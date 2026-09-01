//! The elevated-grant vocabulary, plus the reader for the retired
//! `device-grants.json` projection.
//!
//! # What this module is now
//!
//! [`GrantKind`] is the shared vocabulary for the three elevated grants a
//! paired device can hold, and [`GrantKind::capabilities`] is the **single**
//! mapping from a grant to the canonical SecurityStore capabilities that the
//! request-path gates actually check. Three call sites consume it — the desktop
//! toggles ([`super::commands::companion_set_remote_terminal`] and its two
//! siblings), the `cognia-server devices grant/revoke` CLI, and the one-time
//! import in [`super::security_store::SecurityStore::migrate_legacy_device_grants`]
//! — so a capability added to a grant lands on every host type at once.
//!
//! # Why the JSON file is read-only
//!
//! This module once owned a JSON file that was the persisted truth for a
//! headless host, projected at boot onto a set of process-global in-memory
//! allow lists. That design is retired: authorization is now the SecurityStore's
//! `capability_grants` table, checked on the request path by
//! [`super::remote_execution::authorize_capability`] and by the two direct
//! `has_capability` gates in [`super::rpc`] and [`super::ws_terminal`].
//!
//! What remains is the reader. `cognia-server` loads the file once at boot and
//! hands it to `migrate_legacy_device_grants`, which imports it behind a
//! committed SQLite marker so a grant revoked after the import can never be
//! resurrected by re-reading the same file. Nothing writes it any more — a
//! grant made today goes straight into the SecurityStore, and takes effect on
//! the next request rather than the next restart.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

const GRANTS_FILE: &str = "device-grants.json";

/// Which elevated capability a grant refers to.
///
/// Deliberately three kinds rather than one flag with sub-bits. Remote control
/// means steering work this host already decided to run; agent control means
/// launching a new process; terminal means an interactive shell. Granting
/// someone the ability to write files must not silently also grant process
/// execution, and a single switch labelled "remote control" would do exactly
/// that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantKind {
    /// Steer sessions, write files, push commits.
    Control,
    /// Start and drive external agents.
    AgentControl,
    /// Create, attach to, and control interactive terminal sessions.
    Terminal,
    /// Browse and transfer files over an SSH profile the desktop synchronized
    /// (ADR-0162).
    ///
    /// Separate from [`GrantKind::Terminal`] because it is a strictly smaller
    /// thing to grant. A device with a shell on that machine can already `cat`
    /// and `>` every file on it, so `ssh.files` adds nothing to a device that
    /// holds `terminal.open`. The reverse is the case worth having: files
    /// without a shell is read and write without code execution, and folding
    /// the two switches together would make that combination unexpressible.
    SshFiles,
}

impl GrantKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GrantKind::Control => "control",
            GrantKind::AgentControl => "agent-control",
            GrantKind::Terminal => "terminal",
            GrantKind::SshFiles => "ssh-files",
        }
    }

    /// The canonical SecurityStore capabilities this grant maps onto.
    ///
    /// This is the only place the mapping exists. The desktop toggles, the
    /// `cognia-server devices` CLI, and the legacy-grant import all route
    /// through it, so none of the three can drift into granting a capability
    /// the others do not — which is how a toggle ends up writing something no
    /// gate reads.
    pub fn capabilities(self) -> &'static [&'static str] {
        match self {
            GrantKind::Control => &[
                "agent.run",
                "workspace.read",
                "workspace.write",
                "git.write",
                "workflow.run",
            ],
            GrantKind::AgentControl => &["process.spawn"],
            GrantKind::Terminal => &["terminal.open"],
            GrantKind::SshFiles => &["ssh.files"],
        }
    }

    /// Every kind, so callers can project a whole capability snapshot without
    /// restating the list (and silently forgetting one when a kind is added).
    pub fn all() -> [GrantKind; 4] {
        [
            GrantKind::Control,
            GrantKind::AgentControl,
            GrantKind::Terminal,
            GrantKind::SshFiles,
        ]
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "control" => Some(GrantKind::Control),
            "agent-control" | "agent_control" => Some(GrantKind::AgentControl),
            "terminal" => Some(GrantKind::Terminal),
            "ssh-files" | "ssh_files" => Some(GrantKind::SshFiles),
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
    #[serde(default)]
    pub terminal: BTreeSet<String>,
}

/// Storage seam, so the boot-time import is testable without a real data
/// directory.
pub trait DeviceGrantStore: Send + Sync {
    fn load(&self) -> Result<PersistedGrants, String>;
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_kind_round_trips_through_its_wire_name() {
        for kind in GrantKind::all() {
            assert_eq!(GrantKind::parse(kind.as_str()), Some(kind));
        }
        // Underscore spelling accepted so a config written either way works.
        assert_eq!(
            GrantKind::parse("agent_control"),
            Some(GrantKind::AgentControl)
        );
        assert_eq!(GrantKind::parse("ssh_files"), Some(GrantKind::SshFiles));
        assert_eq!(GrantKind::parse("root"), None);
    }

