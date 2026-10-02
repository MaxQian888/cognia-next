//! Which paired devices the desktop's owner let into which project's Pro IDE.
//!
//! The desktop workbench runs code-server with `--auth none` and full
//! terminals, trusting that only this machine can reach its loopback port.
//! Relaying it to a paired device extends that trust off the machine, so the
//! device's Remote Control capability is not enough on its own: the owner
//! approves each `(device, project)` pair once, at the desktop, and can revoke
//! it from Settings → Pro IDE.
//!
//! A request that has no grant becomes a pending ask (emitted to the desktop
//! UI); the requester is told to wait for approval and retries. Pending asks
//! live in memory and expire; grants persist in a `0600` JSON file under the
//! code-server root.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Emitted to the desktop UI with a [`PendingRelayGrant`] when a paired device
/// asks to open a project's workbench it has no approval for.
pub const CODESERVER_RELAY_GRANT_EVENT: &str = "codeserver://relay-grant-requested";

/// How long an unanswered ask stays answerable.
pub const PENDING_TTL: Duration = Duration::from_secs(5 * 60);

/// One approved `(device, project)` pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayGrant {
    pub device_id: String,
    /// Canonical project root.
    pub root: String,
    pub granted_at_ms: u64,
}

/// An ask waiting for the desktop owner's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRelayGrant {
    pub id: String,
    pub device_id: String,
    pub root: String,
    pub requested_at_ms: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct GrantFile {
    #[serde(default)]
    grants: Vec<RelayGrant>,
}

#[derive(Debug)]
pub struct RelayGrantStore {
    path: PathBuf,
    grants: Vec<RelayGrant>,
    pending: Vec<(PendingRelayGrant, Instant)>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

impl RelayGrantStore {
    /// Load the grants at `path`. A missing file is an empty store; an
    /// unreadable one is too, and says so in the log rather than failing the
    /// app — the cost is that the owner approves again, never that a device
    /// gets in.
    pub fn load(path: PathBuf) -> Self {
        let grants = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<GrantFile>(&bytes) {
                Ok(file) => file.grants,
                Err(error) => {
                    log::warn!(
                        "ignoring unreadable Pro IDE relay grants {}: {error}",
                        path.display()
                    );
                    Vec::new()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                log::warn!(
                    "ignoring unreadable Pro IDE relay grants {}: {error}",
                    path.display()
                );
                Vec::new()
            }
        };
        Self {
            path,
            grants,
            pending: Vec::new(),
        }
    }

    pub fn is_granted(&self, device_id: &str, root: &str) -> bool {
        self.grants
            .iter()
            .any(|grant| grant.device_id == device_id && grant.root == root)
    }

    /// Ask the owner to let `device_id` into `root`. Asking again while an ask
    /// for the same pair is pending returns that ask instead of a second one.
    pub fn request(&mut self, device_id: &str, root: &str) -> PendingRelayGrant {
        self.prune(Instant::now());
        if let Some((pending, _)) = self
            .pending
            .iter()
            .find(|(pending, _)| pending.device_id == device_id && pending.root == root)
        {
            return pending.clone();
        }
        let pending = PendingRelayGrant {
            id: Uuid::new_v4().simple().to_string(),
            device_id: device_id.to_string(),
            root: root.to_string(),
            requested_at_ms: now_ms(),
        };
        self.pending.push((pending.clone(), Instant::now()));
        pending
    }

    /// Asks still waiting for an answer.
    pub fn pending(&mut self) -> Vec<PendingRelayGrant> {
        self.prune(Instant::now());
        self.pending
            .iter()
            .map(|(pending, _)| pending.clone())
            .collect()
    }

    /// Answer ask `id`. Approving persists the grant and returns it.
    pub fn resolve(&mut self, id: &str, approve: bool) -> Result<Option<RelayGrant>, String> {
        self.prune(Instant::now());
        let index = self
            .pending
            .iter()
            .position(|(pending, _)| pending.id == id)
            .ok_or_else(|| "this request expired or was already answered".to_string())?;
        let (pending, _) = self.pending.remove(index);
        if !approve {
            return Ok(None);
        }
        let grant = RelayGrant {
            device_id: pending.device_id,
            root: pending.root,
            granted_at_ms: now_ms(),
        };
        if !self.is_granted(&grant.device_id, &grant.root) {
            self.grants.push(grant.clone());
            self.persist()?;
        }
        Ok(Some(grant))
    }

    pub fn list(&self) -> Vec<RelayGrant> {
        self.grants.clone()
    }

    /// Withdraw one grant. `true` when there was one.
    pub fn revoke(&mut self, device_id: &str, root: &str) -> Result<bool, String> {
        let before = self.grants.len();
        self.grants
            .retain(|grant| grant.device_id != device_id || grant.root != root);
        if self.grants.len() == before {
            return Ok(false);
        }
        self.persist()?;
        Ok(true)
    }

