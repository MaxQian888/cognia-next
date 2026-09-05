//! Storage for Canvas documents, their update log, comments and versions.
//!
//! # The update log is append-only, and the server never reads inside it
//!
//! `payload` is an opaque Yjs update. This module orders the writes, hands
//! them back in order, and refuses a duplicate operation id. It never decodes
//! one, which is why no CRDT library is linked into the server at all.
//!
//! Ordering is a convenience rather than a correctness requirement. Yjs
//! updates commute, so a client that applies them in any order converges on
//! the same document. The sequence exists so a returning client can say "I
//! have everything up to 41" and be sent 42 onward instead of the whole
//! history.
//!
//! # Idempotence is the offline queue's whole safety story
//!
//! A client that edits while disconnected keeps its updates in a local queue
//! and drains it on reconnect. A drain that is interrupted halfway leaves the
//! client unsure which writes landed, and the honest recovery is to send them
//! all again. `(document_id, operation_id)` is unique, so the second attempt
//! is a no-op that returns the row already stored rather than a second copy of
//! the edit.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;

use crate::canvas::{
    CanvasCommentRecord, CanvasDocumentRecord, CanvasUpdateRecord, CanvasVersionRecord,
};
use crate::store::{PgStore, StoreError};

/// The largest single Yjs update the plane accepts, matching the CHECK
/// constraint in migration 0010. A legitimate keystroke-level update is a few
/// dozen bytes, and a whole-document snapshot for a large file is well under
/// this, so the cap only catches a client trying to use the log as storage.
pub const MAX_UPDATE_BYTES: usize = 1_048_576;

#[derive(Debug, Clone)]
pub struct NewCanvasDocument {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub title: String,
    pub language: String,
    pub created_by_user_id: String,
    pub created_at: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone)]
pub struct NewCanvasUpdate {
    pub org_id: String,
    pub document_id: String,
    /// Raw bytes. The API layer decodes the base64 before it gets here, so an
    /// undecodable payload is rejected as a bad request rather than stored.
    pub payload: Vec<u8>,
    pub author_user_id: String,
    pub created_at: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone)]
pub struct NewCanvasSnapshot {
    pub org_id: String,
    pub document_id: String,
    pub payload: Vec<u8>,
    /// The highest update sequence this snapshot already contains. Updates at
    /// or below it become redundant.
    pub covers_sequence: i64,
    pub now: i64,
}

/// A rename, as one value rather than five positional arguments.
#[derive(Debug, Clone)]
pub struct RenameCanvasDocument {
    pub org_id: String,
    pub document_id: String,
    /// `None` leaves the field alone, which is what lets a language change and
    /// a title change use one route without either clearing the other.
    pub title: Option<String>,
    pub language: Option<String>,
    pub base_revision: i64,
    pub operation_id: String,
    pub now: i64,
}

#[derive(Debug, Clone)]
pub struct NewCanvasComment {
    pub id: String,
    pub org_id: String,
    pub document_id: String,
    pub anchor: String,
    pub head: Option<String>,
    pub body: String,
    pub author_user_id: String,
    pub created_at: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone)]
pub struct NewCanvasVersion {
    pub id: String,
    pub org_id: String,
    pub document_id: String,
    pub label: String,
    pub content: String,
    pub author_user_id: String,
    pub created_at: i64,
    pub operation_id: String,
}

/// Everything a joining client needs to reach the current document state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasCatchUp {
    /// The baseline, base64, when the caller is behind it. `None` when the
    /// caller already holds a sequence at or past the snapshot, in which case
    /// the updates alone are enough.
    pub snapshot: Option<String>,
    pub snapshot_sequence: i64,
    pub updates: Vec<CanvasUpdateRecord>,
    pub latest_sequence: i64,
}

#[async_trait]
pub trait CanvasStore: Send + Sync {
    async fn create_document(
        &self,
        input: NewCanvasDocument,
    ) -> Result<CanvasDocumentRecord, StoreError>;

    async fn list_documents(
        &self,
        org_id: &str,
        workspace_id: &str,
    ) -> Result<Vec<CanvasDocumentRecord>, StoreError>;

    /// One document, or [`StoreError::NotFound`].
    ///
    /// Takes the workspace as well as the id: a caller authorized for one
    /// workspace must not be able to read another's document by naming it,
    /// and checking that here means no route can forget to.
    async fn get_document(
        &self,
        org_id: &str,
        workspace_id: &str,
        document_id: &str,
    ) -> Result<CanvasDocumentRecord, StoreError>;

    /// Which workspace a document belongs to, for the routes that hold an id
    /// and have to resolve the workspace before they can authorize at all.
    async fn document_workspace(
        &self,
        org_id: &str,
        document_id: &str,
    ) -> Result<String, StoreError>;

    async fn rename_document(
        &self,
        input: RenameCanvasDocument,
    ) -> Result<CanvasDocumentRecord, StoreError>;

    async fn delete_document(&self, org_id: &str, document_id: &str) -> Result<(), StoreError>;

    /// Append one update, or return the one already stored under this
    /// operation id.
    async fn append_update(&self, input: NewCanvasUpdate)
        -> Result<CanvasUpdateRecord, StoreError>;

    async fn catch_up(
        &self,
        org_id: &str,
        document_id: &str,
        since_sequence: i64,
        limit: i64,
    ) -> Result<CanvasCatchUp, StoreError>;

    async fn store_snapshot(
        &self,
        input: NewCanvasSnapshot,
    ) -> Result<CanvasDocumentRecord, StoreError>;

    async fn create_comment(
        &self,
        input: NewCanvasComment,
    ) -> Result<CanvasCommentRecord, StoreError>;

