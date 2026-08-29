//! HTTP handlers for the CLI bridge.
//!
//! All handlers share the same response envelope:
//!
//! ```json
//! { "ok": true,  "pluginId": "..." }
//! { "ok": false, "error": "human readable" }
//! ```
//!
//! Install/uninstall apply filesystem mutations and emit discovery events.
//! Development reload additionally round-trips through the renderer and only
//! succeeds after a new active lifecycle generation is proven.

use ::anyhow;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
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

#[derive(Debug, Clone, Deserialize)]
pub struct ReloadRequest {
    #[serde(default = "default_schema_version", alias = "schemaVersion")]
    pub schema_version: u32,
    #[serde(default, alias = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default = "default_attempt")]
    pub attempt: u64,
    #[serde(default = "default_activate")]
    pub activate: bool,
    #[serde(default)]
    pub bundle_path: Option<String>,
    #[serde(default)]
    pub source_dir: Option<String>,
    #[serde(default)]
    pub plugin_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PluginDevSessionEventRequest {
    #[serde(default = "default_schema_version", alias = "schemaVersion")]
    pub schema_version: u32,
    #[serde(alias = "sessionId")]
    pub session_id: String,
    pub attempt: u64,
    pub event: String,
    #[serde(default, alias = "projectName")]
    pub project_name: Option<String>,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(alias = "occurredAt")]
    pub occurred_at: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default, alias = "durationMs")]
    pub duration_ms: Option<u64>,
}

const fn default_schema_version() -> u32 {
    1
}

const fn default_attempt() -> u64 {
    1
}

const fn default_activate() -> bool {
    true
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
    let timeout_session_id = req
        .session_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let timeout_attempt = req.attempt;
    let timeout_plugin_id = req.plugin_id.clone().unwrap_or_default();
    match tokio::time::timeout(std::time::Duration::from_secs(30), reload_inner(state, req)).await {
        Ok(response) => response,
        Err(_) => plugin_dev_failure_response(
            &timeout_session_id,
            timeout_attempt,
            &timeout_plugin_id,
            "verify",
            "reload_timeout",
            "plugin reload exceeded the 30 second host deadline".to_string(),
            "Retry the reload and inspect runtime diagnostics",
            true,
        ),
    }
}

