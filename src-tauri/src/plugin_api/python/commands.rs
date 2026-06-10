//! The `plugin_python_*` Tauri command family.
//!
//! Exact contract counterpart of the Python section in
//! `lib/plugin/core/manager.ts` (PythonRuntimeInfo at :226,
//! PythonPluginInfo at :236, call sites :693 and :2823-2917). Invoke args
//! arrive camelCase and map onto the snake_case fn params automatically;
//! the info structs keep snake_case field names on the wire because the TS
//! interfaces declare them that way.
//!
//! Gate order is load/call/call_tool: `python:execute` permission FIRST
//! (PermissionDenied), interpreter availability second (PythonUnavailable).
//! Tests pin this ordering.

use std::fs;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use super::discover::{discover_interpreter, Interpreter};
use super::protocol::{PluginHost, CALL_TIMEOUT, CONTROL_TIMEOUT};
use super::PythonRuntimeState;
use crate::plugin_api::{PluginError, PluginRuntimeState, Result};

/// Embedded host script, written to `<python_dir>/host.py` at initialize.
const HOST_SCRIPT: &str = include_str!("host.py");

const PYTHON_EXECUTE_PERMISSION: &str = "python:execute";

/// Host-level per-plugin settings (user state persisted renderer-side in
/// Dexie; Rust stays stateless — settings ride on every `plugin_python_load`).
/// Wire-exact counterpart of `PythonHostSettings` in `types/plugin/plugin.ts`.
///
/// There is deliberately no `lazySpawn` knob: the first load must be eager
/// (dependency validation + tool/hook collection); the perf win comes from
/// `idleShutdownMin` demotion + transparent respawn.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PythonHostSettings {
    /// Absolute interpreter override for this plugin (beats venv + global).
    pub interpreter_path: Option<String>,
    /// Extra environment variables for the host process.
    pub env: std::collections::HashMap<String, String>,
    /// Per-plugin override of the 120s call timeout.
    pub call_timeout_ms: Option<u64>,
    /// `false` opts out of an existing venv (default: use it when present).
    pub use_venv: Option<bool>,
    /// Idle minutes before demotion to lazy; 0/absent = never.
    pub idle_shutdown_min: Option<u64>,
    /// In-flight request cap (default 4).
    pub max_concurrent_calls: Option<usize>,
    /// ADR-0028 Phase 3 — run the interpreter under the OS sandbox
    /// (`bwrap` / `sandbox-exec`) on Linux/macOS. Off by default; Windows is
    /// not wrapped yet (its restricted-token runner can't host a long-lived
    /// stdio JSON-RPC process). A sandboxed spawn fails closed when no backend
    /// is available.
    pub sandboxed: Option<bool>,
}

/// Wire-exact match for `PythonRuntimeInfo` (manager.ts:226-233); extra
/// fields are additive (TS ignores unknown members).
#[derive(Debug, Clone, Serialize)]
pub struct PythonRuntimeInfo {
    pub available: bool,
    pub version: Option<String>,
    pub plugin_count: usize,
    pub lazy_hosts: usize,
    pub total_calls: u64,
    pub total_execution_time_ms: u64,
    pub failed_calls: u64,
}

/// Wire-exact match for `PythonPluginInfo` (manager.ts:236-240).
#[derive(Debug, Clone, Serialize)]
pub struct PythonPluginInfo {
    pub plugin_id: String,
    pub tool_count: usize,
    pub hook_count: usize,
}

// ============================================================================
// Commands (thin wrappers around testable `*_inner` fns, per lifecycle.rs)
// ============================================================================

#[tauri::command]
pub async fn plugin_python_initialize(
    app: tauri::AppHandle,
    state: State<'_, PythonRuntimeState>,
    python_path: Option<String>,
) -> Result<()> {
    // Install the renderer event sink first so hosts loaded right after
    // initialization stream their notifications.
    *state.event_sink.write() = Some(super::events::tauri_sink(app));
    state.ensure_sweep_started(std::time::Duration::from_secs(60));
    // The probe runs subprocesses synchronously — keep it off the async core.
    let interpreter =
        tokio::task::spawn_blocking(move || discover_interpreter(python_path.as_deref()))
            .await
            .map_err(|e| PluginError::Internal(format!("probe task panicked: {e}")))?;
    apply_initialize(&state, interpreter)
}

#[tauri::command]
pub async fn plugin_python_runtime_info(
    state: State<'_, PythonRuntimeState>,
) -> Result<PythonRuntimeInfo> {
    Ok(runtime_info_inner(&state))
}

#[tauri::command]
pub async fn plugin_python_load(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    plugin_path: String,
    main_module: String,
    dependencies: Option<Vec<String>>,
    config: Option<Value>,
    host_settings: Option<PythonHostSettings>,
) -> Result<Value> {
    load_inner(
        &state,
        &plugins,
        plugin_id,
        plugin_path,
        main_module,
        dependencies,
        config,
        host_settings.unwrap_or_default(),
    )
    .await
}

