//! Codex CLI hooks integration — `~/.codex/hooks.json`.
//!
//! This supersedes the `notify` integration in [`super::codex`], which never
//! produced a single fleet row. The shipped `notify` payload identifies its
//! session with `thread-id`; the registry only accepted `session_id`, so every
//! event was dropped at the door while the settings card reported a healthy
//! install. `notify` is also turn-complete-only: no tool activity, no
//! permission gate, no session end.
//!
//! Codex's hooks system is event-for-event congruent with Claude Code's — same
//! entry shape, same JSON-on-stdin / decision-JSON-on-stdout contract — so we
//! install the *same* generated forwarder script
//! ([`super::install::hook_forwarder_script`]) with `agent: "codex"`.
//!
//! Two field-verified constraints shape this module (checked 2026-07-21
//! against `@openai/codex 0.144.4`):
//!
//! 1. **`hooks.json` is shared territory.** On a real machine it is already
//!    populated by other tools (a third-party agent-overlay app was found
//!    owning every event on the dev machine). Codex runs *all* matching hooks,
//!    so we merge our handler into each event's list and remove only our own
//!    on uninstall. Clobbering the file would silently break another product.
//!
//! 2. **Hooks are gated behind a persisted trust the user grants in the TUI**
//!    (`codex --help` documents `--dangerously-bypass-hook-trust`; the binary
//!    carries `HookStateToml { trusted_hash }` keyed by hook *content*).
//!    That trust is internal to Codex — it is not readable from any config
//!    file — so this module can never report "installed and firing" from disk
//!    alone. [`CodexHooksStatus::Installed`] means *written*, and liveness is
//!    proven separately by observed ingress traffic. Writing the file and
//!    calling it done would recreate the exact failure this integration is
//!    fixing. Because the trust hash is content-keyed, editing our command
//!    line also revokes trust — so [`CodexHooksStatus::Stale`] (our handler
//!    present but with a different command) is a state the UI must surface.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Map, Value};

const EDIT_RETRIES: usize = 4;
static HOOKS_FILE_LOCK: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Events we register. Verified present in a live `~/.codex/hooks.json` and in
/// the shipped binary's `HookEventsToml`. Current Codex exposes SessionEnd and
/// SubagentStart; Notification, StopFailure, and PermissionDenied remain absent. The manifest in
/// [`super::integrations`] deliberately omits them rather than registering
/// hooks that would never fire.
///
/// The second field is the forwarder's `$2` mode: `wait` makes the hook block
/// on our long-poll so the island can answer it; everything else is
/// fire-and-forget.
pub const CODEX_HOOK_EVENTS: &[(&str, HookMode)] = &[
    ("SessionStart", HookMode::Fire),
    ("UserPromptSubmit", HookMode::Fire),
    ("PreToolUse", HookMode::Fire),
    ("PostToolUse", HookMode::Fire),
    ("PermissionRequest", HookMode::Wait),
    ("Stop", HookMode::Fire),
    ("SessionEnd", HookMode::Fire),
    ("SubagentStart", HookMode::Fire),
    ("SubagentStop", HookMode::Fire),
    ("PreCompact", HookMode::Fire),
    ("PostCompact", HookMode::Fire),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookMode {
    Fire,
    Wait,
}

impl HookMode {
    fn arg(self) -> &'static str {
        match self {
            HookMode::Fire => "fire",
            HookMode::Wait => "wait",
        }
    }

    /// Per-hook timeout in seconds. The blocking gate must outlive the island's
    /// answer window and the forwarder's own curl budget, in that order —
    /// island 20s < curl 25s < hook timeout. A fire-and-forget hook sits on the
    /// agent's critical path, so it gets the smallest workable budget.
    fn timeout_secs(self) -> u64 {
        match self {
            HookMode::Fire => 5,
            HookMode::Wait => 30,
        }
    }
}

