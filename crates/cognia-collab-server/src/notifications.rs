//! Per-recipient collaboration notifications (ADR-0207).
//!
//! # What a row is
//!
//! One row says "this was addressed to you": an assignment, a declared
//! mention, an approval request, a targeted invitation. It carries references
//! (`{entity, id}`, the actor's `usr_`), never content, so the client resolves
//! the title from its own mirror and a row can never show more than its reader
//! may open.
//!
//! # Written after the change commits, idempotently
//!
//! Handlers call [`deliver`] once the store has returned, the same rule the
//! ADR-0206 feed follows. A notification is a consequence of a write, not part
//! of it: the assignment stands even if telling the assignee fails, and that
//! failure is logged rather than turned into a 500 for a write that happened.
//! Every row has a dedupe key derived from the write (`issue.assigned:<id>:rev<n>`,
//! `issue.mentioned:<event id>`), so a client retrying a write whose response
//! it lost produces the same key and records nothing twice.
//!
//! # Ordering
//!
//! `seq` is per recipient and allocated from that recipient's cursor row under
//! its lock, so their rows commit in `seq` order and a client paging
//! `afterSeq` never skips one that committed late.
//!
//! # Retention
//!
//! Pruned per recipient as their next row is written: read rows after 90 days,
//! every row after 180. Lazy rather than a background sweep, because the table
//! is under FORCE row-level security and a sweep would need a privileged role
//! or a tenant loop; a recipient who receives nothing more keeps a bounded set.

use std::collections::{BTreeSet, HashMap};

use async_trait::async_trait;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use cognia_tenant_auth::membership::resolve_workspace_access;
use cognia_tenant_auth::WorkspaceCapability;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::api::{authorization, AppState, Failure};
use crate::auth::{readable_scope, verify_grant, WorkspaceScope};
use crate::store::{PgStore, StoreError};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// A read row is kept this long after it was created.
pub const READ_RETENTION_MS: i64 = 90 * DAY_MS;
/// Any row, read or not, is kept this long.
pub const UNREAD_RETENTION_MS: i64 = 180 * DAY_MS;
pub const DEFAULT_PAGE: i64 = 100;
pub const MAX_PAGE: i64 = 200;
/// The most ids one `read` call may name.
pub const MAX_READ_IDS: usize = 500;
/// The most people one issue event may mention.
pub const MAX_MENTIONS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum NotificationKind {
    #[serde(rename = "issue.assigned")]
    IssueAssigned,
    #[serde(rename = "issue.mentioned")]
    IssueMentioned,
    #[serde(rename = "chat.approval_requested")]
    ChatApprovalRequested,
    #[serde(rename = "chat.invited")]
    ChatInvited,
}

impl NotificationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IssueAssigned => "issue.assigned",
            Self::IssueMentioned => "issue.mentioned",
            Self::ChatApprovalRequested => "chat.approval_requested",
            Self::ChatInvited => "chat.invited",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "issue.assigned" => Some(Self::IssueAssigned),
            "issue.mentioned" => Some(Self::IssueMentioned),
            "chat.approval_requested" => Some(Self::ChatApprovalRequested),
            "chat.invited" => Some(Self::ChatInvited),
            _ => None,
        }
    }
}

/// The thing a notification opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSubject {
    /// `issue`, `chat_session` or `chat_invite`.
    pub entity: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabNotification {
    pub id: String,
    pub kind: NotificationKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub subject: NotificationSubject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_user_id: Option<String>,
    pub dedupe_key: String,
    pub seq: i64,
    pub created_at: i64,
    pub read_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct NewNotification {
    pub id: String,
    pub org_id: String,
    pub recipient_user_id: String,
    pub workspace_id: Option<String>,
    pub kind: NotificationKind,
    pub subject: NotificationSubject,
    pub actor_user_id: Option<String>,
    pub dedupe_key: String,
    pub created_at: i64,
}

/// Which rows a `read` call marks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadSelector {
    Ids(Vec<String>),
    /// Every row at or below this `seq`: "mark all read" as of what the
    /// client has seen, so a row that arrives meanwhile stays unread.
    UpToSeq(i64),
}

