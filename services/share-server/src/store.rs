//! Persistent share storage backed by a single SQLite file.
//!
//! Where the Cloudflare Worker splits an opaque envelope across R2 (the body)
//! and KV (the lifecycle metadata) — and must lazily reap orphans when KV
//! expires before R2 — this keeps **one row per share**. That collapses the
//! Worker's cross-store atomicity gap: a view increments the counter and may
//! delete the row inside a single `BEGIN IMMEDIATE` transaction, so concurrent
//! reads of a max-views share can never over-serve it.
//!
//! All methods are synchronous (rusqlite) and meant to be called from
//! `tokio::task::spawn_blocking` on the async side.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::Context;
use cognia_share_core::blobs::{
    validate_commit, CommitError, MAX_BLOBS_PER_SHARE, MAX_SHARE_BLOB_BYTES,
};
use cognia_share_core::policy::{evaluate_read, ReadDecision};
use cognia_share_core::proto::ShareMeta;
use cognia_share_core::ticket::ticket_expiry;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

type Pool = r2d2::Pool<SqliteConnectionManager>;

/// One row of an org's share listing.
///
/// Deliberately not `ShareMeta`: the envelope is never here, and neither is
/// the owner token — a listing is for an operator deciding what to revoke, and
/// handing back the per-share secret would turn a read into a grant.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgShare {
    pub code: String,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_views: Option<u64>,
    pub view_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator_user_id: Option<String>,
}

/// Public lifecycle hints, with no envelope or owner/tenant information.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicMetadata {
    pub passphrase: bool,
    pub burn_after_read: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_views: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

/// Wire field names pinned against the Worker and canonical contract fixture.
pub const PUBLIC_METADATA_FIELDS: [&str; 4] =
    ["passphrase", "burnAfterRead", "maxViews", "expiresAt"];

fn envelope_has_passphrase(envelope: &str) -> anyhow::Result<bool> {
    let value: serde_json::Value = serde_json::from_str(envelope)?;
    Ok(value.get("pp").is_some_and(|pp| !pp.is_null()))
}

/// Result of a read attempt that has already applied the lifecycle decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOutcome {
    /// No servable share — return `404`.
    NotFound,
    /// Serve this opaque envelope JSON text verbatim, with a read ticket
    /// valid until `ticket_expires_at` for the share's file blobs.
    Served {
        envelope: String,
        ticket_expires_at: i64,
    },
}

/// Result of storing one encrypted chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutChunkOutcome {
    Stored,
    /// The share is gone, expired or used up — `404`.
    NotFound,
    /// The blob is already committed and immutable — `409`.
    Committed,
    /// A new blob would exceed `MAX_BLOBS_PER_SHARE` — `413`.
    TooManyBlobs,
    /// The chunk would take the share past `MAX_SHARE_BLOB_BYTES` — `413`.
    QuotaExceeded,
}

/// Result of committing a blob.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitOutcome {
    Committed,
    /// The share or the blob is gone — `404`.
    NotFound,
    /// The uploaded chunks do not match the declaration — `400`.
    Invalid(CommitError),
    /// The blob was committed before with a different declaration — `409`.
    Conflict,
}

#[derive(Clone)]
pub struct Store {
    pool: Pool,
    /// Root of the encrypted chunk files: `<blob_dir>/<code>/<blob_id>/<index>`.
    blob_dir: PathBuf,
}

/// Where a database's chunk files live when no directory is configured:
/// beside the database, so one mounted volume holds both.
pub fn default_blob_dir(db_path: &str) -> PathBuf {
    PathBuf::from(format!("{db_path}.blobs"))
}

impl Store {
    /// Open (creating if needed) the SQLite database at `path` and ensure the
    /// schema exists. WAL + `synchronous=NORMAL` give durable, concurrent-read
    /// performance without an external service.
    pub fn open(path: &str) -> anyhow::Result<Self> {
        Self::open_with_blob_dir(path, &default_blob_dir(path))
    }

