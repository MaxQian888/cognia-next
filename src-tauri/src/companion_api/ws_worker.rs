//! Authenticated worker ingress for Agent RPC v2.
//!
//! The public socket authenticates a paired Companion device with a short-lived,
//! single-use ticket. It derives `host_ref` from that identity and multiplexes
//! opaque, newline-free Agent RPC frames through the existing brain bridge.
//! Task, run, lease, review, and lineage ownership remain in the brain.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, Emitter};
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tokio::time::{interval, Instant};

const WORKER_HELLO_VERSION: u32 = 1;
const MAX_WORKER_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_WORKER_QUEUE_FRAMES: usize = 64;
const MAX_WORKER_QUEUE_BYTES: usize = 32 * 1024 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_SECS: u64 = 25;
const IDLE_TIMEOUT_SECS: u64 = 90;
/// Inbound (worker -> brain) budget for the in-process desktop brain.
///
/// The socket brain gets backpressure for free: frames leave through a TCP
/// connection, so a brain that stops reading stalls the worker's socket too.
/// A Tauri IPC channel has no such signal — `Channel::send` returns as soon as
/// the message is queued for the WebView — so the budget has to be explicit,
/// and the renderer releases it by acking the sequence numbers it has consumed.
const MAX_BRAIN_QUEUE_BYTES: usize = 32 * 1024 * 1024;
/// Cost charged for a lifecycle event, which carries no Agent RPC payload.
const BRAIN_EVENT_OVERHEAD_BYTES: usize = 1024;
/// How long a worker waits for the desktop brain to drain before it is detached.
///
/// Dropping an Agent RPC frame is not an option — the session's request/response
/// correlation would never recover — so a brain that stays blocked this long
/// costs the connection instead. The worker reconnects and ADR-0113 checkpoint
/// recovery resumes the run.
const BRAIN_BACKPRESSURE_TIMEOUT: Duration = Duration::from_secs(30);
const CLOSE_PROTOCOL_ERROR: u16 = 1002;
const CLOSE_POLICY_VIOLATION: u16 = 1008;

#[derive(Debug, Deserialize)]
pub struct WorkerSocketQuery {
    ticket: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WorkerHello {
    WorkerHello { v: u32, manifest: Value },
}

#[derive(Clone)]
struct WorkerConnection {
    connection_id: String,
    tenant_id: String,
    host_ref: String,
    manifest: Value,
    last_seen_at: u64,
    used_slots: u32,
    placement_ready: Option<bool>,
    placement_reason: Option<String>,
    sender: mpsc::Sender<QueuedWorkerMessage>,
    queue_bytes: std::sync::Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
}

struct QueuedWorkerMessage {
    message: Message,
    _byte_permit: OwnedSemaphorePermit,
}

#[derive(Clone)]
struct WorkerPresence {
    tenant_id: String,
    host_ref: String,
    manifest: Value,
    last_seen_at: u64,
    used_slots: u32,
    placement_ready: Option<bool>,
    placement_reason: Option<String>,
    online: bool,
}

static WORKERS: Lazy<RwLock<HashMap<String, WorkerConnection>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
static WORKER_HISTORY: Lazy<RwLock<HashMap<String, WorkerPresence>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub async fn ws_worker_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WorkerSocketQuery>,
    State(state): State<super::SharedState>,
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
    let binding =
        match store.redeem_socket_ticket(&query.ticket, "/ws/worker", "worker", unix_time_secs()) {
            Ok(binding) => binding,
            Err(_) => {
                return super::api::public_error_response(
                    StatusCode::UNAUTHORIZED,
                    "invalid_socket_ticket",
                    "worker socket ticket is invalid, expired, or already used",
                    false,
                    serde_json::json!({}),
                );
            }
        };
    if !worker_authorized(&binding.tenant_id, &binding.device_id) {
        return super::api::public_error_response(
            StatusCode::FORBIDDEN,
            "worker_access_forbidden",
            "the agent.worker capability is required",
            false,
            serde_json::json!({}),
        );
    }
    ws.max_message_size(MAX_WORKER_FRAME_BYTES)
        .max_frame_size(MAX_WORKER_FRAME_BYTES)
        .on_upgrade(move |socket| {
            handle_worker_socket(socket, binding.tenant_id, binding.device_id, state)
        })
        .into_response()
}

pub(crate) fn send_to_worker(
    tenant_id: &str,
    connection_id: &str,
    frame: String,
) -> Result<(), String> {
    validate_agent_rpc_frame(&frame)?;
    let (sender, queue_bytes) = WORKERS
        .read()
        .get(connection_id)
        .filter(|worker| worker.tenant_id == tenant_id)
        .map(|worker| {
            (
                worker.sender.clone(),
                std::sync::Arc::clone(&worker.queue_bytes),
            )
        })
        .ok_or_else(|| format!("worker connection is unavailable: {connection_id}"))?;
    let byte_permit = reserve_queue_bytes(queue_bytes, frame.len())?;
    sender
        .try_send(QueuedWorkerMessage {
            message: Message::Text(frame.into()),
            _byte_permit: byte_permit,
        })
        .map_err(|error| format!("worker connection backpressure: {error}"))
}

fn reserve_queue_bytes(
    queue_bytes: std::sync::Arc<Semaphore>,
    frame_bytes: usize,
) -> Result<OwnedSemaphorePermit, String> {
    let byte_count = u32::try_from(frame_bytes).map_err(|_| "worker frame is too large")?;
    queue_bytes
        .try_acquire_many_owned(byte_count)
        .map_err(|_| "worker connection byte budget exhausted".to_string())
}

