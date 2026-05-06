// OS-keyring-backed storage for the Claude subscription OAuth credential.
//
// Service name `com.cognia.claude-subscription/v1` keeps us out of the way of
// the Claude Code CLI's own `Claude Code-credentials` keychain entry; the
// account is fixed to `default` until multi-account lands.

use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "com.cognia.claude-subscription/v1";
const ACCOUNT: &str = "default";

/// Persisted shape of an OAuth credential. Serialized as JSON into the single
/// keyring entry. New optional fields can be added freely; required fields
/// require a service-name version bump.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubscriptionCredential {
    /// OAuth bearer token. Sent as `Authorization: Bearer <token>` to
    /// `api.anthropic.com`. Treat as a secret.
    #[serde(rename = "accessToken")]
    pub access_token: String,
    /// Long-lived refresh token. May be rotated on every refresh — callers
    /// must always persist the latest value returned by the token endpoint.
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
    /// Absolute expiry in ms epoch. Computed as `Date.now() + expires_in*1000`
    /// at exchange time.
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: i64,
    /// `"subscription"` (Pro/Max) or `"console"` (API billing). Determines
    /// which client_id was used and which header set the sidecar must send.
    pub mode: String,
    /// OAuth scope string returned by the server (echoes the request scope).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Optional account email surfaced in the Account tab; provider may not
    /// return one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Optional plan label ("pro", "max", "team", "console").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// When this record was last written, ms epoch. Useful for the UI.
    #[serde(rename = "storedAtMs", default)]
    pub stored_at_ms: i64,
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keyring init failed: {e}"))
}

/// Persist the credential. Empty access_token is rejected — pass `clear()` to
/// remove instead.
pub fn save(credential: &SubscriptionCredential) -> Result<(), String> {
    if credential.access_token.trim().is_empty() {
        return Err("access_token must not be empty".into());
    }
    let blob = serde_json::to_string(credential)
        .map_err(|e| format!("credential serialize failed: {e}"))?;
    entry()?
        .set_password(&blob)
        .map_err(|e| format!("keyring write failed: {e}"))
}

/// Read the credential. Returns `Ok(None)` when no entry exists. JSON-parse
/// failures bubble as errors so the caller can show a "credential corrupted"
/// banner rather than silently dropping the user back to "logged out".
pub fn load() -> Result<Option<SubscriptionCredential>, String> {
    match entry()?.get_password() {
        Ok(blob) => {
            let parsed: SubscriptionCredential = serde_json::from_str(&blob)
                .map_err(|e| format!("credential parse failed: {e}"))?;
            Ok(Some(parsed))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

/// Remove the credential. No-op when nothing is stored.
pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The OS keyring is unavailable in many CI environments. Skip the
    // round-trip tests unless explicitly opted in via the same env var the
    // tts module uses.
    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    fn sample() -> SubscriptionCredential {
        SubscriptionCredential {
            access_token: "oat01-test".into(),
            refresh_token: "rt-test".into(),
            expires_at_ms: 1_700_000_000_000,
            mode: "subscription".into(),
            scope: Some("user:profile user:inference".into()),
            email: Some("user@example.com".into()),
            plan: Some("pro".into()),
            stored_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn rejects_empty_access_token() {
        let mut c = sample();
        c.access_token = String::new();
        assert!(save(&c).is_err());
    }

    #[test]
    fn json_round_trips_through_serde() {
        // Pure serde sanity — exercised even on machines without a keyring.
        let original = sample();
        let blob = serde_json::to_string(&original).unwrap();
        let parsed: SubscriptionCredential = serde_json::from_str(&blob).unwrap();
        assert_eq!(parsed, original);
    }

    #[test]
    fn json_skips_optional_nones() {
        let mut c = sample();
        c.scope = None;
        c.email = None;
        c.plan = None;
        let blob = serde_json::to_string(&c).unwrap();
        assert!(!blob.contains("\"scope\""));
        assert!(!blob.contains("\"email\""));
        assert!(!blob.contains("\"plan\""));
    }

    #[test]
    fn save_load_clear_round_trip() {
        if !keyring_available() {
            return;
        }
        let original = sample();
        save(&original).unwrap();
        let got = load().unwrap().unwrap();
        assert_eq!(got, original);
        clear().unwrap();
        assert!(load().unwrap().is_none());
    }

    #[test]
    fn clear_when_missing_is_ok() {
        if !keyring_available() {
            return;
        }
        // Make sure nothing leaked from a previous test, then clear again.
        let _ = clear();
        assert!(clear().is_ok());
    }
}
