//! The workspace change feed (ADR-0206).
//!
//! Shared issues, plans, runs and memberships used to reach a client only when
//! it polled (every 60 s while visible). This module gives each organisation
//! one WebSocket stream that says *what* changed, never *how*: a frame is an
//! invalidation (`{entity, id, workspaceId, revision}`), and the client answers
//! it by re-running the one refresh path its mirrors already trust. Keeping the
//! data off this stream is what keeps the client to a single write path into
//! its mirrors.
//!
//! Visibility is decided per connection against the reader's workspace scope,
//! which is cached for [`SCOPE_TTL_MS`] and re-read at once when a frame names
//! the reader's own membership. Frames for workspaces the reader cannot see are
//! dropped, not redacted: an id alone leaks existence.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use cognia_tenant_auth::grant::GrantClaims;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::api::AppState;
use crate::auth::{readable_scope, verify_grant, AuthError, WorkspaceScope};
use crate::socket_hub::{Channels, Expiring, TicketBook};

/// Offered alongside the ticket in `Sec-WebSocket-Protocol`, exactly as the
/// Canvas and shared chat streams do: a browser cannot set headers on a
/// WebSocket handshake, and a URL lands in proxy logs.
pub const FEED_SUBPROTOCOL: &str = "cognia.collab.feed.v1";
const FEED_TICKET_PREFIX: &str = "ft_";
const FEED_TICKET_TTL_MS: i64 = 30_000;
const MAX_PENDING_FEED_TICKETS: usize = 8_192;
/// Backlog per organisation. A reader that falls further behind is sent
/// `resync` and closed, and does one full refresh.
const FEED_CHANNEL_CAPACITY: usize = 1_024;
/// How long a connection trusts its cached workspace scope.
pub const SCOPE_TTL_MS: i64 = 5_000;

/// What changed. The client maps each to the refresh leg that owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedEntity {
    Issue,
    IssueEvent,
    Plan,
    Run,
    Workspace,
    Membership,
}

/// One frame on the feed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FeedFrame {
    /// Something the reader may hold a mirror of changed.
    #[serde(rename_all = "camelCase")]
    Invalidate {
        entity: FeedEntity,
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revision: Option<i64>,
        /// For `membership`: whose membership changed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user_id: Option<String>,
    },
    /// A notification was written for `recipient_user_id` (ADR-0207). Only
    /// that person's sockets receive it; the client pulls after `seq`.
    #[serde(rename_all = "camelCase")]
    Notification { recipient_user_id: String, seq: i64 },
    /// The reader fell behind the backlog. Refresh everything, then reconnect.
    Resync,
}

impl FeedFrame {
    pub fn invalidate(entity: FeedEntity, id: &str, workspace_id: &str, revision: i64) -> Self {
        Self::Invalidate {
            entity,
            id: id.to_owned(),
            workspace_id: Some(workspace_id.to_owned()),
            revision: Some(revision),
            user_id: None,
        }
    }

    /// A membership change. `workspace_id` is `None` for an org-level change
    /// (joined, role changed, removed from the org).
    pub fn membership(user_id: &str, workspace_id: Option<&str>) -> Self {
        Self::Invalidate {
            entity: FeedEntity::Membership,
            id: user_id.to_owned(),
            workspace_id: workspace_id.map(str::to_owned),
            revision: None,
            user_id: Some(user_id.to_owned()),
        }
    }

    /// Whether this frame changes what `user_id` may see.
    fn concerns_membership_of(&self, user_id: &str) -> bool {
        matches!(
            self,
            Self::Invalidate {
                entity: FeedEntity::Membership,
                user_id: Some(subject),
                ..
            } if subject == user_id
        )
    }
}

