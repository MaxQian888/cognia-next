//! `file-share.sqlite`: one file per local account (ADR-0222 §4.3).
//!
//! Synchronous rusqlite behind a mutex, like the companion stores. Every call
//! is short (one statement or one small transaction); callers on an async
//! runtime that do many of them in a row use `spawn_blocking`.
//!
//! Schema changes are migrations keyed by `PRAGMA user_version`, applied in
//! order on open. Rows whose enums this build does not know (a later phase's
//! audience, say) are skipped on read rather than served.

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{FileShareError, FileShareResult};
use crate::model::{
    AssetEntry, Audience, Backing, CollabRole, CreatedBy, CredentialView, Grant, GrantPath,
    GrantStatus, MountRecord, Permission, Protocol, ProviderKind, SessionState,
};

const MIGRATIONS: &[&str] = &[
    // 1 — ADR-0222 P2.
    r#"
    CREATE TABLE file_space_mounts (
      session_id TEXT NOT NULL,
      mount_id TEXT NOT NULL,
      virtual_path TEXT NOT NULL,
      backing TEXT NOT NULL CHECK (backing IN ('disk','dexie')),
      host_path TEXT,
      writable INTEGER NOT NULL,
      status TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      session_state TEXT NOT NULL CHECK (session_state IN ('active','archived','deleted')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, mount_id)
    );
    CREATE TABLE file_space_assets (
      session_id TEXT NOT NULL,
      mount_id TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      modified_at INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY (session_id, mount_id, name)
    );
    CREATE TABLE file_grants (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      label TEXT,
      created_by TEXT NOT NULL,
      creator_principal TEXT NOT NULL,
      audience_kind TEXT NOT NULL,
      audience_json TEXT NOT NULL,
      provider TEXT NOT NULL,
      permissions TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','suspended','stale','expired','revoked')),
      status_reason TEXT,
      expires_at INTEGER NOT NULL,
      policy_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX file_grants_session ON file_grants(session_id, status);
    CREATE TABLE file_grant_paths (
      grant_id TEXT NOT NULL REFERENCES file_grants(id) ON DELETE CASCADE,
      mount_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      is_dir INTEGER NOT NULL,
      mount_fingerprint TEXT NOT NULL,
      virtual_path TEXT NOT NULL,
      PRIMARY KEY (grant_id, mount_id, rel_path)
    );
    CREATE TABLE file_credentials (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES file_grants(id) ON DELETE CASCADE,
      protocol TEXT NOT NULL CHECK (protocol IN ('webdav','sftp')),
      provider TEXT NOT NULL CHECK (provider IN ('builtin','sftpgo')),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      ssh_public_key TEXT,
      ssh_key_fingerprint TEXT,
      provider_account_id TEXT,
      created_at INTEGER NOT NULL,
      rotated_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX file_credentials_grant ON file_credentials(grant_id);
    CREATE TABLE file_auth_failures (
      key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      locked_until INTEGER NOT NULL,
      last_failure_at INTEGER NOT NULL
    );
    CREATE TABLE file_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      session_id TEXT,
      grant_id TEXT,
      principal TEXT NOT NULL,
      channel TEXT NOT NULL,
      action TEXT NOT NULL,
      path TEXT,
      bytes INTEGER,
      outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','failed')),
      reason TEXT,
      remote TEXT
    );
    CREATE INDEX file_audit_session ON file_audit(session_id, at);
    CREATE INDEX file_audit_grant ON file_audit(grant_id, at);
    CREATE TABLE file_share_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE file_provider_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      op TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    "#,
    // 2 — ADR-0222 P3: a conversation's state outlives its mount table. A
    // deleted conversation is pushed with no mounts, so the state the
    // lifecycle cascade acts on cannot live on the mount rows alone.
    r#"
    CREATE TABLE file_space_sessions (
      session_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('active','archived','deleted')),
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO file_space_sessions (session_id, state, updated_at)
      SELECT session_id, session_state, MAX(updated_at) FROM file_space_mounts GROUP BY session_id;
    "#,
    // 3 — ADR-0222 P3: collaboration members. A conversation's registration
    // as the file host of its shared counterpart (the token lives in the
    // secret store), and per grant a revision every state change bumps and
    // the revision last mirrored to the collaboration server, so a mirror
    // that failed is retried with the grant's latest state.
    r#"
    CREATE TABLE file_collab_hosts (
      session_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      collab_session_id TEXT NOT NULL,
      server_url TEXT NOT NULL,
      host_label TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    ALTER TABLE file_grants ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE file_grants ADD COLUMN mirrored_revision INTEGER;
    "#,
];

/// A grant for credential holders (P2).
const AUDIENCE_CREDENTIAL: &str = "credential";
/// A grant for a shared conversation's members (P3).
const AUDIENCE_COLLAB: &str = "collab";

/// A conversation registered as the file host of its shared counterpart.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollabHostRecord {
    pub session_id: String,
    pub org_id: String,
    pub collab_session_id: String,
    pub server_url: String,
    pub host_label: String,
    pub registered_at: i64,
    pub updated_at: i64,
}

/// A credential row, including what is never sent to a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialRow {
    pub view: CredentialView,
    pub password_hash: Option<String>,
    pub ssh_public_key: Option<String>,
    pub provider_account_id: Option<String>,
}

/// Persisted failed-authentication state for one `(username, remote)` key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FailureRecord {
    pub failures: u32,
    pub locked_until: i64,
    pub last_failure_at: i64,
}

/// One audit row.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    pub id: i64,
    pub at: i64,
    pub session_id: Option<String>,
    pub grant_id: Option<String>,
    pub principal: String,
    pub channel: String,
    pub action: String,
    pub path: Option<String>,
    pub bytes: Option<i64>,
    pub outcome: String,
    pub reason: Option<String>,
    pub remote: Option<String>,
}

/// One queued provider operation awaiting a retry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderOp {
    pub id: i64,
    pub provider: String,
    pub op: String,
    pub credential_id: String,
    pub payload: String,
    pub attempts: u32,
}

