//! Plugin lifecycle Tauri commands (Batch 3a).
//!
//! These ten handlers persist the filesystem-side view of every plugin:
//! installed directory, runtime state JSON, and last known status. The TS
//! `PluginManager` calls them via `invoke('plugin_*')` from
//! `lib/plugin/core/manager.ts`, `lifecycle/rollback.ts`, `core/transport.ts`,
//! and `devtools/hot-reload.ts`. Each handler is intentionally small — it
//! doesn't try to re-implement manifest validation (TS owns that) but it
//! does enforce the install directory boundary so callers can't escape it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use base64::Engine as _;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::{
    NodePluginProcessState, PermissionGrant, PluginError, PluginRecord, PluginRuntimeSnapshot,
    PluginRuntimeState, Result,
};

/// Subset of the manifest the Rust side persists. Anything richer stays in TS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestPayload {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPayload {
    /// Optional manifest JSON. When provided, written to
    /// `<install_dir>/<plugin_id>/manifest.json` verbatim.
    #[serde(default)]
    pub manifest_json: Option<String>,
}

fn write_state_file(
    state: &PluginRuntimeState,
    plugin_id: &str,
    value: &serde_json::Value,
) -> Result<()> {
    let dir = state.plugin_dir(plugin_id);
    fs::create_dir_all(&dir)?;
    let path = dir.join("state.json");
    fs::write(&path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn read_state_file(state: &PluginRuntimeState, plugin_id: &str) -> Result<serde_json::Value> {
    let path = state.plugin_dir(plugin_id).join("state.json");
    if !path.exists() {
        return Ok(serde_json::Value::Null);
    }
    let bytes = fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[tauri::command]
pub async fn plugin_load(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    manifest: PluginManifestPayload,
) -> Result<PluginRuntimeSnapshot> {
    if manifest.id != plugin_id {
        return Err(PluginError::InvalidManifest(format!(
            "manifest.id={} does not match plugin_id={}",
            manifest.id, plugin_id
        )));
    }
    let install_path = state.plugin_dir(&plugin_id);
    fs::create_dir_all(&install_path)?;

    let snapshot = PluginRuntimeSnapshot {
        plugin_id: plugin_id.clone(),
        version: manifest.version.clone(),
        status: "loaded".into(),
        last_error: None,
        loaded_at: Some(Utc::now().to_rfc3339()),
        install_path: install_path.to_string_lossy().into_owned(),
    };
    let runtime_state = read_state_file(&state, &plugin_id).unwrap_or(serde_json::Value::Null);
    state.plugins.write().insert(
        plugin_id,
        PluginRecord {
            snapshot: snapshot.clone(),
            runtime_state,
        },
    );
    Ok(snapshot)
}

fn flip_status(state: &PluginRuntimeState, plugin_id: &str, status: &str) -> Result<()> {
    let mut plugins = state.plugins.write();
    let record = plugins
        .get_mut(plugin_id)
        .ok_or_else(|| PluginError::NotFound(plugin_id.into()))?;
    record.snapshot.status = status.into();
    Ok(())
}

/// Set a plugin's status, creating a minimal record if the backend has never
/// seen it. Unlike `flip_status`, this never returns `NotFound`: the frontend
/// `PluginManager` is the authority on which plugins exist (it discovers
/// browser built-ins and disk-scanned plugins entirely TS-side), and the
/// backend `state.plugins` map is in-memory — empty on every cold start until
/// something calls `plugin_load`/`plugin_install`. Browser built-ins are never
/// loaded through those, so their `syncBackendStatus` sync used to fail with
/// `plugin not found`. Seeding a record keeps the status ledger authoritative
/// without forcing a directory-creating `plugin_load` for bundled plugins.
/// `version` is left empty (TS owns rich metadata); `install_path` is the
/// computed plugin dir but is NOT created on disk.
fn upsert_status(state: &PluginRuntimeState, plugin_id: &str, status: &str) -> Result<()> {
    let mut plugins = state.plugins.write();
    if let Some(record) = plugins.get_mut(plugin_id) {
        record.snapshot.status = status.into();
        return Ok(());
    }
    let runtime_state = read_state_file(state, plugin_id).unwrap_or(serde_json::Value::Null);
    plugins.insert(
        plugin_id.to_string(),
        PluginRecord {
            snapshot: PluginRuntimeSnapshot {
                plugin_id: plugin_id.to_string(),
                version: String::new(),
                status: status.into(),
                last_error: None,
                loaded_at: Some(Utc::now().to_rfc3339()),
                install_path: state.plugin_dir(plugin_id).to_string_lossy().into_owned(),
            },
            runtime_state,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn plugin_enable(state: State<'_, PluginRuntimeState>, plugin_id: String) -> Result<()> {
    flip_status(&state, &plugin_id, "enabled")
}

#[tauri::command]
pub async fn plugin_disable(state: State<'_, PluginRuntimeState>, plugin_id: String) -> Result<()> {
    stop_node_plugin_process(state.inner(), &plugin_id, None).await?;
    flip_status(&state, &plugin_id, "disabled")
}

#[tauri::command]
pub async fn plugin_unload(state: State<'_, PluginRuntimeState>, plugin_id: String) -> Result<()> {
    stop_node_plugin_process(state.inner(), &plugin_id, None).await?;
    state.plugins.write().remove(&plugin_id);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct NodeLaunchResult {
    pub command: String,
    pub argv: Vec<String>,
    pub generation: String,
    pub activation: serde_json::Value,
}

const NODE_PLUGIN_HOST_SOURCE: &str = include_str!("../../../scripts/plugin/node-plugin-host.mjs");
const NODE_PLUGIN_RESULT_PREFIX: &str = "COGNIA_PLUGIN_RESULT:";
const NODE_PLUGIN_FRAME_LIMIT: usize = 2 * 1024 * 1024;
const NODE_PLUGIN_CALLBACK_ID_LIMIT: usize = 96 * 1024;
const NODE_PLUGIN_ARGUMENT_LIMIT: usize = 64 * 1024;

fn node_plugin_host_argv(
    mut argv: Vec<String>,
    action: &str,
    plugin_id: &str,
    callback_id: &str,
    args_json: &str,
) -> Result<Vec<String>> {
    let entry_index = argv
        .iter()
        .position(|argument| !argument.starts_with("--"))
        .ok_or_else(|| PluginError::Internal("Node launch argv has no plugin entry".into()))?;
    let plugin_entry = argv.remove(entry_index);
    let plugin_args = argv.split_off(entry_index);
    argv.extend([
        "--input-type=module".into(),
        "--eval".into(),
        NODE_PLUGIN_HOST_SOURCE.into(),
        action.into(),
        plugin_entry,
        plugin_id.into(),
        callback_id.into(),
        args_json.into(),
    ]);
    argv.extend(plugin_args);
    Ok(argv)
}

fn parse_node_plugin_frame(line: &str) -> Result<serde_json::Value> {
    let payload = line
        .strip_prefix(NODE_PLUGIN_RESULT_PREFIX)
        .ok_or_else(|| {
            PluginError::InvalidManifest(
                "Node plugin host emitted an invalid protocol frame".into(),
            )
        })?;
    let value: serde_json::Value = serde_json::from_str(payload).map_err(|error| {
        PluginError::InvalidManifest(format!("Node plugin host emitted invalid JSON: {error}"))
    })?;
    if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
        return Err(PluginError::InvalidManifest(format!(
            "Node plugin activation failed: {error}"
        )));
    }
    Ok(value)
}

async fn read_node_plugin_activation(
    child: &std::sync::Arc<tokio::sync::Mutex<tokio::process::Child>>,
) -> Result<serde_json::Value> {
    let stdout = child
        .lock()
        .await
        .stdout
        .take()
        .ok_or_else(|| PluginError::Internal("Node plugin stdout was not piped".into()))?;
    let read = async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut observed = 0_usize;
        while let Some(line) = lines.next_line().await.map_err(PluginError::Io)? {
            observed = observed.saturating_add(line.len());
            if observed > NODE_PLUGIN_FRAME_LIMIT {
                return Err(PluginError::InvalidManifest(
                    "Node plugin activation output exceeded the protocol limit".into(),
                ));
            }
            if line.starts_with(NODE_PLUGIN_RESULT_PREFIX) {
                return parse_node_plugin_frame(&line);
            }
        }
        Err(PluginError::InvalidManifest(
            "Node plugin exited before reporting activation".into(),
        ))
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), read)
        .await
        .map_err(|_| PluginError::InvalidManifest("Node plugin activation timed out".into()))?
}

fn checked_scope_paths(
    values: Vec<String>,
    label: &str,
    forbidden_roots: &[(&Path, &str)],
) -> Result<Vec<String>> {
    let mut cleaned = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if value.contains('*') || value.contains(',') || value.chars().any(char::is_control) {
            return Err(PluginError::InvalidArgument(format!(
                "Node {label} grant contains a wildcard, delimiter, or control character"
            )));
        }
        let path = Path::new(value);
        if !path.is_absolute() {
            return Err(PluginError::InvalidArgument(format!(
                "Node {label} grant must be an absolute path: {value}"
            )));
        }
        if path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        }) {
            return Err(PluginError::InvalidArgument(format!(
                "Node {label} grant must not contain dot segments: {value}"
            )));
        }
        let mut current = PathBuf::new();
        for component in path.components() {
            current.push(component);
            let metadata = std::fs::symlink_metadata(&current).map_err(|error| {
                PluginError::InvalidArgument(format!(
                    "Node {label} grant must resolve to an existing path without symlinks: {value}: {error}"
                ))
            })?;
            if metadata.file_type().is_symlink() {
                return Err(PluginError::InvalidArgument(format!(
                    "Node {label} grant must not contain symlink segments: {value}"
                )));
            }
        }
        let canonical = path.canonicalize().map_err(|error| {
            PluginError::InvalidArgument(format!(
                "Node {label} grant cannot be canonicalized: {value}: {error}"
            ))
        })?;
        for (forbidden, description) in forbidden_roots {
            if canonical.starts_with(forbidden) || forbidden.starts_with(&canonical) {
                return Err(PluginError::InvalidArgument(format!(
                    "Node {label} grant overlaps {description}: {}",
                    canonical.display()
                )));
            }
        }
        let canonical = canonical.to_string_lossy().into_owned();
        if !cleaned.contains(&canonical) {
            cleaned.push(canonical);
        }
    }
    Ok(cleaned)
}

const BUNDLED_NODE_VERSION: (u64, u64, u64) = (26, 3, 1);

fn parse_node_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim().strip_prefix('v')?.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn validate_node_runtime(path: PathBuf) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(PluginError::InvalidArgument(
            "bundled Node executable path must be absolute".into(),
        ));
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(PluginError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PluginError::InvalidArgument(
            "bundled Node executable must be a non-symlink regular file".into(),
        ));
    }
    let output = std::process::Command::new(&path)
        .arg("--version")
        .output()
        .map_err(PluginError::Io)?;
    let version = String::from_utf8_lossy(&output.stdout);
    let parsed = parse_node_version(&version);
    if !output.status.success()
        || parsed.is_none_or(|parsed| {
            parsed.0 != BUNDLED_NODE_VERSION.0 || parsed < BUNDLED_NODE_VERSION
        })
    {
        return Err(PluginError::InvalidArgument(format!(
            "plugin runtime requires a patched Node 26 release at or above 26.3.1, got {}",
            version.trim()
        )));
    }
    Ok(path)
}

