//! The desktop's IDE host: companion policy plus this machine's own workbenches.
//!
//! The `/ide/relay/{id}` routes are mounted on every companion server, the
//! desktop's included, but the companion host resolves a relay id only
//! against a headless host's instances. On the desktop that left a paired
//! device's relay with nothing behind it. This adapter keeps every companion
//! policy decision (who may control, which container ports are allowed) and
//! answers the relay from [`CodeServerState`], which admits a device only with
//! the owner's per-project approval.

use std::sync::Arc;

use cognia_companion_rpc::codeserver_host::CompanionCodeServerHost;
use tauri::{AppHandle, Manager};

use super::host::{CodeServerHost, HOST};
use super::remote::RemoteCodeServerState;
use super::CodeServerState;

/// Where the owner's relay approvals persist, under the code-server root.
pub const RELAY_GRANTS_FILE: &str = "relay-grants.json";

/// Where a relay id leads on this machine. A seam so the adapter can be
/// exercised without a running app.
#[async_trait::async_trait]
trait RelayPorts: Send + Sync {
    async fn relay_port(&self, relay_id: &str, device_id: &str) -> Option<u16>;
}

struct AppRelayPorts(AppHandle);

#[async_trait::async_trait]
impl RelayPorts for AppRelayPorts {
    async fn relay_port(&self, relay_id: &str, device_id: &str) -> Option<u16> {
        self.0
            .state::<CodeServerState>()
            .relay_port(relay_id, device_id)
            .await
    }
}

struct DesktopCodeServerHost<R> {
    relays: R,
    companion: CompanionCodeServerHost,
}

#[async_trait::async_trait]
impl<R: RelayPorts> CodeServerHost for DesktopCodeServerHost<R> {
    fn remote_state(&self) -> Option<Arc<RemoteCodeServerState>> {
        self.companion.remote_state()
    }

    fn device_can_control(&self, device_id: &str) -> bool {
        self.companion.device_can_control(device_id)
    }

    async fn port_allowed(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<bool, String> {
        self.companion
            .port_allowed(project_id, container_id, port)
            .await
    }

    async fn local_relay(
        &self,
        project_id: String,
        container_id: String,
        port: u16,
        request: axum::extract::Request,
    ) -> axum::response::Response {
        self.companion
            .local_relay(project_id, container_id, port, request)
            .await
    }

    async fn relay_port(&self, relay_id: &str, device_id: &str) -> Option<u16> {
        self.relays.relay_port(relay_id, device_id).await
    }
}

/// Install the desktop host and load the owner's relay approvals.
pub fn install_host(app: &AppHandle) {
    match super::download::code_server_root(app) {
        Ok(root) => app
            .state::<CodeServerState>()
            .attach_relay_grants(root.join(RELAY_GRANTS_FILE)),
        // Without the file nothing is granted, so the relay stays closed.
        Err(error) => log::warn!("Pro IDE relay approvals unavailable: {error:#}"),
    }
    HOST.set(Arc::new(DesktopCodeServerHost {
        relays: AppRelayPorts(app.clone()),
        companion: CompanionCodeServerHost,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    struct OneRelay;

    #[async_trait::async_trait]
    impl RelayPorts for OneRelay {
        async fn relay_port(&self, relay_id: &str, device_id: &str) -> Option<u16> {
            (relay_id == "r1" && device_id == "phone").then_some(41_000)
        }
    }

    fn host() -> DesktopCodeServerHost<OneRelay> {
        DesktopCodeServerHost {
            relays: OneRelay,
            companion: CompanionCodeServerHost,
        }
    }

    #[tokio::test]
    async fn relays_resolve_against_this_machine_not_a_headless_registry() {
        let host = host();
        // The companion host's answer on a desktop: no headless services.
        assert!(host.remote_state().is_none());
        assert_eq!(host.relay_port("r1", "phone").await, Some(41_000));
        assert_eq!(host.relay_port("r1", "laptop").await, None);
        assert_eq!(host.relay_port("r2", "phone").await, None);
    }

    #[test]
    fn control_policy_stays_the_companion_s() {
        assert!(!host().device_can_control("unpaired-ide-test"));
    }
}
