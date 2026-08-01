use std::{sync::Arc, time::Duration};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
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
    db::{CreateIncident, DiagnosticRepository, IncidentRecord, UploadPartRecord},
    fingerprint_incident,
    model::{IncidentLimits, MAX_ATTACHMENT_BYTES, MAX_INCIDENT_BYTES, MAX_MINIDUMP_BYTES},
    privacy::PrivacyGate,
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
    Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/openapi.yaml", get(openapi))
        .route("/v1/grants/oidc", post(exchange_oidc))
        .route("/v1/grants/anonymous", post(exchange_anonymous))
        .route("/v1/incidents", post(create_incident))
        .route(
            "/v1/incidents/{incident_id}",
            get(get_incident).delete(delete_incident),
        )
        .route("/v1/incidents/{incident_id}/parts", get(upload_progress))
        .route(
            "/v1/incidents/{incident_id}/parts/{part_number}",
            put(upload_part),
        )
        .route(
            "/v1/incidents/{incident_id}/complete",
            post(complete_upload),
        )
        .route("/v1/incidents/{incident_id}/cancel", post(cancel_upload))
        .route(
            "/v1/incidents/{incident_id}/withdraw",
            post(withdraw_consent),
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
    expires_in_seconds: u64,
}

async fn exchange_oidc(
    State(state): State<AppState>,
    Json(request): Json<OidcGrantRequest>,
) -> ApiResult<Json<GrantResponse>> {
    let (tenant_id, project_id, _, role) = verify_oidc_session(
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
            GRANT_TTL,
        )
        .map_err(ApiError::internal)?;
    Ok(Json(GrantResponse {
        grant,
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
            GRANT_TTL,
        )
        .map_err(ApiError::internal)?;
    Ok(Json(GrantResponse {
        grant,
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
    deletion_credential: String,
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
    let incident = state
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
            incident,
            deletion_credential,
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
        .put_part(&object_key, scan.sanitized.clone())
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
    symbolized_frames: Vec<String>,
}

async fn complete_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(incident_id): Path<Uuid>,
    Json(request): Json<CompleteUploadRequest>,
) -> ApiResult<Json<IncidentRecord>> {
    let claims = authorize(&state, &headers, GrantRole::Uploader)?;
    let incident = owned_incident(&state, &claims, incident_id).await?;
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
    let fingerprint = fingerprint_incident(
        &incident.platform,
        &incident.exception,
        &compatible_build_family(&incident.build_id),
        &incident.module,
        &request.symbolized_frames,
    );
    let incident = state
        .repository
        .mark_processing(claims.tenant_id, incident_id, &fingerprint)
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

fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn compatible_build_family(build_id: &str) -> String {
    build_id
        .split(['+', '-'])
        .next()
        .unwrap_or(build_id)
        .to_owned()
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

    #[test]
    fn validates_checksums_and_build_families() {
        assert!(validate_hex_sha256(&"a".repeat(64)).is_ok());
        assert!(validate_hex_sha256("not-a-hash").is_err());
        assert_eq!(compatible_build_family("1.2.3+abc"), "1.2.3");
        assert_eq!(compatible_build_family("2026.08.01-beta"), "2026.08.01");
    }

    #[test]
    fn error_responses_never_expose_internal_details() {
        let response = ApiError::internal("database password secret").into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
