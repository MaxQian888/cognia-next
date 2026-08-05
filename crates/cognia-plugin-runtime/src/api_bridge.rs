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
//!   * **network egress policy** — `network:fetch` URLs are checked against
//!     `state.network_allowlist` plus optional method/path rules, fail-closed
//!     on a missing declaration or unparseable URL.
//!
//! UI-only operations (`clipboard:*`, `window:*`, `shell:open`, and
//! `shell:showInFolder`) require a desktop `AppHandle`. The headless gateway
//! reports them as typed `NOT_SUPPORTED` capabilities while retaining the
//! canonical filesystem, secrets, network, database, and allowlisted
//! `shell:execute` backends.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::State;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::{NetworkAccessRule, PluginError, PluginRuntimeState, Result};

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
    fn incompatible_sdk(sdk_version: &str) -> Self {
        Self::new(
            "INCOMPATIBLE_SDK",
            format!(
                "plugin SDK version {sdk_version} is below the minimum supported {MIN_SUPPORTED_SDK}"
            ),
        )
    }
}

/// Parse a `major.minor.patch` string into a comparable tuple. Missing minor
/// or patch components default to 0 (so `"2"` / `"2.0"` / `"2.0.0"` all parse),
/// but an absent or non-numeric major component yields `None`.
fn parse_sdk_semver(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.trim().split('.');
    let major: u32 = parts.next()?.trim().parse().ok()?;
    let minor: u32 = parts
        .next()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(0);
    let patch: u32 = parts
        .next()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(0);
    Some((major, minor, patch))
}

/// True when `sdk_version` is `>= MIN_SUPPORTED_SDK` by (major, minor, patch)
/// ordering. Fail-closed: an unparseable version is treated as incompatible.
fn sdk_is_compatible(sdk_version: &str) -> bool {
    match (
        parse_sdk_semver(sdk_version),
        parse_sdk_semver(MIN_SUPPORTED_SDK),
    ) {
        (Some(sdk), Some(min)) => sdk >= min,
        _ => false,
    }
}

fn compat_for(sdk_version: &str) -> PluginApiCompat {
    PluginApiCompat {
        sdk_version: sdk_version.to_string(),
        min_supported_sdk: MIN_SUPPORTED_SDK.to_string(),
        compatible: sdk_is_compatible(sdk_version),
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
    let candidate = crate::contained_path::validate_plugin_relative_path(raw).map_err(|error| {
        PluginApiError::permission_denied(format!("fs path is not contained: {raw}: {error}"))
    })?;
    if let Ok(metadata) = std::fs::symlink_metadata(&base) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(PluginApiError::permission_denied(
                "plugin data root must be a non-symlink directory",
            ));
        }
    }
    let mut cursor = base.clone();
    for component in candidate.components() {
        cursor.push(component.as_os_str());
        match std::fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(PluginApiError::permission_denied(format!(
                    "fs path traverses a symbolic link: {}",
                    cursor.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(PluginApiError::internal(format!(
                    "fs path validation failed: {error}"
                )));
            }
        }
    }
    Ok(base.join(candidate))
}

fn data_handle_path(raw: &str) -> std::result::Result<PathBuf, PluginApiError> {
    let relative = crate::contained_path::validate_plugin_relative_path(raw).map_err(|error| {
        PluginApiError::permission_denied(format!("fs path is not contained: {raw}: {error}"))
    })?;
    Ok(PathBuf::from("data").join(relative))
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
            let relative = payload_str(payload, "path")?;
            resolve_scoped(state, plugin_id, &relative)?;
            let bytes = crate::contained_path::read_existing_plugin_file(
                &state.plugin_dir(plugin_id),
                &data_handle_path(&relative)?.to_string_lossy(),
            )
            .map_err(|e| PluginApiError::internal(format!("fs:readText: {e}")))?;
            let text = String::from_utf8(bytes)
                .map_err(|e| PluginApiError::internal(format!("fs:readText utf8: {e}")))?;
            Ok(Value::String(text))
        }
        "readBinary" => {
            let relative = payload_str(payload, "path")?;
            resolve_scoped(state, plugin_id, &relative)?;
            let bytes = crate::contained_path::read_existing_plugin_file(
                &state.plugin_dir(plugin_id),
                &data_handle_path(&relative)?.to_string_lossy(),
            )
            .map_err(|e| PluginApiError::internal(format!("fs:readBinary: {e}")))?;
            Ok(json!(bytes))
        }
        "writeText" => {
            let relative = payload_str(payload, "path")?;
            resolve_scoped(state, plugin_id, &relative)?;
            let content = payload_str(payload, "content")?;
            crate::contained_path::write_plugin_file(
                &state.plugin_dir(plugin_id),
                &data_handle_path(&relative)?.to_string_lossy(),
                content.as_bytes(),
            )
            .map_err(|e| PluginApiError::internal(format!("fs:writeText: {e}")))?;
            Ok(Value::Null)
        }
        "writeBinary" => {
            let relative = payload_str(payload, "path")?;
            resolve_scoped(state, plugin_id, &relative)?;
            let content: Vec<u8> = payload
                .get("content")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_u64().map(|n| n as u8))
                        .collect()
                })
                .ok_or_else(|| {
                    PluginApiError::invalid("fs:writeBinary requires content: number[]")
                })?;
            crate::contained_path::write_plugin_file(
                &state.plugin_dir(plugin_id),
                &data_handle_path(&relative)?.to_string_lossy(),
                &content,
            )
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
            let src_rel = payload_str(payload, "src")?;
            let dest_rel = payload_str(payload, "dest")?;
            resolve_scoped(state, plugin_id, &src_rel)?;
            resolve_scoped(state, plugin_id, &dest_rel)?;
            let bytes = crate::contained_path::read_existing_plugin_file(
                &state.plugin_dir(plugin_id),
                &data_handle_path(&src_rel)?.to_string_lossy(),
            )
            .map_err(|e| PluginApiError::internal(format!("fs:copy read: {e}")))?;
            crate::contained_path::write_plugin_file(
                &state.plugin_dir(plugin_id),
                &data_handle_path(&dest_rel)?.to_string_lossy(),
                &bytes,
            )
            .map_err(|e| PluginApiError::internal(format!("fs:copy write: {e}")))?;
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

// ─────────────────────────────────────────────────────────────────────────────
// db (per-plugin SQLite)
// ─────────────────────────────────────────────────────────────────────────────

/// Get-or-open the plugin's single SQLite connection at
/// `<plugin_dir>/data/plugin.db`. Cached in the runtime state so a transaction
/// (BEGIN/COMMIT issued across separate IPC calls) rides one connection — the
/// TS `transaction()` helper drives statements sequentially, so a single
/// connection is sufficient and sidesteps holding a borrowed `Transaction`.
fn plugin_db_connection(
    state: &PluginRuntimeState,
    plugin_id: &str,
) -> std::result::Result<Arc<Mutex<Connection>>, PluginApiError> {
    if let Some(conn) = state.db_connections.read().get(plugin_id).cloned() {
        return Ok(conn);
    }
    let data_dir = state.plugin_dir(plugin_id).join("data");
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| PluginApiError::internal(format!("db: create data dir: {e}")))?;
    let conn = Connection::open(data_dir.join("plugin.db"))
        .map_err(|e| PluginApiError::internal(format!("db: open: {e}")))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| PluginApiError::internal(format!("db: pragma: {e}")))?;
    let handle = Arc::new(Mutex::new(conn));
    state
        .db_connections
        .write()
        .insert(plugin_id.to_string(), handle.clone());
    Ok(handle)
}

/// Map a JSON parameter to a bindable SQLite value. Objects/arrays are stored as
/// their JSON text (the only lossless option for an affinity-less column).
fn json_to_sql(value: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match value {
        Value::Null => V::Null,
        Value::Bool(b) => V::Integer(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .map(V::Integer)
            .unwrap_or_else(|| V::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => V::Text(s.clone()),
        other => V::Text(other.to_string()),
    }
}

fn db_params(payload: &Value) -> Vec<rusqlite::types::Value> {
    payload
        .get("params")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(json_to_sql).collect())
        .unwrap_or_default()
}

fn sql_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!(b),
    }
}

