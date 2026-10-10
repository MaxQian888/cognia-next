//! The built-in WebDAV listener (ADR-0222 §7.3).
//!
//! `dav-server` speaks the protocol; [`GatewayFs`] is its filesystem, and
//! every call it makes goes through [`gateway::authorize`]. A request
//! authenticates with HTTP Basic against a WebDAV credential (only failures
//! are charged to the backoff), and the credential's view is its grant.
//!
//! - Read-only grants are served with the read-only method set, so clients
//!   mount them read-only instead of failing on save.
//! - Locks come from an in-memory lock system per grant, so one grant's
//!   locks never block another's.
//! - File responses carry `Content-Disposition: attachment`, `nosniff` and a
//!   sandbox CSP: a shared HTML file opened in a browser downloads instead of
//!   running on this origin.
//! - Revoking a grant bumps its epoch: open files stop mid-transfer, and an
//!   upload still being received is cut off.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body as AxumBody;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use bytes::{Buf, Bytes};
use dav_server::davpath::DavPath;
use dav_server::fs::{
    DavDirEntry, DavFile, DavMetaData, FsError, FsFuture, FsResult, FsStream, GuardedFileSystem,
    OpenOptions, ReadDirMeta,
};
use dav_server::{DavHandler, DavMethodSet};
use futures_util::{FutureExt, StreamExt};
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use super::TransferMeter;
use crate::assets::MAX_ASSET_SLICE;
use crate::error::{FileShareError, FileShareResult};
use crate::gateway::{self, Caller, Context, Denial, Op, Target};
use crate::listener::{Exposure, ListenerConfig, WebdavRun};
use crate::model::{AssetEntry, Permission, Protocol};
use crate::now_ms;
use crate::service::{AuthFailure, FileShareService};

const REALM: &str = "Basic realm=\"Cognia\", charset=\"UTF-8\"";
const MAX_HANDLERS: usize = 1024;

/// The per-request credential the filesystem sees.
type Creds = Arc<Caller>;

struct DavState {
    service: Arc<FileShareService>,
    behind_tunnel: bool,
    handlers: Mutex<HashMap<(String, bool), DavHandler<Creds>>>,
}

impl DavState {
    fn handler(&self, grant_id: &str, writable: bool) -> DavHandler<Creds> {
        let mut handlers = self.handlers.lock();
        if handlers.len() >= MAX_HANDLERS {
            handlers.clear();
        }
        handlers
            .entry((grant_id.to_string(), writable))
            .or_insert_with(|| {
                DavHandler::builder()
                    .filesystem(Box::new(GatewayFs {
                        service: self.service.clone(),
                    }))
                    .locksystem(dav_server::memls::MemLs::new())
                    .methods(if writable {
                        DavMethodSet::WEBDAV_RW
                    } else {
                        DavMethodSet::WEBDAV_RO
                    })
                    .build_handler()
            })
            .clone()
    }
}

/// Bind and serve WebDAV with `config`; TLS when `tls` is set (LAN).
pub(crate) async fn serve(
    service: Arc<FileShareService>,
    config: &ListenerConfig,
    tls: Option<cognia_companion_connectivity::tls::TlsMaterial>,
) -> FileShareResult<WebdavRun> {
    let addr = config.webdav_bind();
    let listener = std::net::TcpListener::bind(addr)
        .map_err(|error| FileShareError::new("listener_bind_failed", format!("WebDAV cannot listen on {addr}: {error}")))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| FileShareError::new("listener_bind_failed", error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| FileShareError::new("listener_bind_failed", error.to_string()))?
        .port();
    let app = router(service, config.exposure == Exposure::Tunnel);
    let handle = axum_server::Handle::new();
    let serve_handle = handle.clone();
    let make = app.into_make_service_with_connect_info::<SocketAddr>();
    match tls {
        Some(material) => {
            cognia_net::proxy_config::ensure_crypto_provider();
            let rustls = axum_server::tls_rustls::RustlsConfig::from_pem_file(
                &material.cert_pem_path,
                &material.key_pem_path,
            )
            .await
            .map_err(|error| FileShareError::new("listener_tls_failed", error.to_string()))?;
            let server = axum_server::from_tcp_rustls(listener, rustls)
                .map_err(|error| FileShareError::new("listener_tls_failed", error.to_string()))?;
            tokio::spawn(async move {
                if let Err(error) = server.handle(serve_handle).serve(make).await {
                    log::warn!("file-share WebDAV (TLS) stopped: {error}");
                }
            });
        }
        None => {
            let server = axum_server::from_tcp(listener)
                .map_err(|error| FileShareError::new("listener_bind_failed", error.to_string()))?;
            tokio::spawn(async move {
                if let Err(error) = server.handle(serve_handle).serve(make).await {
                    log::warn!("file-share WebDAV stopped: {error}");
                }
            });
        }
    }
    Ok(WebdavRun {
        port,
        tls: config.webdav_tls(),
        handle,
    })
}

