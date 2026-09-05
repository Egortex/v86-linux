# examples/vite-react-example

Same claim as `examples/vite-example` (real Vite runs unmodified, no
compatibility layer) but with the `react` template — a heavier, more
realistic dependency tree (React, JSX transform via esbuild/Babel) than the
vanilla template — and taken one step further: it actually connects to the
running dev server from host JS and checks the response looks like a real
Vite page, not just that the dev server's own log claims to be listening.

```sh
node spike-vite-react.mjs
```

Pipeline (same as `examples/express-example`):

1. Boot under `wsproxy`, real DHCP.
2. `npm create vite@latest my-react-app -- --template react` (unattended via
   `npm_config_yes=true`).
3. `npm install` inside the scaffolded project.
4. `npm run dev -- --host 0.0.0.0 --port 5174`.
5. `save_state()` -> destroy -> restore under `fetch` backend -> refresh
   DHCP (see `packages/preview-bridge/README.md`).
6. `network_adapter.connect(5174)` from host JS, GET `/`, assert the
   response is a real 200 with Vite's client script or React's root div in
   the body.

Each scaffold/install/dev step prints its own wall-clock time.

**Still not covered** (same limitation as `examples/vite-example`): an
actual browser loading this through an iframe with live HMR — this spike
proves one-shot request/response, not a persistent HMR websocket. See
`packages/preview-bridge/README.md`'s "what's still open" section.

Requires `packages/vm-image/dist/` and `examples/minimal/.assets/`. Takes
longer than the vanilla template (`examples/vite-example`) — React pulls in
more dependencies.
