//! Companion API — QR-pairing exchange and mobile device authentication.
//!
//! This module implements the server-side of the cognia mobile companion
//! pairing flow (M2.3).  It exposes an axum HTTP server on a configurable
//! port (default 27890) with two endpoints:
//!
//! - `POST /api/v1/auth/pair/issue` — desktop-only (127.0.0.1 listener when
//!   `bind_loopback_only = true`); issues a short-lived pair JWT that the QR
//!   generator encodes into an image.
//!
//! - `POST /api/v1/auth/pair` — redeems the pair JWT and returns a long-lived
//!   device JWT.  Callable from the phone over LAN or a cloudflared tunnel
//!   (M2.8).
//!
//! # Module layout
//!
//! - [`secret`]          — HS256 signing-secret persistence (OS keyring).
//! - [`jwt`]             — HS256 JWT issue + verify helpers.
//! - [`redemption_lru`]  — Single-use JTI tracker.
//! - [`auth`]            — Axum handlers for the two pair endpoints.
//! - [`server`]          — Axum server spawn + router builder.
//!
//! # Tauri integration
//!
//! The Tauri command `companion_server_start` (in [`commands`]) is the entry
//! point from the frontend.  State is held in [`CompanionState`] managed by
//! Tauri's `manage()`.  Device persistence is handled exclusively by the TS
//! layer: the handler emits `companion://device-paired` and the TS side calls
//! `addPairedDevice` from `lib/db/paired-devices.ts`.

pub mod a2a;
pub mod acp;
pub mod admin_lease;
pub mod audit;
pub mod auth;
pub mod bridge_transport;
pub mod browser_gateway;
pub mod command_manifest;
pub mod control_allow_list;
pub mod data_plane;
pub mod deny_list;
pub mod deployment;
pub mod desktop_messages_bridge;
pub mod desktop_writes_bridge;
pub mod device_grants;
pub mod dispatch_host;
pub mod dispatchers;
pub mod event_bus;
pub mod external_bridge;
pub mod healthz;
pub mod idempotency;
pub mod jwt;
pub mod lark_entry;
pub mod locked_use_allow_list;
pub mod mdns;
pub mod metrics;
pub mod middleware;
pub mod oidc;
pub mod pair_code_guard;
pub mod pair_code_lru;
pub mod pair_flow_test;
pub mod push;
pub mod push_creds;
pub mod rate_limit;
pub mod redemption_lru;
pub mod remote_execution;
pub mod rpc;
pub mod secret;
pub mod security_store;
pub mod server;
pub mod settings_sync_generated;
pub mod signaling;
pub mod skill_transactions;
pub mod spec_parity;
pub mod store;
pub mod sync_bridge;
pub mod sync_registry;
pub mod tls;
pub mod tunnel;
pub mod tunnel_config;
pub mod v2;
pub mod ws;
pub mod ws_bridge;
pub mod ws_terminal;
pub mod ws_terminal_test;

pub mod commands;

/// Re-export so handlers can read the device identity without reaching into
/// the middleware module by full path.  Not yet consumed by any handler in
/// M2.4 — M2.5+ routes will use it.
#[allow(unused_imports)]
pub use middleware::DeviceContext;

use parking_lot::RwLock;
use std::sync::Arc;

use deny_list::DenyList;
use event_bus::EventBus;
use idempotency::IdempotencyCache;
use pair_code_lru::PairCodeLru;
use redemption_lru::RedemptionLru;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// Shared state injected into every axum handler.
///
/// Wrapped in `Arc` for cheap cloning into tower layers.
pub type SharedState = Arc<CompanionState>;

