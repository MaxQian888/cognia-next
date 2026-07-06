//! Process-wide A2A task snapshot store.
//!
//! `message/send` completes synchronously and records the terminal [`Task`]
//! snapshot here so a later `tasks/get` / `tasks/cancel` on the same task id
//! resolves. Bounded like the ACP resume index — oldest-insertion eviction is
//! fine because A2A clients poll recent tasks.

use std::sync::Mutex;

use serde_json::Value;

/// Cap the task store so abandoned tasks can't grow it unboundedly.
const TASK_STORE_CAP: usize = 512;

static TASK_STORE: once_cell::sync::Lazy<Mutex<Vec<(String, Value)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Vec::new()));

/// Record (or replace) the snapshot for a task id.
pub fn record_task(task_id: &str, task: Value) {
    let mut store = TASK_STORE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(slot) = store.iter_mut().find(|(id, _)| id == task_id) {
        slot.1 = task;
        return;
    }
    if store.len() >= TASK_STORE_CAP {
        store.remove(0);
    }
    store.push((task_id.to_string(), task));
}

/// Look up a recorded task snapshot.
pub fn lookup_task(task_id: &str) -> Option<Value> {
    let store = TASK_STORE.lock().unwrap_or_else(|p| p.into_inner());
    store
        .iter()
        .find(|(id, _)| id == task_id)
        .map(|(_, task)| task.clone())
}

#[cfg(test)]
pub fn reset_task_store_for_tests() {
    TASK_STORE.lock().unwrap_or_else(|p| p.into_inner()).clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn record_and_lookup_roundtrip() {
        reset_task_store_for_tests();
        assert!(lookup_task("nope").is_none());

        record_task("t1", json!({ "id": "t1", "status": { "state": "completed" } }));
        assert_eq!(lookup_task("t1").unwrap()["status"]["state"], "completed");

        // Replace in place — no duplicate.
        record_task("t1", json!({ "id": "t1", "status": { "state": "canceled" } }));
        assert_eq!(lookup_task("t1").unwrap()["status"]["state"], "canceled");
        reset_task_store_for_tests();
    }

    #[test]
    fn evicts_oldest_at_cap() {
        reset_task_store_for_tests();
        for i in 0..(TASK_STORE_CAP + 5) {
            record_task(&format!("t{i}"), json!({ "id": format!("t{i}") }));
        }
        assert!(lookup_task("t0").is_none());
        assert!(lookup_task(&format!("t{}", TASK_STORE_CAP + 4)).is_some());
        reset_task_store_for_tests();
    }
}
