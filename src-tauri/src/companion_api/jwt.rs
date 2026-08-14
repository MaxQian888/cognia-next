//! HS256 JWT helpers retained for loopback service principals and transitional
//! internal device callers. Public Companion pairing uses ES256 device keys,
//! one-time Owner invitations, and short-lived access tokens from [`super::api`].
//!
//! # Error handling
//!
//! [`JwtError`] is serializable as a string via `Display` so it can propagate
//! cleanly through the axum error path.

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// 90 days in seconds.
#[cfg(test)]
const DEVICE_TTL_SECS: i64 = 90 * 24 * 3600;
/// 24 hours in seconds — the headless brain's service token (ADR-0059 W4).
/// Short-lived and re-minted on every brain spawn + on a 12h refresh timer,
/// so a leaked token expires fast; the loopback-peer check in the middleware
/// is the primary defense.
const SERVICE_TTL_SECS: i64 = 24 * 3600;

/// `device_id` stamped on the headless brain's service token. The brain is a
/// singleton localhost client, not a paired device.
pub const SERVICE_DEVICE_ID: &str = "brain-local";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Claims carried in every companion JWT.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Claims {
    /// `"device"` or `"service"`.
    pub scope: String,
    /// Issued-at (seconds since Unix epoch).
    pub iat: i64,
    /// Expiry (seconds since Unix epoch).
    pub exp: i64,
    /// Device UUID — present on device tokens for attribution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// Local account id bound to the token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

/// Errors returned by [`verify`].
#[derive(Debug, thiserror::Error)]
pub enum JwtError {
    #[error("JWT signature or format invalid: {0}")]
    Invalid(#[from] jsonwebtoken::errors::Error),
    #[error("JWT scope mismatch: expected {expected}, got {actual}")]
    WrongScope { expected: String, actual: String },
    #[error("JWT account mismatch: expected {expected}, got {actual:?}")]
    WrongAccount {
        expected: String,
        actual: Option<String>,
    },
    #[error("invalid local account id: {0}")]
    InvalidAccountId(String),
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/// Mint the retired device-token shape for legacy middleware regression tests.
/// Production device authentication is cgnp3 + P-256 DPoP and has no issuer
/// for this credential type.
#[cfg(test)]
pub fn issue_device_jwt(
    secret: &[u8],
    device_id: &str,
    account_id: &str,
) -> Result<String, JwtError> {
    validate_account_id(account_id)?;
    let now = now_secs();
    let claims = Claims {
        scope: "device".to_string(),
        iat: now,
        exp: now + DEVICE_TTL_SECS,
        device_id: Some(device_id.to_string()),
        account_id: Some(account_id.to_string()),
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret),
    )?;
    Ok(token)
}

/// Issue the headless brain's service JWT signed with `secret` (ADR-0059 W4).
///
/// Carries `scope = "service"` and a fixed `device_id` ([`SERVICE_DEVICE_ID`]).
/// The middleware additionally requires the request to originate from loopback
/// before honoring a service token — a service token minted for the localhost
/// brain must never authenticate a remote caller.
pub fn issue_service_jwt(secret: &[u8], account_id: &str) -> Result<(String, i64), JwtError> {
    validate_account_id(account_id)?;
    let now = now_secs();
    let exp = now + SERVICE_TTL_SECS;
    let claims = Claims {
        scope: "service".to_string(),
        iat: now,
        exp,
        device_id: Some(SERVICE_DEVICE_ID.to_string()),
        account_id: Some(account_id.to_string()),
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret),
    )?;
    Ok((token, exp))
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

/// Verify a JWT for a specific local account.
///
/// This wraps [`verify`] so scope, expiry, and signature failures keep their
/// existing error shape while account mismatches become explicit.
pub fn verify_for_account(
    secret: &[u8],
    token: &str,
    expected_scope: &str,
    expected_account_id: &str,
) -> Result<Claims, JwtError> {
    validate_account_id(expected_account_id)?;
    let claims = verify(secret, token, expected_scope)?;
    if claims.account_id.as_deref() != Some(expected_account_id) {
        return Err(JwtError::WrongAccount {
            expected: expected_account_id.to_string(),
            actual: claims.account_id.clone(),
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

fn validate_account_id(account_id: &str) -> Result<(), JwtError> {
    let bytes = account_id.as_bytes();
    let valid = (6..=64).contains(&bytes.len())
        && bytes.first().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes
            .iter()
            .skip(1)
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-');

    if valid {
        Ok(())
    } else {
        Err(JwtError::InvalidAccountId(account_id.to_string()))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";

    #[test]
    fn issue_and_verify_device_jwt() {
        let device_id = uuid::Uuid::new_v4().to_string();
        let token = issue_device_jwt(SECRET, &device_id, ACCOUNT_ID).expect("issue device");
        let claims =
            verify_for_account(SECRET, &token, "device", ACCOUNT_ID).expect("verify device");
        assert_eq!(claims.scope, "device");
        assert_eq!(claims.device_id.as_deref(), Some(device_id.as_str()));
        assert_eq!(claims.account_id.as_deref(), Some(ACCOUNT_ID));
    }

    #[test]
    fn issue_and_verify_service_jwt() {
        let (token, exp) = issue_service_jwt(SECRET, ACCOUNT_ID).expect("issue service");
        assert!(exp > now_secs());
        let claims =
            verify_for_account(SECRET, &token, "service", ACCOUNT_ID).expect("verify service");
        assert_eq!(claims.scope, "service");
        assert_eq!(claims.device_id.as_deref(), Some(SERVICE_DEVICE_ID));
        assert_eq!(claims.account_id.as_deref(), Some(ACCOUNT_ID));
        // A service token is not a device token.
        assert!(verify(SECRET, &token, "device").is_err());
    }

    #[test]
    fn service_jwt_exp_is_within_24_hours() {
        let before = now_secs();
        let (_, exp) = issue_service_jwt(SECRET, ACCOUNT_ID).expect("issue");
        let after = now_secs();
        assert!(exp >= before + SERVICE_TTL_SECS);
        assert!(exp <= after + SERVICE_TTL_SECS);
    }

    #[test]
    fn wrong_scope_returns_error() {
        let token = issue_device_jwt(SECRET, "dev-id", ACCOUNT_ID).expect("issue device");
        let err = verify(SECRET, &token, "service").unwrap_err();
        assert!(matches!(&err, JwtError::WrongScope { expected, actual }
                if expected == "service" && actual == "device"));
    }

    #[test]
    fn wrong_account_returns_error() {
        let token = issue_device_jwt(SECRET, "dev-id", ACCOUNT_ID).expect("issue device");
        let err = verify_for_account(SECRET, &token, "device", "local_acct_b").unwrap_err();
        assert!(matches!(&err, JwtError::WrongAccount { expected, actual }
                if expected == "local_acct_b" && actual.as_deref() == Some(ACCOUNT_ID)));
    }

    #[test]
    fn invalid_account_id_is_rejected_before_signing() {
        for bad in ["", "short", "_acct_a", "acct space", "acct/slash"] {
            let device_err = issue_device_jwt(SECRET, "dev-id", bad).unwrap_err();
            assert!(matches!(device_err, JwtError::InvalidAccountId(_)));
        }
    }

    #[test]
    fn wrong_secret_returns_error() {
        let token = issue_device_jwt(SECRET, "dev-id", ACCOUNT_ID).expect("issue device");
        let err = verify(b"different-secret-32-bytes-______", &token, "device").unwrap_err();
        assert!(matches!(err, JwtError::Invalid(_)));
    }

    #[test]
    fn expired_token_returns_error() {
        // Build a token with exp in the past.
        let now = now_secs();
        let claims = Claims {
            scope: "device".to_string(),
            iat: now - 400,
            exp: now - 300, // expired 5 minutes ago
            device_id: Some("dev-id".to_string()),
            account_id: Some(ACCOUNT_ID.to_string()),
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(SECRET),
        )
        .expect("encode");

        let err = verify(SECRET, &token, "device").unwrap_err();
        assert!(matches!(err, JwtError::Invalid(_)));
    }

    #[test]
    fn malformed_token_returns_error() {
        let err = verify(SECRET, "not.a.jwt", "device").unwrap_err();
        assert!(matches!(err, JwtError::Invalid(_)));
    }

    #[test]
    fn device_jwt_exp_is_within_90_days() {
        let before = now_secs();
        let token = issue_device_jwt(SECRET, "dev-id", ACCOUNT_ID).expect("issue");
        let claims = verify(SECRET, &token, "device").expect("verify");
        let after = now_secs();
        assert!(claims.exp >= before + DEVICE_TTL_SECS);
        assert!(claims.exp <= after + DEVICE_TTL_SECS);
    }
}
