//! System scheduler service trait and common functionality

use async_trait::async_trait;

use super::error::Result;
use super::types::{
    CreateSystemTaskInput, SchedulerCapabilities, SystemTask, SystemTaskTrigger, TaskRunResult,
    TranslationValidation, TriggerCapability,
};

/// Trait for platform-specific scheduler implementations
#[async_trait]
pub trait SystemScheduler: Send + Sync {
    /// Get scheduler capabilities for this platform
    fn capabilities(&self) -> SchedulerCapabilities;

    /// Check if the scheduler is available
    fn is_available(&self) -> bool;

    /// Create a new system task
    async fn create_task(&self, input: CreateSystemTaskInput) -> Result<SystemTask>;

    /// Update an existing task
    async fn update_task(&self, id: &str, input: CreateSystemTaskInput) -> Result<SystemTask>;

    /// Delete a task
    async fn delete_task(&self, id: &str) -> Result<bool>;

    /// Get a task by ID
    async fn get_task(&self, id: &str) -> Result<Option<SystemTask>>;

    /// List all Cognia-managed tasks
    async fn list_tasks(&self) -> Result<Vec<SystemTask>>;

    /// Enable a task
    async fn enable_task(&self, id: &str) -> Result<bool>;

    /// Disable a task
    async fn disable_task(&self, id: &str) -> Result<bool>;

    /// Run a task immediately
    async fn run_task_now(&self, id: &str) -> Result<TaskRunResult>;

    /// Check if admin elevation is required for an operation
    fn requires_admin(&self, task: &SystemTask) -> bool;

    /// Request admin elevation (platform-specific)
    async fn request_elevation(&self) -> Result<bool>;

    /// Check if currently running with admin privileges
    fn is_elevated(&self) -> bool;

    /// Get per-trigger capability descriptors for this platform
    fn get_trigger_capabilities(&self) -> Vec<TriggerCapability>;

    /// Validate trigger translation fidelity on this platform
    fn validate_trigger_translation(&self, trigger: &SystemTaskTrigger) -> TranslationValidation;
}

/// Cognia task name prefix for identification
pub const TASK_PREFIX: &str = "Cognia_";

/// Generate a system-compatible task name
pub fn generate_task_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{}{}", TASK_PREFIX, sanitized)
}

/// Check if a task name belongs to Cognia
pub fn is_cognia_task(name: &str) -> bool {
    name.starts_with(TASK_PREFIX)
}

/// Parse ISO 8601 datetime string
pub fn parse_datetime(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Utc))
}

/// Format datetime to ISO 8601
pub fn format_datetime(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339()
}

/// Get current datetime as ISO 8601
pub fn now_iso() -> String {
    format_datetime(chrono::Utc::now())
}
