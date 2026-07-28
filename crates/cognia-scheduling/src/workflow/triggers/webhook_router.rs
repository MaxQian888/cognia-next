//! Workflow webhook receiver — local HTTP server that turns inbound requests
//! into `workflow:trigger` events for the orchestrator to dispatch.
//!
//! The router binds to `127.0.0.1` so the receiver is reachable from `curl`,
//! native HTTP libraries, and SaaS webhook senders bridged through tunnels
//! (ngrok / cloudflared) but never directly from the public internet without
//! the user's explicit relay configuration.
//!
//! Lifecycle:
//!   * On app boot, `start` launches the listener on a random port (or a
//!     port supplied by `AppSettings.workflowWebhookPort`). The bound port
//!     is exposed back to TS via `workflow_get_webhook_url` so the inspector
//!     form can show the user a copy-pastable URL.
//!   * Every workflow with a `trigger.webhook` registers a path through
//!     `register`. Paths are unique within the process; a second register
//!     with the same trigger id is treated as an update.
//!   * On match, the handler builds a `WebhookTriggerPayload`, emits the
//!     `workflow:trigger` event, and returns the configured response (or a
//!     204 No Content fallback).
//!
//! Phase 5a ships the router and the synchronous response path. The
//! "hold the response open until io.webhook.respond runs" path piggybacks
//! on this scaffolding once the orchestrator gains a reverse-channel hook
//! (planned for the next slice).

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::IntoResponse,
    routing::any,
    Router,
};
use base64::Engine as _;
use chrono::DateTime;
use cognia_secrets::keyring_secrets;
use hmac::{Hmac, KeyInit, Mac};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::sync::oneshot;
use tower_http::limit::RequestBodyLimitLayer;

use super::cron_daemon::TriggerEmitter;
use crate::workflow::integration_spool::{
    EnqueueOutcome, IntegrationSpool, SpoolDelivery, SpoolError,
};
use crate::workflow::types::{TriggerBinding, TriggerEvent, WebhookTriggerPayload};

/// Fallback hold time for `await_response` webhooks when the entry doesn't
/// specify one. Kept under the ~30 s most SaaS senders allow before they give
/// up, so a workflow that never calls `io.webhook.respond` still returns the
/// static fallback before the caller times out.
const DEFAULT_RESPONSE_TIMEOUT_MS: u64 = 25_000;

/// A dynamic response supplied by an `io.webhook.respond` node, delivered back
/// to a held-open inbound request via [`WebhookRouter::respond`].
#[derive(Debug, Clone)]
pub struct DynamicResponse {
    pub status: u16,
    pub body: String,
    pub headers: BTreeMap<String, String>,
}

/// In-flight `await_response` requests, keyed by correlation id. Each entry is
/// a oneshot the axum handler is blocked on; `io.webhook.respond` (via the
/// `workflow_webhook_respond` command) resolves it, or the handler's timeout
/// removes it and falls back to the static response.
#[derive(Default)]
struct PendingResponses {
    map: RwLock<HashMap<String, oneshot::Sender<DynamicResponse>>>,
    counter: AtomicU64,
}

