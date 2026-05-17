//! Per-connection WebSocket loop.
//!
//! The state machine is dead simple:
//!
//! ```text
//!     ┌─────────┐  Subscribe   ┌──────────────┐  Relay   ┌──────────────┐
//!     │  open   │ ───────────► │  in-room(s)  │ ───────► │   fan-out    │
//!     └─────────┘              └──────────────┘          └──────────────┘
//!          │                          │                          │
//!          └────────────── socket close / unsubscribe ────────────┘
//! ```
//!
//! The signaling service is intentionally stateless beyond per-connection
//! tracking: no auth, no quota DB, no observability beyond `tracing` logs.

use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::StatusCode,
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::{
    limits::TokenBucket,
    metrics::RejectReason,
    proto::{ClientFrame, PeerRole, PeerSnapshot, ServerFrame},
    room::{PeerHandle, PEER_OUTBOUND_BUFFER},
    AppState,
};

/// Frames per second a single peer may send before getting rate-limited.
const RATE_REFILL_PER_SEC: u32 = 10;
const RATE_CAPACITY: u32 = 20;

/// How long the server waits between idle keepalive pings sent down the WS
/// frame layer. WebSocket pings are separate from `ClientFrame::Ping` —
/// these are what `axum::extract::ws` calls "control frame" pings.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(25);

pub async fn ws_upgrade(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, &'static str)> {
    Ok(ws.on_upgrade(move |socket| handle_socket(state, socket)))
}

