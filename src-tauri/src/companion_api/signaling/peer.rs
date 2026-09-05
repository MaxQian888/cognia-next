//! WebRTC peer wrapper. ADR-0021.
//!
//! Builds one `webrtc::peer_connection::PeerConnection` per active mobile peer
//! in a rendezvous room and bridges its event-handler callbacks plus polled
//! data-channel events into tokio mpsc channels consumed by the signaling task.
//!
//! Role split (matches `lib/tauri/transport-rtc.ts`):
//! - **mobile** is the offerer — it calls `pc.createDataChannel("cognia.signaling", ...)`
//!   and produces the SDP offer.
//! - **desktop** (this file) is the answerer — it waits for the offer via
//!   signaling, calls `set_remote_description` + `create_answer` +
//!   `set_local_description`, and exposes the inbound DataChannel through
//!   the supplied `inbound_data_tx` channel.

use std::{future::Future, sync::Arc, time::Duration};

use bytes::{Bytes, BytesMut};
use tokio::sync::{mpsc, Mutex, Notify, RwLock};
use webrtc::data_channel::{DataChannel, DataChannelEvent, RTCDataChannelState};
use webrtc::error::Error as WebrtcError;
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceCandidateInit, RTCIceServer, RTCPeerConnectionIceEvent, RTCPeerConnectionState,
    RTCSessionDescription,
};

/// DataChannel label both peers agree on. Mirrored in
/// `lib/signaling/types.ts:DATACHANNEL_LABEL`.
pub const DATACHANNEL_LABEL: &str = "cognia.signaling";
/// Label used before the protocol-version suffix was dropped. The desktop is
/// the answerer, so it has to keep accepting what an older mobile build offers
/// — otherwise upgrading the desktop alone silently breaks every WAN session.
pub const LEGACY_DATACHANNEL_LABEL: &str = "cognia.v2";
pub const TERMINAL_DATACHANNEL_LABEL: &str = "cognia.terminal";

/// True for the current label and the pre-rename one.
pub fn is_agent_datachannel_label(label: &str) -> bool {
    label == DATACHANNEL_LABEL || label == LEGACY_DATACHANNEL_LABEL
}
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
    pc: Arc<dyn PeerConnection>,
    dc: Arc<RwLock<Option<Arc<dyn DataChannel>>>>,
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
    pub terminal_channel: Arc<dyn Fn(Arc<dyn DataChannel>) + Send + Sync>,
    /// `RTCPeerConnectionState` transitions for failure detection.
    pub state_change: mpsc::Sender<RTCPeerConnectionState>,
}

#[derive(Clone)]
struct CogniaPeerHandler {
    callbacks: Arc<PeerCallbacks>,
    dc: Arc<RwLock<Option<Arc<dyn DataChannel>>>>,
    open_tx: tokio::sync::watch::Sender<bool>,
    send_capacity: Arc<Notify>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for CogniaPeerHandler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        match event.candidate.to_json() {
            Ok(candidate) => {
                if self.callbacks.outbound_ice.try_send(candidate).is_err() {
                    log::warn!("signaling::peer: ICE queue overflow or receiver closed");
                }
            }
            Err(error) => log::warn!("signaling::peer: ice candidate to_json failed: {error}"),
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        if self.callbacks.state_change.try_send(state).is_err() {
            log::warn!("signaling::peer: state queue overflow or receiver closed");
        }
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let callbacks = Arc::clone(&self.callbacks);
        let dc = Arc::clone(&self.dc);
        let open_tx = self.open_tx.clone();
        let send_capacity = Arc::clone(&self.send_capacity);
        tokio::spawn(async move {
            handle_inbound_channel(channel, callbacks, dc, open_tx, send_capacity).await;
        });
    }
}

async fn channel_contract(
    channel: &Arc<dyn DataChannel>,
) -> Result<(String, bool, Option<u16>, Option<u16>), WebrtcError> {
    Ok((
        channel.label().await?,
        channel.ordered().await?,
        channel.max_packet_life_time().await?,
        channel.max_retransmits().await?,
    ))
}

