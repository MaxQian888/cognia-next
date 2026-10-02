//! Which paired devices may reach which workbench through `/ide/relay/{id}`.
//!
//! A relay id is an opaque, unguessable path segment bound to one workbench
//! *instance*: its canonical root and the generation of the process serving
//! it. A respawn is a new generation, so every id minted for the old process
//! stops resolving the moment it is replaced — a stale id can never route to
//! whatever later listens on the old port. Devices are admitted to an id one
//! by one; nothing else is reachable through it.
//!
//! The table is policy-free. Whether a device may be admitted at all (a
//! control grant, the desktop's per-project approval) is the owner's question,
//! asked before [`RelayTable::admit`] and again on every request.

use std::collections::{HashMap, HashSet};

use uuid::Uuid;

/// The companion path a relay id is served under.
pub fn relay_path(relay_id: &str) -> String {
    format!("/ide/relay/{relay_id}/")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayEntry {
    root: String,
    generation: u64,
    devices: HashSet<String>,
}

/// The instance a relay id names, as resolved for one device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayTarget {
    pub root: String,
    pub generation: u64,
}

#[derive(Debug, Default)]
pub struct RelayTable {
    by_id: HashMap<String, RelayEntry>,
}

impl RelayTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Admit `device` to the instance `(root, generation)` and return its
    /// relay id. One id per instance: a second device joins the same id, and
    /// ids minted for an older generation of `root` are dropped.
    pub fn admit(&mut self, root: &str, generation: u64, device: &str) -> String {
        self.by_id
            .retain(|_, entry| entry.root != root || entry.generation == generation);
        if let Some((id, entry)) = self
            .by_id
            .iter_mut()
            .find(|(_, entry)| entry.root == root && entry.generation == generation)
        {
            entry.devices.insert(device.to_string());
            return id.clone();
        }
        let id = Uuid::new_v4().simple().to_string();
        self.by_id.insert(
            id.clone(),
            RelayEntry {
                root: root.to_string(),
                generation,
                devices: HashSet::from([device.to_string()]),
            },
        );
        id
    }

    /// The instance `relay_id` names, if `device` was admitted to it.
    pub fn resolve(&self, relay_id: &str, device: &str) -> Option<RelayTarget> {
        let entry = self.by_id.get(relay_id)?;
        entry.devices.contains(device).then(|| RelayTarget {
            root: entry.root.clone(),
            generation: entry.generation,
        })
    }

    /// The id `device` already holds for `(root, generation)`, if any.
    pub fn id_for(&self, root: &str, generation: u64, device: &str) -> Option<String> {
        self.by_id
            .iter()
            .find(|(_, entry)| {
                entry.root == root
                    && entry.generation == generation
                    && entry.devices.contains(device)
            })
            .map(|(id, _)| id.clone())
    }

    /// Forget every id for `root` (its instance stopped or was replaced).
    pub fn revoke_root(&mut self, root: &str) {
        self.by_id.retain(|_, entry| entry.root != root);
    }

    /// Withdraw `device` from `root`'s ids (its grant for that root was revoked).
    pub fn revoke_device_root(&mut self, device: &str, root: &str) {
        for entry in self.by_id.values_mut().filter(|entry| entry.root == root) {
            entry.devices.remove(device);
        }
        self.by_id.retain(|_, entry| !entry.devices.is_empty());
    }

    /// Withdraw `device` everywhere (it was unpaired).
    pub fn revoke_device(&mut self, device: &str) {
        for entry in self.by_id.values_mut() {
            entry.devices.remove(device);
        }
        self.by_id.retain(|_, entry| !entry.devices.is_empty());
    }

    /// Drop the id `relay_id` (its instance turned out to be gone).
    pub fn forget(&mut self, relay_id: &str) {
        self.by_id.remove(relay_id);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.by_id.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_resolves_only_for_the_devices_admitted_to_it() {
        let mut table = RelayTable::new();
        let id = table.admit("/w", 1, "phone");
        assert_eq!(id.len(), 32);
        assert_eq!(
            table.resolve(&id, "phone"),
            Some(RelayTarget {
                root: "/w".into(),
                generation: 1
            })
        );
        assert_eq!(table.resolve(&id, "laptop"), None);
        assert_eq!(table.resolve("guess", "phone"), None);
    }

    #[test]
    fn one_instance_has_one_id_that_several_devices_join() {
        let mut table = RelayTable::new();
        let first = table.admit("/w", 1, "phone");
        let second = table.admit("/w", 1, "laptop");
        assert_eq!(first, second);
        assert!(table.resolve(&first, "laptop").is_some());
        assert_eq!(table.id_for("/w", 1, "laptop"), Some(first.clone()));
        assert_eq!(table.id_for("/w", 2, "laptop"), None);
        let other = table.admit("/v", 1, "phone");
        assert_ne!(other, first);
    }

    #[test]
    fn a_respawn_drops_every_id_minted_for_the_old_process() {
        let mut table = RelayTable::new();
        let old = table.admit("/w", 1, "phone");
        let new = table.admit("/w", 2, "phone");
        assert_ne!(old, new);
        assert_eq!(table.resolve(&old, "phone"), None);
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn revocation_by_root_by_grant_and_by_device() {
        let mut table = RelayTable::new();
        let w = table.admit("/w", 1, "phone");
        table.admit("/w", 1, "laptop");
        let v = table.admit("/v", 1, "phone");

        table.revoke_device_root("phone", "/w");
        assert_eq!(table.resolve(&w, "phone"), None);
        assert!(table.resolve(&w, "laptop").is_some());
        assert!(table.resolve(&v, "phone").is_some());

        table.revoke_device("phone");
        assert_eq!(table.resolve(&v, "phone"), None);
        assert_eq!(table.len(), 1, "an id nobody may use is dropped");

        table.revoke_root("/w");
        assert_eq!(table.len(), 0);

        let id = table.admit("/w", 3, "phone");
        table.forget(&id);
        assert_eq!(table.resolve(&id, "phone"), None);
    }
}