/// Resolve and validate Cognia's pinned Node runtime from a Tauri resource
/// directory (or the development checkout fallback).
///
/// The desktop Agent host shares this resolver with JavaScript plugins so all
/// bundled Node workloads use the same absolute executable and version gate.
pub fn resolve_node_runtime(resource_dir: Option<&Path>) -> Result<PathBuf> {
    if let Some(configured) = cognia_core::node_runtime::configured_node_executable() {
        return configured.map_err(|error| PluginError::InvalidArgument(error.to_string()));
    }
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(resource_dir) = resource_dir {
        for candidate in [
            resource_dir
                .join("resources/plugin-node/bin")
                .join(executable),
            resource_dir.join("plugin-node/bin").join(executable),
        ] {
            if candidate.is_file() {
                return validate_node_runtime(candidate);
            }
        }
    }
    #[cfg(debug_assertions)]
    if let Some(repository_root) = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
    {
        let candidate = repository_root
            .join("src-tauri/resources/plugin-node/bin")
            .join(executable);
        if candidate.is_file() {
            return validate_node_runtime(candidate);
        }
    }
    if let Some(value) = std::env::var_os("COGNIA_PLUGIN_NODE_PATH") {
        return validate_node_runtime(PathBuf::from(value));
    }
    Err(PluginError::InvalidArgument(
        "the verified bundled Node 26.3.1+ plugin runtime is missing; rerun the Tauri build preparation"
            .into(),
    ))
}

fn grant_is_live(grant: &PermissionGrant) -> bool {
    grant.expires_at.as_ref().is_none_or(|expires_at| {
        chrono::DateTime::parse_from_rfc3339(expires_at)
            .map(|expires| expires > Utc::now())
            .unwrap_or(false)
    })
}

fn read_node_manifest(root: &Path) -> Result<serde_json::Value> {
    for name in ["manifest.json", "plugin.json"] {
        match crate::contained_path::read_existing_plugin_file(root, name) {
            Ok(bytes) => {
                let manifest = serde_json::from_slice(&bytes).map_err(PluginError::Serde)?;
                crate::contract::validate_manifest_contract(&manifest)
                    .map_err(PluginError::InvalidManifest)?;
                return Ok(manifest);
            }
            Err(error) if error.contains("No such file") => continue,
            Err(error) => return Err(PluginError::InvalidArgument(error)),
        }
    }
    Err(PluginError::InvalidManifest(
        "installed Node plugin is missing manifest.json/plugin.json".into(),
    ))
}

fn manifest_string_array(manifest: &serde_json::Value, path: &[&str]) -> Result<Vec<String>> {
    let mut value = manifest;
    for segment in path {
        let Some(next) = value.get(*segment) else {
            return Ok(Vec::new());
        };
        value = next;
    }
    value
        .as_array()
        .ok_or_else(|| {
            PluginError::InvalidManifest(format!("{} must be an array", path.join(".")))
        })?
        .iter()
        .map(|item| {
            item.as_str().map(str::to_string).ok_or_else(|| {
                PluginError::InvalidManifest(format!(
                    "{} must contain only strings",
                    path.join(".")
                ))
            })
        })
        .collect()
}

