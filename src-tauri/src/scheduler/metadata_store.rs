//! Persistent metadata store for system scheduler tasks.
//!
//! Platform schedulers can lose rich task configuration when listing/querying tasks.
//! This store keeps canonical trigger/action configuration for Cognia-managed tasks.

use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};

use super::error::{Result, SchedulerError};
use super::service::now_iso;
use super::types::{
    RunLevel, SystemTask, SystemTaskAction, SystemTaskStatus, SystemTaskTrigger, TaskMetadataState,
};

fn normalize_id(id: &str) -> String {
    id.trim().trim_start_matches('\\').to_lowercase()
}

fn map_sql_err(err: rusqlite::Error) -> SchedulerError {
    SchedulerError::Internal(format!("scheduler metadata sqlite error: {err}"))
}

pub struct SchedulerMetadataStore {
    conn: Mutex<Connection>,
}

impl SchedulerMetadataStore {
    pub fn new(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(path).map_err(map_sql_err)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS scheduler_task_metadata (
                task_id TEXT PRIMARY KEY,
                normalized_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                trigger_json TEXT NOT NULL,
                action_json TEXT NOT NULL,
                run_level_json TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                last_seen_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_scheduler_task_metadata_normalized_id
                ON scheduler_task_metadata(normalized_id);
            CREATE INDEX IF NOT EXISTS idx_scheduler_task_metadata_name
                ON scheduler_task_metadata(name);
            "#,
        )
        .map_err(map_sql_err)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn upsert_task(&self, task: &SystemTask) -> Result<()> {
        let trigger_json = serde_json::to_string(&task.trigger)
            .map_err(|e| SchedulerError::Serialization(e.to_string()))?;
        let action_json = serde_json::to_string(&task.action)
            .map_err(|e| SchedulerError::Serialization(e.to_string()))?;
        let run_level_json = serde_json::to_string(&task.run_level)
            .map_err(|e| SchedulerError::Serialization(e.to_string()))?;
        let tags_json = serde_json::to_string(&task.tags)
            .map_err(|e| SchedulerError::Serialization(e.to_string()))?;

        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO scheduler_task_metadata (
                task_id, normalized_id, name, description,
                trigger_json, action_json, run_level_json, tags_json,
                created_at, updated_at, last_seen_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(task_id) DO UPDATE SET
                normalized_id = excluded.normalized_id,
                name = excluded.name,
                description = excluded.description,
                trigger_json = excluded.trigger_json,
                action_json = excluded.action_json,
                run_level_json = excluded.run_level_json,
                tags_json = excluded.tags_json,
                created_at = COALESCE(scheduler_task_metadata.created_at, excluded.created_at),
                updated_at = excluded.updated_at,
                last_seen_at = excluded.last_seen_at
            "#,
            params![
                task.id,
                normalize_id(&task.id),
                task.name,
                task.description,
                trigger_json,
                action_json,
                run_level_json,
                tags_json,
                task.created_at,
                task.updated_at,
                now_iso(),
            ],
        )
        .map_err(map_sql_err)?;

        Ok(())
    }

    pub fn delete_task(&self, task_id: &str) -> Result<()> {
        let normalized = normalize_id(task_id);
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM scheduler_task_metadata WHERE task_id = ?1 OR normalized_id = ?2",
            params![task_id, normalized],
        )
        .map_err(map_sql_err)?;
        Ok(())
    }

    pub fn get_task_metadata(
        &self,
        task_id: &str,
        name_hint: Option<&str>,
    ) -> Result<Option<SystemTask>> {
        let normalized = normalize_id(task_id);
        let conn = self.conn.lock();

        let by_id = conn
            .query_row(
                r#"
                SELECT
                    task_id, name, description, trigger_json, action_json,
                    run_level_json, tags_json, created_at, updated_at
                FROM scheduler_task_metadata
                WHERE task_id = ?1 OR normalized_id = ?2
                LIMIT 1
                "#,
                params![task_id, normalized],
                Self::row_to_task,
            )
            .optional()
            .map_err(map_sql_err)?;

        if by_id.is_some() {
            return Ok(by_id);
        }

        if let Some(name) = name_hint {
            let by_name = conn
                .query_row(
                    r#"
                    SELECT
                        task_id, name, description, trigger_json, action_json,
                        run_level_json, tags_json, created_at, updated_at
                    FROM scheduler_task_metadata
                    WHERE name = ?1
                    ORDER BY updated_at DESC
                    LIMIT 1
                    "#,
                    params![name],
                    Self::row_to_task,
                )
                .optional()
                .map_err(map_sql_err)?;
            return Ok(by_name);
        }

        Ok(None)
    }

