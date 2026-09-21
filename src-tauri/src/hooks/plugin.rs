// Plugin-contributed command hooks (`manifest.commandHooks`, `command-hooks`
// capability). Each enabled plugin's block is merged UNDER the user's own
// hook groups and above the built-ins — the same settings.json `Event →
// HookGroup[]` shape every runner already executes, so plugin handlers get
// identical blocking / context / async semantics without a second runtime.
//
// Trust tier: these handlers run in the hook runtime (spawned commands,
// webhooks), not inside the plugin sandbox — identical to user-configured
// hooks. Collection is therefore gated on the manifest declaring the
// `command-hooks` capability; the field alone is inert.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::plugin_api::PluginRuntimeState;
use crate::settings::ClaudeSettings;

use super::builtin::{merge_builtin_under, quote};

/// Plugin-root spellings bound to the install dir at collection time. Mirrors
/// `lib/plugin/utils/plugin-root-tokens.ts` so converted bundles (canonical
/// `${COGNIA_PLUGIN_ROOT}`) and hand-authored manifests (source-ecosystem
/// spellings) bind identically on this rail.
const PLUGIN_ROOT_TOKENS: [&str; 4] = [
    "${COGNIA_PLUGIN_ROOT}",
    "${CLAUDE_PLUGIN_ROOT}",
    "${CODEX_PLUGIN_ROOT}",
    "${extensionPath}",
];

/// Manifest filenames an installed plugin may carry, probed in this order.
/// Runtime installs write `manifest.json` (`lifecycle::install`); `plugin.json`
/// is the CLI/source-layout alias `read_node_manifest` also accepts.
const MANIFEST_FILES: [&str; 2] = ["manifest.json", "plugin.json"];

