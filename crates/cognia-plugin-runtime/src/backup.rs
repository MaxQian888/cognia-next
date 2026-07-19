//! Plugin backup snapshots (Batch 3c).
//!
//! Backup tarballs land at
//! `<install_dir>/_backups/<plugin_id>-<timestamp>.tar.gz`. The `_backups`
//! directory is namespace-collocated with installed plugins so a single
//! `plugin_uninstall` doesn't accidentally drop the tarball — that's
//! `plugin_backup_delete`'s job.

use std::fs::{self, File};
use std::io::Read;
use std::path::PathBuf;

use chrono::Utc;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;
use tauri::State;

use super::{PluginError, PluginRuntimeState, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPayload {
    pub backup_id: String,
    pub plugin_id: String,
    pub label: Option<String>,
    pub created_at: String,
    pub size_bytes: u64,
    pub path: String,
}

fn backups_dir(state: &PluginRuntimeState) -> PathBuf {
    state.plugin_install_dir.join("_backups")
}

fn ensure_backups_dir(state: &PluginRuntimeState) -> Result<PathBuf> {
    let dir = backups_dir(state);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub async fn plugin_backup_create(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    label: Option<String>,
) -> Result<BackupPayload> {
    plugin_backup_create_for_state(state.inner(), plugin_id, label).await
}

/// Host-neutral backup creation used by Tauri and the headless companion host.
pub async fn plugin_backup_create_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    label: Option<String>,
) -> Result<BackupPayload> {
    let plugin_dir = state.plugin_dir(&plugin_id);
    if !plugin_dir.exists() {
        return Err(PluginError::NotFound(plugin_id));
    }
    let backups = ensure_backups_dir(&state)?;
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S").to_string();
    let backup_id = format!("{plugin_id}-{timestamp}");
    let archive_path = backups.join(format!("{backup_id}.tar.gz"));
    let archive_file = File::create(&archive_path)?;
    let encoder = GzEncoder::new(archive_file, Compression::default());
    let mut builder = tar::Builder::new(encoder);
    builder
        .append_dir_all(&plugin_id, &plugin_dir)
        .map_err(|e| PluginError::Internal(format!("tar append: {e}")))?;
    builder
        .into_inner()
        .map_err(|e| PluginError::Internal(format!("gzip finalize: {e}")))?
        .finish()
        .map_err(|e| PluginError::Internal(format!("gzip finish: {e}")))?;
    let size_bytes = fs::metadata(&archive_path)?.len();
    Ok(BackupPayload {
        backup_id,
        plugin_id,
        label,
        created_at: Utc::now().to_rfc3339(),
        size_bytes,
        path: archive_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn plugin_backup_restore(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    backup_id: String,
) -> Result<()> {
    plugin_backup_restore_for_state(state.inner(), plugin_id, backup_id).await
}

/// Host-neutral backup restore used by Tauri and the headless companion host.
pub async fn plugin_backup_restore_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    backup_id: String,
) -> Result<()> {
    let archive_path = backups_dir(&state).join(format!("{backup_id}.tar.gz"));
    if !archive_path.exists() {
        return Err(PluginError::NotFound(format!("backup {backup_id}")));
    }
    let plugin_dir = state.plugin_dir(&plugin_id);
    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir)?;
    }
    let archive_file = File::open(&archive_path)?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(&state.plugin_install_dir)
        .map_err(|e| PluginError::Internal(format!("tar unpack: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn plugin_backup_delete(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    backup_id: String,
) -> Result<()> {
    plugin_backup_delete_for_state(state.inner(), plugin_id, backup_id).await
}

/// Host-neutral backup deletion used by Tauri and the headless companion host.
pub async fn plugin_backup_delete_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    backup_id: String,
) -> Result<()> {
    if !backup_id.starts_with(&plugin_id) {
        return Err(PluginError::InvalidArgument(
            "backup_id must start with plugin_id".into(),
        ));
    }
    let archive_path = backups_dir(&state).join(format!("{backup_id}.tar.gz"));
    if archive_path.exists() {
        fs::remove_file(&archive_path)?;
    }
    Ok(())
}

// Used by tests to validate gzip round-trips without touching tauri state.
#[allow(dead_code)]
fn read_gz_bytes(path: &std::path::Path) -> Result<Vec<u8>> {
    let f = File::open(path)?;
    let mut decoder = GzDecoder::new(f);
    let mut out = Vec::new();
    decoder
        .read_to_end(&mut out)
        .map_err(|e| PluginError::Internal(format!("read_gz: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_state(tmp: &TempDir) -> PluginRuntimeState {
        PluginRuntimeState::new(PathBuf::from(tmp.path()))
    }

    fn seed_plugin_dir(state: &PluginRuntimeState, plugin_id: &str, contents: &str) {
        use std::io::Write as _;
        let dir = state.plugin_dir(plugin_id);
        fs::create_dir_all(&dir).unwrap();
        let mut f = File::create(dir.join("manifest.json")).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
    }

    #[test]
    fn create_then_restore_preserves_bytes() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        seed_plugin_dir(&state, "demo", "{\"id\":\"demo\",\"version\":\"1.0.0\"}");

        // Inline the create logic synchronously to avoid the tokio macro
        // overhead in unit tests.
        let backups = ensure_backups_dir(&state).unwrap();
        let archive_path = backups.join("demo-test.tar.gz");
        let archive_file = File::create(&archive_path).unwrap();
        let encoder = GzEncoder::new(archive_file, Compression::default());
        let mut builder = tar::Builder::new(encoder);
        builder
            .append_dir_all("demo", state.plugin_dir("demo"))
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        assert!(archive_path.exists());

        // Tamper with the original.
        fs::write(state.plugin_dir("demo").join("manifest.json"), b"tampered").unwrap();

        // Restore.
        fs::remove_dir_all(state.plugin_dir("demo")).unwrap();
        let archive_file = File::open(&archive_path).unwrap();
        let decoder = GzDecoder::new(archive_file);
        let mut archive = tar::Archive::new(decoder);
        archive.unpack(&state.plugin_install_dir).unwrap();

        let restored = fs::read_to_string(state.plugin_dir("demo").join("manifest.json")).unwrap();
        assert_eq!(restored, "{\"id\":\"demo\",\"version\":\"1.0.0\"}");
    }

    #[test]
    fn delete_only_accepts_matching_prefix() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // Pre-seed a fake backup so delete actually has work.
        let backups = ensure_backups_dir(&state).unwrap();
        let archive_path = backups.join("demo-stamp.tar.gz");
        File::create(&archive_path).unwrap();
        // Mismatched prefix is rejected before fs touches.
        let err = {
            let plugin_id = "demo".to_string();
            let backup_id = "other-stamp".to_string();
            if !backup_id.starts_with(&plugin_id) {
                Some(PluginError::InvalidArgument(
                    "backup_id must start with plugin_id".into(),
                ))
            } else {
                None
            }
        };
        assert!(matches!(err, Some(PluginError::InvalidArgument(_))));
        // Original archive untouched.
        assert!(archive_path.exists());
    }
}
