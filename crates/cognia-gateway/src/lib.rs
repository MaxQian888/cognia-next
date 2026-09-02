//! Inbound LLM Gateway subsystem (ADR-0043 M3).
//!
//! A local axum HTTP server that exposes OpenAI- and Anthropic-compatible
//! chat endpoints backed by the user's configured providers + the renderer's
//! routing decisions. External tools (Claude Code CLI, any OpenAI client)
//! point their base URL at `http://127.0.0.1:<port>` (or the LAN IP when LAN
//! binding is enabled) and borrow Cognia's credentials, routing, and
//! reliability telemetry.
//!
//! Layout:
//! - `server` — axum routes + middleware (loopback/LAN Host, no
//!   Origin/Referer, IPv4 allowlist, constant-time key auth, global + per-key
//!   rate limit).
//! - `execute` — candidate resolution + upstream request plumbing.
//! - `translate` — inbound-format ⇄ upstream-protocol translation.
//! - `snapshot` — the routing + credential snapshot pushed by the renderer.
//! - `api_keys` — keyring-backed scoped API keys.
//! - `keyed_rate_limit` — per-key request budget.
//!
//! Config persistence: the non-secret [`GatewayConfig`] is mirrored to
//! `<app_data>/cognia/gateway-config.json` so port / allowlist / timeouts /
//! retry / model exposure / bind interface + the `enabled` auto-start flag
//! survive a restart. Secrets (API keys) live in the OS keyring, never the
//! config file.

pub mod api_keys;
#[cfg(feature = "tauri-host")]
pub mod commands;
pub mod concurrency;
pub mod count_tokens;
pub mod cooldown;
pub mod credentials;
pub mod execute;
pub mod header_policy;
pub mod host;
pub mod keyed_rate_limit;
pub mod lease;
pub mod route_planner;
pub mod route_ticket;
pub mod server;
pub mod session_key;
pub mod snapshot;
pub mod translate;
pub mod types;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::host::GatewayHost;
use parking_lot::{Mutex, RwLock};
use tokio::sync::oneshot;

use api_keys::{ApiKeyPatch, GatewayApiKey, RedactedApiKey};
use concurrency::ConcurrencyLimiter;
use cooldown::{CooldownRow, KeyCooldownMap};
use execute::KeyRotationMap;
use server::{RequestObserver, ServerHandle, UpstreamProbeOutcome, UpstreamProbeResult};
use snapshot::{RoutingSnapshot, SnapshotEntry};

/// Successful [`GatewayState::try_set_snapshot`] ingest.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotAccepted {
    pub profile_version: Option<u64>,
}

/// Rejected snapshot ingest (R3 — no last-writer-wins between authorities).
#[derive(Debug, Clone, thiserror::Error)]
pub enum SnapshotRejected {
    #[error("snapshot is stale: current profileVersion {current}")]
    StaleVersion { current: u64 },
    #[error("authority conflict at profileVersion {current}: refusing same-version overwrite from a different publisher")]
    AuthorityConflict { current: u64 },
    #[error("legacy (unversioned) snapshot refused: a versioned snapshot at profileVersion {current} is live")]
    LegacyOverVersioned { current: u64 },
    #[error("snapshot failed validation: {0}")]
    Invalid(String),
}
use types::{GatewayConfig, GatewayError, GatewayStatus};

/// Pending live-routing decisions keyed by request id. The server registers a
/// oneshot before emitting `gateway://decide`; `gateway_decision_response`
/// resolves it. Entries the renderer never answers are dropped on timeout.
pub type DecisionRegistry = Mutex<HashMap<String, oneshot::Sender<Vec<SnapshotEntry>>>>;

