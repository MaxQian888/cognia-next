//! Typed IPC for the recovery controller.
//!
//! These commands are the *only* way the renderer touches recovery state. The
//! renderer no longer computes transitions — the previous TypeScript policy
//! module did, and nothing called it, so the state machine and the UI could
//! never disagree because neither ran. Now the machine runs in the process
//! that survives a renderer crash and the UI reads its decisions.
//!
//! Every command is registered in `generate_handler!`; unregistered commands
//! are unreachable from the webview, which is this app's command ACL boundary.

use std::sync::Arc;

use cognia_observability::recovery::{RecoveryStateV1, RecoverySubsystem, RECOVERY_ORDER};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::controller::RecoveryController;

/// The controller is managed as an `Arc` so the same instance is reachable
/// both here and from `recovery::controller()`, which supervisors without an
/// `AppHandle` use.
type Controller<'a> = State<'a, Arc<RecoveryController>>;

/// Parse a wire subsystem name. Unknown names are rejected rather than mapped
/// to a default: silently recovering the wrong subsystem is worse than an error.
fn parse_subsystem(value: &str) -> Result<RecoverySubsystem, String> {
    RECOVERY_ORDER
        .iter()
        .copied()
        .find(|subsystem| subsystem.as_str() == value)
        .ok_or_else(|| format!("unknown_recovery_subsystem:{value}"))
}

/// What `recovery_retry` should do with the named subsystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryRetryAction {
    /// Re-run this subsystem's probe and everything after it.
    #[default]
    Retry,
    /// Accept running without it and continue with the later groups.
    KeepDisabled,
}

/// Read this session's boot decision. The renderer's recovery boot gate calls
/// this before mounting plugin and background initializers, and mounts the
/// diagnostics shell instead when `requiresSafeShell` is set.
///
/// Answered from the *live* mode — see [`RecoveryBoot::refreshed`].
///
/// [`RecoveryBoot::refreshed`]: super::controller::RecoveryBoot::refreshed
#[tauri::command]
pub async fn recovery_boot_get(
    boot: State<'_, super::controller::RecoveryBoot>,
    controller: Controller<'_>,
) -> Result<super::controller::RecoveryBoot, String> {
    Ok(boot.inner().refreshed(controller.inner()))
}

/// Read the current recovery state, including checkpoint progress, the
/// suspected subsystem and the bounded audit history.
#[tauri::command]
pub async fn recovery_state_get(controller: Controller<'_>) -> Result<RecoveryStateV1, String> {
    Ok(controller.snapshot())
}

/// Record the outcome of one subsystem's read-only health probe.
#[tauri::command]
pub async fn recovery_checkpoint_record(
    controller: Controller<'_>,
    subsystem: String,
    success: bool,
    reason_code: Option<String>,
) -> Result<RecoveryStateV1, String> {
    let subsystem = parse_subsystem(&subsystem)?;
    Ok(controller.record_checkpoint(subsystem, success, reason_code))
}

/// Retry a subsystem, or accept keeping it disabled. Both outcomes are audited
/// as V1 lifecycle events.
#[tauri::command]
pub async fn recovery_retry(
    controller: Controller<'_>,
    subsystem: String,
    action: Option<RecoveryRetryAction>,
) -> Result<RecoveryStateV1, String> {
    let subsystem = parse_subsystem(&subsystem)?;
    Ok(match action.unwrap_or_default() {
        RecoveryRetryAction::Retry => controller.retry(subsystem),
        RecoveryRetryAction::KeepDisabled => controller.keep_disabled(subsystem),
    })
}