// ---------------------------------------------------------------------------
// Brain sinks
//
// A worker's frames are useless until some brain owns dispatch for them. There
// are exactly two brains, and they are mutually exclusive: the headless `cognia
// serve` process, which attaches over the bridge socket, and the desktop
// WebView, which is in-process and reachable only through a Tauri IPC channel.
// Before this sink existed the ingress spoke only the first, so a desktop host
// accepted workers, showed them online in Fleet, and could never send them a
// single frame — every attach and frame was dropped by a `let _ =`.

/// One worker-lifecycle event on its way to whichever brain owns dispatch.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkerBrainEvent {
    #[serde(rename_all = "camelCase")]
    WorkerAttach {
        connection_id: String,
        host_ref: String,
        manifest: Value,
    },
    #[serde(rename_all = "camelCase")]
    WorkerFrame {
        connection_id: String,
        frame: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkerDetach {
        connection_id: String,
        host_ref: String,
        reason: String,
    },
}

impl WorkerBrainEvent {
    fn queue_cost(&self) -> usize {
        match self {
            WorkerBrainEvent::WorkerFrame { frame, .. } => frame.len(),
            _ => BRAIN_EVENT_OVERHEAD_BYTES,
        }
    }
}

/// Channel payload. `seq` is what the renderer acks to release its byte budget.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerBrainEnvelope {
    seq: u64,
    #[serde(flatten)]
    event: WorkerBrainEvent,
}

/// How a delivery attempt ended, because the two failures are not the same.
///
/// `NoBrain` is the ordinary state of a host nobody has attached a brain to
/// yet; the worker stays connected and waits. `Failed` means a brain *is*
/// attached and could not take the event, which for an Agent RPC frame is
/// unrecoverable — the connection has to go.
enum BrainDelivery {
    Delivered,
    NoBrain,
    Failed(String),
}

struct DesktopWorkerSink {
    tenant_id: String,
    channel: Channel<WorkerBrainEnvelope>,
    seq: AtomicU64,
    budget: Arc<Semaphore>,
    outstanding: Mutex<VecDeque<(u64, OwnedSemaphorePermit)>>,
}

impl DesktopWorkerSink {
    fn new(tenant_id: String, channel: Channel<WorkerBrainEnvelope>) -> Self {
        Self {
            tenant_id,
            channel,
            seq: AtomicU64::new(0),
            budget: Arc::new(Semaphore::new(MAX_BRAIN_QUEUE_BYTES)),
            outstanding: Mutex::new(VecDeque::new()),
        }
    }

    fn emit(&self, event: WorkerBrainEvent, permit: OwnedSemaphorePermit) -> Result<(), String> {
        // Sequence allocation, the send and the push happen under ONE lock.
        // This sink is shared by every worker connection of the tenant, and
        // `deliver_to_brain` runs concurrently from each connection's task —
        // two emits interleaving between `fetch_add` and `push_back` would
        // leave `outstanding` out of order, and `ack`'s front-pop drain stops
        // at the first entry above the watermark. The permits behind it stay
        // held even though the renderer has consumed their bytes.
        let mut outstanding = self.outstanding.lock();
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        // The permit is only retained once the send succeeded; a failed send
        // drops it here and returns the bytes rather than leaking the budget.
        self.channel
            .send(WorkerBrainEnvelope { seq, event })
            .map_err(|error| format!("desktop brain channel is unavailable: {error}"))?;
        outstanding.push_back((seq, permit));
        Ok(())
    }

    fn try_send(&self, event: WorkerBrainEvent) -> Result<(), String> {
        let cost = u32::try_from(event.queue_cost()).map_err(|_| "brain event is too large")?;
        let permit = Arc::clone(&self.budget)
            .try_acquire_many_owned(cost)
            .map_err(|_| "desktop brain queue byte budget exhausted".to_string())?;
        self.emit(event, permit)
    }

    async fn send(&self, event: WorkerBrainEvent) -> Result<(), String> {
        let cost = u32::try_from(event.queue_cost()).map_err(|_| "brain event is too large")?;
        let permit = match tokio::time::timeout(
            BRAIN_BACKPRESSURE_TIMEOUT,
            Arc::clone(&self.budget).acquire_many_owned(cost),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return Err("desktop brain queue is closed".to_string()),
            Err(_) => {
                return Err("desktop brain did not drain within the backpressure window".to_string())
            }
        };
        self.emit(event, permit)
    }

    /// Release every permit up to and including `through_seq`.
    fn ack(&self, through_seq: u64) {
        let mut outstanding = self.outstanding.lock();
        while outstanding
            .front()
            .is_some_and(|(seq, _)| *seq <= through_seq)
        {
            outstanding.pop_front();
        }
    }
}

static DESKTOP_SINK: Lazy<RwLock<Option<Arc<DesktopWorkerSink>>>> = Lazy::new(|| RwLock::new(None));

fn desktop_sink_for(tenant_id: &str) -> Option<Arc<DesktopWorkerSink>> {
    DESKTOP_SINK
        .read()
        .as_ref()
        .filter(|sink| sink.tenant_id == tenant_id)
        .map(Arc::clone)
}

/// The tenant whose workers the currently attached brain owns, if any.
fn attached_brain_tenant() -> Option<String> {
    DESKTOP_SINK
        .read()
        .as_ref()
        .map(|sink| sink.tenant_id.clone())
        .or_else(super::ws_bridge::current_brain_account_id)
}

