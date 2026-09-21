//! Authorized workspace port access over Docker exec. No daemon port is
//! published, and only ports from a currently admitted spec can be opened.

use async_trait::async_trait;
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePort {
    pub container_id: String,
    pub project_id: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub path: String,
}

#[async_trait]
pub trait SandboxRuntimeControl: Send + Sync {
    async fn list_ports(&self, project_id: &str) -> Result<Vec<RuntimePort>, SandboxSpawnError>;
    async fn port_allowed(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<bool, SandboxSpawnError>;
    /// The returned stream must close if its spec/port authority is revoked;
    /// callers add their own device authorization without duplicating checks.
    async fn open_port(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<tokio::io::DuplexStream, SandboxSpawnError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_wire_omits_absent_label() {
        let port = RuntimePort {
            container_id: "runtime".into(),
            project_id: "project".into(),
            port: 3000,
            label: None,
            path: "/api/environment/ports/project/runtime/3000/".into(),
        };
        let json = serde_json::to_value(port).unwrap();
        assert_eq!(json["containerId"], "runtime");
        assert!(json.get("label").is_none());
    }
}
