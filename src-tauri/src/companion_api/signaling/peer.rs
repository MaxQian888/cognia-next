//! WebRTC peer wrapper. ADR-0021.
//!
//! Builds one `webrtc::peer_connection::RTCPeerConnection` per active
//! mobile peer in a rendezvous room and bridges its lifecycle hooks
//! (`on_data_channel`, `on_ice_candidate`, `on_peer_connection_state_change`)
//! into tokio mpsc channels that the signaling client task consumes.
//!
//! Role split (matches `lib/tauri/transport-rtc.ts`):
//! - **mobile** is the offerer — it calls `pc.createDataChannel("cognia.v2", ...)`
//!   and produces the SDP offer.
//! - **desktop** (this file) is the answerer — it waits for the offer via
//!   signaling, calls `set_remote_description` + `create_answer` +
//!   `set_local_description`, and exposes the inbound DataChannel through
//!   the supplied `inbound_data_tx` channel.

use std::{future::Future, sync::Arc, time::Duration};

use bytes::Bytes;
use tokio::sync::{mpsc, Mutex, Notify, RwLock};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::data_channel_state::RTCDataChannelState;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

/// DataChannel label both peers agree on. Mirrored in
/// `lib/signaling/types.ts:DATACHANNEL_LABEL`.
pub const DATACHANNEL_LABEL: &str = "cognia.v2";
pub const TERMINAL_DATACHANNEL_LABEL: &str = "cognia.terminal";
pub const ICE_QUEUE_CAPACITY: usize = 256;
pub const INBOUND_FRAME_QUEUE_CAPACITY: usize = 128;
pub const STATE_QUEUE_CAPACITY: usize = 32;
const SEND_BUFFER_HIGH_WATER: usize = 1024 * 1024;
const SEND_BUFFER_LOW_WATER: usize = 256 * 1024;
const SEND_BACKPRESSURE_TIMEOUT: Duration = Duration::from_secs(15);

/// Wraps an `RTCPeerConnection` and its (single) data channel, fanning the
/// callback world out to plain mpsc channels for the signaling client to
/// consume.
pub struct PeerSession {
    pc: Arc<RTCPeerConnection>,
    dc: Arc<RwLock<Option<Arc<RTCDataChannel>>>>,
    /// Latched once the data channel opens — wakes `wait_for_open()`.
    open_tx: tokio::sync::watch::Sender<bool>,
    open_rx: tokio::sync::watch::Receiver<bool>,
    send_lock: Mutex<()>,
    send_capacity: Arc<Notify>,
}

/// Construction-time configuration for [`PeerSession`]. The mpsc senders
/// are owned by the signaling client task; the peer session drops its
/// clones when it tears down.
pub struct PeerCallbacks {
    /// Local ICE candidates discovered after `setLocalDescription`. The
    /// signaling client wraps each in a `rtc:ice` envelope and relays it
    /// to the mobile peer.
    pub outbound_ice: mpsc::Sender<RTCIceCandidateInit>,
    /// Inbound DataChannel binary messages (the RPC / event JSON
    /// envelopes from the mobile peer).
    pub inbound_data: mpsc::Sender<Vec<u8>>,
    /// Handler for the isolated canonical binary terminal channel.
    pub terminal_channel: Arc<dyn Fn(Arc<RTCDataChannel>) + Send + Sync>,
    /// `RTCPeerConnectionState` transitions for failure detection.
    pub state_change: mpsc::Sender<RTCPeerConnectionState>,
}

