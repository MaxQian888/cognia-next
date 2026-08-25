//! Stacked branches — the git half.
//!
//! # What a stack is here
//!
//! A chain of branches where each one is based on the one below it:
//! `main <- feature/a <- feature/b <- feature/c`. Every layer is a normal
//! branch and a normal pull request; what makes it a stack is that layer *n*'s
//! base is layer *n-1* rather than the trunk.
//!
//! # Git is the source of truth
//!
//! The parent pointer lives in the repository's own config, as
//! `branch.<name>.cognia-parent`. Not in a database beside it: the branches are
//! git's, a clone on another machine can read the same config, and a database
//! that disagrees with `git log` is worse than no database. Everything above
//! this module treats its own tables as a rebuildable projection of what these
//! functions report.
//!
//! # Ancestry is checked, never assumed
//!
//! A parent pointer is a *claim*. [`validate`] asks git whether the claim holds
//! (`merge-base --is-ancestor`), because the branch may have been rebased,
//! reset, or force-pushed since the pointer was written — and publishing a
//! stack whose layers do not actually contain each other produces pull requests
//! whose diffs silently include their parents' work.
//!
//! # Why `git replay` and not `rebase --update-refs`
//!
//! Restacking has to move every layer above the one that changed.
//! `rebase --update-refs` does that, but it explicitly refuses to update a
//! branch that is checked out in another worktree — and this application cuts a
//! worktree per task, so in the case that matters most it silently skips the
//! branches it was asked to move.
//!
//! `git replay` computes new commits and prints ref updates without touching
//! any working tree, which is the right primitive. It is also EXPERIMENTAL and
//! absent before git 2.44, so [`capabilities`] probes for it and [`restack`]
//! falls back to a sequence of `rebase --onto` runs in a scratch worktree.
//!
//! The flip side of "touches no working tree" is that `git replay` will happily
//! move a branch that IS checked out somewhere, leaving that worktree's files
//! silently disagreeing with its own HEAD. So [`restack`] refuses those by
//! name rather than producing a worktree full of phantom changes.
//!
//! # Nothing is lost
//!
//! Every branch this module moves has its previous tip written to
//! `refs/cognia/stack-history/<branch>/<unix-millis>` first. A restack that
//! rewrites the wrong thing is then a `git update-ref` away from being undone,
//! and the old commits are reachable so `gc` will not collect them.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::error::{GitError, Result};
use super::exec;
use super::read::open_repo;

/// Config key holding a branch's parent in the stack.
const PARENT_KEY_PREFIX: &str = "branch.";
const PARENT_KEY_SUFFIX: &str = ".cognia-parent";

/// Namespace for pre-restack tips. Under `refs/cognia/` so it is invisible to
/// `git branch` and to every remote, and never fetched or pushed by default.
const HISTORY_NAMESPACE: &str = "refs/cognia/stack-history";

fn cwd(repo_path: &str) -> PathBuf {
    Path::new(repo_path).to_path_buf()
}

fn parent_key(branch: &str) -> String {
    format!("{PARENT_KEY_PREFIX}{branch}{PARENT_KEY_SUFFIX}")
}

/// A branch name git will accept as a ref component.
///
/// Checked here rather than trusted because every value below is interpolated
/// into an argument list, and a name beginning with `-` would be read as a
/// flag by whichever git command received it.
fn validate_branch_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(GitError::InvalidArgument("empty branch name".into()));
    }
    if name.starts_with('-') {
        return Err(GitError::InvalidArgument(
            format!("branch name may not start with '-': {name}").into(),
        ));
    }
    if name.contains("..")
        || name.contains(' ')
        || name.contains('~')
        || name.contains('^')
        || name.contains(':')
        || name.contains('?')
        || name.contains('*')
        || name.contains('[')
        || name.contains('\\')
        || name.ends_with('/')
        || name.ends_with(".lock")
    {
        return Err(GitError::InvalidArgument(
            format!("not a valid branch name: {name}").into(),
        ));
    }
    Ok(())
}

// ── Parent pointers ────────────────────────────────────────────────────────