impl PendingResponses {
    /// Allocate a correlation id and register a waiter. Returns the id (handed
    /// to the workflow via the trigger payload) and the receiver to await.
    fn register(&self) -> (String, oneshot::Receiver<DynamicResponse>) {
        let id = format!("whr_{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.map.write().insert(id.clone(), tx);
        (id, rx)
    }

    /// Resolve a waiting request. Returns true when a waiter was still pending.
    fn resolve(&self, id: &str, response: DynamicResponse) -> bool {
        match self.map.write().remove(id) {
            Some(tx) => tx.send(response).is_ok(),
            None => false,
        }
    }

    /// Drop a waiter without resolving it (timeout / handler giving up).
    fn cancel(&self, id: &str) {
        self.map.write().remove(id);
    }
}

/// 1 MiB request-body cap. SaaS senders (GitHub, Slack, Stripe) cap their
/// outbound payloads well under this; anything larger is almost certainly
/// abuse. The companion server uses a stricter 64 KiB limit because its
/// endpoints are tiny RPC calls — webhooks legitimately carry a JSON body.
const WEBHOOK_BODY_LIMIT_BYTES: usize = 1024 * 1024;
const INGRESS_SECRET_NAMESPACE: &str = "integration-ingress";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "source")]
pub enum SignedPayloadPart {
    Body,
    Header { name: String },
    Literal { value: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum IntegrationVerification {
    #[serde(rename = "hmac-sha256")]
    HmacSha256 {
        signature_header: String,
        encoding: String,
        prefix: Option<String>,
        signed_payload: Option<Vec<SignedPayloadPart>>,
        timestamp_header: Option<String>,
        max_skew_seconds: Option<i64>,
        secret_handle: String,
    },
    #[serde(rename = "static-token")]
    StaticToken {
        token_header: String,
        secret_handle: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationIngressEntry {
    pub route_id: String,
    pub plugin_id: String,
    pub integration_id: String,
    pub account_id: String,
    pub subscription_id: Option<String>,
    pub path: String,
    pub verification: IntegrationVerification,
    pub delivery_id_header: Option<String>,
    pub event_type_header: Option<String>,
    pub enabled: bool,
}

/// Header for cognia-style triggers (`sha256=<hex>` of body).
const HMAC_SIGNATURE_HEADER_COGNIA: &str = "x-signature-256";

/// Signature convention for host-owned legacy webhook triggers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureMode {
    /// Cognia's own convention — `x-signature-256: sha256=<hex>`.
    Cognia,
}

impl Default for SignatureMode {
    fn default() -> Self {
        Self::Cognia
    }
}

impl SignatureMode {
    pub fn header_name(&self) -> &'static str {
        HMAC_SIGNATURE_HEADER_COGNIA
    }
}

/// One registered webhook trigger.
#[derive(Debug, Clone)]
pub struct WebhookEntry {
    pub trigger_id: String,
    pub workflow_id: String,
    /// Original trigger kind dispatched after HMAC verification.
    pub kind: String,
    /// Path segment after `/webhook/` — e.g., `incoming-events`. Lowercase,
    /// no leading slash. Must be unique across the registry.
    pub path: String,
    /// Allowed HTTP method, or `*` for any. Case-insensitive on input.
    pub method: String,
    /// Optional HMAC secret. When present, the receiver verifies the
    /// signature header (per `signature_mode`) is the HMAC-SHA-256 of the
    /// raw body, keyed by `secret`.
    pub hmac_secret: Option<String>,
    /// Which signature header convention to read from. Defaults to Cognia.
    pub signature_mode: SignatureMode,
    pub enabled: bool,
    pub binding: Option<TriggerBinding>,
    /// HTTP status to respond with (default 200).
    pub response_status: u16,
    /// Optional response body template; the workflow's terminal output is
    /// substituted when present. Returned verbatim when the workflow has no
    /// `io.webhook.respond` node, or as the fallback when the dynamic response
    /// times out.
    pub response_body: Option<String>,
    /// When true, the handler holds the inbound request open and waits for an
    /// `io.webhook.respond` node to supply a dynamic response (set by the TS
    /// bridge when the workflow contains such a node). Falls back to the
    /// static `response_status` / `response_body` on timeout.
    pub await_response: bool,
    /// How long to hold the request before falling back. 0 = use the default.
    pub response_timeout_ms: u64,
}

/// Public router handle. Held inside `WorkflowState`; cloneable so the axum
/// handler can share the registry with the registration commands.
#[derive(Clone)]
pub struct WebhookRouter {
    inner: Arc<RouterInner>,
}

struct RouterInner {
    /// Map keyed by lowercase path. Multiple entries per path are not allowed.
    /// Wrapped in `Arc` so the axum handler can share the registry without
    /// going through `Arc<RouterInner>`.
    entries: Arc<RwLock<BTreeMap<String, WebhookEntry>>>,
    integration_entries: Arc<RwLock<BTreeMap<String, IntegrationIngressEntry>>>,
    integration_spool: Arc<IntegrationSpool>,
    /// Held-open `await_response` requests. Shared with the axum handler.
    pending: Arc<PendingResponses>,
    /// Bound socket address; populated once `start` succeeds.
    bound: RwLock<Option<SocketAddr>>,
    /// Shutdown signal — when triggered, the axum server graceful-stops.
    shutdown_tx: RwLock<Option<oneshot::Sender<()>>>,
}

#[derive(Debug, Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
}

impl WebhookRouter {
    pub fn new() -> Self {
        Self::with_integration_spool(Arc::new(IntegrationSpool::open_in_memory()))
    }

    pub fn with_integration_spool(integration_spool: Arc<IntegrationSpool>) -> Self {
        Self {
            inner: Arc::new(RouterInner {
                entries: Arc::new(RwLock::new(BTreeMap::new())),
                integration_entries: Arc::new(RwLock::new(BTreeMap::new())),
                integration_spool,
                pending: Arc::new(PendingResponses::default()),
                bound: RwLock::new(None),
                shutdown_tx: RwLock::new(None),
            }),
        }
    }

    /// Deliver a dynamic response to a held-open `await_response` request.
    /// Returns true when a request was still waiting on `correlation_id`
    /// (false if it already timed out or the id is unknown). Called from the
    /// `workflow_webhook_respond` command when an `io.webhook.respond` node runs.
    pub fn respond(&self, correlation_id: &str, response: DynamicResponse) -> bool {
        self.inner.pending.resolve(correlation_id, response)
    }

    /// Register or update a webhook trigger. Returns the user-facing URL (or
    /// `None` if the router hasn't bound yet).
    pub fn upsert(&self, entry: WebhookEntry) -> Result<Option<String>, String> {
        let path = normalize_path(&entry.path);
        if path.is_empty() {
            return Err("webhook path cannot be empty".into());
        }
        let mut entries = self.inner.entries.write();
        // If another entry uses this path, update only when the full workflow
        // + node identity matches; otherwise reject so copied node ids cannot
        // shadow another workflow.
        if let Some(existing) = entries.get(&path) {
            if existing.trigger_id != entry.trigger_id || existing.workflow_id != entry.workflow_id
            {
                return Err(format!(
                    "webhook path '{path}' is already registered by trigger {}",
                    existing.trigger_id
                ));
            }
        }
        let mut entry = entry;
        entry.path = path.clone();
        entries.insert(path.clone(), entry);
        Ok(self.bound_url_for_path(&path))
    }

    /// Remove a trigger by id. Idempotent; missing ids return Ok(()).
    pub fn unregister(&self, workflow_id: &str, trigger_id: &str) {
        let mut entries = self.inner.entries.write();
        let path = entries
            .iter()
            .find(|(_, e)| e.workflow_id == workflow_id && e.trigger_id == trigger_id)
            .map(|(p, _)| p.clone());
        if let Some(p) = path {
            entries.remove(&p);
        }
    }

