// Tauri commands the frontend uses to read CCSwitch's database.
//
//   ccswitch_status()              -> { dbPath, exists, counts }
//   ccswitch_list_providers()      -> [CcswitchProvider]
//   ccswitch_list_mcp_servers()    -> [CcswitchMcpServer]
//   ccswitch_list_prompts()        -> [CcswitchPrompt]
//   ccswitch_list_skills()         -> [CcswitchSkill]
//
// `status` always returns successfully — it's the probe used by the UI to
// decide whether to render the rest of the section. The list commands fail
// only if the database exists but cannot be opened (corruption, permissions).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::fs_atomic::{self, AtomicWriteError, AtomicWritePlan, DRIFT_DETECTED_TAG};

use super::db::{
    counts, list_mcp_servers as db_list_mcp_servers, list_prompts as db_list_prompts,
    list_providers as db_list_providers, list_skills as db_list_skills, open_readonly,
    CcswitchCounts, CcswitchError, CcswitchMcpServer, CcswitchPrompt, CcswitchProvider,
    CcswitchSkill,
};
use super::paths::{ccswitch_db_path, resolve_ccswitch_db, CcswitchResolutionSource};

#[derive(Debug, Serialize, Deserialize)]
pub struct CcswitchStatus {
    /// Resolved DB path on this OS, or null when the home dir can't be found.
    #[serde(rename = "dbPath")]
    pub db_path: Option<String>,
    pub exists: bool,
    /// Counts per known table. Zero when the DB doesn't exist.
    pub counts: CcswitchCounts,
    /// Filled in if the file was present but couldn't be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Where the dbPath was resolved from. `"env"` = `CC_SWITCH_HOME` override
    /// (mostly for tests), `"redirect"` = cc-switch's own `app_paths.json`
    /// pointed somewhere else, `"default"` = `~/.cc-switch/`.
    #[serde(rename = "resolutionSource", skip_serializing_if = "Option::is_none")]
    pub resolution_source: Option<CcswitchResolutionSource>,
}

#[tauri::command]
pub fn ccswitch_status() -> CcswitchStatus {
    let Some(resolved) = resolve_ccswitch_db() else {
        return CcswitchStatus {
            db_path: None,
            exists: false,
            counts: CcswitchCounts::default(),
            error: None,
            resolution_source: None,
        };
    };
    let db_path = Some(resolved.path.to_string_lossy().into_owned());
    if !resolved.path.exists() {
        return CcswitchStatus {
            db_path,
            exists: false,
            counts: CcswitchCounts::default(),
            error: None,
            resolution_source: Some(resolved.source),
        };
    }
    match open_readonly(&resolved.path).and_then(|c| counts(&c)) {
        Ok(counts) => CcswitchStatus {
            db_path,
            exists: true,
            counts,
            error: None,
            resolution_source: Some(resolved.source),
        },
        Err(err) => CcswitchStatus {
            db_path,
            exists: true,
            counts: CcswitchCounts::default(),
            error: Some(format_err(err)),
            resolution_source: Some(resolved.source),
        },
    }
}

#[tauri::command]
pub fn ccswitch_list_providers() -> Result<Vec<CcswitchProvider>, String> {
    with_conn(|c| db_list_providers(c))
}

#[tauri::command]
pub fn ccswitch_list_mcp_servers() -> Result<Vec<CcswitchMcpServer>, String> {
    with_conn(|c| db_list_mcp_servers(c))
}

#[tauri::command]
pub fn ccswitch_list_prompts() -> Result<Vec<CcswitchPrompt>, String> {
    with_conn(|c| db_list_prompts(c))
}

#[tauri::command]
pub fn ccswitch_list_skills() -> Result<Vec<CcswitchSkill>, String> {
    with_conn(|c| db_list_skills(c))
}

fn with_conn<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&rusqlite::Connection) -> Result<T, CcswitchError>,
    T: Default,
{
    let Some(path) = ccswitch_db_path() else {
        return Err("could not resolve home directory".to_string());
    };
    if !path.exists() {
        // The DB hasn't been created yet — return the type's default rather
        // than an error so the UI can render an empty list cleanly. This
        // mirrors the agent commands' "missing file" semantics in agents/io.rs.
        return Ok(T::default());
    }
    let conn = open_readonly(&path).map_err(format_err)?;
    f(&conn).map_err(format_err)
}

fn format_err(err: CcswitchError) -> String {
    err.to_string()
}

