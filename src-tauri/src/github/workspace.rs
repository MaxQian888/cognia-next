//! Git workspace operations for Marketplace repository plugins' local backend.
//!
//! Previously `lib/github/workspace.ts` shelled out to Node's `simple-git`
//! which pulled `node:fs/promises` / `node:child_process` into the static
//! browser graph through `lib/plugin/core/browser-builtin-registry.ts`.
//! That broke the Next.js bundle once the `NODE_ONLY_MODULES` aliases were
//! deleted from `next.config.ts`. Moving the local backend into Rust here
//! keeps the renderer free of Node built-ins; plugins reach it through the
//! host-owned workspace API.
//!
//! We shell out to the user's system `git` for clone/push (same model
//! simple-git used) instead of pulling libgit2's `https` + `openssl-sys`
//! features. Repository automation already requires a working `git` on PATH,
//! so this doesn't add a new prerequisite.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// Mirrors the JS default that lived inline at `lib/github/workspace.ts`.
const DEFAULT_BASE_DIR: &str = "cognia-github-worktrees";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneArgs {
    pub repo_full_name: String,
    pub branch: String,
    /// Existing branch cloned before creating `branch`. When omitted the
    /// target branch itself is cloned for backwards compatibility.
    pub base_branch: Option<String>,
    /// PAT or installation token. Embedded into the clone URL; never logged.
    pub token: String,
    /// Override the directory the worktree is allocated under. Tests inject
    /// a tempdir here; production callers leave it unset to use the relative
    /// default that the legacy JS code used.
    pub base_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitAndPushArgs {
    pub workspace_path: String,
    /// Canonical GitHub owner/repository identity captured by the host before
    /// the agent receives the worktree. Never derive the push target from the
    /// agent-mutable local git configuration.
    pub repo_full_name: String,
    pub base_branch: Option<String>,
    /// Branch checked out in the workspace (used as the push refspec when
    /// `remote_branch` is omitted).
    pub branch: String,
    pub message: String,
    pub remote_branch: Option<String>,
    /// PAT or installation token, supplied per-push. Required because the
    /// clone deliberately stores a credential-free remote URL — see
    /// `apply_git_auth_env`. Optional so a caller pushing to an
    /// already-authenticated remote (e.g. a user's own checkout) still works.
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatResult {
    pub exists: bool,
    /// Filesystem mtime in milliseconds since the Unix epoch. Matches the
    /// shape JS `node:fs/promises.stat` returned (`mtimeMs`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<f64>,
}

/// Arguments for every clone this subsystem performs.
///
/// Partial rather than shallow. `--depth` truncates history, and a truncated
/// history cannot be rebased past its boundary — which is exactly what a branch
/// stacked on another branch must do when the one below it moves. It is also
/// not the bargain it appears to be: GitHub's published measurements put a
/// shallow *fetch* from such a clone well behind a full one, and every later
/// fetch in the workspace inherits that cost. `--filter=blob:none` keeps the
/// whole commit graph and omits only historical file contents, which nothing
/// here reads. `--single-branch` is explicit because it used to be implied by
/// `--depth`, and dropping that without saying so would start fetching every
/// branch in the repository.
fn clone_args<'a>(remote: &'a str, destination: &'a str, branch: &'a str) -> [&'a str; 6] {
    [
        remote,
        destination,
        "--branch",
        branch,
        "--single-branch",
        "--filter=blob:none",
    ]
}

/// Allocate a worktree under `<base_dir>/<sanitized-repo>/<base36-stamp>` and
/// clone the requested branch into it. Returns the absolute path and
/// allocation timestamp so the TS side can synthesize a `WorkspaceHandle`.
#[tauri::command]
pub async fn github_workspace_clone(args: CloneArgs) -> Result<CloneResult, String> {
    let base_dir = args
        .base_dir
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_DIR.to_string());
    let sanitized = sanitize_repo_name(&args.repo_full_name);
    let now_ms = unix_millis_now();
    let stamp = base36(now_ms as u64);
    let path = PathBuf::from(&base_dir).join(&sanitized).join(&stamp);
    let path_str = path.to_string_lossy().into_owned();

    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| format!("mkdir {path_str}: {e}"))?;

    // The remote URL is credential-FREE on purpose. `git clone` writes whatever
    // URL it is given verbatim into `<workspace>/.git/config` and leaves it
    // there — and the Issue→PR loop then points an agent at this very directory
    // with shell/process/environment tools enabled. A token embedded in the URL
    // would therefore be readable with a plain `cat .git/config` by anything the
    // agent runs, including instructions injected through an issue body (which
    // is attacker-controlled: anyone can file an issue). The credential is
    // instead supplied per-invocation via `git_auth_env` below.
    let remote = canonical_github_remote(&args.repo_full_name)?;

    let clone_branch = args.base_branch.as_deref().unwrap_or(&args.branch);
    let mut command = Command::new("git");
    command
        .arg("clone")
        .args(clone_args(&remote, &path_str, clone_branch))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_git_auth_env(&mut command, &args.token);
    let output = command
        .output()
        .await
        .map_err(|e| format!("git clone spawn: {e}"))?;
    if !output.status.success() {
        // Redact the token before surfacing stderr — git embeds the remote URL
        // in its error messages and we don't want it ending up in renderer logs.
        let stderr =
            redact_git_credentials(&String::from_utf8_lossy(&output.stderr), Some(&args.token));
        return Err(format!("git clone failed: {stderr}"));
    }

    if clone_branch != args.branch {
        run_git_silent(&path, ["checkout", "-b", &args.branch]).await?;
    }

    Ok(CloneResult {
        path: path_str,
        created_at: now_ms,
    })
}

