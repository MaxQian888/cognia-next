use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::{authorize_workspace, verify_grant};
use crate::chat::{
    authorize_session_action, SessionAction, SessionEvent, SessionRole, SessionStatus,
};
use crate::chat_store::{
    ChatAttachment, ChatSessionInvite, NewBreakGlassGrant, NewChatApprovalRequest,
    NewChatAttachment, NewChatRunLease, NewChatRunQueueItem, NewChatSessionInvite, NewSessionEvent,
    NewSharedSession,
};
use crate::store::{AuthorizationAuditEvent, StoreError};
use cognia_tenant_auth::{OrgRole, WorkspaceCapability, WorkspaceRole};

const SOCKET_TICKET_TTL_MS: i64 = 30_000;
const LEASE_TOKEN_TTL_MS: i64 = 5 * 60_000;
const LEASE_HEARTBEAT_TTL_MS: i64 = 90_000;
const ATTACHMENT_TICKET_TTL_MS: i64 = 60_000;
const MAX_ATTACHMENT_BYTES: i64 = 52_428_800;
const SHARED_CHAT_PROTOCOL_VERSION: u32 = 2;

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

#[derive(Default)]
pub struct ChatHub {
    senders: RwLock<HashMap<String, broadcast::Sender<SessionEvent>>>,
    tickets: RwLock<HashMap<String, SocketTicket>>,
    attachment_tickets: RwLock<HashMap<String, AttachmentTicket>>,
}

impl ChatHub {
    fn sender(&self, session_id: &str) -> broadcast::Sender<SessionEvent> {
        if let Some(sender) = self.senders.read().get(session_id) {
            return sender.clone();
        }
        let mut senders = self.senders.write();
        senders
            .entry(session_id.to_owned())
            .or_insert_with(|| broadcast::channel(256).0)
            .clone()
    }

    fn issue_ticket(&self, ticket: SocketTicket) -> String {
        let value = format!("st_{}", Uuid::new_v4().simple());
        self.tickets.write().insert(value.clone(), ticket);
        value
    }

    fn consume_ticket(&self, value: &str, now: i64) -> Option<SocketTicket> {
        self.tickets
            .write()
            .remove(value)
            .filter(|ticket| ticket.expires_at > now)
    }

    fn issue_attachment_ticket(&self, ticket: AttachmentTicket) -> String {
        let value = format!("att_{}", Uuid::new_v4().simple());
        self.attachment_tickets
            .write()
            .insert(value.clone(), ticket);
        value
    }

    fn consume_attachment_ticket(
        &self,
        value: &str,
        action: AttachmentTicketAction,
        now: i64,
    ) -> Option<AttachmentTicket> {
        self.attachment_tickets
            .write()
            .remove(value)
            .filter(|ticket| ticket.expires_at > now && ticket.action == action)
    }

    fn revoke_user_tickets(&self, session_id: &str, user_id: &str) {
        self.tickets
            .write()
            .retain(|_, ticket| ticket.session_id != session_id || ticket.user_id != user_id);
        self.attachment_tickets
            .write()
            .retain(|_, ticket| ticket.session_id != session_id || ticket.user_id != user_id);
    }

