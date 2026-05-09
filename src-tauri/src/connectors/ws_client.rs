//! Outbound WebSocket client for platform connectors.
//!
//! Wraps `tokio_tungstenite::connect_async` and emits Tauri events:
//!   `connectors://ws/<id>/open`
//!   `connectors://ws/<id>/message`
//!   `connectors://ws/<id>/close`
//!   `connectors://ws/<id>/error`
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

use crate::proxy_config;
use crate::proxy_config::wsproxy::{AsyncReadWrite, ProxyStream};

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
/// `app` is used to emit Tauri events to the renderer.
pub async fn open_ws(
    app: tauri::AppHandle,
    url: String,
    extra_headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    use tauri::Emitter;
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
    let target_port = parsed.port_or_known_default().unwrap_or(if is_secure {
        443
    } else {
        80
    });

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
    let app_clone = app.clone();
    let _ = app.emit(&format!("connectors://ws/{id}/open"), ());

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
                    let _ = app_clone
                        .emit(&format!("connectors://ws/{id_clone}/message"), text.to_string());
                }
                Ok(Message::Binary(bytes)) => {
                    let _ = app_clone.emit(
                        &format!("connectors://ws/{id_clone}/message"),
                        format!("<binary:{}>", bytes.len()),
                    );
                }
                Ok(Message::Close(_)) | Err(_) => {
                    let _ =
                        app_clone.emit(&format!("connectors://ws/{id_clone}/close"), ());
                    handles().lock().unwrap().remove(&id_clone);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use std::net::SocketAddr;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

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
        ws_stream
            .send(Message::Text("ping".into()))
            .await
            .unwrap();
        let msg = ws_stream.next().await.unwrap().unwrap();
        assert_eq!(msg.to_text().unwrap(), "ping");
    }
}
