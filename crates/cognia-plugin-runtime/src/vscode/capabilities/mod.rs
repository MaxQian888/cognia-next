//! Per-extension capability gates.
//!
//! Three independent files map to the three Node modules the sidecar's
//! require-hook gates: filesystem (file.rs), child_process (process.rs),
//! and network (network.rs). Each gate inspects an `(extension_id,
//! operation)` pair and returns allow/deny.
//!
//! The gates consult cognia's existing permission-guard ledger via the
//! plugin_api permission tables — VS Code extensions reuse the same
//! storage as every other plugin type. Per-extension allowlists live in
//! [`CapabilityStore`].
//!
//! `dead_code` is silenced module-wide: the gate-call sites are added in
//! Phase M3 once the sidecar's require-hook starts emitting
//! `permission:request` RPCs. The shape (struct fields, decision enums,
//! allowlist mutators) is finalised now so M3 only adds wiring.
#![allow(dead_code)]

pub mod file;
pub mod network;
pub mod process;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CapabilityGrants {
    pub allowed_file_paths: Vec<PathBuf>,
    pub allowed_spawn_commands: Vec<String>,
    pub allowed_network_hosts: Vec<String>,
}

pub struct CapabilityStore {
    /// Keyed by extension id.
    grants: Arc<RwLock<HashMap<String, CapabilityGrants>>>,
}

impl CapabilityStore {
    pub fn new() -> Self {
        Self {
            grants: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn get(&self, extension_id: &str) -> CapabilityGrants {
        self.grants
            .read()
            .get(extension_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn add_file_path(&self, extension_id: &str, path: PathBuf) {
        let mut map = self.grants.write();
        map.entry(extension_id.to_string())
            .or_default()
            .allowed_file_paths
            .push(path);
    }

    pub fn add_spawn_command(&self, extension_id: &str, command: String) {
        let mut map = self.grants.write();
        map.entry(extension_id.to_string())
            .or_default()
            .allowed_spawn_commands
            .push(command);
    }

    pub fn add_network_host(&self, extension_id: &str, host: String) {
        let mut map = self.grants.write();
        map.entry(extension_id.to_string())
            .or_default()
            .allowed_network_hosts
            .push(host);
    }

    pub fn revoke(&self, extension_id: &str) {
        self.grants.write().remove(extension_id);
    }
}

impl Default for CapabilityStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_store_round_trips_grants() {
        let store = CapabilityStore::new();
        store.add_file_path("ext.a", PathBuf::from("/tmp/foo"));
        store.add_spawn_command("ext.a", "node".to_string());
        store.add_network_host("ext.a", "example.com".to_string());
        let g = store.get("ext.a");
        assert_eq!(g.allowed_file_paths, vec![PathBuf::from("/tmp/foo")]);
        assert_eq!(g.allowed_spawn_commands, vec!["node".to_string()]);
        assert_eq!(g.allowed_network_hosts, vec!["example.com".to_string()]);
        store.revoke("ext.a");
        assert!(store.get("ext.a").allowed_file_paths.is_empty());
    }
}
