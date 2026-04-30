//! Scheduler error types

use thiserror::Error;

/// Errors that can occur during system scheduler operations
#[derive(Error, Debug)]
pub enum SchedulerError {
    #[error("Scheduler not available on this platform: {0}")]
    NotAvailable(String),

    #[error("Task not found: {0}")]
    TaskNotFound(String),

    #[error("Task already exists: {0}")]
    TaskAlreadyExists(String),

    #[error("Invalid task configuration: {0}")]
    InvalidConfig(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Administrator privileges required: {0}")]
    AdminRequired(String),

    #[error("Operation requires confirmation")]
    ConfirmationRequired,

    #[error("Execution failed: {0}")]
    ExecutionFailed(String),

    #[error("Timeout: {0}")]
    Timeout(String),

    #[error("Invalid cron expression: {0}")]
    InvalidCron(String),

    #[error("Script validation failed: {0}")]
    ScriptValidation(String),

    #[error("Security violation: {0}")]
    SecurityViolation(String),

    #[error("Platform error: {0}")]
    Platform(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("Internal error: {0}")]
    Internal(String),
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
