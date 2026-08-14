//! HTTP handlers for the CLI bridge.
//!
//! All handlers share the same response envelope:
//!
//! ```json
//! { "ok": true,  "pluginId": "..." }
//! { "ok": false, "error": "human readable" }
//! ```
//!
//! The bridge's job is to apply the filesystem + state mutations
//! synchronously, then emit an event so the TS PluginManager refreshes
//! its in-memory view. The renderer reacts to those events the same
//! way it reacts to user-driven install/uninstall from Settings.

use ::anyhow;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri::Manager;

use super::SharedState;
use crate::plugin_api::{PluginRecord, PluginRuntimeSnapshot, PluginRuntimeState};

// ─────────────────────────────────────────────────────────────────────────────
// Wire types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct InstallRequest {
    pub bundle_path: String,
}

#[derive(Debug, Deserialize)]
pub struct InstallDirectoryRequest {
    #[serde(alias = "sourceDir")]
    pub source_dir: String,
}

#[derive(Debug, Deserialize)]
pub struct UninstallRequest {
    pub plugin_id: String,
    #[serde(default)]
    pub purge_data: bool,
}

#[derive(Debug, Deserialize)]
pub struct ReloadRequest {
    #[serde(default)]
    pub bundle_path: Option<String>,
    #[serde(default)]
    pub source_dir: Option<String>,
    #[serde(default)]
    pub plugin_id: Option<String>,
}

/// One transcript turn handed off from the standalone CLI.
#[derive(Debug, Deserialize, Serialize)]
pub struct HandoffMessage {
    pub role: String,
    pub content: String,
}

/// Wire shape for `POST /api/dev/sessions/handoff` — a CLI session
/// transcript the desktop should materialise + open. The handler never
/// touches Dexie itself (that's a renderer concern); it emits the payload
/// on `cli-bridge:session-handoff` and the TS listener imports + opens it.
#[derive(Debug, Deserialize)]
pub struct SessionHandoffRequest {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub messages: Vec<HandoffMessage>,
    /// Opaque run context (provider/model/cwd) forwarded verbatim.
    #[serde(default)]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct OkResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none", rename = "pluginId")]
    plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
struct ErrResponse {
    ok: bool,
    error: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

pub async fn health(State(_state): State<SharedState>) -> Response {
    Json(json!({ "ok": true })).into_response()
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer-backed routes — twin context / agent teams
// ─────────────────────────────────────────────────────────────────────────────

/// Round-trip one renderer-backed command through the WebView and wrap the
/// result in the bridge's `{ ok, result | error }` envelope. Renderer-side
/// handler failures come back as 502 (the desktop is up but the renderer
/// declined / errored); timeouts read the same way.
async fn renderer_roundtrip(
    state: &SharedState,
    command: &str,
    payload: serde_json::Value,
) -> Response {
    match state
        .renderer
        .clone()
        .dispatch(
            &state.app_handle,
            command,
            payload,
            super::renderer_bridge::DEFAULT_TIMEOUT,
        )
        .await
    {
        Ok(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response(),
    }
}

/// `POST /api/dev/twin/context` — build the twin runtime context for a
/// message (renderer runs `tryBuildTwinDeps` → `applyTwinContext`). The
/// renderer handler returns REDACTED prompt segments only — raw chunk
/// content never crosses this boundary.
pub async fn twin_context(
    State(state): State<SharedState>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    renderer_roundtrip(&state, "twin_context_get", payload).await
}

/// `POST /api/dev/teams/list` — project the renderer's AgentTeam store.
pub async fn teams_list(
    State(state): State<SharedState>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    renderer_roundtrip(&state, "agent_team_list", payload).await
}

/// `POST /api/dev/teams/run` — fire-and-forget start of a team run.
pub async fn teams_run(
    State(state): State<SharedState>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    renderer_roundtrip(&state, "agent_team_run", payload).await
}

/// `POST /api/dev/teams/run-status` — newest run row + events since a
/// cursor, projected without step payloads (PII posture).
pub async fn teams_run_status(
    State(state): State<SharedState>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    renderer_roundtrip(&state, "agent_team_run_status", payload).await
}

async fn host_state_roundtrip(
    state: &SharedState,
    command: &str,
    mut payload: serde_json::Value,
) -> Response {
    let Some(map) = payload.as_object_mut() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "HostState request must be an object" })),
        )
            .into_response();
    };
    let account_id = map
        .get("accountId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let Some(account_id) = account_id else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "accountId is required" })),
        )
            .into_response();
    };
    let host_id = state
        .app_handle
        .state::<crate::companion_api::CompanionServerState>()
        .host_id()
        .unwrap_or_else(|| "host-unavailable".to_string());
    map.insert(
        "callerAccountId".to_string(),
        serde_json::Value::String(account_id),
    );
    map.insert(
        "authoritativeHostId".to_string(),
        serde_json::Value::String(host_id),
    );
    renderer_roundtrip(state, command, payload).await
}

