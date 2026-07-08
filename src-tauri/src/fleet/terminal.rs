//! Dispatch-source (terminal) identification for fleet sessions.
//!
//! Hook scripts forward a whitelist of environment variables inherited from
//! the agent process (`TERM_PROGRAM`, `ITERM_SESSION_ID`, `VSCODE_PID`…).
//! Those identify the terminal emulator / editor the user launched the agent
//! from. Pure functions — the sysinfo parent-chain fallback (P2) plugs in on
//! top when env vars are inconclusive.

use serde::Serialize;
use std::collections::HashMap;

/// Stable identifier for a terminal app — the TS mirror maps these to icons
/// and localized labels (`components/fleet/terminal-badge.tsx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalApp {
    Iterm,
    AppleTerminal,
    Ghostty,
    Vscode,
    Warp,
    Kitty,
    Alacritty,
    Wezterm,
    Tmux,
    WindowsTerminal,
    Jetbrains,
    Cursor,
    Unknown,
}

/// Where a session was dispatched from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSource {
    pub app: TerminalApp,
    /// Display label as reported by the environment (`TERM_PROGRAM` value or
    /// the app product name) — shown verbatim when `app` is `Unknown`.
    pub label: String,
    /// Terminal-native session/window id when the emulator exposes one
    /// (iTerm tab/session GUID, kitty window id…). Reserved for the P2
    /// focus action.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<String>,
}

/// Classify from hook-captured env vars. Returns `None` when nothing in the
/// environment identifies a terminal (e.g. launched by a daemon).
pub fn classify_terminal(env: &HashMap<String, String>) -> Option<TerminalSource> {
    let get = |k: &str| env.get(k).map(String::as_str).filter(|v| !v.is_empty());

    // Editor integrations first: VS Code's integrated terminal also sets
    // TERM_PROGRAM=vscode, but Cursor masquerades similarly — check the
    // more specific markers before the generic TERM_PROGRAM switch.
    if get("CURSOR_TRACE_ID").is_some() {
        return Some(source(TerminalApp::Cursor, "Cursor", None));
    }
    if let Some(tp) = get("TERM_PROGRAM") {
        let lowered = tp.to_ascii_lowercase();
        let known = match lowered.as_str() {
            "iterm.app" => Some((TerminalApp::Iterm, "iTerm2")),
            "apple_terminal" => Some((TerminalApp::AppleTerminal, "Terminal")),
            "ghostty" => Some((TerminalApp::Ghostty, "Ghostty")),
            "vscode" => Some((TerminalApp::Vscode, "VS Code")),
            "warpterminal" | "warp" => Some((TerminalApp::Warp, "Warp")),
            "wezterm" => Some((TerminalApp::Wezterm, "WezTerm")),
            "tmux" => Some((TerminalApp::Tmux, "tmux")),
            _ => None,
        };
        if let Some((app, label)) = known {
            let session_ref = match app {
                TerminalApp::Iterm => get("ITERM_SESSION_ID").map(str::to_owned),
                TerminalApp::AppleTerminal => get("TERM_SESSION_ID").map(str::to_owned),
                _ => None,
            };
            return Some(source(app, label, session_ref));
        }
        // Unrecognized TERM_PROGRAM: keep the raw name so the row still says
        // something meaningful instead of hiding the source.
        return Some(source(TerminalApp::Unknown, tp, None));
    }

    // Emulators that don't set TERM_PROGRAM.
    if let Some(id) = get("KITTY_WINDOW_ID") {
        return Some(source(TerminalApp::Kitty, "kitty", Some(id.to_owned())));
    }
    if get("ALACRITTY_SOCKET").is_some() || get("ALACRITTY_LOG").is_some() {
        return Some(source(TerminalApp::Alacritty, "Alacritty", None));
    }
    if get("GHOSTTY_RESOURCES_DIR").is_some() {
        return Some(source(TerminalApp::Ghostty, "Ghostty", None));
    }
    if let Some(id) = get("WT_SESSION") {
        return Some(source(
            TerminalApp::WindowsTerminal,
            "Windows Terminal",
            Some(id.to_owned()),
        ));
    }
    if get("VSCODE_PID").is_some() || get("VSCODE_BASH_ENV").is_some() {
        return Some(source(TerminalApp::Vscode, "VS Code", None));
    }
    if get("TERMINAL_EMULATOR").is_some_and(|v| v.contains("JetBrains")) {
        return Some(source(TerminalApp::Jetbrains, "JetBrains IDE", None));
    }

    None
}

fn source(app: TerminalApp, label: impl Into<String>, session_ref: Option<String>) -> TerminalSource {
    TerminalSource {
        app,
        label: label.into(),
        session_ref,
    }
}

