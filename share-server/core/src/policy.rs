//! Pure decision logic for the share service — the subtle, security-relevant
//! parts that must behave identically to the Cloudflare Worker.
//!
//! All functions here are deterministic and side-effect-free: the caller
//! injects the clock (`now_ms`) and feeds back whatever the storage layer holds.

use serde_json::Value;

use crate::proto::ShareMeta;

/// Structural validation of a candidate envelope, matching `looksLikeEnvelope`
/// in `share-server/worker/src/index.ts`: `v === 1`, `alg === "AES-GCM"`, and
/// `iv` / `ciphertext` / `checksum` are strings. The server stays blind — it
/// never decrypts, so it only checks the shape it must store and serve back.
pub fn looks_like_envelope(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    obj.get("v").and_then(Value::as_i64) == Some(1)
        && obj.get("alg").and_then(Value::as_str) == Some("AES-GCM")
        && obj.get("iv").map(Value::is_string).unwrap_or(false)
        && obj.get("ciphertext").map(Value::is_string).unwrap_or(false)
        && obj.get("checksum").map(Value::is_string).unwrap_or(false)
}

/// Length-independent constant-time string comparison, mirroring the Worker's
/// `timingSafeEqual`. Folds the length difference into the accumulator so an
/// early length mismatch can never short-circuit and leak timing.
pub fn timing_safe_eq(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let len = ab.len().max(bb.len());
    let mut mismatch: usize = ab.len() ^ bb.len();
    for i in 0..len {
        let x = ab.get(i).copied().unwrap_or(0);
        let y = bb.get(i).copied().unwrap_or(0);
        mismatch |= (x ^ y) as usize;
    }
    mismatch == 0
}

/// Outcome of evaluating a read against the current share metadata. The storage
/// layer turns this into the actual row mutation inside one transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadDecision {
    /// Gate failed (revoked / expired / view cap already reached). The caller
    /// returns `404` and deletes the row if it still exists.
    NotFound,
    /// Serve the envelope, then delete the row — this is the last allowed view.
    ServeAndDestroy,
    /// Serve the envelope and bump `view_count` to `next_count`.
    ServeAndUpdate { next_count: u64 },
}

/// Decide what a read should do, reproducing `handleRead`
/// (`share-server/worker/src/index.ts`) exactly:
///
/// 1. revoked ⇒ not found
/// 2. `expires_at` reached ⇒ not found (caller deletes)
/// 3. `view_count >= max_views` already ⇒ not found (caller deletes)
/// 4. otherwise serve; if `view_count + 1 >= max_views` this is the final view
///    (`ServeAndDestroy`), else bump the counter (`ServeAndUpdate`).
pub fn evaluate_read(meta: &ShareMeta, now_ms: i64) -> ReadDecision {
    if meta.revoked {
        return ReadDecision::NotFound;
    }
    if let Some(exp) = meta.expires_at {
        if now_ms >= exp {
            return ReadDecision::NotFound;
        }
    }
    if let Some(mv) = meta.max_views {
        if meta.view_count >= mv {
            return ReadDecision::NotFound;
        }
    }
    let next = meta.view_count + 1;
    let exhausted = matches!(meta.max_views, Some(mv) if next >= mv);
    if exhausted {
        ReadDecision::ServeAndDestroy
    } else {
        ReadDecision::ServeAndUpdate { next_count: next }
    }
}

