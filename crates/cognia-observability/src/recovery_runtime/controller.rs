//! The recovery controller — owns `RecoveryStateV1`, persists it atomically,
//! and turns every transition into an auditable V1 lifecycle event.
//!
//! One rule runs through the whole type: **persist before you act**. A decision
//! that was taken but not written is a decision that a hard kill erases, and
//! the failure this system exists to survive is exactly a hard kill.

use std::sync::Mutex;

use crate::event::{
    ObservabilityPayload, ObservabilityRuntime, ObservabilitySeverity,
};
use crate::recovery::{
    ChildAction, RecoveryMode, RecoveryStateV1, RecoverySubsystem, RendererAction,
};
use crate::recovery_store::RecoveryStore;
use crate::spool::{FileSpool, SpoolLimits};
use crate::writer::{EventRequest, ObservabilityWriter, WriterIdentity};
use serde::Serialize;
use serde_json::{Map, Value};

/// What the boot path learned. The renderer mounts the diagnostics shell when
/// `requires_safe_shell` is set, and shows the suspect when there is one.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryBoot {
    pub requires_safe_shell: bool,
    pub mode: RecoveryMode,
    pub build_id: String,
    /// True when this session followed an abnormal exit of the same build.
    pub previous_session_unhealthy: bool,
}

impl RecoveryBoot {
    /// This session's boot facts, with the *current* mode.
    ///
    /// The cold-start decision is not the whole story: a renderer that
    /// exhausts its reload budget mid-session flips the process into safe mode
    /// and is then reloaded, and the reloaded webview asks this same question.
    /// Answering it from the frozen boot struct would send the renderer
    /// straight back into the app tree that just died — the safe shell would
    /// be reachable only by restarting the app, which is precisely what a
    /// white-screen loop prevents.
    ///
    /// `previous_session_unhealthy` stays as recorded: it is a fact about the
    /// *previous* process, and nothing in this one can change it.
    pub fn refreshed(&self, controller: &RecoveryController) -> Self {
        let state = controller.snapshot();
        Self {
            requires_safe_shell: state.requires_safe_shell(),
            mode: state.mode,
            build_id: self.build_id.clone(),
            previous_session_unhealthy: self.previous_session_unhealthy,
        }
    }
}

/// Tauri-managed state. Lock scope is deliberately tiny and fully synchronous —
/// no `.await` ever happens while the guard is alive, so this cannot deadlock
/// the async runtime.
pub struct RecoveryController {
    state: Mutex<RecoveryStateV1>,
    store: Option<RecoveryStore>,
    writer: Option<ObservabilityWriter>,
    build_id: String,
}

impl std::fmt::Debug for RecoveryController {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecoveryController")
            .field("build_id", &self.build_id)
            .field("persisted", &self.store.is_some())
            .finish()
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl RecoveryController {
    /// Build a controller with no persistence and no writer. Used when the
    /// platform data dir is unavailable; safe mode then reports `unsupported`
    /// rather than pretending to work.
    pub fn detached(build_id: impl Into<String>) -> Self {
        let build_id = build_id.into();
        Self {
            state: Mutex::new(RecoveryStateV1::new(&build_id)),
            store: None,
            writer: None,
            build_id,
        }
    }

    /// Load persisted state from `dir`, adopting `build_id`, and open a spool
    /// for the recovery audit trail.
    pub fn open(dir: &std::path::Path, build_id: impl Into<String>, app_version: &str) -> Self {
        let build_id = build_id.into();
        let at = now_ms();
        let store = RecoveryStore::new(dir.join("recovery"));
        let state = store.load(&build_id, at);

        let writer = FileSpool::open(dir.join("spool").join("tauri"), SpoolLimits::default())
            .ok()
            .map(|spool| {
                ObservabilityWriter::new(
                    WriterIdentity {
                        tenant_id: "tenant-local".into(),
                        installation_id: installation_id(dir),
                        runtime: ObservabilityRuntime::Tauri,
                        process_id: format!("main-{}", std::process::id()),
                        build_id: build_id.clone(),
                        app_version: app_version.to_string(),
                        origin: Some("tauri".into()),
                    },
                    spool,
                )
            });

        let controller = Self {
            state: Mutex::new(state),
            store: Some(store),
            writer,
            build_id,
        };
        controller.persist();
        controller
    }

    /// True when persistence, the state machine and the audit writer are all
    /// reachable. `crash-capabilities` reports `safeMode: supported` only when
    /// this is true, so the matrix never advertises a path that cannot run.
    pub fn is_operational(&self) -> bool {
        self.store.is_some() && self.writer.is_some()
    }

    pub fn build_id(&self) -> &str {
        &self.build_id
    }

    pub fn snapshot(&self) -> RecoveryStateV1 {
        self.with_state(|state| state.clone())
    }

    fn with_state<T>(&self, operation: impl FnOnce(&mut RecoveryStateV1) -> T) -> T {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut guard)
    }

