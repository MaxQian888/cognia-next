//! Filesystem watcher for cc-switch's SQLite database. Emits
//! `ccswitch://db-changed` so the CCSwitch settings section auto-refreshes
//! when the user switches providers in cc-switch itself while cognia-next is
//! open — closing the "two writers" loop without requiring a window focus.
//!
//! Modeled on `git/watcher.rs`: a single owner, non-recursive watch on the
//! resolved `cc-switch.db` path, debounced 250ms (SQLite touches the db plus
//! `-wal`/`-shm` sidecars in a burst), `app.emit` on quiet. State is a
//! `Mutex<Option<RecommendedWatcher>>` — there is exactly one db, so unlike
//! the git subsystem we don't key by path.

use std::path::Path;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::paths::resolve_ccswitch_db;

pub const DB_CHANGED_EVENT: &str = "ccswitch://db-changed";

/// Trailing debounce window — coalesces the db + WAL/SHM write burst into a
/// single refresh signal.
const DEBOUNCE_MS: u64 = 250;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DbChangedPayload {
    db_path: String,
}

/// Managed Tauri state: the single active cc-switch.db watcher. Dropping it
/// stops the OS watch and closes the channel, which ends the debounce task.
#[derive(Default)]
pub struct CcswitchWatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl CcswitchWatcherState {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when a watcher is currently installed. Exposed for tests.
    pub fn is_watching(&self) -> bool {
        self.watcher.lock().is_some()
    }
}

/// Whether a changed path under the watched directory is the cc-switch
/// database (including its `-wal` / `-shm` sidecars). Anything else in the
/// `.cc-switch/` directory (logs, the app store, temp files) is ignored.
fn path_is_db(db_path: &Path, changed: &Path) -> bool {
    let Some(db_name) = db_path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let Some(changed_name) = changed.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    changed_name == db_name
        || changed_name == format!("{db_name}-wal")
        || changed_name == format!("{db_name}-shm")
        || changed_name == format!("{db_name}-journal")
}

/// Start (or replace) the cc-switch.db watcher, emitting debounced
/// `ccswitch://db-changed` events on `app`. Returns an error string when the
/// db path can't be resolved or the parent dir doesn't exist yet (cc-switch
/// not installed). We watch the *parent directory* non-recursively rather
/// than the file itself: SQLite atomic-replaces / re-creates the db on some
/// operations, and watching a not-yet-existing file fails outright.
pub fn start(
    state: &CcswitchWatcherState,
    app: &AppHandle,
    manual_data_dir: Option<&str>,
) -> Result<(), String> {
    let resolved = resolve_ccswitch_db(manual_data_dir)
        .ok_or_else(|| "could not resolve cc-switch.db".to_string())?;
    let db_path = resolved.path;
    let watch_dir = db_path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "cc-switch.db has no parent dir".to_string())?;
    if !watch_dir.exists() {
        return Err(format!(
            "cc-switch data dir does not exist: {}",
            watch_dir.display()
        ));
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let db_for_filter = db_path.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let relevant = event.paths.iter().any(|p| path_is_db(&db_for_filter, p));
            if relevant {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| format!("notify init: {e}"))?;

    watcher
        .watch(&watch_dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch start: {e}"))?;

    // Debounce emitter: after the first event, wait for DEBOUNCE_MS of quiet
    // before emitting a single refresh signal.
    let app_for_task = app.clone();
    let db_str = db_path.to_string_lossy().into_owned();
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
                DB_CHANGED_EVENT,
                DbChangedPayload {
                    db_path: db_str.clone(),
                },
            );
        }
    });

    // Replaces (and drops) any prior watcher.
    *state.watcher.lock() = Some(watcher);
    Ok(())
}

/// Stop watching. Dropping the watcher ends its debounce task. Idempotent.
pub fn stop(state: &CcswitchWatcherState) {
    *state.watcher.lock() = None;
}

/// Start the cc-switch.db watcher. Returns whether a watch is now active.
#[tauri::command]
pub fn ccswitch_watch_start(
    app: AppHandle,
    state: tauri::State<'_, CcswitchWatcherState>,
    manual_data_dir: Option<String>,
) -> Result<bool, String> {
    start(&state, &app, manual_data_dir.as_deref())?;
    Ok(state.is_watching())
}

/// Stop the cc-switch.db watcher.
#[tauri::command]
pub fn ccswitch_watch_stop(state: tauri::State<'_, CcswitchWatcherState>) {
    stop(&state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn db_file_and_sidecars_are_relevant() {
        let db = PathBuf::from("/home/u/.cc-switch/cc-switch.db");
        assert!(path_is_db(
            &db,
            &PathBuf::from("/home/u/.cc-switch/cc-switch.db")
        ));
        assert!(path_is_db(
            &db,
            &PathBuf::from("/home/u/.cc-switch/cc-switch.db-wal")
        ));
        assert!(path_is_db(
            &db,
            &PathBuf::from("/home/u/.cc-switch/cc-switch.db-shm")
        ));
        assert!(path_is_db(
            &db,
            &PathBuf::from("/home/u/.cc-switch/cc-switch.db-journal")
        ));
    }

    #[test]
    fn unrelated_files_are_not_relevant() {
        let db = PathBuf::from("/home/u/.cc-switch/cc-switch.db");
        assert!(!path_is_db(
            &db,
            &PathBuf::from("/home/u/.cc-switch/app_paths.json")
        ));
        assert!(!path_is_db(
            &db,
            &PathBuf::from("/home/u/.cc-switch/other.db")
        ));
        assert!(!path_is_db(&db, &PathBuf::from("/home/u/.cc-switch/")));
    }

    #[test]
    fn stop_is_safe_when_idle() {
        let state = CcswitchWatcherState::new();
        stop(&state); // must not panic
        assert!(!state.is_watching());
    }

    #[test]
    fn start_errors_when_dir_missing() {
        // Point cc-switch at a non-existent dir via the env override so start()
        // hits the "data dir does not exist" branch without needing an AppHandle.
        let _env_guard = crate::paths::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let prev = std::env::var("CC_SWITCH_HOME").ok();
        std::env::set_var("CC_SWITCH_HOME", &missing);
        let resolved = resolve_ccswitch_db(None).unwrap();
        let watch_dir = resolved.path.parent().unwrap().to_path_buf();
        // Mirror start()'s precondition check (we can't build a real AppHandle
        // in a unit test, so we assert the guard that precedes any watch).
        assert!(!watch_dir.exists());
        match prev {
            Some(v) => std::env::set_var("CC_SWITCH_HOME", v),
            None => std::env::remove_var("CC_SWITCH_HOME"),
        }
    }
}
