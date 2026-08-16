//! Append-only audit trail for RCE-grade companion RPCs (ADR-0059 D6 / R11).
//!
//! Every `spawn/send/kill/status_external_agent` decision — allow AND deny —
//! appends one JSON line to `<data_dir>/audit.log`. The log is the forensic
//! record for the headless server's most dangerous surface, so writes are
//! best-effort-but-loud (a failed write logs an error; it never blocks the
//! request path) and the file rotates by size (`audit.log.1` keeps one
//! generation).
//!
//! Installed process-wide by `cognia-server` at boot (same module-global
//! idiom as `TLS_FINGERPRINT`); absent installation (desktop, tests) the
//! record call is a no-op.

use std::io::Write;
use std::path::PathBuf;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};

/// Rotate once the log exceeds this size (checked before each append).
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

struct AuditLog {
    path: PathBuf,
}

impl AuditLog {
    fn append(&self, line: &str) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("audit dir: {e}"))?;
        }
        self.rotate_if_needed()?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| format!("audit open: {e}"))?;
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|e| format!("audit write: {e}"))
    }

    fn rotate_if_needed(&self) -> Result<(), String> {
        let size = match std::fs::metadata(&self.path) {
            Ok(meta) => meta.len(),
            Err(_) => return Ok(()), // no file yet
        };
        if size < MAX_LOG_BYTES {
            return Ok(());
        }
        let rotated = self.path.with_extension("log.1");
        // Replace the previous generation; two generations bound disk use.
        let _ = std::fs::remove_file(&rotated);
        std::fs::rename(&self.path, &rotated).map_err(|e| format!("audit rotate: {e}"))
    }
}

static AUDIT: Lazy<Mutex<Option<AuditLog>>> = Lazy::new(|| Mutex::new(None));

/// Install the audit log at `<data_dir>/audit.log`. Called by
/// `cognia-server` at boot.
pub fn install(data_dir: &std::path::Path) {
    *AUDIT.lock() = Some(AuditLog {
        path: data_dir.join("audit.log"),
    });
}

/// Test-only: point the audit log somewhere explicit / clear it.
#[cfg(test)]
pub(crate) fn install_at_for_testing(path: Option<PathBuf>) {
    *AUDIT.lock() = path.map(|path| AuditLog { path });
}

/// Serializes every test that installs the process-global audit log.
///
/// `install_at_for_testing` REPLACES the slot, so `cargo test` — one binary,
/// threads in parallel — will happily point the log at another test's temp file,
/// or clear it entirely, midway through a test that is about to assert a record
/// was written. Whichever loses the race reads an empty log and fails, or worse
/// passes because it asserted absence.
///
/// Hold it for the whole test body.
#[cfg(test)]
pub(crate) fn test_guard() -> std::sync::MutexGuard<'static, ()> {
    static AUDIT_TEST_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    // Poisoning only means an earlier test panicked while holding the guard;
    // every test installs its own path on entry, so the state is still usable
    // and failing all subsequent tests would bury the original failure.
    AUDIT_TEST_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Append one audit record. `fields` is merged into the envelope
/// (`ts_ms`, `kind`, `device_id`, `scope`, `decision`). No-op when no log is
/// installed; a failed write logs an error but never fails the request.
pub fn record(kind: &str, device_id: &str, scope: &str, decision: &str, fields: Value) {
    let guard = AUDIT.lock();
    let Some(log) = guard.as_ref() else {
        return;
    };
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let mut entry = json!({
        "ts_ms": ts_ms,
        "kind": kind,
        "device_id": device_id,
        "scope": scope,
        "decision": decision,
    });
    if let (Some(obj), Some(extra)) = (entry.as_object_mut(), fields.as_object()) {
        for (k, v) in extra {
            obj.insert(k.clone(), v.clone());
        }
    }
    let line = entry.to_string();
    if let Err(e) = log.append(&line) {
        log::error!("audit log write failed: {e} (entry: {line})");
    }
}

/// Append an audit record without blocking the async companion request loop on
/// directory creation, rotation, or disk writes.
pub async fn record_async(kind: &str, device_id: &str, scope: &str, decision: &str, fields: Value) {
    let kind = kind.to_owned();
    let device_id = device_id.to_owned();
    let scope = scope.to_owned();
    let decision = decision.to_owned();
    if let Err(error) =
        tokio::task::spawn_blocking(move || record(&kind, &device_id, &scope, &decision, fields))
            .await
    {
        log::error!("audit log task failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The audit slot is process-global; this single test covers install,
    /// append, shape, and rotation sequentially to avoid parallel races.
    #[test]
    fn records_allow_and_deny_lines_and_rotates() {
        let _guard = test_guard();
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("audit.log");
        install_at_for_testing(Some(path.clone()));

        record(
            "external_agent_spawn",
            "brain-local",
            "service",
            "allow",
            json!({ "command": "claude", "agent_id": "a1", "dropped_env_keys": ["LD_PRELOAD"] }),
        );
        record(
            "external_agent_spawn",
            "brain-local",
            "service",
            "deny",
            json!({ "command": "bash", "reason": "not allowlisted" }),
        );

        let content = std::fs::read_to_string(&path).expect("audit file");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        let allow: Value = serde_json::from_str(lines[0]).expect("jsonl");
        assert_eq!(allow["kind"], "external_agent_spawn");
        assert_eq!(allow["decision"], "allow");
        assert_eq!(allow["scope"], "service");
        assert_eq!(allow["dropped_env_keys"][0], "LD_PRELOAD");
        assert!(allow["ts_ms"].is_number());
        let deny: Value = serde_json::from_str(lines[1]).expect("jsonl");
        assert_eq!(deny["decision"], "deny");
        assert_eq!(deny["reason"], "not allowlisted");

        // Rotation: blow past the cap, then append — the old file moves to
        // `.log.1` and a fresh line starts the new file.
        std::fs::write(&path, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        record(
            "external_agent_kill",
            "brain-local",
            "service",
            "allow",
            json!({}),
        );
        let rotated = path.with_extension("log.1");
        assert!(rotated.exists(), "previous generation preserved");
        let fresh = std::fs::read_to_string(&path).unwrap();
        assert_eq!(fresh.lines().count(), 1);

        // Uninstalled → no-op (must not panic or recreate the file).
        install_at_for_testing(None);
        std::fs::remove_file(&path).unwrap();
        record("external_agent_kill", "d", "device", "deny", json!({}));
        assert!(!path.exists());
    }
}
