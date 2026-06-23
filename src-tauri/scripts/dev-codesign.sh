#!/usr/bin/env bash
#
# cargo `runner` shim for local macOS development — see ../../.cargo/config.toml.
#
# Cargo invokes this as:  dev-codesign.sh <path-to-binary> [args…]
# We re-sign the freshly-built `cognia-next` binary with the stable self-signed
# identity created by `dev-codesign-setup.sh`, then exec it. This keeps the
# binary's code-signing designated requirement constant across rebuilds so the
# login keychain (service com.cognia.platforms) stops re-prompting.
#
# It is a transparent pass-through (no signing) for:
#   * any binary other than `cognia-next` (e.g. test binaries, cognia-server),
#   * machines without the signing identity (CI, other contributors),
# so committing the cargo runner is safe everywhere.
#
set -euo pipefail

IDENTITY="${COGNIA_DEV_SIGNING_IDENTITY:-Cognia Dev Signing}"
bin="${1:?dev-codesign: missing binary path}"

# NOTE: gate on `find-identity -p codesigning` WITHOUT `-v`. A self-signed dev
# cert is untrusted, so the `-v` (valid-only) listing hides it even though
# `codesign` can sign with it fine once key access is granted. The `-v` form
# would make this shim silently never fire.
if [ "$(basename "$bin")" = "cognia-next" ] \
  && command -v codesign >/dev/null 2>&1 \
  && command -v security >/dev/null 2>&1 \
  && security find-identity -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  if ! codesign --force --sign "$IDENTITY" "$bin" >/dev/null 2>&1; then
    echo "dev-codesign: WARN could not sign $bin (running unsigned)" >&2
  fi
fi

exec "$@"
