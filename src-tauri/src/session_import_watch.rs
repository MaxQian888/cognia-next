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

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const SESSION_CHANGED_EVENT: &str = "session-import://changed";

/// Trailing debounce — coalesces an agent's write burst into one signal.
const DEBOUNCE_MS: u64 = 300;
const MAX_BATCH_MS: u64 = 2_000;
const MAX_PENDING_PATHS: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedPayload {
    /// Retained for older frontend listeners; new listeners consume every path.
    path: Option<String>,
    paths: Vec<String>,
    /// Queue overflow or watcher errors require a full scan, never a partial one.
    rescan: bool,
}

struct ActiveWatcher {
    _watcher: RecommendedWatcher,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for ActiveWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The same bounded collector is used by the native emitter and its tests.
async fn next_batch(
    rx: &mut tokio::sync::mpsc::Receiver<String>,
    overflow: &AtomicBool,
) -> Option<ChangedPayload> {
    let first = rx.recv().await?;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(MAX_BATCH_MS);
    let mut paths = BTreeSet::new();
    let mut rescan = false;
    let mut next = first;
    loop {
        if !next.is_empty() && !rescan {
            paths.insert(next);
            if paths.len() > MAX_PENDING_PATHS {
                paths.clear();
                rescan = true;
            }
        }
        let quiet = tokio::time::Instant::now() + Duration::from_millis(DEBOUNCE_MS);
        tokio::select! {
            // The deadline wins even when writes never leave the channel empty.
            biased;
            _ = tokio::time::sleep_until(deadline.min(quiet)) => break,
            msg = rx.recv() => match msg {
                Some(path) => next = path,
                None => return None,
            },
        }
    }
    rescan |= overflow.swap(false, Ordering::AcqRel);
    let paths: Vec<String> = if rescan {
        Vec::new()
    } else {
        paths.into_iter().collect()
    };
    Some(ChangedPayload {
        path: paths.last().cloned(),
        paths,
        rescan,
    })
}

fn enqueue_change(tx: &tokio::sync::mpsc::Sender<String>, overflow: &AtomicBool, path: String) {
    if let Err(tokio::sync::mpsc::error::TrySendError::Full(_)) = tx.try_send(path) {
        overflow.store(true, Ordering::Release);
        // The consumer may drain the queue between try_send and the flag
        // write. Wake it again so a late overflow flag cannot sit unobserved.
        let _ = tx.try_send(String::new());
    }
}

/// Managed Tauri state: the single active session-import watcher. Dropping it
/// stops the OS watch and closes the channel, ending the debounce task.
#[derive(Default)]
pub struct SessionImportWatcherState {
    watcher: Mutex<Option<ActiveWatcher>>,
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
/// the union of the adapters' `acceptedExtensions`, plus SQLite's own sidecar
/// files.
///
/// The sidecars matter: OpenCode keeps its history in `opencode.db`, and SQLite
/// in WAL mode writes new pages to `opencode.db-wal` and touches
/// `opencode.db-shm`, leaving the main database file untouched until a
/// checkpoint. Matching only `.db` therefore meant live sync could sit silent
/// through an entire OpenCode session. SQLite changes re-scan their source;
/// transcript changes retain every distinct path within the debounce window.
fn is_session_file(p: &Path) -> bool {
    match p.extension().and_then(|s| s.to_str()) {
        Some(ext) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "jsonl"
                | "json"
                | "md"
                | "db"
                | "db-wal"
                | "db-shm"
                | "sqlite"
                | "sqlite-wal"
                | "sqlite-shm"
                | "vscdb"
                | "vscdb-wal"
                | "vscdb-shm"
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

    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(MAX_PENDING_PATHS);
    let overflow = Arc::new(AtomicBool::new(false));
    let callback_overflow = Arc::clone(&overflow);
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        match res {
            Ok(event) => {
                if event.need_rescan() {
                    callback_overflow.store(true, Ordering::Release);
                    enqueue_change(&tx, &callback_overflow, String::new());
                }
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                for p in &event.paths {
                    if is_session_file(p) {
                        enqueue_change(&tx, &callback_overflow, p.to_string_lossy().into_owned());
                    }
                }
            }
            Err(_) => {
                // OS watchers may report dropped events. Wake the consumer even
                // when the queue was empty; a full queue already guarantees it wakes.
                callback_overflow.store(true, Ordering::Release);
                enqueue_change(&tx, &callback_overflow, String::new());
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

    let app_for_task = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        while let Some(batch) = next_batch(&mut rx, &overflow).await {
            let _ = app_for_task.emit(SESSION_CHANGED_EVENT, batch);
        }
    });

    // Replacing or stopping a watcher also aborts its pending debounce task.
    *state.watcher.lock() = Some(ActiveWatcher {
        _watcher: watcher,
        task,
    });
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
    fn sqlite_sidecar_writes_count_as_changes() {
        // WAL-mode SQLite writes land in `-wal` and leave the `.db` mtime alone
        // until a checkpoint, so matching only `.db` made live sync miss an
        // entire OpenCode session.
        assert!(is_session_file(&PathBuf::from("/x/opencode.db-wal")));
        assert!(is_session_file(&PathBuf::from("/x/opencode.db-shm")));
        assert!(is_session_file(&PathBuf::from("/x/store.sqlite")));
        assert!(is_session_file(&PathBuf::from("/x/store.SQLITE-WAL")));
        // Both spellings carry both sidecars: `.sqlite-shm` was missing while
        // `.db-shm` was accepted, so the two conventions behaved differently.
        assert!(is_session_file(&PathBuf::from("/x/store.sqlite-shm")));
        assert!(is_session_file(&PathBuf::from("/x/state.vscdb")));
        assert!(is_session_file(&PathBuf::from("/x/state.vscdb-wal")));
        assert!(is_session_file(&PathBuf::from("/x/state.vscdb-shm")));
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

    #[tokio::test]
    async fn debounce_keeps_all_distinct_paths() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(MAX_PENDING_PATHS);
        let overflow = AtomicBool::new(false);
        for path in ["/claude/a.jsonl", "/codex/b.jsonl", "/claude/a.jsonl"] {
            enqueue_change(&tx, &overflow, path.into());
        }
        let batch = next_batch(&mut rx, &overflow).await.unwrap();
        assert_eq!(batch.paths, ["/claude/a.jsonl", "/codex/b.jsonl"]);
        assert!(!batch.rescan);
    }

    #[tokio::test]
    async fn overflow_requests_full_rescan() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let overflow = AtomicBool::new(false);
        for path in ["a.json", "b.json", "dropped.json"] {
            enqueue_change(&tx, &overflow, path.into());
        }
        let batch = next_batch(&mut rx, &overflow).await.unwrap();
        assert!(batch.rescan);
        assert!(batch.paths.is_empty());
        assert!(batch.path.is_none());
        assert!(!overflow.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn continuous_writes_flush_at_maximum_deadline() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(MAX_PENDING_PATHS);
        let producer = tokio::spawn(async move {
            loop {
                if tx.send("active.jsonl".into()).await.is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        });
        let overflow = AtomicBool::new(false);
        let result = tokio::time::timeout(
            Duration::from_millis(MAX_BATCH_MS + 1_000),
            next_batch(&mut rx, &overflow),
        )
        .await;
        producer.abort();
        assert_eq!(result.unwrap().unwrap().paths, ["active.jsonl"]);
    }

    #[tokio::test]
    async fn closed_channel_does_not_emit_a_stale_batch() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let overflow = AtomicBool::new(false);
        tx.send("a.jsonl".into()).await.unwrap();
        drop(tx);
        assert!(next_batch(&mut rx, &overflow).await.is_none());
    }
}