    /// Look up the URL for an already-registered trigger.
    pub fn url_for_trigger(&self, workflow_id: &str, trigger_id: &str) -> Option<String> {
        let entries = self.inner.entries.read();
        let path = entries
            .iter()
            .find(|(_, e)| e.workflow_id == workflow_id && e.trigger_id == trigger_id)
            .map(|(p, _)| p.clone())?;
        self.bound_url_for_path(&path)
    }

    pub fn upsert_integration(
        &self,
        mut entry: IntegrationIngressEntry,
    ) -> Result<Option<String>, String> {
        let path = normalize_path(&entry.path);
        if path.is_empty() {
            return Err("integration ingress path cannot be empty".into());
        }
        let mut entries = self.inner.integration_entries.write();
        if let Some(existing) = entries.get(&path) {
            if existing.route_id != entry.route_id {
                return Err(format!(
                    "integration ingress path '{path}' is already registered"
                ));
            }
        }
        entry.path = path.clone();
        entries.insert(path.clone(), entry);
        Ok(self.bound_integration_url_for_path(&path))
    }

    pub fn unregister_integration(&self, route_id: &str) {
        self.inner
            .integration_entries
            .write()
            .retain(|_, entry| entry.route_id != route_id);
    }

    pub fn integration_url(&self, route_id: &str) -> Option<String> {
        let entries = self.inner.integration_entries.read();
        let path = entries
            .iter()
            .find(|(_, entry)| entry.route_id == route_id)
            .map(|(path, _)| path.clone())?;
        self.bound_integration_url_for_path(&path)
    }

    fn bound_url_for_path(&self, path: &str) -> Option<String> {
        let bound = self.inner.bound.read();
        bound.map(|addr| format!("http://{addr}/webhook/{path}"))
    }

    fn bound_integration_url_for_path(&self, path: &str) -> Option<String> {
        let bound = self.inner.bound.read();
        bound.map(|addr| format!("http://{addr}/integration/{path}"))
    }

    /// Number of registered entries (test helper).
    #[cfg(test)]
    pub fn entry_count(&self) -> usize {
        self.inner.entries.read().len()
    }

    /// Spawn the axum listener. The router binds to `127.0.0.1:port`; pass
    /// `port = 0` to let the OS pick.
    pub async fn start<E: TriggerEmitter + 'static>(
        &self,
        emitter: Arc<E>,
        port: u16,
    ) -> Result<SocketAddr, String> {
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
            .await
            .map_err(|e| format!("workflow webhook bind failed: {e}"))?;
        let bound = listener
            .local_addr()
            .map_err(|e| format!("workflow webhook addr failed: {e}"))?;
        *self.inner.bound.write() = Some(bound);

        let app_state = WebhookAppState {
            entries: self.inner.entries.clone(),
            integration_entries: self.inner.integration_entries.clone(),
            integration_spool: self.inner.integration_spool.clone(),
            pending: self.inner.pending.clone(),
            emitter: emitter as Arc<dyn TriggerEmitter>,
        };
        let app = Router::new()
            .route("/webhook/{*path}", any(handle_webhook))
            .route("/webhook/", any(missing_path))
            .route("/integration/{*path}", any(handle_integration_ingress))
            .with_state(Arc::new(app_state))
            // Reject oversize bodies before the handler reads them. Without
            // this layer axum buffers the entire body in memory — a single
            // multi-MB POST per registered path would be enough to grief
            // the desktop process. See module-level constant for the cap.
            .layer(RequestBodyLimitLayer::new(WEBHOOK_BODY_LIMIT_BYTES));

        let (tx, rx) = oneshot::channel::<()>();
        *self.inner.shutdown_tx.write() = Some(tx);

        let bound_for_log = bound;
        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                })
                .await
            {
                log::warn!("workflow webhook router exited: {err}");
            } else {
                log::info!("workflow webhook router stopped (was at {bound_for_log})");
            }
        });
        Ok(bound)
    }

    /// Trigger graceful shutdown. Idempotent.
    pub fn stop(&self) {
        if let Some(tx) = self.inner.shutdown_tx.write().take() {
            let _ = tx.send(());
        }
    }
}

impl Default for WebhookRouter {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
struct WebhookAppState {
    entries: Arc<RwLock<BTreeMap<String, WebhookEntry>>>,
    integration_entries: Arc<RwLock<BTreeMap<String, IntegrationIngressEntry>>>,
    integration_spool: Arc<IntegrationSpool>,
    pending: Arc<PendingResponses>,
    emitter: Arc<dyn TriggerEmitter>,
}

/// Strip leading `/`, lowercase, collapse multiple slashes.
fn normalize_path(path: &str) -> String {
    path.trim_start_matches('/')
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

async fn missing_path() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        axum::Json(ErrorBody {
            error: "webhook path required",
        }),
    )
}

