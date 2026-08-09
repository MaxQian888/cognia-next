//! Per-upstream-key cooldown + permanent-disable tracking (W1.1 + W3.1).
//!
//! Borrowed from sub2api's per-error-code rate-limit service, collapsed to a
//! single-process in-memory map (no Redis). When a pooled upstream key is
//! rate-limited (429/529) the gateway parks it for a cooldown window so the
//! failover walk stops re-selecting a key the upstream just refused — which
//! wastes the failover budget and accelerates upstream risk-control. A key
//! that is permanently dead (401 / `insufficient_quota` / org disabled) is
//! disabled outright until the renderer pushes a fresh snapshot.
//!
//! The cooldown window is derived from the upstream's own recovery hint when
//! present (`Retry-After`, Anthropic `anthropic-ratelimit-unified-reset`), so
//! the same value can also be forwarded to the renderer's circuit breaker
//! (its dynamic-cooldown path already consumes `retryAfterMs`).

use std::collections::HashMap;

use parking_lot::Mutex;

/// Upper bound on any parsed cooldown so a bogus / hostile upstream header
/// can't park a key effectively forever.
const MAX_COOLDOWN_MS: i64 = 60 * 60 * 1000; // 1h

/// One pooled key's cooldown / disable state.
#[derive(Debug, Clone)]
pub struct CooldownState {
    /// Epoch-ms until which the key is parked. Ignored when `permanent`.
    pub until_ms: i64,
    /// Permanently disabled (never auto-recovers within the current snapshot).
    pub permanent: bool,
    /// Human-readable reason, surfaced to the status UI.
    pub reason: String,
}

/// `(provider_id, api_key)` → cooldown state. Lives on `GatewayState`, shared
/// with the running server so cooldowns persist across requests. Process-local
/// and reset on restart (a fresh, empty map after restart is harmless).
pub type KeyCooldownMap = Mutex<HashMap<(String, String), CooldownState>>;

/// Compute the cooldown window (ms from now) an upstream response implies, or
/// `None` when the status carries no account-level cooldown signal. Pure — the
/// caller pulls the two header values off the response.
///
/// Precedence: an explicit `Retry-After` (integer seconds) wins, then
/// Anthropic's absolute `anthropic-ratelimit-unified-reset` (epoch seconds),
/// then a status-based fallback (429 → `fallback_secs`, 529 → `overload_secs`).
/// Transient 5xx (500/502/503/504) carry NO cooldown — they roll over on the
/// failover walk without parking the account.
pub fn cooldown_ms_from_headers(
    status: u16,
    retry_after: Option<&str>,
    unified_reset: Option<&str>,
    fallback_secs: u32,
    overload_secs: u32,
    now_ms: i64,
) -> Option<i64> {
    // Explicit Retry-After (integer seconds) wins for any status that sends it.
    if let Some(secs) = retry_after.and_then(|v| v.trim().parse::<i64>().ok()) {
        if secs >= 0 {
            return Some((secs.saturating_mul(1000)).min(MAX_COOLDOWN_MS));
        }
    }
    // Anthropic's unified reset is an ABSOLUTE epoch-seconds timestamp.
    if let Some(epoch) = unified_reset.and_then(|v| v.trim().parse::<i64>().ok()) {
        let delta = epoch.saturating_mul(1000).saturating_sub(now_ms);
        if delta > 0 {
            return Some(delta.min(MAX_COOLDOWN_MS));
        }
        // Reset already in the past → no cooldown.
    }
    match status {
        429 if fallback_secs > 0 => Some((fallback_secs as i64 * 1000).min(MAX_COOLDOWN_MS)),
        529 if overload_secs > 0 => Some((overload_secs as i64 * 1000).min(MAX_COOLDOWN_MS)),
        _ => None,
    }
}

/// Classify a terminal upstream failure as a PERMANENT key death (W3.1).
/// Returns `Some(reason)` when the key should be disabled outright rather than
/// merely cooled: a 401 (bad/dead credential), or any configured keyword
/// (`insufficient_quota`, `organization has been disabled`, …) appearing in
/// the response body. Keyword match is case-insensitive.
pub fn permanent_failure_reason(status: u16, body: &str, keywords: &[String]) -> Option<String> {
    if status == 401 {
        return Some("unauthorized (401)".to_string());
    }
    let lower = body.to_lowercase();
    keywords
        .iter()
        .map(|k| k.trim())
        .find(|kw| !kw.is_empty() && lower.contains(&kw.to_lowercase()))
        .map(|kw| format!("upstream reported: {kw}"))
}

