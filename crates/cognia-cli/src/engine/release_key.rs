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

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use sha2::{Digest, Sha256};

const PLACEHOLDER_RELEASE_PUBLIC_KEY_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/// Base64-encoded 32-byte Ed25519 public key. All-zero = placeholder.
pub const RELEASE_PUBLIC_KEY_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/// True when the embedded key is still the all-zero placeholder.
pub fn is_placeholder_key() -> bool {
    RELEASE_PUBLIC_KEY_BASE64 == PLACEHOLDER_RELEASE_PUBLIC_KEY_BASE64
}

/// Decode the canonical release public key as exact Ed25519 key material.
pub fn release_public_key_bytes() -> Result<[u8; 32]> {
    decode_release_public_key_base64(RELEASE_PUBLIC_KEY_BASE64)
}

pub(crate) fn decode_release_public_key_base64(value: &str) -> Result<[u8; 32]> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.as_bytes())
        .context("decode embedded release key")?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("release key must be 32 bytes"))
}

/// SHA-256 fingerprint of the embedded release public key bytes.
pub fn release_key_fingerprint_hex() -> Result<String> {
    let bytes = release_public_key_bytes()?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(hex::encode(hasher.finalize()))
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

    #[test]
    fn release_public_key_bytes_decodes_the_canonical_key() {
        assert_eq!(release_public_key_bytes().unwrap(), [0u8; 32]);
    }

    #[test]
    fn decode_release_public_key_base64_rejects_non_32_byte_keys() {
        use base64::Engine as _;
        let short = base64::engine::general_purpose::STANDARD.encode([1u8; 31]);

        let err = decode_release_public_key_base64(&short).unwrap_err();

        assert_eq!(err.to_string(), "release key must be 32 bytes");
    }

    #[test]
    fn release_key_fingerprint_is_sha256_of_public_key_bytes() {
        assert_eq!(
            release_key_fingerprint_hex().unwrap(),
            "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
        );
    }
}
