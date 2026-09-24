#!/usr/bin/env bash
#
# Stable-signing helper for local macOS development.
#
# Cargo's target runner invokes this as
# `dev-codesign.sh <path-to-binary> [args…]`. It re-signs the freshly-built
# `cognia-next` binary with the stable self-signed identity from
# `dev-codesign-setup.sh`, keeping its designated requirement constant across
# rebuilds so the login keychain stops re-prompting.
#
# Non-macOS hosts and binaries other than `cognia-next` pass through.
# macOS app launches require the dedicated stable identity: a broken signing
# setup must never silently launch the linker's ad-hoc signature.
set -euo pipefail

IDENTITY="${COGNIA_DEV_SIGNING_IDENTITY:-Cognia Dev Signing}"
DEV_KEYCHAIN="${COGNIA_DEV_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/cognia-dev-signing.keychain-db}"
bin="${1:?dev-codesign: missing binary path}"

if [ "$(basename "$bin")" != "cognia-next" ] || [ "$(uname -s)" != "Darwin" ]; then
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

codesign --force --keychain "$DEV_KEYCHAIN" --sign "$signing_identity" "$bin" \
  || fail "could not sign binary with '$IDENTITY'"
codesign --verify --strict "$bin" || fail "signature verification failed"

exec "$@"