fn deliver_to_socket_brain(tenant_id: &str, event: WorkerBrainEvent) -> BrainDelivery {
    let sent = match event {
        WorkerBrainEvent::WorkerAttach {
            connection_id,
            host_ref,
            manifest,
        } => super::ws_bridge::send_worker_attach(
            tenant_id.to_string(),
            connection_id,
            host_ref,
            manifest,
        ),
        WorkerBrainEvent::WorkerFrame {
            connection_id,
            frame,
        } => super::ws_bridge::send_worker_frame(tenant_id.to_string(), connection_id, frame),
        WorkerBrainEvent::WorkerDetach {
            connection_id,
            host_ref,
            reason,
        } => super::ws_bridge::send_worker_detach(
            tenant_id.to_string(),
            connection_id,
            host_ref,
            reason,
        ),
    };
    // A socket brain that is mid-reconnect is the `NoBrain` case, not a
    // failure: the worker stays attached and is re-announced on hello.
    match sent {
        Ok(()) => BrainDelivery::Delivered,
        Err(_) => BrainDelivery::NoBrain,
    }
}

/// Deliver one event to the attached brain, waiting for queue space if needed.
async fn deliver_to_brain(tenant_id: &str, event: WorkerBrainEvent) -> BrainDelivery {
    if let Some(sink) = desktop_sink_for(tenant_id) {
        return match sink.send(event).await {
            Ok(()) => BrainDelivery::Delivered,
            Err(reason) => BrainDelivery::Failed(reason),
        };
    }
    deliver_to_socket_brain(tenant_id, event)
}

/// Non-blocking delivery, used where the caller cannot await.
fn try_deliver_to_brain(tenant_id: &str, event: WorkerBrainEvent) -> BrainDelivery {
    if let Some(sink) = desktop_sink_for(tenant_id) {
        return match sink.try_send(event) {
            Ok(()) => BrainDelivery::Delivered,
            Err(reason) => BrainDelivery::Failed(reason),
        };
    }
    deliver_to_socket_brain(tenant_id, event)
}

/// Re-announce every live worker to whichever brain just attached.
///
/// This is a deliberate reset point: a brain that has just connected holds no
/// Agent RPC session state, so the pool tears down and rebuilds each worker's
/// client on re-attach. It is no longer gated on a *socket* brain existing —
/// that gate is what made the desktop host silently inert.
pub(crate) fn announce_all_workers() {
    let Some(tenant_id) = attached_brain_tenant() else {
        return;
    };
    let workers = WORKERS
        .read()
        .values()
        .filter(|worker| worker.tenant_id == tenant_id)
        .cloned()
        .collect::<Vec<_>>();
    for worker in workers {
        if let BrainDelivery::Failed(reason) = try_deliver_to_brain(
            &tenant_id,
            WorkerBrainEvent::WorkerAttach {
                connection_id: worker.connection_id,
                host_ref: worker.host_ref,
                manifest: worker.manifest,
            },
        ) {
            log::warn!("companion-api ws-worker: worker announce failed: {reason}");
        }
    }
}