async fn handle_integration_ingress(
    State(state): State<Arc<WebhookAppState>>,
    Path(path): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let normalized = normalize_path(&path);
    let entry = state.integration_entries.read().get(&normalized).cloned();
    let Some(entry) = entry else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(ErrorBody {
                error: "no integration ingress registered for this path",
            }),
        )
            .into_response();
    };
    if !entry.enabled {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(ErrorBody {
                error: "integration ingress is disabled",
            }),
        )
            .into_response();
    }
    if !verify_integration_request(&entry.verification, &body, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(ErrorBody {
                error: "signature verification failed",
            }),
        )
            .into_response();
    }

    let header_map: BTreeMap<String, String> = headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let delivery_id = entry
        .delivery_id_header
        .as_deref()
        .and_then(|name| header_value(&headers, name))
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let event_type = entry
        .event_type_header
        .as_deref()
        .and_then(|name| header_value(&headers, name))
        .map(str::to_owned);
    let delivery = SpoolDelivery {
        route_id: entry.route_id.clone(),
        delivery_id: delivery_id.clone(),
        event_type,
        headers: header_map,
        body: String::from_utf8_lossy(&body).into_owned(),
        received_at: chrono::Utc::now().to_rfc3339(),
        attempts: 0,
    };
    match state.integration_spool.enqueue(&delivery) {
        Ok(EnqueueOutcome::Inserted) => {
            state
                .emitter
                .emit_integration_delivery_available(&entry.route_id, &delivery_id);
            StatusCode::ACCEPTED.into_response()
        }
        Ok(EnqueueOutcome::Duplicate) => StatusCode::OK.into_response(),
        Err(SpoolError::Full) => (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(ErrorBody {
                error: "integration ingress queue is full",
            }),
        )
            .into_response(),
        Err(error) => {
            log::warn!("integration ingress spool write failed: {error}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(ErrorBody {
                    error: "integration ingress is unavailable",
                }),
            )
                .into_response()
        }
    }
}

fn verify_integration_request(
    verification: &IntegrationVerification,
    body: &Bytes,
    headers: &HeaderMap,
) -> bool {
    match verification {
        IntegrationVerification::StaticToken {
            token_header,
            secret_handle,
        } => {
            let Some(provided) = header_value(headers, token_header) else {
                return false;
            };
            let Ok(Some(expected)) = keyring_secrets::get(INGRESS_SECRET_NAMESPACE, secret_handle)
            else {
                return false;
            };
            constant_time_equal(expected.as_bytes(), provided.as_bytes())
        }
        IntegrationVerification::HmacSha256 {
            signature_header,
            encoding,
            prefix,
            signed_payload,
            timestamp_header,
            max_skew_seconds,
            secret_handle,
        } => {
            let Some(raw_signature) = header_value(headers, signature_header) else {
                return false;
            };
            let signature = match prefix {
                Some(prefix) => match raw_signature.strip_prefix(prefix) {
                    Some(value) => value,
                    None => return false,
                },
                None => raw_signature,
            };
            let provided = if encoding.eq_ignore_ascii_case("base64") {
                match base64::engine::general_purpose::STANDARD.decode(signature) {
                    Ok(value) => value,
                    Err(_) => return false,
                }
            } else {
                match decode_hex(signature) {
                    Ok(value) => value,
                    Err(_) => return false,
                }
            };
            if let Some(timestamp_header) = timestamp_header {
                let Some(timestamp) = header_value(headers, timestamp_header) else {
                    return false;
                };
                if !timestamp_within_skew(timestamp, max_skew_seconds.unwrap_or(300)) {
                    return false;
                }
            }
            let Ok(Some(secret)) = keyring_secrets::get(INGRESS_SECRET_NAMESPACE, secret_handle)
            else {
                return false;
            };
            let parts = signed_payload
                .as_deref()
                .unwrap_or(&[SignedPayloadPart::Body]);
            let mut signed = Vec::new();
            for part in parts {
                match part {
                    SignedPayloadPart::Body => signed.extend_from_slice(body),
                    SignedPayloadPart::Header { name } => {
                        let Some(value) = header_value(headers, name) else {
                            return false;
                        };
                        signed.extend_from_slice(value.as_bytes());
                    }
                    SignedPayloadPart::Literal { value } => {
                        signed.extend_from_slice(value.as_bytes())
                    }
                }
            }
            let mut mac = match <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()) {
                Ok(mac) => mac,
                Err(_) => return false,
            };
            mac.update(&signed);
            mac.verify_slice(&provided).is_ok()
        }
    }
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn timestamp_within_skew(value: &str, max_skew_seconds: i64) -> bool {
    let timestamp = value
        .parse::<i64>()
        .ok()
        .map(|seconds| seconds.saturating_mul(1_000))
        .or_else(|| {
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|value| value.timestamp_millis())
        });
    let Some(timestamp) = timestamp else {
        return false;
    };
    (chrono::Utc::now().timestamp_millis() - timestamp).abs()
        <= max_skew_seconds.max(0).saturating_mul(1_000)
}

fn constant_time_equal(expected: &[u8], provided: &[u8]) -> bool {
    let mut expected_mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(b"cognia-integration-token-compare")
            .expect("fixed HMAC key");
    expected_mac.update(expected);
    let expected_digest = expected_mac.finalize().into_bytes();
    let mut provided_mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(b"cognia-integration-token-compare")
            .expect("fixed HMAC key");
    provided_mac.update(provided);
    provided_mac.verify_slice(&expected_digest).is_ok()
}

