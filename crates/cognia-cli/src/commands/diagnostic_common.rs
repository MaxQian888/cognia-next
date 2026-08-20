use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use cognia_observability::{installation_key_path, InstallationIdentity};
use ed25519_dalek::SigningKey;
use serde::Serialize;

use crate::cli::OutputFormat;

pub fn cognia_data_dir() -> Result<PathBuf> {
    let dirs = directories::BaseDirs::new()
        .ok_or_else(|| anyhow!("could not determine the local data directory"))?;
    Ok(dirs.data_local_dir().join("Cognia"))
}

pub fn resolve_log_dir(override_dir: Option<PathBuf>) -> Result<PathBuf> {
    Ok(override_dir.unwrap_or(cognia_data_dir()?.join("logs")))
}

pub fn resolve_crash_dir(override_dir: Option<PathBuf>) -> Result<PathBuf> {
    Ok(override_dir.unwrap_or(cognia_data_dir()?.join("crash-reports")))
}

/// This installation's identity — the key that signs both diagnostic packages
/// and the installation proof `/v1/grants/anonymous` verifies.
///
/// The same file the desktop shell uses, so `cognia crash` and the app are one
/// installation to a service: whichever made a submission, either can read its
/// receipt back and delete it.
pub fn installation_identity(override_path: Option<PathBuf>) -> Result<InstallationIdentity> {
    let path = match override_path {
        Some(path) => path,
        None => installation_key_path(&cognia_data_dir()?),
    };
    InstallationIdentity::load_or_create(&path)
        .with_context(|| format!("load diagnostic installation key {}", path.display()))
}

pub fn load_or_create_signing_key(override_path: Option<PathBuf>) -> Result<SigningKey> {
    // Delegates so the CLI and the desktop cannot drift on where the key lives
    // or how it is created; the signing key is the identity's key.
    Ok(installation_identity(override_path)?.signing_key().clone())
}


pub fn emit<T: Serialize + ?Sized>(
    format: OutputFormat,
    value: &T,
    human_lines: &[String],
) -> Result<()> {
    match format {
        OutputFormat::Human => {
            for line in human_lines {
                println!("{line}");
            }
        }
        OutputFormat::Json => println!("{}", serde_json::to_string_pretty(value)?),
        OutputFormat::Ndjson => match serde_json::to_value(value)? {
            serde_json::Value::Array(values) => {
                for value in values {
                    println!("{}", serde_json::to_string(&value)?);
                }
            }
            value => println!("{}", serde_json::to_string(&value)?),
        },
    }
    Ok(())
}

pub fn validate_stem(stem: &str) -> Result<()> {
    if stem.is_empty()
        || stem.contains("..")
        || stem.contains('/')
        || stem.contains('\\')
        || stem.contains(':')
    {
        bail!("invalid crash report stem");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_report_stems() {
        assert!(validate_stem("crash-2026-panic").is_ok());
        for invalid in ["", "../x", "a/b", "a\\b", "C:x"] {
            assert!(validate_stem(invalid).is_err());
        }
    }

    #[test]
    fn explicit_directory_overrides_are_preserved() {
        assert_eq!(
            resolve_log_dir(Some(PathBuf::from("/tmp/logs"))).unwrap(),
            PathBuf::from("/tmp/logs")
        );
        assert_eq!(
            resolve_crash_dir(Some(PathBuf::from("/tmp/crashes"))).unwrap(),
            PathBuf::from("/tmp/crashes")
        );
    }

    #[test]
    fn loads_an_explicit_signing_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("key");
        std::fs::write(&path, hex::encode([5_u8; 32])).unwrap();
        assert_eq!(
            load_or_create_signing_key(Some(path)).unwrap().to_bytes(),
            [5_u8; 32]
        );
    }
}
