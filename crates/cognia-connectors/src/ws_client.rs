//! Outbound WebSocket client for platform connectors.
//!
//! Wraps `tokio_tungstenite::connect_async` and emits Tauri events:
//!   `connectors://ws/<id>/open`    — payload `()`
//!   `connectors://ws/<id>/message` — text frame contents (string)
//!   `connectors://ws/<id>/binary`  — binary frame as base64 (string)
//!   `connectors://ws/<id>/close`   — `{code, reason}` (both null when the
//!                                    stream ended without a close frame)
//!   `connectors://ws/<id>/error`   — read-pump error message (string)
//!
//! A stable handle `id` (UUIDv4) is returned to the TS side so it can call
//! `connectors_ws_send` / `connectors_ws_close` referencing that id.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{client_async_tls, tungstenite::Message};
use uuid::Uuid;

use cognia_net::proxy_config;
use cognia_net::proxy_config::wsproxy::{AsyncReadWrite, ProxyStream};

use super::axum_app::EventEmitter;

// ---------------------------------------------------------------------------
// Handle registry (global, process-scoped)
// ---------------------------------------------------------------------------

type SendTx = mpsc::Sender<Message>;

struct WsHandle {
    tx: SendTx,
}

static WS_HANDLES: OnceLock<Arc<Mutex<HashMap<String, WsHandle>>>> = OnceLock::new();

fn handles() -> &'static Arc<Mutex<HashMap<String, WsHandle>>> {
    WS_HANDLES.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Open a WebSocket connection. Returns the stable handle id.
