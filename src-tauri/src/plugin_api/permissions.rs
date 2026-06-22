//! Plugin permission ledger Tauri commands (Batch 3a).
//!
//! Persists per-plugin permission grants to
//! `<install_dir>/<plugin_id>/permissions.json`. The TS-side
//! `permission-guard.ts` is the runtime gate; this module is the disk
//! authority that survives a webview reload.

use std::fs;

use chrono::Utc;
use tauri::State;

use super::{PermissionGrant, PluginError, PluginRuntimeState, Result};

fn ledger_path(state: &PluginRuntimeState, plugin_id: &str) -> std::path::PathBuf {
    state.plugin_dir(plugin_id).join("permissions.json")
}

fn write_ledger(
    state: &PluginRuntimeState,
    plugin_id: &str,
    grants: &[PermissionGrant],
) -> Result<()> {
    let dir = state.plugin_dir(plugin_id);
    fs::create_dir_all(&dir)?;
    fs::write(
        ledger_path(state, plugin_id),
        serde_json::to_vec_pretty(grants)?,
    )?;
    Ok(())
}

pub(crate) fn read_ledger(
    state: &PluginRuntimeState,
    plugin_id: &str,
) -> Result<Vec<PermissionGrant>> {
    let path = ledger_path(state, plugin_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[tauri::command]
pub async fn plugin_permission_grant(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    permission: String,
    granted_by: String,
    expires_at: Option<String>,
) -> Result<PermissionGrant> {
    if permission.trim().is_empty() {
        return Err(PluginError::InvalidArgument("permission is empty".into()));
    }
    let grant = PermissionGrant {
        plugin_id: plugin_id.clone(),
        permission: permission.clone(),
        granted_by,
        granted_at: Utc::now().to_rfc3339(),
        expires_at,
    };
    {
        let mut all = state.permissions.write();
        let entry = all.entry(plugin_id.clone()).or_default();
        // De-dupe: if the same permission already exists, replace it.
        entry.retain(|g| g.permission != permission);
        entry.push(grant.clone());
        write_ledger(&state, &plugin_id, entry)?;
    }
    Ok(grant)
}

#[tauri::command]
pub async fn plugin_permission_list(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<Vec<PermissionGrant>> {
    if let Some(grants) = state.permissions.read().get(&plugin_id) {
        return Ok(grants.clone());
    }
    // Fall back to disk on cold-start.
    let from_disk = read_ledger(&state, &plugin_id)?;
    if !from_disk.is_empty() {
        state
            .permissions
            .write()
            .insert(plugin_id, from_disk.clone());
    }
    Ok(from_disk)
}

#[tauri::command]
pub async fn plugin_permission_revoke(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    permission: String,
) -> Result<()> {
    let mut all = state.permissions.write();
    if let Some(entry) = all.get_mut(&plugin_id) {
        entry.retain(|g| g.permission != permission);
        write_ledger(&state, &plugin_id, entry)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_api::PluginRuntimeState;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn make_state(tmp: &TempDir) -> PluginRuntimeState {
        PluginRuntimeState::new(PathBuf::from(tmp.path()))
    }

    #[tokio::test]
    async fn grant_persists_and_lists() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // Direct ledger I/O — the Tauri command thinly wraps this logic.
        let grant = PermissionGrant {
            plugin_id: "demo".into(),
            permission: "filesystem:read".into(),
            granted_by: "user".into(),
            granted_at: Utc::now().to_rfc3339(),
            expires_at: None,
        };
        write_ledger(&state, "demo", &[grant.clone()]).unwrap();
        let from_disk = read_ledger(&state, "demo").unwrap();
        assert_eq!(from_disk.len(), 1);
        assert_eq!(from_disk[0].permission, "filesystem:read");
    }

    #[tokio::test]
    async fn revoke_removes_entry() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let grant = PermissionGrant {
            plugin_id: "demo".into(),
            permission: "filesystem:read".into(),
            granted_by: "user".into(),
            granted_at: Utc::now().to_rfc3339(),
            expires_at: None,
        };
        write_ledger(&state, "demo", &[grant]).unwrap();
        let mut grants = read_ledger(&state, "demo").unwrap();
        grants.retain(|g| g.permission != "filesystem:read");
        write_ledger(&state, "demo", &grants).unwrap();
        assert!(read_ledger(&state, "demo").unwrap().is_empty());
    }
}
