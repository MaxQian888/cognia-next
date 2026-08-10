//! Headless MCP OAuth service and callback route.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::headless_store::{
    attempt_exists, cancel_owner, clear_entry, consume_state, current_attempt, ensure_inflight,
    expires_at_ms, insert_if_inflight, load_entry, new_state, owner_storage_lock, remove_attempt,
    save_entry, storage_key, HeadlessAttempt, HeadlessInflightGuard,
};
use super::{helper::run_helper_input, McpAuthEntry, ProjectionOut, StatusOut};

#[derive(Debug, Clone, Serialize)]
pub struct HeadlessAuthResultOut {
    pub ok: bool,
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
}

pub async fn headless_status(account_id: &str, server_name: &str) -> Result<StatusOut, String> {
    let entry = load_entry(storage_key(account_id, server_name)).await?;
    let attempt = current_attempt(account_id, server_name);
    Ok(StatusOut {
        has_tokens: entry.as_ref().is_some_and(McpAuthEntry::has_tokens),
        expires_at_ms: entry.and_then(|value| value.expires_at_ms),
        status: attempt.as_ref().map(|value| value.status.clone()),
        attempt_id: attempt.as_ref().map(|value| value.attempt_id.clone()),
        authorization_url: attempt.map(|value| value.authorization_url),
    })
}

pub async fn headless_load_entry(
    account_id: &str,
    server_name: &str,
) -> Result<Option<ProjectionOut>, String> {
    Ok(load_entry(storage_key(account_id, server_name))
        .await?
        .map(|entry| ProjectionOut::from_entry(&entry)))
}

pub async fn headless_clear(account_id: &str, server_name: &str) -> Result<(), String> {
    let key = storage_key(account_id, server_name);
    cancel_owner(account_id, server_name);
    let _storage_guard = owner_storage_lock(account_id, server_name).lock().await;
    clear_entry(key).await
}

pub async fn headless_authenticate(
    account_id: &str,
    server_name: &str,
    server: Value,
) -> Result<HeadlessAuthResultOut, String> {
    let helper_path = headless_helper_path()?;
    let redirect_url = headless_redirect_url()?;
    let attempt_id = uuid::Uuid::new_v4().to_string();
    let inflight = HeadlessInflightGuard::begin(account_id, server_name)?;
    let state = new_state();
    let expiry = expires_at_ms();
    let key = storage_key(account_id, server_name);
    let input = serde_json::json!({
        "serverName": server_name,
        "server": server,
        "entry": load_entry(key.clone()).await?.unwrap_or_default(),
        "redirectUrl": redirect_url,
        "state": state,
    });
    let output = run_helper_input(&input, &helper_path, "headless-prepare").await?;
    if output.result.status == "authorized" {
        let _storage_guard = owner_storage_lock(account_id, server_name).lock().await;
        ensure_inflight(account_id, server_name, &inflight.token)?;
        if let Some(entry) = output.entry {
            save_entry(key.clone(), entry).await?;
            if ensure_inflight(account_id, server_name, &inflight.token).is_err() {
                clear_entry(key).await?;
                return Err("OAuth attempt was cleared".to_string());
            }
        }
        return Ok(HeadlessAuthResultOut {
            ok: output.result.ok,
            status: output.result.status,
            message: output.result.message,
            attempt_id: None,
            authorization_url: None,
            expires_at_ms: None,
        });
    }
    if output.result.status != "pending" || !output.result.ok {
        return Ok(HeadlessAuthResultOut {
            ok: output.result.ok,
            status: output.result.status,
            message: output.result.message,
            attempt_id: None,
            authorization_url: None,
            expires_at_ms: None,
        });
    }

    let authorization_url = output
        .authorization_url
        .ok_or_else(|| "oauth helper returned no authorization URL".to_string())?;
    let entry = output.entry.unwrap_or_default();
    let _storage_guard = owner_storage_lock(account_id, server_name).lock().await;
    ensure_inflight(account_id, server_name, &inflight.token)?;
    save_entry(key.clone(), entry).await?;
    if ensure_inflight(account_id, server_name, &inflight.token).is_err() {
        clear_entry(key.clone()).await?;
        return Err("OAuth attempt was cleared".to_string());
    }
    insert_if_inflight(
        account_id,
        server_name,
        &inflight.token,
        HeadlessAttempt::pending(
            attempt_id.clone(),
            account_id.to_string(),
            server_name.to_string(),
            key,
            server,
            state,
            redirect_url,
            authorization_url.clone(),
            expiry,
        ),
    )?;
    Ok(HeadlessAuthResultOut {
        ok: true,
        status: "pending".to_string(),
        message: "authorization required".to_string(),
        attempt_id: Some(attempt_id),
        authorization_url: Some(authorization_url),
        expires_at_ms: Some(expiry),
    })
}

