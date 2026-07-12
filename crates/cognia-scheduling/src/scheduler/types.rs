//! System scheduler type definitions
//!
//! Types for system-level task scheduling across Windows, macOS, and Linux.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Unique identifier for system tasks
pub type SystemTaskId = String;

/// Input for arming a task in the in-process alarm daemon (`daemon.rs`). The
/// TS scheduler computes the next fire instant and pushes a single absolute
/// timestamp; the daemon sleeps to it and emits `scheduler:task-due`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmTaskInput {
    pub task_id: String,
    pub fire_at_ms: i64,
}

/// Payload emitted over the `scheduler:task-due` event when an armed task's
/// instant elapses. Mirrors `DaemonTaskDueEvent` in `types/scheduler/daemon.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDueEvent {
    pub task_id: String,
    pub fired_at_ms: i64,
}

/// Run level for task execution
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RunLevel {
    /// Run with current user privileges
    #[default]
    User,
    /// Run with elevated/administrator privileges
    Administrator,
}

/// Status of a system task
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SystemTaskStatus {
    /// Task is enabled and will run on schedule
    #[default]
    Enabled,
    /// Task is disabled
    Disabled,
    /// Task is currently running
    Running,
    /// Task completed successfully
    Completed,
    /// Task failed
    Failed,
    /// Unknown status
    Unknown,
}

/// Completeness of scheduler metadata for a task
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskMetadataState {
    /// Trigger/action metadata is complete and editable
    #[default]
    Full,
    /// Metadata could not be fully reconstructed from platform scheduler
    Degraded,
}

/// Risk level for task operations
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    /// Low risk - normal in-app tasks
    Low,
    /// Medium risk - modifying existing tasks
    Medium,
    /// High risk - system tasks or script execution
    High,
    /// Critical risk - admin privileges + system tasks + scripts
    Critical,
}

/// Trigger type for system tasks
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SystemTaskTrigger {
    /// Cron-style schedule
    Cron {
        expression: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        timezone: Option<String>,
    },
    /// Fixed interval in seconds
    Interval { seconds: u64 },
    /// One-time execution at specific time
    Once {
        /// ISO 8601 datetime string
        run_at: String,
    },
    /// Run when system boots
    OnBoot {
        /// Delay in seconds after boot
        #[serde(default)]
        delay_seconds: u64,
    },
    /// Run when user logs in
    OnLogon {
        /// Specific user (None = current user)
        #[serde(skip_serializing_if = "Option::is_none")]
        user: Option<String>,
    },
    /// Run on system event (Windows only)
    OnEvent { source: String, event_id: u32 },
}

/// Action to perform when task triggers
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SystemTaskAction {
    /// Execute a script in sandbox
    ExecuteScript {
        language: String,
        code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        working_dir: Option<String>,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        /// Timeout in seconds
        #[serde(default = "default_timeout")]
        timeout_secs: u64,
        /// Memory limit in MB
        #[serde(default = "default_memory_limit")]
        memory_mb: u64,
        /// Run in sandbox (safer but limited)
        #[serde(default = "default_true")]
        use_sandbox: bool,
    },
    /// Run a system command
    RunCommand {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        working_dir: Option<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    /// Launch an application
    LaunchApp {
        path: String,
        #[serde(default)]
        args: Vec<String>,
    },
}

fn default_timeout() -> u64 {
    300
}

fn default_memory_limit() -> u64 {
    512
}

fn default_true() -> bool {
    true
}

/// System task definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemTask {
    /// Unique task identifier
    pub id: SystemTaskId,
    /// Human-readable name
    pub name: String,
    /// Optional description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// When to trigger the task
    pub trigger: SystemTaskTrigger,
    /// What action to perform
    pub action: SystemTaskAction,
    /// Execution privileges
    #[serde(default)]
    pub run_level: RunLevel,
    /// Current status
    #[serde(default)]
    pub status: SystemTaskStatus,
    /// Whether this task requires admin to create/modify
    #[serde(default)]
    pub requires_admin: bool,
    /// Tags for categorization
    #[serde(default)]
    pub tags: Vec<String>,
    /// Creation timestamp (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Last modification timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Last run timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    /// Next scheduled run
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    /// Last run result
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_result: Option<TaskRunResult>,
    /// Whether metadata is complete for editing
    #[serde(default)]
    pub metadata_state: TaskMetadataState,
}

