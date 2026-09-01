//! File transfer over a saved SSH profile.
//!
//! ADR-0162 settles what this is allowed to be. The short version, because it
//! shapes every decision below: **SFTP grants exactly what a shell on that
//! machine already grants.** A paired device can already open a shell on a
//! synchronized profile and reach the same bytes through `cat` and `tar`, so
//! this adds an interface rather than authority, and it does not pretend to
//! confine what it cannot.
//!
//! Three consequences show up in the code.
//!
//! There is **no root check**. A workspace path is `root` plus `relPath` and
//! `authorize_workspace_root` rejects anything escaping the root on disk. An
//! SFTP path is a remote absolute path on somebody else's filesystem. Refusing
//! `..` would not stop `/etc/shadow` and would not stop a symlink the remote
//! administrator placed. Writing a check that stops neither would tell a reader
//! something untrue about what a grant permits, so there is none.
//!
//! The pool is keyed on **more than a profile identifier**.
//! `TerminalHost::sync_ssh_profile` replaces a profile by identifier, so an
//! identifier-keyed pool would hold a live connection to the machine the
//! profile used to name, authenticated with the credential it used to carry,
//! and hand it to whoever asked for the new one.
//!
//! A session is **its own SSH connection**, not a channel on the terminal's.
//! Termius and VS Code Remote both split them for the same reason: binding a
//! transfer to a tab means closing an unrelated tab kills it, and it makes
//! browsing impossible without first opening a shell nobody wanted.
//!
//! ## What is not here yet
//!
//! This module has no caller outside its own tests. It is the first half of the
//! work, and the transport that reaches it is the second: the `sftp_*` RPC
//! commands, their `ssh.files` grant, the approval at `_open` and the transfer
//! token described in ADR-0162 all live above this and do not exist yet.
//!
//! That is stated rather than left to be discovered. This repository's most
//! recurrent defect is code that was finished and never wired up, and a reader
//! finding an untethered registry deserves to know which it is looking at.
//! `SftpRegistry::sessions` exists for the host session list ADR-0162 requires
//! and returns an empty vector until something opens a session through it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::ssh::{open_hosted_sftp, HostedSftp, SshSpawnRequest};

/// How long an unused connection is kept before it is closed.
///
/// Long enough that browsing a tree does not re-authenticate between clicks,
/// short enough that a forgotten panel does not hold a session open on a
/// production box all afternoon.
pub const IDLE_TTL: Duration = Duration::from_secs(300);

/// The largest single read or write this module will perform.
///
/// The transport above it chunks to its own budget. This is the backstop that
/// keeps one caller from asking for a whole file in one allocation.
pub const MAX_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SftpEntryKind {
    Dir,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    /// The final component, as the server spelled it.
    pub name: String,
    /// The full remote path, always POSIX-separated. SFTP has no other kind.
    pub path: String,
    pub kind: SftpEntryKind,
    pub size: u64,
    /// Seconds since the epoch, when the server reported one.
    pub modified: Option<u32>,
    /// POSIX mode bits, when the server reported them.
    pub permissions: Option<u32>,
}

/// A live SFTP session, as the host reports it.
///
/// ADR-0162 requires these to be visible where terminal sessions are visible.
/// A pooled connection with an idle timeout that nobody can see would be the
/// one real asymmetry with a shell, and "a phone is reading files on the
/// production box" has to be observable or the grant is unauditable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpSessionInfo {
    pub profile_id: String,
    pub host: String,
    pub username: String,
    /// Milliseconds since the epoch.
    pub opened_at: u64,
    pub last_used_at: u64,
    pub host_key_fingerprint: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SftpError {
    #[error("{0}")]
    Connect(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("{0}")]
    Operation(String),
}

impl SftpError {
    /// A stable code the interface can classify without reading English.
    ///
    /// The renderer's `classifyFileTreeFailure` reads message text as well,
    /// because an SFTP server's own status strings ("Permission denied", "No
    /// such file") already carry the answer. This is the belt to that's
    /// braces: a code survives a server that phrases things its own way.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Connect(_) => "sftp_connect_failed",
            Self::InvalidRequest(_) => "sftp_invalid_request",
            Self::Operation(_) => "sftp_operation_failed",
        }
    }
}

pub type SftpResult<T> = Result<T, SftpError>;

