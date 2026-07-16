//! Wire DTOs shared with the renderer-side seam (`types/git/index.ts`).
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffStat {
    /// Final repo-relative path, normalized to forward slashes.
    pub path: String,
    pub insertions: usize,
    pub deletions: usize,
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

/// One entry from `git worktree list --porcelain`. Used by the agent-team
/// per-dispatch isolation layer to enumerate the worktrees allocated for a run
/// (branch names encode `agent/<runId>/<teammate>/<taskId>`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    /// Absolute path of the worktree's working directory.
    pub path: String,
    /// Short branch name checked out (e.g. `agent/run_x/alice/t1`), or `None`
    /// when the worktree is in a detached-HEAD state.
    pub branch: Option<String>,
    /// HEAD commit SHA, or `None` for a freshly-`add`ed worktree with no commit.
    pub head: Option<String>,
    /// `true` for the repository's main worktree (always listed first by git).
    pub is_main: bool,
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

/// A tag ref: name, the commit it points at, and (for annotated tags) message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTag {
    pub name: String,
    pub target_hash: String,
    pub message: Option<String>,
    pub is_annotated: bool,
}

/// Classification of a ref decoration for the commit graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitRefKind {
    Branch,
    RemoteBranch,
    Tag,
    Head,
}

/// A ref pointing at a commit, used to decorate the commit graph rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    pub name: String,
    pub kind: GitRefKind,
    pub target_hash: String,
}

/// Interactive-rebase action for a single commit (mirrors git's todo verbs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RebaseAction {
    Pick,
    Reword,
    Squash,
    Fixup,
    Drop,
}

/// One row of an interactive-rebase plan, in final (top→bottom) order.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodoEntry {
    pub sha: String,
    pub action: RebaseAction,
    /// New message for `reword` (collected up-front in the dialog).
    pub message: Option<String>,
}

/// One blamed line: which commit last touched it, author, time, and content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    pub line_number: u32,
    pub commit_hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub authored_at_ms: i64,
    pub summary: String,
    pub content: String,
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