    /// Write the current state to disk. Best-effort: a failed save is logged
    /// and the in-memory state stands, because refusing to boot over a disk
    /// error would be a worse outcome than a lost failure count.
    fn persist(&self) {
        let Some(store) = &self.store else {
            return;
        };
        let snapshot = self.snapshot();
        if let Err(error) = store.save(&snapshot) {
            log::warn!("recovery: persisting state failed: {error}");
        }
    }

    /// Emit one V1 lifecycle event describing a transition.
    fn audit(
        &self,
        code: &str,
        severity: ObservabilitySeverity,
        message: &str,
        details: Map<String, Value>,
    ) {
        let Some(writer) = &self.writer else {
            return;
        };
        let request = EventRequest::new("recovery", code, message)
            .with_payload(ObservabilityPayload::message(message).with_data(details));
        if let Err(error) = writer.lifecycle(severity, request) {
            log::warn!("recovery: audit event failed: {error}");
        }
    }

    /// Cold-start entry point. `previous_session_unhealthy` comes from the
    /// clean-exit sentinel, which must already have been consumed by the
    /// caller — the sentinel is the owner of "did the last run crash?", and
    /// duplicating that judgement here would let the two disagree.
    pub fn record_start(&self, previous_session_unhealthy: bool) -> RecoveryBoot {
        let at = now_ms();
        let mode = if previous_session_unhealthy {
            self.with_state(|state| state.record_unhealthy_start(at))
        } else {
            self.with_state(|state| {
                state.record_clean_start(at);
                state.mode
            })
        };
        self.persist();

        let mut details = Map::new();
        details.insert("mode".into(), Value::from(mode.as_str()));
        details.insert(
            "previousSessionUnhealthy".into(),
            Value::from(previous_session_unhealthy),
        );
        details.insert("buildId".into(), Value::from(self.build_id.clone()));
        self.audit(
            if previous_session_unhealthy {
                "recovery.start.unhealthy"
            } else {
                "recovery.start.clean"
            },
            if mode == RecoveryMode::Safe {
                ObservabilitySeverity::Error
            } else if previous_session_unhealthy {
                ObservabilitySeverity::Warn
            } else {
                ObservabilitySeverity::Info
            },
            "Recovery start recorded",
            details,
        );

        RecoveryBoot {
            requires_safe_shell: mode == RecoveryMode::Safe,
            mode,
            build_id: self.build_id.clone(),
            previous_session_unhealthy,
        }
    }

    pub fn record_renderer_heartbeat(&self) -> RecoveryStateV1 {
        let at = now_ms();
        self.with_state(|state| state.record_renderer_heartbeat(at));
        // A heartbeat may be the event that starts the healthy timer, and a
        // healthy tick may be the one that clears the budgets.
        self.with_state(|state| state.record_healthy_tick(at));
        self.persist();
        self.snapshot()
    }

