//! Companion-owned policy and environment callbacks for the IDE runtime.
use async_trait::async_trait;
use axum::extract::Request;
use axum::response::Response;
use cognia_core::installed::Replaceable;
use std::sync::Arc;

#[async_trait]
pub trait CodeServerHost: Send + Sync {
    fn remote_state(&self) -> Option<Arc<crate::remote::RemoteCodeServerState>>;
    fn device_can_control(&self, device_id: &str) -> bool;
    async fn port_allowed(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<bool, String>;
    async fn local_relay(
        &self,
        project_id: String,
        container_id: String,
        port: u16,
        request: Request,
    ) -> Response;
}

pub static HOST: Replaceable<dyn CodeServerHost> = Replaceable::new("codeserver.host");

pub fn device_can_control(device_id: &str) -> bool {
    HOST.try_get()
        .is_some_and(|host| host.device_can_control(device_id))
}

#[cfg(test)]
mod tests {
    #[test]
    fn missing_host_never_grants_remote_control() {
        assert!(!super::device_can_control("unpaired-device"));
    }
}
