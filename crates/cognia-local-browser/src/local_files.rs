//! Local files for the desktop browser (ADR-0201).
//!
//! Two concerns share this module because both are "a path on this machine the
//! browser touches":
//!
//! - [`LocalFiles`]: loopback static file servers bound to `127.0.0.1:0`. Each
//!   served root gets **its own listener**, so two roots are two origins and a
//!   page from one cannot read the other. A root is served under a random
//!   128-bit hex path prefix so relative assets resolve and the page gets the
//!   trusted `localhost` tier instead of `file://`.
//! - Download naming: [`sanitize_filename`], [`filename_from_url`] and
//!   [`unique_destination`] (collision-safe `name (1).ext`), plus
//!   [`path_is_within`] for the "may this path be opened / revealed" check.
//!
//! What a served path exposes:
//!
//! - A directory the user chose is served as a tree (not the home directory
//!   itself and not a filesystem root).
//! - A file is served with its parent directory (so its relative assets load)
//!   **only** when that parent is not the home directory, a direct child of
//!   home (`~/Downloads`, `~/Documents`, …) or a filesystem root. Otherwise
//!   only that one file is reachable.
//!
//! Hardening of the server: only `GET`/`HEAD`; the `Host` header must name the
//! loopback address the server is bound to (DNS-rebinding defence); every path
//! segment is percent-decoded then rejected if it is empty-after-decoding
//! `.`/`..`, holds a separator or NUL, or is hidden (`.git`, `.env`, `.ssh`);
//! the resolved path is canonicalized, must still sit under the root, and is
//! checked again for hidden components after symlinks are resolved, so a
//! symlink can neither escape the root nor reach a hidden file inside it.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// Characters escaped in one URL path segment (RFC 3986 `pchar` complement).
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

const CHUNK: usize = 64 * 1024;
const PREFIX_HEX_LEN: usize = 32;
const INDEX_FILES: [&str; 2] = ["index.html", "index.htm"];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LocalFilesError {
    #[error("local_file_not_found: {0}")]
    NotFound(String),
    #[error("local_file_root_not_allowed: a filesystem root or the home directory cannot be served")]
    RootNotAllowed,
    #[error("local_file_not_served: {0}")]
    NotServed(String),
    #[error("local_file_server_failed: {0}")]
    Server(String),
}

/// What `browser_local_file_serve` returns: the URL to open and the served
/// root (the key `browser_local_file_stop` takes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServedPath {
    pub url: String,
    pub root: String,
}

/// What one listener exposes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ServedRoot {
    /// A directory tree (canonical).
    Dir(PathBuf),
    /// Exactly one file (canonical path), under its own name.
    File { path: PathBuf, name: String },
}

impl ServedRoot {
    /// The key [`LocalFiles::stop`] takes (and [`ServedPath::root`] reports).
    fn key(&self) -> &Path {
        match self {
            Self::Dir(dir) => dir,
            Self::File { path, .. } => path,
        }
    }
}

/// Decide what serving `target` (canonical) exposes. `home` is the user's
/// home directory, canonical or not.
pub(crate) fn plan_root(
    target: &Path,
    is_dir: bool,
    home: Option<&Path>,
) -> Result<(ServedRoot, Option<String>), LocalFilesError> {
    let homes: Vec<PathBuf> = home
        .into_iter()
        .flat_map(|home| {
            let canonical = std::fs::canonicalize(home).ok();
            std::iter::once(home.to_path_buf()).chain(canonical)
        })
        .collect();
    let is_home = |dir: &Path| homes.iter().any(|home| home.as_path() == dir);
    let is_home_child = |dir: &Path| dir.parent().is_some_and(is_home);
    if is_dir {
        if is_filesystem_root(target) || is_home(target) {
            return Err(LocalFilesError::RootNotAllowed);
        }
        return Ok((ServedRoot::Dir(target.to_path_buf()), None));
    }
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or(LocalFilesError::RootNotAllowed)?;
    if name.starts_with('.') {
        return Err(LocalFilesError::NotFound(target.display().to_string()));
    }
    let parent = target.parent().ok_or(LocalFilesError::RootNotAllowed)?;
    if is_filesystem_root(parent) || is_home(parent) || is_home_child(parent) {
        return Ok((
            ServedRoot::File {
                path: target.to_path_buf(),
                name: name.clone(),
            },
            Some(name),
        ));
    }
    Ok((ServedRoot::Dir(parent.to_path_buf()), Some(name)))
}

struct Shared {
    port: u16,
    prefix: String,
    root: ServedRoot,
}

struct Running {
    shared: Arc<Shared>,
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl Running {
    async fn stop(self) {
        let _ = self.shutdown.send(());
        let _ = self.task.await;
    }
}

/// The loopback static servers, one listener (origin) per served root.
#[derive(Default)]
pub struct LocalFiles {
    running: tokio::sync::Mutex<HashMap<PathBuf, Running>>,
}

impl LocalFiles {
    pub fn new() -> Self {
        Self::default()
    }

    /// Serve `path` (see the module docs for what that exposes). Serving the
    /// same root twice reuses its listener.
    pub async fn serve(&self, path: &Path) -> Result<ServedPath, LocalFilesError> {
        self.serve_with_home(path, dirs::home_dir().as_deref()).await
    }

