//! The one failure document on the companion planes (ADR-0175, section 3).
//!
//! Every non-2xx answer from `/api/*`, `/internal/*`, the WebSocket upgrade
//! rejections and the operator routes is a [`Problem`]: an RFC 9457 problem
//! document with five companion extensions. Frames on the WebSocket, WebRTC
//! and bridge planes keep their own envelope and carry a `Problem` as their
//! `error` member.
//!
//! ```json
//! {
//!   "type": "https://cognia.dev/problems/command_renamed",
//!   "title": "Gone",
//!   "status": 410,
//!   "detail": "session_list is now session.list",
//!   "instance": "/api/_rpc/session_list",
//!   "code": "command_renamed",
//!   "requestId": "…",
//!   "retryable": false,
//!   "details": { "replacement": "session.list" }
//! }
//! ```
//!
//! `code` is the stable snake_case string a client branches on. `requestId`
//! equals the `x-request-id` response header, and a replayed receipt answers
//! with the request id of the execution it replays. `retryable` says whether
//! repeating the identical request can succeed. `operationId` is present when
//! the failure belongs to a long-running operation.
//!
//! Before this crate the same failure had seven spellings: a nested
//! `{error:{…}}` on the device plane, a flat object on the internal plane, a
//! three-key `RpcError` without a request id, two workflow `ErrorBody`s, a
//! bare `{error: "code"}` on the Lark listener and a plain-text 503 while
//! draining. Clients string-matched whichever one they happened to hit.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// The namespace every `type` URI lives under. The document is
/// `TYPE_BASE + code`, so a client that knows the code knows the type and
/// vice versa. The URI is an identifier, not a page that has to exist.
pub const TYPE_BASE: &str = "https://cognia.dev/problems/";

/// The media type an HTTP answer carrying a [`Problem`] declares.
pub const CONTENT_TYPE: &str = "application/problem+json";

/// The header that mirrors [`Problem::request_id`].
pub const REQUEST_ID_HEADER: &str = "x-request-id";

/// Bound on `detail`, mirroring `cognia_core::CommandError`'s cap so a
/// runaway message cannot turn a receipt into a multi-megabyte row.
const MAX_DETAIL_CHARS: usize = 2048;
const TRUNCATED_SUFFIX: &str = "... (truncated)";

/// RFC 9457 problem details plus the companion extensions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// `https://cognia.dev/problems/<code>`.
    #[serde(rename = "type")]
    pub type_uri: String,
    /// The HTTP reason phrase of `status`. Human-facing, never branched on.
    pub title: String,
    /// The HTTP status this document was (or would be) answered with.
    pub status: u16,
    /// Human-readable explanation of this occurrence.
    pub detail: String,
    /// The request path this occurrence belongs to, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// Stable snake_case code a client branches on.
    pub code: String,
    /// Equals the `x-request-id` response header.
    pub request_id: String,
    /// Whether repeating the identical request can succeed.
    pub retryable: bool,
    /// Machine-readable extras (`replacement`, `retryAfterSeconds`,
    /// `violations`, and so on). Always an object.
    #[serde(default = "empty_object")]
    pub details: Value,
    /// Present when the failure belongs to a long-running operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

impl Problem {
    /// A problem with a fresh request id. `retryable` defaults to "this is a
    /// server-side condition" (`status >= 500`). Every constructor that knows
    /// better says so with [`Problem::retryable`].
    pub fn new(status: u16, code: impl Into<String>, detail: impl Into<String>) -> Self {
        let code = code.into();
        Self {
            type_uri: format!("{TYPE_BASE}{code}"),
            title: title_for_status(status).to_string(),
            status,
            detail: truncate_detail(detail.into()),
            instance: None,
            code,
            request_id: uuid::Uuid::new_v4().to_string(),
            retryable: status >= 500,
            details: empty_object(),
            operation_id: None,
        }
    }

