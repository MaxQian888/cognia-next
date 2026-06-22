//! Filesystem watcher that emits `git://status-changed` so the panel
//! auto-refreshes after external `git`/editor/build mutations — mirroring
//! VSCode. Events are debounced (a `git add -A` fires a burst) and filtered:
//! everything under `.git/` is ignored except the refs/index/merge state that
//! actually changes what the panel shows, and gitignored working-tree churn is
//! dropped via the `ignore` crate.
//!
//! This is the *only* persistent state in the git subsystem; every other
//! command is stateless per call.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::error::{GitError, Result};

pub const STATUS_CHANGED_EVENT: &str = "git://status-changed";

/// Trailing debounce window — coalesces bursts into a single refresh.
const DEBOUNCE_MS: u64 = 250;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusChangedPayload {
    root_dir: String,
}

/// Managed Tauri state: one watcher per active repo path. Dropping a watcher
/// stops it and closes its event channel, which ends the debounce task.
#[derive(Default)]
pub struct GitWatcherState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl GitWatcherState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// `.git/` internals that *do* affect panel state and must not be filtered out.
fn is_relevant_git_internal(rest: &str) -> bool {
    let rest = rest.replace('\\', "/");
    rest == "index"
        || rest == "HEAD"
        || rest == "MERGE_HEAD"
        || rest == "ORIG_HEAD"
        || rest == "CHERRY_PICK_HEAD"
        || rest == "REVERT_HEAD"
        || rest.starts_with("refs/")
        || rest.starts_with("logs/")
}

/// Decide whether a changed path should trigger a refresh.
fn path_is_relevant(
    repo_root: &Path,
    gi: Option<&ignore::gitignore::Gitignore>,
    path: &Path,
) -> bool {
    let rel = match path.strip_prefix(repo_root) {
        Ok(r) => r,
        Err(_) => return true, // outside our prefix — be safe, refresh.
    };
    let rel_str = rel.to_string_lossy().replace('\\', "/");

    if let Some(rest) = rel_str.strip_prefix(".git/") {
        return is_relevant_git_internal(rest);
    }
    if rel_str == ".git" {
        return false;
    }
    // Drop gitignored working-tree churn (build output, node_modules, …).
    if let Some(gi) = gi {
        if gi.matched(rel, path.is_dir()).is_ignore() {
            return false;
        }
    }
    true
}

/// Start (or replace) the watcher for `repo_path`, emitting debounced
/// `git://status-changed` events on `app`.
pub fn start(state: &GitWatcherState, app: &AppHandle, repo_path: &str) -> Result<()> {
    let repo_root = PathBuf::from(repo_path);
    if !repo_root.exists() {
        return Err(GitError::NotARepo(repo_path.to_string()));
    }

    // Build a gitignore matcher once from the repo-root .gitignore.
    let gi = {
        let mut builder = ignore::gitignore::GitignoreBuilder::new(&repo_root);
        let _ = builder.add(repo_root.join(".gitignore"));
        builder.build().ok()
    };

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let root_for_filter = repo_root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let relevant = event
                .paths
                .iter()
                .any(|p| path_is_relevant(&root_for_filter, gi.as_ref(), p));
            if relevant {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| GitError::CommandFailed(format!("notify init: {e}")))?;

    watcher
        .watch(&repo_root, RecursiveMode::Recursive)
        .map_err(|e| GitError::CommandFailed(format!("watch start: {e}")))?;

    // Debounce emitter: after the first event, wait for DEBOUNCE_MS of quiet
    // before emitting a single refresh signal.
    let app_for_task = app.clone();
    let root_str = repo_path.to_string();
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)) => break,
                    msg = rx.recv() => {
                        if msg.is_none() { return; } // channel closed
                    }
                }
            }
            let _ = app_for_task.emit(
                STATUS_CHANGED_EVENT,
                StatusChangedPayload {
                    root_dir: root_str.clone(),
                },
            );
        }
    });

    // Inserting replaces (and drops) any prior watcher for this repo.
    state.watchers.lock().insert(repo_path.to_string(), watcher);
    Ok(())
}

/// Stop watching `repo_path`. Dropping the watcher ends its debounce task.
pub fn stop(state: &GitWatcherState, repo_path: &str) {
    state.watchers.lock().remove(repo_path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_internal_relevance() {
        assert!(is_relevant_git_internal("index"));
        assert!(is_relevant_git_internal("HEAD"));
        assert!(is_relevant_git_internal("refs/heads/main"));
        assert!(is_relevant_git_internal("logs/HEAD"));
        assert!(!is_relevant_git_internal("objects/ab/cdef"));
        assert!(!is_relevant_git_internal("COMMIT_EDITMSG"));
    }

    #[test]
    fn working_tree_file_is_relevant() {
        let root = PathBuf::from("/repo");
        assert!(path_is_relevant(
            &root,
            None,
            &PathBuf::from("/repo/src/a.rs")
        ));
    }

    #[test]
    fn git_object_churn_is_ignored() {
        let root = PathBuf::from("/repo");
        assert!(!path_is_relevant(
            &root,
            None,
            &PathBuf::from("/repo/.git/objects/ab/cdef")
        ));
    }

    #[test]
    fn git_index_change_is_relevant() {
        let root = PathBuf::from("/repo");
        assert!(path_is_relevant(
            &root,
            None,
            &PathBuf::from("/repo/.git/index")
        ));
    }

    #[test]
    fn stop_is_safe_when_absent() {
        let state = GitWatcherState::new();
        stop(&state, "/nope"); // must not panic
        assert!(state.watchers.lock().is_empty());
    }
}
