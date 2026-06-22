//! Canonical Ed25519 **public** key used to verify `cognia` CLI release
//! artifacts downloaded by the desktop app.
//!
//! # Source of truth
//!
//! This file is the single source of truth for the release-signing public
//! key. Two mirrors are kept in sync from here by `scripts/sync/release-sync-keys.mjs`:
//!   - `src-tauri/src/cli_bridge/release_key.rs` (desktop download verifier)
//!   - `lib/cli-bridge/embedded-pubkey.ts`        (renderer, for display)
//!
//! The matching **private** key never lives in the repo — it stays on the
//! release runner and signs each artifact's `.sig` during the release
//! workflow.
//!
//! # Placeholder state
//!
//! Until the release-signing keypair is generated (`pnpm release:keygen`),
//! the constant below is the all-zero sentinel. Download verification treats
//! the sentinel as "signature checking not yet provisioned" — it still
//! enforces the SHA-256 checksum but logs that the Ed25519 layer is inactive.
//! Replacing the sentinel with a real base64 key activates strict signature
//! verification everywhere with no other code change.

/// Base64-encoded 32-byte Ed25519 public key. All-zero = placeholder.
pub const RELEASE_PUBLIC_KEY_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/// True when the embedded key is still the all-zero placeholder.
pub fn is_placeholder_key() -> bool {
    RELEASE_PUBLIC_KEY_BASE64 == "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_detected() {
        assert!(is_placeholder_key());
    }

    #[test]
    fn key_is_valid_base64_of_32_bytes() {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(RELEASE_PUBLIC_KEY_BASE64)
            .expect("release key must be valid base64");
        assert_eq!(bytes.len(), 32, "Ed25519 public key must be 32 bytes");
    }
}
