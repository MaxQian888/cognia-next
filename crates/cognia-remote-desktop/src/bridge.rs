//! The bridge for one viewer session (ADR-0234 §4).
//!
//! A viewer reaches it one of two ways, chosen by who opened the session:
//!
//! * [`Attachment::Loopback`], the desktop's own renderer: a `127.0.0.1:0`
//!   listener with a 256-bit ticket in the path. The first upgrade carrying the
//!   ticket from an app origin is the only one ever accepted; the listener is
//!   dropped right after.
//! * [`Attachment::Remote`], a paired device (Phase 3): no listener at all. The
//!   Companion transport authenticates the device, then hands the bridge the
//!   viewer's byte stream through [`AttachHandle::attach`], once.
//!
//! Either way an unused bridge expires after the ticket TTL. Once a viewer is
//! there the Host dials the pinned address, runs the handshake adapter (VNC
//! authenticates here; `none` pipes raw bytes) and forwards bytes both ways
//! until either side ends or the session is closed.
//!
//! Everything runs in one owned task: dropping or closing the [`Bridge`] ends
//! the listener, the viewer stream and the server connection together.

use crate::{
    error::{RemoteDesktopError, Result},
    rfb,
    target::Adapter,
};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream},
    net::{TcpListener, TcpStream},
    sync::{oneshot, watch},
    task::JoinHandle,
};
use tokio_tungstenite::{
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http::{HeaderValue, StatusCode},
        protocol::WebSocketConfig,
        Message,
    },
    WebSocketStream,
};

pub const TICKET_TTL: Duration = Duration::from_secs(30);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_UPGRADE_ATTEMPTS: u32 = 16;
const PIPE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub enum BridgeState {
    /// Listening for the viewer's upgrade.
    Waiting,
    /// The viewer connected; the Host is dialing and authenticating.
    Connecting,
    Connected,
    Closed,
    Failed(RemoteDesktopError),
}

impl BridgeState {
    pub fn is_terminal(&self) -> bool {
        matches!(self, BridgeState::Closed | BridgeState::Failed(_))
    }
}

pub struct BridgeTarget {
    pub addr: SocketAddr,
    pub adapter: Adapter,
    pub password: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attachment {
    /// The desktop renderer connects to a ticketed loopback WebSocket.
    Loopback,
    /// A Companion transport hands over an authenticated byte stream.
    Remote,
}

/// A viewer's byte stream as a transport adapter delivers it: an in-memory
/// pipe the adapter pumps from its WebSocket or datachannel. The bridge never
/// sees transport types.
pub trait ViewerIo: AsyncRead + AsyncWrite + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> ViewerIo for T {}
pub type ViewerStream = Box<dyn ViewerIo>;

/// The one-shot slot a remote viewer is delivered through. Cloneable so the
/// broker can keep it while the session's watcher owns the bridge.
#[derive(Clone)]
pub struct AttachHandle(Arc<Mutex<Option<oneshot::Sender<ViewerStream>>>>);

impl AttachHandle {
    /// Deliver the viewer. Refused when the bridge is loopback, already has a
    /// viewer, or has ended.
    pub fn attach(&self, stream: ViewerStream) -> Result<()> {
        let sender = self
            .0
            .lock()
            .take()
            .ok_or_else(|| RemoteDesktopError::new("remote_desktop_session_attached"))?;
        sender
            .send(stream)
            .map_err(|_| RemoteDesktopError::new("remote_desktop_session_not_found"))
    }
}

pub struct Bridge {
    /// Loopback only: the WebSocket URL carrying the one-shot ticket.
    pub url: Option<String>,
    attach: AttachHandle,
    state: watch::Receiver<BridgeState>,
    close: watch::Sender<bool>,
    task: JoinHandle<()>,
}

/// Where the viewer will come from, once.
enum ViewerSource {
    Listener { listener: TcpListener, ticket: String },
    Remote(oneshot::Receiver<ViewerStream>),
}

impl Bridge {
    pub async fn start(target: BridgeTarget, attachment: Attachment, ticket_ttl: Duration) -> Result<Bridge> {
        let (url, source, attach) = match attachment {
            Attachment::Loopback => {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|_| RemoteDesktopError::new("remote_desktop_bridge_unavailable"))?;
                let port = listener
                    .local_addr()
                    .map_err(|_| RemoteDesktopError::new("remote_desktop_bridge_unavailable"))?
                    .port();
                let ticket = new_ticket();
                let url = format!("ws://127.0.0.1:{port}/rd/{ticket}");
                (
                    Some(url),
                    ViewerSource::Listener { listener, ticket },
                    AttachHandle(Arc::new(Mutex::new(None))),
                )
            }
            Attachment::Remote => {
                let (sender, receiver) = oneshot::channel();
                (
                    None,
                    ViewerSource::Remote(receiver),
                    AttachHandle(Arc::new(Mutex::new(Some(sender)))),
                )
            }
        };
        let (state_tx, state) = watch::channel(BridgeState::Waiting);
        let (close, close_rx) = watch::channel(false);
        let task = tokio::spawn(run(source, target, ticket_ttl, state_tx, close_rx));
        Ok(Bridge {
            url,
            attach,
            state,
            close,
            task,
        })
    }

