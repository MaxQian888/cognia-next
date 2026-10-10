//! Serving a shared conversation's members (ADR-0222 §6, P3).
//!
//! A conversation shared through a collaboration org has a counterpart on the
//! collaboration server. The device holding its files registers there as the
//! conversation's **file host** (the app does that with the member's own
//! sign-in and hands this crate the host token, [`set_host`]). From then on:
//!
//! - **Grants** with a `collab` audience are mirrored to the server
//!   ([`push_mirrors`]), so members can see what they may reach. The host's
//!   own row stays authoritative: every request is re-authorized here.
//!   Mirroring is an outbox: each state change bumps the grant's revision and
//!   a pass pushes whatever the server has not acknowledged, latest state
//!   first, so a failed push is retried with the grant as it is by then.
//! - **Requests** members make (list, stat, read, write, mkdir, delete,
//!   rename) wait on the server until this host claims them. One long-poll
//!   loop per registered conversation ([`Responders`]) claims each, asks the
//!   gateway exactly as a WebDAV or SFTP credential would be asked — with the
//!   member and role the server vouches for as the holder — does the I/O, and
//!   answers. Bytes travel through the server's object store under keys only
//!   the requester and this host can reach.
//! - **The registration ends** when the app clears it, when the conversation
//!   is deleted (the host unregisters itself), when a newer registration
//!   replaces it, or when the server refuses the token (the registrant lost
//!   `files.share`). Every members' grant made under it is revoked then, as the
//!   server revoked its own copy.
//!
//! The token lives in the secret store under
//! `collab-host:<account>:<session>`; the server keeps only its SHA-256.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use bytes::Bytes;
use parking_lot::Mutex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::audit::{self, Channel, Event, Outcome};
use crate::builtin::TransferMeter;
use crate::error::{FileShareError, FileShareResult};
use crate::gateway::{self, Caller, Context, Denial, Holder, Op, Target};
use crate::grants::{self, Effects};
use crate::listener::SECRET_SERVICE;
use crate::model::{status_reason, Audience, CollabRole, Grant, GrantStatus, SessionState};
use crate::now_ms;
use crate::service::{Active, FileShareService};
use crate::store::{CollabHostRecord, Store};

/// The header the server reads the host token from.
pub const HOST_TOKEN_HEADER: &str = "x-cognia-file-host-token";
/// The shared-chat protocol header and the version this host speaks.
pub const PROTOCOL_HEADER: &str = "x-cognia-collab-protocol";
pub const PROTOCOL_VERSION: &str = "2";
/// How long one claim waits on the server (its ceiling is 25 s).
pub const CLAIM_WAIT_MS: u64 = 25_000;
/// The largest file a member may read or write: the server's attachment
/// ceiling, which its object store enforces too.
pub const MAX_TRANSFER_BYTES: u64 = 50 * 1024 * 1024;
/// Most entries one listing answers with, so its JSON stays under the
/// server's answer limit.
pub const MAX_LIST_ENTRIES: usize = 1_000;
/// Requests one conversation answers at once.
const CONCURRENT_REQUESTS: usize = 4;
/// A call that moves no file bytes.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// A call that moves up to [`MAX_TRANSFER_BYTES`].
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(600);
/// Longest wait between claims after failures.
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Longest host label the server accepts.
const MAX_LABEL_CHARS: usize = 120;

/// The secret-store account holding one conversation's host token.
pub fn token_account(account_id: &str, session_id: &str) -> String {
    format!("collab-host:{account_id}:{session_id}")
}

// ── Configuration ───────────────────────────────────────────────────────────

/// What the app hands over after registering this device as a shared
/// conversation's file host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollabHostInput {
    pub org_id: String,
    /// The conversation's id on the collaboration server.
    pub collab_session_id: String,
    /// The collaboration server's base URL, as the app's client uses it.
    pub server_url: String,
    pub host_label: String,
    /// The token the server answered the registration with (`fht_…`).
    pub host_token: String,
}

/// One registration, as the settings and the share dialog show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollabHostStatus {
    pub session_id: String,
    pub registration: Option<CollabHostRecord>,
    /// The token is in the secret store.
    pub token_present: bool,
    /// A loop is answering this conversation's requests.
    pub running: bool,
    /// When the server last answered a claim.
    pub last_contact_at: Option<i64>,
    /// Why the last call failed, or why the registration ended.
    pub last_error: Option<String>,
    /// Members' grants whose current state the server has not accepted yet.
    pub unmirrored_grants: usize,
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// The server URL with its trailing slash dropped: `https`, or `http` only to
/// a loopback address (a server on this machine).
fn normalized_server_url(raw: &str) -> FileShareResult<String> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|_| FileShareError::invalid("the collaboration server address is not a URL"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !scheme_ok || url.host_str().is_none() || url.query().is_some() || url.fragment().is_some() {
        return Err(FileShareError::invalid(
            "the collaboration server must be reached over https",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FileShareError::invalid(
            "the collaboration server address must not carry a sign-in",
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

impl CollabHostInput {
    /// The record to keep, after checking every field.
    fn record(&self, session_id: &str, now: i64) -> FileShareResult<CollabHostRecord> {
        if !safe_segment(&self.org_id) || !safe_segment(&self.collab_session_id) {
            return Err(FileShareError::invalid("not a collaboration org or conversation id"));
        }
        let token = self.host_token.trim();
        if !(token.len() == 68
            && token.starts_with("fht_")
            && token[4..].bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(FileShareError::invalid("not a file host token"));
        }
        let label = self.host_label.trim();
        if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS {
            return Err(FileShareError::invalid(format!(
                "the host label is 1 to {MAX_LABEL_CHARS} characters"
            )));
        }
        Ok(CollabHostRecord {
            session_id: session_id.to_string(),
            org_id: self.org_id.clone(),
            collab_session_id: self.collab_session_id.clone(),
            server_url: normalized_server_url(&self.server_url)?,
            host_label: label.to_string(),
            registered_at: now,
            updated_at: now,
        })
    }
}

// ── The server ──────────────────────────────────────────────────────────────

/// How a call to the server went wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerError {
    /// The token was refused: the registration is over.
    HostGone,
    /// The org policy refused it (`reason` as the server names it).
    Policy(String),
    /// The request is no longer this host's to answer (answered, expired, or
    /// its registration replaced).
    Gone,
    /// The server already holds a final state for this grant.
    Conflict,
    /// The server refused the body; retrying the same body will not help.
    Rejected(String),
    /// Unreachable, overloaded, or an answer this build does not expect.
    Transient(String),
}

impl std::fmt::Display for ServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServerError::HostGone => write!(f, "host_unregistered"),
            ServerError::Policy(reason) => write!(f, "org_policy: {reason}"),
            ServerError::Gone => write!(f, "request_gone"),
            ServerError::Conflict => write!(f, "conflict"),
            ServerError::Rejected(detail) => write!(f, "rejected: {detail}"),
            ServerError::Transient(detail) => write!(f, "unreachable: {detail}"),
        }
    }
}

/// A request the host claimed.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedRequest {
    pub id: String,
    pub grant_id: String,
    pub requester_user_id: String,
    pub requester_role: CollabRole,
    pub op: String,
    pub path: String,
    #[serde(default)]
    pub dest_path: Option<String>,
    #[serde(default)]
    pub upload_byte_length: Option<i64>,
    #[serde(default)]
    pub upload_sha256: Option<String>,
    pub expires_at: i64,
}

/// The host's side of the collaboration server's file-host routes.
pub struct Client {
    base: String,
    token: String,
    http: reqwest::Client,
}

impl Client {
    pub fn new(record: &CollabHostRecord, token: String) -> FileShareResult<Self> {
        let base = format!(
            "{}/v1/orgs/{}/chat-sessions/{}",
            record.server_url, record.org_id, record.collab_session_id
        );
        let http = cognia_net::proxy_config::managed_client(
            reqwest::Client::builder().timeout(TRANSFER_TIMEOUT),
            &record.server_url,
        )
        .map_err(|error| FileShareError::new("collab_unreachable", error.to_string()))?;
        Ok(Self { base, token, http })
    }

