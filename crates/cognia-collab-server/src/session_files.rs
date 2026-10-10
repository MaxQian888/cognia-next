//! Live access to a shared conversation's files for its members
//! (ADR-0222 §6).
//!
//! The files of a conversation live on one device — the host — not on this
//! server. A member reaches them through requests:
//!
//! 1. A member who may publish the conversation's files (`files.share`)
//!    registers the host. The server answers with a 32-byte host token and
//!    keeps only its SHA-256; the host authenticates every later call with it.
//!    Re-registering replaces the host. Every host call re-checks that the
//!    person who registered it still holds `files.share` here, so losing the
//!    role takes the host's access with it.
//! 2. The host mirrors each live grant it made for the conversation's members
//!    (who, which paths, which permissions, until when). The server clamps
//!    the mirror to the org's file-sharing policy; the host's own grant stays
//!    authoritative for serving and is re-checked on every request.
//! 3. A member asks: list, stat, read, write, mkdir, delete or rename one
//!    path, under one grant that admits them and covers it
//!    (`files.readLive`, plus `files.writeLive` for a change). A write's bytes
//!    are uploaded first; the request becomes claimable once they arrive.
//! 4. The host long-polls `claim`, executes the request through its own file
//!    gateway, and completes it: bounded JSON for a listing or a change, file
//!    bytes as a result object for a read.
//! 5. The member reads the answer. Only the requester can.
//!
//! Bytes travel through the attachment object store under request-scoped
//! keys, never through `chat_attachments`: an answer belongs to one request
//! and one requester, and expires with it. A request nobody claims expires
//! after two minutes (the member then sees the host as offline); an answer's
//! bytes after fifteen. Expiry is applied lazily, whenever the conversation's
//! requests are touched — the host polls continuously while it is online, and
//! deleting the conversation deletes every object — and a conversation may
//! hold only [`MAX_OPEN_REQUESTS`] unanswered requests, so storage stays
//! bounded even when no host ever comes back.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::api::AppState;
use crate::chat::{authorize_session_action, SessionAction, SessionRole, SessionStatus};
use crate::chat_api::{token_hash, visible, ChatFailure, MAX_ATTACHMENT_BYTES};
use crate::store::{AuthorizationAuditEvent, PgStore, StoreError};

/// The header a host's calls carry its token in.
pub const HOST_TOKEN_HEADER: &str = "x-cognia-file-host-token";
/// The header a host names a read's media type in.
pub const MEDIA_TYPE_HEADER: &str = "x-cognia-media-type";
/// An unclaimed request stops waiting after this long; a claimed one must be
/// answered within it.
pub const REQUEST_WAIT_MS: i64 = 120_000;
/// An answer's bytes are kept this long.
pub const RESULT_TTL_MS: i64 = 15 * 60_000;
/// Longest a host's claim waits for a request.
pub const MAX_CLAIM_WAIT_MS: u64 = 25_000;
/// A host seen within this long is online.
pub const HOST_ONLINE_MS: i64 = 60_000;
/// How often a waiting claim refreshes the host's last contact: well inside
/// [`HOST_ONLINE_MS`], without a write every second.
const TOUCH_INTERVAL_MS: i64 = 10_000;
/// Largest JSON answer (a listing of a big folder fits; a file does not).
pub const MAX_RESULT_JSON_BYTES: usize = 256 * 1024;
/// Most paths one mirrored grant may cover, as the host allows.
pub const MAX_GRANT_PATHS: usize = 50;
/// Most unanswered requests one conversation may hold.
pub const MAX_OPEN_REQUESTS: usize = 32;
/// Most unanswered requests one member may hold in one conversation.
pub const MAX_OPEN_REQUESTS_PER_MEMBER: usize = 8;
const MAX_PATH_CHARS: usize = 4096;
const MAX_LABEL_CHARS: usize = 120;

// ── Types ────────────────────────────────────────────────────────────────────

/// The registered host of a conversation's files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileHost {
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub registered_by: String,
    pub host_token_hash: String,
    pub host_label: String,
    pub registered_at: i64,
    pub last_seen_at: Option<i64>,
}

/// What members see of the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHostView {
    pub registered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<i64>,
    pub online: bool,
}

impl FileHostView {
    pub fn of(host: Option<&FileHost>, now: i64) -> Self {
        match host {
            None => Self {
                registered: false,
                host_label: None,
                registered_by: None,
                registered_at: None,
                last_seen_at: None,
                online: false,
            },
            Some(host) => Self {
                registered: true,
                host_label: Some(host.host_label.clone()),
                registered_by: Some(host.registered_by.clone()),
                registered_at: Some(host.registered_at),
                last_seen_at: host.last_seen_at,
                online: host
                    .last_seen_at
                    .is_some_and(|seen| now - seen <= HOST_ONLINE_MS),
            },
        }
    }
}

/// One path a grant covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantPath {
    pub path: String,
    pub is_dir: bool,
}

/// A host's live grant for the conversation's members, as mirrored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGrant {
    pub id: String,
    #[serde(skip)]
    pub org_id: String,
    #[serde(skip)]
    pub workspace_id: String,
    pub session_id: String,
    pub label: Option<String>,
    /// `None`: every member whose role is at least `min_role`.
    pub user_ids: Option<Vec<String>>,
    pub min_role: SessionRole,
    pub permissions: Vec<String>,
    pub paths: Vec<GrantPath>,
    pub status: String,
    pub expires_at: i64,
    pub revoked_at: Option<i64>,
    pub policy_revision: i64,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What a member may ask the host to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileOp {
    List,
    Stat,
    Read,
    Write,
    Mkdir,
    Delete,
    Rename,
}

impl FileOp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Stat => "stat",
            Self::Read => "read",
            Self::Write => "write",
            Self::Mkdir => "mkdir",
            Self::Delete => "delete",
            Self::Rename => "rename",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "list" => Self::List,
            "stat" => Self::Stat,
            "read" => Self::Read,
            "write" => Self::Write,
            "mkdir" => Self::Mkdir,
            "delete" => Self::Delete,
            "rename" => Self::Rename,
            _ => return None,
        })
    }

    /// The grant permission it needs, as the host's gateway spells it.
    pub fn needs(self) -> &'static str {
        match self {
            Self::List | Self::Stat => "read",
            Self::Read => "download",
            Self::Write | Self::Mkdir | Self::Delete | Self::Rename => "write",
        }
    }

    pub fn changes(self) -> bool {
        self.needs() == "write"
    }
}

/// Where a request is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    /// A write waiting for its bytes.
    AwaitingUpload,
    /// Waiting for the host.
    Pending,
    /// The host took it.
    Claimed,
    Done,
    Failed,
    /// Nobody answered in time, or its answer's bytes were dropped.
    Expired,
}

impl RequestStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingUpload => "awaiting_upload",
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Expired => "expired",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "awaiting_upload" => Self::AwaitingUpload,
            "pending" => Self::Pending,
            "claimed" => Self::Claimed,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "expired" => Self::Expired,
            _ => return None,
        })
    }

    /// Still waiting on someone.
    pub fn is_open(self) -> bool {
        matches!(self, Self::AwaitingUpload | Self::Pending | Self::Claimed)
    }
}

/// A write's bytes, as the member declared them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadSpec {
    pub byte_length: i64,
    pub sha256: String,
    pub object_key: String,
}

/// A read's bytes, as the host stored them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultObject {
    pub object_key: String,
    pub byte_length: i64,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileRequest {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub grant_id: String,
    pub requester_user_id: String,
    pub requester_role: SessionRole,
    pub op: FileOp,
    pub path: String,
    pub dest_path: Option<String>,
    pub upload: Option<UploadSpec>,
    pub status: RequestStatus,
    pub result: Option<serde_json::Value>,
    pub result_object: Option<ResultObject>,
    pub error: Option<String>,
    pub created_at: i64,
    pub claimed_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub expires_at: i64,
}

impl FileRequest {
    /// The status as of `now`: an open request past its deadline, or an
    /// answer past its retention, reads as expired before the reaper runs.
    pub fn status_at(&self, now: i64) -> RequestStatus {
        if self.expires_at <= now && self.status != RequestStatus::Expired {
            return RequestStatus::Expired;
        }
        self.status
    }

    /// Every object key it holds.
    pub fn object_keys(&self) -> Vec<String> {
        let mut keys = Vec::new();
        if let Some(upload) = &self.upload {
            keys.push(upload.object_key.clone());
        }
        if let Some(object) = &self.result_object {
            keys.push(object.object_key.clone());
        }
        keys
    }
}

/// What the requester reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRequestView {
    pub id: String,
    pub grant_id: String,
    pub op: FileOp,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_path: Option<String>,
    pub status: RequestStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_byte_length: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    pub expires_at: i64,
}

impl FileRequestView {
    pub fn of(request: &FileRequest, now: i64) -> Self {
        Self {
            id: request.id.clone(),
            grant_id: request.grant_id.clone(),
            op: request.op,
            path: request.path.clone(),
            dest_path: request.dest_path.clone(),
            status: request.status_at(now),
            result: request.result.clone(),
            result_byte_length: request.result_object.as_ref().map(|o| o.byte_length),
            result_media_type: request.result_object.as_ref().map(|o| o.media_type.clone()),
            error: request.error.clone(),
            created_at: request.created_at,
            completed_at: request.completed_at,
            expires_at: request.expires_at,
        }
    }
}

/// What the host claims: enough to re-authorize the request on its side.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedRequest {
    pub id: String,
    pub grant_id: String,
    pub requester_user_id: String,
    pub requester_role: SessionRole,
    pub op: FileOp,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_byte_length: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_sha256: Option<String>,
    pub expires_at: i64,
}

impl ClaimedRequest {
    fn of(request: &FileRequest) -> Self {
        Self {
            id: request.id.clone(),
            grant_id: request.grant_id.clone(),
            requester_user_id: request.requester_user_id.clone(),
            requester_role: request.requester_role,
            op: request.op,
            path: request.path.clone(),
            dest_path: request.dest_path.clone(),
            upload_byte_length: request.upload.as_ref().map(|u| u.byte_length),
            upload_sha256: request.upload.as_ref().map(|u| u.sha256.clone()),
            expires_at: request.expires_at,
        }
    }
}

/// How the host answered.
#[derive(Debug, Clone, PartialEq)]
pub enum RequestOutcome {
    Done {
        result: Option<serde_json::Value>,
        object: Option<ResultObject>,
    },
    Failed {
        error: String,
    },
}

// ── Rules ────────────────────────────────────────────────────────────────────

fn role_rank(role: SessionRole) -> u8 {
    match role {
        SessionRole::Viewer => 0,
        SessionRole::Member => 1,
        SessionRole::Maintainer => 2,
        SessionRole::Owner => 3,
    }
}

/// A FileSpace path: absolute, `/`-separated, no empty, `.` or `..`
/// segments, no NUL. The host normalizes again with the full grammar.
pub fn valid_path(path: &str) -> bool {
    path.len() <= MAX_PATH_CHARS
        && path.starts_with('/')
        && !path.contains('\0')
        && !path.contains('\\')
        && (path == "/"
            || path[1..]
                .split('/')
                .all(|segment| !segment.is_empty() && segment != "." && segment != ".."))
}

