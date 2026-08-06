//! Durable minimal Fleet registry recovery state.
//!
//! Only process/session metadata is persisted — never prompts, pending
//! approvals, tool inputs, or errors. On startup the registry reconciles each
//! row against pid + process start time before exposing it as live.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::fs_atomic::{atomic_write_with_mtime_check, AtomicWritePlan};

use super::registry::{FleetAgent, FleetStatus};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySession {
    pub agent: FleetAgent,
    pub session_id: String,
    pub status: FleetStatus,
    pub cwd: Option<String>,
    pub project_name: Option<String>,
    pub model: Option<String>,
    pub transcript_path: Option<String>,
    pub agent_pid: Option<u32>,
    pub process_started_at: Option<u64>,
    pub started_at: u64,
    pub last_event_at: u64,
    pub tool_use_count: u32,
    pub turn_count: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryFile {
    version: u32,
    sessions: Vec<RecoverySession>,
}

pub fn load(path: &Path) -> Result<Vec<RecoverySession>, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let file: RecoveryFile = serde_json::from_slice(&bytes)
                .map_err(|error| format!("parse Fleet recovery {}: {error}", path.display()))?;
            if file.version != 1 {
                return Err(format!(
                    "unsupported Fleet recovery version {}",
                    file.version
                ));
            }
            Ok(file.sessions)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("read Fleet recovery {}: {error}", path.display())),
    }
}

pub fn save(path: &Path, sessions: Vec<RecoverySession>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&RecoveryFile {
        version: 1,
        sessions,
    })
    .map_err(|error| error.to_string())?;
    atomic_write_with_mtime_check(
        &AtomicWritePlan {
            path: PathBuf::from(path),
            expected_mtime: None,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        },
        &bytes,
    )
    .map_err(|error| error.to_string())?;
    restrict_permissions(path)
}

fn restrict_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> RecoverySession {
        RecoverySession {
            agent: FleetAgent::Codex,
            session_id: "session-1".into(),
            status: FleetStatus::Working,
            cwd: Some("/tmp/project".into()),
            project_name: Some("project".into()),
            model: Some("gpt-5".into()),
            transcript_path: None,
            agent_pid: Some(42),
            process_started_at: Some(10),
            started_at: 1,
            last_event_at: 2,
            tool_use_count: 3,
            turn_count: 4,
        }
    }

    #[test]
    fn round_trip_preserves_minimal_session_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("recovery.json");
        save(&path, vec![row()]).unwrap();
        assert_eq!(load(&path).unwrap(), vec![row()]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn corrupt_recovery_is_an_error_not_an_empty_registry() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("recovery.json");
        std::fs::write(&path, "not-json").unwrap();
        assert!(load(&path).unwrap_err().contains("parse Fleet recovery"));
    }
}
