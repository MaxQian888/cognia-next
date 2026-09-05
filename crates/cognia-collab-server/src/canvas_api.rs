//! HTTP and WebSocket routes for Canvas documents.
//!
//! # Two doors into the same document
//!
//! The REST routes are the durable ones: create, rename, delete, pull the
//! update log, post an update, read comments and versions. Everything a client
//! can do live it can also do over HTTP, which is what makes the offline
//! replay queue possible at all. A client that was disconnected drains its
//! queue through `POST .../updates` and needs no socket to catch up.
//!
//! The WebSocket adds exactly two things HTTP cannot: fan-out without polling,
//! and presence. Nothing is reachable only through the socket.
//!
//! # Authorization runs on every frame, not once at the handshake
//!
//! A ticket proves the bearer could read the document 30 seconds ago. A socket
//! can stay open for hours. Re-resolving the caller's workspace role on every
//! inbound write is one indexed lookup next to a transaction that already does
//! an insert and an update, and it means removing somebody from a workspace
//! stops their typing at the next keystroke rather than whenever they happen
//! to reconnect.
//!
//! # Why a document id in the path is not enough to find one
//!
//! Authorization is per workspace, so a document-scoped route has to learn
//! which workspace the document is in before it can decide anything. That
//! lookup happens under the caller's already-verified org grant, and a caller
//! who cannot read the workspace is answered 404 rather than 403: telling an
//! outsider that a document exists somewhere they cannot see is the leak.

use std::collections::HashMap;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::{authorize_workspace, verify_grant, AuthError, Caller};
use crate::canvas::{
    CanvasAction, CanvasCommentRecord, CanvasDocumentRecord, CanvasPresence, CanvasVersionRecord,
};
use crate::canvas_store::{
    decode_payload, CanvasCatchUp, NewCanvasComment, NewCanvasDocument, NewCanvasSnapshot,
    NewCanvasUpdate, NewCanvasVersion, RenameCanvasDocument,
};
use crate::store::StoreError;

/// The subprotocol a Canvas socket must offer. Bumping it is how a breaking
/// frame change is rolled out, because a client offering only the old value
/// fails the handshake instead of half-speaking the new one.
pub const CANVAS_SUBPROTOCOL: &str = "cognia.canvas.v1";

const SOCKET_TICKET_TTL_MS: i64 = 30_000;
/// How many updates one catch-up returns. A client that is further behind
/// pages with `since`, which is also what stops a very old peer from asking
/// for a response the server has to build in memory all at once.
const CATCH_UP_PAGE: i64 = 512;

#[derive(Debug, Clone)]
struct SocketTicket {
    org_id: String,
    document_id: String,
    user_id: String,
    expires_at: i64,
}

/// One frame on the wire, in the shape the existing client already speaks
/// (`lib/canvas/collaboration/websocket-provider.ts`).
///
/// `session_id` is the document id. The client calls it a session because it
/// models one editing session per document, and renaming the field would have
/// been a protocol break for no gain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFrame {
    #[serde(rename = "type")]
    pub kind: String,
    pub session_id: String,
    pub participant_id: String,
    pub data: serde_json::Value,
    pub timestamp: i64,
}

/// Live sockets and their presence rosters, per document.
#[derive(Default)]
pub struct CanvasHub {
    senders: RwLock<HashMap<String, broadcast::Sender<CanvasFrame>>>,
    tickets: RwLock<HashMap<String, SocketTicket>>,
    presence: RwLock<HashMap<String, Vec<CanvasPresence>>>,
}

impl CanvasHub {
    fn sender(&self, document_id: &str) -> broadcast::Sender<CanvasFrame> {
        if let Some(sender) = self.senders.read().get(document_id) {
            return sender.clone();
        }
        let mut senders = self.senders.write();
        senders
            .entry(document_id.to_owned())
            .or_insert_with(|| broadcast::channel(512).0)
            .clone()
    }

    fn issue_ticket(&self, ticket: SocketTicket) -> String {
        let value = format!("ct_{}", Uuid::new_v4().simple());
        self.tickets.write().insert(value.clone(), ticket);
        value
    }

    /// Redeem a ticket. Removed on the way out whether or not it was still
    /// valid, so a leaked ticket cannot be replayed even by the person it was
    /// minted for.
    fn consume_ticket(&self, value: &str, now: i64) -> Option<SocketTicket> {
        self.tickets
            .write()
            .remove(value)
            .filter(|ticket| ticket.expires_at > now)
    }

    /// Drop expired tickets. Called when one is minted, so the map cannot grow
    /// without bound on a server whose clients keep asking for tickets and
    /// never connecting.
    fn sweep_tickets(&self, now: i64) {
        self.tickets
            .write()
            .retain(|_, ticket| ticket.expires_at > now);
    }

    fn join(&self, document_id: &str, participant: CanvasPresence) -> Vec<CanvasPresence> {
        let mut presence = self.presence.write();
        let roster = presence.entry(document_id.to_owned()).or_default();
        // A reconnecting participant replaces its old entry rather than
        // appearing twice in the roster.
        roster.retain(|existing| existing.participant_id != participant.participant_id);
        let others = roster.clone();
        roster.push(participant);
        others
    }

    fn leave(&self, document_id: &str, participant_id: &str) {
        let mut presence = self.presence.write();
        if let Some(roster) = presence.get_mut(document_id) {
            roster.retain(|existing| existing.participant_id != participant_id);
            if roster.is_empty() {
                presence.remove(document_id);
            }
        }
    }

    fn touch(&self, document_id: &str, participant_id: &str, now: i64) {
        if let Some(roster) = self.presence.write().get_mut(document_id) {
            if let Some(entry) = roster
                .iter_mut()
                .find(|entry| entry.participant_id == participant_id)
            {
                entry.last_active = now;
            }
        }
    }

