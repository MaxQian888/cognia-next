//! In-process cron daemon for workflow triggers.
//!
//! Distinct from `crate::scheduler` (OS-level Task Scheduler / launchd / systemd).
//! That one delegates to the operating system; we want a daemon that fires
//! while the Tauri *process* is running, regardless of webview state. Minimizing
//! to the tray must keep workflows ticking — that's the whole reason we run this
//! in Rust instead of the renderer.
//!
//! Design:
//!
//! - One tokio task per process, sleeping until the soonest next-fire across
//!   all registered cron triggers.
//! - Wakes up after each fire OR when the registry is mutated (add / remove /
//!   update). A `Notify` handle steers the sleep loop.
//! - On fire, emits a `TriggerEvent` via the supplied emitter (a closure the
//!   caller binds to `AppHandle::emit`). The TS bridge resolves the workflow
//!   id and invokes the orchestrator.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use cron::Schedule;
use parking_lot::Mutex;
use tokio::sync::Notify;

use crate::workflow::types::{TriggerEvent, TriggerBinding};

/// One tracked cron entry. `next_fire_at` is computed at insert time and
/// recomputed after every fire — this avoids re-walking the schedule
/// iterator (`Schedule::upcoming`) on the hot path of the loop.
#[derive(Debug, Clone)]
struct CronEntry {
    trigger_id: String,
    workflow_id: String,
    schedule: Schedule,
    enabled: bool,
    binding: Option<TriggerBinding>,
    next_fire_at: Option<DateTime<Utc>>,
}

impl CronEntry {
    /// Recompute the next fire after `anchor`. Returns `None` if the schedule
    /// has no future fires (e.g., a one-shot expression that has already run).
    fn recompute(&mut self, anchor: DateTime<Utc>) {
        self.next_fire_at = self.schedule.after(&anchor).next();
    }
}

/// The mutable shared state behind the daemon.
struct DaemonInner {
    entries: HashMap<String, CronEntry>,
}

impl DaemonInner {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Compute the soonest cached next-fire-time across every enabled entry.
    /// Returns `None` when there are no enabled entries — the loop sleeps
    /// until poked.
    fn next_fire(&self) -> Option<DateTime<Utc>> {
        self.entries
            .values()
            .filter(|e| e.enabled)
            .filter_map(|e| e.next_fire_at)
            .min()
    }

    /// Collect ids of entries whose cached next_fire_at is `<= now`. Used
    /// by the loop to drain everything that came due during the sleep.
    fn due_ids(&self, now: DateTime<Utc>) -> Vec<String> {
        self.entries
            .values()
            .filter(|e| e.enabled)
            .filter(|e| e.next_fire_at.map(|t| t <= now).unwrap_or(false))
            .map(|e| e.trigger_id.clone())
            .collect()
    }
}

/// Trait the daemon uses to emit fired events. Production binds this to
/// `AppHandle::emit("workflow:trigger", payload)`; tests inject a recording
/// emitter.
pub trait TriggerEmitter: Send + Sync + 'static {
    fn emit(&self, event: TriggerEvent);
}

/// In-test emitter that records every fired event for assertions.
#[cfg(test)]
#[derive(Default, Clone)]
pub struct RecordingEmitter {
    pub fired: Arc<Mutex<Vec<TriggerEvent>>>,
}

#[cfg(test)]
impl TriggerEmitter for RecordingEmitter {
    fn emit(&self, event: TriggerEvent) {
        self.fired.lock().push(event);
    }
}

/// Public handle to the daemon. Cloning is cheap and shares the same inner
/// state; pass clones into Tauri commands.
#[derive(Clone)]
pub struct CronDaemon {
    inner: Arc<Mutex<DaemonInner>>,
    notify: Arc<Notify>,
    emitter: Arc<dyn TriggerEmitter>,
}

