//! The shared bare-mirror object cache, and everything needed to drive it.
//!
//! [`plan`] is the pure half (URL normalisation, cache paths, freshness, the
//! argument vectors) and moved here verbatim from `cognia-task-workspace`.
//! [`credential`] is the one credential policy. [`runner`] runs git under a
//! budget it can actually enforce. This module is the orchestration that used
//! to live in `src-tauri/src/github/workspace.rs`, where no leaf crate could
//! reach it.
//!
//! # The root is process-global, and that is the fix
//!
//! The old `mirror_root(base_dir)` derived the cache from the *worktree base
//! directory*, whose default (`"cognia-github-worktrees"`) is a **relative**
//! path. In production the cache therefore lived under whatever the process
//! working directory happened to be, while the GC swept `mirror_root(None)`,
//! and a caller that injected a base wrote somewhere else again. The writer and
//! the collector could disagree about where the cache was.
//!
//! [`set_root`] is called once at boot with `<data_dir>/task-workspaces/mirrors`
//! so there is one answer. [`root`] falls back to a temp-dir path rather than a
//! relative one, because a cache that silently follows the working directory is
//! how the first bug happened.
//!
//! # A cache miss is never an error
//!
//! Every failure below returns "use the network" rather than propagating.
//! A corrupt mirror, an unfetchable remote, a branch created upstream since the
//! last fetch: each costs one slow clone. A cache that can fail a run is worse
//! than no cache.

pub mod credential;
pub mod plan;
pub mod runner;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

pub use credential::GitCredential;
pub use plan::{
    checkout_path, clone_args, derive_args, fetch_args, is_fresh, is_mirror, maintenance_commands,
    mirror_path, normalize_remote_url, reclaim_candidates, stamp_fetch, MirrorError,
    DEFAULT_MIRROR_TTL,
};
pub use runner::{run_git, run_git_quietly, GitRun, RunError};

/// How long an untouched mirror is kept.
///
/// Long enough that a project worked on weekly never re-clones, short enough
/// that a repository someone tried once does not sit on disk forever. A mirror
/// is a cache: deleting one costs a slow clone, keeping one costs the whole
/// repository's history.
pub const DEFAULT_MIRROR_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// One lock per mirror directory, so two callers asking for the same
/// repository at the same time queue instead of fighting.
///
/// Without it the second caller can `remove_dir_all` the very directory the
/// first is cloning into: [`ensure_mirror`] treats "exists but is not a bare
/// repository" as garbage from a dead attempt, and a clone in progress looks
/// exactly like that. Two clones of *different* repositories never contend,
/// because the key is the mirror path.
///
/// The outer `Mutex` is held only long enough to hand out an `Arc`, never
/// across git. Entries are kept rather than reaped: one empty mutex per
/// repository this process has ever cloned is not a leak worth the complexity
/// of collecting, and dropping one while a waiter held it would reintroduce
/// exactly the race it closes.
static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

fn lock_for(mirror: &Path) -> Arc<Mutex<()>> {
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(guard.entry(mirror.to_path_buf()).or_default())
}

/// Point the cache at a directory. Called once at boot, before any clone.
///
/// Returns `false` when a root was already set, so a second caller learns it
/// lost rather than silently believing it won. Following the
/// `cognia_instrument` pattern: one process, one registry, set at startup.
pub fn set_root(path: PathBuf) -> bool {
    ROOT.set(path).is_ok()
}

/// Where the cache lives.
///
/// The fallback is under the system temp directory rather than a relative path.
/// A relative default is what let the production cache follow the process
/// working directory, and it is not a mistake worth being able to make twice.
pub fn root() -> PathBuf {
    ROOT.get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("cognia-git-mirrors"))
}

