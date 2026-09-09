//! Supply a managed source checkout straight from a remote (ADR-0176).
//!
//! Everything downstream of this module already works: `acquire_workspace_bundle`,
//! `create_execution`, `apply_provisioning` and `inspect_bundle_root` all want a
//! non-bare git root with commits in it, and that is exactly what this produces.
//! What was missing was any way to *get* one without a human first cloning the
//! repository onto the machine by hand, which is why an issue run could not
//! start on a headless server or in a container.
//!
//! # `origin` points at the mirror, and that is deliberate
//!
//! `github_workspace_clone` does the opposite: it re-points `origin` at the real
//! remote, because a workspace that exists to push cannot have a local directory
//! as its `origin`. A managed *source* checkout is the other case. It never
//! pushes, and two things downstream run `git fetch origin` on it with **no
//! credential at all** ([`crate::service`]'s `fetch_origin_throttled` and
//! `resolve_pull_request_base`). Against a private repository those fail.
//!
//! Leaving `origin` on the mirror makes them work, because the mirror is a
//! directory on this machine that was itself fetched *with* the credential. The
//! token is used once, here, and `cognia-task-workspace` never learns it: no
//! credential is written into a Registry row, a git config, or the SQLite store.
//!
//! The real remote is still recorded, as a second credential-free remote named
//! `upstream`, so `git remote -v` in the checkout tells the truth about where
//! the code came from rather than pointing only at a cache directory.

use std::fmt;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use cognia_git_mirror::credential::GitCredential;
use cognia_git_mirror::{
    checkout_path, derive_from_mirror, ensure_mirror, DerivedOrigin, MirrorRequest,
};
use serde::{Deserialize, Serialize};

use crate::types::WorkspaceBaseSpec;

/// Wall-clock ceiling for each git invocation the supply path makes.
///
/// Generous, because the first mirror of a large repository really is slow.
/// Bounded, because this runs on a blocking pool thread with an issue run
/// waiting behind it, and an unbounded fetch there is a hung run rather than a
/// slow one.
pub const REMOTE_SUPPLY_BUDGET: Duration = Duration::from_secs(10 * 60);

/// The remote name the real upstream is recorded under.
///
/// Not `origin`: see the module docs. `origin` is the mirror so credential-free
/// fetches work, and this is here so the checkout still says where the code
/// actually came from.
pub const UPSTREAM_REMOTE: &str = "upstream";

/// Supply the source checkout for `remote_url`, creating it if absent.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureRemoteSource {
    /// The real remote. https for anything that needs a credential.
    pub remote_url: String,
    /// What the caller intends to build on. Only [`WorkspaceBaseSpec::PullRequest`]
    /// changes what is fetched, because GitHub does not advertise `refs/pull/*`
    /// and the ref has to be asked for by name.
    #[serde(default)]
    pub base: WorkspaceBaseSpec,
    /// PAT or installation token for the mirror fetch.
    ///
    /// `skip_serializing` so a value that came in can never go back out, in a
    /// response, a log line, or a persisted job payload.
    #[serde(default, skip_serializing)]
    pub credential: Option<String>,
}

/// Never prints the credential. A token in a debug line is a token in a log
/// file, and this struct is exactly the kind of thing that gets `{:?}`'d while
/// someone is diagnosing a failed supply.
impl fmt::Debug for EnsureRemoteSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EnsureRemoteSource")
            .field("remote_url", &self.remote_url)
            .field("base", &self.base)
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSourceCheckout {
    /// The non-bare git root a bundle can now be acquired over.
    pub source_root: String,
    /// The ref the requested base resolves to in this checkout, when the base
    /// names one. `None` for a base that is only meaningful against a working
    /// tree the caller has not created yet.
    pub resolved_ref: Option<String>,
    /// The bare mirror this checkout was derived from, and still fetches from.
    pub mirror_path: String,
}

