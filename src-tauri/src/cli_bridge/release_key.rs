//! MIRROR of `crates/cognia-cli/src/release_key.rs` — kept in sync by
//! `scripts/release-sync-keys.mjs`. Do not edit by hand; edit the source
//! of truth in the cognia-cli crate and re-run the sync script.
//!
//! The desktop download verifier (`download.rs`) uses this to check the
//! Ed25519 signature on a downloaded `cognia` CLI artifact. While the key
//! is the all-zero placeholder, signature verification is skipped (SHA-256
//! still enforced) and a warning is logged.

/// Base64-encoded 32-byte Ed25519 public key. All-zero = placeholder.
pub const RELEASE_PUBLIC_KEY_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/// True when the embedded key is still the all-zero placeholder.
pub fn is_placeholder_key() -> bool {
    RELEASE_PUBLIC_KEY_BASE64 == "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
}
