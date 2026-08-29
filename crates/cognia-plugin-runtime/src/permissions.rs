//! Plugin permission ledger Tauri commands (Batch 3a).
//!
//! Persists per-plugin permission grants to the host-owned
//! `<install_dir>/.host-state/<plugin_id>/permissions.json`. The TS-side
//! `permission-guard.ts` is the runtime gate; this module is the disk
//! authority that survives a webview reload.

use std::fs;
use std::io::Write;

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use chrono::Utc;
use tauri::State;

use super::{PermissionGrant, PluginError, PluginRuntimeState, Result};

const HOST_STATE_DIR: &str = ".host-state";
const ACCOUNT_STATE_DIR: &str = "accounts";
const LEDGER_FILE: &str = "permissions.json";

fn open_ledger_dir(
    state: &PluginRuntimeState,
    plugin_id: &str,
    create: bool,
) -> Result<Option<Dir>> {
    let plugin_id = crate::validate_plugin_id_path_component(plugin_id)?;
    let account_id = state.active_account_id()?;
    fs::create_dir_all(&state.plugin_install_dir)?;
    let install = Dir::open_ambient_dir(&state.plugin_install_dir, ambient_authority())?;
    if create {
        match install.create_dir(HOST_STATE_DIR) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let host_state = match install.open_dir_nofollow(HOST_STATE_DIR) {
        Ok(dir) => dir,
        Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if create {
        match host_state.create_dir(ACCOUNT_STATE_DIR) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let accounts = match host_state.open_dir_nofollow(ACCOUNT_STATE_DIR) {
        Ok(dir) => dir,
        Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if create {
        match accounts.create_dir(&account_id) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let account = match accounts.open_dir_nofollow(&account_id) {
        Ok(dir) => dir,
        Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if create {
        match account.create_dir(&plugin_id) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    match account.open_dir_nofollow(&plugin_id) {
        Ok(dir) => Ok(Some(dir)),
        Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_ledger(
    state: &PluginRuntimeState,
    plugin_id: &str,
    grants: &[PermissionGrant],
) -> Result<()> {
    let dir = open_ledger_dir(state, plugin_id, true)?.ok_or_else(|| {
        PluginError::Internal("failed to create plugin permission ledger directory".into())
    })?;
    let temporary = format!(".permissions-{}.tmp", uuid::Uuid::new_v4());
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut file = dir.open_with(&temporary, &options)?;
    let result = (|| -> Result<()> {
        file.write_all(&serde_json::to_vec_pretty(grants)?)?;
        file.sync_all()?;
        dir.rename(&temporary, &dir, LEDGER_FILE)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = dir.remove_file(&temporary);
    }
    result
}

pub(crate) fn read_ledger(
    state: &PluginRuntimeState,
    plugin_id: &str,
) -> Result<Vec<PermissionGrant>> {
    let Some(dir) = open_ledger_dir(state, plugin_id, false)? else {
        return Ok(Vec::new());
    };
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = match dir.open_with(LEDGER_FILE, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if !file.metadata()?.is_file() {
        return Err(PluginError::InvalidArgument(
            "plugin permission ledger must be a regular file".into(),
        ));
    }
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut bytes)?;
    let grants: Vec<PermissionGrant> = serde_json::from_slice(&bytes)?;
    for grant in &grants {
        if grant.plugin_id != plugin_id {
            return Err(PluginError::InvalidArgument(
                "plugin permission ledger contains a mismatched plugin id".into(),
            ));
        }
        crate::contract::validate_permission_name(&grant.permission)
            .map_err(PluginError::InvalidArgument)?;
    }
    Ok(grants)
}

pub fn grant_permission_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    permission: String,
    granted_by: String,
    expires_at: Option<String>,
) -> Result<PermissionGrant> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
    crate::contract::validate_permission_name(&permission).map_err(PluginError::InvalidArgument)?;
    let grant = PermissionGrant {
        plugin_id: plugin_id.clone(),
        permission: permission.clone(),
        granted_by,
        granted_at: Utc::now().to_rfc3339(),
        expires_at,
    };
    let mut all = state.permissions.write();
    let mut next = match all.get(&plugin_id) {
        Some(grants) => grants.clone(),
        None => read_ledger(state, &plugin_id)?,
    };
    next.retain(|existing| existing.permission != permission);
    next.push(grant.clone());
    write_ledger(state, &plugin_id, &next)?;
    all.insert(plugin_id, next);
    Ok(grant)
}

pub fn revoke_permission_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    permission: String,
) -> Result<()> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
    crate::contract::validate_permission_name(&permission).map_err(PluginError::InvalidArgument)?;
    let mut all = state.permissions.write();
    let mut next = match all.get(&plugin_id) {
        Some(grants) => grants.clone(),
        None => read_ledger(state, &plugin_id)?,
    };
    next.retain(|grant| grant.permission != permission);
    write_ledger(state, &plugin_id, &next)?;
    all.insert(plugin_id, next);
    Ok(())
}

#[tauri::command]
pub async fn plugin_permission_grant(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    permission: String,
    granted_by: String,
    expires_at: Option<String>,
) -> Result<PermissionGrant> {
    grant_permission_for_state(&state, plugin_id, permission, granted_by, expires_at)
}

#[tauri::command]
pub async fn plugin_permission_list(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<Vec<PermissionGrant>> {
    list_permissions_for_state(&state, plugin_id)
}

/// Host-neutral permission-ledger read shared by Tauri and `cognia-server`.
pub fn list_permissions_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
) -> Result<Vec<PermissionGrant>> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
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
    revoke_permission_for_state(&state, plugin_id, permission)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PluginRuntimeState;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn make_state(tmp: &TempDir) -> PluginRuntimeState {
        let state = PluginRuntimeState::new(PathBuf::from(tmp.path()));
        state.activate_account("acct_test").unwrap();
        state
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

    #[test]
    fn cold_start_revoke_loads_and_removes_the_persisted_grant() {
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
        assert!(state.permissions.read().is_empty());

        revoke_permission_for_state(&state, "demo".into(), "filesystem:read".into()).unwrap();

        assert!(read_ledger(&state, "demo").unwrap().is_empty());
        assert!(state
            .permissions
            .read()
            .get("demo")
            .is_some_and(Vec::is_empty));
    }

    #[cfg(unix)]
    #[test]
    fn failed_persistence_never_commits_a_grant_to_memory() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let attacker = tmp.path().join("attacker");
        fs::create_dir_all(&attacker).unwrap();
        symlink(&attacker, &state.plugin_state_dir).unwrap();

        let result = grant_permission_for_state(
            &state,
            "demo".into(),
            "filesystem:write".into(),
            "user".into(),
            None,
        );

        assert!(result.is_err());
        assert!(!state.has_permission("demo", "filesystem:write"));
        assert!(!attacker
            .join("accounts/acct_test/demo/permissions.json")
            .exists());
    }

    #[test]
    fn ledger_apis_reject_reserved_plugin_ids() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        assert!(read_ledger(&state, ".host-state").is_err());
        assert!(revoke_permission_for_state(
            &state,
            "_marketplace_cache".into(),
            "filesystem:read".into()
        )
        .is_err());
    }

    #[test]
    fn ledger_rejects_unknown_permissions_and_mismatched_plugin_ids() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let mut grant = PermissionGrant {
            plugin_id: "demo".into(),
            permission: "unknown:permission".into(),
            granted_by: "attacker".into(),
            granted_at: Utc::now().to_rfc3339(),
            expires_at: None,
        };
        write_ledger(&state, "demo", &[grant.clone()]).unwrap();
        assert!(read_ledger(&state, "demo").is_err());

        grant.permission = "filesystem:read".into();
        grant.plugin_id = "someone-else".into();
        write_ledger(&state, "demo", &[grant]).unwrap();
        assert!(read_ledger(&state, "demo").is_err());

        assert!(grant_permission_for_state(
            &state,
            "demo".into(),
            "unknown:permission".into(),
            "attacker".into(),
            None,
        )
        .is_err());
        assert!(state.permissions.read().is_empty());
    }

    #[test]
    fn permission_ledgers_are_isolated_by_active_local_profile() {
        let tmp = TempDir::new().unwrap();
        let state = PluginRuntimeState::new(PathBuf::from(tmp.path()));
        state.activate_account("acct_a").unwrap();
        grant_permission_for_state(
            &state,
            "demo".into(),
            "filesystem:read".into(),
            "user".into(),
            None,
        )
        .unwrap();
        assert!(state.has_permission("demo", "filesystem:read"));

        state.activate_account("acct_b").unwrap();
        assert!(!state.has_permission("demo", "filesystem:read"));
        assert!(list_permissions_for_state(&state, "demo".into())
            .unwrap()
            .is_empty());

        state.activate_account("acct_a").unwrap();
        assert!(state.has_permission("demo", "filesystem:read"));
    }

    #[test]
    fn permission_checks_fail_closed_without_an_active_local_profile() {
        let tmp = TempDir::new().unwrap();
        let state = PluginRuntimeState::new(PathBuf::from(tmp.path()));
        assert!(!state.has_permission("demo", "filesystem:read"));
        assert!(list_permissions_for_state(&state, "demo".into()).is_err());
    }

    #[test]
    fn ignores_a_legacy_ledger_inside_the_plugin_tree() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let plugin_dir = state.plugin_dir("demo");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("permissions.json"),
            serde_json::to_vec(&[PermissionGrant {
                plugin_id: "demo".into(),
                permission: "filesystem:write".into(),
                granted_by: "plugin".into(),
                granted_at: Utc::now().to_rfc3339(),
                expires_at: None,
            }])
            .unwrap(),
        )
        .unwrap();

        assert!(read_ledger(&state, "demo").unwrap().is_empty());
    }
}
