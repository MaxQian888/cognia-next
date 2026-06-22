use crate::logging::platform::{self, PlatformLoggingStatus};
use chrono::Utc;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::fs::{create_dir_all, remove_file, OpenOptions};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri_plugin_log::{Target, TargetKind};

const APP_LOG_DIR_NAME: &str = "Cognia";
const LOG_FILE_NAME: &str = "cognia";
const READY_TARGETS_FULL: [&str; 3] = ["stdout", "folder", "webview"];
const READY_TARGETS_FALLBACK: [&str; 2] = ["stdout", "webview"];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeLoggingBootstrapMode {
    Full,
    Fallback,
    Disabled,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeLoggingHealth {
    Healthy,
    Degraded,
    Inactive,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeLoggingFallbackReason {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeLoggingReadiness {
    pub startup_mode: NativeLoggingBootstrapMode,
    pub startup_health: NativeLoggingHealth,
    pub active_targets: Vec<String>,
    pub fallback_reason: Option<NativeLoggingFallbackReason>,
    pub platform_logging: PlatformLoggingStatus,
    pub checked_at: String,
}

impl NativeLoggingReadiness {
    fn disabled() -> Self {
        Self {
            startup_mode: NativeLoggingBootstrapMode::Disabled,
            startup_health: NativeLoggingHealth::Inactive,
            active_targets: Vec::new(),
            fallback_reason: None,
            platform_logging: platform::default_platform_logging_status(),
            checked_at: Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeLoggingBootstrapPlan {
    pub mode: NativeLoggingBootstrapMode,
    pub health: NativeLoggingHealth,
    pub active_targets: Vec<String>,
    pub fallback_reason: Option<NativeLoggingFallbackReason>,
    pub platform_logging: PlatformLoggingStatus,
    pub checked_at: String,
}

impl NativeLoggingBootstrapPlan {
    pub fn targets(&self) -> Vec<Target> {
        self.active_targets
            .iter()
            .filter_map(|target| match target.as_str() {
                "stdout" => Some(Target::new(TargetKind::Stdout)),
                "folder" => Some(Target::new(TargetKind::LogDir {
                    file_name: Some(LOG_FILE_NAME.to_string()),
                })),
                "webview" => Some(Target::new(TargetKind::Webview)),
                _ => None,
            })
            .collect()
    }

    pub fn to_readiness(&self) -> NativeLoggingReadiness {
        NativeLoggingReadiness {
            startup_mode: self.mode,
            startup_health: self.health,
            active_targets: self.active_targets.clone(),
            fallback_reason: self.fallback_reason.clone(),
            platform_logging: self.platform_logging.clone(),
            checked_at: self.checked_at.clone(),
        }
    }
}

static NATIVE_LOGGING_READINESS: Lazy<Mutex<NativeLoggingReadiness>> =
    Lazy::new(|| Mutex::new(NativeLoggingReadiness::disabled()));

pub fn plan_native_logging_bootstrap(should_register: bool) -> NativeLoggingBootstrapPlan {
    plan_native_logging_bootstrap_with(
        should_register,
        prepare_persistent_log_target,
        platform::bootstrap_platform_logging,
    )
}

pub fn apply_native_logging_bootstrap(plan: &NativeLoggingBootstrapPlan) {
    set_native_logging_readiness(plan.to_readiness());
}

pub fn get_native_logging_readiness() -> NativeLoggingReadiness {
    NATIVE_LOGGING_READINESS
        .lock()
        .map(|state| state.clone())
        .unwrap_or_else(|_| NativeLoggingReadiness::disabled())
}

fn set_native_logging_readiness(next: NativeLoggingReadiness) {
    if let Ok(mut state) = NATIVE_LOGGING_READINESS.lock() {
        *state = next;
    }
}

/// Resolve the persistent log directory (`<data_local_dir>/Cognia/logs`)
/// without creating it. Returns `None` when the platform data dir is
/// unavailable. Used by the startup rotated-log prune.
pub fn log_dir() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join(APP_LOG_DIR_NAME).join("logs"))
}

fn prepare_persistent_log_target() -> Result<PathBuf, String> {
    let local_data =
        dirs::data_local_dir().ok_or_else(|| "unable_to_resolve_local_data_dir".to_string())?;
    let log_dir = local_data.join(APP_LOG_DIR_NAME).join("logs");
    create_dir_all(&log_dir).map_err(|error| {
        format!(
            "unable_to_prepare_log_dir:{}",
            sanitize_error_message(error.to_string())
        )
    })?;

    let probe_file = log_dir.join(".native-logging-probe");
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&probe_file)
        .map_err(|error| {
            format!(
                "unable_to_probe_log_dir:{}",
                sanitize_error_message(error.to_string())
            )
        })?;
    let _ = remove_file(probe_file);

    Ok(log_dir)
}

fn plan_native_logging_bootstrap_with<F, G>(
    should_register: bool,
    prepare_persistent_target: F,
    bootstrap_platform_logging: G,
) -> NativeLoggingBootstrapPlan
where
    F: FnOnce() -> Result<PathBuf, String>,
    G: FnOnce() -> PlatformLoggingStatus,
{
    let checked_at = Utc::now().to_rfc3339();
    let platform_logging = bootstrap_platform_logging();
    if !should_register {
        return NativeLoggingBootstrapPlan {
            mode: NativeLoggingBootstrapMode::Disabled,
            health: NativeLoggingHealth::Inactive,
            active_targets: Vec::new(),
            fallback_reason: None,
            platform_logging,
            checked_at,
        };
    }

    match prepare_persistent_target() {
        Ok(_) => NativeLoggingBootstrapPlan {
            mode: NativeLoggingBootstrapMode::Full,
            health: NativeLoggingHealth::Healthy,
            active_targets: READY_TARGETS_FULL
                .iter()
                .map(|target| target.to_string())
                .collect(),
            fallback_reason: None,
            platform_logging,
            checked_at,
        },
        Err(message) => NativeLoggingBootstrapPlan {
            mode: NativeLoggingBootstrapMode::Fallback,
            health: NativeLoggingHealth::Degraded,
            active_targets: READY_TARGETS_FALLBACK
                .iter()
                .map(|target| target.to_string())
                .collect(),
            fallback_reason: Some(NativeLoggingFallbackReason {
                code: "persistent_target_unavailable".to_string(),
                message: sanitize_error_message(message),
            }),
            platform_logging,
            checked_at,
        },
    }
}

#[allow(dead_code)]
fn sanitize_error_message(value: String) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(256)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform_status() -> PlatformLoggingStatus {
        platform::default_platform_logging_status()
    }

    fn expected_targets(targets: &[&str]) -> Vec<String> {
        targets.iter().map(|target| target.to_string()).collect()
    }

    #[test]
    fn disabled_plan_does_not_prepare_persistent_target() {
        let plan = plan_native_logging_bootstrap_with(
            false,
            || panic!("persistent target must not be prepared when disabled"),
            platform_status,
        );

        assert_eq!(plan.mode, NativeLoggingBootstrapMode::Disabled);
        assert_eq!(plan.health, NativeLoggingHealth::Inactive);
        assert!(plan.active_targets.is_empty());
        assert!(plan.fallback_reason.is_none());
        assert_eq!(plan.platform_logging, platform_status());
    }

    #[test]
    fn successful_persistent_target_enables_full_target_set() {
        let plan = plan_native_logging_bootstrap_with(
            true,
            || Ok(PathBuf::from("C:/logs/Cognia")),
            platform_status,
        );

        assert_eq!(plan.mode, NativeLoggingBootstrapMode::Full);
        assert_eq!(plan.health, NativeLoggingHealth::Healthy);
        assert_eq!(plan.active_targets, expected_targets(&READY_TARGETS_FULL));
        assert!(plan.fallback_reason.is_none());
        assert_eq!(plan.targets().len(), READY_TARGETS_FULL.len());
    }

    #[test]
    fn persistent_target_failure_uses_fallback_targets_and_sanitized_reason() {
        let noisy = format!("{}\n\t{}", "disk denied ".repeat(80), "tail");
        let plan = plan_native_logging_bootstrap_with(true, || Err(noisy.clone()), platform_status);

        assert_eq!(plan.mode, NativeLoggingBootstrapMode::Fallback);
        assert_eq!(plan.health, NativeLoggingHealth::Degraded);
        assert_eq!(
            plan.active_targets,
            expected_targets(&READY_TARGETS_FALLBACK)
        );
        let reason = plan.fallback_reason.expect("fallback reason");
        assert_eq!(reason.code, "persistent_target_unavailable");
        assert!(!reason.message.contains('\n'));
        assert!(!reason.message.contains('\t'));
        assert!(reason.message.len() <= 256);
        assert_ne!(reason.message, noisy);
    }

    #[test]
    fn readiness_projection_preserves_planned_state() {
        let plan = NativeLoggingBootstrapPlan {
            mode: NativeLoggingBootstrapMode::Fallback,
            health: NativeLoggingHealth::Degraded,
            active_targets: vec!["stdout".to_string(), "webview".to_string()],
            fallback_reason: Some(NativeLoggingFallbackReason {
                code: "persistent_target_unavailable".to_string(),
                message: "disk denied".to_string(),
            }),
            platform_logging: platform_status(),
            checked_at: "2026-04-06T12:00:00Z".to_string(),
        };

        let readiness = plan.to_readiness();

        assert_eq!(readiness.startup_mode, plan.mode);
        assert_eq!(readiness.startup_health, plan.health);
        assert_eq!(readiness.active_targets, plan.active_targets);
        assert_eq!(readiness.fallback_reason, plan.fallback_reason);
        assert_eq!(readiness.platform_logging, plan.platform_logging);
        assert_eq!(readiness.checked_at, plan.checked_at);
    }
}
