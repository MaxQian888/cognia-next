//! Repository lifecycle (system git): `git init`, plus `.gitignore` editing.
//!
//! Lives apart from `read.rs` because that module is git2-only/sync; these
//! helpers shell out (init) or touch the worktree (ignore_add).

use super::error::{GitError, Result};
use super::exec;
use super::read::open_repo;
use super::types::GitIdentity;

fn cwd(path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(path)
}

/// `git init` — turn a plain directory into a repository.
pub async fn init(path: &str) -> Result<()> {
    exec::run(&cwd(path), ["init"]).await
}

/// Clone `remote_url` into `destination` and return the canonical worktree path.
///
/// The destination's parent is used as the subprocess cwd so cloning also
/// works when the destination itself does not exist yet. `--` prevents a
/// remote or destination beginning with `-` from being parsed as an option.
pub async fn clone_repo(remote_url: &str, destination: &str) -> Result<String> {
    cognia_instrument::timed("git.clone", clone_repo_inner(remote_url, destination)).await
}

async fn clone_repo_inner(remote_url: &str, destination: &str) -> Result<String> {
    let remote_url = remote_url.trim();
    if remote_url.is_empty() {
        return Err(GitError::InvalidArgument("empty clone URL".into()));
    }
    if destination.trim().is_empty() {
        return Err(GitError::InvalidArgument("empty clone destination".into()));
    }

    let destination_path = std::path::PathBuf::from(destination);
    if !destination_path.is_absolute() {
        return Err(GitError::InvalidArgument(
            "clone destination must be an absolute path".into(),
        ));
    }
    let parent = destination_path.parent().ok_or_else(|| {
        GitError::InvalidArgument(format!("clone destination has no parent: {destination}").into())
    })?;
    let parent_is_dir = tokio::fs::metadata(parent)
        .await
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false);
    if !parent_is_dir {
        return Err(GitError::NotFound(
            format!(
                "clone destination parent does not exist: {}",
                parent.display()
            )
            .into(),
        ));
    }

    exec::run(
        parent,
        [
            "clone".to_string(),
            "--".to_string(),
            remote_url.to_string(),
            destination_path.to_string_lossy().into_owned(),
        ],
    )
    .await?;

    tokio::fs::canonicalize(&destination_path)
        .await
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|err| {
            GitError::CommandFailed(
                format!(
                    "canonicalize cloned repository {}: {err}",
                    destination_path.display()
                )
                .into(),
            )
        })
}

/// Hosts a guarded clone will fetch from when the caller names none.
///
/// An allow-list rather than a block-list: a plugin handing this an arbitrary
/// URL would otherwise be a request-forgery primitive reaching whatever the
/// desktop can route to, including a link-local metadata service.
pub const DEFAULT_CLONE_HOSTS: &[&str] = &["github.com", "gitlab.com", "bitbucket.org"];

/// Guard rails for [`clone_repo_guarded`]. Every field has a default; a caller
/// may tighten but the host floor (scheme, credentials, allow-list) always
/// applies.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloneGuards {
    /// Extra hosts beyond [`DEFAULT_CLONE_HOSTS`].
    pub allowed_hosts: Vec<String>,
    /// `--depth`; `0` clones full history. Default 1.
    pub depth: Option<u32>,
    /// Reject (and delete) a checkout larger than this. Default 500 MiB.
    pub max_size_mb: Option<u64>,
    /// Wall-clock budget for the clone. Default 120s.
    pub timeout_secs: Option<u64>,
}

const CLONE_DEFAULT_DEPTH: u32 = 1;
const CLONE_DEFAULT_MAX_SIZE_MB: u64 = 500;
const CLONE_DEFAULT_TIMEOUT_SECS: u64 = 120;