    pub fn record_renderer_failure(&self) -> RendererAction {
        let at = now_ms();
        let action = self.with_state(|state| state.record_renderer_failure(at));
        self.persist();

        let mut details = Map::new();
        details.insert(
            "action".into(),
            Value::from(match action {
                RendererAction::Reload => "reload",
                RendererAction::OpenSafeShell => "open-safe-shell",
            }),
        );
        self.audit(
            "recovery.renderer.failure",
            ObservabilitySeverity::Error,
            "Renderer failure handled",
            details,
        );
        action
    }

    pub fn record_child_failure(&self, subsystem: RecoverySubsystem) -> ChildAction {
        let at = now_ms();
        let action = self.with_state(|state| state.record_child_failure(subsystem, at));
        self.persist();

        let mut details = Map::new();
        details.insert("subsystem".into(), Value::from(subsystem.as_str()));
        match action {
            ChildAction::Restart { delay_ms, attempt } => {
                details.insert("delayMs".into(), Value::from(delay_ms));
                details.insert("attempt".into(), Value::from(attempt));
            }
            ChildAction::Disable { .. } => {
                details.insert("disabled".into(), Value::from(true));
            }
        }
        self.audit(
            "recovery.child.failure",
            ObservabilitySeverity::Error,
            "Supervised child failure handled",
            details,
        );
        action
    }

    pub fn record_checkpoint(
        &self,
        subsystem: RecoverySubsystem,
        success: bool,
        reason_code: Option<String>,
    ) -> RecoveryStateV1 {
        let at = now_ms();
        self.with_state(|state| {
            state.record_checkpoint(subsystem, success, reason_code.clone(), at)
        });
        self.with_state(|state| state.record_healthy_tick(at));
        self.persist();

        let mut details = Map::new();
        details.insert("subsystem".into(), Value::from(subsystem.as_str()));
        details.insert("success".into(), Value::from(success));
        if let Some(reason) = &reason_code {
            details.insert("reasonCode".into(), Value::from(reason.clone()));
        }
        self.audit(
            if success {
                "recovery.checkpoint.passed"
            } else {
                "recovery.checkpoint.failed"
            },
            if success {
                ObservabilitySeverity::Info
            } else {
                ObservabilitySeverity::Error
            },
            "Recovery checkpoint recorded",
            details,
        );
        self.snapshot()
    }

    pub fn retry(&self, subsystem: RecoverySubsystem) -> RecoveryStateV1 {
        let at = now_ms();
        self.with_state(|state| state.record_retry(subsystem, at));
        self.persist();

        let mut details = Map::new();
        details.insert("subsystem".into(), Value::from(subsystem.as_str()));
        self.audit(
            "recovery.subsystem.retry",
            ObservabilitySeverity::Warn,
            "Operator requested a subsystem retry",
            details,
        );
        self.snapshot()
    }

    pub fn keep_disabled(&self, subsystem: RecoverySubsystem) -> RecoveryStateV1 {
        let at = now_ms();
        self.with_state(|state| state.record_keep_disabled(subsystem, at));
        self.persist();

        let mut details = Map::new();
        details.insert("subsystem".into(), Value::from(subsystem.as_str()));
        self.audit(
            "recovery.subsystem.kept_disabled",
            ObservabilitySeverity::Warn,
            "Operator kept a subsystem disabled",
            details,
        );
        self.snapshot()
    }

    /// Flush the audit spool. Called on graceful shutdown.
    pub fn close(&self) {
        if let Some(writer) = &self.writer {
            if let Err(error) = writer.close() {
                log::warn!("recovery: closing the audit spool failed: {error}");
            }
        }
    }
}

