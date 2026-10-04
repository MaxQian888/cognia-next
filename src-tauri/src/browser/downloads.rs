//! The browser's Downloads directory and the embedded webview's download
//! handler (ADR-0201).
//!
//! One directory serves every desktop backend: the embedded webview routes its
//! downloads here through `WebviewBuilder::on_download`
//! ([`handle_embedded_download`]), and the local Chromium runtime receives it
//! as `downloadsDir` on `browser.session.create` ([`current_downloads_dir`]).
//! The user may pick another directory and opt into "ask where to save"; both
//! persist in `<app_data>/browser/downloads.json`. The directory is chosen in a
//! native folder picker Rust shows (`browser_downloads_dir_choose`); the
//! renderer never names a path. The home directory itself, filesystem roots,
//! system directories and hidden or `Library`/`AppData` directories under home
//! are refused.
//!
//! `browser_download_reveal` / `browser_download_open` / `browser_download_read`
//! only accept a path a download reported: the local runtime's
//! `download.updated` events ([`remember_reported_download`]) or a file the
//! embedded webview's download handler itself saved. The set is bounded
//! (least recently reported first out). A compromised renderer therefore
//! cannot use them on arbitrary files, not even other files in the Downloads
//! directory. `open` only launches an allow-list of document, media and
//! archive types (everything else, including files without an extension, is
//! `download_open_blocked_executable`; the UI offers reveal instead) and
//! `read` refuses files over 64 MB.
//!
//! `browser_download_save_as` copies a local-runtime download to a path the
//! user picks in a native save dialog; the runtime's `browser.download.save`
//! is Rust-only.
//!
//! Naming (sanitizing, collision-safe `name (1).ext`, containment) lives in
//! `cognia_local_browser::local_files`; this file is the Tauri shell.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};

use cognia_local_browser::local_files::{
    filename_from_url, sanitize_filename, unique_destination_with,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Webview};

use crate::browser::cookie_import::require_main_window;

/// Event the embedded webview's download handler emits.
pub const DOWNLOAD_EVENT: &str = "browser://download";
const SETTINGS_FILE: &str = "downloads.json";
/// How many reported download paths reveal/open/read remember.
pub(crate) const REPORTED_LIMIT: usize = 1000;

/// Persisted user choice. `path: None` means the OS Downloads directory.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadSettings {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub ask_where_to_save: bool,
}

/// `browser_downloads_dir_get` / `_choose` / `_reset` / `_set` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadsDirInfo {
    pub path: String,
    pub is_default: bool,
    pub ask_where_to_save: bool,
}

/// `browser://download` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEventPayload {
    pub phase: &'static str,
    pub id: String,
    pub url: String,
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingDownload {
    id: String,
    destination: PathBuf,
    filename: String,
}

/// Paths downloads reported, bounded: re-reporting a path refreshes it, and
/// the least recently reported path is forgotten first.
#[derive(Debug)]
pub(crate) struct ReportedPaths {
    order: VecDeque<PathBuf>,
    set: HashSet<PathBuf>,
    limit: usize,
}

impl Default for ReportedPaths {
    fn default() -> Self {
        Self::with_limit(REPORTED_LIMIT)
    }
}

impl ReportedPaths {
    pub(crate) fn with_limit(limit: usize) -> Self {
        Self {
            order: VecDeque::new(),
            set: HashSet::new(),
            limit: limit.max(1),
        }
    }

    pub(crate) fn insert(&mut self, path: PathBuf) {
        if self.set.contains(&path) {
            self.order.retain(|known| known != &path);
        } else {
            while self.set.len() >= self.limit {
                match self.order.pop_front() {
                    Some(oldest) => {
                        self.set.remove(&oldest);
                    }
                    None => break,
                }
            }
            self.set.insert(path.clone());
        }
        self.order.push_back(path);
    }

    pub(crate) fn contains(&self, path: &Path) -> bool {
        self.set.contains(path)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.set.len()
    }
}

/// Managed state: the cached settings, paths reported to the renderer, and
/// embedded downloads in flight (keyed by URL — wry reports only the URL on
/// completion).
#[derive(Default)]
pub struct BrowserDownloadsState {
    settings: parking_lot::Mutex<Option<DownloadSettings>>,
    reported: parking_lot::Mutex<ReportedPaths>,
    pending: parking_lot::Mutex<HashMap<String, VecDeque<PendingDownload>>>,
}

impl BrowserDownloadsState {
    fn remember(&self, path: &Path) {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        self.reported.lock().insert(canonical);
    }

    fn was_reported(&self, path: &Path) -> bool {
        match std::fs::canonicalize(path) {
            Ok(canonical) => self.reported.lock().contains(&canonical),
            Err(_) => false,
        }
    }

    fn reserved(&self, candidate: &Path) -> bool {
        self.pending
            .lock()
            .values()
            .flatten()
            .any(|pending| pending.destination == candidate)
    }

    fn push_pending(&self, url: &str, pending: PendingDownload) {
        self.pending
            .lock()
            .entry(url.to_string())
            .or_default()
            .push_back(pending);
    }

