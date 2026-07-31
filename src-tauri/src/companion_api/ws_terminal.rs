//! Authenticated LAN adapter for the durable terminal host.
//!
//! A paired client first obtains a short-lived, single-use, device-bound
//! socket ticket through the authenticated Companion channel, then opens
//! `GET /ws/terminal?ticket=…`. The WebSocket carries only canonical binary
//! terminal frames; PTY/session ownership remains in `cognia-server
//! desktop-host` and therefore survives this process or UI disconnecting.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Extension, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine;
use cognia_terminal::host::{ClientIdentity, HostSessionInfo};
use cognia_terminal::host_wire::{read_frame, write_frame};
use cognia_terminal::protocol::{
    FrameKind, TerminalErrorCode, TerminalFrame, HEADER_LEN, MAX_FRAME_PAYLOAD,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use uuid::Uuid;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;

use super::{middleware::DeviceContext, SharedState};

const TICKET_TTL: Duration = Duration::from_secs(60);
const MAX_TICKETS: usize = 256;
const MAX_WS_FRAME_BYTES: usize = HEADER_LEN + MAX_FRAME_PAYLOAD;
const TERMINAL_DATACHANNEL_QUEUE_CAPACITY: usize = 128;

#[derive(Clone)]
struct TicketBinding {
    device_id: String,
    expires_at: Instant,
}

#[derive(Default)]
struct TerminalTicketStore {
    inner: Mutex<HashMap<[u8; 32], TicketBinding>>,
}

impl TerminalTicketStore {
    fn issue(
        &self,
        device_id: &str,
        remote_access_enabled: bool,
    ) -> Result<TerminalSocketTicket, String> {
        if !remote_access_enabled {
            return Err("remote terminal access is disabled on this host".into());
        }
        if !device_allowed_for_terminal(device_id) {
            return Err("remote terminal permission is required".into());
        }
        let now = Instant::now();
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.retain(|_, binding| binding.expires_at > now);
        if inner.len() >= MAX_TICKETS {
            return Err("too many pending terminal socket tickets".into());
        }
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let ticket = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        inner.insert(
            ticket_digest(&ticket),
            TicketBinding {
                device_id: device_id.to_string(),
                expires_at: now + TICKET_TTL,
            },
        );
        Ok(TerminalSocketTicket {
            ticket,
            expires_at: chrono::Utc::now()
                .timestamp_millis()
                .saturating_add(TICKET_TTL.as_millis() as i64),
        })
    }

    fn consume(&self, ticket: &str, remote_access_enabled: bool) -> Result<TicketBinding, String> {
        if !remote_access_enabled {
            return Err("remote terminal access is disabled on this host".into());
        }
        if ticket.len() > 256 {
            return Err("terminal socket ticket is invalid".into());
        }
        let now = Instant::now();
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let binding = inner
            .remove(&ticket_digest(ticket))
            .ok_or_else(|| "terminal socket ticket is invalid or already used".to_string())?;
        if binding.expires_at <= now {
            return Err("terminal socket ticket expired".into());
        }
        if !device_allowed_for_terminal(&binding.device_id) {
            return Err("remote terminal permission was revoked".into());
        }
        Ok(binding)
    }
}

static TERMINAL_TICKETS: once_cell::sync::Lazy<TerminalTicketStore> =
    once_cell::sync::Lazy::new(TerminalTicketStore::default);

fn ticket_digest(ticket: &str) -> [u8; 32] {
    Sha256::digest(ticket.as_bytes()).into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSocketTicket {
    ticket: String,
    expires_at: i64,
}

/// Authenticated endpoint used before the unauthenticated WebSocket upgrade.
pub async fn issue_ticket_handler(
    Extension(context): Extension<DeviceContext>,
) -> impl IntoResponse {
    let remote_access_enabled =
        crate::terminal_host_service::terminal_remote_access_enabled().await;
    match TERMINAL_TICKETS.issue(&context.device_id, remote_access_enabled) {
        Ok(ticket) => (StatusCode::OK, Json(serde_json::json!(ticket))),
        Err(message) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "code": "permission_denied",
                "message": message,
            })),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub struct TerminalSocketQuery {
    ticket: String,
}

pub async fn ws_terminal_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<TerminalSocketQuery>,
    State(state): State<SharedState>,
) -> Response {
    let remote_access_enabled =
        crate::terminal_host_service::terminal_remote_access_enabled().await;
    let binding = match TERMINAL_TICKETS.consume(&query.ticket, remote_access_enabled) {
        Ok(binding) => binding,
        Err(message) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "code": "unauthorized",
                    "message": message,
                })),
            )
                .into_response();
        }
    };
    ws.max_message_size(MAX_WS_FRAME_BYTES)
        .max_frame_size(MAX_WS_FRAME_BYTES)
        .on_upgrade(move |socket| proxy_terminal_socket(socket, binding.device_id, state))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyTerminalQuery {
    #[serde(default)]
    spawn: Option<String>,
    session_id: Option<String>,
    #[serde(default)]
    resume_from: Option<u64>,
}