/// Result of a task execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRunResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// Input for creating a system task
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSystemTaskInput {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub trigger: SystemTaskTrigger,
    pub action: SystemTaskAction,
    #[serde(default)]
    pub run_level: RunLevel,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Confirmation request for sensitive operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskConfirmationRequest {
    pub confirmation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<SystemTaskId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_task_id: Option<SystemTaskId>,
    pub operation: TaskOperation,
    pub risk_level: RiskLevel,
    pub requires_admin: bool,
    pub warnings: Vec<String>,
    pub details: TaskConfirmationDetails,
    pub created_at: String,
    pub expires_at: String,
}

/// Type of operation requiring confirmation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskOperation {
    Create,
    Update,
    Delete,
    Enable,
    RunNow,
}

/// Details shown in confirmation dialog
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskConfirmationDetails {
    pub task_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_preview: Option<String>,
}

/// Per-trigger capability descriptor
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerCapability {
    /// Trigger type name (e.g. "cron", "interval", "on_boot")
    pub trigger_type: String,
    /// Whether this trigger is available on the current platform
    pub available: bool,
    /// Whether this trigger requires admin privileges
    pub requires_admin: bool,
    /// Constraint notes explaining limitations (shown when unavailable or restricted)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraint_notes: Vec<String>,
    /// Backend behavior notes for available triggers (shown as contextual help)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub backend_notes: Vec<String>,
}

/// Result of validating trigger translation fidelity on the active platform
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationValidation {
    /// Whether the trigger can be faithfully translated
    pub valid: bool,
    /// Blocking translation errors
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
    /// Non-blocking translation warnings
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// Human-readable preview of what the OS will schedule
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_representation: Option<String>,
}

/// System scheduler capabilities
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerCapabilities {
    /// Operating system name
    pub os: String,
    /// Scheduler backend name (Task Scheduler, launchd, systemd)
    pub backend: String,
    /// Whether system scheduling is available
    pub available: bool,
    /// Whether admin elevation is possible
    pub can_elevate: bool,
    /// Supported trigger types (kept for backwards compatibility)
    pub supported_triggers: Vec<String>,
    /// Per-trigger capability descriptors with availability, constraints, and notes
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trigger_capabilities: Vec<TriggerCapability>,
    /// Maximum tasks allowed (0 = unlimited)
    pub max_tasks: u32,
}

impl SystemTask {
    /// Generate a unique task ID
    pub fn generate_id() -> SystemTaskId {
        format!(
            "cognia-task-{}",
            uuid::Uuid::new_v4()
                .to_string()
                .split('-')
                .next()
                .unwrap_or("0000")
        )
    }

    /// Check if this task requires administrator privileges
    pub fn check_requires_admin(&self) -> bool {
        // Admin required if:
        // 1. Run level is Administrator
        // 2. OnBoot trigger (requires system access)
        // 3. Command accesses system paths
        if self.run_level == RunLevel::Administrator {
            return true;
        }

        if matches!(self.trigger, SystemTaskTrigger::OnBoot { .. }) {
            return true;
        }

        match &self.action {
            SystemTaskAction::RunCommand { command, .. } => Self::is_privileged_path(command),
            SystemTaskAction::LaunchApp { path, .. } => Self::is_privileged_path(path),
            SystemTaskAction::ExecuteScript { use_sandbox, .. } => {
                // Scripts without sandbox need more scrutiny
                !use_sandbox
            }
        }
    }

