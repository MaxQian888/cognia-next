use crate::model::*;
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use cognia_deployment::{DeploymentTarget, DeploymentTopology, OperationKind, OperationState};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use parking_lot::Mutex;
use rustls::{ClientConfig, RootCertStore};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tokio_postgres::{Config, Row};
use tokio_postgres_rustls::MakeRustlsConnect;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("record not found")]
    NotFound,
    #[error("operation conflicts with an active destructive operation")]
    TargetBusy,
    #[error("invalid operation transition")]
    InvalidTransition,
    #[error("idempotency key was already used for a different mutation")]
    IdempotencyConflict,
    #[error("admin lease is missing, expired, consumed, or does not match the operation")]
    AdminLeaseInvalid,
    #[error("database error: {0}")]
    Database(String),
}

#[async_trait]
pub trait Store: Send + Sync {
    async fn register_target(
        &self,
        tenant_id: &str,
        target: DeploymentTarget,
        idempotency_key: &str,
    ) -> Result<ServerDetail, StoreError>;
    async fn list_servers(&self, tenant_id: &str) -> Result<Vec<ServerSummary>, StoreError>;
    async fn get_server(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<Option<ServerDetail>, StoreError>;
    async fn get_deployment_target(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<Option<DeploymentTarget>, StoreError>;
    async fn list_logs(
        &self,
        tenant_id: &str,
        target_id: &str,
        limit: usize,
    ) -> Result<Vec<LogEntry>, StoreError>;
    async fn list_backups(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<Vec<RecoveryPoint>, StoreError>;
    async fn create_operation(&self, input: NewOperation) -> Result<Operation, StoreError>;
    async fn operation_by_idempotency(
        &self,
        tenant_id: &str,
        idempotency_key: &str,
    ) -> Result<Option<Operation>, StoreError>;
    async fn get_operation(
        &self,
        tenant_id: &str,
        id: Uuid,
    ) -> Result<Option<Operation>, StoreError>;
    async fn events_after(
        &self,
        tenant_id: &str,
        event_id: i64,
    ) -> Result<Vec<OperationEvent>, StoreError>;
    async fn create_admin_lease(
        &self,
        tenant_id: &str,
        subject: &str,
        target_id: &str,
        operation: OperationKind,
        ttl: Duration,
    ) -> Result<AdminLease, StoreError>;
    async fn validate_admin_lease(
        &self,
        tenant_id: &str,
        subject: &str,
        target_id: &str,
        operation: OperationKind,
        token: &str,
    ) -> Result<bool, StoreError>;
    async fn create_enrollment_token(
        &self,
        tenant_id: &str,
        target_id: &str,
        created_by: &str,
        ttl: Duration,
    ) -> Result<EnrollmentToken, StoreError>;
    async fn consume_enrollment(&self, token: &str) -> Result<EnrollmentGrant, StoreError>;
    async fn register_agent(
        &self,
        grant: &EnrollmentGrant,
        agent_id: &str,
        certificate_fingerprint: &str,
        certificate_expires_at: DateTime<Utc>,
    ) -> Result<(), StoreError>;
    async fn authenticate_agent(
        &self,
        agent_id: &str,
        target_id: &str,
        certificate_fingerprint: &str,
    ) -> Result<Option<AgentIdentity>, StoreError>;
    async fn record_agent_heartbeat(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<(), StoreError>;
    async fn claim_operation_for_target(
        &self,
        tenant_id: &str,
        target_id: &str,
        worker_id: &str,
        lease_seconds: i64,
    ) -> Result<Option<Operation>, StoreError>;
    async fn heartbeat_operation(
        &self,
        operation_id: Uuid,
        worker_id: &str,
        lease_seconds: i64,
    ) -> Result<bool, StoreError>;
    async fn transition_operation(
        &self,
        operation_id: Uuid,
        worker_id: &str,
        next: OperationState,
        result: Option<Value>,
        error: Option<OpsErrorBody>,
    ) -> Result<Operation, StoreError>;
}

#[derive(Default)]
struct MemoryData {
    servers: HashMap<(String, String), ServerDetail>,
    targets: HashMap<(String, String), DeploymentTarget>,
    operations: HashMap<Uuid, Operation>,
    idempotency: HashMap<(String, String), Uuid>,
    events: Vec<TenantOperationEvent>,
    leases: HashMap<String, MemoryLease>,
    enrollment_tokens: HashMap<String, MemoryEnrollment>,
    agents: HashMap<String, AgentIdentity>,
    target_registrations: HashMap<(String, String), (Value, ServerDetail)>,
    recovery_points: Vec<(String, RecoveryPoint)>,
    logs: Vec<(String, LogEntry)>,
    next_log_id: i64,
}

struct MemoryLease {
    tenant_id: String,
    subject: String,
    target_id: String,
    operation: OperationKind,
    expires_at: DateTime<Utc>,
}

struct MemoryEnrollment {
    tenant_id: String,
    target_id: String,
    expires_at: DateTime<Utc>,
}

#[derive(Default)]
pub struct InMemoryStore {
    inner: Mutex<MemoryData>,
}

#[async_trait]
impl Store for InMemoryStore {
    async fn register_target(
        &self,
        tenant_id: &str,
        target: DeploymentTarget,
        idempotency_key: &str,
    ) -> Result<ServerDetail, StoreError> {
        let config = serde_json::to_value(&target)
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let key = (tenant_id.to_owned(), idempotency_key.to_owned());
        let mut data = self.inner.lock();
        if let Some((registered_config, detail)) = data.target_registrations.get(&key) {
            return if registered_config == &config {
                Ok(detail.clone())
            } else {
                Err(StoreError::IdempotencyConflict)
            };
        }
        let target_key = (tenant_id.to_owned(), target.metadata.id.clone());
        let revision = data
            .servers
            .get(&target_key)
            .map_or(1, |detail| detail.target_revision + 1);
        let detail = target_detail(&target, revision);
        data.servers.insert(target_key.clone(), detail.clone());
        data.targets.insert(target_key, target);
        data.target_registrations
            .insert(key, (config, detail.clone()));
        Ok(detail)
    }

    async fn list_servers(&self, tenant_id: &str) -> Result<Vec<ServerSummary>, StoreError> {
        Ok(self
            .inner
            .lock()
            .servers
            .iter()
            .filter(|((tenant, _), _)| tenant == tenant_id)
            .map(|(_, detail)| detail.summary.clone())
            .collect())
    }

    async fn get_server(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<Option<ServerDetail>, StoreError> {
        Ok(self
            .inner
            .lock()
            .servers
            .get(&(tenant_id.into(), target_id.into()))
            .cloned())
    }

    async fn get_deployment_target(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<Option<DeploymentTarget>, StoreError> {
        Ok(self
            .inner
            .lock()
            .targets
            .get(&(tenant_id.into(), target_id.into()))
            .cloned())
    }

    async fn list_logs(
        &self,
        tenant_id: &str,
        target_id: &str,
        limit: usize,
    ) -> Result<Vec<LogEntry>, StoreError> {
        let data = self.inner.lock();
        Ok(data
            .logs
            .iter()
            .rev()
            .filter(|(tenant, entry)| tenant == tenant_id && entry.server_id == target_id)
            .take(limit.min(1000))
            .map(|(_, entry)| entry.clone())
            .collect())
    }

    async fn list_backups(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<Vec<RecoveryPoint>, StoreError> {
        Ok(self
            .inner
            .lock()
            .recovery_points
            .iter()
            .filter(|(tenant, point)| tenant == tenant_id && point.server_id == target_id)
            .map(|(_, point)| point.clone())
            .collect())
    }

    async fn create_operation(&self, input: NewOperation) -> Result<Operation, StoreError> {
        let mut data = self.inner.lock();
        let key = (input.tenant_id.clone(), input.idempotency_key);
        if let Some(id) = data.idempotency.get(&key) {
            return data.operations.get(id).cloned().ok_or(StoreError::NotFound);
        }
        if input.kind.requires_admin_lease() {
            let token = input
                .admin_lease
                .as_deref()
                .ok_or(StoreError::AdminLeaseInvalid)?;
            let lease = data
                .leases
                .remove(&hash_token(token))
                .ok_or(StoreError::AdminLeaseInvalid)?;
            if lease.tenant_id != input.tenant_id
                || lease.subject != input.created_by
                || lease.target_id != input.target_id
                || lease.operation != input.kind
                || lease.expires_at <= Utc::now()
            {
                return Err(StoreError::AdminLeaseInvalid);
            }
        }
        let now = Utc::now();
        let operation = Operation {
            id: Uuid::new_v4(),
            tenant_id: input.tenant_id.clone(),
            target_id: input.target_id,
            kind: input.kind,
            state: OperationState::Queued,
            request: input.request,
            result: None,
            error: None,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
        };
        data.idempotency.insert(key, operation.id);
        let event_id = data.events.len() as i64 + 1;
        data.events.push(TenantOperationEvent {
            tenant_id: operation.tenant_id.clone(),
            event: OperationEvent {
                id: event_id,
                operation_id: operation.id,
                target_id: operation.target_id.clone(),
                state: operation.state,
                timestamp: now,
                message: "operation queued".into(),
            },
        });
        data.operations.insert(operation.id, operation.clone());
        Ok(operation)
    }

    async fn operation_by_idempotency(
        &self,
        tenant_id: &str,
        idempotency_key: &str,
    ) -> Result<Option<Operation>, StoreError> {
        let data = self.inner.lock();
        Ok(data
            .idempotency
            .get(&(tenant_id.into(), idempotency_key.into()))
            .and_then(|id| data.operations.get(id))
            .cloned())
    }

    async fn get_operation(
        &self,
        tenant_id: &str,
        id: Uuid,
    ) -> Result<Option<Operation>, StoreError> {
        Ok(self
            .inner
            .lock()
            .operations
            .get(&id)
            .filter(|operation| operation.tenant_id == tenant_id)
            .cloned())
    }

    async fn events_after(
        &self,
        tenant_id: &str,
        event_id: i64,
    ) -> Result<Vec<OperationEvent>, StoreError> {
        Ok(self
            .inner
            .lock()
            .events
            .iter()
            .filter(|item| item.tenant_id == tenant_id && item.event.id > event_id)
            .map(|item| item.event.clone())
            .collect())
    }

    async fn create_admin_lease(
        &self,
        tenant_id: &str,
        subject: &str,
        target_id: &str,
        operation: OperationKind,
        ttl: Duration,
    ) -> Result<AdminLease, StoreError> {
        let token = Uuid::new_v4().to_string();
        let expires_at = Utc::now() + ttl;
        self.inner.lock().leases.insert(
            hash_token(&token),
            MemoryLease {
                tenant_id: tenant_id.into(),
                subject: subject.into(),
                target_id: target_id.into(),
                operation,
                expires_at,
            },
        );
        Ok(AdminLease { token, expires_at })
    }

    async fn validate_admin_lease(
        &self,
        tenant_id: &str,
        subject: &str,
        target_id: &str,
        operation: OperationKind,
        token: &str,
    ) -> Result<bool, StoreError> {
        Ok(self
            .inner
            .lock()
            .leases
            .get(&hash_token(token))
            .is_some_and(|lease| {
                lease.tenant_id == tenant_id
                    && lease.subject == subject
                    && lease.target_id == target_id
                    && lease.operation == operation
                    && lease.expires_at > Utc::now()
            }))
    }

    async fn create_enrollment_token(
        &self,
        tenant_id: &str,
        target_id: &str,
        _created_by: &str,
        ttl: Duration,
    ) -> Result<EnrollmentToken, StoreError> {
        let token = Uuid::new_v4().to_string();
        let expires_at = Utc::now() + ttl;
        self.inner.lock().enrollment_tokens.insert(
            hash_token(&token),
            MemoryEnrollment {
                tenant_id: tenant_id.into(),
                target_id: target_id.into(),
                expires_at,
            },
        );
        Ok(EnrollmentToken { token, expires_at })
    }

    async fn consume_enrollment(&self, token: &str) -> Result<EnrollmentGrant, StoreError> {
        let enrollment = self
            .inner
            .lock()
            .enrollment_tokens
            .remove(&hash_token(token))
            .filter(|enrollment| enrollment.expires_at > Utc::now())
            .ok_or(StoreError::NotFound)?;
        Ok(EnrollmentGrant {
            tenant_id: enrollment.tenant_id,
            target_id: enrollment.target_id,
        })
    }

    async fn register_agent(
        &self,
        grant: &EnrollmentGrant,
        agent_id: &str,
        certificate_fingerprint: &str,
        _certificate_expires_at: DateTime<Utc>,
    ) -> Result<(), StoreError> {
        let mut data = self.inner.lock();
        let identity = AgentIdentity {
            tenant_id: grant.tenant_id.clone(),
            target_id: grant.target_id.clone(),
            agent_id: agent_id.into(),
        };
        data.agents.insert(certificate_fingerprint.into(), identity);
        Ok(())
    }

    async fn authenticate_agent(
        &self,
        agent_id: &str,
        target_id: &str,
        certificate_fingerprint: &str,
    ) -> Result<Option<AgentIdentity>, StoreError> {
        Ok(self
            .inner
            .lock()
            .agents
            .get(certificate_fingerprint)
            .filter(|identity| identity.agent_id == agent_id && identity.target_id == target_id)
            .cloned())
    }

    async fn record_agent_heartbeat(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<(), StoreError> {
        let mut data = self.inner.lock();
        let server = data
            .servers
            .get_mut(&(tenant_id.into(), target_id.into()))
            .ok_or(StoreError::NotFound)?;
        server.summary.health = ServerHealth::Healthy;
        server.summary.last_seen_at = Some(Utc::now());
        Ok(())
    }

    async fn claim_operation_for_target(
        &self,
        tenant_id: &str,
        target_id: &str,
        worker_id: &str,
        _lease_seconds: i64,
    ) -> Result<Option<Operation>, StoreError> {
        let mut data = self.inner.lock();
        let id = data
            .operations
            .iter()
            .find(|(_, operation)| {
                operation.tenant_id == tenant_id
                    && operation.target_id == target_id
                    && operation.state == OperationState::Queued
            })
            .map(|(id, _)| *id);
        let Some(id) = id else { return Ok(None) };
        let operation = data.operations.get_mut(&id).ok_or(StoreError::NotFound)?;
        operation.state = OperationState::Validating;
        operation.updated_at = Utc::now();
        let _ = worker_id;
        Ok(Some(operation.clone()))
    }

    async fn heartbeat_operation(
        &self,
        operation_id: Uuid,
        _worker_id: &str,
        _lease_seconds: i64,
    ) -> Result<bool, StoreError> {
        Ok(self.inner.lock().operations.contains_key(&operation_id))
    }

    async fn transition_operation(
        &self,
        operation_id: Uuid,
        _worker_id: &str,
        next: OperationState,
        result: Option<Value>,
        error: Option<OpsErrorBody>,
    ) -> Result<Operation, StoreError> {
        let mut data = self.inner.lock();
        let operation = data
            .operations
            .get_mut(&operation_id)
            .ok_or(StoreError::NotFound)?;
        if !operation.state.can_transition_to(next) {
            return Err(StoreError::InvalidTransition);
        }
        operation.state = next;
        operation.result = result;
        operation.error = error;
        operation.updated_at = Utc::now();
        let operation = operation.clone();
        if next == OperationState::Succeeded {
            materialize_memory_result(&mut data, &operation)?;
        }
        Ok(operation)
    }
}

pub struct PgStore {
    pool: Pool,
}

impl PgStore {
    pub async fn connect(database_url: &str, max_connections: usize) -> anyhow::Result<Self> {
        let config: Config = database_url.parse()?;
        let native_certificates = rustls_native_certs::load_native_certs();
        if !native_certificates.errors.is_empty() {
            tracing::warn!(
                errors = ?native_certificates.errors,
                "some native root certificates could not be loaded"
            );
        }
        let mut root_store = RootCertStore::empty();
        for certificate in native_certificates.certs {
            root_store.add(certificate)?;
        }
        let tls = MakeRustlsConnect::new(
            ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth(),
        );
        let manager = Manager::from_config(
            config,
            tls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(max_connections)
            .build()
            .map_err(|error| anyhow::anyhow!(error))?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> anyhow::Result<()> {
        let client = self.pool.get().await?;
        client
            .batch_execute(include_str!("../migrations/0001_init.sql"))
            .await?;
        Ok(())
    }

    async fn claim_for_target(
        &self,
        tenant_id: &str,
        target_id: &str,
        worker_id: &str,
        lease_seconds: i64,
    ) -> Result<Option<Operation>, StoreError> {
        self.requeue_expired_leases().await?;
        let client = self.client().await?;
        let row = client
            .query_opt(
                "WITH candidate AS (
                   SELECT o.id, o.tenant_id, o.target_id FROM operations o
                   WHERE o.state='queued' AND o.tenant_id=$3 AND o.target_id=$4
                   ORDER BY o.created_at
                   FOR UPDATE SKIP LOCKED LIMIT 1
                 ), acquired AS (
                   INSERT INTO target_operation_locks
                     (tenant_id, target_id, operation_id, lease_owner, lease_expires_at)
                   SELECT tenant_id, target_id, id, $1, now() + make_interval(secs => $2)
                   FROM candidate
                   ON CONFLICT (tenant_id, target_id) DO UPDATE SET
                     operation_id=EXCLUDED.operation_id,
                     lease_owner=EXCLUDED.lease_owner,
                     lease_expires_at=EXCLUDED.lease_expires_at
                   WHERE target_operation_locks.lease_expires_at <= now()
                   RETURNING tenant_id, target_id, operation_id
                 )
                 UPDATE operations o SET state='validating', lease_owner=$1,
                   lease_expires_at=now() + make_interval(secs => $2), updated_at=now()
                 FROM acquired a WHERE o.id=a.operation_id RETURNING o.*",
                &[&worker_id, &lease_seconds, &tenant_id, &target_id],
            )
            .await
            .map_err(database_error)?;
        let Some(row) = row else {
            return Ok(None);
        };
        operation_from_row(&row).map(Some)
    }

    async fn heartbeat(
        &self,
        operation_id: Uuid,
        worker_id: &str,
        lease_seconds: i64,
    ) -> Result<bool, StoreError> {
        let mut client = self.client().await?;
        let transaction = client.transaction().await.map_err(database_error)?;
        let changed = transaction
            .execute(
                "UPDATE operations SET lease_expires_at=now() + make_interval(secs => $3), updated_at=now()
                 WHERE id=$1 AND lease_owner=$2 AND lease_expires_at > now()",
                &[&operation_id, &worker_id, &lease_seconds],
            )
            .await
            .map_err(database_error)?;
        if changed == 1 {
            transaction
                .execute(
                    "UPDATE target_operation_locks SET
                     lease_expires_at=now() + make_interval(secs => $3)
                     WHERE operation_id=$1 AND lease_owner=$2 AND lease_expires_at>now()",
                    &[&operation_id, &worker_id, &lease_seconds],
                )
                .await
                .map_err(database_error)?;
        }
        transaction.commit().await.map_err(database_error)?;
        Ok(changed == 1)
    }

    pub async fn requeue_expired_leases(&self) -> Result<u64, StoreError> {
        let mut client = self.client().await?;
        let transaction = client.transaction().await.map_err(database_error)?;
        let changed = transaction
            .execute(
                "UPDATE operations SET state='queued', lease_owner=NULL,
                 lease_expires_at=NULL, updated_at=now()
                 WHERE state IN ('validating','preparing','executing','verifying')
                   AND lease_expires_at <= now()",
                &[],
            )
            .await
            .map_err(database_error)?;
        transaction
            .execute(
                "DELETE FROM target_operation_locks WHERE lease_expires_at <= now()",
                &[],
            )
            .await
            .map_err(database_error)?;
        transaction.commit().await.map_err(database_error)?;
        Ok(changed)
    }

    async fn transition_claimed_operation(
        &self,
        operation_id: Uuid,
        worker_id: &str,
        next: OperationState,
        result: Option<Value>,
        error: Option<OpsErrorBody>,
    ) -> Result<Operation, StoreError> {
        let mut client = self.client().await?;
        let transaction = client.transaction().await.map_err(database_error)?;
        let row = transaction
            .query_opt(
                "SELECT * FROM operations WHERE id=$1 AND lease_owner=$2
                 AND lease_expires_at>now() FOR UPDATE",
                &[&operation_id, &worker_id],
            )
            .await
            .map_err(database_error)?
            .ok_or(StoreError::NotFound)?;
        let current = operation_from_row(&row)?;
        if !current.state.can_transition_to(next) {
            return Err(StoreError::InvalidTransition);
        }
        let recovery_points = if next == OperationState::Succeeded {
            recovery_points_from_result(&current, result.as_ref())?
        } else {
            Vec::new()
        };
        let release_digest = if next == OperationState::Succeeded {
            release_digest_from_result(&current, result.as_ref())
        } else {
            None
        };
        let log_lines = if next == OperationState::Succeeded {
            log_lines_from_result(&current, result.as_ref())?
        } else {
            Vec::new()
        };
        let next_value = operation_state_string(next);
        let error_value = error
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let row = transaction
            .query_one(
                "UPDATE operations SET state=$3, result=$4, error=$5, updated_at=now(),
                   lease_owner=CASE WHEN $6 THEN NULL ELSE lease_owner END,
                   lease_expires_at=CASE WHEN $6 THEN NULL ELSE lease_expires_at END
                 WHERE id=$1 AND lease_owner=$2 RETURNING *",
                &[
                    &operation_id,
                    &worker_id,
                    &next_value,
                    &result,
                    &error_value,
                    &next.is_terminal(),
                ],
            )
            .await
            .map_err(database_error)?;
        if next.is_terminal() {
            transaction
                .execute(
                    "DELETE FROM target_operation_locks WHERE operation_id=$1 AND lease_owner=$2",
                    &[&operation_id, &worker_id],
                )
                .await
                .map_err(database_error)?;
        }
        if next == OperationState::Succeeded {
            transaction
                .execute(
                    "UPDATE server_reports SET health='healthy', last_seen_at=now(),
                       release_digest=COALESCE($3, release_digest)
                     WHERE tenant_id=$1 AND id=$2",
                    &[&current.tenant_id, &current.target_id, &release_digest],
                )
                .await
                .map_err(database_error)?;
            for point in recovery_points {
                let kind = serde_json::to_value(point.kind)
                    .map_err(|error| StoreError::Database(error.to_string()))?
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                transaction
                    .execute(
                        "INSERT INTO recovery_points
                           (tenant_id, target_id, id, kind, manifest_sha256, size_bytes, verified, created_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                         ON CONFLICT (tenant_id, target_id, id) DO UPDATE SET
                           kind=EXCLUDED.kind,
                           manifest_sha256=EXCLUDED.manifest_sha256,
                           size_bytes=EXCLUDED.size_bytes,
                           verified=EXCLUDED.verified,
                           created_at=EXCLUDED.created_at",
                        &[
                            &current.tenant_id,
                            &current.target_id,
                            &point.id,
                            &kind,
                            &point.manifest_sha256,
                            &point.size_bytes,
                            &point.verified,
                            &point.created_at,
                        ],
                    )
                    .await
                    .map_err(database_error)?;
            }
            for line in log_lines {
                transaction
                    .execute(
                        "INSERT INTO log_entries
                           (tenant_id, target_id, timestamp, level, component, message)
                         VALUES ($1,$2,now(),'info','cognia-server',$3)",
                        &[&current.tenant_id, &current.target_id, &line],
                    )
                    .await
                    .map_err(database_error)?;
            }
        }
        transaction.commit().await.map_err(database_error)?;
        operation_from_row(&row)
    }

    async fn client(&self) -> Result<deadpool_postgres::Client, StoreError> {
        self.pool
            .get()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))
    }
}

#[async_trait]
impl Store for PgStore {
    async fn register_target(
        &self,
        tenant_id: &str,
        target: DeploymentTarget,
        idempotency_key: &str,
    ) -> Result<ServerDetail, StoreError> {
        let config = serde_json::to_value(&target)
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let request_hash = hex::encode(Sha256::digest(config.to_string().as_bytes()));
        let mut client = self.client().await?;
        let transaction = client.transaction().await.map_err(database_error)?;
        transaction
            .query_one(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&format!("{tenant_id}:{idempotency_key}")],
            )
            .await
            .map_err(database_error)?;
        if let Some(row) = transaction
            .query_opt(
                "SELECT request_hash, target_id FROM target_registrations
                 WHERE tenant_id=$1 AND idempotency_key=$2",
                &[&tenant_id, &idempotency_key],
            )
            .await
            .map_err(database_error)?
        {
            let stored_hash: String = row.get("request_hash");
            if stored_hash != request_hash {
                return Err(StoreError::IdempotencyConflict);
            }
            let target_id: String = row.get("target_id");
            let row = transaction
                .query_one(
                    "SELECT r.*, t.revision, t.production_certified, t.certification_issues
                     FROM server_reports r JOIN deployment_targets t
                       ON t.tenant_id=r.tenant_id AND t.id=r.id
                     WHERE r.tenant_id=$1 AND r.id=$2",
                    &[&tenant_id, &target_id],
                )
                .await
                .map_err(database_error)?;
            return server_detail_from_row(&row);
        }

        let issues = target
            .production_certification_issues()
            .into_iter()
            .map(|issue| format!("{issue:?}"))
            .collect::<Vec<_>>();
        let production_certified = issues.is_empty();
        let topology = topology_name(target.spec.topology);
        let public_url = target.spec.public_url.to_string();
        let target_id = target.metadata.id.clone();
        let label = target.metadata.label.clone();
        transaction
            .query_one(
                "INSERT INTO deployment_targets
                   (tenant_id, id, label, config, revision, production_certified, certification_issues)
                 VALUES ($1, $2, $3, $4, 1, $5, $6)
                 ON CONFLICT (tenant_id, id) DO UPDATE SET
                   label=EXCLUDED.label, config=EXCLUDED.config,
                   revision=deployment_targets.revision + 1,
                   production_certified=EXCLUDED.production_certified,
                   certification_issues=EXCLUDED.certification_issues, updated_at=now()
                 RETURNING revision",
                &[
                    &tenant_id,
                    &target_id,
                    &label,
                    &config,
                    &production_certified,
                    &issues,
                ],
            )
            .await
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO server_reports
                   (tenant_id, id, label, topology, public_url, health)
                 VALUES ($1, $2, $3, $4, $5, 'unknown')
                 ON CONFLICT (tenant_id, id) DO UPDATE SET
                   label=EXCLUDED.label, topology=EXCLUDED.topology, public_url=EXCLUDED.public_url",
                &[&tenant_id, &target_id, &label, &topology, &public_url],
            )
            .await
            .map_err(database_error)?;
        transaction
            .execute(
                "INSERT INTO target_registrations
                   (tenant_id, idempotency_key, request_hash, target_id)
                 VALUES ($1, $2, $3, $4)",
                &[&tenant_id, &idempotency_key, &request_hash, &target_id],
            )
            .await
            .map_err(database_error)?;
        let row = transaction
            .query_one(
                "SELECT r.*, t.revision, t.production_certified, t.certification_issues
                 FROM server_reports r JOIN deployment_targets t
                   ON t.tenant_id=r.tenant_id AND t.id=r.id
                 WHERE r.tenant_id=$1 AND r.id=$2",
                &[&tenant_id, &target_id],
            )
            .await
            .map_err(database_error)?;
        let detail = server_detail_from_row(&row)?;
        transaction.commit().await.map_err(database_error)?;
        Ok(detail)
    }

    async fn list_servers(&self, tenant_id: &str) -> Result<Vec<ServerSummary>, StoreError> {
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT id, label, topology, public_url, health, release_digest, last_seen_at
                 FROM server_reports WHERE tenant_id=$1 ORDER BY label",
                &[&tenant_id],
            )
            .await
            .map_err(database_error)?;
        rows.iter().map(server_from_row).collect()
    }

    async fn get_server(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<Option<ServerDetail>, StoreError> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                "SELECT r.*, t.revision, t.production_certified, t.certification_issues
                 FROM server_reports r JOIN deployment_targets t
                   ON t.tenant_id=r.tenant_id AND t.id=r.id
                 WHERE r.tenant_id=$1 AND r.id=$2",
                &[&tenant_id, &target_id],
            )
            .await
            .map_err(database_error)?;
        row.map(|row| server_detail_from_row(&row)).transpose()
    }

    async fn get_deployment_target(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<Option<DeploymentTarget>, StoreError> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                "SELECT config FROM deployment_targets WHERE tenant_id=$1 AND id=$2",
                &[&tenant_id, &target_id],
            )
            .await
            .map_err(database_error)?;
        row.map(|row| {
            serde_json::from_value(row.get("config"))
                .map_err(|error| StoreError::Database(error.to_string()))
        })
        .transpose()
    }

    async fn list_logs(
        &self,
        tenant_id: &str,
        target_id: &str,
        limit: usize,
    ) -> Result<Vec<LogEntry>, StoreError> {
        let client = self.client().await?;
        let limit = i64::try_from(limit.min(1000)).unwrap_or(1000);
        let rows = client
            .query(
                "SELECT id, target_id, timestamp, level, component, message FROM log_entries
                 WHERE tenant_id=$1 AND target_id=$2 ORDER BY id DESC LIMIT $3",
                &[&tenant_id, &target_id, &limit],
            )
            .await
            .map_err(database_error)?;
        Ok(rows
            .iter()
            .map(|row| LogEntry {
                id: row.get("id"),
                server_id: row.get("target_id"),
                timestamp: row.get("timestamp"),
                level: row.get("level"),
                component: row.get("component"),
                message: row.get("message"),
            })
            .collect())
    }

    async fn list_backups(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<Vec<RecoveryPoint>, StoreError> {
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT id, target_id, created_at, kind, manifest_sha256, size_bytes, verified
                 FROM recovery_points WHERE tenant_id=$1 AND target_id=$2 ORDER BY created_at DESC",
                &[&tenant_id, &target_id],
            )
            .await
            .map_err(database_error)?;
        rows.iter().map(recovery_point_from_row).collect()
    }

    async fn create_operation(&self, input: NewOperation) -> Result<Operation, StoreError> {
        let mut client = self.client().await?;
        let transaction = client.transaction().await.map_err(database_error)?;
        let kind = serde_json::to_value(input.kind)
            .map_err(|error| StoreError::Database(error.to_string()))?
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let id = Uuid::new_v4();
        let row = transaction
            .query_one(
                "INSERT INTO operations
                   (id, tenant_id, target_id, kind, state, request, created_by, idempotency_key)
                 VALUES ($1,$2,$3,$4,'queued',$5,$6,$7)
                 ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
                   SET idempotency_key=EXCLUDED.idempotency_key
                 RETURNING *, (xmax = 0) AS inserted",
                &[
                    &id,
                    &input.tenant_id,
                    &input.target_id,
                    &kind,
                    &input.request,
                    &input.created_by,
                    &input.idempotency_key,
                ],
            )
            .await
            .map_err(database_error)?;
        let inserted: bool = row.get("inserted");
        let operation = operation_from_row(&row)?;
        if operation.target_id != input.target_id
            || operation.kind != input.kind
            || operation.request != input.request
        {
            return Err(StoreError::IdempotencyConflict);
        }
        if inserted && input.kind.requires_admin_lease() {
            let token = input
                .admin_lease
                .as_deref()
                .ok_or(StoreError::AdminLeaseInvalid)?;
            let changed = transaction
                .execute(
                    "UPDATE admin_leases SET consumed_at=now()
                     WHERE token_hash=$1 AND tenant_id=$2 AND subject=$3 AND target_id=$4
                       AND operation=$5 AND expires_at>now() AND consumed_at IS NULL",
                    &[
                        &hash_token(token),
                        &input.tenant_id,
                        &input.created_by,
                        &input.target_id,
                        &kind,
                    ],
                )
                .await
                .map_err(database_error)?;
            if changed != 1 {
                return Err(StoreError::AdminLeaseInvalid);
            }
        }
        transaction.commit().await.map_err(database_error)?;
        Ok(operation)
    }

    async fn operation_by_idempotency(
        &self,
        tenant_id: &str,
        idempotency_key: &str,
    ) -> Result<Option<Operation>, StoreError> {
        let client = self.client().await?;
        client
            .query_opt(
                "SELECT * FROM operations WHERE tenant_id=$1 AND idempotency_key=$2",
                &[&tenant_id, &idempotency_key],
            )
            .await
            .map_err(database_error)?
            .map(|row| operation_from_row(&row))
            .transpose()
    }

    async fn get_operation(
        &self,
        tenant_id: &str,
        id: Uuid,
    ) -> Result<Option<Operation>, StoreError> {
        let client = self.client().await?;
        client
            .query_opt(
                "SELECT * FROM operations WHERE tenant_id=$1 AND id=$2",
                &[&tenant_id, &id],
            )
            .await
            .map_err(database_error)?
            .map(|row| operation_from_row(&row))
            .transpose()
    }

    async fn events_after(
        &self,
        tenant_id: &str,
        event_id: i64,
    ) -> Result<Vec<OperationEvent>, StoreError> {
        let client = self.client().await?;
        let rows = client
            .query(
                "SELECT id, operation_id, target_id, state, created_at, message
                 FROM operation_events WHERE tenant_id=$1 AND id>$2 ORDER BY id LIMIT 1000",
                &[&tenant_id, &event_id],
            )
            .await
            .map_err(database_error)?;
        rows.iter().map(event_from_row).collect()
    }

    async fn create_admin_lease(
        &self,
        tenant_id: &str,
        subject: &str,
        target_id: &str,
        operation: OperationKind,
        ttl: Duration,
    ) -> Result<AdminLease, StoreError> {
        let client = self.client().await?;
        let token = Uuid::new_v4().to_string();
        let token_hash = hash_token(&token);
        let expires_at = Utc::now() + ttl;
        let operation = operation_kind_string(operation);
        client
            .execute(
                "INSERT INTO admin_leases
                 (token_hash, tenant_id, subject, target_id, operation, expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6)",
                &[
                    &token_hash,
                    &tenant_id,
                    &subject,
                    &target_id,
                    &operation,
                    &expires_at,
                ],
            )
            .await
            .map_err(database_error)?;
        Ok(AdminLease { token, expires_at })
    }

    async fn validate_admin_lease(
        &self,
        tenant_id: &str,
        subject: &str,
        target_id: &str,
        operation: OperationKind,
        token: &str,
    ) -> Result<bool, StoreError> {
        let client = self.client().await?;
        let operation = operation_kind_string(operation);
        let row = client
            .query_one(
                "SELECT EXISTS(SELECT 1 FROM admin_leases
                 WHERE token_hash=$1 AND tenant_id=$2 AND subject=$3 AND target_id=$4
                   AND operation=$5 AND expires_at>now() AND consumed_at IS NULL)",
                &[
                    &hash_token(token),
                    &tenant_id,
                    &subject,
                    &target_id,
                    &operation,
                ],
            )
            .await
            .map_err(database_error)?;
        Ok(row.get(0))
    }

    async fn create_enrollment_token(
        &self,
        tenant_id: &str,
        target_id: &str,
        created_by: &str,
        ttl: Duration,
    ) -> Result<EnrollmentToken, StoreError> {
        let client = self.client().await?;
        let token = Uuid::new_v4().to_string();
        let token_hash = hash_token(&token);
        let expires_at = Utc::now() + ttl;
        client
            .execute(
                "INSERT INTO agent_enrollment_tokens
                 (token_hash, tenant_id, target_id, created_by, expires_at)
                 VALUES ($1,$2,$3,$4,$5)",
                &[
                    &token_hash,
                    &tenant_id,
                    &target_id,
                    &created_by,
                    &expires_at,
                ],
            )
            .await
            .map_err(database_error)?;
        Ok(EnrollmentToken { token, expires_at })
    }

    async fn consume_enrollment(&self, token: &str) -> Result<EnrollmentGrant, StoreError> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                "UPDATE agent_enrollment_tokens SET consumed_at=now()
                 WHERE token_hash=$1 AND expires_at>now() AND consumed_at IS NULL
                 RETURNING tenant_id, target_id",
                &[&hash_token(token)],
            )
            .await
            .map_err(database_error)?
            .ok_or(StoreError::NotFound)?;
        Ok(EnrollmentGrant {
            tenant_id: row.get("tenant_id"),
            target_id: row.get("target_id"),
        })
    }

