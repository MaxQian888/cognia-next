//! Git workspace operations for the GitHub Delivery plugin's `local` backend.
//!
//! Previously `lib/github/workspace.ts` shelled out to Node's `simple-git`
//! which pulled `node:fs/promises` / `node:child_process` into the static
//! browser graph through `lib/plugin/core/browser-builtin-registry.ts`.
//! That broke the Next.js bundle once the `NODE_ONLY_MODULES` aliases were
//! deleted from `next.config.ts`. Moving the local backend into Rust here
//! keeps the renderer free of Node built-ins; the github-delivery plugin
//! reaches us via Tauri `invoke()`.
//!
//! We shell out to the user's system `git` for clone/push (same model
//! simple-git used) instead of pulling libgit2's `https` + `openssl-sys`
//! features. The github-delivery feature has always required a working
//! `git` on PATH, so this doesn't add a new prerequisite.

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

/// Allocate a worktree under `<base_dir>/<sanitized-repo>/<base36-stamp>` and
/// shallow-clone the requested branch into it. Returns the absolute path and
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
    let remote = format!("https://github.com/{}.git", args.repo_full_name);

    let mut command = Command::new("git");
    command
        .args([
            "clone",
            &remote,
            &path_str,
            "--branch",
            &args.branch,
            "--depth",
            "20",
        ])
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
        let stderr = redact_token(&String::from_utf8_lossy(&output.stderr), &args.token);
        return Err(format!("git clone failed: {stderr}"));
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
    let workspace = PathBuf::from(&args.workspace_path);
    let workspace_str = workspace.to_string_lossy().into_owned();

    let status = run_git_capture(&workspace, ["status", "--porcelain"]).await?;
    if status.trim().is_empty() {
        return Err("commitAndPush: no changes to commit".to_string());
    }

    run_git_silent(&workspace, ["add", "."]).await?;
    run_git_silent(&workspace, ["commit", "-m", &args.message]).await?;

    let push_branch = args.remote_branch.as_deref().unwrap_or(&args.branch);
    run_git_silent_auth(
        &workspace,
        ["push", "origin", push_branch, "--set-upstream"],
        args.token.as_deref(),
    )
    .await?;

    let head = run_git_capture(&workspace, ["rev-parse", "HEAD"]).await?;
    let _ = workspace_str; // suppress unused-warning when feature-flagged off
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

/// Replace every literal occurrence of the token with `<redacted>` so callers
/// can safely surface git's stderr to renderer logs / audit trails.
fn redact_token(text: &str, token: &str) -> String {
    if token.is_empty() {
        return text.to_string();
    }
    text.replace(token, "<redacted>")
}

/// Supply the GitHub credential to a single `git` invocation without ever
/// writing it to disk or putting it on the command line.
///
/// `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n` is git's env-based config override:
/// it applies only to this child process, so nothing lands in
/// `<workspace>/.git/config` (which an agent working in the clone can read) and
/// nothing lands in argv (which any process listing can read).
fn apply_git_auth_env(command: &mut Command, token: &str) {
    use base64::Engine as _;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    command
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.extraheader")
        .env("GIT_CONFIG_VALUE_0", format!("Authorization: Basic {basic}"))
        // Never let git fall back to an interactive credential prompt: in a
        // headless workflow that would hang the run instead of failing it.
        .env("GIT_TERMINAL_PROMPT", "0");
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
    }
    let output = command
        .output()
        .await
        .map_err(|e| format!("git spawn: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(format!("git failed: {}", stderr.trim()));
    }
    Ok(())
}

async fn run_git_capture<I, S>(cwd: &Path, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
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

    fn git_on_path() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
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
        assert_eq!(envs.get("GIT_CONFIG_COUNT").map(String::as_str), Some("1"));
        assert_eq!(
            envs.get("GIT_CONFIG_KEY_0").map(String::as_str),
            Some("http.extraheader")
        );
        // base64("x-access-token:ghs_SECRET")
        let expected = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode("x-access-token:ghs_SECRET")
        };
        assert_eq!(
            envs.get("GIT_CONFIG_VALUE_0").map(String::as_str),
            Some(format!("Authorization: Basic {expected}").as_str())
        );
        // A headless run must fail rather than block on a credential prompt.
        assert_eq!(
            envs.get("GIT_TERMINAL_PROMPT").map(String::as_str),
            Some("0")
        );
    }

    #[tokio::test]
    async fn commit_and_push_rejects_when_no_changes() {
        // Skip the test if `git` isn't on PATH — environment-conditional so the
        // suite still passes on minimal CI images without a git install.
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path();
        // Initialize a repo with one committed file so HEAD exists and the
        // working tree is clean.
        let init = std::process::Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(repo)
            .status()
            .unwrap();
        assert!(init.success(), "git init failed");
        std::process::Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(repo)
            .status()
            .unwrap();
        std::process::Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(repo)
            .status()
            .unwrap();
        fs::write(repo.join("README"), b"hi").unwrap();
        std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(repo)
            .status()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-q", "-m", "init"])
            .current_dir(repo)
            .status()
            .unwrap();

        let err = github_workspace_commit_and_push(CommitAndPushArgs {
            workspace_path: repo.to_string_lossy().into_owned(),
            branch: "main".into(),
            message: "noop".into(),
            remote_branch: None,
            token: None,
        })
        .await
        .expect_err("should error on clean tree");
        assert!(
            err.contains("no changes to commit"),
            "unexpected error: {err}"
        );
    }
}
