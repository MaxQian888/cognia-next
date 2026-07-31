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
# It is a transparent pass-through (no signing) for:
#   * any binary other than `cognia-next` (e.g. test binaries, cognia-server),
#   * machines without the signing identity (CI, other contributors),
# so committing the cargo runner is safe everywhere.
#
set -euo pipefail

IDENTITY="${COGNIA_DEV_SIGNING_IDENTITY:-Cognia Dev Signing}"
DEV_KEYCHAIN="${COGNIA_DEV_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/cognia-dev-signing.keychain-db}"
bin="${1:?dev-codesign: missing binary path}"

# NOTE: gate on `find-identity -p codesigning` WITHOUT `-v`. A self-signed dev
# cert is untrusted, so the `-v` (valid-only) listing hides it even though
# `codesign` can sign with it fine once key access is granted. The `-v` form
# would make this shim silently never fire.
if [ "$(basename "$bin")" = "cognia-next" ] \
  && command -v codesign >/dev/null 2>&1 \
  && command -v security >/dev/null 2>&1; then
  codesign_keychain=()
  signing_identity="$IDENTITY"
  if [ -f "$DEV_KEYCHAIN" ] \
    && security unlock-keychain -p "" "$DEV_KEYCHAIN" >/dev/null 2>&1; then
    dedicated_identity="$(
      security find-identity -p codesigning "$DEV_KEYCHAIN" 2>/dev/null \
        | awk -v identity="$IDENTITY" 'index($0, "\"" identity "\"") { print $2; exit }'
    )"
  else
    dedicated_identity=""
  fi
  if [ -n "$dedicated_identity" ]; then
    signing_identity="$dedicated_identity"
    codesign_keychain=(--keychain "$DEV_KEYCHAIN")
  elif ! security find-identity -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
    exec "$@"
  fi

  if ! codesign --force "${codesign_keychain[@]}" --sign "$signing_identity" "$bin" >/dev/null 2>&1; then
    echo "dev-codesign: could not sign $bin; refusing to run unsigned" >&2
    exit 1
  fi
fi

exec "$@"
