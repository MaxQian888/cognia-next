//! Loopback control channel between the app and the companion VS Code extension
//! side-loaded into code-server (Pro IDE Phase 2 — agent↔IDE bidirectional).
//!
//! # Why a dedicated channel
//!
//! code-server's own CLI (`--reuse-window <file>:<line>:<col>`) can only open and
//! reveal — it cannot apply an undo-able edit or read the active editor back. Those
//! need to run *inside* the VS Code extension host, so the app talks to a companion
//! extension (`sidecar/codeserver-agent-ext/`) over this channel. It is hosted here
//! in the `codeserver` module — not the opt-in `companion_api` server — so a core
//! editor feature never depends on remote-access being enabled: it comes up and tears
//! down with the code-server processes it drives.
//!
//! # Transport
//!
//! JSON-RPC 2.0 with LSP-style `Content-Length` framing over a loopback TCP socket
//! (`127.0.0.1`). The legacy newline protocol remains available for one release
//! cycle and exposes only its original editor-control surface.
//!
//! # Topology
//!
//! There is exactly ONE loopback TCP server per app (lazily bound to `127.0.0.1:0`).
//! Each spawned code-server instance is `register`ed here, minting a per-instance
//! CSPRNG token mapped to that instance's canonical project root. The token + the
//! port are injected into the code-server child's environment (`process.rs`); the
//! companion extension reads them, connects, and sends a `hello { token }` line. The
//! server maps the token back to the root and stores the connection, so
//! [`AgentChannel::send`] can address a request "to the editor serving root X".
//!
//! # Wire protocol (one JSON object per line)
//!
//! ```text
//! // extension → app, once on connect
//! { "type": "hello", "token": "<per-instance>" }
//! // app → extension
//! { "type": "req", "id": 1, "method": "openFile",
//!   "params": { "path": "/abs/file.ts", "line": 42, "column": 1 } }
//! // extension → app
//! { "type": "res", "id": 1, "ok": true, "result": { … } }
//! { "type": "res", "id": 1, "ok": false, "error": "…" }
//! // extension → app, unsolicited
//! { "type": "evt", "name": "activeEditorChanged", "payload": { … } }
//! ```
//!
//! The envelope is method-generic: `openFile`, `applyEdit`, `readActive`, `saveAll`,
//! `showDiff`, `revealInExplorer`, `runInTerminal` and `notify` all ride the same
//! frames, so new editor-control methods slot in without a protocol change.
//!
//! `evt` is the reverse direction and carries no id: the extension reports editor
//! changes as they happen (active editor, selection, save, diagnostics) and the app
//! re-reads off the signal instead of polling `readActive` on a timer. Events are
//! re-emitted to the renderer as [`CODESERVER_EDITOR_EVENT`].
//!
//! # Auth
//!
//! Loopback-source check + a per-instance shared token. The token is only ever placed
//! in the (loopback-only) code-server child's env, so possessing it proves the caller
//! is that instance's extension. Mirrors the fleet-token pattern rather than the
//! heavier device-JWT the companion server uses.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::routing::{get, put};
use axum::{Json, Router};
use hmac::{Hmac, KeyInit, Mac};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, OnceCell};
use uuid::Uuid;

use super::broker_protocol::{
    detect_protocol, encode_content_length, read_content_length_value, ProtocolMode,
    CODE_API_VERSION, CURRENT_PROTOCOL_VERSION, DEFAULT_CATALOG_HASH, MAX_FRAME_BYTES,
    PREVIOUS_PROTOCOL_VERSION,
};

/// How long a `send` waits for the extension to answer before giving up. The
/// caller (frontend bridge / agent tool) degrades gracefully on timeout — the
/// CLI open path and the disk-reload edit path remain available.
const AGENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Depth of a connection's outbound frame queue. Frames are tiny and infrequent
/// (one per agent editor action), so a small bound is plenty and still applies
/// backpressure rather than growing without limit.
const OUTBOUND_CHANNEL_CAPACITY: usize = 32;
const CONTENT_HANDLE_TTL: Duration = Duration::from_secs(30);
const MAX_CONTENT_HANDLE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CONTENT_HANDLE_COUNT: usize = 128;
const MAX_CONTENT_STORE_BYTES: usize = 128 * 1024 * 1024;
type AuthenticationSuccess = (String, Option<Value>, Vec<String>);
type AuthenticationFailure = (Option<Value>, i64, String);
const BROKER_CAPABILITIES: &[&str] = &[
    "cancel",
    "progress",
    "structured-errors",
    "content-handles",
    "contribution-transactions",
];

/// Renderer event carrying an editor change pushed by the companion extension.
pub const CODESERVER_EDITOR_EVENT: &str = "codeserver://editor-event";
/// Renderer event carrying a provider callback from a generated managed proxy.
pub const CODESERVER_BROKER_REQUEST_EVENT: &str = "codeserver://broker-request";
/// Renderer event carrying a cancellation or other one-way broker notification.
pub const CODESERVER_BROKER_NOTIFICATION_EVENT: &str = "codeserver://broker-notification";

// ── Wire frames ──────────────────────────────────────────────────────────────

/// A frame received from the companion extension.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InboundFrame {
    /// First frame on connect; authenticates the socket against a minted token.
    Hello { token: String },
    /// Response correlated to a prior [`OutboundFrame::Req`] by `id`.
    Res {
        id: u64,
        #[serde(default)]
        ok: bool,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<String>,
    },
    /// Unsolicited editor-state change. No id — nothing correlates to it.
    Evt {
        name: String,
        #[serde(default)]
        payload: Option<Value>,
    },
}

/// Payload of [`CODESERVER_EDITOR_EVENT`]. `root` is the canonical project root the
/// reporting instance serves, so a renderer hosting two panes can tell them apart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerEditorEvent {
    pub root: String,
    pub name: String,
    pub payload: Value,
}

/// A JSON-RPC callback initiated by a generated proxy extension. The renderer
/// routes it into the Cognia plugin runtime, then answers through
/// [`AgentChannel::respond`]. `generation` prevents a stale response from a
/// replaced extension host being delivered to the new one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerBrokerRequest {
    pub root: String,
    pub generation: u64,
    pub id: Value,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerBrokerNotification {
    pub root: String,
    pub generation: u64,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHandle {
    #[serde(rename = "$type")]
    pub kind: String,
    pub id: String,
    pub size: usize,
    pub sha256: String,
    pub media_type: String,
    pub expires_at_ms: u64,
}

/// A frame sent to the companion extension.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutboundFrame {
    Req {
        id: u64,
        method: String,
        params: Value,
    },
}

// ── Channel state ────────────────────────────────────────────────────────────

/// One connected extension's outbound queue, tagged with a monotonic connection
/// id so a stale close only evicts its own entry (not a fresher reconnect).
struct Conn {
    conn_id: u64,
    mode: ProtocolMode,
    tx: mpsc::Sender<Vec<u8>>,
}

struct PendingRequest {
    root: String,
    conn_id: u64,
    responder: oneshot::Sender<Result<Value, String>>,
}

#[derive(Default)]
struct Registry {
    /// Per-instance opaque token id → root and HMAC secret.
    tokens: HashMap<String, BrokerCredential>,
    /// canonical project root → live extension connection.
    conns: HashMap<String, Conn>,
}

#[derive(Clone)]
struct BrokerCredential {
    root: String,
    secret: String,
    host_id: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ContentDirection {
    ToRuntime,
    ToExtension,
}

struct ContentRecord {
    handle: ContentHandle,
    root: String,
    generation: u64,
    plugin_id: String,
    provider_id: String,
    permission: Option<String>,
    direction: ContentDirection,
    expires_at: Instant,
    bytes: Vec<u8>,
}

/// Sole owner of the loopback agent-control WS. See the module docs.
pub struct AgentChannel {
    port: OnceCell<u16>,
    content_port: OnceCell<u16>,
    registry: Mutex<Registry>,
    content: Mutex<HashMap<String, ContentRecord>>,
    pending: Mutex<HashMap<u64, PendingRequest>>,
    next_request_id: AtomicU64,
    next_conn_id: AtomicU64,
    /// Set on the first `register_instance`, so pushed editor events can be
    /// re-emitted to the renderer. `None` in unit tests (and before any spawn),
    /// where an event simply has nowhere to go.
    app: Mutex<Option<tauri::AppHandle>>,
    /// Headless companion equivalent of `app`: broker callbacks are published
    /// onto the authenticated companion event stream and answered through RPC.
    event_bus: Mutex<Option<Arc<crate::companion_api::event_bus::EventBus>>>,
}

impl AgentChannel {
    fn new() -> Self {
        Self {
            port: OnceCell::new(),
            content_port: OnceCell::new(),
            registry: Mutex::new(Registry::default()),
            content: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            next_conn_id: AtomicU64::new(1),
            app: Mutex::new(None),
            event_bus: Mutex::new(None),
        }
    }

