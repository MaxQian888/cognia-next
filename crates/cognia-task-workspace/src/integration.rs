//! ADR-0227 composition and publication of head-bound agent changesets.

use crate::{
    changeset::{git_command, git_output, git_text, normalize_target_ref},
    service::{apply_provisioning, now_ms, read_git_worktree_inventory},
    types::*,
    ChangesetError, TaskWorkspaceService,
};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IntegrationError {
    #[error(transparent)]
    Changeset(#[from] ChangesetError),
    #[error("integration store: {0}")]
    Store(String),
    #[error("integration git: {0}")]
    Git(String),
    #[error("integration {0} not found")]
    NotFound(String),
    #[error("invalid integration request: {0}")]
    InvalidRequest(String),
    #[error("integration {integration_id} is in state {state:?}")]
    InvalidState {
        integration_id: String,
        state: IntegrationState,
    },
    #[error("integration {integration_id} reserves the repository worktree")]
    Busy { integration_id: String },
    #[error("integration {integration_id} changed concurrently")]
    Conflict { integration_id: String },
    #[error("changeset {changeset_id} is not eligible: {gaps:?}")]
    Ineligible {
        changeset_id: String,
        gaps: Vec<EligibilityGap>,
    },
    #[error("changeset {changeset_id} is in state {state:?}")]
    ChangesetState {
        changeset_id: String,
        state: ChangesetState,
    },
    #[error("changeset {changeset_id} requires dependency {dependency}")]
    Dependency {
        changeset_id: String,
        dependency: String,
    },
    #[error("changeset dependency cycles: {cycles:?}")]
    Cycles { cycles: Vec<Vec<String>> },
    #[error("candidate changed: expected {expected:?}, received {actual}")]
    StaleCandidate {
        expected: Option<String>,
        actual: String,
    },
    #[error("integration checks are incomplete: {gaps:?}")]
    Checks { gaps: Vec<EligibilityGap> },
    #[error("target is checked out with changes at {path}")]
    TargetCheckedOutDirty { path: String },
    #[error("target moved: expected {expected}, actual {actual:?}")]
    TargetMoved {
        expected: String,
        actual: Option<String>,
    },
    #[error("rollback conflicts: {files:?}")]
    RollbackConflict { files: Vec<String> },
    #[error("integration {integration_id} exhausted its three attempts")]
    AttemptsExhausted { integration_id: String },
}

impl IntegrationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Changeset(error) => error.code(),
            Self::Store(_) => "store",
            Self::Git(_) => "git",
            Self::NotFound(_) => "not_found",
            Self::InvalidRequest(_) => "invalid_request",
            Self::InvalidState { .. } => "invalid_state",
            Self::Busy { .. } => "busy",
            Self::Conflict { .. } => "conflict",
            Self::Ineligible { .. } => "ineligible",
            Self::ChangesetState { .. } => "changeset_state",
            Self::Dependency { .. } => "dependency",
            Self::Cycles { .. } => "cycles",
            Self::StaleCandidate { .. } => "stale_candidate",
            Self::Checks { .. } => "checks",
            Self::TargetCheckedOutDirty { .. } => "target_checked_out_dirty",
            Self::TargetMoved { .. } => "target_moved",
            Self::RollbackConflict { .. } => "rollback_conflict",
            Self::AttemptsExhausted { .. } => "attempts_exhausted",
        }
    }

    pub fn retryable(&self) -> bool {
        match self {
            Self::Changeset(error) => error.retryable(),
            Self::Busy { .. }
            | Self::Conflict { .. }
            | Self::TargetMoved { .. }
            | Self::StaleCandidate { .. } => true,
            Self::Store(_)
            | Self::Git(_)
            | Self::NotFound(_)
            | Self::InvalidRequest(_)
            | Self::InvalidState { .. }
            | Self::Ineligible { .. }
            | Self::ChangesetState { .. }
            | Self::Dependency { .. }
            | Self::Cycles { .. }
            | Self::Checks { .. }
            | Self::TargetCheckedOutDirty { .. }
            | Self::RollbackConflict { .. }
            | Self::AttemptsExhausted { .. } => false,
        }
    }
}

type QueueKey = (String, String);
type QueueLocks = Mutex<HashMap<QueueKey, Arc<Mutex<()>>>>;
static QUEUE_LOCKS: OnceLock<QueueLocks> = OnceLock::new();
static MERGE_TREE_SUPPORTED: OnceLock<bool> = OnceLock::new();

fn queue_lock(common_dir: &str, target: &str) -> Arc<Mutex<()>> {
    Arc::clone(
        QUEUE_LOCKS
            .get_or_init(Mutex::default)
            .lock()
            .entry((common_dir.to_string(), target.to_string()))
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    )
}

pub(crate) fn merge_tree_supported() -> bool {
    *MERGE_TREE_SUPPORTED.get_or_init(|| {
        let Ok(output) = std::process::Command::new("git").arg("version").output() else {
            return false;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let mut parts = text
            .trim()
            .strip_prefix("git version ")
            .unwrap_or("")
            .split('.');
        let major = parts
            .next()
            .and_then(|part| part.parse::<u32>().ok())
            .unwrap_or(0);
        let minor = parts
            .next()
            .and_then(|part| part.parse::<u32>().ok())
            .unwrap_or(0);
        output.status.success() && (major, minor) >= (2, 38)
    })
}

fn nul_paths(bytes: &[u8]) -> Result<Vec<String>, IntegrationError> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| {
            String::from_utf8(path.to_vec())
                .map_err(|error| IntegrationError::Git(format!("non-UTF-8 git path: {error}")))
        })
        .collect()
}

fn conflict_prediction(
    root: &Path,
    a: &str,
    b: &str,
) -> Result<Option<Vec<String>>, IntegrationError> {
    let output = git_output(
        root,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "-z",
            "--no-messages",
            a,
            b,
        ],
    )?;
    match output.status.code() {
        Some(0) => Ok(None),
        Some(1) => {
            // With -z the tree OID ends in NUL, followed by NUL-terminated
            // conflicted paths. --no-messages omits the separate message section.
            let delimiter = output
                .stdout
                .iter()
                .position(|byte| *byte == 0)
                .ok_or_else(|| IntegrationError::Git("merge-tree omitted its tree OID".into()))?;
            Ok(Some(nul_paths(&output.stdout[delimiter + 1..])?))
        }
        _ => Err(IntegrationError::Git(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        )),
    }
}

fn dependency_order(changesets: &[AgentChangeset]) -> (Vec<String>, Vec<Vec<String>>) {
    let ids: HashSet<&str> = changesets.iter().map(|c| c.changeset_id.as_str()).collect();
    let mut ready = BTreeSet::new();
    let mut remaining = HashMap::new();
    for changeset in changesets {
        let dependencies: HashSet<&str> = changeset
            .depends_on
            .iter()
            .map(String::as_str)
            .filter(|id| ids.contains(id))
            .collect();
        if dependencies.is_empty() {
            ready.insert((changeset.created_at, changeset.changeset_id.clone()));
        }
        remaining.insert(changeset.changeset_id.as_str(), dependencies);
    }
    let mut order = Vec::new();
    while let Some((_, id)) = ready.pop_first() {
        order.push(id.clone());
        for changeset in changesets {
            let dependencies = remaining
                .get_mut(changeset.changeset_id.as_str())
                .expect("indexed changeset");
            if dependencies.remove(id.as_str()) && dependencies.is_empty() {
                ready.insert((changeset.created_at, changeset.changeset_id.clone()));
            }
        }
    }
    fn visit<'a>(
        id: &'a str,
        graph: &HashMap<&'a str, HashSet<&'a str>>,
        seen: &mut HashSet<&'a str>,
        stack: &mut Vec<&'a str>,
        cycles: &mut Vec<Vec<String>>,
    ) {
        if let Some(start) = stack.iter().position(|entry| *entry == id) {
            let mut cycle: Vec<String> = stack[start..].iter().map(|s| (*s).to_string()).collect();
            cycle.sort();
            if !cycles.contains(&cycle) {
                cycles.push(cycle);
            }
            return;
        }
        if !seen.insert(id) {
            return;
        }
        stack.push(id);
        if let Some(dependencies) = graph.get(id) {
            let mut dependencies: Vec<_> = dependencies.iter().copied().collect();
            dependencies.sort();
            for dependency in dependencies {
                visit(dependency, graph, seen, stack, cycles);
            }
        }
        stack.pop();
    }
    let mut cycles = Vec::new();
    let mut seen = HashSet::new();
    for changeset in changesets {
        visit(
            &changeset.changeset_id,
            &remaining,
            &mut seen,
            &mut Vec::new(),
            &mut cycles,
        );
    }
    cycles.sort();
    (order, cycles)
}

fn changed_paths(changeset: &AgentChangeset) -> BTreeSet<String> {
    changeset
        .files
        .iter()
        .filter(|file| !file.excluded)
        .flat_map(|file| std::iter::once(file.path.clone()).chain(file.old_path.clone()))
        .collect()
}

/// Analyze immutable heads without a checkout. The capability is explicit so
/// callers can test the older-Git fallback without replacing the Git binary.
pub fn analyze_changesets(
    changesets: &[AgentChangeset],
    target_ref: Option<&str>,
    supports_merge_tree: bool,
) -> Result<IntegrationAnalysis, IntegrationError> {
    let first = changesets
        .first()
        .ok_or_else(|| IntegrationError::InvalidRequest("no changesets".into()))?;
    let root = Path::new(&first.repo_common_dir);
    let target = normalize_target_ref(root, target_ref.unwrap_or(&first.target_ref))?;
    let mut seen = HashSet::new();
    for changeset in changesets {
        if changeset.repo_common_dir != first.repo_common_dir || changeset.target_ref != target {
            return Err(IntegrationError::InvalidRequest(
                "changesets must share a repository and target ref".into(),
            ));
        }
        if !seen.insert(&changeset.changeset_id) {
            return Err(IntegrationError::InvalidRequest(
                "duplicate changeset".into(),
            ));
        }
    }
    let target_sha = git_text(root, &["rev-parse", &format!("{target}^{{commit}}")])?;
    let (order, cycles) = dependency_order(changesets);
    let mut analysis = IntegrationAnalysis {
        order,
        cycles,
        predicted_conflicts: Vec::new(),
        overlaps: Vec::new(),
        prediction: if supports_merge_tree {
            IntegrationPrediction::MergeTree
        } else {
            IntegrationPrediction::OverlapOnly
        },
    };
    for (index, a) in changesets.iter().enumerate() {
        let a_paths = changed_paths(a);
        let output = git_output(
            root,
            &["diff", "--name-only", "-z", "-M", &a.base_sha, &target_sha],
        )?;
        if !output.status.success() {
            return Err(IntegrationError::Git(
                String::from_utf8_lossy(&output.stderr).into(),
            ));
        }
        let target_paths: BTreeSet<_> = nul_paths(&output.stdout)?.into_iter().collect();
        let files: Vec<_> = a_paths.intersection(&target_paths).cloned().collect();
        if !files.is_empty() {
            analysis.overlaps.push(IntegrationOverlap {
                a: a.changeset_id.clone(),
                b: "target".into(),
                files,
            });
        }
        if supports_merge_tree {
            if let Some(files) = conflict_prediction(root, &a.head_sha, &target_sha)? {
                analysis.predicted_conflicts.push(IntegrationOverlap {
                    a: a.changeset_id.clone(),
                    b: "target".into(),
                    files,
                });
            }
        }
        for b in &changesets[index + 1..] {
            let files: Vec<_> = a_paths.intersection(&changed_paths(b)).cloned().collect();
            if !files.is_empty() {
                analysis.overlaps.push(IntegrationOverlap {
                    a: a.changeset_id.clone(),
                    b: b.changeset_id.clone(),
                    files,
                });
            }
            if supports_merge_tree {
                if let Some(files) = conflict_prediction(root, &a.head_sha, &b.head_sha)? {
                    analysis.predicted_conflicts.push(IntegrationOverlap {
                        a: a.changeset_id.clone(),
                        b: b.changeset_id.clone(),
                        files,
                    });
                }
            }
        }
    }
    Ok(analysis)
}

fn repository_key(common_dir: &str) -> String {
    hex::encode(Sha256::digest(common_dir.as_bytes()))[..16].to_string()
}

fn git_path(root: &Path, name: &str) -> Result<PathBuf, IntegrationError> {
    let path = PathBuf::from(git_text(root, &["rev-parse", "--git-path", name])?);
    Ok(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

fn abort_leftovers(root: &Path) -> Result<(), IntegrationError> {
    for (marker, command) in [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ] {
        if git_path(root, marker)?.exists() {
            git_text(root, &[command, "--abort"])?;
        }
    }
    // A sequencer may remain after its last commit but before --continue.
    if git_path(root, "sequencer")?.exists() {
        git_text(root, &["cherry-pick", "--abort"])?;
    }
    Ok(())
}

fn reset_worktree(root: &Path, sha: &str) -> Result<(), IntegrationError> {
    abort_leftovers(root)?;
    git_text(root, &["checkout", "--detach", "--force", sha])?;
    git_text(root, &["clean", "-fd"])?;
    Ok(())
}

fn ensure_integration_worktree(
    common_dir: &str,
    path: &Path,
    sha: &str,
) -> Result<(), IntegrationError> {
    let root = Path::new(common_dir);
    let expected_lock = format!("cognia-integration:{}", repository_key(common_dir));
    let inventory = read_git_worktree_inventory(root).map_err(IntegrationError::Git)?;
    let row = inventory.iter().find(|row| same_path(&row.path, path));
    if let Some(row) = row {
        if row.lock_reason.as_deref() != Some(expected_lock.as_str()) || row.branch.is_some() {
            return Err(IntegrationError::InvalidRequest(format!(
                "integration worktree ownership mismatch: {}",
                path.display()
            )));
        }
        if path.join(".git").is_file() {
            if !owned_integration_worktree(common_dir, path)? {
                return Err(IntegrationError::InvalidRequest(format!(
                    "integration checkout does not match its owner: {}",
                    path.display()
                )));
            }
            reset_worktree(path, sha)?;
            // A prior sparse run must not constrain a later full checkout.
            let sparse = git_output(path, &["config", "--bool", "core.sparseCheckout"])?;
            if String::from_utf8_lossy(&sparse.stdout).trim() == "true" {
                git_text(path, &["sparse-checkout", "disable"])?;
            }
            return Ok(());
        }
        if path.exists() {
            return Err(IntegrationError::InvalidRequest(format!(
                "invalid integration worktree contains files: {}",
                path.display()
            )));
        }
        git_text(root, &["worktree", "unlock", &path.to_string_lossy()])?;
        git_text(
            root,
            &["worktree", "remove", "--force", &path.to_string_lossy()],
        )?;
    } else if path.exists() {
        return Err(IntegrationError::InvalidRequest(format!(
            "unowned integration path: {}",
            path.display()
        )));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| IntegrationError::Git(error.to_string()))?;
    }
    git_text(
        root,
        &[
            "worktree",
            "add",
            "--detach",
            "--lock",
            "--reason",
            &expected_lock,
            &path.to_string_lossy(),
            sha,
        ],
    )?;
    Ok(())
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.canonicalize().unwrap_or_else(|_| a.to_path_buf())
        == b.canonicalize().unwrap_or_else(|_| b.to_path_buf())
}

fn owned_integration_worktree(common_dir: &str, path: &Path) -> Result<bool, IntegrationError> {
    if !path.join(".git").is_file()
        || fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_symlink())
    {
        return Ok(false);
    }
    let expected_lock = format!("cognia-integration:{}", repository_key(common_dir));
    let inventory =
        read_git_worktree_inventory(Path::new(common_dir)).map_err(IntegrationError::Git)?;
    if !inventory.iter().any(|row| {
        same_path(&row.path, path)
            && row.branch.is_none()
            && row.lock_reason.as_deref() == Some(&expected_lock)
    }) {
        return Ok(false);
    }
    let common = PathBuf::from(git_text(path, &["rev-parse", "--git-common-dir"])?);
    let common = if common.is_absolute() {
        common
    } else {
        path.join(common)
    };
    Ok(same_path(&common, Path::new(common_dir)))
}

