//! Diff computation.
//!
//! Two jobs: (1) produce full old/new text for the Monaco DiffEditor to render,
//! and (2) extract structured hunks each carrying a *self-contained* unified
//! patch (file header + one `@@` block) that `git apply --cached` can consume
//! for hunk-level staging. The `diff.print` reconstruction mirrors the idiom in
//! `twin/code_repo.rs` — pushing the origin char only for `+`/`-`/space lines so
//! file headers, hunk headers, and `\ No newline at end of file` markers survive
//! verbatim, yielding a patch git will accept.

use git2::{Commit, Diff, DiffFormat, DiffHunk, DiffOptions, Repository, Tree};

use super::error::{GitError, Result};
use super::read::{
    head_blob_text, index_blob_text, open_repo, validate_repo_relative_path, workdir_text,
};
use super::types::{GitDiff, GitDiffLine, GitFileChange, GitFileStatus, GitHunk, GitStatusGroup};

const CONTEXT_LINES: u32 = 3;

fn norm(path: &str) -> String {
    path.replace('\\', "/")
}

fn kind_of(origin: char) -> &'static str {
    match origin {
        '+' => "add",
        '-' => "del",
        _ => "context",
    }
}

struct HunkBuild {
    header: String,
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    body: String,
    lines: Vec<GitDiffLine>,
}

impl HunkBuild {
    fn new(dh: &DiffHunk<'_>, header_text: String) -> Self {
        Self {
            header: header_text.trim_end().to_string(),
            old_start: dh.old_start(),
            old_lines: dh.old_lines(),
            new_start: dh.new_start(),
            new_lines: dh.new_lines(),
            body: header_text,
            lines: Vec::new(),
        }
    }

    fn finish(self, header_block: &str) -> GitHunk {
        GitHunk {
            header: self.header,
            old_start: self.old_start,
            old_lines: self.old_lines,
            new_start: self.new_start,
            new_lines: self.new_lines,
            patch: format!("{header_block}{}", self.body),
            lines: self.lines,
        }
    }
}

/// Walk a single-file diff into `(header_block, hunks, is_binary)`.
fn extract_hunks(diff: &Diff<'_>) -> Result<(String, Vec<GitHunk>, bool)> {
    let mut header_block = String::new();
    let mut hunks: Vec<GitHunk> = Vec::new();
    let mut cur: Option<HunkBuild> = None;
    let mut is_binary = false;

    diff.print(DiffFormat::Patch, |delta, hunk, line| {
        if delta.flags().is_binary() {
            is_binary = true;
        }
        let content = std::str::from_utf8(line.content()).unwrap_or("");
        match line.origin() {
            'F' => header_block.push_str(content),
            'H' => {
                if let Some(prev) = cur.take() {
                    hunks.push(prev.finish(&header_block));
                }
                if let Some(dh) = hunk {
                    cur = Some(HunkBuild::new(&dh, content.to_string()));
                }
            }
            origin @ ('+' | '-' | ' ') => {
                if let Some(b) = cur.as_mut() {
                    b.body.push(origin);
                    b.body.push_str(content);
                    b.lines.push(GitDiffLine {
                        kind: kind_of(origin).to_string(),
                        content: content.to_string(),
                    });
                }
            }
            'B' => is_binary = true,
            // EOFNL markers ('=', '>', '<') — append verbatim, no origin prefix.
            _ => {
                if let Some(b) = cur.as_mut() {
                    b.body.push_str(content);
                }
            }
        }
        true
    })
    .map_err(GitError::from)?;

    if let Some(prev) = cur.take() {
        hunks.push(prev.finish(&header_block));
    }
    Ok((header_block, hunks, is_binary))
}

fn base_opts(path: &str) -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.context_lines(CONTEXT_LINES).pathspec(path);
    opts
}

/// File diff for the panel. `staged = true` → HEAD↔index; `false` → index↔workdir.
pub fn file_diff(repo_path: &str, path: &str, staged: bool) -> Result<GitDiff> {
    let repo = open_repo(repo_path)?;
    file_diff_for(&repo, path, staged)
}

fn file_diff_for(repo: &Repository, path: &str, staged: bool) -> Result<GitDiff> {
    validate_repo_relative_path(path)?;
    let (old_content, new_content, diff) = if staged {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let mut opts = base_opts(path);
        let diff = repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?;
        (
            head_blob_text(repo, path).unwrap_or_default(),
            index_blob_text(repo, path).unwrap_or_default(),
            diff,
        )
    } else {
        let mut opts = base_opts(path);
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
        let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
        (
            index_blob_text(repo, path).unwrap_or_default(),
            workdir_text(repo, path)?.unwrap_or_default(),
            diff,
        )
    };

    let (_, hunks, is_binary) = extract_hunks(&diff)?;
    Ok(GitDiff {
        path: norm(path),
        old_content: if is_binary {
            String::new()
        } else {
            old_content
        },
        new_content: if is_binary {
            String::new()
        } else {
            new_content
        },
        hunks: if is_binary { Vec::new() } else { hunks },
        is_binary,
    })
}

