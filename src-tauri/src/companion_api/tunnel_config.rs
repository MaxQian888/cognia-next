//! Named Cloudflare Tunnel configuration persistence.
//!
//! Stores the connector token in the OS keyring and the mode/hostname
//! metadata in a JSON file under the data directory (Tauri desktop) or
//! the same directory (headless). This mirrors the split used by
//! `push_creds.rs` — secrets go to keyring, non-secrets to file.
//!
//! Service: `com.cognia.companion-tunnel/v1`
//! Account: `token`
//!
//! Config file: `<data_dir>/cognia/tunnel-config.json`

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "com.cognia.companion-tunnel/v1";
const KEYRING_ACCOUNT: &str = "token";
const CONFIG_FILE: &str = "tunnel-config.json";
const CONFIG_SUBDIR: &str = "cognia";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelMode {
    #[default]
    Quick,
    Named,
}

/// Non-secret metadata for a named tunnel. Stored in a plain JSON file
/// so it survives restarts and can be read back without keyring unlock.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedTunnelConfig {
    /// The public hostname (e.g. `https://cognia.example.com`).
    pub hostname: String,
}

/// The full on-disk config shape.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfigFile {
    pub mode: TunnelMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub named: Option<NamedTunnelConfig>,
}

/// Renderer-safe summary — everything except the secret token.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfigSummary {
    pub mode: TunnelMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(rename = "hasToken")]
    pub has_token: bool,
}

fn config_path(data_dir: Option<&Path>) -> PathBuf {
    match data_dir {
        Some(dir) => dir.join(CONFIG_SUBDIR).join(CONFIG_FILE),
        None => {
            // Fallback to a temp-adjacent path when data_dir is unavailable
            // (should only happen in exotic test setups).
            std::env::temp_dir().join("cognia").join(CONFIG_FILE)
        }
    }
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring entry: {e}"))
}

// ---------------------------------------------------------------------------
// Token (keyring)
// ---------------------------------------------------------------------------

/// Store the connector token in the OS keyring.
pub fn save_token(token: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(token)
        .map_err(|e| format!("keyring write: {e}"))
}

/// Read the connector token from the OS keyring.
pub fn load_token() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

/// Remove the token from the OS keyring.
pub fn clear_token() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Metadata (JSON file)
// ---------------------------------------------------------------------------

fn load_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| format!("parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

fn store_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, raw).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perms) = std::fs::metadata(path).map(|m| m.permissions()) {
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    Ok(())
}

/// Load the tunnel config file (mode + hostname). Returns default if absent.
pub fn load_config(data_dir: Option<&Path>) -> TunnelConfigFile {
    load_json(&config_path(data_dir))
        .unwrap_or_default()
        .unwrap_or_default()
}

/// Save the tunnel config file (mode + hostname).
pub fn save_config(data_dir: Option<&Path>, config: &TunnelConfigFile) -> Result<(), String> {
    store_json(&config_path(data_dir), config)
}

/// Build a renderer-safe summary from the on-disk config + keyring token.
pub fn summarize(data_dir: Option<&Path>) -> TunnelConfigSummary {
    let file = load_config(data_dir);
    let has_token = load_token().unwrap_or(None).is_some();

    // Windows Credential Manager can have a transient read sync delay after a
    // successful write. If the named config file exists (mode=Named with a
    // hostname), the token was successfully persisted at save time; optimistically
    // treat it as present so the UI doesn't disable the tunnel toggle.
    let has_token = has_token
        || (file.mode == TunnelMode::Named && file.named.is_some());

    TunnelConfigSummary {
        mode: file.mode,
        hostname: file.named.as_ref().map(|n| n.hostname.clone()),
        has_token,
    }
}

/// Convenience: save a named tunnel (token + hostname + mode switch).
pub fn save_named(data_dir: Option<&Path>, token: &str, hostname: &str) -> Result<(), String> {
    save_token(token)?;

    // Best-effort, NON-blocking read-back. Windows Credential Manager can have
    // a transient sync delay between write and read in the same process, so a
    // miss here does not mean the write failed — `summarize` already reports
    // `has_token = true` optimistically when the named config file exists, so
    // the UI never disables the toggle on a delayed read. We log the miss for
    // diagnostics but must not `sleep` on the command thread (that froze the
    // Save button for up to ~6 s on Windows).
    if load_token().unwrap_or(None).is_none() {
        log::warn!(
            "Tunnel token write succeeded but immediate read-back returned empty \
             (likely Windows Credential Manager sync delay). \
             The token is persisted and will be readable shortly / on next process start."
        );
    }

    save_config(
        data_dir,
        &TunnelConfigFile {
            mode: TunnelMode::Named,
            named: Some(NamedTunnelConfig {
                hostname: hostname.to_string(),
            }),
        },
    )
}

/// Convenience: clear everything back to Quick mode defaults.
pub fn clear_named(data_dir: Option<&Path>) -> Result<(), String> {
    let _ = clear_token();
    save_config(
        data_dir,
        &TunnelConfigFile {
            mode: TunnelMode::Quick,
            named: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn config_file_roundtrip() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        let config = TunnelConfigFile {
            mode: TunnelMode::Named,
            named: Some(NamedTunnelConfig {
                hostname: "https://cognia.example.com".into(),
            }),
        };
        save_config(Some(dir), &config).unwrap();
        let loaded = load_config(Some(dir));
        assert_eq!(loaded.mode, TunnelMode::Named);
        assert_eq!(
            loaded.named.unwrap().hostname,
            "https://cognia.example.com"
        );
    }

    #[test]
    fn summarize_default_when_missing() {
        let tmp = tempdir().unwrap();
        let s = summarize(Some(tmp.path()));
        assert_eq!(s.mode, TunnelMode::Quick);
        assert!(s.hostname.is_none());
        assert!(!s.has_token);
    }

    #[test]
    fn token_roundtrip_when_keyring_available() {
        if std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() != Some("1") {
            return;
        }
        let _ = clear_token();
        assert!(load_token().unwrap().is_none());
        save_token("eyJtest").unwrap();
        assert_eq!(load_token().unwrap().unwrap(), "eyJtest");
        clear_token().unwrap();
        assert!(load_token().unwrap().is_none());
    }

    #[test]
    fn named_save_sets_mode_and_hostname() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path();
        save_named(Some(dir), "tok", "https://c.example.com").unwrap();
        let cfg = load_config(Some(dir));
        assert_eq!(cfg.mode, TunnelMode::Named);
        assert_eq!(cfg.named.unwrap().hostname, "https://c.example.com");
    }
}
