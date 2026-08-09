//! Native ephemeral-TURN provisioning (ADR-0021).
//!
//! The renderer used to `fetch()` `rtc.live.cloudflare.com` / `api.twilio.com`
//! directly from `lib/credentials/turn-provisioning.ts`. That never worked in
//! the Tauri WebView: `tauri.conf.json`'s `connect-src` allowlists only
//! `self`/`ipc`/`ws`/`wss`/huggingface, so the desktop "Test" button and the
//! background rotation loop were both silently blocked by CSP. Routing the call
//! through this Rust command bypasses CSP (native reqwest, no CSP) AND keeps
//! the provider API secret out of the renderer on the saved path — Rust reads
//! it straight from the OS keyring (namespace `webrtc-turn-provider`, the same
//! namespace `lib/credentials/keyring-store.ts` writes under).
//!
//! The provider API contracts mirror the TS implementation the web/Capacitor
//! shells still use (documented in `turn-provisioning.ts`).

use serde::{Deserialize, Serialize};

/// Keyring namespace the renderer stores the provider API secret under
/// (`createKeyringStore("webrtc-turn-provider")`).
const PROVIDER_KEYRING_NAMESPACE: &str = "webrtc-turn-provider";

const TTL_MIN_SECONDS: u64 = 600;
const TTL_MAX_SECONDS: u64 = 86_400;
const TTL_DEFAULT_SECONDS: u64 = 86_400;

fn clamp_ttl(ttl: Option<u64>) -> u64 {
    ttl.unwrap_or(TTL_DEFAULT_SECONDS)
        .clamp(TTL_MIN_SECONDS, TTL_MAX_SECONDS)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnProvisionInput {
    /// `"cloudflare-calls"` or `"twilio"`.
    pub kind: String,
    #[serde(default)]
    pub cloudflare_key_id: Option<String>,
    #[serde(default)]
    pub twilio_account_sid: Option<String>,
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
    /// Keyring keyId holding the saved provider secret (rotation path).
    #[serde(default)]
    pub secret_key_id: Option<String>,
    /// Freshly-typed token for the "Test before save" path — never persisted
    /// by Rust; takes precedence over `secret_key_id` when present.
    #[serde(default)]
    pub inline_token: Option<String>,
}

/// Mirror of `RTCIceServer` — camelCase to match the renderer.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnProvisionResult {
    pub ice_servers: Vec<IceServer>,
    /// Epoch ms after which the credentials expire.
    pub expires_at_ms: i64,
}

/// Resolve the provider secret: the freshly-typed token wins; otherwise read
/// the keyring blob (`{"apiToken":…}` / `{"authToken":…}`) the renderer saved.
async fn resolve_token(input: &TurnProvisionInput) -> Result<String, String> {
    resolve_token_with(input, |key_id| {
        cognia_secrets::keyring_secrets::get(PROVIDER_KEYRING_NAMESPACE, &key_id)
            .map_err(|e| format!("keyring-error ({e})"))
    })
    .await
}

