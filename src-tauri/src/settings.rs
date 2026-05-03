// Reads `.claude/settings.json` from the three Claude Code locations and
// exposes the parsed shape (plus a shallow merge) to the frontend.
//
// Locations, in increasing precedence:
//   1. `~/.claude/settings.json`            — user
//   2. `<cwd>/.claude/settings.json`        — project (committed)
//   3. `<cwd>/.claude/settings.local.json`  — local (gitignored)
//
// We deliberately keep this layer dumb: it parses, exposes raw values per
// scope, and offers a single shallow merge helper. Higher-level concerns
// (hook execution, mcp wiring, allowlist enforcement) live elsewhere.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Subset of fields we explicitly model. Anything else lands in `extra` so
/// future Claude Code releases don't break this reader.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_style: Option<String>,
    /// Permissions block (`allow`, `ask`, `deny`, `additionalDirectories`,
    /// `defaultMode`). Forwarded as-is; consumers parse what they need.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Value>,
    /// Hooks block keyed by event name. Consumed by `crate::hooks`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hooks: Option<Value>,
    /// MCP server map keyed by server name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Value>,
    /// Stash for everything we don't model explicitly.
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSettings {
    pub user: Option<ClaudeSettings>,
    pub project: Option<ClaudeSettings>,
    pub local: Option<ClaudeSettings>,
    /// Shallow per-key merge: local wins over project wins over user. Hooks,
    /// permissions, and mcpServers are NOT deep-merged here; downstream
    /// consumers do that with semantics they care about (e.g. concat hooks).
    pub merged: ClaudeSettings,
}

/// Read `~/.claude/settings.json`. `Ok(None)` when the file does not exist,
/// so callers can distinguish "no settings" from "settings invalid".
#[tauri::command]
pub fn read_claude_user_settings() -> Result<Option<ClaudeSettings>, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let path = home.join(".claude").join("settings.json");
    read_settings_at(&path)
}

/// Read `<cwd>/.claude/settings.json`.
#[tauri::command]
pub fn read_claude_project_settings(cwd: String) -> Result<Option<ClaudeSettings>, String> {
    let path = PathBuf::from(cwd).join(".claude").join("settings.json");
    read_settings_at(&path)
}

/// Read `<cwd>/.claude/settings.local.json` (the gitignored override).
#[tauri::command]
pub fn read_claude_local_settings(cwd: String) -> Result<Option<ClaudeSettings>, String> {
    let path = PathBuf::from(cwd)
        .join(".claude")
        .join("settings.local.json");
    read_settings_at(&path)
}

/// Read all three scopes, plus the shallow merge. Pass `None` for `cwd` to
/// only resolve the user scope.
#[tauri::command]
pub fn read_claude_effective_settings(cwd: Option<String>) -> Result<EffectiveSettings, String> {
    let user = read_claude_user_settings()?;
    let project = match cwd.as_ref() {
        Some(c) if !c.is_empty() => read_claude_project_settings(c.clone())?,
        _ => None,
    };
    let local = match cwd.as_ref() {
        Some(c) if !c.is_empty() => read_claude_local_settings(c.clone())?,
        _ => None,
    };
    let merged = shallow_merge(&user, &project, &local);
    Ok(EffectiveSettings {
        user,
        project,
        local,
        merged,
    })
}

