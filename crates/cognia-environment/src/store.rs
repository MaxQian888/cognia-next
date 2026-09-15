//! The tenant environment store, `<data>/environment.sqlite` (ADR-0182).
//!
//! Authorization state lives in transactional SQLite owned by Rust, the same
//! rule `companion_api/security_store.rs` follows: UI databases may cache what
//! is here, but admission never consults them. The store is separate from
//! every other Cognia database on purpose — nothing in it is migrated with, or
//! can break, the brain's Dexie schema.
//!
//! Rows hold the wire JSON of their type next to the columns queries need, so a
//! read returns exactly what was written and a new optional field never needs a
//! column migration.
//!
//! Catalog entries and approvals are revoked, never deleted: a revoked row is
//! the audit trail for what a sandbox was once admitted under.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::approval::{ApprovalRecord, EgressGrant};
use crate::catalog::{CatalogEntry, CatalogScope, TenantPolicy};
use crate::spec::EnvironmentSpec;

/// A spec as this Host admitted it.
#[derive(Debug, Clone, PartialEq)]
pub struct AdmittedSpec {
    pub spec: EnvironmentSpec,
    pub first_admitted_at: i64,
    pub last_admitted_at: i64,
}

/// Bump when a migration is appended to [`MIGRATIONS`].
const SCHEMA_VERSION: i32 = 2;

