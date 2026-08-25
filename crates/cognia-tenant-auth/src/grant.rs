//! Short-lived bearer grants for tenant-scoped services — ADR-0149 §7.
//!
//! ADR-0149 decision 11 says new services adopt the grant pattern
//! `services/diagnostic-server` already proved rather than inventing a seventh
//! auth scheme. This is that pattern, lifted and reshaped around a `User`.
//!
//! # Why not a JWT
//!
//! A grant is minted and verified by the same service, for a window measured
//! in minutes. There is no third party to convince, so a JWS gains nothing and
//! costs an asymmetric key to rotate plus a header a caller could try to talk
//! you into honouring (`alg: none` and friends). An opaque
//! `base64url(payload).base64url(hmac)` has one algorithm, chosen by the
//! verifier, and no negotiable fields.
//!
//! The MAC is HMAC-SHA256, byte-identical to what diagnostic-server produces
//! with its older `hmac 0.12` / `sha2 0.10` pairing — only the Rust API
//! differs across those majors, not the output — so the two remain wire
//! compatible if that service is ever able to depend on this crate.
//!
//! # What a grant is not
//!
//! It is not a session and not an identity. It says "the bearer proved, within
//! the last few minutes, that they are this user with this role in this
//! workspace". Anything longer-lived belongs to the IdP.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

use crate::ids::{OrgId, UserId};
use crate::roles::WorkspaceRole;

type HmacSha256 = Hmac<Sha256>;

/// The signing key floor. 32 bytes is the HMAC-SHA256 block-optimal length;
/// anything shorter is a configuration mistake worth failing loudly on rather
/// than silently accepting a weak key.
pub const MINIMUM_KEY_BYTES: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum GrantError {
    #[error("grant signing key must contain at least {MINIMUM_KEY_BYTES} bytes")]
    WeakKey,
    #[error("malformed grant: {0}")]
    Malformed(&'static str),
    #[error("invalid grant signature")]
    BadSignature,
    #[error("grant expired")]
    Expired,
    #[error("grant claims are not readable: {0}")]
    Claims(String),
    #[error("the system clock is before the unix epoch")]
    Clock,
}

/// Anything a [`GrantSigner`] will mint. The expiry has to be reachable
/// generically, because refusing an expired grant is the signer's job and not
/// each caller's to remember.
pub trait ExpiringClaims {
    fn expires_at(&self) -> i64;
}

/// The claims a Cognia collaboration-plane grant carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantClaims {
    /// Unique per mint, so an audit trail can point at one specific grant.
    pub grant_id: Uuid,
    /// The person. ADR-0149's whole point: the subject is a human, not a
    /// device and not a local profile.
    pub user_id: UserId,
    pub org_id: OrgId,
    /// Absent for an org-scoped grant — listing your workspaces, for instance,
    /// is not scoped to one of them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// The role resolved at mint time by [`crate::membership`]. Baked in on
    /// purpose: re-resolving on every request would let a mid-flight
    /// membership change take effect at an arbitrary point inside a request.
    /// The grant's short TTL is what bounds the staleness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<WorkspaceRole>,
    pub issued_at: i64,
    pub expires_at: i64,
}

impl ExpiringClaims for GrantClaims {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

/// Mints and verifies grants with one symmetric key.
///
/// `Clone` is cheap and intended — this lives in an axum `State`.
#[derive(Clone)]
pub struct GrantSigner {
    key: Vec<u8>,
}

impl std::fmt::Debug for GrantSigner {
    /// Hand-written so the key cannot reach a log line through a `{:?}` on
    /// some enclosing state struct.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GrantSigner")
            .field("key", &"<redacted>")
            .finish()
    }
}

impl GrantSigner {
    pub fn new(key: &[u8]) -> Result<Self, GrantError> {
        if key.len() < MINIMUM_KEY_BYTES {
            return Err(GrantError::WeakKey);
        }
        Ok(Self { key: key.to_vec() })
    }

