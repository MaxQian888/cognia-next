//! Connect protocol framing for envd's process service (JSON codec).
//!
//! envd serves `process.Process` with connect-go. A server-streaming call
//! (`Start`) is one POST whose request body is a single enveloped message and
//! whose response body is a stream of envelopes:
//!
//! ```text
//! flags (1 byte) | length (4 bytes, big-endian) | payload (length bytes)
//! ```
//!
//! Flag `0x02` marks the end-of-stream message: a JSON object carrying the
//! call's error, if it failed. Flag `0x01` marks a compressed payload, which
//! this client never negotiates (it sends no `Connect-Accept-Encoding`) and so
//! refuses. Envelopes arrive split across, and merged within, transport
//! chunks; the decoder reassembles them. Unary calls (`SendInput`,
//! `CloseStdin`) are plain JSON bodies whose errors are non-200 statuses.

use std::fmt;

use serde::Deserialize;

/// The payload is compressed.
pub const FLAG_COMPRESSED: u8 = 0x01;
/// The end-of-stream message.
pub const FLAG_END_STREAM: u8 = 0x02;
/// The largest message accepted. envd's data events carry one pipe read
/// (32 KiB); anything near this ceiling is a broken peer.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const HEADER_LEN: usize = 5;

/// One request message, enveloped with no flags.
pub fn encode_envelope(payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len()).expect("request messages are small");
    let mut frame = Vec::with_capacity(HEADER_LEN + payload.len());
    frame.push(0);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// A Connect error: a code (`not_found`, `unauthenticated`, …) and a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectError {
    pub code: String,
    pub message: String,
}

impl fmt::Display for ConnectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.code.is_empty(), self.message.is_empty()) {
            (true, true) => f.write_str("unknown error"),
            (false, true) => f.write_str(&self.code),
            (true, false) => f.write_str(&self.message),
            (false, false) => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

/// One decoded envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Message(Vec<u8>),
    /// The stream is over; `Some` when the call failed.
    End(Option<ConnectError>),
}

/// Why a response stream cannot be decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FramingError {
    Compressed,
    UnknownFlags(u8),
    TooLarge(usize),
    EndStreamInvalid(String),
    /// The body ended inside an envelope.
    Truncated(usize),
    /// A frame arrived after the end-of-stream message.
    AfterEnd,
}

impl fmt::Display for FramingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Compressed => f.write_str("envd sent a compressed message it was not offered"),
            Self::UnknownFlags(flags) => write!(f, "envd sent an envelope with flags {flags:#04x}"),
            Self::TooLarge(length) => write!(
                f,
                "envd sent a {length}-byte message (limit {MAX_MESSAGE_BYTES})"
            ),
            Self::EndStreamInvalid(error) => {
                write!(f, "envd sent an unreadable end-of-stream message: {error}")
            }
            Self::Truncated(left) => {
                write!(f, "envd's stream ended {left} bytes into an envelope")
            }
            Self::AfterEnd => f.write_str("envd sent data after the end of the stream"),
        }
    }
}

/// Reassembles envelopes from arbitrarily split transport chunks.
#[derive(Debug, Default)]
pub struct EnvelopeDecoder {
    buffer: Vec<u8>,
    ended: bool,
}

