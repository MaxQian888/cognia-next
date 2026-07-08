//! Filesystem watcher for external-agent session-history directories (ADR-0062).
//! Emits `session-import://changed` when a watched agent's on-disk history
//! changes, so the frontend can debounced-re-import in the background (guarded
//! by `applyImportedMerged`, which never clobbers a session the user already
//! continued in Cognia).
//!
//! Modeled on `ccswitch/watcher.rs`, with two differences: it watches MANY roots
//! (Claude Code / Codex / Gemini CLI / Continue dirs — passed from the frontend
//! scan roots) RECURSIVELY (those trees nest by date/project), and it filters by
//! session-file extension rather than a single db name.

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const SESSION_CHANGED_EVENT: &str = "session-import://changed";

/// Trailing debounce — coalesces an agent's write burst into one signal.
const DEBOUNCE_MS: u64 = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedPayload {
    /// The last changed path in the burst (a hint; the frontend re-scans).
    path: String,
}

/// Managed Tauri state: the single active session-import watcher. Dropping it
/// stops the OS watch and closes the channel, ending the debounce task.
#[derive(Default)]
pub struct SessionImportWatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl SessionImportWatcherState {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when a watcher is currently installed. Exposed for tests.
    pub fn is_watching(&self) -> bool {
        self.watcher.lock().is_some()
    }
}

/// Whether a changed path is an importable session file (by extension). Matches
/// the union of the adapters' `acceptedExtensions`.
fn is_session_file(p: &Path) -> bool {
    match p.extension().and_then(|s| s.to_str()) {
        Some(ext) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "jsonl" | "json" | "md" | "db"
        ),
        None => false,
    }
}

/// The subset of `roots` that exist on disk as directories (skips agents that
/// aren't installed).
fn existing_dirs(roots: &[String]) -> Vec<PathBuf> {
    roots
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect()
}

/// Start (or replace) the watcher over the given roots, emitting debounced
/// `session-import://changed` events on `app`. Watching an empty/missing set is
/// a no-op (returns Ok without installing a watcher).
pub fn start(
    state: &SessionImportWatcherState,
    app: &AppHandle,
    roots: &[String],
) -> Result<(), String> {
    let dirs = existing_dirs(roots);
    if dirs.is_empty() {
        // Nothing installed to watch — clear any prior watcher and return.
        *state.watcher.lock() = None;
        return Ok(());
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            for p in &event.paths {
                if is_session_file(p) {
                    let _ = tx.send(p.to_string_lossy().into_owned());
                }
            }
        }
    })
    .map_err(|e| format!("notify init: {e}"))?;

    let mut watched = 0usize;
    for dir in &dirs {
        // A per-root failure (permissions, race) must not sink the whole watch.
        if watcher.watch(dir, RecursiveMode::Recursive).is_ok() {
            watched += 1;
        }
    }
    if watched == 0 {
        return Err("no session directories could be watched".to_string());
    }

    // Debounce emitter: after the first event, wait for DEBOUNCE_MS of quiet,
    // keeping the last changed path, then emit a single signal.
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut last = first;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)) => break,
                    msg = rx.recv() => {
                        match msg {
                            Some(p) => last = p,
                            None => return, // channel closed
                        }
                    }
                }
            }
            let _ = app_for_task.emit(SESSION_CHANGED_EVENT, ChangedPayload { path: last });
        }
    });

    // Replaces (and drops) any prior watcher.
    *state.watcher.lock() = Some(watcher);
    Ok(())
}

/// Stop watching. Dropping the watcher ends its debounce task. Idempotent.
pub fn stop(state: &SessionImportWatcherState) {
    *state.watcher.lock() = None;
}

/// Start the session-import watcher over `roots`. Returns whether a watch is now
/// active (false when no root exists on disk).
#[tauri::command]
pub fn session_import_watch_start(
    app: AppHandle,
    state: tauri::State<'_, SessionImportWatcherState>,
    roots: Vec<String>,
) -> Result<bool, String> {
    start(&state, &app, &roots)?;
    Ok(state.is_watching())
}

/// Stop the session-import watcher.
#[tauri::command]
pub fn session_import_watch_stop(state: tauri::State<'_, SessionImportWatcherState>) {
    stop(&state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_file_extensions_are_recognized() {
        assert!(is_session_file(&PathBuf::from("/x/a.jsonl")));
        assert!(is_session_file(&PathBuf::from("/x/a.json")));
        assert!(is_session_file(&PathBuf::from("/x/.aider.chat.history.md")));
        assert!(is_session_file(&PathBuf::from("/x/opencode.db")));
        assert!(is_session_file(&PathBuf::from("/x/a.JSONL"))); // case-insensitive
    }

    #[test]
    fn non_session_files_are_ignored() {
        assert!(!is_session_file(&PathBuf::from("/x/a.txt")));
        assert!(!is_session_file(&PathBuf::from("/x/a.log")));
        assert!(!is_session_file(&PathBuf::from("/x/noext")));
    }

    #[test]
    fn existing_dirs_filters_to_real_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().to_string_lossy().into_owned();
        let missing = tmp.path().join("nope").to_string_lossy().into_owned();
        let dirs = existing_dirs(&[real.clone(), missing]);
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0], PathBuf::from(real));
    }

    #[test]
    fn stop_is_safe_when_idle() {
        let state = SessionImportWatcherState::new();
        stop(&state); // must not panic
        assert!(!state.is_watching());
    }
}
