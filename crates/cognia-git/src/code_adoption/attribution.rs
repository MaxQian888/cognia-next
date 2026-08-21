//! Reconcile a baseline snapshot against the current one into per-file
//! attributions, reusing `crate::diff::file_diff` for the hard part
//! (hunk line-range extraction). We keep only metrics + hunk ranges — never
//! the diff body — so nothing sensitive is persisted.

use crate::diff::file_diff;

use super::fingerprint::{Snapshot, MAX_FILES};
use super::FileAttribution;

/// Files whose fingerprint is new or changed between `base` and `cur`, capped
/// at [`MAX_FILES`]. Returns `(files, truncated)`.
pub fn reconcile(cwd: &str, base: &Snapshot, cur: &Snapshot) -> (Vec<FileAttribution>, bool) {
    // BTreeMap iterates in sorted path order → deterministic output.
    let changed: Vec<&String> = cur
        .tokens
        .iter()
        .filter(|(path, token)| base.tokens.get(*path) != Some(*token))
        .map(|(path, _)| path)
        .collect();

    let truncated = changed.len() > MAX_FILES;
    let mut files = Vec::new();
    for path in changed.into_iter().take(MAX_FILES) {
        // "Created this turn" = untracked now AND absent from the baseline (a
        // pre-existing untracked file that was merely edited is not new).
        let is_new = cur.untracked.contains(path) && !base.tokens.contains_key(path);
        files.push(attribute_file(cwd, path, is_new));
    }
    (files, truncated)
}

/// Build one file's attribution. Unstaged (index↔workdir) is the common case
/// for an agent that writes to the worktree; if that yields nothing we retry
/// the staged side for agents that `git add`. On any diff error we still emit
/// the file with empty hunks — it was written, we just could not measure it.
fn attribute_file(cwd: &str, path: &str, is_new: bool) -> FileAttribution {
    let diff = match file_diff(cwd, path, false) {
        Ok(d) if !d.hunks.is_empty() => Some(d),
        _ => file_diff(cwd, path, true).ok(),
    };

    let mut added = 0u32;
    let mut removed = 0u32;
    let mut hunks = Vec::new();
    if let Some(d) = diff {
        for h in &d.hunks {
            let end = h.new_start + h.new_lines.saturating_sub(1);
            hunks.push([h.new_start, end.max(h.new_start)]);
            for line in &h.lines {
                match line.kind.as_str() {
                    "add" => added += 1,
                    "del" => removed += 1,
                    _ => {}
                }
            }
        }
    }

    FileAttribution {
        path: path.to_string(),
        added,
        removed,
        is_new,
        hunks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Repository, Signature};
    use std::fs;
    use tempfile::TempDir;

    use crate::code_adoption::fingerprint::snapshot;

    fn init_repo() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        fs::write(tmp.path().join("tracked.ts"), "line1\nline2\n").unwrap();
        {
            let sig = Signature::now("T", "t@e.com").unwrap();
            let mut index = repo.index().unwrap();
            index
                .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
                .unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        tmp
    }

    #[test]
    fn attributes_new_file_as_added() {
        let tmp = init_repo();
        let cwd = tmp.path().to_str().unwrap();
        let repo = Repository::open(tmp.path()).unwrap();
        let base = snapshot(&repo).unwrap();
        fs::write(tmp.path().join("new.ts"), "a\nb\nc\n").unwrap();
        let cur = snapshot(&repo).unwrap();

        let (files, truncated) = reconcile(cwd, &base, &cur);
        assert!(!truncated);
        let f = files.iter().find(|f| f.path == "new.ts").unwrap();
        assert!(f.is_new);
        assert_eq!(f.added, 3);
        assert_eq!(f.removed, 0);
        assert!(!f.hunks.is_empty());
    }

    #[test]
    fn attributes_modification_with_hunk_range() {
        let tmp = init_repo();
        let cwd = tmp.path().to_str().unwrap();
        let repo = Repository::open(tmp.path()).unwrap();
        let base = snapshot(&repo).unwrap();
        fs::write(tmp.path().join("tracked.ts"), "line1\nCHANGED\nline2\n").unwrap();
        let cur = snapshot(&repo).unwrap();

        let (files, _) = reconcile(cwd, &base, &cur);
        let f = files.iter().find(|f| f.path == "tracked.ts").unwrap();
        assert!(!f.is_new, "a modified tracked file is not 'new'");
        assert!(f.added >= 1);
        assert!(!f.hunks.is_empty());
    }

    #[test]
    fn pre_existing_dirty_file_not_reattributed() {
        let tmp = init_repo();
        let cwd = tmp.path().to_str().unwrap();
        let repo = Repository::open(tmp.path()).unwrap();
        // dirty BEFORE the turn:
        fs::write(tmp.path().join("tracked.ts"), "pre-existing edit\n").unwrap();
        let base = snapshot(&repo).unwrap();
        // turn writes a DIFFERENT file:
        fs::write(tmp.path().join("other.ts"), "z\n").unwrap();
        let cur = snapshot(&repo).unwrap();

        let (files, _) = reconcile(cwd, &base, &cur);
        assert!(files.iter().any(|f| f.path == "other.ts"));
        assert!(
            !files.iter().any(|f| f.path == "tracked.ts"),
            "unchanged pre-existing dirt must not be attributed to the turn"
        );
    }

    #[test]
    fn pre_existing_untracked_file_edited_is_not_new() {
        let tmp = init_repo();
        let cwd = tmp.path().to_str().unwrap();
        let repo = Repository::open(tmp.path()).unwrap();
        // untracked file exists BEFORE the turn:
        fs::write(tmp.path().join("scratch.ts"), "one\n").unwrap();
        let base = snapshot(&repo).unwrap();
        // turn edits it further:
        fs::write(tmp.path().join("scratch.ts"), "one\ntwo\n").unwrap();
        let cur = snapshot(&repo).unwrap();

        let (files, _) = reconcile(cwd, &base, &cur);
        let f = files.iter().find(|f| f.path == "scratch.ts").unwrap();
        assert!(!f.is_new, "a file that existed pre-turn is not 'new'");
    }
}
