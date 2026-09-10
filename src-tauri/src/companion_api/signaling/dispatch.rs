//! DataChannel ↔ `remote_execution` + `EventBus` bridge. ADR-0021.
//!
//! The pump writes to a [`DataCarrier`], never to a `PeerSession` directly:
//! the carrier picks the open DataChannel when there is one and the relay's
//! data lane otherwise (ADR-0170), so this module is carrier-blind and the
//! two paths cannot drift.
//!
//! Once a peer is present, this module's task owns the bidirectional message
//! pump:
//!
//! - **Inbound** (mobile → desktop): JSON envelope `{ id, method, params }`
//!   gets routed through the canonical `companion_api::remote_execution`
//!   allowlist. The response `{ id, ok, result | error }` is sent back
//!   over the same data channel.
//! - **Outbound** (desktop → mobile): the dispatcher subscribes to the
//!   `EventBus` and forwards every `EventFrame` as a JSON envelope
//!   `{ kind: "event", event, seq, payload }`. Consecutive same-channel frames
//!   inside a 50 ms window travel together as
//!   `{ kind: "event-batch", event, seq_from, seq_to, frames: [...] }`
//!   (ADR-0127 §2, `companion_api::event_batcher`); a lone frame keeps the
//!   plain shape. The mobile client tracks per-channel cursors on its end
//!   (see `lib/tauri/transport-rtc.ts`).
//!
//! The shared idempotency ledger is keyed by
//! `(device_id, method, idempotency_key)` and includes a parameter digest.
//! An RTC timeout followed by an HTTPS retry therefore cannot execute a write
//! twice or reuse a key for different parameters.

use std::collections::VecDeque;
use std::sync::Arc;

use futures_util::{future::BoxFuture, FutureExt};

use cognia_signaling_core::protocol::PROTOCOL_VERSION;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::carrier::DataCarrier;
use crate::companion_api::{
    event_batcher::{chunk_replay, EventBatcher},
    event_bus::EventFrame,
    middleware::DeviceContext,
    remote_execution::{self, ExecutionOutcome, ExecutionRequest, ExecutionTransport},
    security_store::security_store,
    SharedState,
};

/// Inbound DataChannel frame shape (mobile → desktop). Mirror of
/// `lib/tauri/transport-rtc.ts:RtcMessage`.
#[derive(Debug, Deserialize)]
pub struct InboundRpc {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    /// Optional idempotency key (UUID) supplied by mutating callers. The
    /// adapter passes it through to the durable ledger in
    /// `companion_api::remote_execution`, matching the HTTP path.
    #[serde(default, rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboundBinaryResource {
    kind: String,
    id: String,
    protocol_version: u8,
    resource: BinaryResourceRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinaryResourceRequest {
    kind: String,
    session_id: String,
    hash: String,
    variant: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BinaryResourceStart<'a> {
    kind: &'static str,
    id: &'a str,
    media_type: &'a str,
    total_bytes: usize,
    total_chunks: u32,
}

/// Outbound DataChannel frame shape (desktop → mobile).
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum OutboundFrame {
    Response(ResponseFrame),
    Event(EventOutbound),
    EventBatch(EventBatchOutbound),
}

/// ADR-0127 §2: several consecutive same-channel frames in one DataChannel
/// message. `frames` keeps the per-frame `EventOutbound` shape so the client
/// can feed each one through its existing single-frame handler.
#[derive(Debug, Serialize)]
pub struct EventBatchOutbound {
    /// Always `"event-batch"`.
    pub kind: &'static str,
    pub event: String,
    pub seq_from: u64,
    pub seq_to: u64,
    pub frames: Vec<EventOutbound>,
}

/// Encode one batch as an outbound frame: a lone frame is a plain `event`.
pub fn outbound_for_batch(batch: Vec<EventFrame>) -> Option<OutboundFrame> {
    let mut frames: Vec<EventOutbound> = batch
        .into_iter()
        .map(|frame| EventOutbound {
            kind: "event",
            event: frame.event_type,
            seq: frame.seq,
            payload: frame.payload,
        })
        .collect();
    match frames.len() {
        0 => None,
        1 => frames.pop().map(OutboundFrame::Event),
        _ => Some(OutboundFrame::EventBatch(EventBatchOutbound {
            kind: "event-batch",
            event: frames[0].event.clone(),
            seq_from: frames[0].seq,
            seq_to: frames[frames.len() - 1].seq,
            frames,
        })),
    }
}

#[derive(Debug, Serialize)]
pub struct ResponseFrame {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct EventOutbound {
    /// Always `"event"`. Discriminates this frame from a response.
    pub kind: &'static str,
    pub event: String,
    pub seq: u64,
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum EventControl {
    #[serde(rename = "event-resume")]
    Resume { since: u64 },
    #[serde(rename = "event-ack")]
    Ack { seq: u64 },
    /// Widen or narrow which channels this data channel receives. The WebRTC
    /// twin of the `/ws/events` `subscribe` frame, so a peer does not have to
    /// fall back to the WebSocket just to opt into a stream.
    #[serde(rename = "event-subscribe")]
    Subscribe(crate::companion_api::event_channels::SubscribeRequest),
}

const MAX_QUEUED_RPCS: usize = 64;
const MAX_PARALLEL_READS: usize = 8;

type RpcWork = BoxFuture<'static, Result<(), String>>;

/// Reads may progress alongside a slow mutation. Mutations start in arrival
/// order, one at a time. The JoinSet owns cancellation: dropping a dispatcher
/// aborts its active jobs rather than leaving detached peer work behind.
#[derive(Default)]
struct RpcWorkQueue {
    queued: VecDeque<(bool, RpcWork)>,
    running: tokio::task::JoinSet<(bool, Result<(), String>)>,
    reads: usize,
    mutation: bool,
    failed: bool,
}

impl RpcWorkQueue {
    fn is_full(&self) -> bool {
        self.queued.len() + self.running.len() >= MAX_QUEUED_RPCS
    }

