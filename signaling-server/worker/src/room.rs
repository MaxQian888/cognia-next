//! Per-room Durable Object — the stateful half of the signaling rendezvous.
//!
//! One instance per `rendezvous_id` (`env.ROOM.idFromName(rid)`). It holds the
//! room's peers as hibernatable WebSockets accepted via the Durable Objects
//! WebSocket Hibernation API, so the instance can be evicted from memory
//! between messages while connections stay open. Per-connection state (role,
//! join time, rate-limit bucket, source IP, AE sample counter) rides on each
//! socket's serialized attachment, which survives hibernation.
//!
//! This mirrors the axum server's `ws.rs` + `room.rs` semantics frame-for-frame
//! (`Subscribe`/`Unsubscribe`/`Relay`/`Ping`, the 8 KiB soft cap, the token
//! bucket, `not_subscribed`/`frame_too_large`/`rate_limited` errors) so the
//! existing TS and Rust clients work unchanged against either backend. Room
//! admission (peer cap, one-desktop-per-room) and the origin allowlist are
//! evaluated by the SAME `cognia-signaling-core::policy` functions the axum
//! server uses, so the two deployments cannot diverge.

use cognia_signaling_core::limits::TokenBucket;
use cognia_signaling_core::policy::{evaluate_subscribe, RoomLimits, SubscribeDecision};
use cognia_signaling_core::proto::{ClientFrame, PeerRole, PeerSnapshot, ServerFrame};
use serde::{Deserialize, Serialize};
use worker::*;

/// Per-connection rate limit — matches the axum server (`ws.rs`).
const RATE_CAPACITY: u32 = 20;
const RATE_REFILL_PER_SEC: u32 = 10;
/// Soft per-frame cap; oversized frames get a graceful error and the socket
/// stays open. SDP/ICE envelopes sit well under this.
const MAX_FRAME_BYTES: usize = 8 * 1024;
/// Fallback caps when the corresponding `wrangler.toml` `[vars]` are unset.
const DEFAULT_MAX_CONN_PER_IP: usize = 4;
const DEFAULT_AE_SAMPLE_N: u32 = 10;

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
    /// Source IP (`cf-connecting-ip`) captured at accept time, used for the
    /// per-room per-IP connection cap. `None` when the header was absent.
    #[serde(default)]
    ip: Option<String>,
    /// Monotonic per-connection counter driving 1-in-N Analytics Engine
    /// sampling of the hot-path events (relay + per-frame rejections), so a
    /// flood can't amplify AE writes into a cost-DoS.
    #[serde(default)]
    sample_n: u32,
}

