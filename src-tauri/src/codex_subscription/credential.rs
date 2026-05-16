// OS-keyring-backed storage for the Codex (OpenAI) subscription credential.
//
// Service name `com.cognia.codex-subscription/v1` is namespaced so a future
// schema bump can ship a fresh entry instead of corrupting the old one.
// Account is fixed to `default` until multi-account support lands.

use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "com.cognia.codex-subscription/v1";
const ACCOUNT: &str = "default";

/// Persisted shape of a Codex credential. Stored as JSON in a single keyring
/// entry. Mirrors `lib/codex-subscription/types.ts::CodexCredential` — field
/// renames are applied so the wire format is stable across the IPC boundary.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CodexCredential {
    /// Either the ChatGPT-issued bearer JWT or — for `auth_mode == "api_key"`
    /// — the raw OpenAI API key. Treat as a secret.
    #[serde(rename = "accessToken", default, skip_serializing_if = "String::is_empty")]
    pub access_token: String,
    /// Long-lived refresh token (only present for `auth_mode == "chatgpt"`).
    /// May rotate on every refresh; callers must always persist the latest.
    #[serde(rename = "refreshToken", default, skip_serializing_if = "String::is_empty")]
    pub refresh_token: String,
    /// Raw id_token JWT (only `chatgpt` mode). Kept for downstream introspection
    /// (plan / email / account_id are parsed from this).
    #[serde(rename = "idTokenRaw", default, skip_serializing_if = "String::is_empty")]
    pub id_token_raw: String,
    /// Absolute expiry in ms epoch. 0 when unknown (api_key mode never expires
    /// locally, so 0 is the sentinel for "doesn't apply").
    #[serde(rename = "expiresAtMs", default)]
    pub expires_at_ms: i64,
    /// `"chatgpt"` or `"api_key"`. Determines which env var the external
    /// codex agent receives — see `lib/ai/agent/external/env-builder.ts`.
    #[serde(rename = "authMode")]
    pub auth_mode: String,
    /// Account email surfaced in the Account tab. Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Plan label ("free", "plus", "pro", "team", "enterprise", etc.).
    #[serde(rename = "chatgptPlanType", default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_plan_type: Option<String>,
    /// ChatGPT user id surfaced in the Account tab.
    #[serde(rename = "chatgptUserId", default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_user_id: Option<String>,
    /// Organization / workspace identifier (when present).
    #[serde(rename = "accountId", default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Where this credential was originally adopted from. `"file"` =
    /// `~/.codex/auth.json`, `"keyring"` = codex-cli's `"Codex Auth"`
    /// keyring entry, `"oauth"` = our own device-code flow.
    #[serde(rename = "originalSource", default, skip_serializing_if = "Option::is_none")]
    pub original_source: Option<String>,
    /// When this record was last written (ms epoch).
    #[serde(rename = "storedAtMs", default)]
    pub stored_at_ms: i64,
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keyring init failed: {e}"))
}

/// Persist the credential. Validates that at least one token field is non-empty;
/// callers wanting to remove the entry should use `clear()` instead.
pub fn save(credential: &CodexCredential) -> Result<(), String> {
    if credential.access_token.trim().is_empty() && credential.refresh_token.trim().is_empty() {
        return Err("at least one of access_token / refresh_token must be set".into());
    }
    if credential.auth_mode.trim().is_empty() {
        return Err("auth_mode must be 'chatgpt' or 'api_key'".into());
    }
    let blob = serde_json::to_string(credential)
        .map_err(|e| format!("credential serialize failed: {e}"))?;
    entry()?
        .set_password(&blob)
        .map_err(|e| format!("keyring write failed: {e}"))
}

/// Read the credential. Returns `Ok(None)` when no entry exists.
pub fn load() -> Result<Option<CodexCredential>, String> {
    match entry()?.get_password() {
        Ok(blob) => {
            let parsed: CodexCredential = serde_json::from_str(&blob)
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

    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    fn sample() -> CodexCredential {
        CodexCredential {
            access_token: "oat01-codex-test".into(),
            refresh_token: "rt-codex-test".into(),
            id_token_raw: "eyJ.fake.jwt".into(),
            expires_at_ms: 1_700_000_000_000,
            auth_mode: "chatgpt".into(),
            email: Some("user@example.com".into()),
            chatgpt_plan_type: Some("plus".into()),
            chatgpt_user_id: Some("user_abc".into()),
            account_id: Some("acct_def".into()),
            original_source: Some("file".into()),
            stored_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn rejects_empty_tokens() {
        let mut c = sample();
        c.access_token = String::new();
        c.refresh_token = String::new();
        assert!(save(&c).is_err());
    }

    #[test]
    fn rejects_blank_auth_mode() {
        let mut c = sample();
        c.auth_mode = "".into();
        assert!(save(&c).is_err());
    }

    #[test]
    fn json_round_trips_through_serde() {
        let original = sample();
        let blob = serde_json::to_string(&original).unwrap();
        let parsed: CodexCredential = serde_json::from_str(&blob).unwrap();
        assert_eq!(parsed, original);
    }

    #[test]
    fn json_skips_optional_nones() {
        let mut c = sample();
        c.email = None;
        c.chatgpt_plan_type = None;
        c.chatgpt_user_id = None;
        c.account_id = None;
        c.original_source = None;
        let blob = serde_json::to_string(&c).unwrap();
        assert!(!blob.contains("\"email\""));
        assert!(!blob.contains("\"chatgptPlanType\""));
        assert!(!blob.contains("\"chatgptUserId\""));
        assert!(!blob.contains("\"accountId\""));
        assert!(!blob.contains("\"originalSource\""));
    }

    #[test]
    fn api_key_mode_round_trip() {
        let c = CodexCredential {
            access_token: "sk-test-1234".into(),
            refresh_token: "".into(),
            id_token_raw: "".into(),
            expires_at_ms: 0,
            auth_mode: "api_key".into(),
            email: None,
            chatgpt_plan_type: None,
            chatgpt_user_id: None,
            account_id: None,
            original_source: Some("oauth".into()),
            stored_at_ms: 1_700_000_000_000,
        };
        let blob = serde_json::to_string(&c).unwrap();
        let parsed: CodexCredential = serde_json::from_str(&blob).unwrap();
        assert_eq!(parsed.auth_mode, "api_key");
        assert_eq!(parsed.access_token, "sk-test-1234");
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
        let _ = clear();
        assert!(clear().is_ok());
    }
}
