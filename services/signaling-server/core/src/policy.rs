//! Room admission policy — pure decision logic shared by the axum server and
//! the Cloudflare Worker.
//!
//! The two backends store room membership differently (an in-process
//! `Vec<PeerHandle>` vs. Durable Object WebSocket attachments), but the *rules*
//! for whether a `Subscribe` is allowed — peer cap, one-desktop-per-room — must
//! be identical or clients see different behavior depending on the deployment.
//! Keeping the rules here means they are unit-tested once (this crate runs
//! `cargo test` natively; the Worker compiles to wasm and cannot) and both
//! transports call the same function, so they can never drift.
//!
//! Strictly `serde`-free and allocation-light so it compiles unchanged to
//! `wasm32-unknown-unknown`.

use crate::proto::PeerRole;

/// Stable wire error code for a frame whose `rendezvousId` does not match the
/// room selected by the WebSocket upgrade URL (`?rid=`).
pub const ROOM_MISMATCH_CODE: &str = "room_mismatch";

/// Stable human-readable message paired with [`ROOM_MISMATCH_CODE`].
pub const ROOM_MISMATCH_MESSAGE: &str = "rendezvous id does not match upgrade room";

/// Whether a server-visible frame is scoped to the room selected by the
/// WebSocket upgrade URL. The Worker must know the room before accepting the
/// socket, so every later frame must repeat the same id in its `rendezvousId`
/// field. Empty ids never match.
pub fn rendezvous_id_matches_upgrade_room(upgrade_room_id: &str, frame_room_id: &str) -> bool {
    !upgrade_room_id.is_empty() && upgrade_room_id == frame_room_id
}

#[cfg(test)]
mod rendezvous_id_tests {
    use super::*;

    #[test]
    fn rendezvous_id_must_match_the_upgrade_room() {
        assert!(rendezvous_id_matches_upgrade_room("room-a", "room-a"));
        assert!(!rendezvous_id_matches_upgrade_room("room-a", "room-b"));
        assert!(!rendezvous_id_matches_upgrade_room("", "room-a"));
        assert!(!rendezvous_id_matches_upgrade_room("room-a", ""));
    }
}

/// Per-room admission limits. Defaults match the ADR-0021 intent (one desktop
/// home server + one mobile client) with slack for reconnect overlap, where an
/// old socket may still be counted until its `close` event fires.
#[derive(Debug, Clone, Copy)]
pub struct RoomLimits {
    /// Maximum total peers admitted to a room. A `Subscribe` past this is
    /// rejected with `room_full`.
    pub max_peers: usize,
    /// Maximum `Desktop` peers in a room. A second desktop `Subscribe` is
    /// rejected with `role_taken`.
    pub max_desktops: usize,
}

impl Default for RoomLimits {
    fn default() -> Self {
        Self {
            max_peers: 2,
            max_desktops: 1,
        }
    }
}

/// Outcome of evaluating a `Subscribe` against the current room composition.
/// `Reject` carries the stable wire `code` and human `message` that go straight
/// into a `ServerFrame::Error` — both backends emit it identically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscribeDecision {
    Accept,
    Reject {
        code: &'static str,
        message: &'static str,
    },
}

/// Decide whether a peer with `new_role` may join a room that already holds
/// `existing_roles` (the roles of the *other* already-subscribed peers, not
/// counting the joining connection).
///
/// Order matters: the peer cap is checked first so a flooded room reports
/// `room_full` rather than `role_taken`.
pub fn evaluate_subscribe(
    existing_roles: &[PeerRole],
    new_role: PeerRole,
    limits: &RoomLimits,
) -> SubscribeDecision {
    if existing_roles.len() >= limits.max_peers {
        return SubscribeDecision::Reject {
            code: "room_full",
            message: "rendezvous room is full",
        };
    }
    if new_role == PeerRole::Desktop {
        let desktops = existing_roles
            .iter()
            .filter(|r| **r == PeerRole::Desktop)
            .count();
        if desktops >= limits.max_desktops {
            return SubscribeDecision::Reject {
                code: "role_taken",
                message: "a desktop peer already owns this room",
            };
        }
    }
    SubscribeDecision::Accept
}