/// Pure process-name matcher for the parent-chain fallback: when the hook's
/// env carries no terminal marker (e.g. an agent launched through a wrapper
/// that scrubbed the environment), walking the agent pid's ancestors and
/// matching their executable names still identifies the terminal app.
pub fn classify_process_name(name: &str) -> Option<TerminalApp> {
    let lowered = name.to_ascii_lowercase();
    // Order matters: more specific names first (e.g. "cursor" before the
    // generic Electron helpers it shares with VS Code).
    const TABLE: &[(&str, TerminalApp)] = &[
        ("iterm", TerminalApp::Iterm),
        // Before the bare "terminal" catch: "windowsterminal" contains it.
        ("windowsterminal", TerminalApp::WindowsTerminal),
        ("wt.exe", TerminalApp::WindowsTerminal),
        ("terminal", TerminalApp::AppleTerminal),
        ("ghostty", TerminalApp::Ghostty),
        ("cursor", TerminalApp::Cursor),
        ("code helper", TerminalApp::Vscode),
        ("electron", TerminalApp::Vscode),
        ("warp", TerminalApp::Warp),
        ("kitty", TerminalApp::Kitty),
        ("alacritty", TerminalApp::Alacritty),
        ("wezterm", TerminalApp::Wezterm),
    ];
    TABLE
        .iter()
        .find(|(needle, _)| lowered.contains(needle))
        .map(|(_, app)| *app)
}

/// Display label for a parent-chain classification (env-classified sources
/// carry richer labels; this is the fallback spelling).
pub fn default_label(app: TerminalApp) -> &'static str {
    match app {
        TerminalApp::Iterm => "iTerm2",
        TerminalApp::AppleTerminal => "Terminal",
        TerminalApp::Ghostty => "Ghostty",
        TerminalApp::Vscode => "VS Code",
        TerminalApp::Warp => "Warp",
        TerminalApp::Kitty => "kitty",
        TerminalApp::Alacritty => "Alacritty",
        TerminalApp::Wezterm => "WezTerm",
        TerminalApp::Tmux => "tmux",
        TerminalApp::WindowsTerminal => "Windows Terminal",
        TerminalApp::Jetbrains => "JetBrains IDE",
        TerminalApp::Cursor => "Cursor",
        TerminalApp::Unknown => "Terminal",
    }
}

/// Walk the agent pid's ancestors (up to 12 levels) and classify the first
/// recognizable terminal/editor process. Live-system I/O — not unit-tested
/// beyond the pure matcher above (same convention as `perf/process.rs`).
pub fn classify_from_pid(agent_pid: u32) -> Option<TerminalSource> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
    let mut pid = Pid::from_u32(agent_pid);
    for _ in 0..12 {
        let process = system.process(pid)?;
        if let Some(app) = classify_process_name(&process.name().to_string_lossy()) {
            return Some(TerminalSource {
                app,
                label: default_label(app).to_string(),
                session_ref: None,
            });
        }
        pid = process.parent()?;
    }
    None
}