    async fn register_agent(
        &self,
        grant: &EnrollmentGrant,
        agent_id: &str,
        certificate_fingerprint: &str,
        certificate_expires_at: DateTime<Utc>,
    ) -> Result<(), StoreError> {
        let client = self.client().await?;
        client
            .execute(
                "INSERT INTO deploy_agents
                 (agent_id, tenant_id, target_id, certificate_fingerprint, certificate_expires_at)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (tenant_id, target_id, agent_id) DO UPDATE SET
                   certificate_fingerprint=EXCLUDED.certificate_fingerprint,
                   certificate_expires_at=EXCLUDED.certificate_expires_at,
                   revoked_at=NULL, updated_at=now()",
                &[
                    &agent_id,
                    &grant.tenant_id,
                    &grant.target_id,
                    &certificate_fingerprint,
                    &certificate_expires_at,
                ],
            )
            .await
            .map_err(database_error)?;
        Ok(())
    }

    async fn authenticate_agent(
        &self,
        agent_id: &str,
        target_id: &str,
        certificate_fingerprint: &str,
    ) -> Result<Option<AgentIdentity>, StoreError> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                "SELECT tenant_id, target_id, agent_id FROM deploy_agents
                 WHERE agent_id=$1 AND target_id=$2 AND certificate_fingerprint=$3
                   AND certificate_expires_at>now() AND revoked_at IS NULL",
                &[&agent_id, &target_id, &certificate_fingerprint],
            )
            .await
            .map_err(database_error)?;
        Ok(row.map(|row| AgentIdentity {
            tenant_id: row.get("tenant_id"),
            target_id: row.get("target_id"),
            agent_id: row.get("agent_id"),
        }))
    }

    async fn record_agent_heartbeat(
        &self,
        tenant_id: &str,
        target_id: &str,
    ) -> Result<(), StoreError> {
        let client = self.client().await?;
        let updated = client
            .execute(
                "UPDATE server_reports SET health='healthy', last_seen_at=now()
                 WHERE tenant_id=$1 AND id=$2",
                &[&tenant_id, &target_id],
            )
            .await
            .map_err(database_error)?;
        if updated == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    async fn claim_operation_for_target(
        &self,
        tenant_id: &str,
        target_id: &str,
        worker_id: &str,
        lease_seconds: i64,
    ) -> Result<Option<Operation>, StoreError> {
        self.claim_for_target(tenant_id, target_id, worker_id, lease_seconds)
            .await
    }

    async fn heartbeat_operation(
        &self,
        operation_id: Uuid,
        worker_id: &str,
        lease_seconds: i64,
    ) -> Result<bool, StoreError> {
        self.heartbeat(operation_id, worker_id, lease_seconds).await
    }

    async fn transition_operation(
        &self,
        operation_id: Uuid,
        worker_id: &str,
        next: OperationState,
        result: Option<Value>,
        error: Option<OpsErrorBody>,
    ) -> Result<Operation, StoreError> {
        self.transition_claimed_operation(operation_id, worker_id, next, result, error)
            .await
    }
}

