//! The built-in SFTP listener (ADR-0222 §7.3, §8).
//!
//! An SSH server whose only purpose is the `sftp` subsystem: password or
//! registered public-key authentication against an SFTP credential, then every
//! SFTP request goes through the gateway as that credential. Shell, exec, PTY,
//! environment, agent, X11 and every kind of forwarding are refused, which is
//! what keeps this listener outside ADR-0162's "SFTP is shell-equivalent":
//! it can reach only the grant's paths.
//!
//! The host key is a persistent Ed25519 key in the secret store, so clients
//! can pin its fingerprint (shown with the credential). Revoking a grant
//! disconnects its sessions; stopping the listener disconnects everyone.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, FileMode, Handle, Name, OpenFlags, Status, StatusCode,
    Version,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::TransferMeter;
use crate::assets::MAX_ASSET_SLICE;
use crate::error::{FileShareError, FileShareResult};
use crate::gateway::{self, Caller, Context, Denial, Op, Target};
use crate::listener::{ListenerConfig, SftpRun, HOST_KEY_ACCOUNT, SECRET_SERVICE};
use crate::model::{AssetEntry, Permission, Protocol};
use crate::now_ms;
use crate::service::{FileShareService, LiveGuard};

/// Largest single read answered (clients ask for 32–256 KiB).
const MAX_READ: u32 = 256 * 1024;

/// Load the persistent host key, creating it on first use.
pub fn host_key() -> FileShareResult<PrivateKey> {
    let unavailable = |error: String| FileShareError::new("secret_store_unavailable", error);
    if let Some(pem) = cognia_secrets::secret_store::get(SECRET_SERVICE, HOST_KEY_ACCOUNT).map_err(unavailable)? {
        if let Ok(key) = PrivateKey::from_openssh(pem.as_bytes()) {
            return Ok(key);
        }
        log::warn!("file-share: stored SFTP host key is unreadable; minting a new one");
    }
    let mut seed = [0_u8; 32];
    rand::fill(&mut seed);
    let key = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    let pem = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .map_err(|error| FileShareError::new("host_key_failed", error.to_string()))?;
    cognia_secrets::secret_store::set(SECRET_SERVICE, HOST_KEY_ACCOUNT, &pem).map_err(unavailable)?;
    Ok(key)
}

fn server_config(key: PrivateKey) -> russh::server::Config {
    let mut methods = MethodSet::empty();
    methods.push(MethodKind::Password);
    methods.push(MethodKind::PublicKey);
    russh::server::Config {
        server_id: russh::SshId::Standard("SSH-2.0-Cognia_FileShare".into()),
        methods,
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(300),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        max_auth_attempts: 6,
        inactivity_timeout: Some(Duration::from_secs(15 * 60)),
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    }
}

/// Bind and serve SFTP with `config`.
pub(crate) async fn serve(service: Arc<FileShareService>, config: &ListenerConfig, key: PrivateKey) -> FileShareResult<SftpRun> {
    let addr = config.sftp_bind();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|error| FileShareError::new("listener_bind_failed", format!("SFTP cannot listen on {addr}: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| FileShareError::new("listener_bind_failed", error.to_string()))?
        .port();
    let cancel = CancellationToken::new();
    tokio::spawn(accept_loop(listener, Arc::new(server_config(key)), service, cancel.clone()));
    Ok(SftpRun { port, cancel })
}

/// Accept connections until `cancel` (exposed for tests).
pub async fn accept_loop(
    listener: tokio::net::TcpListener,
    config: Arc<russh::server::Config>,
    service: Arc<FileShareService>,
    cancel: CancellationToken,
) {
    loop {
        let (socket, peer) = tokio::select! {
            _ = cancel.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                Err(error) => {
                    log::warn!("file-share SFTP accept failed: {error}");
                    continue;
                }
            },
        };
        let config = config.clone();
        let service = service.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let handler = SshConnection::new(service, peer, cancel.clone());
            let Ok(session) = russh::server::run_stream(config, socket, handler).await else {
                return;
            };
            let handle = session.handle();
            tokio::select! {
                _ = session => {}
                _ = cancel.cancelled() => {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "the file share stopped".into(), "en".into())
                        .await;
                }
            }
        });
    }
}