/// Extra refspecs the mirror must be asked for before this base can be resolved.
///
/// GitHub does not advertise `refs/pull/*`, so a pull-request base is invisible
/// to a plain fetch. Asking for it here is what makes
/// `resolve_pull_request_base` succeed later without a credential.
pub fn extra_refspecs_for(base: &WorkspaceBaseSpec) -> Vec<String> {
    match base {
        WorkspaceBaseSpec::PullRequest {
            number, fetch_ref, ..
        } => {
            let source = fetch_ref
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("refs/pull/{number}/head"));
            // Fetched into the same name locally, which is what
            // `resolve_pull_request_base` looks for.
            vec![format!("+{source}:{source}")]
        }
        _ => Vec::new(),
    }
}

/// The ref a base names in a freshly supplied checkout, if it names one.
fn requested_ref(base: &WorkspaceBaseSpec) -> Option<String> {
    match base {
        WorkspaceBaseSpec::GitRef { git_ref } if !git_ref.trim().is_empty() => {
            Some(git_ref.trim().to_string())
        }
        WorkspaceBaseSpec::PullRequest {
            number, fetch_ref, ..
        } => Some(
            fetch_ref
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("refs/pull/{number}/head")),
        ),
        // `WorkingState` and `LocalHead` are about a tree the caller already
        // had. A supplied checkout has neither yet, and `RemoteDefault` is
        // whatever the mirror's HEAD is, which the derive already checked out.
        _ => None,
    }
}

/// Bring the mirror up to date and make sure a source checkout exists for it.
///
/// Returns the checkout even when it already existed: this is idempotent by
/// design, because two issue runs against one repository must share one source
/// rather than each cloning their own. The caller is expected to hold a
/// per-repository lock around it (`service::git_admin_lock`), since two
/// concurrent supplies of the same remote would otherwise race on one directory.
pub fn ensure_remote_source(
    mirror_root: &Path,
    sources_dir: &Path,
    input: &EnsureRemoteSource,
) -> Result<RemoteSourceCheckout, String> {
    let _perf = cognia_instrument::guard("workspace.ensure_remote_source");
    let remote = input.remote_url.trim();
    if remote.is_empty() {
        return Err("remote URL is required".to_string());
    }
    let credential = input
        .credential
        .as_deref()
        .and_then(GitCredential::from_token);
    let refspecs = extra_refspecs_for(&input.base);

    std::fs::create_dir_all(sources_dir)
        .map_err(|error| format!("create sources dir {}: {error}", sources_dir.display()))?;
    let source_root = checkout_path(sources_dir, remote)
        .map_err(|error| format!("resolve source checkout path: {error}"))?;

    let request = MirrorRequest::new(mirror_root, remote)
        .maybe_credential(credential.as_ref())
        .extra_refspecs(&refspecs)
        .budget(REMOTE_SUPPLY_BUDGET);

    // Unlike every other mirror caller, a miss here is fatal. The others fall
    // back to cloning from the network themselves. This path has no fallback,
    // because the network clone *is* the mirror, so reporting the failure is
    // the only honest answer.
    let mirror =
        ensure_mirror(&request).ok_or_else(|| format!("could not supply a mirror for {remote}"))?;

    if is_git_checkout(&source_root) {
        // Already supplied, so nothing is cloned. The fetch below is what
        // brings it up to date.
    } else {
        // A directory that is not a git checkout is a dead attempt, not a
        // checkout, and reusing one wedges the repository permanently.
        if source_root.exists() {
            let _ = std::fs::remove_dir_all(&source_root);
        }
        if !derive_from_mirror(&request, &source_root, None, DerivedOrigin::Mirror) {
            let _ = std::fs::remove_dir_all(&source_root);
            return Err(format!("could not derive a source checkout for {remote}"));
        }
    }

    // Both paths, not just the reuse path. A fresh `git clone` of the mirror
    // brings `refs/heads/*` and nothing else, so a pull-request ref reaches the
    // mirror and stops there unless it is asked for here by name too.
    refresh_from_mirror(&source_root, &refspecs)?;

    // Credential-free, and re-set every time so a repository that moved is not
    // left claiming its old address.
    set_upstream_remote(&source_root, remote)?;

    let resolved_ref = requested_ref(&input.base).map(|name| {
        // Best effort: report the name we were given when it cannot be resolved
        // to a commit yet, rather than failing the supply. The caller's own
        // base resolution reports that properly, with its own error.
        rev_parse(&source_root, &name).unwrap_or(name)
    });

    Ok(RemoteSourceCheckout {
        source_root: source_root.to_string_lossy().into_owned(),
        resolved_ref,
        mirror_path: mirror.to_string_lossy().into_owned(),
    })
}

