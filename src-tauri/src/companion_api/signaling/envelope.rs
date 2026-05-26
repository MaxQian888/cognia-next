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
use hmac::{Hmac, KeyInit, Mac};
use rand::RngCore;
use serde_json::Value;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

// The wire protocol types (`Envelope`, `EnvelopeKind`, `PeerRole`) are the
// single source of truth in the shared `cognia-signaling-core` crate —
// re-exported here so this module's HMAC/replay code and `super::client` keep
// importing them from `super::envelope` unchanged. The canonical-JSON + HMAC
// logic below stays desktop-local (core is intentionally crypto-free). Both
// crates' `Envelope`/`EnvelopeKind` serialize byte-identically, so the
// cross-implementation MAC pin (`mac_matches_cross_implementation_vector_v1`)
// still holds.
pub use cognia_signaling_core::proto::{Envelope, EnvelopeKind, PeerRole};

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
/// sorted by **UTF-16 code-unit order** (matching JavaScript's default
/// `Object.keys(...).sort()`). Arrays preserve their input order. Output has
/// no whitespace and uses `serde_json`'s default string-escape rules so the
/// bytes are identical to the TS counterpart at
/// `lib/signaling/envelope.ts:canonicalJson`.
///
/// `Number` values that are floats (`Value::Number::is_f64() == true`) are
/// rejected — `serde_json` formats `1.0` as `"1.0"` while `JSON.stringify(1.0)`
/// emits `"1"`, which would silently drift the MAC. The two implementations
/// agree on integer-only bodies.
pub fn canonical_json(value: &Value) -> Result<String, EnvelopeError> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String) -> Result<(), EnvelopeError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if n.is_f64() {
                return Err(EnvelopeError::Json(
                    "non-integer number not supported in canonical JSON".to_string(),
                ));
            }
            out.push_str(&n.to_string());
        }
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
                write_canonical(v, out)?;
            }
            out.push(']');
        }
        Value::Object(obj) => {
            // Sort by UTF-16 code units to match JavaScript's default sort.
            // Native `&str` ordering would sort by UTF-8 bytes, which diverges
            // for non-ASCII keys — e.g. "é" (U+00E9) sorts AFTER "z" (U+007A)
            // in UTF-16 but BEFORE "z" when compared as UTF-8 bytes.
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort_by(|a, b| {
                let au: Vec<u16> = a.encode_utf16().collect();
                let bu: Vec<u16> = b.encode_utf16().collect();
                au.cmp(&bu)
            });
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(
                    &serde_json::to_string(k.as_str()).expect("string serialization"),
                );
                out.push(':');
                write_canonical(&obj[k.as_str()], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
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
    let canonical = canonical_json(&canonical_value)?;
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
    /// seen for this role. The `role` parameter is typed to prevent silent
    /// mis-scoping from a stringly-typed call site — see [`PeerRole`].
    pub fn observe(
        &mut self,
        role: PeerRole,
        seq: u64,
        nonce: &str,
    ) -> Result<(), EnvelopeError> {
        let seq_key = format!("{}|{seq}", role.as_str());
        if self.seq_set.contains(&seq_key) {
            return Err(EnvelopeError::Replay);
        }
        let nonce_key = format!("{}|{nonce}", role.as_str());
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

    /// Cross-implementation MAC pin — must equal
    /// `EXPECTED_MAC_VECTOR_V1` in `lib/signaling/envelope.test.ts`. Computed
    /// from the TS canonical-JSON path via `scripts/compute-mac-vector.mjs`
    /// for the fixed envelope tuple below. If this assertion ever fails,
    /// either side has drifted on canonical encoding, HMAC computation, or
    /// base64url framing — investigate before changing the constant.
    const EXPECTED_MAC_VECTOR_V1: &str = "gCsrVgz1X_cWBTd4LR01XEjWzNmIauI8yMrdn5QlLx4";

    #[test]
    fn canonical_json_sorts_object_keys_recursively() {
        let v = json!({"b": 1, "a": {"z": 2, "y": 3}});
        assert_eq!(
            canonical_json(&v).unwrap(),
            r#"{"a":{"y":3,"z":2},"b":1}"#
        );
    }

    #[test]
    fn canonical_json_preserves_array_order() {
        let v = json!({"x": [3, 1, 2]});
        assert_eq!(canonical_json(&v).unwrap(), r#"{"x":[3,1,2]}"#);
    }

    #[test]
    fn canonical_json_handles_nested_arrays_of_objects() {
        let v = json!({"a": [{"b": 1, "a": 2}, {"d": 4, "c": 3}]});
        assert_eq!(
            canonical_json(&v).unwrap(),
            r#"{"a":[{"a":2,"b":1},{"c":3,"d":4}]}"#
        );
    }

    #[test]
    fn canonical_json_sorts_non_ascii_keys_by_utf16_to_match_js() {
        // `é` (U+00E9) > `z` (U+007A) in UTF-16, so `z` comes first. Native
        // `&str` ordering would do the opposite (UTF-8 bytes: `z`=0x7A vs
        // `é`=0xC3 0xA9). Both implementations MUST produce the same
        // canonical bytes.
        let v = json!({"é": 1, "z": 2});
        assert_eq!(canonical_json(&v).unwrap(), r#"{"z":2,"é":1}"#);
        // Astral codepoint U+1F600 encodes as the surrogate pair (0xD83D,
        // 0xDE00), which sorts after every BMP codepoint when compared as
        // u16 sequences.
        let v = json!({"\u{1f600}": 1, "a": 2});
        assert_eq!(canonical_json(&v).unwrap(), r#"{"a":2,"😀":1}"#);
    }

    #[test]
    fn canonical_json_handles_null_and_string_escapes() {
        let v = json!({"body": null});
        assert_eq!(canonical_json(&v).unwrap(), r#"{"body":null}"#);
        // serde_json escapes control chars and quotes identically to
        // JSON.stringify; both ` ` and `` are emitted as the JSON
        // unicode escape (not raw bytes).
        let v = json!({"s": "\u{0000}\u{001f}\\\""});
        assert_eq!(
            canonical_json(&v).unwrap(),
            r#"{"s":" \\\""}"#
        );
    }

    #[test]
    fn canonical_json_rejects_float_numbers() {
        // `serde_json::Number::from_f64(1.5)` is f64-stored and would
        // serialise as `1.5` here but `JSON.stringify(1.5)` also emits `1.5`
        // — so 1.5 alone doesn't prove divergence. But `from_f64(1.0)` emits
        // `1.0` here while JS emits `1`. We reject all floats to stay safe.
        let v = json!({"x": 1.5});
        assert!(matches!(
            canonical_json(&v),
            Err(EnvelopeError::Json(_))
        ));
        // `1.0` from json! is parsed as f64 too.
        let v = json!({"x": 1.0});
        assert!(matches!(
            canonical_json(&v),
            Err(EnvelopeError::Json(_))
        ));
        // Integer u64 / i64 are accepted as before.
        let v = json!({"x": 1, "y": -2_i64});
        assert!(canonical_json(&v).is_ok());
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

    /// Cross-implementation MAC pin. The Rust output for the deterministic
    /// envelope tuple below MUST match `EXPECTED_MAC_VECTOR_V1` in
    /// `lib/signaling/envelope.test.ts` — byte-for-byte agreement on
    /// canonical-JSON encoding, HMAC computation, and base64url framing.
    ///
    /// If this assertion ever fails, one side has drifted. Recompute via
    /// `scripts/compute-mac-vector.mjs` ONLY after intentionally re-cutting
    /// the canonical layout (and bumping `ver`); otherwise treat it as a
    /// regression that would break every production envelope exchange.
    #[test]
    fn mac_matches_cross_implementation_vector_v1() {
        let env = build_signed_envelope_with(
            42,
            EnvelopeKind::RtcOffer,
            json!({"sdp": "v=0\r\nmock"}),
            SECRET,
            1_700_000_000_000,
            "nonce-abcdef".to_string(),
        )
        .expect("build");
        assert_eq!(
            env.mac, EXPECTED_MAC_VECTOR_V1,
            "Rust MAC drifted from TS pin — see comment on EXPECTED_MAC_VECTOR_V1"
        );
        // The pinned envelope must also pass standard verification under
        // a clock window straddling the fixed `ts` — otherwise the MAC
        // pin holds but the round-trip path is broken.
        verify_signed_envelope(&env, SECRET, Some(1_700_000_000_000))
            .expect("pinned envelope verifies");
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
        w.observe(PeerRole::Mobile, 1, "n1").expect("first ok");
        assert!(matches!(
            w.observe(PeerRole::Mobile, 1, "n2"),
            Err(EnvelopeError::Replay)
        ));
    }

    #[test]
    fn replay_window_rejects_repeated_nonce() {
        let mut w = ReplayWindow::default();
        w.observe(PeerRole::Mobile, 1, "n1").expect("first ok");
        assert!(matches!(
            w.observe(PeerRole::Mobile, 2, "n1"),
            Err(EnvelopeError::Replay)
        ));
    }

    #[test]
    fn replay_window_scopes_per_role() {
        let mut w = ReplayWindow::default();
        w.observe(PeerRole::Mobile, 1, "n1").expect("mobile ok");
        w.observe(PeerRole::Desktop, 1, "n1")
            .expect("desktop ok — different scope");
    }

    #[test]
    fn replay_window_evicts_lru() {
        let mut w = ReplayWindow::with_capacity(2);
        w.observe(PeerRole::Mobile, 1, "n1").unwrap();
        w.observe(PeerRole::Mobile, 2, "n2").unwrap();
        w.observe(PeerRole::Mobile, 3, "n3").unwrap();
        // seq=1 has been evicted, so the same tuple is accepted again.
        w.observe(PeerRole::Mobile, 1, "n4").unwrap();
    }

    #[test]
    fn replay_window_evicts_strictly_oldest_on_overflow() {
        let mut w = ReplayWindow::with_capacity(3);
        w.observe(PeerRole::Mobile, 1, "n1").unwrap();
        w.observe(PeerRole::Mobile, 2, "n2").unwrap();
        w.observe(PeerRole::Mobile, 3, "n3").unwrap();
        // Capacity = 3. Fourth push evicts seq=1 (oldest).
        w.observe(PeerRole::Mobile, 4, "n4").unwrap();
        // seq=1 fresh again; 2, 3, 4 still present.
        w.observe(PeerRole::Mobile, 1, "n1b").unwrap();
        assert!(matches!(
            w.observe(PeerRole::Mobile, 3, "n3b"),
            Err(EnvelopeError::Replay)
        ));
        assert!(matches!(
            w.observe(PeerRole::Mobile, 4, "n4b"),
            Err(EnvelopeError::Replay)
        ));
    }

    #[test]
    fn replay_window_role_scoping_does_not_imply_per_role_capacity() {
        // The global LRU keeps the two roles from colliding on key, but it
        // does NOT reserve half-capacity per role. Mobile pushes can still
        // evict desktop entries once the window is full — the 5-minute
        // clock-skew window is what bounds the attacker's replay reach.
        let mut w = ReplayWindow::with_capacity(2);
        w.observe(PeerRole::Desktop, 1, "d1").unwrap();
        w.observe(PeerRole::Mobile, 1, "m1").unwrap();
        // Distinct keys, but the window is full. Immediate desktop replay
        // is still rejected.
        assert!(matches!(
            w.observe(PeerRole::Desktop, 1, "d1-replay-immediate"),
            Err(EnvelopeError::Replay)
        ));
        // Next push evicts desktop|1 (the oldest tuple).
        w.observe(PeerRole::Mobile, 2, "m2").unwrap();
        w.observe(PeerRole::Desktop, 1, "d1-replay-after-evict")
            .expect("desktop|1 was evicted; fresh again");
    }

    #[test]
    fn peer_role_from_wire_round_trips_canonical_strings() {
        assert_eq!(PeerRole::from_wire("desktop"), Some(PeerRole::Desktop));
        assert_eq!(PeerRole::from_wire("mobile"), Some(PeerRole::Mobile));
        assert_eq!(PeerRole::from_wire("DESKTOP"), None);
        assert_eq!(PeerRole::from_wire(""), None);
        assert_eq!(PeerRole::from_wire("server"), None);
        assert_eq!(PeerRole::Desktop.as_str(), "desktop");
        assert_eq!(PeerRole::Mobile.as_str(), "mobile");
    }

    #[test]
    fn decode_secret_rejects_non_base64_characters() {
        assert!(matches!(
            decode_secret("!!!!"),
            Err(EnvelopeError::Base64(_))
        ));
    }

    #[test]
    fn mac_vector_matches_ts() {
        // Cross-implementation pin: the same fixed envelope tuple, signed
        // through the Rust path, must produce the exact MAC the TypeScript
        // path emits for that input. The expected value was minted via
        // `scripts/compute-mac-vector.mjs` (which uses the same Web Crypto
        // primitives the TS production code uses).
        let env = build_signed_envelope_with(
            42,
            EnvelopeKind::RtcOffer,
            json!({"sdp": "v=0\r\nmock"}),
            SECRET,
            1_700_000_000_000,
            "nonce-abcdef".into(),
        )
        .unwrap();

        verify_signed_envelope(&env, SECRET, Some(1_700_000_000_000)).expect("verify");
        assert_eq!(env.mac.len(), 43, "HMAC-SHA256 base64url-unpadded length");
        assert_eq!(env.mac, EXPECTED_MAC_VECTOR_V1);
    }
}
