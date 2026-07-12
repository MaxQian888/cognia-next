//! Fleet hook-script + monitor-config file management.
//!
//! This module owns ONLY the files under `~/.cognia/` (the monitor config the
//! hook scripts read, and the generated scripts themselves). Edits to agent
//! config files (`~/.claude/settings.json`, `~/.codex/config.toml`,
//! `~/.config/opencode/plugins/…`) deliberately live elsewhere: the Claude
//! hooks block is written by the TS side through `lib/claude/settings.ts`
//! (the single settings.json writer), and Codex/OpenCode files go through the
//! `agents::io` format-preserving writer. See the ADR/plan "Hook installation"
//! section.
//!
//! Every function has a pure `*_at(base)` core taking the cognia home dir so
//! tests run against a tempdir without mutating `COGNIA_HOME` (env mutation
//! races across parallel test threads — same trap as `proxy_config`).

use std::io::Write as _;
use std::path::{Path, PathBuf};

use crate::fs_atomic::{atomic_write_with_mtime_check, AtomicWritePlan};

/// Marker header stamped on every generated artifact so status checks can
/// distinguish "ours" from user-modified files. Bump the version when the
/// script contract changes; `fleet_scripts_status` reports stale versions.
pub const MANAGED_MARKER: &str = "cognia-fleet v1 — managed by Cognia, do not edit";

fn cognia_home() -> Result<PathBuf, String> {
    crate::agents::paths::cognia_home().ok_or_else(|| "no home directory".to_string())
}

/// `<cognia-home>/agent-monitor.json` — port + token the hook scripts read.
pub fn monitor_config_path() -> Option<PathBuf> {
    crate::agents::paths::cognia_home().map(|home| home.join("agent-monitor.json"))
}

fn monitor_config_path_at(base: &Path) -> PathBuf {
    base.join("agent-monitor.json")
}

fn claude_hook_script_path_at(base: &Path) -> PathBuf {
    base.join("agent-monitor").join("claude-hook.sh")
}

pub fn claude_hook_script_path() -> Option<PathBuf> {
    crate::agents::paths::cognia_home().map(|home| claude_hook_script_path_at(&home))
}

/// Write `agent-monitor.json` atomically with owner-only permissions.
/// Returns the config path.
pub fn write_monitor_config(port: u16, token: &str) -> Result<PathBuf, String> {
    write_monitor_config_at(&cognia_home()?, port, token)
}

fn write_monitor_config_at(base: &Path, port: u16, token: &str) -> Result<PathBuf, String> {
    let path = monitor_config_path_at(base);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::json!({
        "version": 1,
        "port": port,
        "token": token,
    });
    let contents = serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?;

    atomic_write_with_mtime_check(
        &AtomicWritePlan {
            path: path.clone(),
            // Rewritten wholesale on every monitor start — last writer wins.
            expected_mtime: None,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        },
        &contents,
    )
    .map_err(|e| e.to_string())?;

    restrict_permissions(&path)?;
    Ok(path)
}

/// Remove the monitor config so installed hook scripts fast-exit (their first
/// line checks the file exists). Missing file is fine.
pub fn remove_monitor_config() -> Result<(), String> {
    remove_monitor_config_at(&cognia_home()?)
}

