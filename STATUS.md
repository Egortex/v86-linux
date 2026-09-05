# Status: what works, what doesn't, and why

Snapshot of where this project actually stands, based only on things that
were run for real and observed — not on what the plan hoped for. See
`README.md` for the phase-by-phase narrative and links to each package's
own README for full detail; this file is the condensed, decision-oriented
version.

## Works, confirmed by a real run

| Capability | Evidence |
|---|---|
| Boot a real Linux guest headlessly (no browser needed) | `examples/minimal/spike-phase0-boot.mjs` |
| Custom Alpine + Node.js guest image via Docker | `packages/vm-image` — `node -v`/`npm -v` respond inside it |
| Host↔guest file exchange over 9p (`create_file`/`read_file`) | `packages/fs-bridge/spike-phase2-bridge.mjs` — round-trip verified |
| Real `npm install` from inside the guest | works, but **only via a relay server** (`wsproxy`), not the zero-server `fetch` backend — see "Doesn't work" below for why |
| Browser/host JS reaching a port the guest listens on | `packages/preview-bridge` — solved via a snapshot handoff between two different network backends (install-mode `wsproxy` → preview-mode `fetch`) |
| Fast warm restart from a saved snapshot | ~198x faster than cold boot (43s → 220ms), confirmed on this machine (`packages/vm-runtime`) |
| **A real npm framework running completely unmodified: Express** | `examples/express-example` — real `npm install express` (68 packages, ~2min), a real `server.js` written via the 9p bridge, and a genuine `HTTP/1.1 200 OK` / `X-Powered-By: Express` response received by host JS after the install→snapshot→preview handoff |
| Plain Node.js scripts / `http.createServer` in general | proven repeatedly across several spikes; any pure-JS framework built the same way Express is (Koa, Fastify, Hono, etc.) should work the same way — untested individually, but there's no reason specific to Express that would make it special |

## Doesn't work, confirmed, with a real root cause

| What | Why | Where documented |
|---|---|---|
| **Vite's dev server** | Vite depends on Rollup, which ships native binaries per platform+architecture — **and does not publish an `ia32` (32-bit) build at all**. v86 only ever emulates 32-bit x86 (permanent — not a config choice, v86 itself doesn't support 64-bit guests). Rollup's own documented WASM fallback (`@rollup/wasm-node`) was verified to work on real 64-bit hardware in ~7 seconds; the same npm `overrides` fix did not take effect inside the guest even after a from-scratch reinstall — likely because the guest's Alpine-packaged npm (`10.9.1`) handles `overrides` on a nested dependency differently than the host's `12.0.2`. The obvious next step (upgrade npm inside the guest first) was started but not finished — it stalled for 5+ minutes with no output, was killed to avoid an open-ended time sink, and was not retried with a longer budget. | `examples/vite-example/HMR-LIVE-EDIT.md` |
| The zero-server `fetch` network backend, for outbound internet | It can only parse **cleartext HTTP** out of guest traffic and replay it via `fetch()` — it cannot participate in a TLS handshake. Every real npm registry (npmjs.org included) forces HTTPS via a 301 redirect, so this backend can never reach it. A relay server (`wsproxy`/`wisp`, raw ethernet passthrough — the guest does its own TLS) is required for any real internet access. | `packages/network/README.md` |

## Not attempted (neither confirmed working nor confirmed broken)

- **Next.js** — out of scope per current priorities. If tried, the same class of risk as Vite/Rollup applies: Next.js's compiler (SWC) is also a native Rust binary shipped per-platform, and may not publish an `ia32` build either.
- **Any native npm module** (`node-gyp`, `.node` bindings in general) — `packages/vm-image`'s Dockerfile was prepped with `build-base python3` (the toolchain needed to compile them) but never rebuilt or tested (`examples/native-module-example` is a scaffold only).
- **`vite-react-example`** — same Rollup/32-bit blocker as `vite-example` almost certainly applies; not re-run since diagnosing that root cause.
- **Real browser end-to-end** (an actual iframe, live HMR over a WebSocket, Playwright tests actually executing) — this development environment had no real browser available. `e2e/`'s Playwright tests are written and typecheck cleanly but have never been run. `packages/preview-bridge/src/ws-tunnel.ts` (a real WebSocket client over the raw TCP bridge) was built and is ready, but the Vite-blocker above meant it was never exercised against a live HMR session either.

## The actual dividing line (not "Express works, everything else doesn't")

The pattern isn't about specific frameworks — it's:

> **Works:** anything that's pure JavaScript, no matter how it's structured (plain Node, Express, presumably Koa/Fastify/Hono, plain TCP/HTTP servers of any shape).
>
> **Breaks:** anything with a *mandatory* native (compiled) dependency that doesn't ship a 32-bit (`ia32`) build — confirmed for Rollup, suspected for SWC (Next.js), unknown for anything else with native bindings until actually tried.

This is a real, disclosed architectural ceiling of the v86 approach (permanent 32-bit-only emulation), not a bug we introduced or a gap in effort.

## License, for context

v86 itself is BSD-licensed; this project's own code has no license restrictions either. This matters because the "fast" alternatives that don't hit the above ceiling (Nodebox, Nodepod, WebContainer) all carry some form of commercial-use restriction (Commons Clause, a custom non-commercial license, or a paid enterprise tier) — none are unrestricted open source. See the conversation history / commit log for the fuller comparison; not repeated here since it's not this project's own status.

## Repo state

Everything above is committed to this local git repository (no remote configured yet — nothing has been pushed anywhere). Commit messages document each finding, including the failures, in detail; this file is the condensed summary.