/// Stage all changes in the workspace, commit, and push. Returns the new
/// commit SHA. Errors with `commitAndPush: no changes to commit` when
/// `git status --porcelain` is empty (matches the legacy JS behavior the
/// workflow node already pattern-matches against).
#[tauri::command]
pub async fn github_workspace_commit_and_push(args: CommitAndPushArgs) -> Result<String, String> {
    let agent_workspace = PathBuf::from(&args.workspace_path);
    let push_branch = args.remote_branch.as_deref().unwrap_or(&args.branch);
    let base_branch = args.base_branch.as_deref().unwrap_or(&args.branch);
    let remote = canonical_github_remote(&args.repo_full_name)?;
    let staging = tempfile::Builder::new()
        .prefix("cognia-github-push-")
        .tempdir()
        .map_err(|e| format!("create trusted push workspace: {e}"))?;
    let staging_path = staging.path().to_path_buf();
    let staging_str = staging_path.to_string_lossy().into_owned();

    // This second clone is a trust boundary, not redundancy: `mirror_worktree`
    // copies the agent's files across but never its `.git`, so the commit and
    // push below run against a repository the agent could not have written to.
    // Committing in the agent's own workspace instead would run whatever it
    // left in `.git/hooks`, and honour whatever it wrote to `.git/config`
    // (`core.sshCommand`, `core.fsmonitor`), while our token is in the
    // environment. On the Issue→PR path the agent's instructions come from an
    // issue body, which anyone can write.
    let mut clone = Command::new("git");
    clone
        .arg("clone")
        .args(clone_args(&remote, &staging_str, base_branch));
    if let Some(token) = args.token.as_deref() {
        apply_git_auth_env(&mut clone, token);
    } else {
        apply_git_isolation_env(&mut clone);
    }
    let output = clone
        .output()
        .await
        .map_err(|e| format!("trusted git clone spawn: {e}"))?;
    if !output.status.success() {
        let stderr = redact_git_credentials(
            &String::from_utf8_lossy(&output.stderr),
            args.token.as_deref(),
        );
        return Err(format!("trusted git clone failed: {stderr}"));
    }

    if base_branch != args.branch {
        run_git_silent(&staging_path, ["checkout", "-b", &args.branch]).await?;
    }
    let source = agent_workspace.clone();
    let destination = staging_path.clone();
    tokio::task::spawn_blocking(move || mirror_worktree(&source, &destination))
        .await
        .map_err(|e| format!("mirror worktree task: {e}"))??;

    let status = run_git_capture(&staging_path, ["status", "--porcelain"]).await?;
    if status.trim().is_empty() {
        return Err("commitAndPush: no changes to commit".to_string());
    }
    run_git_silent(&staging_path, ["add", "."]).await?;
    run_git_silent(&staging_path, ["commit", "-m", &args.message]).await?;

    let refspec = format!("HEAD:refs/heads/{push_branch}");
    run_git_silent_auth(
        &staging_path,
        ["push", &remote, &refspec],
        args.token.as_deref(),
    )
    .await?;

    let head = run_git_capture(&staging_path, ["rev-parse", "HEAD"]).await?;
    Ok(head.trim().to_string())
}

/// Recursive `rm -rf` over the workspace. Returns `true` on success or when
/// the path is already gone; surfaces real errors as `Err` so the TS wrapper
/// can log and demote to `false`, preserving the legacy GC-pass semantics.
#[tauri::command]
pub async fn github_workspace_remove(path: String) -> Result<bool, String> {
    match tokio::fs::remove_dir_all(&path).await {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(format!("removeWorkspace {path}: {e}")),
    }
}

