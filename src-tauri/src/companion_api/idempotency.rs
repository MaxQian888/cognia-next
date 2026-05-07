//! Per-device idempotency cache for the companion RPC endpoint.
//!
//! Key = `(device_id, idempotency_key_header)`.
//! Value = the JSON body returned by the first successful call.
//! TTL = 60 seconds (sliding from insertion time).
//! Capacity = 1 000 entries (oldest entry evicted on overflow).

use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Internal structures
// ---------------------------------------------------------------------------

struct CachedResponse {
    inserted_at: Instant,
    body: Value,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Thread-safe, in-memory idempotency cache.
///
/// Constructed once and placed behind an `Arc` in [`super::CompanionState`].
/// All operations take `&self` (interior mutability via `Mutex`).
pub struct IdempotencyCache {
    inner: Mutex<CacheInner>,
    capacity: usize,
    ttl: Duration,
}

struct CacheInner {
    /// Ordered map (insertion order preserved by Vec for O(1) eviction).
    map: HashMap<(String, String), CachedResponse>,
    /// Insertion-order queue used to pick the oldest entry on eviction.
    ///
    /// We keep this in sync with `map` so eviction is O(1) scan of at most
    /// 1 entry (we only need to remove the oldest when `map.len() > capacity`).
    order: Vec<(String, String)>,
}

impl CacheInner {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            order: Vec::new(),
        }
    }
}

impl IdempotencyCache {
    /// Create a cache with the production defaults (capacity = 1 000, TTL = 60 s).
    pub fn new() -> Self {
        Self::with_capacity(1_000, Duration::from_secs(60))
    }

    /// Create a cache with custom settings (useful in tests).
    pub fn with_capacity(capacity: usize, ttl: Duration) -> Self {
        Self {
            inner: Mutex::new(CacheInner::new()),
            capacity,
            ttl,
        }
    }

    /// Look up a cached response.
    ///
    /// Returns `Some(body)` when the entry exists and has **not** expired.
    /// Expired entries are removed on read ("lazy expiry") and `None` is
    /// returned so the caller re-runs the command.
    pub fn get(&self, device_id: &str, key: &str) -> Option<Value> {
        let mut inner = self.inner.lock();
        let map_key = (device_id.to_owned(), key.to_owned());
        if let Some(entry) = inner.map.get(&map_key) {
            if entry.inserted_at.elapsed() < self.ttl {
                return Some(entry.body.clone());
            }
            // Expired — remove it.
            inner.map.remove(&map_key);
            inner.order.retain(|k| k != &map_key);
        }
        None
    }

    /// Store a response.
    ///
    /// If inserting would exceed `capacity`, the oldest entry (by insertion
    /// order) is evicted first.
    pub fn put(&self, device_id: String, key: String, body: Value) {
        let mut inner = self.inner.lock();
        let map_key = (device_id, key);

        // If already present (e.g., race between two identical concurrent
        // requests), just overwrite without changing order.
        if let std::collections::hash_map::Entry::Occupied(mut occ) = inner.map.entry(map_key.clone()) {
            occ.insert(CachedResponse {
                inserted_at: Instant::now(),
                body,
            });
            return;
        }

        // Evict oldest entry if at capacity.
        if inner.map.len() >= self.capacity {
            if let Some(oldest) = inner.order.first().cloned() {
                inner.map.remove(&oldest);
                inner.order.remove(0);
            }
        }

        inner.order.push(map_key.clone());
        inner.map.insert(
            map_key,
            CachedResponse {
                inserted_at: Instant::now(),
                body,
            },
        );
    }

    /// Number of entries currently in the cache (including not-yet-expired ones).
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().map.len()
    }
}

impl Default for IdempotencyCache {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn get_on_empty_returns_none() {
        let cache = IdempotencyCache::new();
        assert!(cache.get("device-1", "key-1").is_none());
    }

    #[test]
    fn put_then_get_round_trip() {
        let cache = IdempotencyCache::new();
        let body = json!({ "ok": true, "data": 42 });
        cache.put("dev".into(), "k1".into(), body.clone());
        let got = cache.get("dev", "k1").expect("should be present");
        assert_eq!(got, body);
    }

    #[test]
    fn expired_entry_returns_none_and_is_removed() {
        // TTL of 0 ms — every entry is immediately expired.
        let cache = IdempotencyCache::with_capacity(100, Duration::from_millis(0));
        cache.put("dev".into(), "k1".into(), json!(1));
        // Sleep a little to ensure non-zero elapsed time.
        std::thread::sleep(Duration::from_millis(5));
        assert!(cache.get("dev", "k1").is_none());
        // Should have been removed on read.
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn lru_eviction_when_capacity_exceeded() {
        let cache = IdempotencyCache::with_capacity(3, Duration::from_secs(60));
        cache.put("d".into(), "k1".into(), json!(1));
        cache.put("d".into(), "k2".into(), json!(2));
        cache.put("d".into(), "k3".into(), json!(3));
        assert_eq!(cache.len(), 3);

        // Inserting a 4th entry must evict the oldest (k1).
        cache.put("d".into(), "k4".into(), json!(4));
        assert_eq!(cache.len(), 3);
        assert!(cache.get("d", "k1").is_none(), "k1 should have been evicted");
        assert!(cache.get("d", "k2").is_some());
        assert!(cache.get("d", "k3").is_some());
        assert!(cache.get("d", "k4").is_some());
    }

    #[test]
    fn different_device_id_and_key_tuples_do_not_collide() {
        let cache = IdempotencyCache::new();
        cache.put("dev-a".into(), "k1".into(), json!("a"));
        cache.put("dev-b".into(), "k1".into(), json!("b"));
        cache.put("dev-a".into(), "k2".into(), json!("c"));

        assert_eq!(cache.get("dev-a", "k1").unwrap(), json!("a"));
        assert_eq!(cache.get("dev-b", "k1").unwrap(), json!("b"));
        assert_eq!(cache.get("dev-a", "k2").unwrap(), json!("c"));
        assert!(cache.get("dev-b", "k2").is_none());
    }

    #[test]
    fn overwrite_existing_key_preserves_len() {
        let cache = IdempotencyCache::with_capacity(5, Duration::from_secs(60));
        cache.put("d".into(), "k".into(), json!(1));
        cache.put("d".into(), "k".into(), json!(2));
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("d", "k").unwrap(), json!(2));
    }
}