/// Compatibility adapter for the released `/ws/v1/terminal` protocol.
/// Authentication remains the route's device-JWT middleware; after upgrade,
/// frames are translated to the durable host protocol so the legacy client no
/// longer owns an in-process PTY or a separate replay registry.
pub async fn legacy_ws_terminal_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<LegacyTerminalQuery>,
    State(state): State<SharedState>,
    Extension(context): Extension<DeviceContext>,
) -> Response {
    if !crate::terminal_host_service::terminal_remote_access_enabled().await
        || !device_allowed_for_terminal(&context.device_id)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "code": "permission_denied",
                "message": "remote terminal access is disabled or not granted",
            })),
        )
            .into_response();
    }
    ws.max_message_size(MAX_WS_FRAME_BYTES)
        .max_frame_size(MAX_WS_FRAME_BYTES)
        .on_upgrade(move |socket| {
            proxy_legacy_terminal_socket(socket, query, context.device_id, state)
        })
}

async fn proxy_legacy_terminal_socket(
    mut socket: WebSocket,
    query: LegacyTerminalQuery,
    device_id: String,
    state: SharedState,
) {
    let identity = ClientIdentity::remote(
        format!("legacy-companion:{device_id}"),
        device_id.clone(),
        true,
    );
    let mut host_stream = match crate::terminal_host_bridge::connect_terminal_host_client(
        state.app_handle.as_ref(),
        identity,
    )
    .await
    {
        Ok(stream) => stream,
        Err(message) => {
            let _ = send_legacy_error(&mut socket, &message).await;
            return;
        }
    };
    let mut sequence = 1u64;
    let initial = if query.spawn.as_deref() == Some("1") {
        TerminalFrame::command(
            FrameKind::Spawn,
            Uuid::nil(),
            sequence,
            serde_json::to_vec(&serde_json::json!({ "profileId": "default" })).unwrap_or_default(),
        )
    } else if let Some(session_id) = query.session_id.as_deref() {
        let Ok(session_id) = Uuid::parse_str(session_id) else {
            let _ = send_legacy_error(&mut socket, "invalid terminal session id").await;
            return;
        };
        TerminalFrame::command(
            FrameKind::Attach,
            session_id,
            sequence,
            serde_json::to_vec(&serde_json::json!({
                "resumeAfter": query.resume_from.unwrap_or(0),
            }))
            .unwrap_or_default(),
        )
    } else {
        let _ = send_legacy_error(&mut socket, "missing spawn=1 or sessionId").await;
        return;
    };
    let snapshot = match legacy_host_request(&mut host_stream, initial).await {
        Ok(frame) => frame,
        Err(message) => {
            let _ = send_legacy_error(&mut socket, &message).await;
            return;
        }
    };
    let session: HostSessionInfo = match serde_json::from_slice(&snapshot.payload) {
        Ok(session) => session,
        Err(error) => {
            let _ =
                send_legacy_error(&mut socket, &format!("invalid host snapshot: {error}")).await;
            return;
        }
    };
    let session_id = match Uuid::parse_str(&session.id) {
        Ok(id) => id,
        Err(_) => {
            let _ = send_legacy_error(&mut socket, "invalid host session id").await;
            return;
        }
    };
    let ready = serde_json::json!({
        "kind": "ready",
        "sessionId": session.id,
        "shell": session.shell,
        "deviceId": device_id,
    });
    if socket
        .send(Message::Text(ready.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    let (mut host_reader, mut host_writer) = tokio::io::split(host_stream);
    let mut authorization_check = tokio::time::interval(Duration::from_secs(1));
    authorization_check.tick().await;
    loop {
        tokio::select! {
            _ = authorization_check.tick() => {
                if !terminal_remote_client_authorized(&device_id).await {
                    let _ = send_legacy_error(&mut socket, "remote terminal permission was revoked").await;
                    break;
                }
            }
            frame = read_frame(&mut host_reader) => {
                match frame {
                    Ok(Some(frame)) => {
                        if forward_legacy_host_frame(&mut socket, frame).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = send_legacy_error(&mut socket, &error).await;
                        break;
                    }
                }
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break; };
                let command = match message {
                    Message::Binary(bytes) => Some((FrameKind::Stdin, bytes.to_vec())),
                    Message::Text(text) => legacy_control_command(text.as_str()),
                    Message::Ping(bytes) => {
                        if socket.send(Message::Pong(bytes)).await.is_err() { break; }
                        None
                    }
                    Message::Pong(_) => None,
                    Message::Close(_) => break,
                };
                if let Some((kind, payload)) = command {
                    sequence = sequence.saturating_add(1);
                    if write_frame(
                        &mut host_writer,
                        &TerminalFrame::command(kind, session_id, sequence, payload),
                    )
                    .await
                    .is_err()
                    {
                        break;
                    }
                }
            }
        }
    }
}

async fn legacy_host_request(
    stream: &mut crate::terminal_host_service::BoxedTerminalHostIo,
    request: TerminalFrame,
) -> Result<TerminalFrame, String> {
    let sequence = request.sequence;
    write_frame(stream, &request).await?;
    loop {
        let frame = read_frame(stream)
            .await?
            .ok_or_else(|| "terminal host closed before responding".to_string())?;
        if frame.sequence != sequence {
            continue;
        }
        if frame.kind == FrameKind::Error {
            let value: serde_json::Value = serde_json::from_slice(&frame.payload)
                .map_err(|error| format!("invalid terminal host error: {error}"))?;
            return Err(value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("terminal host rejected the request")
                .to_string());
        }
        if matches!(frame.kind, FrameKind::SessionSnapshot) {
            return Ok(frame);
        }
    }
}

fn legacy_control_command(text: &str) -> Option<(FrameKind, Vec<u8>)> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    match value.get("kind")?.as_str()? {
        "resize" => Some((
            FrameKind::Resize,
            serde_json::to_vec(&serde_json::json!({
                "rows": value.get("rows").and_then(serde_json::Value::as_u64).unwrap_or(24).clamp(1, u16::MAX as u64),
                "cols": value.get("cols").and_then(serde_json::Value::as_u64).unwrap_or(80).clamp(1, u16::MAX as u64),
            }))
            .ok()?,
        )),
        "kill" => Some((FrameKind::Kill, Vec::new())),
        _ => None,
    }
}

