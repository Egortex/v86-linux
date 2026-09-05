# e2e (not yet built)

**Status: not implemented.** The plan calls for Playwright e2e covering
"install→dev→настоящий Vite HMR WS→iframe→live-правка" — everything that
needs a real browser, which the environment this repo was built in did not
have access to (headless CLI sandbox only; every spike in this repo instead
runs v86 directly under plain Node, which works because v86's WASM core
runs fine outside a browser/DOM).

## What's actually needed here

- A Playwright test that loads a page embedding `packages/runtime`, calls
  `boot()` → `install()` → `enterPreviewMode()` → starts a dev server via
  `run()`, and asserts an iframe pointed at a `previewPort()`-backed URL
  actually renders the page.
- A second test exercising live-edit: `writeFile()` a source change, assert
  Vite's HMR fires and the iframe updates without a full reload — this is
  the piece flagged as unbuilt in `packages/preview-bridge`'s README (no
  WebSocket-shaped duplex over `connectToGuestPort` yet).
- Given the ~43s cold-boot cost (see `packages/vm-runtime`'s README),
  these tests should snapshot after their first successful install and
  reuse that snapshot across the test suite rather than reinstalling per
  test.

## Setup once a browser is available

```sh
pnpm add -D @playwright/test
pnpm exec playwright install --with-deps chromium
```
