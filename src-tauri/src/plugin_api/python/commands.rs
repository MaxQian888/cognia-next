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
use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use super::discover::{discover_interpreter, Interpreter};
use super::protocol::{PluginHost, CALL_TIMEOUT, CONTROL_TIMEOUT};
use super::PythonRuntimeState;
use crate::plugin_api::{PluginError, PluginRuntimeState, Result};

/// Embedded host script, written to `<python_dir>/host.py` at initialize.
const HOST_SCRIPT: &str = include_str!("host.py");

const PYTHON_EXECUTE_PERMISSION: &str = "python:execute";

/// Wire-exact match for `PythonRuntimeInfo` (manager.ts:226-233).
#[derive(Debug, Clone, Serialize)]
pub struct PythonRuntimeInfo {
    pub available: bool,
    pub version: Option<String>,
    pub plugin_count: usize,
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
    state: State<'_, PythonRuntimeState>,
    python_path: Option<String>,
) -> Result<()> {
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
) -> Result<()> {
    load_inner(&state, &plugins, plugin_id, plugin_path, main_module, dependencies).await
}

#[tauri::command]
pub async fn plugin_python_get_tools(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
) -> Result<Value> {
    let host = require_host(&state, &plugin_id)?;
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
    match state.host(&plugin_id) {
        Some(host) => Ok(host.ping().await),
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn plugin_python_get_info(
    state: State<'_, PythonRuntimeState>,
    plugin_id: String,
) -> Result<Option<PythonPluginInfo>> {
    Ok(get_info_inner(&state, &plugin_id))
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

async fn load_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    plugin_path: String,
    main_module: String,
    dependencies: Option<Vec<String>>,
) -> Result<()> {
    // Gate order: permission beats availability (tests pin this).
    check_execute_grant(plugins, &plugin_id)?;
    let interpreter = require_interpreter(state)?;

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
        existing.kill().await;
    }

    let host = PluginHost::spawn(&plugin_id, &interpreter, &host_script).await?;
    let info = match host
        .request(
            "import_main",
            json!({
                "plugin_path": plugin_path,
                "main_module": main_module,
                "dependencies": dependencies,
            }),
            CALL_TIMEOUT,
        )
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
    host.tool_count.store(tool_count, Ordering::Relaxed);
    host.hook_count.store(hook_count, Ordering::Relaxed);

    state.hosts.write().insert(plugin_id, host);
    Ok(())
}

async fn call_tool_inner(
    state: &PythonRuntimeState,
    plugins: &PluginRuntimeState,
    plugin_id: String,
    tool_name: String,
    args: Value,
) -> Result<Value> {
    check_execute_grant(plugins, &plugin_id)?;
    let host = require_host(state, &plugin_id)?;
    let started = Instant::now();
    let result = host
        .request("call_tool", json!({ "name": tool_name, "args": args }), CALL_TIMEOUT)
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
    let host = require_host(state, &plugin_id)?;
    let started = Instant::now();
    let result = host
        .request(
            "call",
            json!({ "function_name": function_name, "args": args }),
            CALL_TIMEOUT,
        )
        .await;
    state
        .counters
        .record(started.elapsed().as_millis() as u64, result.is_err());
    result
}

fn get_info_inner(state: &PythonRuntimeState, plugin_id: &str) -> Option<PythonPluginInfo> {
    state.host(plugin_id).map(|host| PythonPluginInfo {
        plugin_id: plugin_id.to_string(),
        tool_count: host.tool_count.load(Ordering::Relaxed),
        hook_count: host.hook_count.load(Ordering::Relaxed),
    })
}

async fn unload_inner(state: &PythonRuntimeState, plugin_id: &str) -> Result<()> {
    // Bind before awaiting — see load_inner's reload note.
    let host = state.hosts.write().remove(plugin_id);
    if let Some(host) = host {
        host.kill().await;
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
        let err = load_inner(&state, &plugins, "demo".into(), "/p".into(), "main.py".into(), None)
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
        let err = load_inner(&state, &plugins, "demo".into(), "/p".into(), "main.py".into(), None)
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
        load_inner(&state, &plugins, "demo".into(), plugin_path, "main.py".into(), None)
            .await
            .unwrap();

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
