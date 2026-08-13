//! Long-lived signaling-rendezvous WebSocket client. ADR-0021.
//!
//! One task per paired device that owns:
//! - the outbound WSS connection to the public signaling rendezvous,
//! - the `PeerSession` (created on receipt of `rtc:offer`),
//! - the dispatcher that bridges the resulting DataChannel to
//!   `companion_api::remote_execution` + `EventBus`.
//!
//! Reconnect policy mirrors the Discord-gateway pattern used elsewhere
//! in the codebase (`lib/connectors/adapters/discord/gateway-client.ts`):
//! full-jitter exponential backoff capped at 60 s, reset on first
//! successful `subscribed` reply.
//!
//! Cancellation is driven by a `tokio::sync::watch::Receiver<bool>` — the
//! `SignalingHub` flips the flag when the device is unpaired or the user
//! disables the WebRTC tier; the task observes the change at the next
//! `select!` poll and unwinds cleanly.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cognia_signaling_core::{
    proto::{
        ClientFrame, EnvelopeKind, PeerRole, PeerSnapshot, RoomDescriptorV2, ServerFrame,
        SignalingEnvelopeV2, SubscribeProofV2,
    },
    v2::{validate_room_descriptor, verify_subscribe_proof},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use webrtc::peer_connection::{RTCIceCandidateInit, RTCIceServer, RTCPeerConnectionState};

use super::dispatch::spawn as spawn_dispatcher;
use super::envelope_v2::{
    build_envelope, build_subscribe_proof, now_ms, verify_and_decrypt_envelope,
    StrictReplayWindowV2, V2EnvelopeError, V2EphemeralKey, V2Identity,
};
use super::peer::{
    PeerCallbacks, PeerSession, ICE_QUEUE_CAPACITY, INBOUND_FRAME_QUEUE_CAPACITY,
    STATE_QUEUE_CAPACITY,
};
use super::{DeviceTier, TierWriter};
use crate::companion_api::SharedState;

