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
            | "remote_desktop.target.save"
            | "remote_desktop.target.delete"
            | "remote_desktop.credential.set"
            | "remote_desktop.credential.clear"
            | "remote_desktop.endpoint.confirm"
            | "remote_desktop.session.open"
            | "remote_desktop.session.close"
            | "remote_desktop.session.failed"
            | "remote_desktop.stream.open"
            | "remote_desktop.stream.claim"
            | "remote_desktop.stream.revoke"
            | "remote_desktop.stream.revoke_unconfirmed"
            | "remote_desktop.binding.launch"
    ) || !matches!(target_kind, "sandbox" | "managed-desktop" | "external")
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
    // External targets: ids and closed vocabularies only. Hosts, ports and
    // credentials are never logged.
    if let Some(binding) = fields.get("binding_id").and_then(Value::as_str) {
        if crate::target::valid_id(binding) {
            value["binding_id"] = json!(binding);
        }
    }
    for (field, allowed) in [
        ("mode", &["view", "control"][..]),
        ("credential", &["control", "view"][..]),
        ("class", &["private", "public"][..]),
        // Stream grants (ADR-0234 Phase 4): the role only, never a token or URL.
        ("role", &["viewer", "controller"][..]),
        // Web consoles and external apps (Phase 5): never the link or the ID.
        ("access", &["web-console", "external-app"][..]),
        (
            "reason",
            &[
                "closed",
                "expired",
                "preempted",
                "viewer_closed",
                "failed",
                "binding_changed",
                "target_deleted",
            ][..],
        ),
    ] {
        if let Some(text) = fields.get(field).and_then(Value::as_str) {
            if allowed.contains(&text) {
                value[field] = json!(text);
            }
        }
    }
    if let Some(code) = fields.get("code").and_then(Value::as_str) {
        if code.len() <= 64
            && code.starts_with("remote_desktop_")
            && code.chars().all(|c| c.is_ascii_lowercase() || c == '_')
        {
            value["code"] = json!(code);
        }
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
        assert!(entry("remote_desktop.input", "elsewhere", "id", "p", "deny", 0, json!({})).is_none());
    }

    #[test]
    fn stream_grants_record_the_role_and_never_the_token() {
        let record = entry(
            "remote_desktop.stream.claim",
            "sandbox",
            "desktop",
            "local-owner",
            "allowed",
            3,
            json!({"role":"controller", "url":"http://127.0.0.1:1/?token=secret", "token":"secret"}),
        )
        .unwrap();
        assert_eq!(record["role"], "controller");
        assert!(!record.to_string().contains("secret"));
        let record = entry(
            "remote_desktop.stream.open",
            "sandbox",
            "desktop",
            "local-owner",
            "allowed",
            0,
            json!({"role":"admin"}),
        )
        .unwrap();
        assert!(record.get("role").is_none());
        for kind in ["remote_desktop.stream.revoke", "remote_desktop.stream.revoke_unconfirmed"] {
            assert!(entry(kind, "sandbox", "d", "p", "refused", 0, json!({})).is_some());
        }
    }

    #[test]
    fn launches_record_the_access_and_never_the_link_or_peer() {
        let record = entry(
            "remote_desktop.binding.launch",
            "external",
            "target",
            "device:phone",
            "allow",
            0,
            json!({"binding_id":"b1", "access":"external-app",
                "uri":"rustdesk://connection/new/123456789", "url":"https://gw.example.com/#/client/x"}),
        )
        .unwrap();
        assert_eq!(record["access"], "external-app");
        assert_eq!(record["binding_id"], "b1");
        let text = record.to_string();
        assert!(!text.contains("123456789") && !text.contains("gw.example.com"));
        let refused = entry(
            "remote_desktop.binding.launch",
            "external",
            "target",
            "local-owner",
            "deny",
            0,
            json!({"access":"bridge", "code":"remote_desktop_binding_not_launchable"}),
        )
        .unwrap();
        assert!(refused.get("access").is_none());
        assert_eq!(refused["code"], "remote_desktop_binding_not_launchable");
    }

    #[test]
    fn external_fields_are_closed_vocabularies_and_never_endpoints() {
        let record = entry(
            "remote_desktop.session.failed",
            "external",
            "target-1",
            "local-owner",
            "deny",
            0,
            json!({"binding_id":"b_1", "mode":"control", "reason":"failed",
                "code":"remote_desktop_auth_failed", "class":"private", "credential":"view",
                "host":"192.168.1.5", "port":5900, "password":"hunter2"}),
        )
        .unwrap();
        assert_eq!(record["binding_id"], "b_1");
        assert_eq!(record["mode"], "control");
        assert_eq!(record["reason"], "failed");
        assert_eq!(record["code"], "remote_desktop_auth_failed");
        assert_eq!(record["class"], "private");
        assert_eq!(record["credential"], "view");
        let text = record.to_string();
        assert!(!text.contains("192.168") && !text.contains("5900") && !text.contains("hunter2"));
        let record = entry(
            "remote_desktop.session.close",
            "external",
            "target-1",
            "local-owner",
            "allow",
            0,
            json!({"binding_id":"../x", "mode":"admin", "reason":"because",
                "code":"Remote Desktop: 192.168.1.5", "class":"lan"}),
        )
        .unwrap();
        for field in ["binding_id", "mode", "reason", "code", "class"] {
            assert!(record.get(field).is_none(), "{field} must be dropped");
        }
    }

    /// Other tests in this binary record through the same global sink while
    /// it is installed, so this one only reads its own rows.
    fn own_rows(path: &Path, target_id: &str) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|row| row["target_id"] == target_id)
            .collect()
    }

    #[tokio::test]
    async fn installed_sink_records_async_and_retains_one_rotated_generation() {
        let tmp = tempfile::tempdir().unwrap();
        install(tmp.path());
        let path = tmp.path().join("remote-desktop-audit.jsonl");
        record_async(
            "remote_desktop.lease.acquire",
            "managed-desktop",
            "audit-sink-test",
            "p",
            "allow",
            1,
            json!({"expires_at":123}),
        )
        .await;
        let rows = own_rows(&path, "audit-sink-test");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["expires_at"], 123);
        assert!(rows[0]["ts_ms"].is_number());
        let rotated = path.with_extension("jsonl.1");
        std::fs::write(&rotated, "old generation").unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(MAX_LOG_BYTES).unwrap();
        record_async(
            "remote_desktop.lease.release",
            "sandbox",
            "audit-sink-test",
            "p",
            "allow",
            2,
            json!({}),
        )
        .await;
        // A concurrent append may land between `set_len` and the rotation.
        assert!(std::fs::metadata(&rotated).unwrap().len() >= MAX_LOG_BYTES);
        let rows = own_rows(&path, "audit-sink-test");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["kind"], "remote_desktop.lease.release");
        *AUDIT.lock() = None;
        record_async(
            "remote_desktop.input",
            "sandbox",
            "audit-sink-uninstalled",
            "p",
            "allow",
            2,
            json!({}),
        )
        .await;
        assert!(own_rows(&path, "audit-sink-uninstalled").is_empty());
    }
}