/// Park a pooled key for a temporary cooldown (until `until_ms`).
pub fn record_cooldown(
    map: &KeyCooldownMap,
    provider_id: &str,
    api_key: &str,
    until_ms: i64,
    reason: &str,
) {
    map.lock().insert(
        (provider_id.to_string(), api_key.to_string()),
        CooldownState {
            until_ms,
            permanent: false,
            reason: reason.to_string(),
        },
    );
}

/// Mark a pooled key permanently disabled (W3.1). Never auto-recovers.
pub fn record_permanent(map: &KeyCooldownMap, provider_id: &str, api_key: &str, reason: &str) {
    map.lock().insert(
        (provider_id.to_string(), api_key.to_string()),
        CooldownState {
            until_ms: i64::MAX,
            permanent: true,
            reason: reason.to_string(),
        },
    );
}

/// Filter a provider's ordered key pool down to the keys usable RIGHT NOW.
///
/// Permanently-disabled keys are dropped unconditionally. Cooling keys are
/// dropped too. A fully cooling pool returns no usable key, preventing the
/// gateway from hammering the earliest-recovering account before its provider
/// supplied recovery window has elapsed.
pub fn usable_pool(
    map: &KeyCooldownMap,
    provider_id: &str,
    pool: &[String],
    now_ms: i64,
) -> Vec<String> {
    let guard = map.lock();
    let mut usable: Vec<String> = Vec::with_capacity(pool.len());
    for key in pool {
        match guard.get(&(provider_id.to_string(), key.clone())) {
            Some(s) if s.permanent => {} // never usable
            Some(s) if s.until_ms > now_ms => {}
            _ => usable.push(key.clone()),
        }
    }
    usable
}

/// Earliest temporary recovery when every non-permanently-disabled key in a
/// pool is cooling. Returns `None` when any key is usable now or the pool has
/// no recoverable key.
pub fn all_cooling_retry_after_ms(
    map: &KeyCooldownMap,
    provider_id: &str,
    pool: &[String],
    now_ms: i64,
) -> Option<i64> {
    let guard = map.lock();
    let mut earliest: Option<i64> = None;
    for key in pool {
        match guard.get(&(provider_id.to_string(), key.clone())) {
            Some(state) if state.permanent => {}
            Some(state) if state.until_ms > now_ms => {
                earliest = Some(earliest.map_or(state.until_ms, |value| value.min(state.until_ms)));
            }
            _ => return None,
        }
    }
    earliest.map(|until| until.saturating_sub(now_ms))
}

/// A cooling/disabled key surfaced to the status UI (W3.1 visibility).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CooldownRow {
    pub provider_id: String,
    /// Key fingerprint (last 4 chars) — never the secret.
    pub key_hint: String,
    pub until_ms: i64,
    pub permanent: bool,
    pub reason: String,
}

/// Snapshot the current cooldown/disabled keys for the status surface, dropping
/// expired temporary cooldowns. Secrets are reduced to a 4-char fingerprint.
pub fn snapshot_rows(map: &KeyCooldownMap, now_ms: i64) -> Vec<CooldownRow> {
    map.lock()
        .iter()
        .filter(|(_, s)| s.permanent || s.until_ms > now_ms)
        .map(|((provider_id, key), s)| CooldownRow {
            provider_id: provider_id.clone(),
            key_hint: key_fingerprint(key),
            until_ms: s.until_ms,
            permanent: s.permanent,
            reason: s.reason.clone(),
        })
        .collect()
}

