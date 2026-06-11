//! Generic plugin API gateway.
//!
//! `plugin_api_invoke` / `plugin_api_batch_invoke` are the catch-all commands
//! the plugin SDK calls through `lib/plugin/core/transport.ts`
//! (`invokePluginApi(pluginId, api, payload)`). Every dormant `ctx.*` native
//! namespace (`fs`, `secrets`, `clipboard`, `window`, `network`) routes here.
//!
//! ## Contract
//!
//! TS sends `invoke("plugin_api_invoke", { request: PluginApiInvokeRequest })`
//! and expects a `PluginApiInvokeResponse { success, data?, error?, … }` back —
//! the command therefore returns the response struct **directly** (never a
//! rejected promise) so a failed op surfaces as `success:false` with a typed
//! `error.code`, exactly as the TS gateway parses.
//!
//! ## Authorization model
//!
//! This gateway is an **independent host-side permission gate**, not merely a
//! convenience layer behind the renderer's `permission-guard`. Every routed
//! `ctx.*` op whose `required_permission(domain, op)` is `Some(perm)` is checked
//! against the Rust ledger via `state.has_permission(plugin_id, perm)` before it
//! runs — so a plugin that calls `plugin_api_invoke` directly, bypassing the TS
//! guard, is still denied unless it holds the grant. Declared manifest
//! permissions reach the ledger because the manager mirrors silent-tier
//! declarations on enable (`mirrorDeclaredPermissionsToLedger`); dangerous ones
//! land on interactive consent. The hard boundaries enforced HERE are:
//!   * **permission re-check** — `has_permission` per op (fs read/write, secrets
//!     read/write, clipboard read/write, network:fetch). `window:*` is UI-only
//!     and needs none.
//!   * **fs path-scoping** — every `fs:*` path resolves inside the plugin's own
//!     `<install_dir>/<plugin_id>/data` sandbox; `..` / absolute paths are
//!     rejected (mirrors the `files.rs` workspace sandbox).
//!   * **secret namespacing** — `secrets:*` keys live under the keyring
//!     namespace `plugin:<plugin_id>`, so one plugin can't read another's.
//!   * **network domain allowlist** — `network:fetch` URLs are checked against
//!     `state.network_allowlist` (empty = unrestricted), fail-closed on an
//!     unparseable URL.
//!
//! Domains without a real host backend (`db:*`, `shell:*`) return a well-formed
//! `NOT_SUPPORTED` error instead of the previous silent echo, so the SDK fails
//! honestly rather than pretending to succeed.

use std::collections::HashMap;
use std::path::{Component, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::State;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::{PluginRuntimeState, Result};

const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
const MIN_SUPPORTED_SDK: &str = "1.0.0";

// ─────────────────────────────────────────────────────────────────────────────
// Wire types — mirror lib/plugin/core/transport.ts:25-42
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginApiInvokeRequest {
    #[serde(default = "default_sdk_version")]
    pub sdk_version: String,
    pub plugin_id: String,
    #[serde(default)]
    pub request_id: String,
    pub api: String,
    #[serde(default)]
    pub payload: Value,
}

fn default_sdk_version() -> String {
    "2.0.0".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginApiError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginApiCompat {
    pub sdk_version: String,
    pub min_supported_sdk: String,
    pub compatible: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginApiInvokeResponse {
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PluginApiError>,
    pub runtime_version: String,
    pub compat: PluginApiCompat,
}

impl PluginApiError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }
    fn not_supported(api: &str) -> Self {
        Self::new(
            "NOT_SUPPORTED",
            format!("plugin API \"{api}\" has no host backend on this platform yet"),
        )
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_REQUEST", message)
    }
    fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }
    fn permission_denied(message: impl Into<String>) -> Self {
        Self::new("PERMISSION_DENIED", message)
    }
}

fn compat_for(sdk_version: &str) -> PluginApiCompat {
    PluginApiCompat {
        sdk_version: sdk_version.to_string(),
        min_supported_sdk: MIN_SUPPORTED_SDK.to_string(),
        compatible: true,
    }
}