    /// Mint a grant for `claims`, which must already carry its own expiry.
    pub fn sign<T: Serialize>(&self, claims: &T) -> Result<String, GrantError> {
        let payload =
            serde_json::to_vec(claims).map_err(|error| GrantError::Claims(error.to_string()))?;
        let encoded = URL_SAFE_NO_PAD.encode(payload);
        Ok(format!("{encoded}.{}", self.mac(encoded.as_bytes())))
    }

    /// Verify a grant and return its claims. Refuses an expired grant.
    pub fn verify<T: DeserializeOwned + ExpiringClaims>(
        &self,
        token: &str,
    ) -> Result<T, GrantError> {
        let (payload, signature) = token
            .split_once('.')
            .ok_or(GrantError::Malformed("expected `payload.signature`"))?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| GrantError::Malformed("signature is not base64url"))?;

        let mut mac = HmacSha256::new_from_slice(&self.key).map_err(|_| GrantError::WeakKey)?;
        mac.update(payload.as_bytes());
        // Constant-time inside `hmac`; do not be tempted to compare hex here.
        mac.verify_slice(&signature)
            .map_err(|_| GrantError::BadSignature)?;

        let claims: T = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .map_err(|_| GrantError::Malformed("claims are not base64url"))?,
        )
        .map_err(|error| GrantError::Claims(error.to_string()))?;

        if claims.expires_at() < unix_now()? {
            return Err(GrantError::Expired);
        }
        Ok(claims)
    }

    fn mac(&self, message: &[u8]) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("key length checked in `new`");
        mac.update(message);
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    }
}

impl GrantClaims {
    /// Build claims expiring `ttl` from now.
    pub fn issue(
        user_id: UserId,
        org_id: OrgId,
        workspace_id: Option<String>,
        role: Option<WorkspaceRole>,
        ttl: Duration,
    ) -> Result<Self, GrantError> {
        let issued_at = unix_now()?;
        Ok(Self {
            grant_id: Uuid::new_v4(),
            user_id,
            org_id,
            workspace_id,
            role,
            issued_at,
            expires_at: issued_at + ttl.as_secs() as i64,
        })
    }
}

/// Reject a request whose client clock is too far from ours.
///
/// Used on signature-over-timestamp proofs, where a wide window is a replay
/// window. Separate from grant expiry: this one bounds the *request*, that one
/// bounds the credential.
pub fn validate_request_timestamp(timestamp: i64, tolerance: Duration) -> Result<(), GrantError> {
    if timestamp.abs_diff(unix_now()?) > tolerance.as_secs() {
        return Err(GrantError::Expired);
    }
    Ok(())
}

