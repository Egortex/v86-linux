// Phase 2 checkpoint: a file written via fs-bridge (create_file) is visible
// and readable inside the guest, and a file the guest writes is readable back
// on the host via read_file.
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
    autostart: true,
});

let serialBuffer = "";
let sinceCommand = "";
let step = "wait-boot";
// wait-boot -> host-file-written -> guest-cat-sent -> guest-write-sent -> done

emulator.add_listener("serial0-output-byte", async (byte) => {
    const ch = String.fromCharCode(byte);
    serialBuffer += ch;
    sinceCommand += ch;
    process.stdout.write(ch);

    if (!PROMPT.test(stripAnsi(sinceCommand).slice(-40))) return;

    if (step === "wait-boot") {
        step = "host-file-written";
        sinceCommand = "";
        const message = "hello from host via fs-bridge\n";
        await emulator.create_file("root/from-host.txt", new TextEncoder().encode(message));
        console.log(`\n[spike] host wrote root/from-host.txt (${message.length} bytes)\n`);
        step = "guest-cat-sent";
        emulator.serial0_send("cat /root/from-host.txt\n");
    } else if (step === "guest-cat-sent") {
        if (sinceCommand.includes("hello from host via fs-bridge")) {
            step = "guest-write-sent";
            sinceCommand = "";
            emulator.serial0_send("echo 'hello from guest via fs-bridge' > /root/from-guest.txt\n");
        }
    } else if (step === "guest-write-sent") {
        step = "reading-back";
        try {
            const bytes = await emulator.read_file("root/from-guest.txt");
            const text = new TextDecoder().decode(bytes);
            if (text.includes("hello from guest via fs-bridge")) {
                step = "done";
                console.log(`\n\n[spike] Phase 2 SUCCESS: round-trip host<->guest file exchange works\n`);
                console.log(`[spike] host read back: ${JSON.stringify(text)}\n`);
            } else {
                console.error(`\n\n[spike] Phase 2 FAILURE: unexpected content: ${JSON.stringify(text)}\n`);
                process.exitCode = 1;
            }
        } catch (e) {
            console.error(`\n\n[spike] Phase 2 FAILURE: read_file threw: ${e}\n`);
            process.exitCode = 1;
        }
    }
});

setTimeout(() => {
    if (step !== "done") {
        console.error(`\n\n[spike] Phase 2 FAILURE: timed out at step "${step}"\n`);
        process.exitCode = 1;
    }
}, 90_000);
