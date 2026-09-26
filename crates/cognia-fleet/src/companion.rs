//! What a Fleet snapshot reads from the companion core (ADR-0196 P6d).
//!
//! A snapshot is projected for a tenant only when that tenant's brain is the
//! one connected (or, with no brain, on a single-user host), and it lists the
//! tenant's attached worker hosts. Both live in the companion core, above this
//! crate, so the binary installs a [`FleetCompanion`] at boot: the desktop and
//! `cognia-server` both do. Uninstalled — a unit test — reads as no brain and
//! no worker hosts.

use cognia_core::installed::Replaceable;

use crate::registry::FleetHost;

/// The companion core's side of a Fleet snapshot.
pub trait FleetCompanion: Send + Sync + 'static {
    /// The local account namespace the connected brain announced, if any.
    fn brain_account_id(&self) -> Option<String>;

    /// The tenant's worker hosts: live presence plus stored worker devices.
    fn hosts(&self, tenant_id: &str) -> Vec<FleetHost>;
}

/// The installed companion view.
pub static COMPANION: Replaceable<dyn FleetCompanion> =
    Replaceable::new("cognia_fleet::companion::COMPANION");

pub(crate) fn brain_account_id() -> Option<String> {
    COMPANION
        .try_get()
        .and_then(|companion| companion.brain_account_id())
}

pub(crate) fn hosts(tenant_id: &str) -> Vec<FleetHost> {
    COMPANION
        .try_get()
        .map(|companion| companion.hosts(tenant_id))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_installed_reads_as_no_brain_and_no_hosts() {
        // No test in this crate installs a companion view.
        assert_eq!(brain_account_id(), None);
        assert!(hosts("tenant-a").is_empty());
    }
}