    /// [`LocalFiles::serve`] with an explicit home directory.
    pub async fn serve_with_home(
        &self,
        path: &Path,
        home: Option<&Path>,
    ) -> Result<ServedPath, LocalFilesError> {
        let target = tokio::fs::canonicalize(path)
            .await
            .map_err(|_| LocalFilesError::NotFound(path.display().to_string()))?;
        let metadata = tokio::fs::metadata(&target)
            .await
            .map_err(|_| LocalFilesError::NotFound(path.display().to_string()))?;
        let (root, file_name) = plan_root(&target, metadata.is_dir(), home)?;

        let mut running = self.running.lock().await;
        let key = root.key().to_path_buf();
        if !running.contains_key(&key) {
            let started = start_server(root.clone()).await?;
            running.insert(key.clone(), started);
        }
        let shared = Arc::clone(&running.get(&key).expect("server just started").shared);
        drop(running);

        let mut url = format!("http://127.0.0.1:{}/{}/", shared.port, shared.prefix);
        if let Some(name) = file_name {
            url.push_str(&utf8_percent_encode(&name, SEGMENT).to_string());
        }
        Ok(ServedPath {
            url,
            root: key.to_string_lossy().into_owned(),
        })
    }

    /// Stop serving `root` (the value [`ServedPath::root`] reported) and close
    /// its listener.
    pub async fn stop(&self, root: &str) -> Result<(), LocalFilesError> {
        let mut running = self.running.lock().await;
        let wanted = tokio::fs::canonicalize(root)
            .await
            .unwrap_or_else(|_| PathBuf::from(root));
        let stopped = running
            .remove(&wanted)
            .or_else(|| running.remove(Path::new(root)));
        drop(running);
        match stopped {
            Some(server) => {
                server.stop().await;
                Ok(())
            }
            None => Err(LocalFilesError::NotServed(root.to_string())),
        }
    }

    /// The bound ports of every running listener (so dev-server discovery can
    /// skip them).
    pub async fn ports(&self) -> Vec<u16> {
        let mut ports: Vec<u16> = self
            .running
            .lock()
            .await
            .values()
            .map(|running| running.shared.port)
            .collect();
        ports.sort_unstable();
        ports
    }

    /// Stop everything (app exit).
    pub async fn shutdown(&self) {
        let servers: Vec<Running> = self.running.lock().await.drain().map(|(_, r)| r).collect();
        for server in servers {
            server.stop().await;
        }
    }
}

fn random_prefix() -> String {
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes);
    hex::encode(bytes)
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
        || path
            .components()
            .all(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
}

/// Whether any component of `relative` is hidden (starts with `.`).
pub(crate) fn has_hidden_component(relative: &Path) -> bool {
    relative
        .components()
        .any(|component| match component {
            Component::Normal(name) => name.to_string_lossy().starts_with('.'),
            _ => false,
        })
}

async fn start_server(root: ServedRoot) -> Result<Running, LocalFilesError> {
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(|error| LocalFilesError::Server(error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| LocalFilesError::Server(error.to_string()))?
        .port();
    let shared = Arc::new(Shared {
        port,
        prefix: random_prefix(),
        root,
    });
    let router = axum::Router::new()
        .fallback(handle)
        .with_state(Arc::clone(&shared));
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = server.await {
            tracing::warn!("local file server stopped: {error}");
        }
    });
    Ok(Running {
        shared,
        shutdown,
        task,
    })
}

/// `Host` must name the loopback address and port the server is bound to.
pub(crate) fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else { return false };
    let host = host.trim().to_ascii_lowercase();
    [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ]
    .contains(&host)
}

/// Split a request path into its prefix and decoded, validated segments.
/// `None` means "not found" (unknown shape, traversal, hidden, separators).
pub(crate) fn parse_request_path(path: &str) -> Option<(String, Vec<String>, bool)> {
    let trailing_slash = path.ends_with('/');
    let mut parts = path.trim_start_matches('/').split('/');
    let prefix = parts.next()?.to_string();
    if prefix.len() != PREFIX_HEX_LEN || !prefix.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut segments = Vec::new();
    for raw in parts {
        if raw.is_empty() {
            continue;
        }
        let decoded = percent_decode_str(raw).decode_utf8().ok()?.into_owned();
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded.starts_with('.')
            || decoded.contains(['/', '\\', '\0'])
            || (cfg!(windows) && decoded.contains(':'))
        {
            return None;
        }
        segments.push(decoded);
    }
    Some((prefix, segments, trailing_slash))
}

/// A single byte range from a `Range` header, resolved against `len`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RangeRequest {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

