use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex as SyncMutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, Mutex, OwnedMappedMutexGuard, OwnedMutexGuard};
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::{authorize_workspace, verify_grant};
use crate::chat::{
    authorize_session_action, can_change_member_role, SessionAction, SessionEvent, SessionRole, SessionStatus,
};
use crate::chat_store::{
    ChatAttachment, ChatSessionInvite, NewBreakGlassGrant, NewChatApprovalRequest,
    NewChatAttachment, NewChatRunLease, NewChatRunQueueItem, NewChatSessionInvite, NewSessionEvent,
    NewSharedSession, RunWrite,
};
use crate::socket_hub::{Channels, Expiring, TicketBook};
use crate::store::{AuthorizationAuditEvent, StoreError};
use cognia_tenant_auth::{OrgRole, WorkspaceCapability};
#[cfg(test)]
use cognia_tenant_auth::WorkspaceRole;

const SOCKET_TICKET_TTL_MS: i64 = 30_000;
const LEASE_TOKEN_TTL_MS: i64 = 5 * 60_000;
const LEASE_HEARTBEAT_TTL_MS: i64 = 90_000;
const ATTACHMENT_TICKET_TTL_MS: i64 = 60_000;
pub(crate) const MAX_ATTACHMENT_BYTES: i64 = 52_428_800;
const SHARED_CHAT_PROTOCOL_VERSION: u32 = crate::admission::COLLAB_PROTOCOL_VERSION;
const MAX_LIVE_BODY_BYTES: usize = 256 * 1024;
const TRANSCRIPT_LIVE_MAX_BYTES: usize = 200 * 1024;
const TRANSCRIPT_LIVE_MAX_ID: usize = 256;
type LiveFrame = serde_json::Value;

const MAX_PENDING_TICKETS: usize = 8_192;

#[derive(Debug, Clone)]
struct SocketTicket {
    org_id: String,
    session_id: String,
    user_id: String,
    expires_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttachmentTicketAction {
    Upload,
    Download,
}

#[derive(Debug, Clone)]
struct AttachmentTicket {
    org_id: String,
    session_id: String,
    attachment_id: String,
    user_id: String,
    action: AttachmentTicketAction,
    expires_at: i64,
}

impl Expiring for SocketTicket {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

impl Expiring for AttachmentTicket {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

type SessionRedactions = Arc<Mutex<Option<HashSet<String>>>>;
type RunMessages = HashMap<(String, String, String), (HashSet<String>, i64)>;

/// Session streams plus the tickets that open them, on the shared hub pieces
/// (`socket_hub.rs`, ADR-0206).
pub struct ChatHub {
    channels: Channels<String, SessionEvent>,
    live_channels: Channels<String, LiveFrame>,
    run_messages: SyncMutex<RunMessages>,
    redacted: SyncMutex<HashMap<(String, String), SessionRedactions>>,
    tickets: TicketBook<SocketTicket>,
    attachment_tickets: TicketBook<AttachmentTicket>,
}

impl Default for ChatHub {
    fn default() -> Self {
        Self {
            channels: Channels::new(256),
            live_channels: Channels::new(32),
            run_messages: SyncMutex::new(HashMap::new()),
            redacted: SyncMutex::new(HashMap::new()),
            tickets: TicketBook::new("st_", MAX_PENDING_TICKETS),
            attachment_tickets: TicketBook::new("att_", MAX_PENDING_TICKETS),
        }
    }
}

impl ChatHub {
    fn sender(&self, session_id: &str) -> broadcast::Sender<SessionEvent> {
        self.channels.sender(&session_id.to_owned())
    }

    fn prune_idle(&self) {
        let mut sessions = self.redacted.lock();
        self.channels.prune_idle();
        self.live_channels.prune_idle();
        sessions.retain(|(_, session_id), redacted| {
            // An in-flight seed, publisher or reader must keep the shared lock.
            Arc::strong_count(redacted) > 1
                || self.channels.has_subscribers(session_id)
                || self.live_channels.has_subscribers(session_id)
        });
    }

    async fn redacted_set(
        &self,
        org_id: &str,
        session_id: &str,
        seed: impl std::future::Future<Output = Result<Vec<String>, StoreError>>,
    ) -> Result<OwnedMappedMutexGuard<Option<HashSet<String>>, HashSet<String>>, StoreError> {
        let session = {
            let mut sessions = self.redacted.lock();
            sessions
                .entry((org_id.to_owned(), session_id.to_owned()))
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };
        let mut redacted = session.lock_owned().await;
        if redacted.is_none() {
            *redacted = Some(seed.await?.into_iter().collect());
        }
        Ok(OwnedMutexGuard::map(redacted, |redacted| {
            redacted
                .as_mut()
                .expect("redactions were seeded under this lock")
        }))
    }

    /// Read the same session tombstones used by stored-event and live egress.
    pub async fn redacted_snapshot(
        &self,
        store: &dyn crate::chat_store::ChatStore,
        org_id: &str,
        session_id: &str,
    ) -> Result<HashSet<String>, StoreError> {
        Ok(self
            .redacted_set(
                org_id,
                session_id,
                store.redacted_message_ids(org_id, session_id),
            )
            .await?
            .clone())
    }

    async fn project_stream_event(
        &self,
        store: &dyn crate::chat_store::ChatStore,
        org_id: &str,
        event: SessionEvent,
    ) -> Result<SessionEvent, StoreError> {
        let redacted = self
            .redacted_set(
                org_id,
                &event.session_id,
                store.redacted_message_ids(org_id, &event.session_id),
            )
            .await?;
        Ok(project_redacted_event(event, &redacted))
    }

    async fn broadcast_event(
        &self,
        store: &dyn crate::chat_store::ChatStore,
        org_id: &str,
        event: SessionEvent,
    ) -> Result<(), StoreError> {
        if event.kind == "message.redacted" {
            let mut redacted = self
                .redacted_set(
                    org_id,
                    &event.session_id,
                    store.redacted_message_ids(org_id, &event.session_id),
                )
                .await?;
            if let Some(target) = event
                .payload
                .get("targetMessageId")
                .and_then(serde_json::Value::as_str)
            {
                redacted.insert(target.to_owned());
            }
            // Egress takes this same lock, even if the redaction is still queued.
            let _ = self.sender(&event.session_id).send(event);
            drop(redacted);
            self.prune_idle();
        } else {
            let _ = self.sender(&event.session_id).send(event);
        }
        Ok(())
    }

    fn issue_ticket(&self, ticket: SocketTicket) -> Result<String, ChatFailure> {
        // Expiry is assigned by this service, so it also captures issuance time.
        let now = ticket.expires_at.saturating_sub(SOCKET_TICKET_TTL_MS);
        self.tickets
            .issue(ticket, now)
            .map_err(|_| ChatFailure::TicketCapacity)
    }

    fn consume_ticket(&self, value: &str, now: i64) -> Option<SocketTicket> {
        self.tickets.consume(value, now)
    }

    fn issue_attachment_ticket(&self, ticket: AttachmentTicket) -> Result<String, ChatFailure> {
        let now = ticket.expires_at.saturating_sub(ATTACHMENT_TICKET_TTL_MS);
        self.attachment_tickets
            .issue(ticket, now)
            .map_err(|_| ChatFailure::TicketCapacity)
    }

    fn consume_attachment_ticket(
        &self,
        value: &str,
        action: AttachmentTicketAction,
        now: i64,
    ) -> Option<AttachmentTicket> {
        self.attachment_tickets
            .consume_if(value, now, |ticket| ticket.action == action)
    }

    pub(crate) fn revoke_user_tickets(&self, session_id: &str, user_id: &str) {
        self.tickets
            .revoke(|ticket| ticket.session_id == session_id && ticket.user_id == user_id);
        self.attachment_tickets
            .revoke(|ticket| ticket.session_id == session_id && ticket.user_id == user_id);
    }

    fn revoke_session_tickets(&self, session_id: &str) {
        self.tickets
            .revoke(|ticket| ticket.session_id == session_id);
        self.attachment_tickets
            .revoke(|ticket| ticket.session_id == session_id);
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/orgs/{org_id}/workspaces/{workspace_id}/chat-sessions",
            get(list_sessions).post(create_session),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}",
            get(get_session).patch(patch_session).delete(delete_session),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/members",
            get(list_members).post(put_member),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/members/{user_id}",
            patch(patch_member).delete(remove_member),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/invites",
            get(list_invites).post(create_invite),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/invites/{invite_id}",
            delete(revoke_invite),
        )
        .route("/v1/orgs/{org_id}/chat-invites/accept", post(accept_invite))
        .route(
            "/v1/orgs/{org_id}/chat-invites/{invite_id}/accept",
            post(accept_targeted_invite),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/export-authorization",
            get(authorize_export),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/events",
            get(list_events).post(append_event),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/audit",
            get(list_session_audit),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/break-glass",
            post(create_break_glass),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/break-glass/{grant_id}/events",
            get(list_break_glass_events),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/stream-tickets",
            post(create_stream_ticket),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/stream",
            get(stream_events),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/run-leases",
            get(get_active_run_lease).post(acquire_run_lease),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/run-leases/{lease_id}/heartbeat",
            post(heartbeat_run_lease),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/run-leases/{lease_id}",
            delete(release_run_lease),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/approvals",
            get(list_approvals).post(create_approval),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/approvals/{approval_id}",
            patch(resolve_approval),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/queue",
            get(list_run_queue).post(enqueue_run_input),
        )
        .route("/v1/orgs/{org_id}/chat-sessions/{session_id}/queue/claim", post(claim_run_queue))
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/queue/{item_id}",
            delete(cancel_run_queue_item),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/steer",
            post(steer_run),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/runs/{run_id}/live",
            post(post_run_live).layer(DefaultBodyLimit::max(MAX_LIVE_BODY_BYTES)),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/runs/{run_id}/events",
            post(append_run_event),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/attachments",
            post(create_attachment),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/attachments/{attachment_id}/commit",
            post(commit_attachment),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/attachments/{attachment_id}/upload-ticket",
            post(create_attachment_upload_ticket),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/attachments/{attachment_id}/download-ticket",
            post(create_attachment_download_ticket),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/attachments/{attachment_id}",
            delete(delete_attachment),
        )
        .route(
            "/v1/orgs/{org_id}/chat-attachment-objects/{attachment_id}",
            put(upload_attachment).get(download_attachment),
        )
        .layer(DefaultBodyLimit::max(MAX_ATTACHMENT_BYTES as usize))
}

#[derive(Debug)]
pub(crate) enum ChatFailure {
    Unauthorized,
    ProtocolUpgrade,
    Forbidden,
    Hidden,
    Gone,
    BadRequest(String),
    ObjectStore,
    TicketCapacity,
    Store(StoreError),
}

impl IntoResponse for ChatFailure {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            Self::TicketCapacity => (
                StatusCode::TOO_MANY_REQUESTS,
                serde_json::json!({"error":"too many pending tickets"}),
            ),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                serde_json::json!({"error":"unauthorized"}),
            ),
            Self::ProtocolUpgrade => (
                StatusCode::UPGRADE_REQUIRED,
                serde_json::json!({
                    "error":"shared chat protocol upgrade required",
                    "minimumProtocolVersion":SHARED_CHAT_PROTOCOL_VERSION
                }),
            ),
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                serde_json::json!({"error":"forbidden"}),
            ),
            Self::Hidden => (
                StatusCode::NOT_FOUND,
                serde_json::json!({"error":"not found"}),
            ),
            Self::Gone => (
                StatusCode::GONE,
                serde_json::json!({"error":"expired or revoked"}),
            ),
            Self::BadRequest(error) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                serde_json::json!({"error":error}),
            ),
            Self::ObjectStore => (
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({"error":"attachment storage unavailable"}),
            ),
            Self::Store(StoreError::NotFound) => (
                StatusCode::NOT_FOUND,
                serde_json::json!({"error":"not found"}),
            ),
            Self::Store(StoreError::Conflict(authoritative)) => (
                StatusCode::CONFLICT,
                serde_json::json!({"error":"conflict","authoritative":authoritative}),
            ),
            Self::Store(StoreError::InvitationUnavailable) => (
                StatusCode::GONE,
                serde_json::json!({"error":"expired or revoked"}),
            ),
            Self::Store(StoreError::FeatureUnavailable(decision)) => return crate::admission::response(decision),
            Self::Store(StoreError::Policy(reason)) => (
                StatusCode::FORBIDDEN,
                serde_json::json!({"error":"forbidden","reason":reason}),
            ),
            Self::Store(error) => {
                tracing::error!(error=%error, "shared chat storage failure");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    serde_json::json!({"error":"storage unavailable"}),
                )
            }
        };
        let mut response = (status, Json(body)).into_response();
        if status == StatusCode::NOT_FOUND {
            response.headers_mut().insert("cache-control", "private, no-store".parse().expect("static header"));
        }
        response
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
}

/// Legacy 426 floor: RFC 9110 §15.5.22 describes protocol upgrades; plan
/// A18 records this version-header use as a known wire-compatibility deviation.
pub(crate) fn require_shared_chat_protocol(headers: &HeaderMap) -> Result<(), ChatFailure> {
    let protocol_version = headers
        .get("x-cognia-collab-protocol")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or_default();
    if protocol_version < SHARED_CHAT_PROTOCOL_VERSION {
        return Err(ChatFailure::ProtocolUpgrade);
    }
    Ok(())
}

pub(crate) async fn claims(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
) -> Result<cognia_tenant_auth::grant::GrantClaims, ChatFailure> {
    require_shared_chat_protocol(headers)?;
    verify_grant(&state.signer, bearer(headers), org_id)
        .await
        .map_err(|_| ChatFailure::Unauthorized)
}

