//! Per-room Durable Object — the stateful half of the signaling rendezvous.
//!
//! One instance per `rendezvous_id` (`env.ROOM.idFromName(rid)`). It holds the
//! room's peers as hibernatable WebSockets accepted via the Durable Objects
//! WebSocket Hibernation API, so the instance can be evicted from memory
//! between messages while connections stay open. Per-connection state (role,
//! join time, rate-limit bucket) rides on each socket's serialized attachment,
//! which survives hibernation.
//!
//! This mirrors the axum server's `ws.rs` + `room.rs` semantics frame-for-frame
//! (`Subscribe`/`Unsubscribe`/`Relay`/`Ping`, the 8 KiB soft cap, the token
//! bucket, `not_subscribed`/`frame_too_large`/`rate_limited` errors) so the
//! existing TS and Rust clients work unchanged against either backend.

use cognia_signaling_core::limits::TokenBucket;
use cognia_signaling_core::proto::{ClientFrame, PeerRole, PeerSnapshot, ServerFrame};
use serde::{Deserialize, Serialize};
use worker::*;

/// Per-connection rate limit — matches the axum server (`ws.rs`).
const RATE_CAPACITY: u32 = 20;
const RATE_REFILL_PER_SEC: u32 = 10;
/// Soft per-frame cap; oversized frames get a graceful error and the socket
/// stays open. SDP/ICE envelopes sit well under this.
const MAX_FRAME_BYTES: usize = 8 * 1024;

/// State attached to each hibernatable WebSocket. Restored on every message
/// via `deserialize_attachment`, so it must round-trip through `serde`.
#[derive(Serialize, Deserialize)]
struct Attachment {
    /// Set once a `Subscribe` frame arrives; until then `Relay` is rejected
    /// with `not_subscribed`.
    rendezvous_id: Option<String>,
    role: Option<PeerRole>,
    joined_at_ms: i64,
    bucket: TokenBucket,
}

impl Attachment {
    fn fresh(now_ms: f64) -> Self {
        Self {
            rendezvous_id: None,
            role: None,
            joined_at_ms: now_ms as i64,
            bucket: TokenBucket::new(RATE_CAPACITY, RATE_REFILL_PER_SEC),
        }
    }
}

#[durable_object]
pub struct RoomDurableObject {
    state: State,
    env: Env,
}

impl DurableObject for RoomDurableObject {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, _req: Request) -> Result<Response> {
        // App-level Ping/Pong is answered by the runtime without waking the DO.
        // Re-setting on each accept is idempotent and survives reconstruction.
        if let Ok(pair) =
            WebSocketRequestResponsePair::new(r#"{"kind":"ping"}"#, r#"{"kind":"pong"}"#)
        {
            self.state.set_websocket_auto_response(&pair);
        }

        let pair = WebSocketPair::new()?;
        let server = pair.server;
        self.state.accept_web_socket(&server);
        let now = Date::now().as_millis() as f64;
        server.serialize_attachment(Attachment::fresh(now))?;
        Response::from_websocket(pair.client)
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let text = match message {
            WebSocketIncomingMessage::String(s) => s,
            // Protocol is text/JSON only; ignore binary frames.
            WebSocketIncomingMessage::Binary(_) => return Ok(()),
        };

        if text.len() > MAX_FRAME_BYTES {
            console_log!("signaling: frame_too_large len={}", text.len());
            self.record("frame_too_large", None, 0.0);
            send_error(&ws, "frame_too_large", "frame exceeds 8 KiB");
            return Ok(());
        }

        let now = Date::now().as_millis() as f64;
        let mut attach = ws
            .deserialize_attachment::<Attachment>()?
            .unwrap_or_else(|| Attachment::fresh(now));

        if !attach.bucket.try_take(now) {
            console_log!("signaling: rate_limited");
            self.record("rate_limited", None, 0.0);
            let _ = ws.serialize_attachment(&attach);
            send_error(&ws, "rate_limited", "too many frames");
            let _ = ws.close(Some(1008), Some("rate_limited"));
            return Ok(());
        }

        let frame: ClientFrame = match serde_json::from_str(&text) {
            Ok(frame) => frame,
            Err(_) => {
                ws.serialize_attachment(&attach)?;
                self.record("bad_frame", None, 0.0);
                send_error(&ws, "bad_frame", "malformed client frame");
                return Ok(());
            }
        };

        match frame {
            ClientFrame::Subscribe {
                rendezvous_id, role, ..
            } => {
                attach.rendezvous_id = Some(rendezvous_id.clone());
                attach.role = Some(role);
                ws.serialize_attachment(&attach)?;

                let peers = self.peer_snapshots(&ws)?;
                send_frame(
                    &ws,
                    &ServerFrame::Subscribed {
                        rendezvous_id: rendezvous_id.clone(),
                        peers,
                    },
                );
                for other in self.others(&ws) {
                    send_frame(
                        &other,
                        &ServerFrame::PeerJoined {
                            rendezvous_id: rendezvous_id.clone(),
                            role,
                        },
                    );
                }
                console_log!("signaling: subscribe role={}", role.as_str());
                self.record("subscribe", Some(role.as_str()), 0.0);
            }

            ClientFrame::Unsubscribe { rendezvous_id } => {
                let was_role = attach.role.take();
                attach.rendezvous_id = None;
                ws.serialize_attachment(&attach)?;
                if let Some(role) = was_role {
                    self.record("peer_left", Some(role.as_str()), 0.0);
                    for other in self.others(&ws) {
                        send_frame(
                            &other,
                            &ServerFrame::PeerLeft {
                                rendezvous_id: rendezvous_id.clone(),
                                role,
                            },
                        );
                    }
                }
            }

            ClientFrame::Relay {
                rendezvous_id,
                payload,
            } => {
                let Some(from_role) = attach.role else {
                    ws.serialize_attachment(&attach)?;
                    self.record("not_subscribed", None, 0.0);
                    send_error(&ws, "not_subscribed", "subscribe to the room before relaying");
                    return Ok(());
                };
                ws.serialize_attachment(&attach)?;
                let others = self.others(&ws);
                self.record("relay", Some(from_role.as_str()), others.len() as f64);
                for other in others {
                    send_frame(
                        &other,
                        &ServerFrame::Relay {
                            rendezvous_id: rendezvous_id.clone(),
                            from_role,
                            payload: payload.clone(),
                        },
                    );
                }
            }

            ClientFrame::Ping => {
                // Normally answered by auto-response without waking the DO;
                // this is the fallback when the frame reaches a handler.
                ws.serialize_attachment(&attach)?;
                send_frame(&ws, &ServerFrame::Pong);
            }
        }

        Ok(())
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        self.announce_left(&ws);
        Ok(())
    }