fn prepare_node_launch(
    expected_root: &Path,
    claimed_root: &Path,
    plugin_install_dir: &Path,
    plugin_state_dir: &Path,
    entry: &str,
    grants: Vec<PermissionGrant>,
    extra_args: Vec<String>,
) -> Result<(PathBuf, Vec<String>)> {
    if extra_args
        .iter()
        .any(|arg| arg.contains('*') || arg.chars().any(char::is_control))
    {
        return Err(PluginError::InvalidArgument(
            "Node plugin arguments contain a wildcard or control character".into(),
        ));
    }
    let root = crate::contained_path::validate_claimed_plugin_root(expected_root, claimed_root)
        .map_err(PluginError::InvalidArgument)?;
    crate::contained_path::validate_symlink_free_tree(&root)
        .map_err(PluginError::InvalidArgument)?;
    let manifest = read_node_manifest(&root)?;
    let declared_entry = manifest
        .get("main")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| PluginError::InvalidManifest("Node plugin main is required".into()))?;
    let normalized_entry = crate::contained_path::validate_plugin_relative_path(entry)
        .map_err(PluginError::InvalidArgument)?;
    let normalized_declared = crate::contained_path::validate_plugin_relative_path(declared_entry)
        .map_err(PluginError::InvalidManifest)?;
    if normalized_entry != normalized_declared {
        return Err(PluginError::InvalidArgument(
            "Node runtime entry must match the host-validated manifest main".into(),
        ));
    }
    let executable = crate::contained_path::resolve_existing_plugin_file(&root, entry)
        .map_err(PluginError::InvalidArgument)?;
    let canonical_install_dir = plugin_install_dir.canonicalize().map_err(PluginError::Io)?;
    let canonical_state_dir =
        if plugin_state_dir.exists() {
            plugin_state_dir.canonicalize().map_err(PluginError::Io)?
        } else {
            canonical_install_dir.join(plugin_state_dir.file_name().ok_or_else(|| {
                PluginError::Internal("plugin state directory has no name".into())
            })?)
        };
    let granted = grants
        .iter()
        .filter(|grant| grant_is_live(grant))
        .map(|grant| grant.permission.as_str())
        .collect::<std::collections::HashSet<_>>();
    let declared_permissions = manifest_string_array(&manifest, &["permissions"])?;
    let declares = |permission: &str| {
        declared_permissions.iter().any(|value| value == permission) && granted.contains(permission)
    };
    if declares("network:fetch") || declares("network:upload") || declares("network:websocket") {
        return Err(PluginError::InvalidArgument(
            "Node network grants require a scoped host broker and cannot run in-process".into(),
        ));
    }
    if declares("shell:execute") || declares("process:spawn") {
        return Err(PluginError::InvalidArgument(
            "Node subprocess grants require a scoped host broker".into(),
        ));
    }
    let mut read_paths = if declares("filesystem:read") {
        checked_scope_paths(
            manifest_string_array(&manifest, &["fileScope", "readPaths"])?,
            "read",
            &[(&canonical_state_dir, "host-owned plugin metadata")],
        )?
    } else {
        Vec::new()
    };
    let root_string = root.to_string_lossy().into_owned();
    if !read_paths.contains(&root_string) {
        read_paths.push(root_string);
    }
    let write_paths = if declares("filesystem:write") {
        checked_scope_paths(
            manifest_string_array(&manifest, &["fileScope", "writePaths"])?,
            "write",
            &[
                (
                    &canonical_install_dir,
                    "the immutable plugin installation tree",
                ),
                (&canonical_state_dir, "host-owned plugin metadata"),
            ],
        )?
    } else {
        Vec::new()
    };
    let mut argv = vec!["--permission".to_string()];
    argv.extend(
        read_paths
            .into_iter()
            .map(|path| format!("--allow-fs-read={path}")),
    );
    argv.extend(
        write_paths
            .into_iter()
            .map(|path| format!("--allow-fs-write={path}")),
    );
    argv.push(executable.to_string_lossy().into_owned());
    argv.extend(extra_args);
    Ok((root, argv))
}

fn generation_matches(state: &NodePluginProcessState, generation: uuid::Uuid) -> bool {
    match state {
        NodePluginProcessState::Launching {
            generation: current,
        }
        | NodePluginProcessState::Running {
            generation: current,
            ..
        } => *current == generation,
    }
}

/// One long-lived Node plugin host as the managed-process registry sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodePluginManagedInfo {
    pub plugin_id: String,
    pub pid: Option<u32>,
    /// The host is spawning — it has a slot reserved but no child yet.
    pub launching: bool,
}

/// Snapshot every Node plugin host for the managed-process registry.
///
/// Non-blocking on purpose: this runs on the perf sampler tick, so a host
/// whose child lock is momentarily held (a kill in flight) reports `pid: None`
/// rather than stalling the whole frame.
pub fn node_plugin_snapshot(state: &PluginRuntimeState) -> Vec<NodePluginManagedInfo> {
    state
        .node_plugin_processes
        .lock()
        .iter()
        .map(|(plugin_id, process)| match process {
            NodePluginProcessState::Launching { .. } => NodePluginManagedInfo {
                plugin_id: plugin_id.clone(),
                pid: None,
                launching: true,
            },
            NodePluginProcessState::Running { child, .. } => NodePluginManagedInfo {
                plugin_id: plugin_id.clone(),
                pid: child.try_lock().ok().and_then(|c| c.id()),
                launching: false,
            },
        })
        .collect()
}

/// Kill one Node plugin host by plugin id. Returns whether a process was found.
pub async fn stop_node_plugin(state: &PluginRuntimeState, plugin_id: &str) -> Result<bool> {
    stop_node_plugin_process(state, plugin_id, None).await
}

/// Kill every Node plugin host. Called from the app-exit teardown — these are
/// long-lived children with no other shutdown path.
pub async fn stop_all_node_plugins(state: &PluginRuntimeState) {
    let ids: Vec<String> = state.node_plugin_processes.lock().keys().cloned().collect();
    for id in ids {
        let _ = stop_node_plugin_process(state, &id, None).await;
    }
}

fn remove_node_generation(
    state: &PluginRuntimeState,
    plugin_id: &str,
    generation: uuid::Uuid,
) -> bool {
    let mut processes = state.node_plugin_processes.lock();
    if processes
        .get(plugin_id)
        .is_some_and(|process| generation_matches(process, generation))
    {
        processes.remove(plugin_id);
        true
    } else {
        false
    }
}

async fn stop_node_plugin_process(
    state: &PluginRuntimeState,
    plugin_id: &str,
    generation: Option<uuid::Uuid>,
) -> Result<bool> {
    let process = {
        let mut processes = state.node_plugin_processes.lock();
        if generation.is_some_and(|generation| {
            processes
                .get(plugin_id)
                .is_none_or(|process| !generation_matches(process, generation))
        }) {
            return Ok(false);
        }
        match processes.get(plugin_id) {
            Some(NodePluginProcessState::Launching { .. }) => {
                processes.remove(plugin_id);
                return Ok(true);
            }
            Some(NodePluginProcessState::Running {
                generation, child, ..
            }) => Some((*generation, child.clone())),
            None => None,
        }
    };
    let had_process = process.is_some();
    if let Some((process_generation, child)) = process {
        let mut child = child.lock().await;
        if child.try_wait().map_err(PluginError::Io)?.is_none() {
            child.kill().await.map_err(PluginError::Io)?;
        }
        drop(child);
        remove_node_generation(state, plugin_id, process_generation);
    }
    Ok(had_process)
}

fn spawn_node_reaper(
    processes: std::sync::Arc<
        parking_lot::Mutex<std::collections::HashMap<String, NodePluginProcessState>>,
    >,
    plugin_id: String,
    generation: uuid::Uuid,
    child: std::sync::Arc<tokio::sync::Mutex<tokio::process::Child>>,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let finished = child
                .lock()
                .await
                .try_wait()
                .map(|status| status.is_some())
                .unwrap_or(true);
            if finished {
                let mut processes = processes.lock();
                if processes
                    .get(&plugin_id)
                    .is_some_and(|process| generation_matches(process, generation))
                {
                    processes.remove(&plugin_id);
                }
                break;
            }
        }
    });
}

fn spawn_reserved_node_process(
    state: &PluginRuntimeState,
    plugin_id: &str,
    generation: uuid::Uuid,
    command: &Path,
    argv: &[String],
    root: &Path,
) -> Result<std::sync::Arc<tokio::sync::Mutex<tokio::process::Child>>> {
    let mut processes = state.node_plugin_processes.lock();
    if !processes
        .get(plugin_id)
        .is_some_and(|process| generation_matches(process, generation))
    {
        return Err(PluginError::InvalidArgument(
            "Node plugin launch was cancelled".into(),
        ));
    }
    let spawned = tokio::process::Command::new(command)
        .args(argv)
        .current_dir(root)
        .env_clear()
        .env("COGNIA_PLUGIN_ID", plugin_id)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let child = match spawned {
        Ok(child) => child,
        Err(error) => {
            processes.remove(plugin_id);
            return Err(PluginError::Io(error));
        }
    };
    let child = std::sync::Arc::new(tokio::sync::Mutex::new(child));
    processes.insert(
        plugin_id.to_string(),
        NodePluginProcessState::Running {
            generation,
            child: child.clone(),
        },
    );
    Ok(child)
}