    /// Withdraw every grant and ask a device holds (it was unpaired).
    pub fn revoke_device(&mut self, device_id: &str) -> Result<bool, String> {
        self.pending
            .retain(|(pending, _)| pending.device_id != device_id);
        let before = self.grants.len();
        self.grants.retain(|grant| grant.device_id != device_id);
        if self.grants.len() == before {
            return Ok(false);
        }
        self.persist()?;
        Ok(true)
    }

    fn prune(&mut self, now: Instant) {
        self.pending
            .retain(|(_, at)| now.saturating_duration_since(*at) < PENDING_TTL);
    }

    fn persist(&self) -> Result<(), String> {
        write_private_json(
            &self.path,
            &GrantFile {
                grants: self.grants.clone(),
            },
        )
    }

    #[cfg(test)]
    fn age_pending(&mut self, by: Duration) {
        for (_, at) in &mut self.pending {
            *at = at.checked_sub(by).unwrap_or(*at);
        }
    }
}

/// Write `value` to `path` atomically (temp file + rename), readable by this
/// user only.
fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create {}: {error}", parent.display()))?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("serialize relay grants: {error}"))?;
    let temp = path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|error| format!("write {}: {error}", temp.display()))?;
        file.write_all(&bytes)
            .map_err(|error| format!("write {}: {error}", temp.display()))?;
    }
    std::fs::rename(&temp, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("replace {}: {error}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (RelayGrantStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (
            RelayGrantStore::load(dir.path().join("relay-grants.json")),
            dir,
        )
    }

    #[test]
    fn nothing_is_granted_until_the_owner_approves() {
        let (mut store, _dir) = store();
        assert!(!store.is_granted("phone", "/w"));
        let ask = store.request("phone", "/w");
        assert!(!store.is_granted("phone", "/w"));
        assert_eq!(store.pending(), vec![ask.clone()]);

        let grant = store.resolve(&ask.id, true).unwrap().unwrap();
        assert_eq!(
            (grant.device_id.as_str(), grant.root.as_str()),
            ("phone", "/w")
        );
        assert!(store.is_granted("phone", "/w"));
        assert!(!store.is_granted("phone", "/v"), "a grant is per project");
        assert!(!store.is_granted("laptop", "/w"), "and per device");
        assert!(store.pending().is_empty());
    }

    #[test]
    fn a_denied_or_answered_ask_cannot_be_answered_again() {
        let (mut store, _dir) = store();
        let ask = store.request("phone", "/w");
        assert_eq!(store.resolve(&ask.id, false).unwrap(), None);
        assert!(!store.is_granted("phone", "/w"));
        assert!(store.resolve(&ask.id, true).is_err());
    }

    #[test]
    fn asking_twice_is_one_ask_and_an_unanswered_ask_expires() {
        let (mut store, _dir) = store();
        let first = store.request("phone", "/w");
        assert_eq!(store.request("phone", "/w").id, first.id);
        store.age_pending(PENDING_TTL);
        assert!(store.pending().is_empty());
        assert!(store.resolve(&first.id, true).is_err());
        assert_ne!(store.request("phone", "/w").id, first.id);
    }

    #[test]
    fn grants_survive_a_restart_in_a_private_file() {
        let (mut store, dir) = store();
        let ask = store.request("phone", "/w");
        store.resolve(&ask.id, true).unwrap();
        let path = dir.path().join("relay-grants.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let reloaded = RelayGrantStore::load(path);
        assert!(reloaded.is_granted("phone", "/w"));
        assert_eq!(reloaded.list().len(), 1);
    }

    #[test]
    fn revoking_a_grant_or_a_device_persists() {
        let (mut store, dir) = store();
        for root in ["/w", "/v"] {
            let ask = store.request("phone", root);
            store.resolve(&ask.id, true).unwrap();
        }
        let ask = store.request("laptop", "/w");
        store.resolve(&ask.id, true).unwrap();
        store.request("phone", "/u");

        assert!(store.revoke("phone", "/w").unwrap());
        assert!(!store.revoke("phone", "/w").unwrap());
        assert!(store.revoke_device("phone").unwrap());
        assert!(
            store.pending().is_empty(),
            "the unpaired device's asks go too"
        );

        let reloaded = RelayGrantStore::load(dir.path().join("relay-grants.json"));
        assert_eq!(
            reloaded
                .list()
                .into_iter()
                .map(|grant| (grant.device_id, grant.root))
                .collect::<Vec<_>>(),
            vec![("laptop".to_string(), "/w".to_string())]
        );
    }

    #[test]
    fn an_unreadable_file_grants_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relay-grants.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(RelayGrantStore::load(path).list().is_empty());
    }
}
