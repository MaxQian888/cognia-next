//! Managed IDE Dev Mode: the host-side switch behind the Plugin DevTools
//! "Managed IDE" panel.
//!
//! Off by default and never persisted: it lasts until the app quits or the
//! developer switches it off. While it is on:
//!
//! - the agent channel records the broker trace (the desktop shell subscribes
//!   through [`DevModeState::on_change`] and switches recording with it);
//! - the renderer may simulate permission decisions for the managed IDE;
//! - a plugin installed from a *registered* dev path gets a `local-dev`
//!   verification receipt, which the frontend accepts only after asking this
//!   flag. No new key exists for it: the receipt only says "this came from a
//!   folder the developer registered during this Dev Mode session".
//!
//! Switching it off forgets every registered dev path, and from then on a
//! `local-dev` receipt is worth nothing ([`DevModeState::accepts_receipt`]),
//! so those plugins stop passing verification and the renderer disables them.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;

use crate::marketplace::{VerificationReceipt, VERIFICATION_RECEIPT_FILE};

/// `verifiedVia` of a receipt minted for a registered dev path.
pub const LOCAL_DEV_VERIFICATION: &str = "local-dev";

type Listener = Arc<dyn Fn(bool) + Send + Sync>;

/// What the panel shows: the switch and the folders it trusts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevModeStatus {
    pub enabled: bool,
    pub dev_paths: Vec<String>,
}

/// A registered dev path as the host keeps it (canonical: the form the file
/// watcher reports), and the switch after registering it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPathRegistration {
    pub path: String,
    pub status: DevModeStatus,
}

#[derive(Default)]
struct Inner {
    enabled: bool,
    dev_paths: BTreeSet<PathBuf>,
}

/// The switch and its registered dev paths. One per process
/// ([`DevModeState::global`]); tests build their own.
#[derive(Default)]
pub struct DevModeState {
    inner: Mutex<Inner>,
    listeners: Mutex<Vec<Listener>>,
}

static GLOBAL: once_cell::sync::Lazy<DevModeState> =
    once_cell::sync::Lazy::new(DevModeState::default);

impl DevModeState {
    pub fn global() -> &'static DevModeState {
        &GLOBAL
    }

    pub fn enabled(&self) -> bool {
        self.inner.lock().enabled
    }

    pub fn status(&self) -> DevModeStatus {
        let inner = self.inner.lock();
        DevModeStatus {
            enabled: inner.enabled,
            dev_paths: inner
                .dev_paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        }
    }

    /// Switch Dev Mode. Off forgets the registered dev paths. Listeners hear
    /// about a change (not a repeat) after the lock is released.
    pub fn set_enabled(&self, enabled: bool) -> DevModeStatus {
        let changed = {
            let mut inner = self.inner.lock();
            let changed = inner.enabled != enabled;
            inner.enabled = enabled;
            if !enabled {
                inner.dev_paths.clear();
            }
            changed
        };
        if changed {
            let listeners: Vec<Listener> = self.listeners.lock().clone();
            for listener in listeners {
                listener(enabled);
            }
        }
        self.status()
    }

    /// Run `listener` on every switch. The desktop shell uses it to start and
    /// stop the broker trace, which lives in a crate this one does not reach.
    pub fn on_change(&self, listener: impl Fn(bool) + Send + Sync + 'static) {
        self.listeners.lock().push(Arc::new(listener));
    }

    /// Trust plugins installed from `path` for this Dev Mode session. The path
    /// must be an existing directory; it is kept canonical so a symlink or a
    /// `..` cannot widen it later.
    pub fn register_dev_path(&self, path: &Path) -> Result<DevPathRegistration, String> {
        let canonical = canonical_dir(path)?;
        {
            let mut inner = self.inner.lock();
            if !inner.enabled {
                return Err(
                    "MANAGED_IDE_DEV_MODE_OFF: turn on Dev Mode to register a dev path".into(),
                );
            }
            inner.dev_paths.insert(canonical.clone());
        }
        Ok(DevPathRegistration {
            path: canonical.to_string_lossy().into_owned(),
            status: self.status(),
        })
    }

    pub fn unregister_dev_path(&self, path: &Path) -> DevModeStatus {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        self.inner
            .lock()
            .dev_paths
            .retain(|registered| registered != &canonical && registered != path);
        self.status()
    }

    /// Whether `source` lies inside a registered dev path while Dev Mode is on.
    pub fn is_registered_dev_source(&self, source: &Path) -> bool {
        let Ok(source) = source.canonicalize() else {
            return false;
        };
        let inner = self.inner.lock();
        inner.enabled
            && inner
                .dev_paths
                .iter()
                .any(|registered| source.starts_with(registered))
    }

    /// Write a `local-dev` receipt into `plugin_root` if the install came from
    /// a registered dev path while Dev Mode is on. Returns whether it did.
    /// The caller has already discarded any receipt the source carried.
    pub fn mint_local_dev_receipt(
        &self,
        plugin_root: &Path,
        source: &Path,
        version: &str,
    ) -> std::io::Result<bool> {
        if !self.is_registered_dev_source(source) {
            return Ok(false);
        }
        let receipt = VerificationReceipt {
            verified_via: LOCAL_DEV_VERIFICATION.into(),
            version: version.into(),
            verified_at: chrono::Utc::now().to_rfc3339(),
        };
        std::fs::write(
            plugin_root.join(VERIFICATION_RECEIPT_FILE),
            serde_json::to_vec(&receipt).map_err(std::io::Error::other)?,
        )?;
        Ok(true)
    }

    /// Whether a receipt still vouches for its plugin. A `local-dev` receipt
    /// does only while Dev Mode is on; every other kind is unaffected.
    pub fn accepts_receipt(&self, receipt: &VerificationReceipt) -> bool {
        receipt.verified_via != LOCAL_DEV_VERIFICATION || self.enabled()
    }
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("MANAGED_IDE_DEV_PATH_INVALID: the dev path must be absolute".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("MANAGED_IDE_DEV_PATH_INVALID: {}: {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "MANAGED_IDE_DEV_PATH_INVALID: {} is not a directory",
            canonical.display()
        ));
    }
    Ok(canonical)
}

