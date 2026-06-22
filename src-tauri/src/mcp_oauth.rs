//! Keyring-backed OAuth storage for remote (sse/http) MCP servers, plus the
//! commands that drive the interactive authorization flow.
//!
//! One keyring entry per MCP server NAME:
//!   service = "com.cognia.mcp-oauth/v1"
//!   account = "<server name>"
//!   payload = JSON `McpAuthEntry` (tokens / clientInformation / codeVerifier
//!             / expiresAtMs), mirroring the CLI's `mcp-auth.json` shape.
//!
//! The renderer never touches `node:fs` or loopback servers (static export
//! forbids it): it calls these commands, the keyring is the single source of
//! truth, and the interactive flow runs in a short-lived Node helper spawned
//! here. `build-options.ts` injects the access token as an `Authorization`
//! header at send time (the Agent SDK exposes no `authProvider` hook).

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SERVICE: &str = "com.cognia.mcp-oauth/v1";

/// Persisted OAuth state for one server. Field names mirror the Node helper's
/// JSON (and the CLI `McpAuthEntry`) so the round-trip through stdin/stdout is
/// lossless.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct McpAuthEntry {
    /// OAuth tokens object as returned by the SDK (`access_token`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Value>,
    /// Dynamically-registered client info (client_id/secret), if any.
    #[serde(
        rename = "clientInformation",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub client_information: Option<Value>,
    /// In-flight PKCE code verifier (cleared once tokens are saved).
    #[serde(
        rename = "codeVerifier",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub code_verifier: Option<String>,
    /// Absolute access-token expiry (epoch ms), when known.
    #[serde(
        rename = "expiresAtMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at_ms: Option<i64>,
}

