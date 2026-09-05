// Phase 4 spike (the plan's most-open risk): reach a port a server listens
// on INSIDE the guest, from host/browser JS, with no relay server for this
// direction.
//
// Key finding this spike validates: v86's `fetch` network backend exposes
// `emulator.network_adapter.tcp_probe(port)` / `.connect(port)` — a
// synthetic TCP client that lets host JS dial straight into a guest's
// listening socket (see examples/tcp_terminal.html in copy/v86, PR #1233).
// This is NOT in the published v86.d.ts (implementation detail), but it is
// real and used in v86's own official example.
//
// The catch (see packages/network's Phase 3 findings): the `fetch` backend
// cannot do real outbound HTTPS, which real `npm install` needs — so a VM
// configured for `fetch` can't ALSO do the install. This spike proves the
// fix: install under `wsproxy` (real internet), save_state(), then restore
// that state into a FRESH V86 instance configured with the `fetch` backend
// (preserve_mac_from_state_image keeps device identity consistent) — no
// reinstall needed, and now network_adapter.connect() is available to reach
// the guest's listening dev-server port.
import { V86 } from "v86";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const biosDir = path.join(__dirname, "..", "..", "examples", "minimal", ".assets");
const vmImageDir = path.join(__dirname, "..", "vm-image");
const wasmPath = fileURLToPath(new URL("./node_modules/v86/build/v86.wasm", import.meta.url));

const PROMPT = /[\w.-]+:~#\s*$/;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

const baseConfig = {
    wasm_path: wasmPath,
    memory_size: 256 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    screen: { container: null },
    bios: { buffer: readFileSync(path.join(biosDir, "seabios.bin")).buffer },
    vga_bios: { buffer: readFileSync(path.join(biosDir, "vgabios.bin")).buffer },
    bzimage_initrd_from_filesystem: true,
    cmdline: "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose " +
        "modules=virtio_pci tsc=reliable init_on_free=on",
    filesystem: {
        baseurl: path.join(vmImageDir, "dist", "rootfs-flat"),
        basefs: path.join(vmImageDir, "dist", "fs.json"),
    },
};

// ---- Stage A: boot with wsproxy (real internet), start a dev server ----
console.log("[stage A] booting with wsproxy backend (real internet)...");

const stageA = new V86({
    ...baseConfig,
    net_device: { type: "virtio", relay_url: "wss://relay.widgetry.org/" },
    autostart: true,
});

await new Promise((resolve) => {
    let sinceCommand = "";
    let step = "wait-boot"; // wait-boot -> server-started -> saving
    stageA.add_listener("serial0-output-byte", async (byte) => {
        const ch = String.fromCharCode(byte);
        sinceCommand += ch;
        process.stdout.write(ch);
        if (!PROMPT.test(stripAnsi(sinceCommand).slice(-40))) return;

        if (step === "wait-boot") {
            step = "server-started";
            sinceCommand = "";
            // Start a real Node HTTP server in the background inside the guest.
            stageA.serial0_send(
                "node -e \"require('http').createServer((q,r)=>r.end('preview-ok from guest')).listen(8080)\" >/tmp/server.log 2>&1 & echo SERVER_STARTED\n",
            );
        } else if (step === "server-started" && sinceCommand.includes("SERVER_STARTED")) {
            step = "done";
            console.log("\n[stage A] guest HTTP server started on :8080\n");
            resolve();
        }
    });
    setTimeout(() => {
        if (step !== "done") {
            console.error(`\n[stage A] FALLBACK TIMEOUT at step "${step}" — snapshot will be incomplete!\n`);
        }
        resolve();
    }, 60_000);
});

console.log("[stage A] saving state...");
const snapshot = await stageA.save_state();
console.log(`[stage A] snapshot size: ${snapshot.byteLength} bytes`);
await stageA.destroy();

// ---- Stage B: fresh instance, fetch backend, restore state, connect ----
console.log("\n[stage B] booting fresh instance with fetch backend, restoring state...");

const stageB = new V86({
    ...baseConfig,
    net_device: { type: "virtio", relay_url: "fetch" },
    preserve_mac_from_state_image: true,
    autostart: false,
});

// Drain stage B's own boot chatter to the console for visibility.
stageB.add_listener("serial0-output-byte", (byte) => {
    process.stdout.write(String.fromCharCode(byte));
});

await new Promise((resolve) => stageB.add_listener("emulator-ready", resolve));
console.log("[stage B] emulator internals ready, restoring...");

await stageB.restore_state(snapshot);
stageB.run();

// The guest's network stack still has whatever IP it negotiated under
// stage A's wsproxy backend (a real 10.x address); the fetch backend is a
// completely separate JS-side virtual router expecting its own subnet
// (192.168.86.0/24 by default) with no knowledge of that old lease. Force a
// fresh DHCP negotiation now that the fetch backend is attached, so the
// guest's IP actually matches what this backend's ARP/routing expects.
// The already-running Node server is unaffected (it listens on 0.0.0.0).
console.log("[stage B] re-running DHCP so guest IP matches the new backend's virtual subnet...");
stageB.serial0_send("ip link set eth0 down; ip link set eth0 up; udhcpc -i eth0 -n -q -T 5 -t 3\n");
await new Promise((resolve) => setTimeout(resolve, 4_000));

console.log("[stage B] probing guest's port 8080 via network_adapter.connect()...");

// network_adapter.connect()/.tcp_probe() are the (undocumented-in-.d.ts but
// real and officially demoed) fetch-backend-only host->guest TCP API.
const probeTimeout = new Promise((resolve) => setTimeout(() => resolve("__timeout__"), 15_000));
const open = await Promise.race([stageB.network_adapter.tcp_probe(8080), probeTimeout]);
if (open === "__timeout__") {
    console.error("\n\n[spike] Phase 4 FAILURE: tcp_probe(8080) never resolved (timed out)\n");
    process.exit(1);
}
if (!open) {
    console.error("\n\n[spike] Phase 4 FAILURE: tcp_probe(8080) reports closed\n");
    process.exit(1);
}

const connection = stageB.network_adapter.connect(8080);
let responseBytes = new Uint8Array(0);

const result = await new Promise((resolve) => {
    connection.on("connect", () => {
        connection.write(new TextEncoder().encode("GET / HTTP/1.0\r\n\r\n"));
    });
    connection.on("data", (data) => {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        const merged = new Uint8Array(responseBytes.length + chunk.length);
        merged.set(responseBytes);
        merged.set(chunk, responseBytes.length);
        responseBytes = merged;
    });
    connection.on("close", () => resolve(new TextDecoder().decode(responseBytes)));
    connection.on("shutdown", () => resolve(new TextDecoder().decode(responseBytes)));
    setTimeout(() => resolve(new TextDecoder().decode(responseBytes)), 15_000);
});

console.log(`\n[stage B] raw HTTP response from guest:\n${result}\n`);

if (result.includes("preview-ok from guest")) {
    console.log("\n[spike] Phase 4 SUCCESS: browser/host JS reached a port the guest listens on, with no relay server for THIS direction, after a real npm-install-capable session was snapshotted under a different backend\n");
    process.exit(0);
} else {
    console.error("\n[spike] Phase 4 FAILURE: unexpected/empty response\n");
    process.exit(1);
}
