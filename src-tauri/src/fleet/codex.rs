//! Codex CLI integration for the fleet monitor.
//!
//! Codex has no live-attach surface, but its `notify` config runs a program
//! once per completed agent turn with the turn's session-id / cwd / inputs /
//! reply as a single argv-JSON argument. That is the reliable, trust-free
//! observe path (Codex's full hooks system is gated behind a manual `/hooks`
//! trust step, so it is deliberately NOT what we install here).
//!
//! We generate a tiny `codex-notify.sh` under `~/.cognia/agent-monitor/` and
//! point `notify` at it in `~/.codex/config.toml`, editing that file through
//! `toml_edit` so the user's other keys, comments, and formatting survive.
//! Only ever touches the `notify` key, and only when it is absent or already
//! ours — a user's own notify program is reported as a conflict, never
//! clobbered.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use toml_edit::{Array, DocumentMut, Item, Value};

use super::install::MANAGED_MARKER;

/// `~/.codex/config.toml`. `None` when there is no home dir.
pub fn codex_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("config.toml"))
}

fn codex_notify_script_path_at(base: &Path) -> PathBuf {
    base.join("agent-monitor").join("codex-notify.sh")
}

pub fn codex_notify_script_path() -> Option<PathBuf> {
    crate::agents::paths::cognia_home().map(|home| codex_notify_script_path_at(&home))
}

/// The Codex notify forwarder. Codex appends the event JSON as the final argv
/// arg, so `$1` is the payload (kebab-case: `session-id`, `cwd`,
/// `input-messages`, `last-assistant-message`). Fire-and-forget, always
/// exits 0 so Codex never stalls on a stopped Cognia.
pub fn codex_notify_script(env_vars: &[&str]) -> String {
    let env_pairs = env_vars
        .iter()
        .map(|k| format!("\\\"{k}\\\":\\\"$(esc \"${{{k}:-}}\")\\\""))
        .collect::<Vec<_>>()
        .join(",");

    format!(
        r#"#!/bin/sh
# {marker}
# Forwards Codex agent-turn-complete notifications to the Cognia fleet monitor.
CFG="${{COGNIA_HOME:-$HOME/.cognia}}/agent-monitor.json"
[ -r "$CFG" ] || exit 0
PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CFG")
TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG")
[ -n "$PORT" ] && [ -n "$TOKEN" ] || exit 0

# Codex passes the event JSON as the last argument.
PAYLOAD="${{1:-}}"
case "$PAYLOAD" in
  '{{'*) : ;;           # looks like JSON
  *) PAYLOAD='{{}}' ;;  # missing / not JSON — send an empty object
esac

esc() {{
  printf '%s' "$1" | tr -d '\n\r\t' | sed 's/\\/\\\\/g; s/"/\\"/g'
}}

ENVJSON="{{{env_pairs}}}"
BODY="{{\"agent\":\"codex\",\"event\":\"agent-turn-complete\",\"pid\":$$,\"ppid\":$PPID,\"env\":$ENVJSON,\"payload\":$PAYLOAD}}"

curl -sk --max-time 0.6 \
  -H "X-Cognia-Fleet-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "$BODY" \
  "https://127.0.0.1:$PORT/api/v1/fleet/hook" >/dev/null 2>&1 || exit 0
exit 0
"#,
        marker = MANAGED_MARKER,
        env_pairs = env_pairs,
    )
}

fn write_codex_notify_script_at(base: &Path) -> Result<PathBuf, String> {
    let path = codex_notify_script_path_at(base);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let contents = codex_notify_script(super::terminal::CAPTURED_ENV_VARS);
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

/// Install state of the Codex `notify` integration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexStatus {
    /// `notify` points at our generated script.
    Installed,
    /// `notify` is set to something else — we won't touch it.
    Conflict,
    /// `~/.codex/config.toml` present (or creatable) but no `notify`.
    NotInstalled,
    /// No `~/.codex/` directory — Codex isn't installed.
    Unavailable,
}

/// Pure editor: set `notify = ["<script>"]` on a TOML document, returning the
/// new text. Preserves everything else via `toml_edit`.
fn set_notify(existing: &str, script_path: &str) -> Result<String, String> {
    let mut doc: DocumentMut = if existing.trim().is_empty() {
        DocumentMut::new()
    } else {
        existing
            .parse::<DocumentMut>()
            .map_err(|e| format!("codex config.toml parse: {e}"))?
    };
    let mut arr = Array::new();
    arr.push(script_path);
    doc["notify"] = Item::Value(Value::Array(arr));
    Ok(doc.to_string())
}

