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

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cognia_signaling_core::limits::{max_frame_bytes, LaneBuckets, TokenBucket};
use cognia_signaling_core::policy::{
    rendezvous_id_matches_upgrade_room, ROOM_MISMATCH_CODE, ROOM_MISMATCH_MESSAGE,
};
use cognia_signaling_core::proto::{ClientFrame, PeerRole, PeerSnapshot, RelayLane, ServerFrame};
use cognia_signaling_core::protocol::verify_subscribe_proof;
use serde::{Deserialize, Serialize};
use worker::*;

/// Legacy single-bucket limit, kept only so an attachment serialized before
/// the per-lane buckets existed still deserializes across hibernation.
const RATE_CAPACITY: u32 = 20;
const RATE_REFILL_PER_SEC: u32 = 10;
/// Fallback caps when the corresponding `wrangler.toml` `[vars]` are unset.
const DEFAULT_MAX_CONN_PER_IP: usize = 4;
const DEFAULT_AE_SAMPLE_N: u32 = 10;
const SOCKET_LEASE_MS: i64 = 45_000;
const LEASE_SCAN_MS: i64 = 10_000;

/// State attached to each hibernatable WebSocket. Restored on every message
/// via `deserialize_attachment`, so it must round-trip through `serde`.
#[derive(Serialize, Deserialize)]
struct Attachment {
    /// Room selected by the upgrade URL (`?rid=`). Every later frame must carry
    /// the same `rendezvousId`; otherwise the DO actor could fan out frames
    /// whose visible room id does not match the actor that accepted the socket.
    #[serde(default)]
    upgrade_rendezvous_id: String,
    /// Set once a `Subscribe` frame arrives; until then `Relay` is rejected
    /// with `not_subscribed`.
    rendezvous_id: Option<String>,
    role: Option<PeerRole>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    proof: Option<cognia_signaling_core::proto::SubscribeProof>,
    challenge: String,
    challenge_expires_at: i64,
    joined_at_ms: i64,
    #[serde(default)]
    last_activity_ms: i64,
    /// Pre-lane bucket. Unused once `lanes` exists; retained for attachment
    /// compatibility (a DO can hibernate across a deploy).
    bucket: TokenBucket,
    /// Per-lane budgets (signal vs data) — see `cognia_signaling_core::limits`.
    #[serde(default)]
    lanes: LaneBuckets,
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
    fn fresh(
        now_ms: f64,
        ip: Option<String>,
        upgrade_rendezvous_id: String,
        challenge: String,
    ) -> Self {
        Self {
            upgrade_rendezvous_id,
            rendezvous_id: None,
            role: None,
            session_id: None,
            proof: None,
            challenge,
            challenge_expires_at: now_ms as i64 + 5_000,
            joined_at_ms: now_ms as i64,
            last_activity_ms: now_ms as i64,
            bucket: TokenBucket::new(RATE_CAPACITY, RATE_REFILL_PER_SEC),
            lanes: LaneBuckets::new(),
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
        let upgrade_rendezvous_id = req
            .url()?
            .query_pairs()
            .find(|(k, _)| k == "rid")
            .map(|(_, v)| v.into_owned())
            .filter(|s| !s.is_empty());
        let Some(upgrade_rendezvous_id) = upgrade_rendezvous_id else {
            return Response::error("missing rid query parameter", 400);
        };

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
        let mut challenge_bytes = [0u8; 32];
        getrandom::getrandom(&mut challenge_bytes)
            .map_err(|_| Error::RustError("secure random challenge failed".into()))?;
        let challenge = URL_SAFE_NO_PAD.encode(challenge_bytes);
        let attachment = Attachment::fresh(now, ip, upgrade_rendezvous_id, challenge.clone());
        server.serialize_attachment(&attachment)?;
        self.state.storage().set_alarm(LEASE_SCAN_MS).await?;
        send_frame(
            &server,
            &ServerFrame::Challenge {
                challenge,
                issued_at: now as i64,
                expires_at: attachment.challenge_expires_at,
            },
        );
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
                send_error(
                    &ws,
                    "binary_not_supported",
                    "binary frames are not supported",
                );
                return Ok(());
            }
        };

