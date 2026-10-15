//! `git blame --porcelain` (system git) → per-line authorship.
//!
//! Porcelain output emits each commit's metadata header (author / time /
//! summary) only the FIRST time the commit is seen; later lines of the same
//! commit carry just the SHA header + the `\t`-prefixed content. We cache
//! per-commit metadata so every line resolves its author regardless of order.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::error::Result;
use super::exec;
use super::query_cache::{self, QueryKey};
use super::read::open_repo;
use super::types::GitBlameLine;

/// Blame `path`. With `rev = None` blames the working tree; with a rev (commit,
/// branch, or tag) blames the file as of that revision (commit-pinned blame).
///
/// Cached by resolved commit (ADR-0227 §6). A working-tree blame is cached only
/// while the file is unmodified against HEAD, because only then is it the blame
/// at HEAD; see [`blame_cache_key`].
pub async fn blame(repo_path: &str, path: &str, rev: Option<&str>) -> Result<Vec<GitBlameLine>> {
    // Opening the repository and hashing the file for its status is blocking
    // work; keep it off the runtime thread.
    let (key_repo, key_path, key_rev) = (
        repo_path.to_string(),
        path.to_string(),
        rev.map(str::to_string),
    );
    let key = tokio::task::spawn_blocking(move || {
        blame_cache_key(&key_repo, &key_path, key_rev.as_deref())
    })
    .await
    .ok()
    .flatten();
    if let Some(hit) = key.as_ref().and_then(query_cache::cached_blame) {
        return Ok(hit.as_ref().clone());
    }
    let mut args: Vec<&str> = vec!["blame", "--porcelain"];
    if let Some(r) = rev {
        args.push(r);
    }
    args.push("--");
    args.push(path);
    let out = exec::capture(&std::path::PathBuf::from(repo_path), args).await?;
    let lines = parse_porcelain(&out);
    if let Some(key) = key {
        query_cache::store_blame(key, Arc::new(lines.clone()));
    }
    Ok(lines)
}

/// The immutable key for a blame, or `None` when the answer is not a function
/// of a commit: a modified, untracked or unresolvable file, or a path outside
/// the work tree. Blocking: [`blame`] runs it on the blocking pool.
fn blame_cache_key(repo_path: &str, path: &str, rev: Option<&str>) -> Option<QueryKey> {
    let repo = open_repo(repo_path).ok()?;
    let workdir = repo.workdir()?.canonicalize().ok()?;
    let absolute = canonical_target(Path::new(repo_path), path)?;
    let relative = absolute.strip_prefix(&workdir).ok()?;
    let relative_text = relative.to_str()?.replace('\\', "/");
    let commit = match rev {
        Some(rev) => repo.revparse_single(rev).ok()?.peel_to_commit().ok()?.id(),
        None => {
            let status = repo.status_file(relative).ok()?;
            if !status.is_empty() {
                return None;
            }
            repo.head().ok()?.target()?
        }
    };
    Some(QueryKey::Blame {
        common_dir: query_cache::common_dir_of(&repo),
        commit: commit.to_string(),
        path: relative_text,
    })
}

/// `path` as git resolves it from `repo_path`, canonicalized through its parent
/// so a file deleted from the work tree (blamed at a rev) still resolves.
fn canonical_target(repo_path: &Path, path: &str) -> Option<PathBuf> {
    let joined = repo_path.join(path);
    if let Ok(found) = joined.canonicalize() {
        return Some(found);
    }
    let parent = joined.parent()?.canonicalize().ok()?;
    Some(parent.join(joined.file_name()?))
}

#[derive(Default, Clone)]
struct CommitMeta {
    author: String,
    time_secs: i64,
    summary: String,
}

fn is_sha_header(line: &str) -> Option<(String, u32)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }
    let sha = parts[0];
    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    // parts[1] = original line, parts[2] = final line (1-based).
    let final_line = parts[2].parse::<u32>().ok()?;
    parts[1].parse::<u32>().ok()?;
    Some((sha.to_string(), final_line))
}

