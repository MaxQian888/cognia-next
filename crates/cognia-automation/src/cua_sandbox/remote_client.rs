//! Async WebSocket client to a cua `computer-server` (ADR-0020 remote-target).
//!
//! The server processes one command at a time and replies in order, so we
//! serialize calls through an mpsc queue: the pump task sends each request,
//! then reads the next text frame as that request's response. This keeps the
//! `AutomationHandle` call sites simple (`client.call(req).await`) while the
//! whole thing stays off the synchronous COM worker that drives the local
//! back-ends.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, http::HeaderValue, Error as WsError, Message,
};

pub const AUTH_HEADER: &str = "x-cognia-sandbox-token";

use super::protocol::{self, WsRequest};
use crate::automation::types::{AutomationError, Result};

type Job = (
    WsRequest,
    oneshot::Sender<Result<Value>>,
    tokio::time::Instant,
    Option<Arc<dyn Fn() -> bool + Send + Sync>>,
);

pub struct CuaRemoteClient {
    tx: mpsc::Sender<Job>,
    admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

fn backend_err(msg: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: msg.into(),
    }
}

fn auth_denied(reason: impl Into<String>) -> AutomationError {
    AutomationError::PermissionDenied {
        reason: reason.into(),
    }
}

impl CuaRemoteClient {
    /// Only admit a protected endpoint. The token stays in native request
    /// headers: never in URLs, renderer replies, logs or formatted errors.
    pub async fn connect(host: &str, port: u16, token: &str) -> Result<Arc<Self>> {
        if token.len() < 32 || token.len() > 256 {
            return Err(auth_denied("sandbox authentication token is missing or invalid; recreate with the secured desktop image"));
        }
        Self::connect_endpoint(format!("ws://{host}:{port}/ws"), token, None).await
    }

    /// Managed endpoints are constructed from validated provider metadata by
    /// the Host, never supplied by a browser. Reuse the same command pump.
    pub(crate) async fn connect_managed(
        url: String,
        guest: &str,
        traffic: &str,
    ) -> Result<Arc<Self>> {
        if !url.starts_with("wss://") {
            return Err(auth_denied("managed desktop requires TLS"));
        }
        Self::connect_endpoint(url, guest, Some(traffic)).await
    }

    async fn connect_endpoint(
        url: String,
        guest: &str,
        traffic: Option<&str>,
    ) -> Result<Arc<Self>> {
        fn header(token: &str) -> Result<HeaderValue> {
            if token.is_empty() || token.len() > 4096 {
                return Err(auth_denied(
                    "sandbox authentication token is missing or invalid",
                ));
            }
            let mut value = HeaderValue::from_str(token).map_err(|_| {
                auth_denied("sandbox authentication token has an invalid header format")
            })?;
            value.set_sensitive(true);
            Ok(value)
        }
        if guest.len() < 32 || guest.len() > 256 {
            return Err(auth_denied(
                "sandbox authentication token is missing or invalid",
            ));
        }
        let guest = header(guest)?;
        let traffic = traffic.map(header).transpose()?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        // Challenge both cloud ingress and guest auth. Never send input to a
        // legacy endpoint that accepts either missing credential.
        for edge in std::iter::once(None).chain(traffic.as_ref().map(Some)) {
            let mut probe = url
                .as_str()
                .into_client_request()
                .map_err(|_| backend_err("invalid sandbox WebSocket endpoint"))?;
            if let Some(edge) = edge {
                probe
                    .headers_mut()
                    .insert("e2b-traffic-access-token", edge.clone());
            }
            match tokio::time::timeout_at(deadline, tokio_tungstenite::connect_async(probe)).await {
                Ok(Err(WsError::Http(response)))
                    if matches!(response.status().as_u16(), 401 | 403) => {}
                Ok(Ok((stream, _))) => {
                    drop(stream);
                    return Err(auth_denied("sandbox desktop allows unauthenticated access; recreate with the secured desktop image"));
                }
                _ => {
                    return Err(backend_err(
                        "sandbox desktop did not provide the required authentication challenge",
                    ))
                }
            }
        }
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| backend_err("invalid sandbox WebSocket endpoint"))?;
        request.headers_mut().insert(AUTH_HEADER, guest);
        if let Some(traffic) = traffic {
            request
                .headers_mut()
                .insert("e2b-traffic-access-token", traffic);
        }
        let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
        config.max_message_size = Some(12 * 1024 * 1024);
        config.max_frame_size = Some(12 * 1024 * 1024);
        let (stream, _) = tokio::time::timeout_at(
            deadline,
            tokio_tungstenite::connect_async_with_config(request, Some(config), false),
        )
        .await
        .map_err(|_| backend_err("cua authenticated connect timed out"))?
        .map_err(|error| match error {
            WsError::Http(response) if matches!(response.status().as_u16(), 401 | 403) => {
                auth_denied(format!(
                    "cua authenticated connect rejected (HTTP {})",
                    response.status().as_u16()
                ))
            }
            _ => backend_err("cua authenticated WebSocket connection failed"),
        })?;
        let (mut sink, mut source) = stream.split();
        let (tx, mut rx) = mpsc::channel::<Job>(32);

