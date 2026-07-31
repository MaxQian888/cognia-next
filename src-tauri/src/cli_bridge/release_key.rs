//! Desktop mirror of the release public-key literal from
//! `crates/cognia-cli/src/release_key.rs`, kept in sync by
//! `scripts/sync/release-sync-keys.mjs`. The verifier helpers below are
//! desktop-local and enforce the key shape before Ed25519 verification.
//!
//! The desktop download verifier (`download.rs`) uses this to check the
//! Ed25519 signature on a downloaded `cognia` CLI artifact. While the key
//! is the all-zero placeholder, signature verification is skipped (SHA-256
//! still enforced) and a warning is logged.

/// Base64-encoded 32-byte Ed25519 public key. All-zero = placeholder.
pub const RELEASE_PUBLIC_KEY_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const PLACEHOLDER_RELEASE_PUBLIC_KEY_BASE64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/// True when the embedded key is still the all-zero placeholder.
pub fn is_placeholder_key() -> bool {
    RELEASE_PUBLIC_KEY_BASE64 == PLACEHOLDER_RELEASE_PUBLIC_KEY_BASE64
}

/// Decode the embedded key as the exact 32-byte Ed25519 public-key material.
pub fn release_public_key_bytes() -> anyhow::Result<[u8; 32]> {
    decode_release_public_key_base64(RELEASE_PUBLIC_KEY_BASE64)
}

fn decode_release_public_key_base64(value: &str) -> anyhow::Result<[u8; 32]> {
    use anyhow::{anyhow, Context};
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.as_bytes())
        .context("decode embedded release key")?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("release key must be 32 bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn placeholder_key_decodes_to_exactly_zeroed_ed25519_key() {
        assert_eq!(release_public_key_bytes().unwrap(), [0u8; 32]);
    }

    #[test]
    fn decoder_rejects_non_32_byte_public_keys() {
        let short_key = base64::engine::general_purpose::STANDARD.encode([1u8; 31]);

        let err = decode_release_public_key_base64(&short_key).unwrap_err();

        assert_eq!(err.to_string(), "release key must be 32 bytes");
    }

    #[test]
    fn decoder_rejects_invalid_base64() {
        let err = decode_release_public_key_base64("not base64").unwrap_err();

        assert_eq!(err.to_string(), "decode embedded release key");
    }
}
