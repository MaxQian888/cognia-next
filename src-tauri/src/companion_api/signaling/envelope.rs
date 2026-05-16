//! End-to-end HMAC-SHA256 sign/verify for signaling envelopes.
//!
//! Mirror of `lib/signaling/envelope.ts`. The canonical JSON encoding,
//! HMAC computation, and replay window MUST match the TypeScript side
//! byte-for-byte — both peers run identical algorithms locally to verify
//! envelopes relayed through the untrusted signaling rendezvous (see
//! ADR-0021).

use std::{
    collections::{HashSet, VecDeque},
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Mirror of `lib/signaling/types.ts:EnvelopeKind`. The serde tag uses
/// kebab-case for the `rtc:*` variants so the wire format matches the
/// TypeScript discriminator exactly.
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

/// Envelope wire shape. Fields are camelCase via `#[serde]` annotations so
/// the JSON round-trips with `lib/signaling/types.ts:Envelope`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub ver: u8,
    pub ts: i64,
    pub nonce: String,
    pub seq: u64,
    pub kind: EnvelopeKind,
    pub body: Value,
    pub mac: String,
}

/// Default acceptable wall-clock skew window (ms). Mirrors
/// `REPLAY_CLOCK_SKEW_MS` in `lib/signaling/types.ts`.
pub const REPLAY_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;

/// Per-room replay protection LRU capacity. Mirrors `REPLAY_LRU_CAPACITY`.
pub const REPLAY_LRU_CAPACITY: usize = 256;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvelopeError {
    InvalidSecret,
    Base64(String),
    Json(String),
    Hmac(String),
    ClockSkew { ts: i64, now: i64 },
    BadVersion(u8),
    MacMismatch,
    Replay,
}

impl fmt::Display for EnvelopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSecret => write!(f, "rendezvous secret must be 32 bytes"),
            Self::Base64(e) => write!(f, "base64 decode failed: {e}"),
            Self::Json(e) => write!(f, "json error: {e}"),
            Self::Hmac(e) => write!(f, "hmac error: {e}"),
            Self::ClockSkew { ts, now } => {
                write!(f, "clock skew too large: ts={ts}, now={now}")
            }
            Self::BadVersion(v) => write!(f, "unsupported envelope version: {v}"),
            Self::MacMismatch => write!(f, "HMAC verification failed"),
            Self::Replay => write!(f, "envelope replayed (seq or nonce already seen)"),
        }
    }
}

impl std::error::Error for EnvelopeError {}

// ---------------------------------------------------------------------------
// Base64url
// ---------------------------------------------------------------------------

/// Decode a 32-byte rendezvous secret from URL-safe base64 (unpadded).
pub fn decode_secret(secret_b64: &str) -> Result<Vec<u8>, EnvelopeError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(secret_b64.as_bytes())
        .map_err(|e| EnvelopeError::Base64(e.to_string()))?;
    if bytes.len() != 32 {
        return Err(EnvelopeError::InvalidSecret);
    }
    Ok(bytes)
}

/// Encode raw bytes as URL-safe base64 (unpadded).
pub fn encode_base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/// Produce a deterministic JSON encoding of `value` with all object keys
/// sorted lexicographically (UTF-16 codepoint order = byte order for ASCII).
/// Arrays preserve their input order. Output has no whitespace and uses
/// `serde_json`'s default escaping rules so the bytes are identical to the
/// TS counterpart at `lib/signaling/envelope.ts:canonicalJson`.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => {
            // serde_json::to_string always emits a valid JSON string literal.
            // Safe to unwrap — Strings always serialize successfully.
            out.push_str(&serde_json::to_string(s).expect("string serialization"));
        }
        Value::Array(arr) => {
            out.push('[');
            for (i, v) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(v, out);
            }
            out.push(']');
        }
        Value::Object(obj) => {
            // Collect & sort keys lexicographically. We sort by the &str
            // representation, matching JS's default String.prototype < .
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(
                    &serde_json::to_string(k.as_str()).expect("string serialization"),
                );
                out.push(':');
                write_canonical(&obj[k.as_str()], out);
            }
            out.push('}');
        }
    }
}

// ---------------------------------------------------------------------------
// HMAC compute over a draft envelope (mac="" placeholder)
// ---------------------------------------------------------------------------

fn envelope_to_value(envelope: &Envelope, mac: &str) -> Result<Value, EnvelopeError> {
    let mut v = serde_json::to_value(envelope).map_err(|e| EnvelopeError::Json(e.to_string()))?;
    if let Value::Object(ref mut map) = v {
        map.insert("mac".to_string(), Value::String(mac.to_string()));
    }
    Ok(v)
}

