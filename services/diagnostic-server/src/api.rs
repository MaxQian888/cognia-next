use std::{sync::Arc, time::Duration};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tower_http::{
    cors::CorsLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::TraceLayer,
};
use uuid::Uuid;

use crate::{
    auth::{
        validate_request_timestamp, verify_installation_signature, verify_oidc_session,
        GrantClaims, GrantRole, GrantSigner,
    },
    config::ServerConfig,
    db::{
        AuditEventRecord, CreateIncident, CreateSymbol, DiagnosticRepository, GroupQuery,
        GroupTriageUpdate, IncidentGroupRecord, IncidentQuery, IncidentRecord, SymbolRecord,
        TenantRecord, TenantSettingsUpdate, UploadPartRecord, MAX_TRIAGE_PAGE,
    },
    model::{
        IncidentLimits, ProcessingState, MAX_ATTACHMENT_BYTES, MAX_INCIDENT_BYTES,
        MAX_MINIDUMP_BYTES,
    },
    privacy::PrivacyGate,
    processing::validate_symbol_relative_path,
    storage::ArtifactStore,
};

const GRANT_TTL: Duration = Duration::from_secs(15 * 60);
const PROOF_TOLERANCE: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<ServerConfig>,
    pub repository: DiagnosticRepository,
    pub artifacts: ArtifactStore,
    pub grants: GrantSigner,
    pub privacy: PrivacyGate,
}

