//! VS Code extension host (Rust side).
//!
//! Spawns the Node sidecar (`sidecar/vscode-ext-host/dist/host.js`) per
//! extension, tells it which sensitive Node modules the extension's
//! permissions allow (`commands.rs:granted_node_modules`; the sidecar's
//! require hook enforces them), and routes JSON-RPC frames between the
//! renderer and the sidecar.
//!
//! Module layout mirrors `src-tauri/src/plugin_api/wasm/`:
//!
//! - [`host`]              — sidecar lifecycle (spawn / kill / health).
//! - [`installer`]         — `.vsix` extraction + checksum.
//! - [`openvsx_download`]  — Open VSX `.vsix` fetch + SHA-256 verification.
//! - [`commands`]          — `tauri::generate_handler!` entry points.
//!
//! `ExtensionRuntime` is published by the Tauri state but not yet read
//! back — the renderer queries runtime telemetry through the Dexie
//! `vscodeExtensionRuntime` table (schema v31). This module reserves the
//! shape so the Phase M3 wiring can write into it without a schema bump.
#![allow(dead_code)]

pub mod commands;
pub mod host;
pub mod installer;
pub mod memento;
pub mod openvsx_download;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

pub type VscodeEventSink = Arc<dyn Fn(String, String) + Send + Sync + 'static>;

/// Where `.vsix` installs unpack, relative to the data root's `cognia/`.
pub const EXTENSIONS_DIR: &str = "vscode-extensions";
/// Where each extension's storage, Memento and log live, apart from its
/// install so they survive an update or a reinstall.
pub const EXTENSION_STATE_DIR: &str = "vscode-extension-state";

/// The VS Code extension install root for a host whose plugins live in
/// `plugin_install_dir`: its sibling `vscode-extensions`, on every host (the
/// desktop and the headless companion build it this one way).
pub fn extension_install_dir_for(plugin_install_dir: &Path) -> PathBuf {
    plugin_install_dir
        .parent()
        .unwrap_or(plugin_install_dir)
        .join(EXTENSIONS_DIR)
}

/// The state root beside an extension install root.
pub fn extension_state_root_for(extension_install_dir: &Path) -> PathBuf {
    extension_install_dir
        .parent()
        .unwrap_or(extension_install_dir)
        .join(EXTENSION_STATE_DIR)
}

/// One extension's storage directories for one activation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionStoragePaths {
    /// `globalStorageUri`.
    pub global: PathBuf,
    /// `storageUri`: per workspace folder, absent with none open.
    pub workspace: Option<PathBuf>,
    /// `logUri`.
    pub log: PathBuf,
}

impl ExtensionStoragePaths {
    pub fn global_memento(&self) -> PathBuf {
        self.global.join("state.json")
    }
    pub fn workspace_memento(&self) -> Option<PathBuf> {
        self.workspace.as_ref().map(|dir| dir.join("state.json"))
    }
}