    fn row_to_task(row: &Row<'_>) -> rusqlite::Result<SystemTask> {
        let trigger_json: String = row.get(3)?;
        let action_json: String = row.get(4)?;
        let run_level_json: String = row.get(5)?;
        let tags_json: String = row.get(6)?;

        let trigger: SystemTaskTrigger = serde_json::from_str(&trigger_json).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(err))
        })?;
        let action: SystemTaskAction = serde_json::from_str(&action_json).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(err))
        })?;
        let run_level: RunLevel = serde_json::from_str(&run_level_json).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(err))
        })?;
        let tags: Vec<String> = serde_json::from_str(&tags_json).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(err))
        })?;

        let id: String = row.get(0)?;
        let name: String = row.get(1)?;
        let description: Option<String> = row.get(2)?;
        let created_at: Option<String> = row.get(7)?;
        let updated_at: Option<String> = row.get(8)?;

        let mut task = SystemTask {
            id,
            name,
            description,
            trigger,
            action,
            run_level,
            status: SystemTaskStatus::Unknown,
            requires_admin: false,
            tags,
            created_at,
            updated_at,
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state: TaskMetadataState::Full,
        };
        task.requires_admin = task.check_requires_admin();
        Ok(task)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_task(id: &str, name: &str) -> SystemTask {
        SystemTask {
            id: id.to_string(),
            name: name.to_string(),
            description: Some("desc".to_string()),
            trigger: SystemTaskTrigger::Interval { seconds: 60 },
            action: SystemTaskAction::RunCommand {
                command: "/bin/echo".to_string(),
                args: vec!["hello".to_string()],
                working_dir: None,
                env: std::collections::HashMap::new(),
            },
            run_level: RunLevel::User,
            status: SystemTaskStatus::Enabled,
            requires_admin: false,
            tags: vec!["scheduler".to_string()],
            created_at: Some(now_iso()),
            updated_at: Some(now_iso()),
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state: TaskMetadataState::Full,
        }
    }

    #[test]
    fn upsert_get_and_delete_metadata() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("scheduler_meta.db");
        let store = SchedulerMetadataStore::new(db_path).expect("store");

        let task = make_task("TaskA", "Task A");
        store.upsert_task(&task).expect("upsert");

        let loaded = store
            .get_task_metadata("TaskA", None)
            .expect("get")
            .expect("task exists");
        assert_eq!(loaded.id, "TaskA");
        assert_eq!(loaded.name, "Task A");
        assert_eq!(loaded.metadata_state, TaskMetadataState::Full);

        store.delete_task("TaskA").expect("delete");
        let missing = store
            .get_task_metadata("TaskA", None)
            .expect("get after delete");
        assert!(missing.is_none());
    }

    #[test]
    fn resolves_by_normalized_id_and_name_hint() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("scheduler_meta_lookup.db");
        let store = SchedulerMetadataStore::new(db_path).expect("store");

        let task = make_task("\\Cognia_Task_1", "Cognia Task");
        store.upsert_task(&task).expect("upsert");

        let by_normalized = store
            .get_task_metadata("cognia_task_1", None)
            .expect("lookup")
            .expect("exists");
        assert_eq!(by_normalized.id, "\\Cognia_Task_1");

        let by_name = store
            .get_task_metadata("missing-id", Some("Cognia Task"))
            .expect("lookup by name")
            .expect("exists by name");
        assert_eq!(by_name.name, "Cognia Task");
    }
}