/// Reconnect backoff schedule (ms). Index = attempt count (capped). Matches
/// `SIGNALING_BACKOFF_MS` in `lib/signaling/types.ts`.
const BACKOFF_MS: &[u64] = &[1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const HEALTHY_RESET_AFTER: Duration = Duration::from_secs(60);
const MAX_PENDING_REMOTE_ICE: usize = 256;
const PENDING_REMOTE_ICE_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct PendingRemoteIce {
    candidates: VecDeque<(Instant, RTCIceCandidateInit)>,
}

impl PendingRemoteIce {
    fn push(&mut self, candidate: RTCIceCandidateInit) -> Result<(), SessionError> {
        self.push_at(candidate, Instant::now())
    }

    fn push_at(
        &mut self,
        candidate: RTCIceCandidateInit,
        now: Instant,
    ) -> Result<(), SessionError> {
        self.remove_expired(now);
        if self.candidates.len() >= MAX_PENDING_REMOTE_ICE {
            return Err(SessionError::Protocol(
                "pending remote ICE queue overflow".into(),
            ));
        }
        self.candidates.push_back((now, candidate));
        Ok(())
    }

    fn drain(&mut self) -> Vec<RTCIceCandidateInit> {
        self.drain_at(Instant::now())
    }

    fn drain_at(&mut self, now: Instant) -> Vec<RTCIceCandidateInit> {
        self.remove_expired(now);
        self.candidates
            .drain(..)
            .map(|(_, candidate)| candidate)
            .collect()
    }

    fn clear(&mut self) {
        self.candidates.clear();
    }

    fn remove_expired(&mut self, now: Instant) {
        while self.candidates.front().is_some_and(|(received_at, _)| {
            now.saturating_duration_since(*received_at) > PENDING_REMOTE_ICE_TTL
        }) {
            self.candidates.pop_front();
        }
    }
}

/// Configuration passed to one signaling client task.
#[derive(Clone)]
pub struct ClientConfig {
    pub signaling_url: String,
    pub rendezvous_id: String,
    pub room_descriptor: RoomDescriptorV2,
    pub signaling_key_ref: String,
    pub signing_private_key: String,
    pub device_id: String,
    /// ICE servers used by the desktop peer. STUN and optional TURN.
    pub ice_servers: Vec<RTCIceServer>,
    /// Handle the task uses to push its current [`DeviceTier`] into the
    /// hub's shared snapshot.
    pub tier_writer: TierWriter,
}

/// Spawn a signaling client task. The returned watch-sender allows the
/// caller to cancel the task by sending `true`; the corresponding watch-
/// receiver is observed at every `select!` poll.
pub fn spawn(config: ClientConfig, state: SharedState) -> ClientHandle {
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let join = tokio::spawn(run_with_reconnect(config.clone(), state, cancel_rx));
    ClientHandle {
        config,
        cancel_tx,
        join,
    }
}

/// Handle to a running signaling client. Drop the handle to keep the task
/// running; call [`shutdown`] (or simply drop after sending `true`) to
/// stop it. The dispatch host is resolved per-message from the shared
/// `SharedState` (see `signaling::dispatch`), so the task outlives any one
/// host and works in the desktop, headless, and harness processes alike.
pub struct ClientHandle {
    pub config: ClientConfig,
    cancel_tx: watch::Sender<bool>,
    join: tokio::task::JoinHandle<()>,
}

impl ClientHandle {
    pub async fn shutdown(self) {
        let _ = self.cancel_tx.send(true);
        let _ = self.join.await;
    }
}

// ---------------------------------------------------------------------------
// Reconnect loop
// ---------------------------------------------------------------------------

async fn run_with_reconnect(
    config: ClientConfig,
    state: SharedState,
    mut cancel_rx: watch::Receiver<bool>,
) {
    if validate_room_descriptor(&config.room_descriptor, now_ms()).is_err()
        || config.room_descriptor.room_id != config.rendezvous_id
    {
        log::error!(
            "signaling::client[{}]: invalid signaling v2 room descriptor",
            config.device_id
        );
        config
            .tier_writer
            .set_with_error(DeviceTier::Failed, "invalid signaling v2 room descriptor");
        return;
    }

    let mut attempt = 0usize;
    loop {
        if *cancel_rx.borrow() {
            return;
        }
        let label = format!(
            "device {} (room {})",
            config.device_id, config.rendezvous_id
        );
        log::info!(
            "signaling::client[{label}]: connecting to {}",
            config.signaling_url
        );
        // Each attempt begins from `Offline` — the moment the WSS connection
        // is `subscribed` we'll bump to `Awaiting`.
        config.tier_writer.set(DeviceTier::Offline);
        let session_started = Instant::now();
        match run_one_session(&config, state.clone(), cancel_rx.clone()).await {
            Ok(()) => {
                log::info!("signaling::client[{label}]: session ended cleanly");
                attempt = 0;
                // Clean shutdown — drop back to Offline pending next connect.
                config.tier_writer.set(DeviceTier::Offline);
            }
            Err(SessionError::Cancelled) => {
                log::info!("signaling::client[{label}]: cancelled");
                // The hub will remove the tier entry in `cancel_one`; no
                // need to push a final state here.
                return;
            }
            Err(e) => {
                log::warn!("signaling::client[{label}]: session error: {e}");
                config
                    .tier_writer
                    .set_with_error(DeviceTier::Failed, e.to_string());
                if session_started.elapsed() >= HEALTHY_RESET_AFTER {
                    attempt = 0;
                }
                attempt = attempt.saturating_add(1);
            }
        }
        let idx = attempt.min(BACKOFF_MS.len() - 1);
        let base = BACKOFF_MS[idx];
        let jitter = (rand::random::<u64>() % base.max(1)).max(1);
        let delay = Duration::from_millis(jitter);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    return;
                }
            }
        }
    }
}

#[derive(Debug)]
enum SessionError {
    Cancelled,
    Websocket(String),
    Protocol(String),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "cancelled"),
            Self::Websocket(e) => write!(f, "websocket: {e}"),
            Self::Protocol(e) => write!(f, "protocol: {e}"),
        }
    }
}

struct PeerCrypto {
    proof: SubscribeProofV2,
    inbound_key: [u8; 32],
    outbound_key: [u8; 32],
}

struct SessionCrypto {
    identity: V2Identity,
    ephemeral: V2EphemeralKey,
    own_proof: SubscribeProofV2,
    peer: Option<PeerCrypto>,
    replay: StrictReplayWindowV2,
}

impl SessionCrypto {
    fn accept_peer(
        &mut self,
        descriptor: &RoomDescriptorV2,
        snapshot: &PeerSnapshot,
    ) -> Result<(), SessionError> {
        if snapshot.proof.role != PeerRole::Mobile {
            return Err(SessionError::Protocol(
                "signaling snapshot carried the wrong peer role".into(),
            ));
        }
        verify_subscribe_proof(
            descriptor,
            &snapshot.proof,
            &snapshot.proof.challenge,
            now_ms(),
        )
        .map_err(|error| SessionError::Protocol(format!("peer proof: {error}")))?;
        let inbound_key = self
            .ephemeral
            .derive_direction_key(
                &snapshot.proof.ecdh_public_key,
                &descriptor.room_id,
                PeerRole::Mobile,
                &snapshot.proof.epoch,
            )
            .map_err(v2_envelope_err)?;
        let outbound_key = self
            .ephemeral
            .derive_direction_key(
                &snapshot.proof.ecdh_public_key,
                &descriptor.room_id,
                PeerRole::Desktop,
                &self.own_proof.epoch,
            )
            .map_err(v2_envelope_err)?;
        self.peer = Some(PeerCrypto {
            proof: snapshot.proof.clone(),
            inbound_key,
            outbound_key,
        });
        self.replay = StrictReplayWindowV2::default();
        Ok(())
    }

