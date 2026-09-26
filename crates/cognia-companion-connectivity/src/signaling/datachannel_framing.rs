//! Bounded logical-message framing for the reliable ordered DataChannel.

use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};

pub const MAX_FRAME_BYTES: usize = 32 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_REASSEMBLIES: usize = 8;
pub const MAX_REASSEMBLY_BYTES: usize = 4 * 1024 * 1024;
pub const CHUNK_TIMEOUT_MS: i64 = 15_000;
const CHUNK_DATA_BYTES: usize = 23 * 1024;
pub const BINARY_RESOURCE_MAGIC: &[u8; 4] = b"CGM1";
pub const BINARY_RESOURCE_ID_BYTES: usize = 36;
pub const BINARY_RESOURCE_HEADER_BYTES: usize =
    BINARY_RESOURCE_MAGIC.len() + BINARY_RESOURCE_ID_BYTES + 4 + 4;
pub const BINARY_RESOURCE_CHUNK_BYTES: usize = MAX_FRAME_BYTES - BINARY_RESOURCE_HEADER_BYTES;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum ChunkFrame {
    #[serde(rename = "chunk/start")]
    Start {
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "totalBytes")]
        total_bytes: usize,
        #[serde(rename = "totalChunks")]
        total_chunks: usize,
    },
    #[serde(rename = "chunk/data")]
    Data {
        #[serde(rename = "messageId")]
        message_id: String,
        index: usize,
        data: String,
    },
    #[serde(rename = "chunk/ack")]
    Ack {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    #[serde(rename = "chunk/cancel")]
    Cancel {
        #[serde(rename = "messageId")]
        message_id: String,
        reason: String,
    },
}

pub enum ReassemblyResult {
    Message {
        bytes: Vec<u8>,
        message_id: Option<String>,
    },
    Ack,
    Cancel {
        message_id: String,
        reason: &'static str,
    },
    Partial,
}

struct Pending {
    total_bytes: usize,
    total_chunks: usize,
    chunks: HashMap<usize, Vec<u8>>,
    received_bytes: usize,
    expires_at: i64,
}

#[derive(Default)]
pub struct ChunkReassembler {
    pending: HashMap<String, Pending>,
    reserved_bytes: usize,
}

impl ChunkReassembler {
    pub fn accept(&mut self, raw: &[u8], now_ms: i64) -> ReassemblyResult {
        self.expire(now_ms);
        if raw.len() > MAX_FRAME_BYTES {
            return ReassemblyResult::Cancel {
                message_id: String::new(),
                reason: "frame_too_large",
            };
        }
        let Ok(frame) = serde_json::from_slice::<ChunkFrame>(raw) else {
            return ReassemblyResult::Message {
                bytes: raw.to_vec(),
                message_id: None,
            };
        };
        match frame {
            ChunkFrame::Ack { .. } => ReassemblyResult::Ack,
            ChunkFrame::Cancel { message_id, .. } => {
                self.remove(&message_id);
                ReassemblyResult::Ack
            }
            ChunkFrame::Start {
                message_id,
                total_bytes,
                total_chunks,
            } => {
                if message_id.is_empty()
                    || total_bytes == 0
                    || total_bytes > MAX_MESSAGE_BYTES
                    || total_chunks == 0
                    || self.pending.contains_key(&message_id)
                {
                    return ReassemblyResult::Cancel {
                        message_id,
                        reason: "invalid_start",
                    };
                }
                if self.pending.len() >= MAX_REASSEMBLIES
                    || self.reserved_bytes.saturating_add(total_bytes) > MAX_REASSEMBLY_BYTES
                {
                    return ReassemblyResult::Cancel {
                        message_id,
                        reason: "reassembly_overflow",
                    };
                }
                self.reserved_bytes += total_bytes;
                self.pending.insert(
                    message_id,
                    Pending {
                        total_bytes,
                        total_chunks,
                        chunks: HashMap::new(),
                        received_bytes: 0,
                        expires_at: now_ms.saturating_add(CHUNK_TIMEOUT_MS),
                    },
                );
                ReassemblyResult::Partial
            }
            ChunkFrame::Data {
                message_id,
                index,
                data,
            } => {
                let Some(pending) = self.pending.get_mut(&message_id) else {
                    return ReassemblyResult::Cancel {
                        message_id,
                        reason: "invalid_chunk",
                    };
                };
                if index >= pending.total_chunks {
                    return ReassemblyResult::Cancel {
                        message_id,
                        reason: "invalid_chunk",
                    };
                }
                if pending.chunks.contains_key(&index) {
                    return ReassemblyResult::Partial;
                }
                let Ok(bytes) = URL_SAFE_NO_PAD.decode(data) else {
                    self.remove(&message_id);
                    return ReassemblyResult::Cancel {
                        message_id,
                        reason: "invalid_chunk",
                    };
                };
                pending.received_bytes = pending.received_bytes.saturating_add(bytes.len());
                if pending.received_bytes > pending.total_bytes {
                    self.remove(&message_id);
                    return ReassemblyResult::Cancel {
                        message_id,
                        reason: "length_mismatch",
                    };
                }
                pending.chunks.insert(index, bytes);
                if pending.chunks.len() != pending.total_chunks {
                    return ReassemblyResult::Partial;
                }
                let pending = self.pending.remove(&message_id).expect("entry exists");
                self.reserved_bytes -= pending.total_bytes;
                let mut output = Vec::with_capacity(pending.total_bytes);
                for index in 0..pending.total_chunks {
                    let Some(chunk) = pending.chunks.get(&index) else {
                        return ReassemblyResult::Cancel {
                            message_id,
                            reason: "length_mismatch",
                        };
                    };
                    output.extend_from_slice(chunk);
                }
                if output.len() != pending.total_bytes {
                    return ReassemblyResult::Cancel {
                        message_id,
                        reason: "length_mismatch",
                    };
                }
                ReassemblyResult::Message {
                    bytes: output,
                    message_id: Some(message_id),
                }
            }
        }
    }

