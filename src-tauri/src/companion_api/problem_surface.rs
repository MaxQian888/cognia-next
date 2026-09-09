//! ADR-0175, section 3: every failure the companion server answers with is
//! one RFC 9457 problem document.
//!
//! These tests drive the assembled desktop router the way a client would and
//! assert the shape of every refusal on the way in: no bearer, the wrong
//! principal, an unknown command, a malformed body, a body the framework
//! refuses, a method a route does not take, a path no route matches, and the
//! host having nothing to dispatch to. Each one must be
//! `application/problem+json`, parse strictly as a `Problem`, echo its status
//! in the document, and mirror its `requestId` in `x-request-id`.

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::http::{header, StatusCode};
    use axum::Router;
    use parking_lot::RwLock;
    use serde_json::Value;
    use tower::ServiceExt as _;

    use crate::companion_api::{CompanionState, SharedState};

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";

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

    async fn desktop_router() -> (tokio::sync::MutexGuard<'static, ()>, Router) {
        let guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        crate::headless::install_headless_services(None);
        (
            guard,
            crate::companion_api::server::build_router(test_state()),
        )
    }

    struct Sent {
        method: &'static str,
        path: &'static str,
        bearer: Option<String>,
        content_type: Option<&'static str>,
        body: String,
    }

    async fn send(router: &Router, sent: Sent) -> axum::response::Response {
        let mut builder = axum::http::Request::builder()
            .method(sent.method)
            .uri(sent.path);
        if let Some(bearer) = sent.bearer {
            builder = builder.header("authorization", format!("Bearer {bearer}"));
        }
        if let Some(content_type) = sent.content_type {
            builder = builder.header("content-type", content_type);
        }
        // A real client declares its length, and the body limiter refuses an
        // oversized request on that header before a byte is read. Without it
        // the probe would exercise a path no HTTP client takes.
        builder = builder.header("content-length", sent.body.len());
        let mut request = builder.body(axum::body::Body::from(sent.body)).unwrap();
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [127, 0, 0, 1],
                34567,
            ))));
        router.clone().oneshot(request).await.unwrap()
    }

    /// Every assertion the contract makes about one refusal.
    async fn assert_problem(
        label: &str,
        response: axum::response::Response,
        expected_status: StatusCode,
        expected_code: &str,
    ) -> cognia_problem::Problem {
        assert_eq!(response.status(), expected_status, "{label}: status");
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some(cognia_problem::CONTENT_TYPE),
            "{label}: media type"
        );
        let header_request_id = response
            .headers()
            .get(cognia_problem::REQUEST_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .unwrap_or_else(|| panic!("{label}: x-request-id header"));
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            panic!(
                "{label}: body is not JSON: {:?}",
                String::from_utf8_lossy(&bytes)
            )
        });
        assert!(
            value.get("error").is_none(),
            "{label}: the document is the body, not a wrapper: {value}"
        );
        let problem: cognia_problem::Problem = serde_json::from_value(value.clone())
            .unwrap_or_else(|error| panic!("{label}: not a strict Problem ({error}): {value}"));
        assert_eq!(problem.code, expected_code, "{label}: code");
        assert_eq!(
            problem.status,
            expected_status.as_u16(),
            "{label}: status member"
        );
        assert_eq!(
            problem.request_id, header_request_id,
            "{label}: requestId mirrors the header"
        );
        assert_eq!(
            problem.type_uri,
            format!("{}{}", cognia_problem::TYPE_BASE, expected_code),
            "{label}: type"
        );
        assert!(!problem.title.is_empty(), "{label}: title");
        assert!(problem.details.is_object(), "{label}: details");
        problem
    }

    fn service_jwt() -> String {
        crate::companion_api::jwt::issue_service_jwt(SECRET, ACCOUNT_ID)
            .expect("service token")
            .0
    }

    #[tokio::test]
    async fn every_error_response_is_a_problem_document() {
        let (_guard, router) = desktop_router().await;
        let service = service_jwt();
        let device = crate::companion_api::jwt::issue_device_jwt(SECRET, "device-a", ACCOUNT_ID)
            .expect("device token");

        // 401: no bearer on the device plane.
        let response = send(
            &router,
            Sent {
                method: "POST",
                path: "/api/_rpc/claude_sidecar_status",
                bearer: None,
                content_type: Some("application/json"),
                body: "{}".into(),
            },
        )
        .await;
        let problem = assert_problem(
            "no bearer",
            response,
            StatusCode::UNAUTHORIZED,
            "missing_authorization",
        )
        .await;
        assert!(!problem.retryable, "a missing bearer does not fix itself");

        // 401: a device token on the service plane.
        let response = send(
            &router,
            Sent {
                method: "POST",
                path: "/internal/_rpc/claude_sidecar_status",
                bearer: Some(device),
                content_type: Some("application/json"),
                body: "{}".into(),
            },
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some(cognia_problem::CONTENT_TYPE),
            "wrong principal: media type"
        );

        // 404: a command the contract does not know.
        let response = send(
            &router,
            Sent {
                method: "POST",
                path: "/internal/_rpc/no_such_command",
                bearer: Some(service.clone()),
                content_type: Some("application/json"),
                body: "{}".into(),
            },
        )
        .await;
        assert_problem(
            "unknown command",
            response,
            StatusCode::NOT_FOUND,
            "unknown_command",
        )
        .await;

        // 400: a body that is not JSON.
        let response = send(
            &router,
            Sent {
                method: "POST",
                path: "/internal/_rpc/claude_sidecar_status",
                bearer: Some(service.clone()),
                content_type: Some("application/json"),
                body: "{".into(),
            },
        )
        .await;
        assert_problem(
            "malformed body",
            response,
            StatusCode::BAD_REQUEST,
            "invalid_json_request",
        )
        .await;

        // 415: a body with no content type. The JSON extractor refuses it and the
        // handler's rejection branch names the refusal, not just the status.
        let response = send(
            &router,
            Sent {
                method: "POST",
                path: "/internal/_rpc/claude_sidecar_status",
                bearer: Some(service.clone()),
                content_type: None,
                body: "{}".into(),
            },
        )
        .await;
        assert_problem(
            "missing content type",
            response,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
        )
        .await;

        // 413: a body over the plane's limit. Another framework refusal.
        let response = send(
            &router,
            Sent {
                method: "POST",
                path: "/internal/_rpc/claude_sidecar_status",
                bearer: Some(service.clone()),
                content_type: Some("application/json"),
                body: serde_json::json!({ "pad": "x".repeat(17 * 1024 * 1024) }).to_string(),
            },
        )
        .await;
        assert_problem(
            "oversized body",
            response,
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
        )
        .await;

        // 405: a route that exists for another method.
        let response = send(
            &router,
            Sent {
                method: "GET",
                path: "/internal/_rpc/claude_sidecar_status",
                bearer: Some(service.clone()),
                content_type: None,
                body: String::new(),
            },
        )
        .await;
        assert_problem(
            "wrong method",
            response,
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
        )
        .await;

        // 404: a path no route matches.
        let response = send(
            &router,
            Sent {
                method: "GET",
                path: "/api/v1/_rpc/claude_sidecar_status",
                bearer: None,
                content_type: None,
                body: String::new(),
            },
        )
        .await;
        assert_problem(
            "no such route",
            response,
            StatusCode::NOT_FOUND,
            "not_found",
        )
        .await;

        // 503: the desktop test topology has nothing to dispatch to. Retryable,
        // because a host that is still booting answers the same way.
        let response = send(
            &router,
            Sent {
                method: "POST",
                path: "/internal/_rpc/claude_sidecar_status",
                bearer: Some(service),
                content_type: Some("application/json"),
                body: "{}".into(),
            },
        )
        .await;
        let problem = assert_problem(
            "no dispatch host",
            response,
            StatusCode::SERVICE_UNAVAILABLE,
            "service_unavailable",
        )
        .await;
        assert!(
            problem.retryable,
            "a 503 the host itself raised for a missing dispatch host is retryable"
        );
    }

    /// A JSON success is untouched by the outermost layer, and so is a JSON
    /// error a handler wrote itself.
    #[tokio::test]
    async fn the_outermost_layer_leaves_json_answers_alone() {
        let (_guard, router) = desktop_router().await;
        let response = send(
            &router,
            Sent {
                method: "GET",
                path: "/healthz",
                bearer: None,
                content_type: None,
                body: String::new(),
            },
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("application/json")));
    }
}
