//! Tauri commands for system scheduler
//!
//! Provides commands for creating, managing, and executing system-level scheduled tasks.

use log::{debug, error, info};
use tauri::State;

use crate::scheduler::{
    ArmTaskInput, CreateSystemTaskInput, SchedulerCapabilities, SchedulerState, SystemTask,
    SystemTaskId, TaskConfirmationRequest, TaskRunResult,
};
use cognia_core::command_error::CommandError;

/// Response type for operations that may require confirmation
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TaskOperationResponse {
    /// Operation completed successfully
    Success { task: Box<SystemTask> },
    /// Confirmation required before proceeding
    ConfirmationRequired {
        confirmation: Box<TaskConfirmationRequest>,
    },
    /// Operation failed
    Error { message: String },
}

fn resolve_confirmation_target_id(
    confirmation_id: Option<SystemTaskId>,
    task_id: Option<SystemTaskId>,
) -> Result<SystemTaskId, CommandError> {
    confirmation_id
        .or(task_id)
        .ok_or_else(|| CommandError::new("invalid_config", "confirmation_id is required"))
}

fn scheduler_validate_task_impl(
    state: &SchedulerState,
    input: CreateSystemTaskInput,
) -> ValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if input.name.is_empty() {
        errors.push("Task name is required".to_string());
    } else if input.name.len() > 255 {
        errors.push("Task name must be 255 characters or less".to_string());
    }

    match &input.trigger {
        crate::scheduler::SystemTaskTrigger::Cron { expression, .. } => {
            if expression.split_whitespace().count() != 5 {
                errors.push("Cron expression must have exactly 5 fields".to_string());
            }
        }
        crate::scheduler::SystemTaskTrigger::Interval { seconds } => {
            if *seconds < 60 {
                warnings.push(
                    "Intervals less than 60 seconds may impact system performance".to_string(),
                );
            }
        }
        crate::scheduler::SystemTaskTrigger::Once { run_at } => {
            if crate::scheduler::service::parse_datetime(run_at).is_none() {
                errors.push("Invalid datetime format for run_at".to_string());
            }
        }
        _ => {}
    }

    match &input.action {
        crate::scheduler::SystemTaskAction::ExecuteScript { language, code, .. } => {
            if code.is_empty() {
                errors.push("Script code cannot be empty".to_string());
            }
            if language.is_empty() {
                errors.push("Script language is required".to_string());
            }
            warnings.push(
                "Scripts will be executed with the privileges specified. Review carefully."
                    .to_string(),
            );
        }
        crate::scheduler::SystemTaskAction::RunCommand { command, .. } => {
            if command.is_empty() {
                errors.push("Command cannot be empty".to_string());
            }
        }
        crate::scheduler::SystemTaskAction::LaunchApp { path, .. } => {
            if path.is_empty() {
                errors.push("Application path cannot be empty".to_string());
            }
        }
        crate::scheduler::SystemTaskAction::OpenUrl { url } => {
            if let Err(error) = crate::scheduler::validate_open_url(url) {
                errors.push(error);
            }
        }
    }

    let temp_task = crate::scheduler::SystemTask {
        id: "validation".to_string(),
        name: input.name.clone(),
        description: input.description.clone(),
        trigger: input.trigger.clone(),
        action: input.action.clone(),
        run_level: input.run_level,
        status: crate::scheduler::SystemTaskStatus::Enabled,
        requires_admin: false,
        tags: input.tags.clone(),
        created_at: None,
        updated_at: None,
        last_run_at: None,
        next_run_at: None,
        last_result: None,
        metadata_state: crate::scheduler::TaskMetadataState::Full,
    };

    let risk_level = temp_task.calculate_risk_level();
    let requires_admin = temp_task.check_requires_admin() || state.requires_admin(&temp_task);
    warnings.extend(temp_task.generate_warnings());

    let translation_result = state.validate_trigger_translation(&input.trigger);
    if !translation_result.valid {
        errors.extend(translation_result.errors.clone());
    }
    warnings.extend(translation_result.warnings.clone());

    let translation = Some(TranslationValidationResult {
        valid: translation_result.valid,
        errors: translation_result.errors,
        warnings: translation_result.warnings,
        native_representation: translation_result.native_representation,
    });

    ValidationResult {
        valid: errors.is_empty(),
        errors,
        warnings,
        risk_level,
        requires_admin,
        translation,
    }
}