fn unmerged_paths(root: &Path) -> Result<Vec<String>, IntegrationError> {
    let output = git_output(root, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
    if !output.status.success() {
        return Err(IntegrationError::Git(
            String::from_utf8_lossy(&output.stderr).into(),
        ));
    }
    nul_paths(&output.stdout)
}

fn internal_git(root: &Path, args: &[&str]) -> Result<std::process::Output, IntegrationError> {
    git_command(root)
        .args(["-c", "rerere.enabled=true", "-c", "rerere.autoUpdate=true"])
        .args(args)
        .output()
        .map_err(|error| IntegrationError::Git(error.to_string()))
}

fn finish_composition_step(
    root: &Path,
    output: std::process::Output,
    command: &str,
) -> Result<Result<bool, Vec<String>>, IntegrationError> {
    if output.status.success() {
        return Ok(Ok(false));
    }
    let files = unmerged_paths(root)?;
    let marker = if command == "merge" {
        "MERGE_HEAD"
    } else {
        "CHERRY_PICK_HEAD"
    };
    if files.is_empty() && git_path(root, marker)?.exists() {
        let commit = internal_git(root, &["commit", "--no-edit", "--allow-empty"])?;
        if commit.status.success() {
            return Ok(Ok(true));
        }
        return Err(IntegrationError::Git(
            String::from_utf8_lossy(&commit.stderr).into(),
        ));
    }
    if !files.is_empty() {
        git_text(root, &[command, "--abort"])?;
        return Ok(Err(files));
    }
    Err(IntegrationError::Git(
        String::from_utf8_lossy(&output.stderr).trim().into(),
    ))
}

fn compose_changeset(
    root: &Path,
    changeset: &AgentChangeset,
    strategy: IntegrationStrategy,
) -> Result<Result<(String, IntegrationItemOutcome), Vec<String>>, IntegrationError> {
    let before = git_text(root, &["rev-parse", "HEAD"])?;
    let mut rerere = false;
    let result = match strategy {
        IntegrationStrategy::Merge => {
            let message = format!(
                "{}\n\nCognia-Changeset: {}\nCognia-Agent: {}",
                changeset.title,
                changeset.changeset_id,
                changeset.agent_id.as_deref().unwrap_or("unknown")
            );
            let output = internal_git(
                root,
                &[
                    "merge",
                    "--no-ff",
                    "--no-edit",
                    "-m",
                    &message,
                    &changeset.head_sha,
                ],
            )?;
            finish_composition_step(root, output, "merge")?
        }
        IntegrationStrategy::Rebase => {
            let commits = git_text(
                root,
                &[
                    "rev-list",
                    "--reverse",
                    "--topo-order",
                    &format!("{}..{}", changeset.base_sha, changeset.head_sha),
                ],
            )?;
            let mut result = Ok(false);
            for commit in commits.lines() {
                let parents = git_text(root, &["rev-list", "--parents", "-n", "1", commit])?;
                let mut args = vec!["cherry-pick", "--allow-empty", "--keep-redundant-commits"];
                if parents.split_whitespace().count() > 2 {
                    args.extend(["-m", "1"]);
                }
                args.push(commit);
                let output = internal_git(root, &args)?;
                match finish_composition_step(root, output, "cherry-pick")? {
                    Ok(resolved) => rerere |= resolved,
                    Err(files) => {
                        result = Err(files);
                        break;
                    }
                }
            }
            result
        }
    };
    match result {
        Ok(resolved) => {
            let after = git_text(root, &["rev-parse", "HEAD"])?;
            let outcome = if after == before {
                IntegrationItemOutcome::Skipped
            } else if rerere || resolved {
                IntegrationItemOutcome::RerereResolved
            } else {
                IntegrationItemOutcome::Merged
            };
            Ok(Ok((after, outcome)))
        }
        Err(files) => {
            reset_worktree(root, &before)?;
            Ok(Err(files))
        }
    }
}

fn transition_changeset(
    record: &mut AgentChangeset,
    to: ChangesetState,
) -> Result<(), IntegrationError> {
    if record.state != to {
        crate::validate_changeset_transition(record.state, to)?;
        record.state = to;
    }
    Ok(())
}

fn versioned(mut record: AgentChangeset) -> Result<(AgentChangeset, u64), IntegrationError> {
    let version = record.version;
    record.version = version
        .checked_add(1)
        .ok_or_else(|| IntegrationError::InvalidRequest("changeset version overflow".into()))?;
    record.updated_at = now_ms();
    Ok((record, version))
}

fn is_merged(item: &IntegrationItem) -> bool {
    matches!(
        item.outcome,
        IntegrationItemOutcome::Merged | IntegrationItemOutcome::RerereResolved
    )
}

fn check_gaps(checks: &[ChangesetCheck], sha: &str, required: &[String]) -> Vec<EligibilityGap> {
    let mut gaps = Vec::new();
    for profile in required {
        match checks.iter().find(|check| &check.profile_id == profile) {
            None => gaps.push(EligibilityGap::MissingCheck {
                profile: profile.clone(),
            }),
            Some(check) if check.head_sha != sha => gaps.push(EligibilityGap::StaleHead),
            Some(check) if check.outcome != ChangesetCheckOutcome::Passed => {
                gaps.push(EligibilityGap::CheckNotPassed {
                    profile: profile.clone(),
                    outcome: check.outcome,
                })
            }
            Some(_) => {}
        }
    }
    gaps
}

impl TaskWorkspaceService {
    pub fn get_integration(&self, id: &str) -> Result<Option<IntegrationRun>, IntegrationError> {
        self.store
            .lock()
            .get_integration(id)
            .map_err(IntegrationError::Store)
    }

    pub fn list_integrations(&self) -> Result<Vec<IntegrationRun>, IntegrationError> {
        self.store
            .lock()
            .list_integrations()
            .map_err(IntegrationError::Store)
    }

    fn require_integration(&self, id: &str) -> Result<IntegrationRun, IntegrationError> {
        self.get_integration(id)?
            .ok_or_else(|| IntegrationError::NotFound(id.into()))
    }

    fn integration_changeset(&self, id: &str) -> Result<AgentChangeset, IntegrationError> {
        self.store
            .lock()
            .get_changeset(id)
            .map_err(IntegrationError::Store)?
            .ok_or_else(|| IntegrationError::InvalidRequest(format!("changeset {id} not found")))
    }

    fn with_integration_lock<T>(
        &self,
        id: &str,
        action: impl FnOnce(IntegrationRun) -> Result<T, IntegrationError>,
    ) -> Result<T, IntegrationError> {
        let run = self.require_integration(id)?;
        let target_lock = queue_lock(&run.repo_common_dir, &run.target_ref);
        let _target_guard = target_lock
            .try_lock()
            .ok_or_else(|| IntegrationError::Busy {
                integration_id: id.into(),
            })?;
        let repo_lock = queue_lock(&run.repo_common_dir, "");
        let _repo_guard = repo_lock.try_lock().ok_or_else(|| IntegrationError::Busy {
            integration_id: id.into(),
        })?;
        let _process_guard =
            self.acquire_integration_lock(&run.repo_common_dir, &run.target_ref, id)?;
        action(self.require_integration(id)?)
    }

    fn acquire_integration_lock(
        &self,
        common_dir: &str,
        target: &str,
        id: &str,
    ) -> Result<crate::integration_lock::IntegrationLockGuard, IntegrationError> {
        crate::integration_lock::try_acquire(&self.integration_dir, common_dir, target).map_err(
            |error| match error {
                crate::integration_lock::IntegrationLockError::Busy { .. } => {
                    IntegrationError::Busy {
                        integration_id: id.into(),
                    }
                }
                crate::integration_lock::IntegrationLockError::Io(error) => {
                    IntegrationError::Store(error.to_string())
                }
            },
        )
    }

    fn save_progress(
        &self,
        run: &mut IntegrationRun,
        previous: &IntegrationRun,
        changesets: &[(AgentChangeset, u64)],
    ) -> Result<(), IntegrationError> {
        run.required_checks = self.candidate_required_checks(run)?;
        run.updated_at = now_ms();
        self.store
            .lock()
            .save_integration(run, Some(previous), changesets, None)
    }

    fn candidate_required_checks(
        &self,
        run: &IntegrationRun,
    ) -> Result<Vec<String>, IntegrationError> {
        let mut checks: BTreeSet<_> = run.requested_checks.iter().cloned().collect();
        for item in run.items.iter().filter(|item| is_merged(item)) {
            checks.extend(
                self.integration_changeset(&item.changeset_id)?
                    .required_checks,
            );
        }
        Ok(checks.into_iter().collect())
    }

    pub fn analyze_integration(
        &self,
        changeset_ids: Vec<String>,
        target_ref: Option<String>,
    ) -> Result<IntegrationAnalysis, IntegrationError> {
        let changesets = changeset_ids
            .iter()
            .map(|id| self.integration_changeset(id))
            .collect::<Result<Vec<_>, _>>()?;
        analyze_changesets(&changesets, target_ref.as_deref(), merge_tree_supported())
    }

    pub fn prepare_integration(
        &self,
        request: PrepareIntegration,
    ) -> Result<IntegrationRun, IntegrationError> {
        let id = request
            .changeset_ids
            .first()
            .ok_or_else(|| IntegrationError::InvalidRequest("no changesets".into()))?;
        let first = self.integration_changeset(id)?;
        let target = normalize_target_ref(Path::new(&first.repo_common_dir), &request.target_ref)?;
        let target_lock = queue_lock(&first.repo_common_dir, &target);
        let _target_guard = target_lock
            .try_lock()
            .ok_or_else(|| IntegrationError::Busy {
                integration_id: target.clone(),
            })?;
        let repo_lock = queue_lock(&first.repo_common_dir, "");
        let _repo_guard = repo_lock.try_lock().ok_or_else(|| IntegrationError::Busy {
            integration_id: target.clone(),
        })?;
        let _process_guard =
            self.acquire_integration_lock(&first.repo_common_dir, &target, &target)?;
        self.prepare_integration_locked(request)
    }

    fn prepare_integration_locked(
        &self,
        request: PrepareIntegration,
    ) -> Result<IntegrationRun, IntegrationError> {
        let changesets = request
            .changeset_ids
            .iter()
            .map(|id| self.integration_changeset(id))
            .collect::<Result<Vec<_>, _>>()?;
        let analysis = analyze_changesets(
            &changesets,
            Some(&request.target_ref),
            merge_tree_supported(),
        )?;
        if !analysis.cycles.is_empty() {
            return Err(IntegrationError::Cycles {
                cycles: analysis.cycles,
            });
        }
        let first = &changesets[0];
        let root = Path::new(&first.repo_common_dir);
        let target_ref = normalize_target_ref(root, &request.target_ref)?;
        let expected_old_sha = git_text(root, &["rev-parse", &format!("{target_ref}^{{commit}}")])?;
        let previous = request
            .integration_id
            .as_deref()
            .map(|id| self.require_integration(id))
            .transpose()?;
        if let Some(previous) = &previous {
            if previous.state != IntegrationState::Stale {
                return Err(IntegrationError::InvalidState {
                    integration_id: previous.integration_id.clone(),
                    state: previous.state,
                });
            }
            if previous.repo_common_dir != first.repo_common_dir
                || previous.target_ref != target_ref
                || previous.strategy != request.strategy
                || previous.on_conflict != request.on_conflict
            {
                return Err(IntegrationError::InvalidRequest(
                    "rebuild cannot change the integration repository, target, or strategy".into(),
                ));
            }
            let expected_ids: HashSet<_> = previous
                .items
                .iter()
                .filter(|item| {
                    item.outcome != IntegrationItemOutcome::Dropped
                        && item.outcome != IntegrationItemOutcome::Conflicted
                })
                .map(|item| item.changeset_id.as_str())
                .collect();
            let actual_ids: HashSet<_> = request.changeset_ids.iter().map(String::as_str).collect();
            if expected_ids != actual_ids {
                return Err(IntegrationError::InvalidRequest(
                    "rebuild must retain every non-dropped, non-conflicted item".into(),
                ));
            }
            if previous.attempt >= 3 {
                let mut failed = previous.clone();
                failed.state = IntegrationState::Failed;
                failed.error = Some(IntegrationFailure {
                    code: "attemptsExhausted".into(),
                    message: "three integration attempts exhausted".into(),
                });
                self.save_progress(&mut failed, previous, &[])?;
                return Err(IntegrationError::AttemptsExhausted {
                    integration_id: previous.integration_id.clone(),
                });
            }
        }
        let ids: HashSet<_> = request.changeset_ids.iter().map(String::as_str).collect();
        for changeset in &changesets {
            if !matches!(
                changeset.state,
                ChangesetState::Approved | ChangesetState::Queued
            ) {
                return Err(IntegrationError::ChangesetState {
                    changeset_id: changeset.changeset_id.clone(),
                    state: changeset.state,
                });
            }
            crate::changeset_eligibility(changeset).map_err(|gaps| {
                IntegrationError::Ineligible {
                    changeset_id: changeset.changeset_id.clone(),
                    gaps,
                }
            })?;
            for dependency in &changeset.depends_on {
                if ids.contains(dependency.as_str()) {
                    continue;
                }
                let satisfied = self
                    .integration_changeset(dependency)
                    .ok()
                    .is_some_and(|record| {
                        record.repo_common_dir == changeset.repo_common_dir
                            && record.state == ChangesetState::Merged
                            && record.merged_sha.as_deref().is_some_and(|sha| {
                                git_output(
                                    root,
                                    &["merge-base", "--is-ancestor", sha, &expected_old_sha],
                                )
                                .is_ok_and(|output| output.status.success())
                            })
                    });
                if !satisfied {
                    return Err(IntegrationError::Dependency {
                        changeset_id: changeset.changeset_id.clone(),
                        dependency: dependency.clone(),
                    });
                }
            }
        }
        let requested_checks = request
            .required_checks
            .iter()
            .cloned()
            .chain(
                previous
                    .iter()
                    .flat_map(|run| run.requested_checks.iter().cloned()),
            )
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let integration_id = previous
            .as_ref()
            .map(|run| run.integration_id.clone())
            .unwrap_or_else(|| Uuid::now_v7().to_string());
        let worktree = self
            .integration_dir
            .join(repository_key(&first.repo_common_dir));
        let now = now_ms();
        let mut run = IntegrationRun {
            integration_id: integration_id.clone(),
            repo_common_dir: first.repo_common_dir.clone(),
            target_ref,
            strategy: request.strategy,
            on_conflict: request.on_conflict,
            expected_old_sha,
            candidate_sha: None,
            result_sha: None,
            state: IntegrationState::Preparing,
            items: analysis
                .order
                .iter()
                .map(|id| {
                    let changeset = changesets
                        .iter()
                        .find(|record| &record.changeset_id == id)
                        .expect("analyzed changeset");
                    IntegrationItem {
                        changeset_id: id.clone(),
                        head_sha: changeset.head_sha.clone(),
                        outcome: IntegrationItemOutcome::Pending,
                        conflict_files: Vec::new(),
                        commit_sha: None,
                    }
                })
                .collect(),
            worktree_path: Some(worktree.to_string_lossy().into_owned()),
            attempt: previous.as_ref().map_or(1, |run| run.attempt + 1),
            op_log: previous
                .as_ref()
                .map_or_else(Vec::new, |run| run.op_log.clone()),
            checks: Vec::new(),
            required_checks: changesets
                .iter()
                .flat_map(|changeset| changeset.required_checks.iter())
                .chain(requested_checks.iter())
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            requested_checks,
            error: None,
            created_at: previous.as_ref().map_or(now, |run| run.created_at),
            updated_at: now,
        };
        if let Some(previous) = &previous {
            run.items.extend(
                previous
                    .items
                    .iter()
                    .filter(|item| {
                        matches!(
                            item.outcome,
                            IntegrationItemOutcome::Dropped | IntegrationItemOutcome::Conflicted
                        )
                    })
                    .cloned(),
            );
        }
        let updates = changesets
            .iter()
            .cloned()
            .map(|mut changeset| {
                transition_changeset(&mut changeset, ChangesetState::Queued)?;
                changeset.integration_id = Some(integration_id.clone());
                versioned(changeset)
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.store.lock().save_integration(
            &run,
            previous.as_ref(),
            &updates,
            request.provisioning.as_ref(),
        )?;
        let result = self.compose_integration(&mut run, &worktree, request.provisioning.as_ref());
        if let Err(error) = result {
            let admin = self.git_admin_lock(Path::new(&run.repo_common_dir));
            let _admin_guard = admin.as_ref().map(|lock| lock.lock());
            // Leave a durable terminal record even for provisioning or Git
            // failures. Recovery can safely queue any still-integrating item.
            let previous = run.clone();
            run.state = IntegrationState::Failed;
            run.error = Some(IntegrationFailure {
                code: "prepareFailed".into(),
                message: error.to_string(),
            });
            let updates = self.queue_integration_changesets(&run)?;
            let cleanup = (|| {
                if owned_integration_worktree(&run.repo_common_dir, &worktree)? {
                    reset_worktree(&worktree, &run.expected_old_sha)?;
                }
                Ok::<_, IntegrationError>(())
            })();
            if let Err(cleanup) = cleanup {
                run.error = Some(IntegrationFailure {
                    code: "prepareFailed".into(),
                    message: format!("{error}; cleanup: {cleanup}"),
                });
            }
            self.save_progress(&mut run, &previous, &updates)?;
            return Err(error);
        }
        Ok(run)
    }

    fn compose_integration(
        &self,
        run: &mut IntegrationRun,
        worktree: &Path,
        provisioning: Option<&WorkspaceProvisioning>,
    ) -> Result<(), IntegrationError> {
        let admin = self.git_admin_lock(Path::new(&run.repo_common_dir));
        let _admin_guard = admin.as_ref().map(|lock| lock.lock());
        ensure_integration_worktree(&run.repo_common_dir, worktree, &run.expected_old_sha)?;
        if let Some(provisioning) = provisioning {
            let source = self
                .integration_changeset(&run.items[0].changeset_id)?
                .source_root;
            apply_provisioning(Path::new(&source), worktree, provisioning)
                .map_err(IntegrationError::Git)?;
        }
        for index in 0..run.items.len() {
            if run.items[index].outcome != IntegrationItemOutcome::Pending {
                continue;
            }
            let mut changeset = self.integration_changeset(&run.items[index].changeset_id)?;
            if changeset.head_sha != run.items[index].head_sha
                || changeset.integration_id.as_deref() != Some(&run.integration_id)
                || changeset.state != ChangesetState::Queued
            {
                return Err(IntegrationError::Conflict {
                    integration_id: run.integration_id.clone(),
                });
            }
            let dependency_skipped = changeset.depends_on.iter().any(|id| {
                run.items
                    .iter()
                    .any(|item| &item.changeset_id == id && !is_merged(item))
            });
            if dependency_skipped {
                let previous = run.clone();
                run.items[index].outcome = IntegrationItemOutcome::Skipped;
                self.save_progress(run, &previous, &[])?;
                continue;
            }
            let previous = run.clone();
            transition_changeset(&mut changeset, ChangesetState::Integrating)?;
            self.save_progress(run, &previous, &[versioned(changeset.clone())?])?;
            let composed = compose_changeset(worktree, &changeset, run.strategy)?;
            let previous = run.clone();
            match composed {
                Ok((sha, outcome)) => {
                    run.items[index].outcome = outcome;
                    if outcome == IntegrationItemOutcome::Skipped {
                        let mut changeset =
                            self.integration_changeset(&run.items[index].changeset_id)?;
                        transition_changeset(&mut changeset, ChangesetState::Queued)?;
                        self.save_progress(run, &previous, &[versioned(changeset)?])?;
                    } else {
                        run.items[index].commit_sha = Some(sha);
                        self.save_progress(run, &previous, &[])?;
                    }
                }
                Err(files) => {
                    run.items[index].outcome = IntegrationItemOutcome::Conflicted;
                    run.items[index].conflict_files = files;
                    let mut changeset =
                        self.integration_changeset(&run.items[index].changeset_id)?;
                    transition_changeset(&mut changeset, ChangesetState::Conflicted)?;
                    if run.on_conflict == IntegrationConflictPolicy::Stop {
                        run.state = IntegrationState::Conflicted;
                        for item in &mut run.items {
                            if item.outcome == IntegrationItemOutcome::Pending || is_merged(item) {
                                item.outcome = IntegrationItemOutcome::Skipped;
                                item.commit_sha = None;
                            }
                        }
                        reset_worktree(worktree, &run.expected_old_sha)?;
                    }
                    let mut updates = if run.state == IntegrationState::Conflicted {
                        self.queue_integration_changesets(run)?
                    } else {
                        Vec::new()
                    };
                    updates.retain(|(record, _)| record.changeset_id != changeset.changeset_id);
                    updates.push(versioned(changeset)?);
                    self.save_progress(run, &previous, &updates)?;
                    if run.state == IntegrationState::Conflicted {
                        return Ok(());
                    }
                }
            }
        }
        let previous = run.clone();
        if run.items.iter().any(is_merged) {
            run.candidate_sha = Some(git_text(worktree, &["rev-parse", "HEAD"])?);
            run.state = IntegrationState::Prepared;
        } else {
            run.state = IntegrationState::Conflicted;
            reset_worktree(worktree, &run.expected_old_sha)?;
        }
        self.save_progress(run, &previous, &[])
    }

    fn queue_integration_changesets(
        &self,
        run: &IntegrationRun,
    ) -> Result<Vec<(AgentChangeset, u64)>, IntegrationError> {
        let mut updates = Vec::new();
        for item in &run.items {
            let mut changeset = self.integration_changeset(&item.changeset_id)?;
            if changeset.integration_id.as_deref() == Some(run.integration_id.as_str())
                && changeset.state == ChangesetState::Integrating
            {
                transition_changeset(&mut changeset, ChangesetState::Queued)?;
                updates.push(versioned(changeset)?);
            }
        }
        Ok(updates)
    }

    pub fn record_integration_check(
        &self,
        id: &str,
        candidate_sha: &str,
        mut check: ChangesetCheck,
    ) -> Result<IntegrationRun, IntegrationError> {
        self.with_integration_lock(id, |mut run| {
            if run.state != IntegrationState::Prepared {
                return Err(IntegrationError::InvalidState {
                    integration_id: id.into(),
                    state: run.state,
                });
            }
            require_candidate(&run, candidate_sha)?;
            if check.head_sha != candidate_sha {
                return Err(IntegrationError::StaleCandidate {
                    expected: Some(candidate_sha.into()),
                    actual: check.head_sha,
                });
            }
            crate::changeset::cap_check_log(&mut check);
            let previous = run.clone();
            run.checks.retain(|old| old.profile_id != check.profile_id);
            run.checks.push(check);
            self.save_progress(&mut run, &previous, &[])?;
            Ok(run)
        })
    }

    pub fn rebuild_integration(&self, id: &str) -> Result<IntegrationRun, IntegrationError> {
        self.with_integration_lock(id, |run| {
            if run.state != IntegrationState::Stale {
                return Err(IntegrationError::InvalidState {
                    integration_id: id.into(),
                    state: run.state,
                });
            }
            let provisioning = self
                .store
                .lock()
                .integration_provisioning(id)
                .map_err(IntegrationError::Store)?;
            self.prepare_integration_locked(PrepareIntegration {
                changeset_ids: run
                    .items
                    .iter()
                    .filter(|item| {
                        !matches!(
                            item.outcome,
                            IntegrationItemOutcome::Dropped | IntegrationItemOutcome::Conflicted
                        )
                    })
                    .map(|item| item.changeset_id.clone())
                    .collect(),
                required_checks: run.requested_checks,
                target_ref: run.target_ref,
                strategy: run.strategy,
                on_conflict: run.on_conflict,
                provisioning,
                integration_id: Some(id.into()),
            })
        })
    }

    pub fn drop_integration_item(
        &self,
        id: &str,
        changeset_id: &str,
    ) -> Result<IntegrationRun, IntegrationError> {
        self.with_integration_lock(id, |mut run| {
            let admin = self.git_admin_lock(Path::new(&run.repo_common_dir));
            let _admin_guard = admin.as_ref().map(|lock| lock.lock());
            if !matches!(
                run.state,
                IntegrationState::Prepared | IntegrationState::Stale | IntegrationState::Conflicted
            ) {
                return Err(IntegrationError::InvalidState {
                    integration_id: id.into(),
                    state: run.state,
                });
            }
            let previous = run.clone();
            let item = run
                .items
                .iter_mut()
                .find(|item| item.changeset_id == changeset_id)
                .ok_or_else(|| {
                    IntegrationError::InvalidRequest("changeset is not an integration item".into())
                })?;
            if item.outcome == IntegrationItemOutcome::Dropped {
                return Ok(run);
            }
            item.outcome = IntegrationItemOutcome::Dropped;
            let mut changeset = self.integration_changeset(changeset_id)?;
            if changeset.integration_id.as_deref() != Some(id) {
                return Err(IntegrationError::Conflict {
                    integration_id: id.into(),
                });
            }
            if changeset.state == ChangesetState::Conflicted {
                transition_changeset(&mut changeset, ChangesetState::Queued)?;
            }
            if changeset.state == ChangesetState::Queued {
                transition_changeset(&mut changeset, ChangesetState::Integrating)?;
            }
            transition_changeset(&mut changeset, ChangesetState::Failed)?;
            let mut updates = self.queue_integration_changesets(&run)?;
            updates.retain(|(record, _)| record.changeset_id != changeset_id);
            updates.push(versioned(changeset)?);
            run.state = if run.items.iter().all(|item| {
                matches!(
                    item.outcome,
                    IntegrationItemOutcome::Dropped | IntegrationItemOutcome::Conflicted
                )
            }) {
                IntegrationState::Failed
            } else {
                IntegrationState::Stale
            };
            run.candidate_sha = None;
            run.checks.clear();
            self.save_progress(&mut run, &previous, &updates)?;
            self.reset_integration_if_unreserved(&run, &run.expected_old_sha)?;
            Ok(run)
        })
    }

    pub fn abort_integration(&self, id: &str) -> Result<IntegrationRun, IntegrationError> {
        self.with_integration_lock(id, |mut run| {
            let admin = self.git_admin_lock(Path::new(&run.repo_common_dir));
            let _admin_guard = admin.as_ref().map(|lock| lock.lock());
            if !matches!(
                run.state,
                IntegrationState::Preparing
                    | IntegrationState::Prepared
                    | IntegrationState::Stale
                    | IntegrationState::Conflicted
            ) {
                return Err(IntegrationError::InvalidState {
                    integration_id: id.into(),
                    state: run.state,
                });
            }
            let previous = run.clone();
            let updates = self.queue_integration_changesets(&run)?;
            run.state = IntegrationState::Aborted;
            self.reset_integration_if_unreserved(&run, &run.expected_old_sha)?;
            self.save_progress(&mut run, &previous, &updates)?;
            Ok(run)
        })
    }

    fn reset_integration_if_unreserved(
        &self,
        run: &IntegrationRun,
        sha: &str,
    ) -> Result<(), IntegrationError> {
        self.store.lock().with_integration_worktree(
            &run.repo_common_dir,
            Some(&run.integration_id),
            None,
            || {
                if let Some(path) = run
                    .worktree_path
                    .as_deref()
                    .map(Path::new)
                    .filter(|path| path.join(".git").is_file())
                {
                    if !owned_integration_worktree(&run.repo_common_dir, path)? {
                        return Err(IntegrationError::InvalidRequest(
                            "integration worktree ownership changed".into(),
                        ));
                    }
                    reset_worktree(path, sha)?;
                }
                Ok(())
            },
        )?;
        Ok(())
    }
}

fn require_candidate(run: &IntegrationRun, sha: &str) -> Result<(), IntegrationError> {
    if run.candidate_sha.as_deref() != Some(sha) {
        return Err(IntegrationError::StaleCandidate {
            expected: run.candidate_sha.clone(),
            actual: sha.into(),
        });
    }
    Ok(())
}

fn resolve_target(root: &Path, target: &str) -> Result<Option<String>, IntegrationError> {
    let output = git_output(
        root,
        &["rev-parse", "--verify", &format!("{target}^{{commit}}")],
    )?;
    if output.status.success() {
        Ok(Some(String::from_utf8_lossy(&output.stdout).trim().into()))
    } else {
        Ok(None)
    }
}

fn validate_target_checkout(
    root: &Path,
    target: &str,
    expected: &str,
) -> Result<Option<PathBuf>, IntegrationError> {
    let actual = resolve_target(root, target)?;
    if actual.as_deref() != Some(expected) {
        return Err(IntegrationError::TargetMoved {
            expected: expected.into(),
            actual,
        });
    }
    let inventory = read_git_worktree_inventory(root).map_err(IntegrationError::Git)?;
    let short = target.strip_prefix("refs/heads/").unwrap_or(target);
    let checkouts: Vec<_> = inventory
        .into_iter()
        .filter(|row| row.branch.as_deref() == Some(short))
        .collect();
    if checkouts.len() > 1 {
        return Err(IntegrationError::InvalidRequest(
            "target is checked out in multiple worktrees".into(),
        ));
    }
    let Some(checkout) = checkouts.into_iter().next() else {
        return Ok(None);
    };
    let status = git_output(
        &checkout.path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    )?;
    if !status.status.success() {
        return Err(IntegrationError::Git(
            String::from_utf8_lossy(&status.stderr).into(),
        ));
    }
    if !status.stdout.is_empty() {
        return Err(IntegrationError::TargetCheckedOutDirty {
            path: checkout.path.to_string_lossy().into_owned(),
        });
    }
    let actual = git_text(&checkout.path, &["rev-parse", "HEAD"])?;
    if actual != expected {
        return Err(IntegrationError::TargetMoved {
            expected: expected.into(),
            actual: Some(actual),
        });
    }
    Ok(Some(checkout.path))
}

fn validate_checkout_branch(path: &Path, target: &str) -> Result<(), IntegrationError> {
    let output = git_output(path, &["symbolic-ref", "--quiet", "HEAD"])?;
    if output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == target {
        return Ok(());
    }
    Err(IntegrationError::InvalidRequest(format!(
        "target checkout {} no longer owns {target}",
        path.display(),
    )))
}

fn move_target(
    root: &Path,
    target: &str,
    expected: &str,
    candidate: &str,
    id: &str,
    rollback_swap: bool,
) -> Result<(), IntegrationError> {
    let checkout = validate_target_checkout(root, target, expected)?;
    #[cfg(test)]
    tests::target_move_hook("validated");
    let update_ref = || {
        git_output(
            root,
            &[
                "update-ref",
                "-m",
                &format!("cognia integration {id}"),
                target,
                candidate,
                expected,
            ],
        )
    };
    let output = if let Some(path) = checkout {
        validate_checkout_branch(&path, target)?;
        if rollback_swap {
            let swapped = update_ref()?;
            if swapped.status.success() {
                // The branch moves only by CAS. read-tree updates the checkout
                // without changing refs and refuses conflicting local edits.
                #[cfg(test)]
                tests::target_move_hook("swapped");
                let updated = (|| {
                    validate_checkout_branch(&path, target)?;
                    let output = git_output(&path, &["read-tree", "-m", "-u", expected, candidate]);
                    if output.as_ref().is_ok_and(|output| output.status.success()) {
                        Ok(())
                    } else {
                        Err(IntegrationError::TargetCheckedOutDirty {
                            path: path.to_string_lossy().into_owned(),
                        })
                    }
                })();
                if let Err(error) = updated {
                    let restored = git_output(root, &["update-ref", target, expected, candidate])?;
                    if !restored.status.success() {
                        return Err(IntegrationError::TargetMoved {
                            expected: candidate.into(),
                            actual: resolve_target(root, target)?,
                        });
                    }
                    return Err(error);
                }
            }
            swapped
        } else {
            git_output(
                &path,
                &[
                    "merge",
                    "--ff-only",
                    "--no-edit",
                    "--no-overwrite-ignore",
                    candidate,
                ],
            )?
        }
    } else {
        update_ref()?
    };
    #[cfg(test)]
    tests::target_move_hook("moved");
    let actual = resolve_target(root, target)?;
    if output.status.success() {
        if actual.as_deref() == Some(candidate) {
            return Ok(());
        }
        return Err(IntegrationError::TargetMoved {
            expected: candidate.into(),
            actual,
        });
    }
    if actual.as_deref() != Some(expected) {
        return Err(IntegrationError::TargetMoved {
            expected: expected.into(),
            actual,
        });
    }
    Err(IntegrationError::Git(
        String::from_utf8_lossy(&output.stderr).trim().into(),
    ))
}

impl TaskWorkspaceService {
    fn finish_integration_publication(
        &self,
        run: &mut IntegrationRun,
        result: &str,
        rollback: bool,
    ) -> Result<(), IntegrationError> {
        let previous = run.clone();
        let mut updates = Vec::new();
        for item in run.items.iter().filter(|item| is_merged(item)) {
            let mut changeset = self.integration_changeset(&item.changeset_id)?;
            let target_state = if rollback {
                ChangesetState::RolledBack
            } else {
                ChangesetState::Merged
            };
            if changeset.state == target_state
                && changeset.integration_id.as_deref() == Some(run.integration_id.as_str())
            {
                continue;
            }
            if changeset.head_sha != item.head_sha
                || changeset.integration_id.as_deref() != Some(run.integration_id.as_str())
            {
                return Err(IntegrationError::Conflict {
                    integration_id: run.integration_id.clone(),
                });
            }
            transition_changeset(&mut changeset, target_state)?;
            if !rollback {
                changeset.merged_sha = Some(result.into());
            }
            updates.push(versioned(changeset)?);
        }
        run.state = if rollback {
            IntegrationState::RolledBack
        } else {
            IntegrationState::Published
        };
        if !rollback {
            run.result_sha = Some(result.into());
        }
        run.error = None;
        self.save_progress(run, &previous, &updates)
    }

    fn mark_integration_stale(
        &self,
        run: &mut IntegrationRun,
        error: &IntegrationError,
    ) -> Result<(), IntegrationError> {
        let previous = run.clone();
        run.state = IntegrationState::Stale;
        run.error = Some(IntegrationFailure {
            code: "targetMoved".into(),
            message: error.to_string(),
        });
        let updates = self.queue_integration_changesets(run)?;
        self.save_progress(run, &previous, &updates)
    }

    pub fn publish_integration(
        &self,
        id: &str,
        candidate_sha: &str,
        required_checks: Vec<String>,
    ) -> Result<IntegrationRun, IntegrationError> {
        self.with_integration_lock(id, |mut run| {
            if run.state != IntegrationState::Prepared {
                return Err(IntegrationError::InvalidState {
                    integration_id: id.into(),
                    state: run.state,
                });
            }
            require_candidate(&run, candidate_sha)?;
            let required_checks = run
                .required_checks
                .iter()
                .cloned()
                .chain(required_checks)
                .chain(self.candidate_required_checks(&run)?)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let gaps = check_gaps(&run.checks, candidate_sha, &required_checks);
            if !gaps.is_empty() {
                return Err(IntegrationError::Checks { gaps });
            }
            for item in run.items.iter().filter(|item| is_merged(item)) {
                let changeset = self.integration_changeset(&item.changeset_id)?;
                if changeset.head_sha != item.head_sha
                    || changeset.state != ChangesetState::Integrating
                    || changeset.integration_id.as_deref() != Some(id)
                {
                    return Err(IntegrationError::Conflict {
                        integration_id: id.into(),
                    });
                }
                crate::changeset_eligibility(&changeset).map_err(|gaps| {
                    IntegrationError::Ineligible {
                        changeset_id: item.changeset_id.clone(),
                        gaps,
                    }
                })?;
            }
            let root = PathBuf::from(&run.repo_common_dir);
            let admin = self.git_admin_lock(&root);
            let _admin_guard = admin.as_ref().map(|lock| lock.lock());
            if let Err(error) =
                validate_target_checkout(&root, &run.target_ref, &run.expected_old_sha)
            {
                if matches!(error, IntegrationError::TargetMoved { .. }) {
                    self.mark_integration_stale(&mut run, &error)?;
                }
                return Err(error);
            }
            // The detached candidate is immutable. A check runner may have
            // written build outputs; publication never stages those outputs.
            let ancestry = git_output(
                &root,
                &[
                    "merge-base",
                    "--is-ancestor",
                    &run.expected_old_sha,
                    candidate_sha,
                ],
            )?;
            if !ancestry.status.success() {
                return Err(IntegrationError::InvalidRequest(
                    "candidate does not descend from the expected target".into(),
                ));
            }
            let previous = run.clone();
            run.state = IntegrationState::Publishing;
            run.op_log.push(RefTransition {
                ref_name: run.target_ref.clone(),
                old_sha: run.expected_old_sha.clone(),
                new_sha: candidate_sha.into(),
                reason: "publish".into(),
                at: now_ms(),
            });
            self.save_progress(&mut run, &previous, &[])?;
            if let Err(error) = move_target(
                &root,
                &run.target_ref,
                &run.expected_old_sha,
                candidate_sha,
                id,
                false,
            ) {
                if matches!(error, IntegrationError::TargetMoved { .. }) {
                    self.mark_integration_stale(&mut run, &error)?;
                } else {
                    let previous = run.clone();
                    run.state = IntegrationState::Prepared;
                    run.error = Some(IntegrationFailure {
                        code: "publishFailed".into(),
                        message: error.to_string(),
                    });
                    self.save_progress(&mut run, &previous, &[])?;
                }
                return Err(error);
            }
            self.finish_integration_publication(&mut run, candidate_sha, false)?;
            self.reset_integration_if_unreserved(&run, candidate_sha)?;
            Ok(run)
        })
    }

    pub fn rollback_integration(&self, id: &str) -> Result<IntegrationRun, IntegrationError> {
        self.with_integration_lock(id, |mut run| {
            if run.state != IntegrationState::Published {
                return Err(IntegrationError::InvalidState {
                    integration_id: id.into(),
                    state: run.state,
                });
            }
            let root = PathBuf::from(&run.repo_common_dir);
            let result = run.result_sha.clone().ok_or_else(|| {
                IntegrationError::InvalidRequest("published run has no result".into())
            })?;
            let expected = resolve_target(&root, &run.target_ref)?.ok_or_else(|| {
                IntegrationError::TargetMoved {
                    expected: result.clone(),
                    actual: None,
                }
            })?;
            let admin = self.git_admin_lock(&root);
            let _admin_guard = admin.as_ref().map(|lock| lock.lock());
            validate_target_checkout(&root, &run.target_ref, &expected)?;
            let swap = expected == result;
            let candidate = if swap {
                run.expected_old_sha.clone()
            } else {
                let previous = run.clone();
                run.state = IntegrationState::Preparing;
                run.error = Some(IntegrationFailure {
                    code: "rollbackPreparing".into(),
                    message: "building rollback commits".into(),
                });
                self.save_progress(&mut run, &previous, &[])?;
                let path = self
                    .integration_dir
                    .join(repository_key(&run.repo_common_dir));
                let result = (|| -> Result<String, IntegrationError> {
                    ensure_integration_worktree(&run.repo_common_dir, &path, &expected)?;
                    let commits = rollback_commits(&root, &run)?;
                    for (sha, mainline) in commits {
                        let mut args = vec!["revert", "--no-edit"];
                        if mainline {
                            args.extend(["-m", "1"]);
                        }
                        args.push(&sha);
                        let output = internal_git(&path, &args)?;
                        if !output.status.success() {
                            let files = unmerged_paths(&path)?;
                            if git_path(&path, "REVERT_HEAD")?.exists()
                                || git_path(&path, "sequencer")?.exists()
                            {
                                git_text(&path, &["revert", "--abort"])?;
                            }
                            reset_worktree(&path, &expected)?;
                            if !files.is_empty() {
                                return Err(IntegrationError::RollbackConflict { files });
                            }
                            return Err(IntegrationError::Git(
                                String::from_utf8_lossy(&output.stderr).trim().into(),
                            ));
                        }
                    }
                    Ok(git_text(&path, &["rev-parse", "HEAD"])?)
                })();
                match result {
                    Ok(candidate) => {
                        run.worktree_path = Some(path.to_string_lossy().into_owned());
                        candidate
                    }
                    Err(error) => {
                        let previous = run.clone();
                        run.state = IntegrationState::Published;
                        run.error = Some(IntegrationFailure {
                            code: "rollbackFailed".into(),
                            message: error.to_string(),
                        });
                        self.save_progress(&mut run, &previous, &[])?;
                        return Err(error);
                    }
                }
            };
            // Re-read the durable payload: worktree_path may have been restored
            // after retention removed the old checkout, but the CAS compares
            // exactly the payload that was persisted before this operation.
            let previous = self.require_integration(id)?;
            run.state = IntegrationState::Publishing;
            run.op_log.push(RefTransition {
                ref_name: run.target_ref.clone(),
                old_sha: expected.clone(),
                new_sha: candidate.clone(),
                reason: if swap {
                    "rollbackSwap"
                } else {
                    "rollbackRevert"
                }
                .into(),
                at: now_ms(),
            });
            self.save_progress(&mut run, &previous, &[])?;
            if let Err(error) = move_target(&root, &run.target_ref, &expected, &candidate, id, swap)
            {
                let previous = run.clone();
                run.state = IntegrationState::Published;
                run.error = Some(IntegrationFailure {
                    code: "rollbackFailed".into(),
                    message: error.to_string(),
                });
                self.save_progress(&mut run, &previous, &[])?;
                return Err(error);
            }
            self.finish_integration_publication(&mut run, &candidate, true)?;
            self.reset_integration_if_unreserved(&run, &candidate)?;
            Ok(run)
        })
    }

    /// Finish what a crash interrupted, one run at a time. A run that cannot
    /// be recovered now is reported and left for the next pass; it never
    /// stops the others, or the service from opening. A live holder's
    /// advisory lock excludes recovery in other processes.
    pub fn recover_integrations(
        &self,
    ) -> Result<Vec<(String, IntegrationError)>, IntegrationError> {
        let mut failures = Vec::new();
        for stored in self.list_integrations()? {
            let integration_id = stored.integration_id.clone();
            if let Err(error) = self.recover_integration(stored) {
                failures.push((integration_id, error));
            }
        }
        Ok(failures)
    }

    fn recover_integration(&self, stored: IntegrationRun) -> Result<(), IntegrationError> {
        if matches!(
            stored.state,
            IntegrationState::Planned | IntegrationState::Prepared
        ) {
            return Ok(());
        }
        let target_lock = queue_lock(&stored.repo_common_dir, &stored.target_ref);
        let Some(_target_guard) = target_lock.try_lock() else {
            return Ok(());
        };
        let repo_lock = queue_lock(&stored.repo_common_dir, "");
        let Some(_repo_guard) = repo_lock.try_lock() else {
            return Ok(());
        };
        let _process_guard = match self.acquire_integration_lock(
            &stored.repo_common_dir,
            &stored.target_ref,
            &stored.integration_id,
        ) {
            Ok(guard) => guard,
            Err(IntegrationError::Busy { .. }) => return Ok(()),
            Err(error) => return Err(error),
        };
        let mut run = self.require_integration(&stored.integration_id)?;
        if matches!(
            run.state,
            IntegrationState::Planned | IntegrationState::Prepared
        ) {
            return Ok(());
        }
        let root = PathBuf::from(&run.repo_common_dir);
        // Offline source repositories remain recoverable on a later open.
        if !root.is_dir() {
            return Ok(());
        }
        let admin = self.git_admin_lock(&root);
        let _admin_guard = admin.as_ref().map(|lock| lock.lock());
        let actual = resolve_target(&root, &run.target_ref)?;
        let rollback_transition = run
            .op_log
            .last()
            .filter(|op| op.reason.starts_with("rollback"))
            .cloned();
        let rollback = (run.state == IntegrationState::Preparing
            && run
                .error
                .as_ref()
                .is_some_and(|error| error.code == "rollbackPreparing"))
            || (run.state == IntegrationState::Publishing && rollback_transition.is_some())
            || (run.state == IntegrationState::Interrupted && run.result_sha.is_some());
        if rollback {
            if run.state != IntegrationState::Preparing {
                if let Some(transition) =
                    rollback_transition.filter(|op| actual.as_deref() == Some(&op.new_sha))
                {
                    if transition.reason == "rollbackSwap" {
                        self.recover_rollback_checkout(&run, &transition)?;
                    }
                    self.finish_integration_publication(&mut run, &transition.new_sha, true)?;
                    self.reset_integration_if_unreserved(&run, &transition.new_sha)?;
                    return Ok(());
                }
            }
            // A rollback which did not move the ref is still published,
            // retaining the original result and audit log for a retry.
            let previous = run.clone();
            run.state = IntegrationState::Published;
            run.error = None;
            self.reset_integration_if_unreserved(
                &run,
                actual.as_deref().unwrap_or(&run.expected_old_sha),
            )?;
            self.save_progress(&mut run, &previous, &[])?;
            return Ok(());
        }
        if run.state == IntegrationState::Publishing {
            if let Some(result) = run
                .candidate_sha
                .clone()
                .filter(|sha| actual.as_ref() == Some(sha))
            {
                self.finish_integration_publication(&mut run, &result, false)?;
                self.reset_integration_if_unreserved(&run, &result)?;
                return Ok(());
            }
        }
        let previous = run.clone();
        if matches!(
            run.state,
            IntegrationState::Preparing
                | IntegrationState::Publishing
                | IntegrationState::Interrupted
        ) {
            run.state = IntegrationState::Interrupted;
            run.error = Some(IntegrationFailure {
                code: "interrupted".into(),
                message: "integration interrupted before publication completed".into(),
            });
            self.reset_integration_if_unreserved(
                &run,
                actual.as_deref().unwrap_or(&run.expected_old_sha),
            )?;
        }
        let mut updates = Vec::new();
        for item in &run.items {
            let mut changeset = self.integration_changeset(&item.changeset_id)?;
            if changeset.integration_id.as_deref() != Some(&run.integration_id)
                || changeset.state != ChangesetState::Integrating
            {
                continue;
            }
            if is_merged(item)
                && matches!(
                    run.state,
                    IntegrationState::Published | IntegrationState::RolledBack
                )
            {
                transition_changeset(&mut changeset, ChangesetState::Merged)?;
                changeset.merged_sha = run.result_sha.clone();
                if run.state == IntegrationState::RolledBack {
                    transition_changeset(&mut changeset, ChangesetState::RolledBack)?;
                }
            } else if item.outcome == IntegrationItemOutcome::Conflicted {
                transition_changeset(&mut changeset, ChangesetState::Conflicted)?;
            } else {
                transition_changeset(&mut changeset, ChangesetState::Queued)?;
            }
            updates.push(versioned(changeset)?);
        }
        if run != previous || !updates.is_empty() {
            self.save_progress(&mut run, &previous, &updates)?;
        }
        Ok(())
    }

    fn recover_rollback_checkout(
        &self,
        run: &IntegrationRun,
        transition: &RefTransition,
    ) -> Result<(), IntegrationError> {
        let root = Path::new(&run.repo_common_dir);
        let short = run
            .target_ref
            .strip_prefix("refs/heads/")
            .unwrap_or(&run.target_ref);
        for checkout in read_git_worktree_inventory(root)
            .map_err(IntegrationError::Git)?
            .into_iter()
            .filter(|row| row.branch.as_deref() == Some(short))
        {
            // Covers a crash after the ref CAS but before the two-tree checkout.
            validate_checkout_branch(&checkout.path, &run.target_ref)?;
            let output = git_output(
                &checkout.path,
                &[
                    "read-tree",
                    "-m",
                    "-u",
                    &transition.old_sha,
                    &transition.new_sha,
                ],
            )?;
            if !output.status.success() {
                return Err(IntegrationError::TargetCheckedOutDirty {
                    path: checkout.path.to_string_lossy().into_owned(),
                });
            }
        }
        Ok(())
    }

    pub(crate) fn maintain_integrations(
        &self,
        now: i64,
        policy: WorkspaceLifecyclePolicy,
    ) -> Vec<WorkspaceMaintenanceEvent> {
        let mut events = Vec::new();
        let window = i64::from(policy.snapshot_retention_days) * 24 * 60 * 60 * 1000;
        let changesets = match self
            .store
            .lock()
            .list_changesets(&ChangesetFilter::default())
        {
            Ok(records) => records,
            Err(error) => {
                events.push(maintenance_event(
                    now,
                    WorkspaceMaintenanceEventKind::Failed,
                    None,
                    error,
                ));
                return events;
            }
        };
        for changeset in changesets {
            if !matches!(
                changeset.state,
                ChangesetState::Merged | ChangesetState::Abandoned | ChangesetState::RolledBack
            ) || now.saturating_sub(changeset.updated_at) <= window
            {
                continue;
            }
            let result = (|| -> Result<bool, IntegrationError> {
                let root = Path::new(&changeset.repo_common_dir);
                let admin = self.git_admin_lock(root);
                let _guard = admin.as_ref().map(|lock| lock.lock());
                let current = resolve_target(root, &changeset.change_ref)?;
                let Some(head) = current else {
                    return Ok(false);
                };
                if head != changeset.head_sha {
                    return Err(IntegrationError::Conflict {
                        integration_id: changeset.changeset_id.clone(),
                    });
                }
                git_text(root, &["update-ref", "-d", &changeset.change_ref, &head])?;
                Ok(true)
            })();
            match result {
                Ok(true) => events.push(maintenance_event(
                    now,
                    WorkspaceMaintenanceEventKind::SnapshotExpired,
                    Some(changeset.workspace_id),
                    format!("expired changeset ref {}", changeset.change_ref),
                )),
                Ok(false) => {}
                Err(error) => events.push(maintenance_event(
                    now,
                    WorkspaceMaintenanceEventKind::Failed,
                    Some(changeset.workspace_id),
                    error.to_string(),
                )),
            }
        }
        let runs = match self.list_integrations() {
            Ok(runs) => runs,
            Err(error) => {
                events.push(maintenance_event(
                    now,
                    WorkspaceMaintenanceEventKind::Failed,
                    None,
                    error.to_string(),
                ));
                return events;
            }
        };
        let repos: BTreeSet<_> = runs.iter().map(|run| run.repo_common_dir.clone()).collect();
        for repo in repos {
            let repo_lock = queue_lock(&repo, "");
            let Some(_repo_guard) = repo_lock.try_lock() else {
                continue;
            };
            let _process_guard = match self.acquire_integration_lock(&repo, "", &repo) {
                Ok(guard) => guard,
                Err(IntegrationError::Busy { .. }) => continue,
                Err(error) => {
                    events.push(maintenance_event(
                        now,
                        WorkspaceMaintenanceEventKind::Failed,
                        None,
                        error.to_string(),
                    ));
                    continue;
                }
            };
            let repo_runs: Vec<_> = runs
                .iter()
                .filter(|run| run.repo_common_dir == repo)
                .collect();
            if repo_runs.iter().any(|run| {
                matches!(
                    run.state,
                    IntegrationState::Preparing
                        | IntegrationState::Prepared
                        | IntegrationState::Publishing
                ) || now.saturating_sub(run.updated_at) <= window
            }) {
                continue;
            }
            let path = self.integration_dir.join(repository_key(&repo));
            if !path.exists() {
                continue;
            }
            let root = Path::new(&repo);
            let admin = self.git_admin_lock(root);
            let _guard = admin.as_ref().map(|lock| lock.lock());
            let result = self.store.lock().with_integration_worktree(
                &repo,
                None,
                Some(now.saturating_sub(window)),
                || {
                    if worktree_touched_since(&path, now.saturating_sub(window))? {
                        return Ok(false);
                    }
                    let expected = format!("cognia-integration:{}", repository_key(&repo));
                    let inventory =
                        read_git_worktree_inventory(root).map_err(IntegrationError::Git)?;
                    let row = inventory
                        .iter()
                        .find(|row| same_path(&row.path, &path))
                        .ok_or_else(|| {
                            IntegrationError::InvalidRequest(
                                "integration worktree missing from inventory".into(),
                            )
                        })?;
                    if row.lock_reason.as_deref() != Some(&expected) {
                        return Err(IntegrationError::InvalidRequest(
                            "integration lock mismatch".into(),
                        ));
                    }
                    git_text(root, &["worktree", "unlock", &path.to_string_lossy()])?;
                    if let Err(error) = git_text(
                        root,
                        &["worktree", "remove", "--force", &path.to_string_lossy()],
                    ) {
                        let _ = git_text(
                            root,
                            &[
                                "worktree",
                                "lock",
                                "--reason",
                                &expected,
                                &path.to_string_lossy(),
                            ],
                        );
                        return Err(error.into());
                    }
                    Ok(true)
                },
            );
            let (kind, detail) = match result {
                Ok(Some(true)) => (
                    WorkspaceMaintenanceEventKind::DirectoryReclaimed,
                    format!("removed idle integration worktree {}", path.display()),
                ),
                Ok(_) => continue,
                Err(error) => (WorkspaceMaintenanceEventKind::Failed, error.to_string()),
            };
            events.push(maintenance_event(now, kind, None, detail));
        }
        events
    }
}

fn worktree_touched_since(root: &Path, cutoff: i64) -> Result<bool, IntegrationError> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| IntegrationError::Git(format!("stat {}: {error}", path.display())))?;
        let modified = metadata
            .modified()
            .map_err(|error| IntegrationError::Git(error.to_string()))?;
        if modified
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .is_some_and(|time| time.as_millis() as i64 >= cutoff)
        {
            return Ok(true);
        }
        // Cache links belong to the source repository; their targets neither
        // determine this checkout's age nor get traversed during reclamation.
        if metadata.is_dir() && !metadata.is_symlink() {
            for entry in
                fs::read_dir(&path).map_err(|error| IntegrationError::Git(error.to_string()))?
            {
                pending.push(
                    entry
                        .map_err(|error| IntegrationError::Git(error.to_string()))?
                        .path(),
                );
            }
        }
    }
    Ok(false)
}