pub async fn host_state_snapshot(
    State(state): State<SharedState>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    host_state_roundtrip(&state, "host_state_snapshot", payload).await
}

pub async fn host_state_submit(
    State(state): State<SharedState>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    host_state_roundtrip(&state, "host_state_submit", payload).await
}

pub async fn host_state_status(
    State(state): State<SharedState>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    host_state_roundtrip(&state, "host_state_status", payload).await
}

/// Long poll served from the replay ring first, then from the live broadcast.
///
/// The CLI reopens this immediately after each response, so anything published
/// during that turnaround was already sent before the new receiver existed.
/// Reading the ring — after subscribing, so the two cannot race — is what makes
/// those events recoverable instead of silently skipped. `gap` tells the client
/// the retained window no longer reaches its cursor, so it must re-snapshot
/// rather than resume from a hole.
pub async fn host_state_events(
    State(state): State<SharedState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let after = query
        .get("afterHostSeq")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let log = state.host_state_events.clone();
    // Subscribe BEFORE reading the ring: an event landing between the two is
    // then seen by the receiver, never dropped by both.
    let mut receiver = log.subscribe();
    let mut events = log.replay_after(after);
    let mut lagged = false;

    if events.is_empty() {
        let waited = tokio::time::timeout(std::time::Duration::from_secs(25), async {
            loop {
                match receiver.recv().await {
                    Ok(event) => {
                        if crate::cli_bridge::event_host_seq(&event) > after {
                            break Some(event);
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        lagged = true;
                        break None;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break None,
                }
            }
        })
        .await
        .ok()
        .flatten();
        events.extend(waited);
    }

    // `after == 0` means the caller just snapshotted, so there is nothing older
    // it could be missing.
    let truncated = after > 0
        && log
            .oldest_host_seq()
            .is_some_and(|oldest| oldest > after.saturating_add(1));
    Json(json!({ "ok": true, "events": events, "gap": lagged || truncated })).into_response()
}

/// Cursor-based long poll for canonical Agent RPC v2 envelopes. Attached TUI
/// clients feed these unchanged through `canonicalEnvelopeToActions`.
pub async fn host_state_agent_events(
    State(state): State<SharedState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let after = query
        .get("afterCursor")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let log = state.agent_events.clone();
    let mut receiver = log.subscribe();
    let mut records = log.replay_after(after);
    let mut lagged = false;

    if records.is_empty() {
        let waited = tokio::time::timeout(std::time::Duration::from_secs(25), async {
            loop {
                match receiver.recv().await {
                    Ok(record) if record.cursor > after => break Some(record),
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        lagged = true;
                        break None;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break None,
                }
            }
        })
        .await
        .ok()
        .flatten();
        records.extend(waited);
        // Drain the replay ring again so a burst that followed the wake-up
        // event is returned in the same response instead of stranding records
        // between consecutive long polls.
        let cursor = records.last().map_or(after, |record| record.cursor);
        records.extend(log.replay_after(cursor));
    }

    let truncated = after > 0
        && log
            .oldest_cursor()
            .is_some_and(|oldest| oldest > after.saturating_add(1));
    let cursor = records.last().map_or(after, |record| record.cursor);
    let events = records
        .into_iter()
        .map(|record| record.event)
        .collect::<Vec<_>>();
    Json(json!({
        "ok": true,
        "events": events,
        "cursor": cursor,
        "gap": lagged || truncated,
    }))
    .into_response()
}

/// Wire shape for `GET /api/dev/plugins/installed` — a privacy-safe
/// subset of [`PluginRuntimeSnapshot`]. Only the fields the CLI needs
/// for a preflight install collision check are exposed; runtime_state
/// (which may carry per-plugin secrets) is **never** sent.
#[derive(Debug, Serialize)]
struct InstalledPluginInfo {
    #[serde(rename = "pluginId")]
    plugin_id: String,
    version: String,
    status: String,
    #[serde(rename = "installPath")]
    install_path: String,
}

#[derive(Debug, Serialize)]
struct ListInstalledResponse {
    ok: bool,
    plugins: Vec<InstalledPluginInfo>,
}

/// `GET /api/dev/plugins/installed` — list currently-loaded plugins.
///
/// Used by `cognia plugin install` for the same-id preflight prompt; also
/// surfaced for future scripting use. **Never** returns `runtime_state`
/// because plugins may stash secrets / tokens / per-user IDs there.
pub async fn list_installed(State(state): State<SharedState>) -> Response {
    let plugins = list_installed_inner(&state);
    Json(ListInstalledResponse { ok: true, plugins }).into_response()
}

/// Inner reader — keep private so the wire shape isn't part of any
/// public surface. The axum handler lives in the same module.
fn list_installed_inner(state: &SharedState) -> Vec<InstalledPluginInfo> {
    let plugin_state = state.app_handle.state::<PluginRuntimeState>();
    let guard = plugin_state.plugins.read();
    guard
        .values()
        .map(|record| InstalledPluginInfo {
            plugin_id: record.snapshot.plugin_id.clone(),
            version: record.snapshot.version.clone(),
            status: record.snapshot.status.clone(),
            install_path: record.snapshot.install_path.clone(),
        })
        .collect()
}

pub async fn install(
    State(state): State<SharedState>,
    Json(req): Json<InstallRequest>,
) -> Response {
    match install_inner(&state, &req.bundle_path).await {
        Ok((plugin_id, warnings)) => {
            // Emit so the TS PluginManager picks up the new plugin without
            // a full app restart. The renderer wires this in M3 (TS-side
            // refresh handler not yet on main); for now this is best-effort
            // and the user can manually refresh the Settings pane.
            let _ = state.app_handle.emit(
                "cli-bridge:plugin-installed",
                json!({ "plugin_id": plugin_id }),
            );
            Json(OkResponse {
                ok: true,
                plugin_id: Some(plugin_id),
                warnings,
            })
            .into_response()
        }
        Err(e) => {
            log::warn!("cli_bridge install failed: {e:#}");
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(ErrResponse {
                    ok: false,
                    error: e.to_string(),
                }),
            )
                .into_response()
        }
    }
}

pub async fn install_directory(
    State(state): State<SharedState>,
    Json(req): Json<InstallDirectoryRequest>,
) -> Response {
    match install_from_directory_inner(&state.app_handle, &req.source_dir).await {
        Ok((plugin_id, warnings)) => {
            let _ = state.app_handle.emit(
                "cli-bridge:plugin-installed",
                json!({ "plugin_id": plugin_id, "source": "install-directory" }),
            );
            Json(OkResponse {
                ok: true,
                plugin_id: Some(plugin_id),
                warnings,
            })
            .into_response()
        }
        Err(e) => {
            log::warn!("cli_bridge install-directory failed: {e:#}");
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(ErrResponse {
                    ok: false,
                    error: e.to_string(),
                }),
            )
                .into_response()
        }
    }
}