/// The renderer reporting alive. Required before the healthy timer can start —
/// a process whose UI never came up is not healthy just because no subsystem
/// complained.
#[tauri::command]
pub async fn recovery_heartbeat(controller: Controller<'_>) -> Result<RecoveryStateV1, String> {
    Ok(controller.record_renderer_heartbeat())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_observability::recovery::RecoveryMode;
    use tempfile::TempDir;

    #[test]
    fn every_documented_subsystem_parses() {
        for subsystem in RECOVERY_ORDER {
            assert_eq!(parse_subsystem(subsystem.as_str()), Ok(subsystem));
        }
    }

    #[test]
    fn an_unknown_subsystem_is_rejected_with_its_name() {
        let error = parse_subsystem("renderer").expect_err("must reject");
        assert_eq!(error, "unknown_recovery_subsystem:renderer");
    }

    #[test]
    fn subsystem_parsing_is_case_sensitive_and_exact() {
        assert!(parse_subsystem("Database").is_err());
        assert!(parse_subsystem("external_agent").is_err());
        assert!(parse_subsystem("").is_err());
        assert_eq!(
            parse_subsystem("external-agent"),
            Ok(RecoverySubsystem::ExternalAgent)
        );
    }

    #[test]
    fn the_retry_action_defaults_to_retry() {
        assert_eq!(RecoveryRetryAction::default(), RecoveryRetryAction::Retry);
        let parsed: RecoveryRetryAction =
            serde_json::from_str("\"keep-disabled\"").expect("parses");
        assert_eq!(parsed, RecoveryRetryAction::KeepDisabled);
    }

    // The command bodies are thin wrappers over the controller, which is
    // covered directly; these exercise the same paths without a Tauri app.
    #[test]
    fn checkpoint_and_retry_move_the_controller_state() {
        let dir = TempDir::new().expect("tempdir");
        let controller = RecoveryController::open(dir.path(), "build-1", "0.1.0");

        let subsystem = parse_subsystem("plugins").expect("parses");
        let state = controller.record_checkpoint(subsystem, false, Some("boom".into()));
        assert_eq!(state.mode, RecoveryMode::Safe);

        let state = controller.retry(subsystem);
        assert_eq!(state.suspect_subsystem, None);

        let state = controller.keep_disabled(subsystem);
        assert!(state
            .disabled_subsystems
            .contains(&RecoverySubsystem::Plugins));
    }

    #[test]
    fn a_heartbeat_marks_the_renderer_alive() {
        let dir = TempDir::new().expect("tempdir");
        let controller = RecoveryController::open(dir.path(), "build-1", "0.1.0");
        assert!(!controller.snapshot().renderer_alive);
        assert!(controller.record_renderer_heartbeat().renderer_alive);
    }

    #[test]
    fn the_boot_answer_follows_a_mid_session_transition_into_safe_mode() {
        let dir = TempDir::new().expect("tempdir");
        let controller = RecoveryController::open(dir.path(), "build-1", "0.1.0");
        let boot = controller.record_start(false);
        assert!(!boot.requires_safe_shell);

        // The renderer white-screens twice inside the reload window; the
        // second failure opens the one-shot safe shell. The reloaded webview
        // asks for the boot decision again and must be told the truth.
        controller.record_renderer_failure();
        controller.record_renderer_failure();

        let refreshed = boot.refreshed(&controller);
        assert!(refreshed.requires_safe_shell);
        assert_eq!(refreshed.mode, RecoveryMode::Safe);
        // Boot-time facts are not rewritten by a later failure.
        assert!(!refreshed.previous_session_unhealthy);
        assert_eq!(refreshed.build_id, "build-1");
    }

    #[test]
    fn a_healthy_session_keeps_answering_normal() {
        let dir = TempDir::new().expect("tempdir");
        let controller = RecoveryController::open(dir.path(), "build-1", "0.1.0");
        let boot = controller.record_start(false);
        assert!(!boot.refreshed(&controller).requires_safe_shell);
    }

    #[test]
    fn state_serializes_for_the_renderer() {
        let dir = TempDir::new().expect("tempdir");
        let controller = RecoveryController::open(dir.path(), "build-1", "0.1.0");
        let json = serde_json::to_string(&controller.snapshot()).expect("serializes");
        // An object, not a tuple/array — the renderer reads named fields.
        assert!(json.starts_with('{'));
        assert!(json.contains("\"checkpoints\""));
        assert!(json.contains("\"buildId\""));
    }
}