pub fn key_fingerprint(key: &str) -> String {
    let n = key.chars().count();
    if n <= 4 {
        "…".to_string()
    } else {
        format!("…{}", &key[key.len().saturating_sub(4)..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_seconds_wins_for_any_status() {
        // 30s Retry-After → 30_000ms, regardless of status.
        assert_eq!(
            cooldown_ms_from_headers(429, Some("30"), None, 20, 600, 0),
            Some(30_000)
        );
        assert_eq!(
            cooldown_ms_from_headers(529, Some("5"), None, 20, 600, 0),
            Some(5_000)
        );
    }

    #[test]
    fn unified_reset_is_absolute_epoch() {
        // now = 1000s, reset at 1030s → 30_000ms remaining.
        let now_ms = 1_000_000;
        assert_eq!(
            cooldown_ms_from_headers(429, None, Some("1030"), 20, 600, now_ms),
            Some(30_000)
        );
        // A reset already in the past → falls through to the 429 fallback.
        assert_eq!(
            cooldown_ms_from_headers(429, None, Some("900"), 20, 600, now_ms),
            Some(20_000)
        );
    }

    #[test]
    fn status_fallbacks_apply_only_without_headers() {
        assert_eq!(
            cooldown_ms_from_headers(429, None, None, 20, 600, 0),
            Some(20_000)
        );
        assert_eq!(
            cooldown_ms_from_headers(529, None, None, 20, 600, 0),
            Some(600_000)
        );
        // 429 with fallback disabled (0) → no cooldown.
        assert_eq!(cooldown_ms_from_headers(429, None, None, 0, 600, 0), None);
        // Transient 5xx never cool.
        assert_eq!(cooldown_ms_from_headers(503, None, None, 20, 600, 0), None);
        assert_eq!(cooldown_ms_from_headers(500, None, None, 20, 600, 0), None);
    }

    #[test]
    fn cooldown_is_clamped_to_an_hour() {
        assert_eq!(
            cooldown_ms_from_headers(429, Some("99999999"), None, 20, 600, 0),
            Some(MAX_COOLDOWN_MS)
        );
    }

    #[test]
    fn permanent_failure_matches_401_and_keywords() {
        let kw = vec![
            "insufficient_quota".to_string(),
            "organization has been disabled".to_string(),
        ];
        assert!(permanent_failure_reason(401, "whatever", &kw).is_some());
        assert!(permanent_failure_reason(403, "Error: INSUFFICIENT_QUOTA now", &kw).is_some());
        assert!(
            permanent_failure_reason(400, "This organization has been disabled", &kw).is_some()
        );
        // A plain rate limit is NOT permanent.
        assert!(permanent_failure_reason(429, "rate limit exceeded", &kw).is_none());
        assert!(permanent_failure_reason(500, "upstream boom", &kw).is_none());
    }

    #[test]
    fn usable_pool_skips_parked_and_fails_fast_when_all_cool() {
        let map = KeyCooldownMap::default();
        let pool = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        // b cooling until 100, c cooling until 50 → a usable.
        record_cooldown(&map, "p", "b", 100, "x");
        record_cooldown(&map, "p", "c", 50, "x");
        assert_eq!(usable_pool(&map, "p", &pool, 0), vec!["a".to_string()]);

        // Now a permanently disabled AND still within cool windows → fail fast.
        record_permanent(&map, "p", "a", "quota");
        assert!(usable_pool(&map, "p", &pool, 0).is_empty());

        // After the cool windows expire, the two cooling keys are usable again;
        // the permanent one stays dropped.
        assert_eq!(
            usable_pool(&map, "p", &pool, 200),
            vec!["b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn usable_pool_all_permanent_is_empty() {
        let map = KeyCooldownMap::default();
        let pool = vec!["a".to_string(), "b".to_string()];
        record_permanent(&map, "p", "a", "quota");
        record_permanent(&map, "p", "b", "401");
        assert!(usable_pool(&map, "p", &pool, 0).is_empty());
    }

    #[test]
    fn all_cooling_reports_earliest_recovery_only_when_exhausted() {
        let map = KeyCooldownMap::default();
        let pool = vec!["a".to_string(), "b".to_string()];
        record_cooldown(&map, "p", "a", 300, "rate limit");
        record_cooldown(&map, "p", "b", 100, "rate limit");
        assert_eq!(all_cooling_retry_after_ms(&map, "p", &pool, 0), Some(100));
        assert_eq!(all_cooling_retry_after_ms(&map, "p", &pool, 150), None);
    }

    #[test]
    fn snapshot_rows_drops_expired_and_fingerprints() {
        let map = KeyCooldownMap::default();
        record_cooldown(&map, "p", "sk-secret-1234", 100, "HTTP 429");
        record_permanent(&map, "p", "sk-dead-9999", "quota");
        record_cooldown(&map, "p", "sk-expired-0000", 10, "HTTP 429");
        let rows = snapshot_rows(&map, 50); // expired one dropped
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.key_hint.starts_with('…')));
        // No full secret leaks.
        let json = serde_json::to_string(&rows).unwrap();
        assert!(!json.contains("sk-secret-1234"));
        assert!(!json.contains("sk-dead-9999"));
    }
}