/// The account's file-share database.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Open (creating when absent) and migrate the database at `path`.
    pub fn open(path: &Path) -> FileShareResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(FileShareError::store)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Self::from_connection(conn)
    }

    /// An in-memory database (tests).
    pub fn open_in_memory() -> FileShareResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> FileShareResult<Self> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let known = MIGRATIONS.len() as i64;
        if version > known {
            return Err(FileShareError::store(format!(
                "file-share.sqlite is at schema {version}, newer than this build ({known})"
            )));
        }
        for (index, migration) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(migration)?;
            tx.pragma_update(None, "user_version", (index + 1) as i64)?;
            tx.commit()?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    // ── Mounts ─────────────────────────────────────────────────────────────

    /// Replace one conversation's mount table and Dexie entries, and record
    /// its state (kept even when, deleted, it has no mounts left).
    pub fn replace_session_mounts(
        &self,
        session_id: &str,
        state: SessionState,
        mounts: &[MountRecord],
        assets: &[AssetEntry],
        now: i64,
    ) -> FileShareResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        upsert_session_state(&tx, session_id, state, now)?;
        tx.execute(
            "DELETE FROM file_space_mounts WHERE session_id = ?1",
            params![session_id],
        )?;
        tx.execute(
            "DELETE FROM file_space_assets WHERE session_id = ?1",
            params![session_id],
        )?;
        for mount in mounts {
            tx.execute(
                "INSERT INTO file_space_mounts (session_id, mount_id, virtual_path, backing, \
                 host_path, writable, status, fingerprint, session_state, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    session_id,
                    mount.mount_id,
                    mount.virtual_path,
                    mount.backing.as_str(),
                    mount.host_path,
                    mount.writable,
                    mount.status,
                    mount.fingerprint,
                    mount.session_state.as_str(),
                    mount.updated_at,
                ],
            )?;
        }
        for asset in assets {
            tx.execute(
                "INSERT OR REPLACE INTO file_space_assets (session_id, mount_id, name, size, \
                 media_type, modified_at, source_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    session_id,
                    asset.mount_id,
                    asset.name,
                    asset.size as i64,
                    asset.media_type,
                    asset.modified_at,
                    asset.source_id,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Record a conversation's new state and mark its mounts with it,
    /// keeping the table (an archived conversation's mounts still exist).
    pub fn set_session_state(
        &self,
        session_id: &str,
        state: SessionState,
        now: i64,
    ) -> FileShareResult<usize> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        upsert_session_state(&tx, session_id, state, now)?;
        let marked = tx.execute(
            "UPDATE file_space_mounts SET session_state = ?2, updated_at = ?3 WHERE session_id = ?1",
            params![session_id, state.as_str(), now],
        )?;
        tx.commit()?;
        Ok(marked)
    }

    pub fn mounts_for_session(&self, session_id: &str) -> FileShareResult<Vec<MountRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT session_id, mount_id, virtual_path, backing, host_path, writable, status, \
             fingerprint, session_state, updated_at FROM file_space_mounts WHERE session_id = ?1 \
             ORDER BY virtual_path",
        )?;
        let rows = stmt.query_map(params![session_id], mount_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            if let Some(mount) = row? {
                out.push(mount);
            }
        }
        Ok(out)
    }

    pub fn mount(&self, session_id: &str, mount_id: &str) -> FileShareResult<Option<MountRecord>> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                "SELECT session_id, mount_id, virtual_path, backing, host_path, writable, status, \
                 fingerprint, session_state, updated_at FROM file_space_mounts \
                 WHERE session_id = ?1 AND mount_id = ?2",
                params![session_id, mount_id],
                mount_from_row,
            )
            .optional()?;
        Ok(row.flatten())
    }

    pub fn assets(&self, session_id: &str, mount_id: &str) -> FileShareResult<Vec<AssetEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT mount_id, name, size, media_type, modified_at, source_id FROM file_space_assets \
             WHERE session_id = ?1 AND mount_id = ?2 ORDER BY name",
        )?;
        let rows = stmt.query_map(params![session_id, mount_id], asset_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn asset(
        &self,
        session_id: &str,
        mount_id: &str,
        name: &str,
    ) -> FileShareResult<Option<AssetEntry>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT mount_id, name, size, media_type, modified_at, source_id FROM \
                 file_space_assets WHERE session_id = ?1 AND mount_id = ?2 AND name = ?3",
                params![session_id, mount_id, name],
                asset_from_row,
            )
            .optional()?)
    }

    // ── Grants ─────────────────────────────────────────────────────────────

    /// Insert a grant, its paths and its credentials in one transaction.
    pub fn insert_grant(&self, grant: &Grant, credentials: &[CredentialRow]) -> FileShareResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let permissions: Vec<&str> = grant.permissions.iter().map(|p| p.as_str()).collect();
        let (audience_kind, audience_json) = audience_columns(grant);
        tx.execute(
            "INSERT INTO file_grants (id, session_id, label, created_by, creator_principal, \
             audience_kind, audience_json, provider, permissions, status, status_reason, \
             expires_at, policy_revision, created_at, updated_at, revoked_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                grant.id,
                grant.session_id,
                grant.label,
                grant.created_by.as_str(),
                grant.creator_principal,
                audience_kind,
                audience_json,
                grant.provider.as_str(),
                serde_json::to_string(&permissions).map_err(FileShareError::store)?,
                grant.status.as_str(),
                grant.status_reason,
                grant.expires_at,
                grant.policy_revision,
                grant.created_at,
                grant.updated_at,
                grant.revoked_at,
            ],
        )?;
        for path in &grant.paths {
            tx.execute(
                "INSERT INTO file_grant_paths (grant_id, mount_id, rel_path, is_dir, \
                 mount_fingerprint, virtual_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    grant.id,
                    path.mount_id,
                    path.rel_path,
                    path.is_dir,
                    path.mount_fingerprint,
                    path.virtual_path,
                ],
            )?;
        }
        for credential in credentials {
            insert_credential(&tx, credential)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn grant(&self, id: &str) -> FileShareResult<Option<Grant>> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                &format!("{GRANT_SELECT} WHERE id = ?1"),
                params![id],
                grant_from_row,
            )
            .optional()?
            .flatten();
        match row {
            Some(mut grant) => {
                grant.paths = grant_paths(&conn, &grant.id)?;
                Ok(Some(grant))
            }
            None => Ok(None),
        }
    }

    /// Grants, newest first; one conversation's when `session_id` is set.
    pub fn list_grants(&self, session_id: Option<&str>) -> FileShareResult<Vec<Grant>> {
        let conn = self.conn.lock();
        let mut grants = Vec::new();
        {
            let (sql, args): (String, Vec<String>) = match session_id {
                Some(id) => (
                    format!("{GRANT_SELECT} WHERE session_id = ?1 ORDER BY created_at DESC"),
                    vec![id.to_string()],
                ),
                None => (format!("{GRANT_SELECT} ORDER BY created_at DESC"), Vec::new()),
            };
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), grant_from_row)?;
            for row in rows {
                if let Some(grant) = row? {
                    grants.push(grant);
                }
            }
        }
        for grant in &mut grants {
            grant.paths = grant_paths(&conn, &grant.id)?;
        }
        Ok(grants)
    }

    /// One page of grants, newest first, after the keyset cursor `after`
    /// (`(created_at, id)` of the previous page's last grant).
    pub fn list_grants_page(
        &self,
        session_id: Option<&str>,
        after: Option<(i64, String)>,
        limit: u32,
    ) -> FileShareResult<Vec<Grant>> {
        let conn = self.conn.lock();
        let mut grants = Vec::new();
        {
            let (after_at, after_id) = match &after {
                Some((at, id)) => (Some(*at), Some(id.as_str())),
                None => (None, None),
            };
            let sql = format!(
                // Only audiences this build serves, so a page is never short
                // of rows that exist.
                "{GRANT_SELECT} WHERE audience_kind IN ('{AUDIENCE_CREDENTIAL}', '{AUDIENCE_COLLAB}') \
                 AND (?1 IS NULL OR session_id = ?1) \
                 AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3)) \
                 ORDER BY created_at DESC, id DESC LIMIT ?4"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                params![session_id, after_at, after_id, limit.max(1) as i64],
                grant_from_row,
            )?;
            for row in rows {
                if let Some(grant) = row? {
                    grants.push(grant);
                }
            }
        }
        for grant in &mut grants {
            grant.paths = grant_paths(&conn, &grant.id)?;
        }
        Ok(grants)
    }

    /// Conversations that have a grant which can still be served or resumed.
    pub fn sessions_with_open_grants(&self) -> FileShareResult<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT session_id FROM file_grants \
             WHERE status IN ('active','suspended','stale') ORDER BY session_id",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Move a grant to `status`. A terminal grant never moves; the call
    /// reports whether a row changed.
    pub fn set_grant_status(
        &self,
        id: &str,
        status: GrantStatus,
        reason: Option<&str>,
        now: i64,
    ) -> FileShareResult<bool> {
        let conn = self.conn.lock();
        let revoked_at = if status == GrantStatus::Revoked {
            Some(now)
        } else {
            None
        };
        let changed = conn.execute(
            "UPDATE file_grants SET status = ?2, status_reason = ?3, updated_at = ?4, \
             revoked_at = COALESCE(?5, revoked_at), revision = revision + 1 \
             WHERE id = ?1 AND status NOT IN ('expired','revoked')",
            params![id, status.as_str(), reason, now, revoked_at],
        )?;
        Ok(changed > 0)
    }

    /// Re-bind one grant path to its mount's current fingerprint (the owner
    /// reconfirming a stale grant).
    pub fn set_grant_path_fingerprint(
        &self,
        grant_id: &str,
        mount_id: &str,
        rel_path: &str,
        fingerprint: &str,
    ) -> FileShareResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE file_grant_paths SET mount_fingerprint = ?4 \
             WHERE grant_id = ?1 AND mount_id = ?2 AND rel_path = ?3",
            params![grant_id, mount_id, rel_path, fingerprint],
        )?;
        Ok(())
    }

    // ── Collaboration mirror ───────────────────────────────────────────────

    /// Collaboration grants whose current revision the server has not
    /// accepted yet, with that revision.
    pub fn grants_to_mirror(&self) -> FileShareResult<Vec<(Grant, i64)>> {
        let conn = self.conn.lock();
        let mut out = Vec::new();
        {
            let mut stmt = conn.prepare(&format!(
                "{GRANT_SELECT} WHERE audience_kind = '{AUDIENCE_COLLAB}' \
                 AND (mirrored_revision IS NULL OR mirrored_revision < revision) \
                 ORDER BY created_at"
            ))?;
            let rows = stmt.query_map([], |row| {
                Ok((grant_from_row(row)?, row.get::<_, i64>(GRANT_REVISION_COLUMN)?))
            })?;
            for row in rows {
                let (grant, revision) = row?;
                if let Some(grant) = grant {
                    out.push((grant, revision));
                }
            }
        }
        for (grant, _) in &mut out {
            grant.paths = grant_paths(&conn, &grant.id)?;
        }
        Ok(out)
    }

    /// Record that the server holds `revision` of a grant (never moving
    /// backwards past a newer one).
    pub fn mark_mirrored(&self, grant_id: &str, revision: i64) -> FileShareResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE file_grants SET mirrored_revision = ?2 \
             WHERE id = ?1 AND (mirrored_revision IS NULL OR mirrored_revision < ?2)",
            params![grant_id, revision],
        )?;
        Ok(())
    }

    // ── Collaboration hosts ────────────────────────────────────────────────

    pub fn put_collab_host(&self, host: &CollabHostRecord) -> FileShareResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO file_collab_hosts (session_id, org_id, collab_session_id, server_url, \
             host_label, registered_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(session_id) DO UPDATE SET org_id = excluded.org_id, \
             collab_session_id = excluded.collab_session_id, server_url = excluded.server_url, \
             host_label = excluded.host_label, registered_at = excluded.registered_at, \
             updated_at = excluded.updated_at",
            params![
                host.session_id,
                host.org_id,
                host.collab_session_id,
                host.server_url,
                host.host_label,
                host.registered_at,
                host.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn collab_host(&self, session_id: &str) -> FileShareResult<Option<CollabHostRecord>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                &format!("{COLLAB_HOST_SELECT} WHERE session_id = ?1"),
                params![session_id],
                collab_host_from_row,
            )
            .optional()?)
    }

    pub fn collab_hosts(&self) -> FileShareResult<Vec<CollabHostRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!("{COLLAB_HOST_SELECT} ORDER BY session_id"))?;
        let rows = stmt.query_map([], collab_host_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Forget a registration; reports whether there was one.
    pub fn delete_collab_host(&self, session_id: &str) -> FileShareResult<bool> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "DELETE FROM file_collab_hosts WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(changed > 0)
    }

    /// The conversation's state as the app last reported it.
    pub fn session_state(&self, session_id: &str) -> FileShareResult<Option<SessionState>> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row(
                "SELECT state FROM file_space_sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(raw.and_then(|value| SessionState::parse(&value).ok()))
    }

    // ── Credentials ────────────────────────────────────────────────────────

    pub fn credentials_for_grant(&self, grant_id: &str) -> FileShareResult<Vec<CredentialRow>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "{CREDENTIAL_SELECT} WHERE grant_id = ?1 ORDER BY protocol"
        ))?;
        let rows = stmt.query_map(params![grant_id], credential_from_row)?;
        Ok(rows.filter_map(|row| row.ok().flatten()).collect())
    }

    pub fn credential(&self, id: &str) -> FileShareResult<Option<CredentialRow>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                &format!("{CREDENTIAL_SELECT} WHERE id = ?1"),
                params![id],
                credential_from_row,
            )
            .optional()?
            .flatten())
    }

    pub fn credential_by_username(&self, username: &str) -> FileShareResult<Option<CredentialRow>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                &format!("{CREDENTIAL_SELECT} WHERE username = ?1"),
                params![username],
                credential_from_row,
            )
            .optional()?
            .flatten())
    }

    pub fn username_taken(&self, username: &str) -> FileShareResult<bool> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT 1 FROM file_credentials WHERE username = ?1",
                params![username],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Store a rotated secret.
    pub fn rotate_credential(
        &self,
        id: &str,
        password_hash: Option<&str>,
        now: i64,
    ) -> FileShareResult<bool> {
        let conn = self.conn.lock();
        Ok(conn.execute(
            "UPDATE file_credentials SET password_hash = ?2, rotated_at = ?3 \
             WHERE id = ?1 AND revoked_at IS NULL",
            params![id, password_hash, now],
        )? > 0)
    }

    /// Revoke every live credential of a grant; returns the ones revoked.
    pub fn revoke_credentials_for_grant(
        &self,
        grant_id: &str,
        now: i64,
    ) -> FileShareResult<Vec<CredentialRow>> {
        let live: Vec<CredentialRow> = self
            .credentials_for_grant(grant_id)?
            .into_iter()
            .filter(|row| row.view.revoked_at.is_none())
            .collect();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE file_credentials SET revoked_at = ?2 WHERE grant_id = ?1 AND revoked_at IS NULL",
            params![grant_id, now],
        )?;
        Ok(live)
    }

    // ── Auth backoff ───────────────────────────────────────────────────────

    pub fn failure(&self, key: &str) -> FileShareResult<FailureRecord> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT failures, locked_until, last_failure_at FROM file_auth_failures WHERE key = ?1",
                params![key],
                |row| {
                    Ok(FailureRecord {
                        failures: row.get::<_, i64>(0)?.max(0) as u32,
                        locked_until: row.get(1)?,
                        last_failure_at: row.get(2)?,
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    }

    pub fn put_failure(&self, key: &str, record: FailureRecord) -> FileShareResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO file_auth_failures (key, failures, locked_until, last_failure_at) \
             VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, \
             locked_until = excluded.locked_until, last_failure_at = excluded.last_failure_at",
            params![
                key,
                record.failures as i64,
                record.locked_until,
                record.last_failure_at
            ],
        )?;
        Ok(())
    }

    pub fn clear_failure(&self, key: &str) -> FileShareResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM file_auth_failures WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Forget failure records untouched since `before`.
    pub fn prune_failures(&self, before: i64) -> FileShareResult<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute(
            "DELETE FROM file_auth_failures WHERE last_failure_at < ?1 AND locked_until < ?1",
            params![before],
        )?)
    }

    // ── Audit ──────────────────────────────────────────────────────────────

    pub fn insert_audit(&self, row: &AuditRow) -> FileShareResult<i64> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO file_audit (at, session_id, grant_id, principal, channel, action, path, \
             bytes, outcome, reason, remote) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                row.at,
                row.session_id,
                row.grant_id,
                row.principal,
                row.channel,
                row.action,
                row.path,
                row.bytes,
                row.outcome,
                row.reason,
                row.remote,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Audit rows newest first, filtered by conversation or grant, paged by
    /// `before_id`.
    pub fn list_audit(
        &self,
        session_id: Option<&str>,
        grant_id: Option<&str>,
        before_id: Option<i64>,
        limit: u32,
    ) -> FileShareResult<Vec<AuditRow>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, at, session_id, grant_id, principal, channel, action, path, bytes, \
             outcome, reason, remote FROM file_audit \
             WHERE (?1 IS NULL OR session_id = ?1) AND (?2 IS NULL OR grant_id = ?2) \
             AND (?3 IS NULL OR id < ?3) ORDER BY id DESC LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![session_id, grant_id, before_id, limit.clamp(1, 1000) as i64],
            |row| {
                Ok(AuditRow {
                    id: row.get(0)?,
                    at: row.get(1)?,
                    session_id: row.get(2)?,
                    grant_id: row.get(3)?,
                    principal: row.get(4)?,
                    channel: row.get(5)?,
                    action: row.get(6)?,
                    path: row.get(7)?,
                    bytes: row.get(8)?,
                    outcome: row.get(9)?,
                    reason: row.get(10)?,
                    remote: row.get(11)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn prune_audit(&self, before: i64) -> FileShareResult<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM file_audit WHERE at < ?1", params![before])?)
    }

    // ── Settings ───────────────────────────────────────────────────────────

    pub fn setting<T: serde::de::DeserializeOwned>(&self, key: &str) -> FileShareResult<Option<T>> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM file_share_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        match raw {
            Some(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(FileShareError::store),
            None => Ok(None),
        }
    }

    pub fn set_setting<T: serde::Serialize>(
        &self,
        key: &str,
        value: &T,
        now: i64,
    ) -> FileShareResult<()> {
        let raw = serde_json::to_string(value).map_err(FileShareError::store)?;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO file_share_settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, raw, now],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> FileShareResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM file_share_settings WHERE key = ?1",
            params![key],
        )?;
        Ok(())
    }

    // ── Provider retry queue ───────────────────────────────────────────────

    pub fn enqueue_provider_op(
        &self,
        provider: &str,
        op: &str,
        credential_id: &str,
        payload: &str,
        next_at: i64,
        error: &str,
    ) -> FileShareResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO file_provider_ops (provider, op, credential_id, payload, attempts, \
             next_at, last_error, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?5)",
            params![provider, op, credential_id, payload, next_at, error],
        )?;
        Ok(())
    }

    pub fn due_provider_ops(&self, now: i64) -> FileShareResult<Vec<ProviderOp>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, provider, op, credential_id, payload, attempts FROM file_provider_ops \
             WHERE next_at <= ?1 ORDER BY id LIMIT 50",
        )?;
        let rows = stmt.query_map(params![now], |row| {
            Ok(ProviderOp {
                id: row.get(0)?,
                provider: row.get(1)?,
                op: row.get(2)?,
                credential_id: row.get(3)?,
                payload: row.get(4)?,
                attempts: row.get::<_, i64>(5)?.max(0) as u32,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn pending_provider_ops(&self) -> FileShareResult<usize> {
        let conn = self.conn.lock();
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM file_provider_ops", [], |row| row.get(0))?;
        Ok(count.max(0) as usize)
    }

    pub fn complete_provider_op(&self, id: i64) -> FileShareResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM file_provider_ops WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn reschedule_provider_op(&self, id: i64, next_at: i64, error: &str) -> FileShareResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE file_provider_ops SET attempts = attempts + 1, next_at = ?2, last_error = ?3 \
             WHERE id = ?1",
            params![id, next_at, error],
        )?;
        Ok(())
    }
}

const GRANT_SELECT: &str = "SELECT id, session_id, label, created_by, creator_principal, \
     audience_kind, audience_json, provider, permissions, status, status_reason, expires_at, \
     policy_revision, created_at, updated_at, revoked_at, revision FROM file_grants";

/// The index of `revision` in [`GRANT_SELECT`].
const GRANT_REVISION_COLUMN: usize = 16;

const COLLAB_HOST_SELECT: &str = "SELECT session_id, org_id, collab_session_id, server_url, \
     host_label, registered_at, updated_at FROM file_collab_hosts";

fn collab_host_from_row(row: &Row<'_>) -> rusqlite::Result<CollabHostRecord> {
    Ok(CollabHostRecord {
        session_id: row.get(0)?,
        org_id: row.get(1)?,
        collab_session_id: row.get(2)?,
        server_url: row.get(3)?,
        host_label: row.get(4)?,
        registered_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// How a grant's audience is stored: its kind, and a JSON object with what
/// the kind needs (credential protocols; the collaboration binding).
fn audience_columns(grant: &Grant) -> (&'static str, String) {
    match &grant.audience {
        Audience::Credentials => {
            let protocols: Vec<&str> = grant.protocols.iter().map(|p| p.as_str()).collect();
            (
                AUDIENCE_CREDENTIAL,
                serde_json::json!({ "protocols": protocols }).to_string(),
            )
        }
        Audience::Collab {
            org_id,
            collab_session_id,
            user_ids,
            min_role,
        } => (
            AUDIENCE_COLLAB,
            serde_json::json!({
                "orgId": org_id,
                "collabSessionId": collab_session_id,
                "userIds": user_ids,
                "minRole": min_role.as_str(),
            })
            .to_string(),
        ),
    }
}

/// The audience and protocols of a stored row, or `None` for a kind or shape
/// this build does not know.
fn audience_of(kind: &str, json: &str) -> Option<(Audience, Vec<Protocol>)> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    match kind {
        AUDIENCE_CREDENTIAL => {
            let protocols = value["protocols"]
                .as_array()?
                .iter()
                .filter_map(|item| item.as_str().and_then(|s| Protocol::parse(s).ok()))
                .collect();
            Some((Audience::Credentials, protocols))
        }
        AUDIENCE_COLLAB => {
            let min_role: CollabRole = serde_json::from_value(value["minRole"].clone()).ok()?;
            let user_ids: Option<Vec<String>> = match &value["userIds"] {
                serde_json::Value::Null => None,
                other => Some(serde_json::from_value(other.clone()).ok()?),
            };
            Some((
                Audience::Collab {
                    org_id: value["orgId"].as_str()?.to_string(),
                    collab_session_id: value["collabSessionId"].as_str()?.to_string(),
                    user_ids,
                    min_role,
                },
                Vec::new(),
            ))
        }
        _ => None,
    }
}

const CREDENTIAL_SELECT: &str = "SELECT id, grant_id, protocol, provider, username, \
     password_hash, ssh_public_key, ssh_key_fingerprint, provider_account_id, created_at, \
     rotated_at, revoked_at FROM file_credentials";

fn mount_from_row(row: &Row<'_>) -> rusqlite::Result<Option<MountRecord>> {
    let backing: String = row.get(3)?;
    let state: String = row.get(8)?;
    let (Ok(backing), Ok(session_state)) = (Backing::parse(&backing), SessionState::parse(&state))
    else {
        return Ok(None);
    };
    Ok(Some(MountRecord {
        session_id: row.get(0)?,
        mount_id: row.get(1)?,
        virtual_path: row.get(2)?,
        backing,
        host_path: row.get(4)?,
        writable: row.get(5)?,
        status: row.get(6)?,
        fingerprint: row.get(7)?,
        session_state,
        updated_at: row.get(9)?,
    }))
}

fn asset_from_row(row: &Row<'_>) -> rusqlite::Result<AssetEntry> {
    Ok(AssetEntry {
        mount_id: row.get(0)?,
        name: row.get(1)?,
        size: row.get::<_, i64>(2)?.max(0) as u64,
        media_type: row.get(3)?,
        modified_at: row.get(4)?,
        source_id: row.get(5)?,
    })
}

fn grant_from_row(row: &Row<'_>) -> rusqlite::Result<Option<Grant>> {
    let audience_kind: String = row.get(5)?;
    let Some((audience, protocols)) = audience_of(&audience_kind, &row.get::<_, String>(6)?) else {
        return Ok(None);
    };
    let permissions: Option<Vec<Permission>> =
        serde_json::from_str::<Vec<String>>(&row.get::<_, String>(8)?)
            .ok()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| Permission::parse(item).ok())
                    .collect()
            });
    let created_by: String = row.get(3)?;
    let provider: String = row.get(7)?;
    let status: String = row.get(9)?;
    let (Some(permissions), Ok(provider), Ok(status), Some(created_by)) = (
        permissions,
        ProviderKind::parse(&provider),
        GrantStatus::parse(&status),
        CreatedBy::parse(&created_by),
    ) else {
        return Ok(None);
    };
    Ok(Some(Grant {
        id: row.get(0)?,
        session_id: row.get(1)?,
        label: row.get(2)?,
        created_by,
        creator_principal: row.get(4)?,
        audience,
        protocols,
        provider,
        permissions,
        status,
        status_reason: row.get(10)?,
        expires_at: row.get(11)?,
        policy_revision: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        revoked_at: row.get(15)?,
        paths: Vec::new(),
    }))
}

