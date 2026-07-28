//! Framing and version negotiation for the managed code-server broker.
//!
//! Protocol v1 is JSON-RPC 2.0 carried in LSP-style `Content-Length` frames.
//! The legacy newline protocol remains in `agent_channel` for one compatibility
//! cycle; keeping its parser separate prevents accidental feature leakage.

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};

pub(crate) const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_HEADER_BYTES: usize = 8 * 1024;
pub(crate) const CURRENT_PROTOCOL_VERSION: &str = "1.0";
pub(crate) const PREVIOUS_PROTOCOL_VERSION: &str = "0.2";
pub(crate) const CODE_API_VERSION: &str = "1.128.0";
pub(crate) const DEFAULT_CATALOG_HASH: &str =
    "sha256:53cf23036ed2e14693f284778d7f2b0cd7cd5802ee63bb42c573063f40f86fb3";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProtocolMode {
    Legacy,
    JsonRpc,
}

#[derive(Default)]
pub(crate) struct ContentLengthDecoder {
    buffer: Vec<u8>,
    expected_body_bytes: Option<usize>,
}

impl ContentLengthDecoder {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut values = Vec::new();
        loop {
            if self.expected_body_bytes.is_none() {
                let Some(header_end) = find_bytes(&self.buffer, b"\r\n\r\n") else {
                    if self.buffer.len() > MAX_HEADER_BYTES {
                        return Err(format!("JSON-RPC header exceeds {MAX_HEADER_BYTES} bytes"));
                    }
                    break;
                };
                if header_end > MAX_HEADER_BYTES {
                    return Err(format!("JSON-RPC header exceeds {MAX_HEADER_BYTES} bytes"));
                }
                let header = std::str::from_utf8(&self.buffer[..header_end])
                    .map_err(|_| "JSON-RPC header is not ASCII/UTF-8".to_string())?;
                let content_length = parse_content_length(header)?;
                if content_length > MAX_FRAME_BYTES {
                    return Err(format!(
                        "JSON-RPC frame exceeds {MAX_FRAME_BYTES} bytes: {content_length}"
                    ));
                }
                self.buffer.drain(..header_end + 4);
                self.expected_body_bytes = Some(content_length);
            }

            let expected = self.expected_body_bytes.expect("set above");
            if self.buffer.len() < expected {
                break;
            }
            let body: Vec<u8> = self.buffer.drain(..expected).collect();
            self.expected_body_bytes = None;
            values.push(
                serde_json::from_slice(&body)
                    .map_err(|error| format!("invalid JSON-RPC body: {error}"))?,
            );
        }
        Ok(values)
    }
}

pub(crate) fn encode_content_length(value: &Value) -> Result<Vec<u8>, String> {
    let body =
        serde_json::to_vec(value).map_err(|error| format!("encode JSON-RPC body: {error}"))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "JSON-RPC frame exceeds {MAX_FRAME_BYTES} bytes: {}",
            body.len()
        ));
    }
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend(body);
    Ok(frame)
}

pub(crate) async fn read_content_length_value<R>(reader: &mut R) -> Result<Option<Value>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut header = String::new();
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|error| format!("read JSON-RPC header: {error}"))?;
        if read == 0 {
            return if header.is_empty() {
                Ok(None)
            } else {
                Err("unexpected EOF in JSON-RPC header".to_string())
            };
        }
        if line == "\r\n" {
            break;
        }
        header.push_str(&line);
        if header.len() > MAX_HEADER_BYTES {
            return Err(format!("JSON-RPC header exceeds {MAX_HEADER_BYTES} bytes"));
        }
    }

    let content_length = parse_content_length(header.trim_end_matches("\r\n"))?;
    if content_length > MAX_FRAME_BYTES {
        return Err(format!(
            "JSON-RPC frame exceeds {MAX_FRAME_BYTES} bytes: {content_length}"
        ));
    }
    let mut body = vec![0_u8; content_length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|error| format!("read JSON-RPC body: {error}"))?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| format!("invalid JSON-RPC body: {error}"))
}

pub(crate) fn detect_protocol(prefix: &[u8]) -> ProtocolMode {
    if prefix.starts_with(b"Content-Length:") || prefix.starts_with(b"content-length:") {
        ProtocolMode::JsonRpc
    } else {
        ProtocolMode::Legacy
    }
}

fn parse_content_length(header: &str) -> Result<usize, String> {
    let mut content_length = None;
    for line in header.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("content-length") {
            continue;
        }
        let value = value.trim();
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("invalid Content-Length: {value}"));
        }
        content_length = Some(
            value
                .parse::<usize>()
                .map_err(|_| format!("invalid Content-Length: {value}"))?,
        );
    }
    content_length.ok_or_else(|| "missing Content-Length header".to_string())
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn protocol_detection_is_explicit() {
        assert_eq!(
            detect_protocol(b"Content-Length: 2\r\n\r\n{}"),
            ProtocolMode::JsonRpc
        );
        assert_eq!(
            detect_protocol(br#"{"type":"hello"}"#),
            ProtocolMode::Legacy
        );
    }

    #[test]
    fn encoder_uses_utf8_byte_length() {
        let frame = encode_content_length(&json!({ "value": "你好" })).unwrap();
        let separator = find_bytes(&frame, b"\r\n\r\n").unwrap();
        let header = std::str::from_utf8(&frame[..separator]).unwrap();
        let declared = parse_content_length(header).unwrap();
        assert_eq!(declared, frame.len() - separator - 4);
    }
}
