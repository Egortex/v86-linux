# examples/express-example

**Status: verified end-to-end, real run.** A real Express.js app,
unmodified, exercising the full install-mode -> preview-mode pipeline
(Phases 3+4 combined) with a concrete real-world web framework instead of a
bare `http.createServer`.

Confirmed: `npm install express` (68 packages, ~2min over the shared public
relay), a real `server.js` written via the 9p fs-bridge, the server
detected ready after ~10s of polling (a fixed short sleep isn't reliable —
Node startup itself takes real wall-clock time under CPU emulation), a
133MB snapshot saved and restored in a fresh `fetch`-backend instance, and
a genuine HTTP response received from host JS:

```
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: text/html; charset=utf-8
...
hello from real Express inside v86-linux
```

```sh
node spike-express.mjs
```

What it does:

1. Boots under `wsproxy` (real internet — see `packages/network/README.md`
   for why the zero-server `fetch` backend can't do this).
2. `npm install express` inside `/root/express-app`.
3. Writes a real `server.js` (using Express's routing API) via the 9p
   fs-bridge (`create_file`) — not `node -e`, closer to how a real project's
   source would actually land in the guest.
4. Starts the server, `save_state()`, destroys the instance.
5. Restores the snapshot into a fresh instance configured with the `fetch`
   backend, refreshes the guest's DHCP lease (see
   `packages/preview-bridge/README.md` for why this is needed).
6. Connects to the running Express server on port 3000 from host JS via
   `network_adapter.connect()` and asserts a real response, including the
   `X-Powered-By: Express` header Express itself adds — proof this is the
   real framework, not a stand-in.

Requires `packages/vm-image/dist/` and `examples/minimal/.assets/` — see
those packages' READMEs. Takes a few minutes (real network against the
shared public relay).
