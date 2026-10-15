//! Host-owned delivery history, independent of client subscriptions and pool enablement.
//!
//! One atomic JSON file per remote session keeps reused agent ids distinct. Only
//! delivery metadata is stored: never spawn environments, source URLs, credentials,
//! or git stderr (which can contain source text). Files and their directory are
//! synced before an outcome is acknowledged to event subscribers.

use parking_lot::Mutex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const DELIVERY_DIR: &str = "sandbox-deliveries";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PublishState {
    Running,
    Pushed,
    SavedBundle,
    Held,
    Discarded,
    NothingToPublish,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CleanupState {
    Retained,
    Pending,
    DestroyRetrying,
    Destroyed,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDeliveryRecord {
    pub id: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub provider_id: String,
    pub instance_id: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    pub publish_state: PublishState,
    pub cleanup_state: CleanupState,
    #[schemars(schema_with = "publish_schema")]
    pub publish: Value,
    pub created_at: u64,
    pub updated_at: u64,
    pub revision: u64,
}

// The stored payload stays compatible with the existing event, while the RPC
// schema enumerates the fields instead of exposing an arbitrary JSON object.
#[allow(dead_code)]
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
struct DurablePublish {
    pushed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    held: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    discarded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery: Option<DurableRecovery>,
}

#[allow(dead_code)]
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
struct DurableRecovery {
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commits: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
}

fn publish_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    generator.subschema_for::<DurablePublish>()
}

impl TaskDeliveryRecord {
    pub fn running(
        id: String,
        agent_id: String,
        task_id: Option<String>,
        provider_id: String,
        instance_id: String,
        branch: String,
    ) -> Self {
        let now = now_ms();
        Self {
            id,
            agent_id,
            task_id,
            provider_id,
            instance_id,
            branch,
            commit: None,
            publish_state: PublishState::Running,
            cleanup_state: CleanupState::Retained,
            publish: json!({"pushed": false, "code": "session_running"}),
            created_at: now,
            updated_at: now,
            revision: 0,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct DeliveryStore {
    directory: PathBuf,
    writer: Mutex<()>,
}

impl DeliveryStore {
    /// Construction is read-only; listing still works with the pool disabled.
    pub fn new(data_dir: &Path) -> Self {
        Self {
            directory: data_dir.join(DELIVERY_DIR),
            writer: Mutex::new(()),
        }
    }

    pub fn list(
        &self,
        agent_id: Option<&str>,
        task_id: Option<&str>,
    ) -> Result<Vec<TaskDeliveryRecord>, String> {
        let _guard = self.writer.lock();
        self.read_all().map(|mut records| {
            records.retain(|r| {
                agent_id.is_none_or(|id| r.agent_id == id)
                    && task_id.is_none_or(|id| r.task_id.as_deref() == Some(id))
            });
            records.sort_by(|a, b| {
                b.created_at
                    .cmp(&a.created_at)
                    .then_with(|| b.id.cmp(&a.id))
            });
            records
        })
    }

    pub(crate) fn create(&self, record: TaskDeliveryRecord) -> Result<(), String> {
        let _guard = self.writer.lock();
        if self.path(&record.id)?.exists() {
            return Err("delivery session already exists".into());
        }
        self.write(&record)
    }

    pub(crate) fn publish(
        &self,
        id: &str,
        publish: &Value,
        cleanup: CleanupState,
    ) -> Result<TaskDeliveryRecord, String> {
        let _guard = self.writer.lock();
        let mut record = self.read(id)?;
        // A late git command cannot undo a deadline discard or completed removal.
        if record.publish_state != PublishState::Discarded {
            record.publish = sanitized_publish(publish);
            record.publish_state = publish_state(publish);
            if let Some(commit) = publish
                .get("commit")
                .or_else(|| publish.get("recovery").and_then(|r| r.get("commit")))
                .and_then(Value::as_str)
            {
                record.commit = Some(commit.into());
            }
        }
        if record.cleanup_state != CleanupState::Destroyed
            && record.cleanup_state != CleanupState::DestroyRetrying
        {
            record.cleanup_state = cleanup;
        }
        self.bump(&mut record)?;
        Ok(record)
    }

    pub(crate) fn cleanup(
        &self,
        provider: &str,
        instance: &str,
        state: CleanupState,
        lost: bool,
    ) -> Result<Vec<TaskDeliveryRecord>, String> {
        let _guard = self.writer.lock();
        let mut changed = Vec::new();
        for mut record in self.read_all()? {
            if record.provider_id != provider
                || record.instance_id != instance
                || record.cleanup_state == CleanupState::Destroyed
            {
                continue;
            }
            record.cleanup_state = state;
            if lost
                && matches!(
                    record.publish_state,
                    PublishState::Held | PublishState::Running
                )
            {
                // A previously held workspace is known lost. An interrupted
                // running session has an unknown outcome, not proven data loss.
                let discarded = record.publish_state == PublishState::Held;
                record.publish_state = if discarded {
                    PublishState::Discarded
                } else {
                    PublishState::Failed
                };
                record.publish["held"] = json!(false);
                if discarded {
                    record.publish["discarded"] = json!(true);
                }
                record.publish["code"] = json!("sandbox_workspace_instance_lost");
            }
            self.bump(&mut record)?;
            changed.push(record);
        }
        Ok(changed)
    }

    fn bump(&self, record: &mut TaskDeliveryRecord) -> Result<(), String> {
        record.revision += 1;
        record.updated_at = now_ms().max(record.updated_at);
        self.write(record)
    }

    fn path(&self, id: &str) -> Result<PathBuf, String> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("invalid delivery session id".into());
        }
        Ok(self.directory.join(format!("{id}.json")))
    }

    fn read(&self, id: &str) -> Result<TaskDeliveryRecord, String> {
        let bytes = fs::read(self.path(id)?).map_err(|e| format!("read delivery record: {e}"))?;
        serde_json::from_slice(&bytes).map_err(|e| format!("decode delivery record: {e}"))
    }

    fn read_all(&self) -> Result<Vec<TaskDeliveryRecord>, String> {
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("list delivery records: {e}")),
        };
        let mut records = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| format!("list delivery record: {e}"))?;
            if entry.path().extension().is_some_and(|ext| ext == "json") {
                let id = entry
                    .path()
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or("invalid delivery filename")?
                    .to_string();
                records.push(self.read(&id)?);
            }
        }
        Ok(records)
    }

    fn write(&self, record: &TaskDeliveryRecord) -> Result<(), String> {
        let path = self.path(&record.id)?;
        fs::create_dir_all(&self.directory)
            .map_err(|e| format!("create delivery directory: {e}"))?;
        let mut temp = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|e| format!("create delivery file: {e}"))?;
        let bytes =
            serde_json::to_vec(record).map_err(|e| format!("encode delivery record: {e}"))?;
        temp.write_all(&bytes)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|e| format!("write delivery record: {e}"))?;
        temp.persist(path)
            .map_err(|e| format!("replace delivery record: {e}"))?;
        fs::File::open(&self.directory)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("sync delivery directory: {e}"))
    }
}

