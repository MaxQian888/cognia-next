//! Bridge WebSocket — `GET /internal/bridge` (ADR-0059 W3, protocol v3).
//!
//! The headless Node brain connects here and becomes the data plane: the
//! companion bridges (`sync_bridge`, `desktop_messages_bridge`,
//! `desktop_writes_bridge`, and the MCP orchestration proxy) emit request
//! frames through [`SocketBridgeTransport`] instead of a Tauri `AppHandle`,
//! and the brain answers with `respond` frames that route back into the same
//! `resolve()` machinery the desktop WebView uses.
//!
//! This channel carries ONLY host-local bridge request/respond plus
//! lifecycle frames (`hello`/`hello_ack`/`ping`/`pong`/`token_refresh`).
//! All other server→brain events (`claude://message`, `a2ui://dispatch`,
//! `external-agent://*`, `connectors://webhook/<id>`) ride the existing
//! `/ws/events` via `EventBus::publish`.
//!
//! # Wire protocol (v1) — golden fixtures
//!
//! The frame shapes are frozen in `cli/src/serve/fixtures/bridge-frames.json`,
//! asserted byte-for-byte by both this module's tests (`include_str!`) and the
//! TS side (`cli/src/serve/protocol.test.ts`). Sync event payloads are
//! snake_case; messages/writes payloads are camelCase — byte-identical to the
//! desktop Tauri event payloads. Respond payloads are the Tauri
//! response-command args verbatim (camelCase `requestId`).
//!
//! # Connection lifecycle
//!
//! 1. The brain connects with its **service-scope** JWT (loopback-only,
//!    enforced by `require_device_jwt`); this handler additionally rejects
//!    non-service scopes before the upgrade.
//! 2. The brain must send `hello` within [`HELLO_TIMEOUT`]; the server
//!    validates `protocol == 1` and the account, replies `hello_ack`, and
//!    installs the connection as the process-wide socket bridge.
//! 3. Single-connection policy: a new brain connection replaces the old one
//!    (the old socket is closed). Disconnect clears the slot so pending
//!    bridge requests fail fast on their next emit.
//! 4. The server pings every [`HEARTBEAT_SECS`]; the brain's pongs carry an
//!    RSS gauge (`rssBytes`) surfaced to healthz/metrics.
//!
//! Storage follows the module-global-static idiom of `TLS_FINGERPRINT` /
//! `ADVERTISED_PORT` / `data_plane::install_headless_store` — a
//! `CompanionState` field would force-thread through its many constructors.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::{IntoResponse, Response},
};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tokio::time::{interval, Duration, Instant};

use super::bridge_transport::{BridgeRequestGuard, BridgeTransport, WebViewBridgeTransport};
use super::middleware::DeviceContext;
use super::SharedState;

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/// Bridge protocol version. Bumped only on breaking frame-shape changes;
/// mismatches close the socket with code 1002.
pub const BRIDGE_PROTOCOL_VERSION: u32 = 3;

/// How long the server waits for the brain's `hello` before closing 1002.
#[cfg(not(test))]
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const HELLO_TIMEOUT: Duration = Duration::from_millis(400);

/// Interval between server-sent protocol pings.
const HEARTBEAT_SECS: u64 = 25;

/// Maximum silence from the brain before the server closes the connection.
const IDLE_TIMEOUT_SECS: u64 = 90;

/// Upper bound on a single bridge frame. `respond` frames carry whole table
/// deltas (`sync_pull` of a large messages table), so this is far larger than
/// the events-WS cap. The route is service-scope + loopback-only, so the DoS
/// surface is the co-located brain process, not the network.
const MAX_BRIDGE_FRAME_BYTES: usize = 64 * 1024 * 1024;
const MAX_BRIDGE_QUEUE_FRAMES: usize = 64;
const MAX_BRIDGE_QUEUE_BYTES: usize = 64 * 1024 * 1024;
const MAX_BRIDGE_IN_FLIGHT: usize = 128;

/// WS close code for protocol errors (RFC 6455 §7.4.1).
const CLOSE_PROTOCOL_ERROR: u16 = 1002;

/// WS close code for policy violations (account mismatch).
const CLOSE_POLICY_VIOLATION: u16 = 1008;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/// One bridge WS frame. Tag values and field names are the wire contract —
/// see the golden fixtures. Unknown `type` tags fail to parse and are
/// logged + ignored by the socket loop, per the contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeFrame {
    /// brain → server, first frame after connect.
    Hello {
        v: u32,
        role: String,
        #[serde(rename = "brainVersion")]
        brain_version: String,
        protocol: u32,
        #[serde(rename = "accountId")]
        account_id: String,
        #[serde(default)]
        capabilities: Vec<String>,
        #[serde(rename = "catalogHash")]
        catalog_hash: String,
        #[serde(rename = "contractVersion")]
        contract_version: u32,
    },
    /// server → brain, reply to a valid `hello`.
    HelloAck {
        v: u32,
        #[serde(rename = "serverVersion")]
        server_version: String,
        protocol: u32,
        #[serde(rename = "accountId")]
        account_id: String,
        #[serde(rename = "catalogHash")]
        catalog_hash: String,
        #[serde(rename = "contractVersion")]
        contract_version: u32,
    },
    /// server → brain: a bridge request. `event` is the Tauri channel name;
    /// `payload` is byte-identical to the desktop event payload.
    Event {
        v: u32,
        event: String,
        payload: Value,
    },
    /// brain → server: the response-command args verbatim, routed by
    /// `command` to the matching bridge's `resolve()`.
    Respond {
        v: u32,
        command: String,
        payload: Value,
    },
    /// Keepalive (either direction).
    Ping { v: u32, ts: i64 },
    /// Keepalive reply; the brain's pongs carry its RSS gauge.
    Pong {
        v: u32,
        ts: i64,
        #[serde(rename = "rssBytes", default)]
        rss_bytes: u64,
        #[serde(rename = "lastFlushAt", default)]
        last_flush_at: i64,
    },
    /// server → brain: a re-minted service token (12h refresh, R8).
    TokenRefresh { v: u32, token: String },
    /// server → brain: an authenticated worker became available.
    WorkerAttach {
        v: u32,
        #[serde(rename = "connectionId")]
        connection_id: String,
        #[serde(rename = "hostRef")]
        host_ref: String,
        manifest: Value,
    },
    /// Bidirectional opaque Agent RPC v2 frame multiplexed by connection id.
    WorkerFrame {
        v: u32,
        #[serde(rename = "connectionId")]
        connection_id: String,
        frame: String,
    },
    /// server → brain: an authenticated worker attachment ended.
    WorkerDetach {
        v: u32,
        #[serde(rename = "connectionId")]
        connection_id: String,
        #[serde(rename = "hostRef")]
        host_ref: String,
        reason: String,
    },
}

// ---------------------------------------------------------------------------
// Socket transport
// ---------------------------------------------------------------------------

/// [`BridgeTransport`] that frames bridge requests onto the connected brain's
/// WebSocket. Created per-connection by the socket handler; the sender half
/// feeds the connection's outgoing pump.
pub struct SocketBridgeTransport {
    tx: mpsc::Sender<QueuedBridgeMessage>,
    conn_id: u64,
    queued_bytes: Arc<Semaphore>,
    in_flight: Arc<Semaphore>,
    disconnected: watch::Sender<bool>,
}

struct QueuedBridgeMessage {
    message: Message,
    _bytes: OwnedSemaphorePermit,
}

impl SocketBridgeTransport {
    fn new(tx: mpsc::Sender<QueuedBridgeMessage>, conn_id: u64) -> Arc<Self> {
        let (disconnected, _) = watch::channel(false);
        Arc::new(Self {
            tx,
            conn_id,
            queued_bytes: Arc::new(Semaphore::new(MAX_BRIDGE_QUEUE_BYTES)),
            in_flight: Arc::new(Semaphore::new(MAX_BRIDGE_IN_FLIGHT)),
            disconnected,
        })
    }

    /// Serialize and enqueue a frame. Fails when the connection is gone.
    fn send_frame(&self, frame: &BridgeFrame) -> Result<(), String> {
        if *self.disconnected.borrow() {
            return Err("brain bridge disconnected".to_string());
        }
        let text = serde_json::to_string(frame)
            .map_err(|e| format!("failed to serialize bridge frame: {e}"))?;
        let byte_count = u32::try_from(text.len())
            .map_err(|_| "brain bridge overloaded: frame exceeds queue budget".to_string())?;
        let bytes = Arc::clone(&self.queued_bytes)
            .try_acquire_many_owned(byte_count)
            .map_err(|_| "brain bridge overloaded: outgoing byte budget exhausted".to_string())?;
        self.tx
            .try_send(QueuedBridgeMessage {
                message: Message::Text(text.into()),
                _bytes: bytes,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    "brain bridge overloaded: outgoing frame queue is full".to_string()
                }
                mpsc::error::TrySendError::Closed(_) => "brain bridge disconnected".to_string(),
            })
    }

    fn mark_disconnected(&self) {
        self.disconnected.send_replace(true);
    }
}

