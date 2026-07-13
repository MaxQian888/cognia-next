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

fn default_connect_timeout_secs() -> u32 {
    30
}

fn default_request_timeout_secs() -> u32 {
    300
}

fn default_retry_status_codes() -> Vec<u16> {
    vec![408, 409, 429, 500, 502, 503, 504]
}

/// Which network interface the listener binds to.
///
/// `Loopback` (default) binds `127.0.0.1` — only same-machine processes can
/// reach it. `Lan` binds `0.0.0.0` so other devices on the local network can
/// use this gateway; the loopback Host-header check is skipped for LAN peers,
/// but every other defence (cross-origin rejection, IPv4 allowlist, API-key
/// auth, rate limit) still applies. LAN peers must additionally be admitted by
/// the allowlist, which defaults to loopback-only — so flipping this to `Lan`
/// alone exposes nothing until the allowlist is widened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BindInterface {
    #[default]
    Loopback,
    Lan,
}

impl BindInterface {
    pub fn is_lan(self) -> bool {
        matches!(self, BindInterface::Lan)
    }
}

/// Persisted gateway configuration (renderer-owned; pushed via
/// `gateway_set_config`, mirrored to `<app_data>/cognia/gateway-config.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConfig {
    /// Whether the listener should run (auto-started at boot when a key
    /// exists).
    pub enabled: bool,
    /// TCP port; 0 = OS-assigned ephemeral.
    #[serde(default = "default_port")]
    pub port: u16,
    /// IPv4 allowlist (CIDR strings), defence-in-depth behind the bind.
    #[serde(default = "default_allowlist")]
    pub allowlist: Vec<String>,
    /// Fixed-window per-minute request budget. Chat is chatty — default 600.
    #[serde(default = "default_rate_limit")]
    pub rate_limit_per_min: u32,
    /// Interface the listener binds to. See [`BindInterface`].
    #[serde(default)]
    pub bind_interface: BindInterface,
    /// Upstream TCP+TLS connect timeout in seconds. Bounds a hung *connect*
    /// on every request (streaming included) without killing a long stream.
    #[serde(default = "default_connect_timeout_secs")]
    pub connect_timeout_secs: u32,
    /// Total upstream timeout in seconds, applied to NON-streaming requests
    /// only (embeddings, responses, buffered chat). `0` disables it. Streaming
    /// responses intentionally get no total cap — only the connect timeout.
    #[serde(default = "default_request_timeout_secs")]
    pub request_timeout_secs: u32,
    /// Maximum number of candidate attempts before giving up. `0` = walk the
    /// entire fallback chain (previous behaviour).
    #[serde(default)]
    pub max_retries: u32,
    /// Upstream HTTP statuses that advance the failover walk to the next
    /// candidate instead of surfacing immediately (transient / upstream-side).
    #[serde(default = "default_retry_status_codes")]
    pub retry_status_codes: Vec<u16>,
    /// Allowlist of model/alias ids the gateway advertises AND serves. Empty =
    /// expose everything. A request for a model outside this list resolves to
    /// no candidate (404).
    #[serde(default)]
    pub exposed_models: Vec<String>,
    /// When true, `/v1/models` lists only routing aliases (not each provider's
    /// raw model ids). Direct `provider:model` literals still resolve.
    #[serde(default)]
    pub hide_raw_provider_models: bool,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_port(),
            allowlist: default_allowlist(),
            rate_limit_per_min: default_rate_limit(),
            bind_interface: BindInterface::default(),
            connect_timeout_secs: default_connect_timeout_secs(),
            request_timeout_secs: default_request_timeout_secs(),
            max_retries: 0,
            retry_status_codes: default_retry_status_codes(),
            exposed_models: Vec::new(),
            hide_raw_provider_models: false,
        }
    }
}

impl GatewayConfig {
    pub fn validate(&self) -> Result<(), GatewayError> {
        cognia_remote_control::allowlist::ParsedAllowlist::parse(&self.allowlist)
            .map_err(GatewayError::InvalidConfig)?;
        if self.rate_limit_per_min == 0 {
            return Err(GatewayError::InvalidConfig(
                "rate limit must be greater than zero".into(),
            ));
        }
        if self.connect_timeout_secs == 0 {
            return Err(GatewayError::InvalidConfig(
                "connect timeout must be greater than zero".into(),
            ));
        }
        Ok(())
    }

    /// Whether a failed attempt with `status` should advance the failover
    /// walk (transient / upstream-side) rather than surface to the caller.
    pub fn should_retry(&self, status: u16) -> bool {
        self.retry_status_codes.contains(&status)
    }

    /// How many candidates to attempt for `available` resolved candidates,
    /// honouring `max_retries` (`0` = all).
    pub fn attempt_budget(&self, available: usize) -> usize {
        if self.max_retries == 0 {
            available
        } else {
            available.min(self.max_retries as usize)
        }
    }

    /// Whether a requested model/alias id is exposed by this gateway. Empty
    /// `exposed_models` exposes everything.
    pub fn model_is_exposed(&self, model: &str) -> bool {
        if self.exposed_models.is_empty() {
            return true;
        }
        self.exposed_models.iter().any(|m| m == model)
    }
}