pub(crate) fn fleet_hosts(tenant_id: &str) -> Vec<crate::fleet::registry::FleetHost> {
    let mut presence = WORKER_HISTORY
        .read()
        .values()
        .filter(|worker| worker.tenant_id == tenant_id)
        .cloned()
        .map(|worker| (worker.host_ref.clone(), worker))
        .collect::<HashMap<_, _>>();
    if let Some(store) = super::security_store::security_store() {
        if let Ok(devices) = store.list_worker_devices(tenant_id) {
            for device in devices {
                let host_ref = derive_host_ref(tenant_id, &device.device_id);
                presence.entry(host_ref.clone()).or_insert(WorkerPresence {
                    tenant_id: tenant_id.to_string(),
                    host_ref,
                    manifest: serde_json::json!({}),
                    last_seen_at: u64::try_from(device.updated_at)
                        .unwrap_or_default()
                        .saturating_mul(1_000),
                    used_slots: 0,
                    placement_ready: None,
                    placement_reason: None,
                    online: false,
                });
            }
        }
    }
    let mut hosts = presence
        .values()
        .map(|worker| {
            let max_active_turns = worker
                .manifest
                .get("maxActiveTurns")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            let workspace_binding_refs = worker
                .manifest
                .get("workspaceBindingRefs")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            crate::fleet::registry::FleetHost {
                host_ref: worker.host_ref.clone(),
                online: worker.online,
                max_active_turns,
                used_slots: Some(worker.used_slots),
                placement_ready: worker.placement_ready,
                placement_reason: worker.placement_reason.clone(),
                runtime: worker
                    .manifest
                    .get("runtime")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned(),
                workspace_binding_ready: !workspace_binding_refs.is_empty(),
                workspace_binding_refs,
                last_seen_at: worker.last_seen_at,
            }
        })
        .collect::<Vec<_>>();
    hosts.sort_by(|left, right| left.host_ref.cmp(&right.host_ref));
    hosts
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerLoadProjection {
    pub host_ref: String,
    pub used_slots: u32,
    pub placement_ready: Option<bool>,
    pub placement_reason: Option<String>,
}

pub(crate) fn project_worker_load(tenant_id: &str, loads: Vec<WorkerLoadProjection>) {
    let loads = loads
        .into_iter()
        .map(|load| (load.host_ref.clone(), load))
        .collect::<HashMap<_, _>>();
    for worker in WORKERS
        .write()
        .values_mut()
        .filter(|worker| worker.tenant_id == tenant_id)
    {
        if let Some(load) = loads.get(&worker.host_ref) {
            worker.used_slots = clamp_worker_load(&worker.manifest, load.used_slots);
            worker.placement_ready = load.placement_ready;
            worker.placement_reason = load.placement_reason.clone();
            if let Some(presence) = WORKER_HISTORY.write().get_mut(&worker.host_ref) {
                presence.used_slots = worker.used_slots;
                presence.placement_ready = worker.placement_ready;
                presence.placement_reason = worker.placement_reason.clone();
            }
        }
    }
}

fn clamp_worker_load(manifest: &Value, used_slots: u32) -> u32 {
    used_slots.min(
        manifest
            .get("maxActiveTurns")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
    )
}

fn touch_worker(connection_id: &str) {
    if let Some(worker) = WORKERS.write().get_mut(connection_id) {
        worker.last_seen_at = unix_time_millis();
        if let Some(presence) = WORKER_HISTORY.write().get_mut(&worker.host_ref) {
            presence.last_seen_at = worker.last_seen_at;
        }
    }
}

async fn handle_worker_socket(
    mut socket: WebSocket,
    tenant_id: String,
    device_id: String,
    state: super::SharedState,
) {
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, receive_worker_hello(&mut socket)).await {
        Ok(Ok(hello)) => hello,
        Ok(Err(reason)) => {
            close_with(&mut socket, CLOSE_PROTOCOL_ERROR, &reason).await;
            return;
        }
        Err(_) => {
            close_with(
                &mut socket,
                CLOSE_PROTOCOL_ERROR,
                "no worker hello within timeout",
            )
            .await;
            return;
        }
    };
    let WorkerHello::WorkerHello { manifest, .. } = hello;
    let connection_id = uuid::Uuid::new_v4().to_string();
    let host_ref = derive_host_ref(&tenant_id, &device_id);
    let (sender, mut outgoing) = mpsc::channel(MAX_WORKER_QUEUE_FRAMES);
    let (shutdown, mut shutdown_rx) = watch::channel(false);
    let connection = WorkerConnection {
        connection_id: connection_id.clone(),
        tenant_id: tenant_id.clone(),
        host_ref: host_ref.clone(),
        manifest: manifest.clone(),
        last_seen_at: unix_time_millis(),
        used_slots: 0,
        placement_ready: None,
        placement_reason: None,
        sender,
        queue_bytes: std::sync::Arc::new(Semaphore::new(MAX_WORKER_QUEUE_BYTES)),
        shutdown,
    };
    install_worker(connection);
    publish_fleet_update(&state, &tenant_id);
    if let BrainDelivery::Failed(reason) = deliver_to_brain(
        &tenant_id,
        WorkerBrainEvent::WorkerAttach {
            connection_id: connection_id.clone(),
            host_ref: host_ref.clone(),
            manifest,
        },
    )
    .await
    {
        // Same verdict as a refused frame, for a stronger reason: a brain that
        // never received the ATTACH does not know this connection exists, so it
        // can never dispatch to it. Serving on would leave the worker connected
        // and shown online in Fleet while being unreachable — exactly the state
        // this sink was written to remove — until the 90s idle timeout or the
        // next `announce_all_workers`. Drop it and let the worker reconnect.
        log::warn!("companion-api ws-worker: worker attach was refused by the brain: {reason}");
        close_with(
            &mut socket,
            CLOSE_POLICY_VIOLATION,
            "brain could not accept the worker attach",
        )
        .await;
        // No `worker_detach` follow-up: the brain has no record of a connection
        // it never saw attach, and the same sink would refuse it anyway.
        if remove_worker(&connection_id) {
            publish_fleet_update(&state, &tenant_id);
        }
        return;
    }

    let mut heartbeat = interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.tick().await;
    let mut authorization = interval(Duration::from_secs(1));
    authorization.tick().await;
    let idle_timeout = Duration::from_secs(IDLE_TIMEOUT_SECS);
    let mut last_activity = Instant::now();
    let mut detach_reason = "socket_closed";

    loop {
        tokio::select! {
            outgoing = outgoing.recv() => {
                match outgoing {
                    Some(queued) => {
                        if socket.send(queued.message).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(frame))) => {
                        last_activity = Instant::now();
                        touch_worker(&connection_id);
                        if validate_agent_rpc_frame(frame.as_str()).is_err() {
                            detach_reason = "invalid_frame";
                            close_with(&mut socket, CLOSE_PROTOCOL_ERROR, "invalid Agent RPC frame").await;
                            break;
                        }
                        match deliver_to_brain(
                            &tenant_id,
                            WorkerBrainEvent::WorkerFrame {
                                connection_id: connection_id.clone(),
                                frame: frame.to_string(),
                            },
                        )
                        .await
                        {
                            BrainDelivery::Delivered => {}
                            BrainDelivery::NoBrain => {
                                // The worker stays attached while the brain reconnects. Agent RPC frames
                                // only begin after the brain has observed `worker_attach`.
                                log::debug!("companion-api ws-worker: brain unavailable for worker frame");
                            }
                            BrainDelivery::Failed(reason) => {
                                // An attached brain that cannot take a frame has broken the session's
                                // request/response correlation; dropping the frame would strand every
                                // in-flight call, so the connection is closed and recovered instead.
                                log::warn!("companion-api ws-worker: brain refused a worker frame: {reason}");
                                detach_reason = "brain_backpressure";
                                close_with(&mut socket, CLOSE_POLICY_VIOLATION, "brain could not accept Agent RPC frames").await;
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        last_activity = Instant::now();
                        touch_worker(&connection_id);
                        if socket.send(Message::Pong(bytes)).await.is_err() { break; }
                    }
                    Some(Ok(Message::Pong(_))) => {
                        last_activity = Instant::now();
                        touch_worker(&connection_id);
                    },
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Binary(_))) => {
                        detach_reason = "invalid_frame";
                        close_with(&mut socket, CLOSE_PROTOCOL_ERROR, "worker socket accepts text frames only").await;
                        break;
                    }
                }
            }
            _ = heartbeat.tick() => {
                if last_activity.elapsed() > idle_timeout {
                    detach_reason = "idle_timeout";
                    break;
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
            _ = authorization.tick() => {
                if !worker_authorized(&tenant_id, &device_id) {
                    // Distinguish "the capability was taken away" from "the
                    // whole device was suspended or revoked": the worker's
                    // operator does different things about each, and both
                    // arrive here as the same `false`.
                    let (reason, message) = match super::security_store::security_store()
                        .and_then(|store| store.device_state(&tenant_id, &device_id).ok().flatten())
                    {
                        Some(super::security_store::DeviceLifecycleState::Suspended) => {
                            ("device_suspended", "this device is suspended")
                        }
                        Some(super::security_store::DeviceLifecycleState::Quarantined) => {
                            ("device_quarantined", "this device must be claimed again")
                        }
                        Some(super::security_store::DeviceLifecycleState::Active) => {
                            ("grant_revoked", "agent.worker capability revoked")
                        }
                        _ => ("device_revoked", "this device has been revoked"),
                    };
                    detach_reason = reason;
                    close_with(&mut socket, CLOSE_POLICY_VIOLATION, message).await;
                    break;
                }
            }
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    detach_reason = "replaced";
                    close_with(&mut socket, CLOSE_POLICY_VIOLATION, "replaced by a newer worker connection").await;
                    break;
                }
            }
        }
    }

    if remove_worker(&connection_id) {
        publish_fleet_update(&state, &tenant_id);
        if let BrainDelivery::Failed(reason) = deliver_to_brain(
            &tenant_id,
            WorkerBrainEvent::WorkerDetach {
                connection_id,
                host_ref,
                reason: detach_reason.to_string(),
            },
        )
        .await
        {
            log::warn!("companion-api ws-worker: worker detach was not delivered: {reason}");
        }
    }
}

