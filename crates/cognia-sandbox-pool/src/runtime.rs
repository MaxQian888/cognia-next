//! Authorized workspace port access over Docker exec. No daemon port is
//! published, and only ports from a currently admitted spec can be opened.

use async_trait::async_trait;
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
use serde::Serialize;

/// Internal sidecar-created listener. This type is never a renderer RPC input.
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolHostService {
    pub agent_id: String,
    pub owner_session_id: String,
    pub origin_device_id: Option<String>,
    pub lease_id: String,
    pub generation: u64,
    pub port: u16,
    /// Host-owned live authorization, never deserialized from IPC.
    #[serde(skip)]
    pub authorization: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHostBridge {
    pub bridge_id: String,
    pub port: u16,
}

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
    fn agent_origin_allowed(&self, _agent_id: &str, _device_id: &str) -> Option<bool> {
        None
    }
    async fn register_tool_host(
        &self,
        _service: ToolHostService,
    ) -> Result<String, SandboxSpawnError> {
        Err(SandboxSpawnError::refused(
            "sandbox_service_unsupported",
            "This runtime does not support hosted services",
        ))
    }
    async fn open_tool_host(
        &self,
        _service: ToolHostService,
    ) -> Result<ToolHostBridge, SandboxSpawnError> {
        Err(SandboxSpawnError::refused(
            "sandbox_service_unsupported",
            "This runtime does not support hosted services",
        ))
    }
    fn renew_tool_host(&self, _bridge_id: &str) -> bool {
        false
    }
    fn close_tool_host(&self, _bridge_id: &str) {}
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
    fn bridge_identity_rejects_arbitrary_targets_and_deserialized_authority() {
        let request = serde_json::json!({"agentId":"agent", "ownerSessionId":"chat", "originDeviceId":null, "leaseId":"renderer-tool-host-fixture", "generation":1, "port":12345});
        assert!(serde_json::from_value::<ToolHostService>(request.clone())
            .unwrap()
            .authorization
            .is_none());
        for key in ["url", "host", "authorization"] {
            let mut forged = request.clone();
            forged[key] = serde_json::json!("127.0.0.1:22");
            assert!(serde_json::from_value::<ToolHostService>(forged).is_err());
        }
    }

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
