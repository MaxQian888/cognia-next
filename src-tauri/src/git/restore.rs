//! `git restore` (system git) — restore working-tree files (and optionally the
//! index) from HEAD or another source. Shells out so the operation matches the
//! user's terminal exactly.

use super::error::Result;
use super::exec;

/// `git restore [--staged] [--source <source>] -- <paths…>`.
///
/// With `staged = true` the index is restored (unstage); otherwise the working
/// tree is restored. `source` overrides the restore source (default: HEAD for
/// the index, the index for the working tree).
pub async fn restore(
    repo_path: &str,
    paths: &[String],
    staged: bool,
    source: Option<&str>,
) -> Result<()> {
    let mut args = vec!["restore".to_string()];
    if staged {
        args.push("--staged".into());
    }
    if let Some(s) = source {
        args.push("--source".into());
        args.push(s.to_string());
    }
    args.push("--".into());
    for p in paths {
        args.push(p.clone());
    }
    exec::run(&std::path::PathBuf::from(repo_path), args).await
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn git(cwd: &std::path::Path, args: &[&str]) {
        std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
    }

    #[tokio::test]
    async fn restore_working_tree_reverts_uncommitted_edit() {
        if !git_on_path() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        // Pin autocrlf so the checked-out content stays LF on Windows dev boxes
        // (a global core.autocrlf=true would rewrite the restored file to CRLF).
        git(p, &["config", "core.autocrlf", "false"]);
        fs::write(p.join("a.txt"), "committed\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "c1"]);
        fs::write(p.join("a.txt"), "dirty\n").unwrap();

        let rp = p.to_string_lossy().into_owned();
        restore(&rp, &["a.txt".to_string()], false, None).await.unwrap();
        assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "committed\n");
    }
}