fn publish_fleet_update(state: &super::SharedState, tenant_id: &str) {
    let mut payload =
        match serde_json::to_value(crate::fleet::runtime().snapshot_for_tenant(tenant_id)) {
            Ok(payload) => payload,
            Err(error) => {
                log::warn!("companion-api ws-worker: fleet snapshot serialization failed: {error}");
                return;
            }
        };
    let Some(object) = payload.as_object_mut() else {
        log::warn!("companion-api ws-worker: fleet snapshot did not serialize as an object");
        return;
    };
    object.insert("tenantId".to_string(), Value::String(tenant_id.to_string()));
    if let Some(app) = &state.app_handle {
        let _ = app.emit(crate::fleet::UPDATE_EVENT, payload);
    } else {
        state
            .event_bus
            .publish(crate::fleet::UPDATE_EVENT.to_string(), payload);
    }
}

/// An attached worker can be dispatched to at any moment, so the host that
/// accepted it must stay awake. Sleeping here drops the socket, expires the
/// run lease, and shows the team a host that was online seconds ago.
fn hold_host_awake(host_ref: &str) {
    crate::power_assertion::acquire(crate::power_assertion::WakeReason::AttachedWorker(
        host_ref.to_string(),
    ));
}

fn release_host_awake(host_ref: &str) {
    crate::power_assertion::release(&crate::power_assertion::WakeReason::AttachedWorker(
        host_ref.to_string(),
    ));
}

fn install_worker(connection: WorkerConnection) {
    WORKER_HISTORY.write().insert(
        connection.host_ref.clone(),
        WorkerPresence {
            tenant_id: connection.tenant_id.clone(),
            host_ref: connection.host_ref.clone(),
            manifest: connection.manifest.clone(),
            last_seen_at: connection.last_seen_at,
            used_slots: connection.used_slots,
            placement_ready: connection.placement_ready,
            placement_reason: connection.placement_reason.clone(),
            online: true,
        },
    );
    hold_host_awake(&connection.host_ref);
    let replaced = {
        let mut workers = WORKERS.write();
        let previous_id = workers
            .values()
            .find(|worker| worker.host_ref == connection.host_ref)
            .map(|worker| worker.connection_id.clone());
        let previous = previous_id.and_then(|id| workers.remove(&id));
        workers.insert(connection.connection_id.clone(), connection);
        previous
    };
    if let Some(previous) = replaced {
        release_host_awake(&previous.host_ref);
        let _ = previous.shutdown.send(true);
    }
}

fn remove_worker(connection_id: &str) -> bool {
    let removed = WORKERS.write().remove(connection_id);
    if let Some(worker) = &removed {
        if let Some(presence) = WORKER_HISTORY.write().get_mut(&worker.host_ref) {
            presence.online = false;
            presence.last_seen_at = worker.last_seen_at;
            presence.used_slots = 0;
        }
        release_host_awake(&worker.host_ref);
    }
    removed.is_some()
}

// ---------------------------------------------------------------------------
// Desktop brain commands
//
// The desktop brain lives in the WebView, so its half of the worker bridge is a
// pair of Tauri commands rather than a socket. `attach` installs the IPC channel
// and immediately replays the live roster; `send_frame` reuses the same
// per-connection byte budget the socket brain writes through, so outbound
// backpressure is identical on both hosts.