/// What one mirror operation needs to know.
///
/// A struct rather than a parameter list because the budget is the eighth
/// thing: a call site with eight positional arguments is one where the
/// credential and the refspecs get swapped without the compiler noticing.
#[derive(Clone, Copy)]
pub struct MirrorRequest<'a> {
    pub cache_root: &'a Path,
    pub remote: &'a str,
    pub credential: Option<&'a GitCredential>,
    /// Forwarded to [`plan::fetch_args`]. Pass the PR head refspec when the
    /// caller intends to resolve a pull-request base out of the mirror,
    /// because GitHub does not advertise `refs/pull/*`.
    pub extra_refspecs: &'a [String],
    /// Wall-clock ceiling for *each* git invocation the mirror makes.
    ///
    /// `None` accepts an unbounded fetch, which is only ever right for a
    /// caller with no deadline of its own. The mirror exists to make a clone
    /// faster; one that can hang past the budget of the request it is serving
    /// has made it slower, and the fallback to the network never runs.
    pub budget: Option<Duration>,
}

impl<'a> MirrorRequest<'a> {
    pub fn new(cache_root: &'a Path, remote: &'a str) -> Self {
        Self {
            cache_root,
            remote,
            credential: None,
            extra_refspecs: &[],
            budget: None,
        }
    }

    pub fn maybe_credential(mut self, credential: Option<&'a GitCredential>) -> Self {
        self.credential = credential;
        self
    }

    pub fn extra_refspecs(mut self, refspecs: &'a [String]) -> Self {
        self.extra_refspecs = refspecs;
        self
    }

    pub fn maybe_budget(mut self, budget: Option<Duration>) -> Self {
        self.budget = budget;
        self
    }

    pub fn budget(self, budget: Duration) -> Self {
        self.maybe_budget(Some(budget))
    }

    /// `(origin, credential)` for [`runner::GitRun`], or `None`.
    ///
    /// A credential we cannot key on a host is a credential we do not send.
    fn auth(&self) -> Option<(String, &'a GitCredential)> {
        match (credential::origin_of(self.remote), self.credential) {
            (Some(origin), Some(credential)) => Some((origin, credential)),
            _ => None,
        }
    }
}

/// Run one git command on the mirror's behalf, carrying the request's
/// credential and budget. Quiet: a cache miss is not an error to report.
fn run_for(request: &MirrorRequest<'_>, cwd: &Path, args: &[String]) -> bool {
    let auth = request.auth();
    let run = GitRun::new(cwd, args)
        .maybe_credential(auth.as_ref().map(|(origin, cred)| (origin.as_str(), *cred)))
        .maybe_budget(request.budget);
    run_git_quietly(run)
}

/// Bring the mirror for the request's remote up to date, creating it when absent.
///
/// Returns the mirror's path, or `None` when the cache could not be used, which
/// is a request to reach the network instead.
pub fn ensure_mirror(request: &MirrorRequest<'_>) -> Option<PathBuf> {
    let mirror = mirror_path(request.cache_root, request.remote).ok()?;
    if std::fs::create_dir_all(request.cache_root).is_err() {
        return None;
    }

    // Serialise callers that want the same repository. A poisoned lock means a
    // previous holder panicked mid-clone, which is a reason to re-derive the
    // mirror rather than to give up on the cache forever.
    let lock = lock_for(&mirror);
    let _held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    if !is_mirror(&mirror) {
        // A previous attempt may have died partway through. A directory that is
        // not a bare repository is garbage, not a cache.
        let _ = std::fs::remove_dir_all(&mirror);
        let args = clone_args(request.remote, &mirror);
        if !run_for(request, request.cache_root, &args) {
            let _ = std::fs::remove_dir_all(&mirror);
            return None;
        }
        let _ = stamp_fetch(&mirror);
        run_maintenance(&mirror);
        if !request.extra_refspecs.is_empty() {
            let args = fetch_args(request.extra_refspecs);
            let _ = run_for(request, &mirror, &args);
        }
        return Some(mirror);
    }

    // An explicit refspec is not covered by the freshness stamp: the mirror can
    // be fresh and still not hold the ref, because nothing asked for it before.
    let stale = !is_fresh(&mirror, DEFAULT_MIRROR_TTL, SystemTime::now());
    if stale || !request.extra_refspecs.is_empty() {
        let args = fetch_args(request.extra_refspecs);
        if run_for(request, &mirror, &args) {
            let _ = stamp_fetch(&mirror);
            run_maintenance(&mirror);
        }
        // A failed refresh is not fatal: a slightly stale mirror still holds the
        // history, and the derived clone fetches from the real remote the first
        // time it needs something newer.
    }
    Some(mirror)
}