    /// [`Store::open`] with an explicit chunk-file directory.
    pub fn open_with_blob_dir(path: &str, blob_dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(blob_dir)
            .with_context(|| format!("create blob directory {}", blob_dir.display()))?;
        let manager = SqliteConnectionManager::file(path).with_init(|c| {
            c.execute_batch(
                "PRAGMA journal_mode=WAL;\
                 PRAGMA synchronous=NORMAL;\
                 PRAGMA busy_timeout=5000;\
                 PRAGMA foreign_keys=ON;",
            )
        });
        let pool = Pool::builder()
            .build(manager)
            .context("build sqlite connection pool")?;
        {
            let conn = pool.get().context("get sqlite connection")?;
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS shares (
                     code            TEXT PRIMARY KEY,
                     envelope        TEXT NOT NULL,
                     created_at      INTEGER NOT NULL,
                     expires_at      INTEGER,
                     max_views       INTEGER,
                     burn_after_read INTEGER NOT NULL,
                     view_count      INTEGER NOT NULL,
                     revoked         INTEGER NOT NULL,
                     owner_token     TEXT
                 );
                 CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);",
            )
            .context("create schema")?;
            ensure_owner_token_column(&conn).context("migrate owner token column")?;
            ensure_tenancy_columns(&conn).context("migrate tenancy columns")?;
            // Nullable so legacy rows can recover the hint from their envelope.
            add_column_if_missing(&conn, "passphrase").context("migrate passphrase column")?;
            // ADR-0222 file blobs. Deliberately no foreign key to `shares`:
            // a share's last view deletes its row, but the read ticket that
            // view issued keeps its files downloadable until `retain_until`.
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS share_blobs (
                     code         TEXT NOT NULL,
                     blob_id      TEXT NOT NULL,
                     committed    INTEGER NOT NULL DEFAULT 0,
                     chunk_count  INTEGER,
                     total_bytes  INTEGER,
                     stored_bytes INTEGER NOT NULL DEFAULT 0,
                     created_at   INTEGER NOT NULL,
                     retain_until INTEGER,
                     PRIMARY KEY (code, blob_id)
                 );
                 CREATE TABLE IF NOT EXISTS share_blob_chunks (
                     code    TEXT NOT NULL,
                     blob_id TEXT NOT NULL,
                     idx     INTEGER NOT NULL,
                     bytes   INTEGER NOT NULL,
                     PRIMARY KEY (code, blob_id, idx)
                 );
                 CREATE INDEX IF NOT EXISTS idx_share_blobs_retain ON share_blobs(retain_until);",
            )
            .context("create blob schema")?;
        }
        Ok(Self {
            pool,
            blob_dir: blob_dir.to_path_buf(),
        })
    }

    fn share_dir(&self, code: &str) -> PathBuf {
        self.blob_dir.join(code)
    }

    fn chunk_path(&self, code: &str, blob_id: &str, index: u64) -> PathBuf {
        self.share_dir(code).join(blob_id).join(index.to_string())
    }

    /// Remove every chunk file of `code`. A missing directory is success.
    fn purge_files(&self, code: &str) {
        match std::fs::remove_dir_all(self.share_dir(code)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(target: "share", %error, "removing a share's blob files failed");
            }
        }
    }

    /// Insert a new share. `envelope` is the opaque JSON text stored verbatim.
    ///
    /// Returns `false` when `code` is taken — by a live share, or by the
    /// retained files of a share whose last view was moments ago. The caller
    /// mints another code; reusing this one would hand a new share someone
    /// else's files.
    pub fn create(&self, code: &str, envelope: &str, meta: &ShareMeta) -> anyhow::Result<bool> {
        let mut conn = self.pool.get()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let blobs: i64 = tx.query_row(
            "SELECT COUNT(*) FROM share_blobs WHERE code = ?1",
            [code],
            |r| r.get(0),
        )?;
        if blobs > 0 {
            tx.commit()?;
            return Ok(false);
        }
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO shares
                (code, envelope, created_at, expires_at, max_views, burn_after_read, view_count,
                 revoked, owner_token, org_id, creator_user_id, passphrase)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                code,
                envelope,
                meta.created_at,
                meta.expires_at,
                meta.max_views.map(|v| v as i64),
                meta.burn_after_read as i64,
                meta.view_count as i64,
                meta.revoked as i64,
                meta.owner_token.as_deref(),
                meta.org_id.as_deref(),
                meta.creator_user_id.as_deref(),
                if envelope_has_passphrase(envelope)? {
                    "1"
                } else {
                    "0"
                },
            ],
        )?;
        tx.commit()?;
        Ok(inserted > 0)
    }

    /// Read a share and atomically apply its lifecycle decision. Returns the
    /// envelope on success, or [`ReadOutcome::NotFound`] when absent or gated;
    /// gated/expired rows are deleted in the same transaction.
    ///
    /// A served read also decides how long the read ticket it issues lasts
    /// (`ticket_ttl_seconds`, capped at the share's expiry). When the read is
    /// the share's last, the share's blobs are kept until that moment instead
    /// of going with the row.
    pub fn read_and_advance(
        &self,
        code: &str,
        now_ms: i64,
        ticket_ttl_seconds: u64,
    ) -> anyhow::Result<ReadOutcome> {
        let mut conn = self.pool.get()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let row = tx
            .query_row(
                "SELECT envelope, created_at, expires_at, max_views, burn_after_read, view_count, revoked, owner_token
                 FROM shares WHERE code = ?1",
                [code],
                |r| {
                    let envelope: String = r.get(0)?;
                    let meta = ShareMeta {
                        created_at: r.get(1)?,
                        expires_at: r.get(2)?,
                        max_views: r.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                        burn_after_read: r.get::<_, i64>(4)? != 0,
                        view_count: r.get::<_, i64>(5)? as u64,
                        revoked: r.get::<_, i64>(6)? != 0,
                        owner_token: r.get(7)?,
                        org_id: None,
                        creator_user_id: None,
                    };
                    Ok((envelope, meta))
                },
            )
            .optional()?;

        let Some((envelope, meta)) = row else {
            tx.commit()?;
            return Ok(ReadOutcome::NotFound);
        };

        let ticket_expires_at = ticket_expiry(now_ms, meta.expires_at, ticket_ttl_seconds);
        let mut purge = false;
        let outcome = match evaluate_read(&meta, now_ms) {
            ReadDecision::NotFound => {
                tx.execute("DELETE FROM shares WHERE code = ?1", [code])?;
                purge = delete_blob_rows(&tx, code)?;
                ReadOutcome::NotFound
            }
            ReadDecision::ServeAndDestroy => {
                tx.execute("DELETE FROM shares WHERE code = ?1", [code])?;
                tx.execute(
                    "UPDATE share_blobs SET retain_until = ?2 WHERE code = ?1",
                    params![code, ticket_expires_at],
                )?;
                ReadOutcome::Served {
                    envelope,
                    ticket_expires_at,
                }
            }
            ReadDecision::ServeAndUpdate { next_count } => {
                tx.execute(
                    "UPDATE shares SET view_count = ?2 WHERE code = ?1",
                    params![code, next_count as i64],
                )?;
                ReadOutcome::Served {
                    envelope,
                    ticket_expires_at,
                }
            }
        };
        tx.commit()?;
        if purge {
            self.purge_files(code);
        }
        Ok(outcome)
    }

    /// Inspect public lifecycle hints without incrementing views or burning a share.
    pub fn public_metadata(
        &self,
        code: &str,
        now_ms: i64,
    ) -> anyhow::Result<Option<PublicMetadata>> {
        let conn = self.pool.get()?;
        let row = conn
            .query_row(
                "SELECT envelope, passphrase, created_at, expires_at, max_views, burn_after_read,
                    view_count, revoked FROM shares WHERE code = ?1",
                [code],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        ShareMeta {
                            created_at: r.get(2)?,
                            expires_at: r.get(3)?,
                            max_views: r.get::<_, Option<i64>>(4)?.map(|value| value as u64),
                            burn_after_read: r.get::<_, i64>(5)? != 0,
                            view_count: r.get::<_, i64>(6)? as u64,
                            revoked: r.get::<_, i64>(7)? != 0,
                            owner_token: None,
                            org_id: None,
                            creator_user_id: None,
                        },
                    ))
                },
            )
            .optional()?;
        let Some((envelope, passphrase, meta)) = row else {
            return Ok(None);
        };
        if evaluate_read(&meta, now_ms) == ReadDecision::NotFound {
            return Ok(None);
        }
        let passphrase = match passphrase {
            Some(flag) => flag == "1",
            None => envelope_has_passphrase(&envelope)?,
        };
        Ok(Some(PublicMetadata {
            passphrase,
            burn_after_read: meta.burn_after_read,
            max_views: meta.max_views,
            expires_at: meta.expires_at,
        }))
    }

    /// Owner-only metadata lookup. Returns `None` when absent or already past
    /// `expires_at` (lazily deleting the expired row), mirroring the Worker's
    /// KV-TTL-gated stats read.
    pub fn stats(&self, code: &str, now_ms: i64) -> anyhow::Result<Option<ShareMeta>> {
        let conn = self.pool.get()?;
        let meta = conn
            .query_row(
                "SELECT created_at, expires_at, max_views, burn_after_read, view_count, revoked,
                        owner_token, org_id, creator_user_id
                 FROM shares WHERE code = ?1",
                [code],
                |r| {
                    Ok(ShareMeta {
                        created_at: r.get(0)?,
                        expires_at: r.get(1)?,
                        max_views: r.get::<_, Option<i64>>(2)?.map(|v| v as u64),
                        burn_after_read: r.get::<_, i64>(3)? != 0,
                        view_count: r.get::<_, i64>(4)? as u64,
                        revoked: r.get::<_, i64>(5)? != 0,
                        owner_token: r.get(6)?,
                        org_id: r.get(7)?,
                        creator_user_id: r.get(8)?,
                    })
                },
            )
            .optional()?;

        let Some(meta) = meta else {
            return Ok(None);
        };
        if let Some(exp) = meta.expires_at {
            if now_ms >= exp {
                // A renewal can commit between the lookup and this cleanup.
                // Recheck expiry in the DELETE so it cannot erase the new window.
                let mut conn = conn;
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let deleted = tx.execute(
                    "DELETE FROM shares WHERE code = ?1 AND expires_at <= ?2",
                    params![code, now_ms],
                )?;
                let purge = deleted > 0 && delete_blob_rows(&tx, code)?;
                tx.commit()?;
                if purge {
                    self.purge_files(code);
                }
                return Ok(None);
            }
        }
        Ok(Some(meta))
    }

    /// Extend only the lifetime of a still-readable share, never shortening it. The lifecycle
    /// predicates run in the same SQLite write as the update, so a concurrent
    /// read, revocation, or expiry cannot be undone by a stale owner lookup.
    pub fn renew(
        &self,
        code: &str,
        ttl_ms: i64,
        now: impl FnOnce() -> i64,
    ) -> anyhow::Result<Option<Option<i64>>> {
        let mut conn = self.pool.get()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Sample time only after waiting for the connection and the write lock.
        let now_ms = now();
        let expires_at = now_ms.saturating_add(ttl_ms);
        let updated = tx.execute(
            "UPDATE shares SET expires_at = CASE
                 WHEN expires_at IS NULL THEN NULL ELSE MAX(expires_at, ?3) END
             WHERE code = ?1 AND revoked = 0
               AND (expires_at IS NULL OR expires_at > ?2)
               AND (max_views IS NULL OR view_count < max_views)",
            params![code, now_ms, expires_at],
        )?;
        let actual = if updated > 0 {
            Some(tx.query_row(
                "SELECT expires_at FROM shares WHERE code = ?1",
                [code],
                |r| r.get(0),
            )?)
        } else {
            None
        };
        tx.commit()?;
        Ok(actual)
    }

    /// Hard-delete a share (owner revoke). Idempotent — deleting an absent code
    /// is a no-op.
    ///
    /// The share's files go with it, retained or not: a revocation has to
    /// stop downloads that a read ticket would otherwise still allow.
    pub fn delete(&self, code: &str) -> anyhow::Result<()> {
        let mut conn = self.pool.get()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM shares WHERE code = ?1", [code])?;
        let purge = delete_blob_rows(&tx, code)?;
        tx.commit()?;
        if purge {
            self.purge_files(code);
        }
        Ok(())
    }

    /// One org's live shares, newest first — ADR-0149 §8.
    ///
    /// Expired rows are filtered rather than deleted: a listing is a read, and
    /// making it mutate would mean an operator opening a page could race the
    /// reaper. The reaper still owns deletion.
    ///
    /// Never returns a share with no `org_id`. A pre-tenancy share belongs to
    /// nobody the server can name, and folding it into whichever org happened
    /// to ask would hand one tenant another's link.
    pub fn list_by_org(&self, org_id: &str, now_ms: i64) -> anyhow::Result<Vec<OrgShare>> {
        let conn = self.pool.get()?;
        let mut statement = conn.prepare(
            "SELECT code, created_at, expires_at, max_views, view_count, creator_user_id
             FROM shares
             WHERE org_id = ?1 AND (expires_at IS NULL OR expires_at > ?2)
             ORDER BY created_at DESC
             LIMIT 500",
        )?;
        let rows = statement.query_map(params![org_id, now_ms], |r| {
            Ok(OrgShare {
                code: r.get(0)?,
                created_at: r.get(1)?,
                expires_at: r.get(2)?,
                max_views: r.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                view_count: r.get::<_, i64>(4)? as u64,
                creator_user_id: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Hard-delete a share, but only if it belongs to `org_id`.
    ///
    /// Returns whether anything was deleted, so the caller can answer 404 for
    /// a code in somebody else's org exactly as for a code that never existed
    /// — otherwise the response is an oracle for which codes are real.
    pub fn delete_in_org(&self, org_id: &str, code: &str) -> anyhow::Result<bool> {
        let mut conn = self.pool.get()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deleted = tx.execute(
            "DELETE FROM shares WHERE code = ?1 AND org_id = ?2",
            params![code, org_id],
        )?;
        let purge = deleted > 0 && delete_blob_rows(&tx, code)?;
        tx.commit()?;
        if purge {
            self.purge_files(code);
        }
        Ok(deleted > 0)
    }

    /// Delete every share whose `expires_at` is at/under `now_ms`. Returns the
    /// number reaped. Called periodically by the reaper task.
    ///
    /// Also drops the files of shares that no longer exist once their
    /// retention (the last read ticket's lifetime) has passed.
    pub fn reap_expired(&self, now_ms: i64) -> anyhow::Result<usize> {
        let mut conn = self.pool.get()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let n = tx.execute(
            "DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            [now_ms],
        )?;
        let orphaned: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT DISTINCT b.code FROM share_blobs b
                 WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.code = b.code)
                   AND (b.retain_until IS NULL OR b.retain_until <= ?1)",
            )?;
            let rows = statement.query_map([now_ms], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for code in &orphaned {
            delete_blob_rows(&tx, code)?;
        }
        tx.commit()?;
        for code in &orphaned {
            self.purge_files(code);
        }
        Ok(n)
    }

    /// Store one encrypted chunk of `blob_id` for the live share `code`.
    ///
    /// The bytes land in a temporary file first and are renamed into place
    /// only after the quota accounting commits, so a refused chunk never
    /// becomes readable and an accepted one never outruns its row.
    pub fn put_chunk(
        &self,
        code: &str,
        blob_id: &str,
        index: u64,
        bytes: &[u8],
        now_ms: i64,
    ) -> anyhow::Result<PutChunkOutcome> {
        let final_path = self.chunk_path(code, blob_id, index);
        let directory = final_path
            .parent()
            .context("chunk path has a parent")?
            .to_path_buf();
        std::fs::create_dir_all(&directory)?;
        let temporary = directory.join(format!(".{index}.{}.tmp", random_suffix()));
        {
            let mut file = std::fs::File::create(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        let outcome = self.reserve_chunk(code, blob_id, index, bytes.len() as u64, now_ms);
        match outcome {
            Ok(PutChunkOutcome::Stored) => {
                if let Err(error) = std::fs::rename(&temporary, &final_path) {
                    let _ = std::fs::remove_file(&temporary);
                    return Err(error.into());
                }
                Ok(PutChunkOutcome::Stored)
            }
            other => {
                let _ = std::fs::remove_file(&temporary);
                other
            }
        }
    }

    fn reserve_chunk(
        &self,
        code: &str,
        blob_id: &str,
        index: u64,
        len: u64,
        now_ms: i64,
    ) -> anyhow::Result<PutChunkOutcome> {
        let mut conn = self.pool.get()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !share_is_live(&tx, code, now_ms)? {
            tx.commit()?;
            return Ok(PutChunkOutcome::NotFound);
        }
        let blob: Option<i64> = tx
            .query_row(
                "SELECT committed FROM share_blobs WHERE code = ?1 AND blob_id = ?2",
                params![code, blob_id],
                |r| r.get(0),
            )
            .optional()?;
        match blob {
            Some(committed) if committed != 0 => {
                tx.commit()?;
                return Ok(PutChunkOutcome::Committed);
            }
            Some(_) => {}
            None => {
                let count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM share_blobs WHERE code = ?1",
                    [code],
                    |r| r.get(0),
                )?;
                if count as u64 >= MAX_BLOBS_PER_SHARE {
                    tx.commit()?;
                    return Ok(PutChunkOutcome::TooManyBlobs);
                }
            }
        }
        let previous: i64 = tx
            .query_row(
                "SELECT bytes FROM share_blob_chunks WHERE code = ?1 AND blob_id = ?2 AND idx = ?3",
                params![code, blob_id, index as i64],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let stored: i64 = tx.query_row(
            "SELECT COALESCE(SUM(stored_bytes), 0) FROM share_blobs WHERE code = ?1",
            [code],
            |r| r.get(0),
        )?;
        let next_total = stored as u64 - previous as u64 + len;
        if next_total > MAX_SHARE_BLOB_BYTES {
            tx.commit()?;
            return Ok(PutChunkOutcome::QuotaExceeded);
        }
        tx.execute(
            "INSERT INTO share_blobs (code, blob_id, created_at, stored_bytes)
             VALUES (?1, ?2, ?3, 0)
             ON CONFLICT (code, blob_id) DO NOTHING",
            params![code, blob_id, now_ms],
        )?;
        tx.execute(
            "UPDATE share_blobs SET stored_bytes = stored_bytes - ?3 + ?4
             WHERE code = ?1 AND blob_id = ?2",
            params![code, blob_id, previous, len as i64],
        )?;
        tx.execute(
            "INSERT INTO share_blob_chunks (code, blob_id, idx, bytes) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (code, blob_id, idx) DO UPDATE SET bytes = excluded.bytes",
            params![code, blob_id, index as i64, len as i64],
        )?;
        tx.commit()?;
        Ok(PutChunkOutcome::Stored)
    }

    /// Seal `blob_id`: its chunks must be exactly `0..chunk_count`, sum to
    /// `total_bytes`, and be on disk at those sizes. Committing again with
    /// the same declaration is a no-op; with a different one, a conflict.
    pub fn commit_blob(
        &self,
        code: &str,
        blob_id: &str,
        chunk_count: u64,
        total_bytes: u64,
        now_ms: i64,
    ) -> anyhow::Result<CommitOutcome> {
        let mut conn = self.pool.get()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !share_is_live(&tx, code, now_ms)? {
            tx.commit()?;
            return Ok(CommitOutcome::NotFound);
        }
        let blob: Option<(i64, Option<i64>, Option<i64>)> = tx
            .query_row(
                "SELECT committed, chunk_count, total_bytes FROM share_blobs
                 WHERE code = ?1 AND blob_id = ?2",
                params![code, blob_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((committed, committed_count, committed_total)) = blob else {
            tx.commit()?;
            return Ok(CommitOutcome::NotFound);
        };
        if committed != 0 {
            tx.commit()?;
            let same = committed_count == Some(chunk_count as i64)
                && committed_total == Some(total_bytes as i64);
            return Ok(if same {
                CommitOutcome::Committed
            } else {
                CommitOutcome::Conflict
            });
        }
        let chunks: Vec<(u64, u64)> = {
            let mut statement = tx.prepare(
                "SELECT idx, bytes FROM share_blob_chunks WHERE code = ?1 AND blob_id = ?2",
            )?;
            let rows = statement.query_map(params![code, blob_id], |r| {
                Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        if let Err(error) = validate_commit(chunk_count, total_bytes, &chunks) {
            tx.commit()?;
            return Ok(CommitOutcome::Invalid(error));
        }
        for (index, len) in &chunks {
            let on_disk = std::fs::metadata(self.chunk_path(code, blob_id, *index))
                .map(|metadata| metadata.len())
                .ok();
            if on_disk != Some(*len) {
                tx.commit()?;
                return Ok(CommitOutcome::Invalid(CommitError::MissingChunks));
            }
        }
        tx.execute(
            "UPDATE share_blobs SET committed = 1, chunk_count = ?3, total_bytes = ?4
             WHERE code = ?1 AND blob_id = ?2",
            params![code, blob_id, chunk_count as i64, total_bytes as i64],
        )?;
        tx.commit()?;
        Ok(CommitOutcome::Committed)
    }

    /// One committed chunk, if the share still allows reading its files: the
    /// share is live, or it was used up and its retention has not passed.
    /// The caller has already checked the read ticket.
    pub fn read_chunk(
        &self,
        code: &str,
        blob_id: &str,
        index: u64,
        now_ms: i64,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let readable = {
            let mut conn = self.pool.get()?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
            let blob: Option<(Option<i64>, Option<i64>)> = tx
                .query_row(
                    "SELECT chunk_count, retain_until FROM share_blobs
                     WHERE code = ?1 AND blob_id = ?2 AND committed = 1",
                    params![code, blob_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let readable = match blob {
                Some((Some(chunk_count), retain_until)) if (index as i64) < chunk_count => {
                    share_is_live(&tx, code, now_ms)?
                        || retain_until.is_some_and(|until| now_ms < until)
                }
                _ => false,
            };
            tx.commit()?;
            readable
        };
        if !readable {
            return Ok(None);
        }
        match std::fs::read(self.chunk_path(code, blob_id, index)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Count live shares (gauge for `/healthz` and `/metrics`).
    pub fn count(&self) -> anyhow::Result<u64> {
        let conn = self.pool.get()?;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM shares", [], |r| r.get(0))?;
        Ok(n as u64)
    }
}

/// Whether `code` names a share that may still be read: present, not
/// revoked, not expired, views remaining. The same gate `evaluate_read`
/// applies, without spending a view.
fn share_is_live(tx: &Transaction<'_>, code: &str, now_ms: i64) -> anyhow::Result<bool> {
    let row: Option<(Option<i64>, Option<i64>, i64, i64)> = tx
        .query_row(
            "SELECT expires_at, max_views, view_count, revoked FROM shares WHERE code = ?1",
            [code],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    Ok(match row {
        None => false,
        Some((expires_at, max_views, view_count, revoked)) => {
            revoked == 0
                && expires_at.is_none_or(|expiry| now_ms < expiry)
                && max_views.is_none_or(|max| view_count < max)
        }
    })
}

/// Delete `code`'s blob rows. Returns whether there were any, so the caller
/// knows to remove the files once the transaction commits.
fn delete_blob_rows(tx: &Transaction<'_>, code: &str) -> anyhow::Result<bool> {
    tx.execute("DELETE FROM share_blob_chunks WHERE code = ?1", [code])?;
    let deleted = tx.execute("DELETE FROM share_blobs WHERE code = ?1", [code])?;
    Ok(deleted > 0)
}

fn random_suffix() -> String {
    use rand::Rng;
    let mut bytes = [0u8; 8];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn ensure_owner_token_column(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    add_column_if_missing(conn, "owner_token")
}

/// Give `shares` the ADR-0149 §8 tenancy columns.
///
/// Both nullable, and **nothing is backfilled**. Every share created before
/// this — and every one created with the legacy global upload secret — was
/// made by a caller who proved nothing about who they were, so there is no
/// honest value to write. They stay readable by code and revocable by their
/// owner token; they are simply invisible to org-scoped listing.
///
/// Idempotent, like its neighbour: `Store::open` runs it on every start.
fn ensure_tenancy_columns(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    add_column_if_missing(conn, "org_id")?;
    add_column_if_missing(conn, "creator_user_id")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_shares_org ON shares(org_id)",
        [],
    )?;
    Ok(())
}

fn add_column_if_missing(conn: &rusqlite::Connection, column: &str) -> anyhow::Result<()> {
    let has_column: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('shares') WHERE name = ?1",
        [column],
        |r| r.get(0),
    )?;
    if has_column == 0 {
        // The column name is a compile-time literal at every call site, never
        // request data — SQLite cannot parameterise an identifier.
        conn.execute(&format!("ALTER TABLE shares ADD COLUMN {column} TEXT"), [])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_share_core::blobs::max_chunk_ciphertext_bytes;

    const TTL: u64 = 3_600;

    fn temp_store() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shares.sqlite");
        let store = Store::open(path.to_str().unwrap()).unwrap();
        (store, dir)
    }

    fn meta(expires_at: Option<i64>, max_views: Option<u64>) -> ShareMeta {
        ShareMeta {
            created_at: 1_000,
            expires_at,
            max_views,
            burn_after_read: max_views == Some(1),
            view_count: 0,
            revoked: false,
            owner_token: Some("owner-token".to_string()),
            org_id: None,
            creator_user_id: None,
        }
    }

    #[test]
    fn create_then_read_returns_envelope() {
        let (store, _dir) = temp_store();
        store.create("abc", "{\"v\":1}", &meta(None, None)).unwrap();
        assert_eq!(
            store.read_and_advance("abc", 2_000, TTL).unwrap(),
            ReadOutcome::Served {
                envelope: "{\"v\":1}".into(),
                ticket_expires_at: 2_000 + TTL as i64 * 1000,
            }
        );
        assert_eq!(store.count().unwrap(), 1);
    }

    #[test]
    fn read_unknown_is_not_found() {
        let (store, _dir) = temp_store();
        assert_eq!(
            store.read_and_advance("nope", 0, TTL).unwrap(),
            ReadOutcome::NotFound
        );
    }

    #[test]
    fn max_views_self_destructs_after_n_reads() {
        let (store, _dir) = temp_store();
        store.create("c", "{}", &meta(None, Some(2))).unwrap();
        assert!(matches!(
            store.read_and_advance("c", 0, TTL).unwrap(),
            ReadOutcome::Served { .. }
        ));
        assert!(matches!(
            store.read_and_advance("c", 0, TTL).unwrap(),
            ReadOutcome::Served { .. }
        ));
        // Third read — row already destroyed on the second (final) view.
        assert_eq!(
            store.read_and_advance("c", 0, TTL).unwrap(),
            ReadOutcome::NotFound
        );
        assert_eq!(store.count().unwrap(), 0);
    }

    #[test]
    fn burn_after_read_destroys_on_first_view() {
        let (store, _dir) = temp_store();
        store.create("b", "{}", &meta(None, Some(1))).unwrap();
        assert!(matches!(
            store.read_and_advance("b", 0, TTL).unwrap(),
            ReadOutcome::Served { .. }
        ));
        assert_eq!(
            store.read_and_advance("b", 0, TTL).unwrap(),
            ReadOutcome::NotFound
        );
    }

    #[test]
    fn expired_read_deletes_row_and_returns_not_found() {
        let (store, _dir) = temp_store();
        store.create("e", "{}", &meta(Some(5_000), None)).unwrap();
        assert_eq!(
            store.read_and_advance("e", 5_000, TTL).unwrap(),
            ReadOutcome::NotFound
        );
        assert_eq!(store.count().unwrap(), 0);
    }

    #[test]
    fn stats_reports_meta_and_advances_with_reads() {
        let (store, _dir) = temp_store();
        store
            .create("s", "{}", &meta(Some(9_999), Some(5)))
            .unwrap();
        store.read_and_advance("s", 0, TTL).unwrap();
        let m = store.stats("s", 0).unwrap().expect("present");
        assert_eq!(m.view_count, 1);
        assert_eq!(m.max_views, Some(5));
        assert_eq!(m.expires_at, Some(9_999));
    }

    #[test]
    fn stats_treats_expired_as_absent() {
        let (store, _dir) = temp_store();
        store.create("s", "{}", &meta(Some(100), None)).unwrap();
        assert!(store.stats("s", 100).unwrap().is_none());
        assert_eq!(store.count().unwrap(), 0);
    }

    #[test]
    fn delete_removes_then_reads_not_found() {
        let (store, _dir) = temp_store();
        store.create("d", "{}", &meta(None, None)).unwrap();
        store.delete("d").unwrap();
        assert_eq!(
            store.read_and_advance("d", 0, TTL).unwrap(),
            ReadOutcome::NotFound
        );
        // Deleting an absent code is a no-op.
        store.delete("d").unwrap();
    }

    #[test]
    fn reaper_deletes_only_expired_rows() {
        let (store, _dir) = temp_store();
        store.create("past", "{}", &meta(Some(100), None)).unwrap();
        store
            .create("future", "{}", &meta(Some(10_000), None))
            .unwrap();
        store.create("never", "{}", &meta(None, None)).unwrap();
        let reaped = store.reap_expired(5_000).unwrap();
        assert_eq!(reaped, 1);
        assert_eq!(store.count().unwrap(), 2);
        assert!(store.stats("future", 0).unwrap().is_some());
        assert!(store.stats("never", 0).unwrap().is_some());
    }

    #[test]
    fn metadata_does_not_spend_a_view_and_hides_gated_shares() {
        let (store, dir) = temp_store();
        let envelope = r#"{"pp":{"salt":"salt"},"ciphertext":"opaque"}"#;
        store
            .create("burn", envelope, &meta(Some(10_000), Some(1)))
            .unwrap();
        upload(&store, "burn", BLOB, &[&[1u8; 40]]);
        for _ in 0..3 {
            assert_eq!(
                store.public_metadata("burn", 2_000).unwrap(),
                Some(PublicMetadata {
                    passphrase: true,
                    burn_after_read: true,
                    max_views: Some(1),
                    expires_at: Some(10_000),
                })
            );
            assert_eq!(store.stats("burn", 2_000).unwrap().unwrap().view_count, 0);
            assert_eq!(
                store.read_chunk("burn", BLOB, 0, 2_000).unwrap(),
                Some(vec![1u8; 40])
            );
            assert_eq!(chunk_files(&dir), 1);
            let retain_until: Option<i64> = store
                .pool
                .get()
                .unwrap()
                .query_row(
                    "SELECT retain_until FROM share_blobs WHERE code = 'burn'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(retain_until, None);
        }
        assert!(matches!(
            store.read_and_advance("burn", 2_000, TTL).unwrap(),
            ReadOutcome::Served { .. }
        ));
        assert_eq!(store.public_metadata("burn", 2_000).unwrap(), None);
        // The counted read, rather than metadata inspection, begins ticket retention.
        assert_eq!(
            store.read_chunk("burn", BLOB, 0, 9_999).unwrap(),
            Some(vec![1u8; 40])
        );
        assert_eq!(store.read_chunk("burn", BLOB, 0, 10_000).unwrap(), None);
        for (code, mut row) in [
            ("expired", meta(Some(2_000), None)),
            ("revoked", meta(None, None)),
            ("exhausted", meta(None, Some(2))),
        ] {
            row.revoked = code == "revoked";
            row.view_count = if code == "exhausted" { 2 } else { 0 };
            store.create(code, "{}", &row).unwrap();
            assert_eq!(store.public_metadata(code, 2_000).unwrap(), None, "{code}");
        }
    }

    #[test]
    fn legacy_metadata_derives_passphrase_without_consuming_envelope() {
        let (store, _dir) = temp_store();
        store
            .create("legacy", r#"{"pp":{"salt":"salt"}}"#, &meta(None, Some(1)))
            .unwrap();
        store
            .pool
            .get()
            .unwrap()
            .execute(
                "UPDATE shares SET passphrase = NULL WHERE code = 'legacy'",
                [],
            )
            .unwrap();
        assert!(
            store
                .public_metadata("legacy", 0)
                .unwrap()
                .unwrap()
                .passphrase
        );
        assert_eq!(store.stats("legacy", 0).unwrap().unwrap().view_count, 0);
        assert!(matches!(
            store.read_and_advance("legacy", 0, TTL).unwrap(),
            ReadOutcome::Served { .. }
        ));
    }

    #[test]
    fn renewal_never_shortens_finite_or_legacy_unlimited_expiry() {
        let (store, _dir) = temp_store();
        store
            .create("long", "{}", &meta(Some(30_000), None))
            .unwrap();
        assert_eq!(
            store.renew("long", 7_000, || 1_000).unwrap(),
            Some(Some(30_000))
        );
        assert_eq!(
            store.renew("long", 40_000, || 1_000).unwrap(),
            Some(Some(41_000))
        );
        store.create("never", "{}", &meta(None, None)).unwrap();
        assert_eq!(store.renew("never", 7_000, || 1_000).unwrap(), Some(None));
        assert_eq!(
            store.stats("never", 1_000).unwrap().unwrap().expires_at,
            None
        );
    }

    #[test]
    fn renewal_updates_only_expiry_and_preserves_concurrent_reads() {
        let (store, _dir) = temp_store();
        let mut original = meta(Some(10_000), Some(100));
        original.org_id = Some("org_owner".into());
        original.creator_user_id = Some("usr_owner".into());
        store.create("renew", "{}", &original).unwrap();
        std::thread::scope(|scope| {
            for _ in 0..10 {
                let store = &store;
                scope.spawn(move || {
                    assert_eq!(
                        store.renew("renew", 18_000, || 2_000).unwrap(),
                        Some(Some(20_000))
                    );
                    assert!(matches!(
                        store.read_and_advance("renew", 2_000, TTL).unwrap(),
                        ReadOutcome::Served { .. }
                    ));
                });
            }
        });
        original.expires_at = Some(20_000);
        original.view_count = 10;
        assert_eq!(store.stats("renew", 2_000).unwrap(), Some(original));
    }

    #[test]
    fn renewal_samples_clock_under_write_lock_and_rejects_expiry() {
        let (store, dir) = temp_store();
        store
            .create("expired", "{}", &meta(Some(2_000), None))
            .unwrap();
        assert!(store.stats("expired", 1_000).unwrap().is_some());
        let renewed = store
            .renew("expired", 18_000, || {
                // The production clock callback must run after BEGIN IMMEDIATE.
                let probe = rusqlite::Connection::open(dir.path().join("shares.sqlite")).unwrap();
                probe.busy_timeout(std::time::Duration::ZERO).unwrap();
                let error = probe.execute_batch("BEGIN IMMEDIATE").unwrap_err();
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy)
                );
                2_000
            })
            .unwrap();
        assert_eq!(renewed, None);
        assert_eq!(
            store.read_and_advance("expired", 2_000, TTL).unwrap(),
            ReadOutcome::NotFound
        );
    }

    #[test]
    fn renewal_rechecks_lifecycle_after_owner_lookup() {
        let (store, _dir) = temp_store();
        for (code, mut row) in [
            ("expired", meta(Some(2_000), None)),
            ("revoked", meta(None, None)),
            ("exhausted", meta(None, Some(2))),
            ("deleted", meta(None, None)),
            ("burned", meta(None, Some(1))),
        ] {
            store.create(code, "{}", &row).unwrap();
            assert!(store.stats(code, 1_000).unwrap().is_some());
            match code {
                "revoked" | "exhausted" => {
                    row.revoked = code == "revoked";
                    row.view_count = if code == "exhausted" { 2 } else { 0 };
                    store.delete(code).unwrap();
                    store.create(code, "{}", &row).unwrap();
                }
                "deleted" => store.delete(code).unwrap(),
                "burned" => {
                    store.read_and_advance(code, 1_000, TTL).unwrap();
                }
                _ => {}
            }
            assert_eq!(store.renew(code, 18_000, || 2_000).unwrap(), None, "{code}");
            assert_eq!(
                store.read_and_advance(code, 2_000, TTL).unwrap(),
                ReadOutcome::NotFound
            );
        }
        assert_eq!(store.renew("unknown", 18_000, || 2_000).unwrap(), None);
    }

    #[test]
    fn open_migrates_legacy_database_without_owner_token_column() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shares.sqlite");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE shares (
                     code            TEXT PRIMARY KEY,
                     envelope        TEXT NOT NULL,
                     created_at      INTEGER NOT NULL,
                     expires_at      INTEGER,
                     max_views       INTEGER,
                     burn_after_read INTEGER NOT NULL,
                     view_count      INTEGER NOT NULL,
                     revoked         INTEGER NOT NULL
                 );
                 INSERT INTO shares
                    (code, envelope, created_at, expires_at, max_views, burn_after_read, view_count, revoked)
                 VALUES ('legacy', '{}', 1000, NULL, NULL, 0, 0, 0);",
            )
            .unwrap();
        }

        let store = Store::open(path.to_str().unwrap()).unwrap();
        let legacy = store.stats("legacy", 0).unwrap().expect("legacy row");
        assert_eq!(legacy.owner_token, None);

        store.create("new", "{}", &meta(None, None)).unwrap();
        let created = store.stats("new", 0).unwrap().expect("new row");
        assert_eq!(created.owner_token.as_deref(), Some("owner-token"));
    }

    const BLOB: &str = "AAAAAAAAAAAAAAAAAAAAAA";
    const OTHER_BLOB: &str = "BBBBBBBBBBBBBBBBBBBBBB";

    fn full_chunk() -> Vec<u8> {
        vec![7u8; max_chunk_ciphertext_bytes() as usize]
    }

    fn chunk_files(dir: &tempfile::TempDir) -> usize {
        fn walk(path: &std::path::Path) -> usize {
            std::fs::read_dir(path)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| {
                            let path = entry.path();
                            if path.is_dir() {
                                walk(&path)
                            } else {
                                1
                            }
                        })
                        .sum()
                })
                .unwrap_or(0)
        }
        walk(&dir.path().join("shares.sqlite.blobs"))
    }

    fn upload(store: &Store, code: &str, blob: &str, chunks: &[&[u8]]) {
        for (index, chunk) in chunks.iter().enumerate() {
            assert_eq!(
                store.put_chunk(code, blob, index as u64, chunk, 0).unwrap(),
                PutChunkOutcome::Stored
            );
        }
        let total: u64 = chunks.iter().map(|chunk| chunk.len() as u64).sum();
        assert_eq!(
            store
                .commit_blob(code, blob, chunks.len() as u64, total, 0)
                .unwrap(),
            CommitOutcome::Committed
        );
    }

    #[test]
    fn a_committed_blob_reads_back_chunk_by_chunk() {
        let (store, dir) = temp_store();
        store.create("f", "{}", &meta(None, None)).unwrap();
        let first = full_chunk();
        upload(&store, "f", BLOB, &[&first, &[1u8; 40]]);
        assert_eq!(store.read_chunk("f", BLOB, 0, 0).unwrap(), Some(first));
        assert_eq!(
            store.read_chunk("f", BLOB, 1, 0).unwrap(),
            Some(vec![1u8; 40])
        );
        assert_eq!(store.read_chunk("f", BLOB, 2, 0).unwrap(), None);
        assert_eq!(chunk_files(&dir), 2);
    }

    #[test]
    fn an_uncommitted_blob_is_not_readable() {
        let (store, _dir) = temp_store();
        store.create("u", "{}", &meta(None, None)).unwrap();
        store.put_chunk("u", BLOB, 0, &[1u8; 40], 0).unwrap();
        assert_eq!(store.read_chunk("u", BLOB, 0, 0).unwrap(), None);
    }

    #[test]
    fn uploads_need_a_live_share() {
        let (store, _dir) = temp_store();
        assert_eq!(
            store.put_chunk("missing", BLOB, 0, &[1u8; 40], 0).unwrap(),
            PutChunkOutcome::NotFound
        );
        store.create("old", "{}", &meta(Some(100), None)).unwrap();
        assert_eq!(
            store.put_chunk("old", BLOB, 0, &[1u8; 40], 100).unwrap(),
            PutChunkOutcome::NotFound
        );
        assert_eq!(
            store.commit_blob("old", BLOB, 1, 40, 100).unwrap(),
            CommitOutcome::NotFound
        );
    }

    #[test]
    fn a_committed_blob_is_immutable_and_recommit_is_idempotent() {
        let (store, _dir) = temp_store();
        store.create("i", "{}", &meta(None, None)).unwrap();
        upload(&store, "i", BLOB, &[&[1u8; 40]]);
        assert_eq!(
            store.put_chunk("i", BLOB, 0, &[2u8; 40], 0).unwrap(),
            PutChunkOutcome::Committed
        );
        assert_eq!(
            store.commit_blob("i", BLOB, 1, 40, 0).unwrap(),
            CommitOutcome::Committed
        );
        assert_eq!(
            store.commit_blob("i", BLOB, 1, 41, 0).unwrap(),
            CommitOutcome::Conflict
        );
        assert_eq!(
            store.commit_blob("i", OTHER_BLOB, 1, 41, 0).unwrap(),
            CommitOutcome::NotFound
        );
    }

    #[test]
    fn commit_refuses_a_declaration_the_chunks_do_not_match() {
        let (store, _dir) = temp_store();
        store.create("m", "{}", &meta(None, None)).unwrap();
        store.put_chunk("m", BLOB, 0, &[1u8; 40], 0).unwrap();
        assert_eq!(
            store.commit_blob("m", BLOB, 2, 40, 0).unwrap(),
            CommitOutcome::Invalid(CommitError::MissingChunks)
        );
        assert_eq!(
            store.commit_blob("m", BLOB, 1, 41, 0).unwrap(),
            CommitOutcome::Invalid(CommitError::SizeMismatch)
        );
    }

    #[test]
    fn commit_refuses_when_a_chunk_file_went_missing() {
        let (store, dir) = temp_store();
        store.create("g", "{}", &meta(None, None)).unwrap();
        store.put_chunk("g", BLOB, 0, &[1u8; 40], 0).unwrap();
        std::fs::remove_file(
            dir.path()
                .join("shares.sqlite.blobs/g")
                .join(BLOB)
                .join("0"),
        )
        .unwrap();
        assert_eq!(
            store.commit_blob("g", BLOB, 1, 40, 0).unwrap(),
            CommitOutcome::Invalid(CommitError::MissingChunks)
        );
    }

    #[test]
    fn re_uploading_a_chunk_replaces_it_and_its_quota() {
        let (store, _dir) = temp_store();
        store.create("r", "{}", &meta(None, None)).unwrap();
        store.put_chunk("r", BLOB, 0, &[1u8; 400], 0).unwrap();
        store.put_chunk("r", BLOB, 0, &[2u8; 40], 0).unwrap();
        assert_eq!(
            store.commit_blob("r", BLOB, 1, 40, 0).unwrap(),
            CommitOutcome::Committed
        );
        assert_eq!(
            store.read_chunk("r", BLOB, 0, 0).unwrap(),
            Some(vec![2u8; 40])
        );
    }

    #[test]
    fn a_share_holds_at_most_the_blob_limit() {
        let (store, _dir) = temp_store();
        store.create("n", "{}", &meta(None, None)).unwrap();
        for index in 0..MAX_BLOBS_PER_SHARE {
            let blob = format!("{index:0>22}");
            assert_eq!(
                store.put_chunk("n", &blob, 0, &[1u8; 17], 0).unwrap(),
                PutChunkOutcome::Stored
            );
        }
        assert_eq!(
            store.put_chunk("n", BLOB, 0, &[1u8; 17], 0).unwrap(),
            PutChunkOutcome::TooManyBlobs
        );
        // An existing blob may still take more chunks.
        assert_eq!(
            store
                .put_chunk("n", &format!("{:0>22}", 0), 1, &[1u8; 17], 0)
                .unwrap(),
            PutChunkOutcome::Stored
        );
    }

    #[test]
    fn a_share_holds_at_most_the_byte_quota() {
        let (store, _dir) = temp_store();
        store.create("q", "{}", &meta(None, None)).unwrap();
        // Account the quota directly rather than writing 2 GiB of test data.
        {
            let conn = store.pool.get().unwrap();
            conn.execute(
                "INSERT INTO share_blobs (code, blob_id, created_at, stored_bytes)
                 VALUES ('q', ?1, 0, ?2)",
                params![OTHER_BLOB, (MAX_SHARE_BLOB_BYTES - 20) as i64],
            )
            .unwrap();
        }
        assert_eq!(
            store.put_chunk("q", BLOB, 0, &[1u8; 21], 0).unwrap(),
            PutChunkOutcome::QuotaExceeded
        );
        assert_eq!(
            store.put_chunk("q", BLOB, 0, &[1u8; 20], 0).unwrap(),
            PutChunkOutcome::Stored
        );
    }

    #[test]
    fn the_last_view_keeps_files_until_its_ticket_lapses() {
        let (store, dir) = temp_store();
        store
            .create("burn", "{}", &meta(Some(10_000_000), Some(1)))
            .unwrap();
        upload(&store, "burn", BLOB, &[&[1u8; 40]]);
        let ReadOutcome::Served {
            ticket_expires_at, ..
        } = store.read_and_advance("burn", 1_000, 60).unwrap()
        else {
            panic!("served");
        };
        assert_eq!(ticket_expires_at, 61_000);
        // The share is gone, its files are not — yet.
        assert_eq!(store.count().unwrap(), 0);
        assert_eq!(
            store.read_chunk("burn", BLOB, 0, 60_999).unwrap(),
            Some(vec![1u8; 40])
        );
        assert_eq!(store.read_chunk("burn", BLOB, 0, 61_000).unwrap(), None);
        // The reaper drops them once retention has passed, not before.
        store.reap_expired(60_000).unwrap();
        assert_eq!(chunk_files(&dir), 1);
        store.reap_expired(61_000).unwrap();
        assert_eq!(chunk_files(&dir), 0);
        assert_eq!(store.read_chunk("burn", BLOB, 0, 0).unwrap(), None);
    }

    #[test]
    fn a_code_with_retained_files_is_not_reused() {
        let (store, _dir) = temp_store();
        store.create("dup", "{}", &meta(None, Some(1))).unwrap();
        upload(&store, "dup", BLOB, &[&[1u8; 40]]);
        store.read_and_advance("dup", 0, TTL).unwrap();
        assert!(!store.create("dup", "{}", &meta(None, None)).unwrap());
        // A live code is refused too, instead of failing the insert.
        store.create("live", "{}", &meta(None, None)).unwrap();
        assert!(!store.create("live", "{}", &meta(None, None)).unwrap());
    }

    #[test]
    fn revocation_and_expiry_remove_files_at_once() {
        let (store, dir) = temp_store();
        store.create("rv", "{}", &meta(None, None)).unwrap();
        upload(&store, "rv", BLOB, &[&[1u8; 40]]);
        store.delete("rv").unwrap();
        assert_eq!(chunk_files(&dir), 0);
        assert_eq!(store.read_chunk("rv", BLOB, 0, 0).unwrap(), None);

        let mut owned = meta(None, None);
        owned.org_id = Some("org".into());
        store.create("org", "{}", &owned).unwrap();
        upload(&store, "org", BLOB, &[&[1u8; 40]]);
        assert!(store.delete_in_org("org", "org").unwrap());
        assert_eq!(chunk_files(&dir), 0);

        store.create("ex", "{}", &meta(Some(5_000), None)).unwrap();
        upload(&store, "ex", BLOB, &[&[1u8; 40]]);
        assert_eq!(store.read_chunk("ex", BLOB, 0, 5_000).unwrap(), None);
        store.reap_expired(5_000).unwrap();
        assert_eq!(chunk_files(&dir), 0);

        store.create("st", "{}", &meta(Some(5_000), None)).unwrap();
        upload(&store, "st", BLOB, &[&[1u8; 40]]);
        assert!(store.stats("st", 5_000).unwrap().is_none());
        assert_eq!(chunk_files(&dir), 0);

        store.create("rd", "{}", &meta(Some(5_000), None)).unwrap();
        upload(&store, "rd", BLOB, &[&[1u8; 40]]);
        assert_eq!(
            store.read_and_advance("rd", 5_000, TTL).unwrap(),
            ReadOutcome::NotFound
        );
        assert_eq!(chunk_files(&dir), 0);
    }

    #[test]
    fn open_with_blob_dir_uses_the_given_directory() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = dir.path().join("elsewhere");
        let store =
            Store::open_with_blob_dir(dir.path().join("db").to_str().unwrap(), &blobs).unwrap();
        store.create("x", "{}", &meta(None, None)).unwrap();
        store.put_chunk("x", BLOB, 0, &[1u8; 40], 0).unwrap();
        assert!(blobs.join("x").join(BLOB).join("0").is_file());
    }
}
