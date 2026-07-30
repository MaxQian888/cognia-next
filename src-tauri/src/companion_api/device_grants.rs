//! Persisted per-device capability grants for hosts with no renderer.
//!
//! # Why this exists
//!
//! [`super::control_allow_list`] is an in-memory set consulted on the RPC hot
//! path, and its own docs say the persisted truth is Dexie's
//! `pairedDevices.allowRemoteControl`, mirrored in by `companion_seed_remote_control`
//! *at desktop boot*. That is a Tauri command invoked from the renderer.
//!
//! A headless `cognia-server` has no renderer, no Dexie, and no equivalent
//! command — so nothing ever populated the list and it stayed empty for the
//! process lifetime. Every CONTROL-tier RPC (`fs_write`, `git_commit`,
//! `git_push`, session steering) was therefore unreachable with a device JWT on
//! exactly the host type ADR-0082 exists to drive: you could pair a desktop to a
//! cloud server, see the capability boundary documented in the UI, and have no
//! way anywhere to grant it.
//!
//! This module is the missing half: a JSON file next to the other headless
//! credential files ([`super::push_creds::FilePushCredStore`] is the same
//! shape), read at boot to seed both allow lists, and mutated by the
//! `cognia-server devices` subcommands.
//!
//! # Consistency model
//!
//! The file is the truth; the in-memory lists are a boot-time projection. A
//! grant made while the server is running takes effect at its next start —
//! the CLI says so. That matches `rotate-master-key`, which likewise asks the
//! operator to restart. Watching the file would make the grant live at the cost
//! of a filesystem watcher on a security-relevant path, which is not a trade
//! worth making for an operation performed a handful of times per host.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

const GRANTS_FILE: &str = "device-grants.json";

/// Which elevated capability a grant refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantKind {
    /// Steer sessions, write files, push commits — [`super::control_allow_list::global`].
    Control,
    /// Start and drive external agents — [`super::control_allow_list::agent_control_global`].
    AgentControl,
}

impl GrantKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GrantKind::Control => "control",
            GrantKind::AgentControl => "agent-control",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "control" => Some(GrantKind::Control),
            "agent-control" | "agent_control" => Some(GrantKind::AgentControl),
            _ => None,
        }
    }
}

/// On-disk shape. `BTreeSet` so the file is stable and diffable, and so a
/// hand-edited duplicate collapses instead of being counted twice.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedGrants {
    #[serde(default)]
    pub control: BTreeSet<String>,
    #[serde(default)]
    pub agent_control: BTreeSet<String>,
}

impl PersistedGrants {
    fn set_mut(&mut self, kind: GrantKind) -> &mut BTreeSet<String> {
        match kind {
            GrantKind::Control => &mut self.control,
            GrantKind::AgentControl => &mut self.agent_control,
        }
    }
}

/// Storage seam, so the CLI paths and the boot path are testable without a
/// real data directory.
pub trait DeviceGrantStore: Send + Sync {
    fn load(&self) -> Result<PersistedGrants, String>;
    fn save(&self, grants: &PersistedGrants) -> Result<(), String>;
}

pub struct FileDeviceGrantStore {
    path: PathBuf,
}

impl FileDeviceGrantStore {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            path: data_dir.join(GRANTS_FILE),
        })
    }
}

impl DeviceGrantStore for FileDeviceGrantStore {
    /// A missing file means "nothing granted", not an error: that is the state
    /// of every freshly provisioned host.
    fn load(&self) -> Result<PersistedGrants, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => {
                serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", self.path.display()))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok(PersistedGrants::default())
            }
            Err(err) => Err(format!("{}: {err}", self.path.display())),
        }
    }

    fn save(&self, grants: &PersistedGrants) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let raw = serde_json::to_string_pretty(grants).map_err(|e| format!("serialize: {e}"))?;
        std::fs::write(&self.path, raw).map_err(|e| format!("{}: {e}", self.path.display()))
    }
}

