#!/usr/bin/env bash
#
# Stable Rust driver for the Mach-O LLD bundled with the pinned toolchain.
# Cargo resolves this script relative to the workspace `.cargo/config.toml`.

set -euo pipefail

rustc_bin="${RUSTC:-rustc}"
clang_bin="${COGNIA_CLANG_BIN:-/usr/bin/clang}"
target_libdir="$("$rustc_bin" --print target-libdir)"
lld="${target_libdir%/lib}/bin/gcc-ld/ld64.lld"

if [ ! -x "$lld" ]; then
  echo "macos-lld-linker: bundled ld64.lld not found at $lld" >&2
  exit 1
fi

exec "$clang_bin" "-fuse-ld=$lld" "$@"