impl PeerSession {
    /// Build a new peer session bound to the given ICE configuration. The
    /// session is not connected yet — the caller must subsequently feed it
    /// an SDP offer via [`Self::accept_offer`].
    pub async fn new(
        ice_servers: Vec<RTCIceServer>,
        callbacks: PeerCallbacks,
    ) -> Result<Self, webrtc::Error> {
        // The WebRTC DTLS handshake builds a rustls config, which in rustls
        // 0.23 requires an explicit crypto provider when both `ring` and
        // `aws-lc-rs` are in the dep graph. Install one idempotently here so
        // peer connections work even when spawned outside `main.rs` (tests,
        // headless entry points).
        crate::companion_api::ensure_crypto_provider();

        let api = APIBuilder::new().build();
        let config = RTCConfiguration {
            ice_servers,
            ..Default::default()
        };
        let pc = Arc::new(api.new_peer_connection(config).await?);
        let dc: Arc<RwLock<Option<Arc<RTCDataChannel>>>> = Arc::new(RwLock::new(None));
        let (open_tx, open_rx) = tokio::sync::watch::channel(false);
        let send_capacity = Arc::new(Notify::new());

        // ── on_ice_candidate ───────────────────────────────────────────
        let ice_tx = callbacks.outbound_ice.clone();
        pc.on_ice_candidate(Box::new(move |candidate: Option<RTCIceCandidate>| {
            let ice_tx = ice_tx.clone();
            Box::pin(async move {
                if let Some(c) = candidate {
                    match c.to_json() {
                        Ok(init) => {
                            if ice_tx.try_send(init).is_err() {
                                log::warn!(
                                    "signaling::peer: ICE queue overflow or receiver closed"
                                );
                            }
                        }
                        Err(e) => {
                            log::warn!("signaling::peer: ice candidate to_json failed: {e}");
                        }
                    }
                }
            })
        }));

        // ── on_peer_connection_state_change ────────────────────────────
        let state_tx = callbacks.state_change.clone();
        pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
            let state_tx = state_tx.clone();
            Box::pin(async move {
                if state_tx.try_send(s).is_err() {
                    log::warn!("signaling::peer: state queue overflow or receiver closed");
                }
            })
        }));

        // ── on_data_channel ────────────────────────────────────────────
        let dc_slot = Arc::clone(&dc);
        let inbound_tx = callbacks.inbound_data.clone();
        let terminal_channel = Arc::clone(&callbacks.terminal_channel);
        let open_tx_dc = open_tx.clone();
        let send_capacity_dc = Arc::clone(&send_capacity);
        pc.on_data_channel(Box::new(move |channel: Arc<RTCDataChannel>| {
            let dc_slot = Arc::clone(&dc_slot);
            let inbound_tx = inbound_tx.clone();
            let terminal_channel = Arc::clone(&terminal_channel);
            let open_tx_dc = open_tx_dc.clone();
            let send_capacity_dc = Arc::clone(&send_capacity_dc);
            Box::pin(async move {
                if channel.label() == TERMINAL_DATACHANNEL_LABEL {
                    if !is_reliable_ordered_channel(
                        channel.ordered(),
                        channel.max_packet_lifetime(),
                        channel.max_retransmits(),
                    ) {
                        log::warn!(
                            "signaling::peer: rejecting unreliable terminal data channel"
                        );
                        let _ = channel.close().await;
                        return;
                    }
                    terminal_channel(channel);
                    return;
                }
                if channel.label() != DATACHANNEL_LABEL {
                    log::warn!(
                        "signaling::peer: ignoring data channel with unexpected label \"{}\"",
                        channel.label()
                    );
                    return;
                }

                // The RPC/event channel is a single ordered, fully reliable
                // stream. A second channel with the same label is not a
                // replacement protocol: accepting it would let its callbacks
                // overwrite the live channel and reorder framed messages.
                let decision = {
                    let mut slot = dc_slot.write().await;
                    let decision = classify_inbound_channel(
                        channel.label(),
                        channel.ordered(),
                        channel.max_packet_lifetime(),
                        channel.max_retransmits(),
                        slot.is_some(),
                    );
                    if decision == InboundChannelDecision::AcceptMain {
                        *slot = Some(Arc::clone(&channel));
                    }
                    decision
                };
                match decision {
                    InboundChannelDecision::AcceptMain => {}
                    InboundChannelDecision::RejectUnreliable => {
                        log::warn!("signaling::peer: rejecting unreliable main data channel");
                        let _ = channel.close().await;
                        return;
                    }
                    InboundChannelDecision::RejectDuplicate => {
                        log::warn!("signaling::peer: rejecting duplicate main data channel");
                        let _ = channel.close().await;
                        return;
                    }
                }

                channel
                    .set_buffered_amount_low_threshold(SEND_BUFFER_LOW_WATER)
                    .await;
                let capacity_signal = Arc::clone(&send_capacity_dc);
                channel
                    .on_buffered_amount_low(Box::new(move || {
                        let capacity_signal = Arc::clone(&capacity_signal);
                        Box::pin(async move {
                            capacity_signal.notify_waiters();
                        })
                    }))
                    .await;

                // on_open → signal the caller via the watch channel.
                let open_signal = open_tx_dc.clone();
                channel.on_open(Box::new(move || {
                    let open_signal = open_signal.clone();
                    Box::pin(async move {
                        let _ = open_signal.send(true);
                    })
                }));

                // on_message → forward bytes to the dispatcher.
                let forward = inbound_tx.clone();
                let overflow_channel = Arc::clone(&channel);
                channel.on_message(Box::new(move |msg: DataChannelMessage| {
                    let forward = forward.clone();
                    let overflow_channel = Arc::clone(&overflow_channel);
                    Box::pin(async move {
                        let bytes = msg.data.to_vec();
                        if forward.try_send(bytes).is_err() {
                            log::warn!(
                                "signaling::peer: inbound frame queue overflow; closing peer channel"
                            );
                            let _ = overflow_channel.close().await;
                        }
                    })
                }));

                // on_close → drop the cached handle and signal closure.
                let dc_slot_close = Arc::clone(&dc_slot);
                let open_signal_close = open_tx_dc.clone();
                let capacity_signal_close = Arc::clone(&send_capacity_dc);
                let closing_channel = Arc::clone(&channel);
                channel.on_close(Box::new(move || {
                    let dc_slot_close = Arc::clone(&dc_slot_close);
                    let open_signal_close = open_signal_close.clone();
                    let capacity_signal_close = Arc::clone(&capacity_signal_close);
                    let closing_channel = Arc::clone(&closing_channel);
                    Box::pin(async move {
                        let mut slot = dc_slot_close.write().await;
                        if slot
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &closing_channel))
                        {
                            *slot = None;
                        }
                        let _ = open_signal_close.send(false);
                        capacity_signal_close.notify_waiters();
                    })
                }));
            })
        }));

        Ok(Self {
            pc,
            dc,
            open_tx,
            open_rx,
            send_lock: Mutex::new(()),
            send_capacity,
        })
    }

    /// Process an incoming SDP offer and return the SDP of our answer.
    /// Caller is responsible for relaying the answer back to the mobile
    /// peer through the signaling channel.
    pub async fn accept_offer(&self, sdp: String) -> Result<String, webrtc::Error> {
        let offer = RTCSessionDescription::offer(sdp)?;
        self.pc.set_remote_description(offer).await?;
        let answer = self.pc.create_answer(None).await?;
        self.pc.set_local_description(answer.clone()).await?;
        Ok(answer.sdp)
    }

    /// Add an inbound ICE candidate received via signaling.
    pub async fn add_remote_ice(
        &self,
        candidate: RTCIceCandidateInit,
    ) -> Result<(), webrtc::Error> {
        self.pc.add_ice_candidate(candidate).await
    }

    /// Send a JSON envelope to the mobile peer over the data channel. The
    /// dispatcher uses this to deliver RPC responses and event frames.
    ///
    /// Sends as a **text** DataChannel message when the payload is valid UTF-8
    /// (it always is — the dispatcher serializes JSON). This matters: the peer
    /// (`lib/tauri/transport-rtc.ts:handleDataChannelMessage`) reads inbound
    /// frames as `String(event.data)`, which cannot decode a binary
    /// (`ArrayBuffer`/`Blob`) message — so a binary send was silently dropped
    /// on the receiver, breaking every desktop→peer response and event. The
    /// mobile→desktop direction already sends text; this makes the two
    /// symmetric. Non-UTF-8 payloads (should never occur) fall back to binary.
    pub async fn send_bytes(&self, bytes: Vec<u8>) -> Result<(), PeerSendError> {
        let channel = self
            .dc
            .read()
            .await
            .clone()
            .ok_or(PeerSendError::ChannelClosed)?;
        let message_id = uuid::Uuid::new_v4().to_string();
        let frames = super::datachannel_framing::encode_message(&bytes, &message_id)
            .map_err(|error| PeerSendError::Webrtc(error.to_string()))?;
        for frame in frames {
            let frame = match String::from_utf8(frame) {
                Ok(text) => OutboundFrame::Text(text),
                Err(err) => OutboundFrame::Binary(Bytes::from(err.into_bytes())),
            };
            self.send_frame(&channel, frame).await?;
        }
        Ok(())
    }

    /// Send a media resource as raw bounded DataChannel frames. Metadata is
    /// announced separately by the dispatcher; these frames contain only the
    /// request id, ordering fields, and the original bytes.
    pub async fn send_binary_resource(
        &self,
        request_id: &str,
        bytes: &[u8],
    ) -> Result<(), PeerSendError> {
        let channel = self
            .dc
            .read()
            .await
            .clone()
            .ok_or(PeerSendError::ChannelClosed)?;
        let chunk_bytes = super::datachannel_framing::BINARY_RESOURCE_CHUNK_BYTES;
        let total_chunks = bytes.len().max(1).div_ceil(chunk_bytes) as u32;
        if bytes.is_empty() {
            let frame = super::datachannel_framing::encode_binary_resource_chunk(
                request_id,
                0,
                total_chunks,
                &[],
            )
            .map_err(|error| PeerSendError::Webrtc(error.to_string()))?;
            self.send_frame(&channel, OutboundFrame::Binary(Bytes::from(frame)))
                .await?;
            return Ok(());
        }
        for (index, payload) in bytes.chunks(chunk_bytes).enumerate() {
            let frame = super::datachannel_framing::encode_binary_resource_chunk(
                request_id,
                index as u32,
                total_chunks,
                payload,
            )
            .map_err(|error| PeerSendError::Webrtc(error.to_string()))?;
            self.send_frame(&channel, OutboundFrame::Binary(Bytes::from(frame)))
                .await?;
        }
        Ok(())
    }

    async fn send_frame(
        &self,
        channel: &Arc<RTCDataChannel>,
        frame: OutboundFrame,
    ) -> Result<(), PeerSendError> {
        // Lock one physical frame at a time. Logical messages may interleave
        // safely because each frame carries its own message id, while the lock
        // prevents concurrent senders from all refilling a just-drained SCTP
        // buffer before any of them can observe the new buffered amount.
        let _send_guard = self.send_lock.lock().await;
        if channel.ready_state() != RTCDataChannelState::Open {
            return Err(PeerSendError::ChannelClosed);
        }
        if let Err(error) = wait_for_send_capacity(
            {
                let channel = Arc::clone(channel);
                move || {
                    let channel = Arc::clone(&channel);
                    async move { channel.buffered_amount().await }
                }
            },
            self.open_rx.clone(),
            &self.send_capacity,
            SEND_BACKPRESSURE_TIMEOUT,
        )
        .await
        {
            if matches!(error, PeerSendError::BackpressureTimeout) {
                let _ = channel.close().await;
            }
            return Err(error);
        }
        if channel.ready_state() != RTCDataChannelState::Open {
            return Err(PeerSendError::ChannelClosed);
        }
        match frame {
            OutboundFrame::Text(text) => channel.send_text(text).await,
            OutboundFrame::Binary(bytes) => channel.send(&bytes).await,
        }
        .map(|_| ())
        .map_err(|error| PeerSendError::Webrtc(error.to_string()))
    }

    /// Wait until the data channel transitions to the `open` state. Returns
    /// `Err` if the channel never opens (e.g., negotiation failed and the
    /// peer connection was torn down before the open event fired).
    pub async fn wait_for_open(&self, timeout: std::time::Duration) -> Result<(), PeerSendError> {
        // Watch::Receiver returns the current value on first borrow — if
        // the channel is already open we resolve immediately.
        if *self.open_rx.borrow() {
            return Ok(());
        }
        let mut rx = self.open_rx.clone();
        match tokio::time::timeout(timeout, async {
            while rx.changed().await.is_ok() {
                if *rx.borrow() {
                    return Ok(());
                }
            }
            Err(PeerSendError::ChannelClosed)
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err(PeerSendError::Timeout),
        }
    }

    /// Tear down the underlying peer connection.
    pub async fn close(&self) {
        if let Err(e) = self.pc.close().await {
            log::warn!("signaling::peer: close failed: {e}");
        }
        let _ = self.open_tx.send(false);
    }
}

