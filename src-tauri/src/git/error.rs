//! Typed error surface for the Source Control subsystem.
//!
//! Unlike most of our commands (which return `Result<T, String>`), the git
//! panel needs to drive *distinct* UI per failure mode — a merge conflict
//! opens the conflict editor, an auth failure shows a credential CTA, a
//! not-a-repo state offers "Open Folder", a dirty tree blocks a checkout.
//! A tagged enum lets the renderer `switch (err.kind)` instead of
//! locale-fragile substring sniffing on a flat string.
//!
//! The serde shape is `{ "kind": "...", "detail": "..." }`. Every `detail`
//! is passed through [`crate::git::exec::redact`] before it leaves the
//! backend so a credentialed remote URL never lands in renderer logs.

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum GitError {
    #[error("not a git repository: {0}")]
    NotARepo(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("working tree has uncommitted changes: {0}")]
    DirtyWorkingTree(String),

    #[error("merge conflict: {0}")]
    MergeConflict(String),

    #[error("authentication required: {0}")]
    AuthRequired(String),

    #[error("network operation failed: {0}")]
    NetworkFailed(String),

    #[error("could not apply patch: {0}")]
    PatchFailed(String),

    #[error("repository is locked: {0}")]
    LockHeld(String),

    #[error("git is not installed or not on PATH")]
    GitNotInstalled,

    #[error("libgit2 error: {0}")]
    Libgit2(String),

    #[error("git command failed: {0}")]
    CommandFailed(String),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),
}

pub type Result<T> = std::result::Result<T, GitError>;

impl From<git2::Error> for GitError {
    fn from(err: git2::Error) -> Self {
        use git2::ErrorCode;
        match err.code() {
            ErrorCode::NotFound => GitError::NotFound(err.message().to_string()),
            ErrorCode::Locked => GitError::LockHeld(err.message().to_string()),
            ErrorCode::Conflict | ErrorCode::Unmerged => {
                GitError::MergeConflict(err.message().to_string())
            }
            _ => GitError::Libgit2(err.message().to_string()),
        }
    }
}

/// Flat-string interop for any caller that still expects `Result<T, String>`.
impl From<GitError> for String {
    fn from(err: GitError) -> Self {
        err.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_kind_and_detail() {
        let json = serde_json::to_value(GitError::NotARepo("/tmp/x".into())).unwrap();
        assert_eq!(json["kind"], "notARepo");
        assert_eq!(json["detail"], "/tmp/x");
    }

    #[test]
    fn git_not_installed_has_no_detail() {
        let json = serde_json::to_value(GitError::GitNotInstalled).unwrap();
        assert_eq!(json["kind"], "gitNotInstalled");
        assert!(json.get("detail").is_none());
    }

    #[test]
    fn maps_libgit2_not_found() {
        let err = git2::Error::new(
            git2::ErrorCode::NotFound,
            git2::ErrorClass::Repository,
            "no such ref",
        );
        match GitError::from(err) {
            GitError::NotFound(msg) => assert!(msg.contains("no such ref")),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn maps_libgit2_conflict() {
        let err = git2::Error::new(
            git2::ErrorCode::Conflict,
            git2::ErrorClass::Merge,
            "checkout conflict",
        );
        assert!(matches!(GitError::from(err), GitError::MergeConflict(_)));
    }

    #[test]
    fn into_string_uses_display() {
        let s: String = GitError::GitNotInstalled.into();
        assert!(s.contains("not installed"));
    }
}