fn within(path: &str, prefix: &str) -> bool {
    path == prefix
        || prefix == "/"
        || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

impl FileGrant {
    /// Whether the grant admits `user_id` holding `role` right now.
    pub fn admits(&self, user_id: &str, role: SessionRole, now: i64) -> bool {
        self.status == "active"
            && self.revoked_at.is_none()
            && self.expires_at > now
            && role_rank(role) >= role_rank(self.min_role)
            && self
                .user_ids
                .as_ref()
                .is_none_or(|users| users.iter().any(|user| user == user_id))
    }

    /// Whether `op` on `path` falls under the grant: inside a granted path,
    /// or — listing and metadata only — an ancestor that leads to one.
    pub fn reaches(&self, op: FileOp, path: &str) -> bool {
        if !self.permissions.iter().any(|p| p == op.needs()) {
            return false;
        }
        self.paths.iter().any(|granted| {
            let inside = if granted.is_dir {
                within(path, &granted.path)
            } else {
                path == granted.path
            };
            inside || (matches!(op, FileOp::List | FileOp::Stat) && within(&granted.path, path))
        })
    }
}

// ── Store ────────────────────────────────────────────────────────────────────

#[async_trait]
pub trait SessionFileStore: Send + Sync {
    /// Register (or replace) the conversation's host.
    async fn put_host(&self, host: FileHost) -> Result<FileHost, StoreError>;
    async fn host(&self, org_id: &str, session_id: &str) -> Result<Option<FileHost>, StoreError>;
    async fn touch_host(&self, org_id: &str, session_id: &str, now: i64) -> Result<(), StoreError>;
    /// Remove the host and revoke every mirrored grant; open requests expire.
    /// Returns the object keys the removal orphaned.
    async fn delete_host(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<String>, StoreError>;

    async fn put_grant(&self, grant: FileGrant) -> Result<FileGrant, StoreError>;
    async fn revoke_grant(
        &self,
        org_id: &str,
        session_id: &str,
        grant_id: &str,
        now: i64,
    ) -> Result<bool, StoreError>;
    async fn grants(&self, org_id: &str, session_id: &str) -> Result<Vec<FileGrant>, StoreError>;
    async fn grant(
        &self,
        org_id: &str,
        session_id: &str,
        grant_id: &str,
    ) -> Result<Option<FileGrant>, StoreError>;

    async fn create_request(&self, request: FileRequest) -> Result<FileRequest, StoreError>;
    async fn request(
        &self,
        org_id: &str,
        session_id: &str,
        request_id: &str,
    ) -> Result<Option<FileRequest>, StoreError>;
    /// The requests still waiting on someone.
    async fn open_requests(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<FileRequest>, StoreError>;
    /// A write's bytes arrived: `awaiting_upload` → `pending`.
    async fn mark_uploaded(
        &self,
        org_id: &str,
        session_id: &str,
        request_id: &str,
        now: i64,
    ) -> Result<FileRequest, StoreError>;
    /// Take the oldest pending request, giving the host until
    /// `now + REQUEST_WAIT_MS` to answer it — only while the host holding
    /// `host_token_hash` is still the registered one, so a replaced host's
    /// poll never takes the new one's requests.
    async fn claim_next(
        &self,
        org_id: &str,
        session_id: &str,
        host_token_hash: &str,
        now: i64,
    ) -> Result<Option<FileRequest>, StoreError>;
    async fn complete_request(
        &self,
        org_id: &str,
        session_id: &str,
        request_id: &str,
        outcome: RequestOutcome,
        now: i64,
    ) -> Result<FileRequest, StoreError>;
    /// Expire what is past its deadline and forget the object keys of answers
    /// past their retention. Returns the keys to delete from object storage.
    async fn reap_requests(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<String>, StoreError>;
    /// Every object key the conversation's requests hold (its deletion).
    async fn session_object_keys(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<String>, StoreError>;
}

fn not_found() -> StoreError {
    StoreError::NotFound
}

fn conflict(value: impl Serialize) -> StoreError {
    StoreError::Conflict(serde_json::to_value(value).unwrap_or(serde_json::Value::Null))
}

/// Apply `outcome` to a claimed request.
fn completed(
    mut request: FileRequest,
    outcome: RequestOutcome,
    now: i64,
) -> Result<FileRequest, StoreError> {
    if request.status != RequestStatus::Claimed || request.expires_at <= now {
        return Err(conflict(
            serde_json::json!({ "status": request.status_at(now) }),
        ));
    }
    match outcome {
        RequestOutcome::Done { result, object } => {
            request.status = RequestStatus::Done;
            request.result = result;
            request.result_object = object;
        }
        RequestOutcome::Failed { error } => {
            request.status = RequestStatus::Failed;
            request.error = Some(error);
        }
    }
    request.completed_at = Some(now);
    request.expires_at = now + RESULT_TTL_MS;
    Ok(request)
}

// ── In-memory ────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct InMemorySessionFileStore {
    hosts: RwLock<HashMap<(String, String), FileHost>>,
    /// Keyed by `(org_id, grant id)`: a host picks the id, unique per org.
    grants: RwLock<HashMap<(String, String), FileGrant>>,
    requests: RwLock<HashMap<String, FileRequest>>,
}

impl InMemorySessionFileStore {
    pub fn new() -> Self {
        Self::default()
    }
}

fn key(org_id: &str, session_id: &str) -> (String, String) {
    (org_id.to_owned(), session_id.to_owned())
}

#[async_trait]
impl SessionFileStore for InMemorySessionFileStore {
    async fn put_host(&self, host: FileHost) -> Result<FileHost, StoreError> {
        self.hosts
            .write()
            .insert(key(&host.org_id, &host.session_id), host.clone());
        Ok(host)
    }

    async fn host(&self, org_id: &str, session_id: &str) -> Result<Option<FileHost>, StoreError> {
        Ok(self.hosts.read().get(&key(org_id, session_id)).cloned())
    }

    async fn touch_host(&self, org_id: &str, session_id: &str, now: i64) -> Result<(), StoreError> {
        if let Some(host) = self.hosts.write().get_mut(&key(org_id, session_id)) {
            host.last_seen_at = Some(now);
        }
        Ok(())
    }

    async fn delete_host(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<String>, StoreError> {
        self.hosts.write().remove(&key(org_id, session_id));
        for grant in self.grants.write().values_mut() {
            if grant.org_id == org_id
                && grant.session_id == session_id
                && grant.revoked_at.is_none()
            {
                grant.status = "revoked".into();
                grant.revoked_at = Some(now);
                grant.updated_at = now;
            }
        }
        let mut keys = Vec::new();
        for request in self.requests.write().values_mut() {
            if request.org_id == org_id
                && request.session_id == session_id
                && request.status.is_open()
            {
                keys.extend(request.object_keys());
                request.upload = None;
                request.status = RequestStatus::Expired;
            }
        }
        Ok(keys)
    }

    async fn put_grant(&self, grant: FileGrant) -> Result<FileGrant, StoreError> {
        let mut grants = self.grants.write();
        let id = key(&grant.org_id, &grant.id);
        if let Some(existing) = grants.get(&id) {
            if existing.session_id != grant.session_id {
                return Err(not_found());
            }
            if existing.revoked_at.is_some() {
                return Err(conflict(existing));
            }
        }
        let mut stored = grant;
        if let Some(existing) = grants.get(&id) {
            stored.created_at = existing.created_at;
        }
        grants.insert(id, stored.clone());
        Ok(stored)
    }

    async fn revoke_grant(
        &self,
        org_id: &str,
        session_id: &str,
        grant_id: &str,
        now: i64,
    ) -> Result<bool, StoreError> {
        let mut grants = self.grants.write();
        match grants.get_mut(&key(org_id, grant_id)) {
            Some(grant) if grant.session_id == session_id => {
                if grant.revoked_at.is_some() {
                    return Ok(false);
                }
                grant.status = "revoked".into();
                grant.revoked_at = Some(now);
                grant.updated_at = now;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn grants(&self, org_id: &str, session_id: &str) -> Result<Vec<FileGrant>, StoreError> {
        let mut grants: Vec<FileGrant> = self
            .grants
            .read()
            .values()
            .filter(|grant| grant.org_id == org_id && grant.session_id == session_id)
            .cloned()
            .collect();
        grants.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(grants)
    }

    async fn grant(
        &self,
        org_id: &str,
        session_id: &str,
        grant_id: &str,
    ) -> Result<Option<FileGrant>, StoreError> {
        Ok(self
            .grants
            .read()
            .get(&key(org_id, grant_id))
            .filter(|grant| grant.session_id == session_id)
            .cloned())
    }

    async fn create_request(&self, request: FileRequest) -> Result<FileRequest, StoreError> {
        self.requests
            .write()
            .insert(request.id.clone(), request.clone());
        Ok(request)
    }

    async fn request(
        &self,
        org_id: &str,
        session_id: &str,
        request_id: &str,
    ) -> Result<Option<FileRequest>, StoreError> {
        Ok(self
            .requests
            .read()
            .get(request_id)
            .filter(|request| request.org_id == org_id && request.session_id == session_id)
            .cloned())
    }

    async fn open_requests(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<FileRequest>, StoreError> {
        Ok(self
            .requests
            .read()
            .values()
            .filter(|request| {
                request.org_id == org_id
                    && request.session_id == session_id
                    && request.status_at(now).is_open()
            })
            .cloned()
            .collect())
    }

    async fn mark_uploaded(
        &self,
        org_id: &str,
        session_id: &str,
        request_id: &str,
        now: i64,
    ) -> Result<FileRequest, StoreError> {
        let mut requests = self.requests.write();
        let request = requests
            .get_mut(request_id)
            .filter(|request| request.org_id == org_id && request.session_id == session_id)
            .ok_or_else(not_found)?;
        if request.status_at(now) != RequestStatus::AwaitingUpload {
            return Err(conflict(
                serde_json::json!({ "status": request.status_at(now) }),
            ));
        }
        request.status = RequestStatus::Pending;
        request.expires_at = now + REQUEST_WAIT_MS;
        Ok(request.clone())
    }

    async fn claim_next(
        &self,
        org_id: &str,
        session_id: &str,
        host_token_hash: &str,
        now: i64,
    ) -> Result<Option<FileRequest>, StoreError> {
        let hosts = self.hosts.read();
        let registered = hosts
            .get(&key(org_id, session_id))
            .is_some_and(|host| host.host_token_hash == host_token_hash);
        if !registered {
            return Ok(None);
        }
        let mut requests = self.requests.write();
        let next = requests
            .values_mut()
            .filter(|request| {
                request.org_id == org_id
                    && request.session_id == session_id
                    && request.status_at(now) == RequestStatus::Pending
            })
            .min_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.id.cmp(&b.id))
            });
        Ok(next.map(|request| {
            request.status = RequestStatus::Claimed;
            request.claimed_at = Some(now);
            request.expires_at = now + REQUEST_WAIT_MS;
            request.clone()
        }))
    }

    async fn complete_request(
        &self,
        org_id: &str,
        session_id: &str,
        request_id: &str,
        outcome: RequestOutcome,
        now: i64,
    ) -> Result<FileRequest, StoreError> {
        let mut requests = self.requests.write();
        let request = requests
            .get_mut(request_id)
            .filter(|request| request.org_id == org_id && request.session_id == session_id)
            .ok_or_else(not_found)?;
        let next = completed(request.clone(), outcome, now)?;
        *request = next.clone();
        Ok(next)
    }

    async fn reap_requests(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<String>, StoreError> {
        let mut keys = Vec::new();
        for request in self.requests.write().values_mut() {
            if request.org_id != org_id
                || request.session_id != session_id
                || request.expires_at > now
            {
                continue;
            }
            keys.extend(request.object_keys());
            request.upload = None;
            request.result_object = None;
            if request.status.is_open() {
                request.status = RequestStatus::Expired;
            }
        }
        Ok(keys)
    }

    async fn session_object_keys(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<String>, StoreError> {
        Ok(self
            .requests
            .read()
            .values()
            .filter(|request| request.org_id == org_id && request.session_id == session_id)
            .flat_map(FileRequest::object_keys)
            .collect())
    }
}

// ── Postgres ─────────────────────────────────────────────────────────────────

fn db(error: impl std::fmt::Display) -> StoreError {
    StoreError::Database(error.to_string())
}

const HOST_COLUMNS: &str = "org_id, workspace_id, session_id, registered_by, host_token_hash, \
                            host_label, registered_at, last_seen_at";

fn host_from_row(row: &tokio_postgres::Row) -> FileHost {
    FileHost {
        org_id: row.get("org_id"),
        workspace_id: row.get("workspace_id"),
        session_id: row.get("session_id"),
        registered_by: row.get("registered_by"),
        host_token_hash: row.get("host_token_hash"),
        host_label: row.get("host_label"),
        registered_at: row.get("registered_at"),
        last_seen_at: row.get("last_seen_at"),
    }
}

const GRANT_COLUMNS: &str = "id, org_id, workspace_id, session_id, label, user_ids, min_role, \
                             permissions, paths, status, expires_at, revoked_at, \
                             policy_revision, created_by, created_at, updated_at";

fn grant_from_row(row: &tokio_postgres::Row) -> Result<FileGrant, StoreError> {
    let min_role: String = row.get("min_role");
    let paths: serde_json::Value = row.get("paths");
    Ok(FileGrant {
        id: row.get("id"),
        org_id: row.get("org_id"),
        workspace_id: row.get("workspace_id"),
        session_id: row.get("session_id"),
        label: row.get("label"),
        user_ids: row.get("user_ids"),
        min_role: SessionRole::parse(&min_role)
            .ok_or_else(|| StoreError::Corrupt(format!("unknown role {min_role}")))?,
        permissions: row.get("permissions"),
        paths: serde_json::from_value(paths)
            .map_err(|error| StoreError::Corrupt(error.to_string()))?,
        status: row.get("status"),
        expires_at: row.get("expires_at"),
        revoked_at: row.get("revoked_at"),
        policy_revision: row.get("policy_revision"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

const REQUEST_COLUMNS: &str = "id, org_id, workspace_id, session_id, grant_id, requester_user_id, \
                               requester_role, op, path, dest_path, upload_byte_length, \
                               upload_sha256, upload_object_key, status, result, \
                               result_object_key, result_byte_length, result_media_type, error, \
                               created_at, claimed_at, completed_at, expires_at";

fn request_from_row(row: &tokio_postgres::Row) -> Result<FileRequest, StoreError> {
    let corrupt = |what: &str| StoreError::Corrupt(format!("unreadable file request {what}"));
    let role: String = row.get("requester_role");
    let op: String = row.get("op");
    let status: String = row.get("status");
    let upload_key: Option<String> = row.get("upload_object_key");
    let result_key: Option<String> = row.get("result_object_key");
    Ok(FileRequest {
        id: row.get("id"),
        org_id: row.get("org_id"),
        workspace_id: row.get("workspace_id"),
        session_id: row.get("session_id"),
        grant_id: row.get("grant_id"),
        requester_user_id: row.get("requester_user_id"),
        requester_role: SessionRole::parse(&role).ok_or_else(|| corrupt("role"))?,
        op: FileOp::parse(&op).ok_or_else(|| corrupt("op"))?,
        path: row.get("path"),
        dest_path: row.get("dest_path"),
        upload: match (row.get::<_, Option<i64>>("upload_byte_length"), upload_key) {
            (Some(byte_length), Some(object_key)) => Some(UploadSpec {
                byte_length,
                sha256: row
                    .get::<_, Option<String>>("upload_sha256")
                    .unwrap_or_default(),
                object_key,
            }),
            _ => None,
        },
        status: RequestStatus::parse(&status).ok_or_else(|| corrupt("status"))?,
        result: row.get("result"),
        result_object: result_key.map(|object_key| ResultObject {
            object_key,
            byte_length: row
                .get::<_, Option<i64>>("result_byte_length")
                .unwrap_or_default(),
            media_type: row
                .get::<_, Option<String>>("result_media_type")
                .unwrap_or_else(|| "application/octet-stream".into()),
        }),
        error: row.get("error"),
        created_at: row.get("created_at"),
        claimed_at: row.get("claimed_at"),
        completed_at: row.get("completed_at"),
        expires_at: row.get("expires_at"),
    })
}

#[async_trait]
impl SessionFileStore for PgStore {
    async fn put_host(&self, host: FileHost) -> Result<FileHost, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &host.org_id).await?;
        let row = tx
            .query_one(
                &format!(
                    "INSERT INTO session_file_hosts ({HOST_COLUMNS}) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL) \
                     ON CONFLICT (session_id) DO UPDATE SET \
                       registered_by = EXCLUDED.registered_by, \
                       host_token_hash = EXCLUDED.host_token_hash, \
                       host_label = EXCLUDED.host_label, \
                       registered_at = EXCLUDED.registered_at, \
                       last_seen_at = NULL \
                     RETURNING {HOST_COLUMNS}"
                ),
                &[
                    &host.org_id,
                    &host.workspace_id,
                    &host.session_id,
                    &host.registered_by,
                    &host.host_token_hash,
                    &host.host_label,
                    &host.registered_at,
                ],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(host_from_row(&row))
    }

    async fn host(&self, org_id: &str, session_id: &str) -> Result<Option<FileHost>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                &format!(
                    "SELECT {HOST_COLUMNS} FROM session_file_hosts \
                     WHERE org_id = $1 AND session_id = $2"
                ),
                &[&org_id, &session_id],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(row.as_ref().map(host_from_row))
    }

    async fn touch_host(&self, org_id: &str, session_id: &str, now: i64) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        tx.execute(
            "UPDATE session_file_hosts SET last_seen_at = $3 WHERE org_id = $1 AND session_id = $2",
            &[&org_id, &session_id, &now],
        )
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)
    }

    async fn delete_host(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<String>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        tx.execute(
            "DELETE FROM session_file_hosts WHERE org_id = $1 AND session_id = $2",
            &[&org_id, &session_id],
        )
        .await
        .map_err(db)?;
        tx.execute(
            "UPDATE session_file_grants SET status = 'revoked', revoked_at = $3, updated_at = $3 \
             WHERE org_id = $1 AND session_id = $2 AND revoked_at IS NULL",
            &[&org_id, &session_id, &now],
        )
        .await
        .map_err(db)?;
        let rows = tx
            .query(
                &format!(
                    "SELECT {REQUEST_COLUMNS} FROM host_file_requests \
                     WHERE org_id = $1 AND session_id = $2 \
                       AND status IN ('awaiting_upload', 'pending', 'claimed') FOR UPDATE"
                ),
                &[&org_id, &session_id],
            )
            .await
            .map_err(db)?;
        let mut keys = Vec::new();
        for row in &rows {
            keys.extend(request_from_row(row)?.object_keys());
        }
        tx.execute(
            "UPDATE host_file_requests SET status = 'expired', upload_object_key = NULL \
             WHERE org_id = $1 AND session_id = $2 \
               AND status IN ('awaiting_upload', 'pending', 'claimed')",
            &[&org_id, &session_id],
        )
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(keys)
    }

    async fn put_grant(&self, grant: FileGrant) -> Result<FileGrant, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &grant.org_id).await?;
        let existing = tx
            .query_opt(
                &format!(
                    "SELECT {GRANT_COLUMNS} FROM session_file_grants \
                     WHERE org_id = $1 AND id = $2 FOR UPDATE"
                ),
                &[&grant.org_id, &grant.id],
            )
            .await
            .map_err(db)?;
        if let Some(row) = &existing {
            let current = grant_from_row(row)?;
            if current.session_id != grant.session_id {
                tx.commit().await.map_err(db)?;
                return Err(not_found());
            }
            if current.revoked_at.is_some() {
                tx.commit().await.map_err(db)?;
                return Err(conflict(&current));
            }
        }
        let paths = serde_json::to_value(&grant.paths)
            .map_err(|error| StoreError::Corrupt(error.to_string()))?;
        let row = tx
            .query_one(
                &format!(
                    "INSERT INTO session_file_grants ({GRANT_COLUMNS}) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) \
                     ON CONFLICT (org_id, id) DO UPDATE SET \
                       label = EXCLUDED.label, user_ids = EXCLUDED.user_ids, \
                       min_role = EXCLUDED.min_role, permissions = EXCLUDED.permissions, \
                       paths = EXCLUDED.paths, status = EXCLUDED.status, \
                       expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at, \
                       policy_revision = EXCLUDED.policy_revision, \
                       updated_at = EXCLUDED.updated_at \
                     RETURNING {GRANT_COLUMNS}"
                ),
                &[
                    &grant.id,
                    &grant.org_id,
                    &grant.workspace_id,
                    &grant.session_id,
                    &grant.label,
                    &grant.user_ids,
                    &grant.min_role.as_str(),
                    &grant.permissions,
                    &paths,
                    &grant.status,
                    &grant.expires_at,
                    &grant.revoked_at,
                    &grant.policy_revision,
                    &grant.created_by,
                    &grant.created_at,
                    &grant.updated_at,
                ],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        grant_from_row(&row)
    }

    async fn revoke_grant(
        &self,
        org_id: &str,
        session_id: &str,
        grant_id: &str,
        now: i64,
    ) -> Result<bool, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let changed = tx
            .execute(
                "UPDATE session_file_grants SET status = 'revoked', revoked_at = $4, updated_at = $4 \
                 WHERE org_id = $1 AND session_id = $2 AND id = $3 AND revoked_at IS NULL",
                &[&org_id, &session_id, &grant_id, &now],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(changed > 0)
    }

    async fn grants(&self, org_id: &str, session_id: &str) -> Result<Vec<FileGrant>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                &format!(
                    "SELECT {GRANT_COLUMNS} FROM session_file_grants \
                     WHERE org_id = $1 AND session_id = $2 ORDER BY created_at DESC, id"
                ),
                &[&org_id, &session_id],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        rows.iter().map(grant_from_row).collect()
    }

    async fn grant(
        &self,
        org_id: &str,
        session_id: &str,
        grant_id: &str,
    ) -> Result<Option<FileGrant>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                &format!(
                    "SELECT {GRANT_COLUMNS} FROM session_file_grants \
                     WHERE org_id = $1 AND session_id = $2 AND id = $3"
                ),
                &[&org_id, &session_id, &grant_id],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        row.as_ref().map(grant_from_row).transpose()
    }

    async fn create_request(&self, request: FileRequest) -> Result<FileRequest, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &request.org_id).await?;
        let row = tx
            .query_one(
                &format!(
                    "INSERT INTO host_file_requests ({REQUEST_COLUMNS}) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, \
                             NULL, NULL, NULL, NULL, $15, NULL, NULL, $16) \
                     RETURNING {REQUEST_COLUMNS}"
                ),
                &[
                    &request.id,
                    &request.org_id,
                    &request.workspace_id,
                    &request.session_id,
                    &request.grant_id,
                    &request.requester_user_id,
                    &request.requester_role.as_str(),
                    &request.op.as_str(),
                    &request.path,
                    &request.dest_path,
                    &request.upload.as_ref().map(|u| u.byte_length),
                    &request.upload.as_ref().map(|u| u.sha256.clone()),
                    &request.upload.as_ref().map(|u| u.object_key.clone()),
                    &request.status.as_str(),
                    &request.created_at,
                    &request.expires_at,
                ],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        request_from_row(&row)
    }

    async fn request(
        &self,
        org_id: &str,
        session_id: &str,
        request_id: &str,
    ) -> Result<Option<FileRequest>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                &format!(
                    "SELECT {REQUEST_COLUMNS} FROM host_file_requests \
                     WHERE org_id = $1 AND session_id = $2 AND id = $3"
                ),
                &[&org_id, &session_id, &request_id],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        row.as_ref().map(request_from_row).transpose()
    }

    async fn open_requests(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<FileRequest>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                &format!(
                    "SELECT {REQUEST_COLUMNS} FROM host_file_requests \
                     WHERE org_id = $1 AND session_id = $2 \
                       AND status IN ('awaiting_upload', 'pending', 'claimed') AND expires_at > $3"
                ),
                &[&org_id, &session_id, &now],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        rows.iter().map(request_from_row).collect()
    }

    async fn mark_uploaded(
        &self,
        org_id: &str,
        session_id: &str,
        request_id: &str,
        now: i64,
    ) -> Result<FileRequest, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                &format!(
                    "UPDATE host_file_requests SET status = 'pending', expires_at = $4 \
                     WHERE org_id = $1 AND session_id = $2 AND id = $3 \
                       AND status = 'awaiting_upload' AND expires_at > $5 \
                     RETURNING {REQUEST_COLUMNS}"
                ),
                &[
                    &org_id,
                    &session_id,
                    &request_id,
                    &(now + REQUEST_WAIT_MS),
                    &now,
                ],
            )
            .await
            .map_err(db)?;
        let Some(row) = row else {
            let current = tx
                .query_opt(
                    &format!(
                        "SELECT {REQUEST_COLUMNS} FROM host_file_requests \
                         WHERE org_id = $1 AND session_id = $2 AND id = $3"
                    ),
                    &[&org_id, &session_id, &request_id],
                )
                .await
                .map_err(db)?;
            tx.commit().await.map_err(db)?;
            return match current {
                None => Err(not_found()),
                Some(row) => {
                    let current = request_from_row(&row)?;
                    Err(conflict(
                        serde_json::json!({ "status": current.status_at(now) }),
                    ))
                }
            };
        };
        tx.commit().await.map_err(db)?;
        request_from_row(&row)
    }

    async fn claim_next(
        &self,
        org_id: &str,
        session_id: &str,
        host_token_hash: &str,
        now: i64,
    ) -> Result<Option<FileRequest>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        // SKIP LOCKED: two replicas answering one host's polls never hand out
        // the same request twice.
        let row = tx
            .query_opt(
                &format!(
                    "UPDATE host_file_requests SET status = 'claimed', claimed_at = $3, expires_at = $4 \
                     WHERE id = (SELECT id FROM host_file_requests \
                                 WHERE org_id = $1 AND session_id = $2 AND status = 'pending' \
                                   AND expires_at > $3 \
                                   AND EXISTS (SELECT 1 FROM session_file_hosts h \
                                               WHERE h.org_id = $1 AND h.session_id = $2 \
                                                 AND h.host_token_hash = $5) \
                                 ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) \
                     RETURNING {REQUEST_COLUMNS}"
                ),
                &[&org_id, &session_id, &now, &(now + REQUEST_WAIT_MS), &host_token_hash],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        row.as_ref().map(request_from_row).transpose()
    }

    async fn complete_request(
        &self,
        org_id: &str,
        session_id: &str,
        request_id: &str,
        outcome: RequestOutcome,
        now: i64,
    ) -> Result<FileRequest, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                &format!(
                    "SELECT {REQUEST_COLUMNS} FROM host_file_requests \
                     WHERE org_id = $1 AND session_id = $2 AND id = $3 FOR UPDATE"
                ),
                &[&org_id, &session_id, &request_id],
            )
            .await
            .map_err(db)?;
        let Some(row) = row else {
            tx.commit().await.map_err(db)?;
            return Err(not_found());
        };
        let next = match completed(request_from_row(&row)?, outcome, now) {
            Ok(next) => next,
            Err(error) => {
                tx.commit().await.map_err(db)?;
                return Err(error);
            }
        };
        let row = tx
            .query_one(
                &format!(
                    "UPDATE host_file_requests SET status = $4, result = $5, result_object_key = $6, \
                       result_byte_length = $7, result_media_type = $8, error = $9, \
                       completed_at = $10, expires_at = $11 \
                     WHERE org_id = $1 AND session_id = $2 AND id = $3 \
                     RETURNING {REQUEST_COLUMNS}"
                ),
                &[
                    &org_id,
                    &session_id,
                    &request_id,
                    &next.status.as_str(),
                    &next.result,
                    &next.result_object.as_ref().map(|o| o.object_key.clone()),
                    &next.result_object.as_ref().map(|o| o.byte_length),
                    &next.result_object.as_ref().map(|o| o.media_type.clone()),
                    &next.error,
                    &next.completed_at,
                    &next.expires_at,
                ],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        request_from_row(&row)
    }

    async fn reap_requests(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<String>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                &format!(
                    "SELECT {REQUEST_COLUMNS} FROM host_file_requests \
                     WHERE org_id = $1 AND session_id = $2 AND expires_at <= $3 \
                       AND (status IN ('awaiting_upload', 'pending', 'claimed') \
                            OR upload_object_key IS NOT NULL OR result_object_key IS NOT NULL) \
                     FOR UPDATE SKIP LOCKED"
                ),
                &[&org_id, &session_id, &now],
            )
            .await
            .map_err(db)?;
        let mut keys = Vec::new();
        let mut ids = Vec::new();
        for row in &rows {
            let request = request_from_row(row)?;
            keys.extend(request.object_keys());
            ids.push(request.id);
        }
        if !ids.is_empty() {
            tx.execute(
                "UPDATE host_file_requests SET \
                   status = CASE WHEN status IN ('awaiting_upload', 'pending', 'claimed') \
                                 THEN 'expired' ELSE status END, \
                   upload_object_key = NULL, result_object_key = NULL \
                 WHERE org_id = $1 AND session_id = $2 AND id = ANY($3)",
                &[&org_id, &session_id, &ids],
            )
            .await
            .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(keys)
    }

    async fn session_object_keys(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<String>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                &format!(
                    "SELECT {REQUEST_COLUMNS} FROM host_file_requests \
                     WHERE org_id = $1 AND session_id = $2 \
                       AND (upload_object_key IS NOT NULL OR result_object_key IS NOT NULL)"
                ),
                &[&org_id, &session_id],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        let mut keys = Vec::new();
        for row in &rows {
            keys.extend(request_from_row(row)?.object_keys());
        }
        Ok(keys)
    }
}

