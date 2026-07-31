//! Stage / unstage / discard — file-level and hunk-level.
//!
//! All routed through system `git` (not git2's index API) so gitattributes
//! filters, CRLF renormalization, and `assume-unchanged` behave exactly like
//! the CLI — matching what VSCode does. Hunk operations feed a self-contained
//! patch (built in `diff.rs`) to `git apply --cached`.

use std::path::{Path, PathBuf};

use super::error::Result;
use super::exec;

/// Apply flags shared by every hunk operation. `--unidiff-zero` lets
/// zero-context hunks apply without fuzz; `--whitespace=nowarn` keeps CRLF
/// diffs from being rejected as whitespace errors.
const APPLY_FLAGS: [&str; 2] = ["--whitespace=nowarn", "--unidiff-zero"];

fn root(repo_path: &str) -> PathBuf {
    PathBuf::from(repo_path)
}

/// `git add -- <paths>` — stages adds, modifications, and deletions.
pub async fn stage(repo_path: &str, paths: &[String]) -> Result<()> {
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    exec::run(&root(repo_path), args).await
}

/// `git reset -q HEAD -- <paths>`, falling back to `rm --cached` on an unborn
/// HEAD (a repo with no commits yet can't `reset HEAD`).
pub async fn unstage(repo_path: &str, paths: &[String]) -> Result<()> {
    let cwd = root(repo_path);
    let mut args = vec![
        "reset".to_string(),
        "-q".to_string(),
        "HEAD".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().cloned());
    let reset_err = match exec::run(&cwd, args).await {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    // `reset HEAD` failed. Only an unborn HEAD (no commit yet) justifies the
    // index-drop fallback below; any other failure (lock held, bad path) must
    // surface instead of being masked by the `rm`. `rev-parse --verify HEAD`
    // succeeds iff HEAD resolves to a commit.
    if exec::run(&cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])
        .await
        .is_ok()
    {
        return Err(reset_err);
    }
    // Unborn HEAD: drop entries from the index instead.
    let mut rm = vec![
        "rm".to_string(),
        "-r".to_string(),
        "--cached".to_string(),
        "-q".to_string(),
        "--".to_string(),
    ];
    rm.extend(paths.iter().cloned());
    exec::run(&cwd, rm).await
}

/// Discard working-tree changes: tracked paths are restored from the index;
/// untracked paths are deleted from disk.
pub async fn discard(repo_path: &str, paths: &[String]) -> Result<()> {
    let cwd = root(repo_path);
    for path in paths {
        if is_tracked(&cwd, path).await {
            exec::run(&cwd, ["checkout", "--", path]).await?;
        } else {
            remove_path(&cwd.join(path)).await;
        }
    }
    Ok(())
}

/// Discard *all* working-tree changes. `include_untracked` also runs
/// `git clean -fd` to remove untracked files and directories.
pub async fn discard_all(repo_path: &str, include_untracked: bool) -> Result<()> {
    let cwd = root(repo_path);
    exec::run(&cwd, ["checkout", "--", "."]).await?;
    if include_untracked {
        exec::run(&cwd, ["clean", "-fd"]).await?;
    }
    Ok(())
}

/// Stage a single hunk: `git apply --cached` reading the patch from stdin.
pub async fn stage_hunk(repo_path: &str, patch: &str) -> Result<()> {
    let mut args = vec!["apply", "--cached"];
    args.extend(APPLY_FLAGS);
    exec::run_with_stdin(&root(repo_path), args, patch).await
}

/// Unstage a single hunk: reverse-apply against the index.
pub async fn unstage_hunk(repo_path: &str, patch: &str) -> Result<()> {
    let mut args = vec!["apply", "--cached", "--reverse"];
    args.extend(APPLY_FLAGS);
    exec::run_with_stdin(&root(repo_path), args, patch).await
}

/// Discard a single hunk: reverse-apply against the working tree.
pub async fn discard_hunk(repo_path: &str, patch: &str) -> Result<()> {
    let mut args = vec!["apply", "--reverse"];
    args.extend(APPLY_FLAGS);
    exec::run_with_stdin(&root(repo_path), args, patch).await
}

