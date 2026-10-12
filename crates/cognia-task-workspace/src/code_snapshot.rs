//! Hand a working copy to an always-on host (ADR-0224 A11b).
//!
//! A conversation that continues on the host needs the code exactly as it was
//! on the desktop, uncommitted edits included, not a fresh clone of whatever
//! the remote last saw. This module is both ends of that hand-over.
//!
//! # The snapshot
//!
//! For a git checkout it is a binary patch against a commit the remote already
//! has: the merge-base of `HEAD` with the branch it tracks there. Local commits
//! that were never pushed travel inside the patch, so nothing has to be pushed
//! first. The patch is the difference between that commit and the tree a
//! scratch index holds after `git add -A` over the working copy, so it covers
//! tracked edits, untracked files, deletions, binary files and mode changes
//! alike, and honours `.gitignore`. The id of that tree travels with it.
//!
//! A folder that is not a git checkout goes as a gzip tar of its files, also
//! honouring any `.gitignore` / `.ignore` files in it.
//!
//! Both are capped (100 MiB by default, [`CODE_SNAPSHOT_MAX_BYTES_ENV`] on the
//! host raises or lowers its own cap).
//!
//! # The receiver
//!
//! The host fetches the base commit through its mirror (with its stored git
//! credential), adds a fresh worktree on a new `cognia/handoff-…` branch at
//! that commit, applies the patch, and rebuilds the tree from the result the
//! same way the desktop did. A different tree id means the copy is not the
//! desktop's, and the checkout is removed and refused rather than handed to an
//! agent. A tar is unpacked into a fresh directory after every entry is
//! checked: regular files, directories and symlinks that stay inside it only.
//!
//! The checkout lives under the execution root, so a containerised run on the
//! host (ADR-0224 A8) mounts it like any other run's worktree.

use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::transfer::{TransferChunk, TransferRegistry, MAX_TRANSFER_CHUNK_BYTES};

/// The default cap on a snapshot, on both ends.
pub const DEFAULT_CODE_SNAPSHOT_MAX_BYTES: u64 = 100 * 1024 * 1024;

/// The most a host may be configured to accept.
pub const CODE_SNAPSHOT_MAX_BYTES_CEILING: u64 = 4 * 1024 * 1024 * 1024;

/// Sets the host's cap, in bytes.
pub const CODE_SNAPSHOT_MAX_BYTES_ENV: &str = "COGNIA_CODE_SNAPSHOT_MAX_BYTES";

/// How many entries a tar may hold.
pub const CODE_SNAPSHOT_MAX_TAR_ENTRIES: u64 = 200_000;

/// A staged snapshot nobody applied is removed after this long.
const STAGED_TTL: Duration = Duration::from_secs(60 * 60);

/// A produced snapshot nobody uploaded is removed after this long.
const PRODUCED_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CodeSnapshotKind {
    /// A binary patch against a commit the remote has.
    GitPatch,
    /// A gzip tar of a folder that is not a git checkout.
    Tar,
}

/// What the desktop recorded about a snapshot. Travels with it; the host
/// checks the bytes against `sha256` and the applied result against `tree`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CodeSnapshotManifest {
    pub kind: CodeSnapshotKind,
    pub size_bytes: u64,
    pub sha256: String,
    /// The commit the patch applies to. Git only.
    pub base_commit: Option<String>,
    /// The remote branch that commit was found on, so the host can fetch it.
    pub base_ref: Option<String>,
    /// The tree the working copy amounts to. Git only.
    pub tree: Option<String>,
    /// Where the working directory sits inside the checkout, `/`-separated,
    /// empty for its root.
    pub subdir: String,
    /// Files the patch changes, or entries the tar holds.
    pub entries: u64,
}

/// Make a snapshot of a folder on this machine.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CreateCodeSnapshot {
    pub root: String,
    /// At most this many bytes; the default cap when absent.
    #[serde(default)]
    pub max_bytes: Option<u64>,
    /// `tar` sends a git checkout as its files, for a host that cannot fetch
    /// its base (no https repository recorded). Absent: a patch for a git
    /// checkout, a tar otherwise.
    #[serde(default)]
    pub kind: Option<CodeSnapshotKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CreatedCodeSnapshot {
    pub snapshot_id: String,
    pub manifest: CodeSnapshotManifest,
    #[schemars(range(min = 1, max = 65536))]
    pub chunk_bytes: usize,
}

/// What a host accepts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CodeSnapshotLimits {
    pub max_bytes: u64,
    #[schemars(range(min = 1, max = 65536))]
    pub chunk_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CodeSnapshotUpload {
    pub upload_id: String,
    pub snapshot_id: String,
    #[schemars(range(min = 1, max = 65536))]
    pub chunk_bytes: usize,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CommittedCodeSnapshot {
    pub snapshot_id: String,
    pub sha256: String,
    pub size_bytes: u64,
}

/// Apply a staged snapshot to a fresh checkout of a project's repository.
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ApplyCodeSnapshot {
    pub snapshot_id: String,
    pub manifest: CodeSnapshotManifest,
    /// The workspace the checkout belongs to, as this host knows it.
    #[serde(default)]
    pub project_id: Option<String>,
    /// The project's folders, primary first, as its owner's device has them.
    #[serde(default)]
    pub roots: Vec<String>,
    /// Its repository remote: credential-free https.
    #[serde(default)]
    pub remote_url: Option<String>,
    /// A token for the fetch; when absent the host's stored credential is used.
    #[serde(default, skip_serializing)]
    pub credential: Option<String>,
}

impl fmt::Debug for ApplyCodeSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApplyCodeSnapshot")
            .field("snapshot_id", &self.snapshot_id)
            .field("manifest", &self.manifest)
            .field("project_id", &self.project_id)
            .field("roots", &self.roots)
            .field("remote_url", &self.remote_url)
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// A checkout a snapshot became on this host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CodeCheckout {
    pub checkout_id: String,
    /// The checkout's root.
    pub root: String,
    /// Where the conversation works: `root` plus the snapshot's `subdir`.
    pub working_dir: String,
    pub kind: CodeSnapshotKind,
    /// The branch the worktree is on. Git only.
    pub branch: Option<String>,
    pub base_commit: Option<String>,
    pub project_id: Option<String>,
    pub remote_url: Option<String>,
    /// Epoch milliseconds.
    pub created_at: i64,
}

/// The host's cap from [`CODE_SNAPSHOT_MAX_BYTES_ENV`]. Unset or blank is the
/// default; anything else must be a whole number of bytes no larger than
/// [`CODE_SNAPSHOT_MAX_BYTES_CEILING`].
pub fn code_snapshot_max_bytes_from(value: Option<&str>) -> Result<u64, String> {
    let Some(raw) = value.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(DEFAULT_CODE_SNAPSHOT_MAX_BYTES);
    };
    match raw.parse::<u64>() {
        Ok(bytes) if (1..=CODE_SNAPSHOT_MAX_BYTES_CEILING).contains(&bytes) => Ok(bytes),
        _ => Err(format!(
            "{CODE_SNAPSHOT_MAX_BYTES_ENV}={raw:?} must be a number of bytes from 1 to {CODE_SNAPSHOT_MAX_BYTES_CEILING}"
        )),
    }
}

