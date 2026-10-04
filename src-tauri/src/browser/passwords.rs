//! The Rust-only password vault and autofill (ADR-0201).
//!
//! Passwords live in the `cognia-secrets` encrypted store through
//! `cognia_browser_cookies::passwords::vault`. Across IPC only metadata moves,
//! with two exceptions that both require OS user presence
//! (`cognia_secrets::user_presence::verify`): `browser_password_reveal`
//! returns one password, and `browser_password_export` writes a CSV to a path
//! the user picks in a native save dialog Rust shows after presence succeeds
//! (the renderer never names the path). Copy writes the clipboard from Rust. Autofill puts a
//! password into the page from Rust (the embedded overlay helper or the local
//! runtime's privileged `browser.credential.fill`), never through the
//! renderer.
//!
//! Save prompts: the local runtime reports a submitted login
//! (`credential.submitted`); `local.rs` calls [`stash_pending`], forwards only
//! a pending id, and the renderer resolves it with
//! `browser_password_pending_resolve`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_clipboard_manager::ClipboardExt;

use cognia_browser_cookies::browsers::{Browser, HostDirs, Os};
use cognia_browser_cookies::import::{password_sources, SourceInfo};
use cognia_browser_cookies::passwords::csv::{import_csv, CsvFormat};
use cognia_browser_cookies::passwords::import_browser_passwords;
use cognia_browser_cookies::passwords::vault::{
    now_ms, CredentialMeta, CredentialPatch, NewCredential, PendingKind, SecretStoreBackend, Vault,
};
use cognia_browser_cookies::secret::SecretString;
use cognia_browser_cookies::system::SystemSecrets;
use cognia_browser_cookies::ImportError;
use cognia_secrets::user_presence::{self, UserPresenceError};

use crate::browser::commands::js_string;
use crate::browser::cookie_import::{host_keychain, require_main_window};
use crate::browser::embedded::EMBED_LABEL;

/// How long a submitted login waits for the user's save/update answer.
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// At most this many unanswered save prompts are kept.
const PENDING_LIMIT: usize = 32;
/// The clipboard is cleared this long after a copy if it still holds it.
const CLIPBOARD_CLEAR_AFTER: Duration = Duration::from_secs(30);
/// Largest CSV export accepted for import.
const CSV_MAX_BYTES: u64 = 32 * 1024 * 1024;

struct PendingSave {
    origin: String,
    username: String,
    password: SecretString,
    created: Instant,
}

struct VaultInner {
    vault: Vault<SecretStoreBackend>,
    pending: Mutex<HashMap<String, PendingSave>>,
    clipboard_generation: AtomicU64,
}

/// Managed state: the vault and the unanswered save prompts.
#[derive(Clone)]
pub struct PasswordVaultState {
    inner: Arc<VaultInner>,
}

impl Default for PasswordVaultState {
    fn default() -> Self {
        Self {
            inner: Arc::new(VaultInner {
                vault: Vault::new(SecretStoreBackend),
                pending: Mutex::new(HashMap::new()),
                clipboard_generation: AtomicU64::new(0),
            }),
        }
    }
}

fn lock_pending(inner: &VaultInner) -> std::sync::MutexGuard<'_, HashMap<String, PendingSave>> {
    inner
        .pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn prune(pending: &mut HashMap<String, PendingSave>, now: Instant) {
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
    let mut bytes = [0_u8; 16];
    rand::fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl PasswordVaultState {
    fn stash(&self, origin: String, username: String, password: String) -> String {
        let id = new_pending_id();
        let mut pending = lock_pending(&self.inner);
        prune(&mut pending, Instant::now());
        pending.insert(
            id.clone(),
            PendingSave {
                origin,
                username,
                password: SecretString::from(password),
                created: Instant::now(),
            },
        );
        id
    }

    fn take(&self, id: &str) -> Option<PendingSave> {
        let mut pending = lock_pending(&self.inner);
        prune(&mut pending, Instant::now());
        pending.remove(id)
    }
}

/// Keep a login the local runtime saw submitted until the user answers the
/// save prompt. Returns the pending id the renderer may see; the password
/// stays here.
pub fn stash_pending(
    app: &AppHandle,
    origin: String,
    username: String,
    password: String,
) -> String {
    match app.try_state::<PasswordVaultState>() {
        Some(state) => state.stash(origin, username, password),
        None => {
            let mut password = password;
            zeroize_string(&mut password);
            log::warn!("password vault state is not managed; dropping a submitted login");
            new_pending_id()
        }
    }
}

fn zeroize_string(value: &mut String) {
    // SAFETY: only NUL bytes are written, which keeps the buffer valid UTF-8,
    // and each `byte` is a valid element of the String's buffer.
    unsafe {
        for byte in value.as_bytes_mut().iter_mut() {
            std::ptr::write_volatile(byte, 0);
        }
    }
    value.clear();
}

fn code(error: ImportError) -> String {
    error.code().to_string()
}

fn presence_error(error: UserPresenceError) -> String {
    error.to_string()
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|_| "password vault worker failed".to_string())?
}

