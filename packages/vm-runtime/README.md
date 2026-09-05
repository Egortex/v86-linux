# @v86-linux/vm-runtime

Thin wrapper over the `v86` npm package: `boot.ts` (construct + serial
console helpers) and `snapshot.ts` (save_state/restore_state).

## Phase 5 finding: snapshots are not optional, they're the difference between usable and not

Measured in `spike-phase5-snapshot-timing.mjs` (same machine, same guest
image, `fetch` backend both times):

| | time to ready |
|---|---|
| cold boot (kernel + initramfs + Alpine init) | ~43.4s |
| warm restore from a saved snapshot | ~220ms |

**~198x faster.** This confirms plan risk #1 in the direction that matters:
without snapshotting, reopening a project pays the full boot cost every
time, which is not acceptable UX. With it, reopening is near-instant.

Also confirmed (see `packages/preview-bridge`'s Phase 4 spike): a snapshot
saved under one network backend restores cleanly into an instance configured
with a *different* backend, as long as `preserve_mac_from_state_image: true`
is set and the guest's network interface is cycled + re-DHCP'd afterward.
This is a stronger guarantee than same-config warm restart alone, and is
exactly what the install-mode -> preview-mode transition (Phase 4) depends
on.

## Running the spike

```sh
node spike-phase5-snapshot-timing.mjs
```

Requires `packages/vm-image/dist/` and `examples/minimal/.assets/` — see
those packages' READMEs.
