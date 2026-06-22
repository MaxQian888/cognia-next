use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

use reqwest::Method;

pub const DEFAULT_HTTP_TIMEOUT_MS: u64 = 30_000;
pub const MAX_HTTP_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterRegistration {
    pub adapter_id: String,
    pub adapter_type: String,
    pub webhook_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorsHealth {
    pub server_running: bool,
    pub bound_addr: Option<String>,
    pub registered_adapter_count: usize,
}

/// A OneBot reverse-WS client that currently holds a live connection to the
/// in-app axum server. Returned by `connectors_onebot_probe` so the OneBot
/// settings UI can show which configured adapters actually have a NapCat /
/// Lagrange / LLOneBot client dialed in (the reverse-WS direction gives no
/// other signal that the client is up).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneBotLiveClient {
    pub adapter_id: String,
    /// Unix epoch milliseconds when the socket upgraded.
    pub connected_at_ms: u64,
}

/// A platform HTTP request routed from the TS side through a Tauri command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TauriHttpRequest {
    pub url: String,
    pub method: String,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
}

impl TauriHttpRequest {
    pub fn validated_method(&self) -> Result<Method, String> {
        match self.method.trim().to_ascii_uppercase().as_str() {
            "GET" => Ok(Method::GET),
            "POST" => Ok(Method::POST),
            "PUT" => Ok(Method::PUT),
            "PATCH" => Ok(Method::PATCH),
            "DELETE" => Ok(Method::DELETE),
            _ => Err(format!(
                "unsupported HTTP method: {}",
                safe_http_method_label(&self.method)
            )),
        }
    }

    pub fn timeout_duration(&self) -> Duration {
        let timeout_ms = self
            .timeout_ms
            .unwrap_or(DEFAULT_HTTP_TIMEOUT_MS)
            .clamp(1, MAX_HTTP_TIMEOUT_MS);
        Duration::from_millis(timeout_ms)
    }
}

fn safe_http_method_label(value: &str) -> String {
    let normalized: String = value
        .chars()
        .map(|ch| {
            if ch.is_control() || ch.is_whitespace() {
                ' '
            } else {
                ch
            }
        })
        .collect();
    let collapsed = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return "<empty>".to_string();
    }
    const MAX_METHOD_LABEL_CHARS: usize = 80;
    if collapsed.chars().count() <= MAX_METHOD_LABEL_CHARS {
        return collapsed;
    }
    let mut bounded: String = collapsed.chars().take(MAX_METHOD_LABEL_CHARS).collect();
    bounded.push_str("...");
    bounded
}

/// The HTTP response returned to the TS side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TauriHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::Method;
    use std::time::Duration;

    fn request(method: &str, timeout_ms: Option<u64>) -> TauriHttpRequest {
        TauriHttpRequest {
            url: "https://example.com".to_string(),
            method: method.to_string(),
            headers: None,
            body: None,
            timeout_ms,
        }
    }

    #[test]
    fn validated_method_accepts_contract_methods_case_insensitively() {
        assert_eq!(
            request("get", None).validated_method().unwrap(),
            Method::GET
        );
        assert_eq!(
            request("POST", None).validated_method().unwrap(),
            Method::POST
        );
        assert_eq!(
            request(" patch ", None).validated_method().unwrap(),
            Method::PATCH
        );
        assert_eq!(
            request("DELETE", None).validated_method().unwrap(),
            Method::DELETE
        );
    }

    #[test]
    fn validated_method_rejects_methods_outside_frontend_contract() {
        let err = request("TRACE\r\nX-Injected: 1", None)
            .validated_method()
            .unwrap_err();

        assert_eq!(err, "unsupported HTTP method: TRACE X-Injected: 1");
        assert!(!err.contains('\r'));
        assert!(!err.contains('\n'));
    }

    #[test]
    fn timeout_duration_defaults_and_bounds_untrusted_values() {
        assert_eq!(
            request("GET", None).timeout_duration(),
            Duration::from_millis(DEFAULT_HTTP_TIMEOUT_MS)
        );
        assert_eq!(
            request("GET", Some(0)).timeout_duration(),
            Duration::from_millis(1)
        );
        assert_eq!(
            request("GET", Some(MAX_HTTP_TIMEOUT_MS + 1)).timeout_duration(),
            Duration::from_millis(MAX_HTTP_TIMEOUT_MS)
        );
    }
}