async fn resolve_token_with<F>(input: &TurnProvisionInput, read_secret: F) -> Result<String, String>
where
    F: FnOnce(String) -> Result<Option<String>, String> + Send + 'static,
{
    if let Some(tok) = input.inline_token.as_deref() {
        if !tok.is_empty() {
            return Ok(tok.to_string());
        }
    }
    let key_id = input
        .secret_key_id
        .as_deref()
        .ok_or_else(|| "turn provisioning failed: missing-secret".to_string())?
        .to_string();
    let raw = tokio::task::spawn_blocking(move || read_secret(key_id))
        .await
        .map_err(|e| format!("turn provisioning failed: keyring-task ({e})"))?
        .map_err(|reason| format!("turn provisioning failed: {reason}"))?
        .ok_or_else(|| "turn provisioning failed: missing-secret".to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "turn provisioning failed: missing-secret".to_string())?;
    parsed
        .get("apiToken")
        .or_else(|| parsed.get("authToken"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "turn provisioning failed: missing-secret".to_string())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Percent-encode a value for use as a single URL path segment. Provider IDs
/// (a Cloudflare Key ID, a Twilio Account SID) are issued URL-safe, but we
/// encode defensively rather than interpolate raw user input into a URL.
fn encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

struct ProviderEndpoints {
    cloudflare_keys: String,
    twilio_accounts: String,
}

impl ProviderEndpoints {
    fn production() -> Self {
        Self {
            cloudflare_keys: "https://rtc.live.cloudflare.com/v1/turn/keys".to_string(),
            twilio_accounts: "https://api.twilio.com/2010-04-01/Accounts".to_string(),
        }
    }
}

/// Provision a fresh ICE-server set from the configured provider. Errors carry
/// a stable reason string (never the secret) so the renderer can surface it.
#[tauri::command]
pub async fn turn_provision(input: TurnProvisionInput) -> Result<TurnProvisionResult, String> {
    let token = resolve_token(&input).await?;
    let endpoints = ProviderEndpoints::production();
    let target = match input.kind.as_str() {
        "cloudflare-calls" => endpoints.cloudflare_keys.as_str(),
        "twilio" => endpoints.twilio_accounts.as_str(),
        _ => return Err("turn provisioning failed: unsupported-provider".to_string()),
    };
    let builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20));
    let (builder, _) = crate::proxy_config::apply_reqwest_policy(builder, target)
        .map_err(|error| error.to_string())?;
    let client = builder
        .build()
        .map_err(|e| format!("turn provisioning failed: client-init ({e})"))?;
    provision_with(&input, &token, &client, &endpoints, now_ms()).await
}

async fn provision_with(
    input: &TurnProvisionInput,
    token: &str,
    client: &reqwest::Client,
    endpoints: &ProviderEndpoints,
    issued_at_ms: i64,
) -> Result<TurnProvisionResult, String> {
    let ttl = clamp_ttl(input.ttl_seconds);
    match input.kind.as_str() {
        "cloudflare-calls" => {
            let key_id = input
                .cloudflare_key_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "turn provisioning failed: missing-cloudflare-key-id".to_string())?;
            let url = format!(
                "{}/{}/credentials/generate-ice-servers",
                endpoints.cloudflare_keys.trim_end_matches('/'),
                encode_path_segment(key_id)
            );
            let res = client
                .post(url)
                .bearer_auth(&token)
                .json(&serde_json::json!({ "ttl": ttl }))
                .send()
                .await
                .map_err(|e| format!("turn provisioning failed: cloudflare-request ({e})"))?;
            let status = res.status();
            if !status.is_success() {
                return Err(format!(
                    "turn provisioning failed: cloudflare-http-error (status {})",
                    status.as_u16()
                ));
            }
            let body: serde_json::Value = res
                .json()
                .await
                .map_err(|e| format!("turn provisioning failed: cloudflare-parse ({e})"))?;
            let ice_servers = parse_ice_servers(body.get("iceServers"));
            Ok(TurnProvisionResult {
                ice_servers,
                expires_at_ms: issued_at_ms + (ttl as i64) * 1000,
            })
        }
        "twilio" => {
            let sid = input
                .twilio_account_sid
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "turn provisioning failed: missing-twilio-sid".to_string())?;
            let url = format!(
                "{}/{}/Tokens.json",
                endpoints.twilio_accounts.trim_end_matches('/'),
                encode_path_segment(sid)
            );
            let res = client
                .post(url)
                .basic_auth(sid, Some(&token))
                .form(&[("Ttl", ttl.to_string())])
                .send()
                .await
                .map_err(|e| format!("turn provisioning failed: twilio-request ({e})"))?;
            let status = res.status();
            if !status.is_success() {
                return Err(format!(
                    "turn provisioning failed: twilio-http-error (status {})",
                    status.as_u16()
                ));
            }
            let body: serde_json::Value = res
                .json()
                .await
                .map_err(|e| format!("turn provisioning failed: twilio-parse ({e})"))?;
            let ice_servers = parse_ice_servers(body.get("ice_servers"));
            let resp_ttl = body
                .get("ttl")
                .and_then(|v| {
                    v.as_str()
                        .and_then(|s| s.parse::<u64>().ok())
                        .or_else(|| v.as_u64())
                })
                .filter(|n| *n > 0)
                .unwrap_or(ttl);
            Ok(TurnProvisionResult {
                ice_servers,
                expires_at_ms: issued_at_ms + (resp_ttl as i64) * 1000,
            })
        }
        other => Err(format!(
            "turn provisioning failed: unsupported-kind ({other})"
        )),
    }
}

