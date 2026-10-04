//! ADR-0201 — command shells over the Chrome extension store in
//! `cognia-local-browser::extensions` (`<app_data>/browser/extensions`).
//!
//! Only the local Chromium backend loads Cognia's extension set: the embedded
//! webview cannot host extensions and the user's Chrome has its own. Without a
//! staged runtime there is no backend to load them, so installs are refused
//! with `extensions_unsupported_backend`.
//!
//! Installs are two-step. `browser_extension_install_webstore(idOrUrl)`,
//! `browser_extension_install_crx()` and `browser_extension_install_unpacked()`
//! fetch or pick the package (the `.crx` file and the unpacked directory are
//! chosen in a native dialog Rust shows; the renderer never names a path),
//! verify it, parse its manifest and return a [`PendingExtensionInstall`]
//! with its permissions and host permissions. Nothing is installed until the
//! user confirms that in the UI and the renderer calls
//! `browser_extension_install_confirm(pendingId)`
//! (`browser_extension_install_cancel` drops it). A pending install expires
//! after ten minutes. An unpacked directory whose permissions changed between
//! the preview and the install is removed again and refused.
//!
//! Every mutation hands the new enabled set to a running runtime
//! (`browser.extensions.reload`, which restarts live local sessions keeping
//! their pages) and emits `browser-local://event {type: "extensions.changed"}`.
//! Errors are strings that lead with their code (`crx_invalid: …`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use cognia_local_browser::extensions::{
    download_webstore_crx, extract_zip, parse_crx3, parse_manifest, parse_webstore_id,
    BrowserExtension, ExtensionError, ExtensionErrorCode, ExtensionSource, ExtensionStore,
    ExtensionUpdate, ParsedManifest,
};
use cognia_local_browser::installer;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Webview};

use crate::browser::cookie_import::require_main_window;

/// The store under `<app_data>/browser/extensions`.
pub(crate) fn extension_store(app: &AppHandle) -> Result<ExtensionStore, String> {
    Ok(ExtensionStore::new(
        crate::browser::local::browser_root(app)?.join("extensions"),
    ))
}

/// The Chromium version the staged runtime pins (the Web Store's
/// `prodversion`); no staged runtime means no backend can load extensions.
fn prodversion(app: &AppHandle) -> Result<String, String> {
    crate::browser::local::runtime_dir(app)
        .ok()
        .and_then(|runtime| installer::expected_chromium_version(&runtime))
        .ok_or_else(unsupported_backend)
}

fn unsupported_backend() -> String {
    ExtensionError::new(
        ExtensionErrorCode::UnsupportedBackend,
        "no local Chromium runtime is available to load extensions",
    )
    .to_string()
}

fn to_string(error: ExtensionError) -> String {
    error.to_string()
}

/// Run blocking store I/O off the async runtime.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ExtensionError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
        .map_err(to_string)
}

/// The payload of the change notification.
fn changed_event() -> serde_json::Value {
    json!({ "type": "extensions.changed", "sessionId": null })
}

/// Reload the running runtime's extension set and notify the renderer.
async fn after_mutation(app: &AppHandle, store: &ExtensionStore) {
    let store = store.clone();
    let paths = tauri::async_runtime::spawn_blocking(move || store.enabled_paths())
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    crate::browser::local::reload_extensions(app, paths).await;
    crate::browser::local::emit_local_event(app, changed_event());
}

#[tauri::command]
pub async fn browser_extensions_list(app: AppHandle) -> Result<Vec<BrowserExtension>, String> {
    let store = extension_store(&app)?;
    blocking(move || store.list()).await
}

/// How long a previewed install waits for the user's confirmation.
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// Largest `.crx` file read for a preview (the store's own package limit).
const MAX_CRX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// At most this many previews are kept (oldest dropped first).
const PENDING_LIMIT: usize = 8;

/// What the user is asked to confirm before an install.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingExtensionInstall {
    pub pending_id: String,
    /// The extension id when the package fixes it (CRX / Web Store).
    pub id: Option<String>,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub permissions: Vec<String>,
    pub host_permissions: Vec<String>,
    pub source: ExtensionSource,
}

