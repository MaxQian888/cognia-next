use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use super::SigError;

type HmacSha256 = Hmac<Sha256>;

/// Verify a Slack webhook request signature.
///
/// Slack signs each request using HMAC-SHA256 over a v0 basestring:
///   `v0:<timestamp>:<body>`
///
/// The resulting hex digest is delivered in the `X-Slack-Signature` header
/// as `v0=<hex>`. Replay protection rejects requests where
/// `|now_unix_secs - timestamp_secs| > 300` (5 minutes).
///
/// # Arguments
/// - `timestamp`: value of `X-Slack-Request-Timestamp` (Unix seconds as a string)
/// - `body`: raw request body bytes
/// - `signature_header`: value of `X-Slack-Signature` (e.g. `"v0=abc123..."`)
/// - `signing_secret`: the app's signing secret from the Slack developer console
/// - `now_unix_secs`: current Unix timestamp (seconds) for replay-protection check
///
/// # Returns
/// `Ok(())` on a valid, fresh signature; otherwise the appropriate `SigError`.
pub fn verify_v0(
    timestamp: &str,
    body: &[u8],
    signature_header: &str,
    signing_secret: &str,
    now_unix_secs: i64,
) -> Result<(), SigError> {
    if signature_header.is_empty() {
        return Err(SigError::Missing);
    }

    // Parse timestamp for replay protection
    let ts: i64 = timestamp.parse().map_err(|_| SigError::Stale)?;
    if (now_unix_secs - ts).abs() > 300 {
        return Err(SigError::Stale);
    }

    // Compute expected signature over the v0 basestring `v0:<ts>:<body>`.
    // Feed the raw body bytes directly — Slack signs the raw request bytes, so
    // round-tripping through `String::from_utf8_lossy` (which substitutes
    // U+FFFD for invalid UTF-8) would diverge from Slack's basestring and make
    // verification spuriously fail for any non-UTF-8 body.
    let mut mac = HmacSha256::new_from_slice(signing_secret.as_bytes())
        .expect("HMAC can take key of any size");
    mac.update(b"v0:");
    mac.update(timestamp.as_bytes());
    mac.update(b":");
    mac.update(body);
    let result = mac.finalize().into_bytes();
    let expected_hex = format!("v0={}", hex::encode(result));

    // Constant-time comparison
    if !bool::from(
        expected_hex
            .as_bytes()
            .ct_eq(signature_header.as_bytes()),
    ) {
        return Err(SigError::Mismatch);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a known-good v0 signature for the given inputs.
    fn make_signature(timestamp: &str, body: &[u8], signing_secret: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(signing_secret.as_bytes()).unwrap();
        mac.update(b"v0:");
        mac.update(timestamp.as_bytes());
        mac.update(b":");
        mac.update(body);
        let result = mac.finalize().into_bytes();
        format!("v0={}", hex::encode(result))
    }

    #[test]
    fn known_good_vector_returns_ok() {
        let timestamp = "1531420618";
        let body = b"token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&...";
        let secret = "8f742231b10e8888abcd99yyyzzz85a5";
        let now = 1531420618_i64; // same second as timestamp → |diff| = 0

        let sig = make_signature(timestamp, body, secret);
        assert!(verify_v0(timestamp, body, &sig, secret, now).is_ok());
    }

    #[test]
    fn bad_signature_returns_mismatch() {
        let timestamp = "1531420618";
        let body = b"some body content";
        let secret = "my-signing-secret";
        let now = 1531420618_i64;

        let bad_sig = "v0=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let err = verify_v0(timestamp, body, bad_sig, secret, now).unwrap_err();
        assert!(matches!(err, SigError::Mismatch));
    }

    #[test]
    fn missing_signature_returns_missing() {
        let err = verify_v0("1531420618", b"body", "", "secret", 1531420618).unwrap_err();
        assert!(matches!(err, SigError::Missing));
    }

    #[test]
    fn old_timestamp_returns_stale() {
        let timestamp = "1531420618";
        let body = b"body";
        let secret = "secret";
        // now is 10 minutes later → stale
        let now = 1531420618_i64 + 600;

        let sig = make_signature(timestamp, body, secret);
        let err = verify_v0(timestamp, body, &sig, secret, now).unwrap_err();
        assert!(matches!(err, SigError::Stale));
    }

    #[test]
    fn future_timestamp_beyond_window_returns_stale() {
        let timestamp = "1531421218"; // 10 min in the future
        let body = b"body";
        let secret = "secret";
        let now = 1531420618_i64;

        let sig = make_signature(timestamp, body, secret);
        let err = verify_v0(timestamp, body, &sig, secret, now).unwrap_err();
        assert!(matches!(err, SigError::Stale));
    }

    #[test]
    fn timestamp_within_window_succeeds() {
        let timestamp = "1531420800"; // 182 s after now
        let body = b"body";
        let secret = "my-secret";
        let now = 1531420618_i64;

        let sig = make_signature(timestamp, body, secret);
        assert!(verify_v0(timestamp, body, &sig, secret, now).is_ok());
    }

    #[test]
    fn invalid_timestamp_format_returns_stale() {
        let err = verify_v0("not-a-number", b"body", "v0=aaaa", "secret", 1000).unwrap_err();
        assert!(matches!(err, SigError::Stale));
    }

    #[test]
    fn non_utf8_body_verifies_against_raw_bytes() {
        // A body with invalid UTF-8 (0xFF) must still verify when the signature
        // is computed over the raw bytes — the previous lossy-string basestring
        // would substitute U+FFFD and spuriously mismatch.
        let timestamp = "1531420618";
        let body: &[u8] = &[0x7b, 0xff, 0xfe, 0x7d]; // {<0xff><0xfe>}
        let secret = "raw-bytes-secret";
        let now = 1531420618_i64;

        let sig = make_signature(timestamp, body, secret);
        assert!(verify_v0(timestamp, body, &sig, secret, now).is_ok());
    }
}