const MIGRATIONS: [&str; 2] = [
    r#"
CREATE TABLE tenant_catalog_entries (
    id TEXT PRIMARY KEY NOT NULL,
    body TEXT NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE tenant_policy (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE environment_approvals (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    normalized_remote TEXT NOT NULL,
    path TEXT NOT NULL,
    declaration_digest TEXT NOT NULL,
    body TEXT NOT NULL,
    approved_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX environment_approvals_by_declaration
    ON environment_approvals (project_id, normalized_remote, path, revoked_at);
CREATE TABLE egress_grants (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    body TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX egress_grants_by_project ON egress_grants (project_id, revoked_at);
CREATE TABLE probe_cache (
    user_image_digest TEXT NOT NULL,
    bundle_digest TEXT NOT NULL,
    report TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (user_image_digest, bundle_digest)
);
"#,
    // ADR-0182 "One resolved, immutable spec": the body a sandbox was admitted
    // under, kept after the sandbox is gone as the record of what ran.
    r#"
CREATE TABLE admitted_specs (
    spec_digest TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    body TEXT NOT NULL,
    first_admitted_at INTEGER NOT NULL,
    last_admitted_at INTEGER NOT NULL
);
CREATE INDEX admitted_specs_by_project ON admitted_specs (project_id, last_admitted_at);
"#,
];

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("environment database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("environment database row is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("environment database schema version {found} is newer than this build ({supported})")]
    SchemaTooNew { found: i32, supported: i32 },
    #[error("{0}")]
    Invalid(String),
    #[error("{kind} {id} does not exist")]
    NotFound { kind: &'static str, id: String },
}

pub struct EnvironmentStore {
    conn: Connection,
}

impl EnvironmentStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                StoreError::Invalid(format!("cannot create {}: {error}", parent.display()))
            })?;
        }
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self, StoreError> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let found: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if found > SCHEMA_VERSION {
            return Err(StoreError::SchemaTooNew {
                found,
                supported: SCHEMA_VERSION,
            });
        }
        let tx = conn.transaction_with_behavior(TransactionBehavior::Exclusive)?;
        for migration in MIGRATIONS.iter().skip(found.max(0) as usize) {
            tx.execute_batch(migration)?;
        }
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(Self { conn })
    }

    // ── tenant catalog ────────────────────────────────────────────────────

    /// Insert or replace a tenant entry. The entry must be structurally valid
    /// and tenant-scoped; whether it fits the baseline is decided at merge
    /// time, so a baseline change can make an entry available again without a
    /// rewrite here.
    pub fn upsert_tenant_entry(&self, entry: &CatalogEntry) -> Result<(), StoreError> {
        entry
            .validate("entry")
            .map_err(|error| StoreError::Invalid(error.to_string()))?;
        if entry.scope != CatalogScope::Tenant {
            return Err(StoreError::Invalid(
                "tenant entries must have scope tenant".into(),
            ));
        }
        self.conn.execute(
            "INSERT INTO tenant_catalog_entries (id, body, revoked_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               body = excluded.body,
               revoked_at = excluded.revoked_at,
               updated_at = excluded.updated_at",
            params![
                entry.id,
                to_json(entry)?,
                entry.revoked_at,
                entry.created_at,
                entry.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn get_tenant_entry(&self, id: &str) -> Result<Option<CatalogEntry>, StoreError> {
        self.conn
            .query_row(
                "SELECT body FROM tenant_catalog_entries WHERE id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|body| from_json(&body))
            .transpose()
    }

    /// Every tenant entry, revoked ones included, oldest first.
    pub fn list_tenant_entries(&self) -> Result<Vec<CatalogEntry>, StoreError> {
        let mut statement = self
            .conn
            .prepare("SELECT body FROM tenant_catalog_entries ORDER BY created_at, id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|body| from_json(&body?)).collect()
    }

    pub fn revoke_tenant_entry(&self, id: &str, now: i64) -> Result<CatalogEntry, StoreError> {
        let Some(mut entry) = self.get_tenant_entry(id)? else {
            return Err(StoreError::NotFound {
                kind: "catalog entry",
                id: id.to_string(),
            });
        };
        if entry.revoked_at.is_none() {
            entry.revoked_at = Some(now);
            entry.updated_at = now;
            self.upsert_tenant_entry(&entry)?;
        }
        Ok(entry)
    }

    // ── tenant policy ─────────────────────────────────────────────────────

    pub fn tenant_policy(&self) -> Result<TenantPolicy, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT body FROM tenant_policy WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|body| from_json(&body))
            .transpose()?
            .unwrap_or_default())
    }

    pub fn set_tenant_policy(&self, policy: &TenantPolicy) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO tenant_policy (singleton, body, updated_at) VALUES (1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
            params![to_json(policy)?, policy.updated_at],
        )?;
        Ok(())
    }

    // ── approvals ─────────────────────────────────────────────────────────

    /// Record an approval. An earlier active approval of the same declaration
    /// location is revoked in the same transaction: one location has at most
    /// one active approval, so "which approval admits this" is never ambiguous.
    pub fn record_approval(&mut self, approval: &ApprovalRecord) -> Result<(), StoreError> {
        if !approval.is_active() {
            return Err(StoreError::Invalid(
                "a new approval cannot already be revoked".into(),
            ));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let superseded: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT body FROM environment_approvals
                 WHERE project_id = ?1 AND normalized_remote = ?2 AND path = ?3 AND revoked_at IS NULL",
            )?;
            let rows = statement.query_map(
                params![
                    approval.project_id,
                    approval.normalized_remote,
                    approval.path
                ],
                |row| row.get::<_, String>(0),
            )?;
            rows.collect::<Result<_, _>>()?
        };
        for body in superseded {
            let mut previous: ApprovalRecord = from_json(&body)?;
            previous.revoked_at = Some(approval.approved_at);
            previous.revoked_by = Some(approval.approver_user_id.clone());
            tx.execute(
                "UPDATE environment_approvals SET body = ?1, revoked_at = ?2 WHERE id = ?3",
                params![to_json(&previous)?, previous.revoked_at, previous.id],
            )?;
        }
        tx.execute(
            "INSERT INTO environment_approvals
               (id, project_id, normalized_remote, path, declaration_digest, body, approved_at, revoked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
            params![
                approval.id,
                approval.project_id,
                approval.normalized_remote,
                approval.path,
                approval.declaration_digest,
                to_json(approval)?,
                approval.approved_at
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_approval(&self, id: &str) -> Result<Option<ApprovalRecord>, StoreError> {
        self.conn
            .query_row(
                "SELECT body FROM environment_approvals WHERE id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|body| from_json(&body))
            .transpose()
    }

    pub fn active_approval(
        &self,
        project_id: &str,
        normalized_remote: &str,
        path: &str,
    ) -> Result<Option<ApprovalRecord>, StoreError> {
        self.conn
            .query_row(
                "SELECT body FROM environment_approvals
                 WHERE project_id = ?1 AND normalized_remote = ?2 AND path = ?3 AND revoked_at IS NULL",
                params![project_id, normalized_remote, path],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|body| from_json(&body))
            .transpose()
    }

    /// Approvals for one project (or all), newest first.
    pub fn list_approvals(
        &self,
        project_id: Option<&str>,
    ) -> Result<Vec<ApprovalRecord>, StoreError> {
        let mut statement = self.conn.prepare(
            "SELECT body FROM environment_approvals
             WHERE (?1 IS NULL OR project_id = ?1)
             ORDER BY approved_at DESC, id",
        )?;
        let rows = statement.query_map([project_id], |row| row.get::<_, String>(0))?;
        rows.map(|body| from_json(&body?)).collect()
    }

    pub fn revoke_approval(
        &self,
        id: &str,
        by: &str,
        now: i64,
    ) -> Result<ApprovalRecord, StoreError> {
        let Some(mut approval) = self.get_approval(id)? else {
            return Err(StoreError::NotFound {
                kind: "approval",
                id: id.to_string(),
            });
        };
        if approval.revoked_at.is_none() {
            approval.revoked_at = Some(now);
            approval.revoked_by = Some(by.to_string());
            self.conn.execute(
                "UPDATE environment_approvals SET body = ?1, revoked_at = ?2 WHERE id = ?3",
                params![to_json(&approval)?, now, id],
            )?;
        }
        Ok(approval)
    }

    // ── egress grants ─────────────────────────────────────────────────────

    /// Record a grant, revoking the project's previous active one.
    pub fn record_egress_grant(&mut self, grant: &EgressGrant) -> Result<(), StoreError> {
        if !grant.is_active() {
            return Err(StoreError::Invalid(
                "a new grant cannot already be revoked".into(),
            ));
        }
        for (index, domain) in grant.domains.iter().enumerate() {
            if !crate::spec::is_valid_domain_pattern(domain) {
                return Err(StoreError::Invalid(format!(
                    "domains[{index}] {domain:?} is not a domain or *.domain pattern"
                )));
            }
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT body FROM egress_grants WHERE project_id = ?1 AND revoked_at IS NULL",
            )?;
            let rows = statement.query_map([&grant.project_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for body in previous {
            let mut old: EgressGrant = from_json(&body)?;
            old.revoked_at = Some(grant.granted_at);
            tx.execute(
                "UPDATE egress_grants SET body = ?1, revoked_at = ?2 WHERE id = ?3",
                params![to_json(&old)?, old.revoked_at, old.id],
            )?;
        }
        tx.execute(
            "INSERT INTO egress_grants (id, project_id, body, granted_at, revoked_at)
             VALUES (?1, ?2, ?3, ?4, NULL)",
            params![
                grant.id,
                grant.project_id,
                to_json(grant)?,
                grant.granted_at
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn active_egress_grant(&self, project_id: &str) -> Result<Option<EgressGrant>, StoreError> {
        self.conn
            .query_row(
                "SELECT body FROM egress_grants WHERE project_id = ?1 AND revoked_at IS NULL",
                [project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|body| from_json(&body))
            .transpose()
    }

    pub fn revoke_egress_grant(&self, id: &str, now: i64) -> Result<EgressGrant, StoreError> {
        let body: Option<String> = self
            .conn
            .query_row(
                "SELECT body FROM egress_grants WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(body) = body else {
            return Err(StoreError::NotFound {
                kind: "egress grant",
                id: id.to_string(),
            });
        };
        let mut grant: EgressGrant = from_json(&body)?;
        if grant.revoked_at.is_none() {
            grant.revoked_at = Some(now);
            self.conn.execute(
                "UPDATE egress_grants SET body = ?1, revoked_at = ?2 WHERE id = ?3",
                params![to_json(&grant)?, now, id],
            )?;
        }
        Ok(grant)
    }

    // ── admitted specs ────────────────────────────────────────────────────

    /// Record a spec admission. The first body stored for a digest is kept:
    /// a digest names content, so a later admission can differ only in the
    /// `explain` trace the digest excludes, and only the time moves.
    pub fn record_admitted_spec(&self, spec: &EnvironmentSpec, now: i64) -> Result<(), StoreError> {
        spec.validate_with_digest()
            .map_err(|error| StoreError::Invalid(error.to_string()))?;
        self.conn.execute(
            "INSERT INTO admitted_specs
                 (spec_digest, project_id, body, first_admitted_at, last_admitted_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(spec_digest) DO UPDATE SET last_admitted_at = excluded.last_admitted_at",
            params![spec.spec_digest, spec.project_id, to_json(spec)?, now],
        )?;
        Ok(())
    }

    pub fn get_admitted_spec(&self, spec_digest: &str) -> Result<Option<AdmittedSpec>, StoreError> {
        self.conn
            .query_row(
                "SELECT body, first_admitted_at, last_admitted_at
                 FROM admitted_specs WHERE spec_digest = ?1",
                [spec_digest],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?
            .map(|(body, first, last)| {
                Ok(AdmittedSpec {
                    spec: from_json(&body)?,
                    first_admitted_at: first,
                    last_admitted_at: last,
                })
            })
            .transpose()
    }

    // ── probe cache ───────────────────────────────────────────────────────

    /// Cache a probe report for (user image, bundle). The report is opaque
    /// here; `cognia-sandboxd` owns its schema.
    pub fn put_probe(
        &self,
        user_image_digest: &str,
        bundle_digest: &str,
        report: &serde_json::Value,
        now: i64,
    ) -> Result<(), StoreError> {
        for digest in [user_image_digest, bundle_digest] {
            crate::image::validate_digest(digest)
                .map_err(|error| StoreError::Invalid(error.to_string()))?;
        }
        self.conn.execute(
            "INSERT INTO probe_cache (user_image_digest, bundle_digest, report, recorded_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_image_digest, bundle_digest) DO UPDATE SET
               report = excluded.report, recorded_at = excluded.recorded_at",
            params![
                user_image_digest,
                bundle_digest,
                serde_json::to_string(report)?,
                now
            ],
        )?;
        Ok(())
    }

    pub fn get_probe(
        &self,
        user_image_digest: &str,
        bundle_digest: &str,
    ) -> Result<Option<serde_json::Value>, StoreError> {
        self.conn
            .query_row(
                "SELECT report FROM probe_cache WHERE user_image_digest = ?1 AND bundle_digest = ?2",
                [user_image_digest, bundle_digest],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|report| from_json(&report))
            .transpose()
    }
}

fn to_json<T: Serialize>(value: &T) -> Result<String, StoreError> {
    Ok(serde_json::to_string(value)?)
}

fn from_json<T: DeserializeOwned>(body: &str) -> Result<T, StoreError> {
    Ok(serde_json::from_str(body)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalAuthority;
    use crate::catalog::tests::entry;
    use crate::spec::tests::{BUNDLE_DIGEST, IMAGE_DIGEST};
    use crate::spec::{EgressTier, IsolationTier};

    fn approval(id: &str, at: i64) -> ApprovalRecord {
        ApprovalRecord {
            id: id.into(),
            project_id: "proj-1".into(),
            normalized_remote: "https://github.com/acme/app".into(),
            path: ".devcontainer/devcontainer.json".into(),
            declaration_digest: "d".repeat(64),
            resolved_image: None,
            build_key: Some("b".repeat(64)),
            runtime_fields_digest: "r".repeat(64),
            approver_user_id: "maintainer-1".into(),
            via: ApprovalAuthority::WorkspaceMaintainer,
            approved_at: at,
            revoked_at: None,
            revoked_by: None,
        }
    }

    #[test]
    fn tenant_entries_round_trip_and_are_revoked_not_deleted() {
        let store = EnvironmentStore::open_in_memory().unwrap();
        let node = entry("node-22", CatalogScope::Tenant, "ghcr.io", "acme/node");
        store.upsert_tenant_entry(&node).unwrap();
        assert_eq!(
            store.get_tenant_entry("node-22").unwrap(),
            Some(node.clone())
        );

        let revoked = store.revoke_tenant_entry("node-22", 50).unwrap();
        assert_eq!(revoked.revoked_at, Some(50));
        let listed = store.list_tenant_entries().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].revoked_at, Some(50));
        assert!(matches!(
            store.revoke_tenant_entry("missing", 1),
            Err(StoreError::NotFound { .. })
        ));
    }

    #[test]
    fn invalid_or_baseline_scoped_entries_are_refused() {
        let store = EnvironmentStore::open_in_memory().unwrap();
        let baseline_scoped = entry("x", CatalogScope::Baseline, "ghcr.io", "acme/x");
        assert!(matches!(
            store.upsert_tenant_entry(&baseline_scoped),
            Err(StoreError::Invalid(_))
        ));
        let mut unpinned = entry("y", CatalogScope::Tenant, "ghcr.io", "acme/y");
        unpinned.image.digest = None;
        assert!(matches!(
            store.upsert_tenant_entry(&unpinned),
            Err(StoreError::Invalid(_))
        ));
    }

    #[test]
    fn tenant_policy_defaults_until_set() {
        let store = EnvironmentStore::open_in_memory().unwrap();
        assert_eq!(store.tenant_policy().unwrap(), TenantPolicy::default());
        let policy = TenantPolicy {
            isolation_floor: IsolationTier::Vm,
            default_entry_id: Some("node-22".into()),
            updated_at: 7,
        };
        store.set_tenant_policy(&policy).unwrap();
        assert_eq!(store.tenant_policy().unwrap(), policy);
    }

    #[test]
    fn a_new_approval_supersedes_the_active_one_for_the_same_location() {
        let mut store = EnvironmentStore::open_in_memory().unwrap();
        store.record_approval(&approval("a1", 10)).unwrap();
        store.record_approval(&approval("a2", 20)).unwrap();

        let active = store
            .active_approval(
                "proj-1",
                "https://github.com/acme/app",
                ".devcontainer/devcontainer.json",
            )
            .unwrap()
            .unwrap();
        assert_eq!(active.id, "a2");
        let first = store.get_approval("a1").unwrap().unwrap();
        assert_eq!(first.revoked_at, Some(20));
        assert_eq!(first.revoked_by.as_deref(), Some("maintainer-1"));
        assert_eq!(store.list_approvals(Some("proj-1")).unwrap().len(), 2);
        assert!(store.list_approvals(Some("other")).unwrap().is_empty());
        assert_eq!(store.list_approvals(None).unwrap()[0].id, "a2");

        let revoked = store.revoke_approval("a2", "admin-1", 30).unwrap();
        assert_eq!(revoked.revoked_by.as_deref(), Some("admin-1"));
        assert!(store
            .active_approval(
                "proj-1",
                "https://github.com/acme/app",
                ".devcontainer/devcontainer.json"
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn egress_grants_supersede_and_validate_domains() {
        let mut store = EnvironmentStore::open_in_memory().unwrap();
        let grant = |id: &str, at: i64, domains: &[&str]| EgressGrant {
            id: id.into(),
            project_id: "proj-1".into(),
            tier: EgressTier::Allowlist,
            domains: domains.iter().map(|d| d.to_string()).collect(),
            granted_by: "admin-1".into(),
            granted_at: at,
            revoked_at: None,
        };
        store
            .record_egress_grant(&grant("g1", 1, &["pypi.org"]))
            .unwrap();
        store
            .record_egress_grant(&grant("g2", 2, &["*.npmjs.org"]))
            .unwrap();
        assert_eq!(
            store.active_egress_grant("proj-1").unwrap().unwrap().id,
            "g2"
        );
        assert!(matches!(
            store.record_egress_grant(&grant("g3", 3, &["10.0.0.1"])),
            Err(StoreError::Invalid(_))
        ));
        store.revoke_egress_grant("g2", 9).unwrap();
        assert!(store.active_egress_grant("proj-1").unwrap().is_none());
    }

    #[test]
    fn probe_reports_cache_by_image_and_bundle() {
        let store = EnvironmentStore::open_in_memory().unwrap();
        let report = serde_json::json!({ "schemaVersion": 1, "libc": { "kind": "musl" } });
        store
            .put_probe(IMAGE_DIGEST, BUNDLE_DIGEST, &report, 1)
            .unwrap();
        assert_eq!(
            store.get_probe(IMAGE_DIGEST, BUNDLE_DIGEST).unwrap(),
            Some(report)
        );
        assert!(store
            .get_probe(BUNDLE_DIGEST, IMAGE_DIGEST)
            .unwrap()
            .is_none());
        assert!(matches!(
            store.put_probe("sha256:bad", BUNDLE_DIGEST, &serde_json::json!({}), 1),
            Err(StoreError::Invalid(_))
        ));
    }

    #[test]
    fn a_file_store_reopens_with_its_data_and_refuses_a_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("environment.sqlite");
        {
            let store = EnvironmentStore::open(&path).unwrap();
            store
                .upsert_tenant_entry(&entry(
                    "node-22",
                    CatalogScope::Tenant,
                    "ghcr.io",
                    "acme/node",
                ))
                .unwrap();
        }
        let store = EnvironmentStore::open(&path).unwrap();
        assert!(store.get_tenant_entry("node-22").unwrap().is_some());
        drop(store);

        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);
        assert!(matches!(
            EnvironmentStore::open(&path),
            Err(StoreError::SchemaTooNew { .. })
        ));
    }

    #[test]
    fn admitted_specs_keep_their_first_body_and_refuse_a_tampered_one() {
        use crate::spec::tests::sample_spec;
        let store = EnvironmentStore::open_in_memory().unwrap();
        let spec = sample_spec();
        store.record_admitted_spec(&spec, 10).unwrap();

        let mut retraced = spec.clone();
        retraced.explain = Some(serde_json::json!({ "steps": ["again"] }));
        store.record_admitted_spec(&retraced, 20).unwrap();

        let admitted = store.get_admitted_spec(&spec.spec_digest).unwrap().unwrap();
        assert_eq!(admitted.spec, spec);
        assert_eq!(
            (admitted.first_admitted_at, admitted.last_admitted_at),
            (10, 20)
        );
        assert!(store.get_admitted_spec(&"0".repeat(64)).unwrap().is_none());

        let mut tampered = spec.clone();
        tampered.size_class_id = "large".into();
        assert!(matches!(
            store.record_admitted_spec(&tampered, 30),
            Err(StoreError::Invalid(message)) if message.contains("spec_digest_mismatch")
        ));
    }

    #[test]
    fn a_version_one_store_gains_the_admitted_specs_table_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("environment.sqlite");
        {
            let mut conn = Connection::open(&path).unwrap();
            let tx = conn.transaction().unwrap();
            tx.execute_batch(MIGRATIONS[0]).unwrap();
            tx.pragma_update(None, "user_version", 1).unwrap();
            tx.commit().unwrap();
            conn.execute(
                "INSERT INTO tenant_policy (singleton, body, updated_at) VALUES (1, ?1, 5)",
                [serde_json::to_string(&TenantPolicy::default()).unwrap()],
            )
            .unwrap();
        }
        let store = EnvironmentStore::open(&path).unwrap();
        assert_eq!(store.tenant_policy().unwrap(), TenantPolicy::default());
        store
            .record_admitted_spec(&crate::spec::tests::sample_spec(), 1)
            .unwrap();
        let version: i32 = store
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }
}
