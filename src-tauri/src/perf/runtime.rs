//! Tokio `RuntimeMetrics` sampling — the data behind the Async Runtime tab.
//!
//! The app wires Tauri's async dispatcher to a `dial9` traced runtime (see
//! `main.rs`), and `.cargo/config.toml` sets `--cfg tokio_unstable`, so the
//! full `RuntimeMetrics` surface is available off `Handle::current().metrics()`.
//!
//! The headline number is **worker busy %**: the sum of per-worker busy
//! durations is monotonic, so we diff it against the previous sample and divide
//! by `elapsed × num_workers` to get a 0–100 utilization figure — the same
//! shape as a Task-Manager CPU graph, but for the async runtime itself.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::runtime::RuntimeMetrics;

/// A point-in-time snapshot of the async runtime.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSample {
    pub workers: usize,
    pub alive_tasks: usize,
    pub global_queue_depth: usize,
    pub blocking_threads: usize,
    pub blocking_queue_depth: usize,
    pub spawned_tasks_count: u64,
    pub budget_forced_yield_count: u64,
    /// Cumulative tasks stolen by workers from siblings (sum across workers).
    pub worker_steal_count: u64,
    /// Cumulative times workers parked waiting for work (sum across workers).
    pub worker_park_count: u64,
    /// Cumulative times a worker's local queue overflowed into the global
    /// queue (sum across workers) — a sign of bursty scheduling pressure.
    pub worker_overflow_count: u64,
    /// Mean worker busy % over the interval (0–100).
    pub busy_pct: f64,
    /// Per-worker busy % over the interval (0–100 each).
    pub per_worker_busy_pct: Vec<f64>,
}

/// Pure busy-% computation, isolated from `RuntimeMetrics` so it is unit-
/// testable without a live runtime. Returns `(mean_pct, per_worker_pct)`.
///
/// On the first sample (`prev` empty / length mismatch) everything is 0.
pub fn compute_busy_pct(prev: &[Duration], cur: &[Duration], elapsed: Duration) -> (f64, Vec<f64>) {
    let elapsed_secs = elapsed.as_secs_f64();
    if elapsed_secs <= 0.0 || prev.len() != cur.len() || cur.is_empty() {
        return (0.0, vec![0.0; cur.len()]);
    }
    let per: Vec<f64> = cur
        .iter()
        .zip(prev.iter())
        .map(|(c, p)| {
            let delta = c.saturating_sub(*p).as_secs_f64();
            ((delta / elapsed_secs) * 100.0).clamp(0.0, 100.0)
        })
        .collect();
    let mean = per.iter().sum::<f64>() / per.len() as f64;
    (mean, per)
}

/// Stateful sampler holding the previous busy-duration vector for delta math.
pub struct RuntimeSampler {
    prev_busy: Vec<Duration>,
    prev_at: Option<Instant>,
}

impl Default for RuntimeSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeSampler {
    pub fn new() -> Self {
        Self {
            prev_busy: Vec::new(),
            prev_at: None,
        }
    }

    /// Read the current `RuntimeMetrics`, compute busy % since the last call,
    /// and stash the new baseline.
    pub fn sample(&mut self, m: &RuntimeMetrics) -> RuntimeSample {
        let workers = m.num_workers();
        let cur_busy: Vec<Duration> = (0..workers).map(|i| m.worker_total_busy_duration(i)).collect();

        // Sum the per-worker cumulative scheduling counters into a single
        // throughput figure each (these are unstable per-worker accessors).
        let (mut steal, mut park, mut overflow) = (0u64, 0u64, 0u64);
        for i in 0..workers {
            steal += m.worker_steal_count(i);
            park += m.worker_park_count(i);
            overflow += m.worker_overflow_count(i);
        }

        let now = Instant::now();
        let elapsed = self
            .prev_at
            .map(|t| now.duration_since(t))
            .unwrap_or(Duration::ZERO);
        let (busy_pct, per_worker_busy_pct) = compute_busy_pct(&self.prev_busy, &cur_busy, elapsed);

        self.prev_busy = cur_busy;
        self.prev_at = Some(now);

        RuntimeSample {
            workers,
            alive_tasks: m.num_alive_tasks(),
            global_queue_depth: m.global_queue_depth(),
            blocking_threads: m.num_blocking_threads(),
            blocking_queue_depth: m.blocking_queue_depth(),
            spawned_tasks_count: m.spawned_tasks_count(),
            budget_forced_yield_count: m.budget_forced_yield_count(),
            worker_steal_count: steal,
            worker_park_count: park,
            worker_overflow_count: overflow,
            busy_pct,
            per_worker_busy_pct,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_sample_is_zero() {
        let cur = vec![Duration::from_millis(500), Duration::from_millis(500)];
        let (mean, per) = compute_busy_pct(&[], &cur, Duration::from_secs(1));
        assert_eq!(mean, 0.0);
        assert_eq!(per, vec![0.0, 0.0]);
    }

    #[test]
    fn half_busy_over_interval_is_fifty_percent() {
        let prev = vec![Duration::from_millis(0), Duration::from_millis(0)];
        let cur = vec![Duration::from_millis(500), Duration::from_millis(250)];
        let (mean, per) = compute_busy_pct(&prev, &cur, Duration::from_secs(1));
        assert!((per[0] - 50.0).abs() < 0.001);
        assert!((per[1] - 25.0).abs() < 0.001);
        assert!((mean - 37.5).abs() < 0.001);
    }

    #[test]
    fn busy_is_clamped_to_one_hundred() {
        let prev = vec![Duration::from_millis(0)];
        let cur = vec![Duration::from_millis(5000)]; // impossible over 1s, clamp
        let (mean, _) = compute_busy_pct(&prev, &cur, Duration::from_secs(1));
        assert_eq!(mean, 100.0);
    }

    #[test]
    fn zero_elapsed_yields_zero() {
        let prev = vec![Duration::from_millis(0)];
        let cur = vec![Duration::from_millis(500)];
        let (mean, _) = compute_busy_pct(&prev, &cur, Duration::ZERO);
        assert_eq!(mean, 0.0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sampling_a_live_runtime_reports_workers() {
        let metrics = tokio::runtime::Handle::current().metrics();
        let mut s = RuntimeSampler::new();
        let first = s.sample(&metrics);
        assert_eq!(first.workers, 2);
        assert_eq!(first.busy_pct, 0.0); // no prior baseline
        let second = s.sample(&metrics);
        assert_eq!(second.workers, 2);
        assert!(second.busy_pct >= 0.0 && second.busy_pct <= 100.0);
        // The new throughput counters are cumulative and never decrease.
        assert!(second.worker_steal_count >= first.worker_steal_count);
        assert!(second.worker_park_count >= first.worker_park_count);
        assert!(second.worker_overflow_count >= first.worker_overflow_count);
    }

    #[test]
    fn runtime_sample_serializes_camel_case() {
        let sample = RuntimeSample {
            workers: 4,
            alive_tasks: 1,
            global_queue_depth: 0,
            blocking_threads: 0,
            blocking_queue_depth: 0,
            spawned_tasks_count: 7,
            budget_forced_yield_count: 0,
            worker_steal_count: 12,
            worker_park_count: 34,
            worker_overflow_count: 5,
            busy_pct: 50.0,
            per_worker_busy_pct: vec![50.0; 4],
        };
        let json = serde_json::to_string(&sample).unwrap();
        assert!(json.contains("\"workerStealCount\":12"));
        assert!(json.contains("\"workerParkCount\":34"));
        assert!(json.contains("\"workerOverflowCount\":5"));
    }
}