pub struct GatewayState {
    inner: Mutex<GatewayInner>,
    /// Authoritative, hot-shared config. The running server reads request-time
    /// fields (timeouts, retry policy, model exposure) from this on every
    /// request, so an `update_config` takes effect without a restart. Bind-time
    /// fields (port, bind interface, allowlist, connect timeout, global rate
    /// limit) are snapshotted at `start` and need a listener restart to apply.
    config: Arc<RwLock<GatewayConfig>>,
    /// Scoped API keys, shared with the running server's auth middleware so a
    /// key create/revoke lands live. Secrets stay in Rust memory + the keyring.
    keys: Arc<RwLock<Vec<GatewayApiKey>>>,
    /// The last routing+credential snapshot pushed by the renderer.
    snapshot: Arc<RwLock<Option<RoutingSnapshot>>>,
    /// In-flight live-decision round-trips (server ⇄ renderer).
    decisions: Arc<DecisionRegistry>,
    /// Per-provider upstream key-pool rotation cursors (round-robin index +
    /// least-used counts). Shared with the running server so the cursor
    /// advances across requests; process-local, reset on restart.
    key_rotation: Arc<KeyRotationMap>,
    /// Gateway-local V2 alias/Auto distribution cursors.
    route_planner: Arc<route_planner::RoutePlannerState>,
    /// Per-upstream-key cooldown / permanent-disable state (W1.1 + W3.1).
    /// Shared with the running server so a parked key stays parked across
    /// requests; process-local, reset on restart.
    key_cooldown: Arc<KeyCooldownMap>,
    /// In-flight concurrency caps per gateway key / upstream key (W1.2).
    concurrency: Arc<ConcurrencyLimiter>,
    /// Route-ticket registry (ADR-0090 Phase 2). Secrets in memory only;
    /// metadata persisted via the store configured in `hydrate_from_disk`.
    pub tickets: Arc<route_ticket::RouteTicketRegistry>,
    /// Session → credential leases backing ticket affinity (R4).
    pub leases: Arc<lease::CredentialLeaseMap>,
}

struct GatewayInner {
    status: GatewayStatus,
    server: Option<ServerHandle>,
    /// Where the non-secret config is mirrored. Set by `hydrate_from_disk` in
    /// the Tauri setup hook (needs the app-data dir).
    config_path: Option<PathBuf>,
}

fn load_initial_keys(agent_debug: bool) -> Vec<GatewayApiKey> {
    if agent_debug {
        // The agent-debug bridge must become reachable before macOS can show
        // any Keychain authorization UI. Persisted gateway credentials are
        // intentionally unavailable in this opt-in automation process.
        Vec::new()
    } else {
        api_keys::load_keys().unwrap_or_default()
    }
}

impl GatewayState {
    pub fn new() -> Self {
        let mut config = GatewayConfig::default();
        let keys = load_initial_keys(std::env::var_os("COGNIA_AGENT_DEBUG").is_some());
        let now = chrono::Utc::now().timestamp_millis();
        let has_token = api_keys::has_usable_key(&keys, now);
        if !has_token {
            config.enabled = false;
        }
        let status = GatewayStatus {
            has_token,
            bind_interface: config.bind_interface,
            ..Default::default()
        };
        Self {
            inner: Mutex::new(GatewayInner {
                status,
                server: None,
                config_path: None,
            }),
            config: Arc::new(RwLock::new(config)),
            keys: Arc::new(RwLock::new(keys)),
            snapshot: Arc::new(RwLock::new(None)),
            decisions: Arc::new(Mutex::new(HashMap::new())),
            key_rotation: Arc::new(KeyRotationMap::default()),
            route_planner: Arc::new(route_planner::RoutePlannerState::default()),
            key_cooldown: Arc::new(KeyCooldownMap::default()),
            concurrency: Arc::new(ConcurrencyLimiter::default()),
            tickets: Arc::new(route_ticket::RouteTicketRegistry::new(Arc::new(
                route_ticket::InMemoryTicketMetaStore::default(),
            ))),
            leases: Arc::new(lease::CredentialLeaseMap::default()),
        }
    }

    /// Snapshot the current cooling / permanently-disabled upstream keys for the
    /// settings surface (W3.1 visibility). Secrets are fingerprinted, never
    /// returned in full; expired temporary cooldowns are omitted.
    pub fn cooldowns(&self) -> Vec<CooldownRow> {
        let now = chrono::Utc::now().timestamp_millis();
        cooldown::snapshot_rows(&self.key_cooldown, now)
    }