        let now = Date::now().as_millis() as f64;
        let mut attach = ws
            .deserialize_attachment::<Attachment>()?
            .unwrap_or_else(|| Attachment::fresh(now, None, String::new(), String::new()));
        attach.last_activity_ms = now as i64;
        self.state.storage().set_alarm(LEASE_SCAN_MS).await?;

        // Parse first: the lane is a clear-text field and decides both the
        // frame cap and the bucket (mirrors the axum server's `ws.rs`). A
        // frame that fails to parse is charged to the signal lane.
        let parsed: std::result::Result<ClientFrame, _> = serde_json::from_str(&text);
        let lane = match &parsed {
            Ok(ClientFrame::Relay { lane, .. }) => *lane,
            _ => RelayLane::Signal,
        };
        if text.len() > max_frame_bytes(lane) {
            console_log!(
                "signaling: frame_too_large len={} lane={}",
                text.len(),
                lane.as_str()
            );
            self.record_hot(&mut attach, "frame_too_large", None, 0.0);
            ws.serialize_attachment(&attach)?;
            send_error(
                &ws,
                "frame_too_large",
                &format!(
                    "frame exceeds {} KiB on the {} lane",
                    max_frame_bytes(lane) / 1024,
                    lane.as_str()
                ),
            );
            return Ok(());
        }

        if !attach.lanes.try_take(lane, now) {
            console_log!("signaling: rate_limited lane={}", lane.as_str());
            self.record_hot(&mut attach, "rate_limited", None, 0.0);
            let _ = ws.serialize_attachment(&attach);
            send_error(&ws, "rate_limited", "too many frames");
            let _ = ws.close(Some(1008), Some("rate_limited"));
            return Ok(());
        }

        let frame: ClientFrame = match parsed {
            Ok(frame) => frame,
            Err(_) => {
                self.record_hot(&mut attach, "malformed_frame", None, 0.0);
                ws.serialize_attachment(&attach)?;
                send_error(
                    &ws,
                    "malformed_frame",
                    "frame did not match expected schema",
                );
                return Ok(());
            }
        };