fn unix_now() -> Result<i64, GrantError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| GrantError::Clock)?
        .as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> UserId {
        UserId::parse("usr_0123456789abcdef01234567").unwrap()
    }

    fn org() -> OrgId {
        OrgId::parse("org_0123456789abcdef01234567").unwrap()
    }

    fn signer() -> GrantSigner {
        GrantSigner::new(&[7; 32]).unwrap()
    }

    fn workspace_grant() -> GrantClaims {
        GrantClaims::issue(
            user(),
            org(),
            Some("proj-1".into()),
            Some(WorkspaceRole::Member),
            Duration::from_secs(300),
        )
        .unwrap()
    }

    #[test]
    fn a_grant_round_trips_with_every_claim_intact() {
        let signer = signer();
        let claims = workspace_grant();
        let token = signer.sign(&claims).unwrap();
        assert_eq!(signer.verify::<GrantClaims>(&token).unwrap(), claims);
    }

    #[test]
    fn refuses_a_weak_key_rather_than_accepting_it() {
        assert!(matches!(
            GrantSigner::new(&[1; 31]),
            Err(GrantError::WeakKey)
        ));
        assert!(GrantSigner::new(&[1; 32]).is_ok());
    }

    #[test]
    fn a_tampered_payload_fails_the_signature_not_the_parse() {
        // The distinction matters: reaching the claims parser at all would
        // mean attacker-controlled JSON was deserialized before verification.
        let signer = signer();
        let token = signer.sign(&workspace_grant()).unwrap();
        let (payload, signature) = token.split_once('.').unwrap();

        let mut forged: GrantClaims =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        forged.role = Some(WorkspaceRole::Maintainer);
        let forged_payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap());

        let result = signer.verify::<GrantClaims>(&format!("{forged_payload}.{signature}"));
        assert!(matches!(result, Err(GrantError::BadSignature)));
    }

    #[test]
    fn a_grant_from_another_key_is_refused() {
        let token = signer().sign(&workspace_grant()).unwrap();
        let other = GrantSigner::new(&[9; 32]).unwrap();
        assert!(matches!(
            other.verify::<GrantClaims>(&token),
            Err(GrantError::BadSignature)
        ));
    }

    #[test]
    fn malformed_tokens_are_named_rather_than_panicking() {
        let signer = signer();
        assert!(matches!(
            signer.verify::<GrantClaims>("no-dot"),
            Err(GrantError::Malformed(_))
        ));
        assert!(matches!(
            signer.verify::<GrantClaims>("payload.!!!not-base64!!!"),
            Err(GrantError::Malformed(_))
        ));
        // Correct signature over bytes that are not valid claims JSON.
        let encoded = URL_SAFE_NO_PAD.encode(b"not json");
        let token = format!("{encoded}.{}", signer.mac(encoded.as_bytes()));
        assert!(matches!(
            signer.verify::<GrantClaims>(&token),
            Err(GrantError::Claims(_))
        ));
    }

    #[test]
    fn an_expired_grant_is_refused_even_though_it_verifies() {
        let signer = signer();
        let mut claims = workspace_grant();
        claims.expires_at = unix_now().unwrap() - 1;
        let token = signer.sign(&claims).unwrap();
        assert!(matches!(
            signer.verify::<GrantClaims>(&token),
            Err(GrantError::Expired)
        ));
    }

    #[test]
    fn an_org_scoped_grant_omits_the_workspace_fields_entirely() {
        // `skip_serializing_if` keeps a null out of the payload, so an
        // org-scoped grant cannot be read as "workspace: null, role: null"
        // by a consumer that treats an explicit null as a value.
        let claims =
            GrantClaims::issue(user(), org(), None, None, Duration::from_secs(60)).unwrap();
        let json = serde_json::to_string(&claims).unwrap();
        assert!(!json.contains("workspaceId"), "{json}");
        assert!(!json.contains("\"role\""), "{json}");
        let token = signer().sign(&claims).unwrap();
        let verified = signer().verify::<GrantClaims>(&token).unwrap();
        assert_eq!(verified.workspace_id, None);
        assert_eq!(verified.role, None);
    }

    #[test]
    fn claims_carry_camel_case_on_the_wire() {
        let json = serde_json::to_string(&workspace_grant()).unwrap();
        for key in [
            "grantId",
            "userId",
            "orgId",
            "workspaceId",
            "issuedAt",
            "expiresAt",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "missing {key} in {json}"
            );
        }
    }

    #[test]
    fn a_grant_carrying_a_malformed_user_id_is_refused_at_verification() {
        // Belt to the newtype's braces: the ids are validated on the way back
        // in, so a signer with a leaked key still cannot inject a junk subject.
        let signer = signer();
        let encoded = URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "grantId": Uuid::new_v4(),
                "userId": "not-a-user-id",
                "orgId": org().as_str(),
                "issuedAt": 0,
                "expiresAt": unix_now().unwrap() + 60,
            })
            .to_string()
            .into_bytes(),
        );
        let token = format!("{encoded}.{}", signer.mac(encoded.as_bytes()));
        assert!(matches!(
            signer.verify::<GrantClaims>(&token),
            Err(GrantError::Claims(_))
        ));
    }

    #[test]
    fn the_signer_never_prints_its_key() {
        let rendered = format!("{:?}", GrantSigner::new(&[0xab; 32]).unwrap());
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("171"), "{rendered}");
    }

    #[test]
    fn request_timestamps_are_bounded_in_both_directions() {
        let now = unix_now().unwrap();
        assert!(validate_request_timestamp(now, Duration::from_secs(30)).is_ok());
        // A future timestamp is as much a replay signal as an old one.
        assert!(validate_request_timestamp(now + 31, Duration::from_secs(30)).is_err());
        assert!(validate_request_timestamp(now - 31, Duration::from_secs(30)).is_err());
    }
}