    /// A problem whose status comes from the [`status_for_code`] table.
    /// Codes the table does not know answer 500.
    pub fn for_code(code: impl Into<String>, detail: impl Into<String>) -> Self {
        let code = code.into();
        let status = status_for_code(&code).unwrap_or(500);
        Self::new(status, code, detail)
    }

    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = request_id.into();
        self
    }

    pub fn with_instance(mut self, instance: impl Into<String>) -> Self {
        self.instance = Some(instance.into());
        self
    }

    /// Replace `details`. A non-object is wrapped as `{ "value": … }` so the
    /// documented "always an object" holds.
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = match details {
            Value::Object(_) => details,
            Value::Null => empty_object(),
            other => serde_json::json!({ "value": other }),
        };
        self
    }

    /// Insert one key into `details`.
    pub fn with_detail_field(mut self, key: &str, value: impl Into<Value>) -> Self {
        if !self.details.is_object() {
            self.details = empty_object();
        }
        if let Value::Object(map) = &mut self.details {
            map.insert(key.to_string(), value.into());
        }
        self
    }

    pub fn with_operation_id(mut self, operation_id: impl Into<String>) -> Self {
        self.operation_id = Some(operation_id.into());
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    /// `details.retryAfterSeconds`, when the producer quantified the wait.
    pub fn retry_after_secs(&self) -> Option<u64> {
        self.details
            .get("retryAfterSeconds")
            .and_then(Value::as_u64)
    }

    /// Read a problem back from JSON, tolerating the shapes this document
    /// replaced so receipts and frames written before ADR-0175 still replay.
    ///
    /// Accepted, in order: the RFC document itself. Then `{ error: { … } }`
    /// with the legacy `code/message/requestId/retryable/details` members.
    /// Then the same members flat. `fallback_status` fills `status` for the
    /// legacy shapes, which never carried one.
    pub fn parse(value: &Value, fallback_status: u16) -> Option<Self> {
        if let Ok(problem) = serde_json::from_value::<Problem>(value.clone()) {
            return Some(problem);
        }
        let candidate = match value.get("error") {
            Some(nested) if nested.is_object() => nested,
            _ => value,
        };
        let code = candidate.get("code")?.as_str()?;
        let detail = candidate
            .get("detail")
            .or_else(|| candidate.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let status = candidate
            .get("status")
            .and_then(Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
            .unwrap_or(fallback_status);
        let mut problem = Self::new(status, code, detail);
        if let Some(request_id) = candidate.get("requestId").and_then(Value::as_str) {
            problem.request_id = request_id.to_string();
        }
        if let Some(retryable) = candidate.get("retryable").and_then(Value::as_bool) {
            problem.retryable = retryable;
        }
        if let Some(details) = candidate.get("details").cloned() {
            problem = problem.with_details(details);
        }
        if let Some(operation_id) = candidate.get("operationId").and_then(Value::as_str) {
            problem.operation_id = Some(operation_id.to_string());
        }
        Some(problem)
    }

    /// The JSON Schema of this document, for the generated contract.
    pub fn json_schema() -> schemars::Schema {
        schemars::schema_for!(Problem)
    }
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}: {}", self.status, self.code, self.detail)
    }
}

impl std::error::Error for Problem {}

fn truncate_detail(detail: String) -> String {
    if detail.chars().count() <= MAX_DETAIL_CHARS {
        return detail;
    }
    let truncated: String = detail.chars().take(MAX_DETAIL_CHARS).collect();
    format!("{truncated}{TRUNCATED_SUFFIX}")
}

/// The reason phrase for a status. Only the statuses the companion planes
/// answer with are spelled out. Anything else falls back to its class.
pub fn title_for_status(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        412 => "Precondition Failed",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        422 => "Unprocessable Entity",
        423 => "Locked",
        426 => "Upgrade Required",
        428 => "Precondition Required",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        other if (400..500).contains(&other) => "Client Error",
        other if (500..600).contains(&other) => "Server Error",
        _ => "Error",
    }
}

/// The status a well-known code answers with. This is the one table the
/// planes share, so `unknown_command` cannot be a 404 on one route and a 400
/// on another. Codes that belong to one arm only are not listed. Those arms
/// state their status where they raise the problem.
pub fn status_for_code(code: &str) -> Option<u16> {
    Some(match code {
        "malformed_request"
        | "invalid_request"
        | "invalid_json_request"
        | "validation_failed"
        | "invalid_arguments" => 400,
        "missing_authorization"
        | "invalid_token"
        | "expired_token"
        | "wrong_scope"
        | "device_revoked"
        | "service_token_remote"
        | "oidc_authentication_failed"
        | "invalid_device_proof"
        | "session_required"
        | "session_invalid"
        | "missing_device_context" => 401,
        "forbidden"
        | "remote_control_forbidden"
        | "capability_missing"
        | "command_transport_forbidden"
        | "policy_constraints_mismatch"
        | "service_scope_required"
        | "operator_identity_required"
        | "browser_submissions_disabled" => 403,
        "unknown_command" | "not_found" | "operation_not_found" | "media_not_found" => 404,
        "command_renamed" => 410,
        "idempotency_conflict" | "idempotency_indeterminate" | "conflict" => 409,
        "payload_too_large" => 413,
        "unsupported_media_type" => 415,
        "contract_violation" | "output_contract_violation" => 422,
        "upgrade_required" => 426,
        "interactive_approval_required" | "signed_policy_required" => 428,
        "rate_limited" => 429,
        "internal_error" | "operation_failed" | "operation_interrupted" => 500,
        "service_unavailable"
        | "security_store_unavailable"
        | "headless_unsupported"
        | "headless_host_required"
        | "server_draining" => 503,
        _ => return None,
    })
}

