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
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const e2eRoot = resolve(__dirname, "..");
const repoRoot = resolve(e2eRoot, "..");

const ROOTS = {
    "": resolve(__dirname), // "/" and other unprefixed paths
    // Resolved from e2e's OWN node_modules (e2e/package.json depends on
    // "v86" directly for exactly this reason) rather than the repo root's
    // node_modules — pnpm only links a package into node_modules/ for
    // whichever workspace package actually declares it as a dependency.
    v86: resolve(e2eRoot, "node_modules", "v86", "build"),
    bios: resolve(repoRoot, "examples", "minimal", ".assets"),
    image: resolve(repoRoot, "packages", "vm-image", "dist"),
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

    const target = resolve(root, ...rest);
    // Guard against path traversal escaping the chosen root: relative() from
    // root to target must not climb out via "..".
    const rel = relative(root, target);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) {
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