/// The verified package a preview holds until it is confirmed.
enum PendingPackage {
    /// CRX bytes (Web Store or file), installed exactly as previewed.
    Crx {
        bytes: Vec<u8>,
        expected_id: Option<String>,
    },
    /// An unpacked directory, copied at confirm time.
    Unpacked { dir: PathBuf },
}

struct PendingInstall {
    preview: PendingExtensionInstall,
    package: PendingPackage,
    created: Instant,
}

static PENDING: LazyLock<Mutex<HashMap<String, PendingInstall>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn pending_map() -> std::sync::MutexGuard<'static, HashMap<String, PendingInstall>> {
    PENDING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn prune_pending(pending: &mut HashMap<String, PendingInstall>, now: Instant) {
    pending.retain(|_, entry| now.duration_since(entry.created) < PENDING_TTL);
    while pending.len() >= PENDING_LIMIT {
        let Some(oldest) = pending
            .iter()
            .min_by_key(|(_, entry)| entry.created)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        pending.remove(&oldest);
    }
}

fn new_pending_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Keep a verified package until the user confirms it; returns its preview.
fn stash_pending(
    manifest: ParsedManifest,
    id: Option<String>,
    source: ExtensionSource,
    package: PendingPackage,
) -> PendingExtensionInstall {
    let preview = PendingExtensionInstall {
        pending_id: new_pending_id(),
        id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        permissions: manifest.permissions,
        host_permissions: manifest.host_permissions,
        source,
    };
    let mut pending = pending_map();
    prune_pending(&mut pending, Instant::now());
    pending.insert(
        preview.pending_id.clone(),
        PendingInstall {
            preview: preview.clone(),
            package,
            created: Instant::now(),
        },
    );
    preview
}

fn take_pending(pending_id: &str) -> Option<PendingInstall> {
    let mut pending = pending_map();
    prune_pending(&mut pending, Instant::now());
    pending.remove(pending_id)
}

fn pending_expired() -> String {
    "extension_install_expired: the install was not confirmed in time; start it again".into()
}

