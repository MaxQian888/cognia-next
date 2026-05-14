//! VS Code extension host (Rust side).
//!
//! Spawns the Node sidecar (`sidecars/vscode-ext-host/dist/host.cjs`) per
//! extension, mediates `child_process`, file, and network capability
//! grants, and routes JSON-RPC frames between the renderer and the
//! sidecar.
//!
//! Module layout mirrors `src-tauri/src/plugin_api/wasm/`:
//!
//! - [`host`]         — sidecar lifecycle (spawn / kill / health).
//! - [`installer`]    — `.vsix` extraction + checksum.
//! - [`commands`]     — `tauri::generate_handler!` entry points.
//! - [`capabilities`] — per-extension file path / process / network gates.
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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

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
    pub sidecars: Arc<RwLock<HashMap<String, host::Sidecar>>>,
    pub runtimes: Arc<RwLock<HashMap<String, ExtensionRuntime>>>,
    pub extension_install_dir: PathBuf,
}

impl VscodeExtensionState {
    pub fn new(install_dir: PathBuf) -> Self {
        Self {
            sidecars: Arc::new(RwLock::new(HashMap::new())),
            runtimes: Arc::new(RwLock::new(HashMap::new())),
            extension_install_dir: install_dir,
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
    }

    #[test]
    fn extension_dir_is_sanitized() {
        let state = VscodeExtensionState::new(PathBuf::from("/tmp"));
        let dir = state.extension_dir("../boom");
        assert_eq!(dir.file_name().unwrap(), ".._boom");
    }
}