/// Outcome echoed back to the renderer after a successful Codex auth write.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthWriteResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

/// Patch the top-level `OPENAI_API_KEY` + `auth_mode` fields of
/// `~/.codex/auth.json`. Mirrors `write_claude_settings_env` but targets
/// codex-cli's auth file shape.
///
/// Semantics:
///   - `env_updates["OPENAI_API_KEY"] = Some(v)` (non-empty)
///       → set `OPENAI_API_KEY = v`, set `auth_mode = "ApiKey"`
///   - `env_updates["OPENAI_API_KEY"] = None` or empty
///       → remove `OPENAI_API_KEY`. If the file still has a `tokens` object,
///         flip `auth_mode` back to `"ChatGPT"`; otherwise clear `auth_mode`.
///   - Any other keys are passed through as top-level JSON string fields
///     (codex-cli ignores unknown top-level keys, so they're harmless and
///     useful for forward compatibility).
///
/// `tokens`, `last_refresh`, `agent_identity`, and unknown top-level keys
/// are preserved verbatim. Atomic write with mtime drift detection — the
/// special error string `"drift_detected"` is returned when codex-cli (or
/// another writer) touched the file between read and write.
#[tauri::command]
pub fn write_codex_auth_env(
    env_updates: HashMap<String, Option<String>>,
) -> Result<CodexAuthWriteResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dir = home.join(".codex");
    let path = dir.join("auth.json");

    // The agent must already be installed — we don't auto-create the
    // `.codex` directory because that would silently materialise an auth
    // file for users who never set up codex-cli.
    if !dir.exists() {
        return Err(format!(
            "Codex CLI is not installed (missing {}). Install codex first.",
            dir.display()
        ));
    }

    let (bytes, mtime) = fs_atomic::read_with_mtime(&path)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;

    let mut root: serde_json::Map<String, serde_json::Value> = if bytes.is_empty() {
        serde_json::Map::new()
    } else {
        let raw = std::str::from_utf8(&bytes)
            .map_err(|e| format!("read {}: {}", path.display(), e))?;
        if raw.trim().is_empty() {
            serde_json::Map::new()
        } else {
            match serde_json::from_str::<serde_json::Value>(raw) {
                Ok(serde_json::Value::Object(m)) => m,
                Ok(_) => {
                    return Err(format!(
                        "{} is not a JSON object — refusing to overwrite",
                        path.display()
                    ))
                }
                Err(e) => return Err(format!("parse {}: {}", path.display(), e)),
            }
        }
    };

    apply_codex_env_updates(&mut root, env_updates);

    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(root))
        .map_err(|e| format!("serialize: {}", e))?;
    let serialized = format!("{}\n", serialized);

    let plan = AtomicWritePlan {
        path: path.clone(),
        expected_mtime: mtime,
        tmp_suffix: "tmp".into(),
        backup_suffix: "bak".into(),
    };
    let out = fs_atomic::atomic_write_with_mtime_check(&plan, serialized.as_bytes()).map_err(
        |e| match e {
            AtomicWriteError::DriftDetected { .. } => DRIFT_DETECTED_TAG.to_string(),
            other => format!("{other}"),
        },
    )?;

    Ok(CodexAuthWriteResult {
        path: out.path.to_string_lossy().into_owned(),
        backup_path: out.backup_path.map(|p| p.to_string_lossy().into_owned()),
    })
}

/// Apply env_updates to a parsed `auth.json` root. Pure — no I/O. The
/// auth_mode flip is governed entirely by the eventual presence of
/// `OPENAI_API_KEY` vs `tokens` so callers don't have to coordinate it.
fn apply_codex_env_updates(
    root: &mut serde_json::Map<String, serde_json::Value>,
    env_updates: HashMap<String, Option<String>>,
) {
    let mut openai_api_key_touched = false;
    for (k, v) in env_updates {
        if k == "OPENAI_API_KEY" {
            openai_api_key_touched = true;
            match v {
                Some(value) if !value.is_empty() => {
                    root.insert("OPENAI_API_KEY".into(), serde_json::Value::String(value));
                }
                _ => {
                    root.remove("OPENAI_API_KEY");
                }
            }
            continue;
        }
        match v {
            Some(value) if !value.is_empty() => {
                root.insert(k, serde_json::Value::String(value));
            }
            _ => {
                root.remove(&k);
            }
        }
    }

    if openai_api_key_touched {
        let has_api_key = root.get("OPENAI_API_KEY")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let has_tokens = root
            .get("tokens")
            .map(|v| !v.is_null())
            .unwrap_or(false);
        if has_api_key {
            root.insert("auth_mode".into(), serde_json::Value::String("ApiKey".into()));
        } else if has_tokens {
            root.insert(
                "auth_mode".into(),
                serde_json::Value::String("ChatGPT".into()),
            );
        } else {
            root.remove("auth_mode");
        }
    }
}

