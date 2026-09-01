//! Canonical binary protocol shared by local, LAN, and WAN terminal
//! transports. Payloads are opaque to the framing layer: stream frames carry
//! raw bytes while command/event frames carry UTF-8 JSON.
//!
//! # Compatibility invariant
//!
//! **The host never volunteers a frame kind the client did not solicit.**
//! Clients reject unknown discriminants outright (`lib/terminal/protocol.ts`
//! throws on one), so a newer host serving an older mobile client would break
//! the session the moment it pushed a kind that client had never heard of.
//! Concretely: [`FrameKind::FlowControl`] is client→host only,
//! [`FrameKind::HistorySnapshot`] only ever answers a
//! [`FrameKind::HistoryQuery`], and [`FrameKind::TransportState`] has been in
//! both enums since the first release. Adding a *pushed* kind in the future
//! requires negotiating it through the `Hello` ack's `protocolFeatures` first.
//!
//! Discriminants are frozen — `frame_kind_discriminants_are_frozen` pins every
//! one of them, because the TypeScript mirror and the on-disk wire fixture both
//! encode the numbers rather than the names.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const MAGIC: [u8; 4] = *b"CGTH";
pub const HEADER_LEN: usize = 35;
pub const MAX_FRAME_PAYLOAD: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
#[serde(rename_all = "camelCase")]
pub enum FrameKind {
    Hello = 1,
    List = 2,
    Spawn = 3,
    Attach = 4,
    Detach = 5,
    TakeControl = 6,
    ReleaseControl = 7,
    Resize = 8,
    Kill = 9,
    Ack = 10,
    Stdin = 11,
    Stdout = 12,
    HostSnapshot = 13,
    SessionSnapshot = 14,
    Integration = 15,
    ControllerChanged = 16,
    ReplayGap = 17,
    TransportState = 18,
    Exit = 19,
    Error = 20,
    /// Client→host only. Asks the host to park (or unpark) a session's reader
    /// so a renderer that cannot keep up stops the producer instead of being
    /// dropped for queue overflow. Answered with [`FrameKind::Ack`].
    FlowControl = 21,
    /// Client→host request for a session's command ring and/or the host audit
    /// log. Answered with [`FrameKind::HistorySnapshot`].
    HistoryQuery = 22,
    /// Host→client response to [`FrameKind::HistoryQuery`]. Never pushed.
    HistorySnapshot = 23,
    /// Client→host request to read, start, or stop a session's SSH port
    /// forwards. Answered with [`FrameKind::SshForwardSnapshot`].
    ///
    /// Deliberately pull-only. The forwarding UI polls while it is open rather
    /// than being pushed at, so an older client that never asks is never sent a
    /// kind it cannot decode — the compatibility invariant above.
    SshForwardControl = 24,
    /// Host→client response to [`FrameKind::SshForwardControl`]. Never pushed.
    SshForwardSnapshot = 25,
    /// Client to host request to browse or transfer files over a saved SSH
    /// profile (ADR-0162). Answered with [`FrameKind::SftpSnapshot`].
    ///
    /// Host-local only. `TerminalHost` refuses this frame on a connection that
    /// is not local, exactly as it refuses `update_config`, so a device that
    /// reaches `/ws/terminal` with `terminal.open` gains nothing from it. The
    /// device-facing surface is the `sftp_*` RPC family, which authorizes with
    /// its own `ssh.files` capability and then talks to this frame as a local
    /// client. `lib/terminal/protocol.ts` deliberately does not mirror 26 or
    /// 27: a device receiving one has been handed a frame that means nothing
    /// on its plane, and rejecting it is the correct answer.
    SftpControl = 26,
    /// Host to client response to [`FrameKind::SftpControl`]. Never pushed.
    SftpSnapshot = 27,
}