/// One row another device marked read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMark {
    pub id: String,
    pub seq: i64,
    pub read_at: i64,
}

/// Position in a recipient's reads, ordered by `(read_at, seq)`. A single
/// "mark all read" stamps many rows with one instant, so the instant alone
/// cannot be the cursor.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCursor {
    pub at: i64,
    pub seq: i64,
}

impl ReadCursor {
    fn is_before(self, read_at: i64, seq: i64) -> bool {
        (self.at, self.seq) < (read_at, seq)
    }
}

#[async_trait]
pub trait NotificationStore: Send + Sync {
    /// Record one row. Returns it with `true` when it was created, or the row
    /// already stored under the same dedupe key with `false`.
    async fn record(
        &self,
        input: NewNotification,
    ) -> Result<(CollabNotification, bool), StoreError>;

    /// The recipient's rows with `seq > after_seq`, oldest first.
    async fn list(
        &self,
        org_id: &str,
        recipient_user_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<CollabNotification>, StoreError>;

    /// Rows read after `after`, in cursor order.
    async fn list_reads(
        &self,
        org_id: &str,
        recipient_user_id: &str,
        after: ReadCursor,
        limit: i64,
    ) -> Result<Vec<ReadMark>, StoreError>;

    /// Mark unread rows read. Idempotent; returns how many changed.
    async fn mark_read(
        &self,
        org_id: &str,
        recipient_user_id: &str,
        selector: &ReadSelector,
        now: i64,
    ) -> Result<u64, StoreError>;

    /// The recipient's highest allocated `seq`, `0` when they have none.
    async fn latest_seq(&self, org_id: &str, recipient_user_id: &str) -> Result<i64, StoreError>;
}

fn expired(row: &CollabNotification, now: i64) -> bool {
    row.created_at < now - UNREAD_RETENTION_MS
        || (row.read_at.is_some() && row.created_at < now - READ_RETENTION_MS)
}

// ── In-memory ────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Tables {
    /// `(org, recipient) -> rows in seq order`.
    rows: HashMap<(String, String), Vec<CollabNotification>>,
    cursors: HashMap<(String, String), i64>,
}

#[derive(Default)]
pub struct InMemoryNotificationStore {
    tables: RwLock<Tables>,
}

impl InMemoryNotificationStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl NotificationStore for InMemoryNotificationStore {
    async fn record(
        &self,
        input: NewNotification,
    ) -> Result<(CollabNotification, bool), StoreError> {
        let key = (input.org_id.clone(), input.recipient_user_id.clone());
        let mut tables = self.tables.write();
        if let Some(existing) = tables.rows.get(&key).and_then(|rows| {
            rows.iter()
                .find(|row| row.dedupe_key == input.dedupe_key)
                .cloned()
        }) {
            return Ok((existing, false));
        }
        let cursor = tables.cursors.entry(key.clone()).or_insert(0);
        *cursor += 1;
        let row = CollabNotification {
            id: input.id,
            kind: input.kind,
            workspace_id: input.workspace_id,
            subject: input.subject,
            actor_user_id: input.actor_user_id,
            dedupe_key: input.dedupe_key,
            seq: *cursor,
            created_at: input.created_at,
            read_at: None,
        };
        let rows = tables.rows.entry(key).or_default();
        rows.retain(|stored| !expired(stored, input.created_at));
        rows.push(row.clone());
        Ok((row, true))
    }

