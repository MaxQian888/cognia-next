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
pub fn ccswitch_status(manual_data_dir: Option<String>) -> CcswitchStatus {
    let Some(resolved) = resolve_ccswitch_db(manual_data_dir.as_deref()) else {
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
pub fn ccswitch_list_providers(
    manual_data_dir: Option<String>,
) -> Result<Vec<CcswitchProvider>, String> {
    with_conn(manual_data_dir.as_deref(), |c| db_list_providers(c))
}

#[tauri::command]
pub fn ccswitch_list_mcp_servers(
    manual_data_dir: Option<String>,
) -> Result<Vec<CcswitchMcpServer>, String> {
    with_conn(manual_data_dir.as_deref(), |c| db_list_mcp_servers(c))
}

#[tauri::command]
pub fn ccswitch_list_prompts(
    manual_data_dir: Option<String>,
) -> Result<Vec<CcswitchPrompt>, String> {
    with_conn(manual_data_dir.as_deref(), |c| db_list_prompts(c))
}

#[tauri::command]
pub fn ccswitch_list_skills(
    manual_data_dir: Option<String>,
) -> Result<Vec<CcswitchSkill>, String> {
    with_conn(manual_data_dir.as_deref(), |c| db_list_skills(c))
}

fn with_conn<T, F>(manual_data_dir: Option<&str>, f: F) -> Result<T, String>
where
    F: FnOnce(&rusqlite::Connection) -> Result<T, CcswitchError>,
    T: Default,
{
    let Some(path) = ccswitch_db_path(manual_data_dir) else {
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

/// How many `.bak.<ts>` backups each ccswitch writer retains. Older ones are
/// pruned (oldest-first) after every successful atomic write.
const BACKUP_KEEP: usize = 10;

/// Outcome echoed back to the renderer after a successful agent-config write.
/// Shared shape across the codex / gemini / opencode writers — they all return
/// the written path plus the optional pre-write backup path.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthWriteResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

/// Outcome echoed back after a successful Gemini settings write. Mirrors
/// `CodexAuthWriteResult`; kept as a distinct type so the renderer's typed
/// IPC stays unambiguous about which writer produced it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiSettingsWriteResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

/// Outcome echoed back after a successful OpenCode auth.json write.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeAuthWriteResult {
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

    // Keep a bounded backup history so repeated switches don't accumulate
    // `.bak.<ts>` files forever (best-effort — failures don't abort the write).
    fs_atomic::rotate_backups(&path, BACKUP_KEEP);

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

/// Patch the env keys cognia propagates into Gemini CLI's
/// `~/.gemini/settings.json`. Gemini CLI resolves `$VAR`-style references in
/// settings.json from the environment, but the dominant, documented way to
/// pin a key/base-url is the env vars themselves. cc-switch (and we) write the
/// literal values into the `env` block of settings.json so subsequent
/// `gemini` invocations pick them up without the user editing a shell profile.
///
/// Verified env keys (google-gemini/gemini-cli docs):
///   - `GEMINI_API_KEY`           → the API key for gemini-api-key auth.
///   - `GOOGLE_GEMINI_BASE_URL`   → overrides the default Gemini API base URL.
///
/// Semantics match the Claude writer: `Some(v)` sets, `None`/empty removes.
/// The `env` object is created if absent; all other top-level keys
/// (`theme`, `selectedAuthType`, `mcpServers`, …) are preserved verbatim.
/// Atomic write + mtime drift detection + bounded backup rotation.
#[tauri::command]
pub fn write_gemini_settings_env(
    env_updates: HashMap<String, Option<String>>,
) -> Result<GeminiSettingsWriteResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dir = home.join(".gemini");
    let path = dir.join("settings.json");

    if !dir.exists() {
        return Err(format!(
            "Gemini CLI is not installed (missing {}). Install gemini-cli first.",
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

    apply_gemini_env_updates(&mut root, env_updates);

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

    fs_atomic::rotate_backups(&path, BACKUP_KEEP);

    Ok(GeminiSettingsWriteResult {
        path: out.path.to_string_lossy().into_owned(),
        backup_path: out.backup_path.map(|p| p.to_string_lossy().into_owned()),
    })
}

/// Apply env updates into the nested `env` object of a parsed gemini
/// `settings.json` root. Pure — no I/O. Creates the `env` object on first
/// write; removes it when the last key inside it is cleared so we don't leave
/// an empty `"env": {}` behind.
fn apply_gemini_env_updates(
    root: &mut serde_json::Map<String, serde_json::Value>,
    env_updates: HashMap<String, Option<String>>,
) {
    // Take the existing env object (must be an object; a non-object `env` is
    // replaced rather than panicked on).
    let mut env = match root.remove("env") {
        Some(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    for (k, v) in env_updates {
        match v {
            Some(value) if !value.is_empty() => {
                env.insert(k, serde_json::Value::String(value));
            }
            _ => {
                env.remove(&k);
            }
        }
    }
    if !env.is_empty() {
        root.insert("env".into(), serde_json::Value::Object(env));
    }
}

/// Patch a single provider entry in OpenCode CLI's `auth.json`. cognia reads
/// this file in discovery (`subscription/opencode/discovery.rs`); here we
/// write the api key for one provider so a ccswitch provider switch reaches
/// OpenCode too.
///
/// Shape of auth.json: a flat object keyed by provider id, each value an
/// object — e.g. `{ "anthropic": { "type": "api", "key": "sk-..." } }`.
/// OpenCode's api-key entries carry the literal key under `key` (its
/// `Auth.Api` variant). We set `type: "api"` + `key: <value>` for the
/// target provider; clearing removes the whole provider entry.
///
/// `env_updates` carries exactly one logical key — the api key — under the
/// well-known `OPENCODE_API_KEY` name, plus an out-of-band `__provider` field
/// (consumed here, never written) telling us which provider entry to target.
/// Defaulting to `anthropic` keeps the common Claude-relay case working when
/// the caller omits it.
#[tauri::command]
pub fn write_opencode_auth_env(
    env_updates: HashMap<String, Option<String>>,
) -> Result<OpencodeAuthWriteResult, String> {
    let path = crate::subscription::opencode::discovery::opencode_auth_file_path()
        .ok_or_else(|| "could not resolve OpenCode auth.json path".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "OpenCode auth path has no parent dir".to_string())?
        .to_path_buf();

    if !dir.exists() {
        return Err(format!(
            "OpenCode CLI is not installed (missing {}). Install opencode first.",
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

    apply_opencode_env_updates(&mut root, env_updates);

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

    fs_atomic::rotate_backups(&path, BACKUP_KEEP);

    Ok(OpencodeAuthWriteResult {
        path: out.path.to_string_lossy().into_owned(),
        backup_path: out.backup_path.map(|p| p.to_string_lossy().into_owned()),
    })
}

/// Apply env updates to a parsed OpenCode `auth.json` root. Pure — no I/O.
/// The `__provider` field selects the provider id to target (default
/// `anthropic`); `OPENCODE_API_KEY` carries the key. Setting writes
/// `{ "type": "api", "key": <value> }`; clearing removes the provider entry.
fn apply_opencode_env_updates(
    root: &mut serde_json::Map<String, serde_json::Value>,
    mut env_updates: HashMap<String, Option<String>>,
) {
    let provider = env_updates
        .remove("__provider")
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "anthropic".to_string());

    let key = env_updates
        .get("OPENCODE_API_KEY")
        .cloned()
        .flatten()
        .filter(|s| !s.is_empty());

    match key {
        Some(value) => {
            let entry = serde_json::json!({ "type": "api", "key": value });
            root.insert(provider, entry);
        }
        None => {
            root.remove(&provider);
        }
    }
}

#[cfg(test)]
mod gemini_write_tests {
    use super::*;
    use serde_json::json;

    fn updates(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.map(String::from)))
            .collect()
    }

    #[test]
    fn sets_api_key_and_base_url_in_env_block() {
        let mut root = serde_json::Map::new();
        apply_gemini_env_updates(
            &mut root,
            updates(&[
                ("GEMINI_API_KEY", Some("g-key")),
                ("GOOGLE_GEMINI_BASE_URL", Some("https://proxy.example")),
            ]),
        );
        let env = root.get("env").unwrap().as_object().unwrap();
        assert_eq!(env.get("GEMINI_API_KEY"), Some(&json!("g-key")));
        assert_eq!(
            env.get("GOOGLE_GEMINI_BASE_URL"),
            Some(&json!("https://proxy.example"))
        );
    }

    #[test]
    fn clearing_removes_key_from_env() {
        let mut root = serde_json::Map::new();
        root.insert(
            "env".into(),
            json!({"GEMINI_API_KEY": "old", "GOOGLE_GEMINI_BASE_URL": "u"}),
        );
        apply_gemini_env_updates(&mut root, updates(&[("GOOGLE_GEMINI_BASE_URL", None)]));
        let env = root.get("env").unwrap().as_object().unwrap();
        assert!(env.get("GOOGLE_GEMINI_BASE_URL").is_none());
        assert_eq!(env.get("GEMINI_API_KEY"), Some(&json!("old")));
    }

    #[test]
    fn empty_string_treated_as_clear() {
        let mut root = serde_json::Map::new();
        root.insert("env".into(), json!({"GEMINI_API_KEY": "old"}));
        apply_gemini_env_updates(&mut root, updates(&[("GEMINI_API_KEY", Some(""))]));
        assert!(root.get("env").is_none(), "empty env object should be dropped");
    }

    #[test]
    fn drops_env_object_when_emptied() {
        let mut root = serde_json::Map::new();
        root.insert("theme".into(), json!("dark"));
        root.insert("env".into(), json!({"GEMINI_API_KEY": "old"}));
        apply_gemini_env_updates(&mut root, updates(&[("GEMINI_API_KEY", None)]));
        assert!(root.get("env").is_none());
        // Unrelated top-level keys preserved.
        assert_eq!(root.get("theme"), Some(&json!("dark")));
    }

    #[test]
    fn non_object_env_is_replaced_not_panicked() {
        let mut root = serde_json::Map::new();
        root.insert("env".into(), json!("garbage"));
        apply_gemini_env_updates(&mut root, updates(&[("GEMINI_API_KEY", Some("k"))]));
        let env = root.get("env").unwrap().as_object().unwrap();
        assert_eq!(env.get("GEMINI_API_KEY"), Some(&json!("k")));
    }

    #[test]
    fn preserves_unrelated_top_level_keys() {
        let mut root = serde_json::Map::new();
        root.insert("selectedAuthType".into(), json!("gemini-api-key"));
        root.insert("mcpServers".into(), json!({"x": {}}));
        apply_gemini_env_updates(&mut root, updates(&[("GEMINI_API_KEY", Some("k"))]));
        assert!(root.get("selectedAuthType").is_some());
        assert!(root.get("mcpServers").is_some());
    }
}

#[cfg(test)]
mod opencode_write_tests {
    use super::*;
    use serde_json::json;

    fn updates(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.map(String::from)))
            .collect()
    }

    #[test]
    fn writes_api_entry_for_default_provider() {
        let mut root = serde_json::Map::new();
        apply_opencode_env_updates(&mut root, updates(&[("OPENCODE_API_KEY", Some("sk-ant"))]));
        let entry = root.get("anthropic").unwrap();
        assert_eq!(entry.get("type"), Some(&json!("api")));
        assert_eq!(entry.get("key"), Some(&json!("sk-ant")));
    }

    #[test]
    fn writes_to_explicit_provider() {
        let mut root = serde_json::Map::new();
        apply_opencode_env_updates(
            &mut root,
            updates(&[("OPENCODE_API_KEY", Some("sk-oa")), ("__provider", Some("openai"))]),
        );
        assert!(root.get("anthropic").is_none());
        assert_eq!(root.get("openai").unwrap().get("key"), Some(&json!("sk-oa")));
    }

    #[test]
    fn clearing_removes_provider_entry() {
        let mut root = serde_json::Map::new();
        root.insert("anthropic".into(), json!({"type": "api", "key": "old"}));
        root.insert("openai".into(), json!({"type": "api", "key": "keep"}));
        apply_opencode_env_updates(&mut root, updates(&[("OPENCODE_API_KEY", None)]));
        assert!(root.get("anthropic").is_none());
        // Sibling provider untouched.
        assert!(root.get("openai").is_some());
    }

    #[test]
    fn empty_key_treated_as_clear() {
        let mut root = serde_json::Map::new();
        root.insert("anthropic".into(), json!({"type": "api", "key": "old"}));
        apply_opencode_env_updates(&mut root, updates(&[("OPENCODE_API_KEY", Some(""))]));
        assert!(root.get("anthropic").is_none());
    }

    #[test]
    fn blank_provider_falls_back_to_anthropic() {
        let mut root = serde_json::Map::new();
        apply_opencode_env_updates(
            &mut root,
            updates(&[("OPENCODE_API_KEY", Some("k")), ("__provider", Some("   "))]),
        );
        assert!(root.get("anthropic").is_some());
    }

    #[test]
    fn provider_field_is_not_written_as_entry() {
        let mut root = serde_json::Map::new();
        apply_opencode_env_updates(
            &mut root,
            updates(&[("OPENCODE_API_KEY", Some("k")), ("__provider", Some("openai"))]),
        );
        assert!(root.get("__provider").is_none());
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
        let status = ccswitch_status(None);
        assert!(status.db_path.is_some());
        // On a CI host without CCSwitch installed this is the expected branch.
        if !status.exists {
            assert_eq!(status.counts.providers, 0);
            assert!(status.error.is_none());
        }
    }
}
