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
    /// Opt-in for user-configured self-hosted endpoints. Defaults to strict
    /// platform trust; callers must never enable this implicitly.
    pub allow_invalid_certificates: Option<bool>,
}

impl TauriHttpRequest {
    pub fn validated_method(&self) -> Result<Method, String> {
        match self.method.trim().to_ascii_uppercase().as_str() {
            "GET" => Ok(Method::GET),
            "POST" => Ok(Method::POST),
            "PUT" => Ok(Method::PUT),
            "PATCH" => Ok(Method::PATCH),
            "DELETE" => Ok(Method::DELETE),
            "HEAD" => Ok(Method::HEAD),
            "OPTIONS" => Ok(Method::OPTIONS),
            "PROPFIND" => Method::from_bytes(b"PROPFIND")
                .map_err(|error| format!("invalid PROPFIND method: {error}")),
            "MKCOL" => Method::from_bytes(b"MKCOL")
                .map_err(|error| format!("invalid MKCOL method: {error}")),
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

    pub fn accept_invalid_certificates(&self) -> bool {
        self.allow_invalid_certificates.unwrap_or(false)
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

/// Generic binary media upload request used by adapters whose platform wants
/// raw bytes at an upload URL before the message can reference the asset.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorMediaUploadRequest {
    pub upload_url: String,
    pub headers: Option<HashMap<String, String>>,
    pub source_url: Option<String>,
    pub local_path: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixEncryptedMediaUploadRequest {
    pub upload_url: String,
    pub headers: Option<HashMap<String, String>>,
    pub source_url: Option<String>,
    pub local_path: Option<String>,
    pub content_type: Option<String>,
}

impl From<MatrixEncryptedMediaUploadRequest> for ConnectorMediaUploadRequest {
    fn from(value: MatrixEncryptedMediaUploadRequest) -> Self {
        Self {
            upload_url: value.upload_url,
            headers: value.headers,
            source_url: value.source_url,
            local_path: value.local_path,
            content_type: value.content_type,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixEncryptedMediaUploadResponse {
    pub content_uri: String,
    pub file: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixEncryptedMediaFetchRequest {
    pub adapter_id: String,
    pub remote_ref: String,
    pub source_url: String,
    pub headers: Option<HashMap<String, String>>,
    pub file: serde_json::Value,
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
            allow_invalid_certificates: None,
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
    fn validated_method_accepts_webdav_contract_methods() {
        assert_eq!(
            request("PROPFIND", None).validated_method().unwrap(),
            Method::from_bytes(b"PROPFIND").unwrap()
        );
        assert_eq!(
            request("mkcol", None).validated_method().unwrap(),
            Method::from_bytes(b"MKCOL").unwrap()
        );
        assert_eq!(
            request("HEAD", None).validated_method().unwrap(),
            Method::HEAD
        );
        assert_eq!(
            request("OPTIONS", None).validated_method().unwrap(),
            Method::OPTIONS
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

    #[test]
    fn invalid_certificate_acceptance_is_explicit_and_defaults_off() {
        assert!(!request("GET", None).accept_invalid_certificates());

        let enabled: TauriHttpRequest = serde_json::from_value(serde_json::json!({
            "url": "https://nas.example",
            "method": "GET",
            "allowInvalidCertificates": true
        }))
        .unwrap();
        assert!(enabled.accept_invalid_certificates());
    }
}