/// Whether `reader` holding `scope` may receive `frame`.
pub fn frame_visible(frame: &FeedFrame, reader: &str, scope: &WorkspaceScope) -> bool {
    let sees = |workspace: &str| match scope {
        WorkspaceScope::All => true,
        WorkspaceScope::Only(ids) => ids.iter().any(|id| id == workspace),
    };
    match frame {
        FeedFrame::Resync => true,
        FeedFrame::Notification {
            recipient_user_id, ..
        } => recipient_user_id == reader,
        FeedFrame::Invalidate {
            entity: FeedEntity::Membership,
            user_id,
            workspace_id,
            ..
        } => {
            // Your own membership always concerns you. Someone else's concerns
            // you only through a roster you can already see; an org-level
            // change is for those who administer the org.
            user_id.as_deref() == Some(reader)
                || match workspace_id {
                    Some(workspace) => sees(workspace),
                    None => matches!(scope, WorkspaceScope::All),
                }
        }
        FeedFrame::Invalidate {
            entity: FeedEntity::Workspace,
            id,
            workspace_id,
            ..
        } => sees(workspace_id.as_deref().unwrap_or(id)),
        FeedFrame::Invalidate { workspace_id, .. } => workspace_id.as_deref().is_some_and(sees),
    }
}

#[derive(Debug, Clone)]
struct FeedTicket {
    org_id: String,
    claims: GrantClaims,
    expires_at: i64,
}

impl Expiring for FeedTicket {
    fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

/// Per-organisation feed channels and the tickets that open them.
pub struct FeedHub {
    channels: Channels<String, FeedFrame>,
    tickets: TicketBook<FeedTicket>,
}

impl Default for FeedHub {
    fn default() -> Self {
        Self {
            channels: Channels::new(FEED_CHANNEL_CAPACITY),
            tickets: TicketBook::new(FEED_TICKET_PREFIX, MAX_PENDING_FEED_TICKETS),
        }
    }
}

impl FeedHub {
    /// Tell every connected reader in `org_id` that something changed. A
    /// no-op when nobody is connected.
    pub fn publish(&self, org_id: &str, frame: FeedFrame) {
        self.channels.publish(&org_id.to_owned(), frame);
    }

    fn subscribe(&self, org_id: &str) -> broadcast::Receiver<FeedFrame> {
        self.channels.subscribe(&org_id.to_owned())
    }
    /// A raw subscription for handler tests elsewhere in the crate.
    #[cfg(test)]
    pub(crate) fn subscribe_for_test(&self, org_id: &str) -> broadcast::Receiver<FeedFrame> {
        self.subscribe(org_id)
    }
}

/// Publish after a committed write. Handlers call this once the store has
/// returned: announcing a revision before commit could name one that a
/// rolled-back transaction never made.
pub fn publish(state: &AppState, org_id: &str, frame: FeedFrame) {
    if state.feed_enabled {
        state.feed_hub.publish(org_id, frame);
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/orgs/{org_id}/feed/tickets", post(create_ticket))
        .route("/v1/orgs/{org_id}/feed", get(open_feed))
}

#[derive(Debug)]
enum FeedFailure {
    Unauthorized,
    Forbidden,
    /// The ticket was unknown, already spent or expired.
    Gone,
    TicketCapacity,
    Unavailable,
}

impl From<AuthError> for FeedFailure {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Forbidden => Self::Forbidden,
            AuthError::Store(_) => Self::Unavailable,
            _ => Self::Unauthorized,
        }
    }
}

impl IntoResponse for FeedFailure {
    fn into_response(self) -> Response {
        let (status, error) = match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::Gone => (StatusCode::GONE, "ticket expired or already used"),
            Self::TicketCapacity => (StatusCode::TOO_MANY_REQUESTS, "too many pending tickets"),
            Self::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "storage unavailable"),
        };
        (status, Json(serde_json::json!({ "error": error }))).into_response()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketResponse {
    ticket: String,
    expires_at: i64,
}

fn authorization(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
}

/// Mint a feed ticket. Any member of the org may, including a guest recruited
/// into a single workspace; what they then receive is filtered by scope.
async fn create_ticket(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<TicketResponse>, FeedFailure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    // Refuses an outsider holding a grant for an org they have since left.
    readable_scope(state.store.as_ref(), &claims).await?;
    let now = (state.now)();
    let expires_at = now + FEED_TICKET_TTL_MS;
    let ticket = state
        .feed_hub
        .tickets
        .issue(
            FeedTicket {
                org_id,
                claims,
                expires_at,
            },
            now,
        )
        .map_err(|_| FeedFailure::TicketCapacity)?;
    Ok(Json(TicketResponse { ticket, expires_at }))
}

