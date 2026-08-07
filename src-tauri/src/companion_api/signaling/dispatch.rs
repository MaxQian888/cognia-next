//! DataChannel ↔ `rpc::dispatch` + `EventBus` bridge. ADR-0021.
//!
//! Once a `PeerSession`'s data channel is open, this module's task owns
//! the bidirectional message pump:
//!
//! - **Inbound** (mobile → desktop): JSON envelope `{ id, method, params }`
//!   gets routed through the existing `companion_api::rpc::dispatch`
//!   allowlist. The response `{ id, ok, result | error }` is sent back
//!   over the same data channel.
//! - **Outbound** (desktop → mobile): the dispatcher subscribes to the
//!   `EventBus` and forwards every `EventFrame` as a JSON envelope
//!   `{ kind: "event", event, seq, payload }`. The mobile client tracks
//!   per-channel cursors on its end (see `lib/tauri/transport-rtc.ts`).
//!
//! The shared idempotency ledger is keyed by
//! `(device_id, method, idempotency_key)` and includes a parameter digest.
//! An RTC timeout followed by an HTTPS retry therefore cannot execute a write
//! twice or reuse a key for different parameters.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::peer::PeerSession;
use crate::companion_api::command_manifest::{self, CommandIdempotency};
use crate::companion_api::SharedState;

/// Inbound DataChannel frame shape (mobile → desktop). Mirror of
/// `lib/tauri/transport-rtc.ts:RtcMessage`.
#[derive(Debug, Deserialize)]
pub struct InboundRpc {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    /// Optional idempotency key (UUID) supplied by mutating callers. The
    /// dispatcher passes it through to the shared idempotency cache —
    /// see `companion_api::rpc::rpc_handler` for the matching behaviour
    /// on the HTTP path.
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
}

/// Spawn the dispatcher task. The returned `JoinHandle` is cancelled by
/// dropping or aborting; consumers should keep it around for the lifetime
/// of the data channel.
pub fn spawn(
    peer: Arc<PeerSession>,
    inbound_data: mpsc::Receiver<Vec<u8>>,
    state: SharedState,
    device_id: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run(peer, inbound_data, state, device_id))
}