    async fn list(
        &self,
        org_id: &str,
        recipient_user_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<CollabNotification>, StoreError> {
        let tables = self.tables.read();
        Ok(tables
            .rows
            .get(&(org_id.to_owned(), recipient_user_id.to_owned()))
            .map(|rows| {
                rows.iter()
                    .filter(|row| row.seq > after_seq)
                    .take(limit.max(0) as usize)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn list_reads(
        &self,
        org_id: &str,
        recipient_user_id: &str,
        after: ReadCursor,
        limit: i64,
    ) -> Result<Vec<ReadMark>, StoreError> {
        let tables = self.tables.read();
        let mut reads: Vec<ReadMark> = tables
            .rows
            .get(&(org_id.to_owned(), recipient_user_id.to_owned()))
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let read_at = row.read_at?;
                        after.is_before(read_at, row.seq).then(|| ReadMark {
                            id: row.id.clone(),
                            seq: row.seq,
                            read_at,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        reads.sort_by_key(|read| (read.read_at, read.seq));
        reads.truncate(limit.max(0) as usize);
        Ok(reads)
    }

    async fn mark_read(
        &self,
        org_id: &str,
        recipient_user_id: &str,
        selector: &ReadSelector,
        now: i64,
    ) -> Result<u64, StoreError> {
        let mut tables = self.tables.write();
        let Some(rows) = tables
            .rows
            .get_mut(&(org_id.to_owned(), recipient_user_id.to_owned()))
        else {
            return Ok(0);
        };
        let mut marked = 0;
        for row in rows.iter_mut().filter(|row| row.read_at.is_none()) {
            let selected = match selector {
                ReadSelector::Ids(ids) => ids.iter().any(|id| id == &row.id),
                ReadSelector::UpToSeq(seq) => row.seq <= *seq,
            };
            if selected {
                row.read_at = Some(now);
                marked += 1;
            }
        }
        Ok(marked)
    }

    async fn latest_seq(&self, org_id: &str, recipient_user_id: &str) -> Result<i64, StoreError> {
        Ok(self
            .tables
            .read()
            .cursors
            .get(&(org_id.to_owned(), recipient_user_id.to_owned()))
            .copied()
            .unwrap_or(0))
    }
}

// ── Postgres ─────────────────────────────────────────────────────────────────

const COLUMNS: &str = "id, kind, workspace_id, subject_entity, subject_id, actor_user_id, \
                       dedupe_key, seq, created_at, read_at";

fn db(error: impl std::fmt::Display) -> StoreError {
    StoreError::Database(error.to_string())
}

fn from_row(row: &tokio_postgres::Row) -> Result<CollabNotification, StoreError> {
    let kind: String = row.get("kind");
    Ok(CollabNotification {
        id: row.get("id"),
        kind: NotificationKind::parse(&kind)
            .ok_or_else(|| StoreError::Corrupt(format!("notification kind {kind}")))?,
        workspace_id: row.get("workspace_id"),
        subject: NotificationSubject {
            entity: row.get("subject_entity"),
            id: row.get("subject_id"),
        },
        actor_user_id: row.get("actor_user_id"),
        dedupe_key: row.get("dedupe_key"),
        seq: row.get("seq"),
        created_at: row.get("created_at"),
        read_at: row.get("read_at"),
    })
}

#[async_trait]
impl NotificationStore for PgStore {
    async fn record(
        &self,
        input: NewNotification,
    ) -> Result<(CollabNotification, bool), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        tx.execute(
            "INSERT INTO collab_notification_cursors (org_id, recipient_user_id, last_seq) \
             VALUES ($1, $2, 0) ON CONFLICT (org_id, recipient_user_id) DO NOTHING",
            &[&input.org_id, &input.recipient_user_id],
        )
        .await
        .map_err(db)?;
        // The cursor row's lock serialises this recipient's writers, so the
        // dedupe check and the seq allocation below see one another.
        let last_seq: i64 = tx
            .query_one(
                "SELECT last_seq FROM collab_notification_cursors \
                 WHERE org_id = $1 AND recipient_user_id = $2 FOR UPDATE",
                &[&input.org_id, &input.recipient_user_id],
            )
            .await
            .map_err(db)?
            .get(0);
        if let Some(row) = tx
            .query_opt(
                &format!(
                    "SELECT {COLUMNS} FROM collab_notifications \
                     WHERE org_id = $1 AND recipient_user_id = $2 AND dedupe_key = $3"
                ),
                &[&input.org_id, &input.recipient_user_id, &input.dedupe_key],
            )
            .await
            .map_err(db)?
        {
            tx.commit().await.map_err(db)?;
            return Ok((from_row(&row)?, false));
        }
        let seq = last_seq + 1;
        let row = tx
            .query_one(
                &format!(
                    "INSERT INTO collab_notifications \
                     (id, org_id, recipient_user_id, workspace_id, kind, subject_entity, \
                      subject_id, actor_user_id, dedupe_key, seq, created_at) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING {COLUMNS}"
                ),
                &[
                    &input.id,
                    &input.org_id,
                    &input.recipient_user_id,
                    &input.workspace_id,
                    &input.kind.as_str(),
                    &input.subject.entity,
                    &input.subject.id,
                    &input.actor_user_id,
                    &input.dedupe_key,
                    &seq,
                    &input.created_at,
                ],
            )
            .await
            .map_err(db)?;
        tx.execute(
            "UPDATE collab_notification_cursors SET last_seq = $3 \
             WHERE org_id = $1 AND recipient_user_id = $2",
            &[&input.org_id, &input.recipient_user_id, &seq],
        )
        .await
        .map_err(db)?;
        tx.execute(
            "DELETE FROM collab_notifications WHERE org_id = $1 AND recipient_user_id = $2 \
             AND (created_at < $3 OR (read_at IS NOT NULL AND created_at < $4))",
            &[
                &input.org_id,
                &input.recipient_user_id,
                &(input.created_at - UNREAD_RETENTION_MS),
                &(input.created_at - READ_RETENTION_MS),
            ],
        )
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok((from_row(&row)?, true))
    }

    async fn list(
        &self,
        org_id: &str,
        recipient_user_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<CollabNotification>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                &format!(
                    "SELECT {COLUMNS} FROM collab_notifications \
                     WHERE org_id = $1 AND recipient_user_id = $2 AND seq > $3 \
                     ORDER BY seq ASC LIMIT $4"
                ),
                &[&org_id, &recipient_user_id, &after_seq, &limit],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        rows.iter().map(from_row).collect()
    }

    async fn list_reads(
        &self,
        org_id: &str,
        recipient_user_id: &str,
        after: ReadCursor,
        limit: i64,
    ) -> Result<Vec<ReadMark>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                "SELECT id, seq, read_at FROM collab_notifications \
                 WHERE org_id = $1 AND recipient_user_id = $2 AND read_at IS NOT NULL \
                   AND (read_at, seq) > ($3, $4) \
                 ORDER BY read_at ASC, seq ASC LIMIT $5",
                &[&org_id, &recipient_user_id, &after.at, &after.seq, &limit],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(rows
            .iter()
            .map(|row| ReadMark {
                id: row.get("id"),
                seq: row.get("seq"),
                read_at: row.get("read_at"),
            })
            .collect())
    }

    async fn mark_read(
        &self,
        org_id: &str,
        recipient_user_id: &str,
        selector: &ReadSelector,
        now: i64,
    ) -> Result<u64, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let marked = match selector {
            ReadSelector::Ids(ids) => tx
                .execute(
                    "UPDATE collab_notifications SET read_at = $3 \
                     WHERE org_id = $1 AND recipient_user_id = $2 AND read_at IS NULL \
                       AND id = ANY($4)",
                    &[&org_id, &recipient_user_id, &now, ids],
                )
                .await
                .map_err(db)?,
            ReadSelector::UpToSeq(seq) => tx
                .execute(
                    "UPDATE collab_notifications SET read_at = $3 \
                     WHERE org_id = $1 AND recipient_user_id = $2 AND read_at IS NULL \
                       AND seq <= $4",
                    &[&org_id, &recipient_user_id, &now, seq],
                )
                .await
                .map_err(db)?,
        };
        tx.commit().await.map_err(db)?;
        Ok(marked)
    }

    async fn latest_seq(&self, org_id: &str, recipient_user_id: &str) -> Result<i64, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let seq = tx
            .query_opt(
                "SELECT last_seq FROM collab_notification_cursors \
                 WHERE org_id = $1 AND recipient_user_id = $2",
                &[&org_id, &recipient_user_id],
            )
            .await
            .map_err(db)?
            .map(|row| row.get::<_, i64>(0))
            .unwrap_or(0);
        tx.commit().await.map_err(db)?;
        Ok(seq)
    }
}

// ── Producing ────────────────────────────────────────────────────────────────

/// One person a committed write was addressed to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub recipient_user_id: String,
    pub kind: NotificationKind,
    pub subject: NotificationSubject,
    pub dedupe_key: String,
}

impl Draft {
    pub fn issue(
        recipient: &str,
        kind: NotificationKind,
        issue_id: &str,
        dedupe_key: String,
    ) -> Self {
        Self {
            recipient_user_id: recipient.to_owned(),
            kind,
            subject: NotificationSubject {
                entity: "issue".into(),
                id: issue_id.to_owned(),
            },
            dedupe_key,
        }
    }

    pub fn chat_session(
        recipient: &str,
        kind: NotificationKind,
        session_id: &str,
        dedupe_key: String,
    ) -> Self {
        Self {
            recipient_user_id: recipient.to_owned(),
            kind,
            subject: NotificationSubject {
                entity: "chat_session".into(),
                id: session_id.to_owned(),
            },
            dedupe_key,
        }
    }

    /// An invite is its own subject: accepting it needs its id, and the
    /// acceptance answers with the session it opens.
    pub fn chat_invite(recipient: &str, invite_id: &str) -> Self {
        Self {
            recipient_user_id: recipient.to_owned(),
            kind: NotificationKind::ChatInvited,
            subject: NotificationSubject {
                entity: "chat_invite".into(),
                id: invite_id.to_owned(),
            },
            dedupe_key: format!("chat.invited:{invite_id}"),
        }
    }
}

/// Drop the actor's own drafts and repeats of one recipient, keeping order.
pub fn addressees(actor_user_id: &str, drafts: Vec<Draft>) -> Vec<Draft> {
    let mut seen = BTreeSet::new();
    drafts
        .into_iter()
        .filter(|draft| draft.recipient_user_id != actor_user_id)
        .filter(|draft| seen.insert(draft.recipient_user_id.clone()))
        .collect()
}

/// Whether `user_id` may read `workspace_id` right now, by the same resolver
/// every route uses. A failed lookup reads as "no": telling nobody is the
/// safe side of a membership question this function cannot answer.
async fn may_read(state: &AppState, org_id: &str, user_id: &str, workspace_id: &str) -> bool {
    match state
        .store
        .membership(org_id, user_id, Some(workspace_id))
        .await
    {
        Ok(membership) => resolve_workspace_access(membership.org_role, membership.workspace_role)
            .is_some_and(|access| access.allows(WorkspaceCapability::Read)),
        Err(error) => {
            tracing::warn!(%error, "notification access check failed; not delivering");
            false
        }
    }
}

/// Record and announce a committed write's notifications. Never fails the
/// caller: see the module header.
pub async fn deliver(
    state: &AppState,
    org_id: &str,
    workspace_id: &str,
    actor_user_id: &str,
    drafts: Vec<Draft>,
) {
    for draft in addressees(actor_user_id, drafts) {
        // Telling someone about a thing they cannot open leaks that it exists
        // and what it is called.
        if !may_read(state, org_id, &draft.recipient_user_id, workspace_id).await {
            continue;
        }
        let recorded = state
            .notification_store
            .record(NewNotification {
                id: format!("ntf_{}", Uuid::new_v4().simple()),
                org_id: org_id.to_owned(),
                recipient_user_id: draft.recipient_user_id.clone(),
                workspace_id: Some(workspace_id.to_owned()),
                kind: draft.kind,
                subject: draft.subject,
                actor_user_id: Some(actor_user_id.to_owned()),
                dedupe_key: draft.dedupe_key,
                created_at: (state.now)(),
            })
            .await;
        match recorded {
            Ok((row, true)) => crate::feed::publish(
                state,
                org_id,
                crate::feed::FeedFrame::Notification {
                    recipient_user_id: draft.recipient_user_id,
                    seq: row.seq,
                },
            ),
            Ok((_, false)) => {}
            Err(error) => {
                tracing::warn!(%error, kind = draft.kind.as_str(), "notification not recorded");
            }
        }
    }
}

/// The `mentions` an issue event declares: absent is none, anything other
/// than an array of `usr_` strings is refused, repeats collapse.
pub fn declared_mentions(payload: &serde_json::Value) -> Result<Vec<String>, String> {
    let Some(value) = payload.get("mentions") else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| "mentions must be a list of user ids".to_owned())?;
    let mut seen = BTreeSet::new();
    let mut mentions = Vec::new();
    for item in items {
        let id = item
            .as_str()
            .filter(|id| id.starts_with("usr_") && id.len() > 4)
            .ok_or_else(|| "mentions must be a list of user ids".to_owned())?;
        if seen.insert(id.to_owned()) {
            mentions.push(id.to_owned());
        }
    }
    if mentions.len() > MAX_MENTIONS {
        return Err(format!(
            "an event may mention at most {MAX_MENTIONS} people"
        ));
    }
    Ok(mentions)
}

// ── Routes ───────────────────────────────────────────────────────────────────

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/orgs/{org_id}/notifications", get(list_notifications))
        .route(
            "/v1/orgs/{org_id}/notifications/read",
            post(mark_notifications_read),
        )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    #[serde(default)]
    after_seq: i64,
    limit: Option<i64>,
    #[serde(default)]
    read_at: i64,
    #[serde(default)]
    read_seq: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResponse {
    notifications: Vec<CollabNotification>,
    /// Where the next pull starts. Past every row this page covered,
    /// including any withheld because the reader lost the workspace.
    next_after_seq: i64,
    has_more: bool,
    reads: Vec<ReadMark>,
    read_cursor: ReadCursor,
    reads_have_more: bool,
}

async fn list_notifications(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    Query(params): Query<ListParams>,
    headers: HeaderMap,
) -> Result<Json<ListResponse>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    // Also the membership check: someone removed from the org reads nothing.
    let scope = readable_scope(state.store.as_ref(), &claims).await?;
    let reader = claims.user_id.as_str();
    let limit = params.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let after_seq = params.after_seq.max(0);