impl CronDaemon {
    pub fn new(emitter: Arc<dyn TriggerEmitter>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(DaemonInner::new())),
            notify: Arc::new(Notify::new()),
            emitter,
        }
    }

    /// Add or replace an entry. Returns `Err` when the cron expression fails
    /// to parse — callers surface the message back to the TS bridge.
    pub fn upsert(
        &self,
        trigger_id: String,
        workflow_id: String,
        cron_expr: &str,
        enabled: bool,
        binding: Option<TriggerBinding>,
    ) -> Result<(), String> {
        let schedule = Schedule::from_str(cron_expr)
            .map_err(|e| format!("invalid cron '{cron_expr}': {e}"))?;
        let now = Utc::now();
        let mut entry = CronEntry {
            trigger_id: trigger_id.clone(),
            workflow_id,
            schedule,
            enabled,
            binding,
            next_fire_at: None,
        };
        entry.recompute(now);
        self.inner.lock().entries.insert(trigger_id, entry);
        // Wake the loop so it recomputes the next-fire-time including this entry.
        self.notify.notify_one();
        Ok(())
    }

    pub fn remove(&self, trigger_id: &str) {
        self.inner.lock().entries.remove(trigger_id);
        self.notify.notify_one();
    }

    #[allow(dead_code)]
    pub fn entry_count(&self) -> usize {
        self.inner.lock().entries.len()
    }

    /// Convenience for tests + the diagnostics tab — returns the next-fire
    /// timestamp the loop is currently waiting on.
    #[allow(dead_code)]
    pub fn next_fire_at(&self) -> Option<DateTime<Utc>> {
        self.inner.lock().next_fire()
    }

    /// Spawn the long-running tokio task that drives firing. Should be called
    /// once during app boot.
    pub fn spawn(self) {
        tokio::spawn(async move {
            self.run_loop().await;
        });
    }

    /// The actual loop body. Public for tests so they can call it via
    /// `tokio::time::pause()` and step the clock manually if needed; in
    /// production we always call `spawn`.
    pub async fn run_loop(self) {
        loop {
            let now = Utc::now();
            // Fire any entries whose cached next_fire_at has elapsed. We
            // collect ids first to avoid holding the lock across the (cheap)
            // emit + recompute work.
            let due_ids = self.inner.lock().due_ids(now);
            for trigger_id in &due_ids {
                let snapshot = {
                    let mut inner = self.inner.lock();
                    let entry = match inner.entries.get_mut(trigger_id) {
                        Some(e) => e,
                        None => continue, // removed between collection and fire
                    };
                    let snap = entry.clone();
                    entry.recompute(now);
                    snap
                };
                self.fire(&snapshot, now);
            }

            // Compute how long to sleep until the next fire.
            let next = self.inner.lock().next_fire();
            let sleep_dur = match next {
                Some(t) => {
                    let ms = (t - Utc::now()).num_milliseconds().max(0) as u64;
                    // Floor at 25ms so we don't spin when next_fire is in
                    // the past (which can happen on a heavily loaded host
                    // where the cached time is already overdue).
                    std::time::Duration::from_millis(ms.max(25))
                }
                // No enabled entries — wait essentially forever; `notify` will
                // wake us when an upsert lands.
                None => std::time::Duration::from_secs(60 * 60),
            };

            tokio::select! {
                _ = tokio::time::sleep(sleep_dur) => {}
                _ = self.notify.notified() => {}
            }
        }
    }

    fn fire(&self, entry: &CronEntry, now: DateTime<Utc>) {
        let event = TriggerEvent {
            workflow_id: entry.workflow_id.clone(),
            kind: "trigger.cron".into(),
            payload: serde_json::json!({
                "triggerId": entry.trigger_id,
                "firedAt": now.timestamp_millis(),
            }),
            origin_at: now.timestamp_millis(),
            binding: entry.binding.clone(),
        };
        self.emitter.emit(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn daemon_with_recorder() -> (CronDaemon, RecordingEmitter) {
        let recorder = RecordingEmitter::default();
        let daemon = CronDaemon::new(Arc::new(recorder.clone()));
        (daemon, recorder)
    }

    #[test]
    fn upsert_rejects_invalid_cron_expressions() {
        let (daemon, _) = daemon_with_recorder();
        let err = daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "this is not a cron",
                true,
                None,
            )
            .unwrap_err();
        assert!(err.contains("invalid cron"));
        assert_eq!(daemon.entry_count(), 0);
    }

    #[test]
    fn upsert_accepts_valid_cron_and_replaces_on_repeat() {
        let (daemon, _) = daemon_with_recorder();
        // Cron crate uses 6- or 7-field expressions (with seconds).
        daemon
            .upsert("trg_1".into(), "wf_1".into(), "0 0 9 * * 1-5", true, None)
            .unwrap();
        daemon
            .upsert("trg_1".into(), "wf_1".into(), "0 0 10 * * 1-5", true, None)
            .unwrap();
        assert_eq!(daemon.entry_count(), 1);
    }

    #[test]
    fn remove_drops_an_entry() {
        let (daemon, _) = daemon_with_recorder();
        daemon
            .upsert("trg_1".into(), "wf_1".into(), "0 0 9 * * 1-5", true, None)
            .unwrap();
        daemon.remove("trg_1");
        assert_eq!(daemon.entry_count(), 0);
    }

    #[test]
    fn next_fire_at_returns_a_future_time_for_an_enabled_entry() {
        let (daemon, _) = daemon_with_recorder();
        daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                // Every second — guaranteed to have a future fire.
                "* * * * * *",
                true,
                None,
            )
            .unwrap();
        let next = daemon.next_fire_at().expect("expected a future fire");
        assert!(next > Utc::now() - chrono::Duration::seconds(1));
    }

    #[test]
    fn disabled_entries_are_skipped_in_next_fire_computation() {
        let (daemon, _) = daemon_with_recorder();
        daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "* * * * * *",
                false, // disabled
                None,
            )
            .unwrap();
        assert!(daemon.next_fire_at().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_loop_fires_a_due_trigger_at_least_once() {
        let (daemon, recorder) = daemon_with_recorder();
        // Every-second cron — the loop should fire it inside 1.5s.
        daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "* * * * * *",
                true,
                None,
            )
            .unwrap();
        let daemon_clone = daemon.clone();
        let _handle = tokio::spawn(async move {
            daemon_clone.run_loop().await;
        });
        // Wait long enough to give the loop a tick.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let count = recorder.fired.lock().len();
        assert!(count >= 1, "expected at least one fire, got {count}");
        let event = recorder.fired.lock()[0].clone();
        assert_eq!(event.workflow_id, "wf_1");
        assert_eq!(event.kind, "trigger.cron");
    }
}