/// Application state for the companion API server.
pub struct CompanionState {
    /// The HS256 signing secret (raw bytes).  Protected by a `RwLock` so the
    /// secret can be rotated (M3+) without restarting the server.
    pub secret: RwLock<Vec<u8>>,
    /// Single-use redemption tracker for pair JWTs.
    pub redemption_lru: RedemptionLru,
    /// 6-digit numeric code → pair JWT map (emulator-friendly path that
    /// avoids QR camera scanning). Single-use; entries TTL-pruned in lock
    /// step with the underlying pair JWT's `exp` claim.
    pub pair_code_lru: Arc<PairCodeLru>,
    /// In-memory set of revoked device IDs.  Shared with [`CompanionServerState`]
    /// via `Arc` so Tauri commands (`companion_revoke_device`, etc.) can mutate
    /// it even when the axum server holds a clone of the same `SharedState`.
    pub deny_list: Arc<DenyList>,
    /// Tauri `AppHandle` — `None` in unit tests, `Some` in production.
    pub app_handle: Option<tauri::AppHandle>,
    /// Per-device idempotency cache for `POST /api/v1/_rpc/:name`.
    ///
    /// Keyed by `(device_id, Idempotency-Key header)`.  Successful responses
    /// are stored for 60 s; read-only commands skip caching entirely.
    pub idempotency: Arc<IdempotencyCache>,
    /// Event bus — broadcasts Tauri events to all connected WS clients and
    /// maintains a replay buffer for reconnecting clients (M2.6).
    pub event_bus: Arc<EventBus>,
    /// Sync-pull bridge between the Rust handler and the desktop WebView's
    /// Dexie store (M4.7).  See [`sync_bridge`] for the wire protocol.
    pub sync_bridge: Arc<sync_bridge::SyncBridge>,
    /// Desktop-message-mutation bridge (mobile completeness, Phase 2).
    /// Carries `message_update` / `message_delete` / `session_list` round-
    /// trips between the Rust HTTP handler and the WebView's Dexie store.
    /// See [`desktop_messages_bridge`] for the wire protocol.
    pub desktop_messages_bridge: Arc<desktop_messages_bridge::DesktopMessagesBridge>,
    /// Generic desktop-write bridge (Wave 2). Carries the 7 mutating Wave 2
    /// RPCs (character_*, skill_set_enabled, plugin_set_enabled,
    /// adapter_update_policy, app_settings_update) plus the read-only
    /// `twin_profile_get` projection through one event channel.
    pub desktop_writes_bridge: Arc<desktop_writes_bridge::DesktopWritesBridge>,
    /// Declarative sync-table allowlist (Wave 3.5). Replaces the
    /// hardcoded `const ALLOWED` array in `rpc.rs`'s `sync_pull` arm so
    /// plugins can register their own Dexie tables for mobile mirror.
    pub sync_registry: Arc<sync_registry::SyncTableRegistry>,
    /// Per-device rate limiter (Wave 3.3). Token bucket: 60 rpm, 10
    /// burst, evaluated *after* the JWT verifier middleware so each
    /// paired phone gets its own quota.
    pub rate_limiter: Arc<rate_limit::RateLimiter>,
    /// Push notification token registry (Wave 3.4). Per-device APNs /
    /// FCM tokens registered via `register_push_token`; consumed by the
    /// dispatcher when the desktop emits an event for a phone that has
    /// no live WebSocket subscription.
    pub push_tokens: Arc<push::PushTokenRegistry>,
}

/// Currently configured push dispatchers (Phase B2). Process-wide singleton
/// (mirrors `TLS_FINGERPRINT`) so the many test constructors of
/// `CompanionState` aren't forced to pass it. Populated via the
/// `companion_push_configure_{fcm,apns}` Tauri commands.
static PUSH_DISPATCHERS: once_cell::sync::Lazy<Arc<push::DispatcherSet>> =
    once_cell::sync::Lazy::new(push::DispatcherSet::new);

pub fn push_dispatchers() -> Arc<push::DispatcherSet> {
    Arc::clone(&PUSH_DISPATCHERS)
}