/// The branch `branch` is stacked on, or `None` when it sits on the trunk.
pub fn parent_of(repo_path: &str, branch: &str) -> Result<Option<String>> {
    validate_branch_name(branch)?;
    let repo = open_repo(repo_path)?;
    let config = repo.config()?;
    match config.get_string(&parent_key(branch)) {
        Ok(value) => {
            let trimmed = value.trim().to_string();
            Ok(if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            })
        }
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Every parent pointer in the repository, as `child -> parent`.
///
/// One config read rather than one per branch: a stack is walked whole on every
/// validation, and `git config --get-regexp` over a hundred branches is a
/// single process where the naive loop is a hundred.
pub fn parent_map(repo_path: &str) -> Result<BTreeMap<String, String>> {
    let repo = open_repo(repo_path)?;
    let config = repo.config()?;
    let mut out = BTreeMap::new();
    let mut entries = config.entries(Some("branch.*.cognia-parent"))?;
    while let Some(entry) = entries.next() {
        let entry = entry?;
        let (Ok(name), Ok(value)) = (entry.name(), entry.value()) else {
            continue;
        };
        let child = name
            .strip_prefix(PARENT_KEY_PREFIX)
            .and_then(|rest| rest.strip_suffix(PARENT_KEY_SUFFIX));
        let (Some(child), false) = (child, value.trim().is_empty()) else {
            continue;
        };
        out.insert(child.to_string(), value.trim().to_string());
    }
    Ok(out)
}

/// Record (or, with `None`, clear) a branch's parent.
///
/// Shelled out rather than written through git2 so it lands in the same config
/// file `git config` would write, honouring `includeIf` and a worktree-local
/// config the same way the user's own terminal does.
pub async fn set_parent(repo_path: &str, branch: &str, parent: Option<&str>) -> Result<()> {
    validate_branch_name(branch)?;
    if let Some(parent) = parent {
        validate_branch_name(parent)?;
        if parent == branch {
            return Err(GitError::InvalidArgument(
                format!("a branch cannot be its own parent: {branch}").into(),
            ));
        }
        exec::run(
            &cwd(repo_path),
            ["config", "--local", &parent_key(branch), parent],
        )
        .await
    } else {
        // `--unset` exits 5 when the key was never there, which is not a
        // failure for "make sure this branch has no parent".
        exec::succeeds(
            &cwd(repo_path),
            ["config", "--local", "--unset", &parent_key(branch)],
        )
        .await
        .map(|_| ())
    }
}

// ── Capabilities ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackCapabilities {
    /// `git --version`, verbatim.
    pub version: String,
    /// `git replay` exists — restacking can leave every working tree alone.
    pub replay: bool,
    /// `git replay` takes `--ref-action`, which means its DEFAULT is to write
    /// the refs itself.
    ///
    /// This flipped: git through 2.5x printed `update-ref` lines and changed
    /// nothing, and git 2.54 made `update` the default with `print` opt-in.
    /// The difference is not cosmetic — under the new default `--contained`
    /// silently moves every branch inside the replayed range, including
    /// branches the caller never named. [`restack`] therefore asks for `print`
    /// wherever the flag exists, and verifies afterwards that nothing moved
    /// regardless of the answer.
    pub replay_ref_action: bool,
    /// `push --force-if-includes` exists — a lease that a background fetch
    /// cannot silently satisfy.
    pub force_if_includes: bool,
}

/// Probe what this machine's git can do, rather than demanding a version.
///
/// A minimum version would be a lie in both directions: distributions backport,
/// and `git replay` is experimental enough that its presence is the only honest
/// test. Probing costs two processes and is done once per stack operation.
pub async fn capabilities(repo_path: &str) -> Result<StackCapabilities> {
    let root = cwd(repo_path);
    let version = exec::capture(&root, ["--version"]).await?.trim().to_string();
    // `git <cmd> -h` prints its usage and exits 129 — a non-zero exit that
    // means "yes, and here is how to use me". A command git does not have says
    // so on stderr instead. So the probe reads BOTH streams and looks for the
    // flag it needs, rather than trusting the exit code either way.
    let replay = probe_mentions(&root, &["replay", "-h"], "--onto").await;
    let replay_ref_action = probe_mentions(&root, &["replay", "-h"], "--ref-action").await;
    let force_if_includes = probe_mentions(&root, &["push", "-h"], "force-if-includes").await;
    Ok(StackCapabilities {
        version,
        replay,
        replay_ref_action,
        force_if_includes,
    })
}

/// Whether `git <args>` mentions `needle` on either stream.
///
/// A spawn failure answers "no": a git that cannot be run has no capabilities,
/// and every caller of [`capabilities`] already has a path for the fallback.
async fn probe_mentions(root: &Path, args: &[&str], needle: &str) -> bool {
    match exec::capture_output(root, args).await {
        Ok((_, stdout, stderr)) => stdout.contains(needle) || stderr.contains(needle),
        Err(_) => false,
    }
}

// ── Validation ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackLayerState {
    pub branch: String,
    /// The recorded parent, or `None` for the bottom layer.
    pub parent: Option<String>,
    /// Resolved tip, or `None` when the branch does not exist.
    pub head: Option<String>,
    /// Whether the parent is actually an ancestor of this branch.
    ///
    /// `true` for the bottom layer, which has nothing to be behind.
    pub contains_parent: bool,
    /// Path of the worktree this branch is checked out in, when it is one.
    ///
    /// Restacking moves the branch ref without touching files, so a checked-out
    /// layer would end up with a working tree that silently disagrees with its
    /// own HEAD. Reported so the caller can say which worktree to close.
    pub checked_out_in: Option<String>,
}

/// Where each branch is checked out, as `branch -> worktree path`.
async fn checked_out_branches(repo_path: &str) -> Result<BTreeMap<String, String>> {
    let listing = exec::capture(&cwd(repo_path), ["worktree", "list", "--porcelain"]).await?;
    let mut out = BTreeMap::new();
    let mut path: Option<String> = None;
    for line in listing.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            path = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            let branch = rest.trim().trim_start_matches("refs/heads/").to_string();
            if let Some(path) = path.clone() {
                out.insert(branch, path);
            }
        }
    }
    Ok(out)
}

/// Resolve a branch tip, or `None` when the branch does not exist.
async fn resolve(repo_path: &str, branch: &str) -> Result<Option<String>> {
    let root = cwd(repo_path);
    let refname = format!("refs/heads/{branch}");
    if !exec::succeeds(&root, ["rev-parse", "--verify", "--quiet", &refname]).await? {
        return Ok(None);
    }
    Ok(Some(
        exec::capture(&root, ["rev-parse", &refname])
            .await?
            .trim()
            .to_string(),
    ))
}

/// Whether `ancestor` is reachable from `descendant`.
pub async fn is_ancestor(repo_path: &str, ancestor: &str, descendant: &str) -> Result<bool> {
    validate_branch_name(ancestor)?;
    validate_branch_name(descendant)?;
    exec::succeeds(
        &cwd(repo_path),
        ["merge-base", "--is-ancestor", ancestor, descendant],
    )
    .await
}

