//! Public Workflow App / Chatflow HTTP surface.
//!
//! Rust owns only browser-session signing and HTTP/SSE transport. Application
//! access policy, immutable release resolution, idempotency, run ownership,
//! and execution remain in the TypeScript workflow authority.

use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    sync::Arc,
    time::Duration,
};

use axum::{
    extract::{
        multipart::MultipartRejection, rejection::JsonRejection, Multipart, Path, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::stream;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::Instrument as _;
use uuid::Uuid;

use super::SharedState;

const APP_SESSION_SCOPE: &str = "workflow-app-session";
const APP_SESSION_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const EMBED_SESSION_TTL_SECONDS: i64 = 60 * 60;
const SSE_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AppSessionClaims {
    scope: String,
    account_id: String,
    app_id: String,
    app_slug: String,
    release_id: String,
    external_subject_key: String,
    #[serde(default)]
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    group_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    embed_origin: Option<String>,
    jti: String,
    iat: i64,
    exp: i64,
}

#[derive(Debug, Deserialize)]
struct BridgeEnvelope {
    ok: bool,
    data: Option<Value>,
    error: Option<BridgeError>,
}

#[derive(Clone, Debug, Deserialize)]
struct BridgeError {
    code: String,
    status: u16,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    #[serde(default)]
    input: Value,
    #[serde(default)]
    legal_consent_granted: bool,
    #[serde(default = "blocking_mode")]
    response_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRequest {
    query: String,
    conversation_id: Option<String>,
    expected_revision: Option<u64>,
    #[serde(default)]
    legal_consent_granted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackRequest {
    rating: String,
    input: String,
    output: String,
    correction: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    run_id: Option<String>,
    conversation_id: Option<String>,
    message_id: Option<String>,
    #[serde(default)]
    legal_consent_granted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultShareCreateRequest {
    ttl_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchCreateRequest {
    csv: String,
    concurrency: Option<u64>,
    deadline_ms: Option<u64>,
    #[serde(default)]
    legal_consent_granted: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct BatchPageQuery {
    after_row_number: Option<u64>,
    limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanInputSubmitRequest {
    action_id: String,
    #[serde(default)]
    values: Value,
}

#[derive(Debug, Deserialize)]
struct EventsPage {
    events: Vec<Value>,
    terminal: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: String,
    message: String,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

impl ApiError {
    fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody {
                code: code.to_string(),
                message: message.into(),
                request_id: Uuid::new_v4().to_string(),
                details: None,
            },
        }
    }

    fn anonymous_challenge(offer: super::workflow_app_challenge::AnonymousChallengeOffer) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            body: ErrorBody {
                code: "anonymous_challenge_required".into(),
                message: "Anonymous traffic requires a short proof-of-work challenge".into(),
                request_id: Uuid::new_v4().to_string(),
                details: serde_json::to_value(offer).ok(),
            },
        }
    }

    fn from_bridge(error: BridgeError) -> Self {
        Self::new(
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &error.code,
            error.message,
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let request_id = self.body.request_id.clone();
        let mut response = (self.status, Json(self.body)).into_response();
        if let Ok(value) = HeaderValue::from_str(&request_id) {
            response.headers_mut().insert("x-request-id", value);
        }
        response
    }
}

fn blocking_mode() -> String {
    "blocking".to_string()
}

fn now_seconds() -> i64 {
    chrono::Utc::now().timestamp()
}

fn issue_session_with_ttl(
    secret: &[u8],
    mut claims: AppSessionClaims,
    ttl_seconds: i64,
) -> Result<String, ApiError> {
    let now = now_seconds();
    claims.scope = APP_SESSION_SCOPE.to_string();
    claims.iat = now;
    claims.exp = now + ttl_seconds;
    claims.jti = Uuid::new_v4().to_string();
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret),
    )
    .map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_issue_failed",
            "Application session could not be issued",
        )
    })
}

fn issue_session(secret: &[u8], claims: AppSessionClaims) -> Result<String, ApiError> {
    issue_session_with_ttl(secret, claims, APP_SESSION_TTL_SECONDS)
}

fn verify_session(secret: &[u8], token: &str) -> Result<AppSessionClaims, ApiError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    validation.set_required_spec_claims(&["exp"]);
    let claims = decode::<AppSessionClaims>(token, &DecodingKey::from_secret(secret), &validation)
        .map_err(|_| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_app_session",
                "Application session is invalid or expired",
            )
        })?
        .claims;
    if claims.scope != APP_SESSION_SCOPE {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_app_session",
            "Application session has the wrong scope",
        ));
    }
    Ok(claims)
}

fn bearer(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "app_session_required",
                "A Bearer application session is required",
            )
        })?;
    Ok(value)
}

fn session_for_slug(
    state: &SharedState,
    headers: &HeaderMap,
    app_slug: &str,
) -> Result<AppSessionClaims, ApiError> {
    let secret = state.secret.read();
    let claims = verify_session(secret.as_slice(), bearer(headers)?)?;
    if claims.app_slug != app_slug {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "app_not_found",
            "Published app was not found",
        ));
    }
    Ok(claims)
}

fn actor(claims: &AppSessionClaims, legal_consent_granted: bool) -> Value {
    let mut value = json!({
        "authenticated": claims.authenticated,
        "externalSubjectKey": claims.external_subject_key,
        "legalConsentGranted": legal_consent_granted,
    });
    if let Some(subject_id) = &claims.subject_id {
        value["subjectId"] = json!(subject_id);
    }
    if !claims.group_ids.is_empty() {
        value["groupIds"] = json!(claims.group_ids);
    }
    if let Some(embed_origin) = &claims.embed_origin {
        value["embedOrigin"] = json!(embed_origin);
    }
    value
}

