//! Verifying a collaboration-plane grant — ADR-0149 §8.
//!
//! # Why this exists at all
//!
//! Before ADR-0149 the share service had one global bearer secret for every
//! write and fully public reads, which is why §8 lists it as **must** fix: one
//! leaked secret was every tenant's secret, and there was no way to answer
//! "which org do these shares belong to" or "revoke everything that person
//! shared".
//!
//! # Why it is a second implementation
//!
//! `crates/cognia-tenant-auth` owns this format, and this crate does not
//! depend on it. That is not an oversight — `.github/workflows/images.yml`
//! builds this service with `context: services/share-server`, so a
//! `path = "../../crates/…"` dependency resolves under `cargo test` and then
//! fails inside Docker, where the parent directory does not exist. The ADR
//! records the same constraint for `services/diagnostic-server`. Changing a
//! deploy pipeline's build context to serve a refactor is the worse trade.
//!
//! So the wire format is duplicated and the duplication is PINNED: a frozen
//! test vector, checked in beside the owning crate, is verified by both. A
//! silent divergence would mean grants that the collaboration server mints and
//! this service rejects — visible only in production, and only as "sharing
//! stopped working".
//!
//! # What is deliberately not here
//!
//! Minting. This service never issues a grant; it only checks one. Half a
//! signer is how a key ends up somewhere it did not need to be.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use serde::Deserialize;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Matches `cognia_tenant_auth::grant::MINIMUM_KEY_BYTES`. A shorter key is a
/// configuration mistake worth refusing loudly rather than quietly accepting.
pub const MINIMUM_KEY_BYTES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantError {
    WeakKey,
    Malformed(&'static str),
    BadSignature,
    Expired,
    Claims,
}

impl std::fmt::Display for GrantError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WeakKey => write!(
                formatter,
                "grant key must contain at least {MINIMUM_KEY_BYTES} bytes"
            ),
            Self::Malformed(reason) => write!(formatter, "malformed grant: {reason}"),
            Self::BadSignature => write!(formatter, "invalid grant signature"),
            Self::Expired => write!(formatter, "grant expired"),
            Self::Claims => write!(formatter, "grant claims are not readable"),
        }
    }
}

impl std::error::Error for GrantError {}

/// The claims this service reads.
///
/// A grant carries more than this — a workspace, a role — and those are
/// deliberately not modelled: a share belongs to an org, not to a workspace,
/// and modelling fields nobody reads invites somebody to start trusting them.
/// Unknown fields are ignored, which is also what keeps this forward
/// compatible with a grant that grows one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantClaims {
    pub org_id: String,
    pub user_id: String,
    pub expires_at: i64,
}

/// Checks grants minted by the collaboration server with the shared key.
#[derive(Clone)]
pub struct GrantVerifier {
    key: Vec<u8>,
}

impl std::fmt::Debug for GrantVerifier {
    /// Hand-written so the key cannot reach a log line through a `{:?}` on
    /// some enclosing state struct.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GrantVerifier")
            .field("key", &"<redacted>")
            .finish()
    }
}

impl GrantVerifier {
    pub fn new(key: &[u8]) -> Result<Self, GrantError> {
        if key.len() < MINIMUM_KEY_BYTES {
            return Err(GrantError::WeakKey);
        }
        Ok(Self { key: key.to_vec() })
    }

    /// Verify `token` and return its claims.
    ///
    /// `now_unix` is a parameter rather than a clock read, because this crate
    /// is the side-effect-free half of the service and an expiry test that
    /// reads the wall clock cannot be tested at a boundary.
    pub fn verify(&self, token: &str, now_unix: i64) -> Result<GrantClaims, GrantError> {
        let (payload, signature) = token
            .split_once('.')
            .ok_or(GrantError::Malformed("expected `payload.signature`"))?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| GrantError::Malformed("signature is not base64url"))?;