impl BridgeTransport for SocketBridgeTransport {
    fn emit(&self, channel: &str, payload: Value) -> Result<(), String> {
        self.send_frame(&BridgeFrame::Event {
            v: BRIDGE_PROTOCOL_VERSION,
            event: channel.to_string(),
            payload,
        })
    }

    fn reserve_request(&self) -> Result<BridgeRequestGuard, String> {
        if *self.disconnected.borrow() {
            return Err("brain bridge disconnected".to_string());
        }
        let permit = Arc::clone(&self.in_flight)
            .try_acquire_owned()
            .map_err(|_| "brain bridge overloaded: in-flight request limit reached".to_string())?;
        Ok(BridgeRequestGuard::scoped(
            self.disconnected.subscribe(),
            permit,
        ))
    }

    fn kind(&self) -> &'static str {
        "socket"
    }
}

// ---------------------------------------------------------------------------
// Process-global connection slot
// ---------------------------------------------------------------------------

/// Metadata from the brain's `hello`, surfaced to healthz (R8).
#[derive(Debug, Clone, Serialize)]
pub struct BrainHello {
    pub brain_version: String,
    pub account_id: String,
    pub capabilities: Vec<String>,
    pub catalog_hash: String,
    pub contract_version: u32,
}

struct BridgeSlot {
    transport: Arc<SocketBridgeTransport>,
    /// Signals the owning socket task to shut down (single-connection
    /// replacement: the new connection closes the old).
    shutdown: watch::Sender<bool>,
    hello: BrainHello,
    /// Fake bridge ownership is scoped to one state in tests. Real brain
    /// sockets remain process-global and therefore have no owner.
    #[cfg(test)]
    test_owner: Option<usize>,
}

static CONN_COUNTER: AtomicU64 = AtomicU64::new(1);

static SOCKET_BRIDGE: Lazy<RwLock<Option<BridgeSlot>>> = Lazy::new(|| RwLock::new(None));

/// Readiness channel — `true` while a brain is connected and helloed.
/// The brain supervisor (R8) uses this as its readiness probe.
static READY: Lazy<(watch::Sender<bool>, watch::Receiver<bool>)> =
    Lazy::new(|| watch::channel(false));

/// Latest RSS gauge from the brain's pong frames (0 = unknown).
static BRAIN_RSS_BYTES: AtomicU64 = AtomicU64::new(0);
static BRAIN_LAST_FLUSH_AT: AtomicI64 = AtomicI64::new(0);

/// Install a new connection as the process-wide socket bridge, closing any
/// previous connection. Returns after the swap.
fn install_socket_bridge(
    transport: Arc<SocketBridgeTransport>,
    shutdown: watch::Sender<bool>,
    hello: BrainHello,
    _test_owner: Option<usize>,
) {
    let old = {
        let mut slot = SOCKET_BRIDGE.write();
        slot.replace(BridgeSlot {
            transport,
            shutdown,
            hello,
            #[cfg(test)]
            test_owner: _test_owner,
        })
    };
    if let Some(old) = old {
        log::info!("companion-api ws-bridge: replacing existing brain connection");
        old.transport.mark_disconnected();
        let _ = old.shutdown.send(true);
    }
    let _ = READY.0.send(true);
    super::ws_worker::announce_all_workers();
}

/// Clear the slot iff it is still owned by `conn_id` (a replaced connection
/// must not clear its successor's slot).
fn clear_socket_bridge_if(conn_id: u64) {
    let cleared = {
        let mut slot = SOCKET_BRIDGE.write();
        if slot
            .as_ref()
            .map(|s| s.transport.conn_id == conn_id)
            .unwrap_or(false)
        {
            slot.take();
            true
        } else {
            false
        }
    };
    if cleared {
        let _ = READY.0.send(false);
        BRAIN_RSS_BYTES.store(0, Ordering::SeqCst);
        BRAIN_LAST_FLUSH_AT.store(0, Ordering::SeqCst);
    }
}

/// The connected brain's transport, if any.
pub fn socket_bridge_transport() -> Option<Arc<SocketBridgeTransport>> {
    SOCKET_BRIDGE
        .read()
        .as_ref()
        .map(|s| Arc::clone(&s.transport))
}

/// Resolve the connected socket for one state. In production this is the
/// process-global brain; tests additionally prevent a state-scoped fake from
/// leaking into unrelated parallel cases.
pub(crate) fn socket_bridge_transport_for_state(
    _state: &SharedState,
) -> Option<Arc<SocketBridgeTransport>> {
    let slot = SOCKET_BRIDGE.read();
    #[cfg(test)]
    if slot
        .as_ref()
        .and_then(|slot| slot.test_owner)
        .is_some_and(|owner| owner != Arc::as_ptr(_state) as usize)
    {
        return None;
    }
    slot.as_ref().map(|slot| Arc::clone(&slot.transport))
}

/// Whether a brain is currently connected and helloed.
pub fn bridge_connected() -> bool {
    SOCKET_BRIDGE.read().is_some()
}

/// The connected brain's hello metadata (healthz).
pub fn brain_hello() -> Option<BrainHello> {
    SOCKET_BRIDGE.read().as_ref().map(|s| s.hello.clone())
}

/// Capability a brain must announce before it will answer a media read.
///
/// Adding a `respond` command does not change the command catalog, so the
/// catalog hash stays equal and an older brain connects to a newer server
/// perfectly happily. Without this check it then simply never answers a
/// `companion://session-media-request`, and the device waits out the full
/// timeout for a retryable 503 that describes nothing. The handshake already
/// carries capabilities; this reads them.
pub const MEDIA_CAPABILITY: &str = "media";

/// Whether the connected brain announced it can answer media reads.
///
/// `true` when no brain is connected: the desktop data plane answers media
/// through Tauri IPC and never consults this.
pub fn brain_serves_media() -> bool {
    SOCKET_BRIDGE
        .read()
        .as_ref()
        .map(|slot| {
            slot.hello
                .capabilities
                .iter()
                .any(|capability| capability == MEDIA_CAPABILITY)
        })
        .unwrap_or(true)
}

/// Subscribe to bridge readiness transitions (R8 brain supervisor probe).
pub fn subscribe_bridge_ready() -> watch::Receiver<bool> {
    READY.1.clone()
}

/// Latest RSS gauge from the brain's pongs — `0` when unknown/disconnected.
pub fn brain_rss_bytes() -> u64 {
    BRAIN_RSS_BYTES.load(Ordering::SeqCst)
}

/// Push a re-minted service token to the connected brain (R8, 12h refresh).
#[allow(dead_code)] // consumed by the brain supervisor (R8).
pub fn send_token_refresh(token: String) -> Result<(), String> {
    let slot = SOCKET_BRIDGE.read();
    match slot.as_ref() {
        Some(s) => s.transport.send_frame(&BridgeFrame::TokenRefresh {
            v: BRIDGE_PROTOCOL_VERSION,
            token,
        }),
        None => Err("no connected brain".to_string()),
    }
}

pub(crate) fn send_worker_attach(
    tenant_id: String,
    connection_id: String,
    host_ref: String,
    manifest: Value,
) -> Result<(), String> {
    send_worker_bridge_frame(
        &tenant_id,
        BridgeFrame::WorkerAttach {
            v: BRIDGE_PROTOCOL_VERSION,
            connection_id,
            host_ref,
            manifest,
        },
    )
}

pub(crate) fn send_worker_frame(
    tenant_id: String,
    connection_id: String,
    frame: String,
) -> Result<(), String> {
    send_worker_bridge_frame(
        &tenant_id,
        BridgeFrame::WorkerFrame {
            v: BRIDGE_PROTOCOL_VERSION,
            connection_id,
            frame,
        },
    )
}

pub(crate) fn send_worker_detach(
    tenant_id: String,
    connection_id: String,
    host_ref: String,
    reason: String,
) -> Result<(), String> {
    send_worker_bridge_frame(
        &tenant_id,
        BridgeFrame::WorkerDetach {
            v: BRIDGE_PROTOCOL_VERSION,
            connection_id,
            host_ref,
            reason,
        },
    )
}

