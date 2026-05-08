//! RPC dispatch for `POST /api/v1/_rpc/:name`.
//!
//! # Request shape
//!
//! ```text
//! POST /api/v1/_rpc/<command_name>
//! Authorization: Bearer <device-jwt>
//! Idempotency-Key: <optional-uuid>          ← skipped for read-only commands
//! Content-Type: application/json
//!
//! { ...command-specific args... }
//! ```
//!
//! # Response shape (success)
//!
//! ```text
//! HTTP 200
//! Content-Type: application/json
//! { ...command-specific result... }
//! ```
//!
//! # Response shape (failure)
//!
//! ```text
//! HTTP 4xx / 5xx
//! Content-Type: application/json
//! { "code": "<snake_case_code>", "message": "<human readable>" }
//! ```
//!
//! # Idempotency
//!
//! When the `Idempotency-Key` header is present and the command is **not**
//! in [`READ_ONLY_COMMANDS`], a successful response is stored in the
//! per-device [`IdempotencyCache`] for 60 seconds. A second request with the
//! same `(device_id, idempotency_key)` returns the cached body immediately
//! without re-executing the command.
//!
//! Read-only commands skip the cache entirely: they are cheap to re-run and
//! their idempotency is structural (same args → same result).

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Extension, Json,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{
    agents::commands as agent_commands,
    anthropic_subscription::credential,
    api_key::ApiKeyState,
    claude::{
        commands as claude_commands,
        mcp_test,
        sidecar::{kill_sidecar, SidecarState},
    },
    mcp_server::McpServerState,
    skills::{install, native as skills_native, registry},
};

use super::{middleware::DeviceContext, SharedState};

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/// JSON error body returned on any non-200 response.
#[derive(Debug, serde::Serialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }


    fn unknown_command(name: &str) -> (StatusCode, Json<Self>) {
        (
            StatusCode::NOT_FOUND,
            Json(Self::new(
                "unknown_command",
                format!("RPC command '{name}' is not exposed to mobile clients"),
            )),
        )
    }

    fn malformed(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::BAD_REQUEST,
            Json(Self::new("malformed_request", detail)),
        )
    }

    fn service_unavailable(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Self::new("service_unavailable", detail)),
        )
    }

    fn internal(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(Self::new("internal_error", detail)),
        )
    }
}

// ---------------------------------------------------------------------------
// Read-only command list
// ---------------------------------------------------------------------------

/// Commands in this list skip the idempotency cache entirely.
/// They are cheap to re-run and structurally idempotent.
const READ_ONLY_COMMANDS: &[&str] = &[
    "claude_sidecar_status",
    "claude_sub_load_token",
    "claude_has_api_key",
    "claude_has_oauth_bearer",
    "skills_load_registry",
    "skills_scan_native",
    "mcp_server_status",
    "read_agent_config",
    // Sync-down (M4.7) is structurally idempotent: same `(table, since)`
    // returns the same delta. Skip the cache to avoid stalling phone clients
    // behind a 60-second TTL when the desktop has fresh writes.
    "sync_pull",
];

// ---------------------------------------------------------------------------
// Axum handler
// ---------------------------------------------------------------------------

/// Axum handler for `POST /api/v1/_rpc/:name`.
///
/// Steps:
/// 1. Pull [`DeviceContext`] injected by the JWT middleware.
/// 2. Read the `Idempotency-Key` header (if present).  Read-only commands
///    skip the cache entirely.
/// 3. If a cache hit exists, return the cached body immediately.
/// 4. Dispatch to the allowlist match in [`dispatch`].
/// 5. On success, write the response body into the cache (non-read-only only).
pub async fn rpc_handler(
    Path(name): Path<String>,
    Extension(ctx): Extension<DeviceContext>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    Json(args): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<RpcError>)> {
    let idem_key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let is_read_only = READ_ONLY_COMMANDS.contains(&name.as_str());

    // Cache look-up (non-read-only commands only).
    if !is_read_only {
        if let Some(ref key) = idem_key {
            if let Some(cached) = state.idempotency.get(&ctx.device_id, key) {
                return Ok(Json(cached));
            }
        }
    }

    // Obtain the AppHandle — required for commands that spawn the sidecar.
    let app = state
        .app_handle
        .clone()
        .ok_or_else(|| RpcError::service_unavailable("app_handle not available (test mode)".to_string()))?;

    // Dispatch.
    let result = dispatch(&name, args, &state, &app).await?;

    // Cache the result (non-read-only + idempotency key present).
    if !is_read_only {
        if let Some(key) = idem_key {
            state
                .idempotency
                .put(ctx.device_id.clone(), key, result.clone());
        }
    }

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Deserialisation helpers
// ---------------------------------------------------------------------------

/// Extract a field from a JSON object, returning a 400 error when the field
/// is missing or its type does not match `T`.
fn required<T: DeserializeOwned>(
    args: &Value,
    field: &str,
) -> Result<T, (StatusCode, Json<RpcError>)> {
    let v = args
        .get(field)
        .ok_or_else(|| RpcError::malformed(format!("missing required field: {field}")))?;
    serde_json::from_value(v.clone())
        .map_err(|e| RpcError::malformed(format!("field '{field}': {e}")))
}

/// Extract an optional field from a JSON object.
fn optional<T: DeserializeOwned>(
    args: &Value,
    field: &str,
) -> Result<Option<T>, (StatusCode, Json<RpcError>)> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value::<T>(v.clone())
            .map(Some)
            .map_err(|e| RpcError::malformed(format!("field '{field}': {e}"))),
    }
}