async fn forward_legacy_host_frame(socket: &mut WebSocket, frame: TerminalFrame) -> Result<(), ()> {
    let message = match frame.kind {
        FrameKind::Stdout => Some(Message::Binary(frame.payload.into())),
        FrameKind::Integration => {
            let event: serde_json::Value =
                serde_json::from_slice(&frame.payload).map_err(|_| ())?;
            Some(Message::Text(
                serde_json::json!({ "kind": "integration", "event": event, "seq": frame.sequence })
                    .to_string()
                    .into(),
            ))
        }
        FrameKind::Exit => {
            let payload: serde_json::Value =
                serde_json::from_slice(&frame.payload).map_err(|_| ())?;
            Some(Message::Text(
                serde_json::json!({
                    "kind": "exit",
                    "code": payload.get("code").cloned().unwrap_or(serde_json::Value::Null),
                    "seq": frame.sequence,
                })
                .to_string()
                .into(),
            ))
        }
        FrameKind::Error => {
            let payload: serde_json::Value =
                serde_json::from_slice(&frame.payload).map_err(|_| ())?;
            Some(Message::Text(
                serde_json::json!({
                    "kind": "error",
                    "message": payload.get("message").and_then(serde_json::Value::as_str).unwrap_or("terminal host error"),
                })
                .to_string()
                .into(),
            ))
        }
        _ => None,
    };
    if let Some(message) = message {
        socket.send(message).await.map_err(|_| ())?;
    }
    Ok(())
}

