// Phase 1 checkpoint: boot our own Alpine+Node.js image (built by build.sh)
// and verify `node -v` / `npm -v` work inside it, per the plan's Phase 1
// check: "node -v/npm -v доступны в собственном образе через консоль гостя".
import { V86 } from "v86";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const biosDir = path.join(__dirname, "..", "..", "examples", "minimal", ".assets");
const wasmPath = fileURLToPath(
    new URL("./node_modules/v86/build/v86.wasm", import.meta.url),
);

const PROMPT = /:~\S*#\s*$/;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

let serialBuffer = "";
let sinceCommand = "";
let step = "wait-boot"; // wait-boot -> node-sent -> npm-sent -> done

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
        baseurl: path.join(__dirname, "dist", "rootfs-flat"),
        basefs: path.join(__dirname, "dist", "fs.json"),
    },
    autostart: true,
});

let nodeVersion = null;

emulator.add_listener("serial0-output-byte", (byte) => {
    const ch = String.fromCharCode(byte);
    serialBuffer += ch;
    sinceCommand += ch;
    process.stdout.write(ch);

    if (!PROMPT.test(stripAnsi(sinceCommand).slice(-40))) return;

    if (step === "wait-boot") {
        step = "node-sent";
        sinceCommand = "";
        emulator.serial0_send("node -v\n");
    } else if (step === "node-sent") {
        const m = sinceCommand.match(/v(\d+\.\d+\.\d+)/);
        if (m) {
            nodeVersion = m[1];
            step = "npm-sent";
            sinceCommand = "";
            emulator.serial0_send("npm -v\n");
        }
    } else if (step === "npm-sent") {
        const m = sinceCommand.match(/(\d+\.\d+\.\d+)/);
        if (m && nodeVersion) {
            step = "done";
            console.log(
                `\n\n[spike] Phase 1 SUCCESS: node v${nodeVersion}, npm ${m[1]} both respond inside custom image\n`,
            );
        }
    }
});

setTimeout(() => {
    if (step !== "done") {
        console.error(`\n\n[spike] Phase 1 FAILURE: timed out at step "${step}"\n`);
        process.exitCode = 1;
    }
}, 90_000);