async fn require_presence(reason: &'static str) -> Result<(), String> {
    blocking(move || user_presence::verify(reason).map_err(presence_error)).await
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasswordImportResult {
    imported: usize,
    updated: usize,
    skipped: usize,
    skipped_app_bound: usize,
    errors: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCredentialInput {
    origin: String,
    username: String,
    password: SecretInput,
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCredentialInput {
    id: String,
    username: Option<String>,
    password: Option<SecretInput>,
    note: Option<String>,
}

/// A password arriving from the renderer (a manual save or edit): wiped on
/// drop and redacted in `Debug`.
#[derive(Deserialize)]
#[serde(transparent)]
pub struct SecretInput(String);

impl std::fmt::Debug for SecretInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl SecretInput {
    fn into_secret(mut self) -> SecretString {
        SecretString::from(std::mem::take(&mut self.0))
    }
}

impl Drop for SecretInput {
    fn drop(&mut self) {
        zeroize_string(&mut self.0);
    }
}

#[derive(Serialize)]
pub struct RevealedPassword {
    password: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct ExportResult {
    exported: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingAction {
    Save,
    Update,
    Never,
    Dismiss,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingSaveInfo {
    origin: String,
    username: String,
    /// `save` (new), `update` (existing, different password), `unchanged`
    /// (nothing to ask), `suppressed` (the user chose "never" for the site).
    #[serde(flatten)]
    kind: PendingKind,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FillTarget {
    Embedded,
    Local,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FillRequest {
    target: FillTarget,
    session_id: Option<String>,
    page_id: Option<String>,
    credential_id: Option<String>,
    url: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FillResult {
    filled: bool,
    username: Option<String>,
    reason: Option<&'static str>,
}

impl FillResult {
    fn refused(reason: &'static str) -> Self {
        Self {
            filled: false,
            username: None,
            reason: Some(reason),
        }
    }
}

#[tauri::command]
pub async fn browser_password_sources(webview: Webview) -> Result<Vec<SourceInfo>, String> {
    require_main_window(webview.label())?;
    blocking(|| Ok(password_sources(Os::current(), &HostDirs::detect()))).await
}

#[tauri::command]
pub async fn browser_password_import_browser(
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    browser: Browser,
    profile: String,
) -> Result<PasswordImportResult, String> {
    require_main_window(webview.label())?;
    let inner = state.inner.clone();
    blocking(move || {
        let keychain = host_keychain();
        let secrets = SystemSecrets::new(keychain.as_ref());
        let batch = match import_browser_passwords(
            browser,
            &profile,
            Os::current(),
            &HostDirs::detect(),
            &secrets,
        ) {
            Ok(batch) => batch,
            Err(ImportError::PrimaryPasswordSet) => {
                return Ok(PasswordImportResult {
                    errors: vec![ImportError::PrimaryPasswordSet.code().into()],
                    ..Default::default()
                })
            }
            Err(error) => return Err(code(error)),
        };
        let tally = inner
            .vault
            .import(batch.credentials, browser.id(), now_ms());
        Ok(PasswordImportResult {
            imported: tally.imported,
            updated: tally.updated,
            skipped: tally.skipped + batch.skipped,
            skipped_app_bound: batch.skipped_app_bound,
            errors: batch.errors,
        })
    })
    .await
}

fn csv_source(format: Option<CsvFormat>) -> String {
    match format {
        Some(format) => {
            let id = serde_json::to_value(format)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "generic".into());
            format!("csv:{id}")
        }
        None => "csv".into(),
    }
}

#[tauri::command]
pub async fn browser_password_import_csv(
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    path: String,
    format: Option<CsvFormat>,
) -> Result<PasswordImportResult, String> {
    require_main_window(webview.label())?;
    let inner = state.inner.clone();
    blocking(move || {
        let metadata = std::fs::metadata(&path).map_err(|_| "file_unreadable".to_string())?;
        if !metadata.is_file() || metadata.len() > CSV_MAX_BYTES {
            return Err(code(ImportError::InvalidFormat));
        }
        let bytes = std::fs::read(&path).map_err(|_| "file_unreadable".to_string())?;
        let text = String::from_utf8(bytes).map_err(|error| {
            let mut bytes = error.into_bytes();
            bytes.iter_mut().for_each(|byte| *byte = 0);
            code(ImportError::InvalidFormat)
        })?;
        let batch = import_csv(text, format).map_err(code)?;
        let tally = inner
            .vault
            .import(batch.credentials, &csv_source(format), now_ms());
        Ok(PasswordImportResult {
            imported: tally.imported,
            updated: tally.updated,
            skipped: tally.skipped + batch.skipped,
            skipped_app_bound: 0,
            errors: batch.errors,
        })
    })
    .await
}

#[tauri::command]
pub async fn browser_password_list(
    webview: Webview,
    state: State<'_, PasswordVaultState>,
) -> Result<Vec<CredentialMeta>, String> {
    require_main_window(webview.label())?;
    let inner = state.inner.clone();
    blocking(move || inner.vault.list().map_err(code)).await
}

#[tauri::command]
pub async fn browser_password_matches(
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    url: String,
) -> Result<Vec<CredentialMeta>, String> {
    require_main_window(webview.label())?;
    let inner = state.inner.clone();
    blocking(move || inner.vault.matches(&url).map_err(code)).await
}

#[tauri::command]
pub async fn browser_password_save(
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    input: SaveCredentialInput,
) -> Result<CredentialMeta, String> {
    require_main_window(webview.label())?;
    let inner = state.inner.clone();
    blocking(move || {
        let SaveCredentialInput {
            origin,
            username,
            password,
            note,
        } = input;
        inner
            .vault
            .save(
                NewCredential {
                    origin,
                    realm: None,
                    username,
                    password: password.into_secret(),
                    source: "manual".into(),
                    note,
                    created_at: None,
                    last_used_at: None,
                },
                now_ms(),
            )
            .map(|outcome| outcome.into_meta())
            .map_err(code)
    })
    .await
}

#[tauri::command]
pub async fn browser_password_update(
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    input: UpdateCredentialInput,
) -> Result<CredentialMeta, String> {
    require_main_window(webview.label())?;
    let inner = state.inner.clone();
    blocking(move || {
        let UpdateCredentialInput {
            id,
            username,
            password,
            note,
        } = input;
        inner
            .vault
            .update(
                &id,
                CredentialPatch {
                    username,
                    password: password.map(SecretInput::into_secret),
                    note,
                },
                now_ms(),
            )
            .map_err(code)
    })
    .await
}

#[tauri::command]
pub async fn browser_password_delete(
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    id: String,
) -> Result<(), String> {
    require_main_window(webview.label())?;
    let inner = state.inner.clone();
    blocking(move || inner.vault.delete(&id).map_err(code)).await
}

/// Return one password after OS user presence.
#[tauri::command]
pub async fn browser_password_reveal(
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    id: String,
) -> Result<RevealedPassword, String> {
    require_main_window(webview.label())?;
    let inner = state.inner.clone();
    let lookup_id = id.clone();
    // Fail fast on an unknown id before prompting.
    blocking(move || {
        inner
            .vault
            .get(&lookup_id)
            .map_err(code)?
            .ok_or_else(|| code(ImportError::CredentialNotFound))
    })
    .await?;
    require_presence("show a saved password").await?;
    let inner = state.inner.clone();
    blocking(move || {
        let password = inner.vault.password(&id).map_err(code)?;
        Ok(RevealedPassword {
            password: password.expose().to_owned(),
        })
    })
    .await
}

fn clipboard_digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

/// Copy one password to the clipboard after OS user presence, and clear the
/// clipboard 30 seconds later if it still holds that password.
#[tauri::command]
pub async fn browser_password_copy(
    app: AppHandle,
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    id: String,
) -> Result<(), String> {
    require_main_window(webview.label())?;
    let inner = state.inner.clone();
    let lookup_id = id.clone();
    blocking(move || {
        inner
            .vault
            .get(&lookup_id)
            .map_err(code)?
            .ok_or_else(|| code(ImportError::CredentialNotFound))
    })
    .await?;
    require_presence("copy a saved password").await?;
    let inner = state.inner.clone();
    let password = blocking(move || inner.vault.password(&id).map_err(code)).await?;
    let digest = clipboard_digest(password.expose());
    app.clipboard()
        .write_text(password.expose().to_owned())
        .map_err(|error| error.to_string())?;
    drop(password);
    let generation = state
        .inner
        .clipboard_generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let inner = state.inner.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLIPBOARD_CLEAR_AFTER).await;
        // A later copy owns the clipboard (and its own timer).
        if inner.clipboard_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let still_ours = app
            .clipboard()
            .read_text()
            .is_ok_and(|current| clipboard_digest(&current) == digest);
        if still_ours {
            if let Err(error) = app.clipboard().clear() {
                log::warn!("clearing a copied password from the clipboard failed: {error}");
            }
        }
    });
    Ok(())
}

/// Write every credential as a Chrome-format CSV after OS user presence. The
/// renderer names no path: once presence succeeds Rust shows a native save
/// dialog and writes where the user chose. `None` when the dialog was
/// cancelled. The file is created fresh (`create_new`), never through a
/// symlink, owner-only on Unix.
#[tauri::command]
pub async fn browser_password_export(
    app: AppHandle,
    webview: Webview,
    state: State<'_, PasswordVaultState>,
) -> Result<Option<ExportResult>, String> {
    require_main_window(webview.label())?;
    require_presence("export saved passwords").await?;
    let builder = {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .set_file_name("cognia-passwords.csv")
            .add_filter("CSV", &["csv"])
    };
    let Some(target) = crate::browser::downloads::native_dialog::save_file(builder).await else {
        return Ok(None);
    };
    let inner = state.inner.clone();
    blocking(move || {
        let (csv, exported) = inner.vault.export_csv().map_err(code)?;
        // The native save dialog already asked the user to confirm replacing
        // an existing file, so an existing regular file may be replaced.
        write_private_file(&target, csv.expose().as_bytes(), true)?;
        Ok(Some(ExportResult { exported }))
    })
    .await
}

/// Create `path` owner-only and write `bytes`. An existing regular file is
/// removed first only when `replace_confirmed` (the save dialog's overwrite
/// prompt); a symlink or any other file type is refused, and the new file is
/// opened `create_new` so a link raced into place is never followed.
fn write_private_file(
    path: &std::path::Path,
    bytes: &[u8],
    replace_confirmed: bool,
) -> Result<(), String> {
    use std::io::Write;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("file_unwritable: refusing to write through a symlink".into());
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err("file_unwritable: not a regular file".into());
        }
        Ok(_) if !replace_confirmed => {
            return Err("file_unwritable: the file already exists".into());
        }
        Ok(_) => std::fs::remove_file(path).map_err(|_| "file_unwritable".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("file_unwritable".into()),
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "file_unwritable".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // `mode` is filtered by the umask; pin 0600 explicitly.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "file_unwritable".to_string())?;
    }
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "file_unwritable".to_string())
}

/// What a pending save prompt is about, without its password.
#[tauri::command]
pub async fn browser_password_pending_get(
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    pending_id: String,
) -> Result<Option<PendingSaveInfo>, String> {
    require_main_window(webview.label())?;
    let inner = state.inner.clone();
    blocking(move || {
        let (origin, username, password) = {
            let mut pending = lock_pending(&inner);
            prune(&mut pending, Instant::now());
            let Some(entry) = pending.get(&pending_id) else {
                return Ok(None);
            };
            (
                entry.origin.clone(),
                entry.username.clone(),
                entry.password.clone(),
            )
        };
        let kind = inner
            .vault
            .classify_pending(&origin, &username, &password)
            .map_err(code)?;
        Ok(Some(PendingSaveInfo {
            origin,
            username,
            kind,
        }))
    })
    .await
}

#[tauri::command]
pub async fn browser_password_pending_resolve(
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    pending_id: String,
    action: PendingAction,
) -> Result<Option<CredentialMeta>, String> {
    require_main_window(webview.label())?;
    let Some(pending) = state.take(&pending_id) else {
        return Err("pending_not_found".into());
    };
    let inner = state.inner.clone();
    blocking(move || resolve_pending(&inner.vault, pending, action)).await
}

fn resolve_pending(
    vault: &Vault<SecretStoreBackend>,
    pending: PendingSave,
    action: PendingAction,
) -> Result<Option<CredentialMeta>, String> {
    match action {
        PendingAction::Save | PendingAction::Update => vault
            .save(
                NewCredential {
                    origin: pending.origin,
                    realm: None,
                    username: pending.username,
                    password: pending.password,
                    source: "saved".into(),
                    note: None,
                    created_at: None,
                    last_used_at: Some(now_ms()),
                },
                now_ms(),
            )
            .map(|outcome| Some(outcome.into_meta()))
            .map_err(code),
        PendingAction::Never => {
            vault.add_never_save(&pending.origin).map_err(code)?;
            Ok(None)
        }
        PendingAction::Dismiss => Ok(None),
    }
}

/// Pick the credential to fill among the page's matches.
fn choose_credential(
    matches: &[CredentialMeta],
    requested: Option<&str>,
) -> Result<CredentialMeta, &'static str> {
    match requested.filter(|id| !id.is_empty()) {
        Some(id) => matches
            .iter()
            .find(|meta| meta.id == id)
            .cloned()
            .ok_or("no_match"),
        None => match matches {
            [] => Err("no_match"),
            [only] => Ok(only.clone()),
            _ => Err("ambiguous"),
        },
    }
}

/// A local session's page Rust resolved from the runtime's page list.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedPage {
    /// The runtime's page id (absent when the runtime lists none).
    id: Option<String>,
    url: String,
}

/// The id and URL of a local session's page (`pageId`, else the active page).
fn page_from_pages(pages: &serde_json::Value, page_id: Option<&str>) -> Option<ResolvedPage> {
    let pages = pages
        .as_array()
        .or_else(|| pages.get("pages").and_then(serde_json::Value::as_array))?;
    let page = match page_id.filter(|id| !id.is_empty()) {
        Some(id) => pages
            .iter()
            .find(|page| page.get("id").and_then(serde_json::Value::as_str) == Some(id)),
        None => pages.iter().find(|page| {
            page.get("active")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        }),
    }?;
    let url = page
        .get("url")
        .and_then(serde_json::Value::as_str)?
        .to_owned();
    let id = page
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    Some(ResolvedPage { id, url })
}

/// The privileged `browser.credential.fill` payload. The runtime reads
/// `origin` (the page must still be on it) and the page id Rust resolved from
/// its own page list — never the renderer's claim.
fn local_fill_payload(
    session_id: &str,
    page_id: Option<&str>,
    username: &str,
    password: &str,
    origin: &str,
) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
        "pageId": page_id,
        "username": username,
        "password": password,
        "origin": origin,
    })
}