async fn send_legacy_error(socket: &mut WebSocket, message: &str) -> Result<(), ()> {
    socket
        .send(Message::Text(
            serde_json::json!({ "kind": "error", "message": message })
                .to_string()
                .into(),
        ))
        .await
        .map_err(|_| ())
}

fn device_allowed_for_terminal(device_id: &str) -> bool {
    !device_id.is_empty() && super::control_allow_list::terminal_global().is_allowed(device_id)
}

async fn proxy_terminal_socket(mut socket: WebSocket, device_id: String, state: SharedState) {
    let identity =
        ClientIdentity::remote(format!("companion:{device_id}"), device_id.clone(), true);
    let app = state.app_handle.as_ref();
    let host_stream =
        match crate::terminal_host_bridge::connect_terminal_host_client(app, identity).await {
            Ok(stream) => stream,
            Err(message) => {
                let _ = send_protocol_error(&mut socket, TerminalErrorCode::HostOffline, &message)
                    .await;
                return;
            }
        };
    let (mut host_reader, mut host_writer) = tokio::io::split(host_stream);
    let mut authorization_check = tokio::time::interval(Duration::from_secs(1));
    authorization_check.tick().await;

    loop {
        tokio::select! {
            _ = authorization_check.tick() => {
                if !terminal_remote_client_authorized(&device_id).await {
                    let _ = send_protocol_error(
                        &mut socket,
                        TerminalErrorCode::PermissionDenied,
                        "remote terminal permission was revoked",
                    ).await;
                    break;
                }
            }
            host_frame = read_frame(&mut host_reader) => {
                match host_frame {
                    Ok(Some(frame)) => {
                        let bytes = match frame.encode() {
                            Ok(bytes) => bytes,
                            Err(error) => {
                                let _ = send_protocol_error(
                                    &mut socket,
                                    TerminalErrorCode::InvalidRequest,
                                    &error.to_string(),
                                ).await;
                                break;
                            }
                        };
                        if socket.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = send_protocol_error(
                            &mut socket,
                            TerminalErrorCode::HostOffline,
                            &error,
                        ).await;
                        break;
                    }
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Binary(bytes))) => {
                        let frame = match TerminalFrame::decode(&bytes) {
                            Ok(frame) => frame,
                            Err(error) => {
                                let _ = send_protocol_error(
                                    &mut socket,
                                    TerminalErrorCode::InvalidRequest,
                                    &error.to_string(),
                                ).await;
                                break;
                            }
                        };
                        if write_frame(&mut host_writer, &frame).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        if socket.send(Message::Pong(bytes)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Text(_))) => {
                        let _ = send_protocol_error(
                            &mut socket,
                            TerminalErrorCode::InvalidRequest,
                            "terminal WebSocket accepts binary protocol frames only",
                        ).await;
                        break;
                    }
                }
            }
        }
    }
}

async fn terminal_remote_client_authorized(device_id: &str) -> bool {
    crate::terminal_host_service::terminal_remote_access_enabled().await
        && device_allowed_for_terminal(device_id)
}

enum TerminalDataChannelEvent {
    Binary(Vec<u8>),
    Text,
    Closed,
}