    /// Register a freshly-spawned code-server instance: (re)mint its token and
    /// return `(ws_port, token)` for injection into the child's spawn env. Starts
    /// the loopback WS server on first call.
    ///
    /// A prior registration for the same root is dropped first — a respawn must
    /// invalidate the dead instance's token and connection so a leaked old token
    /// can never address the new editor.
    pub async fn register_instance(self: &Arc<Self>, root: &str) -> Result<(u16, String), String> {
        self.register_instance_for_host(root, "local").await
    }

    /// Register an instance owned by a specific Cognia host. The host id is
    /// authenticated during the JSON-RPC hello and prevents a credential
    /// copied from another paired host from attaching to this generation.
    pub async fn register_instance_for_host(
        self: &Arc<Self>,
        root: &str,
        host_id: &str,
    ) -> Result<(u16, String), String> {
        let port = self.ensure_server().await?;
        self.ensure_content_server().await?;
        let token_id = Uuid::new_v4().to_string();
        let token_secret = Uuid::new_v4().to_string();
        let replaced_conn = {
            let mut reg = self.lock_registry();
            reg.tokens.retain(|_, grant| grant.root != root);
            let replaced = reg.conns.remove(root).map(|conn| conn.conn_id);
            reg.tokens.insert(
                token_id.clone(),
                BrokerCredential {
                    root: root.to_string(),
                    secret: token_secret.clone(),
                    host_id: host_id.to_string(),
                },
            );
            replaced
        };
        if let Some(conn_id) = replaced_conn {
            self.fail_pending_for_connection(
                root,
                conn_id,
                "Pro IDE extension instance was replaced",
            );
        }
        Ok((port, format!("{token_id}.{token_secret}")))
    }

    pub async fn content_port(self: &Arc<Self>) -> Result<u16, String> {
        self.ensure_content_server().await
    }

    // Every field participates in content-handle authorization and integrity;
    // keeping them explicit makes accidental scope loss visible at call sites.
    #[allow(clippy::too_many_arguments)]
    pub fn create_content_handle(
        &self,
        root: &str,
        generation: u64,
        plugin_id: &str,
        provider_id: &str,
        permission: Option<String>,
        media_type: String,
        bytes: Vec<u8>,
    ) -> Result<ContentHandle, String> {
        if !self.is_current_connection(root, generation) {
            return Err("stale Pro IDE broker connection generation".to_string());
        }
        self.insert_content(
            root,
            generation,
            plugin_id,
            provider_id,
            permission,
            media_type,
            ContentDirection::ToExtension,
            bytes,
        )
    }

    pub fn redeem_content_handle(
        &self,
        root: &str,
        generation: u64,
        plugin_id: &str,
        provider_id: &str,
        permission: Option<&str>,
        handle_id: &str,
    ) -> Result<Vec<u8>, String> {
        self.take_content(
            root,
            generation,
            plugin_id,
            provider_id,
            permission,
            ContentDirection::ToRuntime,
            handle_id,
        )
    }

    /// Give the channel the handle it needs to re-emit pushed editor events to the
    /// renderer. Called from the spawn path; first caller wins, and subsequent
    /// calls are no-ops.
    ///
    /// Separate from [`Self::register_instance`] rather than a parameter of it so the
    /// registry, framing and correlation logic stay drivable from unit tests, which
    /// have no `AppHandle` to hand over.
    pub fn attach_app(&self, app: &tauri::AppHandle) {
        let mut slot = self.app.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_none() {
            *slot = Some(app.clone());
        }
    }

    /// Attach the no-Tauri companion event stream. Unlike editor snapshots,
    /// broker requests must fail when neither runtime surface is attached.
    pub fn attach_event_bus(&self, event_bus: Arc<crate::companion_api::event_bus::EventBus>) {
        let mut slot = self.event_bus.lock().unwrap_or_else(|p| p.into_inner());
        *slot = Some(event_bus);
    }

    pub fn connection_generation(&self, root: &str) -> Option<u64> {
        self.lock_registry()
            .conns
            .get(root)
            .map(|connection| connection.conn_id)
    }