async fn handle_inbound_channel(
    channel: Arc<dyn DataChannel>,
    callbacks: Arc<PeerCallbacks>,
    dc: Arc<RwLock<Option<Arc<dyn DataChannel>>>>,
    open_tx: tokio::sync::watch::Sender<bool>,
    send_capacity: Arc<Notify>,
) {
    let (label, ordered, max_packet_lifetime, max_retransmits) =
        match channel_contract(&channel).await {
            Ok(contract) => contract,
            Err(error) => {
                log::warn!("signaling::peer: read data-channel contract failed: {error}");
                let _ = channel.close().await;
                return;
            }
        };

    if label == TERMINAL_DATACHANNEL_LABEL {
        if !is_reliable_ordered_channel(ordered, max_packet_lifetime, max_retransmits) {
            log::warn!("signaling::peer: rejecting unreliable terminal data channel");
            let _ = channel.close().await;
            return;
        }
        (callbacks.terminal_channel)(channel);
        return;
    }
    if !is_agent_datachannel_label(&label) {
        log::warn!("signaling::peer: rejecting data channel with unexpected label {label:?}");
        let _ = channel.close().await;
        return;
    }

    let decision = {
        let mut slot = dc.write().await;
        let decision = classify_inbound_channel(
            &label,
            ordered,
            max_packet_lifetime,
            max_retransmits,
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

    if let Err(error) = channel
        .set_buffered_amount_low_threshold(SEND_BUFFER_LOW_WATER as u32)
        .await
    {
        log::warn!("signaling::peer: set low-water threshold failed: {error}");
        let _ = channel.close().await;
    } else {
        while let Some(event) = channel.poll().await {
            match event {
                DataChannelEvent::OnOpen => {
                    let _ = open_tx.send(true);
                }
                DataChannelEvent::OnMessage(message) => {
                    if callbacks
                        .inbound_data
                        .try_send(message.data.to_vec())
                        .is_err()
                    {
                        log::warn!(
                            "signaling::peer: inbound frame queue overflow; closing peer channel"
                        );
                        let _ = channel.close().await;
                        break;
                    }
                }
                DataChannelEvent::OnBufferedAmountLow => send_capacity.notify_waiters(),
                DataChannelEvent::OnClosing | DataChannelEvent::OnClose => {
                    let _ = open_tx.send(false);
                    send_capacity.notify_waiters();
                    if matches!(event, DataChannelEvent::OnClose) {
                        break;
                    }
                }
                DataChannelEvent::OnError => {
                    log::warn!("signaling::peer: data channel reported an error");
                    let _ = channel.close().await;
                    break;
                }
                DataChannelEvent::OnBufferedAmountHigh => {}
            }
        }
    }

    let mut slot = dc.write().await;
    if slot
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, &channel))
    {
        *slot = None;
    }
    let _ = open_tx.send(false);
    send_capacity.notify_waiters();
}

impl PeerSession {
    /// Build a new peer session bound to the given ICE configuration. The
    /// session is not connected yet — the caller must subsequently feed it
    /// an SDP offer via [`Self::accept_offer`].
    pub async fn new(
        ice_servers: Vec<RTCIceServer>,
        callbacks: PeerCallbacks,
    ) -> Result<Self, WebrtcError> {
        // The WebRTC DTLS handshake builds a rustls config, which in rustls
        // 0.23 requires an explicit crypto provider when both `ring` and
        // `aws-lc-rs` are in the dep graph. Install one idempotently here so
        // peer connections work even when spawned outside `main.rs` (tests,
        // headless entry points).
        crate::companion_api::ensure_crypto_provider();

        let config = RTCConfigurationBuilder::default()
            .with_ice_servers(ice_servers)
            .build();
        let dc: Arc<RwLock<Option<Arc<dyn DataChannel>>>> = Arc::new(RwLock::new(None));
        let (open_tx, open_rx) = tokio::sync::watch::channel(false);
        let send_capacity = Arc::new(Notify::new());
        let callbacks = Arc::new(callbacks);
        let handler = Arc::new(CogniaPeerHandler {
            callbacks,
            dc: Arc::clone(&dc),
            open_tx: open_tx.clone(),
            send_capacity: Arc::clone(&send_capacity),
        });
        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(config)
                .with_handler(handler)
                .with_udp_addrs(vec!["0.0.0.0:0", "[::]:0"])
                .with_data_channel_send_buffer_limit(SEND_BUFFER_HIGH_WATER)
                .build()
                .await?,
        );

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
    pub async fn accept_offer(&self, sdp: String) -> Result<String, WebrtcError> {
        let offer = RTCSessionDescription::offer(sdp)?;
        self.pc.set_remote_description(offer).await?;
        let answer = self.pc.create_answer(None).await?;
        self.pc.set_local_description(answer.clone()).await?;
        Ok(answer.sdp)
    }

    /// Add an inbound ICE candidate received via signaling.
    pub async fn add_remote_ice(&self, candidate: RTCIceCandidateInit) -> Result<(), WebrtcError> {
        self.pc.add_ice_candidate(candidate).await
    }