/// Diff of `path` in `sha` against its first parent (for the Timeline view).
pub fn commit_file_diff(repo_path: &str, sha: &str, path: &str) -> Result<GitDiff> {
    validate_repo_relative_path(path)?;
    let repo = open_repo(repo_path)?;
    let commit = resolve_commit(&repo, sha)?;
    let new_tree = commit.tree()?;
    let parent_tree: Option<Tree<'_>> = if commit.parent_count() == 0 {
        None
    } else {
        Some(commit.parent(0)?.tree()?)
    };

    let mut opts = base_opts(path);
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), Some(&mut opts))?;
    let (_, hunks, is_binary) = extract_hunks(&diff)?;

    let old_content = parent_tree
        .as_ref()
        .and_then(|t| tree_blob_text(&repo, t, path))
        .unwrap_or_default();
    let new_content = tree_blob_text(&repo, &new_tree, path).unwrap_or_default();

    Ok(GitDiff {
        path: norm(path),
        old_content: if is_binary {
            String::new()
        } else {
            old_content
        },
        new_content: if is_binary {
            String::new()
        } else {
            new_content
        },
        hunks: if is_binary { Vec::new() } else { hunks },
        is_binary,
    })
}

/// List the files changed by `sha` (vs first parent) for the commit-detail view.
pub fn commit_files(repo_path: &str, sha: &str) -> Result<Vec<GitFileChange>> {
    let repo = open_repo(repo_path)?;
    let commit = resolve_commit(&repo, sha)?;
    let new_tree = commit.tree()?;
    let parent_tree: Option<Tree<'_>> = if commit.parent_count() == 0 {
        None
    } else {
        Some(commit.parent(0)?.tree()?)
    };
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), None)?;
    Ok(deltas_to_changes(&diff))
}

/// Map a diff's deltas to the panel's `GitFileChange` rows.
fn deltas_to_changes(diff: &Diff<'_>) -> Vec<GitFileChange> {
    let mut out = Vec::new();
    for delta in diff.deltas() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| norm(&p.to_string_lossy()))
            .unwrap_or_default();
        let status = match delta.status() {
            git2::Delta::Added => GitFileStatus::Added,
            git2::Delta::Deleted => GitFileStatus::Deleted,
            git2::Delta::Renamed => GitFileStatus::Renamed,
            git2::Delta::Typechange => GitFileStatus::TypeChanged,
            _ => GitFileStatus::Modified,
        };
        out.push(GitFileChange {
            path,
            orig_path: delta.old_file().path().map(|p| norm(&p.to_string_lossy())),
            status,
            staged: false,
            group: GitStatusGroup::Changes,
        });
    }
    out
}

/// Resolve any rev (branch, tag, sha, `HEAD~1`, …) to a commit.
fn resolve_to_commit<'r>(repo: &'r Repository, rev: &str) -> Result<Commit<'r>> {
    repo.revparse_single(rev)
        .and_then(|obj| obj.peel_to_commit())
        .map_err(|_| GitError::InvalidArgument(format!("cannot resolve ref: {rev}").into()))
}

/// The two trees a `base...target` comparison spans: the merge-base tree (old)
/// and the target tree (new) — branch-compare semantics, like a PR diff.
fn merge_base_trees<'r>(
    repo: &'r Repository,
    base: &str,
    target: &str,
) -> Result<(Tree<'r>, Tree<'r>)> {
    let base_commit = resolve_to_commit(repo, base)?;
    let target_commit = resolve_to_commit(repo, target)?;
    let merge_base = repo.merge_base(base_commit.id(), target_commit.id())?;
    let old_tree = repo.find_commit(merge_base)?.tree()?;
    let new_tree = target_commit.tree()?;
    Ok((old_tree, new_tree))
}

/// Files changed between `base...target` (three-dot: merge-base vs target).
pub fn diff_refs_files(repo_path: &str, base: &str, target: &str) -> Result<Vec<GitFileChange>> {
    let repo = open_repo(repo_path)?;
    let (old_tree, new_tree) = merge_base_trees(&repo, base, target)?;
    let diff = repo.diff_tree_to_tree(Some(&old_tree), Some(&new_tree), None)?;
    Ok(deltas_to_changes(&diff))
}