    pub fn roster(&self, document_id: &str) -> Vec<CanvasPresence> {
        self.presence
            .read()
            .get(document_id)
            .cloned()
            .unwrap_or_default()
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/orgs/{org_id}/workspaces/{workspace_id}/canvas-documents",
            get(list_documents).post(create_document),
        )
        .route(
            "/v1/orgs/{org_id}/canvas-documents/{document_id}",
            get(get_document)
                .patch(patch_document)
                .delete(remove_document),
        )
        .route(
            "/v1/orgs/{org_id}/canvas-documents/{document_id}/updates",
            get(pull_updates).post(push_update),
        )
        .route(
            "/v1/orgs/{org_id}/canvas-documents/{document_id}/snapshots",
            post(push_snapshot),
        )
        .route(
            "/v1/orgs/{org_id}/canvas-documents/{document_id}/comments",
            get(list_comments).post(create_comment),
        )
        .route(
            "/v1/orgs/{org_id}/canvas-documents/{document_id}/comments/{comment_id}",
            patch(patch_comment).delete(remove_comment),
        )
        .route(
            "/v1/orgs/{org_id}/canvas-documents/{document_id}/versions",
            get(list_versions).post(create_version),
        )
        .route(
            "/v1/orgs/{org_id}/canvas-documents/{document_id}/presence",
            get(read_presence),
        )
        .route(
            "/v1/orgs/{org_id}/canvas-documents/{document_id}/stream-tickets",
            post(create_stream_ticket),
        )
        .route(
            "/v1/orgs/{org_id}/canvas-documents/{document_id}/stream",
            get(open_stream),
        )
}

#[derive(Debug)]
enum CanvasFailure {
    Unauthorized,
    Forbidden,
    /// The caller may not read this document, so it is reported as absent.
    Hidden,
    Gone,
    BadRequest(String),
    Store(StoreError),
}

