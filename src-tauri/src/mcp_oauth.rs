//! Keyring-backed OAuth storage and desktop commands for remote MCP servers.
//!
//! Headless attempt state, helper IPC, and callback routing live in focused
//! submodules so the desktop command facade does not own three runtimes.

mod headless;
mod headless_store;
mod helper;

pub use headless::{
    headless_authenticate, headless_callback_handler, headless_clear, headless_load_entry,
    headless_refresh, headless_status,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SERVICE: &str = "com.cognia.mcp-oauth/v1";

/// Persisted OAuth state for one server. Field names mirror the Node helper's
/// JSON (and the CLI `McpAuthEntry`) so stdin/stdout round trips are lossless.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct McpAuthEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Value>,
    #[serde(
        rename = "clientInformation",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub client_information: Option<Value>,
    #[serde(
        rename = "codeVerifier",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub code_verifier: Option<String>,
    #[serde(
        rename = "expiresAtMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at_ms: Option<i64>,
}

impl McpAuthEntry {
    pub fn access_token(&self) -> Option<String> {
        self.tokens
            .as_ref()
            .and_then(|tokens| tokens.get("access_token"))
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(str::to_string)
    }

    pub fn has_tokens(&self) -> bool {
        self.access_token().is_some()
    }
}

pub fn save(server_name: &str, entry: &McpAuthEntry) -> Result<(), String> {
    let blob =
        serde_json::to_string(entry).map_err(|error| format!("serialize failed: {error}"))?;
    crate::secret_store::set(SERVICE, server_name, &blob)
}

pub fn load(server_name: &str) -> Result<Option<McpAuthEntry>, String> {
    match crate::secret_store::get(SERVICE, server_name)? {
        Some(blob) => serde_json::from_str(&blob)
            .map(Some)
            .map_err(|error| format!("parse failed: {error}")),
        None => Ok(None),
    }
}

pub fn clear(server_name: &str) -> Result<(), String> {
    crate::secret_store::delete(SERVICE, server_name)
}

#[derive(Serialize)]
pub struct StatusOut {
    pub has_tokens: bool,
    pub expires_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
}

#[derive(Serialize)]
pub struct ProjectionOut {
    pub access_token: Option<String>,
    pub expires_at_ms: Option<i64>,
}

impl ProjectionOut {
    pub(super) fn from_entry(entry: &McpAuthEntry) -> Self {
        Self {
            access_token: entry.access_token(),
            expires_at_ms: entry.expires_at_ms,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AuthResultOut {
    pub ok: bool,
    pub status: String,
    pub message: String,
}

#[tauri::command]
pub async fn mcp_oauth_status(server_name: String) -> Result<StatusOut, String> {
    let entry = load(&server_name)?;
    Ok(match entry {
        Some(entry) => StatusOut {
            has_tokens: entry.has_tokens(),
            expires_at_ms: entry.expires_at_ms,
            status: None,
            attempt_id: None,
            authorization_url: None,
        },
        None => StatusOut {
            has_tokens: false,
            expires_at_ms: None,
            status: None,
            attempt_id: None,
            authorization_url: None,
        },
    })
}

#[tauri::command]
pub async fn mcp_oauth_load_entry(server_name: String) -> Result<Option<ProjectionOut>, String> {
    Ok(load(&server_name)?.map(|entry| ProjectionOut::from_entry(&entry)))
}

#[tauri::command]
pub async fn mcp_oauth_clear(server_name: String) -> Result<(), String> {
    clear(&server_name)
}

#[tauri::command]
pub async fn mcp_oauth_authenticate(
    server_name: String,
    server: Value,
    helper_path: String,
) -> Result<AuthResultOut, String> {
    run_helper(&server_name, &server, &helper_path, "authenticate")
        .await
        .map(|(result, _)| result)
}

#[tauri::command]
pub async fn mcp_oauth_refresh(
    server_name: String,
    server: Value,
    helper_path: String,
) -> Result<Option<ProjectionOut>, String> {
    let (_, entry) = run_helper(&server_name, &server, &helper_path, "refresh").await?;
    Ok(entry.map(|entry| ProjectionOut::from_entry(&entry)))
}

async fn run_helper(
    server_name: &str,
    server: &Value,
    helper_path: &str,
    mode: &str,
) -> Result<(AuthResultOut, Option<McpAuthEntry>), String> {
    let input = serde_json::json!({
        "serverName": server_name,
        "server": server,
        "entry": load(server_name)?.unwrap_or_default(),
    });
    let output = helper::run_helper_input(&input, helper_path, mode).await?;
    if let Some(entry) = &output.entry {
        save(server_name, entry)?;
    }
    Ok((output.result, output.entry))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry_with_token(token: &str) -> McpAuthEntry {
        McpAuthEntry {
            tokens: Some(serde_json::json!({ "access_token": token, "token_type": "Bearer" })),
            expires_at_ms: Some(1_800_000_000_000),
            ..Default::default()
        }
    }

    #[test]
    fn access_token_and_projection_track_usable_tokens() {
        assert_eq!(
            entry_with_token("abc").access_token(),
            Some("abc".to_string())
        );
        assert!(!entry_with_token("").has_tokens());
        let projection = ProjectionOut::from_entry(&entry_with_token("xyz"));
        assert_eq!(projection.access_token, Some("xyz".to_string()));
        assert_eq!(projection.expires_at_ms, Some(1_800_000_000_000));
    }

    #[test]
    fn entry_serde_round_trips_camel_case() {
        let entry = McpAuthEntry {
            tokens: Some(serde_json::json!({ "access_token": "t" })),
            client_information: Some(serde_json::json!({ "client_id": "c" })),
            code_verifier: Some("v".into()),
            expires_at_ms: Some(42),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("clientInformation"));
        assert!(json.contains("codeVerifier"));
        assert!(json.contains("expiresAtMs"));
        assert_eq!(serde_json::from_str::<McpAuthEntry>(&json).unwrap(), entry);
    }

    #[test]
    fn keyring_save_load_clear_round_trip() {
        let name = "__cognia_test_mcp_oauth__";
        let _ = clear(name);
        assert!(load(name).unwrap().is_none());
        save(name, &entry_with_token("round-trip")).unwrap();
        assert_eq!(
            load(name).unwrap().and_then(|entry| entry.access_token()),
            Some("round-trip".to_string())
        );
        clear(name).unwrap();
        assert!(load(name).unwrap().is_none());
        clear(name).unwrap();
    }
}
