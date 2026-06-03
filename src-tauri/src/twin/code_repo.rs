//! Twin code-repo importer — walks recent commits in a local Git repository
//! and returns one [`CommitRecord`] per commit. The renderer-side
//! `parseGitRepo` (lib/twin/importers/code-repo/git-repo.ts) maps each record
//! into a `RawSource` for the ingest pipeline.
//!
//! Replaces the previous renderer-side `simple-git` integration so the Next.js
//! bundle no longer needs the `NODE_ONLY_MODULES` / `SERVER_ONLY_PACKAGES`
//! shim in `next.config.ts`. libgit2 runs entirely in the Tauri main process.

use std::str;

use git2::{
    Commit, Diff, DiffFormat, DiffOptions, DiffStatsFormat, Oid, Repository, Sort, Tree,
};
use serde::{Deserialize, Serialize};

/// Maximum bytes of diff text we keep per commit. Matches the renderer-side
/// cap from the old `simple-git` path (8 KB) so the downstream chunker sees
/// the same input sizes.
const DIFF_BYTE_CAP: usize = 8 * 1024;

/// Default unified-context lines around each diff hunk — matches
/// `git show --unified=2` from the previous JS implementation.
const DIFF_CONTEXT_LINES: u32 = 2;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseGitRepoArgs {
    /// Filesystem path to the repository root.
    pub repo_path: String,
    /// Maximum commits to walk back, newest first. Defaults applied client-side.
    pub max_commits: usize,
    /// Optional author filter — case-insensitive substring match against
    /// `"{name} {email}"`. Mirrors the JS importer's filter semantics.
    #[serde(default)]
    pub author: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitRecord {
    pub hash: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub email: String,
    /// Author time in milliseconds since the Unix epoch.
    pub timestamp_ms: i64,
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
    /// `--stat` summary followed by the unified patch, truncated to
    /// [`DIFF_BYTE_CAP`] bytes with a trailing `…(diff truncated)` marker.
    pub diff: String,
}

/// Tauri command surface. Heavy lifting runs on a blocking thread because
/// libgit2 is sync; we don't want to wedge the tokio reactor on a 500-commit
/// walk.
#[tauri::command]
pub async fn twin_parse_git_repo(
    args: ParseGitRepoArgs,
) -> Result<Vec<CommitRecord>, String> {
    tokio::task::spawn_blocking(move || parse_repo_blocking(args))
        .await
        .map_err(|err| format!("twin_parse_git_repo task panicked: {err}"))?
}

fn parse_repo_blocking(args: ParseGitRepoArgs) -> Result<Vec<CommitRecord>, String> {
    let repo = Repository::open(&args.repo_path)
        .map_err(|err| format!("open repository at {}: {err}", args.repo_path))?;

    let mut walker = repo
        .revwalk()
        .map_err(|err| format!("create revwalk: {err}"))?;
    // Newest-first traversal mirrors `git log` / `simple-git`'s default
    // (`--date-order`): topological ordering — a commit always precedes its
    // parents — with same-generation commits broken by commit time. Plain
    // `Sort::TIME` is insufficient: a back-dated commit (rebase, cherry-pick,
    // amend with an older author/committer date) would otherwise sort *after*
    // a parent that carries a newer timestamp, which `git log` never does.
    walker
        .set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(|err| format!("set revwalk sort: {err}"))?;
    walker
        .push_head()
        .map_err(|err| format!("push HEAD onto revwalk: {err}"))?;

    let author_filter = args.author.as_deref().map(str::to_lowercase);
    let mut records = Vec::new();

    for oid_result in walker {
        if records.len() >= args.max_commits {
            break;
        }
        let oid: Oid = match oid_result {
            Ok(oid) => oid,
            Err(err) => return Err(format!("walk commit: {err}")),
        };
        let commit = repo
            .find_commit(oid)
            .map_err(|err| format!("find commit {oid}: {err}"))?;

        let author_sig = commit.author();
        let author_name = author_sig.name().unwrap_or_default().to_string();
        let author_email = author_sig.email().unwrap_or_default().to_string();

        if let Some(needle) = &author_filter {
            let haystack = format!("{author_name} {author_email}").to_lowercase();
            if !haystack.contains(needle) {
                continue;
            }
        }

        let raw_message = commit.message().unwrap_or("");
        let (subject, body) = split_subject_body(raw_message);
        // libgit2 reports author time in seconds; ms matches the JS contract.
        let timestamp_ms = author_sig.when().seconds().saturating_mul(1_000);

        let (files_changed, insertions, deletions, diff_text) =
            commit_diff(&repo, &commit).unwrap_or_else(|err| {
                (0, 0, 0, format!("(diff unavailable: {err})"))
            });

        records.push(CommitRecord {
            hash: oid.to_string(),
            subject,
            body,
            author: author_name,
            email: author_email,
            timestamp_ms,
            files_changed,
            insertions,
            deletions,
            diff: truncate_diff(diff_text),
        });
    }

    Ok(records)
}

/// First-line subject + remaining body (trimmed), matching the JS path.
fn split_subject_body(message: &str) -> (String, String) {
    let mut parts = message.splitn(2, '\n');
    let subject = parts.next().unwrap_or("").to_string();
    let rest = parts.next().unwrap_or("").trim().to_string();
    (subject, rest)
}

/// Compute `(files_changed, insertions, deletions, formatted_diff)` for a
/// commit against its first parent. Root commits diff against the empty tree.
fn commit_diff(
    repo: &Repository,
    commit: &Commit<'_>,
) -> Result<(usize, usize, usize, String), String> {
    let new_tree = commit
        .tree()
        .map_err(|err| format!("read commit tree: {err}"))?;
    let parent_tree: Option<Tree<'_>> = if commit.parent_count() == 0 {
        None
    } else {
        Some(
            commit
                .parent(0)
                .map_err(|err| format!("read first parent: {err}"))?
                .tree()
                .map_err(|err| format!("read parent tree: {err}"))?,
        )
    };

    let mut opts = DiffOptions::new();
    opts.context_lines(DIFF_CONTEXT_LINES);

    let diff: Diff<'_> = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), Some(&mut opts))
        .map_err(|err| format!("diff tree: {err}"))?;

    let stats = diff
        .stats()
        .map_err(|err| format!("compute stats: {err}"))?;
    let files_changed = stats.files_changed();
    let insertions = stats.insertions();
    let deletions = stats.deletions();

    // `--stat`-style summary, then the unified patch. Mirrors how
    // `git show --stat --patch` interleaves the two sections so downstream
    // chunkers see a familiar layout.
    let stat_buf = stats
        .to_buf(DiffStatsFormat::FULL, 80)
        .map_err(|err| format!("format stats: {err}"))?;
    let mut text = String::new();
    if let Ok(stat_str) = str::from_utf8(&stat_buf) {
        text.push_str(stat_str);
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push('\n');

    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        // Stop *appending* once we have more than the caller will keep (it
        // truncates at DIFF_BYTE_CAP). We must still return `true` so libgit2
        // keeps invoking the callback to completion: returning `false` aborts
        // the print and is surfaced by git2-rs as a `GIT_EUSER` (-7) error,
        // which would discard the entire (large, truncatable) diff and emit a
        // useless "(diff unavailable)" string instead.
        if text.len() < DIFF_BYTE_CAP * 2 {
            match line.origin() {
                '+' | '-' | ' ' => text.push(line.origin()),
                _ => {}
            }
            if let Ok(content) = str::from_utf8(line.content()) {
                text.push_str(content);
            }
        }
        true
    })
    .map_err(|err| format!("print patch: {err}"))?;

    Ok((files_changed, insertions, deletions, text))
}

