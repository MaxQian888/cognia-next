//! Bounded request/response bridge from the WASM host to the renderer.
//!
//! Two v0.2 capabilities cannot be served in-process: `ai.generate-text` needs
//! the provider chain, the PII redaction gate, and the user's provider
//! settings; `workflow.emit-event` needs the workflow runtime's trigger
//! registry. All of that lives in the renderer's TypeScript. So the host emits
//! one request event, the renderer answers through the
//! `plugin_wasm_renderer_response` Tauri command, and this module owns the
//! pending-request pool in between.
//!
//! Structurally parallel to [`crate::cli_bridge::renderer_bridge`] but
//! deliberately separate: different channels, different pool, and a
//! plugin-identity binding the CLI bridge has no need for. A WASM guest is
//! untrusted code, so every frame is bound to the plugin id the host knows
//! from `HostState` — never one the guest supplied.
//!
//! # Why cancellation is load-bearing, not a nicety
//!
//! `Store::set_epoch_deadline` traps at wasm execution points. A host import
//! awaiting the renderer is *not* executing wasm, so epoch interruption does
//! not bound it — [`effective_timeout_ms`] is the only bound on an AI call.
//! And `plugin_wasm_call_for_state` holds the per-plugin `tokio::sync::Mutex`
//! for the whole guest call, so an in-flight 30 s round trip blocks every other
//! export on that plugin. Without [`WasmRendererBridge::cancel_plugin`], a
//! deactivate during an AI call leaks a live store for up to 30 s.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;
use uuid::Uuid;

use super::errors::{coded, WasmErrorCode};

/// Event the host emits carrying one renderer-backed request.
pub const REQUEST_EVENT: &str = "plugin-wasm://renderer-request";
/// Event the host emits to abort an in-flight request.
pub const CANCEL_EVENT: &str = "plugin-wasm://renderer-cancel";
/// Tauri command the renderer invokes to answer a request.
pub const RESPONSE_COMMAND: &str = "plugin_wasm_renderer_response";

/// Ceiling on how long the host waits for the renderer, before the plugin
/// manifest's `wasm.callTimeoutMs` narrows it further.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Generic envelope cap, both directions. Per-surface caps (1 MiB AI prompt,
/// 1 MiB clipboard text) are stricter and are enforced earlier, by the
/// capability modules.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// Transport seam so the bridge can be unit-tested without a Tauri app.
pub trait WasmBridgeTransport: Send + Sync + 'static {
    fn emit(&self, channel: &str, payload: Value) -> Result<(), String>;
    /// `"webview"` | `"recording"`. Diagnostics only.
    fn kind(&self) -> &'static str;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmBridgeOperation {
    AiGenerateText,
    WorkflowEmitEvent,
}