/// SHA-256 SPKI fingerprint of the server's TLS cert (M2.9). Stored as a
/// process-wide value rather than a field on `CompanionState` so the many
/// test constructors of `CompanionState` aren't forced to pass a value.
/// Set at server start by [`commands::companion_server_start`] from the
/// loaded `TlsMaterial`; returned in `/api/v1/whoami` (P0.3).
static TLS_FINGERPRINT: parking_lot::RwLock<String> = parking_lot::RwLock::new(String::new());

pub fn set_tls_fingerprint(fp: String) {
    *TLS_FINGERPRINT.write() = fp;
}

pub fn tls_fingerprint() -> String {
    TLS_FINGERPRINT.read().clone()
}

/// Port the companion API server is currently bound to. Process-global
/// for the same reason as [`TLS_FINGERPRINT`] — the many CompanionState
/// constructors (production + tests + bin entry points) don't need to
/// thread the port through. Set by [`CompanionServerState::start`] after
/// the listener has actually bound; read by [`healthz::healthz_handler`]
/// to surface to mobile clients in `/api/v1/healthz`.
static ADVERTISED_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

pub fn set_advertised_port(port: u16) {
    ADVERTISED_PORT.store(port, std::sync::atomic::Ordering::SeqCst);
}

pub fn advertised_port() -> u16 {
    ADVERTISED_PORT.load(std::sync::atomic::Ordering::SeqCst)
}

/// Idempotently install the process-level rustls `CryptoProvider`.
///
/// rustls 0.23.x refuses to auto-detect a provider when *both* `aws-lc-rs`
/// and `ring` are present in the dependency graph (multiple crates pull in
/// each). `main.rs` installs `ring` at boot, but the companion API server and
/// the WebRTC peer-connection layer can be exercised from contexts that never
/// run `main()` (notably the unit tests in this crate, and any future headless
/// entry point). Calling `install_default` again after a successful install
/// returns `Err`, so this swallows that error — the only contract we need is
/// "a provider is installed by the time TLS/DTLS is set up". Cheap and safe to
/// call on every server spawn / peer-connection construction.
pub fn ensure_crypto_provider() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        // Ignore the result: a provider may already be installed (e.g. by
        // `main.rs` in production, or by an earlier call in another test).
        // `ring` is chosen to match axum-server's `tls-rustls` feature.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Per-source-IP rate limiter for the pre-auth (`public_routes`) surface —
/// the only endpoints reachable without a verified device JWT. Lives as a
/// process-wide singleton (like [`TLS_FINGERPRINT`] / [`ADVERTISED_PORT`])
/// so the many test constructors of `CompanionState` aren't forced to
/// thread a value.
///
/// Bucket: 5 burst, refill 20 req/min (≈ 1 every 3 s). The numeric
/// `/auth/pair/redeem-code` endpoint accepts only `100_000..=999_999` (a
/// ~900 000-code keyspace), and the pair-code LRU caps at 64 live entries
/// — without this gate, an unauthenticated LAN peer could redeem the
/// keyspace in O(minutes). With the gate the same brute force takes
/// roughly 31 hours per source IP, well beyond the ~5-minute pair-code
/// TTL.
static PRE_AUTH_RATE_LIMITER: once_cell::sync::Lazy<Arc<rate_limit::RateLimiter>> =
    once_cell::sync::Lazy::new(|| {
        rate_limit::RateLimiter::new(rate_limit::RateLimitConfig {
            capacity: 5.0,
            refill_per_sec: 20.0 / 60.0,
        })
    });

pub fn pre_auth_rate_limiter() -> Arc<rate_limit::RateLimiter> {
    Arc::clone(&PRE_AUTH_RATE_LIMITER)
}