    /// Run the `/healthz/upstream` self-check against the running listener.
    ///
    /// The endpoint itself is loopback-only and the renderer cannot reach it —
    /// the app CSP's `connect-src` admits no loopback origin — so the settings
    /// surface goes through this instead. Probing requires a running server so
    /// the calls draw on the same rotation cursors, cooldown map and in-flight
    /// tally as live traffic; probing a stopped gateway would report against
    /// throwaway state and mislead.
    pub async fn probe_upstream(&self, model: &str) -> Result<Vec<UpstreamProbeResult>, String> {
        // Detach the probe INSIDE the guard's scope, then drop the guard: this
        // is a parking_lot mutex and holding it across the await below would
        // deadlock any concurrent status read.
        let probe = {
            let inner = self.inner.lock();
            inner.server.as_ref().map(|handle| handle.probe_handle())
        };
        let Some(probe) = probe else {
            return Err("gateway is not running".into());
        };
        match probe.run(model).await {
            UpstreamProbeOutcome::NoSnapshot => Err("no routing snapshot yet".into()),
            UpstreamProbeOutcome::NoCandidate => {
                Err(format!("model \"{model}\" resolves to no candidate"))
            }
            UpstreamProbeOutcome::Probed(results) => Ok(results),
        }
    }

    /// Point the state at its on-disk config mirror and load it (Tauri setup
    /// hook). A missing / unreadable file leaves the in-memory defaults. Called
    /// once, before the boot auto-start check.
    pub fn hydrate_from_disk(&self, path: PathBuf) {
        self.inner.lock().config_path = Some(path.clone());
        // Ticket metadata persists beside the config (secrets never do).
        if let Some(dir) = path.parent() {
            self.tickets
                .attach_store(Arc::new(route_ticket::FileTicketMetaStore {
                    path: dir.join("gateway-tickets.json"),
                }));
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return;
        };
        let Ok(mut loaded) = serde_json::from_str::<GatewayConfig>(&raw) else {
            log::warn!(
                "gateway config at {} is corrupt; using defaults",
                path.display()
            );
            return;
        };
        if loaded.validate().is_err() {
            log::warn!(
                "gateway config at {} failed validation; using defaults",
                path.display()
            );
            return;
        }
        // Never auto-start without a usable key even if the file says enabled.
        let now = chrono::Utc::now().timestamp_millis();
        if !api_keys::has_usable_key(&self.keys.read(), now) {
            loaded.enabled = false;
        }
        let bind = loaded.bind_interface;
        *self.config.write() = loaded;
        self.inner.lock().status.bind_interface = bind;
    }

    fn persist_config(&self) {
        let (path, cfg) = {
            let path = self.inner.lock().config_path.clone();
            (path, self.config.read().clone())
        };
        let Some(path) = path else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string_pretty(&cfg) {
            Ok(raw) => {
                if let Err(e) = std::fs::write(&path, raw) {
                    log::warn!("gateway config persist failed: {e}");
                }
            }
            Err(e) => log::warn!("gateway config serialize failed: {e}"),
        }
    }

    /// Resolve a pending decision (called by `gateway_decision_response`).
    pub fn resolve_decision(&self, request_id: &str, entries: Vec<SnapshotEntry>) {
        if let Some(tx) = self.decisions.lock().remove(request_id) {
            let _ = tx.send(entries);
        }
    }

    pub fn config(&self) -> GatewayConfig {
        self.config.read().clone()
    }

    pub fn status(&self) -> GatewayStatus {
        let mut status = self.inner.lock().status.clone();
        status.bind_interface = self.config.read().bind_interface;
        status
    }

    pub fn update_config(&self, next: GatewayConfig) -> Result<(), GatewayError> {
        if let Err(error) = next.validate() {
            log::warn!("gateway config rejected: {error}");
            return Err(error);
        }
        let local_routing_enabled = next.gateway_local_routing_v2
            && self
                .snapshot
                .read()
                .as_ref()
                .is_some_and(|snapshot| snapshot.routing_policy.is_some());
        *self.config.write() = next;
        self.inner.lock().status.local_routing_enabled = local_routing_enabled;
        self.persist_config();
        Ok(())
    }

    // ---- API key management -------------------------------------------------

    pub fn list_keys(&self) -> Vec<RedactedApiKey> {
        self.keys
            .read()
            .iter()
            .map(GatewayApiKey::redacted)
            .collect()
    }

