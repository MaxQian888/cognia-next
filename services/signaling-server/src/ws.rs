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

use std::net::SocketAddr;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    http::{HeaderMap, StatusCode, Uri},
    response::Response,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cognia_signaling_core::policy::{
    is_origin_allowed, rendezvous_id_matches_upgrade_room, ROOM_MISMATCH_CODE,
    ROOM_MISMATCH_MESSAGE,
};
use cognia_signaling_core::v2::verify_subscribe_proof;
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::{
    ip_limits::{extract_client_ip, AcquireOutcome, Acquired},
    limits::TokenBucket,
    metrics::RejectReason,
    proto::{ClientFrame, PeerRole, PeerSnapshot, ServerFrame},
    room::{PeerHandle, PEER_OUTBOUND_BUFFER},
    AppState,
};

/// Frames per second a single peer may send before getting rate-limited.
const RATE_REFILL_PER_SEC: u32 = 10;
const RATE_CAPACITY: u32 = 20;

/// Soft per-frame cap. Frames above this get a graceful `frame_too_large`
/// error and the connection stays open — SDP/ICE envelopes sit well under
/// this. `RequestBodyLimitLayer` only bounds the *pre-upgrade* HTTP body, so
/// this is where the documented 8 KiB cap is actually enforced on WS frames.
const MAX_FRAME_BYTES: usize = 8 * 1024;

/// Hard memory backstop handed to tungstenite via the WS upgrade. Sized 8×
/// above the soft cap so the graceful path above fires for ordinary overages
/// while still bounding a single message far below tungstenite's MiB default.
/// A frame above this is closed by the protocol layer (stream error → break).
const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024;

/// How long the server waits between idle keepalive pings sent down the WS
/// frame layer. WebSocket pings are separate from `ClientFrame::Ping` —
/// these are what `axum::extract::ws` calls "control frame" pings.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);
const SOCKET_LEASE: Duration = Duration::from_secs(45);
const SUBSCRIBE_DEADLINE: Duration = Duration::from_secs(5);

pub async fn ws_upgrade(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, &'static str)> {
    // Native clients omit Origin. Browser clients must be same-origin or match
    // the explicit HTTPS split-origin allowlist. Checked before the per-IP gate
    // so a cross-origin probe doesn't consume a connection slot.
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    let request_origin = request_origin(&headers);
    if !is_origin_allowed(origin, request_origin.as_deref(), &state.allowed_origins) {
        warn!(
            target: "signaling",
            origin = origin.unwrap_or("<none>"),
            "rejecting WS upgrade — origin not on allowlist"
        );
        state.metrics.frame_rejected(RejectReason::OriginRejected);
        return Err((StatusCode::FORBIDDEN, "origin not allowed"));
    }

    let client_ip = extract_client_ip(peer_addr, &headers, state.trust_proxy_headers);
    let acquired = match state.ip_limits.try_acquire(client_ip) {
        AcquireOutcome::Accepted(guard) => guard,
        AcquireOutcome::Rejected { current, max } => {
            warn!(
                target: "signaling",
                %client_ip,
                current,
                max,
                "rejecting WS upgrade — per-IP connection cap reached"
            );
            // 429 Too Many Requests communicates the cause without
            // leaking the cap value to opportunistic clients.
            return Err((StatusCode::TOO_MANY_REQUESTS, "per-ip connection cap"));
        }
    };
    let upgrade_rendezvous_id = upgrade_room_from_uri(&uri);
    Ok(ws
        .max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(state, socket, acquired, upgrade_rendezvous_id)))
}

fn request_origin(headers: &HeaderMap) -> Option<String> {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| *value == "https" || *value == "http")
        .unwrap_or("http");
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.contains([',', '/', '\\', ' ']))?;
    Some(format!("{scheme}://{host}"))
}