pub async fn uninstall(
    State(state): State<SharedState>,
    Json(req): Json<UninstallRequest>,
) -> Response {
    match uninstall_inner(&state, &req.plugin_id, req.purge_data).await {
        Ok(()) => {
            let _ = state.app_handle.emit(
                "cli-bridge:plugin-uninstalled",
                json!({ "plugin_id": req.plugin_id, "purge_data": req.purge_data }),
            );
            Json(OkResponse {
                ok: true,
                plugin_id: Some(req.plugin_id.clone()),
                warnings: vec![],
            })
            .into_response()
        }
        Err(e) => {
            log::warn!("cli_bridge uninstall failed: {e:#}");
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(ErrResponse {
                    ok: false,
                    error: e.to_string(),
                }),
            )
                .into_response()
        }
    }
}

pub async fn reload(State(state): State<SharedState>, Json(req): Json<ReloadRequest>) -> Response {
    // If a bundle is provided, treat reload as "re-install in place".
    // If an unpacked source directory is provided, use the same install-directory
    // path first, then fire the hot-reload event for the installed plugin id.
    // Otherwise, just fire the host's existing hot-reload event so the
    // TS PluginManager unloads + reloads the existing on-disk artifact.
    if req.bundle_path.is_some() && req.source_dir.is_some() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrResponse {
                ok: false,
                error: "reload accepts only one of bundle_path or source_dir".into(),
            }),
        )
            .into_response();
    }
    if let Some(source_dir) = req.source_dir.as_deref() {
        match install_from_directory_inner(&state.app_handle, source_dir).await {
            Ok((plugin_id, warnings)) => {
                let _ = state.app_handle.emit(
                    &format!("plugin-hot-reload:{plugin_id}"),
                    json!({ "source": "cli-bridge" }),
                );
                let _ = state.app_handle.emit(
                    "plugin-hot-reload",
                    json!({ "plugin_id": plugin_id, "source": "cli-bridge", "via": "install-directory" }),
                );
                return Json(OkResponse {
                    ok: true,
                    plugin_id: Some(plugin_id),
                    warnings,
                })
                .into_response();
            }
            Err(e) => {
                log::warn!("cli_bridge reload-via-install-directory failed: {e:#}");
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(ErrResponse {
                        ok: false,
                        error: e.to_string(),
                    }),
                )
                    .into_response();
            }
        }
    }
    if let Some(bundle_path) = req.bundle_path.as_deref() {
        match install_inner(&state, bundle_path).await {
            Ok((plugin_id, _)) => {
                // Per-plugin channel for callers that already know the id
                // (used by hot-reload contracts shipped before the global
                // channel existed), plus a single global channel the
                // renderer's `use-cli-bridge-events` hook subscribes to
                // once and dispatches into the hot-reload history store.
                let _ = state.app_handle.emit(
                    &format!("plugin-hot-reload:{plugin_id}"),
                    json!({ "source": "cli-bridge" }),
                );
                let _ = state.app_handle.emit(
                    "plugin-hot-reload",
                    json!({ "plugin_id": plugin_id, "source": "cli-bridge", "via": "install" }),
                );
                return Json(OkResponse {
                    ok: true,
                    plugin_id: Some(plugin_id),
                    warnings: vec![],
                })
                .into_response();
            }
            Err(e) => {
                log::warn!("cli_bridge reload-via-install failed: {e:#}");
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(ErrResponse {
                        ok: false,
                        error: e.to_string(),
                    }),
                )
                    .into_response();
            }
        }
    }
    let plugin_id = match req.plugin_id.as_deref() {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrResponse {
                    ok: false,
                    error: "reload requires bundle_path, source_dir, or plugin_id".into(),
                }),
            )
                .into_response();
        }
    };
    let _ = state.app_handle.emit(
        &format!("plugin-hot-reload:{plugin_id}"),
        json!({ "source": "cli-bridge" }),
    );
    let _ = state.app_handle.emit(
        "plugin-hot-reload",
        json!({ "plugin_id": plugin_id, "source": "cli-bridge", "via": "reload" }),
    );
    Json(OkResponse {
        ok: true,
        plugin_id: Some(plugin_id),
        warnings: vec![],
    })
    .into_response()
}

