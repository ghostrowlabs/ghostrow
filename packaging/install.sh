#!/bin/sh
# Ghostrow installer for Linux and macOS.
#   curl -fsSL https://ghostrow.com/install.sh | sh
# Environment: GHOSTROW_VERSION, GHOSTROW_INSTALL, GHOSTROW_NO_MODIFY_PATH=1
set -eu

REPO="ghostrowlabs/ghostrow"

say() { printf '%s\n' "$*"; }
fail() { printf 'ghostrow install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) fail "unsupported operating system '$(uname -s)'. This script supports Linux and macOS. On Windows use: irm https://ghostrow.com/install.ps1 | iex" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported CPU architecture '$(uname -m)'. Ghostrow ships for x64 and arm64." ;;
esac

if have curl; then
  fetch() { curl -fsSL "$1" -o "$2"; }
  fetch_stdout() { curl -fsSL "$1"; }
elif have wget; then
  fetch() { wget -q -O "$2" "$1"; }
  fetch_stdout() { wget -q -O - "$1"; }
else
  fail "curl or wget is required."
fi

version="${GHOSTROW_VERSION:-}"
if [ -z "$version" ]; then
  release_json="$(fetch_stdout "https://api.github.com/repos/$REPO/releases/latest")" \
    || fail "could not look up the latest release. Set GHOSTROW_VERSION and try again."
  version="$(printf '%s\n' "$release_json" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi
version="${version#v}"
[ -n "$version" ] || fail "could not determine the latest version. Set GHOSTROW_VERSION and try again."

asset="ghostrow-$version-$os-$arch.tar.gz"
base="https://github.com/$REPO/releases/download/v$version"

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t ghostrow)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

say "Downloading Ghostrow $version for $os $arch"
fetch "$base/$asset" "$tmp/$asset" || fail "download failed: $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "$asset is not listed in SHA256SUMS."

if have sha256sum; then
  actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
elif have shasum; then
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
else
  fail "sha256sum or shasum is required to verify the download."
fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed."
say "Checksum verified"

install_root="${GHOSTROW_INSTALL:-$HOME/.ghostrow}"
bin_dir="$install_root/bin"
mkdir -p "$tmp/unpack" "$bin_dir"
tar -xzf "$tmp/$asset" -C "$tmp/unpack" ghostrow
cp "$tmp/unpack/ghostrow" "$bin_dir/ghostrow.new"
chmod +x "$bin_dir/ghostrow.new"
mv -f "$bin_dir/ghostrow.new" "$bin_dir/ghostrow"
say "Installed $bin_dir/ghostrow"

path_line="export PATH=\"$bin_dir:\$PATH\""
if [ "${GHOSTROW_NO_MODIFY_PATH:-}" = "1" ]; then
  say "Left your shell profiles alone (GHOSTROW_NO_MODIFY_PATH=1). Add this to your PATH yourself:"
  say "  $path_line"
else
  for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ "$profile" != "$HOME/.profile" ] && [ ! -f "$profile" ]; then
      continue
    fi
    if [ -f "$profile" ] && grep -F "$bin_dir" "$profile" >/dev/null 2>&1; then
      continue
    fi
    printf '\n# Ghostrow\n%s\n' "$path_line" >> "$profile"
    say "Added $bin_dir to PATH in $profile"
  done
fi

say ""
say "Done. Open a new terminal (or run: $path_line), then try:"
say "  ghostrow --version"
say "  ghostrow seed --schema schema.sql --dry-run"
say "Docs: https://ghostrow.com/docs/quickstart"
