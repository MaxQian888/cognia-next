//! Loopback WebSocket control channel between the app and the companion VS Code
//! extension side-loaded into code-server (Pro IDE Phase 2 — agent↔IDE bidirectional).
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
//! # Topology
//!
//! There is exactly ONE loopback WS server per app (lazily bound to `127.0.0.1:0`).
//! Each spawned code-server instance is `register`ed here, minting a per-instance
//! CSPRNG token mapped to that instance's canonical project root. The token + the WS
//! port are injected into the code-server child's environment (`process.rs`); the
//! companion extension reads them, dials the WS, and sends a `hello { token }` frame.
//! The server maps the token back to the root and stores the connection, so
//! [`AgentChannel::send`] can address a request "to the editor serving root X".
//!
//! # Wire protocol (JSON text frames)
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
//! ```
//!
//! The envelope is method-generic: `openFile`, `applyEdit` and `readActive` all ride
//! the same frames, so new editor-control methods slot in without a protocol change.
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
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, OnceCell};
use uuid::Uuid;

/// How long a `send` waits for the extension to answer before giving up. The
/// caller (frontend bridge / agent tool) degrades gracefully on timeout — the
/// CLI open path and the disk-reload edit path remain available.
const AGENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Depth of a connection's outbound frame queue. Frames are tiny and infrequent
/// (one per agent editor action), so a small bound is plenty and still applies
/// backpressure rather than growing without limit.
const OUTBOUND_CHANNEL_CAPACITY: usize = 32;

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
    tx: mpsc::Sender<String>,
}

#[derive(Default)]
struct Registry {
    /// per-instance token → canonical project root.
    tokens: HashMap<String, String>,
    /// canonical project root → live extension connection.
    conns: HashMap<String, Conn>,
}

/// Sole owner of the loopback agent-control WS. See the module docs.
pub struct AgentChannel {
    port: OnceCell<u16>,
    registry: Mutex<Registry>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_request_id: AtomicU64,
    next_conn_id: AtomicU64,
}

impl AgentChannel {
    fn new() -> Self {
        Self {
            port: OnceCell::new(),
            registry: Mutex::new(Registry::default()),
            pending: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            next_conn_id: AtomicU64::new(1),
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
        let port = self.ensure_server().await?;
        let token = Uuid::new_v4().to_string();
        {
            let mut reg = self.lock_registry();
            reg.tokens.retain(|_, mapped_root| mapped_root != root);
            reg.conns.remove(root);
            reg.tokens.insert(token.clone(), root.to_string());
        }
        Ok((port, token))
    }

    /// Forget an instance (explicit stop / kill-switch): drop its token(s) and any
    /// live connection. Idempotent.
    pub fn deregister(&self, root: &str) {
        let mut reg = self.lock_registry();
        reg.tokens.retain(|_, mapped_root| mapped_root != root);
        reg.conns.remove(root);
    }

    /// Send `method` to the editor serving `root` and await its response. Errors
    /// when no extension is connected for that root (caller degrades to the CLI /
    /// disk-reload path) or the request times out.
    pub async fn send(&self, root: &str, method: &str, params: Value) -> Result<Value, String> {
        let tx = {
            let reg = self.lock_registry();
            reg.conns
                .get(root)
                .map(|conn| conn.tx.clone())
                .ok_or_else(|| "Pro IDE extension is not connected for this project".to_string())?
        };

        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (response_tx, response_rx) = oneshot::channel();
        self.lock_pending().insert(id, response_tx);

        let frame = OutboundFrame::Req {
            id,
            method: method.to_string(),
            params,
        };
        let text = serde_json::to_string(&frame).map_err(|e| format!("encode request: {e}"))?;
        if tx.send(text).await.is_err() {
            self.lock_pending().remove(&id);
            return Err("Pro IDE extension connection closed".to_string());
        }

        match tokio::time::timeout(AGENT_REQUEST_TIMEOUT, response_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.lock_pending().remove(&id);
                Err("Pro IDE extension dropped the request".to_string())
            }
            Err(_) => {
                self.lock_pending().remove(&id);
                Err("Pro IDE extension request timed out".to_string())
            }
        }
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
                let app = Router::new().route("/", get(ws_handler)).with_state(channel);
                tokio::spawn(async move {
                    let _ = axum::serve(
                        listener,
                        app.into_make_service_with_connect_info::<SocketAddr>(),
                    )
                    .await;
                });
                Ok::<u16, String>(addr.port())
            })
            .await?;
        Ok(*port)
    }

    /// Resolve the root a token was minted for. Returns `None` for an unknown or
    /// revoked token.
    fn root_for_token(&self, token: &str) -> Option<String> {
        self.lock_registry().tokens.get(token).cloned()
    }

    /// Attach a connection's outbound queue to `root`, returning the connection id
    /// so [`Self::detach_conn`] can avoid evicting a newer reconnect.
    fn attach_conn(&self, root: &str, tx: mpsc::Sender<String>) -> u64 {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        self.lock_registry()
            .conns
            .insert(root.to_string(), Conn { conn_id, tx });
        conn_id
    }

    /// Drop `root`'s connection only if it is still the one identified by
    /// `conn_id` (a later reconnect for the same root must survive this one's close).
    fn detach_conn(&self, root: &str, conn_id: u64) {
        let mut reg = self.lock_registry();
        if reg
            .conns
            .get(root)
            .is_some_and(|conn| conn.conn_id == conn_id)
        {
            reg.conns.remove(root);
        }
    }

    /// Fire the responder for a correlated response id. Unknown ids (already
    /// timed out) are a silent no-op.
    fn resolve(&self, id: u64, outcome: Result<Value, String>) {
        if let Some(responder) = self.lock_pending().remove(&id) {
            let _ = responder.send(outcome);
        }
    }

    fn lock_registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn lock_pending(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<Result<Value, String>>>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }
}

