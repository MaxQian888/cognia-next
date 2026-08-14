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
use uuid::Uuid;
use webrtc::data_channel::{DataChannel, DataChannelEvent};

use super::SharedState;

const MAX_WS_FRAME_BYTES: usize = HEADER_LEN + MAX_FRAME_PAYLOAD;
const TERMINAL_DC_QUEUE_CAPACITY: usize = 128;
const TERMINAL_DC_SEND_TIMEOUT: Duration = Duration::from_secs(15);
const TERMINAL_DC_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

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

fn spawn_terminal_dc_writer(
    channel: std::sync::Arc<dyn DataChannel>,
    timeout: Duration,
) -> (
    tokio::sync::mpsc::Sender<Vec<u8>>,
    tokio::sync::mpsc::Receiver<()>,
    tokio::task::JoinHandle<()>,
) {
    let (outbound_tx, mut outbound_rx) =
        tokio::sync::mpsc::channel::<Vec<u8>>(TERMINAL_DC_QUEUE_CAPACITY);
    let (writer_done_tx, writer_done_rx) = tokio::sync::mpsc::channel::<()>(1);
    let writer_pump = tokio::spawn(async move {
        while let Some(bytes) = outbound_rx.recv().await {
            let send = channel.send(bytes::BytesMut::from(bytes.as_slice()));
            match tokio::time::timeout(timeout, send).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    log::warn!("terminal data channel send failed: {error}");
                    break;
                }
                Err(_) => {
                    log::warn!("terminal data channel send timed out");
                    break;
                }
            }
        }
        close_terminal_data_channel(channel.as_ref()).await;
        let _ = writer_done_tx.try_send(());
    });
    (outbound_tx, writer_done_rx, writer_pump)
}

fn spawn_terminal_dc_event_pump(
    channel: std::sync::Arc<dyn DataChannel>,
    capacity: usize,
) -> (
    tokio::sync::mpsc::Receiver<DataChannelEvent>,
    tokio::task::JoinHandle<()>,
) {
    let (event_tx, event_rx) = tokio::sync::mpsc::channel(capacity);
    let event_pump = tokio::spawn(async move {
        while let Some(event) = channel.poll().await {
            if event_tx.try_send(event).is_err() {
                log::warn!("terminal data channel event queue overflowed; closing attachment");
                close_terminal_data_channel(channel.as_ref()).await;
                break;
            }
        }
    });
    (event_rx, event_pump)
}