    pub fn attach_handle(&self) -> AttachHandle {
        self.attach.clone()
    }

    pub fn state(&self) -> BridgeState {
        self.state.borrow().clone()
    }

    /// Resolve once the bridge reaches a terminal state.
    pub async fn finished(&mut self) -> BridgeState {
        loop {
            let current = self.state.borrow().clone();
            if current.is_terminal() {
                return current;
            }
            if self.state.changed().await.is_err() {
                return self.state.borrow().clone();
            }
        }
    }

    /// Close from the Host side (session closed, lease lost, target changed).
    pub fn close(&self) {
        let _ = self.close.send(true);
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.close.send(true);
        self.task.abort();
    }
}

/// 2 × UUIDv4 = 244 random bits from the OS generator.
fn new_ticket() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The renderer's own origins: the packaged Tauri scheme and loopback dev
/// servers. A page from anywhere else is refused even with a ticket.
pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    let host = rest.split(':').next().unwrap_or_default();
    matches!(scheme, "tauri" | "http" | "https")
        && matches!(host, "localhost" | "127.0.0.1" | "tauri.localhost")
        && !rest.contains('/')
}

fn refuse(status: StatusCode) -> ErrorResponse {
    let mut response = ErrorResponse::new(None);
    *response.status_mut() = status;
    response
}

async fn run(
    source: ViewerSource,
    target: BridgeTarget,
    ticket_ttl: Duration,
    state: watch::Sender<BridgeState>,
    mut close: watch::Receiver<bool>,
) {
    let outcome = async {
        match source {
            ViewerSource::Listener { listener, ticket } => {
                let viewer = tokio::select! {
                    viewer = accept_viewer(&listener, &ticket, ticket_ttl) => viewer?,
                    _ = close.changed() => return Ok(()),
                };
                drop(listener);
                let _ = state.send(BridgeState::Connecting);
                let (local, pump_end) = tokio::io::duplex(PIPE_BYTES);
                tokio::select! {
                    result = relay(Box::new(local), target, &state) => result,
                    result = pump(viewer, pump_end) => result,
                    _ = close.changed() => Ok(()),
                }
            }
            ViewerSource::Remote(receiver) => {
                let viewer = tokio::select! {
                    viewer = tokio::time::timeout(ticket_ttl, receiver) => match viewer {
                        Ok(Ok(viewer)) => viewer,
                        // The handle went with the bridge: nobody can attach.
                        Ok(Err(_)) => return Ok(()),
                        Err(_) => return Err(RemoteDesktopError::new("remote_desktop_ticket_expired")),
                    },
                    _ = close.changed() => return Ok(()),
                };
                let _ = state.send(BridgeState::Connecting);
                tokio::select! {
                    result = relay(viewer, target, &state) => result,
                    _ = close.changed() => Ok(()),
                }
            }
        }
    }
    .await;
    let _ = state.send(match outcome {
        Ok(()) => BridgeState::Closed,
        Err(error) => BridgeState::Failed(error),
    });
}

