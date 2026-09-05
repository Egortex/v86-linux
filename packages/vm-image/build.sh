#!/usr/bin/env bash
# Builds the guest Linux image (Alpine + Node.js/npm) and packages it as a
# flat virtio-9p file tree + JSON manifest that vm-runtime can boot directly
# (see docs/linux-9p-image.md in github.com/copy/v86 for the underlying format).
set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="dist"
OUT_ROOTFS_TAR="$OUT_DIR/rootfs.tar"
OUT_ROOTFS_FLAT="$OUT_DIR/rootfs-flat"
OUT_FSJSON="$OUT_DIR/fs.json"
CONTAINER_NAME="v86-linux-vm-image"
IMAGE_NAME="v86-linux/vm-image"

mkdir -p "$OUT_DIR"

docker build . --platform linux/386 --rm --tag "$IMAGE_NAME"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker create --platform linux/386 -t -i --name "$CONTAINER_NAME" "$IMAGE_NAME"

docker export "$CONTAINER_NAME" -o "$OUT_ROOTFS_TAR"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# Docker adds this marker file; v86's guest doesn't expect it.
tar -f "$OUT_ROOTFS_TAR" --delete ".dockerenv" || true

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 && "$PYTHON" --version >/dev/null 2>&1 || PYTHON=python

"$PYTHON" tools/fs2json.py --out "$OUT_FSJSON" "$OUT_ROOTFS_TAR"
mkdir -p "$OUT_ROOTFS_FLAT"
"$PYTHON" tools/copy-to-sha256.py "$OUT_ROOTFS_TAR" "$OUT_ROOTFS_FLAT"

echo "Built: $OUT_ROOTFS_TAR, $OUT_ROOTFS_FLAT/, $OUT_FSJSON"
echo "Boot with vm-runtime using filesystem: { baseurl: '$OUT_ROOTFS_FLAT', basefs: '$OUT_FSJSON' }"
