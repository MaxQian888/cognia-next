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
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
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
    pub plugin_id: Option<String>,
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

pub async fn reload(
    State(state): State<SharedState>,
    Json(req): Json<ReloadRequest>,
) -> Response {
    // If a bundle is provided, treat reload as "re-install in place".
    // Otherwise, just fire the host's existing hot-reload event so the
    // TS PluginManager unloads + reloads the existing on-disk artifact.
    if let Some(bundle_path) = req.bundle_path.as_deref() {
        match install_inner(&state, bundle_path).await {
            Ok((plugin_id, _)) => {
                let _ = state.app_handle.emit(
                    &format!("plugin-hot-reload:{plugin_id}"),
                    json!({ "source": "cli-bridge" }),
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
                    error: "reload requires either bundle_path or plugin_id".into(),
                }),
            )
                .into_response();
        }
    };
    let _ = state.app_handle.emit(
        &format!("plugin-hot-reload:{plugin_id}"),
        json!({ "source": "cli-bridge" }),
    );
    Json(OkResponse {
        ok: true,
        plugin_id: Some(plugin_id),
        warnings: vec![],
    })
    .into_response()
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
    if target_dir.exists() {
        // Replace any prior contents — install is idempotent.
        std::fs::remove_dir_all(&target_dir)?;
    }
    std::fs::create_dir_all(&target_dir)?;
    extract_zip_into(&bytes, &target_dir)?;

    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let snapshot = PluginRuntimeSnapshot {
        plugin_id: plugin_id.clone(),
        version,
        status: "installed".into(),
        last_error: None,
        loaded_at: Some(Utc::now().to_rfc3339()),
        install_path: target_dir.to_string_lossy().into_owned(),
    };
    plugin_state.plugins.write().insert(
        plugin_id.clone(),
        PluginRecord {
            snapshot,
            runtime_state: serde_json::Value::Null,
        },
    );
    log::info!("cli_bridge installed {plugin_id} from {}", bundle.display());
    Ok((plugin_id, vec![]))
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
    log::info!(
        "cli_bridge uninstalled {plugin_id} (purge_data={purge_data})"
    );
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
    let parsed: serde_json::Value = serde_json::from_str(&buf)?;
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

/// Extract all entries of `bytes` into `target_dir`. Skips entries
/// whose names contain `..` or absolute paths (zip-slip defense).
fn extract_zip_into(bytes: &[u8], target_dir: &Path) -> anyhow::Result<()> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let entry_path = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue, // zip-slip / absolute path; skip.
        };
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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
    fn extract_zip_into_skips_path_traversal_entries() {
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
        extract_zip_into(&buf, tmp.path()).unwrap();
        // legit.txt should be there; ../escape.txt should NOT have escaped.
        assert!(tmp.path().join("legit.txt").exists());
        // ../escape.txt would have ended up at the parent of tmp.path() —
        // confirm it didn't.
        let parent_escape = tmp.path().parent().unwrap().join("escape.txt");
        assert!(
            !parent_escape.exists(),
            "zip-slip should be blocked but {} exists",
            parent_escape.display()
        );
    }
}
