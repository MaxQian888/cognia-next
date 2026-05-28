/**
 * MIRROR of `crates/cognia-cli/src/release_key.rs` — kept in sync by
 * `scripts/release-sync-keys.mjs`. Do not edit by hand; edit the source
 * of truth in the cognia-cli crate and re-run the sync script.
 *
 * The renderer uses this only for display (e.g. showing the signer
 * fingerprint in the install dialog). Actual signature verification of
 * downloaded artifacts happens on the Rust side in
 * `src-tauri/src/cli_bridge/download.rs`.
 */

/** Base64-encoded 32-byte Ed25519 release-signing public key. All-zero = placeholder. */
export const EMBEDDED_COGNIA_RELEASE_PUBKEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

/** True when the embedded key is still the all-zero placeholder. */
export function isPlaceholderReleaseKey(): boolean {
  return EMBEDDED_COGNIA_RELEASE_PUBKEY === "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
}