// ── Wake-ups ─────────────────────────────────────────────────────────────────

/// Wakes a host's waiting claim when a request becomes claimable. Local to
/// this replica: a claim also re-reads the store every second, so a request
/// made on another replica is picked up within that.
#[derive(Default)]
pub struct SessionFilesHub {
    notifies: Mutex<HashMap<String, Arc<Notify>>>,
}

impl SessionFilesHub {
    fn notify_for(&self, session_id: &str) -> Arc<Notify> {
        self.notifies
            .lock()
            .entry(session_id.to_owned())
            .or_default()
            .clone()
    }

    pub fn wake(&self, session_id: &str) {
        if let Some(notify) = self.notifies.lock().get(session_id) {
            notify.notify_waiters();
        }
    }

    pub fn forget(&self, session_id: &str) {
        if let Some(notify) = self.notifies.lock().remove(session_id) {
            notify.notify_waiters();
        }
    }
}

// ── Routes ───────────────────────────────────────────────────────────────────

pub fn routes() -> Router<AppState> {
    let base = "/v1/orgs/{org_id}/chat-sessions/{session_id}";
    Router::new()
        .route(
            &format!("{base}/file-host"),
            get(get_host).put(register_host).delete(unregister_host),
        )
        .route(&format!("{base}/file-host/claim"), post(claim))
        .route(
            &format!("{base}/file-host/grants/{{grant_id}}"),
            put(mirror_grant).delete(revoke_mirrored_grant),
        )
        .route(
            &format!("{base}/file-host/requests/{{request_id}}/upload"),
            get(host_download_upload),
        )
        .route(
            &format!("{base}/file-host/requests/{{request_id}}/result"),
            put(host_store_result),
        )
        .route(
            &format!("{base}/file-host/requests/{{request_id}}/complete"),
            post(host_complete),
        )
        .route(&format!("{base}/file-grants"), get(list_member_grants))
        .route(&format!("{base}/file-requests"), post(create_request))
        .route(
            &format!("{base}/file-requests/{{request_id}}"),
            get(get_request),
        )
        .route(
            &format!("{base}/file-requests/{{request_id}}/upload"),
            put(upload_request_bytes),
        )
        .route(
            &format!("{base}/file-requests/{{request_id}}/result"),
            get(download_result),
        )
        .layer(DefaultBodyLimit::max(MAX_ATTACHMENT_BYTES as usize))
}

