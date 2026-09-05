// Real `npm create vite@latest -- --template react` (React + JSX, a
// heavier/more realistic dependency tree than examples/vite-example's
// vanilla template), scaffolded/installed/run entirely unmodified inside
// the guest, then actually reached from host JS — going one step further
// than examples/vite-example, which only confirms the dev server's own log
// says it's listening.
//
// Pipeline: install under wsproxy (real internet, per packages/network's
// findings) -> save_state() -> restore under fetch backend -> refresh DHCP
// -> network_adapter.connect() to the running Vite dev server (same
// mechanism as packages/preview-bridge/spike-phase4-preview.mjs and
// examples/express-example/spike-express.mjs).
import { V86 } from "v86";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const biosDir = path.join(__dirname, "..", "minimal", ".assets");
const vmImageDir = path.join(__dirname, "..", "..", "packages", "vm-image");
const wasmPath = fileURLToPath(new URL("./node_modules/v86/build/v86.wasm", import.meta.url));

const PROMPT = /[\w.-]+:~#\s*$/;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

const baseConfig = {
    wasm_path: wasmPath,
    memory_size: 512 * 1024 * 1024,
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

function waitFor(emulator, predicate, timeoutMs = 300_000) {
    return new Promise((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error(`timed out waiting for condition`)), timeoutMs);
        emulator.add_listener("serial0-output-byte", function listener(byte) {
            buf += String.fromCharCode(byte);
            process.stdout.write(String.fromCharCode(byte));
            const tail = stripAnsi(buf);
            if (predicate(tail)) {
                emulator.remove_listener("serial0-output-byte", listener);
                clearTimeout(timer);
                resolve(tail);
            }
        });
    });
}

function sendAndWaitForPrompt(emulator, command, timeoutMs = 300_000) {
    const marker = `__DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const t0 = performance.now();
    emulator.serial0_send(`${command}; echo ${marker}\n`);
    return waitFor(emulator, (tail) => tail.includes(marker) && PROMPT.test(tail.slice(-40)), timeoutMs)
        .then((tail) => {
            console.log(`\n[timing] step took ${(performance.now() - t0).toFixed(0)}ms\n`);
            return tail;
        });
}

console.log("[stage A] booting with wsproxy backend (real internet)...");
const stageA = new V86({
    ...baseConfig,
    net_device: { type: "virtio", relay_url: "wss://relay.widgetry.org/" },
    autostart: true,
});

await waitFor(stageA, (tail) => PROMPT.test(tail.slice(-40)));
await sendAndWaitForPrompt(stageA, "ip link set eth0 up 2>&1; udhcpc -i eth0 -n -q -T 5 -t 3");

await sendAndWaitForPrompt(
    stageA,
    "cd /root && npm_config_yes=true npm create vite@latest my-react-app -- --template react 2>&1 | tail -20",
    120_000,
);

await sendAndWaitForPrompt(
    stageA,
    "cd /root/my-react-app && npm install --no-audit --no-fund 2>&1 | tail -20",
    300_000,
);

await sendAndWaitForPrompt(
    stageA,
    "cd /root/my-react-app && (npm run dev -- --host 0.0.0.0 --port 5174 > /tmp/vite.log 2>&1 &); sleep 3; cat /tmp/vite.log",
);

console.log("\n[stage A] saving state...");
const snapshot = await stageA.save_state();
console.log(`[stage A] snapshot size: ${snapshot.byteLength} bytes`);
await stageA.destroy();

console.log("\n[stage B] restoring into fetch-backend instance...");
const stageB = new V86({
    ...baseConfig,
    net_device: { type: "virtio", relay_url: "fetch" },
    preserve_mac_from_state_image: true,
    autostart: false,
});
stageB.add_listener("serial0-output-byte", (byte) => process.stdout.write(String.fromCharCode(byte)));
await new Promise((resolve) => stageB.add_listener("emulator-ready", resolve));
await stageB.restore_state(snapshot);
stageB.run();

stageB.serial0_send("ip link set eth0 down; ip link set eth0 up; udhcpc -i eth0 -n -q -T 5 -t 3\n");
await new Promise((resolve) => setTimeout(resolve, 4_000));

console.log("\n[stage B] connecting to the real Vite+React dev server on :5174...");
const open = await Promise.race([
    stageB.network_adapter.tcp_probe(5174),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 15_000)),
]);
if (open !== true) {
    console.error(`\n[spike] FAILURE: tcp_probe(5174) result: ${open}\n`);
    process.exit(1);
}

const connection = stageB.network_adapter.connect(5174);
let response = new Uint8Array(0);
const result = await new Promise((resolve) => {
    connection.on("connect", () =>
        connection.write(new TextEncoder().encode("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")),
    );
    connection.on("data", (data) => {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        const merged = new Uint8Array(response.length + chunk.length);
        merged.set(response);
        merged.set(chunk, response.length);
        response = merged;
    });
    connection.on("close", () => resolve(new TextDecoder().decode(response)));
    connection.on("shutdown", () => resolve(new TextDecoder().decode(response)));
    setTimeout(() => resolve(new TextDecoder().decode(response)), 15_000);
});

console.log(`\n[stage B] raw HTTP response (truncated):\n${result.slice(0, 600)}\n`);

if (result.includes("200 OK") && /vite|<div id="root">|@vite\/client/i.test(result)) {
    console.log("\n[spike] SUCCESS: real Vite+React dev server (unmodified) reachable from host JS after install-mode -> preview-mode swap\n");
    process.exit(0);
} else {
    console.error("\n[spike] FAILURE: response didn't look like a real Vite dev server page\n");
    process.exit(1);
}