/// Build the `cli-bridge:session-handoff` event payload. Pure so the wire
/// shape is unit-testable without a running Tauri app.
fn build_handoff_event(req: &SessionHandoffRequest) -> serde_json::Value {
    json!({
        "sessionId": req.session_id,
        "title": req.title,
        "messages": req.messages,
        "meta": req.meta,
    })
}

/// `POST /api/dev/sessions/handoff` — receive a CLI session transcript and
/// emit it for the renderer to import + open. Synchronous + best-effort: the
/// renderer owns the Dexie write (`importHandoffSession`) and navigation.
pub async fn handoff(
    State(state): State<SharedState>,
    Json(req): Json<SessionHandoffRequest>,
) -> Response {
    if req.session_id.trim().is_empty() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrResponse {
                ok: false,
                error: "sessionId is required".into(),
            }),
        )
            .into_response();
    }
    let event = build_handoff_event(&req);
    let _ = state.app_handle.emit("cli-bridge:session-handoff", &event);
    Json(json!({ "ok": true, "sessionId": req.session_id })).into_response()
}

// ─────────────────────────────────────────────────────────────────────────────
// Inner logic — testable without an axum request frame
// ─────────────────────────────────────────────────────────────────────────────

pub async fn install_inner(
    state: &SharedState,
    bundle_path: &str,
) -> anyhow::Result<(String, Vec<String>)> {
    let bundle = PathBuf::from(bundle_path);
    if !bundle.is_absolute() {
        anyhow::bail!("bundle_path must be absolute");
    }
    if !bundle.exists() {
        anyhow::bail!("bundle not found at {}", bundle.display());
    }
    let bytes = std::fs::read(&bundle)?;

    let plugin_state = state.app_handle.state::<PluginRuntimeState>();
    let (manifest, plugin_id) = read_manifest_from_zip(&bytes)?;
    let target_dir = plugin_state.plugin_dir(&plugin_id);
    replace_directory_atomically(&target_dir, |staging| extract_zip_into(&bytes, staging))?;

    register_installed_plugin(&plugin_state, &plugin_id, &manifest, &target_dir);
    log::info!("cli_bridge installed {plugin_id} from {}", bundle.display());
    Ok((plugin_id, vec![]))
}