pub(crate) fn parse_range(header: Option<&str>, len: u64) -> RangeRequest {
    let Some(value) = header else {
        return RangeRequest::Full;
    };
    let Some(spec) = value.trim().strip_prefix("bytes=") else {
        return RangeRequest::Full;
    };
    // Multi-range requests are answered with the whole body (allowed by RFC 9110).
    if spec.contains(',') {
        return RangeRequest::Full;
    }
    let Some((start, end)) = spec.split_once('-') else {
        return RangeRequest::Full;
    };
    let (start, end) = (start.trim(), end.trim());
    if len == 0 {
        return RangeRequest::Unsatisfiable;
    }
    if start.is_empty() {
        let Ok(suffix) = end.parse::<u64>() else {
            return RangeRequest::Full;
        };
        if suffix == 0 {
            return RangeRequest::Unsatisfiable;
        }
        let start = len.saturating_sub(suffix);
        return RangeRequest::Partial {
            start,
            end: len - 1,
        };
    }
    let Ok(start) = start.parse::<u64>() else {
        return RangeRequest::Full;
    };
    if start >= len {
        return RangeRequest::Unsatisfiable;
    }
    let end = if end.is_empty() {
        len - 1
    } else {
        match end.parse::<u64>() {
            Ok(end) if end >= start => end.min(len - 1),
            _ => return RangeRequest::Full,
        }
    };
    RangeRequest::Partial { start, end }
}

pub(crate) fn content_type_for(path: &Path) -> String {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let essence = mime.essence_str().to_string();
    let textual = mime.type_() == mime_guess::mime::TEXT
        || matches!(
            essence.as_str(),
            "application/javascript" | "application/json" | "image/svg+xml" | "application/xml"
        );
    if textual {
        format!("{essence}; charset=utf-8")
    } else {
        essence
    }
}

fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// One entry of a directory listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ListingEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// A plain directory listing: directories first, then files, each sorted
/// case-insensitively; hidden entries are never listed.
pub(crate) fn render_listing(display_path: &str, mut entries: Vec<ListingEntry>) -> String {
    entries.retain(|entry| !entry.name.starts_with('.'));
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let title = html_escape(display_path);
    let mut html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title>\
<meta name=\"viewport\" content=\"width=device-width\">\
<style>body{{font:14px system-ui,sans-serif;margin:24px}}li{{margin:2px 0}}\
span{{color:#888;margin-left:8px}}</style></head><body><h1>{title}</h1><ul>"
    );
    if display_path != "/" {
        html.push_str("<li><a href=\"../\">../</a></li>");
    }
    for entry in entries {
        let href = utf8_percent_encode(&entry.name, SEGMENT).to_string();
        let name = html_escape(&entry.name);
        if entry.is_dir {
            html.push_str(&format!("<li><a href=\"{href}/\">{name}/</a></li>"));
        } else {
            html.push_str(&format!(
                "<li><a href=\"{href}\">{name}</a><span>{}</span></li>",
                entry.size
            ));
        }
    }
    html.push_str("</ul></body></html>");
    html
}

fn status(code: StatusCode) -> Response<Body> {
    let mut response = Response::new(Body::from(
        code.canonical_reason().unwrap_or("error").to_string(),
    ));
    *response.status_mut() = code;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    harden(response.headers_mut());
    response
}

fn harden(headers: &mut HeaderMap) {
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
}

async fn handle(State(shared): State<Arc<Shared>>, request: Request<Body>) -> Response<Body> {
    let method = request.method().clone();
    if method != Method::GET && method != Method::HEAD {
        let mut response = status(StatusCode::METHOD_NOT_ALLOWED);
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if !host_allowed(host, shared.port) {
        return status(StatusCode::FORBIDDEN);
    }
    let path = request.uri().path().to_string();
    let Some((prefix, segments, trailing_slash)) = parse_request_path(&path) else {
        return status(StatusCode::NOT_FOUND);
    };
    if prefix != shared.prefix {
        return status(StatusCode::NOT_FOUND);
    }
    let resolved = match &shared.root {
        // A single served file answers only at `/<prefix>/<its name>`.
        ServedRoot::File { path: file, name } => {
            if segments.len() != 1 || &segments[0] != name || trailing_slash {
                return status(StatusCode::NOT_FOUND);
            }
            let Some(parent) = file.parent() else {
                return status(StatusCode::NOT_FOUND);
            };
            let Ok(resolved) = tokio::fs::canonicalize(parent.join(name)).await else {
                return status(StatusCode::NOT_FOUND);
            };
            // The name must still be the very file that was chosen (not a
            // symlink swapped in since).
            if &resolved != file {
                return status(StatusCode::NOT_FOUND);
            }
            resolved
        }
        ServedRoot::Dir(root) => {
            let mut candidate = root.clone();
            for segment in &segments {
                candidate.push(segment);
            }
            let Ok(resolved) = tokio::fs::canonicalize(&candidate).await else {
                return status(StatusCode::NOT_FOUND);
            };
            // Symlinks are resolved: the target must stay under the root and
            // must not be (or sit under) a hidden entry.
            let Ok(relative) = resolved.strip_prefix(root) else {
                return status(StatusCode::NOT_FOUND);
            };
            if has_hidden_component(relative) {
                return status(StatusCode::NOT_FOUND);
            }
            resolved
        }
    };
    let Ok(metadata) = tokio::fs::metadata(&resolved).await else {
        return status(StatusCode::NOT_FOUND);
    };
    let head = method == Method::HEAD;
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    if metadata.is_dir() {
        if !trailing_slash {
            let mut response = status(StatusCode::MOVED_PERMANENTLY);
            if let Ok(location) = HeaderValue::from_str(&format!("{path}/")) {
                response.headers_mut().insert(header::LOCATION, location);
            }
            return response;
        }
        for index in INDEX_FILES {
            let index_path = resolved.join(index);
            if let Ok(index_meta) = tokio::fs::metadata(&index_path).await {
                if index_meta.is_file() {
                    return serve_file(&index_path, index_meta.len(), range.as_deref(), head).await;
                }
            }
        }
        let mut entries = Vec::new();
        if let Ok(mut dir) = tokio::fs::read_dir(&resolved).await {
            while let Ok(Some(entry)) = dir.next_entry().await {
                let Ok(meta) = entry.metadata().await else {
                    continue;
                };
                entries.push(ListingEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    is_dir: meta.is_dir(),
                    size: meta.len(),
                });
            }
        }
        let display = if segments.is_empty() {
            "/".to_string()
        } else {
            format!("/{}/", segments.join("/"))
        };
        let html = render_listing(&display, entries);
        let length = html.len();
        let mut response = Response::new(if head {
            Body::empty()
        } else {
            Body::from(html)
        });
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        response
            .headers_mut()
            .insert(header::CONTENT_LENGTH, HeaderValue::from(length));
        harden(response.headers_mut());
        return response;
    }
    serve_file(&resolved, metadata.len(), range.as_deref(), head).await
}

