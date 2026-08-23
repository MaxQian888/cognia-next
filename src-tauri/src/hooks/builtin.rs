// Product-bundled built-in hooks (desktop side).
//
// Mirrors the TS registry in `lib/claude/hooks/builtin-hooks.ts`: a curated list
// of lifecycle command-hooks that ship with cognia and are merged UNDER the
// user's own settings.json hooks (user groups run first, built-ins last). Each
// id is individually overridable via the `builtinHookOverrides` map stored in
// `~/.claude/settings.json` (id → bool); absent ids fall back to
// `default_enabled`.
//
// The scripts live in the bundled `hooks/builtin/` resource dir and run with
// the process-wide Node runtime selected during desktop setup. If the runtime
// or script path does not resolve, the command handler soft-allows (only an
// explicit exit 2 blocks), so a packaging gap does not lock a turn.

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

#[cfg(not(windows))]
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(windows)]
fn quote(value: &str) -> String {
    // Hook commands run through cmd.exe on Windows. Quotes protect whitespace
    // and metacharacters; doubling percent signs prevents environment-variable
    // expansion in paths supplied by the installation layout.
    format!("\"{}\"", value.replace('%', "%%").replace('"', "\"\""))
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
        let command = format!(
            "{} {}",
            quote(node_bin),
            quote(&script_path.to_string_lossy())
        );
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
/// app, else a dev fallback anchored at the repo root.
///
/// The dev binary's CWD is `src-tauri/` (cargo / `tauri dev`), so a
/// CWD-relative `hooks/builtin` resolves to the non-existent
/// `src-tauri/hooks/builtin` — `node` then dies with a "Cannot find module"
/// (`cjs/loader`) crash on every SessionStart / UserPromptSubmit. Anchor on the
/// compile-time manifest dir's parent (the repo root) instead — the same
/// resource-dir-then-manifest-parent pattern `sidecar::sidecar_dir` uses — and
/// fall back to the CWD-relative path only as a last resort.
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
    // Dev: walk up from the Cargo manifest dir (`src-tauri/`) to the repo root.
    if let Some(root) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        let cand = root.join("hooks").join("builtin");
        if cand.is_dir() {
            return cand;
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
    let node = match cognia_core::node_runtime::node_executable() {
        Ok(node) => node,
        Err(error) => {
            log::warn!("built-in hooks disabled because Node.js is unavailable: {error}");
            return;
        }
    };
    let builtin = build_builtin_hooks(&base, &node.to_string_lossy(), &overrides);
    if builtin.is_empty() {
        return;
    }
    let merged = merge_builtin_under(settings.hooks.take(), builtin);
    settings.hooks = Some(merged);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared registry table. Compiled in so this side fails when the Rust
    /// registry drifts from `lib/claude/hooks/builtin-hooks.ts` — they are two
    /// hand-maintained copies of the same list, and because
    /// `builtinHookOverrides` is keyed by id a drifted id also orphans the
    /// user's enable/disable choice on one shell.
    const LOCKSTEP: &str = include_str!("../../../hooks/builtin-hooks.lockstep.json");

    #[test]
    fn builtin_registry_matches_the_shared_lockstep_table() {
        let table: Value = serde_json::from_str(LOCKSTEP).unwrap();
        let expected = table["hooks"].as_array().expect("hooks array");
        assert_eq!(
            BUILTIN_HOOKS.len(),
            expected.len(),
            "built-in hook count drifted from the lockstep table"
        );
        for (def, want) in BUILTIN_HOOKS.iter().zip(expected) {
            assert_eq!(def.id, want["id"].as_str().unwrap());
            assert_eq!(def.event, want["event"].as_str().unwrap());
            assert_eq!(def.script, want["script"].as_str().unwrap());
            assert_eq!(
                def.default_enabled,
                want["defaultEnabled"].as_bool().unwrap()
            );
            assert_eq!(def.matcher, want["matcher"].as_str());
        }
    }

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
        assert!(cmd.starts_with(&format!("{} ", quote("node"))));
    }

    #[test]
    fn node_executable_and_script_paths_are_shell_quoted() {
        let cfg = build_builtin_hooks(
            Path::new("/Applications/Cognia App/hooks"),
            "/Applications/Cognia App/Node/bin/node",
            &Map::new(),
        );
        let command = cfg["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();

        assert_eq!(
            command,
            format!(
                "{} {}",
                quote("/Applications/Cognia App/Node/bin/node"),
                quote("/Applications/Cognia App/hooks/auto-context-loader.mjs")
            )
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn posix_hook_arguments_do_not_expand_shell_syntax() {
        assert_eq!(
            quote("$HOME/$(touch nope)/`id`/it's"),
            "'$HOME/$(touch nope)/`id`/it'\"'\"'s'"
        );
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

    #[test]
    fn builtin_base_dir_resolves_to_existing_repo_root_scripts() {
        // Regression: the dev fallback must point at the repo-root `hooks/builtin`
        // (where the scripts live), NOT `src-tauri/hooks/builtin` (the old
        // CWD-relative path that made `node` crash with "Cannot find module").
        let dir = builtin_base_dir();
        assert!(
            dir.ends_with("hooks/builtin"),
            "unexpected base dir: {}",
            dir.display()
        );
        assert!(
            dir.join("auto-context-loader.mjs").is_file(),
            "default-on hook script not found under {}",
            dir.display()
        );
    }
}
