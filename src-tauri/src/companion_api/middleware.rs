//! JWT verifier middleware for the companion API.
//!
//! [`require_service_jwt`] is applied to the loopback Headless service plane.
//! Canonical device-key routes use the separate DPoP middleware in `api.rs`.
//! Uses [`axum::middleware::from_fn_with_state`] so the handler
//! receives the full [`SharedState`] (signing secret + deny list).
//!
//! # Token extraction order
//!
//! 1. `Authorization: Bearer <jwt>` header — standard REST path.
//! 2. `?token=<jwt>` is accepted only on loopback Headless sockets because the
//!    Node WebSocket client cannot attach an Authorization header. Canonical
//!    public sockets use single-use tickets.
//!
//! If both are present, the header takes precedence.
//!
//! # Error shape
//!
//! All failures return the flat JSON envelope
//! `{ "code": "...", "message": "...", "requestId": "..." }` with HTTP
//! 401 and the same request id in `x-request-id`.
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
use std::sync::Arc;

use super::{
    host_identity,
    jwt::{verify, JwtError, SERVICE_DEVICE_ID},
    oidc::{self, OidcAuthenticator},
    rate_limit::RateLimitDecision,
    SharedState,
};

const LOCAL_DEBUG_TOKEN_ENV: &str = "COGNIA_LOCAL_DEBUG_TOKEN";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PrincipalRequirement {
    DeviceOrService,
    Service,
}

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
    /// OAuth/OIDC permission scopes granted to this caller. Legacy paired
    /// device/service tokens leave this empty and use their existing device
    /// permission gate; OIDC routes enforce these values explicitly.
    pub granted_scopes: Vec<String>,
    /// Canonical remote-command capabilities loaded by the authenticating
    /// adapter. `Some`, including `Some(Vec::new())`, is an authoritative
    /// authorization snapshot. `None` lets adapters that have not yet loaded
    /// a snapshot fall back to the shared security store.
    pub authorization_capabilities: Option<Vec<String>>,
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
    request: Request,
    next: Next,
) -> Response {
    let oidc = match super::deployment::deployment_mode() {
        super::deployment::DeploymentMode::SingleUser => None,
        super::deployment::DeploymentMode::MultiTenant => match super::oidc_authenticator() {
            Some(authenticator) => Some(authenticator),
            None => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({
                        "code": "oidc_unavailable",
                        "message": "tenant authentication is not configured",
                    })),
                )
                    .into_response();
            }
        },
    };
    let local_debug_token = std::env::var(LOCAL_DEBUG_TOKEN_ENV)
        .ok()
        .filter(|token| token.len() >= 32);
    authenticate_request(
        state,
        oidc,
        local_debug_token,
        PrincipalRequirement::DeviceOrService,
        request,
        next,
    )
    .await
}

/// Authenticate the loopback Headless plane with a service-scoped principal.
/// Device-scoped legacy JWTs and OIDC identities are never accepted here.
pub async fn require_service_jwt(
    State(state): State<SharedState>,
    request: Request,
    next: Next,
) -> Response {
    let local_debug_token = std::env::var(LOCAL_DEBUG_TOKEN_ENV)
        .ok()
        .filter(|token| token.len() >= 32);
    authenticate_request(
        state,
        None,
        local_debug_token,
        PrincipalRequirement::Service,
        request,
        next,
    )
    .await
}

/// Operator-only surface for metrics and local diagnostics. The real socket
/// peer is authoritative; forwarding headers are deliberately ignored.
pub async fn require_loopback_operator(request: Request, next: Next) -> Response {
    let is_loopback = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|peer| peer.0.ip().is_loopback());
    let operator_bearer = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned);
    if !is_loopback && !has_operator_bearer(operator_bearer.as_deref()).await {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": {
                    "code": "operator_identity_required",
                    "message": "this operator endpoint requires loopback or an operator bearer token"
                }
            })),
        )
            .into_response();
    }
    next.run(request).await
}

