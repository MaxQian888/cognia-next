use std::collections::HashMap;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
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
use crate::chat_store::{NewChatRunLease, NewSessionEvent, NewSharedSession};
use crate::store::StoreError;
use cognia_tenant_auth::WorkspaceCapability;

const SOCKET_TICKET_TTL_MS: i64 = 30_000;
const LEASE_TOKEN_TTL_MS: i64 = 5 * 60_000;
const LEASE_HEARTBEAT_TTL_MS: i64 = 90_000;

#[derive(Debug, Clone)]
struct SocketTicket {
    org_id: String,
    session_id: String,
    user_id: String,
    expires_at: i64,
}

#[derive(Default)]
pub struct ChatHub {
    senders: RwLock<HashMap<String, broadcast::Sender<SessionEvent>>>,
    tickets: RwLock<HashMap<String, SocketTicket>>,
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
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/orgs/{org_id}/workspaces/{workspace_id}/chat-sessions",
            get(list_sessions).post(create_session),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}",
            get(get_session).patch(patch_session),
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
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/events",
            get(list_events).post(append_event),
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
            post(acquire_run_lease),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/run-leases/{lease_id}/heartbeat",
            post(heartbeat_run_lease),
        )
        .route(
            "/v1/orgs/{org_id}/chat-sessions/{session_id}/run-leases/{lease_id}",
            delete(release_run_lease),
        )
}

#[derive(Debug)]
enum ChatFailure {
    Unauthorized,
    Forbidden,
    Hidden,
    Gone,
    BadRequest(String),
    Store(StoreError),
}

impl IntoResponse for ChatFailure {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                serde_json::json!({"error":"unauthorized"}),
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
            Self::Store(StoreError::NotFound) => (
                StatusCode::NOT_FOUND,
                serde_json::json!({"error":"not found"}),
            ),
            Self::Store(StoreError::Conflict(authoritative)) => (
                StatusCode::CONFLICT,
                serde_json::json!({"error":"conflict","authoritative":authoritative}),
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

async fn claims(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
) -> Result<cognia_tenant_auth::grant::GrantClaims, ChatFailure> {
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
        .map_err(ChatFailure::Store)?
        .ok_or(ChatFailure::Hidden)?;
    let decision = authorize_session_action(Some(&pair.1), action, pair.0.policy_revision);
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
async fn put_member(
    State(state): State<AppState>,
    Path((org_id, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PutMemberBody>,
) -> Result<(StatusCode, Json<crate::chat::SessionMembership>), ChatFailure> {
    let (session, _) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::ManageMembers,
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
    let (session, _) = visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::ManageMembers,
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
    visible(
        &state,
        &headers,
        &org_id,
        &session_id,
        SessionAction::ManageMembers,
    )
    .await?;
    state
        .chat_store
        .remove_member(&org_id, &session_id, &user_id, (state.now)())
        .await
        .map_err(ChatFailure::Store)?;
    let _ =
        state
            .chat_hub
            .sender(&session_id)
            .send(policy_event(&session_id, &user_id, (state.now)()));
    Ok(StatusCode::NO_CONTENT)
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
        "message.created" | "message.corrected" | "message.redacted" | "run.steered"
    ) {
        return Err(ChatFailure::BadRequest(
            "event kind is not client-writable".into(),
        ));
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
        .await
        .map_err(ChatFailure::Store)?;
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
        .await
        .map_err(ChatFailure::Store)?;
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
}