async fn dispatch_bridge(
    state: &SharedState,
    command: &str,
    payload: Value,
) -> Result<Value, ApiError> {
    let span = tracing::info_span!("workflow_app.bridge", command = command);
    let result = async {
        let transport = super::ws_bridge::resolve_bridge_transport(state).map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "workflow_app_service_unavailable",
                "The application runtime is not connected",
            )
        })?;
        let result = Arc::clone(&state.desktop_writes_bridge)
            .dispatch(
                transport.as_ref(),
                command,
                payload,
                super::desktop_writes_bridge::DEFAULT_TIMEOUT,
            )
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "workflow_app_service_unavailable",
                    "The application runtime did not answer",
                )
            })?;
        let envelope: BridgeEnvelope = serde_json::from_value(result).map_err(|_| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "workflow_app_protocol_error",
                "The application runtime returned an invalid response",
            )
        })?;
        if envelope.ok {
            envelope.data.ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_GATEWAY,
                    "workflow_app_protocol_error",
                    "The application runtime returned no data",
                )
            })
        } else {
            Err(envelope
                .error
                .map(ApiError::from_bridge)
                .unwrap_or_else(|| {
                    ApiError::new(
                        StatusCode::BAD_GATEWAY,
                        "workflow_app_protocol_error",
                        "The application runtime returned an incomplete error",
                    )
                }))
        }
    }
    .instrument(span)
    .await;
    let quota_rejected = result.as_ref().is_err_and(|error| {
        matches!(
            error.body.code.as_str(),
            "request_rate_exhausted"
                | "concurrency_exhausted"
                | "token_budget_exhausted"
                | "cost_budget_exhausted"
                | "cost_budget_unknown"
        )
    });
    super::metrics::record_workflow_app_request(result.is_ok(), quota_rejected);
    result
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let mut response = (status, Json(value)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    response
}

fn cors_json_response(status: StatusCode, value: Value, origin: &str) -> Response {
    let mut response = json_response(status, value);
    if let Ok(origin) = HeaderValue::from_str(origin) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response.headers_mut().insert(
            header::VARY,
            HeaderValue::from_static("Origin, Access-Control-Request-Headers"),
        );
    }
    response
}

fn parse_idempotency_key(headers: &HeaderMap) -> Result<String, ApiError> {
    let value = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty() && value.len() <= 256)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_idempotency_key",
                "A non-empty Idempotency-Key of at most 256 bytes is required",
            )
        })?;
    Ok(value.to_string())
}

fn requires_anonymous_challenge(claims: &AppSessionClaims) -> bool {
    !claims.authenticated
}

fn admit_anonymous_mutation(
    state: &SharedState,
    headers: &HeaderMap,
    claims: &AppSessionClaims,
) -> Result<(), ApiError> {
    if !requires_anonymous_challenge(claims) {
        return Ok(());
    }
    let challenge_token = headers
        .get("x-cognia-challenge-token")
        .and_then(|value| value.to_str().ok());
    let challenge_proof = headers
        .get("x-cognia-challenge-proof")
        .and_then(|value| value.to_str().ok());
    super::workflow_app_challenge::admit(
        state.secret.read().as_slice(),
        &claims.app_slug,
        &claims.jti,
        challenge_token,
        challenge_proof,
        now_seconds(),
    )
    .map_err(ApiError::anonymous_challenge)
}

fn request_origin(headers: &HeaderMap) -> Result<String, ApiError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "embed_origin_required",
                "The embedding page Origin is required",
            )
        })?;
    let parsed = url::Url::parse(origin).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_embed_origin",
            "The embedding page Origin is invalid",
        )
    })?;
    if parsed.origin().ascii_serialization() != origin
        || !super::web_origin::is_secure_or_loopback(&parsed)
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_embed_origin",
            "The embedding page Origin must be HTTPS or loopback HTTP",
        ));
    }
    Ok(origin.to_string())
}

async fn bootstrap_application(
    state: &SharedState,
    app_slug: String,
    bearer_token: Option<&str>,
    requested_embed_origin: Option<String>,
) -> Result<Value, ApiError> {
    let existing = bearer_token
        .and_then(|token| verify_session(state.secret.read().as_slice(), token).ok())
        .filter(|claims| claims.app_slug == app_slug);
    let oidc_claims = if existing.is_none() {
        match (bearer_token, super::oidc_authenticator()) {
            (Some(token), Some(authenticator)) => match authenticator.authenticate(token).await {
                Ok(claims) => Some(claims),
                Err(_) => {
                    return Err(ApiError::new(
                        StatusCode::UNAUTHORIZED,
                        "oidc_authentication_failed",
                        "OIDC access token is invalid or expired",
                    ))
                }
            },
            _ => None,
        }
    } else {
        None
    };
    let external_subject_key = existing
        .as_ref()
        .map(|claims| claims.external_subject_key.clone())
        .or_else(|| {
            oidc_claims
                .as_ref()
                .map(|claims| format!("oidc:{}", claims.sub))
        })
        .unwrap_or_else(|| format!("anonymous:{}", Uuid::new_v4()));
    let embed_origin = existing
        .as_ref()
        .and_then(|claims| claims.embed_origin.clone())
        .or(requested_embed_origin);
    let authenticated =
        oidc_claims.is_some() || existing.as_ref().is_some_and(|claims| claims.authenticated);
    let subject_id = oidc_claims
        .as_ref()
        .map(|claims| claims.sub.clone())
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|claims| claims.subject_id.clone())
        });
    let group_ids = oidc_claims
        .as_ref()
        .map(|claims| claims.group_ids.clone())
        .or_else(|| existing.as_ref().map(|claims| claims.group_ids.clone()))
        .unwrap_or_default();
    let bootstrap_claims = AppSessionClaims {
        scope: String::new(),
        account_id: String::new(),
        app_id: String::new(),
        app_slug: app_slug.clone(),
        release_id: String::new(),
        external_subject_key: external_subject_key.clone(),
        authenticated,
        subject_id: subject_id.clone(),
        group_ids: group_ids.clone(),
        embed_origin: embed_origin.clone(),
        jti: String::new(),
        iat: 0,
        exp: 0,
    };
    let data = dispatch_bridge(
        &state,
        "workflow_app_bootstrap",
        json!({
            "appSlug": app_slug,
            "embedOrigin": embed_origin,
            "actor": actor(&bootstrap_claims, false),
        }),
    )
    .await?;
    let session = data.get("session").cloned().unwrap_or(Value::Null);
    let account_id = session
        .get("accountId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let app_id = session
        .get("appId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let release_id = session
        .get("releaseId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if account_id.is_empty() || app_id.is_empty() || release_id.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "workflow_app_protocol_error",
            "The application runtime returned an invalid session",
        ));
    }
    let claims = AppSessionClaims {
        scope: String::new(),
        account_id: account_id.to_string(),
        app_id: app_id.to_string(),
        app_slug: app_slug.clone(),
        release_id: release_id.to_string(),
        external_subject_key,
        authenticated,
        subject_id,
        group_ids,
        embed_origin,
        jti: String::new(),
        iat: 0,
        exp: 0,
    };
    let token = if claims.embed_origin.is_some() {
        issue_session_with_ttl(
            state.secret.read().as_slice(),
            claims,
            EMBED_SESSION_TTL_SECONDS,
        )?
    } else {
        issue_session(state.secret.read().as_slice(), claims)?
    };
    Ok(json!({ "app": data.get("app"), "sessionToken": token }))
}

