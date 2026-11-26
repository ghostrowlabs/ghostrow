#!/bin/sh
# Build an unsigned macOS .pkg: build-pkg.sh <version> <arch: arm64|x64> <binary> <outdir>
# Output: <outdir>/ghostrow-<version>-macos-<arch>.pkg (installs /usr/local/bin/ghostrow)
set -eu

[ "$#" -eq 4 ] || { echo "usage: $0 <version> <arm64|x64> <binary> <outdir>" >&2; exit 2; }
version="$1"; arch="$2"; binary="$3"; outdir="$4"
case "$arch" in arm64 | x64) ;; *) echo "arch must be arm64 or x64" >&2; exit 2 ;; esac
[ -f "$binary" ] || { echo "binary not found: $binary" >&2; exit 2; }

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/payload/usr/local/bin" "$outdir"
install -m 0755 "$binary" "$root/payload/usr/local/bin/ghostrow"

pkgbuild \
  --root "$root/payload" \
  --identifier com.ghostrow.cli \
  --version "$version" \
  --install-location / \
  "$outdir/ghostrow-${version}-macos-${arch}.pkg"
