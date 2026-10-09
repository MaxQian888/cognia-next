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
            has_tombstones: true,
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
            // Runs are append-mostly, but a user can delete one (or every run
            // of a deleted workflow), and those deletes are tombstoned.
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "executionRuns".to_string(),
            description: "Canonical execution summaries (read-only remote-safe projection; private event rows remain on the executing host)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "twinProfile".to_string(),
            description: "Distilled twin profiles for the mobile twin switcher".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "twins".to_string(),
            // The switcher above had nothing to switch between: there is no
            // `twin_list` command, so a paired device could not enumerate the
            // registry at all and the whole `/discover` Twin section rendered
            // its empty state.
            description: "Twin registry (read-only mirror; ingest and review travel back as twin_* RPCs)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "twinDrafts".to_string(),
            description: "Distilled drafts awaiting review (cursor is max(createdAt, reviewedAt); the review verdict travels back as twin_draft_review)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "projects".to_string(),
            // The scope every issue read filters on. `activeProjectId` is
            // device-local, so a phone resolves it to the literal
            // `project-default` and its workspace switcher listed only the row
            // it auto-created, which left the board empty even once `issues`
            // mirrored. Date fields cross as epoch ms and are revived on write.
            description: "Workspaces (read-only mirror; the phone picks its own active one locally)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "issues".to_string(),
            description: "Issue tracker items (read-only board; no issue_* command exists, so sync is the only path)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "issueProjects".to_string(),
            description: "Delivery containers the board groups by".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "labels".to_string(),
            // Without these every LabelChip renders an unresolved id.
            description: "Label catalogue for the issue board and the inbox".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "issueEvents".to_string(),
            // Comments live in this table too (`kind: "commented"`), so the
            // trail and the discussion are one timeline.
            description: "Issue activity trail (append-only, cursored on ts; deleted with the issue it belongs to)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "issueRuns".to_string(),
            description: "Issue dispatch history (settled in place, so cursored on updatedAt)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "issueCycles".to_string(),
            description: "Cycles and milestones the board plans issues into (edited in place, cursored on updatedAt)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "plugins".to_string(),
            description: "Installed plugins (toggle from mobile via plugin_set_enabled)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "pluginCogsets".to_string(),
            description: "Cogsets: named plugin sets, read-only (switch via plugin_cogset_activate)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "pluginCogsetState".to_string(),
            description: "The host's cogset state: which cogset runs, always-on plugins, a pending switch".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "adapterInstances".to_string(),
            description: "Connector adapter instances (policy editable from mobile)".to_string(),
            has_tombstones: true,
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
            has_tombstones: true,
        },
        // Per-session unread pointers. The mobile Chat tab badge and the
        // Inbox dot both counted `inboundLedger`, a host-only dedupe ledger
        // that never syncs, so both read 0 on every paired device. This is the
        // table the desktop's own unread badges read.
        //
        // The session-delete cascade tombstones the state row next to the
        // session itself (`lib/db/sessions.ts`).
        SyncTableDescriptor {
            name: "sessionState".to_string(),
            description: "Per-session unread pointers (read-only mirror for the mobile Chat badge and Inbox dot)".to_string(),
            has_tombstones: true,
        },
        // Companion read-mostly views. Both have desktop sync readers
        // (`readGoalsDelta` / `readMemoriesDelta`) and TS handlers, but were
        // never added to this allowlist — so `sync_pull` rejected them with
        // "not exposed to mobile sync" and the mobile Goals console / memory
        // viewer stayed empty. Same omission class as the workflowRuns gap.
        SyncTableDescriptor {
            name: "goals".to_string(),
            description: "Goal console rows (read-only mirror; goals are authored on the desktop)".to_string(),
            has_tombstones: true,
        },
        // The goal event log (`chatGoalEvents`) behind a paired phone's goal
        // detail, judge notes and `/goal status`. No tombstones of its own: a
        // deleted goal's `goals` tombstone takes its events on the client, and
        // the per-goal cap is mirrored client-side.
        SyncTableDescriptor {
            name: "goalEvents".to_string(),
            description: "Goal lifecycle events (paged on ts + id; a goal tombstone removes its events, the per-goal cap is mirrored client-side; judge_parse_failed.raw is emptied)".to_string(),
            has_tombstones: false,
        },
        // ADR-0045 — AgentPlan rows. The companion mounts the plan approval
        // dock and the step tracker; without this allowlist entry `sync_pull`
        // rejects the table and those surfaces render against an empty local
        // mirror. Plans are authored and executed on the host; the phone
        // approves/controls them through the run-control RPCs, never by
        // writing rows back.
        SyncTableDescriptor {
            name: "plans".to_string(),
            description: "AgentPlan rows (read-only mirror for the companion plan dock / tracker)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "memories".to_string(),
            description: "Long-term memory rows (read-only mirror for the mobile memory viewer)".to_string(),
            has_tombstones: true,
        },
        // ADR-0056 (Wave 4) — configured MCP servers. Read-only mirror so the
        // mobile `/me/mcp` page lists the desktop's servers; the phone has no
        // MCP push RPC and the standalone engine runs no MCP, so it never
        // writes back.
        SyncTableDescriptor {
            name: "mcpServers".to_string(),
            description: "Configured MCP servers (read-only mirror for the mobile /me/mcp viewer)".to_string(),
            has_tombstones: true,
        },
        // ADR-0039 (phase 2) — durable terminal command history. One-way
        // read-only mirror; the phone has no shell so it never writes back.
        // The desktop projector cursors on `ts` (no updatedAt/createdAt on the
        // row), and prune-deletions are not tombstoned (rows age out passively
        // on the phone).
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
        // Saved chat templates. The mobile composer's `/` menu reads this table
        // straight out of the local Dexie, so before it synced a paired phone
        // simply offered nothing there.
        SyncTableDescriptor {
            name: "chatTemplates".to_string(),
            description: "Saved chat templates offered by the composer's `/` menu (read-only mirror; a template created on the client stays local)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "templateDefinitions".to_string(),
            description: "Portable template definitions (read-only mobile catalog projection)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "templatePackages".to_string(),
            description: "Template package metadata and trust (no assets or device bindings)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "templateInstances".to_string(),
            description: "Template instance provenance and update baselines".to_string(),
            has_tombstones: false,
        },
        // v215 Squad definitions. The runs half has synced since v145, so a
        // paired device saw run history for squads it could not name.
        SyncTableDescriptor {
            name: "agentTeams".to_string(),
            description: "Squad definitions (roster and task ids; run history syncs separately)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "agentTeammates".to_string(),
            description: "Squad roster members and their per-teammate configuration".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "agentTeamTasks".to_string(),
            description: "Squad task board entries (definition-side; execution state lives in agentTeamRuns)".to_string(),
            has_tombstones: true,
        },
        // ADR-0131 cross-shell inbox relay.
        SyncTableDescriptor {
            name: "connectorDrafts".to_string(),
            description: "Connector reply drafts awaiting approval (full rows; approve/reject travel back as RPC)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "outboundQueue".to_string(),
            description: "Connector outbound delivery status projection (no message payload; host-owned, never dispatched by the client)".to_string(),
            has_tombstones: true,
        },
        // The Inbox sidebar's host-only tables. Each is read by a surface the
        // thin client mounts, and none had a sync path, so every one of them
        // rendered against an empty mirror. Cursors are per table (see the
        // readers in `lib/sync/desktop-sync-source.ts`).
        SyncTableDescriptor {
            name: "connectorHeartbeats".to_string(),
            description: "Adapter heartbeat snapshots (paged on `at`; the host prunes after 48 h without tombstones and the client ages them out on the same window)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "platformIdentities".to_string(),
            description: "Contact directory for the Inbox profile drawer (cursored on updatedAt, falling back to lastSeenAt; a merge tombstones the absorbed row)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "connectorCallbackBindings".to_string(),
            description: "Interactive-surface callback bindings (cursored on max(createdAt, consumedAt); expire client-side, never dispatched by the client)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "workflowDeployments".to_string(),
            description: "Published workflow deployments per environment (read-only mirror for the Inbox override form; cursored on updatedAt)".to_string(),
            has_tombstones: false,
        },
        SyncTableDescriptor {
            name: "executionRunBindings".to_string(),
            description: "Run-to-conversation delivery bindings behind the Inbox delegation chips (cursored on updatedAt; controls travel back as run RPCs)".to_string(),
            has_tombstones: false,
        },
        // Conversation folders: the sections the sidebar files conversations
        // into. Writes travel back as `folder.*` HostState intents.
        SyncTableDescriptor {
            name: "sessionFolders".to_string(),
            description: "Conversation folders (cursored on updatedAt; a deleted folder tombstones; writes travel back as folder.* HostState intents)".to_string(),
            has_tombstones: true,
        },
        // The Bot control plane. No `bot_*` read command exists, so sync is the
        // only way `/bots` renders anything at all on a paired device.
        SyncTableDescriptor {
            name: "botDefinitions".to_string(),
            description: "Locally authored Bot definitions (full rows; a plugin's live in the registry overlay and never cross)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "botInstallations".to_string(),
            description: "Bot installations as a projection: identity, scope, status and trigger overrides, with config, credential bindings and runner state dropped".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "botEventDeliveries".to_string(),
            description: "Bot delivery status projection (no event envelope, no dedupe key; host-owned, never drained by the client)".to_string(),
            has_tombstones: true,
        },
        // Remote pet care (ADR-0219). The pet lives on the desktop; a paired
        // phone mirrors these read-only and sends every action back as a
        // `pet_*` RPC, so the one controller awards it once. Chat history,
        // Live2D models and sprite packs never cross.
        SyncTableDescriptor {
            name: "petProfile".to_string(),
            description: "The pet singleton as a projection: no account fingerprint (a sentinel stands in) and no proactive counters, with the host-generated bones in mirroredBones; a reset tombstones it".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "petAchievements".to_string(),
            description: "Unlocked pet achievements (cursored on unlockedAt; a reset tombstones them)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "petInventory".to_string(),
            description: "Owned pet items (cursored on updatedAt; an item used up to zero tombstones its row)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "petCharacterBindings".to_string(),
            description: "Per-character pet appearance overrides (wire id is the characterId; edits stay on the desktop)".to_string(),
            has_tombstones: true,
        },
        SyncTableDescriptor {
            name: "petActivityLog".to_string(),
            description: "Pet interaction ledger (cursored on its numeric id; capped at 2000 rows on both sides without tombstones, a reset is recognised by the profile's createdAt)".to_string(),
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
        assert!(r.contains("pluginCogsets"));
        assert!(r.contains("pluginCogsetState"));
        assert!(r.contains("workflowRuns"));
        assert!(r.contains("executionRuns"));
        assert!(r.contains("goals"));
        assert!(r.contains("goalEvents"));
        assert!(r.contains("memories"));
        assert!(r.contains("mcpServers"));
        assert!(r.contains("terminalHistory"));
        assert!(r.contains("settings"));
        assert!(r.contains("agentTeamBoard"));
        assert!(r.contains("agentTasks"));
        assert!(r.contains("agentTaskAttempts"));
        assert!(r.contains("chatTemplates"));
        assert!(r.contains("templateDefinitions"));
        assert!(r.contains("templatePackages"));
        assert!(r.contains("templateInstances"));
        assert!(r.contains("agentTeams"));
        assert!(r.contains("agentTeammates"));
        assert!(r.contains("agentTeamTasks"));
        assert!(r.contains("connectorDrafts"));
        assert!(r.contains("outboundQueue"));
        assert!(r.contains("connectorHeartbeats"));
        assert!(r.contains("platformIdentities"));
        assert!(r.contains("connectorCallbackBindings"));
        assert!(r.contains("workflowDeployments"));
        assert!(r.contains("executionRunBindings"));
        assert!(r.contains("sessionFolders"));
        assert!(r.contains("botDefinitions"));
        assert!(r.contains("botInstallations"));
        assert!(r.contains("botEventDeliveries"));
        assert!(r.contains("petProfile"));
        assert!(r.contains("petAchievements"));
        assert!(r.contains("petInventory"));
        assert!(r.contains("petCharacterBindings"));
        assert!(r.contains("petActivityLog"));
        // Chat history and the model/sprite blobs stay on the host.
        assert!(!r.contains("petConversationV2"));
        assert!(!r.contains("petModels"));
        assert!(!r.contains("petSpritePacks"));
        // No literal total. This was `24` and went stale the moment a table was
        // legitimately added — the same rot `command_manifest.rs` records: a
        // hardcoded inventory count goes red on every correct addition, and a
        // permanently-red test teaches people to ignore it. What the count was
        // ever standing in for is asserted directly instead: `register` keys on
        // the name, so a duplicated descriptor would silently collapse into one
        // row and none of the `contains` checks above would notice.
        let defaults = default_tables();
        assert_eq!(r.list().len(), defaults.len());
        let unique: std::collections::HashSet<&str> =
            defaults.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            unique.len(),
            defaults.len(),
            "duplicate name in default_tables()"
        );
        assert!(!r.contains("ohai"));
    }

    #[test]
    fn user_deletable_tables_carry_tombstones() {
        // A pull only carries rows that still exist, so a table a user can
        // delete from must tombstone or the row outlives its delete on every
        // paired client. `lib/data-governance/table-catalog.ts` declares the
        // strategy per table and the data-governance gate holds the two equal.
        let r = SyncTableRegistry::with_defaults();
        let by_name: std::collections::HashMap<String, bool> = r
            .list()
            .into_iter()
            .map(|d| (d.name, d.has_tombstones))
            .collect();
        for name in [
            "skills",
            "plugins",
            "pluginCogsets",
            "mcpServers",
            "memories",
            "goals",
            "plans",
            "templateDefinitions",
            "templatePackages",
            "agentTeams",
            "agentTeammates",
            "agentTeamTasks",
            "adapterInstances",
            "conversationOverrides",
            "twinProfile",
            "workflowRuns",
            "outboundQueue",
            "botEventDeliveries",
            "sessionState",
            "petProfile",
            "petAchievements",
            "petInventory",
            "petCharacterBindings",
        ] {
            assert_eq!(by_name.get(name), Some(&true), "{name} must tombstone");
        }
        for name in [
            "settings",
            "terminalHistory",
            "connectorHeartbeats",
            "executionRuns",
            "petActivityLog",
            // A deleted goal's tombstone carries its events; the log has none.
            "goalEvents",
        ] {
            assert_eq!(by_name.get(name), Some(&false), "{name} has no tombstones");
        }
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