pub async fn bootstrap_handler(
    Path(app_slug): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let bearer_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    match bootstrap_application(&state, app_slug, bearer_token, None).await {
        Ok(data) => json_response(StatusCode::OK, data),
        Err(error) => error.into_response(),
    }
}

fn request_hostname(headers: &HeaderMap) -> Result<String, ApiError> {
    let forwarded = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.contains(','))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_custom_domain",
                "The request hostname is invalid",
            )
        })?;
    let parsed = url::Url::parse(&format!("https://{forwarded}")).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_custom_domain",
            "The request hostname is invalid",
        )
    })?;
    parsed.host_str().map(str::to_lowercase).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_custom_domain",
            "The request hostname is invalid",
        )
    })
}

pub async fn domain_bootstrap_handler(
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let hostname = match request_hostname(&headers) {
        Ok(hostname) => hostname,
        Err(error) => return error.into_response(),
    };
    let resolved = match dispatch_bridge(
        &state,
        "workflow_app_domain_resolve",
        json!({ "hostname": hostname }),
    )
    .await
    {
        Ok(resolved) => resolved,
        Err(error) => return error.into_response(),
    };
    let Some(app_slug) = resolved.get("appSlug").and_then(Value::as_str) else {
        return ApiError::new(
            StatusCode::BAD_GATEWAY,
            "workflow_app_protocol_error",
            "The application runtime returned an invalid custom domain",
        )
        .into_response();
    };
    let bearer_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    match bootstrap_application(&state, app_slug.to_string(), bearer_token, None).await {
        Ok(data) => json_response(StatusCode::OK, data),
        Err(error) => error.into_response(),
    }
}

pub async fn embed_token_handler(
    Path(app_slug): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let origin = match request_origin(&headers) {
        Ok(origin) => origin,
        Err(error) => return error.into_response(),
    };
    let bearer_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    match bootstrap_application(&state, app_slug, bearer_token, Some(origin.clone())).await {
        Ok(data) => cors_json_response(
            StatusCode::OK,
            json!({ "sessionToken": data.get("sessionToken") }),
            &origin,
        ),
        Err(error) => error.into_response(),
    }
}

pub async fn create_run_handler(
    Path(app_slug): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<RunRequest>, JsonRejection>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    let Json(body) = match body {
        Ok(body) if matches!(body.response_mode.as_str(), "blocking" | "streaming") => body,
        _ => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "The request body or responseMode is invalid",
            )
            .into_response()
        }
    };
    let idempotency_key = match parse_idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = admit_anonymous_mutation(&state, &headers, &claims) {
        return error.into_response();
    }
    let status = if body.response_mode == "streaming" {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    match dispatch_bridge(
        &state,
        "workflow_app_run_create",
        json!({
            "accountId": claims.account_id,
            "appSlug": claims.app_slug,
            "actor": actor(&claims, body.legal_consent_granted),
            "idempotencyKey": idempotency_key,
            "input": body.input,
            "responseMode": body.response_mode,
        }),
    )
    .await
    {
        Ok(data) => json_response(status, data),
        Err(error) => error.into_response(),
    }
}

pub async fn chat_message_handler(
    Path(app_slug): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<ChatRequest>, JsonRejection>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    let Json(body) = match body {
        Ok(body) if !body.query.trim().is_empty() => body,
        _ => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "A non-empty chat query is required",
            )
            .into_response()
        }
    };
    let idempotency_key = match parse_idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = admit_anonymous_mutation(&state, &headers, &claims) {
        return error.into_response();
    }
    match dispatch_bridge(
        &state,
        "workflow_app_chat_message",
        json!({
            "accountId": claims.account_id,
            "appSlug": claims.app_slug,
            "actor": actor(&claims, body.legal_consent_granted),
            "idempotencyKey": idempotency_key,
            "query": body.query,
            "conversationId": body.conversation_id,
            "expectedRevision": body.expected_revision,
        }),
    )
    .await
    {
        Ok(data) => json_response(StatusCode::OK, data),
        Err(error) => error.into_response(),
    }
}

pub async fn feedback_handler(
    Path(app_slug): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<FeedbackRequest>, JsonRejection>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    let Json(body) = match body {
        Ok(body)
            if matches!(body.rating.as_str(), "like" | "dislike")
                && !body.input.trim().is_empty()
                && !body.output.trim().is_empty() =>
        {
            body
        }
        _ => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_feedback",
                "Feedback requires like/dislike, input, and output",
            )
            .into_response()
        }
    };
    match dispatch_bridge(
        &state,
        "workflow_app_feedback_submit",
        json!({
            "accountId": claims.account_id,
            "appId": claims.app_id,
            "appReleaseId": claims.release_id,
            "appSlug": claims.app_slug,
            "actor": actor(&claims, body.legal_consent_granted),
            "rating": body.rating,
            "input": body.input,
            "output": body.output,
            "correction": body.correction,
            "tags": body.tags,
            "runId": body.run_id,
            "conversationId": body.conversation_id,
            "messageId": body.message_id,
        }),
    )
    .await
    {
        Ok(data) => json_response(StatusCode::CREATED, data),
        Err(error) => error.into_response(),
    }
}

pub async fn create_result_share_handler(
    Path((app_slug, run_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<ResultShareCreateRequest>, JsonRejection>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    let Json(body) = match body {
        Ok(body)
            if body
                .ttl_seconds
                .is_none_or(|ttl| (60..=2_592_000).contains(&ttl)) =>
        {
            body
        }
        _ => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_share_ttl",
                "Result shares must expire between 1 minute and 30 days",
            )
            .into_response()
        }
    };
    match dispatch_bridge(
        &state,
        "workflow_app_result_share_create",
        json!({
            "accountId": claims.account_id,
            "appSlug": claims.app_slug,
            "actor": actor(&claims, true),
            "runId": run_id,
            "ttlSeconds": body.ttl_seconds,
        }),
    )
    .await
    {
        Ok(data) => json_response(StatusCode::CREATED, data),
        Err(error) => error.into_response(),
    }
}

