//! Axum HTTP server for the unversioned Companion API.
//!
//! # Port separation rationale
//!
//! The companion API runs on its own TCP port (default 27890) rather than
//! sharing the MCP server port (default from `mcp_server/http_server.rs`).
//! This keeps the MCP server untouched and gives M2.4 (JWT verifier middleware),
//! M2.5 (RPC routes), and M2.6 (WS upgrade) clean, independent mount points on
//! a single axum `Router`.  Sharing a port via `Router::merge` would require
//! significant changes to the existing MCP server's state model.
//!
//! # Bind strategy
//!
//! When `bind_loopback_only` is `true`, the server binds to `127.0.0.1`
//! (only processes on the same machine can reach it).  When `false`, it binds
//! to `0.0.0.0` (LAN-accessible).  M2.8 exposes a UI toggle; M2.3 defaults to
//! loopback-only until LAN access is explicitly enabled.
//!
//! # TLS (M2.9)
//!
//! The server always terminates HTTPS using the self-signed cert from
//! [`super::tls::ensure_certificate`]. Mobile clients pin the SPKI fingerprint
//! out-of-band via the QR pair payload, so chain validation is intentionally
//! bypassed on the client side. Cloudflared tunnel connects to the local
//! HTTPS origin with `--no-tls-verify` (see [`super::tunnel::launch`]).
//!
//! # Graceful shutdown
//!
//! Uses `axum_server::Handle::graceful_shutdown` driven off the same
//! `tokio::sync::watch` channel the previous plain-HTTP path used. Callers
//! send `()` to drain and exit.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use super::{a2a, acp, healthz, tls::TlsMaterial, ws, ws_bridge, ws_terminal};
use axum::{
    extract::Request,
    http::{header, HeaderValue, Method, StatusCode},
    middleware::Next,
    middleware::{from_fn, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::{any, delete, get, post, put},
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;

use super::{lark_entry, middleware, SharedState};

/// 64 KiB — pair request bodies are tiny; the generous limit leaves room for
/// future endpoints (e.g., push-token registration in M4.6).
const BODY_LIMIT_BYTES: usize = 64 * 1024;

async fn harden_internal_response(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if let Ok(contract) = super::command_manifest::headless_contract() {
        if let Ok(value) = HeaderValue::from_str(contract.catalog_hash()) {
            response
                .headers_mut()
                .insert("x-cognia-headless-catalog-hash", value);
        }
        if let Ok(value) = HeaderValue::from_str(&contract.schema_version().to_string()) {
            response
                .headers_mut()
                .insert("x-cognia-headless-contract-version", value);
        }
    }
    response
}

/// Default companion API port.  Configurable via `companion_server_start`.
/// Used by M2.8 settings UI.
///
/// 27890 — deliberately outside the 789x range: 7890/7891 are the Clash
/// mixed/SOCKS defaults (see `proxy_config::detect::KNOWN_PORTS`), so binding
/// there collides with FlClash/Clash Verge on developer machines.
pub const DEFAULT_PORT: u16 = 27890;
const MAX_DRAIN_DURATION: Duration = Duration::from_secs(300);
static DRAINING: AtomicBool = AtomicBool::new(false);
static WRITES_PAUSED: AtomicBool = AtomicBool::new(false);
static ACTIVE_MUTATIONS: AtomicUsize = AtomicUsize::new(0);

pub fn is_draining() -> bool {
    DRAINING.load(Ordering::SeqCst)
}

pub fn begin_draining() {
    DRAINING.store(true, Ordering::SeqCst);
}

pub fn is_accepting_writes() -> bool {
    !DRAINING.load(Ordering::SeqCst) && !WRITES_PAUSED.load(Ordering::SeqCst)
}

pub struct WritePauseGuard;

impl Drop for WritePauseGuard {
    fn drop(&mut self) {
        WRITES_PAUSED.store(false, Ordering::SeqCst);
    }
}

struct ActiveMutationGuard;

impl Drop for ActiveMutationGuard {
    fn drop(&mut self) {
        ACTIVE_MUTATIONS.fetch_sub(1, Ordering::SeqCst);
    }
}

pub async fn pause_writes() -> Result<WritePauseGuard, String> {
    WRITES_PAUSED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "server writes are already paused".to_string())?;
    let guard = WritePauseGuard;
    let deadline = tokio::time::Instant::now() + MAX_DRAIN_DURATION;
    while ACTIVE_MUTATIONS.load(Ordering::SeqCst) != 0 {
        if tokio::time::Instant::now() >= deadline {
            return Err("timed out waiting for active mutations to drain".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(guard)
}

#[cfg(test)]
pub fn set_draining_for_test(value: bool) {
    DRAINING.store(value, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------

/// Returned by [`spawn_server`] so the caller can record the bound port and
/// send the graceful-shutdown signal later.
#[derive(Clone)]
pub struct ServerHandle {
    /// The port the listener is actually bound to (`0` → OS-assigned).
    pub bound_port: u16,
    /// Send `()` here to initiate graceful shutdown.
    ///
    /// Read by tests and by `CompanionServerState::stop`.
    #[allow(dead_code)]
    pub shutdown: watch::Sender<()>,
    pub terminated: watch::Receiver<bool>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum CompanionServerError {
    #[error("companion server bind failed on {addr}: {source}")]
    Bind {
        addr: SocketAddr,
        #[source]
        source: std::io::Error,
    },
    #[error("companion TLS config load failed: {0}")]
    Tls(String),
    #[error("companion security database initialization failed: {0}")]
    Security(String),
}

impl serde::Serialize for CompanionServerError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Spawn the companion axum server with TLS and return a [`ServerHandle`].
///
/// # Arguments
///
/// - `port` — TCP port.  Pass `0` to let the OS choose an ephemeral port
///   (useful in tests).
/// - `bind_loopback_only` — `true` → `127.0.0.1`; `false` → `0.0.0.0`.
/// - `tls` — TLS material loaded by [`super::tls::ensure_certificate`].
/// - `state` — shared companion state (secret, redemption LRU, app handle).
pub async fn spawn_server(
    port: u16,
    bind_loopback_only: bool,
    tls: TlsMaterial,
    state: SharedState,
) -> Result<ServerHandle, CompanionServerError> {
    DRAINING.store(false, Ordering::SeqCst);
    // rustls 0.23 needs an explicit crypto provider before building any TLS
    // config; install one idempotently in case the server is spawned from a
    // context that never ran `main.rs` (tests, headless entry points).
    super::ensure_crypto_provider();

    let ip: IpAddr = if bind_loopback_only {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    };
    let addr = SocketAddr::new(ip, port);

    // Bind synchronously so we can return the ephemeral port before serving.
    let std_listener = std::net::TcpListener::bind(addr)
        .map_err(|source| CompanionServerError::Bind { addr, source })?;
    std_listener
        .set_nonblocking(true)
        .map_err(|source| CompanionServerError::Bind { addr, source })?;
    let bound_port = std_listener
        .local_addr()
        .map_err(|source| CompanionServerError::Bind { addr, source })?
        .port();

    let rustls_config = RustlsConfig::from_pem_file(&tls.cert_pem_path, &tls.key_pem_path)
        .await
        .map_err(|e| CompanionServerError::Tls(e.to_string()))?;

    let app = build_router(state);

    let server_handle = axum_server::Handle::new();
    let (tx, mut rx) = watch::channel(());
    let (terminated_tx, terminated_rx) = watch::channel(false);

    // Bridge the watch channel to axum-server's graceful_shutdown.
    let shutdown_target = server_handle.clone();
    tokio::spawn(async move {
        if rx.changed().await.is_ok() {
            begin_draining();
            shutdown_target.graceful_shutdown(Some(MAX_DRAIN_DURATION));
        }
    });

    let serve_handle = server_handle.clone();
    tokio::spawn(async move {
        // `into_make_service_with_connect_info::<SocketAddr>()` so the
        // `pre_auth_rate_limit` middleware can extract the peer IP for its
        // per-source-IP token bucket (see `middleware::pre_auth_rate_limit`).
        // axum-server 0.8 made `from_tcp_rustls` fallible (it now builds the
        // rustls acceptor eagerly), so unwrap the `Result` before chaining.
        let server = match axum_server::from_tcp_rustls(std_listener, rustls_config) {
            Ok(server) => server,
            Err(e) => {
                log::warn!("companion-api server failed to build TLS acceptor: {e}");
                return;
            }
        };
        let result = server
            .handle(serve_handle)
            .serve(app.into_make_service_with_connect_info::<SocketAddr>())
            .await;

        if let Err(e) = result {
            log::warn!("companion-api server exited with error: {e}");
        }
        let _ = terminated_tx.send(true);
    });

    Ok(ServerHandle {
        bound_port,
        shutdown: tx,
        terminated: terminated_rx,
    })
}

/// Build the axum `Router` for the companion API.
///
/// Extracted so tests can call it without binding a TCP port via
/// `Router::oneshot`.
///
/// # Route structure
///
/// ```text
/// auth routes — pre_auth_rate_limit (per-source-IP token bucket)
///   POST /api/auth/device/challenge
///   POST /api/auth/device/register
///   POST /api/auth/token
///   POST /api/auth/socket-ticket
///
/// public routes — no authentication
///   GET  /healthz
///
/// device routes — device access token plus DPoP proof
///   GET  /api/whoami
///   POST /api/_rpc/{name}
///   GET  /ws/events
/// ```
pub fn build_router(state: SharedState) -> Router {
    build_router_for_mode(state, super::deployment::deployment_mode())
}

fn build_router_for_mode(state: SharedState, _mode: super::deployment::DeploymentMode) -> Router {
    // Unmetered public routes — no rate limit, no JWT. Used for service
    // discovery only; do not add anything sensitive here.
    let unmetered_public_routes = Router::new()
        // Public health/discovery probe. Read-only, no authentication.
        // Surfaces version, TLS fingerprint, advertised port, and a
        // stable installation identifier so mobile clients can detect
        // cert rotation and confirm they're talking to the right
        // desktop. See `healthz` module docs.
        .route("/healthz", get(healthz::healthz_handler))
        .route("/livez", get(healthz::livez_handler))
        .route("/readyz", get(healthz::readyz_handler))
        // A2A Agent Card (a2a-protocol.org) — public discovery document. Read
        // only, discovery-safe fields only; the A2A endpoint itself (`/a2a`)
        // requires a DPoP-bound device access token below.
        .route(
            "/.well-known/agent-card.json",
            get(a2a::a2a_agent_card_handler),
        );

    let operator_routes = Router::new()
        .route("/metrics", get(super::metrics::metrics_handler))
        .route(
            "/operator/maintenance/backups",
            post(super::maintenance::backup_handler),
        )
        .layer(from_fn(middleware::require_loopback_operator));

    // Canonical device routes — short-lived key-bound token + DPoP.
    //
    // The WS upgrade route uses `any()` rather than `get()` so it handles both
    // HTTP/1.1 GET upgrades and HTTP/2 CONNECT upgrades transparently.
    // It is intentionally outside the `RequestBodyLimitLayer` applied below
    // because that layer can interfere with the WS upgrade handshake.
    let device_routes = Router::new()
        .route("/api/whoami", get(super::api::whoami_handler))
        .route("/api/_rpc/{name}", post(super::api::rpc_handler))
        .route(
            "/api/sessions/{session_id}/media/{hash}",
            get(super::session_media::session_media_handler),
        )
        .route(
            "/api/operations/{operation_id}",
            get(super::api::operation_handler),
        )
        .route(
            "/api/workflow-deployments/{deployment_id}/runs",
            post(super::workflow_api::create_run_handler),
        )
        .route(
            "/api/workflow-runs/{run_id}",
            get(super::workflow_api::get_run_handler),
        )
        .route(
            "/api/workflow-runs/{run_id}/events",
            get(super::workflow_api::events_handler),
        )
        .route(
            "/api/workflow-runs/{run_id}/cancel",
            post(super::workflow_api::cancel_run_handler),
        )
        // Remote Pro IDE relay. The companion owns code-server and revalidates
        // the paired device on every HTTP request and WebSocket upgrade.
        .route(
            "/ide/relay/{relay_id}",
            any(crate::codeserver::remote::relay_root_handler),
        )
        .route(
            "/ide/relay/{relay_id}/",
            any(crate::codeserver::remote::relay_root_handler),
        )
        .route(
            "/ide/relay/{relay_id}/{*tail}",
            any(crate::codeserver::remote::relay_handler),
        )
        // A2A server (Agent2Agent, a2a-protocol.org) — external agents drive
        // cognia over JSON-RPC. Same baseline-chat trust model as ACP: reaches
        // `claude_*` commands through `remote_execution`, so a device access
        // token plus DPoP proof suffices.
        .route("/a2a", post(a2a::a2a_rpc_handler))
        .layer(from_fn_with_state(
            state.clone(),
            super::api::require_device_access,
        ));

    let owner_routes = Router::new()
        .route("/api/devices", get(super::api::devices_handler))
        .route(
            "/api/devices/{device_id}",
            delete(super::api::revoke_device_handler),
        )
        .route(
            "/api/devices/{device_id}/capabilities",
            put(super::api::replace_device_capabilities_handler),
        )
        .route("/api/invitations", post(super::api::invitation_handler))
        .route(
            "/api/policies",
            get(super::api::policies_handler).post(super::api::create_policy_handler),
        )
        .layer(from_fn_with_state(
            state.clone(),
            super::api::require_owner_access,
        ));

    // Loopback/service-token traffic is deliberately isolated from the device
    // plane. It retains its service-principal authentication while sharing the
    // same command execution authority.
    let internal_routes = Router::new()
        .route("/internal/bridge", any(ws_bridge::ws_bridge_handler))
        .route("/internal/events", any(ws::internal_ws_handler))
        .route(
            "/internal/_rpc/{name}",
            post(super::api::internal_rpc_handler),
        )
        .route(
            "/internal/operations/{operation_id}",
            get(super::api::internal_operation_handler),
        )
        .layer(from_fn_with_state(
            state.clone(),
            middleware::require_service_jwt,
        ))
        .layer(from_fn(harden_internal_response));

    let operator_admin_routes = Router::new()
        .route("/operator/lark/admin", post(lark_entry::admin_handler))
        .route(
            "/operator/lark/admin/{request_id}",
            get(lark_entry::admin_poll_handler),
        )
        .layer(from_fn(middleware::require_loopback_operator));

    // Lark dual-entry public surface (plan 2026-07-24) — cloned handle so the
    // headless-only nest below can outlive the `with_state` move.
    let lark_entry_state = state.clone();

    let mut router = Router::new()
        .merge(unmetered_public_routes)
        .merge(operator_routes)
        .merge(operator_admin_routes)
        .merge(super::api::router())
        .route("/ws/events", any(ws::ws_handler))
        // ACP upgrades redeem a path-bound, single-use socket ticket. The
        // ticket identity and capability snapshot are passed into the shared
        // remote execution authority by the protocol adapter.
        .route("/ws/acp", any(acp::acp_handler))
        .merge(device_routes)
        .merge(owner_routes)
        .merge(internal_routes)
        // Browser stream upgrades authenticate with a 60-second, single-use
        // ticket obtained through the protected route above. Long-lived JWTs
        // are deliberately never placed in the WebSocket URL.
        .route(
            "/ws/browser/{session_id}",
            any(super::browser_gateway::browser_ws_handler),
        )
        // Terminal upgrades use the same single-use-ticket pattern as the
        // browser stream, so a bearer access token never enters the URL.
        .route("/ws/terminal", any(ws_terminal::ws_terminal_handler))
        .with_state(state.clone());

    // Fleet ingress (`/api/fleet/*`) — its own auth tier: loopback-source
    // + shared fleet token (see `fleet::routes`). Neither Companion device auth (hook
    // scripts have no pairing) nor pre-auth rate limit (events fire on every
    // tool call and are already token-gated). Merged after `with_state`
    // because the fleet router is stateless (process-global runtime).
    router = router.merge(crate::fleet::routes::router());

    // Public connector webhook ingress (ADR-0059 F4 / R12) — headless only.
    // Deliberately OUTSIDE the JWT middleware: webhook auth is the platform
    // HMAC/signature + replay guard inside `connectors::axum_app`. It still
    // sits inside the pre-auth per-source-IP rate limit and (below) the body
    // cap. Events publish onto the EventBus → `/ws/events` → the brain's
    // connector runtime, retiring the cloudflared-tunnel requirement for
    // cloud installs. Nested after `with_state` because the connectors
    // router carries its own (already-resolved) `ConnectorsState`.
    if let Some(services) = crate::headless::headless_services() {
        let emitter: std::sync::Arc<dyn crate::connectors::axum_app::EventEmitter> =
            std::sync::Arc::new(crate::companion_api::event_bus::ConnectorEventEmitter(
                std::sync::Arc::clone(&services.event_bus),
            ));
        let connectors_router =
            crate::connectors::axum_app::build_router(services.connectors.clone(), emitter)
                .layer(from_fn(middleware::pre_auth_rate_limit));
        router = router.nest("/connectors", connectors_router);

        // Lark dual-entry surface (plan 2026-07-24 P3): web SSO, entry-token
        // resolution, and intent polling. Public by design (SSO happens before
        // any token exists) but headless-only and rate-limited; tokens are
        // HS256 over the companion secret, and the app secret never leaves
        // the Rust process (code exchange happens in `lark_entry.rs`).
        let lark_router = crate::companion_api::lark_entry::router(lark_entry_state)
            .layer(from_fn(middleware::pre_auth_rate_limit));
        router = router.nest("/integrations/lark", lark_router);

        let mcp_oauth_router = Router::new()
            .route(
                "/oauth/callback",
                get(crate::mcp_oauth::headless_callback_handler),
            )
            .with_state(state.clone())
            .layer(from_fn(middleware::pre_auth_rate_limit));
        router = router.nest("/integrations/mcp", mcp_oauth_router);
    }

    // Body-size limit applied to all routes (incl. the ingress — Lark/Slack
    // webhook bodies fit comfortably under 64 KiB). JWT payloads are tiny;
    // the generous limit leaves room for future multipart (M4.6 push-token).
    let router = router
        .layer(RequestBodyLimitLayer::new(BODY_LIMIT_BYTES))
        .layer(from_fn(reject_mutations_while_draining));
    if crate::headless::headless_services().is_none() {
        return router.layer(from_fn_with_state(
            super::web_origin::WebOriginPolicy::from_env(),
            super::web_origin::enforce,
        ));
    }
    // Raw broker content deliberately sits outside the default JSON/webhook
    // body limit. It has its own 64 MiB cap and requires the same loopback-only
    // service principal as the other Headless routes.
    let content_router = Router::new()
        .route(
            "/ide/content",
            post(crate::codeserver::content_bridge::upload_content),
        )
        .route(
            "/ide/content/{handle_id}",
            get(crate::codeserver::content_bridge::redeem_content),
        )
        .layer(RequestBodyLimitLayer::new(64 * 1024 * 1024))
        .layer(from_fn_with_state(
            state.clone(),
            middleware::require_service_jwt,
        ))
        .layer(from_fn(reject_mutations_while_draining))
        .with_state(state);
    router.merge(content_router).layer(from_fn_with_state(
        super::web_origin::WebOriginPolicy::from_env(),
        super::web_origin::enforce,
    ))
}

async fn reject_mutations_while_draining(request: Request, next: Next) -> Response {
    let mutating = !matches!(
        request.method(),
        &Method::GET | &Method::HEAD | &Method::OPTIONS
    );
    let maintenance = request.uri().path() == "/operator/maintenance/backups";
    if !mutating || maintenance {
        return next.run(request).await;
    }
    if !is_accepting_writes() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [("retry-after", "300")],
            "server is draining",
        )
            .into_response();
    }
    ACTIVE_MUTATIONS.fetch_add(1, Ordering::SeqCst);
    let active = ActiveMutationGuard;
    if !is_accepting_writes() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [("retry-after", "300")],
            "server is draining",
        )
            .into_response();
    }
    let response = next.run(request).await;
    drop(active);
    response
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{tls, CompanionState};
    use parking_lot::RwLock;
    use std::sync::Arc;
    use tempfile::TempDir;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";
    static SERVER_LIFECYCLE_TEST_LOCK: once_cell::sync::Lazy<tokio::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));

    struct DrainingReset;

    impl Drop for DrainingReset {
        fn drop(&mut self) {
            set_draining_for_test(false);
        }
    }

    fn test_state() -> SharedState {
        use crate::companion_api::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache,
        };
        Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        })
    }

    /// Generate a fresh TLS cert in a tempdir for tests. Returns the tempdir
    /// so the caller keeps it alive for the duration of the test.
    fn test_tls() -> (TempDir, TlsMaterial) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mat = tls::ensure_certificate(tmp.path()).expect("ensure_certificate");
        (tmp, mat)
    }

    fn insecure_client() -> reqwest::Client {
        // `.no_proxy()` so the loopback HTTPS request goes straight to the
        // in-process listener rather than through any ambient system proxy.
        reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .no_proxy()
            .build()
            .expect("reqwest client")
    }

    async fn shutdown_and_wait(mut handle: ServerHandle) {
        let _ = handle.shutdown.send(());
        if !*handle.terminated.borrow() {
            let _ = handle.terminated.changed().await;
        }
        set_draining_for_test(false);
    }

    // ── Smoke: spawn + immediate shutdown ────────────────────────────────

    #[tokio::test]
    async fn spawn_and_shutdown_loopback() {
        let _guard = SERVER_LIFECYCLE_TEST_LOCK.lock().await;
        let state = test_state();
        let (_tmp, tls_mat) = test_tls();
        let handle = spawn_server(0, true, tls_mat, state)
            .await
            .expect("spawn on ephemeral port");
        assert!(handle.bound_port > 0);
        // Graceful shutdown must not hang.
        shutdown_and_wait(handle).await;
    }

    #[tokio::test]
    async fn spawn_and_shutdown_unspecified() {
        let _guard = SERVER_LIFECYCLE_TEST_LOCK.lock().await;
        let state = test_state();
        let (_tmp, tls_mat) = test_tls();
        let handle = spawn_server(0, false, tls_mat, state)
            .await
            .expect("spawn on ephemeral port");
        assert!(handle.bound_port > 0);
        shutdown_and_wait(handle).await;
    }

    // ── HTTPS smoke via reqwest with cert pinning bypass ──────────────────

    #[tokio::test]
    async fn challenge_fails_closed_without_security_store_after_spawn() {
        let _guard = SERVER_LIFECYCLE_TEST_LOCK.lock().await;
        let state = test_state();
        let (_tmp, tls_mat) = test_tls();
        let handle = spawn_server(0, true, tls_mat, state).await.expect("spawn");

        let url = format!(
            "https://127.0.0.1:{}/api/auth/device/challenge",
            handle.bound_port
        );
        let client = insecure_client();
        let resp = client
            .post(&url)
            .json(&serde_json::json!({ "accountId": ACCOUNT_ID }))
            .send()
            .await
            .expect("POST /api/auth/device/challenge over HTTPS");
        assert_eq!(resp.status().as_u16(), 503);

        shutdown_and_wait(handle).await;
    }

    #[tokio::test]
    async fn https_rejects_plain_http_clients() {
        let _guard = SERVER_LIFECYCLE_TEST_LOCK.lock().await;
        // Verify the listener is actually HTTPS — a plain HTTP request must fail.
        let state = test_state();
        let (_tmp, tls_mat) = test_tls();
        let handle = spawn_server(0, true, tls_mat, state).await.expect("spawn");

        let url = format!(
            "http://127.0.0.1:{}/api/auth/device/challenge",
            handle.bound_port
        );
        // `.no_proxy()` is essential: the default reqwest client honours the
        // ambient `HTTP_PROXY`/`http_proxy` env, and a system proxy would
        // intercept this plaintext request and answer 502 instead of letting
        // it hit (and be rejected by) the TLS listener — making the test
        // depend on the developer's proxy configuration. We want a direct,
        // proxy-free connection so the handshake mismatch is what fails.
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("reqwest client");
        let result = client
            .post(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        assert!(
            result.is_err(),
            "plain HTTP must not succeed against HTTPS listener"
        );

        shutdown_and_wait(handle).await;
    }

    #[tokio::test]
    async fn multi_tenant_mode_does_not_mount_legacy_pairing_routes() {
        use tower::ServiceExt as _;

        let router = build_router_for_mode(
            test_state(),
            crate::companion_api::deployment::DeploymentMode::MultiTenant,
        );
        let mut request = axum::http::Request::builder()
            .method("POST")
            .uri("/api/auth/pair/issue")
            .body(axum::body::Body::from("{}"))
            .unwrap();
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [127, 0, 0, 1],
                34567,
            ))));

        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn released_terminal_ticket_route_is_removed() {
        use tower::ServiceExt as _;

        let response = build_router_for_mode(
            test_state(),
            crate::companion_api::deployment::DeploymentMode::SingleUser,
        )
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/v1/terminal/socket-ticket")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn canonical_routes_are_unversioned_and_versioned_aliases_are_absent() {
        use tower::ServiceExt as _;

        async fn status(path: &str, method: &str) -> StatusCode {
            let mut request = axum::http::Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(axum::body::Body::from("{}"))
                .unwrap();
            request.extensions_mut().insert(axum::extract::ConnectInfo(
                std::net::SocketAddr::from(([127, 0, 0, 1], 34567)),
            ));
            build_router(test_state())
                .oneshot(request)
                .await
                .unwrap()
                .status()
        }

        for (path, method) in [
            ("/healthz", "GET"),
            ("/api/auth/device/challenge", "POST"),
            ("/api/_rpc/claude_sidecar_status", "POST"),
            ("/ws/events", "GET"),
        ] {
            assert_ne!(status(path, method).await, StatusCode::NOT_FOUND, "{path}");
        }

        for (path, method) in [
            ("/api/v1/healthz", "GET"),
            ("/api/v1/auth/pair/issue", "POST"),
            ("/api/v1/_rpc/claude_sidecar_status", "POST"),
            ("/api/v1/terminal/socket-ticket", "POST"),
            ("/api/v2/auth/device/challenge", "POST"),
            ("/api/v2/_rpc/claude_sidecar_status", "POST"),
            ("/ws/v1/events", "GET"),
            ("/ws/v1/terminal", "GET"),
            ("/ws/v2/events", "GET"),
        ] {
            assert_eq!(status(path, method).await, StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[tokio::test]
    async fn internal_rpc_rejects_device_scoped_jwt_even_from_loopback() {
        use tower::ServiceExt as _;

        let jwt = crate::companion_api::jwt::issue_device_jwt(SECRET, "device-a", ACCOUNT_ID)
            .expect("device token");
        let mut request = axum::http::Request::builder()
            .method("POST")
            .uri("/internal/_rpc/claude_sidecar_status")
            .header("authorization", format!("Bearer {jwt}"))
            .header("content-type", "application/json")
            .body(axum::body::Body::from("{}"))
            .unwrap();
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [127, 0, 0, 1],
                34567,
            ))));

        let response = build_router(test_state()).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store"))
        );
        assert_eq!(
            response.headers().get(header::REFERRER_POLICY),
            Some(&HeaderValue::from_static("no-referrer"))
        );
        let contract =
            crate::companion_api::command_manifest::headless_contract().expect("embedded contract");
        assert_eq!(
            response
                .headers()
                .get("x-cognia-headless-catalog-hash")
                .and_then(|value| value.to_str().ok()),
            Some(contract.catalog_hash())
        );
        assert_eq!(
            response
                .headers()
                .get("x-cognia-headless-contract-version")
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
    }

    #[tokio::test]
    async fn legacy_terminal_websocket_route_is_removed() {
        use tower::ServiceExt as _;

        let response = build_router(test_state())
            .oneshot(
                axum::http::Request::builder()
                    .uri("/ws/v1/terminal")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn session_media_routes_require_device_authentication() {
        use tower::ServiceExt as _;

        for path in [format!("/api/sessions/s1/media/{}", "a".repeat(64))] {
            let mut request = axum::http::Request::builder()
                .uri(path)
                .body(axum::body::Body::empty())
                .unwrap();
            request.extensions_mut().insert(axum::extract::ConnectInfo(
                std::net::SocketAddr::from(([127, 0, 0, 1], 34567)),
            ));
            let response = build_router(test_state()).oneshot(request).await.unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
        }
    }

    /// ADR-0059 F4/R12: the public `/connectors` ingress mounts only on
    /// headless installs; on desktop the route does not exist.
    #[tokio::test]
    async fn connectors_ingress_mounts_only_when_headless() {
        use tower::ServiceExt as _;
        // The headless-services slot is process-global; serialize with the
        // other global-slot tests.
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;

        crate::headless::install_headless_services(None);
        let router = build_router(test_state());
        let resp = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/connectors/health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // No ingress on desktop: `/connectors/*` is never nested, so the path
        // matches no route and hits axum's default fallback → 404. The
        // load-bearing half of the assertion is "not 200"; 404 (route absent)
        // is the correct signal that the ingress isn't mounted. Genuinely
        // protected routes (acp/a2a/whoami) still return 401 via their JWT
        // layer — see `acp_route_requires_socket_ticket`.
        assert_eq!(resp.status().as_u16(), 404, "desktop has no ingress");

        // The pre-auth rate limiter requires a peer address; oneshot has no
        // TCP connection, so inject ConnectInfo the way the make-service
        // would.
        let peer = axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 34567)));

        crate::headless::install_headless_services(Some(
            crate::headless::HeadlessServices::stub_for_tests(),
        ));
        let router = build_router(test_state());
        let resp = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/connectors/health")
                    .extension(peer.clone())
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200, "headless mounts the ingress");

        // Deterministic rejection shape for an unregistered adapter — what
        // the tier-2 smoke asserts against.
        let router = build_router(test_state());
        let resp = router
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/connectors/webhook/telegram/ghost")
                    .extension(peer.clone())
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 404, "unregistered adapter → 404");

        let resp = build_router(test_state())
            .oneshot(
                axum::http::Request::builder()
                    .uri("/integrations/mcp/oauth/callback")
                    .extension(peer)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::BAD_REQUEST,
            "headless mounts the public MCP OAuth callback"
        );

        crate::headless::install_headless_services(None);
    }

    /// `/ws/acp` accepts only the canonical single-use socket ticket.
    #[tokio::test]
    async fn acp_route_requires_socket_ticket() {
        use tower::ServiceExt as _;
        let router = build_router(test_state());
        let resp = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/ws/acp")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 400, "missing ticket query → 400");
    }

    /// `/a2a` sits in the protected block: without a DPoP-bound device access
    /// token the middleware rejects the request before the handler runs.
    #[tokio::test]
    async fn a2a_route_requires_dpop_device_access() {
        use tower::ServiceExt as _;
        let router = build_router(test_state());
        let resp = router
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/a2a")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 401, "no token → 401");
    }

    #[tokio::test]
    async fn workflow_api_routes_are_protected_and_unversioned() {
        use tower::ServiceExt as _;

        let response = build_router(test_state())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/workflow-deployments/deployment-1/runs")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(r#"{\"input\":{}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn browser_socket_uses_only_the_unversioned_path() {
        use tower::ServiceExt as _;

        let canonical = build_router(test_state())
            .oneshot(
                axum::http::Request::builder()
                    .uri("/ws/browser/session-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(canonical.status(), StatusCode::NOT_FOUND);

        let legacy = build_router(test_state())
            .oneshot(
                axum::http::Request::builder()
                    .uri("/ws/v1/browser/session-1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(legacy.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a2a_agent_card_is_public() {
        use tower::ServiceExt as _;
        let router = build_router(test_state());
        let resp = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/.well-known/agent-card.json")
                    .header("host", "example.com:7890")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200, "agent card is public");
    }

    #[tokio::test]
    async fn draining_rejects_new_mutations_but_keeps_probes_available() {
        use tower::ServiceExt as _;
        let _guard = SERVER_LIFECYCLE_TEST_LOCK.lock().await;
        set_draining_for_test(true);
        let _reset = DrainingReset;
        let router = build_router(test_state());
        let mutation = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/auth/device/challenge")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(mutation.status(), StatusCode::SERVICE_UNAVAILABLE);

        let live = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/livez")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(live.status(), StatusCode::OK);
    }

    #[test]
    fn body_limit_is_64_kib() {
        assert_eq!(BODY_LIMIT_BYTES, 64 * 1024);
    }

    #[test]
    fn default_port_avoids_known_proxy_ports() {
        assert_eq!(DEFAULT_PORT, 27890);
        // Guard against regressing back into the Clash/V2Ray default range —
        // every entry in proxy_config's known-port probe list is off-limits.
        for (port, _, _) in crate::proxy_config::detect::KNOWN_PORTS {
            assert_ne!(
                DEFAULT_PORT, *port,
                "DEFAULT_PORT collides with a known proxy port"
            );
        }
    }
}