pub async fn headless_refresh(
    account_id: &str,
    server_name: &str,
    server: Value,
) -> Result<Option<ProjectionOut>, String> {
    let helper_path = headless_helper_path()?;
    let key = storage_key(account_id, server_name);
    let inflight = HeadlessInflightGuard::begin(account_id, server_name)?;
    let input = serde_json::json!({
        "serverName": server_name,
        "server": server,
        "entry": load_entry(key.clone()).await?.unwrap_or_default(),
    });
    let output = run_helper_input(&input, &helper_path, "refresh").await?;
    let _storage_guard = owner_storage_lock(account_id, server_name).lock().await;
    if ensure_inflight(account_id, server_name, &inflight.token).is_err() {
        return Err("OAuth refresh was cleared".to_string());
    }
    if let Some(entry) = output.entry {
        save_entry(key.clone(), entry.clone()).await?;
        if ensure_inflight(account_id, server_name, &inflight.token).is_err() {
            clear_entry(key).await?;
            return Err("OAuth refresh was cleared".to_string());
        }
        Ok(Some(ProjectionOut::from_entry(&entry)))
    } else {
        Ok(None)
    }
}

#[derive(Deserialize)]
pub struct HeadlessCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub async fn headless_callback_handler(
    State(state): State<crate::companion_api::SharedState>,
    Query(query): Query<HeadlessCallbackQuery>,
) -> Response {
    if std::env::var("COGNIA_MCP_OAUTH_CALLBACK_ENABLED")
        .is_ok_and(|value| value.eq_ignore_ascii_case("false"))
    {
        return callback_page(StatusCode::NOT_FOUND, "OAuth callback is disabled");
    }
    let Some(callback_state) = query.state.as_deref() else {
        return callback_page(StatusCode::BAD_REQUEST, "Invalid or expired OAuth state");
    };
    let Some(attempt) = consume_state(callback_state) else {
        return callback_page(StatusCode::BAD_REQUEST, "Invalid or expired OAuth state");
    };
    if let Some(error) = query.error {
        remove_attempt(&attempt.attempt_id);
        state.event_bus.publish(
            "mcp://oauth/login-completed".to_string(),
            serde_json::json!({
                "accountId": attempt.account_id,
                "serverName": attempt.server_name,
                "attemptId": attempt.attempt_id,
                "status": "denied",
                "error": error,
            }),
        );
        return callback_page(
            StatusCode::BAD_REQUEST,
            query
                .error_description
                .as_deref()
                .unwrap_or("Authorization denied"),
        );
    }
    let Some(code) = query
        .code
        .filter(|value| !value.is_empty() && value.len() <= 8192)
    else {
        remove_attempt(&attempt.attempt_id);
        return callback_page(StatusCode::BAD_REQUEST, "Missing authorization code");
    };
    let helper_path = match headless_helper_path() {
        Ok(path) => path,
        Err(_) => {
            remove_attempt(&attempt.attempt_id);
            return callback_page(
                StatusCode::INTERNAL_SERVER_ERROR,
                "OAuth helper is unavailable",
            );
        }
    };
    let stored_entry = match load_entry(attempt.storage_key.clone()).await {
        Ok(entry) => entry.unwrap_or_default(),
        Err(_) => {
            remove_attempt(&attempt.attempt_id);
            return callback_page(StatusCode::INTERNAL_SERVER_ERROR, "Token storage failed");
        }
    };
    let input = serde_json::json!({
        "serverName": attempt.server_name,
        "server": attempt.server,
        "entry": stored_entry,
        "redirectUrl": attempt.redirect_url,
        "state": attempt.state,
        "code": code,
    });
    let output = run_helper_input(&input, &helper_path, "headless-complete").await;
    let _storage_guard = owner_storage_lock(&attempt.account_id, &attempt.server_name)
        .lock()
        .await;
    if !attempt_exists(&attempt.attempt_id) {
        return callback_page(StatusCode::CONFLICT, "OAuth attempt was cleared");
    }
    let response = match output {
        Ok(output) if output.result.ok && output.result.status == "authorized" => {
            if let Some(entry) = output.entry {
                if save_entry(attempt.storage_key.clone(), entry)
                    .await
                    .is_err()
                {
                    callback_page(StatusCode::INTERNAL_SERVER_ERROR, "Token storage failed")
                } else if !attempt_exists(&attempt.attempt_id) {
                    let _ = clear_entry(attempt.storage_key.clone()).await;
                    callback_page(StatusCode::CONFLICT, "OAuth attempt was cleared")
                } else {
                    state.event_bus.publish(
                        "mcp://oauth/login-completed".to_string(),
                        serde_json::json!({
                            "accountId": attempt.account_id,
                            "serverName": attempt.server_name,
                            "attemptId": attempt.attempt_id,
                            "status": "authorized",
                        }),
                    );
                    callback_page(
                        StatusCode::OK,
                        "Authorization complete. You can close this tab.",
                    )
                }
            } else {
                callback_page(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "OAuth helper returned no token state",
                )
            }
        }
        Ok(output) => callback_page(StatusCode::BAD_GATEWAY, &output.result.message),
        Err(_) => callback_page(StatusCode::BAD_GATEWAY, "Token exchange failed"),
    };
    remove_attempt(&attempt.attempt_id);
    response
}

