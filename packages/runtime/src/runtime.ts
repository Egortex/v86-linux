import { V86 } from "v86";
import { bootVM, type BootedVM } from "@v86-linux/vm-runtime/src/boot";
import { writeGuestFile } from "@v86-linux/fs-bridge/src/host-to-guest";
import { readGuestFile } from "@v86-linux/fs-bridge/src/guest-to-host";
import {
    connectToGuestPort,
    refreshGuestNetworkForPreview,
    type PreviewConnection,
} from "@v86-linux/preview-bridge/src/port-forward";
import type { RuntimeConfig, ProjectRuntime } from "./types";

const CMDLINE =
    "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose " +
    "modules=virtio_pci tsc=reliable init_on_free=on";

/**
 * Ties together vm-runtime/fs-bridge/network/preview-bridge behind the same
 * public contract shape as the Node-lite plan (boot/install/run/restart/
 * writeFile), per the plan's "критичные файлы" note on this file.
 *
 * Networking is the one place this runtime is NOT backend-agnostic: install
 * mode needs `installNetworkRelayUrl` (a real internet backend — see
 * packages/network's README for why the zero-server fetch backend can't do
 * this), and preview mode needs the `fetch` backend (see
 * packages/preview-bridge's README). `enterPreviewMode()` is the validated
 * transition between the two (spike-phase4-preview.mjs).
 */
export function createProjectRuntime(config: RuntimeConfig): ProjectRuntime {
    let vm: BootedVM | null = null;
    let mode: "install" | "preview" = "install";

    function filesystemConfig() {
        return {
            filesystemBaseUrl: config.filesystemBaseUrl,
            filesystemBaseFs: config.filesystemBaseFs,
        };
    }

    return {
        async boot() {
            vm = bootVM({
                wasmPath: config.wasmPath,
                biosPath: config.biosPath,
                vgaBiosPath: config.vgaBiosPath,
                ...filesystemConfig(),
                cmdline: CMDLINE,
                networkRelayUrl: config.installNetworkRelayUrl,
            });

            if (config.cachedSnapshot) {
                // Warm start (Phase 5): ~200x faster than cold boot per
                // spike-phase5-snapshot-timing.mjs. The cached snapshot is
                // assumed to have been taken in preview mode (the steady
                // state most reopens land in); install() still works from
                // there if dependencies change.
                await vm.emulator.restore_state(config.cachedSnapshot.buffer as ArrayBuffer);
                mode = "preview";
            } else {
                await vm.ready;
            }
        },

        async install(cwd = "/root") {
            if (!vm) throw new Error("call boot() first");
            if (mode !== "install") {
                throw new Error(
                    "install() requires the install-mode network backend; " +
                    "this runtime is currently in preview mode (see enterPreviewMode)",
                );
            }
            const marker = `__INSTALL_EXIT_${Date.now()}__`;
            vm.runCommand(
                `cd ${cwd} && npm install --no-audit --no-fund 2>&1; echo ${marker}=$?`,
            );
            const tail = await vm.waitForSerial(new RegExp(`${marker}=\\d+`), 300_000);
            const match = tail.match(new RegExp(`${marker}=(\\d+)`));
            const exitCode = match ? Number(match[1]) : 1;
            return { exitCode, output: vm.getSerialLog() };
        },

        async enterPreviewMode() {
            if (!vm) throw new Error("call boot() first");
            const snapshot = await vm.emulator.save_state();
            await vm.emulator.destroy();

            vm = bootVM({
                wasmPath: config.wasmPath,
                biosPath: config.biosPath,
                vgaBiosPath: config.vgaBiosPath,
                ...filesystemConfig(),
                cmdline: CMDLINE,
                networkRelayUrl: "fetch",
            });
            (vm.emulator as unknown as { autostart: boolean }).autostart = false;
            await new Promise<void>((resolve) =>
                vm!.emulator.add_listener("emulator-ready", resolve),
            );
            await vm.emulator.restore_state(snapshot);
            await vm.emulator.run();
            await refreshGuestNetworkForPreview(vm.emulator);
            mode = "preview";
        },

        run(command: string) {
            if (!vm) throw new Error("call boot() first");
            vm.runCommand(command);
        },

        async previewPort(port: number): Promise<PreviewConnection> {
            if (!vm) throw new Error("call boot() first");
            if (mode !== "preview") {
                throw new Error("previewPort() requires enterPreviewMode() first");
            }
            return connectToGuestPort(vm.emulator, port);
        },

        async writeFile(guestPath: string, contents: Uint8Array | string) {
            if (!vm) throw new Error("call boot() first");
            await writeGuestFile(vm.emulator, guestPath, contents);
        },

        async readFile(guestPath: string) {
            if (!vm) throw new Error("call boot() first");
            return readGuestFile(vm.emulator, guestPath);
        },

        restart() {
            if (!vm) throw new Error("call boot() first");
            vm.emulator.restart();
        },

        async snapshot() {
            if (!vm) throw new Error("call boot() first");
            return new Uint8Array(await vm.emulator.save_state());
        },

        async destroy() {
            if (vm) {
                await vm.emulator.destroy();
                vm = null;
            }
        },
    };
}

export type { RuntimeConfig, ProjectRuntime } from "./types";
export { V86 };