fn remove_monitor_config_at(base: &Path) -> Result<(), String> {
    let path = monitor_config_path_at(base);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Token + config live at 0600: the token authenticates loopback POSTs, so
/// other local users must not read it. No-op off unix.
fn restrict_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// The Claude Code hook forwarder. POSIX sh + curl: ~10 ms overhead per hook
/// invocation, no Node cold-start on the agent's critical path.
///
/// Contract (mirrors the settings.json entries built by
/// `lib/claude/hooks/fleet-hooks.ts`):
/// - `$1` — hook event name (passed as an arg by the catalog's command line).
/// - `$2` — `wait` for the PermissionRequest long-poll, else fire-and-forget.
/// - stdin — the raw hook JSON payload.
/// - stdout — echoed decision JSON in `wait` mode; nothing otherwise.
/// - Always exits 0 (fail-open: a dead/stopped Cognia never blocks the agent).
pub fn claude_hook_script(env_vars: &[&str]) -> String {
    // Build the `\"K\":\"$(esc "$K")\"` env-capture pairs. The whole ENVJSON
    // assignment is a double-quoted sh string, so JSON quotes must be
    // backslash-escaped to survive as literals while `$(esc …)` still
    // expands. Values run through a tiny JSON escaper so a `"` or `\` in an
    // env value can't break the body.
    let env_pairs = env_vars
        .iter()
        .map(|k| format!("\\\"{k}\\\":\\\"$(esc \"${{{k}:-}}\")\\\""))
        .collect::<Vec<_>>()
        .join(",");

    format!(
        r#"#!/bin/sh
# {marker}
# Forwards Claude Code hook events to the Cognia fleet monitor.
# Fail-open by design: every early-exit path exits 0 so a stopped Cognia
# never blocks or slows the agent beyond the curl timeout.
CFG="${{COGNIA_HOME:-$HOME/.cognia}}/agent-monitor.json"
[ -r "$CFG" ] || exit 0
PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CFG")
TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG")
[ -n "$PORT" ] && [ -n "$TOKEN" ] || exit 0

EVENT="${{1:-unknown}}"
MODE="${{2:-fire}}"
PAYLOAD=$(cat)
[ -n "$PAYLOAD" ] || PAYLOAD='{{}}'

# Minimal JSON string escaper (backslash, quote; control chars stripped).
esc() {{
  printf '%s' "$1" | tr -d '\n\r\t' | sed 's/\\/\\\\/g; s/"/\\"/g'
}}

ENVJSON="{{{env_pairs_open}}}"
BODY="{{\"agent\":\"claude-code\",\"event\":\"$EVENT\",\"pid\":$$,\"ppid\":$PPID,\"env\":$ENVJSON,\"payload\":$PAYLOAD}}"

TMOUT=0.4
[ "$MODE" = "wait" ] && TMOUT=25

OUT=$(curl -sk --max-time "$TMOUT" \
  -H "X-Cognia-Fleet-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "$BODY" \
  "https://127.0.0.1:$PORT/api/v1/fleet/hook") || exit 0

if [ "$MODE" = "wait" ] && [ -n "$OUT" ]; then
  printf '%s' "$OUT"
fi
exit 0
"#,
        marker = MANAGED_MARKER,
        env_pairs_open = env_pairs,
    )
}

/// Write (or refresh) the Claude hook script. Idempotent; 0755.
pub fn write_claude_hook_script() -> Result<PathBuf, String> {
    write_claude_hook_script_at(&cognia_home()?)
}

fn write_claude_hook_script_at(base: &Path) -> Result<PathBuf, String> {
    let path = claude_hook_script_path_at(base);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let contents = claude_hook_script(super::terminal::CAPTURED_ENV_VARS);

    // Plain create+rename (not fs_atomic): scripts are fully regenerated and
    // carry no user edits worth backing up; the managed marker states that.
    let tmp = path.with_extension("sh.tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(contents.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    Ok(path)
}

/// Script status for the settings card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScriptStatus {
    /// Present and carries the current managed marker.
    Installed,
    /// Present but the marker line differs (older version or user-edited).
    Stale,
    Missing,
}

pub fn claude_hook_script_status() -> ScriptStatus {
    match cognia_home() {
        Ok(base) => claude_hook_script_status_at(&base),
        Err(_) => ScriptStatus::Missing,
    }
}

fn claude_hook_script_status_at(base: &Path) -> ScriptStatus {
    match std::fs::read_to_string(claude_hook_script_path_at(base)) {
        Ok(contents) if contents.contains(MANAGED_MARKER) => ScriptStatus::Installed,
        Ok(_) => ScriptStatus::Stale,
        Err(_) => ScriptStatus::Missing,
    }
}

/// Remove generated scripts (uninstall-all path). Missing files are fine.
pub fn remove_scripts() -> Result<(), String> {
    remove_scripts_at(&cognia_home()?)
}

fn remove_scripts_at(base: &Path) -> Result<(), String> {
    match std::fs::remove_file(claude_hook_script_path_at(base)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (script layer only — settings.json editing happens in TS)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetScriptsStatus {
    pub claude_script: ScriptStatus,
    pub claude_script_path: Option<String>,
    pub monitor_config_present: bool,
}

fn scripts_status() -> FleetScriptsStatus {
    FleetScriptsStatus {
        claude_script: claude_hook_script_status(),
        claude_script_path: claude_hook_script_path().map(|p| p.to_string_lossy().into_owned()),
        monitor_config_present: monitor_config_path().is_some_and(|p| p.exists()),
    }
}

/// Ensure the generated hook scripts exist and are current. Returns the
/// script path the TS catalog references from settings.json.
#[tauri::command]
pub async fn fleet_scripts_install() -> Result<FleetScriptsStatus, String> {
    write_claude_hook_script()?;
    Ok(scripts_status())
}

/// Remove generated scripts (after the TS side has removed the settings.json
/// entries pointing at them).
#[tauri::command]
pub async fn fleet_scripts_uninstall() -> Result<FleetScriptsStatus, String> {
    remove_scripts()?;
    Ok(scripts_status())
}

#[tauri::command]
pub async fn fleet_scripts_status() -> Result<FleetScriptsStatus, String> {
    Ok(scripts_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_contains_marker_and_contract_pieces() {
        let script = claude_hook_script(&["TERM_PROGRAM", "VSCODE_PID"]);
        assert!(script.starts_with("#!/bin/sh"));
        assert!(script.contains(MANAGED_MARKER));
        // Fail-open contract: config check, curl fallback, terminal exit 0.
        assert!(script.contains(r#"[ -r "$CFG" ] || exit 0"#));
        assert!(script.contains(r#") || exit 0"#));
        assert!(script.trim_end().ends_with("exit 0"));
        // COGNIA_HOME override honored (matches agents::paths::cognia_home).
        assert!(script.contains(r#"CFG="${COGNIA_HOME:-$HOME/.cognia}/agent-monitor.json""#));
        // Timeout ladder: fire 0.4s, wait 25s.
        assert!(script.contains("TMOUT=0.4"));
        assert!(script.contains(r#"[ "$MODE" = "wait" ] && TMOUT=25"#));
        // Env whitelist is embedded (JSON quotes escaped for the sh string).
        assert!(script.contains(r#"\"TERM_PROGRAM\":\"$(esc "${TERM_PROGRAM:-}")\""#));
        assert!(script.contains(r#"\"VSCODE_PID\":\"$(esc "${VSCODE_PID:-}")\""#));
        // Envelope shape.
        assert!(script.contains(r#"\"agent\":\"claude-code\""#));
        assert!(script.contains(r#"\"ppid\":$PPID"#));
        assert!(script.contains("/api/v1/fleet/hook"));
    }

    #[test]
    fn script_echoes_output_only_in_wait_mode() {
        let script = claude_hook_script(super::super::terminal::CAPTURED_ENV_VARS);
        assert!(script.contains(r#"if [ "$MODE" = "wait" ] && [ -n "$OUT" ]; then"#));
    }

    #[test]
    fn monitor_config_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_monitor_config_at(tmp.path(), 7890, "deadbeef").unwrap();
        assert!(path.exists());
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["port"], 7890);
        assert_eq!(parsed["token"], "deadbeef");
        assert_eq!(parsed["version"], 1);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        remove_monitor_config_at(tmp.path()).unwrap();
        assert!(!path.exists());
        // Second removal is a no-op.
        remove_monitor_config_at(tmp.path()).unwrap();
    }

    #[test]
    fn script_write_and_status_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            claude_hook_script_status_at(tmp.path()),
            ScriptStatus::Missing
        );

        let path = write_claude_hook_script_at(tmp.path()).unwrap();
        assert!(path.exists());
        assert_eq!(
            claude_hook_script_status_at(tmp.path()),
            ScriptStatus::Installed
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }

        // Idempotent rewrite.
        write_claude_hook_script_at(tmp.path()).unwrap();
        assert_eq!(
            claude_hook_script_status_at(tmp.path()),
            ScriptStatus::Installed
        );

        // Foreign modification → stale.
        std::fs::write(&path, "#!/bin/sh\n# hand-edited\n").unwrap();
        assert_eq!(
            claude_hook_script_status_at(tmp.path()),
            ScriptStatus::Stale
        );

        remove_scripts_at(tmp.path()).unwrap();
        assert_eq!(
            claude_hook_script_status_at(tmp.path()),
            ScriptStatus::Missing
        );
        // Second removal is a no-op.
        remove_scripts_at(tmp.path()).unwrap();
    }

    #[test]
    fn generated_script_passes_sh_syntax_check() {
        // `sh -n` parses without executing — catches quoting mistakes in the
        // generated script (it embeds three quoting layers: Rust, sh, JSON).
        let tmp = tempfile::tempdir().unwrap();
        let path = write_claude_hook_script_at(tmp.path()).unwrap();
        let status = std::process::Command::new("sh")
            .arg("-n")
            .arg(&path)
            .status()
            .expect("spawn sh");
        assert!(status.success(), "sh -n rejected the generated script");
    }

    /// Execute the script against a stub `curl` and assert the POSTed body is
    /// valid JSON with the full envelope — the only reliable guard for the
    /// three stacked quoting layers (Rust format! → sh → JSON).
    #[test]
    #[cfg(unix)]
    fn generated_script_posts_valid_json_envelope() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let script = write_claude_hook_script_at(tmp.path()).unwrap();
        // Monitor config the script reads (COGNIA_HOME points at tmp).
        write_monitor_config_at(tmp.path(), 7890, "tok123").unwrap();

        // Stub curl: dump the --data-binary argument to $CAPTURE and exit 0.
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let capture = tmp.path().join("captured.json");
        let stub = bin.join("curl");
        std::fs::write(
            &stub,
            "#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = \"--data-binary\" ]; then printf '%s' \"$2\" > \"$CAPTURE\"; shift; fi\n  shift\ndone\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let path_env = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
        let mut child = std::process::Command::new("sh")
            .arg(&script)
            .arg("PreToolUse")
            .env("PATH", path_env)
            .env("COGNIA_HOME", tmp.path())
            .env("CAPTURE", &capture)
            .env("TERM_PROGRAM", "iTerm.app")
            // Hostile env value: quotes + backslash must not break the JSON.
            .env("TERM_SESSION_ID", "he said \"hi\" \\ bye")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn script");
        {
            let stdin = child.stdin.as_mut().unwrap();
            stdin
                .write_all(
                    br#"{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"ls"}}"#,
                )
                .unwrap();
        }
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        // Fire mode: nothing echoed.
        assert!(out.stdout.is_empty());

        let body = std::fs::read_to_string(&capture).expect("stub captured a body");
        let parsed: serde_json::Value =
            serde_json::from_str(&body).unwrap_or_else(|e| panic!("invalid JSON ({e}): {body}"));
        assert_eq!(parsed["agent"], "claude-code");
        assert_eq!(parsed["event"], "PreToolUse");
        assert!(parsed["pid"].is_number());
        assert!(parsed["ppid"].is_number());
        assert_eq!(parsed["env"]["TERM_PROGRAM"], "iTerm.app");
        assert_eq!(parsed["env"]["TERM_SESSION_ID"], "he said \"hi\" \\ bye");
        assert_eq!(parsed["payload"]["session_id"], "s1");
        assert_eq!(parsed["payload"]["tool_input"]["command"], "ls");
    }
}