static AGENT_CHANNEL: Lazy<Arc<AgentChannel>> = Lazy::new(|| Arc::new(AgentChannel::new()));

/// The process-wide agent control channel.
pub fn global() -> Arc<AgentChannel> {
    Arc::clone(&AGENT_CHANNEL)
}

/// Whether a peer address is loopback. Extracted (and unit-tested) so the source
/// gate is provable without a live socket. The server binds `127.0.0.1` so this is
/// defence-in-depth against any future non-loopback bind.
fn is_loopback(addr: &SocketAddr) -> bool {
    addr.ip().is_loopback()
}

/// Axum handler: one task per extension connection. Rejects non-loopback peers,
/// authenticates the first `hello` frame against a minted token, then proxies
/// request/response frames.
async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(channel): State<Arc<AgentChannel>>,
) -> Response {
    if !is_loopback(&peer) {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, channel))
}

async fn handle_socket(mut socket: WebSocket, channel: Arc<AgentChannel>) {
    // The connection is unauthenticated until a valid `hello` lands, so nothing is
    // registered and no outbound queue exists yet.
    let mut bound: Option<(String, u64)> = None;
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(OUTBOUND_CHANNEL_CAPACITY);

    loop {
        tokio::select! {
            // App → extension: drain queued request frames onto the socket.
            frame = outbound_rx.recv() => {
                match frame {
                    Some(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            // Extension → app.
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<InboundFrame>(text.as_str()) {
                            Ok(InboundFrame::Hello { token }) => {
                                // Ignore a duplicate hello — the socket is already bound.
                                if bound.is_some() {
                                    continue;
                                }
                                match channel.root_for_token(&token) {
                                    Some(root) => {
                                        let conn_id = channel.attach_conn(&root, outbound_tx.clone());
                                        bound = Some((root, conn_id));
                                    }
                                    None => {
                                        // Unknown/revoked token — refuse the connection.
                                        break;
                                    }
                                }
                            }
                            Ok(InboundFrame::Res { id, ok, result, error }) => {
                                let outcome = if ok {
                                    Ok(result.unwrap_or(Value::Null))
                                } else {
                                    Err(error.unwrap_or_else(|| "Pro IDE extension error".to_string()))
                                };
                                channel.resolve(id, outcome);
                            }
                            Err(reason) => {
                                log::warn!("codeserver agent_channel: bad frame: {reason}");
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    if let Some((root, conn_id)) = bound {
        channel.detach_conn(&root, conn_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn is_connected(channel: &AgentChannel, root: &str) -> bool {
        channel.lock_registry().conns.contains_key(root)
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
            InboundFrame::Res {
                id, ok, error, ..
            } => {
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
        {
            let mut reg = channel.lock_registry();
            reg.tokens.insert("tok-1".to_string(), "/work/a".to_string());
        }
        assert_eq!(channel.root_for_token("tok-1").as_deref(), Some("/work/a"));
        assert_eq!(channel.root_for_token("missing"), None);
    }

    #[test]
    fn deregister_drops_tokens_and_conns_for_a_root() {
        let channel = AgentChannel::new();
        {
            let mut reg = channel.lock_registry();
            reg.tokens.insert("tok-a".to_string(), "/work/a".to_string());
            reg.tokens.insert("tok-b".to_string(), "/work/b".to_string());
        }
        // Attach a fake connection for /work/a.
        let (tx, _rx) = mpsc::channel::<String>(1);
        channel.attach_conn("/work/a", tx);
        assert!(is_connected(&channel, "/work/a"));

        channel.deregister("/work/a");
        assert_eq!(channel.root_for_token("tok-a"), None);
        assert!(!is_connected(&channel, "/work/a"));
        // Unrelated root untouched.
        assert_eq!(channel.root_for_token("tok-b").as_deref(), Some("/work/b"));
    }

    #[test]
    fn detach_conn_only_evicts_the_matching_connection() {
        let channel = AgentChannel::new();
        let (tx1, _rx1) = mpsc::channel::<String>(1);
        let first = channel.attach_conn("/work/a", tx1);
        // A reconnect replaces the entry with a fresh conn id.
        let (tx2, _rx2) = mpsc::channel::<String>(1);
        let second = channel.attach_conn("/work/a", tx2);
        assert_ne!(first, second);

        // The stale first connection closing must NOT evict the live second one.
        channel.detach_conn("/work/a", first);
        assert!(is_connected(&channel, "/work/a"));

        // The current connection closing does evict.
        channel.detach_conn("/work/a", second);
        assert!(!is_connected(&channel, "/work/a"));
    }

    #[test]
    fn resolve_fires_the_pending_responder_and_ignores_unknown_ids() {
        let channel = AgentChannel::new();
        let (tx, rx) = oneshot::channel();
        channel.lock_pending().insert(42, tx);

        channel.resolve(42, Ok(json!({ "ok": 1 })));
        assert_eq!(rx.blocking_recv().unwrap().unwrap()["ok"], 1);

        // Unknown id — no panic, no effect.
        channel.resolve(999, Ok(Value::Null));
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
}