/// Copy a directory tree (containing a `plugin.json`) into the host's plugin
/// directory and register it the same way the zip-based install does. Used by
/// the new `plugin_install_from_directory` Tauri command for "Load unpacked"
/// in the renderer.
///
/// Behaves identically to `install_inner` post-extraction: idempotent
/// replacement of any prior install of the same id, snapshot insertion into
/// `PluginRuntimeState`, log line keyed by source path.
pub async fn install_from_directory_inner<P: tauri::Runtime>(
    app_handle: &tauri::AppHandle<P>,
    source_dir: &str,
) -> anyhow::Result<(String, Vec<String>)> {
    let source = PathBuf::from(source_dir);
    if !source.is_absolute() {
        anyhow::bail!("source_dir must be absolute");
    }
    if !source.exists() {
        anyhow::bail!("source directory not found at {}", source.display());
    }
    if !source.is_dir() {
        anyhow::bail!("source path is not a directory: {}", source.display());
    }
    let manifest_path = source.join("plugin.json");
    if !manifest_path.exists() {
        anyhow::bail!(
            "plugin.json not found in {} — pass the directory that contains the manifest",
            source.display()
        );
    }
    let manifest_bytes = std::fs::read(&manifest_path)?;
    let (manifest, plugin_id) = read_manifest_from_bytes(&manifest_bytes)?;

    let plugin_state = app_handle.state::<PluginRuntimeState>();
    let target_dir = plugin_state.plugin_dir(&plugin_id);
    replace_directory_atomically(&target_dir, |staging| {
        copy_dir_recursive(&source, staging)?;
        Ok(())
    })?;

    register_installed_plugin(&plugin_state, &plugin_id, &manifest, &target_dir);
    log::info!(
        "cli_bridge installed {plugin_id} from directory {}",
        source.display()
    );
    Ok((plugin_id, vec![]))
}

/// Populate a sibling staging directory, then replace the live install with
/// same-filesystem renames. A failed extraction/copy never mutates the prior
/// installation, and a failed final rename restores it before returning.
fn replace_directory_atomically(
    target: &Path,
    populate: impl FnOnce(&Path) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| anyhow::anyhow!("plugin install target has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".cognia-plugin-staging-")
        .tempdir_in(parent)?;
    populate(staging.path())?;
    let staging_path = staging.keep();
    let backup = parent.join(format!(".cognia-plugin-backup-{}", uuid::Uuid::now_v7()));
    let had_existing = target.exists();
    if had_existing {
        std::fs::rename(target, &backup)?;
    }
    if let Err(error) = std::fs::rename(&staging_path, target) {
        if had_existing {
            let _ = std::fs::rename(&backup, target);
        }
        let _ = std::fs::remove_dir_all(&staging_path);
        return Err(error.into());
    }
    if had_existing {
        std::fs::remove_dir_all(backup)?;
    }
    Ok(())
}

/// Shared between the zip and directory install paths. Builds the runtime
/// snapshot and inserts the plugin row, so the two surfaces can never drift
/// on what counts as an "installed" record.
fn register_installed_plugin(
    plugin_state: &PluginRuntimeState,
    plugin_id: &str,
    manifest: &serde_json::Value,
    target_dir: &Path,
) {
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let snapshot = PluginRuntimeSnapshot {
        plugin_id: plugin_id.to_string(),
        version,
        status: "installed".into(),
        last_error: None,
        loaded_at: Some(Utc::now().to_rfc3339()),
        install_path: target_dir.to_string_lossy().into_owned(),
    };
    plugin_state.plugins.write().insert(
        plugin_id.to_string(),
        PluginRecord {
            snapshot,
            runtime_state: serde_json::Value::Null,
        },
    );
}

pub async fn uninstall_inner(
    state: &SharedState,
    plugin_id: &str,
    purge_data: bool,
) -> anyhow::Result<()> {
    if plugin_id.trim().is_empty() {
        anyhow::bail!("plugin_id is empty");
    }
    let plugin_state = state.app_handle.state::<PluginRuntimeState>();
    let target_dir = plugin_state.plugin_dir(plugin_id);
    if target_dir.exists() {
        std::fs::remove_dir_all(&target_dir)?;
    }
    plugin_state.plugins.write().remove(plugin_id);
    plugin_state.permissions.write().remove(plugin_id);
    // `purge_data` currently maps onto the same filesystem removal; the
    // Dexie-side wipe happens in the TS layer once the
    // `cli-bridge:plugin-uninstalled` event lands. Surfaced via the
    // event payload so the renderer can branch.
    log::info!("cli_bridge uninstalled {plugin_id} (purge_data={purge_data})");
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Read `plugin.json` from the bundle and return (manifest, plugin_id).
fn read_manifest_from_zip(bytes: &[u8]) -> anyhow::Result<(serde_json::Value, String)> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)?;
    let mut entry = archive
        .by_name("plugin.json")
        .map_err(|e| anyhow::anyhow!("plugin.json not found in bundle: {e}"))?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf)?;
    read_manifest_from_bytes(buf.as_bytes())
}