async fn handle_socket(
    state: AppState,
    socket: WebSocket,
    _ip_guard: Acquired,
    upgrade_rendezvous_id: Option<String>,
) {
    // `_ip_guard` is held for the lifetime of this task; dropping it on
    // function return (normal or panic) releases the per-IP slot.
    let peer_id = state.registry.next_peer_id();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<ServerFrame>(PEER_OUTBOUND_BUFFER);
    let mut bucket = TokenBucket::new(RATE_CAPACITY, RATE_REFILL_PER_SEC);
    let mut subscribed_rooms: Vec<(String, PeerRole, String)> = Vec::new();
    let challenge_issued_at = now_ms();
    let challenge_expires_at =
        challenge_issued_at.saturating_add(SUBSCRIBE_DEADLINE.as_millis() as i64);
    let mut challenge_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut challenge_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(challenge_bytes);
    let _ = tx.try_send(ServerFrame::Challenge {
        challenge: challenge.clone(),
        issued_at: challenge_issued_at,
        expires_at: challenge_expires_at,
    });

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
    loop {
        let next = match tokio::time::timeout(SOCKET_LEASE, stream.next()).await {
            Ok(next) => next,
            Err(_) => {
                debug!(target: "signaling", peer_id, "socket lease expired");
                break;
            }
        };
        let Some(msg) = next else { break };
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                debug!(target: "signaling", peer_id, error = %e, "ws stream error");
                break;
            }
        };
        match msg {
            Message::Text(text) => {
                if text.len() > MAX_FRAME_BYTES {
                    warn!(
                        target: "signaling",
                        peer_id,
                        len = text.len(),
                        "frame exceeds soft cap"
                    );
                    state.metrics.frame_rejected(RejectReason::TooLarge);
                    let _ = tx
                        .send(ServerFrame::Error {
                            code: "frame_too_large".into(),
                            message: "frame exceeds 8 KiB".into(),
                        })
                        .await;
                    continue;
                }
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0);
                if !bucket.try_take(now_ms) {
                    warn!(target: "signaling", peer_id, "rate limited");
                    state.metrics.frame_rejected(RejectReason::Rate);
                    let _ = tx
                        .send(ServerFrame::Error {
                            code: "rate_limited".into(),
                            message: "too many frames".into(),
                        })
                        .await;
                    // Drain the already-buffered burst before closing. Closing
                    // a TCP socket with unread client bytes can produce an RST
                    // that races and discards the queued error frame, leaving
                    // well-behaved clients unable to distinguish throttling
                    // from a network failure.
                    while matches!(
                        tokio::time::timeout(Duration::from_millis(10), stream.next()).await,
                        Ok(Some(_))
                    ) {}
                    break;
                }
                let frame: ClientFrame = match serde_json::from_str(&text) {
                    Ok(f) => f,
                    Err(e) => {
                        state.metrics.frame_rejected(RejectReason::Malformed);
                        // Keep the verbose serde error in the server log only —
                        // returning it verbatim to the client gives an attacker
                        // free protocol fingerprinting (field names, byte
                        // offsets) without source access. Issue a stable
                        // human-readable string instead.
                        debug!(target: "signaling", peer_id, error = %e, "malformed inbound frame");
                        let _ = tx
                            .send(ServerFrame::Error {
                                code: "malformed_frame".into(),
                                message: "frame did not match expected schema".into(),
                            })
                            .await;
                        continue;
                    }
                };
                state.metrics.frame_in();
                handle_frame(
                    &state,
                    peer_id,
                    frame,
                    &tx,
                    &mut subscribed_rooms,
                    AdmissionContext {
                        upgrade_rendezvous_id: upgrade_rendezvous_id.as_deref(),
                        challenge: &challenge,
                        challenge_expires_at,
                    },
                )
                .await;
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
    for (rid, role, session_id) in &subscribed_rooms {
        let others = state.registry.leave(rid, peer_id);
        for sender in others {
            let _ = sender.try_send(ServerFrame::PeerLeft {
                rendezvous_id: rid.clone(),
                role: *role,
                session_id: session_id.clone(),
            });
        }
    }
    // leave_all is a belt-and-braces sweep for rooms we forgot in
    // subscribed_rooms (shouldn't happen, but cheap to ensure).
    let extra = state.registry.leave_all(peer_id);
    for (rid, role, session_id, others) in extra {
        for sender in others {
            let _ = sender.try_send(ServerFrame::PeerLeft {
                rendezvous_id: rid.clone(),
                role,
                session_id: session_id.clone(),
            });
        }
    }

    drop(tx);
    let _ = outbound.await;
    debug!(target: "signaling", peer_id, "connection closed");
}

