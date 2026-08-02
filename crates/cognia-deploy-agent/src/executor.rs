use crate::{Driver, DriverError};
use cognia_deployment::agent_protocol::{AgentOperation, AgentRelease, SignedOperation};
use cognia_deployment::{DeploymentTarget, OperationState};
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

const MAX_COMPLETED_OPERATIONS: usize = 512;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionOutcome {
    pub state: OperationState,
    pub result: Option<Value>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl ExecutionOutcome {
    fn succeeded(result: Value) -> Self {
        Self {
            state: OperationState::Succeeded,
            result: Some(result),
            error_code: None,
            error_message: None,
        }
    }

    fn failed(code: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            state: OperationState::Failed,
            result: None,
            error_code: Some(code.into()),
            error_message: Some(error.into()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletedOperation {
    pub operation_id: String,
    pub outcome: ExecutionOutcome,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionState {
    pub current_release: Option<AgentRelease>,
    pub previous_release: Option<AgentRelease>,
    pub current_target: Option<DeploymentTarget>,
    pub previous_target: Option<DeploymentTarget>,
    pub completed_operations: Vec<CompletedOperation>,
}

#[derive(Clone)]
pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub async fn load(&self) -> Result<ExecutionState, std::io::Error> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(ExecutionState::default())
            }
            Err(error) => Err(error),
        }
    }

    pub async fn save(&self, state: &ExecutionState) -> Result<(), std::io::Error> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let bytes = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
        let temporary = temporary_path(&self.path);
        tokio::fs::write(&temporary, bytes).await?;
        tokio::fs::rename(temporary, &self.path).await
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "agent-state".into());
    name.push(".tmp");
    path.with_file_name(name)
}

pub struct AgentExecutor {
    target_id: String,
    verifying_key: VerifyingKey,
    store: StateStore,
    driver: Arc<dyn Driver>,
    operation_lock: Mutex<()>,
}

impl AgentExecutor {
    pub fn new(
        target_id: String,
        verifying_key: VerifyingKey,
        store: StateStore,
        driver: Arc<dyn Driver>,
    ) -> Self {
        Self {
            target_id,
            verifying_key,
            store,
            driver,
            operation_lock: Mutex::new(()),
        }
    }

    pub async fn state(&self) -> ExecutionState {
        self.store.load().await.unwrap_or_default()
    }

    pub async fn execute(&self, operation: SignedOperation, now: i64) -> ExecutionOutcome {
        let _guard = self.operation_lock.lock().await;
        if let Err(error) = operation.verify(&self.target_id, now, &self.verifying_key) {
            return ExecutionOutcome::failed("operation_verification_failed", error.to_string());
        }
        let mut state = match self.store.load().await {
            Ok(state) => state,
            Err(error) => return ExecutionOutcome::failed("state_load_failed", error.to_string()),
        };
        if let Some(completed) = state
            .completed_operations
            .iter()
            .find(|completed| completed.operation_id == operation.operation_id)
        {
            return completed.outcome.clone();
        }

        let outcome = match &operation.payload {
            AgentOperation::Preflight(parameters) => self
                .driver
                .preflight(parameters.target_revision)
                .await
                .map(ExecutionOutcome::succeeded)
                .unwrap_or_else(driver_failure),
            AgentOperation::Deploy(parameters) | AgentOperation::Upgrade(parameters) => {
                self.activate_with_rollback(&mut state, &parameters.release, &parameters.target)
                    .await
            }
            AgentOperation::Rollback(_) => self.rollback_to_previous(&mut state).await,
            AgentOperation::Backup(parameters) => self
                .driver
                .backup(&parameters.backup_id)
                .await
                .map(ExecutionOutcome::succeeded)
                .unwrap_or_else(driver_failure),
            AgentOperation::Restore(parameters) => self
                .driver
                .restore(
                    &parameters.recovery_point_id,
                    &parameters.destination_volume_id,
                )
                .await
                .map(ExecutionOutcome::succeeded)
                .unwrap_or_else(driver_failure),
            AgentOperation::RotateKey(parameters) => self
                .driver
                .rotate_key(&parameters.key_version)
                .await
                .map(ExecutionOutcome::succeeded)
                .unwrap_or_else(driver_failure),
            AgentOperation::CollectStatus(parameters) => self
                .driver
                .collect_status(parameters.include_runtime_usage)
                .await
                .map(ExecutionOutcome::succeeded)
                .unwrap_or_else(driver_failure),
            AgentOperation::CollectLogs(parameters) => self
                .driver
                .collect_logs(parameters.after_event_id, parameters.limit.min(1000))
                .await
                .map(ExecutionOutcome::succeeded)
                .unwrap_or_else(driver_failure),
        };

        state.completed_operations.push(CompletedOperation {
            operation_id: operation.operation_id,
            outcome: outcome.clone(),
        });
        if state.completed_operations.len() > MAX_COMPLETED_OPERATIONS {
            let overflow = state.completed_operations.len() - MAX_COMPLETED_OPERATIONS;
            state.completed_operations.drain(0..overflow);
        }
        if let Err(error) = self.store.save(&state).await {
            return ExecutionOutcome::failed("state_save_failed", error.to_string());
        }
        outcome
    }

