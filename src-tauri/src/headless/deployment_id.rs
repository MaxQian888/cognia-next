//! Stable identity of one Headless deployment (one server, one data volume).
//!
//! The container exec backends stamp it on every runner they create and
//! reap only what carries the same value, so several deployments can share
//! one Docker daemon or one Kubernetes namespace without sweeping each
//! other's live agents at boot (`crates/cognia-external-agent`,
//! `DEPLOYMENT_LABEL`).
//!
//! Resolution order: `COGNIA_DEPLOYMENT_ID` when the operator set one (the
//! compose suite passes `${COGNIA_INSTANCE}`), else a random id minted once
//! and persisted under the data directory. Inside a container the data path
//! is always `/data`, so the path itself cannot serve as the identity. The
//! persisted file can.

use std::path::{Path, PathBuf};

use crate::external_agent::container_backend::{validate_deployment_id, DEPLOYMENT_ID_ENV};

const DEPLOYMENT_ID_FILE_NAME: &str = "deployment-id";

fn deployment_id_path(data_dir: &Path) -> PathBuf {
    data_dir.join(".cognia").join(DEPLOYMENT_ID_FILE_NAME)
}

/// Resolve the deployment id for `data_dir`, minting and persisting one on
/// first use. Fails only when an explicit value is malformed or the data
/// directory cannot be written, both of which are boot-time configuration
/// errors the operator has to see.
pub fn resolve(data_dir: &Path) -> Result<String, String> {
    resolve_from(std::env::var(DEPLOYMENT_ID_ENV).ok().as_deref(), data_dir)
}

/// The pure half of [`resolve`]: `explicit` is the environment value, if any.
pub fn resolve_from(explicit: Option<&str>, data_dir: &Path) -> Result<String, String> {
    if let Some(value) = explicit.filter(|value| !value.trim().is_empty()) {
        return validate_deployment_id(value)
            .map_err(|error| format!("invalid {DEPLOYMENT_ID_ENV}: {error}"));
    }

    let path = deployment_id_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(stored) => {
            return validate_deployment_id(&stored).map_err(|error| {
                format!(
                    "persisted deployment id {} is unusable ({error}); delete the file to mint a new one",
                    path.display()
                )
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "read persisted deployment id {}: {error}",
                path.display()
            ));
        }
    }

    let minted = format!("cognia-{}", uuid::Uuid::new_v4().simple());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    std::fs::write(&path, format!("{minted}\n"))
        .map_err(|error| format!("persist deployment id {}: {error}", path.display()))?;
    Ok(minted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_value_wins_and_is_validated() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            resolve_from(Some(" cognia-prod "), tmp.path()).unwrap(),
            "cognia-prod"
        );
        // An explicit id never touches the disk.
        assert!(!deployment_id_path(tmp.path()).exists());

        let error = resolve_from(Some("bad value"), tmp.path()).unwrap_err();
        assert!(error.starts_with("invalid COGNIA_DEPLOYMENT_ID"), "{error}");
    }

    #[test]
    fn minted_id_is_persisted_and_stable_across_restarts() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let first = resolve_from(None, tmp.path()).unwrap();
        let second = resolve_from(Some(""), tmp.path()).unwrap();
        assert_eq!(first, second);
        assert!(first.starts_with("cognia-"));
        assert_eq!(validate_deployment_id(&first).unwrap(), first);

        let stored = std::fs::read_to_string(deployment_id_path(tmp.path())).unwrap();
        assert_eq!(stored.trim(), first);
    }

    #[test]
    fn two_data_directories_get_two_identities() {
        let a = tempfile::tempdir().expect("tempdir");
        let b = tempfile::tempdir().expect("tempdir");
        assert_ne!(
            resolve_from(None, a.path()).unwrap(),
            resolve_from(None, b.path()).unwrap()
        );
    }

    #[test]
    fn a_corrupt_persisted_id_is_reported_with_its_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = deployment_id_path(tmp.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not a label/value").unwrap();

        let error = resolve_from(None, tmp.path()).unwrap_err();
        assert!(error.contains(&path.display().to_string()), "{error}");
        assert!(error.contains("delete the file"), "{error}");
    }
}