    fn push(&mut self, read_only: bool, work: RpcWork) {
        self.queued.push_back((read_only, work));
        self.start_ready();
    }

    fn start_ready(&mut self) {
        while let Some(index) = self.queued.iter().position(|(read_only, _)| {
            if *read_only {
                self.reads < MAX_PARALLEL_READS
            } else {
                !self.mutation
            }
        }) {
            let (read_only, work) = self.queued.remove(index).expect("queued work exists");
            if read_only {
                self.reads += 1;
            } else {
                self.mutation = true;
            }
            self.running.spawn(async move {
                let result = std::panic::AssertUnwindSafe(work)
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| Err("RPC worker panicked".into()));
                (read_only, result)
            });
        }
    }

    async fn complete_next(&mut self) -> Option<Result<(), String>> {
        let outcome = self.running.join_next().await?;
        let result = match outcome {
            Ok((read_only, result)) => {
                if read_only {
                    self.reads -= 1;
                } else {
                    self.mutation = false;
                }
                result
            }
            Err(error) => {
                // A panicked task cannot report its class. Abort the queue so
                // a lost mutation slot never silently wedges later writes.
                self.running.abort_all();
                self.queued.clear();
                self.failed = true;
                return Some(Err(format!("RPC worker failed: {error}")));
            }
        };
        self.start_ready();
        Some(result)
    }
}

fn inbound_is_read_only(bytes: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    if value.get("kind").and_then(Value::as_str) == Some("binary-resource") {
        return true;
    }
    value
        .get("method")
        .and_then(Value::as_str)
        .and_then(crate::companion_api::command_manifest::descriptor)
        .is_some_and(|descriptor| {
            descriptor.operation == crate::companion_api::command_manifest::CommandOperation::Read
        })
}

/// Spawn the dispatcher task. The returned `JoinHandle` is cancelled by
/// dropping or aborting; consumers should keep it around for the lifetime
/// of the data channel.
pub fn spawn(
    carrier: Arc<DataCarrier>,
    inbound_data: mpsc::Receiver<Vec<u8>>,
    state: SharedState,
    device_id: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run(carrier, inbound_data, state, device_id))
}

async fn run(
    peer: Arc<DataCarrier>,
    mut inbound_data: mpsc::Receiver<Vec<u8>>,
    state: SharedState,
    device_id: String,
) {
    // Resolve the host the same way the HTTP RPC path does (ADR-0059 R5):
    // the desktop `AppHandle` when the WebView shell is up, else the headless
    // services registry `cognia-server` installs at boot. This used to be
    // hard-wired to `DispatchHost::Tauri(app)`, which made the whole WebRTC
    // tier unreachable from a headless install even though every other
    // companion transport already supported it.
    //
    // `None` (neither a WebView nor a headless registry — bare test states and
    // the `cognia-webrtc-peer` harness) is NOT a reason to drop frames: the
    // event-forwarding half below needs no host at all, and inbound RPCs get
    // the same structured `service_unavailable` the HTTP path returns.
    let host = crate::companion_api::dispatch_host::DispatchHost::from_state(&state);
    if host.is_none() {
        log::warn!(
            "signaling::dispatch: no dispatch host for device {device_id}; \
             events still forward, inbound RPCs answer service_unavailable"
        );
    }
    // Channels this data channel receives. WebRTC peers are always paired
    // devices — the loopback brain reaches the bus over `/internal/events`,
    // never over a peer connection — so `Device` is both correct and the
    // conservative reading if that ever stops being true.
    let mut subscription = crate::companion_api::event_channels::EventSubscription::defaults_for(
        crate::companion_api::event_channels::ConnectionScope::Device,
    );

    // Subscribe to EventBus with since=None → start at high-water mark
    // (matches the existing WS subscription default behaviour).
    use crate::companion_api::event_bus::SubscribeResult;
    let now_ms = crate::companion_api::signaling::envelope::now_ms();
    let mut event_rx = match state.event_bus.subscribe(None, now_ms) {
        SubscribeResult::Ok { receiver, .. } => receiver,
        SubscribeResult::ResyncRequired => {
            // None means "subscribe from the high-water mark", so resync
            // should be impossible here. Treat as a soft failure: log and
            // bail; the data channel stays alive for RPC-only traffic
            // until the peer reconnects (which forces a fresh subscribe).
            log::error!(
                "signaling::dispatch: event bus resync required at subscribe time; \
                 dispatcher will run RPC-only for device {device_id}"
            );
            return;
        }
    };
    // Event-plane lease for this data channel. WebRTC subscribes at the bus's
    // high-water mark, so there is no backlog to drain and the stream is ready
    // the moment the subscription exists.
    //
    // Nothing used to register a WebRTC peer as present at all: liveness lived
    // in a WebSocket-only refcount, so an RTC-only phone read as offline. It
    // collected a native push for every prompt already on its screen, and — once
    // attach leases started requiring a live event stream — could only ever
    // attach as an observer.
    let event_lease = crate::companion_api::event_leases::EventStreamLeaseGuard::open(
        &device_id,
        crate::companion_api::event_leases::EventStreamTransport::Rtc,
    );
    event_lease.advance(crate::companion_api::event_leases::EventStreamState::Ready);

    let mut reassembler =
        crate::companion_api::signaling::datachannel_framing::ChunkReassembler::default();
    // ADR-0127 §2: per-subscriber batching lives here, in the send loop.
    let mut batcher = EventBatcher::new();
    let mut rpc_work = RpcWorkQueue::default();

    loop {
        tokio::select! {
            biased;

            completed = rpc_work.complete_next(), if !rpc_work.running.is_empty() => {
                if let Some(Err(error)) = completed {
                    log::warn!("signaling::dispatch: inbound worker error: {error}");
                }
                if rpc_work.failed { break; }
            }

            // Batch window expired — flush what accumulated.
            _ = batch_window(batcher.deadline()) => {
                if let Some(batch) = batcher.take_due(tokio::time::Instant::now()) {
                    if let Some(outbound) = outbound_for_batch(batch) {
                        if let Err(e) = send_outbound(&peer, &outbound).await {
                            log::warn!(
                                "signaling::dispatch: forward event batch failed: {e}; data channel may be closed"
                            );
                        }
                    }
                }
            }

            maybe_inbound = inbound_data.recv() => {
                let Some(bytes) = maybe_inbound else { break };
                use crate::companion_api::signaling::datachannel_framing::ReassemblyResult;
                match reassembler.accept(
                    &bytes,
                    crate::companion_api::signaling::envelope::now_ms(),
                ) {
                    ReassemblyResult::Message { bytes, message_id } => {
                        if let Some(message_id) = message_id {
                            let _ = peer.send_bytes(
                                crate::companion_api::signaling::datachannel_framing::ack(&message_id)
                            ).await;
                        }
                        if let Ok(control) = serde_json::from_slice::<EventControl>(&bytes) {
                            match control {
                                EventControl::Resume { since } => {
                                    match state.event_bus.subscribe(
                                        Some(since),
                                        crate::companion_api::signaling::envelope::now_ms(),
                                    ) {
        SubscribeResult::Ok {
            receiver, replay, ..
        } => {
                                            event_rx = receiver;
                                            // Flush anything pending from the old
                                            // subscription before the replay burst.
                                            if let Some(pending) = batcher.drain() {
                                                if let Some(outbound) = outbound_for_batch(pending) {
                                                    let _ = send_outbound(&peer, &outbound).await;
                                                }
                                            }
                                            let visible: Vec<EventFrame> = replay
                                                .into_iter()
                                                .filter(|frame| {
                                                    frame.visible_to(&device_id)
                                                        && subscription.allows(&frame.event_type)
                                                })
                                                .collect();
                                            for batch in chunk_replay(visible) {
                                                let Some(outbound) = outbound_for_batch(batch) else {
                                                    continue;
                                                };
                                                if send_outbound(&peer, &outbound).await.is_err() {
                                                    break;
                                                }
                                            }
                                        }
                                        SubscribeResult::ResyncRequired => {
                                            if let Some(pending) = batcher.drain() {
                                                if let Some(outbound) = outbound_for_batch(pending) {
                                                    let _ = send_outbound(&peer, &outbound).await;
                                                }
                                            }
                                            let _ = peer.send_bytes(
                                                serde_json::to_vec(&json!({
                                                    "kind": "resync_required",
                                                    "domains": ["*"],
                                                    "cursor": state.event_bus.high_water_seq(),
                                                })).unwrap_or_default()
                                            ).await;
                                        }
                                    }
                                }
                                EventControl::Ack { seq } => {
                                    log::trace!(
                                        "signaling::dispatch: device {device_id} acked event seq {seq}"
                                    );
                                }
                                EventControl::Subscribe(request) => {
                                    let outcome = subscription.apply(&request);
                                    // ADR-0127: flush pending batched frames before
                                    // the control reply so a narrowing subscribe is
                                    // never followed by frames from a dropped channel.
                                    if let Some(pending) = batcher.drain() {
                                        if let Some(outbound) = outbound_for_batch(pending) {
                                            let _ = send_outbound(&peer, &outbound).await;
                                        }
                                    }
                                    // Answer with the resulting set, refusals
                                    // included. A peer that asked for a channel
                                    // it may not have needs to hear so, not to
                                    // wait on a stream that will never arrive.
                                    let _ = peer.send_bytes(
                                        serde_json::to_vec(&json!({
                                            "kind": "event-subscribed",
                                            "channels": outcome.channels,
                                            "rejected": outcome.rejected,
                                        })).unwrap_or_default()
                                    ).await;
                                }
                            }
                            continue;
                        }
                        if rpc_work.is_full() {
                            // Refuse admission before any side effect and preserve
                            // the request id so the caller can apply quota backoff.
                            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                                if let Some(id) = value.get("id").and_then(Value::as_str) {
                                    let response = OutboundFrame::Response(ResponseFrame {
                                        id: id.to_string(), ok: false, result: None,
                                        error: Some(ErrorBody {
                                            code: "rate_limited".into(),
                                            message: "peer execution queue full; retry_after_seconds=1".into(),
                                        }),
                                    });
                                    let _ = send_outbound(&peer, &response).await;
                                }
                            }
                            continue;
                        }
                        let read_only = inbound_is_read_only(&bytes);
                        let peer = peer.clone();
                        let state = state.clone();
                        let device_id = device_id.clone();
                        rpc_work.push(read_only, Box::pin(async move {
                            handle_inbound(&peer, bytes, &state, &device_id).await
                        }));
                    }
                    ReassemblyResult::Cancel { message_id, reason } => {
                        if !message_id.is_empty() {
                            let _ = peer.send_bytes(
                                crate::companion_api::signaling::datachannel_framing::cancel(
                                    &message_id,
                                    reason,
                                )
                            ).await;
                        }
                    }
                    ReassemblyResult::Ack | ReassemblyResult::Partial => {}
                }
            }

            recv_result = event_rx.recv() => {
                use tokio::sync::broadcast::error::RecvError;
                match recv_result {
                    Ok(frame) => {
                        if !frame.visible_to(&device_id)
                            || !subscription.allows(&frame.event_type)
                        {
                            continue;
                        }
                        for batch in batcher.push(frame, tokio::time::Instant::now()) {
                            let Some(outbound) = outbound_for_batch(batch) else { continue };
                            if let Err(e) = send_outbound(&peer, &outbound).await {
                                log::warn!(
                                    "signaling::dispatch: forward event failed: {e}; data channel may be closed"
                                );
                                // Drain remaining events but stop forwarding —
                                // the WS path will pick up once the DC is gone.
                            }
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        log::warn!(
                            "signaling::dispatch: lagged {n} frames; requiring explicit resync"
                        );
                        if let Some(pending) = batcher.drain() {
                            if let Some(outbound) = outbound_for_batch(pending) {
                                let _ = send_outbound(&peer, &outbound).await;
                            }
                        }
                        let _ = peer.send_bytes(
                            serde_json::to_vec(&json!({
                                "kind": "resync_required",
                                "domains": ["*"],
                                "cursor": state.event_bus.high_water_seq(),
                            })).unwrap_or_default()
                        ).await;
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        }
    }
}

/// Reject a frame whose `protocolVersion` this host does not speak, or `None`
/// when it does. Shaped like [`revocation_reject`] so the gate is reachable
/// from a test — `handle_inbound` itself needs a live peer and shared state.
fn protocol_version_reject(version: u8, request_id: &str) -> Option<OutboundFrame> {
    if version == PROTOCOL_VERSION {
        return None;
    }
    Some(OutboundFrame::Response(ResponseFrame {
        id: request_id.to_string(),
        ok: false,
        result: None,
        error: Some(ErrorBody {
            code: "unsupported_protocol".into(),
            message: format!("only RTC protocolVersion {PROTOCOL_VERSION} is supported"),
        }),
    }))
}

async fn handle_inbound(
    peer: &DataCarrier,
    bytes: Vec<u8>,
    state: &SharedState,
    device_id: &str,
) -> Result<(), String> {
    log::debug!(
        "signaling::dispatch: inbound {} bytes for device {device_id}",
        bytes.len()
    );
    let envelope: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("malformed inbound frame: {e}"))?;
    if envelope.get("kind").and_then(Value::as_str) == Some("binary-resource") {
        let request_id = envelope
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let request = match serde_json::from_value::<InboundBinaryResource>(envelope) {
            Ok(request) => request,
            Err(_) if uuid::Uuid::parse_str(&request_id).is_ok() => {
                return send_binary_resource_error(peer, request_id, "INVALID_PARAMS").await;
            }
            Err(_) => return Err("malformed binary resource request".to_string()),
        };
        return handle_binary_resource(peer, request, state, device_id).await;
    }
    let rpc: InboundRpc =
        serde_json::from_value(envelope).map_err(|e| format!("malformed inbound rpc: {e}"))?;
    log::debug!("signaling::dispatch: inbound rpc method={}", rpc.method);

    let request_id = rpc.id.clone();
    if let Some(frame) = protocol_version_reject(rpc.protocol_version, &request_id) {
        return send_outbound(peer, &frame).await.map_err(|e| e.to_string());
    }

    // Revocation parity with the HTTP path (`middleware.rs` step 4). The
    // DataChannel is bound to authenticated role keys, but unlike the HTTP JWT
    // middleware this path does not otherwise consult the deny list.
    if let Some(frame) = revocation_reject(&state.deny_list, device_id, &request_id) {
        return send_outbound(peer, &frame).await.map_err(|e| e.to_string());
    }

    let tenant_id = security_store()
        .ok_or_else(|| "security store unavailable".to_string())?
        .active_device_tenant(device_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "registered device principal unavailable".to_string())?;
    let principal = DeviceContext {
        device_id: device_id.to_string(),
        account_id: tenant_id,
        scope: "device".to_string(),
        granted_scopes: Vec::new(),
        authorization_capabilities: None,
    };
    let mut execution_request = ExecutionRequest::new(
        rpc.method,
        rpc.params,
        principal,
        ExecutionTransport::WebRtc,
        rpc.idempotency_key,
    );
    execution_request.request_id = request_id.clone();

    let outbound = match remote_execution::execute(state, execution_request).await {
        Ok(ExecutionOutcome::Completed { result, .. }) => OutboundFrame::Response(ResponseFrame {
            id: request_id,
            ok: true,
            result: Some(result),
            error: None,
        }),
        Ok(ExecutionOutcome::Accepted { operation_id, .. }) => {
            OutboundFrame::Response(ResponseFrame {
                id: request_id,
                ok: true,
                result: Some(json!({ "operationId": operation_id, "status": "running" })),
                error: None,
            })
        }
        Err(error) => OutboundFrame::Response(ResponseFrame {
            id: request_id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: error.code,
                message: error.detail,
            }),
        }),
    };

    send_outbound(peer, &outbound)
        .await
        .map_err(|e| e.to_string())
}

const MAX_BINARY_RESOURCE_BYTES: usize = 10 * 1024 * 1024;

async fn send_binary_resource_error(
    peer: &DataCarrier,
    request_id: String,
    code: &str,
) -> Result<(), String> {
    let frame = OutboundFrame::Response(ResponseFrame {
        id: request_id,
        ok: false,
        result: None,
        error: Some(ErrorBody {
            code: code.to_string(),
            message: "binary resource request failed".to_string(),
        }),
    });
    send_outbound(peer, &frame)
        .await
        .map_err(|error| error.to_string())
}

async fn handle_binary_resource(
    peer: &DataCarrier,
    request: InboundBinaryResource,
    state: &SharedState,
    device_id: &str,
) -> Result<(), String> {
    if request.kind != "binary-resource" || request.protocol_version != PROTOCOL_VERSION {
        return send_binary_resource_error(peer, request.id, "unsupported_protocol").await;
    }
    if uuid::Uuid::parse_str(&request.id).is_err()
        || request.resource.kind != "session-media"
        || request.resource.session_id.is_empty()
        || request.resource.session_id.len() > 512
        || request.resource.hash.len() != 64
        || !request
            .resource
            .hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !matches!(
            request.resource.variant.as_str(),
            "thumbnail" | "canonical" | "original"
        )
    {
        return send_binary_resource_error(peer, request.id, "INVALID_PARAMS").await;
    }
    // Tenant-agnostic on purpose: this path has no tenant until the
    // `active_device_tenant` lookup further down, and that lookup is strict
    // about `status = 'active'`, so a suspended or revoked device is refused
    // there regardless. See `DenyList::is_revoked_in_any_tenant`.
    if state.deny_list.is_revoked_in_any_tenant(device_id) {
        return send_binary_resource_error(peer, request.id, "device_revoked").await;
    }
    if !matches!(
        state.rate_limiter.check_class(
            device_id,
            crate::companion_api::rate_limit::RequestClass::MediaTransfer
        ),
        crate::companion_api::rate_limit::RateLimitDecision::Accept
    ) {
        return send_binary_resource_error(peer, request.id, "rate_limited").await;
    }
    let Some(data_plane) = crate::companion_api::data_plane::DataPlane::pick(state) else {
        return send_binary_resource_error(peer, request.id, "service_unavailable").await;
    };
    let media = match data_plane
        .session_media(
            request.resource.session_id,
            request.resource.hash,
            request.resource.variant,
        )
        .await
    {
        Ok(media) => media,
        Err(code) if matches!(code.as_str(), "MEDIA_NOT_FOUND" | "INVALID_PARAMS") => {
            return send_binary_resource_error(peer, request.id, &code).await;
        }
        Err(_) => {
            return send_binary_resource_error(peer, request.id, "service_unavailable").await;
        }
    };
    if media.bytes.len() > MAX_BINARY_RESOURCE_BYTES {
        return send_binary_resource_error(peer, request.id, "binary_resource_too_large").await;
    }
    // Chunk size follows the path the bytes will take: 32 KiB on a
    // DataChannel, 20 KiB through the relay (see `carrier.rs`). The peer
    // only checks that the announced count matches the chunk headers.
    let total_chunks = media
        .bytes
        .len()
        .max(1)
        .div_ceil(peer.binary_chunk_bytes().await) as u32;
    let start = BinaryResourceStart {
        kind: "binary-resource-start",
        id: &request.id,
        media_type: &media.media_type,
        total_bytes: media.bytes.len(),
        total_chunks,
    };
    peer.send_bytes(serde_json::to_vec(&start).map_err(|error| error.to_string())?)
        .await
        .map_err(|error| error.to_string())?;
    peer.send_binary_resource(&request.id, &media.bytes)
        .await
        .map_err(|error| error.to_string())
}

/// Build a `device_revoked` rejection frame for an inbound DataChannel RPC when
/// `device_id` is on the deny list, else `None`. Pure so the revocation parity
/// with the HTTP path is unit-testable without a live WebRTC peer.
fn revocation_reject(
    deny_list: &crate::companion_api::deny_list::DenyList,
    device_id: &str,
    request_id: &str,
) -> Option<OutboundFrame> {
    // See the note on the binary-resource gate above: no tenant is available
    // this early, and the authoritative per-tenant check follows immediately.
    if deny_list.is_revoked_in_any_tenant(device_id) {
        Some(OutboundFrame::Response(ResponseFrame {
            id: request_id.to_string(),
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: "device_revoked".into(),
                message: "this device has been revoked".into(),
            }),
        }))
    } else {
        None
    }
}

