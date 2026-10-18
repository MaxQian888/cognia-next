//! Companion transports for remote desktop viewers (ADR-0234 Phase 3).
//!
//! A paired device opens a session with `remote_desktop_session_open`; the
//! Host's bridge then waits for that device's viewer stream. This module
//! delivers it from the two ways a device reaches the Host:
//!
//! * **LAN.** `POST /api/auth/socket-ticket { channel: "remote-desktop",
//!   sessionId }` issues a single-use ticket bound to
//!   `/ws/remote-desktop/{sessionId}`; `GET` on that path with the ticket
//!   redeems it, attaches as the ticket's device and upgrades. Binary frames
//!   only, `binary` subprotocol, 1 MiB per frame.
//! * **Relay.** A reliable, ordered `cognia.rfb` datachannel per session on the
//!   live peer. Signaling binds the peer to its device. The first message is
//!   text `{"type":"attach","sessionId":…}`; the Host answers text
//!   `{"type":"attached"}` or `{"type":"error","code":…}` and closes. After
//!   that both directions carry binary RFB bytes, at most
//!   [`DC_CHUNK_BYTES`] per message.
//!
//! Either way the bridge only ever sees an in-memory byte pipe, and the
//! session's owner check, its once-only attach and its live admission all live
//! in `cognia-remote-desktop`. [`device_principal`] is the one place a device
//! is turned into a remote desktop principal, for the commands too.

use std::{sync::Arc, time::Duration};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query,
    },
    http::StatusCode,
    response::Response,
};
use cognia_companion_connectivity::signaling::peer::DataChannelTag;
use cognia_remote_desktop::{
    bridge::{ViewerStream, MAX_FRAME_BYTES},
    commands::installed,
    error::RemoteDesktopError,
    session::{Principal, SessionMode},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use webrtc::data_channel::{DataChannel, DataChannelEvent};

/// The socket-ticket audience for viewer sockets.
pub const SOCKET_AUDIENCE: &str = "remote-desktop";
/// Largest binary message sent on a `cognia.rfb` channel. Browsers interoperate
/// on 16 KiB SCTP messages; larger ones are fragmented or refused.
pub const DC_CHUNK_BYTES: usize = 16 * 1024;
const PIPE_BYTES: usize = 64 * 1024;
const DC_EVENT_QUEUE: usize = 128;
const ATTACH_TIMEOUT: Duration = Duration::from_secs(10);
const DC_SEND_TIMEOUT: Duration = Duration::from_secs(15);
const DC_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

/// The socket path a viewer ticket is bound to.
pub fn socket_path(session_id: &str) -> String {
    format!("/ws/remote-desktop/{session_id}")
}

/// Session ids are Host-minted hex; anything else never names a session.
pub fn valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 64
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Whether a device may hold a remote desktop session in `mode` right now:
/// an active, non-service paired device that was never enrolled as an agent
/// worker (agents never drive external machines, ADR-0234), holding
/// `host.observe` to view or `host.admin` to control.
pub fn device_admitted(tenant_id: Option<&str>, device_id: &str, mode: SessionMode) -> bool {
    let Some(store) = crate::security_store::security_store() else {
        return false;
    };
    let tenant = match tenant_id {
        Some(tenant) => tenant.to_owned(),
        None => match store.active_device_tenant(device_id) {
            Ok(Some(tenant)) => tenant,
            _ => return false,
        },
    };
    // `list_devices` leaves out service devices, so a brain never matches.
    let active = store.list_devices(&tenant).is_ok_and(|devices| {
        devices
            .iter()
            .any(|device| device.device_id == device_id && device.status == "active")
    });
    if !active {
        return false;
    }
    let worker = store
        .list_worker_devices(&tenant)
        .map(|workers| workers.iter().any(|device| device.device_id == device_id))
        .unwrap_or(true);
    if worker {
        return false;
    }
    let capability = match mode {
        SessionMode::View => "host.observe",
        SessionMode::Control => "host.admin",
    };
    store
        .has_capability(&tenant, device_id, capability)
        .unwrap_or(false)
}

/// The principal a paired device acts as. Its admission is re-read from the
/// pairing store every time the session checks it.
pub fn device_principal(tenant_id: Option<String>, device_id: &str) -> Principal {
    let device = device_id.to_owned();
    Principal::device(
        device_id,
        Arc::new(move |mode| device_admitted(tenant_id.as_deref(), &device, mode)),
    )
}

fn attach_to_host(principal: &Principal, session_id: &str, stream: ViewerStream) -> Result<(), RemoteDesktopError> {
    let state = installed()?;
    state.host()?.attach_viewer(principal, session_id, stream)
}

fn attach_status(error: &RemoteDesktopError) -> StatusCode {
    match error.code {
        "remote_desktop_session_not_found" => StatusCode::NOT_FOUND,
        "remote_desktop_forbidden" => StatusCode::FORBIDDEN,
        "remote_desktop_session_attached" => StatusCode::CONFLICT,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}

#[derive(Debug, Deserialize)]
pub struct RemoteDesktopSocketQuery {
    ticket: String,
}

/// `GET /ws/remote-desktop/{session_id}?ticket=…`. The ticket is the only
/// gate (it is device-bound and path-bound); the attach is refused before the
/// upgrade so the client sees why.
pub async fn ws_remote_desktop_handler(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    Query(query): Query<RemoteDesktopSocketQuery>,
) -> Response {
    if !valid_session_id(&session_id) {
        return crate::api::public_error_response(
            StatusCode::NOT_FOUND,
            "remote_desktop_session_not_found",
            "no such remote desktop session",
            false,
            serde_json::json!({}),
        );
    }
    let Some(store) = crate::security_store::security_store() else {
        return crate::api::public_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "security_store_unavailable",
            "the security database is unavailable",
            true,
            serde_json::json!({}),
        );
    };
    let binding = match store.redeem_socket_ticket(
        &query.ticket,
        &socket_path(&session_id),
        SOCKET_AUDIENCE,
        unix_time_secs(),
    ) {
        Ok(binding) => binding,
        Err(_) => {
            return crate::api::public_error_response(
                StatusCode::UNAUTHORIZED,
                "invalid_socket_ticket",
                "remote desktop socket ticket is invalid, expired, or already used",
                false,
                serde_json::json!({}),
            );
        }
    };
    let principal = device_principal(Some(binding.tenant_id), &binding.device_id);
    let (viewer, host_end) = tokio::io::duplex(PIPE_BYTES);
    if let Err(error) = attach_to_host(&principal, &session_id, Box::new(host_end)) {
        return crate::api::public_error_response(
            attach_status(&error),
            error.code,
            "the remote desktop session cannot be attached",
            false,
            serde_json::json!({}),
        );
    }
    ws.protocols(["binary"])
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| pump_socket(socket, viewer))
}

