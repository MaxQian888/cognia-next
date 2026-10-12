//! Bring a handed-over conversation's work back (ADR-0224 A11c).
//!
//! A conversation continued on an always-on host works in a checkout of its
//! own (A11b): a worktree on a `cognia/handoff-…` branch, or the unpacked
//! files of a folder without git. This module is both ends of the return.
//!
//! # On the host: the export
//!
//! The work is what the checkout holds right now: the commits the agent made
//! on top of the base, plus one more commit for anything it left uncommitted
//! (built from a scratch index, so neither the agent's branch nor its index
//! moves). That tip goes on a branch named `cognia/<agent>-<id>` and is pushed
//! to the project's repository with the host's stored git credential. When the
//! push cannot happen (no credential, no repository, a refusal) the same
//! commits leave as a git bundle whose only prerequisite is the base, so the
//! desktop gets them exactly, commit ids and all. A folder without git comes
//! back as a tar of its files, like it went.
//!
//! # On the desktop: the apply
//!
//! The commits arrive by fetching the pushed branch (with the user's own git
//! credentials) or out of the bundle, and must be the very commit the host
//! named. They are checked out into a new worktree on a new local branch,
//! never into the folder the conversation started from. A tar is unpacked
//! into a new folder. Applying the same result twice answers with the
//! worktree the first apply made.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use cognia_git_mirror::credential::{auth_env, origin_of, redact, GitCredential};

use crate::code_snapshot::{
    extract_tar_snapshot, hash_file, new_id, produce_tar, too_large, validate_branch_name,
    validate_object_id, working_tree_id, CodeCheckout, CodeSnapshotInbox, CodeSnapshotKind,
    CodeSnapshotManifest, CodeSnapshotOutbox, Git, GitConfig,
};
use crate::transfer::MAX_TRANSFER_CHUNK_BYTES;

/// What names the branch when the caller does not.
pub const DEFAULT_RESULT_AGENT: &str = "agent";

/// The message of the commit that carries uncommitted work.
const UNCOMMITTED_MESSAGE: &str = "Uncommitted work handed back from an always-on host";

/// How many local branch names an apply tries before giving up.
const MAX_BRANCH_SUFFIX: u32 = 50;

/// How the work comes back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CodeResultKind {
    /// Pushed to the repository's remote as `branch`.
    Branch,
    /// A git bundle to read from the host.
    Bundle,
    /// A gzip tar of a folder without git, to read from the host.
    Tar,
}

/// Export a handed-over checkout's work.
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ExportCodeCheckout {
    pub checkout_id: String,
    /// Names the branch, `cognia/<agent>-<id>`: lowercase letters, digits and
    /// dashes. `agent` when absent.
    #[serde(default)]
    pub agent: Option<String>,
    /// A token for the push; when absent the host's stored credential is used.
    #[serde(default, skip_serializing)]
    pub credential: Option<String>,
}

impl fmt::Debug for ExportCodeCheckout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExportCodeCheckout")
            .field("checkout_id", &self.checkout_id)
            .field("agent", &self.agent)
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// Bytes waiting on the host to be read out chunk by chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CodeResultTransfer {
    pub result_id: String,
    pub manifest: CodeSnapshotManifest,
    #[schemars(range(min = 1, max = 65536))]
    pub chunk_bytes: usize,
}

/// A checkout's work, ready to come back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct CodeResult {
    pub checkout_id: String,
    pub kind: CodeResultKind,
    /// The branch the work is on. Git only.
    pub branch: Option<String>,
    /// The tip of that branch. Git only.
    pub commit: Option<String>,
    /// The commit the conversation started from. Git only.
    pub base_commit: Option<String>,
    /// The remote branch that commit was found on. Git only.
    pub base_ref: Option<String>,
    pub remote_url: Option<String>,
    /// Where the conversation's working directory sits inside the checkout.
    pub subdir: String,
    /// Files changed since the base, or entries in the tar.
    pub files: u64,
    /// Why the branch was not pushed, when it comes as a bundle.
    pub push_error: Option<String>,
    /// The bytes to read, for a bundle or a tar.
    pub transfer: Option<CodeResultTransfer>,
}

/// Put a result into a new worktree (or folder) on this device.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ApplyCodeResult {
    /// The folder the conversation worked in on this device before it moved.
    pub root: String,
    pub result: CodeResult,
    /// The received bytes of a bundle or a tar.
    #[serde(default)]
    pub received_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct AppliedCodeResult {
    /// The new worktree, or the new folder for a tar.
    pub path: String,
    /// `path` plus the result's `subdir`.
    pub working_dir: String,
    /// The local branch the worktree is on. Git only.
    pub branch: Option<String>,
    pub commit: Option<String>,
    /// The result was applied before; this is the worktree that apply made.
    pub reused: bool,
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/// The `agent` part of a result branch: lowercase letters, digits and dashes,
/// starting with a letter or digit, at most 32 characters.
pub fn validate_result_agent(agent: &str) -> Result<(), String> {
    let ok = (1..=32).contains(&agent.len())
        && agent
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && agent
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric());
    if ok {
        Ok(())
    } else {
        Err(format!(
            "code_result_invalid_agent: {agent:?} is not lowercase letters, digits and dashes"
        ))
    }
}

/// The branch a checkout's work comes back on.
pub fn result_branch(checkout_id: &str, agent: &str) -> String {
    let compact: String = checkout_id
        .chars()
        .filter(char::is_ascii_hexdigit)
        .collect();
    let tail = &compact[compact.len().saturating_sub(12)..];
    format!("cognia/{agent}-{tail}")
}

