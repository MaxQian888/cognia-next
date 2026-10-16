//! The Browser Companion's device socket (ADR-0228 §5).
//!
//! A paired browser extension keeps one socket open to the Host. Two things
//! travel on it:
//!
//! - **Status hints**, to every paired browser (`browser.read-own`): "one of
//!   your submissions moved", so the side panel and the toolbar badge refresh
//!   now instead of at the next poll. A hint carries no content; the extension
//!   reads the list it was always allowed to read.
//! - **Operations**, only to a browser whose device holds `browser.drive`,
//!   checked again for every frame at send time: the `ExtensionBrowserEngine`
//!   (`lib/browser/extension-engine.ts`) sends `snapshot`, `act`, `navigate`…
//!   and awaits the extension's answer, correlated by id.
//!
//! The shape is `ws_worker`'s: a single-use ticket, a hello within ten seconds,
//! authorization re-checked every second, a bounded outbound queue, closure on
//! revocation, and on the Browser Access kill switch. One connection per device;
//! a newer one replaces the older, whose pending operations fail rather than
//! hang.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch, OwnedSemaphorePermit, Semaphore};
use tokio::time::{interval, Instant};

const HELLO_VERSION: u32 = 1;
/// A screenshot answer or a `set_files` payload is the largest frame; both are
/// bounded by the attachment ceiling (10 MiB) once base64 is accounted for.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_QUEUE_FRAMES: usize = 32;
const MAX_QUEUE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PENDING_OPERATIONS: usize = 16;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Under 30 seconds on purpose: an MV3 service worker is kept alive by
/// WebSocket *messages*, and a protocol-level ping does not count as one. The
/// heartbeat is therefore an application text frame.
const HEARTBEAT_SECS: u64 = 20;
const IDLE_TIMEOUT_SECS: u64 = 75;
/// Ceiling on how long one operation may take, whatever the caller asked for.
pub const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);
const CLOSE_GOING_AWAY: u16 = 1001;
const CLOSE_PROTOCOL_ERROR: u16 = 1002;
const CLOSE_POLICY_VIOLATION: u16 = 1008;

/// The capability that admits a browser to the socket at all.
const SOCKET_CAPABILITY: &str = "browser.read-own";
/// The capability an operation frame needs, checked per frame.
pub const DRIVE_CAPABILITY: &str = "browser.drive";

/// The closed operation vocabulary. The Host never forwards a name outside it,
/// and the extension refuses one it does not implement, so neither side can
/// grow a capability the other did not agree to.
pub const OPERATIONS: &[&str] = &[
    "bind",
    "release",
    "navigate",
    "snapshot",
    "act",
    "press_key",
    "scroll",
    "evaluate",
    "read_console",
    "read_network",
    "back",
    "forward",
    "reload",
    "stop",
    "get_page",
    "list_pages",
    "activate_page",
    "close_page",
    "create_page",
    "drag",
    "handle_dialog",
    "set_files",
    "downloads",
    "cancel_download",
    "delete_download",
    "wait_for_text",
    "wait_for_selector",
    "wait_for_network_idle",
    "wait_for_load",
    "screenshot",
    "set_zoom",
    "find",
    "find_clear",
    "list_cookies",
    "clear_cookies",
    "get_storage",
    "set_storage",
    "clear_storage",
    "finalize_tabs",
];

/// The operations that only look: they change nothing on the page or in the
/// browser that a second run would change again, so a caller may repeat one
/// freely and nothing about it is worth remembering.
///
/// On the RPC plane they travel as `companion_browser_extension_read` (a read,
/// never written to the idempotency ledger), and everything else as
/// `companion_browser_extension_call`, whose answer the ledger keeps so a
/// retried click is not clicked twice. The split matters because the ledger
/// is durable: snapshots, screenshots and cookie or storage values would
/// otherwise be written to the security store on every look.
/// `lib/browser-companion/host-transport.ts` keeps the same list, pinned to
/// this one by its test.
pub const READ_OPERATIONS: &[&str] = &[
    "snapshot",
    "read_console",
    "read_network",
    "get_page",
    "list_pages",
    "downloads",
    "wait_for_text",
    "wait_for_selector",
    "wait_for_network_idle",
    "wait_for_load",
    "screenshot",
    "list_cookies",
    "get_storage",
];

#[derive(Debug, Deserialize)]
pub struct BrowserCompanionSocketQuery {
    ticket: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum Inbound {
    Hello {
        v: u32,
        #[serde(default, rename = "extensionVersion")]
        extension_version: String,
        #[serde(default)]
        features: Vec<String>,
    },
    Result {
        id: String,
        ok: bool,
        #[serde(default)]
        value: Value,
        #[serde(default)]
        error: Option<OperationError>,
    },
    Heartbeat,
}

/// A refusal from the extension, or from this module on its behalf.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct OperationError {
    pub code: String,
    pub message: String,
}

