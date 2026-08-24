//! Python plugin runtime — subprocess JSON-RPC host.
//!
//! Backs the `plugin_python_*` Tauri command family invoked by
//! `lib/plugin/core/manager.ts`. Architecture (see
//! `docs/superpowers/specs/2026-06-04-python-plugin-runtime-design.md` and
//! the 2026-06-05 maturation spec): one Python subprocess per loaded plugin
//! running the embedded `host.py`, NDJSON request/response over stdio with
//! id correlation, un-correlated event frames streamed to the renderer.
//! The interpreter is probed once at `plugin_python_initialize`; a machine
//! without Python is a supported configuration (`available: false`), not an
//! error.
//!
//! Loaded plugins are tracked as [`HostEntry`] slots: `Spawned` holds the
//! live subprocess, `Lazy` holds only the [`RespawnSpec`] — the idle sweep
//! demotes long-idle hosts to `Lazy` and the next call transparently
//! respawns them.

pub mod commands;
pub mod discover;
pub mod events;
pub mod protocol;
pub mod venv;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde_json::Value;

use discover::Interpreter;
use events::{EventSink, HostRequestSink};
use protocol::{HostOptions, PluginHost, CALL_TIMEOUT};

use crate::{PluginError, Result};

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
        self.total_execution_time_ms
            .fetch_add(elapsed_ms, Ordering::Relaxed);
        if failed {
            self.failed_calls.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Everything needed to (re)spawn a plugin's host after demotion.
#[derive(Clone)]
pub struct RespawnSpec {
    pub interpreter: Interpreter,
    pub host_script: PathBuf,
    /// Params for the `import_main` request (plugin_path, main_module,
    /// dependencies, config).
    pub import_params: Value,
    pub env: HashMap<String, String>,
    pub max_concurrent_calls: Option<usize>,
    /// Outbound `host_request` gate size; `None` → the protocol default.
    pub max_outbound_host_calls: Option<usize>,
    /// Idle minutes before the sweep demotes the host to `Lazy`; 0 = never.
    pub idle_shutdown_min: u64,
    /// Per-plugin override of [`CALL_TIMEOUT`] (clamped 1s..=3600s).
    pub call_timeout_ms: Option<u64>,
    /// ADR-0028 Phase 3 — carry the OS-sandbox choice across respawns so a host
    /// demoted to lazy and later revived stays sandboxed.
    pub sandboxed: bool,
}

/// Live or dormant host for one loaded plugin.
#[derive(Clone)]
pub enum PythonHostSlot {
    Spawned(Arc<PluginHost>),
    Lazy,
}

/// One loaded plugin: its slot plus respawn spec and cached counts (counts
/// survive demotion so `plugin_python_get_info` stays cheap and correct).
#[derive(Clone)]
pub struct HostEntry {
    pub slot: PythonHostSlot,
    pub spec: RespawnSpec,
    /// Opaque runtime generation. Every callback/unload must present this
    /// value so a stale renderer cannot act on a replacement host.
    pub generation: String,
    pub tool_count: usize,
    pub hook_count: usize,
}

type HostMap = Arc<RwLock<HashMap<String, HostEntry>>>;

/// Tauri-managed state for the Python runtime — separate from
/// `PluginRuntimeState` (different lock granularity: subprocess handles vs
/// install-dir bookkeeping). Registered once via `.manage()` in `lib.rs`.
pub struct PythonRuntimeState {
    /// `<app_data>/cognia/python` — where the embedded host.py is written.
    pub python_dir: PathBuf,
    /// `Some` after a successful `plugin_python_initialize` probe.
    pub interpreter: RwLock<Option<Interpreter>>,
    /// Loaded plugins keyed by plugin id.
    pub hosts: HostMap,
    pub counters: PythonCounters,
    /// Renderer event sink, set once at `plugin_python_initialize` (a
    /// `tauri_sink` in production, a collector in tests). Hosts spawned
    /// before initialization fall back to log-only behavior.
    pub event_sink: RwLock<Option<EventSink>>,
    /// Plugin -> host RPC sink, set alongside `event_sink`. `None` refuses
    /// every `ctx.*` call with a clear error rather than hanging the plugin.
    pub host_request_sink: RwLock<Option<HostRequestSink>>,
    /// Serializes lazy materialization so concurrent first-calls spawn
    /// exactly one subprocess.
    materialize_lock: tokio::sync::Mutex<()>,
    sweep_started: AtomicBool,
}

impl PythonRuntimeState {
    pub fn new(python_dir: PathBuf) -> Self {
        Self {
            python_dir,
            interpreter: RwLock::new(None),
            hosts: Arc::new(RwLock::new(HashMap::new())),
            counters: PythonCounters::default(),
            event_sink: RwLock::new(None),
            host_request_sink: RwLock::new(None),
            materialize_lock: tokio::sync::Mutex::new(()),
            sweep_started: AtomicBool::new(false),
        }
    }

    /// Clone the live host handle for a plugin — `None` when unknown OR
    /// currently demoted (guard dropped before any await).
    pub fn host(&self, plugin_id: &str) -> Option<Arc<PluginHost>> {
        match self
            .hosts
            .read()
            .get(plugin_id)
            .map(|entry| entry.slot.clone())
        {
            Some(PythonHostSlot::Spawned(host)) => Some(host),
            _ => None,
        }
    }

    /// Whether a plugin is loaded at all (spawned or lazy).
    pub fn loaded(&self, plugin_id: &str) -> bool {
        self.hosts.read().contains_key(plugin_id)
    }

    /// Cached `(tool_count, hook_count)` for a loaded plugin.
    pub fn entry_counts(&self, plugin_id: &str) -> Option<(usize, usize)> {
        self.hosts
            .read()
            .get(plugin_id)
            .map(|entry| (entry.tool_count, entry.hook_count))
    }

    /// Atomically snapshot generation and cached contribution counts.
    pub fn entry_metadata(&self, plugin_id: &str) -> Option<(String, usize, usize)> {
        self.hosts
            .read()
            .get(plugin_id)
            .map(|entry| (entry.generation.clone(), entry.tool_count, entry.hook_count))
    }

    /// Current opaque generation for a loaded plugin.
    pub fn generation(&self, plugin_id: &str) -> Option<String> {
        self.hosts
            .read()
            .get(plugin_id)
            .map(|entry| entry.generation.clone())
    }

    /// Atomically bind an operation to one host generation. `Ok(None)` means
    /// the matching generation is loaded lazily and has no live process.
    pub fn host_for_generation(
        &self,
        plugin_id: &str,
        generation: &str,
    ) -> Result<Option<Arc<PluginHost>>> {
        let hosts = self.hosts.read();
        let entry = hosts.get(plugin_id).ok_or_else(|| {
            PluginError::NotFound(format!("python plugin not loaded: {plugin_id}"))
        })?;
        if entry.generation != generation {
            return Err(PluginError::InvalidArgument(format!(
                "stale python plugin generation for {plugin_id}"
            )));
        }
        Ok(match &entry.slot {
            PythonHostSlot::Spawned(host) => Some(Arc::clone(host)),
            PythonHostSlot::Lazy => None,
        })
    }

    /// Number of currently dormant (lazy) entries.
    pub fn lazy_count(&self) -> usize {
        self.hosts
            .read()
            .values()
            .filter(|entry| matches!(entry.slot, PythonHostSlot::Lazy))
            .count()
    }

    /// Clone the renderer event sink (guard dropped before any await).
    pub fn sink(&self) -> Option<EventSink> {
        self.event_sink.read().clone()
    }

    /// Current plugin -> host RPC sink, if one was registered.
    pub fn host_request_sink(&self) -> Option<HostRequestSink> {
        self.host_request_sink.read().clone()
    }

    /// Effective call timeout for a plugin (its override or the default),
    /// clamped to a sane window.
    pub fn call_timeout(&self, plugin_id: &str) -> Duration {
        self.hosts
            .read()
            .get(plugin_id)
            .and_then(|entry| entry.spec.call_timeout_ms)
            .map(|ms| Duration::from_millis(ms.clamp(1_000, 3_600_000)))
            .unwrap_or(CALL_TIMEOUT)
    }

    pub fn host_script_path(&self) -> PathBuf {
        self.python_dir.join("host.py")
    }

    /// Resolve a live host for a plugin, transparently respawning a demoted
    /// one from its [`RespawnSpec`]. Errors with `NotFound` when the plugin
    /// was never loaded.
    pub async fn materialize(&self, plugin_id: &str) -> Result<Arc<PluginHost>> {
        self.materialize_generation(plugin_id, None).await
    }

    /// Resolve exactly one generation. A stale request can keep talking only
    /// to the old host it already captured; it can never respawn or attach to
    /// a replacement generation.
    pub async fn materialize_generation(
        &self,
        plugin_id: &str,
        expected_generation: Option<&str>,
    ) -> Result<Arc<PluginHost>> {
        let assert_generation = |entry: &HostEntry| -> Result<()> {
            if expected_generation.is_some_and(|expected| entry.generation != expected) {
                return Err(PluginError::InvalidArgument(format!(
                    "stale python plugin generation for {plugin_id}"
                )));
            }
            Ok(())
        };
        {
            let hosts = self.hosts.read();
            if let Some(entry) = hosts.get(plugin_id) {
                assert_generation(entry)?;
                if let PythonHostSlot::Spawned(host) = &entry.slot {
                    return Ok(Arc::clone(host));
                }
            }
        }
        // Serialize spawns; double-check after acquiring the lock.
        let _guard = self.materialize_lock.lock().await;
        let (spec, generation) = {
            let hosts = self.hosts.read();
            let entry = hosts.get(plugin_id).ok_or_else(|| {
                PluginError::NotFound(format!("python plugin not loaded: {plugin_id}"))
            })?;
            assert_generation(entry)?;
            if let PythonHostSlot::Spawned(host) = &entry.slot {
                return Ok(Arc::clone(host));
            }
            (entry.spec.clone(), entry.generation.clone())
        };
        let host = PluginHost::spawn(
            plugin_id,
            &spec.interpreter,
            &spec.host_script,
            HostOptions {
                sink: self.sink(),
                host_request_sink: self.host_request_sink(),
                generation: generation.clone(),
                max_concurrent_calls: spec.max_concurrent_calls,
                max_outbound_host_calls: spec.max_outbound_host_calls,
                env: spec.env.clone(),
                sandboxed: spec.sandboxed,
            },
        )
        .await?;
        let info = match host
            .request("import_main", spec.import_params.clone(), CALL_TIMEOUT)
            .await
        {
            Ok(info) => info,
            Err(err) => {
                host.kill().await;
                return Err(err);
            }
        };
        let tool_count = info.get("tool_count").and_then(Value::as_u64).unwrap_or(0) as usize;
        let hook_count = info.get("hook_count").and_then(Value::as_u64).unwrap_or(0) as usize;
        enum PublishOutcome {
            Published,
            Missing,
            Stale,
        }
        let publish_outcome = {
            let mut hosts = self.hosts.write();
            match hosts.get_mut(plugin_id) {
                None => PublishOutcome::Missing,
                Some(entry) if entry.generation != generation => PublishOutcome::Stale,
                Some(entry) => {
                    entry.slot = PythonHostSlot::Spawned(Arc::clone(&host));
                    entry.tool_count = tool_count;
                    entry.hook_count = hook_count;
                    PublishOutcome::Published
                }
            }
        };
        match publish_outcome {
            PublishOutcome::Published => {}
            PublishOutcome::Missing => {
                host.kill().await;
                return Err(PluginError::NotFound(format!(
                    "python plugin unloaded while respawning: {plugin_id}"
                )));
            }
            PublishOutcome::Stale => {
                host.kill().await;
                return Err(PluginError::InvalidArgument(format!(
                    "stale python plugin generation for {plugin_id}"
                )));
            }
        }
        log::info!("[python.{plugin_id}] respawned from lazy slot");
        Ok(host)
    }

    /// Start the background idle sweep once (no-op on later calls).
    pub fn ensure_sweep_started(&self, interval: Duration) {
        if self.sweep_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let hosts = Arc::clone(&self.hosts);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                sweep_once(&hosts).await;
            }
        });
    }
}

