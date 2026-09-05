# HMR / live-edit test

Closes part of the gap flagged in `packages/preview-bridge/README.md`
("what's still open" — no WebSocket-shaped duplex over `connectToGuestPort`
yet) and in `e2e/README.md` ("Not built here" — HMR coverage).

**Status: transport built and validated in isolation; full Vite HMR
end-to-end blocked on a real, still-open compatibility issue (see below) —
not a fake/simulated result.**

## What's proven

`packages/preview-bridge/src/ws-tunnel.ts` — a minimal RFC6455 WebSocket
client (handshake + frame encode/decode, ping/pong) built directly on top of
a `PreviewConnection` (the raw TCP object from `port-forward.ts`, i.e. v86's
`fetch`-backend synthetic TCP client). Text frames only — enough for Vite's
JSON-over-text-frame HMR protocol. Imported directly as a `.ts` file from
plain `.mjs` spikes via Node 24's native TypeScript support — no build step.

The two-stage snapshot handoff (install under `wsproxy` → `save_state()` →
restore under `fetch` → refresh DHCP) that Phase 4 validated with a bare
`http.createServer` was re-confirmed here with a real npm-installed
project: `stage1` genuinely got `npm install` to complete (twice, ~8-12min
each over the shared public relay) and `save_state()`'d a 266MB snapshot to
disk; `stage2` genuinely restored it in a separate process and reconnected
networking.

## What's blocked: Vite's dev server won't start on v86's guest

**Root cause, confirmed independently on real hardware (not guessed):**
v86 only ever emulates 32-bit x86 (`ia32`) — this is permanent, not a
config mistake (v86's own README: "64-bit kernels are not supported").
Modern Rollup (which Vite's dev server depends on) ships a native `.node`
binary per platform+architecture and **does not publish an `ia32` build at
all** — only 64-bit and non-x86 targets. Vite's own dev server fails at
startup:

```
Error: Your current platform "linux" and architecture "ia32" combination
is not yet supported by the native Rollup build. Please use the WASM
build "@rollup/wasm-node" instead.
```

Rollup ships an official WASM fallback (`@rollup/wasm-node`) for exactly
this situation — the same technique WebContainer/Nodebox use for *every*
native binary, since they can't run native code at all. The standard fix
is an npm `overrides` entry: `"overrides": { "rollup": "npm:@rollup/wasm-node@^4" }`.

**This override works correctly** — reproduced on the real host machine
(`npm 12.0.2`): a clean `npm install` resolved `node_modules/rollup` to the
actual `@rollup/wasm-node` package in ~7 seconds, no special steps needed.

**It does not work inside the guest**, even after a from-scratch reinstall
(`rm -rf node_modules package-lock.json` first, to rule out stale-lockfile
explanations): `node_modules/rollup` stayed the native package regardless,
and the dev server kept failing with the identical error. The guest's
Alpine-packaged npm is `10.9.1`, two majors behind the host's `12.0.2` — the
working theory is that this older npm doesn't apply `overrides` to a
dependency the way `12.x` does for this case (Vite's own nested dependency
on `rollup`), though this wasn't confirmed by reading npm's changelog, only
inferred from the host-vs-guest behavioral difference.

**The obvious next step** — `npm install -g npm@12` inside the guest before
retrying — was started but not completed in this session: it ran for 5+
minutes with no output at all (npm's own package has a large registry
metadata history too, likely the same class of slowness diagnosed in
`packages/network`'s and this example's earlier findings) and was killed
to avoid burning further session time on an increasingly deep rabbit hole.
**This is a real, open, reproducible finding, not a dead end** — likely
fixes, untried:
- Let the `npm install -g npm@12` run to completion with a much longer
  budget (it may simply need more than 5 minutes, consistent with
  everything else measured in this environment).
- Skip npm's `overrides` entirely: install `@rollup/wasm-node` as a regular
  `devDependency` and manually replace `node_modules/rollup`'s contents
  with it (or symlink) after install — sidesteps whatever the guest npm's
  `overrides` resolution gap actually is.
- Try `pnpm` instead of `npm` inside the guest (not installed in the
  current `vm-image`) — pnpm's override mechanism is implemented
  differently and may not share this gap.

## What's still separately open regardless of the above

- An actual iframe rendering the page and re-rendering on HMR update would
  still need `ws-tunnel.ts` wired behind something that looks like a real
  browser `WebSocket` object, verified in a real browser — same limitation
  noted throughout `e2e/README.md`. Not reached because the dev server
  itself never started.
- Only the vanilla template was targeted, which is more likely to trigger
  Vite's `full-reload` fallback than a granular HMR `update` (no framework
  HMR boundary registered in bare `.js`) — the test script accepts either.

## Files

- `spike-hmr-stage1-install.mjs` — boot under `wsproxy`, write a minimal
  Vite project via the 9p fs-bridge (not `npm create vite`, which hit an
  unrelated but equally real bug — see below), `npm install`, poll for the
  dev server's ready banner, `save_state()` to `.hmr-snapshot.bin`.
- `spike-hmr-stage2-live-edit.mjs` — restore the snapshot under `fetch`,
  refresh DHCP, open the HMR WebSocket, `create_file` a source edit, assert
  an update/full-reload message. Never reached a real run because stage 1's
  dev server never started (see above) — written and typechecked, not
  exercised end-to-end.
- `resume-and-start-dev.mjs`, `resume-fix-rollup-wasm.mjs`,
  `diag-check-vite-log.mjs` — diagnostic/recovery scripts written while
  chasing the two bugs below; kept because they demonstrate the
  resume-from-disk-snapshot pattern and are useful starting points for
  whoever continues this.

## Unrelated bug also found and fixed along the way: `npm create vite` crashes on this guest

Originally this test scaffolded via `npm create vite@latest` like
`examples/vite-example/spike-phase6-vite.mjs`. That consistently crashed:

```
TypeError [ERR_INVALID_ARG_VALUE]: The argument 'x' is invalid. Received NaN
    at cursorTo (node:internal/readline/callbacks:43:29)
    at Interface.prompt (node:internal/readline/interface:392:25)
```

`create-vite` constructs a `readline.Interface` tied to stdout regardless
of `--template` being passed. The guest's serial console is a real pty
(`isTTY` true) but doesn't report terminal dimensions the way an
interactive terminal would, so Node's readline internals compute `NaN` for
the cursor column. Setting `COLUMNS`/`LINES` env vars does **not** fix
this — Node's tty column detection uses a real `ioctl`, not those vars.
Ruled out a stale-file/overwrite-prompt explanation too (checked directly:
`vm-image`'s 9p writes don't persist across VM instances). Worked around by
writing the (tiny) vanilla-template files directly via the 9p fs-bridge
instead of driving the interactive CLI — arguably closer to how a real
product would work anyway (a host-side editor writes files; it doesn't
drive an interactive CLI scaffolder inside the guest).

## A second, separate bug found and fixed: shell-prompt regex didn't match subdirectories

All spikes' `PROMPT` regex was anchored to exactly `~#`, matching only when
the guest shell's cwd is the home directory. `cd`ing into a project
subdirectory shows `localhost:~/my-app#` instead, which never matched —
causing `sendAndWaitForPrompt` to time out even after the underlying
command had already genuinely succeeded (confirmed directly: a stage1 run
showed real `added 9 packages in 8m` from `npm install`, immediately
followed by the unmatched prompt, then a timeout from our own script).
Fixed everywhere (10 spike scripts) by widening the regex to
`/:~\S*#\s*$/`.
