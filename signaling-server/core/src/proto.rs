//! Wire protocol between signaling clients and the rendezvous service.
//!
//! Two layers:
//!
//! 1. **Server-visible envelope** ([`ClientFrame`] / [`ServerFrame`]). Routes
//!    by `rendezvous_id`. The server reads `kind` to decide whether to
//!    update the room registry, forward a relay, or reply with `pong`.
//!
//! 2. **Application payload** ([`Envelope`]). Embedded as opaque
//!    base64 inside `ClientFrame::Relay::payload` / `ServerFrame::Relay::payload`.
//!    The signaling server **never** parses this — it forwards the bytes
//!    verbatim. Both peers verify the HMAC-SHA256 inside `Envelope::mac` with
//!    the shared `rendezvous_secret` minted at pair time (ADR-0021).
//!
//! All field names use `camelCase` so the same shapes round-trip through the
//! TypeScript client without translation glue.

use serde::{Deserialize, Serialize};

/// Role identifier for a peer in a rendezvous room. There is exactly one
/// `Desktop` per room (the home server) and zero-or-one `Mobile` per
/// connected client — extra members are tolerated by the router but ignored
/// by application-level peers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerRole {
    Desktop,
    Mobile,
}

impl PeerRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            PeerRole::Desktop => "desktop",
            PeerRole::Mobile => "mobile",
        }
    }

    /// Parse a role off the wire. Only the two canonical values are accepted;
    /// anything else is a protocol violation the caller must drop (the
    /// signaling server only ever routes `"desktop"` / `"mobile"`).
    pub fn from_wire(s: &str) -> Option<PeerRole> {
        match s {
            "desktop" => Some(PeerRole::Desktop),
            "mobile" => Some(PeerRole::Mobile),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Client → server frames
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientFrame {
    /// Join the named rendezvous room as `role`. The server replies with
    /// [`ServerFrame::Subscribed`] and emits [`ServerFrame::PeerJoined`] to
    /// any existing members. Sending `subscribe` twice for the same room on
    /// the same socket is a no-op (the server tracks at-most-one
    /// `(socket, rendezvousId)` subscription).
    Subscribe {
        rendezvous_id: String,
        role: PeerRole,
        /// 16-byte URL-safe-base64 nonce, fresh per connection. Logged for
        /// debugging; the server does not validate it.
        client_nonce: String,
    },
    /// Leave a room. Idempotent.
    Unsubscribe { rendezvous_id: String },
    /// Forward an opaque payload to every other subscriber of
    /// `rendezvous_id`. The server does not parse `payload`; receivers run
    /// the HMAC check (see [`Envelope`]).
    Relay {
        rendezvous_id: String,
        /// Base64url-encoded application envelope. The 8 KiB per-frame cap is
        /// enforced in `ws::handle_socket` (`MAX_FRAME_BYTES`), backed by a
        /// hard `max_message_size` on the WS upgrade — `tower-http`'s body
        /// limit only bounds the pre-upgrade handshake, not WS frames.
        payload: String,
    },
    /// Application-level keepalive. Server replies with [`ServerFrame::Pong`].
    /// WebSocket frame pings still apply but are handled by `axum::extract::ws`
    /// transparently.
    Ping,
}

// ---------------------------------------------------------------------------
// Server → client frames
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerFrame {
    /// Confirms a `subscribe` and lists the peers already in the room.
    Subscribed {
        rendezvous_id: String,
        peers: Vec<PeerSnapshot>,
    },
    /// A new peer joined an existing room. Emitted to every other member.
    PeerJoined {
        rendezvous_id: String,
        role: PeerRole,
    },
    /// A peer left (explicit unsubscribe or socket close).
    PeerLeft {
        rendezvous_id: String,
        role: PeerRole,
    },
    /// Forwarded relay from another peer in the room.
    Relay {
        rendezvous_id: String,
        from_role: PeerRole,
        payload: String,
    },
    /// Reply to a `Ping`.
    Pong,
    /// Recoverable protocol error. The connection is **not** closed on the
    /// server side — the client can retry.
    Error { code: String, message: String },
}

/// Snapshot of a peer already in a room, returned alongside `Subscribed`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerSnapshot {
    pub role: PeerRole,
    /// Wall-clock ms of when the peer joined the room.
    pub joined_at_ms: i64,
}

// ---------------------------------------------------------------------------
// Application envelope (opaque to the signaling server)
// ---------------------------------------------------------------------------

/// End-to-end signed payload exchanged inside `Relay.payload` between the
/// two peers in a rendezvous room. Both desktop and mobile build / verify
/// this struct locally; the signaling service only sees the base64-encoded
/// JSON. ADR-0021 §"Application payload".
///
/// Replay protection rules (enforced by the receiver):
/// - `ts` must be within ±5 minutes of the receiver's wall clock.
/// - `seq` must be strictly greater than the previous `seq` from the same
///   `(rendezvousId, sender)` pair (or `nonce` must be fresh — both checks
///   are applied independently against a 256-entry LRU).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub ver: u8,
    pub ts: i64,
    pub nonce: String,
    pub seq: u64,
    pub kind: EnvelopeKind,
    pub body: serde_json::Value,
    /// HMAC-SHA256 (URL-safe base64, no padding) over canonical JSON of all
    /// preceding fields with `mac: ""`.
    pub mac: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvelopeKind {
    Hello,
    #[serde(rename = "rtc:offer")]
    RtcOffer,
    #[serde(rename = "rtc:answer")]
    RtcAnswer,
    #[serde(rename = "rtc:ice")]
    RtcIce,
    #[serde(rename = "rtc:close")]
    RtcClose,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribe_round_trips() {
        let frame = ClientFrame::Subscribe {
            rendezvous_id: "r1".into(),
            role: PeerRole::Mobile,
            client_nonce: "n1".into(),
        };
        let json = serde_json::to_string(&frame).unwrap();
        // camelCase + tagged kind.
        assert!(json.contains("\"kind\":\"subscribe\""));
        assert!(json.contains("\"rendezvousId\":\"r1\""));
        assert!(json.contains("\"role\":\"mobile\""));
        let decoded: ClientFrame = serde_json::from_str(&json).unwrap();
        match decoded {
            ClientFrame::Subscribe {
                rendezvous_id,
                role,
                client_nonce,
            } => {
                assert_eq!(rendezvous_id, "r1");
                assert_eq!(role, PeerRole::Mobile);
                assert_eq!(client_nonce, "n1");
            }
            _ => panic!("unexpected variant"),
        }
    }

    #[test]
    fn relay_round_trips() {
        let frame = ClientFrame::Relay {
            rendezvous_id: "r1".into(),
            payload: "AAAA".into(),
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"kind\":\"relay\""));
        let decoded: ClientFrame = serde_json::from_str(&json).unwrap();
        match decoded {
            ClientFrame::Relay { payload, .. } => assert_eq!(payload, "AAAA"),
            _ => panic!("unexpected variant"),
        }
    }

    #[test]
    fn server_frame_peer_joined_round_trips() {
        let frame = ServerFrame::PeerJoined {
            rendezvous_id: "r1".into(),
            role: PeerRole::Desktop,
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"kind\":\"peerJoined\""));
        let decoded: ServerFrame = serde_json::from_str(&json).unwrap();
        match decoded {
            ServerFrame::PeerJoined { role, .. } => assert_eq!(role, PeerRole::Desktop),
            _ => panic!("unexpected variant"),
        }
    }

    #[test]
    fn envelope_kind_uses_rtc_prefix() {
        let json = serde_json::to_string(&EnvelopeKind::RtcOffer).unwrap();
        assert_eq!(json, "\"rtc:offer\"");
        let json = serde_json::to_string(&EnvelopeKind::Hello).unwrap();
        assert_eq!(json, "\"hello\"");
    }

    #[test]
    fn peer_role_as_str_maps_to_wire_values() {
        // `as_str` is only invoked inside `tracing` macros at runtime (which
        // skip argument evaluation when no subscriber is attached), so pin the
        // role→wire mapping here directly.
        assert_eq!(PeerRole::Desktop.as_str(), "desktop");
        assert_eq!(PeerRole::Mobile.as_str(), "mobile");
    }

    #[test]
    fn peer_role_from_wire_parses_canonical_only() {
        assert_eq!(PeerRole::from_wire("desktop"), Some(PeerRole::Desktop));
        assert_eq!(PeerRole::from_wire("mobile"), Some(PeerRole::Mobile));
        assert_eq!(PeerRole::from_wire("DESKTOP"), None);
        assert_eq!(PeerRole::from_wire(""), None);
        assert_eq!(PeerRole::from_wire("server"), None);
    }
}