/// Page tokens and the page envelope (ADR-0175 B3).
pub mod paging;

#[cfg(feature = "axum")]
mod axum_support {
    use super::{Problem, CONTENT_TYPE, REQUEST_ID_HEADER};
    use axum::http::{header, HeaderValue, StatusCode};
    use axum::response::{IntoResponse, Response};

    impl Problem {
        /// `status` as the HTTP type. An out-of-range value answers 500 rather
        /// than panicking inside a response builder.
        pub fn status_code(&self) -> StatusCode {
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
        }

        /// [`Problem::new`] taking the HTTP status type.
        pub fn with_status(
            status: StatusCode,
            code: impl Into<String>,
            detail: impl Into<String>,
        ) -> Self {
            Self::new(status.as_u16(), code, detail)
        }
    }

    impl IntoResponse for Problem {
        fn into_response(self) -> Response {
            let body = serde_json::to_vec(&self).unwrap_or_else(|_| b"{}".to_vec());
            let mut response = Response::new(axum::body::Body::from(body));
            *response.status_mut() = self.status_code();
            let headers = response.headers_mut();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(CONTENT_TYPE));
            if let Ok(value) = HeaderValue::from_str(&self.request_id) {
                headers.insert(REQUEST_ID_HEADER, value);
            }
            if let Some(secs) = self.retry_after_secs() {
                if let Ok(value) = HeaderValue::from_str(&secs.to_string()) {
                    headers.insert(header::RETRY_AFTER, value);
                }
            }
            response
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_as_the_rfc_document_with_the_companion_extensions() {
        let problem = Problem::new(410, "command_renamed", "session_list is now session.list")
            .with_request_id("req-1")
            .with_instance("/api/_rpc/session_list")
            .with_details(json!({ "replacement": "session.list" }));
        let value = serde_json::to_value(&problem).unwrap();
        assert_eq!(
            value,
            json!({
                "type": "https://cognia.dev/problems/command_renamed",
                "title": "Gone",
                "status": 410,
                "detail": "session_list is now session.list",
                "instance": "/api/_rpc/session_list",
                "code": "command_renamed",
                "requestId": "req-1",
                "retryable": false,
                "details": { "replacement": "session.list" }
            })
        );
    }

    #[test]
    fn absent_instance_and_operation_id_are_omitted_not_null() {
        let value = serde_json::to_value(Problem::new(404, "unknown_command", "nope")).unwrap();
        let object = value.as_object().unwrap();
        assert!(!object.contains_key("instance"));
        assert!(!object.contains_key("operationId"));
        assert_eq!(object["details"], json!({}));
    }

    #[test]
    fn retryable_defaults_to_the_server_error_class() {
        assert!(Problem::new(503, "service_unavailable", "booting").retryable);
        assert!(!Problem::new(404, "unknown_command", "nope").retryable);
        assert!(
            Problem::new(429, "rate_limited", "slow")
                .retryable(true)
                .retryable
        );
    }

    #[test]
    fn for_code_reads_the_shared_status_table() {
        assert_eq!(Problem::for_code("unknown_command", "").status, 404);
        assert_eq!(Problem::for_code("command_renamed", "").status, 410);
        assert_eq!(Problem::for_code("rate_limited", "").status, 429);
        assert_eq!(Problem::for_code("no_such_code", "").status, 500);
    }

    #[test]
    fn details_are_always_an_object() {
        assert_eq!(
            Problem::new(400, "x", "")
                .with_details(json!("text"))
                .details,
            json!({ "value": "text" })
        );
        assert_eq!(
            Problem::new(400, "x", "").with_details(Value::Null).details,
            json!({})
        );
        assert_eq!(
            Problem::new(400, "x", "")
                .with_detail_field("replacement", "a.b")
                .details,
            json!({ "replacement": "a.b" })
        );
    }

