//! VS Code extension host (Rust side).
//!
//! Spawns the Node sidecar (`sidecar/vscode-ext-host/dist/host.js`) per
//! extension, mediates `child_process`, file, and network capability
//! grants, and routes JSON-RPC frames between the renderer and the
//! sidecar.
//!
//! Module layout mirrors `src-tauri/src/plugin_api/wasm/`:
//!
//! - [`host`]              — sidecar lifecycle (spawn / kill / health).
//! - [`installer`]         — `.vsix` extraction + checksum.
//! - [`openvsx_download`]  — Open VSX `.vsix` fetch + SHA-256 verification.
//! - [`commands`]          — `tauri::generate_handler!` entry points.
//! - [`capabilities`]      — per-extension file path / process / network gates.
//!
//! `ExtensionRuntime` is published by the Tauri state but not yet read
//! back — the renderer queries runtime telemetry through the Dexie
//! `vscodeExtensionRuntime` table (schema v31). This module reserves the
//! shape so the Phase M3 wiring can write into it without a schema bump.
#![allow(dead_code)]

pub mod capabilities;
pub mod commands;
pub mod host;
pub mod installer;
pub mod openvsx_download;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

pub type VscodeEventSink = Arc<dyn Fn(String, String) + Send + Sync + 'static>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionRuntime {
    pub extension_id: String,
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