fn request_id_header(headers: &HeaderMap) -> String {
    headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("req_{}", Uuid::new_v4().simple()))
}

/// One audit row of this module: who did what to which conversation's files.
struct AuditEntry<'a> {
    org_id: &'a str,
    workspace_id: &'a str,
    session_id: &'a str,
    actor_user_id: &'a str,
    action: &'a str,
    reason: &'a str,
    extra: serde_json::Value,
}

async fn audit(
    state: &AppState,
    headers: &HeaderMap,
    entry: AuditEntry<'_>,
) -> Result<(), ChatFailure> {
    let AuditEntry {
        org_id,
        workspace_id,
        session_id,
        actor_user_id,
        action,
        reason,
        extra,
    } = entry;
    let mut source = serde_json::json!({
        "resourceType": "chat_session_files",
        "resourceId": session_id,
        "allowed": true,
    });
    if let (Some(source), Some(extra)) = (source.as_object_mut(), extra.as_object()) {
        source.extend(extra.clone());
    }
    state
        .store
        .append_authorization_audit(AuthorizationAuditEvent {
            id: format!("aud_{}", Uuid::new_v4().simple()),
            org_id: org_id.to_owned(),
            workspace_id: Some(workspace_id.to_owned()),
            actor_user_id: actor_user_id.to_owned(),
            target_user_id: None,
            invitation_id: None,
            action: action.to_owned(),
            old_role: None,
            new_role: None,
            reason: reason.to_owned(),
            request_id: request_id_header(headers),
            grant_id: None,
            source,
            created_at: (state.now)(),
        })
        .await
        .map_err(ChatFailure::Store)
}

fn policy_refusal(reason: &str) -> ChatFailure {
    ChatFailure::Store(StoreError::Policy(reason.to_owned()))
}

/// Delete objects whose rows let go of them. A failure leaves an orphan the
/// conversation's deletion still removes, so it is logged, not raised.
async fn drop_objects(state: &AppState, keys: Vec<String>) {
    for key in keys {
        if let Err(error) = state.chat_attachments.delete(&key).await {
            tracing::warn!(%key, %error, "file request object deletion failed");
        }
    }
}

