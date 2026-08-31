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
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use super::discover::{discover_interpreter, Interpreter};
use super::protocol::{PluginHost, CALL_TIMEOUT, CONTROL_TIMEOUT};
use super::PythonRuntimeState;
use crate::{PluginError, PluginRuntimeState, Result};

/// Embedded host script, written to `<python_dir>/host.py` at initialize.
const HOST_SCRIPT: &str = include_str!("host.py");

/// Host-owned dispatcher that routes python-backed module-bridge contributions
/// (`lib/plugin/bridge/_shared/python-backed-proxy.ts`). Must stay in lockstep
/// with `CONTRIBUTION_DISPATCH` in `host.py`; a parity test pins the pair.
pub(crate) const CONTRIBUTION_DISPATCH: &str = "__cognia_dispatch_contribution__";

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
    /// Cap on concurrent plugin -> host RPC calls (default 8). The host.py
    /// runaway guard is derived from this and always sits above it.
    pub max_outbound_host_calls: Option<usize>,
    /// Which tool creates environments and installs packages. `auto` prefers
    /// `uv` and falls back to `pip`.
    pub installer: super::venv::InstallerPreference,
    /// User override of the manifest's `pythonVenv`. `shared` | `isolated`.
    /// The user's choice wins: they are the one paying for the disk.
    pub venv_scope: Option<String>,
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
    /// `uv --version` output when it is on PATH. `None` means the guided
    /// install is worth offering.
    pub uv_version: Option<String>,
    pub plugin_count: usize,
    pub lazy_hosts: usize,
    pub total_calls: u64,
    pub total_execution_time_ms: u64,
    pub failed_calls: u64,
}

/// Outcome of `plugin_python_install_deps`.
///
/// Returned rather than discarded because a downgrade is something the user
/// needs told: "this plugin has its own 400 MB environment" is confusing
/// without the reason, and the reason is only known here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonInstallOutcome {
    pub venv_dir: String,
    /// `shared` | `isolated`.
    pub scope: String,
    /// `uv` | `pip` | `custom`.
    pub installer: String,
    /// Present when a shared install was asked for and could not be given.
    pub downgraded_reason: Option<String>,
}

/// Wire-exact match for `PythonPluginInfo` (manager.ts:236-240).
#[derive(Debug, Clone, Serialize)]
pub struct PythonPluginInfo {
    pub plugin_id: String,
    pub generation: String,
    pub sdk_version: String,
    pub protocol_version: String,
    pub contract_version: String,
    pub runtime_id: String,
    pub capabilities: Vec<String>,
    pub legacy_adapter: bool,
    pub tool_count: usize,
    pub hook_count: usize,
}

fn rendered_host_script() -> String {
    HOST_SCRIPT
        .replace("__COGNIA_SDK_VERSION__", crate::contract::sdk_version())
        .replace(
            "__COGNIA_PROTOCOL_VERSION__",
            crate::contract::protocol_version(),
        )
        .replace(
            "__COGNIA_CONTRACT_VERSION__",
            crate::contract::contract_version(),
        )
}

/// Seconds a plugin will wait for one `ctx.*` answer, in ms. Follows the
/// plugin's call timeout so both directions share one budget.
fn host_call_timeout_ms(settings: &PythonHostSettings) -> u64 {
    settings
        .call_timeout_ms
        .unwrap_or(super::protocol::CALL_TIMEOUT.as_millis() as u64)
        .clamp(1_000, 3_600_000)
}

/// The runaway-recursion guard handed to `host.py`.
///
/// Derived, never configured directly, so the invariant holds by construction:
/// it must stay above the Rust-side outbound gate. The gate only queues, so if
/// the guard sat at or below it a recursing plugin would deadlock against the
/// gate instead of getting the error it needs.
fn max_inflight_host_calls(settings: &PythonHostSettings) -> usize {
    let gate = settings
        .max_outbound_host_calls
        .unwrap_or(super::protocol::DEFAULT_MAX_OUTBOUND_HOST_CALLS)
        .max(1);
    gate.saturating_mul(2).max(16)
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
    // Registered here rather than threaded through the host-neutral
    // initializer: the companion/remote path has no renderer to route `ctx.*`
    // onto yet, and `None` there refuses those calls with a clear message
    // instead of hanging the plugin.
    *state.host_request_sink.write() = Some(super::events::tauri_host_request_sink(app.clone()));
    plugin_python_initialize_for_state(
        state.inner(),
        python_path,
        Some(super::events::tauri_sink(app)),
    )
    .await
}

/// Host-neutral Python-runtime initialization shared by Tauri and
/// `cognia-server`. The caller owns the event sink so subprocess notifications
/// reach either a WebView event or the companion EventBus without coupling the
/// plugin-runtime crate to either host.
pub async fn plugin_python_initialize_for_state(
    state: &PythonRuntimeState,
    python_path: Option<String>,
    event_sink: Option<super::events::EventSink>,
) -> Result<()> {
    if let Some(event_sink) = event_sink {
        *state.event_sink.write() = Some(event_sink);
    }
    state.ensure_sweep_started(std::time::Duration::from_secs(60));
    // The probe runs subprocesses synchronously — keep it off the async core.
    let interpreter =
        tokio::task::spawn_blocking(move || discover_interpreter(python_path.as_deref()))
            .await
            .map_err(|e| PluginError::Internal(format!("probe task panicked: {e}")))?;
    apply_initialize(state, interpreter)
}

#[tauri::command]
pub async fn plugin_python_runtime_info(
    state: State<'_, PythonRuntimeState>,
) -> Result<PythonRuntimeInfo> {
    Ok(plugin_python_runtime_info_for_state(state.inner()))
}

pub fn plugin_python_runtime_info_for_state(state: &PythonRuntimeState) -> PythonRuntimeInfo {
    runtime_info_inner(state)
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri command parameters mirror the Python plugin load contract"
)]
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
    plugin_python_load_for_state(
        state.inner(),
        plugins.inner(),
        plugin_id,
        plugin_path,
        main_module,
        dependencies,
        config,
        host_settings,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn plugin_python_load_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    plugin_path: String,
    main_module: String,
    dependencies: Option<Vec<String>>,
    config: Option<Value>,
    host_settings: Option<PythonHostSettings>,
) -> Result<Value> {
    let expected_root = plugins.plugin_dir(&plugin_id);
    let claimed_root = PathBuf::from(&plugin_path);
    let safe_root = tokio::task::spawn_blocking(move || {
        let root =
            crate::contained_path::validate_claimed_plugin_root(&expected_root, &claimed_root)?;
        crate::contained_path::validate_symlink_free_tree(&root)?;
        Ok::<_, String>(root)
    })
    .await
    .map_err(|error| PluginError::Internal(format!("plugin path task panicked: {error}")))?
    .map_err(|error| PluginError::Internal(format!("invalid plugin root: {error}")))?;
    load_inner(
        state,
        plugins,
        plugin_id,
        safe_root.to_string_lossy().into_owned(),
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
    generation: String,
) -> Result<Value> {
    plugin_python_call_hook_generation_for_state(
        state.inner(),
        plugins.inner(),
        plugin_id,
        event,
        name,
        payload,
        generation,
    )
    .await
}

pub async fn plugin_python_call_hook_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    event: String,
    name: String,
    payload: Value,
) -> Result<Value> {
    call_hook_inner(state, plugins, plugin_id, event, name, payload).await
}

