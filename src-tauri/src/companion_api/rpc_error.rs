//! The companion RPC error envelope (ADR-0196 P5.2).
//!
//! Every RPC arm, and the canonical remote-execution path in front of them,
//! answers failures as `(StatusCode, Json<RpcError>)`. It lives in the core so
//! that path can speak it without reaching into the dispatch table; `rpc.rs`
//! re-exports it for the arms.

use axum::{http::StatusCode, Json};

/// JSON error body returned on any non-200 response.
#[derive(Debug, serde::Serialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    /// Whether the caller may safely repeat this request unchanged.
    ///
    /// `CommandError` (crates/cognia-core) exists to carry exactly this, but
    /// the RPC envelope dropped it, so `transport-companion.ts` re-derived it
    /// from the HTTP status — which cannot distinguish "the host is booting,
    /// try again" from "this host will never serve that command", both 503.
    /// Each constructor below states the answer instead of leaving it to be
    /// guessed downstream.
    pub retryable: bool,
}

impl RpcError {
    /// Non-retryable by default: most RPC failures are contract or capability
    /// problems that repeating verbatim cannot fix. Transient cases opt in.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn unknown_command(name: &str) -> (StatusCode, Json<Self>) {
        (
            StatusCode::NOT_FOUND,
            Json(Self::new(
                "unknown_command",
                format!("RPC command '{name}' is not exposed to mobile clients"),
            )),
        )
    }

    pub fn malformed(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::BAD_REQUEST,
            Json(Self::new("malformed_request", detail)),
        )
    }

    /// Browser Companion kill switch (ADR-0154). Browser Access is switched
    /// off, so this Host is not accepting new work from a browser — but the
    /// listener it is still answering on stays up until the server restarts,
    /// and the reads a paired panel makes keep working. That asymmetry is the
    /// point: turning the switch off must stop submissions immediately without
    /// making the tasks a browser already started unreachable from it.
    ///
    /// Not retryable: repeating it verbatim cannot help, and the remedy is a
    /// control in the Host's settings rather than anything the caller holds.
    pub fn browser_submissions_disabled() -> (StatusCode, Json<Self>) {
        (
            StatusCode::FORBIDDEN,
            Json(Self::new(
                "browser_submissions_disabled",
                "browser access is switched off on this Host; no new submissions are being accepted",
            )),
        )
    }

    /// A grant the target device's class does not admit (ADR-0154): a browser
    /// companion holds only `browser.submit` and `browser.read-own`. The same
    /// code and status the Owner route answers with for the same store error.
    ///
    /// Not retryable: the class is fixed by the enrollment the device spent.
    pub fn capability_outside_device_class(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::FORBIDDEN,
            Json(Self::new("capability_outside_device_class", detail)),
        )
    }

    pub fn service_unavailable(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Self::new("service_unavailable", detail).retryable()),
        )
    }

    pub fn upgrade_required(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::UPGRADE_REQUIRED,
            Json(Self::new("upgrade_required", detail)),
        )
    }

    /// ADR-0059 R5 — the command's body still requires the desktop Tauri
    /// runtime and this process is a headless `cognia-server`. Distinct code
    /// from `service_unavailable` so clients can tell "retry later" (server
    /// booting) from "this feature does not exist on a headless install".
    pub fn headless_unsupported(name: &str) -> (StatusCode, Json<Self>) {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Self::new(
                "headless_unsupported",
                format!("RPC command '{name}' is not available on a headless server (requires the desktop app)"),
            )),
        )
    }

    /// The mirror image of [`Self::headless_unsupported`]: the command is
    /// implemented by the headless service container and this process is a
    /// desktop-hosted companion server, which has none.
    ///
    /// These two were the same error for a long time, and 99 arms — every
    /// `host.headless().ok_or_else(...)` — reported the desktop case with the
    /// headless case's message, telling operators to "use the desktop app"
    /// while running on the desktop app. Only one command is genuinely
    /// desktop-only (`companion_endpoints`), so the reversed message was the
    /// overwhelmingly common one.
    pub fn headless_host_required(name: &str) -> (StatusCode, Json<Self>) {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Self::new(
                "headless_host_required",
                format!(
                    "RPC command '{name}' is served by the headless host services and this process \
                     is a desktop-hosted companion server (run it against a `cognia-server` host)"
                ),
            )),
        )
    }

    pub fn internal(detail: String) -> (StatusCode, Json<Self>) {
        if detail.starts_with("brain bridge disconnected")
            || detail.starts_with("brain bridge overloaded")
        {
            return Self::service_unavailable(detail);
        }
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(Self::new("internal_error", detail)),
        )
    }

    /// The transcript protocol's own error vocabulary
    /// (`TranscriptErrorCode`), published as the RPC `code`.
    ///
    /// Both transcript planes answer with one of these strings, and every
    /// client branch that acts on one of them (reconcile after a revision
    /// bump, re-anchor a moved turn, fall back to a locally owned transcript)
    /// reads `error.code`. Routed through [`Self::internal`] they all arrived
    /// as `internal_error` with the real code buried in the message, so those
    /// branches were unreachable over the companion transport and a client
    /// could only surface the failure verbatim.
    ///
    /// The status stays 400 rather than a more specific 404 or 409: `404` is
    /// how this endpoint says "no such command", which is exactly the
    /// downgrade signal a transcript client must not confuse with "no such
    /// session".
    pub fn transcript(detail: String) -> (StatusCode, Json<Self>) {
        match detail.as_str() {
            "INVALID_PARAMS" | "SESSION_NOT_FOUND" | "TRANSCRIPT_STALE" | "TURN_NOT_FOUND"
            | "TURN_NOT_COMPLETED" | "MEDIA_NOT_FOUND" => (
                StatusCode::BAD_REQUEST,
                Json(Self::new(detail.clone(), detail)),
            ),
            "TRANSCRIPT_STORE_ERROR" => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(Self::new(detail.clone(), detail).retryable()),
            ),
            _ => Self::internal(detail),
        }
    }

    #[cfg(test)]
    pub fn idempotency_conflict() -> (StatusCode, Json<Self>) {
        (
            StatusCode::CONFLICT,
            Json(Self::new(
                "idempotency_conflict",
                "the idempotency key was already used with different parameters",
            )),
        )
    }

    #[cfg(test)]
    pub fn idempotency_indeterminate() -> (StatusCode, Json<Self>) {
        (
            StatusCode::CONFLICT,
            Json(Self::new(
                "idempotency_indeterminate",
                "the prior execution did not record a final result and will not be replayed",
            )),
        )
    }

    /// Remote session control gate (Remote Session Control). The device is
    /// paired and authenticated but has not been granted the elevated
    /// remote-control capability — `allowRemoteControl` is off for it. The
    /// owner enables it per-device from the desktop paired-devices settings
    /// (biometric-gated).
    pub fn forbidden(detail: impl Into<String>) -> (StatusCode, Json<Self>) {
        (
            StatusCode::FORBIDDEN,
            Json(Self::new("remote_control_forbidden", detail)),
        )
    }

    /// Wave 3.3 — 429 Too Many Requests with the wait time embedded in
    /// the message (`retry_after_seconds=N`). The flat envelope keeps
    /// the contract simple; phones can parse the integer.
    /// `pub(super)` so the device plane's own 429 constructor can be pinned
    /// against this one. Two producers of the same status code that disagree on
    /// the wire shape is a client-side bug waiting to happen, and the drift
    /// guard has to be able to see both.
    pub fn rate_limited(retry_after_secs: u64) -> (StatusCode, Json<Self>) {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(
                Self::new(
                    "rate_limited",
                    format!(
                    "device exceeded the per-minute quota; retry_after_seconds={retry_after_secs}"
                ),
                )
                .retryable(),
            ),
        )
    }

    /// Wave 3.2 — request shape rejected. Distinct from
    /// `malformed_request` so clients can route validation failures
    /// (recoverable, fix the payload and retry) separately from
    /// transport-level malformed JSON (terminal at this layer).
    #[allow(dead_code)] // re-exposed when full schema validation lands.
    pub fn validation_failed(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::BAD_REQUEST,
            Json(Self::new("validation_failed", detail)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The envelope is wire contract: `transport-companion.ts` reads these
    /// three fields.
    #[test]
    fn the_envelope_serializes_code_message_and_retryable() {
        let (status, Json(error)) = RpcError::unknown_command("nope");
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "code": "unknown_command",
                "message": "RPC command 'nope' is not exposed to mobile clients",
                "retryable": false,
            })
        );
    }

    #[test]
    fn only_transient_failures_are_retryable() {
        assert!(RpcError::service_unavailable("booting".into()).1.retryable);
        assert!(!RpcError::forbidden("no").1.retryable);
        assert!(!RpcError::headless_unsupported("x").1.retryable);
    }
}
