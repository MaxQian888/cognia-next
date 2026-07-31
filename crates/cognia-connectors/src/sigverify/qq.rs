//! QQ Official Bot webhook signature scheme.
//!
//! QQ signs each webhook callback with an Ed25519 key DERIVED FROM THE BOT
//! SECRET (unlike Discord, where the console hands out a public key). Per the
//! official docs (bot.q.qq.com wiki, 回调签名校验):
//!
//!   - seed  = bot secret repeated until ≥ 32 bytes, truncated to 32
//!     (e.g. secret `naOC0ocQE3shWLAfffVLB1rhYPG7` → seed
//!     `naOC0ocQE3shWLAfffVLB1rhYPG7naOC`)
//!   - inbound verification: headers `X-Signature-Ed25519` (hex) +
//!     `X-Signature-Timestamp`; message = `timestamp ++ raw body` — verified
//!     against the seed-derived public key.
//!   - URL-validation challenge (op 13): respond with
//!     `hex(sign(event_ts ++ plain_token))` produced by the same seeded key.

use ed25519_dalek::{Signer, SigningKey};

use super::SigError;

/// Derive the 32-byte Ed25519 seed from the bot secret: repeat the secret
/// until it reaches 32 bytes, then truncate (the official docs' Go sample
/// doubles the string, which yields the same 32-byte prefix).
pub fn seed_from_secret(secret: &str) -> Result<[u8; 32], SigError> {
    if secret.is_empty() {
        return Err(SigError::Missing);
    }
    let mut seed = Vec::with_capacity(32 + secret.len());
    while seed.len() < 32 {
        seed.extend_from_slice(secret.as_bytes());
    }
    seed.truncate(32);
    Ok(seed.try_into().expect("seed truncated to exactly 32 bytes"))
}

/// Signing key seeded from the bot secret (used both to derive the public key
/// for inbound verification and to sign the op-13 challenge).
fn signing_key(secret: &str) -> Result<SigningKey, SigError> {
    Ok(SigningKey::from_bytes(&seed_from_secret(secret)?))
}

/// Verify an inbound webhook callback: `X-Signature-Ed25519` over
/// `timestamp ++ body`, against the secret-derived public key. Delegates to
/// the Discord verifier — the message construction is identical.
pub fn verify_ed25519(
    secret: &str,
    timestamp: &str,
    body: &[u8],
    signature_hex: &str,
) -> Result<(), SigError> {
    let public_hex = hex::encode(signing_key(secret)?.verifying_key().as_bytes());
    super::discord::verify_ed25519(timestamp, body, signature_hex, &public_hex)
}

/// Sign the op-13 URL-validation challenge: `hex(sign(event_ts ++ plain_token))`.
pub fn sign_challenge(secret: &str, event_ts: &str, plain_token: &str) -> Result<String, SigError> {
    let key = signing_key(secret)?;
    let mut msg = event_ts.as_bytes().to_vec();
    msg.extend_from_slice(plain_token.as_bytes());
    Ok(hex::encode(key.sign(&msg).to_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier};

    /// The exact seed-expansion vector from the official documentation.
    #[test]
    fn seed_matches_official_docs_vector() {
        let seed = seed_from_secret("naOC0ocQE3shWLAfffVLB1rhYPG7").unwrap();
        assert_eq!(&seed, b"naOC0ocQE3shWLAfffVLB1rhYPG7naOC");
    }

    #[test]
    fn seed_repeats_short_secrets() {
        // 7-byte secret repeats cyclically to fill 32 bytes.
        let seed = seed_from_secret("abcdefg").unwrap();
        assert_eq!(&seed, b"abcdefgabcdefgabcdefgabcdefgabcd");
    }

    #[test]
    fn seed_truncates_long_secrets() {
        let long = "x".repeat(40);
        let seed = seed_from_secret(&long).unwrap();
        assert_eq!(seed, [b'x'; 32]);
    }

    #[test]
    fn empty_secret_is_rejected() {
        assert!(matches!(
            seed_from_secret("").unwrap_err(),
            SigError::Missing
        ));
        assert!(matches!(
            sign_challenge("", "ts", "tok").unwrap_err(),
            SigError::Missing
        ));
    }

    #[test]
    fn sign_and_verify_round_trip() {
        let secret = "DG5g3B4j9X2KOErG";
        let timestamp = "1725442341";
        let body = br#"{"op":0,"t":"C2C_MESSAGE_CREATE","d":{}}"#;

        // Sign like the platform would (same seeded key on both ends).
        let key = signing_key(secret).unwrap();
        let mut msg = timestamp.as_bytes().to_vec();
        msg.extend_from_slice(body);
        let sig_hex = hex::encode(key.sign(&msg).to_bytes());

        assert!(verify_ed25519(secret, timestamp, body, &sig_hex).is_ok());
        // Tampered body must fail.
        assert!(matches!(
            verify_ed25519(secret, timestamp, b"{}", &sig_hex).unwrap_err(),
            SigError::Mismatch
        ));
        // Wrong secret must fail.
        assert!(verify_ed25519("other-secret-value", timestamp, body, &sig_hex).is_err());
    }

    #[test]
    fn challenge_signature_verifies_against_derived_public_key() {
        let secret = "DG5g3B4j9X2KOErG";
        let event_ts = "1725442341";
        let plain_token = "Arq0D5A61EgUu4OxUvOp";

        let sig_hex = sign_challenge(secret, event_ts, plain_token).unwrap();
        let sig_bytes = <[u8; 64]>::try_from(hex::decode(&sig_hex).unwrap().as_slice()).unwrap();
        let signature = Signature::from_bytes(&sig_bytes);

        let vk = signing_key(secret).unwrap().verifying_key();
        let msg = format!("{event_ts}{plain_token}");
        assert!(vk.verify(msg.as_bytes(), &signature).is_ok());
    }
}