/// Pure editor: remove `notify` only when it points at our script. Returns
/// `None` when nothing changed (absent, or a foreign notify we must not drop).
fn clear_our_notify(existing: &str, script_path: &str) -> Result<Option<String>, String> {
    if existing.trim().is_empty() {
        return Ok(None);
    }
    let mut doc: DocumentMut = existing
        .parse::<DocumentMut>()
        .map_err(|e| format!("codex config.toml parse: {e}"))?;
    if !notify_is_ours(&doc, script_path) {
        return Ok(None);
    }
    doc.remove("notify");
    Ok(Some(doc.to_string()))
}

/// Whether the document's `notify` array contains exactly our script path.
fn notify_is_ours(doc: &DocumentMut, script_path: &str) -> bool {
    doc.get("notify")
        .and_then(|item| item.as_array())
        .map(|arr| {
            let entries: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
            entries == [script_path]
        })
        .unwrap_or(false)
}

fn classify(existing_raw: Option<&str>, config_dir_exists: bool, script_path: &str) -> CodexStatus {
    if !config_dir_exists {
        return CodexStatus::Unavailable;
    }
    let Some(raw) = existing_raw else {
        return CodexStatus::NotInstalled;
    };
    let Ok(doc) = raw.parse::<DocumentMut>() else {
        // Unparseable existing config — treat as not-installed so we don't
        // claim ownership; the write path will surface a parse error instead.
        return CodexStatus::NotInstalled;
    };
    match doc.get("notify") {
        None => CodexStatus::NotInstalled,
        Some(_) if notify_is_ours(&doc, script_path) => CodexStatus::Installed,
        Some(_) => CodexStatus::Conflict,
    }
}

fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Back up an existing file before replacing (mirrors agents::io).
    if path.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let bak = path.with_extension(format!("toml.bak.{ts}"));
        std::fs::copy(path, &bak).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("toml.tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(contents.as_bytes())
            .map_err(|e| e.to_string())?;
        f.sync_all().ok();
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexIntegrationStatus {
    pub status: CodexStatus,
    pub config_path: Option<String>,
    pub script_path: Option<String>,
}

fn read_codex_config() -> (Option<String>, bool) {
    match codex_config_path() {
        Some(path) => {
            let dir_exists = path.parent().map(|p| p.exists()).unwrap_or(false);
            let raw = std::fs::read_to_string(&path).ok();
            (raw, dir_exists)
        }
        None => (None, false),
    }
}

fn current_status() -> Result<CodexIntegrationStatus, String> {
    let script_path = codex_notify_script_path().ok_or("no home directory")?;
    let script_str = script_path.to_string_lossy().into_owned();
    let (raw, dir_exists) = read_codex_config();
    Ok(CodexIntegrationStatus {
        status: classify(raw.as_deref(), dir_exists, &script_str),
        config_path: codex_config_path().map(|p| p.to_string_lossy().into_owned()),
        script_path: Some(script_str),
    })
}

/// Install the Codex notify integration: generate the script, then point
/// `~/.codex/config.toml`'s `notify` at it (refusing to overwrite a foreign
/// notify program).
#[tauri::command]
pub async fn fleet_codex_install() -> Result<CodexIntegrationStatus, String> {
    let home = crate::agents::paths::cognia_home().ok_or("no home directory")?;
    let script_path = write_codex_notify_script_at(&home)?;
    let script_str = script_path.to_string_lossy().into_owned();

    let config_path = codex_config_path().ok_or("no home directory")?;
    let dir_exists = config_path.parent().map(|p| p.exists()).unwrap_or(false);
    if !dir_exists {
        return Err("Codex is not installed (~/.codex missing)".to_string());
    }
    let existing = std::fs::read_to_string(&config_path).unwrap_or_default();

    // Refuse to clobber a user's own notify program.
    if let Ok(doc) = existing.parse::<DocumentMut>() {
        if doc.get("notify").is_some() && !notify_is_ours(&doc, &script_str) {
            return Err(
                "Codex `notify` is already set to another program; leaving it untouched"
                    .to_string(),
            );
        }
    }

    let updated = set_notify(&existing, &script_str)?;
    atomic_write(&config_path, &updated)?;
    current_status()
}

/// Remove the Codex notify integration (only our entry) and delete the script.
#[tauri::command]
pub async fn fleet_codex_uninstall() -> Result<CodexIntegrationStatus, String> {
    let script_path = codex_notify_script_path().ok_or("no home directory")?;
    let script_str = script_path.to_string_lossy().into_owned();

    if let Some(config_path) = codex_config_path() {
        if let Ok(existing) = std::fs::read_to_string(&config_path) {
            if let Some(updated) = clear_our_notify(&existing, &script_str)? {
                atomic_write(&config_path, &updated)?;
            }
        }
    }
    match std::fs::remove_file(&script_path) {
        Ok(()) | Err(_) => {}
    }
    current_status()
}

#[tauri::command]
pub async fn fleet_codex_status() -> Result<CodexIntegrationStatus, String> {
    current_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = "/Users/x/.cognia/agent-monitor/codex-notify.sh";

    #[test]
    fn notify_script_has_marker_and_contract() {
        let s = codex_notify_script(&["TERM_PROGRAM"]);
        assert!(s.starts_with("#!/bin/sh"));
        assert!(s.contains(MANAGED_MARKER));
        assert!(s.contains(r#"\"agent\":\"codex\""#));
        assert!(s.contains(r#"\"event\":\"agent-turn-complete\""#));
        assert!(s.contains(r#"PAYLOAD="${1:-}""#));
        assert!(s.contains("/api/v1/fleet/hook"));
        assert!(s.trim_end().ends_with("exit 0"));
    }

    #[test]
    fn generated_notify_script_passes_sh_check() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_codex_notify_script_at(tmp.path()).unwrap();
        let status = std::process::Command::new("sh")
            .arg("-n")
            .arg(&path)
            .status()
            .expect("spawn sh");
        assert!(status.success());
    }

    #[test]
    fn set_notify_adds_key_to_empty_and_preserves_others() {
        let out = set_notify("", SCRIPT).unwrap();
        assert!(out.contains(&format!("notify = [\"{SCRIPT}\"]")));

        let existing = "model = \"gpt-5\"\n\n[tui]\nnotifications = true\n";
        let out = set_notify(existing, SCRIPT).unwrap();
        assert!(out.contains("model = \"gpt-5\""));
        assert!(out.contains("[tui]"));
        assert!(out.contains("notifications = true"));
        assert!(out.contains(&format!("notify = [\"{SCRIPT}\"]")));
    }

    #[test]
    fn set_notify_replaces_our_previous_value() {
        let existing = format!("notify = [\"{SCRIPT}\"]\n");
        let out = set_notify(&existing, SCRIPT).unwrap();
        // Idempotent — still exactly one notify entry.
        assert_eq!(out.matches("notify =").count(), 1);
    }

    #[test]
    fn clear_our_notify_only_removes_ours() {
        // Ours → removed.
        let mine = format!("model = \"gpt-5\"\nnotify = [\"{SCRIPT}\"]\n");
        let out = clear_our_notify(&mine, SCRIPT).unwrap().unwrap();
        assert!(!out.contains("notify"));
        assert!(out.contains("model = \"gpt-5\""));

        // Foreign → left untouched (None).
        let foreign = "notify = [\"/usr/bin/their-notifier\"]\n";
        assert!(clear_our_notify(foreign, SCRIPT).unwrap().is_none());

        // Absent → None.
        assert!(clear_our_notify("model = \"gpt-5\"\n", SCRIPT)
            .unwrap()
            .is_none());
        assert!(clear_our_notify("", SCRIPT).unwrap().is_none());
    }

    #[test]
    fn classify_covers_every_state() {
        assert_eq!(classify(None, false, SCRIPT), CodexStatus::Unavailable);
        assert_eq!(classify(None, true, SCRIPT), CodexStatus::NotInstalled);
        assert_eq!(
            classify(Some("model = \"x\"\n"), true, SCRIPT),
            CodexStatus::NotInstalled
        );
        assert_eq!(
            classify(Some(&format!("notify = [\"{SCRIPT}\"]\n")), true, SCRIPT),
            CodexStatus::Installed
        );
        assert_eq!(
            classify(Some("notify = [\"/other\"]\n"), true, SCRIPT),
            CodexStatus::Conflict
        );
        // A two-element array (ours + an arg) is NOT exactly ours → conflict-ish
        // (not installed-by-us), reported as Conflict so we don't touch it.
        assert_eq!(
            classify(
                Some(&format!("notify = [\"{SCRIPT}\", \"x\"]\n")),
                true,
                SCRIPT
            ),
            CodexStatus::Conflict
        );
    }

    #[test]
    fn full_install_uninstall_round_trip_on_disk() {
        let cfg_dir = tempfile::tempdir().unwrap();
        let config = cfg_dir.path().join("config.toml");
        std::fs::write(&config, "model = \"gpt-5\"\n# keep me\n").unwrap();

        // set_notify + atomic_write, then read back.
        let updated = set_notify(&std::fs::read_to_string(&config).unwrap(), SCRIPT).unwrap();
        atomic_write(&config, &updated).unwrap();
        let after = std::fs::read_to_string(&config).unwrap();
        assert!(after.contains("# keep me"));
        assert!(after.contains(&format!("notify = [\"{SCRIPT}\"]")));

        // clear removes only ours, comment survives.
        let cleared = clear_our_notify(&after, SCRIPT).unwrap().unwrap();
        atomic_write(&config, &cleared).unwrap();
        let final_txt = std::fs::read_to_string(&config).unwrap();
        assert!(!final_txt.contains("notify"));
        assert!(final_txt.contains("# keep me"));
    }
}