/// Get scheduler capabilities for the current platform
#[tauri::command]
pub fn scheduler_get_capabilities(state: State<'_, SchedulerState>) -> SchedulerCapabilities {
    state.capabilities()
}

/// Check if the system scheduler is available
#[tauri::command]
pub fn scheduler_is_available(state: State<'_, SchedulerState>) -> bool {
    state.is_available()
}

/// Check if running with elevated privileges
#[tauri::command]
pub fn scheduler_is_elevated(state: State<'_, SchedulerState>) -> bool {
    state.is_elevated()
}

/// Create a new system task
///
/// If confirmation is required (high-risk operations), returns ConfirmationRequired.
/// Set `confirmed` to true after user confirmation.
#[tauri::command]
pub async fn scheduler_create_task(
    state: State<'_, SchedulerState>,
    input: CreateSystemTaskInput,
    confirmed: bool,
) -> Result<TaskOperationResponse, CommandError> {
    debug!(
        "Creating system task: name={}, confirmed={}",
        input.name, confirmed
    );

    match state.create_task_with_confirmation(input, confirmed).await {
        Ok(Ok(task)) => {
            info!("System task created successfully: {}", task.id);
            Ok(TaskOperationResponse::Success {
                task: Box::new(task),
            })
        }
        Ok(Err(confirmation)) => {
            debug!("Task creation requires confirmation: {:?}", confirmation);
            Ok(TaskOperationResponse::ConfirmationRequired {
                confirmation: Box::new(confirmation),
            })
        }
        Err(e) => {
            error!("Failed to create system task: {}", e);
            Ok(TaskOperationResponse::Error {
                message: e.to_string(),
            })
        }
    }
}

/// Update an existing system task
#[tauri::command]
pub async fn scheduler_update_task(
    state: State<'_, SchedulerState>,
    task_id: SystemTaskId,
    input: CreateSystemTaskInput,
    confirmed: bool,
) -> Result<TaskOperationResponse, CommandError> {
    debug!(
        "Updating system task: id={}, confirmed={}",
        task_id, confirmed
    );

    match state.update_task(&task_id, input, confirmed).await {
        Ok(Ok(task)) => {
            info!("System task updated successfully: {}", task.id);
            Ok(TaskOperationResponse::Success {
                task: Box::new(task),
            })
        }
        Ok(Err(confirmation)) => {
            debug!("Task update requires confirmation: {:?}", confirmation);
            Ok(TaskOperationResponse::ConfirmationRequired {
                confirmation: Box::new(confirmation),
            })
        }
        Err(e) => {
            error!("Failed to update system task: {}", e);
            Ok(TaskOperationResponse::Error {
                message: e.to_string(),
            })
        }
    }
}

/// Delete a system task
#[tauri::command]
pub async fn scheduler_delete_task(
    state: State<'_, SchedulerState>,
    task_id: SystemTaskId,
) -> Result<bool, CommandError> {
    debug!("Deleting system task: {}", task_id);

    match state.delete_task(&task_id).await {
        Ok(deleted) => {
            if deleted {
                info!("System task deleted: {}", task_id);
            }
            Ok(deleted)
        }
        Err(e) => {
            error!("Failed to delete system task: {}", e);
            Err(CommandError::from(e))
        }
    }
}

/// Get a system task by ID
#[tauri::command]
pub async fn scheduler_get_task(
    state: State<'_, SchedulerState>,
    task_id: SystemTaskId,
) -> Result<Option<SystemTask>, CommandError> {
    match state.get_task(&task_id).await {
        Ok(task) => Ok(task),
        Err(e) => {
            error!("Failed to get system task: {}", e);
            Err(CommandError::from(e))
        }
    }
}