/// One idle-sweep pass: demote every spawned host that exceeded its idle
/// budget to `Lazy`, then shut it down. Extracted from the interval task so
/// tests can drive it deterministically.
pub async fn sweep_once(hosts: &HostMap) {
    let candidates: Vec<(String, Arc<PluginHost>, u64)> = hosts
        .read()
        .iter()
        .filter_map(|(id, entry)| match &entry.slot {
            PythonHostSlot::Spawned(host) if entry.spec.idle_shutdown_min > 0 => {
                Some((id.clone(), Arc::clone(host), entry.spec.idle_shutdown_min))
            }
            _ => None,
        })
        .collect();

    for (plugin_id, host, idle_min) in candidates {
        let budget_ms = idle_min.saturating_mul(60_000);
        if host.idle_ms() < budget_ms {
            continue;
        }
        // Demote under the write lock with a re-check (the host may have
        // just served a call or been replaced); shut down outside the lock.
        let demoted = {
            let mut map = hosts.write();
            match map.get_mut(&plugin_id) {
                Some(entry) => match &entry.slot {
                    PythonHostSlot::Spawned(current)
                        if Arc::ptr_eq(current, &host) && host.idle_ms() >= budget_ms =>
                    {
                        entry.slot = PythonHostSlot::Lazy;
                        true
                    }
                    _ => false,
                },
                None => false,
            }
        };
        if demoted {
            log::info!("[python.{plugin_id}] idle for >= {idle_min}min — demoted to lazy");
            host.shutdown().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counters_record_success_and_failure() {
        let counters = PythonCounters::default();
        counters.record(40, false);
        counters.record(60, true);
        assert_eq!(counters.total_calls.load(Ordering::Relaxed), 2);
        assert_eq!(counters.failed_calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            counters.total_execution_time_ms.load(Ordering::Relaxed),
            100
        );
    }

    #[test]
    fn state_starts_uninitialized() {
        let state = PythonRuntimeState::new(PathBuf::from("/tmp/python"));
        assert!(state.interpreter.read().is_none());
        assert!(state.hosts.read().is_empty());
        assert!(state.host("nope").is_none());
        assert!(!state.loaded("nope"));
        assert_eq!(state.lazy_count(), 0);
        assert!(state.entry_counts("nope").is_none());
        assert!(state.host_script_path().ends_with("host.py"));
    }

    #[tokio::test]
    async fn materialize_unknown_plugin_is_not_found() {
        let state = PythonRuntimeState::new(PathBuf::from("/tmp/python"));
        match state.materialize("ghost").await {
            Ok(_) => panic!("materialize of an unknown plugin must fail"),
            Err(err) => assert!(matches!(err, PluginError::NotFound(_))),
        }
    }

    #[test]
    fn python_callbacks_reject_stale_generations() {
        let state = PythonRuntimeState::new(PathBuf::from("/tmp/python"));
        state.hosts.write().insert("demo".into(), lazy_entry(0));

        assert!(commands::plugin_python_assert_generation_for_state(
            &state,
            "demo",
            "test-generation"
        )
        .is_ok());
        assert!(commands::plugin_python_assert_generation_for_state(
            &state,
            "demo",
            "stale-generation"
        )
        .is_err());
    }

    #[test]
    fn host_lookup_is_atomically_bound_to_generation() {
        let state = PythonRuntimeState::new(PathBuf::from("/tmp/python"));
        state.hosts.write().insert("demo".into(), lazy_entry(0));

        assert!(matches!(
            state.host_for_generation("demo", "test-generation"),
            Ok(None)
        ));
        assert!(matches!(
            state.host_for_generation("demo", "stale-generation"),
            Err(PluginError::InvalidArgument(_))
        ));
    }

    #[tokio::test]
    async fn stale_unload_cannot_remove_a_replacement_generation() {
        let state = PythonRuntimeState::new(PathBuf::from("/tmp/python"));
        state.hosts.write().insert("demo".into(), lazy_entry(0));

        assert!(commands::plugin_python_unload_generation_for_state(
            &state,
            "demo",
            "stale-generation"
        )
        .await
        .is_err());
        assert_eq!(state.generation("demo").as_deref(), Some("test-generation"));

        commands::plugin_python_unload_generation_for_state(&state, "demo", "test-generation")
            .await
            .unwrap();
        assert!(!state.loaded("demo"));
    }

    fn lazy_entry(idle_min: u64) -> HostEntry {
        HostEntry {
            slot: PythonHostSlot::Lazy,
            spec: RespawnSpec {
                interpreter: Interpreter {
                    argv_prefix: vec!["python".into()],
                    version: "3.12.0".into(),
                },
                host_script: PathBuf::from("/tmp/host.py"),
                import_params: json!({}),
                env: HashMap::new(),
                max_concurrent_calls: None,
                max_outbound_host_calls: None,
                idle_shutdown_min: idle_min,
                call_timeout_ms: None,
                sandboxed: false,
            },
            generation: "test-generation".into(),
            tool_count: 2,
            hook_count: 1,
        }
    }

    #[test]
    fn lazy_entries_keep_counts_and_are_not_live_hosts() {
        let state = PythonRuntimeState::new(PathBuf::from("/tmp/python"));
        state.hosts.write().insert("demo".into(), lazy_entry(5));
        assert!(state.loaded("demo"));
        assert!(state.host("demo").is_none());
        assert_eq!(state.entry_counts("demo"), Some((2, 1)));
        assert_eq!(state.lazy_count(), 1);
    }

    #[test]
    fn call_timeout_uses_override_clamped_or_default() {
        let state = PythonRuntimeState::new(PathBuf::from("/tmp/python"));
        // Unknown plugin and no-override entries fall back to the default.
        assert_eq!(state.call_timeout("ghost"), CALL_TIMEOUT);
        state.hosts.write().insert("plain".into(), lazy_entry(0));
        assert_eq!(state.call_timeout("plain"), CALL_TIMEOUT);
        // Override applies, clamped to the 1s..=3600s window.
        let mut entry = lazy_entry(0);
        entry.spec.call_timeout_ms = Some(5_000);
        state.hosts.write().insert("custom".into(), entry);
        assert_eq!(state.call_timeout("custom"), Duration::from_secs(5));
        let mut entry = lazy_entry(0);
        entry.spec.call_timeout_ms = Some(1);
        state.hosts.write().insert("tiny".into(), entry);
        assert_eq!(state.call_timeout("tiny"), Duration::from_secs(1));
    }

    #[tokio::test]
    async fn sweep_ignores_lazy_and_zero_budget_entries() {
        let hosts: HostMap = Arc::new(RwLock::new(HashMap::new()));
        hosts.write().insert("lazy".into(), lazy_entry(5));
        hosts.write().insert("never".into(), lazy_entry(0));
        // Must not panic or change anything.
        sweep_once(&hosts).await;
        assert!(matches!(
            hosts.read().get("lazy").unwrap().slot,
            PythonHostSlot::Lazy
        ));
    }
}
