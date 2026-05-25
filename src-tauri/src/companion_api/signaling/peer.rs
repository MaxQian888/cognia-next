//! WebRTC peer wrapper. ADR-0021.
//!
//! Builds one `webrtc::peer_connection::RTCPeerConnection` per active
//! mobile peer in a rendezvous room and bridges its lifecycle hooks
//! (`on_data_channel`, `on_ice_candidate`, `on_peer_connection_state_change`)
//! into tokio mpsc channels that the signaling client task consumes.
//!
//! Role split (matches `lib/tauri/transport-rtc.ts`):
//! - **mobile** is the offerer — it calls `pc.createDataChannel("cognia.v1", ...)`
//!   and produces the SDP offer.
//! - **desktop** (this file) is the answerer — it waits for the offer via
//!   signaling, calls `set_remote_description` + `create_answer` +
//!   `set_local_description`, and exposes the inbound DataChannel through
//!   the supplied `inbound_data_tx` channel.

use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::{mpsc, RwLock};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

/// DataChannel label both peers agree on. Mirrored in
/// `lib/signaling/types.ts:DATACHANNEL_LABEL`.
pub const DATACHANNEL_LABEL: &str = "cognia.v1";

/// Wraps an `RTCPeerConnection` and its (single) data channel, fanning the
/// callback world out to plain mpsc channels for the signaling client to
/// consume.
pub struct PeerSession {
    pc: Arc<RTCPeerConnection>,
    dc: Arc<RwLock<Option<Arc<RTCDataChannel>>>>,
    /// Latched once the data channel opens — wakes `wait_for_open()`.
    open_tx: tokio::sync::watch::Sender<bool>,
    open_rx: tokio::sync::watch::Receiver<bool>,
}

/// Construction-time configuration for [`PeerSession`]. The mpsc senders
/// are owned by the signaling client task; the peer session drops its
/// clones when it tears down.
pub struct PeerCallbacks {
    /// Local ICE candidates discovered after `setLocalDescription`. The
    /// signaling client wraps each in a `rtc:ice` envelope and relays it
    /// to the mobile peer.
    pub outbound_ice: mpsc::UnboundedSender<RTCIceCandidateInit>,
    /// Inbound DataChannel binary messages (the RPC / event JSON
    /// envelopes from the mobile peer).
    pub inbound_data: mpsc::UnboundedSender<Vec<u8>>,
    /// `RTCPeerConnectionState` transitions for failure detection.
    pub state_change: mpsc::UnboundedSender<RTCPeerConnectionState>,
}

