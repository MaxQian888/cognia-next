//! Gateway config/status/error types. Field names serialize camelCase to
//! mirror `types/gateway/index.ts` on the renderer side.

use serde::{Deserialize, Serialize};

fn default_port() -> u16 {
    47823
}

fn default_allowlist() -> Vec<String> {
    vec!["127.0.0.1/32".to_string()]
}

fn default_rate_limit() -> u32 {
    600
}

/// Persisted gateway configuration (renderer-owned; pushed via
/// `gateway_set_config`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConfig {
    /// Whether the listener should run (auto-started at boot when a token
    /// exists).
    pub enabled: bool,
    /// TCP port on 127.0.0.1; 0 = OS-assigned ephemeral.
    #[serde(default = "default_port")]
    pub port: u16,
    /// IPv4 allowlist (CIDR strings), defence-in-depth behind the loopback
    /// bind.
    #[serde(default = "default_allowlist")]
    pub allowlist: Vec<String>,
    /// Fixed-window per-minute request budget. Chat is chatty — default 600.
    #[serde(default = "default_rate_limit")]
    pub rate_limit_per_min: u32,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_port(),
            allowlist: default_allowlist(),
            rate_limit_per_min: default_rate_limit(),
        }
    }
}

/// Live status surfaced to the settings UI.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub running: bool,
    pub bound_port: Option<u16>,
    pub has_token: bool,
    pub calls_total: u64,
    pub last_call_at: Option<String>,
    /// When the routing snapshot was last pushed by the renderer (ms epoch).
    pub snapshot_generated_at_ms: Option<i64>,
    pub snapshot_provider_count: u32,
    pub snapshot_alias_count: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("failed to bind 127.0.0.1:{port}: {source}")]
    Bind {
        port: u16,
        #[source]
        source: std::io::Error,
    },
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("no gateway token — generate one in Settings first")]
    TokenMissing,
    #[error("gateway already running on port {0}")]
    AlreadyRunning(u16),
    #[error("gateway is not running")]
    NotRunning,
    #[error("invalid config: {0}")]
    InvalidConfig(String),
}

impl From<GatewayError> for String {
    fn from(e: GatewayError) -> Self {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_loopback_only_and_off() {
        let cfg = GatewayConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.port, 47823);
        assert_eq!(cfg.allowlist, vec!["127.0.0.1/32".to_string()]);
        assert_eq!(cfg.rate_limit_per_min, 600);
    }

    #[test]
    fn config_round_trips_camel_case() {
        let cfg = GatewayConfig {
            enabled: true,
            port: 50001,
            allowlist: vec!["127.0.0.1/32".into()],
            rate_limit_per_min: 120,
        };
        let json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(json["rateLimitPerMin"], 120);
        let back: GatewayConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.port, 50001);
    }

    #[test]
    fn partial_config_fills_defaults() {
        let back: GatewayConfig = serde_json::from_value(serde_json::json!({
            "enabled": true
        }))
        .unwrap();
        assert_eq!(back.port, 47823);
        assert_eq!(back.rate_limit_per_min, 600);
    }

    #[test]
    fn errors_stringify_clearly() {
        assert!(String::from(GatewayError::TokenMissing).contains("token"));
        assert!(String::from(GatewayError::AlreadyRunning(1)).contains('1'));
    }
}
