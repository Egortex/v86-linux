// Phase 0 spike: boot the official v86 demo image (buildroot Linux, no custom
// image yet) headlessly in Node, using the public asset host documented in
// v86's own README (`i.copy.sh` / `copy.sh/v86/bios`).
//
// Verifies the plan's Phase 0 checkpoint: "boot виден, лог консоли гостя
// доступен в браузере" — here reproduced headlessly (no DOM/browser needed;
// v86's WASM core runs fine under plain Node).
//
// Run with an external timeout, e.g.:
//   timeout 60 node spike-phase0-boot.mjs
// Calling emulator.stop()/process.exit() after boot currently crashes with a
// libuv assertion on Windows (async handle teardown race in v86's internal
// scheduler) — this is a known rough edge of running v86 headlessly on
// Windows, not a boot failure. The SUCCESS marker below is the signal to
// watch for; let the external timeout reap the process.

import { V86 } from "v86";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, ".assets");

const ASSETS = {
    "seabios.bin": "https://copy.sh/v86/bios/seabios.bin",
    "vgabios.bin": "https://copy.sh/v86/bios/vgabios.bin",
    "buildroot-bzimage68.bin": "https://i.copy.sh/buildroot-bzimage68.bin",
};

async function ensureAssets() {
    if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
    for (const [name, url] of Object.entries(ASSETS)) {
        const dest = path.join(assetsDir, name);
        if (existsSync(dest)) continue;
        console.log(`[spike] downloading ${name} from ${url}`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await import("node:fs/promises").then((fs) => fs.writeFile(dest, buf));
    }
}

await ensureAssets();

const wasmPath = fileURLToPath(
    new URL("./node_modules/v86/build/v86.wasm", import.meta.url),
);

let serialBuffer = "";
let done = false;

const emulator = new V86({
    wasm_path: wasmPath,
    memory_size: 64 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    screen: { container: null },
    bios: { buffer: readFileSync(path.join(assetsDir, "seabios.bin")).buffer },
    vga_bios: { buffer: readFileSync(path.join(assetsDir, "vgabios.bin")).buffer },
    bzimage: {
        buffer: readFileSync(path.join(assetsDir, "buildroot-bzimage68.bin")).buffer,
    },
    autostart: true,
});

emulator.add_listener("serial0-output-byte", (byte) => {
    const ch = String.fromCharCode(byte);
    serialBuffer += ch;
    process.stdout.write(ch);
    if (!done && /~\s*[%#]\s*$/.test(serialBuffer.slice(-200))) {
        done = true;
        console.log("\n\n[spike] Phase 0 SUCCESS: guest Linux reached a shell prompt\n");
    }
});

setTimeout(() => {
    if (!done) {
        console.error("\n\n[spike] Phase 0 FAILURE: timed out waiting for shell prompt\n");
        process.exitCode = 1;
    }
}, 60_000);
