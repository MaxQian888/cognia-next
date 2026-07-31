//! In-process metrics registry for perf spans — the data behind the Hotspots
//! table.
//!
//! Each distinct (`&'static str`) span name accumulates a [`SpanStats`] holding
//! count / error count / total / min / max plus a fixed **log-bucket
//! histogram** for approximate p50 / p95. The histogram is dependency-free and
//! fixed-size, so memory is bounded by the (small, curated) set of span names —
//! the registry never grows unboundedly the way a per-call list would.
//!
//! The global [`REGISTRY`] is written by [`super::span`] from anywhere in the
//! backend and read by the sampler + the `perf_hotspots` command.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

/// Number of log-scale buckets. Bucket `i` covers `[2^i, 2^(i+1))` micro-
/// seconds, so 25 buckets reach `2^25 µs ≈ 33.6 s` — well past any operation we
/// would instrument as a single span.
pub const HIST_BUCKETS: usize = 25;

/// Process-global span registry. Lazy because `HashMap::new()` is not `const`.
pub static REGISTRY: Lazy<MetricsRegistry> = Lazy::new(MetricsRegistry::default);

/// Optional zero-dependency bridge for exporting each real observation. The
/// desktop shell installs it only when its `otel-export` feature is enabled.
pub type MetricsObserver = fn(&'static str, Duration, bool);
static METRICS_OBSERVER: OnceLock<MetricsObserver> = OnceLock::new();

pub fn set_metrics_observer(observer: MetricsObserver) -> Result<(), MetricsObserver> {
    METRICS_OBSERVER.set(observer)
}

/// Fixed-size log-bucket histogram over microsecond durations.
#[derive(Debug, Clone)]
pub struct Histogram {
    buckets: [u64; HIST_BUCKETS],
    count: u64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self {
            buckets: [0; HIST_BUCKETS],
            count: 0,
        }
    }
}

/// Bucket index for a microsecond value: the position of its highest set bit,
/// clamped to the last bucket. `0 µs` and `1 µs` both land in bucket 0.
fn bucket_index(micros: u64) -> usize {
    if micros == 0 {
        return 0;
    }
    let bits = 64 - micros.leading_zeros() as usize; // 1 for [1,2), 2 for [2,4)…
    bits.saturating_sub(1).min(HIST_BUCKETS - 1)
}

/// Upper bound (exclusive) of bucket `idx`, in microseconds — used as the
/// approximate percentile value.
fn bucket_upper_micros(idx: usize) -> u64 {
    1u64 << (idx + 1).min(63)
}

impl Histogram {
    pub fn record_micros(&mut self, micros: u64) {
        self.buckets[bucket_index(micros)] += 1;
        self.count += 1;
    }

    /// Per-bucket observation counts, oldest bucket (`[0,2) µs`) first. Surfaced
    /// in the snapshot so the Hotspots table can draw a latency distribution.
    pub fn buckets(&self) -> Vec<u64> {
        self.buckets.to_vec()
    }

    /// Approximate percentile in microseconds (the upper bound of the bucket
    /// the quantile falls into). `q` is in `[0, 1]`.
    pub fn percentile_micros(&self, q: f64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let q = q.clamp(0.0, 1.0);
        let target = (q * self.count as f64).ceil().max(1.0) as u64;
        let mut cum = 0u64;
        for (i, &c) in self.buckets.iter().enumerate() {
            cum += c;
            if cum >= target {
                return bucket_upper_micros(i);
            }
        }
        bucket_upper_micros(HIST_BUCKETS - 1)
    }
}

/// Live accumulator for one span name. Durations are kept in nanoseconds for
/// precision; the serialized snapshot converts to milliseconds.
#[derive(Debug, Clone, Default)]
pub struct SpanStats {
    pub count: u64,
    pub error_count: u64,
    pub total_ns: u128,
    pub min_ns: u64,
    pub max_ns: u64,
    pub last_ts_ms: i64,
    pub hist: Histogram,
}

impl SpanStats {
    fn observe(&mut self, ns: u64, ok: bool, now_ms: i64) {
        if self.count == 0 {
            self.min_ns = ns;
            self.max_ns = ns;
        } else {
            self.min_ns = self.min_ns.min(ns);
            self.max_ns = self.max_ns.max(ns);
        }
        self.count += 1;
        if !ok {
            self.error_count += 1;
        }
        self.total_ns += ns as u128;
        self.last_ts_ms = now_ms;
        // Floor to ≥1 µs so sub-microsecond spans still register in bucket 0.
        self.hist.record_micros((ns / 1000).max(1));
    }
}

/// Serializable per-span row for the Hotspots table (camelCase to match the
/// project's `#[serde]` convention).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpanSnapshot {
    pub name: String,
    pub count: u64,
    pub error_count: u64,
    pub total_ms: f64,
    pub avg_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub last_ts_ms: i64,
    /// Log-bucket histogram counts (`HIST_BUCKETS` entries; bucket `i` covers
    /// `[2^i, 2^(i+1))` µs) for the latency-distribution sparkbar.
    pub buckets: Vec<u64>,
}

fn ns_to_ms(ns: u64) -> f64 {
    ns as f64 / 1_000_000.0
}