    async fn list_comments(
        &self,
        org_id: &str,
        document_id: &str,
    ) -> Result<Vec<CanvasCommentRecord>, StoreError>;

    async fn update_comment(
        &self,
        org_id: &str,
        document_id: &str,
        comment_id: &str,
        body: Option<&str>,
        resolved: Option<bool>,
        now: i64,
    ) -> Result<CanvasCommentRecord, StoreError>;

    async fn delete_comment(
        &self,
        org_id: &str,
        document_id: &str,
        comment_id: &str,
    ) -> Result<(), StoreError>;

    async fn create_version(
        &self,
        input: NewCanvasVersion,
    ) -> Result<CanvasVersionRecord, StoreError>;

    async fn list_versions(
        &self,
        org_id: &str,
        document_id: &str,
    ) -> Result<Vec<CanvasVersionRecord>, StoreError>;
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

#[derive(Default)]
struct MemoryDocument {
    record: CanvasDocumentRecord,
    snapshot: Option<Vec<u8>>,
    updates: Vec<(CanvasUpdateRecord, Vec<u8>)>,
    comments: Vec<CanvasCommentRecord>,
    versions: Vec<CanvasVersionRecord>,
}

impl Default for CanvasDocumentRecord {
    fn default() -> Self {
        Self {
            id: String::new(),
            org_id: String::new(),
            workspace_id: String::new(),
            title: String::new(),
            language: String::new(),
            created_by_user_id: String::new(),
            created_at: 0,
            updated_at: 0,
            revision: 1,
            latest_sequence: 0,
            snapshot_sequence: 0,
        }
    }
}

#[derive(Default)]
pub struct InMemoryCanvasStore {
    documents: Arc<RwLock<HashMap<String, MemoryDocument>>>,
}

impl InMemoryCanvasStore {
    pub fn new() -> Self {
        Self::default()
    }
}

fn encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Decode a base64 payload from a client.
///
/// Returns `None` for anything that is not base64 or is outside the size the
/// schema accepts, so the API can answer 422 instead of letting the database
/// raise a constraint violation that reads as a server fault.
pub fn decode_payload(value: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .ok()?;
    if bytes.is_empty() || bytes.len() > MAX_UPDATE_BYTES {
        return None;
    }
    Some(bytes)
}

fn conflict(record: &CanvasDocumentRecord) -> StoreError {
    StoreError::Conflict(serde_json::to_value(record).unwrap_or_default())
}

#[async_trait]
impl CanvasStore for InMemoryCanvasStore {
    async fn create_document(
        &self,
        input: NewCanvasDocument,
    ) -> Result<CanvasDocumentRecord, StoreError> {
        let mut documents = self.documents.write();
        if let Some(existing) = documents.values().find(|doc| {
            doc.record.org_id == input.org_id
                && doc.record.created_by_user_id == input.created_by_user_id
                && doc.record.id == input.id
        }) {
            return Ok(existing.record.clone());
        }
        let record = CanvasDocumentRecord {
            id: input.id.clone(),
            org_id: input.org_id,
            workspace_id: input.workspace_id,
            title: input.title,
            language: input.language,
            created_by_user_id: input.created_by_user_id,
            created_at: input.created_at,
            updated_at: input.created_at,
            revision: 1,
            latest_sequence: 0,
            snapshot_sequence: 0,
        };
        documents.insert(
            input.id,
            MemoryDocument {
                record: record.clone(),
                ..Default::default()
            },
        );
        Ok(record)
    }

    async fn list_documents(
        &self,
        org_id: &str,
        workspace_id: &str,
    ) -> Result<Vec<CanvasDocumentRecord>, StoreError> {
        let documents = self.documents.read();
        let mut rows: Vec<CanvasDocumentRecord> = documents
            .values()
            .filter(|doc| doc.record.org_id == org_id && doc.record.workspace_id == workspace_id)
            .map(|doc| doc.record.clone())
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        Ok(rows)
    }

    async fn get_document(
        &self,
        org_id: &str,
        workspace_id: &str,
        document_id: &str,
    ) -> Result<CanvasDocumentRecord, StoreError> {
        let documents = self.documents.read();
        documents
            .get(document_id)
            .filter(|doc| doc.record.org_id == org_id && doc.record.workspace_id == workspace_id)
            .map(|doc| doc.record.clone())
            .ok_or(StoreError::NotFound)
    }

    async fn document_workspace(
        &self,
        org_id: &str,
        document_id: &str,
    ) -> Result<String, StoreError> {
        let documents = self.documents.read();
        documents
            .get(document_id)
            .filter(|doc| doc.record.org_id == org_id)
            .map(|doc| doc.record.workspace_id.clone())
            .ok_or(StoreError::NotFound)
    }

    async fn rename_document(
        &self,
        input: RenameCanvasDocument,
    ) -> Result<CanvasDocumentRecord, StoreError> {
        let mut documents = self.documents.write();
        let doc = documents
            .get_mut(&input.document_id)
            .filter(|doc| doc.record.org_id == input.org_id)
            .ok_or(StoreError::NotFound)?;
        if doc.record.revision != input.base_revision {
            return Err(conflict(&doc.record));
        }
        if let Some(title) = input.title {
            doc.record.title = title;
        }
        if let Some(language) = input.language {
            doc.record.language = language;
        }
        doc.record.revision += 1;
        doc.record.updated_at = input.now;
        Ok(doc.record.clone())
    }

    async fn delete_document(&self, org_id: &str, document_id: &str) -> Result<(), StoreError> {
        let mut documents = self.documents.write();
        match documents.get(document_id) {
            Some(doc) if doc.record.org_id == org_id => {
                documents.remove(document_id);
                Ok(())
            }
            _ => Err(StoreError::NotFound),
        }
    }