pub async fn revoke_result_share_handler(
    Path((app_slug, code)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    match dispatch_bridge(
        &state,
        "workflow_app_result_share_revoke",
        json!({
            "accountId": claims.account_id,
            "appSlug": claims.app_slug,
            "actor": actor(&claims, true),
            "code": code,
        }),
    )
    .await
    {
        Ok(data) => json_response(StatusCode::OK, data),
        Err(error) => error.into_response(),
    }
}

pub async fn batch_template_handler(
    Path(app_slug): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    match dispatch_bridge(
        &state,
        "workflow_app_batch_template",
        json!({
            "accountId": claims.account_id,
            "appSlug": claims.app_slug,
            "actor": actor(&claims, false),
        }),
    )
    .await
    {
        Ok(Value::String(csv)) => {
            let mut response = (StatusCode::OK, csv).into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/csv; charset=utf-8"),
            );
            response
        }
        Ok(_) => ApiError::new(
            StatusCode::BAD_GATEWAY,
            "workflow_app_protocol_error",
            "The application runtime returned an invalid CSV template",
        )
        .into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn batch_create_handler(
    Path(app_slug): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<BatchCreateRequest>, JsonRejection>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    let Json(body) = match body {
        Ok(body) if !body.csv.trim().is_empty() => body,
        _ => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_csv",
                "A non-empty CSV body is required",
            )
            .into_response()
        }
    };
    let idempotency_key = match parse_idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = admit_anonymous_mutation(&state, &headers, &claims) {
        return error.into_response();
    }
    match dispatch_bridge(
        &state,
        "workflow_app_batch_create",
        json!({
            "accountId": claims.account_id,
            "appSlug": claims.app_slug,
            "actor": actor(&claims, body.legal_consent_granted),
            "csv": body.csv,
            "concurrency": body.concurrency,
            "deadlineMs": body.deadline_ms,
            "idempotencyKey": idempotency_key,
        }),
    )
    .await
    {
        Ok(data) => json_response(StatusCode::ACCEPTED, data),
        Err(error) => error.into_response(),
    }
}

pub async fn batch_get_handler(
    Path((app_slug, job_id)): Path<(String, String)>,
    Query(query): Query<BatchPageQuery>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    dify_json_result(
        dispatch_bridge(
            &state,
            "workflow_app_batch_get",
            json!({
                "accountId": claims.account_id,
                "appSlug": claims.app_slug,
                "actor": actor(&claims, false),
                "jobId": job_id,
                "afterRowNumber": query.after_row_number,
                "limit": query.limit,
            }),
        )
        .await,
        StatusCode::OK,
    )
}

async fn batch_action(
    state: &SharedState,
    claims: &AppSessionClaims,
    job_id: String,
    command: &str,
) -> Response {
    dify_json_result(
        dispatch_bridge(
            state,
            command,
            json!({
                "accountId": claims.account_id,
                "appSlug": claims.app_slug,
                "actor": actor(claims, false),
                "jobId": job_id,
            }),
        )
        .await,
        StatusCode::ACCEPTED,
    )
}

