//! Diagnostics-first safe mode runtime — ADR-0102 §4.
//!
//! The transitions themselves live in [`crate::recovery`]; this
//! module owns the *runtime*: where the state is persisted, when it is loaded,
//! which sentinel feeds it, and how each transition becomes an auditable V1
//! lifecycle event.
//!
//! Placement matters. The controller initializes during Tauri `setup`, right
//! after native logging and the crash sentinel and *before* any subsystem
//! initializer runs, because its whole job is to decide whether those
//! initializers should run at all. The renderer reads the decision over IPC and
//! mounts either the normal app or the diagnostics shell.

pub mod controller;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use crate::recovery::{ChildAction, RecoverySubsystem};

pub use controller::{RecoveryBoot, RecoveryController};

/// Process-wide handle to the controller.
///
/// Tauri state would be the obvious home, but the callers that need the child
/// restart budget cannot reach it: the sidecar supervisor runs on detached
/// tokio tasks whose only handle is a `SidecarHost` trait object, and the
/// headless server binary (`bin/cognia-server.rs`) has no `AppHandle` at all.
/// A supervisor that could only report failures when a webview happened to
/// exist would enforce the budget in exactly the configurations that need it
/// least.
static CONTROLLER: OnceLock<Arc<RecoveryController>> = OnceLock::new();

/// Publish the controller for supervisors. Called once during Tauri `setup`,
/// immediately before `app.manage`. Later calls are ignored — one process has
/// one recovery state, and a second controller would fork the failure budget.
pub fn publish_controller(controller: Arc<RecoveryController>) {
    if CONTROLLER.set(controller).is_err() {
        log::warn!("recovery: controller already published; ignoring the second one");
    }
}

/// The published controller, or `None` when recovery is not running (headless
/// tests, an unresolvable data dir).
pub fn controller() -> Option<&'static Arc<RecoveryController>> {
    CONTROLLER.get()
}

/// Report that a supervised child for `subsystem` died unexpectedly, and get
/// back what the supervisor should do.
///
/// `None` means recovery is not running. Callers must fall back to their own
/// backoff in that case rather than blocking the restart: this budget exists to
/// stop a restart *loop*, and refusing to restart because the diagnostics
/// subsystem is unavailable would turn a degraded diagnostic into an outage.
pub fn report_child_failure(subsystem: RecoverySubsystem) -> Option<ChildAction> {
    child_failure_with(controller().map(Arc::as_ref), subsystem)
}

/// The body of [`report_child_failure`], parameterized on the controller.
///
/// Split out because `CONTROLLER` is a process-wide `OnceLock`: a test that
/// published one would decide the answer for every test that ran after it, so
/// the two branches are exercised here instead of through the global.
fn child_failure_with(
    controller: Option<&RecoveryController>,
    subsystem: RecoverySubsystem,
) -> Option<ChildAction> {
    controller.map(|controller| controller.record_child_failure(subsystem))
}

/// Whether recovery is currently holding `subsystem` back — either because its
/// restart budget ran out or because the operator chose "keep off" in the
/// diagnostics shell. Supervisors check this before spawning; `recovery_retry`
/// clears both, so the shell's Retry button genuinely re-enables the subsystem.
pub fn is_subsystem_disabled(subsystem: RecoverySubsystem) -> bool {
    subsystem_disabled_with(controller().map(Arc::as_ref), subsystem)
}

/// The body of [`is_subsystem_disabled`] — see [`child_failure_with`] for why
/// it is parameterized.
fn subsystem_disabled_with(
    controller: Option<&RecoveryController>,
    subsystem: RecoverySubsystem,
) -> bool {
    controller.is_some_and(|controller| {
        controller
            .snapshot()
            .disabled_subsystems
            .contains(&subsystem)
    })
}

/// Root folder name under `data_local_dir` — the same `"Cognia"` the file
/// logger and crash reports use, so all diagnostic state sits in one tree that
/// is excluded from WebDAV, settings sync and ordinary backup as a unit.
const APP_DIR_NAME: &str = "Cognia";