impl SpanSnapshot {
    fn from_stats(name: &str, s: &SpanStats) -> Self {
        let total_ms = s.total_ns as f64 / 1_000_000.0;
        Self {
            name: name.to_string(),
            count: s.count,
            error_count: s.error_count,
            total_ms,
            avg_ms: if s.count > 0 {
                total_ms / s.count as f64
            } else {
                0.0
            },
            min_ms: ns_to_ms(s.min_ns),
            max_ms: ns_to_ms(s.max_ns),
            // Histogram percentiles are in µs → ms.
            p50_ms: s.hist.percentile_micros(0.50) as f64 / 1000.0,
            p95_ms: s.hist.percentile_micros(0.95) as f64 / 1000.0,
            last_ts_ms: s.last_ts_ms,
            buckets: s.hist.buckets(),
        }
    }
}

/// Thread-safe registry keyed by static span name.
pub struct MetricsRegistry {
    inner: Mutex<HashMap<&'static str, SpanStats>>,
}

impl Default for MetricsRegistry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl MetricsRegistry {
    pub fn record(&self, name: &'static str, elapsed: Duration, ok: bool) {
        let ns = elapsed.as_nanos().min(u64::MAX as u128) as u64;
        let now = super::now_ms();
        let mut map = self.inner.lock();
        map.entry(name).or_default().observe(ns, ok, now);
        drop(map);
        if let Some(observer) = METRICS_OBSERVER.get() {
            observer(name, elapsed, ok);
        }
    }

    /// Snapshot every span, sorted by total time descending (heaviest first) so
    /// the hotspot table opens on the costliest operation.
    pub fn snapshot(&self) -> Vec<SpanSnapshot> {
        let map = self.inner.lock();
        let mut rows: Vec<SpanSnapshot> = map
            .iter()
            .map(|(name, s)| SpanSnapshot::from_stats(name, s))
            .collect();
        rows.sort_by(|a, b| {
            b.total_ms
                .partial_cmp(&a.total_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        rows
    }

    pub fn reset(&self) {
        self.inner.lock().clear();
    }

    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_index_is_monotonic_and_clamped() {
        assert_eq!(bucket_index(0), 0);
        assert_eq!(bucket_index(1), 0);
        assert_eq!(bucket_index(2), 1);
        assert_eq!(bucket_index(3), 1);
        assert_eq!(bucket_index(4), 2);
        assert_eq!(bucket_index(1023), 9);
        assert_eq!(bucket_index(1024), 10);
        // Huge values clamp to the last bucket instead of panicking.
        assert_eq!(bucket_index(u64::MAX), HIST_BUCKETS - 1);
    }

    #[test]
    fn histogram_percentile_picks_the_right_bucket() {
        let mut h = Histogram::default();
        // 90 samples around 1 ms (1000 µs → bucket 9, upper 1024) and 10 around
        // 1 s (1_000_000 µs → bucket 19, upper 2^20 = 1_048_576).
        for _ in 0..90 {
            h.record_micros(1000);
        }
        for _ in 0..10 {
            h.record_micros(1_000_000);
        }
        // p50 lands in the cheap cluster, p95 in the expensive tail.
        assert!(h.percentile_micros(0.50) <= 2048);
        assert!(h.percentile_micros(0.95) >= 1_000_000);
    }

    #[test]
    fn empty_histogram_returns_zero() {
        assert_eq!(Histogram::default().percentile_micros(0.95), 0);
    }

    #[test]
    fn record_accumulates_count_total_and_extremes() {
        let r = MetricsRegistry::default();
        r.record("op", Duration::from_millis(10), true);
        r.record("op", Duration::from_millis(30), false);
        let snap = r.snapshot();
        assert_eq!(snap.len(), 1);
        let row = &snap[0];
        assert_eq!(row.count, 2);
        assert_eq!(row.error_count, 1);
        assert!((row.total_ms - 40.0).abs() < 0.5);
        assert!((row.avg_ms - 20.0).abs() < 0.5);
        assert!((row.min_ms - 10.0).abs() < 0.5);
        assert!((row.max_ms - 30.0).abs() < 0.5);
    }

    #[test]
    fn snapshot_sorts_by_total_descending() {
        let r = MetricsRegistry::default();
        r.record("cheap", Duration::from_millis(1), true);
        r.record("expensive", Duration::from_millis(100), true);
        let snap = r.snapshot();
        assert_eq!(snap[0].name, "expensive");
        assert_eq!(snap[1].name, "cheap");
    }

    #[test]
    fn snapshot_exposes_full_histogram_buckets() {
        let r = MetricsRegistry::default();
        for _ in 0..5 {
            r.record("op", Duration::from_millis(1), true);
        }
        let snap = r.snapshot();
        let row = &snap[0];
        // Always exactly HIST_BUCKETS entries, and they sum to the call count.
        assert_eq!(row.buckets.len(), HIST_BUCKETS);
        assert_eq!(row.buckets.iter().sum::<u64>(), 5);
    }

    #[test]
    fn span_snapshot_serializes_buckets_field() {
        let r = MetricsRegistry::default();
        r.record("op", Duration::from_millis(2), true);
        let json = serde_json::to_string(&r.snapshot()[0]).unwrap();
        assert!(json.contains("\"buckets\":["));
    }

    #[test]
    fn reset_clears_all_spans() {
        let r = MetricsRegistry::default();
        r.record("op", Duration::from_millis(1), true);
        assert_eq!(r.len(), 1);
        r.reset();
        assert!(r.is_empty());
    }
}
