// Codex OAuth wrappers — device-code flow (OpenAI's *private* deviceauth
// dialect, NOT the RFC-8628 standard) + token refresh / revoke.
//
// codex-cli's device login is a 3-step custom flow against the OpenAI accounts
// service. Verified against `openai/codex` `codex-rs/login/src/device_code_auth.rs`:
//
//   1. POST {ISSUER}/api/accounts/deviceauth/usercode   (JSON `{client_id}`)
//        -> { device_auth_id, user_code, interval }
//      The user then opens {ISSUER}/codex/device and types `user_code`.
//   2. POST {ISSUER}/api/accounts/deviceauth/token      (JSON `{device_auth_id, user_code}`)
//        -> 404 / 403 while still pending;
//           200 -> { authorization_code, code_challenge, code_verifier }
//      Note: the PKCE pair is MINTED SERVER-SIDE and handed back here — the
//      client does not generate it.
//   3. POST {ISSUER}/oauth/token  (x-www-form-urlencoded; grant_type=authorization_code,
//        code, redirect_uri={ISSUER}/api/accounts/deviceauth/callback, client_id,
//        code_verifier) -> { access_token, refresh_token, id_token, ... }
//
// OpenAI does NOT expose a standard RFC-8628 `/oauth/device/code` endpoint for
// this client, so the previous `/oauth/device/code` +
// `grant_type=urn:ietf:params:oauth:grant-type:device_code` implementation
// could never complete. Refresh / revoke DO use the standard `/oauth` endpoints.
//
// Constants (CLIENT_ID, endpoints) are intentionally identical to codex-cli's so
// `auth.openai.com` recognises us as the same first-party client and the user's
// ChatGPT scope decisions carry over.

use serde::{Deserialize, Serialize};

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// Device-code step 1 — request the user code. JSON body `{client_id}`.
pub const DEVICE_USERCODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
/// Device-code step 2 — poll for the authorization code. JSON body
/// `{device_auth_id, user_code}`. A `404`/`403` means "still pending".
pub const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
/// Standard OAuth token endpoint — used for the code exchange (step 3) and for
/// `grant_type=refresh_token`.
pub const OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// Token revoke endpoint. Hit during full Sign Out (vs local-only clear).
pub const REVOKE_TOKEN_URL: &str = "https://auth.openai.com/oauth/revoke";
/// Redirect URI the device-code exchange must echo back — codex uses the
/// deviceauth callback path on the accounts service.
pub const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/api/accounts/deviceauth/callback";
/// Page the user opens to enter their `user_code`.
pub const VERIFICATION_URL: &str = "https://auth.openai.com/codex/device";

/// Scopes mirror what codex-cli requests; `openid profile email offline_access`
/// is the standard ChatGPT sign-in claim set and unlocks both the bearer JWT
/// and the long-lived refresh token.
pub const DEFAULT_SCOPES: &str = "openid profile email offline_access";

/// The usercode response carries no `expires_in`; codex caps the device poll at
/// 15 minutes, so we surface that as the renderer-facing deadline.
const DEVICE_CODE_EXPIRES_IN_SECS: i64 = 15 * 60;

/// `codex_cli_rs`-shaped User-Agent. The accounts service derives its
/// `originator` from the UA prefix; mirroring codex's shape keeps us recognised
/// as the same first-party client. The version is not validated.
const CODEX_USER_AGENT: &str = concat!("codex_cli_rs/", env!("CARGO_PKG_VERSION"), " (cognia-next)");

/// Raw `POST /deviceauth/usercode` response. Some captures key the code as
/// `usercode`; `interval` arrives as a JSON string in the reference impl.
#[derive(Debug, Clone, Deserialize)]
struct UserCodeResp {
    device_auth_id: String,
    #[serde(alias = "usercode")]
    user_code: String,
    #[serde(default, deserialize_with = "de_interval")]
    interval: i64,
}

/// Renderer-facing device-code bundle. `device_code` carries codex's opaque
/// `device_auth_id`; the renderer must echo BOTH it and `user_code` back when
/// polling (`poll_device_code`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    #[serde(default)]
    pub expires_in: i64,
    /// Poll interval the server asked us to use (seconds). The renderer honours
    /// this minimum.
    #[serde(default)]
    pub interval: i64,
}

/// `POST /deviceauth/token` success body — a server-minted PKCE bundle the
/// client replays into the `/oauth/token` exchange.
#[derive(Debug, Clone, Deserialize)]
struct CodeSuccessResp {
    authorization_code: String,
    #[serde(default)]
    #[allow(dead_code)]
    code_challenge: String,
    code_verifier: String,
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

/// Body the server returns while still waiting for the user. Exposed so the
/// renderer can map the code to a translated state. In codex's custom flow the
/// only server-side "pending" signal is an HTTP 404/403, which we normalise to
/// `authorization_pending`; the renderer's own deadline produces `expired_token`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollErrorPayload {
    pub error: String,
    #[serde(default)]
    pub error_description: Option<String>,
}