/// Dispatch one registered `@hook` handler inside the plugin's host.
#[tauri::command]
pub async fn plugin_python_call_hook(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    event: String,
    name: String,
    payload: Value,
) -> Result<Value> {
    call_hook_inner(&state, &plugins, plugin_id, event, name, payload).await
}

/// Push the plugin's persisted config into the host (`on_config_updated`).
#[tauri::command]
pub async fn plugin_python_push_config(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    config: Value,
) -> Result<()> {
    push_config_inner(&state, &plugins, plugin_id, config).await
}

#[tauri::command]
pub async fn plugin_python_get_tools(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
) -> Result<Value> {
    let host = state.materialize(&plugin_id).await?;
    host.request("get_tools", json!({}), CONTROL_TIMEOUT).await
}

#[tauri::command]
pub async fn plugin_python_call_tool(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    tool_name: String,
    args: Value,
) -> Result<Value> {
    call_tool_inner(&state, &plugins, plugin_id, tool_name, args).await
}

#[tauri::command]
pub async fn plugin_python_call(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    function_name: String,
    args: Vec<Value>,
) -> Result<Value> {
    call_inner(&state, &plugins, plugin_id, function_name, args).await
}

#[tauri::command]
pub async fn plugin_python_is_initialized(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
) -> Result<bool> {
    // A demoted (lazy) plugin is still "initialized" — its tools are
    // registered and the next call respawns transparently.
    match state.host(&plugin_id) {
        Some(host) => Ok(host.ping().await),
        None => Ok(state.loaded(&plugin_id)),
    }
}

#[tauri::command]
pub async fn plugin_python_get_info(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
) -> Result<Option<PythonPluginInfo>> {
    Ok(get_info_inner(&state, &plugin_id))
}

/// Create the plugin's venv (if missing) and `pip install` its declared
/// dependencies, streaming progress events. The renderer invokes this only
/// after explicit user consent.
#[tauri::command]
pub async fn plugin_python_install_deps(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    dependencies: Vec<String>,
) -> Result<()> {
    install_deps_inner(&state, &plugins, &plugin_id, &dependencies).await
}

#[tauri::command]
pub async fn plugin_python_unload(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
) -> Result<()> {
    unload_inner(&state, &plugin_id).await
}

#[tauri::command]
pub async fn plugin_python_list(state: State<'_, PythonRuntimeState>) -> Result<Vec<String>> {
    Ok(state.hosts.read().keys().cloned().collect())
}

// ============================================================================
// Inner implementations
// ============================================================================

/// Store the probe outcome. `None` (no usable interpreter) is a supported
/// configuration: warn once and report `available: false` — never an error.
fn apply_initialize(state: &PythonRuntimeState, interpreter: Option<Interpreter>) -> Result<()> {
    match interpreter {
        Some(interp) => {
            fs::create_dir_all(&state.python_dir)?;
            fs::write(state.host_script_path(), HOST_SCRIPT)?;
            log::info!(
                "python runtime initialized: {} ({})",
                interp.argv_prefix.join(" "),
                interp.version
            );
            *state.interpreter.write() = Some(interp);
        }
        None => {
            log::warn!(
                "python runtime unavailable: no python >= 3.9 found — python plugins disabled"
            );
            *state.interpreter.write() = None;
        }
    }
    Ok(())
}

fn runtime_info_inner(state: &PythonRuntimeState) -> PythonRuntimeInfo {
    let interpreter = state.interpreter.read();
    PythonRuntimeInfo {
        available: interpreter.is_some(),
        version: interpreter.as_ref().map(|i| i.version.clone()),
        plugin_count: state.hosts.read().len(),
        lazy_hosts: state.lazy_count(),
        total_calls: state.counters.total_calls.load(Ordering::Relaxed),
        total_execution_time_ms: state
            .counters
            .total_execution_time_ms
            .load(Ordering::Relaxed),
        failed_calls: state.counters.failed_calls.load(Ordering::Relaxed),
    }
}

fn check_execute_grant(plugins: &PluginRuntimeState, plugin_id: &str) -> Result<()> {
    if plugins.has_permission(plugin_id, PYTHON_EXECUTE_PERMISSION) {
        return Ok(());
    }
    Err(PluginError::PermissionDenied {
        plugin_id: plugin_id.to_string(),
        permission: PYTHON_EXECUTE_PERMISSION.to_string(),
    })
}

fn require_interpreter(state: &PythonRuntimeState) -> Result<Interpreter> {
    state.interpreter.read().clone().ok_or_else(|| {
        PluginError::PythonUnavailable(
            "runtime not initialized or no python >= 3.9 interpreter found — \
             call plugin_python_initialize first"
                .into(),
        )
    })
}

fn require_host(state: &PythonRuntimeState, plugin_id: &str) -> Result<std::sync::Arc<PluginHost>> {
    state
        .host(plugin_id)
        .ok_or_else(|| PluginError::NotFound(format!("python plugin not loaded: {plugin_id}")))
}