/// Diff of one `path` between `base...target` (merge-base vs target).
pub fn diff_refs_file(repo_path: &str, base: &str, target: &str, path: &str) -> Result<GitDiff> {
    validate_repo_relative_path(path)?;
    let repo = open_repo(repo_path)?;
    let (old_tree, new_tree) = merge_base_trees(&repo, base, target)?;
    let mut opts = base_opts(path);
    let diff = repo.diff_tree_to_tree(Some(&old_tree), Some(&new_tree), Some(&mut opts))?;
    let (_, hunks, is_binary) = extract_hunks(&diff)?;

    let old_content = tree_blob_text(&repo, &old_tree, path).unwrap_or_default();
    let new_content = tree_blob_text(&repo, &new_tree, path).unwrap_or_default();

    Ok(GitDiff {
        path: norm(path),
        old_content: if is_binary {
            String::new()
        } else {
            old_content
        },
        new_content: if is_binary {
            String::new()
        } else {
            new_content
        },
        hunks: if is_binary { Vec::new() } else { hunks },
        is_binary,
    })
}

fn tree_blob_text(repo: &Repository, tree: &Tree<'_>, path: &str) -> Option<String> {
    let entry = tree.get_path(std::path::Path::new(path)).ok()?;
    let blob = repo.find_blob(entry.id()).ok()?;
    super::read::blob_text(blob.content())
}

fn resolve_commit<'r>(repo: &'r Repository, sha: &str) -> Result<Commit<'r>> {
    let oid = git2::Oid::from_str(sha)
        .map_err(|_| GitError::InvalidArgument(format!("invalid commit sha: {sha}").into()))?;
    repo.find_commit(oid).map_err(GitError::from)
}

