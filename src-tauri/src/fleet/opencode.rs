//! OpenCode integration for the fleet monitor.
//!
//! OpenCode loads plugins from `~/.config/opencode/plugin/` at startup and
//! passes each a bound SDK `client` plus documented lifecycle hooks. We ship a
//! single plugin, `cognia-fleet.js`, that:
//!   - forwards normalized session activity to the fleet `/api/fleet/hook`
//!     endpoint (`session-active` / `session-idle`, agent `opencode`), and
//!   - implements the documented `permission.ask` hook as a long-poll to the
//!     same endpoint (`PermissionRequest`, `wait` mode),
//!   - projects the native Question API into answerable fleet questions, and
//!   - consumes the durable command outbox for native prompts and interrupts.
//!
//! The plugin probes the bound SDK client before advertising controls. Static
//! manifest capabilities are only a ceiling; commands stay disabled until the
//! installed SDK proves the required methods exist. Cognia never depends on
//! OpenCode's random HTTP port.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use super::install::MANAGED_MARKER;

/// Bumped whenever the plugin's wire contract changes, independently of
/// `MANAGED_MARKER`.
///
/// The marker alone is what `classify` used to read, so a plugin written by an
/// older build stayed `Installed` forever and kept calling a URL that no longer
/// exists. It cannot be the marker itself: that string is shared with the
/// Claude hook script and the Codex config, and bumping it would mark those
/// stale for a change that has nothing to do with them.
const OPENCODE_PLUGIN_CONTRACT: &str = "cognia-opencode-contract v2 (unversioned ack/nack paths)";

/// `~/.config/opencode/plugin/`. OpenCode's global plugin dir (singular
/// `plugin`, per current docs). `None` when there's no config dir.
fn opencode_plugin_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("opencode").join("plugin"))
}

fn opencode_plugin_path_from(dir: &Path) -> PathBuf {
    dir.join("cognia-fleet.js")
}

pub fn opencode_plugin_path() -> Option<PathBuf> {
    opencode_plugin_dir().map(|d| opencode_plugin_path_from(&d))
}