fn upsert_session_state(
    conn: &Connection,
    session_id: &str,
    state: SessionState,
    now: i64,
) -> FileShareResult<()> {
    conn.execute(
        "INSERT INTO file_space_sessions (session_id, state, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
        params![session_id, state.as_str(), now],
    )?;
    Ok(())
}

fn grant_paths(conn: &Connection, grant_id: &str) -> rusqlite::Result<Vec<GrantPath>> {
    let mut stmt = conn.prepare(
        "SELECT mount_id, rel_path, is_dir, mount_fingerprint, virtual_path FROM file_grant_paths \
         WHERE grant_id = ?1 ORDER BY virtual_path",
    )?;
    let rows = stmt.query_map(params![grant_id], |row| {
        Ok(GrantPath {
            mount_id: row.get(0)?,
            rel_path: row.get(1)?,
            is_dir: row.get(2)?,
            mount_fingerprint: row.get(3)?,
            virtual_path: row.get(4)?,
        })
    })?;
    rows.collect()
}

fn credential_from_row(row: &Row<'_>) -> rusqlite::Result<Option<CredentialRow>> {
    let protocol: String = row.get(2)?;
    let provider: String = row.get(3)?;
    let (Ok(protocol), Ok(provider)) = (Protocol::parse(&protocol), ProviderKind::parse(&provider))
    else {
        return Ok(None);
    };
    Ok(Some(CredentialRow {
        view: CredentialView {
            id: row.get(0)?,
            grant_id: row.get(1)?,
            protocol,
            provider,
            username: row.get(4)?,
            ssh_key_fingerprint: row.get(7)?,
            created_at: row.get(9)?,
            rotated_at: row.get(10)?,
            revoked_at: row.get(11)?,
        },
        password_hash: row.get(5)?,
        ssh_public_key: row.get(6)?,
        provider_account_id: row.get(8)?,
    }))
}

