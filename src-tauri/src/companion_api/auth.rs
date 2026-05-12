//! Axum handlers for the QR-pairing exchange endpoints.
//!
//! # Endpoints
//!
//! - `POST /api/v1/auth/pair/issue` — issue a short-lived pair JWT (QR payload).
//!   Loopback-only; the router is responsible for binding to 127.0.0.1 so only
//!   the desktop UI can call this.
//!
//! - `POST /api/v1/auth/pair` — redeem a pair JWT and exchange it for a
//!   long-lived device JWT.  Callable from the phone (LAN or tunnel).
//!
//! # Error shape
//!
//! All failures return JSON `{ "error": { "code": "...", "message": "..." } }`.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::{
    jwt::{issue_device_jwt, issue_pair_jwt, verify, JwtError},
    middleware::DeviceContext,
    SharedState,
};

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

/// Response body for `POST /api/v1/auth/pair/issue`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueResponse {
    pub pair_jwt: String,
    /// Millisecond epoch when the pair JWT expires.
    pub expires_at_ms: i64,
}

/// Request body for `POST /api/v1/auth/pair`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub pair_jwt: String,
    pub device_label: String,
    pub device_platform: String,
    pub device_pubkey: String,
    pub app_version: String,
}

/// Response body for `POST /api/v1/auth/pair`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub device_jwt: String,
    pub server_version: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /api/v1/auth/pair/issue`
///
/// Issues a fresh pair JWT.  The desktop QR generator calls this; the token is
/// encoded into the QR code image.  Empty request body.
pub async fn issue_handler(State(state): State<SharedState>) -> Response {
    let secret = state.secret.read().clone();
    match issue_pair_jwt(&secret) {
        Ok((pair_jwt, exp_secs)) => {
            let expires_at_ms = exp_secs * 1000;
            (
                StatusCode::OK,
                Json(IssueResponse {
                    pair_jwt,
                    expires_at_ms,
                }),
            )
                .into_response()
        }
        Err(e) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "jwt_issue_failed",
            &e.to_string(),
        ),
    }
}

/// `POST /api/v1/auth/pair`
///
/// Validates a pair JWT, marks it redeemed, and returns a long-lived device JWT.
/// The Tauri app emits `companion://device-paired` with the device row so the
/// TS layer can persist it to Dexie.
pub async fn pair_handler(
    State(state): State<SharedState>,
    result: Result<Json<PairRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Json(req) = match result {
        Ok(j) => j,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "malformed_request",
                &e.to_string(),
            );
        }
    };

    if req.device_label.chars().count() > 64 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "device_label_too_long",
            "device_label must be at most 64 characters",
        );
    }

    let secret = state.secret.read().clone();

    let claims = match verify(&secret, &req.pair_jwt, "pair") {
        Ok(c) => c,
        Err(JwtError::WrongScope { .. }) | Err(JwtError::Invalid(_)) => {
            return error_response(
                StatusCode::UNAUTHORIZED,
                "invalid_pair_jwt",
                "pair JWT is invalid, expired, or has the wrong scope",
            );
        }
    };

    let jti = match &claims.jti {
        Some(j) => j.clone(),
        None => {
            return error_response(
                StatusCode::UNAUTHORIZED,
                "invalid_pair_jwt",
                "pair JWT is missing jti claim",
            );
        }
    };

    if !state.redemption_lru.mark_redeemed(&jti) {
        return error_response(
            StatusCode::CONFLICT,
            "pair_jwt_redeemed",
            "pair JWT has already been used",
        );
    }

    let device_id = Uuid::new_v4().to_string();

    let device_jwt = match issue_device_jwt(&secret, &device_id) {
        Ok(t) => t,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "jwt_issue_failed",
                &e.to_string(),
            );
        }
    };

    // Emit the Tauri event so the TS layer persists the device to Dexie.
    let paired_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_millis() as i64;

    if let Some(app) = &state.app_handle {
        use tauri::Emitter as _;
        let payload = json!({
            "device_id": device_id,
            "label": req.device_label,
            "platform": req.device_platform,
            "pubkey": req.device_pubkey,
            "paired_at_ms": paired_at_ms,
            "app_version": req.app_version,
        });
        if let Err(e) = app.emit("companion://device-paired", payload) {
            log::warn!("failed to emit companion://device-paired: {e}");
        }
    }

    (
        StatusCode::OK,
        Json(PairResponse {
            device_id,
            device_jwt,
            server_version: env!("CARGO_PKG_VERSION").to_string(),
        }),
    )
        .into_response()
}

