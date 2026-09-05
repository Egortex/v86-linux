// HMR/live-edit test, stage 2: restore stage 1's snapshot under the fetch
// backend, refresh DHCP, open a real WebSocket to Vite's HMR endpoint (via
// ws-tunnel.ts over connectToGuestPort), confirm the "connected" handshake
// message, then overwrite a real source file through the 9p fs-bridge
// (create_file — the same primitive a real host-side editor integration
// would use) and assert Vite's file watcher notices and pushes an HMR
// update/full-reload message over that same WebSocket.
//
// This is the piece flagged as missing in packages/preview-bridge's README
// ("what's still open" — no WebSocket-shaped duplex over
// connectToGuestPort yet) and in e2e/README.md ("Not built here" — HMR
// coverage). ws-tunnel.ts closes that gap.
import { V86 } from "v86";
import { readFileSync, readFileSync as readFileSyncMeta, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectToGuestPort, refreshGuestNetworkForPreview } from "../../packages/preview-bridge/src/port-forward.ts";
import { openGuestWebSocket } from "../../packages/preview-bridge/src/ws-tunnel.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const biosDir = path.join(__dirname, "..", "minimal", ".assets");
const vmImageDir = path.join(__dirname, "..", "..", "packages", "vm-image");
const wasmPath = fileURLToPath(new URL("./node_modules/v86/build/v86.wasm", import.meta.url));
const snapshotPath = path.join(__dirname, ".hmr-snapshot.bin");
const metaPath = path.join(__dirname, ".hmr-meta.json");

if (!existsSync(snapshotPath) || !existsSync(metaPath)) {
    console.error("\n[stage2] missing .hmr-snapshot.bin / .hmr-meta.json — run spike-hmr-stage1-install.mjs first\n");
    process.exit(1);
}

const { editableFile } = JSON.parse(readFileSyncMeta(metaPath, "utf8"));
console.log(`[stage2] will edit: ${editableFile}`);

const snapshot = new Uint8Array(readFileSync(snapshotPath));
console.log(`[stage2] loaded snapshot: ${snapshot.byteLength} bytes`);

const emulator = new V86({
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
    net_device: { type: "virtio", relay_url: "fetch" },
    preserve_mac_from_state_image: true,
    autostart: false,
});

emulator.add_listener("serial0-output-byte", (byte) => process.stdout.write(String.fromCharCode(byte)));

await new Promise((resolve) => emulator.add_listener("emulator-ready", resolve));
await emulator.restore_state(snapshot.buffer);
emulator.run();
console.log("\n[stage2] state restored\n");

await refreshGuestNetworkForPreview(emulator);
console.log("[stage2] guest network refreshed for fetch backend\n");

const open = await Promise.race([
    emulator.network_adapter.tcp_probe(5175),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 15_000)),
]);
if (open !== true) {
    console.error(`\n[stage2] FAILURE: tcp_probe(5175) result: ${open} — is the dev server from stage 1 still running?\n`);
    process.exit(1);
}
console.log("[stage2] port 5175 is open, connecting WebSocket...\n");

const connection = connectToGuestPort(emulator, 5175);
const ws = openGuestWebSocket(connection, "localhost:5175", "/", "vite-hmr");

const result = await new Promise((resolve) => {
    let gotConnected = false;
    const timer = setTimeout(() => resolve({ ok: false, reason: "timed out overall" }), 60_000);

    ws.onClose((reason) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: `socket closed: ${reason}` });
    });

    ws.onMessage((raw) => {
        console.log(`[stage2] HMR message: ${raw}`);
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        if (msg.type === "connected" && !gotConnected) {
            gotConnected = true;
            console.log("\n[stage2] HMR handshake confirmed (\"connected\" message received)\n");
            console.log(`[stage2] now editing ${editableFile} via the 9p fs-bridge...\n`);

            const guestPath = editableFile.replace(/^\/root\//, "root/");
            const newContents = `// live-edit test write at ${new Date().toISOString()}\nconsole.log("hmr-live-edit-test marker");\n`;
            emulator.create_file(guestPath, new TextEncoder().encode(newContents)).catch((e) => {
                clearTimeout(timer);
                resolve({ ok: false, reason: `create_file failed: ${e}` });
            });
        } else if (gotConnected && (msg.type === "update" || msg.type === "full-reload")) {
            clearTimeout(timer);
            resolve({ ok: true, reason: `received "${msg.type}" after live-edit` });
        }
    });
});

console.log(`\n[stage2] result: ${JSON.stringify(result)}\n`);

if (result.ok) {
    console.log("\n[spike] HMR/live-edit SUCCESS: a file written via the 9p fs-bridge triggered a real Vite HMR message over a real WebSocket tunneled through connectToGuestPort\n");
    process.exit(0);
} else {
    console.error(`\n[spike] HMR/live-edit FAILURE: ${result.reason}\n`);
    process.exit(1);
}