/// Externally-tagged on PURPOSE: the renderer's `PollOutcome` type is
/// `{ Pending: … } | { Granted: … }` and `transport.ts` / `pollOutcomeKind`
/// branch on `"Granted" in outcome`. The variant tags must stay PascalCase to
/// match — do NOT add `rename_all` here (camelCase would emit `granted` and the
/// renderer would never detect a successful grant).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PollOutcome {
    Pending(PollErrorPayload),
    Granted(TokenResponse),
}

/// Accept `interval` as either a JSON number or a numeric string (the codex
/// reference emits it as a string).
fn de_interval<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::Number(n) => n.as_i64().ok_or_else(|| Error::custom("interval not i64")),
        serde_json::Value::String(s) => s.trim().parse::<i64>().map_err(Error::custom),
        serde_json::Value::Null => Ok(0),
        other => Err(Error::custom(format!("interval has wrong type: {other}"))),
    }
}

/// Kick off the device-code flow (step 1). Returns the user code + verification
/// URL the renderer must display, plus the opaque `device_auth_id` (as
/// `device_code`) the renderer echoes back when polling. Pure HTTP — no keyring
/// writes.
pub async fn request_device_code() -> Result<DeviceCodeResponse, String> {
    let client = http_client()?;
    let body = serde_json::json!({ "client_id": CLIENT_ID });
    let res = client
        .post(DEVICE_USERCODE_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request_device_code transport: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("request_device_code {status}: {body}"));
    }
    let uc: UserCodeResp = res
        .json()
        .await
        .map_err(|e| format!("request_device_code parse: {e}"))?;
    Ok(DeviceCodeResponse {
        device_code: uc.device_auth_id,
        user_code: uc.user_code,
        verification_uri: VERIFICATION_URL.to_string(),
        verification_uri_complete: None,
        expires_in: DEVICE_CODE_EXPIRES_IN_SECS,
        interval: uc.interval,
    })
}

/// Poll once (step 2). `404`/`403` → still pending. On `200` the server returns
/// the authorization code + PKCE verifier, which we immediately exchange (step
/// 3) so the renderer keeps its existing "poll → Granted(tokens)" contract.
pub async fn poll_device_code(
    device_auth_id: &str,
    user_code: &str,
) -> Result<PollOutcome, String> {
    let client = http_client()?;
    let body = serde_json::json!({
        "device_auth_id": device_auth_id,
        "user_code": user_code,
    });
    let res = client
        .post(DEVICE_TOKEN_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("poll_device_code transport: {e}"))?;
    let status = res.status();
    // codex signals "not yet authorized" with 404 / 403 (NOT an OAuth error
    // body). Map both to the retryable `authorization_pending`.
    if status.as_u16() == 404 || status.as_u16() == 403 {
        return Ok(PollOutcome::Pending(PollErrorPayload {
            error: "authorization_pending".to_string(),
            error_description: None,
        }));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("poll_device_code read body: {e}"))?;
    if !status.is_success() {
        // Any other non-2xx is a hard failure — surface it instead of looping.
        let body = String::from_utf8_lossy(&bytes);
        return Err(format!("poll_device_code {status}: {body}"));
    }
    let code: CodeSuccessResp = serde_json::from_slice(&bytes)
        .map_err(|e| format!("poll_device_code parse success: {e}"))?;
    let token = exchange_code(&client, &code).await?;
    Ok(PollOutcome::Granted(token))
}