async fn reload_inner(state: SharedState, req: ReloadRequest) -> Response {
    if req.schema_version != 1 {
        return err_response(StatusCode::BAD_REQUEST, "unsupported reload schema_version");
    }
    if req.attempt == 0 {
        return err_response(
            StatusCode::BAD_REQUEST,
            "reload attempt must be greater than zero",
        );
    }
    if req.bundle_path.is_some() && req.source_dir.is_some() {
        return err_response(
            StatusCode::BAD_REQUEST,
            "reload accepts only one of bundle_path or source_dir",
        );
    }
    let session_id = match req.session_id.as_deref() {
        Some(value) => match uuid::Uuid::parse_str(value) {
            Ok(value) => value.to_string(),
            Err(_) => return err_response(StatusCode::BAD_REQUEST, "session_id must be a UUID"),
        },
        None => uuid::Uuid::new_v4().to_string(),
    };

    let bundle_path = req.bundle_path.clone();
    let source_dir = req.source_dir.clone();
    let requested_plugin_id = req.plugin_id.clone();
    if bundle_path.is_none()
        && source_dir.is_none()
        && requested_plugin_id
            .as_deref()
            .is_none_or(|plugin_id| plugin_id.trim().is_empty())
    {
        return err_response(
            StatusCode::BAD_REQUEST,
            "reload requires bundle_path, source_dir, or plugin_id",
        );
    }
    let blocking_state = state.clone();
    let install_result = tokio::task::spawn_blocking(move || {
        let (plugin_id, warnings) = if let Some(source_dir) = source_dir.as_deref() {
            install_from_directory_blocking(
                &blocking_state.app_handle,
                source_dir,
                requested_plugin_id.as_deref(),
            )?
        } else if let Some(bundle_path) = bundle_path.as_deref() {
            install_inner_blocking(&blocking_state, bundle_path, requested_plugin_id.as_deref())?
        } else {
            (requested_plugin_id.unwrap_or_default(), Vec::new())
        };
        Ok::<_, anyhow::Error>((plugin_id, warnings))
    })
    .await;
    let (plugin_id, warnings) = match install_result {
        Ok(Ok(value)) => value,
        Err(error) => {
            log::warn!("cli_bridge reload install task failed: {error:#}");
            return plugin_dev_failure_response(
                &session_id,
                req.attempt,
                req.plugin_id.as_deref().unwrap_or(""),
                "install",
                "install_task_failed",
                error.to_string(),
                "Retry the reload and inspect host diagnostics",
                true,
            );
        }
        Ok(Err(error)) => {
            log::warn!("cli_bridge reload install failed: {error:#}");
            if error.downcast_ref::<PluginIdMismatch>().is_some() {
                return err_response(StatusCode::UNPROCESSABLE_ENTITY, &error.to_string());
            }
            return plugin_dev_failure_response(
                &session_id,
                req.attempt,
                req.plugin_id.as_deref().unwrap_or(""),
                "install",
                "install_failed",
                error.to_string(),
                "Fix the plugin bundle or source directory and retry",
                true,
            );
        }
    };
    let metadata_state = state.clone();
    let metadata_plugin_id = plugin_id.clone();
    let metadata_result = tokio::task::spawn_blocking(move || {
        installed_artifact_metadata(&metadata_state, &metadata_plugin_id)
    })
    .await;
    let (package_version, plugin_type, artifact_revision) = match metadata_result {
        Ok(Ok(metadata)) => metadata,
        Ok(Err(error)) => {
            log::warn!("cli_bridge reload metadata failed: {error:#}");
            return plugin_dev_failure_response(
                &session_id,
                req.attempt,
                &plugin_id,
                "discover",
                "installed_artifact_unverified",
                error.to_string(),
                "Rebuild the plugin bundle and retry",
                true,
            );
        }
        Err(error) => {
            log::warn!("cli_bridge reload metadata task failed: {error:#}");
            return plugin_dev_failure_response(
                &session_id,
                req.attempt,
                &plugin_id,
                "discover",
                "metadata_task_failed",
                error.to_string(),
                "Retry the reload and inspect host diagnostics",
                true,
            );
        }
    };
    let payload = json!({
        "schemaVersion": 1,
        "sessionId": session_id,
        "attempt": req.attempt,
        "pluginId": plugin_id,
        "pluginType": plugin_type,
        "packageVersion": package_version,
        "artifactRevision": artifact_revision,
        "activate": req.activate,
    });

    match state
        .renderer
        .clone()
        .dispatch(
            &state.app_handle,
            "plugin_dev_reload",
            payload,
            std::time::Duration::from_secs(25),
        )
        .await
    {
        Ok(mut result) => {
            if let Err(error) = validate_renderer_activation_proof(
                &result,
                &session_id,
                req.attempt,
                &plugin_id,
                &plugin_type,
                &package_version,
                &artifact_revision,
            ) {
                return plugin_dev_failure_response(
                    &session_id,
                    req.attempt,
                    &plugin_id,
                    "verify",
                    "activation_proof_mismatch",
                    error.to_string(),
                    "Retry the reload and inspect renderer diagnostics",
                    true,
                );
            }
            if let Some(object) = result.as_object_mut() {
                let mut merged_warnings = object
                    .get("warnings")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                for warning in warnings {
                    if !merged_warnings.contains(&warning) {
                        merged_warnings.push(warning);
                    }
                }
                object.insert("warnings".to_string(), json!(merged_warnings));
            }
            Json(result).into_response()
        }
        Err(error) => {
            let timed_out = error.contains("timed out");
            Json(json!({
                "schemaVersion": 1,
                "ok": false,
                "outcome": "failed",
                "stage": if timed_out { "verify" } else { "activate" },
                "sessionId": session_id,
                "attempt": req.attempt,
                "pluginId": plugin_id,
                "warnings": warnings,
                "error": {
                    "code": if timed_out { "activation_timeout" } else { "renderer_unavailable" },
                    "message": error,
                    "action": "Keep Cognia open and retry the development reload",
                    "retriable": true,
                }
            }))
            .into_response()
        }
    }
}

fn plugin_dev_failure_response(
    session_id: &str,
    attempt: u64,
    plugin_id: &str,
    stage: &str,
    code: &str,
    message: String,
    action: &str,
    retriable: bool,
) -> Response {
    Json(json!({
        "schemaVersion": 1,
        "ok": false,
        "outcome": "failed",
        "stage": stage,
        "sessionId": session_id,
        "attempt": attempt,
        "pluginId": plugin_id,
        "warnings": [],
        "error": {
            "code": code,
            "message": message,
            "action": action,
            "retriable": retriable,
        }
    }))
    .into_response()
}