fn send_worker_bridge_frame(tenant_id: &str, frame: BridgeFrame) -> Result<(), String> {
    let slot = SOCKET_BRIDGE.read();
    match slot.as_ref() {
        Some(slot) if slot.hello.account_id == tenant_id => slot.transport.send_frame(&frame),
        Some(_) => Err("worker tenant does not match the connected brain".to_string()),
        None => Err("no connected brain".to_string()),
    }
}

pub(crate) fn current_brain_account_id() -> Option<String> {
    SOCKET_BRIDGE
        .read()
        .as_ref()
        .map(|slot| slot.hello.account_id.clone())
}

// ---------------------------------------------------------------------------
// Transport resolution
// ---------------------------------------------------------------------------

/// Pick the bridge transport for a data-plane request: the connected brain
/// wins, then the desktop WebView, else an error the caller maps to 503.
///
/// ADR-0059 D3: the brain owns the data — the SQLite `AppStore` fallback is
/// handled separately by `data_plane::pick` (R4), not here.
pub fn resolve_bridge_transport(state: &SharedState) -> Result<Arc<dyn BridgeTransport>, String> {
    if let Some(socket) = socket_bridge_transport_for_state(state) {
        return Ok(socket);
    }
    if let Some(app) = state.app_handle.clone() {
        return Ok(Arc::new(WebViewBridgeTransport(app)));
    }
    Err("no bridge transport available (no connected brain, no WebView)".to_string())
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Axum handler for `GET /internal/bridge`.
///
/// `require_device_jwt` has already verified the JWT (and enforced loopback
/// for service scope); this handler additionally rejects non-service scopes —
/// a paired phone must never become the data plane.
pub async fn ws_bridge_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    request: axum::extract::Request,
) -> Response {
    let Some(ctx) = request.extensions().get::<DeviceContext>().cloned() else {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({
                "error": "missing_device_context",
                "message": "JWT middleware did not run"
            })),
        )
            .into_response();
    };
    if ctx.scope != "service" {
        return (
            axum::http::StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({
                "error": "service_scope_required",
                "message": "the bridge WS is reserved for the headless brain's service token"
            })),
        )
            .into_response();
    }

    ws.max_message_size(MAX_BRIDGE_FRAME_BYTES)
        .max_frame_size(MAX_BRIDGE_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, ctx.account_id))
}

/// Send a close frame with `code`/`reason`, ignoring transport errors.
async fn close_with(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_string().into(),
        })))
        .await;
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Drive one brain connection.
async fn handle_socket(mut socket: WebSocket, state: SharedState, account_id: String) {
    // ── 1. Await hello ───────────────────────────────────────────────────────
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, await_hello(&mut socket)).await {
        Ok(Some(hello)) => hello,
        Ok(None) => return, // socket closed / transport error mid-handshake
        Err(_) => {
            close_with(&mut socket, CLOSE_PROTOCOL_ERROR, "no hello within timeout").await;
            return;
        }
    };

    let BridgeFrame::Hello {
        protocol,
        account_id: hello_account,
        brain_version,
        capabilities,
        catalog_hash,
        contract_version,
        ..
    } = hello
    else {
        unreachable!("await_hello only returns Hello frames");
    };

    if protocol != BRIDGE_PROTOCOL_VERSION {
        close_with(
            &mut socket,
            CLOSE_PROTOCOL_ERROR,
            &format!(
                "unsupported bridge protocol {protocol} (server speaks {BRIDGE_PROTOCOL_VERSION})"
            ),
        )
        .await;
        return;
    }
    let contract = match super::command_manifest::headless_contract() {
        Ok(contract) => contract,
        Err(_) => {
            close_with(
                &mut socket,
                CLOSE_PROTOCOL_ERROR,
                "Headless contract unavailable",
            )
            .await;
            return;
        }
    };
    if catalog_hash != contract.catalog_hash() || contract_version != contract.schema_version() {
        super::metrics::record_contract_mismatch();
        close_with(
            &mut socket,
            CLOSE_PROTOCOL_ERROR,
            "Headless contract mismatch",
        )
        .await;
        return;
    }
    if hello_account != account_id {
        close_with(
            &mut socket,
            CLOSE_POLICY_VIOLATION,
            "hello accountId does not match the service token's account",
        )
        .await;
        return;
    }

    // ── 2. hello_ack ─────────────────────────────────────────────────────────
    let ack = BridgeFrame::HelloAck {
        v: BRIDGE_PROTOCOL_VERSION,
        server_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol: BRIDGE_PROTOCOL_VERSION,
        account_id: account_id.clone(),
        catalog_hash: contract.catalog_hash().to_string(),
        contract_version: contract.schema_version(),
    };
    let ack_text = match serde_json::to_string(&ack) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("companion-api ws-bridge: failed to serialize hello_ack: {e}");
            return;
        }
    };
    if socket.send(Message::Text(ack_text.into())).await.is_err() {
        return;
    }

    // ── 3. Install as the process-wide socket bridge ─────────────────────────
    let conn_id = CONN_COUNTER.fetch_add(1, Ordering::SeqCst);
    let (out_tx, mut out_rx) = mpsc::channel::<QueuedBridgeMessage>(MAX_BRIDGE_QUEUE_FRAMES);
    let transport = SocketBridgeTransport::new(out_tx, conn_id);
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    install_socket_bridge(
        Arc::clone(&transport),
        shutdown_tx,
        BrainHello {
            brain_version,
            account_id: account_id.clone(),
            capabilities,
            catalog_hash,
            contract_version,
        },
        None,
    );
    log::info!("companion-api ws-bridge: brain connected (conn {conn_id})");

    // ── 4. Pump loop ─────────────────────────────────────────────────────────
    let mut hb_ticker = interval(Duration::from_secs(HEARTBEAT_SECS));
    hb_ticker.tick().await; // consume the immediate first tick
    let idle_timeout = Duration::from_secs(IDLE_TIMEOUT_SECS);
    let mut last_brain_activity = Instant::now();

    loop {
        tokio::select! {
            // Outgoing frame (bridge emit / token refresh).
            out = out_rx.recv() => {
                match out {
                    Some(queued) => {
                        if socket.send(queued.message).await.is_err() {
                            break;
                        }
                    }
                    None => break, // transport dropped — should not happen while installed
                }
            }

            // Incoming frame from the brain.
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        last_brain_activity = Instant::now();
                        handle_brain_frame(&state, text.as_str(), &transport, &account_id);
                    }
                    Some(Ok(Message::Ping(data))) => {
                        last_brain_activity = Instant::now();
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {
                        last_brain_activity = Instant::now();
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {} // binary frames ignored
                    Some(Err(_)) => break,
                }
            }

            // Replaced by a newer brain connection.
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    close_with(&mut socket, CLOSE_POLICY_VIOLATION, "replaced by a newer brain connection").await;
                    break;
                }
            }

            // Heartbeat.
            _ = hb_ticker.tick() => {
                if last_brain_activity.elapsed() > idle_timeout {
                    log::warn!("companion-api ws-bridge: brain idle timeout, closing");
                    break;
                }
                let ping = BridgeFrame::Ping { v: BRIDGE_PROTOCOL_VERSION, ts: now_ms() };
                match serde_json::to_string(&ping) {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => log::warn!("companion-api ws-bridge: failed to serialize ping: {e}"),
                }
            }
        }
    }

    transport.mark_disconnected();
    clear_socket_bridge_if(conn_id);
    log::info!("companion-api ws-bridge: brain disconnected (conn {conn_id})");
}

/// Read frames until the first `hello`. Non-hello frames before the handshake
/// are logged and ignored. Returns `None` when the socket closes first.
async fn await_hello(socket: &mut WebSocket) -> Option<BridgeFrame> {
    loop {
        match socket.recv().await? {
            Ok(Message::Text(text)) => match serde_json::from_str::<BridgeFrame>(text.as_str()) {
                Ok(frame @ BridgeFrame::Hello { .. }) => return Some(frame),
                Ok(other) => {
                    log::debug!(
                        "companion-api ws-bridge: ignoring pre-hello frame: {:?}",
                        std::mem::discriminant(&other)
                    );
                }
                Err(e) => {
                    log::debug!("companion-api ws-bridge: unparseable pre-hello frame: {e}");
                }
            },
            Ok(Message::Close(_)) => return None,
            Ok(_) => {}
            Err(_) => return None,
        }
    }
}