/// Interpreter resolution order: explicit per-plugin override → installed
/// venv (unless opted out) → globally probed interpreter. Initialization is
/// required in every case (host.py must have been written).
fn resolve_plugin_interpreter(
    state: &PythonRuntimeState,
    plugin_id: &str,
    settings: &PythonHostSettings,
) -> Result<Interpreter> {
    if let Some(path) = settings
        .interpreter_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        require_interpreter(state)?;
        // Explicit user choice: trusted as-is; a bad path fails at spawn
        // with an actionable message.
        return Ok(Interpreter { argv_prefix: vec![path.to_string()], version: "custom".into() });
    }
    if settings.use_venv.unwrap_or(true) {
        if let Some(venv_interp) = super::venv::venv_interpreter(&state.python_dir, plugin_id) {
            require_interpreter(state)?;
            return Ok(venv_interp);
        }
    }
    require_interpreter(state)
}

#[allow(clippy::too_many_arguments)]
async fn load_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    plugin_path: String,
    main_module: String,
    dependencies: Option<Vec<String>>,
    config: Option<Value>,
    settings: PythonHostSettings,
) -> Result<Value> {
    // Gate order: permission beats availability (tests pin this).
    check_execute_grant(plugins, &plugin_id)?;
    let interpreter = resolve_plugin_interpreter(state, &plugin_id, &settings)?;

    let host_script = state.host_script_path();
    if !host_script.is_file() {
        return Err(PluginError::PythonUnavailable(
            "host script missing — call plugin_python_initialize first".into(),
        ));
    }

    // Reload semantics: replace any existing host for this plugin.
    // (Bind before awaiting — `if let` would hold the lock guard across
    // the await and make the future non-Send.)
    let existing = state.hosts.write().remove(&plugin_id);
    if let Some(existing) = existing {
        if let super::PythonHostSlot::Spawned(host) = existing.slot {
            host.shutdown().await;
        }
    }

    let import_params = json!({
        "plugin_path": plugin_path,
        "main_module": main_module,
        "dependencies": dependencies,
        "config": config,
    });
    let sandboxed = settings.sandboxed.unwrap_or(false);
    let spec = super::RespawnSpec {
        interpreter: interpreter.clone(),
        host_script: host_script.clone(),
        import_params: import_params.clone(),
        env: settings.env.clone(),
        max_concurrent_calls: settings.max_concurrent_calls,
        idle_shutdown_min: settings.idle_shutdown_min.unwrap_or(0),
        call_timeout_ms: settings.call_timeout_ms,
        sandboxed,
    };

    let host = PluginHost::spawn(
        &plugin_id,
        &interpreter,
        &host_script,
        super::protocol::HostOptions {
            sink: state.sink(),
            max_concurrent_calls: settings.max_concurrent_calls,
            env: settings.env,
            sandboxed,
        },
    )
    .await?;
    let import_timeout = spec
        .call_timeout_ms
        .map(|ms| Duration::from_millis(ms.clamp(1_000, 3_600_000)))
        .unwrap_or(CALL_TIMEOUT);
    let info = match host.request("import_main", import_params, import_timeout).await {
        Ok(info) => info,
        Err(err) => {
            host.kill().await;
            return Err(err);
        }
    };

    let tool_count = info.get("tool_count").and_then(Value::as_u64).unwrap_or(0) as usize;
    let hook_count = info.get("hook_count").and_then(Value::as_u64).unwrap_or(0) as usize;

    state.hosts.write().insert(
        plugin_id,
        super::HostEntry {
            slot: super::PythonHostSlot::Spawned(host),
            spec,
            tool_count,
            hook_count,
        },
    );
    Ok(info)
}

async fn call_tool_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    tool_name: String,
    args: Value,
) -> Result<Value> {
    check_execute_grant(plugins, &plugin_id)?;
    let host = state.materialize(&plugin_id).await?;
    let timeout = state.call_timeout(&plugin_id);
    let started = Instant::now();
    let result = host
        .request("call_tool", json!({ "name": tool_name, "args": args }), timeout)
        .await;
    state
        .counters
        .record(started.elapsed().as_millis() as u64, result.is_err());
    result
}

async fn call_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    function_name: String,
    args: Vec<Value>,
) -> Result<Value> {
    check_execute_grant(plugins, &plugin_id)?;
    if function_name.starts_with('_') {
        // host.py rejects these too — fail fast without a round-trip.
        return Err(PluginError::InvalidArgument(format!(
            "private function names are not callable: {function_name}"
        )));
    }
    let host = state.materialize(&plugin_id).await?;
    let timeout = state.call_timeout(&plugin_id);
    let started = Instant::now();
    let result = host
        .request(
            "call",
            json!({ "function_name": function_name, "args": args }),
            timeout,
        )
        .await;
    state
        .counters
        .record(started.elapsed().as_millis() as u64, result.is_err());
    result
}

fn get_info_inner(state: &PythonRuntimeState, plugin_id: &str) -> Option<PythonPluginInfo> {
    state.entry_counts(plugin_id).map(|(tool_count, hook_count)| PythonPluginInfo {
        plugin_id: plugin_id.to_string(),
        tool_count,
        hook_count,
    })
}