fn publish_state(publish: &Value) -> PublishState {
    if publish["discarded"] == true {
        PublishState::Discarded
    } else if publish["pushed"] == true {
        PublishState::Pushed
    } else if publish["recovery"]["bundle"].is_string() {
        PublishState::SavedBundle
    } else if publish["held"] == true {
        PublishState::Held
    } else if publish["code"] == "nothing_to_publish"
        || publish["recovery"]["code"] == "nothing_to_preserve"
    {
        PublishState::NothingToPublish
    } else {
        PublishState::Failed
    }
}

fn sanitized_publish(publish: &Value) -> Value {
    let mut safe = json!({});
    for key in ["pushed", "branch", "commit", "code", "held", "discarded"] {
        if let Some(value) = publish.get(key) {
            safe[key] = value.clone();
        }
    }
    if let Some(recovery) = publish.get("recovery") {
        safe["recovery"] = json!({});
        for key in ["bundle", "manifest", "commit", "commits", "bytes", "code"] {
            if let Some(value) = recovery.get(key) {
                safe["recovery"][key] = value.clone();
            }
        }
    }
    safe
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: &str) -> TaskDeliveryRecord {
        TaskDeliveryRecord::running(
            id.into(),
            "agent".into(),
            Some("task".into()),
            "cloud".into(),
            "instance".into(),
            "task/branch".into(),
        )
    }

    #[test]
    fn wire_schema_matches_the_serialized_record() {
        let schema = schemars::schema_for!(TaskDeliveryRecord);
        let schema = serde_json::to_value(schema).unwrap();
        assert!(schema["properties"].get("providerId").is_some());
        assert!(schema["properties"].get("revision").is_some());
        if let Ok(path) = std::env::var("COGNIA_DELIVERY_SCHEMA_OUT") {
            fs::write(path, serde_json::to_vec_pretty(&schema).unwrap()).unwrap();
        }
    }

    #[test]
    fn reload_preserves_sessions_filters_and_cleanup_without_sensitive_output() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeliveryStore::new(dir.path());
        store.create(record("one")).unwrap();
        store.create(record("two")).unwrap();
        store.publish("one", &json!({"pushed":false,"held":true,"message":"SECRET source","credential":"SECRET"}), CleanupState::Retained).unwrap();
        store.publish("two", &json!({"pushed":false,"recovery":{"bundle":"/data/work.bundle","manifest":"/data/work.json","message":"SECRET"}}), CleanupState::Pending).unwrap();
        store
            .cleanup("cloud", "instance", CleanupState::DestroyRetrying, false)
            .unwrap();
        let reopened = DeliveryStore::new(dir.path());
        let rows = reopened.list(Some("agent"), Some("task")).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .all(|r| r.cleanup_state == CleanupState::DestroyRetrying && r.revision == 2));
        assert!(!serde_json::to_string(&rows).unwrap().contains("SECRET"));
        assert!(reopened.list(Some("other"), None).unwrap().is_empty());
        reopened
            .cleanup("cloud", "instance", CleanupState::Destroyed, true)
            .unwrap();
        let rows = reopened.list(None, None).unwrap();
        assert_eq!(
            rows.iter().find(|r| r.id == "one").unwrap().publish_state,
            PublishState::Discarded
        );
        assert_eq!(
            rows.iter().find(|r| r.id == "two").unwrap().publish_state,
            PublishState::SavedBundle
        );
        let late = reopened
            .publish("one", &json!({"pushed":true}), CleanupState::Retained)
            .unwrap();
        assert_eq!(late.publish_state, PublishState::Discarded);
        assert_eq!(late.cleanup_state, CleanupState::Destroyed);
    }

    #[test]
    fn exported_commit_is_retained_when_publish_failed_before_resolving_head() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeliveryStore::new(dir.path());
        store.create(record("one")).unwrap();
        let record = store.publish("one", &json!({"pushed":false,"code":"sandbox_workspace_publish_failed","recovery":{"bundle":"/data/one.bundle","commit":"abc"}}), CleanupState::Pending).unwrap();
        assert_eq!(record.commit.as_deref(), Some("abc"));
        assert_eq!(record.publish_state, PublishState::SavedBundle);
    }

    #[test]
    fn interrupted_running_session_is_unknown_not_proven_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeliveryStore::new(dir.path());
        store.create(record("one")).unwrap();
        store
            .cleanup("cloud", "instance", CleanupState::Destroyed, true)
            .unwrap();
        let record = store.list(None, None).unwrap().remove(0);
        assert_eq!(record.publish_state, PublishState::Failed);
        assert!(record.publish.get("discarded").is_none());
    }

    #[test]
    fn failures_are_visible_and_new_store_does_not_create_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeliveryStore::new(dir.path());
        assert!(store.list(None, None).unwrap().is_empty());
        assert!(!dir.path().join(DELIVERY_DIR).exists());
        assert!(store.create(record("../escape")).is_err());
        fs::write(dir.path().join(DELIVERY_DIR), "blocked").unwrap();
        assert!(store.create(record("one")).is_err());
        assert!(store.list(None, None).is_err());
    }

    #[test]
    fn corrupted_records_fail_the_list_instead_of_disappearing() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeliveryStore::new(dir.path());
        store.create(record("one")).unwrap();
        fs::write(store.path("one").unwrap(), "{").unwrap();
        assert!(store
            .list(None, None)
            .unwrap_err()
            .contains("decode delivery record"));
    }
}
