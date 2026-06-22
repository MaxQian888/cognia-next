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
