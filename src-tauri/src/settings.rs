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
}