/// Report the true state of a chain of branches, bottom layer first.
///
/// Returns facts, not a verdict. The caller decides what an out-of-date layer
/// means — a stack being published must refuse, a stack being displayed should
/// show a "restack needed" badge — and both need to know *which* layer.
pub async fn validate(repo_path: &str, branches: &[String]) -> Result<Vec<StackLayerState>> {
    for branch in branches {
        validate_branch_name(branch)?;
    }
    let parents = parent_map(repo_path)?;
    let worktrees = checked_out_branches(repo_path).await?;
    let mut out = Vec::with_capacity(branches.len());
    for branch in branches {
        let parent = parents.get(branch).cloned();
        let head = resolve(repo_path, branch).await?;
        let contains_parent = match (&parent, &head) {
            // A missing branch contains nothing; a missing parent is the
            // bottom of the stack and has nothing to contain.
            (Some(parent), Some(_)) => is_ancestor(repo_path, parent, branch).await.unwrap_or(false),
            (None, _) => true,
            (Some(_), None) => false,
        };
        out.push(StackLayerState {
            branch: branch.clone(),
            parent,
            head,
            contains_parent,
            checked_out_in: worktrees.get(branch).cloned(),
        });
    }
    Ok(out)
}

// ── History ────────────────────────────────────────────────────────────────

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

/// Pin a branch's current tip under `refs/cognia/stack-history/` before it
/// moves, so the restack is reversible and the old commits survive `gc`.
pub async fn record_history(repo_path: &str, branch: &str, oid: &str) -> Result<String> {
    validate_branch_name(branch)?;
    let refname = format!("{HISTORY_NAMESPACE}/{branch}/{}", now_millis());
    exec::run(&cwd(repo_path), ["update-ref", &refname, oid]).await?;
    Ok(refname)
}

/// Previously recorded tips for a branch, newest first.
pub async fn history(repo_path: &str, branch: &str) -> Result<Vec<(String, String)>> {
    validate_branch_name(branch)?;
    let listing = exec::capture(
        &cwd(repo_path),
        [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            &format!("{HISTORY_NAMESPACE}/{branch}/*"),
        ],
    )
    .await?;
    let mut rows: Vec<(String, String)> = listing
        .lines()
        .filter_map(|line| line.split_once(' '))
        .map(|(refname, oid)| (refname.to_string(), oid.to_string()))
        .collect();
    // Ref names sort lexically; the millisecond suffix is fixed-width enough in
    // practice that reversing gives newest-first for any ref written this
    // millennium, and an explicit numeric sort keeps it true past that.
    rows.sort_by_key(|(refname, _)| {
        refname
            .rsplit('/')
            .next()
            .and_then(|stamp| stamp.parse::<u128>().ok())
            .unwrap_or(0)
    });
    rows.reverse();
    Ok(rows)
}

