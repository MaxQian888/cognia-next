//! Durable OpenCode control-command outbox.

use serde::{Deserialize, Serialize};
use std::path::Path;

use super::OpencodeCommand;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedCommand {
    id: String,
    session_id: String,
    kind: String,
    text: String,
    request_id: Option<String>,
    answers: Vec<Vec<String>>,
    attempt: u32,
    created_at: u64,
    expires_at: u64,
    leased_until: u64,
}

impl From<&OpencodeCommand> for PersistedCommand {
    fn from(value: &OpencodeCommand) -> Self {
        Self {
            id: value.id.clone(),
            session_id: value.session_id.clone(),
            kind: value.kind.clone(),
            text: value.text.clone(),
            request_id: value.request_id.clone(),
            answers: value.answers.clone(),
            attempt: value.attempt,
            created_at: value.created_at,
            expires_at: value.expires_at,
            leased_until: value.leased_until,
        }
    }
}

impl From<PersistedCommand> for OpencodeCommand {
    fn from(value: PersistedCommand) -> Self {
        Self {
            id: value.id,
            session_id: value.session_id,
            kind: value.kind,
            text: value.text,
            request_id: value.request_id,
            answers: value.answers,
            attempt: value.attempt,
            created_at: value.created_at,
            expires_at: value.expires_at,
            // A process restart invalidates an old in-process lease. Make the
            // unacknowledged command immediately eligible for redelivery.
            leased_until: 0,
        }
    }
}

pub fn load(path: &Path) -> Result<Vec<OpencodeCommand>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read fleet command outbox: {error}")),
    };
    let rows: Vec<PersistedCommand> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse fleet command outbox: {error}"))?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub fn save(path: &Path, commands: &[OpencodeCommand]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create fleet command outbox directory: {error}"))?;
    }
    let rows = commands
        .iter()
        .map(PersistedCommand::from)
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&rows)
        .map_err(|error| format!("serialize fleet command outbox: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|error| format!("write fleet command outbox: {error}"))?;
    std::fs::rename(&tmp, path).map_err(|error| format!("commit fleet command outbox: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> OpencodeCommand {
        OpencodeCommand {
            id: "cmd-1".into(),
            session_id: "session-1".into(),
            kind: "prompt".into(),
            text: "continue".into(),
            request_id: None,
            answers: Vec::new(),
            attempt: 1,
            created_at: 10,
            expires_at: 1_000,
            leased_until: 900,
        }
    }

    #[test]
    fn round_trip_clears_stale_process_lease() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fleet-command-outbox.json");
        save(&path, &[command()]).unwrap();
        let restored = load(&path).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, "cmd-1");
        assert_eq!(restored[0].text, "continue");
        assert_eq!(restored[0].leased_until, 0);
    }
}