fn materialize_memory_result(
    data: &mut MemoryData,
    operation: &Operation,
) -> Result<(), StoreError> {
    let points = recovery_points_from_result(operation, operation.result.as_ref())?;
    for point in points {
        data.recovery_points.retain(|(tenant, existing)| {
            tenant != &operation.tenant_id
                || existing.server_id != operation.target_id
                || existing.id != point.id
        });
        data.recovery_points
            .push((operation.tenant_id.clone(), point));
    }
    for line in log_lines_from_result(operation, operation.result.as_ref())? {
        data.next_log_id += 1;
        data.logs.push((
            operation.tenant_id.clone(),
            LogEntry {
                id: data.next_log_id,
                server_id: operation.target_id.clone(),
                timestamp: Utc::now(),
                level: "info".into(),
                component: "cognia-server".into(),
                message: line,
            },
        ));
    }
    if let Some(server) = data
        .servers
        .get_mut(&(operation.tenant_id.clone(), operation.target_id.clone()))
    {
        server.summary.health = ServerHealth::Healthy;
        server.summary.last_seen_at = Some(Utc::now());
        if let Some(release) = release_digest_from_result(operation, operation.result.as_ref()) {
            server.summary.release_digest = Some(release);
        }
    }
    Ok(())
}

fn log_lines_from_result(
    operation: &Operation,
    result: Option<&Value>,
) -> Result<Vec<String>, StoreError> {
    if operation.kind != OperationKind::CollectLogs {
        return Ok(Vec::new());
    }
    let stdout = result
        .and_then(|value| value.get("stdout"))
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Database("collect-logs result omitted stdout".into()))?;
    Ok(stdout
        .lines()
        .take(1000)
        .map(|line| {
            let mut end = line.len().min(64 * 1024);
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            line[..end].to_owned()
        })
        .collect())
}