/// Resolve (and create) the diagnostics root. `None` when the platform data dir
/// cannot be resolved — callers then run without persisted recovery state,
/// which degrades safe mode to "off" rather than crashing the boot.
pub fn diagnostics_dir() -> Option<PathBuf> {
    let dir = dirs::data_local_dir()?
        .join(APP_DIR_NAME)
        .join("diagnostics");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// The build identity shared between recovery state and `scope.buildId` on
/// every event.
///
/// CI injects `COGNIA_BUILD_ID` at compile time. Without it — a local dev build
/// — the value is derived from the crate version and profile, which is stable
/// within a working tree and different from any release build. That difference
/// is the point: a developer's rebuild must not inherit the failure budget of
/// the binary they just replaced.
pub fn build_id() -> String {
    match option_env!("COGNIA_BUILD_ID") {
        Some(injected) if !injected.is_empty() => injected.to_string(),
        _ => format!(
            "local-{}-{}",
            env!("CARGO_PKG_VERSION"),
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn controller(dir: &TempDir) -> RecoveryController {
        RecoveryController::open(dir.path(), "build-1", "0.1.0")
    }

    #[test]
    fn a_supervisor_without_recovery_gets_no_verdict() {
        // The supervisor must fall back to its own backoff rather than treat a
        // missing verdict as "do not restart".
        assert_eq!(child_failure_with(None, RecoverySubsystem::Sidecar), None);
        assert!(!subsystem_disabled_with(None, RecoverySubsystem::Sidecar));
    }

    #[test]
    fn a_supervisor_with_recovery_gets_the_restart_budget() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir);
        for expected in [1_000u64, 2_000, 4_000] {
            match child_failure_with(Some(&controller), RecoverySubsystem::Sidecar) {
                Some(ChildAction::Restart { delay_ms, .. }) => assert_eq!(delay_ms, expected),
                other => panic!("expected a restart, got {other:?}"),
            }
        }
        assert_eq!(
            child_failure_with(Some(&controller), RecoverySubsystem::Sidecar),
            Some(ChildAction::Disable {
                subsystem: RecoverySubsystem::Sidecar
            })
        );
    }

    #[test]
    fn an_exhausted_budget_holds_the_subsystem_back() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir);
        assert!(!subsystem_disabled_with(
            Some(&controller),
            RecoverySubsystem::Sidecar
        ));
        for _ in 0..4 {
            child_failure_with(Some(&controller), RecoverySubsystem::Sidecar);
        }
        assert!(subsystem_disabled_with(
            Some(&controller),
            RecoverySubsystem::Sidecar
        ));
        // Only the subsystem that failed — a sidecar crash loop must not stop
        // the workflow engine from starting.
        assert!(!subsystem_disabled_with(
            Some(&controller),
            RecoverySubsystem::Workflow
        ));
    }

    #[test]
    fn an_operator_retry_re_enables_the_subsystem() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir);
        for _ in 0..4 {
            child_failure_with(Some(&controller), RecoverySubsystem::Sidecar);
        }
        controller.retry(RecoverySubsystem::Sidecar);
        assert!(!subsystem_disabled_with(
            Some(&controller),
            RecoverySubsystem::Sidecar
        ));
        // ...and with a fresh budget, not one already spent.
        assert!(matches!(
            child_failure_with(Some(&controller), RecoverySubsystem::Sidecar),
            Some(ChildAction::Restart { attempt: 1, .. })
        ));
    }

    #[test]
    fn keeping_a_subsystem_off_holds_it_back_too() {
        let dir = TempDir::new().expect("tempdir");
        let controller = controller(&dir);
        controller.keep_disabled(RecoverySubsystem::Sidecar);
        assert!(subsystem_disabled_with(
            Some(&controller),
            RecoverySubsystem::Sidecar
        ));
    }

    #[test]
    fn publishing_twice_keeps_the_first_controller() {
        let dir = TempDir::new().expect("tempdir");
        let first = Arc::new(controller(&dir));
        publish_controller(Arc::clone(&first));
        publish_controller(Arc::new(controller(&dir)));
        // Whichever test published first wins for the whole process, so assert
        // the invariant that matters: exactly one controller is ever visible.
        let published = controller_ptr();
        publish_controller(Arc::new(controller(&dir)));
        assert_eq!(published, controller_ptr());
    }

    fn controller_ptr() -> Option<*const RecoveryController> {
        super::controller().map(Arc::as_ptr)
    }

    #[test]
    fn diagnostics_dir_sits_under_cognia() {
        if let Some(dir) = diagnostics_dir() {
            assert!(dir.ends_with("diagnostics"));
            assert!(dir
                .parent()
                .and_then(|parent| parent.file_name())
                .map(|name| name == APP_DIR_NAME)
                .unwrap_or(false));
        }
    }

    #[test]
    fn build_id_is_non_empty_and_stable() {
        let first = build_id();
        assert!(!first.is_empty());
        assert_eq!(first, build_id());
    }

    #[test]
    fn a_local_build_id_names_its_profile() {
        if option_env!("COGNIA_BUILD_ID").is_none() {
            let id = build_id();
            assert!(id.starts_with("local-"));
            assert!(id.ends_with(if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }));
        }
    }
}