/// Apply CCSwitch-style env updates to a parsed settings root. `Some(v)`
/// sets / overwrites a key; `None` (and empty strings) remove it. Every
/// other top-level field is preserved verbatim. Pure — no I/O.
fn merge_env_updates(
    mut root: serde_json::Map<String, Value>,
    env_updates: HashMap<String, Option<String>>,
) -> serde_json::Map<String, Value> {
    let mut env_obj = match root.remove("env") {
        Some(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    for (k, v) in env_updates {
        match v {
            Some(value) if !value.is_empty() => {
                env_obj.insert(k, Value::String(value));
            }
            _ => {
                env_obj.remove(&k);
            }
        }
    }
    if env_obj.is_empty() {
        root.remove("env");
    } else {
        root.insert("env".to_string(), Value::Object(env_obj));
    }
    root
}

fn read_settings_at(path: &Path) -> Result<Option<ClaudeSettings>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let parsed: ClaudeSettings =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", path.display(), e))?;
    Ok(Some(parsed))
}

/// Result of writing to a Claude settings file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettingsWriteResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

/// Patch the `env` block in `~/.claude/settings.json`. Used by the
/// CCSwitch provider-switch flow when the user opts to propagate the
/// switch to Claude Code (so subsequent `claude` CLI invocations see the
/// new ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL).
///
/// Semantics:
///   - `env_updates[key] = Some(v)` → set / overwrite
///   - `env_updates[key] = None`    → remove the key (e.g., clearing
///     ANTHROPIC_BASE_URL when switching to the official endpoint)
///
/// Every other top-level field (model, permissions, hooks, mcpServers,
/// unknown keys in `extra`) is preserved verbatim. The file is written
/// atomically (temp + rename); a `.bak.<ts>` is left alongside the
/// original.
#[tauri::command]
pub fn write_claude_settings_env(
    env_updates: HashMap<String, Option<String>>,
) -> Result<ClaudeSettingsWriteResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dir = home.join(".claude");
    let path = dir.join("settings.json");

    // The agent must already be installed — we don't auto-create the
    // `.claude` directory because that would silently materialize a
    // settings file for users who haven't set up Claude Code at all.
    if !dir.exists() {
        return Err(format!(
            "Claude Code is not installed (missing {}). Install Claude Code first.",
            dir.display()
        ));
    }

    let root: serde_json::Map<String, Value> = if path.is_file() {
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {}", path.display(), e))?;
        if raw.trim().is_empty() {
            serde_json::Map::new()
        } else {
            match serde_json::from_str::<Value>(&raw) {
                Ok(Value::Object(m)) => m,
                Ok(_) => {
                    return Err(format!(
                        "{} is not a JSON object — refusing to overwrite",
                        path.display()
                    ))
                }
                Err(e) => return Err(format!("parse {}: {}", path.display(), e)),
            }
        }
    } else {
        serde_json::Map::new()
    };

    let merged = merge_env_updates(root, env_updates);
    let serialized =
        serde_json::to_string_pretty(&Value::Object(merged)).map_err(|e| format!("serialize: {}", e))?;
    let serialized = format!("{}\n", serialized);

    // Atomic write with backup, mirroring `agents::io::write_file`.
    let backup_path = if path.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let bp = path.with_extension(format!("json.bak.{}", ts));
        std::fs::copy(&path, &bp).map_err(|e| format!("backup: {}", e))?;
        Some(bp.to_string_lossy().into_owned())
    } else {
        None
    };
    let tmp_path = path.with_extension("json.tmp");
    {
        use std::io::Write as _;
        let mut f = std::fs::File::create(&tmp_path).map_err(|e| format!("create tmp: {}", e))?;
        f.write_all(serialized.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        f.sync_all().ok();
    }
    std::fs::rename(&tmp_path, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("rename into place: {}", e)
    })?;

    Ok(ClaudeSettingsWriteResult {
        path: path.to_string_lossy().into_owned(),
        backup_path,
    })
}