    /// Whether the agent data channel is currently `open`. The carrier asks
    /// this before announcing a binary resource so it can size the chunks
    /// for the path the bytes will actually take.
    pub async fn channel_open(&self) -> bool {
        let Some(channel) = self.dc.read().await.clone() else {
            return false;
        };
        matches!(channel.ready_state().await, Ok(RTCDataChannelState::Open))
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
        channel: &Arc<dyn DataChannel>,
        frame: OutboundFrame,
    ) -> Result<(), PeerSendError> {
        // Lock one physical frame at a time. Logical messages may interleave
        // safely because each frame carries its own message id, while the lock
        // prevents concurrent senders from all refilling a just-drained SCTP
        // buffer before any of them can observe the new buffered amount.
        let _send_guard = self.send_lock.lock().await;
        if channel
            .ready_state()
            .await
            .map_err(|error| PeerSendError::Webrtc(error.to_string()))?
            != RTCDataChannelState::Open
        {
            return Err(PeerSendError::ChannelClosed);
        }
        if let Err(error) = wait_for_send_capacity(
            {
                let channel = Arc::clone(channel);
                move || {
                    let channel = Arc::clone(&channel);
                    async move { channel.outstanding_bytes().await.unwrap_or(usize::MAX) }
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
        if channel
            .ready_state()
            .await
            .map_err(|error| PeerSendError::Webrtc(error.to_string()))?
            != RTCDataChannelState::Open
        {
            return Err(PeerSendError::ChannelClosed);
        }
        let result = match frame {
            OutboundFrame::Text(text) => {
                tokio::time::timeout(SEND_BACKPRESSURE_TIMEOUT, channel.send_text(&text)).await
            }
            OutboundFrame::Binary(bytes) => {
                let bytes = BytesMut::from(bytes.as_ref());
                tokio::time::timeout(SEND_BACKPRESSURE_TIMEOUT, channel.send(bytes)).await
            }
        };
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(PeerSendError::Webrtc(error.to_string())),
            Err(_) => {
                let _ = channel.close().await;
                Err(PeerSendError::BackpressureTimeout)
            }
        }
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
    debug_assert!(is_agent_datachannel_label(label));
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

    #[derive(Clone)]
    struct NoopPeerHandler;

    #[async_trait::async_trait]
    impl PeerConnectionEventHandler for NoopPeerHandler {}

    #[derive(Clone)]
    struct ForwardIceHandler {
        remote: Arc<dyn PeerConnection>,
    }

    #[async_trait::async_trait]
    impl PeerConnectionEventHandler for ForwardIceHandler {
        async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
            if let Ok(candidate) = event.candidate.to_json() {
                let _ = self.remote.add_ice_candidate(candidate).await;
            }
        }
    }

    async fn build_test_peer(
        handler: Arc<dyn PeerConnectionEventHandler>,
    ) -> Arc<dyn PeerConnection> {
        crate::companion_api::ensure_crypto_provider();
        Arc::new(
            PeerConnectionBuilder::new()
                .with_handler(handler)
                .with_udp_addrs(vec!["127.0.0.1:0"])
                .build()
                .await
                .expect("test peer"),
        )
    }

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

        let mobile = build_test_peer(Arc::new(NoopPeerHandler)).await;
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
        mobile.restart_ice().await.expect("restart ice");
        let offer2 = mobile.create_offer(None).await.expect("offer2 restart");
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

        // Build the mobile (offerer) side manually using the same crate and
        // wire the two ends' ICE candidates directly into each other.
        let desktop_pc = Arc::clone(&desktop.pc);
        let mobile = build_test_peer(Arc::new(ForwardIceHandler { remote: desktop_pc })).await;
        // PeerSession already wired desktop→outbound_ice. We pump from the
        // receiver into the mobile peer in a separate task.
        let mobile_for_ice = Arc::clone(&mobile);
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
        let (mobile_msg_tx, mut mobile_msg_rx) = tokio::sync::mpsc::channel::<(Vec<u8>, bool)>(1);
        let mobile_dc_events = Arc::clone(&mobile_dc);
        let mobile_event_pump = tokio::spawn(async move {
            while let Some(event) = mobile_dc_events.poll().await {
                match event {
                    DataChannelEvent::OnOpen => {
                        let _ = mobile_open_tx.send(()).await;
                    }
                    DataChannelEvent::OnMessage(message) => {
                        let _ = mobile_msg_tx
                            .send((message.data.to_vec(), message.is_string))
                            .await;
                    }
                    DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
        });

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
            .send_text(std::str::from_utf8(payload).expect("test payload utf-8"))
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
        mobile_event_pump.abort();
    }
}