    async fn activate_with_rollback(
        &self,
        state: &mut ExecutionState,
        release: &AgentRelease,
        target: &DeploymentTarget,
    ) -> ExecutionOutcome {
        if !release.has_immutable_images() {
            return ExecutionOutcome::failed(
                "mutable_release_image",
                "production operations require sha256 image digests",
            );
        }
        if target.metadata.id != self.target_id {
            return ExecutionOutcome::failed(
                "deployment_target_mismatch",
                "operation DeploymentTarget does not match the enrolled target",
            );
        }
        let previous = state.current_release.clone();
        let previous_target = state.current_target.clone();
        state.previous_release = previous.clone();
        state.previous_target = previous_target.clone();
        if let Err(error) = self.store.save(state).await {
            return ExecutionOutcome::failed("state_save_failed", error.to_string());
        }

        let activation = async {
            self.driver.activate_release(release, target).await?;
            self.driver.strict_smoke(release).await
        }
        .await;
        match activation {
            Ok(smoke) => {
                state.current_release = Some(release.clone());
                state.current_target = Some(target.clone());
                ExecutionOutcome::succeeded(json!({
                    "release": release,
                    "strictSmoke": smoke,
                }))
            }
            Err(primary_error) => {
                let Some(previous) = previous else {
                    state.current_release = Some(release.clone());
                    state.current_target = Some(target.clone());
                    return driver_failure(primary_error);
                };
                let Some(previous_target) = previous_target else {
                    state.current_release = Some(release.clone());
                    state.current_target = Some(target.clone());
                    return ExecutionOutcome::failed(
                        "previous_target_unavailable",
                        "previous release has no persisted DeploymentTarget",
                    );
                };
                let rollback = async {
                    self.driver
                        .activate_release(&previous, &previous_target)
                        .await?;
                    self.driver.strict_smoke(&previous).await
                }
                .await;
                match rollback {
                    Ok(smoke) => {
                        state.current_release = Some(previous.clone());
                        state.current_target = Some(previous_target.clone());
                        ExecutionOutcome {
                            state: OperationState::RolledBack,
                            result: Some(json!({
                                "restoredRelease": previous,
                                "strictSmoke": smoke,
                            })),
                            error_code: Some("release_verification_failed".into()),
                            error_message: Some(primary_error.to_string()),
                        }
                    }
                    Err(rollback_error) => {
                        state.current_release = Some(release.clone());
                        state.current_target = Some(target.clone());
                        ExecutionOutcome {
                            state: OperationState::RollbackFailed,
                            result: None,
                            error_code: Some("automatic_rollback_failed".into()),
                            error_message: Some(format!(
                                "release failed: {primary_error}; rollback failed: {rollback_error}"
                            )),
                        }
                    }
                }
            }
        }
    }

    async fn rollback_to_previous(&self, state: &mut ExecutionState) -> ExecutionOutcome {
        let Some(target) = state.previous_release.clone() else {
            return ExecutionOutcome::failed(
                "previous_release_unavailable",
                "no persisted previous release is available for rollback",
            );
        };
        let Some(target_config) = state.previous_target.clone() else {
            return ExecutionOutcome::failed(
                "previous_target_unavailable",
                "no persisted previous DeploymentTarget is available for rollback",
            );
        };
        if !target.has_immutable_images() {
            return ExecutionOutcome::failed(
                "mutable_release_image",
                "the persisted rollback release is not digest-pinned",
            );
        }
        let current = state.current_release.clone();
        let current_target = state.current_target.clone();
        let activation = async {
            self.driver
                .activate_release(&target, &target_config)
                .await?;
            self.driver.strict_smoke(&target).await
        }
        .await;
        match activation {
            Ok(smoke) => {
                state.current_release = Some(target.clone());
                state.current_target = Some(target_config.clone());
                state.previous_release = current;
                state.previous_target = current_target;
                ExecutionOutcome::succeeded(json!({
                    "release": target,
                    "strictSmoke": smoke,
                }))
            }
            Err(primary_error) => {
                let recovery = async {
                    let current = current.as_ref().ok_or_else(|| {
                        DriverError::Readiness(
                            "current release is unavailable for rollback recovery".into(),
                        )
                    })?;
                    let current_target = current_target.as_ref().ok_or_else(|| {
                        DriverError::Readiness(
                            "current DeploymentTarget is unavailable for rollback recovery".into(),
                        )
                    })?;
                    self.driver
                        .activate_release(current, current_target)
                        .await?;
                    self.driver.strict_smoke(current).await
                }
                .await;
                match recovery {
                    Ok(_) => ExecutionOutcome {
                        state: OperationState::RollbackFailed,
                        result: None,
                        error_code: Some("manual_rollback_failed".into()),
                        error_message: Some(format!(
                            "rollback target failed verification and the current release was restored: {primary_error}"
                        )),
                    },
                    Err(recovery_error) => ExecutionOutcome {
                        state: OperationState::RollbackFailed,
                        result: None,
                        error_code: Some("manual_rollback_recovery_failed".into()),
                        error_message: Some(format!(
                            "rollback failed: {primary_error}; restoring the current release failed: {recovery_error}"
                        )),
                    },
                }
            }
        }
    }
}

fn driver_failure(error: DriverError) -> ExecutionOutcome {
    ExecutionOutcome::failed("platform_operation_failed", error.to_string())
}