/// Equivalent of the JS `statWorkspace` — `mtimeMs` if the path exists,
/// `{ exists: false }` otherwise. Never throws.
#[tauri::command]
pub async fn github_workspace_stat(path: String) -> Result<StatResult, String> {
    match tokio::fs::metadata(&path).await {
        Err(_) => Ok(StatResult {
            exists: false,
            mtime: None,
        }),
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0);
            Ok(StatResult {
                exists: true,
                mtime,
            })
        }
    }
}

// ---------- helpers ----------

fn sanitize_repo_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// JavaScript-compatible `Number(n).toString(36)` — used so the stamp segment
/// matches what the legacy TS code emitted (a few `.test.ts` callers eyeball
/// the resulting path).
fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let mut buf = Vec::with_capacity(13);
    while n > 0 {
        let r = (n % 36) as u8;
        let c = if r < 10 { b'0' + r } else { b'a' + (r - 10) };
        buf.push(c);
        n /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).expect("base36 alphabet is ASCII")
}

fn unix_millis_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn canonical_github_remote(repo_full_name: &str) -> Result<String, String> {
    let mut segments = repo_full_name.split('/');
    let owner = segments.next().unwrap_or_default();
    let repo = segments.next().unwrap_or_default();
    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if !valid_segment(owner) || !valid_segment(repo) || segments.next().is_some() {
        return Err("invalid GitHub repository identity".to_string());
    }
    Ok(format!("https://github.com/{owner}/{repo}.git"))
}

/// Replace every literal occurrence of the token with `<redacted>` so callers
/// can safely surface git's stderr to renderer logs / audit trails.
fn redact_token(text: &str, token: &str) -> String {
    if token.is_empty() {
        return text.to_string();
    }
    text.replace(token, "<redacted>")
}

fn redact_git_credentials(text: &str, token: Option<&str>) -> String {
    let Some(token) = token.filter(|value| !value.is_empty()) else {
        return text.to_string();
    };
    use base64::Engine as _;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    redact_token(&redact_token(text, token), &basic)
}

fn mirror_worktree(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() || !destination.join(".git").is_dir() {
        return Err("trusted worktree mirror requires source and git destination".to_string());
    }
    for entry in std::fs::read_dir(destination).map_err(|e| format!("read staging: {e}"))? {
        let entry = entry.map_err(|e| format!("read staging entry: {e}"))?;
        if entry.file_name() != ".git" {
            remove_entry(&entry.path())?;
        }
    }
    for entry in std::fs::read_dir(source).map_err(|e| format!("read agent worktree: {e}"))? {
        let entry = entry.map_err(|e| format!("read agent worktree entry: {e}"))?;
        if entry.file_name() != ".git" {
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn remove_entry(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("inspect staging: {e}"))?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| format!("remove staging directory: {e}"))
    } else {
        std::fs::remove_file(path).map_err(|e| format!("remove staging file: {e}"))
    }
}

fn copy_entry(source: &Path, destination: &Path) -> Result<(), String> {
    if source.file_name().is_some_and(|name| name == ".git") {
        return Err("nested git metadata is not allowed in the agent worktree".to_string());
    }
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|e| format!("inspect agent worktree entry: {e}"))?;
    if metadata.file_type().is_symlink() {
        let target =
            std::fs::read_link(source).map_err(|e| format!("read worktree symlink: {e}"))?;
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, destination)
                .map_err(|e| format!("copy worktree symlink: {e}"))?;
            return Ok(());
        }
        #[cfg(not(unix))]
        return Err("worktree symlinks are not supported on this platform".to_string());
    }
    if metadata.is_dir() {
        std::fs::create_dir(destination).map_err(|e| format!("create staging directory: {e}"))?;
        for entry in
            std::fs::read_dir(source).map_err(|e| format!("read worktree directory: {e}"))?
        {
            let entry = entry.map_err(|e| format!("read worktree child: {e}"))?;
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if metadata.is_file() {
        std::fs::copy(source, destination).map_err(|e| format!("copy worktree file: {e}"))?;
        std::fs::set_permissions(destination, metadata.permissions())
            .map_err(|e| format!("set worktree file permissions: {e}"))?;
        return Ok(());
    }
    Err("worktree contains an unsupported special file".to_string())
}

/// Supply the GitHub credential to a single `git` invocation without ever
/// writing it to disk or putting it on the command line.
///
/// `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n` is git's env-based config override:
/// it applies only to this child process, so nothing lands in
/// `<workspace>/.git/config` (which an agent working in the clone can read) and
/// nothing lands in argv (which any process listing can read).
fn apply_git_isolation_env(command: &mut Command) {
    command
        // Host-owned git operations must never execute hooks installed by an
        // issue-controlled agent in the worktree.
        .env("GIT_CONFIG_COUNT", "3")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", "/dev/null")
        .env("GIT_CONFIG_KEY_1", "user.name")
        .env("GIT_CONFIG_VALUE_1", "Cognia")
        .env("GIT_CONFIG_KEY_2", "user.email")
        .env("GIT_CONFIG_VALUE_2", "noreply@cognia.app")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0");
}

fn apply_git_auth_env(command: &mut Command, token: &str) {
    use base64::Engine as _;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    apply_git_isolation_env(command);
    command
        .env("GIT_CONFIG_COUNT", "4")
        .env("GIT_CONFIG_KEY_3", "http.https://github.com/.extraheader")
        .env(
            "GIT_CONFIG_VALUE_3",
            format!("Authorization: Basic {basic}"),
        );
}

async fn run_git_silent<I, S>(cwd: &Path, args: I) -> Result<(), String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    run_git_silent_auth(cwd, args, None).await
}