/// The WebDAV router (exposed for tests that serve it on their own socket).
pub fn router(service: Arc<FileShareService>, behind_tunnel: bool) -> axum::Router {
    axum::Router::new()
        .fallback(handle)
        .with_state(Arc::new(DavState {
            service,
            behind_tunnel,
            handlers: Mutex::new(HashMap::new()),
        }))
}

fn unauthorized() -> Response {
    let mut response = (StatusCode::UNAUTHORIZED, "authentication required").into_response();
    response
        .headers_mut()
        .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static(REALM));
    response
}

fn basic_credentials(request: &Request) -> Option<(String, String)> {
    let value = request.headers().get(header::AUTHORIZATION)?.to_str().ok()?;
    let encoded = value.strip_prefix("Basic ").or_else(|| value.strip_prefix("basic "))?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let (user, password) = text.split_once(':')?;
    Some((user.to_string(), password.to_string()))
}

async fn handle(
    State(state): State<Arc<DavState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
) -> Response {
    let remote = super::client_address(
        peer,
        state.behind_tunnel,
        request
            .headers()
            .get("cf-connecting-ip")
            .and_then(|value| value.to_str().ok()),
    );
    let Some((username, password)) = basic_credentials(&request) else {
        return unauthorized();
    };
    let caller = match state
        .service
        .authenticate_password(Protocol::Webdav, &username, &password, Some(&remote))
        .await
    {
        Ok(caller) => caller,
        Err(AuthFailure::Locked { retry_after_ms }) => {
            let mut response = (StatusCode::TOO_MANY_REQUESTS, "too many failed sign-ins").into_response();
            let seconds = (retry_after_ms + 999) / 1000;
            if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
            return response;
        }
        Err(AuthFailure::Invalid) => return unauthorized(),
        Err(AuthFailure::Unavailable) => {
            return (StatusCode::SERVICE_UNAVAILABLE, "file sharing is not available").into_response()
        }
    };
    let writable = match state.service.context() {
        Some((store, _)) => match store.grant(&caller.grant_id) {
            Ok(Some(grant)) => grant.allows(Permission::Write),
            _ => return unauthorized(),
        },
        None => return (StatusCode::SERVICE_UNAVAILABLE, "file sharing is not available").into_response(),
    };
    let is_get = request.method() == Method::GET;
    let file_name = request
        .uri()
        .path()
        .rsplit('/')
        .next()
        .map(percent_decode)
        .unwrap_or_default();
    let handler = state.handler(&caller.grant_id, writable);
    let guard = state.service.register_connection(&caller.grant_id);
    let principal = caller.username.clone();
    let (parts, body) = request.into_parts();
    let request = http::Request::from_parts(parts, body);
    let served = tokio::select! {
        response = handler.handle_guarded(request, principal, Arc::new(caller)) => response,
        _ = guard.token.cancelled() => {
            return (StatusCode::FORBIDDEN, "access to this share was withdrawn").into_response();
        }
    };
    drop(guard);
    let mut response = served.map(AxumBody::new);
    let status = response.status();
    if is_get && (status == StatusCode::OK || status == StatusCode::PARTIAL_CONTENT) && !file_name.is_empty() {
        let headers = response.headers_mut();
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("sandbox; default-src 'none'"),
        );
        if let Ok(value) = HeaderValue::from_str(&format!(
            "attachment; filename*=UTF-8''{}",
            percent_encode(&file_name)
        )) {
            headers.insert(header::CONTENT_DISPOSITION, value);
        }
    }
    response
}