/// Launch an installed Node plugin entirely in the native host. This keeps
/// `node:*` imports and process handles out of the static-export renderer.
#[tauri::command]
pub async fn plugin_launch_js(
    app: tauri::AppHandle,
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    plugin_path: String,
    entry: String,
    extra_args: Vec<String>,
) -> Result<NodeLaunchResult> {
    let resource_dir = app.path().resource_dir().map_err(|error| {
        PluginError::Internal(format!("cannot resolve resource directory: {error}"))
    })?;
    plugin_launch_js_for_state(
        state.inner(),
        plugin_id,
        plugin_path,
        entry,
        extra_args,
        Some(resource_dir),
    )
    .await
}

pub async fn plugin_launch_js_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    plugin_path: String,
    entry: String,
    extra_args: Vec<String>,
    resource_dir: Option<PathBuf>,
) -> Result<NodeLaunchResult> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
    let grants = match state.permissions.read().get(&plugin_id).cloned() {
        Some(grants) => grants,
        None => crate::permissions::read_ledger(state, &plugin_id)?,
    };
    let generation = uuid::Uuid::new_v4();
    {
        let mut processes = state.node_plugin_processes.lock();
        if processes.contains_key(&plugin_id) {
            return Err(PluginError::InvalidArgument(format!(
                "Node plugin is already launching or running: {plugin_id}"
            )));
        }
        processes.insert(
            plugin_id.clone(),
            NodePluginProcessState::Launching { generation },
        );
    }
    let expected_root = state.plugin_dir(&plugin_id);
    let claimed_root = PathBuf::from(plugin_path);
    let plugin_install_dir = state.plugin_install_dir.clone();
    let plugin_state_dir = state.plugin_state_dir.clone();
    let prepared = match tokio::task::spawn_blocking(move || {
        let (root, argv) = prepare_node_launch(
            &expected_root,
            &claimed_root,
            &plugin_install_dir,
            &plugin_state_dir,
            &entry,
            grants,
            extra_args,
        )?;
        Ok::<_, PluginError>((root, argv, resolve_node_runtime(resource_dir.as_deref())?))
    })
    .await
    {
        Ok(prepared) => prepared,
        Err(error) => {
            remove_node_generation(state, &plugin_id, generation);
            return Err(PluginError::Internal(format!(
                "Node launch validator failed: {error}"
            )));
        }
    };
    let (root, argv, command) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            remove_node_generation(state, &plugin_id, generation);
            return Err(error);
        }
    };
    let argv = node_plugin_host_argv(argv, "activate-wait", &plugin_id, "", "[]")?;
    let child = spawn_reserved_node_process(state, &plugin_id, generation, &command, &argv, &root)?;
    let activation = match read_node_plugin_activation(&child).await {
        Ok(activation) => activation,
        Err(error) => {
            let _ = child.lock().await.kill().await;
            remove_node_generation(state, &plugin_id, generation);
            return Err(error);
        }
    };
    spawn_node_reaper(
        state.node_plugin_processes.clone(),
        plugin_id,
        generation,
        child,
    );
    Ok(NodeLaunchResult {
        command: command.to_string_lossy().into_owned(),
        argv,
        generation: generation.to_string(),
        activation,
    })
}

async fn run_node_plugin_action(
    state: &PluginRuntimeState,
    plugin_id: &str,
    plugin_path: &str,
    entry: &str,
    action: &str,
    callback_id: &str,
    args: &serde_json::Value,
    resource_dir: Option<&Path>,
) -> Result<serde_json::Value> {
    crate::validate_plugin_id_path_component(plugin_id)?;
    if callback_id.len() > NODE_PLUGIN_CALLBACK_ID_LIMIT
        || callback_id.chars().any(char::is_control)
    {
        return Err(PluginError::InvalidArgument(
            "Node plugin callback id is invalid".into(),
        ));
    }
    let args_json = serde_json::to_string(args)?;
    if args_json.len() > NODE_PLUGIN_ARGUMENT_LIMIT {
        return Err(PluginError::InvalidArgument(
            "Node plugin callback arguments exceed the protocol limit".into(),
        ));
    }
    let grants = match state.permissions.read().get(plugin_id).cloned() {
        Some(grants) => grants,
        None => crate::permissions::read_ledger(state, plugin_id)?,
    };
    let expected_root = state.plugin_dir(plugin_id);
    let claimed_root = PathBuf::from(plugin_path);
    let (root, argv) = prepare_node_launch(
        &expected_root,
        &claimed_root,
        &state.plugin_install_dir,
        &state.plugin_state_dir,
        entry,
        grants,
        Vec::new(),
    )?;
    let argv = node_plugin_host_argv(argv, action, plugin_id, callback_id, &args_json)?;
    let command = resolve_node_runtime(resource_dir)?;
    let mut process = tokio::process::Command::new(command);
    process
        .args(argv)
        .current_dir(root)
        .env_clear()
        .env("COGNIA_PLUGIN_ID", plugin_id)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(120), process.output())
        .await
        .map_err(|_| PluginError::InvalidManifest("Node plugin callback timed out".into()))??;
    if output.stdout.len() > NODE_PLUGIN_FRAME_LIMIT
        || output.stderr.len() > NODE_PLUGIN_FRAME_LIMIT
    {
        return Err(PluginError::InvalidManifest(
            "Node plugin callback output exceeded the protocol limit".into(),
        ));
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| PluginError::InvalidManifest("Node plugin host stdout is not UTF-8".into()))?;
    let frame = stdout
        .lines()
        .rev()
        .find(|line| line.starts_with(NODE_PLUGIN_RESULT_PREFIX))
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            PluginError::InvalidManifest(format!(
                "Node plugin host returned no protocol frame: {}",
                stderr.trim()
            ))
        })?;
    parse_node_plugin_frame(frame)
}

#[tauri::command]
pub async fn plugin_invoke_js_callback(
    app: tauri::AppHandle,
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    plugin_path: String,
    entry: String,
    callback_id: String,
    args: serde_json::Value,
) -> Result<serde_json::Value> {
    let resource_dir = app.path().resource_dir().map_err(|error| {
        PluginError::Internal(format!("cannot resolve resource directory: {error}"))
    })?;
    plugin_invoke_js_callback_for_state(
        state.inner(),
        plugin_id,
        plugin_path,
        entry,
        callback_id,
        args,
        Some(resource_dir),
    )
    .await
}

