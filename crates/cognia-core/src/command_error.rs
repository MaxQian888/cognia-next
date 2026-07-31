//! Structured error envelope for `#[tauri::command]` rejections.
//!
//! Most commands in this crate reject with a plain `String`, which forces the
//! renderer to string-match messages. `CommandError` serializes as the object
//! `{ "code": "...", "message": "...", "retryable": bool }` — the same shape
//! the companion HTTP API already exposes (`companion_api::error::ApiError`) —
//! so the TS side (`lib/tauri/command-error.ts` `parseInvokeError`) gets
//! machine-actionable, retry-aware errors.
//!
//! Migration is incremental: the scheduler commands are the first adopters.
//! `parseInvokeError` tolerates legacy plain-string rejections, so commands
//! can move over one module at a time.
//!
//! NOTE: `plugin_api::error::PluginError` intentionally still serializes to a
//! plain string — several `lib/plugin/**` catch sites string-match messages
//! (e.g. `storage-api.ts` "storage limit"), so flipping its wire shape needs a
//! coordinated renderer migration first.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Keep envelope messages bounded (mirrors `scheduler::error`'s cap).
const MAX_MESSAGE_CHARS: usize = 512;
const TRUNCATED_SUFFIX: &str = "... (truncated)";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandError {
    /// Stable snake_case code the renderer can branch on.
    pub code: String,
    /// Human-readable detail (bounded to 512 chars).
    pub message: String,
    /// Whether retrying the same call may succeed (transient failure).
    pub retryable: bool,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: truncate_message(message.into()),
            retryable: false,
        }
    }

    /// Constructor for transient failures. No production caller yet — the
    /// scheduler maps retryability via `From<SchedulerError>` — but this is
    /// the intended entry point for the next command-module migrations.
    #[allow(dead_code)]
    pub fn retryable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            retryable: true,
            ..Self::new(code, message)
        }
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

fn truncate_message(message: String) -> String {
    if message.chars().count() <= MAX_MESSAGE_CHARS {
        return message;
    }
    let truncated: String = message.chars().take(MAX_MESSAGE_CHARS).collect();
    format!("{truncated}{TRUNCATED_SUFFIX}")
}

// ADR-0067 Phase 6 — `impl From<scheduler::SchedulerError> for CommandError`
// lives in `cognia-scheduling` (which owns SchedulerError) to keep this
// foundation crate free of any upward edge into the scheduler.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_a_three_key_object() {
        let err = CommandError::new("task_not_found", "no such task");
        let value = serde_json::to_value(&err).unwrap();
        let obj = value.as_object().unwrap();
        assert_eq!(obj.len(), 3);
        assert_eq!(obj["code"], "task_not_found");
        assert_eq!(obj["message"], "no such task");
        assert_eq!(obj["retryable"], false);
    }

    #[test]
    fn retryable_constructor_sets_the_flag() {
        let err = CommandError::retryable("timeout", "took too long");
        assert!(err.retryable);
    }

    #[test]
    fn display_is_code_colon_message() {
        let err = CommandError::new("io", "disk gone");
        assert_eq!(err.to_string(), "io: disk gone");
    }

    #[test]
    fn round_trips_through_json() {
        let err = CommandError::retryable("timeout", "slow");
        let json = serde_json::to_string(&err).unwrap();
        let back: CommandError = serde_json::from_str(&json).unwrap();
        assert_eq!(back, err);
    }

    #[test]
    fn long_messages_are_truncated() {
        let err = CommandError::new("internal", "x".repeat(2000));
        assert!(err.message.len() < 600);
        assert!(err.message.ends_with("... (truncated)"));
    }
}