fn percent_decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

// ── Filesystem ─────────────────────────────────────────────────────────────

#[derive(Clone)]
struct GatewayFs {
    service: Arc<FileShareService>,
}

fn fs_error(denial: &Denial) -> FsError {
    if denial.is_not_found() || denial.reason == "invalid_path" {
        FsError::NotFound
    } else {
        FsError::Forbidden
    }
}

fn io_error(error: &std::io::Error) -> FsError {
    match error.kind() {
        std::io::ErrorKind::NotFound => FsError::NotFound,
        std::io::ErrorKind::AlreadyExists => FsError::Exists,
        std::io::ErrorKind::PermissionDenied => FsError::Forbidden,
        _ => FsError::GeneralFailure,
    }
}

fn dav_path(path: &DavPath) -> FsResult<String> {
    String::from_utf8(path.as_bytes().to_vec()).map_err(|_| FsError::NotFound)
}

impl GatewayFs {
    fn authorize(&self, caller: &Caller, op: Op, path: &str) -> FsResult<(Target, Arc<crate::store::Store>)> {
        let (store, policy) = self.service.context().ok_or(FsError::Forbidden)?;
        let target = gateway::authorize(
            &Context {
                store: &store,
                policy: &policy,
                now: now_ms(),
            },
            caller,
            op,
            path,
        )
        .map_err(|denial| fs_error(&denial))?;
        Ok((target, store))
    }

    async fn meta_for(&self, caller: &Caller, target: &Target) -> FsResult<Meta> {
        match target {
            Target::Virtual { .. } | Target::AssetDir { .. } => Ok(Meta::dir()),
            Target::Asset { entry, .. } => Ok(Meta::asset(entry)),
            Target::Disk { abs, .. } => {
                let _ = caller;
                let meta = tokio::fs::metadata(abs).await.map_err(|error| io_error(&error))?;
                Ok(Meta::from_fs(&meta))
            }
        }
    }
}