/// Process-global OIDC authenticator (ADR-0059 cloud/headless Logto mode).
///
/// Built once from the environment: `None` unless BOTH `COGNIA_LOGTO_ISSUER`
/// and `COGNIA_LOGTO_AUDIENCE` are set, so the offline desktop app never
/// activates OIDC — the companion gateway keeps using the self-issued HS256
/// device/service tokens. When present, [`middleware::require_device_jwt`]
/// tries a Logto access token first and falls back to the HS256 path.
///
/// Kept process-global (like [`PRE_AUTH_RATE_LIMITER`] / [`TLS_FINGERPRINT`])
/// so the many `CompanionState` constructors don't have to thread it through.
static OIDC_AUTHENTICATOR: once_cell::sync::Lazy<Option<Arc<oidc::OidcAuthenticator>>> =
    once_cell::sync::Lazy::new(oidc::OidcAuthenticator::from_env);

pub fn oidc_authenticator() -> Option<Arc<oidc::OidcAuthenticator>> {
    OIDC_AUTHENTICATOR.clone()
}

// ---------------------------------------------------------------------------
// Orchestrator state (Tauri-managed)
// ---------------------------------------------------------------------------

use parking_lot::Mutex;
use server::ServerHandle;

/// Tauri-managed state for the companion API server lifecycle.
///
/// Mirrors the pattern in `mcp_server/mod.rs::McpServerState`.
pub struct CompanionServerState {
    inner: Mutex<CompanionServerInner>,
    /// Data directory for file-backed persistence (push tokens, tunnel config).
    /// `None` in headless mode when the directory hasn't been established yet.
    data_dir: Option<std::path::PathBuf>,
    /// The deny list is kept here (behind `Arc`) so Tauri commands can reach it
    /// regardless of whether the HTTP server is currently running.  When the
    /// server is started, the same `Arc<DenyList>` is cloned into the
    /// `SharedState`, giving both sides a live view of the same data.
    pub deny_list: Arc<DenyList>,
    /// Sync-pull bridge — shared with the axum SharedState so the
    /// `companion_sync_pull_response` Tauri command (called from the TS
    /// side when it has the requested Dexie delta in hand) can resolve the
    /// pending oneshot regardless of whether the HTTP handler that opened
    /// the request still holds a reference. Same Arc-cloning trick as
    /// `deny_list` above.
    pub sync_bridge: Arc<sync_bridge::SyncBridge>,
    /// Desktop-message-mutation bridge — same Arc-cloning trick as
    /// `sync_bridge`. Shared with `SharedState` so the
    /// `companion_message_response` Tauri command can resolve pending
    /// oneshots even when the HTTP handler that issued the request has
    /// already returned.
    pub desktop_messages_bridge: Arc<desktop_messages_bridge::DesktopMessagesBridge>,
    /// Desktop-write bridge (Wave 2). Same Arc-cloning trick as
    /// `desktop_messages_bridge`; the `companion_desktop_write_response`
    /// Tauri command resolves the pending oneshots regardless of whether
    /// the HTTP handler that issued the request still has its task alive.
    pub desktop_writes_bridge: Arc<desktop_writes_bridge::DesktopWritesBridge>,
    /// Declarative sync-table registry (Wave 3.5). Shared with the axum
    /// `SharedState` so plugin registration done at boot — before the
    /// server starts — propagates to the running HTTP handler.
    pub sync_registry: Arc<sync_registry::SyncTableRegistry>,
    /// Long-lived rate limiter shared between the orchestrator and the
    /// running axum SharedState — buckets persist across server restarts
    /// so a device that's burning quota can't reset it by re-pairing.
    pub rate_limiter: Arc<rate_limit::RateLimiter>,
    /// Long-lived push token registry — survives server restarts so a
    /// re-paired phone keeps its existing FCM/APNs token until the
    /// phone itself re-registers.
    pub push_tokens: Arc<push::PushTokenRegistry>,
    /// 6-digit pair-code map — survives restarts so codes generated just
    /// before a server bounce still resolve. Capped at 64 entries.
    pub pair_code_lru: Arc<PairCodeLru>,
    /// mDNS broadcaster (Wave 1.5) — exposes the running server on the LAN
    /// so paired phones can discover the desktop without manual baseUrl
    /// entry. Optional — broadcast must be opted into via Settings.
    pub mdns: mdns::BroadcasterState,
    /// Cloudflared tunnel (Wave 1.6) — when active, the QR pair payload
    /// encodes the public trycloudflare URL instead of the LAN IP. Default
    /// off — opt-in via Settings.
    pub tunnel: tunnel::TunnelState,
}