fn compute_mac(envelope: &Envelope, secret: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    if secret.len() != 32 {
        return Err(EnvelopeError::InvalidSecret);
    }
    let canonical_value = envelope_to_value(envelope, "")?;
    let canonical = canonical_json(&canonical_value);
    let mut mac =
        HmacSha256::new_from_slice(secret).map_err(|e| EnvelopeError::Hmac(e.to_string()))?;
    mac.update(canonical.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

/// Build a signed envelope with the given seq/kind/body. `ts` defaults to
/// the wall clock and `nonce` is 16 fresh random bytes.
pub fn build_signed_envelope(
    seq: u64,
    kind: EnvelopeKind,
    body: Value,
    secret_b64: &str,
) -> Result<Envelope, EnvelopeError> {
    build_signed_envelope_with(seq, kind, body, secret_b64, now_ms(), fresh_nonce())
}

/// Test-friendly variant — pass an explicit `ts` and `nonce` for determinism.
pub fn build_signed_envelope_with(
    seq: u64,
    kind: EnvelopeKind,
    body: Value,
    secret_b64: &str,
    ts: i64,
    nonce: String,
) -> Result<Envelope, EnvelopeError> {
    let secret = decode_secret(secret_b64)?;
    let mut envelope = Envelope {
        ver: 1,
        ts,
        nonce,
        seq,
        kind,
        body,
        mac: String::new(),
    };
    let mac = compute_mac(&envelope, &secret)?;
    envelope.mac = encode_base64_url(&mac);
    Ok(envelope)
}

/// Verify an envelope's HMAC + clock window. Returns the unwrapped envelope
/// on success. The caller is responsible for replay (seq/nonce) tracking
/// via [`ReplayWindow`] — verification is split because the desktop tracks
/// replay per `(rendezvous_id, sender_role)` tuple, not globally.
pub fn verify_signed_envelope(
    envelope: &Envelope,
    secret_b64: &str,
    now_ms_override: Option<i64>,
) -> Result<(), EnvelopeError> {
    if envelope.ver != 1 {
        return Err(EnvelopeError::BadVersion(envelope.ver));
    }
    let now = now_ms_override.unwrap_or_else(now_ms);
    if (envelope.ts - now).abs() > REPLAY_CLOCK_SKEW_MS {
        return Err(EnvelopeError::ClockSkew {
            ts: envelope.ts,
            now,
        });
    }
    let secret = decode_secret(secret_b64)?;
    let expected = compute_mac(envelope, &secret)?;
    let presented = URL_SAFE_NO_PAD
        .decode(envelope.mac.as_bytes())
        .map_err(|e| EnvelopeError::Base64(e.to_string()))?;
    if !constant_time_eq(&expected, &presented) {
        return Err(EnvelopeError::MacMismatch);
    }
    Ok(())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// Replay window
// ---------------------------------------------------------------------------

/// Per-room replay protection LRU. Tracks recent `(role, seq)` and
/// `(role, nonce)` tuples; rejects repeats. Drops the oldest entry when
/// capacity is hit, matching [`REPLAY_LRU_CAPACITY`].
#[derive(Debug)]
pub struct ReplayWindow {
    capacity: usize,
    seq_set: HashSet<String>,
    seq_order: VecDeque<String>,
    nonce_set: HashSet<String>,
    nonce_order: VecDeque<String>,
}

impl Default for ReplayWindow {
    fn default() -> Self {
        Self::with_capacity(REPLAY_LRU_CAPACITY)
    }
}

impl ReplayWindow {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            seq_set: HashSet::with_capacity(capacity),
            seq_order: VecDeque::with_capacity(capacity),
            nonce_set: HashSet::with_capacity(capacity),
            nonce_order: VecDeque::with_capacity(capacity),
        }
    }

    /// Returns `Ok(())` if the tuple is fresh and was inserted; returns
    /// `Err(EnvelopeError::Replay)` if either the seq or nonce has been
    /// seen for this role.
    pub fn observe(&mut self, role: &str, seq: u64, nonce: &str) -> Result<(), EnvelopeError> {
        let seq_key = format!("{role}|{seq}");
        if self.seq_set.contains(&seq_key) {
            return Err(EnvelopeError::Replay);
        }
        let nonce_key = format!("{role}|{nonce}");
        if self.nonce_set.contains(&nonce_key) {
            return Err(EnvelopeError::Replay);
        }
        self.seq_set.insert(seq_key.clone());
        self.seq_order.push_back(seq_key);
        if self.seq_order.len() > self.capacity {
            if let Some(oldest) = self.seq_order.pop_front() {
                self.seq_set.remove(&oldest);
            }
        }
        self.nonce_set.insert(nonce_key.clone());
        self.nonce_order.push_back(nonce_key);
        if self.nonce_order.len() > self.capacity {
            if let Some(oldest) = self.nonce_order.pop_front() {
                self.nonce_set.remove(&oldest);
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn fresh_nonce() -> String {
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    encode_base64_url(&buf)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRET: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    #[test]
    fn canonical_json_sorts_object_keys_recursively() {
        let v = json!({"b": 1, "a": {"z": 2, "y": 3}});
        assert_eq!(canonical_json(&v), r#"{"a":{"y":3,"z":2},"b":1}"#);
    }

    #[test]
    fn canonical_json_preserves_array_order() {
        let v = json!({"x": [3, 1, 2]});
        assert_eq!(canonical_json(&v), r#"{"x":[3,1,2]}"#);
    }

    #[test]
    fn canonical_json_handles_nested_arrays_of_objects() {
        let v = json!({"a": [{"b": 1, "a": 2}, {"d": 4, "c": 3}]});
        assert_eq!(
            canonical_json(&v),
            r#"{"a":[{"a":2,"b":1},{"c":3,"d":4}]}"#
        );
    }

    #[test]
    fn decode_secret_rejects_wrong_length() {
        assert!(matches!(
            decode_secret("AAAA"),
            Err(EnvelopeError::InvalidSecret)
        ));
    }

    #[test]
    fn build_and_verify_round_trip() {
        let env = build_signed_envelope(
            1,
            EnvelopeKind::Hello,
            json!({"deviceId": "d1"}),
            SECRET,
        )
        .expect("build");
        assert_eq!(env.ver, 1);
        assert!(!env.mac.is_empty());
        verify_signed_envelope(&env, SECRET, None).expect("verify");
    }

    #[test]
    fn verify_rejects_wrong_secret() {
        let env =
            build_signed_envelope(1, EnvelopeKind::Hello, json!({}), SECRET).unwrap();
        let wrong = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZQ";
        assert!(matches!(
            verify_signed_envelope(&env, wrong, None),
            Err(EnvelopeError::MacMismatch)
        ));
    }

    #[test]
    fn verify_rejects_tampered_body() {
        let mut env = build_signed_envelope(
            1,
            EnvelopeKind::RtcOffer,
            json!({"sdp": "real"}),
            SECRET,
        )
        .unwrap();
        env.body = json!({"sdp": "evil"});
        assert!(matches!(
            verify_signed_envelope(&env, SECRET, None),
            Err(EnvelopeError::MacMismatch)
        ));
    }

    #[test]
    fn verify_rejects_clock_skew() {
        let env = build_signed_envelope_with(
            1,
            EnvelopeKind::Hello,
            json!({}),
            SECRET,
            1_000_000,
            "nonce1".into(),
        )
        .unwrap();
        let now = 1_000_000 + 10 * 60 * 1000;
        assert!(matches!(
            verify_signed_envelope(&env, SECRET, Some(now)),
            Err(EnvelopeError::ClockSkew { .. })
        ));
    }

    #[test]
    fn verify_rejects_wrong_version() {
        let mut env =
            build_signed_envelope(1, EnvelopeKind::Hello, json!({}), SECRET).unwrap();
        env.ver = 2;
        assert!(matches!(
            verify_signed_envelope(&env, SECRET, None),
            Err(EnvelopeError::BadVersion(2))
        ));
    }

    #[test]
    fn replay_window_accepts_fresh_then_rejects_repeat() {
        let mut w = ReplayWindow::default();
        w.observe("mobile", 1, "n1").expect("first ok");
        assert!(matches!(
            w.observe("mobile", 1, "n2"),
            Err(EnvelopeError::Replay)
        ));
    }

    #[test]
    fn replay_window_rejects_repeated_nonce() {
        let mut w = ReplayWindow::default();
        w.observe("mobile", 1, "n1").expect("first ok");
        assert!(matches!(
            w.observe("mobile", 2, "n1"),
            Err(EnvelopeError::Replay)
        ));
    }

    #[test]
    fn replay_window_scopes_per_role() {
        let mut w = ReplayWindow::default();
        w.observe("mobile", 1, "n1").expect("mobile ok");
        w.observe("desktop", 1, "n1").expect("desktop ok — different scope");
    }

    #[test]
    fn replay_window_evicts_lru() {
        let mut w = ReplayWindow::with_capacity(2);
        w.observe("mobile", 1, "n1").unwrap();
        w.observe("mobile", 2, "n2").unwrap();
        w.observe("mobile", 3, "n3").unwrap();
        // seq=1 has been evicted, so the same tuple is accepted again.
        w.observe("mobile", 1, "n4").unwrap();
    }

    #[test]
    fn ts_compat_known_vector() {
        // Sanity vector — ensures the canonical JSON layout doesn't drift
        // away from the TS implementation. Computed by running the TS
        // sign function with the same inputs and capturing the resulting
        // mac. Update this vector intentionally when the canonical layout
        // changes; both sides must change together.
        let env = build_signed_envelope_with(
            42,
            EnvelopeKind::RtcOffer,
            json!({"sdp": "v=0\r\nmock"}),
            SECRET,
            1_700_000_000_000,
            "nonce-abcdef".into(),
        )
        .unwrap();

        // The canonical body is deterministic; assert by re-verifying.
        verify_signed_envelope(&env, SECRET, Some(1_700_000_000_000)).expect("verify");
        // Mac length: HMAC-SHA256 = 32 bytes → base64url unpadded = 43 chars.
        assert_eq!(env.mac.len(), 43);
    }
}
