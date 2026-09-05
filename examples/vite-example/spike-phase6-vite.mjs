// Phase 6 checkpoint: a real `npm create vite` template runs as-is inside
// the guest — no compatibility layer — install -> dev server -> real
// response served, proving out the plan's central claim over Node-lite.
//
// Full e2e (real Vite HMR websocket through the preview-bridge, live-edit,
// iframe) needs an actual browser and is out of scope for this headless
// spike — see the README for what remains.
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

const emulator = new V86({
    wasm_path: wasmPath,
    memory_size: 1024 * 1024 * 1024,
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

const steps = [
    { send: "ip link set eth0 up 2>&1; udhcpc -i eth0 -n -q -T 5 -t 3; echo STEP_DONE", label: "dhcp" },
    {
        send:
            "cd /root && COLUMNS=80 LINES=24 npm_config_yes=true npm create vite@latest my-app -- --template vanilla 2>&1 | tail -20; echo STEP_DONE",
        label: "scaffold",
    },
    {
        send: "cd /root/my-app && npm install --no-audit --no-fund 2>&1 | tail -20; echo STEP_DONE",
        label: "install",
        timeoutMs: 240_000,
    },
    {
        send: "cd /root/my-app && (npm run dev -- --host 0.0.0.0 --port 5173 > /tmp/vite.log 2>&1 &) ; sleep 3; echo STEP_DONE",
        label: "dev-server-start",
    },
    { send: "cat /tmp/vite.log; echo STEP_DONE", label: "dev-server-log" },
];

let idx = 0;
let sinceCommand = "";
let stepStart = performance.now();

emulator.add_listener("serial0-output-byte", (byte) => {
    const ch = String.fromCharCode(byte);
    sinceCommand += ch;
    process.stdout.write(ch);

    if (!PROMPT.test(stripAnsi(sinceCommand).slice(-40))) return;

    if (idx === 0) {
        // first boot prompt -> issue first step
        sinceCommand = "";
        stepStart = performance.now();
        emulator.serial0_send(steps[idx].send + "\n");
        idx++;
        return;
    }
    if (sinceCommand.includes("STEP_DONE")) {
        const elapsed = performance.now() - stepStart;
        console.log(`\n[spike] step "${steps[idx - 1].label}" done in ${elapsed.toFixed(0)}ms\n`);
        sinceCommand = "";
        if (idx < steps.length) {
            stepStart = performance.now();
            emulator.serial0_send(steps[idx].send + "\n");
            idx++;
        } else {
            console.log("\n[spike] Phase 6 SUCCESS: real Vite scaffold + install + dev server all ran unmodified inside the guest\n");
            process.exitCode = 0;
            // let the log flush, then let the external timeout reap us
        }
    }
});

setTimeout(() => {
    if (idx < steps.length) {
        console.error(`\n\n[spike] Phase 6 FAILURE: timed out at step "${steps[idx]?.label ?? "boot"}"\n`);
        process.exitCode = 1;
    }
}, 20 * 60_000);