/// A non-bare git working tree, as opposed to a directory, a bare repository,
/// or the wreckage of an interrupted clone.
fn is_git_checkout(path: &Path) -> bool {
    path.join(".git").exists()
}

/// Bring the checkout level with the mirror.
///
/// `origin` is the mirror, a path on this machine, so none of this needs a
/// credential and none of it can reach the network.
///
/// The plain fetch is best effort: a stale checkout still holds the history,
/// and the caller's own base resolution reports anything genuinely missing with
/// a better error than this could. An explicit refspec is not best effort,
/// because it is the thing the caller specifically asked for.
fn refresh_from_mirror(source_root: &Path, refspecs: &[String]) -> Result<(), String> {
    let _ = git(source_root, &["fetch", "--prune", "origin"])?;
    if refspecs.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["fetch", "origin"];
    args.extend(refspecs.iter().map(String::as_str));
    let output = git(source_root, &args)?;
    if !output.status.success() {
        return Err(format!(
            "fetch {} into the source checkout: {}",
            refspecs.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn set_upstream_remote(source_root: &Path, remote_url: &str) -> Result<(), String> {
    let existing = git(source_root, &["remote", "get-url", UPSTREAM_REMOTE])?;
    let args: Vec<&str> = if existing.status.success() {
        vec!["remote", "set-url", UPSTREAM_REMOTE, remote_url]
    } else {
        vec!["remote", "add", UPSTREAM_REMOTE, remote_url]
    };
    let output = git(source_root, &args)?;
    if !output.status.success() {
        return Err(format!(
            "record upstream remote: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn rev_parse(source_root: &Path, name: &str) -> Option<String> {
    let output = git(source_root, &["rev-parse", "--verify", name]).ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

fn git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| format!("start git {}: {error}", args.join(" ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
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

    /// A real upstream on disk, reachable as a `file://` remote.
    fn upstream(dir: &Path) -> String {
        std::fs::create_dir_all(dir).unwrap();
        sh(dir, &["init", "--initial-branch=main", "."]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        sh(dir, &["add", "."]);
        sh(dir, &["commit", "-m", "first"]);
        format!("file://{}", dir.display())
    }

    fn ensure(tmp: &TempDir, remote: &str, base: WorkspaceBaseSpec) -> RemoteSourceCheckout {
        ensure_remote_source(
            &tmp.path().join("mirrors"),
            &tmp.path().join("sources"),
            &EnsureRemoteSource {
                remote_url: remote.to_string(),
                base,
                credential: None,
            },
        )
        .expect("supply")
    }

    fn remote_url_of(root: &Path, name: &str) -> String {
        let output = git(root, &["remote", "get-url", name]).unwrap();
        assert!(output.status.success(), "no remote {name}");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn a_remote_becomes_a_worktree_capable_source_checkout() {
        let tmp = TempDir::new().unwrap();
        let remote = upstream(&tmp.path().join("upstream"));

        let supplied = ensure(&tmp, &remote, WorkspaceBaseSpec::RemoteDefault);
        let root = PathBuf::from(&supplied.source_root);

        // Non-bare, with a commit in it: exactly what `acquire_workspace_bundle`
        // and `create_execution` already know how to work with.
        assert!(root.join(".git").exists(), "not a checkout");
        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).unwrap(),
            "hello\n"
        );
        assert!(rev_parse(&root, "HEAD").is_some(), "no commit to build on");
        assert!(PathBuf::from(&supplied.mirror_path).exists());
    }

    #[test]
    fn origin_is_the_mirror_and_upstream_is_the_real_remote() {
        // The inversion this module exists for. `fetch_origin_throttled` runs
        // `git fetch origin` with no credential, so `origin` has to be the
        // mirror or a private repository fails there.
        let tmp = TempDir::new().unwrap();
        let remote = upstream(&tmp.path().join("upstream"));
        let supplied = ensure(&tmp, &remote, WorkspaceBaseSpec::RemoteDefault);
        let root = PathBuf::from(&supplied.source_root);

        let origin = remote_url_of(&root, "origin");
        assert_eq!(
            std::fs::canonicalize(&origin).unwrap(),
            std::fs::canonicalize(&supplied.mirror_path).unwrap(),
            "origin must be the mirror, not the network"
        );
        assert_eq!(
            remote_url_of(&root, UPSTREAM_REMOTE),
            remote,
            "the checkout must still say where the code came from"
        );
    }

    #[test]
    fn the_source_checkout_fetches_from_the_mirror_not_the_network() {
        let tmp = TempDir::new().unwrap();
        let upstream_dir = tmp.path().join("upstream");
        let remote = upstream(&upstream_dir);
        let supplied = ensure(&tmp, &remote, WorkspaceBaseSpec::RemoteDefault);
        let root = PathBuf::from(&supplied.source_root);

        // With the real remote gone, a fetch that reached the network would
        // fail. This one reads the mirror.
        std::fs::remove_dir_all(&upstream_dir).unwrap();
        refresh_from_mirror(&root, &[]).expect("fetch origin");
        assert!(rev_parse(&root, "HEAD").is_some());
    }

    #[test]
    fn a_second_acquisition_of_one_repo_reuses_one_source_checkout() {
        let tmp = TempDir::new().unwrap();
        let remote = upstream(&tmp.path().join("upstream"));

        let first = ensure(&tmp, &remote, WorkspaceBaseSpec::RemoteDefault);
        let marker = PathBuf::from(&first.source_root).join("cognia-reused-marker");
        std::fs::write(&marker, "x").unwrap();

        let second = ensure(&tmp, &remote, WorkspaceBaseSpec::RemoteDefault);
        assert_eq!(first.source_root, second.source_root);
        assert!(
            marker.exists(),
            "the checkout was recreated instead of reused"
        );

        let entries = std::fs::read_dir(tmp.path().join("sources"))
            .unwrap()
            .count();
        assert_eq!(entries, 1, "one repository is one source checkout");
    }

    #[test]
    fn a_pull_request_base_is_fetchable_after_supply() {
        // GitHub does not advertise `refs/pull/*`, so the ref has to be asked
        // for by name at mirror time. Published on the upstream here, which is
        // what the forge does.
        let tmp = TempDir::new().unwrap();
        let upstream_dir = tmp.path().join("upstream");
        let remote = upstream(&upstream_dir);
        std::fs::write(upstream_dir.join("feature.txt"), "pr\n").unwrap();
        sh(&upstream_dir, &["add", "."]);
        sh(&upstream_dir, &["commit", "-m", "pr head"]);
        sh(&upstream_dir, &["update-ref", "refs/pull/7/head", "HEAD"]);
        sh(&upstream_dir, &["reset", "--hard", "HEAD~1"]);

        let supplied = ensure(
            &tmp,
            &remote,
            WorkspaceBaseSpec::PullRequest {
                provider: "github".into(),
                repo: "o/r".into(),
                number: 7,
                fetch_ref: None,
                head_sha: None,
            },
        );
        let root = PathBuf::from(&supplied.source_root);

        assert!(
            rev_parse(&root, "refs/pull/7/head").is_some(),
            "the pull-request head did not reach the checkout"
        );
        assert_eq!(
            supplied.resolved_ref.as_deref(),
            rev_parse(&root, "refs/pull/7/head").as_deref(),
            "resolvedRef must name the commit, not repeat the ref"
        );

        // The contract `service::resolve_pull_request_base` actually depends
        // on: `git fetch origin <ref>` in the checkout, with no credential,
        // against a remote that no longer exists.
        std::fs::remove_dir_all(&upstream_dir).unwrap();
        let fetch = git(&root, &["fetch", "origin", "refs/pull/7/head"]).unwrap();
        assert!(
            fetch.status.success(),
            "credential-free PR fetch failed: {}",
            String::from_utf8_lossy(&fetch.stderr)
        );
        assert!(rev_parse(&root, "FETCH_HEAD").is_some());
    }

    #[test]
    fn a_half_written_directory_is_replaced_rather_than_reused() {
        let tmp = TempDir::new().unwrap();
        let remote = upstream(&tmp.path().join("upstream"));
        let sources = tmp.path().join("sources");
        let expected = checkout_path(&sources, &remote).unwrap();
        std::fs::create_dir_all(&expected).unwrap();
        std::fs::write(expected.join("junk"), "half a clone").unwrap();

        let supplied = ensure(&tmp, &remote, WorkspaceBaseSpec::RemoteDefault);

        assert_eq!(PathBuf::from(&supplied.source_root), expected);
        assert!(expected.join(".git").exists());
        assert!(!expected.join("junk").exists());
    }

    #[test]
    fn an_unreachable_remote_is_an_error_here_rather_than_a_silent_miss() {
        // Every other mirror caller treats a miss as "use the network". This
        // one has no network to fall back to: the mirror *is* the clone.
        let tmp = TempDir::new().unwrap();
        let remote = format!("file://{}", tmp.path().join("absent").display());
        let error = ensure_remote_source(
            &tmp.path().join("mirrors"),
            &tmp.path().join("sources"),
            &EnsureRemoteSource {
                remote_url: remote,
                base: WorkspaceBaseSpec::RemoteDefault,
                credential: None,
            },
        )
        .expect_err("a miss must be reported");
        assert!(error.contains("could not supply a mirror"), "{error}");
    }

    #[test]
    fn a_blank_remote_is_refused_before_anything_is_created() {
        let tmp = TempDir::new().unwrap();
        let sources = tmp.path().join("sources");
        let error = ensure_remote_source(
            &tmp.path().join("mirrors"),
            &sources,
            &EnsureRemoteSource {
                remote_url: "   ".into(),
                base: WorkspaceBaseSpec::RemoteDefault,
                credential: None,
            },
        )
        .expect_err("blank remote");
        assert!(error.contains("remote URL is required"), "{error}");
        assert!(!sources.exists(), "nothing should have been created");
    }

    /// The credential is an input, never an output. It must not survive into a
    /// response, a serialised job payload, or a debug line.
    #[test]
    fn the_credential_never_leaves_the_struct_it_arrived_in() {
        let input = EnsureRemoteSource {
            remote_url: "https://github.com/o/r.git".into(),
            base: WorkspaceBaseSpec::RemoteDefault,
            credential: Some("ghs_SECRET".into()),
        };
        let json = serde_json::to_string(&input).expect("serialize");
        assert!(!json.contains("ghs_SECRET"), "{json}");
        assert!(!json.contains("credential"), "{json}");
        assert!(!format!("{input:?}").contains("ghs_SECRET"), "debug leaked");
    }

    #[test]
    fn only_a_pull_request_base_asks_the_mirror_for_an_extra_ref() {
        assert!(extra_refspecs_for(&WorkspaceBaseSpec::RemoteDefault).is_empty());
        assert!(extra_refspecs_for(&WorkspaceBaseSpec::GitRef {
            git_ref: "main".into()
        })
        .is_empty());
        assert_eq!(
            extra_refspecs_for(&WorkspaceBaseSpec::PullRequest {
                provider: "github".into(),
                repo: "o/r".into(),
                number: 12,
                fetch_ref: None,
                head_sha: None,
            }),
            vec!["+refs/pull/12/head:refs/pull/12/head".to_string()]
        );
        // An explicit ref wins, because not every forge spells it the same way.
        assert_eq!(
            extra_refspecs_for(&WorkspaceBaseSpec::PullRequest {
                provider: "gitlab".into(),
                repo: "o/r".into(),
                number: 12,
                fetch_ref: Some("refs/merge-requests/12/head".into()),
                head_sha: None,
            }),
            vec!["+refs/merge-requests/12/head:refs/merge-requests/12/head".to_string()]
        );
    }
}