fn validate_renderer_activation_proof(
    result: &serde_json::Value,
    session_id: &str,
    attempt: u64,
    plugin_id: &str,
    plugin_type: &str,
    package_version: &str,
    artifact_revision: &str,
) -> anyhow::Result<()> {
    if result.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Ok(());
    }
    let proof = result
        .get("activationProof")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("renderer returned success without activationProof"))?;
    anyhow::ensure!(
        result
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            == Some(1),
        "renderer proof schema version mismatch"
    );
    anyhow::ensure!(
        result.get("outcome").and_then(serde_json::Value::as_str) == Some("activated"),
        "renderer proof outcome mismatch"
    );
    anyhow::ensure!(
        result.get("stage").and_then(serde_json::Value::as_str) == Some("verify"),
        "renderer proof stage mismatch"
    );
    anyhow::ensure!(
        result.get("sessionId").and_then(serde_json::Value::as_str) == Some(session_id),
        "renderer proof session ID mismatch"
    );
    anyhow::ensure!(
        result.get("attempt").and_then(serde_json::Value::as_u64) == Some(attempt),
        "renderer proof attempt mismatch"
    );
    anyhow::ensure!(
        result.get("pluginType").and_then(serde_json::Value::as_str) == Some(plugin_type),
        "renderer proof plugin type mismatch"
    );
    let actual_plugin_id = result
        .get("pluginId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let actual_version = proof
        .get("packageVersion")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let actual_revision = proof
        .get("artifactRevision")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let previous_generation = proof
        .get("previousGeneration")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("renderer proof previous generation is missing"))?;
    let generation = proof
        .get("generation")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("renderer proof generation is missing"))?;
    anyhow::ensure!(
        actual_plugin_id == plugin_id,
        "renderer proof plugin ID mismatch"
    );
    anyhow::ensure!(
        actual_version == package_version,
        "renderer proof package version mismatch"
    );
    anyhow::ensure!(
        actual_revision == artifact_revision,
        "renderer proof artifact revision mismatch"
    );
    anyhow::ensure!(
        proof.get("actualState").and_then(serde_json::Value::as_str) == Some("active"),
        "renderer proof runtime is not active"
    );
    anyhow::ensure!(
        generation > previous_generation,
        "renderer proof generation did not increase"
    );
    anyhow::ensure!(
        proof.get("reloadMode").and_then(serde_json::Value::as_str) == Some("hot"),
        "renderer proof reload mode is not hot"
    );
    Ok(())
}

const PLUGIN_DEV_SESSION_EVENTS: [&str; 8] = [
    "session_started",
    "heartbeat",
    "change_detected",
    "build_started",
    "build_succeeded",
    "build_failed",
    "session_stopping",
    "session_stopped",
];

fn validate_plugin_dev_session_event(req: &PluginDevSessionEventRequest) -> anyhow::Result<()> {
    if req.schema_version != 1 {
        anyhow::bail!("unsupported session event schema_version");
    }
    uuid::Uuid::parse_str(&req.session_id)
        .map_err(|_| anyhow::anyhow!("session_id must be a UUID"))?;
    if !PLUGIN_DEV_SESSION_EVENTS.contains(&req.event.as_str()) {
        anyhow::bail!("unsupported plugin dev session event: {}", req.event);
    }
    if req
        .summary
        .as_ref()
        .is_some_and(|value| value.chars().count() > 1024)
    {
        anyhow::bail!("session event summary exceeds 1024 characters");
    }
    for (name, value) in [
        ("project_name", req.project_name.as_deref()),
        ("stage", req.stage.as_deref()),
    ] {
        if value.is_some_and(|value| value.chars().count() > 128) {
            anyhow::bail!("session event {name} exceeds 128 characters");
        }
    }
    Ok(())
}

pub async fn plugin_dev_session_event(
    State(state): State<SharedState>,
    Json(req): Json<PluginDevSessionEventRequest>,
) -> Response {
    if let Err(error) = validate_plugin_dev_session_event(&req) {
        return err_response(StatusCode::UNPROCESSABLE_ENTITY, &error.to_string());
    }
    let payload = json!({
        "schemaVersion": req.schema_version,
        "sessionId": req.session_id,
        "attempt": req.attempt,
        "event": req.event,
        "projectName": req.project_name,
        "stage": req.stage,
        "occurredAt": req.occurred_at,
        "summary": req.summary,
        "durationMs": req.duration_ms,
    });
    if let Err(error) = state
        .app_handle
        .emit("cli-bridge:plugin-dev-session", payload)
    {
        log::warn!("cli_bridge plugin dev session event emit failed: {error}");
        return Json(json!({ "ok": false, "error": "renderer_event_unavailable" })).into_response();
    }
    Json(json!({ "ok": true })).into_response()
}