fn ok_response(request_id: &str, sdk_version: &str, data: Value) -> PluginApiInvokeResponse {
    PluginApiInvokeResponse {
        request_id: request_id.to_string(),
        success: true,
        data: Some(data),
        error: None,
        runtime_version: RUNTIME_VERSION.to_string(),
        compat: compat_for(sdk_version),
    }
}

fn err_response(
    request_id: &str,
    sdk_version: &str,
    error: PluginApiError,
) -> PluginApiInvokeResponse {
    PluginApiInvokeResponse {
        request_id: request_id.to_string(),
        success: false,
        data: None,
        error: Some(error),
        runtime_version: RUNTIME_VERSION.to_string(),
        compat: compat_for(sdk_version),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// fs path-scoping (the hard security boundary)
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve a plugin-supplied path inside the plugin's own data sandbox.
/// Rejects absolute paths and any `..` component so a plugin can never reach
/// outside `<install_dir>/<plugin_id>/data`. The base dir is created on demand.
fn resolve_scoped(
    state: &PluginRuntimeState,
    plugin_id: &str,
    raw: &str,
) -> std::result::Result<PathBuf, PluginApiError> {
    let base = state.plugin_dir(plugin_id).join("data");
    // The plugin SDK's getDataDir() advertises `plugins_runtime/<id>/data`;
    // tolerate callers that prefix paths with that, treating everything as
    // relative to the sandbox root.
    let rel = raw.trim_start_matches('/').trim_start_matches('\\');
    let candidate = PathBuf::from(rel);
    if candidate.is_absolute() {
        return Err(PluginApiError::permission_denied(format!(
            "fs path must be relative to the plugin sandbox: {raw}"
        )));
    }
    for component in candidate.components() {
        match component {
            Component::ParentDir => {
                return Err(PluginApiError::permission_denied(format!(
                    "fs path escapes the plugin sandbox: {raw}"
                )));
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(PluginApiError::permission_denied(format!(
                    "fs path must be relative to the plugin sandbox: {raw}"
                )));
            }
            _ => {}
        }
    }
    Ok(base.join(candidate))
}

fn payload_str(payload: &Value, key: &str) -> std::result::Result<String, PluginApiError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| PluginApiError::invalid(format!("missing string field \"{key}\"")))
}

fn payload_bool(payload: &Value, key: &str, default: bool) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(default)
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain handlers
// ─────────────────────────────────────────────────────────────────────────────

