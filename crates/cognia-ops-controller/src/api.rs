use crate::auth::{Authenticator, Claims};
use crate::model::*;
use crate::store::{Store, StoreError};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Duration;
use cognia_deployment::{DeploymentTarget, OperationKind};
use futures_util::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn Store>,
    pub auth: Arc<dyn Authenticator>,
}

impl AppState {
    pub fn new(store: Arc<dyn Store>, auth: Arc<dyn Authenticator>) -> Self {
        Self { store, auth }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/livez", get(livez))
        .route("/readyz", get(readyz))
        .route("/v1/providers/capabilities", get(capabilities))
        .route("/v1/targets/validate", post(validate_target))
        .route("/v1/servers", get(list_servers))
        .route("/v1/servers/{id}", get(get_server))
        .route("/v1/servers/{id}/logs", get(list_logs))
        .route(
            "/v1/servers/{id}/backups",
            get(list_backups).post(create_backup),
        )
        .route("/v1/servers/{id}/restore", post(create_restore))
        .route("/v1/servers/{id}/upgrade", post(create_upgrade))
        .route("/v1/servers/{id}/rollback", post(create_rollback))
        .route("/v1/servers/{id}/rotate-key", post(create_rotate_key))
        .route("/v1/operations/{id}", get(get_operation))
        .route("/v1/admin-leases", post(create_admin_lease))
        .route("/v1/events", get(events))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn livez() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn readyz(State(state): State<AppState>) -> Response {
    match state.store.list_servers("__readiness__").await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_ready",
            error.to_string(),
            None,
        ),
    }
}

async fn capabilities(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let claims = match authorize(&state, &headers, "servers:read").await {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    let _ = claims;
    Json(ProviderCapabilities::default()).into_response()
}

async fn validate_target(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Response {
    if let Err(response) = authorize_mutation(&state, &headers, "servers:operate").await {
        return response;
    }
    match serde_json::from_value::<DeploymentTarget>(value) {
        Ok(target) => {
            let issues = target
                .production_certification_issues()
                .into_iter()
                .map(|issue| format!("{issue:?}"))
                .collect::<Vec<_>>();
            Json(json!({
                "valid": true,
                "productionCertified": issues.is_empty(),
                "certificationIssues": issues,
                "normalized": target,
            }))
            .into_response()
        }
        Err(error) => api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_deployment_target",
            "DeploymentTarget does not match deploy.cognia.dev/v1alpha1",
            Some(json!({ "validation": error.to_string() })),
        ),
    }
}

async fn list_servers(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let claims = match authorize(&state, &headers, "servers:read").await {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    match state.store.list_servers(&claims.tenant_id).await {
        Ok(items) => Json(json!({ "items": items })).into_response(),
        Err(error) => store_error(error),
    }
}

async fn get_server(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let claims = match authorize(&state, &headers, "servers:read").await {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    match state.store.get_server(&claims.tenant_id, &id).await {
        Ok(Some(server)) => Json(server).into_response(),
        Ok(None) => api_error(
            StatusCode::NOT_FOUND,
            "server_not_found",
            "Server not found",
            None,
        ),
        Err(error) => store_error(error),
    }
}

#[derive(Deserialize)]
struct LogQuery {
    limit: Option<usize>,
}

async fn list_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<LogQuery>,
    headers: HeaderMap,
) -> Response {
    let claims = match authorize(&state, &headers, "servers:read").await {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    match state
        .store
        .list_logs(&claims.tenant_id, &id, query.limit.unwrap_or(200).min(1000))
        .await
    {
        Ok(items) => Json(json!({ "items": items })).into_response(),
        Err(error) => store_error(error),
    }
}

async fn list_backups(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let claims = match authorize(&state, &headers, "servers:read").await {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    match state.store.list_backups(&claims.tenant_id, &id).await {
        Ok(items) => Json(json!({ "items": items })).into_response(),
        Err(error) => store_error(error),
    }
}

async fn create_backup(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    create_operation(state, headers, id, OperationKind::Backup, body).await
}

async fn create_restore(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    create_operation(state, headers, id, OperationKind::Restore, body).await
}

async fn create_upgrade(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    create_operation(state, headers, id, OperationKind::Upgrade, body).await
}

async fn create_rollback(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    create_operation(state, headers, id, OperationKind::Rollback, body).await
}

async fn create_rotate_key(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    create_operation(state, headers, id, OperationKind::RotateKey, body).await
}

async fn create_operation(
    state: AppState,
    headers: HeaderMap,
    target_id: String,
    kind: OperationKind,
    body: Option<Json<Value>>,
) -> Response {
    let claims = match authorize_mutation(&state, &headers, "servers:operate").await {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    let idempotency_key = header_value(&headers, "idempotency-key")
        .expect("authorize_mutation checked the header")
        .to_owned();
    let request_value = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    match state
        .store
        .operation_by_idempotency(&claims.tenant_id, &idempotency_key)
        .await
    {
        Ok(Some(existing))
            if existing.target_id == target_id
                && existing.kind == kind
                && existing.request == request_value =>
        {
            return (StatusCode::ACCEPTED, Json(existing)).into_response();
        }
        Ok(Some(_)) => {
            return api_error(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                "Idempotency-Key was already used for a different mutation",
                None,
            );
        }
        Ok(None) => {}
        Err(error) => return store_error(error),
    }
    if kind.requires_admin_lease() {
        if !claims.has_scope("servers:admin") {
            return api_error(
                StatusCode::FORBIDDEN,
                "insufficient_scope",
                "servers:admin is required",
                None,
            );
        }
        let token = match header_value(&headers, "x-admin-lease") {
            Some(token) => token,
            None => {
                return api_error(
                    StatusCode::FORBIDDEN,
                    "admin_lease_required",
                    "A short-lived operation-bound admin lease is required",
                    None,
                )
            }
        };
        match state
            .store
            .validate_admin_lease(&claims.tenant_id, &claims.subject, &target_id, kind, token)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                return api_error(
                    StatusCode::FORBIDDEN,
                    "admin_lease_invalid",
                    "The admin lease is expired or does not match this user and operation",
                    None,
                )
            }
            Err(error) => return store_error(error),
        }
    }
    let input = NewOperation {
        tenant_id: claims.tenant_id,
        target_id,
        kind,
        request: request_value,
        created_by: claims.subject,
        idempotency_key,
        admin_lease: header_value(&headers, "x-admin-lease").map(str::to_owned),
    };
    match state.store.create_operation(input).await {
        Ok(operation) => (StatusCode::ACCEPTED, Json(operation)).into_response(),
        Err(error) => store_error(error),
    }
}

async fn get_operation(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let claims = match authorize(&state, &headers, "servers:read").await {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    match state.store.get_operation(&claims.tenant_id, id).await {
        Ok(Some(operation)) => Json(operation).into_response(),
        Ok(None) => api_error(
            StatusCode::NOT_FOUND,
            "operation_not_found",
            "Operation not found",
            None,
        ),
        Err(error) => store_error(error),
    }
}

async fn create_admin_lease(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateAdminLeaseRequest>,
) -> Response {
    let claims = match authorize(&state, &headers, "servers:admin").await {
        Ok(claims) => claims,
        Err(response) => return response,
    };
    if !request.operation.requires_admin_lease() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "admin_lease_not_required",
            "This operation does not require an admin lease",
            None,
        );
    }
    let ttl = request.ttl_seconds.unwrap_or(120).clamp(30, 300);
    match state
        .store
        .create_admin_lease(
            &claims.tenant_id,
            &claims.subject,
            &request.target_id,
            request.operation,
            Duration::seconds(ttl as i64),
        )
        .await
    {
        Ok(lease) => Json(lease).into_response(),
        Err(error) => store_error(error),
    }
}

async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, Response> {
    let claims = authorize(&state, &headers, "servers:read").await?;
    let after = header_value(&headers, "last-event-id")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let store = Arc::clone(&state.store);
    let tenant_id = claims.tenant_id;
    let stream = async_stream::stream! {
        let mut cursor = after;
        let mut interval = tokio::time::interval(StdDuration::from_secs(2));
        loop {
            interval.tick().await;
            match store.events_after(&tenant_id, cursor).await {
                Ok(events) => {
                    for event in events {
                        cursor = cursor.max(event.id);
                        let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".into());
                        yield Ok(Event::default().id(event.id.to_string()).event("operation").data(data));
                    }
                }
                Err(_) => {
                    yield Ok(Event::default().event("controller-error").data(
                        r#"{"code":"event_storage_unavailable"}"#,
                    ));
                }
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(StdDuration::from_secs(15))
            .text("keep-alive"),
    ))
}

async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    required_scope: &str,
) -> Result<Claims, Response> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| {
            api_error(
                StatusCode::UNAUTHORIZED,
                "authentication_required",
                "A bearer access token is required",
                None,
            )
        })?;
    let claims = state.auth.authenticate(auth).await.map_err(|error| {
        api_error(
            StatusCode::UNAUTHORIZED,
            "invalid_access_token",
            error.to_string(),
            None,
        )
    })?;
    if !claims.has_scope(required_scope) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "insufficient_scope",
            format!("{required_scope} is required"),
            None,
        ));
    }
    Ok(claims)
}