struct CompanionServerInner {
    handle: Option<ServerHandle>,
    bound_port: Option<u16>,
    /// Mirror of the `bind_loopback_only` flag passed to the most recent
    /// `start` so the settings UI can read back the bind mode without a
    /// separate state lookup. `None` means the server is stopped.
    bind_mode: Option<BindMode>,
}

/// Bind selection persisted alongside the listener handle so the M2.8
/// settings UI can render the current mode without re-reading prefs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BindMode {
    Loopback,
    Lan,
}

impl CompanionServerState {
    pub fn new() -> Self {
        Self::new_with(None)
    }

    /// Construct the long-lived state with persistent push-token storage at
    /// `<data_dir>/cognia/companion/push-tokens.json` (Phase B1). Mirrors the
    /// pattern used by `vector::VectorState::new` and the scheduler — a
    /// data-dir path threaded from `lib.rs::run()` at boot.
    #[allow(dead_code)] // wired from lib.rs::run.
    pub fn with_data_dir(data_dir: Option<std::path::PathBuf>) -> Self {
        Self::new_with(data_dir)
    }

    fn new_with(data_dir: Option<std::path::PathBuf>) -> Self {
        let push_tokens = match data_dir.as_deref() {
            Some(dir) => push::PushTokenRegistry::with_persistence(dir),
            None => push::PushTokenRegistry::new(),
        };
        // Load persisted tunnel config so `current()` reports the hostname
        // for named tunnels without requiring a re-start.
        let tunnel_config = tunnel_config::load_config(data_dir.as_deref());
        let tunnel = tunnel::TunnelState::new();
        if let Some(ref named) = tunnel_config.named {
            tunnel.set_named_config(named.clone());
        }
        Self {
            inner: Mutex::new(CompanionServerInner {
                handle: None,
                bound_port: None,
                bind_mode: None,
            }),
            data_dir,
            deny_list: Arc::new(DenyList::new()),
            sync_bridge: sync_bridge::SyncBridge::new(),
            desktop_messages_bridge: desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge: desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: rate_limit::RateLimiter::with_defaults(),
            push_tokens,
            pair_code_lru: Arc::new(PairCodeLru::new()),
            mdns: mdns::BroadcasterState::new(),
            tunnel,
        }
    }

    /// Whether the server is currently running.
    pub fn is_running(&self) -> bool {
        self.inner.lock().handle.is_some()
    }

    /// The port the server is bound to, if running.
    pub fn bound_port(&self) -> Option<u16> {
        self.inner.lock().bound_port
    }

    /// Spawn the server and store the handle.  Returns the bound port.
    pub async fn start(
        &self,
        port: u16,
        bind_loopback_only: bool,
        tls: tls::TlsMaterial,
        state: SharedState,
    ) -> Result<u16, server::CompanionServerError> {
        {
            let inner = self.inner.lock();
            if inner.handle.is_some() {
                if let Some(p) = inner.bound_port {
                    // Already running — return the current port.
                    return Ok(p);
                }
            }
        }
        let handle = server::spawn_server(port, bind_loopback_only, tls, state).await?;
        let bound_port = handle.bound_port;
        let mode = if bind_loopback_only {
            BindMode::Loopback
        } else {
            BindMode::Lan
        };
        {
            let mut inner = self.inner.lock();
            inner.handle = Some(handle);
            inner.bound_port = Some(bound_port);
            inner.bind_mode = Some(mode);
        }
        // Publish the live bind port so `/api/v1/healthz` can advertise it
        // to mobile clients — the same process-global pattern used by the
        // TLS fingerprint, set here so test + production paths both hit it.
        set_advertised_port(bound_port);
        Ok(bound_port)
    }

