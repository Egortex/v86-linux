# @v86-linux/vm-image

Builds the guest Linux image used by the rest of the monorepo: i386 Alpine
Linux + Node.js/npm, packaged as a flat virtio-9p file tree (not a disk image)
that v86 boots directly, using its own kernel + initramfs pulled from inside
the filesystem (`bzimage_initrd_from_filesystem: true`).

Based on v86's own reference recipe (`tools/docker/alpine/` in
[copy/v86](https://github.com/copy/v86)), extended with `nodejs npm`.

## Build

Requires Docker with i386 (`linux/386`) emulation available (Docker Desktop
ships this via QEMU binfmt handlers) and Python 3 on the host.

```sh
./build.sh
```

Produces in `dist/`:
- `rootfs.tar` — raw container filesystem export (intermediate, not needed at runtime)
- `rootfs-flat/` — files renamed to their sha256 hash, as `vm-runtime` expects
- `fs.json` — the 9p filesystem manifest matching `rootfs-flat/`

## Boot config

```ts
new V86({
    // ...bios/vga_bios as usual...
    bzimage_initrd_from_filesystem: true,
    cmdline: "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose " +
             "modules=virtio_pci tsc=reliable init_on_free=on",
    filesystem: {
        baseurl: "packages/vm-image/dist/rootfs-flat",
        basefs: "packages/vm-image/dist/fs.json",
    },
});
```

## Updating

Bump the Alpine base tag or `ADDPKGS` in `Dockerfile`, then re-run
`./build.sh`. There is no incremental update path — a full rebuild is the
maintenance model (see plan risk #2: this is Linux/Docker/Alpine maintenance
work, not just TypeScript).
