# v86-linux

A real x86 Linux kernel running in WASM (via [v86](https://github.com/copy/v86)),
used as an in-browser dev runtime — the alternative architecture to a
Node-lite/WebContainer-style approach. See the original plan at the repo
root for full context; this file tracks what was actually built and
verified, phase by phase.

## Status: Phases 0-5 verified with real spikes; Phase 6 real but partial; Phase 7 (this file)

Every phase below was tested against the real thing — the actual `v86` npm
package, actual Docker builds, actual `npm install` over the actual
internet, actual save_state()/restore_state() — not simulated. Run any
`spike-*.mjs` script yourself to reproduce.

| Phase | What | Result |
|---|---|---|
| 0 | Boot v86's public demo image headlessly | ✅ verified (`examples/minimal`) |
| 1 | Build a custom Alpine+Node.js guest via Docker | ✅ verified — `node -v`/`npm -v` work (`packages/vm-image`) |
| 2 | Host↔guest file exchange over 9p | ✅ verified round-trip (`packages/fs-bridge`) |
| 3 | Real `npm install` from inside the guest | ✅ go, but **only via a relay server** (`packages/network`) |
| 4 | Browser reaches a port the guest listens on | ✅ solved — the plan's most-open risk (`packages/preview-bridge`) |
| 5 | Fast warm restart via snapshots | ✅ verified — ~198x faster than cold boot (`packages/vm-runtime`) |
| 6 | Real Vite end-to-end | ⚠️ **not actually confirmed yet** — the background run hit the tool's own 10-minute cap mid-scaffold; code is real, needs a rerun with proper long-running handling (see below) |

## Phase 3 finding: networking needs a relay server, just not for the reason expected

The plan hoped the zero-server `fetch` backend might suffice for outbound
`npm install`. It doesn't: that backend can only parse cleartext HTTP out of
guest traffic, and every real npm registry forces HTTPS. A `wsproxy`/`wisp`
relay (raw ethernet passthrough, guest does its own TLS) is required — this
was validated against a public relay, but production use needs self-hosting
one. See `packages/network/README.md`.

## Phase 4 finding: the preview problem was solvable, via a backend switch

The `fetch` backend that fails at real internet turns out to expose exactly
the API needed for the *opposite* direction: a synthetic TCP client
(`network_adapter.connect(port)`) that lets host JS dial straight into a
guest's listening port, no relay needed for that direction. The trick is
running the install under `wsproxy`, then `save_state()` + `restore_state()`
into a fresh instance configured with `fetch`, refreshing the guest's DHCP
lease to match. Validated end-to-end. See `packages/preview-bridge/README.md`.

## Phase 6: what's proven vs what remains

**Real, load-bearing finding (not a tooling artifact this time):** Vite's
dev server does not start on v86's guest at all. Root cause confirmed
independently on real hardware: v86 only ever emulates 32-bit x86
(permanent — v86 itself doesn't support 64-bit guests), and modern Rollup
(which Vite's dev server depends on) ships native binaries for 64-bit and
non-x86 targets only — no `ia32` build exists. Rollup has an official WASM
fallback (`@rollup/wasm-node`) for exactly this, and the standard
`npm overrides` fix for it was verified to work correctly on real hardware
in under 10 seconds — but the same fix did not take effect inside the
guest (Alpine's packaged npm is `10.9.1`, two majors behind; the likely
fix, upgrading npm in the guest first, was started but not completed in
this session — see `examples/vite-example/HMR-LIVE-EDIT.md` for the full
trail and untried next steps). `npm create vite`, `npm install` itself, and
a plain Node http server all separately proven to work fine on this guest
(see Phases 2-5) — this is specifically Vite/Rollup's native-binary
compatibility on a 32-bit-only emulator, not a general npm/Vite failure.

`examples/vite-example/spike-phase6-vite.mjs` (the original scaffold-only
check) also has not been confirmed to complete — an earlier background run
was killed by the test-running tool's own 10-minute cap partway through,
and this session's later, deeper investigation (see HMR-LIVE-EDIT.md)
found the real blocker described above, which would affect this script
too.

**Not proven here** (needs a real browser, which this environment doesn't
have): the actual iframe live-preview with Vite's HMR websocket tunneled
through `preview-bridge`, and a live-edit-triggers-reload user flow. The
one-shot HTTP request/response proven in Phase 4 is not the same as a
persistent HMR socket — building that translation layer (Service Worker or
WebSocket-shaped duplex over `connectToGuestPort`) is the next real step,
flagged in `packages/preview-bridge/README.md`'s "what's still open" section.

`native-module-example` (a package with a node-gyp/native binding, to
demonstrate the ABI advantage over Node-lite) needs `python3 make g++`
added to `vm-image`'s Dockerfile — not yet done; the current image only has
`nodejs npm`.

## Performance expectations

- **Cold boot**: ~43s (kernel + initramfs + Alpine init) on this machine,
  before any npm install. Not acceptable to pay on every open.
- **Warm restore**: ~220ms from a saved snapshot. This is what makes the
  runtime usable — snapshot after first successful install, restore on every
  reopen.
- **npm install**: real network speed through whatever relay is configured,
  plus x86-in-WASM CPU overhead for the guest's own npm/node process. A
  small package (`is-odd`) took ~37s; a full Vite scaffold + install takes
  proportionally longer (see the Phase 6 spike's own timing output).
- **Desktop-only** is the realistic v1 scope (plan risk #5) — this wasn't
  re-tested on mobile/low-power hardware here, but the CPU emulation
  overhead alone makes it an easy call.

## Guest image maintenance

`packages/vm-image`'s Dockerfile pins an Alpine base image tag and an
`ADDPKGS` list. There's no incremental update path — bumping either requires
a full `./build.sh` rerun (Docker build, export, refs into `dist/`). This is
genuinely new maintenance surface for a JS-project team (plan risk #2):
budget for periodic Alpine/Node security-patch rebuilds the same way you'd
budget for base-image updates on any containerized service.

## Networking in production

Both the install-mode backend (Phase 3) and, transitively, the preview
handoff (Phase 4) depend on a `wsproxy`-or-similar relay server existing
somewhere. The public relay used for these spikes
(`wss://relay.widgetry.org/`) is shared/rate-limited and explicitly not
meant for production — self-host one (e.g.
[wsnic](https://github.com/chschnell/wsnic)) before shipping this to real
users. This is not the "pure client, no infra" story the plan's Phase 3
description hoped for; it is a real, disclosed piece of infrastructure this
architecture requires that the Node-lite alternative plan does not.

## Repo layout

See each package's own README for details and how to reproduce its spike:

- `packages/vm-image/` — Docker pipeline building the guest image
- `packages/vm-runtime/` — v86 wrapper, snapshots
- `packages/fs-bridge/` — host↔guest file exchange (9p)
- `packages/network/` — install-mode networking findings
- `packages/preview-bridge/` — the Phase 4 port-forward solution
- `packages/runtime/` — public boot()/install()/run()/restart()/writeFile() API
- `examples/minimal/` — Phase 0 spike
- `examples/vite-example/` — Phase 6 spike; Vite's dev server does not
  currently start on this guest (real Rollup/32-bit incompatibility, see
  `HMR-LIVE-EDIT.md` in that directory) — the one confirmed-blocked example
  in this repo, not a gap in effort
- `examples/vite-react-example/` — same Rollup/32-bit blocker applies (not
  yet re-run since diagnosing it in vite-example)
- `examples/express-example/` — **verified end-to-end, real run**: real
  `npm install express`, full install-mode -> preview-mode pipeline, real
  HTTP response received (see that directory's README)
- `examples/native-module-example/` — not yet built (see above)
- `e2e/` — Playwright test package written (boot + preview-http specs); not
  yet run in this environment (needs a real browser; see `e2e/README.md`)