/// Dispatch one parsed brain→server frame.
fn handle_brain_frame(
    state: &SharedState,
    text: &str,
    transport: &SocketBridgeTransport,
    account_id: &str,
) {
    let frame = match serde_json::from_str::<BridgeFrame>(text) {
        Ok(f) => f,
        Err(e) => {
            log::debug!("companion-api ws-bridge: ignoring unparseable frame: {e}");
            return;
        }
    };
    match frame {
        BridgeFrame::Respond {
            command, payload, ..
        } => route_respond(state, &command, payload),
        BridgeFrame::Pong {
            rss_bytes,
            last_flush_at,
            ..
        } => {
            BRAIN_RSS_BYTES.store(rss_bytes, Ordering::SeqCst);
            BRAIN_LAST_FLUSH_AT.store(last_flush_at, Ordering::SeqCst);
        }
        BridgeFrame::Ping { ts, .. } => {
            let _ = transport.send_frame(&BridgeFrame::Pong {
                v: BRIDGE_PROTOCOL_VERSION,
                ts,
                rss_bytes: 0,
                last_flush_at: 0,
            });
        }
        BridgeFrame::WorkerFrame {
            connection_id,
            frame,
            ..
        } => {
            if let Err(error) = super::ws_worker::send_to_worker(account_id, &connection_id, frame)
            {
                log::debug!("companion-api ws-bridge: worker frame rejected: {error}");
            }
        }
        BridgeFrame::Hello { .. } => {
            log::debug!("companion-api ws-bridge: ignoring duplicate hello");
        }
        other => {
            log::debug!(
                "companion-api ws-bridge: ignoring unexpected brain frame: {:?}",
                std::mem::discriminant(&other)
            );
        }
    }
}

fn resolve_orchestration_response(payload: Value) -> Result<(), String> {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "missing orchestration response id".to_string())?
        .to_string();
    let reply =
        serde_json::from_value::<crate::mcp_server::orchestration_proxy::OrchestrationReply>(
            payload,
        )
        .map_err(|error| error.to_string())?;
    let services = crate::headless::headless_services()
        .ok_or_else(|| "headless services are unavailable".to_string())?;
    services.mcp_server.resolve_orchestration_reply(&id, reply);
    Ok(())
}

/// Route a `respond` frame to the matching bridge's `resolve()`. All
/// resolvers are no-op-safe for unknown / timed-out request ids.
/// Decode one `companion_media_response` payload.
///
/// Typed fields rather than a header bag: Tauri normalizes header case and a
/// JSON object does not, so mirroring "headers" across the two transports
/// would let casing drift turn into a silent miss on one of them. Validation
/// itself is shared with the desktop path
/// (`desktop_messages_bridge::media_response_from_parts`).
fn media_response_from_payload(
    payload: Value,
) -> Result<super::desktop_messages_bridge::MediaBridgeResponse, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let encoded = payload
        .get("bodyBase64")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // Refuse on the ENCODED length first. Decoding to find out how big it is
    // would mean allocating the very thing the cap exists to refuse, and
    // base64 never shrinks its input.
    if encoded.len() > super::desktop_messages_bridge::MAX_MEDIA_BYTES * 4 / 3 + 4 {
        return Err(format!("media body too large ({} encoded bytes)", encoded.len()));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("media body is not valid base64: {error}"))?;
    super::desktop_messages_bridge::media_response_from_parts(
        request_id,
        bytes,
        payload
            .get("mediaType")
            .and_then(Value::as_str)
            .map(str::to_owned),
        payload.get("etag").and_then(Value::as_str).map(str::to_owned),
        payload
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned),
    )
}

