//! Terminal multiplexer detection and tmux enumeration.
//!
//! The Rust half of `lib/terminal/multiplexer.ts`, which has been calling
//! these three commands since it was written and getting a dispatch error
//! every time: they were never registered. The TypeScript side already fixes
//! the wire shape (`MultiplexerInfo`, `TmuxSession`, `TmuxWindow`) and its
//! pure parsers are unit-tested, so this implements that contract rather than
//! proposing a new one.
//!
//! ## Two different questions
//!
//! [`detect_multiplexer`] answers "was THIS process launched from inside a
//! multiplexer", by reading the environment the app inherited. That is a real
//! answer and a narrow one: a tmux the user starts inside the integrated
//! terminal is a child of the PTY, not of this process, so it does not appear
//! here. The renderer uses the answer to decide whether to offer detach and
//! attach affordances for the session it is already in.
//!
//! [`list_tmux_sessions`] asks the tmux *server*, so it works whether or not
//! this process is inside one. That is the enumeration the session picker
//! needs, and it is why the two are separate commands rather than one call
//! that returns everything.
//!
//! ## Why shelling out
//!
//! tmux has no stable C ABI or IPC contract, and its control mode
//! (`tmux -CC`) is a long-lived interactive protocol built for terminal
//! emulators that host a tmux client. The documented, version-stable way to
//! ask a one-shot question is `list-sessions -F`, whose format variables are
//! part of tmux's public interface. Every field below is one of those
//! variables, so the parsing is a tab split rather than a regex over
//! human-readable output. `lib/terminal/multiplexer.ts` keeps its
//! `parseTmuxSessionList` / `parseTmuxWindowList` for the other direction
//! (text a user pasted out of a terminal), and those stay untouched.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

/// A tmux query is a local socket round-trip. A budget exists so a wedged or
/// half-dead server cannot pin the caller, not because the call is slow.
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);

/// Field separator for the `-F` format strings.
///
/// A tab rather than a comma or a colon: a tmux session or window name may
/// contain almost anything a user can type, including both of those, but tmux
/// itself rejects a tab in a session name (`new-session -s` refuses it), so
/// this is the one separator that cannot appear inside a field.
const SEP: char = '\t';

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplexerInfo {
    /// `tmux` | `screen` | `zellij` | `none`.
    #[serde(rename = "type")]
    pub kind: String,
    /// The multiplexer's socket or session identifier, as the environment
    /// reports it. `None` when nothing was detected.
    pub socket_path: Option<String>,
    /// Version string when one is cheap to obtain. `None` is not "unknown
    /// multiplexer", it is "we did not ask", and the renderer treats it that
    /// way.
    pub version: Option<String>,
}

