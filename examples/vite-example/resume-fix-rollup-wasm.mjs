// Resumes the existing .hmr-snapshot.bin, patches package.json to force
// Rollup's WASM build (the same technique WebContainer/Nodebox use for
// every native binary they can't run at all — v86 CAN run native binaries,
// just not 32-bit-incompatible ones like Rollup's ia32-unsupported native
// addon), reinstalls (fast: most deps already cached from the first
// install), and retries starting the dev server with proper polling.
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

const PACKAGE_JSON = JSON.stringify(
    {
        name: "my-app",
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: { dev: "vite" },
        devDependencies: { vite: "^5.4.0" },
        overrides: { rollup: "npm:@rollup/wasm-node@^4" },
    },
    null,
    2,
);

const snapshot = new Uint8Array(readFileSync(snapshotPath));
console.log(`[fix] loaded snapshot: ${snapshot.byteLength} bytes`);

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
    net_device: { type: "virtio", relay_url: "wss://relay.widgetry.org/" },
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
console.log("\n[fix] state restored\n");

await sendAndWaitForPrompt("echo alive", 15_000);
console.log("\n[fix] confirmed shell is responsive\n");

await sendAndWaitForPrompt("pkill -f vite 2>/dev/null; rm -f /tmp/vite.log", 15_000);

await emulator.create_file("root/my-app/package.json", new TextEncoder().encode(PACKAGE_JSON));
console.log("\n[fix] patched package.json with rollup -> @rollup/wasm-node override\n");

// First attempt at this override left node_modules/rollup untouched — npm
// didn't re-resolve because a stale package-lock.json/node_modules from
// the original install already "satisfied" its own checks. Force a clean
// slate so the override actually takes effect. npm's own download cache
// (~/.npm/_cacache, untouched by rm -rf node_modules) still avoids
// re-fetching most already-seen tarballs, so this should still be faster
// than the original from-scratch install.
await sendAndWaitForPrompt("cd /root/my-app && rm -rf node_modules package-lock.json", 30_000);

// Root cause found by reproducing this SAME override on the real host
// machine: it worked instantly there (npm 12.0.2). The guest's Alpine
// package ships npm 10.9.1, which apparently doesn't apply `overrides` to
// a nested/vendored dependency like Vite's copy of rollup the same way.
// Upgrade npm in the guest first.
await sendAndWaitForPrompt("npm install -g npm@12 --no-audit --no-fund", 300_000);
await sendAndWaitForPrompt("npm -v", 15_000);

await sendAndWaitForPrompt("cd /root/my-app && npm install --no-audit --no-fund", 600_000);
console.log("\n[fix] npm install (with override) done\n");

await sendAndWaitForPrompt(
    "cd /root/my-app && (npm run dev -- --host 0.0.0.0 --port 5175 > /tmp/vite.log 2>&1 &)",
    15_000,
);
console.log("\n[fix] dev server launched, polling for its banner...\n");

let viteReady = false;
for (let attempt = 0; attempt < 20 && !viteReady; attempt++) {
    const tail = await sendAndWaitForPrompt("cat /tmp/vite.log 2>&1", 15_000);
    if (/Local:|ready in|VITE v/i.test(tail)) {
        viteReady = true;
        console.log(`\n[fix] vite dev server banner seen after ${attempt + 1} poll(s)\n`);
    } else if (/error|Error/i.test(tail) && tail.match(/error|Error/gi).length > 2) {
        console.error(`\n[fix] FAILURE: error(s) in vite.log:\n${tail}\n`);
        process.exit(1);
    } else {
        await new Promise((r) => setTimeout(r, 3_000));
    }
}
if (!viteReady) {
    console.error("\n[fix] FAILURE: vite dev server never printed its ready banner\n");
    process.exit(1);
}

console.log("[fix] saving fresh snapshot to disk...");
const newSnapshot = await emulator.save_state();
writeFileSync(snapshotPath, Buffer.from(newSnapshot));
console.log(`[fix] snapshot written: ${snapshotPath} (${newSnapshot.byteLength} bytes)`);

console.log("\n[fix] SUCCESS — rollup WASM override worked, dev server confirmed running. Run spike-hmr-stage2-live-edit.mjs next\n");
process.exit(0);
