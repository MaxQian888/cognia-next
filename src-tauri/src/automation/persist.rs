//! Disk persistence for automation settings + per-action policy.
//!
//! ADR-0020 — the permission tier / whitelist / policy must survive a restart.
//! Previously the gate booted with `AutomationSettings::default()` every launch
//! and `automation_settings_set` only mutated the in-memory gate, so every
//! configured tier was silently lost (and, after the proxy gained a real
//! permission gate, the External Bridge MCP surface would re-lock on every
//! restart). We persist to JSON files under the same `<data_dir>/cognia/...`
//! tree the VDD marker uses — no `AppHandle` required, so both the boot path
//! and the Tauri command can reach it.

use std::fs;
use std::path::PathBuf;

use super::permission::AutomationSettings;
use super::policy::{Policy, PolicyState};

const BACKUP_KEEP: usize = 5;

fn dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("cognia").join("automation"))
}

fn settings_path() -> Option<PathBuf> {
    dir().map(|d| d.join("settings.json"))
}

fn policy_path() -> Option<PathBuf> {
    dir().map(|d| d.join("policy.json"))
}

/// Load persisted settings, falling back to `default()` on any error (missing
/// file, parse failure, no data dir). Never panics — a corrupt file just means
/// "start from defaults", which is the safe (most-restrictive, everything-off)
/// state.
pub fn load_settings() -> AutomationSettings {
    let Some(path) = settings_path() else {
        return AutomationSettings::default();
    };
    match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => AutomationSettings::default(),
    }
}

/// Best-effort persist. Logs and swallows IO errors — a write failure must not
/// break the in-memory update that already succeeded.
pub fn save_settings(settings: &AutomationSettings) {
    let Some(path) = settings_path() else {
        log::warn!("automation: no data dir; settings not persisted");
        return;
    };
    if let Err(e) = write_json(&path, settings) {
        log::warn!("automation: failed to persist settings: {e}");
    }
}

/// Load the persisted policy, then compile it into a `PolicyState`. A parse or
/// regex-compile failure falls back to the empty default — a persisted policy
/// should already be valid (it was validated at `set` time), but a corrupt
/// file must not brick boot.
pub fn load_policy_state() -> PolicyState {
    let Some(path) = policy_path() else {
        return PolicyState::default();
    };
    let raw: Policy = match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => return PolicyState::default(),
    };
    PolicyState::try_new(raw).unwrap_or_default()
}

/// Best-effort persist of the per-action policy.
pub fn save_policy(policy: &Policy) {
    let Some(path) = policy_path() else {
        log::warn!("automation: no data dir; policy not persisted");
        return;
    };
    if let Err(e) = write_json(&path, policy) {
        log::warn!("automation: failed to persist policy: {e}");
    }
}

fn write_json<T: serde::Serialize>(path: &PathBuf, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let plan = crate::fs_atomic::AtomicWritePlan {
        path: path.clone(),
        expected_mtime: None,
        tmp_suffix: "tmp".into(),
        backup_suffix: "bak".into(),
    };
    crate::fs_atomic::atomic_write_with_mtime_check(&plan, json.as_bytes())
        .map(|_| {
            crate::fs_atomic::rotate_backups(path, BACKUP_KEEP);
        })
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::permission::Tier;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TMPDIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmpdir() -> PathBuf {
        let base = std::env::temp_dir();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let unique = TMPDIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = base.join(format!(
            "cognia-automation-persist-{}-{nanos}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn settings_roundtrip_via_json() {
        // The persistence is plain serde_json round-trips; assert the shape
        // survives so a future field rename doesn't silently drop the tier.
        let mut settings = AutomationSettings::default();
        settings.enabled = true;
        settings.per_surface.mcp.tier = Tier::Whitelist;
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let back: AutomationSettings = serde_json::from_str(&json).unwrap();
        assert!(back.enabled);
        assert_eq!(back.per_surface.mcp.tier, Tier::Whitelist);
    }

    #[test]
    fn corrupt_settings_falls_back_to_default() {
        let back: AutomationSettings = serde_json::from_str("{ not valid json").unwrap_or_default();
        // Default is the safe, everything-off state.
        assert!(!back.enabled);
        assert_eq!(back.per_surface.mcp.tier, Tier::Off);
    }

    #[test]
    fn policy_roundtrip_and_compile() {
        let mut policy = Policy::default();
        policy.allowed_process_names = vec!["chrome.exe".into()];
        let json = serde_json::to_string_pretty(&policy).unwrap();
        let back: Policy = serde_json::from_str(&json).unwrap();
        assert_eq!(back.allowed_process_names, vec!["chrome.exe".to_string()]);
        // A valid policy compiles into a PolicyState.
        assert!(PolicyState::try_new(back).is_ok());
    }

    #[test]
    fn write_json_preserves_existing_file_as_backup() {
        let dir = tmpdir();
        let path = dir.join("settings.json");
        fs::write(&path, r#"{"enabled":false}"#).unwrap();

        write_json(&path, &json!({ "enabled": true })).unwrap();

        let backup = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("settings.json.bak."))
            })
            .expect("existing settings file should be backed up");
        assert_eq!(fs::read_to_string(backup).unwrap(), r#"{"enabled":false}"#);
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains(r#""enabled": true"#));

        let _ = fs::remove_dir_all(&dir);
    }
}
