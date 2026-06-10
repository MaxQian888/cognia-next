use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

/// The HTTP response returned to the TS side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TauriHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}
