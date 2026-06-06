// Fetch SKILL.md (and other small text files) from remote URLs. Browser
// fetch is blocked by Tauri's CSP for arbitrary hosts, so the Rust side
// proxies the request. Limits:
//   - HTTP/HTTPS only.
//   - Response capped at 1 MiB to keep skills small (skills with huge
//     scripts must be installed via Native sync, not raw fetch).
//   - 15s timeout.

use std::time::Duration;

const MAX_BYTES: usize = 1024 * 1024; // 1 MiB
/// Larger cap for JSON API payloads (marketplace file sets, leaderboard pages).
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024; // 4 MiB
const TIMEOUT_SECS: u64 = 15;

fn validate_scheme(url: &str) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("unsupported scheme: must be http(s)".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn skills_fetch_remote_md(url: String) -> Result<String, String> {
    validate_scheme(&url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .user_agent("cognia-next-skills/0.1")
        .build()
        .map_err(|e| format!("http client: {}", e))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "http {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("body: {}", e))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("response too large: {} bytes", bytes.len()));
    }
    String::from_utf8(bytes.to_vec()).map_err(|e| format!("utf-8: {}", e))
}

/// JSON GET proxy for marketplace APIs (skills.sh + audit service). Unlike
/// `skills_fetch_remote_md`, non-2xx statuses are returned in the response
/// struct (not as `Err`) so the frontend can branch on 401/404/429. Only
/// network/scheme/size failures become `Err`.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGetRequest {
    pub url: String,
    /// When present, sent as `Authorization: Bearer <token>`.
    pub bearer_token: Option<String>,
    /// Defaults to `application/json`.
    pub accept: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGetResponse {
    pub status: u16,
    pub body: String,
    /// Raw `Retry-After` header value, surfaced for 429 handling.
    pub retry_after: Option<String>,
}

#[tauri::command]
pub async fn skills_fetch_remote_json(req: RemoteGetRequest) -> Result<RemoteGetResponse, String> {
    validate_scheme(&req.url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .user_agent("cognia-next-skills/0.1")
        .build()
        .map_err(|e| format!("http client: {}", e))?;
    let mut builder = client.get(&req.url).header(
        reqwest::header::ACCEPT,
        req.accept.as_deref().unwrap_or("application/json"),
    );
    if let Some(token) = req.bearer_token.as_deref().filter(|t| !t.is_empty()) {
        builder = builder.bearer_auth(token);
    }
    let resp = builder.send().await.map_err(|e| format!("request: {}", e))?;
    let status = resp.status().as_u16();
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let bytes = resp.bytes().await.map_err(|e| format!("body: {}", e))?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(format!("response too large: {} bytes", bytes.len()));
    }
    let body = String::from_utf8(bytes.to_vec()).map_err(|e| format!("utf-8: {}", e))?;
    Ok(RemoteGetResponse {
        status,
        body,
        retry_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_schemes() {
        assert!(validate_scheme("file:///etc/passwd").is_err());
        assert!(validate_scheme("ftp://example.com/x").is_err());
        assert!(validate_scheme("javascript:alert(1)").is_err());
        assert!(validate_scheme("").is_err());
    }

    #[test]
    fn accepts_http_and_https() {
        assert!(validate_scheme("http://example.com").is_ok());
        assert!(validate_scheme("https://example.com/skill.md").is_ok());
        assert!(validate_scheme("HTTPS://EXAMPLE.COM").is_ok());
    }

    #[test]
    fn constants_match_documented_limits() {
        assert_eq!(MAX_BYTES, 1024 * 1024);
        assert_eq!(MAX_JSON_BYTES, 4 * 1024 * 1024);
        assert_eq!(TIMEOUT_SECS, 15);
    }

    #[tokio::test]
    async fn rejects_bad_scheme_via_command() {
        let err = skills_fetch_remote_md("ftp://example.com".to_string()).await;
        assert!(err.is_err());
        let msg = err.unwrap_err();
        assert!(msg.contains("scheme"));
    }

    #[tokio::test]
    async fn json_command_rejects_bad_scheme() {
        let err = skills_fetch_remote_json(RemoteGetRequest {
            url: "ftp://example.com".into(),
            bearer_token: None,
            accept: None,
        })
        .await;
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("scheme"));
    }

    #[test]
    fn request_deserializes_camel_case() {
        let req: RemoteGetRequest = serde_json::from_str(
            r#"{"url":"https://skills.sh/api/search","bearerToken":"tok","accept":"application/json"}"#,
        )
        .unwrap();
        assert_eq!(req.url, "https://skills.sh/api/search");
        assert_eq!(req.bearer_token.as_deref(), Some("tok"));
        assert_eq!(req.accept.as_deref(), Some("application/json"));
    }

    #[test]
    fn request_fields_are_optional() {
        let req: RemoteGetRequest =
            serde_json::from_str(r#"{"url":"https://skills.sh/api/search"}"#).unwrap();
        assert!(req.bearer_token.is_none());
        assert!(req.accept.is_none());
    }

    #[test]
    fn response_serializes_camel_case() {
        let json = serde_json::to_string(&RemoteGetResponse {
            status: 429,
            body: "{}".into(),
            retry_after: Some("30".into()),
        })
        .unwrap();
        assert!(json.contains("\"status\":429"));
        assert!(json.contains("\"retryAfter\":\"30\""));
        assert!(json.contains("\"body\":\"{}\""));
    }
}