async fn call_hook_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    event: String,
    name: String,
    payload: Value,
) -> Result<Value> {
    check_execute_grant(plugins, &plugin_id)?;
    let host = state.materialize(&plugin_id).await?;
    let timeout = state.call_timeout(&plugin_id);
    let started = Instant::now();
    let result = host
        .request(
            "call_hook",
            json!({ "event": event, "name": name, "payload": payload }),
            timeout,
        )
        .await;
    state
        .counters
        .record(started.elapsed().as_millis() as u64, result.is_err());
    result
}

/// Config pushes only reach live hosts — a demoted (lazy) host picks the
/// fresh config up at respawn via its import params, so materializing one
/// just to deliver config would defeat idle shutdown.
async fn push_config_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    config: Value,
) -> Result<()> {
    check_execute_grant(plugins, &plugin_id)?;
    // Keep respawn params in sync first so a later materialize imports with
    // the new config.
    {
        let mut hosts = state.hosts.write();
        if let Some(entry) = hosts.get_mut(&plugin_id) {
            entry.spec.import_params["config"] = config.clone();
        } else {
            return Err(PluginError::NotFound(format!(
                "python plugin not loaded: {plugin_id}"
            )));
        }
    }
    let Some(host) = state.host(&plugin_id) else {
        return Ok(()); // lazy — config lands at next respawn
    };
    host.request("push_config", json!({ "config": config }), CONTROL_TIMEOUT)
        .await
        .map(|_| ())
}

async fn install_deps_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: &str,
    dependencies: &[String],
) -> Result<()> {
    // Same gate order as load: permission first, availability second.
    check_execute_grant(plugins, plugin_id)?;
    let base = require_interpreter(state)?;
    let sink = state.sink();
    let venv_dir = super::venv::ensure_venv(&base, &state.python_dir, plugin_id, &sink).await?;
    let venv_python = super::venv::venv_python(&venv_dir);
    super::venv::install_deps(&venv_python, dependencies, plugin_id, &sink).await
}

