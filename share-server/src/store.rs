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

use anyhow::Context;
use cognia_share_core::policy::{evaluate_read, ReadDecision};
use cognia_share_core::proto::ShareMeta;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension, TransactionBehavior};

type Pool = r2d2::Pool<SqliteConnectionManager>;

/// Result of a read attempt that has already applied the lifecycle decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOutcome {
    /// No servable share — return `404`.
    NotFound,
    /// Serve this opaque envelope JSON text verbatim.
    Served { envelope: String },
}

#[derive(Clone)]
pub struct Store {
    pool: Pool,
}

impl Store {
    /// Open (creating if needed) the SQLite database at `path` and ensure the
    /// schema exists. WAL + `synchronous=NORMAL` give durable, concurrent-read
    /// performance without an external service.
    pub fn open(path: &str) -> anyhow::Result<Self> {
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
                     revoked         INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);",
            )
            .context("create schema")?;
        }
        Ok(Self { pool })
    }

    /// Insert a new share. `envelope` is the opaque JSON text stored verbatim.
    pub fn create(&self, code: &str, envelope: &str, meta: &ShareMeta) -> anyhow::Result<()> {
        let conn = self.pool.get()?;
        conn.execute(
            "INSERT INTO shares
                (code, envelope, created_at, expires_at, max_views, burn_after_read, view_count, revoked)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                code,
                envelope,
                meta.created_at,
                meta.expires_at,
                meta.max_views.map(|v| v as i64),
                meta.burn_after_read as i64,
                meta.view_count as i64,
                meta.revoked as i64,
            ],
        )?;
        Ok(())
    }

    /// Read a share and atomically apply its lifecycle decision. Returns the
    /// envelope on success, or [`ReadOutcome::NotFound`] when absent or gated;
    /// gated/expired rows are deleted in the same transaction.
    pub fn read_and_advance(&self, code: &str, now_ms: i64) -> anyhow::Result<ReadOutcome> {
        let mut conn = self.pool.get()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let row = tx
            .query_row(
                "SELECT envelope, created_at, expires_at, max_views, burn_after_read, view_count, revoked
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
                    };
                    Ok((envelope, meta))
                },
            )
            .optional()?;

        let Some((envelope, meta)) = row else {
            tx.commit()?;
            return Ok(ReadOutcome::NotFound);
        };

        let outcome = match evaluate_read(&meta, now_ms) {
            ReadDecision::NotFound => {
                tx.execute("DELETE FROM shares WHERE code = ?1", [code])?;
                ReadOutcome::NotFound
            }
            ReadDecision::ServeAndDestroy => {
                tx.execute("DELETE FROM shares WHERE code = ?1", [code])?;
                ReadOutcome::Served { envelope }
            }
            ReadDecision::ServeAndUpdate { next_count } => {
                tx.execute(
                    "UPDATE shares SET view_count = ?2 WHERE code = ?1",
                    params![code, next_count as i64],
                )?;
                ReadOutcome::Served { envelope }
            }
        };
        tx.commit()?;
        Ok(outcome)
    }

    /// Owner-only metadata lookup. Returns `None` when absent or already past
    /// `expires_at` (lazily deleting the expired row), mirroring the Worker's
    /// KV-TTL-gated stats read.
    pub fn stats(&self, code: &str, now_ms: i64) -> anyhow::Result<Option<ShareMeta>> {
        let conn = self.pool.get()?;
        let meta = conn
            .query_row(
                "SELECT created_at, expires_at, max_views, burn_after_read, view_count, revoked
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
                    })
                },
            )
            .optional()?;

        let Some(meta) = meta else {
            return Ok(None);
        };
        if let Some(exp) = meta.expires_at {
            if now_ms >= exp {
                conn.execute("DELETE FROM shares WHERE code = ?1", [code])?;
                return Ok(None);
            }
        }
        Ok(Some(meta))
    }

    /// Hard-delete a share (owner revoke). Idempotent — deleting an absent code
    /// is a no-op.
    pub fn delete(&self, code: &str) -> anyhow::Result<()> {
        let conn = self.pool.get()?;
        conn.execute("DELETE FROM shares WHERE code = ?1", [code])?;
        Ok(())
    }

    /// Delete every share whose `expires_at` is at/under `now_ms`. Returns the
    /// number reaped. Called periodically by the reaper task.
    pub fn reap_expired(&self, now_ms: i64) -> anyhow::Result<usize> {
        let conn = self.pool.get()?;
        let n = conn.execute(
            "DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            [now_ms],
        )?;
        Ok(n)
    }

    /// Count live shares (gauge for `/healthz` and `/metrics`).
    pub fn count(&self) -> anyhow::Result<u64> {
        let conn = self.pool.get()?;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM shares", [], |r| r.get(0))?;
        Ok(n as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        }
    }

    #[test]
    fn create_then_read_returns_envelope() {
        let (store, _dir) = temp_store();
        store.create("abc", "{\"v\":1}", &meta(None, None)).unwrap();
        assert_eq!(
            store.read_and_advance("abc", 2_000).unwrap(),
            ReadOutcome::Served { envelope: "{\"v\":1}".into() }
        );
        assert_eq!(store.count().unwrap(), 1);
    }

    #[test]
    fn read_unknown_is_not_found() {
        let (store, _dir) = temp_store();
        assert_eq!(store.read_and_advance("nope", 0).unwrap(), ReadOutcome::NotFound);
    }

    #[test]
    fn max_views_self_destructs_after_n_reads() {
        let (store, _dir) = temp_store();
        store.create("c", "{}", &meta(None, Some(2))).unwrap();
        assert!(matches!(store.read_and_advance("c", 0).unwrap(), ReadOutcome::Served { .. }));
        assert!(matches!(store.read_and_advance("c", 0).unwrap(), ReadOutcome::Served { .. }));
        // Third read — row already destroyed on the second (final) view.
        assert_eq!(store.read_and_advance("c", 0).unwrap(), ReadOutcome::NotFound);
        assert_eq!(store.count().unwrap(), 0);
    }

    #[test]
    fn burn_after_read_destroys_on_first_view() {
        let (store, _dir) = temp_store();
        store.create("b", "{}", &meta(None, Some(1))).unwrap();
        assert!(matches!(store.read_and_advance("b", 0).unwrap(), ReadOutcome::Served { .. }));
        assert_eq!(store.read_and_advance("b", 0).unwrap(), ReadOutcome::NotFound);
    }

    #[test]
    fn expired_read_deletes_row_and_returns_not_found() {
        let (store, _dir) = temp_store();
        store.create("e", "{}", &meta(Some(5_000), None)).unwrap();
        assert_eq!(store.read_and_advance("e", 5_000).unwrap(), ReadOutcome::NotFound);
        assert_eq!(store.count().unwrap(), 0);
    }

    #[test]
    fn stats_reports_meta_and_advances_with_reads() {
        let (store, _dir) = temp_store();
        store.create("s", "{}", &meta(Some(9_999), Some(5))).unwrap();
        store.read_and_advance("s", 0).unwrap();
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
        assert_eq!(store.read_and_advance("d", 0).unwrap(), ReadOutcome::NotFound);
        // Deleting an absent code is a no-op.
        store.delete("d").unwrap();
    }

    #[test]
    fn reaper_deletes_only_expired_rows() {
        let (store, _dir) = temp_store();
        store.create("past", "{}", &meta(Some(100), None)).unwrap();
        store.create("future", "{}", &meta(Some(10_000), None)).unwrap();
        store.create("never", "{}", &meta(None, None)).unwrap();
        let reaped = store.reap_expired(5_000).unwrap();
        assert_eq!(reaped, 1);
        assert_eq!(store.count().unwrap(), 2);
        assert!(store.stats("future", 0).unwrap().is_some());
        assert!(store.stats("never", 0).unwrap().is_some());
    }
}
