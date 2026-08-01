use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    model::{IncidentState, ProcessingState},
    processing::{retry_delay, ProcessingFailure},
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
                fingerprint, processing_attempts, next_processing_at, failure_code,
                grouping_basis, raw_stack, symbolized_stack, missing_symbols, group_id,
                accepted_at, consent_withdrawn_at, created_at, updated_at"#,
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

async fn audit_admin(
    tx: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    action: &str,
    details: Option<serde_json::Value>,
) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO audit_events (tenant_id, action, details) VALUES ($1, $2, $3)")
        .bind(tenant_id)
        .bind(action)
        .bind(details.unwrap_or_else(|| serde_json::json!({})))
        .execute(&mut **tx)
        .await?;
    Ok(())
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
}