/// Parse a raw `plugin.json` byte buffer into (manifest, plugin_id). Shared
/// by the zip-based install (after the entry is extracted) and the
/// directory-based install (which reads `plugin.json` straight off disk).
fn read_manifest_from_bytes(bytes: &[u8]) -> anyhow::Result<(serde_json::Value, String)> {
    let parsed: serde_json::Value = serde_json::from_slice(bytes)?;
    let id = parsed
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("plugin.json missing `id`"))?
        .to_string();
    if id.trim().is_empty() {
        anyhow::bail!("plugin.json `id` is empty");
    }
    Ok((parsed, id))
}

/// Recursively copy `src` into `dst`. Skips entries whose canonical path
/// would escape `src` (defensive — `walkdir` follows symlinks otherwise).
/// Used by `install_from_directory_inner` so the rendered "Load unpacked"
/// flow stays faithful to the manifest the author shipped.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let entry_path = entry.path();
        let file_name = entry.file_name();
        let target = dst.join(&file_name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_recursive(&entry_path, &target)?;
        } else if file_type.is_file() {
            std::fs::copy(&entry_path, &target)?;
        }
        // Symlinks deliberately skipped — we don't want a "Load unpacked"
        // affordance to walk out of the source tree via a stale link.
    }
    Ok(())
}

/// Extract all regular entries of `bytes` into `target_dir`.
/// Unsafe names and symbolic-link entries reject the whole archive.
fn extract_zip_into(bytes: &[u8], target_dir: &Path) -> anyhow::Result<()> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let entry_path = entry
            .enclosed_name()
            .ok_or_else(|| anyhow::anyhow!("unsafe zip entry path: {}", entry.name()))?
            .to_path_buf();
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            anyhow::bail!(
                "symbolic-link zip entries are not allowed: {}",
                entry.name()
            );
        }
        let dest = target_dir.join(&entry_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&dest)?;
        std::io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// ACP socket-ticket broker
// ─────────────────────────────────────────────────────────────────────────────

/// Synthetic device identity minted for the `cognia acp` stdio bridge. One
/// fixed id (rather than one per connection) keeps the paired-devices view
/// clean and lets the deny list revoke the whole surface in one entry.
const ACP_DEVICE_ID: &str = "acp-cli";

/// Account id stamped into ACP bridge tickets. Purely local (the companion
/// JWT layer only validates the format), but stable so audit lines and
/// `whoami` output are recognizable.
const ACP_ACCOUNT_ID: &str = "local_acct_acp";

/// Build the broker response payload from resolved inputs. Split from the
/// axum handler so the ticket/URL contract is unit-testable without a Tauri
/// app handle.
fn build_acp_ticket_payload(port: u16, ticket: &str, tls_fingerprint: &str) -> serde_json::Value {
    json!({
        "ok": true,
        "wsUrl": format!("wss://127.0.0.1:{port}/ws/acp"),
        "ticket": ticket,
        "tlsFingerprint": tls_fingerprint,
    })
}

