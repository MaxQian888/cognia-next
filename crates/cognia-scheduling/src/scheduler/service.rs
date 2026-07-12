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
const MAX_TASK_NAME_BODY_CHARS: usize = 96;
const TRUNCATED_TASK_NAME_HASH_CHARS: usize = 8;

/// Generate a system-compatible task name
pub fn generate_task_name(name: &str) -> String {
    let sanitized = sanitize_task_name_body(name);
    format!("{}{}", TASK_PREFIX, sanitized)
}

/// Check if a task name belongs to Cognia
pub fn is_cognia_task(name: &str) -> bool {
    let task_name = name.rsplit(['\\', '/']).next().unwrap_or(name).trim();
    task_name.starts_with(TASK_PREFIX) && task_name.len() > TASK_PREFIX.len()
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

fn sanitize_task_name_body(name: &str) -> String {
    let mut body = String::new();
    for ch in name.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            ch
        } else {
            '_'
        };

        if mapped == '_' && (body.is_empty() || body.ends_with('_')) {
            continue;
        }

        body.push(mapped);
    }

    let mut body = body.trim_matches(['_', '-']).to_string();
    if body.is_empty() {
        body.push_str("task");
    }

    if body.len() > MAX_TASK_NAME_BODY_CHARS {
        let suffix = format!(
            "_{:01$x}",
            stable_task_name_hash(name),
            TRUNCATED_TASK_NAME_HASH_CHARS
        );
        let keep = MAX_TASK_NAME_BODY_CHARS.saturating_sub(suffix.len());
        body.truncate(keep);
        body.truncate(body.trim_end_matches(['_', '-']).len());
        if body.is_empty() {
            body.push_str("task");
        }
        body.push_str(&suffix);
    }

    body
}

fn stable_task_name_hash(value: &str) -> u32 {
    let mut hash = 0x811c_9dc5u32;
    for byte in value.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_task_name_uses_portable_bounded_identifier() {
        let generated =
            generate_task_name(&format!("{}{}", "同步任务/../../evil\n🚀", "x".repeat(180)));

        assert!(generated.starts_with(TASK_PREFIX));
        assert!(generated.len() <= 128);
        assert!(generated
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'));
        assert!(!generated.contains(".."));
        assert!(!generated.contains('/'));
        assert!(!generated.contains('\\'));
        assert!(!generated.contains('\n'));
    }

    #[test]
    fn generate_task_name_uses_fallback_for_empty_sanitized_input() {
        assert_eq!(generate_task_name(" \t\n🚀/."), "Cognia_task");
    }

    #[test]
    fn is_cognia_task_accepts_windows_rooted_task_names() {
        assert!(is_cognia_task("Cognia_daily"));
        assert!(is_cognia_task("\\Cognia_daily"));
        assert!(is_cognia_task("\\Folder\\Cognia_daily"));
        assert!(!is_cognia_task("\\Folder\\Other_daily"));
    }

    #[test]
    fn parse_datetime_normalizes_offsets_to_utc() {
        let parsed = parse_datetime("2026-06-22T09:30:00+08:00").expect("valid datetime");

        assert_eq!(parsed.to_rfc3339(), "2026-06-22T01:30:00+00:00");
        assert!(parse_datetime("not-a-date").is_none());
    }
}
