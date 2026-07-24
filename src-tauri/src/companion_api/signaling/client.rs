//! Long-lived signaling-rendezvous WebSocket client. ADR-0021.
//!
//! One task per paired device that owns:
//! - the outbound WSS connection to the public signaling rendezvous,
//! - the `PeerSession` (created on receipt of `rtc:offer`),
//! - the dispatcher that bridges the resulting DataChannel to
//!   `companion_api::rpc::dispatch` + `EventBus`.
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

use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cognia_signaling_core::proto::{ClientFrame, ServerFrame};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;

use super::dispatch::spawn as spawn_dispatcher;
use super::envelope::{
    build_signed_envelope, decode_secret, encode_base64_url, fresh_nonce, now_ms,
    verify_signed_envelope, Envelope, EnvelopeError, EnvelopeKind, PeerRole, ReplayWindow,
};
use super::peer::{PeerCallbacks, PeerSession};
use super::{DeviceTier, TierWriter};
use crate::companion_api::SharedState;

/// Reconnect backoff schedule (ms). Index = attempt count (capped). Matches
/// `SIGNALING_BACKOFF_MS` in `lib/signaling/types.ts`.
const BACKOFF_MS: &[u64] = &[1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

/// Configuration passed to one signaling client task.
#[derive(Clone, Debug)]
pub struct ClientConfig {
    pub signaling_url: String,
    pub rendezvous_id: String,
    pub rendezvous_secret: String,
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
    if let Err(e) = decode_secret(&config.rendezvous_secret) {
        log::error!(
            "signaling::client[{}]: invalid rendezvous secret: {e}",
            config.device_id
        );
        config.tier_writer.set_with_error(
            DeviceTier::Failed,
            format!("invalid rendezvous secret: {e}"),
        );
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
    let (ws_stream, _resp) = connect_async(request)
        .await
        .map_err(|e| SessionError::Websocket(e.to_string()))?;
    let (mut write, mut read) = ws_stream.split();

    // Subscribe immediately. Server replies `Subscribed`.
    let nonce = fresh_nonce();
    let subscribe = ClientFrame::Subscribe {
        rendezvous_id: config.rendezvous_id.clone(),
        role: PeerRole::Desktop,
        client_nonce: nonce,
    };
    write
        .send(Message::Text(
            serde_json::to_string(&subscribe).expect("serialize subscribe"),
        ))
        .await
        .map_err(|e| SessionError::Websocket(e.to_string()))?;

    // Outbound queue → any task that wants to push a frame to the WSS sink
    // sends through here. Bounded so a runaway producer can't OOM us.
    let (out_tx, mut out_rx) = mpsc::channel::<String>(64);

    // Per-peer channels — recreated each time a fresh PeerSession is built
    // (i.e., each new offer). We hold the Options so we can drop them when
    // the peer dies and create fresh channels for the next offer.
    let mut peer_session: Option<Arc<PeerSession>> = None;
    let mut peer_ice_rx: Option<mpsc::UnboundedReceiver<RTCIceCandidateInit>> = None;
    let mut peer_state_rx: Option<mpsc::UnboundedReceiver<RTCPeerConnectionState>> = None;
    let mut peer_data_rx: Option<mpsc::UnboundedReceiver<Vec<u8>>> = None;
    let mut dispatcher: Option<tokio::task::JoinHandle<()>> = None;

    // Outbound envelope sequence counter (sender = "desktop").
    let mut next_seq: u64 = 1;
    let mut replay = ReplayWindow::default();
    let mut keepalive = tokio::time::interval(Duration::from_secs(25));
    keepalive.tick().await; // skip the immediate first tick

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
                        peer_session.take(),
                        dispatcher.take(),
                    ).await;
                    return Err(SessionError::Cancelled);
                }
            }

            Some(out) = out_rx.recv() => {
                if let Err(e) = write.send(Message::Text(out)).await {
                    return Err(SessionError::Websocket(e.to_string()));
                }
            }

            _ = keepalive.tick() => {
                let frame = serde_json::to_string(&ClientFrame::Ping)
                    .expect("serialize ping");
                if let Err(e) = write.send(Message::Text(frame)).await {
                    return Err(SessionError::Websocket(e.to_string()));
                }
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
                let env = build_signed_envelope(
                    next_seq,
                    EnvelopeKind::RtcIce,
                    body,
                    &config.rendezvous_secret,
                )
                .map_err(envelope_err)?;
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
                        teardown(peer_session.take(), dispatcher.take()).await;
                        peer_ice_rx = None;
                        peer_state_rx = None;
                        peer_data_rx = None;
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
                            ServerFrame::Subscribed { .. } => {
                                log::info!(
                                    "signaling::client[{}]: subscribed",
                                    config.device_id
                                );
                                // WSS is up and we're in the rendezvous —
                                // sit at `Awaiting` until a mobile peer
                                // joins (or `PeerJoined` for an already-
                                // present mobile fires immediately after).
                                config.tier_writer.set(DeviceTier::Awaiting);
                            }
                            ServerFrame::PeerJoined { role, .. } => {
                                log::info!(
                                    "signaling::client[{}]: peer-joined role={}",
                                    config.device_id,
                                    role.as_str()
                                );
                                if role == PeerRole::Mobile {
                                    config.tier_writer.set(DeviceTier::Negotiating);
                                }
                            }
                            ServerFrame::PeerLeft { role, .. } => {
                                log::info!(
                                    "signaling::client[{}]: peer-left role={}",
                                    config.device_id,
                                    role.as_str()
                                );
                                // Mobile dropped — tear down our peer too.
                                teardown(peer_session.take(), dispatcher.take()).await;
                                peer_ice_rx = None;
                                peer_state_rx = None;
                                peer_data_rx = None;
                                if role == PeerRole::Mobile {
                                    config.tier_writer.set(DeviceTier::Awaiting);
                                }
                            }
                            ServerFrame::Relay {
                                from_role, payload, ..
                            } => {
                                handle_relay(
                                    from_role,
                                    &payload,
                                    config,
                                    &state,
                                    &out_tx,
                                    &mut next_seq,
                                    &mut replay,
                                    &mut peer_session,
                                    &mut peer_ice_rx,
                                    &mut peer_state_rx,
                                    &mut peer_data_rx,
                                    &mut dispatcher,
                                )
                                .await?;
                            }
                            ServerFrame::Pong => {}
                            ServerFrame::Error { code, message } => {
                                log::warn!(
                                    "signaling::client[{}]: server error {code}: {message}",
                                    config.device_id
                                );
                                if code == "rate_limited" {
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
    envelope: &Envelope,
) -> Result<(), SessionError> {
    let env_bytes =
        serde_json::to_vec(envelope).map_err(|e| SessionError::Protocol(e.to_string()))?;
    let payload = URL_SAFE_NO_PAD.encode(env_bytes);
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

fn envelope_err(e: EnvelopeError) -> SessionError {
    SessionError::Protocol(format!("envelope: {e}"))
}

/// Decode the inbound relay payload, verify HMAC + replay, and dispatch by
/// envelope kind. May create a new `PeerSession` (on first `rtc:offer`) or
/// tear down an existing one (on `rtc:close`).
#[allow(clippy::too_many_arguments)]
async fn handle_relay(
    from_role: PeerRole,
    payload_b64: &str,
    config: &ClientConfig,
    state: &SharedState,
    out_tx: &mpsc::Sender<String>,
    next_seq: &mut u64,
    replay: &mut ReplayWindow,
    peer_session: &mut Option<Arc<PeerSession>>,
    peer_ice_rx: &mut Option<mpsc::UnboundedReceiver<RTCIceCandidateInit>>,
    peer_state_rx: &mut Option<mpsc::UnboundedReceiver<RTCPeerConnectionState>>,
    peer_data_rx: &mut Option<mpsc::UnboundedReceiver<Vec<u8>>>,
    dispatcher: &mut Option<tokio::task::JoinHandle<()>>,
) -> Result<(), SessionError> {
    let envelope_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64.as_bytes())
        .map_err(|e| SessionError::Protocol(format!("relay payload base64: {e}")))?;
    let envelope: Envelope = serde_json::from_slice(&envelope_bytes)
        .map_err(|e| SessionError::Protocol(format!("relay envelope json: {e}")))?;

    if let Err(e) = verify_signed_envelope(&envelope, &config.rendezvous_secret, None) {
        log::warn!(
            "signaling::client[{}]: rejected envelope: {e}",
            config.device_id
        );
        return Ok(());
    }
    // `from_role` is already the typed `PeerRole` off the wire frame — the
    // server only routes `desktop`/`mobile`, and the frame type enforces that.
    if let Err(e) = replay.observe(from_role, envelope.seq, &envelope.nonce) {
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
            let sdp = envelope
                .body
                .get("sdp")
                .and_then(Value::as_str)
                .ok_or_else(|| SessionError::Protocol("rtc:offer missing sdp".into()))?;
            let ice_restart = envelope
                .body
                .get("iceRestart")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if should_reuse_peer_for_offer(ice_restart, peer_session.is_some()) {
                // True ICE restart: renegotiate on the EXISTING peer so DTLS,
                // the data channel, and the dispatcher all survive — only ICE
                // re-gathers. `accept_offer` (set_remote_description +
                // create_answer + set_local_description) on the live PC
                // produces an answer carrying fresh ICE credentials; the
                // peer's existing `on_ice_candidate` hook keeps relaying new
                // candidates. Mirrors the mobile `attemptIceRestart` path in
                // `lib/tauri/transport-rtc.ts`.
                let existing = peer_session
                    .as_ref()
                    .expect("peer_session is_some checked above");
                let answer_sdp = existing
                    .accept_offer(sdp.to_string())
                    .await
                    .map_err(|e| SessionError::Protocol(format!("accept_offer(restart): {e}")))?;
                let answer = build_signed_envelope(
                    *next_seq,
                    EnvelopeKind::RtcAnswer,
                    json!({ "sdp": answer_sdp }),
                    &config.rendezvous_secret,
                )
                .map_err(envelope_err)?;
                *next_seq += 1;
                push_relay(out_tx, &config.rendezvous_id, &answer).await?;
            } else {
                // First offer (or a non-restart re-offer): build a fresh peer.
                // A prior peer/dispatcher, if any, is torn down below.
                let (ice_tx, ice_rx) = mpsc::unbounded_channel();
                let (data_tx, data_rx) = mpsc::unbounded_channel();
                let (state_tx, state_rx) = mpsc::unbounded_channel();
                let callbacks = PeerCallbacks {
                    outbound_ice: ice_tx,
                    inbound_data: data_tx,
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
                let answer = build_signed_envelope(
                    *next_seq,
                    EnvelopeKind::RtcAnswer,
                    json!({ "sdp": answer_sdp }),
                    &config.rendezvous_secret,
                )
                .map_err(envelope_err)?;
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
            let candidate = envelope
                .body
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
            }
        }
        EnvelopeKind::RtcClose => {
            log::info!(
                "signaling::client[{}]: peer requested rtc:close",
                config.device_id
            );
            teardown(peer_session.take(), dispatcher.take()).await;
            *peer_ice_rx = None;
            *peer_state_rx = None;
            *peer_data_rx = None;
            // Mobile cleanly closed its half — we're back to waiting for
            // the next offer.
            config.tier_writer.set(DeviceTier::Awaiting);
        }
    }
    // Suppress unused-warnings for placeholders that fed into the macro
    // expansions; the compiler keeps them around because we may need
    // their values in future kinds.
    let _ = encode_base64_url; // re-exported for tests
    let _ = now_ms;
    Ok(())
}

async fn teardown(peer: Option<Arc<PeerSession>>, dispatcher: Option<tokio::task::JoinHandle<()>>) {
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

    #[test]
    fn append_rid_adds_query_param() {
        assert_eq!(
            append_rid("wss://host/v1/signaling", "r1"),
            "wss://host/v1/signaling?rid=r1"
        );
    }

    #[test]
    fn append_rid_preserves_existing_query() {
        assert_eq!(
            append_rid("wss://host/v1/signaling?x=1", "r1"),
            "wss://host/v1/signaling?x=1&rid=r1"
        );
    }

    // Wire-format round-trips for the shared frame types live in
    // `cognia-signaling-core::proto`; this keeps just the desktop-specific
    // contract: a Subscribe built with `PeerRole::Desktop` must hit the wire as
    // the `"desktop"` literal the server routes on.
    #[test]
    fn desktop_subscribe_frame_serializes_with_desktop_role() {
        let frame = ClientFrame::Subscribe {
            rendezvous_id: "r1".into(),
            role: PeerRole::Desktop,
            client_nonce: "n1".into(),
        };
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""kind":"subscribe""#));
        assert!(text.contains(r#""role":"desktop""#));
    }
}