/// `~/.codex/hooks.json`. `None` when there is no home dir.
pub fn codex_hooks_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("hooks.json"))
}

/// `~/.codex`. Its absence means Codex isn't installed.
pub fn codex_home() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex"))
}

pub fn codex_hook_script_path_at(base: &Path) -> PathBuf {
    super::install::hook_script_path_at(base, "codex")
}

pub fn codex_hook_script_path() -> Option<PathBuf> {
    crate::agents::paths::cognia_home().map(|home| codex_hook_script_path_at(&home))
}

/// Install state of the Codex hooks integration.
///
/// Deliberately says nothing about whether hooks are *trusted* — that lives
/// inside Codex and is unreadable here. A caller renders "waiting for the first
/// event" from observed ingress traffic, not from this enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexHooksStatus {
    /// Our handler is registered for every event with the current command.
    Installed,
    /// Our handler is present but its command differs from what we generate
    /// now (or it covers only some events). Codex keys hook trust by content,
    /// so a drifted command is also an *untrusted* command — it will not fire
    /// until re-approved. Reinstall to refresh.
    Stale,
    /// `~/.codex` exists but none of our handlers are registered.
    NotInstalled,
    /// No `~/.codex` — Codex isn't installed.
    Unavailable,
}

/// The command line one of our handlers runs, for a given script path + mode.
fn handler_command(script: &str, event: &str, mode: HookMode) -> String {
    format!("{} {event} {}", shell_quote(script), mode.arg())
}

/// Quote one shell argument with the portable POSIX single-quote form. Codex
/// executes hook commands through a shell, and Cognia's data path may contain
/// spaces or apostrophes.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn command_invokes(command: &str, prefix: &str) -> bool {
    command
        .strip_prefix(prefix)
        .is_some_and(|rest| rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace))
}

/// Whether a handler entry is ours — identified by the generated script path,
/// which lives under our own `agent-monitor/` directory and so cannot collide
/// with another product's hook.
fn is_ours(command: &str, script: &str) -> bool {
    command_invokes(command, &shell_quote(script)) || command_invokes(command, script)
}

/// Pure editor: merge our handlers into an existing `hooks.json` document,
/// returning the new document. Foreign handlers on the same events are
/// preserved (Codex runs every matching hook), and a previous version of our
/// own handler is replaced rather than duplicated.
pub fn merge_our_hooks(existing: &Value, script: &str) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    for (event, mode) in CODEX_HOOK_EVENTS {
        let mut groups: Vec<Value> = hooks
            .get(*event)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // Drop any prior incarnation of our handler (including whole groups
        // that contained only ours) so reinstall is idempotent.
        groups.retain_mut(|group| {
            let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            list.retain(|h| {
                !h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| is_ours(c, script))
            });
            !list.is_empty()
        });
        groups.push(json!({
            "hooks": [{
                "type": "command",
                "command": handler_command(script, event, *mode),
                "timeout": mode.timeout_secs(),
            }]
        }));
        hooks.insert((*event).to_string(), Value::Array(groups));
    }

    root.insert("hooks".to_string(), Value::Object(hooks));
    Value::Object(root)
}

/// Pure editor: strip our handlers, leaving every foreign one untouched.
/// Returns `None` when nothing of ours was present.
pub fn remove_our_hooks(existing: &Value, script: &str) -> Option<Value> {
    let mut root = existing.as_object().cloned()?;
    let mut hooks = root.get("hooks").and_then(Value::as_object).cloned()?;
    let mut removed = false;

    let events: Vec<String> = hooks.keys().cloned().collect();
    for event in events {
        let Some(groups) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
            continue;
        };
        groups.retain_mut(|group| {
            let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let before = list.len();
            list.retain(|h| {
                !h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| is_ours(c, script))
            });
            if list.len() != before {
                removed = true;
            }
            !list.is_empty()
        });
        if groups.is_empty() {
            hooks.remove(&event);
        }
    }

    if !removed {
        return None;
    }
    if hooks.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".to_string(), Value::Object(hooks));
    }
    Some(Value::Object(root))
}