    /// Stop the server gracefully.  Called by M2.8 settings UI.
    pub fn stop(&self) {
        let mut inner = self.inner.lock();
        if let Some(handle) = inner.handle.take() {
            let _ = handle.shutdown.send(());
        }
        inner.bound_port = None;
        inner.bind_mode = None;
        // Mirror the bind state in the process-global so /healthz responses
        // reflect "server stopped" rather than a stale port.
        set_advertised_port(0);
    }

    /// Data directory for file-backed persistence (tunnel config, etc.).
    pub fn data_dir(&self) -> Option<&std::path::Path> {
        self.data_dir.as_deref()
    }

    /// Whether the most recent `start` was loopback-only.  `None` if the
    /// server is currently stopped.
    ///
    /// Mirror tracked alongside the listener so the M2.8 settings UI can
    /// render the bind mode without re-reading from a pref file.
    pub fn bind_mode(&self) -> Option<BindMode> {
        self.inner.lock().bind_mode
    }

    // ── Deny-list pass-throughs (used by Tauri commands) ───────────────────

    pub fn seed_deny_list(&self, device_ids: Vec<String>) {
        self.deny_list.seed(device_ids);
    }

    pub fn revoke_device(&self, device_id: String) {
        self.deny_list.revoke(device_id);
    }

    pub fn unrevoke_device(&self, device_id: &str) {
        self.deny_list.unrevoke(device_id);
    }
}

impl Default for CompanionServerState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_shared_state() -> SharedState {
        Arc::new(CompanionState {
            secret: RwLock::new(vec![0u8; 32]),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: sync_bridge::SyncBridge::new(),
            desktop_messages_bridge: desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge: desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: rate_limit::RateLimiter::with_defaults(),
            push_tokens: push::PushTokenRegistry::new(),
        })
    }

    fn test_tls() -> (TempDir, tls::TlsMaterial) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mat = tls::ensure_certificate(tmp.path()).expect("ensure_certificate");
        (tmp, mat)
    }

    #[test]
    fn new_state_is_not_running() {
        let state = CompanionServerState::new();
        assert!(!state.is_running());
        assert!(state.bound_port().is_none());
    }

    #[tokio::test]
    async fn start_stop_round_trip() {
        let server_state = CompanionServerState::new();
        let shared = test_shared_state();
        let (_tmp, tls_mat) = test_tls();

        let port = server_state
            .start(0, true, tls_mat, shared)
            .await
            .expect("start");
        assert!(port > 0);
        assert!(server_state.is_running());
        assert_eq!(server_state.bound_port(), Some(port));
        assert_eq!(server_state.bind_mode(), Some(BindMode::Loopback));

        server_state.stop();
        assert!(!server_state.is_running());
        assert!(server_state.bound_port().is_none());
        assert!(server_state.bind_mode().is_none());
    }

    #[tokio::test]
    async fn lan_bind_records_lan_mode() {
        let server_state = CompanionServerState::new();
        let shared = test_shared_state();
        let (_tmp, tls_mat) = test_tls();

        let _ = server_state
            .start(0, false, tls_mat, shared)
            .await
            .expect("start");
        assert_eq!(server_state.bind_mode(), Some(BindMode::Lan));

        server_state.stop();
        assert!(server_state.bind_mode().is_none());
    }

    #[tokio::test]
    async fn double_start_returns_same_port() {
        let server_state = CompanionServerState::new();
        let shared1 = test_shared_state();
        let shared2 = test_shared_state();
        let (_tmp1, tls1) = test_tls();
        let (_tmp2, tls2) = test_tls();

        let port1 = server_state
            .start(0, true, tls1, shared1)
            .await
            .expect("start");
        let port2 = server_state
            .start(0, true, tls2, shared2)
            .await
            .expect("second start");
        assert_eq!(port1, port2, "second start must return same port");

        server_state.stop();
    }
}