fn rollback_commits(
    root: &Path,
    run: &IntegrationRun,
) -> Result<Vec<(String, bool)>, IntegrationError> {
    if run.strategy == IntegrationStrategy::Merge {
        let mut commits = Vec::new();
        for item in run.items.iter().rev().filter(|item| is_merged(item)) {
            let sha = item.commit_sha.as_ref().ok_or_else(|| {
                IntegrationError::InvalidRequest("merged item has no commit".into())
            })?;
            let parents = git_text(root, &["rev-list", "--parents", "-n", "1", sha])?;
            let already_present = git_output(
                root,
                &["merge-base", "--is-ancestor", sha, &run.expected_old_sha],
            )?;
            if parents.split_whitespace().count() > 2
                && !commits.iter().any(|(old, _)| old == sha)
                && !already_present.status.success()
            {
                commits.push((sha.clone(), true));
            }
        }
        Ok(commits)
    } else {
        let newest = run
            .items
            .iter()
            .rev()
            .find(|item| is_merged(item))
            .and_then(|item| item.commit_sha.as_deref())
            .ok_or_else(|| {
                IntegrationError::InvalidRequest("integration has no replayed commits".into())
            })?;
        let commits = git_text(
            root,
            &[
                "rev-list",
                "--first-parent",
                &format!("{}..{newest}", run.expected_old_sha),
            ],
        )?;
        Ok(commits.lines().map(|sha| (sha.into(), false)).collect())
    }
}

