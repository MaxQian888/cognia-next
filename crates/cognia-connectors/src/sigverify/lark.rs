use aes::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use super::SigError;

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// Verify a Lark webhook verification token.
///
/// Lark sends a `token` field in every event header (schema 2.0). The
/// caller compares it against the value configured in the Lark App dashboard.
///
/// # Arguments
/// - `provided`:  the `token` field from the event header (may be None if absent)
/// - `expected`:  the verification token configured in the Lark App
///
/// # Returns
/// `Ok(())` if the tokens match; `SigError::Missing` if `provided` is None or empty;
/// `SigError::Mismatch` otherwise.
pub fn verify_token(provided: Option<&str>, expected: &str) -> Result<(), SigError> {
    match provided {
        None => Err(SigError::Missing),
        Some(token) if token.is_empty() => Err(SigError::Missing),
        Some(token) => {
            // Constant-time compare — the verification token is a long-lived,
            // high-value shared secret (it is the only gate on plaintext-mode
            // Lark events), so avoid a timing side-channel. Length is compared
            // first (lengths are not secret) so `ct_eq` runs on equal slices.
            let provided = token.as_bytes();
            let expected = expected.as_bytes();
            if provided.len() == expected.len() && bool::from(provided.ct_eq(expected)) {
                Ok(())
            } else {
                Err(SigError::Mismatch)
            }
        }
    }
}

/// Maximum age (in milliseconds) of a Lark event we will accept. Lark event
/// headers carry a `create_time` field (Unix epoch, milliseconds). Rejecting
/// events outside this window — together with `event_id` de-duplication —
/// bounds the replay horizon for a captured webhook POST. Five minutes mirrors
/// the Slack/WeChat replay windows used elsewhere in this module.
pub const LARK_REPLAY_WINDOW_MS: i64 = 5 * 60 * 1000;

/// Check that a Lark event's `create_time` (epoch milliseconds, as the string
/// Lark sends) is fresh relative to `now_ms`. Returns `SigError::Stale` when the
/// timestamp is unparseable or outside `±LARK_REPLAY_WINDOW_MS`.
///
/// This is the freshness half of replay protection; the caller pairs it with an
/// `event_id` dedup cache so a captured POST cannot be replayed indefinitely.
pub fn check_create_time(create_time: Option<&str>, now_ms: i64) -> Result<(), SigError> {
    let raw = create_time.ok_or(SigError::Stale)?;
    let ts: i64 = raw.trim().parse().map_err(|_| SigError::Stale)?;
    if (now_ms - ts).abs() > LARK_REPLAY_WINDOW_MS {
        return Err(SigError::Stale);
    }
    Ok(())
}

