//! Authenticated worker ingress for Agent RPC v2.
//!
//! The public socket authenticates a paired Companion device with a short-lived,
//! single-use ticket. It derives `host_ref` from that identity and multiplexes
//! opaque, newline-free Agent RPC frames through the existing brain bridge.
//! Task, run, lease, review, and lineage ownership remain in the brain.

use std::{collections::HashMap, time::Duration};

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tokio::time::{interval, Instant};

const WORKER_HELLO_VERSION: u32 = 1;
const MAX_WORKER_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_WORKER_QUEUE_FRAMES: usize = 64;
const MAX_WORKER_QUEUE_BYTES: usize = 32 * 1024 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_SECS: u64 = 25;
const IDLE_TIMEOUT_SECS: u64 = 90;
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

pub(crate) fn announce_all_workers() {
    let Some(tenant_id) = super::ws_bridge::current_brain_account_id() else {
        return;
    };
    let workers = WORKERS
        .read()
        .values()
        .filter(|worker| worker.tenant_id == tenant_id)
        .cloned()
        .collect::<Vec<_>>();
    for worker in workers {
        let _ = super::ws_bridge::send_worker_attach(
            worker.tenant_id,
            worker.connection_id,
            worker.host_ref,
            worker.manifest,
        );
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
    let _ = super::ws_bridge::send_worker_attach(
        tenant_id.clone(),
        connection_id.clone(),
        host_ref.clone(),
        manifest,
    );

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
                        if super::ws_bridge::send_worker_frame(tenant_id.clone(), connection_id.clone(), frame.to_string()).is_err() {
                            // The worker stays attached while the brain reconnects. Agent RPC frames
                            // only begin after the brain has observed `worker_attach`.
                            log::debug!("companion-api ws-worker: brain unavailable for worker frame");
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
                    detach_reason = "grant_revoked";
                    close_with(&mut socket, CLOSE_POLICY_VIOLATION, "agent.worker capability revoked").await;
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
        let _ = super::ws_bridge::send_worker_detach(
            tenant_id,
            connection_id,
            host_ref,
            detach_reason.to_string(),
        );
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
    }
    removed.is_some()
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
            created_at: 1,
            updated_at: 2,
            capabilities: vec!["agent.worker".to_string()],
        };
        let summaries = worker_device_summaries("tenant-a", vec![device]);
        let value = serde_json::to_value(&summaries[0]).unwrap();
        assert_eq!(value["hostRef"], derive_host_ref("tenant-a", "worker-a"));
        assert_eq!(value["deviceId"], "worker-a");
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