async fn serve_file(path: &Path, len: u64, range: Option<&str>, head: bool) -> Response<Body> {
    let (code, start, end) = match parse_range(range, len) {
        RangeRequest::Full => (StatusCode::OK, 0, len.saturating_sub(1)),
        RangeRequest::Partial { start, end } => (StatusCode::PARTIAL_CONTENT, start, end),
        RangeRequest::Unsatisfiable => {
            let mut response = status(StatusCode::RANGE_NOT_SATISFIABLE);
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{len}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            return response;
        }
    };
    let body_len = if len == 0 { 0 } else { end - start + 1 };
    let body = if head || body_len == 0 {
        Body::empty()
    } else {
        let Ok(mut file) = tokio::fs::File::open(path).await else {
            return status(StatusCode::NOT_FOUND);
        };
        if start > 0 && file.seek(SeekFrom::Start(start)).await.is_err() {
            return status(StatusCode::INTERNAL_SERVER_ERROR);
        }
        let stream =
            futures_util::stream::unfold((file, body_len), |(mut file, remaining)| async move {
                if remaining == 0 {
                    return None;
                }
                let want = usize::try_from(remaining.min(CHUNK as u64)).unwrap_or(CHUNK);
                let mut buf = vec![0u8; want];
                match file.read(&mut buf).await {
                    Ok(0) => None,
                    Ok(read) => {
                        buf.truncate(read);
                        Some((
                            Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(buf)),
                            (file, remaining - read as u64),
                        ))
                    }
                    Err(error) => Some((Err(error), (file, 0))),
                }
            });
        Body::from_stream(stream)
    };
    let mut response = Response::new(body);
    *response.status_mut() = code;
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&content_type_for(path)) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(body_len));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if code == StatusCode::PARTIAL_CONTENT {
        if let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{end}/{len}")) {
            headers.insert(header::CONTENT_RANGE, value);
        }
    }
    harden(headers);
    response
}

// ---------------------------------------------------------------------------
// Download naming (shared by the embedded webview's download handler).
// ---------------------------------------------------------------------------

const MAX_FILENAME_BYTES: usize = 200;
const COMPOUND_EXTENSIONS: [&str; 4] = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"];
const WINDOWS_RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Split a file name into (stem, extension-with-dot), recognising compound
/// archive extensions so `a.tar.gz` collides as `a (1).tar.gz`.
fn split_extension(name: &str) -> (&str, &str) {
    let lower = name.to_ascii_lowercase();
    for compound in COMPOUND_EXTENSIONS {
        if lower.ends_with(compound) && name.len() > compound.len() {
            let at = name.len() - compound.len();
            return (&name[..at], &name[at..]);
        }
    }
    match name.rfind('.') {
        Some(0) | None => (name, ""),
        Some(at) => (&name[..at], &name[at..]),
    }
}

