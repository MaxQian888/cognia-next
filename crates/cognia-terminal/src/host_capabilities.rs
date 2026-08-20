//! What the terminal host can tell a *remote* client about itself.
//!
//! The renderer used to guess the shell to spawn from `navigator.userAgent`
//! (`lib/terminal/shell-detect.ts`). On the desktop that is correct by
//! accident — the client and the host are the same machine. Over `ws` /
//! `webrtc` they are not: a macOS browser paired to a Linux `cognia-server`
//! asked it for `/bin/zsh`, and a Windows browser asked for `pwsh.exe`. The
//! host answered the only way it could, by failing the spawn.
//!
//! So the host now says what it is. [`TerminalHostCapabilities`] rides along
//! with the `Ack` (hello) and `HostSnapshot` (list) payloads, which is every
//! frame a client already receives before it can spawn anything — no extra
//! round-trip, and an older client that ignores the field keeps its previous
//! behaviour.
//!
//! Discovery is cached for the process lifetime: which shells exist on a
//! server does not change while it runs, and `List` is on the reattach path
//! where a filesystem probe per frame would be paid on every page load.

use std::path::Path;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Host operating system family. The four values mirror the renderer's
/// `ShellPlatform` union so the two sides need no translation table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostPlatform {
    Windows,
    Macos,
    Linux,
    Other,
}

impl HostPlatform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

/// One shell the host can actually spawn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostShellCandidate {
    /// Absolute path (unix) or PATH-resolvable name (Windows) to pass as
    /// [`crate::session::SpawnRequest::shell`].
    pub path: String,
    /// Shell family — the same vocabulary as the renderer's `ShellKind`
    /// (`bash`, `zsh`, `sh`, `fish`, `nu`, `pwsh`, `powershell`, `cmd`).
    pub kind: String,
}

/// What a remote client needs to know before it can spawn on this host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHostCapabilities {
    pub platform: HostPlatform,
    /// The shell a client should use when the user has expressed no
    /// preference. Never empty.
    pub default_shell: String,
    /// Every shell found on this host, default first. May be empty on an
    /// unusual system — a client must still allow a hand-typed path.
    pub available_shells: Vec<HostShellCandidate>,
    /// The host user's home directory, for rendering `~`-relative cwds.
    pub home_dir: Option<String>,
}

/// Ordered shell candidates for the current platform. Absolute paths are
/// probed with `exists()`; bare names are probed against `PATH`.
fn shell_candidates() -> &'static [(&'static str, &'static str)] {
    #[cfg(windows)]
    {
        &[
            ("pwsh.exe", "pwsh"),
            ("powershell.exe", "powershell"),
            ("cmd.exe", "cmd"),
            ("bash.exe", "bash"),
        ]
    }
    #[cfg(not(windows))]
    {
        &[
            ("/bin/zsh", "zsh"),
            ("/bin/bash", "bash"),
            ("/usr/bin/zsh", "zsh"),
            ("/usr/bin/bash", "bash"),
            ("/usr/bin/fish", "fish"),
            ("/usr/local/bin/fish", "fish"),
            ("/opt/homebrew/bin/fish", "fish"),
            ("/usr/bin/nu", "nu"),
            ("/usr/local/bin/nu", "nu"),
            ("/opt/homebrew/bin/nu", "nu"),
            ("/usr/bin/pwsh", "pwsh"),
            ("/usr/local/bin/pwsh", "pwsh"),
            ("/bin/sh", "sh"),
        ]
    }
}

/// True when `candidate` names something this host can execute.
fn candidate_exists(candidate: &str) -> bool {
    let path = Path::new(candidate);
    if path.is_absolute() {
        return path.exists();
    }
    // Bare name (Windows): a PATH prefix scan is cheaper and more accurate
    // than reimplementing `PATHEXT` resolution here.
    let stem = candidate
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(candidate)
        .trim_end_matches(".exe");
    let path_value = std::env::var("PATH").unwrap_or_default();
    crate::path_scan::list_path_executables_inner(&path_value, stem, 8)
        .iter()
        .any(|name| name.eq_ignore_ascii_case(stem))
}

/// The host user's login shell, when the environment names one that exists.
///
/// Preferred over the platform guess: on a server the operator's `$SHELL` is
/// what "open a terminal here" means, and it is frequently neither `/bin/bash`
/// nor `/bin/zsh` (Alpine images ship `/bin/ash`, some hosts default to fish).
fn login_shell() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").ok()?;
    let shell = shell.trim();
    if shell.is_empty() || !Path::new(shell).exists() {
        return None;
    }
    Some(shell.to_string())
}