/// The env-var whitelist hook scripts capture — single source of truth used
/// by the script generator (`install.rs`) so classifier and capture never
/// drift apart.
pub const CAPTURED_ENV_VARS: &[&str] = &[
    "TERM_PROGRAM",
    "TERM_SESSION_ID",
    "ITERM_SESSION_ID",
    "GHOSTTY_RESOURCES_DIR",
    "KITTY_WINDOW_ID",
    "ALACRITTY_SOCKET",
    "ALACRITTY_LOG",
    "WT_SESSION",
    "VSCODE_PID",
    "VSCODE_BASH_ENV",
    "CURSOR_TRACE_ID",
    "TERMINAL_EMULATOR",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn classifies_iterm_with_session_ref() {
        let env = env_of(&[
            ("TERM_PROGRAM", "iTerm.app"),
            ("ITERM_SESSION_ID", "w0t2p0:GUID"),
        ]);
        let src = classify_terminal(&env).unwrap();
        assert_eq!(src.app, TerminalApp::Iterm);
        assert_eq!(src.label, "iTerm2");
        assert_eq!(src.session_ref.as_deref(), Some("w0t2p0:GUID"));
    }

    #[test]
    fn classifies_common_term_programs() {
        for (value, app, label) in [
            ("Apple_Terminal", TerminalApp::AppleTerminal, "Terminal"),
            ("ghostty", TerminalApp::Ghostty, "Ghostty"),
            ("vscode", TerminalApp::Vscode, "VS Code"),
            ("WarpTerminal", TerminalApp::Warp, "Warp"),
            ("WezTerm", TerminalApp::Wezterm, "WezTerm"),
            ("tmux", TerminalApp::Tmux, "tmux"),
        ] {
            let env = env_of(&[("TERM_PROGRAM", value)]);
            let src = classify_terminal(&env).unwrap();
            assert_eq!(src.app, app, "{value}");
            assert_eq!(src.label, label, "{value}");
        }
    }

    #[test]
    fn unknown_term_program_keeps_raw_label() {
        let env = env_of(&[("TERM_PROGRAM", "SomeNewTerm")]);
        let src = classify_terminal(&env).unwrap();
        assert_eq!(src.app, TerminalApp::Unknown);
        assert_eq!(src.label, "SomeNewTerm");
    }

    #[test]
    fn classifies_no_term_program_emulators() {
        let kitty = classify_terminal(&env_of(&[("KITTY_WINDOW_ID", "3")])).unwrap();
        assert_eq!(kitty.app, TerminalApp::Kitty);
        assert_eq!(kitty.session_ref.as_deref(), Some("3"));

        let ala = classify_terminal(&env_of(&[("ALACRITTY_SOCKET", "/tmp/a.sock")])).unwrap();
        assert_eq!(ala.app, TerminalApp::Alacritty);

        let ghostty = classify_terminal(&env_of(&[("GHOSTTY_RESOURCES_DIR", "/Applications/…")]))
            .unwrap();
        assert_eq!(ghostty.app, TerminalApp::Ghostty);

        let wt = classify_terminal(&env_of(&[("WT_SESSION", "guid")])).unwrap();
        assert_eq!(wt.app, TerminalApp::WindowsTerminal);

        let code = classify_terminal(&env_of(&[("VSCODE_PID", "4242")])).unwrap();
        assert_eq!(code.app, TerminalApp::Vscode);

        let jb = classify_terminal(&env_of(&[("TERMINAL_EMULATOR", "JetBrains-JediTerm")]))
            .unwrap();
        assert_eq!(jb.app, TerminalApp::Jetbrains);
    }

    #[test]
    fn cursor_marker_wins_over_vscode_term_program() {
        let env = env_of(&[("TERM_PROGRAM", "vscode"), ("CURSOR_TRACE_ID", "t")]);
        assert_eq!(classify_terminal(&env).unwrap().app, TerminalApp::Cursor);
    }

    #[test]
    fn empty_env_yields_none() {
        assert!(classify_terminal(&HashMap::new()).is_none());
        // Empty values don't count either.
        assert!(classify_terminal(&env_of(&[("TERM_PROGRAM", "")])).is_none());
    }

    #[test]
    fn captured_whitelist_covers_classifier_inputs() {
        // Every env var the classifier reads must be in the capture whitelist,
        // or the hook script would never send it.
        for key in [
            "TERM_PROGRAM",
            "TERM_SESSION_ID",
            "ITERM_SESSION_ID",
            "GHOSTTY_RESOURCES_DIR",
            "KITTY_WINDOW_ID",
            "ALACRITTY_SOCKET",
            "WT_SESSION",
            "VSCODE_PID",
            "CURSOR_TRACE_ID",
            "TERMINAL_EMULATOR",
        ] {
            assert!(CAPTURED_ENV_VARS.contains(&key), "{key} missing");
        }
    }

    #[test]
    fn classify_process_name_matches_known_binaries() {
        for (name, app) in [
            ("iTerm2", TerminalApp::Iterm),
            ("Terminal", TerminalApp::AppleTerminal),
            ("ghostty", TerminalApp::Ghostty),
            ("Code Helper (Renderer)", TerminalApp::Vscode),
            ("Electron", TerminalApp::Vscode),
            ("Cursor Helper", TerminalApp::Cursor),
            ("warp", TerminalApp::Warp),
            ("kitty", TerminalApp::Kitty),
            ("alacritty", TerminalApp::Alacritty),
            ("wezterm-gui", TerminalApp::Wezterm),
            ("WindowsTerminal.exe", TerminalApp::WindowsTerminal),
        ] {
            assert_eq!(classify_process_name(name), Some(app), "{name}");
        }
        assert_eq!(classify_process_name("zsh"), None);
        assert_eq!(classify_process_name("node"), None);
        assert_eq!(classify_process_name("claude"), None);
    }

    #[test]
    fn default_label_covers_every_app() {
        // Smoke: every variant yields a non-empty label.
        for app in [
            TerminalApp::Iterm,
            TerminalApp::AppleTerminal,
            TerminalApp::Ghostty,
            TerminalApp::Vscode,
            TerminalApp::Warp,
            TerminalApp::Kitty,
            TerminalApp::Alacritty,
            TerminalApp::Wezterm,
            TerminalApp::Tmux,
            TerminalApp::WindowsTerminal,
            TerminalApp::Jetbrains,
            TerminalApp::Cursor,
            TerminalApp::Unknown,
        ] {
            assert!(!default_label(app).is_empty());
        }
    }

    #[test]
    fn terminal_source_serializes_camel_and_kebab() {
        let src = source(TerminalApp::AppleTerminal, "Terminal", Some("id".into()));
        let json = serde_json::to_value(&src).unwrap();
        assert_eq!(json["app"], "apple-terminal");
        assert_eq!(json["label"], "Terminal");
        assert_eq!(json["sessionRef"], "id");
        let bare = source(TerminalApp::Ghostty, "Ghostty", None);
        let json = serde_json::to_value(&bare).unwrap();
        assert!(json.get("sessionRef").is_none());
    }
}