/// A short, stable directory name for a workspace folder URI.
pub fn workspace_storage_key(workspace_root: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(workspace_root.as_bytes());
    hex::encode(&digest[..12])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionRuntime {
    pub extension_id: String,
    pub generation: String,
    pub sidecar_pid: u32,
    pub last_activated_at: Option<i64>,
    pub last_error: Option<String>,
    pub registered_commands: Vec<String>,
    pub registered_webview_views: Vec<String>,
    pub registered_language_providers: Vec<String>,
}

pub struct VscodeExtensionState {
    /// One spawned sidecar per loaded extension.
    pub sidecars: Arc<RwLock<HashMap<String, Arc<host::Sidecar>>>>,
    pub runtimes: Arc<RwLock<HashMap<String, ExtensionRuntime>>>,
    pub extension_install_dir: PathBuf,
    /// Server-owned host executable configuration. The desktop wrapper fills
    /// this from the Tauri resource resolver; cognia-server fills it from its
    /// packaged brain layout. Plugin manifests never choose either path.
    pub sidecar_script: RwLock<Option<PathBuf>>,
    pub node_binary: RwLock<Option<String>>,
    /// Host-neutral event bridge for sidecar-initiated JSON-RPC frames.
    pub event_sink: RwLock<Option<VscodeEventSink>>,
}

impl VscodeExtensionState {
    pub fn new(install_dir: PathBuf) -> Self {
        Self {
            sidecars: Arc::new(RwLock::new(HashMap::new())),
            runtimes: Arc::new(RwLock::new(HashMap::new())),
            extension_install_dir: install_dir,
            sidecar_script: RwLock::new(None),
            node_binary: RwLock::new(None),
            event_sink: RwLock::new(None),
        }
    }

    pub fn configure_host(
        &self,
        sidecar_script: PathBuf,
        node_binary: Option<String>,
        event_sink: VscodeEventSink,
    ) {
        *self.sidecar_script.write() = Some(sidecar_script);
        *self.node_binary.write() = node_binary;
        *self.event_sink.write() = Some(event_sink);
    }

    pub fn emit_rpc_frame(&self, event_name: String, raw_frame: String) {
        if let Some(sink) = self.event_sink.read().as_ref().cloned() {
            sink(event_name, raw_frame);
        }
    }

    pub fn extension_dir(&self, extension_id: &str) -> PathBuf {
        self.extension_install_dir
            .join(super::sanitize_plugin_id(extension_id))
    }

    /// `<data>/cognia/vscode-extension-state/<id>`.
    pub fn state_dir(&self, extension_id: &str) -> PathBuf {
        extension_state_root_for(&self.extension_install_dir)
            .join(super::sanitize_plugin_id(extension_id))
    }

    /// The storage directories for one activation, created on disk.
    pub fn storage_paths(
        &self,
        extension_id: &str,
        workspace_root: Option<&str>,
    ) -> std::io::Result<ExtensionStoragePaths> {
        let root = self.state_dir(extension_id);
        let paths = ExtensionStoragePaths {
            global: root.join("global"),
            workspace: workspace_root
                .filter(|root| !root.is_empty())
                .map(|workspace| {
                    root.join("workspace")
                        .join(workspace_storage_key(workspace))
                }),
            log: root.join("log"),
        };
        std::fs::create_dir_all(&paths.global)?;
        std::fs::create_dir_all(&paths.log)?;
        if let Some(workspace) = &paths.workspace {
            std::fs::create_dir_all(workspace)?;
        }
        Ok(paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_state_starts_empty() {
        let state = VscodeExtensionState::new(PathBuf::from("/tmp"));
        assert!(state.sidecars.read().is_empty());
        assert!(state.runtimes.read().is_empty());
        assert!(state.sidecar_script.read().is_none());
        assert!(state.event_sink.read().is_none());
    }

    #[test]
    fn state_lives_beside_the_install_root_and_is_per_workspace() {
        let data = tempfile::tempdir().unwrap();
        let plugins = data.path().join("cognia").join("plugins");
        let installs = extension_install_dir_for(&plugins);
        assert_eq!(installs, data.path().join("cognia").join(EXTENSIONS_DIR));
        let state = VscodeExtensionState::new(installs);
        let first = state
            .storage_paths("acme.tools", Some("file:///work/a"))
            .unwrap();
        let second = state
            .storage_paths("acme.tools", Some("file:///work/b"))
            .unwrap();
        assert_eq!(
            first.global,
            data.path()
                .join("cognia")
                .join(EXTENSION_STATE_DIR)
                .join("acme.tools")
                .join("global")
        );
        assert!(first.global.is_dir() && first.log.is_dir());
        assert_ne!(first.workspace, second.workspace);
        assert!(first.workspace.as_ref().unwrap().is_dir());
        assert_eq!(
            state.storage_paths("acme.tools", None).unwrap().workspace,
            None
        );
        assert_eq!(
            state
                .storage_paths("acme.tools", Some(""))
                .unwrap()
                .workspace,
            None
        );
    }

    #[test]
    fn extension_dir_is_sanitized() {
        let state = VscodeExtensionState::new(PathBuf::from("/tmp"));
        let dir = state.extension_dir("../boom");
        assert_eq!(dir.file_name().unwrap(), ".._boom");
    }

    #[test]
    fn configured_event_sink_receives_namespaced_raw_frames() {
        let state = VscodeExtensionState::new(PathBuf::from("/tmp"));
        let received = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let received_for_sink = Arc::clone(&received);
        state.configure_host(
            PathBuf::from("/opt/cognia/vscode-ext-host/dist/host.js"),
            Some("node22".to_string()),
            Arc::new(move |event, frame| received_for_sink.lock().push((event, frame))),
        );
        state.emit_rpc_frame(
            "vscode://rpc/demo_ext".into(),
            "{\"jsonrpc\":\"2.0\"}".into(),
        );

        assert_eq!(
            received.lock().as_slice(),
            &[(
                "vscode://rpc/demo_ext".to_string(),
                "{\"jsonrpc\":\"2.0\"}".to_string()
            )]
        );
        assert_eq!(state.node_binary.read().as_deref(), Some("node22"));
    }
}