fn truncate_on_char_boundary(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// A safe single-component file name on every desktop OS: the last path
/// component only, control and reserved characters replaced, leading dots and
/// trailing dots/spaces trimmed, Windows device names prefixed, length capped
/// (extension preserved). Empty input becomes `download`.
pub fn sanitize_filename(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut cleaned: String = last
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect();
    cleaned = cleaned
        .trim_start_matches(['.', ' '])
        .trim_end_matches(['.', ' '])
        .to_string();
    if cleaned.is_empty() {
        return "download".to_string();
    }
    let reserved = {
        let (stem, _) = split_extension(&cleaned);
        WINDOWS_RESERVED.contains(&stem.to_ascii_lowercase().as_str())
    };
    if reserved {
        cleaned = format!("_{cleaned}");
    }
    if cleaned.len() > MAX_FILENAME_BYTES {
        let (stem, ext) = split_extension(&cleaned);
        let ext = if ext.len() < 32 { ext } else { "" };
        let stem = truncate_on_char_boundary(stem, MAX_FILENAME_BYTES - ext.len());
        cleaned = format!("{stem}{ext}");
    }
    cleaned
}

/// The file name a URL would save as: its last non-empty path segment,
/// percent-decoded and sanitized; `download` when there is none (`data:`,
/// `blob:`, a bare origin).
pub fn filename_from_url(url: &str) -> String {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("data:") || lower.starts_with("blob:") {
        return "download".to_string();
    }
    let without_fragment = url.split('#').next().unwrap_or("");
    let without_query = without_fragment.split('?').next().unwrap_or("");
    let after_scheme = without_query
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(without_query);
    let path = after_scheme
        .split_once('/')
        .map(|(_, path)| path)
        .unwrap_or("");
    let segment = path.rsplit('/').find(|segment| !segment.is_empty());
    match segment {
        Some(segment) => {
            let decoded = percent_decode_str(segment).decode_utf8_lossy();
            sanitize_filename(&decoded)
        }
        None => "download".to_string(),
    }
}

/// `dir/name`, or `dir/stem (n).ext` for the first `n` that does not exist.
pub fn unique_destination(dir: &Path, name: &str) -> PathBuf {
    unique_destination_with(dir, name, |candidate| candidate.exists())
}

/// [`unique_destination`] with a caller-supplied "taken" test, so names
/// reserved by downloads still in flight (not yet on disk) are skipped too.
pub fn unique_destination_with(dir: &Path, name: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let name = sanitize_filename(name);
    let first = dir.join(&name);
    if !taken(&first) {
        return first;
    }
    let (stem, ext) = split_extension(&name);
    for n in 1..10_000u32 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !taken(&candidate) {
            return candidate;
        }
    }
    let mut bytes = [0u8; 4];
    rand::fill(&mut bytes);
    dir.join(format!("{stem} ({}){ext}", hex::encode(bytes)))
}