    #[test]
    fn detail_is_bounded() {
        let problem = Problem::new(500, "internal_error", "x".repeat(10_000));
        assert!(problem.detail.chars().count() < MAX_DETAIL_CHARS + TRUNCATED_SUFFIX.len() + 1);
        assert!(problem.detail.ends_with(TRUNCATED_SUFFIX));
    }

    #[test]
    fn parse_round_trips_the_rfc_document() {
        let original = Problem::new(409, "idempotency_conflict", "reused")
            .with_request_id("req-9")
            .with_operation_id("op-1")
            .with_details(json!({ "a": 1 }));
        let value = serde_json::to_value(&original).unwrap();
        assert_eq!(Problem::parse(&value, 500), Some(original));
    }

    #[test]
    fn parse_accepts_the_nested_legacy_envelope() {
        let legacy = json!({
            "error": {
                "code": "operation_failed",
                "message": "the prior operation failed",
                "requestId": "req-old",
                "retryable": true,
                "details": { "why": "disk" }
            }
        });
        let problem = Problem::parse(&legacy, 502).unwrap();
        assert_eq!(problem.status, 502);
        assert_eq!(problem.title, "Bad Gateway");
        assert_eq!(problem.code, "operation_failed");
        assert_eq!(problem.detail, "the prior operation failed");
        assert_eq!(problem.request_id, "req-old");
        assert!(problem.retryable);
        assert_eq!(problem.details, json!({ "why": "disk" }));
    }

    #[test]
    fn parse_accepts_the_flat_legacy_envelope_and_refuses_junk() {
        let flat = json!({ "code": "rate_limited", "message": "slow", "retryable": true });
        let problem = Problem::parse(&flat, 429).unwrap();
        assert_eq!(problem.code, "rate_limited");
        assert_eq!(problem.status, 429);
        assert!(Problem::parse(&json!({ "hello": 1 }), 500).is_none());
        assert!(Problem::parse(&json!("text"), 500).is_none());
    }

    #[test]
    fn titles_cover_every_status_the_planes_answer() {
        for status in [
            400, 401, 403, 404, 409, 410, 415, 422, 426, 428, 429, 500, 503,
        ] {
            assert_ne!(
                title_for_status(status),
                "Error",
                "{status} needs a reason phrase"
            );
        }
        assert_eq!(title_for_status(418), "Client Error");
        assert_eq!(title_for_status(599), "Server Error");
        assert_eq!(title_for_status(200), "Error");
    }

    #[test]
    fn schema_requires_the_extension_members() {
        let schema = serde_json::to_value(Problem::json_schema()).unwrap();
        let required: Vec<&str> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        for member in [
            "type",
            "title",
            "status",
            "detail",
            "code",
            "requestId",
            "retryable",
        ] {
            assert!(required.contains(&member), "{member} must be required");
        }
        assert!(schema["properties"]["operationId"].is_object());
        assert!(schema["properties"]["instance"].is_object());
    }

    #[test]
    fn display_is_status_code_detail() {
        assert_eq!(
            Problem::new(404, "unknown_command", "no such command").to_string(),
            "404 unknown_command: no such command"
        );
    }

    #[cfg(feature = "axum")]
    mod http {
        use super::super::*;
        use axum::response::IntoResponse;

        #[tokio::test]
        async fn into_response_sets_status_media_type_and_request_id() {
            let response = Problem::new(410, "command_renamed", "renamed")
                .with_request_id("req-42")
                .into_response();
            assert_eq!(response.status(), 410);
            assert_eq!(
                response.headers()[axum::http::header::CONTENT_TYPE],
                "application/problem+json"
            );
            assert_eq!(response.headers()[REQUEST_ID_HEADER], "req-42");
            assert!(response
                .headers()
                .get(axum::http::header::RETRY_AFTER)
                .is_none());
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["code"], "command_renamed");
            assert_eq!(body["requestId"], "req-42");
            assert_eq!(body["status"], 410);
        }

        #[tokio::test]
        async fn a_quantified_wait_becomes_the_retry_after_header() {
            let response = Problem::new(429, "rate_limited", "slow")
                .retryable(true)
                .with_detail_field("retryAfterSeconds", 7)
                .into_response();
            assert_eq!(response.headers()[axum::http::header::RETRY_AFTER], "7");
        }

        #[test]
        fn an_out_of_range_status_answers_500_instead_of_panicking() {
            assert_eq!(
                Problem::new(7, "x", "").status_code(),
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            );
        }
    }
}