impl EnvelopeDecoder {
    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// The next complete envelope, `None` when more bytes are needed.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, FramingError> {
        if self.buffer.len() < HEADER_LEN {
            if self.ended && !self.buffer.is_empty() {
                return Err(FramingError::AfterEnd);
            }
            return Ok(None);
        }
        if self.ended {
            return Err(FramingError::AfterEnd);
        }
        let flags = self.buffer[0];
        if flags & FLAG_COMPRESSED != 0 {
            return Err(FramingError::Compressed);
        }
        if flags & !FLAG_END_STREAM != 0 {
            return Err(FramingError::UnknownFlags(flags));
        }
        let length = u32::from_be_bytes([
            self.buffer[1],
            self.buffer[2],
            self.buffer[3],
            self.buffer[4],
        ]) as usize;
        if length > MAX_MESSAGE_BYTES {
            return Err(FramingError::TooLarge(length));
        }
        if self.buffer.len() < HEADER_LEN + length {
            return Ok(None);
        }
        let payload = self.buffer[HEADER_LEN..HEADER_LEN + length].to_vec();
        self.buffer.drain(..HEADER_LEN + length);
        if flags & FLAG_END_STREAM != 0 {
            self.ended = true;
            return parse_end_stream(&payload).map(|error| Some(Frame::End(error)));
        }
        Ok(Some(Frame::Message(payload)))
    }

    /// Called when the body has ended: leftover bytes are a cut envelope.
    pub fn finish(&self) -> Result<(), FramingError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(FramingError::Truncated(self.buffer.len()))
        }
    }
}

#[derive(Debug, Deserialize)]
struct WireEndStream {
    #[serde(default)]
    error: Option<WireError>,
}

#[derive(Debug, Deserialize)]
struct WireError {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

fn parse_end_stream(payload: &[u8]) -> Result<Option<ConnectError>, FramingError> {
    if payload.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let end: WireEndStream = serde_json::from_slice(payload)
        .map_err(|error| FramingError::EndStreamInvalid(error.to_string()))?;
    Ok(end.error.map(|error| ConnectError {
        code: error.code,
        message: error.message,
    }))
}

/// The error a unary call (or a stream refused before it started) answered
/// with: Connect's JSON error body when there is one, else the HTTP status.
pub fn parse_unary_error(status: u16, body: &[u8]) -> ConnectError {
    if let Ok(error) = serde_json::from_slice::<WireError>(body) {
        if !error.code.is_empty() || !error.message.is_empty() {
            return ConnectError {
                code: if error.code.is_empty() {
                    code_for_status(status).to_string()
                } else {
                    error.code
                },
                message: error.message,
            };
        }
    }
    let text = String::from_utf8_lossy(body);
    let text = text.trim();
    ConnectError {
        code: code_for_status(status).to_string(),
        message: truncate(text, 512),
    }
}

/// Connect's HTTP-to-code mapping for errors that carry no body.
fn code_for_status(status: u16) -> &'static str {
    match status {
        400 => "invalid_argument",
        401 => "unauthenticated",
        403 => "permission_denied",
        404 => "not_found",
        408 => "deadline_exceeded",
        409 => "already_exists",
        429 | 502 | 503 | 504 => "unavailable",
        501 => "unimplemented",
        _ => "unknown",
    }
}