    fn refresh_key_presence(&self) {
        let now = chrono::Utc::now().timestamp_millis();
        let has = api_keys::has_usable_key(&self.keys.read(), now);
        self.inner.lock().status.has_token = has;
    }

    pub fn create_key(
        &self,
        name: String,
        model_allowlist: Vec<String>,
        expires_at_ms: Option<i64>,
        rate_limit_per_min: Option<u32>,
        quota_tokens: Option<i64>,
    ) -> Result<GatewayApiKey, GatewayError> {
        let key = {
            let mut keys = self.keys.write();
            api_keys::create_key(
                &mut keys,
                name,
                model_allowlist,
                expires_at_ms,
                rate_limit_per_min,
                quota_tokens,
            )
            .map_err(GatewayError::Keyring)?
        };
        self.refresh_key_presence();
        Ok(key)
    }

    /// Zero a key's consumed-quota counter (the "reset usage" action) and
    /// persist. Errors if the id is unknown.
    pub fn reset_key_quota(&self, id: &str) -> Result<(), GatewayError> {
        {
            let mut keys = self.keys.write();
            if !api_keys::reset_quota(&mut keys, id) {
                return Err(GatewayError::InvalidConfig(format!("no such key: {id}")));
            }
            api_keys::save_keys(&keys).map_err(GatewayError::Keyring)?;
        }
        Ok(())
    }

    pub fn update_key(&self, id: &str, patch: ApiKeyPatch) -> Result<(), GatewayError> {
        {
            let mut keys = self.keys.write();
            api_keys::apply_patch(&mut keys, id, patch).map_err(GatewayError::InvalidConfig)?;
            api_keys::save_keys(&keys).map_err(GatewayError::Keyring)?;
        }
        self.refresh_key_presence();
        self.stop_if_no_usable_key();
        Ok(())
    }

    pub fn delete_key(&self, id: &str) -> Result<(), GatewayError> {
        {
            let mut keys = self.keys.write();
            if !api_keys::delete_key(&mut keys, id) {
                return Err(GatewayError::InvalidConfig(format!("no such key: {id}")));
            }
            api_keys::save_keys(&keys).map_err(GatewayError::Keyring)?;
        }
        self.refresh_key_presence();
        self.stop_if_no_usable_key();
        Ok(())
    }

    pub fn reveal_key(&self, id: &str) -> Option<String> {
        self.keys
            .read()
            .iter()
            .find(|k| k.id == id)
            .map(|k| k.secret.clone())
    }

    /// Mirror the old token-clear safety: a running listener with no usable key
    /// left is stopped (and `enabled` cleared) so we never serve keyless.
    fn stop_if_no_usable_key(&self) {
        let now = chrono::Utc::now().timestamp_millis();
        if api_keys::has_usable_key(&self.keys.read(), now) {
            return;
        }
        if self.inner.lock().status.running {
            match self.stop() {
                Ok(()) | Err(GatewayError::NotRunning) => {}
                Err(e) => log::warn!("gateway stop after key removal failed: {e}"),
            }
        }
    }

    /// Replace the live routing snapshot unconditionally. Legacy path — the
    /// authority-checked [`Self::try_set_snapshot`] is what publishers call;
    /// this remains only for pre-Phase-2 in-crate tests and is equivalent to
    /// a legacy (unversioned) accept.
    pub fn set_snapshot(&self, snapshot: RoutingSnapshot) {
        let provider_count = snapshot.providers.iter().filter(|p| p.enabled).count() as u32;
        let alias_count = snapshot.aliases.len() as u32;
        let generated_at = snapshot.generated_at_ms;
        let policy_revision = snapshot
            .routing_policy
            .as_ref()
            .map(|policy| policy.policy_revision.clone());
        let routing_strategy = snapshot
            .routing_policy
            .as_ref()
            .map(|policy| policy.auto.strategy.clone());
        let routing_strategy_unavailable = snapshot
            .routing_policy
            .as_ref()
            .and_then(|policy| policy.auto.strategy_unavailable.clone());
        *self.snapshot.write() = Some(snapshot);
        let mut inner = self.inner.lock();
        inner.status.snapshot_generated_at_ms = Some(generated_at);
        inner.status.snapshot_provider_count = provider_count;
        inner.status.snapshot_alias_count = alias_count;
        inner.status.local_routing_enabled =
            policy_revision.is_some() && self.config.read().gateway_local_routing_v2;
        inner.status.routing_policy_revision = policy_revision;
        inner.status.routing_strategy = routing_strategy;
        inner.status.routing_strategy_unavailable = routing_strategy_unavailable;
    }