async fn is_tracked(cwd: &Path, path: &str) -> bool {
    exec::run(cwd, ["ls-files", "--error-unmatch", "--", path])
        .await
        .is_ok()
}

async fn remove_path(full: &Path) {
    if full.is_dir() {
        let _ = tokio::fs::remove_dir_all(full).await;
    } else {
        let _ = tokio::fs::remove_file(full).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use tempfile::TempDir;

    fn git_on_path() -> bool {
        Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    }

    fn git(cwd: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn init_repo() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        // Pin line-ending handling so content round-trips byte-exact
        // regardless of the developer's global `core.autocrlf` (true on some
        // Windows machines), which would otherwise rewrite "\n" → "\r\n" on
        // checkout/discard and break the byte-exact assertions below.
        git(p, &["config", "core.autocrlf", "false"]);
        std::fs::write(p.join("a.txt"), "line1\nline2\nline3\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "init"]);
        tmp
    }

    fn staged_names(cwd: &Path) -> String {
        let out = Command::new("git")
            .args(["diff", "--cached", "--name-only"])
            .current_dir(cwd)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[tokio::test]
    async fn stage_then_unstage_a_file() {
        if !git_on_path() {
            return;
        }
        let tmp = init_repo();
        let rp = tmp.path().to_string_lossy().into_owned();
        std::fs::write(tmp.path().join("a.txt"), "changed\n").unwrap();

        stage(&rp, &["a.txt".into()]).await.unwrap();
        assert!(staged_names(tmp.path()).contains("a.txt"));

        unstage(&rp, &["a.txt".into()]).await.unwrap();
        assert!(!staged_names(tmp.path()).contains("a.txt"));
    }

    #[tokio::test]
    async fn unstage_on_unborn_head_drops_from_index() {
        if !git_on_path() {
            return;
        }
        // Repo with no commit yet: HEAD is unborn, so `reset HEAD` can't run and
        // unstage must fall back to dropping the index entry.
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        std::fs::write(p.join("a.txt"), "x\n").unwrap();
        let rp = p.to_string_lossy().into_owned();

        stage(&rp, &["a.txt".into()]).await.unwrap();
        assert!(staged_names(p).contains("a.txt"));
        unstage(&rp, &["a.txt".into()]).await.unwrap();
        assert!(!staged_names(p).contains("a.txt"));
    }

    #[tokio::test]
    async fn discard_restores_tracked_file() {
        if !git_on_path() {
            return;
        }
        let tmp = init_repo();
        let rp = tmp.path().to_string_lossy().into_owned();
        std::fs::write(tmp.path().join("a.txt"), "totally different\n").unwrap();
        discard(&rp, &["a.txt".into()]).await.unwrap();
        let restored = std::fs::read_to_string(tmp.path().join("a.txt")).unwrap();
        assert_eq!(restored, "line1\nline2\nline3\n");
    }

    #[tokio::test]
    async fn discard_deletes_untracked_file() {
        if !git_on_path() {
            return;
        }
        let tmp = init_repo();
        let rp = tmp.path().to_string_lossy().into_owned();
        let extra = tmp.path().join("extra.txt");
        std::fs::write(&extra, "junk\n").unwrap();
        discard(&rp, &["extra.txt".into()]).await.unwrap();
        assert!(!extra.exists());
    }

    #[tokio::test]
    async fn stage_hunk_applies_patch_to_index() {
        if !git_on_path() {
            return;
        }
        let tmp = init_repo();
        let rp = tmp.path().to_string_lossy().into_owned();
        std::fs::write(tmp.path().join("a.txt"), "line1\nCHANGED\nline3\n").unwrap();

        // Build the working-tree diff via our own diff module.
        let d = super::super::diff::file_diff(&rp, "a.txt", false).unwrap();
        assert_eq!(d.hunks.len(), 1);
        stage_hunk(&rp, &d.hunks[0].patch).await.unwrap();
        assert!(staged_names(tmp.path()).contains("a.txt"));
    }
}