fn replace_plugin_root_tokens(value: &Value, plugin_root: &str) -> Value {
    match value {
        Value::String(s) => {
            let mut out = s.clone();
            for token in PLUGIN_ROOT_TOKENS {
                out = out.replace(token, plugin_root);
            }
            Value::String(out)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| replace_plugin_root_tokens(v, plugin_root))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), replace_plugin_root_tokens(v, plugin_root)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Bind `${*_PLUGIN_ROOT}` spellings inside one `hooks[].command` string to a
/// shell-quoted install dir. Commands run through `sh -c` / `cmd /C`, and the
/// raw splice splits on the spaces install roots routinely contain
/// (`~/Library/Application Support/…`). A manifest that already wraps the
/// token (`"${ROOT}/x"`) loses that quote pair first so the substituted root
/// isn't double-quoted. Mirrors `bindPluginRootInCommand` in
/// `cli/src/hooks/plugin-hooks.ts`.
fn bind_command_root(command: &str, plugin_root: &str) -> String {
    let quoted = quote(plugin_root);
    let mut out = command.to_string();
    for token in PLUGIN_ROOT_TOKENS {
        for q in ['"', '\''] {
            let open = format!("{q}{token}");
            while let Some(start) = out.find(&open) {
                let span_start = start + open.len();
                let Some(rel_close) = out[span_start..].find(q) else {
                    break;
                };
                let span = &out[span_start..span_start + rel_close];
                // Only an unbroken path span counts as an enclosing pair — a
                // quote wrapping whitespace belongs to the command itself.
                if span
                    .chars()
                    .any(|c| c.is_whitespace() || c == '"' || c == '\'')
                {
                    break;
                }
                out.replace_range(
                    span_start + rel_close..span_start + rel_close + q.len_utf8(),
                    "",
                );
                out.replace_range(start..start + q.len_utf8(), "");
            }
        }
        out = out.replace(token, &quoted);
    }
    out
}

/// Bind plugin-root tokens across one event's groups. `hooks[].command`
/// strings get the shell-quoted root; every other field (matcher, env,
/// webhook urls, …) keeps the raw expansion.
fn bind_groups(groups: &[Value], plugin_root: &str) -> Vec<Value> {
    groups
        .iter()
        .map(|group| {
            let mut bound = group.clone();
            if let Some(hooks) = bound.get_mut("hooks").and_then(Value::as_array_mut) {
                for handler in hooks.iter_mut() {
                    if handler.get("type").and_then(Value::as_str) != Some("command") {
                        continue;
                    }
                    if let Some(Value::String(command)) = handler.get_mut("command") {
                        *command = bind_command_root(command, plugin_root);
                    }
                }
            }
            // Commands are already bound (quoted); the raw pass handles every
            // remaining token-bearing field without re-quoting them.
            replace_plugin_root_tokens(&bound, plugin_root)
        })
        .collect()
}

/// Locate + stat a plugin's manifest without reading it. Returns the resolved
/// path plus the `(mtime_ms, len)` pair the cache signature keys on.
fn manifest_meta(dir: &Path) -> Option<(PathBuf, u64, u64)> {
    MANIFEST_FILES.iter().find_map(|name| {
        let path = dir.join(name);
        let meta = std::fs::metadata(&path).ok()?;
        if !meta.is_file() {
            return None;
        }
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Some((path, mtime_ms, meta.len()))
    })
}

/// Merge every enabled plugin's `commandHooks` block under the user's groups.
/// Call BEFORE `builtin::apply_builtin_hooks` so the final order is
/// user → plugin → builtin.
pub fn apply_plugin_command_hooks(settings: &mut ClaudeSettings, runtime: &PluginRuntimeState) {
    let Some(plugin_hooks) = collect_command_hooks(runtime) else {
        return;
    };
    let merged = merge_builtin_under(settings.hooks.take(), plugin_hooks);
    settings.hooks = Some(merged);
}

/// Read and merge the `commandHooks` block of every ENABLED plugin whose
/// manifest declares the `command-hooks` capability. Returns `None` when no
/// plugin contributes — an absent contribution must not materialize an empty
/// `hooks` key on the settings. Plugins are applied in `plugin_id` order so
/// the merged group order is deterministic across processes.
///
/// The merged map is cached on `PluginRuntimeState` keyed on a signature of
/// the enabled ledger (plugin id + resolved manifest path + mtime + len), so
/// a dispatch with an unchanged ledger does one `stat` per enabled plugin
/// instead of a read + parse of every manifest. An enable/disable flip,
/// install, or manifest rewrite changes the signature and forces a recollect.
pub fn collect_command_hooks(runtime: &PluginRuntimeState) -> Option<Map<String, Value>> {
    // Snapshot under the lock, then do file IO outside it — reading a plugin
    // manifest off disk while holding the plugins lock would stall every
    // status flip behind a slow mount.
    let mut candidates: Vec<(String, PathBuf)> = runtime
        .plugins
        .read()
        .iter()
        .filter(|(_, record)| record.snapshot.status == "enabled")
        .map(|(id, record)| (id.clone(), PathBuf::from(&record.snapshot.install_path)))
        .collect();
    candidates.sort_by(|a, b| a.0.cmp(&b.0));

    // Resolve each candidate's manifest and stat it — the signature of this
    // list is the cache key, so a manifest rewrite invalidates on its own.
    let mut resolved: Vec<(String, PathBuf, PathBuf)> = Vec::with_capacity(candidates.len());
    let mut signature = String::new();
    for (plugin_id, install_path) in candidates {
        if let Some((manifest_path, mtime_ms, len)) = manifest_meta(&install_path) {
            signature.push_str(&format!(
                "\u{1f}{plugin_id}\u{1e}{}\u{1e}{mtime_ms}\u{1e}{len}",
                manifest_path.display()
            ));
            resolved.push((plugin_id, install_path, manifest_path));
        }
    }
    {
        let cache = runtime.command_hooks_cache.read();
        if let Some(cached) = cache.as_ref() {
            if cached.signature == signature {
                return cached.merged.clone();
            }
        }
    }

    let merged = collect_from_manifests(&resolved);
    *runtime.command_hooks_cache.write() = Some(crate::plugin_api::CachedCommandHooks {
        signature,
        merged: merged.clone(),
    });
    merged
}

fn collect_from_manifests(resolved: &[(String, PathBuf, PathBuf)]) -> Option<Map<String, Value>> {
    let mut merged = Map::new();
    for (plugin_id, install_path, manifest_path) in resolved {
        let manifest = match std::fs::read_to_string(manifest_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            Some(value) => value,
            None => {
                log::debug!(
                    "hooks: skipping plugin {plugin_id} — unreadable manifest at {}",
                    manifest_path.display()
                );
                continue;
            }
        };
        let declares_capability = manifest
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|caps| caps.iter().any(|c| c.as_str() == Some("command-hooks")));
        if !declares_capability {
            continue;
        }
        let Some(hooks) = manifest.get("commandHooks").and_then(Value::as_object) else {
            continue;
        };
        let root = install_path.to_string_lossy().into_owned();
        for (event, groups) in hooks {
            let Value::Array(src) = groups else {
                log::warn!("hooks: plugin {plugin_id} commandHooks[{event}] is not a group array");
                continue;
            };
            let bound_groups = bind_groups(src, &root);
            let entry = merged
                .entry(event.clone())
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Value::Array(dst) = entry {
                dst.extend(bound_groups);
            }
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn make_state(tmp: &TempDir) -> PluginRuntimeState {
        PluginRuntimeState::new(PathBuf::from(tmp.path()))
    }

    fn install_plugin(state: &PluginRuntimeState, id: &str, manifest: Value, status: &str) {
        install_plugin_file(state, id, manifest, status, "manifest.json")
    }

    /// Runtime installs write `manifest.json`; `plugin.json` covers the
    /// CLI/source layout. The collector must accept both.
    fn install_plugin_file(
        state: &PluginRuntimeState,
        id: &str,
        manifest: Value,
        status: &str,
        filename: &str,
    ) {
        let dir = state.plugin_dir(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(filename),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        crate::plugin_api::lifecycle::plugin_set_status_for_state(
            state,
            id.to_string(),
            status.to_string(),
        )
        .unwrap();
    }

    fn hook_manifest(command_hooks: Value) -> Value {
        json!({
            "id": "x",
            "name": "x",
            "version": "1.0.0",
            "capabilities": ["command-hooks"],
            "commandHooks": command_hooks,
        })
    }

    #[test]
    fn enabled_plugin_command_hooks_merge_with_root_tokens_bound() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        install_plugin(
            &state,
            "guard",
            hook_manifest(json!({
                "PreToolUse": [{
                    "matcher": "Bash",
                    "hooks": [{
                        "type": "command",
                        "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs",
                        "async": true
                    }]
                }]
            })),
            "enabled",
        );

        let merged = collect_command_hooks(&state).unwrap();
        let groups = merged["PreToolUse"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        let command = groups[0]["hooks"][0]["command"].as_str().unwrap();
        let dir = tmp.path().join("guard");
        assert_eq!(
            command,
            format!("node {}/hooks/guard.mjs", quote(&dir.to_string_lossy()))
        );
        assert!(!command.contains("${CLAUDE_PLUGIN_ROOT}"));
        assert_eq!(groups[0]["hooks"][0]["async"], json!(true));
    }

    #[test]
    fn cli_layout_plugin_json_manifest_is_accepted() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        install_plugin_file(
            &state,
            "src",
            hook_manifest(json!({
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo ok" }] }]
            })),
            "enabled",
            "plugin.json",
        );
        let merged = collect_command_hooks(&state).unwrap();
        assert_eq!(merged["SessionStart"].as_array().unwrap().len(), 1);
    }

    /// Insert a record whose `install_path` doesn't come from `plugin_dir` —
    /// needed when the test needs a path the sanitizer would strip (spaces).
    fn install_plugin_at(
        state: &PluginRuntimeState,
        id: &str,
        dir: &Path,
        manifest: Value,
        status: &str,
    ) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        state.plugins.write().insert(
            id.to_string(),
            crate::plugin_api::PluginRecord {
                snapshot: crate::plugin_api::PluginRuntimeSnapshot {
                    plugin_id: id.to_string(),
                    version: "1.0.0".into(),
                    status: status.to_string(),
                    last_error: None,
                    loaded_at: None,
                    install_path: dir.to_string_lossy().into_owned(),
                },
                runtime_state: Value::Null,
            },
        );
    }

    #[test]
    fn command_root_is_shell_quoted_and_manifest_quote_pairs_unwrapped() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // A space in the install path exercises the quoting end to end.
        let dir = tmp.path().join("sp ace");
        install_plugin_at(
            &state,
            "guard",
            &dir,
            hook_manifest(json!({
                "SessionStart": [{ "hooks": [
                    { "type": "command", "command": "node ${COGNIA_PLUGIN_ROOT}/a.mjs" },
                    { "type": "command", "command": "node \"${COGNIA_PLUGIN_ROOT}/b.mjs\"" },
                    { "type": "command", "command": "echo '${COGNIA_PLUGIN_ROOT}/c'" }
                ] }]
            })),
            "enabled",
        );
        let merged = collect_command_hooks(&state).unwrap();
        let handlers = merged["SessionStart"][0]["hooks"].as_array().unwrap();
        let quoted = quote(&dir.to_string_lossy());
        for (handler, suffix) in handlers.iter().zip(["/a.mjs", "/b.mjs", "/c"]) {
            // `ends_with` — the quoted root itself contains a space, so the
            // command can't be word-split for the assertion.
            let command = handler["command"].as_str().unwrap();
            assert!(command.ends_with(&format!("{quoted}{suffix}")), "{command}");
            assert!(!command.contains("\"\""));
        }
    }

    #[test]
    fn disabled_plugins_and_undeclared_capability_contribute_nothing() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        install_plugin(
            &state,
            "off",
            hook_manifest(json!({
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo no" }] }]
            })),
            "disabled",
        );
        // Enabled but missing the capability declaration — the field alone is inert.
        install_plugin(
            &state,
            "nocap",
            json!({
                "id": "nocap",
                "capabilities": ["skills"],
                "commandHooks": {
                    "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo no" }] }]
                }
            }),
            "enabled",
        );
        assert!(collect_command_hooks(&state).is_none());
    }

    #[test]
    fn apply_merges_under_user_groups_and_leaves_builtin_room() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        install_plugin(
            &state,
            "plug",
            hook_manifest(json!({
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo plugin" }] }]
            })),
            "enabled",
        );

        let mut settings = ClaudeSettings::default();
        settings.hooks = Some(json!({
            "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo user" }] }]
        }));
        apply_plugin_command_hooks(&mut settings, &state);

        let groups = settings.hooks.unwrap()["SessionStart"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["hooks"][0]["command"], json!("echo user"));
        assert_eq!(groups[1]["hooks"][0]["command"], json!("echo plugin"));
    }

    #[test]
    fn malformed_plugin_hook_shapes_are_skipped_not_fatal() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        install_plugin(
            &state,
            "bad",
            hook_manifest(json!({
                "PreToolUse": "not-an-array",
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo ok" }] }]
            })),
            "enabled",
        );
        let merged = collect_command_hooks(&state).unwrap();
        assert!(merged.get("PreToolUse").is_none());
        assert_eq!(merged["SessionStart"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn cache_hit_skips_manifest_io_until_ledger_or_file_changes() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        install_plugin(
            &state,
            "guard",
            hook_manifest(json!({
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo a" }] }]
            })),
            "enabled",
        );
        let first = collect_command_hooks(&state).unwrap();
        assert_eq!(
            first["SessionStart"][0]["hooks"][0]["command"],
            json!("echo a")
        );

        // Second dispatch with an untouched ledger reuses the merge — on unix
        // prove it by making the manifest unreadable: a stat still resolves
        // (mtime/len intact → same signature), so the cached value returns
        // instead of re-reading.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let manifest = state.plugin_dir("guard").join("manifest.json");
            std::fs::set_permissions(&manifest, std::fs::Permissions::from_mode(0o000)).unwrap();
            assert!(collect_command_hooks(&state).is_some());
            std::fs::set_permissions(&manifest, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        #[cfg(not(unix))]
        assert_eq!(
            collect_command_hooks(&state).unwrap()["SessionStart"][0]["hooks"][0]["command"],
            json!("echo a")
        );

        // A manifest rewrite changes the signature (len here) → recollect
        // picks it up.
        std::fs::write(
            state.plugin_dir("guard").join("manifest.json"),
            serde_json::to_string(&hook_manifest(json!({
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo bb" }] }]
            })))
            .unwrap(),
        )
        .unwrap();
        let second = collect_command_hooks(&state).unwrap();
        assert_eq!(
            second["SessionStart"][0]["hooks"][0]["command"],
            json!("echo bb")
        );

        // A status flip changes the enabled ledger → the plugin drops out.
        crate::plugin_api::lifecycle::plugin_set_status_for_state(
            &state,
            "guard".into(),
            "disabled".into(),
        )
        .unwrap();
        assert!(collect_command_hooks(&state).is_none());
    }
}