impl OperationError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// Why the Host ends a live connection from its side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloseReason {
    /// The same browser connected again; this socket is stale.
    Replaced,
    /// The companion server is stopping. Not a refusal: the browser should
    /// reconnect as soon as the Host is back, so this closes with 1001, never
    /// the 1008 a browser waits out as "your authorization changed".
    HostStopping,
}

struct Connection {
    connection_id: String,
    connected_at: u64,
    extension_version: String,
    features: Vec<String>,
    sender: mpsc::Sender<Queued>,
    queue_bytes: Arc<Semaphore>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, OperationError>>>>>,
    shutdown: watch::Sender<Option<CloseReason>>,
}

struct Queued {
    text: String,
    _permit: OwnedSemaphorePermit,
}

type ConnectionKey = (String, String);

static CONNECTIONS: Lazy<RwLock<HashMap<ConnectionKey, Connection>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub async fn ws_browser_companion_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<BrowserCompanionSocketQuery>,
) -> Response {
    let Some(store) = super::security_store::security_store() else {
        return super::api::public_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "security_store_unavailable",
            "the security database is unavailable",
            true,
            serde_json::json!({}),
        );
    };
    let binding = match store.redeem_socket_ticket(
        &query.ticket,
        "/ws/browser-companion",
        "browser-companion",
        unix_time_secs(),
    ) {
        Ok(binding) => binding,
        Err(_) => {
            return super::api::public_error_response(
                StatusCode::UNAUTHORIZED,
                "invalid_socket_ticket",
                "browser companion socket ticket is invalid, expired, or already used",
                false,
                serde_json::json!({}),
            );
        }
    };
    if !has_capability(&binding.tenant_id, &binding.device_id, SOCKET_CAPABILITY) {
        return super::api::public_error_response(
            StatusCode::FORBIDDEN,
            "browser_companion_forbidden",
            "the browser.read-own capability is required",
            false,
            serde_json::json!({}),
        );
    }
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, binding.tenant_id, binding.device_id))
        .into_response()
}

