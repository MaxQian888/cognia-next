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

struct Connection {
    connection_id: String,
    connected_at: u64,
    extension_version: String,
    features: Vec<String>,
    sender: mpsc::Sender<Queued>,
    queue_bytes: Arc<Semaphore>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, OperationError>>>>>,
    shutdown: watch::Sender<bool>,
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
    let (shutdown, mut shutdown_rx) = watch::channel(false);
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
                if changed.is_err() || *shutdown_rx.borrow() {
                    close_with(&mut socket, CLOSE_POLICY_VIOLATION, "replaced by a newer connection").await;
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
        let _ = previous.shutdown.send(true);
        fail_pending(&previous.pending, "browser_extension_replaced");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection(
        connection_id: &str,
    ) -> (Connection, mpsc::Receiver<Queued>, watch::Receiver<bool>) {
        let (sender, receiver) = mpsc::channel(MAX_QUEUE_FRAMES);
        let (shutdown, shutdown_rx) = watch::channel(false);
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
        assert!(*first_shutdown.borrow());
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

    #[test]
    fn the_operation_vocabulary_has_no_duplicates() {
        let mut names = OPERATIONS.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), OPERATIONS.len());
    }
}
