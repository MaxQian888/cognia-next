use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hex::FromHex;

use super::SigError;

/// Verify a Discord Interactions endpoint request signature.
///
/// Discord signs each request with an Ed25519 private key. The message is
/// `<timestamp_bytes> + <body_bytes>`. The signature and public key are
/// delivered as lower-case hex strings.
///
/// Returns `Ok(())` on a valid signature, or the appropriate `SigError`
/// variant on failure.
pub fn verify_ed25519(
    timestamp: &str,
    body: &[u8],
    signature_hex: &str,
    public_key_hex: &str,
) -> Result<(), SigError> {
    if signature_hex.is_empty() || public_key_hex.is_empty() {
        return Err(SigError::Missing);
    }

    // Decode hex → bytes
    let sig_bytes = <[u8; 64]>::from_hex(signature_hex).map_err(|_| SigError::Mismatch)?;
    let key_bytes = <[u8; 32]>::from_hex(public_key_hex).map_err(|_| SigError::Mismatch)?;

    let signature = Signature::from_bytes(&sig_bytes);
    let verifying_key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| SigError::Mismatch)?;

    // Message = timestamp bytes ++ body bytes
    let mut message = timestamp.as_bytes().to_vec();
    message.extend_from_slice(body);

    verifying_key
        .verify(&message, &signature)
        .map_err(|_| SigError::Mismatch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// Generate a keypair and sign a message; return (public_key_hex, signature_hex, message).
    fn make_test_vector(timestamp: &str, body: &[u8]) -> (String, String) {
        // Use a fixed seed for reproducibility
        let seed = [0x42u8; 32];
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();

        let mut message = timestamp.as_bytes().to_vec();
        message.extend_from_slice(body);
        let signature = signing_key.sign(&message);

        (
            hex::encode(verifying_key.as_bytes()),
            hex::encode(signature.to_bytes()),
        )
    }

    #[test]
    fn known_good_vector_returns_ok() {
        let timestamp = "1714900000";
        let body = b"{\"type\":1}";
        let (public_key_hex, signature_hex) = make_test_vector(timestamp, body);

        assert!(verify_ed25519(timestamp, body, &signature_hex, &public_key_hex).is_ok());
    }

    #[test]
    fn bad_signature_returns_mismatch() {
        let timestamp = "1714900000";
        let body = b"{\"type\":1}";
        let (public_key_hex, _) = make_test_vector(timestamp, body);

        // Use a different all-zero signature (64 bytes)
        let bad_sig_hex = "0".repeat(128);

        let err = verify_ed25519(timestamp, body, &bad_sig_hex, &public_key_hex).unwrap_err();
        assert!(matches!(err, SigError::Mismatch));
    }

    #[test]
    fn missing_signature_returns_missing() {
        let err = verify_ed25519("ts", b"body", "", "pubkey").unwrap_err();
        assert!(matches!(err, SigError::Missing));
    }
}