fn is_reliable_ordered_channel(
    ordered: bool,
    max_packet_lifetime: Option<u16>,
    max_retransmits: Option<u16>,
) -> bool {
    ordered && max_packet_lifetime.is_none() && max_retransmits.is_none()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InboundChannelDecision {
    AcceptMain,
    RejectUnreliable,
    RejectDuplicate,
}

fn classify_inbound_channel(
    label: &str,
    ordered: bool,
    max_packet_lifetime: Option<u16>,
    max_retransmits: Option<u16>,
    main_occupied: bool,
) -> InboundChannelDecision {
    debug_assert_eq!(label, DATACHANNEL_LABEL);
    if !is_reliable_ordered_channel(ordered, max_packet_lifetime, max_retransmits) {
        InboundChannelDecision::RejectUnreliable
    } else if main_occupied {
        InboundChannelDecision::RejectDuplicate
    } else {
        InboundChannelDecision::AcceptMain
    }
}

enum OutboundFrame {
    Text(String),
    Binary(Bytes),
}

async fn wait_for_send_capacity<F, Fut>(
    mut buffered_amount: F,
    mut open_rx: tokio::sync::watch::Receiver<bool>,
    capacity_signal: &Notify,
    timeout: Duration,
) -> Result<(), PeerSendError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = usize>,
{
    if buffered_amount().await <= SEND_BUFFER_HIGH_WATER {
        return Ok(());
    }

    let wait = async {
        loop {
            // Register before re-checking the amount so a drain between the
            // check and the await cannot strand this sender.
            let drained = capacity_signal.notified();
            tokio::pin!(drained);
            drained.as_mut().enable();
            if buffered_amount().await <= SEND_BUFFER_LOW_WATER {
                return Ok(());
            }
            if !*open_rx.borrow() {
                return Err(PeerSendError::ChannelClosed);
            }
            tokio::select! {
                _ = &mut drained => {}
                changed = open_rx.changed() => {
                    if changed.is_err() || !*open_rx.borrow() {
                        return Err(PeerSendError::ChannelClosed);
                    }
                }
            }
        }
    };

    tokio::time::timeout(timeout, wait)
        .await
        .unwrap_or(Err(PeerSendError::BackpressureTimeout))
}

#[derive(Debug, thiserror::Error)]
pub enum PeerSendError {
    #[error("data channel is not open")]
    ChannelClosed,
    #[error("wait_for_open timed out")]
    Timeout,
    #[error("data channel backpressure timed out")]
    BackpressureTimeout,
    #[error("webrtc error: {0}")]
    Webrtc(String),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use webrtc::peer_connection::offer_answer_options::RTCOfferOptions;

    fn callbacks() -> (
        PeerCallbacks,
        mpsc::Receiver<RTCIceCandidateInit>,
        mpsc::Receiver<Vec<u8>>,
        mpsc::Receiver<RTCPeerConnectionState>,
    ) {
        let (ice_tx, ice_rx) = mpsc::channel(ICE_QUEUE_CAPACITY);
        let (data_tx, data_rx) = mpsc::channel(INBOUND_FRAME_QUEUE_CAPACITY);
        let (state_tx, state_rx) = mpsc::channel(STATE_QUEUE_CAPACITY);
        (
            PeerCallbacks {
                outbound_ice: ice_tx,
                inbound_data: data_tx,
                terminal_channel: Arc::new(|_| {}),
                state_change: state_tx,
            },
            ice_rx,
            data_rx,
            state_rx,
        )
    }

    #[tokio::test]
    async fn peer_session_constructs_without_errors() {
        let (cb, _ice, _data, _state) = callbacks();
        let session = PeerSession::new(vec![], cb).await.expect("construct");
        // No data channel yet → send_bytes errors with ChannelClosed.
        let err = session.send_bytes(vec![1, 2, 3]).await.unwrap_err();
        assert!(matches!(err, PeerSendError::ChannelClosed));
        session.close().await;
    }

    #[test]
    fn terminal_channel_contract_is_unversioned_reliable_and_ordered() {
        assert_eq!(TERMINAL_DATACHANNEL_LABEL, "cognia.terminal");
        assert!(is_reliable_ordered_channel(true, None, None));
        assert!(!is_reliable_ordered_channel(false, None, None));
        assert!(!is_reliable_ordered_channel(true, Some(1000), None));
        assert!(!is_reliable_ordered_channel(true, None, Some(3)));
    }

    #[test]
    fn main_channel_contract_rejects_unreliable_and_duplicate_channels() {
        assert_eq!(
            classify_inbound_channel(DATACHANNEL_LABEL, true, None, None, false),
            InboundChannelDecision::AcceptMain
        );
        assert_eq!(
            classify_inbound_channel(DATACHANNEL_LABEL, false, None, None, false),
            InboundChannelDecision::RejectUnreliable
        );
        assert_eq!(
            classify_inbound_channel(DATACHANNEL_LABEL, true, Some(1000), None, false),
            InboundChannelDecision::RejectUnreliable
        );
        assert_eq!(
            classify_inbound_channel(DATACHANNEL_LABEL, true, None, Some(3), false),
            InboundChannelDecision::RejectUnreliable
        );
        assert_eq!(
            classify_inbound_channel(DATACHANNEL_LABEL, true, None, None, true),
            InboundChannelDecision::RejectDuplicate
        );
    }

    #[tokio::test]
    async fn send_capacity_wait_resumes_after_buffer_drains() {
        let amount = Arc::new(AtomicUsize::new(SEND_BUFFER_HIGH_WATER + 1));
        let notify = Arc::new(tokio::sync::Notify::new());
        let (open_tx, open_rx) = tokio::sync::watch::channel(true);
        let amount_for_wait = Arc::clone(&amount);
        let notify_for_wait = Arc::clone(&notify);
        let waiter = tokio::spawn(async move {
            wait_for_send_capacity(
                move || {
                    let amount = Arc::clone(&amount_for_wait);
                    async move { amount.load(Ordering::SeqCst) }
                },
                open_rx,
                &notify_for_wait,
                std::time::Duration::from_secs(1),
            )
            .await
        });

        tokio::task::yield_now().await;
        amount.store(SEND_BUFFER_LOW_WATER, Ordering::SeqCst);
        notify.notify_waiters();

        assert!(waiter.await.unwrap().is_ok());
        drop(open_tx);
    }

    #[tokio::test]
    async fn send_capacity_wait_stops_when_channel_closes() {
        let notify = tokio::sync::Notify::new();
        let (open_tx, open_rx) = tokio::sync::watch::channel(true);
        let waiter = tokio::spawn(async move {
            wait_for_send_capacity(
                || async { SEND_BUFFER_HIGH_WATER + 1 },
                open_rx,
                &notify,
                std::time::Duration::from_secs(1),
            )
            .await
        });

        tokio::task::yield_now().await;
        open_tx.send(false).unwrap();

        assert!(matches!(
            waiter.await.unwrap(),
            Err(PeerSendError::ChannelClosed)
        ));
    }

    #[tokio::test]
    async fn send_capacity_wait_has_a_distinct_timeout_error() {
        let notify = tokio::sync::Notify::new();
        let (_open_tx, open_rx) = tokio::sync::watch::channel(true);
        let result = wait_for_send_capacity(
            || async { SEND_BUFFER_HIGH_WATER + 1 },
            open_rx,
            &notify,
            std::time::Duration::from_millis(10),
        )
        .await;

        assert!(matches!(result, Err(PeerSendError::BackpressureTimeout)));
    }

    #[tokio::test]
    async fn wait_for_open_times_out_when_no_channel() {
        let (cb, _ice, _data, _state) = callbacks();
        let session = PeerSession::new(vec![], cb).await.expect("construct");
        let result = session
            .wait_for_open(std::time::Duration::from_millis(50))
            .await;
        assert!(matches!(result, Err(PeerSendError::Timeout)));
        session.close().await;
    }

    #[tokio::test]
    async fn accept_offer_is_recallable_for_ice_restart() {
        // The desktop ICE-restart path (client.rs) renegotiates on the live
        // PeerSession instead of rebuilding it. This proves `accept_offer` is
        // safely re-callable on the same session: a second (ice_restart) offer
        // from the mobile peer yields a fresh answer without a new PeerSession.
        let (cb, _ice, _data, _state) = callbacks();
        let desktop = PeerSession::new(vec![], cb).await.expect("desktop");

        let mobile_api = APIBuilder::new().build();
        let mobile = mobile_api
            .new_peer_connection(RTCConfiguration::default())
            .await
            .expect("mobile pc");
        let _dc = mobile
            .create_data_channel(DATACHANNEL_LABEL, None)
            .await
            .expect("mobile dc");

        // Initial negotiation → stable on both ends.
        let offer1 = mobile.create_offer(None).await.expect("offer1");
        mobile
            .set_local_description(offer1.clone())
            .await
            .expect("ml1");
        let answer1_sdp = desktop.accept_offer(offer1.sdp).await.expect("accept1");
        assert!(!answer1_sdp.is_empty());
        let answer1 = RTCSessionDescription::answer(answer1_sdp).expect("answer1 parse");
        mobile.set_remote_description(answer1).await.expect("mr1");

        // ICE restart: the mobile re-offers with `ice_restart` on the SAME PC;
        // the desktop renegotiates on the SAME PeerSession (no rebuild).
        let offer2 = mobile
            .create_offer(Some(RTCOfferOptions {
                ice_restart: true,
                ..Default::default()
            }))
            .await
            .expect("offer2 restart");
        mobile
            .set_local_description(offer2.clone())
            .await
            .expect("ml2");
        let answer2_sdp = desktop
            .accept_offer(offer2.sdp)
            .await
            .expect("accept2 restart");
        assert!(!answer2_sdp.is_empty());

        desktop.close().await;
        let _ = mobile.close().await;
    }

    #[tokio::test]
    async fn end_to_end_offer_answer_and_data_channel() {
        // Build two PeerConnections in the same process: a "mobile" offerer
        // (created manually here) and a "desktop" answerer (PeerSession).
        // Drive them through SDP+ICE and assert the DataChannel opens on
        // both ends.

        let (cb, _desktop_ice_rx, desktop_data_rx, _desktop_state_rx) = callbacks();
        let desktop = PeerSession::new(vec![], cb).await.expect("desktop");

        // Build the mobile (offerer) side manually using the same crate.
        let mobile_api = APIBuilder::new().build();
        let mobile = Arc::new(
            mobile_api
                .new_peer_connection(RTCConfiguration::default())
                .await
                .expect("mobile pc"),
        );

        // Wire the two ends' ICE candidates directly into each other.
        let desktop_pc = Arc::clone(&desktop.pc);
        let mobile_clone = Arc::clone(&mobile);
        mobile.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
            let desktop_pc = Arc::clone(&desktop_pc);
            Box::pin(async move {
                if let Some(c) = c {
                    if let Ok(init) = c.to_json() {
                        let _ = desktop_pc.add_ice_candidate(init).await;
                    }
                }
            })
        }));
        // PeerSession already wired desktop→outbound_ice. We pump from the
        // receiver into the mobile peer in a separate task.
        let mobile_for_ice = Arc::clone(&mobile_clone);
        let mut ice_rx = _desktop_ice_rx;
        let ice_pump = tokio::spawn(async move {
            while let Some(init) = ice_rx.recv().await {
                let _ = mobile_for_ice.add_ice_candidate(init).await;
            }
        });

        // Mobile creates the data channel before generating the offer.
        let mobile_dc = mobile
            .create_data_channel(DATACHANNEL_LABEL, None)
            .await
            .expect("mobile dc");
        let (mobile_open_tx, mut mobile_open_rx) = tokio::sync::mpsc::channel::<()>(1);
        let mobile_open_tx2 = mobile_open_tx.clone();
        mobile_dc.on_open(Box::new(move || {
            let mobile_open_tx2 = mobile_open_tx2.clone();
            Box::pin(async move {
                let _ = mobile_open_tx2.send(()).await;
            })
        }));

        // SDP offer/answer dance.
        let offer = mobile.create_offer(None).await.expect("offer");
        mobile
            .set_local_description(offer.clone())
            .await
            .expect("ml");
        let answer_sdp = desktop.accept_offer(offer.sdp).await.expect("accept");
        let answer = RTCSessionDescription::answer(answer_sdp).expect("answer parse");
        mobile.set_remote_description(answer).await.expect("mr");

        // Wait for both ends to observe the open transition. Loopback peers
        // converge fast, but we still allow a generous timeout for CI.
        let timeout = std::time::Duration::from_secs(10);
        desktop.wait_for_open(timeout).await.expect("desktop open");
        tokio::time::timeout(timeout, mobile_open_rx.recv())
            .await
            .expect("mobile open timed out")
            .expect("mobile open recv");

        // Round-trip a small payload over the channel.
        let payload = b"hello desktop";
        mobile_dc
            .send(&Bytes::from_static(payload))
            .await
            .expect("mobile send");
        let mut data_rx = desktop_data_rx;
        let received = tokio::time::timeout(timeout, data_rx.recv())
            .await
            .expect("recv timed out")
            .expect("recv None");
        assert_eq!(received, payload);

        // Reverse direction — and ASSERT the mobile actually receives it, AS
        // TEXT. This pins the ADR-0021 fix: `send_bytes` must deliver a text
        // DataChannel message, because the TS/mobile receiver reads frames via
        // `String(event.data)` and silently drops a binary (ArrayBuffer/Blob)
        // message. The real-pair harness (`pnpm webrtc:pair`) caught this when
        // every desktop→peer RPC response timed out; this test locks it down.
        let (mobile_msg_tx, mut mobile_msg_rx) = tokio::sync::mpsc::channel::<(Vec<u8>, bool)>(1);
        mobile_dc.on_message(Box::new(move |msg: DataChannelMessage| {
            let tx = mobile_msg_tx.clone();
            Box::pin(async move {
                let _ = tx.send((msg.data.to_vec(), msg.is_string)).await;
            })
        }));
        desktop
            .send_bytes(b"hello mobile".to_vec())
            .await
            .expect("desktop send");
        let (mobile_received, is_string) = tokio::time::timeout(timeout, mobile_msg_rx.recv())
            .await
            .expect("mobile recv timed out — desktop→mobile frame was dropped")
            .expect("mobile recv None");
        assert_eq!(mobile_received, b"hello mobile");
        assert!(
            is_string,
            "desktop→mobile frame must be a TEXT message; a binary message is silently dropped by the TS receiver"
        );

        // Teardown
        desktop.close().await;
        let _ = mobile.close().await;
        ice_pump.abort();
    }
}
