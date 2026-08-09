//! Authenticated LAN adapter for the durable terminal host.
//!
//! A paired client first obtains a short-lived, single-use, device-bound
//! socket ticket through the authenticated Companion channel, then opens
//! `GET /ws/terminal?ticket=…`. The WebSocket carries only canonical binary
//! terminal frames; PTY/session ownership remains in `cognia-server
//! desktop-host` and therefore survives this process or UI disconnecting.

use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::Response,
};
use cognia_terminal::host::ClientIdentity;
use cognia_terminal::host_wire::{read_frame, write_frame};
use cognia_terminal::protocol::{
    FrameKind, TerminalErrorCode, TerminalFrame, HEADER_LEN, MAX_FRAME_PAYLOAD,
};
use serde::Deserialize;
use tokio::sync::mpsc;
use uuid::Uuid;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;

use super::SharedState;

const MAX_WS_FRAME_BYTES: usize = HEADER_LEN + MAX_FRAME_PAYLOAD;
const TERMINAL_DATACHANNEL_QUEUE_CAPACITY: usize = 128;

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
        "/ws/terminal",
        "terminal",
        unix_time_secs(),
    ) {
        Ok(binding) => binding,
        Err(_) => {
            return super::api::public_error_response(
                StatusCode::UNAUTHORIZED,
                "invalid_socket_ticket",
                "terminal socket ticket is invalid, expired, or already used",
                false,
                serde_json::json!({}),
            );
        }
    };
    if !remote_access_enabled
        || !device_allowed_for_terminal(&store, &binding.tenant_id, &binding.device_id)
    {
        return super::api::public_error_response(
            StatusCode::FORBIDDEN,
            "terminal_access_forbidden",
            "remote terminal access is disabled or the device is not allowed",
            false,
            serde_json::json!({}),
        );
    }
    ws.max_message_size(MAX_WS_FRAME_BYTES)
        .max_frame_size(MAX_WS_FRAME_BYTES)
        .on_upgrade(move |socket| proxy_terminal_socket(socket, binding.device_id, state))
}

fn unix_time_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn device_allowed_for_terminal(
    store: &super::security_store::SecurityStore,
    tenant_id: &str,
    device_id: &str,
) -> bool {
    !device_id.is_empty()
        && store
            .has_capability(tenant_id, device_id, "terminal.open")
            .unwrap_or(false)
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
    if !crate::terminal_host_service::terminal_remote_access_enabled().await {
        return false;
    }
    let Some(store) = super::security_store::security_store() else {
        return false;
    };
    let Ok(Some(tenant_id)) = store.active_device_tenant(device_id) else {
        return false;
    };
    device_allowed_for_terminal(&store, &tenant_id, device_id)
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
    fn canonical_terminal_query_requires_a_ticket() {
        let query: TerminalSocketQuery = serde_urlencoded::from_str("ticket=single-use").unwrap();
        assert_eq!(query.ticket, "single-use");
        assert!(serde_urlencoded::from_str::<TerminalSocketQuery>("").is_err());
    }
}