async fn close_terminal_data_channel(channel: &dyn DataChannel) {
    if tokio::time::timeout(TERMINAL_DC_CLOSE_TIMEOUT, channel.close())
        .await
        .is_err()
    {
        log::warn!("terminal data channel close timed out");
    }
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

/// Authenticated WAN adapter for the durable terminal host. Signaling binds
/// the peer to `device_id`; the independent terminal grant remains mandatory
/// and is rechecked while the attachment is live for immediate revocation.
pub(crate) async fn proxy_terminal_datachannel(
    channel: std::sync::Arc<dyn DataChannel>,
    device_id: String,
    state: SharedState,
) {
    if !terminal_remote_client_authorized(&device_id).await {
        let _ = send_datachannel_protocol_error(
            channel.as_ref(),
            TerminalErrorCode::PermissionDenied,
            "remote terminal permission is required",
        )
        .await;
        close_terminal_data_channel(channel.as_ref()).await;
        return;
    }

    let identity =
        ClientIdentity::remote(format!("companion:{device_id}"), device_id.clone(), true);
    let app = state.app_handle.as_ref();
    let host_stream =
        match crate::terminal_host_bridge::connect_terminal_host_client(app, identity).await {
            Ok(stream) => stream,
            Err(message) => {
                let _ = send_datachannel_protocol_error(
                    channel.as_ref(),
                    TerminalErrorCode::HostOffline,
                    &message,
                )
                .await;
                close_terminal_data_channel(channel.as_ref()).await;
                return;
            }
        };
    let (mut host_reader, mut host_writer) = tokio::io::split(host_stream);
    let (mut event_rx, event_pump) =
        spawn_terminal_dc_event_pump(std::sync::Arc::clone(&channel), TERMINAL_DC_QUEUE_CAPACITY);
    let (outbound_tx, mut writer_done_rx, writer_pump) =
        spawn_terminal_dc_writer(std::sync::Arc::clone(&channel), TERMINAL_DC_SEND_TIMEOUT);
    let (host_inbound_tx, mut host_inbound_rx) =
        tokio::sync::mpsc::channel::<TerminalFrame>(TERMINAL_DC_QUEUE_CAPACITY);
    let (host_writer_done_tx, mut host_writer_done_rx) = tokio::sync::mpsc::channel::<()>(1);
    let host_writer_pump = tokio::spawn(async move {
        while let Some(frame) = host_inbound_rx.recv().await {
            if write_frame(&mut host_writer, &frame).await.is_err() {
                break;
            }
        }
        let _ = host_writer_done_tx.try_send(());
    });
    let mut authorization_check = tokio::time::interval(Duration::from_secs(1));
    authorization_check.tick().await;
    loop {
        tokio::select! {
            _ = authorization_check.tick() => {
                if !terminal_remote_client_authorized(&device_id).await {
                    let _ = send_datachannel_protocol_error(
                        channel.as_ref(),
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
                            if outbound_tx.try_send(bytes).is_err() {
                                log::warn!(
                                    "terminal data channel outbound queue overflowed; closing attachment"
                                );
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = send_datachannel_protocol_error(
                                channel.as_ref(),
                                TerminalErrorCode::InvalidRequest,
                                &error.to_string(),
                            ).await;
                            break;
                        }
                    },
                    Ok(None) => break,
                    Err(error) => {
                        let _ = send_datachannel_protocol_error(
                            channel.as_ref(),
                            TerminalErrorCode::HostOffline,
                            &error,
                        ).await;
                        break;
                    }
                }
            }
            writer_done = writer_done_rx.recv() => {
                if writer_done.is_some() {
                    break;
                }
            }
            host_writer_done = host_writer_done_rx.recv() => {
                if host_writer_done.is_some() {
                    break;
                }
            }
            incoming = event_rx.recv() => {
                match incoming {
                    Some(DataChannelEvent::OnMessage(message)) if !message.is_string => {
                        let bytes = message.data.to_vec();
                        let frame = match TerminalFrame::decode(&bytes) {
                            Ok(frame) => frame,
                            Err(error) => {
                                let _ = send_datachannel_protocol_error(
                                    channel.as_ref(),
                                    TerminalErrorCode::InvalidRequest,
                                    &error.to_string(),
                                ).await;
                                break;
                            }
                        };
                        if host_inbound_tx.try_send(frame).is_err() {
                            log::warn!(
                                "terminal host inbound queue overflowed; closing attachment"
                            );
                            break;
                        }
                    }
                    Some(DataChannelEvent::OnMessage(_)) => {
                        let _ = send_datachannel_protocol_error(
                            channel.as_ref(),
                            TerminalErrorCode::InvalidRequest,
                            "terminal data channel accepts binary protocol frames only",
                        ).await;
                        break;
                    }
                    Some(DataChannelEvent::OnClose) | None => break,
                    Some(DataChannelEvent::OnError) => {
                        log::warn!("terminal data channel reported an error");
                        break;
                    }
                    Some(
                        DataChannelEvent::OnOpen
                        | DataChannelEvent::OnClosing
                        | DataChannelEvent::OnBufferedAmountLow
                        | DataChannelEvent::OnBufferedAmountHigh,
                    ) => {}
                }
            }
        }
    }
    drop(outbound_tx);
    drop(host_inbound_tx);
    close_terminal_data_channel(channel.as_ref()).await;
    event_pump.abort();
    writer_pump.abort();
    host_writer_pump.abort();
}

async fn send_datachannel_protocol_error(
    channel: &dyn DataChannel,
    code: TerminalErrorCode,
    message: &str,
) -> Result<(), String> {
    let payload = serde_json::to_vec(&serde_json::json!({ "code": code, "message": message }))
        .map_err(|error| error.to_string())?;
    let frame = TerminalFrame::command(FrameKind::Error, Uuid::nil(), 0, payload);
    let bytes = frame.encode().map_err(|error| error.to_string())?;
    tokio::time::timeout(
        TERMINAL_DC_SEND_TIMEOUT,
        channel.try_send(bytes::BytesMut::from(bytes.as_slice())),
    )
    .await
    .map_err(|_| "terminal data channel error send timed out".to_string())?
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use webrtc::data_channel::{RTCDataChannelId, RTCDataChannelState};

    struct BlockedDataChannel {
        closed: AtomicBool,
        immediate_sends: std::sync::Mutex<Vec<Vec<u8>>>,
        events: tokio::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<DataChannelEvent>>>,
    }

    impl Default for BlockedDataChannel {
        fn default() -> Self {
            Self {
                closed: AtomicBool::new(false),
                immediate_sends: std::sync::Mutex::new(Vec::new()),
                events: tokio::sync::Mutex::new(None),
            }
        }
    }

    impl BlockedDataChannel {
        fn with_events(events: tokio::sync::mpsc::UnboundedReceiver<DataChannelEvent>) -> Self {
            Self {
                events: tokio::sync::Mutex::new(Some(events)),
                ..Self::default()
            }
        }
    }

    #[async_trait::async_trait]
    impl DataChannel for BlockedDataChannel {
        async fn label(&self) -> webrtc::error::Result<String> {
            Ok("cognia.terminal".into())
        }
        async fn ordered(&self) -> webrtc::error::Result<bool> {
            Ok(true)
        }
        async fn max_packet_life_time(&self) -> webrtc::error::Result<Option<u16>> {
            Ok(None)
        }
        async fn max_retransmits(&self) -> webrtc::error::Result<Option<u16>> {
            Ok(None)
        }
        async fn protocol(&self) -> webrtc::error::Result<String> {
            Ok(String::new())
        }
        async fn negotiated(&self) -> webrtc::error::Result<bool> {
            Ok(false)
        }
        fn id(&self) -> RTCDataChannelId {
            0
        }
        async fn ready_state(&self) -> webrtc::error::Result<RTCDataChannelState> {
            Ok(RTCDataChannelState::Open)
        }
        async fn buffered_amount_high_threshold(&self) -> webrtc::error::Result<u32> {
            Ok(u32::MAX)
        }
        async fn set_buffered_amount_high_threshold(
            &self,
            _threshold: u32,
        ) -> webrtc::error::Result<()> {
            Ok(())
        }
        async fn buffered_amount_low_threshold(&self) -> webrtc::error::Result<u32> {
            Ok(0)
        }
        async fn set_buffered_amount_low_threshold(
            &self,
            _threshold: u32,
        ) -> webrtc::error::Result<()> {
            Ok(())
        }
        async fn send(&self, _data: bytes::BytesMut) -> webrtc::error::Result<()> {
            std::future::pending().await
        }
        async fn send_text(&self, _text: &str) -> webrtc::error::Result<()> {
            Ok(())
        }
        async fn try_send(&self, data: bytes::BytesMut) -> webrtc::error::Result<()> {
            self.immediate_sends.lock().unwrap().push(data.to_vec());
            Ok(())
        }
        async fn poll(&self) -> Option<DataChannelEvent> {
            let mut events = self.events.lock().await;
            match events.as_mut() {
                Some(events) => events.recv().await,
                None => std::future::pending().await,
            }
        }
        async fn close(&self) -> webrtc::error::Result<()> {
            self.closed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn canonical_terminal_query_requires_a_ticket() {
        let query: TerminalSocketQuery = serde_urlencoded::from_str("ticket=single-use").unwrap();
        assert_eq!(query.ticket, "single-use");
        assert!(serde_urlencoded::from_str::<TerminalSocketQuery>("").is_err());
    }

    #[tokio::test]
    async fn blocked_terminal_send_times_out_and_closes_attachment() {
        let channel = std::sync::Arc::new(BlockedDataChannel::default());
        let (tx, mut done_rx, writer) =
            spawn_terminal_dc_writer(channel.clone(), Duration::from_millis(20));
        tx.send(vec![1, 2, 3]).await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), done_rx.recv())
            .await
            .expect("writer must terminate after its send deadline")
            .expect("writer completion signal");
        writer.await.unwrap();
        assert!(channel.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn protocol_errors_use_the_nonblocking_send_path() {
        let channel = BlockedDataChannel::default();

        send_datachannel_protocol_error(&channel, TerminalErrorCode::PermissionDenied, "revoked")
            .await
            .unwrap();

        let sends = channel.immediate_sends.lock().unwrap();
        assert_eq!(sends.len(), 1);
        let frame = TerminalFrame::decode(&sends[0]).unwrap();
        assert_eq!(frame.kind, FrameKind::Error);
    }

    #[tokio::test]
    async fn event_queue_overflow_closes_the_attachment() {
        let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        event_tx.send(DataChannelEvent::OnOpen).unwrap();
        event_tx
            .send(DataChannelEvent::OnBufferedAmountHigh)
            .unwrap();
        drop(event_tx);
        let channel = std::sync::Arc::new(BlockedDataChannel::with_events(event_rx));
        let (_events, pump) = spawn_terminal_dc_event_pump(channel.clone(), 1);

        tokio::time::timeout(Duration::from_secs(1), pump)
            .await
            .expect("event pump must fail closed on overflow")
            .expect("event pump join");
        assert!(channel.closed.load(Ordering::SeqCst));
    }
}
