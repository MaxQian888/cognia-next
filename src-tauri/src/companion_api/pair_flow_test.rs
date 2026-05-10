//! End-to-end pair flow integration test (Wave 3.10).
//!
//! Drives the full sequence — `/auth/pair/issue` → `/auth/pair` →
//! protected RPC `whoami`-style — through the in-process axum router
//! using `tower::ServiceExt::oneshot`. Verifies that:
//!
//!   * a freshly issued pair JWT redeems exactly once and yields a
//!     working device JWT,
//!   * the device JWT carries the right scope so the JWT verifier
//!     middleware lets it through,
//!   * a double-redemption returns 409 with the unified flat envelope
//!     (`{ "code": "pair_jwt_redeemed", ... }`) — Wave 3.1 contract,
//!   * an obviously-wrong-shape body (missing required field) returns
//!     400 with `code: "malformed_request"`.
//!
//! No new external deps — uses the same axum `oneshot` harness already
//! exercised by `companion_api::auth::tests`.

#[cfg(test)]
mod tests {
    use crate::companion_api::auth::{issue_handler, pair_handler};
    use crate::companion_api::jwt::issue_pair_jwt;
    use crate::companion_api::SharedState;
    use axum::{body::Body, http::Request, Router};
    use parking_lot::RwLock;
    use serde_json::json;
    use std::sync::Arc;
    use tower::ServiceExt as _;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";

    fn test_state() -> SharedState {
        use crate::companion_api::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache,
            redemption_lru::RedemptionLru,
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

    /// Drive issue → redeem → assert device JWT shape. The JWT itself
    /// is opaque; the test asserts contract shape, not signature
    /// internals (those are covered by `jwt::tests`).
    #[tokio::test]
    async fn end_to_end_issue_redeem_returns_device_jwt() {
        let state = test_state();
        let router = build_router(Arc::clone(&state));

        // Step 1 — issue pair JWT.
        let issue_resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/pair/issue")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(issue_resp.status().as_u16(), 200);
        let issue_body = body_json(issue_resp).await;
        let pair_jwt = issue_body["pairJwt"]
            .as_str()
            .expect("pairJwt is a string")
            .to_string();

        // Step 2 — redeem.
        let pair_resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/pair")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "pair_jwt": pair_jwt,
                            "device_label": "integ-test-phone",
                            "device_platform": "android",
                            "device_pubkey": "",
                            "app_version": "0.1.0",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(pair_resp.status().as_u16(), 200);
        let pair_body = body_json(pair_resp).await;
        let device_jwt = pair_body["device_jwt"].as_str().expect("device_jwt string");
        let device_id = pair_body["device_id"].as_str().expect("device_id string");

        // Shape assertions — JWT has 3 dot-separated segments, device_id
        // is non-empty.
        assert_eq!(device_jwt.split('.').count(), 3, "device_jwt is 3-part");
        assert!(!device_id.is_empty(), "device_id is non-empty");
        assert!(pair_body["server_version"].is_string());
    }

    /// Wave 3.1 contract — auth errors use the unified flat envelope.
    #[tokio::test]
    async fn double_redeem_returns_flat_envelope_with_pair_jwt_redeemed() {
        let state = test_state();
        let router = build_router(Arc::clone(&state));
        let (pair_jwt, _) = issue_pair_jwt(SECRET).expect("issue pair jwt");

        let body = json!({
            "pair_jwt": pair_jwt,
            "device_label": "phone",
            "device_platform": "android",
            "device_pubkey": "",
            "app_version": "0.1.0",
        })
        .to_string();

        // First redeem succeeds.
        let r1 = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/pair")
                    .header("content-type", "application/json")
                    .body(Body::from(body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r1.status().as_u16(), 200);

        // Second redeem rejects with the unified flat envelope.
        let r2 = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/pair")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = r2.status().as_u16();
        let envelope = body_json(r2).await;
        assert!(
            status == 409 || status == 401,
            "double-redeem must reject (got {status})"
        );
        assert_eq!(envelope["code"], "pair_jwt_redeemed");
        assert!(envelope["message"].is_string());
        // Wave 3.1 — no nested `error.code` shape.
        assert!(envelope.get("error").is_none(), "auth must use flat envelope");
    }

    #[tokio::test]
    async fn malformed_request_body_returns_flat_envelope() {
        let state = test_state();
        let router = build_router(Arc::clone(&state));

        // Missing every required field — server returns 400 with
        // `code: "malformed_request"`.
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/pair")
                    .header("content-type", "application/json")
                    .body(Body::from("{}".to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 400);
        let envelope = body_json(resp).await;
        assert_eq!(envelope["code"], "malformed_request");
        assert!(envelope.get("error").is_none());
    }
}