/// Sleep until the batch window closes; pends forever while idle so the
/// `select!` arm never fires spuriously.
async fn batch_window(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending::<()>().await,
    }
}

async fn send_outbound(
    peer: &DataCarrier,
    frame: &OutboundFrame,
) -> Result<(), super::peer::PeerSendError> {
    let bytes =
        serde_json::to_vec(frame).map_err(|e| super::peer::PeerSendError::Webrtc(e.to_string()))?;
    peer.send_bytes(bytes).await
}

// ---------------------------------------------------------------------------
// Internal helpers exposed for tests / introspection.
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub(super) fn encode_response_for_test(id: &str, result: Value) -> Vec<u8> {
    let frame = OutboundFrame::Response(ResponseFrame {
        id: id.to_string(),
        ok: true,
        result: Some(result),
        error: None,
    });
    serde_json::to_vec(&frame).expect("serialize")
}

#[allow(dead_code)]
pub(super) fn encode_event_for_test(event: &str, seq: u64, payload: Value) -> Vec<u8> {
    let frame = OutboundFrame::Event(EventOutbound {
        kind: "event",
        event: event.to_string(),
        seq,
        payload,
    });
    serde_json::to_vec(&frame).expect("serialize")
}

// Pre-allocate a no-op json call for tests that need a valid frame.
#[allow(dead_code)]
pub(super) fn empty_rpc_for_test(id: &str, method: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "id": id,
        "method": method,
        "params": {},
    }))
    .expect("serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn slow_mutation_does_not_block_reads_and_mutations_keep_order() {
        let mut queue = RpcWorkQueue::default();
        let (release, gate) = tokio::sync::oneshot::channel();
        let completed = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let first = completed.clone();
        queue.push(
            false,
            Box::pin(async move {
                let _ = gate.await;
                first.lock().push("first write");
                Ok(())
            }),
        );
        let second = completed.clone();
        queue.push(
            false,
            Box::pin(async move {
                second.lock().push("second write");
                Ok(())
            }),
        );
        let read = completed.clone();
        queue.push(
            true,
            Box::pin(async move {
                read.lock().push("read");
                Ok(())
            }),
        );
        tokio::time::timeout(std::time::Duration::from_secs(1), queue.complete_next())
            .await
            .expect("read cannot wait for slow mutation")
            .unwrap()
            .unwrap();
        assert_eq!(*completed.lock(), vec!["read"]);
        release.send(()).unwrap();
        queue.complete_next().await.unwrap().unwrap();
        queue.complete_next().await.unwrap().unwrap();
        assert_eq!(
            *completed.lock(),
            vec!["read", "first write", "second write"]
        );
    }

    #[tokio::test]
    async fn rpc_queue_bounds_parallel_reads_and_aborts_on_drop() {
        let mut queue = RpcWorkQueue::default();
        let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        struct Running(Arc<std::sync::atomic::AtomicUsize>);
        impl Drop for Running {
            fn drop(&mut self) {
                self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        for _ in 0..MAX_QUEUED_RPCS {
            let live = live.clone();
            queue.push(
                true,
                Box::pin(async move {
                    live.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _running = Running(live);
                    std::future::pending().await
                }),
            );
        }
        tokio::task::yield_now().await;
        assert!(queue.is_full());
        assert_eq!(
            live.load(std::sync::atomic::Ordering::SeqCst),
            MAX_PARALLEL_READS
        );
        drop(queue);
        tokio::task::yield_now().await;
        assert_eq!(live.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn panicked_mutation_releases_its_ordering_slot() {
        let mut queue = RpcWorkQueue::default();
        queue.push(false, Box::pin(async { panic!("test worker panic") }));
        queue.push(false, Box::pin(async { Ok(()) }));
        assert!(queue.complete_next().await.unwrap().is_err());
        assert!(queue.complete_next().await.unwrap().is_ok());
    }

    #[test]
    fn binary_reads_have_independent_transfer_quota() {
        let limiter = crate::companion_api::rate_limit::RateLimiter::with_defaults();
        for _ in 0..10 {
            let _ = limiter.check("media-reader");
        }
        assert!(matches!(
            limiter.check("media-reader"),
            crate::companion_api::rate_limit::RateLimitDecision::Reject { .. }
        ));
        for _ in 0..32 {
            assert!(matches!(
                limiter.check_class(
                    "media-reader",
                    crate::companion_api::rate_limit::RequestClass::MediaTransfer
                ),
                crate::companion_api::rate_limit::RateLimitDecision::Accept
            ));
        }
        assert!(inbound_is_read_only(br#"{"kind":"binary-resource"}"#));
        assert!(!inbound_is_read_only(br#"{"method":"unknown-write"}"#));
    }

    #[test]
    fn response_frame_serializes_ok() {
        let frame = OutboundFrame::Response(ResponseFrame {
            id: "rpc-1".into(),
            ok: true,
            result: Some(json!({"value": 42})),
            error: None,
        });
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""id":"rpc-1""#));
        assert!(text.contains(r#""ok":true"#));
        assert!(text.contains(r#""value":42"#));
        // The serializer omits `error` because of skip_serializing_if.
        assert!(!text.contains(r#""error""#));
    }

    #[test]
    fn response_frame_serializes_err() {
        let frame = OutboundFrame::Response(ResponseFrame {
            id: "rpc-2".into(),
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: "unknown_command".into(),
                message: "not exposed".into(),
            }),
        });
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""ok":false"#));
        assert!(text.contains(r#""code":"unknown_command""#));
        assert!(text.contains(r#""message":"not exposed""#));
        assert!(!text.contains(r#""result""#));
    }

    #[test]
    fn event_frame_serializes_with_kind_discriminator() {
        let frame = OutboundFrame::Event(EventOutbound {
            kind: "event",
            event: "claude://session-event".into(),
            seq: 7,
            payload: json!({"a": 1}),
        });
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""kind":"event""#));
        assert!(text.contains(r#""event":"claude://session-event""#));
        assert!(text.contains(r#""seq":7"#));
    }

    /// ADR-0127 §2: a batch of one stays a plain `event`; two or more become
    /// `event-batch` whose inner frames keep the per-frame shape.
    #[test]
    fn outbound_for_batch_keeps_single_frames_plain_and_envelopes_runs() {
        let mk = |seq: u64| EventFrame {
            event_type: "claude://message".into(),
            seq,
            payload: json!({ "seq": seq }),
            ts_ms: 0,
            target_device_id: None,
        };
        assert!(outbound_for_batch(vec![]).is_none());

        let one = serde_json::to_value(outbound_for_batch(vec![mk(3)]).unwrap()).unwrap();
        assert_eq!(one["kind"], "event");
        assert_eq!(one["seq"], 3);

        let many =
            serde_json::to_value(outbound_for_batch(vec![mk(3), mk(4), mk(6)]).unwrap()).unwrap();
        assert_eq!(many["kind"], "event-batch");
        assert_eq!(many["event"], "claude://message");
        assert_eq!(many["seq_from"], 3);
        assert_eq!(many["seq_to"], 6);
        let frames = many["frames"].as_array().unwrap();
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0]["kind"], "event");
        assert_eq!(frames[2]["seq"], 6);
        assert_eq!(frames[2]["payload"]["seq"], 6);
    }

    #[test]
    fn inbound_rpc_parses() {
        let raw =
            br#"{"id":"r1","method":"session_list","params":{"limit":50},"protocolVersion":2}"#;
        let rpc: InboundRpc = serde_json::from_slice(raw).unwrap();
        assert_eq!(rpc.id, "r1");
        assert_eq!(rpc.method, "session_list");
        assert_eq!(rpc.idempotency_key, None);
        assert_eq!(rpc.params["limit"], 50);
    }

    #[test]
    fn a_frame_from_another_protocol_version_is_refused() {
        // The version is not decoration: a client using an unsupported protocol version reaching the host must be
        // told so rather than having its params interpreted under the wrong
        // contract. Only the parse was covered before.
        let frame = protocol_version_reject(1, "r1").expect("v1 must be refused");
        let OutboundFrame::Response(body) = frame else {
            panic!("expected a response frame");
        };
        assert_eq!(body.id, "r1");
        assert!(!body.ok);
        assert_eq!(
            body.error.as_ref().map(|e| e.code.as_str()),
            Some("unsupported_protocol")
        );
    }

    #[test]
    fn the_supported_protocol_version_passes_the_gate() {
        assert!(protocol_version_reject(PROTOCOL_VERSION, "r1").is_none());
    }

    #[test]
    fn inbound_rpc_accepts_optional_idempotency_key() {
        let raw = br#"{"id":"r1","method":"claude_send","params":{},"idempotencyKey":"uuid","protocolVersion":2}"#;
        let rpc: InboundRpc = serde_json::from_slice(raw).unwrap();
        assert_eq!(rpc.idempotency_key.as_deref(), Some("uuid"));
        assert_eq!(rpc.protocol_version, 2);
    }

    // ── Revocation parity on the DataChannel path (P1-1 / C3) ──────────────

    #[test]
    fn revocation_reject_returns_none_for_active_device() {
        let deny = crate::companion_api::deny_list::DenyList::new();
        assert!(revocation_reject(&deny, "active-device", "req-1").is_none());
    }

    #[test]
    fn revocation_reject_builds_error_frame_for_revoked_device() {
        let deny = crate::companion_api::deny_list::DenyList::new();
        deny.revoke("tnt_alpha", "revoked-device");
        let frame = revocation_reject(&deny, "revoked-device", "req-2")
            .expect("a revoked device must be rejected on the DataChannel path too");
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""id":"req-2""#));
        assert!(text.contains(r#""ok":false"#));
        assert!(text.contains(r#""code":"device_revoked""#));
    }
}
