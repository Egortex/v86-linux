# @v86-linux/preview-bridge

Phase 4 was the plan's most-open risk — "no known recipe in v86's
documentation for browser reaching a port a server listens on inside the
guest." It turned out to have a real, validated answer.

## The mechanism

v86's `fetch` network backend exposes an undocumented-in-`v86.d.ts` but real
and officially-demoed API: `emulator.network_adapter.tcp_probe(port)` /
`.connect(port)` — a synthetic TCP client living entirely in host/browser JS
that dials straight into a port the guest is listening on. See
[`examples/tcp_terminal.html`](https://github.com/copy/v86/blob/master/examples/tcp_terminal.html)
in copy/v86 (added in PR #1233). No relay server, no port-forwarding
infrastructure — this direction really is solvable client-side.

## The catch, and the fix

Only the `fetch` backend has this API. But (see `packages/network`'s Phase 3
findings) the `fetch` backend cannot do real outbound HTTPS, which real
`npm install` needs. So a VM configured for `fetch` can never have run the
install in the first place — these looked like mutually exclusive
requirements.

**Validated fix** (`spike-phase4-preview.mjs`):

1. Boot under `wsproxy` (real internet). Run the real `npm install`, start
   the dev server.
2. `save_state()`.
3. Construct a **fresh** `V86` instance configured with the `fetch` backend
   and `preserve_mac_from_state_image: true`. `restore_state()` the snapshot
   into it.
4. The guest's network stack still holds the IP it DHCP'd under `wsproxy` (a
   real subnet address) — the `fetch` backend is a separate JS-side virtual
   router expecting its own subnet (`192.168.86.0/24` by default) and knows
   nothing about that old lease. Cycle the interface and re-run DHCP
   (`refreshGuestNetworkForPreview` in `src/port-forward.ts`) so the guest
   negotiates an address the new backend actually recognizes. The
   already-running dev server is unaffected — it listens on `0.0.0.0`.
5. `network_adapter.tcp_probe(port)` / `.connect(port)` now reach it.

Confirmed end-to-end: a real `node -e "http.createServer(...).listen(8080)"`
started inside the guest under `wsproxy`, snapshotted, restored under
`fetch`, and answered a real `GET / HTTP/1.0` from host JS with
`preview-ok from guest`.

This also happens to be a real (if accidental) proof of Phase 5's snapshot
mechanism working across a **backend change**, which is a stronger
guarantee than same-config warm-restart alone.

## What's still open

- This is one-shot request/response for the spike. A real preview iframe
  needs either a Service Worker translating `fetch()` calls into
  `connectToGuestPort` calls, or (for dev-server HMR) a WebSocket-shaped
  duplex over the same raw connection — neither is built here.
- The DHCP-cycle step adds a few seconds of latency to every "switch from
  install-mode to preview-mode" transition. Worth investigating whether a
  static IP matching both backends' expectations sidesteps this.
- Only tested with a single guest listening port; multiplexing many ports
  (one per running dev server) through one `fetch`-backend instance is
  untested but should work the same way per-port.

## Running the spike

```sh
node spike-phase4-preview.mjs
```

Requires `packages/vm-image/dist/` (run `vm-image`'s `build.sh` first) and
`examples/minimal/.assets/` (auto-downloaded by
`examples/minimal/spike-phase0-boot.mjs`). Takes ~60-90s (real npm-install
class network round trip via a public wsproxy relay in stage A).