pub async fn plugin_invoke_js_callback_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    plugin_path: String,
    entry: String,
    callback_id: String,
    args: serde_json::Value,
    resource_dir: Option<PathBuf>,
) -> Result<serde_json::Value> {
    let frame = run_node_plugin_action(
        state,
        &plugin_id,
        &plugin_path,
        &entry,
        "callback",
        &callback_id,
        &args,
        resource_dir.as_deref(),
    )
    .await?;
    Ok(frame
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn plugin_deactivate_js(
    app: tauri::AppHandle,
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    plugin_path: String,
    entry: String,
) -> Result<()> {
    let resource_dir = app.path().resource_dir().map_err(|error| {
        PluginError::Internal(format!("cannot resolve resource directory: {error}"))
    })?;
    plugin_deactivate_js_for_state(
        state.inner(),
        plugin_id,
        plugin_path,
        entry,
        Some(resource_dir),
    )
    .await
}

pub async fn plugin_deactivate_js_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    plugin_path: String,
    entry: String,
    resource_dir: Option<PathBuf>,
) -> Result<()> {
    run_node_plugin_action(
        state,
        &plugin_id,
        &plugin_path,
        &entry,
        "deactivate",
        "",
        &serde_json::Value::Array(Vec::new()),
        resource_dir.as_deref(),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn plugin_stop_js(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    generation: String,
) -> Result<()> {
    plugin_stop_js_for_state(state.inner(), plugin_id, generation).await
}

pub async fn plugin_stop_js_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    generation: String,
) -> Result<()> {
    let generation = uuid::Uuid::parse_str(&generation)
        .map_err(|_| PluginError::InvalidArgument("invalid Node process generation".into()))?;
    stop_node_plugin_process(state, &plugin_id, Some(generation)).await?;
    Ok(())
}

#[tauri::command]
pub async fn plugin_js_status(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    generation: String,
) -> Result<bool> {
    plugin_js_status_for_state(state.inner(), plugin_id, generation).await
}

pub async fn plugin_js_status_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    generation: String,
) -> Result<bool> {
    let generation = uuid::Uuid::parse_str(&generation)
        .map_err(|_| PluginError::InvalidArgument("invalid Node process generation".into()))?;
    let child = {
        let processes = state.node_plugin_processes.lock();
        match processes.get(&plugin_id) {
            Some(NodePluginProcessState::Running {
                generation: current,
                child,
            }) if *current == generation => child.clone(),
            Some(NodePluginProcessState::Launching {
                generation: current,
            }) if *current == generation => return Ok(true),
            _ => return Ok(false),
        }
    };
    let running = child
        .lock()
        .await
        .try_wait()
        .map_err(PluginError::Io)?
        .is_none();
    if !running {
        let mut processes = state.node_plugin_processes.lock();
        if processes
            .get(&plugin_id)
            .is_some_and(|process| generation_matches(process, generation))
        {
            processes.remove(&plugin_id);
        }
    }
    Ok(running)
}

fn read_plugin_entry_bytes_inner(
    expected_root: &std::path::Path,
    claimed_root: &std::path::Path,
    entry: &str,
) -> Result<Vec<u8>> {
    let root = crate::contained_path::validate_claimed_plugin_root(expected_root, claimed_root)
        .map_err(PluginError::InvalidArgument)?;
    crate::contained_path::validate_symlink_free_tree(&root)
        .map_err(PluginError::InvalidArgument)?;
    crate::contained_path::read_existing_plugin_file(&root, entry)
        .map_err(PluginError::InvalidArgument)
}

fn read_plugin_entry_inner(
    expected_root: &std::path::Path,
    claimed_root: &std::path::Path,
    entry: &str,
) -> Result<String> {
    String::from_utf8(read_plugin_entry_bytes_inner(
        expected_root,
        claimed_root,
        entry,
    )?)
    .map_err(|_| PluginError::InvalidManifest("plugin JavaScript entry is not UTF-8".into()))
}

/// Read one installed JavaScript bundle through a no-follow host handle.
/// Renderer code never fetches arbitrary `file://` paths directly.
#[tauri::command]
pub async fn plugin_read_entry(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    plugin_path: String,
    entry: String,
) -> Result<String> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
    let expected_root = state.plugin_dir(&plugin_id);
    let claimed_root = std::path::PathBuf::from(plugin_path);
    tokio::task::spawn_blocking(move || {
        read_plugin_entry_inner(&expected_root, &claimed_root, &entry)
    })
    .await
    .map_err(|error| PluginError::Internal(format!("plugin entry reader task failed: {error}")))?
}

/// Read a binary plugin asset with the same no-follow containment guarantees
/// and return base64 for renderer-side data URLs.
#[tauri::command]
pub async fn plugin_read_entry_base64(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    plugin_path: String,
    entry: String,
) -> Result<String> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
    let expected_root = state.plugin_dir(&plugin_id);
    let claimed_root = std::path::PathBuf::from(plugin_path);
    let bytes = tokio::task::spawn_blocking(move || {
        read_plugin_entry_bytes_inner(&expected_root, &claimed_root, &entry)
    })
    .await
    .map_err(|error| {
        PluginError::Internal(format!("plugin asset reader task failed: {error}"))
    })??;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Validate the install manifest before any disk write. Mirrors the always-on
/// gates the TS `registerBackendInstall` tail enforces (manifest present, valid
/// JSON, declared id matches the install id, non-empty version) so that callers
/// reaching this command directly — notably the Companion API remote install
/// path, which bypasses the renderer's `PluginManager` entirely — cannot
/// install a phantom, malformed, or id-mismatched plugin. Signature
/// verification stays TS-side (it is config-gated and off by default); this
/// covers the integrity gates that always run. Returns the validated version.
fn validate_install_manifest(plugin_id: &str, payload: &InstallPayload) -> Result<String> {
    let raw = payload.manifest_json.as_deref().ok_or_else(|| {
        PluginError::InvalidManifest(
            "manifest_json is required to install a plugin (refusing to create a manifest-less plugin)".into(),
        )
    })?;
    let manifest_value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| PluginError::InvalidManifest(format!("manifest is not valid JSON: {e}")))?;
    crate::contract::validate_manifest_contract(&manifest_value)
        .map_err(PluginError::InvalidManifest)?;
    let manifest: PluginManifestPayload = serde_json::from_value(manifest_value)
        .map_err(|e| PluginError::InvalidManifest(format!("manifest fields are invalid: {e}")))?;
    if manifest.id != plugin_id {
        return Err(PluginError::InvalidManifest(format!(
            "manifest.id={} does not match plugin_id={}",
            manifest.id, plugin_id
        )));
    }
    if manifest.version.trim().is_empty() {
        return Err(PluginError::InvalidManifest(
            "manifest.version is empty".into(),
        ));
    }
    Ok(manifest.version)
}

#[tauri::command]
pub async fn plugin_install(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    source: String,
    payload: InstallPayload,
) -> Result<PluginRuntimeSnapshot> {
    plugin_install_for_state(state.inner(), plugin_id, source, payload).await
}

/// Host-neutral install entry used by Tauri and the headless companion host.
pub async fn plugin_install_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    source: String,
    payload: InstallPayload,
) -> Result<PluginRuntimeSnapshot> {
    if plugin_id.trim().is_empty() {
        return Err(PluginError::InvalidArgument("plugin_id is empty".into()));
    }
    // Gate: validate the manifest BEFORE touching disk so a rejected install
    // leaves no partial plugin directory behind.
    let version = validate_install_manifest(&plugin_id, &payload)?;
    let install_path = state.plugin_dir(&plugin_id);
    fs::create_dir_all(&install_path)?;
    if let Some(manifest_json) = payload.manifest_json.as_ref() {
        let manifest_path = install_path.join("manifest.json");
        fs::write(&manifest_path, manifest_json.as_bytes())?;
    }

    let snapshot = PluginRuntimeSnapshot {
        plugin_id: plugin_id.clone(),
        version,
        status: "installed".into(),
        last_error: None,
        loaded_at: Some(Utc::now().to_rfc3339()),
        install_path: install_path.to_string_lossy().into_owned(),
    };
    state.plugins.write().insert(
        plugin_id,
        PluginRecord {
            snapshot: snapshot.clone(),
            runtime_state: serde_json::Value::Null,
        },
    );
    log::info!(
        "plugin_install: id={} source={}",
        snapshot.plugin_id,
        source
    );
    Ok(snapshot)
}

#[tauri::command]
pub async fn plugin_uninstall(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<()> {
    plugin_uninstall_for_state(state.inner(), plugin_id).await
}

/// Host-neutral uninstall entry used by Tauri and the headless companion host.
pub async fn plugin_uninstall_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
) -> Result<()> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
    stop_node_plugin_process(state, &plugin_id, None).await?;
    let install_path = state.plugin_dir(&plugin_id);
    let host_state_path = state.plugin_host_state_dir(&plugin_id);
    tokio::task::spawn_blocking(move || {
        if install_path.exists() {
            fs::remove_dir_all(&install_path)?;
        }
        if host_state_path.exists() {
            let metadata = fs::symlink_metadata(&host_state_path)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(PluginError::InvalidArgument(
                    "plugin host state path is not a trusted directory".into(),
                ));
            }
            fs::remove_dir_all(&host_state_path)?;
        }
        Result::<()>::Ok(())
    })
    .await
    .map_err(|error| PluginError::Internal(format!("plugin uninstall task failed: {error}")))??;
    state.plugins.write().remove(&plugin_id);
    state.permissions.write().remove(&plugin_id);
    Ok(())
}

#[tauri::command]
pub async fn plugin_get_all(
    state: State<'_, PluginRuntimeState>,
) -> Result<Vec<PluginRuntimeSnapshot>> {
    plugin_get_all_for_state(state.inner()).await
}