/// The script that hands a credential to the embedded overlay's
/// `__cogniaFillLogin(username, password, expectedOrigin)`. Every argument is
/// a JS string literal. The script first compares a snapshot of
/// `window.location.origin` it takes itself (`location` is unforgeable, so a
/// page cannot fake it) with `expected_origin` and refuses before the helper
/// ever sees the password; the helper then checks again.
fn embedded_fill_script(
    username: &str,
    password: &str,
    expected_origin: &str,
) -> Result<String, String> {
    let expected = js_string(expected_origin)?;
    Ok(format!(
        "(function(){{var l=window.location,o=String(l.origin),e={expected};\
if(o!==e)return '{{\"filled\":false,\"username\":null,\"reason\":\"origin_mismatch\"}}';\
var f=window.__cogniaFillLogin;\
if(typeof f!=='function')return '{{\"filled\":false,\"username\":null,\"reason\":\"fill_failed\"}}';\
return f({},{},e)}})()",
        js_string(username)?,
        js_string(password)?,
    ))
}

/// A fill helper's answer (`{filled, username, reason?}`, possibly as a
/// JSON string): `Ok(())` when filled, else the refusal reason.
fn fill_outcome(value: &serde_json::Value) -> Result<(), &'static str> {
    match value {
        serde_json::Value::String(text) => match serde_json::from_str::<serde_json::Value>(text) {
            Ok(inner) if !inner.is_string() => fill_outcome(&inner),
            _ => Err("fill_failed"),
        },
        serde_json::Value::Bool(true) => Ok(()),
        other if other.get("filled").and_then(serde_json::Value::as_bool) == Some(true) => Ok(()),
        other => Err(
            match other.get("reason").and_then(serde_json::Value::as_str) {
                Some("no_login_form") => "no_login_form",
                Some("origin_mismatch") => "origin_mismatch",
                _ => "fill_failed",
            },
        ),
    }
}