/// Whether a WebSocket upgrade carrying `origin` is allowed given `allowlist`.
///
/// - An empty `allowlist` allows everything (the opt-in default — no behavior
///   change until an operator configures origins).
/// - A missing `origin` is allowed: native clients (the desktop
///   `tokio-tungstenite` signaling client) do not send an `Origin` header, and
///   the header cannot be forged by browser JS, so this check only meaningfully
///   gates browser/webview contexts.
/// - Otherwise the origin must match an allowlist entry exactly.
pub fn is_origin_allowed(origin: Option<&str>, allowlist: &[String]) -> bool {
    if allowlist.is_empty() {
        return true;
    }
    match origin {
        None => true,
        Some(origin) => allowlist.iter().any(|allowed| allowed == origin),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn reject_code(d: SubscribeDecision) -> Option<&'static str> {
        match d {
            SubscribeDecision::Reject { code, .. } => Some(code),
            SubscribeDecision::Accept => None,
        }
    }

    #[test]
    fn empty_room_accepts_either_role() {
        let limits = RoomLimits::default();
        assert_eq!(
            evaluate_subscribe(&[], PeerRole::Desktop, &limits),
            SubscribeDecision::Accept
        );
        assert_eq!(
            evaluate_subscribe(&[], PeerRole::Mobile, &limits),
            SubscribeDecision::Accept
        );
    }

    #[test]
    fn second_desktop_is_role_taken() {
        let limits = RoomLimits::default();
        let decision = evaluate_subscribe(&[PeerRole::Desktop], PeerRole::Desktop, &limits);
        assert_eq!(reject_code(decision), Some("role_taken"));
    }

    #[test]
    fn mobile_joins_alongside_desktop() {
        let limits = RoomLimits::default();
        assert_eq!(
            evaluate_subscribe(&[PeerRole::Desktop], PeerRole::Mobile, &limits),
            SubscribeDecision::Accept
        );
    }

    #[test]
    fn extra_mobile_is_rejected_at_the_two_peer_cap() {
        let limits = RoomLimits::default(); // one desktop + one mobile
        let roles = [PeerRole::Desktop, PeerRole::Mobile];
        assert_eq!(
            reject_code(evaluate_subscribe(&roles, PeerRole::Mobile, &limits)),
            Some("room_full")
        );
    }

    #[test]
    fn full_room_is_room_full_even_for_first_desktop() {
        // Peer cap is checked before the role rule: a room with no desktop but
        // already at capacity rejects with room_full, not role_taken.
        let limits = RoomLimits {
            max_peers: 2,
            max_desktops: 1,
        };
        let roles = [PeerRole::Mobile, PeerRole::Mobile];
        let decision = evaluate_subscribe(&roles, PeerRole::Desktop, &limits);
        assert_eq!(reject_code(decision), Some("room_full"));
    }

    #[test]
    fn origin_empty_allowlist_allows_all() {
        assert!(is_origin_allowed(Some("https://evil.example"), &[]));
        assert!(is_origin_allowed(None, &[]));
    }

    #[test]
    fn origin_missing_is_allowed_for_native_clients() {
        let allow = vec!["https://app.cognia.cn".to_string()];
        assert!(is_origin_allowed(None, &allow));
    }

    #[test]
    fn origin_must_match_when_configured() {
        let allow = vec![
            "https://app.cognia.cn".to_string(),
            "capacitor://localhost".to_string(),
        ];
        assert!(is_origin_allowed(Some("https://app.cognia.cn"), &allow));
        assert!(is_origin_allowed(Some("capacitor://localhost"), &allow));
        assert!(!is_origin_allowed(Some("https://evil.example"), &allow));
    }
}
