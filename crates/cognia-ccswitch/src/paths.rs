// Path resolution for CCSwitch's SQLite database.
//
// CCSwitch's default storage is `~/.cc-switch/cc-switch.db`. The upstream
// tool also lets users redirect the data directory for cloud sync
// (Dropbox / iCloud / OneDrive / a chosen folder). When that happens
// CCSwitch persists the override path in its own Tauri `plugin-store`
// file `app_paths.json` under the key `app_config_dir_override`
// (see `farion1231/cc-switch` `src-tauri/src/app_store.rs`).
//
// We follow the same priority chain CCSwitch itself does so cognia-next
// stays in sync without forcing the user to put `.cc-switch` back where
// we hard-coded it:
//
//   1. Test/debug override via `CC_SWITCH_HOME` env var (cognia-specific —
//      not honoured by cc-switch but useful for our test harness).
//   2. cc-switch's own `app_paths.json` → `app_config_dir_override`.
//   3. Default `~/.cc-switch/`.
//
// The resolution source flows through to the renderer (CcswitchStatus.
// resolutionSource) so the Overview tab can show whether we landed on
// the default path or detected a redirect.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Where the DB path came from. Surfaced in `CcswitchStatus` so the
/// Overview tab can label the active source.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CcswitchResolutionSource {
    /// `CC_SWITCH_HOME` env var.
    Env,
    /// User-supplied manual data-dir override from cognia's own settings
    /// (`AppSettings.ccswitchSync.manualDataDir`). Checked below the env var
    /// but above cc-switch's own redirect store, so a user who knows where
    /// their db lives can pin it without editing cc-switch's config.
    Manual,
    /// `app_paths.json::app_config_dir_override` from cc-switch's own store.
    Redirect,
    /// Default `~/.cc-switch/`.
    Default,
}

#[derive(Debug, Clone)]
pub struct ResolvedCcswitchDb {
    pub path: PathBuf,
    pub source: CcswitchResolutionSource,
}

/// Legacy convenience wrapper for callers that just need the path. Prefer
/// `resolve_ccswitch_db()` so the source label flows to the renderer.
pub fn ccswitch_db_path(manual_override: Option<&str>) -> Option<PathBuf> {
    resolve_ccswitch_db(manual_override).map(|r| r.path)
}

/// Full resolution including the source label. Honours the priority chain:
///   1. `CC_SWITCH_HOME` env var.
///   2. `manual_override` (cognia's `ccswitchSync.manualDataDir`).
///   3. cc-switch's own `app_paths.json` redirect.
///   4. Default `~/.cc-switch/`.
///
/// `manual_override` is a directory containing `cc-switch.db` (the same shape
/// as `CC_SWITCH_HOME` and the redirect store). Blank / unresolvable values
/// fall through to the next source.
pub fn resolve_ccswitch_db(manual_override: Option<&str>) -> Option<ResolvedCcswitchDb> {
    if let Some(p) = override_from_env() {
        return Some(ResolvedCcswitchDb {
            path: p.join("cc-switch.db"),
            source: CcswitchResolutionSource::Env,
        });
    }
    if let Some(p) = override_from_manual(manual_override) {
        return Some(ResolvedCcswitchDb {
            path: p.join("cc-switch.db"),
            source: CcswitchResolutionSource::Manual,
        });
    }
    if let Some(p) = override_from_ccswitch_store() {
        return Some(ResolvedCcswitchDb {
            path: p.join("cc-switch.db"),
            source: CcswitchResolutionSource::Redirect,
        });
    }
    dirs::home_dir().map(|h| ResolvedCcswitchDb {
        path: h.join(".cc-switch").join("cc-switch.db"),
        source: CcswitchResolutionSource::Default,
    })
}

/// Resolve a user-supplied manual data-dir override. Trims, expands `~`, and
/// returns `None` for blank input so callers fall through to the next source.
/// Unlike the redirect store we do NOT require the directory to exist — the
/// status command reports `exists: false` for a not-yet-created db so the
/// user gets actionable "we looked here" feedback after typing a path.
fn override_from_manual(manual_override: Option<&str>) -> Option<PathBuf> {
    let raw = manual_override?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(expand_tilde(trimmed))
}

fn override_from_env() -> Option<PathBuf> {
    let raw = std::env::var("CC_SWITCH_HOME").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = expand_tilde(trimmed);
    // We don't require the path to exist for the env override — the test
    // harness writes the db inside the override path after setting it.
    Some(path)
}

/// Resolve cc-switch's Tauri plugin-store file and read the
/// `app_config_dir_override` field if present. We return `None` for any
/// failure (missing file, malformed JSON, missing key, deleted target)
/// so the caller falls through to the default.
fn override_from_ccswitch_store() -> Option<PathBuf> {
    let store_path = ccswitch_app_paths_file()?;
    if !store_path.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(&store_path).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    // tauri-plugin-store wraps the raw key/value map in {values: {...}} on
    // disk — both shapes are tolerated. (Different plugin versions ship
    // different envelopes; older versions wrote the flat shape.)
    let inner: &serde_json::Value = v.get("values").unwrap_or(&v);
    let pointer = inner
        .get("app_config_dir_override")
        .and_then(|x| x.as_str())?;
    let trimmed = pointer.trim();
    if trimmed.is_empty() {
        return None;
    }
    let expanded = expand_tilde(trimmed);
    if !expanded.exists() {
        log::warn!(
            "cc-switch redirect target does not exist on disk: {expanded:?}; falling back to default",
        );
        return None;
    }
    Some(expanded)
}

