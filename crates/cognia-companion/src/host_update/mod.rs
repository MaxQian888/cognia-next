//! An always-on host updating itself (ADR-0224 A10).
//!
//! The host follows its owner's release channel, checks the signed catalog,
//! waits until nothing would be cut off, swaps its server and brain together,
//! and proves the new version or rolls back. See [`updater`] for the flow and
//! `cognia_host_service::install_home` for the on-disk swap. The management
//! channel reaches it through the `host_update_*` host-admin commands.

pub mod idle;
pub mod network;
pub mod settings;
pub mod updater;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use once_cell::sync::OnceCell;
use serde_json::Value;

pub use updater::{
    DetectInput, HostInstall, HostUpdateStatus, HostUpdater, HostUpdaterDeps, InstallKind,
    UnmanagedReason, UpdatePhase,
};

/// Read at runtime first, so an operator can pin the root a build trusts.
pub const TRUST_ROOT_ENV: &str = "COGNIA_UPDATE_TRUST_ROOT";
/// The update Worker a host asks; defaults to [`network::DEFAULT_UPDATE_URL`].
pub const UPDATE_URL_ENV: &str = "COGNIA_UPDATE_URL";
/// Set in the service definition: the OS service started this process.
pub const SERVICE_MANAGED_ENV: &str = "COGNIA_SERVICE_MANAGED";
/// Set by the server image: `oci-<variant>-<arch>`.
pub const HOST_TARGET_ENV: &str = "COGNIA_HOST_TARGET";

/// The root this host trusts: `COGNIA_UPDATE_TRUST_ROOT` at runtime, else the
/// one compiled in from the same variable at build time. `None` turns
/// updates off (reported as such); nothing is installed on unverified
/// metadata.
pub fn trust_root() -> Option<cognia_update_catalog::RootPayload> {
    std::env::var(TRUST_ROOT_ENV)
        .ok()
        .and_then(|raw| cognia_update_catalog::parse_trust_root(&raw))
        .or_else(|| {
            option_env!("COGNIA_UPDATE_TRUST_ROOT")
                .and_then(cognia_update_catalog::parse_trust_root)
        })
}

static UPDATER: OnceCell<Arc<HostUpdater>> = OnceCell::new();

/// Make `updater` the one the host-admin commands reach. First one wins.
pub fn install(updater: Arc<HostUpdater>) {
    let _ = UPDATER.set(updater);
}

pub fn installed() -> Option<Arc<HostUpdater>> {
    UPDATER.get().cloned()
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