/// Fill a stored credential into the embedded preview or a local Chromium
/// page. The credential is matched against the page's real URL (read in
/// Rust), not the renderer's claim; only `{filled, username}` comes back.
#[tauri::command]
pub async fn browser_credential_fill(
    app: AppHandle,
    webview: Webview,
    state: State<'_, PasswordVaultState>,
    request: FillRequest,
) -> Result<FillResult, String> {
    require_main_window(webview.label())?;
    let mut resolved_page_id: Option<String> = None;
    let page_url = match request.target {
        FillTarget::Embedded => app
            .get_webview(EMBED_LABEL)
            .ok_or_else(|| "embedded_not_open".to_string())?
            .url()
            .map_err(|error| error.to_string())?
            .to_string(),
        FillTarget::Local => {
            let session_id = request
                .session_id
                .clone()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| "session_required".to_string())?;
            let pages = crate::browser::local::rpc_privileged(
                &app,
                "browser.pages",
                serde_json::json!({ "sessionId": session_id }),
            )
            .await?;
            let page = page_from_pages(&pages, request.page_id.as_deref())
                .ok_or_else(|| "page_not_found".to_string())?;
            resolved_page_id = page.id;
            page.url
        }
    };
    if url::Url::parse(&request.url).ok().map(|url| url.origin())
        != url::Url::parse(&page_url).ok().map(|url| url.origin())
    {
        log::info!(
            "credential fill: the page navigated since the request; matching its current URL"
        );
    }
    let inner = state.inner.clone();
    let lookup_url = page_url.clone();
    let requested = request.credential_id.clone();
    let chosen = blocking(move || {
        let matches = inner.vault.matches(&lookup_url).map_err(code)?;
        match choose_credential(&matches, requested.as_deref()) {
            Ok(meta) => {
                let password = inner.vault.password(&meta.id).map_err(code)?;
                Ok(Ok((meta, password)))
            }
            Err(reason) => Ok(Err(reason)),
        }
    })
    .await?;
    let (meta, password) = match chosen {
        Ok(found) => found,
        Err(reason) => return Ok(FillResult::refused(reason)),
    };
    let expected_origin = url::Url::parse(&page_url)
        .map(|url| url.origin().ascii_serialization())
        .map_err(|error| error.to_string())?;
    let outcome = match request.target {
        FillTarget::Embedded => {
            let script = embedded_fill_script(&meta.username, password.expose(), &expected_origin)?;
            let result = crate::browser::embedded::eval_json_in_embedded(&app, &script).await;
            drop(script);
            fill_outcome(&result?)
        }
        FillTarget::Local => {
            let payload = local_fill_payload(
                request.session_id.as_deref().unwrap_or_default(),
                resolved_page_id.as_deref(),
                &meta.username,
                password.expose(),
                &expected_origin,
            );
            let response =
                crate::browser::local::rpc_privileged(&app, "browser.credential.fill", payload)
                    .await?;
            fill_outcome(&response)
        }
    };
    drop(password);
    if let Err(reason) = outcome {
        return Ok(FillResult::refused(reason));
    }
    let inner = state.inner.clone();
    let id = meta.id.clone();
    if let Err(error) = blocking(move || inner.vault.mark_used(&id, now_ms()).map_err(code)).await {
        log::warn!("recording credential use failed: {error}");
    }
    Ok(FillResult {
        filled: true,
        username: Some(meta.username),
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, username: &str) -> CredentialMeta {
        CredentialMeta {
            id: id.into(),
            origin: "https://github.com".into(),
            realm: None,
            username: username.into(),
            source: "manual".into(),
            created_at: 1,
            updated_at: 1,
            last_used_at: None,
            note: None,
        }
    }

    #[test]
    fn chooses_the_requested_or_unique_credential() {
        let one = [meta("a", "alice")];
        let two = [meta("a", "alice"), meta("b", "bob")];
        assert_eq!(choose_credential(&one, None).unwrap().id, "a");
        assert_eq!(choose_credential(&[], None), Err("no_match"));
        assert_eq!(choose_credential(&two, None), Err("ambiguous"));
        assert_eq!(choose_credential(&two, Some("b")).unwrap().username, "bob");
        assert_eq!(choose_credential(&two, Some("zzz")), Err("no_match"));
        assert_eq!(choose_credential(&one, Some("")).unwrap().id, "a");
    }

    #[test]
    fn reads_the_page_from_the_runtime_page_list() {
        let pages = serde_json::json!([
            { "id": "p1", "url": "https://a.com/", "active": false },
            { "id": "p2", "url": "https://b.com/login", "active": true }
        ]);
        assert_eq!(
            page_from_pages(&pages, Some("p1")),
            Some(ResolvedPage {
                id: Some("p1".into()),
                url: "https://a.com/".into()
            })
        );
        assert_eq!(
            page_from_pages(&pages, None),
            Some(ResolvedPage {
                id: Some("p2".into()),
                url: "https://b.com/login".into()
            })
        );
        assert_eq!(page_from_pages(&pages, Some("p9")), None);
        let wrapped =
            serde_json::json!({ "pages": [{ "id": "x", "url": "https://c.com", "active": true }] });
        assert_eq!(
            page_from_pages(&wrapped, None).map(|page| page.url),
            Some("https://c.com".into())
        );
        assert_eq!(page_from_pages(&serde_json::json!(null), None), None);
    }

    #[test]
    fn the_local_fill_payload_uses_the_runtime_keys() {
        let payload = local_fill_payload("s1", Some("p2"), "ada", "hunter2", "https://a.com");
        // Exactly what runtime-server.mjs destructures for
        // `browser.credential.fill`: { sessionId, pageId, username, password, origin }.
        assert_eq!(
            payload,
            serde_json::json!({
                "sessionId": "s1",
                "pageId": "p2",
                "username": "ada",
                "password": "hunter2",
                "origin": "https://a.com",
            })
        );
        let mut keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["origin", "pageId", "password", "sessionId", "username"]
        );
        assert_eq!(
            local_fill_payload("s1", None, "u", "p", "https://a.com")["pageId"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn the_embedded_script_checks_the_origin_before_calling_the_helper() {
        let script = embedded_fill_script("a\"b", "p'w</script>", "https://a.com").unwrap();
        let origin_check = script.find("if(o!==e)").unwrap();
        let helper_call = script.find("return f(").unwrap();
        assert!(origin_check < helper_call);
        assert!(script.starts_with("(function(){var l=window.location,o=String(l.origin),e="));
        assert!(script.contains(&format!("e={}", js_string("https://a.com").unwrap())));
        assert!(script.contains(&format!(
            "return f({},{},e)",
            js_string("a\"b").unwrap(),
            js_string("p'w</script>").unwrap()
        )));
        assert!(script.contains("origin_mismatch"));
        assert!(script.contains("typeof f!=='function'"));
        assert!(script.ends_with("})()"));
    }

    #[test]
    fn interprets_fill_helper_results() {
        assert_eq!(fill_outcome(&serde_json::json!(true)), Ok(()));
        assert_eq!(
            fill_outcome(&serde_json::json!({ "filled": true, "username": "u" })),
            Ok(())
        );
        assert_eq!(
            fill_outcome(&serde_json::json!("{\"filled\":true,\"username\":\"u\"}")),
            Ok(())
        );
        assert_eq!(
            fill_outcome(&serde_json::json!(
                "{\"filled\":false,\"username\":null,\"reason\":\"origin_mismatch\"}"
            )),
            Err("origin_mismatch")
        );
        assert_eq!(
            fill_outcome(&serde_json::json!({ "filled": false, "reason": "no_login_form" })),
            Err("no_login_form")
        );
        assert_eq!(
            fill_outcome(&serde_json::json!({ "filled": false })),
            Err("fill_failed")
        );
        assert_eq!(fill_outcome(&serde_json::json!(null)), Err("fill_failed"));
        assert_eq!(fill_outcome(&serde_json::json!("nope")), Err("fill_failed"));
    }

    #[test]
    fn pending_saves_expire_and_are_capped() {
        let state = PasswordVaultState::default();
        let id = state.stash("https://a.com".into(), "me".into(), "pw".into());
        assert_eq!(id.len(), 32);
        let taken = state.take(&id).unwrap();
        assert_eq!(taken.password.expose(), "pw");
        assert!(state.take(&id).is_none());

        let mut pending = HashMap::new();
        let old = Instant::now()
            .checked_sub(PENDING_TTL + Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        pending.insert(
            "old".to_string(),
            PendingSave {
                origin: "o".into(),
                username: "u".into(),
                password: "p".into(),
                created: old,
            },
        );
        prune(&mut pending, Instant::now());
        if old < Instant::now() - PENDING_TTL {
            assert!(pending.is_empty());
        }
        for index in 0..(PENDING_LIMIT + 5) {
            state.stash(format!("https://{index}.com"), "u".into(), "p".into());
        }
        assert!(lock_pending(&state.inner).len() <= PENDING_LIMIT);
    }

    #[test]
    fn resolving_a_pending_save_writes_the_vault_or_the_never_list() {
        let state = PasswordVaultState::default();
        let vault = &state.inner.vault;
        let pending = |origin: &str| PendingSave {
            origin: origin.into(),
            username: "me".into(),
            password: "pw".into(),
            created: Instant::now(),
        };
        let saved = resolve_pending(
            vault,
            pending("https://resolve-save.example"),
            PendingAction::Save,
        )
        .unwrap()
        .unwrap();
        assert_eq!(saved.source, "saved");
        assert_eq!(vault.password(&saved.id).unwrap().expose(), "pw");
        assert_eq!(
            resolve_pending(
                vault,
                pending("https://resolve-never.example"),
                PendingAction::Never
            ),
            Ok(None)
        );
        assert!(vault
            .is_never_save("https://resolve-never.example")
            .unwrap());
        assert_eq!(
            resolve_pending(
                vault,
                pending("https://resolve-dismiss.example"),
                PendingAction::Dismiss
            ),
            Ok(None)
        );
        vault.delete(&saved.id).unwrap();
        vault
            .remove_never_save("https://resolve-never.example")
            .unwrap();
    }

    #[test]
    fn secret_inputs_are_redacted() {
        let input: SecretInput = serde_json::from_value(serde_json::json!("hunter2")).unwrap();
        assert_eq!(format!("{input:?}"), "[REDACTED]");
        assert_eq!(input.into_secret().expose(), "hunter2");
        let mut owned = String::from("abc");
        zeroize_string(&mut owned);
        assert!(owned.is_empty());
    }

    #[test]
    fn ipc_shapes_match_the_contract() {
        let request: FillRequest = serde_json::from_value(serde_json::json!({
            "target": "local", "sessionId": "s", "pageId": null, "credentialId": null, "url": "https://a.com"
        }))
        .unwrap();
        assert_eq!(request.target, FillTarget::Local);
        assert_eq!(
            serde_json::to_value(FillResult::refused("ambiguous")).unwrap(),
            serde_json::json!({ "filled": false, "username": null, "reason": "ambiguous" })
        );
        assert_eq!(
            serde_json::to_value(PasswordImportResult {
                imported: 1,
                skipped_app_bound: 2,
                ..Default::default()
            })
            .unwrap(),
            serde_json::json!({ "imported": 1, "updated": 0, "skipped": 0, "skippedAppBound": 2, "errors": [] })
        );
        assert_eq!(
            serde_json::to_value(PendingSaveInfo {
                origin: "https://a.com".into(),
                username: "me".into(),
                kind: PendingKind::Update { id: "x".into() },
            })
            .unwrap(),
            serde_json::json!({ "origin": "https://a.com", "username": "me", "kind": "update", "id": "x" })
        );
        assert_eq!(
            serde_json::from_value::<PendingAction>(serde_json::json!("never")).unwrap(),
            PendingAction::Never
        );
        assert_eq!(csv_source(None), "csv");
        assert_eq!(csv_source(Some(CsvFormat::OnePassword)), "csv:1password");
    }

    #[test]
    fn exports_are_fresh_owner_only_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.csv");
        write_private_file(&path, b"name,url\n", false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"name,url\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        // An existing file is only replaced when the dialog confirmed it.
        assert!(write_private_file(&path, b"x", false).is_err());
        write_private_file(&path, b"new", true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        // A directory is never replaced.
        assert!(write_private_file(dir.path(), b"x", true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn exports_refuse_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim.txt");
        std::fs::write(&victim, b"keep").unwrap();
        let link = dir.path().join("link.csv");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        let error = write_private_file(&link, b"secrets", true).unwrap_err();
        assert!(error.contains("symlink"), "{error}");
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn presence_errors_carry_their_codes() {
        assert_eq!(
            presence_error(UserPresenceError::Denied),
            "user_presence_denied"
        );
        assert_eq!(
            presence_error(UserPresenceError::Unavailable),
            "user_presence_unavailable"
        );
        assert_eq!(
            presence_error(UserPresenceError::Cancelled),
            "user_presence_cancelled"
        );
    }
}
