//! Read tickets for a share's file blobs — ADR-0222 §3.
//!
//! Downloading a blob chunk is not a view: a share with ten files would
//! otherwise spend ten of its views, and a burn-after-read share would be gone
//! before its first file arrived. So the envelope read — the one counted view
//! — hands back a ticket, and chunk downloads present it instead.
//!
//! A ticket is `<expiresAtMs>.<base64url(HMAC-SHA256(key, message))>` where
//! the message binds the share code and the expiry under a domain tag. It is
//! stateless on purpose: the server keeps no per-reader session, and the
//! ticket says nothing a reader could not already see (the code is in the
//! URL, the expiry in the response). The Worker implements the same format;
//! `ticket-vector.json` pins the two together.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// A ticket key shorter than this is a configuration mistake.
pub const MINIMUM_TICKET_KEY_BYTES: usize = 32;

const DOMAIN: &str = "cognia-share-read-ticket-v1";

/// Why a ticket key was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WeakTicketKey;

impl std::fmt::Display for WeakTicketKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "ticket key must contain at least {MINIMUM_TICKET_KEY_BYTES} bytes"
        )
    }
}

/// Mints and checks read tickets with one server-held key.
#[derive(Clone)]
pub struct ReadTicketSigner {
    key: Vec<u8>,
}

impl std::fmt::Debug for ReadTicketSigner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ReadTicketSigner(..)")
    }
}

fn message(code: &str, expires_at_ms: i64) -> String {
    format!("{DOMAIN}\n{code}\n{expires_at_ms}")
}

impl ReadTicketSigner {
    pub fn new(key: &[u8]) -> Result<Self, WeakTicketKey> {
        if key.len() < MINIMUM_TICKET_KEY_BYTES {
            return Err(WeakTicketKey);
        }
        Ok(Self { key: key.to_vec() })
    }

    fn mac(&self) -> HmacSha256 {
        HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key length")
    }

    /// The ticket for `code`, valid until `expires_at_ms`.
    pub fn mint(&self, code: &str, expires_at_ms: i64) -> String {
        let mut mac = self.mac();
        mac.update(message(code, expires_at_ms).as_bytes());
        format!(
            "{expires_at_ms}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    /// Whether `ticket` was minted for `code` and is still in date at `now_ms`.
    ///
    /// The signature is checked before the expiry, so a forged ticket learns
    /// nothing about whether it would have been in date.
    pub fn verify(&self, ticket: &str, code: &str, now_ms: i64) -> bool {
        let Some((expiry, signature)) = ticket.split_once('.') else {
            return false;
        };
        if expiry.is_empty()
            || expiry.len() > 16
            || !expiry.bytes().all(|byte| byte.is_ascii_digit())
        {
            return false;
        }
        let Ok(expires_at_ms) = expiry.parse::<i64>() else {
            return false;
        };
        let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
            return false;
        };
        let mut mac = self.mac();
        mac.update(message(code, expires_at_ms).as_bytes());
        if mac.verify_slice(&signature).is_err() {
            return false;
        }
        now_ms < expires_at_ms
    }
}

/// When a ticket issued by a read at `now_ms` stops working: one ticket
/// lifetime, but never past the share's own expiry.
pub fn ticket_expiry(now_ms: i64, share_expires_at_ms: Option<i64>, ttl_seconds: u64) -> i64 {
    let by_ttl = now_ms.saturating_add((ttl_seconds as i64).saturating_mul(1000));
    match share_expires_at_ms {
        Some(expiry) => by_ttl.min(expiry),
        None => by_ttl,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"0123456789abcdef0123456789abcdef";

    #[test]
    fn refuses_a_short_key() {
        assert_eq!(ReadTicketSigner::new(b"short").unwrap_err(), WeakTicketKey);
    }

    #[test]
    fn a_ticket_opens_its_own_share_until_it_expires() {
        let signer = ReadTicketSigner::new(KEY).unwrap();
        let ticket = signer.mint("CODE12345678", 10_000);
        assert!(signer.verify(&ticket, "CODE12345678", 9_999));
        assert!(!signer.verify(&ticket, "CODE12345678", 10_000));
        assert!(!signer.verify(&ticket, "OTHER1234567", 9_999));
    }

    #[test]
    fn a_ticket_cannot_be_extended_or_forged() {
        let signer = ReadTicketSigner::new(KEY).unwrap();
        let ticket = signer.mint("CODE12345678", 10_000);
        let (_, signature) = ticket.split_once('.').unwrap();
        assert!(!signer.verify(&format!("99999999.{signature}"), "CODE12345678", 0));
        let other = ReadTicketSigner::new(b"fedcba9876543210fedcba9876543210").unwrap();
        assert!(!other.verify(&ticket, "CODE12345678", 0));
        for junk in ["", ".", "10000", "10000.", "-1.abc", "1e5.abc", "10000.!!!"] {
            assert!(!signer.verify(junk, "CODE12345678", 0), "{junk}");
        }
    }

    #[test]
    fn matches_the_frozen_vector_the_worker_also_checks() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../ticket-vector.json")).unwrap();
        let key: Vec<u8> = (0..vector["keyHex"].as_str().unwrap().len())
            .step_by(2)
            .map(|index| {
                u8::from_str_radix(&vector["keyHex"].as_str().unwrap()[index..index + 2], 16)
                    .unwrap()
            })
            .collect();
        let signer = ReadTicketSigner::new(&key).unwrap();
        let code = vector["code"].as_str().unwrap();
        let expires_at = vector["expiresAt"].as_i64().unwrap();
        assert_eq!(
            signer.mint(code, expires_at),
            vector["ticket"].as_str().unwrap()
        );
    }

    #[test]
    fn ticket_expiry_never_outlives_the_share() {
        assert_eq!(ticket_expiry(1_000, None, 3_600), 3_601_000);
        assert_eq!(ticket_expiry(1_000, Some(5_000), 3_600), 5_000);
        assert_eq!(ticket_expiry(1_000, Some(9_000_000), 3_600), 3_601_000);
    }
}
