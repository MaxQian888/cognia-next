//! DSH-compatible transcripts commit only complete user turns.
use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tokio::sync::watch;

const MAX_SESSION_BYTES: u64 = 64 * 1024 * 1024;
const METADATA: &str = "_cogniaSession";

pub struct Session {
    path: PathBuf,
    _lock: File,
}

fn regular(path: &Path, create: bool) -> Result<File, &'static str> {
    let mut options = OpenOptions::new();
    options.read(true).write(create).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| "session-open-failed")?;
    if !file
        .metadata()
        .map_err(|_| "session-read-failed")?
        .is_file()
    {
        return Err("invalid-session-file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "session-security-failed")?;
    }
    Ok(file)
}

impl Session {
    pub async fn acquire(
        path: &Path,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Self, &'static str> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = parent
            .canonicalize()
            .map_err(|_| "session-parent-missing")?;
        let name = path.file_name().ok_or("invalid-session-file")?;
        let path = parent.join(name);
        let mut lock_name = name.to_os_string();
        lock_name.push(".lock");
        let file = regular(&parent.join(lock_name), true)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            loop {
                if *cancel.borrow() {
                    return Err("cancelled");
                }
                // The owned descriptor remains open for the entire chat.
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                    break;
                }
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::WouldBlock {
                    return Err("session-lock-failed");
                }
                tokio::select! {
                    _ = crate::model::cancellation(cancel) => return Err("cancelled"),
                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
                }
            }
        }
        Ok(Self { path, _lock: file })
    }

    /// Malformed or unfinished tails are discarded; the last completed turn survives.
    pub fn load(&self) -> Result<Vec<Value>, &'static str> {
        if !self.path.try_exists().map_err(|_| "session-read-failed")? {
            if self.path.symlink_metadata().is_ok() {
                return Err("invalid-session-file");
            }
            return Ok(Vec::new());
        }
        let file = regular(&self.path, false)?;
        if file.metadata().map_err(|_| "session-read-failed")?.len() > MAX_SESSION_BYTES {
            return Err("session-too-large");
        }
        let mut text = String::new();
        file.take(MAX_SESSION_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|_| "session-read-failed")?;
        if text.len() as u64 > MAX_SESSION_BYTES {
            return Err("session-too-large");
        }
        let mut values = Vec::new();
        for line in text.lines() {
            let Some((role, json)) = line.split_once('\t') else {
                break;
            };
            let Ok(value) = serde_json::from_str::<Value>(json) else {
                break;
            };
            if value.get("role").and_then(Value::as_str) != Some(role) {
                break;
            }
            values.push(value);
        }
        let length = complete_prefix(&values);
        values.truncate(length);
        Ok(values)
    }

    /// Metadata stays in the role<TAB>JSON file and never enters provider messages.
    pub fn save_completed(
        &self,
        persona: &Value,
        checkpoint: Option<&Value>,
        turns: &[Vec<Value>],
    ) -> Result<(), &'static str> {
        let mut messages = vec![marked(persona, "v1")];
        if let Some(checkpoint) = checkpoint {
            messages.push(marked(checkpoint, "checkpoint"));
        }
        for turn in turns {
            if turn.len() < 2 {
                return Err("incomplete-session-turn");
            }
            for (index, message) in turn.iter().enumerate() {
                let kind = if index == 0 {
                    Some("turn-start")
                } else if index == turn.len() - 1 {
                    Some("turn-end")
                } else if checkpoint_message(message) {
                    Some("checkpoint")
                } else if continuation_message(message) {
                    Some("continuation")
                } else {
                    None
                };
                messages.push(kind.map_or_else(|| message.clone(), |kind| marked(message, kind)));
            }
        }
        if turns.is_empty() {
            return self.save(&[]);
        }
        self.save(&messages)
    }

    pub fn save(&self, messages: &[Value]) -> Result<(), &'static str> {
        if !messages.is_empty() && complete_prefix(messages) != messages.len() {
            return Err("incomplete-session-turn");
        }
        if let Ok(metadata) = self.path.symlink_metadata() {
            if !metadata.file_type().is_file() {
                return Err("invalid-session-file");
            }
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(self.path.parent().ok_or("invalid-session-file")?)
                .map_err(|_| "session-write-failed")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "session-security-failed")?;
        }
        let mut length = 0;
        for value in messages {
            let role = value
                .get("role")
                .and_then(Value::as_str)
                .ok_or("invalid-session-message")?;
            let json = serde_json::to_string(value).map_err(|_| "invalid-session-message")?;
            length += role.len() + json.len() + 2;
            if length as u64 > MAX_SESSION_BYTES {
                return Err("session-too-large");
            }
            writeln!(temporary, "{role}\t{json}").map_err(|_| "session-write-failed")?;
        }
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "session-write-failed")?;
        temporary
            .persist(&self.path)
            .map_err(|_| "session-write-failed")?;
        File::open(self.path.parent().ok_or("invalid-session-file")?)
            .and_then(|f| f.sync_all())
            .map_err(|_| "session-write-failed")?;
        Ok(())
    }
}