async fn handle_socket(mut socket: WebSocket, tenant_id: String, device_id: String) {
    let (extension_version, features) =
        match tokio::time::timeout(HELLO_TIMEOUT, receive_hello(&mut socket)).await {
            Ok(Ok(hello)) => hello,
            Ok(Err(reason)) => {
                close_with(&mut socket, CLOSE_PROTOCOL_ERROR, &reason).await;
                return;
            }
            Err(_) => {
                close_with(&mut socket, CLOSE_PROTOCOL_ERROR, "no hello within timeout").await;
                return;
            }
        };
    let connection_id = uuid::Uuid::new_v4().to_string();
    let (sender, mut outgoing) = mpsc::channel::<Queued>(MAX_QUEUE_FRAMES);
    let (shutdown, mut shutdown_rx) = watch::channel(None::<CloseReason>);
    let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, OperationError>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    install(
        (tenant_id.clone(), device_id.clone()),
        Connection {
            connection_id: connection_id.clone(),
            connected_at: unix_time_millis(),
            extension_version,
            features,
            sender,
            queue_bytes: Arc::new(Semaphore::new(MAX_QUEUE_BYTES)),
            pending: Arc::clone(&pending),
            shutdown,
        },
    );

    let welcome = serde_json::json!({
        "t": "welcome",
        "v": HELLO_VERSION,
        "connectionId": connection_id,
        "driveAllowed": has_capability(&tenant_id, &device_id, DRIVE_CAPABILITY),
    })
    .to_string();
    if socket.send(Message::Text(welcome.into())).await.is_err() {
        remove(&tenant_id, &device_id, &connection_id);
        fail_pending(&pending, "browser_extension_disconnected");
        return;
    }

    let mut heartbeat = interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.tick().await;
    let mut authorization = interval(Duration::from_secs(1));
    authorization.tick().await;
    let idle_timeout = Duration::from_secs(IDLE_TIMEOUT_SECS);
    let mut last_activity = Instant::now();
    let mut drive_allowed = has_capability(&tenant_id, &device_id, DRIVE_CAPABILITY);

    loop {
        tokio::select! {
            queued = outgoing.recv() => {
                match queued {
                    Some(queued) => {
                        if socket.send(Message::Text(queued.text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        last_activity = Instant::now();
                        match serde_json::from_str::<Inbound>(text.as_str()) {
                            Ok(Inbound::Result { id, ok, value, error }) => {
                                let waiter = pending.lock().remove(&id);
                                if let Some(waiter) = waiter {
                                    let outcome = if ok {
                                        Ok(value)
                                    } else {
                                        Err(error.unwrap_or_else(|| {
                                            OperationError::new("browser_extension_error", "the extension refused the operation")
                                        }))
                                    };
                                    let _ = waiter.send(outcome);
                                }
                                // An answer for an id nobody waits on is a late
                                // reply to a timed-out call: harmless, dropped.
                            }
                            Ok(Inbound::Heartbeat) => {}
                            Ok(Inbound::Hello { .. }) | Err(_) => {
                                close_with(&mut socket, CLOSE_PROTOCOL_ERROR, "unexpected frame").await;
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        last_activity = Instant::now();
                        if socket.send(Message::Pong(bytes)).await.is_err() { break; }
                    }
                    Some(Ok(Message::Pong(_))) => last_activity = Instant::now(),
                    Some(Ok(Message::Binary(_))) => {
                        close_with(&mut socket, CLOSE_PROTOCOL_ERROR, "text frames only").await;
                        break;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                }
            }
            _ = heartbeat.tick() => {
                if last_activity.elapsed() > idle_timeout {
                    break;
                }
                let beat = serde_json::json!({ "t": "heartbeat" }).to_string();
                if socket.send(Message::Text(beat.into())).await.is_err() { break; }
            }
            _ = authorization.tick() => {
                // A stop already under way decides how this socket closes:
                // the server clears the submissions flag as it stops, and
                // reading that here first would tell the browser access was
                // switched off.
                let stopping = *shutdown_rx.borrow();
                if let Some(reason) = stopping {
                    close_for(&mut socket, reason).await;
                    break;
                }
                if !has_capability(&tenant_id, &device_id, SOCKET_CAPABILITY) {
                    close_with(&mut socket, CLOSE_POLICY_VIOLATION, "this browser is no longer paired").await;
                    break;
                }
                if !super::browser_access::submissions_enabled() {
                    close_with(&mut socket, CLOSE_POLICY_VIOLATION, "browser access is switched off on this Host").await;
                    break;
                }
                // Tell the extension when the Owner turns driving on or off, so
                // the panel's agent mode follows without a reconnect.
                let now_allowed = has_capability(&tenant_id, &device_id, DRIVE_CAPABILITY);
                if now_allowed != drive_allowed {
                    drive_allowed = now_allowed;
                    if !drive_allowed {
                        fail_pending(&pending, "browser_drive_revoked");
                    }
                    let frame = serde_json::json!({ "t": "drive", "allowed": drive_allowed }).to_string();
                    if socket.send(Message::Text(frame.into())).await.is_err() { break; }
                }
            }
            changed = shutdown_rx.changed() => {
                let reason = *shutdown_rx.borrow();
                if changed.is_err() || reason.is_some() {
                    close_for(&mut socket, reason.unwrap_or(CloseReason::Replaced)).await;
                    break;
                }
            }
        }
    }

    remove(&tenant_id, &device_id, &connection_id);
    fail_pending(&pending, "browser_extension_disconnected");
}

async fn receive_hello(socket: &mut WebSocket) -> Result<(String, Vec<String>), String> {
    let message = socket
        .recv()
        .await
        .ok_or_else(|| "socket closed before hello".to_string())?
        .map_err(|error| format!("receive hello: {error}"))?;
    let Message::Text(text) = message else {
        return Err("hello must be a text frame".to_string());
    };
    match serde_json::from_str::<Inbound>(text.as_str()) {
        Ok(Inbound::Hello {
            v,
            extension_version,
            features,
        }) => {
            if v != HELLO_VERSION {
                return Err(format!("unsupported hello version: {v}"));
            }
            Ok((
                extension_version.chars().take(32).collect(),
                features
                    .into_iter()
                    .take(16)
                    .map(|feature| feature.chars().take(32).collect())
                    .collect(),
            ))
        }
        _ => Err("the first frame must be a hello".to_string()),
    }
}

fn install(key: ConnectionKey, connection: Connection) {
    let previous = CONNECTIONS.write().insert(key, connection);
    if let Some(previous) = previous {
        let _ = previous.shutdown.send(Some(CloseReason::Replaced));
        fail_pending(&previous.pending, "browser_extension_replaced");
    }
}

/// Close every browser's device socket because the companion server is
/// stopping (ADR-0228 §5). Axum's graceful shutdown does not end upgraded
/// sockets, so without this they outlive the stop until their authorization
/// tick reads the cleared submissions flag and refuses them with 1008 — which
/// a browser waits out for minutes, though the Host may be back in seconds.
pub fn close_all_for_host_stop() {
    close_all_for_stop(&CONNECTIONS.read());
}

fn close_all_for_stop(connections: &HashMap<ConnectionKey, Connection>) {
    for connection in connections.values() {
        let _ = connection.shutdown.send(Some(CloseReason::HostStopping));
        fail_pending(&connection.pending, "browser_extension_disconnected");
    }
}

fn remove(tenant_id: &str, device_id: &str, connection_id: &str) {
    let mut connections = CONNECTIONS.write();
    let key = (tenant_id.to_string(), device_id.to_string());
    if connections
        .get(&key)
        .is_some_and(|connection| connection.connection_id == connection_id)
    {
        connections.remove(&key);
    }
}

fn fail_pending(
    pending: &Mutex<HashMap<String, oneshot::Sender<Result<Value, OperationError>>>>,
    code: &str,
) {
    let waiters: Vec<_> = pending.lock().drain().map(|(_, waiter)| waiter).collect();
    for waiter in waiters {
        let _ = waiter.send(Err(OperationError::new(
            code,
            "the browser's connection to this Host ended",
        )));
    }
}

fn enqueue(
    sender: &mpsc::Sender<Queued>,
    queue_bytes: &Arc<Semaphore>,
    text: String,
) -> Result<(), OperationError> {
    if text.len() > MAX_FRAME_BYTES {
        return Err(OperationError::new(
            "browser_operation_too_large",
            "the operation is larger than the socket accepts",
        ));
    }
    let permits = u32::try_from(text.len().max(1)).unwrap_or(u32::MAX);
    let permit = Arc::clone(queue_bytes)
        .try_acquire_many_owned(permits)
        .map_err(|_| {
            OperationError::new(
                "browser_extension_backpressure",
                "the browser is not keeping up",
            )
        })?;
    sender
        .try_send(Queued {
            text,
            _permit: permit,
        })
        .map_err(|_| {
            OperationError::new(
                "browser_extension_backpressure",
                "the browser is not keeping up",
            )
        })
}

/// Run one operation in a connected browser and wait for its answer.
///
/// Refuses before sending when the browser is not connected, does not hold
/// `browser.drive`, or Browser Access is switched off — each with its own code,
/// because each has a different remedy.
pub async fn call(
    tenant_id: &str,
    device_id: &str,
    operation: &str,
    args: Value,
    timeout: Duration,
) -> Result<Value, OperationError> {
    if !OPERATIONS.contains(&operation) {
        return Err(OperationError::new(
            "browser_operation_unknown",
            format!("unknown browser operation: {operation}"),
        ));
    }
    if !super::browser_access::submissions_enabled() {
        return Err(OperationError::new(
            "browser_submissions_disabled",
            "browser access is switched off on this Host",
        ));
    }
    if !has_capability(tenant_id, device_id, DRIVE_CAPABILITY) {
        return Err(OperationError::new(
            "browser_drive_forbidden",
            "this browser has not been allowed to be driven by agents",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let timeout = timeout.min(MAX_OPERATION_TIMEOUT);
    let (waiter, answer) = oneshot::channel();
    let pending = {
        let connections = CONNECTIONS.read();
        let connection = connections
            .get(&(tenant_id.to_string(), device_id.to_string()))
            .ok_or_else(|| {
                OperationError::new(
                    "browser_extension_offline",
                    "the browser is not connected to this Host",
                )
            })?;
        let pending = Arc::clone(&connection.pending);
        {
            let mut guard = pending.lock();
            if guard.len() >= MAX_PENDING_OPERATIONS {
                return Err(OperationError::new(
                    "browser_extension_backpressure",
                    "too many operations are waiting on this browser",
                ));
            }
            guard.insert(id.clone(), waiter);
        }
        let frame = serde_json::json!({
            "t": "op",
            "id": id,
            "op": operation,
            "args": args,
            "deadlineMs": u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
        })
        .to_string();
        if let Err(error) = enqueue(&connection.sender, &connection.queue_bytes, frame) {
            pending.lock().remove(&id);
            return Err(error);
        }
        pending
    };
    match tokio::time::timeout(timeout, answer).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => Err(OperationError::new(
            "browser_extension_disconnected",
            "the browser's connection to this Host ended",
        )),
        Err(_) => {
            pending.lock().remove(&id);
            Err(OperationError::new(
                "browser_operation_timeout",
                "the browser did not answer in time",
            ))
        }
    }
}

/// Tell a connected browser that its submissions changed. Best-effort: a
/// browser that is not connected polls, and a full queue drops the hint, which
/// the next one replaces.
pub fn notify_status(tenant_id: &str, device_id: &str) {
    let connections = CONNECTIONS.read();
    if let Some(connection) = connections.get(&(tenant_id.to_string(), device_id.to_string())) {
        let frame = serde_json::json!({ "t": "status", "at": unix_time_millis() }).to_string();
        let _ = enqueue(&connection.sender, &connection.queue_bytes, frame);
    }
}

/// Whether one browser is connected, and whether it may be driven.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeviceStatus {
    pub connected: bool,
    pub drive_allowed: bool,
}

/// The status the Host's capability answer and target catalogue need.
pub fn device_status(tenant_id: &str, device_id: &str) -> BrowserDeviceStatus {
    BrowserDeviceStatus {
        connected: CONNECTIONS
            .read()
            .contains_key(&(tenant_id.to_string(), device_id.to_string())),
        drive_allowed: has_capability(tenant_id, device_id, DRIVE_CAPABILITY),
    }
}

fn has_capability(tenant_id: &str, device_id: &str, capability: &str) -> bool {
    super::security_store::security_store()
        .and_then(|store| store.has_capability(tenant_id, device_id, capability).ok())
        .unwrap_or(false)
}

async fn close_for(socket: &mut WebSocket, reason: CloseReason) {
    match reason {
        CloseReason::Replaced => {
            close_with(
                socket,
                CLOSE_POLICY_VIOLATION,
                "replaced by a newer connection",
            )
            .await
        }
        CloseReason::HostStopping => {
            close_with(socket, CLOSE_GOING_AWAY, "the Host is stopping").await
        }
    }
}

async fn close_with(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_string().into(),
        })))
        .await;
}

fn unix_time_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Desktop commands ────────────────────────────────────────────────────────
//
// None takes a tenant from the renderer: every one addresses the tenant the
// pairing commands enrolled browsers into, so a renderer on another account
// cannot write grants or send operations nothing would look up.

fn paired_tenant() -> String {
    super::host_identity::current_tenant_or_unbound()
}

/// One paired browser, as the desktop's Browser Companion card shows it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairedBrowser {
    pub device_id: String,
    pub display_name: String,
    pub status: String,
    pub created_at: i64,
    pub connected: bool,
    pub extension_version: Option<String>,
    pub drive_allowed: bool,
}

/// Every paired browser for this Host, connected or not.
pub fn paired_browsers(tenant_id: &str) -> Result<Vec<PairedBrowser>, String> {
    let store = super::security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    let devices = store
        .list_browser_devices(tenant_id)
        .map_err(|error| error.to_string())?;
    let connections = CONNECTIONS.read();
    Ok(devices
        .into_iter()
        .map(|device| {
            let connection = connections.get(&(tenant_id.to_string(), device.device_id.clone()));
            PairedBrowser {
                drive_allowed: device
                    .capabilities
                    .iter()
                    .any(|capability| capability == DRIVE_CAPABILITY),
                connected: connection.is_some(),
                extension_version: connection.map(|c| c.extension_version.clone()),
                device_id: device.device_id,
                display_name: device.display_name,
                status: device.status,
                created_at: device.created_at,
            }
        })
        .collect())
}

/// Grant or revoke `browser.drive` for one paired browser, leaving the rest of
/// its grants as they are. The store refuses it for anything but a browser.
pub fn set_drive_allowed(tenant_id: &str, device_id: &str, allowed: bool) -> Result<(), String> {
    if device_id.trim().is_empty() {
        return Err("device_id is required".to_string());
    }
    let store = super::security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    let mut capabilities = store
        .capability_snapshot(tenant_id, device_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "paired browser is unknown or revoked".to_string())?;
    capabilities.retain(|capability| capability != DRIVE_CAPABILITY);
    if allowed {
        capabilities.push(DRIVE_CAPABILITY.to_string());
    }
    store
        .replace_device_capabilities(
            tenant_id,
            "local-trust-root",
            device_id,
            &capabilities,
            unix_time_secs(),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Run one operation in a paired browser (the `ExtensionBrowserEngine`'s transport).
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn companion_browser_extension_call(
    device_id: String,
    operation: String,
    args: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, OperationError> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    call(&paired_tenant(), &device_id, &operation, args, timeout).await
}

/// Every paired browser, with its connection and drive status.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn companion_browser_extension_list() -> Result<Vec<PairedBrowser>, String> {
    paired_browsers(&paired_tenant())
}

/// One browser's connection and drive status.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn companion_browser_extension_status(
    device_id: String,
) -> Result<BrowserDeviceStatus, String> {
    Ok(device_status(&paired_tenant(), &device_id))
}

/// Turn agent driving on or off for one paired browser.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn companion_browser_extension_set_drive(
    device_id: String,
    allowed: bool,
) -> Result<(), String> {
    set_drive_allowed(&paired_tenant(), &device_id, allowed)
}

/// Hint a browser that its submissions changed.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn companion_browser_extension_notify(device_id: String) -> Result<(), String> {
    notify_status(&paired_tenant(), &device_id);
    Ok(())
}