struct AdmissionContext<'a> {
    upgrade_rendezvous_id: Option<&'a str>,
    challenge: &'a str,
    challenge_expires_at: i64,
}

async fn handle_frame(
    state: &AppState,
    peer_id: u64,
    frame: ClientFrame,
    tx: &mpsc::Sender<ServerFrame>,
    subscribed_rooms: &mut Vec<(String, PeerRole, String)>,
    admission: AdmissionContext<'_>,
) {
    match frame {
        ClientFrame::Subscribe { descriptor, proof } => {
            let rendezvous_id = descriptor.room_id.clone();
            let role = proof.role;
            if let Some(upgrade_room) = admission.upgrade_rendezvous_id {
                if !rendezvous_id_matches_upgrade_room(upgrade_room, &rendezvous_id) {
                    state.metrics.frame_rejected(RejectReason::RoomMismatch);
                    warn!(
                        target: "signaling",
                        peer_id,
                        upgrade_room = %upgrade_room,
                        frame_room = %rendezvous_id,
                        "subscribe rejected because frame room does not match upgrade room"
                    );
                    let _ = tx
                        .send(ServerFrame::Error {
                            code: ROOM_MISMATCH_CODE.into(),
                            message: ROOM_MISMATCH_MESSAGE.into(),
                        })
                        .await;
                    return;
                }
            }
            if subscribed_rooms
                .iter()
                .any(|(rid, _, _)| rid == &rendezvous_id)
            {
                // Idempotent: ignore duplicate subscribe.
                return;
            }
            let joined_at_ms = now_ms();
            if joined_at_ms > admission.challenge_expires_at
                || verify_subscribe_proof(&descriptor, &proof, admission.challenge, joined_at_ms)
                    .is_err()
            {
                state.metrics.frame_rejected(RejectReason::Malformed);
                let _ = tx.try_send(ServerFrame::Error {
                    code: "auth_failed".into(),
                    message: "signaling v2 subscription authentication failed".into(),
                });
                return;
            }
            let handle = PeerHandle {
                peer_id,
                role,
                session_id: proof.session_id.clone(),
                proof: proof.as_ref().clone(),
                joined_at_ms,
                tx: tx.clone(),
            };
            let joined = state.registry.join_authenticated(&rendezvous_id, handle);
            subscribed_rooms.push((rendezvous_id.clone(), role, proof.session_id.clone()));
            if let Some(replaced) = joined.replaced {
                let _ = replaced.try_send(ServerFrame::Error {
                    code: "session_replaced".into(),
                    message: "a newer authenticated session took over this role".into(),
                });
            }

            // Tell the joiner who is already in the room.
            let _ = tx
                .send(ServerFrame::Subscribed {
                    rendezvous_id: rendezvous_id.clone(),
                    peers: joined
                        .existing
                        .iter()
                        .map(|h| PeerSnapshot {
                            proof: h.proof.clone(),
                            joined_at_ms: h.joined_at_ms,
                        })
                        .collect(),
                })
                .await;

            // Announce the join to everyone else.
            for other in joined.others {
                let _ = other.try_send(ServerFrame::PeerJoined {
                    rendezvous_id: rendezvous_id.clone(),
                    peer: PeerSnapshot {
                        proof: proof.as_ref().clone(),
                        joined_at_ms,
                    },
                });
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
            if let Some(upgrade_room) = admission.upgrade_rendezvous_id {
                if !rendezvous_id_matches_upgrade_room(upgrade_room, &rendezvous_id) {
                    state.metrics.frame_rejected(RejectReason::RoomMismatch);
                    let _ = tx
                        .send(ServerFrame::Error {
                            code: ROOM_MISMATCH_CODE.into(),
                            message: ROOM_MISMATCH_MESSAGE.into(),
                        })
                        .await;
                    return;
                }
            }
            let pos = subscribed_rooms
                .iter()
                .position(|(rid, _, _)| rid == &rendezvous_id);
            let Some(idx) = pos else { return };
            let (_, role, session_id) = subscribed_rooms.remove(idx);
            let others = state.registry.leave(&rendezvous_id, peer_id);
            for sender in others {
                let _ = sender.try_send(ServerFrame::PeerLeft {
                    rendezvous_id: rendezvous_id.clone(),
                    role,
                    session_id: session_id.clone(),
                });
            }
        }
        ClientFrame::Relay {
            rendezvous_id,
            payload,
        } => {
            if let Some(upgrade_room) = admission.upgrade_rendezvous_id {
                if !rendezvous_id_matches_upgrade_room(upgrade_room, &rendezvous_id) {
                    state.metrics.frame_rejected(RejectReason::RoomMismatch);
                    let _ = tx
                        .send(ServerFrame::Error {
                            code: ROOM_MISMATCH_CODE.into(),
                            message: ROOM_MISMATCH_MESSAGE.into(),
                        })
                        .await;
                    return;
                }
            }
            let Some((sender_role, sender_session_id, others)) =
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
            for (target_peer_id, sender) in others {
                if sender
                    .try_send(ServerFrame::Relay {
                        rendezvous_id: rendezvous_id.clone(),
                        from_role: sender_role,
                        from_session_id: sender_session_id.clone(),
                        payload: payload.clone(),
                    })
                    .is_err()
                {
                    warn!(
                        target: "signaling",
                        peer_id = target_peer_id,
                        rendezvous_id = %rendezvous_id,
                        "evicting slow signaling consumer"
                    );
                    state
                        .registry
                        .evict_slow_peer(&rendezvous_id, target_peer_id);
                }
            }
            state.metrics.frame_relayed(fanout);
        }
        ClientFrame::Ping => {
            let _ = tx.send(ServerFrame::Pong).await;
        }
    }
}

fn upgrade_room_from_uri(uri: &Uri) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key == "rid" && !value.is_empty() {
            Some(value.to_string())
        } else {
            None
        }
    })
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ip_limits::IpLimits,
        metrics::Metrics,
        room::{RoomRegistry, PEER_OUTBOUND_BUFFER},
    };
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use cognia_signaling_core::{
        proto::{RoomDescriptorV2, SubscribeProofV2},
        v2::{derive_room_id, subscribe_proof_bytes},
    };
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    fn state() -> AppState {
        state_with(cognia_signaling_core::policy::RoomLimits::default())
    }

    fn state_with(room_limits: cognia_signaling_core::policy::RoomLimits) -> AppState {
        AppState {
            registry: Arc::new(RoomRegistry::new()),
            metrics: Arc::new(Metrics::new()),
            ip_limits: IpLimits::new(50),
            room_limits,
            allowed_origins: Arc::new(Vec::new()),
            trust_proxy_headers: false,
        }
    }

    #[test]
    fn derives_same_origin_from_forwarded_https_host() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "signaling:7892".parse().unwrap());
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("x-forwarded-host", "brain.example".parse().unwrap());
        assert_eq!(
            request_origin(&headers).as_deref(),
            Some("https://brain.example")
        );
    }

    #[test]
    fn refuses_malformed_forwarded_hosts() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-host",
            "brain.example,evil.example".parse().unwrap(),
        );
        assert_eq!(request_origin(&headers), None);
    }

    /// Pre-seed a peer already sitting in `room` so its receiver can observe
    /// the fan-out (`PeerJoined` / `PeerLeft` / `Relay`) the handler emits.
    fn seed_peer(state: &AppState, room: &str, role: PeerRole) -> mpsc::Receiver<ServerFrame> {
        let (tx, rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let peer_id = state.registry.next_peer_id();
        state.registry.join(
            room,
            PeerHandle {
                peer_id,
                role,
                session_id: format!("seed-{}", role.as_str()),
                proof: proof(role, "challenge"),
                joined_at_ms: 1,
                tx,
            },
        );
        rx
    }

    fn identity(role: PeerRole) -> SigningKey {
        let byte = if role == PeerRole::Desktop { 1 } else { 2 };
        SigningKey::from_slice(&[byte; 32]).unwrap()
    }

    fn descriptor() -> RoomDescriptorV2 {
        let desktop = identity(PeerRole::Desktop);
        let mobile = identity(PeerRole::Mobile);
        let encode = |key: &SigningKey| {
            URL_SAFE_NO_PAD.encode(key.verifying_key().to_encoded_point(false).as_bytes())
        };
        let mut descriptor = RoomDescriptorV2 {
            v: 2,
            room_id: String::new(),
            room_nonce: "AAECAwQFBgcICQoLDA0ODw".into(),
            desktop_signing_key: encode(&desktop),
            mobile_signing_key: encode(&mobile),
            not_after: i64::MAX,
        };
        descriptor.room_id = derive_room_id(&descriptor);
        descriptor
    }

    fn room_id() -> String {
        descriptor().room_id
    }

    fn proof(role: PeerRole, challenge: &str) -> SubscribeProofV2 {
        let descriptor = descriptor();
        let ephemeral = SigningKey::from_slice(&[3u8; 32]).unwrap();
        let mut proof = SubscribeProofV2 {
            v: 2,
            room_id: descriptor.room_id,
            role,
            session_id: format!("session-{}", role.as_str()),
            epoch: format!("epoch-{}", role.as_str()),
            issued_at: now_ms(),
            challenge: challenge.into(),
            ecdh_public_key: URL_SAFE_NO_PAD
                .encode(ephemeral.verifying_key().to_encoded_point(false).as_bytes()),
            signature: String::new(),
        };
        let signature: Signature = identity(role).sign(&subscribe_proof_bytes(&proof));
        proof.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        proof
    }

    fn subscribe(_rid: &str, role: PeerRole) -> ClientFrame {
        ClientFrame::Subscribe {
            descriptor: Box::new(descriptor()),
            proof: Box::new(proof(role, "challenge")),
        }
    }

    async fn handle_frame(
        state: &AppState,
        peer_id: u64,
        frame: ClientFrame,
        tx: &mpsc::Sender<ServerFrame>,
        subscribed_rooms: &mut Vec<(String, PeerRole, String)>,
    ) {
        super::handle_frame(
            state,
            peer_id,
            frame,
            tx,
            subscribed_rooms,
            super::AdmissionContext {
                upgrade_rendezvous_id: None,
                challenge: "challenge",
                challenge_expires_at: i64::MAX,
            },
        )
        .await;
    }

    #[test]
    fn upgrade_room_from_uri_reads_non_empty_rid() {
        assert_eq!(
            super::upgrade_room_from_uri(&"/v2/signaling?rid=room-a".parse().unwrap()),
            Some("room-a".to_string())
        );
        assert_eq!(
            super::upgrade_room_from_uri(&"/v2/signaling?foo=1&rid=room-b".parse().unwrap()),
            Some("room-b".to_string())
        );
        assert_eq!(
            super::upgrade_room_from_uri(&"/v2/signaling?rid=".parse().unwrap()),
            None
        );
        assert_eq!(
            super::upgrade_room_from_uri(&"/v2/signaling".parse().unwrap()),
            None
        );
    }

    #[tokio::test]
    async fn subscribe_into_empty_room_replies_with_no_peers() {
        let state = state();
        let (tx, mut rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let peer_id = state.registry.next_peer_id();
        let mut rooms = Vec::new();

        handle_frame(
            &state,
            peer_id,
            subscribe("r", PeerRole::Desktop),
            &tx,
            &mut rooms,
        )
        .await;

        match rx.try_recv().expect("subscribed frame") {
            ServerFrame::Subscribed {
                rendezvous_id,
                peers,
            } => {
                assert_eq!(rendezvous_id, room_id());
                assert!(peers.is_empty());
            }
            other => panic!("expected Subscribed, got {other:?}"),
        }
        assert_eq!(state.registry.stats().peers, 1);
        assert_eq!(
            rooms,
            vec![(room_id(), PeerRole::Desktop, "session-desktop".to_string())]
        );
    }

    #[tokio::test]
    async fn second_desktop_subscribe_atomically_replaces_the_old_session() {
        let state = state();
        // Seed a desktop already owning the room.
        let mut owner = seed_peer(&state, &room_id(), PeerRole::Desktop);
        let (tx, mut rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let peer_id = state.registry.next_peer_id();
        let mut rooms = Vec::new();

        handle_frame(
            &state,
            peer_id,
            subscribe("r", PeerRole::Desktop),
            &tx,
            &mut rooms,
        )
        .await;

        match rx.try_recv().expect("subscribed frame") {
            ServerFrame::Subscribed { peers, .. } => assert!(peers.is_empty()),
            other => panic!("expected Subscribed, got {other:?}"),
        }
        match owner.try_recv().expect("replacement notice") {
            ServerFrame::Error { code, .. } => assert_eq!(code, "session_replaced"),
            other => panic!("expected session_replaced, got {other:?}"),
        }
        assert_eq!(state.registry.stats().peers, 1);
        assert_eq!(rooms.len(), 1);
    }

    #[tokio::test]
    async fn subscribe_with_existing_peer_announces_join() {
        let state = state();
        let mut other_rx = seed_peer(&state, &room_id(), PeerRole::Desktop);
        let (tx, mut rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let peer_id = state.registry.next_peer_id();
        let mut rooms = Vec::new();

        handle_frame(
            &state,
            peer_id,
            subscribe("r", PeerRole::Mobile),
            &tx,
            &mut rooms,
        )
        .await;

        match rx.try_recv().expect("subscribed") {
            ServerFrame::Subscribed { peers, .. } => {
                assert_eq!(peers.len(), 1);
                assert_eq!(peers[0].proof.role, PeerRole::Desktop);
            }
            other => panic!("expected Subscribed, got {other:?}"),
        }
        match other_rx.try_recv().expect("peer joined") {
            ServerFrame::PeerJoined { peer, .. } => {
                assert_eq!(peer.proof.role, PeerRole::Mobile)
            }
            other => panic!("expected PeerJoined, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn duplicate_subscribe_is_idempotent() {
        let state = state();
        let (tx, mut rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let peer_id = state.registry.next_peer_id();
        let mut rooms = Vec::new();

        handle_frame(
            &state,
            peer_id,
            subscribe("r", PeerRole::Desktop),
            &tx,
            &mut rooms,
        )
        .await;
        let _ = rx.try_recv().expect("first subscribed");
        handle_frame(
            &state,
            peer_id,
            subscribe("r", PeerRole::Desktop),
            &tx,
            &mut rooms,
        )
        .await;

        assert!(rx.try_recv().is_err(), "duplicate subscribe emits nothing");
        assert_eq!(state.registry.stats().peers, 1);
        assert_eq!(rooms.len(), 1);
    }

    #[tokio::test]
    async fn unsubscribe_announces_peer_left() {
        let state = state();
        let rid = room_id();
        let mut other_rx = seed_peer(&state, &rid, PeerRole::Desktop);
        let (tx, _rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let peer_id = state.registry.next_peer_id();
        let mut rooms = Vec::new();

        handle_frame(
            &state,
            peer_id,
            subscribe("r", PeerRole::Mobile),
            &tx,
            &mut rooms,
        )
        .await;
        let _ = other_rx.try_recv(); // drain PeerJoined

        handle_frame(
            &state,
            peer_id,
            ClientFrame::Unsubscribe { rendezvous_id: rid },
            &tx,
            &mut rooms,
        )
        .await;

        match other_rx.try_recv().expect("peer left") {
            ServerFrame::PeerLeft { role, .. } => assert_eq!(role, PeerRole::Mobile),
            other => panic!("expected PeerLeft, got {other:?}"),
        }
        assert!(rooms.is_empty());
        assert_eq!(
            state.registry.stats().peers,
            1,
            "only the seeded desktop remains"
        );
    }

    #[tokio::test]
    async fn unsubscribe_unknown_room_is_noop() {
        let state = state();
        let (tx, _rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let peer_id = state.registry.next_peer_id();
        let mut rooms = Vec::new();

        handle_frame(
            &state,
            peer_id,
            ClientFrame::Unsubscribe {
                rendezvous_id: "ghost".into(),
            },
            &tx,
            &mut rooms,
        )
        .await;

        assert!(rooms.is_empty());
        assert_eq!(state.registry.stats().rooms, 0);
    }

    #[tokio::test]
    async fn relay_fans_out_to_other_peers_and_counts() {
        let state = state();
        let rid = room_id();
        let mut other_rx = seed_peer(&state, &rid, PeerRole::Desktop);
        let (tx, _rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let peer_id = state.registry.next_peer_id();
        let mut rooms = Vec::new();

        handle_frame(
            &state,
            peer_id,
            subscribe("r", PeerRole::Mobile),
            &tx,
            &mut rooms,
        )
        .await;
        let _ = other_rx.try_recv(); // PeerJoined

        handle_frame(
            &state,
            peer_id,
            ClientFrame::Relay {
                rendezvous_id: rid,
                payload: "AAAA".into(),
            },
            &tx,
            &mut rooms,
        )
        .await;

        match other_rx.try_recv().expect("relay") {
            ServerFrame::Relay {
                from_role, payload, ..
            } => {
                assert_eq!(from_role, PeerRole::Mobile);
                assert_eq!(payload, "AAAA");
            }
            other => panic!("expected Relay, got {other:?}"),
        }
        assert_eq!(
            state.metrics.frames_relayed_total.load(Ordering::Relaxed),
            1
        );
    }

    #[tokio::test]
    async fn relay_without_subscription_errors() {
        let state = state();
        let (tx, mut rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let peer_id = state.registry.next_peer_id();
        let mut rooms = Vec::new();

        handle_frame(
            &state,
            peer_id,
            ClientFrame::Relay {
                rendezvous_id: "r".into(),
                payload: "x".into(),
            },
            &tx,
            &mut rooms,
        )
        .await;

        match rx.try_recv().expect("error") {
            ServerFrame::Error { code, .. } => assert_eq!(code, "not_subscribed"),
            other => panic!("expected Error, got {other:?}"),
        }
        assert_eq!(
            state
                .metrics
                .frames_rejected_not_subscribed
                .load(Ordering::Relaxed),
            1
        );
    }

    #[tokio::test]
    async fn ping_replies_pong() {
        let state = state();
        let (tx, mut rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let peer_id = state.registry.next_peer_id();
        let mut rooms = Vec::new();

        handle_frame(&state, peer_id, ClientFrame::Ping, &tx, &mut rooms).await;

        assert!(matches!(rx.try_recv(), Ok(ServerFrame::Pong)));
    }

    #[test]
    fn now_ms_is_positive() {
        assert!(now_ms() > 0);
    }
}