    #[test]
    fn each_grant_maps_onto_capabilities_the_request_path_actually_checks() {
        // Every capability a toggle can write must be one `has_capability` can
        // be asked for — i.e. one the SecurityStore will accept as an
        // assignable device capability. A typo here is exactly the failure
        // this module exists to prevent: a switch that writes a grant no gate
        // will ever match.
        for kind in GrantKind::all() {
            assert!(
                !kind.capabilities().is_empty(),
                "{} grants nothing",
                kind.as_str()
            );
            for capability in kind.capabilities() {
                assert!(
                    super::super::security_store::is_assignable_device_capability(capability),
                    "{capability} is not an assignable device capability"
                );
            }
        }
    }

    #[test]
    fn the_three_grants_do_not_overlap() {
        // Letting a device write files must not silently also let it start
        // processes or open a shell, so no capability may appear under two
        // kinds — revoking one grant would otherwise leave the other's
        // capability behind.
        // Derived from `all()` rather than listed, so a kind added without a
        // line here is still checked against every other one.
        for a in GrantKind::all() {
            for b in GrantKind::all() {
                if a == b {
                    continue;
                }
                for capability in a.capabilities() {
                    assert!(
                        !b.capabilities().contains(capability),
                        "{capability} is in both {} and {}",
                        a.as_str(),
                        b.as_str()
                    );
                }
            }
        }
    }

    #[test]
    fn terminal_access_is_exactly_the_capability_the_terminal_gates_read() {
        // `rpc::ensure_terminal_rpc_authorized` and `ws_terminal` both ask for
        // "terminal.open" and nothing else. If this drifts, the terminal
        // toggle stops controlling terminal access.
        assert_eq!(GrantKind::Terminal.capabilities(), &["terminal.open"]);
    }

    #[test]
    fn file_transfer_is_its_own_grant_and_a_shell_does_not_carry_it() {
        // ADR-0162. Granting Terminal must not also grant `ssh.files`: the
        // console renders two switches, and one that silently moved the other
        // would report a permission the owner did not give. The reverse is
        // equally deliberate, which is what makes "files without a shell" a
        // grant somebody can actually make.
        assert_eq!(GrantKind::SshFiles.capabilities(), &["ssh.files"]);
        assert!(!GrantKind::Terminal.capabilities().contains(&"ssh.files"));
        assert!(!GrantKind::SshFiles
            .capabilities()
            .contains(&"terminal.open"));
    }

    #[test]
    fn remote_control_can_steer_agent_owned_work_without_granting_process_spawn() {
        // Remote-control commands such as `browser_navigate` and
        // `claude_restore` are classified as `agent.run` in the shared command
        // manifest. The remote-control switch must therefore carry that
        // capability, while process creation remains exclusive to the
        // separately-labelled Agent Control grant.
        assert!(GrantKind::Control.capabilities().contains(&"agent.run"));
        assert!(!GrantKind::Control.capabilities().contains(&"process.spawn"));
        assert_eq!(GrantKind::AgentControl.capabilities(), &["process.spawn"]);
    }

    #[test]
    fn a_missing_file_reads_as_nothing_granted() {
        let dir =
            std::env::temp_dir().join(format!("cognia-grants-missing-{}", std::process::id()));
        let store = FileDeviceGrantStore::new(&dir);
        assert_eq!(store.load().unwrap(), PersistedGrants::default());
    }

    #[test]
    fn a_file_written_by_an_older_build_still_reads() {
        // The file is retired but not extinct: an upgrading host still has one
        // on disk, and losing the ability to read it would silently drop every
        // grant made before the migration.
        let dir = std::env::temp_dir().join(format!(
            "cognia-grants-rt-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(GRANTS_FILE),
            r#"{"control":["dev-b"],"agent_control":["dev-a"],"terminal":["dev-c"]}"#,
        )
        .unwrap();

        let grants = FileDeviceGrantStore::new(&dir).load().unwrap();
        assert!(grants.agent_control.contains("dev-a"));
        assert!(grants.control.contains("dev-b"));
        assert!(grants.terminal.contains("dev-c"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_missing_a_section_reads_as_nothing_granted_for_it() {
        // `terminal` postdates the other two, so a file written before it
        // existed has no such key. Failing to parse would strand the host's
        // remaining grants rather than importing them.
        let dir = std::env::temp_dir().join(format!(
            "cognia-grants-partial-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(GRANTS_FILE), r#"{"control":["dev-b"]}"#).unwrap();

        let grants = FileDeviceGrantStore::new(&dir).load().unwrap();
        assert!(grants.control.contains("dev-b"));
        assert!(grants.terminal.is_empty());
        assert!(grants.agent_control.is_empty());
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
