#!/usr/bin/env bash
#
# Cargo-compatible runner for Tauri's `build.runner` on macOS.
#
# Tauri builds the desktop binary with `cargo build` and launches the resulting
# artifact itself, so Cargo's target runner never sees `tauri dev`. Delegate the
# build unchanged, then apply the stable development signature before Tauri can
# launch the binary. Release builds are deliberately left to Tauri's normal
# distribution signing path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CARGO_BIN="${COGNIA_CARGO_BIN:-cargo}"
SIGNER="${COGNIA_DEV_CODESIGN_SCRIPT:-$SCRIPT_DIR/dev-codesign.sh}"
APP_BIN="${COGNIA_APP_BIN:-cognia-next}"

"$CARGO_BIN" "$@"

is_build=false
profile="debug"
target_triple=""
target_dir="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
next_value=""

for arg in "$@"; do
  if [ -n "$next_value" ]; then
    case "$next_value" in
      profile) profile="$arg" ;;
      target) target_triple="$arg" ;;
      target_dir) target_dir="$arg" ;;
    esac
    next_value=""
    continue
  fi

  case "$arg" in
    build) is_build=true ;;
    --release) profile="release" ;;
    --profile) next_value="profile" ;;
    --profile=*) profile="${arg#--profile=}" ;;
    --target) next_value="target" ;;
    --target=*) target_triple="${arg#--target=}" ;;
    --target-dir) next_value="target_dir" ;;
    --target-dir=*) target_dir="${arg#--target-dir=}" ;;
  esac
done

if [ "$is_build" != true ] || [ "$profile" = "release" ]; then
  exit 0
fi
if [ "$profile" = "dev" ]; then
  profile="debug"
fi

artifact_dir="$target_dir"
if [ -n "$target_triple" ]; then
  artifact_dir="$artifact_dir/$target_triple"
fi
artifact="$artifact_dir/$profile/$APP_BIN"

if [ ! -f "$artifact" ]; then
  echo "tauri-cargo-runner: expected debug artifact not found: $artifact" >&2
  exit 1
fi

"$SIGNER" --sign-only "$artifact"