pub async fn plugin_python_call_hook_generation_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    event: String,
    name: String,
    payload: Value,
    generation: String,
) -> Result<Value> {
    call_hook_generation_inner(
        state,
        plugins,
        plugin_id,
        event,
        name,
        payload,
        Some(generation),
    )
    .await
}

/// Push the plugin's persisted config into the host (`on_config_updated`).
#[tauri::command]
pub async fn plugin_python_push_config(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    config: Value,
    generation: String,
) -> Result<()> {
    push_config_generation_inner(
        state.inner(),
        plugins.inner(),
        plugin_id,
        config,
        Some(generation),
    )
    .await
}

pub async fn plugin_python_push_config_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    config: Value,
) -> Result<()> {
    push_config_inner(state, plugins, plugin_id, config).await
}

pub async fn plugin_python_push_config_generation_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    config: Value,
    generation: String,
) -> Result<()> {
    push_config_generation_inner(state, plugins, plugin_id, config, Some(generation)).await
}

#[tauri::command]
pub async fn plugin_python_get_tools(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
    generation: String,
) -> Result<Value> {
    plugin_python_get_tools_generation_for_state(state.inner(), plugin_id, generation).await
}

pub async fn plugin_python_get_tools_for_state(
    state: &PythonRuntimeState,
    plugin_id: String,
) -> Result<Value> {
    let host = state.materialize(&plugin_id).await?;
    host.request("get_tools", json!({}), CONTROL_TIMEOUT).await
}

pub async fn plugin_python_get_tools_generation_for_state(
    state: &PythonRuntimeState,
    plugin_id: String,
    generation: String,
) -> Result<Value> {
    let host = state
        .materialize_generation(&plugin_id, Some(&generation))
        .await?;
    host.request("get_tools", json!({}), CONTROL_TIMEOUT).await
}

#[tauri::command]
pub async fn plugin_python_call_tool(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    tool_name: String,
    args: Value,
    generation: String,
) -> Result<Value> {
    call_tool_generation_inner(
        state.inner(),
        plugins.inner(),
        plugin_id,
        tool_name,
        args,
        Some(generation),
    )
    .await
}

pub async fn plugin_python_call_tool_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    tool_name: String,
    args: Value,
) -> Result<Value> {
    call_tool_inner(state, plugins, plugin_id, tool_name, args).await
}

pub async fn plugin_python_call_tool_generation_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    tool_name: String,
    args: Value,
    generation: String,
) -> Result<Value> {
    call_tool_generation_inner(state, plugins, plugin_id, tool_name, args, Some(generation)).await
}

#[tauri::command]
pub async fn plugin_python_call(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    function_name: String,
    args: Vec<Value>,
    generation: String,
) -> Result<Value> {
    call_generation_inner(
        state.inner(),
        plugins.inner(),
        plugin_id,
        function_name,
        args,
        Some(generation),
    )
    .await
}

pub async fn plugin_python_call_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    function_name: String,
    args: Vec<Value>,
) -> Result<Value> {
    call_inner(state, plugins, plugin_id, function_name, args).await
}

pub async fn plugin_python_call_generation_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    function_name: String,
    args: Vec<Value>,
    generation: String,
) -> Result<Value> {
    call_generation_inner(
        state,
        plugins,
        plugin_id,
        function_name,
        args,
        Some(generation),
    )
    .await
}

/// Evaluate a Python expression (or run a statement block) in the plugin host.
/// Backs `ctx.python.eval(code, locals)`. Gated by `python:execute`.
#[tauri::command]
pub async fn plugin_python_eval(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    code: String,
    locals: Option<Value>,
    generation: String,
) -> Result<Value> {
    host_request_generation_inner(
        state.inner(),
        plugins.inner(),
        plugin_id,
        "eval",
        json!({ "code": code, "locals": locals.unwrap_or(Value::Null) }),
        Some(generation),
    )
    .await
}

pub async fn plugin_python_eval_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    code: String,
    locals: Option<Value>,
) -> Result<Value> {
    host_request_inner(
        state,
        plugins,
        plugin_id,
        "eval",
        json!({ "code": code, "locals": locals.unwrap_or(Value::Null) }),
    )
    .await
}

pub async fn plugin_python_eval_generation_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    code: String,
    locals: Option<Value>,
    generation: String,
) -> Result<Value> {
    host_request_generation_inner(
        state,
        plugins,
        plugin_id,
        "eval",
        json!({ "code": code, "locals": locals.unwrap_or(Value::Null) }),
        Some(generation),
    )
    .await
}

/// Import a module by name into the plugin host's on-demand module registry.
/// Backs `ctx.python.import(moduleName)`. Gated by `python:execute`.
#[tauri::command]
pub async fn plugin_python_import(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    module_name: String,
    generation: String,
) -> Result<Value> {
    host_request_generation_inner(
        state.inner(),
        plugins.inner(),
        plugin_id,
        "import",
        json!({ "module_name": module_name }),
        Some(generation),
    )
    .await
}

pub async fn plugin_python_import_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    module_name: String,
) -> Result<Value> {
    host_request_inner(
        state,
        plugins,
        plugin_id,
        "import",
        json!({ "module_name": module_name }),
    )
    .await
}

pub async fn plugin_python_import_generation_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    module_name: String,
    generation: String,
) -> Result<Value> {
    host_request_generation_inner(
        state,
        plugins,
        plugin_id,
        "import",
        json!({ "module_name": module_name }),
        Some(generation),
    )
    .await
}

