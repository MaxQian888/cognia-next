//! JWT verifier middleware for the companion API.
//!
//! Applied to every `/api/v1/*` route **except** the pre-auth pair endpoints.
//! Uses [`axum::middleware::from_fn_with_state`] so the handler receives the
//! full [`SharedState`] (signing secret + deny list).
//!
//! # Token extraction order
//!
//! 1. `Authorization: Bearer <jwt>` header — standard REST path.
//! 2. `?token=<jwt>` query parameter — needed for WebSocket upgrade requests
//!    (M2.6), where custom headers are not reliably supported by browsers.
//!
//! If both are present, the header takes precedence.
//!
//! # Error shape
//!
//! All failures return JSON `{ "error": { "code": "...", "message": "..." } }`
//! with HTTP 401, matching the error envelope in [`super::auth`].
//!
//! # Device attribution
//!
//! On success, [`DeviceContext`] is injected as a request extension so
//! downstream handlers can read `device_id` without re-parsing the JWT.
//!
//! # `companion://device-seen` event
//!
//! After forwarding the request, a best-effort Tauri event is emitted with
//! `{ device_id, account_id, seen_at_ms }` so the TS layer can call
//! `touchPairedDevice`.
//! Errors are silently absorbed — event delivery must not affect the response.

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;

use super::{
    jwt::{verify, JwtError},
    rate_limit::RateLimitDecision,
    SharedState,
};

// ---------------------------------------------------------------------------
// Device context (injected into request extensions)
// ---------------------------------------------------------------------------

/// Identity of the authenticated device.  Injected by [`require_device_jwt`]
/// and read by protected handlers via `request.extensions().get::<DeviceContext>()`.
#[derive(Clone, Debug)]
pub struct DeviceContext {
    pub device_id: String,
    pub account_id: String,
    /// Scope string from the JWT claims (`"device"`).  Reserved for M2.5+
    /// handlers that may need to inspect the scope.
    #[allow(dead_code)]
    pub scope: String,
}

