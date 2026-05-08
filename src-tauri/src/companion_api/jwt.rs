//! HS256 JWT helpers for the companion API.
//!
//! # Scopes
//!
//! - `"pair"` — 5-minute TTL, single-use.  Carries a `jti` (UUIDv4) so the
//!   redemption LRU can enforce single-use semantics.  Issued by the desktop
//!   when the user displays the QR code; consumed by the phone on first scan.
//!
//! - `"device"` — 90-day TTL.  Contains `device_id` so every authenticated
//!   request can be attributed to a specific paired device without a database
//!   look-up in the hot path.  Issued at the end of the pair exchange.
//!
//! # Error handling
//!
//! [`JwtError`] is serializable as a string via `Display` so it can propagate
//! cleanly through the axum error path.

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// 5 minutes in seconds.
const PAIR_TTL_SECS: i64 = 5 * 60;
/// 90 days in seconds.
const DEVICE_TTL_SECS: i64 = 90 * 24 * 3600;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Claims carried in every companion JWT.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Claims {
    /// `"pair"` or `"device"`.
    pub scope: String,
    /// Issued-at (seconds since Unix epoch).
    pub iat: i64,
    /// Expiry (seconds since Unix epoch).
    pub exp: i64,
    /// JWT ID — present on pair tokens for single-use tracking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>,
    /// Device UUID — present on device tokens for attribution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

/// Errors returned by [`verify`].
#[derive(Debug, thiserror::Error)]
pub enum JwtError {
    #[error("JWT signature or format invalid: {0}")]
    Invalid(#[from] jsonwebtoken::errors::Error),
    #[error("JWT scope mismatch: expected {expected}, got {actual}")]
    WrongScope { expected: String, actual: String },
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/// Issue a short-lived pair JWT signed with `secret`.
///
/// The token carries `scope = "pair"` and a freshly generated `jti`.
pub fn issue_pair_jwt(secret: &[u8]) -> Result<(String, i64), JwtError> {
    let now = now_secs();
    let exp = now + PAIR_TTL_SECS;
    let claims = Claims {
        scope: "pair".to_string(),
        iat: now,
        exp,
        jti: Some(Uuid::new_v4().to_string()),
        device_id: None,
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret),
    )?;
    Ok((token, exp))
}

/// Issue a long-lived device JWT signed with `secret`.
///
/// The token carries `scope = "device"` and the supplied `device_id`.
pub fn issue_device_jwt(secret: &[u8], device_id: &str) -> Result<String, JwtError> {
    let now = now_secs();
    let claims = Claims {
        scope: "device".to_string(),
        iat: now,
        exp: now + DEVICE_TTL_SECS,
        jti: None,
        device_id: Some(device_id.to_string()),
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret),
    )?;
    Ok(token)
}

/// Verify a JWT and return its claims.
///
/// Validates signature, expiry, and that `scope == expected_scope`.
pub fn verify(secret: &[u8], token: &str, expected_scope: &str) -> Result<Claims, JwtError> {
    let mut validation = Validation::new(Algorithm::HS256);
    // `exp` is validated automatically; no additional leeway.
    validation.leeway = 0;
    validation.validate_exp = true;
    // We set `iat` ourselves — require it to be present.
    validation.validate_nbf = false;
    // Remove the default `sub` requirement so we don't have to include it.
    validation.set_required_spec_claims(&["exp"]);

    let token_data = decode::<Claims>(token, &DecodingKey::from_secret(secret), &validation)?;
    let claims = token_data.claims;

    if claims.scope != expected_scope {
        return Err(JwtError::WrongScope {
            expected: expected_scope.to_string(),
            actual: claims.scope,
        });
    }

    Ok(claims)
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before Unix epoch")
        .as_secs() as i64
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";

    #[test]
    fn issue_and_verify_pair_jwt() {
        let (token, exp) = issue_pair_jwt(SECRET).expect("issue pair");
        assert!(exp > now_secs());
        let claims = verify(SECRET, &token, "pair").expect("verify pair");
        assert_eq!(claims.scope, "pair");
        assert!(claims.jti.is_some());
        assert!(claims.device_id.is_none());
    }

    #[test]
    fn issue_and_verify_device_jwt() {
        let device_id = Uuid::new_v4().to_string();
        let token = issue_device_jwt(SECRET, &device_id).expect("issue device");
        let claims = verify(SECRET, &token, "device").expect("verify device");
        assert_eq!(claims.scope, "device");
        assert_eq!(claims.device_id.as_deref(), Some(device_id.as_str()));
        assert!(claims.jti.is_none());
    }

    #[test]
    fn wrong_scope_returns_error() {
        let (token, _) = issue_pair_jwt(SECRET).expect("issue pair");
        let err = verify(SECRET, &token, "device").unwrap_err();
        assert!(
            matches!(&err, JwtError::WrongScope { expected, actual }
                if expected == "device" && actual == "pair")
        );
    }

    #[test]
    fn wrong_secret_returns_error() {
        let (token, _) = issue_pair_jwt(SECRET).expect("issue pair");
        let err = verify(b"different-secret-32-bytes-______", &token, "pair").unwrap_err();
        assert!(matches!(err, JwtError::Invalid(_)));
    }

    #[test]
    fn expired_token_returns_error() {
        // Build a token with exp in the past.
        let now = now_secs();
        let claims = Claims {
            scope: "pair".to_string(),
            iat: now - 400,
            exp: now - 300, // expired 5 minutes ago
            jti: Some("test-jti".to_string()),
            device_id: None,
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(SECRET),
        )
        .expect("encode");

        let err = verify(SECRET, &token, "pair").unwrap_err();
        assert!(matches!(err, JwtError::Invalid(_)));
    }

    #[test]
    fn malformed_token_returns_error() {
        let err = verify(SECRET, "not.a.jwt", "pair").unwrap_err();
        assert!(matches!(err, JwtError::Invalid(_)));
    }

    #[test]
    fn pair_jwt_exp_is_within_five_minutes() {
        let before = now_secs();
        let (_, exp) = issue_pair_jwt(SECRET).expect("issue");
        let after = now_secs();
        assert!(exp >= before + PAIR_TTL_SECS);
        assert!(exp <= after + PAIR_TTL_SECS);
    }

    #[test]
    fn device_jwt_exp_is_within_90_days() {
        let before = now_secs();
        let token = issue_device_jwt(SECRET, "dev-id").expect("issue");
        let claims = verify(SECRET, &token, "device").expect("verify");
        let after = now_secs();
        assert!(claims.exp >= before + DEVICE_TTL_SECS);
        assert!(claims.exp <= after + DEVICE_TTL_SECS);
    }
}