/// Shallow per-top-level-key merge. Each key takes the highest-precedence
/// value present (local > project > user); when no scope sets the key, it
/// remains None / empty. `extra` is merged key-by-key with the same
/// precedence so unknown fields still flow through.
fn shallow_merge(
    user: &Option<ClaudeSettings>,
    project: &Option<ClaudeSettings>,
    local: &Option<ClaudeSettings>,
) -> ClaudeSettings {
    let mut out = ClaudeSettings::default();
    for src in [user, project, local].iter().copied().flatten() {
        if src.model.is_some() {
            out.model = src.model.clone();
        }
        if src.effort_level.is_some() {
            out.effort_level = src.effort_level.clone();
        }
        if src.output_style.is_some() {
            out.output_style = src.output_style.clone();
        }
        if src.permissions.is_some() {
            out.permissions = src.permissions.clone();
        }
        if src.hooks.is_some() {
            out.hooks = src.hooks.clone();
        }
        if src.mcp_servers.is_some() {
            out.mcp_servers = src.mcp_servers.clone();
        }
        for (k, v) in &src.extra {
            out.extra.insert(k.clone(), v.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(model: Option<&str>, effort: Option<&str>) -> ClaudeSettings {
        ClaudeSettings {
            model: model.map(String::from),
            effort_level: effort.map(String::from),
            ..Default::default()
        }
    }

    #[test]
    fn merge_precedence_local_wins() {
        let user = Some(settings(Some("user-model"), Some("low")));
        let project = Some(settings(Some("project-model"), None));
        let local = Some(settings(None, Some("max")));
        let merged = shallow_merge(&user, &project, &local);
        // project wins over user for model; local wins over both for effort.
        assert_eq!(merged.model.as_deref(), Some("project-model"));
        assert_eq!(merged.effort_level.as_deref(), Some("max"));
    }

    #[test]
    fn merge_falls_back_to_user() {
        let user = Some(settings(Some("user-model"), Some("low")));
        let merged = shallow_merge(&user, &None, &None);
        assert_eq!(merged.model.as_deref(), Some("user-model"));
        assert_eq!(merged.effort_level.as_deref(), Some("low"));
    }

    #[test]
    fn merge_extra_keys_flow_through() {
        let mut user = ClaudeSettings::default();
        user.extra.insert("foo".into(), json!("user-value"));
        let mut project = ClaudeSettings::default();
        project.extra.insert("foo".into(), json!("project-value"));
        project.extra.insert("bar".into(), json!(42));
        let merged = shallow_merge(&Some(user), &Some(project), &None);
        assert_eq!(merged.extra.get("foo"), Some(&json!("project-value")));
        assert_eq!(merged.extra.get("bar"), Some(&json!(42)));
    }

    #[test]
    fn parse_unknown_top_level_field_lands_in_extra() {
        let raw = r#"{"model":"sonnet","customThing":{"x":1}}"#;
        let s: ClaudeSettings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.model.as_deref(), Some("sonnet"));
        assert_eq!(s.extra.get("customThing"), Some(&json!({"x": 1})));
    }

    fn root_with(env: Value, extra: &[(&str, Value)]) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        m.insert("env".to_string(), env);
        for (k, v) in extra {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }

    fn updates(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.map(String::from)))
            .collect()
    }

    #[test]
    fn merge_env_updates_inserts_into_empty() {
        let merged = merge_env_updates(
            serde_json::Map::new(),
            updates(&[("ANTHROPIC_API_KEY", Some("sk-x"))]),
        );
        assert_eq!(
            merged.get("env"),
            Some(&json!({ "ANTHROPIC_API_KEY": "sk-x" }))
        );
    }

    #[test]
    fn merge_env_updates_preserves_other_keys() {
        let mut root = serde_json::Map::new();
        root.insert("model".to_string(), json!("sonnet"));
        root.insert("permissions".to_string(), json!({ "ask": [] }));
        root.insert("env".to_string(), json!({ "OTHER": "stays" }));

        let merged = merge_env_updates(root, updates(&[("ANTHROPIC_API_KEY", Some("sk-y"))]));

        assert_eq!(merged.get("model"), Some(&json!("sonnet")));
        assert_eq!(merged.get("permissions"), Some(&json!({ "ask": [] })));
        let env = merged.get("env").and_then(Value::as_object).unwrap();
        assert_eq!(env.get("OTHER"), Some(&json!("stays")));
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&json!("sk-y")));
    }

    #[test]
    fn merge_env_updates_removes_on_none() {
        let root = root_with(
            json!({ "ANTHROPIC_BASE_URL": "https://old", "KEEP": "yes" }),
            &[],
        );
        let merged = merge_env_updates(root, updates(&[("ANTHROPIC_BASE_URL", None)]));
        let env = merged.get("env").and_then(Value::as_object).unwrap();
        assert!(env.get("ANTHROPIC_BASE_URL").is_none());
        assert_eq!(env.get("KEEP"), Some(&json!("yes")));
    }

    #[test]
    fn merge_env_updates_removes_on_empty_string() {
        let root = root_with(json!({ "X": "v" }), &[]);
        let merged = merge_env_updates(root, updates(&[("X", Some(""))]));
        // Empty string treated like None — env block becomes empty and is dropped.
        assert!(merged.get("env").is_none());
    }

    #[test]
    fn merge_env_updates_drops_empty_env_block() {
        let root = root_with(json!({ "X": "v" }), &[("model", json!("sonnet"))]);
        let merged = merge_env_updates(root, updates(&[("X", None)]));
        assert!(merged.get("env").is_none());
        assert_eq!(merged.get("model"), Some(&json!("sonnet")));
    }

    #[test]
    fn merge_env_updates_replaces_non_object_env() {
        // If a previous (broken) writer left a non-object `env`, treat it as
        // absent rather than refusing to update.
        let mut root = serde_json::Map::new();
        root.insert("env".to_string(), json!("garbage"));
        let merged = merge_env_updates(root, updates(&[("ANTHROPIC_API_KEY", Some("sk-z"))]));
        assert_eq!(
            merged.get("env"),
            Some(&json!({ "ANTHROPIC_API_KEY": "sk-z" }))
        );
    }
}