async fn reap(state: &AppState, org_id: &str, session_id: &str) -> Result<(), ChatFailure> {
    let keys = state
        .session_files_store
        .reap_requests(org_id, session_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?;
    drop_objects(state, keys).await;
    Ok(())
}

fn object_key(
    org_id: &str,
    workspace_id: &str,
    session_id: &str,
    request_id: &str,
    kind: &str,
) -> String {
    format!("{org_id}/{workspace_id}/{session_id}/file-requests/{request_id}/{kind}")
}

// ── Host registration (members holding files.share) ─────────────────────────

async fn get_host(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<FileHostView>, ChatFailure> {
    visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::FilesReadLive,
    )
    .await?;
    let host = state
        .session_files_store
        .host(&org_id, &session_id)
        .await
        .map_err(ChatFailure::Store)?;
    Ok(Json(FileHostView::of(host.as_ref(), (state.now)())))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisterHostBody {
    host_label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredHost {
    /// Shown once; the server keeps only its SHA-256.
    host_token: String,
    host: FileHostView,
}

async fn register_host(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<RegisterHostBody>,
) -> Result<(StatusCode, Json<RegisteredHost>), ChatFailure> {
    let (session, member) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::FilesShare,
    )
    .await?;
    if session.status != SessionStatus::Active {
        return Err(ChatFailure::Gone);
    }
    let label = body.host_label.trim();
    if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS {
        return Err(ChatFailure::BadRequest(format!(
            "hostLabel must be 1 to {MAX_LABEL_CHARS} characters"
        )));
    }
    let policy = crate::file_sharing::effective_policy(state.file_sharing_store.as_ref(), &org_id)
        .await
        .map_err(ChatFailure::Store)?;
    if !policy.settings.allow_live_grants {
        return Err(policy_refusal("org_file_sharing_policy"));
    }
    let mut bytes = [0_u8; 32];
    rand::fill(&mut bytes);
    let token = format!("fht_{}", hex::encode(bytes));
    let now = (state.now)();
    // A replaced host's open requests are not the new host's to answer.
    let orphaned = state
        .session_files_store
        .delete_host(&org_id, &session_id, now)
        .await
        .map_err(ChatFailure::Store)?;
    drop_objects(&state, orphaned).await;
    let host = state
        .session_files_store
        .put_host(FileHost {
            org_id: org_id.clone(),
            workspace_id: session.workspace_id.clone(),
            session_id: session_id.clone(),
            registered_by: member.user_id.clone(),
            host_token_hash: token_hash(&token),
            host_label: label.to_owned(),
            registered_at: now,
            last_seen_at: None,
        })
        .await
        .map_err(ChatFailure::Store)?;
    state.session_files_hub.forget(&session_id);
    audit(
        &state,
        &headers,
        AuditEntry {
            org_id: &org_id,
            workspace_id: &session.workspace_id,
            session_id: &session_id,
            actor_user_id: &member.user_id,
            action: "files.host.register",
            reason: "files_share",
            extra: serde_json::json!({ "hostLabel": label }),
        },
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(RegisteredHost {
            host_token: token,
            host: FileHostView::of(Some(&host), now),
        }),
    ))
}

/// A member holding `files.share` removes the host, or the host removes itself
/// with its token (its conversation was deleted there).
async fn unregister_host(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ChatFailure> {
    let (workspace_id, actor) = if headers.contains_key(HOST_TOKEN_HEADER) {
        let host = authenticate_host(&state, &headers, &org_id, &session_id).await?;
        (host.workspace_id, host.registered_by)
    } else {
        let (session, member) = visible(
            &state,
            &headers,
            &org_id,
            &session_id,
            SessionAction::FilesShare,
        )
        .await?;
        (session.workspace_id, member.user_id)
    };
    let orphaned = state
        .session_files_store
        .delete_host(&org_id, &session_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?;
    drop_objects(&state, orphaned).await;
    state.session_files_hub.forget(&session_id);
    audit(
        &state,
        &headers,
        AuditEntry {
            org_id: &org_id,
            workspace_id: &workspace_id,
            session_id: &session_id,
            actor_user_id: &actor,
            action: "files.host.unregister",
            reason: "files_share",
            extra: serde_json::json!({}),
        },
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ── Host-authenticated calls ─────────────────────────────────────────────────

/// The registered host behind a host token, re-checking that the conversation
/// is live and its registrant still may share its files. A registrant who
/// lost `files.share` takes the host with them.
async fn authenticate_host(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
    session_id: &str,
) -> Result<FileHost, ChatFailure> {
    crate::chat_api::require_shared_chat_protocol(headers)?;
    let token = headers
        .get(HOST_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(ChatFailure::Unauthorized)?;
    let host = state
        .session_files_store
        .host(org_id, session_id)
        .await
        .map_err(ChatFailure::Store)?
        .ok_or(ChatFailure::Unauthorized)?;
    let presented = token_hash(token);
    if !constant_time_eq(presented.as_bytes(), host.host_token_hash.as_bytes()) {
        return Err(ChatFailure::Unauthorized);
    }
    let pair = state
        .chat_store
        .visible_session(org_id, session_id, &host.registered_by)
        .await
        .map_err(ChatFailure::Store)?;
    let allowed = pair.as_ref().is_some_and(|(session, membership)| {
        session.status == SessionStatus::Active
            && authorize_session_action(
                Some(membership),
                SessionAction::FilesShare,
                session.policy_revision,
            )
            .allowed
    });
    if !allowed {
        let now = (state.now)();
        let orphaned = state
            .session_files_store
            .delete_host(org_id, session_id, now)
            .await
            .map_err(ChatFailure::Store)?;
        drop_objects(state, orphaned).await;
        state.session_files_hub.forget(session_id);
        return Err(ChatFailure::Forbidden);
    }
    state
        .session_files_store
        .touch_host(org_id, session_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?;
    Ok(host)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0_u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MirrorGrantBody {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    user_ids: Option<Vec<String>>,
    min_role: SessionRole,
    permissions: Vec<String>,
    paths: Vec<GrantPath>,
    status: String,
    expires_at: i64,
    created_at: i64,
}

const GRANT_STATUSES: [&str; 5] = ["active", "suspended", "stale", "expired", "revoked"];

async fn mirror_grant(
    State(state): State<AppState>,
    Path((org_id, session_id, grant_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<MirrorGrantBody>,
) -> Result<Json<FileGrant>, ChatFailure> {
    let host = authenticate_host(&state, &headers, &org_id, &session_id).await?;
    if grant_id.is_empty() || grant_id.len() > 64 || !grant_id.starts_with("fg_") {
        return Err(ChatFailure::BadRequest("not a grant id".into()));
    }
    if !GRANT_STATUSES.contains(&body.status.as_str()) {
        return Err(ChatFailure::BadRequest("unknown grant status".into()));
    }
    if body.paths.is_empty()
        || body.paths.len() > MAX_GRANT_PATHS
        || body.paths.iter().any(|path| !valid_path(&path.path))
    {
        return Err(ChatFailure::BadRequest(format!(
            "paths must hold 1 to {MAX_GRANT_PATHS} FileSpace paths"
        )));
    }
    if !body.permissions.iter().any(|p| p == "read")
        || body
            .permissions
            .iter()
            .any(|p| !matches!(p.as_str(), "read" | "download" | "write"))
    {
        return Err(ChatFailure::BadRequest(
            "permissions hold read and may add download and write".into(),
        ));
    }
    if body
        .user_ids
        .as_ref()
        .is_some_and(|users| users.is_empty() || users.len() > 200)
    {
        return Err(ChatFailure::BadRequest(
            "userIds names 1 to 200 members, or is omitted".into(),
        ));
    }
    let label = body
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(|label| label.chars().take(MAX_LABEL_CHARS).collect::<String>());
    // The org's ceiling applies here too, whatever the host believed.
    let policy = crate::file_sharing::effective_policy(state.file_sharing_store.as_ref(), &org_id)
        .await
        .map_err(ChatFailure::Store)?;
    let active = body.status == "active";
    if active {
        if !policy.settings.allow_live_grants {
            return Err(policy_refusal("org_file_sharing_policy"));
        }
        if body.permissions.iter().any(|p| p == "write") && !policy.settings.allow_live_write {
            return Err(policy_refusal("org_file_sharing_policy_write"));
        }
        // Measured from this server's clock, not only the host's word: a
        // `createdAt` in the future must not stretch the lifetime.
        let start = body.created_at.min((state.now)());
        if body.expires_at - start > policy.settings.max_live_ttl_seconds * 1000 {
            return Err(policy_refusal("org_file_sharing_policy_ttl"));
        }
    }
    let now = (state.now)();
    let grant = state
        .session_files_store
        .put_grant(FileGrant {
            id: grant_id.clone(),
            org_id: org_id.clone(),
            workspace_id: host.workspace_id.clone(),
            session_id: session_id.clone(),
            label,
            user_ids: body.user_ids,
            min_role: body.min_role,
            permissions: body.permissions,
            paths: body.paths,
            status: body.status.clone(),
            expires_at: body.expires_at,
            revoked_at: (body.status == "revoked").then_some(now),
            policy_revision: policy.revision,
            created_by: host.registered_by.clone(),
            created_at: body.created_at,
            updated_at: now,
        })
        .await
        .map_err(ChatFailure::Store)?;
    audit(
        &state,
        &headers,
        AuditEntry {
            org_id: &org_id,
            workspace_id: &host.workspace_id,
            session_id: &session_id,
            actor_user_id: &host.registered_by,
            action: "files.grant.mirror",
            reason: "file_host",
            extra: serde_json::json!({ "fileGrantId": grant.id, "status": grant.status }),
        },
    )
    .await?;
    Ok(Json(grant))
}

async fn revoke_mirrored_grant(
    State(state): State<AppState>,
    Path((org_id, session_id, grant_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ChatFailure> {
    let host = authenticate_host(&state, &headers, &org_id, &session_id).await?;
    let changed = state
        .session_files_store
        .revoke_grant(&org_id, &session_id, &grant_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?;
    if changed {
        audit(
            &state,
            &headers,
            AuditEntry {
                org_id: &org_id,
                workspace_id: &host.workspace_id,
                session_id: &session_id,
                actor_user_id: &host.registered_by,
                action: "files.grant.revoke",
                reason: "file_host",
                extra: serde_json::json!({ "fileGrantId": grant_id }),
            },
        )
        .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimQuery {
    #[serde(default)]
    wait_ms: Option<u64>,
}

/// Long-poll for the next request: answers at once when one is waiting, or
/// `204 No Content` after `waitMs` (at most 25 s) without one.
async fn claim(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    Query(query): Query<ClaimQuery>,
    headers: HeaderMap,
) -> Result<Response, ChatFailure> {
    let host = authenticate_host(&state, &headers, &org_id, &session_id).await?;
    let wait = Duration::from_millis(
        query
            .wait_ms
            .unwrap_or(MAX_CLAIM_WAIT_MS)
            .min(MAX_CLAIM_WAIT_MS),
    );
    let deadline = tokio::time::Instant::now() + wait;
    let notify = state.session_files_hub.notify_for(&session_id);
    let mut last_seen_at = host.last_seen_at;
    loop {
        // Registered before the read, so a request made in between still wakes it.
        let woken = notify.notified();
        reap(&state, &org_id, &session_id).await?;
        if let Some(request) = state
            .session_files_store
            .claim_next(&org_id, &session_id, &host.host_token_hash, (state.now)())
            .await
            .map_err(ChatFailure::Store)?
        {
            return Ok(Json(ClaimedRequest::of(&request)).into_response());
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        let slice = (deadline - now).min(Duration::from_secs(1));
        let _ = tokio::time::timeout(slice, woken).await;
        // A host replaced or removed while it waited stops here, rather than
        // keep polling under a registration that is no longer its own.
        let current = state
            .session_files_store
            .host(&org_id, &session_id)
            .await
            .map_err(ChatFailure::Store)?
            .filter(|current| {
                constant_time_eq(
                    current.host_token_hash.as_bytes(),
                    host.host_token_hash.as_bytes(),
                )
            })
            .ok_or(ChatFailure::Unauthorized)?;
        // The host is still listening: keep it marked online, without a
        // write on every pass.
        let at = (state.now)();
        let seen = current.last_seen_at.max(last_seen_at);
        if seen.is_none_or(|seen| at - seen >= TOUCH_INTERVAL_MS) {
            state
                .session_files_store
                .touch_host(&org_id, &session_id, at)
                .await
                .map_err(ChatFailure::Store)?;
            last_seen_at = Some(at);
        }
    }
}

async fn claimed_request(
    state: &AppState,
    org_id: &str,
    session_id: &str,
    request_id: &str,
) -> Result<FileRequest, ChatFailure> {
    let request = state
        .session_files_store
        .request(org_id, session_id, request_id)
        .await
        .map_err(ChatFailure::Store)?
        .ok_or(ChatFailure::Hidden)?;
    if request.status_at((state.now)()) != RequestStatus::Claimed {
        return Err(ChatFailure::Gone);
    }
    Ok(request)
}

async fn host_download_upload(
    State(state): State<AppState>,
    Path((org_id, session_id, request_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ChatFailure> {
    authenticate_host(&state, &headers, &org_id, &session_id).await?;
    let request = claimed_request(&state, &org_id, &session_id, &request_id).await?;
    let upload = request.upload.ok_or(ChatFailure::Hidden)?;
    let bytes = state
        .chat_attachments
        .get(&upload.object_key)
        .await
        .map_err(|_| ChatFailure::ObjectStore)?;
    let mut response = bytes.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok(response)
}

async fn host_store_result(
    State(state): State<AppState>,
    Path((org_id, session_id, request_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ChatFailure> {
    authenticate_host(&state, &headers, &org_id, &session_id).await?;
    let request = claimed_request(&state, &org_id, &session_id, &request_id).await?;
    if request.op != FileOp::Read {
        return Err(ChatFailure::BadRequest(
            "only a read answers with bytes".into(),
        ));
    }
    let key = object_key(
        &org_id,
        &request.workspace_id,
        &session_id,
        &request_id,
        "result",
    );
    state
        .chat_attachments
        .put(&key, body)
        .await
        .map_err(|_| ChatFailure::ObjectStore)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteBody {
    ok: bool,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
    /// A read whose bytes were stored with `PUT …/result`.
    #[serde(default)]
    object: Option<CompleteObject>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteObject {
    byte_length: i64,
    media_type: String,
}

async fn host_complete(
    State(state): State<AppState>,
    Path((org_id, session_id, request_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<CompleteBody>,
) -> Result<StatusCode, ChatFailure> {
    authenticate_host(&state, &headers, &org_id, &session_id).await?;
    let request = claimed_request(&state, &org_id, &session_id, &request_id).await?;
    let outcome = if body.ok {
        if let Some(result) = &body.result {
            if serde_json::to_vec(result)
                .map(|bytes| bytes.len())
                .unwrap_or(usize::MAX)
                > MAX_RESULT_JSON_BYTES
            {
                return Err(ChatFailure::BadRequest("the answer is too large".into()));
            }
        }
        let object = match body.object {
            None => None,
            Some(object) => {
                let key = object_key(
                    &org_id,
                    &request.workspace_id,
                    &session_id,
                    &request_id,
                    "result",
                );
                // The stored bytes must be the ones the answer describes.
                let stored = state.chat_attachments.get(&key).await.map_err(|_| {
                    ChatFailure::BadRequest("the result bytes were not stored".into())
                })?;
                if stored.len() as i64 != object.byte_length {
                    return Err(ChatFailure::BadRequest(
                        "the result bytes do not match".into(),
                    ));
                }
                let media_type = object.media_type.trim();
                Some(ResultObject {
                    object_key: key,
                    byte_length: object.byte_length,
                    media_type: if media_type.is_empty() || media_type.len() > 255 {
                        "application/octet-stream".into()
                    } else {
                        media_type.to_owned()
                    },
                })
            }
        };
        if request.op == FileOp::Read && object.is_none() {
            return Err(ChatFailure::BadRequest(
                "a read answers with its bytes".into(),
            ));
        }
        RequestOutcome::Done {
            result: body.result,
            object,
        }
    } else {
        let error = body
            .error
            .as_deref()
            .map(str::trim)
            .filter(|error| !error.is_empty())
            .unwrap_or("the host could not do this")
            .chars()
            .take(500)
            .collect();
        RequestOutcome::Failed { error }
    };
    let completed = state
        .session_files_store
        .complete_request(&org_id, &session_id, &request_id, outcome, (state.now)())
        .await
        .map_err(ChatFailure::Store)?;
    // A write's bytes are spent once the host answered.
    if let Some(upload) = completed.upload.as_ref() {
        drop_objects(&state, vec![upload.object_key.clone()]).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

// ── Members ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberGrants {
    host: FileHostView,
    grants: Vec<FileGrant>,
}

/// The grants that admit the caller now, with the host's state.
async fn list_member_grants(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<MemberGrants>, ChatFailure> {
    let (_, member) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::FilesReadLive,
    )
    .await?;
    let now = (state.now)();
    let host = state
        .session_files_store
        .host(&org_id, &session_id)
        .await
        .map_err(ChatFailure::Store)?;
    let grants = if host.is_some() {
        state
            .session_files_store
            .grants(&org_id, &session_id)
            .await
            .map_err(ChatFailure::Store)?
            .into_iter()
            .filter(|grant| grant.admits(&member.user_id, member.role, now))
            // Who else a grant names is not this member's business.
            .map(|grant| FileGrant {
                user_ids: None,
                ..grant
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Json(MemberGrants {
        host: FileHostView::of(host.as_ref(), now),
        grants,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequestBody {
    grant_id: String,
    op: FileOp,
    path: String,
    #[serde(default)]
    dest_path: Option<String>,
    #[serde(default)]
    upload: Option<UploadBody>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadBody {
    byte_length: i64,
    sha256: String,
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn create_request(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateRequestBody>,
) -> Result<(StatusCode, Json<FileRequestView>), ChatFailure> {
    let action = if body.op.changes() {
        SessionAction::FilesWriteLive
    } else {
        SessionAction::FilesReadLive
    };
    let (session, member) = visible(&state, &headers, &org_id, &session_id, action).await?;
    if session.status != SessionStatus::Active {
        return Err(ChatFailure::Gone);
    }
    if !valid_path(&body.path) {
        return Err(ChatFailure::BadRequest(
            "path is not a FileSpace path".into(),
        ));
    }
    match (body.op, body.dest_path.as_deref()) {
        (FileOp::Rename, Some(dest)) if valid_path(dest) => {}
        (FileOp::Rename, _) => {
            return Err(ChatFailure::BadRequest("a rename names a destPath".into()))
        }
        (_, Some(_)) => {
            return Err(ChatFailure::BadRequest(
                "only a rename names a destPath".into(),
            ))
        }
        _ => {}
    }
    match (body.op, &body.upload) {
        (FileOp::Write, Some(upload))
            if (0..=MAX_ATTACHMENT_BYTES).contains(&upload.byte_length)
                && valid_sha256(&upload.sha256) => {}
        (FileOp::Write, _) => {
            return Err(ChatFailure::BadRequest(
                "a write declares its upload's byteLength and sha256".into(),
            ))
        }
        (_, Some(_)) => return Err(ChatFailure::BadRequest("only a write uploads bytes".into())),
        _ => {}
    }
    let policy = crate::file_sharing::effective_policy(state.file_sharing_store.as_ref(), &org_id)
        .await
        .map_err(ChatFailure::Store)?;
    if !policy.settings.allow_live_grants
        || (body.op.changes() && !policy.settings.allow_live_write)
    {
        return Err(policy_refusal("org_file_sharing_policy"));
    }
    let now = (state.now)();
    if state
        .session_files_store
        .host(&org_id, &session_id)
        .await
        .map_err(ChatFailure::Store)?
        .is_none()
    {
        return Err(policy_refusal("no_file_host"));
    }
    let grant = state
        .session_files_store
        .grant(&org_id, &session_id, &body.grant_id)
        .await
        .map_err(ChatFailure::Store)?
        .filter(|grant| grant.admits(&member.user_id, member.role, now))
        .ok_or(ChatFailure::Hidden)?;
    let reaches = grant.reaches(body.op, &body.path)
        && body
            .dest_path
            .as_deref()
            .is_none_or(|dest| grant.reaches(body.op, dest));
    if !reaches {
        return Err(ChatFailure::Forbidden);
    }
    reap(&state, &org_id, &session_id).await?;
    let open = state
        .session_files_store
        .open_requests(&org_id, &session_id, now)
        .await
        .map_err(ChatFailure::Store)?;
    if open.len() >= MAX_OPEN_REQUESTS
        || open
            .iter()
            .filter(|request| request.requester_user_id == member.user_id)
            .count()
            >= MAX_OPEN_REQUESTS_PER_MEMBER
    {
        return Err(ChatFailure::TicketCapacity);
    }
    let request_id = format!("frq_{}", Uuid::new_v4().simple());
    let upload = body.upload.map(|upload| UploadSpec {
        byte_length: upload.byte_length,
        sha256: upload.sha256.to_ascii_lowercase(),
        object_key: object_key(
            &org_id,
            &session.workspace_id,
            &session_id,
            &request_id,
            "upload",
        ),
    });
    let request = state
        .session_files_store
        .create_request(FileRequest {
            id: request_id,
            org_id: org_id.clone(),
            workspace_id: session.workspace_id.clone(),
            session_id: session_id.clone(),
            grant_id: grant.id.clone(),
            requester_user_id: member.user_id.clone(),
            requester_role: member.role,
            op: body.op,
            path: body.path,
            dest_path: body.dest_path,
            status: if upload.is_some() {
                RequestStatus::AwaitingUpload
            } else {
                RequestStatus::Pending
            },
            upload,
            result: None,
            result_object: None,
            error: None,
            created_at: now,
            claimed_at: None,
            completed_at: None,
            expires_at: now + REQUEST_WAIT_MS,
        })
        .await
        .map_err(ChatFailure::Store)?;
    if request.status == RequestStatus::Pending {
        state.session_files_hub.wake(&session_id);
    }
    Ok((
        StatusCode::CREATED,
        Json(FileRequestView::of(&request, now)),
    ))
}

/// The caller's own request; anyone else's reads as absent.
async fn own_request(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
    session_id: &str,
    request_id: &str,
) -> Result<FileRequest, ChatFailure> {
    let (_, member) = visible(
        state,
        headers,
        org_id,
        session_id,
        SessionAction::FilesReadLive,
    )
    .await?;
    reap(state, org_id, session_id).await?;
    state
        .session_files_store
        .request(org_id, session_id, request_id)
        .await
        .map_err(ChatFailure::Store)?
        .filter(|request| request.requester_user_id == member.user_id)
        .ok_or(ChatFailure::Hidden)
}

async fn get_request(
    State(state): State<AppState>,
    Path((org_id, session_id, request_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<FileRequestView>, ChatFailure> {
    let request = own_request(&state, &headers, &org_id, &session_id, &request_id).await?;
    Ok(Json(FileRequestView::of(&request, (state.now)())))
}

async fn upload_request_bytes(
    State(state): State<AppState>,
    Path((org_id, session_id, request_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ChatFailure> {
    let request = own_request(&state, &headers, &org_id, &session_id, &request_id).await?;
    let now = (state.now)();
    let upload = request.upload.as_ref().ok_or(ChatFailure::Hidden)?;
    if request.status_at(now) != RequestStatus::AwaitingUpload {
        return Err(ChatFailure::Gone);
    }
    if body.len() as i64 != upload.byte_length
        || hex::encode(Sha256::digest(&body)) != upload.sha256
    {
        return Err(ChatFailure::BadRequest(
            "the bytes do not match the declared length and sha256".into(),
        ));
    }
    state
        .chat_attachments
        .put(&upload.object_key, body)
        .await
        .map_err(|_| ChatFailure::ObjectStore)?;
    state
        .session_files_store
        .mark_uploaded(&org_id, &session_id, &request_id, now)
        .await
        .map_err(ChatFailure::Store)?;
    state.session_files_hub.wake(&session_id);
    Ok(StatusCode::NO_CONTENT)
}

async fn download_result(
    State(state): State<AppState>,
    Path((org_id, session_id, request_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ChatFailure> {
    let request = own_request(&state, &headers, &org_id, &session_id, &request_id).await?;
    if request.status_at((state.now)()) != RequestStatus::Done {
        return Err(ChatFailure::Gone);
    }
    let object = request.result_object.ok_or(ChatFailure::Hidden)?;
    let bytes = state
        .chat_attachments
        .get(&object.object_key)
        .await
        .map_err(|_| ChatFailure::Gone)?;
    let mut response = bytes.into_response();
    if let Ok(value) = HeaderValue::from_str(&object.media_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // The media type is the host's word; a browser must not second-guess it.
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_store::NewSharedSession;
    use axum::body::Body;
    use axum::http::Request;
    use cognia_tenant_auth::grant::{GrantClaims, GrantSigner};
    use cognia_tenant_auth::{OrgId, OrgRole, UserId};
    use std::sync::atomic::{AtomicI64, Ordering};
    use tower::ServiceExt;

    const ORG: &str = "org_acme00000000000000000";
    const OWNER: &str = "usr_aaaaaaaaaaaaaaaaaaaaaaaa";
    const MEMBER: &str = "usr_bbbbbbbbbbbbbbbbbbbbbbbb";
    const VIEWER: &str = "usr_cccccccccccccccccccccccc";
    const GUEST: &str = "usr_dddddddddddddddddddddddd";
    const SESSION: &str = "ses_files";
    const PROTOCOL: &str = "2";

    fn grant_body(permissions: &[&str], expires_at: i64) -> serde_json::Value {
        serde_json::json!({
            "label": "Design files",
            "minRole": "viewer",
            "permissions": permissions,
            "paths": [{ "path": "/workspace/src", "isDir": true }, { "path": "/uploads/a.pdf", "isDir": false }],
            "status": "active",
            "expiresAt": expires_at,
            "createdAt": 1_000,
        })
    }

    struct Fixture {
        state: AppState,
        clock: Arc<AtomicI64>,
        bearer: Box<dyn Fn(&str) -> String + Send + Sync>,
    }

    impl Fixture {
        async fn new() -> Self {
            let store = crate::store::InMemoryStore::new();
            for user in [OWNER, MEMBER, VIEWER, GUEST] {
                store.add_user(user, user);
                store.add_org_member(ORG, user, OrgRole::Member);
            }
            let signer = GrantSigner::new(&[9; 32]).unwrap();
            let mut state = AppState::new(
                Arc::new(store),
                signer.clone(),
                Arc::new(cognia_tenant_auth::oidc::TestAuthenticator),
            );
            let clock = Arc::new(AtomicI64::new(1_000));
            let now = clock.clone();
            state.now = Arc::new(move || now.load(Ordering::SeqCst));
            state
                .chat_store
                .create_session(NewSharedSession {
                    id: SESSION.into(),
                    org_id: ORG.into(),
                    workspace_id: "workspace".into(),
                    title: "Shared".into(),
                    status: SessionStatus::Active,
                    created_by_user_id: OWNER.into(),
                    now: 1,
                    operation_id: "create".into(),
                })
                .await
                .unwrap();
            for (user, role, guest) in [
                (MEMBER, SessionRole::Member, false),
                (VIEWER, SessionRole::Viewer, false),
                (GUEST, SessionRole::Member, true),
            ] {
                state
                    .chat_store
                    .put_member(ORG, SESSION, "workspace", user, role, false, guest, 2)
                    .await
                    .unwrap();
            }
            let bearer = Box::new(move |user: &str| {
                let claims = GrantClaims::issue(
                    UserId::parse(user).unwrap(),
                    OrgId::parse(ORG).unwrap(),
                    None,
                    None,
                    Duration::from_secs(300),
                )
                .unwrap();
                format!("Bearer {}", signer.sign(&claims).unwrap())
            });
            Self {
                state,
                clock,
                bearer,
            }
        }

        fn advance(&self, ms: i64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }

        async fn allow_writes(&self) {
            self.state
                .file_sharing_store
                .put_file_sharing_policy(
                    ORG,
                    crate::file_sharing::FileSharingSettings {
                        allow_live_write: true,
                        ..Default::default()
                    },
                    0,
                    OWNER,
                    1,
                )
                .await
                .unwrap();
        }

        async fn send(
            &self,
            method: &str,
            path: &str,
            auth: Auth<'_>,
            body: Option<Body>,
        ) -> (StatusCode, Bytes) {
            let mut request = Request::builder()
                .method(method)
                .uri(format!("/v1/orgs/{ORG}/chat-sessions/{SESSION}{path}"))
                .header("x-cognia-collab-protocol", PROTOCOL);
            request = match auth {
                Auth::User(user) => request.header("authorization", (self.bearer)(user)),
                Auth::Host(token) => request.header(HOST_TOKEN_HEADER, token),
            };
            let request = request.body(body.unwrap_or_else(Body::empty)).unwrap();
            let response = routes()
                .with_state(self.state.clone())
                .oneshot(request)
                .await
                .unwrap();
            let status = response.status();
            (
                status,
                axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap(),
            )
        }

        async fn json(
            &self,
            method: &str,
            path: &str,
            auth: Auth<'_>,
            body: Option<serde_json::Value>,
        ) -> (StatusCode, serde_json::Value) {
            let mut request = Request::builder()
                .method(method)
                .uri(format!("/v1/orgs/{ORG}/chat-sessions/{SESSION}{path}"))
                .header("x-cognia-collab-protocol", PROTOCOL)
                .header("content-type", "application/json");
            request = match auth {
                Auth::User(user) => request.header("authorization", (self.bearer)(user)),
                Auth::Host(token) => request.header(HOST_TOKEN_HEADER, token),
            };
            let request = request
                .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
                .unwrap();
            let response = routes()
                .with_state(self.state.clone())
                .oneshot(request)
                .await
                .unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            (
                status,
                serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
            )
        }

        /// Register the host as the owner and mirror one grant; the token.
        async fn hosted(&self, permissions: &[&str]) -> String {
            let (status, body) = self
                .json(
                    "PUT",
                    "/file-host",
                    Auth::User(OWNER),
                    Some(serde_json::json!({ "hostLabel": "Ada's Mac" })),
                )
                .await;
            assert_eq!(status, StatusCode::CREATED, "{body}");
            let token = body["hostToken"].as_str().unwrap().to_owned();
            let (status, body) = self
                .json(
                    "PUT",
                    "/file-host/grants/fg_1",
                    Auth::Host(&token),
                    Some(grant_body(permissions, 1_000 + 3_600_000)),
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            token
        }

        async fn claim(&self, token: &str) -> (StatusCode, serde_json::Value) {
            self.json("POST", "/file-host/claim?waitMs=0", Auth::Host(token), None)
                .await
        }
    }

    #[derive(Clone, Copy)]
    enum Auth<'a> {
        User(&'a str),
        Host(&'a str),
    }

    fn sample_grant() -> FileGrant {
        FileGrant {
            id: "fg_1".into(),
            org_id: ORG.into(),
            workspace_id: "workspace".into(),
            session_id: SESSION.into(),
            label: None,
            user_ids: None,
            min_role: SessionRole::Member,
            permissions: vec!["read".into(), "download".into()],
            paths: vec![
                GrantPath {
                    path: "/workspace/src".into(),
                    is_dir: true,
                },
                GrantPath {
                    path: "/uploads/a.pdf".into(),
                    is_dir: false,
                },
            ],
            status: "active".into(),
            expires_at: 10_000,
            revoked_at: None,
            policy_revision: 0,
            created_by: OWNER.into(),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn paths_follow_the_filespace_grammar() {
        for good in ["/", "/workspace", "/workspace/src/a.ts", "/uploads/a b.pdf"] {
            assert!(valid_path(good), "{good}");
        }
        for bad in [
            "",
            "workspace",
            "/workspace/",
            "/a//b",
            "/a/./b",
            "/a/../b",
            "/a\\b",
            "/a\0",
        ] {
            assert!(!valid_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_grant_admits_by_role_list_status_and_time() {
        let grant = sample_grant();
        assert!(grant.admits(MEMBER, SessionRole::Member, 5));
        assert!(grant.admits(OWNER, SessionRole::Owner, 5));
        assert!(
            !grant.admits(VIEWER, SessionRole::Viewer, 5),
            "below min_role"
        );
        assert!(
            !grant.admits(MEMBER, SessionRole::Member, 10_000),
            "expired"
        );
        let named = FileGrant {
            user_ids: Some(vec![MEMBER.into()]),
            ..grant.clone()
        };
        assert!(named.admits(MEMBER, SessionRole::Member, 5));
        assert!(!named.admits(OWNER, SessionRole::Owner, 5), "not named");
        let suspended = FileGrant {
            status: "suspended".into(),
            ..grant
        };
        assert!(!suspended.admits(MEMBER, SessionRole::Member, 5));
    }

    #[test]
    fn a_grant_reaches_its_paths_and_lists_their_ancestors() {
        let grant = sample_grant();
        assert!(grant.reaches(FileOp::Read, "/workspace/src/a.ts"));
        assert!(grant.reaches(FileOp::List, "/workspace/src"));
        assert!(grant.reaches(FileOp::Read, "/uploads/a.pdf"));
        assert!(!grant.reaches(FileOp::Read, "/uploads/b.pdf"));
        assert!(
            !grant.reaches(FileOp::Read, "/workspace/srcx/a.ts"),
            "a sibling prefix"
        );
        // Ancestors are list-only.
        assert!(grant.reaches(FileOp::List, "/workspace"));
        assert!(grant.reaches(FileOp::Stat, "/"));
        assert!(!grant.reaches(FileOp::Read, "/workspace"));
        // Permissions gate the op.
        assert!(!grant.reaches(FileOp::Write, "/workspace/src/a.ts"));
        let read_only = FileGrant {
            permissions: vec!["read".into()],
            ..sample_grant()
        };
        assert!(!read_only.reaches(FileOp::Read, "/workspace/src/a.ts"));
        assert!(read_only.reaches(FileOp::List, "/workspace/src"));
    }

    #[test]
    fn a_request_reads_as_expired_past_its_deadline() {
        let request = FileRequest {
            id: "frq_1".into(),
            org_id: ORG.into(),
            workspace_id: "workspace".into(),
            session_id: SESSION.into(),
            grant_id: "fg_1".into(),
            requester_user_id: MEMBER.into(),
            requester_role: SessionRole::Member,
            op: FileOp::List,
            path: "/workspace".into(),
            dest_path: None,
            upload: None,
            status: RequestStatus::Pending,
            result: None,
            result_object: None,
            error: None,
            created_at: 1,
            claimed_at: None,
            completed_at: None,
            expires_at: 100,
        };
        assert_eq!(request.status_at(99), RequestStatus::Pending);
        assert_eq!(request.status_at(100), RequestStatus::Expired);
        assert!(FileOp::Write.changes() && !FileOp::Read.changes());
        assert_eq!(FileOp::parse("rename"), Some(FileOp::Rename));
        assert_eq!(
            RequestStatus::parse("awaiting_upload"),
            Some(RequestStatus::AwaitingUpload)
        );
    }

    #[tokio::test]
    async fn only_a_member_who_may_share_registers_the_host() {
        let f = Fixture::new().await;
        let body = serde_json::json!({ "hostLabel": "Bob's PC" });
        let (status, _) = f
            .json("PUT", "/file-host", Auth::User(MEMBER), Some(body.clone()))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, view) = f.json("GET", "/file-host", Auth::User(VIEWER), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(view["registered"], false);

        let (status, registered) = f
            .json("PUT", "/file-host", Auth::User(OWNER), Some(body))
            .await;
        assert_eq!(status, StatusCode::CREATED);
        let token = registered["hostToken"].as_str().unwrap();
        assert!(token.starts_with("fht_") && token.len() == 4 + 64);
        let stored = f
            .state
            .session_files_store
            .host(ORG, SESSION)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            stored.host_token_hash,
            token_hash(token),
            "only the hash is kept"
        );
        assert_eq!(stored.registered_by, OWNER);
        let audit = f
            .state
            .store
            .list_authorization_audit(ORG, 50)
            .await
            .unwrap();
        assert!(audit
            .iter()
            .any(|event| event.action == "files.host.register"));
    }

    #[tokio::test]
    async fn the_host_authenticates_with_its_token_and_shows_online() {
        let f = Fixture::new().await;
        let token = f.hosted(&["read", "download"]).await;
        let (status, _) = f.claim("fht_wrong").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = f.claim(&token).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, view) = f.json("GET", "/file-host", Auth::User(MEMBER), None).await;
        assert_eq!(view["online"], true);
        f.advance(HOST_ONLINE_MS + 1);
        let (_, view) = f.json("GET", "/file-host", Auth::User(MEMBER), None).await;
        assert_eq!(view["online"], false);
        // Re-registering replaces the token.
        let (_, again) = f
            .json(
                "PUT",
                "/file-host",
                Auth::User(OWNER),
                Some(serde_json::json!({ "hostLabel": "New" })),
            )
            .await;
        assert_ne!(again["hostToken"].as_str().unwrap(), token);
        let (status, _) = f.claim(&token).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_registrant_who_loses_the_role_takes_the_host_with_them() {
        let f = Fixture::new().await;
        f.state
            .chat_store
            .put_member(
                ORG,
                SESSION,
                "workspace",
                MEMBER,
                SessionRole::Maintainer,
                false,
                false,
                3,
            )
            .await
            .unwrap();
        let (status, registered) = f
            .json(
                "PUT",
                "/file-host",
                Auth::User(MEMBER),
                Some(serde_json::json!({ "hostLabel": "Bob" })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        let token = registered["hostToken"].as_str().unwrap().to_owned();
        f.state
            .chat_store
            .put_member(
                ORG,
                SESSION,
                "workspace",
                MEMBER,
                SessionRole::Member,
                false,
                false,
                4,
            )
            .await
            .unwrap();
        let (status, _) = f.claim(&token).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(f
            .state
            .session_files_store
            .host(ORG, SESSION)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn the_mirror_is_clamped_to_the_org_policy() {
        let f = Fixture::new().await;
        let token = f.hosted(&["read", "download"]).await;
        // Writes are off by default.
        let (status, body) = f
            .json(
                "PUT",
                "/file-host/grants/fg_2",
                Auth::Host(&token),
                Some(grant_body(&["read", "write"], 1_000 + 3_600_000)),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["reason"], "org_file_sharing_policy_write");
        // Longer than the seven-day default ceiling.
        let (status, _) = f
            .json(
                "PUT",
                "/file-host/grants/fg_2",
                Auth::Host(&token),
                Some(grant_body(&["read"], 1_000 + 8 * 24 * 3_600_000)),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // A suspended mirror is not clamped: it serves nothing.
        let mut suspended = grant_body(&["read", "write"], 1_000 + 3_600_000);
        suspended["status"] = "suspended".into();
        let (status, _) = f
            .json(
                "PUT",
                "/file-host/grants/fg_2",
                Auth::Host(&token),
                Some(suspended),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        // Malformed ones are refused.
        let mut bad = grant_body(&["read"], 1_000 + 3_600_000);
        bad["paths"] = serde_json::json!([{ "path": "/a/../b", "isDir": true }]);
        let (status, _) = f
            .json(
                "PUT",
                "/file-host/grants/fg_3",
                Auth::Host(&token),
                Some(bad),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, _) = f
            .json(
                "PUT",
                "/file-host/grants/nope",
                Auth::Host(&token),
                Some(grant_body(&["read"], 2_000)),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn members_see_the_grants_that_admit_them_without_who_else_they_name() {
        let f = Fixture::new().await;
        let token = f.hosted(&["read", "download"]).await;
        let mut named = grant_body(&["read"], 1_000 + 3_600_000);
        named["userIds"] = serde_json::json!([MEMBER]);
        named["minRole"] = "member".into();
        f.json(
            "PUT",
            "/file-host/grants/fg_named",
            Auth::Host(&token),
            Some(named),
        )
        .await;

        let (status, listed) = f
            .json("GET", "/file-grants", Auth::User(MEMBER), None)
            .await;
        assert_eq!(status, StatusCode::OK);
        let ids: Vec<&str> = listed["grants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|grant| grant["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(listed["grants"]
            .as_array()
            .unwrap()
            .iter()
            .all(|grant| grant["userIds"].is_null()));
        let (_, viewer) = f
            .json("GET", "/file-grants", Auth::User(VIEWER), None)
            .await;
        assert_eq!(
            viewer["grants"].as_array().unwrap().len(),
            1,
            "the named grant is not the viewer's"
        );
        assert_eq!(viewer["host"]["registered"], true);

        // A revoked mirror lists for nobody.
        let (status, _) = f
            .json("DELETE", "/file-host/grants/fg_1", Auth::Host(&token), None)
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, viewer) = f
            .json("GET", "/file-grants", Auth::User(VIEWER), None)
            .await;
        assert!(viewer["grants"].as_array().unwrap().is_empty());
        // And cannot come back.
        let (status, _) = f
            .json(
                "PUT",
                "/file-host/grants/fg_1",
                Auth::Host(&token),
                Some(grant_body(&["read"], 1_000 + 3_600_000)),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn a_read_travels_from_the_member_to_the_host_and_back_to_the_member_alone() {
        let f = Fixture::new().await;
        let token = f.hosted(&["read", "download"]).await;
        let (status, created) = f
            .json(
                "POST",
                "/file-requests",
                Auth::User(VIEWER),
                Some(serde_json::json!({ "grantId": "fg_1", "op": "read", "path": "/workspace/src/a.ts" })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        assert_eq!(created["status"], "pending");
        let request_id = created["id"].as_str().unwrap().to_owned();

        let (status, claimed) = f.claim(&token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(claimed["id"], request_id.as_str());
        assert_eq!(claimed["requesterUserId"], VIEWER);
        assert_eq!(claimed["requesterRole"], "viewer");
        assert_eq!(claimed["op"], "read");
        // Claimed once only.
        let (status, _) = f.claim(&token).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        // Completing a read without bytes is refused.
        let (status, _) = f
            .json(
                "POST",
                &format!("/file-host/requests/{request_id}/complete"),
                Auth::Host(&token),
                Some(serde_json::json!({ "ok": true })),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, _) = f
            .send(
                "PUT",
                &format!("/file-host/requests/{request_id}/result"),
                Auth::Host(&token),
                Some(Body::from("hello")),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = f
            .json(
                "POST",
                &format!("/file-host/requests/{request_id}/complete"),
                Auth::Host(&token),
                Some(serde_json::json!({ "ok": true, "object": { "byteLength": 5, "mediaType": "text/plain" } })),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (status, view) = f
            .json(
                "GET",
                &format!("/file-requests/{request_id}"),
                Auth::User(VIEWER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(view["status"], "done");
        assert_eq!(view["resultByteLength"], 5);
        let (status, bytes) = f
            .send(
                "GET",
                &format!("/file-requests/{request_id}/result"),
                Auth::User(VIEWER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(&bytes[..], b"hello");
        // Another member cannot see it.
        let (status, _) = f
            .json(
                "GET",
                &format!("/file-requests/{request_id}"),
                Auth::User(MEMBER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = f
            .send(
                "GET",
                &format!("/file-requests/{request_id}/result"),
                Auth::User(MEMBER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Its bytes go after fifteen minutes.
        f.advance(RESULT_TTL_MS + 1);
        let (status, _) = f
            .send(
                "GET",
                &format!("/file-requests/{request_id}/result"),
                Auth::User(VIEWER),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::GONE);
        let key = object_key(ORG, "workspace", SESSION, &request_id, "result");
        assert!(
            f.state.chat_attachments.get(&key).await.is_err(),
            "the reaper deleted it"
        );
    }

    #[tokio::test]
    async fn requests_stay_within_the_grant_and_the_role() {
        let f = Fixture::new().await;
        f.hosted(&["read", "download"]).await;
        let ask =
            |op: &str, path: &str| serde_json::json!({ "grantId": "fg_1", "op": op, "path": path });
        let (status, _) = f
            .json(
                "POST",
                "/file-requests",
                Auth::User(MEMBER),
                Some(ask("read", "/workspace/other.ts")),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "outside the grant");
        let (status, _) = f
            .json(
                "POST",
                "/file-requests",
                Auth::User(MEMBER),
                Some(ask("list", "/workspace")),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "an ancestor lists");
        let (status, _) = f
            .json(
                "POST",
                "/file-requests",
                Auth::User(MEMBER),
                Some(ask("read", "/workspace/../etc")),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, _) = f
            .json(
                "POST",
                "/file-requests",
                Auth::User(MEMBER),
                Some(
                    serde_json::json!({ "grantId": "fg_nope", "op": "list", "path": "/workspace" }),
                ),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // Writes need files.writeLive: never a viewer or a guest.
        let write = serde_json::json!({
            "grantId": "fg_1", "op": "write", "path": "/workspace/src/a.ts",
            "upload": { "byteLength": 2, "sha256": hex::encode(Sha256::digest(b"hi")) }
        });
        for user in [VIEWER, GUEST] {
            let (status, _) = f
                .json(
                    "POST",
                    "/file-requests",
                    Auth::User(user),
                    Some(write.clone()),
                )
                .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{user}");
        }
        // The org policy forbids writes by default.
        let (status, body) = f
            .json("POST", "/file-requests", Auth::User(MEMBER), Some(write))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["reason"], "org_file_sharing_policy");
    }

    #[tokio::test]
    async fn a_write_waits_for_its_bytes_and_the_host_pulls_them() {
        let f = Fixture::new().await;
        f.allow_writes().await;
        let token = f.hosted(&["read", "download", "write"]).await;
        let sha = hex::encode(Sha256::digest(b"new contents"));
        let (status, created) = f
            .json(
                "POST",
                "/file-requests",
                Auth::User(MEMBER),
                Some(serde_json::json!({
                    "grantId": "fg_1", "op": "write", "path": "/workspace/src/new.txt",
                    "upload": { "byteLength": 12, "sha256": sha }
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        assert_eq!(created["status"], "awaiting_upload");
        let id = created["id"].as_str().unwrap().to_owned();
        let (status, _) = f.claim(&token).await;
        assert_eq!(
            status,
            StatusCode::NO_CONTENT,
            "nothing to claim before the bytes"
        );
        let (status, _) = f
            .send(
                "PUT",
                &format!("/file-requests/{id}/upload"),
                Auth::User(MEMBER),
                Some(Body::from("wrong")),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, _) = f
            .send(
                "PUT",
                &format!("/file-requests/{id}/upload"),
                Auth::User(MEMBER),
                Some(Body::from("new contents")),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (status, claimed) = f.claim(&token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(claimed["uploadByteLength"], 12);
        let (status, bytes) = f
            .send(
                "GET",
                &format!("/file-host/requests/{id}/upload"),
                Auth::Host(&token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(&bytes[..], b"new contents");
        let (status, _) = f
            .json(
                "POST",
                &format!("/file-host/requests/{id}/complete"),
                Auth::Host(&token),
                Some(serde_json::json!({ "ok": true, "result": { "written": 12 } })),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let key = object_key(ORG, "workspace", SESSION, &id, "upload");
        assert!(
            f.state.chat_attachments.get(&key).await.is_err(),
            "spent bytes are dropped"
        );
        let (_, view) = f
            .json(
                "GET",
                &format!("/file-requests/{id}"),
                Auth::User(MEMBER),
                None,
            )
            .await;
        assert_eq!(view["status"], "done");
        assert_eq!(view["result"]["written"], 12);
    }

    #[tokio::test]
    async fn an_unanswered_request_expires_and_a_late_answer_is_refused() {
        let f = Fixture::new().await;
        let token = f.hosted(&["read", "download"]).await;
        let (_, created) = f
            .json("POST", "/file-requests", Auth::User(MEMBER), Some(serde_json::json!({ "grantId": "fg_1", "op": "stat", "path": "/workspace/src" })))
            .await;
        let id = created["id"].as_str().unwrap().to_owned();
        f.advance(REQUEST_WAIT_MS);
        let (_, view) = f
            .json(
                "GET",
                &format!("/file-requests/{id}"),
                Auth::User(MEMBER),
                None,
            )
            .await;
        assert_eq!(view["status"], "expired");
        let (status, _) = f.claim(&token).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        // A claimed request must be answered in time.
        let (_, created) = f
            .json("POST", "/file-requests", Auth::User(MEMBER), Some(serde_json::json!({ "grantId": "fg_1", "op": "stat", "path": "/workspace/src" })))
            .await;
        let id = created["id"].as_str().unwrap().to_owned();
        let (status, _) = f.claim(&token).await;
        assert_eq!(status, StatusCode::OK);
        f.advance(REQUEST_WAIT_MS);
        let (status, _) = f
            .json(
                "POST",
                &format!("/file-host/requests/{id}/complete"),
                Auth::Host(&token),
                Some(serde_json::json!({ "ok": false, "error": "late" })),
            )
            .await;
        assert_eq!(status, StatusCode::GONE);
    }

    #[tokio::test]
    async fn open_requests_are_capped_per_member_and_per_conversation() {
        let f = Fixture::new().await;
        f.hosted(&["read", "download"]).await;
        let ask = serde_json::json!({ "grantId": "fg_1", "op": "list", "path": "/workspace/src" });
        for _ in 0..MAX_OPEN_REQUESTS_PER_MEMBER {
            let (status, _) = f
                .json(
                    "POST",
                    "/file-requests",
                    Auth::User(MEMBER),
                    Some(ask.clone()),
                )
                .await;
            assert_eq!(status, StatusCode::CREATED);
        }
        let (status, _) = f
            .json(
                "POST",
                "/file-requests",
                Auth::User(MEMBER),
                Some(ask.clone()),
            )
            .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        // Someone else still may.
        let (status, _) = f
            .json(
                "POST",
                "/file-requests",
                Auth::User(VIEWER),
                Some(ask.clone()),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        // Once they expire the member may ask again.
        f.advance(REQUEST_WAIT_MS);
        let (status, _) = f
            .json("POST", "/file-requests", Auth::User(MEMBER), Some(ask))
            .await;
        assert_eq!(status, StatusCode::CREATED);
    }

    #[tokio::test]
    async fn removing_the_host_revokes_its_grants_and_ends_open_requests() {
        let f = Fixture::new().await;
        let token = f.hosted(&["read", "download"]).await;
        let (_, created) = f
            .json("POST", "/file-requests", Auth::User(MEMBER), Some(serde_json::json!({ "grantId": "fg_1", "op": "list", "path": "/workspace/src" })))
            .await;
        let id = created["id"].as_str().unwrap().to_owned();
        let (status, _) = f
            .json("DELETE", "/file-host", Auth::User(MEMBER), None)
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "files.share is needed");
        // The host may remove itself with its token.
        let (status, _) = f
            .json("DELETE", "/file-host", Auth::Host(&token), None)
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, view) = f
            .json(
                "GET",
                &format!("/file-requests/{id}"),
                Auth::User(MEMBER),
                None,
            )
            .await;
        assert_eq!(view["status"], "expired");
        let grant = f
            .state
            .session_files_store
            .grant(ORG, SESSION, "fg_1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(grant.status, "revoked");
        let (status, body) = f
            .json("POST", "/file-requests", Auth::User(MEMBER), Some(serde_json::json!({ "grantId": "fg_1", "op": "list", "path": "/workspace/src" })))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["reason"], "no_file_host");
        let (status, _) = f.claim(&token).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_waiting_claim_wakes_when_a_request_arrives() {
        let f = Arc::new(Fixture::new().await);
        let token = f.hosted(&["read", "download"]).await;
        let waiter = {
            let f = f.clone();
            let token = token.clone();
            tokio::spawn(async move {
                f.json(
                    "POST",
                    "/file-host/claim?waitMs=5000",
                    Auth::Host(&token),
                    None,
                )
                .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let started = std::time::Instant::now();
        f.json(
            "POST",
            "/file-requests",
            Auth::User(MEMBER),
            Some(serde_json::json!({ "grantId": "fg_1", "op": "list", "path": "/workspace/src" })),
        )
        .await;
        let (status, claimed) = waiter.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(claimed["op"], "list");
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "woken, not polled"
        );
    }

    #[tokio::test]
    async fn a_replaced_host_stops_waiting_and_takes_nothing_of_the_new_one() {
        let f = Arc::new(Fixture::new().await);
        let old = f.hosted(&["read", "download"]).await;
        let waiter = {
            let f = f.clone();
            let old = old.clone();
            tokio::spawn(async move {
                f.json("POST", "/file-host/claim?waitMs=5000", Auth::Host(&old), None)
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let started = std::time::Instant::now();
        let (status, body) = f
            .json(
                "PUT",
                "/file-host",
                Auth::User(OWNER),
                Some(serde_json::json!({ "hostLabel": "New Mac" })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        let new = body["hostToken"].as_str().unwrap().to_owned();
        let (status, _) = waiter.await.unwrap();
        assert_eq!(status, StatusCode::UNAUTHORIZED, "the old poll ends");
        assert!(started.elapsed() < Duration::from_millis(900), "at once, not at its deadline");

        // The new host's grant and a member's request under it.
        let (status, _) = f
            .json(
                "PUT",
                "/file-host/grants/fg_2",
                Auth::Host(&new),
                Some(grant_body(&["read", "download"], 1_000 + 3_600_000)),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        f.json(
            "POST",
            "/file-requests",
            Auth::User(MEMBER),
            Some(serde_json::json!({ "grantId": "fg_2", "op": "list", "path": "/workspace/src" })),
        )
        .await;
        assert_eq!(f.claim(&old).await.0, StatusCode::UNAUTHORIZED);
        let (status, claimed) = f.claim(&new).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(claimed["grantId"], "fg_2");

        // The store never hands a request to a token that is not registered.
        let hash = token_hash(&old);
        assert!(f
            .state
            .session_files_store
            .claim_next(ORG, SESSION, &hash, (f.state.now)())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn a_mirror_cannot_stretch_its_lifetime_with_a_future_creation_time() {
        let f = Fixture::new().await;
        let token = f.hosted(&["read"]).await;
        let mut body = grant_body(&["read"], 10_000_000_000_i64);
        body["createdAt"] = serde_json::json!(10_000_000_000_i64 - 1_000);
        let (status, refused) = f
            .json("PUT", "/file-host/grants/fg_late", Auth::Host(&token), Some(body))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert_eq!(refused["reason"], "org_file_sharing_policy_ttl");
    }

    #[tokio::test]
    async fn deleting_the_conversation_deletes_its_file_requests_bytes() {
        let f = Fixture::new().await;
        f.allow_writes().await;
        f.hosted(&["read", "download", "write"]).await;
        let (_, created) = f
            .json(
                "POST",
                "/file-requests",
                Auth::User(MEMBER),
                Some(serde_json::json!({
                    "grantId": "fg_1", "op": "write", "path": "/workspace/src/new.txt",
                    "upload": { "byteLength": 5, "sha256": hex::encode(Sha256::digest(b"bytes")) }
                })),
            )
            .await;
        let id = created["id"].as_str().unwrap().to_owned();
        let (status, _) = f
            .send(
                "PUT",
                &format!("/file-requests/{id}/upload"),
                Auth::User(MEMBER),
                Some(Body::from("bytes")),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let key = object_key(ORG, "workspace", SESSION, &id, "upload");
        assert!(f.state.chat_attachments.get(&key).await.is_ok());

        let (session, _) = f
            .state
            .chat_store
            .visible_session(ORG, SESSION, OWNER)
            .await
            .unwrap()
            .unwrap();
        let request = Request::builder()
            .method("DELETE")
            .uri(format!(
                "/v1/orgs/{ORG}/chat-sessions/{SESSION}?operationId=delete-1&baseRevision={}",
                session.revision
            ))
            .header("x-cognia-collab-protocol", PROTOCOL)
            .header("authorization", (f.bearer)(OWNER))
            .body(Body::empty())
            .unwrap();
        let response = crate::chat_api::routes()
            .with_state(f.state.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        for _ in 0..200 {
            if f.state.chat_attachments.get(&key).await.is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the request's bytes outlived the conversation");
    }

    #[tokio::test]
    async fn the_conversations_objects_are_listed_for_its_deletion() {
        let store = InMemorySessionFileStore::new();
        let mut request = FileRequest {
            id: "frq_1".into(),
            org_id: ORG.into(),
            workspace_id: "workspace".into(),
            session_id: SESSION.into(),
            grant_id: "fg_1".into(),
            requester_user_id: MEMBER.into(),
            requester_role: SessionRole::Member,
            op: FileOp::Write,
            path: "/workspace/a".into(),
            dest_path: None,
            upload: Some(UploadSpec {
                byte_length: 1,
                sha256: "0".repeat(64),
                object_key: "k-upload".into(),
            }),
            status: RequestStatus::AwaitingUpload,
            result: None,
            result_object: None,
            error: None,
            created_at: 1,
            claimed_at: None,
            completed_at: None,
            expires_at: 100,
        };
        store.create_request(request.clone()).await.unwrap();
        request.id = "frq_other".into();
        request.session_id = "ses_other".into();
        store.create_request(request).await.unwrap();
        assert_eq!(
            store.session_object_keys(ORG, SESSION).await.unwrap(),
            vec!["k-upload".to_string()]
        );
        assert_eq!(
            store.reap_requests(ORG, SESSION, 100).await.unwrap(),
            vec!["k-upload".to_string()]
        );
        assert!(store
            .session_object_keys(ORG, SESSION)
            .await
            .unwrap()
            .is_empty());
    }
}