        let mut mac = HmacSha256::new_from_slice(&self.key).map_err(|_| GrantError::WeakKey)?;
        mac.update(payload.as_bytes());
        // Constant-time inside `hmac`. Do not be tempted to compare hex here.
        mac.verify_slice(&signature)
            .map_err(|_| GrantError::BadSignature)?;

        let claims: GrantClaims = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| GrantError::Malformed("claims are not base64url"))?,
        )
        .map_err(|_| GrantError::Claims)?;

        // Signature first, expiry second: an attacker must not learn whether a
        // forged payload would have been in date.
        if claims.expires_at < now_unix {
            return Err(GrantError::Expired);
        }
        Ok(claims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"0123456789abcdef0123456789abcdef";

    fn sign(key: &[u8], payload_json: &str) -> String {
        let encoded = URL_SAFE_NO_PAD.encode(payload_json.as_bytes());
        let mut mac = HmacSha256::new_from_slice(key).unwrap();
        mac.update(encoded.as_bytes());
        format!(
            "{encoded}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    #[test]
    fn refuses_a_key_that_is_too_short() {
        assert_eq!(
            GrantVerifier::new(b"short").unwrap_err(),
            GrantError::WeakKey
        );
    }

    #[test]
    fn accepts_a_grant_and_reads_the_org_and_person() {
        let token = sign(
            KEY,
            r#"{"grantId":"11111111-1111-1111-1111-111111111111","userId":"usr_ada","orgId":"org_acme","issuedAt":100,"expiresAt":400}"#,
        );
        let claims = GrantVerifier::new(KEY)
            .unwrap()
            .verify(&token, 200)
            .unwrap();
        assert_eq!(claims.org_id, "org_acme");
        assert_eq!(claims.user_id, "usr_ada");
    }

    #[test]
    fn ignores_claims_this_service_does_not_read() {
        // A grant scoped to a workspace is still a valid org grant here. If
        // this stopped parsing, every workspace-scoped caller would be locked
        // out by a field they were right to send.
        let token = sign(
            KEY,
            r#"{"grantId":"1","userId":"usr_ada","orgId":"org_acme","workspaceId":"proj_1","role":"maintainer","issuedAt":100,"expiresAt":400}"#,
        );
        assert_eq!(
            GrantVerifier::new(KEY)
                .unwrap()
                .verify(&token, 200)
                .unwrap()
                .org_id,
            "org_acme"
        );
    }

    #[test]
    fn refuses_a_grant_signed_with_another_key() {
        let token = sign(
            b"ffffffffffffffffffffffffffffffff",
            r#"{"userId":"usr_ada","orgId":"org_acme","expiresAt":400}"#,
        );
        assert_eq!(
            GrantVerifier::new(KEY).unwrap().verify(&token, 200),
            Err(GrantError::BadSignature)
        );
    }

    #[test]
    fn refuses_an_expired_grant() {
        let token = sign(
            KEY,
            r#"{"userId":"usr_ada","orgId":"org_acme","expiresAt":100}"#,
        );
        assert_eq!(
            GrantVerifier::new(KEY).unwrap().verify(&token, 200),
            Err(GrantError::Expired)
        );
    }

    #[test]
    fn refuses_a_tampered_payload_before_looking_at_its_expiry() {
        // Swapping the org in an otherwise-valid grant must fail on the
        // signature, not on anything the payload says.
        let token = sign(
            KEY,
            r#"{"userId":"usr_ada","orgId":"org_acme","expiresAt":400}"#,
        );
        let (_, signature) = token.split_once('.').unwrap();
        let forged =
            URL_SAFE_NO_PAD.encode(r#"{"userId":"usr_ada","orgId":"org_evil","expiresAt":400}"#);
        assert_eq!(
            GrantVerifier::new(KEY)
                .unwrap()
                .verify(&format!("{forged}.{signature}"), 200),
            Err(GrantError::BadSignature)
        );
    }

    #[test]
    fn refuses_a_token_with_no_signature_at_all() {
        assert!(matches!(
            GrantVerifier::new(KEY).unwrap().verify("not-a-grant", 200),
            Err(GrantError::Malformed(_))
        ));
    }
}