async fn run_git_silent_auth<I, S>(cwd: &Path, args: I, token: Option<&str>) -> Result<(), String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    if let Some(token) = token {
        apply_git_auth_env(&mut command, token);
    } else {
        apply_git_isolation_env(&mut command);
    }
    let output = command
        .output()
        .await
        .map_err(|e| format!("git spawn: {e}"))?;
    if !output.status.success() {
        let stderr = redact_git_credentials(&String::from_utf8_lossy(&output.stderr), token);
        return Err(format!("git failed: {}", stderr.trim()));
    }
    Ok(())
}

async fn run_git_capture<I, S>(cwd: &Path, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    apply_git_isolation_env(&mut command);
    let output = command
        .output()
        .await
        .map_err(|e| format!("git spawn: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(format!("git failed: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Both clone sites go through one helper so they cannot drift apart, and
    /// neither may go back to a shallow clone: stacked branches rebase past the
    /// boundary a `--depth` clone would impose.
    #[test]
    fn clones_are_partial_and_never_shallow() {
        let args = clone_args("https://github.com/o/r.git", "/tmp/dest", "main");
        assert!(!args.contains(&"--depth"), "shallow breaks rebasing a stack");
        assert!(args.contains(&"--filter=blob:none"));
        assert!(
            args.contains(&"--single-branch"),
            "dropping --depth removed the implied --single-branch"
        );
        assert_eq!(args[0], "https://github.com/o/r.git");
        assert_eq!(args[1], "/tmp/dest");
        assert_eq!(args[3], "main");
    }

    #[test]
    fn sanitize_repo_name_replaces_unsafe_chars() {
        assert_eq!(
            sanitize_repo_name("octocat/hello-world"),
            "octocat_hello-world"
        );
        assert_eq!(sanitize_repo_name("my org/cool repo"), "my_org_cool_repo");
        assert_eq!(sanitize_repo_name("a.b_c-d.123"), "a.b_c-d.123");
        assert_eq!(sanitize_repo_name("foo@bar/baz"), "foo_bar_baz");
    }

    #[test]
    fn base36_matches_js_number_tostring_36() {
        // Reference values pulled from `Number(n).toString(36)` in Node REPL.
        assert_eq!(base36(0), "0");
        assert_eq!(base36(1), "1");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(base36(1234567890), "kf12oi");
        assert_eq!(base36(1_700_000_000_000), "loyw3v28");
    }

    #[test]
    fn redact_token_replaces_all_occurrences() {
        let text = "Cloning from https://x-access-token:abc123@github.com/o/r.git\nabc123 again";
        let cleaned = redact_token(text, "abc123");
        assert!(!cleaned.contains("abc123"));
        assert_eq!(cleaned.matches("<redacted>").count(), 2);
    }

    #[test]
    fn redact_token_is_a_noop_when_token_empty() {
        let text = "literal text";
        assert_eq!(redact_token(text, ""), text);
    }

    #[test]
    fn credential_redaction_removes_raw_and_basic_forms() {
        use base64::Engine as _;
        let token = "ghs_SECRET";
        let basic =
            base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
        let cleaned = redact_git_credentials(
            &format!("token={token} Authorization: Basic {basic}"),
            Some(token),
        );
        assert!(!cleaned.contains(token));
        assert!(!cleaned.contains(&basic));
    }

    #[test]
    fn canonical_remote_rejects_non_repository_input() {
        assert_eq!(
            canonical_github_remote("octocat/hello-world").unwrap(),
            "https://github.com/octocat/hello-world.git"
        );
        for value in ["octocat", "octocat/repo/extra", "../repo", "octocat/repo?x"] {
            assert!(canonical_github_remote(value).is_err(), "accepted {value}");
        }
    }

    #[tokio::test]
    async fn remove_returns_true_for_missing_path() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let ok = github_workspace_remove(missing.to_string_lossy().into_owned())
            .await
            .expect("ok");
        assert!(ok);
    }

    #[tokio::test]
    async fn remove_clears_an_existing_dir() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("ws");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("a.txt"), b"hi").unwrap();
        let ok = github_workspace_remove(target.to_string_lossy().into_owned())
            .await
            .expect("ok");
        assert!(ok);
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn stat_returns_mtime_when_present() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("stat-target");
        fs::create_dir_all(&target).unwrap();
        let s = github_workspace_stat(target.to_string_lossy().into_owned())
            .await
            .expect("ok");
        assert!(s.exists);
        assert!(s.mtime.is_some());
        assert!(s.mtime.unwrap() > 0.0);
    }

    #[tokio::test]
    async fn stat_reports_missing_paths_as_nonexistent() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("absent");
        let s = github_workspace_stat(missing.to_string_lossy().into_owned())
            .await
            .expect("ok");
        assert!(!s.exists);
        assert!(s.mtime.is_none());
    }

    #[test]
    fn git_auth_env_carries_the_credential_out_of_band() {
        // The credential must travel in the child's ENV, never in argv (visible
        // to any process listing) and never in a config file git would persist.
        let mut command = Command::new("git");
        command.arg("push");
        apply_git_auth_env(&mut command, "ghs_SECRET");

        let std_command = command.as_std();
        let argv: Vec<String> = std_command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            !argv.iter().any(|a| a.contains("ghs_SECRET")),
            "token leaked into argv: {argv:?}"
        );

        let envs: std::collections::HashMap<String, String> = std_command
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().into_owned(),
                    v?.to_string_lossy().into_owned(),
                ))
            })
            .collect();
        assert_eq!(envs.get("GIT_CONFIG_COUNT").map(String::as_str), Some("4"));
        assert_eq!(
            envs.get("GIT_CONFIG_KEY_3").map(String::as_str),
            Some("http.https://github.com/.extraheader")
        );
        // base64("x-access-token:ghs_SECRET")
        let expected = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode("x-access-token:ghs_SECRET")
        };
        assert_eq!(
            envs.get("GIT_CONFIG_VALUE_3").map(String::as_str),
            Some(format!("Authorization: Basic {expected}").as_str())
        );
        assert_eq!(
            envs.get("GIT_CONFIG_KEY_0").map(String::as_str),
            Some("core.hooksPath")
        );
        assert_eq!(
            envs.get("GIT_CONFIG_VALUE_0").map(String::as_str),
            Some("/dev/null")
        );
        // A headless run must fail rather than block on a credential prompt.
        assert_eq!(
            envs.get("GIT_TERMINAL_PROMPT").map(String::as_str),
            Some("0")
        );
    }

    #[test]
    fn trusted_mirror_excludes_agent_git_configuration() {
        let source = TempDir::new().unwrap();
        let destination = TempDir::new().unwrap();
        fs::create_dir(source.path().join(".git")).unwrap();
        fs::write(
            source.path().join(".git/config"),
            b"[extensions]\nworktreeConfig=true\n[credential]\nhelper=evil\n[http]\nproxy=evil",
        )
        .unwrap();
        fs::write(
            source.path().join(".git/config.worktree"),
            b"[url \"https://attacker.invalid/\"]\ninsteadOf=https://github.com/",
        )
        .unwrap();
        fs::create_dir(destination.path().join(".git")).unwrap();
        fs::write(destination.path().join(".git/config"), b"trusted").unwrap();
        fs::write(destination.path().join("deleted.txt"), b"old").unwrap();
        fs::create_dir(source.path().join("src")).unwrap();
        fs::write(source.path().join("src/lib.rs"), b"changed").unwrap();

        mirror_worktree(source.path(), destination.path()).unwrap();

        assert_eq!(
            fs::read(destination.path().join(".git/config")).unwrap(),
            b"trusted"
        );
        assert!(!destination.path().join(".git/config.worktree").exists());
        assert_eq!(
            fs::read(destination.path().join("src/lib.rs")).unwrap(),
            b"changed"
        );
        assert!(!destination.path().join("deleted.txt").exists());
    }
}
