//! In-process alarm daemon for the app-level scheduler.
//!
//! Distinct from the rest of `crate::scheduler` (which delegates to the OS
//! Task Scheduler / launchd / systemd) and a sibling of
//! `crate::workflow::triggers::cron_daemon`. Like that workflow daemon, the
//! whole point of living in Rust is that it keeps firing while the Tauri
//! *process* is alive even when the window is minimized to the tray — renderer
//! `setTimeout`/`setInterval` are heavily throttled on hidden webviews, so the
//! app scheduler's marquee task types (chat / agent / skill) would otherwise
//! fire late or not at all.
//!
//! Unlike the workflow daemon this one does **not** parse cron. The TypeScript
//! scheduler owns the single cron engine (`lib/scheduler/cron-parser.ts`,
//! backed by `cron-parser`) and computes the next fire instant for any trigger
//! type (cron / interval / once); it then `arm`s a single absolute timestamp.
//! This daemon is a pure "alarm clock": it sleeps until the soonest armed
//! timestamp, emits a `scheduler:task-due` event, and removes the entry. The TS
//! side executes the task through its existing pipeline and re-arms the next
//! slot. Keeping one cron engine guarantees the dashboard's "next run" preview
//! matches what actually fires.
//!
//! Design mirrors `cron_daemon.rs`:
//! - One tokio task, sleeping until the soonest armed instant.
//! - A `Notify` handle wakes the loop on every `arm`/`disarm` mutation.
//! - Fires are one-shot (removed on fire); the TS side re-arms.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use tokio::sync::Notify;

use super::types::TaskDueEvent;

/// Trait the daemon uses to emit due events. Production binds this to
/// `AppHandle::emit("scheduler:task-due", payload)` via
/// `crate::scheduler::AppHandleTaskDueEmitter`; tests inject a recorder.
pub trait TaskDueEmitter: Send + Sync + 'static {
    fn emit(&self, event: TaskDueEvent);
}

/// In-test emitter that records every fired event for assertions.
#[cfg(test)]
#[derive(Default, Clone)]
pub struct RecordingEmitter {
    pub fired: Arc<Mutex<Vec<TaskDueEvent>>>,
}

#[cfg(test)]
impl TaskDueEmitter for RecordingEmitter {
    fn emit(&self, event: TaskDueEvent) {
        self.fired.lock().push(event);
    }
}

/// Mutable shared state behind the daemon: armed `task_id → fire_at`.
struct DaemonInner {
    entries: HashMap<String, DateTime<Utc>>,
}

impl DaemonInner {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Soonest armed fire instant across all entries, or `None` when idle.
    fn next_fire(&self) -> Option<DateTime<Utc>> {
        self.entries.values().min().copied()
    }

    /// Ids whose armed instant is `<= now` — everything that came due during
    /// the sleep.
    fn due_ids(&self, now: DateTime<Utc>) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, fire_at)| **fire_at <= now)
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// Public handle to the alarm daemon. Cloning is cheap and shares the same
/// inner state; pass clones into Tauri commands.
#[derive(Clone)]
pub struct AlarmDaemon {
    inner: Arc<Mutex<DaemonInner>>,
    notify: Arc<Notify>,
    emitter: Arc<dyn TaskDueEmitter>,
}