fn detect() -> TerminalHostCapabilities {
    let mut available: Vec<HostShellCandidate> = shell_candidates()
        .iter()
        .filter(|(path, _)| candidate_exists(path))
        .map(|(path, kind)| HostShellCandidate {
            path: (*path).to_string(),
            kind: (*kind).to_string(),
        })
        .collect();

    // `$SHELL` wins, and is inserted into the list when the static candidate
    // table missed it (a custom-built shell, a Nix profile path, …).
    let default_shell = match login_shell() {
        Some(shell) => {
            if !available.iter().any(|entry| entry.path == shell) {
                let kind = shell_kind_of(&shell);
                available.insert(
                    0,
                    HostShellCandidate {
                        path: shell.clone(),
                        kind,
                    },
                );
            }
            shell
        }
        None => available
            .first()
            .map(|entry| entry.path.clone())
            .unwrap_or_else(crate::headless::default_headless_shell),
    };

    // Default first, so a client can render the list without re-sorting.
    if let Some(index) = available
        .iter()
        .position(|entry| entry.path == default_shell)
    {
        let entry = available.remove(index);
        available.insert(0, entry);
    }

    TerminalHostCapabilities {
        platform: HostPlatform::current(),
        default_shell,
        available_shells: available,
        home_dir: dirs::home_dir().map(|path| path.to_string_lossy().into_owned()),
    }
}

/// Classify a shell path into the renderer's `ShellKind` vocabulary. Mirrors
/// `lib/terminal/shell-detect.ts:detectShellKind` and the Rust
/// `integration::ShellKind::from_shell_path`.
fn shell_kind_of(shell: &str) -> String {
    let base = shell
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(shell)
        .to_ascii_lowercase();
    let base = base.trim_end_matches(".exe");
    match base {
        "bash" => "bash",
        "zsh" => "zsh",
        "sh" | "dash" | "ash" => "sh",
        "pwsh" => "pwsh",
        "powershell" => "powershell",
        "cmd" => "cmd",
        "fish" => "fish",
        "nu" | "nushell" => "nu",
        _ => "unknown",
    }
    .to_string()
}

/// This host's capabilities. Computed once per process — see the module note.
pub fn host_capabilities() -> &'static TerminalHostCapabilities {
    static CACHE: OnceLock<TerminalHostCapabilities> = OnceLock::new();
    CACHE.get_or_init(detect)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_always_name_a_spawnable_default_shell() {
        let capabilities = host_capabilities();
        assert!(
            !capabilities.default_shell.trim().is_empty(),
            "a client with no user preference has nothing to spawn"
        );
    }

    #[test]
    fn the_default_shell_leads_the_available_list_when_it_is_in_it() {
        let capabilities = host_capabilities();
        if capabilities
            .available_shells
            .iter()
            .any(|entry| entry.path == capabilities.default_shell)
        {
            assert_eq!(
                capabilities.available_shells[0].path, capabilities.default_shell,
                "clients render this list in order and expect the default first"
            );
        }
    }

    #[test]
    fn every_advertised_shell_exists_on_this_host() {
        for entry in &host_capabilities().available_shells {
            assert!(
                candidate_exists(&entry.path),
                "advertised {} does not exist — a client would spawn into a failure",
                entry.path
            );
        }
    }

    #[test]
    fn platform_matches_the_compile_target() {
        let expected = if cfg!(windows) {
            HostPlatform::Windows
        } else if cfg!(target_os = "macos") {
            HostPlatform::Macos
        } else if cfg!(target_os = "linux") {
            HostPlatform::Linux
        } else {
            HostPlatform::Other
        };
        assert_eq!(host_capabilities().platform, expected);
    }

    #[test]
    fn platform_serializes_to_the_renderer_vocabulary() {
        assert_eq!(
            serde_json::to_string(&HostPlatform::Macos).unwrap(),
            "\"macos\""
        );
        assert_eq!(
            serde_json::to_string(&HostPlatform::Windows).unwrap(),
            "\"windows\""
        );
    }

    #[test]
    fn shell_kind_mirrors_the_renderer_classifier() {
        assert_eq!(shell_kind_of("/bin/zsh"), "zsh");
        assert_eq!(shell_kind_of("/usr/bin/dash"), "sh");
        assert_eq!(shell_kind_of("/bin/ash"), "sh");
        assert_eq!(
            shell_kind_of(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            "pwsh"
        );
        assert_eq!(shell_kind_of("nushell"), "nu");
        assert_eq!(shell_kind_of("/opt/weird/xonsh"), "unknown");
    }
}