/// Host-neutral runtime inventory used by Tauri and the headless companion host.
pub async fn plugin_get_all_for_state(
    state: &PluginRuntimeState,
) -> Result<Vec<PluginRuntimeSnapshot>> {
    Ok(state
        .plugins
        .read()
        .values()
        .map(|r| r.snapshot.clone())
        .collect())
}

#[tauri::command]
pub async fn plugin_runtime_snapshot(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<PluginRuntimeSnapshot> {
    plugin_runtime_snapshot_for_state(state.inner(), plugin_id).await
}

/// Host-neutral snapshot lookup used by Tauri and the headless companion host.
pub async fn plugin_runtime_snapshot_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
) -> Result<PluginRuntimeSnapshot> {
    state
        .plugins
        .read()
        .get(&plugin_id)
        .map(|r| r.snapshot.clone())
        .ok_or_else(|| PluginError::NotFound(plugin_id))
}

#[tauri::command]
pub async fn plugin_set_state(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    state_blob: serde_json::Value,
) -> Result<()> {
    write_state_file(&state, &plugin_id, &state_blob)?;
    if let Some(record) = state.plugins.write().get_mut(&plugin_id) {
        record.runtime_state = state_blob;
    }
    Ok(())
}

/// Set the lifecycle status on a plugin's runtime snapshot. This is the
/// status-ledger counterpart to `plugin_set_state` (which persists opaque
/// runtime data, NOT status). The frontend `PluginManager.syncBackendStatus`
/// drives this on every load/enable/disable/suspend/unload transition so a
/// cold-start `syncRuntimeState` restores the exact status. Uses
/// `upsert_status` so any status string (installed/loaded/enabled/disabled/
/// error) is preserved verbatim — and a plugin the backend hasn't explicitly
/// loaded (browser built-ins, disk-scanned plugins, anything after a cold
/// restart) is seeded rather than rejected with `NotFound`.
#[tauri::command]
pub async fn plugin_set_status(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    status: String,
) -> Result<()> {
    plugin_set_status_for_state(state.inner(), plugin_id, status)
}

/// Host-neutral status ledger update used by Tauri and the headless service.
pub fn plugin_set_status_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    status: String,
) -> Result<()> {
    upsert_status(state, &plugin_id, &status)
}