impl GuardedFileSystem<Creds> for GatewayFs {
    fn open<'a>(
        &'a self,
        path: &'a DavPath,
        options: OpenOptions,
        credentials: &'a Creds,
    ) -> FsFuture<'a, Box<dyn DavFile>> {
        async move {
            let vpath = dav_path(path)?;
            let writing = options.write || options.append || options.create || options.create_new || options.truncate;
            let op = if writing { Op::Write } else { Op::Read };
            let (target, store) = self.authorize(credentials, op, &vpath)?;
            let epoch = self.service.live().epoch(&credentials.grant_id);
            match &target {
                Target::Disk { abs, .. } => {
                    let file = if writing {
                        if let Some(parent) = abs.parent() {
                            if !tokio::fs::metadata(parent).await.map(|m| m.is_dir()).unwrap_or(false) {
                                return Err(FsError::NotFound);
                            }
                        }
                        tokio::fs::OpenOptions::new()
                            .read(options.read)
                            .write(true)
                            .append(options.append)
                            .truncate(options.truncate)
                            .create(options.create)
                            .create_new(options.create_new)
                            .open(abs)
                            .await
                    } else {
                        tokio::fs::File::open(abs).await
                    }
                    .map_err(|error| io_error(&error))?;
                    let meta = file.metadata().await.map_err(|error| io_error(&error))?;
                    if meta.is_dir() {
                        return Err(FsError::Forbidden);
                    }
                    Ok(Box::new(DiskFile {
                        file,
                        service: self.service.clone(),
                        grant_id: credentials.grant_id.clone(),
                        epoch,
                        meter: TransferMeter::new(store, (**credentials).clone(), op, target.clone()),
                    }) as Box<dyn DavFile>)
                }
                Target::Asset { session_id, mount_id, entry, .. } => Ok(Box::new(AssetFile {
                    service: self.service.clone(),
                    grant_id: credentials.grant_id.clone(),
                    epoch,
                    session_id: session_id.clone(),
                    mount_id: mount_id.clone(),
                    entry: entry.clone(),
                    pos: 0,
                    meter: TransferMeter::new(store, (**credentials).clone(), op, target.clone()),
                }) as Box<dyn DavFile>),
                Target::Virtual { .. } | Target::AssetDir { .. } => Err(FsError::Forbidden),
            }
        }
        .boxed()
    }

    fn read_dir<'a>(
        &'a self,
        path: &'a DavPath,
        _meta: ReadDirMeta,
        credentials: &'a Creds,
    ) -> FsFuture<'a, FsStream<Box<dyn DavDirEntry>>> {
        async move {
            let vpath = dav_path(path)?;
            let (target, store) = self.authorize(credentials, Op::List, &vpath)?;
            let entries: Vec<Box<dyn DavDirEntry>> = match &target {
                Target::Virtual { path, children } => {
                    let mut out: Vec<Box<dyn DavDirEntry>> = Vec::new();
                    for child in children {
                        let meta = if child.is_dir {
                            Meta::dir()
                        } else {
                            let child_path = crate::paths::join(path, &child.name);
                            match self.authorize(credentials, Op::Stat, &child_path) {
                                Ok((child_target, _)) => match self.meta_for(credentials, &child_target).await {
                                    Ok(meta) => meta,
                                    Err(_) => continue,
                                },
                                Err(_) => continue,
                            }
                        };
                        out.push(Box::new(Entry { name: child.name.clone(), meta }));
                    }
                    out
                }
                Target::Disk { root, rel, abs, .. } => {
                    let (root, rel, abs) = (root.clone(), rel.clone(), abs.clone());
                    let listed = tokio::task::spawn_blocking(move || gateway::list_disk_dir(&root, &rel, &abs))
                        .await
                        .map_err(|_| FsError::GeneralFailure)?
                        .map_err(|error| io_error(&error))?;
                    listed
                        .into_iter()
                        .map(|entry| {
                            Box::new(Entry {
                                meta: Meta {
                                    len: entry.size,
                                    modified: UNIX_EPOCH + Duration::from_millis(entry.modified_ms.max(0) as u64),
                                    is_dir: entry.is_dir,
                                },
                                name: entry.name,
                            }) as Box<dyn DavDirEntry>
                        })
                        .collect()
                }
                Target::AssetDir { entries, .. } => entries
                    .iter()
                    .map(|entry| Box::new(Entry { name: entry.name.clone(), meta: Meta::asset(entry) }) as Box<dyn DavDirEntry>)
                    .collect(),
                Target::Asset { .. } => return Err(FsError::Forbidden),
            };
            gateway::record_transfer(&store, now_ms(), credentials, Op::List, &target, None, crate::audit::Outcome::Allowed, None);
            Ok(futures_util::stream::iter(entries.into_iter().map(Ok)).boxed())
        }
        .boxed()
    }

    fn metadata<'a>(&'a self, path: &'a DavPath, credentials: &'a Creds) -> FsFuture<'a, Box<dyn DavMetaData>> {
        async move {
            let vpath = dav_path(path)?;
            let (target, _) = self.authorize(credentials, Op::Stat, &vpath)?;
            let meta = self.meta_for(credentials, &target).await?;
            Ok(Box::new(meta) as Box<dyn DavMetaData>)
        }
        .boxed()
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath, credentials: &'a Creds) -> FsFuture<'a, ()> {
        async move {
            let vpath = dav_path(path)?;
            let (target, _) = self.authorize(credentials, Op::Mkdir, &vpath)?;
            let Target::Disk { abs, .. } = target else {
                return Err(FsError::Forbidden);
            };
            tokio::fs::create_dir(&abs).await.map_err(|error| io_error(&error))
        }
        .boxed()
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath, credentials: &'a Creds) -> FsFuture<'a, ()> {
        async move {
            let vpath = dav_path(path)?;
            let (target, _) = self.authorize(credentials, Op::Delete, &vpath)?;
            let Target::Disk { abs, .. } = target else {
                return Err(FsError::Forbidden);
            };
            tokio::fs::remove_dir(&abs).await.map_err(|error| io_error(&error))
        }
        .boxed()
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath, credentials: &'a Creds) -> FsFuture<'a, ()> {
        async move {
            let vpath = dav_path(path)?;
            let (target, _) = self.authorize(credentials, Op::Delete, &vpath)?;
            let Target::Disk { abs, .. } = target else {
                return Err(FsError::Forbidden);
            };
            let meta = tokio::fs::symlink_metadata(&abs).await.map_err(|error| io_error(&error))?;
            if meta.is_dir() {
                return Err(FsError::Forbidden);
            }
            tokio::fs::remove_file(&abs).await.map_err(|error| io_error(&error))
        }
        .boxed()
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath, credentials: &'a Creds) -> FsFuture<'a, ()> {
        async move {
            let (from_target, _) = self.authorize(credentials, Op::Rename, &dav_path(from)?)?;
            let (to_target, _) = self.authorize(credentials, Op::Write, &dav_path(to)?)?;
            match (from_target, to_target) {
                (
                    Target::Disk { abs: source, mount_id: from_mount, .. },
                    Target::Disk { abs: dest, mount_id: to_mount, .. },
                ) if from_mount == to_mount => tokio::fs::rename(&source, &dest).await.map_err(|error| io_error(&error)),
                (Target::Disk { .. }, Target::Disk { .. }) => Err(FsError::IsRemote),
                _ => Err(FsError::Forbidden),
            }
        }
        .boxed()
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath, credentials: &'a Creds) -> FsFuture<'a, ()> {
        async move {
            let (from_target, store) = self.authorize(credentials, Op::Read, &dav_path(from)?)?;
            let (to_target, _) = self.authorize(credentials, Op::Write, &dav_path(to)?)?;
            match (&from_target, &to_target) {
                (Target::Disk { abs: source, .. }, Target::Disk { abs: dest, .. }) => {
                    let copied = tokio::fs::copy(source, dest).await.map_err(|error| io_error(&error))?;
                    let mut meter = TransferMeter::new(store, (**credentials).clone(), Op::Write, to_target.clone());
                    meter.add(copied as usize);
                    Ok(())
                }
                _ => Err(FsError::Forbidden),
            }
        }
        .boxed()
    }
}

// ── Metadata and entries ───────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Meta {
    len: u64,
    modified: SystemTime,
    is_dir: bool,
}

impl Meta {
    fn dir() -> Self {
        Self {
            len: 0,
            modified: UNIX_EPOCH,
            is_dir: true,
        }
    }

    fn asset(entry: &AssetEntry) -> Self {
        Self {
            len: entry.size,
            modified: UNIX_EPOCH + Duration::from_millis(entry.modified_at.max(0) as u64),
            is_dir: false,
        }
    }

    fn from_fs(meta: &std::fs::Metadata) -> Self {
        Self {
            len: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta.modified().unwrap_or(UNIX_EPOCH),
            is_dir: meta.is_dir(),
        }
    }
}

impl DavMetaData for Meta {
    fn len(&self) -> u64 {
        self.len
    }

    fn modified(&self) -> FsResult<SystemTime> {
        Ok(self.modified)
    }

    fn is_dir(&self) -> bool {
        self.is_dir
    }
}

struct Entry {
    name: String,
    meta: Meta,
}

impl DavDirEntry for Entry {
    fn name(&self) -> Vec<u8> {
        self.name.as_bytes().to_vec()
    }

    fn metadata(&self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let meta = self.meta.clone();
        async move { Ok(Box::new(meta) as Box<dyn DavMetaData>) }.boxed()
    }
}

// ── Files ──────────────────────────────────────────────────────────────────

struct DiskFile {
    file: tokio::fs::File,
    service: Arc<FileShareService>,
    grant_id: String,
    epoch: u64,
    meter: TransferMeter,
}

impl std::fmt::Debug for DiskFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiskFile").field("meter", &self.meter).finish()
    }
}

