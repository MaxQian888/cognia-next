//! ADR-0227 immutable changeset capture and head-bound review gates.

use crate::{resource::is_sensitive_resource, service::now_ms, store::WorkspaceStore, types::*};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ChangesetError {
    #[error("changeset {0} not found")]
    NotFound(String),
    #[error("workspace {0} is not an available Registry Git worktree")]
    InvalidWorkspace(String),
    #[error("a target branch is required")]
    TargetRequired,
    #[error("invalid target branch: {0}")]
    InvalidTarget(String),
    #[error("there are no changes to capture")]
    NothingToCapture,
    #[error("illegal changeset transition {from:?} → {to:?}")]
    IllegalTransition {
        from: ChangesetState,
        to: ChangesetState,
    },
    #[error("changeset {changeset_id} changed concurrently")]
    Conflict { changeset_id: String },
    #[error("stale changeset head: expected {expected}, got {actual}")]
    StaleHead { expected: String, actual: String },
    #[error("agent commit history contains sensitive paths: {paths:?}")]
    SensitiveHistory { paths: Vec<String> },
    #[error("agent edits conflict with the working-state overlay: {files:?}")]
    OverlayConflict { files: Vec<String> },
    #[error("working-state overlay capture requires git 2.38 or newer")]
    OverlayUnsupported,
    #[error("changeset cannot be recaptured in state {state:?}")]
    ChangesetState { state: ChangesetState },
    #[error("invalid changeset input: {0}")]
    InvalidInput(String),
    #[error("git error: {0}")]
    Git(String),
    #[error("store error: {0}")]
    Store(String),
    #[error("filesystem error: {0}")]
    Io(String),
}

impl ChangesetError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::InvalidWorkspace(_) => "invalid_workspace",
            Self::TargetRequired => "target_required",
            Self::InvalidTarget(_) => "invalid_target",
            Self::NothingToCapture => "nothing_to_capture",
            Self::IllegalTransition { .. } => "illegal_transition",
            Self::Conflict { .. } => "conflict",
            Self::StaleHead { .. } => "stale_head",
            Self::SensitiveHistory { .. } => "sensitive_history",
            Self::OverlayConflict { .. } => "overlay_conflict",
            Self::OverlayUnsupported => "overlay_unsupported",
            Self::ChangesetState { .. } => "changeset_state",
            Self::InvalidInput(_) => "invalid_input",
            Self::Git(_) => "git",
            Self::Store(_) => "store",
            Self::Io(_) => "io",
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, Self::Conflict { .. })
    }
}

pub fn validate_changeset_transition(
    from: ChangesetState,
    to: ChangesetState,
) -> Result<(), ChangesetError> {
    use ChangesetState::*;
    if matches!(
        (from, to),
        (Draft, Ready | Abandoned)
            | (Ready, Approved | ChangesRequested | Draft | Abandoned)
            | (Approved, Queued | Draft | ChangesRequested | Abandoned)
            | (ChangesRequested, Draft | Abandoned)
            | (Queued, Integrating | Approved | Draft | Abandoned)
            | (Integrating, Merged | Conflicted | Failed | Queued)
            | (Conflicted, Draft | Queued | Abandoned)
            | (Failed, Draft | Queued | Abandoned)
            | (Merged, RolledBack)
    ) {
        Ok(())
    } else {
        Err(ChangesetError::IllegalTransition { from, to })
    }
}

pub fn changeset_eligibility(changeset: &AgentChangeset) -> Result<(), Vec<EligibilityGap>> {
    let mut gaps = Vec::new();
    match &changeset.review {
        None => gaps.push(EligibilityGap::MissingReview),
        Some(review) => {
            if review.head_sha != changeset.head_sha {
                gaps.push(EligibilityGap::StaleHead);
            }
            if review.verdict != ChangesetReviewVerdict::Approve {
                gaps.push(EligibilityGap::ReviewNotApproved);
            }
            if review.requires_human_approval
                || review.verdict == ChangesetReviewVerdict::Unavailable
            {
                match &changeset.approval {
                    None => gaps.push(EligibilityGap::MissingHumanApproval),
                    Some(approval) if approval.head_sha != changeset.head_sha => {
                        gaps.push(EligibilityGap::StaleHead);
                        gaps.push(EligibilityGap::MissingHumanApproval);
                    }
                    Some(_) => {}
                }
            }
        }
    }
    for profile in &changeset.required_checks {
        match changeset
            .checks
            .iter()
            .find(|check| &check.profile_id == profile)
        {
            None => gaps.push(EligibilityGap::MissingCheck {
                profile: profile.clone(),
            }),
            Some(check) => {
                if check.head_sha != changeset.head_sha {
                    gaps.push(EligibilityGap::StaleHead);
                }
                if check.outcome != ChangesetCheckOutcome::Passed {
                    gaps.push(EligibilityGap::CheckNotPassed {
                        profile: profile.clone(),
                        outcome: check.outcome,
                    });
                }
            }
        }
    }
    if gaps.is_empty() {
        Ok(())
    } else {
        Err(gaps)
    }
}

pub(crate) fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.hooksPath=/dev/null"]);
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(key);
    }
    command.env("GIT_OPTIONAL_LOCKS", "0");
    for (config, author, committer, fallback) in [
        (
            "user.name",
            "GIT_AUTHOR_NAME",
            "GIT_COMMITTER_NAME",
            "Cognia Agent",
        ),
        (
            "user.email",
            "GIT_AUTHOR_EMAIL",
            "GIT_COMMITTER_EMAIL",
            "agent@cognia.invalid",
        ),
    ] {
        let configured = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["config", "--get", config])
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .filter(|value| !value.trim().is_empty());
        let identity = configured.as_deref().map(str::trim).unwrap_or(fallback);
        command.env(author, identity).env(committer, identity);
    }
    command
}

pub(crate) fn git_output(root: &Path, args: &[&str]) -> Result<Output, ChangesetError> {
    git_command(root)
        .args(args)
        .output()
        .map_err(|error| ChangesetError::Git(format!("start git {}: {error}", args.join(" "))))
}

fn checked_output(output: Output, operation: &str) -> Result<Vec<u8>, ChangesetError> {
    if !output.status.success() {
        return Err(ChangesetError::Git(format!(
            "{operation}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

pub(crate) fn git_text(root: &Path, args: &[&str]) -> Result<String, ChangesetError> {
    let bytes = checked_output(git_output(root, args)?, &args.join(" "))?;
    String::from_utf8(bytes)
        .map(|text| text.trim().to_string())
        .map_err(|error| ChangesetError::Git(format!("invalid UTF-8 git output: {error}")))
}

pub(crate) fn normalize_target_ref(root: &Path, target: &str) -> Result<String, ChangesetError> {
    let target = target.trim();
    let normalized = if target.starts_with("refs/heads/") {
        target.to_string()
    } else if target.starts_with("refs/") || target.is_empty() || target.starts_with('-') {
        return Err(ChangesetError::InvalidTarget(target.to_string()));
    } else {
        format!("refs/heads/{target}")
    };
    if !git_output(root, &["check-ref-format", &normalized])?
        .status
        .success()
        || !git_output(root, &["show-ref", "--verify", "--quiet", &normalized])?
            .status
            .success()
    {
        return Err(ChangesetError::InvalidTarget(target.to_string()));
    }
    git_text(
        root,
        &["rev-parse", "--verify", &format!("{normalized}^{{commit}}")],
    )?;
    Ok(normalized)
}

fn common_directory(root: &Path) -> Result<PathBuf, ChangesetError> {
    let common = PathBuf::from(git_text(root, &["rev-parse", "--git-common-dir"])?);
    let common = if common.is_absolute() {
        common
    } else {
        root.join(common)
    };
    common
        .canonicalize()
        .map_err(|error| ChangesetError::Io(format!("canonicalize git common dir: {error}")))
}

fn capture_target(
    workspace: &WorkspaceRecord,
    requested: Option<&str>,
) -> Result<String, ChangesetError> {
    let source = Path::new(&workspace.source_root);
    let target = match requested {
        Some(target) => target.to_string(),
        None => match &workspace.base {
            WorkspaceBaseSpec::LocalHead => git_text(source, &["symbolic-ref", "--quiet", "HEAD"])
                .map_err(|_| ChangesetError::TargetRequired)?,
            WorkspaceBaseSpec::GitRef { git_ref } => git_ref.clone(),
            _ => return Err(ChangesetError::TargetRequired),
        },
    };
    normalize_target_ref(source, &target)
}

fn utf8_path(bytes: &[u8]) -> Result<String, ChangesetError> {
    String::from_utf8(bytes.to_vec())
        .map_err(|error| ChangesetError::Git(format!("non-UTF-8 repository path: {error}")))
}

fn status_files(root: &Path) -> Result<Vec<ChangesetFile>, ChangesetError> {
    let output = checked_output(
        git_output(
            root,
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--ignored=matching",
            ],
        )?,
        "list working changes",
    )?;
    let mut fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            return Err(ChangesetError::Git("invalid status record".into()));
        }
        let codes = &field[..2];
        let path = utf8_path(&field[3..])?;
        let renamed = codes.contains(&b'R') || codes.contains(&b'C');
        let old_path = if renamed {
            Some(utf8_path(fields.next().ok_or_else(|| {
                ChangesetError::Git("missing rename source".into())
            })?)?)
        } else {
            None
        };
        let sensitive =
            is_sensitive_resource(&path) || old_path.as_deref().is_some_and(is_sensitive_resource);
        if !sensitive {
            continue;
        }
        let status = if renamed {
            ChangesetFileStatus::Renamed
        } else if codes.contains(&b'D') {
            ChangesetFileStatus::Deleted
        } else if codes.contains(&b'T') {
            ChangesetFileStatus::TypeChanged
        } else if codes.contains(&b'A') || codes == b"??" || codes == b"!!" {
            ChangesetFileStatus::Added
        } else {
            ChangesetFileStatus::Modified
        };
        files.push(ChangesetFile {
            path,
            old_path,
            status,
            insertions: None,
            deletions: None,
            binary: false,
            sensitive: true,
            excluded: true,
        });
    }
    Ok(files)
}

fn parse_name_status(statuses: &[u8]) -> Result<BTreeMap<String, ChangesetFile>, ChangesetError> {
    let mut fields = statuses
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut files = BTreeMap::new();
    while let Some(status) = fields.next() {
        let first = fields
            .next()
            .ok_or_else(|| ChangesetError::Git("missing diff path".into()))?;
        let (path, old_path) = if status[0] == b'R' {
            (
                utf8_path(
                    fields
                        .next()
                        .ok_or_else(|| ChangesetError::Git("missing renamed path".into()))?,
                )?,
                Some(utf8_path(first)?),
            )
        } else {
            (utf8_path(first)?, None)
        };
        let status = match status[0] {
            b'A' => ChangesetFileStatus::Added,
            b'D' => ChangesetFileStatus::Deleted,
            b'R' => ChangesetFileStatus::Renamed,
            b'T' => ChangesetFileStatus::TypeChanged,
            _ => ChangesetFileStatus::Modified,
        };
        files.insert(
            path.clone(),
            ChangesetFile {
                path,
                old_path,
                status,
                insertions: None,
                deletions: None,
                binary: false,
                sensitive: false,
                excluded: false,
            },
        );
    }
    Ok(files)
}

fn diff_files(root: &Path, base: &str, head: &str) -> Result<Vec<ChangesetFile>, ChangesetError> {
    let statuses = checked_output(
        git_output(
            root,
            &["diff", "--name-status", "-z", "-M", base, head, "--"],
        )?,
        "list changeset files",
    )?;
    let mut files = parse_name_status(&statuses)?;
    let stats = checked_output(
        git_output(root, &["diff", "--numstat", "-z", "-M", base, head, "--"])?,
        "read changeset statistics",
    )?;
    let mut fields = stats.split(|byte| *byte == 0).peekable();
    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }
        let mut parts = field.splitn(3, |byte| *byte == b'\t');
        let added = parts.next().unwrap_or_default();
        let deleted = parts
            .next()
            .ok_or_else(|| ChangesetError::Git("invalid numstat record".into()))?;
        let name = parts
            .next()
            .ok_or_else(|| ChangesetError::Git("missing numstat path".into()))?;
        let path = if name.is_empty() {
            fields
                .next()
                .ok_or_else(|| ChangesetError::Git("missing numstat old path".into()))?;
            utf8_path(
                fields
                    .next()
                    .ok_or_else(|| ChangesetError::Git("missing numstat new path".into()))?,
            )?
        } else {
            utf8_path(name)?
        };
        if let Some(file) = files.get_mut(&path) {
            file.binary = added == b"-" || deleted == b"-";
            if !file.binary {
                file.insertions = Some(
                    utf8_path(added)?
                        .parse()
                        .map_err(|_| ChangesetError::Git("invalid insertion count".into()))?,
                );
                file.deletions = Some(
                    utf8_path(deleted)?
                        .parse()
                        .map_err(|_| ChangesetError::Git("invalid deletion count".into()))?,
                );
            }
        }
    }
    Ok(files.into_values().collect())
}

