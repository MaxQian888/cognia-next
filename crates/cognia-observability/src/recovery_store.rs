//! Atomic persistence for [`RecoveryStateV1`].
//!
//! The state has to survive exactly the events it exists to handle — a hard
//! kill, an OOM, a panic mid-write — so every save goes through a temp file and
//! a rename. A half-written state file would be worse than none: it would make
//! the recovery controller's own load path the next crash.
//!
//! The file lives under the diagnostics data root, alongside spools and crash
//! reports, and is therefore excluded from WebDAV, settings sync and ordinary
//! business-data backup along with the rest of that tree.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::recovery::RecoveryStateV1;

const STATE_FILE: &str = "recovery-state.json";
const TEMP_FILE: &str = "recovery-state.json.tmp";

#[derive(Debug, thiserror::Error)]
pub enum RecoveryStoreError {
    #[error("recovery state i/o failed at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

fn io_error(path: &Path, source: std::io::Error) -> RecoveryStoreError {
    RecoveryStoreError::Io {
        path: path.display().to_string(),
        source,
    }
}

/// Owns the on-disk copy of the recovery state.
#[derive(Debug, Clone)]
pub struct RecoveryStore {
    dir: PathBuf,
    // Clones share the fixed staging filename and must never write it together.
    writes: Arc<Mutex<()>>,
}

impl RecoveryStore {
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            dir: dir.as_ref().to_path_buf(),
            writes: Arc::new(Mutex::new(())),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(STATE_FILE)
    }

    /// Load the persisted state and adopt `build_id`.
    ///
    /// Three cases collapse to "start fresh": no file, an unreadable file, and
    /// a file from a build we are not running. The third is the load-bearing
    /// one — a new build has not failed yet and must not inherit the previous
    /// build's failure budget, or a shipped fix would boot straight into the
    /// safe shell.
    pub fn load(&self, build_id: &str, at: i64) -> RecoveryStateV1 {
        let path = self.path();
        let Ok(raw) = fs::read_to_string(&path) else {
            return RecoveryStateV1::new(build_id);
        };
        let Ok(mut state) = serde_json::from_str::<RecoveryStateV1>(&raw) else {
            // A corrupt state file is itself a signal, but not one worth
            // refusing to boot over. Start clean.
            return RecoveryStateV1::new(build_id);
        };
        state.adopt_build(build_id, at);
        state
    }

    /// Sync a complete temp file before replacing the previous checkpoint.
    pub fn save(&self, state: &RecoveryStateV1) -> Result<(), RecoveryStoreError> {
        let _guard = self
            .writes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        fs::create_dir_all(&self.dir).map_err(|error| io_error(&self.dir, error))?;
        let temp = self.dir.join(TEMP_FILE);
        let final_path = self.path();
        let encoded = serde_json::to_string_pretty(state).unwrap_or_else(|_| "{}".to_string());
        let mut file = fs::File::create(&temp).map_err(|error| io_error(&temp, error))?;
        file.write_all(encoded.as_bytes())
            .map_err(|error| io_error(&temp, error))?;
        file.sync_all().map_err(|error| io_error(&temp, error))?;
        drop(file);
        fs::rename(&temp, &final_path).map_err(|error| io_error(&final_path, error))?;
        self.sync_directory()?;
        Ok(())
    }

    /// Remove the persisted state. Used by "reset diagnostics" in the safe
    /// shell, never automatically.
    pub fn clear(&self) -> Result<(), RecoveryStoreError> {
        let _guard = self
            .writes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = self.path();
        match fs::remove_file(&path) {
            Ok(()) => self.sync_directory(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(&path, error)),
        }
    }

