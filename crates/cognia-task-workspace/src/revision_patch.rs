//! Revision-bound compare-and-swap apply, confined reads, and report
//! extraction for a workspace root (ADR-0188 B4: DEL-04, DEL-05).
//!
//! # Why this is not the ledger's apply
//!
//! [`crate::service::TaskWorkspaceService::apply_patch_set`] merges: a task's
//! patch is three-way merged into the live workspace so a user's unrelated
//! edit survives. That is the right behaviour for a chat turn's own
//! workspace, and the wrong one for the delegate's `workspace_updated`
//! delivery, which the user approves against one reviewed diff at one
//! revision. There the contract is a compare-and-swap: the workspace is still
//! at the revision the patch was cut from, or **nothing is written at all**
//! (DEL-04). A merge would silently deliver something nobody reviewed.
//!
//! # What a revision is
//!
//! `wsrev1:<sha256>` over the workspace snapshot the rest of this crate
//! already captures: every file and symlink Git would show (ignored files,
//! `.git` and `node_modules` excluded), each contributing its path, kind,
//! content hash and executable bit. In a Git worktree the content hash is the
//! blob id Git already computed, so a revision costs two `git` calls rather
//! than a full read of the tree.
//!
//! Two consequences worth stating rather than discovering:
//!
//! * a revision covers exactly what the snapshot covers. A file the snapshot
//!   ignores cannot be compare-and-swapped, so a patch that would overwrite
//!   an existing ignored file is refused (`PATH_NOT_COVERED`) instead of
//!   being written under a guarantee that does not hold;
//! * committing a file without changing its bytes moves it from the dirty
//!   overlay into the tree listing. The bytes hash identically either way, so
//!   the revision does not change. Switching a repository between Git-backed
//!   and walk-backed capture (the first commit, a removed `.git`) does change
//!   the hash space, and the apply then reports a conflict rather than a
//!   match — the conservative direction.
//!
//! # Ordering
//!
//! Validate → resolve every path under [`crate::confine`] → capture the
//! revision → compare → verify each target is byte-identical to what the
//! snapshot recorded → stage every write to a sibling temp file → publish by
//! rename. A failure at any point unwinds what was published, so a refused
//! or conflicted apply leaves every file byte-identical.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::confine::{
    normalize_workspace_path, ConfinedRoot, ConfinedTarget, PathPurpose, TargetKind,
    WorkspaceRefusal, WorkspaceRefusalCode,
};
use crate::snapshot::{EntryKind, WorkspaceSnapshot};
use crate::ResourceTrackingPolicy;

/// The patch format the delegate workflow mints
/// (`packages/router-fusion/src/workflows/delegate-ports.ts`).
pub const REVISION_PATCH_FORMAT: &str = "cognia-delegate-patch-1";

/// The revision scheme this module mints and accepts.
pub const REVISION_SCHEME: &str = "wsrev1";

/// Bounds of one patch, mirroring `DELEGATE_PATCH_LIMITS` on the package side.
pub const MAX_PATCH_FILES: usize = 64;
pub const MAX_PATCH_FILE_BYTES: usize = 256 * 1024;
pub const MAX_PATCH_TOTAL_BYTES: usize = 1024 * 1024;

/// Bytes a confined text read returns when the caller names no limit, and the
/// ceiling it may name. The default matches `WORKSPACE_READ_MAX_BYTES` in
/// `lib/router-fusion/tools/workspace-read.ts`.
pub const DEFAULT_CONFINED_READ_BYTES: u64 = 64_000;
pub const MAX_CONFINED_READ_BYTES: u64 = 1024 * 1024;

/// Bytes an acceptance report may have. A report is parsed whole — a cut
/// JUnit file is not a smaller report, it is a parse error — so the cap
/// refuses rather than truncates.
pub const DEFAULT_REPORT_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_REPORT_BYTES: u64 = 32 * 1024 * 1024;

/// Entries a listing returns when the caller names no limit.
pub const DEFAULT_LIST_LIMIT: usize = 500;
pub const MAX_LIST_LIMIT: usize = 5_000;

// ── wire types ───────────────────────────────────────────────────────────────

/// What one entry of a patch does to one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RevisionPatchAction {
    Write,
    Delete,
}

/// One file of a patch: the whole new content, or its deletion. Field names
/// are the package's (`snake_case`), so the JSON a worker produced travels to
/// this host unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct RevisionPatchFile {
    pub path: String,
    pub action: RevisionPatchAction,
    /// The whole new file content for a write; `null` for a delete.
    pub content: Option<String>,
    /// SHA-256 of `content`, lowercase hex; `null` for a delete.
    pub content_sha256: Option<String>,
}

/// Whole-file writes and deletes against one base revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct RevisionPatch {
    pub format: String,
    pub base_revision: String,
    pub files: Vec<RevisionPatchFile>,
}

/// A workspace root's revision, and how many files it covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct WorkspaceRevision {
    pub revision: String,
    pub file_count: u64,
}

/// One file of a revision listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct RevisionFile {
    pub path: String,
    pub size_bytes: u64,
    pub symlink: bool,
}

/// The files of a revision, under a prefix, bounded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct RevisionFileList {
    pub revision: String,
    pub files: Vec<RevisionFile>,
    /// True when the limit cut the listing short.
    pub truncated: bool,
}

/// How an apply ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RevisionApplyStatus {
    /// Every file was written; `revision` is what the workspace is at now.
    Applied,
    /// The workspace had moved; nothing was written (DEL-04).
    Conflict,
    /// The patch was refused before anything was written (DEL-05, limits).
    Refused,
}

/// The outcome of [`apply_revision_patch`]. One shape for all three endings so
/// a caller cannot read a conflict as a failure to apply for another reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct RevisionApplyOutcome {
    pub status: RevisionApplyStatus,
    /// The revision the patch declared it was cut from.
    pub base_revision: String,
    /// `applied`: the revision after the write. `conflict`: the revision the
    /// workspace is actually at. `refused`: null.
    pub current_revision: Option<String>,
    /// Paths written, in patch order. Empty unless `applied`.
    pub written: Vec<String>,
    /// Paths deleted, in patch order. Empty unless `applied`.
    pub deleted: Vec<String>,
    /// Why the patch was refused. `null` unless `refused`.
    pub refusal: Option<WorkspaceRefusal>,
}