/// Verify a CRX (and its pinned id) and read its manifest without installing
/// it: the archive is extracted to a scratch directory that is removed again.
pub(crate) fn preview_crx(
    bytes: &[u8],
    expected_id: Option<&str>,
    scratch_root: &Path,
) -> Result<(String, ParsedManifest), ExtensionError> {
    let crx = parse_crx3(bytes)?;
    if let Some(expected) = expected_id {
        if expected != crx.id {
            return Err(ExtensionError::new(
                ExtensionErrorCode::CrxIdMismatch,
                format!("expected {expected}, the package is {}", crx.id),
            ));
        }
    }
    let scratch = scratch_root.join(format!("cognia-extension-preview-{}", new_pending_id()));
    let result = (|| {
        std::fs::create_dir_all(&scratch).map_err(|error| {
            ExtensionError::new(
                ExtensionErrorCode::Io,
                format!("{}: {error}", scratch.display()),
            )
        })?;
        extract_zip(crx.archive, &scratch)?;
        parse_manifest(&scratch)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    Ok((crx.id.clone(), result?))
}

/// Read an unpacked directory's manifest without copying it.
pub(crate) fn preview_unpacked(dir: &Path) -> Result<ParsedManifest, ExtensionError> {
    if !dir.join("manifest.json").is_file() {
        return Err(ExtensionError::new(
            ExtensionErrorCode::ManifestInvalid,
            format!("{} has no manifest.json", dir.display()),
        ));
    }
    parse_manifest(dir)
}

/// Whether what was installed asks for exactly what the user confirmed.
pub(crate) fn same_permissions(
    installed: &BrowserExtension,
    preview: &PendingExtensionInstall,
) -> bool {
    let sorted = |values: &[String]| {
        let mut values = values.to_vec();
        values.sort();
        values
    };
    sorted(&installed.permissions) == sorted(&preview.permissions)
        && sorted(&installed.host_permissions) == sorted(&preview.host_permissions)
}

/// Download and verify a Web Store extension, then return what it asks for.
/// Installs nothing: confirm with `browser_extension_install_confirm`.
#[tauri::command]
pub async fn browser_extension_install_webstore(
    app: AppHandle,
    webview: Webview,
    id_or_url: String,
) -> Result<PendingExtensionInstall, String> {
    require_main_window(webview.label())?;
    let prodversion = prodversion(&app)?;
    let id = parse_webstore_id(&id_or_url).ok_or_else(|| {
        ExtensionError::new(
            ExtensionErrorCode::ExtensionNotFound,
            format!("{id_or_url:?} is not a Chrome Web Store id or URL"),
        )
        .to_string()
    })?;
    let bytes = download_webstore_crx(&id, &prodversion)
        .await
        .map_err(to_string)?;
    blocking(move || {
        let (crx_id, manifest) = preview_crx(&bytes, Some(&id), &std::env::temp_dir())?;
        Ok(stash_pending(
            manifest,
            Some(crx_id),
            ExtensionSource::Webstore,
            PendingPackage::Crx {
                bytes,
                expected_id: Some(id),
            },
        ))
    })
    .await
}

/// Let the user pick a `.crx` file in a native dialog, verify it and return
/// what it asks for. `None` when the dialog was cancelled.
#[tauri::command]
pub async fn browser_extension_install_crx(
    app: AppHandle,
    webview: Webview,
) -> Result<Option<PendingExtensionInstall>, String> {
    require_main_window(webview.label())?;
    prodversion(&app)?;
    let builder = {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().add_filter("CRX", &["crx"])
    };
    let Some(path) = crate::browser::downloads::native_dialog::pick_file(builder).await else {
        return Ok(None);
    };
    blocking(move || {
        let metadata = std::fs::metadata(&path).map_err(|error| {
            ExtensionError::new(
                ExtensionErrorCode::Io,
                format!("{}: {error}", path.display()),
            )
        })?;
        if !metadata.is_file()
            || metadata.len() > MAX_CRX_FILE_BYTES
        {
            return Err(ExtensionError::new(
                ExtensionErrorCode::CrxInvalid,
                "the package is not a file or exceeds the size limit",
            ));
        }
        let bytes = std::fs::read(&path).map_err(|error| {
            ExtensionError::new(
                ExtensionErrorCode::Io,
                format!("{}: {error}", path.display()),
            )
        })?;
        let (crx_id, manifest) = preview_crx(&bytes, None, &std::env::temp_dir())?;
        Ok(Some(stash_pending(
            manifest,
            Some(crx_id),
            ExtensionSource::Crx,
            PendingPackage::Crx {
                bytes,
                expected_id: None,
            },
        )))
    })
    .await
}

/// Let the user pick an unpacked extension directory in a native dialog and
/// return what it asks for. `None` when the dialog was cancelled.
#[tauri::command]
pub async fn browser_extension_install_unpacked(
    app: AppHandle,
    webview: Webview,
) -> Result<Option<PendingExtensionInstall>, String> {
    require_main_window(webview.label())?;
    prodversion(&app)?;
    let builder = {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file()
    };
    let Some(dir) = crate::browser::downloads::native_dialog::pick_folder(builder).await else {
        return Ok(None);
    };
    blocking(move || {
        let manifest = preview_unpacked(&dir)?;
        Ok(Some(stash_pending(
            manifest,
            None,
            ExtensionSource::Unpacked,
            PendingPackage::Unpacked { dir },
        )))
    })
    .await
}

/// Install a previewed extension after the user confirmed its permissions.
#[tauri::command]
pub async fn browser_extension_install_confirm(
    app: AppHandle,
    webview: Webview,
    pending_id: String,
) -> Result<BrowserExtension, String> {
    require_main_window(webview.label())?;
    prodversion(&app)?;
    let pending = take_pending(&pending_id).ok_or_else(pending_expired)?;
    let store = extension_store(&app)?;
    let worker = store.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || -> Result<BrowserExtension, String> {
        let PendingInstall {
            preview, package, ..
        } = pending;
        match package {
            PendingPackage::Crx { bytes, expected_id } => worker
                .install_crx_bytes(&bytes, preview.source, expected_id.as_deref())
                .map_err(to_string),
            PendingPackage::Unpacked { dir } => {
                let installed = worker.install_unpacked(&dir).map_err(to_string)?;
                if !same_permissions(&installed, &preview) {
                    let _ = worker.remove(&installed.id);
                    return Err(ExtensionError::new(
                        ExtensionErrorCode::ManifestInvalid,
                        "the extension's permissions changed after they were confirmed; install it again",
                    )
                    .to_string());
                }
                Ok(installed)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())??;
    after_mutation(&app, &store).await;
    Ok(installed)
}

/// Drop a previewed install the user declined.
#[tauri::command]
pub async fn browser_extension_install_cancel(
    webview: Webview,
    pending_id: String,
) -> Result<(), String> {
    require_main_window(webview.label())?;
    take_pending(&pending_id);
    Ok(())
}

#[tauri::command]
pub async fn browser_extension_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<BrowserExtension, String> {
    let store = extension_store(&app)?;
    let worker = store.clone();
    let updated = blocking(move || worker.set_enabled(&id, enabled)).await?;
    after_mutation(&app, &store).await;
    Ok(updated)
}

#[tauri::command]
pub async fn browser_extension_remove(app: AppHandle, id: String) -> Result<(), String> {
    let store = extension_store(&app)?;
    let worker = store.clone();
    blocking(move || worker.remove(&id)).await?;
    after_mutation(&app, &store).await;
    Ok(())
}

#[tauri::command]
pub async fn browser_extensions_check_updates(
    app: AppHandle,
) -> Result<Vec<ExtensionUpdate>, String> {
    let prodversion = prodversion(&app)?;
    let store = extension_store(&app)?;
    let updates = store
        .check_updates(&prodversion)
        .await
        .map_err(to_string)?;
    crate::browser::local::emit_local_event(&app, changed_event());
    Ok(updates)
}

#[tauri::command]
pub async fn browser_extension_update(
    app: AppHandle,
    id: String,
) -> Result<BrowserExtension, String> {
    let prodversion = prodversion(&app)?;
    let store = extension_store(&app)?;
    let updated = store.update(&id, &prodversion).await.map_err(to_string)?;
    after_mutation(&app, &store).await;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(name: &str, permissions: &[&str], hosts: &[&str]) -> ParsedManifest {
        ParsedManifest {
            manifest_version: 3,
            name: name.into(),
            version: "1.0".into(),
            permissions: permissions.iter().map(|p| p.to_string()).collect(),
            host_permissions: hosts.iter().map(|p| p.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn pending_installs_are_taken_once_and_expire() {
        let preview = stash_pending(
            manifest("Pending test", &["storage"], &["https://*.example.com/*"]),
            None,
            ExtensionSource::Unpacked,
            PendingPackage::Unpacked {
                dir: PathBuf::from("/nowhere"),
            },
        );
        assert_eq!(preview.permissions, vec!["storage"]);
        assert_eq!(preview.host_permissions, vec!["https://*.example.com/*"]);
        let taken = take_pending(&preview.pending_id).expect("pending");
        assert_eq!(taken.preview, preview);
        assert!(take_pending(&preview.pending_id).is_none(), "taken once");
        assert!(pending_expired().starts_with("extension_install_expired"));

        let mut map = HashMap::new();
        let old = Instant::now()
            .checked_sub(PENDING_TTL + Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        map.insert(
            "old".to_string(),
            PendingInstall {
                preview: preview.clone(),
                package: PendingPackage::Unpacked {
                    dir: PathBuf::from("/x"),
                },
                created: old,
            },
        );
        prune_pending(&mut map, Instant::now());
        if Instant::now().checked_sub(PENDING_TTL).is_some_and(|limit| old < limit) {
            assert!(map.is_empty());
        }
        for index in 0..(PENDING_LIMIT + 3) {
            map.insert(
                format!("p{index}"),
                PendingInstall {
                    preview: preview.clone(),
                    package: PendingPackage::Unpacked {
                        dir: PathBuf::from("/x"),
                    },
                    created: Instant::now(),
                },
            );
            prune_pending(&mut map, Instant::now());
        }
        assert!(map.len() <= PENDING_LIMIT);
    }

    #[test]
    fn previews_serialize_the_ipc_shape() {
        let preview = PendingExtensionInstall {
            pending_id: "p".into(),
            id: Some("a".repeat(32)),
            name: "N".into(),
            version: "1".into(),
            description: None,
            permissions: vec!["tabs".into()],
            host_permissions: vec!["<all_urls>".into()],
            source: ExtensionSource::Webstore,
        };
        assert_eq!(
            serde_json::to_value(&preview).unwrap(),
            json!({
                "pendingId": "p",
                "id": "a".repeat(32),
                "name": "N",
                "version": "1",
                "description": null,
                "permissions": ["tabs"],
                "hostPermissions": ["<all_urls>"],
                "source": "webstore",
            })
        );
    }

    #[test]
    fn unpacked_previews_read_the_manifest_in_place() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("manifest.json"),
            r#"{"manifest_version":3,"name":"Demo","version":"1.2","permissions":["storage","tabs"],"host_permissions":["https://example.com/*"]}"#,
        )
        .unwrap();
        let parsed = preview_unpacked(dir.path()).unwrap();
        assert_eq!(parsed.name, "Demo");
        assert_eq!(parsed.permissions, vec!["storage", "tabs"]);
        assert_eq!(parsed.host_permissions, vec!["https://example.com/*"]);
        let empty = tempfile::tempdir().unwrap();
        assert!(preview_unpacked(empty.path())
            .unwrap_err()
            .to_string()
            .starts_with("manifest_invalid"));
    }

    #[test]
    fn crx_previews_refuse_garbage_and_leave_no_scratch() {
        let scratch = tempfile::tempdir().unwrap();
        let error = preview_crx(b"not a crx", None, scratch.path()).unwrap_err();
        assert_eq!(error.code, ExtensionErrorCode::CrxInvalid);
        assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_permission_change_is_detected() {
        let preview = PendingExtensionInstall {
            pending_id: "p".into(),
            id: None,
            name: "N".into(),
            version: "1".into(),
            description: None,
            permissions: vec!["tabs".into(), "storage".into()],
            host_permissions: vec![],
            source: ExtensionSource::Unpacked,
        };
        let mut installed = BrowserExtension {
            id: "x".into(),
            name: "N".into(),
            version: "1".into(),
            enabled: true,
            source: ExtensionSource::Unpacked,
            installed_at: 0,
            permissions: vec!["storage".into(), "tabs".into()],
            host_permissions: vec![],
            icon_path: None,
            popup_path: None,
            options_path: None,
            description: None,
            update_available: None,
        };
        assert!(same_permissions(&installed, &preview));
        installed.host_permissions.push("<all_urls>".into());
        assert!(!same_permissions(&installed, &preview));
    }

    #[test]
    fn unsupported_backend_leads_with_its_code() {
        assert!(unsupported_backend().starts_with("extensions_unsupported_backend: "));
    }

    #[test]
    fn change_event_matches_the_local_event_shape() {
        assert_eq!(
            changed_event(),
            json!({"type": "extensions.changed", "sessionId": null})
        );
    }

    #[tokio::test]
    async fn blocking_maps_typed_errors_to_coded_strings() {
        let error = blocking(|| -> Result<(), ExtensionError> {
            Err(ExtensionError::new(ExtensionErrorCode::CrxInvalid, "bad"))
        })
        .await
        .unwrap_err();
        assert_eq!(error, "crx_invalid: bad");
        assert_eq!(blocking(|| Ok(7)).await.unwrap(), 7);
    }
}