fn changed_history_paths(
    root: &Path,
    base: &str,
    head: &str,
) -> Result<BTreeSet<String>, ChangesetError> {
    let commits = git_text(root, &["rev-list", &format!("{base}..{head}")])?;
    let mut changed = BTreeSet::new();
    for commit in commits.lines() {
        let paths = checked_output(
            git_output(
                root,
                &[
                    "diff-tree",
                    "--root",
                    "-m",
                    "--no-commit-id",
                    "--name-only",
                    "-r",
                    "-z",
                    commit,
                    "--",
                ],
            )?,
            "read commit paths",
        )?;
        for path in paths
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            let path = utf8_path(path)?;
            changed.insert(path);
        }
    }
    Ok(changed)
}

fn reject_sensitive_history(root: &Path, base: &str, head: &str) -> Result<(), ChangesetError> {
    let sensitive: BTreeSet<_> = changed_history_paths(root, base, head)?
        .into_iter()
        .filter(|path| is_sensitive_resource(path))
        .collect();
    if sensitive.is_empty() {
        Ok(())
    } else {
        Err(ChangesetError::SensitiveHistory {
            paths: sensitive.into_iter().collect(),
        })
    }
}

fn recapture_allowed(state: ChangesetState) -> bool {
    matches!(
        state,
        ChangesetState::Draft
            | ChangesetState::Ready
            | ChangesetState::Approved
            | ChangesetState::ChangesRequested
            | ChangesetState::Conflicted
            | ChangesetState::Failed
    )
}

struct CaptureOverlay {
    tree: String,
    base_commit: String,
    supported: bool,
}

