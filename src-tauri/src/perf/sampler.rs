//! The 1 Hz sampler that composes process + runtime + span data into a
//! [`PerfSample`] and emits it over `perf://sample`.
//!
//! Lifecycle is ref-counted like Windows Task Manager itself: the renderer
//! calls `perf_start_sampling` when the panel mounts and `perf_stop_sampling`
//! when it unmounts, so there is **zero** sampling overhead while the panel is
//! closed. A bounded ring keeps the last [`RING_CAP`] samples so a freshly
//! opened panel can backfill its rolling graphs without waiting.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::process::{ProcessSample, ProcessSampler, SystemMemory};
use super::registry::{SpanSnapshot, REGISTRY};
use super::runtime::{RuntimeSample, RuntimeSampler};

/// Tauri event channel the renderer subscribes to.
pub const SAMPLE_EVENT: &str = "perf://sample";
/// How many samples to retain for backfill (~2 min at 1 Hz).
pub const RING_CAP: usize = 120;
/// Default sampling cadence.
pub const DEFAULT_INTERVAL_MS: u64 = 1000;
/// Clamp bounds so the renderer can't ask for a pathological interval.
pub const MIN_INTERVAL_MS: u64 = 250;
pub const MAX_INTERVAL_MS: u64 = 10_000;

/// One composed performance frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerfSample {
    pub ts_ms: i64,
    pub interval_ms: u64,
    pub processes: Vec<ProcessSample>,
    pub runtime: RuntimeSample,
    pub top_spans: Vec<SpanSnapshot>,
    pub system_memory: Option<SystemMemory>,
    /// cognia-spawned child processes attributed to their owning subsystem
    /// (external agents, chat sidecar, ACP + PTY terminals, MCP server).
    /// Joined to `processes` by `pid` on the frontend for live CPU/memory.
    pub managed: Vec<crate::process_registry::ManagedProcess>,
}

/// Shared, ref-counted sampler control surface. Held in `PerfState` and cloned
/// into the background loop.
#[derive(Default)]
pub struct SamplerHandle {
    running: AtomicBool,
    interval_ms: AtomicU64,
    /// Bumped on stop so a stale loop exits even if a restart races it.
    generation: AtomicU64,
    ring: Mutex<VecDeque<PerfSample>>,
}

impl SamplerHandle {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn interval(&self) -> u64 {
        let v = self.interval_ms.load(Ordering::SeqCst);
        if v == 0 {
            DEFAULT_INTERVAL_MS
        } else {
            v
        }
    }

    pub fn set_interval(&self, ms: u64) {
        self.interval_ms
            .store(ms.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS), Ordering::SeqCst);
    }

    /// Stop the loop and invalidate its generation.
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn recent(&self) -> Vec<PerfSample> {
        self.ring.lock().iter().cloned().collect()
    }

    pub fn push(&self, sample: PerfSample) {
        let mut ring = self.ring.lock();
        if ring.len() >= RING_CAP {
            ring.pop_front();
        }
        ring.push_back(sample);
    }
}

/// Start (or reconfigure) the sampler loop. Idempotent: if a loop is already
/// running, this only updates the interval and returns. Otherwise it spawns the
/// background task on the traced runtime.
pub fn start(app: AppHandle, handle: Arc<SamplerHandle>, interval_ms: u64) {
    handle.set_interval(interval_ms);
    // `swap` makes the start atomic: only the caller that flips false→true wins.
    if handle.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let generation = handle.generation.load(Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        let mut proc_sampler = ProcessSampler::new();
        let mut rt_sampler = RuntimeSampler::new();
        // Prime CPU + runtime baselines so the first emitted frame is non-zero.
        proc_sampler.prime();
        let _ = rt_sampler.sample(&tokio::runtime::Handle::current().metrics());

        loop {
            if !handle.running.load(Ordering::SeqCst)
                || handle.generation.load(Ordering::SeqCst) != generation
            {
                break;
            }
            let ms = handle.interval();
            tokio::time::sleep(Duration::from_millis(ms)).await;
            if !handle.running.load(Ordering::SeqCst)
                || handle.generation.load(Ordering::SeqCst) != generation
            {
                break;
            }

            let interval_secs = ms as f64 / 1000.0;
            let processes = proc_sampler.sample(interval_secs);
            let runtime = rt_sampler.sample(&tokio::runtime::Handle::current().metrics());
            let top_spans = REGISTRY.snapshot();
            let system_memory = Some(proc_sampler.sample_system_memory());
            // Attribute cognia-spawned processes to their owning subsystem.
            // `collect` is non-blocking and holds no lock across this await.
            let managed = crate::process_registry::collect(&app).await;

            let sample = PerfSample {
                ts_ms: super::now_ms(),
                interval_ms: ms,
                processes,
                runtime,
                top_spans,
                system_memory,
                managed,
            };
            handle.push(sample.clone());
            if let Err(err) = app.emit(SAMPLE_EVENT, &sample) {
                log::warn!("perf://sample emit failed: {err}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perf::registry::SpanSnapshot;
    use crate::perf::runtime::RuntimeSample;

    fn dummy_sample(ts: i64) -> PerfSample {
        PerfSample {
            ts_ms: ts,
            interval_ms: 1000,
            processes: vec![],
            runtime: RuntimeSample {
                workers: 1,
                alive_tasks: 0,
                global_queue_depth: 0,
                blocking_threads: 0,
                blocking_queue_depth: 0,
                spawned_tasks_count: 0,
                budget_forced_yield_count: 0,
                worker_steal_count: 0,
                worker_park_count: 0,
                worker_overflow_count: 0,
                busy_pct: 0.0,
                per_worker_busy_pct: vec![0.0],
            },
            top_spans: Vec::<SpanSnapshot>::new(),
            system_memory: None,
            managed: Vec::new(),
        }
    }

    #[test]
    fn interval_defaults_and_clamps() {
        let h = SamplerHandle::default();
        assert_eq!(h.interval(), DEFAULT_INTERVAL_MS); // unset → default
        h.set_interval(10);
        assert_eq!(h.interval(), MIN_INTERVAL_MS); // clamped up
        h.set_interval(99_999);
        assert_eq!(h.interval(), MAX_INTERVAL_MS); // clamped down
        h.set_interval(2000);
        assert_eq!(h.interval(), 2000);
    }

    #[test]
    fn ring_is_bounded_and_ordered() {
        let h = SamplerHandle::default();
        for i in 0..(RING_CAP as i64 + 10) {
            h.push(dummy_sample(i));
        }
        let recent = h.recent();
        assert_eq!(recent.len(), RING_CAP);
        // Oldest entries evicted; the last one is the most recent push.
        assert_eq!(recent.first().unwrap().ts_ms, 10);
        assert_eq!(recent.last().unwrap().ts_ms, RING_CAP as i64 + 9);
    }

    #[test]
    fn stop_marks_not_running_and_bumps_generation() {
        let h = SamplerHandle::default();
        h.running.store(true, Ordering::SeqCst);
        let g0 = h.generation.load(Ordering::SeqCst);
        h.stop();
        assert!(!h.is_running());
        assert_eq!(h.generation.load(Ordering::SeqCst), g0 + 1);
    }
}
