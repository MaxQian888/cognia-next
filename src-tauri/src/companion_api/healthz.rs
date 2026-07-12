//! Public health / discovery endpoint.
//!
//! `GET /api/v1/healthz` is the unauthenticated diagnostic mobile clients
//! use to:
//!   1. confirm the server is reachable at all (vs "wrong port", "TLS
//!      rejected", "fingerprint mismatch"),
//!   2. cross-check the TLS SPKI fingerprint against the one pinned in
//!      a paired-device record (cert-rotation detection),
//!   3. learn what port the server believes it is advertising on (helpful
//!      when the mobile client probes a list of likely ports).
//!
//! # Why no auth?
//!
//! The endpoint is read-only and reveals only:
//!   * `version` — already exposed via the QR pair payload,
//!   * `fingerprint` — already exposed in every TLS handshake,
//!   * `advertised_port` — derivable from a successful TCP connect,
//!   * `server_id` — 16 bytes of HMAC-style installation identifier derived
//!     from the signing secret; same identifier across cert rotations so
//!     the mobile can distinguish "same desktop, fresh cert" (legitimate
//!     dev rebuild) from "different desktop" (mid-pair MITM).
//!
//! None of these enable mutation, exfiltrate user data, or reveal the
//! signing secret itself.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{advertised_port, tls_fingerprint, SharedState};

/// `GET /api/v1/healthz` handler.
///
/// On a headless `cognia-server` (ADR-0059 R8) the payload additionally
/// carries `brain` and `sidecar` supervision blocks so orchestrators and the
/// tier-2 smoke can see the full process tree's health. Both keys are absent
/// on desktop (no headless services installed).
pub async fn healthz_handler(State(state): State<SharedState>) -> Response {
    let secret = state.secret.read().clone();
    let server_id = derive_server_id(&secret);
    let mut payload = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "fingerprint": tls_fingerprint(),
        "advertised_port": advertised_port(),
        "server_id": server_id,
    });
    if let Some(services) = crate::headless::headless_services() {
        let obj = payload.as_object_mut().expect("payload is an object");
        // `brain` reports the supervisor when one is installed; a headless
        // server booted without a brain entry reports `configured: false`.
        obj.insert(
            "brain".to_string(),
            match crate::headless::brain::brain_status() {
                Some(status) => {
                    let mut b = serde_json::to_value(status).unwrap_or_else(|_| json!({}));
                    if let Some(map) = b.as_object_mut() {
                        map.insert("configured".to_string(), json!(true));
                    }
                    b
                }
                None => json!({ "configured": false }),
            },
        );
        obj.insert(
            "sidecar".to_string(),
            json!({
                "ready": services.sidecar.is_ready().await,
                "restart_count": services.sidecar.restart_count(),
            }),
        );
    }
    (StatusCode::OK, Json(payload)).into_response()
}

/// Derive a stable, opaque installation identifier from the signing
/// secret. SHA-256(secret) truncated to 16 bytes, hex-encoded → 32 chars.
///
/// Pure function so it can be reused by tests without the keyring.
pub fn derive_server_id(secret: &[u8]) -> String {
    let digest = Sha256::digest(secret);
    hex::encode(&digest[..16])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{
        deny_list::DenyList, desktop_messages_bridge::DesktopMessagesBridge,
        desktop_writes_bridge::DesktopWritesBridge, event_bus::EventBus,
        idempotency::IdempotencyCache, pair_code_lru::PairCodeLru, push::PushTokenRegistry,
        rate_limit::RateLimiter, redemption_lru::RedemptionLru, sync_bridge::SyncBridge,
        sync_registry::SyncTableRegistry, CompanionState, SharedState,
    };
    use axum::{body::Body, http::Request, routing::get, Router};
    use parking_lot::RwLock;
    use std::sync::Arc;
    use tower::ServiceExt as _;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";

    fn test_state() -> SharedState {
        Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: SyncBridge::new(),
            desktop_messages_bridge: DesktopMessagesBridge::new(),
            desktop_writes_bridge: DesktopWritesBridge::new(),
            sync_registry: SyncTableRegistry::with_defaults(),
            rate_limiter: RateLimiter::with_defaults(),
            push_tokens: PushTokenRegistry::new(),
        })
    }

    fn build_router(state: SharedState) -> Router {
        Router::new()
            .route("/api/v1/healthz", get(healthz_handler))
            .with_state(state)
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        serde_json::from_slice(&bytes).expect("json parse")
    }

    #[test]
    fn server_id_is_stable_for_same_secret() {
        let id1 = derive_server_id(SECRET);
        let id2 = derive_server_id(SECRET);
        assert_eq!(id1, id2);
        assert_eq!(id1.len(), 32, "hex-encoded 16 bytes → 32 chars");
    }

    #[test]
    fn server_id_changes_with_secret() {
        let alt = b"different-secret-32-bytes-____ab";
        assert_ne!(derive_server_id(SECRET), derive_server_id(alt));
    }

    #[test]
    fn server_id_does_not_reveal_secret() {
        // Trivially: server_id is 32 hex chars (128 bits) vs the 32-byte
        // (256-bit) secret. The mapping is one-way (sha256 truncation).
        // The strict guarantee is sha256's preimage resistance; here we
        // only smoke-test that the hex output never contains the raw
        // secret bytes as a substring of any reasonable encoding.
        let id = derive_server_id(SECRET);
        let hex_secret = hex::encode(SECRET);
        assert!(!hex_secret.contains(&id));
    }

    #[tokio::test]
    async fn healthz_returns_200_with_expected_fields() {
        let router = build_router(test_state());
        let req = Request::builder()
            .method("GET")
            .uri("/api/v1/healthz")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert!(body["version"].is_string(), "version is string");
        assert!(body["fingerprint"].is_string(), "fingerprint is string");
        assert!(
            body["advertised_port"].is_number(),
            "advertised_port is number"
        );
        let sid = body["server_id"].as_str().expect("server_id is string");
        assert_eq!(sid, derive_server_id(SECRET));
    }

    /// Desktop shape: no headless services installed → no brain/sidecar keys.
    /// Headless shape: both keys present (ADR-0059 R8).
    #[tokio::test]
    async fn healthz_gains_brain_and_sidecar_blocks_only_when_headless() {
        // The headless-services slot is process-global; serialize on the same
        // lock the other global-slot tests use.
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        crate::headless::install_headless_services(None);

        let router = build_router(test_state());
        let req = Request::builder()
            .method("GET")
            .uri("/api/v1/healthz")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        let body = body_json(resp).await;
        assert!(body.get("brain").is_none(), "desktop must not report brain");
        assert!(
            body.get("sidecar").is_none(),
            "desktop must not report sidecar"
        );

        crate::headless::install_headless_services(Some(
            crate::headless::HeadlessServices::stub_for_tests(),
        ));
        let router = build_router(test_state());
        let req = Request::builder()
            .method("GET")
            .uri("/api/v1/healthz")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        let body = body_json(resp).await;
        assert_eq!(
            body["brain"]["configured"], false,
            "no brain supervisor installed in this test"
        );
        assert_eq!(body["sidecar"]["ready"], false);
        assert!(body["sidecar"]["restart_count"].is_number());

        crate::headless::install_headless_services(None);
    }

    #[tokio::test]
    async fn healthz_does_not_require_authorization_header() {
        // Build a router with NO middleware applied — the public route is
        // intentionally outside `require_device_jwt`. We assert the
        // handler itself succeeds on a plain GET with no headers.
        let router = build_router(test_state());
        let req = Request::builder()
            .method("GET")
            .uri("/api/v1/healthz")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
    }
}
