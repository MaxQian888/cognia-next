//! Visual workflow subsystem — the Rust side.
//!
//! Owns:
//!
//! - The cron daemon that fires `trigger.cron` workflows even when the
//!   webview is minimized to tray (`triggers::cron_daemon`).
//! - The SQLite run-state mirror used for crash recovery (`run_mirror`).
//! - The Tauri commands that implement the IPC contract documented in
//!   `lib/workflow/runtime/tauri-bridge.ts` (`commands`).
//!
//! The TypeScript orchestrator owns step execution; this module owns "when
//! does a workflow start" and "did this run survive a crash". See ADR 0011
//! at `docs/content/docs/adr/0011-workflows-subsystem.md`.

pub mod commands;
pub mod run_mirror;
pub mod state;
pub mod triggers;
pub mod types;

// Public re-exports for ergonomic call sites in `lib.rs`. Some of these are
// only used by `lib.rs` and tests; mark as allow(unused_imports) so a build
// without one of those call sites doesn't warn.
#[allow(unused_imports)]
pub use run_mirror::{default_mirror_path, MirrorError, RunMirror};
#[allow(unused_imports)]
pub use state::WorkflowState;
#[allow(unused_imports)]
pub use triggers::cron_daemon::{CronDaemon, TriggerEmitter};

/// AppHandle-bound TriggerEmitter — wraps `tauri::Emitter::emit` so the cron
/// daemon can fire `workflow:trigger` events without holding a `&AppHandle`
/// reference (which doesn't satisfy the daemon's 'static bound).
pub struct AppHandleEmitter {
    pub handle: tauri::AppHandle,
}

impl TriggerEmitter for AppHandleEmitter {
    fn emit(&self, event: types::TriggerEvent) {
        if let Err(err) = tauri::Emitter::emit(&self.handle, "workflow:trigger", event) {
            log::warn!("workflow:trigger emit failed: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::types::TriggerEvent;
    use super::TriggerEmitter;
    use std::sync::{Arc, Mutex};

    /// Smoke test that the AppHandleEmitter contract type-checks. We can't
    /// instantiate a real `tauri::AppHandle` outside an actual Tauri app, but
    /// we can confirm the trait shape via a custom emitter implementation.
    #[test]
    fn trigger_emitter_trait_can_be_implemented_by_test_doubles() {
        struct CountingEmitter {
            count: Arc<Mutex<usize>>,
        }
        impl TriggerEmitter for CountingEmitter {
            fn emit(&self, _event: TriggerEvent) {
                *self.count.lock().unwrap() += 1;
            }
        }
        let count = Arc::new(Mutex::new(0));
        let emitter = CountingEmitter { count: count.clone() };
        emitter.emit(TriggerEvent {
            workflow_id: "wf".into(),
            kind: "trigger.cron".into(),
            payload: serde_json::Value::Null,
            origin_at: 0,
            binding: None,
        });
        assert_eq!(*count.lock().unwrap(), 1);
    }
}