    async fn append_update(
        &self,
        input: NewCanvasUpdate,
    ) -> Result<CanvasUpdateRecord, StoreError> {
        if input.payload.is_empty() || input.payload.len() > MAX_UPDATE_BYTES {
            return Err(StoreError::Policy("update payload out of range".into()));
        }
        let mut documents = self.documents.write();
        let doc = documents
            .get_mut(&input.document_id)
            .filter(|doc| doc.record.org_id == input.org_id)
            .ok_or(StoreError::NotFound)?;
        if let Some((existing, _)) = doc
            .updates
            .iter()
            .find(|(update, _)| update.operation_id == input.operation_id)
        {
            return Ok(existing.clone());
        }
        let sequence = doc.record.latest_sequence + 1;
        let record = CanvasUpdateRecord {
            document_id: input.document_id,
            sequence,
            payload: encode(&input.payload),
            author_user_id: input.author_user_id,
            created_at: input.created_at,
            operation_id: input.operation_id,
        };
        doc.updates.push((record.clone(), input.payload));
        doc.record.latest_sequence = sequence;
        doc.record.updated_at = input.created_at;
        Ok(record)
    }

    async fn catch_up(
        &self,
        org_id: &str,
        document_id: &str,
        since_sequence: i64,
        limit: i64,
    ) -> Result<CanvasCatchUp, StoreError> {
        let documents = self.documents.read();
        let doc = documents
            .get(document_id)
            .filter(|doc| doc.record.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        // A caller behind the snapshot cannot be caught up by the log alone,
        // because the rows the snapshot replaced are gone.
        let behind_snapshot = since_sequence < doc.record.snapshot_sequence;
        let floor = if behind_snapshot {
            doc.record.snapshot_sequence
        } else {
            since_sequence
        };
        let updates: Vec<CanvasUpdateRecord> = doc
            .updates
            .iter()
            .filter(|(update, _)| update.sequence > floor)
            .take(limit.max(0) as usize)
            .map(|(update, _)| update.clone())
            .collect();
        Ok(CanvasCatchUp {
            snapshot: if behind_snapshot {
                doc.snapshot.as_deref().map(encode)
            } else {
                None
            },
            snapshot_sequence: doc.record.snapshot_sequence,
            updates,
            latest_sequence: doc.record.latest_sequence,
        })
    }

    async fn store_snapshot(
        &self,
        input: NewCanvasSnapshot,
    ) -> Result<CanvasDocumentRecord, StoreError> {
        if input.payload.is_empty() || input.payload.len() > MAX_UPDATE_BYTES {
            return Err(StoreError::Policy("snapshot payload out of range".into()));
        }
        let mut documents = self.documents.write();
        let doc = documents
            .get_mut(&input.document_id)
            .filter(|doc| doc.record.org_id == input.org_id)
            .ok_or(StoreError::NotFound)?;
        // Refusing to move the marker backwards, or past what exists, is what
        // stops a stale peer from retiring updates it never saw.
        if input.covers_sequence < doc.record.snapshot_sequence
            || input.covers_sequence > doc.record.latest_sequence
        {
            return Err(StoreError::Policy(
                "snapshot does not cover a stored range".into(),
            ));
        }
        doc.snapshot = Some(input.payload);
        doc.record.snapshot_sequence = input.covers_sequence;
        doc.record.updated_at = input.now;
        doc.updates
            .retain(|(update, _)| update.sequence > input.covers_sequence);
        Ok(doc.record.clone())
    }

    async fn create_comment(
        &self,
        input: NewCanvasComment,
    ) -> Result<CanvasCommentRecord, StoreError> {
        let mut documents = self.documents.write();
        let doc = documents
            .get_mut(&input.document_id)
            .filter(|doc| doc.record.org_id == input.org_id)
            .ok_or(StoreError::NotFound)?;
        if let Some(existing) = doc
            .comments
            .iter()
            .find(|comment| comment.id == input.id)
            .cloned()
        {
            return Ok(existing);
        }
        let record = CanvasCommentRecord {
            id: input.id,
            document_id: input.document_id,
            anchor: input.anchor,
            head: input.head,
            body: input.body,
            author_user_id: input.author_user_id,
            resolved: false,
            created_at: input.created_at,
            updated_at: input.created_at,
        };
        doc.comments.push(record.clone());
        Ok(record)
    }

    async fn list_comments(
        &self,
        org_id: &str,
        document_id: &str,
    ) -> Result<Vec<CanvasCommentRecord>, StoreError> {
        let documents = self.documents.read();
        let doc = documents
            .get(document_id)
            .filter(|doc| doc.record.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        Ok(doc.comments.clone())
    }

    async fn update_comment(
        &self,
        org_id: &str,
        document_id: &str,
        comment_id: &str,
        body: Option<&str>,
        resolved: Option<bool>,
        now: i64,
    ) -> Result<CanvasCommentRecord, StoreError> {
        let mut documents = self.documents.write();
        let doc = documents
            .get_mut(document_id)
            .filter(|doc| doc.record.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        let comment = doc
            .comments
            .iter_mut()
            .find(|comment| comment.id == comment_id)
            .ok_or(StoreError::NotFound)?;
        if let Some(body) = body {
            comment.body = body.to_owned();
        }
        if let Some(resolved) = resolved {
            comment.resolved = resolved;
        }
        comment.updated_at = now;
        Ok(comment.clone())
    }

    async fn delete_comment(
        &self,
        org_id: &str,
        document_id: &str,
        comment_id: &str,
    ) -> Result<(), StoreError> {
        let mut documents = self.documents.write();
        let doc = documents
            .get_mut(document_id)
            .filter(|doc| doc.record.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        let before = doc.comments.len();
        doc.comments.retain(|comment| comment.id != comment_id);
        if doc.comments.len() == before {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    async fn create_version(
        &self,
        input: NewCanvasVersion,
    ) -> Result<CanvasVersionRecord, StoreError> {
        let mut documents = self.documents.write();
        let doc = documents
            .get_mut(&input.document_id)
            .filter(|doc| doc.record.org_id == input.org_id)
            .ok_or(StoreError::NotFound)?;
        if let Some(existing) = doc
            .versions
            .iter()
            .find(|version| version.id == input.id)
            .cloned()
        {
            return Ok(existing);
        }
        let record = CanvasVersionRecord {
            id: input.id,
            document_id: input.document_id,
            label: input.label,
            content: input.content,
            author_user_id: input.author_user_id,
            created_at: input.created_at,
        };
        doc.versions.push(record.clone());
        Ok(record)
    }

    async fn list_versions(
        &self,
        org_id: &str,
        document_id: &str,
    ) -> Result<Vec<CanvasVersionRecord>, StoreError> {
        let documents = self.documents.read();
        let doc = documents
            .get(document_id)
            .filter(|doc| doc.record.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        let mut rows = doc.versions.clone();
        rows.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
        Ok(rows)
    }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const DOCUMENT_COLUMNS: &str = "id, org_id, workspace_id, title, language, created_by_user_id, \
     created_at, updated_at, revision, next_sequence, snapshot_sequence";

fn document_from_row(row: &tokio_postgres::Row) -> Result<CanvasDocumentRecord, StoreError> {
    Ok(CanvasDocumentRecord {
        id: row.get("id"),
        org_id: row.get("org_id"),
        workspace_id: row.get("workspace_id"),
        title: row.get("title"),
        language: row.get("language"),
        created_by_user_id: row.get("created_by_user_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        revision: row.get("revision"),
        // `next_sequence` is where the next update will land, so the highest
        // one accepted so far is one below it.
        latest_sequence: row.get::<_, i64>("next_sequence") - 1,
        snapshot_sequence: row.get("snapshot_sequence"),
    })
}

fn update_from_row(row: &tokio_postgres::Row) -> CanvasUpdateRecord {
    CanvasUpdateRecord {
        document_id: row.get("document_id"),
        sequence: row.get("sequence"),
        payload: encode(row.get::<_, &[u8]>("payload")),
        author_user_id: row.get("author_user_id"),
        created_at: row.get("created_at"),
        operation_id: row.get("operation_id"),
    }
}

fn comment_from_row(row: &tokio_postgres::Row) -> CanvasCommentRecord {
    CanvasCommentRecord {
        id: row.get("id"),
        document_id: row.get("document_id"),
        anchor: row.get("anchor"),
        head: row.get("head"),
        body: row.get("body"),
        author_user_id: row.get("author_user_id"),
        resolved: row.get("resolved"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn version_from_row(row: &tokio_postgres::Row) -> CanvasVersionRecord {
    CanvasVersionRecord {
        id: row.get("id"),
        document_id: row.get("document_id"),
        label: row.get("label"),
        content: row.get("content"),
        author_user_id: row.get("author_user_id"),
        created_at: row.get("created_at"),
    }
}

fn db(error: impl std::fmt::Display) -> StoreError {
    StoreError::Database(error.to_string())
}

#[async_trait]
impl CanvasStore for PgStore {
    async fn create_document(
        &self,
        input: NewCanvasDocument,
    ) -> Result<CanvasDocumentRecord, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        if let Some(row) = tx
            .query_opt(
                &format!(
                    "SELECT {DOCUMENT_COLUMNS} FROM canvas_documents \
                     WHERE org_id=$1 AND created_operation_id=$2"
                ),
                &[&input.org_id, &input.operation_id],
            )
            .await
            .map_err(db)?
        {
            return document_from_row(&row);
        }
        let row = tx
            .query_one(
                &format!(
                    "INSERT INTO canvas_documents \
                     (id, org_id, workspace_id, title, language, created_by_user_id, \
                      created_at, updated_at, created_operation_id, last_operation_id) \
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$8) RETURNING {DOCUMENT_COLUMNS}"
                ),
                &[
                    &input.id,
                    &input.org_id,
                    &input.workspace_id,
                    &input.title,
                    &input.language,
                    &input.created_by_user_id,
                    &input.created_at,
                    &input.operation_id,
                ],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        document_from_row(&row)
    }

    async fn list_documents(
        &self,
        org_id: &str,
        workspace_id: &str,
    ) -> Result<Vec<CanvasDocumentRecord>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                &format!(
                    "SELECT {DOCUMENT_COLUMNS} FROM canvas_documents \
                     WHERE org_id=$1 AND workspace_id=$2 ORDER BY updated_at DESC, id ASC"
                ),
                &[&org_id, &workspace_id],
            )
            .await
            .map_err(db)?;
        rows.iter().map(document_from_row).collect()
    }

    async fn get_document(
        &self,
        org_id: &str,
        workspace_id: &str,
        document_id: &str,
    ) -> Result<CanvasDocumentRecord, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                &format!(
                    "SELECT {DOCUMENT_COLUMNS} FROM canvas_documents \
                     WHERE org_id=$1 AND workspace_id=$2 AND id=$3"
                ),
                &[&org_id, &workspace_id, &document_id],
            )
            .await
            .map_err(db)?
            .ok_or(StoreError::NotFound)?;
        document_from_row(&row)
    }

    async fn document_workspace(
        &self,
        org_id: &str,
        document_id: &str,
    ) -> Result<String, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                "SELECT workspace_id FROM canvas_documents WHERE org_id=$1 AND id=$2",
                &[&org_id, &document_id],
            )
            .await
            .map_err(db)?
            .ok_or(StoreError::NotFound)?;
        Ok(row.get("workspace_id"))
    }

    async fn rename_document(
        &self,
        input: RenameCanvasDocument,
    ) -> Result<CanvasDocumentRecord, StoreError> {
        let RenameCanvasDocument {
            org_id,
            document_id,
            title,
            language,
            base_revision,
            operation_id,
            now,
        } = input;
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &org_id).await?;
        let existing = tx
            .query_opt(
                &format!(
                    "SELECT {DOCUMENT_COLUMNS}, last_operation_id FROM canvas_documents \
                     WHERE org_id=$1 AND id=$2 FOR UPDATE"
                ),
                &[&org_id, &document_id],
            )
            .await
            .map_err(db)?
            .ok_or(StoreError::NotFound)?;
        // A retried rename is the same rename, not a conflict.
        if existing.get::<_, String>("last_operation_id") == operation_id {
            return document_from_row(&existing);
        }
        let current = document_from_row(&existing)?;
        if current.revision != base_revision {
            return Err(conflict(&current));
        }
        let row = tx
            .query_one(
                &format!(
                    "UPDATE canvas_documents SET title=COALESCE($3,title), \
                     language=COALESCE($4,language), updated_at=$5, revision=revision+1, \
                     last_operation_id=$6 WHERE org_id=$1 AND id=$2 RETURNING {DOCUMENT_COLUMNS}"
                ),
                &[
                    &org_id,
                    &document_id,
                    &title,
                    &language,
                    &now,
                    &operation_id,
                ],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        document_from_row(&row)
    }

    async fn delete_document(&self, org_id: &str, document_id: &str) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        // Updates, comments and versions go with it through ON DELETE CASCADE.
        let deleted = tx
            .execute(
                "DELETE FROM canvas_documents WHERE org_id=$1 AND id=$2",
                &[&org_id, &document_id],
            )
            .await
            .map_err(db)?;
        if deleted == 0 {
            return Err(StoreError::NotFound);
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }

    async fn append_update(
        &self,
        input: NewCanvasUpdate,
    ) -> Result<CanvasUpdateRecord, StoreError> {
        if input.payload.is_empty() || input.payload.len() > MAX_UPDATE_BYTES {
            return Err(StoreError::Policy("update payload out of range".into()));
        }
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        // `FOR UPDATE` serialises sequence allocation against every other
        // writer on this document. Two peers typing at once take the lock in
        // turn and get 42 and 43, rather than both reading 41 and colliding on
        // the primary key.
        let document = tx
            .query_opt(
                "SELECT workspace_id, next_sequence FROM canvas_documents \
                 WHERE org_id=$1 AND id=$2 FOR UPDATE",
                &[&input.org_id, &input.document_id],
            )
            .await
            .map_err(db)?
            .ok_or(StoreError::NotFound)?;
        if let Some(row) = tx
            .query_opt(
                "SELECT document_id, sequence, payload, author_user_id, created_at, operation_id \
                 FROM canvas_document_updates WHERE document_id=$1 AND operation_id=$2",
                &[&input.document_id, &input.operation_id],
            )
            .await
            .map_err(db)?
        {
            return Ok(update_from_row(&row));
        }
        let workspace_id: String = document.get("workspace_id");
        let sequence: i64 = document.get("next_sequence");
        let row = tx
            .query_one(
                "INSERT INTO canvas_document_updates \
                 (org_id, workspace_id, document_id, sequence, payload, author_user_id, \
                  created_at, operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) \
                 RETURNING document_id, sequence, payload, author_user_id, created_at, operation_id",
                &[
                    &input.org_id,
                    &workspace_id,
                    &input.document_id,
                    &sequence,
                    &input.payload,
                    &input.author_user_id,
                    &input.created_at,
                    &input.operation_id,
                ],
            )
            .await
            .map_err(db)?;
        tx.execute(
            "UPDATE canvas_documents SET next_sequence=$3, updated_at=$4 \
             WHERE org_id=$1 AND id=$2",
            &[
                &input.org_id,
                &input.document_id,
                &(sequence + 1),
                &input.created_at,
            ],
        )
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(update_from_row(&row))
    }

    async fn catch_up(
        &self,
        org_id: &str,
        document_id: &str,
        since_sequence: i64,
        limit: i64,
    ) -> Result<CanvasCatchUp, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let document = tx
            .query_opt(
                "SELECT snapshot, snapshot_sequence, next_sequence FROM canvas_documents \
                 WHERE org_id=$1 AND id=$2",
                &[&org_id, &document_id],
            )
            .await
            .map_err(db)?
            .ok_or(StoreError::NotFound)?;
        let snapshot_sequence: i64 = document.get("snapshot_sequence");
        let latest_sequence = document.get::<_, i64>("next_sequence") - 1;
        let behind_snapshot = since_sequence < snapshot_sequence;
        let floor = if behind_snapshot {
            snapshot_sequence
        } else {
            since_sequence
        };
        let rows = tx
            .query(
                "SELECT document_id, sequence, payload, author_user_id, created_at, operation_id \
                 FROM canvas_document_updates WHERE org_id=$1 AND document_id=$2 AND sequence>$3 \
                 ORDER BY sequence ASC LIMIT $4",
                &[&org_id, &document_id, &floor, &limit.max(0)],
            )
            .await
            .map_err(db)?;
        Ok(CanvasCatchUp {
            snapshot: if behind_snapshot {
                document.get::<_, Option<&[u8]>>("snapshot").map(encode)
            } else {
                None
            },
            snapshot_sequence,
            updates: rows.iter().map(update_from_row).collect(),
            latest_sequence,
        })
    }

    async fn store_snapshot(
        &self,
        input: NewCanvasSnapshot,
    ) -> Result<CanvasDocumentRecord, StoreError> {
        if input.payload.is_empty() || input.payload.len() > MAX_UPDATE_BYTES {
            return Err(StoreError::Policy("snapshot payload out of range".into()));
        }
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        let existing = tx
            .query_opt(
                &format!(
                    "SELECT {DOCUMENT_COLUMNS} FROM canvas_documents \
                     WHERE org_id=$1 AND id=$2 FOR UPDATE"
                ),
                &[&input.org_id, &input.document_id],
            )
            .await
            .map_err(db)?
            .ok_or(StoreError::NotFound)?;
        let current = document_from_row(&existing)?;
        if input.covers_sequence < current.snapshot_sequence
            || input.covers_sequence > current.latest_sequence
        {
            return Err(StoreError::Policy(
                "snapshot does not cover a stored range".into(),
            ));
        }
        let row = tx
            .query_one(
                &format!(
                    "UPDATE canvas_documents SET snapshot=$3, snapshot_sequence=$4, updated_at=$5 \
                     WHERE org_id=$1 AND id=$2 RETURNING {DOCUMENT_COLUMNS}"
                ),
                &[
                    &input.org_id,
                    &input.document_id,
                    &input.payload,
                    &input.covers_sequence,
                    &input.now,
                ],
            )
            .await
            .map_err(db)?;
        tx.execute(
            "DELETE FROM canvas_document_updates WHERE org_id=$1 AND document_id=$2 AND sequence<=$3",
            &[&input.org_id, &input.document_id, &input.covers_sequence],
        )
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)?;
        document_from_row(&row)
    }

    async fn create_comment(
        &self,
        input: NewCanvasComment,
    ) -> Result<CanvasCommentRecord, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        if let Some(row) = tx
            .query_opt(
                "SELECT id, document_id, anchor, head, body, author_user_id, resolved, \
                 created_at, updated_at FROM canvas_comments \
                 WHERE document_id=$1 AND operation_id=$2",
                &[&input.document_id, &input.operation_id],
            )
            .await
            .map_err(db)?
        {
            return Ok(comment_from_row(&row));
        }
        let workspace_id: String = tx
            .query_opt(
                "SELECT workspace_id FROM canvas_documents WHERE org_id=$1 AND id=$2",
                &[&input.org_id, &input.document_id],
            )
            .await
            .map_err(db)?
            .ok_or(StoreError::NotFound)?
            .get("workspace_id");
        let row = tx
            .query_one(
                "INSERT INTO canvas_comments \
                 (id, org_id, workspace_id, document_id, anchor, head, body, author_user_id, \
                  created_at, updated_at, operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10) \
                 RETURNING id, document_id, anchor, head, body, author_user_id, resolved, \
                 created_at, updated_at",
                &[
                    &input.id,
                    &input.org_id,
                    &workspace_id,
                    &input.document_id,
                    &input.anchor,
                    &input.head,
                    &input.body,
                    &input.author_user_id,
                    &input.created_at,
                    &input.operation_id,
                ],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(comment_from_row(&row))
    }

    async fn list_comments(
        &self,
        org_id: &str,
        document_id: &str,
    ) -> Result<Vec<CanvasCommentRecord>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                "SELECT id, document_id, anchor, head, body, author_user_id, resolved, \
                 created_at, updated_at FROM canvas_comments \
                 WHERE org_id=$1 AND document_id=$2 ORDER BY created_at ASC, id ASC",
                &[&org_id, &document_id],
            )
            .await
            .map_err(db)?;
        Ok(rows.iter().map(comment_from_row).collect())
    }

    async fn update_comment(
        &self,
        org_id: &str,
        document_id: &str,
        comment_id: &str,
        body: Option<&str>,
        resolved: Option<bool>,
        now: i64,
    ) -> Result<CanvasCommentRecord, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                "UPDATE canvas_comments SET body=COALESCE($4,body), \
                 resolved=COALESCE($5,resolved), updated_at=$6 \
                 WHERE org_id=$1 AND document_id=$2 AND id=$3 \
                 RETURNING id, document_id, anchor, head, body, author_user_id, resolved, \
                 created_at, updated_at",
                &[&org_id, &document_id, &comment_id, &body, &resolved, &now],
            )
            .await
            .map_err(db)?
            .ok_or(StoreError::NotFound)?;
        tx.commit().await.map_err(db)?;
        Ok(comment_from_row(&row))
    }