impl IntoResponse for CanvasFailure {
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
            Self::Hidden | Self::Store(StoreError::NotFound) => (
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
            Self::Store(StoreError::Conflict(authoritative)) => (
                StatusCode::CONFLICT,
                serde_json::json!({"error":"conflict","authoritative":authoritative}),
            ),
            Self::Store(StoreError::Policy(reason)) => (
                StatusCode::FORBIDDEN,
                serde_json::json!({"error":"forbidden","reason":reason}),
            ),
            Self::Store(error) => {
                tracing::error!(error=%error, "canvas storage failure");
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

/// Authorize a workspace-scoped route.
async fn workspace_caller(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
    workspace_id: &str,
    action: CanvasAction,
) -> Result<Caller, CanvasFailure> {
    let claims = verify_grant(&state.signer, bearer(headers), org_id)
        .await
        .map_err(|_| CanvasFailure::Unauthorized)?;
    authorize_workspace(
        state.store.as_ref(),
        &claims,
        workspace_id,
        action.required_capability(),
    )
    .await
    .map_err(|error| match error {
        AuthError::Forbidden => CanvasFailure::Forbidden,
        _ => CanvasFailure::Unauthorized,
    })
}

/// Authorize a document-scoped route.
///
/// Resolves the workspace from the document, then checks read access before
/// the action's own bar. The two-step is what lets a caller who may read but
/// not write be told 403 while a caller who may not read at all is told 404.
async fn document_caller(
    state: &AppState,
    headers: &HeaderMap,
    org_id: &str,
    document_id: &str,
    action: CanvasAction,
) -> Result<(Caller, String), CanvasFailure> {
    let claims = verify_grant(&state.signer, bearer(headers), org_id)
        .await
        .map_err(|_| CanvasFailure::Unauthorized)?;
    let workspace_id = state
        .canvas_store
        .document_workspace(org_id, document_id)
        .await
        .map_err(|error| match error {
            StoreError::NotFound => CanvasFailure::Hidden,
            other => CanvasFailure::Store(other),
        })?;
    let reader = authorize_workspace(
        state.store.as_ref(),
        &claims,
        &workspace_id,
        CanvasAction::Read.required_capability(),
    )
    .await
    .map_err(|_| CanvasFailure::Hidden)?;
    if !reader.access.allows(action.required_capability()) {
        return Err(CanvasFailure::Forbidden);
    }
    Ok((reader, workspace_id))
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDocumentBody {
    id: String,
    title: String,
    language: String,
    operation_id: String,
}

async fn list_documents(
    State(state): State<AppState>,
    Path((org_id, workspace_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<CanvasDocumentRecord>>, CanvasFailure> {
    workspace_caller(&state, &headers, &org_id, &workspace_id, CanvasAction::Read).await?;
    Ok(Json(
        state
            .canvas_store
            .list_documents(&org_id, &workspace_id)
            .await
            .map_err(CanvasFailure::Store)?,
    ))
}

async fn create_document(
    State(state): State<AppState>,
    Path((org_id, workspace_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateDocumentBody>,
) -> Result<(StatusCode, Json<CanvasDocumentRecord>), CanvasFailure> {
    let caller = workspace_caller(
        &state,
        &headers,
        &org_id,
        &workspace_id,
        CanvasAction::Create,
    )
    .await?;
    if body.id.trim().is_empty() || body.operation_id.trim().is_empty() {
        return Err(CanvasFailure::BadRequest(
            "id and operationId are required".into(),
        ));
    }
    let document = state
        .canvas_store
        .create_document(NewCanvasDocument {
            id: body.id,
            org_id,
            workspace_id,
            title: body.title,
            language: body.language,
            created_by_user_id: caller.user_id,
            created_at: (state.now)(),
            operation_id: body.operation_id,
        })
        .await
        .map_err(CanvasFailure::Store)?;
    Ok((StatusCode::CREATED, Json(document)))
}

async fn get_document(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<CanvasDocumentRecord>, CanvasFailure> {
    let (_, workspace_id) =
        document_caller(&state, &headers, &org_id, &document_id, CanvasAction::Read).await?;
    Ok(Json(
        state
            .canvas_store
            .get_document(&org_id, &workspace_id, &document_id)
            .await
            .map_err(CanvasFailure::Store)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchDocumentBody {
    title: Option<String>,
    language: Option<String>,
    base_revision: i64,
    operation_id: String,
}

async fn patch_document(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PatchDocumentBody>,
) -> Result<Json<CanvasDocumentRecord>, CanvasFailure> {
    document_caller(
        &state,
        &headers,
        &org_id,
        &document_id,
        CanvasAction::Rename,
    )
    .await?;
    Ok(Json(
        state
            .canvas_store
            .rename_document(RenameCanvasDocument {
                org_id,
                document_id,
                title: body.title,
                language: body.language,
                base_revision: body.base_revision,
                operation_id: body.operation_id,
                now: (state.now)(),
            })
            .await
            .map_err(CanvasFailure::Store)?,
    ))
}

async fn remove_document(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, CanvasFailure> {
    document_caller(
        &state,
        &headers,
        &org_id,
        &document_id,
        CanvasAction::Delete,
    )
    .await?;
    state
        .canvas_store
        .delete_document(&org_id, &document_id)
        .await
        .map_err(CanvasFailure::Store)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Updates and snapshots
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatchUpQuery {
    #[serde(default)]
    since: i64,
}

async fn pull_updates(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    Query(query): Query<CatchUpQuery>,
    headers: HeaderMap,
) -> Result<Json<CanvasCatchUpResponse>, CanvasFailure> {
    document_caller(&state, &headers, &org_id, &document_id, CanvasAction::Read).await?;
    let caught_up = state
        .canvas_store
        .catch_up(&org_id, &document_id, query.since.max(0), CATCH_UP_PAGE)
        .await
        .map_err(CanvasFailure::Store)?;
    Ok(Json(CanvasCatchUpResponse::from(caught_up)))
}

/// A catch-up as the wire sees it.
///
/// `hasMore` exists because the page limit is silent otherwise: a client that
/// received exactly 512 updates cannot tell a full page from the end of the
/// log, and would stop one page short of current.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasCatchUpResponse {
    pub snapshot: Option<String>,
    pub snapshot_sequence: i64,
    pub updates: Vec<crate::canvas::CanvasUpdateRecord>,
    pub latest_sequence: i64,
    pub has_more: bool,
}

impl From<CanvasCatchUp> for CanvasCatchUpResponse {
    fn from(value: CanvasCatchUp) -> Self {
        // An empty page means the caller's floor was already at or past the
        // head, so there is nothing more. Falling back to the snapshot
        // sequence here instead would tell a caught-up client to keep paging
        // forever against a document that had been compacted.
        let has_more = value
            .updates
            .last()
            .is_some_and(|update| update.sequence < value.latest_sequence);
        Self {
            has_more,
            snapshot: value.snapshot,
            snapshot_sequence: value.snapshot_sequence,
            updates: value.updates,
            latest_sequence: value.latest_sequence,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushUpdateBody {
    /// Base64 of one Yjs update.
    update: String,
    operation_id: String,
}

async fn push_update(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PushUpdateBody>,
) -> Result<(StatusCode, Json<crate::canvas::CanvasUpdateRecord>), CanvasFailure> {
    let (caller, _) =
        document_caller(&state, &headers, &org_id, &document_id, CanvasAction::Edit).await?;
    let payload = decode_payload(&body.update)
        .ok_or_else(|| CanvasFailure::BadRequest("update is not a base64 payload".into()))?;
    let now = (state.now)();
    let record = state
        .canvas_store
        .append_update(NewCanvasUpdate {
            org_id,
            document_id: document_id.clone(),
            payload,
            author_user_id: caller.user_id,
            created_at: now,
            operation_id: body.operation_id,
        })
        .await
        .map_err(CanvasFailure::Store)?;
    // Anyone with a socket open on this document sees an HTTP-posted update
    // immediately, which is what lets an offline client's drain reach the
    // people who stayed connected.
    broadcast_update(&state, &document_id, &record, "http");
    Ok((StatusCode::CREATED, Json(record)))
}

fn broadcast_update(
    state: &AppState,
    document_id: &str,
    record: &crate::canvas::CanvasUpdateRecord,
    participant_id: &str,
) {
    let frame = CanvasFrame {
        kind: "operation".into(),
        session_id: document_id.to_owned(),
        participant_id: participant_id.to_owned(),
        data: serde_json::json!({
            "id": record.operation_id,
            "update": record.payload,
            "origin": participant_id,
            "timestamp": record.created_at,
        }),
        timestamp: record.created_at,
    };
    let _ = state.canvas_hub.sender(document_id).send(frame);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushSnapshotBody {
    snapshot: String,
    covers_sequence: i64,
}

async fn push_snapshot(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PushSnapshotBody>,
) -> Result<Json<CanvasDocumentRecord>, CanvasFailure> {
    document_caller(
        &state,
        &headers,
        &org_id,
        &document_id,
        CanvasAction::Compact,
    )
    .await?;
    let payload = decode_payload(&body.snapshot)
        .ok_or_else(|| CanvasFailure::BadRequest("snapshot is not a base64 payload".into()))?;
    Ok(Json(
        state
            .canvas_store
            .store_snapshot(NewCanvasSnapshot {
                org_id,
                document_id,
                payload,
                covers_sequence: body.covers_sequence,
                now: (state.now)(),
            })
            .await
            .map_err(CanvasFailure::Store)?,
    ))
}

// ---------------------------------------------------------------------------
// Comments and versions
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCommentBody {
    id: String,
    anchor: String,
    head: Option<String>,
    body: String,
    operation_id: String,
}

async fn create_comment(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateCommentBody>,
) -> Result<(StatusCode, Json<CanvasCommentRecord>), CanvasFailure> {
    let (caller, _) = document_caller(
        &state,
        &headers,
        &org_id,
        &document_id,
        CanvasAction::Comment,
    )
    .await?;
    if body.anchor.trim().is_empty() {
        return Err(CanvasFailure::BadRequest(
            "a comment must be anchored".into(),
        ));
    }
    let record = state
        .canvas_store
        .create_comment(NewCanvasComment {
            id: body.id,
            org_id,
            document_id,
            anchor: body.anchor,
            head: body.head,
            body: body.body,
            author_user_id: caller.user_id,
            created_at: (state.now)(),
            operation_id: body.operation_id,
        })
        .await
        .map_err(CanvasFailure::Store)?;
    Ok((StatusCode::CREATED, Json(record)))
}

async fn list_comments(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<CanvasCommentRecord>>, CanvasFailure> {
    document_caller(&state, &headers, &org_id, &document_id, CanvasAction::Read).await?;
    Ok(Json(
        state
            .canvas_store
            .list_comments(&org_id, &document_id)
            .await
            .map_err(CanvasFailure::Store)?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchCommentBody {
    body: Option<String>,
    resolved: Option<bool>,
}

async fn patch_comment(
    State(state): State<AppState>,
    Path((org_id, document_id, comment_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(patch): Json<PatchCommentBody>,
) -> Result<Json<CanvasCommentRecord>, CanvasFailure> {
    document_caller(
        &state,
        &headers,
        &org_id,
        &document_id,
        CanvasAction::Comment,
    )
    .await?;
    Ok(Json(
        state
            .canvas_store
            .update_comment(
                &org_id,
                &document_id,
                &comment_id,
                patch.body.as_deref(),
                patch.resolved,
                (state.now)(),
            )
            .await
            .map_err(CanvasFailure::Store)?,
    ))
}

async fn remove_comment(
    State(state): State<AppState>,
    Path((org_id, document_id, comment_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, CanvasFailure> {
    document_caller(
        &state,
        &headers,
        &org_id,
        &document_id,
        CanvasAction::Comment,
    )
    .await?;
    state
        .canvas_store
        .delete_comment(&org_id, &document_id, &comment_id)
        .await
        .map_err(CanvasFailure::Store)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateVersionBody {
    id: String,
    label: String,
    content: String,
    operation_id: String,
}

async fn create_version(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateVersionBody>,
) -> Result<(StatusCode, Json<CanvasVersionRecord>), CanvasFailure> {
    let (caller, _) =
        document_caller(&state, &headers, &org_id, &document_id, CanvasAction::Edit).await?;
    let record = state
        .canvas_store
        .create_version(NewCanvasVersion {
            id: body.id,
            org_id,
            document_id,
            label: body.label,
            content: body.content,
            author_user_id: caller.user_id,
            created_at: (state.now)(),
            operation_id: body.operation_id,
        })
        .await
        .map_err(CanvasFailure::Store)?;
    Ok((StatusCode::CREATED, Json(record)))
}

async fn list_versions(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<CanvasVersionRecord>>, CanvasFailure> {
    document_caller(&state, &headers, &org_id, &document_id, CanvasAction::Read).await?;
    Ok(Json(
        state
            .canvas_store
            .list_versions(&org_id, &document_id)
            .await
            .map_err(CanvasFailure::Store)?,
    ))
}

async fn read_presence(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<CanvasPresence>>, CanvasFailure> {
    document_caller(&state, &headers, &org_id, &document_id, CanvasAction::Read).await?;
    Ok(Json(state.canvas_hub.roster(&document_id)))
}

// ---------------------------------------------------------------------------
// The live socket
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketResponse {
    ticket: String,
    expires_at: i64,
}

async fn create_stream_ticket(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<TicketResponse>, CanvasFailure> {
    let (caller, _) =
        document_caller(&state, &headers, &org_id, &document_id, CanvasAction::Read).await?;
    let now = (state.now)();
    state.canvas_hub.sweep_tickets(now);
    let expires_at = now + SOCKET_TICKET_TTL_MS;
    let ticket = state.canvas_hub.issue_ticket(SocketTicket {
        org_id,
        document_id,
        user_id: caller.user_id,
        expires_at,
    });
    Ok(Json(TicketResponse { ticket, expires_at }))
}

/// Upgrade to a Canvas socket.
///
/// The ticket travels as a WebSocket subprotocol rather than a query
/// parameter, because a browser cannot set headers on a WebSocket handshake
/// and a URL lands in proxy logs and browser history. Same trick the shared
/// chat stream uses.
async fn open_stream(
    State(state): State<AppState>,
    Path((org_id, document_id)): Path<(String, String)>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, CanvasFailure> {
    let offered = headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let values: Vec<&str> = offered.split(',').map(str::trim).collect();
    if !values.contains(&CANVAS_SUBPROTOCOL) {
        return Err(CanvasFailure::Unauthorized);
    }
    let ticket_value = values
        .iter()
        .find(|value| value.starts_with("ct_"))
        .ok_or(CanvasFailure::Unauthorized)?;
    let ticket = state
        .canvas_hub
        .consume_ticket(ticket_value, (state.now)())
        .ok_or(CanvasFailure::Gone)?;
    if ticket.org_id != org_id || ticket.document_id != document_id {
        return Err(CanvasFailure::Hidden);
    }
    let receiver = state.canvas_hub.sender(&document_id).subscribe();
    Ok(ws
        .protocols([CANVAS_SUBPROTOCOL])
        .on_upgrade(move |socket| stream_loop(socket, state, ticket, receiver))
        .into_response())
}

/// Everything one connection knows about itself.
struct Connection {
    org_id: String,
    document_id: String,
    user_id: String,
    /// Unknown until the client's first presence frame names it.
    participant_id: std::sync::Arc<RwLock<Option<String>>>,
}

async fn stream_loop(
    socket: WebSocket,
    state: AppState,
    ticket: SocketTicket,
    mut broadcast_rx: broadcast::Receiver<CanvasFrame>,
) {
    use futures_util::{SinkExt, StreamExt};

    let connection = Connection {
        org_id: ticket.org_id,
        document_id: ticket.document_id,
        user_id: ticket.user_id,
        participant_id: std::sync::Arc::new(RwLock::new(None)),
    };
    let (mut sink, mut stream) = socket.split();
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::channel::<CanvasFrame>(256);

    // The writer owns the sink, so nothing else can interleave a half-written
    // frame into it. It merges two sources: what this connection is answering
    // directly, and what the document is broadcasting to everyone.
    let mine = connection.participant_id.clone();
    let writer = tokio::spawn(async move {
        loop {
            let frame = tokio::select! {
                direct = outbound_rx.recv() => match direct {
                    Some(frame) => frame,
                    None => break,
                },
                relayed = broadcast_rx.recv() => match relayed {
                    Ok(frame) => {
                        // Skipping our own echo here rather than trusting the
                        // client to: a participant that re-applied its own
                        // presence join would announce itself joining.
                        if mine.read().as_deref() == Some(frame.participant_id.as_str()) {
                            continue;
                        }
                        frame
                    }
                    // Lagged means this connection fell far enough behind that
                    // frames were dropped. The document state is no longer
                    // recoverable from the stream, so the honest move is to
                    // close and let the client reconnect and catch up.
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
            let Ok(text) = serde_json::to_string(&frame) else {
                continue;
            };
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            // Binary, ping and pong need no handling: axum answers pings, and
            // every Canvas frame is JSON.
            continue;
        };
        let Ok(frame) = serde_json::from_str::<CanvasFrame>(&text) else {
            continue;
        };
        // The path is the authority on which document this is. A frame naming
        // another one is not routed there, it is dropped.
        if frame.session_id != connection.document_id {
            continue;
        }
        if !handle_frame(&state, &connection, &outbound_tx, frame).await {
            break;
        }
    }

    // Whatever ended the loop, the roster must not keep claiming this person
    // is looking at the document.
    if let Some(participant_id) = connection.participant_id.read().clone() {
        state
            .canvas_hub
            .leave(&connection.document_id, &participant_id);
        let _ = state
            .canvas_hub
            .sender(&connection.document_id)
            .send(presence_frame(
                &connection.document_id,
                &participant_id,
                "leave",
                serde_json::Value::Null,
            ));
    }
    writer.abort();
}

fn presence_frame(
    document_id: &str,
    participant_id: &str,
    action: &str,
    participant: serde_json::Value,
) -> CanvasFrame {
    let mut data = serde_json::json!({ "action": action });
    if !participant.is_null() {
        data["participant"] = participant;
    }
    CanvasFrame {
        kind: "presence".into(),
        session_id: document_id.to_owned(),
        participant_id: participant_id.to_owned(),
        data,
        timestamp: 0,
    }
}

/// Handle one inbound frame. `false` ends the connection.
async fn handle_frame(
    state: &AppState,
    connection: &Connection,
    outbound: &tokio::sync::mpsc::Sender<CanvasFrame>,
    frame: CanvasFrame,
) -> bool {
    match frame.kind.as_str() {
        "presence" => handle_presence(state, connection, outbound, frame).await,
        "operation" => handle_operation(state, connection, frame).await,
        // Cursors and selections are read-level facts about where somebody is
        // looking. They are relayed and never stored, so a stale one dies with
        // the socket instead of outliving the session.
        "cursor" | "selection" => {
            let _ = state.canvas_hub.sender(&connection.document_id).send(frame);
            true
        }
        "sync" => handle_sync(state, connection, outbound, frame).await,
        _ => true,
    }
}

async fn handle_presence(
    state: &AppState,
    connection: &Connection,
    outbound: &tokio::sync::mpsc::Sender<CanvasFrame>,
    frame: CanvasFrame,
) -> bool {
    let action = frame
        .data
        .get("action")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    match action {
        "join" => {
            let participant = frame.data.get("participant").cloned().unwrap_or_default();
            let now = (state.now)();
            let presence = CanvasPresence {
                participant_id: frame.participant_id.clone(),
                // From the ticket, never from the frame. A client that names
                // somebody else in its own join payload would otherwise appear
                // in the roster as them.
                user_id: connection.user_id.clone(),
                name: participant
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Anonymous")
                    .to_owned(),
                color: participant
                    .get("color")
                    .and_then(|value| value.as_str())
                    .unwrap_or("#888888")
                    .to_owned(),
                last_active: now,
            };
            *connection.participant_id.write() = Some(frame.participant_id.clone());
            let others = state.canvas_hub.join(&connection.document_id, presence);
            // The joiner is told who is already here, one frame per person,
            // which is the same shape as a live join and needs no new client
            // handling.
            for other in others {
                let payload = serde_json::json!({
                    "id": other.participant_id,
                    "name": other.name,
                    "color": other.color,
                    "isOnline": true,
                    "lastActive": other.last_active,
                });
                let _ = outbound
                    .send(presence_frame(
                        &connection.document_id,
                        &other.participant_id,
                        "join",
                        payload,
                    ))
                    .await;
            }
            let _ = state.canvas_hub.sender(&connection.document_id).send(frame);
            true
        }
        "heartbeat" => {
            state.canvas_hub.touch(
                &connection.document_id,
                &frame.participant_id,
                (state.now)(),
            );
            true
        }
        "leave" => false,
        _ => true,
    }
}

async fn handle_operation(state: &AppState, connection: &Connection, frame: CanvasFrame) -> bool {
    let Some(update) = frame.data.get("update").and_then(|value| value.as_str()) else {
        return true;
    };
    let operation_id = frame
        .data
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if operation_id.is_empty() {
        return true;
    }
    // The ticket said this person could read 30 seconds ago. Whether they may
    // write is asked now, on this keystroke, so a revoked role stops taking
    // effect at the next edit rather than at the next reconnect.
    if !may_edit(state, connection).await {
        return false;
    }
    let Some(payload) = decode_payload(update) else {
        return true;
    };
    let now = (state.now)();
    let record = state
        .canvas_store
        .append_update(NewCanvasUpdate {
            org_id: connection.org_id.clone(),
            document_id: connection.document_id.clone(),
            payload,
            author_user_id: connection.user_id.clone(),
            created_at: now,
            operation_id: operation_id.to_owned(),
        })
        .await;
    match record {
        Ok(record) => {
            // Relayed only after it is durable. Fanning out first would show
            // peers an edit that a failed write then loses.
            broadcast_update(
                state,
                &connection.document_id,
                &record,
                &frame.participant_id,
            );
            true
        }
        Err(StoreError::NotFound) => false,
        Err(error) => {
            tracing::warn!(error=%error, document=%connection.document_id, "canvas update rejected");
            true
        }
    }
}

async fn handle_sync(
    state: &AppState,
    connection: &Connection,
    outbound: &tokio::sync::mpsc::Sender<CanvasFrame>,
    frame: CanvasFrame,
) -> bool {
    if frame.data.get("action").and_then(|value| value.as_str()) != Some("request") {
        return true;
    }
    let since = frame
        .data
        .get("since")
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
        .max(0);
    let Ok(caught_up) = state
        .canvas_store
        .catch_up(
            &connection.org_id,
            &connection.document_id,
            since,
            CATCH_UP_PAGE,
        )
        .await
    else {
        return true;
    };
    // Baseline first, then each update in order. Applying them one at a time
    // is equivalent to applying a merged update, which is what lets this
    // server relay Yjs without linking it.
    let mut payloads: Vec<String> = Vec::new();
    if let Some(snapshot) = caught_up.snapshot {
        payloads.push(snapshot);
    }
    payloads.extend(caught_up.updates.into_iter().map(|update| update.payload));
    for payload in payloads {
        let sent = outbound
            .send(CanvasFrame {
                kind: "sync".into(),
                session_id: connection.document_id.clone(),
                participant_id: "server".into(),
                data: serde_json::json!({ "action": "response", "state": payload }),
                timestamp: (state.now)(),
            })
            .await;
        if sent.is_err() {
            return false;
        }
    }
    true
}

/// Whether this connection may still write to this document.
async fn may_edit(state: &AppState, connection: &Connection) -> bool {
    let Ok(workspace_id) = state
        .canvas_store
        .document_workspace(&connection.org_id, &connection.document_id)
        .await
    else {
        return false;
    };
    let Ok(membership) = state
        .store
        .membership(&connection.org_id, &connection.user_id, Some(&workspace_id))
        .await
    else {
        return false;
    };
    cognia_tenant_auth::membership::resolve_workspace_access(
        membership.org_role,
        membership.workspace_role,
    )
    .is_some_and(|access| access.allows(CanvasAction::Edit.required_capability()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    use axum::body::Body;
    use axum::http::Request;
    use cognia_tenant_auth::grant::{GrantClaims, GrantSigner};
    use cognia_tenant_auth::{OrgId, OrgRole, UserId, WorkspaceRole};
    use tower::ServiceExt;

    use crate::canvas_store::InMemoryCanvasStore;
    use crate::store::InMemoryStore;

    const ORG: &str = "org_acme00000000000000000";
    const DOCUMENT: &str = "cvd_1";

    fn ada() -> UserId {
        UserId::parse("usr_aaaaaaaaaaaaaaaaaaaaaaaa").unwrap()
    }

    fn viv() -> UserId {
        UserId::parse("usr_vvvvvvvvvvvvvvvvvvvvvvvv").unwrap()
    }

    fn outsider() -> UserId {
        UserId::parse("usr_oooooooooooooooooooooooo").unwrap()
    }

    fn signer() -> GrantSigner {
        GrantSigner::new(&[7; 32]).unwrap()
    }

    fn token_for(user: &UserId) -> String {
        let claims = GrantClaims::issue(
            user.clone(),
            OrgId::parse(ORG).unwrap(),
            None,
            None,
            Duration::from_secs(300),
        )
        .unwrap();
        format!("Bearer {}", signer().sign(&claims).unwrap())
    }

    /// Ada edits `proj-1`, Viv only views it, and the outsider is in the org
    /// but in no workspace at all.
    fn seeded() -> InMemoryStore {
        let store = InMemoryStore::new();
        for (user, name) in [(ada(), "Ada"), (viv(), "Viv"), (outsider(), "Otto")] {
            store.add_user(user.as_str(), name);
            store.add_org_member(ORG, user.as_str(), OrgRole::Member);
        }
        store.add_workspace_member(ORG, "proj-1", ada().as_str(), WorkspaceRole::Member);
        store.add_workspace_member(ORG, "proj-1", viv().as_str(), WorkspaceRole::Viewer);
        store
    }

    fn app(store: InMemoryStore, canvas: Arc<InMemoryCanvasStore>) -> Router {
        let mut state = AppState::new(
            Arc::new(store),
            signer(),
            Arc::new(cognia_tenant_auth::oidc::TestAuthenticator),
        )
        .with_canvas_store(canvas)
        .with_canvas_enabled(true);
        state.now = Arc::new(|| 1_000);
        crate::api::router(state)
    }

    async fn call(app: Router, request: Request<Body>) -> (StatusCode, serde_json::Value) {
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        (status, json)
    }

    fn request(
        method: &str,
        path: &str,
        token: &str,
        body: Option<serde_json::Value>,
    ) -> Request<Body> {
        let builder = Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", token);
        match body {
            Some(body) => builder
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        }
    }

    fn encode(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    async fn with_document() -> (InMemoryStore, Arc<InMemoryCanvasStore>) {
        let store = seeded();
        let canvas = Arc::new(InMemoryCanvasStore::new());
        let (status, _) = call(
            app(store.clone(), canvas.clone()),
            request(
                "POST",
                &format!("/v1/orgs/{ORG}/workspaces/proj-1/canvas-documents"),
                &token_for(&ada()),
                Some(serde_json::json!({
                    "id": DOCUMENT,
                    "title": "Notes",
                    "language": "markdown",
                    "operationId": "op_create",
                })),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        (store, canvas)
    }

    #[tokio::test]
    async fn a_workspace_member_creates_reads_and_edits() {
        let (store, canvas) = with_document().await;
        let (status, document) = call(
            app(store.clone(), canvas.clone()),
            request(
                "GET",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}"),
                &token_for(&ada()),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(document["title"], "Notes");

        let (status, update) = call(
            app(store, canvas),
            request(
                "POST",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/updates"),
                &token_for(&ada()),
                Some(serde_json::json!({
                    "update": encode(b"a yjs update"),
                    "operationId": "op_u1",
                })),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(update["sequence"], 1);
    }

    #[tokio::test]
    async fn a_viewer_reads_the_document_but_cannot_write_to_it() {
        let (store, canvas) = with_document().await;
        let (status, _) = call(
            app(store.clone(), canvas.clone()),
            request(
                "GET",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}"),
                &token_for(&viv()),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "a viewer may read");

        let (status, _) = call(
            app(store.clone(), canvas.clone()),
            request(
                "POST",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/updates"),
                &token_for(&viv()),
                Some(serde_json::json!({
                    "update": encode(b"nope"),
                    "operationId": "op_v1",
                })),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "a viewer may not edit");

        let (status, _) = call(
            app(store, canvas),
            request(
                "POST",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/comments"),
                &token_for(&viv()),
                Some(serde_json::json!({
                    "id": "cmt_v",
                    "anchor": "anchor",
                    "body": "hi",
                    "operationId": "op_vc",
                })),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "a viewer may not comment");
    }

    #[tokio::test]
    async fn a_member_may_edit_but_not_delete_or_compact() {
        let (store, canvas) = with_document().await;
        for (method, path, body) in [
            (
                "DELETE",
                format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}"),
                None,
            ),
            (
                "POST",
                format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/snapshots"),
                Some(serde_json::json!({
                    "snapshot": encode(b"snap"),
                    "coversSequence": 0,
                })),
            ),
        ] {
            let (status, _) = call(
                app(store.clone(), canvas.clone()),
                request(method, &path, &token_for(&ada()), body),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
        }
    }

    #[tokio::test]
    async fn somebody_outside_the_workspace_is_told_the_document_does_not_exist() {
        // Not 403. A 403 would confirm the id names a real document in an org
        // the caller happens to hold a grant for.
        let (store, canvas) = with_document().await;
        let (status, _) = call(
            app(store, canvas),
            request(
                "GET",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}"),
                &token_for(&outsider()),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_grant_for_another_org_never_reaches_the_document() {
        let (store, canvas) = with_document().await;
        let claims = GrantClaims::issue(
            ada(),
            OrgId::parse("org_somebodyelse00000000").unwrap(),
            None,
            None,
            Duration::from_secs(300),
        )
        .unwrap();
        let token = format!("Bearer {}", signer().sign(&claims).unwrap());
        let (status, _) = call(
            app(store, canvas),
            request(
                "GET",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}"),
                &token,
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn an_unsigned_request_is_refused_before_any_lookup() {
        let (store, canvas) = with_document().await;
        let (status, _) = call(
            app(store, canvas),
            request(
                "GET",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}"),
                "Bearer forged.token",
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn an_update_that_is_not_base64_is_a_bad_request_not_a_server_fault() {
        let (store, canvas) = with_document().await;
        let (status, body) = call(
            app(store, canvas),
            request(
                "POST",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/updates"),
                &token_for(&ada()),
                Some(serde_json::json!({
                    "update": "definitely not base64 !!!",
                    "operationId": "op_bad",
                })),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body["error"].as_str().is_some());
    }

    #[tokio::test]
    async fn replaying_an_update_over_http_is_idempotent() {
        let (store, canvas) = with_document().await;
        let body = serde_json::json!({
            "update": encode(b"same update"),
            "operationId": "op_replay",
        });
        let first = call(
            app(store.clone(), canvas.clone()),
            request(
                "POST",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/updates"),
                &token_for(&ada()),
                Some(body.clone()),
            ),
        )
        .await;
        let second = call(
            app(store.clone(), canvas.clone()),
            request(
                "POST",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/updates"),
                &token_for(&ada()),
                Some(body),
            ),
        )
        .await;
        assert_eq!(first.1["sequence"], second.1["sequence"]);

        let (_, caught_up) = call(
            app(store, canvas),
            request(
                "GET",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/updates?since=0"),
                &token_for(&ada()),
                None,
            ),
        )
        .await;
        assert_eq!(caught_up["updates"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn catch_up_reports_whether_more_is_waiting() {
        let (store, canvas) = with_document().await;
        for index in 0..3 {
            call(
                app(store.clone(), canvas.clone()),
                request(
                    "POST",
                    &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/updates"),
                    &token_for(&ada()),
                    Some(serde_json::json!({
                        "update": encode(format!("update {index}").as_bytes()),
                        "operationId": format!("op_{index}"),
                    })),
                ),
            )
            .await;
        }
        let (_, caught_up) = call(
            app(store.clone(), canvas.clone()),
            request(
                "GET",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/updates?since=0"),
                &token_for(&ada()),
                None,
            ),
        )
        .await;
        assert_eq!(caught_up["latestSequence"], 3);
        assert_eq!(caught_up["hasMore"], false);

        let (_, at_head) = call(
            app(store, canvas),
            request(
                "GET",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/updates?since=3"),
                &token_for(&ada()),
                None,
            ),
        )
        .await;
        assert_eq!(at_head["updates"].as_array().unwrap().len(), 0);
        assert_eq!(at_head["hasMore"], false);
    }

    #[tokio::test]
    async fn the_canvas_routes_are_absent_when_the_gate_is_closed() {
        let (store, canvas) = with_document().await;
        let mut state = AppState::new(
            Arc::new(store),
            signer(),
            Arc::new(cognia_tenant_auth::oidc::TestAuthenticator),
        )
        .with_canvas_store(canvas)
        .with_canvas_enabled(false);
        state.now = Arc::new(|| 1_000);
        let (status, _) = call(
            crate::api::router(state),
            request(
                "GET",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}"),
                &token_for(&ada()),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_stream_ticket_needs_read_access_and_is_single_use() {
        let (store, canvas) = with_document().await;
        let (status, body) = call(
            app(store.clone(), canvas.clone()),
            request(
                "POST",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/stream-tickets"),
                &token_for(&viv()),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "a viewer may watch");
        assert!(body["ticket"].as_str().unwrap().starts_with("ct_"));

        let (status, _) = call(
            app(store, canvas),
            request(
                "POST",
                &format!("/v1/orgs/{ORG}/canvas-documents/{DOCUMENT}/stream-tickets"),
                &token_for(&outsider()),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn socket_tickets_are_single_use_and_expire() {
        let hub = CanvasHub::default();
        let value = hub.issue_ticket(SocketTicket {
            org_id: ORG.into(),
            document_id: DOCUMENT.into(),
            user_id: "usr".into(),
            expires_at: 20,
        });
        assert!(hub.consume_ticket(&value, 10).is_some());
        assert!(
            hub.consume_ticket(&value, 10).is_none(),
            "a ticket must not be replayable"
        );
        let expired = hub.issue_ticket(SocketTicket {
            org_id: ORG.into(),
            document_id: DOCUMENT.into(),
            user_id: "usr".into(),
            expires_at: 20,
        });
        assert!(hub.consume_ticket(&expired, 20).is_none());
    }

    #[test]
    fn sweeping_drops_expired_tickets_so_the_map_cannot_grow_without_bound() {
        let hub = CanvasHub::default();
        let stale = hub.issue_ticket(SocketTicket {
            org_id: ORG.into(),
            document_id: DOCUMENT.into(),
            user_id: "usr".into(),
            expires_at: 10,
        });
        hub.sweep_tickets(50);
        assert!(hub.consume_ticket(&stale, 5).is_none());
    }

    #[test]
    fn a_reconnecting_participant_appears_once_in_the_roster() {
        let hub = CanvasHub::default();
        let entry = |last_active| CanvasPresence {
            participant_id: "p1".into(),
            user_id: "usr".into(),
            name: "Ada".into(),
            color: "#fff".into(),
            last_active,
        };
        assert!(hub.join(DOCUMENT, entry(1)).is_empty());
        let others = hub.join(DOCUMENT, entry(2));
        assert!(
            others.is_empty(),
            "a rejoin must not see its own stale entry as another participant"
        );
        assert_eq!(hub.roster(DOCUMENT).len(), 1);
    }

    #[test]
    fn leaving_empties_the_roster_rather_than_leaving_a_ghost() {
        let hub = CanvasHub::default();
        hub.join(
            DOCUMENT,
            CanvasPresence {
                participant_id: "p1".into(),
                user_id: "usr".into(),
                name: "Ada".into(),
                color: "#fff".into(),
                last_active: 1,
            },
        );
        hub.leave(DOCUMENT, "p1");
        assert!(hub.roster(DOCUMENT).is_empty());
    }

    #[test]
    fn a_frame_serialises_under_the_name_the_existing_client_reads() {
        // `websocket-provider.ts` switches on `type` and reads `sessionId`,
        // `participantId`, `data` and `timestamp`. Renaming any of them is a
        // protocol break, so the wire names are pinned here.
        let frame = CanvasFrame {
            kind: "operation".into(),
            session_id: DOCUMENT.into(),
            participant_id: "p1".into(),
            data: serde_json::json!({"id":"op","update":"AA==","origin":"p1"}),
            timestamp: 7,
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["type"], "operation");
        assert_eq!(json["sessionId"], DOCUMENT);
        assert_eq!(json["participantId"], "p1");
        assert_eq!(json["timestamp"], 7);
        assert_eq!(json["data"]["update"], "AA==");
    }
}
