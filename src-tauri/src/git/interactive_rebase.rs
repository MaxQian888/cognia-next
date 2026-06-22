//! Interactive rebase (system git): list the commits in `base..HEAD`, then run
//! `git rebase -i <base>` with a generated todo plan.
//!
//! Mechanism (the decided approach): we never open a real editor. Two generated
//! shell scripts are wired in per-command:
//!   - `GIT_SEQUENCE_EDITOR` overwrites git's todo file with our plan
//!     (pick/reword/squash/fixup/drop, already reordered).
//!   - `GIT_EDITOR` pops a queue of editor responses in todo order — a reworded
//!     message file for `reword`, "accept the default" for `squash`. `pick`,
//!     `fixup`, and `drop` never open an editor.
//!
//! Scripts use forward-slash paths so Git-for-Windows' bundled `sh` accepts
//! them. A conflict leaves the rebase in progress; the renderer's in-progress
//! banner then drives continue/abort (shared with the sequencer ops).

use git2::Sort;

use super::error::{GitError, Result};
use super::exec;
use super::read::open_repo;
use super::types::{GitCommit, RebaseAction, RebaseTodoEntry};

fn to_record(commit: &git2::Commit<'_>) -> GitCommit {
    let hash = commit.id().to_string();
    let short_hash = hash.chars().take(7).collect();
    let author = commit.author();
    GitCommit {
        hash,
        short_hash,
        summary: commit.summary().unwrap_or_default().to_string(),
        body: commit.body().unwrap_or_default().trim().to_string(),
        author_name: author.name().unwrap_or_default().to_string(),
        author_email: author.email().unwrap_or_default().to_string(),
        authored_at_ms: author.when().seconds().saturating_mul(1_000),
        parents: commit.parent_ids().map(|o| o.to_string()).collect(),
    }
}

/// List commits in `base..HEAD`, oldest first (the order the rebase todo uses).
pub fn list_commits(repo_path: &str, base: &str) -> Result<Vec<GitCommit>> {
    let repo = open_repo(repo_path)?;
    let base_oid = repo
        .revparse_single(base)
        .map_err(|_| GitError::InvalidArgument(format!("invalid base ref: {base}")))?
        .id();
    let head = repo.head()?.peel_to_commit()?.id();

    let mut walker = repo.revwalk()?;
    // Topological (ancestry) order, oldest first — the order a rebase todo must
    // use. NOT time order: sibling commits can share a timestamp, making TIME
    // ordering ambiguous and wrong for a rebase plan.
    walker.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE)?;
    walker.push(head)?;
    walker.hide(base_oid)?;

    let mut out = Vec::new();
    for oid in walker {
        let commit = repo.find_commit(oid?)?;
        out.push(to_record(&commit));
    }
    Ok(out)
}

fn verb(action: RebaseAction) -> &'static str {
    match action {
        RebaseAction::Pick => "pick",
        RebaseAction::Reword => "reword",
        RebaseAction::Squash => "squash",
        RebaseAction::Fixup => "fixup",
        RebaseAction::Drop => "drop",
    }
}