fn marked(message: &Value, kind: &str) -> Value {
    let mut message = message.clone();
    message[METADATA] = Value::String(kind.to_owned());
    message
}

pub(crate) fn checkpoint_message(message: &Value) -> bool {
    message["role"] == "user"
        && message.get("content").and_then(Value::as_str).is_some_and(|text| {
            (text.starts_with("Established context from ")
                || text.starts_with("This is an automatically generated checkpoint condensing an earlier span of the conversation"))
                && text.contains("\n<compacted-summary>\n")
                && text.ends_with("\n</compacted-summary>")
        })
}

fn continuation_message(message: &Value) -> bool {
    message["role"] == "user"
        && message
            .get("content")
            .and_then(Value::as_str)
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .is_some_and(|value| {
                value.get("readinessFailed").is_some_and(Value::is_array)
                    && value.get("instruction").and_then(Value::as_str)
                        == Some("Continue repair; readiness is not established.")
            })
}

/// Restore host turn boundaries and remove persistence-only metadata before replay.
pub(crate) fn unpack(messages: Vec<Value>) -> (Option<Value>, Vec<Vec<Value>>) {
    let explicit = messages
        .first()
        .is_some_and(|message| message[METADATA] == "v1");
    let mut checkpoint = None;
    let mut turns = Vec::new();
    let mut turn = Vec::new();
    for (index, mut message) in messages.iter().cloned().enumerate() {
        let checkpoint_kind = !explicit || message[METADATA] == "checkpoint";
        let ending = if explicit {
            message[METADATA] == "turn-end"
        } else {
            message["role"] == "assistant"
                && message.get("tool_calls").is_none()
                && !messages.get(index + 1).is_some_and(continuation_message)
        };
        if let Some(object) = message.as_object_mut() {
            object.remove(METADATA);
        }
        if message["role"] == "system" {
            continue;
        }
        if checkpoint_kind && turn.is_empty() && turns.is_empty() && checkpoint_message(&message) {
            checkpoint = Some(message);
            continue;
        }
        turn.push(message);
        if ending {
            turns.push(std::mem::take(&mut turn));
        }
    }
    (checkpoint, turns)
}