/// Authenticated WAN adapter for the durable terminal host. Signaling binds
/// the peer to `device_id`; the independent terminal grant remains mandatory
/// and is rechecked while the attachment is live for immediate revocation.
pub(crate) async fn proxy_terminal_datachannel(
    channel: std::sync::Arc<RTCDataChannel>,
    device_id: String,
    state: SharedState,
) {
    if !terminal_remote_client_authorized(&device_id).await {
        let _ = send_datachannel_protocol_error(
            &channel,
            TerminalErrorCode::PermissionDenied,
            "remote terminal permission is required",
        )
        .await;
        let _ = channel.close().await;
        return;
    }

    let identity =
        ClientIdentity::remote(format!("companion:{device_id}"), device_id.clone(), true);
    let app = state.app_handle.as_ref();
    let host_stream = match crate::terminal_host_bridge::connect_terminal_host_client(app, identity)
        .await
    {
        Ok(stream) => stream,
        Err(message) => {
            let _ =
                send_datachannel_protocol_error(&channel, TerminalErrorCode::HostOffline, &message)
                    .await;
            let _ = channel.close().await;
            return;
        }
    };
    let (mut host_reader, mut host_writer) = tokio::io::split(host_stream);
    let (event_tx, mut event_rx) = mpsc::channel(TERMINAL_DATACHANNEL_QUEUE_CAPACITY);

    let message_tx = event_tx.clone();
    let overflow_channel = std::sync::Arc::clone(&channel);
    channel.on_message(Box::new(move |message: DataChannelMessage| {
        let message_tx = message_tx.clone();
        let overflow_channel = std::sync::Arc::clone(&overflow_channel);
        Box::pin(async move {
            let event = if message.is_string {
                TerminalDataChannelEvent::Text
            } else {
                TerminalDataChannelEvent::Binary(message.data.to_vec())
            };
            if message_tx.try_send(event).is_err() {
                log::warn!("terminal data channel input queue overflow; closing attachment");
                let _ = overflow_channel.close().await;
            }
        })
    }));
    channel.on_close(Box::new(move || {
        let event_tx = event_tx.clone();
        Box::pin(async move {
            let _ = event_tx.try_send(TerminalDataChannelEvent::Closed);
        })
    }));

    let mut authorization_check = tokio::time::interval(Duration::from_secs(1));
    authorization_check.tick().await;
    loop {
        tokio::select! {
            _ = authorization_check.tick() => {
                if !terminal_remote_client_authorized(&device_id).await {
                    let _ = send_datachannel_protocol_error(
                        &channel,
                        TerminalErrorCode::PermissionDenied,
                        "remote terminal permission was revoked",
                    ).await;
                    break;
                }
            }
            host_frame = read_frame(&mut host_reader) => {
                match host_frame {
                    Ok(Some(frame)) => match frame.encode() {
                        Ok(bytes) => {
                            if channel.send(&bytes::Bytes::from(bytes)).await.is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = send_datachannel_protocol_error(
                                &channel,
                                TerminalErrorCode::InvalidRequest,
                                &error.to_string(),
                            ).await;
                            break;
                        }
                    },
                    Ok(None) => break,
                    Err(error) => {
                        let _ = send_datachannel_protocol_error(
                            &channel,
                            TerminalErrorCode::HostOffline,
                            &error,
                        ).await;
                        break;
                    }
                }
            }
            incoming = event_rx.recv() => {
                match incoming {
                    Some(TerminalDataChannelEvent::Binary(bytes)) => {
                        let frame = match TerminalFrame::decode(&bytes) {
                            Ok(frame) => frame,
                            Err(error) => {
                                let _ = send_datachannel_protocol_error(
                                    &channel,
                                    TerminalErrorCode::InvalidRequest,
                                    &error.to_string(),
                                ).await;
                                break;
                            }
                        };
                        if write_frame(&mut host_writer, &frame).await.is_err() {
                            break;
                        }
                    }
                    Some(TerminalDataChannelEvent::Text) => {
                        let _ = send_datachannel_protocol_error(
                            &channel,
                            TerminalErrorCode::InvalidRequest,
                            "terminal data channel accepts binary protocol frames only",
                        ).await;
                        break;
                    }
                    Some(TerminalDataChannelEvent::Closed) | None => break,
                }
            }
        }
    }
    let _ = channel.close().await;
}

