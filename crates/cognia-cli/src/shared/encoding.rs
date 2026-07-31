//! Base64 encode/decode centralized so standard / no-pad choices stay
//! consistent across the crate (e.g. the `author.publicKey` field).

use anyhow::{anyhow, Result};
use base64::Engine as _;

/// Encode a base64 string. Centralized so swaps between standard / no-pad
/// (e.g. for the public-key field in `plugin.json`) stay consistent.
pub(crate) fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub(crate) fn b64_decode(s: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim().as_bytes())
        .map_err(|e| anyhow!("invalid base64: {e}"))
}