/// One SSH connection.
struct SshConnection {
    service: Arc<FileShareService>,
    remote: String,
    caller: Option<Caller>,
    channels: HashMap<ChannelId, Channel<Msg>>,
    guard: Option<LiveGuard>,
    listener_cancel: CancellationToken,
    closed: CancellationToken,
}

impl SshConnection {
    fn new(service: Arc<FileShareService>, peer: SocketAddr, listener_cancel: CancellationToken) -> Self {
        Self {
            service,
            remote: peer.ip().to_string(),
            caller: None,
            channels: HashMap::new(),
            guard: None,
            listener_cancel,
            closed: CancellationToken::new(),
        }
    }
}

impl Drop for SshConnection {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}

fn refuse(session: &mut Session, channel: ChannelId) -> Result<(), russh::Error> {
    session.channel_failure(channel)?;
    session.close(channel)
}

impl russh::server::Handler for SshConnection {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        match self
            .service
            .authenticate_password(Protocol::Sftp, user, password, Some(&self.remote))
            .await
        {
            Ok(caller) => {
                self.caller = Some(caller);
                Ok(Auth::Accept)
            }
            Err(_) => Ok(Auth::reject()),
        }
    }

    async fn auth_publickey_offered(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        Ok(match self.service.authenticate_key(user, key, Some(&self.remote)) {
            Ok(_) => Auth::Accept,
            Err(_) => Auth::reject(),
        })
    }

    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        match self.service.authenticate_key(user, key, Some(&self.remote)) {
            Ok(caller) => {
                self.caller = Some(caller);
                Ok(Auth::Accept)
            }
            Err(_) => Ok(Auth::reject()),
        }
    }

    async fn auth_succeeded(&mut self, session: &mut Session) -> Result<(), Self::Error> {
        let Some(caller) = &self.caller else {
            return Ok(());
        };
        let guard = self.service.register_connection(&caller.grant_id);
        let revoked = guard.token.clone();
        let closed = self.closed.clone();
        let handle = session.handle();
        tokio::spawn(async move {
            tokio::select! {
                _ = revoked.cancelled() => {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "access to this share was withdrawn".into(), "en".into())
                        .await;
                }
                _ = closed.cancelled() => {}
            }
        });
        self.guard = Some(guard);
        Ok(())
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.caller.is_some() && self.channels.len() < 8 {
            self.channels.insert(channel.id(), channel);
            reply.accept().await;
        }
        Ok(())
    }

    async fn subsystem_request(&mut self, channel_id: ChannelId, name: &str, session: &mut Session) -> Result<(), Self::Error> {
        let (Some(caller), true) = (self.caller.clone(), name == "sftp") else {
            return refuse(session, channel_id);
        };
        let Some(channel) = self.channels.remove(&channel_id) else {
            return refuse(session, channel_id);
        };
        session.channel_success(channel_id)?;
        let handler = SftpSession {
            service: self.service.clone(),
            caller,
            handles: HashMap::new(),
            next: 0,
        };
        russh_sftp::server::run(channel.into_stream(), handler).await;
        let _ = &self.listener_cancel;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        refuse(session, channel)
    }

    async fn exec_request(&mut self, channel: ChannelId, _data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        refuse(session, channel)
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        refuse(session, channel)
    }

    async fn env_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        _value: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)
    }

    async fn agent_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<bool, Self::Error> {
        session.channel_failure(channel)?;
        Ok(false)
    }

    async fn tcpip_forward(&mut self, _address: &str, _port: &mut u32, _session: &mut Session) -> Result<bool, Self::Error> {
        Ok(false)
    }
}

// ── SFTP ───────────────────────────────────────────────────────────────────

enum OpenHandle {
    Dir { entries: Vec<File>, sent: bool },
    Disk { file: tokio::fs::File, epoch: u64, meter: TransferMeter },
    Asset { session_id: String, mount_id: String, entry: AssetEntry, epoch: u64, meter: TransferMeter },
}

struct SftpSession {
    service: Arc<FileShareService>,
    caller: Caller,
    handles: HashMap<String, OpenHandle>,
    next: u64,
}

/// Resolve `.` and `..` lexically in the credential's virtual namespace
/// (clamped at its root), then apply the FileSpace grammar. Disk confinement
/// still runs on whatever this yields.
fn resolve_path(raw: &str) -> Option<String> {
    let mut segments: Vec<&str> = Vec::new();
    for segment in raw.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    crate::paths::normalize(&format!("/{}", segments.join("/")))
}