    pub async fn wait_for_new_generation(
        &self,
        root: &str,
        previous: u64,
        timeout: Duration,
    ) -> Result<u64, String> {
        let started = Instant::now();
        loop {
            if let Some(generation) = self.connection_generation(root) {
                if generation > previous {
                    return Ok(generation);
                }
            }
            if started.elapsed() >= timeout {
                return Err("managed extension host restart timed out".to_string());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Forget an instance (explicit stop / kill-switch): drop its token(s) and any
    /// live connection. Idempotent.
    pub fn deregister(&self, root: &str) {
        let removed_conn = {
            let mut reg = self.lock_registry();
            reg.tokens.retain(|_, grant| grant.root != root);
            reg.conns.remove(root).map(|conn| conn.conn_id)
        };
        if let Some(conn_id) = removed_conn {
            self.fail_pending_for_connection(
                root,
                conn_id,
                "Pro IDE extension instance was deregistered",
            );
        }
    }

    /// Send `method` to the editor serving `root` and await its response. Errors
    /// when no extension is connected for that root (caller degrades to the CLI /
    /// disk-reload path) or the request times out.
    pub async fn send(&self, root: &str, method: &str, params: Value) -> Result<Value, String> {
        let (tx, conn_id, mode) = {
            let reg = self.lock_registry();
            reg.conns
                .get(root)
                .map(|conn| (conn.tx.clone(), conn.conn_id, conn.mode))
                .ok_or_else(|| "Pro IDE extension is not connected for this project".to_string())?
        };

        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (response_tx, response_rx) = oneshot::channel();
        self.lock_pending().insert(
            id,
            PendingRequest {
                root: root.to_string(),
                conn_id,
                responder: response_tx,
            },
        );

        let bytes = match mode {
            ProtocolMode::Legacy => {
                let frame = OutboundFrame::Req {
                    id,
                    method: method.to_string(),
                    params,
                };
                let mut bytes =
                    serde_json::to_vec(&frame).map_err(|e| format!("encode request: {e}"))?;
                bytes.push(b'\n');
                bytes
            }
            ProtocolMode::JsonRpc => encode_content_length(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }))?,
        };

        let outcome = tokio::time::timeout(AGENT_REQUEST_TIMEOUT, async {
            tx.send(bytes)
                .await
                .map_err(|_| "Pro IDE extension connection closed".to_string())?;
            response_rx
                .await
                .map_err(|_| "Pro IDE extension dropped the request".to_string())?
        })
        .await;
        match outcome {
            Ok(result) => result,
            Err(_) => {
                self.lock_pending().remove(&id);
                Err("Pro IDE extension request timed out".to_string())
            }
        }
    }

    /// Answer a callback initiated by a managed proxy extension.
    ///
    /// Responses are scoped to the exact connection generation that originated
    /// the request. Actions are never replayed across reconnects.
    pub async fn respond(
        &self,
        root: &str,
        generation: u64,
        id: Value,
        result: Option<Value>,
        error: Option<Value>,
    ) -> Result<(), String> {
        let tx = {
            let reg = self.lock_registry();
            let conn = reg
                .conns
                .get(root)
                .ok_or_else(|| "Pro IDE extension is not connected for this project".to_string())?;
            if conn.conn_id != generation {
                return Err("stale Pro IDE broker connection generation".to_string());
            }
            if conn.mode != ProtocolMode::JsonRpc {
                return Err("legacy Pro IDE bridge does not support provider callbacks".to_string());
            }
            conn.tx.clone()
        };
        let response = match error {
            Some(error) => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": error,
            }),
            None => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result.unwrap_or(Value::Null),
            }),
        };
        let bytes = encode_content_length(&response)?;
        tx.send(bytes)
            .await
            .map_err(|_| "Pro IDE extension connection closed".to_string())
    }

    /// Deliver a one-way provider event to the current managed extension host.
    /// Events are state refresh signals and are never replayed after reconnect.
    pub async fn notify_provider(
        &self,
        root: &str,
        generation: u64,
        params: Value,
    ) -> Result<(), String> {
        let tx = {
            let reg = self.lock_registry();
            let conn = reg
                .conns
                .get(root)
                .ok_or_else(|| "Pro IDE extension is not connected for this project".to_string())?;
            if conn.conn_id != generation {
                return Err("stale Pro IDE broker connection generation".to_string());
            }
            if conn.mode != ProtocolMode::JsonRpc {
                return Err("legacy Pro IDE bridge does not support provider events".to_string());
            }
            conn.tx.clone()
        };
        let bytes = encode_content_length(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "cognia/provider/event",
            "params": params,
        }))?;
        tx.send(bytes)
            .await
            .map_err(|_| "Pro IDE extension connection closed".to_string())
    }

    // ── internals ────────────────────────────────────────────────────────────

    /// Bind the loopback WS server once and return its port. Subsequent calls
    /// return the cached port. Requires a tokio runtime (always present under the
    /// Tauri async runtime that spawns code-server).
    async fn ensure_server(self: &Arc<Self>) -> Result<u16, String> {
        let port = self
            .port
            .get_or_try_init(|| async {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|e| format!("bind agent channel: {e}"))?;
                let addr = listener
                    .local_addr()
                    .map_err(|e| format!("read agent channel port: {e}"))?;
                let channel = Arc::clone(self);
                tokio::spawn(async move {
                    loop {
                        match listener.accept().await {
                            Ok((stream, peer)) => {
                                // The listener binds loopback; reject anything else defensively.
                                if !is_loopback(&peer) {
                                    continue;
                                }
                                tokio::spawn(handle_conn(stream, Arc::clone(&channel)));
                            }
                            Err(e) => {
                                log::warn!("codeserver agent_channel accept error: {e}");
                            }
                        }
                    }
                });
                Ok::<u16, String>(addr.port())
            })
            .await?;
        Ok(*port)
    }

    async fn ensure_content_server(self: &Arc<Self>) -> Result<u16, String> {
        let port = self
            .content_port
            .get_or_try_init(|| async {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|error| format!("bind content handle server: {error}"))?;
                let port = listener
                    .local_addr()
                    .map_err(|error| format!("read content handle port: {error}"))?
                    .port();
                let router = Router::new()
                    .route("/v1/content", put(upload_content))
                    .route("/v1/content/{id}", get(download_content))
                    .layer(DefaultBodyLimit::max(MAX_CONTENT_HANDLE_BYTES))
                    .with_state(Arc::clone(self));
                tokio::spawn(async move {
                    if let Err(error) = axum::serve(listener, router).await {
                        log::warn!("codeserver content handle server stopped: {error}");
                    }
                });
                Ok::<u16, String>(port)
            })
            .await?;
        Ok(*port)
    }

    /// Resolve the root a token was minted for. Returns `None` for an unknown or
    /// revoked token.
    fn credential_for_id(&self, token_id: &str) -> Option<BrokerCredential> {
        self.lock_registry().tokens.get(token_id).cloned()
    }

    fn root_for_legacy_token(&self, token: &str) -> Option<String> {
        let (token_id, secret) = token.split_once('.')?;
        let credential = self.credential_for_id(token_id)?;
        (credential.secret == secret).then_some(credential.root)
    }

    fn current_scope_for_token(&self, token: &str) -> Option<(String, u64)> {
        let root = self.root_for_legacy_token(token)?;
        let generation = self
            .lock_registry()
            .conns
            .get(&root)
            .filter(|connection| connection.mode == ProtocolMode::JsonRpc)
            .map(|connection| connection.conn_id)?;
        Some((root, generation))
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_content(
        &self,
        root: &str,
        generation: u64,
        plugin_id: &str,
        provider_id: &str,
        permission: Option<String>,
        media_type: String,
        direction: ContentDirection,
        bytes: Vec<u8>,
    ) -> Result<ContentHandle, String> {
        if bytes.len() > MAX_CONTENT_HANDLE_BYTES {
            return Err(format!(
                "IDE_CONTENT_TOO_LARGE: {} exceeds {MAX_CONTENT_HANDLE_BYTES}",
                bytes.len()
            ));
        }
        let now = Instant::now();
        let mut content = self.content.lock().unwrap_or_else(|p| p.into_inner());
        content.retain(|_, record| record.expires_at > now);
        let total = content
            .values()
            .map(|record| record.bytes.len())
            .sum::<usize>();
        if content.len() >= MAX_CONTENT_HANDLE_COUNT
            || total.saturating_add(bytes.len()) > MAX_CONTENT_STORE_BYTES
        {
            return Err("IDE_CONTENT_STORE_SATURATED".to_string());
        }
        let id = Uuid::new_v4().to_string();
        let digest = Sha256::digest(&bytes);
        let handle = ContentHandle {
            kind: "ContentHandle".to_string(),
            id: id.clone(),
            size: bytes.len(),
            sha256: hex::encode(digest),
            media_type,
            expires_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .saturating_add(CONTENT_HANDLE_TTL)
                .as_millis() as u64,
        };
        content.insert(
            id,
            ContentRecord {
                handle: handle.clone(),
                root: root.to_string(),
                generation,
                plugin_id: plugin_id.to_string(),
                provider_id: provider_id.to_string(),
                permission,
                direction,
                expires_at: now + CONTENT_HANDLE_TTL,
                bytes,
            },
        );
        Ok(handle)
    }

    #[allow(clippy::too_many_arguments)]
    fn take_content(
        &self,
        root: &str,
        generation: u64,
        plugin_id: &str,
        provider_id: &str,
        permission: Option<&str>,
        direction: ContentDirection,
        handle_id: &str,
    ) -> Result<Vec<u8>, String> {
        let mut content = self.content.lock().unwrap_or_else(|p| p.into_inner());
        let record = content
            .get(handle_id)
            .ok_or_else(|| "IDE_CONTENT_HANDLE_NOT_FOUND".to_string())?;
        if record.expires_at <= Instant::now() {
            content.remove(handle_id);
            return Err("IDE_CONTENT_HANDLE_EXPIRED".to_string());
        }
        if record.root != root
            || record.generation != generation
            || record.plugin_id != plugin_id
            || record.provider_id != provider_id
            || record.permission.as_deref() != permission
            || record.direction != direction
        {
            return Err("IDE_CONTENT_HANDLE_SCOPE_MISMATCH".to_string());
        }
        let record = content
            .remove(handle_id)
            .expect("content handle was checked above");
        let digest = Sha256::digest(&record.bytes);
        if hex::encode(digest) != record.handle.sha256 || record.bytes.len() != record.handle.size {
            return Err("IDE_CONTENT_HANDLE_INTEGRITY_FAILED".to_string());
        }
        Ok(record.bytes)
    }

    /// Attach a connection's outbound queue to `root`, returning the connection id
    /// so [`Self::detach_conn`] can avoid evicting a newer reconnect.
    fn attach_conn(&self, root: &str, mode: ProtocolMode, tx: mpsc::Sender<Vec<u8>>) -> u64 {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        let replaced = self
            .lock_registry()
            .conns
            .insert(root.to_string(), Conn { conn_id, mode, tx });
        if let Some(previous) = replaced {
            self.fail_pending_for_connection(
                root,
                previous.conn_id,
                "Pro IDE extension connection was replaced",
            );
        }
        conn_id
    }

    /// Drop `root`'s connection only if it is still the one identified by
    /// `conn_id` (a later reconnect for the same root must survive this one's close).
    fn detach_conn(&self, root: &str, conn_id: u64) {
        let removed = {
            let mut reg = self.lock_registry();
            if reg
                .conns
                .get(root)
                .is_some_and(|conn| conn.conn_id == conn_id)
            {
                reg.conns.remove(root);
                true
            } else {
                false
            }
        };
        if removed {
            self.fail_pending_for_connection(root, conn_id, "Pro IDE extension connection closed");
        }
    }

    fn fail_pending_for_connection(&self, root: &str, conn_id: u64, reason: &str) {
        let mut pending = self.lock_pending();
        let ids: Vec<u64> = pending
            .iter()
            .filter_map(|(id, request)| {
                (request.root == root && request.conn_id == conn_id).then_some(*id)
            })
            .collect();
        for id in ids {
            if let Some(request) = pending.remove(&id) {
                let _ = request.responder.send(Err(reason.to_string()));
            }
        }
    }

    fn is_current_connection(&self, root: &str, conn_id: u64) -> bool {
        self.lock_registry()
            .conns
            .get(root)
            .is_some_and(|conn| conn.conn_id == conn_id)
    }

    /// Fire the responder for a correlated response id. Unknown ids (already
    /// timed out) are a silent no-op.
    fn resolve(&self, root: &str, conn_id: u64, id: u64, outcome: Result<Value, String>) {
        let mut pending = self.lock_pending();
        let matches_connection = pending
            .get(&id)
            .is_some_and(|request| request.root == root && request.conn_id == conn_id);
        if matches_connection {
            if let Some(request) = pending.remove(&id) {
                let _ = request.responder.send(outcome);
            }
        }
    }

    /// Re-emit a pushed editor event to the renderer.
    ///
    /// Best-effort and silent: an event describes current state, so a drop (no app
    /// handle yet, no listener, a closing window) is superseded by the next one and
    /// is never worth failing the connection over.
    fn forward_event(&self, root: &str, name: String, payload: Option<Value>) {
        use tauri::Emitter as _;
        let event = CodeServerEditorEvent {
            root: root.to_string(),
            name,
            payload: payload.unwrap_or(Value::Null),
        };
        let app = {
            let slot = self.app.lock().unwrap_or_else(|p| p.into_inner());
            slot.clone()
        };
        if let Some(app) = app {
            let _ = app.emit(CODESERVER_EDITOR_EVENT, event.clone());
        }
        if let Some(bus) = self
            .event_bus
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        {
            if let Ok(value) = serde_json::to_value(event) {
                bus.publish(CODESERVER_EDITOR_EVENT.to_string(), value);
            }
        }
    }

    fn forward_broker_request(
        &self,
        root: &str,
        generation: u64,
        id: Value,
        method: String,
        params: Value,
    ) -> Result<(), String> {
        use tauri::Emitter as _;
        let request = CodeServerBrokerRequest {
            root: root.to_string(),
            generation,
            id,
            method,
            params,
        };
        let app = {
            let slot = self.app.lock().unwrap_or_else(|p| p.into_inner());
            slot.clone()
        };
        if let Some(app) = app {
            return app
                .emit(CODESERVER_BROKER_REQUEST_EVENT, request)
                .map_err(|error| format!("emit broker request: {error}"));
        }
        let bus = self
            .event_bus
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| "Cognia broker runtime is not attached".to_string())?;
        let value = serde_json::to_value(request)
            .map_err(|error| format!("serialize broker request: {error}"))?;
        bus.publish(CODESERVER_BROKER_REQUEST_EVENT.to_string(), value);
        Ok(())
    }

    fn forward_broker_notification(
        &self,
        root: &str,
        generation: u64,
        method: String,
        params: Value,
    ) -> Result<(), String> {
        use tauri::Emitter as _;
        let notification = CodeServerBrokerNotification {
            root: root.to_string(),
            generation,
            method,
            params,
        };
        let app = {
            let slot = self.app.lock().unwrap_or_else(|p| p.into_inner());
            slot.clone()
        };
        if let Some(app) = app {
            return app
                .emit(CODESERVER_BROKER_NOTIFICATION_EVENT, notification)
                .map_err(|error| format!("emit broker notification: {error}"));
        }
        let bus = self
            .event_bus
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| "Cognia broker runtime is not attached".to_string())?;
        let value = serde_json::to_value(notification)
            .map_err(|error| format!("serialize broker notification: {error}"))?;
        bus.publish(CODESERVER_BROKER_NOTIFICATION_EVENT.to_string(), value);
        Ok(())
    }

    fn lock_registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn lock_pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, PendingRequest>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }
}