// ── Restack ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestackMethod {
    /// `git replay` — no working tree was touched.
    Replay,
    /// `rebase --onto` in a scratch worktree, one layer at a time.
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackRefUpdate {
    pub branch: String,
    pub from: String,
    pub to: String,
    /// Where the previous tip was pinned, so a caller can offer an undo.
    pub history_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackConflict {
    /// The layer whose replay stopped.
    pub branch: String,
    /// Scratch worktree the rebase was left in, for `git_sequencer_continue`.
    ///
    /// Deliberately not cleaned up: the half-finished rebase is the only place
    /// the conflict can be resolved, and deleting it would turn "two files
    /// disagree" into "start the whole restack again".
    pub worktree: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestackOutcome {
    pub method: RestackMethod,
    pub updates: Vec<StackRefUpdate>,
    pub conflict: Option<StackConflict>,
}

/// Move `branches` (bottom layer first) so that the chain sits on `onto`.
///
/// Refuses rather than half-works in three cases, each of which produces a
/// repository that looks fine and is not:
///
///  * a layer checked out in a worktree — the ref would move under files that
///    do not change with it;
///  * a layer that does not exist;
///  * a layer whose recorded parent is not the layer below it in `branches`,
///    which means the caller and the repository disagree about the shape.
pub async fn restack(repo_path: &str, onto: &str, branches: &[String]) -> Result<RestackOutcome> {
    let capabilities = capabilities(repo_path).await?;
    restack_with(repo_path, onto, branches, &capabilities).await
}

/// [`restack`] against an already-probed git.
///
/// Separate so a caller restacking several stacks pays for one probe, and so
/// the fallback path is reachable from a test on a machine whose git has
/// `replay` — otherwise the branch that runs on every older git would only ever
/// execute in production.
pub async fn restack_with(
    repo_path: &str,
    onto: &str,
    branches: &[String],
    capabilities: &StackCapabilities,
) -> Result<RestackOutcome> {
    validate_branch_name(onto)?;
    if branches.is_empty() {
        return Err(GitError::InvalidArgument("restack needs a branch".into()));
    }
    let states = validate(repo_path, branches).await?;
    let blocked: Vec<&str> = states
        .iter()
        .filter_map(|state| state.checked_out_in.as_deref().map(|_| state.branch.as_str()))
        .collect();
    if !blocked.is_empty() {
        return Err(GitError::DirtyWorkingTree(
            format!(
                "these layers are checked out in a worktree and would be moved out from under it: {}",
                blocked.join(", ")
            )
            .into(),
        ));
    }
    let missing: Vec<&str> = states
        .iter()
        .filter(|state| state.head.is_none())
        .map(|state| state.branch.as_str())
        .collect();
    if !missing.is_empty() {
        return Err(GitError::NotFound(
            format!("stack layers do not exist: {}", missing.join(", ")).into(),
        ));
    }

    // The caller's order and the repository's pointers must agree. A layer
    // whose recorded parent is a different branch means one of the two is stale,
    // and restacking on either reading silently rewrites the wrong history. An
    // unrecorded pointer is allowed — the chain may be being built right now —
    // but a contradicting one is not.
    for (index, state) in states.iter().enumerate().skip(1) {
        let expected = &branches[index - 1];
        if let Some(parent) = &state.parent {
            if parent != expected {
                return Err(GitError::InvalidArgument(
                    format!(
                        "{} is recorded as stacked on {parent}, not on {expected}",
                        state.branch
                    )
                    .into(),
                ));
            }
        }
    }

    // Already current? Then do nothing at all.
    //
    // `git replay` and `git rebase` both re-create commits, stamping a fresh
    // committer date, so "restack a stack that is already on its base" would
    // rewrite every layer to a new SHA for no change in content — invalidating
    // reviews and forcing a push that says nothing. Asking git whether each
    // layer already contains the one below it costs one process per layer and
    // makes the no-op actually be one.
    if stack_is_current(repo_path, onto, branches).await? {
        return Ok(RestackOutcome {
            method: if capabilities.replay {
                RestackMethod::Replay
            } else {
                RestackMethod::Rebase
            },
            updates: Vec::new(),
            conflict: None,
        });
    }

    let old_heads: BTreeMap<String, String> = states
        .iter()
        .filter_map(|state| state.head.clone().map(|head| (state.branch.clone(), head)))
        .collect();
    // The range's exclusion point: everything the bottom layer already shares
    // with its old base stays, everything after it is replayed.
    let old_base = states[0]
        .parent
        .clone()
        .unwrap_or_else(|| onto.to_string());

    let tip = branches.last().expect("checked non-empty above");
    if capabilities.replay {
        if let Some(outcome) = replay_stack(
            repo_path,
            onto,
            &old_base,
            tip,
            branches,
            &old_heads,
            capabilities,
        )
        .await?
        {
            return Ok(outcome);
        }
    }
    rebase_stack(repo_path, onto, &old_base, branches, &old_heads).await
}

/// Whether every layer already contains the one below it, bottom on `onto`.
///
/// The exact question "is there anything to move", asked of git rather than of
/// the recorded pointers — a pointer says what someone intended, and ancestry
/// says what is true.
async fn stack_is_current(repo_path: &str, onto: &str, branches: &[String]) -> Result<bool> {
    let mut below = onto.to_string();
    for branch in branches {
        if !is_ancestor(repo_path, &below, branch).await? {
            return Ok(false);
        }
        below = branch.clone();
    }
    Ok(true)
}

/// `git replay --contained --onto <onto> <old_base>..<tip>`.
///
/// Returns `Ok(None)` when replay declined the job in a way a rebase can still
/// do — an experimental command refusing a shape it does not handle is not a
/// reason to leave the stack where it was.
///
/// # Two gits, opposite defaults
///
/// Through git 2.5x `replay` printed `update-ref` lines and wrote nothing. In
/// 2.54 the default became "write them", with the old behaviour behind
/// `--ref-action=print`. Under the new default, `--contained` moves EVERY
/// branch inside the range, so a colleague's branch that happens to sit on the
/// same commits is rewritten by a command the user aimed at their own stack.
///
/// So the flag is passed wherever it exists, and the refs are compared before
/// and after regardless. Anything that moved is put back, and what it moved to
/// becomes the plan — filtered to the branches the caller actually named, with
/// each old tip pinned, and applied as one transaction. That way a future git
/// that changes this again is handled by the check rather than by the flag.
async fn replay_stack(
    repo_path: &str,
    onto: &str,
    old_base: &str,
    tip: &str,
    branches: &[String],
    old_heads: &BTreeMap<String, String>,
    capabilities: &StackCapabilities,
) -> Result<Option<RestackOutcome>> {
    let root = cwd(repo_path);
    let range = format!("{old_base}..{tip}");
    let before = head_refs(repo_path).await?;
    let mut args: Vec<String> = vec!["replay".into(), "--contained".into(), "--onto".into()];
    args.push(onto.to_string());
    if capabilities.replay_ref_action {
        args.push("--ref-action=print".into());
    }
    args.push(range);
    let plan = match exec::capture(&root, &args).await {
        Ok(plan) => plan,
        Err(_) => {
            // Replay refused. It may still have moved something on its way
            // there, so put the refs back before handing over to rebase.
            restore_head_refs(repo_path, &before).await?;
            return Ok(None);
        }
    };

    // Whatever replay decided, in one map: the printed lines on an older git,
    // the refs it wrote on a newer one.
    let mut proposed: BTreeMap<String, String> = BTreeMap::new();
    for line in plan.lines() {
        // `update refs/heads/<branch> <new> <old>` — the `git update-ref
        // --stdin` command language, which is what replay speaks. Both spellings
        // are accepted because the command word is the one thing that could
        // reasonably be renamed, and a parser that silently matches nothing
        // reads as "the stack was already current".
        let mut parts = line.split_whitespace();
        let (Some("update" | "update-ref"), Some(refname), Some(new_oid)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if let Some(branch) = refname.strip_prefix("refs/heads/") {
            proposed.insert(branch.to_string(), new_oid.to_string());
        }
    }
    let after = head_refs(repo_path).await?;
    if after != before {
        for (branch, oid) in &after {
            if before.get(branch) != Some(oid) {
                proposed.insert(branch.clone(), oid.clone());
            }
        }
        // Undo replay's own writes — including to branches nobody named —
        // before deciding what should actually move.
        restore_head_refs(repo_path, &before).await?;
    }

    let wanted: HashSet<&str> = branches.iter().map(String::as_str).collect();
    let mut accepted = String::new();
    let mut updates = Vec::new();
    for (branch, new_oid) in proposed {
        // A branch the caller did not name is somebody else's, and moving it
        // because it happened to be in the range is exactly the surprise a
        // stack tool must not produce.
        if !wanted.contains(branch.as_str()) {
            continue;
        }
        let Some(from) = old_heads.get(&branch) else {
            continue;
        };
        if from == &new_oid {
            continue;
        }
        let history_ref = record_history(repo_path, &branch, from).await?;
        accepted.push_str(&format!("update refs/heads/{branch} {new_oid} {from}\n"));
        updates.push(StackRefUpdate {
            branch: branch.clone(),
            from: from.clone(),
            to: new_oid,
            history_ref,
        });
    }
    if updates.is_empty() {
        // Nothing moved: the stack was already on `onto`.
        return Ok(Some(RestackOutcome {
            method: RestackMethod::Replay,
            updates,
            conflict: None,
        }));
    }
    // One transaction for the whole stack. A partial application would leave
    // layer 2 pointing at commits layer 1 no longer contains. The old value is
    // included on every line, so a concurrent change loses the race loudly
    // instead of being overwritten.
    exec::run_with_stdin(&root, ["update-ref", "--stdin"], &accepted).await?;
    Ok(Some(RestackOutcome {
        method: RestackMethod::Replay,
        updates,
        conflict: None,
    }))
}

/// Every local branch and where it points.
async fn head_refs(repo_path: &str) -> Result<BTreeMap<String, String>> {
    let listing = exec::capture(
        &cwd(repo_path),
        [
            "for-each-ref",
            "--format=%(refname:short) %(objectname)",
            "refs/heads",
        ],
    )
    .await?;
    Ok(listing
        .lines()
        .filter_map(|line| line.split_once(' '))
        .map(|(branch, oid)| (branch.to_string(), oid.to_string()))
        .collect())
}

/// Put every branch back where `snapshot` says it was.
///
/// Only the ones that differ, so this is a no-op in the common case and a
/// single transaction when it is not.
async fn restore_head_refs(repo_path: &str, snapshot: &BTreeMap<String, String>) -> Result<()> {
    let current = head_refs(repo_path).await?;
    let mut script = String::new();
    for (branch, oid) in snapshot {
        if current.get(branch) != Some(oid) {
            script.push_str(&format!("update refs/heads/{branch} {oid}\n"));
        }
    }
    for branch in current.keys() {
        if !snapshot.contains_key(branch) {
            script.push_str(&format!("delete refs/heads/{branch}\n"));
        }
    }
    if script.is_empty() {
        return Ok(());
    }
    exec::run_with_stdin(&cwd(repo_path), ["update-ref", "--stdin"], &script).await
}

/// Fallback: `rebase --onto` per layer, in a scratch worktree.
///
/// A scratch worktree rather than the repository's own: rebase checks the
/// branch out, and doing that in the user's working copy would swap their files
/// underneath them mid-operation.
///
/// # The exclusion point has to be the OLD parent tip
///
/// `rebase --onto <newbase> <upstream> <branch>` replays `<upstream>..<branch>`.
/// By the time layer 2 is rebased, layer 1 has already moved, so naming layer 1
/// as `<upstream>` asks for "commits in layer 2 that are not in the NEW layer
/// 1" — which still includes layer 1's ORIGINAL commits, and replays them a
/// second time. The tips captured before anything moved are the only correct
/// exclusion points.
///
/// # A conflict is left where it can be resolved
///
/// `git rebase` stops mid-operation on a conflict, and that half-finished state
/// in the scratch worktree is the only place it can be finished. It is
/// deliberately not cleaned up: the path comes back in the outcome, and the
/// existing sequencer commands take a repository path. Layers that were already
/// rebased stay moved — they are correctly restacked, and each carries the
/// pinned tip that undoes it.
async fn rebase_stack(
    repo_path: &str,
    onto: &str,
    old_base: &str,
    branches: &[String],
    old_heads: &BTreeMap<String, String>,
) -> Result<RestackOutcome> {
    let root = cwd(repo_path);
    let scratch = Path::new(repo_path)
        .join(".git")
        .join("cognia-stack-restack");
    let scratch_arg = scratch.to_string_lossy().to_string();
    // A leftover from an abandoned restack would make `worktree add` fail; the
    // caller has either resolved it or given up, and either way a new restack
    // starts from the branches as they are now.
    let _ = exec::succeeds(&root, ["worktree", "remove", "--force", &scratch_arg]).await;
    exec::run(&root, ["worktree", "add", "--detach", &scratch_arg, onto]).await?;

    let mut updates = Vec::new();
    let mut base = onto.to_string();
    for (index, branch) in branches.iter().enumerate() {
        let Some(from) = old_heads.get(branch) else {
            continue;
        };
        let exclusion = if index == 0 {
            old_base.to_string()
        } else {
            // The previous layer's tip as it was BEFORE this restack started.
            match old_heads.get(&branches[index - 1]) {
                Some(previous) => previous.clone(),
                None => base.clone(),
            }
        };
        let rebased = exec::succeeds(&scratch, ["rebase", "--onto", &base, &exclusion, branch])
            .await?;
        if !rebased {
            return Ok(RestackOutcome {
                method: RestackMethod::Rebase,
                updates,
                conflict: Some(StackConflict {
                    branch: branch.clone(),
                    worktree: scratch_arg,
                }),
            });
        }
        let to = resolve(repo_path, branch)
            .await?
            .unwrap_or_else(|| from.clone());
        if &to != from {
            let history_ref = record_history(repo_path, branch, from).await?;
            updates.push(StackRefUpdate {
                branch: branch.clone(),
                from: from.clone(),
                to: to.clone(),
                history_ref,
            });
        }
        base = branch.clone();
    }

    // Detach before removing so the last rebased branch is not left checked
    // out in a worktree that is about to disappear.
    let _ = exec::succeeds(&scratch, ["checkout", "--detach"]).await;
    let _ = exec::succeeds(&root, ["worktree", "remove", "--force", &scratch_arg]).await;
    Ok(RestackOutcome {
        method: RestackMethod::Rebase,
        updates,
        conflict: None,
    })
}

/// Undo one branch's move, using the tip [`restack`] pinned before it.
pub async fn revert_to_history(repo_path: &str, branch: &str, history_ref: &str) -> Result<String> {
    validate_branch_name(branch)?;
    if !history_ref.starts_with(HISTORY_NAMESPACE) {
        return Err(GitError::InvalidArgument(
            format!("not a stack history ref: {history_ref}").into(),
        ));
    }
    let root = cwd(repo_path);
    let target = exec::capture(&root, ["rev-parse", "--verify", history_ref])
        .await?
        .trim()
        .to_string();
    exec::run(
        &root,
        ["update-ref", &format!("refs/heads/{branch}"), &target],
    )
    .await?;
    Ok(target)
}

// ── Publishing ─────────────────────────────────────────────────────────────

/// Force-push a restacked stack, with a lease a background fetch cannot break.
///
/// `--force-with-lease` alone compares against the remote-tracking ref, which
/// any `git fetch` — including one the app itself ran a second ago — quietly
/// updates. That turns the lease into a rubber stamp and lets the push discard
/// a colleague's commit. `--force-if-includes` additionally requires that the
/// tip being replaced is actually reachable from what is being pushed, which is
/// the guarantee people believe `--force-with-lease` gives them.
///
/// When git is too old for `--force-if-includes` the push still happens with
/// the weaker lease; the returned flag says which guarantee was obtained, so a
/// caller can say so rather than implying the stronger one.
pub async fn push_stack(
    repo_path: &str,
    remote: &str,
    branches: &[String],
) -> Result<StackPushOutcome> {
    if branches.is_empty() {
        return Err(GitError::InvalidArgument("push needs a branch".into()));
    }
    for branch in branches {
        validate_branch_name(branch)?;
    }
    let capabilities = capabilities(repo_path).await?;
    let mut args: Vec<String> = vec!["push".into(), "--force-with-lease".into()];
    if capabilities.force_if_includes {
        args.push("--force-if-includes".into());
    }
    args.push(remote.to_string());
    // One push for the whole stack: the refs move together or not at all, and
    // a per-branch loop leaves the remote holding a half-restacked stack when
    // the third one is rejected.
    args.extend(branches.iter().map(|branch| format!("{branch}:{branch}")));
    exec::run(&cwd(repo_path), args).await?;
    Ok(StackPushOutcome {
        pushed: branches.to_vec(),
        force_if_includes: capabilities.force_if_includes,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackPushOutcome {
    pub pushed: Vec<String>,
    /// False when this git could only offer the weaker lease.
    pub force_if_includes: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command as SyncCommand;
    use tempfile::TempDir;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = SyncCommand::new("git")
            .current_dir(root)
            .args(args)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@e.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@e.com")
            .output()
            .unwrap_or_else(|error| panic!("spawn git {args:?}: {error}"));
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn commit(root: &Path, name: &str) {
        fs::write(root.join(name), format!("{name}\n")).unwrap();
        git(root, &["add", name]);
        git(root, &["commit", "-m", name]);
    }

    /// `main` → `layer-a` → `layer-b` → `layer-c`, each with one commit and a
    /// recorded parent pointer.
    async fn stacked() -> (TempDir, String) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        git(&root, &["init", "--initial-branch=main"]);
        git(&root, &["config", "user.name", "T"]);
        git(&root, &["config", "user.email", "t@e.com"]);
        commit(&root, "base.txt");
        for (branch, parent) in [
            ("layer-a", "main"),
            ("layer-b", "layer-a"),
            ("layer-c", "layer-b"),
        ] {
            git(&root, &["checkout", "-b", branch]);
            commit(&root, &format!("{branch}.txt"));
            set_parent(root.to_str().unwrap(), branch, Some(parent))
                .await
                .unwrap();
        }
        git(&root, &["checkout", "main"]);
        let path = root.to_str().unwrap().to_string();
        (tmp, path)
    }

    fn layers() -> Vec<String> {
        vec!["layer-a".into(), "layer-b".into(), "layer-c".into()]
    }

    #[tokio::test]
    async fn parent_pointers_round_trip_through_git_config() {
        // The pointer has to live where another clone of this repository can
        // read it, which is the whole reason it is config and not a table.
        let (tmp, path) = stacked().await;
        assert_eq!(parent_of(&path, "layer-b").unwrap().as_deref(), Some("layer-a"));
        assert_eq!(parent_of(&path, "main").unwrap(), None);

        let map = parent_map(&path).unwrap();
        assert_eq!(map.get("layer-a").map(String::as_str), Some("main"));
        assert_eq!(map.get("layer-c").map(String::as_str), Some("layer-b"));
        assert_eq!(map.len(), 3);

        set_parent(&path, "layer-b", None).await.unwrap();
        assert_eq!(parent_of(&path, "layer-b").unwrap(), None);
        // Clearing a pointer that was never there is not a failure.
        set_parent(&path, "layer-b", None).await.unwrap();
        drop(tmp);
    }

    #[tokio::test]
    async fn refuses_names_that_would_be_read_as_flags_or_revisions() {
        let (tmp, path) = stacked().await;
        for name in ["--onto", "layer..b", "layer:b", "layer b", ""] {
            assert!(
                set_parent(&path, name, Some("main")).await.is_err(),
                "accepted {name:?}"
            );
        }
        assert!(set_parent(&path, "layer-a", Some("layer-a")).await.is_err());
        drop(tmp);
    }

    #[tokio::test]
    async fn validate_reports_the_layer_that_stopped_containing_its_parent() {
        let (tmp, path) = stacked().await;
        let before = validate(&path, &layers()).await.unwrap();
        assert!(before.iter().all(|state| state.contains_parent));

        // Rewrite `layer-a`. `layer-b` still points at the old commit, so the
        // stack now LOOKS intact and is not — this is exactly the state that
        // publishes pull requests containing their parents' diffs.
        git(Path::new(&path), &["checkout", "layer-a"]);
        commit(Path::new(&path), "extra.txt");
        git(Path::new(&path), &["checkout", "main"]);

        let after = validate(&path, &layers()).await.unwrap();
        assert!(after[0].contains_parent, "layer-a still sits on main");
        assert!(!after[1].contains_parent, "layer-b is behind layer-a");
        assert_eq!(after[1].parent.as_deref(), Some("layer-a"));
        drop(tmp);
    }

    #[tokio::test]
    async fn validate_reports_a_missing_branch_rather_than_failing() {
        let (tmp, path) = stacked().await;
        let states = validate(&path, &["ghost".to_string()]).await.unwrap();
        assert_eq!(states[0].head, None);
        assert!(states[0].contains_parent, "no parent means nothing to be behind");
        drop(tmp);
    }

    #[tokio::test]
    async fn restack_refuses_a_layer_that_is_checked_out_somewhere() {
        // Moving the ref without moving the files leaves that worktree showing
        // a diff nobody wrote. Refusing by name is the only useful answer.
        let (tmp, path) = stacked().await;
        let elsewhere = TempDir::new().unwrap();
        let worktree = elsewhere.path().join("wt");
        git(
            Path::new(&path),
            &["worktree", "add", worktree.to_str().unwrap(), "layer-b"],
        );

        let states = validate(&path, &layers()).await.unwrap();
        assert!(states[1].checked_out_in.is_some());

        let error = restack(&path, "main", &layers()).await.unwrap_err();
        assert!(error.to_string().contains("layer-b"), "{error}");
        drop(tmp);
    }

    #[tokio::test]
    async fn restack_moves_every_layer_onto_the_new_base_and_pins_the_old_tips() {
        let (tmp, path) = stacked().await;
        let root = Path::new(&path);
        // Trunk moves on: this is the ordinary "main advanced, rebase your
        // stack" case that every layer above the bottom has to follow.
        git(root, &["checkout", "main"]);
        commit(root, "trunk.txt");

        let before: Vec<String> = layers()
            .iter()
            .map(|branch| git(root, &["rev-parse", branch]))
            .collect();

        let outcome = restack(&path, "main", &layers()).await.unwrap();
        assert!(outcome.conflict.is_none(), "{outcome:?}");
        assert_eq!(outcome.updates.len(), 3);

        let states = validate(&path, &layers()).await.unwrap();
        assert!(
            states.iter().all(|state| state.contains_parent),
            "{states:?}"
        );
        // Every layer now contains the trunk commit, and the chain still holds.
        for branch in layers() {
            assert!(is_ancestor(&path, "main", &branch).await.unwrap(), "{branch}");
        }

        // The old tips are reachable, so this is undoable and `gc` will not
        // collect the commits that were replaced.
        for (index, update) in outcome.updates.iter().enumerate() {
            assert_eq!(update.from, before[index]);
            assert_ne!(update.to, update.from);
            let pinned = git(root, &["rev-parse", &update.history_ref]);
            assert_eq!(pinned, update.from);
        }
        drop(tmp);
    }

    #[tokio::test]
    async fn restack_leaves_a_branch_it_was_not_given_where_it_is() {
        // A colleague's branch that happens to live inside the replayed range
        // must not be dragged along. `git replay --contained` would move it.
        let (tmp, path) = stacked().await;
        let root = Path::new(&path);
        git(root, &["checkout", "-b", "someone-else", "layer-b"]);
        let untouched = git(root, &["rev-parse", "someone-else"]);
        git(root, &["checkout", "main"]);
        commit(root, "trunk.txt");

        restack(&path, "main", &layers()).await.unwrap();
        assert_eq!(git(root, &["rev-parse", "someone-else"]), untouched);
        drop(tmp);
    }

    #[tokio::test]
    async fn restacking_a_stack_that_is_already_current_changes_nothing() {
        // Both engines re-create commits with a fresh committer date, so
        // without the early-out this rewrites every layer to a new SHA for no
        // change in content — invalidating reviews and forcing a push that
        // says nothing. It used to pass only when the whole test finished
        // inside one second.
        let (tmp, path) = stacked().await;
        let root = Path::new(&path);
        let before: Vec<String> = layers()
            .iter()
            .map(|branch| git(root, &["rev-parse", branch]))
            .collect();
        for capabilities in [None, Some(without_replay())] {
            let outcome = match &capabilities {
                Some(forced) => restack_with(&path, "main", &layers(), forced).await.unwrap(),
                None => restack(&path, "main", &layers()).await.unwrap(),
            };
            assert!(outcome.updates.is_empty(), "{outcome:?}");
            let after: Vec<String> = layers()
                .iter()
                .map(|branch| git(root, &["rev-parse", branch]))
                .collect();
            assert_eq!(before, after, "capabilities={capabilities:?}");
        }
        drop(tmp);
    }

    #[tokio::test]
    async fn restack_refuses_an_order_the_repository_disagrees_with() {
        // One of the two readings is stale, and restacking on either silently
        // rewrites the wrong history.
        let (tmp, path) = stacked().await;
        let swapped = vec!["layer-b".to_string(), "layer-a".to_string()];
        let error = restack(&path, "main", &swapped).await.unwrap_err();
        assert!(error.to_string().contains("recorded as stacked on"), "{error}");
        drop(tmp);
    }

    #[tokio::test]
    async fn a_restack_can_be_undone_from_the_pinned_tip() {
        let (tmp, path) = stacked().await;
        let root = Path::new(&path);
        git(root, &["checkout", "main"]);
        commit(root, "trunk.txt");
        let before = git(root, &["rev-parse", "layer-c"]);

        let outcome = restack(&path, "main", &layers()).await.unwrap();
        let update = outcome
            .updates
            .iter()
            .find(|update| update.branch == "layer-c")
            .expect("layer-c moved");
        assert_ne!(git(root, &["rev-parse", "layer-c"]), before);

        let restored = revert_to_history(&path, "layer-c", &update.history_ref)
            .await
            .unwrap();
        assert_eq!(restored, before);
        assert_eq!(git(root, &["rev-parse", "layer-c"]), before);
        drop(tmp);
    }

    #[tokio::test]
    async fn history_refs_are_the_only_thing_an_undo_will_accept() {
        // The ref name reaches `update-ref`, so "any ref the caller names" is
        // a way to point a branch at an arbitrary object from the renderer.
        let (tmp, path) = stacked().await;
        let error = revert_to_history(&path, "layer-c", "refs/heads/main")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("stack history"), "{error}");
        drop(tmp);
    }

    #[tokio::test]
    async fn capabilities_answers_for_the_git_that_is_actually_installed() {
        let (tmp, path) = stacked().await;
        let capabilities = capabilities(&path).await.unwrap();
        assert!(capabilities.version.starts_with("git version"));
        // Not asserting which features exist — that is the point of probing —
        // but the probe must produce an answer rather than an error.
        let _ = capabilities.replay;
        let _ = capabilities.force_if_includes;
        drop(tmp);
    }

    /// A git that has no `replay`, so the fallback runs.
    fn without_replay() -> StackCapabilities {
        StackCapabilities {
            version: "git version 2.39.0".into(),
            replay: false,
            replay_ref_action: false,
            force_if_includes: false,
        }
    }

    #[tokio::test]
    async fn the_rebase_fallback_lands_the_stack_in_the_same_place() {
        // Every git older than 2.44 takes this path, and this machine's git is
        // not one of them — without forcing it, the branch that runs for those
        // users would only ever execute in production.
        let (tmp, path) = stacked().await;
        let root = Path::new(&path);
        git(root, &["checkout", "main"]);
        commit(root, "trunk.txt");
        let head_of_main = git(root, &["rev-parse", "main"]);

        let outcome = restack_with(&path, "main", &layers(), &without_replay())
            .await
            .unwrap();
        assert_eq!(outcome.method, RestackMethod::Rebase);
        assert!(outcome.conflict.is_none(), "{outcome:?}");
        assert_eq!(outcome.updates.len(), 3);

        let states = validate(&path, &layers()).await.unwrap();
        assert!(states.iter().all(|state| state.contains_parent), "{states:?}");
        for branch in layers() {
            assert!(is_ancestor(&path, "main", &branch).await.unwrap(), "{branch}");
        }
        // The whole point of the exclusion-point fix: three layers, three
        // commits on top of the trunk — not six, and not layer-a's commit
        // replayed once per layer above it.
        let replayed = git(root, &["rev-list", "--count", &format!("{head_of_main}..layer-c")]);
        assert_eq!(replayed, "3");

        // The scratch worktree is gone, and the user's own checkout never moved.
        assert!(!Path::new(&path).join(".git/cognia-stack-restack").exists());
        assert_eq!(git(root, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        drop(tmp);
    }

    #[tokio::test]
    async fn a_conflicting_layer_is_left_somewhere_it_can_be_resolved() {
        let (tmp, path) = stacked().await;
        let root = Path::new(&path);
        // layer-a and main both rewrite the same file: rebasing layer-a onto
        // main cannot be done without a person.
        git(root, &["checkout", "layer-a"]);
        fs::write(root.join("shared.txt"), "from the stack\n").unwrap();
        git(root, &["add", "shared.txt"]);
        git(root, &["commit", "-m", "stack edit"]);
        git(root, &["checkout", "main"]);
        fs::write(root.join("shared.txt"), "from the trunk\n").unwrap();
        git(root, &["add", "shared.txt"]);
        git(root, &["commit", "-m", "trunk edit"]);

        let outcome = restack_with(&path, "main", &layers(), &without_replay())
            .await
            .unwrap();
        let conflict = outcome.conflict.expect("layer-a conflicts with main");
        assert_eq!(conflict.branch, "layer-a");
        // Left in place on purpose — the half-finished rebase is the only
        // place the conflict can be resolved, and the sequencer commands take
        // a repository path.
        assert!(Path::new(&conflict.worktree).exists());
        drop(tmp);
    }

    #[tokio::test]
    async fn restack_needs_a_branch_to_move() {
        let (tmp, path) = stacked().await;
        assert!(restack(&path, "main", &[]).await.is_err());
        assert!(push_stack(&path, "origin", &[]).await.is_err());
        drop(tmp);
    }
}