fn recovery_points_from_result(
    operation: &Operation,
    result: Option<&Value>,
) -> Result<Vec<RecoveryPoint>, StoreError> {
    if operation.kind != OperationKind::Backup {
        return Ok(Vec::new());
    }
    let report: AgentBackupResult = serde_json::from_value(
        result
            .cloned()
            .ok_or_else(|| StoreError::Database("backup result is missing".into()))?,
    )
    .map_err(|error| StoreError::Database(format!("invalid backup result: {error}")))?;
    if report.recovery_points.is_empty() {
        return Err(StoreError::Database(
            "backup result contains no recovery points".into(),
        ));
    }
    report
        .recovery_points
        .into_iter()
        .map(|point| {
            if point.id.is_empty()
                || point.id.len() > 128
                || point.size_bytes < 0
                || point.manifest_sha256.len() != 64
                || !point
                    .manifest_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(StoreError::Database(
                    "backup recovery point failed validation".into(),
                ));
            }
            Ok(RecoveryPoint {
                id: point.id,
                server_id: operation.target_id.clone(),
                created_at: point.created_at,
                kind: point.kind,
                manifest_sha256: point.manifest_sha256,
                size_bytes: point.size_bytes,
                verified: point.verified,
            })
        })
        .collect()
}

fn release_digest_from_result(operation: &Operation, result: Option<&Value>) -> Option<String> {
    if !matches!(
        operation.kind,
        OperationKind::Deploy | OperationKind::Upgrade | OperationKind::Rollback
    ) {
        return None;
    }
    result
        .and_then(|value| value.get("release"))
        .or_else(|| result.and_then(|value| value.get("restoredRelease")))
        .and_then(|release| release.get("serverImage"))
        .and_then(Value::as_str)
        .filter(|image| image.contains("@sha256:"))
        .map(str::to_owned)
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn database_error(error: tokio_postgres::Error) -> StoreError {
    StoreError::Database(error.to_string())
}

fn operation_kind_string(kind: OperationKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn operation_state_string(state: OperationState) -> String {
    serde_json::to_value(state)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn operation_from_row(row: &Row) -> Result<Operation, StoreError> {
    let kind: String = row.get("kind");
    let state: String = row.get("state");
    Ok(Operation {
        id: row.get("id"),
        tenant_id: row.get("tenant_id"),
        target_id: row.get("target_id"),
        kind: serde_json::from_value(Value::String(kind))
            .map_err(|error| StoreError::Database(error.to_string()))?,
        state: serde_json::from_value(Value::String(state))
            .map_err(|error| StoreError::Database(error.to_string()))?,
        request: row.get("request"),
        result: row.get("result"),
        error: row
            .get::<_, Option<Value>>("error")
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| StoreError::Database(error.to_string()))?,
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn server_from_row(row: &Row) -> Result<ServerSummary, StoreError> {
    let health: String = row.get("health");
    Ok(ServerSummary {
        id: row.get("id"),
        label: row.get("label"),
        topology: row.get("topology"),
        public_url: row.get("public_url"),
        health: serde_json::from_value(Value::String(health))
            .map_err(|error| StoreError::Database(error.to_string()))?,
        release_digest: row.get("release_digest"),
        last_seen_at: row.get("last_seen_at"),
    })
}

fn server_detail_from_row(row: &Row) -> Result<ServerDetail, StoreError> {
    Ok(ServerDetail {
        summary: server_from_row(row)?,
        target_revision: row.get("revision"),
        production_certified: row.get("production_certified"),
        certification_issues: row.get("certification_issues"),
        capabilities: ProviderCapabilities::default(),
    })
}

fn topology_name(topology: DeploymentTopology) -> &'static str {
    match topology {
        DeploymentTopology::Compose => "compose",
        DeploymentTopology::Kubernetes => "kubernetes",
    }
}

fn target_detail(target: &DeploymentTarget, revision: i64) -> ServerDetail {
    let certification_issues = target
        .production_certification_issues()
        .into_iter()
        .map(|issue| format!("{issue:?}"))
        .collect::<Vec<_>>();
    ServerDetail {
        summary: ServerSummary {
            id: target.metadata.id.clone(),
            label: target.metadata.label.clone(),
            topology: topology_name(target.spec.topology).into(),
            public_url: target.spec.public_url.to_string(),
            health: ServerHealth::Unknown,
            release_digest: Some(target.spec.images.server.clone()),
            last_seen_at: None,
        },
        target_revision: revision,
        production_certified: certification_issues.is_empty(),
        certification_issues,
        capabilities: ProviderCapabilities::default(),
    }
}

fn recovery_point_from_row(row: &Row) -> Result<RecoveryPoint, StoreError> {
    let kind: String = row.get("kind");
    Ok(RecoveryPoint {
        id: row.get("id"),
        server_id: row.get("target_id"),
        created_at: row.get("created_at"),
        kind: serde_json::from_value(Value::String(kind))
            .map_err(|error| StoreError::Database(error.to_string()))?,
        manifest_sha256: row.get("manifest_sha256"),
        size_bytes: row.get("size_bytes"),
        verified: row.get("verified"),
    })
}

fn event_from_row(row: &Row) -> Result<OperationEvent, StoreError> {
    let state: String = row.get("state");
    Ok(OperationEvent {
        id: row.get("id"),
        operation_id: row.get("operation_id"),
        target_id: row.get("target_id"),
        state: serde_json::from_value(Value::String(state))
            .map_err(|error| StoreError::Database(error.to_string()))?,
        timestamp: row.get("created_at"),
        message: row.get("message"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn successful_backup_results_become_queryable_recovery_points() {
        let store = InMemoryStore::default();
        let operation = store
            .create_operation(NewOperation {
                tenant_id: "tenant-a".into(),
                target_id: "staging".into(),
                kind: OperationKind::Backup,
                request: json!({}),
                created_by: "operator".into(),
                idempotency_key: "backup-1".into(),
                admin_lease: None,
            })
            .await
            .unwrap();
        store
            .claim_operation_for_target("tenant-a", "staging", "agent-1", 60)
            .await
            .unwrap()
            .expect("claimed operation");
        store
            .transition_operation(
                operation.id,
                "agent-1",
                OperationState::Preparing,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .transition_operation(
                operation.id,
                "agent-1",
                OperationState::Executing,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .transition_operation(
                operation.id,
                "agent-1",
                OperationState::Verifying,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .transition_operation(
                operation.id,
                "agent-1",
                OperationState::Succeeded,
                Some(json!({
                    "recoveryPoints": [{
                        "id": "recovery-1",
                        "kind": "object-store",
                        "manifestSha256": "a".repeat(64),
                        "sizeBytes": 4096,
                        "verified": true,
                        "createdAt": "2026-08-01T10:00:00Z"
                    }]
                })),
                None,
            )
            .await
            .unwrap();

        let points = store.list_backups("tenant-a", "staging").await.unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].id, "recovery-1");
        assert!(points[0].verified);
        assert!(store
            .list_backups("tenant-b", "staging")
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn malformed_backup_results_are_never_materialized() {
        let operation = Operation {
            id: Uuid::new_v4(),
            tenant_id: "tenant".into(),
            target_id: "staging".into(),
            kind: OperationKind::Backup,
            state: OperationState::Verifying,
            request: json!({}),
            result: None,
            error: None,
            created_by: "operator".into(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        assert!(recovery_points_from_result(&operation, Some(&json!({ "stdout": "ok" }))).is_err());
    }

    #[test]
    fn collected_logs_are_bounded_and_materialized_for_the_target() {
        let operation = Operation {
            id: Uuid::new_v4(),
            tenant_id: "tenant-a".into(),
            target_id: "staging".into(),
            kind: OperationKind::CollectLogs,
            state: OperationState::Succeeded,
            request: json!({ "limit": 200 }),
            result: Some(json!({ "stdout": "first line\nsecond line\n" })),
            error: None,
            created_by: "operator".into(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let mut data = MemoryData::default();
        materialize_memory_result(&mut data, &operation).unwrap();

        assert_eq!(data.logs.len(), 2);
        assert_eq!(data.logs[0].0, "tenant-a");
        assert_eq!(data.logs[0].1.server_id, "staging");
        assert_eq!(data.logs[1].1.message, "second line");
    }
}