        match frame {
            ClientFrame::Subscribe { descriptor, proof } => {
                let rendezvous_id = descriptor.room_id.clone();
                let role = proof.role;
                if !rendezvous_id_matches_upgrade_room(
                    &attach.upgrade_rendezvous_id,
                    &rendezvous_id,
                ) {
                    console_log!(
                        "signaling: room mismatch upgrade={} frame={}",
                        attach.upgrade_rendezvous_id,
                        rendezvous_id
                    );
                    self.record(ROOM_MISMATCH_CODE, Some(role.as_str()), 1.0, 0.0);
                    ws.serialize_attachment(&attach)?;
                    send_error(&ws, ROOM_MISMATCH_CODE, ROOM_MISMATCH_MESSAGE);
                    return Ok(());
                }
                if attach.rendezvous_id.as_deref() == Some(rendezvous_id.as_str()) {
                    // Match the axum server: duplicate Subscribe for an
                    // already-tracked `(socket, rendezvousId)` is a no-op.
                    ws.serialize_attachment(&attach)?;
                    return Ok(());
                }
                if now as i64 > attach.challenge_expires_at
                    || verify_subscribe_proof(&descriptor, &proof, &attach.challenge, now as i64)
                        .is_err()
                {
                    self.record("auth_failed", Some(role.as_str()), 1.0, 0.0);
                    ws.serialize_attachment(&attach)?;
                    send_error(
                        &ws,
                        "auth_failed",
                        "signaling subscription authentication failed",
                    );
                    return Ok(());
                }
                // Existing *subscribed* peers — both for the policy check and
                // the `Subscribed.peers` reply (peer_snapshots already filters
                // to peers that carry a role).
                for old in self.subscribed_others(&ws, &rendezvous_id)? {
                    if old
                        .deserialize_attachment::<Attachment>()?
                        .and_then(|old_attach| old_attach.role)
                        == Some(role)
                    {
                        send_error(
                            &old,
                            "session_replaced",
                            "a newer authenticated session took over this role",
                        );
                        let _ = old.close(Some(4001), Some("session_replaced"));
                    }
                }
                let peers = self.peer_snapshots(&ws, &rendezvous_id)?;

                attach.rendezvous_id = Some(rendezvous_id.clone());
                attach.role = Some(role);
                attach.session_id = Some(proof.session_id.clone());
                attach.proof = Some(proof.as_ref().clone());
                ws.serialize_attachment(&attach)?;

                send_frame(
                    &ws,
                    &ServerFrame::Subscribed {
                        rendezvous_id: rendezvous_id.clone(),
                        peers,
                    },
                );
                for other in self.subscribed_others(&ws, &rendezvous_id)? {
                    send_frame(
                        &other,
                        &ServerFrame::PeerJoined {
                            rendezvous_id: rendezvous_id.clone(),
                            peer: PeerSnapshot {
                                proof: proof.as_ref().clone(),
                                joined_at_ms: now as i64,
                            },
                        },
                    );
                }
                console_log!("signaling: subscribe role={}", role.as_str());
                self.record("subscribe", Some(role.as_str()), 1.0, 0.0);
            }

            ClientFrame::Unsubscribe { rendezvous_id } => {
                if !rendezvous_id_matches_upgrade_room(
                    &attach.upgrade_rendezvous_id,
                    &rendezvous_id,
                ) {
                    self.record(
                        ROOM_MISMATCH_CODE,
                        attach.role.map(|r| r.as_str()),
                        1.0,
                        0.0,
                    );
                    ws.serialize_attachment(&attach)?;
                    send_error(&ws, ROOM_MISMATCH_CODE, ROOM_MISMATCH_MESSAGE);
                    return Ok(());
                }
                if attach.rendezvous_id.as_deref() != Some(rendezvous_id.as_str()) {
                    ws.serialize_attachment(&attach)?;
                    return Ok(());
                }
                let was_role = attach.role.take();
                let was_session_id = attach.session_id.take();
                attach.proof = None;
                attach.rendezvous_id = None;
                ws.serialize_attachment(&attach)?;
                if let (Some(role), Some(session_id)) = (was_role, was_session_id) {
                    self.record("peer_left", Some(role.as_str()), 1.0, 0.0);
                    for other in self.subscribed_others(&ws, &rendezvous_id)? {
                        send_frame(
                            &other,
                            &ServerFrame::PeerLeft {
                                rendezvous_id: rendezvous_id.clone(),
                                role,
                                session_id: session_id.clone(),
                            },
                        );
                    }
                }
            }

            ClientFrame::Relay {
                rendezvous_id,
                payload,
                lane,
            } => {
                if !rendezvous_id_matches_upgrade_room(
                    &attach.upgrade_rendezvous_id,
                    &rendezvous_id,
                ) {
                    let role = attach.role.map(|r| r.as_str());
                    self.record_hot(&mut attach, ROOM_MISMATCH_CODE, role, 0.0);
                    ws.serialize_attachment(&attach)?;
                    send_error(&ws, ROOM_MISMATCH_CODE, ROOM_MISMATCH_MESSAGE);
                    return Ok(());
                }
                let Some(from_role) = attach.role else {
                    self.record_hot(&mut attach, "not_subscribed", None, 0.0);
                    ws.serialize_attachment(&attach)?;
                    send_error(
                        &ws,
                        "not_subscribed",
                        "subscribe to the room before relaying",
                    );
                    return Ok(());
                };
                let Some(from_session_id) = attach.session_id.clone() else {
                    send_error(&ws, "not_subscribed", "missing authenticated session");
                    return Ok(());
                };
                if attach.rendezvous_id.as_deref() != Some(rendezvous_id.as_str()) {
                    self.record_hot(&mut attach, "not_subscribed", None, 0.0);
                    ws.serialize_attachment(&attach)?;
                    send_error(
                        &ws,
                        "not_subscribed",
                        "subscribe to the room before relaying",
                    );
                    return Ok(());
                }
                // Fan out ONLY to subscribed peers. A socket that connected but
                // never subscribed must not receive relayed envelopes — this is
                // what keeps the Worker from silently leaking SDP/ICE to a
                // passive observer who knows the rid (matches axum, where
                // unsubscribed sockets are simply not in the room registry).
                let others = self.subscribed_others(&ws, &rendezvous_id)?;
                // `relay` keeps its historical meaning (every lane); the data
                // lane also lands in `relay_data` with the egress byte count in
                // `double2`, so `SUM(double1 * double2)` over that event is the
                // relayed-bytes figure the cost dashboard wants.
                self.record_hot(
                    &mut attach,
                    "relay",
                    Some(from_role.as_str()),
                    others.len() as f64,
                );
                if lane == RelayLane::Data {
                    self.record_hot(
                        &mut attach,
                        "relay_data",
                        Some(from_role.as_str()),
                        (payload.len() * others.len()) as f64,
                    );
                }
                ws.serialize_attachment(&attach)?;
                for other in others {
                    send_frame(
                        &other,
                        &ServerFrame::Relay {
                            rendezvous_id: rendezvous_id.clone(),
                            from_role,
                            from_session_id: from_session_id.clone(),
                            payload: payload.clone(),
                            lane,
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

    async fn alarm(&self) -> Result<Response> {
        let now = Date::now().as_millis() as i64;
        let mut remaining = 0usize;
        for ws in self.state.get_websockets() {
            let stale = ws
                .deserialize_attachment::<Attachment>()?
                .map(|attachment| {
                    now.saturating_sub(attachment.last_activity_ms) >= SOCKET_LEASE_MS
                })
                .unwrap_or(true);
            if stale {
                self.announce_left(&ws);
                let _ = ws.close(Some(4000), Some("lease_expired"));
                self.record("lease_expired", None, 1.0, 0.0);
            } else {
                remaining += 1;
            }
        }
        if remaining > 0 {
            self.state.storage().set_alarm(LEASE_SCAN_MS).await?;
        }
        Response::ok("ok")
    }
}

impl RoomDurableObject {
    fn max_conn_per_ip(&self) -> usize {
        self.env_usize(
            "SIGNALING_MAX_CONN_PER_IP_PER_ROOM",
            DEFAULT_MAX_CONN_PER_IP,
        )
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
    fn subscribed_others(
        &self,
        current: &WebSocket,
        rendezvous_id: &str,
    ) -> Result<Vec<WebSocket>> {
        let mut out = Vec::new();
        for other in self.others(current) {
            if let Some(attach) = other.deserialize_attachment::<Attachment>()? {
                if attach.role.is_some() && attach.rendezvous_id.as_deref() == Some(rendezvous_id) {
                    out.push(other);
                }
            }
        }
        Ok(out)
    }

    /// Build the `Subscribed.peers` list from the other sockets' attachments,
    /// skipping any that haven't subscribed (no role) yet.
    fn peer_snapshots(
        &self,
        current: &WebSocket,
        rendezvous_id: &str,
    ) -> Result<Vec<PeerSnapshot>> {
        let mut peers = Vec::new();
        for other in self.others(current) {
            if let Some(attach) = other.deserialize_attachment::<Attachment>()? {
                if attach.rendezvous_id.as_deref() != Some(rendezvous_id) {
                    continue;
                }
                if let Some(proof) = attach.proof {
                    peers.push(PeerSnapshot {
                        proof,
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
        let Some(session_id) = attach.session_id else {
            return;
        };
        let Some(rendezvous_id) = attach.rendezvous_id else {
            return;
        };
        self.record("peer_left", Some(role.as_str()), 1.0, 0.0);
        if let Ok(others) = self.subscribed_others(ws, &rendezvous_id) {
            for other in others {
                send_frame(
                    &other,
                    &ServerFrame::PeerLeft {
                        rendezvous_id: rendezvous_id.clone(),
                        role,
                        session_id: session_id.clone(),
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