/// Step 3 — swap the server-minted authorization code + PKCE verifier for the
/// real token bundle at the standard `/oauth/token` endpoint (form-encoded).
async fn exchange_code(
    client: &reqwest::Client,
    code: &CodeSuccessResp,
) -> Result<TokenResponse, String> {
    let body = [
        ("grant_type", "authorization_code"),
        ("code", code.authorization_code.as_str()),
        ("redirect_uri", DEVICE_REDIRECT_URI),
        ("client_id", CLIENT_ID),
        ("code_verifier", code.code_verifier.as_str()),
    ];
    let res = client
        .post(OAUTH_TOKEN_URL)
        .form(&body)
        .send()
        .await
        .map_err(|e| format!("exchange_code transport: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("exchange_code {status}: {body}"));
    }
    res.json::<TokenResponse>()
        .await
        .map_err(|e| format!("exchange_code parse: {e}"))
}

/// Refresh an existing bearer at the standard `/oauth/token` endpoint. Rotated
/// `refresh_token` (when returned) MUST be persisted by the caller.
pub async fn refresh_token(refresh_token: &str) -> Result<TokenResponse, String> {
    let client = http_client()?;
    let body = [
        ("client_id", CLIENT_ID),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
        ("scope", DEFAULT_SCOPES),
    ];
    let res = client
        .post(OAUTH_TOKEN_URL)
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

/// Revoke a token. Used by the Sign Out flow when the user wants their session
/// terminated server-side as well as locally.
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
        .user_agent(CODEX_USER_AGENT)
        .build()
        .map_err(|e| format!("http client build: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_id_matches_codex_cli() {
        // Hard-coded to the value codex-cli ships (codex-rs/login).
        assert_eq!(CLIENT_ID, "app_EMoamEEZ73f0CkXaXp7hrann");
    }

    #[test]
    fn endpoints_match_codex_cli_deviceauth_flow() {
        // The accounts-service deviceauth dialect — NOT RFC-8628.
        assert_eq!(
            DEVICE_USERCODE_URL,
            "https://auth.openai.com/api/accounts/deviceauth/usercode"
        );
        assert_eq!(
            DEVICE_TOKEN_URL,
            "https://auth.openai.com/api/accounts/deviceauth/token"
        );
        assert_eq!(OAUTH_TOKEN_URL, "https://auth.openai.com/oauth/token");
        assert_eq!(REVOKE_TOKEN_URL, "https://auth.openai.com/oauth/revoke");
        assert_eq!(
            DEVICE_REDIRECT_URI,
            "https://auth.openai.com/api/accounts/deviceauth/callback"
        );
        assert_eq!(VERIFICATION_URL, "https://auth.openai.com/codex/device");
    }

    #[test]
    fn usercode_resp_parses_string_interval_and_usercode_alias() {
        let raw = r#"{"device_auth_id":"da-1","usercode":"CODE-123","interval":"5"}"#;
        let parsed: UserCodeResp = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.device_auth_id, "da-1");
        assert_eq!(parsed.user_code, "CODE-123");
        assert_eq!(parsed.interval, 5);
    }

    #[test]
    fn usercode_resp_parses_numeric_interval_and_canonical_key() {
        let raw = r#"{"device_auth_id":"da-2","user_code":"CODE-2","interval":0}"#;
        let parsed: UserCodeResp = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.user_code, "CODE-2");
        assert_eq!(parsed.interval, 0);
    }

    #[test]
    fn usercode_resp_defaults_missing_interval_to_zero() {
        let raw = r#"{"device_auth_id":"da-3","user_code":"CODE-3"}"#;
        let parsed: UserCodeResp = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.interval, 0);
    }

    #[test]
    fn code_success_resp_parses_server_minted_pkce_bundle() {
        let raw =
            r#"{"authorization_code":"ac-1","code_challenge":"cc-1","code_verifier":"cv-1"}"#;
        let parsed: CodeSuccessResp = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.authorization_code, "ac-1");
        assert_eq!(parsed.code_verifier, "cv-1");
        assert_eq!(parsed.code_challenge, "cc-1");
    }

    #[test]
    fn code_success_resp_tolerates_missing_challenge() {
        let raw = r#"{"authorization_code":"ac-2","code_verifier":"cv-2"}"#;
        let parsed: CodeSuccessResp = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.code_verifier, "cv-2");
        assert!(parsed.code_challenge.is_empty());
    }

    #[test]
    fn device_code_response_serializes_snake_case_for_renderer() {
        let d = DeviceCodeResponse {
            device_code: "da".into(),
            user_code: "uc".into(),
            verification_uri: VERIFICATION_URL.into(),
            verification_uri_complete: None,
            expires_in: DEVICE_CODE_EXPIRES_IN_SECS,
            interval: 5,
        };
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json["device_code"], "da");
        assert_eq!(json["user_code"], "uc");
        assert_eq!(json["verification_uri"], "https://auth.openai.com/codex/device");
        assert_eq!(json["expires_in"], 900);
        assert!(json["verification_uri_complete"].is_null());
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
    fn poll_outcome_uses_pascal_case_tags_for_renderer() {
        // The renderer branches on `"Granted" in outcome` / `"Pending" in outcome`,
        // so the externally-tagged variant names MUST stay PascalCase.
        let pending = PollOutcome::Pending(PollErrorPayload {
            error: "authorization_pending".into(),
            error_description: None,
        });
        let pending_json = serde_json::to_value(&pending).unwrap();
        assert_eq!(pending_json["Pending"]["error"], "authorization_pending");

        let granted = PollOutcome::Granted(TokenResponse {
            access_token: "oat".into(),
            refresh_token: Some("rt".into()),
            id_token: None,
            token_type: None,
            expires_in: Some(3600),
            scope: None,
        });
        let granted_json = serde_json::to_value(&granted).unwrap();
        assert_eq!(granted_json["Granted"]["access_token"], "oat");
    }

    #[test]
    fn poll_error_payload_round_trip() {
        let raw = r#"{"error":"authorization_pending"}"#;
        let parsed: PollErrorPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.error, "authorization_pending");
    }
}
