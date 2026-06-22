// Product-bundled built-in hooks (desktop side).
//
// Mirrors the TS registry in `lib/claude/hooks/builtin-hooks.ts`: a curated list
// of lifecycle command-hooks that ship with cognia and are merged UNDER the
// user's own settings.json hooks (user groups run first, built-ins last). Each
// id is individually overridable via the `builtinHookOverrides` map stored in
// `~/.claude/settings.json` (id → bool); absent ids fall back to
// `default_enabled`.
//
// The scripts live in the bundled `hooks/builtin/` resource dir and run as
// spawned `node` command hooks. If `node` is absent or the script path does not
// resolve, the command handler soft-allows (only an explicit exit 2 blocks), so
// a packaging gap degrades gracefully instead of locking a turn.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::settings::ClaudeSettings;

/// One bundled hook contribution. Keep in lockstep with the TS `BUILTIN_HOOKS`.
pub struct BuiltinHookDef {
    pub id: &'static str,
    pub event: &'static str,
    pub matcher: Option<&'static str>,
    pub script: &'static str,
    pub default_enabled: bool,
}

pub const BUILTIN_HOOKS: &[BuiltinHookDef] = &[
    BuiltinHookDef {
        id: "auto-context-loader",
        event: "SessionStart",
        matcher: None,
        script: "auto-context-loader.mjs",
        default_enabled: true,
    },
    BuiltinHookDef {
        id: "auto-context-loader-prompt",
        event: "UserPromptSubmit",
        matcher: None,
        script: "auto-context-loader.mjs",
        default_enabled: true,
    },
    BuiltinHookDef {
        id: "cost-quota-guard",
        event: "UserPromptSubmit",
        matcher: None,
        script: "cost-quota-guard.mjs",
        default_enabled: false,
    },
    BuiltinHookDef {
        id: "pii-safety-guard",
        event: "UserPromptSubmit",
        matcher: None,
        script: "pii-safety-guard.mjs",
        default_enabled: false,
    },
    BuiltinHookDef {
        id: "pii-safety-guard-tool",
        event: "PreToolUse",
        matcher: None,
        script: "pii-safety-guard.mjs",
        default_enabled: false,
    },
];

fn is_enabled(def: &BuiltinHookDef, overrides: &Map<String, Value>) -> bool {
    match overrides.get(def.id) {
        Some(Value::Bool(b)) => *b,
        _ => def.default_enabled,
    }
}

fn quote(p: &str) -> String {
    format!("\"{}\"", p.replace('"', "\\\""))
}