impl Attachment {
    fn fresh(now_ms: f64, ip: Option<String>) -> Self {
        Self {
            rendezvous_id: None,
            role: None,
            joined_at_ms: now_ms as i64,
            bucket: TokenBucket::new(RATE_CAPACITY, RATE_REFILL_PER_SEC),
            ip,
            sample_n: 0,
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

    async fn fetch(&self, req: Request) -> Result<Response> {
        // App-level Ping/Pong is answered by the runtime without waking the DO.
        // Re-setting on each accept is idempotent and survives reconstruction.
        if let Ok(pair) =
            WebSocketRequestResponsePair::new(r#"{"kind":"ping"}"#, r#"{"kind":"pong"}"#)
        {
            self.state.set_websocket_auto_response(&pair);
        }

        // Per-room per-IP connection cap. The axum server caps 50/IP process-
        // wide; a DO only sees its own room, so this bounds how many sockets
        // one IP can hold in THIS room (a backstop against flooding a known
        // rid). Cross-room per-IP flooding is the edge's job — see the
        // Cloudflare Rate Limiting rule documented in wrangler.toml.
        let ip = req.headers().get("cf-connecting-ip").ok().flatten();
        if let Some(ip_str) = ip.as_deref() {
            let cap = self.max_conn_per_ip();
            let same_ip = self
                .state
                .get_websockets()
                .into_iter()
                .filter(|w| {
                    w.deserialize_attachment::<Attachment>()
                        .ok()
                        .flatten()
                        .and_then(|a| a.ip)
                        .as_deref()
                        == Some(ip_str)
                })
                .count();
            if same_ip >= cap {
                self.record("conn_capped", None, 1.0, 0.0);
                return Response::error("too many connections", 429);
            }
        }

        let pair = WebSocketPair::new()?;
        let server = pair.server;
        self.state.accept_web_socket(&server);
        let now = Date::now().as_millis() as f64;
        server.serialize_attachment(Attachment::fresh(now, ip))?;
        Response::from_websocket(pair.client)
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let text = match message {
            WebSocketIncomingMessage::String(s) => s,
            // Protocol is text/JSON only. Match the axum server's explicit
            // rejection rather than silently dropping the frame.
            WebSocketIncomingMessage::Binary(_) => {
                send_error(&ws, "binary_not_supported", "binary frames are not supported");
                return Ok(());
            }
        };

        let now = Date::now().as_millis() as f64;
        let mut attach = ws
            .deserialize_attachment::<Attachment>()?
            .unwrap_or_else(|| Attachment::fresh(now, None));

        if text.len() > MAX_FRAME_BYTES {
            console_log!("signaling: frame_too_large len={}", text.len());
            self.record_hot(&mut attach, "frame_too_large", None, 0.0);
            ws.serialize_attachment(&attach)?;
            send_error(&ws, "frame_too_large", "frame exceeds 8 KiB");
            return Ok(());
        }

        if !attach.bucket.try_take(now) {
            console_log!("signaling: rate_limited");
            self.record_hot(&mut attach, "rate_limited", None, 0.0);
            let _ = ws.serialize_attachment(&attach);
            send_error(&ws, "rate_limited", "too many frames");
            let _ = ws.close(Some(1008), Some("rate_limited"));
            return Ok(());
        }

        let frame: ClientFrame = match serde_json::from_str(&text) {
            Ok(frame) => frame,
            Err(_) => {
                self.record_hot(&mut attach, "bad_frame", None, 0.0);
                ws.serialize_attachment(&attach)?;
                send_error(&ws, "bad_frame", "malformed client frame");
                return Ok(());
            }
        };

        match frame {
            ClientFrame::Subscribe {
                rendezvous_id, role, ..
            } => {
                // Existing *subscribed* peers — both for the policy check and
                // the `Subscribed.peers` reply (peer_snapshots already filters
                // to peers that carry a role).
                let peers = self.peer_snapshots(&ws)?;
                let existing_roles: Vec<PeerRole> = peers.iter().map(|p| p.role).collect();
                if let SubscribeDecision::Reject { code, message } =
                    evaluate_subscribe(&existing_roles, role, &self.room_limits())
                {
                    console_log!("signaling: subscribe rejected code={}", code);
                    self.record(code, Some(role.as_str()), 1.0, 0.0);
                    // Persist the consumed token; keep the socket open so the
                    // client can surface the reason and stop retrying.
                    ws.serialize_attachment(&attach)?;
                    send_error(&ws, code, message);
                    return Ok(());
                }

                attach.rendezvous_id = Some(rendezvous_id.clone());
                attach.role = Some(role);
                ws.serialize_attachment(&attach)?;

                send_frame(
                    &ws,
                    &ServerFrame::Subscribed {
                        rendezvous_id: rendezvous_id.clone(),
                        peers,
                    },
                );
                for other in self.subscribed_others(&ws)? {
                    send_frame(
                        &other,
                        &ServerFrame::PeerJoined {
                            rendezvous_id: rendezvous_id.clone(),
                            role,
                        },
                    );
                }
                console_log!("signaling: subscribe role={}", role.as_str());
                self.record("subscribe", Some(role.as_str()), 1.0, 0.0);
            }

            ClientFrame::Unsubscribe { rendezvous_id } => {
                let was_role = attach.role.take();
                attach.rendezvous_id = None;
                ws.serialize_attachment(&attach)?;
                if let Some(role) = was_role {
                    self.record("peer_left", Some(role.as_str()), 1.0, 0.0);
                    for other in self.subscribed_others(&ws)? {
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
                    self.record_hot(&mut attach, "not_subscribed", None, 0.0);
                    ws.serialize_attachment(&attach)?;
                    send_error(&ws, "not_subscribed", "subscribe to the room before relaying");
                    return Ok(());
                };
                // Fan out ONLY to subscribed peers. A socket that connected but
                // never subscribed must not receive relayed envelopes — this is
                // what keeps the Worker from silently leaking SDP/ICE to a
                // passive observer who knows the rid (matches axum, where
                // unsubscribed sockets are simply not in the room registry).
                let others = self.subscribed_others(&ws)?;
                self.record_hot(&mut attach, "relay", Some(from_role.as_str()), others.len() as f64);
                ws.serialize_attachment(&attach)?;
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
    /// Room admission caps, read from `wrangler.toml` `[vars]` (falling back to
    /// `RoomLimits::default()` — `max_peers = 4`, `max_desktops = 1`).
    fn room_limits(&self) -> RoomLimits {
        let d = RoomLimits::default();
        RoomLimits {
            max_peers: self.env_usize("SIGNALING_MAX_PEERS_PER_ROOM", d.max_peers),
            max_desktops: self.env_usize("SIGNALING_MAX_DESKTOPS", d.max_desktops),
        }
    }

    fn max_conn_per_ip(&self) -> usize {
        self.env_usize("SIGNALING_MAX_CONN_PER_IP_PER_ROOM", DEFAULT_MAX_CONN_PER_IP)
    }

    fn ae_sample_n(&self) -> u32 {
        self.env_usize("AE_SAMPLE_N", DEFAULT_AE_SAMPLE_N as usize) as u32
    }

    fn env_usize(&self, name: &str, default: usize) -> usize {
        self.env
            .var(name)
            .ok()
            .and_then(|v| v.to_string().parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(default)
    }

    /// Best-effort metric: one Analytics Engine data point per recorded event
    /// (blob1 = event, blob2 = role, double1 = sample weight, double2 =
    /// fanout). `weight` is the 1-in-N sampling factor for hot events so
    /// `SUM(double1)` extrapolates the true count; state-change events pass
    /// `1.0`. No-ops when the `METRICS` binding isn't configured, so the relay
    /// never depends on it. Query via the AE SQL API, e.g.
    /// `SELECT blob1, SUM(double1) FROM METRICS GROUP BY blob1`.
    fn record(&self, event: &str, role: Option<&str>, weight: f64, fanout: f64) {
        let Ok(dataset) = self.env.analytics_engine("METRICS") else {
            return;
        };
        let _ = AnalyticsEngineDataPointBuilder::new()
            .add_blob(event)
            .add_blob(role.unwrap_or(""))
            .add_double(weight)
            .add_double(fanout)
            .write_to(&dataset);
    }

    /// Record a high-frequency event with 1-in-N sampling. Advances the
    /// per-connection counter (caller must serialize the attachment afterward
    /// so the counter survives hibernation).
    fn record_hot(&self, attach: &mut Attachment, event: &str, role: Option<&str>, fanout: f64) {
        let n = self.ae_sample_n().max(1);
        attach.sample_n = attach.sample_n.wrapping_add(1);
        if attach.sample_n % n == 0 {
            self.record(event, role, n as f64, fanout);
        }
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

    /// `others`, restricted to sockets that have actually subscribed (carry a
    /// role). Used for every fan-out (relay, PeerJoined, PeerLeft) so an
    /// unsubscribed observer receives nothing.
    fn subscribed_others(&self, current: &WebSocket) -> Result<Vec<WebSocket>> {
        let mut out = Vec::new();
        for other in self.others(current) {
            if let Some(attach) = other.deserialize_attachment::<Attachment>()? {
                if attach.role.is_some() {
                    out.push(other);
                }
            }
        }
        Ok(out)
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
        self.record("peer_left", Some(role.as_str()), 1.0, 0.0);
        if let Ok(others) = self.subscribed_others(ws) {
            for other in others {
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
