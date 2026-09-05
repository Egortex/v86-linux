// Tiny static file server for the e2e harness page.
//
// Playwright's `webServer` option (see ../playwright.config.ts) starts this
// with plain `node`, no bundler involved. It serves the harness HTML plus
// four other asset roots the harness page needs, none of which live next to
// each other on disk:
//
//   /                    -> this directory (harness.html and friends)
//   /v86/<file>          -> node_modules/v86/build/<file>       (libv86.js, v86.wasm)
//   /bios/<file>         -> examples/minimal/.assets/<file>     (seabios.bin, vgabios.bin)
//   /image/<file...>     -> packages/vm-image/dist/<file...>    (rootfs-flat/, fs.json)
//
// The vm-image dist/ directory is treated as strictly read-only here: this
// server only ever reads from it, never writes/rebuilds it (see repo README
// — another process may be using it).
//
// No dependencies (no `serve`/`express`) so the package installs offline-safe
// and stays honest about how little a static asset server needs to be.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const ROOTS = {
    "": join(__dirname), // "/" and "/fixtures-relative" paths
    v86: join(repoRoot, "node_modules", "v86", "build"),
    bios: join(repoRoot, "examples", "minimal", ".assets"),
    image: join(repoRoot, "packages", "vm-image", "dist"),
};

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".bin": "application/octet-stream",
};

function resolveRequestPath(urlPath) {
    const clean = urlPath.split("?")[0];
    const parts = clean.split("/").filter(Boolean);
    const prefix = parts[0] in ROOTS && parts[0] !== "" ? parts[0] : null;

    let root;
    let rest;
    if (prefix) {
        root = ROOTS[prefix];
        rest = parts.slice(1);
    } else {
        root = ROOTS[""];
        rest = parts.length === 0 ? ["harness.html"] : parts;
    }

    const target = normalize(join(root, ...rest));
    // Guard against path traversal escaping the chosen root.
    if (!target.startsWith(normalize(root) + sep) && target !== normalize(root)) {
        return null;
    }
    return target;
}

const server = createServer(async (req, res) => {
    try {
        const filePath = resolveRequestPath(req.url ?? "/");
        if (!filePath) {
            res.writeHead(403).end("forbidden");
            return;
        }
        const st = await stat(filePath).catch(() => null);
        if (!st || !st.isFile()) {
            res.writeHead(404).end(`not found: ${req.url}`);
            return;
        }
        const body = await readFile(filePath);
        const type = MIME[extname(filePath)] ?? "application/octet-stream";
        res.writeHead(200, {
            "content-type": type,
            "content-length": body.length,
            // v86's fs.json/rootfs-flat fetches and the wasm module benefit
            // from range requests in a browser; not strictly required for
            // these fixed, small test assets, so kept simple here.
            "cache-control": "no-cache",
        });
        res.end(body);
    } catch (err) {
        res.writeHead(500).end(String(err));
    }
});

const port = Number(process.env.PORT ?? 4310);
server.listen(port, () => {
    console.log(`[e2e] static server listening on http://localhost:${port}`);
});