pub async fn batch_pause_handler(
    Path((app_slug, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    batch_action(&state, &claims, job_id, "workflow_app_batch_pause").await
}

pub async fn batch_resume_handler(
    Path((app_slug, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    batch_action(&state, &claims, job_id, "workflow_app_batch_resume").await
}

pub async fn batch_cancel_handler(
    Path((app_slug, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    batch_action(&state, &claims, job_id, "workflow_app_batch_cancel").await
}

pub async fn batch_export_handler(
    Path((app_slug, job_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    match dispatch_bridge(
        &state,
        "workflow_app_batch_export",
        json!({
            "accountId": claims.account_id,
            "appSlug": claims.app_slug,
            "actor": actor(&claims, false),
            "jobId": job_id,
        }),
    )
    .await
    {
        Ok(Value::String(csv)) => {
            let mut response = (StatusCode::OK, csv).into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/csv; charset=utf-8"),
            );
            response.headers_mut().insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=workflow-batch-results.csv"),
            );
            response
        }
        Ok(_) => ApiError::new(
            StatusCode::BAD_GATEWAY,
            "workflow_app_protocol_error",
            "The application runtime returned an invalid CSV export",
        )
        .into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn human_input_list_handler(
    Path(app_slug): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    dify_json_result(
        dispatch_bridge(
            &state,
            "workflow_app_human_input_list",
            json!({
                "accountId": claims.account_id,
                "appId": claims.app_id,
                "appReleaseId": claims.release_id,
                "appSlug": claims.app_slug,
                "actor": actor(&claims, false),
            }),
        )
        .await,
        StatusCode::OK,
    )
}

pub async fn human_input_submit_handler(
    Path((app_slug, request_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<HumanInputSubmitRequest>, JsonRejection>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    let Json(body) = match body {
        Ok(body) if !body.action_id.trim().is_empty() && body.values.is_object() => body,
        _ => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Human Input requires an actionId and values object",
            )
            .into_response()
        }
    };
    dify_json_result(
        dispatch_bridge(
            &state,
            "workflow_app_human_input_submit",
            json!({
                "accountId": claims.account_id,
                "appId": claims.app_id,
                "appReleaseId": claims.release_id,
                "appSlug": claims.app_slug,
                "actor": actor(&claims, false),
                "requestId": request_id,
                "actionId": body.action_id,
                "values": body.values,
            }),
        )
        .await,
        StatusCode::OK,
    )
}

pub async fn human_input_file_upload_handler(
    Path((app_slug, request_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    multipart: Result<Multipart, MultipartRejection>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    let mut multipart = match multipart {
        Ok(value) => value,
        Err(_) => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "A multipart/form-data body is required",
            )
            .into_response()
        }
    };
    let mut field_id: Option<String> = None;
    let mut file: Option<(String, String, Vec<u8>)> = None;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => {
                return ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "Multipart data could not be read",
                )
                .into_response()
            }
        };
        match field.name() {
            Some("fieldId") => match field.text().await {
                Ok(value) if !value.trim().is_empty() && value.len() <= 128 => {
                    field_id = Some(value)
                }
                _ => {
                    return ApiError::new(
                        StatusCode::BAD_REQUEST,
                        "invalid_request",
                        "fieldId is required",
                    )
                    .into_response()
                }
            },
            Some("file") => {
                if file.is_some() {
                    return ApiError::new(
                        StatusCode::BAD_REQUEST,
                        "too_many_files",
                        "Only one file is allowed per request",
                    )
                    .into_response();
                }
                let name = match field.file_name().map(str::to_string) {
                    Some(value)
                        if !value.trim().is_empty()
                            && value.len() <= 255
                            && !value.contains(['/', '\\', '\0']) =>
                    {
                        value
                    }
                    _ => {
                        return ApiError::new(
                            StatusCode::BAD_REQUEST,
                            "invalid_request",
                            "A safe filename is required",
                        )
                        .into_response()
                    }
                };
                let media_type = field
                    .content_type()
                    .filter(|value| !value.trim().is_empty() && value.len() <= 255)
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let bytes = match field.bytes().await {
                    Ok(value) if !value.is_empty() => value.to_vec(),
                    _ => {
                        return ApiError::new(
                            StatusCode::BAD_REQUEST,
                            "invalid_request",
                            "A non-empty file is required",
                        )
                        .into_response()
                    }
                };
                file = Some((name, media_type, bytes));
            }
            _ => {}
        }
    }
    let field_id = match field_id {
        Some(value) => value,
        None => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "fieldId is required",
            )
            .into_response()
        }
    };
    let (name, media_type, bytes) = match file {
        Some(value) => value,
        None => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "A file is required",
            )
            .into_response()
        }
    };
    dify_json_result(
        dispatch_bridge(
            &state,
            "workflow_app_human_input_file_upload",
            json!({
                "accountId": claims.account_id,
                "appId": claims.app_id,
                "appReleaseId": claims.release_id,
                "appSlug": claims.app_slug,
                "actor": actor(&claims, false),
                "requestId": request_id,
                "fieldId": field_id,
                "name": name,
                "mediaType": media_type,
                "dataBase64": B64.encode(bytes),
            }),
        )
        .await,
        StatusCode::CREATED,
    )
}

pub async fn mcp_handler(
    Path(app_slug): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let api_key = match bearer(&headers) {
        Ok(value) => value.to_string(),
        Err(_) => {
            return ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_api_key",
                "A Bearer application API key is required",
            )
            .into_response()
        }
    };
    let Json(request) = match body {
        Ok(body) if body.0.is_object() => body,
        _ => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "MCP requires a JSON-RPC request object",
            )
            .into_response()
        }
    };
    match dispatch_bridge(
        &state,
        "workflow_app_mcp",
        json!({ "apiKey": api_key, "appSlug": app_slug, "request": request }),
    )
    .await
    {
        Ok(data) if data.is_null() => StatusCode::ACCEPTED.into_response(),
        Ok(data) => json_response(StatusCode::OK, data),
        Err(error) => error.into_response(),
    }
}

fn dify_api_key(headers: &HeaderMap) -> Result<String, ApiError> {
    bearer(headers).map(str::to_string).map_err(|_| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_api_key",
            "A Bearer application API key is required",
        )
    })
}

async fn dispatch_dify(
    state: &SharedState,
    headers: &HeaderMap,
    command: &str,
    mut payload: Value,
) -> Result<Value, ApiError> {
    let api_key = dify_api_key(headers)?;
    let object = payload.as_object_mut().ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_param",
            "Dify-compatible payload must be an object",
        )
    })?;
    object.insert("apiKey".to_string(), Value::String(api_key));
    dispatch_bridge(state, command, payload).await
}

fn dify_query_value(query: &HashMap<String, String>, key: &str) -> Option<Value> {
    query.get(key).cloned().map(Value::String)
}

fn dify_json_result(result: Result<Value, ApiError>, status: StatusCode) -> Response {
    match result {
        Ok(data) => json_response(status, data),
        Err(error) => error.into_response(),
    }
}

pub async fn dify_file_upload_handler(
    headers: HeaderMap,
    State(state): State<SharedState>,
    multipart: Result<Multipart, MultipartRejection>,
) -> Response {
    let api_key = match dify_api_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let mut multipart = match multipart {
        Ok(value) => value,
        Err(_) => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_param",
                "A multipart/form-data body is required",
            )
            .into_response()
        }
    };

    let mut user: Option<String> = None;
    let mut file: Option<(String, String, Vec<u8>)> = None;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => {
                return ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_param",
                    "Multipart data could not be read",
                )
                .into_response()
            }
        };
        match field.name() {
            Some("user") => match field.text().await {
                Ok(value) if !value.trim().is_empty() && value.len() <= 240 => user = Some(value),
                _ => {
                    return ApiError::new(
                        StatusCode::BAD_REQUEST,
                        "invalid_param",
                        "user is required",
                    )
                    .into_response()
                }
            },
            Some("file") => {
                if file.is_some() {
                    return ApiError::new(
                        StatusCode::BAD_REQUEST,
                        "too_many_files",
                        "Only one file is allowed per request",
                    )
                    .into_response();
                }
                let name = match field.file_name().map(str::to_string) {
                    Some(value)
                        if !value.trim().is_empty()
                            && value.len() <= 255
                            && !value.contains(['/', '\\', '\0']) =>
                    {
                        value
                    }
                    _ => {
                        return ApiError::new(
                            StatusCode::BAD_REQUEST,
                            "filename_not_exists_error",
                            "The uploaded file has no safe filename",
                        )
                        .into_response()
                    }
                };
                let media_type = match field.content_type().map(str::to_string) {
                    Some(value) if !value.trim().is_empty() && value.len() <= 255 => value,
                    _ => {
                        return ApiError::new(
                            StatusCode::UNSUPPORTED_MEDIA_TYPE,
                            "unsupported_file_type",
                            "The uploaded file has no supported content type",
                        )
                        .into_response()
                    }
                };
                let bytes = match field.bytes().await {
                    Ok(value) if !value.is_empty() => value.to_vec(),
                    _ => {
                        return ApiError::new(
                            StatusCode::BAD_REQUEST,
                            "no_file_uploaded",
                            "A non-empty file is required",
                        )
                        .into_response()
                    }
                };
                file = Some((name, media_type, bytes));
            }
            _ => {}
        }
    }

    let user = match user {
        Some(value) => value,
        None => {
            return ApiError::new(StatusCode::BAD_REQUEST, "invalid_param", "user is required")
                .into_response()
        }
    };
    let (name, media_type, bytes) = match file {
        Some(value) => value,
        None => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "no_file_uploaded",
                "A file must be provided",
            )
            .into_response()
        }
    };
    dify_json_result(
        dispatch_bridge(
            &state,
            "dify_file_upload",
            json!({
                "apiKey": api_key,
                "user": user,
                "name": name,
                "mediaType": media_type,
                "dataBase64": B64.encode(bytes),
            }),
        )
        .await,
        StatusCode::CREATED,
    )
}

