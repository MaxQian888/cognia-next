//! Connectors axum router.
//!
//! Routes:
//!   GET  /health                          → 200 {"ok":true}
//!   POST /webhook/:adapter_type/:adapter_id → 501 until adapter routes are registered
//!   *    /ws/onebot/:adapter_id            → reserved for WS upgrade (Task 23)

use axum::{
    body::Body,
    http::StatusCode,
    response::Response,
    routing::{any, get},
    Router,
};

use super::state::ConnectorsState;
use super::ws_server;

/// Build the connectors axum `Router<ConnectorsState>` (state not yet resolved).
///
/// Callers that need to add more routes can extend the returned router before
/// calling `.with_state(state)`.
pub fn build_unresolved_router() -> Router<ConnectorsState> {
    let base = Router::new()
        .route("/health", get(health_handler))
        .route(
            "/webhook/{adapter_type}/{adapter_id}",
            any(unimplemented_webhook_handler),
        );
    // Wire in the OneBot reverse-WS route (`/ws/onebot/:adapter_id`).
    ws_server::register_routes(base)
}

/// Convenience wrapper: build the router and resolve state in one call.
/// Used by `server_lifecycle::start_server`.
pub fn build_router(state: ConnectorsState) -> Router {
    build_unresolved_router().with_state(state)
}

async fn health_handler() -> &'static str {
    r#"{"ok":true}"#
}

async fn unimplemented_webhook_handler() -> Response {
    Response::builder()
        .status(StatusCode::NOT_IMPLEMENTED)
        .body(Body::from(r#"{"error":"adapter route not registered"}"#))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_returns_ok() {
        let app = build_router(ConnectorsState::new());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"{\"ok\":true}");
    }

    #[tokio::test]
    async fn unregistered_webhook_returns_501() {
        let app = build_router(ConnectorsState::new());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/webhook/telegram/x")
                    .method("POST")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    }
}