fn validate_result_branch(branch: &str) -> Result<(), String> {
    validate_branch_name(branch)
        .map_err(|_| format!("code_result_invalid: {branch:?} is not a branch name"))?;
    if branch.starts_with("cognia/") {
        Ok(())
    } else {
        Err(format!(
            "code_result_invalid: {branch:?} is not a branch a host hands back"
        ))
    }
}

/// Two spellings of one repository URL: case, a trailing slash and `.git`
/// aside.
fn same_repository(a: &str, b: &str) -> bool {
    fn normal(url: &str) -> String {
        let url = url.trim().trim_end_matches('/');
        url.strip_suffix(".git").unwrap_or(url).to_ascii_lowercase()
    }
    normal(a) == normal(b)
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/// The tip of a checkout's work: `HEAD` when nothing is left uncommitted, else
/// a commit on top of it holding the working copy, made from a scratch index
/// so the checkout's branch and index stay as the agent left them. Returns
/// the tip, its tree and how many files differ from `base`.
pub fn result_tip(root: &Path, base: &str) -> Result<(String, String, u64), String> {
    let git = Git::isolated(root);
    let head = git
        .run(&["rev-parse", "--verify", "HEAD^{commit}"])
        .map_err(|error| format!("code_result_unavailable: {error}"))?;
    let scratch = root.parent().unwrap_or(root).join(format!(
        ".{}.result-index",
        root.file_name().unwrap_or_default().to_string_lossy()
    ));
    let tree = working_tree_id(root, GitConfig::Isolated, &scratch)?;
    let head_tree = git.run(&["rev-parse", "HEAD^{tree}"])?;
    let tip = if tree == head_tree {
        head
    } else {
        git.run(&["commit-tree", &tree, "-p", &head, "-m", UNCOMMITTED_MESSAGE])?
    };
    if tip == base {
        return Err(
            "code_result_unchanged: nothing has changed on the host since the conversation moved"
                .into(),
        );
    }
    let files = git
        .run(&["diff", "--no-renames", "--name-only", base, &tip])?
        .lines()
        .filter(|line| !line.is_empty())
        .count() as u64;
    Ok((tip, tree, files))
}

/// Point `branch` at `tip` in the checkout's repository, replacing an earlier
/// export of the same checkout.
fn point_branch(root: &Path, branch: &str, tip: &str) -> Result<(), String> {
    Git::isolated(root)
        .run(&["update-ref", &format!("refs/heads/{branch}"), tip])
        .map(|_| ())
}

/// Push `branch` to `remote_url`, replacing what an earlier export pushed
/// there. The credential is offered to the remote's own host only.
pub fn push_result(
    root: &Path,
    remote_url: &str,
    branch: &str,
    credential: Option<&GitCredential>,
) -> Result<(), String> {
    let refspec = format!("+refs/heads/{branch}:refs/heads/{branch}");
    // Negotiation finds the base as common, so a partial clone sends only the
    // work instead of walking history it holds no blobs for.
    let mut command = Git::isolated(root).command(&[
        "-c",
        "push.negotiate=true",
        "push",
        "--quiet",
        "--no-verify",
        remote_url,
        &refspec,
    ]);
    if let (Some(credential), Some(origin)) = (credential, origin_of(remote_url)) {
        for (key, value) in auth_env(&origin, credential) {
            command.env(key, value);
        }
    }
    let output = command
        .output()
        .map_err(|error| format!("start git push: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(redact(
            String::from_utf8_lossy(&output.stderr).trim(),
            credential,
        ))
    }
}

/// Write the commits between `base` and `branch` as a bundle, refusing past
/// `max_bytes`.
pub fn bundle_result(
    root: &Path,
    branch: &str,
    base: &str,
    out: &Path,
    max_bytes: u64,
) -> Result<(String, u64), String> {
    let out_text = out.to_string_lossy().into_owned();
    Git::isolated(root).run(&[
        "bundle",
        "create",
        "--quiet",
        &out_text,
        &format!("refs/heads/{branch}"),
        &format!("^{base}"),
    ])?;
    let (sha256, size) = hash_file(out)?;
    if size > max_bytes {
        return Err(too_large(max_bytes));
    }
    Ok((sha256, size))
}

/// Export `checkout`'s work: pushed when `remote_url` takes it, else into
/// `outbox` as a bundle (or a tar for a checkout without git).
pub fn export_checkout(
    checkout: &CodeCheckout,
    input: &ExportCodeCheckout,
    outbox: &CodeSnapshotOutbox,
    max_bytes: u64,
) -> Result<CodeResult, String> {
    let root = PathBuf::from(&checkout.root);
    if !root.is_dir() {
        return Err(format!(
            "code_result_unavailable: the checkout {} is gone",
            checkout.checkout_id
        ));
    }
    match checkout.kind {
        CodeSnapshotKind::Tar => {
            let (result_id, manifest) =
                outbox.put_with(|out| produce_tar(&root, max_bytes, out))?;
            Ok(CodeResult {
                checkout_id: checkout.checkout_id.clone(),
                kind: CodeResultKind::Tar,
                branch: None,
                commit: None,
                base_commit: None,
                base_ref: None,
                remote_url: None,
                subdir: String::new(),
                files: manifest.entries,
                push_error: None,
                transfer: Some(CodeResultTransfer {
                    result_id,
                    manifest,
                    chunk_bytes: MAX_TRANSFER_CHUNK_BYTES,
                }),
            })
        }
        CodeSnapshotKind::GitPatch => export_git(checkout, input, &root, outbox, max_bytes),
        CodeSnapshotKind::GitBundle => {
            Err("code_result_unavailable: a checkout is never a bundle".into())
        }
    }
}