/// Validate tool pairing and host boundaries instead of trusting role labels.
pub fn complete_prefix(messages: &[Value]) -> usize {
    let explicit = messages
        .first()
        .is_some_and(|message| message[METADATA] == "v1");
    let mut pending = std::collections::HashSet::<String>::new();
    let mut last = 0;
    let mut user = false;
    let mut provisional = false;
    for (index, value) in messages.iter().enumerate() {
        if !value.is_object() {
            break;
        }
        let marker = value.get(METADATA).and_then(Value::as_str);
        if (value.get(METADATA).is_some() && marker.is_none()) || (!explicit && marker.is_some()) {
            break;
        }
        let role = value.get("role").and_then(Value::as_str);
        match role {
            Some("system")
                if index == 0
                    && value.get("content").is_some_and(Value::is_string)
                    && (!explicit || marker == Some("v1")) => {}
            Some("user")
                if pending.is_empty() && value.get("content").is_some_and(Value::is_string) =>
            {
                if checkpoint_message(value) && (!explicit || marker == Some("checkpoint")) {
                    if provisional || (last > 0 && !user) {
                        break;
                    }
                    continue;
                }
                if user {
                    if !provisional
                        || !continuation_message(value)
                        || (explicit && marker != Some("continuation"))
                    {
                        break;
                    }
                } else if explicit && marker != Some("turn-start") {
                    break;
                }
                user = true;
                provisional = false;
            }
            Some("assistant") if user && pending.is_empty() && !provisional => {
                if !matches!(
                    value.get("content"),
                    None | Some(Value::Null) | Some(Value::String(_))
                ) {
                    break;
                }
                if let Some(calls) = value.get("tool_calls") {
                    if marker.is_some() {
                        break;
                    }
                    let Some(calls) = calls
                        .as_array()
                        .filter(|calls| !calls.is_empty() && calls.len() <= 256)
                    else {
                        break;
                    };
                    let mut used = std::collections::HashSet::new();
                    let mut valid = true;
                    for call in calls {
                        let Some(id) = call
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty() && id.len() <= 128)
                        else {
                            valid = false;
                            break;
                        };
                        let Some(function) = call.get("function") else {
                            valid = false;
                            break;
                        };
                        if call.get("type").and_then(Value::as_str) != Some("function")
                            || function.get("name").and_then(Value::as_str).is_none()
                            || function
                                .get("arguments")
                                .and_then(Value::as_str)
                                .and_then(|v| serde_json::from_str::<Value>(v).ok())
                                .is_none()
                            || !used.insert(id.to_owned())
                            || !pending.insert(id.to_owned())
                        {
                            valid = false;
                            break;
                        }
                    }
                    if !valid {
                        break;
                    }
                } else if value
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty())
                {
                    if explicit && marker != Some("turn-end") {
                        if marker.is_some() {
                            break;
                        }
                        provisional = true;
                    } else if !explicit && messages.get(index + 1).is_some_and(continuation_message)
                    {
                        provisional = true;
                    } else {
                        last = index + 1;
                        user = false;
                    }
                } else {
                    break;
                }
            }
            Some("tool")
                if user
                    && marker.is_none()
                    && value.get("content").is_some_and(Value::is_string) =>
            {
                let Some(id) = value.get("tool_call_id").and_then(Value::as_str) else {
                    break;
                };
                if !pending.remove(id) {
                    break;
                }
            }
            _ => break,
        }
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn turn() -> Vec<Value> {
        vec![
            json!({"role":"system","content":"persona"}),
            json!({"role":"user","content":"task"}),
            json!({"role":"assistant","content":"done"}),
        ]
    }
    #[tokio::test]
    async fn compatible_round_trip_recovers_incomplete_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let (_tx, mut cancel) = watch::channel(false);
        let session = Session::acquire(&path, &mut cancel).await.unwrap();
        session.save(&turn()).unwrap();
        assert_eq!(session.load().unwrap(), turn());
        writeln!(
            OpenOptions::new().append(true).open(&path).unwrap(),
            "user\t{{\"role\":\"user\",\"content\":\"unfinished\"}}"
        )
        .unwrap();
        assert_eq!(session.load().unwrap(), turn());
        let mut unfinished = turn();
        unfinished.push(json!({"role":"user","content":"unfinished"}));
        assert_eq!(session.save(&unfinished), Err("incomplete-session-turn"));
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
    fn consecutive_tasks_and_incomplete_readiness_repairs_are_not_completed() {
        let mut messages = turn();
        messages.push(json!({"role":"user","content":"unfinished task"}));
        messages.push(json!({"role":"user","content":"another task"}));
        messages.push(json!({"role":"assistant","content":"done"}));
        assert_eq!(complete_prefix(&messages), 3);

        let continuation = json!({"role":"user","content":json!({"readinessFailed":[],"instruction":"Continue repair; readiness is not established."}).to_string()});
        let mut messages = turn();
        messages.push(json!({"role":"user","content":"repair"}));
        messages.push(json!({"role":"assistant","content":"provisional completion"}));
        messages.push(continuation);
        assert_eq!(complete_prefix(&messages), 3);
        messages.push(json!({"role":"assistant","content":"verified completion"}));
        assert_eq!(complete_prefix(&messages), messages.len());
        let (_, turns) = unpack(messages);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].len(), 4);
    }

    #[tokio::test]
    async fn explicit_boundaries_preserve_one_host_turn_and_hide_metadata_on_replay() {
        let dir = tempfile::tempdir().unwrap();
        let (_tx, mut cancel) = watch::channel(false);
        let session = Session::acquire(&dir.path().join("session.jsonl"), &mut cancel)
            .await
            .unwrap();
        let persona = json!({"role":"system","content":"persona"});
        let checkpoint = json!({"role":"user","content":"Established context from completed earlier turns.\n<compacted-summary>\nPrior context.\n</compacted-summary>"});
        let turn = vec![
            json!({"role":"user","content":"repair"}),
            json!({"role":"assistant","content":"provisional completion"}),
            json!({"role":"user","content":json!({"readinessFailed":[],"instruction":"Continue repair; readiness is not established."}).to_string()}),
            json!({"role":"assistant","content":"verified completion"}),
        ];
        session
            .save_completed(&persona, Some(&checkpoint), std::slice::from_ref(&turn))
            .unwrap();
        let saved = session.load().unwrap();
        assert_eq!(saved.last().unwrap()[METADATA], "turn-end");
        assert_eq!(complete_prefix(&saved[..saved.len() - 1]), 0);
        let (restored_checkpoint, turns) = unpack(saved);
        assert_eq!(restored_checkpoint, Some(checkpoint));
        assert_eq!(turns, vec![turn]);
        assert!(turns
            .iter()
            .flatten()
            .all(|message| message.get(METADATA).is_none()));
    }

    #[tokio::test]
    async fn refuses_symlinks_and_lock_wait_can_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let (_tx, mut cancel) = watch::channel(false);
        let session = Session::acquire(&path, &mut cancel).await.unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("elsewhere", &path).unwrap();
            assert!(session.save(&turn()).is_err());
            assert!(session.load().is_err());
        }
        let (tx, mut cancel) = watch::channel(false);
        tx.send(true).unwrap();
        assert!(matches!(
            Session::acquire(&path, &mut cancel).await,
            Err("cancelled")
        ));
    }
    #[test]
    fn unmatched_or_duplicate_tool_results_never_resume() {
        let mut messages = turn();
        messages.push(json!({"role":"user","content":"next"}));
        messages.push(json!({"role":"assistant","tool_calls":[{"id":"a","type":"function","function":{"name":"bash","arguments":"{\"command\":\"pwd\"}"}}]}));
        messages.push(json!({"role":"tool","tool_call_id":"wrong","content":"output"}));
        messages.push(json!({"role":"assistant","content":"done"}));
        assert_eq!(complete_prefix(&messages), 3);
    }
}