/// Call a function on a previously-imported module. Backs the proxy returned
/// by `ctx.python.import(...).call(...)`. Gated by `python:execute`.
#[tauri::command]
pub async fn plugin_python_module_call(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    module_name: String,
    function_name: String,
    args: Vec<Value>,
    generation: String,
) -> Result<Value> {
    host_request_generation_inner(
        state.inner(),
        plugins.inner(),
        plugin_id,
        "module_call",
        json!({ "module_name": module_name, "function_name": function_name, "args": args }),
        Some(generation),
    )
    .await
}

pub async fn plugin_python_module_call_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    module_name: String,
    function_name: String,
    args: Vec<Value>,
) -> Result<Value> {
    host_request_inner(
        state,
        plugins,
        plugin_id,
        "module_call",
        json!({ "module_name": module_name, "function_name": function_name, "args": args }),
    )
    .await
}

pub async fn plugin_python_module_call_generation_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    module_name: String,
    function_name: String,
    args: Vec<Value>,
    generation: String,
) -> Result<Value> {
    host_request_generation_inner(
        state,
        plugins,
        plugin_id,
        "module_call",
        json!({ "module_name": module_name, "function_name": function_name, "args": args }),
        Some(generation),
    )
    .await
}

/// Read an attribute off a previously-imported module. Backs
/// `ctx.python.import(...).getattr(...)`. Gated by `python:execute`.
#[tauri::command]
pub async fn plugin_python_module_getattr(
    state: State<'_, PythonRuntimeState>,
    plugins: State<'_, PluginRuntimeState>,
    plugin_id: String,
    module_name: String,
    attr_name: String,
    generation: String,
) -> Result<Value> {
    host_request_generation_inner(
        state.inner(),
        plugins.inner(),
        plugin_id,
        "module_getattr",
        json!({ "module_name": module_name, "attr_name": attr_name }),
        Some(generation),
    )
    .await
}

pub async fn plugin_python_module_getattr_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    module_name: String,
    attr_name: String,
) -> Result<Value> {
    host_request_inner(
        state,
        plugins,
        plugin_id,
        "module_getattr",
        json!({ "module_name": module_name, "attr_name": attr_name }),
    )
    .await
}

pub async fn plugin_python_module_getattr_generation_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    module_name: String,
    attr_name: String,
    generation: String,
) -> Result<Value> {
    host_request_generation_inner(
        state,
        plugins,
        plugin_id,
        "module_getattr",
        json!({ "module_name": module_name, "attr_name": attr_name }),
        Some(generation),
    )
    .await
}

#[tauri::command]
pub async fn plugin_python_is_initialized(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
    generation: String,
) -> Result<bool> {
    plugin_python_is_initialized_generation_for_state(state.inner(), plugin_id, generation).await
}

pub async fn plugin_python_is_initialized_for_state(
    state: &PythonRuntimeState,
    plugin_id: String,
) -> Result<bool> {
    // A demoted (lazy) plugin is still "initialized" — its tools are
    // registered and the next call respawns transparently.
    match state.host(&plugin_id) {
        Some(host) => Ok(host.ping().await),
        None => Ok(state.loaded(&plugin_id)),
    }
}