#[derive(Debug, Deserialize)]
struct DifyEventsPage {
    frames: Vec<String>,
    terminal: bool,
}

async fn load_dify_events(
    state: &SharedState,
    api_key: &str,
    user: &str,
    run_id: &str,
    after_sequence: u64,
) -> Result<DifyEventsPage, ApiError> {
    let data = dispatch_bridge(
        state,
        "dify_events_list",
        json!({
            "apiKey": api_key,
            "user": user,
            "runId": run_id,
            "afterSequence": after_sequence,
        }),
    )
    .await?;
    serde_json::from_value(data).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "dify_protocol_error",
            "The runtime returned invalid Dify event data",
        )
    })
}

fn parse_dify_frame(frame: &str) -> Option<(u64, Event)> {
    let mut id = None;
    let mut data = None;
    for line in frame.lines() {
        if let Some(value) = line.strip_prefix("id: ") {
            id = Some(value.to_string());
        }
        if let Some(value) = line.strip_prefix("data: ") {
            data = Some(value.to_string());
        }
    }
    let id = id?.parse::<u64>().ok()?;
    Some((id, Event::default().id(id.to_string()).data(data?)))
}

struct DifyEventStreamState {
    state: SharedState,
    api_key: String,
    user: String,
    run_id: String,
    cursor: u64,
    queue: VecDeque<(u64, Event)>,
    terminal: bool,
}

async fn dify_workflow_event_stream(
    state: SharedState,
    api_key: String,
    user: String,
    run_id: String,
) -> Response {
    let first = match load_dify_events(&state, &api_key, &user, &run_id, 0).await {
        Ok(page) => page,
        Err(error) => return error.into_response(),
    };
    let queue = first
        .frames
        .iter()
        .filter_map(|frame| parse_dify_frame(frame))
        .collect();
    let events = stream::unfold(
        DifyEventStreamState {
            state,
            api_key,
            user,
            run_id,
            cursor: 0,
            queue,
            terminal: first.terminal,
        },
        |mut stream_state| async move {
            loop {
                if let Some((id, event)) = stream_state.queue.pop_front() {
                    stream_state.cursor = stream_state.cursor.max(id);
                    return Some((Ok::<Event, Infallible>(event), stream_state));
                }
                if stream_state.terminal {
                    return None;
                }
                tokio::time::sleep(SSE_POLL_INTERVAL).await;
                match load_dify_events(
                    &stream_state.state,
                    &stream_state.api_key,
                    &stream_state.user,
                    &stream_state.run_id,
                    stream_state.cursor,
                )
                .await
                {
                    Ok(page) => {
                        stream_state.queue = page
                            .frames
                            .iter()
                            .filter_map(|frame| parse_dify_frame(frame))
                            .collect();
                        stream_state.terminal = page.terminal;
                    }
                    Err(_) => return None,
                }
            }
        },
    );
    Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response()
}

pub async fn dify_workflow_run_handler(
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(request) = match body {
        Ok(body) if body.0.is_object() => body,
        _ => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_param",
                "Invalid request body",
            )
            .into_response()
        }
    };
    let user = request
        .get("user")
        .and_then(Value::as_str)
        .map(str::to_string);
    let streaming = request.get("response_mode").and_then(Value::as_str) == Some("streaming");
    let idempotency_key = match parse_idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let api_key = match dify_api_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let data = match dispatch_bridge(
        &state,
        "dify_workflow_run",
        json!({ "apiKey": api_key, "idempotencyKey": idempotency_key, "request": request }),
    )
    .await
    {
        Ok(data) => data,
        Err(error) => return error.into_response(),
    };
    if streaming {
        let Some(user) = user else {
            return ApiError::new(StatusCode::BAD_REQUEST, "invalid_param", "user is required")
                .into_response();
        };
        let Some(run_id) = data
            .get("task_id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return ApiError::new(
                StatusCode::BAD_GATEWAY,
                "dify_protocol_error",
                "Runtime returned no task id",
            )
            .into_response();
        };
        return dify_workflow_event_stream(state, api_key, user, run_id).await;
    }
    json_response(StatusCode::OK, data)
}

pub async fn dify_workflow_status_handler(
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    dify_json_result(
        dispatch_dify(
            &state,
            &headers,
            "dify_workflow_status",
            json!({ "runId": run_id, "user": query.get("user") }),
        )
        .await,
        StatusCode::OK,
    )
}

pub async fn dify_task_stop_handler(
    Path(task_id): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let request = body.ok().map(|body| body.0).unwrap_or(Value::Null);
    dify_json_result(
        dispatch_dify(
            &state,
            &headers,
            "dify_task_stop",
            json!({ "taskId": task_id, "user": request.get("user") }),
        )
        .await,
        StatusCode::OK,
    )
}

pub async fn dify_chat_message_handler(
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(request) = match body {
        Ok(body) if body.0.is_object() => body,
        _ => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_param",
                "Invalid request body",
            )
            .into_response()
        }
    };
    let streaming = request.get("response_mode").and_then(Value::as_str) == Some("streaming");
    let idempotency_key = match parse_idempotency_key(&headers) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let data = match dispatch_dify(
        &state,
        &headers,
        "dify_chat_message",
        json!({ "idempotencyKey": idempotency_key, "request": request }),
    )
    .await
    {
        Ok(data) => data,
        Err(error) => return error.into_response(),
    };
    if streaming {
        let done = json!({ "event": "message_end", "task_id": data.get("task_id"), "message_id": data.get("message_id") });
        let events = stream::iter(vec![
            Ok::<Event, Infallible>(Event::default().event("message").data(data.to_string())),
            Ok::<Event, Infallible>(Event::default().event("message_end").data(done.to_string())),
        ]);
        return Sse::new(events).into_response();
    }
    json_response(StatusCode::OK, data)
}

