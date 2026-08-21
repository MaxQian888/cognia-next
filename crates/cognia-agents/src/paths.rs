// Per-agent, per-OS config file paths. Returning `None` means "this agent
// isn't expected to exist on this OS" — the UI greys the chip rather than
// erroring. Paths use `dirs::home_dir()` / `dirs::config_dir()` so they
// honour user-set HOME / APPDATA on Windows.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// File format hint mirroring `lib/claude/agents/index.ts:AgentFileFormat`.
/// IO uses this to pick the right serializer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentFormat {
    Json,
    Jsonc,
    Toml,
}

#[derive(Debug, Clone)]
pub struct AgentSpec {
    pub format: AgentFormat,
    pub writable: bool,
    pub path: Option<PathBuf>,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Pure core of [`cognia_home`] — testable without touching the real env.
/// `$COGNIA_HOME` (when set + non-empty after trim) wins; otherwise
/// `<home>/.cognia`. Mirrors `cli/src/config/load.ts:resolveHome` so the
/// desktop writes exactly where the standalone CLI reads.
fn cognia_home_from(override_val: Option<String>, home_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(v) = override_val {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    home_dir.map(|h| h.join(".cognia"))
}

/// The cognia CLI home directory: `$COGNIA_HOME` or `~/.cognia`.
pub fn cognia_home() -> Option<PathBuf> {
    cognia_home_from(std::env::var("COGNIA_HOME").ok(), home())
}

// ---------------------------------------------------------------------------
// Vendor roots
//
// The coding agents cognia imports from (Claude Code, Codex, OpenCode, Pi)
// each let the user relocate their whole config tree with an environment
// variable. Every importer — sessions, MCP, subagents, skills, memory,
// settings, commands — must agree on where those trees live, so the
// resolution lives here once and is handed to the frontend as one struct
// (`agent_vendor_roots`). Before this existed each adapter re-derived
// `<home>/.codex` inline and silently ignored `$CODEX_HOME`.
// ---------------------------------------------------------------------------

/// Environment overrides consulted when resolving {@link VendorRoots}.
/// Split out from the real `std::env` read so the resolution is unit-testable.
#[derive(Debug, Default, Clone)]
pub struct RootEnv {
    /// `$CLAUDE_CONFIG_DIR` — relocates Claude Code's `~/.claude`.
    pub claude_config_dir: Option<String>,
    /// `$CODEX_HOME` — relocates Codex CLI's `~/.codex`.
    pub codex_home: Option<String>,
    /// `$XDG_CONFIG_HOME` — OpenCode reads XDG on every unix, macOS included.
    pub xdg_config_home: Option<String>,
    /// `$XDG_DATA_HOME` — where OpenCode keeps its session database.
    pub xdg_data_home: Option<String>,
    /// `$PI_CODING_AGENT_DIR` — relocates Pi's `~/.pi/agent`.
    ///
    /// This overrides the *agent* directory, NOT `~/.pi`. Pi's own resolver
    /// (`getAgentDir()` in `@earendil-works/pi-coding-agent`) is env-first and
    /// otherwise `join(homedir(), ".pi", "agent")`. Pi's project scope is
    /// always `<cwd>/.pi` and is deliberately unaffected by this variable.
    pub pi_coding_agent_dir: Option<String>,
    /// `$PI_CODING_AGENT_SESSION_DIR` — relocates Pi's session JSONL tree.
    /// Pi layers a `sessionDir` settings key underneath this; that lives in
    /// `settings.json` and so is resolved by the reader, not here — these
    /// roots are environment-only by design.
    pub pi_coding_agent_session_dir: Option<String>,
}

/// Absolute per-vendor root directories. An empty string means "not
/// resolvable on this host" (no home directory) — the frontend treats that
/// as "this vendor can't be scanned" rather than joining onto `""`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VendorRoots {
    /// `$CLAUDE_CONFIG_DIR` or `<home>/.claude`.
    pub claude_config_dir: String,
    /// `$CODEX_HOME` or `<home>/.codex`.
    pub codex_home: String,
    /// `$XDG_CONFIG_HOME/opencode`, `%APPDATA%/opencode`, or `<home>/.config/opencode`.
    pub opencode_config_dir: String,
    /// `$XDG_DATA_HOME/opencode`, `%APPDATA%/opencode`, or `<home>/.local/share/opencode`.
    pub opencode_data_dir: String,
    /// Platform data fallback (`dirs::data_dir()/opencode`), retained alongside XDG.
    pub opencode_platform_data_dir: String,
    /// `$PI_CODING_AGENT_DIR` or `<home>/.pi/agent` — Pi's user-scope config
    /// directory, holding `settings.json` (packages), `mcp.json`,
    /// `subagents.json` and the per-extension `<name>.json` files.
    pub pi_agent_dir: String,
    /// `$PI_CODING_AGENT_SESSION_DIR` or `<pi_agent_dir>/sessions`.
    pub pi_session_dir: String,
    /// `<home>/.gemini` — Gemini CLI's user-scope directory (its session
    /// transcripts live under `tmp/`).
    ///
    /// Home-relative with no environment override: unlike `$CLAUDE_CONFIG_DIR`
    /// / `$CODEX_HOME` / `$XDG_*` / `$PI_CODING_AGENT_DIR`, no relocation
    /// variable for Gemini CLI is confirmed against upstream, and inventing one
    /// here would be a path this resolver claims to honour and does not. The
    /// point of carrying it anyway is that the renderer stops deriving the path
    /// itself — `lib/session-import/adapters/gemini-cli.ts` was one of only two
    /// sources still joining onto a bare `home`, which is exactly the drift
    /// this module exists to end. Adding an override later is one line here.
    pub gemini_dir: String,
    /// `<home>/.continue` — Continue's global directory (its session JSON lives
    /// under `sessions/`). Home-relative, no confirmed override; see
    /// [`VendorRoots::gemini_dir`].
    pub continue_dir: String,
}

/// A non-blank env override as a path.
fn env_path(value: Option<String>) -> Option<PathBuf> {
    let v = value?;
    let trimmed = v.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn to_string(path: Option<PathBuf>) -> String {
    path.map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Pure core of [`vendor_roots`]. `config_dir` / `data_dir` are the
/// `dirs::` values (only consulted on Windows, where there is no XDG default
/// and `%APPDATA%` is the convention both OpenCode and this repo already use
/// — see `src-tauri/src/fleet/opencode.rs`).
pub fn vendor_roots_from(
    env: RootEnv,
    home_dir: Option<PathBuf>,
    config_dir: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    windows: bool,
) -> VendorRoots {
    let claude =
        env_path(env.claude_config_dir).or_else(|| home_dir.as_ref().map(|h| h.join(".claude")));
    let codex = env_path(env.codex_home).or_else(|| home_dir.as_ref().map(|h| h.join(".codex")));

    let opencode_config = env_path(env.xdg_config_home)
        .map(|x| x.join("opencode"))
        .or_else(|| {
            if windows {
                config_dir.map(|c| c.join("opencode"))
            } else {
                home_dir
                    .as_ref()
                    .map(|h| h.join(".config").join("opencode"))
            }
        });
    let opencode_platform_data = data_dir.as_ref().map(|dir| dir.join("opencode"));
    let opencode_data = env_path(env.xdg_data_home)
        .map(|x| x.join("opencode"))
        .or_else(|| {
            if windows {
                data_dir.map(|d| d.join("opencode"))
            } else {
                home_dir
                    .as_ref()
                    .map(|h| h.join(".local").join("share").join("opencode"))
            }
        });

    // Pi: the env var replaces `<home>/.pi/agent` wholesale, and the session
    // tree hangs off whatever that resolves to unless separately overridden.
    let pi_agent = env_path(env.pi_coding_agent_dir)
        .or_else(|| home_dir.as_ref().map(|h| h.join(".pi").join("agent")));
    let pi_session = env_path(env.pi_coding_agent_session_dir)
        .or_else(|| pi_agent.as_ref().map(|d| d.join("sessions")));

    let gemini = home_dir.as_ref().map(|h| h.join(".gemini"));
    let continue_dir = home_dir.as_ref().map(|h| h.join(".continue"));

    VendorRoots {
        claude_config_dir: to_string(claude),
        codex_home: to_string(codex),
        opencode_config_dir: to_string(opencode_config),
        opencode_data_dir: to_string(opencode_data),
        opencode_platform_data_dir: to_string(opencode_platform_data),
        pi_agent_dir: to_string(pi_agent),
        pi_session_dir: to_string(pi_session),
        gemini_dir: to_string(gemini),
        continue_dir: to_string(continue_dir),
    }
}

fn env_var(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// Resolve the vendor roots against the real environment.
pub fn vendor_roots() -> VendorRoots {
    vendor_roots_from(
        RootEnv {
            claude_config_dir: env_var("CLAUDE_CONFIG_DIR"),
            codex_home: env_var("CODEX_HOME"),
            xdg_config_home: env_var("XDG_CONFIG_HOME"),
            xdg_data_home: env_var("XDG_DATA_HOME"),
            pi_coding_agent_dir: env_var("PI_CODING_AGENT_DIR"),
            pi_coding_agent_session_dir: env_var("PI_CODING_AGENT_SESSION_DIR"),
        },
        home(),
        dirs::config_dir(),
        dirs::data_dir(),
        cfg!(target_os = "windows"),
    )
}

/// `$CODEX_HOME` or `~/.codex`, as a path.
fn codex_home() -> Option<PathBuf> {
    let roots = vendor_roots();
    if roots.codex_home.is_empty() {
        None
    } else {
        Some(PathBuf::from(roots.codex_home))
    }
}

/// `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, as a path.
fn pi_agent_dir() -> Option<PathBuf> {
    let roots = vendor_roots();
    if roots.pi_agent_dir.is_empty() {
        None
    } else {
        Some(PathBuf::from(roots.pi_agent_dir))
    }
}

#[cfg(target_os = "macos")]
fn claude_desktop_path() -> Option<PathBuf> {
    // ~/Library/Application Support/Claude/claude_desktop_config.json
    home().map(|h| {
        h.join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json")
    })
}

#[cfg(target_os = "windows")]
fn claude_desktop_path() -> Option<PathBuf> {
    // %APPDATA%\Claude\claude_desktop_config.json
    dirs::config_dir().map(|d| d.join("Claude").join("claude_desktop_config.json"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn claude_desktop_path() -> Option<PathBuf> {
    // No officially supported Linux build of Claude Desktop.
    None
}

/// Conventional Cline globalStorage path under VS Code. **Best-effort only.**
/// Path varies by VS Code distribution (Stable, Insiders, OSS, Cursor
/// builds…). We try the Stable VS Code location; if absent, the chip stays
/// grey. We never write here.
fn cline_path() -> Option<PathBuf> {
    let home = home()?;
    let base = if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Code")
    } else if cfg!(target_os = "windows") {
        dirs::config_dir()?.join("Code")
    } else {
        home.join(".config").join("Code")
    };
    Some(
        base.join("User")
            .join("globalStorage")
            .join("saoudrizwan.claude-dev")
            .join("settings")
            .join("cline_mcp_settings.json"),
    )
}

fn roo_code_path() -> Option<PathBuf> {
    let home = home()?;
    let base = if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Code")
    } else if cfg!(target_os = "windows") {
        dirs::config_dir()?.join("Code")
    } else {
        home.join(".config").join("Code")
    };
    Some(
        base.join("User")
            .join("globalStorage")
            .join("rooveterinaryinc.roo-cline")
            .join("settings")
            .join("mcp_settings.json"),
    )
}

fn vscode_user_path() -> Option<PathBuf> {
    let home = home()?;
    let base = if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Code")
    } else if cfg!(target_os = "windows") {
        dirs::config_dir()?.join("Code")
    } else {
        home.join(".config").join("Code")
    };
    Some(base.join("User").join("mcp.json"))
}

/// Zed's settings.json. Mirrors `paths::config_dir()` in zed-industries/zed
/// (crates/paths/src/paths.rs): Windows uses the roaming config dir under the
/// capitalised `Zed`, Linux/FreeBSD use XDG, and macOS deliberately uses
/// `~/.config/zed` rather than `~/Library/Application Support` — so
/// `dirs::config_dir()` must NOT be used on macOS here.
fn zed_settings_path() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        dirs::config_dir()?.join("Zed")
    } else if cfg!(any(target_os = "linux", target_os = "freebsd")) {
        dirs::config_dir()?.join("zed")
    } else {
        home()?.join(".config").join("zed")
    };
    Some(base.join("settings.json"))
}

/// opencode's global config. `~/.config/opencode/opencode.json` on unix,
/// `%APPDATA%\opencode\opencode.json` on Windows, `$XDG_CONFIG_HOME` first.
fn opencode_path() -> Option<PathBuf> {
    let roots = vendor_roots();
    if roots.opencode_config_dir.is_empty() {
        return None;
    }
    Some(PathBuf::from(roots.opencode_config_dir).join("opencode.json"))
}

/// Claude Code's user-scope config blob. Normally `~/.claude.json`; when
/// `$CLAUDE_CONFIG_DIR` relocates the config tree, the blob moves inside it.
fn claude_code_json_path() -> Option<PathBuf> {
    match env_path(env_var("CLAUDE_CONFIG_DIR")) {
        Some(dir) => Some(dir.join(".claude.json")),
        None => home().map(|h| h.join(".claude.json")),
    }
}

/// Build the spec for a known agent id. Unknown ids return None.
pub fn spec_for(agent: &str) -> Option<AgentSpec> {
    let path: Option<PathBuf>;
    let format: AgentFormat;
    let writable: bool;

    match agent {
        "claude-code" => {
            // ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json
            path = claude_code_json_path();
            format = AgentFormat::Json;
            writable = true;
        }
        "claude-desktop" => {
            path = claude_desktop_path();
            format = AgentFormat::Json;
            writable = true;
        }
        "cursor" => {
            // ~/.cursor/mcp.json
            path = home().map(|h| h.join(".cursor").join("mcp.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "vscode" => {
            path = vscode_user_path();
            format = AgentFormat::Jsonc;
            writable = true;
        }
        "codex" => {
            // $CODEX_HOME/config.toml, else ~/.codex/config.toml
            path = codex_home().map(|h| h.join("config.toml"));
            format = AgentFormat::Toml;
            writable = true;
        }
        "gemini" => {
            // ~/.gemini/settings.json
            path = home().map(|h| h.join(".gemini").join("settings.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "windsurf" => {
            // ~/.codeium/windsurf/mcp_config.json
            path = home().map(|h| h.join(".codeium").join("windsurf").join("mcp_config.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "zed" => {
            // settings.json is JSONC — comments don't survive a write.
            path = zed_settings_path();
            format = AgentFormat::Jsonc;
            writable = true;
        }
        "kiro" => {
            // ~/.kiro/settings/mcp.json (user scope; workspace file wins in Kiro
            // but isn't ours to touch).
            path = home().map(|h| h.join(".kiro").join("settings").join("mcp.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "opencode" => {
            path = opencode_path();
            format = AgentFormat::Json;
            writable = true;
        }
        "cognia" => {
            // $COGNIA_HOME/mcp.json or ~/.cognia/mcp.json — the cognia CLI's
            // user-scope MCP file (see cli/src/mcp/load-mcp-config.ts).
            path = cognia_home().map(|h| h.join("mcp.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "pi" => {
            // $PI_CODING_AGENT_DIR/settings.json, else ~/.pi/agent/settings.json.
            // This is Pi's whole preference file, of which Cognia owns exactly
            // one key (`packages`). Credentials live in a separate mode-600
            // `auth.json` that we never open, but readers still go through the
            // key allowlist in `lib/pi-packages/settings-io.ts` so no future
            // caller can hand the rest of the tree to a log or support report,
            // and writers keep the "exists but unparseable => refuse" guard
            // (lib/claude/sync.ts) so a hand-edit is never serialized away.
            path = pi_agent_dir().map(|d| d.join("settings.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "pi-mcp-adapter" => {
            // Pi's core ships no MCP support at all; MCP arrives only with the
            // third-party `pi-mcp-adapter` package, which reads six layers and
            // lets the LAST one win: ~/.config/mcp/mcp.json, ~/.agents/mcp.json,
            // ~/.agents/mcp/mcp.json, this file, ./.mcp.json, then
            // ./.pi/mcp.json (highest). We write only this user-scope layer —
            // the two project layers outrank it and belong to the repo, so the
            // UI warns about them via `mcp-drift-banner.tsx` instead.
            path = pi_agent_dir().map(|d| d.join("mcp.json"));
            format = AgentFormat::Json;
            writable = true;
        }
        "cline" => {
            path = cline_path();
            format = AgentFormat::Json;
            writable = false;
        }
        "roo-code" => {
            path = roo_code_path();
            format = AgentFormat::Json;
            writable = false;
        }
        _ => return None,
    }

    Some(AgentSpec {
        format,
        writable,
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cognia_home_prefers_override() {
        let got = cognia_home_from(Some("/custom/home".to_string()), Some(PathBuf::from("/h")));
        assert_eq!(got, Some(PathBuf::from("/custom/home")));
    }

    #[test]
    fn cognia_home_trims_and_ignores_blank_override() {
        let got = cognia_home_from(Some("   ".to_string()), Some(PathBuf::from("/h")));
        assert_eq!(got, Some(PathBuf::from("/h").join(".cognia")));
    }

    #[test]
    fn cognia_home_falls_back_to_dot_cognia() {
        let got = cognia_home_from(None, Some(PathBuf::from("/h")));
        assert_eq!(got, Some(PathBuf::from("/h").join(".cognia")));
    }

    #[test]
    fn cognia_home_none_without_home() {
        assert_eq!(cognia_home_from(None, None), None);
    }

    fn unix_roots(env: RootEnv) -> VendorRoots {
        vendor_roots_from(env, Some(PathBuf::from("/h")), None, None, false)
    }

    #[test]
    fn vendor_roots_default_to_unix_conventions() {
        let got = unix_roots(RootEnv::default());
        assert_eq!(got.claude_config_dir, "/h/.claude");
        assert_eq!(got.codex_home, "/h/.codex");
        assert_eq!(got.opencode_config_dir, "/h/.config/opencode");
        assert_eq!(got.opencode_data_dir, "/h/.local/share/opencode");
        // Gemini CLI and Continue are resolved HERE now. They were the only two
        // session sources still deriving their own path from a bare home in the
        // renderer, which is the drift this module exists to prevent.
        assert_eq!(got.gemini_dir, "/h/.gemini");
        assert_eq!(got.continue_dir, "/h/.continue");
    }

    #[test]
    fn vendor_roots_honour_claude_and_codex_overrides() {
        let got = unix_roots(RootEnv {
            claude_config_dir: Some("/custom/claude".to_string()),
            codex_home: Some("/custom/codex".to_string()),
            ..RootEnv::default()
        });
        assert_eq!(got.claude_config_dir, "/custom/claude");
        assert_eq!(got.codex_home, "/custom/codex");
        // Unset vars still fall back.
        assert_eq!(got.opencode_config_dir, "/h/.config/opencode");
    }

    #[test]
    fn vendor_roots_honour_xdg_overrides() {
        let got = unix_roots(RootEnv {
            xdg_config_home: Some("/xdg/config".to_string()),
            xdg_data_home: Some("/xdg/data".to_string()),
            ..RootEnv::default()
        });
        assert_eq!(got.opencode_config_dir, "/xdg/config/opencode");
        assert_eq!(got.opencode_data_dir, "/xdg/data/opencode");
    }

    #[test]
    fn vendor_roots_ignore_blank_overrides() {
        // Deliberately exhaustive (no `..RootEnv::default()`): adding an env
        // override without deciding how it treats a blank value should break
        // this test rather than silently inherit someone else's answer.
        let got = unix_roots(RootEnv {
            claude_config_dir: Some("   ".to_string()),
            codex_home: Some(String::new()),
            xdg_config_home: Some("  ".to_string()),
            xdg_data_home: Some("\t".to_string()),
            pi_coding_agent_dir: Some("  ".to_string()),
            pi_coding_agent_session_dir: Some(String::new()),
        });
        assert_eq!(got.claude_config_dir, "/h/.claude");
        assert_eq!(got.codex_home, "/h/.codex");
        assert_eq!(got.opencode_config_dir, "/h/.config/opencode");
        assert_eq!(got.opencode_data_dir, "/h/.local/share/opencode");
        assert_eq!(got.pi_agent_dir, "/h/.pi/agent");
        assert_eq!(got.pi_session_dir, "/h/.pi/agent/sessions");
    }

    #[test]
    fn vendor_roots_use_appdata_on_windows() {
        let got = vendor_roots_from(
            RootEnv::default(),
            Some(PathBuf::from("C:\\Users\\u")),
            Some(PathBuf::from("C:\\Users\\u\\AppData\\Roaming")),
            Some(PathBuf::from("C:\\Users\\u\\AppData\\Roaming")),
            true,
        );
        assert!(got.opencode_config_dir.ends_with("opencode"));
        assert!(got.opencode_config_dir.contains("AppData"));
        assert!(got.opencode_data_dir.contains("AppData"));
        assert!(got.opencode_platform_data_dir.contains("AppData"));
        // Claude / Codex stay home-relative on every OS.
        assert!(got.claude_config_dir.ends_with(".claude"));
    }

    #[test]
    fn vendor_roots_keep_appdata_fallback_with_windows_xdg_override() {
        let got = vendor_roots_from(
            RootEnv {
                xdg_data_home: Some("D:\\XDG".to_string()),
                ..RootEnv::default()
            },
            Some(PathBuf::from("C:\\Users\\u")),
            None,
            Some(PathBuf::from("E:\\Profiles\\u\\Roaming")),
            true,
        );
        assert!(got.opencode_data_dir.starts_with("D:\\XDG"));
        assert!(got
            .opencode_platform_data_dir
            .starts_with("E:\\Profiles\\u\\Roaming"));
    }

    #[test]
    fn vendor_roots_are_blank_without_a_home() {
        let got = vendor_roots_from(RootEnv::default(), None, None, None, false);
        assert_eq!(got.claude_config_dir, "");
        assert_eq!(got.codex_home, "");
        assert_eq!(got.opencode_config_dir, "");
        assert_eq!(got.opencode_data_dir, "");
        assert_eq!(got.pi_agent_dir, "");
        assert_eq!(got.pi_session_dir, "");
        assert_eq!(got.gemini_dir, "");
        assert_eq!(got.continue_dir, "");
    }

    #[test]
    fn pi_roots_default_to_agent_subdir() {
        // Pi's own getAgentDir() is join(homedir(), ".pi", "agent") — the
        // config dir is NOT `~/.pi`, and sessions hang off the agent dir.
        let got = unix_roots(RootEnv::default());
        assert_eq!(got.pi_agent_dir, "/h/.pi/agent");
        assert_eq!(got.pi_session_dir, "/h/.pi/agent/sessions");
    }

    #[test]
    fn pi_agent_dir_override_moves_sessions_with_it() {
        let got = unix_roots(RootEnv {
            pi_coding_agent_dir: Some("/custom/pi-agent".to_string()),
            ..RootEnv::default()
        });
        assert_eq!(got.pi_agent_dir, "/custom/pi-agent");
        assert_eq!(got.pi_session_dir, "/custom/pi-agent/sessions");
    }

    #[test]
    fn pi_session_dir_override_is_independent_of_agent_dir() {
        let got = unix_roots(RootEnv {
            pi_coding_agent_dir: Some("/custom/pi-agent".to_string()),
            pi_coding_agent_session_dir: Some("/elsewhere/sessions".to_string()),
            ..RootEnv::default()
        });
        assert_eq!(got.pi_agent_dir, "/custom/pi-agent");
        assert_eq!(got.pi_session_dir, "/elsewhere/sessions");
    }

    #[test]
    fn pi_roots_stay_home_relative_on_windows() {
        // Pi has no XDG/APPDATA convention — `.pi/agent` is home-relative on
        // every OS, same as Claude and Codex.
        let got = vendor_roots_from(
            RootEnv::default(),
            Some(PathBuf::from("C:\\Users\\u")),
            Some(PathBuf::from("C:\\Users\\u\\AppData\\Roaming")),
            Some(PathBuf::from("C:\\Users\\u\\AppData\\Roaming")),
            true,
        );
        assert!(got.pi_agent_dir.ends_with("agent"));
        assert!(got.pi_agent_dir.contains(".pi"));
        assert!(!got.pi_agent_dir.contains("AppData"));
    }

    #[test]
    fn vendor_roots_serialize_camel_case() {
        let json = serde_json::to_value(unix_roots(RootEnv::default())).expect("serialize");
        assert!(json.get("claudeConfigDir").is_some());
        assert!(json.get("opencodeDataDir").is_some());
        // The TS mirror (lib/agent-roots/index.ts:asVendorRoots) narrows on
        // these exact camelCase keys; a rename here silently blanks them there.
        assert!(json.get("piAgentDir").is_some());
        assert!(json.get("piSessionDir").is_some());
    }

    #[test]
    fn spec_for_pi_is_writable_user_settings() {
        let spec = spec_for("pi").expect("pi spec");
        assert!(spec.writable);
        assert_eq!(spec.format, AgentFormat::Json);
        let path = spec.path.expect("pi path");
        assert!(path.ends_with("settings.json"));
        assert!(
            path.to_string_lossy().contains(".pi") || std::env::var("PI_CODING_AGENT_DIR").is_ok()
        );
    }

    /// The MCP file sits beside `settings.json` in the same Pi agent dir, so
    /// relocating the dir must move both. A hard-coded `~/.pi/agent/mcp.json`
    /// here would write into a directory Pi is not reading.
    #[test]
    fn spec_for_pi_mcp_adapter_is_the_user_scope_mcp_file() {
        let spec = spec_for("pi-mcp-adapter").expect("pi-mcp-adapter spec");
        assert!(spec.writable);
        assert_eq!(spec.format, AgentFormat::Json);
        let mcp = spec.path.expect("pi-mcp-adapter path");
        assert!(mcp.ends_with("mcp.json"));

        let settings = spec_for("pi").expect("pi spec").path.expect("pi path");
        assert_eq!(mcp.parent(), settings.parent());
    }

    #[test]
    fn spec_for_cognia_is_writable_json_mcp_file() {
        let spec = spec_for("cognia").expect("cognia spec");
        assert!(spec.writable);
        assert_eq!(spec.format, AgentFormat::Json);
        let path = spec.path.expect("cognia path");
        assert!(path.ends_with("mcp.json"));
        assert!(path.to_string_lossy().contains(".cognia") || std::env::var("COGNIA_HOME").is_ok());
    }

    #[test]
    fn spec_for_unknown_is_none() {
        assert!(spec_for("not-an-agent").is_none());
    }

    #[test]
    fn spec_for_zed_is_writable_jsonc_settings_file() {
        let spec = spec_for("zed").expect("zed spec");
        assert!(spec.writable);
        // settings.json allows comments, so it must round-trip as JSONC.
        assert_eq!(spec.format, AgentFormat::Jsonc);
        let path = spec.path.expect("zed path");
        assert!(path.ends_with("settings.json"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn zed_uses_dot_config_on_macos_not_application_support() {
        // Zed deliberately reads ~/.config/zed on macOS; resolving it via
        // dirs::config_dir() would wrongly land in Application Support.
        let path = spec_for("zed").expect("zed spec").path.expect("zed path");
        let shown = path.to_string_lossy();
        assert!(
            shown.contains(".config/zed"),
            "unexpected zed path: {shown}"
        );
        assert!(!shown.contains("Application Support"));
    }

    #[test]
    fn spec_for_kiro_is_writable_json_under_settings() {
        let spec = spec_for("kiro").expect("kiro spec");
        assert!(spec.writable);
        assert_eq!(spec.format, AgentFormat::Json);
        let path = spec.path.expect("kiro path");
        assert!(path.ends_with("mcp.json"));
        assert!(path.to_string_lossy().contains(".kiro"));
    }

    #[test]
    fn spec_for_opencode_is_writable_json() {
        let spec = spec_for("opencode").expect("opencode spec");
        assert!(spec.writable);
        assert_eq!(spec.format, AgentFormat::Json);
        let path = spec.path.expect("opencode path");
        assert!(path.ends_with("opencode.json"));
        assert!(path.to_string_lossy().contains("opencode"));
    }
}