// ---------------------------------------------------------------------------
// Query extractor (for WS upgrade path)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/// Axum middleware: verify a companion JWT and gate access to protected routes.
///
/// Accepts two scopes (ADR-0059 W4):
///   - `"device"` — a paired device (phone / browser), reachable from anywhere.
///   - `"service"` — the headless Node brain's loopback-minted token. Honored
///     ONLY when the request originates from loopback; a service token
///     presented by a remote peer is rejected (`service_token_remote`).
///
/// Wired in via `axum::middleware::from_fn_with_state(state.clone(), require_device_jwt)`.
pub async fn require_device_jwt(
    State(state): State<SharedState>,
    mut request: Request,
    next: Next,
) -> Response {
    // Peer address for the service-token loopback check. Read from extensions
    // (populated by `into_make_service_with_connect_info`) rather than a
    // `ConnectInfo` extractor param, because axum 0.8's `Option<ConnectInfo>`
    // isn't a valid extractor and a required one would 500 the bare-request
    // unit tests. Absent ⇒ treated as non-loopback, so a service token can
    // never slip through without a verified peer.
    let peer_is_loopback = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip().is_loopback())
        .unwrap_or(false);
    // ── 1. Extract token ────────────────────────────────────────────────────
    let header_token = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned);

    let query_token: Option<String> = request
        .uri()
        .query()
        .and_then(|q| serde_urlencoded::from_str::<TokenQuery>(q).ok())
        .and_then(|tq| tq.token);

    // Header takes precedence over query string.
    let token = match header_token.or(query_token) {
        Some(t) => t,
        None => {
            return error_response(
                "missing_authorization",
                "Authorization header or ?token= query parameter is required",
            );
        }
    };

    // ── 2. Verify JWT ───────────────────────────────────────────────────────
    let secret = state.secret.read().clone();
    let claims = match verify(&secret, &token, "device") {
        Ok(c) => c,
        Err(JwtError::WrongScope { .. }) => {
            // Not a device token — it may be the headless brain's service
            // token, which we honor ONLY from loopback.
            match verify(&secret, &token, "service") {
                Ok(c) => {
                    if !peer_is_loopback {
                        return error_response(
                            "service_token_remote",
                            "service-scope tokens are only honored from loopback",
                        );
                    }
                    c
                }
                Err(_) => {
                    return error_response(
                        "wrong_scope",
                        "JWT scope must be \"device\" or \"service\"",
                    );
                }
            }
        }
        Err(JwtError::WrongAccount { .. }) => {
            return error_response("wrong_account", "JWT account claim does not match");
        }
        Err(JwtError::InvalidAccountId(_)) => {
            return error_response("malformed_token", "JWT account claim is malformed");
        }
        Err(JwtError::Invalid(ref inner)) => {
            use jsonwebtoken::errors::ErrorKind;
            let code = match inner.kind() {
                ErrorKind::ExpiredSignature => "expired_token",
                _ => "invalid_signature",
            };
            return error_response(code, &inner.to_string());
        }
    };

    // ── 3. Extract account_id + device_id ───────────────────────────────────
    let account_id = match claims.account_id {
        Some(ref id) if !id.trim().is_empty() => id.clone(),
        _ => {
            return error_response(
                "malformed_token",
                "device JWT is missing the account_id claim",
            );
        }
    };

    let device_id = match claims.device_id {
        Some(ref id) => id.clone(),
        None => {
            return error_response(
                "malformed_token",
                "device JWT is missing the device_id claim",
            );
        }
    };

    // ── 4. Deny-list check ──────────────────────────────────────────────────
    if state.deny_list.is_revoked(&device_id) {
        return error_response("device_revoked", "this device has been revoked");
    }

    // ── 5. Inject context ───────────────────────────────────────────────────
    request.extensions_mut().insert(DeviceContext {
        device_id: device_id.clone(),
        account_id: account_id.clone(),
        scope: claims.scope.clone(),
    });

    // ── 6. Forward request ──────────────────────────────────────────────────
    let response = next.run(request).await;

    // ── 7. Best-effort device-seen event ────────────────────────────────────
    if let Some(app) = state.app_handle.clone() {
        let seen_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        tokio::spawn(async move {
            use tauri::Emitter as _;
            let _ = app.emit(
                "companion://device-seen",
                json!({
                    "device_id": device_id,
                    "account_id": account_id,
                    "seen_at_ms": seen_at_ms,
                }),
            );
        });
    }

    response
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/// Wave 3.1: unified flat envelope `{ code, message, details? }`.
fn error_response(code: &str, message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "code": code,
            "message": message,
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Pre-auth rate limit (defense in depth on the public_routes surface)
// ---------------------------------------------------------------------------

/// Axum middleware that token-buckets requests on the pre-auth pair surface
/// by source IP. Wired into `server::build_router` for the three POST pair
/// routes (`/auth/pair/issue`, `/auth/pair`, `/auth/pair/redeem-code`) so an
/// unauthenticated LAN peer cannot brute-force the 6-digit pair-code
/// keyspace.
///
/// Uses [`super::pre_auth_rate_limiter`] — a process-global limiter with
/// `5 burst, 20 req/min` so the many `CompanionState` test constructors
/// aren't forced to thread a per-IP limiter alongside the per-device one.
///
/// On rejection: HTTP 429 with `Retry-After` and a `{code, message}` body
/// matching the envelope shape used elsewhere in this module.
pub async fn pre_auth_rate_limit(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    // Loopback is the desktop talking to itself (e.g. the QR generator
    // calling `/auth/pair/issue`) — no realistic brute-force surface, and
    // gating it would deplete the shared bucket during integration tests
    // that issue many requests from 127.0.0.1. The threat model targets
    // *other-host* peers reachable when `bind_loopback_only=false`.
    let ip = addr.ip();
    if ip.is_loopback() {
        return next.run(request).await;
    }
    let limiter = super::pre_auth_rate_limiter();
    let key = ip.to_string();
    match limiter.check(&key) {
        RateLimitDecision::Accept => next.run(request).await,
        RateLimitDecision::Reject { retry_after } => {
            let mut resp = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "code": "rate_limited",
                    "message": "too many pair attempts, slow down",
                })),
            )
                .into_response();
            // `as_secs()` is fine — the limiter rounds up internally so the
            // value is at least 1.
            if let Ok(hv) = HeaderValue::from_str(&retry_after.as_secs().to_string()) {
                resp.headers_mut().insert("retry-after", hv);
            }
            resp
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{
        deny_list::DenyList,
        jwt::{issue_device_jwt, issue_pair_jwt, issue_service_jwt},
        redemption_lru::RedemptionLru,
        CompanionState, SharedState,
    };
    use axum::{
        body::Body,
        http::Request,
        middleware::{from_fn, from_fn_with_state},
        response::IntoResponse,
        routing::get,
        Extension, Router,
    };
    use parking_lot::RwLock;
    use std::sync::Arc;
    use tower::ServiceExt as _;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";

    fn test_state() -> SharedState {
        use crate::companion_api::{event_bus::EventBus, idempotency::IdempotencyCache};
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

    /// Minimal handler that echoes the device_id from the extension.
    async fn echo_device(Extension(ctx): Extension<DeviceContext>) -> impl IntoResponse {
        Json(json!({ "device_id": ctx.device_id, "account_id": ctx.account_id }))
    }

    fn build_router(state: SharedState) -> Router {
        Router::new()
            .route("/protected", get(echo_device))
            .layer(from_fn_with_state(state.clone(), require_device_jwt))
            .with_state(state)
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        serde_json::from_slice(&bytes).expect("json parse")
    }

    fn device_jwt(device_id: &str) -> String {
        issue_device_jwt(SECRET, device_id, ACCOUNT_ID).expect("issue device jwt")
    }

    fn pair_jwt() -> String {
        issue_pair_jwt(SECRET, ACCOUNT_ID)
            .expect("issue pair jwt")
            .0
    }

    // ── Happy path ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn valid_jwt_returns_200_with_device_id() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("device-abc");
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", format!("Bearer {jwt}"))
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert_eq!(body["device_id"], "device-abc");
        assert_eq!(body["account_id"], ACCOUNT_ID);
    }

    // ── Missing authorization ────────────────────────────────────────────────

    #[tokio::test]
    async fn missing_header_returns_401_missing_authorization() {
        let state = test_state();
        let router = build_router(state);
        let req = Request::builder()
            .uri("/protected")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "missing_authorization");
    }

    // ── Malformed JWT ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn malformed_jwt_returns_401_invalid_signature() {
        let state = test_state();
        let router = build_router(state);
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", "Bearer not.a.valid.jwt")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        // "not.a.valid.jwt" fails JSON decode → invalid_signature
        let code = body["code"].as_str().unwrap();
        assert!(
            code == "invalid_signature" || code == "malformed_token",
            "unexpected code: {code}"
        );
    }

    // ── Expired JWT ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn expired_jwt_returns_401_expired_token() {
        use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let claims = crate::companion_api::jwt::Claims {
            scope: "device".to_string(),
            iat: now - 400,
            exp: now - 300,
            jti: None,
            device_id: Some("expired-device".to_string()),
            account_id: Some(ACCOUNT_ID.to_string()),
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(SECRET),
        )
        .unwrap();

        let state = test_state();
        let router = build_router(state);
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "expired_token");
    }

    // ── Wrong scope ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn pair_scope_jwt_returns_401_wrong_scope() {
        let state = test_state();
        let router = build_router(state);
        let pair = pair_jwt();
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", format!("Bearer {pair}"))
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "wrong_scope");
    }

    // ── Revoked device ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn revoked_device_returns_401_device_revoked() {
        let state = test_state();
        state.deny_list.revoke("revoked-device".to_string());
        let router = build_router(Arc::clone(&state));
        let jwt = device_jwt("revoked-device");
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", format!("Bearer {jwt}"))
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "device_revoked");
    }

    // ── Query-string auth (WS upgrade path) ─────────────────────────────────

    #[tokio::test]
    async fn query_string_token_works() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("qs-device");
        let req = Request::builder()
            .uri(format!("/protected?token={jwt}"))
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert_eq!(body["device_id"], "qs-device");
    }

    // ── Pre-auth rate limit ──────────────────────────────────────────────────

    use axum::extract::ConnectInfo;
    use std::net::SocketAddr;

    fn build_metered_router() -> Router {
        async fn ok_handler() -> impl IntoResponse {
            Json(json!({ "ok": true }))
        }
        Router::new()
            .route("/metered", get(ok_handler))
            .layer(from_fn(super::pre_auth_rate_limit))
    }

    fn metered_request(ip: &str) -> Request<Body> {
        let mut req = Request::builder()
            .uri("/metered")
            .body(Body::empty())
            .unwrap();
        let addr: SocketAddr = format!("{ip}:54321").parse().expect("addr parses");
        req.extensions_mut().insert(ConnectInfo(addr));
        req
    }

    #[tokio::test]
    async fn loopback_bypasses_pre_auth_rate_limit() {
        let router = build_metered_router();
        // 50 sequential loopback requests — every one should pass because
        // is_loopback() short-circuits the limiter entirely. Without the
        // bypass, the shared process-global bucket would 429 after ~5.
        for i in 0..50 {
            let resp = router
                .clone()
                .oneshot(metered_request("127.0.0.1"))
                .await
                .unwrap();
            assert_eq!(resp.status().as_u16(), 200, "loopback request {i}");
        }
    }

    #[tokio::test]
    async fn non_loopback_eventually_returns_429_with_retry_after() {
        // Use a per-test IP so the shared process-global bucket starts
        // fresh from this caller's perspective.
        let ip = "192.0.2.137";
        let router = build_metered_router();

        // Drain the burst (capacity=5). Some of these are expected to
        // pass; we don't enforce an exact accept count because other
        // tests in the same process might have touched the limiter.
        for _ in 0..20 {
            let _ = router.clone().oneshot(metered_request(ip)).await.unwrap();
        }

        // After draining, at least one 429 with Retry-After must appear.
        let mut saw_429 = false;
        for _ in 0..5 {
            let resp = router.clone().oneshot(metered_request(ip)).await.unwrap();
            if resp.status().as_u16() == 429 {
                let retry_after = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok());
                assert!(
                    retry_after.unwrap_or(0) >= 1,
                    "Retry-After should be a positive integer"
                );
                let body = body_json(resp).await;
                assert_eq!(body["code"], "rate_limited");
                saw_429 = true;
                break;
            }
        }
        assert!(saw_429, "non-loopback brute force must trip the limiter");
    }

    // ── Service-scope token (ADR-0059 W4) ────────────────────────────────────

    fn service_request_from(ip: Option<&str>) -> Request<Body> {
        let jwt = issue_service_jwt(SECRET, ACCOUNT_ID).expect("issue service jwt").0;
        let mut req = Request::builder()
            .uri("/protected")
            .header("Authorization", format!("Bearer {jwt}"))
            .body(Body::empty())
            .unwrap();
        if let Some(ip) = ip {
            let addr: SocketAddr = format!("{ip}:54321").parse().unwrap();
            req.extensions_mut().insert(ConnectInfo(addr));
        }
        req
    }

    #[tokio::test]
    async fn service_jwt_from_loopback_is_accepted() {
        let router = build_router(test_state());
        let resp = router.oneshot(service_request_from(Some("127.0.0.1"))).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert_eq!(body["device_id"], crate::companion_api::jwt::SERVICE_DEVICE_ID);
    }

    #[tokio::test]
    async fn service_jwt_from_remote_peer_is_rejected() {
        let router = build_router(test_state());
        let resp = router.oneshot(service_request_from(Some("192.0.2.50"))).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "service_token_remote");
    }

    #[tokio::test]
    async fn service_jwt_without_connect_info_is_rejected() {
        // No ConnectInfo ⇒ peer unverifiable ⇒ treated as non-loopback.
        let router = build_router(test_state());
        let resp = router.oneshot(service_request_from(None)).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "service_token_remote");
    }

    // ── Header takes precedence over query string ────────────────────────────

    #[tokio::test]
    async fn header_takes_precedence_over_query_string() {
        let state = test_state();
        let router = build_router(state);

        let header_jwt = device_jwt("header-device");
        // Query carries a revoked device JWT — if header wins, should succeed.
        let query_jwt = device_jwt("query-device");

        let req = Request::builder()
            .uri(format!("/protected?token={query_jwt}"))
            .header("Authorization", format!("Bearer {header_jwt}"))
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert_eq!(body["device_id"], "header-device");
    }
}
