//! The thing the dispatcher writes to. ADR-0170.
//!
//! Before the relay, the dispatcher held an `Arc<PeerSession>` and every
//! outbound frame went onto the WebRTC DataChannel. Now the same frames can
//! also travel *through* the signaling rendezvous, encrypted in a `data`
//! envelope, whenever no DataChannel is open. The relay is a virtual
//! DataChannel, not a second protocol. [`DataCarrier`] owns that choice so
//! the dispatcher stays carrier-blind:
//!
//! - **DataChannel first.** If a `PeerSession` is attached and its channel is
//!   open, frames go there (lowest latency, no vendor hop).
//! - **Relay otherwise.** Frames are handed to the session loop in
//!   `client.rs`, which owns the session crypto and turns each one into a
//!   signed, encrypted `data` envelope on the relay's data lane.
//!
//! The carrier never encrypts: keys live in the session loop with the rest of
//! the peer crypto, and a channel of raw frames is all that crosses.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, RwLock};

use super::datachannel_framing::{
    encode_binary_resource_chunk, encode_message, BINARY_RESOURCE_CHUNK_BYTES,
    BINARY_RESOURCE_HEADER_BYTES,
};
use super::peer::{PeerSendError, PeerSession};

/// One physical frame bound for the relay's data lane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayFrame {
    /// A JSON or chunk frame: what would have been a text DataChannel message.
    Text(Vec<u8>),
    /// A raw binary-resource chunk (`CGM1` header + payload): what would
    /// have been a binary DataChannel message.
    Binary(Vec<u8>),
}

/// Payload bytes per binary-resource chunk on the relay. Smaller than the
/// DataChannel's 32 KiB so a chunk still fits the data lane's 64 KiB frame
/// cap after base64 inside AES-GCM inside JSON (21 KiB grows to roughly
/// 39 KiB), and large enough that a 10 MiB resource (the dispatcher's
/// ceiling) stays under the peer's 512 `totalChunks` limit.
pub const RELAY_BINARY_RESOURCE_CHUNK_BYTES: usize = 21 * 1024 - BINARY_RESOURCE_HEADER_BYTES;

/// Bounded queue from the dispatcher to the session loop. Sized for one
/// full 1 MiB logical message (32 chunks) plus a media resource in flight.
/// Beyond that the dispatcher waits, which is the backpressure a
/// DataChannel would apply through `bufferedAmount`.
pub const RELAY_OUTBOUND_QUEUE: usize = 1024;

pub struct DataCarrier {
    peer: RwLock<Option<Arc<PeerSession>>>,
    relay_tx: Option<mpsc::Sender<RelayFrame>>,
    relay_open: AtomicBool,
}

impl DataCarrier {
    /// A carrier with a DataChannel only: today's pre-relay peers.
    pub fn datachannel_only(peer: Arc<PeerSession>) -> Arc<Self> {
        Arc::new(Self {
            peer: RwLock::new(Some(peer)),
            relay_tx: None,
            relay_open: AtomicBool::new(false),
        })
    }

    /// A carrier whose fallback is the relay. A `PeerSession` may be attached
    /// later (and detached again) as ICE comes and goes.
    pub fn with_relay(relay_tx: mpsc::Sender<RelayFrame>) -> Arc<Self> {
        Arc::new(Self {
            peer: RwLock::new(None),
            relay_tx: Some(relay_tx),
            relay_open: AtomicBool::new(true),
        })
    }

    pub async fn attach_peer(&self, peer: Arc<PeerSession>) {
        *self.peer.write().await = Some(peer);
    }

    pub async fn detach_peer(&self) -> Option<Arc<PeerSession>> {
        self.peer.write().await.take()
    }

    pub fn set_relay_open(&self, open: bool) {
        self.relay_open.store(open, Ordering::Release);
    }

    pub fn relay_open(&self) -> bool {
        self.relay_tx.is_some() && self.relay_open.load(Ordering::Acquire)
    }

    /// Whether *anything* can currently take a frame. Cheap: it does not
    /// probe the DataChannel's ready state (a send does).
    pub async fn is_open(&self) -> bool {
        self.peer.read().await.is_some() || self.relay_open()
    }

    /// Payload bytes per binary-resource chunk for whichever path a send
    /// would take right now. The dispatcher announces `totalChunks` before
    /// sending, so it must ask the carrier rather than assume the DataChannel
    /// figure.
    pub async fn binary_chunk_bytes(&self) -> usize {
        if self.peer_channel_open().await {
            BINARY_RESOURCE_CHUNK_BYTES
        } else {
            RELAY_BINARY_RESOURCE_CHUNK_BYTES
        }
    }

    async fn peer_channel_open(&self) -> bool {
        match self.peer.read().await.as_ref() {
            Some(peer) => peer.channel_open().await,
            None => false,
        }
    }

    /// Send one logical message (JSON RPC response, event, control frame).
    /// Chunked by the same `datachannel_framing` rules on both paths, so the
    /// peer's single reassembler handles either.
    pub async fn send_bytes(&self, bytes: Vec<u8>) -> Result<(), PeerSendError> {
        let peer = self.peer.read().await.clone();
        if let Some(peer) = peer {
            match peer.send_bytes(bytes.clone()).await {
                Err(PeerSendError::ChannelClosed) if self.relay_open() => {}
                other => return other,
            }
        }
        self.send_relay_message(bytes).await
    }