    fn build_outbound(
        &self,
        room_id: &str,
        seq: u64,
        kind: EnvelopeKind,
        body: &Value,
    ) -> Result<SignalingEnvelopeV2, SessionError> {
        let peer = self
            .peer
            .as_ref()
            .ok_or_else(|| SessionError::Protocol("mobile peer is not authenticated".into()))?;
        build_envelope(
            room_id,
            PeerRole::Desktop,
            &self.own_proof.session_id,
            &self.own_proof.epoch,
            seq,
            now_ms(),
            kind,
            body,
            &self.identity,
            &peer.outbound_key,
        )
        .map_err(v2_envelope_err)
    }
}

// Wire frames are the single source of truth in `cognia-signaling-core` (also
// used by the signaling server + its Cloudflare Worker), imported above so the
// desktop peer can never drift from the server's frame schema. `ClientFrame`
// is serialize-only here (we send Subscribe/Relay/Ping); `ServerFrame` is
// deserialize-only. The desktop ignores `Subscribed.peers` and the informational
// `rendezvous_id` on each frame — it already knows its room.

// ---------------------------------------------------------------------------
// Single-connection session
// ---------------------------------------------------------------------------

async fn run_one_session(
    config: &ClientConfig,
    state: SharedState,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(), SessionError> {
    // Append the room id as `?rid=` so the Cloudflare Worker can route the
    // upgrade to the per-room Durable Object before the socket is accepted.
    // The axum server ignores the query param (backward compatible).
    let connect_url = append_rid(&config.signaling_url, &config.rendezvous_id);
    let request = connect_url
        .as_str()
        .into_client_request()
        .map_err(|e| SessionError::Websocket(format!("invalid URL: {e}")))?;
    let (mut ws_stream, _resp) =
        tokio::time::timeout(Duration::from_secs(8), connect_async(request))
            .await
            .map_err(|_| SessionError::Websocket("signaling connect timed out".into()))?
            .map_err(|e| SessionError::Websocket(e.to_string()))?;
    let challenge_frame = tokio::time::timeout(Duration::from_secs(5), ws_stream.next())
        .await
        .map_err(|_| SessionError::Protocol("signaling challenge timed out".into()))?
        .ok_or_else(|| SessionError::Websocket("stream ended before challenge".into()))?
        .map_err(|error| SessionError::Websocket(error.to_string()))?;
    let challenge = match challenge_frame {
        Message::Text(text) => match serde_json::from_str::<ServerFrame>(&text)
            .map_err(|error| SessionError::Protocol(format!("bad challenge frame: {error}")))?
        {
            ServerFrame::Challenge {
                challenge,
                expires_at,
                ..
            } if expires_at >= now_ms() => challenge,
            _ => {
                return Err(SessionError::Protocol(
                    "expected a live signaling v2 challenge".into(),
                ))
            }
        },
        _ => {
            return Err(SessionError::Protocol(
                "expected a text signaling challenge".into(),
            ))
        }
    };
    let private_bytes = URL_SAFE_NO_PAD
        .decode(config.signing_private_key.as_bytes())
        .map_err(|error| SessionError::Protocol(format!("signing key base64: {error}")))?;
    let identity = V2Identity::from_private_bytes(&private_bytes).map_err(v2_envelope_err)?;
    if identity.public_key_base64() != config.room_descriptor.desktop_signing_key {
        return Err(SessionError::Protocol(
            "desktop signing key does not match the room descriptor".into(),
        ));
    }
    let ephemeral = V2EphemeralKey::generate();
    let own_proof = build_subscribe_proof(
        &config.room_descriptor,
        PeerRole::Desktop,
        fresh_v2_id(),
        fresh_v2_id(),
        now_ms(),
        challenge,
        &ephemeral,
        &identity,
    );
    let subscribe = ClientFrame::Subscribe {
        descriptor: Box::new(config.room_descriptor.clone()),
        proof: Box::new(own_proof.clone()),
    };
    ws_stream
        .send(Message::Text(
            serde_json::to_string(&subscribe)
                .expect("serialize subscribe")
                .into(),
        ))
        .await
        .map_err(|e| SessionError::Websocket(e.to_string()))?;
    let (mut write, mut read) = ws_stream.split();
    let mut crypto = SessionCrypto {
        identity,
        ephemeral,
        own_proof,
        peer: None,
        replay: StrictReplayWindowV2::default(),
    };

    // Outbound queue → any task that wants to push a frame to the WSS sink
    // sends through here. Bounded so a runaway producer can't OOM us.
    let (out_tx, mut out_rx) = mpsc::channel::<String>(64);

    // Per-peer channels — recreated each time a fresh PeerSession is built
    // (i.e., each new offer). We hold the Options so we can drop them when
    // the peer dies and create fresh channels for the next offer.
    let mut peer_session: Option<Arc<PeerSession>> = None;
    let mut peer_ice_rx: Option<mpsc::Receiver<RTCIceCandidateInit>> = None;
    let mut peer_state_rx: Option<mpsc::Receiver<RTCPeerConnectionState>> = None;
    let mut peer_data_rx: Option<mpsc::Receiver<Vec<u8>>> = None;
    let mut dispatcher: Option<tokio::task::JoinHandle<()>> = None;
    let mut pending_remote_ice = PendingRemoteIce::default();

    // Outbound envelope sequence counter (sender = "desktop").
    let mut next_seq: u64 = 1;
    let mut keepalive = tokio::time::interval(Duration::from_secs(20));
    keepalive.tick().await; // skip the immediate first tick
    let mut subscribe_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(5));
    let mut pong_deadline: Option<tokio::time::Instant> = None;

    loop {
        // Helpers for `select!` — extract receivers that may be `None` and
        // gate the branch on `Option::is_some()` via `if let`.
        let ice_branch = peer_ice_rx.as_mut();
        let state_branch = peer_state_rx.as_mut();

        tokio::select! {
            biased;

            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    teardown(
                        &config.device_id,
                        peer_session.take(),
                        dispatcher.take(),
                    ).await;
                    return Err(SessionError::Cancelled);
                }
            }

            Some(out) = out_rx.recv() => {
                if let Err(e) = write.send(Message::Text(out.into())).await {
                    return Err(SessionError::Websocket(e.to_string()));
                }
            }

            _ = keepalive.tick() => {
                let frame = serde_json::to_string(&ClientFrame::Ping)
                    .expect("serialize ping");
                if let Err(e) = write.send(Message::Text(frame.into())).await {
                    return Err(SessionError::Websocket(e.to_string()));
                }
                pong_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(10));
            }

            _ = async {
                match subscribe_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            } => {
                return Err(SessionError::Protocol("signaling subscribe timed out".into()));
            }

            _ = async {
                match pong_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            } => {
                return Err(SessionError::Websocket("signaling pong timed out".into()));
            }

            Some(candidate) = async {
                match ice_branch {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                // Forward our ICE candidate to the mobile peer as a signed
                // rtc:ice envelope.
                let body = json!({ "candidate": candidate });
                let env = crypto.build_outbound(
                    &config.rendezvous_id,
                    next_seq,
                    EnvelopeKind::RtcIce,
                    &body,
                )?;
                next_seq += 1;
                push_relay(&out_tx, &config.rendezvous_id, &env).await?;
            }

            Some(s) = async {
                match state_branch {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                match s {
                    RTCPeerConnectionState::Connected => {
                        config.tier_writer.set(DeviceTier::Connected);
                    }
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                        log::info!(
                            "signaling::client[{}]: peer state {s:?} — tearing down",
                            config.device_id
                        );
                        teardown(
                            &config.device_id,
                            peer_session.take(),
                            dispatcher.take(),
                        )
                        .await;
                        peer_ice_rx = None;
                        peer_state_rx = None;
                        peer_data_rx = None;
                        pending_remote_ice.clear();
                        // Mobile peer dropped; we're still subscribed and
                        // awaiting a fresh offer.
                        config.tier_writer.set(DeviceTier::Awaiting);
                    }
                    _ => {
                        // `New`/`Connecting`/`Disconnected` — keep the
                        // current tier; the next definitive transition will
                        // overwrite it.
                    }
                }
            }

            msg = read.next() => {
                let Some(msg) = msg else {
                    return Err(SessionError::Websocket("stream ended".into()));
                };
                let msg = msg.map_err(|e| SessionError::Websocket(e.to_string()))?;
                match msg {
                    Message::Text(text) => {
                        let frame: ServerFrame = serde_json::from_str(&text).map_err(|e| {
                            SessionError::Protocol(format!("bad server frame: {e}"))
                        })?;
                        match frame {
                            ServerFrame::Challenge { .. } => {
                                return Err(SessionError::Protocol(
                                    "unexpected second signaling challenge".into(),
                                ));
                            }
                            ServerFrame::Subscribed { peers, .. } => {
                                subscribe_deadline = None;
                                log::info!(
                                    "signaling::client[{}]: subscribed",
                                    config.device_id
                                );
                                if let Some(peer) =
                                    peers.iter().find(|peer| peer.proof.role == PeerRole::Mobile)
                                {
                                    crypto.accept_peer(&config.room_descriptor, peer)?;
                                    config.tier_writer.set(DeviceTier::Negotiating);
                                }
                                // WSS is up and we're in the rendezvous —
                                // sit at `Awaiting` until a mobile peer
                                // joins (or `PeerJoined` for an already-
                                // present mobile fires immediately after).
                                config.tier_writer.set(DeviceTier::Awaiting);
                            }
                            ServerFrame::PeerJoined { peer, .. } => {
                                log::info!(
                                    "signaling::client[{}]: peer-joined role={}",
                                    config.device_id,
                                    peer.proof.role.as_str()
                                );
                                if peer.proof.role == PeerRole::Mobile {
                                    let replacing_live_session = crypto
                                        .peer
                                        .as_ref()
                                        .is_some_and(|current| {
                                            current.proof.session_id != peer.proof.session_id
                                        });
                                    if replacing_live_session {
                                        teardown(
                                            &config.device_id,
                                            peer_session.take(),
                                            dispatcher.take(),
                                        )
                                        .await;
                                        peer_ice_rx = None;
                                        peer_state_rx = None;
                                        peer_data_rx = None;
                                        pending_remote_ice.clear();
                                    }
                                    crypto.accept_peer(&config.room_descriptor, &peer)?;
                                    config.tier_writer.set(DeviceTier::Negotiating);
                                }
                            }
                            ServerFrame::PeerLeft {
                                role,
                                session_id,
                                ..
                            } => {
                                log::info!(
                                    "signaling::client[{}]: peer-left role={}",
                                    config.device_id,
                                    role.as_str()
                                );
                                if crypto.peer.as_ref().map(|peer| peer.proof.session_id.as_str())
                                    != Some(session_id.as_str())
                                {
                                    continue;
                                }
                                crypto.peer = None;
                                crypto.replay = StrictReplayWindowV2::default();
                                // Mobile dropped — tear down our peer too.
                                teardown(
                                    &config.device_id,
                                    peer_session.take(),
                                    dispatcher.take(),
                                )
                                .await;
                                peer_ice_rx = None;
                                peer_state_rx = None;
                                peer_data_rx = None;
                                pending_remote_ice.clear();
                                if role == PeerRole::Mobile {
                                    config.tier_writer.set(DeviceTier::Awaiting);
                                }
                            }
                            ServerFrame::Relay {
                                from_role,
                                from_session_id,
                                payload,
                                ..
                            } => {
                                handle_relay(
                                    from_role,
                                    &from_session_id,
                                    &payload,
                                    config,
                                    &state,
                                    &out_tx,
                                    &mut next_seq,
                                    &mut crypto,
                                    &mut peer_session,
                                    &mut peer_ice_rx,
                                    &mut peer_state_rx,
                                    &mut peer_data_rx,
                                    &mut dispatcher,
                                    &mut pending_remote_ice,
                                )
                                .await?;
                            }
                            ServerFrame::Pong => {
                                pong_deadline = None;
                            }
                            ServerFrame::Error { code, message } => {
                                log::warn!(
                                    "signaling::client[{}]: server error {code}: {message}",
                                    config.device_id
                                );
                                if matches!(
                                    code.as_str(),
                                    "rate_limited" | "auth_failed" | "session_replaced"
                                ) {
                                    return Err(SessionError::Protocol(format!(
                                        "rate limited by signaling server: {message}"
                                    )));
                                }
                            }
                        }
                    }
                    Message::Close(_) => {
                        return Err(SessionError::Websocket("server closed".into()));
                    }
                    Message::Ping(buf) => {
                        write
                            .send(Message::Pong(buf))
                            .await
                            .map_err(|e| SessionError::Websocket(e.to_string()))?;
                    }
                    Message::Pong(_) | Message::Frame(_) | Message::Binary(_) => {}
                }
            }
        }
    }
}