    fn pop_pending(&self, url: &str) -> Option<PendingDownload> {
        let mut map = self.pending.lock();
        let queue = map.get_mut(url)?;
        let pending = queue.pop_front();
        if queue.is_empty() {
            map.remove(url);
        }
        pending
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Tolerant settings parse: a missing or corrupt file means defaults.
pub(crate) fn parse_settings(bytes: &[u8]) -> DownloadSettings {
    serde_json::from_slice(bytes).unwrap_or_default()
}

/// Directories no download may land in (and their subtrees): the OS and
/// program directories of this platform.
pub(crate) fn system_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        [
            "SystemRoot",
            "windir",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "ProgramData",
        ]
        .iter()
        .filter_map(|key| std::env::var_os(key))
        .map(PathBuf::from)
        .collect()
    }
    #[cfg(not(windows))]
    {
        [
            "/bin",
            "/boot",
            "/dev",
            "/etc",
            "/lib",
            "/lib32",
            "/lib64",
            "/libexec",
            "/opt",
            "/proc",
            "/root",
            "/run",
            "/sbin",
            "/snap",
            "/sys",
            "/usr",
            "/var/db",
            "/var/lib",
            "/var/log",
            "/var/spool",
            "/Applications",
            "/Library",
            "/System",
            "/private/etc",
            "/private/var/db",
            "/private/var/log",
            "/cores",
        ]
        .iter()
        .map(PathBuf::from)
        .collect()
    }
}

/// Under the home directory: dot-directories (`~/.ssh`, `~/.config`) and the
/// per-user program/config trees (`~/Library`, `~/AppData`) hold startup items
/// and credentials; a download must never be dropped there.
fn is_sensitive_under_home(relative: &Path) -> bool {
    let mut components = relative.components().peekable();
    if let Some(first) = components.peek() {
        let first = first.as_os_str().to_string_lossy().to_ascii_lowercase();
        if first == "library" || first == "appdata" {
            return true;
        }
    }
    relative
        .components()
        .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
}

/// Why `dir` may not be the Downloads directory, if it may not: a filesystem
/// root, `home` itself, a sensitive directory under `home`, or a system
/// directory (or anything inside one).
pub(crate) fn forbidden_downloads_dir(
    dir: &Path,
    home: Option<&Path>,
    system: &[PathBuf],
) -> Option<&'static str> {
    if dir.parent().is_none()
        || dir
            .components()
            .all(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
    {
        return Some("a filesystem root");
    }
    let homes: Vec<PathBuf> = home
        .into_iter()
        .flat_map(|home| {
            let canonical = std::fs::canonicalize(home).ok();
            std::iter::once(home.to_path_buf()).chain(canonical)
        })
        .collect();
    for home in &homes {
        if dir == home.as_path() {
            return Some("the home directory itself");
        }
        if let Ok(relative) = dir.strip_prefix(home) {
            if is_sensitive_under_home(relative) {
                return Some("a hidden or application directory in home");
            }
        }
    }
    let lower = |path: &Path| path.to_string_lossy().to_lowercase();
    let dir_text = lower(dir);
    for system_dir in system {
        let candidates = std::iter::once(system_dir.clone())
            .chain(std::fs::canonicalize(system_dir).ok());
        for candidate in candidates {
            // Case-insensitive: macOS and Windows file systems usually are.
            let candidate = lower(&candidate);
            let candidate = candidate.trim_end_matches(['/', '\\']);
            if candidate.is_empty() {
                continue;
            }
            if dir_text == candidate
                || dir_text.starts_with(&format!("{candidate}/"))
                || dir_text.starts_with(&format!("{candidate}\\"))
            {
                return Some("a system directory");
            }
        }
    }
    None
}

/// A chosen directory must be absolute, free of `..`, not a forbidden
/// directory ([`forbidden_downloads_dir`], checked before anything is created
/// and again on the canonical path), and end up a directory (created when
/// missing).
pub(crate) fn validate_custom_dir_with(
    raw: &str,
    home: Option<&Path>,
    system: &[PathBuf],
) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("downloads_dir_invalid: empty path".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("downloads_dir_invalid: path must be absolute".to_string());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("downloads_dir_invalid: path must not contain ..".to_string());
    }
    if let Some(reason) = forbidden_downloads_dir(&path, home, system) {
        return Err(format!("downloads_dir_forbidden: {reason}"));
    }
    std::fs::create_dir_all(&path).map_err(|error| format!("downloads_dir_invalid: {error}"))?;
    if !path.is_dir() {
        return Err("downloads_dir_invalid: not a directory".to_string());
    }
    let canonical = std::fs::canonicalize(&path)
        .map_err(|error| format!("downloads_dir_invalid: {error}"))?;
    if let Some(reason) = forbidden_downloads_dir(&canonical, home, system) {
        return Err(format!("downloads_dir_forbidden: {reason}"));
    }
    Ok(path)
}

/// [`validate_custom_dir_with`] for this machine's home and system dirs.
pub(crate) fn validate_custom_dir(raw: &str) -> Result<PathBuf, String> {
    validate_custom_dir_with(raw, dirs::home_dir().as_deref(), &system_dirs())
}

