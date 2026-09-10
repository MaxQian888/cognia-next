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
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};
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
    cancel: Arc<Notify>,
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
    open_ws_with_handle(emitter, url, extra_headers, Uuid::new_v4().to_string()).await
}

/// Open a WebSocket using a caller-preallocated UUID handle.
///
/// The renderer can subscribe to every event topic before the handshake begins,
/// which prevents a server's first frame from racing listener registration.
pub async fn open_ws_with_handle(
    emitter: Arc<dyn EventEmitter>,
    url: String,
    extra_headers: Option<HashMap<String, String>>,
    id: String,
) -> Result<String, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    Uuid::parse_str(&id).map_err(|_| "WS handle id must be a UUID".to_string())?;

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

    let proxy_cfg = proxy_config::current().map_err(|error| error.to_string())?;
    let route = proxy_cfg
        .websocket_route_for(&url)
        .map_err(|error| error.to_string())?;
    let use_proxy = matches!(route, proxy_config::ProxyRouteSummary::Proxy { .. });

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
        log::info!("WS connecting via {route:?} → {target_host}:{target_port}");
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

    let cancel = Arc::new(Notify::new());
    {
        let mut registry = handles().lock().unwrap();
        if registry.contains_key(&id) {
            return Err("WS handle is already open".into());
        }
        registry.insert(
            id.clone(),
            WsHandle {
                tx,
                cancel: cancel.clone(),
            },
        );
    }

    let id_clone = id.clone();
    let emitter_clone = Arc::clone(&emitter);
    emitter.emit(
        &format!("connectors://ws/{id}/open"),
        serde_json::Value::Null,
    );

    // One owner coordinates both halves. A failed writer, reader EOF, or
    // explicit close always takes the same cleanup path and emits close once.
    tokio::spawn(async move {
        let mut close_payload = close_event_payload(None);
        let result: Result<(), String> = tokio::select! {
            _ = cancel.notified() => Ok(()),
            result = async {
                loop {
                    tokio::select! {
                        outbound = rx.recv() => {
                            let Some(message) = outbound else { break Ok(()); };
                            tokio::time::timeout(Duration::from_secs(10), sink.send(message))
                                .await.map_err(|_| "WS write timed out".to_string())?
                                .map_err(|e| format!("WS write failed: {e}"))?;
                        }
                        inbound = stream.next() => match inbound {
                            Some(Ok(Message::Text(value))) => emitter_clone.emit(
                                &format!("connectors://ws/{id_clone}/message"),
                                serde_json::Value::String(value.to_string())),
                            Some(Ok(Message::Binary(value))) => emitter_clone.emit(
                                &format!("connectors://ws/{id_clone}/binary"),
                                serde_json::Value::String(binary_event_payload(&value))),
                            Some(Ok(Message::Close(frame))) => {
                                close_payload = close_event_payload(frame.as_ref());
                                break Ok(());
                            }
                            Some(Err(error)) => break Err(error.to_string()),
                            None => break Ok(()),
                            _ => {},
                        }
                    }
                }
            } => result,
        };
        if let Err(error) = result {
            emitter_clone.emit(
                &format!("connectors://ws/{id_clone}/error"),
                serde_json::Value::String(error),
            );
        }
        // Do not let a peer that never completes the close handshake retain
        // this task or block global connector teardown.
        let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
        let mut registry = handles().lock().unwrap();
        if registry
            .get(&id_clone)
            .is_some_and(|handle| Arc::ptr_eq(&handle.cancel, &cancel))
        {
            registry.remove(&id_clone);
        }
        drop(registry);
        emitter_clone.emit(&format!("connectors://ws/{id_clone}/close"), close_payload);
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

/// Send a binary message on the given handle.
pub async fn ws_send_binary(handle_id: &str, data: Vec<u8>) -> Result<(), String> {
    let tx = {
        let map = handles().lock().unwrap();
        map.get(handle_id)
            .map(|h| h.tx.clone())
            .ok_or_else(|| format!("WS handle '{handle_id}' not found"))?
    };
    tx.send(Message::Binary(data.into()))
        .await
        .map_err(|e| format!("send failed: {e}"))
}

/// Close the WebSocket connection.
pub async fn ws_close(handle_id: &str) -> Result<(), String> {
    let handle = handles()
        .lock()
        .unwrap()
        .remove(handle_id)
        .ok_or_else(|| format!("WS handle '{handle_id}' not found"))?;
    handle.cancel.notify_one();
    Ok(())
}

/// Cancel all sockets without waiting for a congested outbound queue.
pub async fn close_all() -> usize {
    close_handles(handles())
}

fn close_handles(registry: &Mutex<HashMap<String, WsHandle>>) -> usize {
    let sockets: Vec<WsHandle> = registry
        .lock()
        .unwrap()
        .drain()
        .map(|(_, value)| value)
        .collect();
    let count = sockets.len();
    for handle in sockets {
        handle.cancel.notify_one();
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

        proxy_config::apply_current(Default::default()).unwrap();
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
        let expected_handle_id = "00000000-0000-4000-8000-000000000001".to_string();
        let handle_id = open_ws_with_handle(
            emitter.clone(),
            format!("ws://{addr}"),
            None,
            expected_handle_id.clone(),
        )
        .await
        .unwrap();
        assert_eq!(handle_id, expected_handle_id);

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

    #[tokio::test]
    async fn ws_send_binary_preserves_bytes() {
        proxy_config::apply_current(Default::default()).unwrap();
        let addr = spawn_echo_server().await;
        let emitter = Arc::new(RecordingEmitter::default());
        let handle_id = open_ws(emitter.clone(), format!("ws://{addr}"), None)
            .await
            .unwrap();

        ws_send_binary(&handle_id, vec![1, 2, 255]).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if emitter.events.lock().iter().any(|(topic, payload)| {
                    topic.ends_with("/binary")
                        && payload == &serde_json::Value::String("AQL/".into())
                }) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        ws_close(&handle_id).await.unwrap();
    }

    #[tokio::test]
    async fn open_ws_rejects_non_uuid_preallocated_handle() {
        let emitter = Arc::new(RecordingEmitter::default());
        let error = open_ws_with_handle(emitter, "ws://localhost".into(), None, "guessable".into())
            .await
            .unwrap_err();
        assert_eq!(error, "WS handle id must be a UUID");
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
    async fn disconnected_peer_cleans_registry_and_emits_close_once() {
        proxy_config::apply_current(Default::default()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let socket = accept_async(tcp).await.unwrap();
            drop(socket); // Abrupt EOF, without a close frame.
        });
        let emitter = Arc::new(RecordingEmitter::default());
        let id = open_ws(emitter.clone(), format!("ws://{address}"), None)
            .await
            .unwrap();
        server.await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !emitter
                .events
                .lock()
                .iter()
                .any(|(topic, _)| topic.ends_with("/close"))
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!handles().lock().unwrap().contains_key(&id));
        assert_eq!(
            emitter
                .events
                .lock()
                .iter()
                .filter(|(topic, _)| topic.ends_with("/close"))
                .count(),
            1
        );
        assert!(ws_send(&id, "after close".into()).await.is_err());
    }

    #[tokio::test]
    async fn local_close_finishes_even_when_peer_never_reads() {
        proxy_config::apply_current(Default::default()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let _socket = accept_async(tcp).await.unwrap();
            let _ = stopped.await;
        });
        let emitter = Arc::new(RecordingEmitter::default());
        let id = open_ws(emitter.clone(), format!("ws://{address}"), None)
            .await
            .unwrap();
        ws_close(&id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !emitter
                .events
                .lock()
                .iter()
                .any(|(topic, _)| topic.ends_with("/close"))
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        stop.send(()).unwrap();
        server.await.unwrap();
        assert!(!handles().lock().unwrap().contains_key(&id));
    }

    #[tokio::test]
    async fn close_does_not_wait_for_full_outbound_queue() {
        let (tx, _rx) = mpsc::channel(1);
        tx.send(Message::Text("queued".into())).await.unwrap();
        handles().lock().unwrap().insert(
            "full-queue".into(),
            WsHandle {
                tx,
                cancel: Arc::new(Notify::new()),
            },
        );
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            ws_close("full-queue"),
        )
        .await
        .expect("shutdown must not await queue capacity")
        .unwrap();
    }

    #[tokio::test]
    async fn close_all_drains_every_handle() {
        let registry = Mutex::new(HashMap::new());
        let (tx1, _rx1) = mpsc::channel::<Message>(1);
        let (tx2, _rx2) = mpsc::channel::<Message>(1);
        let cancel = Arc::new(Notify::new());
        registry.lock().unwrap().insert(
            "h1".into(),
            WsHandle {
                tx: tx1,
                cancel: cancel.clone(),
            },
        );
        registry.lock().unwrap().insert(
            "h2".into(),
            WsHandle {
                tx: tx2,
                cancel: Arc::new(Notify::new()),
            },
        );
        assert_eq!(close_handles(&registry), 2);
        assert!(registry.lock().unwrap().is_empty());
        tokio::time::timeout(Duration::from_millis(100), cancel.notified())
            .await
            .unwrap();
    }
}