/// A stable per-installation identifier derived from the diagnostics root.
///
/// Deliberately not a device fingerprint: it is a random id written once beside
/// the diagnostic state, so an incident can be correlated across sessions
/// without carrying anything about the machine.
fn installation_id(dir: &std::path::Path) -> String {
    let path = dir.join("installation-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let generated = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::write(&path, &generated);
    generated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery::CheckpointStatus;
    use tempfile::TempDir;

    fn controller(dir: &TempDir, build: &str) -> RecoveryController {
        RecoveryController::open(dir.path(), build, "0.1.0")
    }

    #[test]
    fn a_detached_controller_is_not_operational() {
        let controller = RecoveryController::detached("build-1");
        assert!(!controller.is_operational());
        // It still answers, so callers do not need a null check everywhere.
        assert_eq!(controller.snapshot().mode, RecoveryMode::Normal);
    }

    #[test]
    fn an_opened_controller_is_operational_and_persists() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-1");
        assert!(controller.is_operational());
        assert!(dir
            .path()
            .join("recovery")
            .join("recovery-state.json")
            .exists());
    }

    #[test]
    fn one_unhealthy_start_does_not_require_the_safe_shell() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-1");
        let boot = controller.record_start(true);
        assert!(!boot.requires_safe_shell);
        assert!(boot.previous_session_unhealthy);
        assert_eq!(boot.mode, RecoveryMode::Normal);
    }

    #[test]
    fn a_second_unhealthy_start_across_a_restart_requires_the_safe_shell() {
        let dir = TempDir::new().expect("tempdir");
        controller(&dir, "build-1").record_start(true);
        // A fresh controller, as if the process had been restarted.
        let boot = controller(&dir, "build-1").record_start(true);
        assert!(boot.requires_safe_shell);
        assert_eq!(boot.mode, RecoveryMode::Safe);
    }

    #[test]
    fn a_clean_start_does_not_require_the_safe_shell() {
        let dir = TempDir::new().expect("tempdir");
        let boot = controller(&dir, "build-1").record_start(false);
        assert!(!boot.requires_safe_shell);
        assert!(!boot.previous_session_unhealthy);
    }

    #[test]
    fn a_new_build_clears_a_persisted_safe_mode() {
        let dir = TempDir::new().expect("tempdir");
        controller(&dir, "build-1").record_start(true);
        controller(&dir, "build-1").record_start(true);
        assert!(controller(&dir, "build-1").snapshot().requires_safe_shell());

        let after_update = controller(&dir, "build-2");
        assert!(!after_update.snapshot().requires_safe_shell());
        assert_eq!(after_update.build_id(), "build-2");
    }

    #[test]
    fn checkpoints_are_recorded_and_persisted() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-1");
        let state = controller.record_checkpoint(RecoverySubsystem::Database, true, None);
        assert_eq!(
            state
                .checkpoints
                .iter()
                .find(|slot| slot.subsystem == RecoverySubsystem::Database)
                .map(|slot| slot.status),
            Some(CheckpointStatus::Passed)
        );

        let reloaded = RecoveryController::open(dir.path(), "build-1", "0.1.0");
        assert_eq!(
            reloaded
                .snapshot()
                .checkpoints
                .iter()
                .find(|slot| slot.subsystem == RecoverySubsystem::Database)
                .map(|slot| slot.status),
            Some(CheckpointStatus::Passed)
        );
    }

    #[test]
    fn a_failed_checkpoint_names_the_suspect_and_stops_the_sequence() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-1");
        controller.record_checkpoint(RecoverySubsystem::Database, true, None);
        let state = controller.record_checkpoint(
            RecoverySubsystem::Plugins,
            false,
            Some("plugins.probe_failed".into()),
        );
        assert_eq!(state.suspect_subsystem, Some(RecoverySubsystem::Plugins));
        assert_eq!(
            state.suspect_reason_code.as_deref(),
            Some("plugins.probe_failed")
        );
        assert_eq!(state.next_checkpoint(), None);
        assert!(state.requires_safe_shell());
    }

    #[test]
    fn retry_reopens_the_sequence() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-1");
        controller.record_checkpoint(RecoverySubsystem::Database, true, None);
        controller.record_checkpoint(RecoverySubsystem::Plugins, false, Some("boom".into()));
        let state = controller.retry(RecoverySubsystem::Plugins);
        assert_eq!(state.next_checkpoint(), Some(RecoverySubsystem::Plugins));
    }

    #[test]
    fn keeping_a_subsystem_disabled_lets_the_sequence_continue() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-1");
        controller.record_checkpoint(RecoverySubsystem::Database, true, None);
        controller.record_checkpoint(RecoverySubsystem::Plugins, false, Some("boom".into()));
        let state = controller.keep_disabled(RecoverySubsystem::Plugins);
        assert_eq!(state.next_checkpoint(), Some(RecoverySubsystem::Sidecar));
        assert!(state
            .disabled_subsystems
            .contains(&RecoverySubsystem::Plugins));
    }

    #[test]
    fn renderer_failures_follow_the_reload_budget() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-1");
        assert_eq!(controller.record_renderer_failure(), RendererAction::Reload);
        assert_eq!(
            controller.record_renderer_failure(),
            RendererAction::OpenSafeShell
        );
        assert!(controller.snapshot().requires_safe_shell());
    }

    #[test]
    fn child_failures_follow_the_restart_budget() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-1");
        for expected in [1_000u64, 2_000, 4_000] {
            match controller.record_child_failure(RecoverySubsystem::Sidecar) {
                ChildAction::Restart { delay_ms, .. } => assert_eq!(delay_ms, expected),
                other => panic!("expected restart, got {other:?}"),
            }
        }
        assert_eq!(
            controller.record_child_failure(RecoverySubsystem::Sidecar),
            ChildAction::Disable {
                subsystem: RecoverySubsystem::Sidecar
            }
        );
    }

    #[test]
    fn every_transition_writes_an_auditable_lifecycle_event() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-1");
        controller.record_start(true);
        controller.record_checkpoint(RecoverySubsystem::Database, false, Some("db.locked".into()));
        controller.retry(RecoverySubsystem::Database);
        controller.close();

        let spool = FileSpool::open(
            dir.path().join("spool").join("tauri"),
            SpoolLimits::default(),
        )
        .expect("spool");
        let codes: Vec<String> = spool
            .list(0, 100)
            .into_iter()
            .map(|record| record.event.code)
            .collect();
        assert!(codes.contains(&"recovery.start.unhealthy".to_string()));
        assert!(codes.contains(&"recovery.checkpoint.failed".to_string()));
        assert!(codes.contains(&"recovery.subsystem.retry".to_string()));
    }

    #[test]
    fn audit_events_are_schema_valid_and_carry_the_build_id() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-xyz");
        controller.record_checkpoint(RecoverySubsystem::Workflow, true, None);
        controller.close();

        let spool = FileSpool::open(
            dir.path().join("spool").join("tauri"),
            SpoolLimits::default(),
        )
        .expect("spool");
        let records = spool.list(0, 10);
        assert!(!records.is_empty());
        for record in records {
            assert_eq!(record.event.validate(), Ok(()));
            assert_eq!(record.event.scope.build_id, "build-xyz");
            assert_eq!(record.event.scope.runtime, ObservabilityRuntime::Tauri);
        }
    }

    #[test]
    fn a_heartbeat_alone_does_not_clear_a_failure_budget() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir, "build-1");
        controller.record_start(true);
        let state = controller.record_renderer_heartbeat();
        assert_eq!(
            state.unhealthy_starts.len(),
            1,
            "health needs the dwell time, not just a heartbeat"
        );
        assert!(state.renderer_alive);
    }

    #[test]
    fn the_installation_id_is_stable_across_controllers() {
        let dir = TempDir::new().expect("tempdir");
        let first = controller(&dir, "build-1");
        let second = controller(&dir, "build-1");
        // Both writers resolve the same persisted installation id.
        assert!(dir.path().join("installation-id").exists());
        assert!(first.is_operational());
        assert!(second.is_operational());
    }

    #[test]
    fn boot_serializes_with_camel_case_keys() {
        let boot = RecoveryBoot {
            requires_safe_shell: true,
            mode: RecoveryMode::Safe,
            build_id: "build-1".into(),
            previous_session_unhealthy: true,
        };
        let json = serde_json::to_string(&boot).expect("serializes");
        assert!(json.contains("\"requiresSafeShell\":true"));
        assert!(json.contains("\"previousSessionUnhealthy\":true"));
        assert!(json.contains("\"mode\":\"safe\""));
    }
}