/// What a derived checkout should point `origin` at.
///
/// The two callers want opposite things, and getting it backwards is a defect
/// that only shows up after the agent has finished its work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DerivedOrigin {
    /// Re-point `origin` at the real remote. A checkout whose `origin` is a
    /// directory on this machine cannot push, and a workspace that exists to
    /// push must be able to. This is what `github_workspace_clone` does.
    RealRemote,
    /// Leave `origin` pointing at the mirror. The managed *source* checkout
    /// never pushes, and keeping the mirror as `origin` is what lets the
    /// worktree layer run `git fetch origin` against a private repository
    /// without ever being handed a credential.
    Mirror,
}

/// Clone `branch` out of the mirror into `destination`.
///
/// Returns `false` when the mirror could not serve it and nothing was left
/// behind, which is a request to clone from the network instead.
pub fn derive_from_mirror(
    request: &MirrorRequest<'_>,
    destination: &Path,
    branch: Option<&str>,
    origin_policy: DerivedOrigin,
) -> bool {
    let Some(mirror) = ensure_mirror(request) else {
        return false;
    };

    let derive = derive_args(&mirror, destination, branch);
    if !run_for(request, request.cache_root, &derive) {
        // The branch may simply not be in the mirror yet (created upstream after
        // the last fetch). Leave nothing half-written behind and let the network
        // clone answer.
        let _ = std::fs::remove_dir_all(destination);
        return false;
    }

    if origin_policy == DerivedOrigin::RealRemote {
        let args = vec![
            "remote".to_string(),
            "set-url".to_string(),
            "origin".to_string(),
            request.remote.to_string(),
        ];
        // No credential and no budget: a local `remote set-url` touches no
        // network and cannot hang.
        if !run_git_quietly(GitRun::new(destination, &args)) {
            // A checkout that cannot push is worse than a slow clone.
            let _ = std::fs::remove_dir_all(destination);
            return false;
        }
    }
    true
}

/// Write the commit-graph and multi-pack-index for a mirror.
///
/// Best effort and never fatal. Deliberately not `git maintenance register`,
/// which would write our cache directory into the user's global config and
/// schedule machine-wide background jobs against it.
pub fn run_maintenance(mirror: &Path) {
    for args in maintenance_commands() {
        let _ = run_git_quietly(GitRun::new(mirror, &args));
    }
}