    fn request(&self, method: reqwest::Method, tail: &str, timeout: Duration) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{tail}", self.base))
            .header(HOST_TOKEN_HEADER, &self.token)
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .timeout(timeout)
    }

    async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, ServerError> {
        let response = request
            .send()
            .await
            .map_err(|error| ServerError::Transient(error.to_string()))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let body: Value = response.json().await.unwrap_or(Value::Null);
        Err(match status.as_u16() {
            401 => ServerError::HostGone,
            403 => match body.get("reason").and_then(Value::as_str) {
                Some(reason) => ServerError::Policy(reason.to_string()),
                None => ServerError::HostGone,
            },
            404 | 410 => ServerError::Gone,
            409 => ServerError::Conflict,
            400 | 413 | 422 => ServerError::Rejected(
                body.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("bad request")
                    .to_string(),
            ),
            other => ServerError::Transient(format!("HTTP {other}")),
        })
    }

    /// Wait up to `wait_ms` for the next request.
    pub async fn claim(&self, wait_ms: u64) -> Result<Option<ClaimedRequest>, ServerError> {
        let request = self.request(
            reqwest::Method::POST,
            &format!("/file-host/claim?waitMs={wait_ms}"),
            CALL_TIMEOUT + Duration::from_millis(wait_ms),
        );
        let response = Self::send(request).await?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        response
            .json::<ClaimedRequest>()
            .await
            .map(Some)
            .map_err(|error| ServerError::Transient(format!("unreadable claim: {error}")))
    }

    /// A write's bytes, as the member uploaded them.
    pub async fn upload(&self, request_id: &str) -> Result<Bytes, ServerError> {
        let response = Self::send(self.request(
            reqwest::Method::GET,
            &format!("/file-host/requests/{request_id}/upload"),
            TRANSFER_TIMEOUT,
        ))
        .await?;
        response
            .bytes()
            .await
            .map_err(|error| ServerError::Transient(error.to_string()))
    }

    /// Store a read's bytes for the requester.
    pub async fn store_result(&self, request_id: &str, bytes: Vec<u8>) -> Result<(), ServerError> {
        Self::send(
            self.request(
                reqwest::Method::PUT,
                &format!("/file-host/requests/{request_id}/result"),
                TRANSFER_TIMEOUT,
            )
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes),
        )
        .await
        .map(|_| ())
    }

    /// Answer a request.
    pub async fn complete(&self, request_id: &str, body: &Value) -> Result<(), ServerError> {
        Self::send(
            self.request(
                reqwest::Method::POST,
                &format!("/file-host/requests/{request_id}/complete"),
                CALL_TIMEOUT,
            )
            .json(body),
        )
        .await
        .map(|_| ())
    }

    /// Publish a grant's current state.
    pub async fn put_grant(&self, grant: &Grant) -> Result<(), ServerError> {
        Self::send(
            self.request(
                reqwest::Method::PUT,
                &format!("/file-host/grants/{}", grant.id),
                CALL_TIMEOUT,
            )
            .json(&mirror_body(grant)),
        )
        .await
        .map(|_| ())
    }

    /// End the registration from this side.
    pub async fn unregister(&self) -> Result<(), ServerError> {
        Self::send(self.request(reqwest::Method::DELETE, "/file-host", CALL_TIMEOUT))
            .await
            .map(|_| ())
    }
}

/// What the server keeps of a members' grant: who it admits, what it allows
/// on which FileSpace paths, and its state.
pub fn mirror_body(grant: &Grant) -> Value {
    let (user_ids, min_role) = match &grant.audience {
        Audience::Collab { user_ids, min_role, .. } => (user_ids.clone(), *min_role),
        Audience::Credentials => (None, CollabRole::Owner),
    };
    json!({
        "label": grant.label,
        "userIds": user_ids,
        "minRole": min_role,
        "permissions": grant.permissions.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
        "paths": grant
            .paths
            .iter()
            .map(|path| json!({ "path": path.virtual_path, "isDir": path.is_dir }))
            .collect::<Vec<_>>(),
        "status": grant.status.as_str(),
        "expiresAt": grant.expires_at,
        "createdAt": grant.created_at,
    })
}

// ── Answering a request ─────────────────────────────────────────────────────

/// A successful answer: JSON, and for a read its bytes and media type.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Answer {
    pub result: Option<Value>,
    pub bytes: Option<(Vec<u8>, String)>,
}

fn parse_op(op: &str) -> Option<Op> {
    Some(match op {
        "list" => Op::List,
        "stat" => Op::Stat,
        "read" => Op::Read,
        "write" => Op::Write,
        "mkdir" => Op::Mkdir,
        "delete" => Op::Delete,
        "rename" => Op::Rename,
        _ => return None,
    })
}

/// The code a member sees for a refusal. A path outside the grant reads as
/// missing, as it does for a credential.
fn denial_code(denial: &Denial) -> &'static str {
    if denial.is_not_found() {
        "not_found"
    } else {
        denial.reason
    }
}

fn io_code(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "not_found",
        std::io::ErrorKind::AlreadyExists => "exists",
        std::io::ErrorKind::DirectoryNotEmpty => "not_empty",
        std::io::ErrorKind::PermissionDenied => "io_denied",
        _ => "io_error",
    }
}

fn media_type_for(name: &str) -> String {
    mime_guess::from_path(name)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

fn last_segment(path: &str) -> &str {
    path.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or("/")
}

fn entry_json(name: &str, is_dir: bool, size: u64, modified_at: i64) -> Value {
    json!({ "name": name, "isDir": is_dir, "size": size, "modifiedAt": modified_at })
}

/// What the gateway decides, for one member.
struct Gate<'a> {
    store: &'a Arc<Store>,
    policy: &'a crate::policy::PolicySnapshot,
    caller: &'a Caller,
}

impl Gate<'_> {
    fn authorize(&self, op: Op, path: &str) -> Result<Target, &'static str> {
        gateway::authorize(
            &Context {
                store: self.store,
                policy: self.policy,
                now: now_ms(),
            },
            self.caller,
            op,
            path,
        )
        .map_err(|denial| denial_code(&denial))
    }

    async fn stat_json(&self, target: &Target) -> Result<Value, &'static str> {
        let name = last_segment(target.path());
        match target {
            Target::Virtual { .. } | Target::AssetDir { .. } => Ok(entry_json(name, true, 0, 0)),
            Target::Asset { entry, .. } => Ok(entry_json(name, false, entry.size, entry.modified_at)),
            Target::Disk { abs, .. } => {
                let meta = tokio::fs::metadata(abs).await.map_err(|error| io_code(&error))?;
                Ok(entry_json(
                    name,
                    meta.is_dir(),
                    if meta.is_dir() { 0 } else { meta.len() },
                    gateway::modified_ms(&meta),
                ))
            }
        }
    }
}