fn capture_overlay(
    root: &Path,
    snapshot: &crate::snapshot::WorkspaceSnapshot,
    blobs: &HashMap<String, Vec<u8>>,
    policy: &ResourceTrackingPolicy,
    base_commit: Option<&str>,
) -> Result<CaptureOverlay, ChangesetError> {
    use crate::snapshot::{EntryKind, SnapshotBase};
    let temp = tempfile::tempdir().map_err(|error| ChangesetError::Io(error.to_string()))?;
    let index = temp.path().join("baseline-index");
    let indexed = |args: &[&str]| {
        let output = git_command(root)
            .env("GIT_INDEX_FILE", &index)
            .args(args)
            .output()
            .map_err(|error| ChangesetError::Git(error.to_string()))?;
        checked_output(output, "reconstruct capture baseline")
    };
    let mut original_entries = BTreeMap::new();
    let base_commit = match &snapshot.base {
        SnapshotBase::GitCommit { commit } => {
            indexed(&["read-tree", commit])?;
            let listing = git_output(root, &["ls-tree", "-r", "-z", commit])?;
            for row in checked_output(listing, "list baseline commit")?
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
            {
                let row = utf8_path(row)?;
                let (metadata, path) = row
                    .split_once('\t')
                    .ok_or_else(|| ChangesetError::Git("invalid baseline tree entry".into()))?;
                let fields: Vec<_> = metadata.split_whitespace().collect();
                if fields.len() != 3 {
                    return Err(ChangesetError::Git("invalid baseline tree metadata".into()));
                }
                original_entries.insert(
                    path.to_string(),
                    (fields[0].to_string(), fields[2].to_string()),
                );
                if !snapshot.entries.contains_key(path)
                    && !crate::snapshot::excluded(
                        &root.join(path),
                        root,
                        &policy.generated_output_roots,
                    )
                {
                    indexed(&[
                        "--literal-pathspecs",
                        "update-index",
                        "--force-remove",
                        "--",
                        path,
                    ])?;
                }
            }
            commit.clone()
        }
        SnapshotBase::Blobs => {
            let base_commit = base_commit.ok_or_else(|| {
                ChangesetError::InvalidWorkspace(
                    "blob-backed working-state baseline has no acquisition commit".into(),
                )
            })?;
            indexed(&["read-tree", "--empty"])?;
            base_commit.to_string()
        }
    };
    for entry in snapshot.entries.values() {
        let mode = match entry.kind {
            EntryKind::Symlink => "120000",
            EntryKind::File if entry.mode.is_some_and(|mode| mode & 0o111 != 0) => "100755",
            EntryKind::File => "100644",
        };
        // Git-backed snapshots already name the unchanged blobs. Keep those
        // index entries instead of writing the entire repository again.
        if original_entries
            .get(&entry.path)
            .is_some_and(|(old_mode, hash)| old_mode == mode && hash == &entry.hash)
        {
            continue;
        }
        let bytes = blobs.get(&entry.hash).ok_or_else(|| {
            ChangesetError::Store(format!("missing baseline blob {}", entry.hash))
        })?;
        let mut child = git_command(root)
            .env("GIT_INDEX_FILE", &index)
            .args([
                "hash-object",
                "-w",
                "--stdin",
                &format!("--path={}", entry.path),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| ChangesetError::Git(error.to_string()))?;
        let write = child.stdin.take().expect("piped stdin").write_all(bytes);
        let output = child
            .wait_with_output()
            .map_err(|error| ChangesetError::Git(error.to_string()))?;
        write.map_err(|error| ChangesetError::Git(error.to_string()))?;
        let hash = String::from_utf8(checked_output(output, "write baseline blob")?)
            .map_err(|error| ChangesetError::Git(error.to_string()))?;
        indexed(&[
            "update-index",
            "--add",
            "--replace",
            "--cacheinfo",
            mode,
            hash.trim(),
            &entry.path,
        ])?;
    }
    let tree = String::from_utf8(indexed(&["write-tree"])?)
        .map_err(|error| ChangesetError::Git(error.to_string()))?;
    Ok(CaptureOverlay {
        tree: tree.trim().into(),
        base_commit,
        supported: crate::integration::merge_tree_supported(),
    })
}

fn remove_capture_overlay(
    root: &Path,
    head: &str,
    tree: &str,
    overlay: &CaptureOverlay,
) -> Result<String, ChangesetError> {
    let original_tree = git_text(
        root,
        &["rev-parse", &format!("{}^{{tree}}", overlay.base_commit)],
    )?;
    if overlay.tree == original_tree {
        return Ok(tree.into());
    }
    if !overlay.supported {
        return Err(ChangesetError::OverlayUnsupported);
    }
    // An agent commit must not make the inherited overlay reachable through
    // our parent. Such histories need an explicit resolution before capture.
    let overlay_files = diff_files(root, &overlay.base_commit, &overlay.tree)?;
    let paths = |files: &[ChangesetFile]| -> BTreeSet<String> {
        files
            .iter()
            .flat_map(|file| std::iter::once(file.path.clone()).chain(file.old_path.clone()))
            .collect()
    };
    let committed: Vec<_> = paths(&overlay_files)
        .intersection(&changed_history_paths(root, &overlay.base_commit, head)?)
        .cloned()
        .collect();
    if !committed.is_empty() {
        return Err(ChangesetError::OverlayConflict { files: committed });
    }
    let baseline = git_text(
        root,
        &[
            "commit-tree",
            &overlay.tree,
            "-p",
            head,
            "-m",
            "Cognia capture baseline",
        ],
    )?;
    let final_commit = git_text(
        root,
        &[
            "commit-tree",
            tree,
            "-p",
            head,
            "-m",
            "Cognia capture candidate",
        ],
    )?;
    let output = git_output(
        root,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "-z",
            "--no-messages",
            &format!("--merge-base={baseline}"),
            head,
            &final_commit,
        ],
    )?;
    if matches!(output.status.code(), Some(0 | 1)) {
        let mut fields = output.stdout.split(|byte| *byte == 0);
        let tree = utf8_path(fields.next().unwrap_or_default())?;
        if output.status.success() && !tree.is_empty() {
            return Ok(tree);
        }
        if output.status.code() == Some(1) {
            let files = fields
                .filter(|field| !field.is_empty())
                .map(utf8_path)
                .collect::<Result<Vec<_>, _>>()?;
            return Err(ChangesetError::OverlayConflict { files });
        }
    }
    Err(ChangesetError::Git(format!(
        "remove capture overlay: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    )))
}

/// Build the immutable commit using a private index. The caller owns pinning
/// and persistence so a failed compare-and-swap can restore the previous pin.
/// Working-state workspaces require the service's persisted acquisition baseline.
pub fn capture_changeset_core(
    workspace: &WorkspaceRecord,
    request: &CaptureChangeset,
    run: Option<(&TaskRun, Option<&str>)>,
    existing: Option<&AgentChangeset>,
    now: i64,
) -> Result<AgentChangeset, ChangesetError> {
    capture_changeset_with_overlay(workspace, request, run, existing, now, None)
}

fn capture_changeset_with_overlay(
    workspace: &WorkspaceRecord,
    request: &CaptureChangeset,
    run: Option<(&TaskRun, Option<&str>)>,
    existing: Option<&AgentChangeset>,
    now: i64,
    overlay: Option<&CaptureOverlay>,
) -> Result<AgentChangeset, ChangesetError> {
    if workspace.isolation_kind != IsolationKind::GitWorktree
        || workspace.workspace_id != request.workspace_id
        || !Path::new(&workspace.execution_root).is_dir()
    {
        return Err(ChangesetError::InvalidWorkspace(
            workspace.workspace_id.clone(),
        ));
    }
    if let Some(existing) = existing {
        if existing.workspace_id != workspace.workspace_id {
            return Err(ChangesetError::InvalidWorkspace(
                workspace.workspace_id.clone(),
            ));
        }
        if !recapture_allowed(existing.state) {
            return Err(ChangesetError::ChangesetState {
                state: existing.state,
            });
        }
    }
    let root = Path::new(&workspace.execution_root);
    let common = common_directory(root)?;
    if common_directory(Path::new(&workspace.source_root))? != common {
        return Err(ChangesetError::InvalidWorkspace(
            workspace.workspace_id.clone(),
        ));
    }
    let target_ref = capture_target(
        workspace,
        request
            .target_ref
            .as_deref()
            .or_else(|| existing.map(|old| old.target_ref.as_str())),
    )?;
    if workspace.base == WorkspaceBaseSpec::WorkingState && overlay.is_none() {
        return Err(ChangesetError::InvalidWorkspace(format!(
            "{} has no persisted working-state baseline",
            workspace.workspace_id
        )));
    }
    let target = git_text(root, &["rev-parse", &format!("{target_ref}^{{commit}}")])?;
    let worktree_head = git_text(root, &["rev-parse", "HEAD^{commit}"])?;
    let original_base = git_text(root, &["merge-base", &target, &worktree_head])?;
    reject_sensitive_history(root, &original_base, &worktree_head)?;
    let changeset_id = existing
        .map(|old| old.changeset_id.clone())
        .or_else(|| request.changeset_id.clone())
        .unwrap_or_else(|| Uuid::now_v7().to_string());
    let change_ref = format!("refs/cognia/changesets/{changeset_id}");
    if !git_output(root, &["check-ref-format", &change_ref])?
        .status
        .success()
    {
        return Err(ChangesetError::InvalidInput("invalid changeset id".into()));
    }
    let mut excluded = status_files(root)?;
    let temp = tempfile::tempdir().map_err(|error| {
        ChangesetError::Io(format!("create temporary index directory: {error}"))
    })?;
    let index = temp.path().join("index");
    let indexed = |args: &[&str]| -> Result<String, ChangesetError> {
        let output = git_command(root)
            .env("GIT_INDEX_FILE", &index)
            .args(args)
            .output()
            .map_err(|error| ChangesetError::Git(format!("start temporary-index git: {error}")))?;
        let bytes = checked_output(output, &args.join(" "))?;
        String::from_utf8(bytes)
            .map(|text| text.trim().to_string())
            .map_err(|error| ChangesetError::Git(error.to_string()))
    };
    indexed(&["read-tree", &worktree_head])?;
    indexed(&["add", "-A", "--", "."])?;
    let staged = git_command(root)
        .env("GIT_INDEX_FILE", &index)
        .args([
            "diff",
            "--cached",
            "--name-status",
            "-z",
            "-M",
            &worktree_head,
            "--",
        ])
        .output()
        .map_err(|error| ChangesetError::Git(format!("read private index changes: {error}")))?;
    for mut file in
        parse_name_status(&checked_output(staged, "read private index changes")?)?.into_values()
    {
        if is_sensitive_resource(&file.path)
            || file.old_path.as_deref().is_some_and(is_sensitive_resource)
        {
            file.sensitive = true;
            file.excluded = true;
            excluded.retain(|previous| previous.path != file.path);
            excluded.push(file);
        }
    }
    for file in &excluded {
        for path in std::iter::once(file.path.as_str()).chain(file.old_path.as_deref()) {
            indexed(&[
                "--literal-pathspecs",
                "rm",
                "--cached",
                "-f",
                "--ignore-unmatch",
                "--",
                path,
            ])?;
            // A tracked credential already belongs to the base. Excluding an
            // edit must not turn it into an accidental credential deletion.
            indexed(&[
                "--literal-pathspecs",
                "reset",
                "-q",
                &worktree_head,
                "--",
                path,
            ])?;
        }
    }
    let mut tree = indexed(&["write-tree"])?;
    if let Some(overlay) = overlay {
        tree = remove_capture_overlay(root, &worktree_head, &tree, overlay)?;
    }
    let head_tree = git_text(root, &["rev-parse", &format!("{worktree_head}^{{tree}}")])?;
    let unchanged_capture = if let Some(old) = existing {
        let old_tree = git_text(root, &["rev-parse", &format!("{}^{{tree}}", old.head_sha)])?;
        let parents = git_text(root, &["show", "-s", "--format=%P", &old.head_sha])?;
        old_tree == tree && (old.head_sha == worktree_head || parents == worktree_head)
    } else {
        false
    };
    if let Some(old) = existing.filter(|_| unchanged_capture) {
        let mut record = old.clone();
        if old.title != request.title
            || old.depends_on != request.depends_on
            || old.required_checks != request.required_checks
        {
            record.title = request.title.clone();
            record.depends_on = request.depends_on.clone();
            record.required_checks = request.required_checks.clone();
            record.version = old.version.checked_add(1).ok_or_else(|| {
                ChangesetError::InvalidInput("changeset version exhausted".into())
            })?;
            record.updated_at = now;
        }
        return Ok(record);
    }
    let agent = run
        .map(|(run, _)| run.agent_id.as_str())
        .unwrap_or("unknown");
    let task = run
        .map(|(run, _)| run.task_id.as_str())
        .unwrap_or("unknown");
    let message = format!(
        "{}\n\nCognia-Changeset: {changeset_id}\nCognia-Agent: {}\nCognia-Task: {}",
        request.title,
        trailer_value(agent),
        trailer_value(task)
    );
    let head_sha = if tree == head_tree {
        worktree_head
    } else {
        git_text(
            root,
            &["commit-tree", &tree, "-p", &worktree_head, "-m", &message],
        )?
    };
    let base_sha = git_text(root, &["merge-base", &target, &head_sha])?;
    if head_sha == base_sha {
        return Err(ChangesetError::NothingToCapture);
    }
    let mut files = diff_files(root, &base_sha, &head_sha)?;
    files.extend(excluded);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let version = existing.map_or(Ok(1), |old| {
        old.version
            .checked_add(1)
            .ok_or_else(|| ChangesetError::InvalidInput("changeset version exhausted".into()))
    })?;
    Ok(AgentChangeset {
        changeset_id,
        run_id: run.map(|(run, _)| run.run_id.clone()),
        task_id: run.map(|(run, _)| run.task_id.clone()),
        session_id: run
            .and_then(|(_, session)| session.map(str::to_string))
            .or_else(|| {
                (workspace.owner_type == WorkspaceOwnerType::Session)
                    .then(|| workspace.owner_ref.clone())
                    .flatten()
            }),
        agent_id: run.map(|(run, _)| run.agent_id.clone()),
        agent_kind: run.map(|(run, _)| run.agent_kind.clone()),
        owner_ref: workspace.owner_ref.clone(),
        workspace_id: workspace.workspace_id.clone(),
        execution_root: workspace.execution_root.clone(),
        repo_common_dir: common.to_string_lossy().into_owned(),
        source_root: workspace.source_root.clone(),
        target_ref,
        base_sha,
        head_sha,
        change_ref,
        title: request.title.clone(),
        files,
        depends_on: request.depends_on.clone(),
        state: ChangesetState::Draft,
        review: None,
        checks: Vec::new(),
        required_checks: request.required_checks.clone(),
        approval: None,
        integration_id: None,
        merged_sha: None,
        version,
        created_at: existing.map_or(now, |old| old.created_at),
        updated_at: now,
    })
}

fn trailer_value(value: &str) -> String {
    value.replace(['\n', '\r'], " ")
}

fn require_head(record: &AgentChangeset, head: &str) -> Result<(), ChangesetError> {
    if record.head_sha == head {
        Ok(())
    } else {
        Err(ChangesetError::StaleHead {
            expected: record.head_sha.clone(),
            actual: head.to_string(),
        })
    }
}

pub(crate) fn cap_check_log(check: &mut ChangesetCheck) {
    if let Some(log) = &mut check.log_tail {
        let count = log.chars().count();
        if count > 8000 {
            *log = log.chars().skip(count - 8000).collect();
        }
    }
}

fn get_record(store: &WorkspaceStore, id: &str) -> Result<AgentChangeset, ChangesetError> {
    store
        .get_changeset(id)
        .map_err(ChangesetError::Store)?
        .ok_or_else(|| ChangesetError::NotFound(id.to_string()))
}

fn save_update(store: &WorkspaceStore, record: &mut AgentChangeset) -> Result<(), ChangesetError> {
    let expected = record.version;
    record.version = expected
        .checked_add(1)
        .ok_or_else(|| ChangesetError::InvalidInput("changeset version exhausted".into()))?;
    record.updated_at = now_ms();
    store.update_changeset(record, expected)
}

fn update_pin(
    root: &Path,
    record: &AgentChangeset,
    head: Option<&str>,
    expected: &str,
) -> Result<(), ChangesetError> {
    let output = match head {
        Some(head) => git_output(root, &["update-ref", &record.change_ref, head, expected])?,
        None => git_output(root, &["update-ref", "-d", &record.change_ref, expected])?,
    };
    if !output.status.success() {
        let actual = git_output(root, &["rev-parse", "--verify", &record.change_ref])?;
        let current = if actual.status.success() {
            String::from_utf8_lossy(&actual.stdout).trim().to_string()
        } else {
            "0".repeat(expected.len())
        };
        if current != expected {
            return Err(ChangesetError::Conflict {
                changeset_id: record.changeset_id.clone(),
            });
        }
    }
    checked_output(output, "update changeset pin").map(|_| ())
}

impl crate::TaskWorkspaceService {
    /// Make every changeset pin agree with its row, one changeset at a time.
    /// A pin that cannot be repaired now (its repository is offline or
    /// broken) is reported and retried on the next open; it never stops the
    /// others, or the service from opening.
    pub(crate) fn recover_changeset_pins(
        &self,
    ) -> Result<Vec<(String, ChangesetError)>, ChangesetError> {
        let now = now_ms();
        let retention = i64::from(self.workspace_lifecycle_policy().snapshot_retention_days)
            * 24
            * 60
            * 60
            * 1000;
        let mut failures = Vec::new();
        for previous in self.list_changesets(ChangesetFilter::default())? {
            let changeset_id = previous.changeset_id.clone();
            if let Err(error) = self.recover_changeset_pin(previous, now, retention) {
                failures.push((changeset_id, error));
            }
        }
        Ok(failures)
    }

    fn recover_changeset_pin(
        &self,
        previous: AgentChangeset,
        now: i64,
        retention: i64,
    ) -> Result<(), ChangesetError> {
        let root = Path::new(&previous.repo_common_dir);
        if !root
            .try_exists()
            .map_err(|error| ChangesetError::Io(format!("inspect repository: {error}")))?
        {
            return Ok(());
        }
        let lock = self
            .git_admin_lock(root)
            .ok_or_else(|| ChangesetError::Git("repository is unavailable".into()))?;
        let _guard = lock.lock();
        let store = self.store.lock();
        let record = get_record(&store, &previous.changeset_id)?;
        let output = git_output(
            root,
            &["rev-parse", "--verify", "--quiet", &record.change_ref],
        )?;
        let actual = if output.status.code() == Some(1) {
            None
        } else {
            let bytes = checked_output(output, "resolve changeset pin")?;
            Some(
                String::from_utf8(bytes)
                    .map_err(|error| ChangesetError::Git(format!("invalid pin SHA: {error}")))?
                    .trim()
                    .to_string(),
            )
        };
        let expired = record.state == ChangesetState::Abandoned
            || (matches!(
                record.state,
                ChangesetState::Merged | ChangesetState::RolledBack
            ) && now.saturating_sub(record.updated_at) > retention);
        if expired {
            if let Some(actual) = actual {
                update_pin(root, &record, None, &actual)?;
            }
        } else if actual.as_deref() != Some(record.head_sha.as_str()) {
            // A crash can leave Git ahead of SQLite or remove the pin
            // before abandonment is persisted. The committed row wins.
            let expected = actual.unwrap_or_else(|| "0".repeat(record.head_sha.len()));
            update_pin(root, &record, Some(&record.head_sha), &expected)?;
        }
        Ok(())
    }

    pub fn capture_changeset(
        &self,
        request: CaptureChangeset,
    ) -> Result<AgentChangeset, ChangesetError> {
        let workspace = self
            .registry
            .get(&request.workspace_id)
            .map_err(|error| ChangesetError::Store(error.to_string()))?
            .ok_or_else(|| ChangesetError::InvalidWorkspace(request.workspace_id.clone()))?;
        let lock = self
            .git_admin_lock(Path::new(&workspace.execution_root))
            .ok_or_else(|| ChangesetError::InvalidWorkspace(request.workspace_id.clone()))?;
        let _guard = lock.lock();
        let mut store = self.store.lock();
        let existing = request
            .changeset_id
            .as_deref()
            .map(|id| get_record(&store, id))
            .transpose()?;
        if let Some(record) = existing
            .as_ref()
            .filter(|record| !recapture_allowed(record.state))
        {
            return Err(ChangesetError::ChangesetState {
                state: record.state,
            });
        }
        let run = store
            .latest_workspace_run(&request.workspace_id)
            .map_err(ChangesetError::Store)?;
        let overlay = if workspace.base == WorkspaceBaseSpec::WorkingState {
            let saved = store
                .get_workspace_capture_baseline(&workspace.workspace_id)
                .map_err(ChangesetError::Store)?;
            let saved = match saved {
                Some(saved) => Some(saved),
                None => match store
                    .earliest_workspace_run(&workspace.workspace_id)
                    .map_err(ChangesetError::Store)?
                {
                    Some(first) => {
                        let baseline = store
                            .get_run::<crate::snapshot::WorkspaceSnapshot>(&first.run_id)
                            .map_err(ChangesetError::Store)?
                            .map(|(run, snapshot)| (snapshot, run.tracking_policy, None));
                        if let Some((snapshot, policy, acquisition_commit)) = &baseline {
                            store
                                .put_workspace_capture_baseline(
                                    &workspace.workspace_id,
                                    snapshot,
                                    policy,
                                    acquisition_commit.as_deref(),
                                )
                                .map_err(ChangesetError::Store)?;
                        }
                        baseline
                    }
                    None => None,
                },
            };
            let (snapshot, policy, acquisition_commit) = saved.ok_or_else(|| {
                ChangesetError::InvalidWorkspace(format!(
                    "{} has no persisted working-state baseline",
                    workspace.workspace_id
                ))
            })?;
            let root = Path::new(&workspace.execution_root);
            let blobs =
                crate::service::hydrate_snapshot_blobs(&mut store, &snapshot, root, now_ms())
                    .map_err(ChangesetError::Store)?;
            Some(capture_overlay(
                root,
                &snapshot,
                &blobs,
                &policy,
                acquisition_commit.as_deref(),
            )?)
        } else {
            None
        };
        let record = capture_changeset_with_overlay(
            &workspace,
            &request,
            run.as_ref().map(|(run, session)| (run, session.as_deref())),
            existing.as_ref(),
            now_ms(),
            overlay.as_ref(),
        )?;
        if existing
            .as_ref()
            .is_some_and(|old| old.head_sha == record.head_sha)
        {
            let old = existing.as_ref().expect("existing capture");
            if old.version != record.version {
                store.update_changeset(&record, old.version)?;
            }
            return Ok(record);
        }
        let root = Path::new(&record.repo_common_dir);
        let old_sha = existing
            .as_ref()
            .map(|old| old.head_sha.clone())
            .unwrap_or_else(|| "0".repeat(record.head_sha.len()));
        update_pin(root, &record, Some(&record.head_sha), &old_sha)?;
        let persisted = match &existing {
            Some(old) => store.update_changeset(&record, old.version),
            None => store.insert_changeset(&record),
        };
        if let Err(error) = persisted {
            let restored = if existing.is_some() {
                git_text(
                    root,
                    &["update-ref", &record.change_ref, &old_sha, &record.head_sha],
                )
            } else {
                git_text(
                    root,
                    &["update-ref", "-d", &record.change_ref, &record.head_sha],
                )
            };
            if let Err(restore) = restored {
                return Err(ChangesetError::Git(format!(
                    "{error}; restore changeset pin: {restore}"
                )));
            }
            return Err(error);
        }
        Ok(record)
    }

    pub fn get_changeset(&self, id: &str) -> Result<AgentChangeset, ChangesetError> {
        get_record(&self.store.lock(), id)
    }

    pub fn list_changesets(
        &self,
        filter: ChangesetFilter,
    ) -> Result<Vec<AgentChangeset>, ChangesetError> {
        self.store
            .lock()
            .list_changesets(&filter)
            .map_err(ChangesetError::Store)
    }

    pub fn mark_changeset_ready(&self, id: &str) -> Result<AgentChangeset, ChangesetError> {
        let store = self.store.lock();
        let mut record = get_record(&store, id)?;
        validate_changeset_transition(record.state, ChangesetState::Ready)?;
        record.state = ChangesetState::Ready;
        save_update(&store, &mut record)?;
        Ok(record)
    }

    pub fn record_changeset_review(
        &self,
        id: &str,
        review: ChangesetReview,
    ) -> Result<AgentChangeset, ChangesetError> {
        let store = self.store.lock();
        let mut record = get_record(&store, id)?;
        require_head(&record, &review.head_sha)?;
        if !matches!(
            record.state,
            ChangesetState::Ready | ChangesetState::Approved | ChangesetState::ChangesRequested
        ) {
            return Err(ChangesetError::IllegalTransition {
                from: record.state,
                to: ChangesetState::Ready,
            });
        }
        record.state = match review.verdict {
            ChangesetReviewVerdict::Approve => ChangesetState::Approved,
            ChangesetReviewVerdict::RequestChanges => ChangesetState::ChangesRequested,
            ChangesetReviewVerdict::Comment | ChangesetReviewVerdict::Unavailable => {
                ChangesetState::Ready
            }
        };
        record.review = Some(review);
        save_update(&store, &mut record)?;
        Ok(record)
    }

    pub fn record_changeset_check(
        &self,
        id: &str,
        mut check: ChangesetCheck,
    ) -> Result<AgentChangeset, ChangesetError> {
        let store = self.store.lock();
        let mut record = get_record(&store, id)?;
        require_head(&record, &check.head_sha)?;
        cap_check_log(&mut check);
        record
            .checks
            .retain(|previous| previous.profile_id != check.profile_id);
        record.checks.push(check);
        save_update(&store, &mut record)?;
        Ok(record)
    }

    pub fn approve_changeset(
        &self,
        id: &str,
        head_sha: &str,
        approver: &str,
    ) -> Result<AgentChangeset, ChangesetError> {
        let store = self.store.lock();
        let mut record = get_record(&store, id)?;
        require_head(&record, head_sha)?;
        if approver.trim().is_empty() {
            return Err(ChangesetError::InvalidInput("approver is empty".into()));
        }
        record.approval = Some(ChangesetApproval {
            head_sha: head_sha.to_string(),
            approver: approver.to_string(),
            approved_at: now_ms(),
        });
        save_update(&store, &mut record)?;
        Ok(record)
    }

    pub fn abandon_changeset(&self, id: &str) -> Result<AgentChangeset, ChangesetError> {
        let current = self.get_changeset(id)?;
        let root = Path::new(&current.repo_common_dir);
        let lock = self
            .git_admin_lock(root)
            .ok_or_else(|| ChangesetError::Git("repository is unavailable".into()))?;
        let _guard = lock.lock();
        let store = self.store.lock();
        let mut record = get_record(&store, id)?;
        validate_changeset_transition(record.state, ChangesetState::Abandoned)?;
        update_pin(root, &record, None, &record.head_sha)?;
        record.state = ChangesetState::Abandoned;
        if let Err(error) = save_update(&store, &mut record) {
            git_text(
                root,
                &[
                    "update-ref",
                    &record.change_ref,
                    &record.head_sha,
                    &"0".repeat(record.head_sha.len()),
                ],
            )?;
            return Err(error);
        }
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ServiceConfig, TaskWorkspaceService};
    use std::fs;
    use tempfile::TempDir;

    struct Fixture {
        _dir: TempDir,
        service: TaskWorkspaceService,
        workspace: WorkspaceRecord,
    }

    impl Fixture {
        fn new() -> Self {
            Self::with_tracked_secret(false)
        }

        fn with_tracked_secret(secret: bool) -> Self {
            let dir = TempDir::new().unwrap();
            let source = dir.path().join("source");
            let execution = dir.path().join("execution");
            fs::create_dir(&source).unwrap();
            git_text(&source, &["init", "-b", "main"]).unwrap();
            git_text(&source, &["config", "user.name", "Changeset Test"]).unwrap();
            git_text(&source, &["config", "user.email", "changeset@test.invalid"]).unwrap();
            fs::write(source.join("one.txt"), "one\n").unwrap();
            fs::write(source.join("two.txt"), "two\n").unwrap();
            fs::write(source.join(".gitignore"), ".env.local\nignored/\n").unwrap();
            if secret {
                fs::write(source.join(".env"), "BASE=existing\n").unwrap();
            }
            git_text(&source, &["add", "-A"]).unwrap();
            git_text(&source, &["commit", "-m", "initial"]).unwrap();
            git_text(
                &source,
                &[
                    "worktree",
                    "add",
                    "--detach",
                    "--lock",
                    "--reason",
                    "cognia:ws-capture",
                    execution.to_str().unwrap(),
                    "HEAD",
                ],
            )
            .unwrap();
            let common = common_directory(&source).unwrap();
            let workspace = WorkspaceRecord {
                workspace_id: "ws-capture".into(),
                environment_kind: WorkspaceEnvironmentKind::Managed,
                project_id: None,
                owner_type: WorkspaceOwnerType::Session,
                owner_ref: Some("session-capture".into()),
                state: WorkspaceState::Active,
                source_root: source.to_string_lossy().into_owned(),
                git_common_dir: Some(common.to_string_lossy().into_owned()),
                base: WorkspaceBaseSpec::LocalHead,
                head: Some(git_text(&source, &["rev-parse", "HEAD"]).unwrap()),
                branch: None,
                isolation_kind: IsolationKind::GitWorktree,
                execution_root: execution.to_string_lossy().into_owned(),
                snapshot_task_id: None,
                size_bytes: None,
                last_used_at: 1,
                locked_by: Some("cognia:ws-capture".into()),
                pinned: false,
                created_at: 1,
            };
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(dir.path().join("data"))).unwrap();
            service.store.lock().put_workspace(&workspace).unwrap();
            Self {
                _dir: dir,
                service,
                workspace,
            }
        }

        fn root(&self) -> &Path {
            Path::new(&self.workspace.execution_root)
        }

        fn request(&self) -> CaptureChangeset {
            CaptureChangeset {
                workspace_id: self.workspace.workspace_id.clone(),
                target_ref: None,
                title: "Capture work".into(),
                depends_on: Vec::new(),
                required_checks: vec!["unit".into()],
                changeset_id: None,
            }
        }

        fn capture(&self) -> AgentChangeset {
            self.service.capture_changeset(self.request()).unwrap()
        }
    }

    fn review(head: &str) -> ChangesetReview {
        ChangesetReview {
            head_sha: head.into(),
            verdict: ChangesetReviewVerdict::Approve,
            reviewer: ChangesetReviewer::Deterministic,
            risk_tier: ChangesetRiskTier::Low,
            reasons: Vec::new(),
            findings: Vec::new(),
            requires_human_approval: false,
            recorded_at: 10,
        }
    }

    fn check(head: &str) -> ChangesetCheck {
        ChangesetCheck {
            head_sha: head.into(),
            profile_id: "unit".into(),
            outcome: ChangesetCheckOutcome::Passed,
            tier: None,
            report_digest: None,
            log_tail: None,
            ran_at: 10,
        }
    }

    fn sample() -> AgentChangeset {
        AgentChangeset {
            changeset_id: "cs".into(),
            run_id: None,
            task_id: None,
            session_id: None,
            agent_id: None,
            agent_kind: None,
            owner_ref: None,
            workspace_id: "ws".into(),
            execution_root: "/execution".into(),
            repo_common_dir: "/repo/.git".into(),
            source_root: "/repo".into(),
            target_ref: "refs/heads/main".into(),
            base_sha: "base".into(),
            head_sha: "head".into(),
            change_ref: "refs/cognia/changesets/cs".into(),
            title: "work".into(),
            files: Vec::new(),
            depends_on: Vec::new(),
            state: ChangesetState::Draft,
            review: None,
            checks: Vec::new(),
            required_checks: vec!["unit".into()],
            approval: None,
            integration_id: None,
            merged_sha: None,
            version: 1,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn changeset_transition_table_is_exhaustive() {
        use ChangesetState::*;
        let states = [
            Draft,
            Ready,
            Approved,
            ChangesRequested,
            Queued,
            Integrating,
            Merged,
            Conflicted,
            Failed,
            RolledBack,
            Abandoned,
        ];
        let legal = [
            (Draft, vec![Ready, Abandoned]),
            (Ready, vec![Approved, ChangesRequested, Draft, Abandoned]),
            (Approved, vec![Queued, Draft, ChangesRequested, Abandoned]),
            (ChangesRequested, vec![Draft, Abandoned]),
            (Queued, vec![Integrating, Approved, Draft, Abandoned]),
            (Integrating, vec![Merged, Conflicted, Failed, Queued]),
            (Conflicted, vec![Draft, Queued, Abandoned]),
            (Failed, vec![Draft, Queued, Abandoned]),
            (Merged, vec![RolledBack]),
            (RolledBack, vec![]),
            (Abandoned, vec![]),
        ];
        for from in states {
            for to in states {
                let expected = legal
                    .iter()
                    .find(|(state, _)| *state == from)
                    .unwrap()
                    .1
                    .contains(&to);
                assert_eq!(
                    validate_changeset_transition(from, to).is_ok(),
                    expected,
                    "{from:?} → {to:?}"
                );
                if !expected {
                    assert_eq!(
                        validate_changeset_transition(from, to),
                        Err(ChangesetError::IllegalTransition { from, to })
                    );
                }
            }
        }
    }

    #[test]
    fn changeset_error_codes_and_retryability_cover_every_variant() {
        use ChangesetError::*;
        let cases = [
            (NotFound("id".into()), "not_found", false),
            (InvalidWorkspace("id".into()), "invalid_workspace", false),
            (TargetRequired, "target_required", false),
            (InvalidTarget("ref".into()), "invalid_target", false),
            (NothingToCapture, "nothing_to_capture", false),
            (
                IllegalTransition {
                    from: crate::ChangesetState::Draft,
                    to: crate::ChangesetState::Merged,
                },
                "illegal_transition",
                false,
            ),
            (
                Conflict {
                    changeset_id: "id".into(),
                },
                "conflict",
                true,
            ),
            (
                StaleHead {
                    expected: "old".into(),
                    actual: "new".into(),
                },
                "stale_head",
                false,
            ),
            (
                SensitiveHistory { paths: vec![] },
                "sensitive_history",
                false,
            ),
            (OverlayConflict { files: vec![] }, "overlay_conflict", false),
            (OverlayUnsupported, "overlay_unsupported", false),
            (
                ChangesetState {
                    state: crate::ChangesetState::Queued,
                },
                "changeset_state",
                false,
            ),
            (InvalidInput("input".into()), "invalid_input", false),
            (Git("error".into()), "git", false),
            (Store("error".into()), "store", false),
            (Io("error".into()), "io", false),
        ];
        for (error, code, retryable) in cases {
            assert_eq!(error.code(), code, "{error:?}");
            assert_eq!(error.retryable(), retryable, "{error:?}");
        }
    }

    fn working_state_fixture(overlay: bool) -> Fixture {
        let mut fixture = Fixture::new();
        let source = Path::new(&fixture.workspace.source_root);
        if overlay {
            fs::write(source.join("one.txt"), "user work in progress\n").unwrap();
        }
        persist_working_state(&mut fixture);
        fixture
    }

    fn persist_working_state(fixture: &mut Fixture) {
        let source = Path::new(&fixture.workspace.source_root);
        let (snapshot, blobs) = crate::snapshot::capture(source).unwrap();
        let policy = ResourceTrackingPolicy::default();
        crate::snapshot::apply_git_overlay(fixture.root(), &snapshot, &blobs, &policy).unwrap();
        fixture.workspace.base = WorkspaceBaseSpec::WorkingState;
        {
            let mut store = fixture.service.store.lock();
            store.put_workspace(&fixture.workspace).unwrap();
            for (hash, bytes) in &blobs {
                store.put_blob(hash, bytes, 1).unwrap();
            }
            store
                .put_workspace_capture_baseline(
                    &fixture.workspace.workspace_id,
                    &snapshot,
                    &policy,
                    fixture.workspace.head.as_deref(),
                )
                .unwrap();
        }
    }

    #[test]
    fn working_state_changeset_removes_the_persisted_overlay_and_recaptures() {
        let fixture = working_state_fixture(true);
        let source = Path::new(&fixture.workspace.source_root);
        // The current source checkout is not the baseline we provisioned.
        fs::write(source.join("one.txt"), "user newer work\n").unwrap();
        fs::write(fixture.root().join("two.txt"), "agent work\n").unwrap();
        let index = git_text(fixture.root(), &["rev-parse", "--git-path", "index"]).unwrap();
        let index_before = fs::read(&index).unwrap();
        let head_before = git_text(fixture.root(), &["rev-parse", "HEAD"]).unwrap();
        let refs_before = git_text(
            fixture.root(),
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads",
            ],
        )
        .unwrap();
        let mut request = fixture.request();
        request.target_ref = Some("main".into());
        let captured = fixture.service.capture_changeset(request.clone()).unwrap();
        assert_eq!(
            captured
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["two.txt"]
        );
        assert_eq!(
            git_text(
                fixture.root(),
                &["show", &format!("{}:one.txt", captured.head_sha)]
            )
            .unwrap(),
            "one"
        );
        assert_eq!(
            fs::read_to_string(source.join("one.txt")).unwrap(),
            "user newer work\n"
        );
        assert_eq!(
            fs::read_to_string(fixture.root().join("one.txt")).unwrap(),
            "user work in progress\n"
        );
        assert_eq!(fs::read(&index).unwrap(), index_before);
        assert_eq!(
            git_text(fixture.root(), &["rev-parse", "HEAD"]).unwrap(),
            head_before
        );
        assert_eq!(
            git_text(
                fixture.root(),
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads"
                ]
            )
            .unwrap(),
            refs_before
        );
        request.changeset_id = Some(captured.changeset_id.clone());
        assert_eq!(
            fixture.service.capture_changeset(request.clone()).unwrap(),
            captured
        );
        request.title = "Retitled overlay capture".into();
        let retitled = fixture.service.capture_changeset(request.clone()).unwrap();
        assert_eq!(retitled.head_sha, captured.head_sha);
        assert_eq!(retitled.version, captured.version + 1);
        fs::write(fixture.root().join("two.txt"), "agent next edit\n").unwrap();
        let revised = fixture.service.capture_changeset(request).unwrap();
        assert_ne!(revised.head_sha, captured.head_sha);
        assert_eq!(revised.files.len(), 1);
        assert_eq!(revised.files[0].path, "two.txt");
        assert_eq!(revised.version, retitled.version + 1);
    }

    #[test]
    fn working_state_changeset_refuses_overlay_conflicts_without_publishing_a_ref() {
        for committed in [0, 1, 2] {
            let fixture = working_state_fixture(true);
            fs::write(fixture.root().join("one.txt"), "agent edited user work\n").unwrap();
            if committed > 0 {
                git_text(fixture.root(), &["add", "-A"]).unwrap();
                git_text(fixture.root(), &["commit", "-m", "agent commit"]).unwrap();
                if committed == 2 {
                    git_text(fixture.root(), &["revert", "--no-edit", "HEAD"]).unwrap();
                    fs::write(fixture.root().join("two.txt"), "agent safe edit\n").unwrap();
                }
            }
            let mut request = fixture.request();
            request.target_ref = Some("main".into());
            assert_eq!(
                fixture.service.capture_changeset(request),
                Err(ChangesetError::OverlayConflict {
                    files: vec!["one.txt".into()]
                })
            );
            assert!(fixture
                .service
                .list_changesets(ChangesetFilter::default())
                .unwrap()
                .is_empty());
            assert!(
                git_text(fixture.root(), &["for-each-ref", "refs/cognia/changesets"])
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[test]
    fn working_state_changeset_normalizes_overlay_with_the_candidates_clean_filters() {
        let mut fixture = Fixture::new();
        let source = Path::new(&fixture.workspace.source_root);
        git_text(source, &["config", "core.autocrlf", "false"]).unwrap();
        fs::write(source.join(".gitattributes"), "one.txt text eol=crlf\n").unwrap();
        git_text(source, &["add", ".gitattributes"]).unwrap();
        git_text(source, &["commit", "-m", "CRLF checkout"]).unwrap();
        let head = git_text(source, &["rev-parse", "HEAD"]).unwrap();
        git_text(fixture.root(), &["checkout", "--detach", &head]).unwrap();
        fixture.workspace.head = Some(head);
        fs::write(source.join("one.txt"), "user CRLF work\r\n").unwrap();
        persist_working_state(&mut fixture);
        let mut request = fixture.request();
        request.target_ref = Some("main".into());
        assert_eq!(
            fixture.service.capture_changeset(request.clone()),
            Err(ChangesetError::NothingToCapture)
        );
        fs::write(fixture.root().join("two.txt"), "agent work\n").unwrap();
        let captured = fixture.service.capture_changeset(request).unwrap();
        assert_eq!(captured.files.len(), 1);
        assert_eq!(captured.files[0].path, "two.txt");
        assert_eq!(
            fs::read(Path::new(&fixture.workspace.source_root).join("one.txt")).unwrap(),
            b"user CRLF work\r\n"
        );
    }

    #[test]
    fn working_state_changeset_removes_added_deleted_and_renamed_overlay_paths() {
        let mut fixture = Fixture::new();
        let source = Path::new(&fixture.workspace.source_root);
        fs::remove_file(source.join("one.txt")).unwrap();
        fs::rename(source.join("two.txt"), source.join("renamed.txt")).unwrap();
        fs::write(source.join("user-added.txt"), "user untracked\n").unwrap();
        persist_working_state(&mut fixture);
        fs::write(fixture.root().join("agent.txt"), "agent work\n").unwrap();
        let mut request = fixture.request();
        request.target_ref = Some("main".into());
        let captured = fixture.service.capture_changeset(request).unwrap();
        assert_eq!(captured.files.len(), 1);
        assert_eq!(captured.files[0].path, "agent.txt");
        for path in ["one.txt", "two.txt"] {
            assert!(git_output(
                fixture.root(),
                &["cat-file", "-e", &format!("{}:{path}", captured.head_sha)]
            )
            .unwrap()
            .status
            .success());
        }
        for path in ["renamed.txt", "user-added.txt"] {
            assert!(!git_output(
                fixture.root(),
                &["cat-file", "-e", &format!("{}:{path}", captured.head_sha)]
            )
            .unwrap()
            .status
            .success());
        }
    }

    #[test]
    fn working_state_changeset_refuses_an_overlay_only_capture_or_a_missing_baseline() {
        let fixture = working_state_fixture(true);
        let mut request = fixture.request();
        request.target_ref = Some("main".into());
        assert_eq!(
            fixture.service.capture_changeset(request.clone()),
            Err(ChangesetError::NothingToCapture)
        );
        assert!(matches!(
            capture_changeset_core(&fixture.workspace, &request, None, None, 1),
            Err(ChangesetError::InvalidWorkspace(_))
        ));
        assert!(fixture
            .service
            .list_changesets(ChangesetFilter::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn working_state_changeset_empty_overlay_and_unsupported_git_are_explicit() {
        for dirty in [false, true] {
            let fixture = working_state_fixture(dirty);
            fs::write(fixture.root().join("two.txt"), "agent work\n").unwrap();
            let (snapshot, policy, acquisition_commit) = fixture
                .service
                .store
                .lock()
                .get_workspace_capture_baseline(&fixture.workspace.workspace_id)
                .unwrap()
                .unwrap();
            let blobs = crate::service::hydrate_snapshot_blobs(
                &mut fixture.service.store.lock(),
                &snapshot,
                fixture.root(),
                2,
            )
            .unwrap();
            let mut overlay = capture_overlay(
                fixture.root(),
                &snapshot,
                &blobs,
                &policy,
                acquisition_commit.as_deref(),
            )
            .unwrap();
            overlay.supported = false;
            let mut request = fixture.request();
            request.target_ref = Some("main".into());
            let result = capture_changeset_with_overlay(
                &fixture.workspace,
                &request,
                None,
                None,
                3,
                Some(&overlay),
            );
            if dirty {
                assert_eq!(result, Err(ChangesetError::OverlayUnsupported));
            } else {
                let captured = result.unwrap();
                assert_eq!(captured.files.len(), 1);
                assert_eq!(captured.files[0].path, "two.txt");
            }
        }
    }

    #[test]
    fn working_state_changeset_blob_baseline_requires_an_immutable_acquisition_commit() {
        let fixture = working_state_fixture(true);
        let (mut snapshot, policy, acquisition_commit) = fixture
            .service
            .store
            .lock()
            .get_workspace_capture_baseline(&fixture.workspace.workspace_id)
            .unwrap()
            .unwrap();
        let blobs = crate::service::hydrate_snapshot_blobs(
            &mut fixture.service.store.lock(),
            &snapshot,
            fixture.root(),
            2,
        )
        .unwrap();
        snapshot.base = crate::snapshot::SnapshotBase::Blobs;
        fs::write(fixture.root().join("two.txt"), "agent work\n").unwrap();
        let overlay = capture_overlay(
            fixture.root(),
            &snapshot,
            &blobs,
            &policy,
            acquisition_commit.as_deref(),
        )
        .unwrap();
        let mut request = fixture.request();
        request.target_ref = Some("main".into());
        let record = capture_changeset_with_overlay(
            &fixture.workspace,
            &request,
            None,
            None,
            3,
            Some(&overlay),
        )
        .unwrap();
        assert_eq!(record.files.len(), 1);
        assert_eq!(record.files[0].path, "two.txt");
        git_text(fixture.root(), &["add", "-A"]).unwrap();
        git_text(
            fixture.root(),
            &["commit", "-m", "agent committed inherited work"],
        )
        .unwrap();
        assert!(matches!(
            capture_overlay(fixture.root(), &snapshot, &blobs, &policy, None),
            Err(ChangesetError::InvalidWorkspace(_))
        ));
        assert_eq!(
            capture_changeset_with_overlay(
                &fixture.workspace,
                &request,
                None,
                None,
                4,
                Some(&overlay)
            ),
            Err(ChangesetError::OverlayConflict {
                files: vec!["one.txt".into()]
            })
        );
    }

    #[test]
    fn recapture_changeset_updates_metadata_without_invalidating_head_bound_evidence() {
        let fixture = Fixture::new();
        fs::write(fixture.root().join("one.txt"), "agent\n").unwrap();
        let first = fixture.capture();
        fixture
            .service
            .mark_changeset_ready(&first.changeset_id)
            .unwrap();
        fixture
            .service
            .record_changeset_review(&first.changeset_id, review(&first.head_sha))
            .unwrap();
        fixture
            .service
            .record_changeset_check(&first.changeset_id, check(&first.head_sha))
            .unwrap();
        let approved = fixture
            .service
            .approve_changeset(&first.changeset_id, &first.head_sha, "user")
            .unwrap();
        let mut request = fixture.request();
        request.changeset_id = Some(first.changeset_id.clone());
        request.title = "Updated title".into();
        request.depends_on = vec!["dependency".into()];
        request.required_checks.push("integration".into());
        let updated = fixture.service.capture_changeset(request.clone()).unwrap();
        assert_eq!(updated.title, request.title);
        assert_eq!(updated.depends_on, request.depends_on);
        assert_eq!(updated.required_checks, request.required_checks);
        assert_eq!(updated.version, approved.version + 1);
        assert_eq!(updated.head_sha, approved.head_sha);
        assert_eq!(updated.state, ChangesetState::Approved);
        assert_eq!(updated.review, approved.review);
        assert_eq!(updated.checks, approved.checks);
        assert_eq!(updated.approval, approved.approval);
        assert_eq!(
            changeset_eligibility(&updated),
            Err(vec![EligibilityGap::MissingCheck {
                profile: "integration".into()
            }])
        );
        assert_eq!(
            fixture.service.get_changeset(&first.changeset_id).unwrap(),
            updated
        );
        assert_eq!(fixture.service.capture_changeset(request).unwrap(), updated);
    }

    #[test]
    fn recapture_changeset_refuses_metadata_updates_in_reserved_or_terminal_states() {
        let fixture = Fixture::new();
        fs::write(fixture.root().join("one.txt"), "agent\n").unwrap();
        let mut record = fixture.capture();
        let mut request = fixture.request();
        request.changeset_id = Some(record.changeset_id.clone());
        request.title = "Refused metadata".into();
        for state in [
            ChangesetState::Queued,
            ChangesetState::Integrating,
            ChangesetState::Merged,
            ChangesetState::RolledBack,
            ChangesetState::Abandoned,
        ] {
            record.state = state;
            let previous = record.version;
            record.version += 1;
            fixture
                .service
                .store
                .lock()
                .update_changeset(&record, previous)
                .unwrap();
            assert_eq!(
                fixture.service.capture_changeset(request.clone()),
                Err(ChangesetError::ChangesetState { state })
            );
            assert_eq!(
                fixture.service.get_changeset(&record.changeset_id).unwrap(),
                record
            );
        }
    }

    #[test]
    fn changeset_eligibility_gap_matrix_is_bound_to_the_head() {
        let mut record = sample();
        assert_eq!(
            changeset_eligibility(&record),
            Err(vec![
                EligibilityGap::MissingReview,
                EligibilityGap::MissingCheck {
                    profile: "unit".into()
                }
            ])
        );
        record.review = Some(review("head"));
        record.checks.push(check("head"));
        assert_eq!(changeset_eligibility(&record), Ok(()));
        for verdict in [
            ChangesetReviewVerdict::RequestChanges,
            ChangesetReviewVerdict::Comment,
            ChangesetReviewVerdict::Unavailable,
        ] {
            record.review.as_mut().unwrap().verdict = verdict;
            let gaps = changeset_eligibility(&record).unwrap_err();
            assert!(gaps.contains(&EligibilityGap::ReviewNotApproved));
            assert_eq!(
                gaps.contains(&EligibilityGap::MissingHumanApproval),
                verdict == ChangesetReviewVerdict::Unavailable
            );
        }
        record.review = Some(review("old"));
        assert_eq!(
            changeset_eligibility(&record),
            Err(vec![EligibilityGap::StaleHead])
        );
        record.review = Some(review("head"));
        for outcome in [
            ChangesetCheckOutcome::Failed,
            ChangesetCheckOutcome::Inconclusive,
        ] {
            record.checks[0].outcome = outcome;
            assert_eq!(
                changeset_eligibility(&record),
                Err(vec![EligibilityGap::CheckNotPassed {
                    profile: "unit".into(),
                    outcome
                }])
            );
        }
        record.checks[0] = check("old");
        assert_eq!(
            changeset_eligibility(&record),
            Err(vec![EligibilityGap::StaleHead])
        );
        record.checks[0] = check("head");
        record.review.as_mut().unwrap().requires_human_approval = true;
        assert_eq!(
            changeset_eligibility(&record),
            Err(vec![EligibilityGap::MissingHumanApproval])
        );
        record.approval = Some(ChangesetApproval {
            head_sha: "old".into(),
            approver: "user".into(),
            approved_at: 11,
        });
        let gaps = changeset_eligibility(&record).unwrap_err();
        assert!(gaps.contains(&EligibilityGap::StaleHead));
        assert!(gaps.contains(&EligibilityGap::MissingHumanApproval));
        record.approval.as_mut().unwrap().head_sha = "head".into();
        assert_eq!(changeset_eligibility(&record), Ok(()));
    }

    #[test]
    fn capture_changeset_leaves_index_head_and_branches_untouched_and_excludes_secrets() {
        let fixture = Fixture::new();
        let root = fixture.root();
        fs::write(root.join("one.txt"), "staged\n").unwrap();
        git_text(root, &["add", "one.txt"]).unwrap();
        fs::write(root.join("one.txt"), "unstaged\n").unwrap();
        fs::write(root.join(".env"), "TOKEN=secret\n").unwrap();
        fs::write(root.join(".env.local"), "IGNORED=secret\n").unwrap();
        let index_path = git_text(root, &["rev-parse", "--git-path", "index"]).unwrap();
        let before_index = fs::read(&index_path).unwrap();
        let before_head = git_text(root, &["rev-parse", "HEAD"]).unwrap();
        let before_branches = git_text(
            root,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads/",
            ],
        )
        .unwrap();
        let record = fixture.capture();
        assert_eq!(fs::read(&index_path).unwrap(), before_index);
        assert_eq!(git_text(root, &["rev-parse", "HEAD"]).unwrap(), before_head);
        assert_eq!(
            git_text(
                root,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads/"
                ]
            )
            .unwrap(),
            before_branches
        );
        assert_eq!(
            git_text(root, &["show", &format!("{}:one.txt", record.head_sha)]).unwrap(),
            "unstaged"
        );
        assert!(!git_output(
            root,
            &["cat-file", "-e", &format!("{}:.env", record.head_sha)]
        )
        .unwrap()
        .status
        .success());
        for path in [".env", ".env.local"] {
            assert!(record
                .files
                .iter()
                .any(|file| file.path == path && file.excluded && file.sensitive));
        }
        assert_eq!(record.base_sha, before_head);
        assert_eq!(record.target_ref, "refs/heads/main");
        assert_eq!(
            git_text(root, &["rev-parse", &record.change_ref]).unwrap(),
            record.head_sha
        );
        let message = git_text(root, &["show", "-s", "--format=%B", &record.head_sha]).unwrap();
        assert!(message.contains(&format!("Cognia-Changeset: {}", record.changeset_id)));
        assert!(message.contains("Cognia-Agent: unknown"));
        let identity = git_text(
            root,
            &["show", "-s", "--format=%an <%ae>", &record.head_sha],
        )
        .unwrap();
        assert_eq!(identity, "Changeset Test <changeset@test.invalid>");
    }

    #[test]
    fn capture_changeset_excluding_a_tracked_secret_does_not_delete_the_base_secret() {
        let fixture = Fixture::with_tracked_secret(true);
        fs::write(fixture.root().join(".env"), "BASE=changed-secret\n").unwrap();
        fs::write(fixture.root().join("one.txt"), "safe change\n").unwrap();
        let record = fixture.capture();
        assert_eq!(
            git_text(
                fixture.root(),
                &["show", &format!("{}:.env", record.head_sha)]
            )
            .unwrap(),
            "BASE=existing"
        );
        assert_eq!(
            record
                .files
                .iter()
                .filter(|file| file.path == ".env")
                .count(),
            1
        );
        assert!(
            record
                .files
                .iter()
                .find(|file| file.path == ".env")
                .unwrap()
                .excluded
        );
    }

    #[test]
    fn recapture_changeset_preserves_equal_head_and_invalidates_changed_head_evidence() {
        let fixture = Fixture::new();
        fs::write(fixture.root().join("one.txt"), "first\n").unwrap();
        let first = fixture.capture();
        fixture
            .service
            .mark_changeset_ready(&first.changeset_id)
            .unwrap();
        fixture
            .service
            .record_changeset_review(&first.changeset_id, review(&first.head_sha))
            .unwrap();
        fixture
            .service
            .record_changeset_check(&first.changeset_id, check(&first.head_sha))
            .unwrap();
        let approved = fixture
            .service
            .approve_changeset(&first.changeset_id, &first.head_sha, "user")
            .unwrap();
        let mut request = fixture.request();
        request.changeset_id = Some(first.changeset_id.clone());
        let unchanged = capture_changeset_core(
            &fixture.workspace,
            &request,
            None,
            Some(&approved),
            approved.updated_at + 10_000,
        )
        .unwrap();
        assert_eq!(unchanged, approved);
        assert_eq!(
            fixture.service.capture_changeset(request.clone()).unwrap(),
            approved
        );
        fs::write(fixture.root().join("one.txt"), "second\n").unwrap();
        let revised = fixture.service.capture_changeset(request).unwrap();
        assert_ne!(revised.head_sha, first.head_sha);
        assert_eq!(revised.version, approved.version + 1);
        assert_eq!(revised.created_at, approved.created_at);
        assert_eq!(revised.state, ChangesetState::Draft);
        assert_eq!(revised.review, None);
        assert!(revised.checks.is_empty());
        assert_eq!(revised.approval, None);
        assert_eq!(
            git_text(fixture.root(), &["rev-parse", &revised.change_ref]).unwrap(),
            revised.head_sha
        );
        assert!(matches!(
            fixture
                .service
                .record_changeset_review(&revised.changeset_id, review(&first.head_sha)),
            Err(ChangesetError::StaleHead { .. })
        ));
        assert!(matches!(
            fixture
                .service
                .record_changeset_check(&revised.changeset_id, check(&first.head_sha)),
            Err(ChangesetError::StaleHead { .. })
        ));
        assert!(matches!(
            fixture
                .service
                .approve_changeset(&revised.changeset_id, &first.head_sha, "user"),
            Err(ChangesetError::StaleHead { .. })
        ));
        assert_eq!(
            fixture
                .service
                .get_changeset(&revised.changeset_id)
                .unwrap(),
            revised
        );
    }

    #[test]
    fn changeset_check_replaces_profile_caps_unicode_tail_and_abandon_unpins() {
        let fixture = Fixture::new();
        fs::write(fixture.root().join("one.txt"), "changed\n").unwrap();
        let record = fixture.capture();
        let mut result = check(&record.head_sha);
        result.outcome = ChangesetCheckOutcome::Failed;
        fixture
            .service
            .record_changeset_check(&record.changeset_id, result)
            .unwrap();
        let mut result = check(&record.head_sha);
        result.log_tail = Some(format!("discard{}", "界".repeat(8000)));
        let checked = fixture
            .service
            .record_changeset_check(&record.changeset_id, result)
            .unwrap();
        assert_eq!(checked.checks.len(), 1);
        assert_eq!(checked.checks[0].outcome, ChangesetCheckOutcome::Passed);
        assert_eq!(
            checked.checks[0].log_tail.as_ref().unwrap().chars().count(),
            8000
        );
        assert_eq!(
            checked.checks[0].log_tail.as_ref().unwrap(),
            &"界".repeat(8000)
        );
        let abandoned = fixture
            .service
            .abandon_changeset(&record.changeset_id)
            .unwrap();
        assert_eq!(abandoned.state, ChangesetState::Abandoned);
        assert!(!git_output(
            fixture.root(),
            &["show-ref", "--verify", "--quiet", &record.change_ref]
        )
        .unwrap()
        .status
        .success());
        let list = fixture
            .service
            .list_changesets(ChangesetFilter {
                states: Some(vec![ChangesetState::Abandoned]),
                session_id: Some("session-capture".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(list, vec![abandoned]);
    }

    #[test]
    fn changeset_pin_recovery_restores_the_database_head_before_recapture_and_abandon() {
        for missing in [false, true] {
            let fixture = Fixture::new();
            fs::write(fixture.root().join("one.txt"), "captured work\n").unwrap();
            let record = fixture.capture();
            let mut request = fixture.request();
            request.changeset_id = Some(record.changeset_id.clone());
            fs::write(fixture.root().join("one.txt"), "work after capture\n").unwrap();
            let interrupted =
                capture_changeset_core(&fixture.workspace, &request, None, Some(&record), now_ms())
                    .unwrap();
            assert_ne!(interrupted.head_sha, record.head_sha);
            if missing {
                git_text(
                    fixture.root(),
                    &["update-ref", "-d", &record.change_ref, &record.head_sha],
                )
                .unwrap();
            } else {
                git_text(
                    fixture.root(),
                    &[
                        "update-ref",
                        &record.change_ref,
                        &interrupted.head_sha,
                        &record.head_sha,
                    ],
                )
                .unwrap();
            }
            let Fixture {
                _dir,
                service,
                workspace,
            } = fixture;
            drop(service);
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(_dir.path().join("data"))).unwrap();
            let root = Path::new(&workspace.execution_root);
            assert_eq!(
                git_text(root, &["rev-parse", "--verify", &record.change_ref]).unwrap(),
                record.head_sha
            );
            assert_eq!(service.get_changeset(&record.changeset_id).unwrap(), record);
            let recaptured = service.capture_changeset(request).unwrap();
            assert_ne!(recaptured.head_sha, record.head_sha);
            assert_eq!(
                git_text(root, &["show", &format!("{}:one.txt", recaptured.head_sha)]).unwrap(),
                "work after capture"
            );
            git_text(
                root,
                &[
                    "update-ref",
                    &record.change_ref,
                    &record.base_sha,
                    &recaptured.head_sha,
                ],
            )
            .unwrap();
            drop(service);
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(_dir.path().join("data"))).unwrap();
            assert_eq!(
                service
                    .abandon_changeset(&record.changeset_id)
                    .unwrap()
                    .state,
                ChangesetState::Abandoned
            );
            assert!(!git_output(
                root,
                &["show-ref", "--verify", "--quiet", &record.change_ref]
            )
            .unwrap()
            .status
            .success());
        }
    }

    #[test]
    fn changeset_pin_recovery_never_keeps_the_service_from_opening() {
        let fixture = Fixture::new();
        fs::write(fixture.root().join("one.txt"), "captured work\n").unwrap();
        let record = fixture.capture();
        let Fixture {
            _dir,
            service,
            workspace: _,
        } = fixture;
        drop(service);
        // The pin is gone and another writer holds its ref lock, so it cannot
        // be repaired on this open.
        let common = Path::new(&record.repo_common_dir);
        git_text(
            common,
            &["update-ref", "-d", &record.change_ref, &record.head_sha],
        )
        .unwrap();
        let lock = common.join(format!("{}.lock", record.change_ref));
        fs::create_dir_all(lock.parent().unwrap()).unwrap();
        fs::write(&lock, "").unwrap();

        let service =
            TaskWorkspaceService::open(ServiceConfig::new(_dir.path().join("data"))).unwrap();
        assert_eq!(service.get_changeset(&record.changeset_id).unwrap(), record);
        let failures = service.recover_changeset_pins().unwrap();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0, record.changeset_id);
        let maintenance = service
            .run_workspace_maintenance(Default::default())
            .unwrap();
        assert!(maintenance.events.iter().any(|event| {
            event.kind == crate::WorkspaceMaintenanceEventKind::Failed
                && event.detail.contains(&record.changeset_id)
        }));

        // Once the lock is released the next pass repairs the pin.
        fs::remove_file(&lock).unwrap();
        assert!(service.recover_changeset_pins().unwrap().is_empty());
        assert_eq!(
            git_text(common, &["rev-parse", "--verify", &record.change_ref]).unwrap(),
            record.head_sha
        );
    }

    #[test]
    fn changeset_pin_recovery_obeys_terminal_retention_without_changing_records() {
        let fixture = Fixture::new();
        fs::write(fixture.root().join("one.txt"), "captured work\n").unwrap();
        let captured = fixture.capture();
        fixture
            .service
            .set_workspace_lifecycle_policy(WorkspaceLifecyclePolicy {
                snapshot_retention_days: 1,
                ..Default::default()
            })
            .unwrap();
        let now = now_ms();
        let mut records = Vec::new();
        for (index, (state, expired, present, retained)) in [
            (ChangesetState::Draft, true, false, true),
            (ChangesetState::Merged, false, true, true),
            (ChangesetState::Merged, true, true, false),
            (ChangesetState::Merged, true, false, false),
            (ChangesetState::RolledBack, false, false, true),
            (ChangesetState::RolledBack, true, true, false),
            (ChangesetState::Abandoned, false, true, false),
            (ChangesetState::Abandoned, true, false, false),
        ]
        .into_iter()
        .enumerate()
        {
            let mut record = captured.clone();
            record.changeset_id = format!("terminal-{index}");
            record.change_ref = format!("refs/cognia/changesets/{}", record.changeset_id);
            record.state = state;
            record.updated_at = if expired {
                now - 2 * 24 * 60 * 60 * 1000
            } else {
                now
            };
            fixture
                .service
                .store
                .lock()
                .insert_changeset(&record)
                .unwrap();
            if present {
                git_text(
                    fixture.root(),
                    &["update-ref", &record.change_ref, &record.base_sha],
                )
                .unwrap();
            }
            records.push((record, retained));
        }
        let Fixture {
            _dir,
            service,
            workspace,
        } = fixture;
        drop(service);
        let service =
            TaskWorkspaceService::open(ServiceConfig::new(_dir.path().join("data"))).unwrap();
        let root = Path::new(&workspace.execution_root);
        for (record, retained) in records {
            let reference = git_output(
                root,
                &["show-ref", "--verify", "--hash", &record.change_ref],
            )
            .unwrap();
            assert_eq!(reference.status.success(), retained, "{:?}", record.state);
            if retained {
                assert_eq!(
                    String::from_utf8(reference.stdout).unwrap().trim(),
                    record.head_sha
                );
            }
            assert_eq!(service.get_changeset(&record.changeset_id).unwrap(), record);
        }
    }

    #[test]
    fn changeset_pin_recovery_keeps_removed_repositories_from_blocking_service_open() {
        let fixture = Fixture::new();
        fs::write(fixture.root().join("one.txt"), "captured work\n").unwrap();
        let record = fixture.capture();
        fixture
            .service
            .store
            .lock()
            .delete_workspace(&record.workspace_id)
            .unwrap();
        let Fixture {
            _dir,
            service,
            workspace: _,
        } = fixture;
        drop(service);
        fs::remove_dir_all(&record.repo_common_dir).unwrap();
        let service =
            TaskWorkspaceService::open(ServiceConfig::new(_dir.path().join("data"))).unwrap();
        assert_eq!(service.get_changeset(&record.changeset_id).unwrap(), record);
    }

    #[test]
    fn capture_changeset_refuses_empty_and_nonbranch_targets_but_accepts_agent_commits() {
        let fixture = Fixture::new();
        assert_eq!(
            fixture.service.capture_changeset(fixture.request()),
            Err(ChangesetError::NothingToCapture)
        );
        let mut workspace = fixture.workspace.clone();
        workspace.base = WorkspaceBaseSpec::WorkingState;
        assert_eq!(
            capture_changeset_core(&workspace, &fixture.request(), None, None, 1),
            Err(ChangesetError::TargetRequired)
        );
        workspace.base = WorkspaceBaseSpec::GitRef {
            git_ref: fixture.workspace.head.clone().unwrap(),
        };
        assert!(matches!(
            capture_changeset_core(&workspace, &fixture.request(), None, None, 1),
            Err(ChangesetError::InvalidTarget(_))
        ));
        fs::write(fixture.root().join("one.txt"), "committed\n").unwrap();
        git_text(fixture.root(), &["add", "-A"]).unwrap();
        git_text(fixture.root(), &["commit", "-m", "agent commit"]).unwrap();
        let head = git_text(fixture.root(), &["rev-parse", "HEAD"]).unwrap();
        let record = fixture.capture();
        assert_eq!(record.head_sha, head);
        assert_eq!(record.base_sha, fixture.workspace.head.clone().unwrap());
    }

    #[test]
    fn capture_changeset_refuses_sensitive_ancestor_even_after_the_secret_was_deleted() {
        let fixture = Fixture::new();
        fs::write(fixture.root().join(".env"), "TOKEN=secret\n").unwrap();
        git_text(fixture.root(), &["add", "-A"]).unwrap();
        git_text(fixture.root(), &["commit", "-m", "sensitive"]).unwrap();
        fs::remove_file(fixture.root().join(".env")).unwrap();
        fs::write(fixture.root().join("one.txt"), "safe\n").unwrap();
        git_text(fixture.root(), &["add", "-A"]).unwrap();
        git_text(fixture.root(), &["commit", "-m", "remove sensitive"]).unwrap();
        assert_eq!(
            fixture.service.capture_changeset(fixture.request()),
            Err(ChangesetError::SensitiveHistory {
                paths: vec![".env".into()]
            })
        );
        assert!(
            git_text(fixture.root(), &["for-each-ref", "refs/cognia/changesets/"])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn capture_changeset_parses_renames_tabs_newlines_binary_and_deletions() {
        let fixture = Fixture::new();
        fs::rename(
            fixture.root().join("one.txt"),
            fixture.root().join("renamed\tline\n.txt"),
        )
        .unwrap();
        fs::remove_file(fixture.root().join("two.txt")).unwrap();
        fs::write(fixture.root().join("binary.bin"), [0, 1, 2, 3]).unwrap();
        let record = fixture.capture();
        let renamed = record
            .files
            .iter()
            .find(|file| file.path == "renamed\tline\n.txt")
            .unwrap();
        assert_eq!(renamed.status, ChangesetFileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("one.txt"));
        assert_eq!(renamed.insertions, Some(0));
        assert_eq!(renamed.deletions, Some(0));
        let binary = record
            .files
            .iter()
            .find(|file| file.path == "binary.bin")
            .unwrap();
        assert!(binary.binary);
        assert_eq!(binary.insertions, None);
        assert_eq!(
            record
                .files
                .iter()
                .find(|file| file.path == "two.txt")
                .unwrap()
                .status,
            ChangesetFileStatus::Deleted
        );
    }

    #[test]
    fn changeset_store_version_cas_refuses_a_lost_update() {
        let fixture = Fixture::new();
        fs::write(fixture.root().join("one.txt"), "changed\n").unwrap();
        let record = fixture.capture();
        let mut winner = record.clone();
        winner.version += 1;
        winner.title = "winner".into();
        fixture
            .service
            .store
            .lock()
            .update_changeset(&winner, record.version)
            .unwrap();
        let mut loser = record.clone();
        loser.version += 1;
        loser.title = "loser".into();
        assert_eq!(
            fixture
                .service
                .store
                .lock()
                .update_changeset(&loser, record.version),
            Err(ChangesetError::Conflict {
                changeset_id: record.changeset_id.clone()
            })
        );
        assert_eq!(
            fixture.service.get_changeset(&record.changeset_id).unwrap(),
            winner
        );
    }

    #[test]
    fn capture_changeset_links_the_latest_workspace_run_and_its_session() {
        let fixture = Fixture::new();
        for (id, created_at) in [("latest", 20), ("older", 10)] {
            fixture
                .service
                .store
                .lock()
                .put_task(&TaskWorkspace {
                    task_id: id.into(),
                    session_id: format!("session-{id}"),
                    workspace_root: fixture.workspace.source_root.clone(),
                    state: TaskWorkspaceState::Active,
                    revision: 0,
                    created_at,
                    expires_at: created_at + 100,
                    pinned: false,
                })
                .unwrap();
            let run = TaskRun {
                run_id: format!("run-{id}"),
                task_id: id.into(),
                parent_run_id: None,
                agent_id: format!("agent-{id}"),
                agent_kind: "test-agent".into(),
                execution_root: fixture.workspace.execution_root.clone(),
                isolation_kind: IsolationKind::GitWorktree,
                isolation_ref: None,
                workspace_id: Some(fixture.workspace.workspace_id.clone()),
                base: WorkspaceBaseSpec::LocalHead,
                workspace_key: None,
                execution_run_id: None,
                trace_id: None,
                turn_id: None,
                attempt_id: None,
                provider_attempt_id: None,
                surface: None,
                tracking_policy: ResourceTrackingPolicy::default(),
                baseline_revision: 0,
                state: RunState::Ready,
                created_at,
                settled_at: Some(created_at),
            };
            fixture
                .service
                .store
                .lock()
                .put_run(&run, &serde_json::json!({}))
                .unwrap();
        }
        fs::write(fixture.root().join("one.txt"), "linked\n").unwrap();
        let record = fixture.capture();
        assert_eq!(record.run_id.as_deref(), Some("run-latest"));
        assert_eq!(record.task_id.as_deref(), Some("latest"));
        assert_eq!(record.session_id.as_deref(), Some("session-latest"));
        assert_eq!(record.agent_id.as_deref(), Some("agent-latest"));
        assert_eq!(record.agent_kind.as_deref(), Some("test-agent"));
        let message = git_text(
            fixture.root(),
            &["show", "-s", "--format=%B", &record.head_sha],
        )
        .unwrap();
        assert!(message.contains("Cognia-Agent: agent-latest"));
        assert!(message.contains("Cognia-Task: latest"));
    }

    #[test]
    fn capture_changeset_uses_fallback_identity_without_repo_configuration() {
        let fixture = Fixture::new();
        git_text(fixture.root(), &["config", "user.name", ""]).unwrap();
        git_text(fixture.root(), &["config", "user.email", ""]).unwrap();
        fs::write(fixture.root().join("one.txt"), "fallback\n").unwrap();
        let record = fixture.capture();
        assert_eq!(
            git_text(
                fixture.root(),
                &[
                    "show",
                    "-s",
                    "--format=%an <%ae>%n%cn <%ce>",
                    &record.head_sha
                ]
            )
            .unwrap(),
            "Cognia Agent <agent@cognia.invalid>\nCognia Agent <agent@cognia.invalid>"
        );
    }

    #[cfg(unix)]
    #[test]
    fn capture_changeset_disables_a_verified_index_hook() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let hooks = fixture._dir.path().join("hooks");
        fs::create_dir(&hooks).unwrap();
        let hook = hooks.join("post-index-change");
        fs::write(&hook, "#!/bin/sh\nprintf called > \"$PWD/hook-ran\"\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        git_text(
            fixture.root(),
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        )
        .unwrap();
        fs::write(fixture.root().join("one.txt"), "hook probe\n").unwrap();
        let probe = Command::new("git")
            .arg("-C")
            .arg(fixture.root())
            .args(["add", "one.txt"])
            .output()
            .unwrap();
        assert!(
            probe.status.success(),
            "{}",
            String::from_utf8_lossy(&probe.stderr)
        );
        let marker = fixture.root().join("hook-ran");
        assert!(
            marker.exists(),
            "the hook must be exercised before its suppression is tested"
        );
        fs::remove_file(&marker).unwrap();
        fixture.capture();
        assert!(!marker.exists());
    }

    #[test]
    fn capture_changeset_excludes_a_staged_sensitive_rename_without_deleting_its_source() {
        let fixture = Fixture::new();
        fs::rename(fixture.root().join("one.txt"), fixture.root().join(".env")).unwrap();
        git_text(fixture.root(), &["add", "-A"]).unwrap();
        fs::write(fixture.root().join("two.txt"), "safe change\n").unwrap();
        let record = fixture.capture();
        assert_eq!(
            git_text(
                fixture.root(),
                &["show", &format!("{}:one.txt", record.head_sha)]
            )
            .unwrap(),
            "one"
        );
        assert!(!git_output(
            fixture.root(),
            &["cat-file", "-e", &format!("{}:.env", record.head_sha)]
        )
        .unwrap()
        .status
        .success());
        let excluded = record
            .files
            .iter()
            .find(|file| file.path == ".env")
            .unwrap();
        assert_eq!(excluded.old_path.as_deref(), Some("one.txt"));
        assert!(excluded.sensitive && excluded.excluded);
    }

    #[test]
    fn capture_changeset_preserves_tracked_paths_outside_sparse_checkout() {
        let fixture = Fixture::new();
        let source = Path::new(&fixture.workspace.source_root);
        fs::create_dir(source.join("src")).unwrap();
        fs::create_dir(source.join("other")).unwrap();
        fs::write(source.join("src/keep.rs"), "fn original() {}\n").unwrap();
        fs::write(
            source.join("other/retained.txt"),
            "retained outside the sparse checkout\n",
        )
        .unwrap();
        git_text(source, &["add", "-A"]).unwrap();
        git_text(source, &["commit", "-m", "sparse baseline"]).unwrap();
        let baseline = git_text(source, &["rev-parse", "HEAD"]).unwrap();
        git_text(fixture.root(), &["checkout", "--detach", &baseline]).unwrap();
        git_text(fixture.root(), &["sparse-checkout", "init", "--cone"]).unwrap();
        git_text(fixture.root(), &["sparse-checkout", "set", "src"]).unwrap();
        assert!(!fixture.root().join("other/retained.txt").exists());
        fs::write(fixture.root().join("src/keep.rs"), "fn changed() {}\n").unwrap();
        let record = fixture.capture();
        assert_eq!(
            git_text(
                fixture.root(),
                &["show", &format!("{}:other/retained.txt", record.head_sha)]
            )
            .unwrap(),
            "retained outside the sparse checkout"
        );
        assert_eq!(record.files.len(), 1);
        assert_eq!(record.files[0].path, "src/keep.rs");
        assert_eq!(record.files[0].status, ChangesetFileStatus::Modified);
    }

    #[test]
    fn changeset_wire_contract_uses_camel_case() {
        assert_eq!(
            serde_json::to_value(ChangesetState::ChangesRequested).unwrap(),
            "changesRequested"
        );
        assert_eq!(
            serde_json::to_value(ChangesetFileStatus::TypeChanged).unwrap(),
            "typeChanged"
        );
        let value = serde_json::to_value(sample()).unwrap();
        assert_eq!(value["changesetId"], "cs");
        assert_eq!(value["baseSha"], "base");
        assert!(value.get("changeset_id").is_none());
    }
}
