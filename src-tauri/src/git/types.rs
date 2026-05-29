//! Wire DTOs shared with the renderer-side seam (`lib/git/types.ts`).
//!
//! Every struct is `#[serde(rename_all = "camelCase")]` so the TypeScript
//! types mirror these 1:1. None of these carry logic — they are pure data
//! crossing the Tauri IPC boundary.

use serde::{Deserialize, Serialize};

/// Per-file change classification, mirroring VSCode's decoration letters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitFileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
    TypeChanged,
}

/// Which of the three VSCode change groups a file belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitStatusGroup {
    Staged,
    Changes,
    Merge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    /// Repo-relative path, forward slashes.
    pub path: String,
    /// Original path for renames; `None` otherwise.
    pub orig_path: Option<String>,
    pub status: GitFileStatus,
    pub staged: bool,
    pub group: GitStatusGroup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Short branch name, or `None` when HEAD is detached/unborn.
    pub branch: Option<String>,
    /// Upstream tracking ref (e.g. `origin/main`), if any.
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub staged: Vec<GitFileChange>,
    pub changes: Vec<GitFileChange>,
    pub merge: Vec<GitFileChange>,
    pub is_rebasing: bool,
    pub is_merging: bool,
}

/// One display line inside a hunk. `content` excludes the leading
/// origin character (`+`/`-`/space).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffLine {
    /// `"context"` | `"add"` | `"del"`.
    pub kind: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHunk {
    /// The `@@ -a,b +c,d @@` header line (trimmed of trailing newline).
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// A self-contained unified-diff patch for exactly this hunk — file
    /// header + the single `@@` block — ready to feed back to
    /// `git apply --cached`.
    pub patch: String,
    pub lines: Vec<GitDiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub path: String,
    /// Full original-side text for the Monaco DiffEditor.
    pub old_content: String,
    /// Full modified-side text for the Monaco DiffEditor.
    pub new_content: String,
    pub hunks: Vec<GitHunk>,
    pub is_binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashEntry {
    pub index: usize,
    pub message: String,
    pub branch: Option<String>,
}

/// A single conflicted path with its three sides extracted from the index
/// stages. `base` is `None` for add/add conflicts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflict {
    pub path: String,
    pub ours: String,
    pub theirs: String,
    pub base: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub summary: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time in milliseconds since the Unix epoch.
    pub authored_at_ms: i64,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

/// Which operation, if any, the repo is in the middle of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoState {
    pub is_repo: bool,
    pub root_dir: Option<String>,
    pub detached_head: bool,
    pub operation_in_progress: Option<GitOperation>,
}

/// Result of a sync (pull + push) — the post-sync divergence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehind {
    pub ahead: usize,
    pub behind: usize,
}

/// How a single conflicted file should be resolved when the renderer does
/// not supply its own merged buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Ours,
    Theirs,
}