    /// Authority-checked snapshot ingest (ADR-0090 Phase 2, R3).
    ///
    /// CAS semantics over `(profile_version, authority)`:
    /// - an invalid snapshot (header policy / missing authority) is rejected
    ///   WHOLE — the previous snapshot keeps serving (fail closed);
    /// - a versioned push older than the current version is rejected;
    /// - an equal-version push from a DIFFERENT authority is rejected — there
    ///   is no last-writer-wins between the renderer and the profile store;
    /// - a legacy (unversioned) push is accepted only while the current
    ///   snapshot is also legacy/absent.
    pub fn try_set_snapshot(
        &self,
        snapshot: RoutingSnapshot,
    ) -> Result<SnapshotAccepted, SnapshotRejected> {
        if let Err(reason) = snapshot.validate() {
            return Err(SnapshotRejected::Invalid(reason));
        }
        let current = {
            let guard = self.snapshot.read();
            guard
                .as_ref()
                .map(|s| (s.profile_version, s.authority))
                .unwrap_or((None, None))
        };
        match (snapshot.profile_version, current.0) {
            (Some(incoming), Some(cur)) => {
                if incoming < cur {
                    return Err(SnapshotRejected::StaleVersion { current: cur });
                }
                if incoming == cur && snapshot.authority != current.1 {
                    return Err(SnapshotRejected::AuthorityConflict { current: cur });
                }
            }
            (None, Some(cur)) => {
                return Err(SnapshotRejected::LegacyOverVersioned { current: cur });
            }
            // Versioned over legacy, or legacy over legacy: accept.
            (Some(_), None) | (None, None) => {}
        }
        let accepted = SnapshotAccepted {
            profile_version: snapshot.profile_version,
        };
        self.set_snapshot(snapshot);
        Ok(accepted)
    }

    pub async fn start(&self, host: Arc<dyn GatewayHost>) -> Result<(), GatewayError> {
        {
            let now = chrono::Utc::now().timestamp_millis();
            if !api_keys::has_usable_key(&self.keys.read(), now) {
                return Err(GatewayError::TokenMissing);
            }
            if self.inner.lock().server.is_some() {
                return Err(GatewayError::AlreadyRunning(
                    self.inner.lock().status.bound_port.unwrap_or(0),
                ));
            }
        }

        let observer: Arc<dyn RequestObserver> = Arc::new(StateObserver {
            state: SelfPtr(self as *const _),
        });

        let handle = server::spawn_server(
            host,
            self.config.clone(),
            self.keys.clone(),
            self.snapshot.clone(),
            self.decisions.clone(),
            self.key_rotation.clone(),
            self.route_planner.clone(),
            self.key_cooldown.clone(),
            self.concurrency.clone(),
            observer,
            self.tickets.clone(),
            self.leases.clone(),
        )
        .await?;

        {
            let mut inner = self.inner.lock();
            inner.status.running = true;
            inner.status.bound_port = Some(handle.bound_port);
            inner.server = Some(handle);
        }
        self.config.write().enabled = true;
        self.persist_config();
        Ok(())
    }

    pub fn stop(&self) -> Result<(), GatewayError> {
        {
            let mut inner = self.inner.lock();
            let Some(handle) = inner.server.take() else {
                return Err(GatewayError::NotRunning);
            };
            let _ = handle.shutdown.send(());
            inner.status.running = false;
            inner.status.bound_port = None;
        }
        self.config.write().enabled = false;
        self.persist_config();
        // Flush any last-used-at bumps accumulated while running.
        let _ = api_keys::save_keys(&self.keys.read());
        Ok(())
    }

