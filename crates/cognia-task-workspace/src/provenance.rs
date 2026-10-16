//! Durable, host-scoped provenance independent of task retention.
//!
//! P2 callers store blobs with `WorkspaceStore::put_blob`, register sources, then
//! prepare a mutation before touching files. After verifying the actual write,
//! `commit_mutation` atomically publishes versions, maps and adoption events.
//! A failed or uncertain filesystem write must abort or require reconciliation.
//! This module deliberately installs no capture hooks or authorization transport.

pub mod capture;

use crate::line_map::{self, Segment};
pub use crate::store::WorkspaceStore;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ops::Range;
use uuid::Uuid;

/// Maximum segments returned in one page.
pub const MAX_SEGMENTS_PER_QUERY: usize = 2_000;
/// Maximum path/adoption entries returned in one page.
pub const MAX_HISTORY_PER_QUERY: usize = 100;
/// Default total retained versions, including the current version.
pub const RETAINED_VERSIONS: usize = 32;

macro_rules! vocabulary {
    ($name:ident, $doc:literal, {$($variant:ident => $sql:literal),+ $(,)?}) => {
        #[doc = $doc]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub enum $name { $(#[doc = $sql] $variant),+ }
        impl $name {
            fn sql(self) -> &'static str { match self { $(Self::$variant => $sql),+ } }
            fn parse(value: &str) -> Result<Self> {
                match value { $($sql => Ok(Self::$variant)),+, _ => Err(ProvenanceError::Invalid(format!("invalid {}: {value}", stringify!($name)))) }
            }
        }
    };
}
vocabulary!(ProvenanceOrigin, "Who introduced the content, independently of its mapping confidence.", {Agent=>"agent", Human=>"human", Unknown=>"unknown"});
vocabulary!(OriginEvidence, "Evidence for the original attribution; never overwritten by carry-forward.", {ToolReported=>"tool_reported", WatcherObserved=>"watcher_observed", Reconciled=>"reconciled", Inferred=>"inferred", EditorSave=>"editor_save", ConfirmedReceipt=>"confirmed_receipt"});
vocabulary!(MappingEvidence, "Confidence in the mapping from original content to these lines.", {Exact=>"exact", Carried=>"carried", Inferred=>"inferred", Unknown=>"unknown"});
vocabulary!(AdoptionState, "Outcome for a file, hunk or line-range unit, separate from surviving lines.", {Pending=>"pending", Applied=>"applied", Partial=>"partial", Discarded=>"discarded", Reverted=>"reverted"});
vocabulary!(IdentityState, "Whether a stable resource identity is live, deleted or unresolved.", {Active=>"active", Deleted=>"deleted", Ambiguous=>"ambiguous"});
vocabulary!(MutationCommitState, "Durable filesystem/SQLite intent state.", {Prepared=>"prepared", Committed=>"committed", Aborted=>"aborted", ReconcileRequired=>"reconcile_required"});
vocabulary!(Completeness, "Whether a version has complete evidence or an explicit degradation.", {Complete=>"complete", Partial=>"partial", Gap=>"gap", Capacity=>"capacity"});

/// Typed refusal; capacity never silently truncates a current map or query.
#[derive(Debug, thiserror::Error)]
pub enum ProvenanceError {
    #[error("provenance capacity: {0}")]
    Capacity(String),
    #[error("invalid provenance: {0}")]
    Invalid(String),
    #[error("provenance conflict: {0}")]
    Conflict(String),
    #[error("provenance database: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("provenance serialization: {0}")]
    Json(#[from] serde_json::Error),
    #[error("provenance blob: {0}")]
    Blob(String),
}
pub type Result<T> = std::result::Result<T, ProvenanceError>;

/// Canonical raw-byte hash. Never compare this string to Git OIDs or legacy blob keys.
pub fn content_hash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

/// Durable root scope. Working trees and target refs use distinct stream keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceRoot {
    pub root_id: String,
    pub principal_id: String,
    pub host_id: String,
    pub canonical_root: String,
    pub stream_key: String,
    pub repository_fingerprint: Option<String>,
}

/// Source metadata is copied here, never joined through a prunable task row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceSource {
    pub provenance_id: String,
    pub root_id: String,
    pub origin: ProvenanceOrigin,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub agent_id: Option<String>,
    pub execution_run_id: Option<String>,
    pub trace_id: Option<String>,
    pub assistant_message_id: Option<String>,
    /// Exact links require a trusted receipt matching the transition in P2.
    pub tool_call_id: Option<String>,
    pub event_id: Option<String>,
    pub evidence: OriginEvidence,
    pub created_at: i64,
    pub details: serde_json::Value,
}

/// Host-attested run-local file transition; metadata remains after task pruning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMutationReceipt {
    pub run_id: String,
    pub tool_call_id: String,
    pub ordinal: u64,
    pub path: String,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
}

/// Path resolution deliberately returns ambiguity instead of picking a candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathEntry {
    pub entry_id: String,
    pub root_id: String,
    pub resource_id: Option<String>,
    pub relative_path: String,
    pub from_seq: i64,
    pub to_seq: Option<i64>,
    pub state: IdentityState,
    pub evidence: OriginEvidence,
    pub candidates: Vec<String>,
}

/// A rename claim; the expected current version prevents stale explicit renames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameClaim {
    pub root_id: String,
    pub old_path: String,
    pub new_path: String,
    pub expected_version_id: Option<String>,
    pub evidence: OriginEvidence,
    /// More than one plausible resource is recorded as ambiguous, never merged.
    pub candidates: Vec<String>,
}

/// A durable intent; blob_refs pin before/after and patch blobs during recovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationIntent {
    pub root_id: String,
    pub operation_key: String,
    pub kind: String,
    pub manifest: serde_json::Value,
    pub selection: serde_json::Value,
    pub blob_refs: Vec<String>,
    pub created_at: i64,
}

/// Mutation identity and state returned on both first execution and retry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    pub operation_id: String,
    pub root_id: String,
    pub operation_key: String,
    pub seq: i64,
    pub state: MutationCommitState,
}

/// One version to publish in a commit. A→B→A creates three distinct version IDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInput {
    pub version_id: String,
    pub resource_id: String,
    pub parent_version_id: Option<String>,
    pub content_hash: String,
    pub blob_ref: Option<String>,
    pub line_count: usize,
    /// Binary or invalid UTF-8 is one whole-file unit, never a pretend text map.
    pub binary: bool,
    pub segments: Vec<Segment>,
    pub completeness: Completeness,
    pub observed_at: i64,
}

/// Stored version metadata; segments are fetched using bounded pages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceVersion {
    pub version_id: String,
    pub resource_id: String,
    pub parent_version_id: Option<String>,
    pub operation_id: String,
    pub content_hash: String,
    pub blob_ref: Option<String>,
    pub line_count: usize,
    pub binary: bool,
    pub completeness: Completeness,
    pub observed_at: i64,
}

/// An adoption summary survives version compaction, including pure deletions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptionInput {
    pub provenance_id: String,
    pub unit_key: String,
    pub state: AdoptionState,
    pub details: serde_json::Value,
}

/// An adoption event plus the immutable operation sequence for pagination.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptionEvent {
    pub operation_id: String,
    pub seq: i64,
    pub adoption: AdoptionInput,
}

/// Cursor is opaque to callers and bound to its exact query and root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryCursor {
    scope: String,
    offset: usize,
    after: Option<(i64, String)>,
}

/// Explicit continuation; requesting over the bound returns Capacity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<QueryCursor>,
}

/// Explicit full-text retention policy. No task lifecycle operation invokes it.
#[derive(Debug, Clone, Copy)]
pub struct CompactionLimits {
    pub versions_per_resource: usize,
}
impl Default for CompactionLimits {
    fn default() -> Self {
        Self {
            versions_per_resource: RETAINED_VERSIONS,
        }
    }
}

