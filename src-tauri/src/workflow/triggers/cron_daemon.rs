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
//!   all registered cron triggers. The generic "sleep until soonest, wake
//!   early on mutation" loop mechanics (shared with
//!   `crate::scheduler::daemon`) live in `crate::timing::alarm_daemon`; this
//!   module keeps the cron-expression parsing and owns the multi-shot
//!   re-arm decision (unlike the plain alarm daemon, a fired cron entry
//!   recomputes its next occurrence and re-arms itself).
//! - Wakes up after each fire OR when the registry is mutated (add / remove /
//!   update). A `Notify` handle (inside the shared core) steers the sleep loop.
//! - On fire, emits a `TriggerEvent` via the supplied emitter (a closure the
//!   caller binds to `AppHandle::emit`). The TS bridge resolves the workflow
//!   id and invokes the orchestrator.

use std::str::FromStr;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use cron::Schedule;

use crate::timing::{Alarm, AlarmDaemonCore, DueEmitter};
use crate::workflow::types::{TriggerBinding, TriggerEvent};

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

impl Alarm for CronEntry {
    fn fire_at(&self) -> Option<DateTime<Utc>> {
        if self.enabled {
            self.next_fire_at
        } else {
            None
        }
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
    pub fired: Arc<parking_lot::Mutex<Vec<TriggerEvent>>>,
}

#[cfg(test)]
impl TriggerEmitter for RecordingEmitter {
    fn emit(&self, event: TriggerEvent) {
        self.fired.lock().push(event);
    }
}

/// Binds the generic `DueEmitter<CronEntry>` core to `TriggerEmitter`.
/// Always recomputes and returns `Some` to re-arm — a cron trigger is
/// multi-shot; it's only ever dropped by an explicit `remove()`.
struct CronDueAdapter {
    inner: Arc<dyn TriggerEmitter>,
}

impl DueEmitter<CronEntry> for CronDueAdapter {
    fn emit(&self, _id: &str, mut entry: CronEntry, fired_at: DateTime<Utc>) -> Option<CronEntry> {
        let event = TriggerEvent {
            workflow_id: entry.workflow_id.clone(),
            kind: "trigger.cron".into(),
            payload: serde_json::json!({
                "triggerId": entry.trigger_id,
                "firedAt": fired_at.timestamp_millis(),
            }),
            origin_at: fired_at.timestamp_millis(),
            binding: entry.binding.clone(),
        };
        self.inner.emit(event);
        entry.recompute(fired_at);
        Some(entry)
    }
}

/// Public handle to the daemon. Cloning is cheap and shares the same inner
/// state; pass clones into Tauri commands.
#[derive(Clone)]
pub struct CronDaemon {
    core: AlarmDaemonCore<CronEntry, CronDueAdapter>,
}

impl CronDaemon {
    pub fn new(emitter: Arc<dyn TriggerEmitter>) -> Self {
        Self {
            core: AlarmDaemonCore::new(Arc::new(CronDueAdapter { inner: emitter })),
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
        self.core.upsert(trigger_id, entry);
        Ok(())
    }

    pub fn remove(&self, trigger_id: &str) {
        self.core.remove(trigger_id);
    }

    #[allow(dead_code)]
    pub fn entry_count(&self) -> usize {
        self.core.entry_count()
    }

    /// Convenience for tests + the diagnostics tab — returns the next-fire
    /// timestamp the loop is currently waiting on.
    #[allow(dead_code)]
    pub fn next_fire_at(&self) -> Option<DateTime<Utc>> {
        self.core.next_fire_at()
    }

    /// Spawn the long-running tokio task that drives firing. Should be called
    /// once during app boot.
    ///
    /// Uses `tauri::async_runtime::spawn` so it is safe to call from the
    /// Tauri `setup` closure (which runs on the main thread without a Tokio
    /// runtime entered). `tokio::spawn` would panic with
    /// "there is no reactor running" in that context.
    pub fn spawn(self) {
        tauri::async_runtime::spawn(async move {
            self.run_loop().await;
        });
    }

    /// The actual loop body. Public for tests so they can call it via
    /// `tokio::time::pause()` and step the clock manually if needed; in
    /// production we always call `spawn`.
    pub async fn run_loop(self) {
        self.core.run_loop().await;
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
            .upsert("trg_1".into(), "wf_1".into(), "* * * * * *", true, None)
            .unwrap();
        // `timeout` drops the run_loop future when it elapses, so there is NO
        // detached task left running to block multi-thread runtime shutdown
        // (a `tokio::spawn`'d infinite loop hangs runtime drop even after
        // `abort()`) — matches the alarm-daemon tests' pattern.
        let _ = tokio::time::timeout(Duration::from_millis(1200), daemon.clone().run_loop()).await;
        let count = recorder.fired.lock().len();
        assert!(count >= 1, "expected at least one fire, got {count}");
        let event = recorder.fired.lock()[0].clone();
        assert_eq!(event.workflow_id, "wf_1");
        assert_eq!(event.kind, "trigger.cron");
    }
}
