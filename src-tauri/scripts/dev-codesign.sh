#!/usr/bin/env bash
#
# Stable-signing helper for local macOS development.
#
# Cargo's target runner invokes this as
# `dev-codesign.sh <path-to-binary> [args…]`. It re-signs the freshly-built
# `cognia-next` and its `cognia-server` companion with the stable identity from
# `dev-codesign-setup.sh`, keeping its designated requirement constant across
# rebuilds so the login keychain stops re-prompting.
#
# Non-macOS hosts and unrelated binaries pass through.
# macOS app launches require the dedicated stable identity: a broken signing
# setup must never silently launch the linker's ad-hoc signature.
set -euo pipefail

IDENTITY="${COGNIA_DEV_SIGNING_IDENTITY:-Cognia Dev Signing}"
DEV_KEYCHAIN="${COGNIA_DEV_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/cognia-dev-signing.keychain-db}"
bin="${1:?dev-codesign: missing binary path}"

binary_name="$(basename "$bin")"
if [ "$binary_name" != "cognia-next" ] && [ "$binary_name" != "cognia-server" ]; then
  exec "$@"
fi
if [ "$(uname -s)" != "Darwin" ]; then
  exec "$@"
fi

fail() {
  echo "dev-codesign: $*; refusing to launch '$bin'." >&2
  echo "dev-codesign: repair the dedicated signing keychain with: pnpm dev:sign:setup" >&2
  exit 1
}

command -v codesign >/dev/null 2>&1 || fail "codesign is unavailable"
command -v security >/dev/null 2>&1 || fail "security is unavailable"
[ -f "$DEV_KEYCHAIN" ] || fail "development keychain is missing: $DEV_KEYCHAIN"

# This passwordless keychain contains only the disposable dev identity. Never
# unlock or fall back to the login keychain, or a different signing identity.
security unlock-keychain -p "" "$DEV_KEYCHAIN" \
  || fail "could not unlock development keychain: $DEV_KEYCHAIN"

# Do not use -v: it hides the self-signed dev certificate as untrusted.
identities="$(security find-identity -p codesigning "$DEV_KEYCHAIN")" \
  || fail "could not inspect signing identities in $DEV_KEYCHAIN"
signing_identity="$(printf '%s\n' "$identities" \
  | awk -v identity="$IDENTITY" 'index($0, "\"" identity "\"") { print $2; exit }')"
[ -n "$signing_identity" ] || fail "signing identity '$IDENTITY' is missing from $DEV_KEYCHAIN"

sign_binary() {
  codesign --force --keychain "$DEV_KEYCHAIN" --sign "$signing_identity" "$1" \
    || fail "could not sign '$1' with '$IDENTITY'"
  codesign --verify --strict "$1" || fail "signature verification failed for '$1'"
}

sign_binary "$bin"
# Tauri starts the terminal host directly, bypassing Cargo's runner. Its stable
# signature must be restored after a rebuild before either process uses the
# shared login Keychain credential. A companion is optional for app-only builds.
if [ "$binary_name" = "cognia-next" ]; then
  workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" \
    || fail "could not locate the development workspace"
  # Match host_client::resolve_server_binary, including a release-mode app
  # using the debug host built by beforeDevCommand. Sign only the chosen host.
  for terminal_host in \
    "$(dirname "$bin")/cognia-server" \
    "$workspace_root/target/debug/cognia-server" \
    "$workspace_root/target/release/cognia-server"; do
    if [ -f "$terminal_host" ]; then
      sign_binary "$terminal_host"
      break
    fi
  done
fi

exec "$@"