fn export_git(
    checkout: &CodeCheckout,
    input: &ExportCodeCheckout,
    root: &Path,
    outbox: &CodeSnapshotOutbox,
    max_bytes: u64,
) -> Result<CodeResult, String> {
    let base = checkout
        .base_commit
        .as_deref()
        .ok_or("code_result_unavailable: the checkout records no base commit")?;
    let agent = input.agent.as_deref().unwrap_or(DEFAULT_RESULT_AGENT);
    validate_result_agent(agent)?;
    let branch = result_branch(&checkout.checkout_id, agent);
    let (tip, tree, files) = result_tip(root, base)?;
    point_branch(root, &branch, &tip)?;

    let credential = input
        .credential
        .as_deref()
        .and_then(GitCredential::from_token);
    let remote_url = checkout
        .remote_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty());
    let push_error = match remote_url {
        Some(url) => push_result(root, url, &branch, credential.as_ref()).err(),
        None => Some("the workspace records no repository to push to".to_string()),
    };
    let mut result = CodeResult {
        checkout_id: checkout.checkout_id.clone(),
        kind: CodeResultKind::Branch,
        branch: Some(branch.clone()),
        commit: Some(tip),
        base_commit: Some(base.to_string()),
        base_ref: checkout.base_ref.clone(),
        remote_url: remote_url.map(str::to_string),
        subdir: checkout.subdir.clone(),
        files,
        push_error: None,
        transfer: None,
    };
    if let Some(error) = push_error {
        let (result_id, (sha256, size_bytes)) =
            outbox.put_with(|out| bundle_result(root, &branch, base, out, max_bytes))?;
        result.kind = CodeResultKind::Bundle;
        result.push_error = Some(error);
        result.transfer = Some(CodeResultTransfer {
            result_id,
            manifest: CodeSnapshotManifest {
                kind: CodeSnapshotKind::GitBundle,
                size_bytes,
                sha256,
                base_commit: Some(base.to_string()),
                base_ref: checkout.base_ref.clone(),
                tree: Some(tree),
                subdir: checkout.subdir.clone(),
                entries: files,
            },
            chunk_bytes: MAX_TRANSFER_CHUNK_BYTES,
        });
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------

fn working_dir_of(path: &Path, subdir: &str) -> String {
    if subdir.is_empty() {
        path.to_string_lossy().into_owned()
    } else {
        path.join(subdir).to_string_lossy().into_owned()
    }
}

/// The worktree holding `branch`, from `git worktree list --porcelain`.
fn worktree_of(git: &Git<'_>, branch: &str) -> Option<String> {
    let listing = git.run(&["worktree", "list", "--porcelain"]).ok()?;
    let wanted = format!("branch refs/heads/{branch}");
    let mut path: Option<&str> = None;
    for line in listing.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            path = Some(rest);
        } else if line == wanted {
            return path.map(str::to_string);
        }
    }
    None
}

/// A local branch for `branch`: the result's own name when free, else the
/// first free `-2`, `-3`… One already at `commit` with a worktree means the
/// result was applied before, and answers with that worktree.
fn local_branch(git: &Git<'_>, branch: &str, commit: &str) -> Result<LocalBranch, String> {
    for n in 1..=MAX_BRANCH_SUFFIX {
        let name = if n == 1 {
            branch.to_string()
        } else {
            format!("{branch}-{n}")
        };
        let existing = git.run(&[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}^{{commit}}"),
        ]);
        match existing {
            Err(_) => return Ok(LocalBranch::Free(name)),
            Ok(at) if at == commit => {
                if let Some(path) = worktree_of(git, &name) {
                    return Ok(LocalBranch::Applied { name, path });
                }
            }
            Ok(_) => {}
        }
    }
    Err(format!(
        "code_result_branch_taken: {branch} and its first {MAX_BRANCH_SUFFIX} variants are all taken"
    ))
}

enum LocalBranch {
    Free(String),
    Applied { name: String, path: String },
}