/// Live status surfaced to the settings UI.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub running: bool,
    pub bound_port: Option<u16>,
    /// Whether at least one API key exists (usable or not — the UI decides).
    pub has_token: bool,
    /// Interface the running (or last-configured) listener binds to.
    pub bind_interface: BindInterface,
    pub calls_total: u64,
    pub last_call_at: Option<String>,
    /// When the routing snapshot was last pushed by the renderer (ms epoch).
    pub snapshot_generated_at_ms: Option<i64>,
    pub snapshot_provider_count: u32,
    pub snapshot_alias_count: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("failed to bind {addr}: {source}")]
    Bind {
        addr: String,
        #[source]
        source: std::io::Error,
    },
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("no gateway key — generate one in Settings first")]
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
        assert_eq!(cfg.bind_interface, BindInterface::Loopback);
        assert_eq!(cfg.connect_timeout_secs, 30);
        assert_eq!(cfg.request_timeout_secs, 300);
        assert_eq!(cfg.max_retries, 0);
        assert!(cfg.retry_status_codes.contains(&429));
        assert!(cfg.exposed_models.is_empty());
        assert!(!cfg.hide_raw_provider_models);
    }

    #[test]
    fn config_round_trips_camel_case() {
        let cfg = GatewayConfig {
            enabled: true,
            port: 50001,
            allowlist: vec!["127.0.0.1/32".into()],
            rate_limit_per_min: 120,
            bind_interface: BindInterface::Lan,
            connect_timeout_secs: 10,
            request_timeout_secs: 0,
            max_retries: 2,
            retry_status_codes: vec![429, 503],
            exposed_models: vec!["fast".into()],
            hide_raw_provider_models: true,
        };
        let json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(json["rateLimitPerMin"], 120);
        assert_eq!(json["bindInterface"], "lan");
        assert_eq!(json["connectTimeoutSecs"], 10);
        assert_eq!(json["requestTimeoutSecs"], 0);
        assert_eq!(json["maxRetries"], 2);
        assert_eq!(json["hideRawProviderModels"], true);
        let back: GatewayConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.port, 50001);
        assert_eq!(back.bind_interface, BindInterface::Lan);
        assert_eq!(back.exposed_models, vec!["fast".to_string()]);
    }

    #[test]
    fn partial_config_fills_defaults() {
        let back: GatewayConfig = serde_json::from_value(serde_json::json!({
            "enabled": true
        }))
        .unwrap();
        assert_eq!(back.port, 47823);
        assert_eq!(back.rate_limit_per_min, 600);
        assert_eq!(back.bind_interface, BindInterface::Loopback);
        assert_eq!(back.request_timeout_secs, 300);
        assert_eq!(back.retry_status_codes, default_retry_status_codes());
    }

    #[test]
    fn config_validation_rejects_invalid_allowlist_entries() {
        let mut cfg = GatewayConfig::default();
        cfg.allowlist = vec!["not-a-cidr".into()];

        let err = cfg.validate().unwrap_err();

        assert!(err.to_string().contains("allowlist"));
    }

    #[test]
    fn config_validation_rejects_zero_rate_limit() {
        let mut cfg = GatewayConfig::default();
        cfg.rate_limit_per_min = 0;

        let err = cfg.validate().unwrap_err();

        assert!(err.to_string().contains("rate limit"));
    }

    #[test]
    fn config_validation_rejects_zero_connect_timeout() {
        let mut cfg = GatewayConfig::default();
        cfg.connect_timeout_secs = 0;

        let err = cfg.validate().unwrap_err();

        assert!(err.to_string().contains("connect timeout"));
    }

    #[test]
    fn should_retry_follows_the_configured_list() {
        let mut cfg = GatewayConfig::default();
        assert!(cfg.should_retry(429));
        assert!(cfg.should_retry(503));
        assert!(!cfg.should_retry(400));
        assert!(!cfg.should_retry(401));
        cfg.retry_status_codes = vec![418];
        assert!(cfg.should_retry(418));
        assert!(!cfg.should_retry(429));
    }

    #[test]
    fn attempt_budget_caps_by_max_retries() {
        let mut cfg = GatewayConfig::default();
        assert_eq!(cfg.attempt_budget(5), 5); // 0 = all
        cfg.max_retries = 2;
        assert_eq!(cfg.attempt_budget(5), 2);
        assert_eq!(cfg.attempt_budget(1), 1);
    }

    #[test]
    fn model_exposure_allowlist_gates() {
        let mut cfg = GatewayConfig::default();
        assert!(cfg.model_is_exposed("anything")); // empty = all
        cfg.exposed_models = vec!["fast".into(), "gpt-4o".into()];
        assert!(cfg.model_is_exposed("fast"));
        assert!(!cfg.model_is_exposed("secret-model"));
    }

    #[test]
    fn errors_stringify_clearly() {
        assert!(String::from(GatewayError::TokenMissing).contains("key"));
        assert!(String::from(GatewayError::AlreadyRunning(1)).contains('1'));
    }
}