async fn run(
    peer: Arc<PeerSession>,
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
    // Subscribe to EventBus with since=None → start at high-water mark
    // (matches the existing WS subscription default behaviour).
    use crate::companion_api::event_bus::SubscribeResult;
    let now_ms = crate::companion_api::signaling::envelope_v2::now_ms();
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
    let mut reassembler =
        crate::companion_api::signaling::datachannel_framing::ChunkReassembler::default();

    loop {
        tokio::select! {
            biased;

            maybe_inbound = inbound_data.recv() => {
                let Some(bytes) = maybe_inbound else { break };
                use crate::companion_api::signaling::datachannel_framing::ReassemblyResult;
                match reassembler.accept(
                    &bytes,
                    crate::companion_api::signaling::envelope_v2::now_ms(),
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
                                        crate::companion_api::signaling::envelope_v2::now_ms(),
                                    ) {
                                        SubscribeResult::Ok { receiver, replay } => {
                                            event_rx = receiver;
                                            for frame in replay {
                                                if !frame.visible_to(&device_id) {
                                                    continue;
                                                }
                                                let outbound = OutboundFrame::Event(EventOutbound {
                                                    kind: "event",
                                                    event: frame.event_type,
                                                    seq: frame.seq,
                                                    payload: frame.payload,
                                                });
                                                if send_outbound(&peer, &outbound).await.is_err() {
                                                    break;
                                                }
                                            }
                                        }
                                        SubscribeResult::ResyncRequired => {
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
                            }
                            continue;
                        }
                        if let Err(e) = handle_inbound(
                            &peer,
                            bytes,
                            &state,
                            host.as_ref(),
                            &device_id,
                        )
                        .await
                        {
                            log::warn!("signaling::dispatch: inbound handling error: {e}");
                        }
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
                        if !frame.visible_to(&device_id) {
                            continue;
                        }
                        let outbound = OutboundFrame::Event(EventOutbound {
                            kind: "event",
                            event: frame.event_type,
                            seq: frame.seq,
                            payload: frame.payload,
                        });
                        if let Err(e) = send_outbound(&peer, &outbound).await {
                            log::warn!(
                                "signaling::dispatch: forward event failed: {e}; data channel may be closed"
                            );
                            // Drain remaining events but stop forwarding —
                            // the WS path will pick up once the DC is gone.
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        log::warn!(
                            "signaling::dispatch: lagged {n} frames; requiring explicit resync"
                        );
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

/// The only RTC frame version this host speaks.
const RTC_PROTOCOL_VERSION: u8 = 2;

/// Reject a frame whose `protocolVersion` this host does not speak, or `None`
/// when it does. Shaped like [`revocation_reject`] so the gate is reachable
/// from a test — `handle_inbound` itself needs a live peer and shared state.
fn protocol_version_reject(version: u8, request_id: &str) -> Option<OutboundFrame> {
    if version == RTC_PROTOCOL_VERSION {
        return None;
    }
    Some(OutboundFrame::Response(ResponseFrame {
        id: request_id.to_string(),
        ok: false,
        result: None,
        error: Some(ErrorBody {
            code: "unsupported_protocol".into(),
            message: format!("only RTC protocolVersion {RTC_PROTOCOL_VERSION} is supported"),
        }),
    }))
}

fn idempotency_contract_reject(
    method: &str,
    idempotency_key: Option<&str>,
    request_id: &str,
) -> Option<OutboundFrame> {
    let descriptor = command_manifest::descriptor(method)?;
    let error = match descriptor.idempotency {
        CommandIdempotency::Required if idempotency_key.is_none_or(|key| key.trim().is_empty()) => {
            Some((
                "idempotency_required",
                "this command requires a non-empty idempotency key",
            ))
        }
        CommandIdempotency::Forbidden if idempotency_key.is_some() => Some((
            "idempotency_forbidden",
            "this command does not accept an idempotency key",
        )),
        _ => None,
    }?;

    Some(OutboundFrame::Response(ResponseFrame {
        id: request_id.to_string(),
        ok: false,
        result: None,
        error: Some(ErrorBody {
            code: error.0.into(),
            message: error.1.into(),
        }),
    }))
}

async fn handle_inbound(
    peer: &PeerSession,
    bytes: Vec<u8>,
    state: &SharedState,
    host: Option<&crate::companion_api::dispatch_host::DispatchHost>,
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

    // Revocation parity with the HTTP path (`middleware.rs` step 4). The v2
    // DataChannel is bound to authenticated role keys, but unlike the HTTP JWT
    // middleware this path does not otherwise consult the deny list.
    if let Some(frame) = revocation_reject(&state.deny_list, device_id, &request_id) {
        return send_outbound(peer, &frame).await.map_err(|e| e.to_string());
    }

    if let Some(frame) = rate_limit_reject(&state.rate_limiter, device_id, &request_id) {
        return send_outbound(peer, &frame).await.map_err(|e| e.to_string());
    }

    if let Some(frame) =
        idempotency_contract_reject(&rpc.method, rpc.idempotency_key.as_deref(), &request_id)
    {
        return send_outbound(peer, &frame).await.map_err(|e| e.to_string());
    }

    // Atomically reserve the write in the same ledger used by HTTPS.
    if let Some(key) = rpc.idempotency_key.as_deref() {
        let decision = state
            .idempotency
            .begin(device_id, &rpc.method, key, &rpc.params)
            .map_err(|error| error.to_string())?;
        let immediate = match decision {
            crate::companion_api::idempotency::IdempotencyDecision::Execute => None,
            crate::companion_api::idempotency::IdempotencyDecision::Cached(cached) => {
                Some(OutboundFrame::Response(ResponseFrame {
                    id: request_id.clone(),
                    ok: true,
                    result: Some(cached),
                    error: None,
                }))
            }
            crate::companion_api::idempotency::IdempotencyDecision::Conflict => {
                Some(OutboundFrame::Response(ResponseFrame {
                    id: request_id.clone(),
                    ok: false,
                    result: None,
                    error: Some(ErrorBody {
                        code: "idempotency_conflict".into(),
                        message: "the idempotency key was already used with different parameters"
                            .into(),
                    }),
                }))
            }
            crate::companion_api::idempotency::IdempotencyDecision::Indeterminate => {
                Some(OutboundFrame::Response(ResponseFrame {
                    id: request_id.clone(),
                    ok: false,
                    result: None,
                    error: Some(ErrorBody {
                        code: "idempotency_indeterminate".into(),
                        message: "the prior execution has no final result and will not be replayed"
                            .into(),
                    }),
                }))
            }
        };
        if let Some(outbound) = immediate {
            return send_outbound(peer, &outbound)
                .await
                .map_err(|error| error.to_string());
        }
    }

    // No host resolved (bare test state / harness peer). Mirror the HTTP
    // path's contract verbatim — `rpc::rpc_handler` maps the same condition to
    // `service_unavailable("app_handle not available (test mode)")` — so a
    // client sees one behaviour regardless of which transport it used.
    let Some(host) = host else {
        let frame = OutboundFrame::Response(ResponseFrame {
            id: request_id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: "service_unavailable".into(),
                message: "app_handle not available (test mode)".into(),
            }),
        });
        return send_outbound(peer, &frame).await.map_err(|e| e.to_string());
    };

    // Route through the existing dispatch table. `scope: None` — the
    // DataChannel is always device-scoped, so service-only (RCE-grade)
    // commands are unreachable over WebRTC by construction.
    let result = crate::companion_api::rpc::dispatch(
        &rpc.method,
        rpc.params,
        state,
        host,
        device_id,
        None,
        None,
    )
    .await;
    let outbound = match result {
        Ok(value) => {
            if let Some(key) = rpc.idempotency_key.as_deref() {
                state
                    .idempotency
                    .complete(device_id, &rpc.method, key, &value)
                    .map_err(|error| error.to_string())?;
            }
            OutboundFrame::Response(ResponseFrame {
                id: request_id,
                ok: true,
                result: Some(value),
                error: None,
            })
        }
        Err((_status, axum::Json(err))) => OutboundFrame::Response(ResponseFrame {
            id: request_id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: err.code,
                message: err.message,
            }),
        }),
    };

    send_outbound(peer, &outbound)
        .await
        .map_err(|e| e.to_string())
}

const MAX_BINARY_RESOURCE_BYTES: usize = 10 * 1024 * 1024;

async fn send_binary_resource_error(
    peer: &PeerSession,
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
    peer: &PeerSession,
    request: InboundBinaryResource,
    state: &SharedState,
    device_id: &str,
) -> Result<(), String> {
    if request.protocol_version != RTC_PROTOCOL_VERSION {
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
    if state.deny_list.is_revoked(device_id) {
        return send_binary_resource_error(peer, request.id, "device_revoked").await;
    }
    if !matches!(
        state.rate_limiter.check(device_id),
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
    let total_chunks = media
        .bytes
        .len()
        .max(1)
        .div_ceil(super::datachannel_framing::BINARY_RESOURCE_CHUNK_BYTES)
        as u32;
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
    if deny_list.is_revoked(device_id) {
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

fn rate_limit_reject(
    limiter: &crate::companion_api::rate_limit::RateLimiter,
    device_id: &str,
    request_id: &str,
) -> Option<OutboundFrame> {
    match limiter.check(device_id) {
        crate::companion_api::rate_limit::RateLimitDecision::Accept => None,
        crate::companion_api::rate_limit::RateLimitDecision::Reject { retry_after } => {
            Some(OutboundFrame::Response(ResponseFrame {
                id: request_id.to_string(),
                ok: false,
                result: None,
                error: Some(ErrorBody {
                    code: "rate_limited".into(),
                    message: format!(
                        "too many requests; retry after {} seconds",
                        retry_after.as_secs()
                    ),
                }),
            }))
        }
    }
}

async fn send_outbound(
    peer: &PeerSession,
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
        // The version is not decoration: a v1 client reaching a v2 host must be
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
        assert!(protocol_version_reject(RTC_PROTOCOL_VERSION, "r1").is_none());
    }

    #[test]
    fn inbound_rpc_accepts_optional_idempotency_key() {
        let raw = br#"{"id":"r1","method":"claude_send","params":{},"idempotencyKey":"uuid","protocolVersion":2}"#;
        let rpc: InboundRpc = serde_json::from_slice(raw).unwrap();
        assert_eq!(rpc.idempotency_key.as_deref(), Some("uuid"));
        assert_eq!(rpc.protocol_version, 2);
    }

    #[test]
    fn required_idempotency_is_enforced_before_dispatch() {
        let frame = idempotency_contract_reject("claude_send", None, "r1")
            .expect("mutating command without a key must be refused");
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""id":"r1""#));
        assert!(text.contains(r#""code":"idempotency_required""#));

        assert!(idempotency_contract_reject("claude_send", Some("uuid"), "r1").is_none());
    }

    #[test]
    fn an_empty_required_idempotency_key_is_refused() {
        let frame = idempotency_contract_reject("claude_send", Some("  "), "r1")
            .expect("blank keys cannot provide replay protection");
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""code":"idempotency_required""#));
    }

    #[test]
    fn data_channel_rate_limit_matches_the_http_device_bucket() {
        let limiter = crate::companion_api::rate_limit::RateLimiter::new(
            crate::companion_api::rate_limit::RateLimitConfig {
                capacity: 1.0,
                refill_per_sec: 0.001,
            },
        );
        assert!(rate_limit_reject(&limiter, "dev-1", "req-1").is_none());
        let frame = rate_limit_reject(&limiter, "dev-1", "req-2")
            .expect("second request must exhaust the shared device bucket");
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""code":"rate_limited""#));
        assert!(text.contains(r#""id":"req-2""#));
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
        deny.revoke("revoked-device".to_string());
        let frame = revocation_reject(&deny, "revoked-device", "req-2")
            .expect("a revoked device must be rejected on the DataChannel path too");
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""id":"req-2""#));
        assert!(text.contains(r#""ok":false"#));
        assert!(text.contains(r#""code":"device_revoked""#));
    }
}