/// Check a git result out into a new worktree at `dest`. `bundle` is the
/// received bundle for [`CodeResultKind::Bundle`].
pub fn apply_git_result(
    root: &Path,
    result: &CodeResult,
    bundle: Option<&Path>,
    dest: &Path,
) -> Result<AppliedCodeResult, String> {
    let branch = result
        .branch
        .as_deref()
        .ok_or("code_result_invalid: a git result names its branch")?;
    validate_result_branch(branch)?;
    let commit = result
        .commit
        .as_deref()
        .ok_or("code_result_invalid: a git result names its commit")?;
    validate_object_id("commit", commit).map_err(|_| "code_result_invalid: bad commit id")?;
    if !Git::user(root).ok(&["rev-parse", "--is-inside-work-tree"]) {
        return Err(format!(
            "code_result_not_git: {} is no longer a git checkout",
            root.display()
        ));
    }
    let toplevel = PathBuf::from(Git::user(root).run(&["rev-parse", "--show-toplevel"])?);
    let git = Git::user(&toplevel);

    let local = match local_branch(&git, branch, commit)? {
        LocalBranch::Applied { name, path } => {
            return Ok(AppliedCodeResult {
                working_dir: working_dir_of(Path::new(&path), &result.subdir),
                path,
                branch: Some(name),
                commit: Some(commit.to_string()),
                reused: true,
            })
        }
        LocalBranch::Free(name) => name,
    };

    // Where the fetched tip lands: the remote-tracking ref when the result
    // was pushed to a remote this checkout knows by name, else a scratch ref
    // removed once the worktree holds the commit.
    let scratch_ref = format!("refs/cognia/returns/{}", &commit[..12]);
    let (source, target_ref, upstream) = match result.kind {
        CodeResultKind::Branch => {
            let url = result
                .remote_url
                .as_deref()
                .ok_or("code_result_invalid: a pushed result names its remote")?;
            match named_remote(&git, url) {
                Some(name) => (
                    name.clone(),
                    format!("refs/remotes/{name}/{branch}"),
                    Some(format!("{name}/{branch}")),
                ),
                None => (url.to_string(), scratch_ref.clone(), None),
            }
        }
        CodeResultKind::Bundle => {
            let bundle = bundle.ok_or("code_result_invalid: a bundle result needs its bytes")?;
            let bundle_text = bundle.to_string_lossy().into_owned();
            git.run(&["bundle", "verify", "--quiet", &bundle_text])
                .map_err(|error| format!("code_result_base_missing: {error}"))?;
            (bundle_text, scratch_ref.clone(), None)
        }
        CodeResultKind::Tar => {
            return Err("code_result_invalid: a tar result is not a git result".into())
        }
    };
    let fetched = fetch_tip(&git, &source, branch, &target_ref, commit, result);
    let applied = fetched.and_then(|()| {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        let dest_text = dest.to_string_lossy().into_owned();
        git.run(&[
            "worktree", "add", "--quiet", "-b", &local, &dest_text, commit,
        ])?;
        if let Some(upstream) = upstream.as_deref() {
            // A tracking branch is a convenience; its absence is not a failure.
            let _ = git.run(&["branch", &format!("--set-upstream-to={upstream}"), &local]);
        }
        Ok(())
    });
    if target_ref == scratch_ref {
        let _ = git.run(&["update-ref", "-d", &scratch_ref]);
    }
    applied?;
    Ok(AppliedCodeResult {
        path: dest.to_string_lossy().into_owned(),
        working_dir: working_dir_of(dest, &result.subdir),
        branch: Some(local),
        commit: Some(commit.to_string()),
        reused: false,
    })
}

/// The name of the remote of this checkout whose URL is `url`.
fn named_remote(git: &Git<'_>, url: &str) -> Option<String> {
    let remotes = git.run(&["remote"]).ok()?;
    remotes
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .find(|name| {
            git.run(&["remote", "get-url", name])
                .is_ok_and(|found| same_repository(&found, url))
        })
        .map(str::to_string)
}

/// Fetch `branch` from `source` into `target_ref` and prove it is `commit`
/// (and, for a bundle, that its tree is the one the host named).
fn fetch_tip(
    git: &Git<'_>,
    source: &str,
    branch: &str,
    target_ref: &str,
    commit: &str,
    result: &CodeResult,
) -> Result<(), String> {
    let refspec = format!("+refs/heads/{branch}:{target_ref}");
    git.run(&[
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        source,
        &refspec,
    ])
    .map_err(|error| format!("code_result_fetch_failed: {}", redact(&error, None)))?;
    let fetched = git.run(&["rev-parse", "--verify", &format!("{target_ref}^{{commit}}")])?;
    if fetched != commit {
        return Err(format!(
            "code_result_mismatch: {branch} is at {fetched}, the host handed back {commit}"
        ));
    }
    if result.kind == CodeResultKind::Bundle {
        let expected = result
            .transfer
            .as_ref()
            .and_then(|transfer| transfer.manifest.tree.as_deref())
            .ok_or("code_result_invalid: a bundle names its tree")?;
        let tree = git.run(&["rev-parse", &format!("{commit}^{{tree}}")])?;
        if tree != expected {
            return Err(format!(
                "code_result_mismatch: {commit} holds tree {tree}, the host named {expected}"
            ));
        }
    }
    Ok(())
}

/// Unpack a received tar into a new folder at `dest`; a folder already there
/// is the earlier apply of the same result.
pub fn apply_tar_result(
    archive: &Path,
    dest: &Path,
    max_bytes: u64,
) -> Result<AppliedCodeResult, String> {
    let path = dest.to_string_lossy().into_owned();
    if dest.exists() {
        return Ok(AppliedCodeResult {
            working_dir: path.clone(),
            path,
            branch: None,
            commit: None,
            reused: true,
        });
    }
    fs::create_dir_all(dest).map_err(|error| format!("create {}: {error}", dest.display()))?;
    if let Err(error) = extract_tar_snapshot(archive, dest, max_bytes) {
        let _ = fs::remove_dir_all(dest);
        return Err(error);
    }
    Ok(AppliedCodeResult {
        working_dir: path.clone(),
        path,
        branch: None,
        commit: None,
        reused: false,
    })
}

