# e2e

**Status: written but not run in this environment.** The plan calls for
Playwright e2e covering "install→dev→настоящий Vite HMR WS→iframe→live-правка"
— everything that needs a real browser, which the environment this repo was
built in did not have (headless CLI sandbox only; every spike elsewhere in
this repo instead runs v86 directly under plain Node, which works because
v86's WASM core runs fine outside a browser/DOM). The test files below are
real, not stubs — they just need `pnpm exec playwright install --with-deps
chromium` and a real browser to actually execute.

## What's here

- `package.json` — `@v86-linux/e2e`, private, with `@playwright/test` as a
  devDependency and workspace deps on `@v86-linux/runtime` and
  `@v86-linux/vm-runtime`.
- `playwright.config.ts` — single `chromium` project, `testDir: "./tests"`,
  a `webServer` that starts `fixtures/serve.mjs` and waits on it.
- `fixtures/serve.mjs` — a dependency-free static file server (plain
  `node:http`) that serves `fixtures/harness.html` plus three asset roots
  the harness needs at fixed URL prefixes: `/v86/*` (from
  `node_modules/v86/build`, the actual npm package build), `/bios/*` (from
  `examples/minimal/.assets`, reusing Phase 0's already-downloaded BIOS
  files rather than fetching them again), and `/image/*` (from
  `packages/vm-image/dist`, the already-built guest rootfs — this server
  only ever reads that directory, never rebuilds it).
- `fixtures/harness.html` — the page under test. **Important limitation,
  documented again at the top of the file itself:** there is no bundler
  configured anywhere in this repo yet that could compile
  `packages/vm-runtime`/`packages/preview-bridge`/`packages/runtime`'s
  TypeScript down to something a `<script>` tag can load. Rather than fake
  that, this page loads v86's own prebuilt UMD/global bundle
  (`/v86/libv86.js`, which sets `window.V86`) directly, and reimplements
  the same small amount of logic `boot.ts`/`port-forward.ts` contain
  (prompt detection, `waitForSerial`, the `fetch`-backend
  `network_adapter.connect()` dance) inline in plain JS, exposed as
  `window.__harness`. This means these tests validate that v86 itself
  behaves as those TS wrappers assume, in a real browser — but a bug
  introduced only in the TS wrapper code (as opposed to how it calls v86)
  would not be caught here. Closing that gap means adding a real build step
  (e.g. `tsup`/`esbuild`) to those packages and pointing this page at their
  compiled output instead of reimplementing their logic by hand; not done
  in this pass.
- `tests/boot-and-preview.spec.ts` — boots the real guest image in an
  actual browser tab, waits for the shell prompt to appear in the page's
  `#log` element, then runs a command and asserts its exact output comes
  back over the serial console.
- `tests/preview-http.spec.ts` — starts a real Node HTTP server inside the
  guest, then reaches it from the page via `network_adapter.connect()` (the
  `fetch` backend's host→guest synthetic TCP client documented in
  `packages/preview-bridge/src/port-forward.ts`) and asserts the real
  response body comes back. It intentionally skips the
  install-under-`wsproxy`-then-snapshot-swap-to-`fetch` dance that
  `packages/preview-bridge/spike-phase4-preview.mjs` and
  `@v86-linux/runtime`'s `enterPreviewMode()` do for a real project install
  — this test's "server" needs no install step, so it boots directly with
  the `fetch` backend and the swap would add nothing but wall-clock time
  (that combined flow is already covered by the spike and by `runtime.ts`).

## Setup once a browser is available

```sh
pnpm install
pnpm exec playwright install --with-deps chromium
pnpm --filter @v86-linux/e2e test
# or, from the repo root:
pnpm test:e2e
```

## What remains unverified

Everything that requires actually launching Chromium: whether
`page.goto()`/the `webServer` wiring works end to end, whether v86's WASM
module instantiates correctly in a real browser tab (as opposed to Node,
which every other spike in this repo uses), whether the asset URLs
`fixtures/serve.mjs` serves are exactly right for `libv86.js`'s browser
code path (it may fetch `v86.wasm` and the filesystem's `fs.json`/`rootfs-flat`
files with different request patterns — e.g. range requests — than it does
under Node), and both tests' actual pass/fail behavior. `npx tsc --noEmit`
was run against the config/test TypeScript in this package to catch
type-level mistakes, but that cannot substitute for actually executing
these tests in a browser.

## Not built here

- Live-edit/HMR coverage (`writeFile()` a source change, assert Vite's HMR
  fires and an iframe updates without a full reload) — still blocked on the
  WebSocket-shaped duplex over `connectToGuestPort` flagged as unbuilt in
  `packages/preview-bridge`'s README.
- Warm-start-via-snapshot reuse across the test suite (to avoid paying the
  ~43s cold boot per test) — both tests here cold-boot independently; worth
  revisiting once the suite has more than two tests.