async fn accept_viewer(
    listener: &TcpListener,
    ticket: &str,
    ticket_ttl: Duration,
) -> Result<WebSocketStream<TcpStream>> {
    let expected = format!("/rd/{ticket}");
    let deadline = tokio::time::Instant::now() + ticket_ttl;
    for _ in 0..MAX_UPGRADE_ATTEMPTS {
        let (stream, peer) = tokio::time::timeout_at(deadline, listener.accept())
            .await
            .map_err(|_| RemoteDesktopError::new("remote_desktop_ticket_expired"))?
            .map_err(|_| RemoteDesktopError::new("remote_desktop_bridge_unavailable"))?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let expected = expected.clone();
        let callback = move |request: &Request, mut response: Response| {
            if !constant_time_eq(request.uri().path().as_bytes(), expected.as_bytes()) {
                return Err(refuse(StatusCode::NOT_FOUND));
            }
            let origin = request
                .headers()
                .get("origin")
                .map(|value| value.to_str().unwrap_or("\u{0}"));
            if !origin_allowed(origin) {
                return Err(refuse(StatusCode::FORBIDDEN));
            }
            let offers_binary = request
                .headers()
                .get_all("sec-websocket-protocol")
                .iter()
                .filter_map(|value| value.to_str().ok())
                .flat_map(|value| value.split(','))
                .any(|protocol| protocol.trim() == "binary");
            if offers_binary {
                response
                    .headers_mut()
                    .insert("sec-websocket-protocol", HeaderValue::from_static("binary"));
            }
            Ok(response)
        };
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME_BYTES))
            .max_frame_size(Some(MAX_FRAME_BYTES));
        let upgrade = tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(config));
        match tokio::time::timeout_at(deadline, upgrade).await {
            Ok(Ok(viewer)) => return Ok(viewer),
            Ok(Err(_)) => continue,
            Err(_) => return Err(RemoteDesktopError::new("remote_desktop_ticket_expired")),
        }
    }
    Err(RemoteDesktopError::new("remote_desktop_ticket_expired"))
}

/// Dial, authenticate and forward between the viewer stream and the server.
async fn relay(
    mut viewer: ViewerStream,
    target: BridgeTarget,
    state: &watch::Sender<BridgeState>,
) -> Result<()> {
    let mut server = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(target.addr))
        .await
        .map_err(|_| RemoteDesktopError::new("remote_desktop_connect_timeout"))?
        .map_err(|_| RemoteDesktopError::new("remote_desktop_connect_failed"))?;
    let _ = server.set_nodelay(true);
    if target.adapter == Adapter::Vnc {
        tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            rfb::authenticate(&mut server, target.password.as_deref()),
        )
        .await
        .map_err(|_| RemoteDesktopError::new("remote_desktop_handshake_timeout"))??;
    }
    drop(target.password);
    if target.adapter == Adapter::Vnc {
        tokio::time::timeout(HANDSHAKE_TIMEOUT, rfb::present_authenticated(&mut viewer))
            .await
            .map_err(|_| RemoteDesktopError::new("remote_desktop_handshake_timeout"))??;
    }
    let _ = state.send(BridgeState::Connected);
    // Either side ending ends the session. A viewer that goes away (end of
    // stream, or its pipe dropped mid-write) is a clean close; a server
    // failure is a lost connection. The server closing is relayed to the
    // viewer as end of stream so its transport closes too.
    let (mut viewer_read, mut viewer_write) = tokio::io::split(viewer);
    let (mut server_read, mut server_write) = server.split();
    let upstream = async {
        let mut buffer = vec![0; PIPE_BYTES];
        loop {
            let read = match viewer_read.read(&mut buffer).await {
                Ok(0) | Err(_) => return Ok(()),
                Ok(read) => read,
            };
            server_write
                .write_all(&buffer[..read])
                .await
                .map_err(|_| RemoteDesktopError::new("remote_desktop_connection_lost"))?;
        }
    };
    let downstream = async {
        let mut buffer = vec![0; PIPE_BYTES];
        loop {
            let read = server_read
                .read(&mut buffer)
                .await
                .map_err(|_| RemoteDesktopError::new("remote_desktop_connection_lost"))?;
            if read == 0 {
                let _ = viewer_write.shutdown().await;
                return Ok(());
            }
            if viewer_write.write_all(&buffer[..read]).await.is_err() {
                return Ok(());
            }
        }
    };
    tokio::select! {
        result = upstream => result,
        result = downstream => result,
    }
}

