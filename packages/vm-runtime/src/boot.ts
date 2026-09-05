import { V86, type V86Options } from "v86";

export interface BootConfig {
    wasmPath: string;
    biosPath: string;
    vgaBiosPath: string;
    /** Directory produced by vm-image's build.sh (dist/rootfs-flat). */
    filesystemBaseUrl: string;
    /** fs.json produced by vm-image's build.sh (dist/fs.json). */
    filesystemBaseFs: string;
    memorySizeBytes?: number;
    vgaMemorySizeBytes?: number;
    cmdline?: string;
    networkRelayUrl?: string;
}

const DEFAULT_CMDLINE =
    "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose " +
    "modules=virtio_pci tsc=reliable init_on_free=on";

export interface BootedVM {
    emulator: V86;
    /** Resolves once the guest shell prompt is seen on the serial console. */
    ready: Promise<void>;
    /** Accumulated serial console output since boot. */
    getSerialLog(): string;
    /** Sends a line to the guest's serial console (appends `\n`). */
    runCommand(command: string): void;
    /** Waits until `pattern` matches the tail of the serial log, or rejects on timeout. */
    waitForSerial(pattern: RegExp, timeoutMs?: number): Promise<string>;
}

const PROMPT_PATTERN = /[\w.-]+:~#\s*$/;
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(s: string): string {
    return s.replace(ANSI_PATTERN, "");
}

export function bootVM(config: BootConfig): BootedVM {
    const options: V86Options = {
        wasm_path: config.wasmPath,
        memory_size: config.memorySizeBytes ?? 256 * 1024 * 1024,
        vga_memory_size: config.vgaMemorySizeBytes ?? 2 * 1024 * 1024,
        screen: { container: null },
        bios: { url: config.biosPath },
        vga_bios: { url: config.vgaBiosPath },
        bzimage_initrd_from_filesystem: true,
        cmdline: config.cmdline ?? DEFAULT_CMDLINE,
        filesystem: {
            baseurl: config.filesystemBaseUrl,
            basefs: config.filesystemBaseFs,
        },
        autostart: true,
    };
    if (config.networkRelayUrl) {
        options.network_relay_url = config.networkRelayUrl;
    }

    const emulator = new V86(options);

    let serialLog = "";
    let resolveReady: () => void;
    const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
    });
    let sawPrompt = false;

    const waiters: Array<{
        pattern: RegExp;
        resolve: (matchedTail: string) => void;
    }> = [];

    emulator.add_listener("serial0-output-byte", (byte: number) => {
        serialLog += String.fromCharCode(byte);

        if (!sawPrompt && PROMPT_PATTERN.test(stripAnsi(serialLog).slice(-200))) {
            sawPrompt = true;
            resolveReady();
        }

        for (let i = waiters.length - 1; i >= 0; i--) {
            const tail = stripAnsi(serialLog).slice(-4096);
            if (waiters[i].pattern.test(tail)) {
                waiters[i].resolve(tail);
                waiters.splice(i, 1);
            }
        }
    });

    return {
        emulator,
        ready,
        getSerialLog: () => serialLog,
        runCommand: (command: string) => emulator.serial0_send(`${command}\n`),
        waitForSerial: (pattern, timeoutMs = 30_000) =>
            new Promise((resolve, reject) => {
                waiters.push({ pattern, resolve });
                setTimeout(() => reject(new Error(`waitForSerial timed out: ${pattern}`)), timeoutMs);
            }),
    };
}