/// Attach the in-process brain and replay the live worker roster onto it.
///
/// `tenant_id` is the renderer's active account. The WebView is inside the
/// trust boundary — it can already invoke every command in the app — so this is
/// an addressing parameter, not an authorization one; worker authorization is
/// still enforced per connection against the security store.
#[tauri::command]
pub async fn companion_worker_attach_channel(
    tenant_id: String,
    on_event: Channel<WorkerBrainEnvelope>,
) -> Result<(), String> {
    if tenant_id.is_empty() {
        return Err("tenant id is required".to_string());
    }
    let previous = DESKTOP_SINK
        .write()
        .replace(Arc::new(DesktopWorkerSink::new(tenant_id, on_event)));
    if previous.is_some() {
        log::info!("companion-api ws-worker: replacing the attached desktop brain channel");
    }
    announce_all_workers();
    Ok(())
}

/// Detach the in-process brain. Workers stay connected and wait for a new one.
#[tauri::command]
pub async fn companion_worker_detach_channel() -> Result<(), String> {
    DESKTOP_SINK.write().take();
    Ok(())
}

/// Send one Agent RPC frame from the desktop brain to a worker.
#[tauri::command]
pub async fn companion_worker_send_frame(
    tenant_id: String,
    connection_id: String,
    frame: String,
) -> Result<(), String> {
    send_to_worker(&tenant_id, &connection_id, frame)
}

/// Release the inbound byte budget for everything up to `through_seq`.
///
/// Without this the desktop brain's queue would be a pure fire-and-forget push
/// and a fast worker could grow the WebView's message backlog without bound.
#[tauri::command]
pub async fn companion_worker_ack_events(through_seq: u64) -> Result<(), String> {
    let sink = DESKTOP_SINK.read().as_ref().map(Arc::clone);
    match sink {
        Some(sink) => {
            sink.ack(through_seq);
            Ok(())
        }
        None => Err("no desktop brain is attached".to_string()),
    }
}

/// Wake a worker host that is offline but has told us how to reach its NIC.
///
/// Placement rejects an offline worker and the run waits. For a machine that is
/// merely asleep that is a self-fulfilling verdict — nothing wakes it, so it
/// stays offline. The retained presence record still holds the manifest from
/// its last connection, which is where the MAC came from.
///
/// Best-effort by contract: `Ok(true)` means a magic packet left this host, not
/// that anything woke up. Wake-on-LAN also has to be enabled in the worker's
/// firmware, which nothing here can verify.
#[tauri::command]
pub async fn companion_wake_worker(tenant_id: String, host_ref: String) -> Result<bool, String> {
    let manifest = WORKER_HISTORY
        .read()
        .values()
        .find(|worker| worker.tenant_id == tenant_id && worker.host_ref == host_ref)
        .map(|worker| worker.manifest.clone())
        .ok_or_else(|| format!("no worker presence for {host_ref}"))?;
    let Some(wake) = manifest.get("wake") else {
        return Ok(false);
    };
    let broadcast = wake.get("broadcastAddress").and_then(Value::as_str);
    let macs = wake
        .get("macAddresses")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    if macs.is_empty() {
        return Ok(false);
    }
    let mut woke = false;
    for mac in macs {
        match crate::wake_on_lan::wake(mac, broadcast) {
            Ok(()) => woke = true,
            Err(error) => log::debug!("companion-api ws-worker: wake failed for {mac}: {error}"),
        }
    }
    Ok(woke)
}