    /// Calculate risk level for this task
    pub fn calculate_risk_level(&self) -> RiskLevel {
        let requires_admin = self.check_requires_admin();
        let is_script = matches!(self.action, SystemTaskAction::ExecuteScript { .. });
        let is_system_trigger = matches!(
            self.trigger,
            SystemTaskTrigger::OnBoot { .. } | SystemTaskTrigger::OnLogon { .. }
        );

        match (requires_admin, is_script, is_system_trigger) {
            (true, true, _) => RiskLevel::Critical,
            (true, false, true) => RiskLevel::Critical,
            (true, false, false) => RiskLevel::High,
            (false, true, _) => RiskLevel::High,
            (false, false, true) => RiskLevel::Medium,
            (false, false, false) => RiskLevel::Low,
        }
    }

    /// Check if a path requires elevated privileges
    fn is_privileged_path(path: &str) -> bool {
        let path = normalize_privileged_path(path);
        let windows_roots = [
            "c:/windows",
            "c:/program files",
            "c:/program files (x86)",
            "c:/programdata",
        ];
        let unix_roots = ["/etc", "/usr", "/var", "/opt", "/root"];

        windows_roots
            .iter()
            .chain(unix_roots.iter())
            .any(|root| path_has_root(&path, root))
    }

    /// Generate warnings for confirmation dialog
    pub fn generate_warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();

        if self.run_level == RunLevel::Administrator {
            warnings.push(
                "此任务将以管理员权限运行 / This task will run with administrator privileges"
                    .to_string(),
            );
        }

        if matches!(self.trigger, SystemTaskTrigger::OnBoot { .. }) {
            warnings
                .push("此任务将在系统启动时运行 / This task will run at system boot".to_string());
        }

        if matches!(self.trigger, SystemTaskTrigger::OnLogon { .. }) {
            warnings
                .push("此任务将在用户登录时运行 / This task will run at user logon".to_string());
        }

        if let SystemTaskAction::ExecuteScript {
            use_sandbox,
            language,
            ..
        } = &self.action
        {
            if !use_sandbox {
                warnings.push(format!(
                    "脚本将在沙盒外运行，可访问完整系统 / {} script will run outside sandbox with full system access",
                    language
                ));
            }
        }

        if let SystemTaskAction::RunCommand { command, .. } = &self.action {
            if Self::is_privileged_path(command) {
                warnings.push("命令涉及系统目录 / Command involves system directories".to_string());
            }
        }

        warnings
    }
}

fn normalize_privileged_path(path: &str) -> String {
    let mut normalized = path
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace('\\', "/")
        .to_lowercase();

    if let Some(stripped) = normalized.strip_prefix("//?/") {
        normalized = stripped.to_string();
    }

    normalized
}

fn path_has_root(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&format!("{root}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_task(command: &str) -> SystemTask {
        SystemTask {
            id: "task".to_string(),
            name: "Task".to_string(),
            description: None,
            trigger: SystemTaskTrigger::Interval { seconds: 60 },
            action: SystemTaskAction::RunCommand {
                command: command.to_string(),
                args: vec![],
                working_dir: None,
                env: HashMap::new(),
            },
            run_level: RunLevel::User,
            status: SystemTaskStatus::Enabled,
            requires_admin: false,
            tags: vec![],
            created_at: None,
            updated_at: None,
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state: TaskMetadataState::Full,
        }
    }

    #[test]
    fn privileged_path_detection_handles_windows_slashes_and_segment_boundaries() {
        assert!(SystemTask::is_privileged_path(
            "C:/Windows/System32/schtasks.exe"
        ));
        assert!(SystemTask::is_privileged_path(
            "C:\\Program Files\\Cognia\\helper.exe"
        ));
        assert!(SystemTask::is_privileged_path("/usr/bin/systemctl"));
        assert!(!SystemTask::is_privileged_path("C:/WindowsBackup/tool.exe"));
        assert!(!SystemTask::is_privileged_path("/usrbin/tool"));
    }

    #[test]
    fn command_tasks_under_windows_system_dir_require_admin_and_high_risk() {
        let task = command_task("C:/Windows/System32/schtasks.exe");

        assert!(task.check_requires_admin());
        assert_eq!(task.calculate_risk_level(), RiskLevel::High);
        assert!(task
            .generate_warnings()
            .iter()
            .any(|warning| warning.contains("system directories")));
    }
}