/// Binary WebSocket frames ⇄ the bridge's pipe. A text frame is a protocol
/// violation for an RFB viewer and ends the stream.
async fn pump_socket(socket: WebSocket, io: DuplexStream) {
    let (mut sink, mut stream) = socket.split();
    let (mut reader, mut writer) = tokio::io::split(io);
    let inbound = async {
        while let Some(Ok(message)) = stream.next().await {
            match message {
                Message::Binary(bytes) => {
                    if writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) | Message::Text(_) => break,
                Message::Ping(_) | Message::Pong(_) => {}
            }
        }
    };
    let outbound = async {
        let mut buffer = vec![0; PIPE_BYTES];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
                Ok(read) => {
                    if sink
                        .send(Message::Binary(buffer[..read].to_vec().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = inbound => {}
        _ = outbound => {}
    }
}

fn unix_time_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// The upstream DataChannel trait is sealed; this small boundary lets the
// tests drive the real attach and pump code with a fake channel.
#[async_trait::async_trait]
trait RfbChannel: Send + Sync {
    async fn send(&self, data: bytes::BytesMut) -> webrtc::error::Result<()>;
    async fn send_text(&self, text: &str) -> webrtc::error::Result<()>;
    async fn poll(&self) -> Option<DataChannelEvent>;
    async fn close(&self) -> webrtc::error::Result<()>;
}

#[async_trait::async_trait]
impl<T: DataChannel + ?Sized> RfbChannel for T {
    async fn send(&self, data: bytes::BytesMut) -> webrtc::error::Result<()> {
        DataChannel::send(self, data).await
    }
    async fn send_text(&self, text: &str) -> webrtc::error::Result<()> {
        DataChannel::send_text(self, text).await
    }
    async fn poll(&self) -> Option<DataChannelEvent> {
        DataChannel::poll(self).await
    }
    async fn close(&self) -> webrtc::error::Result<()> {
        DataChannel::close(self).await
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum ControlMessage {
    Attach {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

/// A `cognia.rfb` channel from the peer signaling bound to `device_id`.
pub(crate) async fn proxy_rfb_datachannel(channel: Arc<dyn DataChannel>, tag: DataChannelTag, device_id: String) {
    let principal = device_principal(None, &device_id);
    serve_rfb_channel(channel, &tag, ATTACH_TIMEOUT, move |session_id, stream| {
        attach_to_host(&principal, session_id, stream)
    })
    .await;
}

async fn serve_rfb_channel<C, A>(channel: Arc<C>, tag: &DataChannelTag, attach_timeout: Duration, attach: A)
where
    C: RfbChannel + ?Sized + 'static,
    A: FnOnce(&str, ViewerStream) -> Result<(), RemoteDesktopError>,
{
    let (events_tx, mut events) = tokio::sync::mpsc::channel(DC_EVENT_QUEUE);
    let poller = Arc::clone(&channel);
    let event_pump = tokio::spawn(async move {
        while let Some(event) = poller.poll().await {
            if events_tx.try_send(event).is_err() {
                log::warn!("remote desktop data channel event queue overflowed; closing it");
                let _ = tokio::time::timeout(DC_CLOSE_TIMEOUT, poller.close()).await;
                break;
            }
        }
    });

    let session_id = match tokio::time::timeout(attach_timeout, first_attach(&mut events)).await {
        Ok(Ok(Some(session_id))) => session_id,
        Ok(Ok(None)) => {
            event_pump.abort();
            return;
        }
        Ok(Err(code)) => {
            refuse(channel.as_ref(), tag, code, &mut events).await;
            event_pump.abort();
            return;
        }
        Err(_) => {
            refuse(channel.as_ref(), tag, "remote_desktop_ticket_expired", &mut events).await;
            event_pump.abort();
            return;
        }
    };
    let (viewer, host_end) = tokio::io::duplex(PIPE_BYTES);
    if let Err(error) = attach(&session_id, Box::new(host_end)) {
        refuse(channel.as_ref(), tag, error.code, &mut events).await;
        event_pump.abort();
        return;
    }
    if channel.send_text(r#"{"type":"attached"}"#).await.is_err() {
        event_pump.abort();
        return;
    }
    log::info!("remote desktop data channel attached ({tag})");
    let (mut reader, mut writer) = tokio::io::split(viewer);
    let sender = Arc::clone(&channel);
    // Awaited sends: the channel's send buffer pushes back through the pipe
    // and the bridge to the server, instead of queueing frames without bound.
    let downstream = async move {
        let mut buffer = vec![0; PIPE_BYTES];
        loop {
            let read = match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            for chunk in buffer[..read].chunks(DC_CHUNK_BYTES) {
                let send = sender.send(bytes::BytesMut::from(chunk));
                match tokio::time::timeout(DC_SEND_TIMEOUT, send).await {
                    Ok(Ok(())) => {}
                    _ => return,
                }
            }
        }
    };
    let upstream = async {
        while let Some(event) = events.recv().await {
            match event {
                DataChannelEvent::OnMessage(message) if !message.is_string => {
                    if writer.write_all(&message.data).await.is_err() {
                        return;
                    }
                }
                // Only the attach is text; anything after it is a violation.
                DataChannelEvent::OnMessage(_) => return,
                DataChannelEvent::OnClose | DataChannelEvent::OnError => return,
                _ => {}
            }
        }
    };
    tokio::select! {
        _ = downstream => {}
        _ = upstream => {}
    }
    log::info!("remote desktop data channel detached ({tag})");
    close_and_drain(channel.as_ref(), &mut events).await;
    event_pump.abort();
}

/// Wait for the attach message: `Ok(None)` when the channel closed first,
/// `Err(code)` for anything that is not a well-formed attach.
async fn first_attach(
    events: &mut tokio::sync::mpsc::Receiver<DataChannelEvent>,
) -> Result<Option<String>, &'static str> {
    while let Some(event) = events.recv().await {
        match event {
            DataChannelEvent::OnMessage(message) if message.is_string => {
                let ControlMessage::Attach { session_id } =
                    serde_json::from_slice(&message.data).map_err(|_| "remote_desktop_protocol_invalid")?;
                if !valid_session_id(&session_id) {
                    return Err("remote_desktop_session_not_found");
                }
                return Ok(Some(session_id));
            }
            DataChannelEvent::OnMessage(_) => return Err("remote_desktop_protocol_invalid"),
            DataChannelEvent::OnClose | DataChannelEvent::OnError => return Ok(None),
            _ => {}
        }
    }
    Ok(None)
}

async fn refuse<C: RfbChannel + ?Sized>(
    channel: &C,
    tag: &DataChannelTag,
    code: &str,
    events: &mut tokio::sync::mpsc::Receiver<DataChannelEvent>,
) {
    log::info!("remote desktop data channel refused ({tag}): {code}");
    let message = serde_json::json!({"type": "error", "code": code}).to_string();
    let _ = tokio::time::timeout(DC_SEND_TIMEOUT, channel.send_text(&message)).await;
    close_and_drain(channel, events).await;
}

/// Close, then wait (bounded) for the stack to report it, so the channel's
/// handle is not dropped before its close event arrives.
async fn close_and_drain<C: RfbChannel + ?Sized>(
    channel: &C,
    events: &mut tokio::sync::mpsc::Receiver<DataChannelEvent>,
) {
    let _ = tokio::time::timeout(DC_CLOSE_TIMEOUT, channel.close()).await;
    let _ = tokio::time::timeout(DC_CLOSE_TIMEOUT, async {
        while let Some(event) = events.recv().await {
            if matches!(event, DataChannelEvent::OnClose) {
                break;
            }
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use webrtc::data_channel::RTCDataChannelMessage;

    #[derive(Default)]
    struct FakeChannel {
        /// `(is_text, bytes)` in send order.
        sent: Mutex<Vec<(bool, Vec<u8>)>>,
        closed: AtomicBool,
        events: tokio::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<DataChannelEvent>>>,
        sent_signal: tokio::sync::Notify,
    }

    #[async_trait::async_trait]
    impl RfbChannel for FakeChannel {
        async fn send(&self, data: bytes::BytesMut) -> webrtc::error::Result<()> {
            self.sent.lock().push((false, data.to_vec()));
            self.sent_signal.notify_waiters();
            Ok(())
        }
        async fn send_text(&self, text: &str) -> webrtc::error::Result<()> {
            self.sent.lock().push((true, text.as_bytes().to_vec()));
            self.sent_signal.notify_waiters();
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

    fn fake_channel() -> (Arc<FakeChannel>, tokio::sync::mpsc::UnboundedSender<DataChannelEvent>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let channel = FakeChannel {
            events: tokio::sync::Mutex::new(Some(rx)),
            ..FakeChannel::default()
        };
        (Arc::new(channel), tx)
    }

    fn text(value: &str) -> DataChannelEvent {
        DataChannelEvent::OnMessage(RTCDataChannelMessage {
            is_string: true,
            data: bytes::BytesMut::from(value.as_bytes()),
        })
    }

    fn binary(value: &[u8]) -> DataChannelEvent {
        DataChannelEvent::OnMessage(RTCDataChannelMessage {
            is_string: false,
            data: bytes::BytesMut::from(value),
        })
    }

    fn tag() -> DataChannelTag {
        DataChannelTag {
            label: "cognia.rfb".into(),
            stream_id: Some(5),
            handle: 1,
        }
    }

    fn texts(channel: &FakeChannel) -> Vec<String> {
        channel
            .sent
            .lock()
            .iter()
            .filter(|(is_text, _)| *is_text)
            .map(|(_, bytes)| String::from_utf8(bytes.clone()).unwrap())
            .collect()
    }

    /// The codes of every `{"type":"error"}` message sent.
    fn errors(channel: &FakeChannel) -> Vec<String> {
        texts(channel)
            .iter()
            .map(|text| serde_json::from_str::<serde_json::Value>(text).unwrap())
            .filter(|value| value["type"] == "error")
            .map(|value| value["code"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn session_ids_and_paths_are_strict() {
        assert!(valid_session_id("0123456789abcdef0123456789abcdef"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("../ws/terminal"));
        assert!(!valid_session_id("ABCDEF"));
        assert!(!valid_session_id(&"a".repeat(65)));
        assert_eq!(socket_path("abc"), "/ws/remote-desktop/abc");
        let query: RemoteDesktopSocketQuery = serde_urlencoded::from_str("ticket=one").unwrap();
        assert_eq!(query.ticket, "one");
        assert!(serde_urlencoded::from_str::<RemoteDesktopSocketQuery>("").is_err());
    }

    #[test]
    fn refusals_map_to_http_statuses() {
        for (code, status) in [
            ("remote_desktop_session_not_found", StatusCode::NOT_FOUND),
            ("remote_desktop_forbidden", StatusCode::FORBIDDEN),
            ("remote_desktop_session_attached", StatusCode::CONFLICT),
            ("remote_desktop_host_unavailable", StatusCode::SERVICE_UNAVAILABLE),
        ] {
            assert_eq!(attach_status(&RemoteDesktopError::new(code)), status, "{code}");
        }
    }

    #[test]
    fn without_a_security_store_no_device_is_admitted() {
        // The test binary never installs one here, so admission fails closed.
        if crate::security_store::security_store().is_none() {
            assert!(!device_admitted(None, "phone", SessionMode::View));
            assert!(!device_principal(None, "phone").admitted(SessionMode::View));
        }
        assert_eq!(device_principal(None, "phone").id(), "device:phone");
    }

    #[tokio::test]
    async fn an_attached_channel_relays_bytes_both_ways_in_bounded_chunks() {
        let (channel, events) = fake_channel();
        let (host_side, mut server) = tokio::io::duplex(PIPE_BYTES * 2);
        let host_side = Mutex::new(Some(host_side));
        let session = "0123456789abcdef".to_string();
        let attached = Arc::new(Mutex::new(None::<String>));
        let seen = attached.clone();
        let task = tokio::spawn({
            let channel = channel.clone();
            async move {
                serve_rfb_channel(channel, &tag(), ATTACH_TIMEOUT, move |session_id, stream| {
                    *seen.lock() = Some(session_id.to_owned());
                    // Splice the bridge end to the test's "server" pipe.
                    let mut bridge = host_side.lock().take().unwrap();
                    tokio::spawn(async move {
                        let mut stream = stream;
                        let _ = tokio::io::copy_bidirectional(&mut stream, &mut bridge).await;
                    });
                    Ok(())
                })
                .await;
            }
        });
        events.send(DataChannelEvent::OnOpen).unwrap();
        events
            .send(text(&format!(r#"{{"type":"attach","sessionId":"{session}"}}"#)))
            .unwrap();
        // Server → viewer: 40 KiB arrives as 16 KiB messages.
        server.write_all(&vec![7u8; 40 * 1024]).await.unwrap();
        events.send(binary(b"client-init")).unwrap();
        let mut from_viewer = [0u8; 11];
        server.read_exact(&mut from_viewer).await.unwrap();
        assert_eq!(&from_viewer, b"client-init");
        for _ in 0..200 {
            let total: usize = channel
                .sent
                .lock()
                .iter()
                .filter(|(is_text, _)| !is_text)
                .map(|(_, bytes)| bytes.len())
                .sum();
            if total == 40 * 1024 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        {
            let sent = channel.sent.lock();
            let binary: Vec<_> = sent.iter().filter(|(is_text, _)| !is_text).collect();
            assert_eq!(binary.iter().map(|(_, b)| b.len()).sum::<usize>(), 40 * 1024);
            assert!(binary.iter().all(|(_, b)| b.len() <= DC_CHUNK_BYTES));
        }
        assert_eq!(texts(&channel), vec![r#"{"type":"attached"}"#]);
        assert_eq!(attached.lock().as_deref(), Some(session.as_str()));
        // A text message after the attach ends the stream.
        events.send(text("{}")).unwrap();
        events.send(DataChannelEvent::OnClose).unwrap();
        task.await.unwrap();
        assert!(channel.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_refused_attach_names_the_code_and_closes() {
        let (channel, events) = fake_channel();
        events
            .send(text(r#"{"type":"attach","sessionId":"abc"}"#))
            .unwrap();
        events.send(DataChannelEvent::OnClose).unwrap();
        serve_rfb_channel(channel.clone(), &tag(), ATTACH_TIMEOUT, |_, _| {
            Err(RemoteDesktopError::new("remote_desktop_session_not_found"))
        })
        .await;
        assert_eq!(errors(&channel), vec!["remote_desktop_session_not_found"]);
        assert!(channel.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn malformed_or_late_attaches_are_refused_without_reaching_the_host() {
        for first in [binary(b"RFB"), text("not json"), text(r#"{"type":"attach","sessionId":"../x"}"#)] {
            let (channel, events) = fake_channel();
            events.send(first).unwrap();
            events.send(DataChannelEvent::OnClose).unwrap();
            serve_rfb_channel(channel.clone(), &tag(), ATTACH_TIMEOUT, |_, _| {
                panic!("the host must not be asked")
            })
            .await;
            assert_eq!(errors(&channel).len(), 1);
            assert!(channel.closed.load(Ordering::SeqCst));
        }
        let (channel, _events) = fake_channel();
        serve_rfb_channel(channel.clone(), &tag(), Duration::from_millis(20), |_, _| {
            panic!("the host must not be asked")
        })
        .await;
        assert_eq!(errors(&channel), vec!["remote_desktop_ticket_expired"]);
        // A channel that closes before attaching just ends.
        let (channel, events) = fake_channel();
        events.send(DataChannelEvent::OnClose).unwrap();
        serve_rfb_channel(channel.clone(), &tag(), ATTACH_TIMEOUT, |_, _| {
            panic!("the host must not be asked")
        })
        .await;
        assert!(texts(&channel).is_empty());
    }
}