/// `POST /api/dev/acp/ticket` — mint a single-use canonical socket ticket for the
/// `cognia acp` stdio↔WS bridge and point it at the companion API's
/// `/ws/acp` endpoint.
///
/// Trust model: identical to plugin install — loopback origin + per-launch
/// dev token (enforced by the router middleware). The durable principal has
/// only the canonical `agent.run` capability and stays hidden from the paired
/// device inventory.
pub async fn acp_ticket(State(state): State<SharedState>) -> Response {
    let Some(server_state) = state
        .app_handle
        .try_state::<crate::companion_api::CompanionServerState>()
    else {
        return err_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "companion server state unavailable",
        );
    };
    let Some(port) = server_state.bound_port() else {
        return err_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "companion API server is not running — start it from Settings → Companion",
        );
    };
    let Some(store) = crate::companion_api::security_store::security_store() else {
        return err_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "companion security store is unavailable",
        );
    };
    let now = Utc::now().timestamp();
    if let Err(error) = store.ensure_service_principal(
        ACP_ACCOUNT_ID,
        ACP_DEVICE_ID,
        "Cognia ACP CLI",
        &["agent.run"],
        now,
    ) {
        return err_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
    }
    let ticket =
        match store.issue_socket_ticket(ACP_ACCOUNT_ID, ACP_DEVICE_ID, "/ws/acp", "acp", now, 60) {
            Ok(ticket) => ticket,
            Err(error) => {
                return err_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
            }
        };
    Json(build_acp_ticket_payload(
        port,
        &ticket,
        &crate::companion_api::tls_fingerprint(),
    ))
    .into_response()
}