fn fwd(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Build the todo file body from the (already-ordered) plan.
pub fn build_todo(entries: &[RebaseTodoEntry]) -> String {
    let mut todo = String::new();
    for e in entries {
        todo.push_str(verb(e.action));
        todo.push(' ');
        todo.push_str(&e.sha);
        todo.push('\n');
    }
    todo
}

/// Run the interactive rebase described by `entries` onto `base`.
pub async fn run(repo_path: &str, base: &str, entries: &[RebaseTodoEntry]) -> Result<()> {
    if entries.is_empty() {
        return Err(GitError::InvalidArgument("empty rebase plan".into()));
    }
    let cwd = std::path::PathBuf::from(repo_path);

    // Per-invocation scratch dir. Keyed by pid + a process-wide atomic counter
    // so concurrent invocations (e.g. parallel tests) never share a dir.
    static SCRATCH_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SCRATCH_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("cognia-irebase-{}-{}", std::process::id(), seq));
    std::fs::create_dir_all(&dir)
        .map_err(|e| GitError::CommandFailed(format!("irebase scratch dir: {e}")))?;

    let result = run_in_dir(&cwd, base, entries, &dir).await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

async fn run_in_dir(
    cwd: &std::path::Path,
    base: &str,
    entries: &[RebaseTodoEntry],
    dir: &std::path::Path,
) -> Result<()> {
    let write = |name: &str, content: &str| -> Result<std::path::PathBuf> {
        let p = dir.join(name);
        std::fs::write(&p, content)
            .map_err(|e| GitError::CommandFailed(format!("irebase {name}: {e}")))?;
        Ok(p)
    };

    let todo_path = write("todo.txt", &build_todo(entries))?;

    // Editor queue: one line per editor invocation, in todo order. `reword` →
    // path to its message file; `squash` → "skip" (accept git's combined
    // default). pick/fixup/drop never invoke the editor.
    let mut queue = String::new();
    let mut reword_idx = 0usize;
    for e in entries {
        match e.action {
            RebaseAction::Reword => {
                let msg_path = write(
                    &format!("msg-{reword_idx}"),
                    e.message.as_deref().unwrap_or_default(),
                )?;
                queue.push_str(&fwd(&msg_path));
                queue.push('\n');
                reword_idx += 1;
            }
            RebaseAction::Squash => queue.push_str("skip\n"),
            _ => {}
        }
    }
    let queue_path = write("queue.txt", &queue)?;
    let idx_path = dir.join("idx");

    let seq_script = format!("#!/bin/sh\ncat '{}' > \"$1\"\n", fwd(&todo_path));
    let seq_path = write("seq-editor.sh", &seq_script)?;

    let editor_script = format!(
        "#!/bin/sh\nq='{}'\ni='{}'\nn=$(cat \"$i\" 2>/dev/null || echo 0)\nline=$(sed -n \"$((n+1))p\" \"$q\")\necho $((n+1)) > \"$i\"\nif [ -n \"$line\" ] && [ \"$line\" != \"skip\" ]; then\n  cat \"$line\" > \"$1\"\nfi\n",
        fwd(&queue_path),
        fwd(&idx_path),
    );
    let editor_path = write("editor.sh", &editor_script)?;

    let seq_env = format!("sh '{}'", fwd(&seq_path));
    let editor_env = format!("sh '{}'", fwd(&editor_path));

    exec::run_with_env(
        cwd,
        ["rebase", "-i", base],
        &[
            ("GIT_SEQUENCE_EDITOR", seq_env.as_str()),
            ("GIT_EDITOR", editor_env.as_str()),
        ],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(sha: &str, action: RebaseAction) -> RebaseTodoEntry {
        RebaseTodoEntry {
            sha: sha.to_string(),
            action,
            message: None,
        }
    }

    #[test]
    fn build_todo_emits_verbs_in_order() {
        let todo = build_todo(&[
            entry("aaa", RebaseAction::Pick),
            entry("bbb", RebaseAction::Drop),
            entry("ccc", RebaseAction::Squash),
        ]);
        assert_eq!(todo, "pick aaa\ndrop bbb\nsquash ccc\n");
    }

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

    fn head_count(p: &std::path::Path) -> usize {
        let out = std::process::Command::new("git")
            .args(["rev-list", "--count", "HEAD"])
            .current_dir(p)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
    }

    #[tokio::test]
    async fn empty_plan_errors() {
        let err = run("/nonexistent", "HEAD~1", &[]).await.unwrap_err();
        assert!(matches!(err, GitError::InvalidArgument(_)));
    }

    #[tokio::test]
    async fn drop_and_reorder_rewrites_history() {
        if !git_on_path() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        git(p, &["config", "core.autocrlf", "false"]);
        for i in 0..4 {
            std::fs::write(p.join(format!("f{i}.txt")), format!("{i}\n")).unwrap();
            git(p, &["add", "."]);
            git(p, &["commit", "-q", "-m", &format!("c{i}")]);
        }
        let rp = p.to_string_lossy().into_owned();
        // base = first commit; commits c1,c2,c3 are rebaseable.
        let base_sha = String::from_utf8(
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD~3"])
                .current_dir(p)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let commits = list_commits(&rp, base_sha.trim()).unwrap();
        assert_eq!(commits.len(), 3);
        assert_eq!(commits[0].summary, "c1"); // oldest first

        // Drop c2, keep c1 and c3.
        let plan = vec![
            entry(&commits[0].hash, RebaseAction::Pick),
            entry(&commits[1].hash, RebaseAction::Drop),
            entry(&commits[2].hash, RebaseAction::Pick),
        ];
        run(&rp, base_sha.trim(), &plan).await.unwrap();
        // 4 commits -> dropped one -> 3.
        assert_eq!(head_count(p), 3);
        assert!(!p.join("f2.txt").exists());
        assert!(p.join("f3.txt").exists());
    }

    #[tokio::test]
    async fn reword_changes_the_message() {
        if !git_on_path() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let p = tmp.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@e.com"]);
        git(p, &["config", "user.name", "T"]);
        git(p, &["config", "core.autocrlf", "false"]);
        std::fs::write(p.join("a.txt"), "base\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "base"]);
        std::fs::write(p.join("b.txt"), "b\n").unwrap();
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", "old message"]);

        let rp = p.to_string_lossy().into_owned();
        let commits = list_commits(&rp, "HEAD~1").unwrap();
        assert_eq!(commits.len(), 1);
        let plan = vec![RebaseTodoEntry {
            sha: commits[0].hash.clone(),
            action: RebaseAction::Reword,
            message: Some("brand new message".to_string()),
        }];
        run(&rp, "HEAD~1", &plan).await.unwrap();
        let subject = String::from_utf8(
            std::process::Command::new("git")
                .args(["log", "-1", "--format=%s"])
                .current_dir(p)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        assert_eq!(subject.trim(), "brand new message");
    }
}
