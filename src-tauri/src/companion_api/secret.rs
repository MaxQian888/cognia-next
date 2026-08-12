//! HS256 signing-secret persistence for the companion API.
//!
//! Service name `com.cognia.companion/v1`, account `signing-key`.
//!
//! On first boot the 32-byte secret is generated via `rand`, base64-encoded,
//! and stored in the OS keyring.  Subsequent boots load the stored value so
//! the same secret signs all JWTs across restarts — a rotation would invalidate
//! every paired device's long-lived token.
//!
//! # Testing
//!
//! The OS keyring is unavailable in most CI environments.  Tests that perform
//! real keyring I/O are gated behind `COGNIA_TEST_KEYRING=1`, following the
//! same convention as `anthropic_subscription/credential.rs`.  Pure serialisation
//! and generation tests run unconditionally.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

const SERVICE: &str = "com.cognia.companion/v1";
const ACCOUNT: &str = "signing-key";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Load the HS256 signing secret from the keyring, generating one on first
/// call.
///
/// Returns the raw 32-byte secret (not base64).
///
/// # Errors
///
/// Propagates keyring errors as human-readable strings.
pub fn load_or_generate() -> Result<Vec<u8>, String> {
    match crate::secret_store::get(SERVICE, ACCOUNT)? {
        Some(encoded) => decode_secret(&encoded),
        None => {
            let secret = generate_secret();
            let encoded = B64.encode(&secret);
            crate::secret_store::set(SERVICE, ACCOUNT, &encoded)?;
            Ok(secret)
        }
    }
}

/// Replace the signing secret with `new_secret`.  Exposed for key rotation;
/// not called in M2.3.
#[allow(dead_code)]
pub fn store(new_secret: &[u8]) -> Result<(), String> {
    let encoded = B64.encode(new_secret);
    crate::secret_store::set(SERVICE, ACCOUNT, &encoded)
}

/// Remove the stored secret.  Next `load_or_generate` call will produce a new
/// one, invalidating outstanding loopback service principals. Public device
/// access tokens use the process-ephemeral DPoP authority instead.
#[allow(dead_code)]
pub fn clear() -> Result<(), String> {
    crate::secret_store::delete(SERVICE, ACCOUNT)
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn generate_secret() -> Vec<u8> {
    let mut buf = vec![0u8; 32];
    rand::fill(&mut buf);
    buf
}

fn decode_secret(encoded: &str) -> Result<Vec<u8>, String> {
    B64.decode(encoded)
        .map_err(|e| format!("secret base64 decode failed: {e}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    #[test]
    fn generate_produces_32_bytes() {
        let secret = generate_secret();
        assert_eq!(secret.len(), 32);
    }

    #[test]
    fn generate_produces_different_values() {
        // Low probability of collision — acceptable for a randomness smoke test.
        let a = generate_secret();
        let b = generate_secret();
        assert_ne!(a, b);
    }

    #[test]
    fn base64_round_trip() {
        let original = generate_secret();
        let encoded = B64.encode(&original);
        let decoded = decode_secret(&encoded).expect("decode");
        assert_eq!(original, decoded);
    }

    #[test]
    fn decode_invalid_base64_returns_error() {
        assert!(decode_secret("not!base64%%").is_err());
    }

    #[test]
    fn load_or_generate_round_trip_via_keyring() {
        if !keyring_available() {
            return;
        }
        // Clean state: remove any leftover entry.
        let _ = clear();

        let first = load_or_generate().expect("first load_or_generate");
        assert_eq!(first.len(), 32);

        let second = load_or_generate().expect("second load_or_generate");
        assert_eq!(first, second, "same secret must be returned on second call");

        // Cleanup.
        clear().expect("clear");
        let third = load_or_generate().expect("third load_or_generate after clear");
        assert_ne!(first, third, "cleared secret must differ");

        let _ = clear();
    }

    #[test]
    fn store_then_load_returns_stored() {
        if !keyring_available() {
            return;
        }
        let _ = clear();
        let custom = vec![0xABu8; 32];
        store(&custom).expect("store");
        let loaded = load_or_generate().expect("load");
        assert_eq!(loaded, custom);
        let _ = clear();
    }
}
