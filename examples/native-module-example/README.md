# examples/native-module-example (not yet built)

**Status: scaffolded, not implemented.** This is the example meant to prove
the plan's other headline argument over Node-lite — that native npm
dependencies (`node-gyp`, `.node` bindings) just work here, because it's a
real x86 ABI, not a JS shim layer.

## Why it isn't done yet

`packages/vm-image`'s Dockerfile currently only installs `nodejs npm`. A
real native-module build (e.g. `better-sqlite3`, `bcrypt`, or any
`node-gyp rebuild`-based package) additionally needs a toolchain inside the
guest: at minimum `python3 make g++` (Alpine's `build-base` + `python3`
packages). That's a one-line Dockerfile change and a `./build.sh` rerun
(a few minutes — Docker build plus re-running `fs2json.py`/
`copy-to-sha256.py` over the larger rootfs), not started here due to time
constraints in this session.

## Plan for whoever picks this up

1. Add `build-base python3` to `vm-image/Dockerfile`'s `$ADDPKGS`, rerun
   `./build.sh`.
2. Boot the rebuilt image, `npm install better-sqlite3` (or similar) inside
   `/root`, over the same `wsproxy`-class backend Phase 3 validated.
3. Verify the compiled `.node` binding actually loads and runs
   (`node -e "require('better-sqlite3')"` or equivalent) — this is the
   actual proof, not just that `npm install` exits 0 (node-gyp failures
   often still leave a package "installed" with a broken binding).
4. Compare install time against a pure-JS package of similar size to get a
   feel for the compile-step overhead inside the emulated CPU.