impl DiskFile {
    fn live(&mut self) -> FsResult<()> {
        if self.service.live().epoch(&self.grant_id) != self.epoch {
            self.meter.fail("revoked");
            return Err(FsError::Forbidden);
        }
        Ok(())
    }
}

impl DavFile for DiskFile {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        async move {
            let meta = self.file.metadata().await.map_err(|error| io_error(&error))?;
            Ok(Box::new(Meta::from_fs(&meta)) as Box<dyn DavMetaData>)
        }
        .boxed()
    }

    fn write_buf(&mut self, mut buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        async move {
            self.live()?;
            while buf.has_remaining() {
                let chunk = buf.chunk().to_vec();
                self.file.write_all(&chunk).await.map_err(|error| {
                    self.meter.fail("io");
                    io_error(&error)
                })?;
                self.meter.add(chunk.len());
                buf.advance(chunk.len());
            }
            Ok(())
        }
        .boxed()
    }

    fn write_bytes(&mut self, buf: Bytes) -> FsFuture<'_, ()> {
        async move {
            self.live()?;
            self.file.write_all(&buf).await.map_err(|error| {
                self.meter.fail("io");
                io_error(&error)
            })?;
            self.meter.add(buf.len());
            Ok(())
        }
        .boxed()
    }

    fn read_bytes(&mut self, count: usize) -> FsFuture<'_, Bytes> {
        async move {
            self.live()?;
            let mut buf = vec![0_u8; count.min(MAX_ASSET_SLICE)];
            let read = self.file.read(&mut buf).await.map_err(|error| {
                self.meter.fail("io");
                io_error(&error)
            })?;
            buf.truncate(read);
            self.meter.add(read);
            Ok(Bytes::from(buf))
        }
        .boxed()
    }

    fn seek(&mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        async move { self.file.seek(pos).await.map_err(|error| io_error(&error)) }.boxed()
    }

    fn flush(&mut self) -> FsFuture<'_, ()> {
        async move {
            self.file.flush().await.map_err(|error| io_error(&error))?;
            self.file.sync_data().await.map_err(|error| io_error(&error))
        }
        .boxed()
    }
}

