export interface RuntimeConfig {
    /** Path to v86's WASM binary (node_modules/v86/build/v86.wasm). */
    wasmPath: string;
    /** Path to seabios.bin. */
    biosPath: string;
    /** Path to vgabios.bin. */
    vgaBiosPath: string;
    /** vm-image's dist/rootfs-flat directory. */
    filesystemBaseUrl: string;
    /** vm-image's dist/fs.json manifest. */
    filesystemBaseFs: string;
    /**
     * Real-internet relay for the install phase (e.g. a self-hosted wsproxy
     * URL). See packages/network's README: the zero-server `fetch` backend
     * cannot reach HTTPS registries, so this is required for `install()`.
     */
    installNetworkRelayUrl: string;
    /** Optional cached snapshot from a previous session (Phase 5 warm start). */
    cachedSnapshot?: Uint8Array;
}

export interface ProjectRuntime {
    /** Boots the VM: cold boot, or warm-restores `cachedSnapshot` if provided. */
    boot(): Promise<void>;
    /** Runs a real `npm install` inside the guest over the install-mode backend. */
    install(cwd?: string): Promise<{ exitCode: number; output: string }>;
    /**
     * Switches the VM to preview mode: snapshots the post-install state,
     * restores it into the fetch backend, and refreshes guest networking so
     * `previewPort()` can reach listening ports. Safe to call once per
     * session, after `install()`.
     */
    enterPreviewMode(): Promise<void>;
    /** Runs a command inside the guest (e.g. starting a dev server). */
    run(command: string): void;
    /** Connects to a port the guest is listening on (preview mode only). */
    previewPort(port: number): Promise<import("@v86-linux/preview-bridge/src/port-forward").PreviewConnection>;
    /** Writes a file into the guest's project directory. */
    writeFile(guestPath: string, contents: Uint8Array | string): Promise<void>;
    /** Reads a file back out of the guest. */
    readFile(guestPath: string): Promise<Uint8Array>;
    /** Restarts the guest OS (not the VM process). */
    restart(): void;
    /** Saves the current state for the next session's warm start. */
    snapshot(): Promise<Uint8Array>;
    /** Tears down the VM. */
    destroy(): Promise<void>;
}
