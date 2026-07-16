//! Aggregate HEAD-to-worktree line statistics, one row per final path.

use std::collections::BTreeMap;

use git2::{DiffFindOptions, DiffOptions, Patch, Repository};

use super::error::Result;
use super::read::open_repo;
use super::types::GitFileDiffStat;

fn norm(path: &str) -> String {
    path.replace('\\', "/")
}

/// Compute the real combined HEAD → index + workdir diff once, including
/// untracked content. Aggregating by final path prevents partially staged
/// files (and detected renames) from producing duplicate rows.
pub fn diff_stat(repo_path: &str) -> Result<Vec<GitFileDiffStat>> {
    let repo = open_repo(repo_path)?;
    diff_stat_for(&repo)
}

fn diff_stat_for(repo: &Repository) -> Result<Vec<GitFileDiffStat>> {
    let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let mut options = DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .include_typechange(true);

    let mut diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut options))?;
    let mut find_options = DiffFindOptions::new();
    find_options.renames(true);
    diff.find_similar(Some(&mut find_options))?;

    let mut by_path = BTreeMap::<String, GitFileDiffStat>::new();
    for (index, delta) in diff.deltas().enumerate() {
        let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) else {
            continue;
        };
        let path = norm(&path.to_string_lossy());
        let (insertions, deletions) = match Patch::from_diff(&diff, index)? {
            Some(patch) if !delta.flags().contains(git2::DiffFlags::BINARY) => {
                let (_, insertions, deletions) = patch.line_stats()?;
                (insertions, deletions)
            }
            _ => (0, 0),
        };
        let entry = by_path.entry(path.clone()).or_insert(GitFileDiffStat {
            path,
            insertions: 0,
            deletions: 0,
        });
        entry.insertions += insertions;
        entry.deletions += deletions;
    }

    Ok(by_path.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::diff_stat;
    use git2::{IndexAddOption, Repository, Signature};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn init_repo(with_commit: bool) -> (TempDir, Repository) {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        if with_commit {
            fs::write(tmp.path().join("tracked.txt"), "one\ntwo\n").unwrap();
            let sig = Signature::now("T", "t@example.com").unwrap();
            let mut index = repo.index().unwrap();
            index
                .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
                .unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        (tmp, repo)
    }

    #[test]
    fn combines_staged_unstaged_and_untracked_changes_once_per_path() {
        let (tmp, repo) = init_repo(true);
        fs::write(tmp.path().join("tracked.txt"), "one\nstaged\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        fs::write(tmp.path().join("tracked.txt"), "one\nstaged\nworktree\n").unwrap();
        fs::write(tmp.path().join("new.txt"), "new\nfile\n").unwrap();

        let stats = diff_stat(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(stats.len(), 2);
        let tracked = stats
            .iter()
            .find(|stat| stat.path == "tracked.txt")
            .unwrap();
        assert_eq!((tracked.insertions, tracked.deletions), (2, 1));
        let untracked = stats.iter().find(|stat| stat.path == "new.txt").unwrap();
        assert_eq!((untracked.insertions, untracked.deletions), (2, 0));
        drop(repo);
    }

    #[test]
    fn reports_a_staged_rename_under_only_the_final_path() {
        let (tmp, repo) = init_repo(true);
        fs::rename(
            tmp.path().join("tracked.txt"),
            tmp.path().join("renamed.txt"),
        )
        .unwrap();
        let mut index = repo.index().unwrap();
        index.remove_path(Path::new("tracked.txt")).unwrap();
        index.add_path(Path::new("renamed.txt")).unwrap();
        index.write().unwrap();

        let stats = diff_stat(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].path, "renamed.txt");
        assert_eq!((stats[0].insertions, stats[0].deletions), (0, 0));
    }

    #[test]
    fn binary_changes_report_zero_text_lines() {
        let (tmp, _repo) = init_repo(true);
        fs::write(tmp.path().join("binary.dat"), [0, 159, 146, 150]).unwrap();

        let stats = diff_stat(tmp.path().to_str().unwrap()).unwrap();
        let binary = stats.iter().find(|stat| stat.path == "binary.dat").unwrap();
        assert_eq!((binary.insertions, binary.deletions), (0, 0));
    }

    #[test]
    fn unborn_repository_counts_untracked_text() {
        let (tmp, _repo) = init_repo(false);
        fs::write(tmp.path().join("first.txt"), "hello\nworld\n").unwrap();

        let stats = diff_stat(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].path, "first.txt");
        assert_eq!((stats[0].insertions, stats[0].deletions), (2, 0));
    }
}