/// The directory in effect: the custom one while it is usable, else
/// `default_dir`. Returns `(dir, is_default)`.
pub(crate) fn resolve_dir(settings: &DownloadSettings, default_dir: &Path) -> (PathBuf, bool) {
    if let Some(custom) = settings.path.as_deref() {
        if let Ok(dir) = validate_custom_dir(custom) {
            return (dir, false);
        }
    }
    (default_dir.to_path_buf(), true)
}

/// The file name to save as: the name the webview suggested (the last
/// component of its proposed destination) when there is one, else the URL's.
pub(crate) fn pick_filename(suggested: &Path, url: &str) -> String {
    let from_suggestion = suggested
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.trim().is_empty());
    match from_suggestion {
        Some(name) if !suggested.is_dir() => sanitize_filename(&name),
        _ => filename_from_url(url),
    }
}

/// The only file types `browser_download_open` hands to the OS default
/// handler: documents, images, audio, video and archives that do not execute
/// on open. Everything else (programs, scripts, installers, shortcuts, HTML,
/// macro-enabled or legacy Office formats, files without an extension) is
/// refused and the UI offers "show in folder" instead.
pub(crate) const SAFE_OPEN_EXTENSIONS: &[&str] = &[
    // Documents
    "pdf", "txt", "md", "markdown", "csv", "tsv", "json", "log", "rtf", "docx", "xlsx", "pptx",
    "odt", "ods", "odp", "epub",
    // Images
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "ico",
    // Audio
    "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus",
    // Video
    "mp4", "m4v", "mov", "webm", "mkv", "avi", "ogv",
    // Archives
    "zip", "tar", "gz", "tgz", "bz2", "xz",
];

/// Whether `path` is a type `browser_download_open` may launch.
pub(crate) fn is_safe_to_open(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|ext| SAFE_OPEN_EXTENSIONS.contains(&ext.as_str()))
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("browser").join(SETTINGS_FILE))
}

fn load_settings<R: Runtime>(app: &AppHandle<R>) -> DownloadSettings {
    if let Some(state) = app.try_state::<BrowserDownloadsState>() {
        if let Some(cached) = state.settings.lock().clone() {
            return cached;
        }
    }
    let settings = settings_path(app)
        .and_then(|path| std::fs::read(path).ok())
        .map(|bytes| parse_settings(&bytes))
        .unwrap_or_default();
    if let Some(state) = app.try_state::<BrowserDownloadsState>() {
        *state.settings.lock() = Some(settings.clone());
    }
    settings
}

fn save_settings<R: Runtime>(
    app: &AppHandle<R>,
    settings: &DownloadSettings,
) -> Result<(), String> {
    let path = settings_path(app).ok_or_else(|| "app data directory unavailable".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|error| error.to_string())?;
    if let Some(state) = app.try_state::<BrowserDownloadsState>() {
        *state.settings.lock() = Some(settings.clone());
    }
    Ok(())
}

fn default_downloads_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .download_dir()
        .ok()
        .or_else(|| {
            app.path()
                .app_data_dir()
                .ok()
                .map(|dir| dir.join("browser").join("downloads"))
        })
        .unwrap_or_else(|| std::env::temp_dir().join("cognia-downloads"))
}