async fn push_relay(
    out_tx: &mpsc::Sender<String>,
    rendezvous_id: &str,
    envelope: &SignalingEnvelopeV2,
) -> Result<(), SessionError> {
    let payload =
        serde_json::to_string(envelope).map_err(|e| SessionError::Protocol(e.to_string()))?;
    let frame = ClientFrame::Relay {
        rendezvous_id: rendezvous_id.to_string(),
        payload,
    };
    let text = serde_json::to_string(&frame).map_err(|e| SessionError::Protocol(e.to_string()))?;
    out_tx
        .send(text)
        .await
        .map_err(|_| SessionError::Protocol("outbound queue closed".into()))
}

/// Whether an inbound `rtc:offer` should renegotiate on the live peer (a true
/// ICE restart that preserves DTLS + the data channel) instead of rebuilding a
/// fresh [`PeerSession`]. Reuse requires both the restart flag and an existing
/// peer; a restart flag with no peer (e.g. after a teardown) falls through to a
/// fresh build.
fn should_reuse_peer_for_offer(ice_restart: bool, has_peer: bool) -> bool {
    ice_restart && has_peer
}

/// Append the rendezvous room id to the signaling URL as `?rid=`. The room id
/// is a URL-safe UUID minted at pair time, so it needs no percent-encoding.
/// Preserves any pre-existing query string (`&` vs `?`).
fn append_rid(url: &str, rendezvous_id: &str) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}rid={rendezvous_id}")
}