async fn unload_inner(state: &PythonRuntimeState, plugin_id: &str) -> Result<()> {
    // Bind before awaiting — see load_inner's reload note.
    let entry = state.hosts.write().remove(plugin_id);
    if let Some(super::HostEntry { slot: super::PythonHostSlot::Spawned(host), .. }) = entry {
        host.shutdown().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_api::PermissionGrant;
    use tempfile::TempDir;

    fn py_state(tmp: &TempDir) -> PythonRuntimeState {
        PythonRuntimeState::new(tmp.path().join("python"))
    }

    fn plugins_state(tmp: &TempDir) -> PluginRuntimeState {
        PluginRuntimeState::new(tmp.path().join("plugins"))
    }

    fn grant_execute(plugins: &PluginRuntimeState, plugin_id: &str) {
        plugins.permissions.write().insert(
            plugin_id.into(),
            vec![PermissionGrant {
                plugin_id: plugin_id.into(),
                permission: PYTHON_EXECUTE_PERMISSION.into(),
                granted_by: "test".into(),
                granted_at: chrono::Utc::now().to_rfc3339(),
                expires_at: None,
            }],
        );
    }

    #[test]
    fn apply_initialize_none_reports_unavailable_without_error() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        apply_initialize(&state, None).unwrap();

        let info = runtime_info_inner(&state);
        assert!(!info.available);
        assert_eq!(info.version, None);
        assert_eq!(info.plugin_count, 0);
        // host.py must not be written when there is nothing to run it with.
        assert!(!state.host_script_path().exists());
    }

    #[test]
    fn apply_initialize_some_writes_host_script() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        apply_initialize(
            &state,
            Some(Interpreter {
                argv_prefix: vec!["python".into()],
                version: "3.12.0".into(),
            }),
        )
        .unwrap();

        let info = runtime_info_inner(&state);
        assert!(info.available);
        assert_eq!(info.version.as_deref(), Some("3.12.0"));
        let written = std::fs::read_to_string(state.host_script_path()).unwrap();
        assert!(written.contains("Cognia Python plugin host"));
    }

    #[tokio::test]
    async fn load_without_grant_is_permission_denied_even_uninitialized() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        // No grant AND no interpreter: the permission gate must win.
        let err =
            load_inner(
                &state,
                &plugins,
                "demo".into(),
                "/p".into(),
                "main.py".into(),
                None,
                None,
                PythonHostSettings::default(),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
    }

    #[tokio::test]
    async fn load_without_initialize_is_python_unavailable() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "demo");
        let err =
            load_inner(
                &state,
                &plugins,
                "demo".into(),
                "/p".into(),
                "main.py".into(),
                None,
                None,
                PythonHostSettings::default(),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::PythonUnavailable(_)));
    }

    #[tokio::test]
    async fn call_tool_without_grant_is_permission_denied() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        let err = call_tool_inner(&state, &plugins, "demo".into(), "t".into(), json!({}))
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
    }

    #[tokio::test]
    async fn call_rejects_private_function_names() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "demo");
        let err = call_inner(&state, &plugins, "demo".into(), "_secret".into(), vec![])
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::InvalidArgument(_)));
    }

    #[tokio::test]
    async fn call_on_unloaded_plugin_is_not_found() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "demo");
        let err = call_inner(&state, &plugins, "demo".into(), "fn".into(), vec![])
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::NotFound(_)));
    }

    #[tokio::test]
    async fn call_hook_and_push_config_gates() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        // Permission first.
        let err = call_hook_inner(&state, &plugins, "demo".into(), "e".into(), "h".into(), json!({}))
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
        let err = push_config_inner(&state, &plugins, "demo".into(), json!({}))
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
        // Granted but never loaded → NotFound.
        grant_execute(&plugins, "demo");
        let err = call_hook_inner(&state, &plugins, "demo".into(), "e".into(), "h".into(), json!({}))
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::NotFound(_)));
        let err = push_config_inner(&state, &plugins, "demo".into(), json!({}))
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::NotFound(_)));
    }

    #[test]
    fn host_settings_deserialize_camel_case_with_defaults() {
        let settings: PythonHostSettings = serde_json::from_value(json!({
            "interpreterPath": "C:/py/python.exe",
            "callTimeoutMs": 5000,
            "useVenv": false,
            "idleShutdownMin": 15,
            "maxConcurrentCalls": 2,
            "env": {"A": "1"},
        }))
        .unwrap();
        assert_eq!(settings.interpreter_path.as_deref(), Some("C:/py/python.exe"));
        assert_eq!(settings.call_timeout_ms, Some(5000));
        assert_eq!(settings.use_venv, Some(false));
        assert_eq!(settings.idle_shutdown_min, Some(15));
        assert_eq!(settings.max_concurrent_calls, Some(2));
        assert_eq!(settings.env.get("A").map(String::as_str), Some("1"));
        // Empty object → all defaults.
        let settings: PythonHostSettings = serde_json::from_value(json!({})).unwrap();
        assert!(settings.interpreter_path.is_none());
        assert!(settings.env.is_empty());
    }

    #[test]
    fn interpreter_resolution_override_beats_venv_beats_global() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        apply_initialize(
            &state,
            Some(Interpreter { argv_prefix: vec!["python".into()], version: "3.12.0".into() }),
        )
        .unwrap();

        // Global only.
        let interp =
            resolve_plugin_interpreter(&state, "demo", &PythonHostSettings::default()).unwrap();
        assert_eq!(interp.version, "3.12.0");

        // Fake a venv: it wins over global.
        let venv = super::super::venv::venv_dir(&state.python_dir, "demo");
        let python = super::super::venv::venv_python(&venv);
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "").unwrap();
        std::fs::write(
            venv.join(super::super::venv::VENV_MARKER),
            r#"{"version":"3.13.0"}"#,
        )
        .unwrap();
        let interp =
            resolve_plugin_interpreter(&state, "demo", &PythonHostSettings::default()).unwrap();
        assert_eq!(interp.version, "3.13.0");

        // useVenv=false opts back to global.
        let interp = resolve_plugin_interpreter(
            &state,
            "demo",
            &PythonHostSettings { use_venv: Some(false), ..Default::default() },
        )
        .unwrap();
        assert_eq!(interp.version, "3.12.0");

        // Explicit path beats everything.
        let interp = resolve_plugin_interpreter(
            &state,
            "demo",
            &PythonHostSettings {
                interpreter_path: Some("D:/custom/python.exe".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(interp.version, "custom");
        assert_eq!(interp.argv_prefix, vec!["D:/custom/python.exe".to_string()]);

        // But still requires initialization.
        let uninit = py_state(&TempDir::new().unwrap());
        let err = resolve_plugin_interpreter(
            &uninit,
            "demo",
            &PythonHostSettings {
                interpreter_path: Some("D:/custom/python.exe".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(matches!(err, PluginError::PythonUnavailable(_)));
    }

    #[tokio::test]
    async fn install_deps_gate_order_permission_then_availability() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        // No grant AND no interpreter: permission gate wins.
        let err = install_deps_inner(&state, &plugins, "demo", &["requests".into()])
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
        // Granted but uninitialized: availability error.
        grant_execute(&plugins, "demo");
        let err = install_deps_inner(&state, &plugins, "demo", &["requests".into()])
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::PythonUnavailable(_)));
    }

    #[tokio::test]
    async fn get_info_unknown_plugin_is_none_and_unload_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        assert!(get_info_inner(&state, "ghost").is_none());
        unload_inner(&state, "ghost").await.unwrap();
        assert!(state.hosts.read().is_empty());
    }

    /// Full lifecycle against a real interpreter. Skips (with a note) on
    /// machines without Python >= 3.9 — GitHub runners ship Python, so CI
    /// exercises this. Covers host.py behavior end-to-end: decorator
    /// collection, signature inference, explicit parameter pass-through,
    /// kwargs unpacking, positional calls, private-name rejection,
    /// non-serializable return errors, and missing-dependency reporting.
    #[tokio::test]
    async fn end_to_end_load_call_unload_with_real_python() {
        let Some(interp) = super::super::discover::discover_interpreter(None) else {
            eprintln!("skipping end_to_end test: no python >= 3.9 interpreter found");
            return;
        };

        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "demo");
        apply_initialize(&state, Some(interp)).unwrap();

        let plugin_dir = tmp.path().join("demo-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("main.py"),
            r#"
from cognia import tool, hook

@tool(description="Doubles a number")
def double(x: int):
    return x * 2

@tool(name="greet", description="Greets", parameters={
    "name": {"type": "string", "required": False, "default": "world"},
})
def greeting(name="world"):
    return "hello " + name

@tool
def bad_return():
    return {1, 2}

@hook("onMessage")
def on_message(payload):
    return payload

def helper(a, b):
    return [a, b]
"#,
        )
        .unwrap();

        let plugin_path = plugin_dir.to_string_lossy().into_owned();
        let load_info = load_inner(
            &state,
            &plugins,
            "demo".into(),
            plugin_path,
            "main.py".into(),
            None,
            None,
            PythonHostSettings::default(),
        )
        .await
        .unwrap();
        // import_main's reply surfaces the declared hooks for TS dispatch.
        assert_eq!(load_info["hooks"][0]["event"], "onMessage");
        assert_eq!(load_info["hooks"][0]["name"], "on_message");

        // Runtime info reflects the loaded host.
        let info = runtime_info_inner(&state);
        assert!(info.available);
        assert_eq!(info.plugin_count, 1);

        // get_tools: inferred + explicit parameter schemas.
        let host = require_host(&state, "demo").unwrap();
        let tools = host.request("get_tools", json!({}), CONTROL_TIMEOUT).await.unwrap();
        let tools = tools.as_array().unwrap();
        assert_eq!(tools.len(), 3);
        let double = tools.iter().find(|t| t["name"] == "double").unwrap();
        assert_eq!(double["description"], "Doubles a number");
        assert_eq!(double["parameters"]["x"]["type"], "number");
        assert_eq!(double["parameters"]["x"]["required"], true);
        let greet = tools.iter().find(|t| t["name"] == "greet").unwrap();
        assert_eq!(greet["parameters"]["name"]["type"], "string");
        assert_eq!(greet["parameters"]["name"]["default"], "world");

        // call_tool: kwargs unpacking + defaults.
        let result =
            call_tool_inner(&state, &plugins, "demo".into(), "double".into(), json!({"x": 21}))
                .await
                .unwrap();
        assert_eq!(result, json!(42));
        let result =
            call_tool_inner(&state, &plugins, "demo".into(), "greet".into(), json!({}))
                .await
                .unwrap();
        assert_eq!(result, json!("hello world"));

        // Non-JSON-serializable return → typed host error.
        let err =
            call_tool_inner(&state, &plugins, "demo".into(), "bad_return".into(), json!({}))
                .await
                .unwrap_err();
        assert!(err.to_string().contains("non-JSON-serializable"));

        // plugin_python_call: module-level positional call.
        let result = call_inner(
            &state,
            &plugins,
            "demo".into(),
            "helper".into(),
            vec![json!(1), json!("z")],
        )
        .await
        .unwrap();
        assert_eq!(result, json!([1, "z"]));

        // Host-side private-name rejection (bypassing the Rust fast-fail).
        let err = host
            .request("call", json!({"function_name": "_hidden", "args": []}), CONTROL_TIMEOUT)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("private"));

        // get_info counts: 3 tools, 1 hook; liveness ping.
        let plugin_info = get_info_inner(&state, "demo").unwrap();
        assert_eq!(plugin_info.tool_count, 3);
        assert_eq!(plugin_info.hook_count, 1);
        assert!(host.ping().await);

        // Counters recorded the calls above (3 ok + 1 failed via call_tool/call).
        let info = runtime_info_inner(&state);
        assert_eq!(info.total_calls, 4);
        assert_eq!(info.failed_calls, 1);

        // Unload terminates and clears.
        unload_inner(&state, "demo").await.unwrap();
        assert!(state.hosts.read().is_empty());
        assert!(get_info_inner(&state, "demo").is_none());
    }

    /// P1.2 surface: streaming generator tools, hook dispatch round-trip,
    /// lifecycle conventions (on_startup / on_config_updated / on_shutdown)
    /// and config delivery — all against a real interpreter.
    #[tokio::test]
    async fn streaming_hooks_and_lifecycle_with_real_python() {
        let Some(interp) = super::super::discover::discover_interpreter(None) else {
            eprintln!("skipping streaming/lifecycle test: no python interpreter found");
            return;
        };

        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "demo");
        apply_initialize(&state, Some(interp)).unwrap();

        // Collect renderer events through the state sink.
        let collected: std::sync::Arc<parking_lot::Mutex<Vec<super::super::events::PythonEvent>>> =
            std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        let sink_target = std::sync::Arc::clone(&collected);
        *state.event_sink.write() =
            Some(std::sync::Arc::new(move |event| sink_target.lock().push(event)));

        let marker = tmp.path().join("lifecycle.txt");
        let plugin_dir = tmp.path().join("demo-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("main.py"),
            format!(
                r#"
import json
from cognia import tool, hook, get_config, progress

MARKER = {marker:?}

def _append(line):
    with open(MARKER, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def on_startup():
    _append("startup:" + json.dumps(get_config(), sort_keys=True))

def on_config_updated(config):
    _append("config:" + json.dumps(config, sort_keys=True))

def on_shutdown():
    _append("shutdown")

@tool(description="Streams three chunks")
def stream_words():
    progress(pct=10, message="starting")
    yield "a"
    yield "b"
    yield "c"

@tool(description="Streams non-string chunks")
def stream_numbers():
    yield 1
    yield 2

@hook("onMessageSend")
def rewrite(payload):
    payload["text"] = payload["text"].upper()
    return payload
"#,
                marker = marker.to_string_lossy()
            ),
        )
        .unwrap();

        let info = load_inner(
            &state,
            &plugins,
            "demo".into(),
            plugin_dir.to_string_lossy().into_owned(),
            "main.py".into(),
            None,
            Some(json!({"greeting": "hi"})),
            PythonHostSettings::default(),
        )
        .await
        .unwrap();
        assert_eq!(info["hooks"][0]["event"], "onMessageSend");
        assert_eq!(info["hooks"][0]["name"], "rewrite");

        // on_startup ran with the delivered config.
        let lifecycle = std::fs::read_to_string(&marker).unwrap();
        assert!(lifecycle.contains(r#"startup:{"greeting": "hi"}"#));

        // Streaming: str chunks join into the terminal reply; chunk events
        // carry the pieces; progress event surfaced too.
        let result =
            call_tool_inner(&state, &plugins, "demo".into(), "stream_words".into(), json!({}))
                .await
                .unwrap();
        assert_eq!(result, json!("abc"));
        {
            let events = collected.lock();
            let chunks: Vec<_> = events.iter().filter(|e| e.kind == "chunk").collect();
            assert_eq!(chunks.len(), 3);
            assert_eq!(chunks[0].data, json!("a"));
            assert!(chunks[0].call_id.is_some());
            assert!(events.iter().any(|e| e.kind == "chunk_end"));
            assert!(events
                .iter()
                .any(|e| e.kind == "progress" && e.data["message"] == "starting"));
        }

        // Non-string chunks come back as a list.
        let result =
            call_tool_inner(&state, &plugins, "demo".into(), "stream_numbers".into(), json!({}))
                .await
                .unwrap();
        assert_eq!(result, json!([1, 2]));

        // Hook round-trip transforms the payload.
        let host = require_host(&state, "demo").unwrap();
        let transformed = host
            .request(
                "call_hook",
                json!({"event": "onMessageSend", "name": "rewrite", "payload": {"text": "hi"}}),
                CONTROL_TIMEOUT,
            )
            .await
            .unwrap();
        assert_eq!(transformed, json!({"text": "HI"}));

        // Unknown hook is a typed error.
        let err = host
            .request(
                "call_hook",
                json!({"event": "onMessageSend", "name": "ghost", "payload": null}),
                CONTROL_TIMEOUT,
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no hook named"));

        // push_config triggers on_config_updated.
        host.request("push_config", json!({"config": {"greeting": "yo"}}), CONTROL_TIMEOUT)
            .await
            .unwrap();
        let lifecycle = std::fs::read_to_string(&marker).unwrap();
        assert!(lifecycle.contains(r#"config:{"greeting": "yo"}"#));

        // Graceful unload runs on_shutdown.
        unload_inner(&state, "demo").await.unwrap();
        let lifecycle = std::fs::read_to_string(&marker).unwrap();
        assert!(lifecycle.contains("shutdown"));
        assert!(state.hosts.read().is_empty());
    }

    /// Idle sweep demotes a spawned host to Lazy; the next call materializes
    /// a fresh subprocess transparently (counts preserved throughout).
    #[tokio::test]
    async fn idle_demotion_then_transparent_respawn() {
        let Some(interp) = super::super::discover::discover_interpreter(None) else {
            eprintln!("skipping idle demotion test: no python interpreter found");
            return;
        };

        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "demo");
        apply_initialize(&state, Some(interp)).unwrap();

        let plugin_dir = tmp.path().join("demo-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("main.py"),
            "from cognia import tool\n\n@tool(description=\"Doubles\")\ndef double(x: int):\n    return x * 2\n",
        )
        .unwrap();
        load_inner(
            &state,
            &plugins,
            "demo".into(),
            plugin_dir.to_string_lossy().into_owned(),
            "main.py".into(),
            None,
            None,
            PythonHostSettings::default(),
        )
        .await
        .unwrap();

        // Arm the idle budget and backdate activity past it.
        let host = require_host(&state, "demo").unwrap();
        state.hosts.write().get_mut("demo").unwrap().spec.idle_shutdown_min = 1;
        host.last_activity.store(0, std::sync::atomic::Ordering::Relaxed);

        super::super::sweep_once(&state.hosts).await;
        assert!(state.host("demo").is_none(), "host must be demoted");
        assert!(state.loaded("demo"), "entry must survive demotion");
        assert_eq!(state.lazy_count(), 1);
        assert_eq!(state.entry_counts("demo"), Some((1, 0)));
        let info = runtime_info_inner(&state);
        assert_eq!(info.plugin_count, 1);

        // Next call respawns transparently and still works.
        let result =
            call_tool_inner(&state, &plugins, "demo".into(), "double".into(), json!({"x": 4}))
                .await
                .unwrap();
        assert_eq!(result, json!(8));
        assert_eq!(state.lazy_count(), 0);
        assert!(state.host("demo").is_some());

        unload_inner(&state, "demo").await.unwrap();
    }

    /// The shipped first-party demo plugin (plugins/cognia-python-demo)
    /// must load and run against the real host — keeps the reference
    /// implementation from bit-rotting.
    #[tokio::test]
    async fn first_party_python_demo_plugin_loads_and_runs() {
        let Some(interp) = super::super::discover::discover_interpreter(None) else {
            eprintln!("skipping demo plugin test: no python interpreter found");
            return;
        };

        let demo_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins")
            .join("cognia-python-demo");
        assert!(demo_dir.join("main.py").is_file(), "demo plugin main.py missing");

        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "cognia-python-demo");
        apply_initialize(&state, Some(interp)).unwrap();

        let info = load_inner(
            &state,
            &plugins,
            "cognia-python-demo".into(),
            demo_dir.to_string_lossy().into_owned(),
            "main.py".into(),
            None,
            Some(json!({"greeting": "Hi", "shout": true})),
            PythonHostSettings::default(),
        )
        .await
        .unwrap();
        assert_eq!(info["tool_count"], 4);
        assert_eq!(info["hooks"][0]["event"], "onMessageSend");

        // Config-aware tool.
        let result = call_tool_inner(
            &state,
            &plugins,
            "cognia-python-demo".into(),
            "greet".into(),
            json!({"name": "world"}),
        )
        .await
        .unwrap();
        assert_eq!(result, json!("HI, WORLD!"));

        // Streaming generator tool joins its chunks.
        let result = call_tool_inner(
            &state,
            &plugins,
            "cognia-python-demo".into(),
            "countdown".into(),
            json!({"start": 2}),
        )
        .await
        .unwrap();
        assert_eq!(result, json!("2... 1... liftoff!"));

        // Transform hook round-trip.
        let host = require_host(&state, "cognia-python-demo").unwrap();
        let stamped = host
            .request(
                "call_hook",
                json!({"event": "onMessageSend", "name": "stamp_outgoing", "payload": {"text": "x"}}),
                CONTROL_TIMEOUT,
            )
            .await
            .unwrap();
        assert_eq!(stamped["metadata"]["pythonDemo"], json!(true));

        unload_inner(&state, "cognia-python-demo").await.unwrap();
    }

    /// Missing pip dependencies must produce the actionable error message.
    #[tokio::test]
    async fn load_with_missing_dependency_reports_pip_install_hint() {
        let Some(interp) = super::super::discover::discover_interpreter(None) else {
            eprintln!("skipping missing-dependency test: no python interpreter found");
            return;
        };

        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "demo");
        apply_initialize(&state, Some(interp)).unwrap();

        let plugin_dir = tmp.path().join("demo-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("main.py"), "x = 1\n").unwrap();

        let err = load_inner(
            &state,
            &plugins,
            "demo".into(),
            plugin_dir.to_string_lossy().into_owned(),
            "main.py".into(),
            Some(vec!["cognia-definitely-missing-pkg>=1.0".into()]),
            None,
            PythonHostSettings::default(),
        )
        .await
        .unwrap_err();
        let message = err.to_string();
        assert!(message.contains("missing Python dependencies"));
        assert!(message.contains("cognia-definitely-missing-pkg"));
        assert!(message.contains("pip install"));
        // Failed load must not leave a host behind.
        assert!(state.hosts.read().is_empty());
    }

    #[test]
    fn runtime_info_serializes_snake_case() {
        let info = PythonRuntimeInfo {
            available: true,
            version: Some("3.12.0".into()),
            plugin_count: 1,
            lazy_hosts: 0,
            total_calls: 2,
            total_execution_time_ms: 3,
            failed_calls: 4,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["plugin_count"], 1);
        assert_eq!(json["total_execution_time_ms"], 3);

        let info = PythonPluginInfo {
            plugin_id: "demo".into(),
            tool_count: 5,
            hook_count: 6,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["plugin_id"], "demo");
        assert_eq!(json["tool_count"], 5);
        assert_eq!(json["hook_count"], 6);
    }
}