impl TryFrom<u8> for FrameKind {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self, ProtocolError> {
        Ok(match value {
            1 => Self::Hello,
            2 => Self::List,
            3 => Self::Spawn,
            4 => Self::Attach,
            5 => Self::Detach,
            6 => Self::TakeControl,
            7 => Self::ReleaseControl,
            8 => Self::Resize,
            9 => Self::Kill,
            10 => Self::Ack,
            11 => Self::Stdin,
            12 => Self::Stdout,
            13 => Self::HostSnapshot,
            14 => Self::SessionSnapshot,
            15 => Self::Integration,
            16 => Self::ControllerChanged,
            17 => Self::ReplayGap,
            18 => Self::TransportState,
            19 => Self::Exit,
            20 => Self::Error,
            21 => Self::FlowControl,
            22 => Self::HistoryQuery,
            23 => Self::HistorySnapshot,
            24 => Self::SshForwardControl,
            25 => Self::SshForwardSnapshot,
            26 => Self::SftpControl,
            27 => Self::SftpSnapshot,
            other => return Err(ProtocolError::UnknownFrameKind(other)),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FrameFlags(u16);

impl FrameFlags {
    pub const NONE: Self = Self(0);
    pub const ACK_REQUIRED: Self = Self(1 << 0);
    pub const END_OF_MESSAGE: Self = Self(1 << 1);

    pub const fn bits(self) -> u16 {
        self.0
    }

    pub const fn from_bits(bits: u16) -> Self {
        Self(bits)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalFrame {
    pub kind: FrameKind,
    pub flags: FrameFlags,
    pub session_id: Uuid,
    pub sequence: u64,
    pub payload: Vec<u8>,
}

impl TerminalFrame {
    pub fn command(kind: FrameKind, session_id: Uuid, sequence: u64, payload: Vec<u8>) -> Self {
        Self {
            kind,
            flags: FrameFlags::END_OF_MESSAGE,
            session_id,
            sequence,
            payload,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        if self.payload.len() > MAX_FRAME_PAYLOAD {
            return Err(ProtocolError::PayloadTooLarge {
                length: self.payload.len(),
                maximum: MAX_FRAME_PAYLOAD,
            });
        }
        let mut bytes = Vec::with_capacity(HEADER_LEN + self.payload.len());
        bytes.extend_from_slice(&MAGIC);
        bytes.push(self.kind as u8);
        bytes.extend_from_slice(&self.flags.bits().to_be_bytes());
        bytes.extend_from_slice(self.session_id.as_bytes());
        bytes.extend_from_slice(&self.sequence.to_be_bytes());
        bytes.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&self.payload);
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() < HEADER_LEN {
            return Err(ProtocolError::Truncated {
                expected: HEADER_LEN,
                actual: bytes.len(),
            });
        }
        if bytes[..4] != MAGIC {
            return Err(ProtocolError::InvalidMagic);
        }
        let kind = FrameKind::try_from(bytes[4])?;
        let flags = FrameFlags::from_bits(u16::from_be_bytes([bytes[5], bytes[6]]));
        let session_id =
            Uuid::from_slice(&bytes[7..23]).map_err(|_| ProtocolError::InvalidSessionId)?;
        let sequence = u64::from_be_bytes(bytes[23..31].try_into().expect("fixed slice"));
        let payload_len =
            u32::from_be_bytes(bytes[31..35].try_into().expect("fixed slice")) as usize;
        if payload_len > MAX_FRAME_PAYLOAD {
            return Err(ProtocolError::PayloadTooLarge {
                length: payload_len,
                maximum: MAX_FRAME_PAYLOAD,
            });
        }
        let expected = HEADER_LEN + payload_len;
        if bytes.len() != expected {
            return Err(ProtocolError::Truncated {
                expected,
                actual: bytes.len(),
            });
        }
        Ok(Self {
            kind,
            flags,
            session_id,
            sequence,
            payload: bytes[HEADER_LEN..].to_vec(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProtocolError {
    #[error("invalid terminal host magic")]
    InvalidMagic,
    #[error("unknown terminal frame kind {0}")]
    UnknownFrameKind(u8),
    #[error("invalid terminal session id")]
    InvalidSessionId,
    #[error("terminal frame is truncated: expected {expected} bytes, received {actual}")]
    Truncated { expected: usize, actual: usize },
    #[error("terminal payload is {length} bytes; maximum is {maximum}")]
    PayloadTooLarge { length: usize, maximum: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalErrorCode {
    NotController,
    PermissionDenied,
    ReplayGap,
    ResourceLimit,
    HostOffline,
    Unpaired,
    Unauthorized,
    SessionNotFound,
    InvalidRequest,
    QueueOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use uuid::Uuid;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        kind: u8,
        flags: u16,
        session_id: String,
        sequence: String,
        payload_utf8: String,
        encoded_hex: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixtures {
        stdout_hello: Fixture,
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                u8::from_str_radix(std::str::from_utf8(pair).expect("fixture hex"), 16)
                    .expect("fixture byte")
            })
            .collect()
    }

    #[test]
    fn frame_roundtrip_matches_terminal_header_layout() {
        let frame = TerminalFrame {
            kind: FrameKind::Stdout,
            flags: FrameFlags::ACK_REQUIRED,
            session_id: Uuid::parse_str("00112233-4455-6677-8899-aabbccddeeff").unwrap(),
            sequence: 0x0102_0304_0506_0708,
            payload: b"hello".to_vec(),
        };

        let encoded = frame.encode().unwrap();
        assert_eq!(&encoded[..4], b"CGTH");
        assert_eq!(encoded.len(), HEADER_LEN + 5);
        assert_eq!(TerminalFrame::decode(&encoded).unwrap(), frame);
    }

    #[test]
    fn shared_typescript_fixture_matches_byte_for_byte() {
        let fixtures: Fixtures =
            serde_json::from_str(include_str!("../../../protocol/terminal-fixtures.json")).unwrap();
        let fixture = fixtures.stdout_hello;
        let frame = TerminalFrame {
            kind: FrameKind::try_from(fixture.kind).unwrap(),
            flags: FrameFlags::from_bits(fixture.flags),
            session_id: Uuid::parse_str(&fixture.session_id).unwrap(),
            sequence: fixture.sequence.parse().unwrap(),
            payload: fixture.payload_utf8.into_bytes(),
        };
        let bytes = decode_hex(&fixture.encoded_hex);
        assert_eq!(frame.encode().unwrap(), bytes);
        assert_eq!(TerminalFrame::decode(&bytes).unwrap(), frame);
    }

    /// Every discriminant in 1..=27 must survive the `u8` round trip, and the
    /// first unassigned value must be rejected rather than silently accepted —
    /// `decode` relies on this to reject a frame from a newer peer.
    #[test]
    fn every_frame_kind_round_trips_through_its_discriminant() {
        for value in 1u8..=27 {
            let kind = FrameKind::try_from(value)
                .unwrap_or_else(|error| panic!("discriminant {value} is unmapped: {error}"));
            assert_eq!(kind as u8, value);
        }
        assert_eq!(
            FrameKind::try_from(28),
            Err(ProtocolError::UnknownFrameKind(28))
        );
        assert_eq!(
            FrameKind::try_from(0),
            Err(ProtocolError::UnknownFrameKind(0))
        );
    }

    /// The TypeScript mirror (`lib/terminal/protocol.ts`) and the shared wire
    /// fixture both encode numbers, so renumbering here would break every
    /// already-installed client. Pin each value explicitly.
    #[test]
    fn frame_kind_discriminants_are_frozen() {
        assert_eq!(FrameKind::Hello as u8, 1);
        assert_eq!(FrameKind::List as u8, 2);
        assert_eq!(FrameKind::Spawn as u8, 3);
        assert_eq!(FrameKind::Attach as u8, 4);
        assert_eq!(FrameKind::Detach as u8, 5);
        assert_eq!(FrameKind::TakeControl as u8, 6);
        assert_eq!(FrameKind::ReleaseControl as u8, 7);
        assert_eq!(FrameKind::Resize as u8, 8);
        assert_eq!(FrameKind::Kill as u8, 9);
        assert_eq!(FrameKind::Ack as u8, 10);
        assert_eq!(FrameKind::Stdin as u8, 11);
        assert_eq!(FrameKind::Stdout as u8, 12);
        assert_eq!(FrameKind::HostSnapshot as u8, 13);
        assert_eq!(FrameKind::SessionSnapshot as u8, 14);
        assert_eq!(FrameKind::Integration as u8, 15);
        assert_eq!(FrameKind::ControllerChanged as u8, 16);
        assert_eq!(FrameKind::ReplayGap as u8, 17);
        assert_eq!(FrameKind::TransportState as u8, 18);
        assert_eq!(FrameKind::Exit as u8, 19);
        assert_eq!(FrameKind::Error as u8, 20);
        assert_eq!(FrameKind::FlowControl as u8, 21);
        assert_eq!(FrameKind::HistoryQuery as u8, 22);
        assert_eq!(FrameKind::HistorySnapshot as u8, 23);
        assert_eq!(FrameKind::SshForwardControl as u8, 24);
        assert_eq!(FrameKind::SshForwardSnapshot as u8, 25);
        assert_eq!(FrameKind::SftpControl as u8, 26);
        assert_eq!(FrameKind::SftpSnapshot as u8, 27);
    }

    #[test]
    fn rejects_wrong_magic_and_truncated_payload() {
        let mut bytes = TerminalFrame::command(FrameKind::Hello, Uuid::nil(), 1, b"{}".to_vec())
            .encode()
            .unwrap();
        bytes[0] = b'X';
        assert_eq!(
            TerminalFrame::decode(&bytes),
            Err(ProtocolError::InvalidMagic)
        );

        let valid = TerminalFrame::command(FrameKind::List, Uuid::nil(), 2, Vec::new())
            .encode()
            .unwrap();
        assert!(matches!(
            TerminalFrame::decode(&valid[..valid.len() - 1]),
            Err(ProtocolError::Truncated { .. })
        ));
    }
}