fn v2_envelope_err(e: V2EnvelopeError) -> SessionError {
    SessionError::Protocol(format!("signaling v2 envelope: {e}"))
}

fn fresh_v2_id() -> String {
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decrypt the inbound relay payload, verify signature + replay, and dispatch by
/// envelope kind. May create a new `PeerSession` (on first `rtc:offer`) or
/// tear down an existing one (on `rtc:close`).
#[allow(clippy::too_many_arguments)]
async fn handle_relay(
    from_role: PeerRole,
    from_session_id: &str,
    payload: &str,
    config: &ClientConfig,
    state: &SharedState,
    out_tx: &mpsc::Sender<String>,
    next_seq: &mut u64,
    crypto: &mut SessionCrypto,
    peer_session: &mut Option<Arc<PeerSession>>,
    peer_ice_rx: &mut Option<mpsc::Receiver<RTCIceCandidateInit>>,
    peer_state_rx: &mut Option<mpsc::Receiver<RTCPeerConnectionState>>,
    peer_data_rx: &mut Option<mpsc::Receiver<Vec<u8>>>,
    dispatcher: &mut Option<tokio::task::JoinHandle<()>>,
    pending_remote_ice: &mut PendingRemoteIce,
) -> Result<(), SessionError> {
    let envelope: SignalingEnvelopeV2 = serde_json::from_str(payload)
        .map_err(|e| SessionError::Protocol(format!("relay envelope json: {e}")))?;
    let Some(peer_crypto) = crypto.peer.as_ref() else {
        log::warn!(
            "signaling::client[{}]: relay before peer auth",
            config.device_id
        );
        return Ok(());
    };
    if from_role != PeerRole::Mobile
        || from_session_id != peer_crypto.proof.session_id
        || envelope.session_id != peer_crypto.proof.session_id
        || envelope.epoch != peer_crypto.proof.epoch
    {
        log::warn!(
            "signaling::client[{}]: rejected relay session metadata",
            config.device_id
        );
        return Ok(());
    }
    let body = match verify_and_decrypt_envelope(
        &envelope,
        &config.rendezvous_id,
        PeerRole::Mobile,
        &config.room_descriptor.mobile_signing_key,
        &peer_crypto.inbound_key,
        now_ms(),
    ) {
        Ok(body) => body,
        Err(error) => {
            log::warn!(
                "signaling::client[{}]: rejected v2 envelope: {error}",
                config.device_id
            );
            return Ok(());
        }
    };
    if let Err(e) = crypto
        .replay
        .observe(&envelope.epoch, envelope.seq, now_ms())
    {
        log::warn!(
            "signaling::client[{}]: replay detected: {e}",
            config.device_id
        );
        return Ok(());
    }

    match envelope.kind {
        EnvelopeKind::Hello => {
            log::debug!(
                "signaling::client[{}]: hello from {}",
                config.device_id,
                from_role.as_str()
            );
        }
        EnvelopeKind::RtcOffer => {
            let sdp = body
                .get("sdp")
                .and_then(Value::as_str)
                .ok_or_else(|| SessionError::Protocol("rtc:offer missing sdp".into()))?;
            let ice_restart = body
                .get("iceRestart")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if should_reuse_peer_for_offer(ice_restart, peer_session.is_some()) {
                // True ICE restart: renegotiate on the EXISTING peer so DTLS,
                // the data channel, and the dispatcher all survive — only ICE
                // re-gathers. `accept_offer` (set_remote_description +
                // create_answer + set_local_description) on the live PC
                // produces an answer carrying fresh ICE credentials; the
                // peer's existing event handler keeps relaying new ICE
                // candidates. Mirrors the mobile `attemptIceRestart` path in
                // `lib/tauri/transport-rtc.ts`.
                let existing = peer_session
                    .as_ref()
                    .expect("peer_session is_some checked above");
                let answer_sdp = existing
                    .accept_offer(sdp.to_string())
                    .await
                    .map_err(|e| SessionError::Protocol(format!("accept_offer(restart): {e}")))?;
                let answer = crypto.build_outbound(
                    &config.rendezvous_id,
                    *next_seq,
                    EnvelopeKind::RtcAnswer,
                    &json!({ "sdp": answer_sdp }),
                )?;
                *next_seq += 1;
                push_relay(out_tx, &config.rendezvous_id, &answer).await?;
            } else {
                // First offer (or a non-restart re-offer): build a fresh peer.
                // A prior peer/dispatcher, if any, is torn down below.
                let (ice_tx, ice_rx) = mpsc::channel(ICE_QUEUE_CAPACITY);
                let (data_tx, data_rx) = mpsc::channel(INBOUND_FRAME_QUEUE_CAPACITY);
                let (state_tx, state_rx) = mpsc::channel(STATE_QUEUE_CAPACITY);
                let callbacks = PeerCallbacks {
                    outbound_ice: ice_tx,
                    inbound_data: data_tx,
                    terminal_channel: Arc::new({
                        let state = Arc::clone(state);
                        let device_id = config.device_id.clone();
                        move |channel| {
                            let state = Arc::clone(&state);
                            let device_id = device_id.clone();
                            tokio::spawn(async move {
                                crate::companion_api::ws_terminal::proxy_terminal_datachannel(
                                    channel, device_id, state,
                                )
                                .await;
                            });
                        }
                    }),
                    state_change: state_tx,
                };
                let new_peer = PeerSession::new(config.ice_servers.clone(), callbacks)
                    .await
                    .map_err(|e| SessionError::Protocol(format!("peer build: {e}")))?;
                let new_peer = Arc::new(new_peer);

                // Generate the SDP answer and relay it back as a signed envelope.
                let answer_sdp = new_peer
                    .accept_offer(sdp.to_string())
                    .await
                    .map_err(|e| SessionError::Protocol(format!("accept_offer: {e}")))?;
                for candidate in pending_remote_ice.drain() {
                    if let Err(e) = new_peer.add_remote_ice(candidate).await {
                        log::warn!(
                            "signaling::client[{}]: queued addRemoteIce failed: {e}",
                            config.device_id
                        );
                    }
                }
                let answer = crypto.build_outbound(
                    &config.rendezvous_id,
                    *next_seq,
                    EnvelopeKind::RtcAnswer,
                    &json!({ "sdp": answer_sdp }),
                )?;
                *next_seq += 1;
                push_relay(out_tx, &config.rendezvous_id, &answer).await?;

                // Tear down any previous dispatcher / channels.
                if let Some(h) = dispatcher.take() {
                    h.abort();
                }
                *peer_session = Some(Arc::clone(&new_peer));
                *peer_ice_rx = Some(ice_rx);
                *peer_state_rx = Some(state_rx);
                *peer_data_rx = Some(data_rx);

                // Spawn the dispatcher — it owns the data_rx side until the
                // DataChannel actually opens (waited on inside the dispatcher).
                // Wrapping in tokio::spawn means the rest of the session loop
                // continues to drive ICE / outbound while the DC is still
                // negotiating.
                let data_rx_take = peer_data_rx.take().expect("data rx just set");
                let handle = spawn_dispatcher(
                    Arc::clone(&new_peer),
                    data_rx_take,
                    state.clone(),
                    config.device_id.clone(),
                );
                *dispatcher = Some(handle);
            }
        }
        EnvelopeKind::RtcAnswer => {
            // We are always the answerer in the desktop role. Receiving an
            // answer suggests the mobile is confused; log + drop.
            log::warn!(
                "signaling::client[{}]: unexpected rtc:answer from {}",
                config.device_id,
                from_role.as_str()
            );
        }
        EnvelopeKind::RtcIce => {
            let candidate = body
                .get("candidate")
                .cloned()
                .ok_or_else(|| SessionError::Protocol("rtc:ice missing candidate".into()))?;
            let init: RTCIceCandidateInit = serde_json::from_value(candidate)
                .map_err(|e| SessionError::Protocol(format!("ice candidate: {e}")))?;
            if let Some(peer) = peer_session.as_ref() {
                if let Err(e) = peer.add_remote_ice(init).await {
                    log::warn!(
                        "signaling::client[{}]: addRemoteIce failed: {e}",
                        config.device_id
                    );
                }
            } else {
                pending_remote_ice.push(init)?;
            }
        }
        EnvelopeKind::RtcClose => {
            log::info!(
                "signaling::client[{}]: peer requested rtc:close",
                config.device_id
            );
            teardown(&config.device_id, peer_session.take(), dispatcher.take()).await;
            *peer_ice_rx = None;
            *peer_state_rx = None;
            *peer_data_rx = None;
            pending_remote_ice.clear();
            // Mobile cleanly closed its half — we're back to waiting for
            // the next offer.
            config.tier_writer.set(DeviceTier::Awaiting);
        }
    }
    Ok(())
}

async fn teardown(
    device_id: &str,
    peer: Option<Arc<PeerSession>>,
    dispatcher: Option<tokio::task::JoinHandle<()>>,
) {
    crate::companion_api::admin_lease::revoke_device(device_id);
    if let Some(d) = dispatcher {
        d.abort();
    }
    if let Some(p) = peer {
        p.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuse_peer_for_offer_requires_restart_flag_and_existing_peer() {
        // True ICE restart: reuse the live peer.
        assert!(should_reuse_peer_for_offer(true, true));
        // Restart requested but no peer yet → fresh build.
        assert!(!should_reuse_peer_for_offer(true, false));
        // First/non-restart offer with an existing peer → fresh build
        // (full renegotiation, new DTLS).
        assert!(!should_reuse_peer_for_offer(false, true));
        assert!(!should_reuse_peer_for_offer(false, false));
    }

    #[tokio::test]
    async fn teardown_revokes_device_admin_leases_even_without_a_live_peer() {
        let lease = crate::companion_api::admin_lease::issue(
            "rtc-teardown-device",
            vec!["external_bridge_start".into()],
            Some(600),
            true,
            true,
        )
        .unwrap();
        assert!(crate::companion_api::admin_lease::validate(
            "rtc-teardown-device",
            "external_bridge_start",
            Some(&lease.token),
        )
        .is_ok());

        teardown("rtc-teardown-device", None, None).await;

        assert!(crate::companion_api::admin_lease::validate(
            "rtc-teardown-device",
            "external_bridge_start",
            Some(&lease.token),
        )
        .is_err());
    }

    #[test]
    fn append_rid_adds_query_param() {
        assert_eq!(
            append_rid("wss://host/v2/signaling", "r1"),
            "wss://host/v2/signaling?rid=r1"
        );
    }

    #[test]
    fn append_rid_preserves_existing_query() {
        assert_eq!(
            append_rid("wss://host/v2/signaling?x=1", "r1"),
            "wss://host/v2/signaling?x=1&rid=r1"
        );
    }

    #[test]
    fn pending_remote_ice_preserves_order_until_offer_exists() {
        let mut pending = PendingRemoteIce::default();
        let now = std::time::Instant::now();
        pending
            .push_at(
                RTCIceCandidateInit {
                    candidate: "candidate:first".into(),
                    ..Default::default()
                },
                now,
            )
            .unwrap();
        pending
            .push_at(
                RTCIceCandidateInit {
                    candidate: "candidate:second".into(),
                    ..Default::default()
                },
                now,
            )
            .unwrap();

        let drained = pending.drain_at(now);
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].candidate, "candidate:first");
        assert_eq!(drained[1].candidate, "candidate:second");
        assert!(pending.drain_at(now).is_empty());
    }

    #[test]
    fn pending_remote_ice_is_bounded_and_expires_old_candidates() {
        let mut pending = PendingRemoteIce::default();
        let now = std::time::Instant::now();
        for index in 0..MAX_PENDING_REMOTE_ICE {
            pending
                .push_at(
                    RTCIceCandidateInit {
                        candidate: format!("candidate:{index}"),
                        ..Default::default()
                    },
                    now,
                )
                .unwrap();
        }
        assert!(pending
            .push_at(
                RTCIceCandidateInit {
                    candidate: "candidate:overflow".into(),
                    ..Default::default()
                },
                now,
            )
            .is_err());
        assert!(pending
            .drain_at(now + PENDING_REMOTE_ICE_TTL + Duration::from_millis(1))
            .is_empty());
    }

    // Wire-format round-trips for the shared frame types live in
    // `cognia-signaling-core::proto`; this keeps just the desktop-specific
    // contract: a Subscribe built with `PeerRole::Desktop` must hit the wire as
    // the `"desktop"` literal the server routes on.
    #[test]
    fn desktop_subscribe_frame_serializes_with_desktop_role() {
        let frame = ClientFrame::Subscribe {
            descriptor: Box::new(RoomDescriptorV2 {
                v: 2,
                room_id: "r1".into(),
                room_nonce: "nonce".into(),
                desktop_signing_key: "desktop-key".into(),
                mobile_signing_key: "mobile-key".into(),
                not_after: 1_800_000_000_000,
            }),
            proof: Box::new(SubscribeProofV2 {
                v: 2,
                room_id: "r1".into(),
                role: PeerRole::Desktop,
                session_id: "s1".into(),
                epoch: "e1".into(),
                issued_at: 1_700_000_000_000,
                challenge: "c1".into(),
                ecdh_public_key: "ephemeral-key".into(),
                signature: "signature".into(),
            }),
        };
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""kind":"subscribe""#));
        assert!(text.contains(r#""role":"desktop""#));
    }
}