    /// Mint a route ticket against the CURRENT snapshot (ADR-0090 Phase 2).
    pub fn mint_route_ticket(
        &self,
        request: route_ticket::MintRequest,
    ) -> Result<route_ticket::MintedTicket, route_ticket::TicketError> {
        let now = chrono::Utc::now().timestamp_millis();
        let snapshot = self.snapshot.read();
        self.tickets.mint(request, snapshot.as_ref(), now)
    }

    pub fn revoke_route_ticket(&self, ticket_id: &str) -> bool {
        self.tickets.revoke(ticket_id)
    }

    /// Redacted ticket metadata (no secrets are ever stored).
    pub fn list_route_tickets(&self) -> Vec<route_ticket::RouteTicket> {
        let now = chrono::Utc::now().timestamp_millis();
        self.tickets.sweep_expired(now);
        self.tickets.list()
    }

    /// Bump the call counter + last-call timestamp from the request observer.
    fn observe(&self) {
        let mut inner = self.inner.lock();
        inner.status.calls_total = inner.status.calls_total.saturating_add(1);
        inner.status.last_call_at = Some(chrono::Utc::now().to_rfc3339());
    }
}

impl Default for GatewayState {
    fn default() -> Self {
        Self::new()
    }
}

/// Type-erased `&'static GatewayState` handle for the request observer. The
/// state is owned for the entire process lifetime by Tauri's `manage()` on
/// desktop, or by `HeadlessServices` (an `Arc` installed process-wide at
/// boot and never dropped) under `cognia-server` — so holding a raw pointer
/// for the server task's duration is sound in both hosts. Mirrors
/// `remote_control::SelfPtr`.
#[derive(Clone)]
struct SelfPtr(*const GatewayState);
unsafe impl Send for SelfPtr {}
unsafe impl Sync for SelfPtr {}

struct StateObserver {
    state: SelfPtr,
}

