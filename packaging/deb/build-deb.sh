#!/bin/sh
# Build a .deb: build-deb.sh <version> <arch: amd64|arm64> <binary> <outdir>
# Output: <outdir>/ghostrow_<version>_<arch>.deb
set -eu

[ "$#" -eq 4 ] || { echo "usage: $0 <version> <amd64|arm64> <binary> <outdir>" >&2; exit 2; }
version="$1"; arch="$2"; binary="$3"; outdir="$4"
case "$arch" in amd64 | arm64) ;; *) echo "arch must be amd64 or arm64" >&2; exit 2 ;; esac
[ -f "$binary" ] || { echo "binary not found: $binary" >&2; exit 2; }

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/pkg/DEBIAN" "$root/pkg/usr/bin" "$outdir"
install -m 0755 "$binary" "$root/pkg/usr/bin/ghostrow"

size_kb="$(du -sk "$root/pkg/usr" | awk '{ print $1 }')"
cat > "$root/pkg/DEBIAN/control" <<CONTROL
Package: ghostrow
Version: $version
Section: utils
Priority: optional
Architecture: $arch
Installed-Size: $size_kb
Maintainer: Ghostrow Labs LLC <support@ghostrow.com>
Homepage: https://ghostrow.com
Description: Realistic, consistent test data from your database schema
 Ghostrow reads a database schema and generates consistent, realistic test
 data that contains no real personal data. It runs offline, is seeded so the
 output is repeatable, and works with Postgres, MySQL, SQL Server and SQLite.
CONTROL

dpkg-deb --root-owner-group --build "$root/pkg" "$outdir/ghostrow_${version}_${arch}.deb"