/// Validate a clone URL against the host floor.
///
/// Pure so the policy is testable without a network or a git binary. Returns
/// the parsed host on success.
pub fn validate_clone_url(remote_url: &str, extra_hosts: &[String]) -> Result<String> {
    let url = remote_url.trim();
    if url.is_empty() {
        return Err(GitError::InvalidArgument("empty clone URL".into()));
    }
    if url.starts_with('-') {
        return Err(GitError::InvalidArgument(
            "clone URL may not begin with '-'".into(),
        ));
    }
    let rest = url.strip_prefix("https://").ok_or_else(|| {
        GitError::InvalidArgument(
            format!(
                "only https:// clone URLs are allowed, got: {}",
                exec::redact(url)
            )
            .into(),
        )
    })?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err(GitError::InvalidArgument("clone URL has no host".into()));
    }
    if authority.contains('@') {
        // Credentials in the URL would be written into the checkout's remote
        // and read back by anything that can run `git remote -v` inside it.
        return Err(GitError::InvalidArgument(
            "clone URL may not embed credentials".into(),
        ));
    }
    let host = authority
        .split(':')
        .next()
        .unwrap_or(authority)
        .to_ascii_lowercase();
    let allowed = DEFAULT_CLONE_HOSTS.iter().any(|h| *h == host)
        || extra_hosts.iter().any(|h| h.to_ascii_lowercase() == host);
    if !allowed {
        return Err(GitError::InvalidArgument(
            format!("clone host not allowed: {host}").into(),
        ));
    }
    Ok(host)
}

/// Total byte size of a directory tree, following no symlinks.
fn dir_size_bytes(root: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

/// Clone with guard rails: https-only, host allow-list, no embedded
/// credentials, shallow by default, under a wall-clock budget, and bounded in
/// size.
///
/// The size bound is a **post-condition**, not a pre-emptive limit: git offers
/// no reliable "stop at N bytes", so an oversized repository is cloned, then
/// detected and deleted. The shallow default keeps the usual case small. The
/// bare [`clone_repo`] stays as-is for the Source Control panel, where the user
/// typed the URL themselves.
pub async fn clone_repo_guarded(
    remote_url: &str,
    destination: &str,
    guards: &CloneGuards,
) -> Result<String> {
    cognia_instrument::timed(
        "git.clone_guarded",
        clone_repo_guarded_inner(remote_url, destination, guards),
    )
    .await
}

async fn clone_repo_guarded_inner(
    remote_url: &str,
    destination: &str,
    guards: &CloneGuards,
) -> Result<String> {
    validate_clone_url(remote_url, &guards.allowed_hosts)?;

    let destination_path = std::path::PathBuf::from(destination);
    if !destination_path.is_absolute() {
        return Err(GitError::InvalidArgument(
            "clone destination must be an absolute path".into(),
        ));
    }
    let parent = destination_path.parent().ok_or_else(|| {
        GitError::InvalidArgument(format!("clone destination has no parent: {destination}").into())
    })?;
    tokio::fs::create_dir_all(parent).await.map_err(|err| {
        GitError::CommandFailed(format!("create clone parent {}: {err}", parent.display()).into())
    })?;

    let depth = guards.depth.unwrap_or(CLONE_DEFAULT_DEPTH);
    let mut args = vec!["clone".to_string()];
    if depth > 0 {
        args.push("--depth".to_string());
        args.push(depth.to_string());
        args.push("--single-branch".to_string());
    }
    args.push("--".to_string());
    args.push(remote_url.trim().to_string());
    args.push(destination_path.to_string_lossy().into_owned());

    let budget = std::time::Duration::from_secs(
        guards
            .timeout_secs
            .unwrap_or(CLONE_DEFAULT_TIMEOUT_SECS)
            .max(1),
    );
    match tokio::time::timeout(budget, exec::run(parent, args)).await {
        Ok(result) => result?,
        Err(_) => {
            // A half-written checkout is worse than none: the next call would
            // find a directory that looks cloned and is not.
            let _ = tokio::fs::remove_dir_all(&destination_path).await;
            return Err(GitError::CommandFailed(
                format!("clone timed out after {}s", budget.as_secs()).into(),
            ));
        }
    }

    let max_bytes = guards
        .max_size_mb
        .unwrap_or(CLONE_DEFAULT_MAX_SIZE_MB)
        .saturating_mul(1024 * 1024);
    let cloned = destination_path.clone();
    let size = tokio::task::spawn_blocking(move || dir_size_bytes(&cloned))
        .await
        .unwrap_or(0);
    if max_bytes > 0 && size > max_bytes {
        let _ = tokio::fs::remove_dir_all(&destination_path).await;
        return Err(GitError::InvalidArgument(
            format!(
                "cloned repository is {} MiB, over the {} MiB limit",
                size / (1024 * 1024),
                max_bytes / (1024 * 1024)
            )
            .into(),
        ));
    }

    tokio::fs::canonicalize(&destination_path)
        .await
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|err| {
            GitError::CommandFailed(
                format!(
                    "canonicalize cloned repository {}: {err}",
                    destination_path.display()
                )
                .into(),
            )
        })
}