static AGENT_CHANNEL: Lazy<Arc<AgentChannel>> = Lazy::new(|| Arc::new(AgentChannel::new()));

/// The process-wide agent control channel.
pub fn global() -> Arc<AgentChannel> {
    Arc::clone(&AGENT_CHANNEL)
}

/// The agent-drive verbs, as free functions over an already-canonical root.
///
/// They live here rather than on a host state because neither host contributes
/// anything to them. `CodeServerState` and `RemoteCodeServerState` both did
/// nothing but canonicalize a root and forward to the channel above, which is
/// process-global and keyed by that root. Keeping the verb names and parameter
/// shapes in one place is the point: the desktop and the headless host used to
/// be the only caller and the only non-caller respectively, which is how a
/// desktop driving a remote workbench ended up sending `openFile` to its own
/// machine.
///
/// Canonicalization stays with the caller. The two hosts resolve a workspace
/// root differently (one against the filesystem, one against the set of roots a
/// device is allowed to reach), and collapsing that here would quietly widen
/// what a remote caller can address.
pub mod verbs {
    use super::global;
    use serde_json::{json, Value};

    pub async fn open(
        canonical: &str,
        path: &str,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<Value, String> {
        global()
            .send(
                canonical,
                "openFile",
                json!({ "path": path, "line": line, "column": column }),
            )
            .await
    }

    pub async fn apply_edit(
        canonical: &str,
        path: &str,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<Value, String> {
        global()
            .send(
                canonical,
                "applyEdit",
                json!({ "path": path, "line": line, "column": column }),
            )
            .await
    }

    pub async fn read_active(canonical: &str) -> Result<Value, String> {
        global().send(canonical, "readActive", json!({})).await
    }

    pub async fn save_all(canonical: &str, path: Option<&str>) -> Result<Value, String> {
        global()
            .send(canonical, "saveAll", json!({ "path": path }))
            .await
    }

    pub async fn show_diff(
        canonical: &str,
        path: &str,
        content: &str,
        title: Option<&str>,
    ) -> Result<Value, String> {
        global()
            .send(
                canonical,
                "showDiff",
                json!({ "path": path, "content": content, "title": title }),
            )
            .await
    }

    pub async fn reveal(canonical: &str, path: &str) -> Result<Value, String> {
        global()
            .send(canonical, "revealInExplorer", json!({ "path": path }))
            .await
    }

    pub async fn run_in_terminal(
        canonical: &str,
        command: &str,
        cwd: Option<&str>,
        name: Option<&str>,
    ) -> Result<Value, String> {
        global()
            .send(
                canonical,
                "runInTerminal",
                json!({ "command": command, "cwd": cwd, "name": name }),
            )
            .await
    }

    pub async fn notify(canonical: &str, message: &str, kind: Option<&str>) -> Result<Value, String> {
        global()
            .send(canonical, "notify", json!({ "message": message, "kind": kind }))
            .await
    }

    pub async fn workspace_snapshot(canonical: &str, snapshot: Value) -> Result<Value, String> {
        global().send(canonical, "workspaceSnapshot", snapshot).await
    }
}

async fn upload_content(
    State(channel): State<Arc<AgentChannel>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<ContentHandle>, (StatusCode, String)> {
    let credential = bearer_credential(&headers)?;
    let (root, generation) = channel
        .current_scope_for_token(credential)
        .ok_or_else(|| unauthorized("invalid or disconnected broker credential"))?;
    let plugin_id = required_content_header(&headers, "x-cognia-plugin-id")?;
    let provider_id = required_content_header(&headers, "x-cognia-provider-id")?;
    let permission = optional_content_header(&headers, "x-cognia-permission")?;
    let media_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    channel
        .insert_content(
            &root,
            generation,
            plugin_id,
            provider_id,
            permission.map(str::to_string),
            media_type,
            ContentDirection::ToRuntime,
            bytes.to_vec(),
        )
        .map(Json)
        .map_err(content_error)
}

async fn download_content(
    State(channel): State<Arc<AgentChannel>>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Vec<u8>), (StatusCode, String)> {
    let credential = bearer_credential(&headers)?;
    let (root, generation) = channel
        .current_scope_for_token(credential)
        .ok_or_else(|| unauthorized("invalid or disconnected broker credential"))?;
    let plugin_id = required_content_header(&headers, "x-cognia-plugin-id")?;
    let provider_id = required_content_header(&headers, "x-cognia-provider-id")?;
    let permission = optional_content_header(&headers, "x-cognia-permission")?;
    let bytes = channel
        .take_content(
            &root,
            generation,
            plugin_id,
            provider_id,
            permission,
            ContentDirection::ToExtension,
            &id,
        )
        .map_err(content_error)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response_headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((response_headers, bytes))
}

fn bearer_credential(headers: &HeaderMap) -> Result<&str, (StatusCode, String)> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| unauthorized("missing bearer credential"))
}

fn required_content_header<'a>(
    headers: &'a HeaderMap,
    name: &'static str,
) -> Result<&'a str, (StatusCode, String)> {
    optional_content_header(headers, name)?
        .ok_or_else(|| (StatusCode::BAD_REQUEST, format!("missing {name}")))
}