#[cfg(test)]
mod codex_write_tests {
    use super::*;
    use serde_json::json;

    fn updates(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.map(String::from)))
            .collect()
    }

    #[test]
    fn setting_api_key_flips_auth_mode_to_apikey() {
        let mut root = serde_json::Map::new();
        root.insert("tokens".into(), json!({"access_token": "oat"}));
        apply_codex_env_updates(&mut root, updates(&[("OPENAI_API_KEY", Some("sk-x"))]));
        assert_eq!(root.get("OPENAI_API_KEY"), Some(&json!("sk-x")));
        assert_eq!(root.get("auth_mode"), Some(&json!("ApiKey")));
        assert_eq!(root.get("tokens"), Some(&json!({"access_token": "oat"})));
    }

    #[test]
    fn clearing_api_key_falls_back_to_chatgpt_when_tokens_present() {
        let mut root = serde_json::Map::new();
        root.insert("OPENAI_API_KEY".into(), json!("sk-x"));
        root.insert("auth_mode".into(), json!("ApiKey"));
        root.insert("tokens".into(), json!({"access_token": "oat"}));
        apply_codex_env_updates(&mut root, updates(&[("OPENAI_API_KEY", None)]));
        assert!(root.get("OPENAI_API_KEY").is_none());
        assert_eq!(root.get("auth_mode"), Some(&json!("ChatGPT")));
    }

    #[test]
    fn clearing_api_key_removes_auth_mode_when_no_tokens() {
        let mut root = serde_json::Map::new();
        root.insert("OPENAI_API_KEY".into(), json!("sk-x"));
        root.insert("auth_mode".into(), json!("ApiKey"));
        apply_codex_env_updates(&mut root, updates(&[("OPENAI_API_KEY", None)]));
        assert!(root.get("OPENAI_API_KEY").is_none());
        assert!(root.get("auth_mode").is_none());
    }

    #[test]
    fn empty_string_treated_as_clear() {
        let mut root = serde_json::Map::new();
        root.insert("OPENAI_API_KEY".into(), json!("sk-x"));
        root.insert("auth_mode".into(), json!("ApiKey"));
        apply_codex_env_updates(&mut root, updates(&[("OPENAI_API_KEY", Some(""))]));
        assert!(root.get("OPENAI_API_KEY").is_none());
    }

    #[test]
    fn unknown_keys_passed_through_as_strings() {
        let mut root = serde_json::Map::new();
        apply_codex_env_updates(&mut root, updates(&[("CUSTOM", Some("v"))]));
        assert_eq!(root.get("CUSTOM"), Some(&json!("v")));
    }

    #[test]
    fn null_tokens_treated_as_no_tokens() {
        let mut root = serde_json::Map::new();
        root.insert("OPENAI_API_KEY".into(), json!("sk-x"));
        root.insert("auth_mode".into(), json!("ApiKey"));
        root.insert("tokens".into(), serde_json::Value::Null);
        apply_codex_env_updates(&mut root, updates(&[("OPENAI_API_KEY", None)]));
        assert!(root.get("auth_mode").is_none());
    }

    #[test]
    fn preserves_unrelated_top_level_keys() {
        let mut root = serde_json::Map::new();
        root.insert(
            "agent_identity".into(),
            json!("eyJ.agent.jwt"),
        );
        root.insert("last_refresh".into(), json!("2026-05-10T01:23:45Z"));
        apply_codex_env_updates(&mut root, updates(&[("OPENAI_API_KEY", Some("sk-x"))]));
        assert!(root.get("agent_identity").is_some());
        assert!(root.get("last_refresh").is_some());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reports_path_even_when_missing() {
        let status = ccswitch_status();
        assert!(status.db_path.is_some());
        // On a CI host without CCSwitch installed this is the expected branch.
        if !status.exists {
            assert_eq!(status.counts.providers, 0);
            assert!(status.error.is_none());
        }
    }
}