    fn revoke_session_tickets(&self, session_id: &str) {
        self.tickets
            .write()
            .retain(|_, ticket| ticket.session_id != session_id);
        self.attachment_tickets
            .write()
            .retain(|_, ticket| ticket.session_id != session_id);
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
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/queue/{item_id}",
            delete(cancel_run_queue_item),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/steer",
            post(steer_run),
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
enum ChatFailure {
    Unauthorized,
    ProtocolUpgrade,
    Forbidden,
    Hidden,
    Gone,
    BadRequest(String),
    ObjectStore,
    Store(StoreError),
}

impl IntoResponse for ChatFailure {
    fn into_response(self) -> Response {
        let (status, body) = match self {
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
        (status, Json(body)).into_response()
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
}

fn require_shared_chat_protocol(headers: &HeaderMap) -> Result<(), ChatFailure> {
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

async fn claims(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
) -> Result<cognia_tenant_auth::grant::GrantClaims, ChatFailure> {
    require_shared_chat_protocol(headers)?;
    verify_grant(&state.signer, bearer(headers), org_id)
        .await
        .map_err(|_| ChatFailure::Unauthorized)
}

async fn visible(
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
struct PatchSessionBody {
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
    visible(
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
    Ok(Json(
        state
            .chat_store
            .patch_session(
                &org_id,
                &session_id,
                body.title.as_deref().map(str::trim),
                body.status,
                &body.operation_id,
                body.base_revision,
                (state.now)(),
            )
            .await
            .map_err(ChatFailure::Store)?,
    ))
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
    let allowed = matches!(standing.org_role, Some(OrgRole::Owner | OrgRole::Admin))
        || match standing.workspace_role {
            Some(WorkspaceRole::Maintainer) => true,
            Some(WorkspaceRole::Member) => {
                matches!(role, SessionRole::Viewer | SessionRole::Member)
            }
            Some(WorkspaceRole::Viewer) => role == SessionRole::Viewer,
            None => false,
        };
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
    if body.role == SessionRole::Owner && actor.role != SessionRole::Owner {
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
    if (body.role == SessionRole::Owner || existing.role == SessionRole::Owner)
        && actor.role != SessionRole::Owner
    {
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
async fn remove_member(
    State(state): State<AppState>,
    Path((org_id, session_id, user_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ChatFailure> {
    let (_, actor) = visible(
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
    if existing.role == SessionRole::Owner && actor.role != SessionRole::Owner {
        return Err(ChatFailure::Forbidden);
    }
    state
        .chat_store
        .remove_member(&org_id, &session_id, &user_id, (state.now)())
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
        .map(|mut event| {
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
        })
        .collect()
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

async fn append_event(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<AppendEventBody>,
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
            id: body
                .id
                .unwrap_or_else(|| format!("evt_{}", Uuid::new_v4().simple())),
            org_id,
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
    let _ = state.chat_hub.sender(&session_id).send(event.clone());
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
    });
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
    state.chat_metrics.stream_connected();
    let sender = state.chat_hub.sender(&session_id);
    Ok(ws
        .protocols(["cognia.chat.v1"])
        .on_upgrade(move |socket| stream_loop(socket, state, ticket, sender.subscribe()))
        .into_response())
}
async fn stream_loop(
    mut socket: WebSocket,
    state: AppState,
    ticket: SocketTicket,
    mut receiver: broadcast::Receiver<SessionEvent>,
) {
    while let Ok(event) = receiver.recv().await {
        if state
            .chat_store
            .visible_session(&ticket.org_id, &ticket.session_id, &ticket.user_id)
            .await
            .ok()
            .flatten()
            .is_none()
        {
            let _ = socket.send(Message::Close(None)).await;
            break;
        }
        let Ok(text) = serde_json::to_string(&event) else {
            continue;
        };
        if socket.send(Message::Text(text.into())).await.is_err() {
            break;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcquireLeaseBody {
    run_id: String,
    device_id: String,
    operation_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseResponse {
    lease: crate::chat_store::ChatRunLease,
    token: String,
}
fn token_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
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
    let now = (state.now)();
    let token = format!("rlt_{}", Uuid::new_v4().simple());
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
            .release_run_lease(&org_id, &lease_id, &member.user_id, (state.now)(), &status)
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
    if state
        .chat_store
        .active_run_lease(&org_id, &session_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?
        .is_none()
    {
        return Err(ChatFailure::Store(StoreError::Conflict(
            serde_json::json!({"reason":"no_active_run"}),
        )));
    }
    let item = state
        .chat_store
        .enqueue_run_input(NewChatRunQueueItem {
            id: format!("queue_{}", Uuid::new_v4().simple()),
            org_id: org_id.clone(),
            workspace_id: session.workspace_id.clone(),
            session_id: session_id.clone(),
            requested_by_user_id: member.user_id.clone(),
            payload: body.payload,
            now: (state.now)(),
            operation_id: body.operation_id.clone(),
        })
        .await
        .map_err(ChatFailure::Store)?;
    let event = state
        .chat_store
        .append_session_event(NewSessionEvent {
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
struct AppendRunEventBody {
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
        "message.created" | "run.started" | "run.paused" | "run.completed" | "run.failed"
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
    let (session, _) = state
        .chat_store
        .visible_session(&org_id, &session_id, &lease.holder_user_id)
        .await
        .map_err(ChatFailure::Store)?
        .ok_or(ChatFailure::Hidden)?;
    let event = state
        .chat_store
        .append_session_event(NewSessionEvent {
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
        })
        .await
        .map_err(ChatFailure::Store)?;
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
            id: format!("evt_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: session.workspace_id,
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
    Ok((StatusCode::CREATED, Json(approval)))
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
        .map_err(ChatFailure::Store)?;
    let expires_at = now + ATTACHMENT_TICKET_TTL_MS;
    let ticket = state.chat_hub.issue_attachment_ticket(AttachmentTicket {
        org_id,
        session_id,
        attachment_id,
        user_id: member.user_id,
        action: AttachmentTicketAction::Upload,
        expires_at,
    });
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
    });
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
    let digest = format!("{:x}", Sha256::digest(&body));
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
        || format!("{:x}", Sha256::digest(&bytes)) != attachment.sha256
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
    use super::*;

    #[test]
    fn socket_tickets_are_single_use_and_expire() {
        let hub = ChatHub::default();
        let value = hub.issue_ticket(SocketTicket {
            org_id: "org".into(),
            session_id: "ses".into(),
            user_id: "usr".into(),
            expires_at: 20,
        });
        assert!(hub.consume_ticket(&value, 10).is_some());
        assert!(hub.consume_ticket(&value, 10).is_none());
        let expired = hub.issue_ticket(SocketTicket {
            org_id: "org".into(),
            session_id: "ses".into(),
            user_id: "usr".into(),
            expires_at: 20,
        });
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
        let ticket = hub.issue_attachment_ticket(AttachmentTicket {
            org_id: "org".into(),
            session_id: "session".into(),
            attachment_id: "attachment".into(),
            user_id: "user".into(),
            action: AttachmentTicketAction::Upload,
            expires_at: 20,
        });
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
