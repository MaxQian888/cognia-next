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
