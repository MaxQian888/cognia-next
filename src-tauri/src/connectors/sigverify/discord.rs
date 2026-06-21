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

/// Maximum age (seconds) of a Discord interaction we accept. The Ed25519
/// signature covers `timestamp ++ body`, so a captured signed request stays
/// cryptographically valid forever; rejecting stale timestamps is Discord's
/// recommended replay defense. 5 minutes mirrors the Slack window.
pub const DISCORD_REPLAY_WINDOW_SECS: i64 = 300;

/// Verify the `X-Signature-Timestamp` (Unix seconds) is fresh relative to
/// `now_secs`. Returns `SigError::Stale` when unparseable or outside the
/// `±DISCORD_REPLAY_WINDOW_SECS` window. Discord always sends this header, so —
/// unlike the lenient Lark path — it can be enforced strictly.
pub fn check_timestamp(timestamp: &str, now_secs: i64) -> Result<(), SigError> {
    let ts: i64 = timestamp.trim().parse().map_err(|_| SigError::Stale)?;
    if (now_secs - ts).abs() > DISCORD_REPLAY_WINDOW_SECS {
        return Err(SigError::Stale);
    }
    Ok(())
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

    #[test]
    fn check_timestamp_accepts_fresh() {
        assert!(check_timestamp("1714900000", 1714900000).is_ok());
        assert!(check_timestamp("1714900000", 1714900000 + 299).is_ok());
        assert!(check_timestamp("1714900000", 1714900000 - 299).is_ok());
    }

    #[test]
    fn check_timestamp_rejects_stale_and_future() {
        assert!(matches!(
            check_timestamp("1714900000", 1714900000 + 600).unwrap_err(),
            SigError::Stale
        ));
        assert!(matches!(
            check_timestamp("1714900000", 1714900000 - 600).unwrap_err(),
            SigError::Stale
        ));
    }

    #[test]
    fn check_timestamp_rejects_unparseable() {
        assert!(matches!(
            check_timestamp("not-a-number", 1714900000).unwrap_err(),
            SigError::Stale
        ));
    }
}