async fn has_operator_bearer(supplied: Option<&str>) -> bool {
    let Ok(path) = std::env::var("COGNIA_METRICS_OPERATOR_TOKEN_FILE") else {
        return false;
    };
    let Ok(expected) = tokio::fs::read(path).await else {
        return false;
    };
    let expected = trim_ascii_whitespace(&expected);
    if expected.is_empty() {
        return false;
    }
    operator_bearer_matches(supplied, expected)
}

fn operator_bearer_matches(supplied: Option<&str>, expected: &[u8]) -> bool {
    let Some(supplied) = supplied else {
        return false;
    };
    constant_time_eq(supplied.as_bytes(), expected)
}

fn trim_ascii_whitespace(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(u8::is_ascii_whitespace) {
        value = &value[1..];
    }
    while value.last().is_some_and(u8::is_ascii_whitespace) {
        value = &value[..value.len() - 1];
    }
    value
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

/// Core companion-gateway auth, split out from [`require_device_jwt`] so the
/// OIDC authenticator can be injected in tests.
///
/// `oidc` is `Some` only in cloud/headless mode ([`super::oidc_authenticator`]).
/// When present, OIDC is the exclusive device authentication authority. A
/// rejected token or unavailable issuer fails closed and never falls through
/// to the single-user HS256 device path.
async fn authenticate_request(
    state: SharedState,
    oidc: Option<Arc<OidcAuthenticator>>,
    local_debug_token: Option<String>,
    requirement: PrincipalRequirement,
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

    // Node's WHATWG WebSocket cannot attach an Authorization header. Admit a
    // query token only on loopback Headless sockets. Canonical public sockets
    // keep using short-lived, single-use tickets.
    let internal_service_socket = peer_is_loopback
        && matches!(
            request.uri().path(),
            "/internal/bridge" | "/internal/events"
        );
    let query_token: Option<String> = internal_service_socket
        .then(|| {
            request
                .uri()
                .query()
                .and_then(|q| serde_urlencoded::from_str::<TokenQuery>(q).ok())
                .and_then(|tq| tq.token)
        })
        .flatten();

    // Header takes precedence over query string.
    let token = match header_token.or(query_token) {
        Some(t) => t,
        None => {
            return error_response(
                "missing_authorization",
                "Authorization bearer token is required",
            );
        }
    };

    // Local development may replace the persistent service JWT with one
    // process-scoped random token. Keep the bypass narrower than the normal
    // service principal: only verified loopback peers and service-only routes
    // are eligible. The token never authenticates the legacy/device API.
    let local_debug_route = request.uri().path().starts_with("/internal/")
        || request.uri().path() == "/ide/content"
        || request.uri().path().starts_with("/ide/content/");
    if local_debug_route
        && local_debug_token
            .as_deref()
            .is_some_and(|expected| constant_time_eq(token.as_bytes(), expected.as_bytes()))
    {
        if !peer_is_loopback {
            return error_response(
                "local_debug_token_remote",
                "local debug tokens are only honored from loopback",
            );
        }
        request.extensions_mut().insert(DeviceContext {
            device_id: SERVICE_DEVICE_ID.to_string(),
            account_id: host_identity::current_tenant_or_unbound(),
            scope: "service".to_string(),
            granted_scopes: Vec::new(),
            authorization_capabilities: None,
        });
        return next.run(request).await;
    }

    // ── 1b. OIDC mode (ADR-0059 cloud/headless) ──────────────────────────────
    // Once configured, OIDC is authoritative. Falling through to a self-issued
    // HS256 token would let a legacy paired device bypass tenant authentication
    // and would turn a JWKS outage into an authentication downgrade.
    if requirement == PrincipalRequirement::DeviceOrService {
        if let Some(authn) = oidc.as_ref() {
            match authn.authenticate(&token).await {
                Ok(claims) => {
                    let ctx = oidc_device_context(&claims);
                    if state.deny_list.is_revoked(&ctx.device_id) {
                        return error_response("device_revoked", "this device has been revoked");
                    }
                    request.extensions_mut().insert(ctx);
                    return next.run(request).await;
                }
                Err(e) => {
                    log::warn!("companion-api oidc: token rejected: {e}");
                    return error_response(
                        "oidc_authentication_failed",
                        "the identity provider could not authenticate this request",
                    );
                }
            }
        }
    }

    // ── 2. Verify JWT ───────────────────────────────────────────────────────
    let secret = state.secret.read().clone();
    let claims = if requirement == PrincipalRequirement::Service {
        if !peer_is_loopback {
            return error_response(
                "service_token_remote",
                "service-scope tokens are only honored from loopback",
            );
        }
        match verify(&secret, &token, "service") {
            Ok(claims) => claims,
            Err(JwtError::WrongScope { .. }) => {
                return error_response("wrong_scope", "JWT scope must be \"service\"");
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
        }
    } else {
        match verify(&secret, &token, "device") {
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
        granted_scopes: Vec::new(),
        authorization_capabilities: None,
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
    super::metrics::record_auth_failure();
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut response = (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "code": code,
            "message": message,
            "requestId": request_id.clone(),
        })),
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

/// Map validated Logto claims (ADR-0059 cloud mode) onto a [`DeviceContext`].
/// The Logto `sub` becomes the caller/device id; the Organization id becomes
/// the account (cognia tenant), falling back to `sub` for non-organization
/// tokens. `scope` is stamped `"oidc"` to distinguish the identity source.
fn oidc_device_context(claims: &oidc::OidcClaims) -> DeviceContext {
    DeviceContext {
        device_id: claims.sub.clone(),
        account_id: claims
            .organization_id
            .clone()
            .unwrap_or_else(|| claims.sub.clone()),
        scope: "oidc".to_string(),
        granted_scopes: claims.scopes.clone(),
        authorization_capabilities: None,
    }
}

// ---------------------------------------------------------------------------
// Pre-auth rate limit (defense in depth on the public_routes surface)
// ---------------------------------------------------------------------------

/// Axum middleware that token-buckets canonical authentication requests by
/// source IP so an unauthenticated LAN peer cannot exhaust challenge,
/// registration, token, or socket-ticket resources.
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
    // Loopback is the desktop talking to itself — no realistic brute-force
    // surface, and
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
            let request_id = uuid::Uuid::new_v4().to_string();
            let mut resp = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": {
                        "code": "rate_limited",
                        "message": "too many authentication attempts, slow down",
                        "requestId": request_id,
                        "retryable": true,
                        "details": {},
                    },
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
        jwt::{issue_device_jwt, issue_service_jwt},
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

    #[test]
    fn operator_bearer_tokens_are_exact_trimmed_and_constant_time_compared() {
        assert!(operator_bearer_matches(
            Some("metrics-operator-token"),
            trim_ascii_whitespace(b"  metrics-operator-token\n")
        ));
        assert!(!operator_bearer_matches(
            Some("metrics-operator-token"),
            b"metrics-operator-other"
        ));
        assert!(!operator_bearer_matches(None, b"metrics-operator-token"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";

    fn test_state() -> SharedState {
        use crate::companion_api::{event_bus::EventBus, idempotency::IdempotencyCache};
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

    /// Minimal handler that echoes the device_id from the extension.
    async fn echo_device(Extension(ctx): Extension<DeviceContext>) -> impl IntoResponse {
        Json(json!({
            "device_id": ctx.device_id,
            "account_id": ctx.account_id,
            "scope": ctx.scope,
        }))
    }

    fn build_router(state: SharedState) -> Router {
        Router::new()
            .route("/protected", get(echo_device))
            .layer(from_fn_with_state(state.clone(), require_device_jwt))
            .with_state(state)
    }

    fn build_service_router(state: SharedState) -> Router {
        Router::new()
            .route("/protected", get(echo_device))
            .layer(from_fn_with_state(state.clone(), require_service_jwt))
            .with_state(state)
    }

    fn build_local_debug_router(state: SharedState, token: &'static str) -> Router {
        Router::new()
            .route("/internal/test", get(echo_device))
            .route("/api/test", get(echo_device))
            .layer(from_fn(move |req, next| {
                let state = state.clone();
                async move {
                    authenticate_request(
                        state,
                        None,
                        Some(token.to_string()),
                        PrincipalRequirement::DeviceOrService,
                        req,
                        next,
                    )
                    .await
                }
            }))
    }

    fn local_debug_request(path: &str, ip: &str) -> Request<Body> {
        let mut req = Request::builder()
            .uri(path)
            .header(
                "Authorization",
                "Bearer local-debug-token-with-at-least-32-bytes",
            )
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(
            format!("{ip}:54321").parse::<SocketAddr>().unwrap(),
        ));
        req
    }

    #[tokio::test]
    async fn local_debug_token_authenticates_loopback_internal_requests_as_service() {
        let router =
            build_local_debug_router(test_state(), "local-debug-token-with-at-least-32-bytes");
        let response = router
            .oneshot(local_debug_request("/internal/test", "127.0.0.1"))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(
            body["device_id"],
            crate::companion_api::jwt::SERVICE_DEVICE_ID
        );
        assert_eq!(body["scope"], "service");
    }

    #[tokio::test]
    async fn local_debug_token_is_rejected_for_remote_internal_requests() {
        let router =
            build_local_debug_router(test_state(), "local-debug-token-with-at-least-32-bytes");
        let response = router
            .oneshot(local_debug_request("/internal/test", "192.0.2.50"))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            body_json(response).await["code"],
            "local_debug_token_remote"
        );
    }

    #[tokio::test]
    async fn local_debug_token_does_not_authenticate_public_device_routes() {
        let router =
            build_local_debug_router(test_state(), "local-debug-token-with-at-least-32-bytes");
        let response = router
            .oneshot(local_debug_request("/api/test", "127.0.0.1"))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
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
        let request_id = resp
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .expect("authentication errors expose a request id")
            .to_string();
        let body = body_json(resp).await;
        assert_eq!(body["code"], "missing_authorization");
        assert_eq!(body["requestId"], request_id);
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
    async fn unsupported_scope_jwt_returns_401_wrong_scope() {
        use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let claims = crate::companion_api::jwt::Claims {
            scope: "unsupported".to_string(),
            iat: now,
            exp: now + 60,
            device_id: None,
            account_id: Some(ACCOUNT_ID.to_string()),
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(SECRET),
        )
        .expect("encode unsupported scope");
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
    async fn query_string_token_is_disabled_by_default() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("qs-device");
        let req = Request::builder()
            .uri(format!("/protected?token={jwt}"))
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "missing_authorization");
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
                assert_eq!(body["error"]["code"], "rate_limited");
                assert_eq!(body["error"]["retryable"], true);
                assert!(body["error"]["requestId"].is_string());
                saw_429 = true;
                break;
            }
        }
        assert!(saw_429, "non-loopback brute force must trip the limiter");
    }

    // ── Service-scope token (ADR-0059 W4) ────────────────────────────────────

    fn service_request_from(ip: Option<&str>) -> Request<Body> {
        let jwt = issue_service_jwt(SECRET, ACCOUNT_ID)
            .expect("issue service jwt")
            .0;
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
        let resp = router
            .oneshot(service_request_from(Some("127.0.0.1")))
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert_eq!(
            body["device_id"],
            crate::companion_api::jwt::SERVICE_DEVICE_ID
        );
    }

    #[tokio::test]
    async fn service_only_middleware_rejects_loopback_device_jwt() {
        let jwt = device_jwt("device-on-loopback");
        let mut request = Request::builder()
            .uri("/protected")
            .header("Authorization", format!("Bearer {jwt}"))
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:54321".parse::<SocketAddr>().unwrap(),
        ));

        let response = build_service_router(test_state())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(response).await["code"], "wrong_scope");
    }

    #[tokio::test]
    async fn service_only_middleware_accepts_loopback_service_jwt() {
        let response = build_service_router(test_state())
            .oneshot(service_request_from(Some("127.0.0.1")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["scope"], "service");
    }

    #[tokio::test]
    async fn service_jwt_from_remote_peer_is_rejected() {
        let router = build_router(test_state());
        let resp = router
            .oneshot(service_request_from(Some("192.0.2.50")))
            .await
            .unwrap();
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

    // ── OIDC mode (ADR-0059 cloud/headless — Logto) ──────────────────────────

    use crate::companion_api::oidc::{self, test_support, OidcAuthenticator, OidcVerifierConfig};
    use std::time::Duration;

    const OIDC_AUD: &str = "https://brain.cognia.test/api";

    fn oidc_authn(issuer: String) -> Arc<OidcAuthenticator> {
        Arc::new(OidcAuthenticator::new(
            OidcVerifierConfig::new(issuer, OIDC_AUD, vec![]),
            Duration::from_secs(300),
        ))
    }

    fn build_oidc_router(state: SharedState, authn: Arc<OidcAuthenticator>) -> Router {
        Router::new()
            .route("/protected", get(echo_device))
            .layer(from_fn(move |req, next| {
                let state = state.clone();
                let authn = authn.clone();
                async move {
                    authenticate_request(
                        state,
                        Some(authn),
                        None,
                        PrincipalRequirement::DeviceOrService,
                        req,
                        next,
                    )
                    .await
                }
            }))
    }

    #[test]
    fn oidc_device_context_maps_sub_and_org() {
        let claims = oidc::OidcClaims {
            sub: "user_x".into(),
            organization_id: Some("org_y".into()),
            scopes: vec!["brain:rpc".into()],
            exp: 0,
        };
        let ctx = oidc_device_context(&claims);
        assert_eq!(ctx.device_id, "user_x");
        assert_eq!(ctx.account_id, "org_y");
        assert_eq!(ctx.scope, "oidc");
    }

    #[test]
    fn oidc_device_context_falls_back_to_sub_without_org() {
        let claims = oidc::OidcClaims {
            sub: "user_x".into(),
            organization_id: None,
            scopes: vec![],
            exp: 0,
        };
        let ctx = oidc_device_context(&claims);
        assert_eq!(ctx.account_id, "user_x");
    }

    #[tokio::test]
    async fn oidc_valid_token_authenticates() {
        let server = wiremock::MockServer::start().await;
        test_support::mount_lenient(&server).await;
        let router = build_oidc_router(test_state(), oidc_authn(server.uri()));
        let token = test_support::mint(
            test_support::claims(&server.uri(), OIDC_AUD),
            Some(test_support::TEST_KID),
            jsonwebtoken::Algorithm::ES384,
        );
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert_eq!(body["device_id"], "user_abc");
        assert_eq!(body["account_id"], "org_tenant_1");
    }

    #[tokio::test]
    async fn oidc_configured_rejects_device_hs256_without_fallback() {
        // Cloud mode is fail-closed: once OIDC is configured, a self-issued
        // HS256 device token must never bypass tenant authentication.
        let server = wiremock::MockServer::start().await;
        test_support::mount_lenient(&server).await;
        let router = build_oidc_router(test_state(), oidc_authn(server.uri()));
        let jwt = device_jwt("hs256-device");
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", format!("Bearer {jwt}"))
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "oidc_authentication_failed");
    }

    #[tokio::test]
    async fn oidc_configured_rejects_unknown_token() {
        let server = wiremock::MockServer::start().await;
        test_support::mount_lenient(&server).await;
        let router = build_oidc_router(test_state(), oidc_authn(server.uri()));
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", "Bearer not.a.token")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
    }
}
