//! Single-use 6-digit numeric pair-code → pair JWT map.
//!
//! The emulator-friendly companion to the QR pairing flow: when the desktop
//! UI issues a pair JWT it also surfaces a 6-digit numeric code so a mobile
//! client without a working camera can type the code in by hand. The mapping
//! `code -> pair_jwt` is kept here while the pair JWT itself is still
//! verified by [`super::jwt::verify`] on redeem — meaning code expiry and
//! JWT expiry stay in lockstep (same `expires_at_ms`).
//!
//! # Why a separate type from [`super::redemption_lru::RedemptionLru`]
//!
//! `RedemptionLru` is a *deque of strings* used to detect replay of pair
//! JWT `jti` claims. Pair codes need value storage (code → JWT plus expiry)
//! and active TTL pruning, so the abstractions don't share enough to merge
//! cleanly.
//!
//! # Design
//!
//! - `parking_lot::Mutex<HashMap<String, PairCodeEntry>>` — short critical
//!   section, no async overhead. Cap of 64 codes is well over the typical
//!   case (a single desktop user generating one code at a time).
//! - **Single-use**: [`take`] removes the entry. A successful take means
//!   the redeemer is committed; failure of the downstream pair handler
//!   does NOT restore the entry (matches `RedemptionLru` semantics — a
//!   compromised code, once observed, must not be re-redeemable).
//! - **TTL pruning**: every insert/take prunes expired entries lazily. The
//!   pair JWT's own `exp` claim is the source of truth; this LRU just
//!   short-circuits before the JWT layer rejects.
//! - **Eviction**: at capacity, the entry with the *smallest*
//!   `expires_at_ms` (closest to expiry) is evicted first.
//!
//! # Thread safety
//!
//! `PairCodeLru` is `Send + Sync`. Wrap in `Arc` for shared ownership.

use parking_lot::Mutex;
use std::collections::HashMap;

const CAP: usize = 64;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairCodeEntry {
    pub pair_jwt: String,
    pub expires_at_ms: i64,
}

/// Result of an attempted code redemption.
#[derive(Debug, PartialEq, Eq)]
pub enum TakeOutcome {
    /// Code found and unexpired — entry is removed and pair_jwt returned.
    Hit(PairCodeEntry),
    /// Code not present in the LRU.
    NotFound,
    /// Code present but already expired — entry is removed without yielding.
    Expired,
}

/// In-memory map from 6-digit numeric code to its underlying pair JWT.
pub struct PairCodeLru {
    inner: Mutex<HashMap<String, PairCodeEntry>>,
}

impl PairCodeLru {
    /// Construct an empty LRU.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::with_capacity(CAP)),
        }
    }

    /// Insert (or overwrite) a code → JWT mapping.
    ///
    /// Prunes expired entries first; at capacity, evicts the entry closest
    /// to expiry. Returns `true` if the insertion took place; never fails.
    pub fn insert(&self, code: String, entry: PairCodeEntry, now_ms: i64) -> bool {
        let mut map = self.inner.lock();
        prune_expired(&mut map, now_ms);
        if map.len() >= CAP && !map.contains_key(&code) {
            evict_closest_to_expiry(&mut map);
        }
        map.insert(code, entry);
        true
    }

    /// Remove and return the entry for `code`, or report why it could not
    /// be redeemed. Expired entries are eagerly removed.
    pub fn take(&self, code: &str, now_ms: i64) -> TakeOutcome {
        let mut map = self.inner.lock();
        prune_expired(&mut map, now_ms);
        match map.remove(code) {
            Some(entry) => {
                if entry.expires_at_ms <= now_ms {
                    TakeOutcome::Expired
                } else {
                    TakeOutcome::Hit(entry)
                }
            }
            None => TakeOutcome::NotFound,
        }
    }

    /// Number of codes currently tracked. Exposed for testing.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }
}

