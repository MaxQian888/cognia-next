//! Canonical binary protocol shared by local, LAN, and WAN terminal
//! transports. Payloads are opaque to the framing layer: stream frames carry
//! raw bytes while command/event frames carry UTF-8 JSON.

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