/// The plugin source. ESM default export of the `Plugin` factory. Reads the
/// monitor config each call (cheap, and picks up token rotation), fails open
/// on any error so a stopped Cognia never blocks an OpenCode turn.
pub fn opencode_plugin_source() -> String {
    // Note: `{marker}` etc. are the only Rust-format substitutions; all other
    // braces are doubled for `format!`.
    format!(
        r#"// {marker}
// {contract}
// Cognia fleet monitor plugin for OpenCode. Forwards session activity and
// proxies permission prompts to the Cognia desktop app. Fails open.
import {{ readFileSync }} from "node:fs"
import {{ homedir }} from "node:os"
import {{ join }} from "node:path"
import {{ createOpencodeClient as createV2Client }} from "@opencode-ai/sdk/v2"

function loadConfig() {{
  try {{
    const base = process.env.COGNIA_HOME || join(homedir(), ".cognia")
    const cfg = JSON.parse(readFileSync(join(base, "agent-monitor.json"), "utf8"))
    if (!cfg || !cfg.port || !cfg.token) return null
    return cfg
  }} catch {{
    return null
  }}
}}

function capturedEnv() {{
  const keys = {env_keys}
  const out = {{}}
  for (const k of keys) if (process.env[k]) out[k] = process.env[k]
  return out
}}

async function post(cfg, body, timeoutMs) {{
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {{
    const res = await fetch(`https://127.0.0.1:${{cfg.port}}/api/fleet/hook`, {{
      method: "POST",
      headers: {{ "Content-Type": "application/json", "X-Cognia-Fleet-Token": cfg.token }},
      body: JSON.stringify(body),
      signal: controller.signal,
    }})
    if (!res.ok) return undefined
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }} catch {{
    return undefined
  }} finally {{
    clearTimeout(timer)
  }}
}}

function envelope(event, payload) {{
  return {{
    agent: "opencode",
    event,
    pid: process.pid,
    ppid: 0,
    env: capturedEnv(),
    payload,
  }}
}}

async function pollCommands(cfg, sessionIds) {{
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  try {{
    const res = await fetch(`https://127.0.0.1:${{cfg.port}}/api/fleet/opencode/commands`, {{
      method: "POST",
      headers: {{ "Content-Type": "application/json", "X-Cognia-Fleet-Token": cfg.token }},
      body: JSON.stringify({{ session_ids: sessionIds }}),
      signal: controller.signal,
    }})
    if (!res.ok) return []
    const data = await res.json()
    return (data && data.commands) || []
  }} catch {{
    return []
  }} finally {{
    clearTimeout(timer)
  }}
}}

async function settleCommand(cfg, command, ok, value) {{
  const suffix = ok ? "ack" : "nack"
  const body = ok
    ? {{ id: command.id, result: value || null }}
    : {{ id: command.id, error: String(value && value.message ? value.message : value) }}
  try {{
    await fetch(`https://127.0.0.1:${{cfg.port}}/api/fleet/opencode/commands/${{suffix}}`, {{
      method: "POST",
      headers: {{ "Content-Type": "application/json", "X-Cognia-Fleet-Token": cfg.token }},
      body: JSON.stringify(body),
    }})
  }} catch {{
    // Lease expiry intentionally causes at-least-once redelivery.
  }}
}}

async function interruptSession(client, sessionID) {{
  try {{
    if (client.session && client.session.interrupt) {{
      return await client.session.interrupt({{ sessionID }}, {{ throwOnError: true }})
    }}
  }} catch (interruptError) {{
    if (!(client.session && client.session.abort)) throw interruptError
  }}
  if (client.session && client.session.abort) {{
    return await client.session.abort({{ sessionID }}, {{ throwOnError: true }})
  }}
  throw new Error("OpenCode interrupt API unavailable")
}}

function nativeQuestionAnswers(questions, updatedInput) {{
  const byQuestion = (updatedInput && updatedInput.answers) || {{}}
  return questions.map((question) => {{
    const answer = byQuestion[question.question]
    if (Array.isArray(answer)) return answer.map(String)
    return answer == null ? [] : [String(answer)]
  }})
}}

async function replyQuestion(client, sessionID, requestID, questions, updatedInput) {{
  const answers = nativeQuestionAnswers(questions, updatedInput)
  if (client.question && client.question.reply) {{
    return client.question.reply({{
      sessionID,
      requestID,
      questionV2Reply: {{ answers }},
    }}, {{ throwOnError: true }})
  }}
  throw new Error("OpenCode Question API unavailable")
}}

async function rejectQuestion(client, sessionID, requestID) {{
  if (client.question && client.question.reject) {{
    return client.question.reject({{ sessionID, requestID }}, {{ throwOnError: true }})
  }}
  throw new Error("OpenCode Question reject API unavailable")
}}

function runtimeCapabilities(client) {{
  const interruptMode = client.session && typeof client.session.interrupt === "function"
    ? "v2"
    : client.session && typeof client.session.abort === "function"
      ? "v1"
      : null
  const questionMode = client.question
    && typeof client.question.reply === "function"
    && typeof client.question.reject === "function"
    ? "v2"
    : null
  return {{
    sendMessage: Boolean(client.session && typeof client.session.promptAsync === "function"),
    interrupt: interruptMode !== null,
    interruptMode,
    answersQuestions: questionMode !== null,
    questionMode,
  }}
}}

export const CogniaFleet = async ({{ directory, serverUrl }}) => {{
  const cwd = directory || process.cwd()
  // The plugin's bound client still exposes the legacy surface in current
  // OpenCode releases. Create the documented v2 client against the same local
  // server so question replies and per-session interrupts use native APIs.
  const client = createV2Client({{ baseUrl: serverUrl.toString(), directory: cwd }})
  const seen = new Set()
  const capabilities = runtimeCapabilities(client)
  let announcedCapabilityToken = null
  const fire = (event, payload) => {{
    const cfg = loadConfig()
    if (!cfg) return
    void post(cfg, envelope(event, {{ cwd, ...payload }}), 400)
  }}
  fire("Capabilities", capabilities)

  const announceCapabilities = async (cfg) => {{
    if (!cfg || announcedCapabilityToken === cfg.token) return
    const accepted = await post(cfg, envelope("Capabilities", {{ cwd, ...capabilities }}), 1000)
    // A 204 response parses as null; `undefined` means transport/HTTP failure.
    if (accepted !== undefined) announcedCapabilityToken = cfg.token
  }}

  // Deliver queued island prompts into OpenCode via the bound client. Runs a
  // long-poll loop over the sessions this plugin instance has seen; a stopped
  // Cognia just returns empty and the loop idles.
  const runCommandLoop = async () => {{
    for (;;) {{
      const cfg = loadConfig()
      if (cfg) await announceCapabilities(cfg)
      if (!cfg || seen.size === 0) {{
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }}
      const commands = await pollCommands(cfg, Array.from(seen))
      for (const cmd of commands) {{
        try {{
          const result = cmd.kind === "interrupt"
            ? await interruptSession(client, cmd.sessionId)
            : await client.session.promptAsync({{
                sessionID: cmd.sessionId,
                directory: cwd,
                parts: [{{ type: "text", text: cmd.text || "" }}],
              }}, {{ throwOnError: true }})
          await settleCommand(cfg, cmd, true, result)
        }} catch (error) {{
          await settleCommand(cfg, cmd, false, error)
        }}
      }}
    }}
  }}
  void runCommandLoop()

  return {{
    // Every bus event — we only care about session idle to flip back.
    event: async ({{ event }}) => {{
      if (event && event.type === "session.idle" && event.properties && event.properties.sessionID) {{
        fire("session-idle", {{ session_id: event.properties.sessionID }})
      }}
      const question = event && (event.data || event.properties)
      if (event && event.type === "question.asked" && question) {{
        const cfg = loadConfig()
        const sid = question.sessionID
        const requestID = question.id || question.requestID
        const questions = Array.isArray(question.questions) ? question.questions : []
        if (!cfg || !capabilities.answersQuestions || !sid || !requestID || questions.length === 0) return
        seen.add(sid)
        const normalized = questions.map((item) => ({{
          question: item.question,
          header: item.header,
          multiSelect: item.multiple === true || item.multiSelect === true,
          options: Array.isArray(item.options) ? item.options : [],
        }}))
        const decision = await post(cfg, envelope("PermissionRequest", {{
          cwd,
          session_id: sid,
          tool_name: "AskUserQuestion",
          tool_input: {{ questions: normalized }},
        }}), 25000)
        if (decision && decision.updatedInput) {{
          await replyQuestion(client, sid, requestID, normalized, decision.updatedInput)
        }} else if (decision && decision.status === "deny") {{
          await rejectQuestion(client, sid, requestID)
        }}
      }} else if (event && event.type === "question.rejected" && question && question.sessionID) {{
        fire("PermissionDenied", {{ session_id: question.sessionID }})
      }} else if (event && event.type === "question.replied" && question && question.sessionID) {{
        fire("session-active", {{ session_id: question.sessionID }})
      }}
    }},
    // A user message started a turn.
    "chat.message": async (_input, output) => {{
      const sid = output && output.message && output.message.sessionID
      if (sid) {{ seen.add(sid); fire("session-active", {{ session_id: sid }}) }}
    }},
    // A tool is about to run — surface it as the activity line.
    "tool.execute.before": async (input) => {{
      if (input && input.sessionID) {{
        seen.add(input.sessionID)
        fire("session-active", {{ session_id: input.sessionID, tool_name: input.tool }})
      }}
    }},
    // Permission prompt — long-poll the island for allow/deny; leave the
    // status untouched on timeout so OpenCode's own prompt takes over.
    "permission.ask": async (input, output) => {{
      const cfg = loadConfig()
      if (!cfg) return
      const sid = input && input.sessionID
      if (!sid) return
      const body = envelope("PermissionRequest", {{
        cwd,
        session_id: sid,
        tool_name: (input && (input.title || input.type)) || "permission",
      }})
      const decision = await post(cfg, body, 25000)
      if (decision && (decision.status === "allow" || decision.status === "deny")) {{
        output.status = decision.status
      }}
    }},
  }}
}}
"#,
        marker = MANAGED_MARKER,
        contract = OPENCODE_PLUGIN_CONTRACT,
        env_keys = env_keys_js(),
    )
}

