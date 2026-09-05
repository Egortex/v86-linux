// HMR/live-edit test, stage 1: boot -> DHCP -> write a minimal real Vite
// project via the 9p fs-bridge -> `npm install` (real vite, real npm
// registry) -> start the dev server -> save_state() to disk.
//
// Originally this scaffolded via `npm create vite@latest` like
// spike-phase6-vite.mjs. That consistently crashed: create-vite constructs
// a readline.Interface tied to stdout regardless of --template being
// passed, and the guest's serial console is a real pty (isTTY true) that
// doesn't report terminal dimensions the way an interactive terminal would,
// so Node's readline internals compute NaN for the cursor column
// (TypeError [ERR_INVALID_ARG_VALUE]: cursorTo ... Received NaN). Setting
// COLUMNS/LINES doesn't help — Node's tty column detection uses a real
// ioctl, not those env vars. `stty` would set the kernel-level window size
// and might fix it, but after the crash the command never returned control
// at all (not even the echoed marker), so something downstream of the
// crash also wedges. Rather than keep fighting create-vite's interactive
// CLI, this writes the (tiny) vanilla-template files directly — which is
// arguably closer to how a real product would work anyway (a host-side
// editor/IDE writes files; it doesn't drive an interactive CLI scaffolder
// inside the guest).
//
// Split into two stages (this file + spike-hmr-stage2-live-edit.mjs) so
// each fits comfortably under a single tool invocation's time budget, and
// to demonstrate persisting a snapshot to disk and resuming it in a
// separate process later.
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
    },
    null,
    2,
);

const INDEX_HTML = `<!doctype html>
<html>
  <head><meta charset="UTF-8" /><title>my-app</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`;

const MAIN_JS = `document.querySelector('#app').innerHTML = '<h1>hello from v86-linux</h1>';\n`;

const emulator = new V86({
    wasm_path: wasmPath,
    memory_size: 2 * 1024 * 1024 * 1024,
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
    net_device: { type: "virtio", relay_url: "wss://relay.widgetry.org/" },
    autostart: true,
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
    const t0 = performance.now();
    emulator.serial0_send(`${command}; echo ${marker}\n`);
    return waitFor((tail) => tail.includes(marker) && PROMPT.test(tail.slice(-40)), timeoutMs).then((tail) => {
        console.log(`\n[timing] step took ${(performance.now() - t0).toFixed(0)}ms\n`);
        return tail;
    });
}

await waitFor((tail) => PROMPT.test(tail.slice(-40)), 60_000);
console.log("\n[stage1] boot prompt reached\n");

await sendAndWaitForPrompt("ip link set eth0 up 2>&1; udhcpc -i eth0 -n -q -T 5 -t 3", 30_000);
console.log("\n[stage1] DHCP done\n");

await sendAndWaitForPrompt("mkdir -p /root/my-app", 15_000);
await emulator.create_file("root/my-app/package.json", new TextEncoder().encode(PACKAGE_JSON));
await emulator.create_file("root/my-app/index.html", new TextEncoder().encode(INDEX_HTML));
await emulator.create_file("root/my-app/main.js", new TextEncoder().encode(MAIN_JS));
console.log("\n[stage1] wrote package.json/index.html/main.js via 9p fs-bridge\n");

// `vite`'s own npm registry metadata document is large (thousands of
// published versions) — a bare `npm view vite version` can take several
// minutes to fetch+parse through the emulated NIC + shared wsproxy relay
// (confirmed: ~2m40s with 2GB guest RAM; it OOM'd entirely at 512MB).
// `npm install` needs the same resolution, so budget generously.
await sendAndWaitForPrompt("cd /root/my-app && npm install --no-audit --no-fund", 900_000);
console.log("\n[stage1] npm install done\n");

await sendAndWaitForPrompt(
    "cd /root/my-app && (npm run dev -- --host 0.0.0.0 --port 5175 > /tmp/vite.log 2>&1 &); sleep 3; cat /tmp/vite.log",
    30_000,
);
console.log("\n[stage1] vite dev server started\n");

console.log("[stage1] saving state to disk...");
const snapshot = await emulator.save_state();
writeFileSync(snapshotPath, Buffer.from(snapshot));
console.log(`[stage1] snapshot written: ${snapshotPath} (${snapshot.byteLength} bytes)`);

const metaPath = path.join(__dirname, ".hmr-meta.json");
writeFileSync(metaPath, JSON.stringify({ editableFile: "/root/my-app/main.js" }, null, 2));
console.log(`[stage1] meta written: ${metaPath}`);

await emulator.destroy();
console.log("\n[stage1] SUCCESS — run spike-hmr-stage2-live-edit.mjs next\n");
process.exit(0);
