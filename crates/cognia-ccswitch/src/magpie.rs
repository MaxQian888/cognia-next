//! Read-only provider-relay discovery of Magpie's configured gateway port.
//! Kept separate from CCSwitch's SQLite reader: Magpie owns its own JSON config.

use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

const DEFAULT_PORT: u16 = 3425;
const MAX_SETTINGS_BYTES: u64 = 64 * 1024;

fn settings_path(xdg: Option<PathBuf>, home: Option<PathBuf>) -> Result<PathBuf, String> {
    let root = xdg
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| home.map(|p| p.join(".config")))
        .ok_or("Home directory unavailable")?;
    Ok(root.join("magpie/settings.json"))
}

fn read_port(path: &Path) -> Result<u16, String> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(DEFAULT_PORT),
        Err(error) => return Err(format!("Could not read Magpie settings: {error}")),
    };
    if !meta.is_file() || meta.len() > MAX_SETTINGS_BYTES {
        return Err("Magpie settings must be a regular file smaller than 64 KiB".into());
    }
    let file = File::open(path).map_err(|e| format!("Could not read Magpie settings: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("Magpie settings exceed 64 KiB".into());
    }
    let settings: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid Magpie settings: {e}"))?;
    if !settings.is_object() {
        return Err("Magpie settings must be a JSON object".into());
    }
    match settings.get("port") {
        None => Ok(DEFAULT_PORT),
        Some(value) => value
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p > 0)
            .ok_or_else(|| "Magpie port must be between 1 and 65535".into()),
    }
}

/// Read Magpie's device-local relay settings without consulting CCSwitch SQLite.
pub fn gateway_port() -> Result<u16, String> {
    let path = settings_path(
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        dirs::home_dir(),
    )?;
    read_port(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_location_matches_upstream_on_every_desktop() {
        assert_eq!(
            settings_path(None, Some("/home/user".into())).unwrap(),
            PathBuf::from("/home/user/.config/magpie/settings.json")
        );
        assert_eq!(
            settings_path(Some("/config".into()), Some("/home/user".into())).unwrap(),
            PathBuf::from("/config/magpie/settings.json")
        );
    }

    #[test]
    fn reads_the_port_without_writing_the_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(read_port(&path).unwrap(), DEFAULT_PORT);
        for (input, expected) in [
            ("{}", DEFAULT_PORT),
            ("{\"port\":18995,\"other\":true}", 18995),
        ] {
            std::fs::write(&path, input).unwrap();
            assert_eq!(read_port(&path).unwrap(), expected);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), input);
        }
    }

    #[test]
    fn rejects_invalid_ports_and_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        for input in [
            "[]",
            "invalid",
            "{\"port\":0}",
            "{\"port\":65536}",
            "{\"port\":\"3425\"}",
        ] {
            std::fs::write(&path, input).unwrap();
            assert!(read_port(&path).is_err(), "{input}");
        }
        std::fs::write(&path, vec![b' '; MAX_SETTINGS_BYTES as usize + 1]).unwrap();
        assert!(read_port(&path).is_err());
    }
}