    /// Send a media resource as raw bounded chunks. `request_id` must be a
    /// UUID string (the framing rejects anything else).
    pub async fn send_binary_resource(
        &self,
        request_id: &str,
        bytes: &[u8],
    ) -> Result<(), PeerSendError> {
        let peer = self.peer.read().await.clone();
        if let Some(peer) = peer {
            match peer.send_binary_resource(request_id, bytes).await {
                Err(PeerSendError::ChannelClosed) if self.relay_open() => {}
                other => return other,
            }
        }
        let Some(tx) = self.relay_tx.as_ref().filter(|_| self.relay_open()) else {
            return Err(PeerSendError::ChannelClosed);
        };
        let chunk_bytes = RELAY_BINARY_RESOURCE_CHUNK_BYTES;
        let total_chunks = bytes.len().max(1).div_ceil(chunk_bytes) as u32;
        if bytes.is_empty() {
            let frame = encode_binary_resource_chunk(request_id, 0, total_chunks, &[])
                .map_err(|error| PeerSendError::Webrtc(error.to_string()))?;
            return tx
                .send(RelayFrame::Binary(frame))
                .await
                .map_err(|_| PeerSendError::ChannelClosed);
        }
        for (index, payload) in bytes.chunks(chunk_bytes).enumerate() {
            let frame =
                encode_binary_resource_chunk(request_id, index as u32, total_chunks, payload)
                    .map_err(|error| PeerSendError::Webrtc(error.to_string()))?;
            tx.send(RelayFrame::Binary(frame))
                .await
                .map_err(|_| PeerSendError::ChannelClosed)?;
        }
        Ok(())
    }

    async fn send_relay_message(&self, bytes: Vec<u8>) -> Result<(), PeerSendError> {
        let Some(tx) = self.relay_tx.as_ref().filter(|_| self.relay_open()) else {
            return Err(PeerSendError::ChannelClosed);
        };
        let message_id = uuid::Uuid::new_v4().to_string();
        let frames = encode_message(&bytes, &message_id)
            .map_err(|error| PeerSendError::Webrtc(error.to_string()))?;
        for frame in frames {
            tx.send(RelayFrame::Text(frame))
                .await
                .map_err(|_| PeerSendError::ChannelClosed)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn relay_carrier_chunks_a_logical_message_like_the_datachannel() {
        let (tx, mut rx) = mpsc::channel(RELAY_OUTBOUND_QUEUE);
        let carrier = DataCarrier::with_relay(tx);
        assert!(carrier.is_open().await);
        // 100 KB is more than one 32 KiB frame: a start frame + N data chunks.
        let payload = vec![b'x'; 100_000];
        carrier.send_bytes(payload).await.expect("send");
        let mut frames = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            frames.push(frame);
        }
        assert!(frames.len() > 2);
        assert!(frames.iter().all(|f| matches!(f, RelayFrame::Text(_))));
    }

    #[tokio::test]
    async fn relay_binary_resource_uses_the_smaller_chunk_and_the_512_ceiling() {
        let (tx, mut rx) = mpsc::channel(RELAY_OUTBOUND_QUEUE);
        let carrier = DataCarrier::with_relay(tx);
        assert_eq!(
            carrier.binary_chunk_bytes().await,
            RELAY_BINARY_RESOURCE_CHUNK_BYTES
        );
        // The dispatcher's 10 MiB ceiling must fit the peer's 512-chunk cap.
        assert!((10 * 1024 * 1024usize).div_ceil(RELAY_BINARY_RESOURCE_CHUNK_BYTES) <= 512);
        let id = uuid::Uuid::new_v4().to_string();
        let bytes = vec![7u8; RELAY_BINARY_RESOURCE_CHUNK_BYTES * 2 + 1];
        carrier.send_binary_resource(&id, &bytes).await.expect("send");
        let mut count = 0;
        while let Ok(frame) = rx.try_recv() {
            assert!(matches!(frame, RelayFrame::Binary(_)));
            count += 1;
        }
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn closed_relay_refuses_with_channel_closed() {
        let (tx, _rx) = mpsc::channel(RELAY_OUTBOUND_QUEUE);
        let carrier = DataCarrier::with_relay(tx);
        carrier.set_relay_open(false);
        assert!(!carrier.is_open().await);
        assert!(matches!(
            carrier.send_bytes(b"{}".to_vec()).await,
            Err(PeerSendError::ChannelClosed)
        ));
    }

    #[tokio::test]
    async fn dropped_relay_receiver_reads_as_closed() {
        let (tx, rx) = mpsc::channel(RELAY_OUTBOUND_QUEUE);
        drop(rx);
        let carrier = DataCarrier::with_relay(tx);
        assert!(matches!(
            carrier.send_bytes(b"{}".to_vec()).await,
            Err(PeerSendError::ChannelClosed)
        ));
    }
}