impl WasmBridgeOperation {
    pub const fn as_str(self) -> &'static str {
        match self {
            WasmBridgeOperation::AiGenerateText => "ai.generate-text",
            WasmBridgeOperation::WorkflowEmitEvent => "workflow.emit-event",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmRendererRequest {
    pub request_id: String,
    pub plugin_id: String,
    pub operation: &'static str,
    pub timeout_ms: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmRendererErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmRendererResponse {
    #[serde(alias = "request_id")]
    pub request_id: String,
    #[serde(alias = "plugin_id")]
    pub plugin_id: String,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<WasmRendererErrorBody>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CancelReason {
    Timeout,
    Caller,
    Deactivate,
    Unload,
}

impl CancelReason {
    const fn as_str(self) -> &'static str {
        match self {
            CancelReason::Timeout => "timeout",
            CancelReason::Caller => "caller",
            CancelReason::Deactivate => "deactivate",
            CancelReason::Unload => "unload",
        }
    }

    /// The code a guest sees when a request ends this way.
    const fn error_code(self) -> WasmErrorCode {
        match self {
            CancelReason::Timeout => WasmErrorCode::Timeout,
            _ => WasmErrorCode::Cancelled,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmRendererCancel {
    pub request_id: String,
    pub plugin_id: String,
    pub reason: CancelReason,
}

/// An error with the code already chosen, so callers never re-classify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WasmBridgeError {
    pub code: WasmErrorCode,
    pub message: String,
}

impl WasmBridgeError {
    pub fn new(code: WasmErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn to_wire(&self) -> String {
        coded(self.code, &self.message)
    }
}

struct PendingEntry {
    /// Captured from `HostState` at register time. Never guest-supplied.
    plugin_id: String,
    operation: &'static str,
    request_bytes: usize,
    started_at: Instant,
    tx: oneshot::Sender<Result<Value, WasmBridgeError>>,
}

/// Payload-free structured diagnostic.
///
/// The field set is closed and rendered by exactly one function so a future
/// contributor cannot casually add `prompt` or `payload` to a log line. v0.1's
/// `since_v0_1.rs` logged notification titles and bodies at info level; this
/// type exists so that class of leak cannot recur.
#[derive(Debug, Clone)]
pub struct BridgeDiagnostic<'a> {
    pub plugin_id: &'a str,
    pub operation: &'a str,
    pub outcome: &'static str,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub duration_ms: u128,
    pub error_code: Option<&'static str>,
    pub transport: &'static str,
}

impl BridgeDiagnostic<'_> {
    /// The ONLY place diagnostic fields are named. Unit-tested against an exact
    /// key allowlist so an added field cannot smuggle payload data into logs.
    pub fn fields(&self) -> Vec<(&'static str, String)> {
        vec![
            ("plugin_id", self.plugin_id.to_string()),
            ("operation", self.operation.to_string()),
            ("outcome", self.outcome.to_string()),
            ("request_bytes", self.request_bytes.to_string()),
            ("response_bytes", self.response_bytes.to_string()),
            ("duration_ms", self.duration_ms.to_string()),
            ("error_code", self.error_code.unwrap_or("none").to_string()),
            ("transport", self.transport.to_string()),
        ]
    }

    pub const ALLOWED_KEYS: &'static [&'static str] = &[
        "plugin_id",
        "operation",
        "outcome",
        "request_bytes",
        "response_bytes",
        "duration_ms",
        "error_code",
        "transport",
    ];

    fn emit(&self) {
        let rendered: Vec<String> = self
            .fields()
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        tracing::info!(
            target: "cognia_plugin",
            error_code = "plugin.wasm.bridge",
            "{}",
            rendered.join(" ")
        );
    }
}

/// How long the host will actually wait: the 30 s ceiling, narrowed by the
/// plugin manifest's `wasm.callTimeoutMs`. Pure, so it is tested directly.
pub const fn effective_timeout_ms(call_timeout_ms: u64) -> u64 {
    let requested = if call_timeout_ms == 0 {
        DEFAULT_TIMEOUT_MS
    } else {
        call_timeout_ms
    };
    if requested < DEFAULT_TIMEOUT_MS {
        requested
    } else {
        DEFAULT_TIMEOUT_MS
    }
}

pub struct WasmRendererBridge {
    transport: Arc<dyn WasmBridgeTransport>,
    pending: Mutex<HashMap<String, PendingEntry>>,
}

impl WasmRendererBridge {
    pub fn new(transport: Arc<dyn WasmBridgeTransport>) -> Arc<Self> {
        Arc::new(Self {
            transport,
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Round-trip one operation through the renderer.
    ///
    /// `plugin_id` MUST come from `HostState::plugin_id`. `payload` is guest
    /// data and is never consulted for identity or routing.
    pub async fn dispatch(
        self: &Arc<Self>,
        plugin_id: &str,
        operation: WasmBridgeOperation,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, WasmBridgeError> {
        // Size-gate BEFORE registering anything, so an oversized request never
        // occupies a pending slot or reaches the renderer.
        let request_bytes = match serde_json::to_vec(&payload) {
            Ok(bytes) => bytes.len(),
            Err(err) => {
                return Err(WasmBridgeError::new(
                    WasmErrorCode::InvalidRequest,
                    format!(
                        "{}: request payload is not serializable: {err}",
                        operation.as_str()
                    ),
                ))
            }
        };
        if request_bytes > MAX_BODY_BYTES {
            return Err(WasmBridgeError::new(
                WasmErrorCode::PayloadTooLarge,
                format!(
                    "{}: request body is {request_bytes} bytes, over the {MAX_BODY_BYTES} byte limit",
                    operation.as_str()
                ),
            ));
        }

        let (request_id, rx) = self.register(plugin_id, operation, request_bytes);
        let started_at = Instant::now();

        let frame = WasmRendererRequest {
            request_id: request_id.clone(),
            plugin_id: plugin_id.to_string(),
            operation: operation.as_str(),
            timeout_ms: timeout.as_millis() as u64,
            payload,
        };
        let encoded = match serde_json::to_value(&frame) {
            Ok(value) => value,
            Err(err) => {
                self.remove(&request_id);
                return Err(WasmBridgeError::new(
                    WasmErrorCode::InvalidRequest,
                    format!("{}: cannot encode request frame: {err}", operation.as_str()),
                ));
            }
        };

        if let Err(err) = self.transport.emit(REQUEST_EVENT, encoded) {
            self.remove(&request_id);
            self.diagnostic(
                plugin_id,
                operation.as_str(),
                "emit_failed",
                request_bytes,
                0,
                started_at,
                Some(WasmErrorCode::HostUnavailable.as_str()),
            );
            return Err(WasmBridgeError::new(
                WasmErrorCode::HostUnavailable,
                format!("{}: renderer is not reachable: {err}", operation.as_str()),
            ));
        }

        self.diagnostic(
            plugin_id,
            operation.as_str(),
            "dispatched",
            request_bytes,
            0,
            started_at,
            None,
        );

        self.await_response(
            request_id,
            plugin_id,
            operation,
            request_bytes,
            started_at,
            rx,
            timeout,
        )
        .await
    }

    fn register(
        &self,
        plugin_id: &str,
        operation: WasmBridgeOperation,
        request_bytes: usize,
    ) -> (String, oneshot::Receiver<Result<Value, WasmBridgeError>>) {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(
            request_id.clone(),
            PendingEntry {
                plugin_id: plugin_id.to_string(),
                operation: operation.as_str(),
                request_bytes,
                started_at: Instant::now(),
                tx,
            },
        );
        (request_id, rx)
    }

    fn remove(&self, request_id: &str) -> Option<PendingEntry> {
        self.pending.lock().remove(request_id)
    }

    #[allow(clippy::too_many_arguments)]
    async fn await_response(
        self: &Arc<Self>,
        request_id: String,
        plugin_id: &str,
        operation: WasmBridgeOperation,
        request_bytes: usize,
        started_at: Instant,
        rx: oneshot::Receiver<Result<Value, WasmBridgeError>>,
        timeout: Duration,
    ) -> Result<Value, WasmBridgeError> {
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => {
                let response_bytes = serde_json::to_vec(&value).map(|b| b.len()).unwrap_or(0);
                self.diagnostic(
                    plugin_id,
                    operation.as_str(),
                    "resolved",
                    request_bytes,
                    response_bytes,
                    started_at,
                    None,
                );
                Ok(value)
            }
            Ok(Ok(Err(err))) => {
                self.diagnostic(
                    plugin_id,
                    operation.as_str(),
                    "rejected",
                    request_bytes,
                    0,
                    started_at,
                    Some(err.code.as_str()),
                );
                Err(err)
            }
            // Sender dropped without sending — only reachable if the pool entry
            // was removed by something other than `resolve`/`cancel_plugin`.
            Ok(Err(_recv)) => {
                self.remove(&request_id);
                self.diagnostic(
                    plugin_id,
                    operation.as_str(),
                    "cancelled",
                    request_bytes,
                    0,
                    started_at,
                    Some(WasmErrorCode::Cancelled.as_str()),
                );
                Err(WasmBridgeError::new(
                    WasmErrorCode::Cancelled,
                    format!(
                        "{}: request was abandoned before completing",
                        operation.as_str()
                    ),
                ))
            }
            Err(_elapsed) => {
                self.remove(&request_id);
                self.emit_cancel(&request_id, plugin_id, CancelReason::Timeout);
                self.diagnostic(
                    plugin_id,
                    operation.as_str(),
                    "timeout",
                    request_bytes,
                    0,
                    started_at,
                    Some(WasmErrorCode::Timeout.as_str()),
                );
                Err(WasmBridgeError::new(
                    WasmErrorCode::Timeout,
                    format!(
                        "{}: renderer did not answer within {} ms",
                        operation.as_str(),
                        timeout.as_millis()
                    ),
                ))
            }
        }
    }

    /// Complete a pending request from a renderer response.
    ///
    /// Identity is compared **while the lock is held and before the entry is
    /// removed**. Remove-then-compare would let a buggy or hostile renderer
    /// cancel another plugin's in-flight request by guessing its id — a
    /// cross-plugin denial of service. Unknown, duplicate, and late responses
    /// all land on the same no-op path because the entry is already gone.
    pub fn resolve(&self, response: WasmRendererResponse) {
        let entry = {
            let mut pending = self.pending.lock();
            match pending.get(&response.request_id) {
                None => {
                    // Already resolved, timed out, or never existed.
                    self.diagnostic_static(&response.plugin_id, "unknown", "unknown_request", None);
                    return;
                }
                Some(existing) if existing.plugin_id != response.plugin_id => {
                    let operation = existing.operation;
                    // Entry deliberately left in place.
                    self.diagnostic_static(
                        &existing.plugin_id.clone(),
                        operation,
                        "identity_mismatch",
                        None,
                    );
                    return;
                }
                Some(_) => pending.remove(&response.request_id),
            }
        };
        let Some(entry) = entry else { return };

        let payload = match (response.result, response.error) {
            (_, Some(err)) => {
                // A renderer must not be able to forge a code outside the
                // vocabulary — unknown codes downgrade to PROVIDER_ERROR.
                Err(WasmBridgeError::new(
                    WasmErrorCode::from_renderer_code(&err.code),
                    err.message,
                ))
            }
            (Some(value), None) => match serde_json::to_vec(&value) {
                Ok(bytes) if bytes.len() > MAX_BODY_BYTES => Err(WasmBridgeError::new(
                    WasmErrorCode::PayloadTooLarge,
                    format!(
                        "{}: response body is {} bytes, over the {MAX_BODY_BYTES} byte limit",
                        entry.operation,
                        bytes.len()
                    ),
                )),
                _ => Ok(value),
            },
            (None, None) => Err(WasmBridgeError::new(
                WasmErrorCode::ProviderError,
                format!(
                    "{}: renderer response carried neither result nor error",
                    entry.operation
                ),
            )),
        };

        let _ = entry.tx.send(payload);
    }

    /// Drain every pending request for one plugin. Returns how many were ended.
    pub fn cancel_plugin(&self, plugin_id: &str, reason: CancelReason) -> usize {
        let drained: Vec<(String, PendingEntry)> = {
            let mut pending = self.pending.lock();
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, entry)| entry.plugin_id == plugin_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id).map(|entry| (id, entry)))
                .collect()
        };

        let count = drained.len();
        for (request_id, entry) in drained {
            self.emit_cancel(&request_id, plugin_id, reason);
            self.diagnostic(
                plugin_id,
                entry.operation,
                "cancelled",
                entry.request_bytes,
                0,
                entry.started_at,
                Some(reason.error_code().as_str()),
            );
            let _ = entry.tx.send(Err(WasmBridgeError::new(
                reason.error_code(),
                format!("{}: cancelled ({})", entry.operation, reason.as_str()),
            )));
        }
        count
    }

    fn emit_cancel(&self, request_id: &str, plugin_id: &str, reason: CancelReason) {
        let frame = WasmRendererCancel {
            request_id: request_id.to_string(),
            plugin_id: plugin_id.to_string(),
            reason,
        };
        if let Ok(value) = serde_json::to_value(&frame) {
            // A failed cancel emit is not actionable for the guest — the
            // request has already been resolved host-side.
            let _ = self.transport.emit(CANCEL_EVENT, value);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn diagnostic(
        &self,
        plugin_id: &str,
        operation: &str,
        outcome: &'static str,
        request_bytes: usize,
        response_bytes: usize,
        started_at: Instant,
        error_code: Option<&'static str>,
    ) {
        BridgeDiagnostic {
            plugin_id,
            operation,
            outcome,
            request_bytes,
            response_bytes,
            duration_ms: started_at.elapsed().as_millis(),
            error_code,
            transport: self.transport.kind(),
        }
        .emit();
    }

    fn diagnostic_static(
        &self,
        plugin_id: &str,
        operation: &str,
        outcome: &'static str,
        error_code: Option<&'static str>,
    ) {
        BridgeDiagnostic {
            plugin_id,
            operation,
            outcome,
            request_bytes: 0,
            response_bytes: 0,
            duration_ms: 0,
            error_code,
            transport: self.transport.kind(),
        }
        .emit();
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::services::test_support::RecordingWasmBridgeTransport;
    use serde_json::json;

    fn bridge() -> (Arc<WasmRendererBridge>, Arc<RecordingWasmBridgeTransport>) {
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        (WasmRendererBridge::new(transport.clone()), transport)
    }

    #[test]
    fn effective_timeout_caps_at_30s_and_honours_shorter_manifests() {
        assert_eq!(effective_timeout_ms(5_000), 5_000);
        assert_eq!(effective_timeout_ms(120_000), DEFAULT_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(0), DEFAULT_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(1), 1);
    }

    #[tokio::test]
    async fn dispatch_uses_trusted_plugin_id_not_the_payload() {
        let (bridge, transport) = bridge();
        let b = bridge.clone();
        tokio::spawn(async move {
            let _ = b
                .dispatch(
                    "real.plugin",
                    WasmBridgeOperation::AiGenerateText,
                    // The guest claims to be someone else.
                    json!({ "pluginId": "attacker", "prompt": "hi" }),
                    Duration::from_millis(50),
                )
                .await;
        });
        tokio::time::sleep(Duration::from_millis(10)).await;

        let frames = transport.frames_for(REQUEST_EVENT);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["pluginId"], json!("real.plugin"));
        // The guest's claim survives only inside the opaque payload.
        assert_eq!(frames[0]["payload"]["pluginId"], json!("attacker"));
    }

    #[tokio::test]
    async fn dispatch_generates_a_fresh_request_id_each_time() {
        let (bridge, transport) = bridge();
        for _ in 0..2 {
            let b = bridge.clone();
            tokio::spawn(async move {
                let _ = b
                    .dispatch(
                        "p",
                        WasmBridgeOperation::AiGenerateText,
                        json!({}),
                        Duration::from_millis(50),
                    )
                    .await;
            });
        }
        tokio::time::sleep(Duration::from_millis(10)).await;

        let frames = transport.frames_for(REQUEST_EVENT);
        assert_eq!(frames.len(), 2);
        let a = frames[0]["requestId"].as_str().unwrap();
        let b = frames[1]["requestId"].as_str().unwrap();
        assert_ne!(a, b);
        assert!(Uuid::parse_str(a).is_ok());
        assert!(Uuid::parse_str(b).is_ok());
    }

    #[tokio::test]
    async fn resolve_completes_a_matching_request() {
        let (bridge, transport) = bridge();
        let b = bridge.clone();
        let handle = tokio::spawn(async move {
            b.dispatch(
                "p",
                WasmBridgeOperation::AiGenerateText,
                json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;

        let request_id = transport.frames_for(REQUEST_EVENT)[0]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        bridge.resolve(WasmRendererResponse {
            request_id,
            plugin_id: "p".into(),
            result: Some(json!({ "text": "ok" })),
            error: None,
        });

        assert_eq!(handle.await.unwrap().unwrap(), json!({ "text": "ok" }));
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn resolve_with_mismatched_plugin_id_leaves_the_entry_pending() {
        // The security test. A response naming the wrong plugin must not be
        // able to complete — or cancel — someone else's request.
        let (bridge, transport) = bridge();
        let b = bridge.clone();
        let handle = tokio::spawn(async move {
            b.dispatch(
                "victim",
                WasmBridgeOperation::AiGenerateText,
                json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;

        let request_id = transport.frames_for(REQUEST_EVENT)[0]["requestId"]
            .as_str()
            .unwrap()
            .to_string();

        bridge.resolve(WasmRendererResponse {
            request_id: request_id.clone(),
            plugin_id: "attacker".into(),
            result: Some(json!({ "text": "poisoned" })),
            error: None,
        });

        // Still pending, still unresolved.
        assert_eq!(bridge.pending_count(), 1);

        // The rightful owner can still complete it.
        bridge.resolve(WasmRendererResponse {
            request_id,
            plugin_id: "victim".into(),
            result: Some(json!({ "text": "genuine" })),
            error: None,
        });
        assert_eq!(handle.await.unwrap().unwrap(), json!({ "text": "genuine" }));
    }

    #[test]
    fn resolve_unknown_request_id_is_a_noop() {
        let (bridge, _) = bridge();
        bridge.resolve(WasmRendererResponse {
            request_id: "no-such-id".into(),
            plugin_id: "p".into(),
            result: Some(json!({})),
            error: None,
        });
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn duplicate_and_late_responses_are_noops() {
        let (bridge, transport) = bridge();
        let b = bridge.clone();
        let handle = tokio::spawn(async move {
            b.dispatch(
                "p",
                WasmBridgeOperation::AiGenerateText,
                json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;

        let request_id = transport.frames_for(REQUEST_EVENT)[0]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        let respond = |value: &str| WasmRendererResponse {
            request_id: request_id.clone(),
            plugin_id: "p".into(),
            result: Some(json!({ "text": value })),
            error: None,
        };

        bridge.resolve(respond("first"));
        // Second and third must not panic and must not change the outcome.
        bridge.resolve(respond("second"));
        bridge.resolve(respond("third"));

        assert_eq!(handle.await.unwrap().unwrap(), json!({ "text": "first" }));
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn timeout_removes_pending_and_emits_a_cancel_frame() {
        let (bridge, transport) = bridge();
        let err = bridge
            .dispatch(
                "p",
                WasmBridgeOperation::AiGenerateText,
                json!({}),
                Duration::from_millis(20),
            )
            .await
            .unwrap_err();

        assert_eq!(err.code, WasmErrorCode::Timeout);
        assert_eq!(bridge.pending_count(), 0);

        let cancels = transport.frames_for(CANCEL_EVENT);
        assert_eq!(cancels.len(), 1);
        assert_eq!(cancels[0]["reason"], json!("timeout"));
        assert_eq!(cancels[0]["pluginId"], json!("p"));
    }

    #[tokio::test]
    async fn cancel_plugin_drains_only_the_named_plugin() {
        let (bridge, transport) = bridge();
        let a = bridge.clone();
        let handle_a = tokio::spawn(async move {
            a.dispatch(
                "a",
                WasmBridgeOperation::AiGenerateText,
                json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        let b = bridge.clone();
        let _handle_b = tokio::spawn(async move {
            b.dispatch(
                "b",
                WasmBridgeOperation::AiGenerateText,
                json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(bridge.pending_count(), 2);

        assert_eq!(bridge.cancel_plugin("a", CancelReason::Deactivate), 1);
        assert_eq!(bridge.pending_count(), 1);

        let err = handle_a.await.unwrap().unwrap_err();
        assert_eq!(err.code, WasmErrorCode::Cancelled);
        assert!(err.message.contains("deactivate"));

        let cancels = transport.frames_for(CANCEL_EVENT);
        assert_eq!(cancels.len(), 1);
        assert_eq!(cancels[0]["pluginId"], json!("a"));
        assert_eq!(cancels[0]["reason"], json!("deactivate"));
    }

    #[tokio::test]
    async fn cancel_plugin_with_unload_reason_reports_cancelled() {
        let (bridge, _) = bridge();
        let b = bridge.clone();
        let handle = tokio::spawn(async move {
            b.dispatch(
                "p",
                WasmBridgeOperation::WorkflowEmitEvent,
                json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;

        assert_eq!(bridge.cancel_plugin("p", CancelReason::Unload), 1);
        let err = handle.await.unwrap().unwrap_err();
        assert_eq!(err.code, WasmErrorCode::Cancelled);
        assert!(err.message.contains("unload"));
    }

    #[tokio::test]
    async fn emit_failure_removes_pending_and_returns_host_unavailable() {
        let transport = Arc::new(RecordingWasmBridgeTransport::failing());
        let bridge = WasmRendererBridge::new(transport);
        let err = bridge
            .dispatch(
                "p",
                WasmBridgeOperation::AiGenerateText,
                json!({}),
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();

        assert_eq!(err.code, WasmErrorCode::HostUnavailable);
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn oversize_request_is_rejected_before_registering() {
        let (bridge, transport) = bridge();
        let big = "x".repeat(MAX_BODY_BYTES + 1);
        let err = bridge
            .dispatch(
                "p",
                WasmBridgeOperation::AiGenerateText,
                json!({ "prompt": big }),
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();

        assert_eq!(err.code, WasmErrorCode::PayloadTooLarge);
        // Nothing allocated, nothing emitted.
        assert_eq!(bridge.pending_count(), 0);
        assert_eq!(transport.frames_for(REQUEST_EVENT).len(), 0);
    }

    #[tokio::test]
    async fn oversize_response_is_rejected() {
        let (bridge, transport) = bridge();
        let b = bridge.clone();
        let handle = tokio::spawn(async move {
            b.dispatch(
                "p",
                WasmBridgeOperation::AiGenerateText,
                json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;

        let request_id = transport.frames_for(REQUEST_EVENT)[0]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        bridge.resolve(WasmRendererResponse {
            request_id,
            plugin_id: "p".into(),
            result: Some(json!({ "text": "y".repeat(MAX_BODY_BYTES + 1) })),
            error: None,
        });

        let err = handle.await.unwrap().unwrap_err();
        assert_eq!(err.code, WasmErrorCode::PayloadTooLarge);
    }

    #[tokio::test]
    async fn renderer_error_code_is_validated() {
        let (bridge, transport) = bridge();
        let b = bridge.clone();
        let handle = tokio::spawn(async move {
            b.dispatch(
                "p",
                WasmBridgeOperation::AiGenerateText,
                json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;

        let request_id = transport.frames_for(REQUEST_EVENT)[0]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        bridge.resolve(WasmRendererResponse {
            request_id,
            plugin_id: "p".into(),
            result: None,
            error: Some(WasmRendererErrorBody {
                code: "HACK".into(),
                message: "forged".into(),
            }),
        });

        let err = handle.await.unwrap().unwrap_err();
        assert_eq!(err.code, WasmErrorCode::ProviderError);
    }

    #[tokio::test]
    async fn renderer_may_report_a_known_code() {
        let (bridge, transport) = bridge();
        let b = bridge.clone();
        let handle = tokio::spawn(async move {
            b.dispatch(
                "p",
                WasmBridgeOperation::WorkflowEmitEvent,
                json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;

        let request_id = transport.frames_for(REQUEST_EVENT)[0]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        bridge.resolve(WasmRendererResponse {
            request_id,
            plugin_id: "p".into(),
            result: None,
            error: Some(WasmRendererErrorBody {
                code: "WORKFLOW_REJECTED".into(),
                message: "not-registered".into(),
            }),
        });

        let err = handle.await.unwrap().unwrap_err();
        assert_eq!(err.code, WasmErrorCode::WorkflowRejected);
        assert!(err.message.contains("not-registered"));
    }

    #[tokio::test]
    async fn response_with_neither_result_nor_error_is_a_provider_error() {
        let (bridge, transport) = bridge();
        let b = bridge.clone();
        let handle = tokio::spawn(async move {
            b.dispatch(
                "p",
                WasmBridgeOperation::AiGenerateText,
                json!({}),
                Duration::from_secs(5),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;

        let request_id = transport.frames_for(REQUEST_EVENT)[0]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        bridge.resolve(WasmRendererResponse {
            request_id,
            plugin_id: "p".into(),
            result: None,
            error: None,
        });

        let err = handle.await.unwrap().unwrap_err();
        assert_eq!(err.code, WasmErrorCode::ProviderError);
        assert!(err.message.contains("neither result nor error"));
    }

    #[test]
    fn diagnostic_fields_are_a_closed_allowlist() {
        // The payload-leak guard. A field added to BridgeDiagnostic without
        // updating ALLOWED_KEYS fails here, and no rendered value may ever
        // contain guest content.
        let diag = BridgeDiagnostic {
            plugin_id: "p",
            operation: "ai.generate-text",
            outcome: "resolved",
            request_bytes: 1234,
            response_bytes: 42,
            duration_ms: 7,
            error_code: None,
            transport: "recording",
        };
        let fields = diag.fields();
        let keys: Vec<&str> = fields.iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, BridgeDiagnostic::ALLOWED_KEYS);

        let rendered = fields
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!rendered.contains("TOPSECRET"));
        assert!(rendered.contains("request_bytes=1234"));
    }

    #[test]
    fn diagnostics_never_render_guest_payload_content() {
        // Build a diagnostic from a request whose payload carries a marker and
        // assert the marker cannot appear: the type has no payload field at all.
        let payload = json!({ "prompt": "TOPSECRET launch codes" });
        let request_bytes = serde_json::to_vec(&payload).unwrap().len();
        let diag = BridgeDiagnostic {
            plugin_id: "p",
            operation: "ai.generate-text",
            outcome: "dispatched",
            request_bytes,
            response_bytes: 0,
            duration_ms: 0,
            error_code: None,
            transport: "recording",
        };
        let rendered = diag
            .fields()
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!rendered.contains("TOPSECRET"));
        assert!(!rendered.contains("prompt"));
    }

    #[test]
    fn cancel_reason_maps_to_the_right_guest_code() {
        assert_eq!(CancelReason::Timeout.error_code(), WasmErrorCode::Timeout);
        assert_eq!(CancelReason::Caller.error_code(), WasmErrorCode::Cancelled);
        assert_eq!(
            CancelReason::Deactivate.error_code(),
            WasmErrorCode::Cancelled
        );
        assert_eq!(CancelReason::Unload.error_code(), WasmErrorCode::Cancelled);
    }

    #[test]
    fn operation_strings_match_the_wit_contract() {
        assert_eq!(
            WasmBridgeOperation::AiGenerateText.as_str(),
            "ai.generate-text"
        );
        assert_eq!(
            WasmBridgeOperation::WorkflowEmitEvent.as_str(),
            "workflow.emit-event"
        );
    }
}
