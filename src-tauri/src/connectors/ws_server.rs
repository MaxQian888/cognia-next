//! Axum WebSocket route for OneBot reverse-WS adapters.
//!
//! Route: `/ws/onebot/:adapter_id`
//! Auth:  `Authorization: Bearer <token>` — token stored in keyring at
//!        service `com.cognia.platforms`, account `<adapter_id>:onebotBearer`.
//!
//! When the bearer token is absent or wrong, the upgrade is rejected with 401.

use axum::{
    extract::{Path, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use subtle::ConstantTimeEq;

use super::state::ConnectorsState;

/// Register the `/ws/onebot/:adapter_id` route on the supplied router.
pub fn register_routes(router: Router<ConnectorsState>) -> Router<ConnectorsState> {
    router.route("/ws/onebot/{adapter_id}", get(ws_onebot_handler))
}

async fn ws_onebot_handler(
    State(_state): State<ConnectorsState>,
    Path(adapter_id): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // Read the expected bearer from keyring.
    let expected_token = match super::keyring::get(&adapter_id, "onebotBearer") {
        Ok(Some(t)) => t,
        Ok(None) => {
            // No token configured → accept without auth (development mode).
            // Adapters that need auth must have the keyring entry set.
            return ws.on_upgrade(|mut socket| async move {
                let _ = socket.recv().await;
            });
        }
        Err(e) => {
            log::warn!("ws_server: keyring error for {adapter_id}: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "keyring error").into_response();
        }
    };

    // Validate bearer token.
    let supplied = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    let expected_bytes = expected_token.as_bytes();
    let supplied_bytes = supplied.as_bytes();

    if expected_bytes.len() != supplied_bytes.len()
        || expected_bytes.ct_eq(supplied_bytes).unwrap_u8() == 0
    {
        return (StatusCode::UNAUTHORIZED, "invalid bearer token").into_response();
    }

    ws.on_upgrade(|mut socket| async move {
        while let Some(Ok(_msg)) = socket.recv().await {
            // Phase 1 stub: drain incoming frames. Real message routing lands later.
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::axum_app::build_unresolved_router;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn router_with_ws() -> Router<ConnectorsState> {
        let base = build_unresolved_router();
        register_routes(base)
    }

    #[tokio::test]
    async fn ws_onebot_without_keyring_entry_upgrades_ok() {
        // Without a keyring entry, the server accepts any connection.
        // We can't do a real WS handshake in tower oneshot, so just verify
        // it doesn't return 401 for a non-upgrade request (it returns 400
        // "no upgrade header" which is axum's normal response for a missing
        // Upgrade header, not a 401).
        // This test doesn't actually need a real keyring — just ensures the
        // route exists and doesn't reject without auth configured.

        let state = ConnectorsState::new();
        let app = router_with_ws().with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/ws/onebot/test-adapter-noauth")
                    .header("Connection", "Upgrade")
                    .header("Upgrade", "websocket")
                    .header("Sec-WebSocket-Version", "13")
                    .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // Without a bearer requirement in keyring, the upgrade proceeds (101)
        // or at minimum does not return 401.
        assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn ws_onebot_with_wrong_token_returns_401() {
        if !crate::connectors::keyring_available() {
            return;
        }
        // Set a bearer token in the real keyring.
        super::super::keyring::set("guarded-ws-adapter", "onebotBearer", "correct-secret").unwrap();

        let state = ConnectorsState::new();
        let app = router_with_ws().with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/ws/onebot/guarded-ws-adapter")
                    .header("Authorization", "Bearer wrong-secret")
                    .header("Connection", "Upgrade")
                    .header("Upgrade", "websocket")
                    .header("Sec-WebSocket-Version", "13")
                    .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