/// The Downloads directory in effect for every backend (created on demand).
pub fn current_downloads_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let (dir, _) = resolve_dir(&load_settings(app), &default_downloads_dir(app));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn dir_info<R: Runtime>(app: &AppHandle<R>) -> DownloadsDirInfo {
    let settings = load_settings(app);
    let (dir, is_default) = resolve_dir(&settings, &default_downloads_dir(app));
    DownloadsDirInfo {
        path: dir.to_string_lossy().into_owned(),
        is_default,
        ask_where_to_save: settings.ask_where_to_save,
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn browser_downloads_dir_get(
    app: AppHandle,
    webview: Webview,
) -> Result<DownloadsDirInfo, String> {
    require_main_window(webview.label())?;
    tauri::async_runtime::spawn_blocking(move || dir_info(&app))
        .await
        .map_err(|error| error.to_string())
}

/// Let the user pick the Downloads directory in a native folder picker and
/// save it with the "ask where to save" preference. `None` when the picker
/// was cancelled (nothing changes). The renderer never names the path.
#[tauri::command]
pub async fn browser_downloads_dir_choose(
    app: AppHandle,
    webview: Webview,
    ask_where_to_save: bool,
) -> Result<Option<DownloadsDirInfo>, String> {
    require_main_window(webview.label())?;
    let start_dir = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || current_downloads_dir(&app))
            .await
            .map_err(|error| error.to_string())?
    };
    let builder = {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .set_directory(start_dir)
            .set_can_create_directories(true)
    };
    let Some(chosen) = native_dialog::pick_folder(builder).await else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let dir = validate_custom_dir(&chosen.to_string_lossy())?;
        save_settings(
            &app,
            &DownloadSettings {
                path: Some(dir.to_string_lossy().into_owned()),
                ask_where_to_save,
            },
        )?;
        Ok(Some(dir_info(&app)))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Restore the OS Downloads directory, keeping "ask where to save".
#[tauri::command]
pub async fn browser_downloads_dir_reset(
    app: AppHandle,
    webview: Webview,
) -> Result<DownloadsDirInfo, String> {
    require_main_window(webview.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let current = load_settings(&app);
        save_settings(
            &app,
            &DownloadSettings {
                path: None,
                ask_where_to_save: current.ask_where_to_save,
            },
        )?;
        Ok(dir_info(&app))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Toggle "ask where to save" only; the directory is unchanged (it is chosen
/// with `browser_downloads_dir_choose`).
#[tauri::command]
pub async fn browser_downloads_dir_set(
    app: AppHandle,
    webview: Webview,
    ask_where_to_save: bool,
) -> Result<DownloadsDirInfo, String> {
    require_main_window(webview.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let current = load_settings(&app);
        save_settings(
            &app,
            &DownloadSettings {
                path: current.path,
                ask_where_to_save,
            },
        )?;
        Ok(dir_info(&app))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Reveal/open/read only accept a path a download reported (the local
/// runtime's events or the embedded handler's own saves). Returns the
/// canonical path.
pub(crate) fn authorize_download_path_in(
    state: &BrowserDownloadsState,
    raw: &str,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() || !path.exists() {
        return Err("download_not_found".to_string());
    }
    if state.was_reported(&path) {
        return std::fs::canonicalize(&path).map_err(|_| "download_not_found".to_string());
    }
    Err("download_path_not_allowed".to_string())
}

/// Largest file `browser_download_read` hands to the renderer.
pub const MAX_DOWNLOAD_READ_BYTES: u64 = 64 * 1024 * 1024;

/// Size gate for `browser_download_read`: files only, at most
/// [`MAX_DOWNLOAD_READ_BYTES`].
pub(crate) fn check_readable(metadata: &std::fs::Metadata) -> Result<(), String> {
    if !metadata.is_file() {
        return Err("download_not_found".to_string());
    }
    if metadata.len() > MAX_DOWNLOAD_READ_BYTES {
        return Err("download_too_large".to_string());
    }
    Ok(())
}

/// Raw bytes of a finished download for "attach to chat" — same reported-path
/// rule as reveal/open, so the fs plugin scope never has to cover a directory
/// the user can change. Refuses files over 64 MB (`download_too_large`).
#[tauri::command]
pub async fn browser_download_read(
    webview: Webview,
    state: State<'_, BrowserDownloadsState>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    require_main_window(webview.label())?;
    let path = authorize_download_path_in(&state, &path)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| "download_not_found".to_string())?;
    check_readable(&metadata)?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("download_read_failed: {error}"))?;
    // The file may have grown between the size check and the read.
    if bytes.len() as u64 > MAX_DOWNLOAD_READ_BYTES {
        return Err("download_too_large".to_string());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn browser_download_reveal(
    app: AppHandle,
    webview: Webview,
    state: State<'_, BrowserDownloadsState>,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    require_main_window(webview.label())?;
    let path = authorize_download_path_in(&state, &path)?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| error.to_string())
}

/// Open a reported download with the OS default handler — only types on
/// [`SAFE_OPEN_EXTENSIONS`]; anything else is
/// `download_open_blocked_executable` (reveal it instead).
#[tauri::command]
pub async fn browser_download_open(
    app: AppHandle,
    webview: Webview,
    state: State<'_, BrowserDownloadsState>,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    require_main_window(webview.label())?;
    let path = authorize_download_path_in(&state, &path)?;
    if !path.is_file() || !is_safe_to_open(&path) {
        return Err("download_open_blocked_executable".to_string());
    }
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// The file name a runtime download list gives `download_id`.
fn download_filename(list: &serde_json::Value, download_id: &str) -> Option<String> {
    let items = list
        .as_array()
        .or_else(|| list.get("downloads").and_then(serde_json::Value::as_array))?;
    items
        .iter()
        .find(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(download_id))
        .and_then(|item| item.get("filename").and_then(serde_json::Value::as_str))
        .map(sanitize_filename)
}

/// The Rust-only `browser.download.save` payload.
fn download_save_payload(session_id: &str, download_id: &str, target: &Path) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
        "downloadId": download_id,
        "targetPath": target.to_string_lossy(),
    })
}

/// Copy a finished local-runtime download to a path the user picks in a
/// native save dialog. `None` when the dialog was cancelled. The runtime's
/// `browser.download.save` is not renderer-callable.
#[tauri::command]
pub async fn browser_download_save_as(
    app: AppHandle,
    webview: Webview,
    state: State<'_, BrowserDownloadsState>,
    session_id: String,
    download_id: String,
) -> Result<Option<serde_json::Value>, String> {
    require_main_window(webview.label())?;
    if session_id.trim().is_empty() || download_id.trim().is_empty() {
        return Err("download_not_found".to_string());
    }
    let list = crate::browser::local::rpc_privileged(
        &app,
        "browser.downloads",
        serde_json::json!({ "sessionId": session_id }),
    )
    .await?;
    let filename =
        download_filename(&list, &download_id).ok_or_else(|| "download_not_found".to_string())?;
    let start_dir = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || current_downloads_dir(&app))
            .await
            .map_err(|error| error.to_string())?
    };
    let builder = {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .set_file_name(filename)
            .set_directory(start_dir)
    };
    let Some(target) = native_dialog::save_file(builder).await else {
        return Ok(None);
    };
    let result = crate::browser::local::rpc_privileged(
        &app,
        "browser.download.save",
        download_save_payload(&session_id, &download_id, &target),
    )
    .await?;
    let saved = result
        .get("savedPath")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
        .unwrap_or(target);
    state.remember(&saved);
    Ok(Some(result))
}

/// Record a path the local Chromium runtime reported (`download.updated`) so
/// reveal/open accept it even when it was saved outside the directory.
pub fn remember_reported_download<R: Runtime>(app: &AppHandle<R>, path: &Path) {
    if let Some(state) = app.try_state::<BrowserDownloadsState>() {
        state.remember(path);
    }
}

// ---------------------------------------------------------------------------
// Embedded webview download handler
// ---------------------------------------------------------------------------

fn emit<R: Runtime>(app: &AppHandle<R>, payload: DownloadEventPayload) {
    let _ = app.emit(DOWNLOAD_EVENT, payload);
}

fn new_download_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `WebviewBuilder::on_download` body for the embedded webview. Routes every
/// download into the Downloads directory under a collision-safe name, emits
/// `requested` / `finished`, and — with "ask where to save" on — offers a save
/// dialog once the file is complete and moves it there.
pub(crate) fn handle_embedded_download<R: Runtime>(
    webview: &tauri::Webview<R>,
    event: tauri::webview::DownloadEvent<'_>,
) -> bool {
    let app = webview.app_handle().clone();
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            let url = url.to_string();
            let filename = pick_filename(destination, &url);
            let dir = current_downloads_dir(&app);
            let target = match app.try_state::<BrowserDownloadsState>() {
                Some(state) => unique_destination_with(&dir, &filename, |candidate| {
                    candidate.exists() || state.reserved(candidate)
                }),
                None => unique_destination_with(&dir, &filename, Path::exists),
            };
            let filename = target
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or(filename);
            let id = new_download_id();
            *destination = target.clone();
            if let Some(state) = app.try_state::<BrowserDownloadsState>() {
                state.push_pending(
                    &url,
                    PendingDownload {
                        id: id.clone(),
                        destination: target,
                        filename: filename.clone(),
                    },
                );
            }
            emit(
                &app,
                DownloadEventPayload {
                    phase: "requested",
                    id,
                    url,
                    filename,
                    saved_path: None,
                    success: None,
                    error: None,
                },
            );
            true
        }
        tauri::webview::DownloadEvent::Finished { url, path, success } => {
            let url = url.to_string();
            let pending = app
                .try_state::<BrowserDownloadsState>()
                .and_then(|state| state.pop_pending(&url));
            // macOS never reports the path; fall back to the destination we set.
            let saved = path
                .filter(|path| !path.as_os_str().is_empty())
                .or_else(|| pending.as_ref().map(|p| p.destination.clone()));
            let id = pending
                .as_ref()
                .map(|p| p.id.clone())
                .unwrap_or_else(new_download_id);
            let filename = pending
                .as_ref()
                .map(|p| p.filename.clone())
                .or_else(|| {
                    saved
                        .as_ref()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().into_owned())
                })
                .unwrap_or_else(|| filename_from_url(&url));
            if !success {
                emit(
                    &app,
                    DownloadEventPayload {
                        phase: "finished",
                        id,
                        url,
                        filename,
                        saved_path: None,
                        success: Some(false),
                        error: Some("download_failed".to_string()),
                    },
                );
                return true;
            }
            if let (Some(state), Some(saved)) =
                (app.try_state::<BrowserDownloadsState>(), saved.as_ref())
            {
                state.remember(saved);
            }
            let ask = load_settings(&app).ask_where_to_save;
            match (ask, saved) {
                (true, Some(saved)) => ask_and_move(app, id, url, filename, saved),
                (_, saved) => emit(
                    &app,
                    DownloadEventPayload {
                        phase: "finished",
                        id,
                        url,
                        filename,
                        saved_path: saved.map(|p| p.to_string_lossy().into_owned()),
                        success: Some(true),
                        error: None,
                    },
                ),
            }
            true
        }
        _ => true,
    }
}

