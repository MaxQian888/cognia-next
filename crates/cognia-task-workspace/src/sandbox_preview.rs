//! Host-owned preview capabilities. Only keyed hashes enter the durable ledger.
//! Kept separate from snapshots because grants have independent CAS revisions
//! and bootstrap/session lifetimes; both use task-workspaces.sqlite.
use crate::{TaskWorkspaceService, WorkspacePortLease};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PreviewAudience {
    LocalOwner,
    /// Inert in phase 1b. The Host refuses this variant until phase 2.
    PairedDevice {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PreviewPort {
    Fixed { port: u16 },
    WorkspaceLeaseOffset { offset: u16 },
}
impl PreviewPort {
    pub fn resolve(&self, lease: Option<&WorkspacePortLease>) -> Result<u16, String> {
        match self {
            Self::Fixed { port } if *port != 0 => Ok(*port),
            Self::WorkspaceLeaseOffset { offset } => {
                let lease = lease.ok_or("preview_port_lease_missing")?;
                if u32::from(*offset) >= lease.port_count {
                    return Err("preview_port_offset_invalid".into());
                }
                lease
                    .base_port
                    .checked_add(u32::from(*offset))
                    .and_then(|port| u16::try_from(port).ok())
                    .filter(|port| *port != 0)
                    .ok_or_else(|| "preview_port_offset_invalid".into())
            }
            _ => Err("preview_port_invalid".into()),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct PreviewGrantV1 {
    pub version: u32,
    pub id: String,
    pub project_id: String,
    pub workspace_id: String,
    pub provider: String,
    pub container_id: String,
    pub runtime_generation: String,
    pub port: PreviewPort,
    pub resolved_port: u16,
    pub port_lease: Option<WorkspacePortLease>,
    pub audience: PreviewAudience,
    pub created_at: i64,
    pub expires_at: i64,
    pub revision: u64,
    pub revoked: bool,
    pub origin: String,
}
/// Internal record: never serialized through a Host command response.
#[derive(Clone, Serialize, Deserialize)]
pub struct StoredPreviewGrant {
    pub grant: PreviewGrantV1,
    pub bootstrap_hash: Option<String>,
    pub bootstrap_expires_at: i64,
    pub session_hash: Option<String>,
}
pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS sandbox_preview_grants (
        id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS sandbox_preview_deployment ON sandbox_preview_grants(deployment_id);")
        .map_err(|e|e.to_string())
}
impl TaskWorkspaceService {
    pub fn store_preview_grant(
        &self,
        deployment: &str,
        record: &StoredPreviewGrant,
        previous: Option<u64>,
    ) -> Result<(), String> {
        let store = self.store.lock();
        let payload = serde_json::to_string(record).map_err(|e| e.to_string())?;
        let changed = match previous {
            Some(revision) => store.connection.execute("UPDATE sandbox_preview_grants SET revision=?1,payload=?2 WHERE deployment_id=?3 AND id=?4 AND revision=?5",params![record.grant.revision,payload,deployment,record.grant.id,revision]),
            None => store.connection.execute("INSERT INTO sandbox_preview_grants(id,deployment_id,revision,payload) VALUES (?1,?2,?3,?4)",params![record.grant.id,deployment,record.grant.revision,payload]),
        }.map_err(|e|e.to_string())?;
        if changed != 1 {
            return Err("preview_revision_conflict".into());
        }
        Ok(())
    }
    pub fn preview_grant(&self, deployment: &str, id: &str) -> Result<StoredPreviewGrant, String> {
        let payload: Option<String> = self
            .store
            .lock()
            .connection
            .query_row(
                "SELECT payload FROM sandbox_preview_grants WHERE deployment_id=?1 AND id=?2",
                params![deployment, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&payload.ok_or("preview_not_found")?).map_err(|e| e.to_string())
    }
    pub fn preview_grants(&self, deployment: &str) -> Result<Vec<StoredPreviewGrant>, String> {
        let store = self.store.lock();
        let mut query = store.connection.prepare("SELECT payload FROM sandbox_preview_grants WHERE deployment_id=?1 ORDER BY rowid DESC").map_err(|e|e.to_string())?;
        let rows = query
            .query_map([deployment], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> StoredPreviewGrant {
        StoredPreviewGrant {
            grant: PreviewGrantV1 {
                version: 1,
                id: "grant".into(),
                project_id: "project".into(),
                workspace_id: "workspace".into(),
                provider: "local".into(),
                container_id: "container".into(),
                runtime_generation: "2026-10-17T01:00:00Z".into(),
                port: PreviewPort::Fixed { port: 3000 },
                resolved_port: 3000,
                port_lease: None,
                audience: PreviewAudience::LocalOwner,
                created_at: 1000,
                expires_at: 901000,
                revision: 1,
                revoked: false,
                origin: "http://p-grant.localhost:42000".into(),
            },
            bootstrap_hash: Some("a".repeat(64)),
            bootstrap_expires_at: 61000,
            session_hash: None,
        }
    }

    #[test]
    fn preview_ledger_persists_revision_and_isolates_deployments() {
        let data = tempfile::TempDir::new().unwrap();
        let config = || crate::ServiceConfig::new(data.path().into());
        let service = TaskWorkspaceService::open(config()).unwrap();
        let mut record = record();
        service.store_preview_grant("owner", &record, None).unwrap();
        assert!(service.preview_grant("other", "grant").is_err());
        assert!(service.preview_grants("other").unwrap().is_empty());
        record.grant.revision = 2;
        record.grant.revoked = true;
        record.bootstrap_hash = None;
        assert!(service
            .store_preview_grant("other", &record, Some(1))
            .is_err());
        service
            .store_preview_grant("owner", &record, Some(1))
            .unwrap();
        let mut stale = record.clone();
        stale.grant.revoked = false;
        assert_eq!(
            service
                .store_preview_grant("owner", &stale, Some(1))
                .unwrap_err(),
            "preview_revision_conflict"
        );
        drop(service);
        let reopened = TaskWorkspaceService::open(config()).unwrap();
        let stored = reopened.preview_grant("owner", "grant").unwrap();
        assert_eq!(stored.grant.revision, 2);
        assert!(stored.grant.revoked);
        assert!(stored.bootstrap_hash.is_none());
        let metadata = serde_json::to_string(&stored.grant).unwrap();
        assert!(!metadata.contains("bootstrap_hash"));
        assert!(!metadata.contains("session_hash"));
    }

    #[test]
    fn preview_unknown_or_corrupted_records_fail_closed() {
        let data = tempfile::TempDir::new().unwrap();
        let service =
            TaskWorkspaceService::open(crate::ServiceConfig::new(data.path().into())).unwrap();
        assert!(service.preview_grant("owner", "missing").is_err());
        service
            .store_preview_grant("owner", &record(), None)
            .unwrap();
        service
            .store
            .lock()
            .connection
            .execute(
                "UPDATE sandbox_preview_grants SET payload='invalid' WHERE id='grant'",
                [],
            )
            .unwrap();
        assert!(service.preview_grant("owner", "grant").is_err());
        assert!(service.preview_grants("owner").is_err());
    }
    #[test]
    fn preview_lease_offsets_follow_the_target_fork_block() {
        let mut lease = WorkspacePortLease {
            lease_id: "source".into(),
            namespace_key: "host-loopback".into(),
            subject_kind: crate::PortSubjectKind::Registry,
            subject_key: "source".into(),
            canonical_root: "/source".into(),
            registry_workspace_id: Some("source".into()),
            base_port: 40000,
            port_count: 10,
            created_at: 0,
            updated_at: 0,
        };
        let port = PreviewPort::WorkspaceLeaseOffset { offset: 3 };
        assert_eq!(port.resolve(Some(&lease)).unwrap(), 40003);
        lease.lease_id = "fork".into();
        lease.base_port = 40010;
        assert_eq!(port.resolve(Some(&lease)).unwrap(), 40013);
        assert!(PreviewPort::WorkspaceLeaseOffset { offset: 10 }
            .resolve(Some(&lease))
            .is_err());
        assert!(port.resolve(None).is_err());
        assert!(PreviewPort::Fixed { port: 0 }.resolve(None).is_err());
    }
    #[test]
    fn preview_migration_is_idempotent() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        migrate(&connection).unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM sandbox_preview_grants", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