fn run_query(
    conn: &Connection,
    sql: &str,
    params: &[rusqlite::types::Value],
) -> std::result::Result<Value, PluginApiError> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| PluginApiError::invalid(format!("db:query prepare: {e}")))?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let param_refs: Vec<&dyn rusqlite::ToSql> =
        params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
    let mut rows = stmt
        .query(param_refs.as_slice())
        .map_err(|e| PluginApiError::invalid(format!("db:query: {e}")))?;
    let mut out: Vec<Value> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| PluginApiError::internal(format!("db:query row: {e}")))?
    {
        let mut obj = serde_json::Map::new();
        for (i, name) in col_names.iter().enumerate() {
            let v = row
                .get_ref(i)
                .map_err(|e| PluginApiError::internal(format!("db:query col: {e}")))?;
            obj.insert(name.clone(), sql_to_json(v));
        }
        out.push(Value::Object(obj));
    }
    Ok(Value::Array(out))
}

fn run_execute(
    conn: &Connection,
    sql: &str,
    params: &[rusqlite::types::Value],
) -> std::result::Result<Value, PluginApiError> {
    let param_refs: Vec<&dyn rusqlite::ToSql> =
        params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
    let affected = conn
        .execute(sql, param_refs.as_slice())
        .map_err(|e| PluginApiError::invalid(format!("db:execute: {e}")))?;
    Ok(json!({ "rowsAffected": affected, "lastInsertId": conn.last_insert_rowid() }))
}

/// Quote a SQL identifier, rejecting embedded quotes / NULs so table and column
/// names from the manifest schema can't break out of the DDL.
fn quote_ident(name: &str) -> std::result::Result<String, PluginApiError> {
    if name.is_empty() || name.contains('"') || name.contains('\0') {
        return Err(PluginApiError::invalid(format!(
            "invalid identifier: {name}"
        )));
    }
    Ok(format!("\"{name}\""))
}

fn sql_type_for(col_type: &str) -> &'static str {
    match col_type {
        "integer" | "boolean" => "INTEGER",
        "real" => "REAL",
        "blob" => "BLOB",
        _ => "TEXT",
    }
}

fn build_create_table(name: &str, schema: &Value) -> std::result::Result<String, PluginApiError> {
    let table = quote_ident(name)?;
    let columns = schema
        .get("columns")
        .and_then(Value::as_array)
        .ok_or_else(|| PluginApiError::invalid("createTable: schema.columns must be an array"))?;
    if columns.is_empty() {
        return Err(PluginApiError::invalid(
            "createTable: schema.columns is empty",
        ));
    }
    let mut col_defs: Vec<String> = Vec::new();
    for col in columns {
        let col_name = col
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| PluginApiError::invalid("createTable: column missing name"))?;
        let col_type = col.get("type").and_then(Value::as_str).unwrap_or("text");
        let mut def = format!("{} {}", quote_ident(col_name)?, sql_type_for(col_type));
        if col.get("nullable").and_then(Value::as_bool) == Some(false) {
            def.push_str(" NOT NULL");
        }
        if col.get("unique").and_then(Value::as_bool) == Some(true) {
            def.push_str(" UNIQUE");
        }
        col_defs.push(def);
    }
    if let Some(pk) = schema.get("primaryKey") {
        let pk_cols: Vec<String> = match pk {
            Value::String(s) => vec![quote_ident(s)?],
            Value::Array(arr) => arr
                .iter()
                .filter_map(Value::as_str)
                .map(quote_ident)
                .collect::<std::result::Result<Vec<_>, _>>()?,
            _ => Vec::new(),
        };
        if !pk_cols.is_empty() {
            col_defs.push(format!("PRIMARY KEY ({})", pk_cols.join(", ")));
        }
    }
    Ok(format!(
        "CREATE TABLE IF NOT EXISTS {table} ({})",
        col_defs.join(", ")
    ))
}

/// Per-plugin SQLite operations for `ctx.db.*`. Single-shot query/execute,
/// table DDL, and transaction statements all run on the plugin's one cached
/// connection inside its own sandboxed `plugin.db`.
fn handle_db(
    state: &PluginRuntimeState,
    plugin_id: &str,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    let conn_handle = plugin_db_connection(state, plugin_id)?;
    let conn = conn_handle.lock();
    match op {
        "query" | "txQuery" => run_query(&conn, &payload_str(payload, "sql")?, &db_params(payload)),
        "execute" | "txExecute" => {
            run_execute(&conn, &payload_str(payload, "sql")?, &db_params(payload))
        }
        "createTable" => {
            let name = payload_str(payload, "name")?;
            let schema = payload.get("schema").cloned().unwrap_or(Value::Null);
            conn.execute_batch(&build_create_table(&name, &schema)?)
                .map_err(|e| PluginApiError::invalid(format!("db:createTable: {e}")))?;
            Ok(Value::Null)
        }
        "dropTable" => {
            let name = payload_str(payload, "name")?;
            conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", quote_ident(&name)?))
                .map_err(|e| PluginApiError::invalid(format!("db:dropTable: {e}")))?;
            Ok(Value::Null)
        }
        "tableExists" => {
            let name = payload_str(payload, "name")?;
            let exists = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
                    [&name],
                    |_| Ok(true),
                )
                .optional()
                .map_err(|e| PluginApiError::internal(format!("db:tableExists: {e}")))?
                .unwrap_or(false);
            Ok(Value::Bool(exists))
        }
        "beginTransaction" => {
            conn.execute_batch("BEGIN")
                .map_err(|e| PluginApiError::invalid(format!("db:beginTransaction: {e}")))?;
            Ok(Value::Null)
        }
        "commit" => {
            conn.execute_batch("COMMIT")
                .map_err(|e| PluginApiError::invalid(format!("db:commit: {e}")))?;
            Ok(Value::Null)
        }
        "rollback" => {
            conn.execute_batch("ROLLBACK")
                .map_err(|e| PluginApiError::invalid(format!("db:rollback: {e}")))?;
            Ok(Value::Null)
        }
        _ => Err(PluginApiError::not_supported(&format!("db:{op}"))),
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
            let value = cognia_secrets::keyring_secrets::get(&ns, &key)
                .map_err(|e| PluginApiError::internal(format!("secrets:get: {e}")))?;
            Ok(match value {
                Some(v) => Value::String(v),
                None => Value::Null,
            })
        }
        "set" => {
            let key = payload_str(payload, "key")?;
            let value = payload_str(payload, "value")?;
            cognia_secrets::keyring_secrets::set(&ns, &key, &value)
                .map_err(|e| PluginApiError::internal(format!("secrets:set: {e}")))?;
            Ok(Value::Null)
        }
        "delete" => {
            let key = payload_str(payload, "key")?;
            cognia_secrets::keyring_secrets::clear(&ns, &key)
                .map_err(|e| PluginApiError::internal(format!("secrets:delete: {e}")))?;
            Ok(Value::Null)
        }
        _ => Err(PluginApiError::not_supported(&format!("secrets:{op}"))),
    }
}

const MAX_MANAGED_IDE_STATE_BYTES: usize = 5 * 1024 * 1024;
const MAX_MANAGED_IDE_KEY_BYTES: usize = 1024;

fn managed_ide_partition(payload: &Value) -> std::result::Result<String, PluginApiError> {
    let scope = payload
        .get("scope")
        .and_then(Value::as_object)
        .ok_or_else(|| PluginApiError::invalid("managed IDE scope must be an object"))?;
    let mut hasher = Sha256::new();
    for field in ["userId", "hostId", "workspaceRoot", "area"] {
        let value = scope
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 16 * 1024)
            .ok_or_else(|| {
                PluginApiError::invalid(format!("managed IDE scope.{field} is invalid"))
            })?;
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    Ok(hex::encode(hasher.finalize()))
}

fn managed_ide_key(payload: &Value) -> std::result::Result<String, PluginApiError> {
    payload_str(payload, "key").and_then(|key| {
        if key.is_empty() || key.len() > MAX_MANAGED_IDE_KEY_BYTES || key.contains('\0') {
            Err(PluginApiError::invalid("managed IDE state key is invalid"))
        } else {
            Ok(key)
        }
    })
}

