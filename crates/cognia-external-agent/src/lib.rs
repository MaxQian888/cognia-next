//! External Agent Module
//!
//! Provides Tauri commands for managing external agent processes.
//! Supports spawning, communication, and lifecycle management of
//! external agents via stdio transport.

pub mod command_resolver;
pub mod commands;
pub mod dsh_runtime;
pub mod container_backend;
pub mod exec_backend;
pub mod kube_backend;
pub mod presets;
pub mod proc_group;
pub mod process;
pub mod sandbox;
pub mod terminal;
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
