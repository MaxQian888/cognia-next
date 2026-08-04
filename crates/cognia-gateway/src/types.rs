//! Gateway config/status/error types. Field names serialize camelCase to
//! mirror `types/gateway/index.ts` on the renderer side.

use serde::{Deserialize, Serialize};
use std::time::Duration;

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

fn default_retry_backoff_base_ms() -> u32 {
    250
}

fn default_retry_backoff_max_ms() -> u32 {
    4_000
}

fn default_max_retry_wait_ms() -> u32 {
    60_000
}

fn default_true() -> bool {
    true
}

fn default_cooldown_fallback_secs() -> u32 {
    20
}

fn default_overload_cooldown_secs() -> u32 {
    600
}

fn default_disable_keywords() -> Vec<String> {
    vec![
        "insufficient_quota".to_string(),
        "organization has been disabled".to_string(),
        "deactivated_workspace".to_string(),
        "account_deactivated".to_string(),
    ]
}

fn default_concurrency_wait_ms() -> u32 {
    10_000
}

fn default_stream_idle_timeout_secs() -> u32 {
    300
}

fn default_stripped_request_fields() -> Vec<String> {
    vec![
        "service_tier".to_string(),
        "store".to_string(),
        "safety_identifier".to_string(),
        "stream_options.include_obfuscation".to_string(),
    ]
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
    #[serde(default = "default_retry_backoff_base_ms")]
    pub retry_backoff_base_ms: u32,
    #[serde(default = "default_retry_backoff_max_ms")]
    pub retry_backoff_max_ms: u32,
    #[serde(default = "default_max_retry_wait_ms")]
    pub max_retry_wait_ms: u32,
    #[serde(default = "default_true")]
    pub respect_retry_after: bool,
    #[serde(default = "default_true")]
    pub gateway_local_routing_v2: bool,
    /// Allowlist of model/alias ids the gateway advertises AND serves. Empty =
    /// expose everything. A request for a model outside this list resolves to
    /// no candidate (404).
    #[serde(default)]
    pub exposed_models: Vec<String>,
    /// When true, `/v1/models` lists only routing aliases (not each provider's
    /// raw model ids). Direct `provider:model` literals still resolve.
    #[serde(default)]
    pub hide_raw_provider_models: bool,

    // ---- W1.1 upstream cooldown (per pooled key) ----------------------------
    /// Cooldown (seconds) applied to a pooled key that returned 429 WITHOUT a
    /// parseable `Retry-After` / `anthropic-ratelimit-unified-reset` header, so
    /// the failover walk stops immediately re-selecting a just-limited account.
    /// `0` disables the header-less fallback (only header-derived cooldowns
    /// apply). Header-derived cooldowns are always honoured.
    #[serde(default = "default_cooldown_fallback_secs")]
    pub cooldown_fallback_secs: u32,
    /// Cooldown (seconds) applied on a 529 "overloaded" with no recovery header.
    #[serde(default = "default_overload_cooldown_secs")]
    pub overload_cooldown_secs: u32,

    // ---- W3.1 permanent key disable -----------------------------------------
    /// Case-insensitive substrings that, when present in a failing upstream
    /// body, mark the pooled key PERMANENTLY disabled (quota exhausted / org
    /// disabled) rather than merely cooled. A 401 is always permanent.
    #[serde(default = "default_disable_keywords")]
    pub disable_keywords: Vec<String>,

    // ---- W1.2 in-flight concurrency caps ------------------------------------
    /// Max simultaneous in-flight requests per gateway API key. `0` = unlimited.
    #[serde(default)]
    pub max_concurrent_per_key: u32,
    /// Max simultaneous in-flight upstream calls per pooled upstream key.
    /// `0` = unlimited.
    #[serde(default)]
    pub max_concurrent_per_upstream_key: u32,
    /// How long (ms) a request waits for a concurrency slot before it is
    /// rejected with 429. `0` = reject immediately (no queueing).
    #[serde(default = "default_concurrency_wait_ms")]
    pub concurrency_wait_ms: u32,
    /// How long (seconds) an SSE pump tolerates TOTAL silence from the upstream
    /// before abandoning the stream. `0` = wait forever.
    ///
    /// Streaming deliberately skips `request_timeout_secs` (a long generation is
    /// not a hung one) and reqwest sets no read timeout, so without this an
    /// upstream that accepts the connection and then never writes or closes
    /// parks the pump task forever — holding its concurrency slots AND its
    /// in-flight tally, which drives least-busy routing. Both upstream protocols
    /// emit keepalives far more often than the 300 s default, so it fires only
    /// on a genuinely dead connection. Setting `0` restores the old
    /// park-forever behaviour and is not recommended.
    #[serde(default = "default_stream_idle_timeout_secs")]
    pub stream_idle_timeout_secs: u32,

    // ---- W3.2 outbound field stripping --------------------------------------
    /// Dotted-path fields stripped from every upstream request body (billing /
    /// privacy / behaviour toggles the client must not control).
    #[serde(default = "default_stripped_request_fields")]
    pub stripped_request_fields: Vec<String>,
    /// Per-provider re-permits for stripped fields, as `"providerId:field"`
    /// entries. A match leaves that field intact for that provider only.
    #[serde(default)]
    pub field_strip_allow: Vec<String>,
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
            retry_backoff_base_ms: default_retry_backoff_base_ms(),
            retry_backoff_max_ms: default_retry_backoff_max_ms(),
            max_retry_wait_ms: default_max_retry_wait_ms(),
            respect_retry_after: true,
            gateway_local_routing_v2: true,
            exposed_models: Vec::new(),
            hide_raw_provider_models: false,
            cooldown_fallback_secs: default_cooldown_fallback_secs(),
            overload_cooldown_secs: default_overload_cooldown_secs(),
            disable_keywords: default_disable_keywords(),
            max_concurrent_per_key: 0,
            max_concurrent_per_upstream_key: 0,
            concurrency_wait_ms: default_concurrency_wait_ms(),
            stream_idle_timeout_secs: default_stream_idle_timeout_secs(),
            stripped_request_fields: default_stripped_request_fields(),
            field_strip_allow: Vec::new(),
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
        if self.retry_backoff_base_ms > self.retry_backoff_max_ms {
            return Err(GatewayError::InvalidConfig(
                "retry backoff base must not exceed retry backoff max".into(),
            ));
        }
        Ok(())
    }

    /// How long an SSE pump waits on a silent upstream before abandoning it.
    /// `None` when configured to `0` (wait forever — the pre-timeout
    /// behaviour, which leaks concurrency slots and in-flight tally).
    pub fn stream_idle_timeout(&self) -> Option<Duration> {
        if self.stream_idle_timeout_secs == 0 {
            None
        } else {
            Some(Duration::from_secs(self.stream_idle_timeout_secs as u64))
        }
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
    pub routing_policy_revision: Option<String>,
    pub routing_strategy: Option<String>,
    pub routing_strategy_unavailable: Option<String>,
    pub local_routing_enabled: bool,
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
        assert_eq!(cfg.retry_backoff_base_ms, 250);
        assert_eq!(cfg.retry_backoff_max_ms, 4_000);
        assert_eq!(cfg.max_retry_wait_ms, 60_000);
        assert!(cfg.respect_retry_after);
        assert!(cfg.exposed_models.is_empty());
        assert!(!cfg.hide_raw_provider_models);
        assert_eq!(cfg.cooldown_fallback_secs, 20);
        assert_eq!(cfg.overload_cooldown_secs, 600);
        assert!(cfg
            .disable_keywords
            .iter()
            .any(|k| k == "insufficient_quota"));
        assert_eq!(cfg.max_concurrent_per_key, 0);
        assert_eq!(cfg.max_concurrent_per_upstream_key, 0);
        assert_eq!(cfg.concurrency_wait_ms, 10_000);
        assert_eq!(cfg.stream_idle_timeout_secs, 300);
        assert!(cfg
            .stripped_request_fields
            .iter()
            .any(|f| f == "service_tier"));
        assert!(cfg.field_strip_allow.is_empty());
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
            retry_backoff_base_ms: 100,
            retry_backoff_max_ms: 2_000,
            max_retry_wait_ms: 30_000,
            respect_retry_after: true,
            gateway_local_routing_v2: false,
            exposed_models: vec!["fast".into()],
            hide_raw_provider_models: true,
            cooldown_fallback_secs: 15,
            overload_cooldown_secs: 300,
            disable_keywords: vec!["insufficient_quota".into()],
            max_concurrent_per_key: 4,
            max_concurrent_per_upstream_key: 2,
            concurrency_wait_ms: 5_000,
            stream_idle_timeout_secs: 90,
            stripped_request_fields: vec!["service_tier".into()],
            field_strip_allow: vec!["openai:service_tier".into()],
        };
        let json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(json["rateLimitPerMin"], 120);
        assert_eq!(json["bindInterface"], "lan");
        assert_eq!(json["connectTimeoutSecs"], 10);
        assert_eq!(json["requestTimeoutSecs"], 0);
        assert_eq!(json["maxRetries"], 2);
        assert_eq!(json["gatewayLocalRoutingV2"], false);
        assert_eq!(json["hideRawProviderModels"], true);
        assert_eq!(json["cooldownFallbackSecs"], 15);
        assert_eq!(json["overloadCooldownSecs"], 300);
        assert_eq!(json["maxConcurrentPerKey"], 4);
        assert_eq!(json["maxConcurrentPerUpstreamKey"], 2);
        assert_eq!(json["concurrencyWaitMs"], 5_000);
        assert_eq!(json["streamIdleTimeoutSecs"], 90);
        assert_eq!(json["fieldStripAllow"][0], "openai:service_tier");
        let back: GatewayConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.port, 50001);
        assert_eq!(back.bind_interface, BindInterface::Lan);
        assert_eq!(back.exposed_models, vec!["fast".to_string()]);
        assert_eq!(back.max_concurrent_per_key, 4);
        assert!(!back.gateway_local_routing_v2);
        assert_eq!(
            back.stripped_request_fields,
            vec!["service_tier".to_string()]
        );
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
        // New W1/W3 fields fill their defaults when absent from the JSON.
        assert_eq!(back.cooldown_fallback_secs, 20);
        assert_eq!(back.overload_cooldown_secs, 600);
        assert_eq!(back.concurrency_wait_ms, 10_000);
        // A config written before the field existed must still get the bounded
        // idle timeout — defaulting it to 0 would silently restore the
        // park-forever pump for every existing install.
        assert_eq!(back.stream_idle_timeout_secs, 300);
        assert!(back.stripped_request_fields.iter().any(|f| f == "store"));
        assert!(back
            .disable_keywords
            .iter()
            .any(|k| k == "account_deactivated"));
    }

    #[test]
    fn stream_idle_timeout_maps_zero_to_wait_forever() {
        let mut cfg = GatewayConfig::default();
        assert_eq!(cfg.stream_idle_timeout(), Some(Duration::from_secs(300)));

        cfg.stream_idle_timeout_secs = 45;
        assert_eq!(cfg.stream_idle_timeout(), Some(Duration::from_secs(45)));

        // `0` is the documented opt-out, not "time out instantly" — an
        // instant timeout would abort every stream before its first byte.
        cfg.stream_idle_timeout_secs = 0;
        assert_eq!(cfg.stream_idle_timeout(), None);
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
