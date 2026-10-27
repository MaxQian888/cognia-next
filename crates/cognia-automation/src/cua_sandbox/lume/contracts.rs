//! Local-only Host contract. Renderer projections never confer authority.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONTRACT_VERSION: u32 = 1;
pub const LUME_VERSION: &str = "0.6.1";

pub fn require_start_capacity(
    available_memory_mb: u64,
    vm_memory_mb: u64,
    owned_running: usize,
    available_disk: u64,
) -> Result<(), String> {
    if owned_running >= 2 {
        return Err("lume_capacity_slots".into());
    }
    if available_memory_mb < vm_memory_mb.saturating_add(8192) {
        return Err("lume_capacity_memory".into());
    }
    if available_disk < 10 * 1024 * 1024 * 1024 {
        return Err("lume_capacity_disk".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRef {
    pub resource_id: String,
    pub generation: u64,
    pub boot_epoch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingRef {
    #[serde(flatten)]
    pub resource: ResourceRef,
    pub binding_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Readiness {
    pub vm: bool,
    pub ssh: bool,
    pub helper: bool,
    pub gui: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    #[serde(flatten)]
    pub reference: ResourceRef,
    pub connection_id: String,
    pub vm_name: String,
    pub state: String,
    pub readiness: Readiness,
    pub quarantine: bool,
    pub memory_mb: u64,
    pub last_error_code: Option<String>,
    pub group_id: Option<String>,
    #[serde(default)]
    pub workspace_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Provision {
    Create {
        ipsw: String,
        cpu: u32,
        memory_mb: u64,
        disk_gb: u64,
    },
    Clone {
        seed_name: String,
        seed_storage: String,
    },
    /// Explicit adoption is limited to a VM already inside the owned storage.
    /// External VMs use Clone, so deletion cannot destroy a user's original.
    Attach { vm_name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    ImportWorkspace {
        reference: ResourceRef,
        host_root: String,
    },
    ReviewWorkspace {
        reference: ResourceRef,
    },
    AdoptWorkspace {
        reference: ResourceRef,
        review_id: String,
    },
    Configure {
        binary: String,
        enabled: bool,
    },
    Provision {
        connection_id: String,
        source: Provision,
    },
    Start {
        reference: ResourceRef,
    },
    Setup {
        reference: ResourceRef,
    },
    Connect {
        reference: ResourceRef,
    },
    Health {
        reference: ResourceRef,
    },
    Stop {
        reference: ResourceRef,
    },
    Delete {
        reference: ResourceRef,
    },
    PrepareSsh {
        reference: ResourceRef,
    },
    TrustSsh {
        reference: ResourceRef,
        host_key: String,
        user: String,
    },
    Qualify {
        reference: ResourceRef,
        helper_hash: String,
        driver_version: String,
        #[serde(skip)]
        approved_identity: Option<cognia_desktop_guest::lume::DriverIdentity>,
    },
    Execute {
        request: ExecRequest,
    },
    File {
        binding: BindingRef,
        operation: cognia_desktop_guest::lume::FileOperation,
        data_base64: String,
    },
}

impl Operation {
    pub fn reference(&self) -> Option<&ResourceRef> {
        match self {
            Self::Provision { .. } | Self::Configure { .. } => None,
            Self::Start { reference }
            | Self::ImportWorkspace { reference, .. }
            | Self::ReviewWorkspace { reference }
            | Self::AdoptWorkspace { reference, .. }
            | Self::Setup { reference }
            | Self::Connect { reference }
            | Self::Health { reference }
            | Self::Stop { reference }
            | Self::Delete { reference }
            | Self::PrepareSsh { reference }
            | Self::TrustSsh { reference, .. }
            | Self::Qualify { reference, .. } => Some(reference),
            Self::Execute { request } => Some(&request.binding.resource),
            Self::File { binding, .. } => Some(&binding.resource),
        }
    }
    pub fn recovery(&self) -> bool {
        matches!(
            self,
            Self::Health { .. } | Self::Stop { .. } | Self::Delete { .. }
        )
    }
    pub fn needs_consent(&self) -> bool {
        matches!(
            self,
            Self::Configure { .. }
                | Self::ImportWorkspace { .. }
                | Self::AdoptWorkspace { .. }
                | Self::Provision { .. }
                | Self::Setup { .. }
                | Self::Delete { .. }
                | Self::PrepareSsh { .. }
                | Self::TrustSsh { .. }
                | Self::Qualify { .. }
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationStatus {
    pub id: String,
    pub request_key: String,
    pub request_hash: String,
    pub state: String,
    pub stage: String,
    pub resource: Option<Resource>,
    pub error_code: Option<String>,
    /// Results are bounded ephemeral data, never part of the ownership journal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingPolicy {
    pub group_id: String,
    pub workspace_root: String,
    pub network: String,
    pub max_cpu_seconds: u32,
    pub max_memory_mb: u64,
    pub readable: Vec<String>,
    pub writable: Vec<String>,
}

impl BindingPolicy {
    pub fn validate(&self, resource: &Resource) -> Result<(), String> {
        if self.group_id.is_empty() || self.workspace_root.is_empty() {
            return Err("lume_binding_identity".into());
        }
        if self.network != "on"
            || self.max_cpu_seconds != 0
            || (self.max_memory_mb != 0 && resource.memory_mb > self.max_memory_mb)
        {
            return Err("lume_policy_unsupported".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecRequest {
    pub binding: BindingRef,
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub stdin: Option<String>,
    pub timeout_ms: u64,
    pub network: String,
    pub max_cpu_seconds: u32,
    pub max_memory_mb: u64,
    pub readable: Vec<String>,
    pub writable: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capacity_preserves_host_reserve_and_rejects_third_guest() {
        assert!(require_start_capacity(16384, 8192, 1, 10 * 1024 * 1024 * 1024).is_ok());
        assert_eq!(
            require_start_capacity(16383, 8192, 1, u64::MAX).unwrap_err(),
            "lume_capacity_memory"
        );
        assert_eq!(
            require_start_capacity(u64::MAX, 8192, 2, u64::MAX).unwrap_err(),
            "lume_capacity_slots"
        );
        assert_eq!(
            require_start_capacity(16384, 8192, 0, 1).unwrap_err(),
            "lume_capacity_disk"
        );
    }
    #[test]
    fn unknown_operations_and_extra_execution_fields_are_refused() {
        assert!(
            serde_json::from_value::<Operation>(serde_json::json!({"kind":"suspend"})).is_err()
        );
        assert!(serde_json::from_value::<Provision>(
            serde_json::json!({"kind":"attach","vmName":"x","storage":"/Users/me"})
        )
        .is_err());
        let binding = serde_json::json!({"resourceId":"r","generation":1,"bootEpoch":"b","bindingId":"binding","sessionId":"session"});
        let decoded: BindingRef = serde_json::from_value(binding.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), binding);
    }
    #[test]
    fn vm_network_and_strict_cpu_requirements_are_never_downgraded() {
        let resource = Resource {
            reference: ResourceRef {
                resource_id: "r".into(),
                generation: 1,
                boot_epoch: "b".into(),
            },
            connection_id: "c".into(),
            vm_name: "v".into(),
            state: "running".into(),
            readiness: Readiness::default(),
            quarantine: false,
            memory_mb: 8192,
            last_error_code: None,
            group_id: None,
            workspace_revision: None,
        };
        let mut policy = BindingPolicy {
            group_id: "g".into(),
            workspace_root: "w".into(),
            network: "off".into(),
            max_cpu_seconds: 0,
            max_memory_mb: 8192,
            readable: vec![],
            writable: vec![],
        };
        assert!(policy.validate(&resource).is_err());
        policy.network = "on".into();
        assert!(policy.validate(&resource).is_ok());
        policy.max_cpu_seconds = 1;
        assert!(policy.validate(&resource).is_err());
        policy.max_cpu_seconds = 0;
        policy.max_memory_mb = 4096;
        assert!(policy.validate(&resource).is_err());
    }
}