    async fn websocket_error(&self, ws: WebSocket, _error: Error) -> Result<()> {
        self.announce_left(&ws);
        Ok(())
    }
}

impl RoomDurableObject {
    /// Best-effort metric: one Analytics Engine data point per event
    /// (blob1 = event, blob2 = role, double1 = count, double2 = fanout). This
    /// is the Cloudflare-native replacement for the axum server's Prometheus
    /// `/metrics`. No-ops when the `METRICS` binding isn't configured, so the
    /// relay never depends on it. Query via the AE SQL API, e.g.
    /// `SELECT blob1, SUM(_sample_interval) FROM METRICS GROUP BY blob1`.
    fn record(&self, event: &str, role: Option<&str>, fanout: f64) {
        let Ok(dataset) = self.env.analytics_engine("METRICS") else {
            return;
        };
        let _ = AnalyticsEngineDataPointBuilder::new()
            .add_blob(event)
            .add_blob(role.unwrap_or(""))
            .add_double(1.0)
            .add_double(fanout)
            .write_to(&dataset);
    }

    /// Every connected socket except `current` (`WebSocket` compares by JS
    /// reference identity).
    fn others(&self, current: &WebSocket) -> Vec<WebSocket> {
        self.state
            .get_websockets()
            .into_iter()
            .filter(|w| w != current)
            .collect()
    }

    /// Build the `Subscribed.peers` list from the other sockets' attachments,
    /// skipping any that haven't subscribed (no role) yet.
    fn peer_snapshots(&self, current: &WebSocket) -> Result<Vec<PeerSnapshot>> {
        let mut peers = Vec::new();
        for other in self.others(current) {
            if let Some(attach) = other.deserialize_attachment::<Attachment>()? {
                if let Some(role) = attach.role {
                    peers.push(PeerSnapshot {
                        role,
                        joined_at_ms: attach.joined_at_ms,
                    });
                }
            }
        }
        Ok(peers)
    }

    /// Announce a departing peer to the rest of the room (close/error paths).
    fn announce_left(&self, ws: &WebSocket) {
        let attach = ws.deserialize_attachment::<Attachment>().ok().flatten();
        let Some(attach) = attach else { return };
        let Some(role) = attach.role else { return };
        let rendezvous_id = attach.rendezvous_id.unwrap_or_default();
        self.record("peer_left", Some(role.as_str()), 0.0);
        for other in self.others(ws) {
            send_frame(
                &other,
                &ServerFrame::PeerLeft {
                    rendezvous_id: rendezvous_id.clone(),
                    role,
                },
            );
        }
    }
}

fn send_frame(ws: &WebSocket, frame: &ServerFrame) {
    if let Ok(text) = serde_json::to_string(frame) {
        let _ = ws.send_with_str(text);
    }
}

fn send_error(ws: &WebSocket, code: &str, message: &str) {
    send_frame(
        ws,
        &ServerFrame::Error {
            code: code.to_string(),
            message: message.to_string(),
        },
    );
}
