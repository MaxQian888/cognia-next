use crate::{AppState, Operation, OpsErrorBody};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use cognia_deployment::agent_protocol::{
    AgentOperation, AgentToControllerMessage, BackupParameters, CollectLogsParameters,
    CollectStatusParameters, ControllerToAgentMessage, PreflightParameters, ReleaseParameters,
    RestoreParameters, RotateKeyParameters, SignedOperation, AGENT_PROTOCOL_VERSION,
};
use cognia_deployment::{OperationKind, OperationState};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::timeout;
use uuid::Uuid;

const AGENT_LEASE_SECONDS: i64 = 60;

pub struct OperationSigner {
    key_id: String,
    key: SigningKey,
}

impl OperationSigner {
    pub fn from_base64(key_id: String, encoded_key: &str) -> anyhow::Result<Arc<Self>> {
        let bytes = BASE64.decode(encoded_key)?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("controller signing key must contain 32 bytes"))?;
        Ok(Arc::new(Self {
            key_id,
            key: SigningKey::from_bytes(&bytes),
        }))
    }

    pub fn sign(
        &self,
        operation_id: String,
        target_id: String,
        payload: AgentOperation,
        now: i64,
    ) -> anyhow::Result<SignedOperation> {
        let mut operation = SignedOperation {
            api_version: AGENT_PROTOCOL_VERSION.into(),
            operation_id,
            target_id,
            issued_at: now,
            expires_at: now + AGENT_LEASE_SECONDS,
            key_id: self.key_id.clone(),
            payload,
            signature: String::new(),
        };
        operation.signature = BASE64.encode(self.key.sign(&operation.signing_bytes()?).to_bytes());
        Ok(operation)
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    pub fn verifying_key_base64(&self) -> String {
        BASE64.encode(self.key.verifying_key().to_bytes())
    }
}

pub async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(signer) = state.operation_signer.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "agent gateway unavailable").into_response();
    };
    if headers
        .get("x-cognia-mtls-verified")
        .and_then(|value| value.to_str().ok())
        != Some("SUCCESS")
    {
        return (StatusCode::UNAUTHORIZED, "verified mTLS is required").into_response();
    }
    let Some(fingerprint) = headers
        .get("x-cognia-client-cert-sha256")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
    else {
        return (
            StatusCode::UNAUTHORIZED,
            "client certificate fingerprint missing",
        )
            .into_response();
    };
    upgrade.on_upgrade(move |socket| run_socket(socket, state, signer, fingerprint))
}

async fn run_socket(
    socket: WebSocket,
    state: AppState,
    signer: Arc<OperationSigner>,
    fingerprint: String,
) {
    let (mut writer, mut reader) = socket.split();
    let hello = timeout(Duration::from_secs(10), reader.next()).await;
    let Ok(Some(Ok(Message::Text(text)))) = hello else {
        return;
    };
    let Ok(AgentToControllerMessage::Hello(hello)) = serde_json::from_str(&text) else {
        return;
    };
    if hello.api_version != AGENT_PROTOCOL_VERSION {
        return;
    }
    let identity = match state
        .store
        .authenticate_agent(&hello.agent_id, &hello.target_id, &fingerprint)
        .await
    {
        Ok(Some(identity)) => identity,
        _ => return,
    };
    let worker_id = format!("{}:{}", identity.agent_id, Uuid::new_v4());
    let mut active_operation: Option<Uuid> = None;
    let mut poll = tokio::time::interval(Duration::from_secs(1));

    loop {
        tokio::select! {
            _ = poll.tick() => {
                if let Some(operation_id) = active_operation {
                    match state.store.heartbeat_operation(operation_id, &worker_id, AGENT_LEASE_SECONDS).await {
                        Ok(true) => {}
                        _ => active_operation = None,
                    }
                    continue;
                }
                let claimed = state.store.claim_operation_for_target(
                    &identity.tenant_id,
                    &identity.target_id,
                    &worker_id,
                    AGENT_LEASE_SECONDS,
                ).await;
                let Ok(Some(operation)) = claimed else { continue };
                let operation_id = operation.id;
                match prepare_operation(&state, &worker_id, operation, &signer).await {
                    Ok(signed) => {
                        let message = ControllerToAgentMessage::Operation(Box::new(signed));
                        let Ok(json) = serde_json::to_string(&message) else { continue };
                        if writer.send(Message::Text(json.into())).await.is_err() {
                            return;
                        }
                        active_operation = Some(operation_id);
                    }
                    Err(error) => {
                        let _ = state.store.transition_operation(
                            operation_id,
                            &worker_id,
                            OperationState::Failed,
                            None,
                            Some(OpsErrorBody {
                                code: "invalid_agent_operation".into(),
                                message: error.to_string(),
                                details: None,
                            }),
                        ).await;
                    }
                }
            }
            message = reader.next() => {
                let Some(Ok(message)) = message else { return };
                let Message::Text(text) = message else { continue };
                let Ok(message) = serde_json::from_str::<AgentToControllerMessage>(&text) else { continue };
                match message {
                    AgentToControllerMessage::Heartbeat(heartbeat) => {
                        if let Some(operation_id) = heartbeat.operation_id.and_then(|id| Uuid::parse_str(&id).ok()) {
                            let _ = state.store.heartbeat_operation(operation_id, &worker_id, AGENT_LEASE_SECONDS).await;
                        }
                    }
                    AgentToControllerMessage::Transition(transition) => {
                        let Ok(operation_id) = Uuid::parse_str(&transition.operation_id) else { continue };
                        if active_operation != Some(operation_id) || !transition.state.is_terminal() {
                            continue;
                        }
                        let error = transition.error_code.map(|code| OpsErrorBody {
                            code,
                            message: transition.error_message.unwrap_or_default(),
                            details: None,
                        });
                        if transition.state == OperationState::Succeeded {
                            let verified = state.store.transition_operation(
                                operation_id,
                                &worker_id,
                                OperationState::Verifying,
                                None,
                                None,
                            ).await;
                            if verified.is_err() { continue; }
                        }
                        let result = state.store.transition_operation(
                            operation_id,
                            &worker_id,
                            transition.state,
                            transition.result,
                            error,
                        ).await;
                        if result.is_ok() {
                            active_operation = None;
                        }
                    }
                    AgentToControllerMessage::Hello(_) => return,
                }
            }
        }
    }
}