impl McpAuthEntry {
    /// The access token, if a non-empty one is stored.
    pub fn access_token(&self) -> Option<String> {
        self.tokens
            .as_ref()
            .and_then(|t| t.get("access_token"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    /// Whether usable tokens are present.
    pub fn has_tokens(&self) -> bool {
        self.access_token().is_some()
    }
}

// ---------------------------------------------------------------------------
// Keyring I/O
// ---------------------------------------------------------------------------

fn entry_for(server_name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, server_name).map_err(|e| format!("keyring init failed: {e}"))
}

pub fn save(server_name: &str, entry: &McpAuthEntry) -> Result<(), String> {
    let blob = serde_json::to_string(entry).map_err(|e| format!("serialize failed: {e}"))?;
    entry_for(server_name)?
        .set_password(&blob)
        .map_err(|e| format!("keyring write failed: {e}"))
}

pub fn load(server_name: &str) -> Result<Option<McpAuthEntry>, String> {
    match entry_for(server_name)?.get_password() {
        Ok(blob) => {
            let parsed: McpAuthEntry =
                serde_json::from_str(&blob).map_err(|e| format!("parse failed: {e}"))?;
            Ok(Some(parsed))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

pub fn clear(server_name: &str) -> Result<(), String> {
    match entry_for(server_name)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete failed: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Command output shapes (snake_case — the renderer wrappers read these keys)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct StatusOut {
    pub has_tokens: bool,
    pub expires_at_ms: Option<i64>,
}

#[derive(Serialize)]
pub struct ProjectionOut {
    pub access_token: Option<String>,
    pub expires_at_ms: Option<i64>,
}

impl ProjectionOut {
    fn from_entry(e: &McpAuthEntry) -> Self {
        Self {
            access_token: e.access_token(),
            expires_at_ms: e.expires_at_ms,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct AuthResultOut {
    pub ok: bool,
    pub status: String,
    pub message: String,
}

/// The Node helper's stdout payload: the structured result + the final entry.
#[derive(Deserialize)]
struct HelperOutput {
    result: AuthResultOut,
    #[serde(default)]
    entry: Option<McpAuthEntry>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mcp_oauth_status(server_name: String) -> Result<StatusOut, String> {
    let entry = load(&server_name)?;
    Ok(match entry {
        Some(e) => StatusOut {
            has_tokens: e.has_tokens(),
            expires_at_ms: e.expires_at_ms,
        },
        None => StatusOut {
            has_tokens: false,
            expires_at_ms: None,
        },
    })
}

#[tauri::command]
pub async fn mcp_oauth_load_entry(server_name: String) -> Result<Option<ProjectionOut>, String> {
    Ok(load(&server_name)?.map(|e| ProjectionOut::from_entry(&e)))
}

#[tauri::command]
pub async fn mcp_oauth_clear(server_name: String) -> Result<(), String> {
    clear(&server_name)
}

/// Run the interactive authorization-code flow via the Node helper, persisting
/// the resulting tokens to the keyring. `server` is the `{ transport, config }`
/// descriptor; `helper_path` is the bundled `mcp-oauth-helper.mjs`.
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

/// Headless refresh using the stored refresh token. Returns the refreshed
/// projection (or `None` when no usable token resulted).
#[tauri::command]
pub async fn mcp_oauth_refresh(
    server_name: String,
    server: Value,
    helper_path: String,
) -> Result<Option<ProjectionOut>, String> {
    let (_result, entry) = run_helper(&server_name, &server, &helper_path, "refresh").await?;
    Ok(entry.map(|e| ProjectionOut::from_entry(&e)))
}

/// Spawn `node <helper> <mode>`, feed `{ server, entry }` on stdin, read one
/// `{ result, entry }` JSON line from stdout, persist the entry, and return
/// both. Never panics — every failure becomes an `error` result.
async fn run_helper(
    server_name: &str,
    server: &Value,
    helper_path: &str,
    mode: &str,
) -> Result<(AuthResultOut, Option<McpAuthEntry>), String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::Command;

    let existing = load(server_name)?.unwrap_or_default();
    let input = serde_json::json!({
        "serverName": server_name,
        "server": server,
        "entry": existing,
    });

    let mut child = Command::new("node")
        .arg(helper_path)
        .arg(mode)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn oauth helper failed: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let line = format!("{input}\n");
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write to helper failed: {e}"))?;
        stdin.flush().await.ok();
        drop(stdin);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "helper stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);

    // The helper prints exactly one JSON result line (it may print `{open:url}`
    // browser-hint lines first, which we skip).
    let mut last_json: Option<HelperOutput> = None;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(parsed) = serde_json::from_str::<HelperOutput>(trimmed) {
                    last_json = Some(parsed);
                }
            }
            Err(e) => return Err(format!("read from helper failed: {e}")),
        }
    }
    let _ = child.wait().await;

    let Some(out) = last_json else {
        return Ok((
            AuthResultOut {
                ok: false,
                status: "error".into(),
                message: "oauth helper produced no result".into(),
            },
            None,
        ));
    };

    if let Some(entry) = &out.entry {
        // Persist whatever the helper produced (tokens on success; the seeded
        // entry otherwise) so a partial PKCE state survives a retry.
        save(server_name, entry)?;
    }
    Ok((out.result, out.entry))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    fn entry_with_token(tok: &str) -> McpAuthEntry {
        McpAuthEntry {
            tokens: Some(serde_json::json!({ "access_token": tok, "token_type": "Bearer" })),
            expires_at_ms: Some(1_800_000_000_000),
            ..Default::default()
        }
    }

    #[test]
    fn access_token_extracts_non_empty_token() {
        assert_eq!(
            entry_with_token("abc").access_token(),
            Some("abc".to_string())
        );
        assert!(entry_with_token("").access_token().is_none());
        assert!(McpAuthEntry::default().access_token().is_none());
    }

    #[test]
    fn has_tokens_tracks_presence() {
        assert!(entry_with_token("abc").has_tokens());
        assert!(!McpAuthEntry::default().has_tokens());
    }

    #[test]
    fn projection_carries_token_and_expiry() {
        let p = ProjectionOut::from_entry(&entry_with_token("xyz"));
        assert_eq!(p.access_token, Some("xyz".to_string()));
        assert_eq!(p.expires_at_ms, Some(1_800_000_000_000));
    }

    #[test]
    fn entry_serde_round_trips_camel_case() {
        let e = McpAuthEntry {
            tokens: Some(serde_json::json!({ "access_token": "t" })),
            client_information: Some(serde_json::json!({ "client_id": "c" })),
            code_verifier: Some("v".into()),
            expires_at_ms: Some(42),
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("clientInformation"));
        assert!(json.contains("codeVerifier"));
        assert!(json.contains("expiresAtMs"));
        let back: McpAuthEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn helper_output_parses_result_and_entry() {
        let out: HelperOutput = serde_json::from_str(
            r#"{"result":{"ok":true,"status":"authorized","message":"ok"},"entry":{"tokens":{"access_token":"z"}}}"#,
        )
        .unwrap();
        assert!(out.result.ok);
        assert_eq!(out.entry.unwrap().access_token(), Some("z".to_string()));
    }

    // ── Keyring round-trip (opt-in: COGNIA_TEST_KEYRING=1) ────────────────────

    #[test]
    fn keyring_save_load_clear_round_trip() {
        if !keyring_available() {
            return;
        }
        let name = "__cognia_test_mcp_oauth__";
        let _ = clear(name);
        assert!(load(name).unwrap().is_none());

        let e = entry_with_token("round-trip");
        save(name, &e).unwrap();
        let loaded = load(name).unwrap().expect("entry present");
        assert_eq!(loaded.access_token(), Some("round-trip".to_string()));

        clear(name).unwrap();
        assert!(load(name).unwrap().is_none());
        // clear is idempotent
        clear(name).unwrap();
    }
}
