use chrono::{DateTime, Utc};
use cognia_deployment::{OperationKind, OperationState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSummary {
    pub id: String,
    pub label: String,
    pub topology: String,
    pub public_url: String,
    pub health: ServerHealth,
    pub release_digest: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerHealth {
    Healthy,
    Degraded,
    Unavailable,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDetail {
    #[serde(flatten)]
    pub summary: ServerSummary,
    pub target_revision: i64,
    pub production_certified: bool,
    pub certification_issues: Vec<String>,
    pub capabilities: ProviderCapabilities,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub topologies: Vec<String>,
    pub snapshot_providers: Vec<String>,
    pub secret_providers: Vec<String>,
    pub tls_providers: Vec<String>,
    pub object_store_protocols: Vec<String>,
    pub requires_provider_credentials: bool,
}

impl Default for ProviderCapabilities {
    fn default() -> Self {
        Self {
            topologies: vec!["compose".into(), "kubernetes".into()],
            snapshot_providers: vec!["kubernetes-csi".into(), "external-command".into()],
            secret_providers: vec![
                "file".into(),
                "kubernetes".into(),
                "vault".into(),
                "aws-secrets-manager".into(),
            ],
            tls_providers: vec![
                "ingress".into(),
                "acme-http01".into(),
                "acme-dns01".into(),
                "existing".into(),
            ],
            object_store_protocols: vec!["s3-compatible".into()],
            requires_provider_credentials: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPoint {
    pub id: String,
    pub server_id: String,
    pub created_at: DateTime<Utc>,
    pub kind: RecoveryPointKind,
    pub manifest_sha256: String,
    pub size_bytes: i64,
    pub verified: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryPointKind {
    Snapshot,
    ObjectStore,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: i64,
    pub server_id: String,
    pub timestamp: DateTime<Utc>,
    pub level: String,
    pub component: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: Uuid,
    #[serde(skip_serializing)]
    pub tenant_id: String,
    pub target_id: String,
    pub kind: OperationKind,
    pub state: OperationState,
    pub request: Value,
    pub result: Option<Value>,
    pub error: Option<OpsErrorBody>,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationEvent {
    pub id: i64,
    pub operation_id: Uuid,
    pub target_id: String,
    pub state: OperationState,
    pub timestamp: DateTime<Utc>,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct TenantOperationEvent {
    pub tenant_id: String,
    pub event: OperationEvent,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsErrorBody {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Clone, Debug)]
pub struct NewOperation {
    pub tenant_id: String,
    pub target_id: String,
    pub kind: OperationKind,
    pub request: Value,
    pub created_by: String,
    pub idempotency_key: String,
    pub admin_lease: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAdminLeaseRequest {
    pub target_id: String,
    pub operation: OperationKind,
    pub ttl_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminLease {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateEnrollmentTokenRequest {
    pub target_id: String,
    pub ttl_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentToken {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollAgentRequest {
    pub token: String,
    pub agent_id: String,
    pub csr_pem: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollAgentResponse {
    pub target_id: String,
    pub certificate_pem: String,
    pub ca_certificate_pem: String,
    pub certificate_fingerprint: String,
    pub expires_at: DateTime<Utc>,
    pub controller_signing_key_id: String,
    pub controller_signing_key: String,
}

#[derive(Clone, Debug)]
pub struct EnrollmentGrant {
    pub tenant_id: String,
    pub target_id: String,
}

#[derive(Clone, Debug)]
pub struct AgentIdentity {
    pub tenant_id: String,
    pub target_id: String,
    pub agent_id: String,
}