/// Binary WebSocket frames ⇄ an in-memory byte stream. Ends when either side
/// closes; text frames are a protocol violation for an RFB viewer.
async fn pump(viewer: WebSocketStream<TcpStream>, io: DuplexStream) -> Result<()> {
    let lost = |_| RemoteDesktopError::new("remote_desktop_connection_lost");
    let (mut sink, mut stream) = viewer.split();
    let (mut reader, mut writer) = tokio::io::split(io);
    let inbound = async {
        while let Some(message) = stream.next().await {
            match message.map_err(|_| RemoteDesktopError::new("remote_desktop_connection_lost"))? {
                Message::Binary(bytes) => writer.write_all(&bytes).await.map_err(lost)?,
                Message::Close(_) => break,
                Message::Text(_) => {
                    return Err(RemoteDesktopError::new("remote_desktop_protocol_invalid"))
                }
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
        }
        Ok(())
    };
    let outbound = async {
        let mut buffer = vec![0; PIPE_BYTES];
        loop {
            let read = reader.read(&mut buffer).await.map_err(lost)?;
            if read == 0 {
                let _ = sink.send(Message::Close(None)).await;
                return Ok(());
            }
            sink.send(Message::Binary(buffer[..read].to_vec().into()))
                .await
                .map_err(|_| RemoteDesktopError::new("remote_desktop_connection_lost"))?;
        }
    };
    tokio::select! {
        result = inbound => result,
        result = outbound => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    async fn fake_vnc_server(password_ok: bool) -> (SocketAddr, JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket.write_all(b"RFB 003.008\n").await.unwrap();
            let mut banner = [0; 12];
            socket.read_exact(&mut banner).await.unwrap();
            socket.write_all(&[1, 2]).await.unwrap();
            let mut chosen = [0; 1];
            socket.read_exact(&mut chosen).await.unwrap();
            socket.write_all(b"0123456789abcdef").await.unwrap();
            let mut response = [0; 16];
            socket.read_exact(&mut response).await.unwrap();
            let ok = password_ok
                && response == rfb::vnc_auth_response("secret", b"0123456789abcdef");
            if !ok {
                socket.write_all(&1u32.to_be_bytes()).await.unwrap();
                socket.write_all(&4u32.to_be_bytes()).await.unwrap();
                socket.write_all(b"nope").await.unwrap();
                return Vec::new();
            }
            socket.write_all(&0u32.to_be_bytes()).await.unwrap();
            // ClientInit from the viewer, then a fake ServerInit-ish payload.
            let mut client_init = [0; 1];
            socket.read_exact(&mut client_init).await.unwrap();
            socket.write_all(b"SERVERINIT").await.unwrap();
            // Hold the connection until the bridge hangs up.
            let mut rest = Vec::new();
            let _ = socket.read_to_end(&mut rest).await;
            client_init.to_vec()
        });
        (addr, task)
    }

    async fn connect(url: &str, origin: Option<&str>) -> std::result::Result<WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>, ()> {
        let mut request = url.into_client_request().unwrap();
        if let Some(origin) = origin {
            request.headers_mut().insert("origin", origin.parse().unwrap());
        }
        request
            .headers_mut()
            .insert("sec-websocket-protocol", "binary".parse().unwrap());
        tokio_tungstenite::connect_async(request)
            .await
            .map(|(socket, response)| {
                assert_eq!(
                    response.headers().get("sec-websocket-protocol").unwrap(),
                    "binary"
                );
                socket
            })
            .map_err(|_| ())
    }

    async fn read_binary(socket: &mut WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>, len: usize) -> Vec<u8> {
        let mut out = Vec::new();
        while out.len() < len {
            match socket.next().await.unwrap().unwrap() {
                Message::Binary(bytes) => out.extend_from_slice(&bytes),
                other => panic!("unexpected {other:?}"),
            }
        }
        out
    }

    #[test]
    fn origins_are_limited_to_the_app() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("tauri://localhost")));
        assert!(origin_allowed(Some("http://tauri.localhost")));
        assert!(origin_allowed(Some("http://localhost:3000")));
        assert!(origin_allowed(Some("http://127.0.0.1:3000")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("http://localhost.evil.example")));
        assert!(!origin_allowed(Some("file://localhost/x")));
        assert!(!origin_allowed(Some("null")));
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[tokio::test]
    async fn a_viewer_gets_an_authenticated_stream_and_never_the_password() {
        let (addr, server) = fake_vnc_server(true).await;
        let mut bridge = Bridge::start(
            BridgeTarget {
                addr,
                adapter: Adapter::Vnc,
                password: Some("secret".into()),
            },
            Attachment::Loopback,
            TICKET_TTL,
        )
        .await
        .unwrap();
        assert!(bridge.url.as_deref().unwrap().starts_with("ws://127.0.0.1:"));
        let mut viewer = connect(bridge.url.as_deref().unwrap(), Some("tauri://localhost")).await.unwrap();
        // The Host presents itself as a 3.8 server offering only None.
        assert_eq!(read_binary(&mut viewer, 12).await, b"RFB 003.008\n");
        viewer.send(Message::Binary(b"RFB 003.008\n".to_vec().into())).await.unwrap();
        assert_eq!(read_binary(&mut viewer, 2).await, [1, rfb::SECURITY_NONE]);
        viewer.send(Message::Binary(vec![rfb::SECURITY_NONE].into())).await.unwrap();
        assert_eq!(read_binary(&mut viewer, 4).await, 0u32.to_be_bytes());
        viewer.send(Message::Binary(vec![1].into())).await.unwrap();
        assert_eq!(read_binary(&mut viewer, 10).await, b"SERVERINIT");
        assert_eq!(bridge.state(), BridgeState::Connected);
        viewer.close(None).await.unwrap();
        assert_eq!(bridge.finished().await, BridgeState::Closed);
        // The viewer's ClientInit reached the server unchanged.
        assert_eq!(server.await.unwrap(), vec![1]);
    }

    #[tokio::test]
    async fn the_ticket_is_single_use_and_wrong_paths_or_origins_are_refused() {
        let (addr, _server) = fake_vnc_server(true).await;
        let bridge = Bridge::start(
            BridgeTarget {
                addr,
                adapter: Adapter::Vnc,
                password: Some("secret".into()),
            },
            Attachment::Loopback,
            TICKET_TTL,
        )
        .await
        .unwrap();
        let base = bridge.url.as_deref().unwrap().rsplit_once('/').unwrap().0.to_owned();
        assert!(connect(&format!("{base}/wrong"), None).await.is_err());
        assert!(connect(bridge.url.as_deref().unwrap(), Some("https://evil.example")).await.is_err());
        let _first = connect(bridge.url.as_deref().unwrap(), None).await.unwrap();
        // The listener is gone after the first accepted upgrade.
        assert!(connect(bridge.url.as_deref().unwrap(), None).await.is_err());
    }

    #[tokio::test]
    async fn authentication_failure_is_reported_and_closes_the_viewer() {
        let (addr, _server) = fake_vnc_server(false).await;
        let mut bridge = Bridge::start(
            BridgeTarget {
                addr,
                adapter: Adapter::Vnc,
                password: Some("wrong".into()),
            },
            Attachment::Loopback,
            TICKET_TTL,
        )
        .await
        .unwrap();
        let mut viewer = connect(bridge.url.as_deref().unwrap(), None).await.unwrap();
        match bridge.finished().await {
            BridgeState::Failed(error) => {
                assert_eq!(error.code, "remote_desktop_auth_failed");
                assert_eq!(error.detail.as_deref(), Some("nope"));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(viewer.next().await, None | Some(Err(_)) | Some(Ok(Message::Close(_)))));
    }

    #[tokio::test]
    async fn an_unused_ticket_expires_and_host_close_ends_a_live_session() {
        let (addr, _server) = fake_vnc_server(true).await;
        let mut idle = Bridge::start(
            BridgeTarget {
                addr,
                adapter: Adapter::Vnc,
                password: None,
            },
            Attachment::Loopback,
            Duration::from_millis(50),
        )
        .await
        .unwrap();
        match idle.finished().await {
            BridgeState::Failed(error) => assert_eq!(error.code, "remote_desktop_ticket_expired"),
            other => panic!("unexpected {other:?}"),
        }

        // A raw `none` bridge: bytes pass through untouched until the Host closes.
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_addr = echo.local_addr().unwrap();
        let _echo = tokio::spawn(async move {
            let (mut socket, _) = echo.accept().await.unwrap();
            let mut buf = [0; 5];
            socket.read_exact(&mut buf).await.unwrap();
            socket.write_all(&buf).await.unwrap();
            std::future::pending::<()>().await;
        });
        let mut bridge = Bridge::start(
            BridgeTarget {
                addr: echo_addr,
                adapter: Adapter::None,
                password: None,
            },
            Attachment::Loopback,
            TICKET_TTL,
        )
        .await
        .unwrap();
        let mut viewer = connect(bridge.url.as_deref().unwrap(), None).await.unwrap();
        viewer.send(Message::Binary(b"hello".to_vec().into())).await.unwrap();
        assert_eq!(read_binary(&mut viewer, 5).await, b"hello");
        bridge.close();
        assert_eq!(bridge.finished().await, BridgeState::Closed);
        assert!(matches!(viewer.next().await, None | Some(Err(_)) | Some(Ok(Message::Close(_)))));
    }

    #[tokio::test]
    async fn an_unreachable_server_fails_the_session() {
        let unused = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = unused.local_addr().unwrap();
        drop(unused);
        let mut bridge = Bridge::start(
            BridgeTarget {
                addr,
                adapter: Adapter::Vnc,
                password: None,
            },
            Attachment::Loopback,
            TICKET_TTL,
        )
        .await
        .unwrap();
        let _viewer = connect(bridge.url.as_deref().unwrap(), None).await.unwrap();
        match bridge.finished().await {
            BridgeState::Failed(error) => assert_eq!(error.code, "remote_desktop_connect_failed"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_remote_viewer_attaches_once_and_gets_the_authenticated_stream() {
        let (addr, server) = fake_vnc_server(true).await;
        let mut bridge = Bridge::start(
            BridgeTarget {
                addr,
                adapter: Adapter::Vnc,
                password: Some("secret".into()),
            },
            Attachment::Remote,
            TICKET_TTL,
        )
        .await
        .unwrap();
        // No listener: nothing on loopback carries a remote session.
        assert!(bridge.url.is_none());
        let handle = bridge.attach_handle();
        let (mut viewer, host_end) = tokio::io::duplex(PIPE_BYTES);
        handle.attach(Box::new(host_end)).unwrap();
        let (_, spare) = tokio::io::duplex(8);
        assert_eq!(
            handle.attach(Box::new(spare)).unwrap_err().code,
            "remote_desktop_session_attached"
        );
        let mut banner = [0; 12];
        viewer.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"RFB 003.008\n");
        viewer.write_all(b"RFB 003.008\n").await.unwrap();
        let mut offer = [0; 2];
        viewer.read_exact(&mut offer).await.unwrap();
        assert_eq!(offer, [1, rfb::SECURITY_NONE]);
        viewer.write_all(&[rfb::SECURITY_NONE]).await.unwrap();
        let mut result = [0; 4];
        viewer.read_exact(&mut result).await.unwrap();
        assert_eq!(result, 0u32.to_be_bytes());
        viewer.write_all(&[1]).await.unwrap();
        let mut init = [0; 10];
        viewer.read_exact(&mut init).await.unwrap();
        assert_eq!(&init, b"SERVERINIT");
        assert_eq!(bridge.state(), BridgeState::Connected);
        // The transport going away is a clean end of the session.
        drop(viewer);
        assert_eq!(bridge.finished().await, BridgeState::Closed);
        assert_eq!(server.await.unwrap(), vec![1]);
    }

    #[tokio::test]
    async fn a_remote_bridge_expires_unattached_and_a_loopback_bridge_refuses_attach() {
        let (addr, _server) = fake_vnc_server(true).await;
        let mut idle = Bridge::start(
            BridgeTarget {
                addr,
                adapter: Adapter::Vnc,
                password: None,
            },
            Attachment::Remote,
            Duration::from_millis(50),
        )
        .await
        .unwrap();
        let late = idle.attach_handle();
        match idle.finished().await {
            BridgeState::Failed(error) => assert_eq!(error.code, "remote_desktop_ticket_expired"),
            other => panic!("unexpected {other:?}"),
        }
        let (_, stream) = tokio::io::duplex(8);
        assert_eq!(late.attach(Box::new(stream)).unwrap_err().code, "remote_desktop_session_not_found");

        let loopback = Bridge::start(
            BridgeTarget {
                addr,
                adapter: Adapter::Vnc,
                password: None,
            },
            Attachment::Loopback,
            TICKET_TTL,
        )
        .await
        .unwrap();
        let (_, stream) = tokio::io::duplex(8);
        assert_eq!(
            loopback.attach_handle().attach(Box::new(stream)).unwrap_err().code,
            "remote_desktop_session_attached"
        );
    }

    #[tokio::test]
    async fn the_server_closing_ends_the_remote_viewer_stream() {
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_addr = echo.local_addr().unwrap();
        let _echo = tokio::spawn(async move {
            let (mut socket, _) = echo.accept().await.unwrap();
            socket.write_all(b"bye").await.unwrap();
        });
        let mut bridge = Bridge::start(
            BridgeTarget {
                addr: echo_addr,
                adapter: Adapter::None,
                password: None,
            },
            Attachment::Remote,
            TICKET_TTL,
        )
        .await
        .unwrap();
        let (mut viewer, host_end) = tokio::io::duplex(PIPE_BYTES);
        bridge.attach_handle().attach(Box::new(host_end)).unwrap();
        let mut received = Vec::new();
        viewer.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, b"bye");
        assert_eq!(bridge.finished().await, BridgeState::Closed);
    }
}