async fn open_feed(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, FeedFailure> {
    let offered = headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let values: Vec<&str> = offered.split(',').map(str::trim).collect();
    if !values.contains(&FEED_SUBPROTOCOL) {
        return Err(FeedFailure::Unauthorized);
    }
    let ticket_value = values
        .iter()
        .find(|value| value.starts_with(FEED_TICKET_PREFIX))
        .ok_or(FeedFailure::Unauthorized)?;
    let ticket = state
        .feed_hub
        .tickets
        .consume(ticket_value, (state.now)())
        .ok_or(FeedFailure::Gone)?;
    if ticket.org_id != org_id {
        return Err(FeedFailure::Forbidden);
    }
    let scope = readable_scope(state.store.as_ref(), &ticket.claims).await?;
    let receiver = state.feed_hub.subscribe(&org_id);
    let opened_at = (state.now)();
    Ok(ws
        .protocols([FEED_SUBPROTOCOL])
        .on_upgrade(move |socket| {
            feed_loop(socket, state, ticket.claims, scope, opened_at, receiver)
        })
        .into_response())
}

/// A reader's cached scope, refreshed on a timer or on its own membership.
struct ReaderScope {
    scope: WorkspaceScope,
    read_at: i64,
}

enum Delivery {
    Send,
    Skip,
    /// The reader lost access to the org; end the stream.
    Close,
}

async fn decide(
    state: &AppState,
    claims: &GrantClaims,
    cached: &mut ReaderScope,
    frame: &FeedFrame,
) -> Delivery {
    let reader = claims.user_id.as_str();
    let now = (state.now)();
    if frame.concerns_membership_of(reader) || now - cached.read_at >= SCOPE_TTL_MS {
        match readable_scope(state.store.as_ref(), claims).await {
            Ok(scope) => {
                cached.scope = scope;
                cached.read_at = now;
            }
            Err(AuthError::Forbidden) => return Delivery::Close,
            // Storage trouble: keep the last known scope rather than widen it
            // or drop the reader; the next frame tries again.
            Err(_) => {}
        }
    }
    if frame_visible(frame, reader, &cached.scope) {
        Delivery::Send
    } else {
        Delivery::Skip
    }
}

async fn feed_loop(
    socket: WebSocket,
    state: AppState,
    claims: GrantClaims,
    scope: WorkspaceScope,
    opened_at: i64,
    mut receiver: broadcast::Receiver<FeedFrame>,
) {
    use futures_util::{SinkExt, StreamExt};

    let (mut sink, mut stream) = socket.split();
    let mut cached = ReaderScope {
        scope,
        read_at: opened_at,
    };
    loop {
        tokio::select! {
            inbound = stream.next() => match inbound {
                // The feed is one-way; axum answers pings. Anything else from
                // the client is ignored, and a close or error ends the stream.
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => continue,
            },
            relayed = receiver.recv() => {
                let frame = match relayed {
                    Ok(frame) => frame,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        send_frame(&mut sink, &FeedFrame::Resync).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                match decide(&state, &claims, &mut cached, &frame).await {
                    Delivery::Send => {
                        if !send_frame(&mut sink, &frame).await {
                            break;
                        }
                    }
                    Delivery::Skip => {}
                    Delivery::Close => break,
                }
            }
        }
    }
    let _ = sink.close().await;
}

async fn send_frame<S>(sink: &mut S, frame: &FeedFrame) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    use futures_util::SinkExt;
    let Ok(text) = serde_json::to_string(frame) else {
        return true;
    };
    sink.send(Message::Text(text.into())).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn only(ids: &[&str]) -> WorkspaceScope {
        WorkspaceScope::Only(ids.iter().map(|id| (*id).to_owned()).collect())
    }

    #[test]
    fn an_invalidation_reaches_only_readers_of_its_workspace() {
        let frame = FeedFrame::invalidate(FeedEntity::Issue, "iss_1", "ws_a", 7);
        assert!(frame_visible(&frame, "usr_1", &only(&["ws_a"])));
        assert!(!frame_visible(&frame, "usr_1", &only(&["ws_b"])));
        assert!(frame_visible(&frame, "usr_1", &WorkspaceScope::All));
    }

    #[test]
    fn an_invalidation_without_a_workspace_reaches_nobody_scoped() {
        let frame = FeedFrame::Invalidate {
            entity: FeedEntity::Plan,
            id: "pln_1".into(),
            workspace_id: None,
            revision: None,
            user_id: None,
        };
        assert!(!frame_visible(&frame, "usr_1", &only(&["ws_a"])));
    }

    #[test]
    fn a_workspace_frame_is_scoped_by_its_own_id() {
        let frame = FeedFrame::Invalidate {
            entity: FeedEntity::Workspace,
            id: "ws_a".into(),
            workspace_id: None,
            revision: None,
            user_id: None,
        };
        assert!(frame_visible(&frame, "usr_1", &only(&["ws_a"])));
        assert!(!frame_visible(&frame, "usr_1", &only(&["ws_b"])));
    }

    #[test]
    fn membership_frames_reach_the_subject_and_readers_of_the_roster() {
        let workspace = FeedFrame::membership("usr_2", Some("ws_a"));
        assert!(
            frame_visible(&workspace, "usr_2", &only(&[])),
            "the subject"
        );
        assert!(
            frame_visible(&workspace, "usr_1", &only(&["ws_a"])),
            "a roster reader"
        );
        assert!(!frame_visible(&workspace, "usr_1", &only(&["ws_b"])));

        let org = FeedFrame::membership("usr_2", None);
        assert!(frame_visible(&org, "usr_2", &only(&[])));
        assert!(
            frame_visible(&org, "usr_1", &WorkspaceScope::All),
            "an admin"
        );
        assert!(!frame_visible(&org, "usr_1", &only(&["ws_a"])));
    }

    #[test]
    fn a_notification_reaches_only_its_recipient() {
        let frame = FeedFrame::Notification {
            recipient_user_id: "usr_2".into(),
            seq: 4,
        };
        assert!(frame_visible(&frame, "usr_2", &only(&[])));
        assert!(!frame_visible(&frame, "usr_1", &WorkspaceScope::All));
    }

    #[test]
    fn resync_reaches_everyone() {
        assert!(frame_visible(&FeedFrame::Resync, "usr_1", &only(&[])));
    }

    #[test]
    fn frames_serialize_in_the_shape_the_client_reads() {
        let frame = FeedFrame::invalidate(FeedEntity::IssueEvent, "iss_1", "ws_a", 3);
        assert_eq!(
            serde_json::to_value(&frame).unwrap(),
            serde_json::json!({
                "kind": "invalidate",
                "entity": "issue_event",
                "id": "iss_1",
                "workspaceId": "ws_a",
                "revision": 3
            })
        );
        assert_eq!(
            serde_json::to_value(FeedFrame::Resync).unwrap(),
            serde_json::json!({ "kind": "resync" })
        );
        assert_eq!(
            serde_json::to_value(FeedFrame::Notification {
                recipient_user_id: "usr_2".into(),
                seq: 9
            })
            .unwrap(),
            serde_json::json!({ "kind": "notification", "recipientUserId": "usr_2", "seq": 9 })
        );
    }

    #[test]
    fn only_membership_frames_about_the_reader_force_a_scope_refresh() {
        assert!(FeedFrame::membership("usr_1", None).concerns_membership_of("usr_1"));
        assert!(!FeedFrame::membership("usr_2", None).concerns_membership_of("usr_1"));
        assert!(
            !FeedFrame::invalidate(FeedEntity::Issue, "i", "w", 1).concerns_membership_of("usr_1")
        );
    }

    #[tokio::test]
    async fn publishing_reaches_subscribers_of_that_org_only() {
        let hub = FeedHub::default();
        let mut a = hub.subscribe("org_a");
        let mut b = hub.subscribe("org_b");
        hub.publish("org_a", FeedFrame::Resync);
        assert_eq!(a.recv().await.unwrap(), FeedFrame::Resync);
        assert!(b.try_recv().is_err());
    }
}