struct AssetFile {
    service: Arc<FileShareService>,
    grant_id: String,
    epoch: u64,
    session_id: String,
    mount_id: String,
    entry: AssetEntry,
    pos: u64,
    meter: TransferMeter,
}

impl std::fmt::Debug for AssetFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssetFile")
            .field("name", &self.entry.name)
            .field("pos", &self.pos)
            .finish()
    }
}

impl DavFile for AssetFile {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let meta = Meta::asset(&self.entry);
        async move { Ok(Box::new(meta) as Box<dyn DavMetaData>) }.boxed()
    }

    fn write_buf(&mut self, _buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        async { Err(FsError::Forbidden) }.boxed()
    }

    fn write_bytes(&mut self, _buf: Bytes) -> FsFuture<'_, ()> {
        async { Err(FsError::Forbidden) }.boxed()
    }

    fn read_bytes(&mut self, count: usize) -> FsFuture<'_, Bytes> {
        async move {
            if self.service.live().epoch(&self.grant_id) != self.epoch {
                self.meter.fail("revoked");
                return Err(FsError::Forbidden);
            }
            if self.pos >= self.entry.size {
                return Ok(Bytes::new());
            }
            let want = count
                .min(MAX_ASSET_SLICE)
                .min((self.entry.size - self.pos) as usize);
            let bytes = self
                .service
                .asset_reader()
                .read(&self.session_id, &self.mount_id, &self.entry.source_id, self.pos, want)
                .await
                .map_err(|error| {
                    log::warn!("file-share: asset read failed: {error}");
                    self.meter.fail("asset_unavailable");
                    FsError::GeneralFailure
                })?;
            self.pos += bytes.len() as u64;
            self.meter.add(bytes.len());
            Ok(Bytes::from(bytes))
        }
        .boxed()
    }

    fn seek(&mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        let size = self.entry.size as i128;
        let next = match pos {
            SeekFrom::Start(offset) => offset as i128,
            SeekFrom::End(delta) => size + delta as i128,
            SeekFrom::Current(delta) => self.pos as i128 + delta as i128,
        };
        let result = if next < 0 {
            Err(FsError::GeneralFailure)
        } else {
            self.pos = next as u64;
            Ok(self.pos)
        };
        async move { result }.boxed()
    }

    fn flush(&mut self) -> FsFuture<'_, ()> {
        async { Ok(()) }.boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::tests::MemoryAssets;
    use crate::model::{CreateGrantRequest, ProviderKind};
    use crate::service::tests::service_with;

    struct Served {
        base: String,
        service: Arc<FileShareService>,
        _dir: tempfile::TempDir,
        root: String,
    }

    async fn served(permissions: Vec<Permission>, paths: &[&str]) -> (Served, String, String, String) {
        let (service, dir) = service_with(vec![Permission::Read], vec![]);
        let root = dir.path().join("repo").canonicalize().unwrap().to_string_lossy().into_owned();
        service.set_asset_reader(Arc::new(MemoryAssets(HashMap::from([(
            "m-photo".to_string(),
            b"PNG!!".to_vec(),
        )]))));
        let created = service
            .create_grant(
                CreateGrantRequest {
                    session_id: "s1".into(),
                    paths: paths.iter().map(|p| p.to_string()).collect(),
                    permissions,
                    protocols: vec![Protocol::Webdav],
                    provider: ProviderKind::Builtin,
                    expires_in_seconds: 3600,
                    label: None,
                    ssh_public_key: None,
                },
                "owner",
            )
            .await
            .unwrap();
        let app = router(service.clone(), false);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await;
        });
        let username = created.credentials[0].credential.username.clone();
        let password = created.credentials[0].password.clone();
        (
            Served { base: format!("http://{addr}"), service, _dir: dir, root },
            username,
            password,
            created.grant.id,
        )
    }

    fn client() -> reqwest::Client {
        cognia_net::proxy_config::ensure_crypto_provider();
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn propfind(c: &reqwest::Client, url: &str, user: &str, pass: &str) -> reqwest::RequestBuilder {
        c.request(Method::from_bytes(b"PROPFIND").unwrap(), url)
            .basic_auth(user, Some(pass))
            .header("Depth", "1")
    }

    #[tokio::test]
    async fn listing_reading_and_the_floor_over_webdav() {
        let (s, user, pass, _) = served(vec![Permission::Read, Permission::Download], &["/workspace/src", "/uploads"]).await;
        let c = client();
        assert_eq!(c.get(format!("{}/", s.base)).send().await.unwrap().status(), 401);
        let response = c.get(format!("{}/", s.base)).basic_auth(&user, Some("nope")).send().await.unwrap();
        assert_eq!(response.status(), 401);
        assert!(response.headers().get("www-authenticate").is_some());

        let root = propfind(&c, &format!("{}/", s.base), &user, &pass).send().await.unwrap();
        assert_eq!(root.status(), 207);
        let body = root.text().await.unwrap();
        assert!(body.contains("/workspace/") && body.contains("/uploads/"), "{body}");

        let src = propfind(&c, &format!("{}/workspace/src/", s.base), &user, &pass).send().await.unwrap().text().await.unwrap();
        assert!(src.contains("a.txt") && src.contains("nested"));
        assert!(!src.contains(".env"), "the floor is never listed");

        let file = c.get(format!("{}/workspace/src/a.txt", s.base)).basic_auth(&user, Some(&pass)).send().await.unwrap();
        assert_eq!(file.status(), 200);
        assert_eq!(file.headers()["content-disposition"], "attachment; filename*=UTF-8''a.txt");
        assert_eq!(file.headers()["x-content-type-options"], "nosniff");
        assert_eq!(file.text().await.unwrap(), "alpha");

        let secret = c.get(format!("{}/workspace/src/.env", s.base)).basic_auth(&user, Some(&pass)).send().await.unwrap();
        assert_eq!(secret.status(), 403);
        let outside = c.get(format!("{}/workspace/README.md", s.base)).basic_auth(&user, Some(&pass)).send().await.unwrap();
        assert_eq!(outside.status(), 404, "paths outside the grant do not exist");

        let asset = c.get(format!("{}/uploads/photo.png", s.base)).basic_auth(&user, Some(&pass)).send().await.unwrap();
        assert_eq!(asset.status(), 200);
        assert_eq!(asset.bytes().await.unwrap().as_ref(), b"PNG!!");

        // Read-only grants refuse writes before touching disk.
        let put = c.put(format!("{}/workspace/src/new.txt", s.base)).basic_auth(&user, Some(&pass)).body("x").send().await.unwrap();
        assert!(put.status().is_client_error());
        assert!(!std::path::Path::new(&s.root).join("src/new.txt").exists());
    }

    #[tokio::test]
    async fn writes_mkcol_move_and_delete_when_granted() {
        let (s, user, pass, _) = served(vec![Permission::Read, Permission::Download, Permission::Write], &["/workspace/src"]).await;
        let c = client();
        let body = vec![7_u8; 3 * 1024 * 1024 + 11];
        let put = c.put(format!("{}/workspace/src/big.bin", s.base)).basic_auth(&user, Some(&pass)).body(body.clone()).send().await.unwrap();
        assert!(put.status().is_success(), "{}", put.status());
        assert_eq!(std::fs::read(std::path::Path::new(&s.root).join("src/big.bin")).unwrap(), body);

        let mkcol = c.request(Method::from_bytes(b"MKCOL").unwrap(), format!("{}/workspace/src/dir", s.base)).basic_auth(&user, Some(&pass)).send().await.unwrap();
        assert_eq!(mkcol.status(), 201);
        let mv = c
            .request(Method::from_bytes(b"MOVE").unwrap(), format!("{}/workspace/src/big.bin", s.base))
            .basic_auth(&user, Some(&pass))
            .header("Destination", format!("{}/workspace/src/dir/moved.bin", s.base))
            .send()
            .await
            .unwrap();
        assert!(mv.status().is_success(), "{}", mv.status());
        assert!(std::path::Path::new(&s.root).join("src/dir/moved.bin").exists());
        let escape = c
            .request(Method::from_bytes(b"MOVE").unwrap(), format!("{}/workspace/src/a.txt", s.base))
            .basic_auth(&user, Some(&pass))
            .header("Destination", format!("{}/workspace/a.txt", s.base))
            .send()
            .await
            .unwrap();
        assert!(escape.status().is_client_error(), "moving out of the grant is refused");
        let delete = c.delete(format!("{}/workspace/src/dir", s.base)).basic_auth(&user, Some(&pass)).send().await.unwrap();
        assert!(delete.status().is_success());
        assert!(!std::path::Path::new(&s.root).join("src/dir").exists());
        let root_delete = c.delete(format!("{}/workspace/src", s.base)).basic_auth(&user, Some(&pass)).send().await.unwrap();
        assert!(root_delete.status().is_client_error(), "the shared folder itself survives");
        let env = c.put(format!("{}/workspace/src/.env", s.base)).basic_auth(&user, Some(&pass)).body("X=1").send().await.unwrap();
        assert_eq!(env.status(), 403);
        let audit = s
            .service
            .audit(&crate::service::AuditQuery::default(), &crate::page::PageRequest::default())
            .unwrap()
            .items;
        assert!(audit.iter().any(|row| row.action == "fs.write" && row.bytes == Some(body.len() as i64)));
    }

    #[tokio::test]
    async fn revoking_ends_access_on_the_next_request() {
        let (s, user, pass, grant_id) = served(vec![Permission::Read, Permission::Download], &["/workspace/src"]).await;
        let c = client();
        let ok = c.get(format!("{}/workspace/src/a.txt", s.base)).basic_auth(&user, Some(&pass)).send().await.unwrap();
        assert_eq!(ok.status(), 200);
        s.service.revoke_grant(&grant_id, "owner").await.unwrap();
        let after = c.get(format!("{}/workspace/src/a.txt", s.base)).basic_auth(&user, Some(&pass)).send().await.unwrap();
        assert_eq!(after.status(), 401, "a revoked credential no longer signs in");
    }

    #[test]
    fn percent_round_trip_for_disposition_names() {
        assert_eq!(percent_decode("a%20b.txt"), "a b.txt");
        assert_eq!(percent_decode("%E6%97%A5"), "日");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_encode("a b.txt"), "a%20b.txt");
    }
}
