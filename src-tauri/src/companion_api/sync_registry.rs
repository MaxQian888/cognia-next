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
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "skills".to_string(),
            description: "Installed skill manifests".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "sessions".to_string(),
            description: "Chat sessions (incremental by updatedAt; deletions via tombstones)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "messages".to_string(),
            description: "Stored chat messages (paged by createdAt; deletions via tombstones)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "workflows".to_string(),
            description: "Visual workflow definitions (read-only viewer on mobile; deletions via tombstones)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "workflowRuns".to_string(),
            description: "Workflow run history (read-only; cursors on max(startedAt, completedAt) so the mobile library badges + runs feed reflect desktop-executed runs)".to_string(),
            // Runs are append-mostly; deletions are not tombstoned (the mobile
            // runs viewer accumulates and ages them out of the recent feed).
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
        // Companion read-mostly views. Both have desktop sync readers
        // (`readGoalsDelta` / `readMemoriesDelta`) and TS handlers, but were
        // never added to this allowlist — so `sync_pull` rejected them with
        // "not exposed to mobile sync" and the mobile Goals console / memory
        // viewer stayed empty. Same omission class as the workflowRuns gap.
        SyncTableDescriptor {
            name: "goals".to_string(),
            description: "Goal console rows (read-only mirror; goals are authored on the desktop)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "memories".to_string(),
            description: "Long-term memory rows (read-only mirror for the mobile memory viewer)".to_string(),
            has_tombstones: false,
        },
        // ADR-0056 (Wave 4) — configured MCP servers. Read-only mirror so the
        // mobile `/me/mcp` page lists the desktop's servers; the phone has no
        // MCP push RPC and the standalone engine runs no MCP, so it never
        // writes back.
        SyncTableDescriptor {
            name: "mcpServers".to_string(),
            description: "Configured MCP servers (read-only mirror for the mobile /me/mcp viewer)".to_string(),
            has_tombstones: false,
        },
        // ADR-0039 (phase 2) — durable terminal command history. One-way
        // read-only mirror; the phone has no shell so it never writes back.
        // The desktop projector cursors on `ts` (no updatedAt/createdAt on the
        // row), and prune-deletions are not tombstoned (rows age out passively
        // on the phone), same omission class as mcpServers/settings.
        SyncTableDescriptor {
            name: "terminalHistory".to_string(),
            description: "Durable terminal command history (read-only mirror for the mobile /me/command-history viewer)".to_string(),
            has_tombstones: false,
        },
        // v104 — Agent-Team board projection (team-board CQRS). One-way mirror
        // of the desktop task board (task rows + team-meta rows) so the mobile
        // workspace renders the kanban offline; edits travel back as the
        // `team_task_*` / `team_run_*` control RPCs, never as data writes.
        // Task/team deletions are tombstoned by the desktop projector.
        SyncTableDescriptor {
            name: "agentTeamBoard".to_string(),
            description: "Agent-Team task board projection (read-only mirror; controls go through team_* RPCs)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "agentTasks".to_string(),
            description: "Single-Agent task metadata (read-only mirror; controls go through agent task RPCs)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "agentTaskAttempts".to_string(),
            description: "Immutable Single-Agent task attempts (read-only mirror)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "templateDefinitions".to_string(),
            description: "Portable template definitions (read-only mobile catalog projection)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "templatePackages".to_string(),
            description: "Template package metadata and trust (no assets or device bindings)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "templateInstances".to_string(),
            description: "Template instance provenance and update baselines".to_string(),
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
        assert!(r.contains("workflowRuns"));
        assert!(r.contains("goals"));
        assert!(r.contains("memories"));
        assert!(r.contains("mcpServers"));
        assert!(r.contains("terminalHistory"));
        assert!(r.contains("settings"));
        assert!(r.contains("agentTeamBoard"));
        assert!(r.contains("agentTasks"));
        assert!(r.contains("agentTaskAttempts"));
        assert!(r.contains("templateDefinitions"));
        assert!(r.contains("templatePackages"));
        assert!(r.contains("templateInstances"));
        assert_eq!(r.list().len(), 21);
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