/// Render the captured-env whitelist as a JS array literal (single source of
/// truth shared with the classifier via `terminal::CAPTURED_ENV_VARS`).
fn env_keys_js() -> String {
    let items = super::terminal::CAPTURED_ENV_VARS
        .iter()
        .map(|k| format!("\"{k}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{items}]")
}

/// Install state of the OpenCode plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpencodeStatus {
    Installed,
    /// Present but the marker differs (older version / user-edited).
    Stale,
    NotInstalled,
    /// No `~/.config/opencode/` — OpenCode isn't installed.
    Unavailable,
}

fn classify(plugin_dir: &Path) -> OpencodeStatus {
    // The parent `opencode` dir existing means OpenCode is configured.
    let opencode_root = plugin_dir.parent();
    if !opencode_root.map(|p| p.exists()).unwrap_or(false) {
        return OpencodeStatus::Unavailable;
    }
    match std::fs::read_to_string(opencode_plugin_path_from(plugin_dir)) {
        // Both, not just the marker. A plugin carrying the marker but an older
        // contract is calling a URL this build no longer serves, so it reads as
        // Stale and the settings row offers a one-click reinstall.
        Ok(contents)
            if contents.contains(MANAGED_MARKER)
                && contents.contains(OPENCODE_PLUGIN_CONTRACT) =>
        {
            OpencodeStatus::Installed
        }
        Ok(_) => OpencodeStatus::Stale,
        Err(_) => OpencodeStatus::NotInstalled,
    }
}