// ---------------------------------------------------------------------------
// Ids and validation
// ---------------------------------------------------------------------------

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// A snapshot or checkout id names a file and a directory, so only the shape
/// this module mints is accepted.
fn validate_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .ok()
        .filter(|parsed| parsed.hyphenated().to_string() == id)
        .map(|_| ())
        .ok_or_else(|| format!("code_snapshot_invalid_id: {id:?}"))
}

fn validate_object_id(label: &str, value: &str) -> Result<(), String> {
    let ok = matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if ok {
        Ok(())
    } else {
        Err(format!(
            "code_snapshot_invalid_manifest: {label} is not an object id"
        ))
    }
}

/// A remote branch name the host may fetch: what `git check-ref-format
/// --branch` accepts, minus anything that could read as an option.
pub fn validate_branch_name(name: &str) -> Result<(), String> {
    let refuse = || {
        Err(format!(
            "code_snapshot_invalid_manifest: {name:?} is not a branch name"
        ))
    };
    if name.is_empty()
        || name.len() > 255
        || name.starts_with(['-', '/', '.'])
        || name.ends_with(['/', '.'])
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("//")
        || name.contains("@{")
        || name.contains("/.")
        || name == "@"
    {
        return refuse();
    }
    if name
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace() || "~^:?*[\\".contains(ch))
    {
        return refuse();
    }
    Ok(())
}

fn validate_subdir(subdir: &str) -> Result<(), String> {
    if subdir.is_empty() {
        return Ok(());
    }
    let path = Path::new(subdir);
    if subdir.contains('\\')
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "code_snapshot_invalid_manifest: subdir {subdir:?} is not a relative path inside the checkout"
        ));
    }
    Ok(())
}

/// The manifest says what the bytes are; check it says it coherently before
/// anything acts on it.
pub fn validate_manifest(manifest: &CodeSnapshotManifest) -> Result<(), String> {
    validate_object_id("sha256", &manifest.sha256).and_then(|_| {
        if manifest.sha256.len() == 64 {
            Ok(())
        } else {
            Err("code_snapshot_invalid_manifest: sha256 is not a sha256".to_string())
        }
    })?;
    validate_subdir(&manifest.subdir)?;
    match manifest.kind {
        CodeSnapshotKind::GitPatch => {
            let base = manifest
                .base_commit
                .as_deref()
                .ok_or("code_snapshot_invalid_manifest: a git snapshot names its base commit")?;
            validate_object_id("baseCommit", base)?;
            let tree = manifest
                .tree
                .as_deref()
                .ok_or("code_snapshot_invalid_manifest: a git snapshot names its tree")?;
            validate_object_id("tree", tree)?;
            if let Some(base_ref) = manifest.base_ref.as_deref() {
                validate_branch_name(base_ref)?;
            }
        }
        CodeSnapshotKind::Tar => {
            if manifest.base_commit.is_some() || manifest.tree.is_some() {
                return Err(
                    "code_snapshot_invalid_manifest: a tar snapshot has no commit or tree".into(),
                );
            }
        }
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 256 * 1024];
    let mut size = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        size += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok((hex::encode(hasher.finalize()), size))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

fn remove_older_than(dir: &Path, ttl: Duration) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= ttl);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/// How the git a step runs is configured.
#[derive(Clone, Copy, PartialEq, Eq)]
enum GitConfig {
    /// The user's own configuration: line endings, filters and excludes decide
    /// what their working copy amounts to.
    User,
    /// None of this machine's configuration, so the host rebuilds the tree
    /// the same way whatever its service account has configured.
    Isolated,
}

struct Git<'a> {
    cwd: &'a Path,
    config: GitConfig,
    index: Option<&'a Path>,
}

impl<'a> Git<'a> {
    fn user(cwd: &'a Path) -> Self {
        Self {
            cwd,
            config: GitConfig::User,
            index: None,
        }
    }