async fn send_datachannel_protocol_error(
    channel: &RTCDataChannel,
    code: TerminalErrorCode,
    message: &str,
) -> Result<(), String> {
    let payload = serde_json::to_vec(&serde_json::json!({ "code": code, "message": message }))
        .map_err(|error| error.to_string())?;
    let frame = TerminalFrame::command(FrameKind::Error, Uuid::nil(), 0, payload);
    let bytes = frame.encode().map_err(|error| error.to_string())?;
    channel
        .send(&bytes::Bytes::from(bytes))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn send_protocol_error(
    socket: &mut WebSocket,
    code: TerminalErrorCode,
    message: &str,
) -> Result<(), String> {
    let payload = serde_json::to_vec(&serde_json::json!({ "code": code, "message": message }))
        .map_err(|error| error.to_string())?;
    let frame = TerminalFrame::command(FrameKind::Error, Uuid::nil(), 0, payload);
    let bytes = frame.encode().map_err(|error| error.to_string())?;
    socket
        .send(Message::Binary(bytes.into()))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_tickets_are_single_use_and_device_bound() {
        let _guard = super::super::control_allow_list::test_guard();
        let device = format!("ticket-device-{}", Uuid::new_v4());
        super::super::control_allow_list::terminal_global().allow(device.clone());
        let store = TerminalTicketStore::default();
        let ticket = store.issue(&device, true).unwrap();
        let binding = store.consume(&ticket.ticket, true).unwrap();
        assert_eq!(binding.device_id, device);
        assert!(store.consume(&ticket.ticket, true).is_err());
        super::super::control_allow_list::terminal_global().disallow(&device);
    }

    #[test]
    fn terminal_ticket_requires_the_independent_grant() {
        let store = TerminalTicketStore::default();
        assert!(store.issue("never-granted-terminal-device", true).is_err());
    }

    #[test]
    fn terminal_ticket_revocation_is_checked_again_at_consumption() {
        let _guard = super::super::control_allow_list::test_guard();
        let device = format!("revoked-ticket-device-{}", Uuid::new_v4());
        super::super::control_allow_list::terminal_global().allow(device.clone());
        let store = TerminalTicketStore::default();
        let ticket = store.issue(&device, true).unwrap();
        super::super::control_allow_list::terminal_global().disallow(&device);
        assert!(store.consume(&ticket.ticket, true).is_err());
    }

    #[test]
    fn ticket_store_never_keeps_the_bearer_value() {
        let ticket = "sensitive-ticket";
        let digest = ticket_digest(ticket);
        assert_ne!(digest.as_slice(), ticket.as_bytes());
        assert_eq!(digest.len(), 32);
    }

    #[test]
    fn host_wide_remote_disable_blocks_issue_and_consumption() {
        let _guard = super::super::control_allow_list::test_guard();
        let device = format!("disabled-host-device-{}", Uuid::new_v4());
        super::super::control_allow_list::terminal_global().allow(device.clone());
        let store = TerminalTicketStore::default();
        assert!(store.issue(&device, false).is_err());
        let ticket = store.issue(&device, true).unwrap();
        assert!(store.consume(&ticket.ticket, false).is_err());
        super::super::control_allow_list::terminal_global().disallow(&device);
    }

    #[test]
    fn legacy_control_frames_translate_to_canonical_host_commands() {
        let resize = legacy_control_command(r#"{"kind":"resize","rows":0,"cols":120}"#)
            .expect("resize command");
        assert_eq!(resize.0, FrameKind::Resize);
        let payload: serde_json::Value = serde_json::from_slice(&resize.1).unwrap();
        assert_eq!(payload["rows"], 1);
        assert_eq!(payload["cols"], 120);

        let kill = legacy_control_command(r#"{"kind":"kill"}"#).expect("kill command");
        assert_eq!(kill.0, FrameKind::Kill);
        assert!(kill.1.is_empty());
        assert!(legacy_control_command(r#"{"kind":"unknown"}"#).is_none());
    }
}