fn managed_ide_state_connection(
    state: &PluginRuntimeState,
    plugin_id: &str,
) -> std::result::Result<Connection, PluginApiError> {
    let data_dir = state.plugin_host_state_dir(plugin_id);
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| PluginApiError::internal(format!("managed IDE state mkdir: {error}")))?;
    let connection = Connection::open(data_dir.join("managed-ide-state.db"))
        .map_err(|error| PluginApiError::internal(format!("managed IDE state open: {error}")))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS managed_ide_state (
               partition TEXT NOT NULL,
               key TEXT NOT NULL,
               value_json TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               PRIMARY KEY (partition, key)
             );
             CREATE TABLE IF NOT EXISTS managed_ide_secret_keys (
               partition TEXT NOT NULL,
               key TEXT NOT NULL,
               PRIMARY KEY (partition, key)
             );",
        )
        .map_err(|error| PluginApiError::internal(format!("managed IDE state schema: {error}")))?;
    Ok(connection)
}

fn handle_managed_ide_state(
    state: &PluginRuntimeState,
    plugin_id: &str,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    let partition = managed_ide_partition(payload)?;
    let mut connection = managed_ide_state_connection(state, plugin_id)?;
    match op {
        "get" => {
            let key = managed_ide_key(payload)?;
            let value = connection
                .query_row(
                    "SELECT value_json FROM managed_ide_state WHERE partition = ?1 AND key = ?2",
                    (&partition, &key),
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE state get: {error}"))
                })?;
            value
                .map(|raw| {
                    serde_json::from_str(&raw).map_err(|error| {
                        PluginApiError::internal(format!(
                            "managed IDE state contains invalid JSON: {error}"
                        ))
                    })
                })
                .transpose()
                .map(|value| value.unwrap_or(Value::Null))
        }
        "set" => {
            let key = managed_ide_key(payload)?;
            let value = payload.get("value").cloned().unwrap_or(Value::Null);
            let encoded = serde_json::to_string(&value)
                .map_err(|error| PluginApiError::invalid(format!("encode state value: {error}")))?;
            if encoded.len() > MAX_MANAGED_IDE_STATE_BYTES {
                return Err(PluginApiError::invalid(format!(
                    "managed IDE state value exceeds {MAX_MANAGED_IDE_STATE_BYTES} bytes"
                )));
            }
            let transaction = connection.transaction().map_err(|error| {
                PluginApiError::internal(format!("managed IDE state transaction: {error}"))
            })?;
            let current_usage: i64 = transaction
                .query_row(
                    "SELECT COALESCE(SUM(length(value_json)), 0) FROM managed_ide_state
                     WHERE partition = ?1 AND key <> ?2",
                    (&partition, &key),
                    |row| row.get(0),
                )
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE state usage: {error}"))
                })?;
            if current_usage.saturating_add(encoded.len() as i64)
                > MAX_MANAGED_IDE_STATE_BYTES as i64
            {
                return Err(PluginApiError::invalid(format!(
                    "managed IDE state partition exceeds {MAX_MANAGED_IDE_STATE_BYTES} bytes"
                )));
            }
            transaction
                .execute(
                    "INSERT INTO managed_ide_state (partition, key, value_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(partition, key) DO UPDATE SET
                       value_json = excluded.value_json,
                       updated_at = excluded.updated_at",
                    (
                        &partition,
                        &key,
                        &encoded,
                        chrono::Utc::now().timestamp_millis(),
                    ),
                )
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE state set: {error}"))
                })?;
            transaction.commit().map_err(|error| {
                PluginApiError::internal(format!("managed IDE state commit: {error}"))
            })?;
            Ok(Value::Null)
        }
        "delete" => {
            let key = managed_ide_key(payload)?;
            connection
                .execute(
                    "DELETE FROM managed_ide_state WHERE partition = ?1 AND key = ?2",
                    (&partition, &key),
                )
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE state delete: {error}"))
                })?;
            Ok(Value::Null)
        }
        "keys" => {
            let mut statement = connection
                .prepare("SELECT key FROM managed_ide_state WHERE partition = ?1 ORDER BY key ASC")
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE state keys: {error}"))
                })?;
            let keys = statement
                .query_map([partition.as_str()], |row| row.get::<_, String>(0))
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE state keys: {error}"))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE state keys: {error}"))
                })?;
            Ok(json!(keys))
        }
        "clear" => {
            connection
                .execute(
                    "DELETE FROM managed_ide_state WHERE partition = ?1",
                    [partition],
                )
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE state clear: {error}"))
                })?;
            Ok(Value::Null)
        }
        _ => Err(PluginApiError::not_supported(&format!(
            "managedIdeState:{op}"
        ))),
    }
}

fn handle_managed_ide_secrets(
    state: &PluginRuntimeState,
    plugin_id: &str,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    let partition = managed_ide_partition(payload)?;
    let namespace = format!("plugin-ide:{plugin_id}:{partition}");
    let connection = managed_ide_state_connection(state, plugin_id)?;
    match op {
        "get" => {
            let key = managed_ide_key(payload)?;
            cognia_secrets::keyring_secrets::get(&namespace, &key)
                .map(|value| value.map_or(Value::Null, Value::String))
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE secrets get: {error}"))
                })
        }
        "set" => {
            let key = managed_ide_key(payload)?;
            let value = payload_str(payload, "value")?;
            cognia_secrets::keyring_secrets::set(&namespace, &key, &value).map_err(|error| {
                PluginApiError::internal(format!("managed IDE secrets set: {error}"))
            })?;
            if let Err(error) = connection.execute(
                "INSERT OR IGNORE INTO managed_ide_secret_keys (partition, key) VALUES (?1, ?2)",
                (&partition, &key),
            ) {
                let _ = cognia_secrets::keyring_secrets::clear(&namespace, &key);
                return Err(PluginApiError::internal(format!(
                    "managed IDE secret index set: {error}"
                )));
            }
            Ok(Value::Null)
        }
        "delete" => {
            let key = managed_ide_key(payload)?;
            cognia_secrets::keyring_secrets::clear(&namespace, &key).map_err(|error| {
                PluginApiError::internal(format!("managed IDE secrets delete: {error}"))
            })?;
            connection
                .execute(
                    "DELETE FROM managed_ide_secret_keys WHERE partition = ?1 AND key = ?2",
                    (&partition, &key),
                )
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE secret index delete: {error}"))
                })?;
            Ok(Value::Null)
        }
        "keys" => {
            let mut statement = connection
                .prepare(
                    "SELECT key FROM managed_ide_secret_keys WHERE partition = ?1 ORDER BY key ASC",
                )
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE secret index keys: {error}"))
                })?;
            let keys = statement
                .query_map([partition.as_str()], |row| row.get::<_, String>(0))
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE secret index keys: {error}"))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| {
                    PluginApiError::internal(format!("managed IDE secret index keys: {error}"))
                })?;
            drop(statement);
            let mut live_keys = Vec::with_capacity(keys.len());
            for key in keys {
                match cognia_secrets::keyring_secrets::get(&namespace, &key) {
                    Ok(Some(_)) => live_keys.push(key),
                    Ok(None) => {
                        connection
                            .execute(
                                "DELETE FROM managed_ide_secret_keys
                                 WHERE partition = ?1 AND key = ?2",
                                (&partition, &key),
                            )
                            .map_err(|error| {
                                PluginApiError::internal(format!(
                                    "managed IDE secret index reconcile: {error}"
                                ))
                            })?;
                    }
                    Err(error) => {
                        return Err(PluginApiError::internal(format!(
                            "managed IDE secrets enumerate: {error}"
                        )));
                    }
                }
            }
            Ok(json!(live_keys))
        }
        _ => Err(PluginApiError::not_supported(&format!(
            "managedIdeSecrets:{op}"
        ))),
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
            let has = app
                .clipboard()
                .read_text()
                .map(|t| !t.is_empty())
                .unwrap_or(false);
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
    plugin_id: &str,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    use super::window_ops;
    let map = |r: Result<()>| {
        r.map(|_| Value::Null)
            .map_err(|e| PluginApiError::internal(e.to_string()))
    };
    let into_err = |e: PluginError| PluginApiError::internal(e.to_string());
    let window_id = payload
        .get("windowId")
        .and_then(Value::as_str)
        .unwrap_or("main");
    match op {
        // Legacy main-window controls (the TS PluginWindow.minimize/maximize
        // call these directly without a windowId).
        "minimize" => map(window_ops::plugin_window_minimize(app.clone()).await),
        "maximize" => map(window_ops::plugin_window_maximize(app.clone()).await),
        "unmaximize" => map(window_ops::plugin_window_unmaximize(app.clone()).await),
        "setAlwaysOnTop" => {
            let flag = payload_bool(payload, "flag", true);
            map(window_ops::plugin_window_set_always_on_top(app.clone(), flag).await)
        }
        "create" => {
            let options = payload.get("options").cloned().unwrap_or(Value::Null);
            window_ops::plugin_window_create(app, plugin_id, &options)
                .await
                .map(Value::String)
                .map_err(into_err)
        }
        "close" | "show" | "hide" | "focus" | "center" | "setTitle" | "setSize" | "setPosition"
        | "getSize" | "getPosition" | "isMaximized" => {
            window_ops::plugin_window_op(app, plugin_id, window_id, op, payload)
                .await
                .map_err(into_err)
        }
        _ => Err(PluginApiError::not_supported(&format!("window:{op}"))),
    }
}