/// Apply a result on this device: the bytes of a bundle or a tar come out of
/// `inbox`, checked against the manifest the host sent, and the new worktree
/// or folder goes under the inbox's checkout directory.
pub fn apply_result(
    input: &ApplyCodeResult,
    inbox: &CodeSnapshotInbox,
) -> Result<AppliedCodeResult, String> {
    let result = &input.result;
    let staged = match (&result.transfer, input.received_id.as_deref()) {
        (Some(transfer), Some(received_id)) => {
            let expected = match result.kind {
                CodeResultKind::Bundle => CodeSnapshotKind::GitBundle,
                CodeResultKind::Tar => CodeSnapshotKind::Tar,
                CodeResultKind::Branch => {
                    return Err("code_result_invalid: a pushed result has no bytes".into())
                }
            };
            if transfer.manifest.kind != expected {
                return Err("code_result_invalid: the bytes are not what the result says".into());
            }
            Some((received_id, inbox.staged(received_id, &transfer.manifest)?))
        }
        (None, None) if result.kind == CodeResultKind::Branch => None,
        _ => return Err("code_result_invalid: the result's bytes were not received".into()),
    };
    let dest_id = staged
        .as_ref()
        .map(|(id, _)| id.to_string())
        .unwrap_or_else(new_id);
    let dest = inbox.checkout_dir(&dest_id)?;
    let applied = match result.kind {
        CodeResultKind::Tar => {
            let (_, archive) = staged.as_ref().ok_or("code_result_invalid: no tar")?;
            apply_tar_result(archive, &dest, inbox.limits().max_bytes)
        }
        _ => apply_git_result(
            Path::new(input.root.trim()),
            result,
            staged.as_ref().map(|(_, path)| path.as_path()),
            &dest,
        ),
    };
    if let Some((id, _)) = staged.as_ref() {
        if applied.is_ok() {
            inbox.discard_staged(id);
        }
    }
    applied
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::code_snapshot::{CodeSnapshotOutbox, DEFAULT_CODE_SNAPSHOT_MAX_BYTES};
    use std::process::Command;
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

    const CHECKOUT_ID: &str = "0192f0c4-7a1e-7b3c-9d2e-4f5a6b7c8d9e";

    struct Fixture {
        _tmp: TempDir,
        root: PathBuf,
        /// A bare repository standing in for the project's remote.
        upstream: PathBuf,
        /// The desktop's checkout, cloned from `upstream`.
        desk: PathBuf,
        /// The host's checkout: a worktree of its own clone, at the base.
        checkout: CodeCheckout,
        base: String,
    }

    fn fixture() -> Fixture {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        let seed = root.join("seed");
        fs::create_dir_all(&seed).unwrap();
        sh(&seed, &["init", "--initial-branch=main", "."]);
        fs::write(seed.join("README.md"), "hello\n").unwrap();
        fs::write(seed.join("gone.txt"), "delete me\n").unwrap();
        fs::create_dir_all(seed.join("app")).unwrap();
        fs::write(seed.join("app/main.rs"), "fn main() {}\n").unwrap();
        sh(&seed, &["add", "."]);
        sh(&seed, &["commit", "-m", "first"]);
        let upstream = root.join("upstream.git");
        sh(
            &root,
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                upstream.to_str().unwrap(),
            ],
        );
        let desk = root.join("desk");
        sh(
            &root,
            &[
                "clone",
                "-q",
                upstream.to_str().unwrap(),
                desk.to_str().unwrap(),
            ],
        );
        let source = root.join("host/source");
        sh(
            &root,
            &[
                "clone",
                "-q",
                upstream.to_str().unwrap(),
                source.to_str().unwrap(),
            ],
        );
        let base = sh(&source, &["rev-parse", "HEAD"]);
        let handoff = root.join("host/handoffs").join(CHECKOUT_ID);
        sh(
            &source,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "cognia/handoff-test",
                handoff.to_str().unwrap(),
                &base,
            ],
        );
        let checkout = CodeCheckout {
            checkout_id: CHECKOUT_ID.into(),
            root: handoff.to_string_lossy().into_owned(),
            working_dir: handoff.join("app").to_string_lossy().into_owned(),
            kind: CodeSnapshotKind::GitPatch,
            branch: Some("cognia/handoff-test".into()),
            base_commit: Some(base.clone()),
            base_ref: Some("main".into()),
            subdir: "app".into(),
            project_id: None,
            remote_url: Some(upstream.to_string_lossy().into_owned()),
            created_at: 0,
        };
        Fixture {
            _tmp: tmp,
            root,
            upstream,
            desk,
            checkout,
            base,
        }
    }

    /// What an agent leaves behind: one commit, then edits it never committed.
    fn agent_works(checkout: &Path) {
        fs::write(checkout.join("app/lib.rs"), "pub fn lib() {}\n").unwrap();
        sh(checkout, &["add", "app/lib.rs"]);
        sh(checkout, &["commit", "-q", "-m", "agent: add lib"]);
        fs::write(checkout.join("README.md"), "hello, from the host\n").unwrap();
        fs::remove_file(checkout.join("gone.txt")).unwrap();
        fs::write(checkout.join("logo.bin"), [0_u8, 255, 7, 0, 128]).unwrap();
    }

    fn outbox(fx: &Fixture) -> CodeSnapshotOutbox {
        CodeSnapshotOutbox::new(fx.root.join("host/results"))
    }

    fn inbox(fx: &Fixture) -> CodeSnapshotInbox {
        CodeSnapshotInbox::new(
            &fx.root.join("desk-state"),
            fx.root.join("desk-returns"),
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES,
        )
    }

    fn export(fx: &Fixture) -> Result<CodeResult, String> {
        export_checkout(
            &fx.checkout,
            &ExportCodeCheckout {
                checkout_id: CHECKOUT_ID.into(),
                agent: Some("claude-code".into()),
                credential: None,
            },
            &outbox(fx),
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES,
        )
    }

    /// Stage a host's result bytes in `inbox` the way the desktop receives
    /// them, returning the received id.
    fn receive(fx: &Fixture, inbox: &CodeSnapshotInbox, transfer: &CodeResultTransfer) -> String {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use sha2::{Digest, Sha256};
        let outbox = outbox(fx);
        let upload = inbox
            .open_upload(transfer.manifest.size_bytes, &transfer.manifest.sha256)
            .unwrap();
        let mut offset = 0;
        loop {
            let chunk = outbox.read_chunk(&transfer.result_id, offset).unwrap();
            let bytes = STANDARD.decode(&chunk.data_base64).unwrap();
            assert_eq!(hex::encode(Sha256::digest(&bytes)), chunk.chunk_hash);
            offset = inbox
                .write_chunk(
                    &upload.upload_id,
                    chunk.offset,
                    &chunk.data_base64,
                    &chunk.chunk_hash,
                )
                .unwrap();
            if chunk.eof {
                break;
            }
        }
        inbox.commit_upload(&upload.upload_id).unwrap().snapshot_id
    }

    #[test]
    fn agent_names_are_checked_and_shape_the_branch() {
        assert!(validate_result_agent("claude-code").is_ok());
        assert!(validate_result_agent("codex2").is_ok());
        for bad in ["", "-x", "Claude", "a/b", "a b", &"x".repeat(33)] {
            assert!(validate_result_agent(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            result_branch(CHECKOUT_ID, "codex"),
            "cognia/codex-4f5a6b7c8d9e"
        );
        assert!(validate_result_branch("cognia/codex-4f5a6b7c8d9e").is_ok());
        assert!(validate_result_branch("main").is_err());
        assert!(validate_result_branch("cognia/../x").is_err());
    }

    #[test]
    fn repository_urls_match_across_spellings() {
        assert!(same_repository(
            "https://github.com/Acme/App.git",
            "https://github.com/acme/app/"
        ));
        assert!(!same_repository(
            "https://github.com/acme/app",
            "https://github.com/acme/other"
        ));
    }

    #[test]
    fn the_tip_carries_uncommitted_work_without_moving_the_agents_branch() {
        let fx = fixture();
        let checkout = PathBuf::from(&fx.checkout.root);
        agent_works(&checkout);
        let head_before = sh(&checkout, &["rev-parse", "HEAD"]);
        let (tip, tree, files) = result_tip(&checkout, &fx.base).unwrap();
        assert_ne!(tip, head_before);
        assert_eq!(
            sh(&checkout, &["rev-parse", &format!("{tip}^")]),
            head_before
        );
        assert_eq!(
            sh(&checkout, &["rev-parse", &format!("{tip}^{{tree}}")]),
            tree
        );
        // lib.rs, README.md, gone.txt, logo.bin.
        assert_eq!(files, 4);
        assert_eq!(sh(&checkout, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            sh(&checkout, &["status", "--porcelain"]).lines().count(),
            3,
            "the agent's uncommitted edits stay uncommitted"
        );
        assert_eq!(
            sh(&checkout, &["log", "-1", "--format=%an", &tip]),
            "Cognia"
        );
    }

    #[test]
    fn a_clean_checkout_is_its_head_and_an_untouched_one_has_nothing_to_return() {
        let fx = fixture();
        let checkout = PathBuf::from(&fx.checkout.root);
        let error = result_tip(&checkout, &fx.base).unwrap_err();
        assert!(error.starts_with("code_result_unchanged"), "{error}");
        fs::write(checkout.join("new.txt"), "x\n").unwrap();
        sh(&checkout, &["add", "new.txt"]);
        sh(&checkout, &["commit", "-q", "-m", "only a commit"]);
        let (tip, _, files) = result_tip(&checkout, &fx.base).unwrap();
        assert_eq!(tip, sh(&checkout, &["rev-parse", "HEAD"]));
        assert_eq!(files, 1);
    }

    #[test]
    fn a_pushed_result_comes_back_into_a_new_tracking_worktree() {
        let fx = fixture();
        agent_works(Path::new(&fx.checkout.root));
        let result = export(&fx).unwrap();
        assert_eq!(
            result.kind,
            CodeResultKind::Branch,
            "{:?}",
            result.push_error
        );
        assert!(result.transfer.is_none());
        let branch = result.branch.clone().unwrap();
        assert_eq!(branch, "cognia/claude-code-4f5a6b7c8d9e");
        let commit = result.commit.clone().unwrap();
        assert_eq!(
            sh(
                &fx.upstream,
                &["rev-parse", &format!("refs/heads/{branch}")]
            ),
            commit
        );
        assert_eq!(result.subdir, "app");
        assert_eq!(result.base_ref.as_deref(), Some("main"));

        let inbox = inbox(&fx);
        let applied = apply_result(
            &ApplyCodeResult {
                root: fx.desk.join("app").to_string_lossy().into_owned(),
                result: result.clone(),
                received_id: None,
            },
            &inbox,
        )
        .unwrap();
        assert!(!applied.reused);
        let path = PathBuf::from(&applied.path);
        assert!(path.starts_with(fx.root.join("desk-returns")));
        assert_eq!(applied.working_dir, path.join("app").to_string_lossy());
        assert_eq!(applied.branch.as_deref(), Some(branch.as_str()));
        assert_eq!(sh(&path, &["rev-parse", "HEAD"]), commit);
        assert_eq!(
            fs::read_to_string(path.join("README.md")).unwrap(),
            "hello, from the host\n"
        );
        assert!(!path.join("gone.txt").exists());
        assert_eq!(
            fs::read(path.join("logo.bin")).unwrap(),
            [0_u8, 255, 7, 0, 128]
        );
        assert!(path.join("app/lib.rs").exists());
        assert_eq!(
            sh(&path, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            format!("origin/{branch}")
        );
        // The folder the conversation started from is untouched.
        assert_eq!(sh(&fx.desk, &["rev-parse", "HEAD"]), fx.base);
        assert_eq!(
            fs::read_to_string(fx.desk.join("README.md")).unwrap(),
            "hello\n"
        );

        // Asking again answers with the same worktree.
        let again = apply_result(
            &ApplyCodeResult {
                root: fx.desk.to_string_lossy().into_owned(),
                result,
                received_id: None,
            },
            &inbox,
        )
        .unwrap();
        assert!(again.reused);
        assert_eq!(
            Path::new(&again.path).canonicalize().unwrap(),
            path.canonicalize().unwrap()
        );
    }

    #[test]
    fn a_later_export_replaces_the_branch_and_applies_beside_the_first() {
        let fx = fixture();
        let checkout = PathBuf::from(&fx.checkout.root);
        agent_works(&checkout);
        let first = export(&fx).unwrap();
        let inbox = inbox(&fx);
        let root = fx.desk.to_string_lossy().into_owned();
        let one = apply_result(
            &ApplyCodeResult {
                root: root.clone(),
                result: first.clone(),
                received_id: None,
            },
            &inbox,
        )
        .unwrap();
        fs::write(checkout.join("more.txt"), "later\n").unwrap();
        let second = export(&fx).unwrap();
        assert_eq!(
            second.kind,
            CodeResultKind::Branch,
            "{:?}",
            second.push_error
        );
        assert_eq!(second.branch, first.branch);
        assert_ne!(second.commit, first.commit);
        let two = apply_result(
            &ApplyCodeResult {
                root,
                result: second.clone(),
                received_id: None,
            },
            &inbox,
        )
        .unwrap();
        assert!(!two.reused);
        assert_ne!(one.path, two.path);
        assert_eq!(
            two.branch.as_deref(),
            Some(format!("{}-2", first.branch.as_deref().unwrap()).as_str())
        );
        assert!(Path::new(&two.path).join("more.txt").exists());
    }

    #[test]
    fn a_refused_push_comes_back_as_a_bundle_with_the_same_commits() {
        let mut fx = fixture();
        agent_works(Path::new(&fx.checkout.root));
        fx.checkout.remote_url = Some(
            fx.root
                .join("no-such-remote")
                .to_string_lossy()
                .into_owned(),
        );
        let result = export(&fx).unwrap();
        assert_eq!(result.kind, CodeResultKind::Bundle);
        assert!(result.push_error.is_some());
        let transfer = result.transfer.clone().unwrap();
        assert_eq!(transfer.manifest.kind, CodeSnapshotKind::GitBundle);
        crate::code_snapshot::validate_manifest(&transfer.manifest).unwrap();

        let inbox = inbox(&fx);
        let received = receive(&fx, &inbox, &transfer);
        let applied = apply_result(
            &ApplyCodeResult {
                root: fx.desk.to_string_lossy().into_owned(),
                result: result.clone(),
                received_id: Some(received.clone()),
            },
            &inbox,
        )
        .unwrap();
        let path = PathBuf::from(&applied.path);
        assert_eq!(
            sh(&path, &["rev-parse", "HEAD"]),
            result.commit.clone().unwrap()
        );
        assert_eq!(
            sh(
                &path,
                &["log", "--format=%s", &format!("{}..HEAD", fx.base)]
            ),
            format!("{UNCOMMITTED_MESSAGE}\nagent: add lib")
        );
        // No scratch ref is left behind.
        assert!(sh(&fx.desk, &["for-each-ref", "refs/cognia"]).is_empty());
        // The staged bytes are gone once applied.
        assert!(inbox.staged(&received, &transfer.manifest).is_err());
    }

    #[test]
    fn a_bundle_whose_tree_is_not_the_named_one_is_refused_and_leaves_nothing() {
        let mut fx = fixture();
        agent_works(Path::new(&fx.checkout.root));
        fx.checkout.remote_url = None;
        let mut result = export(&fx).unwrap();
        assert_eq!(result.kind, CodeResultKind::Bundle);
        let transfer = result.transfer.as_mut().unwrap();
        let inbox = inbox(&fx);
        let received = receive(&fx, &inbox, transfer);
        transfer.manifest.tree = Some(sh(&fx.desk, &["rev-parse", "HEAD^{tree}"]));
        let error = apply_result(
            &ApplyCodeResult {
                root: fx.desk.to_string_lossy().into_owned(),
                result: result.clone(),
                received_id: Some(received),
            },
            &inbox,
        )
        .unwrap_err();
        assert!(error.starts_with("code_result_mismatch"), "{error}");
        assert!(sh(&fx.desk, &["branch", "--list", "cognia/*"]).is_empty());
        assert!(sh(&fx.desk, &["for-each-ref", "refs/cognia"]).is_empty());
        assert_eq!(sh(&fx.desk, &["worktree", "list"]).lines().count(), 1);
    }

    #[test]
    fn a_result_whose_named_commit_differs_from_the_fetched_one_is_refused() {
        let fx = fixture();
        agent_works(Path::new(&fx.checkout.root));
        let mut result = export(&fx).unwrap();
        assert_eq!(result.kind, CodeResultKind::Branch);
        result.commit = Some(fx.base.clone());
        let error = apply_result(
            &ApplyCodeResult {
                root: fx.desk.to_string_lossy().into_owned(),
                result,
                received_id: None,
            },
            &inbox(&fx),
        )
        .unwrap_err();
        assert!(error.starts_with("code_result_mismatch"), "{error}");
        assert_eq!(sh(&fx.desk, &["worktree", "list"]).lines().count(), 1);
    }

    #[test]
    fn a_result_needs_its_bytes_and_a_git_checkout_to_land_in() {
        let mut fx = fixture();
        agent_works(Path::new(&fx.checkout.root));
        fx.checkout.remote_url = None;
        let result = export(&fx).unwrap();
        let inbox = inbox(&fx);
        let error = apply_result(
            &ApplyCodeResult {
                root: fx.desk.to_string_lossy().into_owned(),
                result: result.clone(),
                received_id: None,
            },
            &inbox,
        )
        .unwrap_err();
        assert!(error.starts_with("code_result_invalid"), "{error}");
        let plain = fx.root.join("plain");
        fs::create_dir_all(&plain).unwrap();
        let received = receive(&fx, &inbox, result.transfer.as_ref().unwrap());
        let error = apply_result(
            &ApplyCodeResult {
                root: plain.to_string_lossy().into_owned(),
                result,
                received_id: Some(received),
            },
            &inbox,
        )
        .unwrap_err();
        assert!(error.starts_with("code_result_not_git"), "{error}");
    }

    #[test]
    fn a_folder_without_git_comes_back_as_a_new_folder() {
        let fx = fixture();
        let unpacked = fx.root.join("host/handoffs/tar-one");
        fs::create_dir_all(unpacked.join("notes")).unwrap();
        fs::write(unpacked.join("notes/todo.md"), "- done\n").unwrap();
        let checkout = CodeCheckout {
            checkout_id: CHECKOUT_ID.into(),
            root: unpacked.to_string_lossy().into_owned(),
            working_dir: unpacked.to_string_lossy().into_owned(),
            kind: CodeSnapshotKind::Tar,
            branch: None,
            base_commit: None,
            base_ref: None,
            subdir: String::new(),
            project_id: None,
            remote_url: None,
            created_at: 0,
        };
        let result = export_checkout(
            &checkout,
            &ExportCodeCheckout {
                checkout_id: CHECKOUT_ID.into(),
                agent: None,
                credential: None,
            },
            &outbox(&fx),
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES,
        )
        .unwrap();
        assert_eq!(result.kind, CodeResultKind::Tar);
        let inbox = inbox(&fx);
        let transfer = result.transfer.clone().unwrap();
        let received = receive(&fx, &inbox, &transfer);
        let input = ApplyCodeResult {
            root: fx.root.join("anywhere").to_string_lossy().into_owned(),
            result,
            received_id: Some(received.clone()),
        };
        let applied = apply_result(&input, &inbox).unwrap();
        assert!(!applied.reused);
        assert_eq!(
            fs::read_to_string(Path::new(&applied.path).join("notes/todo.md")).unwrap(),
            "- done\n"
        );
        assert!(applied.branch.is_none());
        // Its folder is named for the received bytes, so the same bytes
        // land in the same folder.
        assert_eq!(
            apply_tar_result(Path::new("/nonexistent"), Path::new(&applied.path), 1)
                .unwrap()
                .reused,
            true
        );
    }

    #[test]
    fn an_export_over_the_cap_leaves_nothing_in_the_outbox() {
        let mut fx = fixture();
        agent_works(Path::new(&fx.checkout.root));
        fx.checkout.remote_url = None;
        let error = export_checkout(
            &fx.checkout,
            &ExportCodeCheckout {
                checkout_id: CHECKOUT_ID.into(),
                agent: None,
                credential: None,
            },
            &outbox(&fx),
            16,
        )
        .unwrap_err();
        assert!(error.starts_with("code_snapshot_too_large"), "{error}");
        let left = fs::read_dir(fx.root.join("host/results"))
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(left, 0);
    }

    #[test]
    fn a_bad_agent_name_is_refused_before_anything_moves() {
        let fx = fixture();
        agent_works(Path::new(&fx.checkout.root));
        let error = export_checkout(
            &fx.checkout,
            &ExportCodeCheckout {
                checkout_id: CHECKOUT_ID.into(),
                agent: Some("Bad Name".into()),
                credential: None,
            },
            &outbox(&fx),
            DEFAULT_CODE_SNAPSHOT_MAX_BYTES,
        )
        .unwrap_err();
        assert!(error.starts_with("code_result_invalid_agent"), "{error}");
        assert!(sh(
            Path::new(&fx.checkout.root),
            &["branch", "--list", "cognia/B*"]
        )
        .is_empty());
    }

    #[test]
    fn the_export_debug_form_hides_the_credential() {
        let input = ExportCodeCheckout {
            checkout_id: CHECKOUT_ID.into(),
            agent: None,
            credential: Some("ghp_secret".into()),
        };
        let text = format!("{input:?}");
        assert!(!text.contains("ghp_secret"), "{text}");
        assert!(!serde_json::to_string(&input)
            .unwrap()
            .contains("ghp_secret"));
    }
}