/// Decrypt a Lark encrypted event body.
///
/// Lark encrypts events with AES-256-CBC:
/// - Key: SHA-256 of the Encrypt Key string (32 bytes)
/// - Ciphertext: base64-decode the `encrypt` field from the JSON body
/// - IV: first 16 bytes of the decoded ciphertext
/// - Actual cipher input: remaining bytes after the IV
/// - Padding: PKCS#7
///
/// # Arguments
/// - `encrypted_b64`: the base64-encoded string from Lark's `encrypt` field
/// - `encrypt_key`:   the Encrypt Key configured in the Lark App dashboard
///
/// # Returns
/// The decrypted plaintext bytes on success, or a `SigError` on failure.
pub fn decrypt_body(encrypted_b64: &str, encrypt_key: &str) -> Result<Vec<u8>, SigError> {
    // Derive 32-byte AES key from the encrypt_key string via SHA-256
    let digest = Sha256::digest(encrypt_key.as_bytes());
    let key_arr: [u8; 32] = digest
        .as_slice()
        .try_into()
        .map_err(|_| SigError::Mismatch)?;

    // Base64-decode the ciphertext
    let raw = BASE64
        .decode(encrypted_b64)
        .map_err(|_| SigError::Mismatch)?;

    if raw.len() < 16 {
        return Err(SigError::Mismatch);
    }

    // IV = first 16 bytes; ciphertext = remainder
    let (iv, ciphertext) = raw.split_at(16);

    let iv_arr: [u8; 16] = iv.try_into().map_err(|_| SigError::Mismatch)?;

    // Decrypt with PKCS#7 unpadding (cbc 0.2 / cipher 0.5 API)
    let decryptor = Aes256CbcDec::new(&key_arr.into(), &iv_arr.into());
    let plaintext = decryptor
        .decrypt_padded_vec::<Pkcs7>(ciphertext)
        .map_err(|_| SigError::Mismatch)?;

    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::{BlockModeEncrypt, KeyIvInit};
    use rand::RngCore;

    type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

    fn encrypt_body(plaintext: &[u8], encrypt_key: &str) -> String {
        let digest = Sha256::digest(encrypt_key.as_bytes());
        let key_arr: [u8; 32] = digest.as_slice().try_into().unwrap();

        // Random IV
        let mut iv = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut iv);

        let ciphertext =
            Aes256CbcEnc::new(&key_arr.into(), &iv.into()).encrypt_padded_vec::<Pkcs7>(plaintext);

        // Prepend IV to ciphertext, then base64-encode
        let mut combined = iv.to_vec();
        combined.extend_from_slice(&ciphertext);
        BASE64.encode(combined)
    }

    // -------------------------------------------------------------------------
    // verify_token
    // -------------------------------------------------------------------------

    #[test]
    fn known_good_token_returns_ok() {
        let expected = "my-verification-token";
        assert!(verify_token(Some(expected), expected).is_ok());
    }

    #[test]
    fn mismatched_token_returns_mismatch() {
        let err = verify_token(Some("wrong-token"), "correct-token").unwrap_err();
        assert!(matches!(err, SigError::Mismatch));
    }

    #[test]
    fn missing_token_none_returns_missing() {
        let err = verify_token(None, "expected").unwrap_err();
        assert!(matches!(err, SigError::Missing));
    }

    #[test]
    fn empty_token_returns_missing() {
        let err = verify_token(Some(""), "expected").unwrap_err();
        assert!(matches!(err, SigError::Missing));
    }

    #[test]
    fn token_length_mismatch_returns_mismatch() {
        // Differing lengths must not panic and must reject (constant-time path
        // compares length first).
        let err = verify_token(Some("short"), "a-much-longer-token").unwrap_err();
        assert!(matches!(err, SigError::Mismatch));
    }

    // -------------------------------------------------------------------------
    // check_create_time — replay freshness window
    // -------------------------------------------------------------------------

    #[test]
    fn create_time_within_window_is_ok() {
        let now = 1_700_000_000_000_i64;
        assert!(check_create_time(Some(&now.to_string()), now).is_ok());
        assert!(check_create_time(Some(&now.to_string()), now + LARK_REPLAY_WINDOW_MS).is_ok());
        assert!(check_create_time(Some(&now.to_string()), now - LARK_REPLAY_WINDOW_MS).is_ok());
    }

    #[test]
    fn create_time_outside_window_is_stale() {
        let ts = 1_700_000_000_000_i64;
        let now = ts + LARK_REPLAY_WINDOW_MS + 1;
        assert!(matches!(
            check_create_time(Some(&ts.to_string()), now).unwrap_err(),
            SigError::Stale
        ));
    }

    #[test]
    fn create_time_missing_or_unparseable_is_stale() {
        assert!(matches!(
            check_create_time(None, 1_700_000_000_000).unwrap_err(),
            SigError::Stale
        ));
        assert!(matches!(
            check_create_time(Some("not-a-number"), 1_700_000_000_000).unwrap_err(),
            SigError::Stale
        ));
    }

    // -------------------------------------------------------------------------
    // decrypt_body — round-trip
    // -------------------------------------------------------------------------

    #[test]
    fn decrypt_round_trip_with_known_plaintext() {
        let key = "my-secret-encrypt-key";
        let plaintext =
            b"{\"schema\":\"2.0\",\"header\":{\"event_type\":\"im.message.receive_v1\"}}";

        let encrypted = encrypt_body(plaintext, key);
        let decrypted = decrypt_body(&encrypted, key).expect("decrypt should succeed");
        assert_eq!(decrypted, plaintext.as_slice());
    }

    #[test]
    fn decrypt_invalid_base64_returns_mismatch() {
        let err = decrypt_body("not-valid-base64!!!", "key").unwrap_err();
        assert!(matches!(err, SigError::Mismatch));
    }

    #[test]
    fn decrypt_too_short_payload_returns_mismatch() {
        // Base64 of fewer than 16 bytes
        let short = BASE64.encode(b"short");
        let err = decrypt_body(&short, "key").unwrap_err();
        assert!(matches!(err, SigError::Mismatch));
    }

    #[test]
    fn decrypt_wrong_key_returns_mismatch() {
        let plaintext = b"test plaintext body";
        let encrypted = encrypt_body(plaintext, "correct-key");
        // Decrypting with a wrong key should fail (bad padding)
        let err = decrypt_body(&encrypted, "wrong-key").unwrap_err();
        assert!(matches!(err, SigError::Mismatch));
    }
}