/// What makes two requests the same connection.
///
/// Everything that changes where the connection goes or who it claims to be.
/// A change to any of these must produce a new connection rather than reuse of
/// one that is now pointed somewhere else.
pub fn pool_fingerprint(request: &SshSpawnRequest) -> String {
    let mut parts = vec![
        request.host.clone(),
        request.port.to_string(),
        request.username.clone(),
        format!("{:?}", request.auth_method),
        request.private_key_path.clone().unwrap_or_default(),
        request.credential_ref.clone().unwrap_or_default(),
    ];
    for hop in &request.jump_chain {
        parts.push(format!("{}:{}@{}", hop.host, hop.port, hop.username));
    }
    parts.join("\u{1f}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

/// Reject what cannot be a path, and nothing else.
///
/// A NUL byte truncates the string inside a C server and an empty path names
/// nothing. Neither is a confinement, and this deliberately performs no other
/// check: see the module docs for why a root check would be a lie here.
pub fn validate_remote_path(path: &str) -> SftpResult<()> {
    if path.is_empty() {
        return Err(SftpError::InvalidRequest("path is required".into()));
    }
    if path.contains('\0') {
        return Err(SftpError::InvalidRequest("path contains a NUL byte".into()));
    }
    Ok(())
}

struct PooledSftp {
    hosted: HostedSftp,
    info: SftpSessionInfo,
}

/// Live SFTP connections, pooled per profile configuration.
#[derive(Default)]
pub struct SftpRegistry {
    sessions: Mutex<HashMap<String, Arc<tokio::sync::Mutex<PooledSftp>>>>,
}

impl SftpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// The connection for `request`, dialling one if there is none.
    ///
    /// A pooled entry whose transport has quietly died is dropped rather than
    /// handed over. Learning about a dead connection from the operation that
    /// used it produces a worse error one step further from the cause.
    async fn session_for(
        &self,
        request: &SshSpawnRequest,
        known_hosts_path: &Path,
    ) -> SftpResult<Arc<tokio::sync::Mutex<PooledSftp>>> {
        let key = pool_key(request);
        if let Some(existing) = self.reusable(&key) {
            return Ok(existing);
        }
        let hosted = open_hosted_sftp(request.clone(), known_hosts_path.to_path_buf())
            .await
            .map_err(SftpError::Connect)?;
        let now = now_ms();
        let pooled = Arc::new(tokio::sync::Mutex::new(PooledSftp {
            info: SftpSessionInfo {
                profile_id: request.profile_id.clone(),
                host: request.host.clone(),
                username: request.username.clone(),
                opened_at: now,
                last_used_at: now,
                host_key_fingerprint: hosted.host_key_fingerprint.clone(),
            },
            hosted,
        }));
        // Re-check under the lock. Two callers racing on a cold pool would
        // otherwise both dial, and the loser's connection would leak.
        let mut guard = self.sessions.lock();
        if let Some(existing) = guard.get(&key) {
            return Ok(Arc::clone(existing));
        }
        guard.insert(key, Arc::clone(&pooled));
        Ok(pooled)
    }

    fn reusable(&self, key: &str) -> Option<Arc<tokio::sync::Mutex<PooledSftp>>> {
        let mut guard = self.sessions.lock();
        let candidate = guard.get(key)?;
        let alive = match candidate.try_lock() {
            // Busy means another operation is mid-flight on it, which is proof
            // enough that it exists. Only an idle-but-dead one is worth dropping.
            Err(_) => true,
            Ok(pooled) => pooled.hosted.is_connected(),
        };
        if alive {
            return Some(Arc::clone(candidate));
        }
        guard.remove(key);
        None
    }

    /// Whether a connection for exactly this configuration is already pooled.
    ///
    /// Read-only on purpose: the caller is deciding whether an operation is
    /// about to open a NEW connection to somebody's machine, which is the one
    /// event worth an audit row. Reaping a dead entry here would make the
    /// answer depend on when it was asked.
    pub fn is_pooled(&self, request: &SshSpawnRequest) -> bool {
        self.sessions.lock().contains_key(&pool_key(request))
    }

    /// Every live session, for the host's session list and its audit log.
    pub fn sessions(&self) -> Vec<SftpSessionInfo> {
        let guard = self.sessions.lock();
        guard
            .values()
            .filter_map(|entry| entry.try_lock().ok().map(|pooled| pooled.info.clone()))
            .collect()
    }

    /// Close and forget every session for a profile, whatever its configuration.
    ///
    /// Keyed on the identifier rather than the fingerprint on purpose: this is
    /// what a profile being deleted or edited calls, and the caller is saying
    /// "nothing for this profile survives", not "nothing for this exact
    /// configuration".
    pub fn close_profile(&self, profile_id: &str) -> usize {
        let mut guard = self.sessions.lock();
        let doomed: Vec<String> = guard
            .keys()
            .filter(|key| key_belongs_to_profile(key, profile_id))
            .cloned()
            .collect();
        for key in &doomed {
            guard.remove(key);
        }
        doomed.len()
    }

    /// Drop sessions untouched for longer than `ttl`.
    pub fn reap_idle(&self, ttl: Duration, now: u64) -> usize {
        let mut guard = self.sessions.lock();
        let stamps: Vec<(String, u64)> = guard
            .iter()
            .filter_map(|(key, entry)| {
                let pooled = entry.try_lock().ok()?;
                Some((key.clone(), pooled.info.last_used_at))
            })
            .collect();
        let doomed = expired_keys(&stamps, ttl, now);
        for key in &doomed {
            guard.remove(key);
        }
        doomed.len()
    }
}

/// Everything a caller needs to reach one path on one profile.
///
/// Bundled so the operations below cannot drift apart on which arguments they
/// take, and so a caller never assembles a destination of its own: `request` is
/// the profile the host synchronized, not something a device supplied.
pub struct SftpCall<'a> {
    pub request: &'a SshSpawnRequest,
    pub known_hosts_path: &'a Path,
}