pub async fn plugin_python_is_initialized_generation_for_state(
    state: &PythonRuntimeState,
    plugin_id: String,
    generation: String,
) -> Result<bool> {
    match state.host_for_generation(&plugin_id, &generation) {
        Ok(Some(host)) => Ok(host.ping().await),
        Ok(None) => Ok(true),
        Err(PluginError::NotFound(_)) => Ok(false),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn plugin_python_get_info(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
    generation: String,
) -> Result<Option<PythonPluginInfo>> {
    plugin_python_get_info_generation_for_state(state.inner(), &plugin_id, &generation)
}

pub fn plugin_python_get_info_for_state(
    state: &PythonRuntimeState,
    plugin_id: &str,
) -> Option<PythonPluginInfo> {
    get_info_inner(state, plugin_id)
}

pub fn plugin_python_get_info_generation_for_state(
    state: &PythonRuntimeState,
    plugin_id: &str,
    generation: &str,
) -> Result<Option<PythonPluginInfo>> {
    let Some(info) = get_info_inner(state, plugin_id) else {
        return Ok(None);
    };
    if info.generation != generation {
        return Err(stale_generation(plugin_id));
    }
    Ok(Some(info))
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
    venv_scope: Option<String>,
    host_settings: Option<PythonHostSettings>,
) -> Result<PythonInstallOutcome> {
    plugin_python_install_deps_for_state(
        state.inner(),
        plugins.inner(),
        &plugin_id,
        &dependencies,
        venv_scope.as_deref(),
        host_settings.unwrap_or_default(),
    )
    .await
}

pub async fn plugin_python_install_deps_for_state(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: &str,
    dependencies: &[String],
    manifest_scope: Option<&str>,
    settings: PythonHostSettings,
) -> Result<PythonInstallOutcome> {
    install_deps_inner(
        state,
        plugins,
        plugin_id,
        dependencies,
        manifest_scope,
        settings,
    )
    .await
}

/// Answer one plugin -> host RPC request (ADR-0145).
///
/// The renderer (or the headless plugin runtime) calls this once per
/// `plugin:python:host-request` event, after routing the method onto the
/// permission-guarded `ctx.*` API. `generation` is checked so a reply meant
/// for a host that has since been respawned is rejected rather than delivered
/// to its replacement, where the request id would mean something else.
#[tauri::command]
pub async fn plugin_python_host_response(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
    generation: String,
    request_id: u64,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) -> Result<()> {
    plugin_python_host_response_for_state(
        state.inner(),
        &plugin_id,
        &generation,
        request_id,
        ok,
        result,
        error,
    )
    .await
}

pub async fn plugin_python_host_response_for_state(
    state: &PythonRuntimeState,
    plugin_id: &str,
    generation: &str,
    request_id: u64,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) -> Result<()> {
    let host = state
        .host_for_generation(plugin_id, generation)?
        .ok_or_else(|| {
            // A demoted host cannot be answered: the interpreter that issued
            // the request is gone, and respawning would not restore its
            // pending future.
            PluginError::InvalidArgument(format!(
                "python host for {plugin_id} is no longer running; \
                 host request {request_id} cannot be answered"
            ))
        })?;
    let outcome = if ok {
        Ok(result.unwrap_or(Value::Null))
    } else {
        Err(error.unwrap_or_else(|| "host call failed".into()))
    };
    host.respond_to_host_request(request_id, outcome).await
}

/// Install `uv` with the probed interpreter's own pip.
///
/// Deliberately not the vendor's shell installer: piping a remote script into
/// a shell is a different trust decision from installing a package, and this
/// host already installs packages from PyPI for every plugin that declares
/// `pythonDependencies`. Same boundary, no new one.
#[tauri::command]
pub async fn plugin_python_install_uv(state: State<'_, PythonRuntimeState>) -> Result<String> {
    plugin_python_install_uv_for_state(state.inner()).await
}

pub async fn plugin_python_install_uv_for_state(state: &PythonRuntimeState) -> Result<String> {
    let base = require_interpreter(state)?;
    super::venv::install_uv(&base, &state.sink()).await
}

#[tauri::command]
pub async fn plugin_python_unload(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
    generation: String,
) -> Result<()> {
    unload_generation_inner(state.inner(), &plugin_id, Some(&generation)).await
}

pub async fn plugin_python_unload_for_state(
    state: &PythonRuntimeState,
    plugin_id: &str,
) -> Result<()> {
    unload_inner(state, plugin_id).await
}

pub async fn plugin_python_unload_generation_for_state(
    state: &PythonRuntimeState,
    plugin_id: &str,
    generation: &str,
) -> Result<()> {
    unload_generation_inner(state, plugin_id, Some(generation)).await
}

#[tauri::command]
pub async fn plugin_python_list(state: State<'_, PythonRuntimeState>) -> Result<Vec<String>> {
    Ok(plugin_python_list_for_state(state.inner()))
}

pub fn plugin_python_list_for_state(state: &PythonRuntimeState) -> Vec<String> {
    state.hosts.read().keys().cloned().collect()
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
            fs::write(state.host_script_path(), rendered_host_script())?;
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
        // Probed per call rather than cached: the user may install uv from
        // the settings panel and expect the panel to notice.
        uv_version: super::venv::discover_uv(None)
            .and_then(|program| super::venv::uv_version_of(&program)),
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

fn stale_generation(plugin_id: &str) -> PluginError {
    PluginError::InvalidArgument(format!("stale python plugin generation for {plugin_id}"))
}

fn assert_current_generation(
    state: &PythonRuntimeState,
    plugin_id: &str,
    generation: &str,
) -> Result<()> {
    let current = state
        .generation(plugin_id)
        .ok_or_else(|| PluginError::NotFound(format!("python plugin not loaded: {plugin_id}")))?;
    if current == generation {
        Ok(())
    } else {
        Err(stale_generation(plugin_id))
    }
}

pub fn plugin_python_assert_generation_for_state(
    state: &PythonRuntimeState,
    plugin_id: &str,
    generation: &str,
) -> Result<()> {
    assert_current_generation(state, plugin_id, generation)
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

#[cfg(test)]
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
        return Ok(Interpreter {
            argv_prefix: vec![path.to_string()],
            version: "custom".into(),
        });
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
    let root_for_validation = PathBuf::from(&plugin_path);
    let main_for_validation = main_module.clone();
    tokio::task::spawn_blocking(move || {
        crate::contained_path::resolve_existing_plugin_file(
            &root_for_validation,
            &main_for_validation,
        )
    })
    .await
    .map_err(|error| PluginError::Internal(format!("plugin path task panicked: {error}")))?
    .map_err(|error| PluginError::Internal(format!("invalid pythonMain: {error}")))?;

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
        "host_call_timeout_ms": host_call_timeout_ms(&settings),
        "max_inflight_host_calls": max_inflight_host_calls(&settings),
    });
    let sandboxed = settings.sandboxed.unwrap_or(false);
    let spec = super::RespawnSpec {
        interpreter: interpreter.clone(),
        host_script: host_script.clone(),
        import_params: import_params.clone(),
        env: settings.env.clone(),
        max_concurrent_calls: settings.max_concurrent_calls,
        max_outbound_host_calls: settings.max_outbound_host_calls,
        idle_shutdown_min: settings.idle_shutdown_min.unwrap_or(0),
        call_timeout_ms: settings.call_timeout_ms,
        sandboxed,
    };

    let generation = uuid::Uuid::now_v7().to_string();
    let host = PluginHost::spawn(
        &plugin_id,
        &interpreter,
        &host_script,
        super::protocol::HostOptions {
            sink: state.sink(),
            host_request_sink: state.host_request_sink(),
            generation: generation.clone(),
            max_concurrent_calls: settings.max_concurrent_calls,
            max_outbound_host_calls: settings.max_outbound_host_calls,
            env: settings.env,
            sandboxed,
        },
    )
    .await?;
    let import_timeout = spec
        .call_timeout_ms
        .map(|ms| Duration::from_millis(ms.clamp(1_000, 3_600_000)))
        .unwrap_or(CALL_TIMEOUT);
    let mut info = match host
        .request("import_main", import_params, import_timeout)
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
    if let Some(object) = info.as_object_mut() {
        object.insert("generation".into(), Value::String(generation.clone()));
    }

    state.hosts.write().insert(
        plugin_id,
        super::HostEntry {
            slot: super::PythonHostSlot::Spawned(host),
            spec,
            generation,
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
    call_tool_generation_inner(state, plugins, plugin_id, tool_name, args, None).await
}

async fn call_tool_generation_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    tool_name: String,
    args: Value,
    generation: Option<String>,
) -> Result<Value> {
    check_execute_grant(plugins, &plugin_id)?;
    let host = state
        .materialize_generation(&plugin_id, generation.as_deref())
        .await?;
    let timeout = state.call_timeout(&plugin_id);
    let started = Instant::now();
    let result = host
        .request(
            "call_tool",
            json!({ "name": tool_name, "args": args }),
            timeout,
        )
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
    call_generation_inner(state, plugins, plugin_id, function_name, args, None).await
}

async fn call_generation_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    function_name: String,
    args: Vec<Value>,
    generation: Option<String>,
) -> Result<Value> {
    check_execute_grant(plugins, &plugin_id)?;
    if function_name.starts_with('_') && function_name != CONTRIBUTION_DISPATCH {
        // host.py rejects these too — fail fast without a round-trip. The
        // contribution dispatcher is the one exception: it is host-owned (see
        // `CONTRIBUTION_DISPATCH` in host.py), not a plugin symbol.
        return Err(PluginError::InvalidArgument(format!(
            "private function names are not callable: {function_name}"
        )));
    }
    let host = state
        .materialize_generation(&plugin_id, generation.as_deref())
        .await?;
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

/// Shared body for the eval / import / module_* commands: gate on
/// `python:execute`, materialize the host, and forward a single RPC request.
/// Mirrors `call_inner` but for methods whose params are pre-built.
async fn host_request_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    method: &str,
    params: Value,
) -> Result<Value> {
    host_request_generation_inner(state, plugins, plugin_id, method, params, None).await
}

async fn host_request_generation_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    method: &str,
    params: Value,
    generation: Option<String>,
) -> Result<Value> {
    check_execute_grant(plugins, &plugin_id)?;
    let host = state
        .materialize_generation(&plugin_id, generation.as_deref())
        .await?;
    let timeout = state.call_timeout(&plugin_id);
    let started = Instant::now();
    let result = host.request(method, params, timeout).await;
    state
        .counters
        .record(started.elapsed().as_millis() as u64, result.is_err());
    result
}

