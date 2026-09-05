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
    net_device: { type: "virtio", relay_url: "wss://relay.widgetry.org/" },
    autostart: true,
});

const commands = [
    "ip link set eth0 up 2>&1; udhcpc -i eth0 -n -q -T 5 -t 3; echo STEP_DONE",
    "cat /etc/resolv.conf; echo STEP_DONE",
    "wget -T 10 -O- http://example.com/ 2>&1 | head -c 300; echo; echo STEP_DONE",
    "wget -T 10 -O- https://registry.npmjs.org/is-odd 2>&1 | head -c 300; echo; echo STEP_DONE",
];
let idx = 0;
let sinceCommand = "";

emulator.add_listener("serial0-output-byte", (byte) => {
    const ch = String.fromCharCode(byte);
    sinceCommand += ch;
    process.stdout.write(ch);

    if (!PROMPT.test(stripAnsi(sinceCommand).slice(-40))) return;

    if (idx === 0) {
        // first prompt after boot -> send first command
        sinceCommand = "";
        emulator.serial0_send(commands[idx] + "\n");
        idx++;
        return;
    }
    if (sinceCommand.includes("STEP_DONE")) {
        sinceCommand = "";
        if (idx < commands.length) {
            emulator.serial0_send(commands[idx] + "\n");
            idx++;
        } else {
            console.log("\n\n[diag] all steps issued\n");
        }
    }
});

setTimeout(() => {
    console.log("\n\n[diag] time is up, stopping\n");
}, 90_000);