#[tauri::command]
pub async fn plugin_get_state(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<serde_json::Value> {
    if let Some(record) = state.plugins.read().get(&plugin_id) {
        return Ok(record.runtime_state.clone());
    }
    read_state_file(&state, &plugin_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn make_state(tmp: &TempDir) -> PluginRuntimeState {
        PluginRuntimeState::new(PathBuf::from(tmp.path()))
    }

    #[test]
    fn reads_only_utf8_entries_from_the_registered_symlink_free_tree() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let root = state.plugin_dir("demo");
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.js"), "module.exports = {};").unwrap();

        assert_eq!(
            read_plugin_entry_inner(&root, &root, "dist/index.js").unwrap(),
            "module.exports = {};"
        );
        assert!(read_plugin_entry_inner(&root, &root, "../outside.js").is_err());
        assert!(read_plugin_entry_inner(
            &root,
            tmp.path().join("outside").as_path(),
            "dist/index.js"
        )
        .is_err());
    }

    #[test]
    fn reads_binary_assets_without_utf8_conversion() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let root = state.plugin_dir("demo");
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/image.bin"), [0_u8, 159, 146, 150]).unwrap();

        assert_eq!(
            read_plugin_entry_bytes_inner(&root, &root, "assets/image.bin").unwrap(),
            vec![0, 159, 146, 150]
        );
        assert!(read_plugin_entry_inner(&root, &root, "assets/image.bin").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn binary_asset_reads_reject_symlinked_segments() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let root = state.plugin_dir("demo");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.bin"), b"secret").unwrap();
        symlink(&outside, root.join("assets")).unwrap();

        assert!(read_plugin_entry_bytes_inner(&root, &root, "assets/secret.bin").is_err());
    }

    #[test]
    fn prepares_node_launch_with_host_owned_containment_and_scoped_paths() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let root = state.plugin_dir("demo");
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.mjs"), "export default {};").unwrap();
        let canonical_root = root.canonicalize().unwrap();
        std::fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": "demo",
                "name": "Demo",
                "version": "1.0.0",
                "type": "frontend",
                "main": "dist/index.mjs",
                "capabilities": [],
                "permissions": ["filesystem:read"],
                "fileScope": { "readPaths": [canonical_root.to_string_lossy()] }
            }))
            .unwrap(),
        )
        .unwrap();
        let (resolved_root, argv) = prepare_node_launch(
            &root,
            &root,
            &state.plugin_install_dir,
            &state.plugin_state_dir,
            "dist/index.mjs",
            vec![PermissionGrant {
                plugin_id: "demo".into(),
                permission: "filesystem:read".into(),
                granted_by: "test".into(),
                granted_at: Utc::now().to_rfc3339(),
                expires_at: None,
            }],
            vec!["--mode=test".into()],
        )
        .unwrap();

        assert_eq!(resolved_root, root.canonicalize().unwrap());
        assert_eq!(argv.first().map(String::as_str), Some("--permission"));
        let read_flags = argv
            .iter()
            .filter(|arg| arg.starts_with("--allow-fs-read="))
            .collect::<Vec<_>>();
        assert_eq!(read_flags.len(), 1);
        assert!(!read_flags[0].contains(','));
        assert_eq!(argv.last().map(String::as_str), Some("--mode=test"));
    }

    #[test]
    fn emits_repeated_node_flags_for_multiple_scopes() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let root = state.plugin_dir("demo");
        let shared = tmp.path().join("shared");
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(root.join("dist/index.mjs"), "export default {};").unwrap();
        let root = root.canonicalize().unwrap();
        let shared = shared.canonicalize().unwrap();
        std::fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": "demo",
                "name": "Demo",
                "version": "1.0.0",
                "type": "frontend",
                "main": "dist/index.mjs",
                "capabilities": [],
                "permissions": ["filesystem:read"],
                "fileScope": { "readPaths": [root, shared] }
            }))
            .unwrap(),
        )
        .unwrap();

        let (_, argv) = prepare_node_launch(
            &root,
            &root,
            &state.plugin_install_dir,
            &state.plugin_state_dir,
            "dist/index.mjs",
            vec![PermissionGrant {
                plugin_id: "demo".into(),
                permission: "filesystem:read".into(),
                granted_by: "test".into(),
                granted_at: Utc::now().to_rfc3339(),
                expires_at: None,
            }],
            vec![],
        )
        .unwrap();

        let flags = argv
            .iter()
            .filter(|arg| arg.starts_with("--allow-fs-read="))
            .collect::<Vec<_>>();
        assert_eq!(flags.len(), 2);
        assert!(flags.iter().all(|flag| !flag.contains(',')));
    }

    #[test]
    fn scope_paths_cannot_cover_install_or_host_state_trees() {
        let tmp = TempDir::new().unwrap();
        let install = tmp.path().join("plugins");
        let state_dir = install.join(".host-state");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let install = install.canonicalize().unwrap();
        let state_dir = state_dir.canonicalize().unwrap();
        let outside = outside.canonicalize().unwrap();

        assert!(checked_scope_paths(
            vec![outside.to_string_lossy().into_owned()],
            "read",
            &[(&state_dir, "host metadata")]
        )
        .is_ok());
        assert!(checked_scope_paths(
            vec![install.to_string_lossy().into_owned()],
            "write",
            &[(&install, "install tree"), (&state_dir, "host metadata")]
        )
        .is_err());
        assert!(checked_scope_paths(
            vec![state_dir.to_string_lossy().into_owned()],
            "read",
            &[(&state_dir, "host metadata")]
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn scope_paths_reject_symlink_segments() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let real = tmp.path().join("real");
        let link = tmp.path().join("link");
        std::fs::create_dir_all(&real).unwrap();
        symlink(&real, &link).unwrap();

        assert!(
            checked_scope_paths(vec![link.to_string_lossy().into_owned()], "read", &[]).is_err()
        );
    }

    #[test]
    fn node_runtime_version_requires_patched_node_26() {
        assert_eq!(parse_node_version("v26.3.1\n"), Some((26, 3, 1)));
        assert!(parse_node_version("26.3.1").is_none());
        assert!((26, 3, 0) < BUNDLED_NODE_VERSION);
        assert_ne!((25, 99, 99).0, BUNDLED_NODE_VERSION.0);
    }

    #[test]
    fn rejects_unsafe_node_launch_inputs_before_process_creation() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let root = state.plugin_dir("demo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.mjs"), "export default {};").unwrap();
        let write_manifest = |permissions: &[&str], read_paths: &[&str]| {
            std::fs::write(
                root.join("manifest.json"),
                serde_json::to_vec(&serde_json::json!({
                    "id": "demo",
                    "name": "Demo",
                    "version": "1.0.0",
                    "type": "frontend",
                    "main": "index.mjs",
                    "capabilities": [],
                    "permissions": permissions,
                    "fileScope": { "readPaths": read_paths }
                }))
                .unwrap(),
            )
            .unwrap();
        };
        write_manifest(&[], &[]);

        assert!(prepare_node_launch(
            &root,
            &root,
            &state.plugin_install_dir,
            &state.plugin_state_dir,
            "../outside.mjs",
            vec![],
            vec![]
        )
        .is_err());
        write_manifest(&["filesystem:read"], &["relative"]);
        let read_grant = PermissionGrant {
            plugin_id: "demo".into(),
            permission: "filesystem:read".into(),
            granted_by: "test".into(),
            granted_at: Utc::now().to_rfc3339(),
            expires_at: None,
        };
        assert!(prepare_node_launch(
            &root,
            &root,
            &state.plugin_install_dir,
            &state.plugin_state_dir,
            "index.mjs",
            vec![read_grant],
            vec![],
        )
        .is_err());
        write_manifest(&["network:fetch"], &[]);
        let network_grant = PermissionGrant {
            plugin_id: "demo".into(),
            permission: "network:fetch".into(),
            granted_by: "test".into(),
            granted_at: Utc::now().to_rfc3339(),
            expires_at: None,
        };
        assert!(prepare_node_launch(
            &root,
            &root,
            &state.plugin_install_dir,
            &state.plugin_state_dir,
            "index.mjs",
            vec![network_grant],
            vec![],
        )
        .is_err());
    }

    #[tokio::test]
    async fn node_launch_generation_prevents_stale_stop_and_cancels_inflight_launch() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let current = uuid::Uuid::new_v4();
        state.node_plugin_processes.lock().insert(
            "demo".into(),
            NodePluginProcessState::Launching {
                generation: current,
            },
        );

        assert!(
            !stop_node_plugin_process(&state, "demo", Some(uuid::Uuid::new_v4()))
                .await
                .unwrap()
        );
        assert!(state.node_plugin_processes.lock().contains_key("demo"));
        assert!(stop_node_plugin_process(&state, "demo", Some(current))
            .await
            .unwrap());
        assert!(!state.node_plugin_processes.lock().contains_key("demo"));
    }

    #[tokio::test]
    async fn node_plugin_snapshot_reports_launching_hosts_without_a_pid() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        assert!(node_plugin_snapshot(&state).is_empty());

        state.node_plugin_processes.lock().insert(
            "demo".into(),
            NodePluginProcessState::Launching {
                generation: uuid::Uuid::new_v4(),
            },
        );
        let snapshot = node_plugin_snapshot(&state);
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].plugin_id, "demo");
        assert!(snapshot[0].launching);
        assert_eq!(snapshot[0].pid, None);
    }

    #[tokio::test]
    async fn stop_all_node_plugins_empties_the_registry() {
        // The app-exit teardown depends on this: these hosts are long-lived
        // children with no other shutdown path.
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        for id in ["a", "b", "c"] {
            state.node_plugin_processes.lock().insert(
                id.into(),
                NodePluginProcessState::Launching {
                    generation: uuid::Uuid::new_v4(),
                },
            );
        }
        stop_all_node_plugins(&state).await;
        assert!(state.node_plugin_processes.lock().is_empty());
        assert!(node_plugin_snapshot(&state).is_empty());
    }

    #[tokio::test]
    async fn spawn_failure_clears_reservation_for_retry() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let first = uuid::Uuid::new_v4();
        state.node_plugin_processes.lock().insert(
            "demo".into(),
            NodePluginProcessState::Launching { generation: first },
        );

        assert!(spawn_reserved_node_process(
            &state,
            "demo",
            first,
            &tmp.path().join("missing-node"),
            &[],
            tmp.path(),
        )
        .is_err());
        assert!(!state.node_plugin_processes.lock().contains_key("demo"));

        let retry = uuid::Uuid::new_v4();
        state.node_plugin_processes.lock().insert(
            "demo".into(),
            NodePluginProcessState::Launching { generation: retry },
        );
        assert!(state
            .node_plugin_processes
            .lock()
            .get("demo")
            .is_some_and(|process| generation_matches(process, retry)));
    }

    #[tokio::test]
    async fn load_then_unload_clears_record() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);

        let snap = plugin_load_inner(
            &state,
            "demo".into(),
            PluginManifestPayload {
                id: "demo".into(),
                version: "1.0.0".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(snap.status, "loaded");
        assert!(state.plugins.read().contains_key("demo"));

        plugin_unload_inner(&state, "demo".into()).await.unwrap();
        assert!(state.plugins.read().is_empty());
    }

    #[tokio::test]
    async fn enable_disable_flips_status() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        plugin_load_inner(
            &state,
            "demo".into(),
            PluginManifestPayload {
                id: "demo".into(),
                version: "1.0.0".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap();
        plugin_enable_inner(&state, "demo".into()).await.unwrap();
        assert_eq!(
            state.plugins.read().get("demo").unwrap().snapshot.status,
            "enabled"
        );
        plugin_disable_inner(&state, "demo".into()).await.unwrap();
        assert_eq!(
            state.plugins.read().get("demo").unwrap().snapshot.status,
            "disabled"
        );
    }

    #[tokio::test]
    async fn set_status_preserves_arbitrary_status() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        plugin_load_inner(
            &state,
            "demo".into(),
            PluginManifestPayload {
                id: "demo".into(),
                version: "1.0.0".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap();
        // The host-neutral entry point preserves non-enable/disable statuses
        // verbatim (not collapsed), which syncBackendStatus relies on.
        plugin_set_status_for_state(&state, "demo".into(), "installed".into()).unwrap();
        assert_eq!(
            state.plugins.read().get("demo").unwrap().snapshot.status,
            "installed"
        );
        plugin_set_status_for_state(&state, "demo".into(), "error".into()).unwrap();
        assert_eq!(
            state.plugins.read().get("demo").unwrap().snapshot.status,
            "error"
        );
    }

    #[tokio::test]
    async fn flip_status_unknown_plugin_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // flip_status stays strict — explicit enable/disable on an unknown
        // plugin is a real error.
        let err = flip_status(&state, "missing", "enabled").unwrap_err();
        assert!(matches!(err, PluginError::NotFound(_)));
    }

    #[tokio::test]
    async fn upsert_status_seeds_unknown_plugin() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // A browser built-in / disk-scanned plugin the backend never loaded:
        // syncBackendStatus must seed it rather than fail with NotFound.
        upsert_status(&state, "cognia-deep-research", "enabled").unwrap();
        let plugins = state.plugins.read();
        let record = plugins.get("cognia-deep-research").unwrap();
        assert_eq!(record.snapshot.status, "enabled");
        assert_eq!(record.snapshot.plugin_id, "cognia-deep-research");
        // No directory is created on disk for a seeded built-in.
        assert!(!state.plugin_dir("cognia-deep-research").exists());
    }

    #[tokio::test]
    async fn upsert_status_preserves_existing_metadata() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        plugin_load_inner(
            &state,
            "demo".into(),
            PluginManifestPayload {
                id: "demo".into(),
                version: "2.3.4".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap();
        // Upserting an already-loaded plugin only flips status; version and
        // install_path from the real load are not clobbered.
        upsert_status(&state, "demo", "disabled").unwrap();
        let plugins = state.plugins.read();
        let record = plugins.get("demo").unwrap();
        assert_eq!(record.snapshot.status, "disabled");
        assert_eq!(record.snapshot.version, "2.3.4");
    }

    #[tokio::test]
    async fn manifest_id_mismatch_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let err = plugin_load_inner(
            &state,
            "expected".into(),
            PluginManifestPayload {
                id: "other".into(),
                version: "1.0.0".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::InvalidManifest(_)));
    }

    #[tokio::test]
    async fn install_writes_manifest_and_uninstall_removes_dir() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let snap = plugin_install_inner(
            &state,
            "demo".into(),
            "local".into(),
            InstallPayload {
                manifest_json: Some(
                    r#"{"id":"demo","version":"2.0.0","type":"frontend","main":"index.js"}"#.into(),
                ),
            },
        )
        .await
        .unwrap();
        assert_eq!(snap.version, "2.0.0");
        let manifest_path = tmp.path().join("demo").join("manifest.json");
        assert!(manifest_path.exists());
        let host_state = state.plugin_host_state_dir("demo");
        std::fs::create_dir_all(&host_state).unwrap();
        std::fs::write(host_state.join("permissions.json"), "[]").unwrap();

        plugin_uninstall_inner(&state, "demo".into()).await.unwrap();
        assert!(!tmp.path().join("demo").exists());
        assert!(!host_state.exists());
        assert!(state.plugins.read().is_empty());
    }

    #[tokio::test]
    async fn install_without_manifest_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // A manifest-less install would create a phantom plugin dir; reject it
        // and leave no directory behind.
        let err = plugin_install_inner(
            &state,
            "demo".into(),
            "local".into(),
            InstallPayload {
                manifest_json: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::InvalidManifest(_)));
        assert!(!tmp.path().join("demo").exists());
        assert!(state.plugins.read().is_empty());
    }

    #[tokio::test]
    async fn install_manifest_id_mismatch_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let err = plugin_install_inner(
            &state,
            "expected".into(),
            "local".into(),
            InstallPayload {
                manifest_json: Some(
                    r#"{"id":"other","version":"1.0.0","type":"frontend","main":"index.js"}"#
                        .into(),
                ),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::InvalidManifest(_)));
        assert!(!tmp.path().join("expected").exists());
    }

    #[tokio::test]
    async fn install_malformed_manifest_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let err = plugin_install_inner(
            &state,
            "demo".into(),
            "local".into(),
            InstallPayload {
                manifest_json: Some("{not json".into()),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::InvalidManifest(_)));
    }

    #[tokio::test]
    async fn install_empty_version_rejected() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let err = plugin_install_inner(
            &state,
            "demo".into(),
            "local".into(),
            InstallPayload {
                manifest_json: Some(
                    r#"{"id":"demo","version":"  ","type":"frontend","main":"index.js"}"#.into(),
                ),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::InvalidManifest(_)));
    }

    #[tokio::test]
    async fn set_state_persists_and_get_state_reads_back() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        plugin_load_inner(
            &state,
            "demo".into(),
            PluginManifestPayload {
                id: "demo".into(),
                version: "1.0.0".into(),
                name: None,
                description: None,
            },
        )
        .await
        .unwrap();
        let blob = serde_json::json!({ "answer": 42 });
        plugin_set_state_inner(&state, "demo".into(), blob.clone())
            .await
            .unwrap();
        assert!(tmp.path().join("demo").join("state.json").exists());
        let read_back = plugin_get_state_inner(&state, "demo".into()).await.unwrap();
        assert_eq!(read_back, blob);
    }

    // -- async-mirror helpers so tests don't construct a `tauri::State` --
    async fn plugin_load_inner(
        state: &PluginRuntimeState,
        plugin_id: String,
        manifest: PluginManifestPayload,
    ) -> Result<PluginRuntimeSnapshot> {
        if manifest.id != plugin_id {
            return Err(PluginError::InvalidManifest(format!(
                "manifest.id={} does not match plugin_id={}",
                manifest.id, plugin_id
            )));
        }
        let install_path = state.plugin_dir(&plugin_id);
        fs::create_dir_all(&install_path)?;
        let snapshot = PluginRuntimeSnapshot {
            plugin_id: plugin_id.clone(),
            version: manifest.version.clone(),
            status: "loaded".into(),
            last_error: None,
            loaded_at: Some(Utc::now().to_rfc3339()),
            install_path: install_path.to_string_lossy().into_owned(),
        };
        let runtime_state = read_state_file(state, &plugin_id).unwrap_or(serde_json::Value::Null);
        state.plugins.write().insert(
            plugin_id,
            PluginRecord {
                snapshot: snapshot.clone(),
                runtime_state,
            },
        );
        Ok(snapshot)
    }

    async fn plugin_enable_inner(state: &PluginRuntimeState, plugin_id: String) -> Result<()> {
        flip_status(state, &plugin_id, "enabled")
    }
    async fn plugin_disable_inner(state: &PluginRuntimeState, plugin_id: String) -> Result<()> {
        flip_status(state, &plugin_id, "disabled")
    }
    async fn plugin_unload_inner(state: &PluginRuntimeState, plugin_id: String) -> Result<()> {
        state.plugins.write().remove(&plugin_id);
        Ok(())
    }
    async fn plugin_install_inner(
        state: &PluginRuntimeState,
        plugin_id: String,
        _source: String,
        payload: InstallPayload,
    ) -> Result<PluginRuntimeSnapshot> {
        if plugin_id.trim().is_empty() {
            return Err(PluginError::InvalidArgument("plugin_id is empty".into()));
        }
        // Mirror production: validate the manifest before any disk write.
        let version = validate_install_manifest(&plugin_id, &payload)?;
        let install_path = state.plugin_dir(&plugin_id);
        fs::create_dir_all(&install_path)?;
        if let Some(manifest_json) = payload.manifest_json.as_ref() {
            fs::write(install_path.join("manifest.json"), manifest_json.as_bytes())?;
        }
        let snapshot = PluginRuntimeSnapshot {
            plugin_id: plugin_id.clone(),
            version,
            status: "installed".into(),
            last_error: None,
            loaded_at: Some(Utc::now().to_rfc3339()),
            install_path: install_path.to_string_lossy().into_owned(),
        };
        state.plugins.write().insert(
            plugin_id,
            PluginRecord {
                snapshot: snapshot.clone(),
                runtime_state: serde_json::Value::Null,
            },
        );
        Ok(snapshot)
    }
    async fn plugin_uninstall_inner(state: &PluginRuntimeState, plugin_id: String) -> Result<()> {
        let install_path = state.plugin_dir(&plugin_id);
        let host_state_path = state.plugin_host_state_dir(&plugin_id);
        if install_path.exists() {
            fs::remove_dir_all(&install_path)?;
        }
        if host_state_path.exists() {
            fs::remove_dir_all(&host_state_path)?;
        }
        state.plugins.write().remove(&plugin_id);
        state.permissions.write().remove(&plugin_id);
        Ok(())
    }
    async fn plugin_set_state_inner(
        state: &PluginRuntimeState,
        plugin_id: String,
        state_blob: serde_json::Value,
    ) -> Result<()> {
        write_state_file(state, &plugin_id, &state_blob)?;
        if let Some(record) = state.plugins.write().get_mut(&plugin_id) {
            record.runtime_state = state_blob;
        }
        Ok(())
    }
    async fn plugin_get_state_inner(
        state: &PluginRuntimeState,
        plugin_id: String,
    ) -> Result<serde_json::Value> {
        if let Some(record) = state.plugins.read().get(&plugin_id) {
            return Ok(record.runtime_state.clone());
        }
        read_state_file(state, &plugin_id)
    }
}