///
/// `emitter` forwards events to either the desktop renderer or the headless
/// companion event bus.
pub async fn open_ws(
    emitter: Arc<dyn EventEmitter>,
    url: String,
    extra_headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("invalid WS URL: {e}"))?;

    if let Some(headers) = extra_headers {
        for (k, v) in headers {
            let name = k
                .parse::<tokio_tungstenite::tungstenite::http::header::HeaderName>()
                .map_err(|e| format!("invalid header name '{k}': {e}"))?;
            let value = v
                .parse::<tokio_tungstenite::tungstenite::http::header::HeaderValue>()
                .map_err(|e| format!("invalid header value for '{k}': {e}"))?;
            request.headers_mut().insert(name, value);
        }
    }

    let id = Uuid::new_v4().to_string();
    let proxy_cfg = proxy_config::current();
    let proxy_url_for_log = proxy_cfg.proxy_url();
    let use_proxy =
        proxy_cfg.is_active() && proxy_cfg.proxy_websockets && !proxy_cfg.should_bypass(&url);

    // Pre-parse the target so both paths know what to dial.
    let parsed = url::Url::parse(&url).map_err(|e| format!("invalid WS URL: {e}"))?;
    let target_host = parsed
        .host_str()
        .ok_or_else(|| "WS URL missing host".to_string())?
        .to_string();
    let is_secure = parsed.scheme() == "wss";
    let target_port = parsed
        .port_or_known_default()
        .unwrap_or(if is_secure { 443 } else { 80 });

    // Both branches produce the same erased `ProxyStream` type so the
    // downstream split() / send / recv plumbing has a single concrete type.
    let raw_stream: ProxyStream = if use_proxy {
        log::info!(
            "WS connecting via proxy {:?} → {target_host}:{target_port}",
            proxy_url_for_log
        );
        proxy_config::wsproxy::connect_via_proxy(&proxy_cfg, &target_host, target_port)
            .await
            .map_err(|e| format!("WS proxy tunnel failed: {e}"))?
    } else {
        let tcp = TcpStream::connect((target_host.as_str(), target_port))
            .await
            .map_err(|e| format!("WS connect failed: {e}"))?;
        let boxed: Box<dyn AsyncReadWrite + Send + Unpin> = Box::new(tcp);
        boxed
    };

    let (ws_stream, _) = client_async_tls(request, raw_stream)
        .await
        .map_err(|e| format!("WS handshake failed: {e}"))?;
    let (mut sink, mut stream) = ws_stream.split();
    let (tx, mut rx) = mpsc::channel::<Message>(64);

    handles()
        .lock()
        .unwrap()
        .insert(id.clone(), WsHandle { tx });

    let id_clone = id.clone();
    let emitter_clone = Arc::clone(&emitter);
    emitter.emit(
        &format!("connectors://ws/{id}/open"),
        serde_json::Value::Null,
    );

    // Pump outbound messages from the mpsc channel to the WS sink.
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Pump inbound messages from WS to Tauri events.
    tokio::spawn(async move {
        while let Some(item) = stream.next().await {
            match item {
                Ok(Message::Text(text)) => {
                    emitter_clone.emit(
                        &format!("connectors://ws/{id_clone}/message"),
                        serde_json::Value::String(text.to_string()),
                    );
                }
                Ok(Message::Binary(bytes)) => {
                    // Binary frames ride a dedicated `/binary` topic as base64
                    // so `/message` listeners keep receiving text only.
                    log::debug!(
                        "WS {id_clone}: binary frame ({} bytes) → /binary",
                        bytes.len()
                    );
                    emitter_clone.emit(
                        &format!("connectors://ws/{id_clone}/binary"),
                        serde_json::Value::String(binary_event_payload(&bytes)),
                    );
                }
                Ok(Message::Close(frame)) => {
                    emitter_clone.emit(
                        &format!("connectors://ws/{id_clone}/close"),
                        close_event_payload(frame.as_ref()),
                    );
                    handles().lock().unwrap().remove(&id_clone);
                    break;
                }
                Err(e) => {
                    emitter_clone.emit(
                        &format!("connectors://ws/{id_clone}/error"),
                        serde_json::Value::String(e.to_string()),
                    );
                    emitter_clone.emit(
                        &format!("connectors://ws/{id_clone}/close"),
                        close_event_payload(None),
                    );
                    handles().lock().unwrap().remove(&id_clone);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(id)
}

/// Base64 payload for the `/binary` topic.
fn binary_event_payload(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `{code, reason}` payload for the `/close` topic. Both fields are `null`
/// when the peer vanished without a close frame (abrupt EOF / read error).
fn close_event_payload(
    frame: Option<&tokio_tungstenite::tungstenite::protocol::CloseFrame>,
) -> serde_json::Value {
    serde_json::json!({
        "code": frame.map(|f| u16::from(f.code)),
        "reason": frame.map(|f| f.reason.to_string()),
    })
}

/// Send a text message on the given handle.
pub async fn ws_send(handle_id: &str, data: String) -> Result<(), String> {
    let tx = {
        let map = handles().lock().unwrap();
        map.get(handle_id)
            .map(|h| h.tx.clone())
            .ok_or_else(|| format!("WS handle '{handle_id}' not found"))?
    };
    tx.send(Message::Text(data.into()))
        .await
        .map_err(|e| format!("send failed: {e}"))
}

/// Close the WebSocket connection.
pub async fn ws_close(handle_id: &str) -> Result<(), String> {
    let tx = {
        let mut map = handles().lock().unwrap();
        map.remove(handle_id)
            .map(|h| h.tx)
            .ok_or_else(|| format!("WS handle '{handle_id}' not found"))?
    };
    let _ = tx.send(Message::Close(None)).await;
    Ok(())
}

/// Close **every** live WS handle and return how many were closed.
///
/// Used on connector bootstrap to reap sockets leaked by a previous webview
/// load whose JS cleanup never ran: a hard reload / Fast-Refresh full reload
/// discards the renderer that owned the handle ids while the Rust core process
/// — and these sockets — keep running. Without this, each reload piles up a
/// zombie socket that keeps delivering duplicate inbound events.
///
/// Drains the registry under the lock, then sends `Close` outside it — the
/// std `Mutex` guard must never be held across an `.await`.
pub async fn close_all() -> usize {
    let txs: Vec<SendTx> = {
        let mut map = handles().lock().unwrap();
        map.drain().map(|(_, h)| h.tx).collect()
    };
    let count = txs.len();
    for tx in txs {
        let _ = tx.send(Message::Close(None)).await;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::axum_app::EventEmitter;
    use futures_util::StreamExt;
    use parking_lot::Mutex as ParkingMutex;
    use std::net::SocketAddr;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    #[derive(Default)]
    struct RecordingEmitter {
        events: ParkingMutex<Vec<(String, serde_json::Value)>>,
    }

    impl EventEmitter for RecordingEmitter {
        fn emit(&self, topic: &str, payload: serde_json::Value) {
            self.events.lock().push((topic.to_string(), payload));
        }
    }

    /// Spawn a minimal echo WebSocket server on an ephemeral port.
    async fn spawn_echo_server() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(tcp).await.unwrap();
            while let Some(Ok(msg)) = ws.next().await {
                if msg.is_text() || msg.is_binary() {
                    ws.send(msg).await.unwrap();
                }
            }
        });

        addr
    }

    #[tokio::test]
    async fn ws_send_and_receive_via_mock_server() {
        use futures_util::SinkExt;
        use tokio_tungstenite::{connect_async, tungstenite::Message};

        let addr = spawn_echo_server().await;
        let url = format!("ws://{addr}");
        let (mut ws_stream, _) = connect_async(&url).await.unwrap();
        ws_stream.send(Message::Text("ping".into())).await.unwrap();
        let msg = ws_stream.next().await.unwrap().unwrap();
        assert_eq!(msg.to_text().unwrap(), "ping");
    }

    #[tokio::test]
    async fn open_ws_preserves_event_topics_and_payload_shapes() {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::{
            protocol::{frame::coding::CloseCode, CloseFrame},
            Message,
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(tcp).await.unwrap();
            ws.send(Message::Text("hello".into())).await.unwrap();
            ws.send(Message::Binary(vec![0, 255].into())).await.unwrap();
            ws.send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "done".into(),
            })))
            .await
            .unwrap();
        });

        let emitter = Arc::new(RecordingEmitter::default());
        let handle_id = open_ws(emitter.clone(), format!("ws://{addr}"), None)
            .await
            .unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if emitter.events.lock().len() >= 4 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let events = emitter.events.lock();
        assert_eq!(
            events.as_slice(),
            &[
                (
                    format!("connectors://ws/{handle_id}/open"),
                    serde_json::Value::Null
                ),
                (
                    format!("connectors://ws/{handle_id}/message"),
                    serde_json::Value::String("hello".into()),
                ),
                (
                    format!("connectors://ws/{handle_id}/binary"),
                    serde_json::Value::String("AP8=".into()),
                ),
                (
                    format!("connectors://ws/{handle_id}/close"),
                    serde_json::json!({ "code": 1000, "reason": "done" }),
                ),
            ]
        );
    }

    #[test]
    fn binary_event_payload_is_base64() {
        assert_eq!(binary_event_payload(&[]), "");
        assert_eq!(binary_event_payload(b"hi"), "aGk=");
        assert_eq!(binary_event_payload(&[0u8, 255, 16]), "AP8Q");
    }

    #[test]
    fn close_event_payload_carries_code_and_reason() {
        use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
        use tokio_tungstenite::tungstenite::protocol::CloseFrame;

        let frame = CloseFrame {
            code: CloseCode::Normal,
            reason: "bye".into(),
        };
        let payload = close_event_payload(Some(&frame));
        assert_eq!(payload["code"], 1000);
        assert_eq!(payload["reason"], "bye");
    }

    #[test]
    fn close_event_payload_without_frame_is_nulls() {
        let payload = close_event_payload(None);
        assert!(payload["code"].is_null());
        assert!(payload["reason"].is_null());
    }

    #[tokio::test]
    async fn close_all_drains_every_handle() {
        // Reap any residue from a prior test so the count is deterministic.
        close_all().await;
        // Insert two synthetic handles directly into the global registry;
        // keep the receivers alive so the Close send doesn't error.
        let (tx1, _rx1) = mpsc::channel::<Message>(1);
        let (tx2, _rx2) = mpsc::channel::<Message>(1);
        {
            let mut map = handles().lock().unwrap();
            map.insert("h1".into(), WsHandle { tx: tx1 });
            map.insert("h2".into(), WsHandle { tx: tx2 });
        }
        let closed = close_all().await;
        assert_eq!(closed, 2);
        assert!(handles().lock().unwrap().is_empty());
    }
}
