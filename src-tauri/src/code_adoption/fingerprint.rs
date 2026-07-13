//! Workspace fingerprinting — the cheap "reverse-infer what changed" primitive.
//!
//! We do not track the agent's edit operations. Instead we snapshot a stat
//! fingerprint (`path -> "size:mtime_ns"`) of every dirty/untracked file at
//! turn start, and again at turn end; a file whose token is new or changed
//! between the two was written during the turn. The snapshot also records the
//! untracked set so reconcile can tell a freshly-created file from a modified
//! tracked one.
//!
//! Uses `git2` directly (a direct dependency of `src-tauri`) rather than
//! `crate::git::status::status`, because we need the repository `workdir()` to
//! `stat` files and want a single repo open. The harder diff/hunk extraction
//! is what we reuse from `crate::git::diff` (see `attribution.rs`).

use std::collections::{BTreeMap, BTreeSet};
use std::time::UNIX_EPOCH;

use git2::{Repository, Status, StatusOptions};

/// `repo-relative path -> "size:mtime_ns"`.
pub type TokenMap = BTreeMap<String, String>;

/// A point-in-time fingerprint of a workspace's dirty/untracked files.
#[derive(Debug, Default, Clone)]
pub struct Snapshot {
    /// Stat token per dirty/untracked file — the change detector.
    pub tokens: TokenMap,
    /// Paths that are untracked (`WT_NEW`) — used to classify "created this turn".
    pub untracked: BTreeSet<String>,
}

/// Hard cap on attributed files per turn — a runaway edit (e.g. a `dist/`
/// dir that escaped filtering) must not blow up the record. Callers set the
/// `truncated` flag when they clamp to this.
pub const MAX_FILES: usize = 500;

/// Directory path segments we never attribute (build output, deps, VCS meta).
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    ".next",
    "target",
    "out",
    "coverage",
    ".turbo",
];

/// Exact file basenames we never attribute (lockfiles + OS junk).
const SKIP_FILES: &[&str] = &[
    ".DS_Store",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "Cargo.lock",
    "composer.lock",
    "Gemfile.lock",
    "poetry.lock",
];

/// Binary / non-source extensions (lowercase, no dot).
const SKIP_EXTS: &[&str] = &[
    "log", "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "pdf", "zip", "gz", "tar", "tgz",
    "exe", "dll", "so", "dylib", "a", "o", "class", "wasm", "woff", "woff2", "ttf", "otf", "eot",
    "mp4", "mov", "mp3", "wav", "bin", "node", "map",
];

/// Whether `rel` (a forward-slash, repo-relative path) should be excluded.
pub fn is_filtered(rel: &str) -> bool {
    let norm = rel.replace('\\', "/");
    if norm
        .split('/')
        .any(|seg| SKIP_DIRS.iter().any(|d| seg == *d))
    {
        return true;
    }
    let base = norm.rsplit('/').next().unwrap_or(&norm);
    if SKIP_FILES.iter().any(|f| base == *f) {
        return true;
    }
    if base.starts_with(".env") {
        return true;
    }
    if let Some(ext) = base.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()) {
        if SKIP_EXTS.iter().any(|e| ext == *e) {
            return true;
        }
    }
    false
}

fn mtime_ns(meta: &std::fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Fingerprint every dirty/untracked, non-filtered file in `repo`'s worktree.
/// Deleted files are skipped (no stat, and a deletion is not "code written").
pub fn snapshot(repo: &Repository) -> Result<Snapshot, String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repository has no worktree".to_string())?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .include_ignored(false);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("git status failed: {e}"))?;

    let mut snap = Snapshot::default();
    for entry in statuses.iter() {
        let st = entry.status();
        if st.is_conflicted() {
            continue;
        }
        let Some(rel) = entry.path() else { continue };
        if is_filtered(rel) {
            continue;
        }
        // Deleted / vanished files fail to stat — skip them.
        let Ok(meta) = std::fs::metadata(workdir.join(rel)) else {
            continue;
        };
        snap.tokens.insert(
            rel.to_string(),
            format!("{}:{}", meta.len(), mtime_ns(&meta)),
        );
        if st.intersects(Status::WT_NEW) {
            snap.untracked.insert(rel.to_string());
        }
    }
    Ok(snap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Repository, Signature};
    use std::fs;
    use tempfile::TempDir;

    fn init_repo() -> (TempDir, Repository) {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        fs::write(tmp.path().join("tracked.txt"), "original\n").unwrap();
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
        (tmp, repo)
    }

    #[test]
    fn clean_repo_has_empty_snapshot() {
        let (_tmp, repo) = init_repo();
        let snap = snapshot(&repo).unwrap();
        assert!(snap.tokens.is_empty());
        assert!(snap.untracked.is_empty());
    }

    #[test]
    fn untracked_and_modified_files_are_fingerprinted() {
        let (tmp, repo) = init_repo();
        fs::write(tmp.path().join("new.ts"), "export const x = 1\n").unwrap();
        fs::write(tmp.path().join("tracked.txt"), "changed\n").unwrap();
        let snap = snapshot(&repo).unwrap();
        assert!(snap.tokens.contains_key("new.ts"));
        assert!(snap.tokens.contains_key("tracked.txt"));
        assert!(snap.untracked.contains("new.ts"));
        assert!(!snap.untracked.contains("tracked.txt"));
    }

    #[test]
    fn token_changes_when_content_changes() {
        let (tmp, repo) = init_repo();
        fs::write(tmp.path().join("a.ts"), "one\n").unwrap();
        let first = snapshot(&repo).unwrap();
        fs::write(tmp.path().join("a.ts"), "one two three\n").unwrap();
        let second = snapshot(&repo).unwrap();
        assert_ne!(first.tokens.get("a.ts"), second.tokens.get("a.ts"));
    }

    #[test]
    fn filtered_paths_are_excluded() {
        let (tmp, repo) = init_repo();
        fs::create_dir_all(tmp.path().join("node_modules/pkg")).unwrap();
        fs::write(tmp.path().join("node_modules/pkg/index.js"), "x\n").unwrap();
        fs::write(tmp.path().join("pnpm-lock.yaml"), "lock\n").unwrap();
        fs::write(tmp.path().join(".env.local"), "SECRET=1\n").unwrap();
        fs::write(tmp.path().join("keep.ts"), "y\n").unwrap();
        let snap = snapshot(&repo).unwrap();
        assert_eq!(snap.tokens.keys().collect::<Vec<_>>(), vec!["keep.ts"]);
    }

    #[test]
    fn is_filtered_rules() {
        assert!(is_filtered("node_modules/react/index.js"));
        assert!(is_filtered("dist/bundle.js"));
        assert!(is_filtered(".git/HEAD"));
        assert!(is_filtered("src/logo.png"));
        assert!(is_filtered("app.log"));
        assert!(is_filtered(".env"));
        assert!(is_filtered("Cargo.lock"));
        assert!(!is_filtered("src/index.ts"));
        assert!(!is_filtered("lib/app.rs"));
    }
}