impl WorkspaceStore {
    /// Additive, repeatable migration; intentionally no foreign keys to task tables.
    pub fn apply_provenance_migration(&self) -> std::result::Result<(), String> {
        self.connection.execute_batch(r#"
CREATE TABLE IF NOT EXISTS provenance_roots (
 root_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, host_id TEXT NOT NULL,
 canonical_root TEXT NOT NULL, stream_key TEXT NOT NULL, repository_fingerprint TEXT,
 next_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_seq>=1),
 UNIQUE(principal_id,host_id,canonical_root,stream_key));
CREATE TABLE IF NOT EXISTS resource_identity (
 resource_id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES provenance_roots(root_id),
 identity_state TEXT NOT NULL CHECK(identity_state IN ('active','deleted','ambiguous')),
 current_version_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS path_history (
 entry_id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES provenance_roots(root_id),
 resource_id TEXT REFERENCES resource_identity(resource_id), relative_path TEXT NOT NULL,
 from_seq INTEGER NOT NULL CHECK(from_seq>=1), to_seq INTEGER CHECK(to_seq>=from_seq),
 state TEXT NOT NULL CHECK(state IN ('active','deleted','ambiguous')),
 evidence TEXT NOT NULL CHECK(evidence IN ('tool_reported','watcher_observed','reconciled','inferred','editor_save','confirmed_receipt')),
 candidates_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provenance_sources (
 provenance_id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES provenance_roots(root_id),
 origin TEXT NOT NULL CHECK(origin IN ('agent','human','unknown')),
 session_id TEXT, turn_id TEXT, task_id TEXT, run_id TEXT, agent_id TEXT,
 execution_run_id TEXT, trace_id TEXT, assistant_message_id TEXT, tool_call_id TEXT, event_id TEXT,
 evidence TEXT NOT NULL CHECK(evidence IN ('tool_reported','watcher_observed','reconciled','inferred','editor_save','confirmed_receipt')),
 created_at INTEGER NOT NULL, details_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provenance_mutations (
 operation_id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES provenance_roots(root_id),
 operation_key TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL, kind TEXT NOT NULL,
 commit_state TEXT NOT NULL CHECK(commit_state IN ('prepared','committed','aborted','reconcile_required')),
 manifest_json TEXT NOT NULL, selection_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 intent_json TEXT NOT NULL, commit_json TEXT, UNIQUE(root_id,seq));
CREATE TABLE IF NOT EXISTS resource_versions (
 version_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource_identity(resource_id),
 parent_version_id TEXT, operation_id TEXT NOT NULL REFERENCES provenance_mutations(operation_id),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=71 AND substr(content_hash,1,7)='sha256:' AND substr(content_hash,8) NOT GLOB '*[^0-9a-f]*'),
 blob_ref TEXT, line_count INTEGER NOT NULL CHECK(line_count>=0 AND line_count<=100000),
 completeness TEXT NOT NULL CHECK(completeness IN ('complete','partial','gap','capacity')),
 observed_at INTEGER NOT NULL, binary INTEGER NOT NULL DEFAULT 0 CHECK(binary IN (0,1)));
CREATE TABLE IF NOT EXISTS line_origin_segments (
 version_id TEXT NOT NULL REFERENCES resource_versions(version_id) ON DELETE CASCADE,
 start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
 provenance_id TEXT NOT NULL REFERENCES provenance_sources(provenance_id),
 mapping_evidence TEXT NOT NULL CHECK(mapping_evidence IN ('exact','carried','inferred','unknown')),
 PRIMARY KEY(version_id,start_line), CHECK(start_line>=1 AND end_line>start_line));
CREATE TABLE IF NOT EXISTS provenance_adoption_events (
 operation_id TEXT NOT NULL REFERENCES provenance_mutations(operation_id),
 provenance_id TEXT NOT NULL REFERENCES provenance_sources(provenance_id), unit_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','applied','partial','discarded','reverted')),
 details_json TEXT NOT NULL, PRIMARY KEY(operation_id,provenance_id,unit_key));
CREATE TABLE IF NOT EXISTS provenance_rename_results (
 operation_key TEXT PRIMARY KEY, claim_json TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provenance_tool_receipts (
 run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, ordinal INTEGER NOT NULL, path TEXT NOT NULL,
 before_hash TEXT, after_hash TEXT, PRIMARY KEY(run_id,ordinal,path));
CREATE TABLE IF NOT EXISTS provenance_blob_pins (
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('mutation','version')), owner_id TEXT NOT NULL,
 hash TEXT NOT NULL, PRIMARY KEY(owner_kind,owner_id,hash));
"#).map_err(|e| format!("apply provenance migration: {e}"))?;
        // Columns added after the research schema are guarded before indexes.
        for (table, column, declaration) in [
            (
                "resource_versions",
                "binary",
                "INTEGER NOT NULL DEFAULT 0 CHECK(binary IN (0,1))",
            ),
            (
                "provenance_mutations",
                "intent_json",
                "TEXT NOT NULL DEFAULT '{}'",
            ),
            ("provenance_mutations", "commit_json", "TEXT"),
        ] {
            let exists: bool = self
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                    params![table, column],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !exists {
                self.connection
                    .execute_batch(&format!(
                        "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
                    ))
                    .map_err(|e| e.to_string())?;
            }
        }
        self.connection.execute_batch(r#"
CREATE UNIQUE INDEX IF NOT EXISTS path_history_current ON path_history(root_id,relative_path) WHERE to_seq IS NULL;
CREATE INDEX IF NOT EXISTS path_history_resource ON path_history(root_id,resource_id,from_seq);
CREATE INDEX IF NOT EXISTS resource_versions_hash ON resource_versions(resource_id,content_hash);
CREATE INDEX IF NOT EXISTS resource_versions_operation ON resource_versions(operation_id);
CREATE INDEX IF NOT EXISTS provenance_sources_run ON provenance_sources(run_id,session_id);
CREATE INDEX IF NOT EXISTS provenance_adoption_source ON provenance_adoption_events(provenance_id,operation_id);
CREATE INDEX IF NOT EXISTS provenance_pins_hash ON provenance_blob_pins(hash);
CREATE INDEX IF NOT EXISTS provenance_mutations_recovery ON provenance_mutations(commit_state,operation_id);
"#).map_err(|e| e.to_string())
    }

    /// Borrow the same connection, transaction boundary, and blob store used by tasks.
    pub fn provenance(&mut self) -> ProvenanceStore<'_> {
        ProvenanceStore { store: self }
    }
}

/// Public storage facade for later capture and query phases.
pub struct ProvenanceStore<'a> {
    store: &'a mut WorkspaceStore,
}

fn id() -> String {
    Uuid::now_v7().to_string()
}
fn invalid(message: &str) -> ProvenanceError {
    ProvenanceError::Invalid(message.into())
}
fn conflict(message: &str) -> ProvenanceError {
    ProvenanceError::Conflict(message.into())
}
fn json<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
fn path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.contains(['\\', '\0', ':'])
        || value
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(invalid("expected normalized relative path"));
    }
    Ok(())
}
fn sequence(c: &Connection, root: &str) -> Result<i64> {
    let n = c.query_row(
        "SELECT next_seq FROM provenance_roots WHERE root_id=?1",
        [root],
        |r| r.get(0),
    )?;
    c.execute(
        "UPDATE provenance_roots SET next_seq=next_seq+1 WHERE root_id=?1",
        [root],
    )?;
    Ok(n)
}
fn root_matches(c: &Connection, table: &str, column: &str, key: &str, root: &str) -> Result<()> {
    let actual: Option<String> = c
        .query_row(
            &format!("SELECT root_id FROM {table} WHERE {column}=?1"),
            [key],
            |r| r.get(0),
        )
        .optional()?;
    if actual.as_deref() != Some(root) {
        return Err(invalid("missing or cross-root reference"));
    }
    Ok(())
}
fn read_path(c: &Connection, root: &str, relative: &str) -> Result<Option<PathEntry>> {
    let mut q = c.prepare("SELECT entry_id,root_id,resource_id,relative_path,from_seq,to_seq,state,evidence,candidates_json FROM path_history WHERE root_id=?1 AND relative_path=?2 AND to_seq IS NULL")?;
    let mut rows = q.query(params![root, relative])?;
    rows.next()?.map(path_row).transpose()
}
fn path_row(r: &rusqlite::Row<'_>) -> Result<PathEntry> {
    Ok(PathEntry {
        entry_id: r.get(0)?,
        root_id: r.get(1)?,
        resource_id: r.get(2)?,
        relative_path: r.get(3)?,
        from_seq: r.get(4)?,
        to_seq: r.get(5)?,
        state: IdentityState::parse(&r.get::<_, String>(6)?)?,
        evidence: OriginEvidence::parse(&r.get::<_, String>(7)?)?,
        candidates: serde_json::from_str(&r.get::<_, String>(8)?)?,
    })
}
fn insert_path(c: &Connection, p: &PathEntry) -> Result<()> {
    c.execute(
        "INSERT INTO path_history VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            p.entry_id,
            p.root_id,
            p.resource_id,
            p.relative_path,
            p.from_seq,
            p.to_seq,
            p.state.sql(),
            p.evidence.sql(),
            json(&p.candidates)?
        ],
    )?;
    Ok(())
}