/// Pure classifier over the parsed document.
pub fn classify(
    existing: Option<&Value>,
    codex_home_exists: bool,
    script: &str,
) -> CodexHooksStatus {
    if !codex_home_exists {
        return CodexHooksStatus::Unavailable;
    }
    let Some(doc) = existing else {
        return CodexHooksStatus::NotInstalled;
    };
    let Some(hooks) = doc.get("hooks").and_then(Value::as_object) else {
        return CodexHooksStatus::NotInstalled;
    };

    let mut found_any = false;
    let mut all_current = true;
    for (event, mode) in CODEX_HOOK_EVENTS {
        let want = handler_command(script, event, *mode);
        let commands = our_commands_for(hooks, event, script);
        if commands.is_empty() {
            all_current = false;
        } else {
            found_any = true;
            if !commands.iter().any(|c| c == &want) {
                all_current = false;
            }
        }
    }

    match (found_any, all_current) {
        (false, _) => CodexHooksStatus::NotInstalled,
        (true, true) => CodexHooksStatus::Installed,
        (true, false) => CodexHooksStatus::Stale,
    }
}

fn our_commands_for(hooks: &Map<String, Value>, event: &str, script: &str) -> Vec<String> {
    hooks
        .get(event)
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .filter_map(|g| g.get("hooks").and_then(Value::as_array))
                .flatten()
                .filter_map(|h| h.get("command").and_then(Value::as_str))
                .filter(|c| is_ours(c, script))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Filesystem + command layer
// ---------------------------------------------------------------------------

/// Read and parse `hooks.json`. `Ok(None)` when the file is absent; an
/// unparseable file is an error rather than a silent "not installed", so a
/// corrupt file can never be reported as a healthy state.
fn read_hooks_raw_at(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn parse_hooks(raw: Option<&str>) -> Result<Option<Value>, String> {
    match raw {
        Some(raw) if raw.trim().is_empty() => Ok(None),
        Some(raw) => serde_json::from_str(raw)
            .map(Some)
            .map_err(|e| format!("codex hooks.json parse: {e}")),
        None => Ok(None),
    }
}

fn read_hooks_at(path: &Path) -> Result<Option<Value>, String> {
    let raw = read_hooks_raw_at(path)?;
    parse_hooks(raw.as_deref())
}

/// Atomically replace `hooks.json` only when it still has the exact bytes we
/// read. This optimistic check preserves edits made by other hook managers;
/// callers retry from the new document instead of overwriting it.
fn write_hooks_if_unchanged(
    path: &Path,
    expected: Option<&str>,
    doc: &Value,
) -> Result<bool, String> {
    let current = read_hooks_raw_at(path)?;
    if current.as_deref() != expected {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("hooks.json");
    let tmp = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    if let Err(error) = std::fs::write(&tmp, body.as_bytes()) {
        return Err(error.to_string());
    }
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    Ok(true)
}

fn install_at(hooks_path: &Path, script: &Path) -> Result<CodexHooksStatus, String> {
    let script_str = script.to_string_lossy().to_string();
    for _ in 0..EDIT_RETRIES {
        let raw = read_hooks_raw_at(hooks_path)?;
        let existing = parse_hooks(raw.as_deref())?.unwrap_or_else(|| json!({}));
        let merged = merge_our_hooks(&existing, &script_str);
        if write_hooks_if_unchanged(hooks_path, raw.as_deref(), &merged)? {
            return Ok(classify(Some(&merged), true, &script_str));
        }
    }
    Err("codex hooks.json changed repeatedly while installing; retry".to_string())
}

fn uninstall_at(hooks_path: &Path, script: &Path) -> Result<(), String> {
    let script_str = script.to_string_lossy().to_string();
    for _ in 0..EDIT_RETRIES {
        let raw = read_hooks_raw_at(hooks_path)?;
        let Some(existing) = parse_hooks(raw.as_deref())? else {
            return Ok(());
        };
        let Some(cleaned) = remove_our_hooks(&existing, &script_str) else {
            return Ok(());
        };
        if write_hooks_if_unchanged(hooks_path, raw.as_deref(), &cleaned)? {
            return Ok(());
        }
    }
    Err("codex hooks.json changed repeatedly while uninstalling; retry".to_string())
}

fn status_at(hooks_path: &Path, codex_home: &Path, script: &Path) -> CodexHooksStatus {
    let script_str = script.to_string_lossy().to_string();
    match read_hooks_at(hooks_path) {
        Ok(doc) => classify(doc.as_ref(), codex_home.is_dir(), &script_str),
        // Unparseable: we cannot claim ownership, but Codex is clearly present.
        Err(_) if codex_home.is_dir() => CodexHooksStatus::NotInstalled,
        Err(_) => CodexHooksStatus::Unavailable,
    }
}

fn paths() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let hooks = codex_hooks_path().ok_or_else(|| "no home directory".to_string())?;
    let home = codex_home().ok_or_else(|| "no home directory".to_string())?;
    let script = codex_hook_script_path().ok_or_else(|| "no cognia home".to_string())?;
    Ok((hooks, home, script))
}

/// Write the forwarder script and register our handlers in `~/.codex/hooks.json`.
///
/// The returned status reports what is *written*, never whether Codex will
/// actually run it: hooks stay inert until the user grants trust in the Codex
/// TUI, and that trust is not readable from disk. Callers must surface
/// "waiting for the first event" from observed ingress traffic.
#[tauri::command]
pub async fn fleet_codex_hooks_install() -> Result<CodexHooksStatus, String> {
    tokio::task::spawn_blocking(|| {
        let _guard = HOOKS_FILE_LOCK
            .lock()
            .map_err(|_| "codex hooks lock poisoned".to_string())?;
        let (hooks, home, script) = paths()?;
        if !home.is_dir() {
            return Ok(CodexHooksStatus::Unavailable);
        }
        if let Some(parent) = script.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let contents =
            super::install::hook_forwarder_script("codex", super::terminal::CAPTURED_ENV_VARS);
        std::fs::write(&script, contents.as_bytes()).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        install_at(&hooks, &script)
    })
    .await
    .map_err(|e| format!("codex hooks install task: {e}"))?
}

/// Remove our handlers (leaving every foreign one) and delete the script.
#[tauri::command]
pub async fn fleet_codex_hooks_uninstall() -> Result<CodexHooksStatus, String> {
    tokio::task::spawn_blocking(|| {
        let _guard = HOOKS_FILE_LOCK
            .lock()
            .map_err(|_| "codex hooks lock poisoned".to_string())?;
        let (hooks, home, script) = paths()?;
        uninstall_at(&hooks, &script)?;
        match std::fs::remove_file(&script) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        Ok(status_at(&hooks, &home, &script))
    })
    .await
    .map_err(|e| format!("codex hooks uninstall task: {e}"))?
}

#[tauri::command]
pub async fn fleet_codex_hooks_status() -> Result<CodexHooksStatus, String> {
    tokio::task::spawn_blocking(|| {
        let _guard = HOOKS_FILE_LOCK
            .lock()
            .map_err(|_| "codex hooks lock poisoned".to_string())?;
        let (hooks, home, script) = paths()?;
        Ok(status_at(&hooks, &home, &script))
    })
    .await
    .map_err(|e| format!("codex hooks status task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = "/Users/x/.cognia/agent-monitor/codex-hook.sh";

    /// A real `hooks.json` found in the wild: another agent-overlay product
    /// owning several events. Merging must not disturb it.
    fn foreign_doc() -> Value {
        json!({
            "hooks": {
                "SessionStart": [{
                    "hooks": [{
                        "type": "command",
                        "command": "'/Applications/Other.app/bin/other-hooks' --source codex",
                        "timeout": 5
                    }]
                }],
                "PostToolUse": [
                    {
                        "hooks": [{
                            "type": "command",
                            "command": "'/Applications/Other.app/bin/other-hooks' --source codex",
                            "timeout": 5
                        }]
                    },
                    {
                        "matcher": ".*",
                        "hooks": [{
                            "type": "command",
                            "command": "'/Applications/Other.app/bin/other-report' codex postToolUse",
                            "timeout": 30
                        }]
                    }
                ]
            }
        })
    }

    fn commands(doc: &Value, event: &str) -> Vec<String> {
        doc["hooks"][event]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|g| g.get("hooks").and_then(Value::as_array))
            .flatten()
            .filter_map(|h| h["command"].as_str())
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn merge_registers_every_event() {
        let merged = merge_our_hooks(&json!({}), SCRIPT);
        for (event, _) in CODEX_HOOK_EVENTS {
            assert!(
                commands(&merged, event).iter().any(|c| is_ours(c, SCRIPT)),
                "missing handler for {event}"
            );
        }
    }

    /// The load-bearing property: `hooks.json` belongs to whoever else is
    /// already using it. Clobbering it would silently break another product.
    #[test]
    fn merge_preserves_foreign_handlers() {
        let merged = merge_our_hooks(&foreign_doc(), SCRIPT);
        let start = commands(&merged, "SessionStart");
        assert!(start.iter().any(|c| c.contains("other-hooks")));
        assert!(start.iter().any(|c| is_ours(c, SCRIPT)));
        // Both foreign PostToolUse groups (including the `matcher` one) survive.
        let post = commands(&merged, "PostToolUse");
        assert!(post.iter().any(|c| c.contains("other-hooks")));
        assert!(post.iter().any(|c| c.contains("other-report")));
        assert!(post.iter().any(|c| is_ours(c, SCRIPT)));
        // The foreign group's `matcher` key is not rewritten.
        let matchers: Vec<_> = merged["hooks"]["PostToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|g| g.get("matcher").and_then(Value::as_str))
            .collect();
        assert_eq!(matchers, vec![".*"]);
    }

    #[test]
    fn merge_is_idempotent() {
        let once = merge_our_hooks(&foreign_doc(), SCRIPT);
        let twice = merge_our_hooks(&once, SCRIPT);
        assert_eq!(once, twice);
        for (event, _) in CODEX_HOOK_EVENTS {
            let ours: Vec<_> = commands(&twice, event)
                .into_iter()
                .filter(|c| is_ours(c, SCRIPT))
                .collect();
            assert_eq!(ours.len(), 1, "duplicate handler for {event}");
        }
    }

    /// A drifted command (older Cognia, different mode) is replaced, not
    /// duplicated — and since Codex keys hook trust by content, leaving both
    /// would leave an untrusted stale entry behind forever.
    #[test]
    fn merge_replaces_a_drifted_handler_of_ours() {
        let stale = json!({
            "hooks": { "PreToolUse": [{ "hooks": [{
                "type": "command",
                "command": format!("{SCRIPT} PreToolUse legacy-mode"),
                "timeout": 5
            }]}]}
        });
        let merged = merge_our_hooks(&stale, SCRIPT);
        let ours: Vec<_> = commands(&merged, "PreToolUse")
            .into_iter()
            .filter(|c| is_ours(c, SCRIPT))
            .collect();
        assert_eq!(
            ours,
            vec![handler_command(SCRIPT, "PreToolUse", HookMode::Fire)]
        );
    }

    #[test]
    fn permission_request_blocks_and_outlives_the_island_window() {
        let merged = merge_our_hooks(&json!({}), SCRIPT);
        let perm = &merged["hooks"]["PermissionRequest"][0]["hooks"][0];
        assert_eq!(
            perm["command"].as_str().unwrap(),
            handler_command(SCRIPT, "PermissionRequest", HookMode::Wait)
        );
        // island 20s < curl 25s < hook timeout — the ladder that guarantees a
        // permission prompt can never wedge the user's terminal.
        let hook_timeout = perm["timeout"].as_u64().unwrap();
        assert!(hook_timeout * 1000 > super::super::PERMISSION_WAIT_MS);
        assert!(hook_timeout > 25);
    }

    #[test]
    fn only_permission_request_waits() {
        for (event, mode) in CODEX_HOOK_EVENTS {
            assert_eq!(
                *mode == HookMode::Wait,
                *event == "PermissionRequest",
                "{event} has the wrong mode"
            );
        }
    }

    #[test]
    fn remove_strips_only_ours() {
        let merged = merge_our_hooks(&foreign_doc(), SCRIPT);
        let cleaned = remove_our_hooks(&merged, SCRIPT).expect("ours was present");
        for (event, _) in CODEX_HOOK_EVENTS {
            let ours: usize = cleaned["hooks"]
                .get(event)
                .and_then(Value::as_array)
                .map(|groups| {
                    groups
                        .iter()
                        .filter_map(|g| g.get("hooks").and_then(Value::as_array))
                        .flatten()
                        .filter_map(|h| h["command"].as_str())
                        .filter(|c| is_ours(c, SCRIPT))
                        .count()
                })
                .unwrap_or(0);
            assert_eq!(ours, 0, "our handler survived on {event}");
        }
        // Every foreign handler is intact.
        assert!(commands(&cleaned, "SessionStart")
            .iter()
            .any(|c| c.contains("other-hooks")));
        assert_eq!(commands(&cleaned, "PostToolUse").len(), 2);
    }

    /// Uninstalling from a file that only ever held our handlers leaves no
    /// empty scaffolding behind.
    #[test]
    fn remove_cleans_up_empty_events_and_the_hooks_key() {
        let merged = merge_our_hooks(&json!({}), SCRIPT);
        let cleaned = remove_our_hooks(&merged, SCRIPT).unwrap();
        assert!(cleaned.get("hooks").is_none(), "left empty scaffolding");
    }

    #[test]
    fn remove_reports_nothing_to_do() {
        assert!(remove_our_hooks(&foreign_doc(), SCRIPT).is_none());
        assert!(remove_our_hooks(&json!({}), SCRIPT).is_none());
    }

    #[test]
    fn classify_covers_each_state() {
        assert_eq!(
            classify(None, false, SCRIPT),
            CodexHooksStatus::Unavailable,
            "no ~/.codex"
        );
        assert_eq!(classify(None, true, SCRIPT), CodexHooksStatus::NotInstalled);
        assert_eq!(
            classify(Some(&foreign_doc()), true, SCRIPT),
            CodexHooksStatus::NotInstalled,
            "someone else's hooks are not ours"
        );
        let merged = merge_our_hooks(&foreign_doc(), SCRIPT);
        assert_eq!(
            classify(Some(&merged), true, SCRIPT),
            CodexHooksStatus::Installed
        );
    }

    /// Partial coverage reads as `Stale`, not `Installed` — a half-registered
    /// integration that silently misses `PermissionRequest` is precisely the
    /// class of failure this rewrite exists to end.
    #[test]
    fn partial_registration_is_stale_not_installed() {
        let mut merged = merge_our_hooks(&json!({}), SCRIPT);
        merged["hooks"]
            .as_object_mut()
            .unwrap()
            .remove("PermissionRequest");
        assert_eq!(
            classify(Some(&merged), true, SCRIPT),
            CodexHooksStatus::Stale
        );
    }

    /// End-to-end on disk, starting from a file another product already owns —
    /// the real-world starting state on a machine with Codex installed.
    #[test]
    fn install_uninstall_round_trip_preserves_a_foreign_file() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = dir.path().join("hooks.json");
        let script = dir.path().join("agent-monitor").join("codex-hook.sh");
        let before = serde_json::to_string_pretty(&foreign_doc()).unwrap();
        std::fs::write(&hooks, &before).unwrap();

        assert_eq!(
            install_at(&hooks, &script).unwrap(),
            CodexHooksStatus::Installed
        );
        assert_eq!(
            status_at(&hooks, dir.path(), &script),
            CodexHooksStatus::Installed
        );

        uninstall_at(&hooks, &script).unwrap();
        assert_eq!(
            status_at(&hooks, dir.path(), &script),
            CodexHooksStatus::NotInstalled
        );
        // The foreign product's configuration is byte-for-byte what it was.
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&hooks).unwrap()).unwrap();
        assert_eq!(after, foreign_doc());
    }

    #[test]
    fn install_creates_the_file_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = dir.path().join("hooks.json");
        let script = dir.path().join("codex-hook.sh");
        assert_eq!(
            status_at(&hooks, dir.path(), &script),
            CodexHooksStatus::NotInstalled
        );
        assert_eq!(
            install_at(&hooks, &script).unwrap(),
            CodexHooksStatus::Installed
        );
        assert!(hooks.is_file());
    }

    #[test]
    fn command_quotes_paths_with_spaces_and_apostrophes() {
        let script = "/Users/O'Brien/Cognia Data/codex-hook.sh";
        let command = handler_command(script, "SessionStart", HookMode::Fire);

        assert_eq!(
            command,
            "'/Users/O'\"'\"'Brien/Cognia Data/codex-hook.sh' SessionStart fire"
        );
        assert!(is_ours(&command, script));
        assert!(!is_ours(
            &format!("{}-other SessionStart fire", shell_quote(script)),
            script
        ));
    }

    #[test]
    fn optimistic_write_preserves_a_concurrent_external_edit() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = dir.path().join("hooks.json");
        let original = serde_json::to_string_pretty(&foreign_doc()).unwrap();
        std::fs::write(&hooks, &original).unwrap();

        let external = json!({"hooks": {}, "externalRevision": 2});
        std::fs::write(&hooks, serde_json::to_string_pretty(&external).unwrap()).unwrap();

        assert!(!write_hooks_if_unchanged(&hooks, Some(&original), &json!({})).unwrap());
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&hooks).unwrap()).unwrap();
        assert_eq!(after, external);
    }

    /// A corrupt `hooks.json` must never read as a healthy install, and must
    /// not be silently overwritten.
    #[test]
    fn unparseable_file_is_not_reported_as_installed() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = dir.path().join("hooks.json");
        let script = dir.path().join("codex-hook.sh");
        std::fs::write(&hooks, "{ not json").unwrap();
        assert!(read_hooks_at(&hooks).is_err());
        assert_eq!(
            status_at(&hooks, dir.path(), &script),
            CodexHooksStatus::NotInstalled
        );
        assert!(install_at(&hooks, &script).is_err());
        assert_eq!(std::fs::read_to_string(&hooks).unwrap(), "{ not json");
    }

    /// Missing `~/.codex` means Codex isn't installed — reported as such rather
    /// than as an install failure.
    #[test]
    fn absent_codex_home_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-such-codex");
        assert_eq!(
            status_at(
                &missing.join("hooks.json"),
                &missing,
                &dir.path().join("s.sh")
            ),
            CodexHooksStatus::Unavailable
        );
    }

    /// A drifted command is also an *untrusted* command (Codex keys trust by
    /// content), so it must not read as a healthy install.
    #[test]
    fn drifted_command_is_stale() {
        let doc = json!({
            "hooks": { "SessionStart": [{ "hooks": [{
                "type": "command",
                "command": format!("{SCRIPT} SessionStart ancient"),
                "timeout": 5
            }]}]}
        });
        assert_eq!(classify(Some(&doc), true, SCRIPT), CodexHooksStatus::Stale);
    }
}