impl RevisionApplyOutcome {
    fn refused(base_revision: &str, refusal: WorkspaceRefusal) -> Self {
        Self {
            status: RevisionApplyStatus::Refused,
            base_revision: base_revision.to_string(),
            current_revision: None,
            written: Vec::new(),
            deleted: Vec::new(),
            refusal: Some(refusal),
        }
    }

    fn conflict(base_revision: &str, current: String) -> Self {
        Self {
            status: RevisionApplyStatus::Conflict,
            base_revision: base_revision.to_string(),
            current_revision: Some(current),
            written: Vec::new(),
            deleted: Vec::new(),
            refusal: None,
        }
    }
}

/// How a confined read ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConfinedReadStatus {
    Ok,
    /// Nothing is at the path. For an acceptance report this is the answer
    /// that matters: the command ended without writing one.
    Missing,
    /// Larger than the cap. A report is refused rather than cut.
    TooLarge,
    Refused,
}

/// A bounded read of one confined file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ConfinedFileRead {
    pub status: ConfinedReadStatus,
    /// The normalised path, when it survived normalisation.
    pub path: Option<String>,
    pub content: Option<String>,
    /// SHA-256 of the returned `content`.
    pub content_sha256: Option<String>,
    /// The file's size on disk, whatever was returned.
    pub size_bytes: u64,
    /// True when `content` stops before the end of the file.
    pub truncated: bool,
    pub refusal: Option<WorkspaceRefusal>,
}

impl ConfinedFileRead {
    fn refused(path: Option<String>, refusal: WorkspaceRefusal) -> Self {
        Self {
            status: ConfinedReadStatus::Refused,
            path,
            content: None,
            content_sha256: None,
            size_bytes: 0,
            truncated: false,
            refusal: Some(refusal),
        }
    }
}

// ── revisions ────────────────────────────────────────────────────────────────

/// The revision of `root` right now.
pub fn workspace_revision(root: &Path) -> Result<WorkspaceRevision, String> {
    let confined = ConfinedRoot::open(root)?;
    let snapshot = capture(confined.path())?;
    Ok(WorkspaceRevision {
        revision: revision_of(&snapshot),
        file_count: snapshot.entries.len() as u64,
    })
}

/// The files a revision covers, under `prefix`, in path order.
pub fn list_revision_files(
    root: &Path,
    prefix: &str,
    limit: Option<usize>,
) -> Result<RevisionFileList, String> {
    let confined = ConfinedRoot::open(root)?;
    let snapshot = capture(confined.path())?;
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
    let normalized = prefix.trim().replace('\\', "/");
    let normalized = normalized.trim_matches('/');
    let mut files = Vec::new();
    let mut truncated = false;
    for (path, entry) in &snapshot.entries {
        let matches = normalized.is_empty()
            || path == normalized
            || path.starts_with(&format!("{normalized}/"));
        if !matches {
            continue;
        }
        if files.len() == limit {
            truncated = true;
            break;
        }
        files.push(RevisionFile {
            path: path.clone(),
            size_bytes: entry.size,
            symlink: entry.kind == EntryKind::Symlink,
        });
    }
    Ok(RevisionFileList {
        revision: revision_of(&snapshot),
        files,
        truncated,
    })
}

/// Why a capture could not produce a revision.
enum CaptureError {
    /// The workspace itself contains a symbolic link that leaves it. Such a
    /// tree has no honest revision: the linked content is not inside the
    /// workspace, so nothing here can promise what it holds. It is a refusal
    /// about the request, not a host fault.
    Escape(String),
    /// The host could not read the workspace.
    Failed(String),
}

impl From<CaptureError> for String {
    fn from(error: CaptureError) -> Self {
        match error {
            CaptureError::Escape(message) | CaptureError::Failed(message) => message,
        }
    }
}

fn capture(canonical_root: &Path) -> Result<WorkspaceSnapshot, CaptureError> {
    let policy = ResourceTrackingPolicy {
        generated_output_roots: Vec::new(),
        auto_detect: false,
    };
    match crate::snapshot::capture_with_policy(canonical_root, &policy) {
        Ok((snapshot, _blobs)) => Ok(snapshot),
        Err(message) if message.contains("escapes workspace") => Err(CaptureError::Escape(message)),
        Err(message) => Err(CaptureError::Failed(message)),
    }
}

/// `wsrev1:<sha256>` over every covered entry's path, kind, content hash and
/// executable bit.
///
/// Permission bits beyond the executable one are deliberately out: a umask or
/// a `chmod g+w` is not a change to the work, and a revision that moved for
/// one would turn every apply into a conflict.
fn revision_of(snapshot: &WorkspaceSnapshot) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"cognia-workspace-revision-1\n");
    for (path, entry) in &snapshot.entries {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(match entry.kind {
            EntryKind::File => b"f",
            EntryKind::Symlink => b"l",
        });
        hasher.update([0]);
        hasher.update(entry.hash.as_bytes());
        hasher.update([0]);
        hasher.update(if executable(entry.mode) { b"x" } else { b"-" });
        hasher.update([b'\n']);
    }
    format!("{REVISION_SCHEME}:{}", hex::encode(hasher.finalize()))
}

fn executable(mode: Option<u32>) -> bool {
    mode.is_some_and(|mode| mode & 0o111 != 0)
}

// ── compare-and-swap apply ───────────────────────────────────────────────────

/// One in-flight write or delete.
struct StagedFile {
    relative: String,
    target: PathBuf,
    action: RevisionPatchAction,
    /// The staged content of a write, already on disk beside its target.
    temp: Option<PathBuf>,
    /// Where the previous content was moved during publication.
    backup: Option<PathBuf>,
    published: bool,
}