/// Do one claimed request. Refusals and failures are a code the member sees.
pub(crate) async fn perform(
    service: &Arc<FileShareService>,
    store: &Arc<Store>,
    policy: &crate::policy::PolicySnapshot,
    caller: &Caller,
    request: &ClaimedRequest,
    upload: Option<Bytes>,
) -> Result<Answer, &'static str> {
    let op = parse_op(&request.op).ok_or("unsupported")?;
    let gate = Gate { store, policy, caller };
    match op {
        Op::List => {
            let target = gate.authorize(Op::List, &request.path)?;
            let mut entries: Vec<Value> = Vec::new();
            match &target {
                Target::Virtual { path, children } => {
                    for child in children {
                        if child.is_dir {
                            entries.push(entry_json(&child.name, true, 0, 0));
                            continue;
                        }
                        let child_path = crate::paths::join(path, &child.name);
                        if let Ok(child_target) = gate.authorize(Op::Stat, &child_path) {
                            if let Ok(entry) = gate.stat_json(&child_target).await {
                                entries.push(entry);
                            }
                        }
                    }
                }
                Target::Disk { root, rel, abs, .. } => {
                    let (root, rel, abs) = (root.clone(), rel.clone(), abs.clone());
                    let listed = tokio::task::spawn_blocking(move || gateway::list_disk_dir(&root, &rel, &abs))
                        .await
                        .map_err(|_| "io_error")?
                        .map_err(|error| io_code(&error))?;
                    entries.extend(
                        listed
                            .into_iter()
                            .map(|entry| entry_json(&entry.name, entry.is_dir, entry.size, entry.modified_ms)),
                    );
                }
                Target::AssetDir { entries: assets, .. } => entries.extend(
                    assets
                        .iter()
                        .map(|entry| entry_json(&entry.name, false, entry.size, entry.modified_at)),
                ),
                Target::Asset { .. } => return Err("not_a_folder"),
            }
            let truncated = entries.len() > MAX_LIST_ENTRIES;
            entries.truncate(MAX_LIST_ENTRIES);
            gateway::record_transfer(store, now_ms(), caller, Op::List, &target, None, Outcome::Allowed, None);
            Ok(Answer {
                result: Some(json!({ "entries": entries, "truncated": truncated })),
                bytes: None,
            })
        }
        Op::Stat => {
            let target = gate.authorize(Op::Stat, &request.path)?;
            Ok(Answer {
                result: Some(gate.stat_json(&target).await?),
                bytes: None,
            })
        }
        Op::Read => {
            let target = gate.authorize(Op::Read, &request.path)?;
            let mut meter = TransferMeter::new(store.clone(), caller.clone(), Op::Read, target.clone());
            let (bytes, name) = match &target {
                Target::Disk { abs, .. } => {
                    let meta = tokio::fs::metadata(abs).await.map_err(|error| io_code(&error))?;
                    if meta.is_dir() {
                        meter.fail("is_folder");
                        return Err("is_folder");
                    }
                    if meta.len() > MAX_TRANSFER_BYTES {
                        meter.fail("too_large");
                        return Err("too_large");
                    }
                    let bytes = tokio::fs::read(abs).await.map_err(|error| {
                        meter.fail("io");
                        io_code(&error)
                    })?;
                    (bytes, last_segment(target.path()).to_string())
                }
                Target::Asset { session_id, mount_id, entry, .. } => {
                    if entry.size > MAX_TRANSFER_BYTES {
                        meter.fail("too_large");
                        return Err("too_large");
                    }
                    let reader = service.asset_reader();
                    let mut bytes = Vec::with_capacity(entry.size as usize);
                    loop {
                        let slice = reader
                            .read(
                                session_id,
                                mount_id,
                                &entry.source_id,
                                bytes.len() as u64,
                                crate::assets::MAX_ASSET_SLICE,
                            )
                            .await
                            .map_err(|_| {
                                meter.fail("asset_unavailable");
                                "unavailable"
                            })?;
                        let done = slice.len() < crate::assets::MAX_ASSET_SLICE;
                        bytes.extend_from_slice(&slice);
                        if bytes.len() as u64 > MAX_TRANSFER_BYTES {
                            meter.fail("too_large");
                            return Err("too_large");
                        }
                        if done {
                            break;
                        }
                    }
                    (bytes, entry.name.clone())
                }
                Target::Virtual { .. } | Target::AssetDir { .. } => {
                    meter.fail("is_folder");
                    return Err("is_folder");
                }
            };
            meter.add(bytes.len());
            let media_type = match &target {
                Target::Asset { entry, .. } if !entry.media_type.is_empty() => entry.media_type.clone(),
                _ => media_type_for(&name),
            };
            Ok(Answer {
                result: Some(json!({ "name": name, "size": bytes.len() })),
                bytes: Some((bytes, media_type)),
            })
        }
        Op::Write => {
            let bytes = upload.ok_or("upload_mismatch")?;
            let declared = request.upload_byte_length.ok_or("upload_mismatch")?;
            let sha256 = request.upload_sha256.as_deref().ok_or("upload_mismatch")?;
            if bytes.len() as i64 != declared
                || bytes.len() as u64 > MAX_TRANSFER_BYTES
                || !hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(sha256)
            {
                return Err("upload_mismatch");
            }
            let target = gate.authorize(Op::Write, &request.path)?;
            let Target::Disk { abs, .. } = &target else {
                return Err("read_only");
            };
            let mut meter = TransferMeter::new(store.clone(), caller.clone(), Op::Write, target.clone());
            let parent = abs.parent().ok_or("not_found")?;
            if !tokio::fs::metadata(parent).await.map(|m| m.is_dir()).unwrap_or(false) {
                meter.fail("no_parent");
                return Err("not_found");
            }
            if tokio::fs::metadata(abs).await.map(|m| m.is_dir()).unwrap_or(false) {
                meter.fail("is_folder");
                return Err("is_folder");
            }
            // Written beside the target and moved over it, so a reader never
            // sees half a file and a failure leaves the old one.
            let mut suffix = [0_u8; 8];
            rand::fill(&mut suffix);
            let temp = parent.join(format!(".cognia-upload-{}", hex::encode(suffix)));
            let written = async {
                let mut file = tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)
                    .await?;
                file.write_all(&bytes).await?;
                file.sync_all().await?;
                drop(file);
                tokio::fs::rename(&temp, abs).await
            }
            .await;
            if let Err(error) = written {
                let _ = tokio::fs::remove_file(&temp).await;
                meter.fail("io");
                return Err(io_code(&error));
            }
            meter.add(bytes.len());
            Ok(Answer {
                result: Some(json!({ "size": bytes.len() })),
                bytes: None,
            })
        }
        Op::Mkdir => {
            let target = gate.authorize(Op::Mkdir, &request.path)?;
            let Target::Disk { abs, .. } = target else {
                return Err("read_only");
            };
            tokio::fs::create_dir(&abs).await.map_err(|error| io_code(&error))?;
            Ok(Answer::default())
        }
        Op::Delete => {
            let target = gate.authorize(Op::Delete, &request.path)?;
            let Target::Disk { abs, .. } = target else {
                return Err("read_only");
            };
            let meta = tokio::fs::symlink_metadata(&abs).await.map_err(|error| io_code(&error))?;
            if meta.is_dir() {
                tokio::fs::remove_dir(&abs).await
            } else {
                tokio::fs::remove_file(&abs).await
            }
            .map_err(|error| io_code(&error))?;
            Ok(Answer::default())
        }
        Op::Rename => {
            let dest = request.dest_path.as_deref().ok_or("invalid_path")?;
            let from = gate.authorize(Op::Rename, &request.path)?;
            let to = gate.authorize(Op::Write, dest)?;
            match (from, to) {
                (
                    Target::Disk { abs: source, mount_id: from_mount, .. },
                    Target::Disk { abs: destination, mount_id: to_mount, .. },
                ) => {
                    if from_mount != to_mount {
                        return Err("cross_mount");
                    }
                    if tokio::fs::symlink_metadata(&destination).await.is_ok() {
                        return Err("exists");
                    }
                    tokio::fs::rename(&source, &destination)
                        .await
                        .map_err(|error| io_code(&error))?;
                    Ok(Answer::default())
                }
                _ => Err("read_only"),
            }
        }
    }
}

/// Claim-to-answer for one request.
async fn answer(
    service: Arc<FileShareService>,
    record: CollabHostRecord,
    client: Arc<Client>,
    request: ClaimedRequest,
) -> Result<(), ServerError> {
    let caller = Caller {
        grant_id: request.grant_id.clone(),
        holder: Holder::Member {
            org_id: record.org_id.clone(),
            collab_session_id: record.collab_session_id.clone(),
            user_id: request.requester_user_id.clone(),
            role: request.requester_role,
        },
        channel: Channel::Collab,
        remote: None,
    };
    let outcome: Result<Answer, &'static str> = async {
        // Registered before the account is read: a lock or a revoke that
        // lands after this cancels the work, one that landed before leaves
        // no account to read.
        let guard = service.register_connection(&request.grant_id);
        let (store, policy) = service.context().ok_or("unavailable")?;
        // A grant of another conversation is not this registration's to serve.
        match store.grant(&request.grant_id) {
            Ok(Some(grant)) if grant.session_id == record.session_id => {}
            Ok(_) => return Err("not_found"),
            Err(_) => return Err("store"),
        }
        if request.op == "write"
            && request
                .upload_byte_length
                .is_some_and(|length| length < 0 || length as u64 > MAX_TRANSFER_BYTES)
        {
            return Err("too_large");
        }
        let upload = if request.op == "write" {
            match client.upload(&request.id).await {
                Ok(bytes) => Some(bytes),
                Err(ServerError::Gone) => return Err("gone"),
                Err(_) => return Err("unavailable"),
            }
        } else {
            None
        };
        tokio::select! {
            result = perform(&service, &store, &policy, &caller, &request, upload) => result,
            _ = guard.token.cancelled() => Err("withdrawn"),
        }
    }
    .await;
    match outcome {
        Err("gone") => Err(ServerError::Gone),
        Err(code) => {
            client
                .complete(&request.id, &json!({ "ok": false, "error": code }))
                .await
        }
        Ok(Answer { result, bytes: Some((bytes, media_type)) }) => {
            let length = bytes.len();
            client.store_result(&request.id, bytes).await?;
            client
                .complete(
                    &request.id,
                    &json!({
                        "ok": true,
                        "result": result,
                        "object": { "byteLength": length, "mediaType": media_type },
                    }),
                )
                .await
        }
        Ok(Answer { result, bytes: None }) => {
            client
                .complete(&request.id, &json!({ "ok": true, "result": result }))
                .await
        }
    }
}

// ── Loops ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
struct LoopKey {
    account_id: String,
    record: CollabHostRecord,
}

struct RunningLoop {
    key: LoopKey,
    cancel: CancellationToken,
}

#[derive(Debug, Clone, Default)]
struct Health {
    last_contact_at: Option<i64>,
    last_error: Option<String>,
}

/// The answering loops, one per registered conversation, and how each last
/// fared.
#[derive(Default)]
pub struct Responders {
    loops: Mutex<HashMap<String, RunningLoop>>,
    health: Mutex<HashMap<String, Health>>,
    /// One sync at a time: a second waits and then sees the first's work.
    sync_order: tokio::sync::Mutex<()>,
    /// A background sync is queued and has not started yet; more requests
    /// fold into it rather than pile up behind a slow server.
    sync_queued: AtomicBool,
    /// Registration changes (register, replace, unregister, a server that
    /// dropped the host) one at a time, so a check and the change it decides
    /// cannot interleave with another. Never held across a [`sync`].
    registration: tokio::sync::Mutex<()>,
}

impl Responders {
    /// Stop every loop (the account was locked or switched).
    pub fn stop_all(&self) {
        for (_, running) in self.loops.lock().drain() {
            running.cancel.cancel();
        }
    }

    fn stop(&self, session_id: &str) {
        if let Some(running) = self.loops.lock().remove(session_id) {
            running.cancel.cancel();
        }
    }