/// Full staged (index ↔ HEAD) unified diff as a single text blob — the prompt
/// input for AI commit-message generation. Shells out to system `git` (via
/// `exec`) so the output is exactly what the user would see from
/// `git diff --cached`, with all files grouped under proper headers.
pub async fn staged_all_text(repo_path: &str) -> Result<String> {
    super::exec::capture(
        std::path::Path::new(repo_path),
        ["diff", "--cached", "--no-color"],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn init_committed() -> (TempDir, Repository) {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        fs::write(tmp.path().join("a.txt"), "line1\nline2\nline3\n").unwrap();
        commit_all(&repo, "init");
        (tmp, repo)
    }

    fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
        let sig = Signature::now("T", "t@e.com").unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    #[test]
    fn working_diff_has_hunk_with_self_contained_patch() {
        let (tmp, repo) = init_committed();
        fs::write(tmp.path().join("a.txt"), "line1\nCHANGED\nline3\n").unwrap();
        let d = file_diff_for(&repo, "a.txt", false).unwrap();
        assert!(!d.is_binary);
        assert_eq!(d.hunks.len(), 1);
        let hunk = &d.hunks[0];
        // The per-hunk patch must carry the file header + the @@ block.
        assert!(hunk.patch.contains("--- "));
        assert!(hunk.patch.contains("+++ "));
        assert!(hunk.patch.contains("@@"));
        assert!(hunk.patch.contains("+CHANGED"));
        assert!(hunk.patch.contains("-line2"));
        assert_eq!(d.new_content, "line1\nCHANGED\nline3\n");
        let _ = tmp;
    }

    #[test]
    fn staged_diff_compares_head_to_index() {
        let (tmp, repo) = init_committed();
        fs::write(tmp.path().join("a.txt"), "line1\nstaged\nline3\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let d = file_diff_for(&repo, "a.txt", true).unwrap();
        assert_eq!(d.hunks.len(), 1);
        assert_eq!(d.old_content, "line1\nline2\nline3\n");
        assert_eq!(d.new_content, "line1\nstaged\nline3\n");
        let _ = tmp;
    }

    #[test]
    fn untracked_file_shows_all_additions() {
        let (tmp, repo) = init_committed();
        fs::write(tmp.path().join("new.txt"), "fresh\ncontent\n").unwrap();
        let d = file_diff_for(&repo, "new.txt", false).unwrap();
        assert!(!d.is_binary);
        assert!(d.hunks[0].patch.contains("+fresh"));
        assert_eq!(d.new_content, "fresh\ncontent\n");
        let _ = tmp;
    }

    #[test]
    fn binary_file_is_flagged_without_hunks() {
        let (tmp, repo) = init_committed();
        fs::write(tmp.path().join("img.bin"), [0u8, 159, 146, 150, 0, 1]).unwrap();
        let d = file_diff_for(&repo, "img.bin", false).unwrap();
        assert!(d.is_binary);
        assert!(d.hunks.is_empty());
        assert!(d.new_content.is_empty());
        let _ = tmp;
    }

    #[test]
    fn commit_files_lists_changed_paths() {
        let (tmp, repo) = init_committed();
        fs::write(tmp.path().join("b.txt"), "second\n").unwrap();
        let oid = commit_all(&repo, "add b");
        let files = commit_files(&tmp.path().to_string_lossy(), &oid.to_string()).unwrap();
        assert!(files.iter().any(|f| f.path == "b.txt"));
        let _ = repo;
    }

    #[test]
    fn working_tree_diff_rejects_an_absolute_path_outside_the_repository() {
        let (tmp, _repo) = init_committed();
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "do not expose\n").unwrap();

        let error = file_diff(
            &tmp.path().to_string_lossy(),
            &secret.to_string_lossy(),
            false,
        )
        .expect_err("absolute paths must not be readable through the git seam");

        assert!(matches!(error, GitError::InvalidArgument(_)));
    }

    #[test]
    fn commit_file_diff_against_parent() {
        let (tmp, repo) = init_committed();
        fs::write(tmp.path().join("a.txt"), "line1\nv2\nline3\n").unwrap();
        let oid = commit_all(&repo, "edit a");
        let d = commit_file_diff(&tmp.path().to_string_lossy(), &oid.to_string(), "a.txt").unwrap();
        assert_eq!(d.old_content, "line1\nline2\nline3\n");
        assert_eq!(d.new_content, "line1\nv2\nline3\n");
        assert_eq!(d.hunks.len(), 1);
        let _ = repo;
    }

    #[test]
    fn invalid_sha_errors() {
        let (tmp, _repo) = init_committed();
        let err = commit_files(&tmp.path().to_string_lossy(), "not-a-sha").unwrap_err();
        assert!(matches!(err, GitError::InvalidArgument(_)));
    }

    /// The default branch and `feature` diverge: feature edits a.txt + adds
    /// f.txt; the default branch adds m.txt after the fork. Three-dot
    /// semantics must show only feature's side. Returns the default branch name
    /// (libgit2's default varies with `init.defaultBranch`).
    fn two_branch_fixture() -> (TempDir, Repository, String) {
        let (tmp, repo) = init_committed();
        let default_branch = repo.head().unwrap().shorthand().unwrap().to_string();
        // Fork point is the init commit. Build feature first.
        {
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("feature", &head, false).unwrap();
        }
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        fs::write(tmp.path().join("a.txt"), "line1\nFEATURE\nline3\n").unwrap();
        fs::write(tmp.path().join("f.txt"), "feature-only\n").unwrap();
        commit_all(&repo, "feature work");
        // Advance the default branch independently.
        repo.set_head(&format!("refs/heads/{default_branch}"))
            .unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        fs::write(tmp.path().join("m.txt"), "main-only\n").unwrap();
        commit_all(&repo, "main work");
        (tmp, repo, default_branch)
    }

    #[test]
    fn diff_refs_files_shows_only_target_side_changes() {
        let (tmp, _repo, default_branch) = two_branch_fixture();
        let rp = tmp.path().to_string_lossy().into_owned();
        let files = diff_refs_files(&rp, &default_branch, "feature").unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt"));
        assert!(paths.contains(&"f.txt"));
        // The default branch's post-fork commit must NOT appear (three-dot).
        assert!(!paths.contains(&"m.txt"));
    }

    #[test]
    fn diff_refs_file_diffs_against_the_merge_base() {
        let (tmp, _repo, default_branch) = two_branch_fixture();
        let rp = tmp.path().to_string_lossy().into_owned();
        let d = diff_refs_file(&rp, &default_branch, "feature", "a.txt").unwrap();
        assert_eq!(d.old_content, "line1\nline2\nline3\n");
        assert_eq!(d.new_content, "line1\nFEATURE\nline3\n");
        assert_eq!(d.hunks.len(), 1);
    }

    #[test]
    fn diff_refs_unresolvable_ref_errors() {
        let (tmp, _repo) = init_committed();
        let rp = tmp.path().to_string_lossy().into_owned();
        let err = diff_refs_files(&rp, "no-such-branch", "HEAD").unwrap_err();
        assert!(matches!(err, GitError::InvalidArgument(_)));
    }

    fn git_on_path() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }

    #[tokio::test]
    async fn staged_all_text_aggregates_staged_changes() {
        if !git_on_path() {
            return;
        }
        let (tmp, repo) = init_committed();
        fs::write(tmp.path().join("a.txt"), "line1\nstaged\nline3\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();

        let text = staged_all_text(&tmp.path().to_string_lossy())
            .await
            .unwrap();
        assert!(text.contains("a.txt"));
        assert!(text.contains("+staged"));
        assert!(text.contains("-line2"));
    }

    #[tokio::test]
    async fn staged_all_text_empty_when_nothing_staged() {
        if !git_on_path() {
            return;
        }
        let (tmp, _repo) = init_committed();
        let text = staged_all_text(&tmp.path().to_string_lossy())
            .await
            .unwrap();
        assert!(text.trim().is_empty());
    }
}