pub(crate) fn derive_host_ref(tenant_id: &str, device_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update((tenant_id.len() as u64).to_be_bytes());
    digest.update(tenant_id.as_bytes());
    digest.update((device_id.len() as u64).to_be_bytes());
    digest.update(device_id.as_bytes());
    format!("device:{}", hex::encode(digest.finalize()))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDeviceSummary {
    #[serde(flatten)]
    device: super::security_store::DeviceSummary,
    host_ref: String,
}

pub(crate) fn worker_device_summaries(
    tenant_id: &str,
    devices: Vec<super::security_store::DeviceSummary>,
) -> Vec<WorkerDeviceSummary> {
    devices
        .into_iter()
        .map(|device| WorkerDeviceSummary {
            host_ref: derive_host_ref(tenant_id, &device.device_id),
            device,
        })
        .collect()
}

async fn receive_worker_hello(socket: &mut WebSocket) -> Result<WorkerHello, String> {
    let message = socket
        .recv()
        .await
        .ok_or_else(|| "worker socket closed before hello".to_string())?
        .map_err(|error| format!("receive worker hello: {error}"))?;
    let Message::Text(text) = message else {
        return Err("worker hello must be a text frame".to_string());
    };
    let hello: WorkerHello = serde_json::from_str(text.as_str())
        .map_err(|error| format!("invalid worker hello: {error}"))?;
    let WorkerHello::WorkerHello { v, manifest } = &hello;
    if *v != WORKER_HELLO_VERSION {
        return Err(format!("unsupported worker hello version: {v}"));
    }
    validate_manifest(manifest)?;
    Ok(hello)
}

fn validate_manifest(manifest: &Value) -> Result<(), String> {
    let object = manifest
        .as_object()
        .ok_or_else(|| "worker manifest must be an object".to_string())?;
    if object.get("manifestVersion").and_then(Value::as_u64) != Some(1) {
        return Err("worker manifest manifestVersion must be 1".to_string());
    }
    if !object
        .get("maxActiveTurns")
        .and_then(Value::as_u64)
        .is_some_and(|value| value > 0)
    {
        return Err("worker manifest maxActiveTurns must be positive".to_string());
    }
    Ok(())
}

fn validate_agent_rpc_frame(frame: &str) -> Result<(), String> {
    if frame.is_empty() || frame.len() > MAX_WORKER_FRAME_BYTES {
        return Err("Agent RPC frame size is invalid".to_string());
    }
    if frame.contains('\n') || frame.contains('\r') {
        return Err("Agent RPC frame must not contain newlines".to_string());
    }
    Ok(())
}

fn worker_authorized(tenant_id: &str, device_id: &str) -> bool {
    super::security_store::security_store()
        .and_then(|store| {
            store
                .has_capability(tenant_id, device_id, "agent.worker")
                .ok()
        })
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
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn unix_time_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_minimal_worker_manifest_and_rejects_self_reported_host_identity() {
        let valid = serde_json::json!({
            "type": "worker_hello",
            "v": 1,
            "manifest": { "manifestVersion": 1, "maxActiveTurns": 1 }
        });
        let hello: WorkerHello = serde_json::from_value(valid).unwrap();
        let WorkerHello::WorkerHello { manifest, .. } = hello;
        assert!(validate_manifest(&manifest).is_ok());

        let spoofed = serde_json::json!({
            "type": "worker_hello",
            "v": 1,
            "hostRef": "attacker-selected",
            "manifest": { "manifestVersion": 1, "maxActiveTurns": 1 }
        });
        assert!(serde_json::from_value::<WorkerHello>(spoofed).is_err());
    }

    #[test]
    fn agent_rpc_multiplex_accepts_one_json_line_per_websocket_frame() {
        assert!(validate_agent_rpc_frame(r#"{"jsonrpc":"2.0","id":1}"#).is_ok());
        assert!(validate_agent_rpc_frame("{}\n{}").is_err());
        assert!(validate_agent_rpc_frame("").is_err());
        assert!(validate_agent_rpc_frame(&"x".repeat(MAX_WORKER_FRAME_BYTES)).is_ok());
        assert!(validate_agent_rpc_frame(&"x".repeat(MAX_WORKER_FRAME_BYTES + 1)).is_err());
    }

    #[test]
    fn worker_load_never_exceeds_manifest_capacity() {
        let manifest = serde_json::json!({ "maxActiveTurns": 1 });
        assert_eq!(clamp_worker_load(&manifest, 3), 1);
        assert_eq!(clamp_worker_load(&serde_json::json!({}), 3), 0);
    }

    #[test]
    fn worker_load_projects_readiness_to_live_and_retained_hosts() {
        // `install_worker` / `remove_worker` take and drop a power-assertion
        // hold as a side effect, and that state is process-global. Without this
        // lock the assertion suite intermittently observes this test's holder.
        let _guard = crate::power_assertion::ASSERTION_TEST_LOCK.lock();
        let tenant_id = "tenant-placement-projection";
        let connection_id = "connection-placement-projection";
        let host_ref = "device:placement-projection";
        let (sender, _receiver) = mpsc::channel(1);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        install_worker(WorkerConnection {
            connection_id: connection_id.to_string(),
            tenant_id: tenant_id.to_string(),
            host_ref: host_ref.to_string(),
            manifest: serde_json::json!({
                "runtime": "cognia-agent",
                "maxActiveTurns": 2,
                "workspaceBindingRefs": ["repository:project:repo"]
            }),
            last_seen_at: 1,
            used_slots: 0,
            placement_ready: None,
            placement_reason: None,
            sender,
            queue_bytes: std::sync::Arc::new(Semaphore::new(MAX_WORKER_QUEUE_BYTES)),
            shutdown,
        });

        project_worker_load(
            tenant_id,
            vec![WorkerLoadProjection {
                host_ref: host_ref.to_string(),
                used_slots: 1,
                placement_ready: Some(false),
                placement_reason: Some("workspace_missing".to_string()),
            }],
        );
        let live = fleet_hosts(tenant_id);
        assert_eq!(live[0].used_slots, Some(1));
        assert_eq!(live[0].placement_ready, Some(false));
        assert_eq!(
            live[0].placement_reason.as_deref(),
            Some("workspace_missing")
        );

        assert!(remove_worker(connection_id));
        let retained = fleet_hosts(tenant_id);
        assert!(!retained[0].online);
        assert_eq!(retained[0].placement_ready, Some(false));
        assert_eq!(
            retained[0].placement_reason.as_deref(),
            Some("workspace_missing")
        );
        WORKER_HISTORY.write().remove(host_ref);
    }

    #[test]
    fn host_identity_is_stable_and_tenant_scoped() {
        assert_eq!(
            derive_host_ref("tenant-a", "same-device"),
            derive_host_ref("tenant-a", "same-device")
        );
        assert_ne!(
            derive_host_ref("tenant-a", "same-device"),
            derive_host_ref("tenant-b", "same-device")
        );
        assert!(!derive_host_ref("tenant-a", "same-device").contains("tenant-a"));
    }

    #[test]
    fn management_summary_carries_the_same_derived_host_identity_as_ingress() {
        let device = super::super::security_store::DeviceSummary {
            device_id: "worker-a".to_string(),
            display_name: "Worker A".to_string(),
            role: "member".to_string(),
            status: "active".to_string(),
            user_id: None,
            created_at: 1,
            updated_at: 2,
            capabilities: vec!["agent.worker".to_string()],
        };
        let summaries = worker_device_summaries("tenant-a", vec![device]);
        let value = serde_json::to_value(&summaries[0]).unwrap();
        assert_eq!(value["hostRef"], derive_host_ref("tenant-a", "worker-a"));
        assert_eq!(value["deviceId"], "worker-a");
    }

    fn test_sink(
        tenant_id: &str,
    ) -> (
        Arc<DesktopWorkerSink>,
        tauri::ipc::Channel<WorkerBrainEnvelope>,
    ) {
        let channel = Channel::new(|_| Ok(()));
        let sink = Arc::new(DesktopWorkerSink::new(
            tenant_id.to_string(),
            channel.clone(),
        ));
        (sink, channel)
    }

    #[test]
    fn brain_events_serialize_as_a_tagged_envelope_the_renderer_can_switch_on() {
        // The TS side matches on `type` and acks `seq`. A shape change here is a
        // silent protocol break: the renderer would drop every envelope and the
        // host would stall on an unreleased byte budget.
        let envelope = WorkerBrainEnvelope {
            seq: 4,
            event: WorkerBrainEvent::WorkerFrame {
                connection_id: "connection-1".to_string(),
                frame: "{}".to_string(),
            },
        };
        let value = serde_json::to_value(&envelope).unwrap();
        assert_eq!(value["seq"], 4);
        assert_eq!(value["type"], "worker_frame");
        assert_eq!(value["connectionId"], "connection-1");

        let attach = serde_json::to_value(WorkerBrainEnvelope {
            seq: 1,
            event: WorkerBrainEvent::WorkerAttach {
                connection_id: "connection-1".to_string(),
                host_ref: "device:a".to_string(),
                manifest: serde_json::json!({ "manifestVersion": 1 }),
            },
        })
        .unwrap();
        assert_eq!(attach["type"], "worker_attach");
        assert_eq!(attach["hostRef"], "device:a");

        let detach = serde_json::to_value(WorkerBrainEnvelope {
            seq: 2,
            event: WorkerBrainEvent::WorkerDetach {
                connection_id: "connection-1".to_string(),
                host_ref: "device:a".to_string(),
                reason: "idle_timeout".to_string(),
            },
        })
        .unwrap();
        assert_eq!(detach["type"], "worker_detach");
        assert_eq!(detach["reason"], "idle_timeout");
    }

    #[test]
    fn desktop_brain_queue_is_bounded_and_released_by_renderer_acks() {
        // `Channel::send` is fire-and-forget, so without this budget a fast
        // worker would grow the WebView's backlog without bound.
        let (sink, _channel) = test_sink("tenant-budget");
        let frame = "x".repeat(MAX_BRAIN_QUEUE_BYTES / 2);

        assert!(sink
            .try_send(WorkerBrainEvent::WorkerFrame {
                connection_id: "connection-1".to_string(),
                frame: frame.clone(),
            })
            .is_ok());
        assert!(sink
            .try_send(WorkerBrainEvent::WorkerFrame {
                connection_id: "connection-1".to_string(),
                frame: frame.clone(),
            })
            .is_ok());
        assert!(sink
            .try_send(WorkerBrainEvent::WorkerFrame {
                connection_id: "connection-1".to_string(),
                frame: "one more".to_string(),
            })
            .is_err());

        // Acks are cumulative: releasing through seq 2 frees both frames.
        sink.ack(2);
        assert!(sink
            .try_send(WorkerBrainEvent::WorkerFrame {
                connection_id: "connection-1".to_string(),
                frame: "one more".to_string(),
            })
            .is_ok());
    }

    #[test]
    fn an_ack_below_the_watermark_releases_nothing() {
        let (sink, _channel) = test_sink("tenant-partial-ack");
        let frame = "x".repeat(MAX_BRAIN_QUEUE_BYTES / 2);
        sink.try_send(WorkerBrainEvent::WorkerFrame {
            connection_id: "connection-1".to_string(),
            frame: frame.clone(),
        })
        .unwrap();
        sink.try_send(WorkerBrainEvent::WorkerFrame {
            connection_id: "connection-1".to_string(),
            frame,
        })
        .unwrap();

        sink.ack(0);

        assert!(sink
            .try_send(WorkerBrainEvent::WorkerFrame {
                connection_id: "connection-1".to_string(),
                frame: "still blocked".to_string(),
            })
            .is_err());
    }

    #[test]
    fn a_desktop_brain_takes_priority_over_the_socket_brain_for_its_own_tenant() {
        // The two brains are mutually exclusive by design — delivering to both
        // would give one worker connection two Agent RPC clients.
        let tenant_id = "tenant-routing";
        let (sink, _channel) = test_sink(tenant_id);
        DESKTOP_SINK.write().replace(Arc::clone(&sink));

        assert!(desktop_sink_for(tenant_id).is_some());
        assert!(desktop_sink_for("tenant-other").is_none());
        assert_eq!(attached_brain_tenant().as_deref(), Some(tenant_id));

        DESKTOP_SINK.write().take();
        assert!(desktop_sink_for(tenant_id).is_none());
    }

    #[test]
    fn outbound_queue_enforces_a_total_byte_budget() {
        let budget = std::sync::Arc::new(Semaphore::new(MAX_WORKER_QUEUE_BYTES));
        let first = reserve_queue_bytes(std::sync::Arc::clone(&budget), MAX_WORKER_FRAME_BYTES)
            .expect("first frame");
        let second = reserve_queue_bytes(std::sync::Arc::clone(&budget), MAX_WORKER_FRAME_BYTES)
            .expect("second frame");
        assert!(reserve_queue_bytes(std::sync::Arc::clone(&budget), 1).is_err());
        drop(first);
        assert!(reserve_queue_bytes(std::sync::Arc::clone(&budget), 1).is_ok());
        drop(second);
    }
}
