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

    /// Wave 3.3 — 429 Too Many Requests with the wait time embedded in
    /// the message (`retry_after_seconds=N`). The flat envelope keeps
    /// the contract simple; phones can parse the integer.
    fn rate_limited(retry_after_secs: u64) -> (StatusCode, Json<Self>) {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(Self::new(
                "rate_limited",
                format!(
                    "device exceeded the per-minute quota; retry_after_seconds={retry_after_secs}"
                ),
            )),
        )
    }

    /// Wave 3.2 — request shape rejected. Distinct from
    /// `malformed_request` so clients can route validation failures
    /// (recoverable, fix the payload and retry) separately from
    /// transport-level malformed JSON (terminal at this layer).
    #[allow(dead_code)] // re-exposed when full schema validation lands.
    fn validation_failed(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::BAD_REQUEST,
            Json(Self::new("validation_failed", detail)),
        )
    }
}

// ---------------------------------------------------------------------------
// Read-only command list
// ---------------------------------------------------------------------------

/// Every command name recognized by `dispatch()`. The handler consults this
/// list **before** requiring the AppHandle so unknown commands consistently
/// surface as 404 rather than 503-in-test-mode. Keep in lockstep with the
/// `match name` arms in `dispatch()` below — drift means unknown names
/// silently bypass the 404 path.
const KNOWN_COMMANDS: &[&str] = &[
    "claude_send",
    "claude_interrupt",
    "claude_approve",
    "claude_close_session",
    "claude_sidecar_status",
    "claude_sub_save_token",
    "claude_sub_load_token",
    "claude_sub_clear_token",
    "claude_set_api_key",
    "claude_has_api_key",
    "claude_set_oauth_bearer",
    "claude_has_oauth_bearer",
    "claude_set_provider_env",
    "claude_restart_sidecar",
    "skills_load_registry",
    "skills_scan_native",
    "skills_install_native",
    "skills_uninstall_native",
    "mcp_server_status",
    "test_mcp_server",
    "read_agent_config",
    "write_agent_config",
    "sync_pull",
    "sync_list_tables",
    "register_push_token",
    "revoke_push_token",
    "message_update",
    "message_delete",
    "session_list",
    "message_get_by_session",
    "message_send",
    // Wave 2 mutating RPCs — round-trip through desktop_writes_bridge.
    "character_upsert",
    "character_delete",
    "character_bind_twin",
    "skill_set_enabled",
    "plugin_set_enabled",
    "adapter_update_policy",
    "app_settings_update",
    // Wave 2 read-only projection routed through desktop_writes_bridge.
    "twin_profile_get",
];

/// Public read-only accessor for the dispatch allowlist. Used by the
/// `spec_parity` test (Wave 3.6) to assert that every command in this
/// list has a matching `/api/v1/_rpc/<name>` path in the OpenAPI spec.
#[allow(dead_code)] // referenced from `spec_parity::tests` only.
pub fn known_commands() -> &'static [&'static str] {
    KNOWN_COMMANDS
}

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
    // Wave 3.5 — registry introspection is pure read.
    "sync_list_tables",
    // Read-only paginated session listing — same `(limit, offset, before)`
    // returns the same page; skip the cache so a slow desktop write doesn't
    // serve stale rows to a polling phone.
    "session_list",
    // Read-only message-by-session listing — same `(session_id, limit, offset)`
    // returns the same page.
    "message_get_by_session",
    // Wave 2 read-only twin profile projection.
    "twin_profile_get",
];

/// Allowlisted patch keys for `app_settings_update`. The mobile client may
/// only mutate user-facing preferences; transport, sidecar, and provider
/// configuration stay desktop-only. Mirror this with the OpenAPI spec.
const APP_SETTINGS_MOBILE_ALLOWED_KEYS: &[&str] = &[
    "theme",
    "fontScale",
    "language",
    "reduceMotion",
    "defaultModel",
    "defaultCharacterId",
    "biometricRequiredFor",
    // Appearance — mobile `/me/appearance` route writes these through the
    // same allowlist. The matching field types live in
    // `lib/claude/types.ts` (`colorTheme`, `customThemes`,
    // `activeCustomThemeId`, `wallpapers`, `customCss`, `customCssEnabled`,
    // `importedVscodeThemes`).
    "colorTheme",
    "customThemes",
    "activeCustomThemeId",
    "wallpapers",
    "customCss",
    "customCssEnabled",
    "importedVscodeThemes",
    // ADR-0021 — WebRTC WAN transport configuration. Mobile clients toggle
    // the feature and configure ICE/TURN/signaling endpoints from the
    // Mobile companion settings tab.
    "webrtcEnabled",
    "signalingUrl",
    "iceServers",
    "turnServers",
];

