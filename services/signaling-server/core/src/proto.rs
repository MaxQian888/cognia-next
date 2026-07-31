//! Wire protocol between signaling clients and the rendezvous service.
//!
//! [`ClientFrame`] and [`ServerFrame`] are the server-visible routing layer.
//! The application payload is a serialized [`SignalingEnvelopeV2`] containing
//! only authenticated metadata and AES-GCM ciphertext. The relay forwards it
//! without access to SDP or ICE plaintext.
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

/// Self-certifying room material for the only supported signaling protocol.
/// The room id is SHA-256 over the length-prefixed canonical fields; the
/// descriptor contains public keys only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDescriptorV2 {
    pub v: u8,
    pub room_id: String,
    pub room_nonce: String,
    pub desktop_signing_key: String,
    pub mobile_signing_key: String,
    pub not_after: i64,
}

/// Role-authenticated, challenge-bound session advertisement. The ECDH key is
/// ephemeral and its signature is forwarded to the peer in snapshots so the
/// untrusted relay cannot substitute a key or sender role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeProofV2 {
    pub v: u8,
    pub room_id: String,
    pub role: PeerRole,
    pub session_id: String,
    pub epoch: String,
    pub issued_at: i64,
    pub challenge: String,
    pub ecdh_public_key: String,
    pub signature: String,
}

/// End-to-end encrypted relay payload. The rendezvous service can route and
/// bound this object but cannot decrypt `ciphertext`. Every visible field is
/// authenticated by both ECDSA and AES-GCM additional data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalingEnvelopeV2 {
    pub v: u8,
    pub room_id: String,
    pub sender_role: PeerRole,
    pub session_id: String,
    pub epoch: String,
    pub seq: u64,
    pub issued_at: i64,
    pub kind: EnvelopeKind,
    pub nonce: String,
    pub ciphertext: String,
    pub signature: String,
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
    /// Join the self-certifying room after receiving a server challenge.
    /// Admission validates the descriptor hash and the role's ECDSA proof.
    Subscribe {
        descriptor: Box<RoomDescriptorV2>,
        proof: Box<SubscribeProofV2>,
    },
    /// Leave a room. Idempotent.
    Unsubscribe { rendezvous_id: String },
    /// Forward an opaque payload to every other subscriber of
    /// `rendezvous_id`. The server does not parse `payload`; receivers verify
    /// the v2 ECDSA signature and AES-GCM authentication.
    Relay {
        rendezvous_id: String,
        /// Serialized v2 application envelope. The per-frame cap is
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
    /// Fresh per-socket challenge. A client must bind this into its signed
    /// subscribe proof before the deadline.
    Challenge {
        challenge: String,
        issued_at: i64,
        expires_at: i64,
    },
    /// Confirms a `subscribe` and lists the peers already in the room.
    Subscribed {
        rendezvous_id: String,
        peers: Vec<PeerSnapshot>,
    },
    /// A new peer joined an existing room. Emitted to every other member.
    PeerJoined {
        rendezvous_id: String,
        peer: PeerSnapshot,
    },
    /// A peer left (explicit unsubscribe or socket close).
    PeerLeft {
        rendezvous_id: String,
        role: PeerRole,
        session_id: String,
    },
    /// Forwarded relay from another peer in the room.
    Relay {
        rendezvous_id: String,
        from_role: PeerRole,
        from_session_id: String,
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
    pub proof: SubscribeProofV2,
    /// Wall-clock ms of when the peer joined the room.
    pub joined_at_ms: i64,
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
        let descriptor = RoomDescriptorV2 {
            v: 2,
            room_id: "r1".into(),
            room_nonce: "nonce".into(),
            desktop_signing_key: "desktop-key".into(),
            mobile_signing_key: "mobile-key".into(),
            not_after: 1_800_000_000_000,
        };
        let frame = ClientFrame::Subscribe {
            descriptor: Box::new(descriptor),
            proof: Box::new(SubscribeProofV2 {
                v: 2,
                room_id: "r1".into(),
                role: PeerRole::Mobile,
                session_id: "s1".into(),
                epoch: "e1".into(),
                issued_at: 1_700_000_000_000,
                challenge: "c1".into(),
                ecdh_public_key: "k1".into(),
                signature: "sig".into(),
            }),
        };
        let json = serde_json::to_string(&frame).unwrap();
        // camelCase + tagged kind.
        assert!(json.contains("\"kind\":\"subscribe\""));
        assert!(json.contains("\"roomId\":\"r1\""));
        assert!(json.contains("\"role\":\"mobile\""));
        let decoded: ClientFrame = serde_json::from_str(&json).unwrap();
        match decoded {
            ClientFrame::Subscribe { descriptor, proof } => {
                assert_eq!(descriptor.room_id, "r1");
                assert_eq!(proof.role, PeerRole::Mobile);
                assert_eq!(proof.session_id, "s1");
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
            peer: PeerSnapshot {
                proof: SubscribeProofV2 {
                    v: 2,
                    room_id: "r1".into(),
                    role: PeerRole::Desktop,
                    session_id: "s1".into(),
                    epoch: "e1".into(),
                    issued_at: 1_700_000_000_000,
                    challenge: "c1".into(),
                    ecdh_public_key: "k1".into(),
                    signature: "sig".into(),
                },
                joined_at_ms: 1_700_000_000_000,
            },
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"kind\":\"peerJoined\""));
        let decoded: ServerFrame = serde_json::from_str(&json).unwrap();
        match decoded {
            ServerFrame::PeerJoined { peer, .. } => {
                assert_eq!(peer.proof.role, PeerRole::Desktop)
            }
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