    fn is_running(&self, session_id: &str) -> bool {
        self.loops
            .lock()
            .get(session_id)
            .is_some_and(|running| !running.cancel.is_cancelled())
    }

    fn contact(&self, session_id: &str) {
        let mut health = self.health.lock();
        let entry = health.entry(session_id.to_string()).or_default();
        entry.last_contact_at = Some(now_ms());
        entry.last_error = None;
    }

    fn failed(&self, session_id: &str, error: impl Into<String>) {
        self.health
            .lock()
            .entry(session_id.to_string())
            .or_default()
            .last_error = Some(error.into());
    }

    fn health(&self, session_id: &str) -> Health {
        self.health.lock().get(session_id).cloned().unwrap_or_default()
    }
}

// The keychain can block (a locked keychain, a slow Secret Service), so its
// calls run on the blocking pool, never on the runtime's workers.

async fn read_token(account_id: &str, session_id: &str) -> Option<String> {
    let account = token_account(account_id, session_id);
    tokio::task::spawn_blocking(move || {
        cognia_secrets::secret_store::get(SECRET_SERVICE, &account)
            .ok()
            .flatten()
            .filter(|token| !token.is_empty())
    })
    .await
    .ok()
    .flatten()
}

async fn write_token(account_id: &str, session_id: &str, token: &str) -> FileShareResult<()> {
    let (account, token) = (token_account(account_id, session_id), token.to_string());
    tokio::task::spawn_blocking(move || cognia_secrets::secret_store::set(SECRET_SERVICE, &account, &token))
        .await
        .map_err(|error| FileShareError::new("secret_store_unavailable", error.to_string()))?
        .map_err(|error| FileShareError::new("secret_store_unavailable", error))
}

async fn delete_token(account_id: &str, session_id: &str) {
    let account = token_account(account_id, session_id);
    let outcome =
        tokio::task::spawn_blocking(move || cognia_secrets::secret_store::delete(SECRET_SERVICE, &account)).await;
    match outcome {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => log::warn!("file-share: could not delete the host token of {session_id}: {error}"),
        Err(error) => log::warn!("file-share: could not delete the host token of {session_id}: {error}"),
    }
}

/// The loop each usable registration of `active` should run, with its token.
async fn wanted_loops(service: &Arc<FileShareService>, active: &Active) -> HashMap<String, (LoopKey, String)> {
    let mut wanted = HashMap::new();
    for record in active.store.collab_hosts().unwrap_or_default() {
        let state = active.store.session_state(&record.session_id).ok().flatten();
        if state == Some(SessionState::Deleted) {
            continue;
        }
        let Some(token) = read_token(&active.account_id, &record.session_id).await else {
            service.collab.failed(&record.session_id, "host_token_missing");
            continue;
        };
        wanted.insert(
            record.session_id.clone(),
            (
                LoopKey {
                    account_id: active.account_id.clone(),
                    record,
                },
                token,
            ),
        );
    }
    wanted
}

/// Run the `wanted` loops of `account_id` and stop the rest.
///
/// The account is checked again under the loops' lock: a sync that began
/// before the account was locked or switched must not start loops for it
/// afterwards. The switch clears the served account before it stops the
/// loops, so either this sees the change and starts nothing, or its loops
/// are in the map when they are stopped.
fn reconcile(service: &Arc<FileShareService>, account_id: &str, wanted: HashMap<String, (LoopKey, String)>) {
    let responders = &service.collab;
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let mut loops = responders.loops.lock();
    let still_served = service
        .active()
        .is_ok_and(|active| active.account_id == account_id);
    if !still_served {
        for (_, running) in loops.drain() {
            running.cancel.cancel();
        }
        return;
    }
    loops.retain(|session_id, running| {
        let keep = wanted
            .get(session_id)
            .is_some_and(|(key, _)| *key == running.key && !running.cancel.is_cancelled());
        if !keep {
            running.cancel.cancel();
        }
        keep
    });
    for (session_id, (key, token)) in wanted {
        if loops.contains_key(&session_id) {
            continue;
        }
        let cancel = CancellationToken::new();
        handle.spawn(run(Arc::downgrade(service), key.clone(), token, cancel.clone()));
        loops.insert(session_id, RunningLoop { key, cancel });
    }
}