/// Project the persisted grants onto the in-memory allow lists the RPC hot path
/// reads. Returns `(control, agent_control)` counts for the boot log.
///
/// Uses `reseed` (replace, not union) so a grant revoked while the server was
/// down does not survive the restart.
pub fn seed_allow_lists(store: &dyn DeviceGrantStore) -> Result<(usize, usize), String> {
    seed_allow_lists_into(
        store,
        super::control_allow_list::global(),
        super::control_allow_list::agent_control_global(),
    )
}

/// Seed a specific pair of lists.
///
/// Split out so the replace-not-union contract can be tested against lists the
/// test owns. The two globals are shared by every test in this binary and
/// `reseed` REPLACES, so seeding them from a test wipes whatever a concurrently
/// running RPC gate test had just granted itself — and a permission test that
/// passes because the grant vanished is worse than one that fails.
pub fn seed_allow_lists_into(
    store: &dyn DeviceGrantStore,
    control_list: &super::control_allow_list::ControlAllowList,
    agent_control_list: &super::control_allow_list::ControlAllowList,
) -> Result<(usize, usize), String> {
    let grants = store.load()?;
    let control: Vec<String> = grants.control.iter().cloned().collect();
    let agent: Vec<String> = grants.agent_control.iter().cloned().collect();
    let counts = (control.len(), agent.len());
    control_list.reseed(control);
    agent_control_list.reseed(agent);
    Ok(counts)
}

/// Grant `device_id` a capability. Returns `true` when this changed anything.
pub fn grant(
    store: &dyn DeviceGrantStore,
    device_id: &str,
    kind: GrantKind,
) -> Result<bool, String> {
    if device_id.trim().is_empty() {
        return Err("device id must not be empty".to_string());
    }
    let mut grants = store.load()?;
    let changed = grants.set_mut(kind).insert(device_id.to_string());
    if changed {
        store.save(&grants)?;
    }
    Ok(changed)
}

