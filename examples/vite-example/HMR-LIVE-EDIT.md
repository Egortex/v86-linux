# HMR / live-edit test

Closes the gap flagged in `packages/preview-bridge/README.md` ("what's
still open" — no WebSocket-shaped duplex over `connectToGuestPort` yet) and
in `e2e/README.md` ("Not built here" — HMR coverage).

## What it proves

That a file written into the guest through the 9p fs-bridge (`create_file`
— the same primitive a real host-side editor integration would use, not a
shell command) is picked up by Vite's file watcher, and pushes a real
update over a real WebSocket connection to Vite's HMR endpoint — where that
WebSocket itself is tunneled through v86's `fetch`-backend synthetic TCP
client (`network_adapter.connect()`), the same mechanism validated for
one-shot HTTP in Phase 4.

## New code

`packages/preview-bridge/src/ws-tunnel.ts` — a minimal RFC6455 WebSocket
client (handshake + frame encode/decode) built directly on top of a
`PreviewConnection` (the raw TCP object from `port-forward.ts`). Not a
general-purpose implementation: no fragmentation, text frames only — enough
for Vite's JSON-over-text-frame HMR protocol. Handles server pings (replies
with pong) so the connection doesn't get dropped as idle.

Both spike scripts import `port-forward.ts` and `ws-tunnel.ts` **directly**
as `.ts` files — Node 24's native TypeScript support (type-stripping) loads
them with no build step. This is a better path than the `.mjs`-reimplements-
the-TS-logic-by-hand pattern used in earlier spikes in this repo (and in
`e2e/fixtures/harness.html`, which still has to do that because it runs in
a browser, where no such native loader exists yet).

## Running it (two stages, to fit the tool's own time budget)

The instructions below assume there is no time-limited wrapper around your
shell — if there is one, a real npm install against a shared/rate-limited
public relay can occasionally stall for several minutes, so prefer starting
stage 1 as a detached background process and polling its log rather than
blocking on it directly.

```sh
node spike-hmr-stage1-install.mjs
# writes .hmr-snapshot.bin and .hmr-meta.json on success

node spike-hmr-stage2-live-edit.mjs
# reads them, does the actual HMR/live-edit assertion
```

Stage 1: boot under `wsproxy` -> DHCP -> `npm create vite@latest -- --template
vanilla` -> `npm install` -> find the scaffold's editable `.js` file (its
name has changed across create-vite versions, so this is discovered at
runtime rather than hardcoded) -> start the dev server -> `save_state()` to
disk.

Stage 2 (separate process — also demonstrates persisting a snapshot across
process boundaries, closer to real product behavior than an in-memory
handoff): restore the snapshot under the `fetch` backend, refresh DHCP,
open a WebSocket to the dev server with the `vite-hmr` subprotocol, wait for
Vite's `{"type":"connected"}` handshake message, then `create_file` a new
version of the discovered source file and wait for Vite to push an
`"update"` or `"full-reload"` message.

## What this does not cover

- An actual iframe rendering the page and re-rendering on HMR update — this
  proves the transport (WebSocket tunneled over `connectToGuestPort`) and
  the trigger (a 9p file write reaching Vite's watcher), not a rendered
  page. Wiring `ws-tunnel.ts` behind something that looks like a real
  browser `WebSocket` object (so an unmodified Vite client script can use
  it inside an iframe) is the next step, and needs a real browser to
  verify — same limitation noted throughout `e2e/README.md`.
- Only tested against the vanilla template's plain `.js` reload path,
  which is more likely to trigger Vite's `full-reload` fallback than a
  granular HMR `update` (no framework HMR boundary is registered in a
  bare vanilla-JS file) — the test accepts either, since both prove the
  same underlying transport works; a framework template (React/Vue) would
  be needed to exercise true granular HMR update messages.