fn validate_expected_plugin_id(expected: Option<&str>, installed: &str) -> anyhow::Result<()> {
    if let Some(expected) = expected.filter(|value| !value.trim().is_empty()) {
        if expected != installed {
            return Err(PluginIdMismatch {
                expected: expected.to_string(),
                installed: installed.to_string(),
            }
            .into());
        }
    }
    Ok(())
}

#[derive(Debug)]
struct PluginIdMismatch {
    expected: String,
    installed: String,
}

impl std::fmt::Display for PluginIdMismatch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "reload expected plugin id `{}` but installed artifact declares `{}`",
            self.expected, self.installed
        )
    }
}

impl std::error::Error for PluginIdMismatch {}

fn installed_artifact_metadata(
    state: &SharedState,
    plugin_id: &str,
) -> anyhow::Result<(String, String, String)> {
    let plugin_state = state.app_handle.state::<PluginRuntimeState>();
    let install_dir = plugin_state.plugin_dir(plugin_id);
    let manifest_bytes = std::fs::read(install_dir.join("plugin.json"))?;
    let (manifest, installed_id) = read_manifest_from_bytes(&manifest_bytes)?;
    validate_expected_plugin_id(Some(plugin_id), &installed_id)?;
    let version = manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("installed plugin manifest has no valid version"))?
        .to_string();
    let plugin_type = manifest
        .get("type")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            matches!(
                *value,
                "frontend" | "python" | "hybrid" | "wasm" | "vscode-extension"
            )
        })
        .ok_or_else(|| anyhow::anyhow!("installed plugin manifest has no supported type"))?
        .to_string();
    let revision = installed_tree_revision(&install_dir)?;
    Ok((version, plugin_type, revision))
}

