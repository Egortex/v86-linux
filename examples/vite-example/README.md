# examples/vite-example

Phase 6 spike: proves the plan's central claim — a real Vite project runs
inside the v86-Linux guest completely unmodified, no compatibility layer.

```sh
node spike-phase6-vite.mjs
```

Runs, against a real `wsproxy` relay, in sequence:

1. `udhcpc` — real DHCP
2. `npm create vite@latest my-app -- --template vanilla` — real scaffold
3. `npm install` inside the scaffolded project — real dependency resolution
4. `npm run dev -- --host 0.0.0.0 --port 5173` — real Vite dev server
5. Dumps the dev server's own log to prove it's actually listening

Each step prints its own wall-clock time so you can see where the cost is
(scaffold/install dominate; the guest's own CPU-in-WASM overhead is smaller
than the network round trips through the shared public relay).

**What this does NOT prove**: an actual browser loading the dev server
through an iframe with live HMR. That needs `packages/preview-bridge`'s
`connectToGuestPort` wired into a Service Worker or WebSocket-shaped duplex,
and a real browser to run it in — this environment could not do either.
Treat this spike as "the guest-side half of Phase 6 works"; the browser-side
half is the next real step.

Requires `packages/vm-image/dist/` and `examples/minimal/.assets/` — see
those packages' READMEs. Takes several minutes (real network against a
shared public relay — expect it to be slower and less predictable than a
self-hosted relay would be).