impl ProvenanceStore<'_> {
    /// Record a trusted host receipt. A repeated ordinal/path must attest the same transition.
    pub fn record_tool_mutation_receipt(&mut self, run_id: &str, tool_call_id: &str, ordinal: u64, relative: &str, before_hash: Option<&str>, after_hash: Option<&str>) -> Result<()> {
        path(relative)?;
        if run_id.is_empty() || tool_call_id.is_empty() || ordinal > i64::MAX as u64 || (before_hash.is_none() && after_hash.is_none()) {
            return Err(invalid("invalid tool mutation receipt"));
        }
        for hash in [before_hash, after_hash].into_iter().flatten() {
            if hash.len() != 71 || !hash.starts_with("sha256:") || !hash[7..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                return Err(invalid("receipt requires canonical content hash"));
            }
        }
        let tx = self.store.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, Option<String>, Option<String>)> = tx.query_row(
            "SELECT tool_call_id,before_hash,after_hash FROM provenance_tool_receipts WHERE run_id=?1 AND ordinal=?2 AND path=?3", params![run_id,ordinal,relative], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional()?;
        if let Some((tool, before, after)) = existing {
            if tool != tool_call_id || before.as_deref() != before_hash || after.as_deref() != after_hash {
                return Err(conflict("receipt ordinal has a different transition"));
            }
        } else {
            tx.execute("INSERT INTO provenance_tool_receipts VALUES (?1,?2,?3,?4,?5,?6)", params![run_id,tool_call_id,ordinal,relative,before_hash,after_hash])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Exact run-local transition match; competing tool calls are ambiguous, never last-wins.
    pub fn matching_tool_mutation_receipt(&self, run_id: &str, relative: &str, before_hash: Option<&str>, after_hash: Option<&str>) -> Result<Option<ToolMutationReceipt>> {
        let mut query = self.store.connection.prepare("SELECT tool_call_id,MIN(ordinal) FROM provenance_tool_receipts WHERE run_id=?1 AND path=?2 AND before_hash IS ?3 AND after_hash IS ?4 GROUP BY tool_call_id ORDER BY tool_call_id LIMIT 2")?;
        let rows = query.query_map(params![run_id,relative,before_hash,after_hash], |r| Ok((r.get::<_, String>(0)?,r.get::<_, u64>(1)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
        if rows.len() != 1 { return Ok(None); }
        let (tool_call_id, ordinal) = rows.into_iter().next().unwrap();
        Ok(Some(ToolMutationReceipt { run_id: run_id.into(), tool_call_id, ordinal, path: relative.into(), before_hash: before_hash.map(str::to_owned), after_hash: after_hash.map(str::to_owned) }))
    }

    /// Register once by the complete security/stream scope; returns the existing ID on retry.
    pub fn register_root(
        &mut self,
        principal: &str,
        host: &str,
        canonical: &str,
        stream: &str,
        fingerprint: Option<&str>,
    ) -> Result<ProvenanceRoot> {
        if [principal, host, canonical, stream]
            .iter()
            .any(|s| s.is_empty())
            || !std::path::Path::new(canonical).is_absolute()
        {
            return Err(invalid(
                "root needs a principal, host, absolute canonical path and stream",
            ));
        }
        self.store.connection.execute("INSERT INTO provenance_roots(root_id,principal_id,host_id,canonical_root,stream_key,repository_fingerprint) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(principal_id,host_id,canonical_root,stream_key) DO NOTHING",params![id(),principal,host,canonical,stream,fingerprint])?;
        self.lookup_root(principal, host, canonical, stream)?
            .ok_or_else(|| invalid("root registration disappeared"))
    }

    /// Lookup does not depend on a task or managed workspace still existing.
    pub fn lookup_root(
        &self,
        principal: &str,
        host: &str,
        canonical: &str,
        stream: &str,
    ) -> Result<Option<ProvenanceRoot>> {
        Ok(self.store.connection.query_row("SELECT root_id,repository_fingerprint FROM provenance_roots WHERE principal_id=?1 AND host_id=?2 AND canonical_root=?3 AND stream_key=?4",params![principal,host,canonical,stream],|r| Ok(ProvenanceRoot {root_id:r.get(0)?,principal_id:principal.into(),host_id:host.into(),canonical_root:canonical.into(),stream_key:stream.into(),repository_fingerprint:r.get(1)?})).optional()?)
    }

    /// Create a new identity. An occupied or ambiguous path is never implicitly reused.
    pub fn create_resource(&mut self, root: &str, relative: &str, now: i64) -> Result<String> {
        let tx = self.store.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let resource = Self::create_resource_in_transaction(&tx, root, relative, now)?;
        tx.commit()?;
        Ok(resource)
    }

    pub fn create_resource_in_transaction(tx: &Transaction<'_>, root: &str, relative: &str, now: i64) -> Result<String> {
        Self::create_resource_with_id_in_transaction(tx, root, relative, &id(), now)
    }

    pub fn create_resource_with_id_in_transaction(tx: &Transaction<'_>, root: &str, relative: &str, resource_id: &str, now: i64) -> Result<String> {
        path(relative)?;
        if read_path(tx, root, relative)?.is_some() {
            return Err(conflict("path is already occupied"));
        }
        let seq = sequence(tx, root)?;
        let resource = resource_id.to_string();
        tx.execute(
            "INSERT INTO resource_identity VALUES (?1,?2,'active',NULL,?3)",
            params![resource, root, now],
        )?;
        insert_path(
            tx,
            &PathEntry {
                entry_id: id(),
                root_id: root.into(),
                resource_id: Some(resource.clone()),
                relative_path: relative.into(),
                from_seq: seq,
                to_seq: None,
                state: IdentityState::Active,
                evidence: OriginEvidence::Inferred,
                candidates: vec![],
            },
        )?;
        Ok(resource)
    }

    /// Resolve an active or ambiguous current path without guessing candidate identity.
    pub fn resolve_path(&self, root: &str, relative: &str) -> Result<Option<PathEntry>> {
        path(relative)?;
        let mut entry = read_path(&self.store.connection, root, relative)?;
        if let Some(p) = &mut entry {
            if let Some(resource) = &p.resource_id {
                let state: String = self.store.connection.query_row(
                    "SELECT identity_state FROM resource_identity WHERE resource_id=?1",
                    [resource],
                    |r| r.get(0),
                )?;
                p.state = IdentityState::parse(&state)?;
                if p.state == IdentityState::Ambiguous && p.candidates.is_empty() {
                    p.candidates.push(resource.clone());
                }
            }
        }
        Ok(entry)
    }

    /// Close a deleted path so a later creation at the same name gets a fresh identity.
    pub fn delete_resource(&mut self, root: &str, relative: &str, evidence: OriginEvidence) -> Result<()> {
        let tx = self.store.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::delete_resource_in_transaction(&tx, root, relative, evidence)?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_resource_in_transaction(tx: &Transaction<'_>, root: &str, relative: &str, evidence: OriginEvidence) -> Result<()> {
        path(relative)?;
        let p = read_path(tx, root, relative)?.ok_or_else(|| invalid("missing path"))?;
        let seq = sequence(tx, root)?;
        tx.execute(
            "UPDATE path_history SET to_seq=?2 WHERE entry_id=?1",
            params![p.entry_id, seq],
        )?;
        if let Some(resource) = &p.resource_id {
            tx.execute(
                "UPDATE resource_identity SET identity_state='deleted' WHERE resource_id=?1",
                [resource],
            )?;
        }
        insert_path(
            tx,
            &PathEntry {
                entry_id: id(),
                from_seq: seq,
                to_seq: Some(seq),
                state: IdentityState::Deleted,
                evidence,
                ..p
            },
        )?;
        Ok(())
    }

    /// Trusted explicit/watcher pairs preserve identity. Hash-derived claims are inferred.
    /// Conflicts close neither candidate's other paths and record an ambiguous target.
    pub fn record_rename(&mut self, claim: &RenameClaim) -> Result<PathEntry> {
        let key = format!("rename:{}", content_hash(json(claim)?.as_bytes()));
        let tx = self.store.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = Self::record_rename_in_transaction(&tx, &key, claim)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn record_rename_in_transaction(tx: &Transaction<'_>, operation_key: &str, claim: &RenameClaim) -> Result<PathEntry> {
        path(&claim.old_path)?;
        path(&claim.new_path)?;
        if operation_key.is_empty() || claim.old_path == claim.new_path {
            return Err(invalid("invalid rename operation key or identical paths"));
        }
        let payload = json(claim)?;
        let existing: Option<(String, String)> = tx.query_row(
            "SELECT claim_json,result_json FROM provenance_rename_results WHERE operation_key=?1",
            [operation_key], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        if let Some((previous, result)) = existing {
            if previous != payload { return Err(conflict("rename operation key has different claim")); }
            return Ok(serde_json::from_str(&result)?);
        }
        let old = read_path(tx, &claim.root_id, &claim.old_path)?;
        let target = read_path(tx, &claim.root_id, &claim.new_path)?;
        let mut candidates = claim.candidates.clone();
        if let Some(p) = &old {
            candidates.extend(p.resource_id.clone());
            candidates.extend(p.candidates.clone());
        }
        if let Some(p) = &target {
            candidates.extend(p.resource_id.clone());
            candidates.extend(p.candidates.clone());
        }
        candidates.sort();
        candidates.dedup();
        for candidate in &candidates {
            root_matches(
                tx,
                "resource_identity",
                "resource_id",
                candidate,
                &claim.root_id,
            )?;
        }
        let (current, identity_state):(Option<String>,String)=match old.as_ref().and_then(|p| p.resource_id.as_ref()) {
            Some(resource)=>tx.query_row("SELECT current_version_id,identity_state FROM resource_identity WHERE resource_id=?1",[resource],|r|Ok((r.get(0)?,r.get(1)?)))?,
            None=>(None,"ambiguous".into()),
        };
        let certain = old
            .as_ref()
            .is_some_and(|p| p.state == IdentityState::Active && p.resource_id.is_some())
            && identity_state == "active"
            && target.is_none()
            && candidates.len() == 1
            && current == claim.expected_version_id;
        let seq = sequence(tx, &claim.root_id)?;
        let evidence = match claim.evidence {
            OriginEvidence::ToolReported
            | OriginEvidence::ConfirmedReceipt
            | OriginEvidence::WatcherObserved => claim.evidence,
            _ => OriginEvidence::Inferred,
        };
        let result = PathEntry {
            entry_id: id(),
            root_id: claim.root_id.clone(),
            resource_id: if certain {
                candidates.first().cloned()
            } else {
                None
            },
            relative_path: claim.new_path.clone(),
            from_seq: seq,
            to_seq: None,
            state: if certain {
                IdentityState::Active
            } else {
                IdentityState::Ambiguous
            },
            evidence,
            candidates: if certain { vec![] } else { candidates.clone() },
        };
        if certain {
            tx.execute(
                "UPDATE path_history SET to_seq=?2 WHERE entry_id=?1",
                params![old.as_ref().unwrap().entry_id, seq],
            )?;
        } else {
            for candidate in &candidates {
                tx.execute(
                    "UPDATE resource_identity SET identity_state='ambiguous' WHERE resource_id=?1",
                    [candidate],
                )?;
            }
            if let Some(p) = target {
                tx.execute(
                    "UPDATE path_history SET to_seq=?2 WHERE entry_id=?1",
                    params![p.entry_id, seq],
                )?;
            }
        }
        insert_path(tx, &result)?;
        tx.execute("INSERT INTO provenance_rename_results VALUES (?1,?2,?3)", params![operation_key,payload,json(&result)?])?;
        Ok(result)
    }

    /// Upsert is immutable except for filling a previously unbound assistant message.
    /// A tool-call ID without confirmed receipt evidence is refused.
    pub fn upsert_source(&mut self, source: &ProvenanceSource) -> Result<()> {
        let mut source = source.clone();
        if source.run_id.is_some() && source.session_id.is_none() {
            return Err(invalid("run source requires durable session identity"));
        }
        if source.provenance_id.is_empty() {
            return Err(invalid("empty provenance ID"));
        }
        if source.tool_call_id.is_some() && source.evidence != OriginEvidence::ConfirmedReceipt {
            return Err(invalid(
                "precise tool link requires confirmed receipt evidence",
            ));
        }
        let tx = self
            .store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(mut existing) = read_source(&tx, &source.provenance_id)? {
            if source.assistant_message_id.is_none() {
                source.assistant_message_id = existing.assistant_message_id.clone();
            }
            if existing.assistant_message_id.is_none() {
                existing.assistant_message_id = source.assistant_message_id.clone();
            }
            if existing != source {
                return Err(conflict("source metadata is immutable"));
            }
        }
        if let (Some(run), Some(session)) = (&source.run_id, &source.session_id) {
            let mut q = tx.prepare(
                "SELECT session_id,assistant_message_id FROM provenance_sources WHERE run_id=?1",
            )?;
            for row in q.query_map([run], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                ))
            })? {
                let (existing_session, message) = row?;
                if source.assistant_message_id.is_none() {
                    source.assistant_message_id = message.clone();
                }
                if existing_session.as_deref() != Some(session)
                    || (message.is_some() && source.assistant_message_id != message)
                {
                    return Err(conflict("run session/message binding differs"));
                }
            }
        }
        tx.execute("INSERT INTO provenance_sources VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) ON CONFLICT(provenance_id) DO UPDATE SET assistant_message_id=excluded.assistant_message_id",params![source.provenance_id,source.root_id,source.origin.sql(),source.session_id,source.turn_id,source.task_id,source.run_id,source.agent_id,source.execution_run_id,source.trace_id,source.assistant_message_id,source.tool_call_id,source.event_id,source.evidence.sql(),source.created_at,json(&source.details)?])?;
        tx.commit()?;
        Ok(())
    }

    /// Retrieve self-contained source metadata after task prune.
    pub fn source(&self, root: &str, provenance_id: &str) -> Result<Option<ProvenanceSource>> {
        let value = read_source(&self.store.connection, provenance_id)?;
        if value.as_ref().is_some_and(|s| s.root_id != root) {
            return Err(invalid("cross-root source"));
        }
        Ok(value)
    }

    /// Idempotently bind every source of a run; refuses different sessions or messages.
    pub fn bind_assistant_message(
        &mut self,
        run: &str,
        session: &str,
        message: &str,
    ) -> Result<usize> {
        if [run, session, message].iter().any(|s| s.is_empty()) {
            return Err(invalid("empty message binding"));
        }
        let tx = self
            .store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let incompatible:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM provenance_sources WHERE run_id=?1 AND (session_id IS NOT ?2 OR (assistant_message_id IS NOT NULL AND assistant_message_id<>?3)))",params![run,session,message],|r|r.get(0))?;
        if incompatible {
            return Err(conflict(
                "run already belongs to a different session or message",
            ));
        }
        let count=tx.execute("UPDATE provenance_sources SET assistant_message_id=?3 WHERE run_id=?1 AND session_id=?2",params![run,session,message])?;
        if count == 0 {
            return Err(invalid("no durable sources for run"));
        }
        tx.commit()?;
        Ok(count)
    }

    /// Persist intent and pins BEFORE filesystem writes. Same key requires identical intent.
    pub fn prepare_mutation(&mut self, intent: &MutationIntent) -> Result<Mutation> {
        if intent.operation_key.is_empty() || intent.kind.is_empty() {
            return Err(invalid("empty operation key/kind"));
        }
        let payload = json(intent)?;
        let tx = self
            .store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = read_mutation(&tx, &intent.operation_key)? {
            let old: String = tx.query_row(
                "SELECT intent_json FROM provenance_mutations WHERE operation_id=?1",
                [&existing.operation_id],
                |r| r.get(0),
            )?;
            if old != payload {
                return Err(conflict("operation key already has a different intent"));
            }
            return Ok(existing);
        }
        let seq = sequence(&tx, &intent.root_id)?;
        let operation = id();
        tx.execute("INSERT INTO provenance_mutations(operation_id,root_id,operation_key,seq,kind,commit_state,manifest_json,selection_json,created_at,intent_json) VALUES (?1,?2,?3,?4,?5,'prepared',?6,?7,?8,?9)",params![operation,intent.root_id,intent.operation_key,seq,intent.kind,json(&intent.manifest)?,json(&intent.selection)?,intent.created_at,payload])?;
        for blob in &intent.blob_refs {
            pin(&tx, "mutation", &operation, blob)?;
        }
        tx.commit()?;
        Ok(Mutation {
            operation_id: operation,
            root_id: intent.root_id.clone(),
            operation_key: intent.operation_key.clone(),
            seq,
            state: MutationCommitState::Prepared,
        })
    }

    /// Read unfinished intents during recovery, or confirm an idempotent commit.
    pub fn mutation(&self, operation_key: &str) -> Result<Option<Mutation>> {
        read_mutation(&self.store.connection, operation_key)
    }

    /// Recover the complete persisted intent without any live task/run state.
    pub fn mutation_intent(&self, operation_key: &str) -> Result<Option<MutationIntent>> {
        self.store.connection.query_row("SELECT intent_json FROM provenance_mutations WHERE operation_key=?1", [operation_key], |r| r.get::<_, String>(0)).optional()?.map(|value| Ok(serde_json::from_str(&value)?)).transpose()
    }

    /// Bounded recovery batch. Completed entries disappear from subsequent batches.
    pub fn pending_mutations(&self, limit: usize) -> Result<Vec<(Mutation, MutationIntent)>> {
        self.pending_mutations_after(None, limit)
    }

    /// Keyset cursor lets recovery advance past unresolved intents without starving later work.
    pub fn pending_mutations_after(&self, after_operation_id: Option<&str>, limit: usize) -> Result<Vec<(Mutation, MutationIntent)>> {
        if limit == 0 || limit > MAX_HISTORY_PER_QUERY {
            return Err(ProvenanceError::Capacity("pending mutation batch must be 1..=100".into()));
        }
        let mut query = self.store.connection.prepare("SELECT operation_key,intent_json FROM provenance_mutations WHERE commit_state IN ('prepared','reconcile_required') AND (?1 IS NULL OR operation_id>?1) ORDER BY operation_id LIMIT ?2")?;
        let rows = query.query_map(params![after_operation_id, limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.map(|row| { let (key, intent) = row?; Ok((read_mutation(&self.store.connection, &key)?.ok_or_else(|| invalid("missing recovery mutation"))?, serde_json::from_str(&intent)?)) }).collect()
    }

    /// Abort only a write known not to have happened; uncertainty retains recovery pins.
    pub fn abort_mutation(
        &mut self,
        operation_key: &str,
        reconcile_required: bool,
    ) -> Result<Mutation> {
        let tx = self
            .store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut m =
            read_mutation(&tx, operation_key)?.ok_or_else(|| invalid("missing mutation"))?;
        if m.state == MutationCommitState::Committed {
            return Err(conflict("cannot abort committed mutation"));
        }
        if m.state == MutationCommitState::Aborted && reconcile_required {
            return Err(conflict("aborted mutation cannot be resurrected"));
        }
        m.state = if reconcile_required {
            MutationCommitState::ReconcileRequired
        } else {
            MutationCommitState::Aborted
        };
        tx.execute(
            "UPDATE provenance_mutations SET commit_state=?2 WHERE operation_id=?1",
            params![m.operation_id, m.state.sql()],
        )?;
        if !reconcile_required {
            tx.execute(
                "DELETE FROM provenance_blob_pins WHERE owner_kind='mutation' AND owner_id=?1",
                [&m.operation_id],
            )?;
        }
        tx.commit()?;
        Ok(m)
    }

    /// Atomically record versions and per-unit adoption. Exact retries return the same
    /// mutation, even after old full-text versions have been compacted. Differing retry
    /// payloads, stale parents, cross-root references and partial commits are refused.
    pub fn commit_mutation(&mut self, operation_key: &str, versions: &[VersionInput], adoptions: &[AdoptionInput]) -> Result<Mutation> {
        self.commit_mutation_with(operation_key, versions, adoptions, |_| Ok(()))
    }

    /// Identity/path and task/patch changes in the closure share the version/adoption commit.
    /// The closure is not called again for an already committed identical operation.
    pub fn commit_mutation_with(&mut self, operation_key: &str, versions: &[VersionInput], adoptions: &[AdoptionInput], before_commit: impl FnOnce(&Transaction<'_>) -> Result<()>) -> Result<Mutation> {
        self.commit_mutation_with_changes(operation_key, versions, adoptions, before_commit, |_| Ok(()))
    }

    /// Apply identity creation/rename before versions and deletion/task state after versions,
    /// all under one SQLite transaction. Neither callback repeats on a committed retry.
    pub fn commit_mutation_with_changes(&mut self, operation_key: &str, versions: &[VersionInput], adoptions: &[AdoptionInput], before_commit: impl FnOnce(&Transaction<'_>) -> Result<()>, after_commit: impl FnOnce(&Transaction<'_>) -> Result<()>) -> Result<Mutation> {
        let payload = content_hash(json(&(versions, adoptions))?.as_bytes());
        // Check committed retries before looking up blobs that compaction may release.
        if let Some(m) = read_mutation(&self.store.connection, operation_key)? {
            if m.state == MutationCommitState::Committed {
                verify_retry(&self.store.connection, &m, &payload)?;
                return Ok(m);
            }
        }
        for version in versions {
            self.validate_version_content(version)?;
        }
        let tx = self.store.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(m) = read_mutation(&tx, operation_key)? {
            if m.state == MutationCommitState::Committed {
                verify_retry(&tx, &m, &payload)?;
                return Ok(m);
            }
        }
        before_commit(&tx)?;
        let m = Self::commit_mutation_in_transaction(&tx, operation_key, versions, adoptions)?;
        after_commit(&tx)?;
        // Bound history on the normal write path, while preserving recovery and undo roots.
        let resources: std::collections::BTreeSet<_> = versions.iter().map(|v| v.resource_id.as_str()).collect();
        for resource in resources {
            compact_resource_in_transaction(&tx, resource, RETAINED_VERSIONS)?;
        }
        tx.commit()?;
        Ok(m)
    }

    /// Transaction-scoped publication; callers must validate version blobs before opening the transaction.
    pub(crate) fn commit_mutation_in_transaction(tx: &Transaction<'_>, operation_key: &str, versions: &[VersionInput], adoptions: &[AdoptionInput]) -> Result<Mutation> {
        let payload = content_hash(json(&(versions, adoptions))?.as_bytes());
        let mut m =
            read_mutation(tx, operation_key)?.ok_or_else(|| invalid("missing mutation"))?;
        if m.state == MutationCommitState::Committed {
            verify_retry(tx, &m, &payload)?;
            return Ok(m);
        }
        if !matches!(
            m.state,
            MutationCommitState::Prepared | MutationCommitState::ReconcileRequired
        ) {
            return Err(conflict("mutation is not committable"));
        }
        for version in versions {
            record_version(tx, &m, version)?;
        }
        for adoption in adoptions {
            root_matches(
                tx,
                "provenance_sources",
                "provenance_id",
                &adoption.provenance_id,
                &m.root_id,
            )?;
            if adoption.unit_key.is_empty() {
                return Err(invalid("empty adoption unit"));
            }
            tx.execute(
                "INSERT INTO provenance_adoption_events VALUES (?1,?2,?3,?4,?5)",
                params![
                    m.operation_id,
                    adoption.provenance_id,
                    adoption.unit_key,
                    adoption.state.sql(),
                    json(&adoption.details)?
                ],
            )?;
        }
        tx.execute("UPDATE provenance_mutations SET commit_state='committed',commit_json=?2 WHERE operation_id=?1",params![m.operation_id,payload])?;
        tx.execute(
            "DELETE FROM provenance_blob_pins WHERE owner_kind='mutation' AND owner_id=?1",
            [&m.operation_id],
        )?;
        m.state = MutationCommitState::Committed;
        Ok(m)
    }

    fn validate_version_content(&mut self, v: &VersionInput) -> Result<()> {
        if v.line_count > 100_000 {
            return Err(ProvenanceError::Capacity("100000 lines".into()));
        }
        if v.version_id.is_empty()
            || v.content_hash.len() != 71
            || !v.content_hash.starts_with("sha256:")
            || !v.content_hash[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("noncanonical content hash or empty version ID"));
        }
        line_map::validate_segments(&v.segments, v.line_count)
            .map_err(|e| invalid(&e.to_string()))?;
        if v.binary && v.line_count != 1 {
            return Err(invalid("binary requires one whole-file unit"));
        }
        if let Some(blob) = &v.blob_ref {
            let size: Option<u64> = self
                .store
                .connection
                .query_row("SELECT size FROM task_blobs WHERE hash=?1", [blob], |r| {
                    r.get(0)
                })
                .optional()?;
            if size.ok_or_else(|| invalid("missing version blob"))? > 2 * 1024 * 1024 {
                return Err(ProvenanceError::Capacity("2 MiB text/blob".into()));
            }
            let bytes = self
                .store
                .get_blob(blob, v.observed_at)
                .map_err(ProvenanceError::Blob)?;
            if content_hash(&bytes) != v.content_hash {
                return Err(invalid("blob does not match canonical content hash"));
            }
            let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
            let count = if binary {
                1
            } else {
                line_map::split_lines(&bytes)
                    .map_err(|e| ProvenanceError::Capacity(e.to_string()))?
                    .len()
            };
            if binary != v.binary || count != v.line_count {
                return Err(invalid("blob layout does not match version"));
            }
        } else if v.completeness == Completeness::Complete {
            return Err(invalid("complete version needs a verifiable blob"));
        }
        Ok(())
    }

    /// Convenience single-version commit. Uses the same atomic path as a multi-file mutation.
    pub fn record_version(
        &mut self,
        operation_key: &str,
        version: &VersionInput,
        adoptions: &[AdoptionInput],
    ) -> Result<Mutation> {
        self.commit_mutation(operation_key, std::slice::from_ref(version), adoptions)
    }

    /// Current metadata of an unambiguous path; ambiguous identity is a typed conflict.
    pub fn current_version(&self, root: &str, relative: &str) -> Result<Option<ResourceVersion>> {
        let Some(p) = self.resolve_path(root, relative)? else {
            return Ok(None);
        };
        if p.state != IdentityState::Active {
            return Err(conflict("ambiguous path identity"));
        }
        let Some(resource) = p.resource_id else {
            return Err(invalid("active path without identity"));
        };
        let c = &self.store.connection;
        let state: String = c.query_row(
            "SELECT identity_state FROM resource_identity WHERE resource_id=?1",
            [&resource],
            |r| r.get(0),
        )?;
        if state != "active" {
            return Err(conflict("ambiguous resource identity"));
        }
        let mut q=c.prepare("SELECT v.version_id,v.resource_id,v.parent_version_id,v.operation_id,v.content_hash,v.blob_ref,v.line_count,v.binary,v.completeness,v.observed_at FROM resource_identity r JOIN resource_versions v ON v.version_id=r.current_version_id WHERE r.resource_id=?1 AND r.root_id=?2")?;
        let mut rows = q.query(params![resource, root])?;
        rows.next()?.map(version_row).transpose()
    }

    /// Query clipped 1-based/end-exclusive segments, at most 2000 per page.
    /// A cursor cannot be reused for a different root, version or line range.
    pub fn segments(
        &self,
        root: &str,
        version: &str,
        range: Range<usize>,
        cursor: Option<&QueryCursor>,
        limit: usize,
    ) -> Result<Page<Segment>> {
        let c = &self.store.connection;
        let (actual,count):(String,usize)=c.query_row("SELECT r.root_id,v.line_count FROM resource_versions v JOIN resource_identity r ON r.resource_id=v.resource_id WHERE v.version_id=?1",[version],|r|Ok((r.get(0)?,r.get(1)?)))?;
        if actual != root {
            return Err(invalid("cross-root version"));
        }
        if range.start < 1 || range.end < range.start || range.end > count + 1 {
            return Err(invalid("line range outside version"));
        }
        let scope = json(&("segments", root, version, range.start, range.end))?;
        let offset = page_offset(&scope, cursor, limit, MAX_SEGMENTS_PER_QUERY)?;
        if range.is_empty() {
            return finish_page(scope, offset, limit, vec![]);
        }
        let mut q=c.prepare("SELECT start_line,end_line,provenance_id,mapping_evidence FROM line_origin_segments WHERE version_id=?1 AND end_line>?2 AND start_line<?3 ORDER BY start_line LIMIT ?4 OFFSET ?5")?;
        let mut rows = q.query(params![version, range.start, range.end, limit + 1, offset])?;
        let mut items = Vec::new();
        while let Some(r) = rows.next()? {
            items.push(Segment {
                start_line: r.get::<_, usize>(0)?.max(range.start),
                end_line: r.get::<_, usize>(1)?.min(range.end),
                provenance_id: r.get(2)?,
                mapping_evidence: MappingEvidence::parse(&r.get::<_, String>(3)?)?,
            });
        }
        finish_page(scope, offset, limit, items)
    }

    /// Path aliases and rename evidence in immutable sequence order; max 100 entries.
    pub fn path_history(
        &self,
        root: &str,
        resource: &str,
        cursor: Option<&QueryCursor>,
        limit: usize,
    ) -> Result<Page<PathEntry>> {
        root_matches(
            &self.store.connection,
            "resource_identity",
            "resource_id",
            resource,
            root,
        )?;
        let scope = json(&("paths", root, resource))?;
        let offset = page_offset(&scope, cursor, limit, MAX_HISTORY_PER_QUERY)?;
        // Ambiguous entries include their candidate IDs, preserving evidence without merging.
        let mut q=self.store.connection.prepare("SELECT entry_id,root_id,resource_id,relative_path,from_seq,to_seq,state,evidence,candidates_json FROM path_history WHERE root_id=?1 AND (resource_id=?2 OR EXISTS(SELECT 1 FROM json_each(candidates_json) WHERE value=?2)) ORDER BY from_seq,entry_id LIMIT ?3 OFFSET ?4")?;
        let mut rows = q.query(params![root, resource, limit + 1, offset])?;
        let mut items = Vec::new();
        while let Some(r) = rows.next()? {
            items.push(path_row(r)?);
        }
        finish_page(scope, offset, limit, items)
    }

    /// Per-source adoption summaries, including deletion and rename units; max 100 entries.
    pub fn adoption_history(
        &self,
        root: &str,
        source: &str,
        cursor: Option<&QueryCursor>,
        limit: usize,
    ) -> Result<Page<AdoptionEvent>> {
        root_matches(
            &self.store.connection,
            "provenance_sources",
            "provenance_id",
            source,
            root,
        )?;
        let scope = json(&("adoption", root, source))?;
        let offset = page_offset(&scope, cursor, limit, MAX_HISTORY_PER_QUERY)?;
        let (after_seq, after_key) = match cursor {
            Some(c) => c
                .after
                .clone()
                .filter(|(seq, key)| *seq > 0 && !key.is_empty())
                .ok_or_else(|| invalid("invalid adoption cursor"))?,
            None => (0, String::new()),
        };
        // Intents receive sequence numbers before commit. Keyset continuation avoids
        // duplicate rows when an earlier intent commits between pages. Such newly
        // committed earlier events are visible on the next fresh history query.
        let mut q=self.store.connection.prepare("SELECT e.operation_id,m.seq,e.unit_key,e.state,e.details_json FROM provenance_adoption_events e JOIN provenance_mutations m ON m.operation_id=e.operation_id WHERE m.root_id=?1 AND e.provenance_id=?2 AND (m.seq>?4 OR (m.seq=?4 AND e.unit_key>?5)) ORDER BY m.seq,e.unit_key LIMIT ?3")?;
        let mut rows = q.query(params![root, source, limit + 1, after_seq, after_key])?;
        let mut items = Vec::new();
        while let Some(r) = rows.next()? {
            items.push(AdoptionEvent {
                operation_id: r.get(0)?,
                seq: r.get(1)?,
                adoption: AdoptionInput {
                    provenance_id: source.into(),
                    unit_key: r.get(2)?,
                    state: AdoptionState::parse(&r.get::<_, String>(3)?)?,
                    details: serde_json::from_str(&r.get::<_, String>(4)?)?,
                },
            });
        }
        let after = items
            .get(limit.saturating_sub(1))
            .map(|event| (event.seq, event.adoption.unit_key.clone()));
        let mut page = finish_page(scope, offset, limit, items)?;
        if let Some(cursor) = &mut page.next_cursor {
            cursor.after = after;
        }
        Ok(page)
    }

    /// Trim ordinary history, preserving current maps, recovery parents and reversible
    /// applied versions. Protected versions may temporarily exceed the ordinary limit.
    /// Blob deletion remains a later ordinary GC; sources/adoption/manifests are durable.
    pub fn compact_provenance(&mut self, limits: CompactionLimits) -> Result<usize> {
        if limits.versions_per_resource == 0 || limits.versions_per_resource > RETAINED_VERSIONS {
            return Err(ProvenanceError::Capacity("retention must be 1..=32 versions".into()));
        }
        let tx = self.store.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let resources = {
            let mut q = tx.prepare("SELECT resource_id FROM resource_identity")?;
            let rows = q.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut removed = 0;
        for resource in resources {
            removed += compact_resource_in_transaction(&tx, &resource, limits.versions_per_resource)?;
        }
        tx.commit()?;
        Ok(removed)
    }

}

/// Safety roots are checked in the same write transaction as version deletion and
/// pin release. A still-reversible patch retains its applied version, whose pins
/// include the pre-apply body and whose immutable manifest contains its origin map.
fn compact_resource_in_transaction(tx: &Transaction<'_>, resource: &str, retain: usize) -> Result<usize> {
    let current: Option<String> = tx.query_row(
        "SELECT current_version_id FROM resource_identity WHERE resource_id=?1", [resource], |r| r.get(0),
    )?;
    let keep = retain - usize::from(current.is_some());
    let old = {
        let mut query = tx.prepare(r#"
SELECT v.version_id FROM resource_versions v
JOIN provenance_mutations owner ON owner.operation_id=v.operation_id
WHERE v.resource_id=?1 AND v.version_id IS NOT ?2
AND v.version_id NOT IN (
 SELECT recent.version_id FROM resource_versions recent
 JOIN provenance_mutations m ON m.operation_id=recent.operation_id
 WHERE recent.resource_id=?1 AND recent.version_id IS NOT ?2
 ORDER BY m.seq DESC,recent.version_id DESC LIMIT ?3
)
AND NOT EXISTS (
 SELECT 1 FROM provenance_mutations pending, json_tree(pending.manifest_json) reference
 WHERE pending.commit_state IN ('prepared','reconcile_required')
 AND reference.key IN ('versionId','parentVersionId') AND reference.value=v.version_id
)
AND NOT EXISTS (
 SELECT 1 FROM task_patch_sets patch
 WHERE json_extract(patch.payload,'$.state') IN ('applied','conflict')
 AND COALESCE(json_extract(patch.payload,'$.reversible'),1)=1
 AND json_extract(patch.payload,'$.appliedRevision') IS NOT NULL
 AND patch.run_id=json_extract(owner.manifest_json,'$.patch.runId')
 AND json_extract(patch.payload,'$.patchId')=json_extract(owner.manifest_json,'$.patch.patchId')
 AND json_extract(patch.payload,'$.appliedRevision')=json_extract(owner.manifest_json,'$.patch.appliedRevision')
)
"#)?;
        let rows = query.query_map(params![resource,current,keep], |r| r.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut removed = 0;
    for version in old {
        tx.execute("DELETE FROM provenance_blob_pins WHERE owner_kind='version' AND owner_id=?1", [&version])?;
        removed += tx.execute("DELETE FROM resource_versions WHERE version_id=?1", [version])?;
    }
    Ok(removed)
}

fn page_offset(
    scope: &str,
    cursor: Option<&QueryCursor>,
    limit: usize,
    max: usize,
) -> Result<usize> {
    if limit == 0 || limit > max {
        return Err(ProvenanceError::Capacity(format!(
            "page size must be 1..={max}"
        )));
    }
    if let Some(c) = cursor {
        if c.scope != scope || c.offset == 0 || c.offset > i64::MAX as usize {
            return Err(invalid("cursor does not belong to query"));
        }
        Ok(c.offset)
    } else {
        Ok(0)
    }
}
fn finish_page<T>(
    scope: String,
    offset: usize,
    limit: usize,
    mut items: Vec<T>,
) -> Result<Page<T>> {
    if offset > 0 && items.is_empty() {
        return Err(invalid("cursor is beyond query history"));
    }
    let more = items.len() > limit;
    if more {
        items.pop();
    }
    Ok(Page {
        items,
        next_cursor: more.then_some(QueryCursor {
            scope,
            offset: offset + limit,
            after: None,
        }),
    })
}
fn version_row(r: &rusqlite::Row<'_>) -> Result<ResourceVersion> {
    Ok(ResourceVersion {
        version_id: r.get(0)?,
        resource_id: r.get(1)?,
        parent_version_id: r.get(2)?,
        operation_id: r.get(3)?,
        content_hash: r.get(4)?,
        blob_ref: r.get(5)?,
        line_count: r.get(6)?,
        binary: r.get(7)?,
        completeness: Completeness::parse(&r.get::<_, String>(8)?)?,
        observed_at: r.get(9)?,
    })
}
fn read_source(c: &Connection, key: &str) -> Result<Option<ProvenanceSource>> {
    let mut q=c.prepare("SELECT provenance_id,root_id,origin,session_id,turn_id,task_id,run_id,agent_id,execution_run_id,trace_id,assistant_message_id,tool_call_id,event_id,evidence,created_at,details_json FROM provenance_sources WHERE provenance_id=?1")?;
    let mut rows = q.query([key])?;
    let Some(r) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(ProvenanceSource {
        provenance_id: r.get(0)?,
        root_id: r.get(1)?,
        origin: ProvenanceOrigin::parse(&r.get::<_, String>(2)?)?,
        session_id: r.get(3)?,
        turn_id: r.get(4)?,
        task_id: r.get(5)?,
        run_id: r.get(6)?,
        agent_id: r.get(7)?,
        execution_run_id: r.get(8)?,
        trace_id: r.get(9)?,
        assistant_message_id: r.get(10)?,
        tool_call_id: r.get(11)?,
        event_id: r.get(12)?,
        evidence: OriginEvidence::parse(&r.get::<_, String>(13)?)?,
        created_at: r.get(14)?,
        details: serde_json::from_str(&r.get::<_, String>(15)?)?,
    }))
}
fn read_mutation(c: &Connection, key: &str) -> Result<Option<Mutation>> {
    let mut q=c.prepare("SELECT operation_id,root_id,operation_key,seq,commit_state FROM provenance_mutations WHERE operation_key=?1")?;
    let mut rows = q.query([key])?;
    let Some(r) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(Mutation {
        operation_id: r.get(0)?,
        root_id: r.get(1)?,
        operation_key: r.get(2)?,
        seq: r.get(3)?,
        state: MutationCommitState::parse(&r.get::<_, String>(4)?)?,
    }))
}
fn verify_retry(c: &Connection, m: &Mutation, payload: &str) -> Result<()> {
    let previous: Option<String> = c.query_row(
        "SELECT commit_json FROM provenance_mutations WHERE operation_id=?1",
        [&m.operation_id],
        |r| r.get(0),
    )?;
    if previous.as_deref() != Some(payload) {
        return Err(conflict(
            "committed operation retried with different payload",
        ));
    }
    Ok(())
}
fn pin(c: &Connection, kind: &str, owner: &str, blob: &str) -> Result<()> {
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_blobs WHERE hash=?1)",
        [blob],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(invalid("cannot pin missing blob"));
    }
    c.execute(
        "INSERT OR IGNORE INTO provenance_blob_pins VALUES (?1,?2,?3)",
        params![kind, owner, blob],
    )?;
    Ok(())
}
fn record_version(c: &Connection, m: &Mutation, v: &VersionInput) -> Result<()> {
    root_matches(
        c,
        "resource_identity",
        "resource_id",
        &v.resource_id,
        &m.root_id,
    )?;
    let (current, state): (Option<String>, String) = c.query_row(
        "SELECT current_version_id,identity_state FROM resource_identity WHERE resource_id=?1",
        [&v.resource_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if current != v.parent_version_id || state != "active" {
        return Err(conflict("stale parent or non-active identity"));
    }
    if let Some(parent) = &current {
        let seq:i64=c.query_row("SELECT m.seq FROM resource_versions v JOIN provenance_mutations m ON m.operation_id=v.operation_id WHERE v.version_id=?1",[parent],|r|r.get(0))?;
        if seq >= m.seq {
            return Err(conflict("out-of-order mutation"));
        }
    }
    for segment in &v.segments {
        root_matches(
            c,
            "provenance_sources",
            "provenance_id",
            &segment.provenance_id,
            &m.root_id,
        )?;
    }
    c.execute("INSERT INTO resource_versions(version_id,resource_id,parent_version_id,operation_id,content_hash,blob_ref,line_count,completeness,observed_at,binary) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![v.version_id,v.resource_id,v.parent_version_id,m.operation_id,v.content_hash,v.blob_ref,v.line_count,v.completeness.sql(),v.observed_at,v.binary])?;
    for segment in &v.segments {
        c.execute(
            "INSERT INTO line_origin_segments VALUES (?1,?2,?3,?4,?5)",
            params![
                v.version_id,
                segment.start_line,
                segment.end_line,
                segment.provenance_id,
                segment.mapping_evidence.sql()
            ],
        )?;
    }
    if let Some(blob) = &v.blob_ref {
        pin(c, "version", &v.version_id, blob)?;
    }
    c.execute(
        "UPDATE resource_identity SET current_version_id=?2 WHERE resource_id=?1",
        params![v.resource_id, v.version_id],
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tempfile::TempDir;

    fn source(root: &str, key: &str) -> ProvenanceSource {
        ProvenanceSource {
            provenance_id: key.into(),
            root_id: root.into(),
            origin: ProvenanceOrigin::Agent,
            session_id: Some("session".into()),
            turn_id: Some("turn".into()),
            task_id: Some("task-provenance".into()),
            run_id: Some("run-provenance".into()),
            agent_id: Some("agent".into()),
            execution_run_id: Some("execution".into()),
            trace_id: Some("trace".into()),
            assistant_message_id: None,
            tool_call_id: None,
            event_id: Some("event".into()),
            evidence: OriginEvidence::Inferred,
            created_at: 1,
            details: serde_json::json!({"receipt":false}),
        }
    }
    fn intent(root: &str, key: &str, blob: &str) -> MutationIntent {
        MutationIntent {
            root_id: root.into(),
            operation_key: key.into(),
            kind: "apply".into(),
            manifest: serde_json::json!({"afterBlob":blob}),
            selection: serde_json::json!([]),
            blob_refs: vec![blob.into()],
            created_at: 1,
        }
    }
    fn version(
        resource: &str,
        parent: Option<String>,
        key: &str,
        blob: &str,
        bytes: &[u8],
    ) -> VersionInput {
        let (line_count, binary) = line_map::inspect_content(bytes).unwrap();
        VersionInput {
            version_id: key.into(),
            resource_id: resource.into(),
            parent_version_id: parent,
            content_hash: content_hash(bytes),
            blob_ref: Some(blob.into()),
            line_count,
            binary,
            segments: if line_count == 0 {
                vec![]
            } else {
                vec![Segment {
                    start_line: 1,
                    end_line: line_count + 1,
                    provenance_id: "source".into(),
                    mapping_evidence: MappingEvidence::Exact,
                }]
            },
            completeness: Completeness::Complete,
            observed_at: 1,
        }
    }
    fn adoption() -> AdoptionInput {
        AdoptionInput {
            provenance_id: "source".into(),
            unit_key: "file:notes.txt".into(),
            state: AdoptionState::Applied,
            details: serde_json::json!({"selectedHunks":["h1"]}),
        }
    }
    /// Used from the real service prune test to exercise this public API end to end.
    pub(crate) fn seed(store: &mut WorkspaceStore) -> (String, String, VersionInput) {
        seed_at_root(store, "/project")
    }

    pub(crate) fn seed_at_root(
        store: &mut WorkspaceStore,
        canonical_root: &str,
    ) -> (String, String, VersionInput) {
        store
            .put_blob("provenance-body", b"agent line\n", 1)
            .unwrap();
        let mut p = store.provenance();
        let root = p
            .register_root("principal", "host", canonical_root, "working-tree", None)
            .unwrap()
            .root_id;
        let resource = p.create_resource(&root, "notes.txt", 1).unwrap();
        p.upsert_source(&source(&root, "source")).unwrap();
        p.prepare_mutation(&intent(&root, "apply-1", "provenance-body"))
            .unwrap();
        let v = version(
            &resource,
            None,
            "version-1",
            "provenance-body",
            b"agent line\n",
        );
        p.record_version("apply-1", &v, &[adoption()]).unwrap();
        p.bind_assistant_message("run-provenance", "session", "message")
            .unwrap();
        (root, resource, v)
    }

    #[test]
    fn provenance_successful_rename_retry_preserves_identity_and_history() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, resource, version) = seed(&mut store);
        let claim = RenameClaim { root_id: root.clone(), old_path: "notes.txt".into(), new_path: "renamed.txt".into(), expected_version_id: Some(version.version_id), evidence: OriginEvidence::ToolReported, candidates: vec![] };
        let first = store.provenance().record_rename(&claim).unwrap();
        let count = store.provenance().path_history(&root, &resource, None, 100).unwrap().items.len();
        drop(store);
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        assert_eq!(store.provenance().record_rename(&claim).unwrap(), first);
        assert_eq!(store.provenance().resolve_path(&root, "renamed.txt").unwrap().unwrap().state, IdentityState::Active);
        assert_eq!(store.provenance().path_history(&root, &resource, None, 100).unwrap().items.len(), count);
    }

    #[test]
    fn provenance_transaction_rolls_back_identity_paths_versions_adoption_and_task_state() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, resource, previous) = seed(&mut store);
        store.connection.execute("CREATE TABLE provenance_test_task_state (value TEXT)", []).unwrap();
        store.provenance().prepare_mutation(&intent(&root, "atomic", "provenance-body")).unwrap();
        let version = version(&resource, Some(previous.version_id.clone()), "atomic-version", "provenance-body", b"agent line\n");
        let claim = RenameClaim { root_id: root.clone(), old_path: "notes.txt".into(), new_path: "atomic.txt".into(), expected_version_id: Some(previous.version_id), evidence: OriginEvidence::ToolReported, candidates: vec![] };
        let bad_adoption = AdoptionInput { provenance_id: "missing-source".into(), ..adoption() };
        assert!(store.provenance().commit_mutation_with("atomic", &[version.clone()], &[bad_adoption], |tx| {
            ProvenanceStore::create_resource_with_id_in_transaction(tx, &root, "new.txt", "new-resource", 1)?;
            ProvenanceStore::delete_resource_in_transaction(tx, &root, "new.txt", OriginEvidence::Inferred)?;
            ProvenanceStore::record_rename_in_transaction(tx, "atomic:rename", &claim)?;
            tx.execute("INSERT INTO provenance_test_task_state VALUES ('applied')", [])?;
            Ok(())
        }).is_err());
        assert!(store.provenance().resolve_path(&root, "atomic.txt").unwrap().is_none());
        assert!(store.provenance().resolve_path(&root, "notes.txt").unwrap().is_some());
        assert_eq!(store.connection.query_row("SELECT COUNT(*) FROM resource_identity WHERE resource_id='new-resource'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(store.connection.query_row("SELECT COUNT(*) FROM provenance_test_task_state", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(store.provenance().mutation("atomic").unwrap().unwrap().state, MutationCommitState::Prepared);
        assert!(store.provenance().commit_mutation_with_changes("atomic", &[version.clone()], &[adoption()], |_| Ok(()), |tx| {
            ProvenanceStore::delete_resource_in_transaction(tx, &root, "notes.txt", OriginEvidence::Inferred)?;
            Err(invalid("simulated task state write failure"))
        }).is_err());
        assert!(store.provenance().resolve_path(&root, "notes.txt").unwrap().is_some());
        assert_eq!(store.provenance().mutation("atomic").unwrap().unwrap().state, MutationCommitState::Prepared);
        let result = store.provenance().commit_mutation_with("atomic", &[version.clone()], &[adoption()], |tx| {
            ProvenanceStore::record_rename_in_transaction(tx, "atomic:rename", &claim)?;
            tx.execute("INSERT INTO provenance_test_task_state VALUES ('applied')", [])?;
            Ok(())
        }).unwrap();
        assert_eq!(result.state, MutationCommitState::Committed);
        store.provenance().commit_mutation_with("atomic", &[version], &[adoption()], |_| panic!("retry must not repeat side effects")).unwrap();
        assert_eq!(store.connection.query_row("SELECT COUNT(*) FROM provenance_test_task_state", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn provenance_pending_recovery_reads_complete_intent_after_reopen() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, resource, previous) = seed(&mut store);
        let version = version(&resource, Some(previous.version_id), "recover-version", "provenance-body", b"agent line\n");
        let mut expected = intent(&root, "recover", "provenance-body");
        expected.manifest = serde_json::to_value(&version).unwrap();
        expected.selection = serde_json::json!(["hunk-2"]);
        store.provenance().prepare_mutation(&expected).unwrap();
        store.provenance().abort_mutation("recover", true).unwrap();
        drop(store);
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let pending = store.provenance().pending_mutations(100).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0.state, MutationCommitState::ReconcileRequired);
        assert_eq!(pending[0].1, expected);
        assert!(store.provenance().pending_mutations_after(Some(&pending[0].0.operation_id), 100).unwrap().is_empty());
        assert_eq!(store.provenance().mutation_intent("recover").unwrap(), Some(expected));
        let version: VersionInput = serde_json::from_value(pending[0].1.manifest.clone()).unwrap();
        store.provenance().commit_mutation(&pending[0].0.operation_key, &[version], &[]).unwrap();
        assert!(store.provenance().pending_mutations(100).unwrap().is_empty());
        assert!(matches!(store.provenance().pending_mutations(101), Err(ProvenanceError::Capacity(_))));
    }

    #[test]
    fn provenance_tool_receipts_require_exact_transition_and_refuse_ambiguity() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let before = content_hash(b"before");
        let after = content_hash(b"after");
        let mut p = store.provenance();
        p.record_tool_mutation_receipt("run", "tool-a", 1, "a.txt", Some(&before), Some(&after)).unwrap();
        p.record_tool_mutation_receipt("run", "tool-a", 1, "a.txt", Some(&before), Some(&after)).unwrap();
        assert_eq!(p.matching_tool_mutation_receipt("run", "a.txt", Some(&before), Some(&after)).unwrap().unwrap().tool_call_id, "tool-a");
        assert!(p.matching_tool_mutation_receipt("run", "a.txt", None, Some(&after)).unwrap().is_none());
        assert!(p.record_tool_mutation_receipt("run", "tool-b", 1, "a.txt", Some(&before), Some(&after)).is_err());
        p.record_tool_mutation_receipt("run", "tool-b", 2, "a.txt", Some(&before), Some(&after)).unwrap();
        assert!(p.matching_tool_mutation_receipt("run", "a.txt", Some(&before), Some(&after)).unwrap().is_none());
        assert!(p.record_tool_mutation_receipt("run", "tool", 3, "a.txt", None, Some("git-oid")).is_err());
        drop(store);
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        assert!(store.provenance().matching_tool_mutation_receipt("run", "a.txt", Some(&before), Some(&after)).unwrap().is_none());
    }

    #[test]
    fn provenance_public_api_survives_reopen_and_preserves_hash_domains() {
        let dir = TempDir::new().unwrap();
        let (root, resource, v) = {
            let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
            seed(&mut store)
        };
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let p = store.provenance();
        let current = p.current_version(&root, "notes.txt").unwrap().unwrap();
        assert_eq!(current.content_hash, content_hash(b"agent line\n"));
        assert_eq!(current.blob_ref.as_deref(), Some("provenance-body"));
        assert_eq!(
            p.segments(&root, &v.version_id, 1..2, None, 2)
                .unwrap()
                .items,
            v.segments
        );
        assert_eq!(
            p.adoption_history(&root, "source", None, 100)
                .unwrap()
                .items[0]
                .adoption,
            adoption()
        );
        assert_eq!(
            p.path_history(&root, &resource, None, 100).unwrap().items[0].relative_path,
            "notes.txt"
        );
        let source = p.source(&root, "source").unwrap().unwrap();
        assert_eq!(source.assistant_message_id.as_deref(), Some("message"));
        assert_eq!(source.task_id.as_deref(), Some("task-provenance"));
        assert_eq!(
            content_hash(b""),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_ne!(content_hash(b"a\n"), content_hash(b"a\r\n"));
        assert_eq!(
            serde_json::to_value(OriginEvidence::ConfirmedReceipt).unwrap(),
            "confirmedReceipt"
        );
    }

    #[test]
    fn provenance_migration_is_idempotent_and_additive_to_pre_provenance_schema() {
        let dir = TempDir::new().unwrap();
        {
            let store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
            // Remove only the new tables to recreate the existing HEAD schema, retaining
            // every existing table and a legacy row across the migration.
            store.connection.execute_batch("DROP TABLE provenance_adoption_events; DROP TABLE line_origin_segments; DROP TABLE resource_versions; DROP TABLE provenance_blob_pins; DROP TABLE provenance_mutations; DROP TABLE path_history; DROP TABLE provenance_sources; DROP TABLE resource_identity; DROP TABLE provenance_roots;").unwrap();
            store
                .connection
                .execute(
                    "INSERT INTO task_workspaces VALUES ('legacy','session','/project','{}')",
                    [],
                )
                .unwrap();
        }
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        store.apply_provenance_migration().unwrap();
        store.apply_provenance_migration().unwrap();
        let (root, _, v) = seed(&mut store);
        let count: i64 = store
            .connection
            .query_row(
                "SELECT count(*) FROM task_workspaces WHERE task_id='legacy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert!(store
            .connection
            .execute("UPDATE provenance_sources SET evidence='made_up'", [])
            .is_err());
        assert!(store
            .connection
            .execute("UPDATE resource_versions SET completeness='made_up'", [])
            .is_err());
        assert!(store
            .connection
            .execute("UPDATE provenance_mutations SET commit_state='made_up'", [])
            .is_err());
        assert!(store
            .connection
            .execute("UPDATE resource_identity SET identity_state='made_up'", [])
            .is_err());
        assert!(store
            .connection
            .execute("UPDATE provenance_sources SET origin='made_up'", [])
            .is_err());
        assert!(store
            .connection
            .execute(
                "UPDATE line_origin_segments SET mapping_evidence='made_up'",
                []
            )
            .is_err());
        assert!(store
            .connection
            .execute("UPDATE provenance_adoption_events SET state='made_up'", [])
            .is_err());
        drop(store);
        let mut reopened = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        assert_eq!(
            reopened
                .provenance()
                .current_version(&root, "notes.txt")
                .unwrap()
                .unwrap()
                .version_id,
            v.version_id
        );
    }

    #[test]
    fn provenance_rename_evidence_conflicts_and_recreation() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, resource, v) = seed(&mut store);
        let mut p = store.provenance();
        for (old, new, evidence, want) in [
            (
                "notes.txt",
                "explicit.txt",
                OriginEvidence::ToolReported,
                OriginEvidence::ToolReported,
            ),
            (
                "explicit.txt",
                "watched.txt",
                OriginEvidence::WatcherObserved,
                OriginEvidence::WatcherObserved,
            ),
            (
                "watched.txt",
                "hash.txt",
                OriginEvidence::Reconciled,
                OriginEvidence::Inferred,
            ),
        ] {
            let r = p
                .record_rename(&RenameClaim {
                    root_id: root.clone(),
                    old_path: old.into(),
                    new_path: new.into(),
                    expected_version_id: Some(v.version_id.clone()),
                    evidence,
                    candidates: vec![],
                })
                .unwrap();
            assert_eq!(r.resource_id.as_deref(), Some(resource.as_str()));
            assert_eq!(r.evidence, want);
            assert!(p.resolve_path(&root, old).unwrap().is_none());
        }
        let duplicate = p.create_resource(&root, "duplicate.txt", 2).unwrap();
        let ambiguous = p
            .record_rename(&RenameClaim {
                root_id: root.clone(),
                old_path: "hash.txt".into(),
                new_path: "duplicate.txt".into(),
                expected_version_id: Some(v.version_id),
                evidence: OriginEvidence::Inferred,
                candidates: vec![duplicate.clone()],
            })
            .unwrap();
        assert_eq!(ambiguous.state, IdentityState::Ambiguous);
        assert_eq!(ambiguous.resource_id, None);
        assert!(ambiguous.candidates.contains(&resource));
        assert!(ambiguous.candidates.contains(&duplicate));
        assert!(p.current_version(&root, "duplicate.txt").is_err());
        assert!(p.current_version(&root, "hash.txt").is_err());
        let again = p
            .record_rename(&RenameClaim {
                root_id: root.clone(),
                old_path: "hash.txt".into(),
                new_path: "still-ambiguous.txt".into(),
                expected_version_id: Some("version-1".into()),
                evidence: OriginEvidence::ToolReported,
                candidates: vec![],
            })
            .unwrap();
        assert_eq!(again.state, IdentityState::Ambiguous);
        assert_eq!(
            p.path_history(&root, &resource, None, 100)
                .unwrap()
                .items
                .len(),
            6
        );
        let fresh = p.create_resource(&root, "fresh.txt", 3).unwrap();
        p.delete_resource(&root, "fresh.txt", OriginEvidence::WatcherObserved)
            .unwrap();
        assert_ne!(p.create_resource(&root, "fresh.txt", 4).unwrap(), fresh);
    }

    #[test]
    fn provenance_stale_rename_and_cross_root_candidates_are_not_merged() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, resource, _) = seed(&mut store);
        let mut p = store.provenance();
        let claim = RenameClaim {
            root_id: root.clone(),
            old_path: "notes.txt".into(),
            new_path: "stale.txt".into(),
            expected_version_id: None,
            evidence: OriginEvidence::ConfirmedReceipt,
            candidates: vec![],
        };
        assert_eq!(
            p.record_rename(&claim).unwrap().state,
            IdentityState::Ambiguous
        );
        let other = p
            .register_root("other", "host", "/project", "working-tree", None)
            .unwrap();
        let foreign = p.create_resource(&other.root_id, "foreign.txt", 1).unwrap();
        assert!(p
            .record_rename(&RenameClaim {
                new_path: "cross.txt".into(),
                candidates: vec![foreign],
                ..claim
            })
            .is_err());
        assert!(p
            .path_history(&root, &resource, None, 100)
            .unwrap()
            .items
            .iter()
            .any(|x| x.relative_path == "stale.txt"));
    }

    #[test]
    fn provenance_intent_idempotence_atomicity_binding_and_receipt_rules() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, resource, v) = seed(&mut store);
        let mut p = store.provenance();
        let prepared = p
            .prepare_mutation(&intent(&root, "apply-1", "provenance-body"))
            .unwrap();
        assert_eq!(prepared.state, MutationCommitState::Committed);
        assert_eq!(
            p.record_version("apply-1", &v, &[adoption()]).unwrap(),
            prepared
        );
        let mut changed = v.clone();
        changed.content_hash = content_hash(b"other");
        assert!(p
            .record_version("apply-1", &changed, &[adoption()])
            .is_err());
        let mut changed_intent = intent(&root, "apply-1", "provenance-body");
        changed_intent.kind = "undo".into();
        assert!(p.prepare_mutation(&changed_intent).is_err());
        p.bind_assistant_message("run-provenance", "session", "message")
            .unwrap();
        p.upsert_source(&source(&root, "source")).unwrap();
        p.upsert_source(&source(&root, "late-source")).unwrap();
        assert_eq!(
            p.source(&root, "late-source")
                .unwrap()
                .unwrap()
                .assistant_message_id
                .as_deref(),
            Some("message")
        );
        assert!(p
            .bind_assistant_message("run-provenance", "session", "different")
            .is_err());
        assert!(p
            .bind_assistant_message("run-provenance", "other-session", "message")
            .is_err());
        let mut s = source(&root, "untrusted");
        s.tool_call_id = Some("tool".into());
        assert!(p.upsert_source(&s).is_err());
        s.evidence = OriginEvidence::ConfirmedReceipt;
        s.assistant_message_id = Some("message".into());
        p.upsert_source(&s).unwrap();
        let next = intent(&root, "apply-2", "provenance-body");
        assert_eq!(
            p.prepare_mutation(&next).unwrap(),
            p.prepare_mutation(&next).unwrap()
        );
        let mut valid = version(
            &resource,
            Some(v.version_id.clone()),
            "version-2",
            "provenance-body",
            b"agent line\n",
        );
        let mut invalid = valid.clone();
        invalid.version_id = "version-3".into();
        invalid.parent_version_id = Some("nonexistent".into());
        assert!(p
            .commit_mutation("apply-2", &[valid.clone(), invalid], &[])
            .is_err());
        assert_eq!(
            p.current_version(&root, "notes.txt")
                .unwrap()
                .unwrap()
                .version_id,
            v.version_id
        );
        assert_eq!(
            p.mutation("apply-2").unwrap().unwrap().state,
            MutationCommitState::Prepared
        );
        valid.segments[0].end_line = 3;
        assert!(p.record_version("apply-2", &valid, &[]).is_err());
        p.abort_mutation("apply-2", true).unwrap();
        assert_eq!(
            p.mutation("apply-2").unwrap().unwrap().state,
            MutationCommitState::ReconcileRequired
        );
        valid.segments[0].end_line = 2;
        p.record_version("apply-2", &valid, &[]).unwrap();
        assert!(p.abort_mutation("apply-2", false).is_err());
        p.prepare_mutation(&intent(&root, "cancel", "provenance-body"))
            .unwrap();
        assert_eq!(
            p.abort_mutation("cancel", false).unwrap().state,
            MutationCommitState::Aborted
        );
        assert!(p.record_version("cancel", &valid, &[]).is_err());
    }

    #[test]
    fn provenance_blob_gc_pins_prepared_current_and_releases_aborted() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, _, _) = seed(&mut store);
        store.put_blob("recovery", b"recovery", 1).unwrap();
        store.put_blob("garbage", b"garbage", 1).unwrap();
        store
            .provenance()
            .prepare_mutation(&intent(&root, "recovery-op", "recovery"))
            .unwrap();
        assert_eq!(store.prune_unreferenced_blobs().unwrap().0, 1);
        assert_eq!(
            store.get_blob("provenance-body", 2).unwrap(),
            b"agent line\n"
        );
        store
            .provenance()
            .abort_mutation("recovery-op", true)
            .unwrap();
        assert_eq!(store.prune_unreferenced_blobs().unwrap().0, 0);
        store
            .provenance()
            .abort_mutation("recovery-op", false)
            .unwrap();
        assert_eq!(store.prune_unreferenced_blobs().unwrap().0, 1);
        assert!(store.get_blob("recovery", 2).is_err());
    }

    #[test]
    fn provenance_runtime_retention_preserves_pending_parents_until_resolved() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, resource, first) = seed(&mut store);
        let mut pending = intent(&root, "pending-parent", "provenance-body");
        pending.manifest = serde_json::json!({"paths":[{"version":{"parentVersionId":first.version_id}}]});
        store.provenance().prepare_mutation(&pending).unwrap();
        store.provenance().abort_mutation("pending-parent", true).unwrap();
        let mut previous = first.version_id.clone();
        for n in 2..=40 {
            let bytes = format!("pending retention {n}\n").into_bytes();
            let key = format!("pending-version-{n}");
            store.put_blob(&key, &bytes, n).unwrap();
            store.provenance().prepare_mutation(&intent(&root, &key, &key)).unwrap();
            let next = version(&resource, Some(previous), &key, &key, &bytes);
            store.provenance().record_version(&key, &next, &[]).unwrap();
            previous = key;
        }
        let count = |store: &WorkspaceStore| store.connection.query_row("SELECT COUNT(*) FROM resource_versions", [], |r| r.get::<_, usize>(0)).unwrap();
        assert_eq!(count(&store), RETAINED_VERSIONS + 1);
        store.prune_unreferenced_blobs().unwrap();
        assert_eq!(store.get_blob("provenance-body", 50).unwrap(), b"agent line\n");
        assert_eq!(store.provenance().segments(&root, &first.version_id, 1..2, None, 100).unwrap().items[0].provenance_id, "source");
        store.provenance().abort_mutation("pending-parent", false).unwrap();
        store.prune_unreferenced_blobs().unwrap();
        assert_eq!(count(&store), RETAINED_VERSIONS);
        assert!(store.get_blob("provenance-body", 51).is_err());
        assert_eq!(store.provenance().current_version(&root, "notes.txt").unwrap().unwrap().version_id, previous);
    }

    #[test]
    fn provenance_prune_releases_retention_exceptions_but_preserves_live_undo() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, resource, first) = seed(&mut store);
        let mut previous = first.version_id;
        for n in 2..=40 {
            let task_id = format!("retention-task-{n}");
            let key = format!("retention-version-{n}");
            let undo_blob = format!("retention-before-{n}");
            let bytes = format!("agent version {n}\n").into_bytes();
            let before = format!("earlier origin {n}\n").into_bytes();
            store.put_blob(&key, &bytes, n).unwrap();
            store.put_blob(&undo_blob, &before, n).unwrap();
            store.connection.execute("INSERT INTO task_workspaces VALUES (?1,'session','/project','{}')", [&task_id]).unwrap();
            let patch = crate::PatchSet {
                patch_id: format!("retention-patch-{n}"), task_id: task_id.clone(), run_id: key.clone(),
                state: if n == 2 { crate::PatchState::Conflict } else { crate::PatchState::Applied },
                base_revision: n as u64 - 1, applied_revision: Some(n as u64), files: vec![],
                applied_files: vec![crate::AppliedFile { path: "notes.txt".into(), before_apply_hash: Some(undo_blob.clone()), after_apply_hash: Some(key.clone()), before_kind: Some(crate::ResourceKind::File), after_kind: Some(crate::ResourceKind::File), before_mode: None, after_mode: None, binary: false }],
                applied_selection: vec![], applied_selection_known: true, reversible: true, created_at: n,
            };
            store.put_patch_set(&patch).unwrap();
            let next = version(&resource, Some(previous), &key, &key, &bytes);
            let mut prepared = intent(&root, &key, &key);
            prepared.blob_refs.push(undo_blob.clone());
            prepared.manifest = serde_json::json!({"patch":patch,"paths":[{"before_blob":undo_blob,"before_segments":next.segments,"version":next}]});
            store.provenance().prepare_mutation(&prepared).unwrap();
            store.provenance().commit_mutation_with(&key, &[next], &[], |tx| pin(tx, "version", &key, &undo_blob)).unwrap();
            previous = key;
        }
        let count = |store: &WorkspaceStore| store.connection.query_row("SELECT COUNT(*) FROM resource_versions", [], |r| r.get::<_, usize>(0)).unwrap();
        assert_eq!(count(&store), 39);
        for n in 3..=40 { store.delete_task(&format!("retention-task-{n}")).unwrap(); }
        store.prune_unreferenced_blobs().unwrap();
        assert_eq!(count(&store), RETAINED_VERSIONS + 1);
        assert_eq!(store.get_blob("retention-before-2", 50).unwrap(), b"earlier origin 2\n");
        assert_eq!(store.provenance().segments(&root, "retention-version-2", 1..2, None, 100).unwrap().items[0].provenance_id, "source");
        assert_eq!(store.provenance().mutation_intent("retention-version-2").unwrap().unwrap().manifest["paths"][0]["before_segments"][0]["provenanceId"], "source");
        assert!(store.get_blob("retention-before-3", 50).is_err());
        store.delete_task("retention-task-2").unwrap();
        store.prune_unreferenced_blobs().unwrap();
        assert_eq!(count(&store), RETAINED_VERSIONS);
        assert!(store.get_blob("retention-before-2", 51).is_err());
        assert_eq!(store.connection.query_row("SELECT COUNT(*) FROM provenance_blob_pins WHERE owner_kind='version'", [], |r| r.get::<_, usize>(0)).unwrap(), RETAINED_VERSIONS * 2);
        assert!(store.provenance().source(&root, "source").unwrap().is_some());
    }

    #[test]
    fn provenance_compaction_preserves_current_sources_adoption_and_aba() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, resource, original) = seed(&mut store);
        let mut previous = original.version_id.clone();
        for n in 2..=36 {
            let bytes = if n == 36 {
                b"agent line\n".to_vec()
            } else {
                format!("version {n}\n").into_bytes()
            };
            let blob = format!("blob-{n}");
            store.put_blob(&blob, &bytes, n).unwrap();
            let mut p = store.provenance();
            let op = format!("operation-{n}");
            p.prepare_mutation(&intent(&root, &op, &blob)).unwrap();
            let v = version(
                &resource,
                Some(previous),
                &format!("version-{n}"),
                &blob,
                &bytes,
            );
            p.record_version(&op, &v, &[adoption()]).unwrap();
            previous = v.version_id;
        }
        assert_eq!(store.connection.query_row("SELECT COUNT(*) FROM resource_versions WHERE resource_id=?1", [&resource], |r| r.get::<_, usize>(0)).unwrap(), RETAINED_VERSIONS);
        let mut p = store.provenance();
        assert_eq!(
            p.current_version(&root, "notes.txt")
                .unwrap()
                .unwrap()
                .content_hash,
            original.content_hash
        );
        assert_eq!(
            p.compact_provenance(CompactionLimits::default()).unwrap(),
            0
        );
        assert_eq!(
            p.compact_provenance(CompactionLimits::default()).unwrap(),
            0
        );
        assert_eq!(
            p.compact_provenance(CompactionLimits {
                versions_per_resource: 1
            })
            .unwrap(),
            31
        );
        assert_eq!(
            p.current_version(&root, "notes.txt")
                .unwrap()
                .unwrap()
                .version_id,
            "version-36"
        );
        assert_eq!(
            p.segments(&root, "version-36", 1..2, None, 100)
                .unwrap()
                .items[0]
                .provenance_id,
            "source"
        );
        assert_eq!(
            p.adoption_history(&root, "source", None, 100)
                .unwrap()
                .items
                .len(),
            36
        );
        assert_eq!(
            p.source(&root, "source")
                .unwrap()
                .unwrap()
                .assistant_message_id
                .as_deref(),
            Some("message")
        );
        assert_eq!(
            p.record_version("apply-1", &original, &[adoption()])
                .unwrap()
                .state,
            MutationCommitState::Committed
        );
        assert_eq!(store.prune_unreferenced_blobs().unwrap().0, 35);
        assert!(store.get_blob("blob-36", 2).is_ok());
    }

    #[test]
    fn provenance_queries_are_bounded_scoped_clipped_and_paginated() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, resource, old) = seed(&mut store);
        store.put_blob("multi", b"a\nb\nc\n", 1).unwrap();
        let mut p = store.provenance();
        p.prepare_mutation(&intent(&root, "multi-op", "multi"))
            .unwrap();
        let mut v = version(
            &resource,
            Some(old.version_id),
            "multi-version",
            "multi",
            b"a\nb\nc\n",
        );
        v.segments = (1..=3)
            .map(|n| Segment {
                start_line: n,
                end_line: n + 1,
                provenance_id: "source".into(),
                mapping_evidence: if n == 2 {
                    MappingEvidence::Inferred
                } else {
                    MappingEvidence::Carried
                },
            })
            .collect();
        p.record_version("multi-op", &v, &[adoption()]).unwrap();
        assert!(p
            .segments(&root, "multi-version", 2..2, None, 1)
            .unwrap()
            .items
            .is_empty());
        let first = p.segments(&root, "multi-version", 1..4, None, 1).unwrap();
        assert_eq!(first.items.len(), 1);
        let cursor = first.next_cursor.unwrap();
        assert_eq!(
            p.segments(&root, "multi-version", 1..4, Some(&cursor), 2)
                .unwrap()
                .items,
            v.segments[1..]
        );
        assert!(p
            .segments(&root, "multi-version", 2..4, Some(&cursor), 2)
            .is_err());
        assert!(p.segments("other", "multi-version", 1..4, None, 2).is_err());
        assert!(matches!(
            p.segments(&root, "multi-version", 1..4, None, 2001),
            Err(ProvenanceError::Capacity(_))
        ));
        assert!(p.segments(&root, "multi-version", 0..4, None, 1).is_err());
        assert!(p.segments(&root, "multi-version", 1..5, None, 1).is_err());
        let page = p.adoption_history(&root, "source", None, 1).unwrap();
        assert!(p
            .adoption_history(&root, "source", page.next_cursor.as_ref(), 1)
            .unwrap()
            .next_cursor
            .is_none());
        assert!(matches!(
            p.path_history(&root, &resource, None, 101),
            Err(ProvenanceError::Capacity(_))
        ));
        assert!(p
            .segments(
                &root,
                "multi-version",
                1..4,
                Some(&QueryCursor {
                    scope: cursor.scope,
                    offset: 500,
                    after: None,
                }),
                1
            )
            .is_err());
    }

    #[test]
    fn provenance_adoption_cursor_tolerates_earlier_intent_finishing_between_pages() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 1 << 20).unwrap();
        let (root, _, _) = seed(&mut store);
        let mut p = store.provenance();
        p.prepare_mutation(&intent(&root, "delayed", "provenance-body"))
            .unwrap();
        for key in ["later-one", "later-two"] {
            p.prepare_mutation(&intent(&root, key, "provenance-body"))
                .unwrap();
            p.commit_mutation(key, &[], &[adoption()]).unwrap();
        }
        let first = p.adoption_history(&root, "source", None, 2).unwrap();
        let expected = p.mutation("later-two").unwrap().unwrap().operation_id;
        p.commit_mutation("delayed", &[], &[adoption()]).unwrap();
        let second = p
            .adoption_history(&root, "source", first.next_cursor.as_ref(), 2)
            .unwrap();
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].operation_id, expected);
        assert_eq!(
            p.adoption_history(&root, "source", None, 100)
                .unwrap()
                .items
                .len(),
            4
        );
    }

    #[test]
    fn provenance_binary_capacity_missing_blob_and_cross_root_source_refusal() {
        let dir = TempDir::new().unwrap();
        let mut store = WorkspaceStore::open(dir.path(), 4 << 20).unwrap();
        let (root, resource, old) = seed(&mut store);
        store.put_blob("binary", b"a\0b", 1).unwrap();
        let mut p = store.provenance();
        p.prepare_mutation(&intent(&root, "binary-op", "binary"))
            .unwrap();
        let v = version(
            &resource,
            Some(old.version_id),
            "binary-version",
            "binary",
            b"a\0b",
        );
        p.record_version("binary-op", &v, &[]).unwrap();
        assert!(
            p.current_version(&root, "notes.txt")
                .unwrap()
                .unwrap()
                .binary
        );
        let mut huge = v.clone();
        huge.version_id = "huge".into();
        huge.line_count = 100001;
        assert!(matches!(
            p.record_version("unprepared", &huge, &[]),
            Err(ProvenanceError::Capacity(_))
        ));
        let other = p
            .register_root("other", "host", "/project", "working-tree", None)
            .unwrap();
        let mut foreign = source(&other.root_id, "foreign");
        foreign.run_id = None;
        p.upsert_source(&foreign).unwrap();
        p.prepare_mutation(&intent(&root, "foreign-op", "binary"))
            .unwrap();
        let mut wrong = v.clone();
        wrong.version_id = "wrong".into();
        wrong.parent_version_id = Some(v.version_id.clone());
        wrong.segments[0].provenance_id = "foreign".into();
        assert!(p.record_version("foreign-op", &wrong, &[]).is_err());
        wrong.segments[0].provenance_id = "source".into();
        wrong.blob_ref = Some("absent".into());
        assert!(p.record_version("foreign-op", &wrong, &[]).is_err());
        wrong.blob_ref = None;
        assert!(p.record_version("foreign-op", &wrong, &[]).is_err());
        assert!(p
            .prepare_mutation(&intent(&root, "missing-pin", "absent"))
            .is_err());
        assert!(p.mutation("missing-pin").unwrap().is_none());
        store
            .put_blob("too-large", &vec![b'x'; 2 * 1024 * 1024 + 1], 1)
            .unwrap();
        wrong.blob_ref = Some("too-large".into());
        assert!(matches!(
            store.provenance().record_version("foreign-op", &wrong, &[]),
            Err(ProvenanceError::Capacity(_))
        ));
    }
}
