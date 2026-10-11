//! A host's own update settings and catalog trust, in its data dir.
//!
//! The channel is the owner's: their device pushes the channel its Update
//! Center follows when it pairs and whenever it changes (ADR-0224 A10), and
//! the host panel can change it. Auto-update is on unless someone turned it
//! off. The rollout bucket is drawn once from local randomness and never
//! derived from an account or device id, like the app's
//! (`lib/updates/rollout.ts`).

use std::path::{Path, PathBuf};

use cognia_update_catalog::client::TrustFile;
use serde::{Deserialize, Serialize};

/// `<data dir>/updates`.
pub const UPDATES_DIR: &str = "updates";
const SETTINGS_FILE: &str = "host-update.json";
const TRUST_FILE: &str = "trust.json";

/// Channels an owner may put a host on. `canary` is internal, as in the app.
pub const SELECTABLE_CHANNELS: [&str; 2] = ["stable", "beta"];

/// The channel `raw` names, if it is one a host may follow.
pub fn normalize_channel(raw: &str) -> Option<&'static str> {
    let raw = raw.trim();
    SELECTABLE_CHANNELS
        .into_iter()
        .find(|channel| channel.eq_ignore_ascii_case(raw))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostUpdateSettings {
    pub channel: String,
    pub auto_update: bool,
    /// 0..10000, drawn once.
    pub rollout_bucket: u32,
    /// The device that last set the channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_set_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_set_at_ms: Option<i64>,
}

impl HostUpdateSettings {
    fn fresh() -> Self {
        Self {
            channel: "stable".to_owned(),
            auto_update: true,
            rollout_bucket: rand::random::<u32>() % 10_000,
            channel_set_by: None,
            channel_set_at_ms: None,
        }
    }
}

/// Reads and writes the settings and trust files.
#[derive(Debug, Clone)]
pub struct SettingsStore {
    dir: PathBuf,
}

impl SettingsStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join(UPDATES_DIR),
        }
    }

    /// The saved settings, or fresh ones saved now so the bucket stays put.
    pub fn load(&self) -> HostUpdateSettings {
        let saved: Option<HostUpdateSettings> =
            read_json(&self.dir.join(SETTINGS_FILE)).filter(|settings: &HostUpdateSettings| {
                normalize_channel(&settings.channel).is_some() && settings.rollout_bucket < 10_000
            });
        match saved {
            Some(settings) => settings,
            None => {
                let fresh = HostUpdateSettings::fresh();
                if let Err(error) = self.save(&fresh) {
                    log::warn!("host update: could not save fresh settings: {error}");
                }
                fresh
            }
        }
    }

    pub fn save(&self, settings: &HostUpdateSettings) -> Result<(), String> {
        write_json(&self.dir.join(SETTINGS_FILE), settings)
    }

    /// Where this host keeps the trust state it verifies catalogs with.
    pub fn trust(&self) -> TrustFile {
        TrustFile::new(self.dir.join(TRUST_FILE))
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("settings path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".{}.tmp", rand::random::<u64>()));
    let body = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    std::fs::write(&temp, body).map_err(|error| error.to_string())?;
    std::fs::rename(&temp, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_starts_on_stable_with_updates_on_and_keeps_its_bucket() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(tmp.path());
        let first = store.load();
        assert_eq!(first.channel, "stable");
        assert!(first.auto_update);
        assert!(first.rollout_bucket < 10_000);
        assert_eq!(store.load(), first, "the bucket is drawn once");
    }

    #[test]
    fn only_selectable_channels_are_accepted() {
        assert_eq!(normalize_channel(" Beta "), Some("beta"));
        assert_eq!(normalize_channel("stable"), Some("stable"));
        assert_eq!(normalize_channel("canary"), None);
        assert_eq!(normalize_channel("nightly"), None);
    }

    #[test]
    fn a_damaged_settings_file_is_replaced_not_trusted() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(tmp.path());
        std::fs::create_dir_all(tmp.path().join(UPDATES_DIR)).unwrap();
        std::fs::write(
            tmp.path().join(UPDATES_DIR).join(SETTINGS_FILE),
            r#"{"channel":"canary","autoUpdate":false,"rolloutBucket":5}"#,
        )
        .unwrap();
        assert_eq!(store.load().channel, "stable");
    }
}
