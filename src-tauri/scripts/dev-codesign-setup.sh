#!/usr/bin/env bash
#
# One-time setup for local macOS development.
#
# Why this exists
# ---------------
# `pnpm tauri dev` produces an *ad-hoc* (linker-signed) `cognia-next` binary
# whose code-signing identity is its cdhash, which changes on every rebuild.
# macOS Keychain access-control lists (ACLs) match the requesting app by its
# code-signing "designated requirement", so an ad-hoc binary is treated as a
# brand-new, unrecognized app after every rebuild — and macOS re-prompts for
# the login-keychain password to read the secrets stored under the
# `com.cognia.platforms` service (and every other keyring the app uses).
# Clicking "Always Allow / 始终允许" only pins the *current* cdhash, so the next
# rebuild prompts again.
#
# The fix: sign dev builds with a *stable* self-signed identity. Its designated
# requirement is cert-based, not cdhash-based, so it stays constant across
# rebuilds — "Always Allow" sticks permanently. This script (a) creates that
# identity if missing and (b) grants `codesign` non-interactive access to its
# private key. `dev-codesign.sh` (wired as a cargo `runner`) then applies it on
# every rebuild.
#
# Run in your OWN terminal — it prompts for your login-keychain password:
#   pnpm dev:sign:setup
#   # or: bash src-tauri/scripts/dev-codesign-setup.sh
#
set -euo pipefail

IDENTITY="${COGNIA_DEV_SIGNING_IDENTITY:-Cognia Dev Signing}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This setup is macOS-only (nothing to do on $(uname -s))."
  exit 0
fi
command -v openssl >/dev/null 2>&1 || { echo "error: openssl not found on PATH" >&2; exit 1; }

# --- 1. Create + import the identity (idempotent) ----------------------------
if security find-identity -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "✓ Identity '$IDENTITY' already present — skipping creation."
else
  echo "Creating self-signed code-signing identity '$IDENTITY' (valid 10 years)…"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  # Transient PKCS#12 password: an empty-password p12 produces a MAC that
  # Apple's `security import` rejects, so use a throwaway one (never persisted).
  p12pass="cognia-dev-$$"

  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
    -subj "/CN=$IDENTITY" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

  # macOS `security import` only reads legacy PKCS#12 (SHA1 MAC + 3DES);
  # OpenSSL 3's modern defaults fail with "MAC verification failed".
  openssl pkcs12 -export -legacy -out "$tmp/identity.p12" \
    -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -passout "pass:$p12pass" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 >/dev/null 2>&1

  security import "$tmp/identity.p12" -k "$KEYCHAIN" -P "$p12pass" \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  echo "✓ Imported."
fi

# --- 2. Grant codesign non-interactive access to the private key -------------
# The ACL partition list gates key access independently of the -T flags above,
# so without this `codesign` fails with errSecInternalComponent (or pops its own
# prompt). Needs your login-keychain password (your macOS login password).
echo
printf 'Enter your login-keychain password (your macOS login password): '
read -rs KCPASS
echo
if ! security set-key-partition-list \
      -S apple-tool:,apple:,codesign: -s -k "$KCPASS" "$KEYCHAIN" >/dev/null 2>&1; then
  unset KCPASS
  echo "error: failed to grant key access (wrong password?). Re-run to retry." >&2
  exit 1
fi
unset KCPASS

echo
echo "✓ Done. Code-signing identity is ready and authorized for codesign."
echo
echo "Next steps:"
echo "  1. Run the app as usual:  pnpm tauri dev"
echo "  2. The FIRST time each stored credential is read you'll get ONE Keychain"
echo "     prompt — click \"始终允许 / Always Allow\". Because the binary is now"
echo "     stably signed, that choice persists across ALL future rebuilds."