async fn run(service: Weak<FileShareService>, key: LoopKey, token: String, cancel: CancellationToken) {
    // However the loop ends, it reads as stopped, so the next sync starts a
    // new one instead of reporting a dead loop as running.
    let _stopped = cancel.clone().drop_guard();
    let session_id = key.record.session_id.clone();
    let client = match Client::new(&key.record, token) {
        Ok(client) => Arc::new(client),
        Err(error) => {
            if let Some(service) = service.upgrade() {
                service.collab.failed(&session_id, error.message);
            }
            return;
        }
    };
    let permits = Arc::new(tokio::sync::Semaphore::new(CONCURRENT_REQUESTS));
    let mut failures: u32 = 0;
    loop {
        // Hold a permit before claiming, so a claimed request never waits
        // behind four slow ones until it expires.
        let permit = tokio::select! {
            _ = cancel.cancelled() => return,
            permit = permits.clone().acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => return,
            },
        };
        let claimed = tokio::select! {
            _ = cancel.cancelled() => return,
            claimed = client.claim(CLAIM_WAIT_MS) => claimed,
        };
        let Some(service) = service.upgrade() else {
            return;
        };
        match claimed {
            Ok(Some(request)) => {
                failures = 0;
                service.collab.contact(&session_id);
                let (service, record, client) = (service.clone(), key.record.clone(), client.clone());
                tokio::spawn(async move {
                    let _permit = permit;
                    let request_id = request.id.clone();
                    if let Err(error) = answer(service.clone(), record.clone(), client, request).await {
                        match error {
                            ServerError::HostGone => {
                                host_gone(&service, &record).await;
                            }
                            ServerError::Gone => {
                                log::debug!("file-share: request {request_id} was no longer ours to answer");
                            }
                            other => {
                                log::warn!("file-share: answering {request_id} failed: {other}");
                                service.collab.failed(&record.session_id, other.to_string());
                            }
                        }
                    }
                });
            }
            Ok(None) => {
                failures = 0;
                service.collab.contact(&session_id);
            }
            Err(ServerError::HostGone) => {
                host_gone(&service, &key.record).await;
                return;
            }
            Err(error) => {
                failures = failures.saturating_add(1);
                service.collab.failed(&session_id, error.to_string());
                drop(service);
                let delay = Duration::from_secs(1_u64 << failures.min(6)).min(MAX_BACKOFF);
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
}

// ── Registration lifecycle ──────────────────────────────────────────────────

/// End a conversation's registration here: forget it and its token, stop its
/// loop, and revoke the members' grants made under it (the server revoked its
/// copies when the registration ended there). Their final state needs no
/// push: there is no registration left to push it to.
async fn end_registration(
    service: &Arc<FileShareService>,
    active: &Active,
    session_id: &str,
    why: &str,
    principal: &str,
) {
    service.collab.stop(session_id);
    let had = active.store.delete_collab_host(session_id).unwrap_or(false);
    delete_token(&active.account_id, session_id).await;
    let mut effects = Effects::default();
    for grant in active.store.list_grants(Some(session_id)).unwrap_or_default() {
        if !grant.audience.is_collab() || grant.status.is_terminal() {
            continue;
        }
        match grants::revoke(&active.store, &grant.id, status_reason::COLLAB_HOST_REMOVED, principal, now_ms()) {
            Ok(more) => effects.merge(more),
            Err(error) => log::warn!("file-share: could not revoke {}: {error}", grant.id),
        }
    }
    for (grant, revision) in active.store.grants_to_mirror().unwrap_or_default() {
        if grant.session_id == session_id && grant.status.is_terminal() {
            let _ = active.store.mark_mirrored(&grant.id, revision);
        }
    }
    service.apply_effects(active, effects).await;
    service.collab.failed(session_id, why);
    if had {
        audit::record(
            &active.store,
            now_ms(),
            Event {
                session_id: Some(session_id),
                principal,
                action: "collab.host.end",
                reason: Some(why),
                ..Event::default()
            },
        );
    }
}

/// The server refused the token: if the registration is still the one that
/// was refused, end it.
async fn host_gone(service: &Arc<FileShareService>, record: &CollabHostRecord) {
    let _registration = service.collab.registration.lock().await;
    let Ok(active) = service.active() else {
        return;
    };
    if active.store.collab_host(&record.session_id).ok().flatten().as_ref() != Some(record) {
        return;
    }
    end_registration(service, &active, &record.session_id, "host_unregistered", "system").await;
}

/// Register (with `Some`) or unregister this host for one conversation.
pub(crate) async fn set_host(
    service: &Arc<FileShareService>,
    session_id: &str,
    input: Option<CollabHostInput>,
    principal: &str,
) -> FileShareResult<CollabHostStatus> {
    if session_id.is_empty() || session_id.len() > 256 {
        return Err(FileShareError::invalid("not a conversation id"));
    }
    change_registration(service, session_id, input, principal).await?;
    sync(service).await;
    status(service, session_id).await
}

async fn change_registration(
    service: &Arc<FileShareService>,
    session_id: &str,
    input: Option<CollabHostInput>,
    principal: &str,
) -> FileShareResult<()> {
    let _registration = service.collab.registration.lock().await;
    let active = service.active()?;
    match input {
        Some(input) => {
            let now = now_ms();
            let record = input.record(session_id, now)?;
            if active.store.session_state(session_id)? == Some(SessionState::Deleted) {
                return Err(FileShareError::new(
                    "session_inactive",
                    "a deleted conversation cannot be served to its members",
                ));
            }
            // A new registration replaced the old one on the server, which
            // revoked the grants made under it: so are they here.
            if active.store.collab_host(session_id)?.is_some() {
                end_registration(service, &active, session_id, "replaced", principal).await;
            }
            write_token(&active.account_id, session_id, input.host_token.trim()).await?;
            active.store.put_collab_host(&record)?;
            service.collab.health.lock().remove(session_id);
            audit::record(
                &active.store,
                now,
                Event {
                    session_id: Some(session_id),
                    principal,
                    action: "collab.host.register",
                    reason: Some(&record.collab_session_id),
                    ..Event::default()
                },
            );
        }
        None => {
            if let Some(record) = active.store.collab_host(session_id)? {
                if let Some(token) = read_token(&active.account_id, session_id).await {
                    if let Ok(client) = Client::new(&record, token) {
                        match client.unregister().await {
                            Ok(()) | Err(ServerError::HostGone) => {}
                            Err(error) => log::warn!(
                                "file-share: the server did not take the unregistration of {session_id}: {error}"
                            ),
                        }
                    }
                }
                end_registration(service, &active, session_id, "unregistered", principal).await;
            }
        }
    }
    Ok(())
}

/// One conversation's registration and how its loop fares.
pub(crate) async fn status(service: &Arc<FileShareService>, session_id: &str) -> FileShareResult<CollabHostStatus> {
    let active = service.active()?;
    let registration = active.store.collab_host(session_id)?;
    let health = service.collab.health(session_id);
    let unmirrored_grants = active
        .store
        .grants_to_mirror()?
        .iter()
        .filter(|(grant, _)| grant.session_id == session_id)
        .count();
    Ok(CollabHostStatus {
        session_id: session_id.to_string(),
        token_present: registration.is_some() && read_token(&active.account_id, session_id).await.is_some(),
        running: service.collab.is_running(session_id),
        registration,
        last_contact_at: health.last_contact_at,
        last_error: health.last_error,
        unmirrored_grants,
    })
}

/// Publish every members' grant whose state the server has not accepted.
async fn push_mirrors(service: &Arc<FileShareService>, active: &Active) {
    // Two passes: a refusal here (org policy, a final state on the server)
    // changes a grant, and the change is pushed in the same sync.
    for _ in 0..2 {
        let Ok(due) = active.store.grants_to_mirror() else {
            return;
        };
        if due.is_empty() {
            return;
        }
        let mut clients: HashMap<String, Option<(CollabHostRecord, Client)>> = HashMap::new();
        let mut effects = Effects::default();
        let mut gone: Vec<CollabHostRecord> = Vec::new();
        for (grant, revision) in due {
            if !clients.contains_key(&grant.session_id) {
                let record = active.store.collab_host(&grant.session_id).ok().flatten();
                let client = match record {
                    Some(record) => read_token(&active.account_id, &grant.session_id)
                        .await
                        .and_then(|token| Client::new(&record, token).ok().map(|client| (record, client))),
                    None => None,
                };
                clients.insert(grant.session_id.clone(), client);
            }
            let client = clients.get_mut(&grant.session_id).expect("inserted above");
            let Some((record, client)) = client else {
                // No registration: maintenance revokes the grant, and the
                // server already revoked its copy when the registration ended.
                if grant.status.is_terminal() {
                    let _ = active.store.mark_mirrored(&grant.id, revision);
                }
                continue;
            };
            if !grants::binding_current(&active.store, &grant).unwrap_or(false) {
                continue;
            }
            match client.put_grant(&grant).await {
                Ok(()) => {
                    let _ = active.store.mark_mirrored(&grant.id, revision);
                }
                Err(ServerError::HostGone) => {
                    gone.push(record.clone());
                }
                Err(ServerError::Policy(reason)) if grant.status == GrantStatus::Active => {
                    log::info!("file-share: the org policy refused {} ({reason}); suspending it", grant.id);
                    if let Ok(more) =
                        grants::suspend(&active.store, &grant.id, status_reason::ORG_POLICY, "system", now_ms())
                    {
                        effects.merge(more);
                    }
                }
                Err(ServerError::Conflict) => {
                    // The server holds it revoked; so must this host.
                    if !grant.status.is_terminal() {
                        if let Ok(more) = grants::revoke(
                            &active.store,
                            &grant.id,
                            status_reason::COLLAB_HOST_REMOVED,
                            "system",
                            now_ms(),
                        ) {
                            effects.merge(more);
                        }
                    } else {
                        let _ = active.store.mark_mirrored(&grant.id, revision);
                    }
                }
                Err(ServerError::Rejected(detail)) => {
                    log::warn!("file-share: the server rejected the mirror of {}: {detail}", grant.id);
                    service.collab.failed(&grant.session_id, format!("mirror_rejected: {detail}"));
                    let _ = active.store.mark_mirrored(&grant.id, revision);
                }
                Err(error) => {
                    service.collab.failed(&grant.session_id, error.to_string());
                }
            }
        }
        service.apply_effects(active, effects).await;
        gone.dedup();
        for record in gone {
            host_gone(service, &record).await;
        }
    }
}

/// A deleted conversation's registration ends: the host unregisters itself.
async fn unregister_deleted(service: &Arc<FileShareService>, active: &Active) {
    for record in active.store.collab_hosts().unwrap_or_default() {
        if active.store.session_state(&record.session_id).ok().flatten() != Some(SessionState::Deleted) {
            continue;
        }
        let _registration = service.collab.registration.lock().await;
        // Replaced or ended while this pass ran: not this record's to end.
        if active.store.collab_host(&record.session_id).ok().flatten().as_ref() != Some(&record) {
            continue;
        }
        if let Some(token) = read_token(&active.account_id, &record.session_id).await {
            if let Ok(client) = Client::new(&record, token) {
                match client.unregister().await {
                    Ok(()) | Err(ServerError::HostGone) => {}
                    // Unreachable: keep the registration and try again on
                    // the next pass rather than leave the server's copy.
                    Err(error) => {
                        service.collab.failed(&record.session_id, error.to_string());
                        continue;
                    }
                }
            }
        }
        end_registration(service, active, &record.session_id, "session_deleted", "system").await;
    }
}

/// Bring the server and the loops in line with this host: push pending
/// mirrors, unregister deleted conversations, run a loop per registration.
pub(crate) async fn sync(service: &Arc<FileShareService>) {
    let _order = service.collab.sync_order.lock().await;
    sync_now(service).await;
}

async fn sync_now(service: &Arc<FileShareService>) {
    let Ok(active) = service.active() else {
        service.collab.stop_all();
        return;
    };
    push_mirrors(service, &active).await;
    unregister_deleted(service, &active).await;
    let wanted = wanted_loops(service, &active).await;
    reconcile(service, &active.account_id, wanted);
}

/// [`sync`] in the background, so a command that changed a grant answers
/// without waiting on the collaboration server. Requests made while one is
/// queued fold into it: it has not read anything yet, so it sees their
/// changes too.
pub(crate) fn spawn_sync(service: &Arc<FileShareService>) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    if service.collab.sync_queued.swap(true, Ordering::AcqRel) {
        return;
    }
    let service = service.clone();
    handle.spawn(async move {
        let _order = service.collab.sync_order.lock().await;
        // From here on a change asks for another sync.
        service.collab.sync_queued.store(false, Ordering::Release);
        sync_now(&service).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};

    use axum::extract::{Path, Query, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::{get, post, put};
    use axum::{Json, Router};

    use crate::assets::tests::MemoryAssets;
    use crate::gateway::tests::{fixture, for_members, member, open_policy};
    use crate::model::{AudienceRequest, CreateGrantRequest, CreatedBy, Permission, ProviderKind};

    const TOKEN: &str = "fht_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    // ── A collaboration server's file-host routes, in memory ──────────────

    #[derive(Default)]
    struct Fake {
        queue: Mutex<VecDeque<Value>>,
        uploads: Mutex<HashMap<String, Vec<u8>>>,
        results: Mutex<HashMap<String, Vec<u8>>>,
        completions: Mutex<Vec<(String, Value)>>,
        grants: Mutex<HashMap<String, Value>>,
        unregistered: AtomicBool,
        /// Answer every host call with this status (and body).
        refuse: Mutex<Option<(u16, Value)>>,
        /// Refuse active mirrors as the org policy would.
        policy_reason: Mutex<Option<String>>,
    }

    type Shared = Arc<Fake>;

    fn gate(fake: &Fake, headers: &HeaderMap) -> Option<Response> {
        if let Some((status, body)) = fake.refuse.lock().clone() {
            return Some((StatusCode::from_u16(status).unwrap(), Json(body)).into_response());
        }
        let token = headers.get(HOST_TOKEN_HEADER).and_then(|v| v.to_str().ok());
        let protocol = headers.get(PROTOCOL_HEADER).and_then(|v| v.to_str().ok());
        if token != Some(TOKEN) || protocol != Some(PROTOCOL_VERSION) {
            return Some(StatusCode::UNAUTHORIZED.into_response());
        }
        None
    }

    async fn claim(State(fake): State<Shared>, headers: HeaderMap, Query(_q): Query<HashMap<String, String>>) -> Response {
        if let Some(refused) = gate(&fake, &headers) {
            return refused;
        }
        if let Some(next) = fake.queue.lock().pop_front() {
            return Json(next).into_response();
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        StatusCode::NO_CONTENT.into_response()
    }

    async fn upload(State(fake): State<Shared>, headers: HeaderMap, Path((_, _, rid)): Path<(String, String, String)>) -> Response {
        if let Some(refused) = gate(&fake, &headers) {
            return refused;
        }
        match fake.uploads.lock().get(&rid) {
            Some(bytes) => bytes.clone().into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn result(
        State(fake): State<Shared>,
        headers: HeaderMap,
        Path((_, _, rid)): Path<(String, String, String)>,
        body: Bytes,
    ) -> Response {
        if let Some(refused) = gate(&fake, &headers) {
            return refused;
        }
        fake.results.lock().insert(rid, body.to_vec());
        StatusCode::NO_CONTENT.into_response()
    }

    async fn complete(
        State(fake): State<Shared>,
        headers: HeaderMap,
        Path((_, _, rid)): Path<(String, String, String)>,
        Json(body): Json<Value>,
    ) -> Response {
        if let Some(refused) = gate(&fake, &headers) {
            return refused;
        }
        fake.completions.lock().push((rid, body));
        StatusCode::NO_CONTENT.into_response()
    }

    async fn mirror(
        State(fake): State<Shared>,
        headers: HeaderMap,
        Path((_, _, gid)): Path<(String, String, String)>,
        Json(body): Json<Value>,
    ) -> Response {
        if let Some(refused) = gate(&fake, &headers) {
            return refused;
        }
        if body["status"] == "active" {
            if let Some(reason) = fake.policy_reason.lock().clone() {
                return (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden", "reason": reason }))).into_response();
            }
        }
        fake.grants.lock().insert(gid, body.clone());
        Json(body).into_response()
    }

    async fn unregister(State(fake): State<Shared>, headers: HeaderMap) -> Response {
        if let Some(refused) = gate(&fake, &headers) {
            return refused;
        }
        fake.unregistered.store(true, Ordering::SeqCst);
        StatusCode::NO_CONTENT.into_response()
    }

    async fn serve_fake() -> (Shared, String) {
        let _ = cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default());
        let fake: Shared = Arc::default();
        let base = "/v1/orgs/{org}/chat-sessions/{session}";
        let app = Router::new()
            .route(&format!("{base}/file-host"), axum::routing::delete(unregister))
            .route(&format!("{base}/file-host/claim"), post(claim))
            .route(&format!("{base}/file-host/grants/{{gid}}"), put(mirror))
            .route(&format!("{base}/file-host/requests/{{rid}}/upload"), get(upload))
            .route(&format!("{base}/file-host/requests/{{rid}}/result"), put(result))
            .route(&format!("{base}/file-host/requests/{{rid}}/complete"), post(complete))
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (fake, format!("http://{address}"))
    }

    async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
        for _ in 0..200 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting for {what}");
    }

    fn input(server_url: &str) -> CollabHostInput {
        CollabHostInput {
            org_id: "org_1".into(),
            collab_session_id: "ses_1".into(),
            server_url: server_url.into(),
            host_label: "Studio Mac".into(),
            host_token: TOKEN.into(),
        }
    }

    fn members_request(permissions: &[Permission]) -> CreateGrantRequest {
        let mut paths = vec!["/workspace/src".to_string()];
        // Uploads are read-only; a writable share leaves them out.
        if !permissions.contains(&Permission::Write) {
            paths.push("/uploads".into());
        }
        CreateGrantRequest {
            session_id: "s1".into(),
            paths,
            permissions: permissions.to_vec(),
            protocols: Vec::new(),
            provider: ProviderKind::Builtin,
            expires_in_seconds: 3600,
            label: Some("Review".into()),
            ssh_public_key: None,
            created_by: CreatedBy::User,
            audience: AudienceRequest::Collab {
                user_ids: None,
                min_role: CollabRole::Viewer,
            },
        }
    }

    fn service(account: &str, permissions: Vec<Permission>) -> (Arc<FileShareService>, tempfile::TempDir, String) {
        let f = fixture(permissions, vec![]);
        let root = f.root.clone();
        let service = FileShareService::for_tests_account(f.store, open_policy(), account);
        service.set_asset_reader(Arc::new(MemoryAssets(HashMap::from([(
            "m-photo".to_string(),
            b"photo".to_vec(),
        )]))));
        (service, f.dir, root)
    }

    fn claimed(id: &str, grant_id: &str, op: &str, path: &str) -> Value {
        json!({
            "id": id,
            "grantId": grant_id,
            "requesterUserId": "usr_m",
            "requesterRole": "member",
            "op": op,
            "path": path,
            "expiresAt": now_ms() + 60_000,
        })
    }

    fn completion(fake: &Fake, id: &str) -> Option<Value> {
        fake.completions
            .lock()
            .iter()
            .find(|(rid, _)| rid == id)
            .map(|(_, body)| body.clone())
    }

    // ── Pure pieces ───────────────────────────────────────────────────────

    #[test]
    fn the_server_is_reached_over_https_or_on_this_machine() {
        assert_eq!(
            normalized_server_url("https://collab.example/api/").unwrap(),
            "https://collab.example/api"
        );
        assert!(normalized_server_url("http://127.0.0.1:8080").is_ok());
        assert!(normalized_server_url("http://localhost:8080").is_ok());
        assert!(normalized_server_url("http://[::1]:8080").is_ok());
        for refused in [
            "http://collab.example",
            "https://collab.example/?x=1",
            "https://user:pw@collab.example",
            "ftp://collab.example",
            "not a url",
        ] {
            assert!(normalized_server_url(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_registration_is_checked_before_anything_is_kept() {
        let ok = input("https://collab.example");
        let record = ok.record("s1", 7).unwrap();
        assert_eq!(record.server_url, "https://collab.example");
        assert_eq!((record.registered_at, record.updated_at), (7, 7));
        let refused = |change: fn(&mut CollabHostInput)| {
            let mut bad = input("https://collab.example");
            change(&mut bad);
            bad.record("s1", 1).unwrap_err().code
        };
        assert_eq!(refused(|i| i.host_token = "fht_short".into()), "invalid_request");
        assert_eq!(refused(|i| i.host_token = TOKEN.replace("fht_", "xxx_")), "invalid_request");
        assert_eq!(refused(|i| i.org_id = "org/../x".into()), "invalid_request");
        assert_eq!(refused(|i| i.collab_session_id = String::new()), "invalid_request");
        assert_eq!(refused(|i| i.host_label = "  ".into()), "invalid_request");
        assert_eq!(refused(|i| i.server_url = "http://collab.example".into()), "invalid_request");
        assert_eq!(token_account("acct", "s1"), "collab-host:acct:s1");
    }

    #[test]
    fn the_mirror_says_who_what_and_where_but_nothing_local() {
        let mut grant = crate::store::tests::sample_collab_grant("fg_9", "s1");
        grant.paths[0].mount_fingerprint = "secret-ish".into();
        let body = mirror_body(&grant);
        assert_eq!(
            body,
            json!({
                "label": "Report",
                "userIds": ["usr_a"],
                "minRole": "member",
                "permissions": ["read", "download"],
                "paths": [{ "path": "/workspace/src", "isDir": true }],
                "status": "active",
                "expiresAt": 10_000,
                "createdAt": 100,
            })
        );
        assert!(!body.to_string().contains("secret-ish"));
    }

    #[test]
    fn server_errors_name_what_happened() {
        assert_eq!(ServerError::HostGone.to_string(), "host_unregistered");
        assert_eq!(ServerError::Policy("org_x".into()).to_string(), "org_policy: org_x");
        assert!(ServerError::Transient("down".into()).to_string().contains("down"));
    }

    // ── Answering, through the gateway ────────────────────────────────────

    async fn perform_as(
        service: &Arc<FileShareService>,
        role: CollabRole,
        op: &str,
        path: &str,
        dest: Option<&str>,
        upload: Option<&[u8]>,
    ) -> Result<Answer, &'static str> {
        let (store, policy) = service.context().unwrap();
        let caller = Caller {
            grant_id: "fg_m".into(),
            ..member("usr_m", role)
        };
        let request = ClaimedRequest {
            id: "frq_1".into(),
            grant_id: "fg_m".into(),
            requester_user_id: "usr_m".into(),
            requester_role: role,
            op: op.into(),
            path: path.into(),
            dest_path: dest.map(str::to_string),
            upload_byte_length: upload.map(|bytes| bytes.len() as i64),
            upload_sha256: upload.map(|bytes| hex::encode(Sha256::digest(bytes))),
            expires_at: now_ms() + 60_000,
        };
        perform(service, &store, &policy, &caller, &request, upload.map(Bytes::copy_from_slice)).await
    }

    fn members_fixture(permissions: Vec<Permission>) -> (Arc<FileShareService>, tempfile::TempDir, String) {
        let f = fixture(permissions, vec![("workspace", "src", true), ("uploads", "", true)]);
        for_members(&f, None, CollabRole::Viewer);
        let root = f.root.clone();
        let service = FileShareService::for_tests_account(f.store, open_policy(), "perform");
        service.set_asset_reader(Arc::new(MemoryAssets(HashMap::from([(
            "m-photo".to_string(),
            b"photo".to_vec(),
        )]))));
        (service, f.dir, root)
    }

    #[tokio::test]
    async fn members_list_stat_and_read_what_the_grant_covers() {
        let (service, _dir, _root) = members_fixture(vec![Permission::Read, Permission::Download]);
        let root = perform_as(&service, CollabRole::Viewer, "list", "/", None, None).await.unwrap();
        assert_eq!(
            root.result.unwrap()["entries"],
            json!([
                { "name": "uploads", "isDir": true, "size": 0, "modifiedAt": 0 },
                { "name": "workspace", "isDir": true, "size": 0, "modifiedAt": 0 },
            ])
        );
        let src = perform_as(&service, CollabRole::Viewer, "list", "/workspace/src", None, None)
            .await
            .unwrap()
            .result
            .unwrap();
        let names: Vec<&str> = src["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["nested", "a.txt"], ".env stays hidden");
        assert_eq!(src["truncated"], false);
        let stat = perform_as(&service, CollabRole::Viewer, "stat", "/workspace/src/a.txt", None, None)
            .await
            .unwrap()
            .result
            .unwrap();
        assert_eq!((stat["name"].as_str(), stat["size"].as_u64(), stat["isDir"].as_bool()), (Some("a.txt"), Some(5), Some(false)));

        let read = perform_as(&service, CollabRole::Viewer, "read", "/workspace/src/a.txt", None, None)
            .await
            .unwrap();
        assert_eq!(read.bytes, Some((b"alpha".to_vec(), "text/plain".to_string())));
        let photo = perform_as(&service, CollabRole::Viewer, "read", "/uploads/photo.png", None, None)
            .await
            .unwrap();
        assert_eq!(photo.bytes, Some((b"photo".to_vec(), "image/png".to_string())));

        for (path, code) in [
            ("/workspace/README.md", "not_found"),
            ("/workspace/src/.env", "sensitive"),
            ("/workspace/src", "is_folder"),
            ("/workspace/src/missing.txt", "not_found"),
        ] {
            assert_eq!(
                perform_as(&service, CollabRole::Viewer, "read", path, None, None).await.unwrap_err(),
                code,
                "{path}"
            );
        }
        assert_eq!(
            perform_as(&service, CollabRole::Viewer, "chmod", "/", None, None).await.unwrap_err(),
            "unsupported"
        );
        let (store, _) = service.context().unwrap();
        let audit = store.list_audit(Some("s1"), Some("fg_m"), None, 50).unwrap();
        assert!(audit
            .iter()
            .any(|row| row.action == "fs.read" && row.principal == "member:usr_m" && row.bytes == Some(5)));
    }

    #[tokio::test]
    async fn members_change_files_only_with_write_and_a_member_role() {
        let (service, _dir, root) = members_fixture(vec![Permission::Read, Permission::Download, Permission::Write]);
        let root = std::path::PathBuf::from(root);
        let body = b"fresh contents";
        assert_eq!(
            perform_as(&service, CollabRole::Viewer, "write", "/workspace/src/new.txt", None, Some(body))
                .await
                .unwrap_err(),
            "permission"
        );
        let wrote = perform_as(&service, CollabRole::Member, "write", "/workspace/src/new.txt", None, Some(body))
            .await
            .unwrap();
        assert_eq!(wrote.result.unwrap()["size"], body.len());
        assert_eq!(std::fs::read(root.join("src/new.txt")).unwrap(), body);
        // No temp file is left beside it.
        assert!(std::fs::read_dir(root.join("src"))
            .unwrap()
            .all(|entry| !entry.unwrap().file_name().to_string_lossy().starts_with(".cognia-upload")));

        // Bytes that are not the ones declared are refused.
        let (store, policy) = service.context().unwrap();
        let caller = Caller {
            grant_id: "fg_m".into(),
            ..member("usr_m", CollabRole::Member)
        };
        let lying = ClaimedRequest {
            id: "frq_2".into(),
            grant_id: "fg_m".into(),
            requester_user_id: "usr_m".into(),
            requester_role: CollabRole::Member,
            op: "write".into(),
            path: "/workspace/src/a.txt".into(),
            dest_path: None,
            upload_byte_length: Some(3),
            upload_sha256: Some(hex::encode(Sha256::digest(b"abc"))),
            expires_at: now_ms() + 60_000,
        };
        assert_eq!(
            perform(&service, &store, &policy, &caller, &lying, Some(Bytes::from_static(b"abd")))
                .await
                .unwrap_err(),
            "upload_mismatch"
        );
        assert_eq!(std::fs::read(root.join("src/a.txt")).unwrap(), b"alpha");

        perform_as(&service, CollabRole::Member, "mkdir", "/workspace/src/dir", None, None).await.unwrap();
        assert!(root.join("src/dir").is_dir());
        assert_eq!(
            perform_as(&service, CollabRole::Member, "mkdir", "/workspace/src/dir", None, None).await.unwrap_err(),
            "exists"
        );
        assert_eq!(
            perform_as(&service, CollabRole::Member, "rename", "/workspace/src/new.txt", Some("/workspace/src/a.txt"), None)
                .await
                .unwrap_err(),
            "exists"
        );
        perform_as(&service, CollabRole::Member, "rename", "/workspace/src/new.txt", Some("/workspace/src/dir/moved.txt"), None)
            .await
            .unwrap();
        assert!(root.join("src/dir/moved.txt").is_file());
        assert_eq!(
            perform_as(&service, CollabRole::Member, "delete", "/workspace/src/dir", None, None).await.unwrap_err(),
            "not_empty"
        );
        perform_as(&service, CollabRole::Member, "delete", "/workspace/src/dir/moved.txt", None, None).await.unwrap();
        perform_as(&service, CollabRole::Member, "delete", "/workspace/src/dir", None, None).await.unwrap();
        assert!(!root.join("src/dir").exists());
        assert_eq!(
            perform_as(&service, CollabRole::Member, "delete", "/workspace/src", None, None).await.unwrap_err(),
            "grant_root"
        );
        assert_eq!(
            perform_as(&service, CollabRole::Member, "write", "/uploads/new.txt", None, Some(body))
                .await
                .unwrap_err(),
            "read_only"
        );
        assert_eq!(
            perform_as(&service, CollabRole::Member, "rename", "/workspace/src/a.txt", None, None).await.unwrap_err(),
            "invalid_path"
        );
    }

    // ── Against a collaboration server ────────────────────────────────────

    #[tokio::test]
    async fn a_registered_host_mirrors_its_grants_and_answers_members() {
        let (fake, url) = serve_fake().await;
        let (service, _dir, root) = service("e2e", vec![Permission::Read]);
        let status = service.set_collab_host("s1", Some(input(&url)), "owner").await.unwrap();
        assert!(status.registration.is_some() && status.token_present && status.running);

        let created = service
            .create_grant(members_request(&[Permission::Read, Permission::Download, Permission::Write]), "owner")
            .await
            .unwrap();
        assert!(created.credentials.is_empty());
        let grant_id = created.grant.id.clone();
        sync(&service).await;
        let mirrored = fake.grants.lock().get(&grant_id).cloned().expect("mirrored");
        assert_eq!(mirrored["status"], "active");
        assert_eq!(mirrored["minRole"], "viewer");
        assert_eq!(service.collab_host_status("s1").await.unwrap().unmirrored_grants, 0);

        fake.queue.lock().push_back(claimed("frq_list", &grant_id, "list", "/workspace/src"));
        fake.queue.lock().push_back(claimed("frq_read", &grant_id, "read", "/workspace/src/a.txt"));
        fake.uploads.lock().insert("frq_write".into(), b"from a member".to_vec());
        let mut write = claimed("frq_write", &grant_id, "write", "/workspace/src/member.txt");
        write["uploadByteLength"] = json!(13);
        write["uploadSha256"] = json!(hex::encode(Sha256::digest(b"from a member")));
        fake.queue.lock().push_back(write);
        fake.queue.lock().push_back(claimed("frq_secret", &grant_id, "read", "/workspace/src/.env"));

        eventually("four answers", || fake.completions.lock().len() == 4).await;
        let list = completion(&fake, "frq_list").unwrap();
        assert_eq!(list["ok"], true);
        assert!(list["result"]["entries"].as_array().unwrap().iter().any(|e| e["name"] == "a.txt"));
        let read = completion(&fake, "frq_read").unwrap();
        assert_eq!(read["object"], json!({ "byteLength": 5, "mediaType": "text/plain" }));
        assert_eq!(fake.results.lock().get("frq_read").unwrap(), b"alpha");
        assert_eq!(completion(&fake, "frq_write").unwrap()["ok"], true);
        assert_eq!(
            std::fs::read(std::path::Path::new(&root).join("src/member.txt")).unwrap(),
            b"from a member"
        );
        assert_eq!(completion(&fake, "frq_secret").unwrap(), json!({ "ok": false, "error": "sensitive" }));
        assert!(service.collab_host_status("s1").await.unwrap().last_contact_at.is_some());

        // Revoking publishes the final state.
        service.revoke_grant(&grant_id, "owner").await.unwrap();
        sync(&service).await;
        assert_eq!(fake.grants.lock().get(&grant_id).unwrap()["status"], "revoked");

        // The server refusing the token ends the registration and its grants.
        let second = service
            .create_grant(members_request(&[Permission::Read]), "owner")
            .await
            .unwrap()
            .grant
            .id;
        sync(&service).await;
        *fake.refuse.lock() = Some((401, json!({ "error": "unauthorized" })));
        let (store, _) = service.context().unwrap();
        eventually("the registration to end", || store.collab_host("s1").unwrap().is_none()).await;
        let ended = store.grant(&second).unwrap().unwrap();
        assert_eq!(
            (ended.status, ended.status_reason.as_deref()),
            (GrantStatus::Revoked, Some(status_reason::COLLAB_HOST_REMOVED))
        );
        let status = service.collab_host_status("s1").await.unwrap();
        assert!(!status.running && !status.token_present);
        assert_eq!(status.last_error.as_deref(), Some("host_unregistered"));
        assert_eq!(status.unmirrored_grants, 0, "nothing is left to push anywhere");
        assert!(store
            .list_audit(Some("s1"), None, None, 100)
            .unwrap()
            .iter()
            .any(|row| row.action == "collab.host.end"));
    }

    #[tokio::test]
    async fn the_org_policy_refusing_a_grant_suspends_it_here() {
        let (fake, url) = serve_fake().await;
        let (service, _dir, _root) = service("policy", vec![Permission::Read]);
        *fake.policy_reason.lock() = Some("org_file_sharing_policy_write".into());
        service.set_collab_host("s1", Some(input(&url)), "owner").await.unwrap();
        let id = service
            .create_grant(members_request(&[Permission::Read]), "owner")
            .await
            .unwrap()
            .grant
            .id;
        sync(&service).await;
        let (store, _) = service.context().unwrap();
        let grant = store.grant(&id).unwrap().unwrap();
        assert_eq!(
            (grant.status, grant.status_reason.as_deref()),
            (GrantStatus::Suspended, Some(status_reason::ORG_POLICY))
        );
        assert_eq!(fake.grants.lock().get(&id).unwrap()["status"], "suspended");
        service.set_collab_host("s1", None, "owner").await.unwrap();
    }

    #[tokio::test]
    async fn clearing_or_deleting_ends_the_registration_on_both_sides() {
        let (fake, url) = serve_fake().await;
        let (service, _dir, _root) = service("clear", vec![Permission::Read]);
        service.set_collab_host("s1", Some(input(&url)), "owner").await.unwrap();
        let id = service
            .create_grant(members_request(&[Permission::Read]), "owner")
            .await
            .unwrap()
            .grant
            .id;
        let status = service.set_collab_host("s1", None, "owner").await.unwrap();
        assert!(fake.unregistered.swap(false, Ordering::SeqCst));
        assert!(status.registration.is_none() && !status.running);
        let (store, _) = service.context().unwrap();
        assert_eq!(store.grant(&id).unwrap().unwrap().status, GrantStatus::Revoked);

        // A deleted conversation unregisters itself on the next pass.
        service.set_collab_host("s1", Some(input(&url)), "owner").await.unwrap();
        store.set_session_state("s1", SessionState::Deleted, now_ms()).unwrap();
        sync(&service).await;
        assert!(fake.unregistered.load(Ordering::SeqCst));
        assert!(store.collab_host("s1").unwrap().is_none());
        assert_eq!(
            service.set_collab_host("s1", Some(input(&url)), "owner").await.unwrap_err().code,
            "session_inactive"
        );
    }

    #[tokio::test]
    async fn a_new_registration_replaces_the_old_and_its_grants() {
        let (_fake, url) = serve_fake().await;
        let (service, _dir, _root) = service("replace", vec![Permission::Read]);
        service.set_collab_host("s1", Some(input(&url)), "owner").await.unwrap();
        let id = service
            .create_grant(members_request(&[Permission::Read]), "owner")
            .await
            .unwrap()
            .grant
            .id;
        service.set_collab_host("s1", Some(input(&url)), "owner").await.unwrap();
        let (store, _) = service.context().unwrap();
        assert_eq!(store.grant(&id).unwrap().unwrap().status, GrantStatus::Revoked);
        assert!(service.collab_host_status("s1").await.unwrap().running);
        service.set_collab_host("s1", None, "owner").await.unwrap();
    }

    #[tokio::test]
    async fn a_sync_for_an_account_no_longer_served_starts_no_loops() {
        let (_fake, url) = serve_fake().await;
        let (service, _dir, _root) = service("served", vec![Permission::Read]);
        service.set_collab_host("s1", Some(input(&url)), "owner").await.unwrap();
        assert!(service.collab.is_running("s1"));
        let active = service.active().unwrap();

        // A sync that read the account before it was switched.
        service.collab.stop_all();
        let wanted = wanted_loops(&service, &active).await;
        assert_eq!(wanted.len(), 1);
        reconcile(&service, "another-account", wanted);
        assert!(!service.collab.is_running("s1"));
        assert!(service.collab.loops.lock().is_empty());

        // The served account's own sync starts it again.
        let wanted = wanted_loops(&service, &active).await;
        reconcile(&service, "served", wanted);
        assert!(service.collab.is_running("s1"));
        service.set_collab_host("s1", None, "owner").await.unwrap();
    }

    #[tokio::test]
    async fn a_loop_that_ends_reads_as_stopped() {
        let (fake, url) = serve_fake().await;
        *fake.refuse.lock() = Some((401, json!({ "error": "unauthorized" })));
        let (service, _dir, _root) = service("ended", vec![Permission::Read]);
        let record = input(&url).record("s1", now_ms()).unwrap();
        let cancel = CancellationToken::new();
        let key = LoopKey {
            account_id: "ended".into(),
            record,
        };
        run(Arc::downgrade(&service), key, TOKEN.into(), cancel.clone()).await;
        assert!(cancel.is_cancelled(), "a loop the server ended is not reported running");
    }

    #[tokio::test]
    async fn a_write_declared_too_large_is_refused_before_its_bytes_are_fetched() {
        let (fake, url) = serve_fake().await;
        let (service, _dir, _root) = service("large", vec![Permission::Read, Permission::Write]);
        service.set_collab_host("s1", Some(input(&url)), "owner").await.unwrap();
        let grant_id = service
            .create_grant(members_request(&[Permission::Read, Permission::Write]), "owner")
            .await
            .unwrap()
            .grant
            .id;
        let mut write = claimed("frq_big", &grant_id, "write", "/workspace/src/big.bin");
        write["uploadByteLength"] = json!(MAX_TRANSFER_BYTES + 1);
        write["uploadSha256"] = json!("00".repeat(32));
        fake.queue.lock().push_back(write);
        eventually("the refusal", || completion(&fake, "frq_big").is_some()).await;
        assert_eq!(completion(&fake, "frq_big").unwrap(), json!({ "ok": false, "error": "too_large" }));
        service.set_collab_host("s1", None, "owner").await.unwrap();
    }

    #[tokio::test]
    async fn background_syncs_fold_into_the_one_already_queued() {
        let (service, _dir, _root) = service("folded", vec![Permission::Read]);
        // Hold the order so the queued sync cannot start.
        let order = service.collab.sync_order.lock().await;
        spawn_sync(&service);
        assert!(service.collab.sync_queued.load(Ordering::Acquire));
        for _ in 0..50 {
            spawn_sync(&service);
        }
        assert!(service.collab.sync_queued.load(Ordering::Acquire));
        drop(order);
        eventually("the queued sync to start", || {
            !service.collab.sync_queued.load(Ordering::Acquire)
        })
        .await;
        // The next change queues a new one.
        spawn_sync(&service);
        eventually("the next sync to start", || {
            !service.collab.sync_queued.load(Ordering::Acquire)
        })
        .await;
    }
}