    async fn delete_comment(
        &self,
        org_id: &str,
        document_id: &str,
        comment_id: &str,
    ) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let deleted = tx
            .execute(
                "DELETE FROM canvas_comments WHERE org_id=$1 AND document_id=$2 AND id=$3",
                &[&org_id, &document_id, &comment_id],
            )
            .await
            .map_err(db)?;
        if deleted == 0 {
            return Err(StoreError::NotFound);
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }

    async fn create_version(
        &self,
        input: NewCanvasVersion,
    ) -> Result<CanvasVersionRecord, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        if let Some(row) = tx
            .query_opt(
                "SELECT id, document_id, label, content, author_user_id, created_at \
                 FROM canvas_versions WHERE document_id=$1 AND operation_id=$2",
                &[&input.document_id, &input.operation_id],
            )
            .await
            .map_err(db)?
        {
            return Ok(version_from_row(&row));
        }
        let workspace_id: String = tx
            .query_opt(
                "SELECT workspace_id FROM canvas_documents WHERE org_id=$1 AND id=$2",
                &[&input.org_id, &input.document_id],
            )
            .await
            .map_err(db)?
            .ok_or(StoreError::NotFound)?
            .get("workspace_id");
        let row = tx
            .query_one(
                "INSERT INTO canvas_versions \
                 (id, org_id, workspace_id, document_id, label, content, author_user_id, \
                  created_at, operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) \
                 RETURNING id, document_id, label, content, author_user_id, created_at",
                &[
                    &input.id,
                    &input.org_id,
                    &workspace_id,
                    &input.document_id,
                    &input.label,
                    &input.content,
                    &input.author_user_id,
                    &input.created_at,
                    &input.operation_id,
                ],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(version_from_row(&row))
    }