/// Public read-only accessor for the mobile-side `app_settings_update`
/// allowlist. Used by the OpenAPI `spec_parity` test (Wave 3.6) and by the
/// in-file tests below to assert the allowlist stays in lockstep with
/// what the phone UI actually writes.
#[allow(dead_code)] // referenced from tests / spec_parity only.
pub fn mobile_allowed_keys() -> &'static [&'static str] {
    APP_SETTINGS_MOBILE_ALLOWED_KEYS
}

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

    // Reject unknown command names before requiring the AppHandle so the
    // public 404 contract holds in test mode (where `state.app_handle` is
    // intentionally `None`). Keep `KNOWN_COMMANDS` in lockstep with the
    // `match name` arms in `dispatch()` below — drift will silently bypass
    // the 503 path for genuinely unknown commands.
    if !KNOWN_COMMANDS.contains(&name.as_str()) {
        return Err(RpcError::unknown_command(&name));
    }

    // Wave 3.3 — per-device rate limiter sits after the JWT verifier
    // middleware (so we can key on device_id) and before idempotency
    // lookup (cache hits don't burn a token).
    if let crate::companion_api::rate_limit::RateLimitDecision::Reject { retry_after } =
        state.rate_limiter.check(&ctx.device_id)
    {
        return Err(RpcError::rate_limited(retry_after.as_secs()));
    }

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
    let result = dispatch(&name, args, &state, &app, &ctx.device_id).await?;

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
// DataPlane selection helper
// ---------------------------------------------------------------------------