fn map_op(error: russh_sftp::client::error::Error) -> SftpError {
    // The server's own words are kept verbatim. An SFTP status renders as
    // "Permission denied" or "No such file", which is exactly what the
    // renderer's classifier already reads, so translating here would only lose
    // information.
    SftpError::Operation(error.to_string())
}

fn entry_kind(attrs: &russh_sftp::protocol::FileAttributes) -> SftpEntryKind {
    let file_type = attrs.file_type();
    if file_type.is_dir() {
        SftpEntryKind::Dir
    } else if file_type.is_symlink() {
        SftpEntryKind::Symlink
    } else if file_type.is_file() {
        SftpEntryKind::File
    } else {
        SftpEntryKind::Other
    }
}

fn join_remote(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

// ---------------------------------------------------------------------------
// The protocol-facing half.
//
// Free functions over a `SftpSession` rather than methods on the registry, so
// the conversion and offset logic can be driven against a real SFTP server over
// an in-memory duplex, with no SSH connection and no network. The registry
// below is then only pooling and lifetime.
// ---------------------------------------------------------------------------

use russh_sftp::client::SftpSession;

pub async fn list_dir_on(session: &SftpSession, path: &str) -> SftpResult<Vec<SftpEntry>> {
    validate_remote_path(path)?;
    let dir = session.read_dir(path.to_string()).await.map_err(map_op)?;
    let mut entries: Vec<SftpEntry> = dir
        .map(|item| {
            let attrs = item.metadata();
            SftpEntry {
                path: join_remote(path, &item.file_name()),
                name: item.file_name(),
                kind: entry_kind(&attrs),
                size: attrs.size.unwrap_or(0),
                modified: attrs.mtime,
                permissions: attrs.permissions,
            }
        })
        // `.` and `..` are protocol noise rather than entries anyone wants
        // rendered, and a tree showing `..` invites a click that walks out of
        // wherever the user thought they were.
        .filter(|entry| entry.name != "." && entry.name != "..")
        .collect();
    // Directories first, then case-insensitive by name. The server returns
    // whatever order its filesystem hands back, which for a large directory is
    // effectively arbitrary and changes between listings.
    entries.sort_by(|left, right| {
        matches!(right.kind, SftpEntryKind::Dir)
            .cmp(&matches!(left.kind, SftpEntryKind::Dir))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

pub async fn stat_on(session: &SftpSession, path: &str) -> SftpResult<SftpEntry> {
    validate_remote_path(path)?;
    let attrs = session.metadata(path.to_string()).await.map_err(map_op)?;
    Ok(SftpEntry {
        name: leaf_name(path),
        path: path.to_string(),
        kind: entry_kind(&attrs),
        size: attrs.size.unwrap_or(0),
        modified: attrs.mtime,
        permissions: attrs.permissions,
    })
}

/// The final component of a remote path, tolerating trailing slashes.
fn leaf_name(path: &str) -> String {
    path.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn check_chunk_len(len: usize) -> SftpResult<()> {
    if len == 0 || len > MAX_CHUNK_BYTES {
        return Err(SftpError::InvalidRequest(format!(
            "chunk length must be between 1 and {MAX_CHUNK_BYTES} bytes"
        )));
    }
    Ok(())
}

/// Read at most `len` bytes from `offset`.
///
/// Returns fewer at end of file and an empty vector past it, so a caller
/// draining a file stops on a short read rather than on an error. The loop is
/// there because one `read` is permitted to return less than asked for even
/// mid-file, and treating that as the end would silently truncate a transfer.
pub async fn read_chunk_on(
    session: &SftpSession,
    path: &str,
    offset: u64,
    len: usize,
) -> SftpResult<Vec<u8>> {
    validate_remote_path(path)?;
    check_chunk_len(len)?;
    let mut file = session.open(path.to_string()).await.map_err(map_op)?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(io_op)?;
    let mut buffer = vec![0u8; len];
    let mut filled = 0usize;
    while filled < len {
        let read = file.read(&mut buffer[filled..]).await.map_err(io_op)?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buffer.truncate(filled);
    Ok(buffer)
}

/// Write `bytes` at `offset`, creating the file if it is not there.
///
/// The caller owns the offset because the host owns the write head: a resumed
/// upload continues from where the host actually got to, never from the
/// client's own arithmetic (ADR-0162). Returns the new end of the written
/// span, which is what the caller records as its resume point.
pub async fn write_chunk_on(
    session: &SftpSession,
    path: &str,
    offset: u64,
    bytes: &[u8],
) -> SftpResult<u64> {
    validate_remote_path(path)?;
    check_chunk_len(bytes.len())?;
    use russh_sftp::protocol::OpenFlags;
    let mut file = session
        .open_with_flags(
            path.to_string(),
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::READ,
        )
        .await
        .map_err(map_op)?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(io_op)?;
    file.write_all(bytes).await.map_err(io_op)?;
    file.flush().await.map_err(io_op)?;
    Ok(offset + bytes.len() as u64)
}

fn io_op(error: std::io::Error) -> SftpError {
    SftpError::Operation(error.to_string())
}

// ---------------------------------------------------------------------------
// Pooling.
// ---------------------------------------------------------------------------

/// Keys whose session has been idle longer than `ttl`.
///
/// Pure, and separated from the registry for exactly that reason: the reaping
/// rule is the part worth pinning, and it should not need a live SSH connection
/// to be exercised.
pub fn expired_keys(entries: &[(String, u64)], ttl: Duration, now: u64) -> Vec<String> {
    let cutoff = ttl.as_millis() as u64;
    entries
        .iter()
        .filter(|(_, last_used)| now.saturating_sub(*last_used) > cutoff)
        .map(|(key, _)| key.clone())
        .collect()
}

/// The pool key for one request.
///
/// The fingerprint is load-bearing, not decoration. `sync_ssh_profile` replaces
/// a profile by identifier, so a key of the identifier alone would keep a live
/// connection to the machine the profile used to name and hand it to whoever
/// asked for the new one.
pub fn pool_key(request: &SshSpawnRequest) -> String {
    format!("{}\u{1e}{}", request.profile_id, pool_fingerprint(request))
}

/// Whether `key` belongs to `profile_id`, whatever its configuration.
pub fn key_belongs_to_profile(key: &str, profile_id: &str) -> bool {
    key.starts_with(&format!("{profile_id}\u{1e}"))
}

impl SftpRegistry {
    /// Run one operation against the pooled session, stamping it as used.
    ///
    /// The stamp happens whether the operation succeeded or not. A session that
    /// answered "permission denied" is still one somebody is actively using,
    /// and reaping it out from under them would turn a clear refusal into a
    /// reconnect on the next click.
    async fn with_session<T, F>(&self, call: &SftpCall<'_>, run: F) -> SftpResult<T>
    where
        F: for<'s> FnOnce(
            &'s SftpSession,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = SftpResult<T>> + Send + 's>,
        >,
    {
        let pooled = self
            .session_for(call.request, call.known_hosts_path)
            .await?;
        let mut guard = pooled.lock().await;
        guard.info.last_used_at = now_ms();
        run(&guard.hosted.session).await
    }

    pub async fn list_dir(&self, call: SftpCall<'_>, path: &str) -> SftpResult<Vec<SftpEntry>> {
        let owned = path.to_string();
        self.with_session(&call, move |session| {
            Box::pin(async move { list_dir_on(session, &owned).await })
        })
        .await
    }

    pub async fn stat(&self, call: SftpCall<'_>, path: &str) -> SftpResult<SftpEntry> {
        let owned = path.to_string();
        self.with_session(&call, move |session| {
            Box::pin(async move { stat_on(session, &owned).await })
        })
        .await
    }

    /// Resolve a path the way the server would, symlinks included.
    ///
    /// The one place a client learns where a relative path actually lands,
    /// which is how a browser opens on the profile user's home without the
    /// client having to guess at it.
    pub async fn realpath(&self, call: SftpCall<'_>, path: &str) -> SftpResult<String> {
        validate_remote_path(path)?;
        let owned = path.to_string();
        self.with_session(&call, move |session| {
            Box::pin(async move { session.canonicalize(owned).await.map_err(map_op) })
        })
        .await
    }

    pub async fn create_dir(&self, call: SftpCall<'_>, path: &str) -> SftpResult<()> {
        validate_remote_path(path)?;
        let owned = path.to_string();
        self.with_session(&call, move |session| {
            Box::pin(async move { session.create_dir(owned).await.map_err(map_op) })
        })
        .await
    }

    pub async fn rename(&self, call: SftpCall<'_>, from: &str, to: &str) -> SftpResult<()> {
        validate_remote_path(from)?;
        validate_remote_path(to)?;
        let (from, to) = (from.to_string(), to.to_string());
        self.with_session(&call, move |session| {
            Box::pin(async move { session.rename(from, to).await.map_err(map_op) })
        })
        .await
    }

    /// Remove a file, or an empty directory.
    ///
    /// `is_dir` comes from the caller rather than from a `stat` here, because
    /// the interface already knows which one the user clicked and a second round
    /// trip would let the answer change underneath the decision.
    pub async fn remove(&self, call: SftpCall<'_>, path: &str, is_dir: bool) -> SftpResult<()> {
        validate_remote_path(path)?;
        let owned = path.to_string();
        self.with_session(&call, move |session| {
            Box::pin(async move {
                if is_dir {
                    session.remove_dir(owned).await.map_err(map_op)
                } else {
                    session.remove_file(owned).await.map_err(map_op)
                }
            })
        })
        .await
    }

    pub async fn read_chunk(
        &self,
        call: SftpCall<'_>,
        path: &str,
        offset: u64,
        len: usize,
    ) -> SftpResult<Vec<u8>> {
        let owned = path.to_string();
        self.with_session(&call, move |session| {
            Box::pin(async move { read_chunk_on(session, &owned, offset, len).await })
        })
        .await
    }

    pub async fn write_chunk(
        &self,
        call: SftpCall<'_>,
        path: &str,
        offset: u64,
        bytes: &[u8],
    ) -> SftpResult<u64> {
        let owned = path.to_string();
        let payload = bytes.to_vec();
        self.with_session(&call, move |session| {
            Box::pin(async move { write_chunk_on(session, &owned, offset, &payload).await })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::{SshAuthMethod, SshJumpHop};

    fn request() -> SshSpawnRequest {
        SshSpawnRequest {
            host: "prod.example.com".into(),
            port: 22,
            username: "deploy".into(),
            auth_method: SshAuthMethod::Agent,
            credential_ref: None,
            private_key_path: None,
            rows: 24,
            cols: 80,
            project_id: None,
            profile_id: "prod-east".into(),
            display_name: "Production".into(),
            jump_chain: Vec::new(),
            local_forwards: Vec::new(),
            remote_forwards: Vec::new(),
        }
    }

    mod pool_key_identity {
        use super::*;

        #[test]
        fn the_same_configuration_is_the_same_connection() {
            assert_eq!(pool_key(&request()), pool_key(&request()));
        }

        /// The reason the key is not just the profile identifier.
        ///
        /// `sync_ssh_profile` replaces a profile by identifier. A key of the
        /// identifier alone would keep a live connection to the machine the
        /// profile used to name, authenticated with the credential it used to
        /// carry, and hand it to whoever asked for the new one.
        #[test]
        fn editing_where_a_profile_points_produces_a_new_connection() {
            let before = pool_key(&request());
            let mut after = request();
            after.host = "staging.example.com".into();
            assert_ne!(before, pool_key(&after));
        }

        #[test]
        fn every_field_that_changes_the_destination_changes_the_key() {
            let base = pool_key(&request());
            let mut port = request();
            port.port = 2222;
            let mut user = request();
            user.username = "root".into();
            let mut auth = request();
            auth.auth_method = SshAuthMethod::Password;
            let mut key_path = request();
            key_path.private_key_path = Some("~/.ssh/other".into());
            let mut credential = request();
            credential.credential_ref = Some("cognia-ssh:prod-east".into());
            let mut jumped = request();
            jumped.jump_chain = vec![SshJumpHop {
                host: "bastion.example.com".into(),
                port: 22,
                username: "jump".into(),
                auth_method: SshAuthMethod::Agent,
                credential_ref: None,
                private_key_path: None,
            }];

            for changed in [port, user, auth, key_path, credential, jumped] {
                assert_ne!(base, pool_key(&changed), "{:?}", changed.host);
            }
        }

        /// A bastion swap must not be invisible. Reusing a connection whose
        /// jump chain has changed would reach the target through a machine the
        /// user has since decided not to route through.
        #[test]
        fn swapping_a_bastion_changes_the_key() {
            let hop = |host: &str| SshJumpHop {
                host: host.into(),
                port: 22,
                username: "jump".into(),
                auth_method: SshAuthMethod::Agent,
                credential_ref: None,
                private_key_path: None,
            };
            let mut first = request();
            first.jump_chain = vec![hop("bastion-a")];
            let mut second = request();
            second.jump_chain = vec![hop("bastion-b")];
            assert_ne!(pool_key(&first), pool_key(&second));
        }

        /// Geometry and labels are not identity. A phone asking for 40 rows
        /// must not open a second connection to the same machine.
        #[test]
        fn cosmetic_fields_do_not_split_the_pool() {
            let mut cosmetic = request();
            cosmetic.rows = 40;
            cosmetic.cols = 200;
            cosmetic.display_name = "Prod (east)".into();
            cosmetic.project_id = Some("proj-1".into());
            assert_eq!(pool_key(&request()), pool_key(&cosmetic));
        }

        #[test]
        fn a_key_is_scoped_to_its_profile() {
            let key = pool_key(&request());
            assert!(key_belongs_to_profile(&key, "prod-east"));
            assert!(!key_belongs_to_profile(&key, "prod"));
            assert!(!key_belongs_to_profile(&key, "staging"));
        }
    }

    mod paths {
        use super::*;

        #[test]
        fn an_empty_path_names_nothing() {
            assert!(validate_remote_path("").is_err());
        }

        #[test]
        fn a_nul_byte_would_truncate_inside_a_c_server() {
            assert!(validate_remote_path("/etc/passwd\0.txt").is_err());
        }

        /// Deliberate, and the whole point of ADR-0162.
        ///
        /// There is no root to confine against: the filesystem belongs to the
        /// remote machine, refusing `..` would not stop an absolute path, and
        /// neither would stop a symlink its administrator placed. A check that
        /// stops none of that would tell a reader something untrue about what
        /// the grant permits, so there is none.
        #[test]
        fn traversal_and_absolute_paths_are_accepted_because_this_is_shell_equivalent() {
            for path in [
                "/etc/shadow",
                "../../etc/shadow",
                "~/notes",
                "relative/file",
            ] {
                assert!(validate_remote_path(path).is_ok(), "{path}");
            }
        }

        #[test]
        fn a_leaf_name_survives_trailing_slashes_and_bare_names() {
            assert_eq!(leaf_name("/srv/app/config.toml"), "config.toml");
            assert_eq!(leaf_name("/srv/app/"), "app");
            assert_eq!(leaf_name("config.toml"), "config.toml");
            assert_eq!(leaf_name("/"), "/");
        }

        #[test]
        fn joining_never_doubles_or_drops_a_separator() {
            assert_eq!(join_remote("/srv", "app"), "/srv/app");
            assert_eq!(join_remote("/srv/", "app"), "/srv/app");
            assert_eq!(join_remote("", "app"), "app");
        }
    }

    mod chunk_bounds {
        use super::*;

        #[test]
        fn a_zero_length_chunk_is_a_mistake_rather_than_a_no_op() {
            assert!(check_chunk_len(0).is_err());
        }

        #[test]
        fn one_caller_cannot_ask_for_a_whole_file_in_one_allocation() {
            assert!(check_chunk_len(MAX_CHUNK_BYTES).is_ok());
            assert!(check_chunk_len(MAX_CHUNK_BYTES + 1).is_err());
        }
    }

    mod reaping {
        use super::*;

        #[test]
        fn only_sessions_past_the_ttl_are_dropped() {
            let entries = vec![
                ("fresh".to_string(), 10_000u64),
                ("stale".to_string(), 1_000u64),
            ];
            let doomed = expired_keys(&entries, Duration::from_secs(5), 10_000);
            assert_eq!(doomed, vec!["stale".to_string()]);
        }

        /// Exactly at the boundary the session is kept. A connection used the
        /// instant the TTL elapsed is one somebody is plausibly still using,
        /// and closing it turns a click into a reconnect.
        #[test]
        fn a_session_exactly_at_the_ttl_survives() {
            let entries = vec![("edge".to_string(), 5_000u64)];
            assert!(expired_keys(&entries, Duration::from_secs(5), 10_000).is_empty());
        }

        /// Clocks move backwards across a suspend. Reading that as "idle for
        /// four billion milliseconds" would close every session on wake.
        #[test]
        fn a_clock_that_went_backwards_reaps_nothing() {
            let entries = vec![("future".to_string(), 20_000u64)];
            assert!(expired_keys(&entries, Duration::from_secs(5), 10_000).is_empty());
        }
    }

    mod error_codes {
        use super::*;

        #[test]
        fn each_failure_carries_a_code_a_client_can_classify() {
            assert_eq!(SftpError::Connect("x".into()).code(), "sftp_connect_failed");
            assert_eq!(
                SftpError::InvalidRequest("x".into()).code(),
                "sftp_invalid_request"
            );
            assert_eq!(
                SftpError::Operation("x".into()).code(),
                "sftp_operation_failed"
            );
        }

        /// The renderer's `classifyFileTreeFailure` reads message text, and an
        /// SFTP server's own status strings already carry the answer. Keeping
        /// them verbatim is what makes the two ends agree without a table.
        #[test]
        fn a_server_status_reaches_the_client_in_its_own_words() {
            let denied = SftpError::Operation("Permission denied".into());
            assert!(denied.to_string().contains("Permission denied"));
        }
    }
}

/// A real SFTP server, in memory, on both ends of a `tokio::io::duplex`.
///
/// The point is that the conversion and offset logic above is driven by the
/// actual wire protocol rather than by a stub of it. No SSH, no socket, no
/// filesystem: everything that could differ between "what we think SFTP does"
/// and "what SFTP does" is still in the path.
#[cfg(test)]
mod protocol_tests {
    use std::collections::HashMap;

    use russh_sftp::protocol::{
        Attrs, Data, File, FileAttributes, Handle, Name, Status, StatusCode, Version,
    };

    use super::*;

    const DIR_MODE: u32 = 0x4000 | 0o755;
    const FILE_MODE: u32 = 0x8000 | 0o644;

    fn attrs(mode: u32, size: u64) -> FileAttributes {
        FileAttributes {
            size: Some(size),
            permissions: Some(mode),
            mtime: Some(1_700_000_000),
            ..Default::default()
        }
    }

    #[derive(Default)]
    struct MemoryFs {
        /// path -> contents. A directory is an entry with `None`.
        nodes: HashMap<String, Option<Vec<u8>>>,
        handles: HashMap<String, String>,
        drained: HashMap<String, bool>,
        next_handle: u32,
    }

    impl MemoryFs {
        fn seeded() -> Self {
            let mut fs = Self::default();
            fs.nodes.insert("/srv".into(), None);
            fs.nodes.insert("/srv/logs".into(), None);
            fs.nodes
                .insert("/srv/Alpha.txt".into(), Some(b"alpha".to_vec()));
            fs.nodes
                .insert("/srv/beta.bin".into(), Some((0u8..200).collect()));
            fs
        }

        fn children(&self, dir: &str) -> Vec<(String, Option<usize>)> {
            let prefix = if dir.ends_with('/') {
                dir.to_string()
            } else {
                format!("{dir}/")
            };
            self.nodes
                .iter()
                .filter_map(|(path, body)| {
                    let rest = path.strip_prefix(&prefix)?;
                    if rest.is_empty() || rest.contains('/') {
                        return None;
                    }
                    Some((rest.to_string(), body.as_ref().map(|bytes| bytes.len())))
                })
                .collect()
        }

        fn mint(&mut self, path: &str) -> String {
            self.next_handle += 1;
            let handle = format!("h{}", self.next_handle);
            self.handles.insert(handle.clone(), path.to_string());
            handle
        }
    }

    impl russh_sftp::server::Handler for MemoryFs {
        type Error = StatusCode;

        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }

        async fn init(
            &mut self,
            _version: u32,
            _extensions: HashMap<String, String>,
        ) -> Result<Version, Self::Error> {
            Ok(Version::new())
        }

        async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
            let resolved = if path == "." {
                "/srv".to_string()
            } else {
                path
            };
            Ok(Name {
                id,
                files: vec![File::dummy(resolved)],
            })
        }

        async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
            // A real server resolves `/srv/` and `/srv` to the same directory.
            // Normalizing here keeps the trailing-slash test about the client's
            // path joining rather than about this fixture's key lookup.
            let path = path.trim_end_matches('/').to_string();
            let path = if path.is_empty() {
                "/".to_string()
            } else {
                path
            };
            if !matches!(self.nodes.get(&path), Some(None)) {
                return Err(StatusCode::NoSuchFile);
            }
            let handle = self.mint(&path);
            self.drained.insert(handle.clone(), false);
            Ok(Handle { id, handle })
        }

        async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
            if self.drained.get(&handle).copied().unwrap_or(true) {
                return Err(StatusCode::Eof);
            }
            self.drained.insert(handle.clone(), true);
            let dir = self.handles.get(&handle).cloned().unwrap_or_default();
            // `.` and `..` are what a real server sends, and dropping them is
            // the client's job. Sending them here is what makes that testable.
            let mut files = vec![
                File::new(".", attrs(DIR_MODE, 0)),
                File::new("..", attrs(DIR_MODE, 0)),
            ];
            for (name, size) in self.children(&dir) {
                files.push(match size {
                    None => File::new(name, attrs(DIR_MODE, 0)),
                    Some(len) => File::new(name, attrs(FILE_MODE, len as u64)),
                });
            }
            Ok(Name { id, files })
        }

        async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
            self.handles.remove(&handle);
            self.drained.remove(&handle);
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: "Ok".into(),
                language_tag: "en-US".into(),
            })
        }

        async fn open(
            &mut self,
            id: u32,
            filename: String,
            pflags: russh_sftp::protocol::OpenFlags,
            _attrs: FileAttributes,
        ) -> Result<Handle, Self::Error> {
            let exists = matches!(self.nodes.get(&filename), Some(Some(_)));
            if !exists {
                if !pflags.contains(russh_sftp::protocol::OpenFlags::CREATE) {
                    return Err(StatusCode::NoSuchFile);
                }
                self.nodes.insert(filename.clone(), Some(Vec::new()));
            }
            let handle = self.mint(&filename);
            Ok(Handle { id, handle })
        }

        async fn read(
            &mut self,
            id: u32,
            handle: String,
            offset: u64,
            len: u32,
        ) -> Result<Data, Self::Error> {
            let path = self.handles.get(&handle).cloned().unwrap_or_default();
            let body = match self.nodes.get(&path) {
                Some(Some(bytes)) => bytes.clone(),
                _ => return Err(StatusCode::NoSuchFile),
            };
            let start = offset as usize;
            if start >= body.len() {
                return Err(StatusCode::Eof);
            }
            // A real server is allowed to return less than asked for, and the
            // client's read loop has to cope. Halving the request is how that
            // gets exercised rather than assumed.
            let want = (len as usize).min(body.len() - start);
            let served = want.div_ceil(2).max(1);
            Ok(Data {
                id,
                data: body[start..start + served].to_vec(),
            })
        }

        async fn write(
            &mut self,
            id: u32,
            handle: String,
            offset: u64,
            data: Vec<u8>,
        ) -> Result<Status, Self::Error> {
            let path = self.handles.get(&handle).cloned().unwrap_or_default();
            let Some(Some(body)) = self.nodes.get_mut(&path) else {
                return Err(StatusCode::NoSuchFile);
            };
            let start = offset as usize;
            if body.len() < start + data.len() {
                body.resize(start + data.len(), 0);
            }
            body[start..start + data.len()].copy_from_slice(&data);
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: "Ok".into(),
                language_tag: "en-US".into(),
            })
        }

        async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
            match self.nodes.get(&path) {
                Some(None) => Ok(Attrs {
                    id,
                    attrs: attrs(DIR_MODE, 0),
                }),
                Some(Some(body)) => Ok(Attrs {
                    id,
                    attrs: attrs(FILE_MODE, body.len() as u64),
                }),
                None => Err(StatusCode::NoSuchFile),
            }
        }

        async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
            self.stat(id, path).await
        }
    }

    async fn connected() -> SftpSession {
        let (client, server) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move {
            russh_sftp::server::run(server, MemoryFs::seeded()).await;
        });
        SftpSession::new(client)
            .await
            .expect("SFTP handshake over the in-memory duplex")
    }

    #[tokio::test]
    async fn a_listing_drops_protocol_noise_and_sorts_directories_first() {
        let session = connected().await;
        let entries = list_dir_on(&session, "/srv").await.expect("listing");

        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        // `logs` first because it is a directory, then case-insensitively:
        // a byte-wise sort would put `Alpha.txt` before `beta.bin` for the
        // wrong reason and `beta.bin` before `Alpha.txt` on other input.
        assert_eq!(names, vec!["logs", "Alpha.txt", "beta.bin"]);
        assert!(!names.contains(&"."), "`.` is protocol noise");
        assert!(
            !names.contains(&".."),
            "`..` invites a click out of the tree"
        );
    }

    #[tokio::test]
    async fn a_listing_carries_the_full_remote_path_for_every_entry() {
        let session = connected().await;
        let entries = list_dir_on(&session, "/srv").await.expect("listing");
        let alpha = entries.iter().find(|e| e.name == "Alpha.txt").unwrap();
        assert_eq!(alpha.path, "/srv/Alpha.txt");
        assert_eq!(alpha.kind, SftpEntryKind::File);
        assert_eq!(alpha.size, 5);
        assert_eq!(alpha.permissions, Some(FILE_MODE));
        let logs = entries.iter().find(|e| e.name == "logs").unwrap();
        assert_eq!(logs.kind, SftpEntryKind::Dir);
    }

    #[tokio::test]
    async fn a_trailing_slash_does_not_double_the_separator() {
        let session = connected().await;
        let entries = list_dir_on(&session, "/srv/").await.expect("listing");
        assert!(entries.iter().all(|entry| !entry.path.contains("//")));
    }

    #[tokio::test]
    async fn stat_names_the_leaf_and_reports_the_kind() {
        let session = connected().await;
        let file = stat_on(&session, "/srv/Alpha.txt").await.expect("stat");
        assert_eq!(file.name, "Alpha.txt");
        assert_eq!(file.kind, SftpEntryKind::File);
        assert_eq!(file.size, 5);

        let dir = stat_on(&session, "/srv/logs").await.expect("stat");
        assert_eq!(dir.kind, SftpEntryKind::Dir);
    }

    #[tokio::test]
    async fn a_missing_path_reports_the_server_words_the_client_classifies_on() {
        let session = connected().await;
        let error = stat_on(&session, "/srv/nope").await.expect_err("missing");
        assert_eq!(error.code(), "sftp_operation_failed");
        assert!(
            error.to_string().contains("No such file"),
            "renderer classifies on this text: {error}"
        );
    }

    /// The server here deliberately serves half of every read. A loop that
    /// treated the first short read as end of file would silently truncate
    /// every transfer, which is the kind of bug a stub never catches.
    #[tokio::test]
    async fn a_chunk_read_fills_its_buffer_across_short_reads() {
        let session = connected().await;
        let chunk = read_chunk_on(&session, "/srv/beta.bin", 0, 200)
            .await
            .expect("read");
        assert_eq!(chunk.len(), 200);
        assert_eq!(chunk, (0u8..200).collect::<Vec<u8>>());
    }

    #[tokio::test]
    async fn a_chunk_read_honours_its_offset_and_stops_at_the_end() {
        let session = connected().await;
        let tail = read_chunk_on(&session, "/srv/beta.bin", 190, 64)
            .await
            .expect("read");
        assert_eq!(tail, (190u8..200).collect::<Vec<u8>>());

        let past = read_chunk_on(&session, "/srv/beta.bin", 500, 16)
            .await
            .expect("read past the end is empty, not an error");
        assert!(past.is_empty());
    }

    /// The resume contract from ADR-0162: the caller writes at an offset the
    /// host reports, and gets back the new end of the written span.
    #[tokio::test]
    async fn a_chunked_write_resumes_at_the_offset_it_is_given() {
        let session = connected().await;
        let first = write_chunk_on(&session, "/srv/upload.bin", 0, b"hello ")
            .await
            .expect("first chunk");
        assert_eq!(first, 6);
        let second = write_chunk_on(&session, "/srv/upload.bin", first, b"world")
            .await
            .expect("second chunk");
        assert_eq!(second, 11);

        let readback = read_chunk_on(&session, "/srv/upload.bin", 0, 64)
            .await
            .expect("read back");
        assert_eq!(readback, b"hello world");
    }

    #[tokio::test]
    async fn a_write_creates_a_file_that_was_not_there() {
        let session = connected().await;
        write_chunk_on(&session, "/srv/fresh.txt", 0, b"new")
            .await
            .expect("create on write");
        let stat = stat_on(&session, "/srv/fresh.txt").await.expect("stat");
        assert_eq!(stat.size, 3);
    }

    #[tokio::test]
    async fn realpath_is_how_a_browser_learns_where_a_relative_path_lands() {
        let session = connected().await;
        let resolved = session
            .canonicalize(".".to_string())
            .await
            .expect("realpath");
        assert_eq!(resolved, "/srv");
    }

    #[tokio::test]
    async fn an_oversized_chunk_is_refused_before_it_reaches_the_wire() {
        let session = connected().await;
        let error = read_chunk_on(&session, "/srv/beta.bin", 0, MAX_CHUNK_BYTES + 1)
            .await
            .expect_err("refused");
        assert_eq!(error.code(), "sftp_invalid_request");
    }
}