fn optional_content_header<'a>(
    headers: &'a HeaderMap,
    name: &'static str,
) -> Result<Option<&'a str>, (StatusCode, String)> {
    headers
        .get(name)
        .map(|value| {
            value
                .to_str()
                .map_err(|_| (StatusCode::BAD_REQUEST, format!("invalid {name}")))
        })
        .transpose()
}

fn unauthorized(message: &str) -> (StatusCode, String) {
    (StatusCode::UNAUTHORIZED, message.to_string())
}

fn content_error(message: String) -> (StatusCode, String) {
    let status = if message.contains("SATURATED") {
        StatusCode::TOO_MANY_REQUESTS
    } else if message.contains("TOO_LARGE") {
        StatusCode::PAYLOAD_TOO_LARGE
    } else if message.contains("NOT_FOUND") || message.contains("EXPIRED") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::FORBIDDEN
    };
    (status, message)
}

/// Whether a peer address is loopback. Extracted (and unit-tested) so the source
/// gate is provable without a live socket. The server binds `127.0.0.1` so this is
/// defence-in-depth against any future non-loopback bind.
fn is_loopback(addr: &SocketAddr) -> bool {
    addr.ip().is_loopback()
}

/// One task per extension connection. Protocol v1 uses JSON-RPC 2.0
/// `Content-Length` frames; the newline protocol is accepted for one compatibility
/// cycle. The first frame always authenticates and negotiates before the
/// connection is published to callers.
async fn handle_conn(stream: TcpStream, channel: Arc<AgentChannel>) {
    if !stream.peer_addr().map(|a| is_loopback(&a)).unwrap_or(false) {
        return;
    }
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mode = match reader.fill_buf().await {
        Ok(prefix) if !prefix.is_empty() => detect_protocol(prefix),
        _ => return,
    };
    let first = match read_wire_value(&mut reader, mode).await {
        Ok(Some(value)) => value,
        Ok(None) | Err(_) => return,
    };

    let authentication = match mode {
        ProtocolMode::Legacy => authenticate_first_frame(&channel, mode, first),
        ProtocolMode::JsonRpc => {
            authenticate_jsonrpc_handshake(&channel, &mut reader, &mut write_half, first).await
        }
    };
    let (root, hello_id, negotiated_capabilities) = match authentication {
        Ok(authenticated) => authenticated,
        Err((id, code, message)) => {
            if mode == ProtocolMode::JsonRpc {
                let response = jsonrpc_error(id.unwrap_or(Value::Null), code, &message, None);
                if let Ok(bytes) = encode_content_length(&response) {
                    let _ = write_half.write_all(&bytes).await;
                }
            }
            return;
        }
    };

    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_CHANNEL_CAPACITY);
    let conn_id = channel.attach_conn(&root, mode, outbound_tx.clone());
    if mode == ProtocolMode::JsonRpc {
        let response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": hello_id.unwrap_or(Value::String("hello".to_string())),
            "result": {
                "protocolVersion": CURRENT_PROTOCOL_VERSION,
                "previousProtocolVersion": PREVIOUS_PROTOCOL_VERSION,
                "codeApiVersion": CODE_API_VERSION,
                "catalogHash": DEFAULT_CATALOG_HASH,
                "generation": conn_id,
                "capabilities": negotiated_capabilities
            }
        });
        let Ok(bytes) = encode_content_length(&response) else {
            channel.detach_conn(&root, conn_id);
            return;
        };
        if write_half.write_all(&bytes).await.is_err() {
            channel.detach_conn(&root, conn_id);
            return;
        }
    }

    loop {
        tokio::select! {
            frame = outbound_rx.recv() => {
                match frame {
                    Some(bytes) => {
                        if write_half.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = read_wire_value(&mut reader, mode) => {
                let value = match incoming {
                    Ok(Some(value)) => value,
                    Ok(None) | Err(_) => break,
                };
                if !channel.is_current_connection(&root, conn_id) {
                    break;
                }
                if let Err(reason) = handle_authenticated_frame(
                    &channel,
                    &root,
                    conn_id,
                    mode,
                    value,
                ) {
                    log::warn!("codeserver broker frame rejected: {reason}");
                }
            }
        }
    }

    channel.detach_conn(&root, conn_id);
}

async fn read_wire_value<R>(reader: &mut R, mode: ProtocolMode) -> Result<Option<Value>, String>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    match mode {
        ProtocolMode::JsonRpc => read_content_length_value(reader).await,
        ProtocolMode::Legacy => loop {
            let mut line = String::new();
            let read = reader
                .read_line(&mut line)
                .await
                .map_err(|error| format!("read legacy broker frame: {error}"))?;
            if read == 0 {
                return Ok(None);
            }
            if line.len() > MAX_FRAME_BYTES {
                return Err(format!(
                    "legacy broker frame exceeds {MAX_FRAME_BYTES} bytes"
                ));
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            return serde_json::from_str(trimmed)
                .map(Some)
                .map_err(|error| format!("invalid legacy broker frame: {error}"));
        },
    }
}

fn authenticate_first_frame(
    channel: &AgentChannel,
    mode: ProtocolMode,
    value: Value,
) -> Result<AuthenticationSuccess, AuthenticationFailure> {
    match mode {
        ProtocolMode::Legacy => {
            let frame = serde_json::from_value::<InboundFrame>(value)
                .map_err(|error| (None, -32600, format!("invalid legacy hello: {error}")))?;
            let InboundFrame::Hello { token } = frame else {
                return Err((None, -32002, "authentication required".to_string()));
            };
            channel
                .root_for_legacy_token(&token)
                .map(|root| (root, None, Vec::new()))
                .ok_or_else(|| (None, -32002, "invalid broker token".to_string()))
        }
        ProtocolMode::JsonRpc => Err((
            value.get("id").cloned(),
            -32600,
            "JSON-RPC requires challenge authentication".to_string(),
        )),
    }
}

async fn authenticate_jsonrpc_handshake<R, W>(
    channel: &AgentChannel,
    reader: &mut R,
    writer: &mut W,
    challenge_request: Value,
) -> Result<AuthenticationSuccess, AuthenticationFailure>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let challenge_id = challenge_request.get("id").cloned();
    if challenge_request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || challenge_request.get("method").and_then(Value::as_str) != Some("cognia/auth/challenge")
        || challenge_id.is_none()
    {
        return Err((
            challenge_id,
            -32600,
            "first request must be cognia/auth/challenge".to_string(),
        ));
    }
    let token_id = challenge_request
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("tokenId"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                challenge_id.clone(),
                -32602,
                "challenge tokenId is required".to_string(),
            )
        })?;
    let credential = channel.credential_for_id(token_id).ok_or_else(|| {
        (
            challenge_id.clone(),
            -32002,
            "invalid broker token id".to_string(),
        )
    })?;
    let challenge = Uuid::new_v4().to_string();
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": challenge_id,
        "result": { "challenge": challenge }
    });
    let bytes = encode_content_length(&response).map_err(|message| (None, -32603, message))?;
    writer
        .write_all(&bytes)
        .await
        .map_err(|error| (None, -32603, format!("write broker challenge: {error}")))?;

    let hello = read_content_length_value(reader)
        .await
        .map_err(|message| (None, -32600, message))?
        .ok_or_else(|| (None, -32600, "connection closed before hello".to_string()))?;
    authenticate_jsonrpc_hello(channel, hello, token_id, &credential, &challenge)
}