/// Per-plugin egress gate for domain, HTTP method, and pathname. A plugin that
/// declared no allowlist is denied by default. Fail-closed on an unparseable
/// URL / host.
fn guard_network_request(
    state: &PluginRuntimeState,
    plugin_id: &str,
    url: &str,
    method: &str,
) -> std::result::Result<(), PluginApiError> {
    match url::Url::parse(url).ok().and_then(|u| {
        u.host_str()
            .map(|host| (host.to_string(), u.path().to_string()))
    }) {
        Some((host, path)) if state.network_request_allowed(plugin_id, &host, method, &path) => {
            Ok(())
        }
        Some((host, _)) => Err(PluginApiError::permission_denied(format!(
            "network policy denied {method} egress to {host} for plugin {plugin_id}"
        ))),
        None => Err(PluginApiError::invalid(format!(
            "network: cannot extract host from URL: {url}"
        ))),
    }
}

fn network_http_client() -> std::result::Result<reqwest::Client, PluginApiError> {
    reqwest::Client::builder()
        .user_agent("cognia-plugin-network/0.1")
        .build()
        .map_err(|e| PluginApiError::internal(format!("network: http client init: {e}")))
}

/// Optional `headers` map a plugin may attach to a download/upload request.
fn payload_headers(payload: &Value) -> HashMap<String, String> {
    payload
        .get("headers")
        .and_then(|h| serde_json::from_value::<HashMap<String, String>>(h.clone()).ok())
        .unwrap_or_default()
}

async fn handle_network(
    state: &PluginRuntimeState,
    plugin_id: &str,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    use cognia_connectors::types::TauriHttpRequest;
    match op {
        "fetch" => {
            let url = payload_str(payload, "url")?;
            let options = payload.get("options").cloned().unwrap_or(Value::Null);
            let method = options
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .to_string();
            guard_network_request(state, plugin_id, &url, &method)?;
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
                allow_invalid_certificates: None,
            };
            let resp = cognia_connectors::http_client::http_request(req)
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
        // Stream a remote URL into the plugin's own data sandbox. The
        // destination is `resolve_scoped`, so a plugin can never write the
        // download outside `<install_dir>/<id>/data`.
        "download" => {
            let url = payload_str(payload, "url")?;
            let dest_rel = payload_str(payload, "destPath")?;
            guard_network_request(state, plugin_id, &url, "GET")?;
            resolve_scoped(state, plugin_id, &dest_rel)?;

            let client = network_http_client()?;
            let mut req = client.get(&url);
            for (k, v) in payload_headers(payload) {
                req = req.header(k, v);
            }
            let resp = req
                .send()
                .await
                .map_err(|e| PluginApiError::internal(format!("network:download: {e}")))?;
            if !resp.status().is_success() {
                return Err(PluginApiError::internal(format!(
                    "network:download: HTTP {}",
                    resp.status().as_u16()
                )));
            }
            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| PluginApiError::internal(format!("network:download body: {e}")))?;
            resolve_scoped(state, plugin_id, &dest_rel)?;
            crate::contained_path::write_plugin_file(
                &state.plugin_dir(plugin_id),
                &data_handle_path(&dest_rel)?.to_string_lossy(),
                &bytes,
            )
            .map_err(|e| PluginApiError::internal(format!("network:download write: {e}")))?;
            Ok(json!({
                "path": dest_rel,
                "size": bytes.len(),
                "contentType": content_type,
            }))
        }
        // Upload a file FROM the plugin sandbox to a remote URL. Raw body by
        // default; multipart/form-data when `fieldName` is supplied.
        "upload" => {
            let url = payload_str(payload, "url")?;
            let file_rel = payload_str(payload, "filePath")?;
            guard_network_request(state, plugin_id, &url, "POST")?;
            let file_content_policy = payload
                .get("fileContentPolicy")
                .and_then(Value::as_str)
                .unwrap_or("block");
            if file_content_policy != "allow" {
                return Err(PluginApiError::permission_denied(
                    "network:upload file content is blocked; set fileContentPolicy=allow and declare dataClassification",
                ));
            }
            if payload
                .get("dataClassification")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err(PluginApiError::permission_denied(
                    "network:upload requires dataClassification when fileContentPolicy=allow",
                ));
            }
            let src = resolve_scoped(state, plugin_id, &file_rel)?;
            let bytes = crate::contained_path::read_existing_plugin_file(
                &state.plugin_dir(plugin_id),
                &data_handle_path(&file_rel)?.to_string_lossy(),
            )
            .map_err(|e| {
                PluginApiError::internal(format!("network:upload read {file_rel}: {e}"))
            })?;

            let method_str = payload
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("POST")
                .to_uppercase();
            let method = reqwest::Method::from_bytes(method_str.as_bytes()).map_err(|_| {
                PluginApiError::invalid(format!("network:upload: bad method {method_str}"))
            })?;
            let client = network_http_client()?;
            let mut req = client.request(method, &url);
            for (k, v) in payload_headers(payload) {
                req = req.header(k, v);
            }
            req = match payload.get("fieldName").and_then(Value::as_str) {
                Some(field) => {
                    let file_name = src
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("upload.bin")
                        .to_string();
                    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
                    req.multipart(reqwest::multipart::Form::new().part(field.to_string(), part))
                }
                None => req.body(bytes),
            };
            let resp = req
                .send()
                .await
                .map_err(|e| PluginApiError::internal(format!("network:upload: {e}")))?;
            let status = resp.status().as_u16();
            let headers: HashMap<String, String> = resp
                .headers()
                .iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.to_string(), s.to_string())))
                .collect();
            let data = resp
                .text()
                .await
                .map_err(|e| PluginApiError::internal(format!("network:upload body: {e}")))?;
            Ok(json!({
                "ok": (200..300).contains(&status),
                "status": status,
                "statusText": "",
                "headers": headers,
                "data": data,
            }))
        }
        _ => Err(PluginApiError::not_supported(&format!("network:{op}"))),
    }
}

/// Shell domain. DENY-by-default declarative model (Zed-style): a plugin may
/// only run a command it declared in `manifest.shellCommands` — enforced by
/// `state.shell_command_allowed` — AND must hold the `shell:execute`
/// permission, which is dangerous → user-consented at the renderer guard. The
/// command runs with a CLEARED environment (only `PATH` + any plugin-supplied
/// `env` survive) so plugin code can't read host secrets like API keys.
async fn handle_shell(
    app: Option<&AppHandle>,
    state: &PluginRuntimeState,
    plugin_id: &str,
    op: &str,
    payload: &Value,
) -> std::result::Result<Value, PluginApiError> {
    use tauri_plugin_opener::OpenerExt;
    match op {
        "execute" => {
            // `command` is the PROGRAM name (the allowlist key); arguments are
            // passed explicitly via `options.args` and never interpreted by a
            // shell, so a declared `echo` can't smuggle `&& rm -rf` through the
            // command string.
            let command = payload_str(payload, "command")?;
            if !state.shell_command_allowed(plugin_id, &command) {
                return Err(PluginApiError::permission_denied(format!(
                    "shell:execute denied: '{command}' is not in plugin {plugin_id}'s declared shellCommands allowlist"
                )));
            }
            let options = payload.get("options").cloned().unwrap_or(Value::Null);
            let args: Vec<String> = options
                .get("args")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let cwd = options.get("cwd").and_then(Value::as_str).map(String::from);
            let env: HashMap<String, String> = options
                .get("env")
                .and_then(|e| serde_json::from_value(e.clone()).ok())
                .unwrap_or_default();
            let timeout_ms = options
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(30_000);
            run_shell_exec(command, args, cwd, env, timeout_ms, plugin_id.to_string()).await
        }
        "open" => {
            let path = payload_str(payload, "path")?;
            let app = app.ok_or_else(|| PluginApiError::not_supported("shell:open"))?;
            app.opener()
                .open_path(path.clone(), None::<&str>)
                .map_err(|e| PluginApiError::internal(format!("shell:open: {e}")))?;
            Ok(json!({ "opened": path }))
        }
        "showInFolder" => {
            let path = payload_str(payload, "path")?;
            let app = app.ok_or_else(|| PluginApiError::not_supported("shell:showInFolder"))?;
            app.opener()
                .reveal_item_in_dir(&path)
                .map_err(|e| PluginApiError::internal(format!("shell:showInFolder: {e}")))?;
            Ok(json!({ "revealed": path }))
        }
        _ => Err(PluginApiError::not_supported(&format!("shell:{op}"))),
    }
}