fn callback_page(status: StatusCode, message: &str) -> Response {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    (
        status,
        Html(format!(
            "<!doctype html><meta charset=\"utf-8\"><title>Cognia MCP OAuth</title><p>{escaped}</p>"
        )),
    )
        .into_response()
}

fn headless_helper_path() -> Result<String, String> {
    let path = crate::headless::resolve_mcp_sidecar_path().with_file_name("mcp-oauth-helper.mjs");
    if !path.is_file() {
        return Err("packaged MCP OAuth helper is unavailable".to_string());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn headless_redirect_url() -> Result<String, String> {
    let raw = std::env::var("COGNIA_PUBLIC_URL")
        .map_err(|_| "COGNIA_PUBLIC_URL is required for Headless MCP OAuth".to_string())?;
    let mut url = url::Url::parse(&raw).map_err(|_| "COGNIA_PUBLIC_URL is invalid".to_string())?;
    let local_debug = std::env::var_os("COGNIA_LOCAL_DEBUG_TOKEN").is_some();
    if url.scheme() != "https"
        && !(local_debug
            && url.scheme() == "http"
            && url
                .host_str()
                .is_some_and(|host| host == "127.0.0.1" || host == "localhost"))
    {
        return Err("COGNIA_PUBLIC_URL must use HTTPS for MCP OAuth".to_string());
    }
    url.set_path("/integrations/mcp/oauth/callback");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn callback_pages_escape_provider_control_characters() {
        let response = callback_page(StatusCode::BAD_REQUEST, "<denied & unsafe>");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.contains("&lt;denied &amp; unsafe&gt;"));
        assert!(!text.contains("<denied & unsafe>"));
    }
}
