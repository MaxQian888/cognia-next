// Codex OAuth wrappers — device-code flow + token refresh / revoke.
//
// Constants are intentionally identical to codex-cli's (CLIENT_ID, refresh /
// revoke URLs) so the user's ChatGPT account scope decisions carry over and
// `auth.openai.com` recognises us as the same first-party client.

use serde::{Deserialize, Serialize};

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// Device-code grant endpoint. Returns `device_code` + `user_code` +
/// `verification_uri` / `verification_uri_complete`.
pub const DEVICE_CODE_URL: &str = "https://auth.openai.com/oauth/device/code";
/// Polled with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
pub const REFRESH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const REVOKE_TOKEN_URL: &str = "https://auth.openai.com/oauth/revoke";

/// Scopes mirror what codex-cli requests; `openid profile email offline_access`
/// is the standard ChatGPT sign-in claim set and unlocks both the bearer JWT
/// and the long-lived refresh token. Extra OpenAI-specific scopes are added
/// for parity with codex.
pub const DEFAULT_SCOPES: &str = "openid profile email offline_access";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    #[serde(default)]
    pub expires_in: i64,
    /// Poll interval the server asked us to use (seconds). The renderer
    /// honours this minimum; passing a smaller value risks `slow_down`.
    #[serde(default)]
    pub interval: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
    /// Validity of the bearer in seconds. The renderer converts this to an
    /// absolute `expires_at_ms` before persisting.
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub scope: Option<String>,
}

/// Body the server returns while still waiting for the user — exposed so the
/// renderer can map the OAuth-defined codes (`authorization_pending`,
/// `slow_down`, `expired_token`, `access_denied`) to a translated state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollErrorPayload {
    pub error: String,
    #[serde(default)]
    pub error_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PollOutcome {
    Pending(PollErrorPayload),
    Granted(TokenResponse),
}

/// Kick off a device-code flow. Returns the codes the renderer must display
/// + the recommended poll cadence. Pure HTTP — no keyring writes.
pub async fn request_device_code() -> Result<DeviceCodeResponse, String> {
    let client = http_client()?;
    let body = [
        ("client_id", CLIENT_ID),
        ("scope", DEFAULT_SCOPES),
    ];
    let res = client
        .post(DEVICE_CODE_URL)
        .form(&body)
        .send()
        .await
        .map_err(|e| format!("request_device_code transport: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("request_device_code {status}: {body}"));
    }
    res.json::<DeviceCodeResponse>()
        .await
        .map_err(|e| format!("request_device_code parse: {e}"))
}

/// Poll the token endpoint once. Returns either a granted token bundle or
/// the OAuth-defined "still pending" payload (so the renderer can keep
/// polling without surfacing it as an error to the user).
pub async fn poll_device_code(device_code: &str) -> Result<PollOutcome, String> {
    let client = http_client()?;
    let body = [
        ("client_id", CLIENT_ID),
        ("device_code", device_code),
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
    ];
    let res = client
        .post(REFRESH_TOKEN_URL)
        .form(&body)
        .send()
        .await
        .map_err(|e| format!("poll_device_code transport: {e}"))?;
    let status = res.status();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("poll_device_code read body: {e}"))?;
    if status.is_success() {
        let parsed: TokenResponse = serde_json::from_slice(&bytes)
            .map_err(|e| format!("poll_device_code parse success: {e}"))?;
        return Ok(PollOutcome::Granted(parsed));
    }
    // Spec calls for error JSON with `{error, error_description}`. The four
    // codes the renderer expects: authorization_pending, slow_down,
    // expired_token, access_denied.
    let payload: PollErrorPayload = serde_json::from_slice(&bytes)
        .map_err(|e| format!("poll_device_code parse error ({status}): {e}"))?;
    Ok(PollOutcome::Pending(payload))
}

/// Refresh an existing bearer. Rotated `refresh_token` (when returned) MUST
/// be persisted by the caller — some flows rotate every refresh.
pub async fn refresh_token(refresh_token: &str) -> Result<TokenResponse, String> {
    let client = http_client()?;
    let body = [
        ("client_id", CLIENT_ID),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];
    let res = client
        .post(REFRESH_TOKEN_URL)
        .form(&body)
        .send()
        .await
        .map_err(|e| format!("refresh_token transport: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("refresh_token {status}: {body}"));
    }
    res.json::<TokenResponse>()
        .await
        .map_err(|e| format!("refresh_token parse: {e}"))
}

/// Revoke a token. Used by the Sign Out flow when the user wants their
/// session terminated server-side as well as locally.
pub async fn revoke_token(token: &str) -> Result<(), String> {
    let client = http_client()?;
    let body = [("client_id", CLIENT_ID), ("token", token)];
    let res = client
        .post(REVOKE_TOKEN_URL)
        .form(&body)
        .send()
        .await
        .map_err(|e| format!("revoke_token transport: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("revoke_token {status}: {body}"));
    }
    Ok(())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("cognia-next-codex/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client build: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_id_matches_codex_cli() {
        // Hard-coded to the value codex-cli ships (codex-rs/login/src/auth/manager.rs).
        assert_eq!(CLIENT_ID, "app_EMoamEEZ73f0CkXaXp7hrann");
    }

    #[test]
    fn token_endpoints_match_codex_cli() {
        assert_eq!(REFRESH_TOKEN_URL, "https://auth.openai.com/oauth/token");
        assert_eq!(REVOKE_TOKEN_URL, "https://auth.openai.com/oauth/revoke");
    }

    #[test]
    fn device_code_response_parses_minimal_payload() {
        let raw = r#"{
            "device_code": "abc",
            "user_code": "CODE-123",
            "verification_uri": "https://chat.openai.com/d",
            "expires_in": 900,
            "interval": 5
        }"#;
        let parsed: DeviceCodeResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.user_code, "CODE-123");
        assert_eq!(parsed.interval, 5);
        assert!(parsed.verification_uri_complete.is_none());
    }

    #[test]
    fn token_response_parses_full_payload() {
        let raw = r#"{
            "access_token": "oat-1",
            "refresh_token": "rt-1",
            "id_token": "eyJ.x.y",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "openid profile email"
        }"#;
        let parsed: TokenResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.access_token, "oat-1");
        assert_eq!(parsed.refresh_token.as_deref(), Some("rt-1"));
        assert_eq!(parsed.expires_in, Some(3600));
    }

    #[test]
    fn token_response_tolerates_missing_optional_fields() {
        let raw = r#"{"access_token": "oat-only"}"#;
        let parsed: TokenResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.access_token, "oat-only");
        assert!(parsed.refresh_token.is_none());
        assert!(parsed.id_token.is_none());
        assert!(parsed.expires_in.is_none());
    }

    #[test]
    fn poll_error_payload_round_trip() {
        let raw = r#"{"error":"authorization_pending"}"#;
        let parsed: PollErrorPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.error, "authorization_pending");
    }
}