fn write_plugin(plugin_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(plugin_dir).map_err(|e| e.to_string())?;
    let path = opencode_plugin_path_from(plugin_dir);
    let tmp = path.with_extension("js.tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(opencode_plugin_source().as_bytes())
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeIntegrationStatus {
    pub status: OpencodeStatus,
    pub plugin_path: Option<String>,
}

fn status_dto() -> OpencodeIntegrationStatus {
    let dir = opencode_plugin_dir();
    OpencodeIntegrationStatus {
        status: dir
            .as_deref()
            .map(classify)
            .unwrap_or(OpencodeStatus::Unavailable),
        plugin_path: opencode_plugin_path().map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Write the OpenCode plugin. Requires `~/.config/opencode/` to exist.
#[tauri::command]
pub async fn fleet_opencode_install() -> Result<OpencodeIntegrationStatus, String> {
    let dir = opencode_plugin_dir().ok_or("no config directory")?;
    let opencode_root = dir.parent().ok_or("bad plugin path")?;
    if !opencode_root.exists() {
        return Err("OpenCode is not installed (~/.config/opencode missing)".to_string());
    }
    write_plugin(&dir)?;
    Ok(status_dto())
}

/// Remove the OpenCode plugin.
#[tauri::command]
pub async fn fleet_opencode_uninstall() -> Result<OpencodeIntegrationStatus, String> {
    if let Some(path) = opencode_plugin_path() {
        match std::fs::remove_file(&path) {
            Ok(()) | Err(_) => {}
        }
    }
    Ok(status_dto())
}

#[tauri::command]
pub async fn fleet_opencode_status() -> Result<OpencodeIntegrationStatus, String> {
    Ok(status_dto())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_source_has_marker_and_documented_hooks() {
        let src = opencode_plugin_source();
        assert!(src.contains(MANAGED_MARKER));
        assert!(src.contains("export const CogniaFleet"));
        // Documented OpenCode plugin hooks only.
        assert!(src.contains("\"chat.message\""));
        assert!(src.contains("\"tool.execute.before\""));
        assert!(src.contains("\"permission.ask\""));
        assert!(src.contains("event:"));
        // Our contract: normalized event names + the fleet endpoint.
        assert!(src.contains("\"session-active\""));
        assert!(src.contains("\"session-idle\""));
        assert!(src.contains("\"PermissionRequest\""));
        assert!(src.contains("/api/fleet/hook"));
        // Fail-open + timeout ladder (25s wait < nothing here, matches Rust 20s).
        assert!(src.contains("output.status = decision.status"));
        // Send-message reverse channel: command poll + client execution.
        assert!(src.contains("/api/fleet/opencode/commands"));
        assert!(src.contains("/api/fleet/opencode/commands/${suffix}"));
        // The stamp `classify` reads. Without it in the emitted source, every
        // freshly written plugin would immediately read back as Stale.
        assert!(src.contains(OPENCODE_PLUGIN_CONTRACT));
        assert!(!src.contains("/api/v1/"), "runtime paths on this listener are unversioned");
        assert!(src.contains("settleCommand"));
        assert!(src.contains("createOpencodeClient as createV2Client"));
        assert!(src.contains("client.session.promptAsync"));
        assert!(src.contains("client.session.abort"));
        assert!(src.contains("client.session.interrupt"));
        assert!(src.contains("client.question.reply"));
        assert!(src.contains("client.question.reject"));
        assert!(src.contains("throwOnError: true"));
        assert!(src.contains("question.asked"));
        assert!(!src.contains("fire(\"question.asked\""));
        assert!(src.contains("/commands/${suffix}"));
        assert!(src.contains("ok ? \"ack\" : \"nack\""));
        assert!(src.contains("cmd.kind === \"interrupt\""));
        assert!(src.contains("question.replied"));
        assert!(src.contains("question.rejected"));
        assert!(src.contains("runtimeCapabilities(client)"));
        assert!(src.contains("fire(\"Capabilities\", capabilities)"));
        assert!(src.contains("answersQuestions: questionMode !== null"));
        assert!(src.contains("runCommandLoop"));
        // Sessions are tracked so commands route to the owning instance.
        assert!(src.contains("seen.add"));
    }

    #[test]
    fn env_keys_js_is_a_js_array_of_captured_vars() {
        let js = env_keys_js();
        assert!(js.starts_with('[') && js.ends_with(']'));
        assert!(js.contains("\"TERM_PROGRAM\""));
        assert!(js.contains("\"VSCODE_PID\""));
    }

    #[test]
    fn classify_and_write_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        // Simulate ~/.config/opencode/plugin.
        let opencode_root = tmp.path().join("opencode");
        let plugin_dir = opencode_root.join("plugin");

        // No opencode root → Unavailable.
        assert_eq!(classify(&plugin_dir), OpencodeStatus::Unavailable);

        // Root exists, no plugin → NotInstalled.
        std::fs::create_dir_all(&opencode_root).unwrap();
        assert_eq!(classify(&plugin_dir), OpencodeStatus::NotInstalled);

        // Write → Installed.
        let path = write_plugin(&plugin_dir).unwrap();
        assert!(path.exists());
        assert_eq!(classify(&plugin_dir), OpencodeStatus::Installed);

        // Foreign edit → Stale.
        std::fs::write(&path, "export const X = 1\n").unwrap();
        assert_eq!(classify(&plugin_dir), OpencodeStatus::Stale);

        // Remove → NotInstalled.
        std::fs::remove_file(&path).unwrap();
        assert_eq!(classify(&plugin_dir), OpencodeStatus::NotInstalled);
    }
}