async fn handle_webhook(
    State(state): State<Arc<WebhookAppState>>,
    Path(path): Path<String>,
    Query(query): Query<BTreeMap<String, String>>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let normalized = normalize_path(&path);
    let entry_opt = state.entries.read().get(&normalized).cloned();
    let Some(entry) = entry_opt else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(ErrorBody {
                error: "no workflow registered for this path",
            }),
        )
            .into_response();
    };
    if !entry.enabled {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(ErrorBody {
                error: "trigger is disabled",
            }),
        )
            .into_response();
    }
    if !method_allowed(&entry.method, &method) {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            axum::Json(ErrorBody {
                error: "method not allowed",
            }),
        )
            .into_response();
    }

    // HMAC verification. When the trigger has a secret configured, every
    // request must carry an `X-Signature-256: sha256=<hex>` header whose
    // MAC matches the SHA-256 HMAC of the raw body. Any mismatch (missing
    // header, malformed prefix, hex-decode failure, MAC mismatch) yields
    // 401 — never leak which check failed.
    if let Some(secret) = entry.hmac_secret.as_deref() {
        if !verify_hmac_signature(secret, &body, &headers, entry.signature_mode) {
            return (
                StatusCode::UNAUTHORIZED,
                axum::Json(ErrorBody {
                    error: "signature verification failed",
                }),
            )
                .into_response();
        }
    }

    // Best-effort JSON parsing — fall back to a raw string body.
    let (body_value, body_was_json) = match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => (v, true),
        Err(_) => (
            serde_json::Value::String(String::from_utf8_lossy(&body).to_string()),
            false,
        ),
    };

    let header_map: BTreeMap<String, String> = headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|v| (name.as_str().to_string(), v.to_string()))
        })
        .collect();

    let mut payload = WebhookTriggerPayload {
        method: method.as_str().to_string(),
        path: normalized,
        headers: header_map,
        query,
        body: body_value,
        body_was_json,
        correlation_id: None,
    };

    // When the workflow has an `io.webhook.respond` node the TS bridge sets
    // `await_response`. Register a correlation id + waiter BEFORE emitting so
    // the workflow's respond node can resolve us by the time it runs, and
    // surface the id to the workflow via the trigger payload.
    let pending_rx = if entry.await_response {
        let (correlation_id, rx) = state.pending.register();
        payload.correlation_id = Some(correlation_id);
        Some(rx)
    } else {
        None
    };

    let payload_value = match serde_json::to_value(&payload) {
        Ok(v) => v,
        Err(err) => {
            log::warn!("workflow webhook payload serialize failed: {err}");
            if let Some(cid) = payload.correlation_id.as_deref() {
                state.pending.cancel(cid);
            }
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(ErrorBody {
                    error: "payload serialization failed",
                }),
            )
                .into_response();
        }
    };

    let event = TriggerEvent {
        workflow_id: entry.workflow_id.clone(),
        kind: entry.kind.clone(),
        trigger_id: Some(entry.trigger_id.clone()),
        payload: payload_value,
        origin_at: chrono::Utc::now().timestamp_millis(),
        binding: entry.binding.clone(),
    };
    state.emitter.emit(event);

    // Hold the request open until `io.webhook.respond` resolves us or the
    // timeout elapses. On timeout we drop the waiter and fall through to the
    // static response so the caller never hangs indefinitely.
    if let Some(rx) = pending_rx {
        let timeout_ms = if entry.response_timeout_ms == 0 {
            DEFAULT_RESPONSE_TIMEOUT_MS
        } else {
            entry.response_timeout_ms
        };
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(resp)) => return dynamic_response(resp),
            _ => {
                if let Some(cid) = payload.correlation_id.as_deref() {
                    state.pending.cancel(cid);
                }
                // fall through to the static fallback below
            }
        }
    }

    let status = StatusCode::from_u16(entry.response_status).unwrap_or(StatusCode::OK);
    let body = entry.response_body.unwrap_or_default();
    (status, body).into_response()
}

/// Build an axum response from a workflow-supplied [`DynamicResponse`].
/// Invalid header names / values are skipped rather than failing the response.
fn dynamic_response(resp: DynamicResponse) -> axum::response::Response {
    let status = StatusCode::from_u16(resp.status).unwrap_or(StatusCode::OK);
    let mut headers = HeaderMap::new();
    for (name, value) in &resp.headers {
        if let (Ok(n), Ok(v)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            headers.insert(n, v);
        }
    }
    (status, headers, resp.body).into_response()
}

fn method_allowed(allowed: &str, actual: &Method) -> bool {
    let allowed_upper = allowed.to_ascii_uppercase();
    if allowed_upper == "*" || allowed_upper.is_empty() {
        return true;
    }
    allowed_upper == actual.as_str()
}

/// HMAC-SHA-256 of `body` keyed with `secret`, compared in constant time
/// against the `sha256=<hex>` value of the signature header chosen by `mode`.
/// Header lookup is case-insensitive (axum normalises to lowercase). Returns
/// `false` for any failure mode without leaking which one.
fn verify_hmac_signature(
    secret: &str,
    body: &Bytes,
    headers: &HeaderMap,
    mode: SignatureMode,
) -> bool {
    let Some(raw) = headers.get(mode.header_name()) else {
        return false;
    };
    let Ok(value) = raw.to_str() else {
        return false;
    };
    let Some(hex_part) = value.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(provided) = decode_hex(hex_part) else {
        return false;
    };
    let mut mac = match <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(body);
    mac.verify_slice(&provided).is_ok()
}