fn installed_tree_revision(root: &Path) -> anyhow::Result<String> {
    fn collect_files(root: &Path, current: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
        for entry in std::fs::read_dir(current)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                collect_files(root, &path, files)?;
            } else if file_type.is_file() {
                files.push(path.strip_prefix(root)?.to_path_buf());
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for relative in files {
        let path_bytes = relative.to_string_lossy();
        let contents = std::fs::read(root.join(&relative))?;
        hasher.update((path_bytes.len() as u64).to_le_bytes());
        hasher.update(path_bytes.as_bytes());
        hasher.update((contents.len() as u64).to_le_bytes());
        hasher.update(contents);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
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
    install_inner_blocking(state, bundle_path, None)
}

fn install_inner_blocking(
    state: &SharedState,
    bundle_path: &str,
    expected_plugin_id: Option<&str>,
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
    validate_expected_plugin_id(expected_plugin_id, &plugin_id)?;
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
    install_from_directory_blocking(app_handle, source_dir, None)
}

fn install_from_directory_blocking<P: tauri::Runtime>(
    app_handle: &tauri::AppHandle<P>,
    source_dir: &str,
    expected_plugin_id: Option<&str>,
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
    validate_expected_plugin_id(expected_plugin_id, &plugin_id)?;

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
        assert_eq!(request.schema_version, 1);
        assert_eq!(request.attempt, 1);
        assert!(request.activate);
    }

    #[test]
    fn reload_request_accepts_trustworthy_dev_session_fields() {
        let request: ReloadRequest = serde_json::from_value(json!({
            "schema_version": 1,
            "session_id": "550e8400-e29b-41d4-a716-446655440000",
            "attempt": 7,
            "activate": true,
            "bundle_path": "/tmp/demo.cpk",
            "plugin_id": "demo.plugin"
        }))
        .unwrap();
        assert_eq!(request.schema_version, 1);
        assert_eq!(
            request.session_id.as_deref(),
            Some("550e8400-e29b-41d4-a716-446655440000")
        );
        assert_eq!(request.attempt, 7);
        assert!(request.activate);
    }

    #[test]
    fn expected_plugin_id_rejects_a_different_installed_artifact() {
        let error =
            validate_expected_plugin_id(Some("expected.plugin"), "actual.plugin").unwrap_err();
        assert!(error.downcast_ref::<PluginIdMismatch>().is_some());
        assert!(error.to_string().contains("expected.plugin"));
        assert!(error.to_string().contains("actual.plugin"));
    }

    #[test]
    fn installed_tree_revision_is_stable_and_changes_with_content() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("dist")).unwrap();
        std::fs::write(tmp.path().join("plugin.json"), br#"{"id":"demo.plugin"}"#).unwrap();
        std::fs::write(tmp.path().join("dist/index.js"), b"one").unwrap();

        let first = installed_tree_revision(tmp.path()).unwrap();
        let second = installed_tree_revision(tmp.path()).unwrap();
        assert_eq!(first, second);
        assert!(first.starts_with("sha256:"));

        std::fs::write(tmp.path().join("dist/index.js"), b"two").unwrap();
        let changed = installed_tree_revision(tmp.path()).unwrap();
        assert_ne!(first, changed);
    }

    #[test]
    fn renderer_activation_proof_must_match_the_installed_artifact() {
        let result = json!({
            "schemaVersion": 1,
            "ok": true,
            "outcome": "activated",
            "stage": "verify",
            "sessionId": "550e8400-e29b-41d4-a716-446655440000",
            "attempt": 7,
            "pluginId": "demo.plugin",
            "pluginType": "frontend",
            "activationProof": {
                "previousGeneration": 3,
                "generation": 4,
                "actualState": "active",
                "packageVersion": "1.0.0",
                "artifactRevision": "sha256:actual",
                "reloadMode": "hot"
            }
        });
        assert!(validate_renderer_activation_proof(
            &result,
            "550e8400-e29b-41d4-a716-446655440000",
            7,
            "demo.plugin",
            "frontend",
            "1.0.0",
            "sha256:actual"
        )
        .is_ok());
        let error = validate_renderer_activation_proof(
            &result,
            "550e8400-e29b-41d4-a716-446655440000",
            7,
            "demo.plugin",
            "frontend",
            "1.0.0",
            "sha256:different",
        )
        .unwrap_err();
        assert!(error.to_string().contains("artifact revision mismatch"));

        let mut stale = result.clone();
        stale["activationProof"]["generation"] = json!(3);
        let error = validate_renderer_activation_proof(
            &stale,
            "550e8400-e29b-41d4-a716-446655440000",
            7,
            "demo.plugin",
            "frontend",
            "1.0.0",
            "sha256:actual",
        )
        .unwrap_err();
        assert!(error.to_string().contains("generation did not increase"));

        let mut inactive = result;
        inactive["activationProof"]["actualState"] = json!("inactive");
        assert!(validate_renderer_activation_proof(
            &inactive,
            "550e8400-e29b-41d4-a716-446655440000",
            7,
            "demo.plugin",
            "frontend",
            "1.0.0",
            "sha256:actual",
        )
        .unwrap_err()
        .to_string()
        .contains("not active"));
    }

    #[test]
    fn dev_session_event_accepts_only_the_public_event_catalog() {
        let valid: PluginDevSessionEventRequest = serde_json::from_value(json!({
            "schema_version": 1,
            "session_id": "550e8400-e29b-41d4-a716-446655440000",
            "attempt": 1,
            "event": "build_started",
            "occurred_at": "2026-08-29T12:00:00Z"
        }))
        .unwrap();
        assert!(validate_plugin_dev_session_event(&valid).is_ok());

        let invalid = PluginDevSessionEventRequest {
            event: "arbitrary_event".into(),
            ..valid
        };
        assert!(validate_plugin_dev_session_event(&invalid).is_err());

        let oversized = PluginDevSessionEventRequest {
            project_name: Some("x".repeat(129)),
            ..serde_json::from_value(json!({
                "schema_version": 1,
                "session_id": "550e8400-e29b-41d4-a716-446655440000",
                "attempt": 1,
                "event": "heartbeat",
                "occurred_at": "2026-08-29T12:00:00Z"
            }))
            .unwrap()
        };
        assert!(validate_plugin_dev_session_event(&oversized).is_err());
    }

    #[test]
    fn operational_reload_failures_use_an_http_200_response() {
        let response = plugin_dev_failure_response(
            "550e8400-e29b-41d4-a716-446655440000",
            1,
            "demo.plugin",
            "activate",
            "activation_failed",
            "loader crashed".to_string(),
            "Inspect diagnostics",
            true,
        );

        assert_eq!(response.status(), StatusCode::OK);
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
