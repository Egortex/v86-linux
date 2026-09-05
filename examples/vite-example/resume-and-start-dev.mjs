// Resumes the existing .hmr-snapshot.bin (npm install already done there)
// under the SAME wsproxy backend it was saved with, properly starts+polls
// for the vite dev server this time, and re-saves the snapshot — avoiding
// re-running the ~10min npm install just to fix the dev-server-start step.
import { V86 } from "v86";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const biosDir = path.join(__dirname, "..", "minimal", ".assets");
const vmImageDir = path.join(__dirname, "..", "..", "packages", "vm-image");
const wasmPath = fileURLToPath(new URL("./node_modules/v86/build/v86.wasm", import.meta.url));
const snapshotPath = path.join(__dirname, ".hmr-snapshot.bin");

const PROMPT = /:~\S*#\s*$/;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

const snapshot = new Uint8Array(readFileSync(snapshotPath));
console.log(`[resume] loaded snapshot: ${snapshot.byteLength} bytes`);

const emulator = new V86({
    wasm_path: wasmPath,
    memory_size: 2 * 1024 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    screen: { container: null },
    bios: { buffer: readFileSync(path.join(biosDir, "seabios.bin")).buffer },
    vga_bios: { buffer: readFileSync(path.join(biosDir, "vgabios.bin")).buffer },
    bzimage_initrd_from_filesystem: true,
    cmdline: "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci tsc=reliable init_on_free=on",
    filesystem: { baseurl: path.join(vmImageDir, "dist", "rootfs-flat"), basefs: path.join(vmImageDir, "dist", "fs.json") },
    net_device: { type: "virtio", relay_url: "wss://relay.widgetry.org/" }, // same backend as stage1 saved with
    preserve_mac_from_state_image: true,
    autostart: false,
});

function waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("timed out waiting for condition")), timeoutMs);
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
function sendAndWaitForPrompt(command, timeoutMs) {
    const marker = `__DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    emulator.serial0_send(`${command}; echo ${marker}\n`);
    return waitFor((tail) => tail.includes(marker) && PROMPT.test(tail.slice(-40)), timeoutMs);
}

emulator.add_listener("serial0-output-byte", (byte) => process.stdout.write(String.fromCharCode(byte)));
await new Promise((resolve) => emulator.add_listener("emulator-ready", resolve));
await emulator.restore_state(snapshot.buffer);
emulator.run();
console.log("\n[resume] state restored (should be sitting at a live prompt already)\n");

// Make sure we can actually issue a fresh command (proves the shell is live).
await sendAndWaitForPrompt("echo alive", 15_000);
console.log("\n[resume] confirmed shell is responsive\n");

// Kill any stale/partial vite process from the original snapshot attempt,
// then start fresh and poll properly this time.
await sendAndWaitForPrompt("pkill -f 'vite' 2>/dev/null; rm -f /tmp/vite.log", 15_000);
await sendAndWaitForPrompt(
    "cd /root/my-app && (npm run dev -- --host 0.0.0.0 --port 5175 > /tmp/vite.log 2>&1 &)",
    15_000,
);
console.log("\n[resume] dev server (re)launched, polling for its banner...\n");

let viteReady = false;
for (let attempt = 0; attempt < 20 && !viteReady; attempt++) {
    const tail = await sendAndWaitForPrompt("cat /tmp/vite.log 2>&1", 15_000);
    if (/Local:|ready in|VITE v/i.test(tail)) {
        viteReady = true;
        console.log(`\n[resume] vite dev server banner seen after ${attempt + 1} poll(s)\n`);
    } else {
        await new Promise((r) => setTimeout(r, 3_000));
    }
}
if (!viteReady) {
    console.error("\n[resume] FAILURE: vite dev server never printed its ready banner\n");
    process.exit(1);
}

console.log("[resume] saving fresh snapshot to disk...");
const newSnapshot = await emulator.save_state();
writeFileSync(snapshotPath, Buffer.from(newSnapshot));
console.log(`[resume] snapshot written: ${snapshotPath} (${newSnapshot.byteLength} bytes)`);

console.log("\n[resume] SUCCESS — snapshot now has a confirmed-running vite dev server. Run spike-hmr-stage2-live-edit.mjs next\n");
process.exit(0);