/// Move `from` to `to`, falling back to copy + remove across volumes.
pub(crate) fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(from, to)?;
            std::fs::remove_file(from)
        }
    }
}

fn ask_and_move<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    url: String,
    filename: String,
    saved: PathBuf,
) {
    use tauri_plugin_dialog::DialogExt;
    let dir = saved
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| current_downloads_dir(&app));
    let callback_app = app.clone();
    app.dialog()
        .file()
        .set_file_name(filename.clone())
        .set_directory(dir)
        .save_file(move |choice| {
            let chosen = choice.and_then(|choice| choice.into_path().ok());
            let (final_path, error) = match chosen {
                Some(target) if target != saved => match move_file(&saved, &target) {
                    Ok(()) => (target, None),
                    Err(error) => (
                        saved.clone(),
                        Some(format!("download_move_failed: {error}")),
                    ),
                },
                _ => (saved.clone(), None),
            };
            if let Some(state) = callback_app.try_state::<BrowserDownloadsState>() {
                state.remember(&final_path);
            }
            let filename = final_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or(filename);
            emit(
                &callback_app,
                DownloadEventPayload {
                    phase: "finished",
                    id,
                    url,
                    filename,
                    saved_path: Some(final_path.to_string_lossy().into_owned()),
                    success: Some(true),
                    error,
                },
            );
        });
}