/// Delete mirrors nothing has fetched in `max_age`. Returns how many.
///
/// By age rather than by size: a mirror nobody has asked for in a month is the
/// one to drop, and evicting the biggest instead removes the repository the
/// user is most likely working in.
pub fn reclaim_stale(cache_root: &Path, max_age: Duration) -> usize {
    reclaim_candidates(cache_root, max_age, SystemTime::now())
        .into_iter()
        .filter(|mirror| std::fs::remove_dir_all(mirror).is_ok())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn sh(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    }

    /// A real upstream repository on disk, reachable as a `file://` remote.
    fn upstream(dir: &Path) -> String {
        std::fs::create_dir_all(dir).unwrap();
        sh(dir, &["init", "--initial-branch=main", "."]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        sh(dir, &["add", "."]);
        sh(dir, &["commit", "-m", "first"]);
        format!("file://{}", dir.display())
    }

    #[test]
    fn the_first_call_creates_a_mirror_and_the_second_reuses_it() {
        let tmp = TempDir::new().unwrap();
        let remote = upstream(&tmp.path().join("upstream"));
        let cache = tmp.path().join("cache");

        let request = MirrorRequest::new(&cache, &remote);
        let first = ensure_mirror(&request).expect("first");
        assert!(is_mirror(&first));
        let marker = first.join("cognia-reused-marker");
        std::fs::write(&marker, "x").unwrap();

        let second = ensure_mirror(&request).expect("second");
        assert_eq!(first, second);
        // Reused rather than re-cloned: a fresh clone would not carry the marker.
        assert!(
            marker.exists(),
            "the mirror was recreated instead of reused"
        );
    }

    #[test]
    fn a_directory_that_is_not_a_bare_repository_is_replaced() {
        let tmp = TempDir::new().unwrap();
        let remote = upstream(&tmp.path().join("upstream"));
        let cache = tmp.path().join("cache");

        let expected = mirror_path(&cache, &remote).unwrap();
        std::fs::create_dir_all(&expected).unwrap();
        std::fs::write(expected.join("junk"), "not a repository").unwrap();

        let mirror = ensure_mirror(&MirrorRequest::new(&cache, &remote)).expect("mirror");
        assert_eq!(mirror, expected);
        assert!(is_mirror(&mirror));
        assert!(!mirror.join("junk").exists());
    }

    #[test]
    fn an_unusable_remote_is_a_cache_miss_not_an_error() {
        let tmp = TempDir::new().unwrap();
        let cache = tmp.path().join("cache");
        let remote = format!("file://{}", tmp.path().join("does-not-exist").display());

        assert!(ensure_mirror(&MirrorRequest::new(&cache, &remote)).is_none());
        // Nothing half-written is left for the next call to trip over.
        let expected = mirror_path(&cache, &remote).unwrap();
        assert!(!expected.exists(), "a failed clone left a directory behind");
    }

    #[test]
    fn a_derived_checkout_points_origin_where_the_caller_asked() {
        let tmp = TempDir::new().unwrap();
        let remote = upstream(&tmp.path().join("upstream"));
        let cache = tmp.path().join("cache");

        let pushes = tmp.path().join("pushes");
        let request = MirrorRequest::new(&cache, &remote);
        assert!(derive_from_mirror(
            &request,
            &pushes,
            Some("main"),
            DerivedOrigin::RealRemote,
        ));
        assert_eq!(origin_url(&pushes), remote);

        let source = tmp.path().join("source");
        assert!(derive_from_mirror(
            &request,
            &source,
            Some("main"),
            DerivedOrigin::Mirror,
        ));
        let mirror = mirror_path(&cache, &remote).unwrap();
        assert_eq!(
            std::fs::canonicalize(origin_url(&source)).unwrap(),
            std::fs::canonicalize(&mirror).unwrap()
        );
    }

    #[test]
    fn a_branch_the_mirror_does_not_have_falls_through_to_the_network() {
        let tmp = TempDir::new().unwrap();
        let remote = upstream(&tmp.path().join("upstream"));
        let cache = tmp.path().join("cache");
        let destination = tmp.path().join("checkout");

        assert!(!derive_from_mirror(
            &MirrorRequest::new(&cache, &remote),
            &destination,
            Some("branch-that-does-not-exist"),
            DerivedOrigin::RealRemote,
        ));
        assert!(
            !destination.exists(),
            "a failed derive left a half-written checkout behind"
        );
    }

    #[test]
    fn reclaim_removes_only_what_is_stale() {
        let tmp = TempDir::new().unwrap();
        let remote = upstream(&tmp.path().join("upstream"));
        let cache = tmp.path().join("cache");
        let mirror = ensure_mirror(&MirrorRequest::new(&cache, &remote)).expect("mirror");

        assert_eq!(reclaim_stale(&cache, DEFAULT_MIRROR_MAX_AGE), 0);
        assert!(mirror.exists());

        assert_eq!(reclaim_stale(&cache, Duration::ZERO), 1);
        assert!(!mirror.exists());
    }

    /// The budget is the whole reason [`runner`] is sync, and it is worth
    /// nothing unless the orchestration passes it down. A mirror clone of an
    /// unreachable host would otherwise sit in `connect()` forever while the
    /// caller that has a 120s clone budget waits behind it, and the fallback
    /// to the network — the thing that makes a cache miss survivable — never
    /// gets to run.
    #[test]
    fn a_budget_reaches_the_git_the_mirror_runs() {
        let tmp = TempDir::new().unwrap();
        let cache = tmp.path().join("cache");
        // A remote that neither resolves nor refuses quickly. The assertion is
        // not the wall-clock (a CI box may resolve-fail instantly); it is that
        // the miss is clean and bounded rather than a hang.
        let remote = format!("file://{}", tmp.path().join("absent").display());

        let started = std::time::Instant::now();
        let request = MirrorRequest::new(&cache, &remote).budget(Duration::from_millis(1_500));
        assert!(ensure_mirror(&request).is_none(), "a miss, not a mirror");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the budget did not bound the attempt"
        );
        assert!(
            !mirror_path(&cache, &remote).unwrap().exists(),
            "a bounded failure still cleans up after itself"
        );
    }

    /// A request carries no budget unless one is asked for, and the two
    /// builders are the only way to set it. Pinned because
    /// `ensure_mirror`/`derive_from_mirror` read the field directly: a
    /// constructor that silently dropped it would leave every production
    /// clone unbounded again, which is the state this test exists to end.
    #[test]
    fn a_request_carries_the_budget_it_was_given() {
        let cache = PathBuf::from("/tmp/cache");
        let base = MirrorRequest::new(&cache, "https://github.com/o/r.git");
        assert_eq!(base.budget, None);
        assert_eq!(
            base.budget(Duration::from_secs(30)).budget,
            Some(Duration::from_secs(30))
        );
        assert_eq!(base.maybe_budget(None).budget, None);
    }

    /// Two callers wanting the same repository at the same time is now the
    /// normal case, not a corner: the workspace clone and a guarded clone both
    /// reach this. Without the per-mirror lock the second caller's
    /// `remove_dir_all` (its "a directory that is not a bare repository is
    /// garbage" branch) deletes the directory the first is still cloning into,
    /// and both walk away with nothing.
    #[test]
    fn two_callers_racing_for_one_repository_both_get_a_mirror() {
        let tmp = TempDir::new().unwrap();
        let remote = upstream(&tmp.path().join("upstream"));
        let cache = tmp.path().join("cache");

        let results: Vec<Option<PathBuf>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    let cache = cache.clone();
                    let remote = remote.clone();
                    scope.spawn(move || ensure_mirror(&MirrorRequest::new(&cache, &remote)))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        assert!(
            results.iter().all(|r| r.is_some()),
            "a concurrent caller was starved: {results:?}"
        );
        let first = results[0].clone().unwrap();
        assert!(results.iter().all(|r| r.as_ref() == Some(&first)));
        assert!(is_mirror(&first));
    }

    /// The other half of the contract the fallback rests on: a miss leaves
    /// nothing behind, so the network clone that follows finds a clean
    /// destination rather than a directory that looks cloned and is not.
    #[test]
    fn a_miss_leaves_the_destination_clean_for_the_network_clone() {
        let tmp = TempDir::new().unwrap();
        let cache = tmp.path().join("cache");
        let remote = format!("file://{}", tmp.path().join("never-existed").display());
        let destination = tmp.path().join("checkout");

        assert!(!derive_from_mirror(
            &MirrorRequest::new(&cache, &remote),
            &destination,
            None,
            DerivedOrigin::RealRemote,
        ));
        assert!(!destination.exists(), "a miss must not leave a checkout");
        assert!(
            !mirror_path(&cache, &remote).unwrap().exists(),
            "a miss must not leave a mirror"
        );
    }

    #[test]
    fn the_default_root_is_absolute() {
        // The bug this replaces: a relative default made the cache follow the
        // process working directory, so the writer and the GC disagreed.
        assert!(root().is_absolute(), "{:?}", root());
    }

    fn origin_url(checkout: &Path) -> String {
        let args = vec![
            "remote".to_string(),
            "get-url".to_string(),
            "origin".to_string(),
        ];
        run_git(GitRun::new(checkout, &args).capture_stdout())
            .expect("remote get-url")
            .trim()
            .to_string()
    }
}
