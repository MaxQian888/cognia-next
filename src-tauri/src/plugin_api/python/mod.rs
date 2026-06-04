//! Python plugin runtime — subprocess JSON-RPC host.
//!
//! Backs the `plugin_python_*` Tauri command family invoked by
//! `lib/plugin/core/manager.ts`. Architecture (see
//! `docs/superpowers/specs/2026-06-04-python-plugin-runtime-design.md`):
//! one Python subprocess per loaded plugin running the embedded `host.py`,
//! NDJSON request/response over stdio with id correlation. The interpreter
//! is probed once at `plugin_python_initialize`; a machine without Python is
//! a supported configuration (`available: false`), not an error.

pub mod commands;
pub mod discover;
pub mod protocol;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;

use discover::Interpreter;
use protocol::PluginHost;

/// Runtime-wide call statistics surfaced by `plugin_python_runtime_info`.
#[derive(Default)]
pub struct PythonCounters {
    pub total_calls: AtomicU64,
    pub failed_calls: AtomicU64,
    pub total_execution_time_ms: AtomicU64,
}

impl PythonCounters {
    /// Record one completed call (success or failure) with its wall time.
    pub fn record(&self, elapsed_ms: u64, failed: bool) {
        self.total_calls.fetch_add(1, Ordering::Relaxed);
        self.total_execution_time_ms.fetch_add(elapsed_ms, Ordering::Relaxed);
        if failed {
            self.failed_calls.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Tauri-managed state for the Python runtime — separate from
/// `PluginRuntimeState` (different lock granularity: subprocess handles vs
/// install-dir bookkeeping). Registered once via `.manage()` in `lib.rs`.
pub struct PythonRuntimeState {
    /// `<app_data>/cognia/python` — where the embedded host.py is written.
    pub python_dir: PathBuf,
    /// `Some` after a successful `plugin_python_initialize` probe.
    pub interpreter: RwLock<Option<Interpreter>>,
    /// Live host subprocesses keyed by plugin id.
    pub hosts: RwLock<HashMap<String, Arc<PluginHost>>>,
    pub counters: PythonCounters,
}

impl PythonRuntimeState {
    pub fn new(python_dir: PathBuf) -> Self {
        Self {
            python_dir,
            interpreter: RwLock::new(None),
            hosts: RwLock::new(HashMap::new()),
            counters: PythonCounters::default(),
        }
    }

    /// Clone the host handle for a plugin (guard dropped before any await).
    pub fn host(&self, plugin_id: &str) -> Option<Arc<PluginHost>> {
        self.hosts.read().get(plugin_id).cloned()
    }

    pub fn host_script_path(&self) -> PathBuf {
        self.python_dir.join("host.py")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_record_success_and_failure() {
        let counters = PythonCounters::default();
        counters.record(40, false);
        counters.record(60, true);
        assert_eq!(counters.total_calls.load(Ordering::Relaxed), 2);
        assert_eq!(counters.failed_calls.load(Ordering::Relaxed), 1);
        assert_eq!(counters.total_execution_time_ms.load(Ordering::Relaxed), 100);
    }

    #[test]
    fn state_starts_uninitialized() {
        let state = PythonRuntimeState::new(PathBuf::from("/tmp/python"));
        assert!(state.interpreter.read().is_none());
        assert!(state.hosts.read().is_empty());
        assert!(state.host("nope").is_none());
        assert!(state.host_script_path().ends_with("host.py"));
    }
}