fn maintenance_event(
    now: i64,
    kind: WorkspaceMaintenanceEventKind,
    workspace_id: Option<String>,
    detail: String,
) -> WorkspaceMaintenanceEvent {
    WorkspaceMaintenanceEvent {
        event_id: Uuid::now_v7().to_string(),
        kind,
        workspace_id,
        occurred_at: now,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ServiceConfig;
    use std::{cell::Cell, process::Command};
    use tempfile::TempDir;

    #[test]
    fn integration_error_codes_and_retryability_cover_every_variant() {
        let cases = [
            (
                IntegrationError::Changeset(ChangesetError::NotFound("changeset".into())),
                "not_found",
                false,
            ),
            (IntegrationError::Store("database".into()), "store", false),
            (IntegrationError::Git("git".into()), "git", false),
            (IntegrationError::NotFound("run".into()), "not_found", false),
            (
                IntegrationError::InvalidRequest("request".into()),
                "invalid_request",
                false,
            ),
            (
                IntegrationError::InvalidState {
                    integration_id: "run".into(),
                    state: IntegrationState::Aborted,
                },
                "invalid_state",
                false,
            ),
            (
                IntegrationError::Busy {
                    integration_id: "run".into(),
                },
                "busy",
                true,
            ),
            (
                IntegrationError::Conflict {
                    integration_id: "run".into(),
                },
                "conflict",
                true,
            ),
            (
                IntegrationError::Ineligible {
                    changeset_id: "changeset".into(),
                    gaps: vec![EligibilityGap::MissingReview],
                },
                "ineligible",
                false,
            ),
            (
                IntegrationError::ChangesetState {
                    changeset_id: "changeset".into(),
                    state: ChangesetState::Draft,
                },
                "changeset_state",
                false,
            ),
            (
                IntegrationError::Dependency {
                    changeset_id: "changeset".into(),
                    dependency: "other".into(),
                },
                "dependency",
                false,
            ),
            (
                IntegrationError::Cycles {
                    cycles: vec![vec!["first".into(), "second".into()]],
                },
                "cycles",
                false,
            ),
            (
                IntegrationError::StaleCandidate {
                    expected: Some("current".into()),
                    actual: "stale".into(),
                },
                "stale_candidate",
                true,
            ),
            (
                IntegrationError::Checks {
                    gaps: vec![EligibilityGap::MissingCheck {
                        profile: "unit".into(),
                    }],
                },
                "checks",
                false,
            ),
            (
                IntegrationError::TargetCheckedOutDirty {
                    path: "/repo".into(),
                },
                "target_checked_out_dirty",
                false,
            ),
            (
                IntegrationError::TargetMoved {
                    expected: "previous".into(),
                    actual: Some("current".into()),
                },
                "target_moved",
                true,
            ),
            (
                IntegrationError::RollbackConflict {
                    files: vec!["shared.txt".into()],
                },
                "rollback_conflict",
                false,
            ),
            (
                IntegrationError::AttemptsExhausted {
                    integration_id: "run".into(),
                },
                "attempts_exhausted",
                false,
            ),
        ];
        for (error, code, retryable) in cases {
            assert_eq!(error.code(), code, "{error:?}");
            assert_eq!(error.retryable(), retryable, "{error:?}");
        }
    }

    #[test]
    fn integration_changeset_errors_delegate_their_code_and_retryability() {
        for inner in [
            ChangesetError::Conflict {
                changeset_id: "changeset".into(),
            },
            ChangesetError::StaleHead {
                expected: "current".into(),
                actual: "stale".into(),
            },
            ChangesetError::InvalidInput("request".into()),
        ] {
            let code = inner.code();
            let retryable = inner.retryable();
            let wrapped = IntegrationError::Changeset(inner);
            assert_eq!(wrapped.code(), code);
            assert_eq!(wrapped.retryable(), retryable);
        }
    }

    fn git_result(root: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap()
    }

    fn git(root: &Path, args: &[&str]) -> String {
        let output = git_result(root, args);
        assert!(
            output.status.success(),
            "git {args:?} in {}: {}",
            root.display(),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    struct Fixture {
        service: TaskWorkspaceService,
        source: PathBuf,
        data: PathBuf,
        sequence: Cell<i64>,
        _dir: TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = TempDir::new().unwrap();
            let root = dir.path().canonicalize().unwrap();
            let source = root.join("source");
            let data = root.join("data");
            fs::create_dir(&source).unwrap();
            git(&source, &["init", "-b", "main"]);
            git(&source, &["config", "user.name", "Integration Test"]);
            git(
                &source,
                &["config", "user.email", "integration@test.invalid"],
            );
            for (path, content) in [
                ("shared.txt", "base\n"),
                ("left.txt", "left base\n"),
                ("right.txt", "right base\n"),
                (".gitignore", "ignored/\n"),
            ] {
                fs::write(source.join(path), content).unwrap();
            }
            git(&source, &["add", "-A"]);
            git(&source, &["commit", "-m", "initial"]);
            let source = source.canonicalize().unwrap();
            let service = TaskWorkspaceService::open(ServiceConfig::new(data.clone())).unwrap();
            Self {
                service,
                source,
                data,
                sequence: Cell::new(1),
                _dir: dir,
            }
        }

        fn workspace(&self, name: &str) -> WorkspaceRecord {
            let bundle = self
                .service
                .acquire_workspace_bundle(AcquireWorkspaceBundle {
                    owner_type: WorkspaceOwnerType::Session,
                    owner_ref: Some(format!("session-{name}")),
                    project_id: None,
                    environment_kind: WorkspaceEnvironmentKind::Managed,
                    base: WorkspaceBaseSpec::LocalHead,
                    roots: vec![WorkspaceBundleRootInput {
                        logical_root_id: "primary".into(),
                        role: WorkspaceRootRole::Primary,
                        source_root: self.source.to_string_lossy().into_owned(),
                    }],
                    provisioning: None,
                    requested_name: None,
                })
                .unwrap();
            self.service
                .registry
                .get(&bundle.leases[0].workspace_id)
                .unwrap()
                .unwrap()
        }

        fn capture_workspace(&self, workspace: &WorkspaceRecord, name: &str) -> AgentChangeset {
            let captured = self
                .service
                .capture_changeset(CaptureChangeset {
                    workspace_id: workspace.workspace_id.clone(),
                    target_ref: Some("main".into()),
                    title: name.into(),
                    depends_on: Vec::new(),
                    required_checks: Vec::new(),
                    changeset_id: None,
                })
                .unwrap();
            self.service
                .mark_changeset_ready(&captured.changeset_id)
                .unwrap();
            let mut approved = self
                .service
                .record_changeset_review(
                    &captured.changeset_id,
                    ChangesetReview {
                        head_sha: captured.head_sha,
                        verdict: ChangesetReviewVerdict::Approve,
                        reviewer: ChangesetReviewer::Deterministic,
                        risk_tier: ChangesetRiskTier::Low,
                        reasons: vec!["Reviewed test change".into()],
                        findings: Vec::new(),
                        requires_human_approval: false,
                        recorded_at: now_ms(),
                    },
                )
                .unwrap();
            let version = approved.version;
            approved.created_at = self.sequence.get();
            self.sequence.set(self.sequence.get() + 1);
            approved.version += 1;
            self.service
                .store
                .lock()
                .update_changeset(&approved, version)
                .unwrap();
            approved
        }

        fn capture(&self, name: &str, edits: &[(&str, &str)]) -> AgentChangeset {
            let workspace = self.workspace(name);
            for (path, content) in edits {
                let path = Path::new(&workspace.execution_root).join(path);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, content).unwrap();
            }
            self.capture_workspace(&workspace, name)
        }

        fn request(
            &self,
            changesets: &[&AgentChangeset],
            strategy: IntegrationStrategy,
            on_conflict: IntegrationConflictPolicy,
        ) -> PrepareIntegration {
            PrepareIntegration {
                changeset_ids: changesets.iter().map(|c| c.changeset_id.clone()).collect(),
                required_checks: Vec::new(),
                target_ref: "refs/heads/main".into(),
                strategy,
                on_conflict,
                provisioning: None,
                integration_id: None,
            }
        }

        fn prepare(&self, changesets: &[&AgentChangeset]) -> IntegrationRun {
            self.service
                .prepare_integration(self.request(
                    changesets,
                    IntegrationStrategy::Merge,
                    IntegrationConflictPolicy::Skip,
                ))
                .unwrap()
        }

        fn publish(&self, run: &IntegrationRun) -> IntegrationRun {
            self.service
                .publish_integration(
                    &run.integration_id,
                    run.candidate_sha.as_deref().unwrap(),
                    Vec::new(),
                )
                .unwrap()
        }

        fn target(&self) -> String {
            git(&self.source, &["rev-parse", "refs/heads/main"])
        }

        fn commit_target(&self, path: &str, content: &str) -> String {
            fs::write(self.source.join(path), content).unwrap();
            git(&self.source, &["add", "--", path]);
            git(&self.source, &["commit", "-m", "external target change"]);
            self.target()
        }

        fn reopen(&mut self) {
            self.service =
                TaskWorkspaceService::open(ServiceConfig::new(self.data.clone())).unwrap();
        }
    }

    fn candidate_file(run: &IntegrationRun, path: &str) -> String {
        git(
            Path::new(&run.repo_common_dir),
            &[
                "show",
                &format!("{}:{path}", run.candidate_sha.as_deref().unwrap()),
            ],
        )
    }

    fn check(head: &str, outcome: ChangesetCheckOutcome) -> ChangesetCheck {
        ChangesetCheck {
            head_sha: head.into(),
            profile_id: "unit".into(),
            outcome,
            tier: Some("sandbox".into()),
            report_digest: None,
            log_tail: None,
            ran_at: now_ms(),
        }
    }

    #[test]
    fn analysis_predicts_pair_and_target_conflicts_and_has_an_explicit_fallback() {
        let fixture = Fixture::new();
        let a = fixture.capture("a", &[("shared.txt", "agent a\n")]);
        let b = fixture.capture("b", &[("shared.txt", "agent b\n")]);
        let disjoint = fixture.capture("disjoint", &[("right.txt", "disjoint\n")]);
        fixture.commit_target("shared.txt", "target\n");
        let records = [a.clone(), b.clone(), disjoint.clone()];
        let analysis = analyze_changesets(&records, None, true).unwrap();
        assert_eq!(analysis.prediction, IntegrationPrediction::MergeTree);
        for (left, right) in [
            (&a.changeset_id, "target"),
            (&b.changeset_id, "target"),
            (&a.changeset_id, b.changeset_id.as_str()),
        ] {
            assert!(analysis
                .predicted_conflicts
                .iter()
                .any(|conflict| &conflict.a == left
                    && conflict.b == right
                    && conflict.files == ["shared.txt"]));
        }
        assert!(!analysis
            .predicted_conflicts
            .iter()
            .any(|conflict| conflict.a == disjoint.changeset_id
                || conflict.b == disjoint.changeset_id));
        let fallback = analyze_changesets(&records, None, false).unwrap();
        assert_eq!(fallback.prediction, IntegrationPrediction::OverlapOnly);
        assert!(fallback.predicted_conflicts.is_empty());
        assert_eq!(fallback.overlaps, analysis.overlaps);
        assert_eq!(fallback.order, analysis.order);
    }

    #[test]
    fn analysis_orders_dependencies_then_capture_time_and_prepare_refuses_cycles() {
        let fixture = Fixture::new();
        let mut first = fixture.capture("first", &[("left.txt", "first\n")]);
        let mut second = fixture.capture("second", &[("right.txt", "second\n")]);
        let mut third = fixture.capture("third", &[("third.txt", "third\n")]);
        let independent = fixture.capture("independent", &[("other.txt", "other\n")]);
        second.depends_on = vec![first.changeset_id.clone()];
        third.depends_on = vec![second.changeset_id.clone()];
        third.created_at = 0;
        let records = [
            third.clone(),
            independent.clone(),
            second.clone(),
            first.clone(),
        ];
        let analysis = analyze_changesets(&records, None, false).unwrap();
        assert_eq!(
            analysis.order,
            [
                first.changeset_id.clone(),
                second.changeset_id.clone(),
                third.changeset_id.clone(),
                independent.changeset_id.clone()
            ]
        );
        assert!(analysis.cycles.is_empty());
        first.depends_on = vec![third.changeset_id.clone()];
        for record in [&mut first, &mut second, &mut third] {
            let version = record.version;
            record.version += 1;
            fixture
                .service
                .store
                .lock()
                .update_changeset(record, version)
                .unwrap();
        }
        let error = fixture
            .service
            .prepare_integration(fixture.request(
                &[&first, &second, &third],
                IntegrationStrategy::Merge,
                IntegrationConflictPolicy::Skip,
            ))
            .unwrap_err();
        match error {
            IntegrationError::Cycles { cycles } => {
                let mut expected =
                    vec![first.changeset_id, second.changeset_id, third.changeset_id];
                expected.sort();
                assert_eq!(cycles, vec![expected]);
            }
            other => panic!("expected dependency cycle, got {other:?}"),
        }
        assert!(fixture.service.list_integrations().unwrap().is_empty());
    }

    #[test]
    fn prepare_skip_keeps_both_disjoint_changes_and_records_the_conflicting_item() {
        let fixture = Fixture::new();
        let left = fixture.capture("left", &[("left.txt", "left change\n")]);
        let conflict = fixture.capture("conflict", &[("shared.txt", "agent change\n")]);
        let right = fixture.capture("right", &[("right.txt", "right change\n")]);
        let target = fixture.commit_target("shared.txt", "target change\n");
        let run = fixture.prepare(&[&right, &conflict, &left]);
        assert_eq!(run.state, IntegrationState::Prepared);
        assert_eq!(fixture.target(), target);
        assert_eq!(candidate_file(&run, "left.txt"), "left change");
        assert_eq!(candidate_file(&run, "right.txt"), "right change");
        assert_eq!(candidate_file(&run, "shared.txt"), "target change");
        assert_eq!(run.items[1].changeset_id, conflict.changeset_id);
        assert_eq!(run.items[1].outcome, IntegrationItemOutcome::Conflicted);
        assert_eq!(run.items[1].conflict_files, ["shared.txt"]);
        assert_eq!(
            fixture
                .service
                .get_changeset(&conflict.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Conflicted
        );
        assert!(is_merged(&run.items[0]) && is_merged(&run.items[2]));
        let published = fixture.publish(&run);
        assert_eq!(published.state, IntegrationState::Published);
        assert_eq!(
            fixture
                .service
                .get_changeset(&left.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Merged
        );
        assert_eq!(
            fixture
                .service
                .get_changeset(&right.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Merged
        );
        assert_eq!(
            fixture
                .service
                .get_changeset(&conflict.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Conflicted
        );
    }

    #[test]
    fn prepare_stop_resets_the_candidate_and_leaves_the_target_untouched() {
        let fixture = Fixture::new();
        let left = fixture.capture("left", &[("left.txt", "left change\n")]);
        let conflict = fixture.capture("conflict", &[("shared.txt", "agent change\n")]);
        let right = fixture.capture("right", &[("right.txt", "right change\n")]);
        let target = fixture.commit_target("shared.txt", "target change\n");
        let run = fixture
            .service
            .prepare_integration(fixture.request(
                &[&right, &left, &conflict],
                IntegrationStrategy::Merge,
                IntegrationConflictPolicy::Stop,
            ))
            .unwrap();
        assert_eq!(run.state, IntegrationState::Conflicted);
        assert!(run.candidate_sha.is_none());
        assert_eq!(fixture.target(), target);
        assert_eq!(
            git(
                Path::new(run.worktree_path.as_deref().unwrap()),
                &["rev-parse", "HEAD"]
            ),
            target
        );
        assert_eq!(run.items[1].outcome, IntegrationItemOutcome::Conflicted);
        assert_eq!(run.items[2].outcome, IntegrationItemOutcome::Skipped);
        assert_eq!(
            fixture
                .service
                .get_changeset(&right.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Queued
        );
        assert_eq!(
            fixture
                .service
                .get_changeset(&conflict.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Conflicted
        );
    }

    #[test]
    fn rerere_reuses_a_recorded_resolution_and_marks_the_second_item_resolved() {
        let fixture = Fixture::new();
        let first = fixture.capture("first-conflict", &[("shared.txt", "agent\n")]);
        let second = fixture.capture("second-conflict", &[("shared.txt", "agent\n")]);
        let target = fixture.commit_target("shared.txt", "target\n");
        let conflicted = fixture.prepare(&[&first]);
        assert_eq!(conflicted.state, IntegrationState::Conflicted);
        let worktree = Path::new(conflicted.worktree_path.as_deref().unwrap());
        let output = git_result(
            worktree,
            &[
                "-c",
                "rerere.enabled=true",
                "-c",
                "rerere.autoUpdate=true",
                "merge",
                "--no-ff",
                "--no-edit",
                &first.head_sha,
            ],
        );
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(unmerged_paths(worktree).unwrap(), ["shared.txt"]);
        fs::write(worktree.join("shared.txt"), "target and agent\n").unwrap();
        git(worktree, &["add", "shared.txt"]);
        git(worktree, &["-c", "rerere.enabled=true", "rerere"]);
        git(
            worktree,
            &[
                "-c",
                "rerere.enabled=true",
                "commit",
                "-m",
                "record resolution",
            ],
        );
        fixture
            .service
            .abort_integration(&conflicted.integration_id)
            .unwrap();

        let prepared = fixture.prepare(&[&second]);
        assert_eq!(prepared.state, IntegrationState::Prepared);
        assert_eq!(
            prepared.items[0].outcome,
            IntegrationItemOutcome::RerereResolved
        );
        assert_eq!(candidate_file(&prepared, "shared.txt"), "target and agent");
        assert_eq!(fixture.target(), target);
    }

    #[test]
    fn publish_update_ref_requires_checks_bound_to_the_exact_candidate() {
        let fixture = Fixture::new();
        let changeset = fixture.capture("publish", &[("left.txt", "published\n")]);
        let old = fixture.target();
        git(&fixture.source, &["checkout", "--detach", "HEAD"]);
        let run = fixture.prepare(&[&changeset]);
        let candidate = run.candidate_sha.as_deref().unwrap();
        let error = fixture
            .service
            .publish_integration(&run.integration_id, candidate, vec!["unit".into()])
            .unwrap_err();
        assert!(matches!(error, IntegrationError::Checks { gaps }
            if gaps == [EligibilityGap::MissingCheck { profile: "unit".into() }]));
        assert_eq!(fixture.target(), old);
        assert!(matches!(
            fixture
                .service
                .record_integration_check(
                    &run.integration_id,
                    &old,
                    check(&old, ChangesetCheckOutcome::Passed)
                )
                .unwrap_err(),
            IntegrationError::StaleCandidate { .. }
        ));
        assert!(matches!(
            fixture
                .service
                .record_integration_check(
                    &run.integration_id,
                    candidate,
                    check(&old, ChangesetCheckOutcome::Passed)
                )
                .unwrap_err(),
            IntegrationError::StaleCandidate { .. }
        ));
        fixture
            .service
            .record_integration_check(
                &run.integration_id,
                candidate,
                check(candidate, ChangesetCheckOutcome::Failed),
            )
            .unwrap();
        assert!(matches!(
            fixture
                .service
                .publish_integration(&run.integration_id, candidate, vec!["unit".into()])
                .unwrap_err(),
            IntegrationError::Checks { .. }
        ));
        let mut passed = check(candidate, ChangesetCheckOutcome::Passed);
        passed.log_tail = Some("界".repeat(9_000));
        let checked = fixture
            .service
            .record_integration_check(&run.integration_id, candidate, passed)
            .unwrap();
        assert_eq!(checked.checks.len(), 1);
        assert_eq!(
            checked.checks[0]
                .log_tail
                .as_deref()
                .unwrap()
                .chars()
                .count(),
            8_000
        );
        let published = fixture
            .service
            .publish_integration(&run.integration_id, candidate, vec!["unit".into()])
            .unwrap();
        assert_eq!(published.state, IntegrationState::Published);
        assert_eq!(published.result_sha.as_deref(), Some(candidate));
        assert_eq!(fixture.target(), candidate);
        assert_eq!(git(&fixture.source, &["rev-parse", "HEAD"]), old);
        assert_eq!(published.op_log.len(), 1);
        assert_eq!(published.op_log[0].old_sha, old);
        assert_eq!(published.op_log[0].new_sha, candidate);
        let merged = fixture
            .service
            .get_changeset(&changeset.changeset_id)
            .unwrap();
        assert_eq!(merged.state, ChangesetState::Merged);
        assert_eq!(merged.merged_sha.as_deref(), Some(candidate));
        assert_eq!(
            merged.integration_id.as_deref(),
            Some(run.integration_id.as_str())
        );
    }

    #[test]
    fn moved_target_is_stale_and_rebuild_uses_the_new_tip() {
        let fixture = Fixture::new();
        let changeset = fixture.capture("rebuild", &[("left.txt", "agent\n")]);
        let run = fixture.prepare(&[&changeset]);
        let moved = fixture.commit_target("right.txt", "external\n");
        let error = fixture
            .service
            .publish_integration(
                &run.integration_id,
                run.candidate_sha.as_deref().unwrap(),
                Vec::new(),
            )
            .unwrap_err();
        assert_eq!(
            error,
            IntegrationError::TargetMoved {
                expected: run.expected_old_sha.clone(),
                actual: Some(moved.clone())
            }
        );
        assert_eq!(
            fixture
                .service
                .get_integration(&run.integration_id)
                .unwrap()
                .unwrap()
                .state,
            IntegrationState::Stale
        );
        assert_eq!(
            fixture
                .service
                .get_changeset(&changeset.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Queued
        );
        let rebuilt = fixture
            .service
            .rebuild_integration(&run.integration_id)
            .unwrap();
        assert_eq!(rebuilt.state, IntegrationState::Prepared);
        assert_eq!(rebuilt.attempt, 2);
        assert_eq!(rebuilt.expected_old_sha, moved);
        assert_eq!(rebuilt.worktree_path, run.worktree_path);
        assert_eq!(candidate_file(&rebuilt, "left.txt"), "agent");
        assert_eq!(candidate_file(&rebuilt, "right.txt"), "external");
        fixture.publish(&rebuilt);
        assert_eq!(fixture.target(), rebuilt.candidate_sha.unwrap());
    }

    #[test]
    fn publish_fast_forwards_a_clean_checkout_and_preserves_untracked_files() {
        let fixture = Fixture::new();
        let changeset = fixture.capture("checkout", &[("left.txt", "agent\n")]);
        let run = fixture.prepare(&[&changeset]);
        fs::write(fixture.source.join("local.txt"), "untracked\n").unwrap();
        let published = fixture.publish(&run);
        assert_eq!(
            git(&fixture.source, &["rev-parse", "HEAD"]),
            published.result_sha.unwrap()
        );
        assert_eq!(
            fs::read_to_string(fixture.source.join("left.txt")).unwrap(),
            "agent\n"
        );
        assert_eq!(
            fs::read_to_string(fixture.source.join("local.txt")).unwrap(),
            "untracked\n"
        );
        assert!(git(
            &fixture.source,
            &["status", "--porcelain", "--untracked-files=no"]
        )
        .is_empty());
    }

    #[test]
    fn publish_refuses_a_dirty_checkout_without_moving_any_ref_or_losing_edits() {
        for staged in [false, true] {
            let fixture = Fixture::new();
            let changeset = fixture.capture("dirty", &[("left.txt", "agent\n")]);
            let run = fixture.prepare(&[&changeset]);
            fs::write(fixture.source.join("right.txt"), "user edit\n").unwrap();
            if staged {
                git(&fixture.source, &["add", "right.txt"]);
            }
            let before = git(&fixture.source, &["show-ref", "--heads"]);
            let status = git(&fixture.source, &["status", "--porcelain"]);
            let error = fixture
                .service
                .publish_integration(
                    &run.integration_id,
                    run.candidate_sha.as_deref().unwrap(),
                    Vec::new(),
                )
                .unwrap_err();
            assert!(
                matches!(error, IntegrationError::TargetCheckedOutDirty { path }
                if Path::new(&path) == fixture.source)
            );
            assert_eq!(git(&fixture.source, &["show-ref", "--heads"]), before);
            assert_eq!(git(&fixture.source, &["status", "--porcelain"]), status);
            assert_eq!(
                fs::read_to_string(fixture.source.join("right.txt")).unwrap(),
                "user edit\n"
            );
            let stored = fixture
                .service
                .get_integration(&run.integration_id)
                .unwrap()
                .unwrap();
            assert_eq!(stored.state, IntegrationState::Prepared);
            assert!(stored.op_log.is_empty());
        }
    }

    #[test]
    fn rollback_swaps_the_ref_back_with_or_without_a_checked_out_target() {
        for detached in [false, true] {
            let fixture = Fixture::new();
            let changeset = fixture.capture("rollback-swap", &[("left.txt", "agent\n")]);
            if detached {
                git(&fixture.source, &["checkout", "--detach", "HEAD"]);
            }
            let prepared = fixture.prepare(&[&changeset]);
            let published = fixture.publish(&prepared);
            let rolled_back = fixture
                .service
                .rollback_integration(&published.integration_id)
                .unwrap();
            assert_eq!(rolled_back.state, IntegrationState::RolledBack);
            assert_eq!(fixture.target(), prepared.expected_old_sha);
            assert_eq!(
                git(&fixture.source, &["rev-parse", "HEAD"]),
                prepared.expected_old_sha
            );
            assert_eq!(
                fs::read_to_string(fixture.source.join("left.txt")).unwrap(),
                "left base\n"
            );
            assert_eq!(rolled_back.op_log.len(), 2);
            assert_eq!(rolled_back.op_log[1].reason, "rollbackSwap");
            assert_eq!(rolled_back.op_log[1].old_sha, published.result_sha.unwrap());
            assert_eq!(rolled_back.op_log[1].new_sha, prepared.expected_old_sha);
            assert_eq!(
                fixture
                    .service
                    .get_changeset(&changeset.changeset_id)
                    .unwrap()
                    .state,
                ChangesetState::RolledBack
            );
        }
    }

    #[test]
    fn rollback_reverts_merge_and_rebase_results_while_preserving_later_target_commits() {
        for strategy in [IntegrationStrategy::Merge, IntegrationStrategy::Rebase] {
            let fixture = Fixture::new();
            let workspace = fixture.workspace("multi-commit");
            let root = Path::new(&workspace.execution_root);
            fs::write(root.join("left.txt"), "agent first commit\n").unwrap();
            git(root, &["add", "left.txt"]);
            git(root, &["commit", "-m", "agent first"]);
            fs::write(root.join("agent-added.txt"), "agent second commit\n").unwrap();
            git(root, &["add", "agent-added.txt"]);
            git(root, &["commit", "-m", "agent second"]);
            let left = fixture.capture_workspace(&workspace, "multi-commit");
            let right = fixture.capture("right", &[("right.txt", "agent right\n")]);
            let prepared = fixture
                .service
                .prepare_integration(fixture.request(
                    &[&left, &right],
                    strategy,
                    IntegrationConflictPolicy::Skip,
                ))
                .unwrap();
            let published = fixture.publish(&prepared);
            let advanced = fixture.commit_target("later.txt", "later user work\n");
            let rolled_back = fixture
                .service
                .rollback_integration(&published.integration_id)
                .unwrap();
            assert_eq!(rolled_back.state, IntegrationState::RolledBack);
            assert_eq!(rolled_back.op_log.last().unwrap().reason, "rollbackRevert");
            assert_eq!(rolled_back.op_log.last().unwrap().old_sha, advanced);
            assert_ne!(fixture.target(), advanced);
            assert_ne!(fixture.target(), published.result_sha.unwrap());
            git(
                &fixture.source,
                &["merge-base", "--is-ancestor", &advanced, "HEAD"],
            );
            assert_eq!(
                fs::read_to_string(fixture.source.join("left.txt")).unwrap(),
                "left base\n"
            );
            assert_eq!(
                fs::read_to_string(fixture.source.join("right.txt")).unwrap(),
                "right base\n"
            );
            assert!(!fixture.source.join("agent-added.txt").exists());
            assert_eq!(
                fs::read_to_string(fixture.source.join("later.txt")).unwrap(),
                "later user work\n"
            );
            for changeset in [&left, &right] {
                assert_eq!(
                    fixture
                        .service
                        .get_changeset(&changeset.changeset_id)
                        .unwrap()
                        .state,
                    ChangesetState::RolledBack
                );
            }
        }
    }

    #[test]
    fn rollback_conflict_aborts_the_revert_and_keeps_the_published_record() {
        for strategy in [IntegrationStrategy::Merge, IntegrationStrategy::Rebase] {
            let fixture = Fixture::new();
            let changeset = fixture.capture("rollback-conflict", &[("left.txt", "agent\n")]);
            let prepared = fixture
                .service
                .prepare_integration(fixture.request(
                    &[&changeset],
                    strategy,
                    IntegrationConflictPolicy::Stop,
                ))
                .unwrap();
            let published = fixture.publish(&prepared);
            let advanced = fixture.commit_target("left.txt", "later conflicting user work\n");
            let error = fixture
                .service
                .rollback_integration(&published.integration_id)
                .unwrap_err();
            assert_eq!(
                error,
                IntegrationError::RollbackConflict {
                    files: vec!["left.txt".into()]
                }
            );
            assert_eq!(fixture.target(), advanced);
            let stored = fixture
                .service
                .get_integration(&published.integration_id)
                .unwrap()
                .unwrap();
            assert_eq!(stored.state, IntegrationState::Published);
            assert_eq!(stored.op_log, published.op_log);
            assert_eq!(
                fixture
                    .service
                    .get_changeset(&changeset.changeset_id)
                    .unwrap()
                    .state,
                ChangesetState::Merged
            );
            let worktree = Path::new(stored.worktree_path.as_deref().unwrap());
            assert_eq!(git(worktree, &["rev-parse", "HEAD"]), advanced);
            assert!(unmerged_paths(worktree).unwrap().is_empty());
            assert!(!git_path(worktree, "REVERT_HEAD").unwrap().exists());
        }
    }

    #[test]
    fn already_contained_changeset_is_skipped_and_rollback_preserves_its_old_merge() {
        let fixture = Fixture::new();
        let contained =
            fixture.capture("already-contained", &[("left.txt", "pre-existing merge\n")]);
        git(
            &fixture.source,
            &[
                "merge",
                "--no-ff",
                "-m",
                "user already merged",
                &contained.head_sha,
            ],
        );
        let previous_merge = fixture.target();
        let fresh = fixture.capture("fresh", &[("right.txt", "new integration\n")]);
        let prepared = fixture.prepare(&[&contained, &fresh]);
        assert_eq!(prepared.state, IntegrationState::Prepared);
        assert_eq!(prepared.items[0].outcome, IntegrationItemOutcome::Skipped);
        assert!(prepared.items[0].commit_sha.is_none());
        assert_eq!(prepared.items[1].outcome, IntegrationItemOutcome::Merged);
        assert_eq!(
            fixture
                .service
                .get_changeset(&contained.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Queued
        );
        let published = fixture.publish(&prepared);
        fixture.commit_target("later.txt", "keep this too\n");
        fixture
            .service
            .rollback_integration(&published.integration_id)
            .unwrap();
        git(
            &fixture.source,
            &["merge-base", "--is-ancestor", &previous_merge, "HEAD"],
        );
        assert_eq!(
            fs::read_to_string(fixture.source.join("left.txt")).unwrap(),
            "pre-existing merge\n"
        );
        assert_eq!(
            fs::read_to_string(fixture.source.join("right.txt")).unwrap(),
            "right base\n"
        );
        assert_eq!(
            fs::read_to_string(fixture.source.join("later.txt")).unwrap(),
            "keep this too\n"
        );
        assert_eq!(
            fixture
                .service
                .get_changeset(&contained.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Queued
        );
        assert_eq!(
            fixture
                .service
                .get_changeset(&fresh.changeset_id)
                .unwrap()
                .state,
            ChangesetState::RolledBack
        );
    }

    #[test]
    fn rebase_replays_a_merge_commit_with_its_first_parent_as_mainline() {
        let fixture = Fixture::new();
        let workspace = fixture.workspace("merged-agent-history");
        let root = Path::new(&workspace.execution_root);
        let base = git(root, &["rev-parse", "HEAD"]);
        git(root, &["checkout", "-b", "agent-side"]);
        fs::write(root.join("side.txt"), "side\n").unwrap();
        git(root, &["add", "side.txt"]);
        git(root, &["commit", "-m", "side commit"]);
        git(root, &["checkout", "--detach", &base]);
        fs::write(root.join("agent-main.txt"), "main\n").unwrap();
        git(root, &["add", "agent-main.txt"]);
        git(root, &["commit", "-m", "main commit"]);
        git(
            root,
            &["merge", "--no-ff", "-m", "agent merge", "agent-side"],
        );
        let changeset = fixture.capture_workspace(&workspace, "merged-agent-history");
        let prepared = fixture
            .service
            .prepare_integration(fixture.request(
                &[&changeset],
                IntegrationStrategy::Rebase,
                IntegrationConflictPolicy::Stop,
            ))
            .unwrap();
        assert_eq!(prepared.state, IntegrationState::Prepared);
        assert_eq!(candidate_file(&prepared, "side.txt"), "side");
        assert_eq!(candidate_file(&prepared, "agent-main.txt"), "main");
        assert!(git(
            Path::new(&prepared.repo_common_dir),
            &[
                "rev-list",
                "--min-parents=2",
                &format!(
                    "{}..{}",
                    prepared.expected_old_sha,
                    prepared.candidate_sha.as_deref().unwrap()
                )
            ]
        )
        .is_empty());
        assert_eq!(fixture.target(), base);
    }

    #[test]
    fn reopening_a_preparing_run_interrupts_it_and_queues_its_changesets() {
        let mut fixture = Fixture::new();
        let changeset = fixture.capture("recover-prepare", &[("left.txt", "agent\n")]);
        let prepared = fixture.prepare(&[&changeset]);
        let mut crashed = prepared.clone();
        crashed.state = IntegrationState::Preparing;
        crashed.candidate_sha = None;
        fixture
            .service
            .store
            .lock()
            .save_integration(&crashed, Some(&prepared), &[], None)
            .unwrap();
        let worktree = PathBuf::from(prepared.worktree_path.as_deref().unwrap());
        fs::write(worktree.join("left.txt"), "interrupted write\n").unwrap();
        fs::write(worktree.join("partial-output.txt"), "incomplete\n").unwrap();
        fixture.reopen();
        let recovered = fixture
            .service
            .get_integration(&prepared.integration_id)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.state, IntegrationState::Interrupted);
        assert_eq!(
            fixture
                .service
                .get_changeset(&changeset.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Queued
        );
        assert_eq!(fixture.target(), prepared.expected_old_sha);
        assert_eq!(
            git(&worktree, &["rev-parse", "HEAD"]),
            prepared.expected_old_sha
        );
        assert!(git(&worktree, &["status", "--porcelain"]).is_empty());
        fixture.reopen();
        assert_eq!(
            fixture
                .service
                .get_integration(&prepared.integration_id)
                .unwrap()
                .unwrap(),
            recovered
        );
    }

    #[test]
    fn reopening_publishing_finishes_only_when_the_target_has_the_candidate() {
        for moved in [false, true] {
            let mut fixture = Fixture::new();
            let changeset = fixture.capture("recover-publish", &[("left.txt", "agent\n")]);
            let prepared = fixture.prepare(&[&changeset]);
            let candidate = prepared.candidate_sha.as_deref().unwrap();
            let mut publishing = prepared.clone();
            publishing.state = IntegrationState::Publishing;
            publishing.op_log.push(RefTransition {
                ref_name: publishing.target_ref.clone(),
                old_sha: publishing.expected_old_sha.clone(),
                new_sha: candidate.into(),
                reason: "publish".into(),
                at: now_ms(),
            });
            fixture
                .service
                .store
                .lock()
                .save_integration(&publishing, Some(&prepared), &[], None)
                .unwrap();
            if moved {
                git(&fixture.source, &["merge", "--ff-only", candidate]);
            }
            fixture.reopen();
            let recovered = fixture
                .service
                .get_integration(&prepared.integration_id)
                .unwrap()
                .unwrap();
            let changeset = fixture
                .service
                .get_changeset(&changeset.changeset_id)
                .unwrap();
            if moved {
                assert_eq!(recovered.state, IntegrationState::Published);
                assert_eq!(recovered.result_sha.as_deref(), Some(candidate));
                assert_eq!(changeset.state, ChangesetState::Merged);
                assert_eq!(changeset.merged_sha.as_deref(), Some(candidate));
            } else {
                assert_eq!(recovered.state, IntegrationState::Interrupted);
                assert_eq!(changeset.state, ChangesetState::Queued);
                assert_eq!(fixture.target(), prepared.expected_old_sha);
            }
            assert_eq!(recovered.op_log, publishing.op_log);
            fixture.reopen();
            assert_eq!(
                fixture
                    .service
                    .get_integration(&prepared.integration_id)
                    .unwrap()
                    .unwrap(),
                recovered
            );
        }
    }

    #[test]
    fn simultaneous_prepare_and_a_second_service_cannot_reserve_the_same_target() {
        let fixture = Fixture::new();
        let first = fixture.capture("first", &[("left.txt", "first\n")]);
        let second = fixture.capture("second", &[("right.txt", "second\n")]);
        let peer = TaskWorkspaceService::open(ServiceConfig::new(fixture.data.clone())).unwrap();
        let request = fixture.request(
            &[&first],
            IntegrationStrategy::Merge,
            IntegrationConflictPolicy::Skip,
        );
        let lock = queue_lock(&first.repo_common_dir, &first.target_ref);
        let held = lock.lock();
        let service = &fixture.service;
        let error = std::thread::scope(|scope| {
            scope
                .spawn(move || service.prepare_integration(request))
                .join()
                .unwrap()
                .unwrap_err()
        });
        assert!(matches!(error, IntegrationError::Busy { .. }));
        drop(held);
        let prepared = fixture.prepare(&[&first]);
        let error = peer
            .prepare_integration(fixture.request(
                &[&second],
                IntegrationStrategy::Merge,
                IntegrationConflictPolicy::Skip,
            ))
            .unwrap_err();
        assert_eq!(
            error,
            IntegrationError::Busy {
                integration_id: prepared.integration_id.clone()
            }
        );
        assert_eq!(peer.list_integrations().unwrap().len(), 1);
        assert_eq!(
            peer.get_changeset(&second.changeset_id).unwrap().state,
            ChangesetState::Approved
        );
    }

    #[test]
    fn drop_isolates_the_failed_item_and_rebuilds_the_remaining_candidate() {
        let fixture = Fixture::new();
        let left = fixture.capture("left", &[("left.txt", "left agent\n")]);
        let right = fixture.capture("right", &[("right.txt", "right culprit\n")]);
        let prepared = fixture.prepare(&[&left, &right]);
        fixture
            .service
            .record_integration_check(
                &prepared.integration_id,
                prepared.candidate_sha.as_deref().unwrap(),
                check(
                    prepared.candidate_sha.as_deref().unwrap(),
                    ChangesetCheckOutcome::Failed,
                ),
            )
            .unwrap();
        let dropped = fixture
            .service
            .drop_integration_item(&prepared.integration_id, &right.changeset_id)
            .unwrap();
        assert_eq!(dropped.state, IntegrationState::Stale);
        assert!(dropped.candidate_sha.is_none());
        assert!(dropped.checks.is_empty());
        assert_eq!(
            fixture
                .service
                .get_changeset(&right.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Failed
        );
        assert_eq!(
            fixture
                .service
                .get_changeset(&left.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Queued
        );
        let rebuilt = fixture
            .service
            .rebuild_integration(&prepared.integration_id)
            .unwrap();
        assert_eq!(rebuilt.attempt, 2);
        assert!(rebuilt
            .items
            .iter()
            .any(|item| item.changeset_id == right.changeset_id
                && item.outcome == IntegrationItemOutcome::Dropped));
        assert_eq!(candidate_file(&rebuilt, "left.txt"), "left agent");
        assert_eq!(candidate_file(&rebuilt, "right.txt"), "right base");
        fixture.publish(&rebuilt);
        assert_eq!(
            fixture
                .service
                .get_changeset(&right.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Failed
        );
    }

    #[test]
    fn rebuild_stops_after_three_attempts_without_moving_the_target() {
        let fixture = Fixture::new();
        let changeset = fixture.capture("bounded", &[("left.txt", "agent\n")]);
        let mut run = fixture.prepare(&[&changeset]);
        for attempt in 1..=3 {
            let moved =
                fixture.commit_target("right.txt", &format!("external attempt {attempt}\n"));
            assert!(matches!(
                fixture
                    .service
                    .publish_integration(
                        &run.integration_id,
                        run.candidate_sha.as_deref().unwrap(),
                        Vec::new()
                    )
                    .unwrap_err(),
                IntegrationError::TargetMoved { .. }
            ));
            if attempt < 3 {
                run = fixture
                    .service
                    .rebuild_integration(&run.integration_id)
                    .unwrap();
                assert_eq!(run.attempt, attempt + 1);
            } else {
                assert_eq!(
                    fixture
                        .service
                        .rebuild_integration(&run.integration_id)
                        .unwrap_err(),
                    IntegrationError::AttemptsExhausted {
                        integration_id: run.integration_id.clone()
                    }
                );
                assert_eq!(
                    fixture
                        .service
                        .get_integration(&run.integration_id)
                        .unwrap()
                        .unwrap()
                        .state,
                    IntegrationState::Failed
                );
            }
            assert_eq!(fixture.target(), moved);
        }
    }

    #[test]
    fn aborted_integration_reuses_the_worktree_and_keeps_ignored_dependencies() {
        let fixture = Fixture::new();
        let first = fixture.capture("first", &[("left.txt", "first\n")]);
        let second = fixture.capture("second", &[("right.txt", "second\n")]);
        fs::write(fixture.source.join("local-settings.json"), "{}\n").unwrap();
        let mut request = fixture.request(
            &[&first],
            IntegrationStrategy::Merge,
            IntegrationConflictPolicy::Skip,
        );
        request.provisioning = Some(WorkspaceProvisioning {
            include: vec!["local-settings.json".into()],
            ..WorkspaceProvisioning::default()
        });
        let prepared = fixture.service.prepare_integration(request).unwrap();
        let worktree = Path::new(prepared.worktree_path.as_deref().unwrap());
        assert_eq!(
            fs::read_to_string(worktree.join("local-settings.json")).unwrap(),
            "{}\n"
        );
        fs::create_dir_all(worktree.join("ignored/dependencies")).unwrap();
        fs::write(worktree.join("ignored/dependencies/cache"), "keep\n").unwrap();
        fs::write(worktree.join("discard.txt"), "discard\n").unwrap();
        let aborted = fixture
            .service
            .abort_integration(&prepared.integration_id)
            .unwrap();
        assert_eq!(aborted.state, IntegrationState::Aborted);
        assert_eq!(
            fixture
                .service
                .get_changeset(&first.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Queued
        );
        assert_eq!(
            git(worktree, &["rev-parse", "HEAD"]),
            prepared.expected_old_sha
        );
        assert!(!worktree.join("discard.txt").exists());
        assert!(!worktree.join("local-settings.json").exists());
        let next = fixture.prepare(&[&second]);
        assert_eq!(next.worktree_path, prepared.worktree_path);
        assert_eq!(
            fs::read_to_string(worktree.join("ignored/dependencies/cache")).unwrap(),
            "keep\n"
        );
        assert_eq!(candidate_file(&next, "left.txt"), "left base");
        assert_eq!(candidate_file(&next, "right.txt"), "second");
        assert!(!fixture
            .service
            .list_managed_workspaces()
            .unwrap()
            .iter()
            .any(|record| Path::new(&record.execution_root) == worktree));
    }

    #[test]
    fn maintenance_expires_terminal_refs_by_age_and_only_reclaims_an_idle_worktree() {
        let fixture = Fixture::new();
        let merged = fixture.capture("merged", &[("left.txt", "merged\n")]);
        fixture.publish(&fixture.prepare(&[&merged]));
        let rolled_back = fixture.capture("rolled-back", &[("right.txt", "rolled back\n")]);
        let published = fixture.publish(&fixture.prepare(&[&rolled_back]));
        fixture
            .service
            .rollback_integration(&published.integration_id)
            .unwrap();
        let abandoned = fixture.capture("abandoned", &[("shared.txt", "abandoned\n")]);
        fixture
            .service
            .abandon_changeset(&abandoned.changeset_id)
            .unwrap();
        // A retained pin can remain after an earlier interrupted cleanup.
        git(
            &fixture.source,
            &["update-ref", &abandoned.change_ref, &abandoned.head_sha],
        );
        let active = fixture.capture("active", &[("active.txt", "pending integration\n")]);
        let prepared = fixture.prepare(&[&active]);
        let worktree = Path::new(prepared.worktree_path.as_deref().unwrap());
        let current = now_ms();
        fixture
            .service
            .run_workspace_maintenance(WorkspaceMaintenanceRequest { now: Some(current) })
            .unwrap();
        for changeset in [&merged, &rolled_back, &abandoned, &active] {
            assert!(git_result(
                &fixture.source,
                &["show-ref", "--verify", &changeset.change_ref]
            )
            .status
            .success());
        }
        let future = current + 31 * 24 * 60 * 60 * 1_000;
        let expired = fixture
            .service
            .run_workspace_maintenance(WorkspaceMaintenanceRequest { now: Some(future) })
            .unwrap();
        for changeset in [&merged, &rolled_back, &abandoned] {
            assert!(!git_result(
                &fixture.source,
                &["show-ref", "--verify", &changeset.change_ref]
            )
            .status
            .success());
            assert!(expired.events.iter().any(|event| event.kind
                == WorkspaceMaintenanceEventKind::SnapshotExpired
                && event.detail.contains(&changeset.change_ref)));
        }
        assert!(git_result(
            &fixture.source,
            &["show-ref", "--verify", &active.change_ref]
        )
        .status
        .success());
        assert!(worktree.is_dir());
        fixture
            .service
            .abort_integration(&prepared.integration_id)
            .unwrap();
        let reclaimed = fixture
            .service
            .run_workspace_maintenance(WorkspaceMaintenanceRequest { now: Some(future) })
            .unwrap();
        assert!(!worktree.exists());
        assert!(reclaimed.events.iter().any(|event| event.kind
            == WorkspaceMaintenanceEventKind::DirectoryReclaimed
            && event.detail.contains("integration worktree")));
        assert!(git_result(
            &fixture.source,
            &["show-ref", "--verify", &active.change_ref]
        )
        .status
        .success());
    }

    #[test]
    fn prepare_enforces_changeset_checks_before_reserving_or_touching_the_target() {
        let fixture = Fixture::new();
        let mut changeset = fixture.capture("gate", &[("left.txt", "agent\n")]);
        let target = fixture.target();
        let version = changeset.version;
        changeset.version += 1;
        changeset.required_checks = vec!["unit".into()];
        fixture
            .service
            .store
            .lock()
            .update_changeset(&changeset, version)
            .unwrap();
        let error = fixture
            .service
            .prepare_integration(fixture.request(
                &[&changeset],
                IntegrationStrategy::Merge,
                IntegrationConflictPolicy::Skip,
            ))
            .unwrap_err();
        assert_eq!(
            error,
            IntegrationError::Ineligible {
                changeset_id: changeset.changeset_id,
                gaps: vec![EligibilityGap::MissingCheck {
                    profile: "unit".into()
                }]
            }
        );
        assert!(fixture.service.list_integrations().unwrap().is_empty());
        assert_eq!(fixture.target(), target);
    }

    #[test]
    fn prepare_never_resets_an_unowned_checkout_at_the_reserved_integration_path() {
        let fixture = Fixture::new();
        let changeset = fixture.capture("ownership", &[("left.txt", "agent\n")]);
        let path = fixture
            .service
            .integration_dir
            .join(repository_key(&changeset.repo_common_dir));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let foreign = fixture._dir.path().join("foreign");
        git(
            fixture._dir.path(),
            &[
                "clone",
                "--no-hardlinks",
                fixture.source.to_str().unwrap(),
                foreign.to_str().unwrap(),
            ],
        );
        git(
            &foreign,
            &[
                "worktree",
                "add",
                "--detach",
                path.to_str().unwrap(),
                "HEAD",
            ],
        );
        assert!(path.join(".git").is_file());
        fs::write(path.join("shared.txt"), "foreign tracked edit\n").unwrap();
        fs::write(path.join("sentinel.txt"), "foreign untracked content\n").unwrap();
        let before_head = git(&path, &["rev-parse", "HEAD"]);
        let before_status = git(&path, &["status", "--porcelain"]);
        let target = fixture.target();

        let error = fixture
            .service
            .prepare_integration(fixture.request(
                &[&changeset],
                IntegrationStrategy::Merge,
                IntegrationConflictPolicy::Stop,
            ))
            .unwrap_err();
        assert!(matches!(
            error,
            IntegrationError::InvalidRequest(message) if message.contains("unowned integration path")
        ));
        assert_eq!(git(&path, &["rev-parse", "HEAD"]), before_head);
        assert_eq!(git(&path, &["status", "--porcelain"]), before_status);
        assert_eq!(
            fs::read_to_string(path.join("shared.txt")).unwrap(),
            "foreign tracked edit\n"
        );
        assert_eq!(
            fs::read_to_string(path.join("sentinel.txt")).unwrap(),
            "foreign untracked content\n"
        );
        assert!(
            git(&foreign, &["worktree", "list", "--porcelain"]).contains(path.to_str().unwrap())
        );
        assert_eq!(fixture.target(), target);
        let runs = fixture.service.list_integrations().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].state, IntegrationState::Failed);
    }

    #[cfg(unix)]
    #[test]
    fn retention_detects_nested_activity_without_following_cache_symlinks() {
        use std::os::unix::fs::symlink;
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        let dir = TempDir::new().unwrap();
        let root = dir.path().join("worktree");
        let nested = root.join("build/nested");
        let outside = dir.path().join("external-cache");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let output = nested.join("output.txt");
        fs::write(&output, "recent build output\n").unwrap();
        fs::write(outside.join("active-cache.txt"), "external activity\n").unwrap();
        symlink(&outside, root.join("cache")).unwrap();
        let old = UNIX_EPOCH + Duration::from_secs(1);
        let cutoff_time = SystemTime::now() + Duration::from_secs(60);
        let cutoff = cutoff_time.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let recent = cutoff_time + Duration::from_secs(60);
        let set_modified = |path: &Path, modified| {
            fs::File::open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(modified))
                .unwrap();
        };
        for path in [&root, &root.join("build"), &nested, &outside] {
            set_modified(path, old);
        }
        set_modified(&output, recent);
        set_modified(&outside.join("active-cache.txt"), recent);
        assert!(worktree_touched_since(&root, cutoff).unwrap());

        set_modified(&output, old);
        assert!(!worktree_touched_since(&root, cutoff).unwrap());
        assert!(worktree_touched_since(&outside, cutoff).unwrap());
        assert!(fs::symlink_metadata(root.join("cache"))
            .unwrap()
            .is_symlink());
    }

    #[test]
    fn terminal_run_cleanup_cannot_reset_a_worktree_reserved_by_a_new_active_run() {
        let fixture = Fixture::new();
        let first = fixture.capture("terminal", &[("left.txt", "first\n")]);
        let published = fixture.publish(&fixture.prepare(&[&first]));
        let second = fixture.capture("active", &[("right.txt", "second\n")]);
        let active = fixture.prepare(&[&second]);
        assert_eq!(published.worktree_path, active.worktree_path);
        let worktree = Path::new(active.worktree_path.as_deref().unwrap());
        fs::write(worktree.join("right.txt"), "active verification edit\n").unwrap();
        fs::write(worktree.join("active-check.log"), "keep active output\n").unwrap();
        let head = git(worktree, &["rev-parse", "HEAD"]);
        let status = git(worktree, &["status", "--porcelain"]);
        fixture
            .service
            .reset_integration_if_unreserved(&published, &published.expected_old_sha)
            .unwrap();

        let invoked = Cell::new(false);
        let result = fixture
            .service
            .store
            .lock()
            .with_integration_worktree(
                &published.repo_common_dir,
                Some(&published.integration_id),
                Some(now_ms() + 31 * 24 * 60 * 60 * 1_000),
                || {
                    invoked.set(true);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(result, None);
        assert!(!invoked.get());
        let outcome = fixture
            .service
            .run_workspace_maintenance(WorkspaceMaintenanceRequest {
                now: Some(now_ms() + 31 * 24 * 60 * 60 * 1_000),
            })
            .unwrap();
        assert!(!outcome.events.iter().any(|event| {
            event.kind == WorkspaceMaintenanceEventKind::DirectoryReclaimed
                && event.detail.contains("integration worktree")
        }));
        assert_eq!(git(worktree, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(worktree, &["status", "--porcelain"]), status);
        assert_eq!(
            fs::read_to_string(worktree.join("active-check.log")).unwrap(),
            "keep active output\n"
        );
        assert_eq!(
            fixture
                .service
                .get_integration(&active.integration_id)
                .unwrap()
                .unwrap()
                .state,
            IntegrationState::Prepared
        );
    }

    type TargetMoveHook = Option<Box<dyn FnMut(&str)>>;

    thread_local! {
        static TARGET_MOVE_HOOK: std::cell::RefCell<TargetMoveHook> =
            const { std::cell::RefCell::new(None) };
    }

    pub(super) fn target_move_hook(phase: &str) {
        TARGET_MOVE_HOOK.with(|hook| {
            if let Some(hook) = hook.borrow_mut().as_mut() {
                hook(phase);
            }
        });
    }

    #[test]
    fn adversarial_checked_out_rollback_keeps_a_racing_user_commit() {
        let fixture = Fixture::new();
        let changeset = fixture.capture("rollback-race", &[("left.txt", "agent\n")]);
        let published = fixture.publish(&fixture.prepare(&[&changeset]));
        let source = fixture.source.clone();
        let user_commit = std::sync::Arc::new(Mutex::new(String::new()));
        let recorded = user_commit.clone();
        TARGET_MOVE_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |phase| {
                if phase == "validated" {
                    fs::write(source.join("right.txt"), "user commit\n").unwrap();
                    git(&source, &["add", "right.txt"]);
                    git(&source, &["commit", "-m", "racing user commit"]);
                    *recorded.lock() = git(&source, &["rev-parse", "HEAD"]);
                }
            }));
        });
        let result = fixture
            .service
            .rollback_integration(&published.integration_id);
        TARGET_MOVE_HOOK.with(|hook| hook.borrow_mut().take());
        assert!(
            matches!(result, Err(IntegrationError::TargetMoved { .. })),
            "{result:?}"
        );
        assert_eq!(fixture.target(), *user_commit.lock());
        assert_eq!(
            fs::read_to_string(fixture.source.join("right.txt")).unwrap(),
            "user commit\n"
        );
        assert_eq!(
            fixture
                .service
                .get_integration(&published.integration_id)
                .unwrap()
                .unwrap()
                .state,
            IntegrationState::Published
        );
    }

    #[test]
    fn adversarial_checked_out_publish_verifies_the_ref_after_merge() {
        let fixture = Fixture::new();
        let changeset = fixture.capture("publish-race", &[("left.txt", "agent\n")]);
        let prepared = fixture.prepare(&[&changeset]);
        let source = fixture.source.clone();
        TARGET_MOVE_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |phase| {
                if phase == "moved" {
                    fs::write(source.join("right.txt"), "user after merge\n").unwrap();
                    git(&source, &["add", "right.txt"]);
                    git(&source, &["commit", "-m", "user after merge"]);
                }
            }));
        });
        let result = fixture.service.publish_integration(
            &prepared.integration_id,
            prepared.candidate_sha.as_deref().unwrap(),
            Vec::new(),
        );
        TARGET_MOVE_HOOK.with(|hook| hook.borrow_mut().take());
        assert!(
            matches!(result, Err(IntegrationError::TargetMoved { actual: Some(ref actual), .. }) if actual == &fixture.target()),
            "{result:?}"
        );
        let stored = fixture
            .service
            .get_integration(&prepared.integration_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.state, IntegrationState::Stale);
        assert!(stored.error.unwrap().message.contains(&fixture.target()));
    }

    #[test]
    fn adversarial_publish_cannot_omit_changeset_required_checks() {
        let fixture = Fixture::new();
        let mut changeset = fixture.capture("mandatory-check", &[("left.txt", "agent\n")]);
        let version = changeset.version;
        changeset.version += 1;
        changeset.required_checks = vec!["unit".into()];
        changeset
            .checks
            .push(check(&changeset.head_sha, ChangesetCheckOutcome::Passed));
        fixture
            .service
            .store
            .lock()
            .update_changeset(&changeset, version)
            .unwrap();
        let prepared = fixture.prepare(&[&changeset]);
        let result = fixture.service.publish_integration(
            &prepared.integration_id,
            prepared.candidate_sha.as_deref().unwrap(),
            Vec::new(),
        );
        assert!(
            matches!(result, Err(IntegrationError::Checks { ref gaps }) if gaps == &[EligibilityGap::MissingCheck { profile: "unit".into() }]),
            "{result:?}"
        );
    }

    #[test]
    fn adversarial_recovery_restores_unfinished_rollback_to_published() {
        for publishing in [false, true] {
            let mut fixture = Fixture::new();
            let changeset = fixture.capture("rollback-recovery", &[("left.txt", "agent\n")]);
            let published = fixture.publish(&fixture.prepare(&[&changeset]));
            let mut crashed = published.clone();
            crashed.state = if publishing {
                IntegrationState::Publishing
            } else {
                IntegrationState::Preparing
            };
            crashed.error = Some(IntegrationFailure {
                code: "rollbackPreparing".into(),
                message: "building rollback commits".into(),
            });
            if publishing {
                crashed.op_log.push(RefTransition {
                    ref_name: crashed.target_ref.clone(),
                    old_sha: published.result_sha.clone().unwrap(),
                    new_sha: published.expected_old_sha.clone(),
                    reason: "rollbackSwap".into(),
                    at: now_ms(),
                });
            }
            fixture
                .service
                .store
                .lock()
                .save_integration(&crashed, Some(&published), &[], None)
                .unwrap();
            fixture.reopen();
            let recovered = fixture
                .service
                .get_integration(&published.integration_id)
                .unwrap()
                .unwrap();
            assert_eq!(recovered.state, IntegrationState::Published);
            assert_eq!(recovered.result_sha, published.result_sha);
            assert_eq!(recovered.op_log, crashed.op_log);
            assert_eq!(
                fixture
                    .service
                    .get_changeset(&changeset.changeset_id)
                    .unwrap()
                    .state,
                ChangesetState::Merged
            );
            assert_eq!(
                fixture
                    .service
                    .rollback_integration(&published.integration_id)
                    .unwrap()
                    .state,
                IntegrationState::RolledBack
            );
        }
    }

    #[test]
    fn adversarial_stop_queues_previously_composed_changesets() {
        let fixture = Fixture::new();
        let left = fixture.capture("left-first", &[("left.txt", "agent left\n")]);
        let conflict = fixture.capture("conflict-next", &[("shared.txt", "agent shared\n")]);
        fixture.commit_target("shared.txt", "user shared\n");
        let run = fixture
            .service
            .prepare_integration(fixture.request(
                &[&left, &conflict],
                IntegrationStrategy::Merge,
                IntegrationConflictPolicy::Stop,
            ))
            .unwrap();
        assert_eq!(run.state, IntegrationState::Conflicted);
        assert_eq!(
            fixture
                .service
                .get_changeset(&left.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Queued
        );
        assert_eq!(
            fixture
                .service
                .get_changeset(&conflict.changeset_id)
                .unwrap()
                .state,
            ChangesetState::Conflicted
        );
    }

    #[test]
    fn adversarial_recovery_repairs_stranded_integrating_changesets() {
        for state in [
            IntegrationState::Conflicted,
            IntegrationState::Failed,
            IntegrationState::Aborted,
        ] {
            let mut fixture = Fixture::new();
            let changeset = fixture.capture("stranded", &[("left.txt", "agent\n")]);
            let prepared = fixture.prepare(&[&changeset]);
            let mut crashed = prepared.clone();
            crashed.state = state;
            fixture
                .service
                .store
                .lock()
                .save_integration(&crashed, Some(&prepared), &[], None)
                .unwrap();
            fixture.reopen();
            assert_eq!(
                fixture
                    .service
                    .get_integration(&prepared.integration_id)
                    .unwrap()
                    .unwrap()
                    .state,
                state
            );
            assert_eq!(
                fixture
                    .service
                    .get_changeset(&changeset.changeset_id)
                    .unwrap()
                    .state,
                ChangesetState::Queued
            );
        }
    }

    #[test]
    fn adversarial_recovery_skips_an_advisory_lock_owner() {
        let fixture = Fixture::new();
        let changeset = fixture.capture("live-prepare", &[("left.txt", "agent\n")]);
        let prepared = fixture.prepare(&[&changeset]);
        let mut live = prepared.clone();
        live.state = IntegrationState::Preparing;
        fixture
            .service
            .store
            .lock()
            .save_integration(&live, Some(&prepared), &[], None)
            .unwrap();
        let guard = crate::integration_lock::try_acquire(
            &fixture.service.integration_dir,
            &live.repo_common_dir,
            &live.target_ref,
        )
        .unwrap();
        let second = TaskWorkspaceService::open(ServiceConfig::new(fixture.data.clone())).unwrap();
        assert_eq!(
            second
                .get_integration(&live.integration_id)
                .unwrap()
                .unwrap(),
            live
        );
        assert_eq!(
            second.get_changeset(&changeset.changeset_id).unwrap().state,
            ChangesetState::Integrating
        );
        drop(guard);
        assert!(second.recover_integrations().unwrap().is_empty());
        assert_eq!(
            second
                .get_integration(&live.integration_id)
                .unwrap()
                .unwrap()
                .state,
            IntegrationState::Interrupted
        );
        assert_eq!(
            second.get_changeset(&changeset.changeset_id).unwrap().state,
            ChangesetState::Queued
        );
    }

    #[test]
    fn integration_required_checks_survive_rebuild_and_exclude_dropped_or_conflicted_items() {
        let mut fixture = Fixture::new();
        let mut left = fixture.capture("required-left", &[("left.txt", "agent left\n")]);
        let mut right = fixture.capture("required-right", &[("right.txt", "agent right\n")]);
        let mut conflict =
            fixture.capture("required-conflict", &[("shared.txt", "agent shared\n")]);
        for (changeset, profile) in [
            (&mut left, "unit"),
            (&mut right, "lint"),
            (&mut conflict, "smoke"),
        ] {
            let version = changeset.version;
            changeset.version += 1;
            changeset.required_checks = vec![profile.into()];
            let mut passed = check(&changeset.head_sha, ChangesetCheckOutcome::Passed);
            passed.profile_id = profile.into();
            changeset.checks.push(passed);
            fixture
                .service
                .store
                .lock()
                .update_changeset(changeset, version)
                .unwrap();
        }
        fixture.commit_target("shared.txt", "target shared\n");
        let mut request = fixture.request(
            &[&left, &right, &conflict],
            IntegrationStrategy::Merge,
            IntegrationConflictPolicy::Skip,
        );
        request.required_checks = vec!["global".into(), "global".into()];
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(
            json["requiredChecks"],
            serde_json::json!(["global", "global"])
        );
        let mut legacy = json;
        legacy.as_object_mut().unwrap().remove("requiredChecks");
        assert!(serde_json::from_value::<PrepareIntegration>(legacy)
            .unwrap()
            .required_checks
            .is_empty());
        let run = fixture.service.prepare_integration(request).unwrap();
        assert_eq!(run.required_checks, ["global", "lint", "unit"]);
        fixture.reopen();
        let dropped = fixture
            .service
            .drop_integration_item(&run.integration_id, &right.changeset_id)
            .unwrap();
        assert_eq!(dropped.required_checks, ["global", "unit"]);
        let rebuilt = fixture
            .service
            .rebuild_integration(&run.integration_id)
            .unwrap();
        assert_eq!(rebuilt.required_checks, ["global", "unit"]);
        assert_eq!(rebuilt.requested_checks, ["global"]);
        let candidate = rebuilt.candidate_sha.as_deref().unwrap();
        assert!(matches!(
            fixture
                .service
                .publish_integration(&run.integration_id, candidate, Vec::new()),
            Err(IntegrationError::Checks { .. })
        ));
        for profile in ["global", "unit"] {
            let mut passed = check(candidate, ChangesetCheckOutcome::Passed);
            passed.profile_id = profile.into();
            fixture
                .service
                .record_integration_check(&run.integration_id, candidate, passed)
                .unwrap();
        }
        assert!(
            matches!(fixture.service.publish_integration(&run.integration_id, candidate, vec!["extra".into()]), Err(IntegrationError::Checks { gaps }) if gaps == [EligibilityGap::MissingCheck { profile: "extra".into() }])
        );
        assert_eq!(
            fixture
                .service
                .publish_integration(&run.integration_id, candidate, Vec::new())
                .unwrap()
                .state,
            IntegrationState::Published
        );
    }

    #[test]
    fn integration_rollback_restores_the_ref_when_checkout_changes_after_validation() {
        let fixture = Fixture::new();
        let changeset = fixture.capture("rollback-dirty-race", &[("left.txt", "agent\n")]);
        let published = fixture.publish(&fixture.prepare(&[&changeset]));
        let source = fixture.source.clone();
        TARGET_MOVE_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |phase| {
                if phase == "validated" {
                    fs::write(source.join("left.txt"), "user uncommitted\n").unwrap();
                }
            }));
        });
        let result = fixture
            .service
            .rollback_integration(&published.integration_id);
        TARGET_MOVE_HOOK.with(|hook| hook.borrow_mut().take());
        assert!(
            matches!(result, Err(IntegrationError::TargetCheckedOutDirty { .. })),
            "{result:?}"
        );
        assert_eq!(fixture.target(), published.result_sha.unwrap());
        assert_eq!(
            fs::read_to_string(fixture.source.join("left.txt")).unwrap(),
            "user uncommitted\n"
        );
    }

    #[test]
    fn integration_rollback_recovery_finishes_a_cas_before_checkout_update() {
        for checkout_updated in [false, true] {
            let mut fixture = Fixture::new();
            let changeset = fixture.capture("rollback-crash", &[("left.txt", "agent\n")]);
            let published = fixture.publish(&fixture.prepare(&[&changeset]));
            let mut crashed = published.clone();
            crashed.state = IntegrationState::Publishing;
            crashed.op_log.push(RefTransition {
                ref_name: crashed.target_ref.clone(),
                old_sha: published.result_sha.clone().unwrap(),
                new_sha: published.expected_old_sha.clone(),
                reason: "rollbackSwap".into(),
                at: now_ms(),
            });
            fixture
                .service
                .store
                .lock()
                .save_integration(&crashed, Some(&published), &[], None)
                .unwrap();
            git(
                &fixture.source,
                &[
                    "update-ref",
                    &crashed.target_ref,
                    &crashed.expected_old_sha,
                    crashed.result_sha.as_deref().unwrap(),
                ],
            );
            if checkout_updated {
                git(
                    &fixture.source,
                    &[
                        "read-tree",
                        "-m",
                        "-u",
                        crashed.result_sha.as_deref().unwrap(),
                        &crashed.expected_old_sha,
                    ],
                );
            }
            fixture.reopen();
            let recovered = fixture
                .service
                .get_integration(&crashed.integration_id)
                .unwrap()
                .unwrap();
            assert_eq!(recovered.state, IntegrationState::RolledBack);
            assert_eq!(recovered.op_log, crashed.op_log);
            assert_eq!(recovered.result_sha, published.result_sha);
            assert_eq!(
                fixture
                    .service
                    .get_changeset(&changeset.changeset_id)
                    .unwrap()
                    .state,
                ChangesetState::RolledBack
            );
            assert_eq!(
                fs::read_to_string(fixture.source.join("left.txt")).unwrap(),
                "left base\n"
            );
            assert!(git(&fixture.source, &["status", "--porcelain"]).is_empty());
        }
    }

    #[test]
    fn integration_all_mutations_refuse_an_external_lock_holder() {
        let fixture = Fixture::new();
        let changeset = fixture.capture("locked-mutations", &[("left.txt", "agent\n")]);
        let run = fixture.prepare(&[&changeset]);
        let guard = crate::integration_lock::try_acquire(
            &fixture.service.integration_dir,
            &run.repo_common_dir,
            &run.target_ref,
        )
        .unwrap();
        let candidate = run.candidate_sha.as_deref().unwrap();
        let attempts = [
            fixture.service.prepare_integration(fixture.request(
                &[&changeset],
                IntegrationStrategy::Merge,
                IntegrationConflictPolicy::Skip,
            )),
            fixture
                .service
                .publish_integration(&run.integration_id, candidate, Vec::new()),
            fixture.service.rollback_integration(&run.integration_id),
            fixture.service.rebuild_integration(&run.integration_id),
            fixture.service.abort_integration(&run.integration_id),
            fixture
                .service
                .drop_integration_item(&run.integration_id, &changeset.changeset_id),
            fixture.service.record_integration_check(
                &run.integration_id,
                candidate,
                check(candidate, ChangesetCheckOutcome::Passed),
            ),
        ];
        for result in attempts {
            assert!(
                matches!(result, Err(IntegrationError::Busy { .. })),
                "{result:?}"
            );
        }
        drop(guard);
        assert_eq!(
            fixture
                .service
                .get_integration(&run.integration_id)
                .unwrap()
                .unwrap(),
            run
        );
        fixture
            .service
            .abort_integration(&run.integration_id)
            .unwrap();
    }

    #[test]
    fn integration_checked_out_moves_refuse_a_branch_switch_after_validation() {
        for (rollback, trigger) in [(false, "validated"), (true, "validated"), (true, "swapped")] {
            let fixture = Fixture::new();
            let changeset = fixture.capture("switch-race", &[("left.txt", "agent\n")]);
            let prepared = fixture.prepare(&[&changeset]);
            let run = if rollback {
                fixture.publish(&prepared)
            } else {
                prepared
            };
            let original = fixture.target();
            let original_index = git(&fixture.source, &["write-tree"]);
            let original_file = fs::read(fixture.source.join("left.txt")).unwrap();
            let source = fixture.source.clone();
            let branch_head = original.clone();
            TARGET_MOVE_HOOK.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move |phase| {
                    if phase == trigger {
                        git(&source, &["checkout", "-b", "other", &branch_head]);
                    }
                }));
            });
            let result = if rollback {
                fixture.service.rollback_integration(&run.integration_id)
            } else {
                fixture.service.publish_integration(
                    &run.integration_id,
                    run.candidate_sha.as_deref().unwrap(),
                    Vec::new(),
                )
            };
            TARGET_MOVE_HOOK.with(|hook| hook.borrow_mut().take());
            assert!(result.is_err(), "{result:?}");
            assert_eq!(fixture.target(), original);
            assert_eq!(
                git(&fixture.source, &["rev-parse", "refs/heads/other"]),
                original
            );
            assert_eq!(git(&fixture.source, &["write-tree"]), original_index);
            assert_eq!(
                fs::read(fixture.source.join("left.txt")).unwrap(),
                original_file
            );
        }
    }
}