async fn authorize_mutation(
    state: &AppState,
    headers: &HeaderMap,
    required_scope: &str,
) -> Result<Claims, Response> {
    let claims = authorize(state, headers, required_scope).await?;
    if header_value(headers, "idempotency-key").is_none() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "idempotency_key_required",
            "Idempotency-Key is required for every mutation",
            None,
        ));
    }
    Ok(claims)
}

fn header_value<'a>(headers: &'a HeaderMap, key: &str) -> Option<&'a str> {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
}

fn store_error(error: StoreError) -> Response {
    match error {
        StoreError::NotFound => api_error(
            StatusCode::NOT_FOUND,
            "not_found",
            "The requested resource was not found",
            None,
        ),
        StoreError::TargetBusy => {
            api_error(StatusCode::CONFLICT, "target_busy", error.to_string(), None)
        }
        StoreError::InvalidTransition => api_error(
            StatusCode::CONFLICT,
            "invalid_operation_transition",
            error.to_string(),
            None,
        ),
        StoreError::IdempotencyConflict => api_error(
            StatusCode::CONFLICT,
            "idempotency_conflict",
            error.to_string(),
            None,
        ),
        StoreError::AdminLeaseInvalid => api_error(
            StatusCode::FORBIDDEN,
            "admin_lease_invalid",
            error.to_string(),
            None,
        ),
        StoreError::Database(_) => api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "The controller storage operation failed",
            None,
        ),
    }
}

fn api_error(
    status: StatusCode,
    code: impl Into<String>,
    message: impl Into<String>,
    details: Option<Value>,
) -> Response {
    (
        status,
        Json(OpsErrorBody {
            code: code.into(),
            message: message.into(),
            details,
        }),
    )
        .into_response()
}
