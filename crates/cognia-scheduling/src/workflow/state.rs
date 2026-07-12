//! Tauri-managed state container for the workflow subsystem.
//!
//! Bundles the cron daemon handle and the run-state mirror so a single
//! `app.manage(WorkflowState::new(...))` call wires everything. Construction
//! lives at `lib.rs` boot time alongside the other subsystems.

use std::path::PathBuf;
use std::sync::Arc;

use crate::workflow::run_mirror::{self, RunMirror};
use crate::workflow::triggers::cron_daemon::{CronDaemon, TriggerEmitter};
use crate::workflow::triggers::webhook_router::WebhookRouter;

pub struct WorkflowState {
    pub mirror: RunMirror,
    pub cron: CronDaemon,
    pub webhook: WebhookRouter,
}

impl WorkflowState {
    /// Open the mirror DB and wire the cron daemon + webhook router. Does NOT
    /// spawn the daemons' loops — callers run `cron.clone().spawn()` and
    /// `webhook.start(emitter, port)` once after this so they run once per
    /// process.
    pub fn open(
        mirror_path: PathBuf,
        emitter: Arc<dyn TriggerEmitter>,
    ) -> Result<Self, run_mirror::MirrorError> {
        let mirror = RunMirror::open(mirror_path)?;
        let cron = CronDaemon::new(emitter);
        let webhook = WebhookRouter::new();
        Ok(Self {
            mirror,
            cron,
            webhook,
        })
    }

    /// Test-only: open both the mirror and the cron daemon backed by an
    /// in-memory SQLite + a recording emitter. Returns the recorder so tests
    /// can assert on fired events.
    #[cfg(test)]
    pub fn open_in_memory_for_testing() -> (
        Self,
        crate::workflow::triggers::cron_daemon::RecordingEmitter,
    ) {
        let recorder = crate::workflow::triggers::cron_daemon::RecordingEmitter::default();
        let mirror = RunMirror::open_in_memory().expect("in-memory mirror");
        let cron = CronDaemon::new(Arc::new(recorder.clone()));
        let webhook = WebhookRouter::new();
        (
            Self {
                mirror,
                cron,
                webhook,
            },
            recorder,
        )
    }
}

impl Drop for WorkflowState {
    /// Best-effort graceful shutdown of the webhook listener so the bound
    /// port is released before the process exits or the state gets re-built
    /// (the latter happens in test runs that swap states between cases).
    /// `stop` is idempotent: calling it on a router that never started is
    /// a no-op.
    fn drop(&mut self) {
        self.webhook.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::types::PersistRunStateInput;
    use serde_json::json;

    #[test]
    fn open_in_memory_for_testing_yields_a_usable_mirror_and_cron() {
        let (state, _) = WorkflowState::open_in_memory_for_testing();
        assert_eq!(state.mirror.count().unwrap(), 0);
        assert_eq!(state.cron.entry_count(), 0);
    }

    #[test]
    fn full_round_trip_via_state_works() {
        let (state, _) = WorkflowState::open_in_memory_for_testing();
        state
            .cron
            .upsert("trg_1".into(), "wf_1".into(), "0 0 9 * * 1-5", true, None)
            .unwrap();
        assert_eq!(state.cron.entry_count(), 1);

        state
            .mirror
            .persist(&PersistRunStateInput {
                run_id: "run_a".into(),
                workflow_id: "wf_1".into(),
                status: "running".into(),
                last_step_id: None,
                snapshot: Some(json!({"id": "wf_1", "schemaVersion": 1, "name": "x"})),
            })
            .unwrap();
        assert_eq!(state.mirror.count().unwrap(), 1);
        assert_eq!(state.mirror.list_in_flight().unwrap().len(), 1);
    }
}