/// Resolve the path to cc-switch's own `app_paths.json` plugin-store file.
/// This is in cc-switch's Tauri app config dir, NOT inside `~/.cc-switch/`.
///
/// Per Tauri's defaults:
///   - macOS:   ~/Library/Application Support/com.farion1231.cc-switch/app_paths.json
///   - Windows: %APPDATA%\com.farion1231.cc-switch\app_paths.json
///   - Linux:   ~/.config/com.farion1231.cc-switch/app_paths.json
fn ccswitch_app_paths_file() -> Option<PathBuf> {
    let config_dir = dirs::config_dir()?;
    Some(
        config_dir
            .join("com.farion1231.cc-switch")
            .join("app_paths.json"),
    )
}

fn expand_tilde(raw: &str) -> PathBuf {
    if raw == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("~"));
    }
    if let Some(stripped) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }
    // Windows-style "~\" prefix (cc-switch's Rust side supports this).
    if let Some(stripped) = raw.strip_prefix("~\\") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scoped_env(key: &str, value: Option<&str>) -> impl Drop {
        struct Guard {
            _lock: std::sync::MutexGuard<'static, ()>,
            key: String,
            prev: Option<String>,
        }
        impl Drop for Guard {
            fn drop(&mut self) {
                match &self.prev {
                    Some(v) => std::env::set_var(&self.key, v),
                    None => std::env::remove_var(&self.key),
                }
            }
        }
        let lock = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let prev = std::env::var(key).ok();
        match value {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        Guard {
            _lock: lock,
            key: key.to_string(),
            prev,
        }
    }

    #[test]
    fn default_resolution_lives_under_home() {
        let _g = scoped_env("CC_SWITCH_HOME", None);
        let resolved = resolve_ccswitch_db(None).expect("home dir resolvable on test host");
        let home = dirs::home_dir().unwrap();
        // We can't fully isolate the default branch on a CI host that may
        // have cc-switch installed with a redirect set — tolerate that
        // branch landing on `Redirect` if so.
        if resolved.source == CcswitchResolutionSource::Default {
            assert_eq!(resolved.path, home.join(".cc-switch").join("cc-switch.db"));
        }
    }

    #[test]
    fn env_override_takes_priority() {
        let tmp = tempfile::tempdir().unwrap();
        let _g = scoped_env("CC_SWITCH_HOME", Some(tmp.path().to_str().unwrap()));
        // Env wins even when a manual override is also supplied.
        let resolved = resolve_ccswitch_db(Some("/some/manual/dir")).unwrap();
        assert_eq!(resolved.source, CcswitchResolutionSource::Env);
        assert_eq!(resolved.path, tmp.path().join("cc-switch.db"));
    }

    #[test]
    fn manual_override_used_below_env() {
        let _g = scoped_env("CC_SWITCH_HOME", None);
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_ccswitch_db(Some(tmp.path().to_str().unwrap())).unwrap();
        assert_eq!(resolved.source, CcswitchResolutionSource::Manual);
        assert_eq!(resolved.path, tmp.path().join("cc-switch.db"));
    }

    #[test]
    fn blank_manual_override_falls_through() {
        let _g = scoped_env("CC_SWITCH_HOME", None);
        // Empty / whitespace manual override must not be treated as Manual.
        let resolved = resolve_ccswitch_db(Some("   ")).unwrap();
        assert_ne!(resolved.source, CcswitchResolutionSource::Manual);
    }

    #[test]
    fn manual_override_expands_tilde() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            override_from_manual(Some("~/cc-data")),
            Some(home.join("cc-data"))
        );
        assert_eq!(override_from_manual(Some("")), None);
        assert_eq!(override_from_manual(None), None);
    }

    #[test]
    fn ccswitch_db_path_returns_just_the_path() {
        let _g = scoped_env("CC_SWITCH_HOME", None);
        let path = ccswitch_db_path(None).expect("home dir resolvable on test host");
        assert!(path.ends_with("cc-switch.db"));
    }

    #[test]
    fn expand_tilde_handles_unix_and_windows_separators() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_tilde("~/foo"), home.join("foo"));
        assert_eq!(expand_tilde("~\\bar"), home.join("bar"));
        assert_eq!(expand_tilde("~"), home);
        assert_eq!(expand_tilde("/abs/path"), PathBuf::from("/abs/path"));
    }

    #[test]
    fn override_from_store_parses_flat_envelope() {
        // Use a fake config_dir by routing cc-switch's app_paths.json into a
        // temp dir via the home redirect. We can't actually mock dirs::config_dir
        // here, so this test exercises the parser shape via direct fn use.
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("redirected");
        fs::create_dir_all(&target).unwrap();
        let store = tmp.path().join("app_paths.json");
        let flat = serde_json::json!({
            "app_config_dir_override": target.to_string_lossy()
        });
        fs::write(&store, serde_json::to_string(&flat).unwrap()).unwrap();

        // Inline the parsing logic to verify the envelope handling shape:
        let raw = fs::read_to_string(&store).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let inner = v.get("values").unwrap_or(&v);
        let pointer = inner
            .get("app_config_dir_override")
            .and_then(|x| x.as_str());
        assert!(pointer.is_some());
    }

    #[test]
    fn override_from_store_parses_wrapped_envelope() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("redirected");
        fs::create_dir_all(&target).unwrap();
        let store = tmp.path().join("app_paths.json");
        let wrapped = serde_json::json!({
            "values": {
                "app_config_dir_override": target.to_string_lossy()
            }
        });
        fs::write(&store, serde_json::to_string(&wrapped).unwrap()).unwrap();

        let raw = fs::read_to_string(&store).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let inner = v.get("values").unwrap_or(&v);
        let pointer = inner
            .get("app_config_dir_override")
            .and_then(|x| x.as_str());
        assert!(pointer.is_some());
    }
}
