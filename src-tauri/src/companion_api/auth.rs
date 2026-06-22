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
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::{
    jwt::{issue_device_jwt, issue_pair_jwt, verify, JwtError},
    middleware::DeviceContext,
    pair_code_guard,
    pair_code_lru::{PairCodeEntry, TakeOutcome},
    SharedState,
};

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

/// Request body for `POST /api/v1/auth/pair/issue`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRequest {
    pub account_id: String,
}

/// Response body for `POST /api/v1/auth/pair/issue`.
///
/// Carries both the QR payload (`pair_jwt`) and an emulator-friendly
/// numeric path (`pair_code`). Both expire at the same instant — the
/// underlying JWT's `exp` claim — so the desktop UI can render a single
/// countdown next to both surfaces. Mobile clients pick whichever they
/// can present: phones with a working camera scan the QR; emulators
/// type the digits.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueResponse {
    pub pair_jwt: String,
    /// Millisecond epoch when the pair JWT expires.
    pub expires_at_ms: i64,
    /// 6-digit numeric code that resolves server-side to the same
    /// `pair_jwt`. Single-use; consumed by
    /// `POST /api/v1/auth/pair/redeem-code`.
    pub pair_code: String,
    /// Millisecond epoch when the numeric code stops being redeemable.
    /// Set equal to `expires_at_ms` so the desktop UI can render one
    /// countdown — the server enforces the underlying pair-JWT TTL
    /// regardless of which surface the mobile picks.
    pub pair_code_expires_at_ms: i64,
}