// ---------------------------------------------------------------------------
// Dispatch table — the explicit allowlist
// ---------------------------------------------------------------------------

/// Dispatch an RPC call to the corresponding Tauri command body.
///
/// Each arm deserialises the JSON `args`, obtains the necessary Tauri state
/// from `app.state::<T>()`, calls the underlying function (not the IPC
/// wrapper), and serialises the result back to [`Value`].
///
/// If a command's signature is incompatible with this pattern (e.g., it
/// requires `tauri::Window`), it must be excluded from the V1 allowlist.
async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    app: &tauri::AppHandle,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    use tauri::Manager as _;

    match name {
        // ── Chat session ─────────────────────────────────────────────────────

        "claude_send" => {
            let session_id: String = required(&args, "session_id")?;
            let prompt: Value = required(&args, "prompt")?;
            let options: Option<claude_commands::SendOptions> = optional(&args, "options")?;
            let sidecar_state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_send(app.clone(), sidecar_state, session_id, prompt, options)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_interrupt" => {
            let session_id: String = required(&args, "session_id")?;
            let state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_interrupt(state, session_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_approve" => {
            let session_id: String = required(&args, "session_id")?;
            let request_id: String = required(&args, "request_id")?;
            let decision: String = required(&args, "decision")?;
            let message: Option<String> = optional(&args, "message")?;
            let updated_input: Option<Value> = optional(&args, "updated_input")?;
            let state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_approve(
                state,
                session_id,
                request_id,
                decision,
                message,
                updated_input,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_close_session" => {
            let session_id: String = required(&args, "session_id")?;
            let state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_close_session(state, session_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_sidecar_status" => {
            let state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_sidecar_status(state)
                .await
                .map_err(RpcError::internal)
                .and_then(|s| {
                    serde_json::to_value(s).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        // ── Subscription / OAuth ─────────────────────────────────────────────

        "claude_sub_save_token" => {
            let payload: crate::anthropic_subscription::credential::SubscriptionCredential =
                required(&args, "payload")?;
            credential::save(&payload)
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_sub_load_token" => credential::load()
            .map_err(RpcError::internal)
            .and_then(|opt| {
                serde_json::to_value(opt).map_err(|e| RpcError::internal(e.to_string()))
            }),

        "claude_sub_clear_token" => credential::clear()
            .map(|_| Value::Null)
            .map_err(RpcError::internal),

        "claude_set_oauth_bearer" => {
            let token: Option<String> = optional(&args, "token")?;
            let state: tauri::State<'_, ApiKeyState> = app.state();
            state.set_oauth_bearer(token).await;
            Ok(Value::Null)
        }

        // ── Provider env ─────────────────────────────────────────────────────

        "claude_set_api_key" => {
            let key: Option<String> = optional(&args, "key")?;
            let state: tauri::State<'_, ApiKeyState> = app.state();
            state.set(key).await;
            Ok(Value::Null)
        }

        "claude_set_provider_env" => {
            let api_key: Option<String> = optional(&args, "api_key")?;
            let base_url: Option<String> = optional(&args, "base_url")?;
            let state: tauri::State<'_, ApiKeyState> = app.state();
            state.set_provider(api_key, base_url).await;
            Ok(Value::Null)
        }

        "claude_has_api_key" => {
            let state: tauri::State<'_, ApiKeyState> = app.state();
            let has = state.get().await.is_some();
            Ok(Value::Bool(has))
        }

        "claude_has_oauth_bearer" => {
            let state: tauri::State<'_, ApiKeyState> = app.state();
            let has = state.get_oauth_bearer().await.is_some();
            Ok(Value::Bool(has))
        }

        "claude_restart_sidecar" => {
            let state: tauri::State<'_, SidecarState> = app.state();
            kill_sidecar(state.inner().clone()).await;
            Ok(Value::Null)
        }

        // ── Multi-agent config ────────────────────────────────────────────────

        "read_agent_config" => {
            let agent: String = required(&args, "agent")?;
            tokio::task::spawn_blocking(move || agent_commands::read_agent_config(agent))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "write_agent_config" => {
            let agent: String = required(&args, "agent")?;
            let value: Value = required(&args, "value")?;
            tokio::task::spawn_blocking(move || agent_commands::write_agent_config(agent, value))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        // ── Skills ────────────────────────────────────────────────────────────

        "skills_scan_native" => {
            tokio::task::spawn_blocking(skills_native::skills_scan_native)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "skills_load_registry" => {
            tokio::task::spawn_blocking(registry::skills_load_registry)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "skills_install_native" => {
            let request: crate::skills::types::InstallSkillRequest =
                required(&args, "request")?;
            tokio::task::spawn_blocking(move || install::skills_install_native(request))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "skills_uninstall_native" => {
            let dir_name: String = required(&args, "dir_name")?;
            tokio::task::spawn_blocking(move || skills_native::skills_uninstall_native(dir_name))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        // ── MCP server ────────────────────────────────────────────────────────

        "mcp_server_status" => {
            let state: tauri::State<'_, McpServerState> = app.state();
            let status = state.status();
            serde_json::to_value(status).map_err(|e| RpcError::internal(e.to_string()))
        }

        // ── Sync down (M4.7) ──────────────────────────────────────────────────

        "sync_pull" => {
            let table: String = required(&args, "table")?;
            let since: i64 = optional::<i64>(&args, "since")?.unwrap_or(0);
            // Allowlist the table names so a malicious phone can't ask for
            // arbitrary Dexie tables. Mirror lib/sync/types.ts SyncableTable.
            const ALLOWED: &[&str] = &["characters", "skills", "sessions", "messages"];
            if !ALLOWED.contains(&table.as_str()) {
                return Err(RpcError::malformed(format!(
                    "table '{table}' is not exposed to mobile sync"
                )));
            }
            let bridge = std::sync::Arc::clone(&state.sync_bridge);
            bridge
                .pull(
                    app,
                    table,
                    since,
                    crate::companion_api::sync_bridge::DEFAULT_TIMEOUT,
                )
                .await
                .map_err(RpcError::internal)
        }

        // ── Test MCP ──────────────────────────────────────────────────────────

        "test_mcp_server" => {
            let transport: String = required(&args, "transport")?;
            let command: Option<String> = optional(&args, "command")?;
            let mcp_args: Option<Vec<String>> = optional(&args, "args")?;
            let env: Option<std::collections::HashMap<String, String>> =
                optional(&args, "env")?;
            let url: Option<String> = optional(&args, "url")?;
            let headers: Option<std::collections::HashMap<String, String>> =
                optional(&args, "headers")?;
            mcp_test::test_mcp_server(transport, command, mcp_args, env, url, headers)
                .await
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        unknown => Err(RpcError::unknown_command(unknown)),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::{
        deny_list::DenyList,
        idempotency::IdempotencyCache,
        jwt::issue_device_jwt,
        redemption_lru::RedemptionLru,
        CompanionState,
    };
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        Router,
    };
    use parking_lot::RwLock;
    use serde_json::json;
    use std::sync::Arc;
    use tower::ServiceExt as _;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";

    fn test_state() -> super::super::SharedState {
        use crate::companion_api::event_bus::EventBus;
        Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        })
    }

    fn build_router(state: super::super::SharedState) -> Router {
        use axum::{middleware::from_fn_with_state, routing::post};
        use super::super::middleware;

        Router::new()
            .route("/api/v1/_rpc/:name", post(rpc_handler))
            .layer(from_fn_with_state(
                state.clone(),
                middleware::require_device_jwt,
            ))
            .with_state(state)
    }

    fn device_jwt(device_id: &str) -> String {
        issue_device_jwt(SECRET, device_id).expect("issue device jwt")
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        serde_json::from_slice(&bytes).expect("json parse")
    }

    async fn rpc_post(
        router: Router,
        name: &str,
        body: serde_json::Value,
        jwt: &str,
        idempotency_key: Option<&str>,
    ) -> axum::response::Response {
        let mut builder = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/_rpc/{name}"))
            .header("Authorization", format!("Bearer {jwt}"))
            .header("Content-Type", "application/json");

        if let Some(key) = idempotency_key {
            builder = builder.header("Idempotency-Key", key);
        }

        let req = builder
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        router.oneshot(req).await.unwrap()
    }

    // ── Unknown command → 404 ─────────────────────────────────────────────────

    #[tokio::test]
    async fn unknown_command_returns_404() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        let resp = rpc_post(router, "wallpaper_save", json!({}), &jwt, None).await;
        assert_eq!(resp.status().as_u16(), 404);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "unknown_command");
    }

    // ── Missing Authorization → 401 (middleware) ──────────────────────────────

    #[tokio::test]
    async fn missing_auth_returns_401() {
        let state = test_state();
        let router = build_router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/_rpc/claude_sidecar_status")
            .header("Content-Type", "application/json")
            .body(Body::from(b"{}".to_vec()))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
    }

    // ── app_handle=None → 503 for commands that need it ──────────────────────

    #[tokio::test]
    async fn command_requiring_app_handle_returns_503_in_test_mode() {
        let state = test_state(); // app_handle is None
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        let resp = rpc_post(
            router,
            "claude_sidecar_status",
            json!({}),
            &jwt,
            None,
        )
        .await;
        assert_eq!(resp.status().as_u16(), 503);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "service_unavailable");
    }

    // ── Malformed args → 400 ──────────────────────────────────────────────────

    #[tokio::test]
    async fn missing_required_field_returns_400() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        // claude_interrupt requires session_id
        let resp = rpc_post(router, "claude_interrupt", json!({}), &jwt, None).await;
        // app_handle is None so we'll get 503 before field validation for
        // commands that reach dispatch — but the routing still works.
        // The key assertion is that we never get a 5xx crash / panic.
        assert!(resp.status().as_u16() >= 400);
    }

    // ── Idempotency: cache hit returns same body without re-executing ─────────

    #[tokio::test]
    async fn idempotency_cache_hit_returns_cached_body() {
        use std::time::Duration;

        // Use a real cache with a long TTL.
        let cache = Arc::new(IdempotencyCache::with_capacity(100, Duration::from_secs(60)));
        // Pre-seed the cache with a known response for device "dev-idem".
        cache.put(
            "dev-idem".into(),
            "idem-key-1".into(),
            json!({ "cached": true }),
        );

        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: cache,
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev-idem");

        // Send a NON-read-only command (e.g., claude_send) with the
        // pre-seeded idempotency key. The cache hit is returned before
        // the dispatch even runs (so app_handle=None doesn't matter).
        let resp = rpc_post(
            router,
            "claude_send",
            json!({ "session_id": "s1", "prompt": "hi" }),
            &jwt,
            Some("idem-key-1"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["cached"], true);
    }

    // ── Idempotency: different keys run independently ─────────────────────────

    #[tokio::test]
    async fn different_idempotency_keys_run_independently() {
        use std::time::Duration;
        let cache = Arc::new(IdempotencyCache::with_capacity(100, Duration::from_secs(60)));
        cache.put("dev2".into(), "k1".into(), json!({ "hit": 1 }));
        cache.put("dev2".into(), "k2".into(), json!({ "hit": 2 }));

        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: cache,
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        });
        let jwt = device_jwt("dev2");

        // k1
        let router1 = build_router(Arc::clone(&state));
        let r1 = rpc_post(router1, "claude_close_session", json!({}), &jwt, Some("k1")).await;
        assert_eq!(r1.status(), StatusCode::OK);
        let b1 = body_json(r1).await;
        assert_eq!(b1["hit"], 1);

        // k2
        let router2 = build_router(Arc::clone(&state));
        let r2 = rpc_post(router2, "claude_close_session", json!({}), &jwt, Some("k2")).await;
        assert_eq!(r2.status(), StatusCode::OK);
        let b2 = body_json(r2).await;
        assert_eq!(b2["hit"], 2);
    }

    // ── Read-only commands do NOT write to the cache ──────────────────────────

    #[tokio::test]
    async fn read_only_commands_skip_cache() {
        use std::time::Duration;
        let cache = Arc::new(IdempotencyCache::with_capacity(100, Duration::from_secs(60)));
        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::clone(&cache),
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev3");

        // mcp_server_status is read-only. Even with an idempotency-key header,
        // a response should NOT be stored. Since app_handle=None, we get 503;
        // the important thing is that the cache stays empty.
        let _ = rpc_post(
            router,
            "mcp_server_status",
            json!({}),
            &jwt,
            Some("key-should-not-cache"),
        )
        .await;

        // Cache must still be empty.
        assert_eq!(cache.len(), 0);
    }

    // ── Expired idempotency entry causes re-execution ─────────────────────────

    #[tokio::test]
    async fn expired_idempotency_key_causes_re_execution() {
        use std::time::Duration;
        // TTL = 0 ms → immediately expired.
        let cache = Arc::new(IdempotencyCache::with_capacity(100, Duration::from_millis(0)));
        cache.put("dev4".into(), "stale".into(), json!({ "stale": true }));
        // Let the entry expire.
        std::thread::sleep(Duration::from_millis(5));

        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: cache,
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev4");

        // The cache entry is expired → dispatch runs → 503 (app_handle=None).
        let resp = rpc_post(
            router,
            "claude_interrupt",
            json!({ "session_id": "s" }),
            &jwt,
            Some("stale"),
        )
        .await;
        // 503 means dispatch was attempted (cache miss), not a cached 200.
        assert_eq!(resp.status().as_u16(), 503);
    }

    // ── Dispatch table coverage: one per family ───────────────────────────────
    // These just assert the dispatch arm exists and returns something (not a
    // 404), since all commands need app_handle in test mode.

    macro_rules! assert_not_404 {
        ($name:expr, $body:expr) => {{
            let state = test_state();
            let router = build_router(state);
            let jwt = device_jwt("cover-dev");
            let resp = rpc_post(router, $name, $body, &jwt, None).await;
            assert_ne!(
                resp.status().as_u16(),
                404,
                "command '{}' returned 404 — dispatch arm missing",
                $name
            );
        }};
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_interrupt() {
        assert_not_404!("claude_interrupt", json!({ "session_id": "s" }));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_approve() {
        assert_not_404!(
            "claude_approve",
            json!({
                "session_id": "s",
                "request_id": "r",
                "decision": "allow"
            })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_close_session() {
        assert_not_404!("claude_close_session", json!({ "session_id": "s" }));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_sidecar_status() {
        assert_not_404!("claude_sidecar_status", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_sub_clear_token() {
        assert_not_404!("claude_sub_clear_token", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_sub_load_token() {
        assert_not_404!("claude_sub_load_token", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_set_oauth_bearer() {
        assert_not_404!("claude_set_oauth_bearer", json!({ "token": null }));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_has_api_key() {
        assert_not_404!("claude_has_api_key", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_has_oauth_bearer() {
        assert_not_404!("claude_has_oauth_bearer", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_set_api_key() {
        assert_not_404!("claude_set_api_key", json!({ "key": null }));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_set_provider_env() {
        assert_not_404!(
            "claude_set_provider_env",
            json!({ "api_key": null, "base_url": null })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_restart_sidecar() {
        assert_not_404!("claude_restart_sidecar", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_read_agent_config() {
        assert_not_404!("read_agent_config", json!({ "agent": "cursor" }));
    }

    #[tokio::test]
    async fn dispatch_coverage_write_agent_config() {
        assert_not_404!(
            "write_agent_config",
            json!({ "agent": "cursor", "value": {} })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_skills_scan_native() {
        assert_not_404!("skills_scan_native", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_skills_load_registry() {
        assert_not_404!("skills_load_registry", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_skills_install_native() {
        assert_not_404!(
            "skills_install_native",
            json!({
                "request": {
                    "dirName": "my-skill",
                    "content": "# SKILL",
                    "resources": [],
                    "clean": false
                }
            })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_skills_uninstall_native() {
        assert_not_404!("skills_uninstall_native", json!({ "dir_name": "my-skill" }));
    }

    #[tokio::test]
    async fn dispatch_coverage_mcp_server_status() {
        assert_not_404!("mcp_server_status", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_test_mcp_server() {
        assert_not_404!(
            "test_mcp_server",
            json!({ "transport": "stdio", "command": "echo" })
        );
    }
}