/// `GET /api/v1/whoami`
///
/// Protected endpoint (behind [`super::middleware::require_device_jwt`]).
/// Returns the device ID, server version, and the server's TLS SPKI
/// fingerprint so the mobile app can:
///   1. verify that its JWT is still valid after pairing (existing behavior)
///   2. compare the server's fingerprint to the one pinned in the QR pair
///      payload (P0.3 app-layer attestation — see `lib/tauri/pinned-fetch.ts`)
///
/// The fingerprint is **not** a strict TLS pinning replacement; the mobile
/// JS layer cannot inspect the actual negotiated TLS cert from a browser
/// webview. It's an app-layer sanity check that catches the "you connected
/// to the wrong cognia desktop" case.
pub async fn whoami_handler(Extension(ctx): Extension<DeviceContext>) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "device_id": ctx.device_id,
            "server_version": env!("CARGO_PKG_VERSION"),
            "tls_fingerprint": super::tls_fingerprint(),
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Wave 3.1: unified flat envelope `{ code, message, details? }`.
///
/// Both auth and RPC now share this shape so the mobile transport
/// (`lib/tauri/transport-companion.ts`) can read `body.code` directly,
/// no more synthetic `http_<status>` fallbacks for auth-side errors.
fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "code": code,
            "message": message,
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{
        jwt::issue_pair_jwt,
        redemption_lru::RedemptionLru,
        SharedState,
    };
    use axum::{body::Body, http::Request, Router};
    use parking_lot::RwLock;
    use std::sync::Arc;
    use tower::ServiceExt as _;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";

    fn test_state() -> SharedState {
        use crate::companion_api::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache,
        };
        Arc::new(crate::companion_api::CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry:
                crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter:
                crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens:
                crate::companion_api::push::PushTokenRegistry::new(),
        })
    }

    fn build_router(state: SharedState) -> Router {
        Router::new()
            .route("/api/v1/auth/pair/issue", axum::routing::post(issue_handler))
            .route("/api/v1/auth/pair", axum::routing::post(pair_handler))
            .with_state(state)
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        serde_json::from_slice(&bytes).expect("json parse")
    }

    // ── /api/v1/auth/pair/issue ──────────────────────────────────────────

    #[tokio::test]
    async fn issue_returns_200_with_pair_jwt() {
        let router = build_router(test_state());
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair/issue")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert!(body["pairJwt"].is_string());
        assert!(body["expiresAtMs"].is_number());
    }

    // ── /api/v1/auth/pair — happy path ───────────────────────────────────

    #[tokio::test]
    async fn pair_happy_path_returns_device_jwt() {
        let state = test_state();
        let router = build_router(Arc::clone(&state));

        let (pair_jwt, _) = issue_pair_jwt(SECRET).expect("issue pair jwt");

        let req_body = serde_json::json!({
            "pairJwt": pair_jwt,
            "deviceLabel": "Test Phone",
            "devicePlatform": "ios",
            "devicePubkey": "base64pubkeyhere==",
            "appVersion": "0.1.0",
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&req_body).unwrap()))
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert!(body["deviceId"].is_string());
        assert!(body["deviceJwt"].is_string());
        assert!(body["serverVersion"].is_string());
    }

    // ── 401 invalid_pair_jwt ─────────────────────────────────────────────

    #[tokio::test]
    async fn pair_invalid_jwt_returns_401() {
        let router = build_router(test_state());
        let req_body = serde_json::json!({
            "pairJwt": "not.a.valid.jwt",
            "deviceLabel": "Phone",
            "devicePlatform": "android",
            "devicePubkey": "abc",
            "appVersion": "0.1.0",
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&req_body).unwrap()))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "invalid_pair_jwt");
    }

    #[tokio::test]
    async fn pair_wrong_scope_jwt_returns_401() {
        let device_jwt = crate::companion_api::jwt::issue_device_jwt(SECRET, "some-device")
            .expect("issue device jwt");
        let router = build_router(test_state());
        let req_body = serde_json::json!({
            "pairJwt": device_jwt,
            "deviceLabel": "Phone",
            "devicePlatform": "android",
            "devicePubkey": "abc",
            "appVersion": "0.1.0",
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&req_body).unwrap()))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "invalid_pair_jwt");
    }

    // ── 409 pair_jwt_redeemed ────────────────────────────────────────────

    #[tokio::test]
    async fn pair_redeemed_jwt_returns_409() {
        let state = test_state();
        let (pair_jwt, _) = issue_pair_jwt(SECRET).expect("issue pair jwt");
        let req_body = serde_json::json!({
            "pairJwt": pair_jwt,
            "deviceLabel": "Phone",
            "devicePlatform": "ios",
            "devicePubkey": "abc",
            "appVersion": "0.1.0",
        });

        // First request succeeds.
        let router = build_router(Arc::clone(&state));
        let req1 = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&req_body).unwrap()))
            .unwrap();
        let resp1 = router.oneshot(req1).await.unwrap();
        assert_eq!(resp1.status().as_u16(), 200);

        // Second request with the same JWT returns 409.
        let router2 = build_router(Arc::clone(&state));
        let req2 = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&req_body).unwrap()))
            .unwrap();
        let resp2 = router2.oneshot(req2).await.unwrap();
        assert_eq!(resp2.status().as_u16(), 409);
        let body = body_json(resp2).await;
        assert_eq!(body["code"], "pair_jwt_redeemed");
    }

    // ── 400 device_label_too_long ────────────────────────────────────────

    #[tokio::test]
    async fn pair_label_too_long_returns_400() {
        let state = test_state();
        let (pair_jwt, _) = issue_pair_jwt(SECRET).expect("issue pair jwt");
        let label_65 = "a".repeat(65);
        let req_body = serde_json::json!({
            "pairJwt": pair_jwt,
            "deviceLabel": label_65,
            "devicePlatform": "ios",
            "devicePubkey": "abc",
            "appVersion": "0.1.0",
        });
        let router = build_router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&req_body).unwrap()))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 400);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "device_label_too_long");
    }

    #[tokio::test]
    async fn pair_label_exactly_64_chars_is_ok() {
        let state = test_state();
        let (pair_jwt, _) = issue_pair_jwt(SECRET).expect("issue pair jwt");
        let label_64 = "x".repeat(64);
        let req_body = serde_json::json!({
            "pairJwt": pair_jwt,
            "deviceLabel": label_64,
            "devicePlatform": "ios",
            "devicePubkey": "abc",
            "appVersion": "0.1.0",
        });
        let router = build_router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&req_body).unwrap()))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
    }

    // ── 400 malformed_request ────────────────────────────────────────────

    #[tokio::test]
    async fn pair_non_json_body_returns_400() {
        let router = build_router(test_state());
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair")
            .header("content-type", "application/json")
            .body(Body::from("not json at all"))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 400);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "malformed_request");
    }

    #[tokio::test]
    async fn pair_missing_fields_returns_400() {
        let router = build_router(test_state());
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"pairJwt":"only-one-field"}"#))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 400);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "malformed_request");
    }
}