fn truncate_diff(diff: String) -> String {
    if diff.len() <= DIFF_BYTE_CAP {
        return diff;
    }
    // Walk back to a char boundary so we never split a multibyte sequence.
    let mut cut = DIFF_BYTE_CAP;
    while cut > 0 && !diff.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n…(diff truncated)", &diff[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn init_repo_with_commits() -> (TempDir, Vec<String>) {
        let tmp = TempDir::new().expect("tempdir");
        let repo = Repository::init(tmp.path()).expect("init repo");

        let alice = Signature::new("Alice", "alice@example.com", &git2::Time::new(1_700_000_000, 0))
            .expect("alice sig");
        let bob = Signature::new("Bob", "bob@example.com", &git2::Time::new(1_700_000_100, 0))
            .expect("bob sig");

        // Commit 1 (Alice) — root commit, two files.
        write_file(tmp.path(), "README.md", "hello\n");
        write_file(tmp.path(), "src/main.rs", "fn main() {}\n");
        let oid1 = commit_index(&repo, &alice, "initial: scaffold", &[]);

        // Commit 2 (Bob) — modifies README, adds a third file.
        write_file(tmp.path(), "README.md", "hello world\nline 2\n");
        write_file(tmp.path(), "src/lib.rs", "pub fn hi() {}\n");
        let parent1 = repo.find_commit(oid1).expect("parent1");
        let oid2 = commit_index(&repo, &bob, "feat: greet the world", &[&parent1]);

        // Commit 3 (Alice) — large payload to trigger the truncation cap.
        let big = "x".repeat(DIFF_BYTE_CAP * 2);
        write_file(tmp.path(), "big.txt", &big);
        let parent2 = repo.find_commit(oid2).expect("parent2");
        let oid3 = commit_index(&repo, &alice, "chore: add big file\n\nWith body.", &[&parent2]);

        (
            tmp,
            vec![oid1.to_string(), oid2.to_string(), oid3.to_string()],
        )
    }

    fn write_file(root: &Path, rel: &str, contents: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create dirs");
        }
        fs::write(path, contents).expect("write file");
    }

    fn commit_index(
        repo: &Repository,
        sig: &Signature<'_>,
        message: &str,
        parents: &[&Commit<'_>],
    ) -> Oid {
        let mut index = repo.index().expect("index");
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .expect("add_all");
        index.write().expect("write index");
        let tree_oid = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_oid).expect("find tree");
        repo.commit(Some("HEAD"), sig, sig, message, &tree, parents)
            .expect("commit")
    }

    #[test]
    fn walks_in_reverse_chronological_order() {
        let (tmp, oids) = init_repo_with_commits();
        let records = parse_repo_blocking(ParseGitRepoArgs {
            repo_path: tmp.path().to_string_lossy().into_owned(),
            max_commits: 10,
            author: None,
        })
        .expect("walk");
        assert_eq!(records.len(), 3);
        // Newest first (commit 3, then 2, then 1).
        assert_eq!(records[0].hash, oids[2]);
        assert_eq!(records[1].hash, oids[1]);
        assert_eq!(records[2].hash, oids[0]);
    }

    #[test]
    fn respects_max_commits_cap() {
        let (tmp, _oids) = init_repo_with_commits();
        let records = parse_repo_blocking(ParseGitRepoArgs {
            repo_path: tmp.path().to_string_lossy().into_owned(),
            max_commits: 2,
            author: None,
        })
        .expect("walk");
        assert_eq!(records.len(), 2);
    }

    #[test]
    fn author_filter_is_case_insensitive_substring() {
        let (tmp, _oids) = init_repo_with_commits();
        let records = parse_repo_blocking(ParseGitRepoArgs {
            repo_path: tmp.path().to_string_lossy().into_owned(),
            max_commits: 10,
            author: Some("ALICE".into()),
        })
        .expect("walk");
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|r| r.author == "Alice"));
    }

    #[test]
    fn splits_subject_and_body() {
        let (tmp, _oids) = init_repo_with_commits();
        let records = parse_repo_blocking(ParseGitRepoArgs {
            repo_path: tmp.path().to_string_lossy().into_owned(),
            max_commits: 10,
            author: None,
        })
        .expect("walk");
        let big_commit = records
            .iter()
            .find(|r| r.subject == "chore: add big file")
            .expect("big commit");
        assert_eq!(big_commit.body, "With body.");
    }

    #[test]
    fn diff_is_truncated_with_marker() {
        let (tmp, _oids) = init_repo_with_commits();
        let records = parse_repo_blocking(ParseGitRepoArgs {
            repo_path: tmp.path().to_string_lossy().into_owned(),
            max_commits: 1,
            author: None,
        })
        .expect("walk");
        let head = &records[0];
        assert!(head.diff.ends_with("…(diff truncated)"));
        // The truncated body is bounded by the cap plus the marker.
        assert!(head.diff.len() <= DIFF_BYTE_CAP + "\n…(diff truncated)".len());
    }

    #[test]
    fn stats_reflect_root_commit_against_empty_tree() {
        let (tmp, oids) = init_repo_with_commits();
        let records = parse_repo_blocking(ParseGitRepoArgs {
            repo_path: tmp.path().to_string_lossy().into_owned(),
            max_commits: 10,
            author: None,
        })
        .expect("walk");
        let root = records
            .iter()
            .find(|r| r.hash == oids[0])
            .expect("root commit");
        // Root commit added two files (README.md + src/main.rs).
        assert_eq!(root.files_changed, 2);
        assert!(root.insertions >= 2);
        assert_eq!(root.deletions, 0);
    }

    #[test]
    fn errors_on_non_repo_path() {
        let tmp = TempDir::new().unwrap();
        let result = parse_repo_blocking(ParseGitRepoArgs {
            repo_path: tmp.path().to_string_lossy().into_owned(),
            max_commits: 5,
            author: None,
        });
        assert!(result.is_err(), "non-repo path should error, got {result:?}");
    }
}
