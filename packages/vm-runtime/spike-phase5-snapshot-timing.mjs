// Phase 5 checkpoint: "повторное открытие проекта на порядок быстрее первого"
// (reopening a project is an order of magnitude faster the second time).
// Measures cold boot-to-prompt vs warm restore-to-prompt, same backend.
import { V86 } from "v86";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const biosDir = path.join(__dirname, "..", "..", "examples", "minimal", ".assets");
const vmImageDir = path.join(__dirname, "..", "vm-image");
const wasmPath = fileURLToPath(new URL("./node_modules/v86/build/v86.wasm", import.meta.url));

const PROMPT = /:~\S*#\s*$/;
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
    net_device: { type: "virtio", relay_url: "fetch" },
};

function waitForPrompt(emulator) {
    return new Promise((resolve) => {
        let buf = "";
        emulator.add_listener("serial0-output-byte", function listener(byte) {
            buf += String.fromCharCode(byte);
            if (PROMPT.test(stripAnsi(buf).slice(-40))) {
                emulator.remove_listener("serial0-output-byte", listener);
                resolve();
            }
        });
    });
}

// A restored snapshot resumes exactly where it was saved (already sitting at
// a prompt) — no new serial bytes are emitted just from resuming, so
// "waiting for the prompt" only works by actually issuing a command and
// waiting for its result. This is also the fairer measure of "ready for the
// next instruction" from a UX standpoint.
function waitForCommandEcho(emulator, marker) {
    return new Promise((resolve) => {
        let buf = "";
        emulator.add_listener("serial0-output-byte", function listener(byte) {
            buf += String.fromCharCode(byte);
            if (buf.includes(marker)) {
                emulator.remove_listener("serial0-output-byte", listener);
                resolve();
            }
        });
        emulator.serial0_send(`echo ${marker}\n`);
    });
}

// ---- Cold boot ----
const coldStart = performance.now();
const cold = new V86({ ...baseConfig, autostart: true });
await waitForPrompt(cold);
const coldMs = performance.now() - coldStart;
console.log(`\n[timing] cold boot to prompt: ${coldMs.toFixed(0)}ms\n`);

const snapshot = await cold.save_state();
console.log(`[timing] snapshot size: ${snapshot.byteLength} bytes`);
await cold.destroy();

// ---- Warm restore ----
const warmStart = performance.now();
const warm = new V86({ ...baseConfig, autostart: false, preserve_mac_from_state_image: true });
await new Promise((resolve) => warm.add_listener("emulator-ready", resolve));
await warm.restore_state(snapshot);
warm.run();
await waitForCommandEcho(warm, "WARM_READY_MARKER");
const warmMs = performance.now() - warmStart;
console.log(`\n[timing] warm restore to prompt: ${warmMs.toFixed(0)}ms\n`);

const speedup = coldMs / warmMs;
console.log(`\n[spike] Phase 5 result: warm restore is ${speedup.toFixed(1)}x faster than cold boot\n`);
process.exit(speedup > 1.5 ? 0 : 1);