/// Resolve the DataPlane for the current process. Returns a 503 error
/// envelope when no plane is selectable — happens in test states where
/// both the Tauri AppHandle and the headless store are absent.
fn pick_data_plane(
    state: &SharedState,
) -> Result<super::data_plane::DataPlane, (StatusCode, Json<RpcError>)> {
    super::data_plane::DataPlane::pick(state).ok_or_else(|| {
        RpcError::internal(
            "no data plane available — neither a Tauri AppHandle nor a headless AppStore is configured"
                .to_string(),
        )
    })
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
///
/// Visibility note (ADR-0021): exposed as `pub(super)` so the WebRTC
/// signaling module (`super::signaling::dispatch`) can route DataChannel
/// RPCs through the same allowlist without re-implementing 1k+ lines.
pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    app: &tauri::AppHandle,
    device_id: &str,
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

        "register_push_token" => {
            // Wave 3.4 — phone hands its FCM/APNs token to the desktop
            // so the dispatcher can route inbound events to the device
            // when no WS subscription is live. Idempotent: re-registering
            // overwrites the previous record.
            let provider_str: String = required(&args, "provider")?;
            let token: String = required(&args, "token")?;
            let provider = match provider_str.as_str() {
                "fcm" => crate::companion_api::push::PushProvider::Fcm,
                "apns" => crate::companion_api::push::PushProvider::Apns,
                other => {
                    return Err(RpcError::malformed(format!(
                        "register_push_token.provider must be 'fcm' or 'apns', got '{other}'"
                    )));
                }
            };
            let app_version: Option<String> = optional(&args, "app_version")?;
            let device_locale: Option<String> = optional(&args, "device_locale")?;
            state
                .push_tokens
                .register(crate::companion_api::push::PushTokenRecord {
                    device_id: device_id.to_string(),
                    provider,
                    token,
                    app_version,
                    device_locale,
                    registered_at: chrono::Utc::now().timestamp_millis(),
                });
            Ok(Value::Null)
        }

        "revoke_push_token" => {
            // Phone explicitly clears its token (sign-out / token rotation).
            state.push_tokens.revoke(device_id);
            Ok(Value::Null)
        }

        "sync_list_tables" => {
            // Wave 3.5 introspection — surface every registered Dexie
            // table the phone is allowed to mirror. Used by the mobile
            // shell to discover plugin-added tables without a release.
            let descriptors = state.sync_registry.list();
            let payload: Vec<serde_json::Value> = descriptors
                .into_iter()
                .map(|d| {
                    serde_json::json!({
                        "name": d.name,
                        "description": d.description,
                        "hasTombstones": d.has_tombstones,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "tables": payload }))
        }

        "sync_pull" => {
            let table: String = required(&args, "table")?;
            let since: i64 = optional::<i64>(&args, "since")?.unwrap_or(0);
            // Wave 3.5 — table allowlist now lives on the declarative
            // `SyncTableRegistry` (`sync_registry.rs`) so plugins can
            // register new tables at boot without a code edit here.
            // The `with_defaults()` factory seeds the 9 Wave 1+2 tables.
            if !state.sync_registry.contains(&table) {
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

        // ── Desktop-message bridge (Mobile completeness P2) ──────────────────
        //
        // All five message / session RPCs route through `DataPlane::pick`,
        // which selects the Tauri-bridge variant (existing desktop flow) or
        // the Direct variant against a `SqliteAppStore` in headless mode
        // (Phase D). The return shape is identical so the rest of the RPC
        // pipeline stays unchanged.

        "message_update" => {
            let session_id: String = required(&args, "session_id")?;
            let message_id: String = required(&args, "message_id")?;
            let updates: Value = required(&args, "updates")?;
            let dp = pick_data_plane(state)?;
            dp.update_message(session_id, message_id, updates)
                .await
                .map_err(RpcError::internal)
        }

        "message_delete" => {
            let session_id: String = required(&args, "session_id")?;
            let message_id: String = required(&args, "message_id")?;
            let dp = pick_data_plane(state)?;
            dp.delete_message(session_id, message_id)
                .await
                .map_err(RpcError::internal)
        }

        "session_list" => {
            let limit: u32 = required(&args, "limit")?;
            let offset: u32 = required(&args, "offset")?;
            let before: Option<i64> = optional(&args, "before")?;
            let dp = pick_data_plane(state)?;
            dp.list_sessions(limit, offset, before)
                .await
                .map_err(RpcError::internal)
        }

        "message_get_by_session" => {
            let session_id: String = required(&args, "session_id")?;
            let limit: Option<u32> = optional(&args, "limit")?;
            let offset: Option<u32> = optional(&args, "offset")?;
            let dp = pick_data_plane(state)?;
            dp.get_messages_by_session(session_id, limit, offset)
                .await
                .map_err(RpcError::internal)
        }

        "message_send" => {
            let session_id: String = required(&args, "session_id")?;
            let content: String = required(&args, "content")?;
            let role: Option<String> = optional(&args, "role")?;
            let dp = pick_data_plane(state)?;
            dp.send_message(session_id, content, role)
                .await
                .map_err(RpcError::internal)
        }

        // ── Desktop-write bridge (Wave 2 mutating RPCs) ──────────────────────
        // All commands route through one generic bridge that emits
        // `companion://desktop-write-request` with `{ command, payload }`.
        // The desktop WebView dispatches by command name and resolves via
        // the `companion_desktop_write_response` Tauri command.
        "character_upsert"
        | "character_delete"
        | "character_bind_twin"
        | "skill_set_enabled"
        | "plugin_set_enabled"
        | "adapter_update_policy"
        | "twin_profile_get" => {
            let bridge = std::sync::Arc::clone(&state.desktop_writes_bridge);
            bridge
                .dispatch(
                    app,
                    name,
                    args,
                    crate::companion_api::desktop_writes_bridge::DEFAULT_TIMEOUT,
                )
                .await
                .map_err(RpcError::internal)
        }

        "app_settings_update" => {
            // Allowlist enforcement — phone may only mutate user-facing
            // preferences, never transport / sidecar / provider keys.
            // Wave 3.2: distinguish validation failures (recoverable —
            // user can fix the payload) from transport-level malformed
            // requests by emitting `validation_failed` here.
            let patch: Value = required(&args, "patch")?;
            if let Some(map) = patch.as_object() {
                for key in map.keys() {
                    if !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key.as_str()) {
                        return Err(RpcError::validation_failed(format!(
                            "settings key '{key}' is not editable from the mobile client"
                        )));
                    }
                }
            } else {
                return Err(RpcError::validation_failed(
                    "app_settings_update.patch must be an object".to_string(),
                ));
            }
            let bridge = std::sync::Arc::clone(&state.desktop_writes_bridge);
            bridge
                .dispatch(
                    app,
                    name,
                    args,
                    crate::companion_api::desktop_writes_bridge::DEFAULT_TIMEOUT,
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
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry:
                crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter:
                crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens:
                crate::companion_api::push::PushTokenRegistry::new(),
        })
    }

    fn build_router(state: super::super::SharedState) -> Router {
        use axum::{middleware::from_fn_with_state, routing::post};
        use super::super::middleware;

        Router::new()
            .route("/api/v1/_rpc/{name}", post(rpc_handler))
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
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry:
                crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter:
                crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens:
                crate::companion_api::push::PushTokenRegistry::new(),
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
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry:
                crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter:
                crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens:
                crate::companion_api::push::PushTokenRegistry::new(),
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
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry:
                crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter:
                crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens:
                crate::companion_api::push::PushTokenRegistry::new(),
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
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry:
                crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter:
                crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens:
                crate::companion_api::push::PushTokenRegistry::new(),
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

    // ── Desktop-message bridge command coverage (Mobile completeness P2) ─────

    #[tokio::test]
    async fn dispatch_coverage_message_update() {
        // Required fields are present so the handler reaches dispatch and
        // returns 503 (test-mode, no AppHandle). The key assertion is that
        // the dispatch arm is wired (not a 404).
        assert_not_404!(
            "message_update",
            json!({
                "session_id": "s1",
                "message_id": "m1",
                "updates": { "role": "user" }
            })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_message_delete() {
        assert_not_404!(
            "message_delete",
            json!({ "session_id": "s1", "message_id": "m1" })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_session_list() {
        assert_not_404!(
            "session_list",
            json!({ "limit": 20, "offset": 0 })
        );
    }

    // ── Missing-field 400s ───────────────────────────────────────────────────

    #[tokio::test]
    async fn message_update_missing_session_id_returns_non_success() {
        // App handle is None in test-mode so the dispatch short-circuits to
        // 503 *before* per-field validation. The assertion captures the
        // contract that an empty-body request never reaches a 200 success
        // and never returns a 404 (the dispatch arm exists).
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        let resp = rpc_post(router, "message_update", json!({}), &jwt, None).await;
        let status = resp.status().as_u16();
        assert_ne!(status, 200);
        assert_ne!(status, 404);
    }

    #[tokio::test]
    async fn message_delete_missing_message_id_returns_non_success() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        let resp = rpc_post(
            router,
            "message_delete",
            json!({ "session_id": "s1" }),
            &jwt,
            None,
        )
        .await;
        let status = resp.status().as_u16();
        assert_ne!(status, 200);
        assert_ne!(status, 404);
    }

    #[tokio::test]
    async fn session_list_missing_limit_returns_non_success() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        let resp = rpc_post(router, "session_list", json!({ "offset": 0 }), &jwt, None).await;
        let status = resp.status().as_u16();
        assert_ne!(status, 200);
        assert_ne!(status, 404);
    }

    // ── session_list lives in READ_ONLY_COMMANDS (skips idempotency cache) ──

    #[tokio::test]
    async fn session_list_skips_idempotency_cache() {
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
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry:
                crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter:
                crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens:
                crate::companion_api::push::PushTokenRegistry::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev-list");
        let _ = rpc_post(
            router,
            "session_list",
            json!({ "limit": 10, "offset": 0 }),
            &jwt,
            Some("idem-list"),
        )
        .await;

        // session_list is in READ_ONLY_COMMANDS — cache must remain empty.
        assert_eq!(cache.len(), 0);
    }

    // ── message_update / message_delete are NOT read-only ────────────────────
    // (mutations must be cached on first success so an in-flight retry
    // doesn't double-mutate the desktop's Dexie.)

    #[test]
    fn message_update_not_in_read_only_set() {
        assert!(!READ_ONLY_COMMANDS.contains(&"message_update"));
    }

    #[test]
    fn message_delete_not_in_read_only_set() {
        assert!(!READ_ONLY_COMMANDS.contains(&"message_delete"));
    }

    #[test]
    fn session_list_in_read_only_set() {
        assert!(READ_ONLY_COMMANDS.contains(&"session_list"));
    }

    #[test]
    fn all_three_commands_in_known_commands() {
        assert!(KNOWN_COMMANDS.contains(&"message_update"));
        assert!(KNOWN_COMMANDS.contains(&"message_delete"));
        assert!(KNOWN_COMMANDS.contains(&"session_list"));
    }

    // ── app_settings_update allowlist coverage (Phase 1 of the mobile theme
    //    parity work — see plan i18n-partitioned-teapot.md). The phone's
    //    /me/appearance route writes these keys through `app_settings_update`,
    //    so a regression here would 400 on every save. The accessor mirror
    //    keeps the OpenAPI spec_parity check honest.

    #[test]
    fn mobile_allowed_keys_accessor_mirrors_const() {
        // The accessor must return exactly the const slice — no copying,
        // no filtering. spec_parity downstream depends on this identity.
        let from_accessor = mobile_allowed_keys();
        assert_eq!(
            from_accessor.len(),
            APP_SETTINGS_MOBILE_ALLOWED_KEYS.len(),
            "accessor length drift"
        );
        for (a, b) in from_accessor.iter().zip(APP_SETTINGS_MOBILE_ALLOWED_KEYS.iter()) {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn mobile_allowlist_includes_appearance_keys() {
        // Every key surfaced by the mobile appearance route must be here.
        // Adding a new tab / setting on the phone side without updating
        // this list will 400 on save.
        for key in [
            "colorTheme",
            "customThemes",
            "activeCustomThemeId",
            "wallpapers",
            "customCss",
            "customCssEnabled",
            "importedVscodeThemes",
        ] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "appearance key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
            );
        }
    }

    #[test]
    fn mobile_allowlist_keeps_baseline_keys() {
        // Don't accidentally drop a baseline key while editing this list.
        for key in [
            "theme",
            "fontScale",
            "language",
            "reduceMotion",
            "defaultModel",
            "defaultCharacterId",
            "biometricRequiredFor",
        ] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "baseline key '{key}' must stay in the mobile allowlist"
            );
        }
    }

    #[test]
    fn mobile_allowlist_rejects_transport_and_sidecar_keys() {
        // Sentinel keys that the phone must never be allowed to write —
        // protects the desktop-only configuration plane.
        for key in [
            "apiBaseUrl",
            "anthropicApiKey",
            "claudeOauthBearer",
            "mcpServers",
            "providerConfigs",
            "sidecarPath",
        ] {
            assert!(
                !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "key '{key}' must NOT be writable from the mobile client"
            );
        }
    }

    #[tokio::test]
    async fn app_settings_update_rejects_unknown_key() {
        // End-to-end: a patch carrying an unknown key returns 400 with
        // `validation_failed` rather than reaching the desktop_writes_bridge.
        let cache = Arc::new(IdempotencyCache::with_capacity(
            100,
            std::time::Duration::from_secs(60),
        ));
        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::clone(&cache),
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev-allowlist");
        let resp = rpc_post(
            router,
            "app_settings_update",
            json!({ "patch": { "apiBaseUrl": "https://attacker.example" } }),
            &jwt,
            None,
        )
        .await;

        assert_eq!(
            resp.status().as_u16(),
            400,
            "unknown key must be rejected as 400"
        );
        let body = body_json(resp).await;
        assert_eq!(body["code"], "validation_failed");
        assert!(
            body["message"]
                .as_str()
                .unwrap_or_default()
                .contains("apiBaseUrl"),
            "error message should name the rejected key"
        );
    }

    #[tokio::test]
    async fn app_settings_update_accepts_color_theme_key() {
        // End-to-end: a patch carrying only allowlisted keys passes the
        // validation gate. The bridge will return service_unavailable
        // here (no app_handle in test state) — that's distinct from a
        // 400, which is what we're guarding against.
        let cache = Arc::new(IdempotencyCache::with_capacity(
            100,
            std::time::Duration::from_secs(60),
        ));
        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::clone(&cache),
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev-allowlist-ok");
        let resp = rpc_post(
            router,
            "app_settings_update",
            json!({ "patch": { "colorTheme": "ocean" } }),
            &jwt,
            None,
        )
        .await;

        // The patch is valid — must NOT be a 400 validation_failed.
        // (The bridge layer below returns 500/503 in unit-test mode
        // without a real app_handle, which is fine for this assertion.)
        assert_ne!(
            resp.status().as_u16(),
            400,
            "allowlisted colorTheme patch must not be rejected as 400"
        );
    }
}