fn err_response(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(ErrResponse {
            ok: false,
            error: message.to_string(),
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn acp_ticket_payload_uses_single_use_ticket_shape() {
        let payload = build_acp_ticket_payload(7890, "ticket-a", "AA:BB");
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["wsUrl"], "wss://127.0.0.1:7890/ws/acp");
        assert_eq!(payload["tlsFingerprint"], "AA:BB");
        assert_eq!(payload["ticket"], "ticket-a");
        assert!(payload.get("token").is_none());
    }

    #[test]
    fn acp_ticket_payload_uses_bound_port() {
        let payload = build_acp_ticket_payload(43210, "ticket-a", "");
        assert_eq!(payload["wsUrl"], "wss://127.0.0.1:43210/ws/acp");
    }

    fn make_test_bundle(manifest: &str, files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut w = zip::ZipWriter::new(cursor);
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            w.start_file("plugin.json", opts).unwrap();
            w.write_all(manifest.as_bytes()).unwrap();
            for (name, bytes) in files {
                w.start_file(*name, opts).unwrap();
                w.write_all(bytes).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn read_manifest_from_zip_extracts_id() {
        let bundle = make_test_bundle(
            r#"{"id":"hello","name":"H","version":"0.1.0","type":"frontend"}"#,
            &[("dist/index.js", b"x")],
        );
        let (m, id) = read_manifest_from_zip(&bundle).unwrap();
        assert_eq!(id, "hello");
        assert_eq!(m["name"], serde_json::Value::String("H".into()));
    }

    #[test]
    fn read_manifest_from_zip_errors_when_missing() {
        // bundle with no plugin.json
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut w = zip::ZipWriter::new(cursor);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file::<_, ()>("other.txt", opts).unwrap();
            w.write_all(b"x").unwrap();
            w.finish().unwrap();
        }
        let err = read_manifest_from_zip(&buf).unwrap_err();
        assert!(err.to_string().contains("plugin.json"));
    }

    #[test]
    fn read_manifest_from_zip_errors_when_id_missing() {
        let bundle = make_test_bundle(r#"{"name":"H","version":"0.1.0"}"#, &[]);
        let err = read_manifest_from_zip(&bundle).unwrap_err();
        assert!(err.to_string().contains("missing `id`"));
    }

    #[test]
    fn extract_zip_into_writes_all_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = make_test_bundle(
            r#"{"id":"x","version":"0.1.0"}"#,
            &[("dist/index.js", b"console.log(1)"), ("README.md", b"hi")],
        );
        extract_zip_into(&bundle, tmp.path()).unwrap();
        assert!(tmp.path().join("plugin.json").exists());
        assert!(tmp.path().join("dist/index.js").exists());
        assert!(tmp.path().join("README.md").exists());
        let content = std::fs::read_to_string(tmp.path().join("dist/index.js")).unwrap();
        assert!(content.contains("console.log"));
    }

    #[test]
    fn atomic_directory_replace_preserves_existing_install_on_population_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("demo");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("old.txt"), "old").unwrap();

        let result = replace_directory_atomically(&target, |staging| {
            std::fs::write(staging.join("partial.txt"), "partial")?;
            anyhow::bail!("rejected archive")
        });

        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(target.join("old.txt")).unwrap(),
            "old"
        );
        assert!(!target.join("partial.txt").exists());
    }

    #[test]
    fn read_manifest_from_bytes_round_trips_a_plain_plugin_json() {
        let bytes = br#"{"id":"loose","name":"Loose","version":"0.2.0","type":"frontend"}"#;
        let (m, id) = read_manifest_from_bytes(bytes).unwrap();
        assert_eq!(id, "loose");
        assert_eq!(m["version"], serde_json::Value::String("0.2.0".into()));
    }

    #[test]
    fn read_manifest_from_bytes_rejects_empty_id() {
        let err =
            read_manifest_from_bytes(br#"{"id":"","name":"X","version":"0.1.0"}"#).unwrap_err();
        assert!(err.to_string().contains("empty"));
    }

    #[test]
    fn install_directory_request_deserializes_source_dir() {
        let request: InstallDirectoryRequest =
            serde_json::from_value(json!({"source_dir":"C:/plugins/demo"})).unwrap();
        assert_eq!(request.source_dir, "C:/plugins/demo");
    }

    #[test]
    fn reload_request_deserializes_source_dir() {
        let request: ReloadRequest =
            serde_json::from_value(json!({"source_dir":"C:/plugins/demo"})).unwrap();
        assert_eq!(request.source_dir.as_deref(), Some("C:/plugins/demo"));
        assert!(request.bundle_path.is_none());
        assert!(request.plugin_id.is_none());
    }

    #[test]
    fn copy_dir_recursive_copies_nested_layout() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(src.path().join("nested")).unwrap();
        std::fs::write(
            src.path().join("plugin.json"),
            r#"{"id":"x","version":"0.1.0"}"#,
        )
        .unwrap();
        std::fs::write(src.path().join("nested").join("inner.js"), b"hi").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("plugin.json").exists());
        assert!(dst.path().join("nested").join("inner.js").exists());
        assert_eq!(
            std::fs::read(dst.path().join("nested").join("inner.js")).unwrap(),
            b"hi"
        );
    }

    #[test]
    fn extract_zip_into_rejects_path_traversal_entries() {
        // Build a zip whose entry name is "../../etc/passwd" — enclosed_name
        // returns None for these, so extract_zip_into should silently skip.
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut w = zip::ZipWriter::new(cursor);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file::<_, ()>("../escape.txt", opts).unwrap();
            w.write_all(b"pwned").unwrap();
            w.start_file::<_, ()>("legit.txt", opts).unwrap();
            w.write_all(b"safe").unwrap();
            w.finish().unwrap();
        }
        let tmp = tempfile::tempdir().unwrap();
        let error = extract_zip_into(&buf, tmp.path()).unwrap_err();
        assert!(error.to_string().contains("unsafe zip entry path"));
        // ../escape.txt would have ended up at the parent of tmp.path() —
        // confirm it didn't.
        let parent_escape = tmp.path().parent().unwrap().join("escape.txt");
        assert!(
            !parent_escape.exists(),
            "zip-slip should be blocked but {} exists",
            parent_escape.display()
        );
    }

    #[test]
    fn extract_zip_into_rejects_symlink_entries() {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut writer = zip::ZipWriter::new(cursor);
            writer
                .add_symlink(
                    "link.js",
                    "../../outside.js",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            writer.finish().unwrap();
        }
        let tmp = tempfile::tempdir().unwrap();
        let error = extract_zip_into(&buf, tmp.path()).unwrap_err();
        assert!(error.to_string().contains("symbolic-link"));
        assert!(!tmp.path().join("link.js").exists());
    }

    #[test]
    fn build_handoff_event_shapes_payload() {
        let req = SessionHandoffRequest {
            session_id: "s_cli_1".into(),
            title: Some("Fix the bug".into()),
            messages: vec![
                HandoffMessage {
                    role: "user".into(),
                    content: "fix it".into(),
                },
                HandoffMessage {
                    role: "assistant".into(),
                    content: "done".into(),
                },
            ],
            meta: Some(json!({ "provider": "anthropic", "model": "claude-x" })),
        };
        let ev = build_handoff_event(&req);
        assert_eq!(ev["sessionId"], "s_cli_1");
        assert_eq!(ev["title"], "Fix the bug");
        assert_eq!(ev["messages"][0]["role"], "user");
        assert_eq!(ev["messages"][1]["content"], "done");
        assert_eq!(ev["meta"]["provider"], "anthropic");
    }

    #[test]
    fn build_handoff_event_tolerates_minimal_request() {
        let req = SessionHandoffRequest {
            session_id: "s1".into(),
            title: None,
            messages: vec![],
            meta: None,
        };
        let ev = build_handoff_event(&req);
        assert_eq!(ev["sessionId"], "s1");
        assert!(ev["title"].is_null());
        assert_eq!(ev["messages"].as_array().unwrap().len(), 0);
    }
}