impl AppState {
    pub fn new(
        config: Arc<ServerConfig>,
        repository: DiagnosticRepository,
        artifacts: ArtifactStore,
        grants: GrantSigner,
        privacy: PrivacyGate,
    ) -> Self {
        Self {
            config,
            repository,
            artifacts,
            grants,
            privacy,
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    let ingest_enabled = state.config.ingest_enabled;
    let mut router = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/openapi.yaml", get(openapi));

    // Grant exchange is *not* intake and is deliberately outside the switch.
    //
    // Every route the kill switch is documented to keep up — read, withdraw,
    // delete, triage, admin — needs a bearer grant, and grants live 15 minutes.
    // Answering the exchange with 503 therefore locked the whole service out
    // a quarter of an hour after the switch flipped, which is exactly when a
    // deletion request has to be servable. A grant issued while intake is off
    // can still only reach routes that are themselves still mounted.
    router = router
        .route("/v1/grants/oidc", post(exchange_oidc))
        .route("/v1/grants/anonymous", post(exchange_anonymous));

    // The intake surface, behind its own switch. Turning it off is the
    // rollback for "stop taking reports right now" and deliberately leaves the
    // read, withdraw and admin routes mounted — an operator containing an
    // intake problem still has to be able to serve deletion requests.
    //
    // `POST /v1/incidents` is intake; `GET /v1/incidents` is the console's
    // triage list and stays up regardless. They share a path, so the method
    // router is built once with the intake half swapped rather than
    // registering the same path twice.
    //
    // The disabled half answers rather than 404s: a client that gets "not
    // found" retries forever against a spooled report, while 503 is the
    // documented "come back later" that the upload client already understands.
    router = router.route(
        "/v1/incidents",
        if ingest_enabled {
            get(list_incidents).post(create_incident)
        } else {
            get(list_incidents).post(ingest_disabled)
        },
    );

    if ingest_enabled {
        router = router
            .route("/v1/incidents/{incident_id}/parts", get(upload_progress))
            .route(
                "/v1/incidents/{incident_id}/parts/{part_number}",
                put(upload_part),
            )
            .route(
                "/v1/incidents/{incident_id}/complete",
                post(complete_upload),
            )
            .route("/v1/incidents/{incident_id}/cancel", post(cancel_upload));
    } else {
        router = router
            .route("/v1/incidents/{incident_id}/parts", get(ingest_disabled))
            .route(
                "/v1/incidents/{incident_id}/parts/{part_number}",
                put(ingest_disabled),
            )
            .route(
                "/v1/incidents/{incident_id}/complete",
                post(ingest_disabled),
            )
            .route("/v1/incidents/{incident_id}/cancel", post(ingest_disabled));
    }

    router
        .route(
            "/v1/incidents/{incident_id}",
            get(get_incident).delete(delete_incident),
        )
        .route(
            "/v1/incidents/{incident_id}/withdraw",
            post(withdraw_consent),
        )
        .route("/v1/incidents/{incident_id}/audit", get(incident_audit))
        // The console's own view of stored artifacts. Separate from
        // `/parts` — that one is the uploader's resume inventory and rides the
        // intake switch, while triage has to keep working with intake off.
        .route("/v1/incidents/{incident_id}/artifacts", get(list_artifacts))
        .route(
            "/v1/incidents/{incident_id}/artifacts/{part_number}",
            get(download_artifact),
        )
        .route("/v1/groups", get(list_groups))
        .route("/v1/groups/{group_id}", get(get_group).patch(triage_group))
        .route("/v1/admin/symbols", get(list_symbols))
        .route(
            "/v1/admin/symbols/{build_id}/{platform}",
            put(upload_symbol),
        )
        .route("/v1/admin/tenant", get(get_tenant).patch(update_tenant))
        .route(
            "/v1/admin/tenant-key",
            post(rotate_tenant_key).delete(crypto_shred_tenant),
        )
        .layer(DefaultBodyLimit::max(MAX_MINIDUMP_BYTES as usize))
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::very_permissive())
        .with_state(state)
}

async fn live() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn ready(State(state): State<AppState>) -> ApiResult<StatusCode> {
    state
        .repository
        .health()
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Stand-in for every intake route while `DIAGNOSTIC_INGEST_ENABLED` is off.
async fn ingest_disabled() -> ApiError {
    ApiError::service_unavailable("ingest_disabled")
}

async fn openapi() -> impl IntoResponse {
    (
        [
            ("content-type", "application/yaml; charset=utf-8"),
            ("cache-control", "public, max-age=300"),
        ],
        include_str!("../openapi.yaml"),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OidcGrantRequest {
    session_token: String,
    installation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnonymousGrantRequest {
    tenant_id: Uuid,
    project_id: Uuid,
    installation_id: String,
    public_key: String,
    signature: String,
    nonce: String,
    timestamp: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GrantResponse {
    grant: String,
    /// Echoed so a console can render the surfaces this operator may use
    /// instead of discovering its own permissions through 403s.
    role: GrantRole,
    expires_in_seconds: u64,
}

async fn exchange_oidc(
    State(state): State<AppState>,
    Json(request): Json<OidcGrantRequest>,
) -> ApiResult<Json<GrantResponse>> {
    let (tenant_id, project_id, subject, role) = verify_oidc_session(
        &request.session_token,
        &state.config.oidc_issuer,
        &state.config.oidc_audience,
        &state.config.oidc_public_key_pem,
    )
    .map_err(|_| ApiError::unauthorized("invalid_oidc_session"))?;
    let grant = state
        .grants
        .issue(
            tenant_id,
            project_id,
            request.installation_id,
            role,
            // The OIDC subject rides the grant so every triage edit and raw
            // artifact read this session performs names a person in the
            // audit trail instead of leaving `actor_id` null.
            Some(subject),
            GRANT_TTL,
        )
        .map_err(ApiError::internal)?;
    Ok(Json(GrantResponse {
        grant,
        role,
        expires_in_seconds: GRANT_TTL.as_secs(),
    }))
}

async fn exchange_anonymous(
    State(state): State<AppState>,
    Json(request): Json<AnonymousGrantRequest>,
) -> ApiResult<Json<GrantResponse>> {
    if request.installation_id.len() > 128 || request.nonce.len() > 128 || request.nonce.len() < 16
    {
        return Err(ApiError::bad_request("invalid_installation_proof"));
    }
    validate_request_timestamp(request.timestamp, PROOF_TOLERANCE)
        .map_err(|_| ApiError::unauthorized("expired_installation_proof"))?;
    let message = format!(
        "{}\n{}\n{}\n{}\n{}",
        request.tenant_id,
        request.project_id,
        request.installation_id,
        request.nonce,
        request.timestamp
    );
    let public_key = STANDARD
        .decode(request.public_key)
        .map_err(|_| ApiError::bad_request("invalid_installation_public_key"))?;
    let signature = STANDARD
        .decode(request.signature)
        .map_err(|_| ApiError::bad_request("invalid_installation_signature"))?;
    verify_installation_signature(&public_key, &signature, message.as_bytes())
        .map_err(|_| ApiError::unauthorized("invalid_installation_signature"))?;
    let fresh = state
        .repository
        .register_nonce(
            request.tenant_id,
            &request.nonce,
            Utc::now() + ChronoDuration::from_std(PROOF_TOLERANCE).expect("valid duration"),
        )
        .await
        .map_err(ApiError::internal)?;
    if !fresh {
        return Err(ApiError::conflict("installation_proof_replayed"));
    }
    let grant = state
        .grants
        .issue(
            request.tenant_id,
            request.project_id,
            request.installation_id,
            GrantRole::Uploader,
            // An installation proof authenticates a machine, not a person.
            // Naming one would make the audit trail lie.
            None,
            GRANT_TTL,
        )
        .map_err(ApiError::internal)?;
    Ok(Json(GrantResponse {
        grant,
        role: GrantRole::Uploader,
        expires_in_seconds: GRANT_TTL.as_secs(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateIncidentRequest {
    artifact_hash: String,
    build_id: String,
    platform: String,
    module: String,
    exception: String,
    attachment_count: usize,
    event_count: usize,
    total_bytes: u64,
    largest_attachment_bytes: u64,
    largest_minidump_bytes: u64,
    consent: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateIncidentResponse {
    incident: IncidentRecord,
    /// True when this call created the incident, false when an identical
    /// artifact hash resumed an existing one.
    created: bool,
    /// One-time credential, present only on creation.
    ///
    /// The upsert deliberately leaves `deletion_credential_hash` untouched on
    /// conflict, so minting a fresh credential for a resumed incident would
    /// hand the client a string that can never verify against the stored hash.
    /// A resuming client keeps the credential it stored the first time.
    #[serde(skip_serializing_if = "Option::is_none")]
    deletion_credential: Option<String>,
}

async fn create_incident(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateIncidentRequest>,
) -> ApiResult<(StatusCode, Json<CreateIncidentResponse>)> {
    let claims = authorize(&state, &headers, GrantRole::Uploader)?;
    if !request.consent {
        return Err(ApiError::bad_request("consent_required"));
    }
    IncidentLimits {
        attachment_count: request.attachment_count,
        event_count: request.event_count,
        total_bytes: request.total_bytes,
        largest_attachment_bytes: request.largest_attachment_bytes,
        largest_minidump_bytes: request.largest_minidump_bytes,
    }
    .validate()
    .map_err(|violation| ApiError::payload_too_large(&format!("{violation:?}")))?;
    validate_hex_sha256(&request.artifact_hash)?;
    let deletion_credential = format!("del_{}", Uuid::new_v4().simple());
    let deletion_credential_hash = sha256_hex(deletion_credential.as_bytes());
    let created = state
        .repository
        .create_incident(CreateIncident {
            id: Uuid::new_v4(),
            tenant_id: claims.tenant_id,
            project_id: claims.project_id,
            installation_id: claims.installation_id,
            artifact_hash: request.artifact_hash,
            build_id: request.build_id,
            platform: request.platform,
            module: request.module,
            exception: request.exception,
            deletion_credential_hash: Some(deletion_credential_hash),
        })
        .await
        .map_err(ApiError::internal)?;
    Ok((
        StatusCode::CREATED,
        Json(CreateIncidentResponse {
            incident: created.incident,
            created: created.inserted,
            deletion_credential: created.inserted.then_some(deletion_credential),
        }),
    ))
}

async fn get_incident(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(incident_id): Path<Uuid>,
) -> ApiResult<Json<IncidentRecord>> {
    let claims = authorize(&state, &headers, GrantRole::Uploader)?;
    Ok(Json(owned_incident(&state, &claims, incident_id).await?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgressResponse {
    incident_id: Uuid,
    parts: Vec<UploadPartRecord>,
    stored_bytes: i64,
}

async fn upload_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(incident_id): Path<Uuid>,
) -> ApiResult<Json<UploadProgressResponse>> {
    let claims = authorize(&state, &headers, GrantRole::Uploader)?;
    owned_incident(&state, &claims, incident_id).await?;
    let parts = state
        .repository
        .parts(claims.tenant_id, incident_id)
        .await
        .map_err(ApiError::internal)?;
    let stored_bytes = parts.iter().map(|part| part.stored_bytes).sum();
    Ok(Json(UploadProgressResponse {
        incident_id,
        parts,
        stored_bytes,
    }))
}

async fn upload_part(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((incident_id, part_number)): Path<(Uuid, i32)>,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<UploadPartRecord>)> {
    let claims = authorize(&state, &headers, GrantRole::Uploader)?;
    owned_incident(&state, &claims, incident_id).await?;
    if !(1..=10_000).contains(&part_number) {
        return Err(ApiError::bad_request("invalid_part_number"));
    }
    let source_sha256 = required_header(&headers, "x-part-sha256")?;
    validate_hex_sha256(source_sha256)?;
    if sha256_hex(&body) != source_sha256 {
        return Err(ApiError::unprocessable("part_checksum_mismatch"));
    }
    let artifact_kind = headers
        .get("x-artifact-kind")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("attachment");
    validate_artifact_kind(artifact_kind)?;
    let limit = if artifact_kind == "minidump" {
        MAX_MINIDUMP_BYTES
    } else {
        MAX_ATTACHMENT_BYTES
    };
    if body.len() as u64 > limit {
        return Err(ApiError::payload_too_large("part_too_large"));
    }
    let scan = state.privacy.scan(&body);
    if let Some(kind) = scan.rejected_credential_kind {
        return Err(ApiError::unprocessable(&format!(
            "credential_detected:{kind}"
        )));
    }
    let stored_sha256 = sha256_hex(&scan.sanitized);
    let object_key = format!(
        "tenants/{}/projects/{}/incidents/{incident_id}/parts/{part_number:05}",
        claims.tenant_id, claims.project_id
    );
    state
        .artifacts
        .put_part(claims.tenant_id, &object_key, scan.sanitized.clone())
        .await
        .map_err(ApiError::internal)?;
    let record = UploadPartRecord {
        incident_id,
        part_number,
        object_key: object_key.clone(),
        source_sha256: source_sha256.to_owned(),
        stored_sha256,
        stored_bytes: scan.sanitized.len() as i64,
        redaction_version: scan.redaction_version.to_owned(),
        removed_fields: scan.removed_fields.into_iter().map(str::to_owned).collect(),
        artifact_kind: artifact_kind.to_owned(),
        created_at: Utc::now(),
    };
    if let Err(error) = state
        .repository
        .upsert_part(claims.tenant_id, &record)
        .await
    {
        let _ = state.artifacts.delete(&object_key).await;
        return Err(ApiError::internal(error));
    }
    Ok((StatusCode::CREATED, Json(record)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteUploadRequest {
    #[serde(default, rename = "symbolizedFrames")]
    _legacy_symbolized_frames: Vec<String>,
}

async fn complete_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(incident_id): Path<Uuid>,
    _request: Option<Json<CompleteUploadRequest>>,
) -> ApiResult<Json<IncidentRecord>> {
    let claims = authorize(&state, &headers, GrantRole::Uploader)?;
    owned_incident(&state, &claims, incident_id).await?;
    let parts = state
        .repository
        .parts(claims.tenant_id, incident_id)
        .await
        .map_err(ApiError::internal)?;
    if parts.is_empty() {
        return Err(ApiError::conflict("upload_has_no_parts"));
    }
    let total_bytes: u64 = parts.iter().map(|part| part.stored_bytes as u64).sum();
    if total_bytes > MAX_INCIDENT_BYTES {
        return Err(ApiError::payload_too_large("incident_too_large"));
    }
    let incident = state
        .repository
        .queue_processing(claims.tenant_id, incident_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(incident))
}

async fn cancel_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(incident_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let claims = authorize(&state, &headers, GrantRole::Uploader)?;
    owned_incident(&state, &claims, incident_id).await?;
    delete_artifacts(&state, claims.tenant_id, incident_id).await?;
    state
        .repository
        .cancel(claims.tenant_id, incident_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn withdraw_consent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(incident_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let claims = authorize(&state, &headers, GrantRole::Uploader)?;
    owned_incident(&state, &claims, incident_id).await?;
    state
        .repository
        .withdraw(claims.tenant_id, incident_id)
        .await
        .map_err(ApiError::internal)?;
    delete_artifacts(&state, claims.tenant_id, incident_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_incident(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(incident_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let claims = authorize(&state, &headers, GrantRole::Uploader)?;
    owned_incident(&state, &claims, incident_id).await?;
    delete_artifacts(&state, claims.tenant_id, incident_id).await?;
    state
        .repository
        .delete(claims.tenant_id, incident_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Triage console
//
// Everything below is Viewer-or-better and scoped by the grant's tenant and
// project. `authorize(.., Uploader)` admits every role, so the read routes an
// installation legitimately needs (its own receipt, its own withdrawal) stay
// where they are; these are the routes an uploader must *not* reach, and they
// say so by requiring Viewer.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListGroupsQuery {
    status: Option<String>,
    platform: Option<String>,
    assigned_to: Option<String>,
    /// Substring match over exception, module, and fingerprint.
    q: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn list_groups(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListGroupsQuery>,
) -> ApiResult<Json<Vec<IncidentGroupRecord>>> {
    let claims = authorize(&state, &headers, GrantRole::Viewer)?;
    if let Some(status) = &query.status {
        crate::db::validate_group_status(status)
            .map_err(|_| ApiError::bad_request("invalid_group_status"))?;
    }
    let groups = state
        .repository
        .list_groups(
            claims.tenant_id,
            claims.project_id,
            &GroupQuery {
                status: query.status,
                platform: query.platform,
                assigned_to: query.assigned_to,
                search: query.q.filter(|value| !value.trim().is_empty()),
                limit: query.limit.unwrap_or(50),
                offset: query.offset.unwrap_or(0),
            },
        )
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(groups))
}

async fn get_group(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(group_id): Path<Uuid>,
) -> ApiResult<Json<IncidentGroupRecord>> {
    let claims = authorize(&state, &headers, GrantRole::Viewer)?;
    state
        .repository
        .group(claims.tenant_id, claims.project_id, group_id)
        .await
        .map_err(ApiError::internal)?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("group_not_found"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TriageGroupRequest {
    status: Option<String>,
    /// Absent leaves the assignee alone; an explicit `null` unassigns.
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    assigned_to: Option<Option<String>>,
}

async fn triage_group(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(group_id): Path<Uuid>,
    Json(request): Json<TriageGroupRequest>,
) -> ApiResult<Json<IncidentGroupRecord>> {
    let claims = authorize(&state, &headers, GrantRole::Triager)?;
    let assigned_to = match request.assigned_to {
        // An assignee is an identity string from the operator's directory, not
        // free-form prose: bound so a paste accident cannot fill the column.
        Some(Some(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Some(None)
            } else if trimmed.len() > 256 {
                return Err(ApiError::bad_request("assignee_too_long"));
            } else {
                Some(Some(trimmed.to_owned()))
            }
        }
        Some(None) => Some(None),
        None => None,
    };
    let update = GroupTriageUpdate {
        status: request.status,
        assigned_to,
    };
    if update.is_empty() {
        return Err(ApiError::bad_request("empty_triage_update"));
    }
    if let Some(status) = &update.status {
        crate::db::validate_group_status(status)
            .map_err(|_| ApiError::bad_request("invalid_group_status"))?;
    }
    state
        .repository
        .update_group(
            claims.tenant_id,
            claims.project_id,
            group_id,
            &update,
            claims.actor_id.as_deref(),
        )
        .await
        .map_err(ApiError::internal)?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("group_not_found"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListIncidentsQuery {
    group_id: Option<Uuid>,
    processing_state: Option<ProcessingState>,
    support_code: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn list_incidents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListIncidentsQuery>,
) -> ApiResult<Json<Vec<IncidentRecord>>> {
    let claims = authorize(&state, &headers, GrantRole::Viewer)?;
    let incidents = state
        .repository
        .list_incidents(
            claims.tenant_id,
            claims.project_id,
            &IncidentQuery {
                group_id: query.group_id,
                processing_state: query.processing_state,
                support_code: query.support_code.filter(|code| !code.trim().is_empty()),
                limit: query.limit.unwrap_or(50),
                offset: query.offset.unwrap_or(0),
            },
        )
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(incidents))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditQuery {
    limit: Option<i64>,
}

async fn incident_audit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(incident_id): Path<Uuid>,
    Query(query): Query<AuditQuery>,
) -> ApiResult<Json<Vec<AuditEventRecord>>> {
    let claims = authorize(&state, &headers, GrantRole::Viewer)?;
    owned_incident(&state, &claims, incident_id).await?;
    let events = state
        .repository
        .incident_audit(
            claims.tenant_id,
            incident_id,
            query.limit.unwrap_or(MAX_TRIAGE_PAGE),
        )
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(events))
}

async fn list_artifacts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(incident_id): Path<Uuid>,
) -> ApiResult<Json<Vec<UploadPartRecord>>> {
    let claims = authorize(&state, &headers, GrantRole::Viewer)?;
    owned_incident(&state, &claims, incident_id).await?;
    let parts = state
        .repository
        .parts(claims.tenant_id, incident_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(parts))
}

/// Hand one stored artifact back, decrypted.
///
/// Minidumps are the one artifact class that can still hold process memory
/// after the privacy gate, so they are gated a second time on the tenant's own
/// `raw_minidump_access_enabled` opt-in — the column that existed from the
/// first migration and until now was never read. Every read is audited with
/// the operator's identity *before* the bytes leave, so an attempt that fails
/// downstream is still on the immutable trail.
async fn download_artifact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((incident_id, part_number)): Path<(Uuid, i32)>,
) -> ApiResult<Response> {
    let claims = authorize(&state, &headers, GrantRole::Triager)?;
    owned_incident(&state, &claims, incident_id).await?;
    let part = state
        .repository
        .part(claims.tenant_id, incident_id, part_number)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("artifact_not_found"))?;
    if part.artifact_kind == "minidump"
        && !state
            .repository
            .raw_minidump_access_enabled(claims.tenant_id)
            .await
            .map_err(ApiError::internal)?
    {
        return Err(ApiError::forbidden("raw_minidump_access_disabled"));
    }
    state
        .repository
        .record_artifact_access(
            claims.tenant_id,
            incident_id,
            &part,
            claims.actor_id.as_deref(),
        )
        .await
        .map_err(ApiError::internal)?;
    let body = state
        .artifacts
        .get(claims.tenant_id, &part.object_key)
        .await
        .map_err(ApiError::internal)?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename=\"{incident_id}-{part_number:05}-{}\"",
                    part.artifact_kind
                ),
            ),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        body,
    )
        .into_response())
}

async fn get_tenant(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<TenantRecord>> {
    let claims = authorize(&state, &headers, GrantRole::Admin)?;
    state
        .repository
        .tenant(claims.tenant_id)
        .await
        .map_err(ApiError::internal)?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("tenant_not_found"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTenantRequest {
    raw_minidump_access_enabled: Option<bool>,
    retention_overrides: Option<serde_json::Value>,
}

async fn update_tenant(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<UpdateTenantRequest>,
) -> ApiResult<Json<TenantRecord>> {
    let claims = authorize(&state, &headers, GrantRole::Admin)?;
    if let Some(overrides) = &request.retention_overrides {
        if !overrides.is_object() {
            return Err(ApiError::bad_request("retention_overrides_must_be_object"));
        }
    }
    let update = TenantSettingsUpdate {
        raw_minidump_access_enabled: request.raw_minidump_access_enabled,
        retention_overrides: request.retention_overrides,
    };
    if update.is_empty() {
        return Err(ApiError::bad_request("empty_tenant_update"));
    }
    state
        .repository
        .update_tenant_settings(claims.tenant_id, &update, claims.actor_id.as_deref())
        .await
        .map_err(ApiError::internal)?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("tenant_not_found"))
}

/// Distinguish "field absent" from "field explicitly null" in a PATCH body.
///
/// Serde collapses both to `None` for a plain `Option<T>`; wrapping in a second
/// `Option` and requiring the field to have been present is what lets the
/// console unassign a group instead of only ever reassigning it.
fn deserialize_optional_field<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSymbolsQuery {
    build_id: Option<String>,
}

async fn list_symbols(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListSymbolsQuery>,
) -> ApiResult<Json<Vec<SymbolRecord>>> {
    let claims = authorize(&state, &headers, GrantRole::Admin)?;
    let symbols = state
        .repository
        .symbols(
            claims.tenant_id,
            claims.project_id,
            query.build_id.as_deref(),
        )
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(symbols))
}

async fn upload_symbol(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((build_id, platform)): Path<(String, String)>,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<SymbolRecord>)> {
    let claims = authorize(&state, &headers, GrantRole::Admin)?;
    if !validate_path_segment(&build_id, 256) || !validate_path_segment(&platform, 64) {
        return Err(ApiError::bad_request("invalid_symbol_identity"));
    }
    let sha256 = required_header(&headers, "x-symbol-sha256")?;
    validate_hex_sha256(sha256)?;
    if sha256_hex(&body) != sha256 {
        return Err(ApiError::unprocessable("symbol_checksum_mismatch"));
    }
    let relative_path = required_header(&headers, "x-symbol-relative-path")?;
    if relative_path.len() > 512 || !validate_symbol_relative_path(relative_path) {
        return Err(ApiError::bad_request("invalid_symbol_relative_path"));
    }
    let symbol_type = required_header(&headers, "x-symbol-type")?;
    if !matches!(
        symbol_type,
        "breakpad" | "pdb" | "dsym" | "elf" | "android_mapping" | "android_native" | "source_map"
    ) {
        return Err(ApiError::bad_request("invalid_symbol_type"));
    }
    let object_key = format!(
        "tenants/{}/projects/{}/symbols/{}/{}/{}",
        claims.tenant_id, claims.project_id, build_id, platform, sha256
    );
    state
        .artifacts
        .put_part(claims.tenant_id, &object_key, body.to_vec())
        .await
        .map_err(ApiError::internal)?;
    let record = match state
        .repository
        .upsert_symbol(CreateSymbol {
            tenant_id: claims.tenant_id,
            project_id: claims.project_id,
            build_id,
            platform,
            object_key: object_key.clone(),
            relative_path: relative_path.to_owned(),
            symbol_type: symbol_type.to_owned(),
            sha256: sha256.to_owned(),
        })
        .await
    {
        Ok(record) => record,
        Err(error) => {
            let _ = state.artifacts.delete(&object_key).await;
            return Err(ApiError::internal(error));
        }
    };
    Ok((StatusCode::CREATED, Json(record)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RotateTenantKeyResponse {
    key_version: i32,
}

async fn rotate_tenant_key(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<RotateTenantKeyResponse>> {
    let claims = authorize(&state, &headers, GrantRole::Admin)?;
    let key_version = state
        .artifacts
        .rotate_tenant_key(claims.tenant_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(RotateTenantKeyResponse { key_version }))
}

async fn crypto_shred_tenant(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let claims = authorize(&state, &headers, GrantRole::Admin)?;
    let confirmation = required_header(&headers, "x-confirm-crypto-shred")?;
    if confirmation != claims.tenant_id.to_string() {
        return Err(ApiError::bad_request("crypto_shred_confirmation_mismatch"));
    }
    state
        .artifacts
        .crypto_shred_tenant(claims.tenant_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_artifacts(state: &AppState, tenant_id: Uuid, incident_id: Uuid) -> ApiResult<()> {
    let parts = state
        .repository
        .parts(tenant_id, incident_id)
        .await
        .map_err(ApiError::internal)?;
    state
        .artifacts
        .delete_many(
            &parts
                .into_iter()
                .map(|part| part.object_key)
                .collect::<Vec<_>>(),
        )
        .await
        .map_err(ApiError::internal)
}

fn authorize(state: &AppState, headers: &HeaderMap, role: GrantRole) -> ApiResult<GrantClaims> {
    let authorization = required_header(headers, "authorization")?;
    let token = authorization
        .strip_prefix("Bearer ")
        .ok_or_else(|| ApiError::unauthorized("invalid_authorization_scheme"))?;
    let claims = state
        .grants
        .verify(token)
        .map_err(|_| ApiError::unauthorized("invalid_upload_grant"))?;
    if !claims.role.permits(role) {
        return Err(ApiError::forbidden("insufficient_grant_scope"));
    }
    Ok(claims)
}

async fn owned_incident(
    state: &AppState,
    claims: &GrantClaims,
    incident_id: Uuid,
) -> ApiResult<IncidentRecord> {
    let incident = state
        .repository
        .incident(claims.tenant_id, claims.project_id, incident_id)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("incident_not_found"))?;
    if claims.role == GrantRole::Uploader && incident.installation_id != claims.installation_id {
        return Err(ApiError::not_found("incident_not_found"));
    }
    Ok(incident)
}

fn required_header<'a>(headers: &'a HeaderMap, name: &str) -> ApiResult<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::bad_request(&format!("missing_header:{name}")))
}

fn validate_hex_sha256(value: &str) -> ApiResult<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request("invalid_sha256"));
    }
    Ok(())
}

fn validate_artifact_kind(value: &str) -> ApiResult<()> {
    if matches!(
        value,
        "manifest" | "events" | "attachment" | "minidump" | "screenshot"
    ) {
        Ok(())
    } else {
        Err(ApiError::bad_request("invalid_artifact_kind"))
    }
}

fn validate_path_segment(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: String,
}

impl ApiError {
    fn bad_request(code: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code)
    }

    fn unauthorized(code: &str) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code)
    }

    fn forbidden(code: &str) -> Self {
        Self::new(StatusCode::FORBIDDEN, code)
    }

    fn not_found(code: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, code)
    }

    fn conflict(code: &str) -> Self {
        Self::new(StatusCode::CONFLICT, code)
    }

    fn payload_too_large(code: &str) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, code)
    }

    fn unprocessable(code: &str) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, code)
    }

    fn service_unavailable(code: &str) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, code)
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(error = %error, "diagnostic request failed");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
    }

    fn new(status: StatusCode, code: &str) -> Self {
        Self {
            status,
            code: code.to_owned(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({
                "error": {"code": self.code}
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{crypto::TenantKeyManager, kms::AwsKmsClient};
    use axum::body::Body;
    use axum::http::Request;
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    /// A router over lazily-connected dependencies.
    ///
    /// Nothing here dials Postgres, S3, or KMS: every assertion below is
    /// answered by routing or by the grant check, both of which run before the
    /// first query. A test that did reach the database would fail loudly on
    /// connect rather than pass by accident.
    fn router(ingest_enabled: bool) -> (Router, GrantSigner) {
        let config = Arc::new(ServerConfig::for_router_tests(ingest_enabled));
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy(&config.database_url)
            .expect("lazy pool");
        let repository = DiagnosticRepository::new(pool);
        let kms = AwsKmsClient::new(
            config.kms_endpoint.clone(),
            config.kms_region.clone(),
            config.kms_key_id.clone(),
            config.kms_access_key_id.clone(),
            config.kms_secret_access_key.clone(),
            None,
            config.kms_timeout,
        )
        .expect("kms client");
        let artifacts = ArtifactStore::in_memory(TenantKeyManager::new(
            Arc::new(repository.clone()),
            Arc::new(kms),
            config.kms_key_id.clone(),
        ));
        let signer = GrantSigner::new(config.grant_signing_key.as_bytes()).expect("signer");
        let state = AppState::new(
            config,
            repository,
            artifacts,
            signer.clone(),
            PrivacyGate::v1(),
        );
        (build_router(state), signer)
    }

    fn grant(signer: &GrantSigner, role: GrantRole) -> String {
        signer
            .issue(
                Uuid::new_v4(),
                Uuid::new_v4(),
                "install-test".to_owned(),
                role,
                None,
                Duration::from_secs(60),
            )
            .expect("issue grant")
    }

    async fn status_of(router: &Router, request: Request<Body>) -> StatusCode {
        router
            .clone()
            .oneshot(request)
            .await
            .expect("router response")
            .status()
    }

    #[tokio::test]
    async fn the_intake_switch_stops_uploads_without_locking_the_console_out() {
        let (router, _) = router(false);

        // Intake itself is closed.
        assert_eq!(
            status_of(
                &router,
                Request::post("/v1/incidents")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap()
            )
            .await,
            StatusCode::SERVICE_UNAVAILABLE
        );

        // Grant exchange is not intake. It used to answer 503 here, which meant
        // every route the switch is documented to keep up became unreachable
        // once the last 15-minute grant expired. A bad session is now rejected
        // on its merits (401) rather than by the switch.
        assert_eq!(
            status_of(
                &router,
                Request::post("/v1/grants/oidc")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"sessionToken":"not-a-jwt","installationId":"install-test"}"#
                    ))
                    .unwrap()
            )
            .await,
            StatusCode::UNAUTHORIZED
        );

        // And triage stays mounted: no auth header is a 400, not a 404.
        assert_eq!(
            status_of(
                &router,
                Request::get("/v1/groups").body(Body::empty()).unwrap()
            )
            .await,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn an_upload_grant_cannot_reach_the_triage_console() {
        let (router, signer) = router(true);
        let uploader = grant(&signer, GrantRole::Uploader);
        for path in [
            "/v1/groups",
            "/v1/incidents",
            "/v1/admin/symbols",
            "/v1/admin/tenant",
        ] {
            assert_eq!(
                status_of(
                    &router,
                    Request::get(path)
                        .header("authorization", format!("Bearer {uploader}"))
                        .body(Body::empty())
                        .unwrap()
                )
                .await,
                StatusCode::FORBIDDEN,
                "{path} must refuse an upload-only grant"
            );
        }
    }

    #[tokio::test]
    async fn triage_and_admin_sit_at_different_heights() {
        let (router, signer) = router(true);
        let viewer = grant(&signer, GrantRole::Viewer);
        let incident = Uuid::new_v4();
        // A Viewer may read groups but may not edit them…
        assert_eq!(
            status_of(
                &router,
                Request::patch(format!("/v1/groups/{}", Uuid::new_v4()))
                    .header("authorization", format!("Bearer {viewer}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"status":"resolved"}"#))
                    .unwrap()
            )
            .await,
            StatusCode::FORBIDDEN
        );
        // …and may not pull raw artifact bytes, which is Triager-only.
        assert_eq!(
            status_of(
                &router,
                Request::get(format!("/v1/incidents/{incident}/artifacts/1"))
                    .header("authorization", format!("Bearer {viewer}"))
                    .body(Body::empty())
                    .unwrap()
            )
            .await,
            StatusCode::FORBIDDEN
        );
        // Triager is still not Admin.
        let triager = grant(&signer, GrantRole::Triager);
        assert_eq!(
            status_of(
                &router,
                Request::get("/v1/admin/tenant")
                    .header("authorization", format!("Bearer {triager}"))
                    .body(Body::empty())
                    .unwrap()
            )
            .await,
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn every_console_route_is_in_the_published_contract() {
        // The spec is `include_str!`-ed into the binary, so this is a real
        // drift check: a route added without a contract entry (or an entry
        // deleted out from under a live route) fails here rather than in a
        // client that generated its types from the published document.
        let contract = include_str!("../openapi.yaml");
        for path in [
            "/incidents/{incidentId}/audit:",
            "/incidents/{incidentId}/artifacts:",
            "/incidents/{incidentId}/artifacts/{partNumber}:",
            "/groups:",
            "/groups/{groupId}:",
            "/admin/tenant:",
        ] {
            assert!(contract.contains(path), "{path} missing from openapi.yaml");
        }
        for operation in [
            "listIncidents",
            "listIncidentGroups",
            "triageIncidentGroup",
            "downloadIncidentArtifact",
            "readIncidentAudit",
            "updateTenantPolicy",
        ] {
            assert!(
                contract.contains(operation),
                "{operation} missing from openapi.yaml"
            );
        }
        // The switch semantics the router now implements have to be what the
        // contract promises, or an operator reads the wrong runbook.
        assert!(contract.contains("Not part of intake"));
        // And the resume contract: a client that retries a spooled package
        // must be told it resumed rather than handed a credential that cannot
        // verify against the stored hash.
        assert!(contract.contains("CreateIncidentResponse"));
        assert!(contract.contains("only when `created` is true"));
    }

    fn incident_record() -> IncidentRecord {
        let now = Utc::now();
        IncidentRecord {
            id: Uuid::new_v4(),
            tenant_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            installation_id: "install-test".to_owned(),
            artifact_hash: "a".repeat(64),
            build_id: "1.0.0".to_owned(),
            platform: "macos".to_owned(),
            module: "cognia".to_owned(),
            exception: "panic".to_owned(),
            client_state: crate::model::IncidentState::Processing,
            processing_state: ProcessingState::Received,
            support_code: "ABCDEF1234".to_owned(),
            fingerprint: None,
            processing_attempts: 0,
            next_processing_at: now,
            failure_code: None,
            grouping_basis: None,
            raw_stack: serde_json::json!([]),
            symbolized_stack: serde_json::json!([]),
            missing_symbols: Vec::new(),
            group_id: None,
            accepted_at: None,
            consent_withdrawn_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn a_resumed_incident_withholds_the_credential_it_cannot_honour() {
        // `create_incident` mints a credential unconditionally but the upsert
        // stores its hash only on the INSERT branch. Returning it anyway would
        // hand a resuming client a string that can never verify.
        let created = serde_json::to_value(CreateIncidentResponse {
            incident: incident_record(),
            created: true,
            deletion_credential: Some("del_abc".to_owned()),
        })
        .unwrap();
        assert_eq!(created["created"], serde_json::json!(true));
        assert_eq!(created["deletionCredential"], serde_json::json!("del_abc"));

        let resumed = serde_json::to_value(CreateIncidentResponse {
            incident: incident_record(),
            created: false,
            deletion_credential: None,
        })
        .unwrap();
        assert_eq!(resumed["created"], serde_json::json!(false));
        // Absent, not null: a client that reads the key at all must not find
        // an empty credential it might then try to use.
        assert!(resumed.get("deletionCredential").is_none());
        assert_eq!(
            resumed["incident"]["supportCode"],
            serde_json::json!("ABCDEF1234")
        );
    }

    #[test]
    fn a_patch_can_unassign_as_well_as_reassign() {
        let cleared: TriageGroupRequest =
            serde_json::from_str(r#"{"assignedTo":null}"#).expect("explicit null parses");
        assert_eq!(cleared.assigned_to, Some(None));
        let untouched: TriageGroupRequest =
            serde_json::from_str(r#"{"status":"resolved"}"#).expect("absent field parses");
        assert_eq!(untouched.assigned_to, None);
        let assigned: TriageGroupRequest =
            serde_json::from_str(r#"{"assignedTo":"ops@example.com"}"#).expect("value parses");
        assert_eq!(
            assigned.assigned_to,
            Some(Some("ops@example.com".to_owned()))
        );
    }

    #[test]
    fn validates_checksums_and_artifact_kinds() {
        assert!(validate_hex_sha256(&"a".repeat(64)).is_ok());
        assert!(validate_hex_sha256("not-a-hash").is_err());
        assert!(validate_artifact_kind("minidump").is_ok());
        assert!(validate_artifact_kind("raw_database").is_err());
        assert!(validate_path_segment("1.2.3+macos", 256));
        assert!(!validate_path_segment("../secret", 256));
    }

    #[test]
    fn error_responses_never_expose_internal_details() {
        let response = ApiError::internal("database password secret").into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
