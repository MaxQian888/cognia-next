//! The desktop and headless execution hosts share one lease authority.
//! The desktop-host PTY subprocess deliberately never installs this provider.

use cognia_core::workspace_env::{
    set_workspace_env_provider, WorkspaceEnv, WorkspaceEnvProvider, WorkspaceEnvQuery,
    HOST_LOOPBACK_NAMESPACE,
};
use cognia_task_workspace::{port_lease_env, TaskWorkspaceService};
use std::sync::{Arc, OnceLock};

/// Install even if service initialization failed: execution must surface that
/// failure rather than silently running without the configured lease authority.
pub fn install_workspace_env_provider() -> Result<(), String> {
    static PROVIDER: OnceLock<WorkspaceEnvProvider> = OnceLock::new();
    set_workspace_env_provider(
        PROVIDER
            .get_or_init(|| Arc::new(resolve_workspace_env))
            .clone(),
    )
}

/// The same authority is used by installed providers and native integrations.
/// Runtime placement never selects a different ledger or allocates a new block.
pub fn resolve_workspace_env(query: WorkspaceEnvQuery) -> Result<Option<WorkspaceEnv>, String> {
    let service = crate::host_surface::service()?;
    resolve_with_service(&service, query)
}

fn resolve_with_service(
    service: &TaskWorkspaceService,
    query: WorkspaceEnvQuery,
) -> Result<Option<WorkspaceEnv>, String> {
    // Execution lazily allocates registry and discovered Git checkout subjects;
    // desktop scratch folders still need their frontend-owned identity.
    service
        .resolve_workspace_port_lease(
            HOST_LOOPBACK_NAMESPACE,
            query.workspace_id.as_deref(),
            &query.cwd,
            true,
        )
        .map(|lease| lease.as_ref().map(port_lease_env))
        .map_err(|error| format!("workspace port environment: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_core::workspace_env::WORKSPACE_ENV_KEYS;
    use cognia_task_workspace::{PortSubjectKind, ServiceConfig};
    use tempfile::TempDir;

    #[test]
    fn fresh_checkout_provider_allocates_without_frontend_registration() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        assert!(std::process::Command::new("git")
            .arg("init")
            .arg(root.path())
            .output()
            .unwrap()
            .status
            .success());
        let nested = root.path().join("src");
        std::fs::create_dir(&nested).unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert!(service
            .resolve_workspace_port_lease(HOST_LOOPBACK_NAMESPACE, None, &nested, false)
            .unwrap()
            .is_none());
        let env = resolve_with_service(
            &service,
            WorkspaceEnvQuery {
                cwd: nested,
                workspace_id: None,
                namespace: HOST_LOOPBACK_NAMESPACE.into(),
            },
        )
        .unwrap()
        .unwrap();
        let lease = service
            .resolve_workspace_port_lease(HOST_LOOPBACK_NAMESPACE, None, root.path(), false)
            .unwrap()
            .unwrap();
        assert_eq!(env, port_lease_env(&lease));
        assert_eq!(
            lease.subject_key,
            format!(
                "root:{}",
                std::fs::canonicalize(root.path()).unwrap().display()
            )
        );
    }

    #[tokio::test]
    async fn fresh_checkout_sidecar_rpc_allocates_through_host_provider() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        assert!(std::process::Command::new("git")
            .arg("init")
            .arg(root.path())
            .output()
            .unwrap()
            .status
            .success());
        let nested = root.path().join("src");
        std::fs::create_dir(&nested).unwrap();
        let service =
            Arc::new(TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap());
        assert!(service
            .resolve_workspace_port_lease(HOST_LOOPBACK_NAMESPACE, None, &nested, false)
            .unwrap()
            .is_none());
        let provider_service = Arc::clone(&service);
        let provider_cwd = nested.clone();
        // The sole provider installation in this test binary is path-scoped,
        // leaving the other host tests independent of this service instance.
        set_workspace_env_provider(Arc::new(move |query| {
            if query.cwd != provider_cwd {
                return Ok(None);
            }
            resolve_with_service(&provider_service, query)
        }))
        .unwrap();
        let env = cognia_companion_rpc::sidecar_runtime::dispatch_runtime_rpc(
            "workspace.portEnv",
            &serde_json::json!({ "cwd": nested }),
        )
        .await
        .unwrap();
        let lease = service
            .resolve_workspace_port_lease(HOST_LOOPBACK_NAMESPACE, None, root.path(), false)
            .unwrap()
            .unwrap();
        assert_eq!(env, serde_json::to_value(port_lease_env(&lease)).unwrap());
        assert_eq!(lease.subject_kind, PortSubjectKind::ProjectRoot);
        assert_eq!(lease.subject_key, format!("root:{}", lease.canonical_root));
    }

    #[test]
    fn registry_host_and_container_share_one_lazy_host_lease() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        service
            .set_workspace_lifecycle_policy(cognia_task_workspace::WorkspaceLifecyclePolicy {
                port_range_start: 41000,
                port_range_end: 41009,
                port_block_size: 10,
                ..Default::default()
            })
            .unwrap();
        // Model old registry rows without leases. Lazy allocation must still
        // probe the host, even when the first execution is inside a container.
        let db =
            rusqlite::Connection::open(data.path().join("task-workspaces/task-workspaces.sqlite"))
                .unwrap();
        for (id, root) in [("first", root.path()), ("second", other.path())] {
            db.execute("INSERT INTO workspace_registry (workspace_id,environment_kind,owner_type,state,source_root,base_kind,isolation_kind,execution_root,last_used_at,created_at) VALUES (?1,'imported','imported','active',?2,'localHead','gitWorktree',?2,0,0)", rusqlite::params![id, root.to_string_lossy()]).unwrap();
        }
        let query = WorkspaceEnvQuery {
            cwd: root.path().into(),
            workspace_id: None,
            namespace: "runtime:legacy-container".into(),
        };
        assert!(service
            .read_workspace_port_lease("first", HOST_LOOPBACK_NAMESPACE)
            .unwrap()
            .is_none());
        let env = resolve_with_service(&service, query.clone())
            .unwrap()
            .unwrap();
        assert_eq!(env["PORT"], "41000");
        assert_eq!(env["COGNIA_PORT_COUNT"], "10");
        assert_eq!(
            resolve_with_service(
                &service,
                WorkspaceEnvQuery {
                    namespace: HOST_LOOPBACK_NAMESPACE.into(),
                    workspace_id: Some("first".into()),
                    ..query.clone()
                }
            )
            .unwrap(),
            Some(env.clone())
        );
        let lease = service
            .read_workspace_port_lease("first", HOST_LOOPBACK_NAMESPACE)
            .unwrap()
            .unwrap();
        assert_eq!(env, port_lease_env(&lease));
        assert!(service
            .read_workspace_port_lease("first", &query.namespace)
            .unwrap()
            .is_none());
        let count: i64 = db
            .query_row("SELECT count(*) FROM workspace_port_leases", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1, "placements must not allocate separate blocks");
        let error = resolve_with_service(
            &service,
            WorkspaceEnvQuery {
                cwd: other.path().into(),
                ..query.clone()
            },
        )
        .unwrap_err();
        assert!(error.contains("portRangeStart"), "{error}");
        db.execute("DROP TABLE workspace_registry", []).unwrap();
        assert!(resolve_with_service(&service, query)
            .unwrap_err()
            .contains("store"));
    }

    #[test]
    fn foundation_contract_matches_the_lease_authority() {
        assert_eq!(
            HOST_LOOPBACK_NAMESPACE,
            cognia_task_workspace::HOST_LOOPBACK_NAMESPACE
        );
        let lease = cognia_task_workspace::WorkspacePortLease {
            lease_id: "contract".into(),
            namespace_key: HOST_LOOPBACK_NAMESPACE.into(),
            subject_kind: PortSubjectKind::ProjectRoot,
            subject_key: "project".into(),
            canonical_root: "/workspace".into(),
            registry_workspace_id: None,
            base_port: 41000,
            port_count: 10,
            created_at: 0,
            updated_at: 0,
        };
        let env = port_lease_env(&lease);
        assert_eq!(env.len(), WORKSPACE_ENV_KEYS.len());
        for key in WORKSPACE_ENV_KEYS {
            assert!(env.contains_key(key), "missing {key}");
        }
        assert_eq!(env["PORT"], env["COGNIA_PORT"]);
    }

    #[test]
    fn frontend_subjects_use_the_host_lease_for_every_runtime_placement() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let nested = root.path().join("src");
        std::fs::create_dir(&nested).unwrap();
        let query = WorkspaceEnvQuery {
            cwd: nested,
            workspace_id: None,
            namespace: HOST_LOOPBACK_NAMESPACE.into(),
        };
        assert_eq!(resolve_with_service(&service, query.clone()).unwrap(), None);
        for kind in [
            PortSubjectKind::ProjectRoot,
            PortSubjectKind::DesktopSession,
        ] {
            let lease = service
                .ensure_subject_port_lease(&query.namespace, kind, "subject", root.path())
                .unwrap();
            assert_eq!(
                resolve_with_service(&service, query.clone()).unwrap(),
                Some(port_lease_env(&lease))
            );
            for placement in ["container", "kubernetes", "e2b", "workspace-runtime"] {
                assert_eq!(
                    resolve_with_service(
                        &service,
                        WorkspaceEnvQuery {
                            namespace: format!("runtime:{placement}"),
                            ..query.clone()
                        }
                    )
                    .unwrap(),
                    Some(port_lease_env(&lease))
                );
            }
            service
                .release_subject_port_leases(&query.namespace, kind, "subject")
                .unwrap();
        }
        let error = resolve_with_service(
            &service,
            WorkspaceEnvQuery {
                workspace_id: Some("missing-registry-id".into()),
                ..query
            },
        )
        .unwrap_err();
        assert!(error.contains("workspace port environment"));
        assert!(error.contains("missing-registry-id"));
    }

    #[test]
    fn unmatched_subject_and_store_failure_are_distinct() {
        let data = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let query = WorkspaceEnvQuery {
            cwd: root.path().into(),
            workspace_id: None,
            namespace: HOST_LOOPBACK_NAMESPACE.into(),
        };
        assert_eq!(resolve_with_service(&service, query.clone()).unwrap(), None);
        let db =
            rusqlite::Connection::open(data.path().join("task-workspaces/task-workspaces.sqlite"))
                .unwrap();
        db.execute("DROP TABLE workspace_registry", []).unwrap();
        assert!(resolve_with_service(&service, query)
            .unwrap_err()
            .contains("store"));
    }
}