async fn handle_socket(state: AppState, socket: WebSocket) {
    let peer_id = state.registry.next_peer_id();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<ServerFrame>(PEER_OUTBOUND_BUFFER);
    let mut bucket = TokenBucket::new(RATE_CAPACITY, RATE_REFILL_PER_SEC);
    let mut subscribed_rooms: Vec<(String, PeerRole)> = Vec::new();

    debug!(target: "signaling", peer_id, "connection opened");

    // Outbound pump: forward ServerFrames to the WS sink.
    let outbound = tokio::spawn(async move {
        let mut keepalive = tokio::time::interval(KEEPALIVE_INTERVAL);
        // Skip the first immediate tick.
        keepalive.tick().await;
        loop {
            tokio::select! {
                maybe_frame = rx.recv() => {
                    let Some(frame) = maybe_frame else { break };
                    let text = match serde_json::to_string(&frame) {
                        Ok(s) => s,
                        Err(e) => {
                            warn!(target: "signaling", error = %e, "serialize failed");
                            continue;
                        }
                    };
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                _ = keepalive.tick() => {
                    if sink.send(Message::Ping(Default::default())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Inbound loop: dispatch ClientFrames.
    while let Some(msg) = stream.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                debug!(target: "signaling", peer_id, error = %e, "ws stream error");
                break;
            }
        };
        match msg {
            Message::Text(text) => {
                if !bucket.try_take() {
                    warn!(target: "signaling", peer_id, "rate limited");
                    state.metrics.frame_rejected(RejectReason::Rate);
                    let _ = tx
                        .send(ServerFrame::Error {
                            code: "rate_limited".into(),
                            message: "too many frames".into(),
                        })
                        .await;
                    break;
                }
                let frame: ClientFrame = match serde_json::from_str(&text) {
                    Ok(f) => f,
                    Err(e) => {
                        state.metrics.frame_rejected(RejectReason::Malformed);
                        let _ = tx
                            .send(ServerFrame::Error {
                                code: "malformed_frame".into(),
                                message: e.to_string(),
                            })
                            .await;
                        continue;
                    }
                };
                state.metrics.frame_in();
                handle_frame(&state, peer_id, frame, &tx, &mut subscribed_rooms).await;
            }
            Message::Binary(_) => {
                state.metrics.frame_rejected(RejectReason::Malformed);
                let _ = tx
                    .send(ServerFrame::Error {
                        code: "binary_not_supported".into(),
                        message: "send frames as JSON text".into(),
                    })
                    .await;
            }
            Message::Ping(_) | Message::Pong(_) => {
                // axum handles WS control frames automatically.
            }
            Message::Close(_) => break,
        }
    }

    // Tear-down.
    for (rid, role) in &subscribed_rooms {
        let others = state.registry.leave(rid, peer_id);
        for sender in others {
            let _ = sender
                .send(ServerFrame::PeerLeft {
                    rendezvous_id: rid.clone(),
                    role: *role,
                })
                .await;
        }
    }
    // leave_all is a belt-and-braces sweep for rooms we forgot in
    // subscribed_rooms (shouldn't happen, but cheap to ensure).
    let extra = state.registry.leave_all(peer_id);
    for (rid, role, others) in extra {
        for sender in others {
            let _ = sender
                .send(ServerFrame::PeerLeft {
                    rendezvous_id: rid.clone(),
                    role,
                })
                .await;
        }
    }

    drop(tx);
    let _ = outbound.await;
    debug!(target: "signaling", peer_id, "connection closed");
}

async fn handle_frame(
    state: &AppState,
    peer_id: u64,
    frame: ClientFrame,
    tx: &mpsc::Sender<ServerFrame>,
    subscribed_rooms: &mut Vec<(String, PeerRole)>,
) {
    match frame {
        ClientFrame::Subscribe {
            rendezvous_id,
            role,
            client_nonce: _,
        } => {
            if subscribed_rooms
                .iter()
                .any(|(rid, _)| rid == &rendezvous_id)
            {
                // Idempotent: ignore duplicate subscribe.
                return;
            }
            let joined_at_ms = now_ms();
            let handle = PeerHandle {
                peer_id,
                role,
                joined_at_ms,
                tx: tx.clone(),
            };
            let (existing, others) = state.registry.join(&rendezvous_id, handle);
            subscribed_rooms.push((rendezvous_id.clone(), role));

            // Tell the joiner who is already in the room.
            let _ = tx
                .send(ServerFrame::Subscribed {
                    rendezvous_id: rendezvous_id.clone(),
                    peers: existing
                        .iter()
                        .map(|h| PeerSnapshot {
                            role: h.role,
                            joined_at_ms: h.joined_at_ms,
                        })
                        .collect(),
                })
                .await;

            // Announce the join to everyone else.
            for other in others {
                let _ = other
                    .send(ServerFrame::PeerJoined {
                        rendezvous_id: rendezvous_id.clone(),
                        role,
                    })
                    .await;
            }
            info!(
                target: "signaling",
                peer_id,
                rendezvous_id = %rendezvous_id,
                role = role.as_str(),
                "subscribed"
            );
        }
        ClientFrame::Unsubscribe { rendezvous_id } => {
            let pos = subscribed_rooms
                .iter()
                .position(|(rid, _)| rid == &rendezvous_id);
            let Some(idx) = pos else { return };
            let (_, role) = subscribed_rooms.remove(idx);
            let others = state.registry.leave(&rendezvous_id, peer_id);
            for sender in others {
                let _ = sender
                    .send(ServerFrame::PeerLeft {
                        rendezvous_id: rendezvous_id.clone(),
                        role,
                    })
                    .await;
            }
        }
        ClientFrame::Relay {
            rendezvous_id,
            payload,
        } => {
            let Some((sender_role, others)) =
                state.registry.others(&rendezvous_id, peer_id)
            else {
                state.metrics.frame_rejected(RejectReason::NotSubscribed);
                let _ = tx
                    .send(ServerFrame::Error {
                        code: "not_subscribed".into(),
                        message: "subscribe to the room before relaying".into(),
                    })
                    .await;
                return;
            };
            let fanout = others.len() as u64;
            for sender in others {
                let _ = sender
                    .send(ServerFrame::Relay {
                        rendezvous_id: rendezvous_id.clone(),
                        from_role: sender_role,
                        payload: payload.clone(),
                    })
                    .await;
            }
            state.metrics.frame_relayed(fanout);
        }
        ClientFrame::Ping => {
            let _ = tx.send(ServerFrame::Pong).await;
        }
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
