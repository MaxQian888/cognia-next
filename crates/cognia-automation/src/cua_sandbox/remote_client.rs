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
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{self, WsRequest};
use crate::automation::types::{AutomationError, Result};

type Job = (WsRequest, oneshot::Sender<Result<Value>>);

pub struct CuaRemoteClient {
    tx: mpsc::Sender<Job>,
}

fn backend_err(msg: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: msg.into(),
    }
}

impl CuaRemoteClient {
    /// Connect to `ws://{host}:{port}/ws` and spawn the request/response pump.
    pub async fn connect(host: &str, port: u16) -> Result<Arc<Self>> {
        let url = format!("ws://{host}:{port}/ws");
        let (stream, _) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| backend_err(format!("cua connect {url}: {e}")))?;
        let (mut sink, mut source) = stream.split();
        let (tx, mut rx) = mpsc::channel::<Job>(32);

        tokio::spawn(async move {
            while let Some((req, reply)) = rx.recv().await {
                let payload = match serde_json::to_string(&req) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = reply.send(Err(backend_err(format!("cua encode: {e}"))));
                        continue;
                    }
                };
                if let Err(e) = sink.send(Message::Text(payload.into())).await {
                    let _ = reply.send(Err(backend_err(format!("cua send: {e}"))));
                    continue;
                }
                // Read frames until the next text frame — that's this command's
                // response. Ping/pong/binary frames are skipped.
                let resp = loop {
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
                };
                let _ = reply.send(resp);
            }
        });

        Ok(Arc::new(Self { tx }))
    }

    /// Send a request and await its response (30s timeout).
    pub async fn call(&self, req: WsRequest) -> Result<Value> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send((req, reply_tx))
            .await
            .map_err(|_| backend_err("cua client channel closed"))?;
        tokio::time::timeout(Duration::from_secs(30), reply_rx)
            .await
            .map_err(|_| backend_err("cua call timed out"))?
            .map_err(|_| backend_err("cua reply channel dropped"))?
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