fn handle_fs(
    state: &PluginRuntimeState,
    plugin_id: &str,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    match op {
        "readText" => {
            let path = resolve_scoped(state, plugin_id, &payload_str(payload, "path")?)?;
            let text = std::fs::read_to_string(&path)
                .map_err(|e| PluginApiError::internal(format!("fs:readText: {e}")))?;
            Ok(Value::String(text))
        }
        "readBinary" => {
            let path = resolve_scoped(state, plugin_id, &payload_str(payload, "path")?)?;
            let bytes = std::fs::read(&path)
                .map_err(|e| PluginApiError::internal(format!("fs:readBinary: {e}")))?;
            Ok(json!(bytes))
        }
        "writeText" => {
            let path = resolve_scoped(state, plugin_id, &payload_str(payload, "path")?)?;
            let content = payload_str(payload, "content")?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| PluginApiError::internal(format!("fs:writeText mkdir: {e}")))?;
            }
            std::fs::write(&path, content)
                .map_err(|e| PluginApiError::internal(format!("fs:writeText: {e}")))?;
            Ok(Value::Null)
        }
        "writeBinary" => {
            let path = resolve_scoped(state, plugin_id, &payload_str(payload, "path")?)?;
            let content: Vec<u8> = payload
                .get("content")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(|v| v.as_u64().map(|n| n as u8)).collect())
                .ok_or_else(|| PluginApiError::invalid("fs:writeBinary requires content: number[]"))?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| PluginApiError::internal(format!("fs:writeBinary mkdir: {e}")))?;
            }
            std::fs::write(&path, content)
                .map_err(|e| PluginApiError::internal(format!("fs:writeBinary: {e}")))?;
            Ok(Value::Null)
        }
        "exists" => {
            let path = resolve_scoped(state, plugin_id, &payload_str(payload, "path")?)?;
            Ok(Value::Bool(path.exists()))
        }
        "mkdir" => {
            let path = resolve_scoped(state, plugin_id, &payload_str(payload, "path")?)?;
            std::fs::create_dir_all(&path)
                .map_err(|e| PluginApiError::internal(format!("fs:mkdir: {e}")))?;
            Ok(Value::Null)
        }
        "remove" => {
            let path = resolve_scoped(state, plugin_id, &payload_str(payload, "path")?)?;
            let recursive = payload_bool(payload, "recursive", false);
            let result = if path.is_dir() {
                if recursive {
                    std::fs::remove_dir_all(&path)
                } else {
                    std::fs::remove_dir(&path)
                }
            } else {
                std::fs::remove_file(&path)
            };
            result.map_err(|e| PluginApiError::internal(format!("fs:remove: {e}")))?;
            Ok(Value::Null)
        }
        "copy" => {
            let src = resolve_scoped(state, plugin_id, &payload_str(payload, "src")?)?;
            let dest = resolve_scoped(state, plugin_id, &payload_str(payload, "dest")?)?;
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| PluginApiError::internal(format!("fs:copy mkdir: {e}")))?;
            }
            std::fs::copy(&src, &dest)
                .map_err(|e| PluginApiError::internal(format!("fs:copy: {e}")))?;
            Ok(Value::Null)
        }
        "move" => {
            let src = resolve_scoped(state, plugin_id, &payload_str(payload, "src")?)?;
            let dest = resolve_scoped(state, plugin_id, &payload_str(payload, "dest")?)?;
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| PluginApiError::internal(format!("fs:move mkdir: {e}")))?;
            }
            std::fs::rename(&src, &dest)
                .map_err(|e| PluginApiError::internal(format!("fs:move: {e}")))?;
            Ok(Value::Null)
        }
        "readDir" => {
            let path = resolve_scoped(state, plugin_id, &payload_str(payload, "path")?)?;
            let mut entries: Vec<Value> = Vec::new();
            for dent in std::fs::read_dir(&path)
                .map_err(|e| PluginApiError::internal(format!("fs:readDir: {e}")))?
                .flatten()
            {
                let meta = dent.metadata().ok();
                let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                entries.push(json!({
                    "name": dent.file_name().to_string_lossy(),
                    "path": dent.path().to_string_lossy(),
                    "isDirectory": is_dir,
                    "isFile": !is_dir,
                    "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                }));
            }
            Ok(json!(entries))
        }
        "stat" => {
            let path = resolve_scoped(state, plugin_id, &payload_str(payload, "path")?)?;
            let meta = std::fs::metadata(&path)
                .map_err(|e| PluginApiError::internal(format!("fs:stat: {e}")))?;
            Ok(json!({
                "size": meta.len(),
                "isFile": meta.is_file(),
                "isDirectory": meta.is_dir(),
            }))
        }
        _ => Err(PluginApiError::not_supported(&format!("fs:{op}"))),
    }
}

fn secret_namespace(plugin_id: &str) -> String {
    format!("plugin:{plugin_id}")
}

fn handle_secrets(
    plugin_id: &str,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    let ns = secret_namespace(plugin_id);
    match op {
        "get" => {
            let key = payload_str(payload, "key")?;
            let value = crate::keyring_secrets::get(&ns, &key)
                .map_err(|e| PluginApiError::internal(format!("secrets:get: {e}")))?;
            Ok(match value {
                Some(v) => Value::String(v),
                None => Value::Null,
            })
        }
        "set" => {
            let key = payload_str(payload, "key")?;
            let value = payload_str(payload, "value")?;
            crate::keyring_secrets::set(&ns, &key, &value)
                .map_err(|e| PluginApiError::internal(format!("secrets:set: {e}")))?;
            Ok(Value::Null)
        }
        "delete" => {
            let key = payload_str(payload, "key")?;
            crate::keyring_secrets::clear(&ns, &key)
                .map_err(|e| PluginApiError::internal(format!("secrets:delete: {e}")))?;
            Ok(Value::Null)
        }
        _ => Err(PluginApiError::not_supported(&format!("secrets:{op}"))),
    }
}

async fn handle_clipboard(
    app: &AppHandle,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    match op {
        "readText" => {
            let text = app
                .clipboard()
                .read_text()
                .map_err(|e| PluginApiError::internal(format!("clipboard:readText: {e}")))?;
            Ok(Value::String(text))
        }
        "writeText" => {
            let text = payload_str(payload, "text")?;
            app.clipboard()
                .write_text(text)
                .map_err(|e| PluginApiError::internal(format!("clipboard:writeText: {e}")))?;
            Ok(Value::Null)
        }
        "hasText" => {
            let has = app.clipboard().read_text().map(|t| !t.is_empty()).unwrap_or(false);
            Ok(Value::Bool(has))
        }
        "clear" => {
            app.clipboard()
                .write_text(String::new())
                .map_err(|e| PluginApiError::internal(format!("clipboard:clear: {e}")))?;
            Ok(Value::Null)
        }
        // Image clipboard isn't exposed by the cross-platform manager here.
        _ => Err(PluginApiError::not_supported(&format!("clipboard:{op}"))),
    }
}

async fn handle_window(
    app: &AppHandle,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    use super::window_ops;
    let map = |r: Result<()>| {
        r.map(|_| Value::Null)
            .map_err(|e| PluginApiError::internal(e.to_string()))
    };
    match op {
        "minimize" => map(window_ops::plugin_window_minimize(app.clone()).await),
        "maximize" => map(window_ops::plugin_window_maximize(app.clone()).await),
        "unmaximize" => map(window_ops::plugin_window_unmaximize(app.clone()).await),
        "setAlwaysOnTop" => {
            let flag = payload_bool(payload, "flag", true);
            map(window_ops::plugin_window_set_always_on_top(app.clone(), flag).await)
        }
        // Multi-window create/close/resize/getSize aren't supported yet.
        _ => Err(PluginApiError::not_supported(&format!("window:{op}"))),
    }
}

async fn handle_network(
    state: &PluginRuntimeState,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    use crate::connectors::types::TauriHttpRequest;
    match op {
        "fetch" => {
            let url = payload_str(payload, "url")?;
            // Domain allowlist (fail-closed on an unparseable URL / missing host).
            let host = url::Url::parse(&url)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()));
            match host {
                Some(h) if state.network_host_allowed(&h) => {}
                Some(h) => {
                    return Err(PluginApiError::permission_denied(format!(
                        "network:fetch to {h} is not allow-listed"
                    )))
                }
                None => {
                    return Err(PluginApiError::invalid(format!(
                        "network:fetch: cannot extract host from URL: {url}"
                    )))
                }
            }
            let options = payload.get("options").cloned().unwrap_or(Value::Null);
            let method = options
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .to_string();
            let headers: Option<HashMap<String, String>> = options
                .get("headers")
                .and_then(|h| serde_json::from_value(h.clone()).ok());
            let body = options.get("body").and_then(|b| match b {
                Value::String(s) => Some(s.clone()),
                Value::Null => None,
                other => Some(other.to_string()),
            });
            let req = TauriHttpRequest {
                url,
                method,
                headers,
                body,
                timeout_ms: None,
            };
            let resp = crate::connectors::http_client::http_request(req)
                .await
                .map_err(|e| PluginApiError::internal(format!("network:fetch: {e}")))?;
            let ok = (200..300).contains(&resp.status);
            Ok(json!({
                "ok": ok,
                "status": resp.status,
                "statusText": "",
                "headers": resp.headers,
                "data": resp.body,
            }))
        }
        // download/upload need streaming-to-sandbox plumbing — not wired yet.
        _ => Err(PluginApiError::not_supported(&format!("network:{op}"))),
    }
}

