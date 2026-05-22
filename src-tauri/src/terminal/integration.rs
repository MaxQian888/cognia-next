//! Shell-integration argv + env builder.
//!
//! Translates a recognised shell ("bash" / "zsh" / "pwsh" / "powershell")
//! into the argv + env tweaks that make our integration script run on
//! startup while still honoring the user's regular rc files. Mirrors
//! VS Code's approach where reasonable.
//!
//! Output is an `IntegrationSetup` value that the caller (`session.rs`)
//! applies to the `CommandBuilder`. The `tempdir` field on the setup
//! must outlive the spawned shell — keep it owned by the `PtySession`
//! so the `.zshrc` we wrote isn't deleted while zsh is still reading it.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Recognised shells. Anything else falls under `Unknown` and integration
/// is silently skipped (the shell is spawned without our env tweaks).
///
/// `from_shell_path` is the canonical recogniser — it strips the directory
/// + extension and lowercases, so `/usr/bin/zsh`, `C:\Program Files\PowerShell\7\pwsh.exe`,
/// and just `bash` all classify correctly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Bash,
    Zsh,
    Pwsh,
    PowerShell,
    /// Windows `cmd.exe`. Recognised explicitly so we don't fall through
    /// to `Unknown` (which would also work but loses the affordance to
    /// short-circuit "no integration possible" without filesystem
    /// probing). `build(Cmd, …)` returns an empty setup — cmd.exe has
    /// no rcfile mechanism we can hook.
    Cmd,
    Unknown,
}