fn parse_porcelain(text: &str) -> Vec<GitBlameLine> {
    let mut out: Vec<GitBlameLine> = Vec::new();
    let mut meta: HashMap<String, CommitMeta> = HashMap::new();

    let mut cur_hash = String::new();
    let mut cur_line = 0u32;
    let mut pending = CommitMeta::default();
    let mut have_pending = false;

    for line in text.lines() {
        if let Some(stripped) = line.strip_prefix('\t') {
            // Content line — flush any freshly-parsed header into the cache.
            if have_pending {
                meta.insert(cur_hash.clone(), pending.clone());
                pending = CommitMeta::default();
                have_pending = false;
            }
            let m = meta.get(&cur_hash).cloned().unwrap_or_default();
            let short_hash: String = cur_hash.chars().take(7).collect();
            out.push(GitBlameLine {
                line_number: cur_line,
                commit_hash: cur_hash.clone(),
                short_hash,
                author_name: m.author,
                authored_at_ms: m.time_secs.saturating_mul(1_000),
                summary: m.summary,
                content: stripped.to_string(),
            });
            continue;
        }

        if let Some((sha, final_line)) = is_sha_header(line) {
            cur_hash = sha;
            cur_line = final_line;
            pending = CommitMeta::default();
            have_pending = false;
            continue;
        }

        if let Some(rest) = line.strip_prefix("author ") {
            pending.author = rest.to_string();
            have_pending = true;
        } else if let Some(rest) = line.strip_prefix("author-time ") {
            pending.time_secs = rest.trim().parse().unwrap_or(0);
            have_pending = true;
        } else if let Some(rest) = line.strip_prefix("summary ") {
            pending.summary = rest.to_string();
            have_pending = true;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Two lines from commit A, one from commit B; B's header omits nothing
    // because it's first seen, A's second line carries no header (cached).
    const PORCELAIN: &str = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2
author Alice
author-mail <alice@e.com>
author-time 1000
author-tz +0000
summary first commit
filename a.txt
\tline one
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2
\tline two
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 3 3 1
author Bob
author-mail <bob@e.com>
author-time 2000
author-tz +0000
summary second commit
filename a.txt
\tline three
";

    #[test]
    fn parses_each_line_with_cached_author() {
        let lines = parse_porcelain(PORCELAIN);
        assert_eq!(lines.len(), 3);

        assert_eq!(lines[0].line_number, 1);
        assert_eq!(lines[0].author_name, "Alice");
        assert_eq!(lines[0].summary, "first commit");
        assert_eq!(lines[0].authored_at_ms, 1_000_000);
        assert_eq!(lines[0].content, "line one");
        assert_eq!(lines[0].short_hash, "aaaaaaa");

        // Second line reuses commit A's cached metadata (no header repeated).
        assert_eq!(lines[1].line_number, 2);
        assert_eq!(lines[1].author_name, "Alice");
        assert_eq!(lines[1].content, "line two");

        assert_eq!(lines[2].line_number, 3);
        assert_eq!(lines[2].author_name, "Bob");
        assert_eq!(lines[2].content, "line three");
        assert_eq!(lines[2].authored_at_ms, 2_000_000);
    }

    #[test]
    fn ignores_garbage_and_empty() {
        assert!(parse_porcelain("").is_empty());
        assert!(parse_porcelain("not a blame\njust text").is_empty());
    }

    fn sh(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@e.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@e.com")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn repo_with_file() -> tempfile::TempDir {
        let tmp = tempfile::TempDir::new().unwrap();
        sh(tmp.path(), &["init", "-q"]);
        std::fs::write(tmp.path().join("a.txt"), "one\ntwo\n").unwrap();
        sh(tmp.path(), &["add", "a.txt"]);
        sh(tmp.path(), &["commit", "-q", "-m", "first"]);
        tmp
    }

    #[test]
    fn a_clean_file_keys_on_head_and_a_modified_file_is_never_cached() {
        let tmp = repo_with_file();
        let root = tmp.path().to_str().unwrap();
        let clean = blame_cache_key(root, "a.txt", None).expect("clean file is cacheable");
        let pinned = blame_cache_key(root, "a.txt", Some("HEAD")).expect("rev is cacheable");
        // Working-tree blame of an unmodified file IS the blame at HEAD.
        assert_eq!(clean, pinned);

        std::fs::write(tmp.path().join("a.txt"), "one\nchanged\n").unwrap();
        assert!(blame_cache_key(root, "a.txt", None).is_none());
        assert!(blame_cache_key(root, "a.txt", Some("HEAD")).is_some());
        std::fs::write(tmp.path().join("new.txt"), "x\n").unwrap();
        assert!(blame_cache_key(root, "new.txt", None).is_none());
        assert!(blame_cache_key(root, "../outside.txt", Some("HEAD")).is_none());
    }

    #[tokio::test]
    async fn blame_reflects_an_edit_after_a_cached_answer() {
        let tmp = repo_with_file();
        let root = tmp.path().to_str().unwrap().to_string();
        let first = blame(&root, "a.txt", None).await.unwrap();
        assert_eq!(first[1].content, "two");
        let again = blame(&root, "a.txt", None).await.unwrap();
        assert_eq!(again, first);

        std::fs::write(tmp.path().join("a.txt"), "one\nedited\n").unwrap();
        let edited = blame(&root, "a.txt", None).await.unwrap();
        assert_eq!(edited[1].content, "edited");
        assert_eq!(edited[1].commit_hash, "0".repeat(40), "uncommitted line");
    }

    #[test]
    fn linked_worktrees_share_one_key() {
        let tmp = repo_with_file();
        let linked = tmp.path().join("linked");
        sh(
            tmp.path(),
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                linked.to_str().unwrap(),
            ],
        );
        let main_key = blame_cache_key(tmp.path().to_str().unwrap(), "a.txt", None).unwrap();
        let linked_key = blame_cache_key(linked.to_str().unwrap(), "a.txt", None).unwrap();
        assert_eq!(main_key, linked_key);
    }

    #[test]
    fn detects_sha_header() {
        assert!(is_sha_header("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2").is_some());
        assert!(is_sha_header("author Alice").is_none());
        assert!(is_sha_header("summary x").is_none());
    }
}
