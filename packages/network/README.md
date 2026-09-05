# @v86-linux/network

Phase 3 spike results — real `npm install` from inside the guest.

## Finding: the `fetch` backend cannot reach npm (no-go for pure client-side networking)

Tested with `net_device: { type: "virtio", relay_url: "fetch" }` (no relay
server, per docs/networking.md in copy/v86):

- Plain HTTP (`http://example.com/`) works — the backend intercepts the
  guest's HTTP request bytes and replays them via `fetch()`.
- HTTPS (`https://registry.npmjs.org/...`) fails with "connection refused".
  The `fetch` backend can only parse **cleartext HTTP** out of the guest's
  TCP stream; a TLS handshake is opaque bytes to it, so there is nothing to
  translate into a `fetch()` call.
- `registry.npmjs.org` (and effectively every real npm registry today)
  redirects plain HTTP to HTTPS with a 301 — there is no way around this by
  configuring npm to use `http://`.

**Conclusion: the "outbound networking without any relay server" path the
plan hoped for does not work for real npm installs.** This confirms plan
risk #3 in the worst direction.

## Finding: `wsproxy` (raw ethernet relay) is a real go — but needs a server

Tested with `net_device: { type: "virtio", relay_url: "wss://relay.widgetry.org/" }`
(a public wsproxy instance, see docs/networking.md):

- DHCP, DNS (via 8.8.8.8/8.8.4.4 handed out by the proxy), plain HTTP, and
  HTTPS to `registry.npmjs.org` all work — this backend forwards raw
  ethernet frames, so the guest's own TLS stack does the handshake and there
  is nothing for the relay to parse.
- `npm install is-odd` completed for real in ~37s end-to-end inside the
  booted custom Alpine+Node.js image (see `spike-phase3-network.mjs`).

**Conclusion: real `npm install` is achievable, but only via a backend that
requires a relay server component** (`wsproxy` or `wisp`), not the
zero-server `fetch` backend the plan's Phase 3 hoped might suffice. For
production use, self-hosting a relay (e.g.
[wsnic](https://github.com/chschnell/wsnic) or
[websockproxy](https://github.com/benjamincburns/websockproxy)) is required
— the public `relay.widgetry.org` instance used here is rate-limited/shared
and not suitable beyond spiking.

## Running the spikes

```sh
node spike-phase3-diag.mjs      # step-by-step: DHCP, resolv.conf, http, https
node spike-phase3-network.mjs   # end-to-end npm install via wsproxy
```

Both require `packages/vm-image/dist/` to exist (`vm-image`'s `build.sh` must
have run first) and `examples/minimal/.assets/` bios files (auto-downloaded
by `examples/minimal/spike-phase0-boot.mjs`).