/// List all Cognia-managed system tasks
#[tauri::command]
pub async fn scheduler_list_tasks(
    state: State<'_, SchedulerState>,
) -> Result<Vec<SystemTask>, CommandError> {
    match state.list_tasks().await {
        Ok(tasks) => {
            debug!("Listed {} system tasks", tasks.len());
            Ok(tasks)
        }
        Err(e) => {
            error!("Failed to list system tasks: {}", e);
            Err(CommandError::from(e))
        }
    }
}

/// Enable a system task
#[tauri::command]
pub async fn scheduler_enable_task(
    state: State<'_, SchedulerState>,
    task_id: SystemTaskId,
) -> Result<bool, CommandError> {
    debug!("Enabling system task: {}", task_id);

    match state.enable_task(&task_id).await {
        Ok(success) => {
            if success {
                info!("System task enabled: {}", task_id);
            }
            Ok(success)
        }
        Err(e) => {
            error!("Failed to enable system task: {}", e);
            Err(CommandError::from(e))
        }
    }
}

/// Disable a system task
#[tauri::command]
pub async fn scheduler_disable_task(
    state: State<'_, SchedulerState>,
    task_id: SystemTaskId,
) -> Result<bool, CommandError> {
    debug!("Disabling system task: {}", task_id);

    match state.disable_task(&task_id).await {
        Ok(success) => {
            if success {
                info!("System task disabled: {}", task_id);
            }
            Ok(success)
        }
        Err(e) => {
            error!("Failed to disable system task: {}", e);
            Err(CommandError::from(e))
        }
    }
}

/// Run a system task immediately
#[tauri::command]
pub async fn scheduler_run_task_now(
    state: State<'_, SchedulerState>,
    task_id: SystemTaskId,
) -> Result<TaskRunResult, CommandError> {
    debug!("Running system task now: {}", task_id);

    match state.run_task_now(&task_id).await {
        Ok(result) => {
            info!(
                "System task run completed: id={}, success={}",
                task_id, result.success
            );
            Ok(result)
        }
        Err(e) => {
            error!("Failed to run system task: {}", e);
            Err(CommandError::from(e))
        }
    }
}

/// Cancel a pending confirmation
#[tauri::command]
pub async fn scheduler_cancel_confirmation(
    state: State<'_, SchedulerState>,
    confirmation_id: Option<SystemTaskId>,
    task_id: Option<SystemTaskId>,
) -> Result<bool, CommandError> {
    let id = resolve_confirmation_target_id(confirmation_id, task_id)?;
    Ok(state.cancel_confirmation(&id).await)
}

/// Get all pending confirmations
#[tauri::command]
pub async fn scheduler_get_pending_confirmations(
    state: State<'_, SchedulerState>,
) -> Result<Vec<TaskConfirmationRequest>, CommandError> {
    Ok(state.get_pending_confirmations().await)
}

/// Request admin elevation
#[tauri::command]
pub async fn scheduler_request_elevation(
    state: State<'_, SchedulerState>,
) -> Result<bool, CommandError> {
    match state.request_elevation().await {
        Ok(elevated) => Ok(elevated),
        Err(e) => Err(CommandError::from(e)),
    }
}

/// Confirm a pending task operation
#[tauri::command]
pub async fn scheduler_confirm_task(
    state: State<'_, SchedulerState>,
    confirmation_id: Option<SystemTaskId>,
    task_id: Option<SystemTaskId>,
) -> Result<Option<SystemTask>, CommandError> {
    let id = resolve_confirmation_target_id(confirmation_id, task_id)?;
    debug!("Confirming pending task operation: {}", id);

    match state.confirm_task(&id).await {
        Ok(task) => {
            if task.is_some() {
                info!("Task operation confirmed: {}", id);
            }
            Ok(task)
        }
        Err(e) => {
            error!("Failed to confirm task: {}", e);
            Err(CommandError::from(e))
        }
    }
}