fn decode_hex(input: &str) -> Result<Vec<u8>, ()> {
    if input.len() % 2 != 0 {
        return Err(());
    }
    let mut out = Vec::with_capacity(input.len() / 2);
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_nibble(bytes[i])?;
        let lo = hex_nibble(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn hex_nibble(b: u8) -> Result<u8, ()> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::triggers::cron_daemon::RecordingEmitter;
    use std::error::Error as _;

    fn entry(path: &str) -> WebhookEntry {
        WebhookEntry {
            trigger_id: format!("trg_{path}"),
            workflow_id: format!("wf_{path}"),
            kind: "trigger.webhook".into(),
            path: path.into(),
            method: "POST".into(),
            hmac_secret: None,
            signature_mode: SignatureMode::Cognia,
            enabled: true,
            binding: None,
            response_status: 200,
            response_body: None,
            await_response: false,
            response_timeout_ms: 0,
        }
    }

    #[test]
    fn upsert_new_path_is_accepted() {
        let r = WebhookRouter::new();
        r.upsert(entry("foo")).unwrap();
        assert_eq!(r.entry_count(), 1);
    }

    #[test]
    fn upsert_same_trigger_id_replaces_entry() {
        let r = WebhookRouter::new();
        let mut e = entry("foo");
        r.upsert(e.clone()).unwrap();
        e.method = "GET".into();
        r.upsert(e).unwrap();
        assert_eq!(r.entry_count(), 1);
    }

    #[test]
    fn upsert_collision_is_rejected() {
        let r = WebhookRouter::new();
        let mut a = entry("foo");
        a.trigger_id = "trg_a".into();
        let mut b = entry("foo");
        b.trigger_id = "trg_b".into();
        r.upsert(a).unwrap();
        let err = r.upsert(b).unwrap_err();
        assert!(err.contains("already registered"));
    }

    #[test]
    fn unregister_is_idempotent() {
        let r = WebhookRouter::new();
        r.upsert(entry("foo")).unwrap();
        r.unregister("wf_foo", "trg_foo");
        r.unregister("wf_foo", "trg_foo"); // second call is a no-op
        assert_eq!(r.entry_count(), 0);
    }

    #[test]
    fn copied_trigger_id_cannot_replace_or_unregister_another_workflow() {
        let r = WebhookRouter::new();
        let source = entry("source");
        let mut copy = entry("source");
        copy.workflow_id = "wf_copy".into();
        r.upsert(source).unwrap();

        assert!(r.upsert(copy).unwrap_err().contains("already registered"));
        r.unregister("wf_copy", "trg_source");
        assert_eq!(r.entry_count(), 1);
        assert_eq!(
            r.inner
                .entries
                .read()
                .get("source")
                .map(|entry| entry.workflow_id.as_str()),
            Some("wf_source")
        );
    }

    #[test]
    fn empty_path_is_rejected() {
        let r = WebhookRouter::new();
        let mut e = entry("");
        e.trigger_id = "trg_empty".into();
        let err = r.upsert(e).unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn method_allowed_handles_wildcard_and_specific() {
        assert!(method_allowed("*", &Method::POST));
        assert!(method_allowed("post", &Method::POST));
        assert!(!method_allowed("GET", &Method::POST));
        assert!(method_allowed("", &Method::DELETE));
    }

    #[test]
    fn normalize_path_strips_slashes_and_lowercases() {
        assert_eq!(normalize_path("/Foo/"), "foo");
        assert_eq!(normalize_path("Bar"), "bar");
        assert_eq!(normalize_path("/A/B"), "a/b");
    }

    #[tokio::test]
    async fn end_to_end_post_emits_a_trigger_event() {
        let router = WebhookRouter::new();
        router.upsert(entry("hello")).unwrap();
        let recorder = Arc::new(RecordingEmitter::default());
        let bound = router.start(recorder.clone(), 0).await.unwrap();

        let url = format!("http://{bound}/webhook/hello");
        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(r#"{"hello":"world"}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);

        // Give the emitter a moment to record (axum spawns the handler).
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let events = recorder.fired.lock().clone();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "trigger.webhook");
        assert_eq!(events[0].workflow_id, "wf_hello");

        router.stop();
    }

    #[tokio::test]
    async fn await_response_holds_until_respond_supplies_a_dynamic_body() {
        let router = WebhookRouter::new();
        let mut e = entry("dyn");
        e.await_response = true;
        e.response_timeout_ms = 5_000;
        router.upsert(e).unwrap();
        let recorder = Arc::new(RecordingEmitter::default());
        let bound = router.start(recorder.clone(), 0).await.unwrap();

        let url = format!("http://{bound}/webhook/dyn");
        // The POST blocks until we respond; drive it on a separate task.
        let post = tokio::spawn(async move {
            reqwest::Client::new()
                .post(&url)
                .body("{}")
                .send()
                .await
                .unwrap()
        });

        // Wait for the trigger to fire, then read the correlation id the
        // handler injected into the payload.
        let mut correlation_id = None;
        for _ in 0..200 {
            if let Some(ev) = recorder.fired.lock().first() {
                if let Some(c) = ev.payload.get("correlationId").and_then(|v| v.as_str()) {
                    correlation_id = Some(c.to_string());
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let correlation_id = correlation_id.expect("correlation id surfaced in payload");

        let mut headers = BTreeMap::new();
        headers.insert("x-custom".to_string(), "yes".to_string());
        assert!(router.respond(
            &correlation_id,
            DynamicResponse {
                status: 201,
                body: r#"{"ok":true}"#.to_string(),
                headers,
            },
        ));

        let resp = post.await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::CREATED);
        assert_eq!(resp.headers().get("x-custom").unwrap(), "yes");
        assert_eq!(resp.text().await.unwrap(), r#"{"ok":true}"#);
        router.stop();
    }

    #[tokio::test]
    async fn await_response_falls_back_to_static_on_timeout() {
        let router = WebhookRouter::new();
        let mut e = entry("slow");
        e.await_response = true;
        e.response_timeout_ms = 50; // fall back almost immediately
        e.response_status = 202;
        e.response_body = Some("queued".into());
        router.upsert(e).unwrap();
        let recorder = Arc::new(RecordingEmitter::default());
        let bound = router.start(recorder, 0).await.unwrap();

        let resp = reqwest::Client::new()
            .post(format!("http://{bound}/webhook/slow"))
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::ACCEPTED);
        assert_eq!(resp.text().await.unwrap(), "queued");
        router.stop();
    }

    #[test]
    fn respond_to_unknown_correlation_returns_false() {
        let r = WebhookRouter::new();
        assert!(!r.respond(
            "whr_nope",
            DynamicResponse {
                status: 200,
                body: String::new(),
                headers: BTreeMap::new()
            },
        ));
    }

    #[tokio::test]
    async fn unknown_path_returns_404() {
        let router = WebhookRouter::new();
        let recorder = Arc::new(RecordingEmitter::default());
        let bound = router.start(recorder, 0).await.unwrap();
        let resp = reqwest::Client::new()
            .post(format!("http://{bound}/webhook/missing"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::NOT_FOUND);
        router.stop();
    }

    #[test]
    fn verify_hmac_signature_accepts_correct_mac() {
        use axum::http::HeaderValue;
        let secret = "shh";
        let body = Bytes::from_static(b"{\"hello\":\"world\"}");
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(&body);
        let hex: String = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let mut headers = HeaderMap::new();
        headers.insert(
            HMAC_SIGNATURE_HEADER_COGNIA,
            HeaderValue::from_str(&format!("sha256={hex}")).unwrap(),
        );
        assert!(verify_hmac_signature(
            secret,
            &body,
            &headers,
            SignatureMode::Cognia
        ));
    }

    #[test]
    fn verify_hmac_signature_rejects_missing_header() {
        let body = Bytes::from_static(b"x");
        let headers = HeaderMap::new();
        assert!(!verify_hmac_signature(
            "k",
            &body,
            &headers,
            SignatureMode::Cognia
        ));
    }

    #[test]
    fn verify_hmac_signature_rejects_wrong_prefix() {
        use axum::http::HeaderValue;
        let mut headers = HeaderMap::new();
        headers.insert(
            HMAC_SIGNATURE_HEADER_COGNIA,
            HeaderValue::from_static("md5=abcd"),
        );
        assert!(!verify_hmac_signature(
            "k",
            &Bytes::from_static(b"x"),
            &headers,
            SignatureMode::Cognia
        ));
    }

    #[test]
    fn verify_hmac_signature_rejects_bad_hex() {
        use axum::http::HeaderValue;
        let mut headers = HeaderMap::new();
        headers.insert(
            HMAC_SIGNATURE_HEADER_COGNIA,
            HeaderValue::from_static("sha256=zzz"),
        );
        assert!(!verify_hmac_signature(
            "k",
            &Bytes::from_static(b"x"),
            &headers,
            SignatureMode::Cognia
        ));
    }

    #[test]
    fn verify_hmac_signature_rejects_wrong_mac() {
        use axum::http::HeaderValue;
        let mut headers = HeaderMap::new();
        headers.insert(
            HMAC_SIGNATURE_HEADER_COGNIA,
            HeaderValue::from_static(
                "sha256=0000000000000000000000000000000000000000000000000000000000000000",
            ),
        );
        assert!(!verify_hmac_signature(
            "k",
            &Bytes::from_static(b"x"),
            &headers,
            SignatureMode::Cognia
        ));
    }

    #[test]
    fn decode_hex_round_trips() {
        assert_eq!(decode_hex("00").unwrap(), vec![0u8]);
        assert_eq!(decode_hex("abCD").unwrap(), vec![0xab, 0xcd]);
        assert!(decode_hex("0").is_err());
        assert!(decode_hex("zz").is_err());
    }

    #[test]
    fn signature_mode_header_name_picks_correct_header() {
        assert_eq!(SignatureMode::default(), SignatureMode::Cognia);
        assert_eq!(SignatureMode::Cognia.header_name(), "x-signature-256");
    }

    #[test]
    fn verify_hmac_signature_uses_constant_time_compare() {
        // The verify_slice() call inside verify_hmac_signature uses a
        // constant-time comparator under the hood (subtle::ConstantTimeEq via
        // hmac::Mac::verify_slice). This test asserts that two MACs of the
        // same length but different contents both return false — guarding
        // against a regression where someone replaces verify_slice with
        // straight equality.
        use axum::http::HeaderValue;
        let secret = "k";
        let mut headers = HeaderMap::new();
        headers.insert(
            HMAC_SIGNATURE_HEADER_COGNIA,
            HeaderValue::from_static(
                "sha256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            ),
        );
        assert!(!verify_hmac_signature(
            secret,
            &Bytes::from_static(b"x"),
            &headers,
            SignatureMode::Cognia
        ));
    }

    #[tokio::test]
    async fn signed_request_succeeds_when_mac_matches() {
        let router = WebhookRouter::new();
        let mut e = entry("signed");
        e.hmac_secret = Some("shh".into());
        router.upsert(e).unwrap();
        let recorder = Arc::new(RecordingEmitter::default());
        let bound = router.start(recorder.clone(), 0).await.unwrap();

        let body = "{\"a\":1}";
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(b"shh").unwrap();
        mac.update(body.as_bytes());
        let hex: String = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();

        let resp = reqwest::Client::new()
            .post(format!("http://{bound}/webhook/signed"))
            .header("Content-Type", "application/json")
            .header(HMAC_SIGNATURE_HEADER_COGNIA, format!("sha256={hex}"))
            .body(body.to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(recorder.fired.lock().len(), 1);
        router.stop();
    }

    #[tokio::test]
    async fn unsigned_request_is_rejected_when_secret_set() {
        let router = WebhookRouter::new();
        let mut e = entry("must-sign");
        e.hmac_secret = Some("shh".into());
        router.upsert(e).unwrap();
        let recorder = Arc::new(RecordingEmitter::default());
        let bound = router.start(recorder.clone(), 0).await.unwrap();

        let resp = reqwest::Client::new()
            .post(format!("http://{bound}/webhook/must-sign"))
            .body("{}".to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(recorder.fired.lock().is_empty());
        router.stop();
    }

    #[tokio::test]
    async fn oversize_body_is_rejected() {
        let router = WebhookRouter::new();
        router.upsert(entry("big")).unwrap();
        let recorder = Arc::new(RecordingEmitter::default());
        let bound = router.start(recorder.clone(), 0).await.unwrap();

        // 2 MiB — well above the 1 MiB cap.
        let payload = "x".repeat(2 * 1024 * 1024);
        let result = reqwest::Client::new()
            .post(format!("http://{bound}/webhook/big"))
            .body(payload)
            .send()
            .await;
        match result {
            Ok(resp) => assert_eq!(resp.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE),
            Err(err) if is_body_limit_connection_abort(&err) => {}
            Err(err) => panic!("unexpected oversize webhook response error: {err:?}"),
        }

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(recorder.fired.lock().is_empty());
        router.stop();
    }

    fn is_body_limit_connection_abort(err: &reqwest::Error) -> bool {
        if !err.is_request() {
            return false;
        }
        let mut source = err.source();
        while let Some(err) = source {
            let message = err.to_string().to_ascii_lowercase();
            if message.contains("connectionaborted")
                || message.contains("connection aborted")
                || message.contains("connection reset")
                || message.contains("broken pipe")
                || message.contains("10053")
                || message.contains("code: 54")
                || message.contains("code: 32")
            {
                return true;
            }
            source = err.source();
        }
        false
    }

    #[tokio::test]
    async fn disallowed_method_returns_405() {
        let router = WebhookRouter::new();
        router.upsert(entry("only-post")).unwrap();
        let recorder = Arc::new(RecordingEmitter::default());
        let bound = router.start(recorder, 0).await.unwrap();
        let resp = reqwest::Client::new()
            .get(format!("http://{bound}/webhook/only-post"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::METHOD_NOT_ALLOWED);
        router.stop();
    }

    #[test]
    fn generic_verification_supports_base64_hmac_timestamp_and_static_tokens() {
        let secret_handle = format!("test-{}", uuid::Uuid::new_v4());
        keyring_secrets::set(INGRESS_SECRET_NAMESPACE, &secret_handle, "secret").unwrap();
        let timestamp = chrono::Utc::now().timestamp().to_string();
        let body = Bytes::from_static(br#"{"id":1}"#);
        let signed = format!("{timestamp}.{}", String::from_utf8_lossy(&body));
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(b"secret").unwrap();
        mac.update(signed.as_bytes());
        let signature =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        let mut headers = HeaderMap::new();
        headers.insert("x-time", timestamp.parse().unwrap());
        headers.insert("x-signature", format!("v1={signature}").parse().unwrap());
        assert!(verify_integration_request(
            &IntegrationVerification::HmacSha256 {
                signature_header: "x-signature".into(),
                encoding: "base64".into(),
                prefix: Some("v1=".into()),
                signed_payload: Some(vec![
                    SignedPayloadPart::Header {
                        name: "x-time".into(),
                    },
                    SignedPayloadPart::Literal { value: ".".into() },
                    SignedPayloadPart::Body,
                ]),
                timestamp_header: Some("x-time".into()),
                max_skew_seconds: Some(60),
                secret_handle: secret_handle.clone(),
            },
            &body,
            &headers,
        ));

        headers.insert("x-token", "secret".parse().unwrap());
        assert!(verify_integration_request(
            &IntegrationVerification::StaticToken {
                token_header: "x-token".into(),
                secret_handle: secret_handle.clone(),
            },
            &body,
            &headers,
        ));
        keyring_secrets::clear(INGRESS_SECRET_NAMESPACE, &secret_handle).unwrap();
    }

    #[tokio::test]
    async fn integration_ingress_spools_before_acknowledging_and_deduplicates() {
        let router = WebhookRouter::new();
        let secret_handle = format!("test-{}", uuid::Uuid::new_v4());
        keyring_secrets::set(INGRESS_SECRET_NAMESPACE, &secret_handle, "shared-token").unwrap();
        router
            .upsert_integration(IntegrationIngressEntry {
                route_id: "route-1".into(),
                plugin_id: "demo-delivery".into(),
                integration_id: "demo".into(),
                account_id: "account-1".into(),
                subscription_id: Some("subscription-1".into()),
                path: "demo".into(),
                verification: IntegrationVerification::StaticToken {
                    token_header: "x-token".into(),
                    secret_handle: secret_handle.clone(),
                },
                delivery_id_header: Some("x-delivery-id".into()),
                event_type_header: Some("x-event-type".into()),
                enabled: true,
            })
            .unwrap();
        let recorder = Arc::new(RecordingEmitter::default());
        let bound = router.start(recorder, 0).await.unwrap();
        let client = reqwest::Client::new();
        for expected in [reqwest::StatusCode::ACCEPTED, reqwest::StatusCode::OK] {
            let response = client
                .post(format!("http://{bound}/integration/demo"))
                .header("x-token", "shared-token")
                .header("x-delivery-id", "delivery-1")
                .header("x-event-type", "issue.created")
                .body(r#"{"id":"issue-1"}"#)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        let pending = router.inner.integration_spool.pending(10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].event_type.as_deref(), Some("issue.created"));
        keyring_secrets::clear(INGRESS_SECRET_NAMESPACE, &secret_handle).unwrap();
        router.stop();
    }
}
