//! Durable Host audit, deliberately independent of the Companion audit slot.
//! Only action categories and counts are retained: never input payloads.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
};

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub struct RemoteDesktopAudit {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl RemoteDesktopAudit {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("remote-desktop-audit.jsonl"),
            write_lock: Mutex::new(()),
        }
    }

    fn append(&self, entry: &Value) -> std::io::Result<()> {
        let _guard = self.write_lock.lock();
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match std::fs::metadata(&self.path) {
            Ok(meta) if meta.len() >= MAX_LOG_BYTES => {
                let rotated = self.path.with_extension("jsonl.1");
                match std::fs::remove_file(&rotated) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
                std::fs::rename(&self.path, rotated)?;
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(file, "{entry}")?;
        file.sync_data()
    }
}

static AUDIT: LazyLock<Mutex<Option<Arc<RemoteDesktopAudit>>>> = LazyLock::new(|| Mutex::new(None));

pub fn install(data_dir: &Path) {
    *AUDIT.lock() = Some(Arc::new(RemoteDesktopAudit::new(data_dir)));
}

fn entry(
    kind: &str,
    target_kind: &str,
    target_id: &str,
    principal: &str,
    decision: &str,
    fence: u64,
    fields: Value,
) -> Option<Value> {
    if !matches!(
        kind,
        "remote_desktop.lease.acquire"
            | "remote_desktop.lease.renew"
            | "remote_desktop.lease.release"
            | "remote_desktop.lease.expire"
            | "remote_desktop.lease.takeover"
            | "remote_desktop.lease.refused"
            | "remote_desktop.input"
            | "remote_desktop.input.quarantined"
            | "remote_desktop.agent.preempted"
    ) || !matches!(target_kind, "sandbox" | "managed-desktop")
    {
        return None;
    }
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let mut value = json!({ "ts_ms":ts_ms, "kind":kind, "target_kind":target_kind,
        "target_id":target_id, "principal":principal, "decision":decision, "fence":fence });
    // Allowlisting also prevents caller fields from replacing the envelope.
    if let Some(action) = fields.get("action_kind").and_then(Value::as_str) {
        if matches!(action, "click" | "drag" | "scroll" | "key" | "text") {
            value["action_kind"] = json!(action);
        }
    }
    if let Some(count) = fields.get("count").and_then(Value::as_u64) {
        value["count"] = json!(count);
    }
    if let Some(expires_at) = fields.get("expires_at").and_then(Value::as_i64) {
        value["expires_at"] = json!(expires_at);
    }
    Some(value)
}

fn pending(
    kind: &str,
    target_kind: &str,
    target_id: &str,
    principal: &str,
    decision: &str,
    fence: u64,
    fields: Value,
) -> Option<(Arc<RemoteDesktopAudit>, Value)> {
    let audit = AUDIT.lock().clone()?;
    Some((
        audit,
        entry(
            kind,
            target_kind,
            target_id,
            principal,
            decision,
            fence,
            fields,
        )?,
    ))
}

fn append(audit: &RemoteDesktopAudit, entry: &Value) {
    if let Err(error) = audit.append(entry) {
        log::error!("remote desktop audit write failed: {error}");
    }
}

/// Await the durable append without blocking an asynchronous request worker.
pub async fn record_async(
    kind: &str,
    target_kind: &str,
    target_id: &str,
    principal: &str,
    decision: &str,
    fence: u64,
    fields: Value,
) {
    let Some((audit, entry)) = pending(
        kind,
        target_kind,
        target_id,
        principal,
        decision,
        fence,
        fields,
    ) else {
        return;
    };
    if let Err(error) = tokio::task::spawn_blocking(move || append(&audit, &entry)).await {
        log::error!("remote desktop audit task failed: {error}");
    }
}

/// Synchronous state transitions cannot await, but still offload disk writes.
/// Tokio waits for started blocking tasks when the runtime shuts down.
pub fn record_background(
    kind: &str,
    target_kind: &str,
    target_id: &str,
    principal: &str,
    decision: &str,
    fence: u64,
    fields: Value,
) {
    let Some((audit, entry)) = pending(
        kind,
        target_kind,
        target_id,
        principal,
        decision,
        fence,
        fields,
    ) else {
        return;
    };
    match tokio::runtime::Handle::try_current() {
        Ok(runtime) => {
            runtime.spawn_blocking(move || append(&audit, &entry));
        }
        Err(_) => append(&audit, &entry),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_fields_are_redacted_and_cannot_override_envelope() {
        let record = entry(
            "remote_desktop.input",
            "sandbox",
            "desktop",
            "owner",
            "allow",
            7,
            json!({"action_kind":"text", "count":5, "text":"secret", "chord":"secret",
                "point":{"x":5,"y":9}, "token":"secret", "kind":"secret", "fence":99}),
        )
        .unwrap();
        assert_eq!(record["action_kind"], "text");
        assert_eq!(record["count"], 5);
        assert_eq!(record["fence"], 7);
        assert_eq!(record["target_id"], "desktop");
        assert!(!record.to_string().contains("secret"));
        assert_eq!(record.as_object().unwrap().len(), 9);
        let record = entry(
            "remote_desktop.input",
            "sandbox",
            "desktop",
            "owner",
            "deny",
            7,
            json!({"action_kind":"secret", "count":-1}),
        )
        .unwrap();
        assert!(record.get("action_kind").is_none());
        assert!(record.get("count").is_none());
        assert!(entry("secret", "sandbox", "id", "p", "deny", 0, json!({})).is_none());
    }

    #[tokio::test]
    async fn installed_sink_records_async_and_retains_one_rotated_generation() {
        let tmp = tempfile::tempdir().unwrap();
        install(tmp.path());
        let path = tmp.path().join("remote-desktop-audit.jsonl");
        record_async(
            "remote_desktop.lease.acquire",
            "managed-desktop",
            "id",
            "p",
            "allow",
            1,
            json!({"expires_at":123}),
        )
        .await;
        let value: Value =
            serde_json::from_str(std::fs::read_to_string(&path).unwrap().trim()).unwrap();
        assert_eq!(value["expires_at"], 123);
        assert!(value["ts_ms"].is_number());
        let rotated = path.with_extension("jsonl.1");
        std::fs::write(&rotated, "old generation").unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(MAX_LOG_BYTES).unwrap();
        record_async(
            "remote_desktop.lease.release",
            "sandbox",
            "id",
            "p",
            "allow",
            2,
            json!({}),
        )
        .await;
        assert_eq!(std::fs::metadata(&rotated).unwrap().len(), MAX_LOG_BYTES);
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 1);
        *AUDIT.lock() = None;
        std::fs::remove_file(&path).unwrap();
        record_async(
            "remote_desktop.input",
            "sandbox",
            "id",
            "p",
            "allow",
            2,
            json!({}),
        )
        .await;
        assert!(!path.exists());
    }
}