/// Native file dialogs awaited without blocking an async worker: the plugin's
/// callback form feeds a oneshot channel. Shared by every browser command
/// that needs a path from the user (downloads, password export, extension
/// install, uploads).
pub(crate) mod native_dialog {
    use std::path::PathBuf;

    use tauri::Runtime;
    use tauri_plugin_dialog::{FileDialogBuilder, FilePath};

    fn to_path(path: FilePath) -> Option<PathBuf> {
        path.into_path().ok()
    }

    pub(crate) async fn pick_folder<R: Runtime>(builder: FileDialogBuilder<R>) -> Option<PathBuf> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        builder.pick_folder(move |choice| {
            let _ = tx.send(choice.and_then(to_path));
        });
        rx.await.ok().flatten()
    }

    pub(crate) async fn pick_file<R: Runtime>(builder: FileDialogBuilder<R>) -> Option<PathBuf> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        builder.pick_file(move |choice| {
            let _ = tx.send(choice.and_then(to_path));
        });
        rx.await.ok().flatten()
    }

    pub(crate) async fn pick_files<R: Runtime>(builder: FileDialogBuilder<R>) -> Vec<PathBuf> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        builder.pick_files(move |choice| {
            let paths = choice
                .unwrap_or_default()
                .into_iter()
                .filter_map(to_path)
                .collect::<Vec<_>>();
            let _ = tx.send(paths);
        });
        rx.await.unwrap_or_default()
    }

    pub(crate) async fn save_file<R: Runtime>(builder: FileDialogBuilder<R>) -> Option<PathBuf> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        builder.save_file(move |choice| {
            let _ = tx.send(choice.and_then(to_path));
        });
        rx.await.ok().flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_parse_is_tolerant() {
        assert_eq!(parse_settings(b""), DownloadSettings::default());
        assert_eq!(parse_settings(b"not json"), DownloadSettings::default());
        assert_eq!(
            parse_settings(br#"{"path":"/x","askWhereToSave":true}"#),
            DownloadSettings {
                path: Some("/x".into()),
                ask_where_to_save: true
            }
        );
        assert_eq!(
            parse_settings(br#"{"askWhereToSave":true}"#),
            DownloadSettings {
                path: None,
                ask_where_to_save: true
            }
        );
    }

    #[test]
    fn settings_round_trip_camel_case() {
        let json = serde_json::to_string(&DownloadSettings {
            path: Some("/d".into()),
            ask_where_to_save: false,
        })
        .unwrap();
        assert_eq!(json, r#"{"path":"/d","askWhereToSave":false}"#);
    }

    #[test]
    fn custom_dirs_must_be_absolute_directories() {
        assert!(validate_custom_dir("").is_err());
        assert!(validate_custom_dir("relative/dir").is_err());
        let tmp = tempfile::tempdir().unwrap();
        let fresh = tmp.path().join("new").join("nested");
        assert_eq!(validate_custom_dir(fresh.to_str().unwrap()).unwrap(), fresh);
        assert!(fresh.is_dir());
        let file = tmp.path().join("file");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_custom_dir(file.to_str().unwrap()).is_err());
        let dotted = tmp.path().join("a").join("..").join("b");
        assert!(validate_custom_dir(dotted.to_str().unwrap())
            .unwrap_err()
            .contains(".."));
    }

    #[test]
    fn home_roots_system_and_hidden_dirs_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let system = tmp.path().join("sys");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&system).unwrap();
        let systems = vec![system.clone()];
        let check = |dir: &Path| validate_custom_dir_with(dir.to_str().unwrap(), Some(&home), &systems);

        assert!(check(&home).unwrap_err().starts_with("downloads_dir_forbidden"));
        assert!(check(&system).unwrap_err().starts_with("downloads_dir_forbidden"));
        assert!(check(&system.join("inner")).is_err());
        assert!(!system.join("inner").exists(), "nothing is created in a refused dir");
        for hidden in [".ssh", ".config/autostart", "Library/LaunchAgents", "AppData/Roaming"] {
            let dir = home.join(hidden);
            assert!(
                check(&dir).unwrap_err().starts_with("downloads_dir_forbidden"),
                "{hidden}"
            );
            assert!(!dir.exists(), "{hidden} was created");
        }
        // Ordinary directories under home are fine.
        assert_eq!(check(&home.join("Downloads")).unwrap(), home.join("Downloads"));
        assert_eq!(
            check(&home.join("Documents/dl")).unwrap(),
            home.join("Documents/dl")
        );
        // A sibling whose name merely starts like the system dir is fine.
        let sibling = tmp.path().join("sysfoo");
        assert!(check(&sibling).is_ok());

        assert_eq!(
            forbidden_downloads_dir(Path::new("/"), None, &[]),
            Some("a filesystem root")
        );
        #[cfg(unix)]
        {
            // A symlink into a refused directory is caught on the canonical path.
            let link = tmp.path().join("sneaky");
            std::os::unix::fs::symlink(&system, &link).unwrap();
            assert!(check(&link).unwrap_err().starts_with("downloads_dir_forbidden"));
        }
    }

    #[test]
    fn the_real_system_dirs_are_refused() {
        #[cfg(unix)]
        for dir in ["/etc", "/usr/local/bin", "/System/Library", "/Applications"] {
            assert!(
                forbidden_downloads_dir(Path::new(dir), None, &system_dirs()).is_some(),
                "{dir}"
            );
        }
        if let Some(home) = dirs::home_dir() {
            assert!(forbidden_downloads_dir(&home, Some(&home), &system_dirs()).is_some());
            assert!(
                forbidden_downloads_dir(&home.join("Downloads"), Some(&home), &system_dirs())
                    .is_none()
            );
        }
    }

    #[test]
    fn resolve_dir_prefers_a_usable_custom_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let default = tmp.path().join("default");
        let custom = tmp.path().join("custom");
        let settings = DownloadSettings {
            path: Some(custom.to_string_lossy().into_owned()),
            ask_where_to_save: false,
        };
        assert_eq!(resolve_dir(&settings, &default), (custom, false));
        assert_eq!(
            resolve_dir(&DownloadSettings::default(), &default),
            (default.clone(), true)
        );
        let unusable = DownloadSettings {
            path: Some("relative".into()),
            ask_where_to_save: false,
        };
        assert_eq!(resolve_dir(&unusable, &default), (default, true));
    }

    #[test]
    fn filenames_come_from_the_suggestion_or_the_url() {
        assert_eq!(
            pick_filename(Path::new("/Users/me/Downloads/report.pdf"), "https://x/y"),
            "report.pdf"
        );
        assert_eq!(
            pick_filename(Path::new(""), "https://x/a/data.csv?x=1"),
            "data.csv"
        );
        assert_eq!(
            pick_filename(Path::new("/tmp/../../evil"), "https://x/"),
            "evil"
        );
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(pick_filename(dir.path(), "https://x/f.zip"), "f.zip");
    }

    #[test]
    fn only_allow_listed_types_are_opened() {
        for name in [
            "report.pdf",
            "photo.PNG",
            "archive.zip",
            "data.tar.gz",
            "notes.md",
            "sheet.xlsx",
            "clip.mp4",
            "song.mp3",
        ] {
            assert!(is_safe_to_open(Path::new(name)), "{name}");
        }
        for name in [
            "setup.exe",
            "a.MSI",
            "run.sh",
            "x.app",
            "evil.ps1",
            "page.html",
            "macro.docm",
            "legacy.doc",
            "installer.dmg",
            "pkg.pkg",
            "script.py",
            "link.lnk",
            "shortcut.desktop",
            "image.svg",
            "noext",
            ".bashrc",
        ] {
            assert!(!is_safe_to_open(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn reported_paths_are_bounded_lru() {
        let mut reported = ReportedPaths::with_limit(3);
        for name in ["a", "b", "c"] {
            reported.insert(PathBuf::from(name));
        }
        // Re-reporting "a" refreshes it, so "b" is the oldest.
        reported.insert(PathBuf::from("a"));
        reported.insert(PathBuf::from("d"));
        assert_eq!(reported.len(), 3);
        assert!(!reported.contains(Path::new("b")));
        for name in ["a", "c", "d"] {
            assert!(reported.contains(Path::new(name)), "{name}");
        }
        assert_eq!(ReportedPaths::default().limit, REPORTED_LIMIT);
        let mut many = ReportedPaths::default();
        for index in 0..(REPORTED_LIMIT + 50) {
            many.insert(PathBuf::from(format!("/d/{index}")));
        }
        assert_eq!(many.len(), REPORTED_LIMIT);
        assert!(!many.contains(Path::new("/d/0")));
        assert!(many.contains(&PathBuf::from(format!("/d/{}", REPORTED_LIMIT + 49))));
    }

    #[test]
    fn save_as_reads_the_runtime_filename_and_builds_the_privileged_payload() {
        let list = serde_json::json!([
            {"id": "d1", "filename": "../report.pdf"},
            {"id": "d2", "filename": "b.zip"}
        ]);
        assert_eq!(download_filename(&list, "d1").as_deref(), Some("report.pdf"));
        assert_eq!(
            download_filename(&serde_json::json!({"downloads": list}), "d2").as_deref(),
            Some("b.zip")
        );
        assert_eq!(download_filename(&list, "zz"), None);
        assert_eq!(
            download_save_payload("s", "d1", Path::new("/x/a.pdf")),
            serde_json::json!({"sessionId": "s", "downloadId": "d1", "targetPath": "/x/a.pdf"})
        );
    }

    #[test]
    fn pending_downloads_reserve_names_and_pop_in_order() {
        let state = BrowserDownloadsState::default();
        let first = PathBuf::from("/d/a.pdf");
        state.push_pending(
            "https://x/a.pdf",
            PendingDownload {
                id: "1".into(),
                destination: first.clone(),
                filename: "a.pdf".into(),
            },
        );
        state.push_pending(
            "https://x/a.pdf",
            PendingDownload {
                id: "2".into(),
                destination: PathBuf::from("/d/a (1).pdf"),
                filename: "a (1).pdf".into(),
            },
        );
        assert!(state.reserved(&first));
        assert!(!state.reserved(Path::new("/d/b.pdf")));
        assert_eq!(state.pop_pending("https://x/a.pdf").unwrap().id, "1");
        assert_eq!(state.pop_pending("https://x/a.pdf").unwrap().id, "2");
        assert!(state.pop_pending("https://x/a.pdf").is_none());
        assert!(!state.reserved(&first));
    }

    #[test]
    fn reported_paths_are_matched_canonically() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        let state = BrowserDownloadsState::default();
        assert!(!state.was_reported(&file));
        state.remember(&file);
        assert!(state.was_reported(&tmp.path().join(".").join("f.txt")));
        assert!(!state.was_reported(&tmp.path().join("missing")));
    }

    #[test]
    fn download_paths_must_have_been_reported() {
        let downloads = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let inside = downloads.path().join("in.pdf");
        let outside = elsewhere.path().join("out.pdf");
        std::fs::write(&inside, b"x").unwrap();
        std::fs::write(&outside, b"y").unwrap();
        let state = BrowserDownloadsState::default();
        let check = |raw: &Path| authorize_download_path_in(&state, raw.to_str().unwrap());

        // Being inside the Downloads directory is not enough.
        assert_eq!(check(&inside).unwrap_err(), "download_path_not_allowed");
        assert_eq!(check(&outside).unwrap_err(), "download_path_not_allowed");
        assert_eq!(
            authorize_download_path_in(&state, "relative.pdf").unwrap_err(),
            "download_not_found"
        );
        assert_eq!(
            check(&downloads.path().join("missing.pdf")).unwrap_err(),
            "download_not_found"
        );
        assert_eq!(
            check(downloads.path()).unwrap_err(),
            "download_path_not_allowed"
        );

        state.remember(&inside);
        assert_eq!(
            check(&inside).unwrap(),
            std::fs::canonicalize(&inside).unwrap()
        );
        // Traversal resolves to the same reported file.
        let traversal = downloads.path().join(".").join("in.pdf");
        assert!(check(&traversal).is_ok());
        assert_eq!(check(&outside).unwrap_err(), "download_path_not_allowed");

        #[cfg(unix)]
        {
            let secret = elsewhere.path().join("secret.txt");
            std::fs::write(&secret, b"s").unwrap();
            let link = downloads.path().join("link.txt");
            std::os::unix::fs::symlink(&secret, &link).unwrap();
            assert_eq!(check(&link).unwrap_err(), "download_path_not_allowed");
            // A reported file swapped for a link to a secret is refused.
            std::fs::remove_file(&inside).unwrap();
            std::os::unix::fs::symlink(&secret, &inside).unwrap();
            assert_eq!(check(&inside).unwrap_err(), "download_path_not_allowed");
        }
    }

    #[test]
    fn reads_are_limited_to_files_up_to_64_mb() {
        let tmp = tempfile::tempdir().unwrap();
        let small = tmp.path().join("small.bin");
        std::fs::write(&small, b"abc").unwrap();
        assert_eq!(check_readable(&std::fs::metadata(&small).unwrap()), Ok(()));

        let exact = tmp.path().join("exact.bin");
        std::fs::File::create(&exact)
            .unwrap()
            .set_len(MAX_DOWNLOAD_READ_BYTES)
            .unwrap();
        assert_eq!(check_readable(&std::fs::metadata(&exact).unwrap()), Ok(()));

        let big = tmp.path().join("big.bin");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_DOWNLOAD_READ_BYTES + 1)
            .unwrap();
        assert_eq!(
            check_readable(&std::fs::metadata(&big).unwrap()),
            Err("download_too_large".to_string())
        );
        assert_eq!(
            check_readable(&std::fs::metadata(tmp.path()).unwrap()),
            Err("download_not_found".to_string())
        );
    }

    #[test]
    fn move_file_moves_and_reports_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("a");
        let to = tmp.path().join("b");
        std::fs::write(&from, b"data").unwrap();
        move_file(&from, &to).unwrap();
        assert!(!from.exists());
        assert_eq!(std::fs::read(&to).unwrap(), b"data");
        assert!(move_file(&tmp.path().join("missing"), &to).is_err());
    }

    #[test]
    fn event_payload_serializes_camel_case_and_skips_absent_fields() {
        let value = serde_json::to_value(DownloadEventPayload {
            phase: "requested",
            id: "i".into(),
            url: "u".into(),
            filename: "f".into(),
            saved_path: None,
            success: None,
            error: None,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"phase":"requested","id":"i","url":"u","filename":"f"})
        );
        let value = serde_json::to_value(DownloadEventPayload {
            phase: "finished",
            id: "i".into(),
            url: "u".into(),
            filename: "f".into(),
            saved_path: Some("/p".into()),
            success: Some(true),
            error: None,
        })
        .unwrap();
        assert_eq!(value["savedPath"], "/p");
        assert_eq!(value["success"], true);
    }
}