// ── The brain's three on the companion RPC plane ─────────────────────────
//
// A headless Host serves this socket too, and its brain reaches the Host only
// over RPC: `rpc/service_plane.rs` answers status, call and notify for the
// service principal alone. These adapters keep those arms thin and answer in
// the RPC envelope, so the brain sees the same codes the desktop gets over IPC.

type RpcFailure = (StatusCode, axum::Json<super::rpc_error::RpcError>);

/// One browser's connection and drive status, for the brain.
pub fn rpc_device_status(device_id: &str) -> BrowserDeviceStatus {
    device_status(&paired_tenant(), device_id)
}

/// Run one acting operation in a paired browser, for the brain. A
/// [`READ_OPERATIONS`] entry is refused here: it belongs on [`rpc_read`].
pub async fn rpc_call(
    device_id: &str,
    operation: &str,
    args: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, RpcFailure> {
    if READ_OPERATIONS.contains(&operation) {
        return Err(operation_error_response(OperationError::new(
            "browser_operation_wrong_command",
            format!("{operation} only reads; send it as companion_browser_extension_read"),
        )));
    }
    rpc_operation(device_id, operation, args, timeout_ms).await
}

/// Run one looking operation in a paired browser, for the brain. Anything
/// outside [`READ_OPERATIONS`] is refused: it belongs on [`rpc_call`].
pub async fn rpc_read(
    device_id: &str,
    operation: &str,
    args: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, RpcFailure> {
    if OPERATIONS.contains(&operation) && !READ_OPERATIONS.contains(&operation) {
        return Err(operation_error_response(OperationError::new(
            "browser_operation_wrong_command",
            format!("{operation} acts on the page; send it as companion_browser_extension_call"),
        )));
    }
    rpc_operation(device_id, operation, args, timeout_ms).await
}

async fn rpc_operation(
    device_id: &str,
    operation: &str,
    args: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, RpcFailure> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    call(&paired_tenant(), device_id, operation, args, timeout)
        .await
        .map_err(operation_error_response)
}

/// Hint a browser that its submissions changed, for the brain.
pub fn rpc_notify_status(device_id: &str) {
    notify_status(&paired_tenant(), device_id);
}

/// A failed operation in the RPC envelope. The code is kept as is — the
/// engine (`lib/browser/extension-engine.ts`) maps it to the same error the
/// desktop raises from IPC — and the status says whose problem it is: the
/// request, the Owner's grant, the browser's connection, or the page.
pub fn operation_error_response(error: OperationError) -> RpcFailure {
    let (status, retryable) = match error.code.as_str() {
        "browser_operation_unknown" | "browser_operation_wrong_command" => {
            (StatusCode::BAD_REQUEST, false)
        }
        "browser_operation_too_large" => (StatusCode::PAYLOAD_TOO_LARGE, false),
        "browser_drive_forbidden" | "browser_submissions_disabled" => {
            (StatusCode::FORBIDDEN, false)
        }
        "browser_extension_offline"
        | "browser_extension_disconnected"
        | "browser_extension_backpressure" => (StatusCode::SERVICE_UNAVAILABLE, true),
        "browser_operation_timeout" => (StatusCode::GATEWAY_TIMEOUT, true),
        // Anything else is the extension's own answer about the page: the
        // operation reached it and was refused there.
        _ => (StatusCode::UNPROCESSABLE_ENTITY, false),
    };
    let body = super::rpc_error::RpcError::new(error.code, error.message);
    (
        status,
        axum::Json(if retryable { body.retryable() } else { body }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection(
        connection_id: &str,
    ) -> (
        Connection,
        mpsc::Receiver<Queued>,
        watch::Receiver<Option<CloseReason>>,
    ) {
        let (sender, receiver) = mpsc::channel(MAX_QUEUE_FRAMES);
        let (shutdown, shutdown_rx) = watch::channel(None);
        (
            Connection {
                connection_id: connection_id.to_string(),
                connected_at: 1,
                extension_version: "0.2.0".to_string(),
                features: vec!["drive".to_string()],
                sender,
                queue_bytes: Arc::new(Semaphore::new(MAX_QUEUE_BYTES)),
                pending: Arc::new(Mutex::new(HashMap::new())),
                shutdown,
            },
            receiver,
            shutdown_rx,
        )
    }

    #[test]
    fn a_newer_connection_replaces_the_older_and_fails_its_pending_calls() {
        let key = ("tenant-replace".to_string(), "browser-1".to_string());
        let (first, _first_rx, first_shutdown) = test_connection("c1");
        let (waiter, mut answer) = oneshot::channel();
        first.pending.lock().insert("op-1".to_string(), waiter);
        install(key.clone(), first);
        let (second, _second_rx, _) = test_connection("c2");
        install(key.clone(), second);
        assert_eq!(*first_shutdown.borrow(), Some(CloseReason::Replaced));
        assert_eq!(
            answer.try_recv().unwrap().unwrap_err().code,
            "browser_extension_replaced"
        );
        // Removing with the stale id leaves the newer connection installed.
        remove(&key.0, &key.1, "c1");
        assert!(CONNECTIONS.read().contains_key(&key));
        remove(&key.0, &key.1, "c2");
        assert!(!CONNECTIONS.read().contains_key(&key));
    }

    #[test]
    fn a_host_stop_closes_every_socket_as_going_away_and_fails_its_calls() {
        // A map of its own: the process-wide registry is shared with the
        // tests running beside this one, and stopping it would close theirs.
        let mut connections = HashMap::new();
        let mut shutdowns = Vec::new();
        let mut answers = Vec::new();
        for index in 0..2 {
            let (connection, _rx, shutdown) = test_connection(&format!("c-stop-{index}"));
            let (waiter, answer) = oneshot::channel();
            connection.pending.lock().insert("op-1".to_string(), waiter);
            connections.insert(
                ("tenant-stop".to_string(), format!("browser-stop-{index}")),
                connection,
            );
            shutdowns.push(shutdown);
            answers.push(answer);
        }
        close_all_for_stop(&connections);
        for shutdown in &shutdowns {
            assert_eq!(*shutdown.borrow(), Some(CloseReason::HostStopping));
        }
        for answer in &mut answers {
            assert_eq!(
                answer.try_recv().unwrap().unwrap_err().code,
                "browser_extension_disconnected"
            );
        }
    }

    #[test]
    fn the_queue_refuses_rather_than_blocks_when_the_browser_stalls() {
        let (sender, _receiver) = mpsc::channel(1);
        let budget = Arc::new(Semaphore::new(MAX_QUEUE_BYTES));
        enqueue(&sender, &budget, "a".to_string()).unwrap();
        let refused = enqueue(&sender, &budget, "b".to_string()).unwrap_err();
        assert_eq!(refused.code, "browser_extension_backpressure");
        let oversized = enqueue(&sender, &budget, "x".repeat(MAX_FRAME_BYTES + 1)).unwrap_err();
        assert_eq!(oversized.code, "browser_operation_too_large");
    }

    #[tokio::test]
    async fn an_unknown_operation_is_refused_before_anything_else() {
        let refused = call(
            "tenant-x",
            "browser-x",
            "run_shell",
            Value::Null,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, "browser_operation_unknown");
    }

    #[test]
    fn inbound_frames_parse_as_the_extension_sends_them() {
        let hello: Inbound = serde_json::from_str(
            r#"{"t":"hello","v":1,"extensionVersion":"0.2.0","features":["drive"]}"#,
        )
        .unwrap();
        assert!(matches!(hello, Inbound::Hello { v: 1, .. }));
        let result: Inbound =
            serde_json::from_str(r#"{"t":"result","id":"a","ok":false,"error":{"code":"browser_site_permission_required","message":"no"}}"#)
                .unwrap();
        match result {
            Inbound::Result { ok, error, .. } => {
                assert!(!ok);
                assert_eq!(error.unwrap().code, "browser_site_permission_required");
            }
            _ => panic!("expected a result"),
        }
        assert!(serde_json::from_str::<Inbound>(r#"{"t":"exec","cmd":"x"}"#).is_err());
    }

    /// Holds the process-global store lock and leaves no store installed on
    /// the way out, so suites asserting its absence are not made flaky.
    struct StoreScope(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

    impl Drop for StoreScope {
        fn drop(&mut self) {
            super::super::security_store::install_security_store(None);
        }
    }

    fn store_with_browser(
        tenant: &str,
        device: &str,
    ) -> (StoreScope, Arc<super::super::security_store::SecurityStore>) {
        let scope = StoreScope(super::super::security_store::test_guard());
        let store = super::super::security_store::SecurityStore::in_memory().expect("store");
        let challenge = store.issue_challenge(tenant, 100, 600).expect("challenge");
        let enrollment = store
            .create_browser_enrollment(tenant, "trust-root", 100, 600)
            .expect("enrollment");
        store
            .register_browser_device(
                tenant,
                &enrollment,
                &challenge.id,
                &challenge.nonce,
                device,
                "Chrome",
                "pem",
                &format!("thumb-{device}"),
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                100,
            )
            .expect("register browser");
        super::super::security_store::install_security_store(Some(store.clone()));
        (scope, store)
    }

    #[test]
    fn drive_is_granted_and_revoked_without_touching_the_other_grants() {
        let (_scope, store) = store_with_browser("tenant-d", "browser-d");
        let snapshot = || store.capability_snapshot("tenant-d", "browser-d").unwrap().unwrap();
        let before = snapshot();
        assert!(!before.iter().any(|c| c == DRIVE_CAPABILITY));

        set_drive_allowed("tenant-d", "browser-d", true).expect("grant");
        let granted = snapshot();
        assert!(granted.iter().any(|c| c == DRIVE_CAPABILITY));
        assert!(before.iter().all(|c| granted.contains(c)));

        set_drive_allowed("tenant-d", "browser-d", false).expect("revoke");
        let mut revoked = snapshot();
        let mut expected = before.clone();
        revoked.sort();
        expected.sort();
        assert_eq!(revoked, expected);

        assert!(set_drive_allowed("tenant-d", " ", true).is_err());
        let unknown = set_drive_allowed("tenant-d", "browser-unknown", true).unwrap_err();
        assert!(unknown.contains("unknown or revoked"), "{unknown}");
    }

    #[test]
    fn a_failed_operation_keeps_its_code_and_says_whose_problem_it_is() {
        let cases = [
            ("browser_operation_unknown", StatusCode::BAD_REQUEST, false),
            ("browser_operation_wrong_command", StatusCode::BAD_REQUEST, false),
            ("browser_operation_too_large", StatusCode::PAYLOAD_TOO_LARGE, false),
            ("browser_drive_forbidden", StatusCode::FORBIDDEN, false),
            ("browser_submissions_disabled", StatusCode::FORBIDDEN, false),
            ("browser_extension_offline", StatusCode::SERVICE_UNAVAILABLE, true),
            ("browser_extension_disconnected", StatusCode::SERVICE_UNAVAILABLE, true),
            ("browser_extension_backpressure", StatusCode::SERVICE_UNAVAILABLE, true),
            ("browser_operation_timeout", StatusCode::GATEWAY_TIMEOUT, true),
            // The extension's own refusal about the page.
            ("browser_ref_not_found", StatusCode::UNPROCESSABLE_ENTITY, false),
        ];
        for (code, status, retryable) in cases {
            let (got, body) = operation_error_response(OperationError::new(code, "why"));
            assert_eq!(got, status, "{code}");
            assert_eq!(body.code, code);
            assert_eq!(body.message, "why");
            assert_eq!(body.retryable, retryable, "{code}");
        }
    }

    #[tokio::test]
    async fn the_rpc_call_refuses_an_undriveable_browser_in_the_rpc_envelope() {
        // No browser here holds `browser.drive` (and Browser Access may be off
        // in this process): either way the refusal is the Owner's to lift.
        let (status, body) =
            rpc_call("browser-without-drive", "navigate", Value::Null, Some(1_000))
                .await
                .unwrap_err();
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(
            ["browser_drive_forbidden", "browser_submissions_disabled"]
                .contains(&body.code.as_str()),
            "{}",
            body.code
        );
        let (status, body) = rpc_call("browser-x", "run_shell", Value::Null, None)
            .await
            .unwrap_err();
        assert_eq!(
            (status, body.code.as_str()),
            (StatusCode::BAD_REQUEST, "browser_operation_unknown")
        );
    }

    #[test]
    fn every_read_operation_is_an_operation() {
        for operation in READ_OPERATIONS {
            assert!(OPERATIONS.contains(operation), "{operation}");
        }
        // The acting half is never empty, and the obvious actors are in it.
        for operation in ["act", "navigate", "set_files", "clear_cookies", "set_storage"] {
            assert!(!READ_OPERATIONS.contains(&operation), "{operation}");
        }
    }

    #[tokio::test]
    async fn each_rpc_command_refuses_the_other_half_of_the_vocabulary() {
        let (status, body) = rpc_call("browser-x", "snapshot", Value::Null, Some(1_000))
            .await
            .unwrap_err();
        assert_eq!(
            (status, body.code.as_str()),
            (StatusCode::BAD_REQUEST, "browser_operation_wrong_command")
        );
        let (status, body) = rpc_read("browser-x", "act", Value::Null, Some(1_000))
            .await
            .unwrap_err();
        assert_eq!(
            (status, body.code.as_str()),
            (StatusCode::BAD_REQUEST, "browser_operation_wrong_command")
        );
        // An unknown name is refused as unknown on either command.
        let (_, body) = rpc_read("browser-x", "run_shell", Value::Null, None)
            .await
            .unwrap_err();
        assert_eq!(body.code, "browser_operation_unknown");
    }

    #[test]
    fn the_operation_vocabulary_has_no_duplicates() {
        let mut names = OPERATIONS.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), OPERATIONS.len());
    }
}