/// Apply `patch` to `root` if and only if the workspace is still at the
/// patch's `base_revision`.
///
/// `Ok` covers all three endings — applied, conflict, refused — because each
/// is an answer about the request. `Err` is reserved for the host failing:
/// an unreadable root, a filesystem that refused a rename.
pub fn apply_revision_patch(
    root: &Path,
    patch: &RevisionPatch,
) -> Result<RevisionApplyOutcome, String> {
    let confined = ConfinedRoot::open(root)?;
    let lock = root_lock(confined.path());
    let _guard = lock.lock();

    if patch.format != REVISION_PATCH_FORMAT {
        return Ok(RevisionApplyOutcome::refused(
            &patch.base_revision,
            WorkspaceRefusal::about_request(
                WorkspaceRefusalCode::PatchFormat,
                format!(
                    "unknown patch format `{}`; this host applies `{REVISION_PATCH_FORMAT}`",
                    patch.format
                ),
            ),
        ));
    }
    if !patch
        .base_revision
        .starts_with(&format!("{REVISION_SCHEME}:"))
    {
        return Ok(RevisionApplyOutcome::refused(
            &patch.base_revision,
            WorkspaceRefusal::about_request(
                WorkspaceRefusalCode::PatchFormat,
                format!("`{}` is not a workspace revision", patch.base_revision),
            ),
        ));
    }
    if patch.files.len() > MAX_PATCH_FILES {
        return Ok(RevisionApplyOutcome::refused(
            &patch.base_revision,
            WorkspaceRefusal::about_request(
                WorkspaceRefusalCode::PatchLimit,
                format!(
                    "the patch touches {} files; at most {MAX_PATCH_FILES} are applied at once",
                    patch.files.len()
                ),
            ),
        ));
    }

    // 1. Validate and normalise every entry before touching the filesystem.
    let mut planned: Vec<(String, &RevisionPatchFile)> = Vec::with_capacity(patch.files.len());
    let mut seen: BTreeMap<String, ()> = BTreeMap::new();
    let mut total_bytes = 0usize;
    for file in &patch.files {
        let normalized = match normalize_workspace_path(&file.path, PathPurpose::Write) {
            Ok(value) => value,
            Err(refusal) => {
                return Ok(RevisionApplyOutcome::refused(&patch.base_revision, refusal))
            }
        };
        if seen.insert(normalized.clone(), ()).is_some() {
            return Ok(RevisionApplyOutcome::refused(
                &patch.base_revision,
                WorkspaceRefusal::new(
                    WorkspaceRefusalCode::PatchDuplicatePath,
                    &file.path,
                    "the patch names the same file twice",
                ),
            ));
        }
        match file.action {
            RevisionPatchAction::Write => {
                let Some(content) = file.content.as_ref() else {
                    return Ok(RevisionApplyOutcome::refused(
                        &patch.base_revision,
                        WorkspaceRefusal::new(
                            WorkspaceRefusalCode::PatchContentMismatch,
                            &file.path,
                            "a write carries no content",
                        ),
                    ));
                };
                if content.len() > MAX_PATCH_FILE_BYTES {
                    return Ok(RevisionApplyOutcome::refused(
                        &patch.base_revision,
                        WorkspaceRefusal::new(
                            WorkspaceRefusalCode::PatchLimit,
                            &file.path,
                            format!(
                                "the file is larger than the {MAX_PATCH_FILE_BYTES}-byte limit"
                            ),
                        ),
                    ));
                }
                total_bytes = total_bytes.saturating_add(content.len());
                if total_bytes > MAX_PATCH_TOTAL_BYTES {
                    return Ok(RevisionApplyOutcome::refused(
                        &patch.base_revision,
                        WorkspaceRefusal::about_request(
                            WorkspaceRefusalCode::PatchLimit,
                            format!(
                                "the patch is larger than the {MAX_PATCH_TOTAL_BYTES}-byte limit"
                            ),
                        ),
                    ));
                }
                let declared = file.content_sha256.as_deref().unwrap_or_default();
                let actual = hex::encode(Sha256::digest(content.as_bytes()));
                if declared != actual {
                    return Ok(RevisionApplyOutcome::refused(
                        &patch.base_revision,
                        WorkspaceRefusal::new(
                            WorkspaceRefusalCode::PatchContentMismatch,
                            &file.path,
                            "the declared content hash does not match the content",
                        ),
                    ));
                }
            }
            RevisionPatchAction::Delete => {
                if file.content.is_some() || file.content_sha256.is_some() {
                    return Ok(RevisionApplyOutcome::refused(
                        &patch.base_revision,
                        WorkspaceRefusal::new(
                            WorkspaceRefusalCode::PatchContentMismatch,
                            &file.path,
                            "a delete carries content",
                        ),
                    ));
                }
            }
        }
        planned.push((normalized, file));
    }

    // 2. Resolve every path against the filesystem. A symlink, a `..` the
    //    normaliser could not see, or a location outside the root stops the
    //    apply before a single byte is staged.
    let mut targets: Vec<ConfinedTarget> = Vec::with_capacity(planned.len());
    for (normalized, file) in &planned {
        match confined.resolve(normalized) {
            Ok(target) => {
                if target.kind == Some(TargetKind::Directory) {
                    return Ok(RevisionApplyOutcome::refused(
                        &patch.base_revision,
                        WorkspaceRefusal::new(
                            WorkspaceRefusalCode::PatchTargetExists,
                            &file.path,
                            "the path names a directory",
                        ),
                    ));
                }
                targets.push(target);
            }
            Err(refusal) => {
                return Ok(RevisionApplyOutcome::refused(&patch.base_revision, refusal))
            }
        }
    }

    // 3. The compare half of the swap.
    let snapshot = match capture(confined.path()) {
        Ok(snapshot) => snapshot,
        Err(CaptureError::Escape(message)) => {
            return Ok(RevisionApplyOutcome::refused(
                &patch.base_revision,
                WorkspaceRefusal::about_request(WorkspaceRefusalCode::PathEscape, message),
            ));
        }
        Err(CaptureError::Failed(message)) => return Err(message),
    };
    let current = revision_of(&snapshot);
    if current != patch.base_revision {
        return Ok(RevisionApplyOutcome::conflict(
            &patch.base_revision,
            current,
        ));
    }

    // 4. Every target must be exactly what the revision says it is. The
    //    revision already proved the whole tree, so this only narrows the
    //    window between the capture and the write.
    for ((normalized, file), target) in planned.iter().zip(&targets) {
        let entry = snapshot.entries.get(normalized);
        match (file.action, target.kind, entry) {
            (RevisionPatchAction::Delete, None, _) | (RevisionPatchAction::Delete, _, None) => {
                return Ok(RevisionApplyOutcome::refused(
                    &patch.base_revision,
                    WorkspaceRefusal::new(
                        WorkspaceRefusalCode::PatchTargetMissing,
                        &file.path,
                        "the file the patch deletes is not part of the base revision",
                    ),
                ));
            }
            (RevisionPatchAction::Write, Some(TargetKind::File), None) => {
                return Ok(RevisionApplyOutcome::refused(
                    &patch.base_revision,
                    WorkspaceRefusal::new(
                        WorkspaceRefusalCode::PathNotCovered,
                        &file.path,
                        "the file exists but the workspace revision does not cover it, so it \
                         cannot be compare-and-swapped",
                    ),
                ));
            }
            _ => {}
        }
        let Some(entry) = entry else { continue };
        if target.kind != Some(TargetKind::File) {
            continue;
        }
        if entry.kind != EntryKind::File {
            return Ok(RevisionApplyOutcome::refused(
                &patch.base_revision,
                WorkspaceRefusal::new(
                    WorkspaceRefusalCode::PathNotFile,
                    &file.path,
                    "the path names a symbolic link",
                ),
            ));
        }
        let bytes =
            fs::read(&target.path).map_err(|error| format!("read {}: {error}", target.relative))?;
        if hash_in(&bytes, &entry.hash)? != entry.hash {
            return Ok(RevisionApplyOutcome::conflict(
                &patch.base_revision,
                workspace_revision(confined.path())?.revision,
            ));
        }
    }

    // 5. Stage, then publish. Everything after this point is undone on the
    //    first failure, so a half-applied patch never survives the call.
    let mut staged: Vec<StagedFile> = Vec::with_capacity(planned.len());
    let mut created_dirs: Vec<PathBuf> = Vec::new();
    let mut failure: Option<String> = None;

    for ((normalized, file), target) in planned.iter().zip(&targets) {
        let mut entry = StagedFile {
            relative: normalized.clone(),
            target: target.path.clone(),
            action: file.action,
            temp: None,
            backup: None,
            published: false,
        };
        if file.action == RevisionPatchAction::Write {
            match stage_write(
                confined.path(),
                target,
                file.content.as_deref().unwrap_or_default(),
                &mut created_dirs,
            ) {
                Ok(temp) => entry.temp = Some(temp),
                Err(error) => {
                    failure = Some(error);
                    staged.push(entry);
                    break;
                }
            }
        }
        staged.push(entry);
    }

    if failure.is_none() {
        for entry in staged.iter_mut() {
            if let Err(error) = publish(entry) {
                failure = Some(error);
                break;
            }
        }
    }

    if let Some(error) = failure {
        unwind(&mut staged, &created_dirs);
        return Err(format!("revision patch could not be applied: {error}"));
    }

    for entry in &staged {
        if let Some(backup) = &entry.backup {
            let _ = fs::remove_file(backup);
        }
    }

    let written = staged
        .iter()
        .filter(|entry| entry.action == RevisionPatchAction::Write)
        .map(|entry| entry.relative.clone())
        .collect();
    let deleted = staged
        .iter()
        .filter(|entry| entry.action == RevisionPatchAction::Delete)
        .map(|entry| entry.relative.clone())
        .collect();
    Ok(RevisionApplyOutcome {
        status: RevisionApplyStatus::Applied,
        base_revision: patch.base_revision.clone(),
        current_revision: Some(workspace_revision(confined.path())?.revision),
        written,
        deleted,
        refusal: None,
    })
}