/// The `PluginPermission` a supported `domain:op` requires, or `None` when the
/// op needs no permission (UI-only `window:*`) or has no host backend. Mirrors
/// the first `required_permissions` entry of [`capability_table`]; an in-Rust
/// parity test keeps the two in lockstep.
fn required_permission(domain: &str, op: &str) -> Option<&'static str> {
    match (domain, op) {
        ("fs", "readText" | "readBinary" | "exists" | "readDir" | "stat") => {
            Some("filesystem:read")
        }
        ("fs", "writeText" | "writeBinary" | "mkdir" | "copy" | "move" | "remove") => {
            Some("filesystem:write")
        }
        ("secrets", "get") => Some("secrets:read"),
        ("secrets", "set" | "delete") => Some("secrets:write"),
        ("clipboard", "readText" | "hasText") => Some("clipboard:read"),
        ("clipboard", "writeText" | "clear") => Some("clipboard:write"),
        ("network", "fetch") => Some("network:fetch"),
        // window:* is UI-cosmetic; db/shell/process have no backend.
        _ => None,
    }
}

/// Route one `domain:operation` api string to its handler.
async fn dispatch(
    app: &AppHandle,
    state: &PluginRuntimeState,
    plugin_id: &str,
    api: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    let (domain, op) = api
        .split_once(':')
        .ok_or_else(|| PluginApiError::invalid(format!("malformed api string: {api}")))?;
    // Host-side permission gate — independent of the renderer guard. A plugin
    // reaching this command directly is still denied without the grant.
    if let Some(perm) = required_permission(domain, op) {
        if !state.has_permission(plugin_id, perm) {
            return Err(PluginApiError::permission_denied(format!(
                "{api} requires permission {perm}"
            )));
        }
    }
    match domain {
        "fs" => handle_fs(state, plugin_id, op, payload),
        "secrets" => handle_secrets(plugin_id, op, payload),
        "clipboard" => handle_clipboard(app, op, payload).await,
        "window" => handle_window(app, op, payload).await,
        "network" => handle_network(state, op, payload).await,
        // No host backend yet — fail honestly instead of the old silent echo.
        "db" | "shell" | "process" => Err(PluginApiError::not_supported(api)),
        _ => Err(PluginApiError::not_supported(api)),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn plugin_api_invoke(
    app: AppHandle,
    state: State<'_, PluginRuntimeState>,
    request: PluginApiInvokeRequest,
) -> Result<PluginApiInvokeResponse> {
    let PluginApiInvokeRequest {
        sdk_version,
        plugin_id,
        request_id,
        api,
        payload,
    } = request;

    if !state.plugins.read().contains_key(&plugin_id) {
        return Ok(err_response(
            &request_id,
            &sdk_version,
            PluginApiError::new("NOT_FOUND", format!("plugin not loaded: {plugin_id}")),
        ));
    }

    Ok(match dispatch(&app, &state, &plugin_id, &api, &payload).await {
        Ok(data) => ok_response(&request_id, &sdk_version, data),
        Err(error) => err_response(&request_id, &sdk_version, error),
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequestItem {
    #[serde(default)]
    pub request_id: String,
    pub api: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchInvokeRequest {
    #[serde(default = "default_sdk_version")]
    pub sdk_version: String,
    pub plugin_id: String,
    #[serde(default)]
    pub strategy: Option<String>,
    pub requests: Vec<BatchRequestItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchInvokeResponse {
    pub success: bool,
    pub results: Vec<PluginApiInvokeResponse>,
}

#[tauri::command]
pub async fn plugin_api_batch_invoke(
    app: AppHandle,
    state: State<'_, PluginRuntimeState>,
    request: BatchInvokeRequest,
) -> Result<BatchInvokeResponse> {
    let BatchInvokeRequest {
        sdk_version,
        plugin_id,
        strategy,
        requests,
    } = request;
    let abort_on_error = strategy.as_deref() == Some("abortOnError");
    let loaded = state.plugins.read().contains_key(&plugin_id);

    let mut results: Vec<PluginApiInvokeResponse> = Vec::with_capacity(requests.len());
    let mut all_ok = true;
    for item in requests {
        let response = if !loaded {
            err_response(
                &item.request_id,
                &sdk_version,
                PluginApiError::new("NOT_FOUND", format!("plugin not loaded: {plugin_id}")),
            )
        } else {
            match dispatch(&app, &state, &plugin_id, &item.api, &item.payload).await {
                Ok(data) => ok_response(&item.request_id, &sdk_version, data),
                Err(error) => err_response(&item.request_id, &sdk_version, error),
            }
        };
        if !response.success {
            all_ok = false;
            if abort_on_error {
                results.push(response);
                break;
            }
        }
        results.push(response);
    }

    Ok(BatchInvokeResponse {
        success: all_ok,
        results,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability advertisement — backs transport.ts:getPluginCapabilities()
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginApiCapability {
    pub api: String,
    pub supported: bool,
    pub high_risk: bool,
    pub required_permissions: Vec<String>,
}

/// Single source of truth for which `api` strings the gateway actually
/// services. Mirrors the routing table in [`dispatch`]; unsupported domains
/// (`db:*`, `shell:*`) are advertised as `supported: false` so SDK authors get
/// an honest answer instead of discovering NOT_SUPPORTED at call time.
fn capability_table() -> Vec<PluginApiCapability> {
    let cap = |api: &str, supported: bool, high_risk: bool, perms: &[&str]| PluginApiCapability {
        api: api.to_string(),
        supported,
        high_risk,
        required_permissions: perms.iter().map(|p| p.to_string()).collect(),
    };
    vec![
        cap("fs:readText", true, false, &["filesystem:read"]),
        cap("fs:readBinary", true, false, &["filesystem:read"]),
        cap("fs:writeText", true, true, &["filesystem:write"]),
        cap("fs:writeBinary", true, true, &["filesystem:write"]),
        cap("fs:exists", true, false, &["filesystem:read"]),
        cap("fs:mkdir", true, true, &["filesystem:write"]),
        cap("fs:remove", true, true, &["filesystem:write"]),
        cap("fs:copy", true, true, &["filesystem:write"]),
        cap("fs:move", true, true, &["filesystem:write"]),
        cap("fs:readDir", true, false, &["filesystem:read"]),
        cap("fs:stat", true, false, &["filesystem:read"]),
        cap("secrets:get", true, true, &["secrets:read"]),
        cap("secrets:set", true, true, &["secrets:write"]),
        cap("secrets:delete", true, true, &["secrets:write"]),
        cap("clipboard:readText", true, false, &["clipboard:read"]),
        cap("clipboard:writeText", true, false, &["clipboard:write"]),
        cap("clipboard:hasText", true, false, &["clipboard:read"]),
        cap("clipboard:clear", true, false, &["clipboard:write"]),
        cap("window:minimize", true, false, &[]),
        cap("window:maximize", true, false, &[]),
        cap("window:unmaximize", true, false, &[]),
        cap("window:setAlwaysOnTop", true, false, &[]),
        cap("network:fetch", true, false, &["network:fetch"]),
        cap("network:download", false, false, &["network:fetch"]),
        cap("network:upload", false, false, &["network:fetch"]),
        cap("db:query", false, false, &["database:read"]),
        cap("db:execute", false, false, &["database:write"]),
        cap("shell:execute", false, true, &["shell:execute"]),
    ]
}

#[tauri::command]
pub async fn plugin_get_capabilities() -> Result<Vec<PluginApiCapability>> {
    Ok(capability_table())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_api::{PluginRecord, PluginRuntimeSnapshot, PluginRuntimeState};
    use tempfile::TempDir;

    fn seeded_state(tmp: &TempDir) -> PluginRuntimeState {
        let state = PluginRuntimeState::new(PathBuf::from(tmp.path()));
        state.plugins.write().insert(
            "demo".into(),
            PluginRecord {
                snapshot: PluginRuntimeSnapshot {
                    plugin_id: "demo".into(),
                    version: "1.0.0".into(),
                    status: "loaded".into(),
                    last_error: None,
                    loaded_at: None,
                    install_path: tmp.path().join("demo").to_string_lossy().into_owned(),
                },
                runtime_state: serde_json::Value::Null,
            },
        );
        state
    }

    #[test]
    fn resolve_scoped_blocks_traversal_and_absolute() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        assert!(resolve_scoped(&state, "demo", "../../etc/passwd").is_err());
        assert!(resolve_scoped(&state, "demo", "a/../../b").is_err());
        #[cfg(windows)]
        assert!(resolve_scoped(&state, "demo", "C:/Windows/system32").is_err());
        #[cfg(not(windows))]
        assert!(resolve_scoped(&state, "demo", "/etc/passwd").is_err());
        // A clean relative path resolves inside the sandbox.
        let ok = resolve_scoped(&state, "demo", "notes/today.txt").unwrap();
        assert!(ok.starts_with(state.plugin_dir("demo").join("data")));
    }

    #[test]
    fn fs_write_then_read_roundtrips_in_sandbox() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let write = handle_fs(
            &state,
            "demo",
            "writeText",
            &json!({ "path": "sub/file.txt", "content": "hello" }),
        )
        .unwrap();
        assert_eq!(write, Value::Null);
        let read = handle_fs(&state, "demo", "readText", &json!({ "path": "sub/file.txt" })).unwrap();
        assert_eq!(read, Value::String("hello".into()));
        let exists = handle_fs(&state, "demo", "exists", &json!({ "path": "sub/file.txt" })).unwrap();
        assert_eq!(exists, Value::Bool(true));
    }

    #[test]
    fn fs_write_outside_sandbox_is_permission_denied() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let err = handle_fs(
            &state,
            "demo",
            "writeText",
            &json!({ "path": "../escape.txt", "content": "x" }),
        )
        .unwrap_err();
        assert_eq!(err.code, "PERMISSION_DENIED");
    }

    #[test]
    fn fs_missing_path_field_is_invalid_request() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let err = handle_fs(&state, "demo", "readText", &json!({})).unwrap_err();
        assert_eq!(err.code, "INVALID_REQUEST");
    }

    #[test]
    fn unknown_fs_op_is_not_supported() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let err = handle_fs(&state, "demo", "chmod", &json!({ "path": "x" })).unwrap_err();
        assert_eq!(err.code, "NOT_SUPPORTED");
    }

    #[test]
    fn secret_namespace_is_plugin_scoped() {
        assert_eq!(secret_namespace("my-plugin"), "plugin:my-plugin");
        assert_ne!(secret_namespace("a"), secret_namespace("b"));
    }

    #[test]
    fn response_serializes_with_camel_case_success_shape() {
        let resp = ok_response("req-1", "2.0.0", json!({ "x": 1 }));
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"success\":true"));
        assert!(s.contains("\"requestId\":\"req-1\""));
        assert!(s.contains("\"runtimeVersion\""));
        assert!(s.contains("\"compat\""));
    }

    #[test]
    fn error_response_carries_typed_code() {
        let resp = err_response("req-2", "2.0.0", PluginApiError::not_supported("db:query"));
        assert!(!resp.success);
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"code\":\"NOT_SUPPORTED\""));
        assert!(s.contains("\"success\":false"));
    }

    #[test]
    fn capability_table_marks_db_and_shell_unsupported() {
        let caps = capability_table();
        let db = caps.iter().find(|c| c.api == "db:query").unwrap();
        assert!(!db.supported);
        let fs_write = caps.iter().find(|c| c.api == "fs:writeText").unwrap();
        assert!(fs_write.supported && fs_write.high_risk);
        assert!(fs_write
            .required_permissions
            .contains(&"filesystem:write".to_string()));
    }

    #[test]
    fn request_deserializes_camel_case_envelope() {
        let req: PluginApiInvokeRequest = serde_json::from_value(json!({
            "sdkVersion": "2.0.0",
            "pluginId": "demo",
            "requestId": "r1",
            "api": "fs:readText",
            "payload": { "path": "x.txt" }
        }))
        .unwrap();
        assert_eq!(req.plugin_id, "demo");
        assert_eq!(req.api, "fs:readText");
    }

    #[test]
    fn required_permission_maps_each_op_family() {
        assert_eq!(required_permission("fs", "readText"), Some("filesystem:read"));
        assert_eq!(required_permission("fs", "writeText"), Some("filesystem:write"));
        assert_eq!(required_permission("fs", "remove"), Some("filesystem:write"));
        assert_eq!(required_permission("secrets", "get"), Some("secrets:read"));
        assert_eq!(required_permission("secrets", "set"), Some("secrets:write"));
        assert_eq!(required_permission("clipboard", "readText"), Some("clipboard:read"));
        assert_eq!(required_permission("clipboard", "clear"), Some("clipboard:write"));
        assert_eq!(required_permission("network", "fetch"), Some("network:fetch"));
        // window:* and unbacked domains need no permission.
        assert_eq!(required_permission("window", "minimize"), None);
        assert_eq!(required_permission("db", "query"), None);
    }

    #[test]
    fn required_permission_matches_capability_table() {
        // In-Rust parity: every supported, permissioned capability's first
        // required permission equals what the gate enforces.
        for c in capability_table() {
            if !c.supported {
                continue;
            }
            let (domain, op) = c.api.split_once(':').unwrap();
            let gate = required_permission(domain, op);
            match c.required_permissions.first() {
                Some(first) => assert_eq!(
                    gate,
                    Some(first.as_str()),
                    "gate/table mismatch for {}",
                    c.api
                ),
                None => assert_eq!(gate, None, "gate should be None for {}", c.api),
            }
        }
    }

    #[test]
    fn capability_table_uses_only_canonical_permissions() {
        // No phantom permission strings (filesystem:delete, network:download/
        // upload, database:query/execute) outside the PluginPermission union.
        let phantom = [
            "filesystem:delete",
            "network:download",
            "network:upload",
            "database:query",
            "database:execute",
        ];
        for c in capability_table() {
            for p in &c.required_permissions {
                assert!(
                    !phantom.contains(&p.as_str()),
                    "capability {} advertises non-union permission {}",
                    c.api,
                    p
                );
            }
        }
    }

    #[tokio::test]
    async fn handle_network_denies_non_allowlisted_host() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        state.network_allowlist.write().push("example.com".into());
        let err = handle_network(&state, "fetch", &json!({ "url": "https://evil.test/x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code, "PERMISSION_DENIED");
    }

    #[tokio::test]
    async fn handle_network_rejects_malformed_url() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let err = handle_network(&state, "fetch", &json!({ "url": "not a url" }))
            .await
            .unwrap_err();
        assert_eq!(err.code, "INVALID_REQUEST");
    }

    #[test]
    fn has_permission_reflects_a_written_manifest_grant() {
        use crate::plugin_api::{permissions::read_ledger, PermissionGrant};
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        assert!(!state.has_permission("demo", "filesystem:read"));
        // Write a manifest grant directly to the ledger (mirrors the manager).
        let grant = PermissionGrant {
            plugin_id: "demo".into(),
            permission: "filesystem:read".into(),
            granted_by: "manifest".into(),
            granted_at: chrono::Utc::now().to_rfc3339(),
            expires_at: None,
        };
        state
            .permissions
            .write()
            .insert("demo".into(), vec![grant]);
        assert!(state.has_permission("demo", "filesystem:read"));
        assert!(!state.has_permission("demo", "filesystem:write"));
        let _ = read_ledger(&state, "demo");
    }
}