impl AlarmDaemon {
    pub fn new(emitter: Arc<dyn TaskDueEmitter>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(DaemonInner::new())),
            notify: Arc::new(Notify::new()),
            emitter,
        }
    }

    /// Arm (or re-arm) a task to fire at `fire_at_ms` (epoch ms). Re-arming an
    /// existing id replaces its fire time. A timestamp in the past fires on the
    /// next loop tick (immediately).
    pub fn arm(&self, task_id: String, fire_at_ms: i64) {
        let fire_at = DateTime::<Utc>::from_timestamp_millis(fire_at_ms).unwrap_or_else(Utc::now);
        self.inner.lock().entries.insert(task_id, fire_at);
        // Wake the loop so it recomputes the soonest fire including this entry.
        self.notify.notify_one();
    }

    /// Cancel a previously-armed task. No-op for unknown ids.
    pub fn disarm(&self, task_id: &str) {
        self.inner.lock().entries.remove(task_id);
        self.notify.notify_one();
    }

    #[allow(dead_code)]
    pub fn entry_count(&self) -> usize {
        self.inner.lock().entries.len()
    }

    /// The next-fire instant the loop is currently waiting on (tests + a
    /// future diagnostics readout).
    #[allow(dead_code)]
    pub fn next_fire_at(&self) -> Option<DateTime<Utc>> {
        self.inner.lock().next_fire()
    }

    /// Spawn the long-running tokio task that drives firing. Call once at boot.
    /// Uses `tauri::async_runtime::spawn` so it is safe to call from the Tauri
    /// `setup` closure (no Tokio runtime entered on that thread).
    pub fn spawn(self) {
        tauri::async_runtime::spawn(async move {
            self.run_loop().await;
        });
    }

    /// The actual loop body. Public for tests so they can drive it directly; in
    /// production we always call `spawn`.
    pub async fn run_loop(self) {
        loop {
            let now = Utc::now();
            // Drain everything that came due. Each fire is one-shot: remove the
            // entry first (so a slow emit can't double-fire), then emit.
            //
            // NOTE: bind `due_ids` to a local so the `inner` lock guard is
            // released before the loop body re-locks `inner` for the remove.
            // Inlining `self.inner.lock().due_ids(now)` into the `for` header
            // keeps the guard alive for the whole loop → self-deadlock on the
            // non-reentrant parking_lot mutex (this fires on every due task).
            let due_ids = self.inner.lock().due_ids(now);
            for task_id in due_ids {
                let removed = self.inner.lock().entries.remove(&task_id).is_some();
                if removed {
                    self.fire(&task_id, now);
                }
            }

            let next = self.inner.lock().next_fire();
            let sleep_dur = match next {
                Some(t) => {
                    let ms = (t - Utc::now()).num_milliseconds().max(0) as u64;
                    // Floor at 25ms so we don't spin when the cached time is
                    // already overdue on a heavily loaded host.
                    std::time::Duration::from_millis(ms.max(25))
                }
                // Idle — wait essentially forever; `notify` wakes us on arm.
                None => std::time::Duration::from_secs(60 * 60),
            };

            tokio::select! {
                _ = tokio::time::sleep(sleep_dur) => {}
                _ = self.notify.notified() => {}
            }
        }
    }

    fn fire(&self, task_id: &str, now: DateTime<Utc>) {
        self.emitter.emit(TaskDueEvent {
            task_id: task_id.to_string(),
            fired_at_ms: now.timestamp_millis(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn daemon_with_recorder() -> (AlarmDaemon, RecordingEmitter) {
        let recorder = RecordingEmitter::default();
        let daemon = AlarmDaemon::new(Arc::new(recorder.clone()));
        (daemon, recorder)
    }

    #[test]
    fn arm_inserts_and_rearm_replaces() {
        let (daemon, _) = daemon_with_recorder();
        let future = (Utc::now() + chrono::Duration::hours(1)).timestamp_millis();
        daemon.arm("task_1".into(), future);
        daemon.arm("task_1".into(), future + 1000);
        assert_eq!(daemon.entry_count(), 1);
    }

    #[test]
    fn disarm_drops_an_entry() {
        let (daemon, _) = daemon_with_recorder();
        let future = (Utc::now() + chrono::Duration::hours(1)).timestamp_millis();
        daemon.arm("task_1".into(), future);
        daemon.disarm("task_1");
        assert_eq!(daemon.entry_count(), 0);
        // Disarming an unknown id is a no-op.
        daemon.disarm("nope");
    }

    #[test]
    fn next_fire_at_returns_the_soonest_armed_instant() {
        let (daemon, _) = daemon_with_recorder();
        let soon = (Utc::now() + chrono::Duration::seconds(30)).timestamp_millis();
        let later = (Utc::now() + chrono::Duration::hours(2)).timestamp_millis();
        daemon.arm("late".into(), later);
        daemon.arm("soon".into(), soon);
        let next = daemon.next_fire_at().expect("expected a future fire");
        assert!((next.timestamp_millis() - soon).abs() < 1000);
    }

    #[tokio::test]
    async fn run_loop_fires_a_due_task_and_removes_it() {
        let (daemon, recorder) = daemon_with_recorder();
        // Arm in the past — should fire on the first tick.
        let past = (Utc::now() - chrono::Duration::seconds(1)).timestamp_millis();
        daemon.arm("task_1".into(), past);

        // Drive the loop briefly. `timeout` drops the run_loop future when it
        // elapses, so there is NO detached task to block runtime shutdown
        // (a `tokio::spawn`'d infinite loop hangs multi-thread runtime drop
        // even after `abort()`).
        let _ = tokio::time::timeout(Duration::from_millis(200), daemon.clone().run_loop()).await;

        let fired = recorder.fired.lock().clone();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].task_id, "task_1");
        // One-shot: the entry is gone after firing.
        assert_eq!(daemon.entry_count(), 0);
    }

    #[tokio::test]
    async fn run_loop_does_not_fire_future_entries() {
        let (daemon, recorder) = daemon_with_recorder();
        let future = (Utc::now() + chrono::Duration::hours(1)).timestamp_millis();
        daemon.arm("task_1".into(), future);

        let _ = tokio::time::timeout(Duration::from_millis(200), daemon.clone().run_loop()).await;

        assert!(recorder.fired.lock().is_empty());
        assert_eq!(daemon.entry_count(), 1);
    }
}