        tokio::spawn(async move {
            while let Some((req, reply, deadline, admission)) = rx.recv().await {
                if reply.is_closed() || tokio::time::Instant::now() >= deadline {
                    continue;
                }
                if admission.as_ref().is_some_and(|check| !check()) {
                    let _ = reply.send(Err(auth_denied("sandbox input fence expired")));
                    continue;
                }
                let payload = match serde_json::to_string(&req) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = reply.send(Err(backend_err(format!("cua encode: {e}"))));
                        continue;
                    }
                };
                if let Err(e) =
                    tokio::time::timeout_at(deadline, sink.send(Message::Text(payload.into())))
                        .await
                        .map_err(|_| backend_err("cua send timed out"))
                        .and_then(|r| r.map_err(|e| backend_err(e.to_string())))
                {
                    let _ = reply.send(Err(backend_err(format!("cua send: {e}"))));
                    break;
                }
                // Read frames until the next text frame — that's this command's
                // response. Ping/pong/binary frames are skipped.
                let resp = tokio::time::timeout_at(deadline, async {
                    loop {
                        match source.next().await {
                            Some(Ok(Message::Text(t))) => {
                                break serde_json::from_str::<Value>(&t)
                                    .map_err(|e| backend_err(format!("cua decode: {e}")))
                                    .and_then(protocol::check_response);
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                break Err(backend_err("cua connection closed"));
                            }
                            Some(Ok(_)) => continue, // ping/pong/binary
                            Some(Err(e)) => break Err(backend_err(format!("cua recv: {e}"))),
                        }
                    }
                })
                .await;
                match resp {
                    Ok(result) => {
                        let disconnected = matches!(&result, Err(AutomationError::BackendError { message }) if message.starts_with("cua recv:") || message == "cua connection closed");
                        let _ = reply.send(result);
                        if disconnected {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = reply
                            .send(Err(backend_err("cua call timed out; connection discarded")));
                        break; // Never match a late response to a later request.
                    }
                }
            }
        });

        Ok(Arc::new(Self {
            tx,
            admission: None,
        }))
    }

    /// Each queued command checks its authority immediately before send. This
    /// also fences later commands in a compound click/scroll/drag operation.
    pub(crate) fn fenced(&self, admission: Arc<dyn Fn() -> bool + Send + Sync>) -> Arc<Self> {
        Arc::new(Self {
            tx: self.tx.clone(),
            admission: Some(admission),
        })
    }

    /// Send a request and await its response (30s timeout).
    pub async fn call(&self, req: WsRequest) -> Result<Value> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let (reply_tx, reply_rx) = oneshot::channel();
        tokio::time::timeout_at(deadline, async {
            self.tx
                .send((req, reply_tx, deadline, self.admission.clone()))
                .await
                .map_err(|_| backend_err("cua client channel closed"))?;
            reply_rx
                .await
                .map_err(|_| backend_err("cua reply channel dropped"))?
        })
        .await
        .map_err(|_| backend_err("cua call timed out"))?
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }

    /// Convenience for parameterless / ad-hoc commands.
    pub async fn call_simple(&self, command: &str, params: Value) -> Result<Value> {
        self.call(WsRequest {
            command: command.to_string(),
            params,
        })
        .await
    }
}

