//! Declarative sync-table registry (Wave 3.5).
//!
//! Replaces the hardcoded `const ALLOWED: &[&str] = &[...]` allowlist
//! that the `sync_pull` RPC walked. Plugins or future internal modules
//! can call [`SyncTableRegistry::register`] at boot to expose their own
//! Dexie tables to the mobile sync surface — without a Rust code edit
//! and a rebuild.
//!
//! # Default tables
//!
//! [`SyncTableRegistry::with_defaults`] seeds the registry with the
//! Wave 1 base tables plus the Wave 2 additions. Anything beyond that
//! must register at startup before the HTTP server starts.
//!
//! # Concurrency
//!
//! The registry is `RwLock`-protected so multiple readers can probe
//! `contains` without contention. Writes (registration) are expected
//! at boot only, before the server takes its first request.

use parking_lot::RwLock;
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct SyncTableDescriptor {
    pub name: String,
    /// Free-form summary surfaced by the new `sync_list_tables` RPC.
    pub description: String,
    /// Whether the desktop projector tracks tombstones for this table.
    pub has_tombstones: bool,
}

pub struct SyncTableRegistry {
    inner: RwLock<BTreeMap<String, SyncTableDescriptor>>,
}

impl SyncTableRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(BTreeMap::new()),
        })
    }

    pub fn with_defaults() -> Arc<Self> {
        let registry = Self::new();
        for d in default_tables() {
            registry.register(d);
        }
        registry
    }

    pub fn register(&self, descriptor: SyncTableDescriptor) {
        let mut inner = self.inner.write();
        inner.insert(descriptor.name.clone(), descriptor);
    }

    pub fn contains(&self, name: &str) -> bool {
        self.inner.read().contains_key(name)
    }

    pub fn list(&self) -> Vec<SyncTableDescriptor> {
        self.inner.read().values().cloned().collect()
    }
}

fn default_tables() -> Vec<SyncTableDescriptor> {
    vec![
        SyncTableDescriptor {
            name: "characters".to_string(),
            description: "AI characters (read-only mirror; mobile creates/edits via mutating RPC)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "skills".to_string(),
            description: "Installed skill manifests".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "sessions".to_string(),
            description: "Chat sessions (newest 200 by updatedAt)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "messages".to_string(),
            description: "Stored chat messages (newest 200 by createdAt)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "workflows".to_string(),
            description: "Visual workflow definitions (read-only viewer on mobile)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "twinProfile".to_string(),
            description: "Distilled twin profiles for the mobile twin switcher".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "plugins".to_string(),
            description: "Installed plugins (toggle from mobile via plugin_set_enabled)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "adapterInstances".to_string(),
            description: "Connector adapter instances (policy editable from mobile)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "settings".to_string(),
            description: "AppSettings singleton row (mobile may patch a allowlisted subset)".to_string(),
            has_tombstones: false,
        },
        // v49 — per-conversation overrides (pinned / archived / lastReadAt /
        // allowComputerUse / allowGoalDriving / mode / character / quietHours).
        // Mirrors the desktop view of the override row so the mobile Inbox
        // renders pinned/unread/archived buckets correctly when offline.
        SyncTableDescriptor {
            name: "conversationOverrides".to_string(),
            description: "Per-conversation Inbox overrides (pinned, archived, lastReadAt, allowComputerUse, allowGoalDriving, mode)".to_string(),
            has_tombstones: false,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_registry_seeds_known_tables() {
        let r = SyncTableRegistry::with_defaults();
        assert!(r.contains("characters"));
        assert!(r.contains("workflows"));
        assert!(r.contains("settings"));
        assert!(!r.contains("ohai"));
    }

    #[test]
    fn register_adds_a_new_table() {
        let r = SyncTableRegistry::with_defaults();
        assert!(!r.contains("widgets"));
        r.register(SyncTableDescriptor {
            name: "widgets".to_string(),
            description: "Plugin-defined widgets table".to_string(),
            has_tombstones: false,
        });
        assert!(r.contains("widgets"));
    }

    #[test]
    fn list_returns_descriptors_sorted_by_name() {
        let r = SyncTableRegistry::new();
        r.register(SyncTableDescriptor {
            name: "z".to_string(),
            description: "z".to_string(),
            has_tombstones: false,
        });
        r.register(SyncTableDescriptor {
            name: "a".to_string(),
            description: "a".to_string(),
            has_tombstones: false,
        });
        let names: Vec<String> = r.list().into_iter().map(|d| d.name).collect();
        assert_eq!(names, vec!["a".to_string(), "z".to_string()]);
    }
}