/// Request body for `POST /api/v1/auth/pair/redeem-code` — the
/// emulator-friendly variant of `/auth/pair` that takes a 6-digit
/// numeric code instead of an opaque JWT. All device fields mirror
/// [`PairRequest`] so the downstream redeem path is identical.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemCodeRequest {
    pub code: String,
    pub device_label: String,
    pub device_platform: String,
    pub device_pubkey: String,
    pub app_version: String,
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
///
/// `rendezvous_id` and `rendezvous_secret` are minted alongside the device
/// JWT (ADR-0021): both peers use them to authenticate signaling-server
/// messages end-to-end without trusting the public rendezvous service. The
/// secret is 32 random bytes encoded as URL-safe base64 (unpadded); the id is
/// a UUIDv4. Devices that don't receive these fields (legacy pair payloads)
/// will skip the WebRTC transport tier and continue with HTTPS+WS only.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub device_jwt: String,
    pub server_version: String,
    pub rendezvous_id: String,
    pub rendezvous_secret: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /api/v1/auth/pair/issue`
///
/// Issues a fresh pair JWT for the supplied local account.  The desktop QR
/// generator calls this; the token is encoded into the QR code image.
///
/// Also mints a 6-digit numeric code that resolves to the same pair JWT
/// server-side. The desktop UI renders both surfaces with a shared
/// countdown.
pub async fn issue_handler(
    State(state): State<SharedState>,
    maybe_body: Option<Json<IssueRequest>>,
) -> Response {
    let Some(Json(req)) = maybe_body else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "account_id_required",
            "accountId is required",
        );
    };
    if req.account_id.trim().is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "account_id_required",
            "accountId is required",
        );
    }

    let secret = state.secret.read().clone();
    let (pair_jwt, exp_secs) = match issue_pair_jwt(&secret, &req.account_id) {
        Ok(t) => t,
        Err(JwtError::InvalidAccountId(_)) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_account_id",
                "accountId must be 6-64 characters and contain only letters, numbers, underscores, or hyphens",
            );
        }
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "jwt_issue_failed",
                &e.to_string(),
            );
        }
    };
    let expires_at_ms = exp_secs * 1000;

    let pair_code = generate_pair_code();
    state.pair_code_lru.insert(
        pair_code.clone(),
        PairCodeEntry {
            pair_jwt: pair_jwt.clone(),
            expires_at_ms,
        },
        now_ms(),
    );

    (
        StatusCode::OK,
        Json(IssueResponse {
            pair_jwt,
            expires_at_ms,
            pair_code,
            pair_code_expires_at_ms: expires_at_ms,
        }),
    )
        .into_response()
}

/// Generate a 6-digit numeric code in `100000..=999999` (no leading zero
/// to keep visual parity with the desktop renderer that uses a 6-cell
/// monospace block — leading zeros would be ambiguous when read aloud).
pub(crate) fn generate_pair_code() -> String {
    use rand::Rng as _;
    // `gen_range` is inclusive on the low bound and exclusive on the high
    // by default; pin both to span the full 6-digit space exactly once.
    let n = rand::thread_rng().gen_range(100_000u32..=999_999u32);
    format!("{n:06}")
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
            return error_response(StatusCode::BAD_REQUEST, "malformed_request", &e.to_string());
        }
    };

    redeem_with_pair_jwt(
        &state,
        &req.pair_jwt,
        &req.device_label,
        &req.device_platform,
        &req.device_pubkey,
        &req.app_version,
    )
}

/// `POST /api/v1/auth/pair/redeem-code`
///
/// Numeric companion to `/auth/pair`. The mobile client posts a 6-digit
/// code instead of an opaque JWT; the server looks the code up in
/// [`PairCodeLru`], converts it to its underlying pair JWT, and then
/// drives the same redeem path. Single-use: a successful `take` removes
/// the entry whether or not the downstream redeem succeeds (matches the
/// "observe-once" semantics of the JTI redemption LRU).
pub async fn redeem_code_handler(
    State(state): State<SharedState>,
    result: Result<Json<RedeemCodeRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Json(req) = match result {
        Ok(j) => j,
        Err(e) => {
            return error_response(StatusCode::BAD_REQUEST, "malformed_request", &e.to_string());
        }
    };

    // Format gate before we hit the LRU — saves a lock acquisition on
    // obvious typos. Six ASCII digits, nothing else.
    if req.code.len() != 6 || !req.code.chars().all(|c| c.is_ascii_digit()) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_pair_code",
            "pair code must be exactly 6 digits",
        );
    }

    // Global brute-force guard. Source-independent (covers the loopback
    // exemption and IP rotation that defeat the per-IP pre-auth limiter) so the
    // total number of guesses against a live code is bounded.
    let guard = pair_code_guard::global();
    let now_instant = std::time::Instant::now();
    if !guard.allow(now_instant) {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_attempts",
            "too many failed pair-code attempts; wait a minute and request a fresh code",
        );
    }

    let entry = match state.pair_code_lru.take(&req.code, now_ms()) {
        TakeOutcome::Hit(e) => e,
        TakeOutcome::NotFound => {
            guard.record_failure(now_instant);
            return error_response(
                StatusCode::NOT_FOUND,
                "pair_code_not_found",
                "pair code is unknown or already used",
            );
        }
        TakeOutcome::Expired => {
            guard.record_failure(now_instant);
            return error_response(
                StatusCode::GONE,
                "pair_code_expired",
                "pair code has expired; request a new one from the desktop",
            );
        }
    };
    // A live code was found — reset the brute-force counter.
    guard.record_success();

    redeem_with_pair_jwt(
        &state,
        &entry.pair_jwt,
        &req.device_label,
        &req.device_platform,
        &req.device_pubkey,
        &req.app_version,
    )
}

/// Shared redeem core for both `/auth/pair` and `/auth/pair/redeem-code`.
///
/// Validates the pair JWT, marks its JTI redeemed, mints the device JWT
/// + rendezvous tuple, emits the Tauri pairing event, and returns the
/// final `PairResponse`. Both entry points pass identical device-info
/// fields through; only the *transport* of the pair JWT differs.
fn redeem_with_pair_jwt(
    state: &SharedState,
    pair_jwt: &str,
    device_label: &str,
    device_platform: &str,
    device_pubkey: &str,
    app_version: &str,
) -> Response {
    if device_label.chars().count() > 64 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "device_label_too_long",
            "device_label must be at most 64 characters",
        );
    }

    let secret = state.secret.read().clone();

    let claims = match verify(&secret, pair_jwt, "pair") {
        Ok(c) => c,
        Err(JwtError::WrongScope { .. })
        | Err(JwtError::WrongAccount { .. })
        | Err(JwtError::InvalidAccountId(_))
        | Err(JwtError::Invalid(_)) => {
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

    let now_secs = chrono::Utc::now().timestamp();
    if !state
        .redemption_lru
        .mark_redeemed(&jti, claims.exp, now_secs)
    {
        return error_response(
            StatusCode::CONFLICT,
            "pair_jwt_redeemed",
            "pair JWT has already been used",
        );
    }

    let device_id = Uuid::new_v4().to_string();

    let account_id = match claims.account_id.clone() {
        Some(id) if !id.trim().is_empty() => id,
        _ => {
            return error_response(
                StatusCode::UNAUTHORIZED,
                "invalid_pair_jwt",
                "pair JWT is missing account_id claim",
            );
        }
    };

    let device_jwt = match issue_device_jwt(&secret, &device_id, &account_id) {
        Ok(t) => t,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "jwt_issue_failed",
                &e.to_string(),
            );
        }
    };

    // ADR-0021: mint a rendezvous room id and 32-byte shared HMAC secret
    // alongside the device JWT. The rendezvous service routes signaling by
    // `rendezvous_id`; both peers sign signaling envelopes with the secret
    // so the service can never impersonate either side. We use the OS RNG
    // (rand::thread_rng() seeds from getrandom) — same primitive that backs
    // jti generation in `jwt.rs`.
    let rendezvous_id = Uuid::new_v4().to_string();
    let rendezvous_secret = {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    };

    let paired_at_ms = now_ms();

    if let Some(app) = &state.app_handle {
        use tauri::Emitter as _;
        let payload = json!({
            "device_id": device_id,
            "label": device_label,
            "platform": device_platform,
            "pubkey": device_pubkey,
            "paired_at_ms": paired_at_ms,
            "app_version": app_version,
            "account_id": account_id,
            "rendezvous_id": rendezvous_id,
            "rendezvous_secret": rendezvous_secret,
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
            rendezvous_id,
            rendezvous_secret,
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
            "account_id": ctx.account_id,
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
    use crate::companion_api::{jwt::issue_pair_jwt, redemption_lru::RedemptionLru, SharedState};
    use axum::{body::Body, http::Request, Router};
    use parking_lot::RwLock;
    use std::sync::Arc;
    use tower::ServiceExt as _;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";

    /// Serializes the redeem-code tests, which share the process-global
    /// `pair_code_guard`. One test deliberately drives the guard into lockout;
    /// without this lock it could race a concurrent redeem test. Each redeem
    /// test takes this lock and then `reset_for_test()`s the guard for a clean
    /// slate.
    static REDEEM_GUARD_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    fn test_state() -> SharedState {
        use crate::companion_api::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache,
        };
        Arc::new(crate::companion_api::CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: std::sync::Arc::new(
                crate::companion_api::pair_code_lru::PairCodeLru::new(),
            ),
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

    fn build_router(state: SharedState) -> Router {
        Router::new()
            .route(
                "/api/v1/auth/pair/issue",
                axum::routing::post(issue_handler),
            )
            .route("/api/v1/auth/pair", axum::routing::post(pair_handler))
            .route(
                "/api/v1/auth/pair/redeem-code",
                axum::routing::post(redeem_code_handler),
            )
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
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "accountId": ACCOUNT_ID })).unwrap(),
            ))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert!(body["pairJwt"].is_string());
        assert!(body["expiresAtMs"].is_number());
        // 6-digit numeric code minted alongside the QR payload.
        let code = body["pairCode"].as_str().expect("pairCode string");
        assert_eq!(code.len(), 6, "pair code is 6 chars");
        assert!(
            code.chars().all(|c| c.is_ascii_digit()),
            "pair code is all digits: {code}"
        );
        // No leading zero — generator pinned to 100000..=999999.
        assert_ne!(&code[0..1], "0", "pair code has no leading zero");
        let pce = body["pairCodeExpiresAtMs"]
            .as_i64()
            .expect("pairCodeExpiresAtMs i64");
        let pe = body["expiresAtMs"].as_i64().expect("expiresAtMs i64");
        assert_eq!(pce, pe, "code expiry mirrors JWT expiry");
    }

    #[tokio::test]
    async fn issue_persists_code_into_lru() {
        // The mint path is responsible for writing into pair_code_lru —
        // verify by checking len changes from 0 to 1 around a single
        // issue call, then test redeem-code happy path in a separate
        // case so failures in either are not coupled.
        let state = test_state();
        assert_eq!(state.pair_code_lru.len(), 0);
        let router = build_router(Arc::clone(&state));
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair/issue")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "accountId": ACCOUNT_ID })).unwrap(),
            ))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(state.pair_code_lru.len(), 1);
    }

    // ── /api/v1/auth/pair/redeem-code ────────────────────────────────────

    #[tokio::test]
    async fn redeem_code_happy_path_returns_device_jwt() {
        let _serial = REDEEM_GUARD_LOCK.lock();
        pair_code_guard::global().reset_for_test();
        let state = test_state();
        let router = build_router(Arc::clone(&state));

        // Issue first so a code exists in the LRU.
        let issue_resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/pair/issue")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&serde_json::json!({ "accountId": ACCOUNT_ID }))
                            .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let issue_body = body_json(issue_resp).await;
        let code = issue_body["pairCode"].as_str().unwrap().to_string();

        let req_body = serde_json::json!({
            "code": code,
            "deviceLabel": "Pixel 7 Emulator",
            "devicePlatform": "android",
            "devicePubkey": "abc",
            "appVersion": "0.1.0",
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair/redeem-code")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&req_body).unwrap()))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert!(body["deviceJwt"].is_string());
        assert!(body["deviceId"].is_string());
        assert!(body["rendezvousId"].is_string());
        assert!(body["rendezvousSecret"].is_string());
    }

    #[tokio::test]
    async fn redeem_code_is_single_use() {
        let _serial = REDEEM_GUARD_LOCK.lock();
        pair_code_guard::global().reset_for_test();
        let state = test_state();
        let router = build_router(Arc::clone(&state));

        let issue_resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/pair/issue")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&serde_json::json!({ "accountId": ACCOUNT_ID }))
                            .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let code = body_json(issue_resp).await["pairCode"]
            .as_str()
            .unwrap()
            .to_string();

        let make_req = || {
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/pair/redeem-code")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "code": code,
                        "deviceLabel": "Pixel 7",
                        "devicePlatform": "android",
                        "devicePubkey": "",
                        "appVersion": "0.1.0",
                    }))
                    .unwrap(),
                ))
                .unwrap()
        };

        let resp1 = router.clone().oneshot(make_req()).await.unwrap();
        assert_eq!(resp1.status().as_u16(), 200);
        let resp2 = router.oneshot(make_req()).await.unwrap();
        // Second redeem hits the LRU empty — not-found, never expired.
        assert_eq!(resp2.status().as_u16(), 404);
        assert_eq!(body_json(resp2).await["code"], "pair_code_not_found");
    }

    #[tokio::test]
    async fn redeem_unknown_code_returns_404() {
        let _serial = REDEEM_GUARD_LOCK.lock();
        pair_code_guard::global().reset_for_test();
        let router = build_router(test_state());
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair/redeem-code")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "code": "654321",
                    "deviceLabel": "Pixel 7",
                    "devicePlatform": "android",
                    "devicePubkey": "",
                    "appVersion": "0.1.0",
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 404);
        assert_eq!(body_json(resp).await["code"], "pair_code_not_found");
    }

    #[tokio::test]
    async fn redeem_code_brute_force_locks_out_after_threshold() {
        let _serial = REDEEM_GUARD_LOCK.lock();
        pair_code_guard::global().reset_for_test();
        let router = build_router(test_state());

        let make_req = |code: &str| {
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/pair/redeem-code")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "code": code,
                        "deviceLabel": "attacker",
                        "devicePlatform": "android",
                        "devicePubkey": "",
                        "appVersion": "0.1.0",
                    }))
                    .unwrap(),
                ))
                .unwrap()
        };

        // Burn through the failure threshold with wrong (but well-formed) codes.
        for _ in 0..pair_code_guard::FAIL_THRESHOLD {
            let resp = router.clone().oneshot(make_req("654321")).await.unwrap();
            assert_eq!(resp.status().as_u16(), 404);
        }
        // The next attempt is locked out regardless of source.
        let locked = router.oneshot(make_req("654321")).await.unwrap();
        assert_eq!(locked.status().as_u16(), 429);
        assert_eq!(body_json(locked).await["code"], "too_many_attempts");
        pair_code_guard::global().reset_for_test();
    }

    #[tokio::test]
    async fn redeem_expired_code_returns_410() {
        let _serial = REDEEM_GUARD_LOCK.lock();
        pair_code_guard::global().reset_for_test();
        // Insert manually with a past expiry to bypass the issue path.
        let state = test_state();
        state.pair_code_lru.insert(
            "111111".into(),
            PairCodeEntry {
                pair_jwt: "irrelevant.jwt".into(),
                expires_at_ms: 1,
            },
            0,
        );

        let router = build_router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/pair/redeem-code")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "code": "111111",
                    "deviceLabel": "Pixel 7",
                    "devicePlatform": "android",
                    "devicePubkey": "",
                    "appVersion": "0.1.0",
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        // Either Expired (410) or NotFound (404) is acceptable — the LRU
        // prunes expired entries eagerly. The contract that matters: the
        // server refuses, the code is gone, and the client can request a
        // fresh one.
        let status = resp.status().as_u16();
        assert!(
            status == 404 || status == 410,
            "expected 404 or 410, got {status}"
        );
        let body = body_json(resp).await;
        let code = body["code"].as_str().unwrap();
        assert!(
            code == "pair_code_not_found" || code == "pair_code_expired",
            "unexpected error code: {code}"
        );
    }

    #[tokio::test]
    async fn redeem_malformed_code_returns_400() {
        let router = build_router(test_state());
        let cases = ["12345", "1234567", "12345a", "abcdef", ""];
        for bad in cases {
            let req = Request::builder()
                .method("POST")
                .uri("/api/v1/auth/pair/redeem-code")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "code": bad,
                        "deviceLabel": "Pixel 7",
                        "devicePlatform": "android",
                        "devicePubkey": "",
                        "appVersion": "0.1.0",
                    }))
                    .unwrap(),
                ))
                .unwrap();
            let resp = router.clone().oneshot(req).await.unwrap();
            assert_eq!(resp.status().as_u16(), 400, "code {bad:?} should be 400");
            assert_eq!(body_json(resp).await["code"], "invalid_pair_code");
        }
    }

    #[test]
    fn generate_pair_code_is_six_ascii_digits_no_leading_zero() {
        for _ in 0..200 {
            let c = super::generate_pair_code();
            assert_eq!(c.len(), 6);
            assert!(c.chars().all(|ch| ch.is_ascii_digit()));
            assert_ne!(&c[0..1], "0");
        }
    }

    // ── /api/v1/auth/pair — happy path ───────────────────────────────────

    #[tokio::test]
    async fn pair_happy_path_returns_device_jwt() {
        let state = test_state();
        let router = build_router(Arc::clone(&state));

        let (pair_jwt, _) = issue_pair_jwt(SECRET, ACCOUNT_ID).expect("issue pair jwt");

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
        // ADR-0021: rendezvous fields must be present and well-formed.
        let rid = body["rendezvousId"].as_str().expect("rendezvousId string");
        assert!(
            Uuid::parse_str(rid).is_ok(),
            "rendezvousId is not a UUID: {rid}"
        );
        let rsec = body["rendezvousSecret"]
            .as_str()
            .expect("rendezvousSecret string");
        let decoded = URL_SAFE_NO_PAD
            .decode(rsec.as_bytes())
            .expect("rendezvousSecret decodes as base64url");
        assert_eq!(decoded.len(), 32, "rendezvousSecret must be 32 bytes");
    }

    #[tokio::test]
    async fn pair_two_redeems_produce_distinct_rendezvous() {
        let _serial = REDEEM_GUARD_LOCK.lock();
        pair_code_guard::global().reset_for_test();
        // Each pair flow gets a fresh rendezvous tuple — secrets do not
        // collide across devices and the id is not derived from any
        // predictable input.
        let secret_a = test_state();
        let secret_b = test_state();
        let router_a = build_router(Arc::clone(&secret_a));
        let router_b = build_router(Arc::clone(&secret_b));
        let (jwt_a, _) = issue_pair_jwt(SECRET, ACCOUNT_ID).expect("issue jwt a");
        let (jwt_b, _) = issue_pair_jwt(SECRET, ACCOUNT_ID).expect("issue jwt b");

        let send = |router: Router, jwt: String| async move {
            let req = Request::builder()
                .method("POST")
                .uri("/api/v1/auth/pair")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "pairJwt": jwt,
                        "deviceLabel": "x",
                        "devicePlatform": "ios",
                        "devicePubkey": "",
                        "appVersion": "0.1.0",
                    }))
                    .unwrap(),
                ))
                .unwrap();
            body_json(router.oneshot(req).await.unwrap()).await
        };

        let body_a = send(router_a, jwt_a).await;
        let body_b = send(router_b, jwt_b).await;
        assert_ne!(body_a["rendezvousId"], body_b["rendezvousId"]);
        assert_ne!(body_a["rendezvousSecret"], body_b["rendezvousSecret"]);
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
        let device_jwt =
            crate::companion_api::jwt::issue_device_jwt(SECRET, "some-device", ACCOUNT_ID)
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
        let (pair_jwt, _) = issue_pair_jwt(SECRET, ACCOUNT_ID).expect("issue pair jwt");
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
        let (pair_jwt, _) = issue_pair_jwt(SECRET, ACCOUNT_ID).expect("issue pair jwt");
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
        let (pair_jwt, _) = issue_pair_jwt(SECRET, ACCOUNT_ID).expect("issue pair jwt");
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