/// Build the built-in hook groups keyed by event name (a `settings.json`
/// `hooks` sub-object). Pure — `base_dir` + `node_bin` are injected.
pub fn build_builtin_hooks(
    base_dir: &Path,
    node_bin: &str,
    overrides: &Map<String, Value>,
) -> Map<String, Value> {
    let mut out: Map<String, Value> = Map::new();
    for def in BUILTIN_HOOKS {
        if !is_enabled(def, overrides) {
            continue;
        }
        let script_path = base_dir.join(def.script);
        let command = format!("{} {}", node_bin, quote(&script_path.to_string_lossy()));
        let mut group = Map::new();
        if let Some(m) = def.matcher {
            group.insert("matcher".to_string(), json!(m));
        }
        group.insert(
            "hooks".to_string(),
            json!([{ "type": "command", "command": command }]),
        );
        let arr = out
            .entry(def.event.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(dst) = arr {
            dst.push(Value::Object(group));
        }
    }
    out
}

/// Merge built-in groups UNDER an existing `hooks` value: for each event the
/// existing (user) groups come first, then the built-in groups. Pure.
pub fn merge_builtin_under(existing: Option<Value>, builtin: Map<String, Value>) -> Value {
    let mut merged = match existing {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    for (event, groups) in builtin {
        let Value::Array(src) = groups else { continue };
        let arr = merged
            .entry(event)
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(dst) = arr {
            dst.extend(src);
        }
    }
    Value::Object(merged)
}

/// Read the `builtinHookOverrides` map (id → bool) out of a settings' extra keys.
fn overrides_from(settings: &ClaudeSettings) -> Map<String, Value> {
    match settings.extra.get("builtinHookOverrides") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

/// Resolve the bundled `hooks/builtin/` dir: the Tauri resource dir in a packaged
/// app, else a dev fallback relative to the current working directory.
fn builtin_base_dir() -> PathBuf {
    #[cfg(not(test))]
    if let Some(app) = crate::crash::app_handle() {
        use tauri::Manager;
        if let Ok(res) = app.path().resource_dir() {
            let cand = res.join("hooks").join("builtin");
            if cand.is_dir() {
                return cand;
            }
        }
    }
    std::env::current_dir()
        .unwrap_or_default()
        .join("hooks")
        .join("builtin")
}

/// Merge the enabled built-in hooks into a settings' `hooks` block, under any
/// hooks the user already configured. Best-effort: a missing script soft-allows
/// at spawn time, so this never blocks a turn.
pub fn apply_builtin_hooks(settings: &mut ClaudeSettings) {
    let overrides = overrides_from(settings);
    let base = builtin_base_dir();
    let builtin = build_builtin_hooks(&base, "node", &overrides);
    if builtin.is_empty() {
        return;
    }
    let merged = merge_builtin_under(settings.hooks.take(), builtin);
    settings.hooks = Some(merged);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overrides(pairs: &[(&str, bool)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), Value::Bool(*v)))
            .collect()
    }

    #[test]
    fn default_on_hooks_are_emitted_without_overrides() {
        let cfg = build_builtin_hooks(Path::new("/base"), "node", &Map::new());
        // both auto-context-loader entries (SessionStart + UserPromptSubmit)
        assert!(cfg.get("SessionStart").is_some());
        let ups = cfg.get("UserPromptSubmit").unwrap().as_array().unwrap();
        assert_eq!(ups.len(), 1); // only the default-on prompt loader
        let cmd = ups[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("auto-context-loader.mjs"));
        assert!(cmd.starts_with("node "));
    }

    #[test]
    fn opt_in_guard_appears_only_when_enabled() {
        let cfg = build_builtin_hooks(
            Path::new("/b"),
            "node",
            &overrides(&[("cost-quota-guard", true)]),
        );
        let ups = cfg.get("UserPromptSubmit").unwrap().as_array().unwrap();
        assert_eq!(ups.len(), 2); // prompt loader + cost guard
    }

    #[test]
    fn default_on_hook_can_be_disabled() {
        let cfg = build_builtin_hooks(
            Path::new("/b"),
            "node",
            &overrides(&[
                ("auto-context-loader", false),
                ("auto-context-loader-prompt", false),
            ]),
        );
        assert!(cfg.get("SessionStart").is_none());
        assert!(cfg.get("UserPromptSubmit").is_none());
    }

    #[test]
    fn tool_scoped_hook_carries_matcher_when_present() {
        // pii-safety-guard-tool has no matcher in the catalog → none emitted.
        let cfg = build_builtin_hooks(
            Path::new("/b"),
            "node",
            &overrides(&[("pii-safety-guard-tool", true)]),
        );
        let pre = cfg.get("PreToolUse").unwrap().as_array().unwrap();
        assert_eq!(pre.len(), 1);
        assert!(pre[0].get("matcher").is_none());
    }

    #[test]
    fn merge_puts_user_groups_before_builtin() {
        let existing = json!({
            "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "user" }] }]
        });
        let builtin = build_builtin_hooks(Path::new("/b"), "node", &Map::new());
        let merged = merge_builtin_under(Some(existing), builtin);
        let ups = merged["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(ups[0]["hooks"][0]["command"], "user");
        assert!(ups.len() >= 2); // user + builtin
    }

    #[test]
    fn merge_tolerates_absent_existing_hooks() {
        let builtin = build_builtin_hooks(Path::new("/b"), "node", &Map::new());
        let merged = merge_builtin_under(None, builtin);
        assert!(merged["SessionStart"].is_array());
    }
}