#[cfg(feature = "tauri-host")]
mod commands {
    use super::{DevModeState, DevModeStatus, DevPathRegistration};
    use std::path::PathBuf;

    #[tauri::command]
    pub fn plugin_managed_ide_dev_mode_status() -> DevModeStatus {
        DevModeState::global().status()
    }

    #[tauri::command]
    pub fn plugin_managed_ide_dev_mode_set(enabled: bool) -> DevModeStatus {
        DevModeState::global().set_enabled(enabled)
    }

    #[tauri::command]
    pub fn plugin_managed_ide_dev_path_register(
        path: String,
    ) -> Result<DevPathRegistration, String> {
        DevModeState::global().register_dev_path(&PathBuf::from(path))
    }

    #[tauri::command]
    pub fn plugin_managed_ide_dev_path_unregister(path: String) -> DevModeStatus {
        DevModeState::global().unregister_dev_path(&PathBuf::from(path))
    }
}

#[cfg(feature = "tauri-host")]
pub use commands::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn receipt(verified_via: &str) -> VerificationReceipt {
        VerificationReceipt {
            verified_via: verified_via.into(),
            version: "1.0.0".into(),
            verified_at: "now".into(),
        }
    }

    #[test]
    fn off_by_default_and_registering_needs_it_on() {
        let dev = DevModeState::default();
        let folder = tempfile::tempdir().unwrap();
        assert!(!dev.enabled());
        assert!(dev
            .register_dev_path(folder.path())
            .unwrap_err()
            .starts_with("MANAGED_IDE_DEV_MODE_OFF"));
        dev.set_enabled(true);
        let registered = dev.register_dev_path(folder.path()).unwrap();
        assert_eq!(registered.status.dev_paths, vec![registered.path.clone()]);
        assert_eq!(
            PathBuf::from(&registered.path),
            folder.path().canonicalize().unwrap()
        );
        assert!(dev
            .register_dev_path(Path::new("relative/dir"))
            .unwrap_err()
            .starts_with("MANAGED_IDE_DEV_PATH_INVALID"));
        let file = folder.path().join("plugin.json");
        std::fs::write(&file, "{}").unwrap();
        assert!(dev
            .register_dev_path(&file)
            .unwrap_err()
            .contains("is not a directory"));
    }

    #[test]
    fn only_a_registered_folder_mints_a_local_dev_receipt_and_only_while_on() {
        let dev = DevModeState::default();
        let workspace = tempfile::tempdir().unwrap();
        let registered = workspace.path().join("dev");
        let plugin_source = registered.join("acme");
        let elsewhere = workspace.path().join("other");
        std::fs::create_dir_all(&plugin_source).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let installed = tempfile::tempdir().unwrap();

        dev.set_enabled(true);
        dev.register_dev_path(&registered).unwrap();
        assert!(!dev
            .mint_local_dev_receipt(installed.path(), &elsewhere, "1.0.0")
            .unwrap());
        assert!(!installed.path().join(VERIFICATION_RECEIPT_FILE).exists());
        assert!(dev
            .mint_local_dev_receipt(installed.path(), &plugin_source, "1.0.0")
            .unwrap());
        let written: VerificationReceipt = serde_json::from_slice(
            &std::fs::read(installed.path().join(VERIFICATION_RECEIPT_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(written.verified_via, LOCAL_DEV_VERIFICATION);
        assert!(dev.accepts_receipt(&written));

        // Off: the folders are forgotten and the receipt stops vouching.
        let status = dev.set_enabled(false);
        assert!(status.dev_paths.is_empty());
        assert!(!dev.accepts_receipt(&written));
        assert!(dev.accepts_receipt(&receipt("signature")));
        assert!(!dev.is_registered_dev_source(&plugin_source));
        // A traversal out of the registered folder does not count as inside it.
        dev.set_enabled(true);
        dev.register_dev_path(&registered).unwrap();
        assert!(!dev.is_registered_dev_source(&registered.join("..").join("other")));
        dev.unregister_dev_path(&registered);
        assert!(!dev.is_registered_dev_source(&plugin_source));
    }

    #[test]
    fn listeners_hear_each_change_once() {
        let dev = DevModeState::default();
        let heard = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&heard);
        dev.on_change(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        dev.set_enabled(true);
        dev.set_enabled(true);
        dev.set_enabled(false);
        assert_eq!(heard.load(Ordering::SeqCst), 2);
    }
}