impl RequestObserver for StateObserver {
    fn on_call(&self, _route: &str, _status: axum::http::StatusCode, _remote_ip: std::net::IpAddr) {
        // SAFETY: the underlying `GatewayState` is owned by Tauri's managed-
        // state container for the entire process lifetime.
        let state: &GatewayState = unsafe { &*self.state.0 };
        state.observe();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_state_is_off_with_sane_defaults() {
        let state = GatewayState::new();
        let cfg = state.config();
        assert!(!cfg.enabled);
        assert_eq!(cfg.port, 47823);
        assert!(!state.status().running);
    }

    #[test]
    fn agent_debug_startup_does_not_load_persisted_gateway_keys() {
        assert!(load_initial_keys(true).is_empty());
    }

    #[test]
    fn set_snapshot_updates_status_counts() {
        let state = GatewayState::new();
        let snapshot: RoutingSnapshot = serde_json::from_value(serde_json::json!({
            "aliases": [{ "alias": "fast", "entries": [] }],
            "providers": [
                { "id": "a", "protocol": "openai", "baseUrl": "u", "enabled": true },
                { "id": "b", "protocol": "openai", "baseUrl": "u", "enabled": false }
            ],
            "generatedAtMs": 123
        }))
        .unwrap();
        state.set_snapshot(snapshot);
        let status = state.status();
        assert_eq!(status.snapshot_generated_at_ms, Some(123));
        assert_eq!(status.snapshot_provider_count, 1); // only enabled
        assert_eq!(status.snapshot_alias_count, 1);
    }

    #[test]
    fn update_config_rejects_invalid_config_and_preserves_previous_state() {
        let state = GatewayState::new();
        let original = state.config();
        let mut invalid = original.clone();
        invalid.allowlist = vec!["not-a-cidr".into()];

        let err = state.update_config(invalid).unwrap_err();

        assert!(err.to_string().contains("allowlist"));
        assert_eq!(state.config().allowlist, original.allowlist);
    }

    #[test]
    fn stop_without_running_returns_not_running() {
        let state = GatewayState::new();
        assert!(matches!(state.stop(), Err(GatewayError::NotRunning)));
    }

    #[test]
    fn key_lifecycle_toggles_presence() {
        let _guard = api_keys::STORE_TEST_GUARD
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let state = GatewayState::new();
        // Isolate from any keys other parallel tests left in the shared
        // cfg(test) secret store; this state's Arc is independent memory.
        state.keys.write().clear();
        state.refresh_key_presence();
        let created = state
            .create_key("Tool".into(), vec!["fast".into()], None, Some(60), None)
            .unwrap();
        assert!(state.status().has_token);
        // list is redacted (no secret)
        let listed = state.list_keys();
        assert!(listed.iter().any(|k| k.id == created.id));
        assert!(!serde_json::to_string(&listed)
            .unwrap()
            .contains(&created.secret));
        // reveal returns the full secret
        assert_eq!(
            state.reveal_key(&created.id).as_deref(),
            Some(created.secret.as_str())
        );
        // disabling the only key clears presence
        let patch: ApiKeyPatch =
            serde_json::from_value(serde_json::json!({ "enabled": false })).unwrap();
        state.update_key(&created.id, patch).unwrap();
        assert!(!state.status().has_token);
        // delete
        state.delete_key(&created.id).unwrap();
        assert!(state.delete_key(&created.id).is_err());
    }

    #[test]
    fn create_key_with_quota_and_reset() {
        let _guard = api_keys::STORE_TEST_GUARD
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let state = GatewayState::new();
        state.keys.write().clear();
        state.refresh_key_presence();
        let created = state
            .create_key("q".into(), vec![], None, None, Some(1000))
            .unwrap();
        assert_eq!(created.quota_tokens, Some(1000));
        assert_eq!(created.quota_used_tokens, 0);
        // Simulate consumption, then reset.
        api_keys::add_quota_usage(&mut state.keys.write(), &created.id, 400);
        assert_eq!(
            state
                .list_keys()
                .iter()
                .find(|k| k.id == created.id)
                .unwrap()
                .quota_used_tokens,
            400
        );
        state.reset_key_quota(&created.id).unwrap();
        assert_eq!(
            state
                .list_keys()
                .iter()
                .find(|k| k.id == created.id)
                .unwrap()
                .quota_used_tokens,
            0
        );
        assert!(state.reset_key_quota("missing").is_err());
    }

    #[test]
    fn hydrate_from_disk_loads_persisted_config() {
        let _guard = api_keys::STORE_TEST_GUARD
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let state = GatewayState::new();
        state.keys.write().clear();
        state.refresh_key_presence();
        // Ensure a usable key so `enabled` survives hydrate.
        let _ = state
            .create_key("k".into(), vec![], None, None, None)
            .unwrap();
        let dir = std::env::temp_dir().join(format!("cognia-gw-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("gateway-config.json");
        let cfg = GatewayConfig {
            port: 50055,
            enabled: true,
            request_timeout_secs: 42,
            ..GatewayConfig::default()
        };
        std::fs::write(&path, serde_json::to_string(&cfg).unwrap()).unwrap();

        state.hydrate_from_disk(path);
        let loaded = state.config();
        assert_eq!(loaded.port, 50055);
        assert_eq!(loaded.request_timeout_secs, 42);
        assert!(loaded.enabled);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_config_persists_to_disk_when_path_set() {
        let state = GatewayState::new();
        let dir = std::env::temp_dir().join(format!("cognia-gw-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("gateway-config.json");
        state.hydrate_from_disk(path.clone()); // sets config_path (file absent → defaults)
        let mut cfg = state.config();
        cfg.request_timeout_secs = 99;
        state.update_config(cfg).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"requestTimeoutSecs\": 99"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn resolve_decision_delivers_to_the_waiting_oneshot() {
        let state = GatewayState::new();
        let (tx, rx) = oneshot::channel();
        state.decisions.lock().insert("req-1".into(), tx);
        let entries: Vec<SnapshotEntry> = serde_json::from_value(serde_json::json!([
            { "providerId": "groq", "modelId": "llama" }
        ]))
        .unwrap();
        state.resolve_decision("req-1", entries);
        let got = rx.await.unwrap();
        assert_eq!(got[0].provider_id, "groq");
        assert!(state.decisions.lock().is_empty());
    }

    #[test]
    fn resolve_decision_for_unknown_id_is_a_noop() {
        let state = GatewayState::new();
        state.resolve_decision("never-registered", vec![]); // must not panic
    }

    #[test]
    fn cooldowns_surface_reflects_recorded_state() {
        let state = GatewayState::new();
        assert!(state.cooldowns().is_empty());
        let now = chrono::Utc::now().timestamp_millis();
        cooldown::record_cooldown(
            &state.key_cooldown,
            "p",
            "sk-abcd",
            now + 60_000,
            "HTTP 429",
        );
        cooldown::record_permanent(&state.key_cooldown, "p", "sk-dead", "quota");
        let rows = state.cooldowns();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.permanent));
        // Fingerprinted — no full secret leaks.
        assert!(!serde_json::to_string(&rows).unwrap().contains("sk-abcd"));
    }

    fn versioned_snapshot(version: u64, authority: &str, generated_at: i64) -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [],
            "providers": [],
            "generatedAtMs": generated_at,
            "profileVersion": version,
            "authority": authority,
        }))
        .unwrap()
    }

    fn legacy_snapshot(generated_at: i64) -> RoutingSnapshot {
        serde_json::from_value(serde_json::json!({
            "aliases": [], "providers": [], "generatedAtMs": generated_at,
        }))
        .unwrap()
    }

    #[test]
    fn snapshot_cas_accepts_newer_versions_and_rejects_stale_ones() {
        let state = GatewayState::new();
        assert!(state
            .try_set_snapshot(versioned_snapshot(2, "renderer", 1))
            .is_ok());
        assert!(state
            .try_set_snapshot(versioned_snapshot(3, "renderer", 2))
            .is_ok());
        match state.try_set_snapshot(versioned_snapshot(2, "renderer", 3)) {
            Err(SnapshotRejected::StaleVersion { current }) => assert_eq!(current, 3),
            other => panic!("expected StaleVersion, got {other:?}"),
        }
        // The live snapshot is unchanged by the rejection.
        assert_eq!(state.snapshot.read().as_ref().unwrap().generated_at_ms, 2);
    }

    #[test]
    fn snapshot_cas_refuses_same_version_from_a_different_authority() {
        let state = GatewayState::new();
        assert!(state
            .try_set_snapshot(versioned_snapshot(5, "profile-store", 1))
            .is_ok());
        match state.try_set_snapshot(versioned_snapshot(5, "renderer", 2)) {
            Err(SnapshotRejected::AuthorityConflict { current }) => assert_eq!(current, 5),
            other => panic!("expected AuthorityConflict, got {other:?}"),
        }
        // Same version + same authority is an idempotent republish — accepted.
        assert!(state
            .try_set_snapshot(versioned_snapshot(5, "profile-store", 3))
            .is_ok());
    }

    #[test]
    fn snapshot_cas_gates_legacy_pushes_once_versioned() {
        let state = GatewayState::new();
        // Legacy over empty and legacy over legacy: accepted.
        assert!(state.try_set_snapshot(legacy_snapshot(1)).is_ok());
        assert!(state.try_set_snapshot(legacy_snapshot(2)).is_ok());
        // Versioned over legacy: accepted (migration direction).
        assert!(state
            .try_set_snapshot(versioned_snapshot(1, "renderer", 3))
            .is_ok());
        // Legacy over versioned: refused — no silent downgrade.
        assert!(matches!(
            state.try_set_snapshot(legacy_snapshot(4)),
            Err(SnapshotRejected::LegacyOverVersioned { current: 1 })
        ));
    }

    #[test]
    fn snapshot_cas_rejects_invalid_transports_whole() {
        let state = GatewayState::new();
        state.set_snapshot(legacy_snapshot(1));
        let bad: RoutingSnapshot = serde_json::from_value(serde_json::json!({
            "aliases": [],
            "providers": [{
                "id": "p", "protocol": "anthropic", "baseUrl": "u", "enabled": true,
                "transport": {
                    "authScheme": "bearer",
                    "staticHeaders": [["x-cognia-run", "1"]],
                }
            }],
            "generatedAtMs": 2,
        }))
        .unwrap();
        assert!(matches!(
            state.try_set_snapshot(bad),
            Err(SnapshotRejected::Invalid(_))
        ));
        // Previous snapshot keeps serving.
        assert_eq!(state.snapshot.read().as_ref().unwrap().generated_at_ms, 1);
    }
}
