//! Axum HTTP server for the companion API (`/api/v1/*`).
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
//! loopback-only so the pair/issue endpoint is safe before the LAN-bind toggle
//! lands.
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
use std::time::Duration;

use super::{a2a, acp, healthz, rpc, tls::TlsMaterial, ws, ws_bridge, ws_terminal};
use axum::{
    middleware::{from_fn, from_fn_with_state},
    routing::{any, delete, get, post},
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;

use super::{auth, lark_entry, middleware, SharedState};

/// 64 KiB — pair request bodies are tiny; the generous limit leaves room for
/// future endpoints (e.g., push-token registration in M4.6).
const BODY_LIMIT_BYTES: usize = 64 * 1024;

/// Default companion API port.  Configurable via `companion_server_start`.
/// Used by M2.8 settings UI.
///
/// 27890 — deliberately outside the 789x range: 7890/7891 are the Clash
/// mixed/SOCKS defaults (see `proxy_config::detect::KNOWN_PORTS`), so binding
/// there collides with FlClash/Clash Verge on developer machines.
pub const DEFAULT_PORT: u16 = 27890;

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

    // Bridge the watch channel to axum-server's graceful_shutdown.
    let shutdown_target = server_handle.clone();
    tokio::spawn(async move {
        if rx.changed().await.is_ok() {
            shutdown_target.graceful_shutdown(Some(Duration::from_secs(10)));
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
    });

    Ok(ServerHandle {
        bound_port,
        shutdown: tx,
    })
}

/// Build the axum `Router` for the companion API.
///
/// Extracted so tests can call it without binding a TCP port (via
/// `Router::oneshot`).  M2.5 will add `/api/v1/_rpc/:name`; M2.6 will add
/// the WS upgrade route.
///
/// # Route structure
///
/// ```text
/// metered_pre_auth_routes  — pre_auth_rate_limit (per-source-IP token bucket)
///   POST /api/v1/auth/pair/issue
///   POST /api/v1/auth/pair
///   POST /api/v1/auth/pair/redeem-code
///
/// unmetered_public_routes  — no middleware
///   GET  /api/v1/healthz    — service discovery, read-only
///
/// protected_routes — require_device_jwt middleware applied
///   GET  /api/v1/whoami   — identity check for the mobile app post-pair
/// ```
pub fn build_router(state: SharedState) -> Router {
    build_router_for_mode(state, super::deployment::deployment_mode())
}

fn build_router_for_mode(state: SharedState, mode: super::deployment::DeploymentMode) -> Router {
    // Pre-auth POST routes that can be brute-forced from the LAN — gated
    // by a per-source-IP token bucket. See `middleware::pre_auth_rate_limit`
    // for the bucket parameters and rationale.
    let metered_pre_auth_routes = match mode {
        super::deployment::DeploymentMode::SingleUser => Router::new()
            .route("/api/v1/auth/pair/issue", post(auth::issue_handler))
            .route("/api/v1/auth/pair", post(auth::pair_handler))
            // 6-digit numeric code redemption path. Same trust model as
            // `/api/v1/auth/pair` (callable from the phone over LAN); we
            // resolve `code -> pair_jwt` server-side then run the same
            // redeem logic. The 6-digit keyspace (~900K codes) makes this the
            // primary brute-force target — see the docstring on
            // `middleware::pre_auth_rate_limit`.
            .route(
                "/api/v1/auth/pair/redeem-code",
                post(auth::redeem_code_handler),
            )
            .layer(from_fn(middleware::pre_auth_rate_limit)),
        super::deployment::DeploymentMode::MultiTenant => Router::new(),
    };

    // Unmetered public routes — no rate limit, no JWT. Used for service
    // discovery only; do not add anything sensitive here.
    let unmetered_public_routes = Router::new()
        // Public health/discovery probe. Read-only, no authentication.
        // Surfaces version, TLS fingerprint, advertised port, and a
        // stable installation identifier so mobile clients can detect
        // cert rotation and confirm they're talking to the right
        // desktop. See `healthz` module docs.
        .route("/api/v1/healthz", get(healthz::healthz_handler))
        // A2A Agent Card (a2a-protocol.org) — public discovery document. Read
        // only, discovery-safe fields only; the A2A endpoint itself (`/a2a`)
        // is device-JWT gated below.
        .route(
            "/.well-known/agent-card.json",
            get(a2a::a2a_agent_card_handler),
        );

    let operator_routes = Router::new()
        .route("/metrics", get(super::metrics::metrics_handler))
        .layer(from_fn(middleware::require_loopback_operator));

    // Authenticated routes — JWT verifier middleware applied.
    //
    // The WS upgrade route uses `any()` rather than `get()` so it handles both
    // HTTP/1.1 GET upgrades and HTTP/2 CONNECT upgrades transparently.
    // It is intentionally outside the `RequestBodyLimitLayer` applied below
    // because that layer can interfere with the WS upgrade handshake.
    let protected_routes = Router::new()
        .route("/api/v1/whoami", get(auth::whoami_handler))
        .route("/api/v1/_rpc/{name}", post(rpc::rpc_handler))
        .route(
            "/api/v1/browser/stream-ticket",
            post(super::browser_gateway::issue_ticket_handler),
        )
        .route(
            "/api/v1/terminal/socket-ticket",
            post(ws_terminal::issue_ticket_handler),
        )
        // Legacy JSON/raw-byte terminal protocol. Keep this behind device-JWT
        // middleware for released clients while `/ws/terminal` uses tickets
        // and canonical binary frames.
        .route(
            "/ws/v1/terminal",
            any(ws_terminal::legacy_ws_terminal_handler),
        )
        .route("/ws/v1/events", any(ws::ws_handler))
        // Headless-brain data plane (ADR-0059 W3). The JWT middleware already
        // enforces loopback for service-scope tokens; the handler additionally
        // rejects non-service scopes before the upgrade.
        .route("/ws/v1/bridge", any(ws_bridge::ws_bridge_handler))
        // Remote Pro IDE relay. The companion owns code-server and revalidates
        // the paired device on every HTTP request and WebSocket upgrade.
        .route(
            "/ide/v1/relay/{relay_id}",
            any(crate::codeserver::remote::relay_root_handler),
        )
        .route(
            "/ide/v1/relay/{relay_id}/",
            any(crate::codeserver::remote::relay_root_handler),
        )
        .route(
            "/ide/v1/relay/{relay_id}/{*tail}",
            any(crate::codeserver::remote::relay_handler),
        )
        // ACP server (Agent Client Protocol) — external editors drive cognia
        // Claude sessions over JSON-RPC. Baseline-chat surface only (the
        // handler reaches `claude_*` arms through `rpc::dispatch`, whose
        // control/service gates still apply), so a device JWT suffices.
        .route("/ws/v1/acp", any(acp::acp_handler))
        // A2A server (Agent2Agent, a2a-protocol.org) — external agents drive
        // cognia over JSON-RPC. Same baseline-chat trust model as ACP: reaches
        // `claude_*` arms through `rpc::dispatch`, so a device JWT suffices.
        .route("/a2a", post(a2a::a2a_rpc_handler))
        // Feishu principal-registry admin (`cognia lark …`). Deliberately here
        // rather than in the public `/integrations/lark` nest: this tier
        // already accepts the headless brain's loopback-only service token,
        // which is exactly the trust level an operator channel needs.
        .route("/api/v1/lark/admin", post(lark_entry::admin_handler))
        .route(
            "/api/v1/lark/admin/{request_id}",
            get(lark_entry::admin_poll_handler),
        )
        .layer(from_fn_with_state(
            state.clone(),
            middleware::require_device_jwt,
        ));

    // v2 keeps the v1 RPC payload shape for one compatibility release, but
    // replaces its authentication and authorization completely: short-lived
    // key-bound access token, per-request DPoP proof, manifest capability,
    // transport target, and UUID idempotency enforcement.
    let v2_protected_routes = Router::new()
        .route("/api/v2/_rpc/{name}", post(super::v2::rpc_handler))
        .layer(from_fn_with_state(
            state.clone(),
            super::v2::require_device_access,
        ));
    let v2_owner_routes = Router::new()
        .route("/api/v2/devices", get(super::v2::devices_handler))
        .route(
            "/api/v2/devices/{device_id}",
            delete(super::v2::revoke_device_handler),
        )
        .route("/api/v2/invitations", post(super::v2::invitation_handler))
        .route(
            "/api/v2/policies",
            get(super::v2::policies_handler).post(super::v2::create_policy_handler),
        )
        .layer(from_fn_with_state(
            state.clone(),
            super::v2::require_owner_access,
        ));

    // Lark dual-entry public surface (plan 2026-07-24) — cloned handle so the
    // headless-only nest below can outlive the `with_state` move.
    let lark_entry_state = state.clone();

    let mut router = Router::new()
        .merge(metered_pre_auth_routes)
        .merge(unmetered_public_routes)
        .merge(operator_routes)
        .merge(super::v2::router())
        .route("/ws/v2/events", any(ws::ws_v2_handler))
        .merge(v2_protected_routes)
        .merge(v2_owner_routes)
        // Browser stream upgrades authenticate with a 60-second, single-use
        // ticket obtained through the protected route above. Long-lived JWTs
        // are deliberately never placed in the WebSocket URL.
        .route(
            "/ws/v1/browser/{session_id}",
            any(super::browser_gateway::browser_ws_handler),
        )
        // Terminal upgrades use the same single-use-ticket pattern as the
        // browser stream, so a long-lived device JWT never enters the URL.
        .route("/ws/terminal", any(ws_terminal::ws_terminal_handler))
        .merge(protected_routes)
        .with_state(state.clone());

    // Fleet ingress (`/api/v1/fleet/*`) — its own auth tier: loopback-source
    // + shared fleet token (see `fleet::routes`). Neither device-JWT (hook
    // scripts have no pairing) nor pre-auth rate limit (events fire on every
    // tool call and are already token-gated). Merged after `with_state`
    // because the fleet router is stateless (process-global runtime).
    router = router.merge(crate::fleet::routes::router());

    // Public connector webhook ingress (ADR-0059 F4 / R12) — headless only.
    // Deliberately OUTSIDE the JWT middleware: webhook auth is the platform
    // HMAC/signature + replay guard inside `connectors::axum_app`. It still
    // sits inside the pre-auth per-source-IP rate limit and (below) the body
    // cap. Events publish onto the EventBus → `/ws/v1/events` → the brain's
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
    }

    // Body-size limit applied to all routes (incl. the ingress — Lark/Slack
    // webhook bodies fit comfortably under 64 KiB). JWT payloads are tiny;
    // the generous limit leaves room for future multipart (M4.6 push-token).
    let router = router.layer(RequestBodyLimitLayer::new(BODY_LIMIT_BYTES));
    if crate::headless::headless_services().is_none() {
        return router;
    }
    // Raw broker content deliberately sits outside the default JSON/webhook
    // body limit. It has its own 64 MiB cap and the same device-JWT middleware;
    // the handler additionally requires a loopback-only service-scope token.
    let content_router = Router::new()
        .route(
            "/api/v1/ide/content",
            post(crate::codeserver::content_bridge::upload_content),
        )
        .route(
            "/api/v1/ide/content/{handle_id}",
            get(crate::codeserver::content_bridge::redeem_content),
        )
        .layer(RequestBodyLimitLayer::new(64 * 1024 * 1024))
        .layer(from_fn_with_state(
            state.clone(),
            middleware::require_device_jwt,
        ))
        .with_state(state);
    router.merge(content_router)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{redemption_lru::RedemptionLru, tls, CompanionState};
    use parking_lot::RwLock;
    use std::sync::Arc;
    use tempfile::TempDir;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";

    fn test_state() -> SharedState {
        use crate::companion_api::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache,
        };
        Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
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

    async fn bind_test_router(router: Router) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test router");
        let addr = listener.local_addr().expect("test router address");
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        addr
    }

    // ── Smoke: spawn + immediate shutdown ────────────────────────────────

    #[tokio::test]
    async fn spawn_and_shutdown_loopback() {
        let state = test_state();
        let (_tmp, tls_mat) = test_tls();
        let handle = spawn_server(0, true, tls_mat, state)
            .await
            .expect("spawn on ephemeral port");
        assert!(handle.bound_port > 0);
        // Graceful shutdown must not hang.
        let _ = handle.shutdown.send(());
    }

    #[tokio::test]
    async fn spawn_and_shutdown_unspecified() {
        let state = test_state();
        let (_tmp, tls_mat) = test_tls();
        let handle = spawn_server(0, false, tls_mat, state)
            .await
            .expect("spawn on ephemeral port");
        assert!(handle.bound_port > 0);
        let _ = handle.shutdown.send(());
    }

    // ── HTTPS smoke via reqwest with cert pinning bypass ──────────────────

    #[tokio::test]
    async fn issue_reachable_after_spawn() {
        let state = test_state();
        let (_tmp, tls_mat) = test_tls();
        let handle = spawn_server(0, true, tls_mat, state).await.expect("spawn");

        let url = format!(
            "https://127.0.0.1:{}/api/v1/auth/pair/issue",
            handle.bound_port
        );
        let client = insecure_client();
        let resp = client
            .post(&url)
            .json(&serde_json::json!({ "accountId": ACCOUNT_ID }))
            .send()
            .await
            .expect("POST /api/v1/auth/pair/issue over HTTPS");
        assert_eq!(resp.status().as_u16(), 200);

        let _ = handle.shutdown.send(());
    }

    #[tokio::test]
    async fn https_rejects_plain_http_clients() {
        // Verify the listener is actually HTTPS — a plain HTTP request must fail.
        let state = test_state();
        let (_tmp, tls_mat) = test_tls();
        let handle = spawn_server(0, true, tls_mat, state).await.expect("spawn");

        let url = format!(
            "http://127.0.0.1:{}/api/v1/auth/pair/issue",
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

        let _ = handle.shutdown.send(());
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
            .uri("/api/v1/auth/pair/issue")
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
    async fn legacy_terminal_websocket_route_remains_mounted() {
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

        assert_ne!(response.status(), axum::http::StatusCode::NOT_FOUND);
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
        // layer — see `acp_route_requires_device_jwt`.
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
                    .extension(peer)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 404, "unregistered adapter → 404");

        crate::headless::install_headless_services(None);
    }

    /// `/ws/v1/acp` sits in the protected block: without a device JWT the
    /// middleware rejects the upgrade before the handler runs.
    #[tokio::test]
    async fn acp_route_requires_device_jwt() {
        use tower::ServiceExt as _;
        let router = build_router(test_state());
        let resp = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/ws/v1/acp")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 401, "no token → 401 before upgrade");
    }

    /// `/a2a` sits in the protected block: without a device JWT the middleware
    /// rejects the request before the handler runs.
    #[tokio::test]
    async fn a2a_route_requires_device_jwt() {
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
    async fn browser_stream_ticket_route_is_protected_bound_and_single_use() {
        use crate::companion_api::browser_gateway::{
            gateway, BrowserBackend, EnsureBrowserSession,
        };
        use tokio_tungstenite::tungstenite::Error as WebSocketError;

        let device_id = format!("browser-route-device-{}", uuid::Uuid::new_v4());
        let session = gateway()
            .ensure_session(EnsureBrowserSession {
                account_id: ACCOUNT_ID.to_string(),
                device_id: device_id.clone(),
                chat_session_id: format!("browser-route-chat-{}", uuid::Uuid::new_v4()),
                parent_chat_session_id: None,
                workspace_id: format!("browser-route-workspace-{}", uuid::Uuid::new_v4()),
                backend: BrowserBackend::RemoteChromium,
                profile_id: None,
            })
            .expect("seed browser session");
        let state = test_state();
        let addr = bind_test_router(build_router(state)).await;
        let endpoint = format!("http://{addr}/api/v1/browser/stream-ticket");
        let client = reqwest::Client::new();

        let unauthorized = client
            .post(&endpoint)
            .json(&serde_json::json!({ "sessionId": session.id }))
            .send()
            .await
            .expect("unauthorized ticket request");
        assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);

        let jwt = crate::companion_api::jwt::issue_device_jwt(SECRET, &device_id, ACCOUNT_ID)
            .expect("issue browser route JWT");
        let issue_ticket = || {
            client
                .post(&endpoint)
                .bearer_auth(&jwt)
                .json(&serde_json::json!({ "sessionId": session.id }))
        };
        let ticket: serde_json::Value = issue_ticket()
            .send()
            .await
            .expect("ticket request")
            .error_for_status()
            .expect("ticket response")
            .json()
            .await
            .expect("ticket JSON");
        let ticket = ticket["ticket"].as_str().expect("ticket string");
        let wrong_url = format!(
            "ws://{addr}/ws/v1/browser/{}?ticket={ticket}",
            uuid::Uuid::new_v4()
        );
        match tokio_tungstenite::connect_async(&wrong_url).await {
            Err(WebSocketError::Http(response)) => {
                assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED)
            }
            other => panic!("wrong-session ticket must be rejected, got {other:?}"),
        }

        let ticket: serde_json::Value = issue_ticket()
            .send()
            .await
            .expect("replacement ticket request")
            .error_for_status()
            .expect("replacement ticket response")
            .json()
            .await
            .expect("replacement ticket JSON");
        let ticket = ticket["ticket"]
            .as_str()
            .expect("replacement ticket string");
        let stream_url = format!("ws://{addr}/ws/v1/browser/{}?ticket={ticket}", session.id);
        let (mut socket, response) = tokio_tungstenite::connect_async(&stream_url)
            .await
            .expect("valid ticket upgrades");
        assert_eq!(response.status(), reqwest::StatusCode::SWITCHING_PROTOCOLS);
        socket.close(None).await.expect("close browser stream");

        match tokio_tungstenite::connect_async(&stream_url).await {
            Err(WebSocketError::Http(response)) => {
                assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED)
            }
            other => panic!("replayed ticket must be rejected, got {other:?}"),
        }
    }

    /// The A2A Agent Card is a public discovery document — no JWT required.
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