fn insert_credential(tx: &rusqlite::Transaction<'_>, row: &CredentialRow) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO file_credentials (id, grant_id, protocol, provider, username, password_hash, \
         ssh_public_key, ssh_key_fingerprint, provider_account_id, created_at, rotated_at, \
         revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            row.view.id,
            row.view.grant_id,
            row.view.protocol.as_str(),
            row.view.provider.as_str(),
            row.view.username,
            row.password_hash,
            row.ssh_public_key,
            row.view.ssh_key_fingerprint,
            row.provider_account_id,
            row.view.created_at,
            row.view.rotated_at,
            row.view.revoked_at,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn sample_grant(id: &str, session_id: &str) -> Grant {
        Grant {
            id: id.into(),
            session_id: session_id.into(),
            label: Some("Report".into()),
            created_by: CreatedBy::User,
            creator_principal: "owner".into(),
            audience: Audience::Credentials,
            protocols: vec![Protocol::Webdav, Protocol::Sftp],
            provider: ProviderKind::Builtin,
            permissions: vec![Permission::Read, Permission::Download],
            status: GrantStatus::Active,
            status_reason: None,
            expires_at: 10_000,
            policy_revision: 1,
            created_at: 100,
            updated_at: 100,
            revoked_at: None,
            paths: vec![GrantPath {
                mount_id: "workspace".into(),
                rel_path: "src".into(),
                is_dir: true,
                mount_fingerprint: "fp".into(),
                virtual_path: "/workspace/src".into(),
            }],
        }
    }

    pub(crate) fn sample_credential(id: &str, grant_id: &str, username: &str) -> CredentialRow {
        CredentialRow {
            view: CredentialView {
                id: id.into(),
                grant_id: grant_id.into(),
                protocol: Protocol::Webdav,
                provider: ProviderKind::Builtin,
                username: username.into(),
                ssh_key_fingerprint: None,
                created_at: 100,
                rotated_at: None,
                revoked_at: None,
            },
            password_hash: Some("$hash".into()),
            ssh_public_key: None,
            provider_account_id: None,
        }
    }

    fn mount(session_id: &str, mount_id: &str) -> MountRecord {
        MountRecord {
            session_id: session_id.into(),
            mount_id: mount_id.into(),
            virtual_path: format!("/{mount_id}"),
            backing: Backing::Disk,
            host_path: Some("/repo".into()),
            writable: true,
            status: "available".into(),
            fingerprint: "fp".into(),
            session_state: SessionState::Active,
            updated_at: 1,
        }
    }

    #[test]
    fn migrations_apply_once_and_a_newer_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("file-share.sqlite");
        drop(Store::open(&path).unwrap());
        drop(Store::open(&path).unwrap());
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        drop(conn);
        let error = Store::open(&path).err().expect("newer schema refused");
        assert!(error.message.contains("newer than this build"));
    }

    #[test]
    fn a_mount_table_is_replaced_whole_with_its_assets() {
        let store = Store::open_in_memory().unwrap();
        let asset = AssetEntry {
            mount_id: "uploads".into(),
            name: "a.png".into(),
            size: 3,
            media_type: "image/png".into(),
            modified_at: 5,
            source_id: "m1".into(),
        };
        store
            .replace_session_mounts("s1", SessionState::Active, &[mount("s1", "workspace")], std::slice::from_ref(&asset), 1)
            .unwrap();
        assert_eq!(store.mounts_for_session("s1").unwrap().len(), 1);
        assert_eq!(store.assets("s1", "uploads").unwrap(), vec![asset.clone()]);
        assert_eq!(store.asset("s1", "uploads", "a.png").unwrap(), Some(asset));
        store.replace_session_mounts("s1", SessionState::Active, &[], &[], 1).unwrap();
        assert!(store.mounts_for_session("s1").unwrap().is_empty());
        assert!(store.assets("s1", "uploads").unwrap().is_empty());
    }

    #[test]
    fn a_deleted_conversation_keeps_its_state_without_mounts() {
        let store = Store::open_in_memory().unwrap();
        store
            .replace_session_mounts("s1", SessionState::Active, &[mount("s1", "workspace")], &[], 1)
            .unwrap();
        store.replace_session_mounts("s1", SessionState::Deleted, &[], &[], 2).unwrap();
        assert!(store.mounts_for_session("s1").unwrap().is_empty());
        assert_eq!(store.session_state("s1").unwrap(), Some(SessionState::Deleted));
        assert_eq!(store.session_state("s2").unwrap(), None);
    }

    #[test]
    fn upgrading_backfills_session_states_from_the_mount_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file-share.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute(
                "INSERT INTO file_space_mounts (session_id, mount_id, virtual_path, backing, host_path, \
                 writable, status, fingerprint, session_state, updated_at) \
                 VALUES ('s1', 'workspace', '/workspace', 'disk', '/repo', 1, 'available', 'fp', 'archived', 7)",
                [],
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.session_state("s1").unwrap(), Some(SessionState::Archived));
    }

    #[test]
    fn session_state_changes_keep_the_mounts() {
        let store = Store::open_in_memory().unwrap();
        store
            .replace_session_mounts("s1", SessionState::Active, &[mount("s1", "workspace")], &[], 1)
            .unwrap();
        store
            .set_session_state("s1", SessionState::Archived, 9)
            .unwrap();
        let mounts = store.mounts_for_session("s1").unwrap();
        assert_eq!(mounts[0].session_state, SessionState::Archived);
        assert!(!mounts[0].is_available());
    }

    #[test]
    fn a_grant_round_trips_with_paths_and_credentials() {
        let store = Store::open_in_memory().unwrap();
        let grant = sample_grant("fg_1", "s1");
        store
            .insert_grant(&grant, &[sample_credential("fc_1", "fg_1", "cg-aaaa")])
            .unwrap();
        assert_eq!(store.grant("fg_1").unwrap(), Some(grant.clone()));
        assert_eq!(store.list_grants(Some("s1")).unwrap(), vec![grant.clone()]);
        assert_eq!(store.list_grants_page(Some("s1"), None, 10).unwrap(), vec![grant.clone()]);
        assert!(store
            .list_grants_page(Some("s1"), Some((grant.created_at, grant.id.clone())), 10)
            .unwrap()
            .is_empty());
        assert_eq!(store.list_grants(None).unwrap().len(), 1);
        assert!(store.list_grants(Some("s2")).unwrap().is_empty());
        assert_eq!(store.sessions_with_open_grants().unwrap(), vec!["s1"]);
        let credential = store.credential_by_username("cg-aaaa").unwrap().unwrap();
        assert_eq!(credential.view.grant_id, "fg_1");
        assert!(store.username_taken("cg-aaaa").unwrap());
        assert!(!store.username_taken("cg-bbbb").unwrap());
    }

    #[test]
    fn terminal_grants_never_move_again() {
        let store = Store::open_in_memory().unwrap();
        store.insert_grant(&sample_grant("fg_1", "s1"), &[]).unwrap();
        assert!(store
            .set_grant_status("fg_1", GrantStatus::Suspended, Some("owner"), 200)
            .unwrap());
        assert!(store
            .set_grant_status("fg_1", GrantStatus::Revoked, Some("revoked"), 300)
            .unwrap());
        let revoked = store.grant("fg_1").unwrap().unwrap();
        assert_eq!(revoked.status, GrantStatus::Revoked);
        assert_eq!(revoked.revoked_at, Some(300));
        assert!(!store
            .set_grant_status("fg_1", GrantStatus::Active, None, 400)
            .unwrap());
        assert!(store.sessions_with_open_grants().unwrap().is_empty());
    }

    #[test]
    fn rows_of_an_unknown_audience_are_skipped_not_served() {
        let store = Store::open_in_memory().unwrap();
        store.insert_grant(&sample_grant("fg_1", "s1"), &[]).unwrap();
        store
            .conn
            .lock()
            .execute(
                "UPDATE file_grants SET audience_kind = 'future' WHERE id = 'fg_1'",
                [],
            )
            .unwrap();
        assert_eq!(store.grant("fg_1").unwrap(), None);
        assert!(store.list_grants(None).unwrap().is_empty());
    }

    pub(crate) fn sample_collab_grant(id: &str, session_id: &str) -> Grant {
        Grant {
            audience: Audience::Collab {
                org_id: "org_1".into(),
                collab_session_id: "ses_1".into(),
                user_ids: Some(vec!["usr_a".into()]),
                min_role: CollabRole::Member,
            },
            protocols: Vec::new(),
            ..sample_grant(id, session_id)
        }
    }

    #[test]
    fn collab_grants_round_trip_and_are_paged_with_the_rest() {
        let store = Store::open_in_memory().unwrap();
        store.insert_grant(&sample_grant("fg_1", "s1"), &[]).unwrap();
        let mut collab = sample_collab_grant("fg_2", "s1");
        collab.created_at = 200;
        store.insert_grant(&collab, &[]).unwrap();
        assert_eq!(store.grant("fg_2").unwrap().unwrap(), collab);
        let page = store.list_grants_page(Some("s1"), None, 10).unwrap();
        assert_eq!(
            page.iter().map(|grant| grant.id.as_str()).collect::<Vec<_>>(),
            vec!["fg_2", "fg_1"]
        );
        // A collab row whose binding is unreadable is skipped, not served.
        store
            .conn
            .lock()
            .execute("UPDATE file_grants SET audience_json = '{}' WHERE id = 'fg_2'", [])
            .unwrap();
        assert_eq!(store.grant("fg_2").unwrap(), None);
    }

    #[test]
    fn every_state_change_needs_mirroring_again() {
        let store = Store::open_in_memory().unwrap();
        store.insert_grant(&sample_grant("fg_1", "s1"), &[]).unwrap();
        store.insert_grant(&sample_collab_grant("fg_2", "s1"), &[]).unwrap();
        let due = store.grants_to_mirror().unwrap();
        assert_eq!(due.len(), 1, "only collaboration grants are mirrored");
        let (grant, revision) = &due[0];
        assert_eq!(grant.id, "fg_2");
        assert_eq!(grant.paths.len(), 1);
        store.mark_mirrored("fg_2", *revision).unwrap();
        assert!(store.grants_to_mirror().unwrap().is_empty());
        store
            .set_grant_status("fg_2", GrantStatus::Suspended, Some("owner"), 300)
            .unwrap();
        let (_, next) = store.grants_to_mirror().unwrap().remove(0);
        assert!(next > *revision);
        // An older revision acknowledged late does not hide the newer one.
        store.mark_mirrored("fg_2", *revision).unwrap();
        assert_eq!(store.grants_to_mirror().unwrap().len(), 1);
        store.mark_mirrored("fg_2", next).unwrap();
        assert!(store.grants_to_mirror().unwrap().is_empty());
    }

    #[test]
    fn collab_host_registrations_are_kept_per_conversation() {
        let store = Store::open_in_memory().unwrap();
        let host = CollabHostRecord {
            session_id: "s1".into(),
            org_id: "org_1".into(),
            collab_session_id: "ses_1".into(),
            server_url: "https://collab.example".into(),
            host_label: "Studio Mac".into(),
            registered_at: 10,
            updated_at: 10,
        };
        store.put_collab_host(&host).unwrap();
        assert_eq!(store.collab_host("s1").unwrap(), Some(host.clone()));
        let moved = CollabHostRecord {
            collab_session_id: "ses_2".into(),
            updated_at: 20,
            ..host
        };
        store.put_collab_host(&moved).unwrap();
        assert_eq!(store.collab_hosts().unwrap(), vec![moved]);
        assert!(store.delete_collab_host("s1").unwrap());
        assert!(!store.delete_collab_host("s1").unwrap());
        assert_eq!(store.collab_host("s1").unwrap(), None);
    }

    #[test]
    fn credentials_rotate_and_revoke_with_their_grant() {
        let store = Store::open_in_memory().unwrap();
        store
            .insert_grant(
                &sample_grant("fg_1", "s1"),
                &[sample_credential("fc_1", "fg_1", "cg-aaaa")],
            )
            .unwrap();
        assert!(store.rotate_credential("fc_1", Some("$new"), 500).unwrap());
        let rotated = store.credential("fc_1").unwrap().unwrap();
        assert_eq!(rotated.password_hash.as_deref(), Some("$new"));
        assert_eq!(rotated.view.rotated_at, Some(500));
        let revoked = store.revoke_credentials_for_grant("fg_1", 600).unwrap();
        assert_eq!(revoked.len(), 1);
        assert!(!store.rotate_credential("fc_1", Some("$x"), 700).unwrap());
        assert!(store
            .revoke_credentials_for_grant("fg_1", 800)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn failures_audit_settings_and_provider_ops_persist() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.failure("k").unwrap(), FailureRecord::default());
        let record = FailureRecord {
            failures: 6,
            locked_until: 90,
            last_failure_at: 60,
        };
        store.put_failure("k", record).unwrap();
        assert_eq!(store.failure("k").unwrap(), record);
        assert_eq!(store.prune_failures(50).unwrap(), 0);
        assert_eq!(store.prune_failures(100).unwrap(), 1);

        for at in [10, 20, 30] {
            store
                .insert_audit(&AuditRow {
                    id: 0,
                    at,
                    session_id: Some("s1".into()),
                    grant_id: Some("fg_1".into()),
                    principal: "owner".into(),
                    channel: "app".into(),
                    action: "grant.create".into(),
                    path: None,
                    bytes: None,
                    outcome: "allowed".into(),
                    reason: None,
                    remote: None,
                })
                .unwrap();
        }
        let page = store.list_audit(Some("s1"), None, None, 2).unwrap();
        assert_eq!(page.iter().map(|row| row.at).collect::<Vec<_>>(), vec![30, 20]);
        let next = store
            .list_audit(Some("s1"), None, Some(page[1].id), 2)
            .unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(store.prune_audit(25).unwrap(), 2);

        store.set_setting("k", &vec![1, 2], 1).unwrap();
        assert_eq!(store.setting::<Vec<i32>>("k").unwrap(), Some(vec![1, 2]));
        store.delete_setting("k").unwrap();
        assert_eq!(store.setting::<Vec<i32>>("k").unwrap(), None);

        store
            .enqueue_provider_op("sftpgo", "delete_user", "fc_1", "{}", 100, "down")
            .unwrap();
        assert!(store.due_provider_ops(50).unwrap().is_empty());
        let due = store.due_provider_ops(100).unwrap();
        assert_eq!(due.len(), 1);
        store.reschedule_provider_op(due[0].id, 200, "still down").unwrap();
        assert_eq!(store.due_provider_ops(200).unwrap()[0].attempts, 2);
        assert_eq!(store.pending_provider_ops().unwrap(), 1);
        store.complete_provider_op(due[0].id).unwrap();
        assert_eq!(store.pending_provider_ops().unwrap(), 0);
    }
}