fn authenticate_jsonrpc_hello(
    channel: &AgentChannel,
    value: Value,
    token_id: &str,
    challenged_credential: &BrokerCredential,
    challenge: &str,
) -> Result<AuthenticationSuccess, AuthenticationFailure> {
    let id = value.get("id").cloned();
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || value.get("method").and_then(Value::as_str) != Some("cognia/hello")
        || id.is_none()
    {
        return Err((
            id,
            -32600,
            "second request must be cognia/hello".to_string(),
        ));
    }
    let params = value
        .get("params")
        .and_then(Value::as_object)
        .ok_or_else(|| (id.clone(), -32602, "hello params are required".to_string()))?;
    if params.get("tokenId").and_then(Value::as_str) != Some(token_id) {
        return Err((id, -32002, "hello token id changed".to_string()));
    }
    let current = channel
        .credential_for_id(token_id)
        .filter(|current| {
            current.root == challenged_credential.root
                && current.secret == challenged_credential.secret
                && current.host_id == challenged_credential.host_id
        })
        .ok_or_else(|| {
            (
                id.clone(),
                -32002,
                "broker credential was revoked".to_string(),
            )
        })?;
    let proof = params
        .get("proof")
        .and_then(Value::as_str)
        .ok_or_else(|| (id.clone(), -32602, "hello proof is required".to_string()))?;
    verify_challenge_proof(&current.secret, challenge, proof)
        .map_err(|message| (id.clone(), -32002, message))?;

    let versions = params
        .get("protocolVersions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            (
                id.clone(),
                -32602,
                "protocolVersions are required".to_string(),
            )
        })?;
    if !versions
        .iter()
        .any(|version| version.as_str() == Some(CURRENT_PROTOCOL_VERSION))
    {
        return Err((
            id,
            -32001,
            format!(
                "no compatible broker protocol; host supports {CURRENT_PROTOCOL_VERSION} and {PREVIOUS_PROTOCOL_VERSION}"
            ),
        ));
    }
    if params.get("codeApiVersion").and_then(Value::as_str) != Some(CODE_API_VERSION) {
        return Err((
            id,
            -32001,
            format!("code API mismatch; expected {CODE_API_VERSION}"),
        ));
    }
    if params.get("catalogHash").and_then(Value::as_str) != Some(DEFAULT_CATALOG_HASH) {
        return Err((
            id,
            -32001,
            format!("capability catalog mismatch; expected {DEFAULT_CATALOG_HASH}"),
        ));
    }
    if params.get("hostId").and_then(Value::as_str) != Some(current.host_id.as_str()) {
        return Err((
            id,
            -32002,
            "hello host does not match token scope".to_string(),
        ));
    }
    let capabilities = params
        .get("capabilities")
        .and_then(Value::as_array)
        .ok_or_else(|| (id.clone(), -32602, "capabilities are required".to_string()))?
        .iter()
        .filter_map(Value::as_str)
        .filter(|capability| BROKER_CAPABILITIES.contains(capability))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(workspace) = params.get("workspace").and_then(Value::as_str) {
        if !workspace.is_empty() && workspace != current.root {
            return Err((
                id,
                -32002,
                "hello workspace does not match token scope".to_string(),
            ));
        }
    }
    Ok((current.root, id, capabilities))
}

fn verify_challenge_proof(secret: &str, challenge: &str, proof: &str) -> Result<(), String> {
    let proof = hex::decode(proof).map_err(|_| "invalid broker challenge proof".to_string())?;
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes())
        .map_err(|_| "invalid broker challenge secret".to_string())?;
    mac.update(challenge.as_bytes());
    mac.verify_slice(&proof)
        .map_err(|_| "invalid broker challenge proof".to_string())
}

fn handle_authenticated_frame(
    channel: &AgentChannel,
    root: &str,
    conn_id: u64,
    mode: ProtocolMode,
    value: Value,
) -> Result<(), String> {
    match mode {
        ProtocolMode::Legacy => {
            let frame = serde_json::from_value::<InboundFrame>(value)
                .map_err(|error| format!("invalid legacy frame: {error}"))?;
            match frame {
                InboundFrame::Hello { .. } => Ok(()),
                InboundFrame::Res {
                    id,
                    ok,
                    result,
                    error,
                } => {
                    let outcome = if ok {
                        Ok(result.unwrap_or(Value::Null))
                    } else {
                        Err(error.unwrap_or_else(|| "Pro IDE extension error".to_string()))
                    };
                    channel.resolve(root, conn_id, id, outcome);
                    Ok(())
                }
                InboundFrame::Evt { name, payload } => {
                    channel.forward_event(root, name, payload);
                    Ok(())
                }
            }
        }
        ProtocolMode::JsonRpc => {
            if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
                return Err("missing jsonrpc 2.0 marker".to_string());
            }
            if let Some(method) = value.get("method").and_then(Value::as_str) {
                match method {
                    "cognia/event" => {
                        let params = value.get("params").and_then(Value::as_object);
                        let name = params
                            .and_then(|params| params.get("name"))
                            .and_then(Value::as_str)
                            .ok_or_else(|| "event name is required".to_string())?;
                        let payload = params.and_then(|params| params.get("payload")).cloned();
                        channel.forward_event(root, name.to_string(), payload);
                        return Ok(());
                    }
                    "$/progress" => {
                        channel.forward_event(
                            root,
                            "brokerProgress".to_string(),
                            value.get("params").cloned(),
                        );
                        return Ok(());
                    }
                    "cognia/provider/cancel"
                    | "cognia/provider/approvalResponse"
                    | "cognia/protocol/cancel" => {
                        if value.get("id").is_some() {
                            return Err("broker control message must be a notification".to_string());
                        }
                        return channel.forward_broker_notification(
                            root,
                            conn_id,
                            method.to_string(),
                            value.get("params").cloned().unwrap_or(Value::Null),
                        );
                    }
                    _ => {
                        let id = value
                            .get("id")
                            .cloned()
                            .ok_or_else(|| format!("unsupported broker notification: {method}"))?;
                        return channel.forward_broker_request(
                            root,
                            conn_id,
                            id,
                            method.to_string(),
                            value.get("params").cloned().unwrap_or(Value::Null),
                        );
                    }
                }
            }
            if let Some(id) = value.get("id").and_then(Value::as_u64) {
                let outcome = if let Some(error) = value.get("error") {
                    let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603);
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Pro IDE extension error");
                    Err(format!("JSON-RPC {code}: {message}"))
                } else {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                };
                channel.resolve(root, conn_id, id, outcome);
                return Ok(());
            }
            Err("JSON-RPC frame has neither response nor method".to_string())
        }
    }
}

