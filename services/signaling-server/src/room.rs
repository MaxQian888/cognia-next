//! Stateless, in-memory rendezvous room registry.
//!
//! A room is a `Vec<PeerHandle>` keyed by the public `rendezvous_id`. Each
//! `PeerHandle` carries a bounded `tokio::sync::mpsc::Sender` so the
//! WebSocket task that owns the corresponding peer socket can be woken
//! synchronously by another peer's `relay` frame.
//!
//! No persistent storage; no cross-process state. A single process can
//! safely host thousands of rooms because per-message cost is `O(peers
//! in room)` and rooms drop to zero immediately when the last socket
//! disconnects.

use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::sync::mpsc;

use cognia_signaling_core::policy::{evaluate_subscribe, RoomLimits, SubscribeDecision};

use crate::proto::{PeerRole, ServerFrame, SubscribeProofV2};

/// Outbound channel buffer (frames). Sized generously — peers that fall
/// behind by more than this many frames are forcibly disconnected to bound
/// memory in the face of slow clients.
pub const PEER_OUTBOUND_BUFFER: usize = 64;

/// Per-connection identifier. Monotonic within the process; rolls over at
/// 2^64 which we treat as "never" for practical purposes.
pub type PeerId = u64;
type PeerSender = (PeerId, mpsc::Sender<ServerFrame>);
type RelayPeers = (PeerRole, String, Vec<PeerSender>);

#[derive(Clone)]
pub struct PeerHandle {
    pub peer_id: PeerId,
    pub role: PeerRole,
    pub session_id: String,
    pub proof: SubscribeProofV2,
    pub joined_at_ms: i64,
    pub tx: mpsc::Sender<ServerFrame>,
}

pub struct AuthenticatedJoin {
    pub existing: Vec<PeerHandle>,
    pub others: Vec<mpsc::Sender<ServerFrame>>,
    pub replaced: Option<mpsc::Sender<ServerFrame>>,
}

/// Top-level shared state. Clone freely — both `Arc<Mutex<...>>`. Access is
/// short-lived (no `await` inside the critical section) so the parking_lot
/// mutex is the right primitive.
#[derive(Default)]
pub struct RoomRegistry {
    rooms: Mutex<HashMap<String, Vec<PeerHandle>>>,
    next_peer_id: AtomicU64,
}

impl RoomRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn next_peer_id(&self) -> PeerId {
        self.next_peer_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Add a peer to a room. Returns the snapshot of peers that were
    /// already in the room (to be returned in `Subscribed`) and a list of
    /// the *other* peers' senders so the caller can fan out a
    /// `peerJoined` notification without holding the lock across the await.
    pub fn join(
        &self,
        rendezvous_id: &str,
        handle: PeerHandle,
    ) -> (Vec<PeerHandle>, Vec<mpsc::Sender<ServerFrame>>) {
        let mut rooms = self.rooms.lock();
        let entry = rooms.entry(rendezvous_id.to_string()).or_default();

        let existing = entry.clone();
        let others: Vec<_> = entry.iter().map(|h| h.tx.clone()).collect();
        entry.push(handle);
        (existing, others)
    }

    /// Like [`join`] but gated by the room admission policy
    /// ([`evaluate_subscribe`]). The peer-count / role check and the insert
    /// happen under the same lock so two concurrent `Subscribe`s can't both
    /// slip past a cap. On `Reject` nothing is mutated and the decision is
    /// returned for the caller to turn into a `ServerFrame::Error`.
    pub fn try_join(
        &self,
        rendezvous_id: &str,
        handle: PeerHandle,
        limits: &RoomLimits,
    ) -> Result<(Vec<PeerHandle>, Vec<mpsc::Sender<ServerFrame>>), SubscribeDecision> {
        let mut rooms = self.rooms.lock();
        let entry = rooms.entry(rendezvous_id.to_string()).or_default();

        let existing_roles: Vec<PeerRole> = entry.iter().map(|h| h.role).collect();
        if let SubscribeDecision::Reject { code, message } =
            evaluate_subscribe(&existing_roles, handle.role, limits)
        {
            // Drop a room we just lazily created but won't populate, so a
            // rejected first subscribe doesn't leak an empty entry.
            if entry.is_empty() {
                rooms.remove(rendezvous_id);
            }
            return Err(SubscribeDecision::Reject { code, message });
        }

        let existing = entry.clone();
        let others: Vec<_> = entry.iter().map(|h| h.tx.clone()).collect();
        entry.push(handle);
        Ok((existing, others))
    }