impl PeerSession {
    /// Build a new peer session bound to the given ICE configuration. The
    /// session is not connected yet — the caller must subsequently feed it
    /// an SDP offer via [`Self::accept_offer`].
    pub async fn new(
        ice_servers: Vec<RTCIceServer>,
        callbacks: PeerCallbacks,
    ) -> Result<Self, webrtc::Error> {
        let api = APIBuilder::new().build();
        let config = RTCConfiguration {
            ice_servers,
            ..Default::default()
        };
        let pc = Arc::new(api.new_peer_connection(config).await?);
        let dc: Arc<RwLock<Option<Arc<RTCDataChannel>>>> = Arc::new(RwLock::new(None));
        let (open_tx, open_rx) = tokio::sync::watch::channel(false);

        // ── on_ice_candidate ───────────────────────────────────────────
        let ice_tx = callbacks.outbound_ice.clone();
        pc.on_ice_candidate(Box::new(move |candidate: Option<RTCIceCandidate>| {
            let ice_tx = ice_tx.clone();
            Box::pin(async move {
                if let Some(c) = candidate {
                    match c.to_json() {
                        Ok(init) => {
                            let _ = ice_tx.send(init);
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
                let _ = state_tx.send(s);
            })
        }));

        // ── on_data_channel ────────────────────────────────────────────
        let dc_slot = Arc::clone(&dc);
        let inbound_tx = callbacks.inbound_data.clone();
        let open_tx_dc = open_tx.clone();
        pc.on_data_channel(Box::new(move |channel: Arc<RTCDataChannel>| {
            let dc_slot = Arc::clone(&dc_slot);
            let inbound_tx = inbound_tx.clone();
            let open_tx_dc = open_tx_dc.clone();
            Box::pin(async move {
                if channel.label() != DATACHANNEL_LABEL {
                    log::warn!(
                        "signaling::peer: ignoring data channel with unexpected label \"{}\"",
                        channel.label()
                    );
                    return;
                }

                // Stash the channel so `send()` can reach it.
                {
                    let mut slot = dc_slot.write().await;
                    *slot = Some(Arc::clone(&channel));
                }

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
                channel.on_message(Box::new(move |msg: DataChannelMessage| {
                    let forward = forward.clone();
                    Box::pin(async move {
                        let bytes = msg.data.to_vec();
                        if forward.send(bytes).is_err() {
                            log::warn!(
                                "signaling::peer: inbound channel dropped, dispatcher gone"
                            );
                        }
                    })
                }));

                // on_close → drop the cached handle and signal closure.
                let dc_slot_close = Arc::clone(&dc_slot);
                let open_signal_close = open_tx_dc.clone();
                channel.on_close(Box::new(move || {
                    let dc_slot_close = Arc::clone(&dc_slot_close);
                    let open_signal_close = open_signal_close.clone();
                    Box::pin(async move {
                        let mut slot = dc_slot_close.write().await;
                        *slot = None;
                        let _ = open_signal_close.send(false);
                    })
                }));
            })
        }));

        Ok(Self {
            pc,
            dc,
            open_tx,
            open_rx,
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

    /// Send a binary payload to the mobile peer over the data channel. The
    /// dispatcher uses this to deliver RPC responses and event frames.
    pub async fn send_bytes(&self, bytes: Vec<u8>) -> Result<(), PeerSendError> {
        let dc = self.dc.read().await;
        let channel = dc.as_ref().ok_or(PeerSendError::ChannelClosed)?;
        channel
            .send(&Bytes::from(bytes))
            .await
            .map(|_| ())
            .map_err(|e| PeerSendError::Webrtc(e.to_string()))
    }

    /// Wait until the data channel transitions to the `open` state. Returns
    /// `Err` if the channel never opens (e.g., negotiation failed and the
    /// peer connection was torn down before the open event fired).
    pub async fn wait_for_open(
        &self,
        timeout: std::time::Duration,
    ) -> Result<(), PeerSendError> {
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

#[derive(Debug, thiserror::Error)]
pub enum PeerSendError {
    #[error("data channel is not open")]
    ChannelClosed,
    #[error("wait_for_open timed out")]
    Timeout,
    #[error("webrtc error: {0}")]
    Webrtc(String),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;
    use webrtc::peer_connection::offer_answer_options::RTCOfferOptions;

    fn callbacks() -> (
        PeerCallbacks,
        mpsc::UnboundedReceiver<RTCIceCandidateInit>,
        mpsc::UnboundedReceiver<Vec<u8>>,
        mpsc::UnboundedReceiver<RTCPeerConnectionState>,
    ) {
        let (ice_tx, ice_rx) = unbounded_channel();
        let (data_tx, data_rx) = unbounded_channel();
        let (state_tx, state_rx) = unbounded_channel();
        (
            PeerCallbacks {
                outbound_ice: ice_tx,
                inbound_data: data_tx,
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
        mobile.set_local_description(offer1.clone()).await.expect("ml1");
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
        mobile.set_local_description(offer2.clone()).await.expect("ml2");
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
        mobile.set_local_description(offer.clone()).await.expect("ml");
        let answer_sdp = desktop.accept_offer(offer.sdp).await.expect("accept");
        let answer =
            RTCSessionDescription::answer(answer_sdp).expect("answer parse");
        mobile.set_remote_description(answer).await.expect("mr");

        // Wait for both ends to observe the open transition. Loopback peers
        // converge fast, but we still allow a generous timeout for CI.
        let timeout = std::time::Duration::from_secs(10);
        desktop
            .wait_for_open(timeout)
            .await
            .expect("desktop open");
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

        // Reverse direction.
        desktop.send_bytes(b"hello mobile".to_vec()).await.expect("desktop send");

        // Teardown
        desktop.close().await;
        let _ = mobile.close().await;
        ice_pump.abort();
    }
}