pub fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end_frame(payload: &[u8]) -> Vec<u8> {
        let mut frame = encode_envelope(payload);
        frame[0] = FLAG_END_STREAM;
        frame
    }

    #[test]
    fn a_request_envelope_is_flag_length_payload() {
        let frame = encode_envelope(br#"{"a":1}"#);
        assert_eq!(&frame[..5], &[0, 0, 0, 0, 7]);
        assert_eq!(&frame[5..], br#"{"a":1}"#);
    }

    #[test]
    fn envelopes_are_reassembled_from_single_byte_chunks() {
        let mut stream = encode_envelope(b"first");
        stream.extend(encode_envelope(b""));
        stream.extend(encode_envelope(b"second message"));
        stream.extend(end_frame(b"{}"));

        let mut decoder = EnvelopeDecoder::default();
        let mut frames = Vec::new();
        for byte in &stream {
            decoder.push(std::slice::from_ref(byte));
            while let Some(frame) = decoder.next_frame().unwrap() {
                frames.push(frame);
            }
        }
        decoder.finish().unwrap();
        assert_eq!(
            frames,
            vec![
                Frame::Message(b"first".to_vec()),
                Frame::Message(Vec::new()),
                Frame::Message(b"second message".to_vec()),
                Frame::End(None),
            ]
        );
    }

    #[test]
    fn several_envelopes_in_one_chunk_come_out_in_order() {
        let mut stream = encode_envelope(b"a");
        stream.extend(encode_envelope(b"b"));
        let mut decoder = EnvelopeDecoder::default();
        decoder.push(&stream);
        assert_eq!(
            decoder.next_frame().unwrap(),
            Some(Frame::Message(b"a".to_vec()))
        );
        assert_eq!(
            decoder.next_frame().unwrap(),
            Some(Frame::Message(b"b".to_vec()))
        );
        assert_eq!(decoder.next_frame().unwrap(), None);
    }

    #[test]
    fn the_end_of_stream_message_carries_the_call_error() {
        let mut decoder = EnvelopeDecoder::default();
        decoder.push(&end_frame(
            br#"{"error":{"code":"invalid_argument","message":"cwd '/nope' does not exist"},"metadata":{}}"#,
        ));
        let frame = decoder.next_frame().unwrap();
        assert_eq!(
            frame,
            Some(Frame::End(Some(ConnectError {
                code: "invalid_argument".into(),
                message: "cwd '/nope' does not exist".into(),
            })))
        );
        let error = ConnectError {
            code: "invalid_argument".into(),
            message: "cwd '/nope' does not exist".into(),
        };
        assert_eq!(
            error.to_string(),
            "invalid_argument: cwd '/nope' does not exist"
        );

        let mut empty = EnvelopeDecoder::default();
        empty.push(&end_frame(b""));
        assert_eq!(empty.next_frame().unwrap(), Some(Frame::End(None)));

        let mut broken = EnvelopeDecoder::default();
        broken.push(&end_frame(b"not json"));
        assert!(matches!(
            broken.next_frame(),
            Err(FramingError::EndStreamInvalid(_))
        ));
    }

    #[test]
    fn broken_streams_are_refused() {
        let mut compressed = EnvelopeDecoder::default();
        let mut frame = encode_envelope(b"x");
        frame[0] = FLAG_COMPRESSED;
        compressed.push(&frame);
        assert_eq!(compressed.next_frame(), Err(FramingError::Compressed));

        let mut unknown = EnvelopeDecoder::default();
        let mut frame = encode_envelope(b"x");
        frame[0] = 0x80;
        unknown.push(&frame);
        assert_eq!(unknown.next_frame(), Err(FramingError::UnknownFlags(0x80)));

        let mut huge = EnvelopeDecoder::default();
        huge.push(&[0, 0xff, 0xff, 0xff, 0xff]);
        assert!(matches!(huge.next_frame(), Err(FramingError::TooLarge(_))));

        let mut cut = EnvelopeDecoder::default();
        cut.push(&encode_envelope(b"cut short")[..8]);
        assert_eq!(cut.next_frame().unwrap(), None);
        assert_eq!(cut.finish(), Err(FramingError::Truncated(8)));

        let mut after = EnvelopeDecoder::default();
        after.push(&end_frame(b"{}"));
        after.push(&encode_envelope(b"late"));
        assert_eq!(after.next_frame().unwrap(), Some(Frame::End(None)));
        assert_eq!(after.next_frame(), Err(FramingError::AfterEnd));
    }

    #[test]
    fn unary_errors_prefer_the_json_body_and_fall_back_to_the_status() {
        let error = parse_unary_error(
            404,
            br#"{"code":"not_found","message":"process with pid 7 not found"}"#,
        );
        assert_eq!(error.code, "not_found");
        assert_eq!(error.message, "process with pid 7 not found");

        let error = parse_unary_error(401, br#"{"message":"unauthorized access"}"#);
        assert_eq!(error.code, "unauthenticated");
        assert_eq!(error.message, "unauthorized access");

        let error = parse_unary_error(503, b"upstream connect error");
        assert_eq!(error.code, "unavailable");
        assert_eq!(error.message, "upstream connect error");

        let long = "é".repeat(400);
        let error = parse_unary_error(500, long.as_bytes());
        assert!(error.message.len() <= 515, "{}", error.message.len());
        assert!(error.message.ends_with('…'));
    }
}