/// Spawn an allow-listed command on a blocking pool, enforce a wall-clock
/// timeout, and capture stdout/stderr. The environment is cleared (only `PATH`
/// + caller-supplied `env`) so a plugin can't exfiltrate host secrets.
async fn run_shell_exec(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    timeout_ms: u64,
    plugin_id: String,
) -> std::result::Result<Value, PluginApiError> {
    let out = tokio::task::spawn_blocking(
        move || -> std::result::Result<(i32, String, String), String> {
            let mut cmd = std::process::Command::new(&command);
            cmd.args(&args);
            if let Some(c) = cwd.as_deref() {
                cmd.current_dir(c);
            }
            cmd.env_clear();
            // PATH is not a secret and is needed to resolve bare command names.
            if let Ok(path) = std::env::var("PATH") {
                cmd.env("PATH", path);
            }
            for (k, v) in &env {
                cmd.env(k, v);
            }
            let mut child = cmd
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("spawn {command}: {e}"))?;
            let dur = std::time::Duration::from_millis(timeout_ms);
            match wait_timeout::ChildExt::wait_timeout(&mut child, dur)
                .map_err(|e| format!("wait_timeout: {e}"))?
            {
                Some(status) => {
                    let mut so = Vec::new();
                    let mut se = Vec::new();
                    if let Some(mut s) = child.stdout.take() {
                        std::io::Read::read_to_end(&mut s, &mut so).ok();
                    }
                    if let Some(mut s) = child.stderr.take() {
                        std::io::Read::read_to_end(&mut s, &mut se).ok();
                    }
                    Ok((
                        status.code().unwrap_or(-1),
                        String::from_utf8_lossy(&so).into_owned(),
                        String::from_utf8_lossy(&se).into_owned(),
                    ))
                }
                None => {
                    let _ = child.kill();
                    Err(format!(
                        "shell:execute timed out after {timeout_ms}ms (plugin {plugin_id})"
                    ))
                }
            }
        },
    )
    .await
    .map_err(|e| PluginApiError::internal(format!("shell:execute join: {e}")))?
    .map_err(PluginApiError::internal)?;
    // Mirror the SDK `ShellResult` shape ({ code, stdout, stderr, success }).
    Ok(json!({
        "code": out.0,
        "stdout": out.1,
        "stderr": out.2,
        "success": out.0 == 0,
    }))
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
        ("managedIdeSecrets", "get" | "keys") => Some("secrets:read"),
        ("managedIdeSecrets", "set" | "delete") => Some("secrets:write"),
        ("clipboard", "readText" | "hasText") => Some("clipboard:read"),
        ("clipboard", "writeText" | "clear") => Some("clipboard:write"),
        ("network", "fetch" | "download") => Some("network:fetch"),
        ("network", "upload") => Some("network:upload"),
        ("db", "query" | "tableExists" | "txQuery") => Some("database:read"),
        (
            "db",
            "execute" | "createTable" | "dropTable" | "beginTransaction" | "txExecute" | "commit"
            | "rollback",
        ) => Some("database:write"),
        ("shell", "execute" | "open" | "showInFolder") => Some("shell:execute"),
        // window:* is UI-cosmetic; process:* has no backend.
        _ => None,
    }
}