async fn prepare_operation(
    state: &AppState,
    worker_id: &str,
    operation: Operation,
    signer: &OperationSigner,
) -> anyhow::Result<SignedOperation> {
    let payload = operation_payload(&operation)?;
    state
        .store
        .transition_operation(
            operation.id,
            worker_id,
            OperationState::Preparing,
            None,
            None,
        )
        .await?;
    state
        .store
        .transition_operation(
            operation.id,
            worker_id,
            OperationState::Executing,
            None,
            None,
        )
        .await?;
    signer.sign(
        operation.id.to_string(),
        operation.target_id,
        payload,
        now_unix_seconds(),
    )
}

fn operation_payload(operation: &Operation) -> anyhow::Result<AgentOperation> {
    Ok(match operation.kind {
        OperationKind::Preflight => AgentOperation::Preflight(serde_json::from_value::<
            PreflightParameters,
        >(operation.request.clone())?),
        OperationKind::Deploy => AgentOperation::Deploy(
            serde_json::from_value::<ReleaseParameters>(operation.request.clone())?,
        ),
        OperationKind::Upgrade => AgentOperation::Upgrade(serde_json::from_value::<
            ReleaseParameters,
        >(operation.request.clone())?),
        OperationKind::Rollback => AgentOperation::Rollback(serde_json::from_value::<
            ReleaseParameters,
        >(operation.request.clone())?),
        OperationKind::Backup => {
            let parameters = if operation
                .request
                .as_object()
                .is_some_and(|map| map.is_empty())
            {
                BackupParameters {
                    backup_id: operation.id.to_string(),
                }
            } else {
                serde_json::from_value(operation.request.clone())?
            };
            AgentOperation::Backup(parameters)
        }
        OperationKind::Restore => AgentOperation::Restore(serde_json::from_value::<
            RestoreParameters,
        >(operation.request.clone())?),
        OperationKind::RotateKey => AgentOperation::RotateKey(serde_json::from_value::<
            RotateKeyParameters,
        >(operation.request.clone())?),
        OperationKind::CollectStatus => {
            let parameters = if operation
                .request
                .as_object()
                .is_some_and(|map| map.is_empty())
            {
                CollectStatusParameters {
                    include_runtime_usage: false,
                }
            } else {
                serde_json::from_value(operation.request.clone())?
            };
            AgentOperation::CollectStatus(parameters)
        }
        OperationKind::CollectLogs => {
            let parameters = if operation
                .request
                .as_object()
                .is_some_and(|map| map.is_empty())
            {
                CollectLogsParameters {
                    after_event_id: None,
                    limit: 200,
                }
            } else {
                serde_json::from_value(operation.request.clone())?
            };
            AgentOperation::CollectLogs(parameters)
        }
    })
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_deployment::agent_protocol::AgentRelease;
    use ed25519_dalek::VerifyingKey;
    use serde_json::json;

    #[test]
    fn signer_produces_an_agent_verifiable_envelope() {
        let signer = OperationSigner::from_base64("key-1".into(), &BASE64.encode([3_u8; 32]))
            .expect("signer");
        let signed = signer
            .sign(
                "operation-1".into(),
                "staging".into(),
                AgentOperation::Backup(BackupParameters {
                    backup_id: "backup-1".into(),
                }),
                1_700_000_000,
            )
            .expect("signed");
        let key = VerifyingKey::from_bytes(
            &SigningKey::from_bytes(&[3_u8; 32])
                .verifying_key()
                .to_bytes(),
        )
        .expect("key");
        signed
            .verify("staging", 1_700_000_001, &key)
            .expect("verify");
    }

    #[test]
    fn rejects_untyped_upgrade_payloads() {
        let operation = Operation {
            id: Uuid::new_v4(),
            tenant_id: "tenant".into(),
            target_id: "staging".into(),
            kind: OperationKind::Upgrade,
            state: OperationState::Queued,
            request: json!({ "argv": ["sh", "-c", "unsafe"] }),
            result: None,
            error: None,
            created_by: "user".into(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        assert!(operation_payload(&operation).is_err());

        let _ = AgentRelease {
            server_image: String::new(),
            runner_image: String::new(),
            workspace_runtime_image: String::new(),
            config_revision: String::new(),
        };
    }
}
