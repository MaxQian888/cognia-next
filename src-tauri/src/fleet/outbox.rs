//! Durable at-least-once OpenCode command outbox.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::fs_atomic::{atomic_write_with_mtime_check, AtomicWritePlan};

pub const COMMAND_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
pub const COMMAND_LEASE_MS: u64 = 30_000;
const COMPLETED_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandState {
    Queued,
    Leased,
    Acked,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandKind {
    Prompt,
    Interrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutboxHealth {
    Healthy,
    Corrupt,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxStatus {
    pub health: OutboxHealth,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeCommand {
    pub id: String,
    pub kind: CommandKind,
    pub session_id: String,
    pub text: Option<String>,
    pub created_at: u64,
    pub expires_at: u64,
    pub attempts: u32,
    pub lease_until: Option<u64>,
    pub last_error: Option<String>,
    pub state: CommandState,
    pub completed_at: Option<u64>,
    pub result: Option<serde_json::Value>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutboxFile {
    version: u32,
    commands: Vec<OpencodeCommand>,
}

#[derive(Debug)]
pub struct DurableCommandOutbox {
    path: Option<PathBuf>,
    commands: Vec<OpencodeCommand>,
    load_error: Option<String>,
    health: OutboxHealth,
}

impl DurableCommandOutbox {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let commands = match std::fs::read(&path) {
            Ok(bytes) => {
                let file: OutboxFile = serde_json::from_slice(&bytes).map_err(|e| {
                    format!("invalid OpenCode command outbox {}: {e}", path.display())
                })?;
                if file.version != 1 {
                    return Err(format!(
                        "invalid OpenCode command outbox {}: unsupported version {}",
                        path.display(),
                        file.version
                    ));
                }
                file.commands
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("read OpenCode command outbox: {e}")),
        };
        Ok(Self {
            path: Some(path),
            commands,
            load_error: None,
            health: OutboxHealth::Healthy,
        })
    }

    pub fn unavailable(path: Option<PathBuf>, error: String) -> Self {
        let health = if error.starts_with("invalid OpenCode command outbox") {
            OutboxHealth::Corrupt
        } else {
            OutboxHealth::Unavailable
        };
        Self {
            path,
            commands: Vec::new(),
            load_error: Some(error),
            health,
        }
    }

    pub fn status(&self) -> OutboxStatus {
        OutboxStatus {
            health: self.health,
            path: self
                .path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            error: self.load_error.clone(),
        }
    }

    /// Explicit recovery for a failed durable store. Existing bytes are never
    /// discarded silently: a present file is quarantined beside the outbox,
    /// then a fresh empty store is created. The caller must opt in through the
    /// repair command; normal enqueue/poll operations remain fail-closed.
    pub fn repair(&mut self, now: u64) -> Result<Option<PathBuf>, String> {
        let path = self
            .path
            .clone()
            .ok_or_else(|| "OpenCode command outbox path is unavailable".to_string())?;
        let quarantine = if path.exists() {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("fleet-opencode-outbox.json");
            let quarantine = path.with_file_name(format!("{file_name}.corrupt-{now}"));
            std::fs::rename(&path, &quarantine)
                .map_err(|error| format!("quarantine OpenCode command outbox: {error}"))?;
            Some(quarantine)
        } else {
            None
        };

        self.commands.clear();
        self.load_error = None;
        self.health = OutboxHealth::Healthy;
        if let Err(error) = self.persist() {
            self.load_error = Some(error.clone());
            self.health = OutboxHealth::Unavailable;
            return Err(error);
        }
        Ok(quarantine)
    }

    fn ensure_available(&self) -> Result<(), String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        if self.path.is_none() {
            return Err("OpenCode command outbox path is unavailable".to_string());
        }
        Ok(())
    }

    fn persist(&mut self) -> Result<(), String> {
        let result = (|| {
            self.ensure_available()?;
            let path = self.path.as_ref().expect("checked above");
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let bytes = serde_json::to_vec_pretty(&OutboxFile {
                version: 1,
                commands: self.commands.clone(),
            })
            .map_err(|e| e.to_string())?;
            atomic_write_with_mtime_check(
                &AtomicWritePlan {
                    path: path.clone(),
                    expected_mtime: None,
                    tmp_suffix: "tmp".into(),
                    backup_suffix: "bak".into(),
                },
                &bytes,
            )
            .map_err(|e| e.to_string())?;
            restrict_permissions(path)
        })();
        if let Err(error) = &result {
            self.load_error = Some(error.clone());
            self.health = OutboxHealth::Unavailable;
        }
        result
    }

    pub fn enqueue(
        &mut self,
        id: String,
        kind: CommandKind,
        session_id: String,
        text: Option<String>,
        now: u64,
    ) -> Result<String, String> {
        self.ensure_available()?;
        self.prune(now);
        self.commands.push(OpencodeCommand {
            id: id.clone(),
            kind,
            session_id,
            text,
            created_at: now,
            expires_at: now.saturating_add(COMMAND_TTL_MS),
            attempts: 0,
            lease_until: None,
            last_error: None,
            state: CommandState::Queued,
            completed_at: None,
            result: None,
        });
        self.persist()?;
        Ok(id)
    }

    pub fn lease(
        &mut self,
        session_ids: &[String],
        now: u64,
    ) -> Result<Vec<OpencodeCommand>, String> {
        self.ensure_available()?;
        let pruned = self.prune(now);
        let mut leased = Vec::new();
        for command in &mut self.commands {
            let lease_expired = command.lease_until.is_some_and(|until| until <= now);
            if command.state == CommandState::Leased && lease_expired {
                command.state = CommandState::Queued;
                command.lease_until = None;
            }
            if command.state == CommandState::Queued
                && session_ids.iter().any(|id| id == &command.session_id)
            {
                command.state = CommandState::Leased;
                command.attempts = command.attempts.saturating_add(1);
                command.lease_until = Some(now.saturating_add(COMMAND_LEASE_MS));
                leased.push(command.clone());
            }
        }
        if pruned || !leased.is_empty() {
            self.persist()?;
        }
        Ok(leased)
    }

    pub fn ack(
        &mut self,
        id: &str,
        result: Option<serde_json::Value>,
        now: u64,
    ) -> Result<bool, String> {
        self.ensure_available()?;
        let Some(command) = self.commands.iter_mut().find(|command| command.id == id) else {
            return Ok(false);
        };
        if command.state == CommandState::Acked {
            return Ok(true);
        }
        command.state = CommandState::Acked;
        command.lease_until = None;
        command.completed_at = Some(now);
        command.result = result;
        self.persist()?;
        Ok(true)
    }

    pub fn nack(&mut self, id: &str, error: String, now: u64) -> Result<bool, String> {
        self.ensure_available()?;
        let Some(command) = self.commands.iter_mut().find(|command| command.id == id) else {
            return Ok(false);
        };
        if command.state == CommandState::Acked {
            return Ok(true);
        }
        command.state = if now >= command.expires_at {
            CommandState::Failed
        } else {
            CommandState::Queued
        };
        command.lease_until = None;
        command.last_error = Some(error);
        if command.state == CommandState::Failed {
            command.completed_at = Some(now);
        }
        self.persist()?;
        Ok(true)
    }

    fn prune(&mut self, now: u64) -> bool {
        let mut changed = false;
        for command in &mut self.commands {
            if !matches!(command.state, CommandState::Acked | CommandState::Failed)
                && now >= command.expires_at
            {
                command.state = CommandState::Failed;
                command.lease_until = None;
                command.completed_at = Some(now);
                command
                    .last_error
                    .get_or_insert_with(|| "command expired before acknowledgement".to_string());
                changed = true;
            }
        }
        let before = self.commands.len();
        self.commands.retain(|command| {
            if matches!(command.state, CommandState::Acked | CommandState::Failed) {
                return command
                    .completed_at
                    .is_none_or(|at| now.saturating_sub(at) < COMPLETED_RETENTION_MS);
            }
            now < command.expires_at
        });
        changed || self.commands.len() != before
    }
}

fn restrict_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_is_at_least_once_until_ack_and_survives_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("outbox.json");
        let mut outbox = DurableCommandOutbox::open(path.clone()).unwrap();
        outbox
            .enqueue(
                "c1".into(),
                CommandKind::Prompt,
                "s1".into(),
                Some("hello".into()),
                100,
            )
            .unwrap();

        let first = outbox.lease(&["s1".into()], 200).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].attempts, 1);
        assert!(outbox.lease(&["s1".into()], 201).unwrap().is_empty());

        let mut reopened = DurableCommandOutbox::open(path).unwrap();
        let redelivered = reopened
            .lease(&["s1".into()], 200 + COMMAND_LEASE_MS)
            .unwrap();
        assert_eq!(redelivered[0].id, "c1");
        assert_eq!(redelivered[0].attempts, 2);
        assert!(reopened
            .ack("c1", Some(serde_json::json!({"ok": true})), 500)
            .unwrap());
        assert!(reopened.ack("c1", None, 501).unwrap());
        assert!(reopened
            .lease(&["s1".into()], 500 + COMMAND_LEASE_MS)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn nack_requeues_and_expired_commands_are_not_delivered() {
        let tmp = tempfile::tempdir().unwrap();
        let mut outbox = DurableCommandOutbox::open(tmp.path().join("outbox.json")).unwrap();
        outbox
            .enqueue(
                "retry".into(),
                CommandKind::Prompt,
                "s1".into(),
                Some("hello".into()),
                0,
            )
            .unwrap();
        outbox.lease(&["s1".into()], 1).unwrap();
        assert!(outbox.nack("retry", "offline".into(), 2).unwrap());
        let retried = outbox.lease(&["s1".into()], 3).unwrap();
        assert_eq!(retried[0].last_error.as_deref(), Some("offline"));

        outbox
            .enqueue(
                "expired".into(),
                CommandKind::Prompt,
                "s2".into(),
                Some("old".into()),
                0,
            )
            .unwrap();
        assert!(outbox
            .lease(&["s2".into()], COMMAND_TTL_MS)
            .unwrap()
            .is_empty());
        let expired = outbox
            .commands
            .iter()
            .find(|command| command.id == "expired")
            .expect("expired command retained for audit");
        assert_eq!(expired.state, CommandState::Failed);
        assert_eq!(expired.completed_at, Some(COMMAND_TTL_MS));
    }

    #[test]
    fn corrupt_store_fails_closed_until_explicit_repair_quarantines_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("outbox.json");
        std::fs::write(&path, b"not-json").unwrap();

        let error = DurableCommandOutbox::open(path.clone()).unwrap_err();
        let mut outbox = DurableCommandOutbox::unavailable(Some(path.clone()), error);
        assert_eq!(outbox.status().health, OutboxHealth::Corrupt);
        assert!(outbox
            .enqueue(
                "blocked".into(),
                CommandKind::Prompt,
                "s1".into(),
                Some("hello".into()),
                1,
            )
            .is_err());

        let quarantine = outbox.repair(42).unwrap().expect("corrupt file moved");
        assert!(quarantine.ends_with("outbox.json.corrupt-42"));
        assert_eq!(std::fs::read_to_string(quarantine).unwrap(), "not-json");
        assert_eq!(outbox.status().health, OutboxHealth::Healthy);
        outbox
            .enqueue(
                "accepted".into(),
                CommandKind::Interrupt,
                "s1".into(),
                None,
                2,
            )
            .unwrap();
        assert!(path.is_file());
    }

    #[test]
    fn unsupported_version_is_corrupt_and_persist_failure_marks_unavailable() {
        let tmp = tempfile::tempdir().unwrap();
        let versioned = tmp.path().join("versioned.json");
        std::fs::write(&versioned, br#"{"version":2,"commands":[]}"#).unwrap();
        let error = DurableCommandOutbox::open(versioned.clone()).unwrap_err();
        assert_eq!(
            DurableCommandOutbox::unavailable(Some(versioned), error)
                .status()
                .health,
            OutboxHealth::Corrupt
        );

        let parent_file = tmp.path().join("not-a-directory");
        std::fs::create_dir(&parent_file).unwrap();
        let mut outbox = DurableCommandOutbox::open(parent_file.join("outbox.json")).unwrap();
        std::fs::remove_dir(&parent_file).unwrap();
        std::fs::write(&parent_file, b"file").unwrap();
        assert!(outbox
            .enqueue(
                "blocked".into(),
                CommandKind::Interrupt,
                "s1".into(),
                None,
                1,
            )
            .is_err());
        assert_eq!(outbox.status().health, OutboxHealth::Unavailable);
        assert!(outbox.lease(&["s1".into()], 2).is_err());
    }
}