pub async fn dify_conversations_handler(
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    dify_json_result(
        dispatch_dify(
            &state,
            &headers,
            "dify_conversations_list",
            json!({
                "user": query.get("user"),
                "limit": query.get("limit").and_then(|value| value.parse::<u64>().ok()),
                "lastId": dify_query_value(&query, "last_id"),
            }),
        )
        .await,
        StatusCode::OK,
    )
}

pub async fn dify_messages_handler(
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    dify_json_result(
        dispatch_dify(
            &state,
            &headers,
            "dify_messages_list",
            json!({
                "user": query.get("user"),
                "conversationId": query.get("conversation_id"),
                "limit": query.get("limit").and_then(|value| value.parse::<u64>().ok()),
                "firstId": dify_query_value(&query, "first_id"),
            }),
        )
        .await,
        StatusCode::OK,
    )
}

pub async fn dify_conversation_rename_handler(
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let request = body.ok().map(|body| body.0).unwrap_or(Value::Null);
    dify_json_result(
        dispatch_dify(
            &state,
            &headers,
            "dify_conversation_rename",
            json!({ "conversationId": conversation_id, "user": request.get("user"), "name": request.get("name") }),
        )
        .await,
        StatusCode::OK,
    )
}

pub async fn dify_conversation_delete_handler(
    Path(conversation_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    dify_json_result(
        dispatch_dify(
            &state,
            &headers,
            "dify_conversation_delete",
            json!({ "conversationId": conversation_id, "user": query.get("user") }),
        )
        .await,
        StatusCode::NO_CONTENT,
    )
}

pub async fn dify_conversation_variables_handler(
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let request = body.ok().map(|body| body.0).unwrap_or(Value::Null);
    dify_json_result(
        dispatch_dify(
            &state,
            &headers,
            "dify_conversation_variables",
            json!({ "conversationId": conversation_id, "user": request.get("user"), "variables": request.get("variables") }),
        )
        .await,
        StatusCode::OK,
    )
}

pub async fn dify_message_feedback_handler(
    Path(message_id): Path<String>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let request = body.ok().map(|body| body.0).unwrap_or(Value::Null);
    dify_json_result(
        dispatch_dify(
            &state,
            &headers,
            "dify_message_feedback",
            json!({
                "messageId": message_id,
                "user": request.get("user"),
                "rating": request.get("rating"),
                "content": request.get("content"),
            }),
        )
        .await,
        StatusCode::OK,
    )
}

pub async fn get_run_handler(
    Path((app_slug, run_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    match dispatch_bridge(
        &state,
        "workflow_app_run_get",
        json!({
            "accountId": claims.account_id,
            "appSlug": claims.app_slug,
            "actor": actor(&claims, true),
            "runId": run_id,
        }),
    )
    .await
    {
        Ok(data) => json_response(StatusCode::OK, data),
        Err(error) => error.into_response(),
    }
}

pub async fn cancel_run_handler(
    Path((app_slug, run_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    match dispatch_bridge(
        &state,
        "workflow_app_run_cancel",
        json!({
            "accountId": claims.account_id,
            "appSlug": claims.app_slug,
            "actor": actor(&claims, true),
            "runId": run_id,
        }),
    )
    .await
    {
        Ok(data) => json_response(StatusCode::ACCEPTED, data),
        Err(error) => error.into_response(),
    }
}

fn parse_last_event_id(headers: &HeaderMap) -> Result<u64, ApiError> {
    let Some(raw) = headers.get("last-event-id") else {
        return Ok(0);
    };
    let raw = raw.to_str().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_event_cursor",
            "Last-Event-ID must be a non-negative safe integer",
        )
    })?;
    let value = raw.parse::<u64>().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_event_cursor",
            "Last-Event-ID must be a non-negative safe integer",
        )
    })?;
    if value > 9_007_199_254_740_991 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_event_cursor",
            "Last-Event-ID must be a non-negative safe integer",
        ));
    }
    Ok(value)
}

async fn load_events(
    state: &SharedState,
    claims: &AppSessionClaims,
    run_id: &str,
    after_sequence: u64,
) -> Result<EventsPage, ApiError> {
    let data = dispatch_bridge(
        state,
        "workflow_app_events_list",
        json!({
            "accountId": claims.account_id,
            "appSlug": claims.app_slug,
            "actor": actor(claims, true),
            "runId": run_id,
            "afterSequence": after_sequence,
        }),
    )
    .await?;
    let page: EventsPage = serde_json::from_value(data).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "workflow_app_protocol_error",
            "The application runtime returned invalid event data",
        )
    })?;
    let mut cursor = after_sequence;
    for event in &page.events {
        let valid = event.get("runId").and_then(Value::as_str) == Some(run_id)
            && event.get("type").and_then(Value::as_str).is_some()
            && event.get("timestamp").and_then(Value::as_str).is_some()
            && event
                .get("sequence")
                .and_then(Value::as_u64)
                .is_some_and(|sequence| sequence > cursor);
        if !valid {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "workflow_app_protocol_error",
                "The application runtime returned invalid event data",
            ));
        }
        cursor = event["sequence"].as_u64().expect("validated sequence");
    }
    Ok(page)
}

struct EventStreamState {
    state: SharedState,
    claims: AppSessionClaims,
    run_id: String,
    cursor: u64,
    queue: VecDeque<Value>,
    terminal: bool,
    _metrics_guard: super::metrics::WorkflowAppSseGuard,
}

fn sse_event(value: Value) -> Event {
    let sequence = value.get("sequence").and_then(Value::as_u64).unwrap_or(0);
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("workflow_event");
    Event::default()
        .id(sequence.to_string())
        .event(event_type)
        .data(value.to_string())
}