fn status_for(denial: &Denial) -> StatusCode {
    if denial.is_not_found() || denial.reason == "invalid_path" {
        StatusCode::NoSuchFile
    } else {
        StatusCode::PermissionDenied
    }
}

fn io_status(error: &std::io::Error) -> StatusCode {
    match error.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".into(),
        language_tag: "en-US".into(),
    }
}

fn unix_seconds(ms: i64) -> u32 {
    (ms.max(0) / 1000).min(u32::MAX as i64) as u32
}

impl SftpSession {
    fn authorize(&self, op: Op, raw: &str) -> Result<(Target, Arc<crate::store::Store>), StatusCode> {
        let path = resolve_path(raw).ok_or(StatusCode::NoSuchFile)?;
        let (store, policy) = self.service.context().ok_or(StatusCode::PermissionDenied)?;
        let target = gateway::authorize(
            &Context {
                store: &store,
                policy: &policy,
                now: now_ms(),
            },
            &self.caller,
            op,
            &path,
        )
        .map_err(|denial| status_for(&denial))?;
        Ok((target, store))
    }

    fn writable(&self) -> bool {
        self.service
            .context()
            .and_then(|(store, _)| store.grant(&self.caller.grant_id).ok().flatten())
            .is_some_and(|grant| grant.allows(Permission::Write))
    }

    fn dir_attrs(&self) -> FileAttributes {
        let mut attrs = FileAttributes {
            size: Some(0),
            permissions: Some(if self.writable() { 0o755 } else { 0o555 }),
            atime: Some(0),
            mtime: Some(0),
            ..Default::default()
        };
        attrs.set_type(FileMode::DIR);
        attrs
    }

    fn file_attrs(&self, size: u64, modified_ms: i64, writable: bool) -> FileAttributes {
        let mut attrs = FileAttributes {
            size: Some(size),
            permissions: Some(if writable { 0o644 } else { 0o444 }),
            atime: Some(unix_seconds(modified_ms)),
            mtime: Some(unix_seconds(modified_ms)),
            ..Default::default()
        };
        attrs.set_type(FileMode::REG);
        attrs
    }

    fn disk_attrs(&self, meta: &std::fs::Metadata) -> FileAttributes {
        if meta.is_dir() {
            let mut attrs = self.dir_attrs();
            attrs.mtime = Some(unix_seconds(gateway::modified_ms(meta)));
            attrs.atime = attrs.mtime;
            attrs
        } else {
            self.file_attrs(meta.len(), gateway::modified_ms(meta), self.writable())
        }
    }

    async fn attrs_for(&self, target: &Target) -> Result<FileAttributes, StatusCode> {
        match target {
            Target::Virtual { .. } | Target::AssetDir { .. } => Ok(self.dir_attrs()),
            Target::Asset { entry, .. } => Ok(self.file_attrs(entry.size, entry.modified_at, false)),
            Target::Disk { abs, .. } => {
                let meta = tokio::fs::metadata(abs).await.map_err(|error| io_status(&error))?;
                Ok(self.disk_attrs(&meta))
            }
        }
    }

    fn mint(&mut self, handle: OpenHandle) -> String {
        self.next += 1;
        let id = format!("h{}", self.next);
        self.handles.insert(id.clone(), handle);
        id
    }

    fn epoch(&self) -> u64 {
        self.service.live().epoch(&self.caller.grant_id)
    }
}