    /// Atomically install the authenticated session for its role. Signaling v2
    /// permits exactly one desktop and one mobile; a newer valid proof replaces
    /// the old socket instead of leaving a stale role lock behind.
    pub fn join_authenticated(&self, rendezvous_id: &str, handle: PeerHandle) -> AuthenticatedJoin {
        let mut rooms = self.rooms.lock();
        let entry = rooms.entry(rendezvous_id.to_string()).or_default();
        let replaced_index = entry.iter().position(|peer| peer.role == handle.role);
        let replaced = replaced_index.map(|index| entry.remove(index).tx);
        let existing = entry.clone();
        let others = entry.iter().map(|peer| peer.tx.clone()).collect();
        entry.push(handle);
        AuthenticatedJoin {
            existing,
            others,
            replaced,
        }
    }

    /// Remove a peer from a room. Returns the other peers' senders so the
    /// caller can emit `peerLeft` to them. If the room becomes empty, the
    /// HashMap entry is dropped.
    pub fn leave(&self, rendezvous_id: &str, peer_id: PeerId) -> Vec<mpsc::Sender<ServerFrame>> {
        let mut rooms = self.rooms.lock();
        let Some(entry) = rooms.get_mut(rendezvous_id) else {
            return Vec::new();
        };
        let before = entry.len();
        entry.retain(|h| h.peer_id != peer_id);
        if entry.len() == before {
            return Vec::new();
        }
        let others: Vec<_> = entry.iter().map(|h| h.tx.clone()).collect();
        if entry.is_empty() {
            rooms.remove(rendezvous_id);
        }
        others
    }

    /// Remove every room a peer is in (called on socket close). Returns the
    /// list of `(room, others)` pairs the caller should announce
    /// `peerLeft` to.
    pub fn leave_all(
        &self,
        peer_id: PeerId,
    ) -> Vec<(String, PeerRole, String, Vec<mpsc::Sender<ServerFrame>>)> {
        let mut rooms = self.rooms.lock();
        let mut announcements: Vec<(String, PeerRole, String, Vec<mpsc::Sender<ServerFrame>>)> =
            Vec::new();
        let mut to_drop: Vec<String> = Vec::new();
        for (rid, peers) in rooms.iter_mut() {
            if let Some(idx) = peers.iter().position(|h| h.peer_id == peer_id) {
                let role = peers[idx].role;
                let session_id = peers[idx].session_id.clone();
                peers.remove(idx);
                let senders: Vec<_> = peers.iter().map(|h| h.tx.clone()).collect();
                if peers.is_empty() {
                    to_drop.push(rid.clone());
                }
                announcements.push((rid.clone(), role, session_id, senders));
            }
        }
        for rid in to_drop {
            rooms.remove(&rid);
        }
        announcements
    }

    /// Snapshot of the senders belonging to every peer in a room *except*
    /// the caller. Used by the relay path.
    pub fn others(&self, rendezvous_id: &str, peer_id: PeerId) -> Option<RelayPeers> {
        let rooms = self.rooms.lock();
        let entry = rooms.get(rendezvous_id)?;
        let sender = entry.iter().find(|h| h.peer_id == peer_id)?;
        let others: Vec<_> = entry
            .iter()
            .filter(|h| h.peer_id != peer_id)
            .map(|h| (h.peer_id, h.tx.clone()))
            .collect();
        Some((sender.role, sender.session_id.clone(), others))
    }

