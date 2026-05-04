//! Wire-shape types for the MCP HTTP server subsystem.
//!
//! Field names use camelCase so serde matches the TypeScript-side definitions
//! in `types/wiki/index.ts` verbatim.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Mirror of the TypeScript `ExternalBridgeSettings` shape.
/// Passed in as serialised JSON from the Tauri command layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBridgeSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearer_token: Option<String>,
    pub enabled_scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_rotated_at: Option<u64>,
}

/// Live status returned by `mcp_server_status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    /// Whether the HTTP listener is currently bound and accepting requests.
    pub running: bool,
    /// The port the listener is bound to, if running.
    pub port: Option<u16>,
    /// ISO-8601 timestamp of when the server was last started.
    pub started_at: Option<String>,
}

impl Default for McpServerStatus {
    fn default() -> Self {
        Self {
            running: false,
            port: None,
            started_at: None,
        }
    }
}

/// Errors that the MCP server commands surface to the renderer.
#[derive(Debug, Error)]
pub enum McpServerError {
    #[error("MCP server is already running on port {0}")]
    AlreadyRunning(u16),

    #[error("MCP server is not running")]
    NotRunning,

    #[error("server bind failed on 127.0.0.1:{port}: {source}")]
    Bind {
        port: u16,
        #[source]
        source: std::io::Error,
    },

    #[error("invalid settings JSON: {0}")]
    InvalidSettings(String),

    #[error("bearer token is required but was not supplied")]
    TokenMissing,

    #[error("sidecar spawn failed: {0}")]
    SidecarSpawn(String),

    #[error("sidecar I/O error: {0}")]
    SidecarIo(String),
}

impl serde::Serialize for McpServerError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_status_is_inactive() {
        let s = McpServerStatus::default();
        assert!(!s.running);
        assert!(s.port.is_none());
        assert!(s.started_at.is_none());
    }

    #[test]
    fn error_serializes_as_string() {
        let err = McpServerError::NotRunning;
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"MCP server is not running\"");
    }

    #[test]
    fn settings_round_trips_through_serde() {
        let settings = ExternalBridgeSettings {
            enabled: true,
            bearer_token: Some("abc123".to_string()),
            enabled_scopes: vec!["wiki".to_string()],
            http_port: Some(47920),
            token_rotated_at: None,
        };
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(json.contains("\"bearerToken\":\"abc123\""));
        assert!(json.contains("\"httpPort\":47920"));
        let parsed: ExternalBridgeSettings = serde_json::from_str(&json).expect("parse");
        assert_eq!(parsed.http_port, Some(47920));
        assert!(parsed.enabled);
    }

    #[test]
    fn settings_optional_fields_omitted_when_none() {
        let settings = ExternalBridgeSettings {
            enabled: false,
            bearer_token: None,
            enabled_scopes: vec![],
            http_port: None,
            token_rotated_at: None,
        };
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(!json.contains("bearerToken"));
        assert!(!json.contains("httpPort"));
    }
}
