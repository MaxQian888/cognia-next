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
# rebuilds — "Always Allow" sticks permanently. The disposable identity lives
# in a dedicated passwordless keychain, not the login keychain. That keychain
# contains no user secrets and only this development key, so `codesign` can
# unlock it non-interactively without changing access controls for unrelated
# identities. `dev-codesign.sh` (wired as a cargo `runner`) targets it directly
# on every rebuild.
#
# Run once:
#   pnpm dev:sign:setup
#   # or: bash src-tauri/scripts/dev-codesign-setup.sh
#
set -euo pipefail

IDENTITY="${COGNIA_DEV_SIGNING_IDENTITY:-Cognia Dev Signing}"
KEYCHAIN="${COGNIA_DEV_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/cognia-dev-signing.keychain-db}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This setup is macOS-only (nothing to do on $(uname -s))."
  exit 0
fi
command -v openssl >/dev/null 2>&1 || { echo "error: openssl not found on PATH" >&2; exit 1; }

# --- 1. Create the isolated development keychain (idempotent) ----------------
if [ ! -f "$KEYCHAIN" ]; then
  security create-keychain -p "" "$KEYCHAIN"
fi
security unlock-keychain -p "" "$KEYCHAIN"

# `codesign --keychain` still requires the keychain to be in the user search
# list before it can resolve an identity by fingerprint. Preserve every current
# entry and append ours once.
user_keychains=()
keychain_is_listed=false
while IFS= read -r keychain_path; do
  keychain_path="${keychain_path#*\"}"
  keychain_path="${keychain_path%\"*}"
  [ -n "$keychain_path" ] || continue
  user_keychains+=("$keychain_path")
  if [ "$keychain_path" = "$KEYCHAIN" ]; then
    keychain_is_listed=true
  fi
done < <(security list-keychains -d user)
if [ "$keychain_is_listed" = false ]; then
  security list-keychains -d user -s "${user_keychains[@]}" "$KEYCHAIN"
fi

# --- 2. Create + import the identity (idempotent) ----------------------------
if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -qF "$IDENTITY"; then
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

# --- 3. Grant codesign non-interactive access to the private key -------------
# The ACL partition list gates key access independently of the -T flags above,
# so without this `codesign` fails with errSecInternalComponent (or opens a
# password prompt). The dedicated keychain intentionally has an empty password:
# it contains only this disposable development identity, never user secrets.
if ! security set-key-partition-list \
      -S apple-tool:,apple:,codesign: -s -k "" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "error: failed to grant codesign access to '$KEYCHAIN'." >&2
  exit 1
fi

echo
echo "✓ Done. Code-signing identity is ready and authorized for codesign."
echo
echo "Next steps:"
echo "  1. Run the app as usual:  pnpm tauri dev"
echo "  2. The FIRST time each stored credential is read you'll get ONE Keychain"
echo "     prompt — click \"始终允许 / Always Allow\". Because the binary is now"
echo "     stably signed, that choice persists across ALL future rebuilds."
