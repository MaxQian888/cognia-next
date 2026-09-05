//! Persisted signaling / relay configuration for a headless Host (ADR-0170).
//!
//! The desktop keeps this in `AppSettings` and re-pushes it through
//! `companion_signaling_configure` on every boot, so it never needed a file.
//! A headless `cognia-server` has no renderer to do that: before this module
//! its signaling URL came from `COGNIA_SIGNALING_URL` at start and its ICE
//! servers were hard-coded, and the same `companion_signaling_configure`
//! that an owner device can now send over the host-admin plane would have
//! lasted exactly until the next restart.
//!
//! Follows [`super::reachability_config`]: a plain JSON file under the data
//! dir, `0o600`, absent file == "use the defaults". TURN credentials are the
//! only secret and they are short-lived by construction, so there is no
//! keyring leg.
//!
//! Config file: `<data_dir>/cognia/signaling.json`

use std::path::{Path, PathBuf};

use super::signaling::SignalingConfigPatch;

const CONFIG_FILE: &str = "signaling.json";
const CONFIG_SUBDIR: &str = "cognia";

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CONFIG_SUBDIR).join(CONFIG_FILE)
}

/// The saved patch, or `None` when nothing was ever saved (or the file is
/// unreadable, which is logged and treated the same: the defaults are the
/// safe answer and the next save overwrites the damage).
pub fn load(data_dir: Option<&Path>) -> Option<SignalingConfigPatch> {
    let path = config_path(data_dir?);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            log::warn!("signaling config: could not read {}: {error}", path.display());
            return None;
        }
    };
    match serde_json::from_str(&raw) {
        Ok(config) => Some(config),
        Err(error) => {
            log::warn!("signaling config: {} is not valid: {error}", path.display());
            None
        }
    }
}

pub fn save(data_dir: Option<&Path>, patch: &SignalingConfigPatch) -> Result<(), String> {
    let Some(data_dir) = data_dir else {
        return Err("no data directory to persist the signaling config into".into());
    };
    let path = config_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(patch).map_err(|error| error.to_string())?;
    std::fs::write(&path, raw).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::signaling::IceServerSpec;

    #[test]
    fn round_trips_and_reads_absent_as_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(load(Some(dir.path())).is_none());
        let patch = SignalingConfigPatch {
            enabled: true,
            signaling_url: "wss://relay.test/signaling".into(),
            ice_servers: vec![IceServerSpec {
                urls: vec!["stun:s.test:3478".into()],
                username: None,
                credential: None,
            }],
            turn_servers: vec![],
        };
        save(Some(dir.path()), &patch).expect("save");
        let loaded = load(Some(dir.path())).expect("loaded");
        assert_eq!(loaded.signaling_url, patch.signaling_url);
        assert_eq!(loaded.ice_servers.len(), 1);
        assert!(loaded.enabled);
    }

    #[test]
    fn a_corrupt_file_reads_as_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cognia").join("signaling.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert!(load(Some(dir.path())).is_none());
    }

    #[test]
    fn saving_without_a_data_dir_is_an_error() {
        let patch = SignalingConfigPatch {
            enabled: false,
            signaling_url: String::new(),
            ice_servers: vec![],
            turn_servers: vec![],
        };
        assert!(save(None, &patch).is_err());
    }
}
