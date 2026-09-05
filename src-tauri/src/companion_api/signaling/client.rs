//! Long-lived signaling-rendezvous WebSocket client. ADR-0021.
//!
//! One task per paired device that owns:
//! - the outbound WSS connection to the public signaling rendezvous,
//! - the `PeerSession` (created on receipt of `rtc:offer`),
//! - the dispatcher that bridges the resulting DataChannel to
//!   `companion_api::remote_execution` + `EventBus`,
//! - and, since ADR-0170, the **relay data lane**: a peer whose `hello`
//!   announces `relay: true` gets its dispatcher the moment it is
//!   authenticated, writing through a [`DataCarrier`] that uses the
//!   DataChannel when one is open and otherwise hands each frame back to
//!   this task to be sealed into a `data` envelope. A phone behind a
//!   symmetric NAT, or a browser that never completes ICE, therefore has
//!   full RPC + event service from the first round trip.
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
        ClientFrame, EnvelopeKind, PeerRole, PeerSnapshot, RelayLane, RoomDescriptor,
        ServerFrame, SignalingEnvelope, SubscribeProof,
    },
    protocol::{validate_room_descriptor, verify_subscribe_proof},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use webrtc::peer_connection::{RTCIceCandidateInit, RTCIceServer, RTCPeerConnectionState};