/// Hash `bytes` in the space `entry_hash` was written in: Git blob ids for a
/// Git-backed capture, SHA-256 for the walk.
fn hash_in(bytes: &[u8], entry_hash: &str) -> Result<String, String> {
    if entry_hash.len() == 40 {
        crate::snapshot::git_blob_hash(bytes, git2::ObjectFormat::Sha1)
    } else {
        Ok(hex::encode(Sha256::digest(bytes)))
    }
}

fn stage_write(
    root: &Path,
    target: &ConfinedTarget,
    content: &str,
    created_dirs: &mut Vec<PathBuf>,
) -> Result<PathBuf, String> {
    let parent = target
        .path
        .parent()
        .ok_or_else(|| format!("invalid target path: {}", target.relative))?;
    create_dirs(root, parent, created_dirs)?;
    let temp = parent.join(format!(".cognia-revision-{}.tmp", Uuid::now_v7()));
    let file = fs::File::create(&temp).map_err(|error| format!("stage write: {error}"))?;
    {
        use std::io::Write;
        let mut writer = std::io::BufWriter::new(&file);
        writer
            .write_all(content.as_bytes())
            .map_err(|error| format!("stage write: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("stage write: {error}"))?;
    }
    file.sync_all()
        .map_err(|error| format!("stage write: {error}"))?;
    copy_mode(&target.path, &temp)?;
    Ok(temp)
}

/// Create the missing directories of `parent`, recording what was created so
/// an unwind can remove exactly those.
fn create_dirs(root: &Path, parent: &Path, created: &mut Vec<PathBuf>) -> Result<(), String> {
    if parent.is_dir() {
        return Ok(());
    }
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| "the target's parent is outside the workspace".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        if current.is_dir() {
            continue;
        }
        fs::create_dir(&current)
            .map_err(|error| format!("create {}: {error}", current.display()))?;
        created.push(current.clone());
    }
    Ok(())
}

#[cfg(unix)]
fn copy_mode(from: &Path, to: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(from) else {
        return Ok(());
    };
    if !metadata.is_file() {
        return Ok(());
    }
    fs::set_permissions(to, metadata.permissions())
        .map_err(|error| format!("copy file mode: {error}"))
}

#[cfg(not(unix))]
fn copy_mode(_from: &Path, _to: &Path) -> Result<(), String> {
    Ok(())
}

fn publish(entry: &mut StagedFile) -> Result<(), String> {
    let exists = fs::symlink_metadata(&entry.target).is_ok();
    if exists {
        let parent = entry
            .target
            .parent()
            .ok_or_else(|| format!("invalid target path: {}", entry.relative))?;
        let backup = parent.join(format!(".cognia-revision-{}.bak", Uuid::now_v7()));
        fs::rename(&entry.target, &backup)
            .map_err(|error| format!("set aside {}: {error}", entry.relative))?;
        entry.backup = Some(backup);
    }
    if let Some(temp) = &entry.temp {
        fs::rename(temp, &entry.target)
            .map_err(|error| format!("publish {}: {error}", entry.relative))?;
    }
    entry.published = true;
    Ok(())
}

/// Put back everything a failed apply moved, newest first.
fn unwind(staged: &mut [StagedFile], created_dirs: &[PathBuf]) {
    for entry in staged.iter_mut().rev() {
        if entry.published {
            if entry.temp.is_some() {
                let _ = fs::remove_file(&entry.target);
            }
            if let Some(backup) = entry.backup.take() {
                let _ = fs::rename(&backup, &entry.target);
            }
            entry.published = false;
        } else if let Some(temp) = entry.temp.take() {
            let _ = fs::remove_file(temp);
        }
    }
    for directory in created_dirs.iter().rev() {
        let _ = fs::remove_dir(directory);
    }
}

/// One lock per canonical root, so two applies to the same workspace cannot
/// interleave their compare and their swap. The caller holds the returned
/// mutex for the whole apply.
fn root_lock(root: &Path) -> Arc<Mutex<()>> {
    static LOCKS: std::sync::OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
        std::sync::OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    locks
        .lock()
        .entry(root.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

// ── confined reads ───────────────────────────────────────────────────────────

/// Read one confined text file, bounded, for a model or a reviewer.
///
/// Over the limit the content is cut at a UTF-8 boundary and `truncated` says
/// so, which is what a preview wants. [`read_report_file`] is the other
/// answer, for a file that is parsed whole.
pub fn read_confined_text(
    root: &Path,
    rel_path: &str,
    max_bytes: Option<u64>,
) -> Result<ConfinedFileRead, String> {
    let limit = max_bytes
        .unwrap_or(DEFAULT_CONFINED_READ_BYTES)
        .clamp(1, MAX_CONFINED_READ_BYTES);
    read_confined(root, rel_path, limit, false)
}

/// Copy a declared acceptance report out of a sandbox worktree.
///
/// Refuses rather than truncates over the cap, refuses a symlinked report (a
/// command that wrote `report.xml -> ~/.aws/credentials` gets nothing), and
/// answers `missing` when the command wrote no report at all — which is the
/// input DEL-02 needs to call a run inconclusive rather than passed.
pub fn read_report_file(
    root: &Path,
    rel_path: &str,
    max_bytes: Option<u64>,
) -> Result<ConfinedFileRead, String> {
    let limit = max_bytes
        .unwrap_or(DEFAULT_REPORT_BYTES)
        .clamp(1, MAX_REPORT_BYTES);
    read_confined(root, rel_path, limit, true)
}

fn read_confined(
    root: &Path,
    rel_path: &str,
    limit: u64,
    whole: bool,
) -> Result<ConfinedFileRead, String> {
    let confined = ConfinedRoot::open(root)?;
    let normalized = match normalize_workspace_path(rel_path, PathPurpose::Read) {
        Ok(value) => value,
        Err(refusal) => return Ok(ConfinedFileRead::refused(None, refusal)),
    };
    let opened = match confined.open_file(&normalized) {
        Ok(value) => value,
        Err(refusal) => {
            return Ok(ConfinedFileRead::refused(Some(normalized), refusal));
        }
    };
    let Some((mut file, size)) = opened else {
        return Ok(ConfinedFileRead {
            status: ConfinedReadStatus::Missing,
            path: Some(normalized),
            content: None,
            content_sha256: None,
            size_bytes: 0,
            truncated: false,
            refusal: None,
        });
    };
    if whole && size > limit {
        return Ok(ConfinedFileRead {
            status: ConfinedReadStatus::TooLarge,
            path: Some(normalized),
            content: None,
            content_sha256: None,
            size_bytes: size,
            truncated: false,
            refusal: None,
        });
    }
    // Read one byte past the limit so a file that grew between the stat and
    // the read is still reported as truncated rather than silently cut.
    let mut bytes = Vec::with_capacity(limit.min(size).min(MAX_REPORT_BYTES) as usize);
    file.by_ref()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read {normalized}: {error}"))?;
    let over = bytes.len() as u64 > limit;
    if whole && over {
        return Ok(ConfinedFileRead {
            status: ConfinedReadStatus::TooLarge,
            path: Some(normalized),
            content: None,
            content_sha256: None,
            size_bytes: size.max(bytes.len() as u64),
            truncated: false,
            refusal: None,
        });
    }
    if over {
        bytes.truncate(limit as usize);
    }
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => {
            if whole {
                return Ok(ConfinedFileRead::refused(
                    Some(normalized.clone()),
                    WorkspaceRefusal::new(
                        WorkspaceRefusalCode::NotText,
                        &normalized,
                        "the report is not valid UTF-8",
                    ),
                ));
            }
            // A cut multi-byte character at the boundary is the expected way
            // a preview ends; anything else is a binary file.
            let valid = error.utf8_error().valid_up_to();
            if !over || valid == 0 {
                return Ok(ConfinedFileRead::refused(
                    Some(normalized.clone()),
                    WorkspaceRefusal::new(
                        WorkspaceRefusalCode::NotText,
                        &normalized,
                        "the file is not valid UTF-8 text",
                    ),
                ));
            }
            let mut bytes = error.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).map_err(|_| format!("read {normalized}: invalid UTF-8"))?
        }
    };
    let hash = hex::encode(Sha256::digest(text.as_bytes()));
    Ok(ConfinedFileRead {
        status: ConfinedReadStatus::Ok,
        path: Some(normalized),
        content: Some(text),
        content_sha256: Some(hash),
        size_bytes: size,
        truncated: over,
        refusal: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn workspace() -> TempDir {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/a.ts"), "const a = 1\n").unwrap();
        fs::write(dir.path().join("src/b.ts"), "const b = 2\n").unwrap();
        fs::write(dir.path().join("README.md"), "# project\n").unwrap();
        dir
    }

    fn write(path: &str, content: &str) -> RevisionPatchFile {
        RevisionPatchFile {
            path: path.to_string(),
            action: RevisionPatchAction::Write,
            content: Some(content.to_string()),
            content_sha256: Some(hex::encode(Sha256::digest(content.as_bytes()))),
        }
    }

    fn delete(path: &str) -> RevisionPatchFile {
        RevisionPatchFile {
            path: path.to_string(),
            action: RevisionPatchAction::Delete,
            content: None,
            content_sha256: None,
        }
    }

    fn patch(base: &str, files: Vec<RevisionPatchFile>) -> RevisionPatch {
        RevisionPatch {
            format: REVISION_PATCH_FORMAT.to_string(),
            base_revision: base.to_string(),
            files,
        }
    }

    #[test]
    fn a_revision_is_stable_and_moves_with_content() {
        let dir = workspace();
        let first = workspace_revision(dir.path()).unwrap();
        assert!(first.revision.starts_with("wsrev1:"));
        assert_eq!(first.file_count, 3);
        assert_eq!(workspace_revision(dir.path()).unwrap(), first);

        fs::write(dir.path().join("src/a.ts"), "const a = 2\n").unwrap();
        assert_ne!(
            workspace_revision(dir.path()).unwrap().revision,
            first.revision
        );
    }

    #[test]
    fn applies_writes_deletes_and_new_directories_as_one_step() {
        let dir = workspace();
        let base = workspace_revision(dir.path()).unwrap().revision;
        let outcome = apply_revision_patch(
            dir.path(),
            &patch(
                &base,
                vec![
                    write("src/a.ts", "const a = 9\n"),
                    write("src/nested/deep/c.ts", "export {}\n"),
                    delete("src/b.ts"),
                ],
            ),
        )
        .unwrap();

        assert_eq!(outcome.status, RevisionApplyStatus::Applied);
        assert_eq!(outcome.written, vec!["src/a.ts", "src/nested/deep/c.ts"]);
        assert_eq!(outcome.deleted, vec!["src/b.ts"]);
        assert_eq!(
            fs::read_to_string(dir.path().join("src/a.ts")).unwrap(),
            "const a = 9\n"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("src/nested/deep/c.ts")).unwrap(),
            "export {}\n"
        );
        assert!(!dir.path().join("src/b.ts").exists());
        assert_eq!(
            outcome.current_revision.as_deref(),
            Some(workspace_revision(dir.path()).unwrap().revision.as_str())
        );
        // No staging artefact survives a successful apply.
        let leftovers: Vec<_> = fs::read_dir(dir.path().join("src"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".cognia-revision-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    /// [ACC:DEL-04] A patch cut from another revision is a conflict, and the
    /// workspace is byte-identical afterwards.
    #[test]
    fn a_stale_base_revision_conflicts_without_writing_anything() {
        let dir = workspace();
        let base = workspace_revision(dir.path()).unwrap().revision;
        // Somebody else edits the workspace after the patch was cut.
        fs::write(dir.path().join("README.md"), "# project (edited)\n").unwrap();
        let before: BTreeMap<String, String> = read_tree(dir.path());

        let outcome = apply_revision_patch(
            dir.path(),
            &patch(
                &base,
                vec![write("src/a.ts", "const a = 9\n"), delete("src/b.ts")],
            ),
        )
        .unwrap();

        assert_eq!(outcome.status, RevisionApplyStatus::Conflict);
        assert_eq!(outcome.base_revision, base);
        assert_eq!(
            outcome.current_revision,
            Some(workspace_revision(dir.path()).unwrap().revision)
        );
        assert!(outcome.written.is_empty() && outcome.deleted.is_empty());
        assert_eq!(read_tree(dir.path()), before);
    }

    /// [ACC:DEL-04] The conflict is decided per file too: an unrelated file
    /// that changed moves the revision, and a touched file that changed after
    /// the capture is caught before publication.
    #[test]
    fn an_unrelated_edit_is_still_a_conflict_rather_than_a_merge() {
        let dir = workspace();
        let base = workspace_revision(dir.path()).unwrap().revision;
        fs::write(dir.path().join("src/b.ts"), "const b = 3\n").unwrap();

        let outcome =
            apply_revision_patch(dir.path(), &patch(&base, vec![write("src/a.ts", "x\n")]))
                .unwrap();

        assert_eq!(outcome.status, RevisionApplyStatus::Conflict);
        assert_eq!(
            fs::read_to_string(dir.path().join("src/a.ts")).unwrap(),
            "const a = 1\n"
        );
    }

    /// [ACC:DEL-05] `..`, absolute paths, credential names and `.git` are
    /// refused before the capture, and nothing lands outside the workspace.
    #[test]
    fn traversal_absolute_and_credential_paths_are_refused_and_write_nothing() {
        let dir = workspace();
        let base = workspace_revision(dir.path()).unwrap().revision;

        for (file, code) in [
            (
                write("../escaped.txt", "x"),
                WorkspaceRefusalCode::PathTraversal,
            ),
            (
                write("src/../../escaped.txt", "x"),
                WorkspaceRefusalCode::PathTraversal,
            ),
            (
                write("/etc/cognia-test", "x"),
                WorkspaceRefusalCode::PathAbsolute,
            ),
            (
                write("~/.ssh/authorized_keys", "x"),
                WorkspaceRefusalCode::PathAbsolute,
            ),
            (
                write(".env", "SECRET=1"),
                WorkspaceRefusalCode::PathSensitive,
            ),
            (
                write(".ssh/id_rsa", "x"),
                WorkspaceRefusalCode::PathSensitive,
            ),
            (
                write(".git/config", "[core]"),
                WorkspaceRefusalCode::PathExcluded,
            ),
        ] {
            let outcome =
                apply_revision_patch(dir.path(), &patch(&base, vec![file.clone()])).unwrap();
            assert_eq!(
                outcome.status,
                RevisionApplyStatus::Refused,
                "{} was not refused",
                file.path
            );
            assert_eq!(
                outcome.refusal.as_ref().map(|refusal| refusal.code),
                Some(code),
                "{}",
                file.path
            );
        }

        assert_eq!(workspace_revision(dir.path()).unwrap().revision, base);
        assert!(!dir.path().join(".env").exists());
    }

    /// [ACC:DEL-05] A symlink anywhere on a patch entry's path is refused,
    /// and the host file behind it keeps its bytes. This covers both halves:
    /// a link that already stands in the tree, and the only way a
    /// whole-file patch could make one — writing through an existing link.
    #[cfg(unix)]
    #[test]
    fn a_patch_neither_follows_nor_creates_a_symbolic_link() {
        let dir = workspace();
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("credentials");
        fs::write(&secret, "host secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        std::os::unix::fs::symlink(&secret, dir.path().join("src/link.ts")).unwrap();
        // Resolution happens before the capture, so a stale base is enough to
        // prove the path itself is what stopped the apply.
        let base = format!("{REVISION_SCHEME}:{}", "0".repeat(64));

        for file in [
            write("escape/credentials", "owned"),
            write("escape/planted.txt", "owned"),
            write("src/link.ts", "owned"),
            delete("src/link.ts"),
        ] {
            let outcome =
                apply_revision_patch(dir.path(), &patch(&base, vec![file.clone()])).unwrap();
            assert_eq!(
                outcome.refusal.as_ref().map(|refusal| refusal.code),
                Some(WorkspaceRefusalCode::PathSymlink),
                "{}",
                file.path
            );
        }

        assert_eq!(fs::read_to_string(&secret).unwrap(), "host secret");
        assert!(!outside.path().join("planted.txt").exists());
    }

    /// [ACC:DEL-05] A workspace that links out of itself has no honest
    /// revision, so it is refused rather than compare-and-swapped against a
    /// tree whose content is partly somewhere else.
    #[cfg(unix)]
    #[test]
    fn a_workspace_that_links_outside_itself_cannot_be_swapped() {
        let dir = workspace();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret"), "host secret").unwrap();
        let base = workspace_revision(dir.path()).unwrap().revision;
        std::os::unix::fs::symlink(outside.path().join("secret"), dir.path().join("peek.txt"))
            .unwrap();

        let error = workspace_revision(dir.path()).unwrap_err();
        assert!(error.contains("escapes workspace"), "{error}");

        let outcome =
            apply_revision_patch(dir.path(), &patch(&base, vec![write("src/a.ts", "x\n")]))
                .unwrap();
        assert_eq!(outcome.status, RevisionApplyStatus::Refused);
        assert_eq!(
            outcome.refusal.map(|refusal| refusal.code),
            Some(WorkspaceRefusalCode::PathEscape)
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("src/a.ts")).unwrap(),
            "const a = 1\n"
        );
    }

    #[test]
    fn a_patch_whose_hash_does_not_match_its_content_is_refused() {
        let dir = workspace();
        let base = workspace_revision(dir.path()).unwrap().revision;
        let mut bad = write("src/a.ts", "const a = 9\n");
        bad.content_sha256 = Some("0".repeat(64));
        let outcome = apply_revision_patch(dir.path(), &patch(&base, vec![bad])).unwrap();
        assert_eq!(
            outcome.refusal.map(|refusal| refusal.code),
            Some(WorkspaceRefusalCode::PatchContentMismatch)
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("src/a.ts")).unwrap(),
            "const a = 1\n"
        );
    }

    #[test]
    fn an_unknown_format_or_revision_scheme_is_refused_before_the_capture() {
        let dir = workspace();
        let base = workspace_revision(dir.path()).unwrap().revision;
        let mut foreign = patch(&base, vec![write("src/a.ts", "x")]);
        foreign.format = "unified-diff".into();
        assert_eq!(
            apply_revision_patch(dir.path(), &foreign)
                .unwrap()
                .refusal
                .map(|refusal| refusal.code),
            Some(WorkspaceRefusalCode::PatchFormat)
        );

        let stale = patch("sha256:deadbeef", vec![write("src/a.ts", "x")]);
        assert_eq!(
            apply_revision_patch(dir.path(), &stale)
                .unwrap()
                .refusal
                .map(|refusal| refusal.code),
            Some(WorkspaceRefusalCode::PatchFormat)
        );
    }

    #[test]
    fn deleting_a_file_the_base_revision_does_not_have_is_refused() {
        let dir = workspace();
        let base = workspace_revision(dir.path()).unwrap().revision;
        let outcome =
            apply_revision_patch(dir.path(), &patch(&base, vec![delete("src/gone.ts")])).unwrap();
        assert_eq!(
            outcome.refusal.map(|refusal| refusal.code),
            Some(WorkspaceRefusalCode::PatchTargetMissing)
        );
    }

    #[test]
    fn the_patch_limits_are_hard() {
        let dir = workspace();
        let base = workspace_revision(dir.path()).unwrap().revision;
        let many: Vec<_> = (0..=MAX_PATCH_FILES)
            .map(|index| write(&format!("src/gen/{index}.ts"), "x"))
            .collect();
        assert_eq!(
            apply_revision_patch(dir.path(), &patch(&base, many))
                .unwrap()
                .refusal
                .map(|refusal| refusal.code),
            Some(WorkspaceRefusalCode::PatchLimit)
        );

        let huge = write("src/big.ts", &"x".repeat(MAX_PATCH_FILE_BYTES + 1));
        assert_eq!(
            apply_revision_patch(dir.path(), &patch(&base, vec![huge]))
                .unwrap()
                .refusal
                .map(|refusal| refusal.code),
            Some(WorkspaceRefusalCode::PatchLimit)
        );

        let duplicated = patch(
            &base,
            vec![write("src/a.ts", "one"), write("./src/a.ts", "two")],
        );
        assert_eq!(
            apply_revision_patch(dir.path(), &duplicated)
                .unwrap()
                .refusal
                .map(|refusal| refusal.code),
            Some(WorkspaceRefusalCode::PatchDuplicatePath)
        );
    }

    #[test]
    fn lists_the_files_a_revision_covers_under_a_prefix() {
        let dir = workspace();
        let listing = list_revision_files(dir.path(), "src", None).unwrap();
        assert_eq!(
            listing
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/a.ts", "src/b.ts"]
        );
        assert!(!listing.truncated);
        assert_eq!(
            listing.revision,
            workspace_revision(dir.path()).unwrap().revision
        );

        let bounded = list_revision_files(dir.path(), "", Some(1)).unwrap();
        assert_eq!(bounded.files.len(), 1);
        assert!(bounded.truncated);
    }

    /// [ACC:DEL-04] The unwind is what makes "nothing is written" true when a
    /// publish fails halfway — the filesystem rarely obliges a test by
    /// failing a rename, so the rollback is exercised directly: two files
    /// published, one staged, then undone.
    #[test]
    fn the_unwind_restores_every_file_a_half_finished_publish_moved() {
        let dir = workspace();
        let root = ConfinedRoot::open(dir.path()).unwrap();
        let before = read_tree(root.path());

        let overwrite = root.resolve("src/a.ts").unwrap();
        let removal = root.resolve("src/b.ts").unwrap();
        let addition = root.resolve("src/new/c.ts").unwrap();
        let mut created_dirs = Vec::new();

        let mut staged = vec![
            StagedFile {
                relative: overwrite.relative.clone(),
                target: overwrite.path.clone(),
                action: RevisionPatchAction::Write,
                temp: Some(
                    stage_write(root.path(), &overwrite, "replaced\n", &mut created_dirs).unwrap(),
                ),
                backup: None,
                published: false,
            },
            StagedFile {
                relative: removal.relative.clone(),
                target: removal.path.clone(),
                action: RevisionPatchAction::Delete,
                temp: None,
                backup: None,
                published: false,
            },
            StagedFile {
                relative: addition.relative.clone(),
                target: addition.path.clone(),
                action: RevisionPatchAction::Write,
                temp: Some(
                    stage_write(root.path(), &addition, "added\n", &mut created_dirs).unwrap(),
                ),
                backup: None,
                published: false,
            },
        ];

        publish(&mut staged[0]).unwrap();
        publish(&mut staged[1]).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("src/a.ts")).unwrap(),
            "replaced\n"
        );
        assert!(!dir.path().join("src/b.ts").exists());
        assert_eq!(
            created_dirs,
            vec![dir.path().canonicalize().unwrap().join("src/new")]
        );

        unwind(&mut staged, &created_dirs);

        assert_eq!(read_tree(root.path()), before);
        assert!(!dir.path().join("src/new").exists());
        let leftovers: Vec<_> = fs::read_dir(dir.path().join("src"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".cognia-revision-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_confined_read_is_bounded_and_hashed() {
        let dir = workspace();
        let read = read_confined_text(dir.path(), "src/a.ts", Some(5)).unwrap();
        assert_eq!(read.status, ConfinedReadStatus::Ok);
        assert_eq!(read.content.as_deref(), Some("const"));
        assert!(read.truncated);
        assert_eq!(
            read.content_sha256,
            Some(hex::encode(Sha256::digest(b"const")))
        );
        assert_eq!(read.size_bytes, 12);

        let missing = read_confined_text(dir.path(), "src/nope.ts", None).unwrap();
        assert_eq!(missing.status, ConfinedReadStatus::Missing);
    }

    /// [ACC:DEL-05] A read refuses the same escapes an apply does.
    #[cfg(unix)]
    #[test]
    fn a_confined_read_refuses_traversal_and_links() {
        let dir = workspace();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret"), "host secret").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), dir.path().join("peek")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("out")).unwrap();

        for (path, code) in [
            ("../secret", WorkspaceRefusalCode::PathTraversal),
            ("/etc/passwd", WorkspaceRefusalCode::PathAbsolute),
            ("peek", WorkspaceRefusalCode::PathSymlink),
            ("out/secret", WorkspaceRefusalCode::PathSymlink),
            (".ssh/id_rsa", WorkspaceRefusalCode::PathSensitive),
        ] {
            let read = read_confined_text(dir.path(), path, None).unwrap();
            assert_eq!(read.status, ConfinedReadStatus::Refused, "{path}");
            assert_eq!(
                read.refusal.map(|refusal| refusal.code),
                Some(code),
                "{path}"
            );
        }
    }

    #[test]
    fn a_report_is_refused_over_its_cap_rather_than_cut() {
        let dir = workspace();
        fs::write(dir.path().join("report.xml"), "<testsuite/>").unwrap();
        let ok = read_report_file(dir.path(), "report.xml", Some(1024)).unwrap();
        assert_eq!(ok.status, ConfinedReadStatus::Ok);
        assert_eq!(ok.content.as_deref(), Some("<testsuite/>"));

        let capped = read_report_file(dir.path(), "report.xml", Some(4)).unwrap();
        assert_eq!(capped.status, ConfinedReadStatus::TooLarge);
        assert_eq!(capped.content, None);

        let missing = read_report_file(dir.path(), "reports/none.json", None).unwrap();
        assert_eq!(missing.status, ConfinedReadStatus::Missing);
    }

    /// [ACC:DEL-05] The report a sandboxed command declared is read out of
    /// the worktree, and a command that pointed it at a host secret gets
    /// nothing.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_report_is_refused_rather_than_followed() {
        let dir = workspace();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("credentials"), "host secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("credentials"),
            dir.path().join("report.xml"),
        )
        .unwrap();

        let read = read_report_file(dir.path(), "report.xml", None).unwrap();
        assert_eq!(read.status, ConfinedReadStatus::Refused);
        assert_eq!(
            read.refusal.map(|refusal| refusal.code),
            Some(WorkspaceRefusalCode::PathSymlink)
        );
        assert_eq!(read.content, None);
    }

    #[test]
    fn a_binary_file_is_not_text() {
        let dir = workspace();
        fs::write(dir.path().join("asset.bin"), [0xff, 0xfe, 0x00]).unwrap();
        let read = read_confined_text(dir.path(), "asset.bin", None).unwrap();
        assert_eq!(read.status, ConfinedReadStatus::Refused);
        assert_eq!(
            read.refusal.map(|refusal| refusal.code),
            Some(WorkspaceRefusalCode::NotText)
        );
    }

    fn read_tree(root: &Path) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(directory) = stack.pop() {
            for entry in fs::read_dir(&directory).unwrap().flatten() {
                let path = entry.path();
                let kind = entry.file_type().unwrap();
                if kind.is_dir() {
                    stack.push(path);
                } else if kind.is_file() {
                    let relative = path
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned();
                    out.insert(relative, fs::read_to_string(&path).unwrap_or_default());
                }
            }
        }
        out
    }
}