    fn expire(&mut self, now_ms: i64) {
        let expired: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.expires_at <= now_ms)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            self.remove(&id);
        }
    }

    fn remove(&mut self, message_id: &str) {
        if let Some(pending) = self.pending.remove(message_id) {
            self.reserved_bytes -= pending.total_bytes;
        }
    }
}

pub fn encode_message(bytes: &[u8], message_id: &str) -> Result<Vec<Vec<u8>>, &'static str> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err("rtc_message_too_large");
    }
    if bytes.len() <= MAX_FRAME_BYTES {
        return Ok(vec![bytes.to_vec()]);
    }
    let total_chunks = bytes.len().div_ceil(CHUNK_DATA_BYTES);
    let mut frames = vec![serde_json::to_vec(&ChunkFrame::Start {
        message_id: message_id.to_string(),
        total_bytes: bytes.len(),
        total_chunks,
    })
    .map_err(|_| "rtc_chunk_encode")?];
    for (index, chunk) in bytes.chunks(CHUNK_DATA_BYTES).enumerate() {
        let frame = serde_json::to_vec(&ChunkFrame::Data {
            message_id: message_id.to_string(),
            index,
            data: URL_SAFE_NO_PAD.encode(chunk),
        })
        .map_err(|_| "rtc_chunk_encode")?;
        if frame.len() > MAX_FRAME_BYTES {
            return Err("rtc_chunk_frame_too_large");
        }
        frames.push(frame);
    }
    Ok(frames)
}

pub fn ack(message_id: &str) -> Vec<u8> {
    serde_json::to_vec(&ChunkFrame::Ack {
        message_id: message_id.to_string(),
    })
    .unwrap_or_default()
}

pub fn cancel(message_id: &str, reason: &str) -> Vec<u8> {
    serde_json::to_vec(&ChunkFrame::Cancel {
        message_id: message_id.to_string(),
        reason: reason.to_string(),
    })
    .unwrap_or_default()
}

/// Encode one raw binary resource chunk. Unlike logical RPC framing, the
/// payload stays binary and is never expanded through JSON/base64.
pub fn encode_binary_resource_chunk(
    request_id: &str,
    index: u32,
    total_chunks: u32,
    payload: &[u8],
) -> Result<Vec<u8>, &'static str> {
    if request_id.len() != BINARY_RESOURCE_ID_BYTES
        || !request_id.is_ascii()
        || uuid::Uuid::parse_str(request_id).is_err()
        || total_chunks == 0
        || index >= total_chunks
        || payload.len() > BINARY_RESOURCE_CHUNK_BYTES
    {
        return Err("invalid_binary_resource_chunk");
    }
    let mut frame = Vec::with_capacity(BINARY_RESOURCE_HEADER_BYTES + payload.len());
    frame.extend_from_slice(BINARY_RESOURCE_MAGIC);
    frame.extend_from_slice(request_id.as_bytes());
    frame.extend_from_slice(&index.to_be_bytes());
    frame.extend_from_slice(&total_chunks.to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_message_round_trips_with_bounded_frames() {
        let bytes = vec![b'x'; 100_000];
        let frames = encode_message(&bytes, "m1").unwrap();
        assert!(frames.len() > 2);
        assert!(frames.iter().all(|frame| frame.len() <= MAX_FRAME_BYTES));
        let mut reassembler = ChunkReassembler::default();
        let mut completed = None;
        for frame in frames {
            if let ReassemblyResult::Message { bytes, .. } = reassembler.accept(&frame, 0) {
                completed = Some(bytes);
            }
        }
        assert_eq!(completed, Some(bytes));
    }

    #[test]
    fn binary_resource_chunk_keeps_payload_raw_and_bounded() {
        let request_id = "550e8400-e29b-41d4-a716-446655440000";
        let payload = vec![0_u8, 255, 17, 99];
        let frame = encode_binary_resource_chunk(request_id, 1, 3, &payload).unwrap();

        assert_eq!(&frame[..4], BINARY_RESOURCE_MAGIC);
        assert_eq!(
            std::str::from_utf8(&frame[4..4 + BINARY_RESOURCE_ID_BYTES]).unwrap(),
            request_id
        );
        assert_eq!(&frame[BINARY_RESOURCE_HEADER_BYTES..], payload.as_slice());
        assert!(frame.len() <= MAX_FRAME_BYTES);
    }

    #[test]
    fn message_and_reassembly_limits_are_enforced() {
        assert!(encode_message(&vec![0; MAX_MESSAGE_BYTES + 1], "huge").is_err());
        let mut reassembler = ChunkReassembler::default();
        for index in 0..MAX_REASSEMBLIES {
            let frame = serde_json::to_vec(&ChunkFrame::Start {
                message_id: format!("m{index}"),
                total_bytes: MAX_REASSEMBLY_BYTES / MAX_REASSEMBLIES,
                total_chunks: 1,
            })
            .unwrap();
            assert!(matches!(
                reassembler.accept(&frame, 0),
                ReassemblyResult::Partial
            ));
        }
        let overflow = serde_json::to_vec(&ChunkFrame::Start {
            message_id: "overflow".into(),
            total_bytes: 1,
            total_chunks: 1,
        })
        .unwrap();
        assert!(matches!(
            reassembler.accept(&overflow, 0),
            ReassemblyResult::Cancel {
                reason: "reassembly_overflow",
                ..
            }
        ));
    }
}
