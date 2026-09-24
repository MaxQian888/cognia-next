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
use std::time::Duration;

use cognia_observability::recovery::{RecoveryStateV1, RecoverySubsystem, RECOVERY_ORDER};
use cognia_secrets::secret_store::{self, Readiness};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::RecoveryController;

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
    /// Explicitly re-run the encrypted secret store's initialization, which
    /// may show the OS Keychain dialog. Scoped to the sidecar — whose
    /// credential provisioning (proxy password, provider keys) is what the
    /// store gates — and deliberately leaves every checkpoint, suspect and
    /// budget untouched: a locked Keychain is not a crash, so unlocking it
    /// must neither reset nor advance the recovery sequence.
    UnlockSecretStore,
}

/// How long the renderer waits for an explicit secret-store retry. Timing out
/// releases the UI, not the OS call; the store's initializer stays
/// single-flight, so another click cannot enqueue more dialogs.
const SECRET_STORE_RETRY_TIMEOUT: Duration = Duration::from_secs(15);

/// The boot answer the renderer's recovery gate reads: the controller's boot
/// decision plus whether the encrypted secret store is usable. Carrying the
/// store state here lets the gate surface a locked Keychain (and its Retry) on
/// every cold boot — not only when a proxy credential happens to need it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryBootAnswer {
    #[serde(flatten)]
    pub boot: super::controller::RecoveryBoot,
    pub secret_store: Readiness,
}

/// Settle the store's *passive* initialization on a blocking worker (never a
/// prompt) and report the outcome.
async fn settled_secret_store_readiness() -> Readiness {
    tauri::async_runtime::spawn_blocking(secret_store::ensure_initialized)
        .await
        .unwrap_or_else(|_| {
            log::error!("secret-store readiness worker failed");
            secret_store::readiness()
        })
}

/// Run the explicit (interactive) secret-store retry on a blocking worker.
async fn retry_secret_store_initialization() -> Result<(), String> {
    tokio::time::timeout(
        SECRET_STORE_RETRY_TIMEOUT,
        tauri::async_runtime::spawn_blocking(secret_store::retry_failed_initialization),
    )
    .await
    .map_err(|_| "secret-store recovery timed out; unlock the device before retrying".to_string())?
    .map_err(|_| "secret-store recovery worker failed".to_string())?
}

fn needs_secret_retry(
    action: RecoveryRetryAction,
    subsystem: RecoverySubsystem,
    reason: Option<&str>,
) -> bool {
    matches!(action, RecoveryRetryAction::Retry)
        && subsystem == RecoverySubsystem::Sidecar
        && matches!(
            reason,
            Some("proxy.credential_unavailable" | "proxy.apply_failed")
        )
}

async fn prepare_retry(
    action: RecoveryRetryAction,
    subsystem: RecoverySubsystem,
    reason: Option<&str>,
) -> Result<(), String> {
    if !needs_secret_retry(action, subsystem, reason) {
        return Ok(());
    }
    retry_secret_store_initialization().await
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
) -> Result<RecoveryBootAnswer, String> {
    Ok(RecoveryBootAnswer {
        boot: boot.inner().refreshed(controller.inner()),
        secret_store: settled_secret_store_readiness().await,
    })
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
    let snapshot = controller.snapshot();
    let reason = snapshot
        .checkpoints
        .iter()
        .find(|checkpoint| checkpoint.subsystem == subsystem)
        .and_then(|checkpoint| checkpoint.reason_code.as_deref())
        .or_else(|| {
            (snapshot.suspect_subsystem == Some(subsystem))
                .then_some(snapshot.suspect_reason_code.as_deref())
                .flatten()
        });
    let action = action.unwrap_or_default();
    Ok(match action {
        RecoveryRetryAction::UnlockSecretStore => {
            validate_unlock_scope(subsystem)?;
            retry_secret_store_initialization().await?;
            controller.snapshot()
        }
        RecoveryRetryAction::Retry => {
            prepare_retry(action, subsystem, reason).await?;
            controller.retry(subsystem)
        }
        RecoveryRetryAction::KeepDisabled => controller.keep_disabled(subsystem),
    })
}

/// `unlock-secret-store` is addressed to the sidecar (see the variant docs);
/// naming any other group is a caller bug, rejected rather than ignored.
fn validate_unlock_scope(subsystem: RecoverySubsystem) -> Result<(), String> {
    if subsystem == RecoverySubsystem::Sidecar {
        Ok(())
    } else {
        Err(format!(
            "unlock-secret-store applies to the sidecar, not {}",
            subsystem.as_str()
        ))
    }
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
        let unlock: RecoveryRetryAction =
            serde_json::from_str("\"unlock-secret-store\"").expect("parses");
        assert_eq!(unlock, RecoveryRetryAction::UnlockSecretStore);
    }

    #[test]
    fn unlocking_the_secret_store_is_scoped_to_the_sidecar() {
        assert!(validate_unlock_scope(RecoverySubsystem::Sidecar).is_ok());
        for subsystem in RECOVERY_ORDER {
            if subsystem != RecoverySubsystem::Sidecar {
                assert!(validate_unlock_scope(subsystem)
                    .unwrap_err()
                    .contains(subsystem.as_str()));
            }
        }
        // Unlock is its own action: it never triggers the proxy-scoped
        // checkpoint retry path.
        assert!(!needs_secret_retry(
            RecoveryRetryAction::UnlockSecretStore,
            RecoverySubsystem::Sidecar,
            Some("proxy.credential_unavailable")
        ));
    }

    #[tokio::test]
    async fn the_secret_store_readiness_is_settled_and_an_explicit_unlock_succeeds() {
        // The test build uses the in-memory store, which always opens.
        assert_eq!(settled_secret_store_readiness().await, Readiness::Ready);
        retry_secret_store_initialization()
            .await
            .expect("a ready store retries as a no-op");
        assert_eq!(secret_store::readiness(), Readiness::Ready);
    }

    #[test]
    fn the_boot_answer_flattens_the_decision_and_adds_the_store_state() {
        let dir = TempDir::new().expect("tempdir");
        let controller = RecoveryController::open(dir.path(), "build-1", "0.1.0");
        let answer = RecoveryBootAnswer {
            boot: controller.record_start(false),
            secret_store: Readiness::Locked,
        };
        let json = serde_json::to_value(&answer).expect("serializes");
        assert_eq!(json["secretStore"], "locked");
        assert_eq!(json["buildId"], "build-1");
        assert_eq!(json["requiresSafeShell"], false);
        assert!(json.get("boot").is_none(), "decision fields stay top-level");
    }

    #[test]
    fn secret_recovery_is_scoped_to_proxy_failures_not_independent_subsystems() {
        for subsystem in RECOVERY_ORDER {
            assert!(!needs_secret_retry(
                RecoveryRetryAction::Retry,
                subsystem,
                None
            ));
            assert!(!needs_secret_retry(
                RecoveryRetryAction::KeepDisabled,
                subsystem,
                Some("proxy.credential_unavailable")
            ));
            assert_eq!(
                needs_secret_retry(
                    RecoveryRetryAction::Retry,
                    subsystem,
                    Some("proxy.credential_unavailable")
                ),
                subsystem == RecoverySubsystem::Sidecar
            );
        }
        assert!(!needs_secret_retry(
            RecoveryRetryAction::Retry,
            RecoverySubsystem::Sidecar,
            Some("sidecar.not_ready")
        ));
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
