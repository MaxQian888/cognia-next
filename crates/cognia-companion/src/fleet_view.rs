//! Fleet projection adapter backed by the companion connection registries.
use std::sync::Arc;
use cognia_fleet::companion::{FleetCompanion, COMPANION};
use cognia_fleet::registry::FleetHost;
/// The companion core's side of a Fleet snapshot: the connected brain and the
/// tenant's worker hosts.
struct CompanionFleetView;

impl FleetCompanion for CompanionFleetView {
    fn brain_account_id(&self) -> Option<String> {
        crate::ws_bridge::current_brain_account_id()
    }

    fn hosts(&self, tenant_id: &str) -> Vec<FleetHost> {
        crate::ws_worker::fleet_hosts(tenant_id)
    }
}

/// Give Fleet snapshots the companion view. Desktop boot and the headless
/// services install call this; a process that skips it projects no brain and
/// lists no worker hosts.
pub fn install_companion_view() {
    COMPANION.set(Arc::new(CompanionFleetView));
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projects_the_same_active_brain_account() {
        assert_eq!(CompanionFleetView.brain_account_id(), crate::ws_bridge::current_brain_account_id());
    }
}