use super::carrier::{DataCarrier, RelayFrame, RELAY_OUTBOUND_QUEUE};
use super::dispatch::spawn as spawn_dispatcher;
use super::envelope::{
    build_envelope, build_subscribe_proof, now_ms, verify_and_decrypt_envelope, EnvelopeError,
    EphemeralKey, SignalingIdentity, StrictReplayWindow,
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

/// Ceiling for a relay that is answering, but answering "no".
///
/// A WebSocket handshake refused with an HTTP status is a *configuration*
/// failure, not an outage: the URL is not a signaling endpoint, or this device
/// is not allowed on it. Nothing the client does differently in 30 seconds will
/// change that, and with one task per paired device the 30 s schedule turns a
/// mis-set `signalingUrl` into a permanent log firehose — which is exactly what
/// an undeployed `wss://…/signaling` produces today. Backing off to five
/// minutes keeps the retry alive (a relay deployed later is still picked up)
/// while making the wrong configuration quiet enough to read past.
const REJECTED_BACKOFF_MS: u64 = 300_000;

/// How often to re-log an unchanged, repeating failure at `warn`.
///
/// The first failure and every tenth after it are loud; the rest drop to
/// `debug`. Without this the same two lines repeat forever and bury everything
/// else in the log.
const REPEAT_LOG_EVERY: usize = 10;

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
    pub room_descriptor: RoomDescriptor,
    pub signaling_key_ref: String,
    pub signing_private_key: String,
    pub device_id: String,
    /// ICE servers used by the desktop peer. STUN and optional TURN.
    pub ice_servers: Vec<RTCIceServer>,
    /// Handle the task uses to push its current [`DeviceTier`] into the
    /// hub's shared snapshot.
    pub tier_writer: TierWriter,
    /// Present for a one-shot pairing room (ADR-0170): the peer has no
    /// identity yet, so the only thing this session answers is `pair.http`
    /// over the relay data lane. No dispatcher, no DataChannel.
    pub pairing: Option<Arc<super::pairing::PairingRoom>>,
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
// Dispatcher lifetime
// ---------------------------------------------------------------------------

/// The dispatcher task plus the carrier it writes to.
///
/// Dropping the guard (the session loop unwound: cancel, socket error, peer
/// left) closes the relay half of the carrier at once. Whether the task
/// itself is aborted depends on what is left for it to write to: a live
/// DataChannel outlives the signaling socket by design (DTLS does not need
/// the rendezvous once ICE is done), so a peer that still holds one keeps
/// its dispatcher, and only a relay-only peer loses it. Without that check a
/// relay-only dispatcher would sit forever forwarding events into a closed
/// queue, one warning per frame.
struct DispatcherGuard {
    carrier: Arc<DataCarrier>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl DispatcherGuard {
    fn new(carrier: Arc<DataCarrier>, task: tokio::task::JoinHandle<()>) -> Self {
        Self {
            carrier,
            task: Some(task),
        }
    }

    /// Stop the task unconditionally (the peer is gone for good).
    fn abort(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Drop for DispatcherGuard {
    fn drop(&mut self) {
        self.carrier.set_relay_open(false);
        let Some(task) = self.task.take() else { return };
        let carrier = Arc::clone(&self.carrier);
        tokio::spawn(async move {
            if !carrier.is_open().await {
                task.abort();
            }
        });
    }
}

/// Everything the session loop keeps per authenticated mobile peer. Bundled
/// so the `select!` arms and `handle_relay` share one name for one thing.
#[derive(Default)]
struct PeerState {
    peer_session: Option<Arc<PeerSession>>,
    peer_ice_rx: Option<mpsc::Receiver<RTCIceCandidateInit>>,
    peer_state_rx: Option<mpsc::Receiver<RTCPeerConnectionState>>,
    dispatcher: Option<DispatcherGuard>,
    /// Present once the peer announced `relay: true` in its `hello`. The
    /// carrier is shared with the dispatcher; the two channels are this
    /// task's ends of the relay path (frames out to be sealed, decrypted
    /// bytes in to the dispatcher's reassembler).
    carrier: Option<Arc<DataCarrier>>,
    relay_out_rx: Option<mpsc::Receiver<RelayFrame>>,
    relay_data_tx: Option<mpsc::Sender<Vec<u8>>>,
    pending_remote_ice: PendingRemoteIce,
}

impl PeerState {
    fn relay_active(&self) -> bool {
        self.carrier.as_ref().is_some_and(|c| c.relay_open())
    }

    /// Drop the WebRTC half only. In relay mode the dispatcher lives on and
    /// the carrier falls back to the data lane; without a relay this is a
    /// full teardown.
    async fn drop_peer(&mut self, device_id: &str) {
        self.peer_ice_rx = None;
        self.peer_state_rx = None;
        self.pending_remote_ice.clear();
        if let Some(carrier) = self.carrier.as_ref().filter(|c| c.relay_open()) {
            carrier.detach_peer().await;
            if let Some(peer) = self.peer_session.take() {
                peer.close().await;
            }
            log::info!(
                "signaling::client[{device_id}]: DataChannel gone, continuing over the relay"
            );
        } else {
            self.teardown_all(device_id).await;
        }
    }

    /// The peer is gone: stop the dispatcher, close the peer, forget the
    /// relay path, and release every per-device lease that assumed presence.
    async fn teardown_all(&mut self, device_id: &str) {
        crate::companion_api::admin_lease::revoke_device(device_id);
        crate::companion_api::host_consent::forget_device(device_id);
        self.peer_ice_rx = None;
        self.peer_state_rx = None;
        self.pending_remote_ice.clear();
        if let Some(carrier) = self.carrier.take() {
            carrier.set_relay_open(false);
            carrier.detach_peer().await;
        }
        self.relay_out_rx = None;
        self.relay_data_tx = None;
        if let Some(guard) = self.dispatcher.take() {
            guard.abort();
        }
        if let Some(peer) = self.peer_session.take() {
            peer.close().await;
        }
    }
}

/// Decrypted body of a `data` envelope: one physical frame for the
/// DataChannel reassembler, carried as text or base64 binary.
#[derive(Debug, serde::Deserialize)]
struct DataBody {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    b64: Option<String>,
}

impl DataBody {
    fn into_bytes(self) -> Result<Vec<u8>, SessionError> {
        if let Some(text) = self.text {
            return Ok(text.into_bytes());
        }
        if let Some(b64) = self.b64 {
            return URL_SAFE_NO_PAD
                .decode(b64.as_bytes())
                .map_err(|e| SessionError::Protocol(format!("data envelope base64: {e}")));
        }
        Err(SessionError::Protocol(
            "data envelope carried neither text nor b64".into(),
        ))
    }
}

fn relay_frame_body(frame: RelayFrame) -> Value {
    match frame {
        RelayFrame::Text(bytes) => json!({ "text": String::from_utf8_lossy(&bytes) }),
        RelayFrame::Binary(bytes) => json!({ "b64": URL_SAFE_NO_PAD.encode(bytes) }),
    }
}

/// Whether a peer's `hello` opted into the relay data lane.
fn hello_wants_relay(body: &Value) -> bool {
    body.get("relay").and_then(Value::as_bool).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Reconnect loop
// ---------------------------------------------------------------------------

/// Whether the relay answered and refused, as opposed to being unreachable.
///
/// `tokio-tungstenite` renders a rejected upgrade as `HTTP error: <status>`, so
/// the status is the only thing to go on. 4xx means the endpoint exists and has
/// decided against us — a wrong path, a relay that is not a relay, a revoked
/// device — none of which a faster retry fixes. 5xx and transport errors stay on
/// the normal schedule because those genuinely do clear on their own.
fn is_permanent_rejection(message: &str) -> bool {
    let Some(rest) = message.split("HTTP error: ").nth(1) else {
        return false;
    };
    rest.split_whitespace()
        .next()
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|status| (400..500).contains(&status))
}

/// Delay before reconnect attempt `attempt`, in milliseconds.
///
/// **Equal jitter**, not full jitter. The previous implementation computed
/// `random(1, base)`, which spreads a herd but leaves the *minimum* delay at one
/// millisecond no matter how many times the connection has failed — so against a
/// relay that always refuses, roughly one attempt in thirty fired within a
/// second and the loop never actually calmed down. Halving the base and
/// jittering the other half keeps the anti-herd spread while making the floor
/// grow with the attempt count, which is the property a retry schedule is for.
///
/// `random_unit` is the caller's raw entropy, taken as a parameter so the
/// schedule is a pure function and can be pinned by tests.
fn reconnect_delay_ms(attempt: usize, rejected: bool, random_unit: u64) -> u64 {
    let base = if rejected {
        REJECTED_BACKOFF_MS
    } else {
        BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)]
    };
    let half = base / 2;
    half + (random_unit % half.max(1))
}

/// How one failed session should be surfaced.
///
/// Split out of the reconnect loop so the log level is a pure function of
/// (was this a refusal, how long did the socket live) and can be pinned by a
/// test instead of being read out of a running task's output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionFailure {
    /// The socket stayed up past [`HEALTHY_RESET_AFTER`] and then broke.
    ///
    /// This is the expected cost of a WAN long-connection, not a fault: the
    /// relay sits behind an edge that resets sockets periodically, and the
    /// client is back within seconds. With one socket per paired device that
    /// reset rate is multiplied by the device count, so warning on each one
    /// buries every real failure. The loop counts them and speaks up only
    /// once per [`REPEAT_LOG_EVERY`] of them.
    ///
    /// The counter is cleared by a clean close or by any [`Self::CannotConnect`],
    /// and by nothing else: a session that reconnects and stays up for hours
    /// still ends in this arm when it finally breaks. So the tally spans the
    /// whole run since the last connect failure, and the log line says that
    /// rather than calling drops an hour apart consecutive.
    DroppedAfterHealthy,
    /// The attempt never reached a healthy session: an ongoing failure that
    /// keeps the device offline, and worth the existing loud-then-quiet
    /// treatment. A refusal (4xx) always lands here — a relay that answers
    /// "no" is a configuration problem no amount of uptime excuses.
    CannotConnect,
}

fn classify_failure(rejected: bool, session_lifetime: Duration) -> SessionFailure {
    if !rejected && session_lifetime >= HEALTHY_RESET_AFTER {
        SessionFailure::DroppedAfterHealthy
    } else {
        SessionFailure::CannotConnect
    }
}

async fn run_with_reconnect(
    config: ClientConfig,
    state: SharedState,
    mut cancel_rx: watch::Receiver<bool>,
) {
    if validate_room_descriptor(&config.room_descriptor, now_ms()).is_err()
        || config.room_descriptor.room_id != config.rendezvous_id
    {
        log::error!(
            "signaling::client[{}]: invalid signaling room descriptor",
            config.device_id
        );
        config
            .tier_writer
            .set_with_error(DeviceTier::Failed, "invalid signaling room descriptor");
        return;
    }

    let mut attempt = 0usize;
    // The last failure text, so an unchanged one can be logged quietly. See
    // REPEAT_LOG_EVERY.
    let mut last_error: Option<String> = None;
    let mut repeats = 0usize;
    // [`SessionFailure::DroppedAfterHealthy`] events since the last connect
    // failure or clean close. Not a consecutive-failure count: healthy sessions
    // in between do not clear it, because a session only leaves this loop
    // through the error arm when it breaks.
    let mut healthy_drops = 0usize;
    // The endpoint is announced once per task, not once per attempt: the URL
    // never changes within a task's life, so re-stating it at `info` on every
    // reconnect is pure repetition across every paired device at once.
    let mut announced_endpoint = false;
    loop {
        if *cancel_rx.borrow() {
            return;
        }
        let label = format!(
            "device {} (room {})",
            config.device_id, config.rendezvous_id
        );
        if !announced_endpoint {
            log::info!(
                "signaling::client[{label}]: connecting to {}",
                config.signaling_url
            );
            announced_endpoint = true;
        } else {
            log::debug!(
                "signaling::client[{label}]: reconnecting to {} (attempt {attempt})",
                config.signaling_url
            );
        }
        // Each attempt begins from `Offline` — the moment the WSS connection
        // is `subscribed` we'll bump to `Awaiting`.
        config.tier_writer.set(DeviceTier::Offline);
        let session_started = Instant::now();
        let mut rejected = false;
        match run_one_session(&config, state.clone(), cancel_rx.clone()).await {
            Ok(()) => {
                log::info!("signaling::client[{label}]: session ended cleanly");
                attempt = 0;
                last_error = None;
                repeats = 0;
                healthy_drops = 0;
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
                let text = e.to_string();
                rejected = is_permanent_rejection(&text);
                match classify_failure(rejected, session_started.elapsed()) {
                    SessionFailure::DroppedAfterHealthy => {
                        healthy_drops = healthy_drops.saturating_add(1);
                        // An established socket that broke is not evidence of a
                        // *repeating* fault, so clear the consecutive-failure
                        // state: if the redial then fails, that failure is the
                        // first of its own cycle and gets reported loudly.
                        repeats = 0;
                        last_error = None;
                        if healthy_drops.is_multiple_of(REPEAT_LOG_EVERY) {
                            log::warn!(
                                "signaling::client[{label}]: lost an established signaling \
                                 socket {healthy_drops} times since the last connect failure, \
                                 most recently: {text}"
                            );
                        } else {
                            log::debug!(
                                "signaling::client[{label}]: signaling socket dropped, \
                                 reconnecting: {text}"
                            );
                        }
                    }
                    SessionFailure::CannotConnect => {
                        healthy_drops = 0;
                        if last_error.as_deref() == Some(text.as_str()) {
                            repeats = repeats.saturating_add(1);
                        } else {
                            repeats = 0;
                        }
                        if repeats.is_multiple_of(REPEAT_LOG_EVERY) {
                            if rejected {
                                log::warn!(
                                    "signaling::client[{label}]: relay refused the connection \
                                     ({text}); check the signaling URL, or turn the WebRTC tier \
                                     off in Settings → Companion if this Host does not need WAN \
                                     fallback"
                                );
                            } else {
                                log::warn!("signaling::client[{label}]: session error: {text}");
                            }
                        } else {
                            log::debug!("signaling::client[{label}]: session error: {text}");
                        }
                        last_error = Some(text.clone());
                    }
                }
                config.tier_writer.set_with_error(DeviceTier::Failed, text);
                if session_started.elapsed() >= HEALTHY_RESET_AFTER {
                    attempt = 0;
                }
                attempt = attempt.saturating_add(1);
            }
        }
        let delay =
            Duration::from_millis(reconnect_delay_ms(attempt, rejected, rand::random::<u64>()));
        tokio::select! {
            biased;
            // Same primitive for the same reason: `changed()` answers a dropped
            // sender with `Err` at once, which would skip the backoff entirely
            // and turn a hub that is gone into an undelayed reconnect loop
            // against the relay.
            () = wait_for_cancel(&mut cancel_rx) => return,
            _ = tokio::time::sleep(delay) => {}
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
    proof: SubscribeProof,
    inbound_key: [u8; 32],
    outbound_key: [u8; 32],
}

struct SessionCrypto {
    identity: SignalingIdentity,
    ephemeral: EphemeralKey,
    own_proof: SubscribeProof,
    peer: Option<PeerCrypto>,
    replay: StrictReplayWindow,
}

impl SessionCrypto {
    fn accept_peer(
        &mut self,
        descriptor: &RoomDescriptor,
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
            .map_err(envelope_err)?;
        let outbound_key = self
            .ephemeral
            .derive_direction_key(
                &snapshot.proof.ecdh_public_key,
                &descriptor.room_id,
                PeerRole::Desktop,
                &self.own_proof.epoch,
            )
            .map_err(envelope_err)?;
        self.peer = Some(PeerCrypto {
            proof: snapshot.proof.clone(),
            inbound_key,
            outbound_key,
        });
        self.replay = StrictReplayWindow::default();
        Ok(())
    }

    fn build_outbound(
        &self,
        room_id: &str,
        seq: u64,
        kind: EnvelopeKind,
        body: &Value,
    ) -> Result<SignalingEnvelope, SessionError> {
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
        .map_err(envelope_err)
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

/// Await `fut`, unwinding with [`SessionError::Cancelled`] the moment the hub
/// asks this client to stop.
///
/// The handshake — dial, read the challenge, send `Subscribe` — runs *before*
/// the session's `select!` loop, which used to be the only place the cancel
/// flag was ever observed. That left a cancelled client blind for up to 13 s
/// (8 s connect + 5 s challenge), and [`SignalingHub::configure`] cancels and
/// re-spawns every device in the same breath: the old socket could finish
/// subscribing *after* its replacement, take the room's desktop role back, and
/// get the new socket closed with `session_replaced` — costing the replacement
/// another full reconnect for nothing.
///
/// [`wait_for_cancel`] also inspects the *current* value, so a flag that was
/// already set before this call short-circuits before the socket is dialed at
/// all, and a channel whose sender is gone unwinds the same way.
async fn cancellable<T>(
    cancel_rx: &mut watch::Receiver<bool>,
    fut: impl std::future::Future<Output = T>,
) -> Result<T, SessionError> {
    tokio::pin!(fut);
    tokio::select! {
        biased;
        () = wait_for_cancel(cancel_rx) => Err(SessionError::Cancelled),
        out = &mut fut => Ok(out),
    }
}

/// Resolve once this client must stop: the hub raised the cancel flag, or the
/// hub itself is gone.
///
/// [`watch::Receiver::changed`] is the wrong primitive for a cancel arm. Once
/// the sender is dropped it returns `Err(RecvError)` immediately, and on every
/// later poll. An arm that unwinds only on a raised flag therefore re-arms
/// forever, and as the first arm under `biased;` the enclosing `select!` stops
/// yielding at all: a 100% CPU spin where an unwind was intended.
///
/// A dropped sender is reachable, not hypothetical. The sender lives on the
/// [`ClientHandle`], whose contract is "drop the handle to keep the task
/// running", and `SignalingHub::cancel_one` defers the send to a *spawned*
/// task, so a runtime that shuts down before that task is polled drops the
/// sender with nothing ever sent.
///
/// `wait_for` covers both: it resolves when the predicate holds *and* when the
/// channel closes, and it inspects the current value before waiting, so a flag
/// raised before the first poll short-circuits. Its `Ref` borrows the channel's
/// lock, so this returns `()` instead and no caller can hold that guard across
/// an `.await`.
async fn wait_for_cancel(cancel_rx: &mut watch::Receiver<bool>) {
    let _ = cancel_rx.wait_for(|cancelled| *cancelled).await;
}

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
    let (mut ws_stream, _resp) = cancellable(
        &mut cancel_rx,
        tokio::time::timeout(Duration::from_secs(8), connect_async(request)),
    )
    .await?
    .map_err(|_| SessionError::Websocket("signaling connect timed out".into()))?
    .map_err(|e| SessionError::Websocket(e.to_string()))?;
    let challenge_frame = cancellable(
        &mut cancel_rx,
        tokio::time::timeout(Duration::from_secs(5), ws_stream.next()),
    )
    .await?
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
                    "expected a live signaling challenge".into(),
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
    let identity = SignalingIdentity::from_private_bytes(&private_bytes).map_err(envelope_err)?;
    if identity.public_key_base64() != config.room_descriptor.desktop_signing_key {
        return Err(SessionError::Protocol(
            "desktop signing key does not match the room descriptor".into(),
        ));
    }
    let ephemeral = EphemeralKey::generate();
    let own_proof = build_subscribe_proof(
        &config.room_descriptor,
        PeerRole::Desktop,
        fresh_id(),
        fresh_id(),
        now_ms(),
        challenge,
        &ephemeral,
        &identity,
    );
    let subscribe = ClientFrame::Subscribe {
        descriptor: Box::new(config.room_descriptor.clone()),
        proof: Box::new(own_proof.clone()),
    };
    cancellable(
        &mut cancel_rx,
        ws_stream.send(Message::Text(
            serde_json::to_string(&subscribe)
                .expect("serialize subscribe")
                .into(),
        )),
    )
    .await?
    .map_err(|e| SessionError::Websocket(e.to_string()))?;
    let (mut write, mut read) = ws_stream.split();
    let mut crypto = SessionCrypto {
        identity,
        ephemeral,
        own_proof,
        peer: None,
        replay: StrictReplayWindow::default(),
    };

    // Outbound queue → any task that wants to push a frame to the WSS sink
    // sends through here. Bounded so a runaway producer can't OOM us.
    let (out_tx, mut out_rx) = mpsc::channel::<String>(64);

    // Per-peer state: recreated each time a fresh PeerSession is built
    // (i.e., each new offer) and, in relay mode, from the peer's `hello`.
    let mut ps = PeerState::default();

    // Outbound envelope sequence counter (sender = "desktop").
    let mut next_seq: u64 = 1;
    let mut keepalive = tokio::time::interval(Duration::from_secs(20));
    keepalive.tick().await; // skip the immediate first tick
    let mut subscribe_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(5));
    let mut pong_deadline: Option<tokio::time::Instant> = None;

    loop {
        // Helpers for `select!` — extract receivers that may be `None` and
        // gate the branch on `Option::is_some()` via `if let`.
        let ice_branch = ps.peer_ice_rx.as_mut();
        let state_branch = ps.peer_state_rx.as_mut();
        let relay_branch = ps.relay_out_rx.as_mut();

        tokio::select! {
            biased;

            () = wait_for_cancel(&mut cancel_rx) => {
                ps.teardown_all(&config.device_id).await;
                return Err(SessionError::Cancelled);
            }

            // ADR-0170: a frame the dispatcher could not put on a DataChannel.
            // Seal it into a `data` envelope on the relay's data lane.
            Some(frame) = async {
                match relay_branch {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                let body = relay_frame_body(frame);
                let env = crypto.build_outbound(
                    &config.rendezvous_id,
                    next_seq,
                    EnvelopeKind::Data,
                    &body,
                )?;
                next_seq += 1;
                push_relay(&out_tx, &config.rendezvous_id, &env, RelayLane::Data).await?;
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
                push_relay(&out_tx, &config.rendezvous_id, &env, RelayLane::Signal).await?;
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
                        let relayed = ps.relay_active();
                        ps.drop_peer(&config.device_id).await;
                        // Mobile peer dropped; we're still subscribed and
                        // either serving it over the relay or awaiting a
                        // fresh offer.
                        config.tier_writer.set(if relayed {
                            DeviceTier::Relayed
                        } else {
                            DeviceTier::Awaiting
                        });
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
                                        ps.teardown_all(&config.device_id).await;
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
                                crypto.replay = StrictReplayWindow::default();
                                // Mobile dropped — tear down our peer too.
                                ps.teardown_all(&config.device_id).await;
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
                                    &mut ps,
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
    envelope: &SignalingEnvelope,
    lane: RelayLane,
) -> Result<(), SessionError> {
    let payload =
        serde_json::to_string(envelope).map_err(|e| SessionError::Protocol(e.to_string()))?;
    let frame = ClientFrame::Relay {
        rendezvous_id: rendezvous_id.to_string(),
        payload,
        lane,
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
    SessionError::Protocol(format!("signaling envelope: {e}"))
}

fn fresh_id() -> String {
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decrypt the inbound relay payload, verify signature + replay, and dispatch by
/// envelope kind. May create a new `PeerSession` (on first `rtc:offer`), open
/// the relay data lane (on a `hello` that asks for it), or tear down an
/// existing peer (on `rtc:close`).
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
    ps: &mut PeerState,
) -> Result<(), SessionError> {
    let envelope: SignalingEnvelope = serde_json::from_str(payload)
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
                "signaling::client[{}]: rejected envelope: {error}",
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

    if let Some(room) = config.pairing.as_ref() {
        return handle_pairing_envelope(
            room,
            envelope.kind,
            body,
            config,
            state,
            out_tx,
            next_seq,
            crypto,
        )
        .await;
    }

    match envelope.kind {
        EnvelopeKind::Hello => {
            log::debug!(
                "signaling::client[{}]: hello from {}",
                config.device_id,
                from_role.as_str()
            );
            if hello_wants_relay(&body) {
                open_relay_lane(config, state, ps);
                // Answer so the peer knows the lane is live on this end. A
                // Host built before the lane never replies, and the peer
                // then waits for the DataChannel exactly as before.
                let reply = crypto.build_outbound(
                    &config.rendezvous_id,
                    *next_seq,
                    EnvelopeKind::Hello,
                    &json!({ "deviceId": "host", "relay": true }),
                )?;
                *next_seq += 1;
                push_relay(out_tx, &config.rendezvous_id, &reply, RelayLane::Signal).await?;
                if ps.peer_session.is_none() {
                    config.tier_writer.set(DeviceTier::Relayed);
                }
            }
        }
        EnvelopeKind::Data => {
            let Some(data_tx) = ps.relay_data_tx.as_ref() else {
                log::warn!(
                    "signaling::client[{}]: data envelope before the relay lane was opened",
                    config.device_id
                );
                return Ok(());
            };
            let bytes = serde_json::from_value::<DataBody>(body)
                .map_err(|e| SessionError::Protocol(format!("data envelope: {e}")))?
                .into_bytes()?;
            if data_tx.send(bytes).await.is_err() {
                log::warn!(
                    "signaling::client[{}]: dispatcher is gone; dropping relayed frame",
                    config.device_id
                );
            }
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

            if should_reuse_peer_for_offer(ice_restart, ps.peer_session.is_some()) {
                // True ICE restart: renegotiate on the EXISTING peer so DTLS,
                // the data channel, and the dispatcher all survive — only ICE
                // re-gathers. `accept_offer` (set_remote_description +
                // create_answer + set_local_description) on the live PC
                // produces an answer carrying fresh ICE credentials; the
                // peer's existing event handler keeps relaying new ICE
                // candidates. Mirrors the mobile `attemptIceRestart` path in
                // `lib/tauri/transport-rtc.ts`.
                let existing = ps
                    .peer_session
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
                push_relay(out_tx, &config.rendezvous_id, &answer, RelayLane::Signal).await?;
            } else {
                // First offer (or a non-restart re-offer): build a fresh peer.
                // A prior peer, if any, is dropped below.
                let (ice_tx, ice_rx) = mpsc::channel(ICE_QUEUE_CAPACITY);
                let (state_tx, state_rx) = mpsc::channel(STATE_QUEUE_CAPACITY);
                // In relay mode the DataChannel feeds the dispatcher that the
                // `hello` already spawned, through the same inbound queue the
                // relay lane uses. Otherwise a fresh queue + dispatcher pair
                // is created for this peer, exactly as before the relay.
                let (data_tx, fresh_data_rx) = match ps.relay_data_tx.clone() {
                    Some(tx) => (tx, None),
                    None => {
                        let (tx, rx) = mpsc::channel(INBOUND_FRAME_QUEUE_CAPACITY);
                        (tx, Some(rx))
                    }
                };
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
                for candidate in ps.pending_remote_ice.drain() {
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
                push_relay(out_tx, &config.rendezvous_id, &answer, RelayLane::Signal).await?;

                // Retire the previous peer (the dispatcher survives in relay
                // mode and is replaced otherwise).
                if let Some(old) = ps.peer_session.take() {
                    old.close().await;
                }
                ps.peer_ice_rx = Some(ice_rx);
                ps.peer_state_rx = Some(state_rx);

                match (ps.carrier.clone(), fresh_data_rx) {
                    (Some(carrier), None) => {
                        // Relay mode: the running dispatcher now has a
                        // DataChannel to prefer.
                        carrier.attach_peer(Arc::clone(&new_peer)).await;
                    }
                    (_, Some(data_rx)) => {
                        // DataChannel-only peer: dispatcher per peer, as before.
                        // Wrapping in tokio::spawn means the rest of the
                        // session loop continues to drive ICE / outbound while
                        // the DC is still negotiating.
                        let carrier = DataCarrier::datachannel_only(Arc::clone(&new_peer));
                        let handle = spawn_dispatcher(
                            Arc::clone(&carrier),
                            data_rx,
                            state.clone(),
                            config.device_id.clone(),
                        );
                        if let Some(old) = ps.dispatcher.take() {
                            old.abort();
                        }
                        ps.dispatcher = Some(DispatcherGuard::new(carrier, handle));
                    }
                    (None, None) => unreachable!("relay_data_tx implies a carrier"),
                }
                ps.peer_session = Some(new_peer);
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
            if let Some(peer) = ps.peer_session.as_ref() {
                if let Err(e) = peer.add_remote_ice(init).await {
                    log::warn!(
                        "signaling::client[{}]: addRemoteIce failed: {e}",
                        config.device_id
                    );
                }
            } else {
                ps.pending_remote_ice.push(init)?;
            }
        }
        EnvelopeKind::RtcClose => {
            log::info!(
                "signaling::client[{}]: peer requested rtc:close",
                config.device_id
            );
            let relayed = ps.relay_active();
            ps.drop_peer(&config.device_id).await;
            // Mobile cleanly closed its WebRTC half. Over a relay it is still
            // here; otherwise we're back to waiting for the next offer.
            config.tier_writer.set(if relayed {
                DeviceTier::Relayed
            } else {
                DeviceTier::Awaiting
            });
        }
    }
    Ok(())
}

/// A pairing room's whole protocol: answer `hello` so the peer opens its
/// relay lane, then serve `pair.http` requests through the Host's router.
/// Everything else (offers, ICE, arbitrary RPC) is ignored: nothing here has
/// a device identity to act on.
#[allow(clippy::too_many_arguments)]
async fn handle_pairing_envelope(
    room: &super::pairing::PairingRoom,
    kind: EnvelopeKind,
    body: Value,
    config: &ClientConfig,
    state: &SharedState,
    out_tx: &mpsc::Sender<String>,
    next_seq: &mut u64,
    crypto: &mut SessionCrypto,
) -> Result<(), SessionError> {
    use super::dispatch::{ErrorBody, InboundRpc, OutboundFrame, ResponseFrame};
    use super::pairing::{self, PairHttpRequest, PAIR_HTTP_METHOD};

    match kind {
        EnvelopeKind::Hello => {
            if !hello_wants_relay(&body) {
                return Ok(());
            }
            let reply = crypto.build_outbound(
                &config.rendezvous_id,
                *next_seq,
                EnvelopeKind::Hello,
                &json!({ "deviceId": "host", "relay": true }),
            )?;
            *next_seq += 1;
            push_relay(out_tx, &config.rendezvous_id, &reply, RelayLane::Signal).await
        }
        EnvelopeKind::Data => {
            let bytes = serde_json::from_value::<DataBody>(body)
                .map_err(|e| SessionError::Protocol(format!("data envelope: {e}")))?
                .into_bytes()?;
            // Pairing requests are small, so a frame is a whole message. A
            // chunked one is refused rather than reassembled: there is no
            // legitimate multi-frame pairing request.
            let Ok(rpc) = serde_json::from_slice::<InboundRpc>(&bytes) else {
                log::debug!(
                    "signaling::client[{}]: ignoring non-RPC frame in a pairing room",
                    config.device_id
                );
                return Ok(());
            };
            let response = if rpc.method != PAIR_HTTP_METHOD {
                ResponseFrame {
                    id: rpc.id,
                    ok: false,
                    result: None,
                    error: Some(ErrorBody {
                        code: "pair_method_only".into(),
                        message: "a pairing room only answers pair.http".into(),
                    }),
                }
            } else {
                match serde_json::from_value::<PairHttpRequest>(rpc.params) {
                    Err(error) => ResponseFrame {
                        id: rpc.id,
                        ok: false,
                        result: None,
                        error: Some(ErrorBody {
                            code: "pair_invalid_request".into(),
                            message: error.to_string(),
                        }),
                    },
                    Ok(request) => match pairing::admit(&request, room.expires_at_ms, now_ms()) {
                        Err(refusal) => ResponseFrame {
                            id: rpc.id,
                            ok: false,
                            result: None,
                            error: Some(ErrorBody {
                                code: refusal.code().into(),
                                message: "pairing request refused".into(),
                            }),
                        },
                        Ok(()) => match pairing::answer(room, state, request, "127.0.0.1").await {
                            Ok(answer) => ResponseFrame {
                                id: rpc.id,
                                ok: true,
                                result: Some(serde_json::to_value(answer).unwrap_or(Value::Null)),
                                error: None,
                            },
                            Err(error) => ResponseFrame {
                                id: rpc.id,
                                ok: false,
                                result: None,
                                error: Some(ErrorBody {
                                    code: "pair_router_failed".into(),
                                    message: error,
                                }),
                            },
                        },
                    },
                }
            };
            let frame = OutboundFrame::Response(response);
            let bytes = serde_json::to_vec(&frame).map_err(|e| SessionError::Protocol(e.to_string()))?;
            let message_id = uuid::Uuid::new_v4().to_string();
            let frames = super::datachannel_framing::encode_message(&bytes, &message_id)
                .map_err(|e| SessionError::Protocol(e.to_string()))?;
            for frame in frames {
                let env = crypto.build_outbound(
                    &config.rendezvous_id,
                    *next_seq,
                    EnvelopeKind::Data,
                    &relay_frame_body(RelayFrame::Text(frame)),
                )?;
                *next_seq += 1;
                push_relay(out_tx, &config.rendezvous_id, &env, RelayLane::Data).await?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Open the relay data lane for the authenticated peer: one carrier, one
/// dispatcher, and this task's two ends of the relay path. Idempotent for a
/// peer that says `hello` twice (a signaling reconnect re-sends it).
fn open_relay_lane(config: &ClientConfig, state: &SharedState, ps: &mut PeerState) {
    if let Some(carrier) = ps.carrier.as_ref() {
        carrier.set_relay_open(true);
        return;
    }
    let (relay_tx, relay_rx) = mpsc::channel(RELAY_OUTBOUND_QUEUE);
    let (data_tx, data_rx) = mpsc::channel(INBOUND_FRAME_QUEUE_CAPACITY);
    let carrier = DataCarrier::with_relay(relay_tx);
    let handle = spawn_dispatcher(
        Arc::clone(&carrier),
        data_rx,
        state.clone(),
        config.device_id.clone(),
    );
    if let Some(old) = ps.dispatcher.take() {
        old.abort();
    }
    ps.dispatcher = Some(DispatcherGuard::new(Arc::clone(&carrier), handle));
    ps.carrier = Some(carrier);
    ps.relay_out_rx = Some(relay_rx);
    ps.relay_data_tx = Some(data_tx);
    log::info!(
        "signaling::client[{}]: relay data lane open",
        config.device_id
    );
}

#[cfg(test)]
mod tests {
    #[test]
    fn reconnect_delay_never_drops_below_half_the_schedule() {
        // The bug this pins: the old `random(1, base)` jitter let the *minimum*
        // delay stay at 1 ms however many times the connection had failed, so a
        // relay that always refuses was retried in a tight, never-calming loop.
        for attempt in 1..=8usize {
            let base = BACKOFF_MS[(attempt).min(BACKOFF_MS.len() - 1)];
            for entropy in [0u64, 1, u64::MAX / 2, u64::MAX] {
                let delay = reconnect_delay_ms(attempt, false, entropy);
                assert!(
                    delay >= base / 2,
                    "attempt {attempt} entropy {entropy}: {delay}ms < floor {}ms",
                    base / 2
                );
                assert!(
                    delay < base,
                    "attempt {attempt}: {delay}ms >= base {base}ms"
                );
            }
        }
    }

    #[test]
    fn reconnect_delay_still_spreads_within_its_window() {
        // Equal jitter, not a fixed delay — two different entropy values must
        // land on different delays or the anti-thundering-herd property is gone.
        let low = reconnect_delay_ms(3, false, 0);
        let high = reconnect_delay_ms(3, false, BACKOFF_MS[3] / 2 - 1);
        assert!(high > low, "expected spread, got {low}ms and {high}ms");
    }

    #[test]
    fn reconnect_delay_grows_with_the_attempt_count() {
        let first = reconnect_delay_ms(1, false, 0);
        let last = reconnect_delay_ms(BACKOFF_MS.len() + 5, false, 0);
        assert!(last > first, "{last}ms should exceed {first}ms");
        assert_eq!(last, BACKOFF_MS[BACKOFF_MS.len() - 1] / 2);
    }

    #[test]
    fn a_refused_relay_backs_off_far_further_than_an_unreachable_one() {
        let refused = reconnect_delay_ms(1, true, 0);
        let unreachable = reconnect_delay_ms(1, false, 0);
        assert_eq!(refused, REJECTED_BACKOFF_MS / 2);
        assert!(refused > unreachable * 10);
    }

    #[test]
    fn only_a_4xx_handshake_counts_as_a_refusal() {
        // The exact text tokio-tungstenite produces for an undeployed relay.
        assert!(is_permanent_rejection(
            "websocket: HTTP error: 404 Not Found"
        ));
        assert!(is_permanent_rejection("websocket: HTTP error: 401"));
        assert!(is_permanent_rejection(
            "websocket: HTTP error: 403 Forbidden"
        ));
        // Transient: these do clear on their own, so they keep the fast schedule.
        assert!(!is_permanent_rejection(
            "websocket: HTTP error: 502 Bad Gateway"
        ));
        assert!(!is_permanent_rejection("websocket: HTTP error: 503"));
        assert!(!is_permanent_rejection(
            "websocket: signaling connect timed out"
        ));
        assert!(!is_permanent_rejection("websocket: stream ended"));
        assert!(!is_permanent_rejection("protocol: bad frame"));
    }

    use super::*;
    use crate::companion_api::{
        deny_list::DenyList, desktop_messages_bridge::DesktopMessagesBridge,
        desktop_writes_bridge::DesktopWritesBridge, event_bus::EventBus,
        idempotency::IdempotencyCache, push::PushTokenRegistry, rate_limit::RateLimiter,
        sync_bridge::SyncBridge, sync_registry::SyncTableRegistry, CompanionState,
    };
    use cognia_signaling_core::protocol::{derive_room_id, PROTOCOL_VERSION};
    use parking_lot::RwLock;

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
        )
        .unwrap();
        assert!(crate::companion_api::admin_lease::validate(
            "rtc-teardown-device",
            "external_bridge_start",
            Some(&lease.token),
        )
        .is_ok());

        let mut ps = PeerState::default();
        ps.teardown_all("rtc-teardown-device").await;

        assert!(crate::companion_api::admin_lease::validate(
            "rtc-teardown-device",
            "external_bridge_start",
            Some(&lease.token),
        )
        .is_err());
    }

    #[test]
    fn hello_relay_flag_is_read_from_the_body() {
        assert!(hello_wants_relay(&json!({ "deviceId": "d", "relay": true })));
        assert!(!hello_wants_relay(&json!({ "deviceId": "d" })));
        assert!(!hello_wants_relay(&json!({ "deviceId": "d", "relay": "yes" })));
    }

    #[test]
    fn data_body_round_trips_text_and_binary_frames() {
        let text = relay_frame_body(RelayFrame::Text(b"{\"id\":1}".to_vec()));
        let bytes = serde_json::from_value::<DataBody>(text)
            .unwrap()
            .into_bytes()
            .unwrap();
        assert_eq!(bytes, b"{\"id\":1}");
        let binary = relay_frame_body(RelayFrame::Binary(vec![0, 255, 7]));
        let bytes = serde_json::from_value::<DataBody>(binary)
            .unwrap()
            .into_bytes()
            .unwrap();
        assert_eq!(bytes, vec![0, 255, 7]);
        let empty = serde_json::from_value::<DataBody>(json!({})).unwrap();
        assert!(empty.into_bytes().is_err());
    }

    #[tokio::test]
    async fn dropping_the_peer_in_relay_mode_keeps_the_dispatcher() {
        let (relay_tx, _relay_rx) = mpsc::channel(RELAY_OUTBOUND_QUEUE);
        let carrier = DataCarrier::with_relay(relay_tx);
        let task = tokio::spawn(std::future::pending::<()>());
        let mut ps = PeerState {
            carrier: Some(Arc::clone(&carrier)),
            dispatcher: Some(DispatcherGuard::new(Arc::clone(&carrier), task)),
            ..PeerState::default()
        };
        assert!(ps.relay_active());
        ps.drop_peer("relay-device").await;
        assert!(ps.dispatcher.is_some(), "relay keeps serving without ICE");
        assert!(carrier.relay_open());
        ps.teardown_all("relay-device").await;
        assert!(ps.dispatcher.is_none());
        assert!(!carrier.relay_open());
    }

    #[test]
    fn an_established_socket_that_breaks_is_not_treated_as_a_fault() {
        assert_eq!(
            classify_failure(false, HEALTHY_RESET_AFTER),
            SessionFailure::DroppedAfterHealthy
        );
        assert_eq!(
            classify_failure(false, HEALTHY_RESET_AFTER + Duration::from_secs(600)),
            SessionFailure::DroppedAfterHealthy
        );
    }

    #[test]
    fn a_session_that_never_got_healthy_is_a_real_failure() {
        assert_eq!(
            classify_failure(false, Duration::from_secs(0)),
            SessionFailure::CannotConnect
        );
        assert_eq!(
            classify_failure(false, HEALTHY_RESET_AFTER - Duration::from_millis(1)),
            SessionFailure::CannotConnect
        );
    }

    #[test]
    fn a_refusal_stays_loud_however_long_the_socket_lived() {
        // A 4xx is a configuration problem; uptime does not excuse it, and the
        // operator needs the "check the signaling URL" line either way.
        assert_eq!(
            classify_failure(true, Duration::from_secs(0)),
            SessionFailure::CannotConnect
        );
        assert_eq!(
            classify_failure(true, HEALTHY_RESET_AFTER + Duration::from_secs(3_600)),
            SessionFailure::CannotConnect
        );
    }

    #[tokio::test]
    async fn cancellable_unwinds_a_flag_that_was_already_set() {
        // `configure` cancels and re-spawns in the same breath, so a client can
        // be cancelled before its first poll. It must not dial at all.
        let (tx, mut rx) = watch::channel(false);
        tx.send(true).unwrap();
        let result = cancellable(&mut rx, async {
            unreachable!("the operation must not be polled once cancel is set")
        })
        .await;
        assert!(matches!(result, Err(SessionError::Cancelled)));
    }

    #[tokio::test]
    async fn cancellable_unwinds_a_flag_raised_mid_handshake() {
        let (tx, mut rx) = watch::channel(false);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let _ = tx.send(true);
        });
        // Stands in for the 8 s connect: long enough that the old code would
        // have finished the handshake before ever looking at the flag.
        let result = cancellable(&mut rx, tokio::time::sleep(Duration::from_secs(30))).await;
        assert!(matches!(result, Err(SessionError::Cancelled)));
    }

    #[tokio::test]
    async fn cancellable_passes_the_value_through_when_no_cancel_arrives() {
        let (_tx, mut rx) = watch::channel(false);
        let result = cancellable(&mut rx, async { 7u8 }).await;
        assert!(matches!(result, Ok(7)));
    }

    #[tokio::test]
    async fn cancellable_treats_a_dropped_sender_as_a_cancel() {
        // The sender lives on the `ClientHandle`; if it is gone the hub is gone.
        let (tx, mut rx) = watch::channel(false);
        drop(tx);
        let result = cancellable(&mut rx, tokio::time::sleep(Duration::from_secs(30))).await;
        assert!(matches!(result, Err(SessionError::Cancelled)));
    }

    #[tokio::test]
    async fn wait_for_cancel_resolves_when_the_sender_is_dropped() {
        let (tx, mut rx) = watch::channel(false);
        drop(tx);
        tokio::time::timeout(Duration::from_secs(1), wait_for_cancel(&mut rx))
            .await
            .expect("a closed cancel channel must resolve the arm");
    }

    #[tokio::test]
    async fn wait_for_cancel_holds_while_the_channel_is_live_and_uncancelled() {
        // The other half of the contract: an arm that resolved on a *live*
        // channel would spin the session loop just as hard. A `false` write is
        // a change, and must still not unwind the session.
        let (tx, mut rx) = watch::channel(false);
        tx.send(false).expect("send");
        let waited =
            tokio::time::timeout(Duration::from_millis(50), wait_for_cancel(&mut rx)).await;
        assert!(
            waited.is_err(),
            "a live, uncancelled channel must not unwind the session"
        );
    }

    /// A signaling client config whose signing key matches its own room
    /// descriptor, pointed at `url`.
    fn test_client_config(url: &str, device_id: &str) -> ClientConfig {
        let identity = SignalingIdentity::generate();
        let mobile = SignalingIdentity::generate();
        let mut room_descriptor = RoomDescriptor {
            v: PROTOCOL_VERSION,
            room_id: String::new(),
            room_nonce: URL_SAFE_NO_PAD.encode([7u8; 16]),
            desktop_signing_key: identity.public_key_base64(),
            mobile_signing_key: mobile.public_key_base64(),
            not_after: now_ms() + 600_000,
        };
        room_descriptor.room_id = derive_room_id(&room_descriptor);
        let rendezvous_id = room_descriptor.room_id.clone();
        ClientConfig {
            pairing: None,
            signaling_url: url.to_string(),
            rendezvous_id: rendezvous_id.clone(),
            room_descriptor,
            signaling_key_ref: "test-key-ref".into(),
            signing_private_key: URL_SAFE_NO_PAD.encode(identity.private_bytes()),
            device_id: device_id.to_string(),
            ice_servers: Vec::new(),
            tier_writer: super::super::SignalingHub::new()
                .new_tier_writer(&rendezvous_id, device_id),
        }
    }

    fn test_shared_state() -> SharedState {
        Arc::new(CompanionState {
            secret: RwLock::new(vec![0u8; 32]),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: SyncBridge::new(),
            desktop_messages_bridge: DesktopMessagesBridge::new(),
            desktop_writes_bridge: DesktopWritesBridge::new(),
            sync_registry: SyncTableRegistry::with_defaults(),
            rate_limiter: RateLimiter::with_defaults(),
            push_tokens: PushTokenRegistry::new(),
        })
    }

    /// Minimal stand-in for the rendezvous relay: completes the WebSocket
    /// upgrade, issues a live challenge, and reports the moment the client's
    /// `Subscribe` lands. That frame is the last thing `run_one_session` sends
    /// before entering its `select!` loop, so the report is the signal that the
    /// loop, and nothing earlier, is what observes the cancel.
    async fn stub_relay() -> (String, tokio::sync::oneshot::Receiver<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub relay");
        // The path matters: `append_rid` only adds a query, so a pathless URL
        // would put `GET ?rid=... HTTP/1.1` on the wire and the upgrade would
        // be refused as an invalid request target. Real rendezvous URLs are
        // always `wss://host/signaling`.
        let url = format!(
            "ws://{}/signaling",
            listener.local_addr().expect("local addr")
        );
        let (subscribed_tx, subscribed_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut ws = tokio_tungstenite::accept_async(stream)
                .await
                .expect("websocket upgrade");
            let challenge = serde_json::to_string(&ServerFrame::Challenge {
                challenge: URL_SAFE_NO_PAD.encode([3u8; 32]),
                issued_at: now_ms(),
                expires_at: now_ms() + 60_000,
            })
            .expect("serialize challenge");
            ws.send(Message::Text(challenge.into()))
                .await
                .expect("send challenge");
            let mut subscribed_tx = Some(subscribed_tx);
            // Keep reading so the socket stays open: only the cancel should be
            // able to end this session.
            while let Some(Ok(frame)) = ws.next().await {
                if matches!(frame, Message::Text(_)) {
                    if let Some(tx) = subscribed_tx.take() {
                        let _ = tx.send(());
                    }
                }
            }
        });
        (url, subscribed_rx)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_cancel_sender_unwinds_the_session_loop() {
        // Every removal path today sends `true` before dropping, but that is
        // not what makes them safe: `ClientHandle` documents dropping without a
        // shutdown, and `cancel_one` defers the send to a spawned task, so a
        // runtime that shuts down first drops the sender with nothing sent.
        // With `changed()` in the loop's first `biased;` arm, a sender that is
        // gone answers `Err` on every poll and the session spins at 100% CPU
        // instead of unwinding.
        //
        // The session deliberately runs on its own thread and runtime rather
        // than `tokio::spawn`. A spinning task never reaches a yield point, so
        // it can be neither cancelled nor joined: dropping a runtime that owns
        // one blocks forever, and a regression would hang `cargo test` instead
        // of failing it. On a detached thread the spin cannot block this test's
        // runtime or the harness process, so the timeout below reports the
        // regression and the run moves on.
        let (url, subscribed) = stub_relay().await;
        let config = test_client_config(&url, "rtc-cancel-drop-device");
        let state = test_shared_state();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (outcome_tx, outcome_rx) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("session runtime");
            let outcome = runtime.block_on(run_one_session(&config, state, cancel_rx));
            let _ = outcome_tx.send(matches!(outcome, Err(SessionError::Cancelled)));
        });

        tokio::time::timeout(Duration::from_secs(5), subscribed)
            .await
            .expect("the client should subscribe within 5s")
            .expect("the relay should report the subscribe");

        drop(cancel_tx);

        let cancelled = tokio::time::timeout(Duration::from_secs(2), outcome_rx)
            .await
            .expect("a dropped cancel sender must unwind the session, not spin")
            .expect("the session thread should report an outcome");
        assert!(cancelled, "the session should unwind as `Cancelled`");
    }

    #[test]
    fn append_rid_adds_query_param() {
        assert_eq!(
            append_rid("wss://host/signaling", "r1"),
            "wss://host/signaling?rid=r1"
        );
    }

    #[test]
    fn append_rid_preserves_existing_query() {
        assert_eq!(
            append_rid("wss://host/signaling?x=1", "r1"),
            "wss://host/signaling?x=1&rid=r1"
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
            descriptor: Box::new(RoomDescriptor {
                v: 2,
                room_id: "r1".into(),
                room_nonce: "nonce".into(),
                desktop_signing_key: "desktop-key".into(),
                mobile_signing_key: "mobile-key".into(),
                not_after: 1_800_000_000_000,
            }),
            proof: Box::new(SubscribeProof {
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