    fn sync_directory(&self) -> Result<(), RecoveryStoreError> {
        // Sync the rename/removal metadata where opening directories is supported.
        #[cfg(unix)]
        fs::File::open(&self.dir)
            .and_then(|dir| dir.sync_all())
            .map_err(|error| io_error(&self.dir, error))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery::{RecoveryMode, RecoverySubsystem};
    use tempfile::TempDir;

    const T0: i64 = 1_785_000_000_000;

    #[test]
    fn cloned_stores_serialize_concurrent_saves_and_clear() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|worker| {
                let store = store.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let mut failures = Vec::new();
                    for iteration in 0..40 {
                        let mut state = RecoveryStateV1::new("build-1");
                        state.record_unhealthy_start(T0 + worker * 100 + iteration);
                        if let Err(error) = store.save(&state) {
                            failures.push(error.to_string());
                        }
                        if iteration % 5 == 0 {
                            store.clear().expect("concurrent clear");
                        }
                    }
                    failures
                })
            })
            .collect();
        let failures: Vec<_> = workers
            .into_iter()
            .flat_map(|worker| worker.join().expect("worker"))
            .collect();
        assert!(
            failures.is_empty(),
            "{} failed saves; first: {:?}",
            failures.len(),
            failures.first()
        );
        let mut final_state = RecoveryStateV1::new("build-1");
        final_state.record_unhealthy_start(T0);
        final_state.record_unhealthy_start(T0 + 1);
        store.save(&final_state).expect("final checkpoint");
        assert_eq!(store.load("build-1", T0 + 2), final_state);
        assert!(!dir.path().join(TEMP_FILE).exists());
    }

    #[test]
    fn loading_a_missing_file_yields_a_fresh_state() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        let state = store.load("build-1", T0);
        assert_eq!(state.build_id, "build-1");
        assert_eq!(state.mode, RecoveryMode::Normal);
        assert!(state.audit.is_empty());
    }

    #[test]
    fn a_saved_state_round_trips() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        let mut state = RecoveryStateV1::new("build-1");
        state.record_unhealthy_start(T0);
        state.record_checkpoint(
            RecoverySubsystem::Database,
            false,
            Some("db.locked".into()),
            T0,
        );
        store.save(&state).expect("save");

        let loaded = store.load("build-1", T0 + 1);
        assert_eq!(loaded, state);
    }

    #[test]
    fn a_corrupt_file_does_not_block_boot() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        fs::create_dir_all(dir.path()).expect("mkdir");
        fs::write(store.path(), "{ not json at all").expect("write");
        let state = store.load("build-1", T0);
        assert_eq!(state.mode, RecoveryMode::Normal);
        assert_eq!(state.build_id, "build-1");
    }

    #[test]
    fn a_state_from_another_build_starts_a_fresh_failure_window() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        let mut state = RecoveryStateV1::new("build-1");
        state.record_unhealthy_start(T0);
        state.record_unhealthy_start(T0 + 1_000);
        assert_eq!(state.mode, RecoveryMode::Safe);
        store.save(&state).expect("save");

        let loaded = store.load("build-2", T0 + 2_000);
        assert_eq!(
            loaded.mode,
            RecoveryMode::Normal,
            "a shipped fix must not boot into the safe shell"
        );
        assert!(loaded.unhealthy_starts.is_empty());
        assert!(loaded
            .audit
            .iter()
            .any(|entry| entry.code == "recovery.build.changed"));
    }

    #[test]
    fn safe_mode_survives_a_restart_on_the_same_build() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        let mut state = RecoveryStateV1::new("build-1");
        state.record_unhealthy_start(T0);
        state.record_unhealthy_start(T0 + 1_000);
        store.save(&state).expect("save");

        let loaded = store.load("build-1", T0 + 2_000);
        assert_eq!(loaded.mode, RecoveryMode::Safe);
        assert!(loaded.requires_safe_shell());
    }

    #[test]
    fn save_creates_the_directory_when_missing() {
        let dir = TempDir::new().expect("tempdir");
        let nested = dir.path().join("diagnostics").join("recovery");
        let store = RecoveryStore::new(&nested);
        store.save(&RecoveryStateV1::new("build-1")).expect("save");
        assert!(store.path().exists());
    }

    #[test]
    fn save_leaves_no_temp_file_behind() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        store.save(&RecoveryStateV1::new("build-1")).expect("save");
        assert!(!dir.path().join(TEMP_FILE).exists());
    }

    #[test]
    fn a_partially_written_temp_file_does_not_affect_the_load() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        let mut state = RecoveryStateV1::new("build-1");
        state.record_unhealthy_start(T0);
        store.save(&state).expect("save");
        // Simulate a crash between write and rename.
        fs::write(dir.path().join(TEMP_FILE), "{ torn").expect("write");

        let loaded = store.load("build-1", T0 + 1);
        assert_eq!(loaded.unhealthy_starts, vec![T0]);
        state.record_unhealthy_start(T0 + 1);
        store
            .save(&state)
            .expect("replace abandoned temporary file");
        assert_eq!(store.load("build-1", T0 + 2), state);
        assert!(!dir.path().join(TEMP_FILE).exists());
    }

    #[test]
    fn a_failed_staging_write_preserves_the_previous_checkpoint() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        let mut state = RecoveryStateV1::new("build-1");
        state.record_unhealthy_start(T0);
        store.save(&state).expect("initial checkpoint");
        fs::create_dir(dir.path().join(TEMP_FILE)).expect("block staging file");
        let mut next = state.clone();
        next.record_unhealthy_start(T0 + 1);
        assert!(store.save(&next).is_err());
        assert_eq!(store.load("build-1", T0 + 2), state);
    }

    #[test]
    fn clear_removes_the_state_and_is_idempotent() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        store.save(&RecoveryStateV1::new("build-1")).expect("save");
        store.clear().expect("clear");
        assert!(!store.path().exists());
        store.clear().expect("clearing twice is fine");
    }

    #[test]
    fn the_state_file_lives_under_the_configured_directory() {
        let dir = TempDir::new().expect("tempdir");
        let store = RecoveryStore::new(dir.path());
        assert_eq!(store.path(), dir.path().join(STATE_FILE));
    }
}