impl MultiplexerInfo {
    fn none() -> Self {
        Self {
            kind: "none".to_string(),
            socket_path: None,
            version: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub name: String,
    pub window_count: u32,
    pub attached: bool,
    /// Creation time in unix SECONDS. tmux reports seconds and the renderer
    /// multiplies, so converting here would double-apply.
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWindow {
    pub index: u32,
    pub name: String,
    pub active: bool,
    pub pane_count: u32,
}

/// Classify an environment map into a multiplexer.
///
/// Pure, and a direct mirror of `detectMultiplexerFromEnv` in
/// `lib/terminal/multiplexer.ts` so the two hosts cannot disagree about what
/// counts as "inside tmux".
///
/// Order matters and is not alphabetical. `TMUX` wins because a zellij or
/// screen session running inside tmux still has `TMUX` set, and the outermost
/// multiplexer is the one whose detach and attach commands actually apply.
/// `TERM=screen-256color` is deliberately NOT consulted: tmux sets it too, and
/// so do plenty of emulators that are neither, so it identifies a terminfo
/// entry rather than a multiplexer.
///
/// ## What this cannot tell you
///
/// Nesting. A shell inside zellij-inside-tmux inherits `TMUX` and `ZELLIJ`
/// both, and so does a shell inside tmux-inside-zellij: the variables record
/// which multiplexers are in the ancestry, never their order. This returns the
/// outer one by the fixed precedence above, which is right for the first case
/// and wrong for the second, and no reading of the environment alone can
/// separate them. Answering it properly means walking the process tree.
///
/// That is tolerable only because the answer is descriptive today. Nothing
/// dispatches a detach or an attach from it, and `list_tmux_sessions` asks tmux
/// directly rather than trusting this. Before anything acts on the result, the
/// ambiguity has to be resolved rather than documented.
pub fn classify_env(env: &HashMap<String, String>) -> MultiplexerInfo {
    let non_empty = |key: &str| env.get(key).filter(|value| !value.is_empty()).cloned();

    if let Some(tmux) = non_empty("TMUX") {
        // `$TMUX` is `<socket-path>,<server-pid>,<session-index>`. Only the
        // socket path identifies the server, which is what a later
        // `tmux -S <path>` would need.
        let socket = tmux.split(',').next().unwrap_or(&tmux).to_string();
        return MultiplexerInfo {
            kind: "tmux".to_string(),
            socket_path: Some(socket),
            version: None,
        };
    }
    if let Some(sty) = non_empty("STY") {
        // GNU screen's `$STY` is `<pid>.<tty>.<host>`, a session name rather
        // than a path. Reported verbatim because that is what
        // `screen -r <name>` takes.
        return MultiplexerInfo {
            kind: "screen".to_string(),
            socket_path: Some(sty),
            version: None,
        };
    }
    if let Some(zellij) = non_empty("ZELLIJ") {
        return MultiplexerInfo {
            kind: "zellij".to_string(),
            socket_path: Some(zellij),
            version: non_empty("ZELLIJ_VERSION"),
        };
    }
    MultiplexerInfo::none()
}

/// Detect the multiplexer this process was launched from, filling in a
/// version when the binary can answer for one.
pub async fn detect_multiplexer() -> MultiplexerInfo {
    let env: HashMap<String, String> = std::env::vars().collect();
    let mut info = classify_env(&env);
    if info.version.is_none() {
        let program = match info.kind.as_str() {
            "tmux" => Some("tmux"),
            "screen" => Some("screen"),
            // zellij already reported its own version through `ZELLIJ_VERSION`
            // when it set `ZELLIJ`, so asking the binary adds a spawn for
            // nothing.
            _ => None,
        };
        if let Some(program) = program {
            info.version = probe_version(program).await;
        }
    }
    info
}

/// `<program> -V`, trimmed. `None` on any failure, because a missing version
/// must not turn a detected multiplexer into an undetected one.
async fn probe_version(program: &str) -> Option<String> {
    let output = run(program, &["-V".to_string()]).await.ok()?;
    let text = output.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// Every session the tmux server knows about.
///
/// An empty vector covers three states the caller cannot act on differently:
/// tmux is not installed, no server is running, and a server with no sessions.
/// The renderer's own contract already collapses them (its catch returns
/// `[]`), and a session picker showing "none" is the right rendering of all
/// three.
pub async fn list_tmux_sessions() -> Vec<TmuxSession> {
    let format = [
        "#{session_name}",
        "#{session_windows}",
        "#{session_attached}",
        "#{session_created}",
    ]
    .join(&SEP.to_string());
    let Ok(output) = run("tmux", &["list-sessions".into(), "-F".into(), format]).await else {
        return Vec::new();
    };
    output.lines().filter_map(parse_session_line).collect()
}

/// Every window in `session_name`.
///
/// The name is passed as an argv element, never interpolated into a shell
/// string, so a session called `; rm -rf ~` is a session called `; rm -rf ~`.
pub async fn list_tmux_windows(session_name: &str) -> Vec<TmuxWindow> {
    let format = [
        "#{window_index}",
        "#{window_name}",
        "#{window_active}",
        "#{window_panes}",
    ]
    .join(&SEP.to_string());
    let args = [
        "list-windows".to_string(),
        "-t".to_string(),
        session_name.to_string(),
        "-F".to_string(),
        format,
    ];
    let Ok(output) = run("tmux", &args).await else {
        return Vec::new();
    };
    output.lines().filter_map(parse_window_line).collect()
}

/// Split one `-F` line into its four session fields.
///
/// Right-anchored (`rsplitn`) so a name containing the separator cannot shift
/// the numeric fields left and silently produce a session with the wrong
/// window count.
fn parse_session_line(line: &str) -> Option<TmuxSession> {
    let mut parts = line.rsplitn(4, SEP);
    let created_at = parts.next()?.trim().parse().ok()?;
    let attached: u32 = parts.next()?.trim().parse().ok()?;
    let window_count = parts.next()?.trim().parse().ok()?;
    let name = parts.next()?.to_string();
    if name.is_empty() {
        return None;
    }
    Some(TmuxSession {
        name,
        window_count,
        // `session_attached` is a CLIENT COUNT, not a flag. Comparing it to
        // zero is the whole conversion, and reading it as a boolean directly
        // would make "two clients attached" parse as false.
        attached: attached > 0,
        created_at,
    })
}

fn parse_window_line(line: &str) -> Option<TmuxWindow> {
    let mut parts = line.splitn(2, SEP);
    let index = parts.next()?.trim().parse().ok()?;
    let rest = parts.next()?;
    let mut tail = rest.rsplitn(3, SEP);
    let pane_count = tail.next()?.trim().parse().ok()?;
    let active: u32 = tail.next()?.trim().parse().ok()?;
    let name = tail.next()?.to_string();
    Some(TmuxWindow {
        index,
        name,
        active: active == 1,
        pane_count,
    })
}

/// Run a query and return its stdout, or an error string.
///
/// stdin is null so a binary that decides to prompt exits instead of hanging
/// on a terminal that is not there, and stderr is dropped: tmux writes "no
/// server running on /tmp/tmux-501/default" there, which is a normal state
/// rather than a fault worth surfacing.
async fn run(program: &str, args: &[String]) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let output = tokio::time::timeout(QUERY_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("{program} query timed out"))?
        .map_err(|error| format!("{program}: {error}"))?;
    if !output.status.success() {
        return Err(format!("{program} exited with {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------
//
// Thin wrappers, deliberately. `lib/terminal/multiplexer.ts` already wraps
// each of these in a try/catch that degrades to `{ type: "none" }` or `[]`,
// so the value of the command layer is the argument names on the wire and
// nothing else.

#[tauri::command]
pub async fn terminal_detect_multiplexer() -> Result<MultiplexerInfo, String> {
    Ok(detect_multiplexer().await)
}

#[tauri::command]
pub async fn terminal_list_tmux_sessions() -> Result<Vec<TmuxSession>, String> {
    Ok(list_tmux_sessions().await)
}

#[tauri::command]
pub async fn terminal_list_tmux_windows(session_name: String) -> Result<Vec<TmuxWindow>, String> {
    Ok(list_tmux_windows(&session_name).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn tmux_reports_only_the_socket_half_of_the_env_var() {
        let info = classify_env(&env(&[("TMUX", "/tmp/tmux-501/default,12345,0")]));
        assert_eq!(info.kind, "tmux");
        assert_eq!(info.socket_path.as_deref(), Some("/tmp/tmux-501/default"));
    }

    #[test]
    fn tmux_outranks_an_inner_multiplexer() {
        let info = classify_env(&env(&[
            ("TMUX", "/tmp/tmux-501/default,1,0"),
            ("ZELLIJ", "0"),
            ("STY", "1.pts-0.host"),
        ]));
        assert_eq!(info.kind, "tmux");
    }

    #[test]
    fn screen_and_zellij_are_recognised() {
        assert_eq!(classify_env(&env(&[("STY", "9.pts-3.box")])).kind, "screen");
        let zellij = classify_env(&env(&[("ZELLIJ", "0"), ("ZELLIJ_VERSION", "0.41.2")]));
        assert_eq!(zellij.kind, "zellij");
        assert_eq!(zellij.version.as_deref(), Some("0.41.2"));
    }

    /// An exported-but-empty variable is what a shell leaves behind after a
    /// detach. Treating it as presence reported a multiplexer that is gone.
    #[test]
    fn an_empty_variable_is_not_a_multiplexer() {
        assert_eq!(classify_env(&env(&[("TMUX", "")])).kind, "none");
        assert_eq!(classify_env(&env(&[("STY", "")])).kind, "none");
        assert_eq!(classify_env(&env(&[])).kind, "none");
    }

    /// `TERM` identifies a terminfo entry. tmux sets `screen-256color` and so
    /// do emulators that are not multiplexers at all.
    #[test]
    fn term_alone_never_counts() {
        assert_eq!(
            classify_env(&env(&[("TERM", "screen-256color")])).kind,
            "none"
        );
        assert_eq!(
            classify_env(&env(&[("TERM", "tmux-256color")])).kind,
            "none"
        );
    }

    #[test]
    fn session_line_parses_every_field() {
        let session = parse_session_line("work\t3\t1\t1723459200").expect("parsed");
        assert_eq!(
            session,
            TmuxSession {
                name: "work".to_string(),
                window_count: 3,
                attached: true,
                created_at: 1_723_459_200,
            }
        );
    }

    /// `session_attached` is a client count. Two attached clients is still
    /// attached, and reading the field as a flag would have said otherwise.
    #[test]
    fn two_clients_still_counts_as_attached() {
        let session = parse_session_line("work\t1\t2\t1").expect("parsed");
        assert!(session.attached);
        let detached = parse_session_line("idle\t1\t0\t1").expect("parsed");
        assert!(!detached.attached);
    }

    /// Right-anchored parsing: the three numeric fields are taken from the
    /// end, so a name that somehow contains the separator keeps them aligned
    /// instead of shifting the window count into the name.
    #[test]
    fn a_name_containing_the_separator_does_not_shift_the_numbers() {
        let session = parse_session_line("odd\tname\t7\t0\t42").expect("parsed");
        assert_eq!(session.name, "odd\tname");
        assert_eq!(session.window_count, 7);
        assert_eq!(session.created_at, 42);
    }

    #[test]
    fn a_malformed_line_is_dropped_rather_than_defaulted() {
        assert!(parse_session_line("").is_none());
        assert!(parse_session_line("only-a-name").is_none());
        assert!(parse_session_line("name\tnot-a-number\t0\t1").is_none());
        assert!(parse_window_line("nope").is_none());
    }

    #[test]
    fn window_line_parses_index_name_active_and_panes() {
        let window = parse_window_line("0\tzsh\t1\t2").expect("parsed");
        assert_eq!(
            window,
            TmuxWindow {
                index: 0,
                name: "zsh".to_string(),
                active: true,
                pane_count: 2,
            }
        );
        let inactive = parse_window_line("4\tbuild\t0\t1").expect("parsed");
        assert!(!inactive.active);
        assert_eq!(inactive.index, 4);
    }

    #[test]
    fn a_window_name_containing_the_separator_keeps_its_trailing_fields() {
        let window = parse_window_line("2\tnvim\tsplit\t1\t3").expect("parsed");
        assert_eq!(window.name, "nvim\tsplit");
        assert!(window.active);
        assert_eq!(window.pane_count, 3);
    }

    /// A missing binary must degrade to "no sessions", never to an error the
    /// renderer would render as a broken panel.
    #[tokio::test]
    async fn a_missing_binary_yields_an_empty_list() {
        assert!(run("cognia-no-such-binary-multiplexer", &[]).await.is_err());
    }
}