fn route_respond(state: &SharedState, command: &str, payload: Value) {
    match command {
        "companion_sync_pull_response" => {
            match serde_json::from_value::<super::sync_bridge::SyncPullResponse>(payload) {
                Ok(response) => state.sync_bridge.resolve(response),
                Err(e) => log::warn!("companion-api ws-bridge: bad sync respond payload: {e}"),
            }
        }
        "companion_message_response" => {
            match serde_json::from_value::<super::desktop_messages_bridge::MessageBridgeResponse>(
                payload,
            ) {
                Ok(response) => state.desktop_messages_bridge.resolve(response),
                Err(e) => log::warn!("companion-api ws-bridge: bad message respond payload: {e}"),
            }
        }
        "companion_desktop_write_response" => {
            match serde_json::from_value::<super::desktop_writes_bridge::DesktopWriteResponse>(
                payload,
            ) {
                Ok(response) => state.desktop_writes_bridge.resolve(response),
                Err(e) => log::warn!("companion-api ws-bridge: bad write respond payload: {e}"),
            }
        }
        // The arm this whole path was missing. `respondSessionMedia` has always
        // emitted this command, and without a match here every frame it sent
        // hit the `other =>` warning below and was dropped, so the oneshot in
        // `pending_media` never resolved and `GET /api/sessions/{id}/media/…`
        // timed out on every headless host.
        //
        // Bytes ride as base64 in an ordinary `respond` payload because the v3
        // frame set is JSON text only (see the `Message::Binary` arm above,
        // which ignores binary), and a payload capped at 10 MB inflates to
        // ~13.4 MB against a 64 MB frame ceiling.
        "companion_media_response" => {
            match media_response_from_payload(payload) {
                Ok(response) => state.desktop_messages_bridge.resolve_media(response),
                Err(error) => {
                    log::warn!("companion-api ws-bridge: bad media respond payload: {error}")
                }
            }
        }
        "companion_host_state_publish" => {
            let topic = payload.get("topic").and_then(Value::as_str);
            let event = payload.get("event").cloned();
            match (topic, event) {
                (Some("host-state://action"), Some(event)) => {
                    state
                        .event_bus
                        .publish("host-state://action".to_string(), event);
                }
                _ => log::warn!("companion-api ws-bridge: bad HostState publish payload"),
            }
        }
        // ADR-0131 cross-shell inbox relay — the headless brain has no Tauri
        // runtime, so it cannot `emit` onto the event bus the way the desktop
        // webview does (`lib/companion/host-event-publisher.ts`). It pipes
        // host events through here instead.
        //
        // The topic is checked against a CLOSED allowlist rather than passed
        // through: `route_respond` runs on an authenticated bridge, but the
        // bridge peer is the brain process, and letting it name arbitrary
        // topics would let a compromised brain publish e.g.
        // `host-state://action` frames that clients treat as authoritative.
        // Push topics carry ids only; authenticated foreground WS topics may
        // carry the full approval or remote-step request.
        "companion_event_publish" => {
            const ALLOWED_TOPICS: &[&str] = &[
                "sync://invalidate",
                "connector://message-added",
                "workflow://run-status",
                "workflow://run-terminal",
                "workflow://approval-request",
                "workflow://approval-resolved",
                "workflow://approval-pending",
                "workflow://step-execute",
                "workflow://step-pending",
                "thread-handoff://offer",
                // The brain runs host-owned external agents for clients that
                // cannot spawn one; this is the only way that turn reaches the
                // client that asked for it.
                "external-agent://session-event",
            ];
            let topic = payload.get("topic").and_then(Value::as_str);
            let event = payload.get("event").cloned();
            match (topic, event) {
                (Some(topic), Some(event)) if ALLOWED_TOPICS.contains(&topic) => {
                    state.event_bus.publish(topic.to_string(), event);
                }
                (Some(topic), _) => {
                    log::warn!(
                        "companion-api ws-bridge: refusing to publish disallowed topic {topic:?}"
                    );
                }
                _ => log::warn!("companion-api ws-bridge: bad event publish payload"),
            }
        }
        "orchestration_proxy_response" => {
            if let Err(error) = resolve_orchestration_response(payload) {
                log::warn!("companion-api ws-bridge: bad orchestration respond payload: {error}");
            }
        }
        "companion_perf_frame" => {
            let device_id = payload
                .get("deviceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let event = payload
                .get("event")
                .and_then(Value::as_str)
                .filter(|value| *value == "perf://frame");
            let frame = payload.get("frame").cloned();
            match (device_id, event, frame) {
                (Some(device_id), Some(event), Some(frame)) => {
                    state.event_bus.publish_ephemeral_to(
                        event.to_string(),
                        frame,
                        device_id.to_string(),
                    );
                }
                _ => log::warn!("companion-api ws-bridge: bad performance frame payload"),
            }
        }
        other => {
            log::warn!("companion-api ws-bridge: unknown respond command {other:?}, ignoring");
        }
    }
}

// ---------------------------------------------------------------------------
// Test support (shared with sibling modules' tests)
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub(crate) struct TestBridgeReceiver {
        rx: mpsc::Receiver<QueuedBridgeMessage>,
    }

    impl TestBridgeReceiver {
        pub(crate) async fn recv(&mut self) -> Option<Message> {
            self.rx.recv().await.map(|queued| queued.message)
        }

        pub(crate) fn try_recv(&mut self) -> Result<Message, mpsc::error::TryRecvError> {
            self.rx.try_recv().map(|queued| queued.message)
        }
    }

    /// The socket-bridge slot is process-global; every test (in ANY module)
    /// that installs, clears, or asserts on it must hold this lock so
    /// parallel test threads don't steal each other's slot. tokio's `Mutex`
    /// (not std/parking_lot) because guards are held across await points for
    /// whole test bodies.
    pub(crate) static GLOBAL_SLOT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    pub(crate) async fn lock_slot() -> tokio::sync::MutexGuard<'static, ()> {
        GLOBAL_SLOT_LOCK.lock().await
    }

    /// Install a fake connected brain into the process-global slot without a
    /// real WebSocket. Returns the receiver of the outgoing frame queue so
    /// the test can assert on emitted frames. Hold the slot lock first.
    pub(crate) fn install_socket_for_testing(state: &SharedState) -> TestBridgeReceiver {
        let (tx, rx) = mpsc::channel::<QueuedBridgeMessage>(MAX_BRIDGE_QUEUE_FRAMES);
        let conn_id = CONN_COUNTER.fetch_add(1, Ordering::SeqCst);
        let transport = SocketBridgeTransport::new(tx, conn_id);
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        install_socket_bridge(
            transport,
            shutdown_tx,
            BrainHello {
                brain_version: "0.0.0-test".to_string(),
                account_id: "local_acct_a".to_string(),
                capabilities: Vec::new(),
                catalog_hash: crate::companion_api::command_manifest::headless_contract()
                    .expect("embedded contract")
                    .catalog_hash()
                    .to_string(),
                contract_version: crate::companion_api::command_manifest::headless_contract()
                    .expect("embedded contract")
                    .schema_version(),
            },
            Some(Arc::as_ptr(state) as usize),
        );
        TestBridgeReceiver { rx }
    }

    /// Clear the slot regardless of owner. Hold the slot lock first.
    pub(crate) fn clear_socket_for_testing() {
        SOCKET_BRIDGE.write().take();
        let _ = READY.0.send(false);
        BRAIN_RSS_BYTES.store(0, Ordering::SeqCst);
        BRAIN_LAST_FLUSH_AT.store(0, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::test_support::lock_slot;
    use super::*;
    use crate::companion_api::{
        deny_list::DenyList,
        event_bus::EventBus,
        idempotency::IdempotencyCache,
        jwt::{issue_device_jwt, issue_service_jwt},
        middleware, push, rate_limit,
        sync_bridge::SyncBridge,
        sync_registry::SyncTableRegistry,
        CompanionState,
    };
    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use std::net::SocketAddr;
    use tokio_tungstenite::tungstenite::{
        client::IntoClientRequest, http::Request, Message as WsMessage,
    };

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";

    fn test_state() -> SharedState {
        Arc::new(CompanionState {
            secret: parking_lot::RwLock::new(SECRET.to_vec()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: SyncTableRegistry::with_defaults(),
            rate_limiter: rate_limit::RateLimiter::with_defaults(),
            push_tokens: push::PushTokenRegistry::new(),
        })
    }

    /// Bind the bridge route on an ephemeral loopback port. Uses
    /// `into_make_service_with_connect_info` so the middleware sees the peer
    /// address (service tokens are loopback-gated).
    async fn serve_bridge(state: SharedState) -> SocketAddr {
        let router = axum::Router::new()
            .route(
                "/internal/bridge",
                axum::routing::any(super::ws_bridge_handler),
            )
            .layer(axum::middleware::from_fn_with_state(
                Arc::clone(&state),
                middleware::require_device_jwt,
            ))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        addr
    }

    fn service_token() -> String {
        let (token, _exp) = issue_service_jwt(SECRET, ACCOUNT_ID).expect("issue service jwt");
        token
    }

    type WsClient = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    fn authorized_request(addr: SocketAddr, token: &str) -> Request<()> {
        let request = format!("ws://{addr}/internal/bridge?token={token}")
            .into_client_request()
            .expect("valid bridge URL");
        request
    }

    async fn connect(addr: SocketAddr, token: &str) -> WsClient {
        let (ws, _resp) = tokio_tungstenite::connect_async(authorized_request(addr, token))
            .await
            .expect("ws connect");
        ws
    }

    fn hello_frame() -> String {
        let contract =
            crate::companion_api::command_manifest::headless_contract().expect("embedded contract");
        serde_json::to_string(&json!({
            "v": BRIDGE_PROTOCOL_VERSION, "type": "hello", "role": "brain", "brainVersion": "0.0.0-test",
            "protocol": BRIDGE_PROTOCOL_VERSION, "accountId": ACCOUNT_ID,
            "capabilities": ["sync", "messages", "writes"],
            "catalogHash": contract.catalog_hash(),
            "contractVersion": contract.schema_version()
        }))
        .unwrap()
    }

    /// Send hello, read frames until hello_ack (skipping pings).
    async fn handshake(ws: &mut WsClient) -> Value {
        ws.send(WsMessage::Text(hello_frame().into()))
            .await
            .expect("send hello");
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .expect("hello_ack timeout")
                .expect("socket closed before hello_ack")
                .expect("ws frame err");
            if let WsMessage::Text(text) = msg {
                let v: Value = serde_json::from_str(text.as_str()).expect("parse frame");
                if v["type"] == "hello_ack" {
                    return v;
                }
            }
        }
    }

    /// Wait until the global slot reports connected (the handler installs it
    /// right after sending hello_ack, so one ack read is almost enough — poll
    /// to be robust).
    async fn wait_connected() {
        for _ in 0..100 {
            if bridge_connected() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("bridge never reported connected");
    }

    async fn wait_disconnected() {
        for _ in 0..100 {
            if !bridge_connected() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("bridge never reported disconnected");
    }

    // ── Golden fixtures — the cross-language wire contract ────────────────────

    #[test]
    fn golden_fixtures_roundtrip_through_the_frame_enum() {
        let raw = include_str!("../../../cli/src/serve/fixtures/bridge-frames.json");
        let fixture: Value = serde_json::from_str(raw).expect("fixture parses");
        assert_eq!(
            fixture["protocol"], BRIDGE_PROTOCOL_VERSION,
            "fixture protocol matches the server"
        );

        let frames = fixture["frames"].as_object().expect("frames object");
        assert!(!frames.is_empty(), "fixture has frames");
        for (name, frame_value) in frames {
            let frame: BridgeFrame = serde_json::from_value(frame_value.clone())
                .unwrap_or_else(|e| panic!("fixture frame {name} must parse: {e}"));
            let reserialized =
                serde_json::to_value(&frame).unwrap_or_else(|e| panic!("reserialize {name}: {e}"));
            assert_eq!(
                &reserialized, frame_value,
                "fixture frame {name} must roundtrip byte-identically"
            );
        }
    }

    #[test]
    fn golden_respond_payloads_parse_into_the_bridge_response_structs() {
        let raw = include_str!("../../../cli/src/serve/fixtures/bridge-frames.json");
        let fixture: Value = serde_json::from_str(raw).expect("fixture parses");
        let frames = &fixture["frames"];

        let sync: crate::companion_api::sync_bridge::SyncPullResponse =
            serde_json::from_value(frames["respondSyncPull"]["payload"].clone())
                .expect("sync respond payload parses (camelCase requestId alias)");
        assert_eq!(sync.request_id, "11111111-1111-4111-8111-111111111111");

        let msg: crate::companion_api::desktop_messages_bridge::MessageBridgeResponse =
            serde_json::from_value(frames["respondMessage"]["payload"].clone())
                .expect("message respond payload parses");
        assert_eq!(msg.request_id, "33333333-3333-4333-8333-333333333333");

        let write: crate::companion_api::desktop_writes_bridge::DesktopWriteResponse =
            serde_json::from_value(frames["respondDesktopWrite"]["payload"].clone())
                .expect("write respond payload parses");
        assert_eq!(write.request_id, "22222222-2222-4222-8222-222222222222");
        assert!(write.error.is_some());

        // The frame that had no arm. `respondSessionMedia` was always emitted
        // by the brain and always dropped here, so every attachment read on a
        // headless host timed out after thirty seconds.
        let media = media_response_from_payload(frames["respondSessionMedia"]["payload"].clone())
            .expect("media respond payload parses");
        assert_eq!(media.request_id, "33333333-3333-4333-8333-333333333333");
        assert_eq!(media.bytes, b"cognia");
        assert_eq!(media.media_type, "image/png");
        assert_eq!(media.etag.as_deref(), Some("\"deadbeef:canonical\""));
        assert!(media.error.is_none());
    }

    /// Every `respond` command the brain can emit must have an arm here.
    ///
    /// This is the gate the media bug got through. `respondSessionMedia` was
    /// emitted by the brain for as long as the feature existed and `route_respond`
    /// never matched it, so the frame hit the `other =>` warning, the oneshot in
    /// `pending_media` was never resolved, and the read timed out. Nothing failed:
    /// not the catalog parity test, not the AsyncAPI frame-set check, because both
    /// describe frame *types* and this is a `command` inside one type.
    ///
    /// The golden fixture is the cross-language list of what the brain sends, so
    /// scanning this file's own `route_respond` for each of its respond commands
    /// closes the loop without a second hand-kept table.
    #[test]
    fn every_respond_command_in_the_golden_fixture_has_a_route_arm() {
        let source = include_str!("ws_bridge.rs");
        let routing = source
            .split_once("fn route_respond(")
            .expect("route_respond exists")
            .1;
        let body = routing.split_once("\n}").expect("route_respond has a body").0;

        let raw = include_str!("../../../cli/src/serve/fixtures/bridge-frames.json");
        let fixture: Value = serde_json::from_str(raw).expect("fixture parses");

        let mut unrouted: Vec<String> = Vec::new();
        let mut scanned = 0usize;
        for frame in fixture["frames"]
            .as_object()
            .expect("frames is an object")
            .values()
        {
            if frame["type"].as_str() != Some("respond") {
                continue;
            }
            let command = frame["command"].as_str().expect("respond frames name a command");
            scanned += 1;
            if !body.contains(&format!("\"{command}\"")) {
                unrouted.push(command.to_string());
            }
        }
        // An empty `unrouted` also describes a walk that saw nothing, which is
        // what a renamed fixture key or a changed `route_respond` signature
        // would silently produce.
        assert!(
            scanned >= 4,
            "expected at least the four known respond fixtures, scanned {scanned}"
        );
        assert!(
            unrouted.is_empty(),
            "respond commands the brain sends with no arm in route_respond: {unrouted:?}. \
             A frame with no arm is logged and dropped, so whatever awaits it hangs."
        );
    }

    #[test]
    fn media_payloads_are_refused_before_they_can_allocate_or_mislead() {
        // Oversize is judged on the ENCODED length. Decoding first to measure
        // it would allocate exactly what the cap exists to refuse.
        let huge = "A".repeat(super::super::desktop_messages_bridge::MAX_MEDIA_BYTES * 2);
        let err = media_response_from_payload(serde_json::json!({
            "requestId": "r1",
            "bodyBase64": huge,
        }))
        .expect_err("an oversized body is refused");
        assert!(err.contains("too large"), "{err}");

        let err = media_response_from_payload(serde_json::json!({
            "requestId": "r1",
            "bodyBase64": "not base64!!",
        }))
        .expect_err("a malformed body is refused rather than silently emptied");
        assert!(err.contains("base64"), "{err}");

        // A missing request id cannot resolve anything, so it is an error and
        // not a response addressed to nobody.
        assert!(media_response_from_payload(serde_json::json!({ "bodyBase64": "" })).is_err());

        // An error-only answer keeps its error and carries no bytes.
        let denied = media_response_from_payload(serde_json::json!({
            "requestId": "r1",
            "bodyBase64": "",
            "error": "MEDIA_NOT_FOUND",
        }))
        .expect("an error answer parses");
        assert!(denied.bytes.is_empty());
        assert_eq!(denied.error.as_deref(), Some("MEDIA_NOT_FOUND"));
    }

    // ── Handshake ─────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn device_scope_token_is_rejected_before_upgrade() {
        let _guard = lock_slot().await;
        let state = test_state();
        let addr = serve_bridge(state).await;
        let device = issue_device_jwt(SECRET, "phone-1", ACCOUNT_ID).expect("device jwt");
        let result = tokio_tungstenite::connect_async(authorized_request(addr, &device)).await;
        assert!(
            result.is_err(),
            "device-scope token must not open the bridge"
        );
    }

    #[tokio::test]
    async fn hello_gets_hello_ack_and_installs_the_slot() {
        let _guard = lock_slot().await;
        let state = test_state();
        let addr = serve_bridge(state).await;
        let mut ws = connect(addr, &service_token()).await;

        let ack = handshake(&mut ws).await;
        assert_eq!(ack["v"], BRIDGE_PROTOCOL_VERSION);
        assert_eq!(ack["protocol"], BRIDGE_PROTOCOL_VERSION);
        assert_eq!(ack["accountId"], ACCOUNT_ID);
        assert!(ack["serverVersion"].as_str().is_some_and(|s| !s.is_empty()));

        wait_connected().await;
        assert!(socket_bridge_transport().is_some());
        let hello = brain_hello().expect("hello metadata");
        assert_eq!(hello.brain_version, "0.0.0-test");
        assert_eq!(hello.capabilities, vec!["sync", "messages", "writes"]);
        let contract =
            crate::companion_api::command_manifest::headless_contract().expect("embedded contract");
        assert_eq!(hello.catalog_hash, contract.catalog_hash());
        assert_eq!(hello.contract_version, contract.schema_version());

        ws.close(None).await.ok();
        wait_disconnected().await;
    }

    #[tokio::test]
    async fn protocol_mismatch_closes_with_1002() {
        let _guard = lock_slot().await;
        test_support::clear_socket_for_testing();
        let state = test_state();
        let addr = serve_bridge(state).await;
        let mut ws = connect(addr, &service_token()).await;

        let bad_hello = serde_json::to_string(&json!({
            "v": BRIDGE_PROTOCOL_VERSION, "type": "hello", "role": "brain", "brainVersion": "x",
            "protocol": 99, "accountId": ACCOUNT_ID, "capabilities": [],
            "catalogHash": "mismatch", "contractVersion": 1
        }))
        .unwrap();
        ws.send(WsMessage::Text(bad_hello.into())).await.unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("close timeout")
            .expect("stream ended")
            .expect("ws frame err");
        match msg {
            WsMessage::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), CLOSE_PROTOCOL_ERROR);
            }
            other => panic!("expected close frame, got {other:?}"),
        }
        assert!(!bridge_connected(), "mismatched brain must not install");
    }

    #[tokio::test]
    async fn catalog_mismatch_closes_with_1002() {
        let _guard = lock_slot().await;
        test_support::clear_socket_for_testing();
        let state = test_state();
        let addr = serve_bridge(state).await;
        let mut ws = connect(addr, &service_token()).await;

        let bad_hello = serde_json::to_string(&json!({
            "v": BRIDGE_PROTOCOL_VERSION, "type": "hello", "role": "brain", "brainVersion": "x",
            "protocol": BRIDGE_PROTOCOL_VERSION, "accountId": ACCOUNT_ID, "capabilities": [],
            "catalogHash": "stale-catalog", "contractVersion": 1
        }))
        .unwrap();
        ws.send(WsMessage::Text(bad_hello.into())).await.unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("close timeout")
            .expect("stream ended")
            .expect("ws frame err");
        match msg {
            WsMessage::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), CLOSE_PROTOCOL_ERROR);
            }
            other => panic!("expected close frame, got {other:?}"),
        }
        assert!(!bridge_connected(), "stale brain must not install");
    }

    #[tokio::test]
    async fn missing_hello_times_out_with_1002() {
        let _guard = lock_slot().await;
        let state = test_state();
        let addr = serve_bridge(state).await;
        let mut ws = connect(addr, &service_token()).await;

        // Send nothing; the (test-shortened) hello timeout must close 1002.
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("close timeout")
            .expect("stream ended")
            .expect("ws frame err");
        match msg {
            WsMessage::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), CLOSE_PROTOCOL_ERROR);
            }
            other => panic!("expected close frame, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn account_mismatch_closes_with_1008() {
        let _guard = lock_slot().await;
        let state = test_state();
        let addr = serve_bridge(state).await;
        let mut ws = connect(addr, &service_token()).await;

        let wrong_account = serde_json::to_string(&json!({
            "v": BRIDGE_PROTOCOL_VERSION, "type": "hello", "role": "brain", "brainVersion": "x",
            "protocol": BRIDGE_PROTOCOL_VERSION, "accountId": "some_other_account", "capabilities": [],
            "catalogHash": crate::companion_api::command_manifest::headless_contract().expect("contract").catalog_hash(),
            "contractVersion": crate::companion_api::command_manifest::headless_contract().expect("contract").schema_version()
        }))
        .unwrap();
        ws.send(WsMessage::Text(wrong_account.into()))
            .await
            .unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("close timeout")
            .expect("stream ended")
            .expect("ws frame err");
        match msg {
            WsMessage::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), CLOSE_POLICY_VIOLATION);
            }
            other => panic!("expected close frame, got {other:?}"),
        }
    }

    // ── Full sync_pull roundtrip through the socket transport ────────────────

    #[tokio::test]
    async fn sync_pull_roundtrips_through_a_connected_fake_brain() {
        let _guard = lock_slot().await;
        let state = test_state();
        let addr = serve_bridge(Arc::clone(&state)).await;
        let mut ws = connect(addr, &service_token()).await;
        handshake(&mut ws).await;
        wait_connected().await;

        // Kick off the pull through the installed socket transport — exactly
        // what the RPC arm will do once R4/R5 rewire `resolve_bridge_transport`.
        let transport = socket_bridge_transport().expect("socket transport installed");
        let bridge = Arc::clone(&state.sync_bridge);
        let pull = tokio::spawn(async move {
            bridge
                .pull(
                    transport.as_ref(),
                    "sessions".into(),
                    7,
                    ACCOUNT_ID.into(),
                    Some(1),
                    Duration::from_secs(5),
                )
                .await
        });

        // Fake brain: receive the event frame, assert the snake_case payload,
        // respond with the camelCase Tauri-command args (what the TS
        // installers send verbatim).
        let request_id = loop {
            let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .expect("event timeout")
                .expect("socket closed")
                .expect("ws frame err");
            if let WsMessage::Text(text) = msg {
                let v: Value = serde_json::from_str(text.as_str()).unwrap();
                if v["type"] == "event" {
                    assert_eq!(v["event"], "companion://sync-pull-request");
                    assert_eq!(v["payload"]["table"], "sessions");
                    assert_eq!(v["payload"]["since"], 7);
                    assert_eq!(v["payload"]["account_id"], ACCOUNT_ID);
                    break v["payload"]["request_id"].as_str().unwrap().to_string();
                }
            }
        };

        let respond = serde_json::to_string(&json!({
            "v": BRIDGE_PROTOCOL_VERSION, "type": "respond", "command": "companion_sync_pull_response",
            "payload": { "requestId": request_id, "delta": { "rows": [1, 2] }, "error": null }
        }))
        .unwrap();
        ws.send(WsMessage::Text(respond.into())).await.unwrap();

        let delta = pull.await.expect("join").expect("pull succeeds");
        assert_eq!(delta, json!({ "rows": [1, 2] }));

        ws.close(None).await.ok();
        wait_disconnected().await;
    }

    // ── Single-connection replacement + disconnect cleanup ───────────────────

    #[tokio::test]
    async fn new_brain_connection_replaces_and_closes_the_old() {
        let _guard = lock_slot().await;
        let state = test_state();
        let addr = serve_bridge(state).await;

        let mut brain_a = connect(addr, &service_token()).await;
        handshake(&mut brain_a).await;
        wait_connected().await;
        let first = socket_bridge_transport().expect("first transport");
        let mut first_request = first
            .reserve_request()
            .expect("first connection accepts requests");

        let mut brain_b = connect(addr, &service_token()).await;
        handshake(&mut brain_b).await;

        // A gets closed by the replacement.
        let mut a_closed = false;
        for _ in 0..50 {
            match tokio::time::timeout(Duration::from_secs(5), brain_a.next()).await {
                Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) => {
                    a_closed = true;
                    break;
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) => {
                    a_closed = true;
                    break;
                }
                Err(_) => break,
            }
        }
        assert!(
            a_closed,
            "old brain connection must be closed on replacement"
        );

        // The slot now belongs to B (different connection id).
        assert!(bridge_connected());
        let second = socket_bridge_transport().expect("second transport");
        assert_ne!(
            first.conn_id, second.conn_id,
            "slot must belong to the new connection"
        );
        tokio::time::timeout(Duration::from_secs(1), first_request.disconnected())
            .await
            .expect("replacement cancels only the old connection's requests");
        let late_request_error = match first.reserve_request() {
            Ok(_) => panic!("replaced transport must reject late requests"),
            Err(error) => error,
        };
        assert!(late_request_error.contains("disconnected"));
        let mut second_request = second
            .reserve_request()
            .expect("replacement connection accepts requests");
        assert!(
            tokio::time::timeout(Duration::from_millis(50), second_request.disconnected())
                .await
                .is_err(),
            "replacement must not cancel the new connection's requests"
        );

        // B disconnecting clears the slot.
        brain_b.close(None).await.ok();
        wait_disconnected().await;
        tokio::time::timeout(Duration::from_secs(1), second_request.disconnected())
            .await
            .expect("disconnect cancels the active connection's requests");
        assert!(socket_bridge_transport().is_none());
    }

    // ── Pong metrics ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn pong_updates_the_rss_gauge() {
        let _guard = lock_slot().await;
        let state = test_state();
        let addr = serve_bridge(state).await;
        let mut ws = connect(addr, &service_token()).await;
        handshake(&mut ws).await;
        wait_connected().await;

        let pong = serde_json::to_string(&json!({
            "v": BRIDGE_PROTOCOL_VERSION, "type": "pong", "ts": 123, "rssBytes": 987654321_u64, "lastFlushAt": 456
        }))
        .unwrap();
        ws.send(WsMessage::Text(pong.into())).await.unwrap();

        let mut seen = false;
        for _ in 0..100 {
            if brain_rss_bytes() == 987654321 {
                seen = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(seen, "pong rssBytes must land in the gauge");

        // Disconnect resets the gauge.
        ws.close(None).await.ok();
        wait_disconnected().await;
        assert_eq!(brain_rss_bytes(), 0);
    }

    // ── resolve_bridge_transport ordering ─────────────────────────────────────

    #[tokio::test]
    async fn fake_socket_is_visible_only_to_its_owning_state() {
        let _guard = lock_slot().await;
        test_support::clear_socket_for_testing();
        let owner = test_state();
        let unrelated = test_state();

        let _receiver = test_support::install_socket_for_testing(&owner);

        assert!(socket_bridge_transport_for_state(&owner).is_some());
        assert!(socket_bridge_transport_for_state(&unrelated).is_none());
        test_support::clear_socket_for_testing();
    }

    #[tokio::test]
    async fn resolve_bridge_transport_prefers_socket_then_errors_without_webview() {
        let _guard = lock_slot().await;
        test_support::clear_socket_for_testing();
        let state = test_state();

        // No socket, no app_handle → Err.
        assert!(resolve_bridge_transport(&state).is_err());

        let addr = serve_bridge(Arc::clone(&state)).await;
        let mut ws = connect(addr, &service_token()).await;
        handshake(&mut ws).await;
        wait_connected().await;

        let transport = resolve_bridge_transport(&state).expect("socket transport wins");
        assert_eq!(transport.kind(), "socket");

        ws.close(None).await.ok();
        wait_disconnected().await;
        assert!(resolve_bridge_transport(&state).is_err());
    }

    // ── Respond routing edge cases (unit level) ───────────────────────────────

    #[test]
    fn route_respond_ignores_unknown_commands_and_bad_payloads() {
        let state = test_state();
        // Unknown command — no panic.
        route_respond(&state, "companion_unknown_response", json!({}));
        // Known command, malformed payload — no panic.
        route_respond(
            &state,
            "companion_sync_pull_response",
            json!("not-an-object"),
        );
        // Known command, unknown request id — resolver no-ops.
        route_respond(
            &state,
            "companion_sync_pull_response",
            json!({ "requestId": "never-registered", "delta": {}, "error": null }),
        );
        route_respond(
            &state,
            "orchestration_proxy_response",
            json!({ "ok": true }),
        );
        assert_eq!(state.sync_bridge.pending_count(), 0);
    }

    /// ADR-0131/0136 — the brain publishes host events through the bridge. Only
    /// the explicit host-owned relay topics may pass; anything else is dropped, so a
    /// compromised brain cannot forge e.g. `host-state://action` frames that
    /// clients treat as authoritative.
    #[test]
    fn companion_event_publish_honours_the_topic_allowlist() {
        let state = test_state();
        let seen = |topic: &str| -> bool {
            match state.event_bus.subscribe(Some(0), 0) {
                super::super::event_bus::SubscribeResult::Ok { replay, .. } => {
                    replay.iter().any(|frame| frame.event_type == topic)
                }
                _ => panic!("replay from seq 0 must be available in-test"),
            }
        };

        route_respond(
            &state,
            "companion_event_publish",
            json!({ "topic": "sync://invalidate", "event": { "table": "outboundQueue" } }),
        );
        route_respond(
            &state,
            "companion_event_publish",
            json!({
                "topic": "connector://message-added",
                "event": { "conversationKey": "telegram:tg:1", "messageId": "m1" }
            }),
        );
        assert!(seen("sync://invalidate"));
        assert!(seen("connector://message-added"));

        for topic in [
            "workflow://run-status",
            "workflow://run-terminal",
            "workflow://approval-request",
            "workflow://approval-resolved",
            "workflow://approval-pending",
            "workflow://step-execute",
            "workflow://step-pending",
        ] {
            route_respond(
                &state,
                "companion_event_publish",
                json!({ "topic": topic, "event": { "id": "opaque" } }),
            );
            assert!(seen(topic), "expected {topic} to be allowed");
        }

        // Not on the allowlist → dropped, not published.
        route_respond(
            &state,
            "companion_event_publish",
            json!({ "topic": "host-state://action", "event": { "kind": "session.create" } }),
        );
        route_respond(
            &state,
            "companion_event_publish",
            json!({ "topic": "notification://remote", "event": {} }),
        );
        assert!(!seen("host-state://action"));
        assert!(!seen("notification://remote"));

        // Malformed payloads must not panic.
        route_respond(&state, "companion_event_publish", json!({ "topic": 7 }));
        route_respond(
            &state,
            "companion_event_publish",
            json!({ "topic": "sync://invalidate" }),
        );
    }

    #[tokio::test]
    async fn performance_frames_are_targeted_and_never_enter_replay() {
        let state = test_state();
        let mut receiver = match state
            .event_bus
            .subscribe(None, chrono::Utc::now().timestamp_millis())
        {
            crate::companion_api::event_bus::SubscribeResult::Ok { receiver, .. } => receiver,
            crate::companion_api::event_bus::SubscribeResult::ResyncRequired => {
                panic!("fresh cursor")
            }
        };
        route_respond(
            &state,
            "companion_perf_frame",
            json!({
                "deviceId": "device-a",
                "event": "perf://frame",
                "frame": { "wireVersion": 1, "sequence": 7 }
            }),
        );
        let frame = receiver.recv().await.expect("ephemeral frame");
        assert_eq!(frame.event_type, "perf://frame");
        assert_eq!(frame.target_device_id.as_deref(), Some("device-a"));
        assert_eq!(frame.payload["sequence"], 7);
        let replay = match state
            .event_bus
            .subscribe(Some(0), chrono::Utc::now().timestamp_millis())
        {
            crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => replay,
            crate::companion_api::event_bus::SubscribeResult::ResyncRequired => {
                panic!("fresh cursor")
            }
        };
        assert!(replay.is_empty());
    }

    #[tokio::test]
    async fn orchestration_response_routes_to_the_headless_mcp_state() {
        let _guard = lock_slot().await;
        crate::headless::install_headless_services(Some(
            crate::headless::HeadlessServices::stub_for_tests(),
        ));

        resolve_orchestration_response(json!({
            "id": "unknown-request",
            "ok": false,
            "error": "cancelled",
        }))
        .expect("unknown reply ids are an idempotent no-op");

        crate::headless::install_headless_services(None);
    }

    #[tokio::test]
    async fn token_refresh_without_a_brain_errors() {
        let _guard = lock_slot().await;
        // Ensure no slot is installed (tests are serialized on the lock).
        if !bridge_connected() {
            assert!(send_token_refresh("tok".into()).is_err());
        }
    }

    #[test]
    fn socket_transport_emit_formats_an_event_frame() {
        let (tx, mut rx) = mpsc::channel::<QueuedBridgeMessage>(MAX_BRIDGE_QUEUE_FRAMES);
        let transport = SocketBridgeTransport::new(tx, 42);
        transport
            .emit(
                "companion://sync-pull-request",
                json!({ "request_id": "r1" }),
            )
            .expect("emit");
        let Message::Text(text) = rx.try_recv().expect("frame queued").message else {
            panic!("expected text frame");
        };
        let v: Value = serde_json::from_str(text.as_str()).unwrap();
        assert_eq!(v["v"], BRIDGE_PROTOCOL_VERSION);
        assert_eq!(v["type"], "event");
        assert_eq!(v["event"], "companion://sync-pull-request");
        assert_eq!(v["payload"]["request_id"], "r1");
        assert_eq!(transport.kind(), "socket");

        // Receiver dropped → emit fails (disconnect fail-fast).
        drop(rx);
        assert!(transport.emit("companion://x", json!({})).is_err());
    }

    #[test]
    fn socket_transport_bounds_the_outgoing_frame_queue() {
        let (tx, _rx) = mpsc::channel::<QueuedBridgeMessage>(MAX_BRIDGE_QUEUE_FRAMES);
        let transport = SocketBridgeTransport::new(tx, 43);

        for index in 0..MAX_BRIDGE_QUEUE_FRAMES {
            transport
                .emit("companion://x", json!({ "index": index }))
                .expect("within queue budget");
        }
        let error = transport
            .emit("companion://x", json!({ "overflow": true }))
            .expect_err("queue must reject overflow");
        assert!(error.contains("overloaded"));
    }

    #[test]
    fn socket_transport_bounds_queued_bytes_independently_of_frame_count() {
        assert_eq!(MAX_BRIDGE_QUEUE_BYTES, 64 * 1024 * 1024);
        let (tx, _rx) = mpsc::channel::<QueuedBridgeMessage>(MAX_BRIDGE_QUEUE_FRAMES);
        let (disconnected, _) = watch::channel(false);
        let transport = SocketBridgeTransport {
            tx,
            conn_id: 45,
            queued_bytes: Arc::new(Semaphore::new(32)),
            in_flight: Arc::new(Semaphore::new(MAX_BRIDGE_IN_FLIGHT)),
            disconnected,
        };

        let error = transport
            .emit("companion://x", json!({ "payload": "x".repeat(128) }))
            .expect_err("byte budget must reject an otherwise available frame slot");
        assert!(error.contains("overloaded"));
    }

    #[test]
    fn socket_transport_bounds_connection_in_flight_requests() {
        let (tx, _rx) = mpsc::channel::<QueuedBridgeMessage>(MAX_BRIDGE_QUEUE_FRAMES);
        let transport = SocketBridgeTransport::new(tx, 44);
        let mut guards = Vec::new();
        for _ in 0..MAX_BRIDGE_IN_FLIGHT {
            guards.push(
                transport
                    .reserve_request()
                    .expect("within in-flight budget"),
            );
        }
        let error = transport
            .reserve_request()
            .err()
            .expect("in-flight overflow must fail");
        assert!(error.contains("overloaded"));
        drop(guards);
        assert!(transport.reserve_request().is_ok());
    }

    #[tokio::test]
    async fn connection_in_flight_budget_is_shared_across_bridge_types() {
        let (tx, _rx) = mpsc::channel::<QueuedBridgeMessage>(MAX_BRIDGE_QUEUE_FRAMES);
        let transport = SocketBridgeTransport::new(tx, 46);
        let guards = (0..MAX_BRIDGE_IN_FLIGHT)
            .map(|_| transport.reserve_request().expect("within shared budget"))
            .collect::<Vec<_>>();

        let write_error = super::super::desktop_writes_bridge::DesktopWritesBridge::new()
            .dispatch(
                transport.as_ref(),
                "host_feature_manifest",
                json!({}),
                Duration::from_secs(30),
            )
            .await
            .expect_err("desktop-write bridge must share the connection budget");
        assert!(write_error.contains("overloaded"));

        let message_error = super::super::desktop_messages_bridge::DesktopMessagesBridge::new()
            .list_sessions(transport.as_ref(), 10, 0, None, Duration::from_secs(30))
            .await
            .expect_err("desktop-message bridge must share the connection budget");
        assert!(message_error.contains("overloaded"));

        let sync_error = super::super::sync_bridge::SyncBridge::new()
            .pull(
                transport.as_ref(),
                "sessions".into(),
                0,
                "account".into(),
                None,
                Duration::from_secs(30),
            )
            .await
            .expect_err("sync bridge must share the connection budget");
        assert!(sync_error.contains("overloaded"));
        drop(guards);
    }
}
