//! Wire-shape types shared between the renderer (`@/types/remote-control`)
//! and the axum HTTP server. Field names use camelCase so serde matches the
//! TS-side definitions verbatim — no translation step needed.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Token capability — mirrors the TS `TokenCapability`. `Read` permits only
/// the health route; `Write` permits the trigger routes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Read,
    Write,
}

impl Default for Capability {
    fn default() -> Self {
        Capability::Write
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlInboundConfig {
    pub enabled: bool,
    pub port: u16,
    pub allowlist: Vec<String>,
    pub rate_limit_per_min: u32,
    /// Token capability gate. `#[serde(default)]` so configs persisted before
    /// this field existed deserialize as `Write`.
    #[serde(default)]
    pub capability: Capability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlOutboundHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlOutboundConfig {
    pub has_signing_secret: bool,
    pub default_headers: Vec<RemoteControlOutboundHeader>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlConfig {
    pub inbound: RemoteControlInboundConfig,
    pub outbound: RemoteControlOutboundConfig,
}

impl Default for RemoteControlConfig {
    fn default() -> Self {
        Self {
            inbound: RemoteControlInboundConfig {
                enabled: false,
                port: 47821,
                allowlist: vec!["127.0.0.1/32".to_string()],
                rate_limit_per_min: 60,
                capability: Capability::Write,
            },
            outbound: RemoteControlOutboundConfig {
                has_signing_secret: false,
                default_headers: Vec::new(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStatus {
    pub inbound_running: bool,
    pub bound_port: Option<u16>,
    pub last_call_at: Option<String>,
    pub inbound_calls_total: u64,
    pub has_inbound_token: bool,
}

impl Default for RemoteControlStatus {
    fn default() -> Self {
        Self {
            inbound_running: false,
            bound_port: None,
            last_call_at: None,
            inbound_calls_total: 0,
            has_inbound_token: false,
        }
    }
}

/// Body of `POST /api/v1/tasks/:id/run`.
#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TriggerTaskRequestBody {
    pub payload: Option<serde_json::Value>,
}

/// Body of `POST /api/v1/events`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmitEventRequestBody {
    pub event_type: String,
    pub event_source: Option<String>,
    pub data: Option<serde_json::Value>,
}

/// Body of `POST /api/v1/commands/:target`. `args` is free-form — each
/// renderer-side handler validates its own required shape.
#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandRequestBody {
    #[serde(default)]
    pub args: serde_json::Value,
}

/// Payload emitted to the renderer on `remote-control://command`. The renderer
/// dispatch registry routes by `target` into each subsystem's run entry.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandEvent {
    pub target: String,
    pub args: serde_json::Value,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

/// Payload emitted to the renderer on `remote-control://run-task`.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskEvent {
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

/// Payload emitted to the renderer on `remote-control://emit-event`.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmitEvent {
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Error)]
pub enum RemoteControlError {
    #[error("inbound listener already running on {0}")]
    AlreadyRunning(u16),
    #[error("inbound listener is not running")]
    NotRunning,
    #[error("inbound token not configured — call rotate_token first")]
    TokenMissing,
    #[error("keyring access failed: {0}")]
    Keyring(String),
    #[error("server bind failed on 127.0.0.1:{port}: {source}")]
    Bind {
        port: u16,
        #[source]
        source: std::io::Error,
    },
    #[allow(dead_code)] // reserved for the persistence layer (#10 follow-up)
    #[error("config persistence failed: {0}")]
    Persist(String),
    #[error("invalid config: {0}")]
    InvalidConfig(String),
}

impl serde::Serialize for RemoteControlError {
    // Tauri commands serialize errors as strings — match the rest of the code
    // base (`tts::keyring`, `scheduler::commands`).
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
    fn default_config_is_loopback_only() {
        let cfg = RemoteControlConfig::default();
        assert!(!cfg.inbound.enabled);
        assert_eq!(cfg.inbound.port, 47821);
        assert_eq!(cfg.inbound.allowlist, vec!["127.0.0.1/32"]);
        assert_eq!(cfg.inbound.rate_limit_per_min, 60);
        assert!(!cfg.outbound.has_signing_secret);
        assert!(cfg.outbound.default_headers.is_empty());
    }

    #[test]
    fn default_status_is_inactive() {
        let s = RemoteControlStatus::default();
        assert!(!s.inbound_running);
        assert!(s.bound_port.is_none());
        assert_eq!(s.inbound_calls_total, 0);
        assert!(!s.has_inbound_token);
    }

    #[test]
    fn config_round_trips_through_serde() {
        let cfg = RemoteControlConfig::default();
        let json = serde_json::to_string(&cfg).expect("serialize");
        // Camelcase should be preserved.
        assert!(json.contains("\"rateLimitPerMin\":60"));
        assert!(json.contains("\"hasSigningSecret\":false"));
        let parsed: RemoteControlConfig = serde_json::from_str(&json).expect("parse");
        assert_eq!(parsed.inbound.port, cfg.inbound.port);
    }

    #[test]
    fn error_serializes_as_message_string() {
        let err = RemoteControlError::TokenMissing;
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"inbound token not configured — call rotate_token first\"");
    }
}
