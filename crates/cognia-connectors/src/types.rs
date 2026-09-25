use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The request/response pair behind `connectors_http_request`. They live in
/// `cognia_net::http_client` (ADR-0196), shared with the plugin runtime's
/// `network:fetch` bridge, which no longer has to link this crate for them.
pub use cognia_net::http_client::{
    HttpRequest as TauriHttpRequest, HttpResponse as TauriHttpResponse,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterRegistration {
    pub adapter_id: String,
    pub adapter_type: String,
    pub webhook_path: Option<String>,
    /// How to prove an inbound webhook really came from this adapter's
    /// platform, for kinds this crate has no built-in verifier for.
    ///
    /// The four native webhook platforms (telegram, slack, discord, lark) are
    /// verified by their own hand-written arms and leave this `None`. A plugin
    /// connector has no arm, so before this existed every inbound POST for one
    /// was answered `400 unsupported adapter type` and a plugin could not
    /// receive over webhook at all.
    ///
    /// `serde(default)` keeps the wire shape backward compatible: a paired
    /// desktop on an older build sends a registration without this field.
    #[serde(default)]
    pub verification: Option<crate::sigverify::declarative::WebhookVerificationSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorsHealth {
    pub server_running: bool,
    pub bound_addr: Option<String>,
    pub registered_adapter_count: usize,
    /// Bearer for `POST /internal/lark/app-avatar` (appPreset.avatar staging).
    /// Deserialization tolerates its absence so a response produced by an
    /// older host still parses; callers treat a missing token as "avatar
    /// staging unsupported" and skip the param.
    #[serde(default)]
    pub staging_token: Option<String>,
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
    pub multipart: Option<ConnectorMediaMultipart>,
    pub response_mode: Option<MediaUploadResponseMode>,
}

/// One binary file plus platform-defined text fields, sent as multipart/form-data.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorMediaMultipart {
    pub field_name: String,
    pub filename: String,
    #[serde(default)]
    pub fields: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaUploadResponseMode {
    ContentUri,
    Http,
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
            multipart: None,
            response_mode: None,
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
    #[test]
    fn media_upload_optional_modes_preserve_legacy_requests() {
        let req: super::ConnectorMediaUploadRequest = serde_json::from_str(
            r#"{"uploadUrl":"https://example.com/upload","localPath":"/tmp/file"}"#,
        )
        .unwrap();
        assert!(req.multipart.is_none());
        assert!(req.response_mode.is_none());
        let matrix: super::MatrixEncryptedMediaUploadRequest = serde_json::from_str(
            r#"{"uploadUrl":"https://example.com/upload","localPath":"/tmp/file","multipart":{"fieldName":"x","filename":"f"},"responseMode":"http"}"#).unwrap();
        let req: super::ConnectorMediaUploadRequest = matrix.into();
        assert!(req.multipart.is_none());
        assert!(req.response_mode.is_none());
        assert!(serde_json::from_str::<super::ConnectorMediaUploadRequest>(
            r#"{"uploadUrl":"https://example.com","responseMode":"unknown"}"#
        )
        .is_err());
    }
}