#[cfg(test)]
pub(crate) const TEST_AUTH_TOKEN: &str = "synthetic-desktop-test-token-00000000";

#[cfg(test)]
pub(crate) fn test_authorize(
    request: &tokio_tungstenite::tungstenite::handshake::server::Request,
    response: tokio_tungstenite::tungstenite::handshake::server::Response,
) -> std::result::Result<
    tokio_tungstenite::tungstenite::handshake::server::Response,
    tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
> {
    if request
        .headers()
        .get(AUTH_HEADER)
        .and_then(|header| header.to_str().ok())
        == Some(TEST_AUTH_TOKEN)
    {
        Ok(response)
    } else {
        Err(tokio_tungstenite::tungstenite::http::Response::builder()
            .status(401)
            .body(Some("Unauthorized".into()))
            .unwrap())
    }
}

#[cfg(test)]
pub(crate) async fn accept_test_client(
    listener: &tokio::net::TcpListener,
) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
    // The native client first probes that the unauthenticated path is denied.
    let (probe, _) = listener.accept().await.unwrap();
    assert!(tokio_tungstenite::accept_hdr_async(probe, test_authorize)
        .await
        .is_err());
    let (socket, _) = listener.accept().await.unwrap();
    tokio_tungstenite::accept_hdr_async(socket, test_authorize)
        .await
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cloud_handshake_challenges_both_auth_layers_and_keeps_secrets_out_of_url() {
        const TRAFFIC: &str = "synthetic-provider-traffic-secret";
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for index in 0..3 {
                let (socket, _) = listener.accept().await.unwrap();
                let accepted = tokio_tungstenite::accept_hdr_async(socket, move |
                    request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                    response: tokio_tungstenite::tungstenite::handshake::server::Response,
                | {
                    assert_eq!(request.uri().path(), "/ws");
                    assert!(request.uri().query().is_none());
                    assert!(!request.uri().to_string().contains(TRAFFIC));
                    assert!(!request.uri().to_string().contains(TEST_AUTH_TOKEN));
                    let traffic = request.headers().get("e2b-traffic-access-token").and_then(|v| v.to_str().ok());
                    let guest = request.headers().get(AUTH_HEADER).and_then(|v| v.to_str().ok());
                    match index {
                        0 => { assert!(traffic.is_none()); assert!(guest.is_none()); },
                        1 => { assert_eq!(traffic, Some(TRAFFIC)); assert!(guest.is_none()); },
                        2 => { assert_eq!(traffic, Some(TRAFFIC)); assert_eq!(guest, Some(TEST_AUTH_TOKEN)); return Ok(response); },
                        _ => unreachable!(),
                    }
                    Err(tokio_tungstenite::tungstenite::http::Response::builder().status(401).body(Some("Unauthorized".into())).unwrap())
                }).await;
                if index < 2 {
                    assert!(accepted.is_err());
                } else {
                    let mut stream = accepted.unwrap();
                    let request = stream.next().await.unwrap().unwrap();
                    assert!(request.to_text().unwrap().contains("screenshot"));
                    stream
                        .send(Message::Text("{\"status\":\"success\"}".into()))
                        .await
                        .unwrap();
                }
            }
        });
        // Only this private fixture helper permits a local plaintext socket;
        // production connect_managed rejects it before accessing the network.
        let client = CuaRemoteClient::connect_endpoint(
            format!("ws://127.0.0.1:{port}/ws"),
            TEST_AUTH_TOKEN,
            Some(TRAFFIC),
        )
        .await
        .unwrap();
        client
            .call_simple("screenshot", serde_json::json!({}))
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn queued_input_rechecks_fence_after_waiting_for_an_earlier_reply() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (started, received) = tokio::sync::oneshot::channel();
        let (finish, blocked) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut stream = accept_test_client(&listener).await;
            let _first = stream.next().await.unwrap().unwrap();
            started.send(()).unwrap();
            blocked.await.unwrap();
            stream
                .send(Message::Text("{\"status\":\"success\"}".into()))
                .await
                .unwrap();
            // The stale second command must never reach the remote desktop.
            assert!(
                tokio::time::timeout(Duration::from_millis(50), stream.next())
                    .await
                    .is_err()
            );
        });
        let client = CuaRemoteClient::connect("127.0.0.1", port, TEST_AUTH_TOKEN)
            .await
            .unwrap();
        let first_client = client.clone();
        let first = tokio::spawn(async move {
            first_client
                .call_simple("screenshot", serde_json::json!({}))
                .await
        });
        received.await.unwrap();
        let allowed = Arc::new(AtomicBool::new(true));
        let gate = allowed.clone();
        let guarded = client.fenced(Arc::new(move || gate.load(Ordering::SeqCst)));
        let queued = tokio::spawn(async move {
            guarded
                .call_simple("left_click", serde_json::json!({"x":1,"y":1}))
                .await
        });
        tokio::task::yield_now().await;
        allowed.store(false, Ordering::SeqCst);
        finish.send(()).unwrap();
        first.await.unwrap().unwrap();
        assert!(queued
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("fence expired"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn managed_transport_rejects_plaintext_before_any_network_operation() {
        assert!(CuaRemoteClient::connect_managed(
            "ws://127.0.0.1:1/ws".into(),
            TEST_AUTH_TOKEN,
            TEST_AUTH_TOKEN
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn missing_or_invalid_secret_is_rejected_before_network_access() {
        for token in ["".to_string(), format!("{}\ninvalid", "x".repeat(32))] {
            let error = match CuaRemoteClient::connect("127.0.0.1", 1, &token).await {
                Ok(_) => panic!("invalid secret was accepted"),
                Err(error) => error.to_string(),
            };
            assert!(error.contains("authentication token"));
            if !token.is_empty() {
                assert!(!error.contains(&token));
            }
        }
    }

    #[tokio::test]
    async fn protected_handshake_and_closed_connection_fail_closed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut stream = accept_test_client(&listener).await;
            let _ = stream.next().await;
            stream.close(None).await.unwrap();
        });
        let client = CuaRemoteClient::connect("127.0.0.1", port, TEST_AUTH_TOKEN)
            .await
            .unwrap();
        assert!(client
            .call_simple("screenshot", serde_json::json!({}))
            .await
            .is_err());
        server.await.unwrap();
        tokio::task::yield_now().await;
        assert!(client.is_closed());
        assert!(client
            .call_simple("screenshot", serde_json::json!({}))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn legacy_unauthenticated_backend_is_refused_without_sending_desktop_commands() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = tokio_tungstenite::accept_async(socket).await.unwrap();
            assert!(!matches!(stream.next().await, Some(Ok(Message::Text(_)))));
        });
        let error = match CuaRemoteClient::connect("127.0.0.1", port, TEST_AUTH_TOKEN).await {
            Ok(_) => panic!("unauthenticated desktop was accepted"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("unauthenticated access"));
        assert!(!error.contains(TEST_AUTH_TOKEN));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn wrong_secret_is_rejected_without_echoing_secret_response_or_headers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        const WRONG: &str = "synthetic-wrong-token-000000000000000";
        let server = tokio::spawn(async move {
            for index in 0..2 {
                let (socket, _) = listener.accept().await.unwrap();
                let result = tokio_tungstenite::accept_hdr_async(
                    socket,
                    move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                          _response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                        if index == 0 {
                            assert!(request.headers().get(AUTH_HEADER).is_none());
                        } else {
                            assert_eq!(request.headers()[AUTH_HEADER], WRONG);
                        }
                        Err(tokio_tungstenite::tungstenite::http::Response::builder()
                            .status(401)
                            .header("x-echo-secret", WRONG)
                            .body(Some(WRONG.into()))
                            .unwrap())
                    },
                )
                .await;
                assert!(result.is_err());
            }
        });
        let error = match CuaRemoteClient::connect("127.0.0.1", port, WRONG).await {
            Ok(_) => panic!("wrong secret was accepted"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("HTTP 401"));
        assert!(!error.contains(WRONG));
        server.await.unwrap();
    }
}