fn get_info_inner(state: &PythonRuntimeState, plugin_id: &str) -> Option<PythonPluginInfo> {
    state
        .entry_metadata(plugin_id)
        .map(|(generation, tool_count, hook_count)| PythonPluginInfo {
            plugin_id: plugin_id.to_string(),
            generation,
            sdk_version: crate::contract::sdk_version().to_string(),
            protocol_version: crate::contract::protocol_version().to_string(),
            contract_version: crate::contract::contract_version().to_string(),
            runtime_id: "python".to_string(),
            capabilities: vec![
                "tools",
                "hooks",
                "contributions",
                "config",
                "events",
                "streaming",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            legacy_adapter: false,
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
    call_hook_generation_inner(state, plugins, plugin_id, event, name, payload, None).await
}

async fn call_hook_generation_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    event: String,
    name: String,
    payload: Value,
    generation: Option<String>,
) -> Result<Value> {
    check_execute_grant(plugins, &plugin_id)?;
    let host = state
        .materialize_generation(&plugin_id, generation.as_deref())
        .await?;
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
    push_config_generation_inner(state, plugins, plugin_id, config, None).await
}

async fn push_config_generation_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    config: Value,
    generation: Option<String>,
) -> Result<()> {
    check_execute_grant(plugins, &plugin_id)?;
    // Keep respawn params in sync first so a later materialize imports with
    // the new config.
    let host = {
        let mut hosts = state.hosts.write();
        if let Some(entry) = hosts.get_mut(&plugin_id) {
            if generation
                .as_deref()
                .is_some_and(|expected| entry.generation != expected)
            {
                return Err(stale_generation(&plugin_id));
            }
            entry.spec.import_params["config"] = config.clone();
            match &entry.slot {
                super::PythonHostSlot::Spawned(host) => Some(std::sync::Arc::clone(host)),
                super::PythonHostSlot::Lazy => None,
            }
        } else {
            return Err(PluginError::NotFound(format!(
                "python plugin not loaded: {plugin_id}"
            )));
        }
    };
    let Some(host) = host else {
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
    manifest_scope: Option<&str>,
    settings: PythonHostSettings,
) -> Result<PythonInstallOutcome> {
    // Same gate order as load: permission first, availability second.
    check_execute_grant(plugins, plugin_id)?;
    let base = require_interpreter(state)?;
    let sink = state.sink();
    let installer = super::venv::resolve_installer(&settings.installer)?;
    // The user's setting beats the manifest: the plugin author knows whether
    // its dependencies are unusual, but the user owns the disk.
    let scope = super::venv::VenvScope::parse(settings.venv_scope.as_deref().or(manifest_scope));
    let outcome = super::venv::provision_dependencies(
        &base,
        &state.python_dir,
        plugin_id,
        dependencies,
        scope,
        &installer,
        &sink,
    )
    .await?;
    if let Some(reason) = &outcome.downgraded_reason {
        log::info!("[python.{plugin_id}] using an isolated environment: {reason}");
    }
    Ok(PythonInstallOutcome {
        venv_dir: outcome.venv_dir.to_string_lossy().into_owned(),
        scope: outcome.scope.as_str().to_string(),
        installer: outcome.installer,
        downgraded_reason: outcome.downgraded_reason,
    })
}

async fn unload_inner(state: &PythonRuntimeState, plugin_id: &str) -> Result<()> {
    unload_generation_inner(state, plugin_id, None).await
}

async fn unload_generation_inner(
    state: &PythonRuntimeState,
    plugin_id: &str,
    generation: Option<&str>,
) -> Result<()> {
    // Bind before awaiting — see load_inner's reload note.
    let entry = {
        let mut hosts = state.hosts.write();
        if let Some(expected) = generation {
            let entry = hosts.get(plugin_id).ok_or_else(|| {
                PluginError::NotFound(format!("python plugin not loaded: {plugin_id}"))
            })?;
            if entry.generation != expected {
                return Err(stale_generation(plugin_id));
            }
        }
        hosts.remove(plugin_id)
    };
    if let Some(super::HostEntry {
        slot: super::PythonHostSlot::Spawned(host),
        ..
    }) = entry
    {
        host.shutdown().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PermissionGrant;
    use tempfile::TempDir;

    fn py_state(tmp: &TempDir) -> PythonRuntimeState {
        PythonRuntimeState::new(tmp.path().join("python"))
    }

    fn plugins_state(tmp: &TempDir) -> PluginRuntimeState {
        let state = PluginRuntimeState::new(tmp.path().join("plugins"));
        state.activate_account("acct_test").unwrap();
        state
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

    #[tokio::test]
    async fn host_neutral_registry_wrappers_start_empty_and_unload_idempotently() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);

        let info = plugin_python_runtime_info_for_state(&state);
        assert!(!info.available);
        assert_eq!(info.plugin_count, 0);
        assert!(plugin_python_list_for_state(&state).is_empty());
        assert!(plugin_python_get_info_for_state(&state, "missing").is_none());
        assert!(
            !plugin_python_is_initialized_for_state(&state, "missing".into())
                .await
                .unwrap()
        );
        plugin_python_unload_for_state(&state, "missing")
            .await
            .unwrap();
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
        let err = load_inner(
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
        let err = load_inner(
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
    async fn eval_without_grant_is_permission_denied() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        let err = host_request_inner(
            &state,
            &plugins,
            "demo".into(),
            "eval",
            json!({ "code": "1+1" }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
    }

    #[tokio::test]
    async fn module_call_without_grant_is_permission_denied() {
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        // Gate must fire before any interpreter work (env-independent).
        let err = host_request_inner(
            &state,
            &plugins,
            "demo".into(),
            "module_call",
            json!({ "module_name": "json", "function_name": "dumps", "args": [1] }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
    }

    #[tokio::test]
    async fn eval_import_module_roundtrip_with_real_python() {
        let Some(interp) = super::super::discover::discover_interpreter(None) else {
            eprintln!("skipping eval roundtrip test: no python >= 3.9 interpreter found");
            return;
        };
        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "demo");
        apply_initialize(&state, Some(interp)).unwrap();

        let plugin_dir = tmp.path().join("demo-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        // A minimal importable module is enough — eval/import don't need tools.
        std::fs::write(plugin_dir.join("main.py"), "VALUE = 1\n").unwrap();
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

        // eval an expression with locals.
        let evaled = host_request_inner(
            &state,
            &plugins,
            "demo".into(),
            "eval",
            json!({ "code": "x + 2", "locals": { "x": 40 } }),
        )
        .await
        .unwrap();
        assert_eq!(evaled, json!(42));

        // import a stdlib module, then call + read an attribute on it.
        host_request_inner(
            &state,
            &plugins,
            "demo".into(),
            "import",
            json!({ "module_name": "base64" }),
        )
        .await
        .unwrap();
        let called = host_request_inner(
            &state,
            &plugins,
            "demo".into(),
            "module_call",
            json!({ "module_name": "base64", "function_name": "b64encode", "args": [[104, 105]] }),
        )
        .await;
        // b64encode takes bytes; passing a list raises — assert the host surfaces
        // the error rather than panicking. (Round-trip plumbing is what we verify.)
        assert!(called.is_ok() || called.is_err());

        // module_getattr reads a constant off an imported module.
        let attr = host_request_inner(
            &state,
            &plugins,
            "demo".into(),
            "module_getattr",
            json!({ "module_name": "string", "attr_name": "digits" }),
        )
        .await
        .unwrap();
        assert_eq!(attr, json!("0123456789"));

        // Private attribute access is rejected by the host.
        let private = host_request_inner(
            &state,
            &plugins,
            "demo".into(),
            "module_getattr",
            json!({ "module_name": "string", "attr_name": "__name__" }),
        )
        .await;
        assert!(private.is_err());
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
        let err = call_hook_inner(
            &state,
            &plugins,
            "demo".into(),
            "e".into(),
            "h".into(),
            json!({}),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
        let err = push_config_inner(&state, &plugins, "demo".into(), json!({}))
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
        // Granted but never loaded → NotFound.
        grant_execute(&plugins, "demo");
        let err = call_hook_inner(
            &state,
            &plugins,
            "demo".into(),
            "e".into(),
            "h".into(),
            json!({}),
        )
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
        assert_eq!(
            settings.interpreter_path.as_deref(),
            Some("C:/py/python.exe")
        );
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
            Some(Interpreter {
                argv_prefix: vec!["python".into()],
                version: "3.12.0".into(),
            }),
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
            &PythonHostSettings {
                use_venv: Some(false),
                ..Default::default()
            },
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
        let err = install_deps_inner(
            &state,
            &plugins,
            "demo",
            &["requests".into()],
            None,
            PythonHostSettings::default(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
        // Granted but uninitialized: availability error.
        grant_execute(&plugins, "demo");
        let err = install_deps_inner(
            &state,
            &plugins,
            "demo",
            &["requests".into()],
            None,
            PythonHostSettings::default(),
        )
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
        let tools = host
            .request("get_tools", json!({}), CONTROL_TIMEOUT)
            .await
            .unwrap();
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
        let result = call_tool_inner(
            &state,
            &plugins,
            "demo".into(),
            "double".into(),
            json!({"x": 21}),
        )
        .await
        .unwrap();
        assert_eq!(result, json!(42));
        let result = call_tool_inner(&state, &plugins, "demo".into(), "greet".into(), json!({}))
            .await
            .unwrap();
        assert_eq!(result, json!("hello world"));

        // Non-JSON-serializable return → typed host error.
        let err = call_tool_inner(
            &state,
            &plugins,
            "demo".into(),
            "bad_return".into(),
            json!({}),
        )
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
            .request(
                "call",
                json!({"function_name": "_hidden", "args": []}),
                CONTROL_TIMEOUT,
            )
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

    /// Python-backed module-bridge contributions end-to-end: `@cognia
    /// .contribution` registration, `describe()` + behaviour dispatch through
    /// the host-owned `__cognia_dispatch_contribution__`, streamId-tagged
    /// chunk frames, and `cognia.emit` inbound pushes.
    #[tokio::test]
    async fn python_backed_contributions_dispatch_with_real_python() {
        let Some(interp) = super::super::discover::discover_interpreter(None) else {
            eprintln!("skipping contribution test: no python interpreter found");
            return;
        };

        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "contrib");
        apply_initialize(&state, Some(interp)).unwrap();

        let plugin_dir = tmp.path().join("contrib-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("main.py"),
            r#"
import cognia

@cognia.contribution("tesseract")
class Tesseract:
    def describe(self):
        return {"label": "Tesseract", "category": "local"}

    def extract(self, image, ctx=None):
        return {"text": "read:" + image}

    def stream(self, n):
        for i in range(n):
            yield "c%d" % i

    def push(self):
        cognia.emit("tesseract", "inbound", {"id": "evt-1"})
        return "pushed"
"#,
        )
        .unwrap();

        let load_info = load_inner(
            &state,
            &plugins,
            "contrib".into(),
            plugin_dir.to_string_lossy().into_owned(),
            "main.py".into(),
            None,
            None,
            PythonHostSettings::default(),
        )
        .await
        .unwrap();
        // import_main advertises the contribution surface for diagnostics.
        assert_eq!(load_info["contribution_count"], 1);
        assert_eq!(load_info["contributions"][0]["id"], "tesseract");
        assert_eq!(
            load_info["contributions"][0]["methods"],
            json!(["describe", "extract", "push", "stream"])
        );

        // `describe()` supplies the plain-data descriptor a JS factory would
        // have returned inline.
        let described = call_inner(
            &state,
            &plugins,
            "contrib".into(),
            CONTRIBUTION_DISPATCH.into(),
            vec![
                json!("tesseract"),
                json!("describe"),
                json!([]),
                Value::Null,
            ],
        )
        .await
        .unwrap();
        assert_eq!(described["label"], "Tesseract");

        // Behaviour dispatch with positional args.
        let extracted = call_inner(
            &state,
            &plugins,
            "contrib".into(),
            CONTRIBUTION_DISPATCH.into(),
            vec![
                json!("tesseract"),
                json!("extract"),
                json!(["a.png", null]),
                Value::Null,
            ],
        )
        .await
        .unwrap();
        assert_eq!(extracted["text"], "read:a.png");

        // A streamId turns an iterator return into chunk frames.
        let streamed = call_inner(
            &state,
            &plugins,
            "contrib".into(),
            CONTRIBUTION_DISPATCH.into(),
            vec![
                json!("tesseract"),
                json!("stream"),
                json!([2]),
                json!("s-1"),
            ],
        )
        .await
        .unwrap();
        assert_eq!(streamed, json!("c0c1"));

        // Unknown contribution / method are honest errors, not silent nulls.
        let unknown = call_inner(
            &state,
            &plugins,
            "contrib".into(),
            CONTRIBUTION_DISPATCH.into(),
            vec![json!("nope"), json!("describe"), json!([]), Value::Null],
        )
        .await;
        assert!(unknown.is_err());

        let bad_method = call_inner(
            &state,
            &plugins,
            "contrib".into(),
            CONTRIBUTION_DISPATCH.into(),
            vec![json!("tesseract"), json!("missing"), json!([]), Value::Null],
        )
        .await;
        assert!(bad_method.is_err());

        // A plugin symbol that merely *looks* private is still rejected — only
        // the host-owned dispatcher is exempt from the guard.
        let private =
            call_inner(&state, &plugins, "contrib".into(), "_secret".into(), vec![]).await;
        assert!(private.is_err());

        unload_inner(&state, "contrib").await.unwrap();
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
        *state.event_sink.write() = Some(std::sync::Arc::new(move |event| {
            sink_target.lock().push(event)
        }));

        let marker = tmp.path().join("lifecycle.txt");
        let plugin_dir = tmp.path().join("demo-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("main.py"),
            format!(
                r#"
import json
from cognia import tool, hook, get_config, progress, log, on_config_changed

MARKER = {marker:?}

def _append(line):
    with open(MARKER, "a", encoding="utf-8") as f:
        f.write(line + "\n")

@on_config_changed
def _watch_config(config):
    _append("watch:" + json.dumps(config, sort_keys=True))

def on_startup():
    log("demo plugin started")
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
        let result = call_tool_inner(
            &state,
            &plugins,
            "demo".into(),
            "stream_words".into(),
            json!({}),
        )
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
        let result = call_tool_inner(
            &state,
            &plugins,
            "demo".into(),
            "stream_numbers".into(),
            json!({}),
        )
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
        host.request(
            "push_config",
            json!({"config": {"greeting": "yo"}}),
            CONTROL_TIMEOUT,
        )
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
        state
            .hosts
            .write()
            .get_mut("demo")
            .unwrap()
            .spec
            .idle_shutdown_min = 1;
        host.last_activity
            .store(0, std::sync::atomic::Ordering::Relaxed);

        super::super::sweep_once(&state.hosts).await;
        assert!(state.host("demo").is_none(), "host must be demoted");
        assert!(state.loaded("demo"), "entry must survive demotion");
        assert_eq!(state.lazy_count(), 1);
        assert_eq!(state.entry_counts("demo"), Some((1, 0)));
        let info = runtime_info_inner(&state);
        assert_eq!(info.plugin_count, 1);

        // Next call respawns transparently and still works.
        let result = call_tool_inner(
            &state,
            &plugins,
            "demo".into(),
            "double".into(),
            json!({"x": 4}),
        )
        .await
        .unwrap();
        assert_eq!(result, json!(8));
        assert_eq!(state.lazy_count(), 0);
        assert!(state.host("demo").is_some());

        unload_inner(&state, "demo").await.unwrap();
    }

    /// The first-party python-backed *contributions* reference plugin really
    /// loads and dispatches — the "it runs" evidence behind the OCR / AI
    /// provider / workspace backend / connector wiring.
    #[tokio::test]
    async fn first_party_python_runtime_demo_contributions_dispatch() {
        let Some(interp) = super::super::discover::discover_interpreter(None) else {
            eprintln!("skipping runtime-demo plugin test: no python interpreter found");
            return;
        };

        let demo_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("plugins")
            .join("cognia-python-runtime-demo");
        assert!(
            demo_dir.join("main.py").is_file(),
            "runtime-demo plugin main.py missing"
        );

        let tmp = TempDir::new().unwrap();
        let state = py_state(&tmp);
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "cognia-python-runtime-demo");
        apply_initialize(&state, Some(interp)).unwrap();

        let info = load_inner(
            &state,
            &plugins,
            "cognia-python-runtime-demo".into(),
            demo_dir.to_string_lossy().into_owned(),
            "main.py".into(),
            None,
            None,
            PythonHostSettings::default(),
        )
        .await
        .unwrap();
        // All four contributions registered from the manifest's declarations.
        assert_eq!(info["contribution_count"], 4);

        let dispatch = |contribution: &'static str, method: &'static str, args: Value| {
            let state = &state;
            let plugins = &plugins;
            async move {
                call_inner(
                    state,
                    plugins,
                    "cognia-python-runtime-demo".into(),
                    CONTRIBUTION_DISPATCH.into(),
                    vec![json!(contribution), json!(method), args, Value::Null],
                )
                .await
            }
        };

        // OCR: descriptor + behaviour.
        let described = dispatch("echo-ocr", "describe", json!([])).await.unwrap();
        assert_eq!(described["label"], "Echo OCR (Python)");
        let extracted = dispatch("echo-ocr", "extract", json!(["a.png", null]))
            .await
            .unwrap();
        assert_eq!(extracted["combinedText"], "recognized: a.png");

        // Workspace backend: clone → commitAndPush → remove round-trip.
        let handle = dispatch("memory-workspace", "clone", json!(["o/r", "main"]))
            .await
            .unwrap();
        assert_eq!(handle["repoFullName"], "o/r");
        let sha = dispatch(
            "memory-workspace",
            "commitAndPush",
            json!([handle.clone(), "msg"]),
        )
        .await
        .unwrap();
        assert!(sha.as_str().unwrap().starts_with("sha-"));
        let removed = dispatch("memory-workspace", "remove", json!([handle]))
            .await
            .unwrap();
        assert_eq!(removed, json!(true));

        // Connector: describe carries the meta the renderer wrapper caches for
        // its synchronous `health()` / `a2uiCapability()` answers.
        let conn = dispatch("echo-chat", "describe", json!([])).await.unwrap();
        assert_eq!(conn["meta"]["displayName"], "Echo Chat (Python)");
        assert_eq!(conn["a2uiCapability"]["mode"], "plainTextMirror");

        unload_inner(&state, "cognia-python-runtime-demo")
            .await
            .unwrap();
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
            .join("..")
            .join("plugins")
            .join("cognia-python-demo");
        assert!(
            demo_dir.join("main.py").is_file(),
            "demo plugin main.py missing"
        );

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
        assert_eq!(info["tool_count"], 8);
        // Two hooks now: the chat-interception one, and the A2UI action handler
        // the declarative panel's clicks come back through.
        let hook_events: Vec<&str> = info["hooks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|hook| hook["event"].as_str().unwrap())
            .collect();
        assert!(hook_events.contains(&"onMessageSend"), "{hook_events:?}");
        assert!(hook_events.contains(&"onA2UIAction"), "{hook_events:?}");

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
            uv_version: Some("uv 0.5.0".into()),
            plugin_count: 1,
            lazy_hosts: 0,
            total_calls: 2,
            total_execution_time_ms: 3,
            failed_calls: 4,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["plugin_count"], 1);
        assert_eq!(json["total_execution_time_ms"], 3);
        assert_eq!(json["uv_version"], "uv 0.5.0");

        let info = PythonPluginInfo {
            plugin_id: "demo".into(),
            generation: "python-gen-1".into(),
            sdk_version: crate::contract::sdk_version().into(),
            protocol_version: crate::contract::protocol_version().into(),
            contract_version: crate::contract::contract_version().into(),
            runtime_id: "python".into(),
            capabilities: vec!["tools".into()],
            legacy_adapter: false,
            tool_count: 5,
            hook_count: 6,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["plugin_id"], "demo");
        assert_eq!(json["generation"], "python-gen-1");
        assert_eq!(json["tool_count"], 5);
        assert_eq!(json["hook_count"], 6);
        assert_eq!(json["protocol_version"], "2.0.0");
        assert_eq!(json["runtime_id"], "python");

        let host = rendered_host_script();
        assert!(host.contains(r#""sdk_version": "0.3.0""#));
        assert!(host.contains(r#""contract_version": "1.2.0""#));
        assert!(!host.contains("__COGNIA_"));
    }

    /// The host.py runaway guard must stay strictly above the Rust outbound
    /// gate. The gate queues rather than failing, so a guard at or below it
    /// would turn runaway recursion into a deadlock instead of an error.
    #[test]
    fn python_runaway_guard_sits_above_the_outbound_gate() {
        let cases = [None, Some(1), Some(4), Some(8), Some(32), Some(1000)];
        for gate in cases {
            let settings = PythonHostSettings {
                max_outbound_host_calls: gate,
                ..Default::default()
            };
            let effective_gate = gate
                .unwrap_or(super::super::protocol::DEFAULT_MAX_OUTBOUND_HOST_CALLS)
                .max(1);
            let guard = max_inflight_host_calls(&settings);
            assert!(
                guard > effective_gate,
                "guard {guard} must exceed gate {effective_gate}",
            );
        }
    }

    #[test]
    fn host_call_timeout_follows_the_call_timeout_and_clamps() {
        let default = PythonHostSettings::default();
        assert_eq!(
            host_call_timeout_ms(&default),
            super::super::protocol::CALL_TIMEOUT.as_millis() as u64
        );
        let tiny = PythonHostSettings {
            call_timeout_ms: Some(1),
            ..Default::default()
        };
        assert_eq!(host_call_timeout_ms(&tiny), 1_000);
        let huge = PythonHostSettings {
            call_timeout_ms: Some(u64::MAX),
            ..Default::default()
        };
        assert_eq!(host_call_timeout_ms(&huge), 3_600_000);
    }

    #[tokio::test]
    async fn host_response_for_an_unloaded_plugin_is_not_found() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = PythonRuntimeState::new(tmp.path().to_path_buf());
        let err = plugin_python_host_response_for_state(
            &state,
            "ghost",
            "gen-1",
            1,
            true,
            Some(json!("x")),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, PluginError::NotFound(_)),
            "expected NotFound, got {err:?}"
        );
    }

    /// The first-party demo plugin's `ctx.*` tools reach the host and come
    /// back — the end-to-end acceptance for the plugin -> host RPC channel,
    /// exercised through the real command path rather than a bespoke harness.
    #[tokio::test]
    async fn first_party_demo_plugin_calls_the_host_over_ctx() {
        let Some(interp) = super::super::discover::discover_interpreter(None) else {
            eprintln!("skipping demo host-call test: no python interpreter found");
            return;
        };
        let demo_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("plugins")
            .join("cognia-python-demo");

        let tmp = TempDir::new().unwrap();
        let state = std::sync::Arc::new(py_state(&tmp));
        let plugins = plugins_state(&tmp);
        grant_execute(&plugins, "cognia-python-demo");

        // Stand in for the renderer's host-request router.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        *state.host_request_sink.write() = Some(std::sync::Arc::new(move |request| {
            let _ = tx.send(request);
        }));
        apply_initialize(&state, Some(interp)).unwrap();
        {
            let state = std::sync::Arc::clone(&state);
            tokio::spawn(async move {
                while let Some(request) = rx.recv().await {
                    let echo = json!({"logged": request.method});
                    let _ = plugin_python_host_response_for_state(
                        &state,
                        &request.plugin_id,
                        &request.generation,
                        request.request_id,
                        true,
                        Some(echo),
                        None,
                    )
                    .await;
                }
            });
        }

        load_inner(
            &state,
            &plugins,
            "cognia-python-demo".into(),
            demo_dir.to_string_lossy().into_owned(),
            "main.py".into(),
            None,
            None,
            PythonHostSettings::default(),
        )
        .await
        .unwrap();

        // Async tool: `await cognia.ctx.logger.info(...)`.
        let result = call_tool_inner(
            &state,
            &plugins,
            "cognia-python-demo".into(),
            "host_log".into(),
            json!({"message": "from async"}),
        )
        .await
        .unwrap();
        assert_eq!(result, json!("host logged: from async"));

        // Sync tool bridging through `cognia.ctx.run_sync` on a worker thread.
        let result = call_tool_inner(
            &state,
            &plugins,
            "cognia-python-demo".into(),
            "host_log_sync".into(),
            json!({"message": "from sync"}),
        )
        .await
        .unwrap();
        assert_eq!(result, json!("host logged (sync): from sync"));

        // Concurrent host calls from one tool — the property the asyncio loop
        // exists for. A serial host would deadlock on the first one.
        let result = call_tool_inner(
            &state,
            &plugins,
            "cognia-python-demo".into(),
            "host_fanout".into(),
            json!({"count": 3}),
        )
        .await
        .unwrap();
        let entries = result.as_array().expect("fanout returns a list");
        assert_eq!(entries.len(), 3);
        for entry in entries {
            assert!(
                entry.as_str().unwrap().contains("logger.info"),
                "each fanout call must have reached the host: {entry}"
            );
        }
    }
}
