//! Scheduler error types

use std::error::Error as StdError;
use std::fmt;

const MAX_ERROR_DETAIL_CHARS: usize = 512;
const TRUNCATED_ERROR_DETAIL_SUFFIX: &str = "... (truncated)";

/// Errors that can occur during system scheduler operations
#[derive(Debug)]
pub enum SchedulerError {
    NotAvailable(String),

    TaskNotFound(String),

    TaskAlreadyExists(String),

    InvalidConfig(String),

    PermissionDenied(String),

    AdminRequired(String),

    ConfirmationRequired,

    ExecutionFailed(String),

    Timeout(String),

    InvalidCron(String),

    ScriptValidation(String),

    SecurityViolation(String),

    Platform(String),

    Io(std::io::Error),

    Serialization(String),

    Internal(String),
}

impl SchedulerError {
    fn fmt_detail(f: &mut fmt::Formatter<'_>, prefix: &str, detail: &str) -> fmt::Result {
        write!(f, "{prefix}{}", sanitize_error_detail(detail))
    }
}

impl fmt::Display for SchedulerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAvailable(detail) => {
                Self::fmt_detail(f, "Scheduler not available on this platform: ", detail)
            }
            Self::TaskNotFound(detail) => Self::fmt_detail(f, "Task not found: ", detail),
            Self::TaskAlreadyExists(detail) => Self::fmt_detail(f, "Task already exists: ", detail),
            Self::InvalidConfig(detail) => {
                Self::fmt_detail(f, "Invalid task configuration: ", detail)
            }
            Self::PermissionDenied(detail) => Self::fmt_detail(f, "Permission denied: ", detail),
            Self::AdminRequired(detail) => {
                Self::fmt_detail(f, "Administrator privileges required: ", detail)
            }
            Self::ConfirmationRequired => f.write_str("Operation requires confirmation"),
            Self::ExecutionFailed(detail) => Self::fmt_detail(f, "Execution failed: ", detail),
            Self::Timeout(detail) => Self::fmt_detail(f, "Timeout: ", detail),
            Self::InvalidCron(detail) => Self::fmt_detail(f, "Invalid cron expression: ", detail),
            Self::ScriptValidation(detail) => {
                Self::fmt_detail(f, "Script validation failed: ", detail)
            }
            Self::SecurityViolation(detail) => Self::fmt_detail(f, "Security violation: ", detail),
            Self::Platform(detail) => Self::fmt_detail(f, "Platform error: ", detail),
            Self::Io(error) => Self::fmt_detail(f, "IO error: ", &error.to_string()),
            Self::Serialization(detail) => Self::fmt_detail(f, "Serialization error: ", detail),
            Self::Internal(detail) => Self::fmt_detail(f, "Internal error: ", detail),
        }
    }
}

impl StdError for SchedulerError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for SchedulerError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<SchedulerError> for String {
    fn from(err: SchedulerError) -> Self {
        err.to_string()
    }
}

impl serde::Serialize for SchedulerError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, SchedulerError>;

fn sanitize_error_detail(value: &str) -> String {
    let mut normalized = String::new();
    let mut emitted = 0usize;
    let mut truncated = false;

    for ch in value.chars() {
        if emitted >= MAX_ERROR_DETAIL_CHARS {
            truncated = true;
            break;
        }

        let ch = if ch.is_control() || ch.is_whitespace() {
            ' '
        } else {
            ch
        };

        if ch == ' ' && (normalized.is_empty() || normalized.ends_with(' ')) {
            continue;
        }

        normalized.push(ch);
        emitted += 1;
    }

    normalized.truncate(normalized.trim_end().len());
    if normalized.is_empty() {
        normalized.push_str("<empty>");
    }
    if truncated {
        normalized.push_str(TRUNCATED_ERROR_DETAIL_SUFFIX);
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_conversion_sanitizes_and_bounds_dynamic_details() {
        let detail = format!("schtasks failed\r\n{}\u{0007}", "x".repeat(700));

        let message: String = SchedulerError::Platform(detail).into();

        assert!(message.starts_with("Platform error: schtasks failed "));
        assert!(message.ends_with("... (truncated)"));
        assert!(!message.contains('\r'));
        assert!(!message.contains('\n'));
        assert!(!message.contains('\u{0007}'));
        assert!(message.len() < 600);
    }

    #[test]
    fn serialization_uses_the_same_safe_message() {
        let json = serde_json::to_string(&SchedulerError::SecurityViolation(
            "bad\u{0000}\nname".to_string(),
        ))
        .expect("serialize scheduler error");

        assert_eq!(json, "\"Security violation: bad name\"");
    }
}

// ADR-0067 Phase 6 — moved here from command_error.rs so the `cognia-core`
// foundation crate has no upward edge into the scheduler. Orphan-rule OK:
// `SchedulerError` is local to this crate. Uses the `CommandError` constructors
// (which truncate the message) instead of the crate-private `truncate_message`.
impl From<SchedulerError> for cognia_core::command_error::CommandError {
    fn from(err: SchedulerError) -> Self {
        use cognia_core::command_error::CommandError;
        use SchedulerError as E;
        // Honest retryability audit: only genuinely transient failures retry.
        let (code, retryable) = match &err {
            E::NotAvailable(_) => ("not_available", false),
            E::TaskNotFound(_) => ("task_not_found", false),
            E::TaskAlreadyExists(_) => ("task_already_exists", false),
            E::InvalidConfig(_) => ("invalid_config", false),
            E::PermissionDenied(_) => ("permission_denied", false),
            E::AdminRequired(_) => ("admin_required", false),
            E::ConfirmationRequired => ("confirmation_required", false),
            E::ExecutionFailed(_) => ("execution_failed", true),
            E::Timeout(_) => ("timeout", true),
            E::InvalidCron(_) => ("invalid_cron", false),
            E::ScriptValidation(_) => ("script_validation", false),
            E::SecurityViolation(_) => ("security_violation", false),
            E::Platform(_) => ("platform", false),
            E::Io(_) => ("io", true),
            E::Serialization(_) => ("serialization", false),
            E::Internal(_) => ("internal", false),
        };
        let message = err.to_string();
        if retryable {
            CommandError::retryable(code, message)
        } else {
            CommandError::new(code, message)
        }
    }
}

#[cfg(test)]
mod command_error_conv_tests {
    use super::SchedulerError;
    use cognia_core::command_error::CommandError;

    #[test]
    fn scheduler_error_maps_to_code_and_retryability() {
        let timeout = CommandError::from(SchedulerError::Timeout("op".into()));
        assert_eq!(timeout.code, "timeout");
        assert!(timeout.retryable);

        let denied = CommandError::from(SchedulerError::PermissionDenied("nope".into()));
        assert_eq!(denied.code, "permission_denied");
        assert!(!denied.retryable);

        let confirm = CommandError::from(SchedulerError::ConfirmationRequired);
        assert_eq!(confirm.code, "confirmation_required");
    }
}