pub async fn events_handler(
    Path((app_slug, run_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<SharedState>,
) -> Response {
    let claims = match session_for_slug(&state, &headers, &app_slug) {
        Ok(claims) => claims,
        Err(error) => return error.into_response(),
    };
    let cursor = match parse_last_event_id(&headers) {
        Ok(cursor) => cursor,
        Err(error) => return error.into_response(),
    };
    let first = match load_events(&state, &claims, &run_id, cursor).await {
        Ok(page) => page,
        Err(error) => return error.into_response(),
    };
    let events = stream::unfold(
        EventStreamState {
            state,
            claims,
            run_id,
            cursor,
            queue: first.events.into(),
            terminal: first.terminal,
            _metrics_guard: super::metrics::WorkflowAppSseGuard::connect(),
        },
        |mut stream_state| async move {
            loop {
                if let Some(value) = stream_state.queue.pop_front() {
                    if let Some(sequence) = value.get("sequence").and_then(Value::as_u64) {
                        stream_state.cursor = stream_state.cursor.max(sequence);
                    }
                    return Some((Ok::<Event, Infallible>(sse_event(value)), stream_state));
                }
                if stream_state.terminal {
                    return None;
                }
                tokio::time::sleep(SSE_POLL_INTERVAL).await;
                match load_events(
                    &stream_state.state,
                    &stream_state.claims,
                    &stream_state.run_id,
                    stream_state.cursor,
                )
                .await
                {
                    Ok(page) => {
                        stream_state.queue = page.events.into();
                        stream_state.terminal = page.terminal;
                    }
                    Err(_) => return None,
                }
            }
        },
    );
    Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims() -> AppSessionClaims {
        AppSessionClaims {
            scope: String::new(),
            account_id: "acct_a".into(),
            app_id: "app_a".into(),
            app_slug: "review".into(),
            release_id: "rel_a".into(),
            external_subject_key: "anonymous:one".into(),
            authenticated: false,
            subject_id: None,
            group_ids: vec![],
            embed_origin: Some("https://embed.example".into()),
            jti: String::new(),
            iat: 0,
            exp: 0,
        }
    }

    #[test]
    fn app_session_is_signed_scoped_and_origin_bound() {
        let token = issue_session(b"test-secret", claims()).expect("issue session");
        let verified = verify_session(b"test-secret", &token).expect("verify session");
        assert_eq!(verified.scope, APP_SESSION_SCOPE);
        assert_eq!(verified.app_slug, "review");
        assert_eq!(
            verified.embed_origin.as_deref(),
            Some("https://embed.example")
        );
        assert!(verified.exp > verified.iat);
        assert!(!verified.jti.is_empty());
        assert!(verify_session(b"wrong-secret", &token).is_err());
        assert_eq!(verified.exp - verified.iat, APP_SESSION_TTL_SECONDS);
    }

    #[test]
    fn embed_sessions_use_the_short_expiry_window() {
        let token = issue_session_with_ttl(b"test-secret", claims(), EMBED_SESSION_TTL_SECONDS)
            .expect("issue embed session");
        let verified = verify_session(b"test-secret", &token).expect("verify embed session");
        assert_eq!(verified.exp - verified.iat, EMBED_SESSION_TTL_SECONDS);
    }

    #[test]
    fn idempotency_and_event_cursors_are_strictly_bounded() {
        let mut headers = HeaderMap::new();
        assert!(parse_idempotency_key(&headers).is_err());
        headers.insert("idempotency-key", HeaderValue::from_static("idem-1"));
        assert_eq!(parse_idempotency_key(&headers).unwrap(), "idem-1");
        headers.insert("last-event-id", HeaderValue::from_static("42"));
        assert_eq!(parse_last_event_id(&headers).unwrap(), 42);
        headers.insert("last-event-id", HeaderValue::from_static("-1"));
        assert!(parse_last_event_id(&headers).is_err());
    }

    #[test]
    fn actor_never_promotes_anonymous_subject_to_member() {
        let value = actor(&claims(), true);
        assert_eq!(value["authenticated"], false);
        assert_eq!(value["externalSubjectKey"], "anonymous:one");
        assert!(value.get("subjectId").is_none());
        assert_eq!(value["legalConsentGranted"], true);
    }

    #[test]
    fn authenticated_sessions_bypass_the_anonymous_mutation_challenge() {
        let mut member = claims();
        member.authenticated = true;
        assert!(!requires_anonymous_challenge(&member));
        assert!(requires_anonymous_challenge(&claims()));
    }

    #[test]
    fn actor_preserves_verified_oidc_subject_and_groups() {
        let mut member = claims();
        member.authenticated = true;
        member.subject_id = Some("user-1".into());
        member.group_ids = vec!["release-managers".into()];
        let value = actor(&member, false);
        assert_eq!(value["authenticated"], true);
        assert_eq!(value["subjectId"], "user-1");
        assert_eq!(value["groupIds"], json!(["release-managers"]));
    }

    #[test]
    fn mcp_requires_a_bearer_application_key() {
        let mut headers = HeaderMap::new();
        assert!(bearer(&headers).is_err());
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer cog_app_test"),
        );
        assert_eq!(bearer(&headers).unwrap(), "cog_app_test");
    }

    #[test]
    fn result_share_ttl_is_strictly_bounded() {
        let valid: ResultShareCreateRequest =
            serde_json::from_value(json!({ "ttlSeconds": 60 })).expect("valid ttl");
        assert_eq!(valid.ttl_seconds, Some(60));
        assert!(serde_json::from_value::<ResultShareCreateRequest>(json!({
            "ttlSeconds": 60,
            "permanent": true
        }))
        .is_err());
    }

    #[test]
    fn embed_origin_requires_an_exact_secure_or_loopback_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://embed.example"),
        );
        assert_eq!(request_origin(&headers).unwrap(), "https://embed.example");
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://embed.example/path"),
        );
        assert!(request_origin(&headers).is_err());
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://embed.example"),
        );
        assert!(request_origin(&headers).is_err());
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:3000"),
        );
        assert_eq!(request_origin(&headers).unwrap(), "http://localhost:3000");
    }

    #[test]
    fn custom_domain_hostname_uses_the_forwarded_host_without_its_port() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("Portal.Example.com:443"),
        );
        assert_eq!(request_hostname(&headers).unwrap(), "portal.example.com");
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("portal.example.com,attacker.example"),
        );
        assert!(request_hostname(&headers).is_err());
    }
}
