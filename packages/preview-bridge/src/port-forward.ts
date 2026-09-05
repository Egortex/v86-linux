import type { V86 } from "v86";

/**
 * v86's `fetch` network backend exposes a synthetic TCP client
 * (`network_adapter.tcp_probe`/`.connect`) that lets host/browser JS dial
 * directly into a port the guest is listening on — no relay server needed
 * for THIS direction. Not in the published v86.d.ts (implementation detail),
 * but real: see examples/tcp_terminal.html in github.com/copy/v86 (PR #1233).
 *
 * The catch: only the `fetch` backend has this API, and (per
 * packages/network's Phase 3 findings) that backend cannot do real outbound
 * HTTPS — so a VM configured for it can't also run `npm install`.
 *
 * The fix, validated in spike-phase4-preview.mjs: run the install under a
 * backend with real internet (`wsproxy`/`wisp`), `save_state()` once the
 * dev server is listening, then `restore_state()` that snapshot into a
 * FRESH V86 instance configured with the `fetch` backend
 * (`preserve_mac_from_state_image: true` keeps device identity stable).
 * The guest's old DHCP lease belongs to the wsproxy backend's real subnet,
 * not the fetch backend's virtual one — cycle the interface and re-run
 * DHCP after restoring (see refreshGuestNetworkForPreview below) so the
 * fetch backend's virtual router can actually see the guest. The
 * already-running dev server is unaffected; it listens on 0.0.0.0.
 */

interface FetchNetworkAdapter {
    tcp_probe(port: number): Promise<boolean>;
    connect(port: number): PreviewConnection;
}

export interface PreviewConnection {
    on(event: "connect" | "close" | "shutdown", handler: () => void): void;
    on(event: "data", handler: (data: Uint8Array | ArrayBuffer) => void): void;
    write(data: Uint8Array): void;
    close(): void;
}

function getFetchAdapter(emulator: V86): FetchNetworkAdapter {
    const adapter = (emulator as unknown as { network_adapter?: FetchNetworkAdapter }).network_adapter;
    if (!adapter || typeof adapter.connect !== "function") {
        throw new Error(
            "network_adapter.connect is unavailable — the VM must be configured with " +
            "net_device: { relay_url: 'fetch' } to use the preview port bridge",
        );
    }
    return adapter;
}

/**
 * Re-negotiates the guest's network config so it matches whichever backend
 * is currently attached. Required after restoring a snapshot that was taken
 * under a different net_device backend (see module doc above).
 */
export function refreshGuestNetworkForPreview(
    emulator: V86,
    interfaceName = "eth0",
    settleMs = 4_000,
): Promise<void> {
    emulator.serial0_send(
        `ip link set ${interfaceName} down; ip link set ${interfaceName} up; ` +
        `udhcpc -i ${interfaceName} -n -q -T 5 -t 3\n`,
    );
    return new Promise((resolve) => setTimeout(resolve, settleMs));
}

/** Probes whether the guest is listening on `port`. */
export function probeGuestPort(emulator: V86, port: number): Promise<boolean> {
    return getFetchAdapter(emulator).tcp_probe(port);
}

/** Opens a raw TCP connection into the guest's listening `port`. */
export function connectToGuestPort(emulator: V86, port: number): PreviewConnection {
    return getFetchAdapter(emulator).connect(port);
}

/**
 * Sends a minimal HTTP/1.0 GET and resolves with the raw response bytes.
 * A real preview-bridge would instead pipe this connection into a Service
 * Worker (to serve an iframe) or a WebSocket-shaped duplex (for dev-server
 * HMR) rather than doing one-shot request/response — this helper is for
 * spikes and health checks.
 */
export function fetchOverGuestPort(
    emulator: V86,
    port: number,
    requestPath = "/",
    timeoutMs = 15_000,
): Promise<Uint8Array> {
    const connection = connectToGuestPort(emulator, port);
    let response = new Uint8Array(0);

    return new Promise((resolve) => {
        const finish = () => resolve(response);
        connection.on("connect", () => {
            connection.write(new TextEncoder().encode(`GET ${requestPath} HTTP/1.0\r\n\r\n`));
        });
        connection.on("data", (data) => {
            const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
            const merged = new Uint8Array(response.length + chunk.length);
            merged.set(response);
            merged.set(chunk, response.length);
            response = merged;
        });
        connection.on("close", finish);
        connection.on("shutdown", finish);
        setTimeout(finish, timeoutMs);
    });
}
