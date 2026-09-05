import { createHash, randomBytes } from "node:crypto";
import type { PreviewConnection } from "./port-forward";

// `.slice()` on a Uint8Array whose backing buffer type isn't statically
// known widens to `ArrayBufferLike` (which includes SharedArrayBuffer);
// using this alias throughout avoids fighting that everywhere frames get
// sliced and reassigned.
type Bytes = Uint8Array<ArrayBufferLike>;

/**
 * A minimal RFC6455 WebSocket client implemented on top of a raw
 * `PreviewConnection` (v86's fetch-backend synthetic TCP client — see
 * port-forward.ts). This is what closes the gap flagged in this package's
 * README: `fetchOverGuestPort` only does one-shot HTTP request/response,
 * which isn't enough for Vite's HMR client, which needs a persistent
 * WebSocket. Vite's dev server upgrades the same HTTP port used for regular
 * requests, using the `vite-hmr` subprotocol.
 *
 * Not a general-purpose WebSocket implementation: no fragmentation
 * (Vite's HMR JSON messages are small and sent unfragmented), no ping/pong
 * handling beyond replying to server pings (required to keep some servers
 * from closing idle connections), text frames only (opcode 0x1 in, 0x1 out
 * — sufficient for Vite's JSON-over-text-frame protocol).
 */
export interface GuestWebSocket {
    onOpen(handler: () => void): void;
    onMessage(handler: (data: string) => void): void;
    onClose(handler: (reason: string) => void): void;
    send(text: string): void;
    close(): void;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function buildHandshakeRequest(host: string, path: string, key: string, subprotocol?: string): string {
    const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
    ];
    if (subprotocol) lines.push(`Sec-WebSocket-Protocol: ${subprotocol}`);
    lines.push("", "");
    return lines.join("\r\n");
}

function expectedAccept(key: string): string {
    return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** Encodes a client->server text frame (RFC6455 requires client frames to be masked). */
function encodeTextFrame(text: string): Uint8Array {
    const payload = new TextEncoder().encode(text);
    const mask = randomBytes(4);
    const masked = new Uint8Array(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];

    const lengthBytes: number[] = [];
    let firstLenByte: number;
    if (payload.length < 126) {
        firstLenByte = payload.length;
    } else if (payload.length < 65536) {
        firstLenByte = 126;
        lengthBytes.push((payload.length >> 8) & 0xff, payload.length & 0xff);
    } else {
        firstLenByte = 127;
        const len = payload.length;
        for (let i = 7; i >= 0; i--) lengthBytes.push((len >> (8 * i)) & 0xff);
    }

    const header = [0x81 /* FIN + text opcode */, firstLenByte | 0x80 /* masked */, ...lengthBytes, ...mask];
    const frame = new Uint8Array(header.length + masked.length);
    frame.set(header);
    frame.set(masked, header.length);
    return frame;
}

/** Decodes zero or more complete server->client frames from the head of `buf`. Returns leftover bytes. */
function decodeFrames(buf: Bytes, onFrame: (opcode: number, payload: Bytes) => void): Bytes {
    let offset = 0;
    while (true) {
        if (buf.length - offset < 2) break;
        const b0 = buf[offset];
        const b1 = buf[offset + 1];
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0; // server frames are never masked per spec, but read defensively
        let payloadLen = b1 & 0x7f;
        let headerLen = 2;

        if (payloadLen === 126) {
            if (buf.length - offset < 4) break;
            payloadLen = (buf[offset + 2] << 8) | buf[offset + 3];
            headerLen = 4;
        } else if (payloadLen === 127) {
            if (buf.length - offset < 10) break;
            let len = 0;
            for (let i = 0; i < 8; i++) len = len * 256 + buf[offset + 2 + i];
            payloadLen = len;
            headerLen = 10;
        }

        const maskLen = masked ? 4 : 0;
        const total = headerLen + maskLen + payloadLen;
        if (buf.length - offset < total) break;

        let payload = buf.slice(offset + headerLen + maskLen, offset + headerLen + maskLen + payloadLen);
        if (masked) {
            const maskKey = buf.slice(offset + headerLen, offset + headerLen + 4);
            const unmasked = new Uint8Array(payload.length);
            for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
            payload = unmasked;
        }

        onFrame(opcode, payload);
        offset += total;
    }
    return buf.slice(offset);
}

/**
 * Opens a WebSocket over `connection` (already-established TCP, e.g. from
 * `connectToGuestPort`). `host`/`path` are used for the HTTP Upgrade
 * request line — for Vite, `path` is typically `/` and `subprotocol` is
 * `"vite-hmr"`.
 */
export function openGuestWebSocket(
    connection: PreviewConnection,
    host: string,
    path = "/",
    subprotocol?: string,
): GuestWebSocket {
    const key = randomBytes(16).toString("base64");
    let handshakeDone = false;
    let httpBuffer = "";
    let frameBuffer: Bytes = new Uint8Array(0);

    let openHandler: (() => void) | null = null;
    let messageHandler: ((data: string) => void) | null = null;
    let closeHandler: ((reason: string) => void) | null = null;

    connection.on("connect", () => {
        connection.write(new TextEncoder().encode(buildHandshakeRequest(host, path, key, subprotocol)));
    });

    connection.on("data", (data) => {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);

        if (!handshakeDone) {
            httpBuffer += new TextDecoder().decode(chunk);
            const headerEnd = httpBuffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;

            const header = httpBuffer.slice(0, headerEnd);
            const rest = httpBuffer.slice(headerEnd + 4);
            handshakeDone = true;

            if (!/^HTTP\/1\.1 101/i.test(header)) {
                closeHandler?.(`handshake failed: ${header.split("\r\n")[0]}`);
                return;
            }
            const acceptMatch = header.match(/Sec-WebSocket-Accept:\s*(\S+)/i);
            if (!acceptMatch || acceptMatch[1] !== expectedAccept(key)) {
                closeHandler?.("handshake failed: Sec-WebSocket-Accept mismatch");
                return;
            }

            openHandler?.();
            if (rest.length > 0) {
                frameBuffer = new TextEncoder().encode(rest);
            }
        } else {
            const merged = new Uint8Array(frameBuffer.length + chunk.length);
            merged.set(frameBuffer);
            merged.set(chunk, frameBuffer.length);
            frameBuffer = merged;
        }

        if (handshakeDone) {
            frameBuffer = decodeFrames(frameBuffer, (opcode, payload) => {
                if (opcode === 0x1) {
                    messageHandler?.(new TextDecoder().decode(payload));
                } else if (opcode === 0x9) {
                    // ping -> pong (opcode 0xA), echoing the payload
                    const pong = new Uint8Array(payload.length + 6);
                    pong.set([0x8a, payload.length | 0x80, ...randomBytes(4)]);
                    const mask = pong.slice(2, 6);
                    for (let i = 0; i < payload.length; i++) pong[6 + i] = payload[i] ^ mask[i % 4];
                    connection.write(pong);
                } else if (opcode === 0x8) {
                    closeHandler?.("server sent close frame");
                }
            });
        }
    });

    connection.on("close", () => closeHandler?.("connection closed"));
    connection.on("shutdown", () => closeHandler?.("connection shut down"));

    return {
        onOpen: (handler) => {
            openHandler = handler;
        },
        onMessage: (handler) => {
            messageHandler = handler;
        },
        onClose: (handler) => {
            closeHandler = handler;
        },
        send: (text) => connection.write(encodeTextFrame(text)),
        close: () => connection.close(),
    };
}
