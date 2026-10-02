//! Companion policy adapter for the shared IDE runtime.
use cognia_codeserver::remote;

/// Companion policy for the IDE runtime. Public so the desktop shell can wrap
/// it with its own workbenches (`src-tauri/src/codeserver/desktop_host.rs`)
/// rather than restate the policy.
pub struct CompanionCodeServerHost;

#[async_trait::async_trait]
impl cognia_codeserver::host::CodeServerHost for CompanionCodeServerHost {
    fn remote_state(&self) -> Option<std::sync::Arc<remote::RemoteCodeServerState>> {
        crate::headless::headless_services()
            .map(|services| std::sync::Arc::clone(&services.code_server))
    }
    fn device_can_control(&self, device_id: &str) -> bool {
        cognia_companion::workspace_access::device_can_control(device_id)
    }
    async fn port_allowed(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<bool, String> {
        let runtime = cognia_companion::environment_pool::installed()
            .and_then(|pool| pool.runtime)
            .ok_or("runtime environment service is unavailable")?;
        runtime
            .port_allowed(project_id, container_id, port)
            .await
            .map_err(|error| error.to_string())
    }
    async fn local_relay(
        &self,
        project_id: String,
        container_id: String,
        port: u16,
        request: axum::extract::Request,
    ) -> axum::response::Response {
        cognia_companion::environment_ports::local_relay(project_id, container_id, port, request)
            .await
    }
}

pub fn install_host() {
    cognia_codeserver::host::HOST.set(std::sync::Arc::new(CompanionCodeServerHost));
}

#[cfg(test)]
mod tests {
    #[test]
    fn unpaired_devices_are_not_granted_ide_control() {
        use cognia_codeserver::host::CodeServerHost;
        assert!(!super::CompanionCodeServerHost.device_can_control("unpaired-ide-test"));
    }
}
