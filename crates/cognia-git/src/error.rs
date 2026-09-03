//! Typed error surface for the Source Control subsystem.
//!
//! Unlike most of our commands (which return `Result<T, String>`), the git
//! panel needs to drive *distinct* UI per failure mode — a merge conflict
//! opens the conflict editor, an auth failure shows a credential CTA, a
//! not-a-repo state offers "Open Folder", a dirty tree blocks a checkout.
//! A tagged enum lets the renderer `switch (err.kind)` instead of
//! locale-fragile substring sniffing on a flat string.
//!
//! The serde shape is `{ "kind": "...", "detail": "..." }`. Every `detail` is
//! a [`Detail`], which strips embedded credentials at BOTH serialization and
//! `Display` time — so a credentialed remote URL never lands in renderer logs
//! or in the `Result<T, String>` interop path, no matter which construction
//! site produced the error.

use serde::{Serialize, Serializer};
use thiserror::Error;

/// A redaction-guaranteed error detail string.
///
/// The invariant "a credentialed remote URL never leaves the backend" is
/// enforced *structurally* here rather than at each construction site: the
/// inner string is private, so the only way to build a `Detail` is via
/// `From<String>`/`From<&str>`, and both `Serialize` and `Display` run it
/// through [`crate::exec::redact`]. A future `GitError` variant or a direct
/// `CommandFailed(format!(...))` therefore cannot leak a token by accident.
#[derive(Debug, Clone)]
pub struct Detail(String);

impl From<String> for Detail {
    fn from(s: String) -> Self {
        Detail(s)
    }
}

impl From<&str> for Detail {
    fn from(s: &str) -> Self {
        Detail(s.to_string())
    }
}

impl std::fmt::Display for Detail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&crate::exec::redact(&self.0))
    }
}

impl Serialize for Detail {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&crate::exec::redact(&self.0))
    }
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum GitError {
    #[error("not a git repository: {0}")]
    NotARepo(Detail),

    #[error("not found: {0}")]
    NotFound(Detail),

    #[error("working tree has uncommitted changes: {0}")]
    DirtyWorkingTree(Detail),

    #[error("merge conflict: {0}")]
    MergeConflict(Detail),

    /// `git switch` / `git checkout` refusing a branch another worktree holds.
    ///
    /// Its own variant rather than `CommandFailed` because it is the one git
    /// refusal a caller can act on without the user resolving anything: the
    /// branch exists and is fine, it simply lives elsewhere, so the answer is
    /// to go there.
    #[error("branch is checked out in another worktree: {0}")]
    BranchCheckedOutElsewhere(Detail),

    /// `git branch -d` refusing a branch with unmerged commits.
    ///
    /// Distinct so a caller can offer the `-D` escalation as a question. As
    /// `CommandFailed` it read as a dead end, and the only way past it was to
    /// leave the app.
    #[error("branch is not fully merged: {0}")]
    BranchNotFullyMerged(Detail),

    #[error("authentication required: {0}")]
    AuthRequired(Detail),

    #[error("git commit identity is required: {0}")]
    IdentityRequired(Detail),

    #[error("network operation failed: {0}")]
    NetworkFailed(Detail),

    #[error("could not apply patch: {0}")]
    PatchFailed(Detail),

    #[error("repository is locked: {0}")]
    LockHeld(Detail),

    #[error("git is not installed or not on PATH")]
    GitNotInstalled,

    #[error("libgit2 error: {0}")]
    Libgit2(Detail),

    #[error("git command failed: {0}")]
    CommandFailed(Detail),

    #[error("invalid argument: {0}")]
    InvalidArgument(Detail),
}

pub type Result<T> = std::result::Result<T, GitError>;

impl From<git2::Error> for GitError {
    fn from(err: git2::Error) -> Self {
        use git2::ErrorCode;
        match err.code() {
            ErrorCode::NotFound => GitError::NotFound(err.message().into()),
            ErrorCode::Locked => GitError::LockHeld(err.message().into()),
            ErrorCode::Conflict | ErrorCode::Unmerged => {
                GitError::MergeConflict(err.message().into())
            }
            _ => GitError::Libgit2(err.message().into()),
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
            GitError::NotFound(msg) => assert!(msg.0.contains("no such ref")),
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

    #[test]
    fn detail_redacts_credentialed_url_via_serde() {
        // A detail can arrive with an embedded credential regardless of the
        // construction path — here a direct `Libgit2(...)`.
        let raw = "fatal: unable to access 'https://alice:ghp_secret@github.com/o/r.git'";
        let json = serde_json::to_value(GitError::Libgit2(raw.into())).unwrap();
        let detail = json["detail"].as_str().unwrap();
        assert!(
            !detail.contains("ghp_secret"),
            "token leaked in serde: {detail}"
        );
        assert!(detail.contains("<redacted>"));
    }

    #[test]
    fn detail_redacts_credentialed_url_via_display_interop() {
        // The `Result<T, String>` interop path goes through Display, which must
        // redact too — a direct `CommandFailed(format!(...))` here.
        let raw = "remote: https://bob:ghp_secret@example.com/x.git rejected";
        let s: String = GitError::CommandFailed(raw.into()).into();
        assert!(!s.contains("ghp_secret"), "token leaked in Display: {s}");
        assert!(s.contains("<redacted>"));
    }
}