/// Validate a system task input without creating it
#[tauri::command]
pub fn scheduler_validate_task(
    state: State<'_, SchedulerState>,
    input: CreateSystemTaskInput,
) -> Result<ValidationResult, CommandError> {
    Ok(scheduler_validate_task_impl(&state, input))
}

fn scheduler_arm_task_impl(state: &SchedulerState, input: ArmTaskInput) {
    match state.alarm() {
        Some(daemon) => daemon.arm(input.task_id, input.fire_at_ms),
        None => debug!("scheduler_arm_task: alarm daemon not installed; ignoring"),
    }
}

fn scheduler_disarm_task_impl(state: &SchedulerState, task_id: &str) {
    if let Some(daemon) = state.alarm() {
        daemon.disarm(task_id);
    }
}

/// Arm a task in the in-process alarm daemon to fire at an absolute instant.
/// The TS scheduler (`lib/scheduler/timing/rust-daemon-driver.ts`) calls this
/// whenever it (re)schedules a task; the daemon emits `scheduler:task-due` when
/// the instant elapses. No-op when the alarm daemon is not installed (e.g. the
/// data dir was unavailable at boot) so the renderer never hard-fails.
#[tauri::command]
pub fn scheduler_arm_task(
    state: State<'_, SchedulerState>,
    input: ArmTaskInput,
) -> Result<(), CommandError> {
    scheduler_arm_task_impl(&state, input);
    Ok(())
}

/// Cancel a previously-armed task in the alarm daemon. No-op for unknown ids
/// or when the daemon is not installed.
#[tauri::command]
pub fn scheduler_disarm_task(
    state: State<'_, SchedulerState>,
    task_id: String,
) -> Result<(), CommandError> {
    scheduler_disarm_task_impl(&state, &task_id);
    Ok(())
}

/// Translation validation result (part of ValidationResult)
#[derive(serde::Serialize)]
pub struct TranslationValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_representation: Option<String>,
}

