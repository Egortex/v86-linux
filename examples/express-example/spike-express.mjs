// Real Express.js app, unmodified, running inside the guest — plus the full
// install-mode -> preview-mode pipeline (Phase 3 + Phase 4 combined):
//   1. boot under wsproxy (real internet) -> `npm install express`
//   2. write a real Express server.js via the 9p fs-bridge (create_file)
//   3. start it, save_state(), destroy
//   4. restore into a fresh fetch-backend instance, refresh DHCP
//   5. reach the running Express server from host JS via
//      network_adapter.connect() (packages/preview-bridge's mechanism)
//
// This is the same pipeline packages/preview-bridge/spike-phase4-preview.mjs
// validates with a bare `http.createServer`, here exercised against a real
// npm-installed framework instead of a builtin module, and with the
// server's source code delivered via the fs-bridge (not `node -e`) — a
// closer match to how a real project's files would actually get in.
import { V86 } from "v86";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const biosDir = path.join(__dirname, "..", "minimal", ".assets");
const vmImageDir = path.join(__dirname, "..", "..", "packages", "vm-image");
const wasmPath = fileURLToPath(new URL("./node_modules/v86/build/v86.wasm", import.meta.url));

const PROMPT = /:~\S*#\s*$/;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

const SERVER_JS = `
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('hello from real Express inside v86-linux'));
app.listen(3000, '0.0.0.0');
`;

const baseConfig = {
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
};

function waitFor(emulator, predicate, timeoutMs = 300_000) {
    return new Promise((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
        emulator.add_listener("serial0-output-byte", function listener(byte) {
            buf += String.fromCharCode(byte);
            process.stdout.write(String.fromCharCode(byte));
            const tail = stripAnsi(buf);
            if (predicate(tail)) {
                emulator.remove_listener("serial0-output-byte", listener);
                clearTimeout(timer);
                resolve(tail);
            }
        });
    });
}

function sendAndWaitForPrompt(emulator, command, timeoutMs = 300_000) {
    const marker = `__DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    emulator.serial0_send(`${command}; echo ${marker}\n`);
    return waitFor(emulator, (tail) => tail.includes(marker) && PROMPT.test(tail.slice(-40)), timeoutMs);
}

console.log("[stage A] booting with wsproxy backend (real internet)...");
const stageA = new V86({
    ...baseConfig,
    net_device: { type: "virtio", relay_url: "wss://relay.widgetry.org/" },
    autostart: true,
});

await waitFor(stageA, (tail) => PROMPT.test(tail.slice(-40)));
console.log("\n[stage A] boot prompt reached\n");

await sendAndWaitForPrompt(stageA, "ip link set eth0 up 2>&1; udhcpc -i eth0 -n -q -T 5 -t 3");
console.log("\n[stage A] DHCP done\n");

await sendAndWaitForPrompt(stageA, "mkdir -p /root/express-app && cd /root/express-app && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund express 2>&1 | tail -10", 240_000);
console.log("\n[stage A] express installed\n");

await stageA.create_file("root/express-app/server.js", new TextEncoder().encode(SERVER_JS));
console.log("\n[stage A] server.js written via 9p fs-bridge\n");

await sendAndWaitForPrompt(stageA, "cd /root/express-app && (node server.js > /tmp/express.log 2>&1 &); sleep 2; cat /tmp/express.log");
console.log("\n[stage A] express server started\n");

console.log("[stage A] saving state...");
const snapshot = await stageA.save_state();
console.log(`[stage A] snapshot size: ${snapshot.byteLength} bytes`);
await stageA.destroy();

console.log("\n[stage B] restoring into fetch-backend instance...");
const stageB = new V86({
    ...baseConfig,
    net_device: { type: "virtio", relay_url: "fetch" },
    preserve_mac_from_state_image: true,
    autostart: false,
});
stageB.add_listener("serial0-output-byte", (byte) => process.stdout.write(String.fromCharCode(byte)));
await new Promise((resolve) => stageB.add_listener("emulator-ready", resolve));
await stageB.restore_state(snapshot);
stageB.run();

console.log("\n[stage B] refreshing guest network for the new backend...");
stageB.serial0_send("ip link set eth0 down; ip link set eth0 up; udhcpc -i eth0 -n -q -T 5 -t 3\n");
await new Promise((resolve) => setTimeout(resolve, 4_000));

console.log("[stage B] connecting to the running Express server on :3000...");
const open = await Promise.race([
    stageB.network_adapter.tcp_probe(3000),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 15_000)),
]);
if (open !== true) {
    console.error(`\n[spike] FAILURE: tcp_probe(3000) result: ${open}\n`);
    process.exit(1);
}

const connection = stageB.network_adapter.connect(3000);
let response = new Uint8Array(0);
const result = await new Promise((resolve) => {
    connection.on("connect", () => connection.write(new TextEncoder().encode("GET / HTTP/1.0\r\n\r\n")));
    connection.on("data", (data) => {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        const merged = new Uint8Array(response.length + chunk.length);
        merged.set(response);
        merged.set(chunk, response.length);
        response = merged;
    });
    connection.on("close", () => resolve(new TextDecoder().decode(response)));
    connection.on("shutdown", () => resolve(new TextDecoder().decode(response)));
    setTimeout(() => resolve(new TextDecoder().decode(response)), 15_000);
});

console.log(`\n[stage B] raw HTTP response:\n${result}\n`);

if (result.includes("hello from real Express inside v86-linux") && result.includes("X-Powered-By: Express")) {
    console.log("\n[spike] SUCCESS: real Express app (npm install, real source file via 9p) served a real request after an install-mode -> preview-mode backend swap\n");
    process.exit(0);
} else {
    console.error("\n[spike] FAILURE: unexpected response\n");
    process.exit(1);
}
