//! External Agent Module
//!
//! Provides Tauri commands for managing external agent processes.
//! Supports spawning, communication, and lifecycle management of
//! external agents via stdio transport.

pub mod command_resolver;
#[cfg(feature = "tauri-host")]
pub mod commands;
pub mod container_backend;
pub mod devin_mcp_config;
pub mod dsh_runtime;
pub mod exec_backend;
pub mod gateway_task;
pub mod kube_backend;
pub mod presets;
pub mod person_workspace;
pub mod proc_group;
pub mod process;
pub mod sandbox;
pub mod sandbox_routing_backend;
pub mod spawn_authority;
pub mod state_isolation;
pub mod terminal;
pub mod version_probe;
pub mod workspace_runtime_backend;

/// Env-mutating tests across this crate's modules serialize on one lock.
/// (In app_lib they shared companion_api::ws_bridge's global test lock; as an
/// extracted crate this test binary is its own process, so a crate-local lock
/// gives the same guarantee.) tokio's `Mutex` because guards are held across
/// await points for whole test bodies.
#[cfg(test)]
pub(crate) mod test_env_lock {
    static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    pub(crate) async fn env_lock() -> tokio::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().await
    }
}

#[cfg(test)]
pub(crate) fn workspace_env_fixture(kind: &str) -> tempfile::TempDir {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        cognia_core::workspace_env::set_workspace_env_provider(std::sync::Arc::new(|query| {
            let path = query.cwd.to_string_lossy();
            if path.contains("cognia-real-port-fixture-") {
                return cognia_task_workspace_host::workspace_env::resolve_workspace_env(query);
            }
            if path.contains("cognia-port-fixture-error-") {
                return Err("fixture port range exhausted".into());
            }
            if !path.contains("cognia-port-fixture-some-") {
                return Ok(None);
            }
            assert_eq!(
                query.namespace,
                cognia_core::workspace_env::HOST_LOOPBACK_NAMESPACE
            );
            let base = "41000";
            Ok(Some(std::collections::BTreeMap::from([
                ("PORT".into(), base.into()),
                ("COGNIA_PORT".into(), base.into()),
                ("COGNIA_PORT_COUNT".into(), "10".into()),
            ])))
        }))
        .expect("install fixture provider once");
    });
    tempfile::Builder::new()
        .prefix(&format!("cognia-port-fixture-{kind}-"))
        .tempdir()
        .unwrap()
}

#[cfg(test)]
pub(crate) fn real_workspace_env_fixture(
    kind: &str,
) -> (
    tempfile::TempDir,
    std::collections::BTreeMap<String, String>,
) {
    static STORE: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    STORE.get_or_init(|| {
        let store = tempfile::tempdir().unwrap();
        cognia_task_workspace_host::host_surface::install(store.path().to_path_buf()).unwrap();
        store
    });
    let _ = workspace_env_fixture("none");
    let root = tempfile::Builder::new()
        .prefix("cognia-real-port-fixture-")
        .tempdir()
        .unwrap();
    // Match the frontend subject registration API, including the host probe.
    cognia_task_workspace_host::host_surface::task_workspace_port_lease_subject_ensure(
        serde_json::from_value(serde_json::json!(kind)).unwrap(),
        root.path().to_string_lossy().into_owned(),
        root.path().to_string_lossy().into_owned(),
        None,
    )
    .unwrap();
    let env = cognia_task_workspace_host::workspace_env::resolve_workspace_env(
        cognia_core::workspace_env::WorkspaceEnvQuery {
            cwd: root.path().to_path_buf(),
            workspace_id: None,
            namespace: cognia_core::workspace_env::HOST_LOOPBACK_NAMESPACE.into(),
        },
    )
    .unwrap()
    .unwrap();
    (root, env)
}
