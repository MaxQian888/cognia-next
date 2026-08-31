use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    model::{IncidentState, ProcessingState},
    processing::{retry_delay, ProcessingFailure},
    retention::RetentionPolicy,
};

#[derive(Clone)]
pub struct DiagnosticRepository {
    pool: PgPool,
}

#[derive(Debug, Clone)]
pub struct CreateIncident {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub project_id: Uuid,
    pub installation_id: String,
    pub artifact_hash: String,
    pub build_id: String,
    pub platform: String,
    pub module: String,
    pub exception: String,
    pub deletion_credential_hash: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentRecord {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub project_id: Uuid,
    pub installation_id: String,
    pub artifact_hash: String,
    pub build_id: String,
    pub platform: String,
    pub module: String,
    pub exception: String,
    pub client_state: IncidentState,
    pub processing_state: ProcessingState,
    pub support_code: String,
    pub fingerprint: Option<String>,
    pub processing_attempts: i32,
    pub next_processing_at: DateTime<Utc>,
    pub failure_code: Option<String>,
    pub grouping_basis: Option<serde_json::Value>,
    pub raw_stack: serde_json::Value,
    pub symbolized_stack: serde_json::Value,
    pub missing_symbols: Vec<String>,
    pub group_id: Option<Uuid>,
    pub accepted_at: Option<DateTime<Utc>>,
    pub consent_withdrawn_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// An incident plus whether this call is the one that created it.
///
/// `xmax = 0` is true only on the INSERT branch of an upsert — the row has no
/// deleting transaction. It is how the route learns that a retry resumed an
/// existing incident and must not hand out a second deletion credential.
#[derive(Debug, Clone, FromRow)]
pub struct CreatedIncident {
    #[sqlx(flatten)]
    pub incident: IncidentRecord,
    pub inserted: bool,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPartRecord {
    pub incident_id: Uuid,
    pub part_number: i32,
    pub object_key: String,
    pub source_sha256: String,
    pub stored_sha256: String,
    pub stored_bytes: i64,
    pub redaction_version: String,
    pub removed_fields: Vec<String>,
    pub artifact_kind: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolRecord {
    pub id: Uuid,
    pub build_id: String,
    pub platform: String,
    pub object_key: String,
    pub relative_path: String,
    pub symbol_type: String,
    pub status: String,
    pub sha256: String,
    pub created_at: DateTime<Utc>,
}

/// One deduplicated crash signature — the unit an operator actually triages.
///
/// Written by `accept_processing` since the grouping pipeline shipped; until
/// the triage routes existed nothing ever read it back, which is why `status`
/// never left `open` and `assigned_to` was never anything but NULL.
#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentGroupRecord {
    pub id: Uuid,
    pub project_id: Uuid,
    pub fingerprint: String,
    pub fingerprint_version: String,
    pub status: String,
    pub assigned_to: Option<String>,
    pub regression_count: i32,
    pub compatible_build_family: String,
    pub platform: String,
    pub exception: String,
    pub module: String,
    pub top_frames: serde_json::Value,
    pub incident_count: i64,
    pub first_seen_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Tenant-level policy an operator can read and change from the console.
#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TenantRecord {
    pub id: Uuid,
    pub name: String,
    pub retention_overrides: serde_json::Value,
    pub raw_minidump_access_enabled: bool,
    pub created_at: DateTime<Utc>,
}

/// One immutable audit row, as the console renders it.
#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventRecord {
    pub id: i64,
    pub action: String,
    pub incident_id: Option<Uuid>,
    pub actor_id: Option<String>,
    pub reason: Option<String>,
    pub details: serde_json::Value,
    pub occurred_at: DateTime<Utc>,
}

/// The statuses `incident_groups.status` accepts, mirroring its CHECK.
pub const GROUP_STATUSES: [&str; 3] = ["open", "suppressed", "resolved"];

/// Upper bound on any triage page, so a console cannot ask for the whole table.
pub const MAX_TRIAGE_PAGE: i64 = 200;

#[derive(Debug, Clone)]
pub struct GroupQuery {
    pub status: Option<String>,
    pub platform: Option<String>,
    pub assigned_to: Option<String>,
    pub search: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

impl Default for GroupQuery {
    fn default() -> Self {
        Self {
            status: None,
            platform: None,
            assigned_to: None,
            search: None,
            limit: 50,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct IncidentQuery {
    pub group_id: Option<Uuid>,
    pub processing_state: Option<ProcessingState>,
    pub support_code: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

impl Default for IncidentQuery {
    fn default() -> Self {
        Self {
            group_id: None,
            processing_state: None,
            support_code: None,
            limit: 50,
            offset: 0,
        }
    }
}

/// A triage edit. Every field is optional because the console PATCHes one
/// control at a time; `assigned_to: Some(None)` is the explicit "unassign",
/// which a plain `Option<String>` could not distinguish from "leave alone".
#[derive(Debug, Clone, Default)]
pub struct GroupTriageUpdate {
    pub status: Option<String>,
    pub assigned_to: Option<Option<String>>,
}

impl GroupTriageUpdate {
    pub fn is_empty(&self) -> bool {
        self.status.is_none() && self.assigned_to.is_none()
    }
}

/// Tenant policy edit, same one-control-at-a-time shape as the triage update.
#[derive(Debug, Clone, Default)]
pub struct TenantSettingsUpdate {
    pub raw_minidump_access_enabled: Option<bool>,
    pub retention_overrides: Option<serde_json::Value>,
}

impl TenantSettingsUpdate {
    pub fn is_empty(&self) -> bool {
        self.raw_minidump_access_enabled.is_none() && self.retention_overrides.is_none()
    }
}

#[derive(Debug, Clone)]
pub struct AcceptProcessing {
    pub fingerprint: String,
    pub compatible_build_family: String,
    pub grouping_basis: serde_json::Value,
    pub raw_stack: Vec<String>,
    pub symbolized_stack: Vec<String>,
    pub missing_symbols: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CreateSymbol {
    pub tenant_id: Uuid,
    pub project_id: Uuid,
    pub build_id: String,
    pub platform: String,
    pub object_key: String,
    pub relative_path: String,
    pub symbol_type: String,
    pub sha256: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct TenantKeyRecord {
    pub tenant_id: Uuid,
    pub key_version: i32,
    pub wrapped_dek: Vec<u8>,
    pub kms_key_id: String,
    pub state: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct RetentionJobRecord {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub incident_id: Option<Uuid>,
    pub object_key: Option<String>,
    pub resource_kind: String,
    pub attempts: i32,
}

#[derive(Debug, Clone, FromRow)]
pub struct AlertDeliveryRecord {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub project_id: Uuid,
    pub incident_id: Option<Uuid>,
    pub group_id: Option<Uuid>,
    pub alert_kind: String,
    pub transport: String,
    pub attempts: i32,
    pub payload: serde_json::Value,
}

impl DiagnosticRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn health(&self) -> anyhow::Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn active_tenant_key(
        &self,
        tenant_id: Uuid,
    ) -> anyhow::Result<Option<TenantKeyRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let record = sqlx::query_as::<_, TenantKeyRecord>(
            r#"SELECT tenant_id, key_version, wrapped_dek, kms_key_id, state
            FROM tenant_keys WHERE state = 'active'"#,
        )
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn tenant_key(
        &self,
        tenant_id: Uuid,
        key_version: i32,
    ) -> anyhow::Result<Option<TenantKeyRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let record = sqlx::query_as::<_, TenantKeyRecord>(
            r#"SELECT tenant_id, key_version, wrapped_dek, kms_key_id, state
            FROM tenant_keys WHERE key_version = $1"#,
        )
        .bind(key_version)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn insert_tenant_key(
        &self,
        tenant_id: Uuid,
        wrapped_dek: &[u8],
        kms_key_id: &str,
    ) -> anyhow::Result<TenantKeyRecord> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("tenant-key:{tenant_id}"))
            .execute(&mut *tx)
            .await?;
        if let Some(record) = sqlx::query_as::<_, TenantKeyRecord>(
            r#"SELECT tenant_id, key_version, wrapped_dek, kms_key_id, state
            FROM tenant_keys WHERE state = 'active' FOR UPDATE"#,
        )
        .fetch_optional(&mut *tx)
        .await?
        {
            tx.commit().await?;
            return Ok(record);
        }
        let record = sqlx::query_as::<_, TenantKeyRecord>(
            r#"INSERT INTO tenant_keys (tenant_id, key_version, wrapped_dek, kms_key_id)
            SELECT $1, COALESCE(MAX(key_version), 0) + 1, $2, $3
            FROM tenant_keys WHERE tenant_id = $1
            RETURNING tenant_id, key_version, wrapped_dek, kms_key_id, state"#,
        )
        .bind(tenant_id)
        .bind(wrapped_dek)
        .bind(kms_key_id)
        .fetch_one(&mut *tx)
        .await?;
        audit_admin(
            &mut tx,
            tenant_id,
            "tenant_key.created",
            Some(serde_json::json!({"keyVersion": record.key_version})),
        )
        .await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn rotate_tenant_key(
        &self,
        tenant_id: Uuid,
        wrapped_dek: &[u8],
        kms_key_id: &str,
    ) -> anyhow::Result<TenantKeyRecord> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("tenant-key:{tenant_id}"))
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            r#"UPDATE tenant_keys SET state = 'retired', retired_at = now()
            WHERE state = 'active'"#,
        )
        .execute(&mut *tx)
        .await?;
        let record = sqlx::query_as::<_, TenantKeyRecord>(
            r#"INSERT INTO tenant_keys (tenant_id, key_version, wrapped_dek, kms_key_id)
            SELECT $1, COALESCE(MAX(key_version), 0) + 1, $2, $3
            FROM tenant_keys WHERE tenant_id = $1
            RETURNING tenant_id, key_version, wrapped_dek, kms_key_id, state"#,
        )
        .bind(tenant_id)
        .bind(wrapped_dek)
        .bind(kms_key_id)
        .fetch_one(&mut *tx)
        .await?;
        audit_admin(
            &mut tx,
            tenant_id,
            "tenant_key.rotated",
            Some(serde_json::json!({"keyVersion": record.key_version})),
        )
        .await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn shred_tenant_keys(&self, tenant_id: Uuid) -> anyhow::Result<u64> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("tenant-key:{tenant_id}"))
            .execute(&mut *tx)
            .await?;
        let result = sqlx::query(
            r#"UPDATE tenant_keys SET wrapped_dek = ''::bytea, state = 'destroyed',
                destroyed_at = now() WHERE state <> 'destroyed'"#,
        )
        .execute(&mut *tx)
        .await?;
        audit_admin(
            &mut tx,
            tenant_id,
            "tenant_key.crypto_shredded",
            Some(serde_json::json!({"keyCount": result.rows_affected()})),
        )
        .await?;
        tx.commit().await?;
        Ok(result.rows_affected())
    }

    pub async fn register_nonce(
        &self,
        tenant_id: Uuid,
        nonce: &str,
        expires_at: DateTime<Utc>,
    ) -> anyhow::Result<bool> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let result = sqlx::query(
            "INSERT INTO anonymous_nonces (tenant_id, nonce, expires_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(tenant_id)
        .bind(nonce)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(result.rows_affected() == 1)
    }

    /// Create an incident, or hand back the one this artifact already made.
    ///
    /// Idempotent on `(tenant, project, artifact_hash)` so a client that
    /// retries a spooled package resumes instead of duplicating. The returned
    /// flag says which happened, because the caller must NOT mint a second
    /// deletion credential for an existing incident: `DO UPDATE` deliberately
    /// leaves `deletion_credential_hash` alone, so a freshly generated
    /// credential would be handed to the client while the stored hash still
    /// belonged to the first one — a credential that can never verify.
    pub async fn create_incident(&self, input: CreateIncident) -> anyhow::Result<CreatedIncident> {
        let mut tx = self.tenant_transaction(input.tenant_id).await?;
        let record = sqlx::query_as::<_, CreatedIncident>(
            r#"INSERT INTO incidents (
                id, tenant_id, project_id, installation_id, artifact_hash, build_id,
                platform, module, exception, deletion_credential_hash
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (tenant_id, project_id, artifact_hash)
            DO UPDATE SET updated_at = incidents.updated_at
            RETURNING id, tenant_id, project_id, installation_id, artifact_hash, build_id,
                platform, module, exception, client_state, processing_state, support_code,
                fingerprint, processing_attempts, next_processing_at, failure_code,
                grouping_basis, raw_stack, symbolized_stack, missing_symbols, group_id,
                accepted_at, consent_withdrawn_at, created_at, updated_at,
                (xmax = 0) AS inserted"#,
        )
        .bind(input.id)
        .bind(input.tenant_id)
        .bind(input.project_id)
        .bind(input.installation_id)
        .bind(input.artifact_hash)
        .bind(input.build_id)
        .bind(input.platform)
        .bind(input.module)
        .bind(input.exception)
        .bind(input.deletion_credential_hash)
        .fetch_one(&mut *tx)
        .await?;
        audit(
            &mut tx,
            record.incident.tenant_id,
            if record.inserted {
                "incident.created"
            } else {
                "incident.resumed"
            },
            record.incident.id,
            None,
        )
        .await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn incident(
        &self,
        tenant_id: Uuid,
        project_id: Uuid,
        id: Uuid,
    ) -> anyhow::Result<Option<IncidentRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let record = sqlx::query_as::<_, IncidentRecord>(
            r#"SELECT id, tenant_id, project_id, installation_id, artifact_hash, build_id,
                platform, module, exception, client_state, processing_state, support_code,
                fingerprint, processing_attempts, next_processing_at, failure_code,
                grouping_basis, raw_stack, symbolized_stack, missing_symbols, group_id,
                accepted_at, consent_withdrawn_at, created_at, updated_at
            FROM incidents WHERE id = $1 AND project_id = $2"#,
        )
        .bind(id)
        .bind(project_id)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn upsert_part(
        &self,
        tenant_id: Uuid,
        part: &UploadPartRecord,
    ) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        sqlx::query(
            r#"INSERT INTO upload_parts (
                tenant_id, incident_id, part_number, object_key, source_sha256,
                stored_sha256, stored_bytes, redaction_version, removed_fields, artifact_kind
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (tenant_id, incident_id, part_number) DO UPDATE SET
                object_key = EXCLUDED.object_key,
                source_sha256 = EXCLUDED.source_sha256,
                stored_sha256 = EXCLUDED.stored_sha256,
                stored_bytes = EXCLUDED.stored_bytes,
                redaction_version = EXCLUDED.redaction_version,
                removed_fields = EXCLUDED.removed_fields,
                artifact_kind = EXCLUDED.artifact_kind,
                created_at = now()"#,
        )
        .bind(tenant_id)
        .bind(part.incident_id)
        .bind(part.part_number)
        .bind(&part.object_key)
        .bind(&part.source_sha256)
        .bind(&part.stored_sha256)
        .bind(part.stored_bytes)
        .bind(&part.redaction_version)
        .bind(&part.removed_fields)
        .bind(&part.artifact_kind)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut tx,
            tenant_id,
            "upload.part_stored",
            part.incident_id,
            Some(serde_json::json!({"partNumber": part.part_number})),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn parts(
        &self,
        tenant_id: Uuid,
        incident_id: Uuid,
    ) -> anyhow::Result<Vec<UploadPartRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let parts = sqlx::query_as::<_, UploadPartRecord>(
            r#"SELECT incident_id, part_number, object_key, source_sha256, stored_sha256,
                stored_bytes, redaction_version, removed_fields, artifact_kind, created_at
            FROM upload_parts WHERE incident_id = $1 ORDER BY part_number"#,
        )
        .bind(incident_id)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(parts)
    }

    pub async fn queue_processing(
        &self,
        tenant_id: Uuid,
        incident_id: Uuid,
    ) -> anyhow::Result<IncidentRecord> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let record = sqlx::query_as::<_, IncidentRecord>(
            r#"UPDATE incidents SET client_state = 'processing', processing_state = 'received',
                failure_code = NULL, next_processing_at = now(), updated_at = now()
            WHERE id = $1 AND consent_withdrawn_at IS NULL
                AND client_state NOT IN ('cancelled', 'deleted')
            RETURNING id, tenant_id, project_id, installation_id, artifact_hash, build_id,
                platform, module, exception, client_state, processing_state, support_code,
                fingerprint, processing_attempts, next_processing_at, failure_code,
                grouping_basis, raw_stack, symbolized_stack, missing_symbols, group_id,
                accepted_at, consent_withdrawn_at, created_at, updated_at"#,
        )
        .bind(incident_id)
        .fetch_one(&mut *tx)
        .await?;
        audit(
            &mut tx,
            tenant_id,
            "incident.processing_queued",
            incident_id,
            None,
        )
        .await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn tenant_ids(&self) -> anyhow::Result<Vec<Uuid>> {
        Ok(sqlx::query_scalar("SELECT id FROM tenants ORDER BY id")
            .fetch_all(&self.pool)
            .await?)
    }

    pub async fn claim_next_retention(
        &self,
        tenant_id: Uuid,
    ) -> anyhow::Result<Option<RetentionJobRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let record = sqlx::query_as::<_, RetentionJobRecord>(
            r#"WITH candidate AS (
                SELECT id FROM retention_jobs
                WHERE (
                    state IN ('pending', 'failed') AND execute_after <= now() AND attempts < 10
                ) OR (
                    state = 'running' AND updated_at < now() - interval '10 minutes'
                )
                ORDER BY execute_after, created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE retention_jobs SET state = 'running', attempts = attempts + 1,
                last_error_code = NULL, updated_at = now()
            WHERE id = (SELECT id FROM candidate)
            RETURNING id, tenant_id, incident_id, object_key, resource_kind, attempts"#,
        )
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn claim_next_alert(
        &self,
        tenant_id: Uuid,
    ) -> anyhow::Result<Option<AlertDeliveryRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let record = sqlx::query_as::<_, AlertDeliveryRecord>(
            r#"WITH candidate AS (
                SELECT id FROM alert_deliveries
                WHERE (
                    state IN ('pending', 'failed') AND next_attempt_at <= now() AND attempts < 10
                ) OR (
                    state = 'sending' AND updated_at < now() - interval '10 minutes'
                )
                ORDER BY next_attempt_at, created_at
                FOR UPDATE SKIP LOCKED LIMIT 1
            )
            UPDATE alert_deliveries SET state = 'sending', attempts = attempts + 1,
                last_error_code = NULL, updated_at = now()
            WHERE id = (SELECT id FROM candidate)
            RETURNING id, tenant_id, project_id, incident_id, group_id, alert_kind,
                transport, attempts, payload"#,
        )
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn complete_alert(&self, delivery: &AlertDeliveryRecord) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(delivery.tenant_id).await?;
        sqlx::query(
            "UPDATE alert_deliveries SET state = 'sent', sent_at = now(), updated_at = now() WHERE id = $1",
        )
        .bind(delivery.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn fail_alert(
        &self,
        delivery: &AlertDeliveryRecord,
        error_code: &str,
        retry_at: DateTime<Utc>,
        retryable: bool,
    ) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(delivery.tenant_id).await?;
        sqlx::query(
            r#"UPDATE alert_deliveries SET state = 'failed', last_error_code = $2,
                next_attempt_at = $3, attempts = CASE WHEN $4 THEN attempts ELSE 10 END,
                updated_at = now() WHERE id = $1"#,
        )
        .bind(delivery.id)
        .bind(error_code)
        .bind(retry_at)
        .bind(retryable)
        .execute(&mut *tx)
        .await?;
        if !retryable {
            audit_admin(
                &mut tx,
                delivery.tenant_id,
                "alert.permanent_failure",
                Some(serde_json::json!({
                    "deliveryId": delivery.id,
                    "transport": delivery.transport,
                    "code": error_code,
                })),
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn complete_retention_artifact(
        &self,
        job: &RetentionJobRecord,
    ) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(job.tenant_id).await?;
        let object_key = job.object_key.as_deref().unwrap_or_default();
        match job.resource_kind.as_str() {
            "incident_artifact" => {
                sqlx::query("DELETE FROM upload_parts WHERE object_key = $1")
                    .bind(object_key)
                    .execute(&mut *tx)
                    .await?;
            }
            "symbol" => {
                sqlx::query("DELETE FROM symbols WHERE object_key = $1")
                    .bind(object_key)
                    .execute(&mut *tx)
                    .await?;
            }
            _ => anyhow::bail!("retention job does not reference an artifact"),
        }
        sqlx::query(
            "UPDATE retention_jobs SET state = 'complete', completed_at = now(), updated_at = now() WHERE id = $1",
        )
        .bind(job.id)
        .execute(&mut *tx)
        .await?;
        audit_admin(
            &mut tx,
            job.tenant_id,
            "retention.artifact_deleted",
            Some(serde_json::json!({"jobId": job.id, "resourceKind": job.resource_kind})),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn complete_retention_metadata(
        &self,
        job: &RetentionJobRecord,
    ) -> anyhow::Result<()> {
        let incident_id = job
            .incident_id
            .ok_or_else(|| anyhow::anyhow!("metadata retention job is missing an incident"))?;
        let mut tx = self.tenant_transaction(job.tenant_id).await?;
        audit(
            &mut tx,
            job.tenant_id,
            "retention.incident_deleted",
            incident_id,
            Some(serde_json::json!({"jobId": job.id})),
        )
        .await?;
        sqlx::query(
            "UPDATE retention_jobs SET state = 'complete', completed_at = now(), updated_at = now() WHERE id = $1",
        )
        .bind(job.id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM incidents WHERE id = $1")
            .bind(incident_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn fail_retention(
        &self,
        job: &RetentionJobRecord,
        error_code: &str,
        retry_at: DateTime<Utc>,
        retryable: bool,
    ) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(job.tenant_id).await?;
        sqlx::query(
            r#"UPDATE retention_jobs SET state = 'failed', last_error_code = $2,
                execute_after = $3, updated_at = now() WHERE id = $1"#,
        )
        .bind(job.id)
        .bind(error_code)
        .bind(retry_at)
        .execute(&mut *tx)
        .await?;
        if !retryable {
            audit_admin(
                &mut tx,
                job.tenant_id,
                "retention.permanent_failure",
                Some(serde_json::json!({"jobId": job.id, "code": error_code})),
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn claim_next_processing(
        &self,
        tenant_id: Uuid,
    ) -> anyhow::Result<Option<IncidentRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let record = sqlx::query_as::<_, IncidentRecord>(
            r#"WITH candidate AS (
                SELECT id FROM incidents
                WHERE ((
                        processing_state IN ('received', 'retryable_failure')
                        AND next_processing_at <= now()
                    ) OR (
                        processing_state IN ('scanning', 'symbolicating', 'grouping')
                        AND updated_at < now() - interval '10 minutes'
                    ))
                    AND consent_withdrawn_at IS NULL
                    AND client_state = 'processing'
                ORDER BY next_processing_at, created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE incidents SET processing_state = 'scanning',
                processing_attempts = processing_attempts + 1, failure_code = NULL,
                updated_at = now()
            WHERE id = (SELECT id FROM candidate)
            RETURNING id, tenant_id, project_id, installation_id, artifact_hash, build_id,
                platform, module, exception, client_state, processing_state, support_code,
                fingerprint, processing_attempts, next_processing_at, failure_code,
                grouping_basis, raw_stack, symbolized_stack, missing_symbols, group_id,
                accepted_at, consent_withdrawn_at, created_at, updated_at"#,
        )
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn set_processing_state(
        &self,
        tenant_id: Uuid,
        incident_id: Uuid,
        state: ProcessingState,
    ) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        sqlx::query(
            "UPDATE incidents SET processing_state = $2, updated_at = now() WHERE id = $1 AND consent_withdrawn_at IS NULL",
        )
        .bind(incident_id)
        .bind(state)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn reject_part(
        &self,
        tenant_id: Uuid,
        incident_id: Uuid,
        part_number: i32,
        code: &str,
    ) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        sqlx::query("DELETE FROM upload_parts WHERE incident_id = $1 AND part_number = $2")
            .bind(incident_id)
            .bind(part_number)
            .execute(&mut *tx)
            .await?;
        audit(
            &mut tx,
            tenant_id,
            "upload.part_rejected",
            incident_id,
            Some(serde_json::json!({"partNumber": part_number, "code": code})),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn symbols_for_build(
        &self,
        tenant_id: Uuid,
        project_id: Uuid,
        build_id: &str,
        platform: &str,
    ) -> anyhow::Result<Vec<SymbolRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let records = sqlx::query_as::<_, SymbolRecord>(
            r#"SELECT id, build_id, platform, object_key, relative_path, symbol_type, status,
                sha256, created_at
            FROM symbols WHERE project_id = $1 AND build_id = $2 AND platform = $3
                AND expires_at > now() AND status IN ('uploaded', 'indexed')
            ORDER BY created_at"#,
        )
        .bind(project_id)
        .bind(build_id)
        .bind(platform)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(records)
    }

    pub async fn upsert_symbol(&self, input: CreateSymbol) -> anyhow::Result<SymbolRecord> {
        let mut tx = self.tenant_transaction(input.tenant_id).await?;
        let record = sqlx::query_as::<_, SymbolRecord>(
            r#"INSERT INTO symbols (
                tenant_id, project_id, build_id, platform, object_key, relative_path,
                symbol_type, sha256, status, indexed_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'indexed',now())
            ON CONFLICT (tenant_id, project_id, build_id, platform, sha256)
            DO UPDATE SET object_key = EXCLUDED.object_key,
                relative_path = EXCLUDED.relative_path, symbol_type = EXCLUDED.symbol_type,
                status = 'indexed', indexed_at = now()
            RETURNING id, build_id, platform, object_key, relative_path, symbol_type, status,
                sha256, created_at"#,
        )
        .bind(input.tenant_id)
        .bind(input.project_id)
        .bind(&input.build_id)
        .bind(&input.platform)
        .bind(&input.object_key)
        .bind(&input.relative_path)
        .bind(&input.symbol_type)
        .bind(&input.sha256)
        .fetch_one(&mut *tx)
        .await?;
        audit_admin(
            &mut tx,
            input.tenant_id,
            "symbol.indexed",
            Some(serde_json::json!({
                "symbolId": record.id,
                "buildId": input.build_id,
                "platform": input.platform,
                "sha256": input.sha256,
            })),
        )
        .await?;
        schedule_symbol_retention(&mut tx, input.tenant_id, &record.object_key).await?;
        tx.commit().await?;
        Ok(record)
    }

    pub async fn symbols(
        &self,
        tenant_id: Uuid,
        project_id: Uuid,
        build_id: Option<&str>,
    ) -> anyhow::Result<Vec<SymbolRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let records = sqlx::query_as::<_, SymbolRecord>(
            r#"SELECT id, build_id, platform, object_key, relative_path, symbol_type, status,
                sha256, created_at FROM symbols
            WHERE project_id = $1 AND ($2::text IS NULL OR build_id = $2)
            ORDER BY created_at DESC LIMIT 1000"#,
        )
        .bind(project_id)
        .bind(build_id)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(records)
    }

    pub async fn accept_processing(
        &self,
        incident: &IncidentRecord,
        accepted: AcceptProcessing,
    ) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(incident.tenant_id).await?;
        let lock_key = format!(
            "{}:{}:{}",
            incident.tenant_id, incident.project_id, accepted.fingerprint
        );
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(lock_key)
            .execute(&mut *tx)
            .await?;
        let existing = sqlx::query_as::<_, (Uuid, String)>(
            "SELECT id, status FROM incident_groups WHERE project_id = $1 AND fingerprint = $2 FOR UPDATE",
        )
        .bind(incident.project_id)
        .bind(&accepted.fingerprint)
        .fetch_optional(&mut *tx)
        .await?;
        let (group_id, notify_regression) = if let Some((group_id, status)) = existing {
            sqlx::query(
                r#"UPDATE incident_groups SET status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
                    regression_count = regression_count + CASE WHEN status = 'resolved' THEN 1 ELSE 0 END,
                    compatible_build_family = $2, platform = $3, exception = $4, module = $5,
                    top_frames = $6, incident_count = incident_count + 1,
                    last_seen_at = now(), updated_at = now()
                WHERE id = $1"#,
            )
            .bind(group_id)
            .bind(&accepted.compatible_build_family)
            .bind(&incident.platform)
            .bind(&incident.exception)
            .bind(&incident.module)
            .bind(serde_json::json!(accepted.symbolized_stack.iter().take(5).collect::<Vec<_>>()))
            .execute(&mut *tx)
            .await?;
            (group_id, status == "resolved")
        } else {
            let group_id = sqlx::query_scalar::<_, Uuid>(
                r#"INSERT INTO incident_groups (
                    tenant_id, project_id, fingerprint, compatible_build_family,
                    platform, exception, module, top_frames, incident_count
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) RETURNING id"#,
            )
            .bind(incident.tenant_id)
            .bind(incident.project_id)
            .bind(&accepted.fingerprint)
            .bind(&accepted.compatible_build_family)
            .bind(&incident.platform)
            .bind(&incident.exception)
            .bind(&incident.module)
            .bind(serde_json::json!(accepted
                .symbolized_stack
                .iter()
                .take(5)
                .collect::<Vec<_>>()))
            .fetch_one(&mut *tx)
            .await?;
            (group_id, true)
        };

        sqlx::query(
            r#"UPDATE incidents SET client_state = 'accepted', processing_state = 'accepted',
                fingerprint = $2, grouping_basis = $3, raw_stack = $4, symbolized_stack = $5,
                missing_symbols = $6, group_id = $7, accepted_at = now(), failure_code = NULL,
                updated_at = now()
            WHERE id = $1 AND consent_withdrawn_at IS NULL"#,
        )
        .bind(incident.id)
        .bind(&accepted.fingerprint)
        .bind(&accepted.grouping_basis)
        .bind(serde_json::json!(accepted.raw_stack))
        .bind(serde_json::json!(accepted.symbolized_stack))
        .bind(&accepted.missing_symbols)
        .bind(group_id)
        .execute(&mut *tx)
        .await?;
        if notify_regression {
            enqueue_alert(
                &mut tx,
                incident,
                group_id,
                "new_regression",
                serde_json::json!({"fingerprint": accepted.fingerprint}),
            )
            .await?;
        }
        if !accepted.missing_symbols.is_empty() {
            enqueue_alert(
                &mut tx,
                incident,
                group_id,
                "missing_symbols",
                serde_json::json!({"modules": accepted.missing_symbols}),
            )
            .await?;
        }
        schedule_incident_retention(&mut tx, incident.tenant_id, incident.id, false).await?;
        audit(
            &mut tx,
            incident.tenant_id,
            "incident.accepted",
            incident.id,
            Some(serde_json::json!({"groupId": group_id, "fingerprint": accepted.fingerprint})),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn fail_processing(
        &self,
        incident: &IncidentRecord,
        failure: ProcessingFailure,
    ) -> anyhow::Result<()> {
        let attempt = u32::try_from(incident.processing_attempts).unwrap_or(u32::MAX);
        let next_delay = failure.retryable().then(|| retry_delay(attempt)).flatten();
        let (processing_state, client_state) = processing_failure_target(next_delay.is_some());
        let mut tx = self.tenant_transaction(incident.tenant_id).await?;
        sqlx::query(
            r#"UPDATE incidents SET processing_state = $2, client_state = $3,
                failure_code = $4, next_processing_at = now() + ($5 * interval '1 second'),
                updated_at = now() WHERE id = $1 AND consent_withdrawn_at IS NULL"#,
        )
        .bind(incident.id)
        .bind(processing_state)
        .bind(client_state)
        .bind(failure.code())
        .bind(next_delay.map_or(0_i32, |delay| delay.as_secs() as i32))
        .execute(&mut *tx)
        .await?;
        audit(
            &mut tx,
            incident.tenant_id,
            "incident.processing_failed",
            incident.id,
            Some(serde_json::json!({"code": failure.code(), "retryable": next_delay.is_some()})),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn cancel(&self, tenant_id: Uuid, incident_id: Uuid) -> anyhow::Result<()> {
        self.set_terminal(tenant_id, incident_id, "cancelled", "incident.cancelled")
            .await
    }

    pub async fn withdraw(&self, tenant_id: Uuid, incident_id: Uuid) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        sqlx::query(
            "UPDATE incidents SET consent_withdrawn_at = now(), client_state = 'cancelled', updated_at = now() WHERE id = $1 AND client_state <> 'deleted'",
        )
        .bind(incident_id)
        .execute(&mut *tx)
        .await?;
        schedule_incident_retention(&mut tx, tenant_id, incident_id, true).await?;
        audit(&mut tx, tenant_id, "consent.withdrawn", incident_id, None).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn delete(&self, tenant_id: Uuid, incident_id: Uuid) -> anyhow::Result<()> {
        self.set_terminal(tenant_id, incident_id, "deleted", "incident.deleted")
            .await
    }

    async fn set_terminal(
        &self,
        tenant_id: Uuid,
        incident_id: Uuid,
        state: &str,
        action: &str,
    ) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        sqlx::query(
            "UPDATE incidents SET client_state = $2::incident_state, processing_state = CASE WHEN $2 = 'deleted' THEN 'deleted'::processing_state ELSE processing_state END, updated_at = now() WHERE id = $1",
        )
        .bind(incident_id)
        .bind(state)
        .execute(&mut *tx)
        .await?;
        if matches!(state, "cancelled" | "deleted") {
            schedule_incident_retention(&mut tx, tenant_id, incident_id, true).await?;
        }
        audit(&mut tx, tenant_id, action, incident_id, None).await?;
        tx.commit().await?;
        Ok(())
    }

    /// One page of triage groups, newest activity first.
    ///
    /// Filters are bound as nullable parameters rather than concatenated, so
    /// the statement is the same prepared plan for every filter combination
    /// and no operator-supplied text ever reaches the parser.
    pub async fn list_groups(
        &self,
        tenant_id: Uuid,
        project_id: Uuid,
        query: &GroupQuery,
    ) -> anyhow::Result<Vec<IncidentGroupRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let groups = sqlx::query_as::<_, IncidentGroupRecord>(
            r#"SELECT id, project_id, fingerprint, fingerprint_version, status, assigned_to,
                regression_count, compatible_build_family, platform, exception, module,
                top_frames, incident_count, first_seen_at, last_seen_at, created_at, updated_at
            FROM incident_groups
            WHERE project_id = $1
              AND ($2::text IS NULL OR status = $2)
              AND ($3::text IS NULL OR platform = $3)
              AND ($4::text IS NULL OR assigned_to = $4)
              AND ($5::text IS NULL
                   OR exception ILIKE '%' || $5 || '%'
                   OR module ILIKE '%' || $5 || '%'
                   OR fingerprint ILIKE '%' || $5 || '%')
            ORDER BY last_seen_at DESC, id
            LIMIT $6 OFFSET $7"#,
        )
        .bind(project_id)
        .bind(query.status.as_deref())
        .bind(query.platform.as_deref())
        .bind(query.assigned_to.as_deref())
        .bind(query.search.as_deref())
        .bind(query.limit.clamp(1, MAX_TRIAGE_PAGE))
        .bind(query.offset.max(0))
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(groups)
    }

    pub async fn group(
        &self,
        tenant_id: Uuid,
        project_id: Uuid,
        group_id: Uuid,
    ) -> anyhow::Result<Option<IncidentGroupRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let group = sqlx::query_as::<_, IncidentGroupRecord>(
            r#"SELECT id, project_id, fingerprint, fingerprint_version, status, assigned_to,
                regression_count, compatible_build_family, platform, exception, module,
                top_frames, incident_count, first_seen_at, last_seen_at, created_at, updated_at
            FROM incident_groups WHERE id = $1 AND project_id = $2"#,
        )
        .bind(group_id)
        .bind(project_id)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(group)
    }

    /// Apply a triage edit and record who made it.
    ///
    /// Returns `None` when the group does not exist in this tenant/project, so
    /// the route can answer 404 rather than a silent no-op. `COALESCE` leaves
    /// untouched columns alone; the assignee is handled by a separate flag
    /// because clearing it is a real edit that `COALESCE` cannot express.
    pub async fn update_group(
        &self,
        tenant_id: Uuid,
        project_id: Uuid,
        group_id: Uuid,
        update: &GroupTriageUpdate,
        actor: Option<&str>,
    ) -> anyhow::Result<Option<IncidentGroupRecord>> {
        if let Some(status) = &update.status {
            validate_group_status(status)?;
        }
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let (assign_requested, assignee) = match &update.assigned_to {
            Some(value) => (true, value.clone()),
            None => (false, None),
        };
        let group = sqlx::query_as::<_, IncidentGroupRecord>(
            r#"UPDATE incident_groups SET
                status = COALESCE($3, status),
                assigned_to = CASE WHEN $4 THEN $5 ELSE assigned_to END,
                updated_at = now()
            WHERE id = $1 AND project_id = $2
            RETURNING id, project_id, fingerprint, fingerprint_version, status, assigned_to,
                regression_count, compatible_build_family, platform, exception, module,
                top_frames, incident_count, first_seen_at, last_seen_at, created_at, updated_at"#,
        )
        .bind(group_id)
        .bind(project_id)
        .bind(update.status.as_deref())
        .bind(assign_requested)
        .bind(assignee.as_deref())
        .fetch_optional(&mut *tx)
        .await?;
        let Some(group) = group else {
            tx.rollback().await?;
            return Ok(None);
        };
        audit_actor(
            &mut tx,
            tenant_id,
            "group.triaged",
            None,
            actor,
            Some(serde_json::json!({
                "groupId": group.id,
                "status": group.status,
                "assignedTo": group.assigned_to,
            })),
        )
        .await?;
        tx.commit().await?;
        Ok(Some(group))
    }

    /// One page of incidents for the console, newest first.
    pub async fn list_incidents(
        &self,
        tenant_id: Uuid,
        project_id: Uuid,
        query: &IncidentQuery,
    ) -> anyhow::Result<Vec<IncidentRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let incidents = sqlx::query_as::<_, IncidentRecord>(
            r#"SELECT id, tenant_id, project_id, installation_id, artifact_hash, build_id,
                platform, module, exception, client_state, processing_state, support_code,
                fingerprint, processing_attempts, next_processing_at, failure_code,
                grouping_basis, raw_stack, symbolized_stack, missing_symbols, group_id,
                accepted_at, consent_withdrawn_at, created_at, updated_at
            FROM incidents
            WHERE project_id = $1
              AND ($2::uuid IS NULL OR group_id = $2)
              AND ($3::processing_state IS NULL OR processing_state = $3)
              AND ($4::text IS NULL OR support_code = upper($4))
            ORDER BY created_at DESC, id
            LIMIT $5 OFFSET $6"#,
        )
        .bind(project_id)
        .bind(query.group_id)
        .bind(query.processing_state)
        .bind(query.support_code.as_deref())
        .bind(query.limit.clamp(1, MAX_TRIAGE_PAGE))
        .bind(query.offset.max(0))
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(incidents)
    }

    pub async fn part(
        &self,
        tenant_id: Uuid,
        incident_id: Uuid,
        part_number: i32,
    ) -> anyhow::Result<Option<UploadPartRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let part = sqlx::query_as::<_, UploadPartRecord>(
            r#"SELECT incident_id, part_number, object_key, source_sha256, stored_sha256,
                stored_bytes, redaction_version, removed_fields, artifact_kind, created_at
            FROM upload_parts WHERE incident_id = $1 AND part_number = $2"#,
        )
        .bind(incident_id)
        .bind(part_number)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(part)
    }

    /// Tenant policy row. `tenants` is the one table without RLS — it is keyed
    /// by the id the grant already pins, so the lookup is explicitly scoped.
    pub async fn tenant(&self, tenant_id: Uuid) -> anyhow::Result<Option<TenantRecord>> {
        let tenant = sqlx::query_as::<_, TenantRecord>(
            r#"SELECT id, name, retention_overrides, raw_minidump_access_enabled, created_at
            FROM tenants WHERE id = $1"#,
        )
        .bind(tenant_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(tenant)
    }

    /// Whether this tenant has opted into operators reading raw minidumps.
    ///
    /// Missing tenant reads as `false`: an unknown tenant is never granted the
    /// most sensitive artifact in the system.
    pub async fn raw_minidump_access_enabled(&self, tenant_id: Uuid) -> anyhow::Result<bool> {
        Ok(self
            .tenant(tenant_id)
            .await?
            .is_some_and(|tenant| tenant.raw_minidump_access_enabled))
    }

    pub async fn update_tenant_settings(
        &self,
        tenant_id: Uuid,
        update: &TenantSettingsUpdate,
        actor: Option<&str>,
    ) -> anyhow::Result<Option<TenantRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let tenant = sqlx::query_as::<_, TenantRecord>(
            r#"UPDATE tenants SET
                raw_minidump_access_enabled = COALESCE($2, raw_minidump_access_enabled),
                retention_overrides = COALESCE($3, retention_overrides)
            WHERE id = $1
            RETURNING id, name, retention_overrides, raw_minidump_access_enabled, created_at"#,
        )
        .bind(tenant_id)
        .bind(update.raw_minidump_access_enabled)
        .bind(update.retention_overrides.as_ref())
        .fetch_optional(&mut *tx)
        .await?;
        let Some(tenant) = tenant else {
            tx.rollback().await?;
            return Ok(None);
        };
        audit_actor(
            &mut tx,
            tenant_id,
            "tenant.policy_changed",
            None,
            actor,
            Some(serde_json::json!({
                "rawMinidumpAccessEnabled": tenant.raw_minidump_access_enabled,
                "retentionOverrides": tenant.retention_overrides,
            })),
        )
        .await?;
        tx.commit().await?;
        Ok(Some(tenant))
    }

    /// Record that an operator read an artifact out of the store.
    ///
    /// Written before the bytes are handed over, and in its own transaction, so
    /// a read that later fails still leaves the attempt on the immutable trail.
    pub async fn record_artifact_access(
        &self,
        tenant_id: Uuid,
        incident_id: Uuid,
        part: &UploadPartRecord,
        actor: Option<&str>,
    ) -> anyhow::Result<()> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        audit_actor(
            &mut tx,
            tenant_id,
            "artifact.read",
            Some(incident_id),
            actor,
            Some(serde_json::json!({
                "partNumber": part.part_number,
                "artifactKind": part.artifact_kind,
                "storedBytes": part.stored_bytes,
            })),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The audit trail for one incident, newest first — the console's evidence
    /// that consent, processing, and every operator read are accounted for.
    pub async fn incident_audit(
        &self,
        tenant_id: Uuid,
        incident_id: Uuid,
        limit: i64,
    ) -> anyhow::Result<Vec<AuditEventRecord>> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let events = sqlx::query_as::<_, AuditEventRecord>(
            r#"SELECT id, action, incident_id, actor_id, reason, details, occurred_at
            FROM audit_events WHERE incident_id = $1
            ORDER BY occurred_at DESC, id DESC LIMIT $2"#,
        )
        .bind(incident_id)
        .bind(limit.clamp(1, MAX_TRIAGE_PAGE))
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(events)
    }

    async fn tenant_transaction(
        &self,
        tenant_id: Uuid,
    ) -> anyhow::Result<Transaction<'_, Postgres>> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT set_config('app.tenant_id', $1, true)")
            .bind(tenant_id.to_string())
            .execute(&mut *tx)
            .await?;
        Ok(tx)
    }
}

/// Reject a status the CHECK constraint would reject anyway.
///
/// Checked before the transaction opens so a typo comes back as a 400 rather
/// than a constraint violation surfaced as an opaque 500.
pub fn validate_group_status(status: &str) -> anyhow::Result<()> {
    if GROUP_STATUSES.contains(&status) {
        Ok(())
    } else {
        anyhow::bail!("unsupported group status {status}")
    }
}

fn processing_failure_target(retryable: bool) -> (ProcessingState, IncidentState) {
    if retryable {
        (ProcessingState::RetryableFailure, IncidentState::Processing)
    } else {
        (ProcessingState::PermanentFailure, IncidentState::Rejected)
    }
}

async fn enqueue_alert(
    tx: &mut Transaction<'_, Postgres>,
    incident: &IncidentRecord,
    group_id: Uuid,
    alert_kind: &str,
    payload: serde_json::Value,
) -> anyhow::Result<()> {
    for transport in ["webhook", "smtp", "otel"] {
        sqlx::query(
            r#"INSERT INTO alert_deliveries (
                tenant_id, project_id, incident_id, group_id, alert_kind, transport, payload
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)"#,
        )
        .bind(incident.tenant_id)
        .bind(incident.project_id)
        .bind(incident.id)
        .bind(group_id)
        .bind(alert_kind)
        .bind(transport)
        .bind(&payload)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn tenant_retention_policy(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
) -> anyhow::Result<RetentionPolicy> {
    let overrides = sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT retention_overrides FROM tenants WHERE id = $1",
    )
    .bind(tenant_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(RetentionPolicy::from_overrides(&overrides))
}

async fn schedule_incident_retention(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    incident_id: Uuid,
    immediate: bool,
) -> anyhow::Result<()> {
    let policy = tenant_retention_policy(tx, tenant_id).await?;
    let parts = sqlx::query_as::<_, (String, String)>(
        "SELECT object_key, artifact_kind FROM upload_parts WHERE incident_id = $1",
    )
    .bind(incident_id)
    .fetch_all(&mut **tx)
    .await?;
    let now = Utc::now();
    for (object_key, artifact_kind) in parts {
        let execute_after = if immediate {
            now
        } else {
            now + chrono::Duration::days(policy.artifact_days(&artifact_kind) as i64)
        };
        upsert_retention_job(
            tx,
            tenant_id,
            Some(incident_id),
            Some(&object_key),
            "incident_artifact",
            execute_after,
        )
        .await?;
    }
    let metadata_at = if immediate {
        now
    } else {
        now + chrono::Duration::days(policy.metadata_days as i64)
    };
    upsert_retention_job(
        tx,
        tenant_id,
        Some(incident_id),
        None,
        "incident_metadata",
        metadata_at,
    )
    .await
}

async fn schedule_symbol_retention(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    object_key: &str,
) -> anyhow::Result<()> {
    let policy = tenant_retention_policy(tx, tenant_id).await?;
    upsert_retention_job(
        tx,
        tenant_id,
        None,
        Some(object_key),
        "symbol",
        Utc::now() + chrono::Duration::days(policy.symbol_days as i64),
    )
    .await
}

async fn upsert_retention_job(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    incident_id: Option<Uuid>,
    object_key: Option<&str>,
    resource_kind: &str,
    execute_after: DateTime<Utc>,
) -> anyhow::Result<()> {
    let dedupe_key = format!(
        "{}:{}",
        resource_kind,
        object_key
            .map(str::to_owned)
            .or_else(|| incident_id.map(|id| id.to_string()))
            .ok_or_else(|| anyhow::anyhow!("retention job requires an object or incident"))?
    );
    sqlx::query(
        r#"INSERT INTO retention_jobs (
            tenant_id, incident_id, object_key, resource_kind, dedupe_key, execute_after
        ) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
            execute_after = LEAST(retention_jobs.execute_after, EXCLUDED.execute_after),
            state = CASE WHEN retention_jobs.state = 'complete' THEN 'complete' ELSE 'pending' END,
            updated_at = now()"#,
    )
    .bind(tenant_id)
    .bind(incident_id)
    .bind(object_key)
    .bind(resource_kind)
    .bind(dedupe_key)
    .bind(execute_after)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Append one immutable audit row.
///
/// `actor` is `None` for everything a worker does on its own schedule — a
/// retention sweep or a symbolication retry has no operator to name, and
/// inventing one would make the trail lie. Routes that act on behalf of a
/// signed-in operator pass the grant's `actor_id` through.
async fn audit_actor(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    action: &str,
    incident_id: Option<Uuid>,
    actor: Option<&str>,
    details: Option<serde_json::Value>,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"INSERT INTO audit_events (tenant_id, action, incident_id, actor_id, details)
        VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(tenant_id)
    .bind(action)
    .bind(incident_id)
    .bind(actor)
    .bind(details.unwrap_or_else(|| serde_json::json!({})))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn audit_admin(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    action: &str,
    details: Option<serde_json::Value>,
) -> anyhow::Result<()> {
    audit_actor(tx, tenant_id, action, None, None, details).await
}

async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    action: &str,
    incident_id: Uuid,
    details: Option<serde_json::Value>,
) -> anyhow::Result<()> {
    audit_actor(tx, tenant_id, action, Some(incident_id), None, details).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn processing_failures_keep_retryable_incidents_active() {
        assert_eq!(
            processing_failure_target(true),
            (ProcessingState::RetryableFailure, IncidentState::Processing)
        );
        assert_eq!(
            processing_failure_target(false),
            (ProcessingState::PermanentFailure, IncidentState::Rejected)
        );
    }

    #[test]
    fn group_status_matches_the_check_constraint() {
        for status in GROUP_STATUSES {
            validate_group_status(status).unwrap();
        }
        assert!(validate_group_status("wontfix").is_err());
        assert!(validate_group_status("OPEN").is_err());
    }

    #[test]
    fn an_unassign_is_distinguishable_from_leaving_the_assignee_alone() {
        let untouched = GroupTriageUpdate {
            status: Some("resolved".to_owned()),
            assigned_to: None,
        };
        let cleared = GroupTriageUpdate {
            status: None,
            assigned_to: Some(None),
        };
        assert!(!untouched.is_empty() && !cleared.is_empty());
        // The flag the UPDATE binds: false leaves the column, true writes it.
        assert!(untouched.assigned_to.is_none());
        assert_eq!(cleared.assigned_to, Some(None));
        assert!(GroupTriageUpdate::default().is_empty());
        assert!(TenantSettingsUpdate::default().is_empty());
    }

    #[test]
    fn triage_pages_are_bounded_in_both_directions() {
        let query = GroupQuery::default();
        assert_eq!(query.limit, 50);
        assert_eq!(query.limit.clamp(1, MAX_TRIAGE_PAGE), 50);
        assert_eq!(i64::MAX.clamp(1, MAX_TRIAGE_PAGE), MAX_TRIAGE_PAGE);
        assert_eq!(0_i64.clamp(1, MAX_TRIAGE_PAGE), 1);
        let negative_offset: i64 = -5;
        assert_eq!(negative_offset.max(0), 0);
    }
}