/// Validation result
#[derive(serde::Serialize)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub risk_level: crate::scheduler::RiskLevel,
    pub requires_admin: bool,
    /// Backend translation fidelity validation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<TranslationValidationResult>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use crate::scheduler::{RunLevel, SystemTaskAction, SystemTaskTrigger};

    fn interval_command_input(name: &str, seconds: u64) -> CreateSystemTaskInput {
        CreateSystemTaskInput {
            name: name.to_string(),
            description: Some("desc".to_string()),
            trigger: SystemTaskTrigger::Interval { seconds },
            action: SystemTaskAction::RunCommand {
                command: "echo".to_string(),
                args: vec!["ok".to_string()],
                working_dir: None,
                env: HashMap::new(),
            },
            run_level: RunLevel::User,
            tags: vec!["test".to_string()],
        }
    }

    #[test]
    fn arm_and_disarm_drive_the_installed_daemon() {
        use crate::scheduler::daemon::RecordingEmitter;
        use chrono::{Duration, Utc};

        let state = SchedulerState::default();
        state.install_alarm_no_spawn(std::sync::Arc::new(RecordingEmitter::default()));

        let fire_at = (Utc::now() + Duration::hours(1)).timestamp_millis();
        scheduler_arm_task_impl(
            &state,
            ArmTaskInput {
                task_id: "task_1".to_string(),
                fire_at_ms: fire_at,
            },
        );
        assert_eq!(state.alarm().map(|d| d.entry_count()), Some(1));

        scheduler_disarm_task_impl(&state, "task_1");
        assert_eq!(state.alarm().map(|d| d.entry_count()), Some(0));
    }

    #[test]
    fn arm_is_a_no_op_without_an_installed_daemon() {
        let state = SchedulerState::default();
        // No panic / error when the daemon was never installed (web mode).
        scheduler_arm_task_impl(
            &state,
            ArmTaskInput {
                task_id: "task_1".to_string(),
                fire_at_ms: 0,
            },
        );
        scheduler_disarm_task_impl(&state, "task_1");
        assert!(state.alarm().is_none());
    }

    #[test]
    fn resolve_confirmation_target_id_prefers_confirmation_id() {
        let resolved = resolve_confirmation_target_id(
            Some("confirm-123".to_string()),
            Some("task-456".to_string()),
        )
        .expect("id should resolve");

        assert_eq!(resolved, "confirm-123");
    }

    #[test]
    fn resolve_confirmation_target_id_requires_any_identifier() {
        let error = resolve_confirmation_target_id(None, None).expect_err("missing id should fail");
        assert_eq!(error.code, "invalid_config");
        assert_eq!(error.message, "confirmation_id is required");
    }

    #[test]
    fn scheduler_validate_task_impl_reports_empty_name_and_command_errors() {
        let state = SchedulerState::default();
        let result = scheduler_validate_task_impl(
            &state,
            CreateSystemTaskInput {
                name: String::new(),
                description: None,
                trigger: SystemTaskTrigger::Cron {
                    expression: "*/5 * *".to_string(),
                    timezone: None,
                },
                action: SystemTaskAction::RunCommand {
                    command: String::new(),
                    args: vec![],
                    working_dir: None,
                    env: HashMap::new(),
                },
                run_level: RunLevel::User,
                tags: vec![],
            },
        );

        assert!(!result.valid);
        assert!(result.errors.contains(&"Task name is required".to_string()));
        assert!(result
            .errors
            .contains(&"Cron expression must have exactly 5 fields".to_string()));
        assert!(result
            .errors
            .contains(&"Command cannot be empty".to_string()));
        assert!(result.translation.is_some());
    }

    #[test]
    fn scheduler_validate_task_impl_surfaces_open_url_validation_errors() {
        let state = SchedulerState::default();
        let input = |url: &str| CreateSystemTaskInput {
            name: "wake".to_string(),
            description: None,
            trigger: SystemTaskTrigger::Interval { seconds: 3600 },
            action: SystemTaskAction::OpenUrl {
                url: url.to_string(),
            },
            run_level: RunLevel::User,
            tags: vec![],
        };
        let bad = scheduler_validate_task_impl(&state, input("file:///etc/passwd"));
        assert!(!bad.valid);
        assert!(bad
            .errors
            .iter()
            .any(|e| e.contains("scheme") && e.contains("not allowed")));
        let good = scheduler_validate_task_impl(&state, input("cognia://scheduler/task/1?run=t"));
        assert!(good.valid, "{:?}", good.errors);
    }

    #[test]
    fn scheduler_validate_task_impl_adds_interval_and_script_warnings() {
        let state = SchedulerState::default();
        let result = scheduler_validate_task_impl(
            &state,
            CreateSystemTaskInput {
                name: "script-task".to_string(),
                description: Some("script".to_string()),
                trigger: SystemTaskTrigger::Interval { seconds: 30 },
                action: SystemTaskAction::ExecuteScript {
                    language: "python".to_string(),
                    code: "print('ok')".to_string(),
                    working_dir: None,
                    args: vec![],
                    env: HashMap::new(),
                    timeout_secs: 300,
                    memory_mb: 512,
                    use_sandbox: false,
                },
                run_level: RunLevel::Administrator,
                tags: vec!["test".to_string()],
            },
        );

        assert!(result.requires_admin);
        assert_eq!(result.risk_level, crate::scheduler::RiskLevel::Critical);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("Intervals less than 60 seconds")));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("Scripts will be executed")));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("管理员权限") || warning.contains("administrator")));
    }

    #[test]
    fn scheduler_validate_task_impl_accepts_basic_interval_command() {
        let state = SchedulerState::default();
        let result = scheduler_validate_task_impl(&state, interval_command_input("basic", 120));

        assert!(
            result.valid,
            "expected validation to succeed: {:?}",
            result.errors
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.risk_level, crate::scheduler::RiskLevel::Low);
        assert!(result.translation.is_some());
    }
}