/// Revoke a capability. Returns `true` when this changed anything.
pub fn revoke(
    store: &dyn DeviceGrantStore,
    device_id: &str,
    kind: GrantKind,
) -> Result<bool, String> {
    let mut grants = store.load()?;
    let changed = grants.set_mut(kind).remove(device_id);
    if changed {
        store.save(&grants)?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemStore {
        inner: Mutex<PersistedGrants>,
        fail_save: bool,
    }

    impl DeviceGrantStore for MemStore {
        fn load(&self) -> Result<PersistedGrants, String> {
            Ok(self.inner.lock().unwrap().clone())
        }
        fn save(&self, grants: &PersistedGrants) -> Result<(), String> {
            if self.fail_save {
                return Err("disk full".to_string());
            }
            *self.inner.lock().unwrap() = grants.clone();
            Ok(())
        }
    }

    #[test]
    fn grant_kind_round_trips_through_its_wire_name() {
        for kind in [GrantKind::Control, GrantKind::AgentControl] {
            assert_eq!(GrantKind::parse(kind.as_str()), Some(kind));
        }
        // Underscore spelling accepted so a config written either way works.
        assert_eq!(
            GrantKind::parse("agent_control"),
            Some(GrantKind::AgentControl)
        );
        assert_eq!(GrantKind::parse("root"), None);
    }

    #[test]
    fn granting_control_does_not_grant_agent_control() {
        // The whole reason these are two lists: letting a device write files
        // must not silently let it start processes.
        let store = MemStore::default();
        assert!(grant(&store, "dev-1", GrantKind::Control).unwrap());
        let grants = store.load().unwrap();
        assert!(grants.control.contains("dev-1"));
        assert!(grants.agent_control.is_empty());
    }

    #[test]
    fn grant_is_idempotent_and_only_writes_when_it_changes_something() {
        let store = MemStore::default();
        assert!(grant(&store, "dev-1", GrantKind::AgentControl).unwrap());
        assert!(!grant(&store, "dev-1", GrantKind::AgentControl).unwrap());
    }

    #[test]
    fn revoke_reports_whether_it_removed_anything() {
        let store = MemStore::default();
        grant(&store, "dev-1", GrantKind::Control).unwrap();
        assert!(revoke(&store, "dev-1", GrantKind::Control).unwrap());
        assert!(!revoke(&store, "dev-1", GrantKind::Control).unwrap());
    }

    #[test]
    fn an_empty_device_id_is_refused_rather_than_stored() {
        // An empty id would match the empty `device_id` an unauthenticated or
        // malformed context carries, which would grant everyone.
        let store = MemStore::default();
        assert!(grant(&store, "   ", GrantKind::Control).is_err());
        assert!(store.load().unwrap().control.is_empty());
    }

    #[test]
    fn a_failed_write_surfaces_instead_of_silently_dropping_the_grant() {
        let store = MemStore {
            fail_save: true,
            ..Default::default()
        };
        assert!(grant(&store, "dev-1", GrantKind::Control).is_err());
    }

    #[test]
    fn seeding_replaces_rather_than_unions_so_revocations_survive_a_restart() {
        // Seeded into lists this test owns. Reseeding the process-global pair
        // from here would wipe whatever the RPC gate tests in `rpc.rs` and
        // `ws_terminal_test.rs` had granted themselves — same binary, threads
        // in parallel — and a permission test passing because the grant
        // vanished is a false green, not a flake.
        let control = super::super::control_allow_list::ControlAllowList::new();
        let agent = super::super::control_allow_list::ControlAllowList::new();
        let store = MemStore::default();
        grant(&store, "dev-1", GrantKind::Control).unwrap();
        grant(&store, "dev-2", GrantKind::AgentControl).unwrap();
        assert_eq!(
            seed_allow_lists_into(&store, &control, &agent).unwrap(),
            (1, 1)
        );
        assert!(control.is_allowed("dev-1"));
        assert!(agent.is_allowed("dev-2"));
        // A device granted control is NOT thereby allowed to run agents.
        assert!(!agent.is_allowed("dev-1"));

        revoke(&store, "dev-1", GrantKind::Control).unwrap();
        assert_eq!(
            seed_allow_lists_into(&store, &control, &agent).unwrap(),
            (0, 1)
        );
        assert!(!control.is_allowed("dev-1"));
    }

    #[test]
    fn seed_allow_lists_projects_onto_the_process_globals() {
        // The injectable form above is the contract test; this one proves the
        // production entry point still targets the lists the RPC hot path
        // reads. Takes the shared guard because it reseeds them.
        let _guard = super::super::control_allow_list::test_guard();
        let store = MemStore::default();
        grant(&store, "seeded-control", GrantKind::Control).unwrap();
        grant(&store, "seeded-agent", GrantKind::AgentControl).unwrap();
        assert_eq!(seed_allow_lists(&store).unwrap(), (1, 1));
        assert!(super::super::control_allow_list::global().is_allowed("seeded-control"));
        assert!(super::super::control_allow_list::agent_control_global().is_allowed("seeded-agent"));

        // Leave the process-global lists clean for other tests.
        super::super::control_allow_list::global().clear();
        super::super::control_allow_list::agent_control_global().clear();
    }

    #[test]
    fn a_missing_file_reads_as_nothing_granted() {
        let dir =
            std::env::temp_dir().join(format!("cognia-grants-missing-{}", std::process::id()));
        let store = FileDeviceGrantStore::new(&dir);
        assert_eq!(store.load().unwrap(), PersistedGrants::default());
    }

    #[test]
    fn file_store_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!(
            "cognia-grants-rt-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = FileDeviceGrantStore::new(&dir);
        grant(store.as_ref(), "dev-a", GrantKind::AgentControl).unwrap();
        grant(store.as_ref(), "dev-b", GrantKind::Control).unwrap();

        let reopened = FileDeviceGrantStore::new(&dir);
        let grants = reopened.load().unwrap();
        assert!(grants.agent_control.contains("dev-a"));
        assert!(grants.control.contains("dev-b"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_is_an_error_rather_than_a_silent_empty_grant_set() {
        // Reading "nothing granted" from a corrupt file would be a fail-open on
        // the *revocation* side only, but it would also hide the corruption
        // from the operator, who would then re-grant into a file that never
        // loads.
        let dir = std::env::temp_dir().join(format!(
            "cognia-grants-corrupt-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(GRANTS_FILE), "{ not json").unwrap();
        let store = FileDeviceGrantStore::new(&dir);
        assert!(store.load().is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