impl ShellKind {
    pub fn from_shell_path(path: &str) -> Self {
        let stem = Path::new(path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match stem.as_str() {
            "bash" => ShellKind::Bash,
            "zsh" => ShellKind::Zsh,
            "pwsh" => ShellKind::Pwsh,
            "powershell" => ShellKind::PowerShell,
            "cmd" => ShellKind::Cmd,
            _ => ShellKind::Unknown,
        }
    }
}

/// Output of `build`. Caller applies `extra_args` after its own argv and
/// merges `env_overrides` into the spawn env. `tempdir`, when present,
/// must be kept alive for the lifetime of the PTY session.
pub struct IntegrationSetup {
    pub extra_args: Vec<String>,
    pub env_overrides: HashMap<String, String>,
    /// Holds onto any temp dir we created (e.g. zsh's ZDOTDIR). Drop
    /// removes it from disk — keep on the session.
    pub tempdir: Option<PathBuf>,
}

impl IntegrationSetup {
    /// Empty setup — caller spawns the shell with no integration tweaks.
    /// Used both for `ShellKind::Unknown` and when the caller wants
    /// integration disabled (e.g. settings toggle off).
    pub fn empty() -> Self {
        Self {
            extra_args: Vec::new(),
            env_overrides: HashMap::new(),
            tempdir: None,
        }
    }
}

/// Build the integration argv + env for `kind`.
///
/// * `script_dir` — directory containing `shell-integration.{bash,zsh,ps1}`.
///   Resolved by the caller via `app.path().resource_dir()` and joined
///   with `terminal/`. Missing files cause a silently-disabled spawn.
/// * `nonce` — per-spawn random string. Stamped into `$COGNIA_TERM_NONCE`
///   and verified by `osc633::Osc633Parser` so untrusted processes in the
///   PTY can't forge prompt decorations.
pub fn build(
    kind: ShellKind,
    script_dir: &Path,
    nonce: &str,
) -> io::Result<IntegrationSetup> {
    match kind {
        ShellKind::Bash => build_bash(script_dir, nonce),
        ShellKind::Zsh => build_zsh(script_dir, nonce),
        ShellKind::Pwsh | ShellKind::PowerShell => build_pwsh(script_dir, nonce),
        // cmd.exe + anything unrecognised both fall through to an empty
        // setup — the shell spawns normally without OSC 633 events.
        ShellKind::Cmd | ShellKind::Unknown => Ok(IntegrationSetup::empty()),
    }
}

fn build_bash(script_dir: &Path, nonce: &str) -> io::Result<IntegrationSetup> {
    let script = script_dir.join("shell-integration.bash");
    if !script.exists() {
        return Ok(IntegrationSetup::empty());
    }
    let mut env = HashMap::new();
    env.insert("COGNIA_TERM_NONCE".to_string(), nonce.to_string());
    // bash's `--rcfile` replaces ~/.bashrc; the script re-sources it.
    Ok(IntegrationSetup {
        extra_args: vec![
            "--rcfile".to_string(),
            script.to_string_lossy().into_owned(),
        ],
        env_overrides: env,
        tempdir: None,
    })
}

fn build_zsh(script_dir: &Path, nonce: &str) -> io::Result<IntegrationSetup> {
    let script = script_dir.join("shell-integration.zsh");
    if !script.exists() {
        return Ok(IntegrationSetup::empty());
    }
    // zsh has no --rcfile. We create a temp ZDOTDIR containing a tiny
    // .zshrc that re-sources the user's original config (via the
    // exported USER_ZDOTDIR) and then sources our integration script.
    let tempdir = std::env::temp_dir().join(format!("cognia-zdot-{nonce}"));
    fs::create_dir_all(&tempdir)?;
    let zshrc = tempdir.join(".zshrc");
    let script_str = script.to_string_lossy();
    let body = format!(
        r#"# Cognia zsh integration ZDOTDIR shim — auto-generated, do not edit
if [[ -n "$USER_ZDOTDIR" && -f "$USER_ZDOTDIR/.zshrc" ]]; then
  ZDOTDIR="$USER_ZDOTDIR" source "$USER_ZDOTDIR/.zshrc"
fi
source "{script}"
"#,
        script = script_str
    );
    fs::write(&zshrc, body)?;

    let mut env = HashMap::new();
    env.insert("COGNIA_TERM_NONCE".to_string(), nonce.to_string());
    // Preserve the user's ZDOTDIR (if any) so the shim above can resource it.
    if let Ok(prior) = std::env::var("ZDOTDIR") {
        env.insert("USER_ZDOTDIR".to_string(), prior);
    } else if let Ok(home) = std::env::var("HOME") {
        env.insert("USER_ZDOTDIR".to_string(), home);
    }
    env.insert("ZDOTDIR".to_string(), tempdir.to_string_lossy().into_owned());

    Ok(IntegrationSetup {
        extra_args: Vec::new(),
        env_overrides: env,
        tempdir: Some(tempdir),
    })
}

fn build_pwsh(script_dir: &Path, nonce: &str) -> io::Result<IntegrationSetup> {
    let script = script_dir.join("shell-integration.ps1");
    if !script.exists() {
        return Ok(IntegrationSetup::empty());
    }
    let mut env = HashMap::new();
    env.insert("COGNIA_TERM_NONCE".to_string(), nonce.to_string());
    // `-NoExit -Command "..."` runs the inline command then drops to the
    // interactive prompt. We dot-source $PROFILE first (with try/catch so
    // a missing/erroring profile doesn't abort) and then our integration
    // script.
    let script_str = script.to_string_lossy();
    let cmd = format!(
        "try {{ if (Test-Path $PROFILE) {{ . $PROFILE }} }} catch {{}} ; . '{script}'",
        script = script_str.replace('\'', "''")
    );
    Ok(IntegrationSetup {
        extra_args: vec![
            "-NoExit".to_string(),
            "-NoLogo".to_string(),
            "-Command".to_string(),
            cmd,
        ],
        env_overrides: env,
        tempdir: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_bash_from_unix_path() {
        assert_eq!(ShellKind::from_shell_path("/usr/bin/bash"), ShellKind::Bash);
        assert_eq!(ShellKind::from_shell_path("bash"), ShellKind::Bash);
    }

    #[test]
    fn detects_zsh() {
        assert_eq!(ShellKind::from_shell_path("/usr/local/bin/zsh"), ShellKind::Zsh);
    }

    #[test]
    fn detects_pwsh_with_windows_extension() {
        assert_eq!(
            ShellKind::from_shell_path("C:/Program Files/PowerShell/7/pwsh.exe"),
            ShellKind::Pwsh
        );
        assert_eq!(
            ShellKind::from_shell_path("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
            ShellKind::PowerShell
        );
    }

    #[test]
    fn detects_cmd_explicitly() {
        // Windows cmd.exe is recognised but still gets an empty setup.
        assert_eq!(
            ShellKind::from_shell_path("C:\\Windows\\System32\\cmd.exe"),
            ShellKind::Cmd
        );
        assert_eq!(ShellKind::from_shell_path("cmd"), ShellKind::Cmd);
    }

    #[test]
    fn build_cmd_returns_empty_setup() {
        let tempdir = std::env::temp_dir().join("cognia-test-cmd-int");
        let _ = fs::create_dir_all(&tempdir);
        let setup = build(ShellKind::Cmd, &tempdir, "n").unwrap();
        assert!(setup.extra_args.is_empty());
        assert!(setup.env_overrides.is_empty());
        assert!(setup.tempdir.is_none());
    }

    #[test]
    fn case_insensitive_recogniser() {
        assert_eq!(
            ShellKind::from_shell_path("C:/PWSH.EXE"),
            ShellKind::Pwsh
        );
    }

    #[test]
    fn build_bash_with_missing_script_is_empty() {
        // Use a temp dir we know is empty so the script lookup fails.
        let tempdir = std::env::temp_dir().join("cognia-test-empty-int");
        let _ = fs::create_dir_all(&tempdir);
        let setup = build(ShellKind::Bash, &tempdir, "n").unwrap();
        assert!(setup.extra_args.is_empty());
        assert!(setup.env_overrides.is_empty());
    }

    #[test]
    fn build_bash_with_script_sets_rcfile_and_nonce() {
        let tempdir = std::env::temp_dir().join("cognia-test-bash-int");
        let _ = fs::create_dir_all(&tempdir);
        let script = tempdir.join("shell-integration.bash");
        fs::write(&script, "# stub").unwrap();
        let setup = build(ShellKind::Bash, &tempdir, "nonce-123").unwrap();
        assert_eq!(setup.extra_args[0], "--rcfile");
        assert!(setup.extra_args[1].ends_with("shell-integration.bash"));
        assert_eq!(setup.env_overrides.get("COGNIA_TERM_NONCE"), Some(&"nonce-123".to_string()));
        let _ = fs::remove_file(script);
    }

    #[test]
    fn build_zsh_with_script_creates_zdotdir_with_shim() {
        let tempdir = std::env::temp_dir().join("cognia-test-zsh-int");
        let _ = fs::create_dir_all(&tempdir);
        let script = tempdir.join("shell-integration.zsh");
        fs::write(&script, "# stub").unwrap();
        let setup = build(ShellKind::Zsh, &tempdir, "zsh-nonce").unwrap();
        let zdot = setup.env_overrides.get("ZDOTDIR").expect("ZDOTDIR set");
        let shim_path = PathBuf::from(zdot).join(".zshrc");
        let shim = fs::read_to_string(&shim_path).unwrap();
        assert!(shim.contains("USER_ZDOTDIR"));
        assert!(shim.contains("shell-integration.zsh"));
        assert!(setup.tempdir.is_some());
        // Cleanup
        let _ = fs::remove_dir_all(setup.tempdir.unwrap());
        let _ = fs::remove_file(script);
    }

    #[test]
    fn build_pwsh_with_script_sources_profile_and_integration() {
        let tempdir = std::env::temp_dir().join("cognia-test-pwsh-int");
        let _ = fs::create_dir_all(&tempdir);
        let script = tempdir.join("shell-integration.ps1");
        fs::write(&script, "# stub").unwrap();
        let setup = build(ShellKind::Pwsh, &tempdir, "ps-nonce").unwrap();
        assert!(setup.extra_args.contains(&"-NoExit".to_string()));
        assert!(setup.extra_args.contains(&"-Command".to_string()));
        let cmd_idx = setup
            .extra_args
            .iter()
            .position(|a| a == "-Command")
            .unwrap();
        let cmd = &setup.extra_args[cmd_idx + 1];
        assert!(cmd.contains("$PROFILE"));
        assert!(cmd.contains("shell-integration.ps1"));
        let _ = fs::remove_file(script);
    }

    #[test]
    fn pwsh_command_escapes_embedded_quotes_in_path() {
        let tempdir = std::env::temp_dir().join("cognia-test-pwsh'quoted-int");
        let _ = fs::create_dir_all(&tempdir);
        let script = tempdir.join("shell-integration.ps1");
        fs::write(&script, "# stub").unwrap();
        let setup = build(ShellKind::Pwsh, &tempdir, "n").unwrap();
        let cmd_idx = setup
            .extra_args
            .iter()
            .position(|a| a == "-Command")
            .unwrap();
        let cmd = &setup.extra_args[cmd_idx + 1];
        // Embedded single quotes are doubled per PowerShell single-quote escape rules.
        assert!(cmd.contains("''"));
        let _ = fs::remove_file(script);
        let _ = fs::remove_dir_all(&tempdir);
    }

    #[test]
    fn unknown_shell_returns_empty_setup() {
        let tempdir = std::env::temp_dir().join("cognia-test-unknown-int");
        let _ = fs::create_dir_all(&tempdir);
        let setup = build(ShellKind::Unknown, &tempdir, "n").unwrap();
        assert!(setup.extra_args.is_empty());
        assert!(setup.env_overrides.is_empty());
        assert!(setup.tempdir.is_none());
    }
}