/// Route one `domain:operation` api string to its handler.
async fn dispatch(
    app: Option<&AppHandle>,
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
        "managedIdeState" => handle_managed_ide_state(state, plugin_id, op, payload),
        "managedIdeSecrets" => handle_managed_ide_secrets(state, plugin_id, op, payload),
        "clipboard" => match app {
            Some(app) => handle_clipboard(app, op, payload).await,
            None => Err(PluginApiError::not_supported(api)),
        },
        "window" => match app {
            Some(app) => handle_window(app, plugin_id, op, payload).await,
            None => Err(PluginApiError::not_supported(api)),
        },
        "network" => handle_network(state, plugin_id, op, payload).await,
        "db" => handle_db(state, plugin_id, op, payload),
        "shell" => handle_shell(app, state, plugin_id, op, payload).await,
        // `process:*` (spawn/kill of long-lived children) has no host backend;
        // `shell:execute` covers one-shot command execution.
        "process" => Err(PluginApiError::not_supported(api)),
        _ => Err(PluginApiError::not_supported(api)),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async fn plugin_api_invoke_for_host(
    app: Option<&AppHandle>,
    state: &PluginRuntimeState,
    request: PluginApiInvokeRequest,
) -> Result<PluginApiInvokeResponse> {
    let PluginApiInvokeRequest {
        sdk_version,
        plugin_id,
        request_id,
        api,
        payload,
    } = request;

    if !sdk_is_compatible(&sdk_version) {
        return Ok(err_response(
            &request_id,
            &sdk_version,
            PluginApiError::incompatible_sdk(&sdk_version),
        ));
    }

    if !state.plugins.read().contains_key(&plugin_id) {
        return Ok(err_response(
            &request_id,
            &sdk_version,
            PluginApiError::new("NOT_FOUND", format!("plugin not loaded: {plugin_id}")),
        ));
    }

    Ok(
        match dispatch(app, state, &plugin_id, &api, &payload).await {
            Ok(data) => ok_response(&request_id, &sdk_version, data),
            Err(error) => err_response(&request_id, &sdk_version, error),
        },
    )
}

/// Invoke the canonical gateway without a desktop UI host. Filesystem,
/// secrets, network, database, and allowlisted process execution keep their
/// existing backends and permission gates; UI-only namespaces return the same
/// typed `NOT_SUPPORTED` response as any unavailable capability.
pub async fn plugin_api_invoke_for_state(
    state: &PluginRuntimeState,
    request: PluginApiInvokeRequest,
) -> Result<PluginApiInvokeResponse> {
    plugin_api_invoke_for_host(None, state, request).await
}

#[tauri::command]
pub async fn plugin_api_invoke(
    app: AppHandle,
    state: State<'_, PluginRuntimeState>,
    request: PluginApiInvokeRequest,
) -> Result<PluginApiInvokeResponse> {
    plugin_api_invoke_for_host(Some(&app), &state, request).await
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

async fn plugin_api_batch_invoke_for_host(
    app: Option<&AppHandle>,
    state: &PluginRuntimeState,
    request: BatchInvokeRequest,
) -> Result<BatchInvokeResponse> {
    let BatchInvokeRequest {
        sdk_version,
        plugin_id,
        strategy,
        requests,
    } = request;

    if !sdk_is_compatible(&sdk_version) {
        let results = requests
            .iter()
            .map(|item| {
                err_response(
                    &item.request_id,
                    &sdk_version,
                    PluginApiError::incompatible_sdk(&sdk_version),
                )
            })
            .collect();
        return Ok(BatchInvokeResponse {
            success: false,
            results,
        });
    }

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
            match dispatch(app, state, &plugin_id, &item.api, &item.payload).await {
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

pub async fn plugin_api_batch_invoke_for_state(
    state: &PluginRuntimeState,
    request: BatchInvokeRequest,
) -> Result<BatchInvokeResponse> {
    plugin_api_batch_invoke_for_host(None, state, request).await
}

#[tauri::command]
pub async fn plugin_api_batch_invoke(
    app: AppHandle,
    state: State<'_, PluginRuntimeState>,
    request: BatchInvokeRequest,
) -> Result<BatchInvokeResponse> {
    plugin_api_batch_invoke_for_host(Some(&app), &state, request).await
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
/// services. [`plugin_get_capabilities_for_host`] adjusts desktop-UI-only
/// entries for a headless process so SDK authors can branch before invocation.
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
        cap("managedIdeState:get", true, false, &[]),
        cap("managedIdeState:set", true, false, &[]),
        cap("managedIdeState:delete", true, false, &[]),
        cap("managedIdeState:keys", true, false, &[]),
        cap("managedIdeState:clear", true, false, &[]),
        cap("managedIdeSecrets:get", true, true, &["secrets:read"]),
        cap("managedIdeSecrets:set", true, true, &["secrets:write"]),
        cap("managedIdeSecrets:delete", true, true, &["secrets:write"]),
        cap("managedIdeSecrets:keys", true, true, &["secrets:read"]),
        cap("clipboard:readText", true, false, &["clipboard:read"]),
        cap("clipboard:writeText", true, false, &["clipboard:write"]),
        cap("clipboard:hasText", true, false, &["clipboard:read"]),
        cap("clipboard:clear", true, false, &["clipboard:write"]),
        cap("window:minimize", true, false, &[]),
        cap("window:maximize", true, false, &[]),
        cap("window:unmaximize", true, false, &[]),
        cap("window:setAlwaysOnTop", true, false, &[]),
        cap("network:fetch", true, false, &["network:fetch"]),
        cap("network:download", true, false, &["network:fetch"]),
        cap("network:upload", true, true, &["network:upload"]),
        cap("db:query", true, false, &["database:read"]),
        cap("db:tableExists", true, false, &["database:read"]),
        cap("db:execute", true, true, &["database:write"]),
        cap("db:createTable", true, true, &["database:write"]),
        cap("db:dropTable", true, true, &["database:write"]),
        cap("shell:execute", true, true, &["shell:execute"]),
        cap("shell:open", true, true, &["shell:execute"]),
        cap("shell:showInFolder", true, true, &["shell:execute"]),
    ]
}

pub fn plugin_get_capabilities_for_host(has_desktop_ui: bool) -> Vec<PluginApiCapability> {
    let mut capabilities = capability_table();
    if !has_desktop_ui {
        for capability in &mut capabilities {
            if capability.api.starts_with("clipboard:")
                || capability.api.starts_with("window:")
                || matches!(capability.api.as_str(), "shell:open" | "shell:showInFolder")
            {
                capability.supported = false;
            }
        }
    }
    capabilities
}

#[tauri::command]
pub async fn plugin_get_capabilities() -> Result<Vec<PluginApiCapability>> {
    Ok(plugin_get_capabilities_for_host(true))
}

/// Push a plugin's declared `manifest.shellCommands` into the host so the
/// `shell:execute` gate can enforce its deny-by-default allowlist. Called by
/// the renderer at plugin load; an empty list (or never calling this) leaves
/// the plugin unable to run any command.
#[tauri::command]
pub async fn plugin_set_shell_allowlist(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    commands: Vec<String>,
) -> Result<()> {
    state.set_shell_allowlist(&plugin_id, commands);
    Ok(())
}

/// Push a plugin's declared `manifest.networkAccess.allowedDomains` into the
/// host so the `network:*` egress gate enforces it. Called by the renderer at
/// plugin load. A plugin that never calls this (declares no allowlist) is
/// denied all egress by default — declaring an allowlist (or `["*"]` to opt
/// into unrestricted egress) is required to reach any host.
#[tauri::command]
pub async fn plugin_set_network_allowlist(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    domains: Vec<String>,
    rules: Option<Vec<NetworkAccessRule>>,
) -> Result<()> {
    state.set_network_allowlist(&plugin_id, domains);
    if let Some(rules) = rules {
        state.set_network_rules(&plugin_id, rules);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PluginRecord, PluginRuntimeSnapshot, PluginRuntimeState};
    use tempfile::TempDir;

    fn seeded_state(tmp: &TempDir) -> PluginRuntimeState {
        let state = PluginRuntimeState::new(PathBuf::from(tmp.path()));
        std::fs::create_dir_all(state.plugin_dir("demo")).unwrap();
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

    fn ide_scope(user_id: &str, host_id: &str, workspace_root: &str, area: &str) -> Value {
        json!({
            "scope": {
                "userId": user_id,
                "hostId": host_id,
                "workspaceRoot": workspace_root,
                "area": area,
            }
        })
    }

    #[test]
    fn managed_ide_state_is_host_owned_and_partitioned() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let workspace_a = ide_scope("acct_a", "local", "/workspace/a", "workspace");
        let workspace_b = ide_scope("acct_a", "local", "/workspace/b", "workspace");
        let set_a = json!({
            "scope": workspace_a["scope"],
            "key": "selection",
            "value": { "line": 7 }
        });
        handle_managed_ide_state(&state, "demo", "set", &set_a).unwrap();

        let get_a = json!({ "scope": workspace_a["scope"], "key": "selection" });
        let get_b = json!({ "scope": workspace_b["scope"], "key": "selection" });
        assert_eq!(
            handle_managed_ide_state(&state, "demo", "get", &get_a).unwrap(),
            json!({ "line": 7 })
        );
        assert_eq!(
            handle_managed_ide_state(&state, "demo", "get", &get_b).unwrap(),
            Value::Null
        );
        assert!(state
            .plugin_host_state_dir("demo")
            .join("managed-ide-state.db")
            .is_file());
        assert!(!state
            .plugin_dir("demo")
            .join("data/managed-ide-state.db")
            .exists());
    }

    #[test]
    fn managed_ide_state_validates_keys_and_enforces_partition_quota() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let scope = ide_scope("acct_a", "local", "/workspace/a", "global");
        let invalid = json!({ "scope": scope["scope"], "key": "", "value": true });
        assert!(handle_managed_ide_state(&state, "demo", "set", &invalid).is_err());

        let oversized = json!({
            "scope": scope["scope"],
            "key": "large",
            "value": "x".repeat(MAX_MANAGED_IDE_STATE_BYTES + 1)
        });
        assert!(handle_managed_ide_state(&state, "demo", "set", &oversized).is_err());
    }

    #[test]
    fn managed_ide_secrets_are_keyring_backed_indexed_and_partitioned() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let workspace_a = ide_scope("acct_a", "local", "/workspace/a", "secrets");
        let workspace_b = ide_scope("acct_a", "local", "/workspace/b", "secrets");
        let key = format!("token-{}", uuid::Uuid::new_v4());
        let set = json!({ "scope": workspace_a["scope"], "key": key.clone(), "value": "secret" });
        handle_managed_ide_secrets(&state, "demo", "set", &set).unwrap();

        let get_a = json!({ "scope": workspace_a["scope"], "key": key.clone() });
        let get_b = json!({ "scope": workspace_b["scope"], "key": key.clone() });
        assert_eq!(
            handle_managed_ide_secrets(&state, "demo", "get", &get_a).unwrap(),
            Value::String("secret".into())
        );
        assert_eq!(
            handle_managed_ide_secrets(&state, "demo", "get", &get_b).unwrap(),
            Value::Null
        );
        assert_eq!(
            handle_managed_ide_secrets(
                &state,
                "demo",
                "keys",
                &json!({ "scope": workspace_a["scope"] })
            )
            .unwrap(),
            json!([key.clone()])
        );
        handle_managed_ide_secrets(&state, "demo", "delete", &get_a).unwrap();
        assert_eq!(
            handle_managed_ide_secrets(
                &state,
                "demo",
                "keys",
                &json!({ "scope": workspace_a["scope"] })
            )
            .unwrap(),
            json!([])
        );
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
        let read = handle_fs(
            &state,
            "demo",
            "readText",
            &json!({ "path": "sub/file.txt" }),
        )
        .unwrap();
        assert_eq!(read, Value::String("hello".into()));
        let exists =
            handle_fs(&state, "demo", "exists", &json!({ "path": "sub/file.txt" })).unwrap();
        assert_eq!(exists, Value::Bool(true));
    }

    #[cfg(unix)]
    #[test]
    fn fs_rejects_symlinked_segments_inside_the_data_sandbox() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let data = state.plugin_dir("demo").join("data");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, data.join("link")).unwrap();

        let error = handle_fs(
            &state,
            "demo",
            "readText",
            &json!({ "path": "link/secret.txt" }),
        )
        .unwrap_err();
        assert_eq!(error.code, "PERMISSION_DENIED");
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
    fn sdk_is_compatible_enforces_minimum() {
        // Wire default ("2.0.0") and the floor itself are compatible.
        assert!(sdk_is_compatible("2.0.0"));
        assert!(sdk_is_compatible("1.0.0"));
        assert!(sdk_is_compatible("1.5.3"));
        assert!(sdk_is_compatible("2")); // lenient on missing minor/patch
        assert!(sdk_is_compatible("2.0"));
        // Below the floor, or unparseable → incompatible (fail-closed).
        assert!(!sdk_is_compatible("0.9.0"));
        assert!(!sdk_is_compatible("0.0.1"));
        assert!(!sdk_is_compatible("garbage"));
        assert!(!sdk_is_compatible(""));
    }

    #[test]
    fn compat_for_reports_real_compatibility() {
        let ok = compat_for("2.0.0");
        assert!(ok.compatible);
        assert_eq!(ok.min_supported_sdk, "1.0.0");
        let bad = compat_for("0.9.0");
        assert!(!bad.compatible);
        assert_eq!(bad.min_supported_sdk, "1.0.0");
    }

    #[test]
    fn incompatible_sdk_error_has_typed_code() {
        let resp = err_response("req-3", "0.9.0", PluginApiError::incompatible_sdk("0.9.0"));
        assert!(!resp.success);
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"code\":\"INCOMPATIBLE_SDK\""));
        assert!(s.contains("\"compatible\":false"));
    }

    #[test]
    fn capability_table_marks_db_supported_and_shell_unsupported() {
        let caps = capability_table();
        // db now has a real per-plugin SQLite backend.
        let db = caps.iter().find(|c| c.api == "db:query").unwrap();
        assert!(db.supported);
        assert!(db
            .required_permissions
            .contains(&"database:read".to_string()));
        let db_exec = caps.iter().find(|c| c.api == "db:execute").unwrap();
        assert!(db_exec.supported && db_exec.high_risk);
        // shell:execute now has a real, allowlist-gated host backend.
        let shell = caps.iter().find(|c| c.api == "shell:execute").unwrap();
        assert!(shell.supported && shell.high_risk);
        assert!(shell
            .required_permissions
            .contains(&"shell:execute".to_string()));
        let fs_write = caps.iter().find(|c| c.api == "fs:writeText").unwrap();
        assert!(fs_write.supported && fs_write.high_risk);
        assert!(fs_write
            .required_permissions
            .contains(&"filesystem:write".to_string()));
    }

    #[test]
    fn network_download_and_upload_are_advertised_supported() {
        let caps = capability_table();
        let dl = caps.iter().find(|c| c.api == "network:download").unwrap();
        assert!(dl.supported);
        assert!(dl
            .required_permissions
            .contains(&"network:fetch".to_string()));
        let up = caps.iter().find(|c| c.api == "network:upload").unwrap();
        assert!(up.supported && up.high_risk);
        assert!(up
            .required_permissions
            .contains(&"network:upload".to_string()));
    }

    #[test]
    fn required_permission_covers_network_download_and_upload() {
        assert_eq!(
            required_permission("network", "download"),
            Some("network:fetch")
        );
        assert_eq!(
            required_permission("network", "upload"),
            Some("network:upload")
        );
    }

    #[test]
    fn network_guard_enforces_method_and_path_rules() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        state.set_network_allowlist("demo", vec!["observability.test".into()]);
        state.set_network_rules(
            "demo",
            vec![NetworkAccessRule {
                domain: "observability.test".into(),
                methods: vec!["GET".into()],
                paths: vec!["/api/logs/*".into()],
            }],
        );

        assert!(guard_network_request(
            &state,
            "demo",
            "https://observability.test/api/logs/recent?limit=10",
            "GET"
        )
        .is_ok());
        assert_eq!(
            guard_network_request(
                &state,
                "demo",
                "https://observability.test/api/logs/recent",
                "DELETE"
            )
            .unwrap_err()
            .code,
            "PERMISSION_DENIED"
        );
        assert_eq!(
            guard_network_request(
                &state,
                "demo",
                "https://observability.test/api/admin",
                "GET"
            )
            .unwrap_err()
            .code,
            "PERMISSION_DENIED"
        );
    }

    #[tokio::test]
    async fn download_rejects_a_dest_path_escaping_the_sandbox() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        // No allowlist declared, so the egress gate itself denies the host —
        // either that or the sandbox-scope check would reject the traversal;
        // both fail closed with the same PERMISSION_DENIED error code.
        let err = handle_network(
            &state,
            "demo",
            "download",
            &json!({ "url": "https://files.test/a.bin", "destPath": "../escape.bin" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "PERMISSION_DENIED");
    }

    #[tokio::test]
    async fn download_denies_a_non_allowlisted_host() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        state.set_network_allowlist("demo", vec!["allowed.test".into()]);
        let err = handle_network(
            &state,
            "demo",
            "download",
            &json!({ "url": "https://evil.test/a.bin", "destPath": "out.bin" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "PERMISSION_DENIED");
    }

    #[tokio::test]
    async fn upload_reports_a_missing_sandbox_file() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        // A declared allowlist passes the egress gate; the read of a
        // nonexistent sandbox file fails before any network call.
        state.set_network_allowlist("demo", vec!["files.test".into()]);
        let err = handle_network(
            &state,
            "demo",
            "upload",
            &json!({
                "url": "https://files.test/u",
                "filePath": "nope.bin",
                "fileContentPolicy": "allow",
                "dataClassification": "internal"
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "INTERNAL");
    }

    #[tokio::test]
    async fn upload_blocks_file_content_by_default() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        state.set_network_allowlist("demo", vec!["files.test".into()]);
        let err = handle_network(
            &state,
            "demo",
            "upload",
            &json!({ "url": "https://files.test/u", "filePath": "payload.bin" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "PERMISSION_DENIED");
        assert!(err.message.contains("file content is blocked"));
    }

    #[tokio::test]
    async fn upload_allow_requires_data_classification() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        state.set_network_allowlist("demo", vec!["files.test".into()]);
        let err = handle_network(
            &state,
            "demo",
            "upload",
            &json!({
                "url": "https://files.test/u",
                "filePath": "payload.bin",
                "fileContentPolicy": "allow"
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "PERMISSION_DENIED");
        assert!(err.message.contains("requires dataClassification"));
    }

    #[tokio::test]
    async fn download_allows_a_declared_domain_but_denies_others() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        state.set_network_allowlist("demo", vec!["allowed.test".into()]);
        // A declared but non-matching host is denied before any fetch.
        let err = handle_network(
            &state,
            "demo",
            "download",
            &json!({ "url": "https://evil.test/a.bin", "destPath": "x.bin" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "PERMISSION_DENIED");
        // A different plugin that declared nothing is denied by default too
        // (fail-closed) — an undeclared allowlist is no longer unrestricted.
        let other = handle_network(
            &state,
            "undeclared",
            "download",
            &json!({ "url": "https://evil.test/a.bin", "destPath": "x.bin" }),
        )
        .await
        .unwrap_err();
        assert_eq!(other.code, "PERMISSION_DENIED");
    }

    #[test]
    fn shell_command_allowed_is_deny_by_default_and_stem_matched() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        // Deny-by-default: a plugin that declared nothing runs nothing.
        assert!(!state.shell_command_allowed("demo", "git"));
        state.set_shell_allowlist("demo", vec!["git".into(), "node".into()]);
        assert!(state.shell_command_allowed("demo", "git"));
        assert!(state.shell_command_allowed("demo", "git.exe")); // .exe stem tolerated
        assert!(state.shell_command_allowed("demo", "/usr/bin/git")); // absolute-path stem
        assert!(!state.shell_command_allowed("demo", "rm")); // undeclared → denied
        assert!(!state.shell_command_allowed("other", "git")); // wrong plugin → denied
    }

    #[tokio::test]
    async fn run_shell_exec_captures_stdout_and_exit_code() {
        let (cmd, args) = if cfg!(windows) {
            (
                "cmd".to_string(),
                vec!["/C".to_string(), "echo".to_string(), "hello".to_string()],
            )
        } else {
            ("printf".to_string(), vec!["hello".to_string()])
        };
        let out = run_shell_exec(cmd, args, None, HashMap::new(), 30_000, "demo".into())
            .await
            .unwrap();
        assert_eq!(out.get("code").and_then(Value::as_i64), Some(0));
        assert_eq!(out.get("success").and_then(Value::as_bool), Some(true));
        assert!(out
            .get("stdout")
            .and_then(Value::as_str)
            .unwrap()
            .contains("hello"));
    }

    #[tokio::test]
    async fn run_shell_exec_times_out_on_a_long_command() {
        // A command that sleeps past the deadline must be killed and error.
        let (cmd, args) = if cfg!(windows) {
            (
                "cmd".to_string(),
                vec![
                    "/C".to_string(),
                    "ping".to_string(),
                    "-n".to_string(),
                    "5".to_string(),
                    "127.0.0.1".to_string(),
                ],
            )
        } else {
            ("sleep".to_string(), vec!["5".to_string()])
        };
        let err = run_shell_exec(cmd, args, None, HashMap::new(), 200, "demo".into())
            .await
            .unwrap_err();
        assert!(err.message.contains("timed out"), "got: {}", err.message);
    }

    #[test]
    fn db_create_insert_query_roundtrips_in_the_plugin_sandbox() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        handle_db(
            &state,
            "demo",
            "createTable",
            &json!({
                "name": "notes",
                "schema": {
                    "columns": [
                        { "name": "id", "type": "integer" },
                        { "name": "body", "type": "text", "nullable": false }
                    ],
                    "primaryKey": "id"
                }
            }),
        )
        .unwrap();

        assert_eq!(
            handle_db(&state, "demo", "tableExists", &json!({ "name": "notes" })).unwrap(),
            Value::Bool(true)
        );

        let exec = handle_db(
            &state,
            "demo",
            "execute",
            &json!({ "sql": "INSERT INTO notes (id, body) VALUES (?1, ?2)", "params": [1, "hello"] }),
        )
        .unwrap();
        assert_eq!(exec.get("rowsAffected").and_then(Value::as_i64), Some(1));

        let rows = handle_db(
            &state,
            "demo",
            "query",
            &json!({ "sql": "SELECT id, body FROM notes WHERE id = ?1", "params": [1] }),
        )
        .unwrap();
        assert_eq!(
            rows,
            json!([{ "id": 1, "body": "hello" }]),
            "query returns column-keyed JSON rows"
        );

        // The file lives inside the plugin's own data sandbox.
        assert!(state
            .plugin_dir("demo")
            .join("data")
            .join("plugin.db")
            .exists());
    }

    #[test]
    fn db_transaction_rollback_discards_writes() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        handle_db(
            &state,
            "demo",
            "createTable",
            &json!({ "name": "t", "schema": { "columns": [{ "name": "v", "type": "integer" }] } }),
        )
        .unwrap();
        handle_db(&state, "demo", "beginTransaction", &json!({ "txId": "x" })).unwrap();
        handle_db(
            &state,
            "demo",
            "txExecute",
            &json!({ "txId": "x", "sql": "INSERT INTO t (v) VALUES (1)" }),
        )
        .unwrap();
        handle_db(&state, "demo", "rollback", &json!({ "txId": "x" })).unwrap();

        let rows = handle_db(
            &state,
            "demo",
            "query",
            &json!({ "sql": "SELECT v FROM t" }),
        )
        .unwrap();
        assert_eq!(rows, json!([]), "rolled-back insert must not persist");
    }

    #[test]
    fn db_create_table_rejects_identifiers_with_embedded_quotes() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let err = handle_db(
            &state,
            "demo",
            "createTable",
            &json!({ "name": "ev\"il", "schema": { "columns": [{ "name": "a", "type": "text" }] } }),
        )
        .unwrap_err();
        assert_eq!(err.code, "INVALID_REQUEST");
    }

    #[test]
    fn db_unknown_op_is_not_supported() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let err = handle_db(&state, "demo", "vacuum", &json!({})).unwrap_err();
        assert_eq!(err.code, "NOT_SUPPORTED");
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
        assert_eq!(
            required_permission("fs", "readText"),
            Some("filesystem:read")
        );
        assert_eq!(
            required_permission("fs", "writeText"),
            Some("filesystem:write")
        );
        assert_eq!(
            required_permission("fs", "remove"),
            Some("filesystem:write")
        );
        assert_eq!(required_permission("secrets", "get"), Some("secrets:read"));
        assert_eq!(required_permission("secrets", "set"), Some("secrets:write"));
        assert_eq!(
            required_permission("clipboard", "readText"),
            Some("clipboard:read")
        );
        assert_eq!(
            required_permission("clipboard", "clear"),
            Some("clipboard:write")
        );
        assert_eq!(
            required_permission("network", "fetch"),
            Some("network:fetch")
        );
        // window:* and unbacked domains need no permission.
        assert_eq!(required_permission("window", "minimize"), None);
        assert_eq!(required_permission("db", "query"), Some("database:read"));
        assert_eq!(required_permission("db", "execute"), Some("database:write"));
        assert_eq!(
            required_permission("db", "createTable"),
            Some("database:write")
        );
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
        // No phantom permission strings (filesystem:delete, network:download,
        // database:query/execute) outside the PluginPermission union.
        let phantom = [
            "filesystem:delete",
            "network:download",
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
        state.set_network_allowlist("demo", vec!["example.com".into()]);
        let err = handle_network(
            &state,
            "demo",
            "fetch",
            &json!({ "url": "https://evil.test/x" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "PERMISSION_DENIED");
    }

    #[tokio::test]
    async fn handle_network_rejects_malformed_url() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let err = handle_network(&state, "demo", "fetch", &json!({ "url": "not a url" }))
            .await
            .unwrap_err();
        assert_eq!(err.code, "INVALID_REQUEST");
    }

    #[test]
    fn has_permission_reflects_a_written_manifest_grant() {
        use crate::{permissions::read_ledger, PermissionGrant};
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
        state.permissions.write().insert("demo".into(), vec![grant]);
        assert!(state.has_permission("demo", "filesystem:read"));
        assert!(!state.has_permission("demo", "filesystem:write"));
        let _ = read_ledger(&state, "demo");
    }

    #[tokio::test]
    async fn headless_invoke_reuses_the_permission_gate_and_plugin_sandbox() {
        use crate::PermissionGrant;

        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let now = chrono::Utc::now().to_rfc3339();
        state.permissions.write().insert(
            "demo".into(),
            ["filesystem:read", "filesystem:write"]
                .into_iter()
                .map(|permission| PermissionGrant {
                    plugin_id: "demo".into(),
                    permission: permission.into(),
                    granted_by: "test".into(),
                    granted_at: now.clone(),
                    expires_at: None,
                })
                .collect(),
        );

        let write = plugin_api_invoke_for_state(
            &state,
            PluginApiInvokeRequest {
                sdk_version: "2.0.0".into(),
                plugin_id: "demo".into(),
                request_id: "write".into(),
                api: "fs:writeText".into(),
                payload: json!({ "path": "remote/note.txt", "content": "headless" }),
            },
        )
        .await
        .unwrap();
        assert!(write.success);

        let read = plugin_api_invoke_for_state(
            &state,
            PluginApiInvokeRequest {
                sdk_version: "2.0.0".into(),
                plugin_id: "demo".into(),
                request_id: "read".into(),
                api: "fs:readText".into(),
                payload: json!({ "path": "remote/note.txt" }),
            },
        )
        .await
        .unwrap();
        assert!(read.success);
        assert_eq!(read.data, Some(Value::String("headless".into())));
    }

    #[tokio::test]
    async fn headless_invoke_reports_ui_only_apis_as_unavailable() {
        let tmp = TempDir::new().unwrap();
        let state = seeded_state(&tmp);
        let response = plugin_api_invoke_for_state(
            &state,
            PluginApiInvokeRequest {
                sdk_version: "2.0.0".into(),
                plugin_id: "demo".into(),
                request_id: "window".into(),
                api: "window:minimize".into(),
                payload: json!({}),
            },
        )
        .await
        .unwrap();
        assert!(!response.success);
        assert_eq!(response.error.unwrap().code, "NOT_SUPPORTED");
    }

    #[test]
    fn headless_capabilities_hide_only_desktop_ui_backends() {
        let caps = plugin_get_capabilities_for_host(false);
        let supported = |api: &str| caps.iter().find(|cap| cap.api == api).unwrap().supported;
        assert!(supported("fs:readText"));
        assert!(supported("secrets:get"));
        assert!(supported("network:fetch"));
        assert!(supported("db:query"));
        assert!(supported("shell:execute"));
        assert!(!supported("clipboard:readText"));
        assert!(!supported("window:minimize"));
        assert!(!supported("shell:open"));
    }
}