fn jsonrpc_error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = serde_json::json!({ "code": code, "message": message });
    if let Some(data) = data {
        error["data"] = data;
    }
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn is_connected(channel: &AgentChannel, root: &str) -> bool {
        channel.lock_registry().conns.contains_key(root)
    }

    fn insert_credential(channel: &AgentChannel, token_id: &str, secret: &str, root: &str) {
        channel.lock_registry().tokens.insert(
            token_id.to_string(),
            BrokerCredential {
                root: root.to_string(),
                secret: secret.to_string(),
                host_id: "local".to_string(),
            },
        );
    }

    fn split_credential(value: &str) -> (&str, &str) {
        value.split_once('.').expect("generated broker credential")
    }

    fn challenge_proof(secret: &str, challenge: &str) -> String {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(challenge.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    #[test]
    fn hello_frame_parses() {
        let frame: InboundFrame =
            serde_json::from_str(r#"{"type":"hello","token":"abc-123"}"#).unwrap();
        match frame {
            InboundFrame::Hello { token } => assert_eq!(token, "abc-123"),
            _ => panic!("expected hello"),
        }
    }

    #[test]
    fn res_frame_parses_success_and_failure() {
        let ok: InboundFrame =
            serde_json::from_str(r#"{"type":"res","id":7,"ok":true,"result":{"path":"/a"}}"#)
                .unwrap();
        match ok {
            InboundFrame::Res {
                id,
                ok,
                result,
                error,
            } => {
                assert_eq!(id, 7);
                assert!(ok);
                assert_eq!(result.unwrap()["path"], "/a");
                assert!(error.is_none());
            }
            _ => panic!("expected res"),
        }

        let err: InboundFrame =
            serde_json::from_str(r#"{"type":"res","id":8,"ok":false,"error":"nope"}"#).unwrap();
        match err {
            InboundFrame::Res { id, ok, error, .. } => {
                assert_eq!(id, 8);
                assert!(!ok);
                assert_eq!(error.as_deref(), Some("nope"));
            }
            _ => panic!("expected res"),
        }
    }

    #[test]
    fn unknown_frame_type_is_rejected() {
        assert!(serde_json::from_str::<InboundFrame>(r#"{"type":"bogus"}"#).is_err());
    }

    #[test]
    fn managed_agent_approval_response_is_a_one_way_broker_control_message() {
        let channel = AgentChannel::new();
        let frame = json!({
            "jsonrpc": "2.0",
            "method": "cognia/provider/approvalResponse",
            "params": {
                "invocationId": "invoke-1",
                "requestId": "approval-1",
                "pluginId": "acme.tools",
                "providerId": "cognia.acme.tools.assistant",
                "decision": "allow"
            }
        });
        let error = handle_authenticated_frame(
            &channel,
            "/work/project",
            7,
            ProtocolMode::JsonRpc,
            frame.clone(),
        )
        .unwrap_err();
        assert_eq!(error, "Cognia broker runtime is not attached");

        let mut request = frame;
        request["id"] = json!(1);
        let error = handle_authenticated_frame(
            &channel,
            "/work/project",
            7,
            ProtocolMode::JsonRpc,
            request,
        )
        .unwrap_err();
        assert_eq!(error, "broker control message must be a notification");
    }

    #[test]
    fn evt_frame_parses_with_and_without_a_payload() {
        let with: InboundFrame = serde_json::from_str(
            r#"{"type":"evt","name":"activeEditorChanged","payload":{"path":"/a.ts"}}"#,
        )
        .unwrap();
        match with {
            InboundFrame::Evt { name, payload } => {
                assert_eq!(name, "activeEditorChanged");
                assert_eq!(payload.unwrap()["path"], "/a.ts");
            }
            _ => panic!("expected evt"),
        }

        // No payload is legal — some events are pure signals.
        let without: InboundFrame =
            serde_json::from_str(r#"{"type":"evt","name":"documentSaved"}"#).unwrap();
        match without {
            InboundFrame::Evt { name, payload } => {
                assert_eq!(name, "documentSaved");
                assert!(payload.is_none());
            }
            _ => panic!("expected evt"),
        }
    }

    #[test]
    fn evt_frame_carries_no_request_id_to_correlate() {
        // Proves the event path can never consume a pending request: the frame has
        // no id to match one with.
        let raw = r#"{"type":"evt","name":"x","payload":null,"id":7}"#;
        let frame: InboundFrame = serde_json::from_str(raw).unwrap();
        assert!(matches!(frame, InboundFrame::Evt { .. }));
    }

    #[test]
    fn forwarding_an_event_without_an_app_handle_is_a_silent_no_op() {
        // Unit tests (and the window between process start and the first spawn) have
        // no AppHandle; a pushed event must not panic there.
        let channel = AgentChannel::new();
        channel.forward_event("/work/a", "activeEditorChanged".to_string(), None);
    }

    #[tokio::test]
    async fn an_unauthenticated_socket_cannot_inject_editor_events() {
        // An event the renderer trusts as "the editor said so" must come from a
        // socket that proved it is that editor.
        let channel = Arc::new(AgentChannel::new());
        let (port, _token) = channel.register_instance("/work/evt").await.unwrap();

        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"{\"type\":\"evt\",\"name\":\"activeEditorChanged\"}\n")
            .await
            .unwrap();

        // The server drops the connection on an unauthenticated evt, so the read half
        // reaches EOF instead of staying open.
        let mut lines = BufReader::new(stream).lines();
        let next = tokio::time::timeout(Duration::from_secs(2), lines.next_line())
            .await
            .expect("connection should have been closed promptly")
            .unwrap();
        assert!(next.is_none());
        assert!(!is_connected(&channel, "/work/evt"));
    }

    #[test]
    fn req_frame_serializes_to_the_documented_shape() {
        let frame = OutboundFrame::Req {
            id: 3,
            method: "openFile".to_string(),
            params: json!({ "path": "/x.ts", "line": 4 }),
        };
        let value: Value = serde_json::from_str(&serde_json::to_string(&frame).unwrap()).unwrap();
        assert_eq!(value["type"], "req");
        assert_eq!(value["id"], 3);
        assert_eq!(value["method"], "openFile");
        assert_eq!(value["params"]["path"], "/x.ts");
        assert_eq!(value["params"]["line"], 4);
    }

    #[test]
    fn register_instance_mints_a_token_mapped_to_the_root() {
        // Exercise the token-registry logic directly (no server bind): register a
        // token by hand, mirroring what `register_instance` does after the WS port
        // is known.
        let channel = AgentChannel::new();
        insert_credential(&channel, "tok-1", "secret", "/work/a");
        assert_eq!(
            channel.root_for_legacy_token("tok-1.secret").as_deref(),
            Some("/work/a")
        );
        assert_eq!(channel.root_for_legacy_token("tok-1.forged"), None);
        assert_eq!(channel.root_for_legacy_token("missing.secret"), None);
    }

    #[test]
    fn challenge_proofs_are_hmac_bound_and_constant_time_verified() {
        let proof = challenge_proof("secret", "nonce");
        verify_challenge_proof("secret", "nonce", &proof).unwrap();
        assert!(verify_challenge_proof("secret", "other", &proof).is_err());
        assert!(verify_challenge_proof("forged", "nonce", &proof).is_err());
        assert!(verify_challenge_proof("secret", "nonce", "not-hex").is_err());
    }

    #[test]
    fn deregister_drops_tokens_and_conns_for_a_root() {
        let channel = AgentChannel::new();
        insert_credential(&channel, "tok-a", "secret-a", "/work/a");
        insert_credential(&channel, "tok-b", "secret-b", "/work/b");
        // Attach a fake connection for /work/a.
        let (tx, _rx) = mpsc::channel::<Vec<u8>>(1);
        channel.attach_conn("/work/a", ProtocolMode::Legacy, tx);
        assert!(is_connected(&channel, "/work/a"));

        channel.deregister("/work/a");
        assert_eq!(channel.root_for_legacy_token("tok-a.secret-a"), None);
        assert!(!is_connected(&channel, "/work/a"));
        // Unrelated root untouched.
        assert_eq!(
            channel.root_for_legacy_token("tok-b.secret-b").as_deref(),
            Some("/work/b")
        );
    }

    #[test]
    fn detach_conn_only_evicts_the_matching_connection() {
        let channel = AgentChannel::new();
        let (tx1, _rx1) = mpsc::channel::<Vec<u8>>(1);
        let first = channel.attach_conn("/work/a", ProtocolMode::Legacy, tx1);
        // A reconnect replaces the entry with a fresh conn id.
        let (tx2, _rx2) = mpsc::channel::<Vec<u8>>(1);
        let second = channel.attach_conn("/work/a", ProtocolMode::Legacy, tx2);
        assert_ne!(first, second);

        // The stale first connection closing must NOT evict the live second one.
        channel.detach_conn("/work/a", first);
        assert!(is_connected(&channel, "/work/a"));

        // The current connection closing does evict.
        channel.detach_conn("/work/a", second);
        assert!(!is_connected(&channel, "/work/a"));
    }

    #[tokio::test]
    async fn waits_for_a_strictly_new_extension_host_generation() {
        let channel = Arc::new(AgentChannel::new());
        let (first_tx, _first_rx) = mpsc::channel::<Vec<u8>>(1);
        let first = channel.attach_conn("/work/reload", ProtocolMode::JsonRpc, first_tx);
        let waiter = {
            let channel = Arc::clone(&channel);
            tokio::spawn(async move {
                channel
                    .wait_for_new_generation("/work/reload", first, Duration::from_secs(1))
                    .await
            })
        };
        let (second_tx, _second_rx) = mpsc::channel::<Vec<u8>>(1);
        let second = channel.attach_conn("/work/reload", ProtocolMode::JsonRpc, second_tx);
        assert!(second > first);
        assert_eq!(waiter.await.unwrap().unwrap(), second);
    }

    #[test]
    fn resolve_fires_the_pending_responder_and_ignores_unknown_ids() {
        let channel = AgentChannel::new();
        let (tx, rx) = oneshot::channel();
        channel.lock_pending().insert(
            42,
            PendingRequest {
                root: "/work/a".to_string(),
                conn_id: 7,
                responder: tx,
            },
        );

        // Each binding dimension is independently load-bearing.
        channel.resolve("/work/a", 8, 42, Ok(json!({ "wrong_conn": true })));
        assert!(channel.lock_pending().contains_key(&42));
        channel.resolve("/work/b", 7, 42, Ok(json!({ "wrong_root": true })));
        assert!(channel.lock_pending().contains_key(&42));

        channel.resolve("/work/a", 7, 42, Ok(json!({ "ok": 1 })));
        assert_eq!(rx.blocking_recv().unwrap().unwrap()["ok"], 1);

        // Unknown id — no panic, no effect.
        channel.resolve("/work/a", 7, 999, Ok(Value::Null));
    }

    #[test]
    fn content_handles_are_scoped_integrity_checked_and_one_shot() {
        let channel = AgentChannel::new();
        let (tx, _rx) = mpsc::channel::<Vec<u8>>(1);
        let generation = channel.attach_conn("/work/a", ProtocolMode::JsonRpc, tx);
        let handle = channel
            .insert_content(
                "/work/a",
                generation,
                "acme",
                "cognia.acme.fs",
                Some("filesystem:write".to_string()),
                "application/octet-stream".to_string(),
                ContentDirection::ToRuntime,
                vec![1, 2, 3],
            )
            .unwrap();

        assert!(channel
            .redeem_content_handle(
                "/work/a",
                generation,
                "other",
                "cognia.acme.fs",
                Some("filesystem:write"),
                &handle.id,
            )
            .is_err());
        assert_eq!(
            channel
                .redeem_content_handle(
                    "/work/a",
                    generation,
                    "acme",
                    "cognia.acme.fs",
                    Some("filesystem:write"),
                    &handle.id,
                )
                .unwrap(),
            vec![1, 2, 3]
        );
        assert!(channel
            .redeem_content_handle(
                "/work/a",
                generation,
                "acme",
                "cognia.acme.fs",
                Some("filesystem:write"),
                &handle.id,
            )
            .unwrap_err()
            .contains("NOT_FOUND"));
    }

    #[tokio::test]
    async fn send_errors_when_no_extension_is_connected() {
        let channel = AgentChannel::new();
        let err = channel
            .send("/work/absent", "openFile", json!({}))
            .await
            .unwrap_err();
        assert!(err.contains("not connected"));
    }

    #[test]
    fn loopback_gate_accepts_localhost_and_rejects_public() {
        assert!(is_loopback(&SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            5555
        )));
        assert!(is_loopback(&SocketAddr::new(
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            5555
        )));
        assert!(!is_loopback(&SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)),
            5555
        )));
    }

    /// End-to-end over a real loopback socket: bind the server, connect a stand-in
    /// "extension", authenticate with `hello`, then prove a `send` request reaches
    /// the socket and its response is correlated back to the caller.
    #[tokio::test]
    async fn tcp_round_trip_delivers_a_request_and_returns_its_response() {
        let channel = Arc::new(AgentChannel::new());
        let (port, token) = channel.register_instance("/work/rt").await.unwrap();

        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(format!("{{\"type\":\"hello\",\"token\":\"{token}\"}}\n").as_bytes())
            .await
            .unwrap();

        // Wait until the server has bound this connection to the root.
        for _ in 0..100 {
            if is_connected(&channel, "/work/rt") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(is_connected(&channel, "/work/rt"));

        // Fire the request from the app side; the stand-in extension answers below.
        let client = Arc::clone(&channel);
        let request = tokio::spawn(async move {
            client
                .send("/work/rt", "openFile", json!({ "path": "/a.ts" }))
                .await
        });

        let (read_half, mut write_half) = stream.into_split();
        let mut lines = BufReader::new(read_half).lines();
        let line = lines.next_line().await.unwrap().unwrap();
        let frame: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(frame["type"], "req");
        assert_eq!(frame["method"], "openFile");
        assert_eq!(frame["params"]["path"], "/a.ts");
        let id = frame["id"].as_u64().unwrap();
        write_half
            .write_all(
                format!(
                    "{{\"type\":\"res\",\"id\":{id},\"ok\":true,\"result\":{{\"opened\":true}}}}\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        let result = request.await.unwrap().unwrap();
        assert_eq!(result["opened"], true);
    }

    #[tokio::test]
    async fn jsonrpc_round_trip_negotiates_and_correlates_a_request() {
        let channel = Arc::new(AgentChannel::new());
        let (port, token) = channel.register_instance("/work/rpc").await.unwrap();
        let (token_id, secret) = split_credential(&token);
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let challenge_request = json!({
            "jsonrpc": "2.0",
            "id": "challenge",
            "method": "cognia/auth/challenge",
            "params": { "tokenId": token_id }
        });
        stream
            .write_all(&encode_content_length(&challenge_request).unwrap())
            .await
            .unwrap();

        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let challenge_response = read_content_length_value(&mut reader)
            .await
            .unwrap()
            .unwrap();
        let challenge = challenge_response["result"]["challenge"].as_str().unwrap();
        let hello = json!({
            "jsonrpc": "2.0",
            "id": "hello",
            "method": "cognia/hello",
            "params": {
                "tokenId": token_id,
                "proof": challenge_proof(secret, challenge),
                "protocolVersions": ["1.0", "0.2"],
                "codeApiVersion": "1.128.0",
                "catalogHash": DEFAULT_CATALOG_HASH,
                "hostId": "local",
                "workspace": "/work/rpc",
                "capabilities": ["cancel", "structured-errors"]
            }
        });
        write_half
            .write_all(&encode_content_length(&hello).unwrap())
            .await
            .unwrap();

        let negotiated = read_content_length_value(&mut reader)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(negotiated["id"], "hello");
        assert_eq!(negotiated["result"]["protocolVersion"], "1.0");
        let generation = negotiated["result"]["generation"].as_u64().unwrap();
        assert!(generation > 0);

        let client = Arc::clone(&channel);
        let request =
            tokio::spawn(async move { client.send("/work/rpc", "readActive", json!({})).await });
        let outbound = read_content_length_value(&mut reader)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outbound["jsonrpc"], "2.0");
        assert_eq!(outbound["method"], "readActive");
        let id = outbound["id"].as_u64().unwrap();
        write_half
            .write_all(
                &encode_content_length(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "path": "/a.ts" }
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(request.await.unwrap().unwrap()["path"], "/a.ts");
    }

    #[tokio::test]
    async fn response_before_hello_cannot_consume_an_authenticated_request() {
        let channel = Arc::new(AgentChannel::new());
        let (port, token) = channel.register_instance("/work/auth").await.unwrap();

        let mut legitimate = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        legitimate
            .write_all(format!("{{\"type\":\"hello\",\"token\":\"{token}\"}}\n").as_bytes())
            .await
            .unwrap();
        for _ in 0..100 {
            if is_connected(&channel, "/work/auth") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let client = Arc::clone(&channel);
        let request =
            tokio::spawn(async move { client.send("/work/auth", "readActive", json!({})).await });
        let (read_half, mut legitimate_write) = legitimate.into_split();
        let mut lines = BufReader::new(read_half).lines();
        let line = tokio::time::timeout(Duration::from_secs(1), lines.next_line())
            .await
            .expect("authenticated request frame timed out")
            .unwrap()
            .unwrap();
        let id = serde_json::from_str::<Value>(&line).unwrap()["id"]
            .as_u64()
            .unwrap();

        let mut unauthenticated = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        unauthenticated
            .write_all(
                format!("{{\"type\":\"res\",\"id\":{id},\"ok\":true,\"result\":\"forged\"}}\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!request.is_finished());

        legitimate_write
            .write_all(
                format!("{{\"type\":\"res\",\"id\":{id},\"ok\":true,\"result\":\"real\"}}\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        assert_eq!(request.await.unwrap().unwrap(), json!("real"));
    }

    /// A connection presenting an unknown token is refused: the server never binds
    /// it, so a subsequent `send` for that root still reports "not connected".
    #[tokio::test]
    async fn tcp_connection_with_a_bad_token_is_refused() {
        let channel = Arc::new(AgentChannel::new());
        let (port, _token) = channel.register_instance("/work/bad").await.unwrap();

        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"{\"type\":\"hello\",\"token\":\"not-a-real-token\"}\n")
            .await
            .unwrap();

        // Give the server a beat to process (and reject) the hello.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!is_connected(&channel, "/work/bad"));
    }
}