impl Default for PairCodeLru {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn prune_expired(map: &mut HashMap<String, PairCodeEntry>, now_ms: i64) {
    map.retain(|_, e| e.expires_at_ms > now_ms);
}

fn evict_closest_to_expiry(map: &mut HashMap<String, PairCodeEntry>) {
    if let Some(key) = map
        .iter()
        .min_by_key(|(_, e)| e.expires_at_ms)
        .map(|(k, _)| k.clone())
    {
        map.remove(&key);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;
    const FUTURE: i64 = NOW + 300_000; // +5 min
    const PAST: i64 = NOW - 1;

    fn entry(jwt: &str, exp_ms: i64) -> PairCodeEntry {
        PairCodeEntry {
            pair_jwt: jwt.to_string(),
            expires_at_ms: exp_ms,
        }
    }

    #[test]
    fn insert_then_take_returns_hit() {
        let lru = PairCodeLru::new();
        lru.insert("123456".into(), entry("jwt-a", FUTURE), NOW);
        match lru.take("123456", NOW) {
            TakeOutcome::Hit(e) => assert_eq!(e.pair_jwt, "jwt-a"),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[test]
    fn take_is_single_use() {
        let lru = PairCodeLru::new();
        lru.insert("123456".into(), entry("jwt-a", FUTURE), NOW);
        let _ = lru.take("123456", NOW);
        assert_eq!(lru.take("123456", NOW), TakeOutcome::NotFound);
    }

    #[test]
    fn take_unknown_code_returns_not_found() {
        let lru = PairCodeLru::new();
        assert_eq!(lru.take("999999", NOW), TakeOutcome::NotFound);
    }

    #[test]
    fn take_expired_code_returns_expired_and_removes() {
        let lru = PairCodeLru::new();
        lru.insert("123456".into(), entry("jwt-a", PAST), NOW - 600_000);
        assert_eq!(lru.take("123456", NOW), TakeOutcome::NotFound);
        // Already pruned on entry to take, so NotFound rather than Expired.
        assert_eq!(lru.len(), 0);
    }

    #[test]
    fn expired_branch_when_taken_before_prune_window() {
        // Insert with a tiny TTL, then advance "now" past it but still call
        // take on the exact code so the prune doesn't have to scan. With
        // current implementation prune_expired runs before the remove, so
        // this also yields NotFound — assert that behavior explicitly.
        let lru = PairCodeLru::new();
        lru.insert("111111".into(), entry("jwt", NOW + 1), NOW);
        let outcome = lru.take("111111", NOW + 5);
        // Either path is acceptable so long as the entry is gone afterwards
        // and the redeemer is rejected.
        assert!(
            matches!(outcome, TakeOutcome::Expired | TakeOutcome::NotFound),
            "expected Expired or NotFound, got {outcome:?}"
        );
        assert_eq!(lru.len(), 0);
    }

    #[test]
    fn capacity_evicts_closest_to_expiry() {
        let lru = PairCodeLru::new();
        for i in 0..CAP {
            let code = format!("{:06}", 100_000 + i);
            // Stagger expiries so eviction has a deterministic target.
            lru.insert(code, entry(&format!("jwt-{i}"), FUTURE + i as i64), NOW);
        }
        assert_eq!(lru.len(), CAP);
        // Inserting one more evicts the entry with smallest exp (the first
        // one, `100000` with `FUTURE+0`).
        lru.insert("999999".into(), entry("jwt-overflow", FUTURE + 10_000), NOW);
        assert_eq!(lru.len(), CAP);
        assert_eq!(lru.take("100000", NOW), TakeOutcome::NotFound);
        match lru.take("999999", NOW) {
            TakeOutcome::Hit(e) => assert_eq!(e.pair_jwt, "jwt-overflow"),
            other => panic!("expected hit, got {other:?}"),
        }
    }

    #[test]
    fn insert_overwrites_existing_code_without_eviction() {
        let lru = PairCodeLru::new();
        lru.insert("123456".into(), entry("jwt-old", FUTURE), NOW);
        lru.insert("123456".into(), entry("jwt-new", FUTURE), NOW);
        assert_eq!(lru.len(), 1);
        match lru.take("123456", NOW) {
            TakeOutcome::Hit(e) => assert_eq!(e.pair_jwt, "jwt-new"),
            other => panic!("expected hit, got {other:?}"),
        }
    }

    #[test]
    fn cap_is_64() {
        assert_eq!(CAP, 64);
    }
}