impl russh_sftp::server::Handler for SftpSession {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(&mut self, _version: u32, _extensions: HashMap<String, String>) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let resolved = resolve_path(&path).ok_or(StatusCode::NoSuchFile)?;
        Ok(Name {
            id,
            files: vec![File::dummy(resolved)],
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let (target, store) = self.authorize(Op::List, &path)?;
        let mut entries = vec![
            File::new(".", self.dir_attrs()),
            File::new("..", self.dir_attrs()),
        ];
        match &target {
            Target::Virtual { path, children } => {
                for child in children {
                    if child.is_dir {
                        entries.push(File::new(child.name.clone(), self.dir_attrs()));
                        continue;
                    }
                    let child_path = crate::paths::join(path, &child.name);
                    if let Ok((child_target, _)) = self.authorize(Op::Stat, &child_path) {
                        if let Ok(attrs) = self.attrs_for(&child_target).await {
                            entries.push(File::new(child.name.clone(), attrs));
                        }
                    }
                }
            }
            Target::Disk { root, rel, abs, .. } => {
                let (root, rel, abs) = (root.clone(), rel.clone(), abs.clone());
                let listed = tokio::task::spawn_blocking(move || gateway::list_disk_dir(&root, &rel, &abs))
                    .await
                    .map_err(|_| StatusCode::Failure)?
                    .map_err(|error| io_status(&error))?;
                let writable = self.writable();
                for entry in listed {
                    let attrs = if entry.is_dir {
                        let mut attrs = self.dir_attrs();
                        attrs.mtime = Some(unix_seconds(entry.modified_ms));
                        attrs
                    } else {
                        self.file_attrs(entry.size, entry.modified_ms, writable)
                    };
                    entries.push(File::new(entry.name, attrs));
                }
            }
            Target::AssetDir { entries: assets, .. } => {
                for asset in assets {
                    entries.push(File::new(asset.name.clone(), self.file_attrs(asset.size, asset.modified_at, false)));
                }
            }
            Target::Asset { .. } => return Err(StatusCode::NoSuchFile),
        }
        gateway::record_transfer(&store, now_ms(), &self.caller, Op::List, &target, None, crate::audit::Outcome::Allowed, None);
        let handle = self.mint(OpenHandle::Dir { entries, sent: false });
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        match self.handles.get_mut(&handle) {
            Some(OpenHandle::Dir { entries, sent }) if !*sent => {
                *sent = true;
                Ok(Name {
                    id,
                    files: std::mem::take(entries),
                })
            }
            Some(OpenHandle::Dir { .. }) => Err(StatusCode::Eof),
            _ => Err(StatusCode::Failure),
        }
    }

    async fn open(&mut self, id: u32, filename: String, pflags: OpenFlags, _attrs: FileAttributes) -> Result<Handle, Self::Error> {
        let writing = pflags.intersects(OpenFlags::WRITE | OpenFlags::APPEND | OpenFlags::CREATE | OpenFlags::TRUNCATE);
        let op = if writing { Op::Write } else { Op::Read };
        let (target, store) = self.authorize(op, &filename)?;
        let epoch = self.epoch();
        let handle = match &target {
            Target::Disk { abs, .. } => {
                let file = if writing {
                    tokio::fs::OpenOptions::new()
                        .read(pflags.contains(OpenFlags::READ))
                        .write(true)
                        .append(pflags.contains(OpenFlags::APPEND))
                        .truncate(pflags.contains(OpenFlags::TRUNCATE))
                        .create(pflags.contains(OpenFlags::CREATE) && !pflags.contains(OpenFlags::EXCLUDE))
                        .create_new(pflags.contains(OpenFlags::CREATE) && pflags.contains(OpenFlags::EXCLUDE))
                        .open(abs)
                        .await
                } else {
                    tokio::fs::File::open(abs).await
                }
                .map_err(|error| io_status(&error))?;
                if file.metadata().await.map(|meta| meta.is_dir()).unwrap_or(true) {
                    return Err(StatusCode::Failure);
                }
                OpenHandle::Disk {
                    file,
                    epoch,
                    meter: TransferMeter::new(store, self.caller.clone(), op, target.clone()),
                }
            }
            Target::Asset { session_id, mount_id, entry, .. } => OpenHandle::Asset {
                session_id: session_id.clone(),
                mount_id: mount_id.clone(),
                entry: entry.clone(),
                epoch,
                meter: TransferMeter::new(store, self.caller.clone(), op, target.clone()),
            },
            Target::Virtual { .. } | Target::AssetDir { .. } => return Err(StatusCode::Failure),
        };
        let handle = self.mint(handle);
        Ok(Handle { id, handle })
    }

    async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data, Self::Error> {
        let current = self.epoch();
        let reader = self.service.asset_reader();
        match self.handles.get_mut(&handle) {
            Some(OpenHandle::Disk { file, epoch, meter }) => {
                if *epoch != current {
                    meter.fail("revoked");
                    return Err(StatusCode::PermissionDenied);
                }
                file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|error| io_status(&error))?;
                let mut buf = vec![0_u8; len.min(MAX_READ) as usize];
                let read = file.read(&mut buf).await.map_err(|error| io_status(&error))?;
                if read == 0 {
                    return Err(StatusCode::Eof);
                }
                buf.truncate(read);
                meter.add(read);
                Ok(Data { id, data: buf })
            }
            Some(OpenHandle::Asset { session_id, mount_id, entry, epoch, meter }) => {
                if *epoch != current {
                    meter.fail("revoked");
                    return Err(StatusCode::PermissionDenied);
                }
                if offset >= entry.size {
                    return Err(StatusCode::Eof);
                }
                let want = (len.min(MAX_READ) as usize)
                    .min(MAX_ASSET_SLICE)
                    .min((entry.size - offset) as usize);
                let data = reader
                    .read(session_id, mount_id, &entry.source_id, offset, want)
                    .await
                    .map_err(|_| {
                        meter.fail("asset_unavailable");
                        StatusCode::Failure
                    })?;
                if data.is_empty() {
                    return Err(StatusCode::Eof);
                }
                meter.add(data.len());
                Ok(Data { id, data })
            }
            _ => Err(StatusCode::Failure),
        }
    }

