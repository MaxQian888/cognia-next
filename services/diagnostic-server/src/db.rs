use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::model::{IncidentState, ProcessingState};

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
    pub consent_withdrawn_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
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
    pub created_at: DateTime<Utc>,
}

impl DiagnosticRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn health(&self) -> anyhow::Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
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

    pub async fn create_incident(&self, input: CreateIncident) -> anyhow::Result<IncidentRecord> {
        let mut tx = self.tenant_transaction(input.tenant_id).await?;
        let record = sqlx::query_as::<_, IncidentRecord>(
            r#"INSERT INTO incidents (
                id, tenant_id, project_id, installation_id, artifact_hash, build_id,
                platform, module, exception, deletion_credential_hash
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (tenant_id, project_id, artifact_hash)
            DO UPDATE SET updated_at = incidents.updated_at
            RETURNING id, tenant_id, project_id, installation_id, artifact_hash, build_id,
                platform, module, exception, client_state, processing_state, support_code,
                fingerprint, consent_withdrawn_at, created_at, updated_at"#,
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
            record.tenant_id,
            "incident.created",
            record.id,
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
                fingerprint, consent_withdrawn_at, created_at, updated_at
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
                stored_sha256, stored_bytes, redaction_version, removed_fields
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (tenant_id, incident_id, part_number) DO UPDATE SET
                object_key = EXCLUDED.object_key,
                source_sha256 = EXCLUDED.source_sha256,
                stored_sha256 = EXCLUDED.stored_sha256,
                stored_bytes = EXCLUDED.stored_bytes,
                redaction_version = EXCLUDED.redaction_version,
                removed_fields = EXCLUDED.removed_fields,
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
                stored_bytes, redaction_version, removed_fields, created_at
            FROM upload_parts WHERE incident_id = $1 ORDER BY part_number"#,
        )
        .bind(incident_id)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(parts)
    }

    pub async fn mark_processing(
        &self,
        tenant_id: Uuid,
        incident_id: Uuid,
        fingerprint: &str,
    ) -> anyhow::Result<IncidentRecord> {
        let mut tx = self.tenant_transaction(tenant_id).await?;
        let record = sqlx::query_as::<_, IncidentRecord>(
            r#"UPDATE incidents SET client_state = 'processing', processing_state = 'grouping',
                fingerprint = $2, updated_at = now()
            WHERE id = $1 AND consent_withdrawn_at IS NULL
            RETURNING id, tenant_id, project_id, installation_id, artifact_hash, build_id,
                platform, module, exception, client_state, processing_state, support_code,
                fingerprint, consent_withdrawn_at, created_at, updated_at"#,
        )
        .bind(incident_id)
        .bind(fingerprint)
        .fetch_one(&mut *tx)
        .await?;
        audit(&mut tx, tenant_id, "incident.processing", incident_id, None).await?;
        tx.commit().await?;
        Ok(record)
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
        audit(&mut tx, tenant_id, action, incident_id, None).await?;
        tx.commit().await?;
        Ok(())
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

async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    action: &str,
    incident_id: Uuid,
    details: Option<serde_json::Value>,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO audit_events (tenant_id, action, incident_id, details) VALUES ($1, $2, $3, $4)",
    )
    .bind(tenant_id)
    .bind(action)
    .bind(incident_id)
    .bind(details.unwrap_or_else(|| serde_json::json!({})))
    .execute(&mut **tx)
    .await?;
    Ok(())
}
