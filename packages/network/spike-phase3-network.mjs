// Phase 3 checkpoint (go/no-go): can a real `npm install` inside the guest
// reach the real internet through v86's `fetch` network backend (no relay
// server — just the browser/Node fetch() API doing CORS-gated HTTP)?
//
// Uses net_device: { type: "virtio", relay_url: "fetch" } per
// docs/networking.md in github.com/copy/v86 (fetched 2026-09-05).
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

const emulator = new V86({
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
    net_device: {
        type: "virtio",
        relay_url: "wss://relay.widgetry.org/",
    },
    autostart: true,
});

let sinceCommand = "";
let step = "wait-boot";
// wait-boot -> dhcp-sent -> ping-sent -> npm-install-sent -> done

emulator.add_listener("serial0-output-byte", (byte) => {
    const ch = String.fromCharCode(byte);
    sinceCommand += ch;
    process.stdout.write(ch);

    if (!PROMPT.test(stripAnsi(sinceCommand).slice(-40))) return;

    if (step === "wait-boot") {
        step = "dhcp-sent";
        sinceCommand = "";
        // virtio-net module + DHCP, per vm-image's networking.sh
        emulator.serial0_send("ip link show; ip link set eth0 up 2>&1; udhcpc -i eth0 -n -q -T 5 -t 3; echo DHCP_EXIT=$?\n");
    } else if (step === "dhcp-sent") {
        step = "npm-install-sent";
        sinceCommand = "";
        emulator.serial0_send("cd /root && npm install --no-audit --no-fund is-odd 2>&1 | tail -20; echo EXIT=$?\n");
    } else if (step === "npm-install-sent") {
        if (sinceCommand.includes("EXIT=")) {
            step = "done";
            const success = /EXIT=0/.test(sinceCommand);
            if (success) {
                console.log("\n\n[spike] Phase 3 SUCCESS (go, via wsproxy relay): npm install reached the real npm registry over HTTPS\n");
            } else {
                console.error("\n\n[spike] Phase 3 FAILURE (no-go): npm install did not complete cleanly through the fetch backend\n");
                process.exitCode = 1;
            }
        }
    }
});

setTimeout(() => {
    if (step !== "done") {
        console.error(`\n\n[spike] Phase 3 FAILURE: timed out at step "${step}"\n`);
        process.exitCode = 1;
    }
}, 120_000);