pub(crate) async fn visible(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
    session_id: &str,
    action: SessionAction,
) -> Result<(crate::chat::SharedSession, crate::chat::SessionMembership), ChatFailure> {
    let claims = claims(state, headers, org_id).await?;
    let pair = state
        .chat_store
        .visible_session(org_id, session_id, claims.user_id.as_str())
        .await
        .map_err(ChatFailure::Store)?;
    let decision = authorize_session_action(
        pair.as_ref().map(|(_, membership)| membership),
        action,
        pair.as_ref()
            .map_or(0, |(session, _)| session.policy_revision),
    );
    state
        .store
        .append_authorization_audit(AuthorizationAuditEvent {
            id: format!("aud_{}", Uuid::new_v4().simple()),
            org_id: org_id.to_owned(),
            workspace_id: pair
                .as_ref()
                .map(|(session, _)| session.workspace_id.clone()),
            actor_user_id: claims.user_id.to_string(),
            target_user_id: None,
            invitation_id: None,
            action: action.as_str().to_owned(),
            old_role: None,
            new_role: None,
            reason: decision.reason.to_owned(),
            request_id: headers
                .get("x-request-id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("req_{}", Uuid::new_v4().simple())),
            grant_id: Some(claims.grant_id.to_string()),
            source: serde_json::json!({
                "resourceType": "chat_session",
                "resourceId": session_id,
                "policyRevision": decision.policy_revision,
                "allowed": decision.allowed,
            }),
            created_at: (state.now)(),
        })
        .await
        .map_err(ChatFailure::Store)?;
    if pair.is_none() || !decision.allowed {
        state.chat_metrics.authorization_denied();
    }
    let pair = pair.ok_or(ChatFailure::Hidden)?;
    if !decision.allowed {
        return Err(ChatFailure::Forbidden);
    }
    Ok(pair)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionBody {
    title: String,
    #[serde(default)]
    importing: bool,
    operation_id: String,
}

async fn create_session(
    State(state): State<AppState>,
    Path((org_id, workspace_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateSessionBody>,
) -> Result<(StatusCode, Json<crate::chat::SharedSession>), ChatFailure> {
    let grant = claims(&state, &headers, &org_id).await?;
    authorize_workspace(
        state.store.as_ref(),
        &grant,
        &workspace_id,
        WorkspaceCapability::Write,
    )
    .await
    .map_err(|_| ChatFailure::Forbidden)?;
    if body.title.trim().is_empty() {
        return Err(ChatFailure::BadRequest("title must not be blank".into()));
    }
    let session = state
        .chat_store
        .create_session(NewSharedSession {
            id: format!("ses_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id,
            title: body.title.trim().to_owned(),
            status: if body.importing {
                SessionStatus::Importing
            } else {
                SessionStatus::Active
            },
            created_by_user_id: grant.user_id.to_string(),
            now: (state.now)(),
            operation_id: body.operation_id,
        })
        .await
        .map_err(ChatFailure::Store)?;
    Ok((StatusCode::CREATED, Json(session)))
}

async fn list_sessions(
    State(state): State<AppState>,
    Path((org_id, workspace_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::chat::SharedSession>>, ChatFailure> {
    let grant = claims(&state, &headers, &org_id).await?;
    authorize_workspace(
        state.store.as_ref(),
        &grant,
        &workspace_id,
        WorkspaceCapability::Read,
    )
    .await
    .map_err(|_| ChatFailure::Forbidden)?;
    Ok(Json(
        state
            .chat_store
            .list_sessions(&org_id, grant.user_id.as_str(), Some(&workspace_id))
            .await
            .map_err(ChatFailure::Store)?,
    ))
}
async fn get_session(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<crate::chat::SharedSession>, ChatFailure> {
    Ok(Json(
        visible(&state, &headers, &org_id, &session_id, SessionAction::Read)
            .await?
            .0,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportAuthorizationQuery {
    /// `transcript` (the default) or `files` (ADR-0222).
    scope: Option<String>,
}

/// May the caller take a copy of this conversation out of the org right now?
/// Never cached: membership and policy are read on every call.
///
/// `scope=files` asks about publishing the conversation's files, which needs
/// `files.share` and an org file-sharing policy that allows public snapshots;
/// the answer then names the policy revision it was decided under.
async fn authorize_export(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    Query(query): Query<ExportAuthorizationQuery>,
    headers: HeaderMap,
) -> Result<Response, ChatFailure> {
    let files = match query.scope.as_deref() {
        None | Some("transcript") => false,
        Some("files") => true,
        Some(other) => {
            return Err(ChatFailure::BadRequest(format!(
                "unknown export scope {other:?}"
            )))
        }
    };
    if !files {
        visible(
            &state,
            &headers,
            &org_id,
            &session_id,
            SessionAction::Export,
        )
        .await?;
        return Ok(([("cache-control", "no-store")], StatusCode::NO_CONTENT).into_response());
    }
    let (session, _) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::FilesShare,
    )
    .await?;
    let policy = crate::file_sharing::effective_policy(state.file_sharing_store.as_ref(), &org_id)
        .await
        .map_err(ChatFailure::Store)?;
    if !policy.settings.allow_public_snapshots {
        let claims = claims(&state, &headers, &org_id).await?;
        state
            .store
            .append_authorization_audit(AuthorizationAuditEvent {
                id: format!("aud_{}", Uuid::new_v4().simple()),
                org_id: org_id.clone(),
                workspace_id: Some(session.workspace_id.clone()),
                actor_user_id: claims.user_id.to_string(),
                target_user_id: None,
                invitation_id: None,
                action: SessionAction::FilesShare.as_str().to_owned(),
                old_role: None,
                new_role: None,
                reason: "org_file_sharing_policy".into(),
                request_id: headers
                    .get("x-request-id")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("req_{}", Uuid::new_v4().simple())),
                grant_id: Some(claims.grant_id.to_string()),
                source: serde_json::json!({
                    "resourceType": "chat_session",
                    "resourceId": session_id,
                    "policyRevision": policy.revision,
                    "allowed": false,
                }),
                created_at: (state.now)(),
            })
            .await
            .map_err(ChatFailure::Store)?;
        state.chat_metrics.authorization_denied();
        return Err(ChatFailure::Store(StoreError::Policy(
            "org_file_sharing_policy".into(),
        )));
    }
    Ok((
        [
            ("cache-control", "no-store".to_owned()),
            ("x-cognia-file-policy-revision", policy.revision.to_string()),
        ],
        StatusCode::NO_CONTENT,
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchSessionBody {
    tool_detail: Option<crate::chat::ToolDetail>,
    title: Option<String>,
    status: Option<SessionStatus>,
    operation_id: String,
    base_revision: i64,
}

async fn patch_session(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PatchSessionBody>,
) -> Result<Json<crate::chat::SharedSession>, ChatFailure> {
    let (before, member) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::ManageSettings,
    )
    .await?;
    if body
        .title
        .as_deref()
        .is_some_and(|title| title.trim().is_empty())
    {
        return Err(ChatFailure::BadRequest("title must not be blank".into()));
    }
    let updated = state
        .chat_store
        .patch_session(
            &org_id,
            &session_id,
            body.title.as_deref().map(str::trim),
            body.status,
            body.tool_detail
                .map(|detail| (detail, member.user_id.as_str())),
            &body.operation_id,
            body.base_revision,
            (state.now)(),
        )
        .await
        .map_err(ChatFailure::Store)?;
    if updated.policy_revision != before.policy_revision {
        let _ = state.chat_hub.sender(&session_id).send(policy_event(
            &session_id,
            &member.user_id,
            (state.now)(),
        ));
    }
    Ok(Json(updated))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteSessionQuery {
    operation_id: String,
    base_revision: i64,
}

async fn delete_session(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    Query(query): Query<DeleteSessionQuery>,
    headers: HeaderMap,
) -> Result<StatusCode, ChatFailure> {
    visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::Delete,
    )
    .await?;
    state
        .chat_store
        .patch_session(
            &org_id,
            &session_id,
            None,
            Some(SessionStatus::Deleting),
            None,
            &query.operation_id,
            query.base_revision,
            (state.now)(),
        )
        .await
        .map_err(ChatFailure::Store)?;
    state.chat_hub.revoke_session_tickets(&session_id);
    let _ = state.chat_hub.sender(&session_id).send(policy_event(
        &session_id,
        "session-deleting",
        (state.now)(),
    ));
    tokio::spawn(async move {
        let attachments = match state
            .chat_store
            .list_session_attachments(&org_id, &session_id)
            .await
        {
            Ok(attachments) => attachments,
            Err(error) => {
                tracing::error!(%org_id, %session_id, %error, "shared chat deletion could not list attachments");
                return;
            }
        };
        for attachment in attachments {
            if let Err(error) = state.chat_attachments.delete(&attachment.object_key).await {
                tracing::error!(%org_id, %session_id, attachment_id=%attachment.id, %error, "shared chat attachment deletion failed");
                return;
            }
        }
        // The live-file requests' bytes (ADR-0222 §6) go with the conversation.
        let request_objects = match state
            .session_files_store
            .session_object_keys(&org_id, &session_id)
            .await
        {
            Ok(keys) => keys,
            Err(error) => {
                tracing::error!(%org_id, %session_id, %error, "shared chat deletion could not list file request objects");
                return;
            }
        };
        for key in request_objects {
            if let Err(error) = state.chat_attachments.delete(&key).await {
                tracing::error!(%org_id, %session_id, %key, %error, "shared chat file request object deletion failed");
                return;
            }
        }
        state.session_files_hub.forget(&session_id);
        if let Err(error) = state
            .chat_store
            .delete_session_data(&org_id, &session_id)
            .await
        {
            tracing::error!(%org_id, %session_id, %error, "shared chat content deletion failed");
        }
    });
    Ok(StatusCode::ACCEPTED)
}

async fn list_members(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::chat::SessionMembership>>, ChatFailure> {
    visible(&state, &headers, &org_id, &session_id, SessionAction::Read).await?;
    Ok(Json(
        state
            .chat_store
            .list_members(&org_id, &session_id)
            .await
            .map_err(ChatFailure::Store)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutMemberBody {
    user_id: String,
    role: SessionRole,
    #[serde(default)]
    approver: bool,
    #[serde(default)]
    guest: bool,
}

async fn enforce_member_role_ceiling(
    state: &AppState,
    org_id: &str,
    workspace_id: &str,
    user_id: &str,
    role: SessionRole,
    guest: bool,
) -> Result<(), ChatFailure> {
    if guest {
        return if matches!(role, SessionRole::Viewer | SessionRole::Member) {
            Ok(())
        } else {
            Err(ChatFailure::Forbidden)
        };
    }
    let standing = state
        .store
        .membership(org_id, user_id, Some(workspace_id))
        .await
        .map_err(ChatFailure::Store)?;
    let allowed = cognia_tenant_auth::membership::resolve_workspace_access(standing.org_role, standing.workspace_role)
        .is_some_and(|standing| crate::chat::session_role_rank(role) <= crate::chat::session_role_rank(crate::chat::session_grant_role_ceiling(standing)));
    if allowed {
        Ok(())
    } else {
        Err(ChatFailure::Forbidden)
    }
}

async fn put_member(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PutMemberBody>,
) -> Result<(StatusCode, Json<crate::chat::SessionMembership>), ChatFailure> {
    let (session, actor) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::ManageMembers,
    )
    .await?;
    let existing_role = state
        .chat_store
        .list_members(&org_id, &session_id)
        .await
        .map_err(ChatFailure::Store)?
        .into_iter()
        .find(|member| member.user_id == body.user_id)
        .map(|member| member.role);
    if !can_change_member_role(actor.role, existing_role, body.role) {
        return Err(ChatFailure::Forbidden);
    }
    enforce_member_role_ceiling(
        &state,
        &org_id,
        &session.workspace_id,
        &body.user_id,
        body.role,
        body.guest,
    )
    .await?;
    let member = state
        .chat_store
        .put_member(
            &org_id,
            &session_id,
            &session.workspace_id,
            &body.user_id,
            body.role,
            body.approver,
            body.guest,
            &actor.user_id,
            (state.now)(),
        )
        .await
        .map_err(ChatFailure::Store)?;
    let _ = state.chat_hub.sender(&session_id).send(policy_event(
        &session_id,
        &body.user_id,
        (state.now)(),
    ));
    Ok((StatusCode::CREATED, Json(member)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchMemberBody {
    role: SessionRole,
    #[serde(default)]
    approver: bool,
    #[serde(default)]
    guest: bool,
}
async fn patch_member(
    State(state): State<AppState>,
    Path((org_id, session_id, user_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<PatchMemberBody>,
) -> Result<Json<crate::chat::SessionMembership>, ChatFailure> {
    let (session, actor) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::ManageMembers,
    )
    .await?;
    let existing = state
        .chat_store
        .list_members(&org_id, &session_id)
        .await
        .map_err(ChatFailure::Store)?
        .into_iter()
        .find(|member| member.user_id == user_id)
        .ok_or(ChatFailure::Hidden)?;
    if !can_change_member_role(actor.role, Some(existing.role), body.role) {
        return Err(ChatFailure::Forbidden);
    }
    enforce_member_role_ceiling(
        &state,
        &org_id,
        &session.workspace_id,
        &user_id,
        body.role,
        body.guest,
    )
    .await?;
    let member = state
        .chat_store
        .put_member(
            &org_id,
            &session_id,
            &session.workspace_id,
            &user_id,
            body.role,
            body.approver,
            body.guest,
            &actor.user_id,
            (state.now)(),
        )
        .await
        .map_err(ChatFailure::Store)?;
    let _ =
        state
            .chat_hub
            .sender(&session_id)
            .send(policy_event(&session_id, &user_id, (state.now)()));
    Ok(Json(member))
}

fn member_removal_action(actor_user_id: &str, target_user_id: &str) -> SessionAction {
    if actor_user_id == target_user_id {
        SessionAction::Read
    } else {
        SessionAction::ManageMembers
    }
}

async fn remove_member(
    State(state): State<AppState>,
    Path((org_id, session_id, user_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ChatFailure> {
    let grant = claims(&state, &headers, &org_id).await?;
    let action = member_removal_action(grant.user_id.as_str(), &user_id);
    let (_, actor) = visible(&state, &headers, &org_id, &session_id, action).await?;
    let existing = state
        .chat_store
        .list_members(&org_id, &session_id)
        .await
        .map_err(ChatFailure::Store)?
        .into_iter()
        .find(|member| member.user_id == user_id)
        .ok_or(ChatFailure::Hidden)?;
    if existing.role == SessionRole::Owner && actor.role != SessionRole::Owner {
        return Err(ChatFailure::Forbidden);
    }
    state
        .chat_store
        .remove_member(&org_id, &session_id, &user_id, &actor.user_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?;
    state.chat_hub.revoke_user_tickets(&session_id, &user_id);
    let _ =
        state
            .chat_hub
            .sender(&session_id)
            .send(policy_event(&session_id, &user_id, (state.now)()));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInviteBody {
    target_user_id: Option<String>,
    role: SessionRole,
    #[serde(default)]
    approver: bool,
    #[serde(default)]
    guest: bool,
    expires_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateInviteResponse {
    invite: ChatSessionInvite,
    token: String,
}

async fn list_invites(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<ChatSessionInvite>>, ChatFailure> {
    visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::ManageMembers,
    )
    .await?;
    Ok(Json(
        state
            .chat_store
            .list_invites(&org_id, &session_id, (state.now)())
            .await
            .map_err(ChatFailure::Store)?,
    ))
}

async fn create_invite(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateInviteBody>,
) -> Result<(StatusCode, Json<CreateInviteResponse>), ChatFailure> {
    let (session, actor) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::ManageMembers,
    )
    .await?;
    if session.status != SessionStatus::Active {
        return Err(ChatFailure::Forbidden);
    }
    let now = (state.now)();
    if body.expires_at <= now || body.expires_at > now + 30 * 24 * 60 * 60_000 {
        return Err(ChatFailure::BadRequest(
            "invite expiry must be within 30 days".into(),
        ));
    }
    if matches!(body.role, SessionRole::Owner)
        || (!body.guest && body.target_user_id.is_none())
        || (body.guest && (matches!(body.role, SessionRole::Maintainer) || body.approver))
    {
        return Err(ChatFailure::BadRequest(
            "invalid invitation capability or target".into(),
        ));
    }
    if let Some(target_user_id) = body.target_user_id.as_deref() {
        enforce_member_role_ceiling(
            &state,
            &org_id,
            &session.workspace_id,
            target_user_id,
            body.role,
            body.guest,
        )
        .await?;
    }
    let token = format!("cit_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let org_id_for_notice = org_id.clone();
    let workspace_for_notice = session.workspace_id.clone();
    let invite = state
        .chat_store
        .create_invite(NewChatSessionInvite {
            id: format!("inv_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: session.workspace_id,
            session_id,
            token_hash: token_hash(&token),
            target_user_id: body.target_user_id,
            role: body.role,
            approver: body.approver,
            guest: body.guest,
            created_by_user_id: actor.user_id,
            expires_at: body.expires_at,
            now,
        })
        .await
        .map_err(ChatFailure::Store)?;
    // A targeted invite can be accepted by its target without the token
    // (`accept_targeted_invite`), so telling them is actionable.
    if let Some(target) = invite.target_user_id.as_deref() {
        crate::notifications::deliver(
            &state,
            &org_id_for_notice,
            &workspace_for_notice,
            &invite.created_by_user_id,
            vec![crate::notifications::Draft::chat_invite(target, &invite.id)],
        )
        .await;
    }
    Ok((
        StatusCode::CREATED,
        Json(CreateInviteResponse { invite, token }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceptInviteBody {
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptInviteResponse {
    invite: ChatSessionInvite,
    membership: crate::chat::SessionMembership,
}

async fn accept_invite(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<AcceptInviteBody>,
) -> Result<Json<AcceptInviteResponse>, ChatFailure> {
    let grant = claims(&state, &headers, &org_id).await?;
    if !body.token.starts_with("cit_") || body.token.len() < 32 {
        return Err(ChatFailure::Gone);
    }
    let (invite, membership) = state
        .chat_store
        .accept_invite(
            &org_id,
            &token_hash(&body.token),
            grant.user_id.as_str(),
            (state.now)(),
        )
        .await
        .map_err(ChatFailure::Store)?;
    let _ = state.chat_hub.sender(&invite.session_id).send(policy_event(
        &invite.session_id,
        &membership.user_id,
        (state.now)(),
    ));
    Ok(Json(AcceptInviteResponse { invite, membership }))
}

/// Accept an invite addressed to the caller by name, without its token.
///
/// The token exists for invites nobody was named on: whoever holds it may
/// join. An invite that names a person already says who may join, and the
/// signed-in caller proves who they are, so the id is enough. That is what
/// makes the `chat.invited` notification (ADR-0207) something its recipient
/// can act on. Anyone else gets the same answer as a used invite.
async fn accept_targeted_invite(
    State(state): State<AppState>,
    Path((org_id, invite_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<AcceptInviteResponse>, ChatFailure> {
    let grant = claims(&state, &headers, &org_id).await?;
    let (invite, membership) = state
        .chat_store
        .accept_targeted_invite(&org_id, &invite_id, grant.user_id.as_str(), (state.now)())
        .await
        .map_err(ChatFailure::Store)?;
    let _ = state.chat_hub.sender(&invite.session_id).send(policy_event(
        &invite.session_id,
        &membership.user_id,
        (state.now)(),
    ));
    Ok(Json(AcceptInviteResponse { invite, membership }))
}

async fn revoke_invite(
    State(state): State<AppState>,
    Path((org_id, session_id, invite_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<ChatSessionInvite>, ChatFailure> {
    visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::ManageMembers,
    )
    .await?;
    Ok(Json(
        state
            .chat_store
            .revoke_invite(&org_id, &session_id, &invite_id)
            .await
            .map_err(ChatFailure::Store)?,
    ))
}

fn policy_event(session_id: &str, user_id: &str, now: i64) -> SessionEvent {
    SessionEvent {
        id: format!("evt_{}", Uuid::new_v4().simple()),
        session_id: session_id.into(),
        sequence: 0,
        kind: "member.updated".into(),
        actor_kind: "system".into(),
        actor_id: "system".into(),
        actor_label: None,
        payload: serde_json::json!({"userId":user_id,"policyChanged":true}),
        created_at: now,
        operation_id: format!("policy_{}", Uuid::new_v4().simple()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventQuery {
    #[serde(default)]
    after_sequence: i64,
    limit: Option<i64>,
}
async fn list_events(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<EventQuery>,
) -> Result<Json<Vec<SessionEvent>>, ChatFailure> {
    visible(&state, &headers, &org_id, &session_id, SessionAction::Read).await?;
    let redacted = state
        .chat_store
        .redacted_message_ids(&org_id, &session_id)
        .await
        .map_err(ChatFailure::Store)?
        .into_iter()
        .collect();
    let events = state
        .chat_store
        .list_session_events(
            &org_id,
            &session_id,
            query.after_sequence,
            query.limit.unwrap_or(200).clamp(1, 500),
        )
        .await
        .map_err(ChatFailure::Store)?;
    Ok(Json(project_redacted_events(events, &redacted)))
}

fn project_redacted_events(
    events: Vec<SessionEvent>,
    redacted: &HashSet<String>,
) -> Vec<SessionEvent> {
    events
        .into_iter()
        .map(|event| project_redacted_event(event, redacted))
        .collect()
}

fn project_redacted_event(mut event: SessionEvent, redacted: &HashSet<String>) -> SessionEvent {
    let message_id = event
        .payload
        .get("messageId")
        .and_then(serde_json::Value::as_str);
    let target_message_id = event
        .payload
        .get("targetMessageId")
        .and_then(serde_json::Value::as_str);
    let sanitized_id = message_id
        .filter(|id| redacted.contains(*id))
        .or_else(|| target_message_id.filter(|id| redacted.contains(*id)));
    if let Some(message_id) = sanitized_id {
        event.payload = if event.kind == "message.created" {
            serde_json::json!({"messageId": message_id, "redacted": true})
        } else {
            serde_json::json!({"targetMessageId": message_id, "redacted": true})
        };
    }
    event
}

#[derive(Deserialize)]
struct SessionAuditQuery {
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionAuditEvent {
    id: String,
    org_id: String,
    workspace_id: Option<String>,
    session_id: String,
    actor_user_id: String,
    action: String,
    resource_type: String,
    resource_id: String,
    allowed: bool,
    reason: String,
    policy_revision: i64,
    created_at: i64,
}

async fn list_session_audit(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    Query(query): Query<SessionAuditQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<SessionAuditEvent>>, ChatFailure> {
    visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::AuditMetadata,
    )
    .await?;
    let events = state
        .store
        .list_authorization_audit(&org_id, query.limit.unwrap_or(200).clamp(1, 500))
        .await
        .map_err(ChatFailure::Store)?
        .into_iter()
        .filter_map(|event| {
            let resource_id = event.source.get("resourceId")?.as_str()?.to_owned();
            if resource_id != session_id {
                return None;
            }
            let resource_type = event
                .source
                .get("resourceType")
                .and_then(|value| value.as_str())
                .unwrap_or("chat_session")
                .to_owned();
            let allowed = event
                .source
                .get("allowed")
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            let policy_revision = event
                .source
                .get("policyRevision")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            Some(SessionAuditEvent {
                id: event.id,
                org_id: event.org_id,
                workspace_id: event.workspace_id,
                session_id: session_id.clone(),
                actor_user_id: event.actor_user_id,
                action: event.action,
                resource_type,
                resource_id,
                allowed,
                reason: event.reason,
                policy_revision,
                created_at: event.created_at,
            })
        })
        .collect();
    Ok(Json(events))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBreakGlassBody {
    reason: String,
    duration_ms: i64,
    operation_id: String,
}

async fn require_break_glass_admin(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
    session_id: &str,
) -> Result<
    (
        crate::chat::SharedSession,
        cognia_tenant_auth::grant::GrantClaims,
    ),
    ChatFailure,
> {
    let grant = claims(state, headers, org_id).await?;
    let session = state
        .chat_store
        .admin_session(org_id, session_id)
        .await
        .map_err(|_| ChatFailure::Hidden)?;
    let membership = state
        .store
        .membership(org_id, grant.user_id.as_str(), Some(&session.workspace_id))
        .await
        .map_err(ChatFailure::Store)?;
    if !matches!(membership.org_role, Some(OrgRole::Owner | OrgRole::Admin)) {
        return Err(ChatFailure::Hidden);
    }
    authorize_workspace(
        state.store.as_ref(),
        &grant,
        &session.workspace_id,
        WorkspaceCapability::Manage,
    )
    .await
    .map_err(|_| ChatFailure::Hidden)?;
    Ok((session, grant))
}

async fn create_break_glass(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateBreakGlassBody>,
) -> Result<(StatusCode, Json<crate::chat_store::BreakGlassGrant>), ChatFailure> {
    let (session, actor) =
        require_break_glass_admin(&state, &headers, &org_id, &session_id).await?;
    let reason = body.reason.trim();
    if reason.len() < 8 || !(60_000..=60 * 60_000).contains(&body.duration_ms) {
        return Err(ChatFailure::BadRequest(
            "break-glass requires a reason and a duration from one minute to one hour".into(),
        ));
    }
    let now = (state.now)();
    let grant = state
        .chat_store
        .create_break_glass_grant(NewBreakGlassGrant {
            id: format!("bg_{}", Uuid::new_v4().simple()),
            org_id: org_id.clone(),
            workspace_id: session.workspace_id.clone(),
            session_id: session_id.clone(),
            granted_to_user_id: actor.user_id.to_string(),
            reason: reason.to_owned(),
            expires_at: now + body.duration_ms,
            created_at: now,
            operation_id: body.operation_id,
        })
        .await
        .map_err(ChatFailure::Store)?;
    state
        .store
        .append_authorization_audit(AuthorizationAuditEvent {
            id: format!("aud_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: Some(session.workspace_id),
            actor_user_id: actor.user_id.to_string(),
            target_user_id: None,
            invitation_id: None,
            action: SessionAction::BreakGlassRead.as_str().to_owned(),
            old_role: None,
            new_role: None,
            reason: reason.to_owned(),
            request_id: headers
                .get("x-request-id")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("break-glass")
                .to_owned(),
            grant_id: Some(actor.grant_id.to_string()),
            source: serde_json::json!({
                "resourceType":"chat_session",
                "resourceId":session_id,
                "breakGlassGrantId":grant.id,
                "allowed":true,
            }),
            created_at: now,
        })
        .await
        .map_err(ChatFailure::Store)?;
    Ok((StatusCode::CREATED, Json(grant)))
}

async fn list_break_glass_events(
    State(state): State<AppState>,
    Path((org_id, session_id, grant_id)): Path<(String, String, String)>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<SessionEvent>>, ChatFailure> {
    let (_, actor) = require_break_glass_admin(&state, &headers, &org_id, &session_id).await?;
    let grant = state
        .chat_store
        .valid_break_glass_grant(
            &org_id,
            &session_id,
            &grant_id,
            actor.user_id.as_str(),
            (state.now)(),
        )
        .await
        .map_err(|error| match error {
            StoreError::InvitationUnavailable => ChatFailure::Gone,
            other => ChatFailure::Store(other),
        })?;
    let now = (state.now)();
    state
        .store
        .append_authorization_audit(AuthorizationAuditEvent {
            id: format!("aud_{}", Uuid::new_v4().simple()),
            org_id: org_id.clone(),
            workspace_id: None,
            actor_user_id: actor.user_id.to_string(),
            target_user_id: None,
            invitation_id: None,
            action: SessionAction::BreakGlassRead.as_str().to_owned(),
            old_role: None,
            new_role: None,
            reason: grant.reason.clone(),
            request_id: headers
                .get("x-request-id")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("break-glass-read")
                .to_owned(),
            grant_id: Some(actor.grant_id.to_string()),
            source: serde_json::json!({
                "resourceType":"chat_session",
                "resourceId":session_id,
                "breakGlassGrantId":grant.id,
                "allowed":true,
                "rawContentAccessed":true,
            }),
            created_at: now,
        })
        .await
        .map_err(ChatFailure::Store)?;
    Ok(Json(
        state
            .chat_store
            .list_session_events(
                &org_id,
                &session_id,
                query.after_sequence,
                query.limit.unwrap_or(200).clamp(1, 500),
            )
            .await
            .map_err(ChatFailure::Store)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendEventBody {
    id: Option<String>,
    kind: String,
    payload: serde_json::Value,
    operation_id: String,
    actor_label: Option<String>,
}

fn message_owned_by(event: &SessionEvent, user_id: &str) -> bool {
    let author = event.payload.get("author");
    match (
        author
            .and_then(|value| value.get("kind"))
            .and_then(|value| value.as_str()),
        author
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str()),
    ) {
        (Some("human" | "guest"), Some(author_id)) => author_id == user_id,
        (Some(_), _) => false,
        _ => matches!(event.actor_kind.as_str(), "human" | "guest") && event.actor_id == user_id,
    }
}

fn normalize_human_message(
    session: &crate::chat::SharedSession,
    member: &crate::chat::SessionMembership,
    payload: &mut serde_json::Value,
) -> Result<(), ChatFailure> {
    if payload
        .get("messageId")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|id| id.trim().is_empty())
        || !payload
            .get("parts")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err(ChatFailure::BadRequest("message is incomplete".into()));
    }
    if session.status == SessionStatus::Importing
        && member.role == SessionRole::Owner
        && session.created_by_user_id == member.user_id
    {
        // Preserve historical authors and roles only during the creator's
        // explicit private-transcript import, before activation.
        return Ok(());
    }
    if payload.get("role").and_then(serde_json::Value::as_str) != Some("user")
        || payload.get("imported").and_then(serde_json::Value::as_bool) == Some(true)
    {
        return Err(ChatFailure::BadRequest(
            "human posts require the user role".into(),
        ));
    }
    payload["author"] = serde_json::json!({
        "kind": if member.guest { "guest" } else { "human" },
        "id": member.user_id,
        "displayName": member.display_name,
    });
    Ok(())
}

fn is_import_replay(event: &SessionEvent, body: &AppendEventBody, actor_id: &str) -> bool {
    event.kind == "message.created"
        && event.actor_id == actor_id
        && event.operation_id == body.operation_id
        && event.payload == body.payload
        && event
            .payload
            .get("imported")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
}

async fn append_event(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(mut body): Json<AppendEventBody>,
) -> Result<(StatusCode, Json<SessionEvent>), ChatFailure> {
    let (session, member) =
        visible(&state, &headers, &org_id, &session_id, SessionAction::Post).await?;
    if !matches!(
        body.kind.as_str(),
        "message.created" | "message.corrected" | "message.redacted"
    ) {
        return Err(ChatFailure::BadRequest(
            "event kind is not client-writable".into(),
        ));
    }
    if matches!(
        session.status,
        SessionStatus::Archived | SessionStatus::Deleting
    ) {
        return Err(ChatFailure::Forbidden);
    }
    if body.operation_id.trim().is_empty() {
        return Err(ChatFailure::BadRequest("operationId is required".into()));
    }
    if body.kind == "message.created" {
        // Activation may have succeeded while its response was lost. Exact
        // durable import retries stay readable after the import phase closes.
        if body
            .payload
            .get("imported")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            if let Some(message_id) = body
                .payload
                .get("messageId")
                .and_then(serde_json::Value::as_str)
            {
                match state
                    .chat_store
                    .get_message_event(&org_id, &session_id, message_id)
                    .await
                {
                    Ok(event) if is_import_replay(&event, &body, &member.user_id) => {
                        return Ok((StatusCode::CREATED, Json(event)));
                    }
                    Ok(_) | Err(StoreError::NotFound) => {}
                    Err(error) => return Err(ChatFailure::Store(error)),
                }
            }
        }
        normalize_human_message(&session, &member, &mut body.payload)?;
    }
    if matches!(body.kind.as_str(), "message.corrected" | "message.redacted") {
        let target_message_id = body
            .payload
            .get("targetMessageId")
            .and_then(|value| value.as_str())
            .ok_or_else(|| ChatFailure::BadRequest("targetMessageId is required".into()))?;
        let target = state
            .chat_store
            .get_message_event(&org_id, &session_id, target_message_id)
            .await
            .map_err(ChatFailure::Store)?;
        if !message_owned_by(&target, &member.user_id) {
            if body.kind == "message.corrected" {
                return Err(ChatFailure::Forbidden);
            }
            visible(
                &state,
                &headers,
                &org_id,
                &session_id,
                SessionAction::RedactAny,
            )
            .await?;
        }
    }
    let event = state
        .chat_store
        .append_session_event(NewSessionEvent {
            tool_detail_revision: None,
            id: body
                .id
                .unwrap_or_else(|| format!("evt_{}", Uuid::new_v4().simple())),
            org_id: org_id.clone(),
            workspace_id: session.workspace_id,
            session_id: session_id.clone(),
            kind: body.kind,
            actor_kind: if member.guest {
                "guest".into()
            } else {
                "human".into()
            },
            actor_id: member.user_id,
            actor_label: body.actor_label,
            payload: body.payload,
            now: (state.now)(),
            operation_id: body.operation_id,
        })
        .await;
    if event.is_err() {
        state.chat_metrics.event_append_failed();
    }
    let event = event.map_err(ChatFailure::Store)?;
    state
        .chat_hub
        .broadcast_event(state.chat_store.as_ref(), &org_id, event.clone())
        .await
        .map_err(ChatFailure::Store)?;
    Ok((StatusCode::CREATED, Json(event)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketResponse {
    ticket: String,
    expires_at: i64,
}
async fn create_stream_ticket(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<TicketResponse>, ChatFailure> {
    let (_, member) = visible(&state, &headers, &org_id, &session_id, SessionAction::Read).await?;
    let expires_at = (state.now)() + SOCKET_TICKET_TTL_MS;
    let ticket = state.chat_hub.issue_ticket(SocketTicket {
        org_id,
        session_id,
        user_id: member.user_id,
        expires_at,
    })?;
    Ok(Json(TicketResponse { ticket, expires_at }))
}

async fn stream_events(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ChatFailure> {
    let offered = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let ticket_value = offered
        .split(',')
        .map(str::trim)
        .find(|value| value.starts_with("st_"))
        .ok_or(ChatFailure::Unauthorized)?;
    let ticket = state
        .chat_hub
        .consume_ticket(ticket_value, (state.now)())
        .ok_or(ChatFailure::Gone)?;
    if ticket.org_id != org_id || ticket.session_id != session_id {
        return Err(ChatFailure::Hidden);
    }
    if state.chat_store.effective_member(&org_id, &session_id, &ticket.user_id).await.map_err(ChatFailure::Store)?.is_none() {
        return Err(ChatFailure::Hidden);
    }
    state.chat_metrics.stream_connected();
    let receiver = state.chat_hub.channels.subscribe(&session_id);
    let live = offered
        .split(',')
        .any(|value| value.trim() == "cognia.chat.v2");
    let live_receiver = live.then(|| state.chat_hub.live_channels.subscribe(&session_id));
    Ok(ws
        .protocols(["cognia.chat.v2", "cognia.chat.v1"])
        .on_upgrade(move |socket| async move {
            if live {
                stream_loop_with_live(socket, state, ticket, receiver, live_receiver).await;
            } else {
                stream_loop(socket, state, ticket, receiver).await;
            }
        })
        .into_response())
}
async fn stream_visible(state: &AppState, ticket: &SocketTicket) -> bool {
    state.chat_store.visible_session(&ticket.org_id, &ticket.session_id, &ticket.user_id)
        .await.ok().flatten().is_some()
}

async fn stream_loop(
    socket: WebSocket,
    state: AppState,
    ticket: SocketTicket,
    receiver: broadcast::Receiver<SessionEvent>,
) {
    stream_loop_with_live(socket, state, ticket, receiver, None).await;
}

async fn receive_live(
    receiver: &mut Option<broadcast::Receiver<LiveFrame>>,
) -> Result<LiveFrame, broadcast::error::RecvError> {
    match receiver {
        Some(receiver) => receiver.recv().await,
        None => std::future::pending().await,
    }
}

const STREAM_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

async fn send_stream_message<S>(socket: &mut S, message: Message) -> bool
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    matches!(
        tokio::time::timeout(STREAM_SEND_TIMEOUT, socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn stream_loop_with_live<S>(
    mut socket: S,
    state: AppState,
    ticket: SocketTicket,
    mut receiver: broadcast::Receiver<SessionEvent>,
    mut live_receiver: Option<broadcast::Receiver<LiveFrame>>,
) where
    S: futures_util::Stream<Item = Result<Message, axum::Error>>
        + futures_util::Sink<Message, Error = axum::Error>
        + Unpin,
{
    let v2 = live_receiver.is_some();
    let tick_period = std::time::Duration::from_secs(if v2 { 1 } else { 5 });
    let mut standing_tick = tokio::time::interval_at(tokio::time::Instant::now() + tick_period, tick_period);
    standing_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Do not trust the ticket's earlier standing on a newly upgraded socket.
    let mut standing_checked = None::<tokio::time::Instant>;
    loop {
        let event = tokio::select! {
            _ = standing_tick.tick() => {
                if !stream_visible(&state, &ticket).await {
                    let _ = send_stream_message(&mut socket, Message::Close(None)).await;
                    break;
                }
                standing_checked = Some(tokio::time::Instant::now());
                continue;
            }
            incoming = socket.next() => {
                match incoming {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    Some(Ok(_)) => continue,
                }
            }
            frame = receive_live(&mut live_receiver) => {
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::debug!(skipped, "shared chat live receiver skipped frames");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                // Consult committed tombstones even if the redaction event is
                // still queued, then release the shared lock before socket I/O.
                let Ok(redacted) = state.chat_hub.redacted_set(
                    &ticket.org_id, &ticket.session_id,
                    state.chat_store.redacted_message_ids(&ticket.org_id, &ticket.session_id),
                ).await else { break };
                let is_redacted = frame["messageId"].as_str().is_some_and(|id| redacted.contains(id));
                drop(redacted);
                if is_redacted { continue; }
                if standing_checked.is_none_or(|checked| checked.elapsed() >= std::time::Duration::from_secs(1)) {
                    if !stream_visible(&state, &ticket).await {
                        let _ = send_stream_message(&mut socket, Message::Close(None)).await;
                        break;
                    }
                    standing_checked = Some(tokio::time::Instant::now());
                }
                let text = serde_json::json!({"type":"live", "frame":frame}).to_string();
                // This loop sends sequentially: any later redaction event can
                // only reach this socket after the frame that passed the check.
                if !send_stream_message(&mut socket, Message::Text(text.into())).await { break; }
                continue;
            }
            event = receiver.recv() => match event {
                Ok(event) => event,
                // Stored-event lag still requires cursor recovery.
                Err(_) => {
                    let _ = send_stream_message(&mut socket, Message::Close(None)).await;
                    break;
                }
            }
        };
        if !stream_visible(&state, &ticket).await {
            let _ = send_stream_message(&mut socket, Message::Close(None)).await;
            break;
        }
        // Includes member.updated: its policy change invalidates live standing
        // immediately, while every durable event retains its own check.
        standing_checked = Some(tokio::time::Instant::now());
        let Ok(event) = state
            .chat_hub
            .project_stream_event(state.chat_store.as_ref(), &ticket.org_id, event)
            .await
        else {
            let _ = send_stream_message(&mut socket, Message::Close(None)).await;
            break;
        };
        let text = if v2 {
            serde_json::to_string(&serde_json::json!({"type":"event", "event":event}))
        } else {
            serde_json::to_string(&event)
        };
        let Ok(text) = text else { continue };
        if !send_stream_message(&mut socket, Message::Text(text.into())).await {
            break;
        }
    }
    drop(receiver);
    drop(live_receiver);
    state.chat_hub.prune_idle();
    // A peer that stopped reading may also stall the close handshake. Bound
    // that attempt too; dropping the socket then releases the transport.
    let _ = tokio::time::timeout(STREAM_SEND_TIMEOUT, socket.close()).await;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcquireLeaseBody {
    run_id: String,
    device_id: String,
    operation_id: String,
    token: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseResponse {
    lease: crate::chat_store::ChatRunLease,
    token: String,
}
pub(crate) fn token_hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

async fn get_active_run_lease(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Option<crate::chat_store::ChatRunLease>>, ChatFailure> {
    visible(&state, &headers, &org_id, &session_id, SessionAction::Read).await?;
    Ok(Json(
        state
            .chat_store
            .active_run_lease(&org_id, &session_id, (state.now)())
            .await
            .map_err(ChatFailure::Store)?,
    ))
}

async fn acquire_run_lease(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<AcquireLeaseBody>,
) -> Result<(StatusCode, Json<LeaseResponse>), ChatFailure> {
    let (session, member) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::StartRun,
    )
    .await?;
    if session.status != SessionStatus::Active {
        return Err(ChatFailure::Forbidden);
    }
    if body.token.len() < 32
        || body.token.len() > 256
        || body.run_id.trim().is_empty()
        || body.device_id.trim().is_empty()
        || body.operation_id.trim().is_empty()
    {
        return Err(ChatFailure::BadRequest("invalid run lease".into()));
    }
    let now = (state.now)();
    let token = body.token;
    let lease = state
        .chat_store
        .acquire_run_lease(NewChatRunLease {
            id: format!("lease_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: session.workspace_id,
            session_id,
            run_id: body.run_id,
            holder_user_id: member.user_id,
            holder_device_id: body.device_id,
            token_hash: token_hash(&token),
            token_expires_at: now + LEASE_TOKEN_TTL_MS,
            heartbeat_expires_at: now + LEASE_HEARTBEAT_TTL_MS,
            now,
            operation_id: body.operation_id,
        })
        .await;
    if matches!(lease, Err(StoreError::Conflict(_))) {
        state.chat_metrics.lease_conflict();
    }
    let lease = lease.map_err(ChatFailure::Store)?;
    Ok((StatusCode::CREATED, Json(LeaseResponse { lease, token })))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimQueueBody {
    run_id: String,
    device_id: String,
    operation_id: String,
    queue_item_id: String,
    token: String,
    #[serde(default)]
    takeover: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimQueueResponse {
    lease: crate::chat_store::ChatRunLease,
    item: crate::chat_store::ChatRunQueueItem,
    token: String,
}
async fn claim_run_queue(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<ClaimQueueBody>,
) -> Result<Json<ClaimQueueResponse>, ChatFailure> {
    let (session, member) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::StartRun,
    )
    .await?;
    if session.status != SessionStatus::Active {
        return Err(ChatFailure::Forbidden);
    }
    if body.token.len() < 32
        || body.token.len() > 256
        || body.run_id.trim().is_empty()
        || body.device_id.trim().is_empty()
        || body.operation_id.trim().is_empty()
    {
        return Err(ChatFailure::BadRequest("invalid queue claim".into()));
    }
    let now = (state.now)();
    let (lease, item) = state
        .chat_store
        .claim_run_queue(
            NewChatRunLease {
                id: format!("lease_{}", Uuid::new_v4().simple()),
                org_id,
                workspace_id: session.workspace_id,
                session_id,
                run_id: body.run_id,
                holder_user_id: member.user_id,
                holder_device_id: body.device_id,
                token_hash: token_hash(&body.token),
                token_expires_at: now + LEASE_TOKEN_TTL_MS,
                heartbeat_expires_at: now + LEASE_HEARTBEAT_TTL_MS,
                now,
                operation_id: body.operation_id,
            },
            &body.queue_item_id,
            body.takeover,
        )
        .await
        .map_err(ChatFailure::Store)?;
    Ok(Json(ClaimQueueResponse {
        lease,
        item,
        token: body.token,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatBody {
    device_id: String,
    token: String,
}
async fn heartbeat_run_lease(
    State(state): State<AppState>,
    Path((org_id, session_id, lease_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<HeartbeatBody>,
) -> Result<Json<crate::chat_store::ChatRunLease>, ChatFailure> {
    let (_, member) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::StartRun,
    )
    .await?;
    let now = (state.now)();
    Ok(Json(
        state
            .chat_store
            .heartbeat_run_lease(
                &org_id,
                &session_id,
                &lease_id,
                &member.user_id,
                &body.device_id,
                &token_hash(&body.token),
                now + LEASE_HEARTBEAT_TTL_MS,
                now,
            )
            .await
            .map_err(ChatFailure::Store)?,
    ))
}
#[derive(Deserialize)]
struct ReleaseQuery {
    status: Option<String>,
}
async fn release_run_lease(
    State(state): State<AppState>,
    Path((org_id, session_id, lease_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Query(query): Query<ReleaseQuery>,
    Json(body): Json<HeartbeatBody>,
) -> Result<Json<crate::chat_store::ChatRunLease>, ChatFailure> {
    let (_, member) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::StartRun,
    )
    .await?;
    let status = query.status.unwrap_or_else(|| "released".into());
    if !matches!(status.as_str(), "released" | "failed") {
        return Err(ChatFailure::BadRequest(
            "invalid lease terminal status".into(),
        ));
    }
    Ok(Json(
        state
            .chat_store
            .release_run_lease(
                &org_id,
                &session_id,
                &lease_id,
                &member.user_id,
                &body.device_id,
                &token_hash(&body.token),
                (state.now)(),
                &status,
            )
            .await
            .map_err(ChatFailure::Store)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueRunInputBody {
    payload: serde_json::Value,
    operation_id: String,
}

async fn list_run_queue(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::chat_store::ChatRunQueueItem>>, ChatFailure> {
    visible(&state, &headers, &org_id, &session_id, SessionAction::Read).await?;
    Ok(Json(
        state
            .chat_store
            .list_run_queue(&org_id, &session_id)
            .await
            .map_err(ChatFailure::Store)?,
    ))
}

async fn enqueue_run_input(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<EnqueueRunInputBody>,
) -> Result<(StatusCode, Json<crate::chat_store::ChatRunQueueItem>), ChatFailure> {
    let (session, member) =
        visible(&state, &headers, &org_id, &session_id, SessionAction::Post).await?;
    if body.payload.is_null() || body.operation_id.trim().is_empty() {
        return Err(ChatFailure::BadRequest("queue input is incomplete".into()));
    }
    let message_id = body
        .payload
        .get("messageId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ChatFailure::BadRequest("AI request requires a durable messageId".into()))?;
    let message = state
        .chat_store
        .get_message_event(&org_id, &session_id, message_id)
        .await
        .map_err(ChatFailure::Store)?;
    if message
        .payload
        .get("role")
        .and_then(serde_json::Value::as_str)
        != Some("user")
    {
        return Err(ChatFailure::BadRequest(
            "AI request must reference a user message".into(),
        ));
    }
    let redacted = state
        .chat_store
        .redacted_message_ids(&org_id, &session_id)
        .await
        .map_err(ChatFailure::Store)?;
    if redacted.iter().any(|id| id == message_id) {
        return Err(ChatFailure::BadRequest(
            "AI request references a redacted message".into(),
        ));
    }
    let payload = serde_json::json!({"messageId": message_id, "parts": message.payload.get("parts"), "contextSequence": message.sequence});
    let item = state
        .chat_store
        .enqueue_run_input(NewChatRunQueueItem {
            id: format!("queue_{}", Uuid::new_v4().simple()),
            org_id: org_id.clone(),
            workspace_id: session.workspace_id.clone(),
            session_id: session_id.clone(),
            requested_by_user_id: member.user_id.clone(),
            payload,
            now: (state.now)(),
            operation_id: body.operation_id.clone(),
        })
        .await
        .map_err(ChatFailure::Store)?;
    let event = state
        .chat_store
        .append_session_event(NewSessionEvent {
            tool_detail_revision: None,
            id: format!("evt_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: session.workspace_id,
            session_id: session_id.clone(),
            kind: "run.queued".into(),
            actor_kind: if member.guest { "guest" } else { "human" }.into(),
            actor_id: member.user_id,
            actor_label: member.display_name,
            payload: serde_json::json!({"queueItemId":item.id,"position":item.position}),
            now: (state.now)(),
            operation_id: format!("{}:event", body.operation_id),
        })
        .await
        .map_err(ChatFailure::Store)?;
    let _ = state.chat_hub.sender(&session_id).send(event);
    Ok((StatusCode::CREATED, Json(item)))
}

async fn cancel_run_queue_item(
    State(state): State<AppState>,
    Path((org_id, session_id, item_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<crate::chat_store::ChatRunQueueItem>, ChatFailure> {
    let (_, member) = visible(&state, &headers, &org_id, &session_id, SessionAction::Read).await?;
    let elevated = matches!(member.role, SessionRole::Owner | SessionRole::Maintainer);
    Ok(Json(
        state
            .chat_store
            .cancel_run_queue_item(&org_id, &session_id, &item_id, &member.user_id, elevated)
            .await
            .map_err(ChatFailure::Store)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SteerRunBody {
    run_id: String,
    payload: serde_json::Value,
    operation_id: String,
}

async fn steer_run(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<SteerRunBody>,
) -> Result<Json<SessionEvent>, ChatFailure> {
    let (session, member) =
        visible(&state, &headers, &org_id, &session_id, SessionAction::Read).await?;
    let lease = state
        .chat_store
        .active_run_lease(&org_id, &session_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?
        .ok_or_else(|| {
            ChatFailure::Store(StoreError::Conflict(
                serde_json::json!({"reason":"no_active_run"}),
            ))
        })?;
    let elevated =
        authorize_session_action(Some(&member), SessionAction::Steer, session.policy_revision)
            .allowed;
    if lease.run_id != body.run_id || (lease.holder_user_id != member.user_id && !elevated) {
        return Err(ChatFailure::Forbidden);
    }
    let event = state
        .chat_store
        .append_session_event(NewSessionEvent {
            tool_detail_revision: None,
            id: format!("evt_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: session.workspace_id,
            session_id: session_id.clone(),
            kind: "run.steered".into(),
            actor_kind: if member.guest { "guest" } else { "human" }.into(),
            actor_id: member.user_id,
            actor_label: member.display_name,
            payload: serde_json::json!({"runId":body.run_id,"input":body.payload}),
            now: (state.now)(),
            operation_id: body.operation_id,
        })
        .await
        .map_err(ChatFailure::Store)?;
    let _ = state.chat_hub.sender(&session_id).send(event.clone());
    Ok(Json(event))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunLiveBody {
    frame: LiveFrame,
    tool_detail_revision: u64,
}

fn is_live_frame(frame: &LiveFrame) -> bool {
    let id = |key| {
        frame
            .get(key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= TRANSCRIPT_LIVE_MAX_ID)
    };
    let count = |key, minimum| {
        frame
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|v| {
                v >= minimum as f64 && v <= 9_007_199_254_740_991_f64 && v.fract() == 0.0
            })
    };
    let Some(keyframe) = frame.get("keyframe").and_then(serde_json::Value::as_bool) else {
        return false;
    };
    let Some(state) = frame.get("state").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let Some(parts) = frame.get("parts").and_then(serde_json::Value::as_array) else {
        return false;
    };
    id("sessionId")
        && id("messageId")
        && id("replyTo")
        && count("seq", 1)
        && count("base", 0)
        && matches!(state, "streaming" | "settled" | "reset")
        && parts.iter().all(serde_json::Value::is_object)
        && (!keyframe || frame["base"].as_f64() == Some(0.0))
        && (state != "settled" || keyframe)
        && (state != "reset" || parts.is_empty())
        && (frame.get("afterRevision").is_none()
            || (state == "settled" && count("afterRevision", 0)))
        && serde_json::to_vec(frame).is_ok_and(|bytes| bytes.len() <= TRANSCRIPT_LIVE_MAX_BYTES)
}

async fn post_run_live(
    State(state): State<AppState>,
    Path((org_id, session_id, run_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<RunLiveBody>,
) -> Result<StatusCode, ChatFailure> {
    require_shared_chat_protocol(&headers)?;
    if !is_live_frame(&body.frame) || body.frame["sessionId"].as_str() != Some(&session_id) {
        return Err(ChatFailure::BadRequest("invalid live frame".into()));
    }
    let token = headers
        .get("x-cognia-run-token")
        .and_then(|v| v.to_str().ok())
        .ok_or(ChatFailure::Unauthorized)?;
    let message_id = body.frame["messageId"].as_str().expect("validated id");
    // Admission is uncached, even when the durable message ownership is cached.
    state
        .chat_store
        .admit_live_frame(
            RunWrite {
                org_id: &org_id,
                session_id: &session_id,
                run_id: &run_id,
                token_hash: &token_hash(token),
                now: (state.now)(),
            },
            message_id,
            body.tool_detail_revision,
        )
        .await
        .map_err(ChatFailure::Store)?;
    let key = (session_id.clone(), format!("run:{run_id}"), run_id.clone());
    let known = {
        let mut runs = state.chat_hub.run_messages.lock();
        runs.retain(|_, (_, expires)| *expires > (state.now)());
        runs.get(&key)
            .is_some_and(|(ids, _)| ids.contains(message_id))
    };
    if !known {
        let event = state
            .chat_store
            .get_message_event(&org_id, &session_id, message_id)
            .await
            .map_err(ChatFailure::Store)?;
        if event.kind != "message.created" || event.actor_id != format!("run:{run_id}") {
            return Err(ChatFailure::Forbidden);
        }
        // Cache is filled only by append_run_event. Lookup-only requests cannot grow it.
    }
    state
        .chat_hub
        .live_channels
        .publish(&session_id, body.frame);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendRunEventBody {
    tool_detail_revision: Option<u64>,
    kind: String,
    payload: serde_json::Value,
    operation_id: String,
}

async fn append_run_event(
    State(state): State<AppState>,
    Path((org_id, session_id, run_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<AppendRunEventBody>,
) -> Result<(StatusCode, Json<SessionEvent>), ChatFailure> {
    require_shared_chat_protocol(&headers)?;
    if !matches!(
        body.kind.as_str(),
        "message.created"
            | "message.corrected"
            | "run.started"
            | "run.paused"
            | "run.completed"
            | "run.failed"
    ) {
        return Err(ChatFailure::BadRequest(
            "run event kind is not writable".into(),
        ));
    }
    let token = headers
        .get("x-cognia-run-token")
        .and_then(|value| value.to_str().ok())
        .ok_or(ChatFailure::Unauthorized)?;
    let lease = state
        .chat_store
        .validate_run_token(
            &org_id,
            &session_id,
            &run_id,
            &token_hash(token),
            (state.now)(),
        )
        .await
        .map_err(|_| ChatFailure::Unauthorized)?;
    let (session, member) = state
        .chat_store
        .visible_session(&org_id, &session_id, &lease.holder_user_id)
        .await
        .map_err(ChatFailure::Store)?
        .ok_or(ChatFailure::Hidden)?;
    if !authorize_session_action(
        Some(&member),
        SessionAction::StartRun,
        session.policy_revision,
    )
    .allowed
    {
        return Err(ChatFailure::Forbidden);
    }
    if body.kind == "message.corrected" {
        let target = body
            .payload
            .get("targetMessageId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| ChatFailure::BadRequest("missing correction target".into()))?;
        let original = state
            .chat_store
            .get_message_event(&org_id, &session_id, target)
            .await
            .map_err(ChatFailure::Store)?;
        if original.actor_id != format!("run:{run_id}") {
            return Err(ChatFailure::Forbidden);
        }
    }
    let event = state
        .chat_store
        .append_session_run_event(
            NewSessionEvent {
                tool_detail_revision: body.tool_detail_revision,
                id: format!("evt_{}", Uuid::new_v4().simple()),
                org_id,
                workspace_id: session.workspace_id,
                session_id: session_id.clone(),
                kind: body.kind,
                actor_kind: "agent".into(),
                actor_id: format!("run:{run_id}"),
                actor_label: None,
                payload: body.payload,
                now: (state.now)(),
                operation_id: body.operation_id,
            },
            &run_id,
            &token_hash(token),
        )
        .await
        .map_err(ChatFailure::Store)?;
    let key = (event.session_id.clone(), event.actor_id.clone(), run_id);
    if event.kind == "message.created" {
        if let Some(message_id) = event
            .payload
            .get("messageId")
            .and_then(serde_json::Value::as_str)
        {
            let mut runs = state.chat_hub.run_messages.lock();
            runs.retain(|_, (_, expires)| *expires > (state.now)());
            runs.entry(key)
                .or_insert_with(|| (HashSet::new(), lease.token_expires_at))
                .0
                .insert(message_id.to_owned());
        }
    } else if matches!(event.kind.as_str(), "run.completed" | "run.failed") {
        state.chat_hub.run_messages.lock().remove(&key);
    }
    let _ = state.chat_hub.sender(&session_id).send(event.clone());
    Ok((StatusCode::CREATED, Json(event)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateApprovalBody {
    run_id: String,
    action: String,
    risk: String,
    expires_at: i64,
    operation_id: String,
}

async fn list_approvals(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::chat_store::ChatApprovalRequest>>, ChatFailure> {
    visible(&state, &headers, &org_id, &session_id, SessionAction::Read).await?;
    Ok(Json(
        state
            .chat_store
            .list_approvals(&org_id, &session_id, (state.now)())
            .await
            .map_err(ChatFailure::Store)?,
    ))
}

async fn create_approval(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateApprovalBody>,
) -> Result<(StatusCode, Json<crate::chat_store::ChatApprovalRequest>), ChatFailure> {
    let (session, member) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::StartRun,
    )
    .await?;
    let lease = state
        .chat_store
        .active_run_lease(&org_id, &session_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?
        .ok_or(ChatFailure::Gone)?;
    if lease.run_id != body.run_id || lease.holder_user_id != member.user_id {
        return Err(ChatFailure::Forbidden);
    }
    let now = (state.now)();
    if body.action.trim().is_empty()
        || !matches!(body.risk.as_str(), "ordinary" | "high")
        || body.expires_at <= now
        || body.expires_at > now + 30 * 60_000
    {
        return Err(ChatFailure::BadRequest(
            "invalid approval request or expiry".into(),
        ));
    }
    let approval = state
        .chat_store
        .create_approval(NewChatApprovalRequest {
            id: format!("apr_{}", Uuid::new_v4().simple()),
            org_id: org_id.clone(),
            workspace_id: session.workspace_id.clone(),
            session_id: session_id.clone(),
            run_id: body.run_id,
            action: body.action.trim().to_owned(),
            risk: body.risk,
            requested_by_user_id: member.user_id.clone(),
            expires_at: body.expires_at,
            now,
            operation_id: body.operation_id.clone(),
        })
        .await
        .map_err(ChatFailure::Store)?;
    let event = state
        .chat_store
        .append_session_event(NewSessionEvent {
            tool_detail_revision: None,
            id: format!("evt_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: session.workspace_id.clone(),
            session_id: session_id.clone(),
            kind: "approval.requested".into(),
            actor_kind: if member.guest { "guest" } else { "human" }.into(),
            actor_id: member.user_id,
            actor_label: member.display_name,
            payload: serde_json::json!({
                "approvalId": approval.id,
                "runId": approval.run_id,
                "action": approval.action,
                "risk": approval.risk,
                "expiresAt": approval.expires_at,
            }),
            now,
            operation_id: format!("{}:event", body.operation_id),
        })
        .await
        .map_err(ChatFailure::Store)?;
    let _ = state.chat_hub.sender(&session_id).send(event);
    deliver_approval_request(&state, &session, &approval).await;
    Ok((StatusCode::CREATED, Json(approval)))
}

/// Tell the people who may approve a high-risk request that a run is waiting
/// on them (ADR-0207). An ordinary request is resolved by its requester alone
/// (`resolve_approval`), so there is nobody else to tell.
async fn deliver_approval_request(
    state: &AppState,
    session: &crate::chat::SharedSession,
    approval: &crate::chat_store::ChatApprovalRequest,
) {
    if approval.risk != "high" {
        return;
    }
    let members = match state
        .chat_store
        .list_members(&session.org_id, &session.id)
        .await
    {
        Ok(members) => members,
        Err(error) => {
            tracing::warn!(%error, "approval notification: members unavailable");
            return;
        }
    };
    let drafts = members
        .iter()
        .filter(|member| {
            authorize_session_action(
                Some(member),
                SessionAction::ApproveHighRisk,
                session.policy_revision,
            )
            .allowed
        })
        .map(|member| {
            crate::notifications::Draft::chat_session(
                &member.user_id,
                crate::notifications::NotificationKind::ChatApprovalRequested,
                &session.id,
                format!("chat.approval_requested:{}", approval.id),
            )
        })
        .collect();
    crate::notifications::deliver(
        state,
        &session.org_id,
        &session.workspace_id,
        &approval.requested_by_user_id,
        drafts,
    )
    .await;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveApprovalBody {
    status: String,
    base_revision: i64,
}

async fn resolve_approval(
    State(state): State<AppState>,
    Path((org_id, session_id, approval_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<ResolveApprovalBody>,
) -> Result<Json<crate::chat_store::ChatApprovalRequest>, ChatFailure> {
    if !matches!(body.status.as_str(), "approved" | "denied") {
        return Err(ChatFailure::BadRequest(
            "approval status must be approved or denied".into(),
        ));
    }
    let (session, resolver) =
        visible(&state, &headers, &org_id, &session_id, SessionAction::Read).await?;
    let approval = state
        .chat_store
        .get_approval(&org_id, &session_id, &approval_id)
        .await
        .map_err(ChatFailure::Store)?;
    let lease = state
        .chat_store
        .active_run_lease(&org_id, &session_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?
        .ok_or(ChatFailure::Gone)?;
    if lease.run_id != approval.run_id {
        return Err(ChatFailure::Gone);
    }
    if approval.expires_at <= (state.now)() {
        state.chat_metrics.approval_expired();
        return Err(ChatFailure::Gone);
    }
    let required = if approval.risk == "high" {
        SessionAction::ApproveHighRisk
    } else {
        SessionAction::ApproveOrdinary
    };
    let decision = authorize_session_action(Some(&resolver), required, session.policy_revision);
    if !decision.allowed {
        return Err(ChatFailure::Forbidden);
    }
    if approval.risk == "ordinary" && resolver.user_id != approval.requested_by_user_id {
        return Err(ChatFailure::Forbidden);
    }
    let now = (state.now)();
    let resolved = state
        .chat_store
        .resolve_approval(
            &org_id,
            &session_id,
            &approval_id,
            &resolver.user_id,
            &body.status,
            body.base_revision,
            now,
        )
        .await
        .map_err(ChatFailure::Store)?;
    let event = state
        .chat_store
        .append_session_event(NewSessionEvent {
            tool_detail_revision: None,
            id: format!("evt_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: session.workspace_id,
            session_id: session_id.clone(),
            kind: "approval.resolved".into(),
            actor_kind: if resolver.guest { "guest" } else { "human" }.into(),
            actor_id: resolver.user_id,
            actor_label: resolver.display_name,
            payload: serde_json::json!({
                "approvalId": resolved.id,
                "status": resolved.status,
                "revision": resolved.revision,
            }),
            now,
            operation_id: format!("approval-resolve:{}:{}", resolved.id, resolved.revision),
        })
        .await
        .map_err(ChatFailure::Store)?;
    let _ = state.chat_hub.sender(&session_id).send(event);
    Ok(Json(resolved))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAttachmentBody {
    file_name: String,
    media_type: String,
    byte_length: i64,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentTicketResponse {
    attachment: ChatAttachment,
    ticket: String,
    expires_at: i64,
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn attachment_ticket_header(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-cognia-attachment-ticket")
        .and_then(|value| value.to_str().ok())
}

async fn create_attachment(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateAttachmentBody>,
) -> Result<(StatusCode, Json<AttachmentTicketResponse>), ChatFailure> {
    let (session, member) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::AttachmentWrite,
    )
    .await?;
    if body.file_name.trim().is_empty()
        || body.media_type.trim().is_empty()
        || !(0..=MAX_ATTACHMENT_BYTES).contains(&body.byte_length)
        || !valid_sha256(&body.sha256)
    {
        return Err(ChatFailure::BadRequest(
            "invalid attachment metadata".into(),
        ));
    }
    let now = (state.now)();
    let attachment_id = format!("att_{}", Uuid::new_v4().simple());
    let expires_at = now + ATTACHMENT_TICKET_TTL_MS;
    // Reserve capacity before persisting an attachment the caller cannot yet
    // address. A capacity rejection must not leave an orphan pending row.
    let ticket = state.chat_hub.issue_attachment_ticket(AttachmentTicket {
        org_id: org_id.clone(),
        session_id: session_id.clone(),
        attachment_id: attachment_id.clone(),
        user_id: member.user_id.clone(),
        action: AttachmentTicketAction::Upload,
        expires_at,
    })?;
    let attachment = state
        .chat_store
        .create_attachment(NewChatAttachment {
            id: attachment_id.clone(),
            org_id: org_id.clone(),
            workspace_id: session.workspace_id.clone(),
            session_id: session_id.clone(),
            object_key: format!(
                "{}/{}/{}/{}",
                org_id, session.workspace_id, session_id, attachment_id
            ),
            file_name: body.file_name.trim().to_owned(),
            media_type: body.media_type.trim().to_owned(),
            byte_length: body.byte_length,
            sha256: body.sha256.to_ascii_lowercase(),
            created_by_user_id: member.user_id.clone(),
            now,
        })
        .await
        .map_err(|error| {
            state.chat_hub.attachment_tickets.discard(&ticket);
            ChatFailure::Store(error)
        })?;
    Ok((
        StatusCode::CREATED,
        Json(AttachmentTicketResponse {
            attachment,
            ticket,
            expires_at,
        }),
    ))
}

async fn issue_attachment_ticket(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
    session_id: &str,
    attachment_id: &str,
    action: AttachmentTicketAction,
) -> Result<AttachmentTicketResponse, ChatFailure> {
    let permission = if action == AttachmentTicketAction::Upload {
        SessionAction::AttachmentWrite
    } else {
        SessionAction::AttachmentRead
    };
    let (_, member) = visible(state, headers, org_id, session_id, permission).await?;
    let attachment = state
        .chat_store
        .get_attachment(org_id, session_id, attachment_id)
        .await
        .map_err(ChatFailure::Store)?;
    if action == AttachmentTicketAction::Upload {
        state.chat_store.admit_session_write(org_id, session_id).await.map_err(ChatFailure::Store)?;
    }
    if action == AttachmentTicketAction::Upload && attachment.status != "pending" {
        return Err(ChatFailure::Store(StoreError::Conflict(
            serde_json::to_value(&attachment).unwrap_or_default(),
        )));
    }
    if action == AttachmentTicketAction::Download && attachment.status != "available" {
        return Err(ChatFailure::Hidden);
    }
    let expires_at = (state.now)() + ATTACHMENT_TICKET_TTL_MS;
    let ticket = state.chat_hub.issue_attachment_ticket(AttachmentTicket {
        org_id: org_id.to_owned(),
        session_id: session_id.to_owned(),
        attachment_id: attachment_id.to_owned(),
        user_id: member.user_id,
        action,
        expires_at,
    })?;
    Ok(AttachmentTicketResponse {
        attachment,
        ticket,
        expires_at,
    })
}

async fn create_attachment_upload_ticket(
    State(state): State<AppState>,
    Path((org_id, session_id, attachment_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<AttachmentTicketResponse>, ChatFailure> {
    Ok(Json(
        issue_attachment_ticket(
            &state,
            &headers,
            &org_id,
            &session_id,
            &attachment_id,
            AttachmentTicketAction::Upload,
        )
        .await?,
    ))
}

async fn create_attachment_download_ticket(
    State(state): State<AppState>,
    Path((org_id, session_id, attachment_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Json<AttachmentTicketResponse>, ChatFailure> {
    Ok(Json(
        issue_attachment_ticket(
            &state,
            &headers,
            &org_id,
            &session_id,
            &attachment_id,
            AttachmentTicketAction::Download,
        )
        .await?,
    ))
}

async fn authorize_attachment_ticket(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
    attachment_id: &str,
    action: AttachmentTicketAction,
) -> Result<(AttachmentTicket, ChatAttachment), ChatFailure> {
    require_shared_chat_protocol(headers)?;
    let ticket = state
        .chat_hub
        .consume_attachment_ticket(
            attachment_ticket_header(headers).unwrap_or_default(),
            action,
            (state.now)(),
        )
        .filter(|ticket| ticket.org_id == org_id && ticket.attachment_id == attachment_id)
        .ok_or(ChatFailure::Unauthorized)?;
    let pair = state
        .chat_store
        .visible_session(org_id, &ticket.session_id, &ticket.user_id)
        .await
        .map_err(ChatFailure::Store)?
        .ok_or(ChatFailure::Hidden)?;
    let permission = if action == AttachmentTicketAction::Upload {
        SessionAction::AttachmentWrite
    } else {
        SessionAction::AttachmentRead
    };
    if !authorize_session_action(Some(&pair.1), permission, pair.0.policy_revision).allowed {
        return Err(ChatFailure::Forbidden);
    }
    if action == AttachmentTicketAction::Upload {
        state.chat_store.admit_session_write(org_id, &ticket.session_id).await.map_err(ChatFailure::Store)?;
    }
    let attachment = state
        .chat_store
        .get_attachment(org_id, &ticket.session_id, attachment_id)
        .await
        .map_err(ChatFailure::Store)?;
    Ok((ticket, attachment))
}

async fn upload_attachment(
    State(state): State<AppState>,
    Path((org_id, attachment_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ChatFailure> {
    let (_, attachment) = authorize_attachment_ticket(
        &state,
        &headers,
        &org_id,
        &attachment_id,
        AttachmentTicketAction::Upload,
    )
    .await?;
    let digest = hex::encode(Sha256::digest(&body));
    if attachment.status != "pending"
        || body.len() as i64 != attachment.byte_length
        || digest != attachment.sha256
    {
        state.chat_metrics.attachment_failed();
        return Err(ChatFailure::BadRequest(
            "attachment content does not match declared metadata".into(),
        ));
    }
    let stored = state
        .chat_attachments
        .put(&attachment.object_key, body)
        .await;
    if stored.is_err() {
        state.chat_metrics.attachment_failed();
    }
    stored.map_err(|_| ChatFailure::ObjectStore)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitAttachmentBody {
    event_id: Option<String>,
}

async fn commit_attachment(
    State(state): State<AppState>,
    Path((org_id, session_id, attachment_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<CommitAttachmentBody>,
) -> Result<Json<ChatAttachment>, ChatFailure> {
    visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::AttachmentWrite,
    )
    .await?;
    let attachment = state
        .chat_store
        .get_attachment(&org_id, &session_id, &attachment_id)
        .await
        .map_err(ChatFailure::Store)?;
    let bytes = state.chat_attachments.get(&attachment.object_key).await;
    if bytes.is_err() {
        state.chat_metrics.attachment_failed();
    }
    let bytes =
        bytes.map_err(|_| ChatFailure::BadRequest("attachment upload is incomplete".into()))?;
    if bytes.len() as i64 != attachment.byte_length
        || hex::encode(Sha256::digest(&bytes)) != attachment.sha256
    {
        state.chat_metrics.attachment_failed();
        return Err(ChatFailure::BadRequest(
            "attachment content does not match declared metadata".into(),
        ));
    }
    Ok(Json(
        state
            .chat_store
            .commit_attachment(
                &org_id,
                &session_id,
                &attachment_id,
                body.event_id.as_deref(),
                (state.now)(),
            )
            .await
            .map_err(ChatFailure::Store)?,
    ))
}

async fn download_attachment(
    State(state): State<AppState>,
    Path((org_id, attachment_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ChatFailure> {
    let (_, attachment) = authorize_attachment_ticket(
        &state,
        &headers,
        &org_id,
        &attachment_id,
        AttachmentTicketAction::Download,
    )
    .await?;
    if attachment.status != "available" {
        return Err(ChatFailure::Hidden);
    }
    let bytes = state
        .chat_attachments
        .get(&attachment.object_key)
        .await
        .map_err(|_| ChatFailure::ObjectStore)?;
    let mut response = bytes.into_response();
    if let Ok(value) = HeaderValue::from_str(&attachment.media_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    Ok(response)
}

async fn delete_attachment(
    State(state): State<AppState>,
    Path((org_id, session_id, attachment_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ChatFailure> {
    visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::AttachmentWrite,
    )
    .await?;
    let deleted = state
        .chat_store
        .delete_attachment(&org_id, &session_id, &attachment_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?;
    state
        .chat_attachments
        .delete(&deleted.object_key)
        .await
        .map_err(|_| ChatFailure::ObjectStore)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    #[test]
    fn activated_import_retries_require_the_same_durable_event_and_actor() {
        use super::*;
        let payload =
            serde_json::json!({"messageId":"m", "role":"assistant", "parts":[], "imported":true});
        let event = SessionEvent {
            id: "event".into(),
            session_id: "session".into(),
            sequence: 1,
            kind: "message.created".into(),
            actor_kind: "human".into(),
            actor_id: "owner".into(),
            actor_label: None,
            payload: payload.clone(),
            created_at: 1,
            operation_id: "import-op".into(),
        };
        let mut body = AppendEventBody {
            id: None,
            kind: "message.created".into(),
            payload,
            operation_id: "import-op".into(),
            actor_label: None,
        };
        assert!(is_import_replay(&event, &body, "owner"));
        assert!(!is_import_replay(&event, &body, "other-member"));
        body.operation_id = "new-import-op".into();
        assert!(!is_import_replay(&event, &body, "owner"));
        body.operation_id = "import-op".into();
        body.payload["parts"] = serde_json::json!([{"type":"text", "text":"changed"}]);
        assert!(!is_import_replay(&event, &body, "owner"));
    }

    #[test]
    fn ordinary_posts_bind_the_author_and_only_explicit_imports_preserve_roles() {
        use super::*;
        let mut session = crate::chat::SharedSession {
            tool_detail: crate::chat::ToolDetail::Summary,
            tool_detail_revision: 0,
            contract_version: crate::admission::COLLAB_PROTOCOL_VERSION as i32,
            id: "session".into(),
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            title: "Chat".into(),
            status: SessionStatus::Active,
            created_by_user_id: "owner".into(),
            created_at: 1,
            updated_at: 1,
            revision: 1,
            policy_revision: 1,
        };
        let mut member = crate::chat::SessionMembership {
            session_id: "session".into(),
            user_id: "owner".into(),
            role: SessionRole::Owner,
            approver: false,
            guest: false,
            display_name: Some("Owner".into()),
            created_at: 1,
            updated_at: 1,
        };
        let mut payload = serde_json::json!({"messageId":"m", "role":"user", "parts":[], "author":{"kind":"human", "id":"victim"}});
        normalize_human_message(&session, &member, &mut payload).unwrap();
        assert_eq!(payload["author"]["id"], "owner");
        member.guest = true;
        normalize_human_message(&session, &member, &mut payload).unwrap();
        assert_eq!(payload["author"]["kind"], "guest");
        member.guest = false;
        for role in ["assistant", "system", "tool"] {
            payload["role"] = serde_json::json!(role);
            assert!(normalize_human_message(&session, &member, &mut payload).is_err());
        }
        payload["role"] = serde_json::json!("assistant");
        payload["imported"] = serde_json::json!(true);
        session.status = SessionStatus::Importing;
        let historical = payload.clone();
        normalize_human_message(&session, &member, &mut payload).unwrap();
        assert_eq!(payload, historical);
        member.role = SessionRole::Member;
        assert!(normalize_human_message(&session, &member, &mut payload).is_err());
        member.role = SessionRole::Owner;
        member.user_id = "other-owner".into();
        assert!(normalize_human_message(&session, &member, &mut payload).is_err());
        assert!(normalize_human_message(
            &session,
            &member,
            &mut serde_json::json!({"role":"user"})
        )
        .is_err());
        // A blank or non-string id is as incomplete as a missing one.
        normalize_human_message(
            &session,
            &member,
            &mut serde_json::json!({"messageId":"m", "role":"user", "parts":[]}),
        )
        .unwrap();
        for message_id in [serde_json::json!("   "), serde_json::json!(7)] {
            assert!(matches!(
                normalize_human_message(
                    &session,
                    &member,
                    &mut serde_json::json!({"messageId": message_id, "role":"user", "parts":[]})
                ),
                Err(ChatFailure::BadRequest(reason)) if reason == "message is incomplete"
            ));
        }
    }

    #[test]
    fn maintainers_cannot_overwrite_an_owner_through_membership_upsert() {
        use super::{can_change_member_role, SessionRole};
        assert!(!can_change_member_role(
            SessionRole::Maintainer,
            Some(SessionRole::Owner),
            SessionRole::Member
        ));
        assert!(!can_change_member_role(
            SessionRole::Maintainer,
            None,
            SessionRole::Owner
        ));
        assert!(can_change_member_role(
            SessionRole::Owner,
            Some(SessionRole::Owner),
            SessionRole::Member
        ));
        assert!(can_change_member_role(
            SessionRole::Maintainer,
            Some(SessionRole::Member),
            SessionRole::Viewer
        ));
    }
    use super::*;

    /// Chat tokens are looked up by this hash, so its spelling is part of the
    /// stored schema.
    #[test]
    fn chat_token_hashes_are_lowercase_sha256_hex() {
        assert_eq!(
            token_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[tokio::test]
    async fn export_authorization_uses_current_membership_and_never_caches_success() {
        use crate::chat_store::NewSharedSession;
        use axum::{body::Body, http::Request};
        use cognia_tenant_auth::{grant::GrantClaims, OrgId, UserId};
        use std::sync::Arc;
        use std::time::Duration;
        use tower::ServiceExt;

        let org = "org_acme00000000000000000";
        let user = UserId::parse("usr_aaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        let signer = cognia_tenant_auth::grant::GrantSigner::new(&[7; 32]).unwrap();
        let claims = GrantClaims::issue(
            user.clone(),
            OrgId::parse(org).unwrap(),
            None,
            None,
            Duration::from_secs(300),
        )
        .unwrap();
        let grant = format!("Bearer {}", signer.sign(&claims).unwrap());
        let store = crate::store::InMemoryStore::new();
        for id in [user.as_str(), "another-owner"] {
            store.add_org_member(org, id, OrgRole::Owner);
        }
        let state = AppState::new(
            Arc::new(store),
            signer,
            Arc::new(cognia_tenant_auth::oidc::TestAuthenticator),
        );
        state
            .chat_store
            .create_session(NewSharedSession {
                id: "session".into(),
                org_id: org.into(),
                workspace_id: "workspace".into(),
                title: "Shared".into(),
                status: SessionStatus::Active,
                created_by_user_id: "another-owner".into(),
                now: 1,
                operation_id: "create".into(),
            })
            .await
            .unwrap();
        let app = routes().with_state(state.clone());
        for (role, guest, expected) in [
            (SessionRole::Owner, false, StatusCode::NO_CONTENT),
            (SessionRole::Maintainer, false, StatusCode::NO_CONTENT),
            (SessionRole::Member, false, StatusCode::FORBIDDEN),
            (SessionRole::Viewer, false, StatusCode::FORBIDDEN),
            (SessionRole::Member, true, StatusCode::FORBIDDEN),
        ] {
            state
                .chat_store
                .put_member(
                    org,
                    "session",
                    "workspace",
                    user.as_str(),
                    role,
                    false,
                    guest,
                    "another-owner",
                    2,
                )
                .await
                .unwrap();
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!(
                            "/v1/orgs/{org}/chat-sessions/session/export-authorization"
                        ))
                        .header("authorization", &grant)
                        .header(
                            "x-cognia-collab-protocol",
                            SHARED_CHAT_PROTOCOL_VERSION.to_string(),
                        )
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "{role:?} guest={guest}");
            if expected == StatusCode::NO_CONTENT {
                assert_eq!(response.headers()["cache-control"], "no-store");
            }
        }
    }

    #[tokio::test]
    async fn file_share_authorization_needs_files_share_and_the_org_policy() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;

        let (state, grant) = notification_fixture().await;
        let app = routes().with_state(state.clone());
        let ask = |user: &str, scope: &str| {
            Request::builder()
                .uri(format!(
                    "/v1/orgs/{NOTICE_ORG}/chat-sessions/session/export-authorization{scope}"
                ))
                .header("authorization", grant(user))
                .header(
                    "x-cognia-collab-protocol",
                    SHARED_CHAT_PROTOCOL_VERSION.to_string(),
                )
                .body(Body::empty())
                .unwrap()
        };
        state
            .chat_store
            .put_member(
                NOTICE_ORG,
                "session",
                "workspace",
                BOB,
                SessionRole::Member,
                false,
                false,
                ADA,
                2,
            )
            .await
            .unwrap();

        // The owner may; the answer names the policy revision it used.
        let response = app.clone().oneshot(ask(ADA, "?scope=files")).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(response.headers()["x-cognia-file-policy-revision"], "0");
        assert_eq!(response.headers()["cache-control"], "no-store");
        // A member may not, and the transcript scope is unchanged.
        let response = app.clone().oneshot(ask(BOB, "?scope=files")).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = app.clone().oneshot(ask(BOB, "")).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = app
            .clone()
            .oneshot(ask(ADA, "?scope=transcript"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let response = app
            .clone()
            .oneshot(ask(ADA, "?scope=everything"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

        // The org turns public snapshots off: even the owner is refused, and
        // the refusal is audited against the conversation.
        state
            .file_sharing_store
            .put_file_sharing_policy(
                NOTICE_ORG,
                crate::file_sharing::FileSharingSettings {
                    allow_public_snapshots: false,
                    ..Default::default()
                },
                0,
                ADA,
                5,
            )
            .await
            .unwrap();
        let response = app.clone().oneshot(ask(ADA, "?scope=files")).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let audit = state
            .store
            .list_authorization_audit(NOTICE_ORG, 50)
            .await
            .unwrap();
        assert!(audit.iter().any(|event| event.action == "files.share"
            && event.reason == "org_file_sharing_policy"
            && event.source["policyRevision"] == 1
            && event.source["allowed"] == false));
        // Exporting the transcript is a different question.
        let response = app.oneshot(ask(ADA, "")).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    /// A store and state with Ada (owner of `session`), Bob and Cy all in
    /// `workspace`, plus a grant per person.
    async fn notification_fixture() -> (AppState, impl Fn(&str) -> String) {
        use crate::chat_store::NewSharedSession;
        use cognia_tenant_auth::{grant::GrantClaims, OrgId, UserId};
        use std::sync::Arc;
        use std::time::Duration;

        let store = crate::store::InMemoryStore::new();
        store.add_workspace(NOTICE_ORG, "workspace", "Workspace");
        for (user, name) in [(ADA, "Ada"), (BOB, "Bob"), (CY, "Cy")] {
            store.add_user(user, name);
            store.add_org_member(NOTICE_ORG, user, OrgRole::Member);
            store.add_workspace_member(NOTICE_ORG, "workspace", user, WorkspaceRole::Member);
        }
        store.add_workspace_member(NOTICE_ORG, "workspace", ADA, WorkspaceRole::Maintainer);
        store.add_user("usr_authorization_admin", "Organization manager");
        store.add_org_member(NOTICE_ORG, "usr_authorization_admin", OrgRole::Owner);
        let signer = cognia_tenant_auth::grant::GrantSigner::new(&[9; 32]).unwrap();
        let mut state = AppState::new(
            Arc::new(store),
            signer.clone(),
            Arc::new(cognia_tenant_auth::oidc::TestAuthenticator),
        );
        state.now = Arc::new(|| 10);
        state
            .chat_store
            .create_session(NewSharedSession {
                id: "session".into(),
                org_id: NOTICE_ORG.into(),
                workspace_id: "workspace".into(),
                title: "Shared".into(),
                status: SessionStatus::Active,
                created_by_user_id: ADA.into(),
                now: 1,
                operation_id: "create".into(),
            })
            .await
            .unwrap();
        let grant = move |user: &str| {
            let claims = GrantClaims::issue(
                UserId::parse(user).unwrap(),
                OrgId::parse(NOTICE_ORG).unwrap(),
                None,
                None,
                Duration::from_secs(300),
            )
            .unwrap();
            format!("Bearer {}", signer.sign(&claims).unwrap())
        };
        (state, grant)
    }

    const NOTICE_ORG: &str = "org_acme00000000000000000";
    const ADA: &str = "usr_aaaaaaaaaaaaaaaaaaaaaaaa";
    const BOB: &str = "usr_bbbbbbbbbbbbbbbbbbbbbbbb";
    const CY: &str = "usr_cccccccccccccccccccccccc";

    #[tokio::test]
    async fn a_named_invitee_is_told_and_only_they_can_accept_by_id() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;

        let (state, grant) = notification_fixture().await;
        let app = routes().with_state(state.clone());
        let send = |method: &str, path: String, user: &str, body: serde_json::Value| {
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", grant(user))
                .header("content-type", "application/json")
                .header(
                    "x-cognia-collab-protocol",
                    SHARED_CHAT_PROTOCOL_VERSION.to_string(),
                )
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let response = app
            .clone()
            .oneshot(send(
                "POST",
                format!("/v1/orgs/{NOTICE_ORG}/chat-sessions/session/invites"),
                ADA,
                serde_json::json!({
                    "targetUserId": BOB, "role": "member", "expiresAt": 10 + 60_000,
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let created: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap(),
        )
        .unwrap();
        let invite_id = created["invite"]["id"].as_str().unwrap().to_owned();

        let told = state
            .notification_store
            .list(NOTICE_ORG, BOB, 0, 10)
            .await
            .unwrap();
        assert_eq!(told.len(), 1);
        assert_eq!(
            told[0].kind,
            crate::notifications::NotificationKind::ChatInvited
        );
        assert_eq!(told[0].subject.entity, "chat_invite");
        assert_eq!(told[0].subject.id, invite_id);
        assert!(state
            .notification_store
            .list(NOTICE_ORG, ADA, 0, 10)
            .await
            .unwrap()
            .is_empty());

        let accept = |user: &str| {
            send(
                "POST",
                format!("/v1/orgs/{NOTICE_ORG}/chat-invites/{invite_id}/accept"),
                user,
                serde_json::json!({}),
            )
        };
        // Cy holds no token and is not named.
        let refused = app.clone().oneshot(accept(CY)).await.unwrap();
        assert_ne!(refused.status(), StatusCode::OK);
        let accepted = app.clone().oneshot(accept(BOB)).await.unwrap();
        assert_eq!(accepted.status(), StatusCode::OK);
        let again = app.oneshot(accept(BOB)).await.unwrap();
        assert_ne!(again.status(), StatusCode::OK, "an invite is used once");
    }

    #[tokio::test]
    async fn a_high_risk_request_reaches_every_other_approver_and_an_ordinary_one_nobody() {
        let (state, _) = notification_fixture().await;
        for (user, role, approver) in [
            (BOB, SessionRole::Member, true),
            (CY, SessionRole::Viewer, false),
        ] {
            state
                .chat_store
                .put_member(
                    NOTICE_ORG,
                    "session",
                    "workspace",
                    user,
                    role,
                    approver,
                    false,
                    ADA,
                    2,
                )
                .await
                .unwrap();
        }
        let session = state
            .chat_store
            .admin_session(NOTICE_ORG, "session")
            .await
            .unwrap();
        let request = |id: &str, risk: &str| crate::chat_store::ChatApprovalRequest {
            id: id.into(),
            session_id: "session".into(),
            run_id: "run".into(),
            action: "deploy".into(),
            risk: risk.into(),
            requested_by_user_id: ADA.into(),
            status: "pending".into(),
            resolved_by_user_id: None,
            resolved_at: None,
            expires_at: 100,
            created_at: 10,
            revision: 1,
        };
        deliver_approval_request(&state, &session, &request("apr_ordinary", "ordinary")).await;
        deliver_approval_request(&state, &session, &request("apr_high", "high")).await;

        let rows = |user: &'static str| {
            let store = state.notification_store.clone();
            async move { store.list(NOTICE_ORG, user, 0, 10).await.unwrap() }
        };
        let bob_rows = rows(BOB).await;
        assert_eq!(bob_rows.len(), 1, "only the high-risk request");
        assert_eq!(bob_rows[0].dedupe_key, "chat.approval_requested:apr_high");
        // The requester is not told about their own request; a viewer cannot
        // approve and is not asked to.
        assert!(rows(ADA).await.is_empty());
        assert!(rows(CY).await.is_empty());
    }

    #[test]
    fn issuing_tickets_reclaims_expired_unused_credentials() {
        let hub = ChatHub::default();
        hub.issue_ticket(SocketTicket {
            org_id: "org".into(),
            session_id: "session".into(),
            user_id: "user".into(),
            expires_at: 1,
        })
        .unwrap();
        hub.issue_ticket(SocketTicket {
            org_id: "org".into(),
            session_id: "session".into(),
            user_id: "user".into(),
            expires_at: SOCKET_TICKET_TTL_MS + 1,
        })
        .unwrap();
        assert_eq!(hub.tickets.len(), 1);

        for expires_at in [1, ATTACHMENT_TICKET_TTL_MS + 1] {
            hub.issue_attachment_ticket(AttachmentTicket {
                org_id: "org".into(),
                session_id: "session".into(),
                attachment_id: "attachment".into(),
                user_id: "user".into(),
                action: AttachmentTicketAction::Upload,
                expires_at,
            })
            .unwrap();
        }
        assert_eq!(hub.attachment_tickets.len(), 1);
    }

    #[tokio::test]
    async fn idle_stream_releases_its_subscription_when_the_peer_closes() {
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let state = AppState::new(
            Arc::new(crate::store::InMemoryStore::new()),
            cognia_tenant_auth::grant::GrantSigner::new(&[7; 32]).unwrap(),
            Arc::new(cognia_tenant_auth::oidc::TestAuthenticator),
        );
        let sender = state.chat_hub.sender("session");
        let subscription = sender.clone();
        let (ended_tx, ended_rx) = tokio::sync::oneshot::channel();
        let ended = Arc::new(std::sync::Mutex::new(Some(ended_tx)));
        let app = Router::new().route(
            "/stream",
            get(move |ws: WebSocketUpgrade| {
                let state = state.clone();
                let receiver = subscription.subscribe();
                let ended = ended.clone();
                async move {
                    ws.on_upgrade(move |socket| async move {
                        stream_loop(
                            socket,
                            state,
                            SocketTicket {
                                org_id: "org".into(),
                                session_id: "session".into(),
                                user_id: "user".into(),
                                expires_at: i64::MAX,
                            },
                            receiver,
                        )
                        .await;
                        let _ = ended.lock().unwrap().take().unwrap().send(());
                    })
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client.write_all(b"GET /stream HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").await.unwrap();
        let mut response = Vec::new();
        while !response.ends_with(b"\r\n\r\n") {
            response.push(client.read_u8().await.unwrap());
        }
        assert!(response.starts_with(b"HTTP/1.1 101"));
        assert_eq!(sender.receiver_count(), 1);
        // A client close frame must be masked, including an empty payload.
        client.write_all(&[0x88, 0x80, 0, 0, 0, 0]).await.unwrap();
        let finished = tokio::time::timeout(std::time::Duration::from_secs(1), ended_rx).await;
        server.abort();
        assert!(finished.is_ok(), "idle socket retained its server task");
        assert_eq!(sender.receiver_count(), 0);
    }

    #[tokio::test]
    async fn a_manager_cannot_assign_creator_ownership_to_a_plain_workspace_writer() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let (state, grant) = notification_fixture().await;
        let app = crate::router(state);
        for (resource, role, expected) in [
            ("members", "owner", StatusCode::FORBIDDEN),
            ("members", "member", StatusCode::CREATED),
            ("invites", "maintainer", StatusCode::FORBIDDEN),
            ("invites", "member", StatusCode::CREATED),
        ] {
            let body = serde_json::json!({"userId":BOB, "targetUserId":BOB, "role":role, "expiresAt":60_010});
            let request = Request::builder().method("POST").uri(format!("/v1/orgs/{NOTICE_ORG}/chat-sessions/session/{resource}"))
                .header("authorization", grant(ADA)).header("x-cognia-collab-protocol", "2").header("content-type", "application/json")
                .body(Body::from(body.to_string())).unwrap();
            assert_eq!(app.clone().oneshot(request).await.unwrap().status(), expected, "{resource}/{role}");
        }
    }

    #[tokio::test]
    async fn workspace_writer_can_import_history_and_activate_the_session_they_created() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let (state, grant) = notification_fixture().await;
        let app = crate::router(state.clone());
        let send = |method: &str, path: String, body: serde_json::Value| Request::builder()
            .method(method).uri(path).header("authorization", grant(BOB))
            .header("x-cognia-collab-protocol", "2").header("content-type", "application/json")
            .body(Body::from(body.to_string())).unwrap();
        let response = app.clone().oneshot(send("POST", format!("/v1/orgs/{NOTICE_ORG}/workspaces/workspace/chat-sessions"),
            serde_json::json!({"title":"Import", "importing":true, "operationId":"writer-create"}))).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let session: serde_json::Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
        let id = session["id"].as_str().unwrap();
        let response = app.clone().oneshot(send("POST", format!("/v1/orgs/{NOTICE_ORG}/chat-sessions/{id}/events"),
            serde_json::json!({"kind":"message.created", "operationId":"writer-import", "payload":{"messageId":"history", "role":"assistant", "parts":[{"type":"text","text":"Imported"}], "imported":true}}))).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let response = app.oneshot(send("PATCH", format!("/v1/orgs/{NOTICE_ORG}/chat-sessions/{id}"),
            serde_json::json!({"status":"active", "baseRevision":session["revision"], "operationId":"writer-activate"}))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let (session, member) = state.chat_store.visible_session(NOTICE_ORG, id, BOB).await.unwrap().unwrap();
        assert_eq!(session.status, SessionStatus::Active);
        assert_eq!(member.role, SessionRole::Owner);
    }

    fn revocation_context() -> crate::store::AuthorizationContext {
        crate::store::AuthorizationContext {
            actor_user_id: "usr_authorization_admin".into(), reason: "offboard".into(), request_id: "request".into(),
            grant_id: None, source: serde_json::json!({}), now: 10,
        }
    }

    #[tokio::test]
    async fn standing_mutation_handlers_revoke_tickets_and_publish_membership_after_commit() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        for mutation in ["offboard", "remove", "demote"] {
            let (state, grant) = notification_fixture().await;
            state.store.set_org_member(NOTICE_ORG, ADA, OrgRole::Owner, revocation_context()).await.unwrap();
            state.chat_store.put_member(NOTICE_ORG, "session", "workspace", BOB, SessionRole::Member, false, false, ADA, 2).await.unwrap();
            let ticket = state.chat_hub.issue_ticket(SocketTicket { org_id: NOTICE_ORG.into(), session_id: "session".into(), user_id: BOB.into(), expires_at: SOCKET_TICKET_TTL_MS + 10 }).unwrap();
            let attachment_ticket = state.chat_hub.issue_attachment_ticket(AttachmentTicket { org_id: NOTICE_ORG.into(), session_id: "session".into(), user_id: BOB.into(), attachment_id: "attachment".into(), action: AttachmentTicketAction::Download, expires_at: ATTACHMENT_TICKET_TTL_MS + 10 }).unwrap();
            let path = if mutation == "offboard" { format!("/v1/orgs/{NOTICE_ORG}/members/{BOB}") } else { format!("/v1/orgs/{NOTICE_ORG}/workspaces/workspace/members/{BOB}") };
            let body = if mutation == "demote" { Body::from(r#"{"role":"viewer","reason":"demote"}"#) } else { Body::empty() };
            let request = Request::builder().method(if mutation == "demote" { "PATCH" } else { "DELETE" }).uri(path)
                .header("authorization", grant(ADA)).header("content-type", "application/json").body(body).unwrap();
            let mut feed = state.feed_hub.subscribe_for_test(NOTICE_ORG);
            let response = crate::router(state.clone()).oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT, "{mutation}");
            assert_eq!(feed.try_recv().unwrap(), crate::feed::FeedFrame::membership(BOB, if mutation == "offboard" { None } else { Some("workspace") }));
            assert!(state.chat_hub.consume_ticket(&ticket, 10).is_none());
            assert!(state.chat_hub.consume_attachment_ticket(&attachment_ticket, AttachmentTicketAction::Download, 10).is_none());
        }
    }

    #[tokio::test]
    async fn offboarded_grant_cannot_read_post_attach_claim_or_approve() {
        let (state, grant) = notification_fixture().await;
        state.chat_store.put_member(NOTICE_ORG, "session", "workspace", BOB, SessionRole::Member, true, false, ADA, 2).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", grant(BOB).parse().unwrap());
        headers.insert("x-cognia-collab-protocol", "2".parse().unwrap());
        assert!(visible(&state, &headers, NOTICE_ORG, "session", SessionAction::Post).await.is_ok());
        state.store.offboard_org_member(NOTICE_ORG, BOB, revocation_context()).await.unwrap();
        // The signed grant is unchanged and unexpired throughout this check.
        for action in [SessionAction::Read, SessionAction::Post, SessionAction::AttachmentRead, SessionAction::AttachmentWrite, SessionAction::StartRun, SessionAction::ApproveHighRisk] {
            assert!(matches!(visible(&state, &headers, NOTICE_ORG, "session", action).await, Err(ChatFailure::Hidden)));
        }
        assert!(create_stream_ticket(State(state.clone()), Path((NOTICE_ORG.into(), "session".into())), headers.clone()).await.is_err());
        assert!(issue_attachment_ticket(&state, &headers, NOTICE_ORG, "session", "attachment", AttachmentTicketAction::Download).await.is_err());
        let ticket = SocketTicket { org_id: NOTICE_ORG.into(), session_id: "session".into(), user_id: BOB.into(), expires_at: i64::MAX };
        assert!(!stream_visible(&state, &ticket).await);
    }

    #[tokio::test]
    async fn idle_stream_closes_on_standing_tick_without_an_event() {
        use futures_util::StreamExt;
        let (state, _) = notification_fixture().await;
        state.chat_store.put_member(NOTICE_ORG, "session", "workspace", BOB, SessionRole::Member, false, false, ADA, 2).await.unwrap();
        let stream_state = state.clone();
        let app = Router::new().route("/stream", get(move |ws: WebSocketUpgrade| {
            let state = stream_state.clone();
            async move {
                let receiver = state.chat_hub.sender("session").subscribe();
                ws.on_upgrade(move |socket| stream_loop(socket, state, SocketTicket {
                    org_id: NOTICE_ORG.into(), session_id: "session".into(), user_id: BOB.into(), expires_at: i64::MAX,
                }, receiver))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/stream")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        state.store.offboard_org_member(NOTICE_ORG, BOB, revocation_context()).await.unwrap();
        let closed = tokio::time::timeout(std::time::Duration::from_secs(6), socket.next()).await;
        server.abort();
        assert!(matches!(closed, Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))))));
    }

    #[test]
    fn ticket_capacity_rejects_new_credentials_without_invalidating_live_ones() {
        let hub = ChatHub::default();
        let socket = SocketTicket {
            org_id: "org".into(),
            session_id: "session".into(),
            user_id: "user".into(),
            expires_at: SOCKET_TICKET_TTL_MS + 1,
        };
        let attachment = AttachmentTicket {
            org_id: "org".into(),
            session_id: "session".into(),
            user_id: "user".into(),
            attachment_id: "attachment".into(),
            action: AttachmentTicketAction::Upload,
            expires_at: ATTACHMENT_TICKET_TTL_MS + 1,
        };
        let first_socket = hub.tickets.issue(socket.clone(), 0).unwrap();
        let first_attachment = hub.attachment_tickets.issue(attachment.clone(), 0).unwrap();
        for _ in 1..MAX_PENDING_TICKETS {
            hub.tickets.issue(socket.clone(), 0).unwrap();
            hub.attachment_tickets.issue(attachment.clone(), 0).unwrap();
        }
        assert!(matches!(
            hub.issue_ticket(socket.clone()),
            Err(ChatFailure::TicketCapacity)
        ));
        assert!(matches!(
            hub.issue_attachment_ticket(attachment.clone()),
            Err(ChatFailure::TicketCapacity)
        ));
        assert_eq!(
            ChatFailure::TicketCapacity.into_response().status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert!(hub.consume_ticket(&first_socket, 1).is_some());
        assert!(hub
            .consume_attachment_ticket(&first_attachment, AttachmentTicketAction::Upload, 1)
            .is_some());
        assert!(hub.issue_ticket(socket).is_ok());
        assert!(hub.issue_attachment_ticket(attachment).is_ok());
        assert_eq!(hub.tickets.len(), MAX_PENDING_TICKETS);
        assert_eq!(hub.attachment_tickets.len(), MAX_PENDING_TICKETS);
    }

    #[test]
    fn leaving_requires_membership_but_removing_others_requires_management() {
        assert_eq!(
            member_removal_action("member", "member").as_str(),
            "session.read"
        );
        assert_eq!(
            member_removal_action("member", "other").as_str(),
            "session.manageMembers"
        );
        assert!(
            !authorize_session_action(None, member_removal_action("member", "member"), 1).allowed
        );
    }

    #[test]
    fn socket_tickets_are_single_use_and_expire() {
        let hub = ChatHub::default();
        let value = hub
            .issue_ticket(SocketTicket {
                org_id: "org".into(),
                session_id: "ses".into(),
                user_id: "usr".into(),
                expires_at: 20,
            })
            .unwrap();
        assert!(hub.consume_ticket(&value, 10).is_some());
        assert!(hub.consume_ticket(&value, 10).is_none());
        let expired = hub
            .issue_ticket(SocketTicket {
                org_id: "org".into(),
                session_id: "ses".into(),
                user_id: "usr".into(),
                expires_at: 20,
            })
            .unwrap();
        assert!(hub.consume_ticket(&expired, 20).is_none());
    }

    #[test]
    fn lease_tokens_are_only_stored_as_digests() {
        assert_ne!(token_hash("secret"), "secret");
        assert_eq!(token_hash("secret"), token_hash("secret"));
    }

    #[test]
    fn shared_chat_rejects_clients_below_the_protocol_floor() {
        let mut headers = HeaderMap::new();
        assert!(matches!(
            require_shared_chat_protocol(&headers),
            Err(ChatFailure::ProtocolUpgrade)
        ));
        headers.insert("x-cognia-collab-protocol", HeaderValue::from_static("1"));
        assert!(matches!(
            require_shared_chat_protocol(&headers),
            Err(ChatFailure::ProtocolUpgrade)
        ));
        headers.insert("x-cognia-collab-protocol", HeaderValue::from_static("2"));
        assert!(require_shared_chat_protocol(&headers).is_ok());
    }

    #[test]
    fn attachment_tickets_are_action_bound_and_single_use() {
        let hub = ChatHub::default();
        let ticket = hub
            .issue_attachment_ticket(AttachmentTicket {
                org_id: "org".into(),
                session_id: "session".into(),
                attachment_id: "attachment".into(),
                user_id: "user".into(),
                action: AttachmentTicketAction::Upload,
                expires_at: 20,
            })
            .unwrap();
        assert!(hub
            .consume_attachment_ticket(&ticket, AttachmentTicketAction::Download, 10)
            .is_none());
        assert!(hub
            .consume_attachment_ticket(&ticket, AttachmentTicketAction::Upload, 10)
            .is_none());
    }

    #[test]
    fn message_ownership_uses_the_stable_author() {
        let event = SessionEvent {
            id: "event".into(),
            session_id: "session".into(),
            sequence: 1,
            kind: "message.created".into(),
            actor_kind: "human".into(),
            actor_id: "importer".into(),
            actor_label: None,
            payload: serde_json::json!({
                "messageId": "message",
                "author": {"kind":"agent", "id":"assistant"}
            }),
            created_at: 1,
            operation_id: "operation".into(),
        };
        assert!(!message_owned_by(&event, "importer"));
        let human = SessionEvent {
            payload: serde_json::json!({
                "messageId": "message",
                "author": {"kind":"human", "id":"author"}
            }),
            ..event
        };
        assert!(message_owned_by(&human, "author"));
        assert!(!message_owned_by(&human, "importer"));
    }

    #[tokio::test]
    async fn redaction_seed_does_not_block_another_sessions_egress() {
        let (state, _) = notification_fixture().await;
        let started = tokio::sync::Notify::new();
        let release = tokio::sync::Notify::new();
        let seed = state.chat_hub.redacted_set(NOTICE_ORG, "pending", async {
            started.notify_one();
            release.notified().await;
            Ok(vec!["hidden".into()])
        });
        tokio::pin!(seed);
        tokio::select! {
            _ = started.notified() => {},
            _ = &mut seed => panic!("seed did not wait"),
        }
        state.chat_hub.prune_idle();
        let event = policy_event("session", ADA, 10);
        let projected = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            state.chat_hub.project_stream_event(
                state.chat_store.as_ref(),
                NOTICE_ORG,
                event.clone(),
            ),
        )
        .await;
        release.notify_one();
        drop(seed.await.unwrap());
        let ids = state
            .chat_hub
            .redacted_set(NOTICE_ORG, "pending", async { Ok(vec!["reseeded".into()]) })
            .await
            .unwrap();
        assert_eq!(*ids, HashSet::from(["hidden".to_owned()]));
        assert_eq!(
            projected
                .expect("another session's seed blocked egress")
                .unwrap(),
            event
        );
    }

    #[tokio::test]
    async fn redaction_prune_evicts_idle_sessions_but_keeps_subscribers_and_pending_seeds() {
        let (state, _) = notification_fixture().await;
        let active = state.chat_hub.sender("active").subscribe();
        for session in ["active", "idle"] {
            drop(
                state
                    .chat_hub
                    .redacted_set(NOTICE_ORG, session, async { Ok(vec!["cached".into()]) })
                    .await
                    .unwrap(),
            );
        }
        let pending = state
            .chat_hub
            .redacted_set(NOTICE_ORG, "pending", async { Ok(vec!["pending".into()]) })
            .await
            .unwrap();
        state.chat_hub.prune_idle();
        drop(pending);
        for (session, expected) in [
            ("active", vec!["cached"]),
            ("idle", vec!["reseeded"]),
            ("pending", vec!["pending"]),
        ] {
            let ids = state
                .chat_hub
                .redacted_set(NOTICE_ORG, session, async { Ok(vec!["reseeded".into()]) })
                .await
                .unwrap();
            assert_eq!(
                *ids,
                expected.into_iter().map(str::to_owned).collect(),
                "{session}"
            );
        }
        drop(active);
        state.chat_hub.prune_idle();
        let ids = state
            .chat_hub
            .redacted_set(NOTICE_ORG, "active", async { Ok(vec!["reseeded".into()]) })
            .await
            .unwrap();
        assert_eq!(*ids, HashSet::from(["reseeded".to_owned()]));
    }

    #[tokio::test]
    async fn redaction_history_reads_the_store_independently_of_the_stream_cache() {
        let (state, grant) = notification_fixture().await;
        assert!(state
            .chat_hub
            .redacted_snapshot(state.chat_store.as_ref(), NOTICE_ORG, "session")
            .await
            .unwrap()
            .is_empty());
        let original = NewSessionEvent {
            tool_detail_revision: None,
            id: "created".into(),
            org_id: NOTICE_ORG.into(),
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            kind: "message.created".into(),
            actor_kind: "human".into(),
            actor_id: ADA.into(),
            actor_label: None,
            payload: serde_json::json!({"messageId":"secret","parts":[{"type":"text","text":"raw"}]}),
            now: 2,
            operation_id: "created".into(),
        };
        state
            .chat_store
            .append_session_event(original.clone())
            .await
            .unwrap();
        let mut redaction = original;
        redaction.id = "redact".into();
        redaction.operation_id = "redact".into();
        redaction.kind = "message.redacted".into();
        redaction.payload = serde_json::json!({"targetMessageId":"secret"});
        state
            .chat_store
            .append_session_event(redaction)
            .await
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", grant(ADA).parse().unwrap());
        headers.insert("x-cognia-collab-protocol", "2".parse().unwrap());
        let Json(events) = list_events(
            State(state),
            Path((NOTICE_ORG.into(), "session".into())),
            headers,
            Query(EventQuery {
                after_sequence: 0,
                limit: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            events[0].payload,
            serde_json::json!({"messageId":"secret","redacted":true})
        );
    }

    #[tokio::test]
    async fn stream_projection_hides_queued_corrections_and_pre_redaction_replays() {
        let (state, grant) = notification_fixture().await;
        let original = state.chat_store.append_session_event(NewSessionEvent {
            tool_detail_revision: None,
id: "created".into(), org_id: NOTICE_ORG.into(), workspace_id: "workspace".into(),
            session_id: "session".into(), kind: "message.created".into(), actor_kind: "agent".into(),
            actor_id: "run:run".into(), actor_label: None,
            payload: serde_json::json!({"messageId":"secret","parts":[{"type":"text","text":"raw original"}]}),
            now: 2, operation_id: "created".into(),
        }).await.unwrap();
        let before = state
            .chat_hub
            .project_stream_event(state.chat_store.as_ref(), NOTICE_ORG, original.clone())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_string(&before).unwrap(),
            serde_json::to_string(&original).unwrap()
        );
        let mut receiver = state.chat_hub.sender("session").subscribe();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", grant(ADA).parse().unwrap());
        headers.insert("x-cognia-collab-protocol", "2".parse().unwrap());
        let _ = append_event(
            State(state.clone()),
            Path((NOTICE_ORG.into(), "session".into())),
            headers.clone(),
            Json(AppendEventBody {
                id: None,
                kind: "message.redacted".into(),
                payload: serde_json::json!({"targetMessageId":"secret"}),
                operation_id: "redact".into(),
                actor_label: None,
            }),
        )
        .await
        .unwrap();
        // Leave the redaction queued: egress must consult the hub, not what this receiver has seen.
        let mut correction = original.clone();
        correction.kind = "message.corrected".into();
        correction.payload = serde_json::json!({"targetMessageId":"secret","parts":[{"type":"text","text":"raw correction"}]});
        state
            .chat_hub
            .sender("session")
            .send(correction.clone())
            .unwrap();
        let projected = state
            .chat_hub
            .project_stream_event(state.chat_store.as_ref(), NOTICE_ORG, correction)
            .await
            .unwrap();
        assert_eq!(
            projected.payload,
            serde_json::json!({"targetMessageId":"secret","redacted":true})
        );
        let replay = state
            .chat_hub
            .project_stream_event(state.chat_store.as_ref(), NOTICE_ORG, original.clone())
            .await
            .unwrap();
        assert_eq!(
            replay.payload,
            serde_json::json!({"messageId":"secret","redacted":true})
        );
        // A fresh hub seeds persisted tombstones, including events queued before redaction.
        let restarted = ChatHub::default()
            .project_stream_event(state.chat_store.as_ref(), NOTICE_ORG, original)
            .await
            .unwrap();
        assert_eq!(restarted.payload, replay.payload);
        let Json(history) = list_events(
            State(state.clone()),
            Path((NOTICE_ORG.into(), "session".into())),
            headers,
            Query(EventQuery {
                after_sequence: 0,
                limit: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(history[0].payload, replay.payload);
        assert_eq!(receiver.try_recv().unwrap().kind, "message.redacted");
    }

    #[tokio::test]
    async fn redacted_correction_routes_return_conflict_for_members_and_runs() {
        use axum::{
            body::{to_bytes, Body},
            http::Request,
        };
        use tower::ServiceExt;
        for run in [false, true] {
            let (state, grant) = notification_fixture().await;
            state
                .chat_store
                .acquire_run_lease(NewChatRunLease {
                    id: "lease".into(),
                    org_id: NOTICE_ORG.into(),
                    workspace_id: "workspace".into(),
                    session_id: "session".into(),
                    run_id: "run".into(),
                    holder_user_id: ADA.into(),
                    holder_device_id: "device".into(),
                    token_hash: token_hash("token"),
                    token_expires_at: 100,
                    heartbeat_expires_at: 100,
                    now: 2,
                    operation_id: "lease".into(),
                })
                .await
                .unwrap();
            state
                .chat_store
                .append_session_event(NewSessionEvent {
                    tool_detail_revision: None,
                    id: "created".into(),
                    org_id: NOTICE_ORG.into(),
                    workspace_id: "workspace".into(),
                    session_id: "session".into(),
                    kind: "message.created".into(),
                    actor_kind: if run { "agent" } else { "human" }.into(),
                    actor_id: if run { "run:run" } else { ADA }.into(),
                    actor_label: None,
                    payload: serde_json::json!({"messageId":"secret","parts":[]}),
                    now: 3,
                    operation_id: "created".into(),
                })
                .await
                .unwrap();
            let app = routes().with_state(state.clone());
            let request = |suffix: &str, kind: &str, operation: &str| {
                Request::builder().method("POST")
                .uri(format!("/v1/orgs/{NOTICE_ORG}/chat-sessions/session/{suffix}"))
                .header("authorization", grant(ADA)).header("x-cognia-collab-protocol", "2")
                .header("x-cognia-run-token", "token").header("content-type", "application/json")
                .body(Body::from(serde_json::json!({"kind":kind,"operationId":operation,"payload":{"targetMessageId":"secret","parts":[{"type":"text","text":"raw"}]}}).to_string())).unwrap()
            };
            assert_eq!(
                app.clone()
                    .oneshot(request("events", "message.redacted", "redact"))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::CREATED
            );
            assert!(state.chat_hub.redacted.lock().is_empty());
            assert!(state.chat_hub.channels.is_empty());
            let response = app
                .oneshot(request(
                    if run { "runs/run/events" } else { "events" },
                    "message.corrected",
                    "correct",
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT, "run={run}");
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(body["authoritative"]["reason"], "message_redacted");
            assert_eq!(
                state
                    .chat_store
                    .list_session_events(NOTICE_ORG, "session", 0, 100)
                    .await
                    .unwrap()
                    .len(),
                2
            );
        }
    }

    async fn live_fixture() -> (AppState, impl Fn(&str) -> String) {
        let (state, grant) = notification_fixture().await;
        state
            .chat_store
            .acquire_run_lease(NewChatRunLease {
                id: "lease".into(),
                org_id: NOTICE_ORG.into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                run_id: "run".into(),
                holder_user_id: ADA.into(),
                holder_device_id: "device".into(),
                token_hash: token_hash("token"),
                token_expires_at: 100,
                heartbeat_expires_at: 100,
                now: 2,
                operation_id: "lease".into(),
            })
            .await
            .unwrap();
        state
            .chat_store
            .append_session_event(NewSessionEvent {
                tool_detail_revision: None,
                id: "created".into(),
                org_id: NOTICE_ORG.into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                kind: "message.created".into(),
                actor_kind: "agent".into(),
                actor_id: "run:run".into(),
                actor_label: None,
                payload: serde_json::json!({"messageId":"reply","parts":[]}),
                now: 3,
                operation_id: "created".into(),
            })
            .await
            .unwrap();
        (state, grant)
    }

    fn live_frame() -> serde_json::Value {
        serde_json::json!({"sessionId":"session","messageId":"reply","replyTo":"question",
            "seq":1,"base":0,"keyframe":true,"state":"streaming","parts":[]})
    }

    async fn live_request(
        state: &AppState,
        frame: serde_json::Value,
        revision: u64,
        token: Option<&str>,
    ) -> Response {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let mut request = Request::builder()
            .method("POST")
            .uri(format!(
                "/v1/orgs/{NOTICE_ORG}/chat-sessions/session/runs/run/live"
            ))
            .header("x-cognia-collab-protocol", "2")
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("x-cognia-run-token", token);
        }
        routes()
            .with_state(state.clone())
            .oneshot(
                request
                    .body(Body::from(
                        serde_json::json!({"frame":frame,"toolDetailRevision":revision})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn live_route_broadcasts_without_persisting() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let (state, _) = live_fixture().await;
        let mut live = state
            .chat_hub
            .live_channels
            .subscribe(&"session".to_owned());
        let app = routes().with_state(state.clone());
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/v1/orgs/{NOTICE_ORG}/chat-sessions/session/runs/run/live"
                    ))
                    .header("x-cognia-collab-protocol", "2")
                    .header("x-cognia-run-token", "token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({"frame":{
                "sessionId":"session","messageId":"reply","replyTo":"question",
                "seq":1,"base":0,"keyframe":true,"state":"streaming","parts":[]
            },"toolDetailRevision":0})
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(live.try_recv().unwrap(), live_frame());
        assert_eq!(
            state
                .chat_store
                .list_session_events(NOTICE_ORG, "session", 0, 100)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn transcript_live_frame_v1_contract() {
        let contract: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol/transcript-live-frame-v1.json"
        ))
        .unwrap();
        assert_eq!(contract["maxIdLength"], TRANSCRIPT_LIVE_MAX_ID);
        assert_eq!(contract["maxFrameBytes"], TRANSCRIPT_LIVE_MAX_BYTES);
        for (index, frame) in contract["valid"].as_array().unwrap().iter().enumerate() {
            assert!(is_live_frame(frame), "rejected valid frame {index}");
        }
        for case in contract["invalid"].as_array().unwrap() {
            assert!(!is_live_frame(&case["frame"]), "accepted {}", case["why"]);
        }
    }

    #[test]
    fn live_shape_matches_the_codec_constraints() {
        assert!(is_live_frame(&live_frame()));
        for (key, value) in [
            ("sessionId", serde_json::json!("")),
            ("messageId", serde_json::json!("a".repeat(257))),
            ("replyTo", serde_json::json!(null)),
            ("seq", serde_json::json!(0)),
            ("seq", serde_json::json!(1.5)),
            ("base", serde_json::json!(-1)),
            ("seq", serde_json::json!(9_007_199_254_740_992_u64)),
            ("keyframe", serde_json::json!("yes")),
            ("base", serde_json::json!(1)),
            ("state", serde_json::json!("other")),
            ("parts", serde_json::json!([[]])),
            ("parts", serde_json::json!([null])),
            ("afterRevision", serde_json::json!(0)),
        ] {
            let mut frame = live_frame();
            frame[key] = value;
            assert!(!is_live_frame(&frame), "{frame}");
        }
        let mut frame = live_frame();
        frame["state"] = serde_json::json!("settled");
        frame["afterRevision"] = serde_json::json!(0);
        assert!(is_live_frame(&frame));
        frame["keyframe"] = serde_json::json!(false);
        assert!(!is_live_frame(&frame));
        frame["keyframe"] = serde_json::json!(true);
        frame["afterRevision"] = serde_json::json!(-1);
        assert!(!is_live_frame(&frame));
        frame = live_frame();
        frame["state"] = serde_json::json!("reset");
        assert!(is_live_frame(&frame));
        frame["parts"] = serde_json::json!([{}]);
        assert!(!is_live_frame(&frame));
    }

    #[tokio::test]
    async fn live_route_refuses_bad_identity_shape_target_and_redaction() {
        use axum::body::to_bytes;
        let (mut state, _) = live_fixture().await;
        for token in [None, Some("wrong")] {
            assert!(live_request(&state, live_frame(), 0, token)
                .await
                .status()
                .is_client_error());
        }
        for (key, value, expected) in [
            (
                "sessionId",
                serde_json::json!("foreign"),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                "seq",
                serde_json::json!(0),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                "messageId",
                serde_json::json!("unknown"),
                StatusCode::NOT_FOUND,
            ),
            (
                "parts",
                serde_json::json!([{"text":"a".repeat(MAX_LIVE_BODY_BYTES)}]),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            let mut frame = live_frame();
            frame[key] = value;
            assert_eq!(
                live_request(&state, frame, 0, Some("token")).await.status(),
                expected
            );
        }
        let mut foreign = state
            .chat_store
            .get_message_event(NOTICE_ORG, "session", "reply")
            .await
            .unwrap();
        foreign.id = "foreign".into();
        foreign.operation_id = "foreign".into();
        foreign.actor_id = "run:other".into();
        foreign.payload["messageId"] = serde_json::json!("foreign");
        state
            .chat_store
            .append_session_event(NewSessionEvent {
                tool_detail_revision: None,
                id: foreign.id,
                org_id: NOTICE_ORG.into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                kind: foreign.kind,
                actor_kind: foreign.actor_kind,
                actor_id: foreign.actor_id,
                actor_label: None,
                payload: foreign.payload,
                now: 4,
                operation_id: foreign.operation_id,
            })
            .await
            .unwrap();
        let mut frame = live_frame();
        frame["messageId"] = serde_json::json!("foreign");
        assert_eq!(
            live_request(&state, frame, 0, Some("token")).await.status(),
            StatusCode::FORBIDDEN
        );
        state.now = Arc::new(|| 101);
        assert!(live_request(&state, live_frame(), 0, Some("token"))
            .await
            .status()
            .is_client_error());
        state.now = Arc::new(|| 10);
        state
            .chat_store
            .append_session_event(NewSessionEvent {
                tool_detail_revision: None,
                id: "redact".into(),
                org_id: NOTICE_ORG.into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                kind: "message.redacted".into(),
                actor_kind: "human".into(),
                actor_id: ADA.into(),
                actor_label: None,
                payload: serde_json::json!({"targetMessageId":"reply"}),
                now: 5,
                operation_id: "redact".into(),
            })
            .await
            .unwrap();
        let response = live_request(&state, live_frame(), 0, Some("token")).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(
            body,
            serde_json::json!({"error":"conflict","authoritative":{"reason":"message_redacted"}})
        );
    }

    #[tokio::test]
    async fn tool_detail_patch_is_revisioned_authorized_and_broadcast() {
        use axum::{
            body::{to_bytes, Body},
            http::Request,
        };
        use tower::ServiceExt;
        let (state, grant) = live_fixture().await;
        state
            .chat_store
            .put_member(
                NOTICE_ORG,
                "session",
                "workspace",
                BOB,
                SessionRole::Member,
                false,
                false,
                ADA,
                4,
            )
            .await
            .unwrap();
        let initial = state
            .chat_store
            .admin_session(NOTICE_ORG, "session")
            .await
            .unwrap();
        assert_eq!(initial.tool_detail, crate::chat::ToolDetail::Summary);
        assert_eq!(initial.tool_detail_revision, 0);
        let mut events = state.chat_hub.channels.subscribe(&"session".to_owned());
        let app = routes().with_state(state.clone());
        let request = |user: &str, detail: &str, operation: &str, revision: i64| {
            Request::builder().method("PATCH")
            .uri(format!("/v1/orgs/{NOTICE_ORG}/chat-sessions/session"))
            .header("authorization",grant(user)).header("x-cognia-collab-protocol","2").header("content-type","application/json")
            .body(Body::from(serde_json::json!({"toolDetail":detail,"operationId":operation,"baseRevision":revision}).to_string())).unwrap()
        };
        assert_eq!(
            app.clone()
                .oneshot(request(BOB, "full", "refused", initial.revision))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let response = app
            .clone()
            .oneshot(request(ADA, "full", "full", initial.revision))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let full: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(full["toolDetail"], "full");
        assert_eq!(full["toolDetailRevision"], 1);
        assert_eq!(full["policyRevision"], initial.policy_revision + 1);
        assert_eq!(events.try_recv().unwrap().kind, "member.updated");
        let response = live_request(&state, live_frame(), 0, Some("token")).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let stale: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(
            stale,
            serde_json::json!({"error":"conflict","authoritative":{"reason":"tool_detail_stale","toolDetail":"full","toolDetailRevision":1}})
        );
        assert_eq!(
            live_request(&state, live_frame(), 1, Some("token"))
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        let unchanged = app
            .clone()
            .oneshot(request(
                ADA,
                "full",
                "same",
                full["revision"].as_i64().unwrap(),
            ))
            .await
            .unwrap();
        assert_eq!(unchanged.status(), StatusCode::OK);
        assert!(events.try_recv().is_err());
        let unchanged: serde_json::Value =
            serde_json::from_slice(&to_bytes(unchanged.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(unchanged, full);
        // A maintainer can downgrade, and a cached run-message id still cannot bypass the revision.
        state
            .store
            .set_workspace_member(
                NOTICE_ORG,
                "workspace",
                BOB,
                WorkspaceRole::Maintainer,
                revocation_context(),
            )
            .await
            .unwrap();
        state
            .chat_store
            .put_member(
                NOTICE_ORG,
                "session",
                "workspace",
                BOB,
                SessionRole::Maintainer,
                false,
                false,
                ADA,
                6,
            )
            .await
            .unwrap();
        assert_eq!(
            app.oneshot(request(
                BOB,
                "summary",
                "summary",
                full["revision"].as_i64().unwrap()
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            state
                .chat_store
                .admin_session(NOTICE_ORG, "session")
                .await
                .unwrap()
                .tool_detail_revision,
            2
        );
    }

    #[tokio::test]
    async fn run_event_http_revision_and_cached_live_message_cannot_bypass_a_downgrade() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let (state, _) = live_fixture().await;
        let app = routes().with_state(state.clone());
        let append = |kind: &str, id: &str, revision: Option<u64>| {
            let mut body = serde_json::json!({"kind":kind,"operationId":id,"payload":{"messageId":"second","targetMessageId":"second","parts":[]}});
            if let Some(revision) = revision {
                body["toolDetailRevision"] = serde_json::json!(revision);
            }
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/v1/orgs/{NOTICE_ORG}/chat-sessions/session/runs/run/events"
                ))
                .header("x-cognia-collab-protocol", "2")
                .header("x-cognia-run-token", "token")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        assert_eq!(
            app.clone()
                .oneshot(append("message.created", "second", Some(0)))
                .await
                .unwrap()
                .status(),
            StatusCode::CREATED
        );
        assert_eq!(state.chat_hub.run_messages.lock().len(), 1);
        let initial = state
            .chat_store
            .admin_session(NOTICE_ORG, "session")
            .await
            .unwrap();
        let full = state
            .chat_store
            .patch_session(
                NOTICE_ORG,
                "session",
                None,
                None,
                Some((crate::chat::ToolDetail::Full, ADA)),
                "full",
                initial.revision,
                6,
            )
            .await
            .unwrap();
        state
            .chat_store
            .patch_session(
                NOTICE_ORG,
                "session",
                None,
                None,
                Some((crate::chat::ToolDetail::Summary, ADA)),
                "summary",
                full.revision,
                7,
            )
            .await
            .unwrap();
        assert_eq!(
            app.clone()
                .oneshot(append("message.corrected", "stale", Some(1)))
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            app.clone()
                .oneshot(append("message.corrected", "old-executor", None))
                .await
                .unwrap()
                .status(),
            StatusCode::CREATED
        );
        let mut frame = live_frame();
        frame["messageId"] = serde_json::json!("second");
        assert_eq!(
            live_request(&state, frame.clone(), 1, Some("token"))
                .await
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            live_request(&state, frame, 2, Some("token")).await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            app.oneshot(append("run.completed", "terminal", None))
                .await
                .unwrap()
                .status(),
            StatusCode::CREATED
        );
        assert!(state.chat_hub.run_messages.lock().is_empty());
    }

    struct SocketServer(tokio::task::JoinHandle<()>);
    impl Drop for SocketServer {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    type TestSocket = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    async fn open_live_socket(state: &AppState, v2: bool) -> (TestSocket, SocketServer) {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let ticket = state
            .chat_hub
            .issue_ticket(SocketTicket {
                org_id: NOTICE_ORG.into(),
                session_id: "session".into(),
                user_id: ADA.into(),
                expires_at: 30_010,
            })
            .unwrap();
        let app = routes().with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = SocketServer(tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap()
        }));
        let mut request =
            format!("ws://{address}/v1/orgs/{NOTICE_ORG}/chat-sessions/session/stream")
                .into_client_request()
                .unwrap();
        request.headers_mut().insert(
            "sec-websocket-protocol",
            format!(
                "cognia.chat.v1, {}, {ticket}",
                if v2 { "cognia.chat.v2" } else { "unused" }
            )
            .parse()
            .unwrap(),
        );
        let (socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
        assert_eq!(
            response.headers()["sec-websocket-protocol"],
            if v2 {
                "cognia.chat.v2"
            } else {
                "cognia.chat.v1"
            }
        );
        (socket, server)
    }

    async fn socket_json(socket: &mut TestSocket) -> serde_json::Value {
        use futures_util::StreamExt;
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str(frame.to_text().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn v1_stays_raw_and_v2_negotiates_both_envelope_kinds() {
        use futures_util::StreamExt;
        let (state, _) = live_fixture().await;
        let (mut v1, _server1) = open_live_socket(&state, false).await;
        let (mut v2, _server2) = open_live_socket(&state, true).await;
        assert_eq!(
            live_request(&state, live_frame(), 0, Some("token"))
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            socket_json(&mut v2).await,
            serde_json::json!({"type":"live","frame":live_frame()})
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), v1.next())
                .await
                .is_err()
        );
        let event = policy_event("session", ADA, 10);
        state
            .chat_hub
            .sender("session")
            .send(event.clone())
            .unwrap();
        assert_eq!(
            socket_json(&mut v1).await,
            serde_json::to_value(&event).unwrap()
        );
        assert_eq!(
            socket_json(&mut v2).await,
            serde_json::json!({"type":"event","event":event})
        );
    }

    struct LoopSocket {
        incoming: tokio::sync::mpsc::UnboundedReceiver<Result<Message, axum::Error>>,
        outgoing: tokio::sync::mpsc::UnboundedSender<Message>,
    }
    impl futures_util::Stream for LoopSocket {
        type Item = Result<Message, axum::Error>;
        fn poll_next(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            self.incoming.poll_recv(cx)
        }
    }
    impl futures_util::Sink<Message> for LoopSocket {
        type Error = axum::Error;
        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn start_send(self: std::pin::Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
            self.outgoing.send(message).map_err(axum::Error::new)
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }
    struct LoopClient {
        _incoming: tokio::sync::mpsc::UnboundedSender<Result<Message, axum::Error>>,
        outgoing: tokio::sync::mpsc::UnboundedReceiver<Message>,
    }

    // A peer that never accepts a send, but can still be closed by the server.
    struct StalledSocket {
        sending: Arc<tokio::sync::Notify>,
        closed: Arc<std::sync::atomic::AtomicBool>,
    }
    impl futures_util::Stream for StalledSocket {
        type Item = Result<Message, axum::Error>;
        fn poll_next(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            std::task::Poll::Pending
        }
    }
    impl futures_util::Sink<Message> for StalledSocket {
        type Error = axum::Error;
        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            self.sending.notify_one();
            std::task::Poll::Pending
        }
        fn start_send(self: std::pin::Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
            panic!("a stalled sink is never ready")
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Pending
        }
        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
            std::task::Poll::Ready(Ok(()))
        }
    }

    async fn stalled_send_does_not_block_session_and_closes(live: bool) {
        let (state, _) = live_fixture().await;
        let sending = Arc::new(tokio::sync::Notify::new());
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let socket = StalledSocket {
            sending: sending.clone(),
            closed: closed.clone(),
        };
        let events = state.chat_hub.channels.subscribe(&"session".to_owned());
        let frames = live.then(|| {
            state
                .chat_hub
                .live_channels
                .subscribe(&"session".to_owned())
        });
        let mut stalled = SocketServer(tokio::spawn(stream_loop_with_live(
            socket,
            state.clone(),
            SocketTicket {
                org_id: NOTICE_ORG.into(),
                session_id: "session".into(),
                user_id: ADA.into(),
                expires_at: 30_010,
            },
            events,
            frames,
        )));
        let event = state
            .chat_store
            .list_session_events(NOTICE_ORG, "session", 0, 100)
            .await
            .unwrap()
            .remove(0);
        if live {
            state
                .chat_hub
                .live_channels
                .publish(&"session".to_owned(), live_frame());
        } else {
            state
                .chat_hub
                .sender("session")
                .send(event.clone())
                .unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(1), sending.notified())
            .await
            .expect("stalled socket must start sending");

        // All three operations must finish while the first send is still pending.
        let (mut healthy, start, _server) = gated_loop_socket(&state, true);
        start.notify_one();
        state
            .chat_hub
            .live_channels
            .publish(&"session".to_owned(), live_frame());
        assert_eq!(loop_json(&mut healthy).await["type"], "live");
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            state.chat_hub.project_stream_event(
                state.chat_store.as_ref(),
                NOTICE_ORG,
                event.clone(),
            ),
        )
        .await
        .expect("stalled send must not block stored projection")
        .unwrap();
        let redaction = state
            .chat_store
            .append_session_event(NewSessionEvent {
                tool_detail_revision: None,
                id: "redact".into(),
                org_id: NOTICE_ORG.into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                kind: "message.redacted".into(),
                actor_kind: "human".into(),
                actor_id: ADA.into(),
                actor_label: None,
                payload: serde_json::json!({"targetMessageId":"reply"}),
                now: 5,
                operation_id: "redact".into(),
            })
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            state
                .chat_hub
                .broadcast_event(state.chat_store.as_ref(), NOTICE_ORG, redaction),
        )
        .await
        .expect("stalled send must not block redaction broadcast")
        .unwrap();
        assert_eq!(
            loop_json(&mut healthy).await["event"]["kind"],
            "message.redacted"
        );
        let projected = state
            .chat_hub
            .project_stream_event(state.chat_store.as_ref(), NOTICE_ORG, event)
            .await
            .unwrap();
        assert_eq!(
            projected.payload,
            serde_json::json!({"messageId":"reply","redacted":true})
        );
        assert!(
            !stalled.0.is_finished(),
            "other sockets must progress before the timeout"
        );
        tokio::time::timeout(std::time::Duration::from_secs(6), &mut stalled.0)
            .await
            .expect("stalled socket must time out")
            .unwrap();
        assert!(
            closed.load(std::sync::atomic::Ordering::SeqCst),
            "timed-out socket must close"
        );
    }

    #[tokio::test]
    async fn stalled_live_send_does_not_block_session_and_closes() {
        stalled_send_does_not_block_session_and_closes(true).await;
    }

    #[tokio::test]
    async fn stalled_event_send_does_not_block_session_and_closes() {
        stalled_send_does_not_block_session_and_closes(false).await;
    }

    async fn loop_json(client: &mut LoopClient) -> serde_json::Value {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), client.outgoing.recv())
            .await
            .unwrap()
            .unwrap();
        match frame {
            Message::Text(text) => serde_json::from_str(&text).unwrap(),
            other => panic!("expected text, got {other:?}"),
        }
    }
    fn gated_loop_socket(
        state: &AppState,
        v2: bool,
    ) -> (LoopClient, Arc<tokio::sync::Notify>, SocketServer) {
        let (input_tx, input_rx) = tokio::sync::mpsc::unbounded_channel();
        let (output_tx, output_rx) = tokio::sync::mpsc::unbounded_channel();
        let start = Arc::new(tokio::sync::Notify::new());
        let gate = start.clone();
        let state = state.clone();
        let events = state.chat_hub.channels.subscribe(&"session".to_owned());
        let live = v2.then(|| {
            state
                .chat_hub
                .live_channels
                .subscribe(&"session".to_owned())
        });
        let task = SocketServer(tokio::spawn(async move {
            gate.notified().await;
            stream_loop_with_live(
                LoopSocket {
                    incoming: input_rx,
                    outgoing: output_tx,
                },
                state,
                SocketTicket {
                    org_id: NOTICE_ORG.into(),
                    session_id: "session".into(),
                    user_id: ADA.into(),
                    expires_at: 30_010,
                },
                events,
                live,
            )
            .await;
        }));
        (
            LoopClient {
                _incoming: input_tx,
                outgoing: output_rx,
            },
            start,
            task,
        )
    }

    #[tokio::test]
    async fn v1_loop_stays_raw_and_v2_loop_sends_both_envelope_kinds() {
        let (state, _) = live_fixture().await;
        let (mut v1, start1, _task1) = gated_loop_socket(&state, false);
        let (mut v2, start2, _task2) = gated_loop_socket(&state, true);
        start1.notify_one();
        start2.notify_one();
        state
            .chat_hub
            .live_channels
            .publish(&"session".to_owned(), live_frame());
        assert_eq!(
            loop_json(&mut v2).await,
            serde_json::json!({"type":"live","frame":live_frame()})
        );
        let event = policy_event("session", ADA, 10);
        state
            .chat_hub
            .sender("session")
            .send(event.clone())
            .unwrap();
        assert_eq!(
            loop_json(&mut v1).await,
            serde_json::to_value(&event).unwrap()
        );
        assert_eq!(
            loop_json(&mut v2).await,
            serde_json::json!({"type":"event","event":event})
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), v1.outgoing.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn queued_live_is_dropped_before_the_socket_consumes_redaction() {
        let (state, _) = live_fixture().await;
        let (mut socket, start, _server) = gated_loop_socket(&state, true);
        assert!(state
            .chat_hub
            .redacted_snapshot(state.chat_store.as_ref(), NOTICE_ORG, "session")
            .await
            .unwrap()
            .is_empty());
        state
            .chat_hub
            .live_channels
            .publish(&"session".to_owned(), live_frame());
        let redaction = state
            .chat_store
            .append_session_event(NewSessionEvent {
                tool_detail_revision: None,
                id: "redact".into(),
                org_id: NOTICE_ORG.into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                kind: "message.redacted".into(),
                actor_kind: "human".into(),
                actor_id: ADA.into(),
                actor_label: None,
                payload: serde_json::json!({"targetMessageId":"reply"}),
                now: 5,
                operation_id: "redact".into(),
            })
            .await
            .unwrap();
        state
            .chat_hub
            .broadcast_event(state.chat_store.as_ref(), NOTICE_ORG, redaction.clone())
            .await
            .unwrap();
        start.notify_one();
        assert_eq!(
            loop_json(&mut socket).await,
            serde_json::json!({"type":"event","event":project_redacted_event(redaction, &HashSet::from(["reply".to_owned()]))})
        );
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(100),
            socket.outgoing.recv()
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn lagged_live_skips_frames_and_keeps_the_event_stream() {
        let (state, _) = live_fixture().await;
        let (mut socket, start, _server) = gated_loop_socket(&state, true);
        for seq in 1..=100 {
            let mut frame = live_frame();
            frame["seq"] = serde_json::json!(seq);
            state
                .chat_hub
                .live_channels
                .publish(&"session".to_owned(), frame);
        }
        let event = policy_event("session", ADA, 10);
        state
            .chat_hub
            .sender("session")
            .send(event.clone())
            .unwrap();
        start.notify_one();
        let mut saw_event = false;
        let mut saw_latest = false;
        for _ in 0..=32 {
            let value = loop_json(&mut socket).await;
            if value["type"] == "event" {
                assert_eq!(value["event"], serde_json::to_value(&event).unwrap());
                saw_event = true;
            }
            if value["type"] == "live" && value["frame"]["seq"] == 100 {
                saw_latest = true;
            }
            if saw_event && saw_latest {
                break;
            }
        }
        assert!(saw_event && saw_latest);
        state
            .chat_hub
            .sender("session")
            .send(event.clone())
            .unwrap();
        assert_eq!(
            loop_json(&mut socket).await,
            serde_json::json!({"type":"event","event":event})
        );
    }

    #[tokio::test]
    async fn revoked_live_member_is_rechecked_within_one_second_and_on_policy_events() {
        for notice in [false, true] {
            let (state, _) = live_fixture().await;
            let (mut socket, start, _server) = gated_loop_socket(&state, true);
            start.notify_one();
            state
                .chat_hub
                .live_channels
                .publish(&"session".to_owned(), live_frame());
            assert_eq!(loop_json(&mut socket).await["type"], "live");
            state
                .store
                .remove_workspace_member(NOTICE_ORG, "workspace", ADA, revocation_context())
                .await
                .unwrap();
            if notice {
                state
                    .chat_hub
                    .sender("session")
                    .send(policy_event("session", ADA, 11))
                    .unwrap();
            }
            let timeout = if notice {
                std::time::Duration::from_millis(100)
            } else {
                std::time::Duration::from_millis(1100)
            };
            let received = tokio::time::timeout(timeout, socket.outgoing.recv())
                .await
                .expect("revoked socket must close within its standing refresh");
            assert!(received.is_none() || matches!(received, Some(Message::Close(_))));
        }
    }

    #[test]
    fn ordinary_event_projection_removes_redacted_content() {
        let events = vec![
            SessionEvent {
                id: "created".into(),
                session_id: "session".into(),
                sequence: 1,
                kind: "message.created".into(),
                actor_kind: "human".into(),
                actor_id: "author".into(),
                actor_label: None,
                payload: serde_json::json!({
                    "messageId":"secret",
                    "content":"must not escape",
                    "author":{"kind":"human","id":"author"}
                }),
                created_at: 1,
                operation_id: "create".into(),
            },
            SessionEvent {
                id: "correction".into(),
                session_id: "session".into(),
                sequence: 2,
                kind: "message.corrected".into(),
                actor_kind: "human".into(),
                actor_id: "author".into(),
                actor_label: None,
                payload: serde_json::json!({
                    "targetMessageId":"secret",
                    "content":"corrected secret"
                }),
                created_at: 2,
                operation_id: "correct".into(),
            },
        ];
        let projected = project_redacted_events(events, &HashSet::from(["secret".to_owned()]));

        assert_eq!(
            projected[0].payload,
            serde_json::json!({"messageId":"secret","redacted":true})
        );
        assert_eq!(
            projected[1].payload,
            serde_json::json!({"targetMessageId":"secret","redacted":true})
        );
    }
}