/// Normalize a provider's ICE-server list. Cloudflare returns `urls` (string or
/// array); Twilio may use the legacy singular `url` or plural `urls`. Entries
/// without any url are dropped. Mirrors `normalizeTwilioIceServers` in the TS.
fn parse_ice_servers(raw: Option<&serde_json::Value>) -> Vec<IceServer> {
    let Some(serde_json::Value::Array(arr)) = raw else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            let urls = obj.get("urls").or_else(|| obj.get("url"))?;
            if !urls.is_string() && !urls.is_array() {
                return None;
            }
            Some(IceServer {
                urls: urls.clone(),
                username: obj
                    .get("username")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                credential: obj
                    .get("credential")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn input(kind: &str) -> TurnProvisionInput {
        TurnProvisionInput {
            kind: kind.to_string(),
            cloudflare_key_id: None,
            twilio_account_sid: None,
            ttl_seconds: Some(1_000),
            secret_key_id: None,
            inline_token: Some("fresh-token".to_string()),
        }
    }

    fn endpoints(server: &MockServer) -> ProviderEndpoints {
        ProviderEndpoints {
            cloudflare_keys: format!("{}/v1/turn/keys", server.uri()),
            twilio_accounts: format!("{}/2010-04-01/Accounts", server.uri()),
        }
    }

    #[test]
    fn clamp_ttl_bounds_the_window() {
        assert_eq!(clamp_ttl(None), TTL_DEFAULT_SECONDS);
        assert_eq!(clamp_ttl(Some(0)), TTL_MIN_SECONDS);
        assert_eq!(clamp_ttl(Some(100)), TTL_MIN_SECONDS);
        assert_eq!(clamp_ttl(Some(1_000)), 1_000);
        assert_eq!(clamp_ttl(Some(999_999)), TTL_MAX_SECONDS);
    }

    #[tokio::test]
    async fn resolve_token_prefers_inline_over_keyring() {
        let input = TurnProvisionInput {
            kind: "twilio".into(),
            cloudflare_key_id: None,
            twilio_account_sid: Some("AC".into()),
            ttl_seconds: None,
            secret_key_id: Some("kid".into()),
            inline_token: Some("fresh-token".into()),
        };
        assert_eq!(resolve_token(&input).await.unwrap(), "fresh-token");
    }

    #[tokio::test]
    async fn resolve_token_reads_and_parses_the_keyring_blob_off_thread() {
        let mut input = input("twilio");
        input.inline_token = None;
        input.secret_key_id = Some("saved-token".to_string());
        let token = resolve_token_with(&input, |key_id| {
            assert_eq!(key_id, "saved-token");
            Ok(Some(r#"{"authToken":"from-keyring"}"#.to_string()))
        })
        .await
        .unwrap();
        assert_eq!(token, "from-keyring");
    }

    #[tokio::test]
    async fn resolve_token_errors_without_any_source() {
        let input = TurnProvisionInput {
            kind: "twilio".into(),
            cloudflare_key_id: None,
            twilio_account_sid: Some("AC".into()),
            ttl_seconds: None,
            secret_key_id: None,
            inline_token: None,
        };
        assert!(resolve_token(&input)
            .await
            .unwrap_err()
            .contains("missing-secret"));
    }

    #[test]
    fn parse_ice_servers_handles_url_and_urls_and_drops_empty() {
        let raw = serde_json::json!([
            { "urls": "stun:stun.example:3478" },
            { "url": "turn:turn.example:3478", "username": "u", "credential": "c" },
            { "nope": true },
            { "urls": ["turns:turn.example:5349"], "username": "u2", "credential": "c2" }
        ]);
        let servers = parse_ice_servers(Some(&raw));
        assert_eq!(servers.len(), 3);
        assert_eq!(servers[1].username.as_deref(), Some("u"));
        assert_eq!(servers[1].credential.as_deref(), Some("c"));
        assert!(servers[2].urls.is_array());
    }

    #[test]
    fn parse_ice_servers_empty_on_non_array() {
        assert!(parse_ice_servers(None).is_empty());
        assert!(parse_ice_servers(Some(&serde_json::json!({}))).is_empty());
    }

    #[tokio::test]
    async fn provisions_cloudflare_ice_servers_with_the_requested_ttl() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(
                "/v1/turn/keys/key%2Fwith%20spaces/credentials/generate-ice-servers",
            ))
            .and(body_json(serde_json::json!({ "ttl": 1_000 })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "iceServers": [{
                    "urls": ["turn:turn.example:3478"],
                    "username": "user",
                    "credential": "credential"
                }]
            })))
            .mount(&server)
            .await;

        let mut input = input("cloudflare-calls");
        input.cloudflare_key_id = Some("key/with spaces".to_string());
        let result = provision_with(
            &input,
            "fresh-token",
            &reqwest::Client::new(),
            &endpoints(&server),
            5_000,
        )
        .await
        .unwrap();

        assert_eq!(result.expires_at_ms, 1_005_000);
        assert_eq!(
            result.ice_servers,
            vec![IceServer {
                urls: serde_json::json!(["turn:turn.example:3478"]),
                username: Some("user".to_string()),
                credential: Some("credential".to_string()),
            }]
        );
    }

    #[tokio::test]
    async fn provisions_twilio_ice_servers_and_honours_the_response_ttl() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/2010-04-01/Accounts/AC123/Tokens.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ttl": "1200",
                "ice_servers": [{
                    "url": "turn:twilio.example:3478",
                    "username": "user",
                    "credential": "credential"
                }]
            })))
            .mount(&server)
            .await;

        let mut input = input("twilio");
        input.twilio_account_sid = Some("AC123".to_string());
        let result = provision_with(
            &input,
            "fresh-token",
            &reqwest::Client::new(),
            &endpoints(&server),
            7_000,
        )
        .await
        .unwrap();

        assert_eq!(result.expires_at_ms, 1_207_000);
        assert_eq!(
            result.ice_servers[0].urls,
            serde_json::json!("turn:twilio.example:3478")
        );
    }

    #[tokio::test]
    async fn normalizes_provider_http_errors_without_leaking_the_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/turn/keys/key/credentials/generate-ice-servers"))
            .respond_with(
                ResponseTemplate::new(403).set_body_string("secret fresh-token must not escape"),
            )
            .mount(&server)
            .await;

        let mut input = input("cloudflare-calls");
        input.cloudflare_key_id = Some("key".to_string());
        let error = provision_with(
            &input,
            "fresh-token",
            &reqwest::Client::new(),
            &endpoints(&server),
            0,
        )
        .await
        .unwrap_err();

        assert!(error.contains("cloudflare-http-error (status 403)"));
        assert!(!error.contains("fresh-token"));
    }

    #[test]
    fn command_payload_uses_the_renderer_camel_case_contract() {
        let input: TurnProvisionInput = serde_json::from_value(serde_json::json!({
            "kind": "twilio",
            "twilioAccountSid": "AC123",
            "ttlSeconds": 600,
            "secretKeyId": "saved-token",
            "inlineToken": null
        }))
        .unwrap();
        assert_eq!(input.twilio_account_sid.as_deref(), Some("AC123"));
        assert_eq!(input.secret_key_id.as_deref(), Some("saved-token"));

        let value = serde_json::to_value(TurnProvisionResult {
            ice_servers: vec![IceServer {
                urls: serde_json::json!("turn:example"),
                username: None,
                credential: None,
            }],
            expires_at_ms: 123,
        })
        .unwrap();
        assert_eq!(value["expiresAtMs"], 123);
        assert_eq!(value["iceServers"][0]["urls"], "turn:example");
    }
}