    async fn list_versions(
        &self,
        org_id: &str,
        document_id: &str,
    ) -> Result<Vec<CanvasVersionRecord>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                "SELECT id, document_id, label, content, author_user_id, created_at \
                 FROM canvas_versions WHERE org_id=$1 AND document_id=$2 \
                 ORDER BY created_at DESC, id ASC",
                &[&org_id, &document_id],
            )
            .await
            .map_err(db)?;
        Ok(rows.iter().map(version_from_row).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "org_acme00000000000000000";
    const USER: &str = "usr_aaaaaaaaaaaaaaaaaaaaaaaa";

    async fn seeded() -> (InMemoryCanvasStore, CanvasDocumentRecord) {
        let store = InMemoryCanvasStore::new();
        let document = store
            .create_document(NewCanvasDocument {
                id: "cvd_1".into(),
                org_id: ORG.into(),
                workspace_id: "proj-1".into(),
                title: "Notes".into(),
                language: "markdown".into(),
                created_by_user_id: USER.into(),
                created_at: 10,
                operation_id: "op_create".into(),
            })
            .await
            .expect("create");
        (store, document)
    }

    fn update(store_id: &str, operation: &str, payload: &[u8], at: i64) -> NewCanvasUpdate {
        NewCanvasUpdate {
            org_id: ORG.into(),
            document_id: store_id.into(),
            payload: payload.to_vec(),
            author_user_id: USER.into(),
            created_at: at,
            operation_id: operation.into(),
        }
    }

    #[tokio::test]
    async fn updates_are_numbered_in_the_order_they_land() {
        let (store, document) = seeded().await;
        let first = store
            .append_update(update(&document.id, "op_a", b"a", 11))
            .await
            .expect("first");
        let second = store
            .append_update(update(&document.id, "op_b", b"b", 12))
            .await
            .expect("second");
        assert_eq!((first.sequence, second.sequence), (1, 2));
    }

    #[tokio::test]
    async fn replaying_an_operation_id_returns_the_stored_update_rather_than_a_second_one() {
        // The offline queue drains more than once whenever a reconnect
        // interrupts it, so this is the normal path, not an edge case.
        let (store, document) = seeded().await;
        let first = store
            .append_update(update(&document.id, "op_a", b"hello", 11))
            .await
            .expect("first");
        let replayed = store
            .append_update(update(&document.id, "op_a", b"hello", 99))
            .await
            .expect("replay");
        assert_eq!(first, replayed);
        let caught_up = store
            .catch_up(ORG, &document.id, 0, 100)
            .await
            .expect("catch up");
        assert_eq!(caught_up.updates.len(), 1);
    }

    #[tokio::test]
    async fn a_caller_that_is_caught_up_is_sent_nothing() {
        let (store, document) = seeded().await;
        store
            .append_update(update(&document.id, "op_a", b"a", 11))
            .await
            .expect("append");
        let caught_up = store
            .catch_up(ORG, &document.id, 1, 100)
            .await
            .expect("catch up");
        assert!(caught_up.updates.is_empty());
        assert_eq!(caught_up.latest_sequence, 1);
        assert!(caught_up.snapshot.is_none());
    }

    #[tokio::test]
    async fn a_caller_behind_the_snapshot_is_sent_the_snapshot_and_the_rest() {
        let (store, document) = seeded().await;
        for (operation, byte) in [("op_a", b"a"), ("op_b", b"b"), ("op_c", b"c")] {
            store
                .append_update(update(&document.id, operation, byte, 11))
                .await
                .expect("append");
        }
        store
            .store_snapshot(NewCanvasSnapshot {
                org_id: ORG.into(),
                document_id: document.id.clone(),
                payload: b"snapshot-of-1-and-2".to_vec(),
                covers_sequence: 2,
                now: 20,
            })
            .await
            .expect("snapshot");

        let joiner = store
            .catch_up(ORG, &document.id, 0, 100)
            .await
            .expect("catch up");
        assert!(joiner.snapshot.is_some(), "a new peer needs the baseline");
        assert_eq!(
            joiner
                .updates
                .iter()
                .map(|u| u.sequence)
                .collect::<Vec<_>>(),
            vec![3],
            "only what the snapshot does not already contain"
        );

        let current = store
            .catch_up(ORG, &document.id, 3, 100)
            .await
            .expect("catch up");
        assert!(
            current.snapshot.is_none(),
            "a peer already past the snapshot must not be sent it again"
        );
    }

    #[tokio::test]
    async fn a_snapshot_may_not_retire_updates_it_does_not_cover() {
        let (store, document) = seeded().await;
        store
            .append_update(update(&document.id, "op_a", b"a", 11))
            .await
            .expect("append");
        // Sequence 7 does not exist. A peer claiming it would delete a range
        // nobody has confirmed is in the snapshot.
        let error = store
            .store_snapshot(NewCanvasSnapshot {
                org_id: ORG.into(),
                document_id: document.id.clone(),
                payload: b"whatever".to_vec(),
                covers_sequence: 7,
                now: 20,
            })
            .await
            .expect_err("must refuse");
        assert!(matches!(error, StoreError::Policy(_)), "{error}");
    }

    #[tokio::test]
    async fn a_snapshot_may_not_walk_the_marker_backwards() {
        let (store, document) = seeded().await;
        for (operation, byte) in [("op_a", b"a"), ("op_b", b"b")] {
            store
                .append_update(update(&document.id, operation, byte, 11))
                .await
                .expect("append");
        }
        store
            .store_snapshot(NewCanvasSnapshot {
                org_id: ORG.into(),
                document_id: document.id.clone(),
                payload: b"covers-2".to_vec(),
                covers_sequence: 2,
                now: 20,
            })
            .await
            .expect("snapshot");
        let error = store
            .store_snapshot(NewCanvasSnapshot {
                org_id: ORG.into(),
                document_id: document.id.clone(),
                payload: b"stale".to_vec(),
                covers_sequence: 1,
                now: 21,
            })
            .await
            .expect_err("a stale peer must not undo a compaction");
        assert!(matches!(error, StoreError::Policy(_)), "{error}");
    }

    #[tokio::test]
    async fn a_document_is_invisible_from_another_workspace() {
        let (store, document) = seeded().await;
        assert!(store
            .get_document(ORG, "proj-1", &document.id)
            .await
            .is_ok());
        assert!(matches!(
            store.get_document(ORG, "proj-other", &document.id).await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn a_document_is_invisible_from_another_org() {
        let (store, document) = seeded().await;
        assert!(matches!(
            store
                .get_document("org_somebodyelse00000000", "proj-1", &document.id)
                .await,
            Err(StoreError::NotFound)
        ));
        assert!(matches!(
            store
                .append_update(NewCanvasUpdate {
                    org_id: "org_somebodyelse00000000".into(),
                    document_id: document.id.clone(),
                    payload: b"x".to_vec(),
                    author_user_id: USER.into(),
                    created_at: 11,
                    operation_id: "op_x".into(),
                })
                .await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn a_rename_against_a_stale_revision_conflicts_instead_of_overwriting() {
        let (store, document) = seeded().await;
        let rename = |title: &str, operation: &str, now: i64| RenameCanvasDocument {
            org_id: ORG.into(),
            document_id: document.id.clone(),
            title: Some(title.into()),
            language: None,
            base_revision: 1,
            operation_id: operation.into(),
            now,
        };
        store
            .rename_document(rename("Renamed", "op_r1", 30))
            .await
            .expect("first rename");
        let error = store
            .rename_document(rename("Also renamed", "op_r2", 31))
            .await
            .expect_err("the second writer held revision 1");
        assert!(matches!(error, StoreError::Conflict(_)), "{error}");
    }

    #[tokio::test]
    async fn deleting_a_document_takes_its_updates_comments_and_versions_with_it() {
        let (store, document) = seeded().await;
        store
            .append_update(update(&document.id, "op_a", b"a", 11))
            .await
            .expect("append");
        store
            .create_comment(NewCanvasComment {
                id: "cmt_1".into(),
                org_id: ORG.into(),
                document_id: document.id.clone(),
                anchor: "anchor".into(),
                head: None,
                body: "look here".into(),
                author_user_id: USER.into(),
                created_at: 12,
                operation_id: "op_c".into(),
            })
            .await
            .expect("comment");
        store
            .delete_document(ORG, &document.id)
            .await
            .expect("delete");
        assert!(matches!(
            store.list_comments(ORG, &document.id).await,
            Err(StoreError::NotFound)
        ));
        assert!(matches!(
            store.catch_up(ORG, &document.id, 0, 10).await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn an_oversized_update_is_refused_rather_than_stored() {
        let (store, document) = seeded().await;
        let error = store
            .append_update(update(
                &document.id,
                "op_big",
                &vec![0u8; MAX_UPDATE_BYTES + 1],
                11,
            ))
            .await
            .expect_err("must refuse");
        assert!(matches!(error, StoreError::Policy(_)), "{error}");
    }

    #[test]
    fn payload_decoding_refuses_what_the_schema_would_refuse() {
        assert!(decode_payload("not base64 at all !!!").is_none());
        assert!(
            decode_payload("").is_none(),
            "an empty update is not an update"
        );
        use base64::Engine as _;
        let oversized =
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_UPDATE_BYTES + 1]);
        assert!(decode_payload(&oversized).is_none());
        let fine = base64::engine::general_purpose::STANDARD.encode(b"hello");
        assert_eq!(decode_payload(&fine).as_deref(), Some(&b"hello"[..]));
    }

    #[tokio::test]
    async fn comments_can_be_resolved_and_deleted() {
        let (store, document) = seeded().await;
        let comment = store
            .create_comment(NewCanvasComment {
                id: "cmt_1".into(),
                org_id: ORG.into(),
                document_id: document.id.clone(),
                anchor: "anchor".into(),
                head: Some("head".into()),
                body: "look here".into(),
                author_user_id: USER.into(),
                created_at: 12,
                operation_id: "op_c".into(),
            })
            .await
            .expect("comment");
        assert!(!comment.resolved);
        let resolved = store
            .update_comment(ORG, &document.id, &comment.id, None, Some(true), 13)
            .await
            .expect("resolve");
        assert!(resolved.resolved);
        assert_eq!(
            resolved.body, "look here",
            "resolving must not blank the body"
        );
        store
            .delete_comment(ORG, &document.id, &comment.id)
            .await
            .expect("delete");
        assert!(store
            .list_comments(ORG, &document.id)
            .await
            .expect("list")
            .is_empty());
    }
}
