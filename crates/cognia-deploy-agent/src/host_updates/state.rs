//! What the agent remembers across restarts: the image it pinned, the swap in
//! progress, and how the last one ended.
//!
//! A swap is recorded before the server is touched, so an agent that restarts
//! mid-update finds it and finishes the job: it keeps proving a server it
//! already switched, and rolls back one it had not.

use std::path::{Path, PathBuf};

use cognia_host_service::install_home::UpdateOutcome;
use serde::{Deserialize, Serialize};

const STATE_FILE: &str = "host-updates.json";
const TRUST_FILE: &str = "trust.json";

/// A swap from one server image to another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSwap {
    pub attempt_id: String,
    pub from: String,
    pub to: String,
    /// `repository@digest`, from the signed catalog.
    pub image: String,
    /// The env file the image is pinned in.
    pub env_file: PathBuf,
    /// Its `COGNIA_SERVER_IMAGE` before the swap; `None` when unset.
    pub previous_env: Option<String>,
    /// The `repository@digest` the old server ran, when it came from a
    /// registry: what a rollback pins, so it returns to the exact build.
    pub rollback_image: Option<String>,
    pub started_at_ms: i64,
    pub deadline_ms: i64,
    /// The env file is pinned and the server recreated (or being recreated).
    pub activated: bool,
    /// Failures already present on the old version, persisted before replacement.
    #[serde(default)]
    pub baseline_failed_required_runtimes: Vec<String>,
}

impl PendingSwap {
    /// What a rollback pins: the old build's digest, else the old value.
    pub fn restore_value(&self) -> Option<&str> {
        self.rollback_image
            .as_deref()
            .or(self.previous_env.as_deref())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    /// The `repository@digest` the agent pinned the server to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<PendingSwap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_outcome: Option<UpdateOutcome>,
}

/// `<state dir>/host-updates.json`, replaced atomically.
#[derive(Debug, Clone)]
pub struct StateFile {
    dir: PathBuf,
}

impl StateFile {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where the catalog trust state lives, beside the agent's own state.
    pub fn trust_path(&self) -> PathBuf {
        self.dir.join(TRUST_FILE)
    }

    /// The saved state. A damaged file is an error, never a blank state: a
    /// swap in progress must not be forgotten.
    pub fn load(&self) -> Result<AgentState, String> {
        match std::fs::read_to_string(self.dir.join(STATE_FILE)) {
            Ok(raw) => serde_json::from_str(&raw)
                .map_err(|error| format!("{}: {error}", self.dir.join(STATE_FILE).display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AgentState::default()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn save(&self, state: &AgentState) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|error| error.to_string())?;
        let path = self.dir.join(STATE_FILE);
        let temp = self.dir.join(format!(".{STATE_FILE}.tmp"));
        let body = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
        std::fs::write(&temp, body).map_err(|error| error.to_string())?;
        std::fs::rename(&temp, &path).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn swap() -> PendingSwap {
        PendingSwap {
            attempt_id: "a1".into(),
            from: "1.4.0".into(),
            to: "1.5.0".into(),
            image: "ghcr.io/x/s@sha256:new".into(),
            env_file: PathBuf::from("/srv/.env"),
            previous_env: Some("ghcr.io/x/s:latest-full".into()),
            rollback_image: Some("ghcr.io/x/s@sha256:old".into()),
            started_at_ms: 1,
            deadline_ms: 2,
            activated: false,
            baseline_failed_required_runtimes: vec!["connector-runtime".into()],
        }
    }

    #[test]
    fn a_swap_survives_a_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let file = StateFile::new(tmp.path().join("state"));
        assert_eq!(file.load().unwrap(), AgentState::default());
        let state = AgentState {
            image: Some("ghcr.io/x/s@sha256:old".into()),
            pending: Some(swap()),
            last_outcome: None,
        };
        file.save(&state).unwrap();
        assert_eq!(file.load().unwrap(), state);
        assert_eq!(
            file.trust_path(),
            tmp.path().join("state").join("trust.json")
        );
    }

    #[test]
    fn old_pending_swaps_default_to_no_known_runtime_failures() {
        let mut old = serde_json::to_value(swap()).unwrap();
        old.as_object_mut()
            .unwrap()
            .remove("baselineFailedRequiredRuntimes");
        let pending: PendingSwap = serde_json::from_value(old).unwrap();
        assert!(pending.baseline_failed_required_runtimes.is_empty());
    }

    #[test]
    fn a_damaged_state_file_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(STATE_FILE), "{not json").unwrap();
        assert!(StateFile::new(tmp.path()).load().is_err());
    }

    #[test]
    fn a_rollback_returns_to_the_old_digest_else_the_old_value() {
        let mut pending = swap();
        assert_eq!(pending.restore_value(), Some("ghcr.io/x/s@sha256:old"));
        pending.rollback_image = None;
        assert_eq!(pending.restore_value(), Some("ghcr.io/x/s:latest-full"));
        pending.previous_env = None;
        assert_eq!(pending.restore_value(), None);
    }
}