    async fn write(&mut self, id: u32, handle: String, offset: u64, data: Vec<u8>) -> Result<Status, Self::Error> {
        let current = self.epoch();
        match self.handles.get_mut(&handle) {
            Some(OpenHandle::Disk { file, epoch, meter }) => {
                if *epoch != current {
                    meter.fail("revoked");
                    return Err(StatusCode::PermissionDenied);
                }
                file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|error| io_status(&error))?;
                file.write_all(&data).await.map_err(|error| {
                    meter.fail("io");
                    io_status(&error)
                })?;
                meter.add(data.len());
                Ok(ok(id))
            }
            _ => Err(StatusCode::PermissionDenied),
        }
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        if let Some(OpenHandle::Disk { mut file, .. }) = self.handles.remove(&handle) {
            let _ = file.flush().await;
            let _ = file.sync_data().await;
        }
        Ok(ok(id))
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let (target, _) = self.authorize(Op::Stat, &path)?;
        Ok(Attrs {
            id,
            attrs: self.attrs_for(&target).await?,
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let attrs = match self.handles.get(&handle) {
            Some(OpenHandle::Disk { file, .. }) => {
                let meta = file.metadata().await.map_err(|error| io_status(&error))?;
                self.disk_attrs(&meta)
            }
            Some(OpenHandle::Asset { entry, .. }) => self.file_attrs(entry.size, entry.modified_at, false),
            Some(OpenHandle::Dir { .. }) => self.dir_attrs(),
            None => return Err(StatusCode::Failure),
        };
        Ok(Attrs { id, attrs })
    }

    /// Size changes truncate; a modification time is applied; ownership and
    /// mode bits are ignored (the grant, not POSIX bits, decides access).
    async fn setstat(&mut self, id: u32, path: String, attrs: FileAttributes) -> Result<Status, Self::Error> {
        let (target, _) = self.authorize(Op::Write, &path)?;
        let Target::Disk { abs, .. } = target else {
            return Err(StatusCode::PermissionDenied);
        };
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&abs)
            .await
            .map_err(|error| io_status(&error))?;
        apply_attrs(file, &attrs).await?;
        Ok(ok(id))
    }

    async fn fsetstat(&mut self, id: u32, handle: String, attrs: FileAttributes) -> Result<Status, Self::Error> {
        let Some(OpenHandle::Disk { file, .. }) = self.handles.get(&handle) else {
            return Err(StatusCode::PermissionDenied);
        };
        let clone = file.try_clone().await.map_err(|error| io_status(&error))?;
        apply_attrs(clone, &attrs).await?;
        Ok(ok(id))
    }

