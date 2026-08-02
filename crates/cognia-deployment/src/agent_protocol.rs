//! Signed, typed controller-to-agent protocol.

use crate::{DeploymentTarget, DeploymentTopology, OperationKind, OperationState};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

pub const AGENT_PROTOCOL_VERSION: &str = "deploy.cognia.dev/agent/v1alpha1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedOperation {
    pub api_version: String,
    pub operation_id: String,
    pub target_id: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub key_id: String,
    pub payload: AgentOperation,
    pub signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SigningPayload<'a> {
    api_version: &'a str,
    operation_id: &'a str,
    target_id: &'a str,
    issued_at: i64,
    expires_at: i64,
    key_id: &'a str,
    payload: &'a AgentOperation,
}

impl SignedOperation {
    pub fn signing_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        serde_json::to_vec(&SigningPayload {
            api_version: &self.api_version,
            operation_id: &self.operation_id,
            target_id: &self.target_id,
            issued_at: self.issued_at,
            expires_at: self.expires_at,
            key_id: &self.key_id,
            payload: &self.payload,
        })
        .map_err(ProtocolError::Serialize)
    }

    pub fn verify(
        &self,
        expected_target: &str,
        now_unix_seconds: i64,
        verifying_key: &VerifyingKey,
    ) -> Result<(), ProtocolError> {
        if self.api_version != AGENT_PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.api_version.clone()));
        }
        if self.target_id != expected_target {
            return Err(ProtocolError::WrongTarget);
        }
        if self.issued_at > now_unix_seconds + 60 {
            return Err(ProtocolError::IssuedInFuture);
        }
        if self.expires_at <= now_unix_seconds || self.expires_at <= self.issued_at {
            return Err(ProtocolError::Expired);
        }
        let signature = BASE64
            .decode(&self.signature)
            .map_err(ProtocolError::InvalidSignatureEncoding)?;
        let signature = Signature::from_slice(&signature)
            .map_err(|_| ProtocolError::InvalidSignatureEncodingLength)?;
        verifying_key
            .verify(&self.signing_bytes()?, &signature)
            .map_err(|_| ProtocolError::InvalidSignature)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", content = "parameters", rename_all = "kebab-case")]
pub enum AgentOperation {
    Preflight(PreflightParameters),
    Deploy(ReleaseParameters),
    Upgrade(ReleaseParameters),
    Rollback(RollbackParameters),
    Backup(BackupParameters),
    Restore(RestoreParameters),
    RotateKey(RotateKeyParameters),
    CollectStatus(CollectStatusParameters),
    CollectLogs(CollectLogsParameters),
}

impl AgentOperation {
    pub fn kind(&self) -> OperationKind {
        match self {
            Self::Preflight(_) => OperationKind::Preflight,
            Self::Deploy(_) => OperationKind::Deploy,
            Self::Upgrade(_) => OperationKind::Upgrade,
            Self::Rollback(_) => OperationKind::Rollback,
            Self::Backup(_) => OperationKind::Backup,
            Self::Restore(_) => OperationKind::Restore,
            Self::RotateKey(_) => OperationKind::RotateKey,
            Self::CollectStatus(_) => OperationKind::CollectStatus,
            Self::CollectLogs(_) => OperationKind::CollectLogs,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightParameters {
    pub target_revision: i64,
    pub topology: DeploymentTopology,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseParameters {
    pub target_revision: i64,
    pub target: DeploymentTarget,
    pub release: AgentRelease,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackParameters {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRelease {
    pub server_image: String,
    pub runner_image: String,
    pub workspace_runtime_image: String,
    pub config_revision: String,
}

impl AgentRelease {
    pub fn has_immutable_images(&self) -> bool {
        [
            self.server_image.as_str(),
            self.runner_image.as_str(),
            self.workspace_runtime_image.as_str(),
        ]
        .iter()
        .all(|image| is_digest_image(image))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupParameters {
    pub backup_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreParameters {
    pub recovery_point_id: String,
    pub destination_volume_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotateKeyParameters {
    pub key_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectStatusParameters {
    pub include_runtime_usage: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectLogsParameters {
    pub after_event_id: Option<i64>,
    pub limit: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "kebab-case")]
pub enum AgentToControllerMessage {
    Hello(AgentHello),
    Heartbeat(AgentHeartbeat),
    Transition(AgentTransition),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "kebab-case")]
pub enum ControllerToAgentMessage {
    Operation(Box<SignedOperation>),
    RotateCertificate(CertificateRotationRequest),
    Ping { nonce: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHello {
    pub api_version: String,
    pub agent_id: String,
    pub target_id: String,
    pub topology: DeploymentTopology,
    pub agent_version: String,
    pub certificate_expires_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHeartbeat {
    pub operation_id: Option<String>,
    pub observed_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTransition {
    pub operation_id: String,
    pub state: OperationState,
    pub result: Option<serde_json::Value>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CertificateRotationRequest {
    pub enrollment_nonce: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("unsupported agent protocol version `{0}`")]
    UnsupportedVersion(String),
    #[error("operation is addressed to a different target")]
    WrongTarget,
    #[error("operation issue time is in the future")]
    IssuedInFuture,
    #[error("operation has expired")]
    Expired,
    #[error("signature is not valid base64: {0}")]
    InvalidSignatureEncoding(base64::DecodeError),
    #[error("signature has an invalid length")]
    InvalidSignatureEncodingLength,
    #[error("operation signature verification failed")]
    InvalidSignature,
    #[error("could not serialize the signing payload: {0}")]
    Serialize(serde_json::Error),
}

fn is_digest_image(image: &str) -> bool {
    let Some((_, digest)) = image.rsplit_once("@sha256:") else {
        return false;
    };
    digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}
