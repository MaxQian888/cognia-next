//! One error type with a stable wire code.
//!
//! The command shells reject with the `{ code, message, retryable }` envelope
//! and the companion RPC with a problem document carrying the same code, so
//! the renderer maps the code to a sentence without parsing prose. Codes are part of the contract: the TS client
//! (`lib/filespace/grants-client.ts`) lists them.

use std::fmt;

/// Result alias for this crate.
pub type FileShareResult<T> = Result<T, FileShareError>;

/// A refused or failed file-share operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileShareError {
    /// Stable machine-readable reason.
    pub code: &'static str,
    /// Human-readable detail for logs and developer tools.
    pub message: String,
}

impl FileShareError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// No account is active, so there is no store to serve from.
    pub fn locked() -> Self {
        Self::new(
            "file_share_locked",
            "no account is active on this host; unlock it first",
        )
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }

    pub fn store(error: impl fmt::Display) -> Self {
        Self::new("store_failed", error.to_string())
    }
}

impl fmt::Display for FileShareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for FileShareError {}

impl From<rusqlite::Error> for FileShareError {
    fn from(error: rusqlite::Error) -> Self {
        Self::store(error)
    }
}

impl From<FileShareError> for String {
    fn from(error: FileShareError) -> Self {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_form_leads_with_the_code() {
        let error = FileShareError::new("policy_live_disabled", "live access is off");
        assert_eq!(error.to_string(), "policy_live_disabled: live access is off");
        let wire: String = error.into();
        assert!(wire.starts_with("policy_live_disabled: "));
        assert_eq!(FileShareError::locked().code, "file_share_locked");
    }
}
