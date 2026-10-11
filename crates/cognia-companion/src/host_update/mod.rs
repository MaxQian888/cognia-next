//! An always-on host updating itself (ADR-0224 A10).
//!
//! The host follows its owner's release channel, checks the signed catalog,
//! waits until nothing would be cut off, swaps its server and brain together,
//! and proves the new version or rolls back. See [`updater`] for the flow and
//! `cognia_host_service::install_home` for the on-disk swap. The management
//! channel reaches it through the `host_update_*` host-admin commands.

pub mod idle;
pub mod settings;
pub mod updater;
/// The update Worker client, shared with a Compose host's deploy agent.
pub use cognia_update_catalog::client as network;

use std::sync::Arc;

use once_cell::sync::OnceCell;
use serde_json::Value;

pub use updater::{
    ComposeAgent, DetectInput, HostInstall, HostUpdateStatus, HostUpdater, HostUpdaterDeps,
    InstallKind, SocketAgent, UnmanagedReason, UpdateAgent, UpdatePhase,
};

pub use network::{trust_root, TRUST_ROOT_ENV, UPDATE_URL_ENV};
/// Set in the service definition: the OS service started this process.
pub const SERVICE_MANAGED_ENV: &str = "COGNIA_SERVICE_MANAGED";
/// Set by the server image: `oci-<variant>-<arch>`.
pub const HOST_TARGET_ENV: &str = "COGNIA_HOST_TARGET";
/// Set by the Compose overlay: where this host's deploy agent listens.
pub use cognia_host_service::update_agent::SOCKET_ENV as UPDATE_AGENT_SOCKET_ENV;

static UPDATER: OnceCell<Arc<HostUpdater>> = OnceCell::new();

/// Make `updater` the one the host-admin commands reach. First one wins.
pub fn install(updater: Arc<HostUpdater>) {
    let _ = UPDATER.set(updater);
}

pub fn installed() -> Option<Arc<HostUpdater>> {
    UPDATER.get().cloned()
}

/// [`status_value`] after asking a Compose host's deploy agent where it is.
pub async fn status_value_live(desktop_version: &str) -> Value {
    if let Some(updater) = installed() {
        updater.refresh_agent().await;
    }
    status_value(desktop_version)
}

/// `host_update_status` for this process: the updater's, or, where none runs
/// (the desktop app), why this host does not update itself.
pub fn status_value(desktop_version: &str) -> Value {
    match installed() {
        Some(updater) => serde_json::to_value(updater.status()).unwrap_or_default(),
        None => serde_json::json!({
            "install": "unmanaged",
            "unmanagedReason": UnmanagedReason::DesktopApp,
            "currentVersion": desktop_version,
            "channel": "stable",
            "autoUpdate": false,
            "phase": UpdatePhase::Idle,
            "installRequested": false,
        }),
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn the_desktop_app_reports_that_it_updates_elsewhere() {
        // No updater is installed in the desktop app (nor in this test process).
        for status in [
            super::status_value("0.9.0"),
            super::status_value_live("0.9.0").await,
        ] {
            assert_eq!(status["install"], "unmanaged");
            assert_eq!(status["unmanagedReason"], "desktop-app");
            assert_eq!(status["currentVersion"], "0.9.0");
        }
    }
}