    async fn mkdir(&mut self, id: u32, path: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        let (target, _) = self.authorize(Op::Mkdir, &path)?;
        let Target::Disk { abs, .. } = target else {
            return Err(StatusCode::PermissionDenied);
        };
        tokio::fs::create_dir(&abs).await.map_err(|error| io_status(&error))?;
        Ok(ok(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let (target, _) = self.authorize(Op::Delete, &path)?;
        let Target::Disk { abs, .. } = target else {
            return Err(StatusCode::PermissionDenied);
        };
        tokio::fs::remove_dir(&abs).await.map_err(|error| io_status(&error))?;
        Ok(ok(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let (target, _) = self.authorize(Op::Delete, &filename)?;
        let Target::Disk { abs, .. } = target else {
            return Err(StatusCode::PermissionDenied);
        };
        let meta = tokio::fs::symlink_metadata(&abs).await.map_err(|error| io_status(&error))?;
        if meta.is_dir() {
            return Err(StatusCode::Failure);
        }
        tokio::fs::remove_file(&abs).await.map_err(|error| io_status(&error))?;
        Ok(ok(id))
    }

    async fn rename(&mut self, id: u32, oldpath: String, newpath: String) -> Result<Status, Self::Error> {
        let (from, _) = self.authorize(Op::Rename, &oldpath)?;
        let (to, _) = self.authorize(Op::Write, &newpath)?;
        match (from, to) {
            (Target::Disk { abs: source, mount_id: a, .. }, Target::Disk { abs: dest, mount_id: b, .. }) if a == b => {
                if tokio::fs::symlink_metadata(&dest).await.is_ok() {
                    return Err(StatusCode::Failure);
                }
                tokio::fs::rename(&source, &dest).await.map_err(|error| io_status(&error))?;
                Ok(ok(id))
            }
            _ => Err(StatusCode::PermissionDenied),
        }
    }

    async fn readlink(&mut self, _id: u32, _path: String) -> Result<Name, Self::Error> {
        Err(StatusCode::OpUnsupported)
    }

    async fn symlink(&mut self, _id: u32, _linkpath: String, _targetpath: String) -> Result<Status, Self::Error> {
        Err(StatusCode::OpUnsupported)
    }
}

async fn apply_attrs(file: tokio::fs::File, attrs: &FileAttributes) -> Result<(), StatusCode> {
    if let Some(size) = attrs.size {
        file.set_len(size).await.map_err(|error| io_status(&error))?;
    }
    if let Some(mtime) = attrs.mtime {
        let std_file = file.into_std().await;
        let when = UNIX_EPOCH + Duration::from_secs(mtime as u64);
        tokio::task::spawn_blocking(move || std_file.set_modified(when))
            .await
            .map_err(|_| StatusCode::Failure)?
            .map_err(|error| io_status(&error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::tests::MemoryAssets;
    use crate::model::{CreateGrantRequest, ProviderKind};
    use crate::service::tests::service_with;

    struct Client;

    impl russh::client::Handler for Client {
        type Error = russh::Error;

        async fn check_server_key(&mut self, _key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    #[test]
    fn sftp_paths_resolve_dots_inside_the_virtual_root() {
        assert_eq!(resolve_path(".").as_deref(), Some("/"));
        assert_eq!(resolve_path("workspace/src/..").as_deref(), Some("/workspace"));
        assert_eq!(resolve_path("/../../etc/passwd").as_deref(), Some("/etc/passwd"));
        assert_eq!(resolve_path("/workspace/./src//a.txt").as_deref(), Some("/workspace/src/a.txt"));
        assert_eq!(resolve_path("/workspace/a\\b"), None);
    }

    /// Manual spike (ADR-0222 §12): serves two grants over a real WebDAV and
    /// a real SFTP listener until `SPIKE_SECS` (default 900) elapse, for
    /// OpenSSH `sftp`, curl, Finder (`mount volume`) and rclone to connect to.
    /// Writes ports, credentials and the host-key fingerprint to
    /// `$SPIKE_DIR/spike.json` (default the temp dir). `SPIKE_SSH_KEY`, an
    /// OpenSSH public key, also enables key auth for the SFTP credential.
    ///
    /// `cargo test -p cognia-file-share --lib spike_serve_real_clients -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "manual spike against real clients; serves until SPIKE_SECS elapse"]
    async fn spike_serve_real_clients() {
        let (service, dir) = service_with(vec![Permission::Read], vec![]);
        service.set_asset_reader(Arc::new(MemoryAssets(HashMap::from([(
            "m-photo".to_string(),
            b"PNG!!".to_vec(),
        )]))));
        let request = |paths: &[&str], permissions: Vec<Permission>, protocols: Vec<Protocol>, key: Option<String>| CreateGrantRequest {
            session_id: "s1".into(),
            paths: paths.iter().map(|path| path.to_string()).collect(),
            permissions,
            protocols,
            provider: ProviderKind::Builtin,
            expires_in_seconds: 3600,
            label: Some("spike".into()),
            ssh_public_key: key,
        };
        let writable = service
            .create_grant(
                request(
                    &["/workspace/src"],
                    vec![Permission::Read, Permission::Download, Permission::Write],
                    vec![Protocol::Webdav, Protocol::Sftp],
                    std::env::var("SPIKE_SSH_KEY").ok(),
                ),
                "owner",
            )
            .await
            .unwrap();
        let read_only = service
            .create_grant(
                request(&["/workspace", "/uploads"], vec![Permission::Read, Permission::Download], vec![Protocol::Webdav], None),
                "owner",
            )
            .await
            .unwrap();

        let dav = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dav_addr = dav.local_addr().unwrap();
        let app = crate::builtin::dav::router(service.clone(), false);
        tokio::spawn(async move {
            let _ = axum::serve(dav, app.into_make_service_with_connect_info::<SocketAddr>()).await;
        });
        let sftp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let sftp_addr = sftp.local_addr().unwrap();
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&[9_u8; 32]));
        let fingerprint = key.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string();
        let cancel = CancellationToken::new();
        tokio::spawn(accept_loop(sftp, Arc::new(server_config(key)), service.clone(), cancel.clone()));

        let creds = |created: &crate::model::CreatedGrant| -> Vec<serde_json::Value> {
            created
                .credentials
                .iter()
                .map(|issued| {
                    serde_json::json!({
                        "protocol": issued.credential.protocol,
                        "username": issued.credential.username,
                        "password": issued.password,
                    })
                })
                .collect()
        };
        let report = serde_json::json!({
            "root": dir.path().join("repo"),
            "webdav": format!("http://{dav_addr}/"),
            "sftp": { "host": "127.0.0.1", "port": sftp_addr.port(), "hostKey": fingerprint },
            "writable": creds(&writable),
            "readOnly": creds(&read_only),
        });
        let out = std::env::var("SPIKE_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
        std::fs::write(out.join("spike.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        let secs = std::env::var("SPIKE_SECS").ok().and_then(|value| value.parse().ok()).unwrap_or(900);
        tokio::time::sleep(Duration::from_secs(secs)).await;
        cancel.cancel();
    }

    async fn served(permissions: Vec<Permission>) -> (Arc<FileShareService>, tempfile::TempDir, SocketAddr, CancellationToken, String, String, String) {
        // Uploads are read-only, so a writable share names only the folder.
        let paths: Vec<String> = if permissions.contains(&Permission::Write) {
            vec!["/workspace/src".into()]
        } else {
            vec!["/workspace/src".into(), "/uploads".into()]
        };
        let (service, dir) = service_with(vec![Permission::Read], vec![]);
        service.set_asset_reader(Arc::new(MemoryAssets(HashMap::from([("m-photo".to_string(), b"PNG!!".to_vec())]))));
        let created = service
            .create_grant(
                CreateGrantRequest {
                    session_id: "s1".into(),
                    paths,
                    permissions,
                    protocols: vec![Protocol::Sftp],
                    provider: ProviderKind::Builtin,
                    expires_in_seconds: 3600,
                    label: None,
                    ssh_public_key: None,
                },
                "owner",
            )
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&[9_u8; 32]));
        tokio::spawn(accept_loop(listener, Arc::new(server_config(key)), service.clone(), cancel.clone()));
        let user = created.credentials[0].credential.username.clone();
        let pass = created.credentials[0].password.clone();
        (service, dir, addr, cancel, user, pass, created.grant.id)
    }

    async fn connect(addr: SocketAddr, user: &str, pass: &str) -> Result<(russh::client::Handle<Client>, russh_sftp::client::SftpSession), String> {
        let config = Arc::new(russh::client::Config::default());
        let mut handle = russh::client::connect(config, addr, Client).await.map_err(|e| e.to_string())?;
        let auth = handle.authenticate_password(user, pass).await.map_err(|e| e.to_string())?;
        if !auth.success() {
            return Err("rejected".into());
        }
        let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
        channel.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await.map_err(|e| e.to_string())?;
        Ok((handle, sftp))
    }

    #[tokio::test]
    async fn sftp_lists_reads_and_refuses_what_the_grant_does_not_cover() {
        let (_service, dir, addr, cancel, user, pass, _) = served(vec![Permission::Read, Permission::Download]).await;
        assert!(connect(addr, &user, "wrong").await.is_err());
        let (_handle, sftp) = connect(addr, &user, &pass).await.unwrap();
        let root: Vec<String> = sftp.read_dir("/").await.unwrap().map(|e| e.file_name()).collect();
        assert_eq!(root, vec!["uploads", "workspace"]);
        let src: Vec<String> = sftp.read_dir("/workspace/src").await.unwrap().map(|e| e.file_name()).collect();
        assert!(src.contains(&"a.txt".to_string()) && !src.contains(&".env".to_string()));
        assert_eq!(sftp.read("/workspace/src/a.txt").await.unwrap(), b"alpha");
        assert_eq!(sftp.read("/workspace/src/nested/../a.txt").await.unwrap(), b"alpha");
        assert_eq!(sftp.read("/uploads/photo.png").await.unwrap(), b"PNG!!");
        assert!(sftp.read("/workspace/README.md").await.is_err());
        assert!(sftp.read("/workspace/src/.env").await.is_err());
        assert!(put(&sftp, "/workspace/src/new.txt", b"x").await.is_err());
        assert!(!dir.path().join("repo/src/new.txt").exists());
        cancel.cancel();
    }

    async fn put(sftp: &russh_sftp::client::SftpSession, path: &str, data: &[u8]) -> Result<(), String> {
        let mut file = sftp.create(path).await.map_err(|e| e.to_string())?;
        file.write_all(data).await.map_err(|e| e.to_string())?;
        file.shutdown().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tokio::test]
    async fn sftp_writes_when_granted_and_never_follows_symlinks_out() {
        let (_service, dir, addr, cancel, user, pass, _) =
            served(vec![Permission::Read, Permission::Download, Permission::Write]).await;
        let (_handle, sftp) = connect(addr, &user, &pass).await.unwrap();
        put(&sftp, "/workspace/src/new.txt", b"fresh").await.unwrap();
        assert_eq!(std::fs::read(dir.path().join("repo/src/new.txt")).unwrap(), b"fresh");
        sftp.create_dir("/workspace/src/made").await.unwrap();
        sftp.rename("/workspace/src/new.txt", "/workspace/src/made/moved.txt").await.unwrap();
        assert!(dir.path().join("repo/src/made/moved.txt").exists());
        assert!(sftp.rename("/workspace/src/a.txt", "/workspace/a.txt").await.is_err());
        assert!(sftp.symlink("/workspace/src/link", "/etc").await.is_err());
        sftp.remove_file("/workspace/src/made/moved.txt").await.unwrap();
        sftp.remove_dir("/workspace/src/made").await.unwrap();
        assert!(sftp.remove_dir("/workspace/src").await.is_err(), "the shared folder survives");
        #[cfg(unix)]
        {
            let outside = dir.path().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, dir.path().join("repo/src/out")).unwrap();
            assert!(put(&sftp, "/workspace/src/out/x.txt", b"x").await.is_err());
            assert!(!outside.join("x.txt").exists());
        }
        cancel.cancel();
    }

    #[tokio::test]
    async fn shell_and_exec_are_refused() {
        let (_service, _dir, addr, cancel, user, pass, _) = served(vec![Permission::Read]).await;
        let config = Arc::new(russh::client::Config::default());
        let mut handle = russh::client::connect(config, addr, Client).await.unwrap();
        assert!(handle.authenticate_password(&user, &pass).await.unwrap().success());
        let channel = handle.channel_open_session().await.unwrap();
        assert!(channel.exec(true, "id").await.is_err() || {
            // Some russh versions report the failure on the next message.
            let mut channel = channel;
            matches!(channel.wait().await, Some(russh::ChannelMsg::Failure) | Some(russh::ChannelMsg::Close) | None)
        });
        cancel.cancel();
    }

    #[tokio::test]
    async fn revoking_the_grant_disconnects_its_sessions() {
        let (service, _dir, addr, cancel, user, pass, grant_id) = served(vec![Permission::Read, Permission::Download]).await;
        let (handle, sftp) = connect(addr, &user, &pass).await.unwrap();
        assert!(sftp.read("/workspace/src/a.txt").await.is_ok());
        service.revoke_grant(&grant_id, "owner").await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(sftp.read("/workspace/src/a.txt").await.is_err());
        assert!(handle.is_closed());
        assert!(connect(addr, &user, &pass).await.is_err());
        cancel.cancel();
    }
}
