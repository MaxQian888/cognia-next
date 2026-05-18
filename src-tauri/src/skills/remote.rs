// Fetch SKILL.md (and other small text files) from remote URLs. Browser
// fetch is blocked by Tauri's CSP for arbitrary hosts, so the Rust side
// proxies the request. Limits:
//   - HTTP/HTTPS only.
//   - Response capped at 1 MiB to keep skills small (skills with huge
//     scripts must be installed via Native sync, not raw fetch).
//   - 15s timeout.

use std::time::Duration;

const MAX_BYTES: usize = 1024 * 1024; // 1 MiB
const TIMEOUT_SECS: u64 = 15;

#[tauri::command]
pub async fn skills_fetch_remote_md(url: String) -> Result<String, String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("unsupported scheme: must be http(s)".into());
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper that runs the early validation gate without dispatching the
    /// outbound HTTP request. Mirrors the first three checks in
    /// `skills_fetch_remote_md` so we can unit-test them without a network.
    fn validate_url(url: &str) -> Result<(), String> {
        let lower = url.to_lowercase();
        if !(lower.starts_with("https://") || lower.starts_with("http://")) {
            return Err("unsupported scheme: must be http(s)".into());
        }
        Ok(())
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("ftp://example.com/x").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("").is_err());
    }

    #[test]
    fn accepts_http_and_https() {
        assert!(validate_url("http://example.com").is_ok());
        assert!(validate_url("https://example.com/skill.md").is_ok());
        assert!(validate_url("HTTPS://EXAMPLE.COM").is_ok());
    }

    #[test]
    fn constants_match_documented_limits() {
        assert_eq!(MAX_BYTES, 1024 * 1024);
        assert_eq!(TIMEOUT_SECS, 15);
    }

    #[tokio::test]
    async fn rejects_bad_scheme_via_command() {
        let err = skills_fetch_remote_md("ftp://example.com".to_string()).await;
        assert!(err.is_err());
        let msg = err.unwrap_err();
        assert!(msg.contains("scheme"));
    }
}