/// Whether a request carrying `origin` is allowed given `allowlist`. Copied from
/// the signaling policy: an empty allowlist allows everything (the opt-in
/// default), a missing `Origin` (native clients) always passes, otherwise the
/// origin must match an entry exactly.
pub fn is_origin_allowed(origin: Option<&str>, allowlist: &[String]) -> bool {
    if allowlist.is_empty() {
        return true;
    }
    match origin {
        None => true,
        Some(origin) => allowlist.iter().any(|allowed| allowed == origin),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(expires_at: Option<i64>, max_views: Option<u64>, view_count: u64, revoked: bool) -> ShareMeta {
        ShareMeta {
            created_at: 0,
            expires_at,
            max_views,
            burn_after_read: max_views == Some(1),
            view_count,
            revoked,
        }
    }

    #[test]
    fn valid_envelope_passes() {
        let v = json!({
            "v": 1, "alg": "AES-GCM", "iv": "aa", "ciphertext": "bb", "checksum": "cc"
        });
        assert!(looks_like_envelope(&v));
    }

    #[test]
    fn envelope_with_optional_pp_passes() {
        let v = json!({
            "v": 1, "alg": "AES-GCM", "iv": "aa", "ciphertext": "bb", "checksum": "cc",
            "pp": { "kdf": "PBKDF2", "hash": "SHA-256", "iterations": 100000, "salt": "ss" }
        });
        assert!(looks_like_envelope(&v));
    }

    #[test]
    fn envelope_rejects_wrong_version_alg_or_missing_fields() {
        assert!(!looks_like_envelope(&json!({ "v": 2, "alg": "AES-GCM", "iv": "a", "ciphertext": "b", "checksum": "c" })));
        assert!(!looks_like_envelope(&json!({ "v": 1, "alg": "RSA", "iv": "a", "ciphertext": "b", "checksum": "c" })));
        assert!(!looks_like_envelope(&json!({ "v": 1, "alg": "AES-GCM", "ciphertext": "b", "checksum": "c" })));
        assert!(!looks_like_envelope(&json!({ "v": 1, "alg": "AES-GCM", "iv": 5, "ciphertext": "b", "checksum": "c" })));
        assert!(!looks_like_envelope(&json!("not an object")));
        assert!(!looks_like_envelope(&json!(null)));
    }

    #[test]
    fn timing_safe_eq_matches_only_identical_strings() {
        assert!(timing_safe_eq("hunter2", "hunter2"));
        assert!(!timing_safe_eq("hunter2", "hunter3"));
        assert!(!timing_safe_eq("hunter2", "hunter2x"));
        assert!(!timing_safe_eq("", "x"));
        assert!(timing_safe_eq("", ""));
    }

    #[test]
    fn read_not_found_when_revoked() {
        assert_eq!(evaluate_read(&meta(None, None, 0, true), 100), ReadDecision::NotFound);
    }

    #[test]
    fn read_not_found_when_expired() {
        assert_eq!(evaluate_read(&meta(Some(100), None, 0, false), 100), ReadDecision::NotFound);
        assert_eq!(evaluate_read(&meta(Some(100), None, 0, false), 101), ReadDecision::NotFound);
    }

    #[test]
    fn read_serves_before_expiry() {
        assert_eq!(
            evaluate_read(&meta(Some(100), None, 0, false), 99),
            ReadDecision::ServeAndUpdate { next_count: 1 }
        );
    }

    #[test]
    fn read_unlimited_views_just_bumps() {
        assert_eq!(
            evaluate_read(&meta(None, None, 7, false), 0),
            ReadDecision::ServeAndUpdate { next_count: 8 }
        );
    }

    #[test]
    fn read_max_views_destroys_on_final_view() {
        // max_views = 3, already viewed twice → this (3rd) is the last.
        assert_eq!(evaluate_read(&meta(None, Some(3), 2, false), 0), ReadDecision::ServeAndDestroy);
        // viewed once → serve and bump to 2.
        assert_eq!(
            evaluate_read(&meta(None, Some(3), 1, false), 0),
            ReadDecision::ServeAndUpdate { next_count: 2 }
        );
        // already at cap → not found.
        assert_eq!(evaluate_read(&meta(None, Some(3), 3, false), 0), ReadDecision::NotFound);
    }

    #[test]
    fn read_burn_after_read_destroys_on_first_view() {
        assert_eq!(evaluate_read(&meta(None, Some(1), 0, false), 0), ReadDecision::ServeAndDestroy);
    }

    #[test]
    fn origin_empty_allowlist_allows_all() {
        assert!(is_origin_allowed(Some("https://evil.example"), &[]));
        assert!(is_origin_allowed(None, &[]));
    }

    #[test]
    fn origin_must_match_when_configured() {
        let allow = vec!["https://app.cognia.cn".to_string()];
        assert!(is_origin_allowed(None, &allow));
        assert!(is_origin_allowed(Some("https://app.cognia.cn"), &allow));
        assert!(!is_origin_allowed(Some("https://evil.example"), &allow));
    }
}