/// Resolve the effective commit identity for this repository (local config
/// first, then the user's inherited/global Git configuration).
pub fn identity(repo_path: &str) -> Result<GitIdentity> {
    let repo = open_repo(repo_path)?;
    let config = repo.config()?;
    let value = |key: &str| {
        config
            .get_string(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Ok(GitIdentity {
        name: value("user.name"),
        email: value("user.email"),
    })
}

/// Resolve only repository-local identity values without inherited/global fallbacks.
pub fn identity_local(repo_path: &str) -> Result<GitIdentity> {
    let repo = open_repo(repo_path)?;
    let config = repo.config()?.open_level(git2::ConfigLevel::Local)?;
    let value = |key: &str| {
        config
            .get_string(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Ok(GitIdentity {
        name: value("user.name"),
        email: value("user.email"),
    })
}

/// Set the commit identity in repository-local or user-global Git config.
pub async fn set_identity(repo_path: &str, name: &str, email: &str, global: bool) -> Result<()> {
    set_identity_with_env(repo_path, name, email, global, &[]).await
}

async fn set_identity_with_env(
    repo_path: &str,
    name: &str,
    email: &str,
    global: bool,
    envs: &[(&str, &str)],
) -> Result<()> {
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() || email.is_empty() {
        return Err(GitError::InvalidArgument(
            "git identity name and email are required".into(),
        ));
    }
    let scope = if global { "--global" } else { "--local" };
    let repo_cwd = cwd(repo_path);
    exec::run_with_env(&repo_cwd, ["rev-parse", "--git-dir"], envs).await?;
    exec::run_with_env(&repo_cwd, ["config", scope, "user.name", name], envs).await?;
    exec::run_with_env(&repo_cwd, ["config", scope, "user.email", email], envs).await
}

/// Append `pattern` as a line to the repo-root `.gitignore`, creating the file
/// if missing. A pattern that already exists as a line is a no-op.
pub async fn ignore_add(repo_path: &str, pattern: &str) -> Result<()> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(GitError::InvalidArgument("empty ignore pattern".into()));
    }
    let repo = open_repo(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| GitError::NotARepo(repo_path.to_string().into()))?
        .to_path_buf();
    let path = workdir.join(".gitignore");

    let existing = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err(GitError::CommandFailed(
                format!("read .gitignore: {e}").into(),
            ))
        }
    };
    if existing.lines().any(|l| l.trim() == pattern) {
        return Ok(());
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(pattern);
    next.push('\n');
    tokio::fs::write(&path, next)
        .await
        .map_err(|e| GitError::CommandFailed(format!("write .gitignore: {e}").into()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn clone_url_floor_rejects_everything_that_is_not_a_plain_https_allowlisted_url() {
        let none: Vec<String> = Vec::new();

        assert_eq!(
            validate_clone_url("https://github.com/owner/repo.git", &none).unwrap(),
            "github.com"
        );
        assert_eq!(
            validate_clone_url("https://GitLab.com/owner/repo", &none).unwrap(),
            "gitlab.com"
        );

        // Non-https transports would reach the SSH agent or the local disk.
        for url in [
            "git@github.com:owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "http://github.com/owner/repo.git",
            "file:///etc/passwd",
            "/tmp/local/repo",
        ] {
            assert!(
                validate_clone_url(url, &none).is_err(),
                "{url} must be refused"
            );
        }

        // A URL beginning with '-' would be read by git as an option.
        assert!(validate_clone_url("--upload-pack=touch /tmp/x", &none).is_err());

        // Credentials in the URL end up in the checkout's remote config.
        assert!(validate_clone_url("https://user:pw@github.com/o/r.git", &none).is_err());

        // Anything off the list, including a metadata service.
        for url in [
            "https://169.254.169.254/latest/meta-data/",
            "https://localhost/repo.git",
            "https://evil.example.com/o/r.git",
        ] {
            assert!(
                validate_clone_url(url, &none).is_err(),
                "{url} must be refused"
            );
        }

        // A caller may widen the list, and only the host it named.
        let extra = vec!["git.internal.example".to_string()];
        assert_eq!(
            validate_clone_url("https://git.internal.example/o/r.git", &extra).unwrap(),
            "git.internal.example"
        );
        assert!(validate_clone_url("https://other.example/o/r.git", &extra).is_err());
    }

    #[test]
    fn clone_url_floor_keeps_the_port_out_of_the_host_comparison() {
        let extra = vec!["git.internal.example".to_string()];
        assert_eq!(
            validate_clone_url("https://git.internal.example:8443/o/r.git", &extra).unwrap(),
            "git.internal.example"
        );
    }

    use super::*;
    use git2::Repository;
    use std::fs;
    use tempfile::TempDir;

    fn git_on_path() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }

    #[tokio::test]
    async fn init_creates_a_repository() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();
        init(&rp).await.unwrap();
        assert!(Repository::open(tmp.path()).is_ok());
    }

    #[tokio::test]
    async fn clone_repo_clones_a_real_local_remote_and_returns_the_destination() {
        if !git_on_path() {
            return;
        }
        let fixture = TempDir::new().unwrap();
        let source = fixture.path().join("source");
        fs::create_dir(&source).unwrap();
        let source_repo = Repository::init(&source).unwrap();
        let mut config = source_repo.config().unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        config.set_str("user.name", "Test User").unwrap();
        fs::write(source.join("README.md"), "# cloned\n").unwrap();
        let mut index = source_repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = source_repo.find_tree(tree_id).unwrap();
        let signature = source_repo.signature().unwrap();
        source_repo
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();

        let destination = fixture.path().join(" cloned ");
        let cloned = clone_repo(&source.to_string_lossy(), &destination.to_string_lossy())
            .await
            .unwrap();

        assert_eq!(
            std::path::PathBuf::from(cloned),
            destination.canonicalize().unwrap()
        );
        assert_eq!(
            fs::read_to_string(destination.join("README.md")).unwrap(),
            "# cloned\n"
        );
        assert!(Repository::open(destination).is_ok());
    }

    /// Reads `(count, error_count)` for a span without resetting the registry —
    /// it is a process-global shared with every other test in this crate.
    fn span_counts(name: &str) -> (u64, u64) {
        cognia_instrument::registry::REGISTRY
            .snapshot()
            .iter()
            .find(|row| row.name == name)
            .map(|row| (row.count, row.error_count))
            .unwrap_or((0, 0))
    }

    /// A clone that fails must be recorded as a failure. This is the whole
    /// reason `clone_repo` wraps an inner fn in `timed` instead of holding a
    /// plain `guard`: a guard defaults to success, so a clone that burned the
    /// full 120 s budget and then errored would land in the p50/p95 as if it
    /// had worked — quietly poisoning the baseline these spans exist to
    /// establish.
    #[tokio::test]
    async fn clone_spans_record_failure_as_an_error() {
        let (count_before, errors_before) = span_counts("git.clone");

        // Relative destination: refused before git is ever started.
        assert!(clone_repo("https://example.test/repo.git", "nested/repo")
            .await
            .is_err());

        // Deltas are asserted as increases, not exact values: `git.clone` is a
        // process-global counter and the sibling clone tests run concurrently
        // on the same registry, so any exact arithmetic here is a flake.
        let (count_after, errors_after) = span_counts("git.clone");
        assert!(count_after > count_before, "the span must be recorded");
        assert!(
            errors_after > errors_before,
            "a failed clone must count as an error, not a success"
        );
    }

    #[tokio::test]
    async fn clone_repo_rejects_relative_destinations_before_running_git() {
        let result = clone_repo("https://example.test/repo.git", "nested/repo").await;

        assert!(matches!(result, Err(GitError::InvalidArgument(_))));
    }

    #[tokio::test]
    async fn identity_round_trips_repository_local_name_and_email() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        let repo_path = tmp.path().to_string_lossy();

        let initial = identity(&repo_path).unwrap();
        set_identity(
            &repo_path,
            "Cognia Developer",
            "developer@example.com",
            false,
        )
        .await
        .unwrap();
        let configured = identity(&repo_path).unwrap();

        assert_eq!(configured.name.as_deref(), Some("Cognia Developer"));
        assert_eq!(configured.email.as_deref(), Some("developer@example.com"));
        assert!(
            initial.name != configured.name || initial.email != configured.email,
            "the repository-local identity must override any inherited global identity"
        );
    }

    #[test]
    fn local_identity_does_not_inherit_global_values() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        let repo_path = tmp.path().to_string_lossy();

        let configured = identity_local(&repo_path).unwrap();

        assert_eq!(configured.name, None);
        assert_eq!(configured.email, None);
    }

    #[tokio::test]
    async fn set_identity_rejects_blank_fields_without_mutating_config() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        let repo_path = tmp.path().to_string_lossy();

        let result = set_identity(&repo_path, " ", "developer@example.com", false).await;

        assert!(matches!(result, Err(GitError::InvalidArgument(_))));
        let configured = Repository::open(tmp.path()).unwrap().config().unwrap();
        let local = configured.open_level(git2::ConfigLevel::Local).unwrap();
        assert!(local.get_entry("user.name").is_err());
    }

    #[tokio::test]
    async fn set_identity_writes_to_an_isolated_global_config() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let repo_path = tmp.path().join("repo");
        fs::create_dir(&repo_path).unwrap();
        Repository::init(&repo_path).unwrap();
        let global_config = tmp.path().join("global.gitconfig");
        let global_config_value = global_config.to_string_lossy();

        set_identity_with_env(
            &repo_path.to_string_lossy(),
            "Global Developer",
            "global@example.com",
            true,
            &[("GIT_CONFIG_GLOBAL", &global_config_value)],
        )
        .await
        .unwrap();

        let config = git2::Config::open(&global_config).unwrap();
        assert_eq!(config.get_string("user.name").unwrap(), "Global Developer");
        assert_eq!(
            config.get_string("user.email").unwrap(),
            "global@example.com"
        );
    }

    #[tokio::test]
    async fn ignore_add_creates_the_file() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();
        ignore_add(&rp, "dist/").await.unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join(".gitignore")).unwrap(),
            "dist/\n"
        );
    }

    #[tokio::test]
    async fn ignore_add_appends_with_newline_handling() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        // Existing file without a trailing newline.
        fs::write(tmp.path().join(".gitignore"), "node_modules").unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();
        ignore_add(&rp, "dist/").await.unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join(".gitignore")).unwrap(),
            "node_modules\ndist/\n"
        );
    }

    #[tokio::test]
    async fn ignore_add_dedupes_existing_lines() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        fs::write(tmp.path().join(".gitignore"), "dist/\n").unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();
        ignore_add(&rp, " dist/ ").await.unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join(".gitignore")).unwrap(),
            "dist/\n"
        );
    }

    #[tokio::test]
    async fn ignore_add_rejects_empty_pattern() {
        let tmp = TempDir::new().unwrap();
        Repository::init(tmp.path()).unwrap();
        let rp = tmp.path().to_string_lossy().into_owned();
        assert!(ignore_add(&rp, "  ").await.is_err());
    }
}