    fn isolated(cwd: &'a Path) -> Self {
        Self {
            cwd,
            config: GitConfig::Isolated,
            index: None,
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new("git");
        command.arg("-C").arg(self.cwd).args(args);
        command.stdin(Stdio::null());
        // A prompt would hang a host with nobody to answer it.
        command.env("GIT_TERMINAL_PROMPT", "0");
        if self.config == GitConfig::Isolated {
            for (key, value) in cognia_git_mirror::credential::isolation_env() {
                command.env(key, value);
            }
        }
        if let Some(index) = self.index {
            command.env("GIT_INDEX_FILE", index);
        }
        command
    }

    fn run(&self, args: &[&str]) -> Result<String, String> {
        let output = self
            .command(args)
            .output()
            .map_err(|error| format!("start git {}: {error}", args.join(" ")))?;
        if !output.status.success() {
            return Err(format!(
                "git {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn ok(&self, args: &[&str]) -> bool {
        self.command(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
}

/// The tree a working copy amounts to: `HEAD` (when there is one) plus
/// `git add -A` in a scratch index, so the user's own index is untouched.
fn working_tree_id(
    git_dir_cwd: &Path,
    config: GitConfig,
    scratch: &Path,
) -> Result<String, String> {
    let _ = fs::remove_file(scratch);
    let git = Git {
        cwd: git_dir_cwd,
        config,
        index: Some(scratch),
    };
    if git.ok(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) {
        git.run(&["read-tree", "HEAD"])?;
    }
    git.run(&["add", "-A", "--", ":/"])?;
    let tree = git.run(&["write-tree"]);
    let _ = fs::remove_file(scratch);
    tree
}

/// The remote the project's repository was recorded from: `origin`, else the
/// first remote (the rule `lib/workspace/project-repository.ts` applies).
fn recorded_remote(git: &Git<'_>) -> Result<String, String> {
    let remotes = git.run(&["remote"])?;
    let names: Vec<&str> = remotes
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    names
        .iter()
        .find(|name| **name == "origin")
        .or_else(|| names.first())
        .map(|name| name.to_string())
        .ok_or_else(|| {
            "code_snapshot_no_remote: the repository has no remote, so the host has nothing to start from"
                .to_string()
        })
}

/// The commit the patch is made against: the merge-base of `HEAD` with a
/// branch the remote has, preferring the one the current branch tracks, then
/// the remote's default branch, then a branch of the same name, then the
/// remote branch the working copy is closest to.
fn choose_base(git: &Git<'_>, remote: &str) -> Result<(String, String), String> {
    let prefix = format!("refs/remotes/{remote}/");
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(upstream) = git.run(&["rev-parse", "--symbolic-full-name", "@{upstream}"]) {
        if upstream.starts_with(&prefix) {
            candidates.push(upstream);
        }
    }
    if let Ok(default) = git.run(&["symbolic-ref", "--quiet", &format!("{prefix}HEAD")]) {
        candidates.push(default);
    }
    if let Ok(branch) = git.run(&["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        candidates.push(format!("{prefix}{branch}"));
    }
    for candidate in &candidates {
        if let Some(found) = merge_base_on(git, candidate, &prefix) {
            return Ok(found);
        }
    }
    // Nothing named fits: the remote branch whose merge-base leaves the
    // fewest commits to carry in the patch.
    let refs = git.run(&[
        "for-each-ref",
        "--format=%(refname)",
        "--sort=-committerdate",
        "--count=64",
        &prefix,
    ])?;
    let mut best: Option<(u64, (String, String))> = None;
    for candidate in refs.lines().filter(|name| !name.ends_with("/HEAD")) {
        let Some(found) = merge_base_on(git, candidate, &prefix) else {
            continue;
        };
        let ahead = git
            .run(&["rev-list", "--count", &format!("{}..HEAD", found.0)])
            .ok()
            .and_then(|count| count.parse::<u64>().ok())
            .unwrap_or(u64::MAX);
        if best.as_ref().is_none_or(|(least, _)| ahead < *least) {
            best = Some((ahead, found));
        }
    }
    best.map(|(_, found)| found).ok_or_else(|| {
        format!(
            "code_snapshot_base_unavailable: no branch on {remote} shares history with this checkout; push a branch first"
        )
    })
}

fn merge_base_on(git: &Git<'_>, remote_ref: &str, prefix: &str) -> Option<(String, String)> {
    let branch = remote_ref.strip_prefix(prefix)?;
    if branch == "HEAD" || validate_branch_name(branch).is_err() {
        return None;
    }
    let base = git.run(&["merge-base", "HEAD", remote_ref]).ok()?;
    validate_object_id("merge-base", &base).ok()?;
    Some((base, branch.to_string()))
}

/// Stream `git diff` into `out`, refusing past `max_bytes`.
fn write_patch(
    git: &Git<'_>,
    base: &str,
    tree: &str,
    out: &Path,
    max_bytes: u64,
) -> Result<u64, String> {
    let args = [
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "diff",
        "--binary",
        "--full-index",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        base,
        tree,
    ];
    let mut child = git
        .command(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("start git diff: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("git diff has no stdout")?;
    let mut file = BufWriter::new(
        File::create(out).map_err(|error| format!("create {}: {error}", out.display()))?,
    );
    let mut buffer = vec![0_u8; 256 * 1024];
    let mut written = 0_u64;
    loop {
        let read = stdout
            .read(&mut buffer)
            .map_err(|error| format!("read git diff: {error}"))?;
        if read == 0 {
            break;
        }
        written += read as u64;
        if written > max_bytes {
            let _ = child.kill();
            let _ = child.wait();
            return Err(too_large(max_bytes));
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("write {}: {error}", out.display()))?;
    }
    file.flush()
        .map_err(|error| format!("write {}: {error}", out.display()))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("wait for git diff: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git diff: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(written)
}

fn too_large(max_bytes: u64) -> String {
    format!(
        "code_snapshot_too_large: the working copy is more than {} MiB; commit and push it, or raise the cap",
        max_bytes / (1024 * 1024)
    )
}

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

/// Make a snapshot of `root` into `out`, returning what it is. `kind` forces
/// one form; `None` picks a patch for a git checkout and a tar otherwise.
pub fn produce_code_snapshot(
    root: &Path,
    max_bytes: u64,
    out: &Path,
    kind: Option<CodeSnapshotKind>,
) -> Result<CodeSnapshotManifest, String> {
    if !root.is_dir() {
        return Err(format!(
            "code_snapshot_root_missing: {} is not a folder on this device",
            root.display()
        ));
    }
    let is_git = Git::user(root).ok(&["rev-parse", "--is-inside-work-tree"]);
    let produced = match kind {
        Some(CodeSnapshotKind::Tar) => produce_tar(root, max_bytes, out),
        Some(CodeSnapshotKind::GitPatch) if !is_git => Err(format!(
            "code_snapshot_not_git: {} is not a git checkout",
            root.display()
        )),
        _ if is_git => produce_git(root, max_bytes, out),
        _ => produce_tar(root, max_bytes, out),
    };
    if produced.is_err() {
        let _ = fs::remove_file(out);
    }
    produced
}

fn produce_git(root: &Path, max_bytes: u64, out: &Path) -> Result<CodeSnapshotManifest, String> {
    let toplevel = PathBuf::from(Git::user(root).run(&["rev-parse", "--show-toplevel"])?);
    let git = Git::user(&toplevel);
    if !git.ok(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) {
        return Err(
            "code_snapshot_base_unavailable: the repository has no commit yet; commit and push one first"
                .into(),
        );
    }
    let subdir = relative_subdir(&toplevel, root)?;
    let remote = recorded_remote(&git)?;
    let (base, base_ref) = choose_base(&git, &remote)?;
    let scratch = out.with_extension("index");
    let tree = working_tree_id(&toplevel, GitConfig::User, &scratch)?;
    let size = write_patch(&git, &base, &tree, out, max_bytes)?;
    let entries = git
        .run(&["diff", "--no-renames", "--name-only", &base, &tree])?
        .lines()
        .filter(|line| !line.is_empty())
        .count() as u64;
    let (sha256, hashed) = hash_file(out)?;
    debug_assert_eq!(hashed, size);
    Ok(CodeSnapshotManifest {
        kind: CodeSnapshotKind::GitPatch,
        size_bytes: size,
        sha256,
        base_commit: Some(base),
        base_ref: Some(base_ref),
        tree: Some(tree),
        subdir,
        entries,
    })
}

fn relative_subdir(toplevel: &Path, root: &Path) -> Result<String, String> {
    let toplevel = toplevel
        .canonicalize()
        .map_err(|error| format!("resolve {}: {error}", toplevel.display()))?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("resolve {}: {error}", root.display()))?;
    let relative = root.strip_prefix(&toplevel).map_err(|_| {
        format!(
            "code_snapshot_root_missing: {} is not inside its repository",
            root.display()
        )
    })?;
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/"))
}

fn produce_tar(root: &Path, max_bytes: u64, out: &Path) -> Result<CodeSnapshotManifest, String> {
    let file = File::create(out).map_err(|error| format!("create {}: {error}", out.display()))?;
    let encoder =
        flate2::write::GzEncoder::new(BufWriter::new(file), flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    builder.follow_symlinks(false);
    builder.mode(tar::HeaderMode::Deterministic);
    let walk = ignore::WalkBuilder::new(root)
        .hidden(false)
        .parents(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .follow_links(false)
        // A repository's own database never travels: its history is not the
        // working copy, and its config can hold a credential.
        .filter_entry(|entry| entry.file_name() != ".git")
        .sort_by_file_path(|a, b| a.cmp(b))
        .build();
    let mut total = 0_u64;
    let mut entries = 0_u64;
    for entry in walk {
        let entry = entry.map_err(|error| format!("walk {}: {error}", root.display()))?;
        let path = entry.path();
        if path == root {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| format!("walk left {}", root.display()))?;
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !(file_type.is_file() || file_type.is_dir() || file_type.is_symlink()) {
            // A socket or a device file is not code.
            continue;
        }
        if file_type.is_file() {
            total += entry
                .metadata()
                .map_err(|error| format!("stat {}: {error}", path.display()))?
                .len();
            if total > max_bytes {
                return Err(too_large(max_bytes));
            }
        }
        entries += 1;
        if entries > CODE_SNAPSHOT_MAX_TAR_ENTRIES {
            return Err(format!(
                "code_snapshot_too_large: more than {CODE_SNAPSHOT_MAX_TAR_ENTRIES} files"
            ));
        }
        builder
            .append_path_with_name(path, relative)
            .map_err(|error| format!("add {} to the snapshot: {error}", path.display()))?;
    }
    let encoder = builder
        .into_inner()
        .map_err(|error| format!("finish the snapshot: {error}"))?;
    encoder
        .finish()
        .and_then(|mut inner| inner.flush())
        .map_err(|error| format!("finish the snapshot: {error}"))?;
    let (sha256, size) = hash_file(out)?;
    if size > max_bytes {
        return Err(too_large(max_bytes));
    }
    Ok(CodeSnapshotManifest {
        kind: CodeSnapshotKind::Tar,
        size_bytes: size,
        sha256,
        base_commit: None,
        base_ref: None,
        tree: None,
        subdir: String::new(),
        entries,
    })
}

// ---------------------------------------------------------------------------
// Receiver
// ---------------------------------------------------------------------------

/// Validate one tar entry's path and, for a symlink, its target: relative,
/// and never leading out of the checkout.
fn validate_tar_entry(path: &Path, link: Option<&Path>) -> Result<(), String> {
    let refuse = |why: &str| {
        Err(format!(
            "code_snapshot_unsafe_archive: {} {why}",
            path.display()
        ))
    };
    let mut depth = 0_usize;
    for component in path.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            _ => return refuse("leaves the checkout"),
        }
    }
    if depth == 0 {
        return refuse("names no file");
    }
    if let Some(target) = link {
        let mut level = depth as isize - 1;
        for component in target.components() {
            match component {
                Component::Normal(_) => level += 1,
                Component::CurDir => {}
                Component::ParentDir => {
                    level -= 1;
                    if level < 0 {
                        return refuse("links outside the checkout");
                    }
                }
                _ => return refuse("links to an absolute path"),
            }
        }
    }
    Ok(())
}

/// Unpack a gzip tar into `dest`, checking every entry first. Returns how
/// many entries it held.
pub fn extract_tar_snapshot(archive: &Path, dest: &Path, max_bytes: u64) -> Result<u64, String> {
    let file =
        File::open(archive).map_err(|error| format!("open {}: {error}", archive.display()))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    tar.set_overwrite(false);
    tar.set_preserve_permissions(false);
    tar.set_unpack_xattrs(false);
    let mut total = 0_u64;
    let mut count = 0_u64;
    let entries = tar
        .entries()
        .map_err(|error| format!("code_snapshot_unsafe_archive: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("code_snapshot_unsafe_archive: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("code_snapshot_unsafe_archive: {error}"))?
            .into_owned();
        let kind = entry.header().entry_type();
        let link = match kind {
            tar::EntryType::Regular | tar::EntryType::Directory => None,
            tar::EntryType::Symlink => Some(
                entry
                    .link_name()
                    .map_err(|error| format!("code_snapshot_unsafe_archive: {error}"))?
                    .ok_or_else(|| {
                        format!(
                            "code_snapshot_unsafe_archive: {} links nowhere",
                            path.display()
                        )
                    })?
                    .into_owned(),
            ),
            other => {
                return Err(format!(
                    "code_snapshot_unsafe_archive: {} is a {other:?}, not a file, folder or link",
                    path.display()
                ))
            }
        };
        validate_tar_entry(&path, link.as_deref())?;
        count += 1;
        if count > CODE_SNAPSHOT_MAX_TAR_ENTRIES {
            return Err(format!(
                "code_snapshot_unsafe_archive: more than {CODE_SNAPSHOT_MAX_TAR_ENTRIES} entries"
            ));
        }
        total = total.saturating_add(entry.size());
        if total > max_bytes {
            return Err(format!(
                "code_snapshot_unsafe_archive: unpacks to more than {max_bytes} bytes"
            ));
        }
        let unpacked = entry
            .unpack_in(dest)
            .map_err(|error| format!("unpack {}: {error}", path.display()))?;
        if !unpacked {
            return Err(format!(
                "code_snapshot_unsafe_archive: {} leaves the checkout",
                path.display()
            ));
        }
    }
    Ok(count)
}

/// The branch a handed-over checkout is on.
pub fn handoff_branch(checkout_id: &str) -> String {
    let compact: String = checkout_id
        .chars()
        .filter(char::is_ascii_hexdigit)
        .collect();
    let tail = &compact[compact.len().saturating_sub(12)..];
    format!("cognia/handoff-{tail}")
}

/// Add a worktree of `source` at `base` on a new branch, apply the patch, and
/// prove the result is the tree the desktop had. On any failure the worktree
/// and branch are removed again.
pub fn check_out_patch(
    source: &Path,
    dest: &Path,
    branch: &str,
    base: &str,
    patch: &Path,
    expected_tree: &str,
    reason: &str,
) -> Result<(), String> {
    let git = Git::isolated(source);
    if !git.ok(&["cat-file", "-e", &format!("{base}^{{commit}}")]) {
        return Err(format!(
            "code_snapshot_base_unavailable: the host has no commit {base}; push it, then try again"
        ));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let dest_text = dest.to_string_lossy().into_owned();
    git.run(&[
        "worktree", "add", "--lock", "--reason", reason, "-b", branch, &dest_text, base,
    ])?;
    let applied = apply_and_verify(dest, patch, expected_tree);
    if applied.is_err() {
        let _ = git.run(&["worktree", "remove", "--force", "--force", &dest_text]);
        let _ = fs::remove_dir_all(dest);
        let _ = git.run(&["worktree", "prune"]);
        let _ = git.run(&["branch", "-D", branch]);
    }
    applied
}

fn apply_and_verify(dest: &Path, patch: &Path, expected_tree: &str) -> Result<(), String> {
    let git = Git::isolated(dest);
    let patch_text = patch.to_string_lossy().into_owned();
    if fs::metadata(patch)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
        > 0
    {
        git.run(&["apply", "--binary", "--whitespace=nowarn", &patch_text])
            .map_err(|error| format!("code_snapshot_apply_failed: {error}"))?;
    }
    let scratch = dest.parent().unwrap_or(dest).join(format!(
        ".{}.verify-index",
        dest.file_name().unwrap_or_default().to_string_lossy()
    ));
    let tree = working_tree_id(dest, GitConfig::Isolated, &scratch)?;
    if tree != expected_tree {
        return Err(format!(
            "code_snapshot_tree_mismatch: the copy on the host is tree {tree}, the desktop's was {expected_tree}"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/// Snapshots this device made and has not uploaded yet.
pub struct CodeSnapshotOutbox {
    dir: PathBuf,
}

impl CodeSnapshotOutbox {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, snapshot_id: &str) -> Result<PathBuf, String> {
        validate_id(snapshot_id)?;
        Ok(self.dir.join(format!("{snapshot_id}.snapshot")))
    }

    pub fn create(&self, input: &CreateCodeSnapshot) -> Result<CreatedCodeSnapshot, String> {
        let max_bytes = input
            .max_bytes
            .unwrap_or(DEFAULT_CODE_SNAPSHOT_MAX_BYTES)
            .clamp(1, CODE_SNAPSHOT_MAX_BYTES_CEILING);
        fs::create_dir_all(&self.dir)
            .map_err(|error| format!("create {}: {error}", self.dir.display()))?;
        remove_older_than(&self.dir, PRODUCED_TTL);
        let snapshot_id = new_id();
        let out = self.path(&snapshot_id)?;
        let manifest =
            produce_code_snapshot(Path::new(input.root.trim()), max_bytes, &out, input.kind)?;
        Ok(CreatedCodeSnapshot {
            snapshot_id,
            manifest,
            chunk_bytes: MAX_TRANSFER_CHUNK_BYTES,
        })
    }

    pub fn read_chunk(&self, snapshot_id: &str, offset: u64) -> Result<TransferChunk, String> {
        let path = self.path(snapshot_id)?;
        let mut file =
            File::open(&path).map_err(|_| format!("code_snapshot_not_found: {snapshot_id}"))?;
        let size = file
            .metadata()
            .map_err(|error| format!("stat {}: {error}", path.display()))?
            .len();
        if offset > size {
            return Err(format!("read offset {offset} is past the end ({size})"));
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("seek {}: {error}", path.display()))?;
        let length = (size - offset).min(MAX_TRANSFER_CHUNK_BYTES as u64) as usize;
        let mut bytes = vec![0_u8; length];
        file.read_exact(&mut bytes)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        let next_offset = offset + length as u64;
        Ok(TransferChunk {
            offset,
            next_offset,
            chunk_hash: hex::encode(Sha256::digest(&bytes)),
            data_base64: STANDARD.encode(&bytes),
            eof: next_offset == size,
        })
    }

    pub fn discard(&self, snapshot_id: &str) -> Result<(), String> {
        let path = self.path(snapshot_id)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("remove {}: {error}", path.display())),
        }
    }
}

/// Snapshots arriving on this host, and the checkouts they became.
pub struct CodeSnapshotInbox {
    incoming: PathBuf,
    records: PathBuf,
    checkouts: PathBuf,
    max_bytes: u64,
    uploads: TransferRegistry,
    /// Upload handle -> the snapshot id it will be staged under.
    pending: Mutex<HashMap<String, String>>,
}

impl CodeSnapshotInbox {
    /// `state_dir` holds staged uploads and checkout records; `checkouts` the
    /// checkouts themselves (under the execution root).
    pub fn new(state_dir: &Path, checkouts: PathBuf, max_bytes: u64) -> Self {
        Self {
            incoming: state_dir.join("incoming"),
            records: state_dir.join("checkouts"),
            checkouts,
            max_bytes,
            uploads: TransferRegistry::new(Duration::from_secs(5 * 60)),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn limits(&self) -> CodeSnapshotLimits {
        CodeSnapshotLimits {
            max_bytes: self.max_bytes,
            chunk_bytes: MAX_TRANSFER_CHUNK_BYTES,
        }
    }

    pub fn open_upload(&self, size_bytes: u64, sha256: &str) -> Result<CodeSnapshotUpload, String> {
        if size_bytes > self.max_bytes {
            return Err(format!(
                "code_snapshot_too_large: this host accepts at most {} bytes",
                self.max_bytes
            ));
        }
        fs::create_dir_all(&self.incoming)
            .map_err(|error| format!("create {}: {error}", self.incoming.display()))?;
        remove_older_than(&self.incoming, STAGED_TTL);
        let snapshot_id = new_id();
        let handle = self.uploads.open_upload(
            &self.incoming,
            &format!("{snapshot_id}.snapshot"),
            size_bytes,
            sha256,
            false,
        )?;
        self.pending
            .lock()
            .insert(handle.handle_id.clone(), snapshot_id.clone());
        Ok(CodeSnapshotUpload {
            upload_id: handle.handle_id,
            snapshot_id,
            chunk_bytes: handle.chunk_bytes,
            max_bytes: self.max_bytes,
        })
    }

    pub fn write_chunk(
        &self,
        upload_id: &str,
        offset: u64,
        data_base64: &str,
        chunk_hash: &str,
    ) -> Result<u64, String> {
        self.uploads
            .write_chunk(upload_id, offset, data_base64, chunk_hash)
    }

    pub fn commit_upload(&self, upload_id: &str) -> Result<CommittedCodeSnapshot, String> {
        let snapshot_id = self
            .pending
            .lock()
            .remove(upload_id)
            .ok_or_else(|| format!("unknown or expired upload handle: {upload_id}"))?;
        let sha256 = self.uploads.commit_upload(upload_id)?;
        let size_bytes = fs::metadata(self.staged_path(&snapshot_id)?)
            .map_err(|error| format!("stat the staged snapshot: {error}"))?
            .len();
        Ok(CommittedCodeSnapshot {
            snapshot_id,
            sha256,
            size_bytes,
        })
    }

    pub fn cancel_upload(&self, upload_id: &str) -> Result<(), String> {
        self.pending.lock().remove(upload_id);
        self.uploads.abort_upload(upload_id)
    }

    fn staged_path(&self, snapshot_id: &str) -> Result<PathBuf, String> {
        validate_id(snapshot_id)?;
        Ok(self.incoming.join(format!("{snapshot_id}.snapshot")))
    }

    /// The staged bytes for `snapshot_id`, checked against `manifest`.
    pub fn staged(
        &self,
        snapshot_id: &str,
        manifest: &CodeSnapshotManifest,
    ) -> Result<PathBuf, String> {
        validate_manifest(manifest)?;
        let path = self.staged_path(snapshot_id)?;
        if !path.is_file() {
            return Err(format!(
                "code_snapshot_not_found: {snapshot_id} was not uploaded here"
            ));
        }
        let (sha256, size) = hash_file(&path)?;
        if sha256 != manifest.sha256 || size != manifest.size_bytes {
            return Err("code_snapshot_integrity_failed: the uploaded bytes are not the snapshot the manifest describes".into());
        }
        Ok(path)
    }

    pub fn discard_staged(&self, snapshot_id: &str) {
        if let Ok(path) = self.staged_path(snapshot_id) {
            let _ = fs::remove_file(path);
        }
    }

    pub fn checkout_dir(&self, checkout_id: &str) -> Result<PathBuf, String> {
        validate_id(checkout_id)?;
        Ok(self.checkouts.join(checkout_id))
    }

    fn record_path(&self, checkout_id: &str) -> Result<PathBuf, String> {
        validate_id(checkout_id)?;
        Ok(self.records.join(format!("{checkout_id}.json")))
    }

    pub fn checkout(&self, checkout_id: &str) -> Result<Option<CodeCheckout>, String> {
        let path = self.record_path(checkout_id)?;
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|error| format!("read {}: {error}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("read {}: {error}", path.display())),
        }
    }

    pub fn record(&self, checkout: &CodeCheckout) -> Result<(), String> {
        fs::create_dir_all(&self.records)
            .map_err(|error| format!("create {}: {error}", self.records.display()))?;
        let path = self.record_path(&checkout.checkout_id)?;
        let temp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(checkout).map_err(|error| error.to_string())?;
        fs::write(&temp, bytes).map_err(|error| format!("write {}: {error}", temp.display()))?;
        fs::rename(&temp, &path).map_err(|error| format!("write {}: {error}", path.display()))
    }

    /// Unpack a staged tar into its checkout and record it.
    pub fn apply_tar(
        &self,
        input: &ApplyCodeSnapshot,
        staged: &Path,
    ) -> Result<CodeCheckout, String> {
        let dest = self.checkout_dir(&input.snapshot_id)?;
        if dest.exists() {
            return Err(format!(
                "code_snapshot_checkout_exists: {} already exists",
                dest.display()
            ));
        }
        fs::create_dir_all(&dest).map_err(|error| format!("create {}: {error}", dest.display()))?;
        if let Err(error) = extract_tar_snapshot(staged, &dest, self.max_bytes) {
            let _ = fs::remove_dir_all(&dest);
            return Err(error);
        }
        let root = dest.to_string_lossy().into_owned();
        let checkout = CodeCheckout {
            checkout_id: input.snapshot_id.clone(),
            working_dir: root.clone(),
            root,
            kind: CodeSnapshotKind::Tar,
            branch: None,
            base_commit: None,
            project_id: input.project_id.clone(),
            remote_url: None,
            created_at: now_ms(),
        };
        self.record(&checkout)?;
        Ok(checkout)
    }

    /// Record a checkout [`check_out_patch`] made.
    pub fn record_patch_checkout(
        &self,
        input: &ApplyCodeSnapshot,
        dest: &Path,
        branch: String,
        remote_url: Option<String>,
    ) -> Result<CodeCheckout, String> {
        let root = dest.to_string_lossy().into_owned();
        let working_dir = if input.manifest.subdir.is_empty() {
            root.clone()
        } else {
            dest.join(&input.manifest.subdir)
                .to_string_lossy()
                .into_owned()
        };
        let checkout = CodeCheckout {
            checkout_id: input.snapshot_id.clone(),
            root,
            working_dir,
            kind: CodeSnapshotKind::GitPatch,
            branch: Some(branch),
            base_commit: input.manifest.base_commit.clone(),
            project_id: input.project_id.clone(),
            remote_url,
            created_at: now_ms(),
        };
        self.record(&checkout)?;
        Ok(checkout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sh(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// An upstream with one commit, and a clone of it that tracks `main`.
    fn repository(tmp: &TempDir) -> (PathBuf, PathBuf) {
        let upstream = tmp.path().join("upstream");
        fs::create_dir_all(&upstream).unwrap();
        sh(&upstream, &["init", "--initial-branch=main", "."]);
        fs::write(upstream.join("README.md"), "hello\n").unwrap();
        fs::write(upstream.join("gone.txt"), "delete me\n").unwrap();
        fs::write(upstream.join("run.sh"), "echo hi\n").unwrap();
        fs::write(upstream.join(".gitignore"), "target/\n").unwrap();
        sh(&upstream, &["add", "."]);
        sh(&upstream, &["commit", "-m", "first"]);
        let clone = tmp.path().join("desk");
        sh(
            tmp.path(),
            &[
                "clone",
                "-q",
                upstream.to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
        );
        (upstream, clone)
    }

    /// Every kind of change the producer has to carry.
    fn edit_everything(clone: &Path) {
        fs::write(clone.join("README.md"), "hello, edited\n").unwrap();
        fs::remove_file(clone.join("gone.txt")).unwrap();
        fs::write(clone.join("logo.bin"), [0_u8, 159, 146, 150, 255, 0, 7]).unwrap();
        fs::create_dir_all(clone.join("src")).unwrap();
        fs::write(clone.join("src/new.rs"), "fn main() {}\n").unwrap();
        fs::create_dir_all(clone.join("target")).unwrap();
        fs::write(clone.join("target/ignored.o"), "build output").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(clone.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn a_git_snapshot_carries_edits_untracked_deletes_binaries_and_modes() {
        let tmp = TempDir::new().unwrap();
        let (upstream, clone) = repository(&tmp);
        // A local commit that was never pushed travels inside the patch.
        fs::write(clone.join("local.txt"), "committed here only\n").unwrap();
        sh(&clone, &["add", "local.txt"]);
        sh(&clone, &["commit", "-m", "local"]);
        edit_everything(&clone);

        let out = tmp.path().join("snap.patch");
        let manifest =
            produce_code_snapshot(&clone, DEFAULT_CODE_SNAPSHOT_MAX_BYTES, &out, None).unwrap();
        assert_eq!(manifest.kind, CodeSnapshotKind::GitPatch);
        assert_eq!(
            manifest.base_commit.as_deref(),
            Some(sh(&upstream, &["rev-parse", "HEAD"]).as_str())
        );
        assert_eq!(manifest.base_ref.as_deref(), Some("main"));
        assert_eq!(manifest.subdir, "");
        let patch = fs::read(&out).unwrap();
        assert_eq!(manifest.size_bytes, patch.len() as u64);
        let text = String::from_utf8_lossy(&patch);
        assert!(text.contains("GIT binary patch"), "{text}");
        assert!(text.contains("deleted file mode"), "{text}");
        assert!(text.contains("b/local.txt"), "{text}");
        assert!(!text.contains("ignored.o"), "{text}");
        #[cfg(unix)]
        assert!(text.contains("new mode 100755"), "{text}");
        // The user's own index is untouched.
        assert!(sh(&clone, &["diff", "--cached", "--name-only"]).is_empty());

        // The round trip: a fresh worktree of the upstream at the base, the
        // patch applied, the same tree.
        let dest = tmp.path().join("host/handoffs/one");
        check_out_patch(
            &upstream,
            &dest,
            "cognia/handoff-test",
            manifest.base_commit.as_deref().unwrap(),
            &out,
            manifest.tree.as_deref().unwrap(),
            "test",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(dest.join("README.md")).unwrap(),
            "hello, edited\n"
        );
        assert!(!dest.join("gone.txt").exists());
        assert_eq!(
            fs::read(dest.join("logo.bin")).unwrap(),
            [0_u8, 159, 146, 150, 255, 0, 7]
        );
        assert_eq!(
            fs::read_to_string(dest.join("local.txt")).unwrap(),
            "committed here only\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dest.join("run.sh"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111);
        }
        assert_eq!(
            sh(&dest, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "cognia/handoff-test"
        );
    }

    #[test]
    fn a_patch_whose_result_is_not_the_desktops_tree_is_refused_and_cleaned_up() {
        let tmp = TempDir::new().unwrap();
        let (upstream, clone) = repository(&tmp);
        edit_everything(&clone);
        let out = tmp.path().join("snap.patch");
        let manifest =
            produce_code_snapshot(&clone, DEFAULT_CODE_SNAPSHOT_MAX_BYTES, &out, None).unwrap();
        let wrong_tree = sh(&upstream, &["rev-parse", "HEAD^{tree}"]);
        let dest = tmp.path().join("host/handoffs/two");
        let error = check_out_patch(
            &upstream,
            &dest,
            "cognia/handoff-two",
            manifest.base_commit.as_deref().unwrap(),
            &out,
            &wrong_tree,
            "test",
        )
        .unwrap_err();
        assert!(error.starts_with("code_snapshot_tree_mismatch"), "{error}");
        assert!(!dest.exists());
        assert!(sh(&upstream, &["branch", "--list", "cognia/handoff-two"]).is_empty());
    }

    #[test]
    fn a_base_the_host_lacks_is_refused_before_any_checkout() {
        let tmp = TempDir::new().unwrap();
        let (upstream, _clone) = repository(&tmp);
        let patch = tmp.path().join("empty.patch");
        fs::write(&patch, "").unwrap();
        let error = check_out_patch(
            &upstream,
            &tmp.path().join("host/x"),
            "cognia/handoff-x",
            &"1".repeat(40),
            &patch,
            &"2".repeat(40),
            "test",
        )
        .unwrap_err();
        assert!(
            error.starts_with("code_snapshot_base_unavailable"),
            "{error}"
        );
    }

    #[test]
    fn a_working_directory_below_the_repository_root_is_recorded_as_its_subdir() {
        let tmp = TempDir::new().unwrap();
        let (_upstream, clone) = repository(&tmp);
        fs::create_dir_all(clone.join("apps/web")).unwrap();
        fs::write(clone.join("apps/web/page.tsx"), "export {}\n").unwrap();
        let out = tmp.path().join("snap.patch");
        let manifest = produce_code_snapshot(
            &clone.join("apps/web"),
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES,
            &out,
            None,
        )
        .unwrap();
        assert_eq!(manifest.subdir, "apps/web");
        // The whole repository travels, not only the subfolder.
        assert!(fs::read_to_string(&out)
            .unwrap()
            .contains("b/apps/web/page.tsx"));
    }

    #[test]
    fn a_repository_with_nothing_on_its_remote_is_refused() {
        let tmp = TempDir::new().unwrap();
        let local = tmp.path().join("local");
        fs::create_dir_all(&local).unwrap();
        sh(&local, &["init", "--initial-branch=main", "."]);
        fs::write(local.join("a.txt"), "a\n").unwrap();
        sh(&local, &["add", "."]);
        sh(&local, &["commit", "-m", "first"]);
        let out = tmp.path().join("snap.patch");
        let error =
            produce_code_snapshot(&local, DEFAULT_CODE_SNAPSHOT_MAX_BYTES, &out, None).unwrap_err();
        assert!(error.starts_with("code_snapshot_no_remote"), "{error}");
        assert!(!out.exists());
    }

    #[test]
    fn a_snapshot_over_the_cap_is_refused_and_leaves_nothing() {
        let tmp = TempDir::new().unwrap();
        let (_upstream, clone) = repository(&tmp);
        fs::write(clone.join("big.txt"), "x".repeat(10_000)).unwrap();
        let out = tmp.path().join("snap.patch");
        let error = produce_code_snapshot(&clone, 1_000, &out, None).unwrap_err();
        assert!(error.starts_with("code_snapshot_too_large"), "{error}");
        assert!(!out.exists());
    }

    #[test]
    fn a_folder_without_git_goes_as_a_tar_that_unpacks_to_the_same_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("plain");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("notes.md"), "# notes\n").unwrap();
        fs::write(root.join("docs/data.bin"), [1_u8, 2, 3, 0, 255]).unwrap();
        fs::write(root.join(".gitignore"), "cache/\n").unwrap();
        fs::create_dir_all(root.join("cache")).unwrap();
        fs::write(root.join("cache/skip.tmp"), "skip").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("notes.md", root.join("link.md")).unwrap();

        let out = tmp.path().join("snap.tar.gz");
        let manifest =
            produce_code_snapshot(&root, DEFAULT_CODE_SNAPSHOT_MAX_BYTES, &out, None).unwrap();
        assert_eq!(manifest.kind, CodeSnapshotKind::Tar);
        assert!(manifest.base_commit.is_none() && manifest.tree.is_none());

        let dest = tmp.path().join("unpacked");
        fs::create_dir_all(&dest).unwrap();
        extract_tar_snapshot(&out, &dest, DEFAULT_CODE_SNAPSHOT_MAX_BYTES).unwrap();
        assert_eq!(
            fs::read_to_string(dest.join("notes.md")).unwrap(),
            "# notes\n"
        );
        assert_eq!(
            fs::read(dest.join("docs/data.bin")).unwrap(),
            [1_u8, 2, 3, 0, 255]
        );
        assert!(!dest.join("cache").exists());
        #[cfg(unix)]
        assert_eq!(
            fs::read_link(dest.join("link.md")).unwrap(),
            PathBuf::from("notes.md")
        );
    }

    #[test]
    fn a_git_checkout_sent_as_a_tar_leaves_its_repository_behind() {
        let tmp = TempDir::new().unwrap();
        let (_upstream, clone) = repository(&tmp);
        edit_everything(&clone);
        let out = tmp.path().join("snap.tar.gz");
        let manifest = produce_code_snapshot(
            &clone,
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES,
            &out,
            Some(CodeSnapshotKind::Tar),
        )
        .unwrap();
        assert_eq!(manifest.kind, CodeSnapshotKind::Tar);
        let dest = tmp.path().join("unpacked");
        fs::create_dir_all(&dest).unwrap();
        extract_tar_snapshot(&out, &dest, DEFAULT_CODE_SNAPSHOT_MAX_BYTES).unwrap();
        assert!(!dest.join(".git").exists());
        assert!(!dest.join("target").exists(), "ignored files stay behind");
        assert_eq!(
            fs::read_to_string(dest.join("README.md")).unwrap(),
            "hello, edited\n"
        );

        let plain = tmp.path().join("plain");
        fs::create_dir_all(&plain).unwrap();
        let error = produce_code_snapshot(
            &plain,
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES,
            &tmp.path().join("x"),
            Some(CodeSnapshotKind::GitPatch),
        )
        .unwrap_err();
        assert!(error.starts_with("code_snapshot_not_git"), "{error}");
    }

    fn tar_with(entries: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        entries(&mut builder);
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn a_tar_that_reaches_outside_the_checkout_is_refused() {
        let tmp = TempDir::new().unwrap();
        let escapes = tar_with(|builder| {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            builder
                .append_link(&mut header, "docs/out", "../../etc")
                .unwrap();
        });
        let archive = tmp.path().join("escape.tar.gz");
        fs::write(&archive, escapes).unwrap();
        let dest = tmp.path().join("dest");
        fs::create_dir_all(&dest).unwrap();
        let error =
            extract_tar_snapshot(&archive, &dest, DEFAULT_CODE_SNAPSHOT_MAX_BYTES).unwrap_err();
        assert!(error.starts_with("code_snapshot_unsafe_archive"), "{error}");

        let device = tar_with(|builder| {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Char);
            header.set_size(0);
            header.set_path("dev").unwrap();
            header.set_cksum();
            builder.append(&header, std::io::empty()).unwrap();
        });
        fs::write(&archive, device).unwrap();
        let error =
            extract_tar_snapshot(&archive, &dest, DEFAULT_CODE_SNAPSHOT_MAX_BYTES).unwrap_err();
        assert!(error.contains("not a file, folder or link"), "{error}");
    }

    #[test]
    fn a_tar_that_unpacks_past_the_cap_is_refused() {
        let tmp = TempDir::new().unwrap();
        let bomb = tar_with(|builder| {
            let data = vec![0_u8; 4096];
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            builder
                .append_data(&mut header, "zeros.bin", data.as_slice())
                .unwrap();
        });
        let archive = tmp.path().join("bomb.tar.gz");
        fs::write(&archive, bomb).unwrap();
        let dest = tmp.path().join("dest");
        fs::create_dir_all(&dest).unwrap();
        let error = extract_tar_snapshot(&archive, &dest, 1024).unwrap_err();
        assert!(error.contains("unpacks to more than"), "{error}");
    }

    #[test]
    fn tar_paths_and_link_targets_stay_inside() {
        assert!(validate_tar_entry(Path::new("a/b.txt"), None).is_ok());
        assert!(validate_tar_entry(Path::new("a/link"), Some(Path::new("../b.txt"))).is_ok());
        assert!(validate_tar_entry(Path::new("a/link"), Some(Path::new("../../x"))).is_err());
        assert!(validate_tar_entry(Path::new("../x"), None).is_err());
        assert!(validate_tar_entry(Path::new("/etc/passwd"), None).is_err());
        assert!(validate_tar_entry(Path::new("link"), Some(Path::new("/etc"))).is_err());
    }

    #[test]
    fn a_manifest_is_checked_before_anything_acts_on_it() {
        let good = CodeSnapshotManifest {
            kind: CodeSnapshotKind::GitPatch,
            size_bytes: 1,
            sha256: "a".repeat(64),
            base_commit: Some("b".repeat(40)),
            base_ref: Some("feature/x".into()),
            tree: Some("c".repeat(40)),
            subdir: "apps/web".into(),
            entries: 1,
        };
        assert!(validate_manifest(&good).is_ok());
        for bad in [
            CodeSnapshotManifest {
                sha256: "z".repeat(64),
                ..good.clone()
            },
            CodeSnapshotManifest {
                base_commit: None,
                ..good.clone()
            },
            CodeSnapshotManifest {
                base_ref: Some("-c core.x".into()),
                ..good.clone()
            },
            CodeSnapshotManifest {
                base_ref: Some("a..b".into()),
                ..good.clone()
            },
            CodeSnapshotManifest {
                subdir: "../up".into(),
                ..good.clone()
            },
            CodeSnapshotManifest {
                subdir: "/abs".into(),
                ..good.clone()
            },
            CodeSnapshotManifest {
                kind: CodeSnapshotKind::Tar,
                ..good.clone()
            },
        ] {
            assert!(validate_manifest(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn ids_name_files_only_in_the_shape_minted_here() {
        assert!(validate_id(&new_id()).is_ok());
        for bad in [
            "../x",
            "",
            "0190e0e0e0e0",
            "0190E0E0-0000-7000-8000-000000000000",
        ] {
            assert!(validate_id(bad).is_err(), "{bad}");
        }
        let branch = handoff_branch("0190e0e0-1111-7222-8333-444455556666");
        assert_eq!(branch, "cognia/handoff-444455556666");
        assert!(validate_branch_name(&branch).is_ok());
    }

    #[test]
    fn the_host_cap_is_the_default_unless_configured() {
        assert_eq!(
            code_snapshot_max_bytes_from(None).unwrap(),
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES
        );
        assert_eq!(
            code_snapshot_max_bytes_from(Some(" ")).unwrap(),
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES
        );
        assert_eq!(
            code_snapshot_max_bytes_from(Some("1048576")).unwrap(),
            1_048_576
        );
        assert!(code_snapshot_max_bytes_from(Some("0")).is_err());
        assert!(code_snapshot_max_bytes_from(Some("lots")).is_err());
        assert!(code_snapshot_max_bytes_from(Some(
            &(CODE_SNAPSHOT_MAX_BYTES_CEILING + 1).to_string()
        ))
        .is_err());
    }

    #[test]
    fn a_snapshot_travels_through_the_outbox_and_inbox_intact() {
        let tmp = TempDir::new().unwrap();
        let (_upstream, clone) = repository(&tmp);
        edit_everything(&clone);
        let outbox = CodeSnapshotOutbox::new(tmp.path().join("out"));
        let created = outbox
            .create(&CreateCodeSnapshot {
                root: clone.to_string_lossy().into_owned(),
                max_bytes: None,
                kind: None,
            })
            .unwrap();

        let inbox = CodeSnapshotInbox::new(
            &tmp.path().join("host-state"),
            tmp.path().join("host-exec/handoffs"),
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES,
        );
        let upload = inbox
            .open_upload(created.manifest.size_bytes, &created.manifest.sha256)
            .unwrap();
        let mut offset = 0_u64;
        loop {
            let chunk = outbox.read_chunk(&created.snapshot_id, offset).unwrap();
            if chunk.next_offset > chunk.offset {
                offset = inbox
                    .write_chunk(
                        &upload.upload_id,
                        chunk.offset,
                        &chunk.data_base64,
                        &chunk.chunk_hash,
                    )
                    .unwrap();
            }
            if chunk.eof {
                break;
            }
        }
        let committed = inbox.commit_upload(&upload.upload_id).unwrap();
        assert_eq!(committed.snapshot_id, upload.snapshot_id);
        assert_eq!(committed.sha256, created.manifest.sha256);
        assert!(inbox
            .staged(&committed.snapshot_id, &created.manifest)
            .is_ok());

        // Bytes that are not what the manifest says are refused.
        let lying = CodeSnapshotManifest {
            sha256: "0".repeat(64),
            ..created.manifest.clone()
        };
        assert!(inbox
            .staged(&committed.snapshot_id, &lying)
            .unwrap_err()
            .starts_with("code_snapshot_integrity_failed"));

        outbox.discard(&created.snapshot_id).unwrap();
        assert!(outbox.read_chunk(&created.snapshot_id, 0).is_err());
    }

    #[test]
    fn an_upload_over_the_host_cap_is_refused_at_open() {
        let tmp = TempDir::new().unwrap();
        let inbox = CodeSnapshotInbox::new(&tmp.path().join("s"), tmp.path().join("c"), 10);
        let error = inbox.open_upload(11, &"a".repeat(64)).unwrap_err();
        assert!(error.starts_with("code_snapshot_too_large"), "{error}");
        assert_eq!(inbox.limits().max_bytes, 10);
    }

    #[test]
    fn a_tar_checkout_is_recorded_and_found_again() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("plain");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        let archive = tmp.path().join("a.tar.gz");
        let manifest =
            produce_code_snapshot(&root, DEFAULT_CODE_SNAPSHOT_MAX_BYTES, &archive, None).unwrap();
        let inbox = CodeSnapshotInbox::new(
            &tmp.path().join("state"),
            tmp.path().join("exec/handoffs"),
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES,
        );
        let id = new_id();
        let input = ApplyCodeSnapshot {
            snapshot_id: id.clone(),
            manifest,
            project_id: Some("project-1".into()),
            roots: vec![],
            remote_url: None,
            credential: None,
        };
        let checkout = inbox.apply_tar(&input, &archive).unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&checkout.root).join("a.txt")).unwrap(),
            "a\n"
        );
        assert_eq!(inbox.checkout(&id).unwrap(), Some(checkout));
        assert_eq!(inbox.checkout(&new_id()).unwrap(), None);
        assert!(
            inbox.apply_tar(&input, &archive).is_err(),
            "a second apply must not overwrite"
        );
    }
}