/// Whether `path` resolves (symlinks followed) to somewhere inside `dir`.
/// A path that does not exist is never "within".
pub fn path_is_within(path: &Path, dir: &Path) -> bool {
    let (Ok(path), Ok(dir)) = (std::fs::canonicalize(path), std::fs::canonicalize(dir)) else {
        return false;
    };
    path.starts_with(&dir) && path != dir
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn host_must_name_the_bound_loopback_port() {
        assert!(host_allowed(Some("127.0.0.1:4100"), 4100));
        assert!(host_allowed(Some("LOCALHOST:4100"), 4100));
        assert!(host_allowed(Some("[::1]:4100"), 4100));
        assert!(!host_allowed(Some("127.0.0.1:4101"), 4100));
        assert!(!host_allowed(Some("evil.example:4100"), 4100));
        assert!(!host_allowed(Some("127.0.0.1"), 4100));
        assert!(!host_allowed(None, 4100));
    }

    #[test]
    fn request_paths_are_decoded_and_traversal_is_refused() {
        let prefix = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_request_path(&format!("/{prefix}/a%20b/c.html")),
            Some((prefix.into(), vec!["a b".into(), "c.html".into()], false))
        );
        assert_eq!(
            parse_request_path(&format!("/{prefix}/")),
            Some((prefix.into(), vec![], true))
        );
        for bad in [
            format!("/{prefix}/../etc/passwd"),
            format!("/{prefix}/%2e%2e/secret"),
            format!("/{prefix}/a%2fb"),
            format!("/{prefix}/a%5cb"),
            format!("/{prefix}/.git/config"),
            format!("/{prefix}/.env"),
            format!("/{prefix}/a%00b"),
            format!("/{prefix}/%ff"),
            "/short/x".to_string(),
            "/zz23456789abcdef0123456789abcdef/x".to_string(),
        ] {
            assert_eq!(parse_request_path(&bad), None, "{bad}");
        }
    }

    #[test]
    fn ranges_resolve_against_the_length() {
        assert_eq!(parse_range(None, 10), RangeRequest::Full);
        assert_eq!(
            parse_range(Some("bytes=0-3"), 10),
            RangeRequest::Partial { start: 0, end: 3 }
        );
        assert_eq!(
            parse_range(Some("bytes=4-"), 10),
            RangeRequest::Partial { start: 4, end: 9 }
        );
        assert_eq!(
            parse_range(Some("bytes=-3"), 10),
            RangeRequest::Partial { start: 7, end: 9 }
        );
        assert_eq!(
            parse_range(Some("bytes=5-100"), 10),
            RangeRequest::Partial { start: 5, end: 9 }
        );
        assert_eq!(
            parse_range(Some("bytes=10-"), 10),
            RangeRequest::Unsatisfiable
        );
        assert_eq!(
            parse_range(Some("bytes=-0"), 10),
            RangeRequest::Unsatisfiable
        );
        assert_eq!(parse_range(Some("bytes=0-1,4-5"), 10), RangeRequest::Full);
        assert_eq!(parse_range(Some("items=0-1"), 10), RangeRequest::Full);
        assert_eq!(parse_range(Some("bytes=5-2"), 10), RangeRequest::Full);
        assert_eq!(
            parse_range(Some("bytes=0-"), 0),
            RangeRequest::Unsatisfiable
        );
    }

    #[test]
    fn content_types_carry_a_charset_for_text() {
        assert_eq!(
            content_type_for(Path::new("a.html")),
            "text/html; charset=utf-8"
        );
        assert!(content_type_for(Path::new("a.js")).ends_with("charset=utf-8"));
        assert_eq!(content_type_for(Path::new("a.png")), "image/png");
        assert_eq!(
            content_type_for(Path::new("a.unknownext")),
            "application/octet-stream"
        );
    }

    #[test]
    fn listing_escapes_names_sorts_dirs_first_and_hides_dotfiles() {
        let html = render_listing(
            "/docs/",
            vec![
                ListingEntry {
                    name: "b.txt".into(),
                    is_dir: false,
                    size: 3,
                },
                ListingEntry {
                    name: ".secret".into(),
                    is_dir: false,
                    size: 1,
                },
                ListingEntry {
                    name: "<x>".into(),
                    is_dir: true,
                    size: 0,
                },
                ListingEntry {
                    name: "A dir".into(),
                    is_dir: true,
                    size: 0,
                },
            ],
        );
        assert!(!html.contains(".secret"));
        assert!(html.contains("&lt;x&gt;/"));
        assert!(html.contains("href=\"A%20dir/\""));
        let a = html.find("A dir").unwrap();
        let x = html.find("&lt;x&gt;").unwrap();
        let b = html.find("b.txt").unwrap();
        assert!(x < a && a < b);
        assert!(html.contains("href=\"../\""));
        assert!(!render_listing("/", vec![]).contains("../"));
    }

    #[test]
    fn filesystem_roots_are_detected() {
        assert!(is_filesystem_root(Path::new("/")));
        assert!(!is_filesystem_root(Path::new("/tmp")));
    }

    #[test]
    fn sanitize_filename_is_safe_everywhere() {
        assert_eq!(sanitize_filename("report.pdf"), "report.pdf");
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(
            sanitize_filename("a<b>:c\"d|e?f*g.txt"),
            "a_b__c_d_e_f_g.txt"
        );
        assert_eq!(sanitize_filename("..hidden"), "hidden");
        assert_eq!(sanitize_filename("trailing. . "), "trailing");
        assert_eq!(sanitize_filename("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_filename("nul"), "_nul");
        assert_eq!(sanitize_filename(""), "download");
        assert_eq!(sanitize_filename("..."), "download");
        assert_eq!(sanitize_filename("a\u{0007}b"), "a_b");
        let long = format!("{}.pdf", "中".repeat(200));
        let out = sanitize_filename(&long);
        assert!(out.len() <= MAX_FILENAME_BYTES);
        assert!(out.ends_with(".pdf"));
    }

    #[test]
    fn filename_from_url_takes_the_last_segment() {
        assert_eq!(
            filename_from_url("https://x.example/files/My%20Report.pdf?dl=1#top"),
            "My Report.pdf"
        );
        assert_eq!(filename_from_url("https://x.example/a/b/"), "b");
        assert_eq!(filename_from_url("https://x.example"), "download");
        assert_eq!(filename_from_url("data:text/plain,hi"), "download");
        assert_eq!(filename_from_url("blob:https://x/123"), "download");
        assert_eq!(
            filename_from_url("https://x.example/%2e%2e%2fpasswd"),
            "passwd"
        );
    }

    #[test]
    fn unique_destination_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let first = unique_destination(dir.path(), "a.pdf");
        assert_eq!(first, dir.path().join("a.pdf"));
        std::fs::write(&first, b"1").unwrap();
        let second = unique_destination(dir.path(), "a.pdf");
        assert_eq!(second, dir.path().join("a (1).pdf"));
        std::fs::write(&second, b"2").unwrap();
        assert_eq!(
            unique_destination(dir.path(), "a.pdf"),
            dir.path().join("a (2).pdf")
        );
        std::fs::write(dir.path().join("x.tar.gz"), b"").unwrap();
        assert_eq!(
            unique_destination(dir.path(), "x.tar.gz"),
            dir.path().join("x (1).tar.gz")
        );
        std::fs::write(dir.path().join("noext"), b"").unwrap();
        assert_eq!(
            unique_destination(dir.path(), "noext"),
            dir.path().join("noext (1)")
        );
    }

    #[test]
    fn unique_destination_with_skips_reserved_names() {
        let dir = tempfile::tempdir().unwrap();
        let reserved = [dir.path().join("a.pdf"), dir.path().join("a (1).pdf")];
        assert_eq!(
            unique_destination_with(dir.path(), "a.pdf", |p| reserved.iter().any(|r| r == p)),
            dir.path().join("a (2).pdf")
        );
    }

    #[test]
    fn path_is_within_follows_symlinks_and_rejects_missing() {
        let dir = tempfile::tempdir().unwrap();
        let inside = dir.path().join("f.txt");
        std::fs::write(&inside, b"x").unwrap();
        assert!(path_is_within(&inside, dir.path()));
        assert!(!path_is_within(dir.path(), dir.path()));
        assert!(!path_is_within(&dir.path().join("missing"), dir.path()));
        let other = tempfile::tempdir().unwrap();
        let outside = other.path().join("o.txt");
        std::fs::write(&outside, b"x").unwrap();
        assert!(!path_is_within(&outside, dir.path()));
        assert!(!path_is_within(
            &dir.path()
                .join("../")
                .join(other.path().file_name().unwrap())
                .join("o.txt"),
            dir.path()
        ));
        #[cfg(unix)]
        {
            let link = dir.path().join("link.txt");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(!path_is_within(&link, dir.path()));
        }
    }

    async fn http_get(port: u16, path: &str, extra: &str) -> (u16, String, Vec<u8>) {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{extra}\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let code = head[9..12].parse().unwrap();
        (code, head, raw[split + 4..].to_vec())
    }

    fn path_of(url: &str) -> String {
        let rest = url.split_once("://").unwrap().1;
        format!("/{}", rest.split_once('/').unwrap().1)
    }

    fn port_of(url: &str) -> u16 {
        let rest = url.split_once("://").unwrap().1;
        let authority = rest.split_once('/').unwrap().0;
        authority.rsplit_once(':').unwrap().1.parse().unwrap()
    }

    #[tokio::test]
    async fn serves_files_listings_ranges_and_refuses_escapes() {
        let home = tempfile::tempdir().unwrap();
        let site = tempfile::tempdir().unwrap();
        std::fs::write(site.path().join("page.html"), b"<h1>hi</h1>").unwrap();
        std::fs::write(site.path().join("data.bin"), b"0123456789").unwrap();
        std::fs::write(site.path().join(".env"), b"SECRET=1").unwrap();
        std::fs::create_dir(site.path().join("sub")).unwrap();
        std::fs::write(site.path().join("sub").join("x.txt"), b"x").unwrap();
        std::fs::create_dir(site.path().join(".git")).unwrap();
        std::fs::write(site.path().join(".git").join("config"), b"[core]").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("o.txt"), b"outside").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path().join("o.txt"), site.path().join("escape.txt"))
                .unwrap();
            // A visible name that resolves to a hidden entry inside the root.
            std::os::unix::fs::symlink(site.path().join(".env"), site.path().join("env.txt"))
                .unwrap();
            std::os::unix::fs::symlink(site.path().join(".git"), site.path().join("repo"))
                .unwrap();
        }

        let files = LocalFiles::new();
        let served = files
            .serve_with_home(&site.path().join("page.html"), Some(home.path()))
            .await
            .unwrap();
        let port = port_of(&served.url);
        assert_eq!(files.ports().await, vec![port]);
        assert!(served.url.starts_with(&format!("http://127.0.0.1:{port}/")));
        assert!(served.url.ends_with("/page.html"));
        assert_eq!(
            PathBuf::from(&served.root),
            std::fs::canonicalize(site.path()).unwrap()
        );

        let page = path_of(&served.url);
        let (code, head, body) = http_get(port, &page, "").await;
        assert_eq!(code, 200);
        assert!(head
            .to_lowercase()
            .contains("content-type: text/html; charset=utf-8"));
        assert!(head
            .to_lowercase()
            .contains("x-content-type-options: nosniff"));
        assert_eq!(body, b"<h1>hi</h1>");

        let base = page.trim_end_matches("page.html").to_string();
        let (code, _, body) = http_get(port, &base, "").await;
        assert_eq!(code, 200);
        let listing = String::from_utf8(body).unwrap();
        assert!(listing.contains("page.html") && listing.contains("sub/"));
        assert!(!listing.contains(".env"));

        let (code, head, _) = http_get(port, base.trim_end_matches('/'), "").await;
        assert_eq!(code, 301);
        assert!(head.contains(base.as_str()));

        let (code, head, body) =
            http_get(port, &format!("{base}data.bin"), "Range: bytes=2-4\r\n").await;
        assert_eq!(code, 206);
        assert!(head.to_lowercase().contains("content-range: bytes 2-4/10"));
        assert_eq!(body, b"234");

        for bad in [
            format!("{base}.env"),
            format!("{base}..%2f..%2fetc%2fpasswd"),
            format!("{base}missing.txt"),
            "/00000000000000000000000000000000/page.html".to_string(),
        ] {
            assert_eq!(http_get(port, &bad, "").await.0, 404, "{bad}");
        }
        #[cfg(unix)]
        for bad in ["escape.txt", "env.txt", "repo/config", "repo/"] {
            assert_eq!(
                http_get(port, &format!("{base}{bad}"), "").await.0,
                404,
                "{bad}"
            );
        }

        // DNS rebinding: a foreign Host is refused.
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream
            .write_all(
                format!(
                    "GET {page} HTTP/1.1\r\nHost: evil.example:{port}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        assert!(String::from_utf8_lossy(&raw).starts_with("HTTP/1.1 403"));

        // Serving the directory again reuses its listener and prefix.
        let again = files
            .serve_with_home(site.path(), Some(home.path()))
            .await
            .unwrap();
        assert_eq!(path_of(&again.url), base);
        assert_eq!(port_of(&again.url), port);

        // A second root gets its own listener (its own origin); stopping one
        // keeps the other.
        let other = files
            .serve_with_home(outside.path(), Some(home.path()))
            .await
            .unwrap();
        let other_port = port_of(&other.url);
        assert_ne!(other_port, port);
        // The other root's prefix is unknown to the first listener.
        assert_eq!(
            http_get(port, &format!("{}o.txt", path_of(&other.url)), "")
                .await
                .0,
            404
        );
        files.stop(&served.root).await.unwrap();
        assert_eq!(files.ports().await, vec![other_port]);
        assert_eq!(
            http_get(other_port, &format!("{}o.txt", path_of(&other.url)), "")
                .await
                .0,
            200
        );
        assert!(matches!(
            files.stop(&served.root).await,
            Err(LocalFilesError::NotServed(_))
        ));

        files.stop(&other.root).await.unwrap();
        assert!(files.ports().await.is_empty());
    }

    #[tokio::test]
    async fn a_file_in_home_or_a_home_child_is_served_alone() {
        let home = tempfile::tempdir().unwrap();
        let downloads = home.path().join("Downloads");
        std::fs::create_dir_all(downloads.join("nested")).unwrap();
        std::fs::write(home.path().join("notes.html"), b"home file").unwrap();
        std::fs::write(home.path().join("secret.txt"), b"secret").unwrap();
        std::fs::write(downloads.join("report.html"), b"report").unwrap();
        std::fs::write(downloads.join("other.pdf"), b"other").unwrap();
        std::fs::write(downloads.join("nested").join("page.html"), b"nested").unwrap();
        std::fs::write(downloads.join("nested").join("style.css"), b"css").unwrap();

        let files = LocalFiles::new();
        for (file, sibling) in [
            (home.path().join("notes.html"), "secret.txt"),
            (downloads.join("report.html"), "other.pdf"),
        ] {
            let served = files.serve_with_home(&file, Some(home.path())).await.unwrap();
            let canonical = std::fs::canonicalize(&file).unwrap();
            assert_eq!(PathBuf::from(&served.root), canonical, "the root is the file");
            let port = port_of(&served.url);
            let page = path_of(&served.url);
            assert_eq!(http_get(port, &page, "").await.0, 200);
            let base = page.rsplit_once('/').unwrap().0.to_string() + "/";
            assert_eq!(http_get(port, &format!("{base}{sibling}"), "").await.0, 404);
            assert_eq!(http_get(port, &base, "").await.0, 404, "no listing");
            assert_eq!(http_get(port, &format!("{page}/"), "").await.0, 404);
        }

        // Deeper than a direct child of home: the parent directory is served.
        let nested = files
            .serve_with_home(&downloads.join("nested").join("page.html"), Some(home.path()))
            .await
            .unwrap();
        assert_eq!(
            PathBuf::from(&nested.root),
            std::fs::canonicalize(downloads.join("nested")).unwrap()
        );
        let base = path_of(&nested.url).trim_end_matches("page.html").to_string();
        assert_eq!(
            http_get(port_of(&nested.url), &format!("{base}style.css"), "")
                .await
                .0,
            200
        );

        // The home directory itself is never served; a direct child may be.
        assert_eq!(
            files.serve_with_home(home.path(), Some(home.path())).await,
            Err(LocalFilesError::RootNotAllowed)
        );
        assert!(files
            .serve_with_home(&downloads, Some(home.path()))
            .await
            .is_ok());
        files.shutdown().await;
        assert!(files.ports().await.is_empty());
    }

    #[test]
    fn root_planning_follows_the_home_rules() {
        let home = Path::new("/home/ada");
        assert_eq!(
            plan_root(Path::new("/home/ada/a.html"), false, Some(home)).unwrap(),
            (
                ServedRoot::File {
                    path: PathBuf::from("/home/ada/a.html"),
                    name: "a.html".into()
                },
                Some("a.html".into())
            )
        );
        assert!(matches!(
            plan_root(Path::new("/home/ada/Documents/a.html"), false, Some(home))
                .unwrap()
                .0,
            ServedRoot::File { .. }
        ));
        assert_eq!(
            plan_root(Path::new("/home/ada/Documents/site/a.html"), false, Some(home))
                .unwrap()
                .0,
            ServedRoot::Dir(PathBuf::from("/home/ada/Documents/site"))
        );
        assert!(matches!(
            plan_root(Path::new("/a.html"), false, Some(home)).unwrap().0,
            ServedRoot::File { .. }
        ));
        assert_eq!(
            plan_root(Path::new("/home/ada"), true, Some(home)),
            Err(LocalFilesError::RootNotAllowed)
        );
        assert_eq!(
            plan_root(Path::new("/"), true, Some(home)),
            Err(LocalFilesError::RootNotAllowed)
        );
        assert!(matches!(
            plan_root(Path::new("/home/ada/.env"), false, Some(home)),
            Err(LocalFilesError::NotFound(_))
        ));
        assert!(has_hidden_component(Path::new("a/.git/config")));
        assert!(!has_hidden_component(Path::new("a/b.txt")));
    }

    #[tokio::test]
    async fn refuses_missing_paths_and_filesystem_roots() {
        let files = LocalFiles::new();
        assert!(matches!(
            files.serve(Path::new("/definitely/not/here")).await,
            Err(LocalFilesError::NotFound(_))
        ));
        assert_eq!(
            files.serve(Path::new("/")).await,
            Err(LocalFilesError::RootNotAllowed)
        );
        assert!(files.ports().await.is_empty());
    }
}