    /// Remove a peer whose bounded outbound queue stopped accepting frames.
    /// The socket task remains alive only long enough to observe that it is no
    /// longer a room member; it cannot relay or receive further room traffic.
    pub fn evict_slow_peer(&self, rendezvous_id: &str, peer_id: PeerId) {
        let mut rooms = self.rooms.lock();
        let Some(entry) = rooms.get_mut(rendezvous_id) else {
            return;
        };
        entry.retain(|peer| peer.peer_id != peer_id);
        if entry.is_empty() {
            rooms.remove(rendezvous_id);
        }
    }

    /// Diagnostic — total rooms and total peers across all rooms.
    pub fn stats(&self) -> RoomRegistryStats {
        let rooms = self.rooms.lock();
        let total_peers: usize = rooms.values().map(Vec::len).sum();
        RoomRegistryStats {
            rooms: rooms.len(),
            peers: total_peers,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RoomRegistryStats {
    pub rooms: usize,
    pub peers: usize,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(reg: &RoomRegistry, role: PeerRole) -> (PeerHandle, mpsc::Receiver<ServerFrame>) {
        let (tx, rx) = mpsc::channel(PEER_OUTBOUND_BUFFER);
        let h = PeerHandle {
            peer_id: reg.next_peer_id(),
            role,
            session_id: format!("session-{}", reg.next_peer_id()),
            proof: SubscribeProofV2 {
                v: 2,
                room_id: "r".into(),
                role,
                session_id: "session".into(),
                epoch: "epoch".into(),
                issued_at: 0,
                challenge: "challenge".into(),
                ecdh_public_key: "key".into(),
                signature: "signature".into(),
            },
            joined_at_ms: 0,
            tx,
        };
        (h, rx)
    }

    #[test]
    fn join_returns_existing_peers() {
        let reg = RoomRegistry::new();
        let (h1, _rx1) = handle(&reg, PeerRole::Desktop);
        let (h2, _rx2) = handle(&reg, PeerRole::Mobile);

        let (existing_a, others_a) = reg.join("r", h1.clone());
        assert!(existing_a.is_empty());
        assert!(others_a.is_empty());

        let (existing_b, others_b) = reg.join("r", h2.clone());
        assert_eq!(existing_b.len(), 1);
        assert_eq!(existing_b[0].role, PeerRole::Desktop);
        assert_eq!(
            others_b.len(),
            1,
            "should notify the desktop that joined first"
        );
    }

    #[test]
    fn leave_announces_to_other_peers_only() {
        let reg = RoomRegistry::new();
        let (h1, _rx1) = handle(&reg, PeerRole::Desktop);
        let (h2, _rx2) = handle(&reg, PeerRole::Mobile);
        reg.join("r", h1.clone());
        reg.join("r", h2.clone());

        let others = reg.leave("r", h2.peer_id);
        assert_eq!(others.len(), 1, "only the desktop should be notified");

        // Leaving an already-empty room is a no-op.
        let others_again = reg.leave("r", h2.peer_id);
        assert!(others_again.is_empty());

        // Leaving a room that was never created is also a no-op.
        assert!(reg.leave("never-existed", 999).is_empty());
    }

    #[test]
    fn leave_all_drops_empty_rooms() {
        let reg = RoomRegistry::new();
        let (h, _rx) = handle(&reg, PeerRole::Desktop);
        let peer_id = h.peer_id;
        reg.join("only", h);
        assert_eq!(reg.stats().rooms, 1);

        let announcements = reg.leave_all(peer_id);
        assert_eq!(announcements.len(), 1);
        assert!(
            announcements[0].3.is_empty(),
            "no other peers were left to notify"
        );
        assert_eq!(reg.stats().rooms, 0);
    }

    #[test]
    fn try_join_rejects_second_desktop() {
        let reg = RoomRegistry::new();
        let limits = RoomLimits::default();
        let (h1, _rx1) = handle(&reg, PeerRole::Desktop);
        let (h2, _rx2) = handle(&reg, PeerRole::Desktop);

        assert!(reg.try_join("r", h1, &limits).is_ok());
        let rejected = reg.try_join("r", h2, &limits);
        match rejected {
            Err(SubscribeDecision::Reject { code, .. }) => assert_eq!(code, "role_taken"),
            _ => panic!("expected role_taken rejection"),
        }
        // The rejected peer was not added.
        assert_eq!(reg.stats().peers, 1);
    }

    #[test]
    fn try_join_rejects_when_room_full() {
        let reg = RoomRegistry::new();
        let limits = RoomLimits {
            max_peers: 2,
            max_desktops: 1,
        };
        let (h1, _rx1) = handle(&reg, PeerRole::Desktop);
        let (h2, _rx2) = handle(&reg, PeerRole::Mobile);
        let (h3, _rx3) = handle(&reg, PeerRole::Mobile);
        assert!(reg.try_join("r", h1, &limits).is_ok());
        assert!(reg.try_join("r", h2, &limits).is_ok());
        match reg.try_join("r", h3, &limits) {
            Err(SubscribeDecision::Reject { code, .. }) => assert_eq!(code, "room_full"),
            _ => panic!("expected room_full rejection"),
        }
        assert_eq!(reg.stats().peers, 2);
    }

    #[test]
    fn try_join_rejecting_first_subscribe_leaves_no_empty_room() {
        let reg = RoomRegistry::new();
        let limits = RoomLimits {
            max_peers: 0,
            max_desktops: 1,
        };
        let (h1, _rx1) = handle(&reg, PeerRole::Desktop);
        assert!(reg.try_join("r", h1, &limits).is_err());
        assert_eq!(reg.stats().rooms, 0, "rejected lazy room must be dropped");
    }

    #[test]
    fn others_excludes_sender() {
        let reg = RoomRegistry::new();
        let (h1, _rx1) = handle(&reg, PeerRole::Desktop);
        let (h2, _rx2) = handle(&reg, PeerRole::Mobile);
        let (h3, _rx3) = handle(&reg, PeerRole::Mobile);
        reg.join("r", h1.clone());
        reg.join("r", h2.clone());
        reg.join("r", h3.clone());

        let (sender_role, _session_id, others) = reg.others("r", h2.peer_id).expect("room exists");
        assert_eq!(sender_role, PeerRole::Mobile);
        assert_eq!(others.len(), 2);
    }

    #[test]
    fn slow_peer_eviction_removes_room_membership() {
        let reg = RoomRegistry::new();
        let (desktop, _desktop_rx) = handle(&reg, PeerRole::Desktop);
        let (mobile, _mobile_rx) = handle(&reg, PeerRole::Mobile);
        reg.join("r", desktop.clone());
        reg.join("r", mobile.clone());

        reg.evict_slow_peer("r", mobile.peer_id);

        let (_, _, targets) = reg.others("r", desktop.peer_id).expect("desktop remains");
        assert!(targets.is_empty());
        assert!(reg.others("r", mobile.peer_id).is_none());
        assert_eq!(reg.stats().peers, 1);
    }

    #[test]
    fn authenticated_join_atomically_replaces_the_same_role() {
        let reg = RoomRegistry::new();
        let (old, _old_rx) = handle(&reg, PeerRole::Desktop);
        let (mobile, _mobile_rx) = handle(&reg, PeerRole::Mobile);
        let (replacement, _replacement_rx) = handle(&reg, PeerRole::Desktop);
        reg.join_authenticated("r", old);
        reg.join_authenticated("r", mobile);

        let joined = reg.join_authenticated("r", replacement);
        assert!(joined.replaced.is_some());
        assert_eq!(joined.existing.len(), 1);
        assert_eq!(joined.existing[0].role, PeerRole::Mobile);
        assert_eq!(reg.stats().peers, 2);
    }
}