    let mut rows = state
        .notification_store
        .list(&org_id, reader, after_seq, limit + 1)
        .await?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next_after_seq = rows.last().map_or(after_seq, |row| row.seq);
    // A row stays, but is not shown, once its reader can no longer open it.
    rows.retain(|row| match (&scope, row.workspace_id.as_deref()) {
        (WorkspaceScope::All, _) | (_, None) => true,
        (WorkspaceScope::Only(ids), Some(workspace)) => ids.iter().any(|id| id == workspace),
    });

    let after = ReadCursor {
        at: params.read_at,
        seq: params.read_seq,
    };
    let mut reads = state
        .notification_store
        .list_reads(&org_id, reader, after, MAX_PAGE + 1)
        .await?;
    let reads_have_more = reads.len() as i64 > MAX_PAGE;
    reads.truncate(MAX_PAGE as usize);
    let read_cursor = reads.last().map_or(after, |read| ReadCursor {
        at: read.read_at,
        seq: read.seq,
    });

    Ok(Json(ListResponse {
        notifications: rows,
        next_after_seq,
        has_more,
        reads,
        read_cursor,
        reads_have_more,
    }))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadBody {
    ids: Option<Vec<String>>,
    up_to_seq: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadResponse {
    marked: u64,
}

fn read_selector(body: ReadBody) -> Result<ReadSelector, Failure> {
    match (body.ids, body.up_to_seq) {
        (Some(ids), None) if !ids.is_empty() && ids.len() <= MAX_READ_IDS => {
            Ok(ReadSelector::Ids(ids))
        }
        (None, Some(seq)) if seq >= 0 => Ok(ReadSelector::UpToSeq(seq)),
        _ => Err(Failure::BadRequest(format!(
            "name either 1 to {MAX_READ_IDS} ids or an upToSeq, not both"
        ))),
    }
}

async fn mark_notifications_read(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<ReadBody>,
) -> Result<Json<ReadResponse>, Failure> {
    let selector = read_selector(body)?;
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    readable_scope(state.store.as_ref(), &claims).await?;
    let reader = claims.user_id.as_str();
    let marked = state
        .notification_store
        .mark_read(&org_id, reader, &selector, (state.now)())
        .await?;
    if marked > 0 {
        // The reader's other devices pull on this and learn about the reads.
        let seq = state.notification_store.latest_seq(&org_id, reader).await?;
        crate::feed::publish(
            &state,
            &org_id,
            crate::feed::FeedFrame::Notification {
                recipient_user_id: reader.to_owned(),
                seq,
            },
        );
    }
    Ok(Json(ReadResponse { marked }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(recipient: &str, dedupe: &str, at: i64) -> NewNotification {
        NewNotification {
            id: format!("ntf_{dedupe}"),
            org_id: "org_1".into(),
            recipient_user_id: recipient.into(),
            workspace_id: Some("ws_1".into()),
            kind: NotificationKind::IssueAssigned,
            subject: NotificationSubject {
                entity: "issue".into(),
                id: "iss_1".into(),
            },
            actor_user_id: Some("usr_actor".into()),
            dedupe_key: dedupe.into(),
            created_at: at,
        }
    }

    #[tokio::test]
    async fn seq_is_per_recipient_and_a_repeated_key_records_nothing() {
        let store = InMemoryNotificationStore::new();
        let (a1, created) = store.record(new("usr_a", "k1", 10)).await.unwrap();
        assert!(created);
        let (a2, _) = store.record(new("usr_a", "k2", 11)).await.unwrap();
        let (b1, _) = store.record(new("usr_b", "k1", 12)).await.unwrap();
        assert_eq!((a1.seq, a2.seq, b1.seq), (1, 2, 1));

        let (again, created) = store.record(new("usr_a", "k1", 13)).await.unwrap();
        assert!(!created);
        assert_eq!(again.id, a1.id);
        assert_eq!(store.latest_seq("org_1", "usr_a").await.unwrap(), 2);
    }

    #[tokio::test]
    async fn listing_pages_by_seq_and_never_crosses_recipients() {
        let store = InMemoryNotificationStore::new();
        for key in ["k1", "k2", "k3"] {
            store.record(new("usr_a", key, 1)).await.unwrap();
        }
        store.record(new("usr_b", "k9", 1)).await.unwrap();
        let page = store.list("org_1", "usr_a", 1, 1).await.unwrap();
        assert_eq!(page.iter().map(|row| row.seq).collect::<Vec<_>>(), vec![2]);
        assert_eq!(store.list("org_1", "usr_a", 0, 10).await.unwrap().len(), 3);
        assert!(store
            .list("org_2", "usr_a", 0, 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn reads_are_idempotent_and_pulled_by_read_cursor() {
        let store = InMemoryNotificationStore::new();
        for key in ["k1", "k2", "k3"] {
            store.record(new("usr_a", key, 1)).await.unwrap();
        }
        let up_to_two = ReadSelector::UpToSeq(2);
        assert_eq!(
            store
                .mark_read("org_1", "usr_a", &up_to_two, 50)
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            store
                .mark_read("org_1", "usr_a", &up_to_two, 60)
                .await
                .unwrap(),
            0
        );
        let by_id = ReadSelector::Ids(vec!["ntf_k3".into()]);
        assert_eq!(
            store.mark_read("org_1", "usr_a", &by_id, 50).await.unwrap(),
            1
        );
        // Someone else's ids mark nothing of theirs.
        assert_eq!(
            store.mark_read("org_1", "usr_b", &by_id, 70).await.unwrap(),
            0
        );

        // Three rows share one instant; a page of two must not lose the third.
        let first = store
            .list_reads("org_1", "usr_a", ReadCursor::default(), 2)
            .await
            .unwrap();
        assert_eq!(first.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
        let cursor = ReadCursor {
            at: first[1].read_at,
            seq: first[1].seq,
        };
        let rest = store.list_reads("org_1", "usr_a", cursor, 2).await.unwrap();
        assert_eq!(rest.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![3]);
    }

    #[tokio::test]
    async fn old_rows_are_pruned_as_the_recipient_receives_more() {
        let store = InMemoryNotificationStore::new();
        store.record(new("usr_a", "old_read", 0)).await.unwrap();
        store.record(new("usr_a", "old_unread", 0)).await.unwrap();
        store
            .mark_read(
                "org_1",
                "usr_a",
                &ReadSelector::Ids(vec!["ntf_old_read".into()]),
                1,
            )
            .await
            .unwrap();
        // Past the read retention: the read row goes, the unread one stays.
        store
            .record(new("usr_a", "k1", READ_RETENTION_MS + 1))
            .await
            .unwrap();
        let keys: Vec<String> = store
            .list("org_1", "usr_a", 0, 10)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.dedupe_key)
            .collect();
        assert_eq!(keys, vec!["old_unread", "k1"]);
        // Past the unread retention: everything that old goes.
        store
            .record(new("usr_a", "k2", UNREAD_RETENTION_MS + 1))
            .await
            .unwrap();
        let keys: Vec<String> = store
            .list("org_1", "usr_a", 0, 10)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.dedupe_key)
            .collect();
        assert_eq!(keys, vec!["k1", "k2"]);
        // A pruned row's seq is never reused.
        assert_eq!(store.latest_seq("org_1", "usr_a").await.unwrap(), 4);
    }

    #[test]
    fn the_actor_and_repeats_are_not_addressed() {
        let draft = |who: &str| {
            Draft::issue(
                who,
                NotificationKind::IssueMentioned,
                "iss_1",
                format!("k:{who}"),
            )
        };
        let kept = addressees(
            "usr_me",
            vec![
                draft("usr_a"),
                draft("usr_me"),
                draft("usr_b"),
                draft("usr_a"),
            ],
        );
        assert_eq!(
            kept.iter()
                .map(|d| d.recipient_user_id.as_str())
                .collect::<Vec<_>>(),
            vec!["usr_a", "usr_b"]
        );
    }

    #[test]
    fn mentions_are_declared_ids_only() {
        let parse = |value: serde_json::Value| declared_mentions(&value);
        assert_eq!(parse(serde_json::json!({ "body": "hi" })), Ok(vec![]));
        assert_eq!(
            parse(serde_json::json!({ "mentions": ["usr_a", "usr_b", "usr_a"] })),
            Ok(vec!["usr_a".to_owned(), "usr_b".to_owned()])
        );
        assert!(parse(serde_json::json!({ "mentions": "usr_a" })).is_err());
        assert!(parse(serde_json::json!({ "mentions": ["@alice"] })).is_err());
        assert!(parse(serde_json::json!({ "mentions": [1] })).is_err());
        let many: Vec<String> = (0..=MAX_MENTIONS).map(|i| format!("usr_{i}")).collect();
        assert!(parse(serde_json::json!({ "mentions": many })).is_err());
    }

    #[test]
    fn a_read_names_ids_or_a_seq_but_not_both() {
        let body = |ids: Option<Vec<&str>>, up_to_seq: Option<i64>| ReadBody {
            ids: ids.map(|ids| ids.into_iter().map(str::to_owned).collect()),
            up_to_seq,
        };
        assert!(read_selector(body(Some(vec!["ntf_1"]), None)).is_ok());
        assert!(read_selector(body(None, Some(4))).is_ok());
        assert!(read_selector(body(Some(vec!["ntf_1"]), Some(4))).is_err());
        assert!(read_selector(body(None, None)).is_err());
        assert!(read_selector(body(Some(vec![]), None)).is_err());
        assert!(read_selector(body(None, Some(-1))).is_err());
        let too_many: Vec<&str> = vec!["ntf_x"; MAX_READ_IDS + 1];
        assert!(read_selector(body(Some(too_many), None)).is_err());
    }

    #[test]
    fn kinds_round_trip_through_their_wire_names() {
        for kind in [
            NotificationKind::IssueAssigned,
            NotificationKind::IssueMentioned,
            NotificationKind::ChatApprovalRequested,
            NotificationKind::ChatInvited,
        ] {
            assert_eq!(NotificationKind::parse(kind.as_str()), Some(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        assert_eq!(NotificationKind::parse("org.invited"), None);
    }
}
