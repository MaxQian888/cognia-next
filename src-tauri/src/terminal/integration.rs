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
    /// `fish` — uses native event hooks (`fish_prompt` / `fish_preexec`)
    /// rather than --rcfile. Loaded via `fish --init-command "source …"`.
    Fish,
    /// `nu` (nushell) — loaded via `nu --config <tempdir>/config.nu`.
    /// The temp config re-sources the user's original config first, then
    /// applies our hook upserts.
    Nu,
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
            "fish" => ShellKind::Fish,
            "nu" => ShellKind::Nu,
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
/// * `enable_integration` — when false, OSC 633 prompt hooks are skipped.
///   The UTF-8 prelude (below) is *independent* of this flag.
/// * `force_utf8` — when true, PowerShell/cmd are launched with their
///   console output encoding pinned to UTF-8 (PowerShell:
///   `[Console]::OutputEncoding`, cmd: `chcp 65001`). This is the fix for
///   mojibake on non-UTF-8 system codepages (e.g. GBK/cp936 on Chinese
///   Windows), where the shell would otherwise emit bytes xterm.js — which
///   always decodes as UTF-8 — cannot render. Applies even when shell
///   integration is disabled.
pub fn build(
    kind: ShellKind,
    script_dir: &Path,
    nonce: &str,
    enable_integration: bool,
    force_utf8: bool,
) -> io::Result<IntegrationSetup> {
    match kind {
        // POSIX shells: integration is the only reason to touch argv; when
        // disabled they spawn untouched (no codepage concept to fix).
        ShellKind::Bash if enable_integration => build_bash(script_dir, nonce),
        ShellKind::Zsh if enable_integration => build_zsh(script_dir, nonce),
        ShellKind::Fish if enable_integration => build_fish(script_dir, nonce),
        ShellKind::Nu if enable_integration => build_nu(script_dir, nonce),
        ShellKind::Bash | ShellKind::Zsh | ShellKind::Fish | ShellKind::Nu => {
            Ok(IntegrationSetup::empty())
        }
        // PowerShell composes a single `-Command` that pins UTF-8 first
        // (when requested), then optionally sources the integration script.
        ShellKind::Pwsh | ShellKind::PowerShell => {
            build_pwsh(script_dir, nonce, enable_integration, force_utf8)
        }
        // cmd.exe has no rc hook — the only thing we can do is fix the
        // codepage via `/K chcp 65001`.
        ShellKind::Cmd => Ok(build_cmd(force_utf8)),
        // Unrecognised shells spawn normally — we know neither their rc
        // mechanism nor their encoding knob.
        ShellKind::Unknown => Ok(IntegrationSetup::empty()),
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

/// UTF-8 prelude injected at the front of PowerShell's `-Command`. Pins all
/// three encodings PowerShell consults so that subsequent output (and pipes
/// to native commands) are UTF-8 regardless of the system codepage. The
/// `($false)` argument selects the no-BOM UTF-8 encoder. Wrapped in
/// try/catch so a locked-down host that forbids touching `[Console]` can't
/// abort the rest of the command.
const PWSH_UTF8_PRELUDE: &str = "try { [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false) } catch {}";

fn build_pwsh(
    script_dir: &Path,
    nonce: &str,
    enable_integration: bool,
    force_utf8: bool,
) -> io::Result<IntegrationSetup> {
    let script = script_dir.join("shell-integration.ps1");
    let want_integration = enable_integration && script.exists();

    // Nothing to do — let PowerShell launch with its own defaults.
    if !force_utf8 && !want_integration {
        return Ok(IntegrationSetup::empty());
    }

    let mut command = String::new();
    if force_utf8 {
        command.push_str(PWSH_UTF8_PRELUDE);
    }

    let mut env = HashMap::new();
    if want_integration {
        if !command.is_empty() {
            command.push_str(" ; ");
        }
        // Dot-source $PROFILE first (try/catch so a missing/erroring profile
        // doesn't abort), then our integration script. Single quotes in the
        // path are doubled per PowerShell single-quote escaping rules.
        let script_str = script.to_string_lossy();
        command.push_str(&format!(
            "try {{ if (Test-Path $PROFILE) {{ . $PROFILE }} }} catch {{}} ; . '{script}'",
            script = script_str.replace('\'', "''")
        ));
        env.insert("COGNIA_TERM_NONCE".to_string(), nonce.to_string());
    }

    // `-ExecutionPolicy Bypass` lets us dot-source the bundled (unsigned)
    // integration script even when the machine policy is `Restricted` — the
    // default for `powershell.exe` (Windows PowerShell 5.1) on client SKUs.
    // `-NoExit -Command "..."` runs the inline command then drops to the
    // interactive prompt.
    Ok(IntegrationSetup {
        extra_args: vec![
            "-NoLogo".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-NoExit".to_string(),
            "-Command".to_string(),
            command,
        ],
        env_overrides: env,
        tempdir: None,
    })
}

/// cmd.exe setup. There is no rc-file hook for OSC 633 integration, so the
/// only thing we can do is pin the console codepage to UTF-8 (65001) when
/// requested. `/K <cmd>` runs the command then stays interactive; the
/// `>nul` suppresses chcp's "Active code page: 65001" banner.
fn build_cmd(force_utf8: bool) -> IntegrationSetup {
    if !force_utf8 {
        return IntegrationSetup::empty();
    }
    IntegrationSetup {
        extra_args: vec!["/K".to_string(), "chcp 65001>nul".to_string()],
        env_overrides: HashMap::new(),
        tempdir: None,
    }
}

fn build_fish(script_dir: &Path, nonce: &str) -> io::Result<IntegrationSetup> {
    let script = script_dir.join("shell-integration.fish");
    if !script.exists() {
        return Ok(IntegrationSetup::empty());
    }
    let mut env = HashMap::new();
    env.insert("COGNIA_TERM_NONCE".to_string(), nonce.to_string());
    // fish loads its own conf.d / user config before evaluating
    // `--init-command`, so user functions are in scope by the time we
    // attach our `fish_prompt` / `fish_preexec` event handlers.
    let cmd = format!("source '{}'", script.to_string_lossy().replace('\'', "\\'"));
    Ok(IntegrationSetup {
        extra_args: vec!["--init-command".to_string(), cmd],
        env_overrides: env,
        tempdir: None,
    })
}

fn build_nu(script_dir: &Path, nonce: &str) -> io::Result<IntegrationSetup> {
    let script = script_dir.join("shell-integration.nu");
    if !script.exists() {
        return Ok(IntegrationSetup::empty());
    }
    // Nushell's `--config` REPLACES the user's config rather than
    // composing — so we generate a temp config that explicitly
    // re-sources the user's regular config first, then sources our
    // hook script. The temp dir survives via `IntegrationSetup.tempdir`.
    let tempdir = std::env::temp_dir().join(format!("cognia-nu-{nonce}"));
    fs::create_dir_all(&tempdir)?;
    let config_path = tempdir.join("config.nu");
    let user_default = default_nu_config_path();
    let mut body = String::new();
    // Re-source the user's regular config when one exists, ignoring
    // errors so a missing / empty file doesn't abort our hooks.
    if let Some(user) = user_default {
        body.push_str(&format!(
            "try {{ source '{user}' }} catch {{ }}\n",
            user = user.to_string_lossy().replace('\'', "''")
        ));
    }
    body.push_str(&format!(
        "source '{script}'\n",
        script = script.to_string_lossy().replace('\'', "''")
    ));
    fs::write(&config_path, body)?;
    let mut env = HashMap::new();
    env.insert("COGNIA_TERM_NONCE".to_string(), nonce.to_string());
    Ok(IntegrationSetup {
        extra_args: vec![
            "--config".to_string(),
            config_path.to_string_lossy().into_owned(),
        ],
        env_overrides: env,
        tempdir: Some(tempdir),
    })
}

/// Best-effort guess at the user's regular nushell config path. We don't
/// care if this is wrong — the temp config wraps the source in try/catch.
fn default_nu_config_path() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .ok()
            .map(|appdata| PathBuf::from(appdata).join("nushell").join("config.nu"))
    } else {
        std::env::var("XDG_CONFIG_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".config")))
            .map(|cfg| cfg.join("nushell").join("config.nu"))
    }
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
    fn detects_fish_and_nu() {
        assert_eq!(ShellKind::from_shell_path("/usr/bin/fish"), ShellKind::Fish);
        assert_eq!(ShellKind::from_shell_path("fish"), ShellKind::Fish);
        assert_eq!(ShellKind::from_shell_path("/usr/local/bin/nu"), ShellKind::Nu);
        assert_eq!(ShellKind::from_shell_path("nu"), ShellKind::Nu);
    }

    #[test]
    fn build_fish_returns_empty_when_script_missing() {
        let tempdir = std::env::temp_dir().join("cognia-test-fish-noscript");
        let _ = fs::create_dir_all(&tempdir);
        let setup = build(ShellKind::Fish, &tempdir, "n", true, true).unwrap();
        assert!(setup.extra_args.is_empty());
    }

    #[test]
    fn build_fish_emits_init_command_when_script_present() {
        let tempdir = std::env::temp_dir().join("cognia-test-fish-yes");
        let _ = fs::create_dir_all(&tempdir);
        let script = tempdir.join("shell-integration.fish");
        let _ = fs::write(&script, "# test stub");
        let setup = build(ShellKind::Fish, &tempdir, "nonce-xyz", true, true).unwrap();
        assert_eq!(setup.extra_args.first().map(String::as_str), Some("--init-command"));
        let cmd = setup.extra_args.get(1).cloned().unwrap_or_default();
        assert!(cmd.starts_with("source "));
        assert!(cmd.contains("shell-integration.fish"));
        assert_eq!(
            setup.env_overrides.get("COGNIA_TERM_NONCE").map(String::as_str),
            Some("nonce-xyz")
        );
        let _ = fs::remove_dir_all(&tempdir);
    }

    #[test]
    fn build_nu_writes_temp_config_referencing_the_script() {
        let tempdir = std::env::temp_dir().join("cognia-test-nu");
        let _ = fs::create_dir_all(&tempdir);
        let script = tempdir.join("shell-integration.nu");
        let _ = fs::write(&script, "# test nu stub");
        let setup = build(ShellKind::Nu, &tempdir, "n-abc", true, true).unwrap();
        assert_eq!(setup.extra_args.first().map(String::as_str), Some("--config"));
        let cfg_path = setup.extra_args.get(1).cloned().unwrap_or_default();
        let cfg_body = fs::read_to_string(&cfg_path).expect("temp config readable");
        assert!(cfg_body.contains("source"));
        assert!(cfg_body.contains("shell-integration.nu"));
        assert!(setup.tempdir.is_some());
        let _ = fs::remove_dir_all(&tempdir);
    }

    #[test]
    fn build_cmd_returns_empty_setup_without_utf8() {
        let tempdir = std::env::temp_dir().join("cognia-test-cmd-int");
        let _ = fs::create_dir_all(&tempdir);
        let setup = build(ShellKind::Cmd, &tempdir, "n", true, false).unwrap();
        assert!(setup.extra_args.is_empty());
        assert!(setup.env_overrides.is_empty());
        assert!(setup.tempdir.is_none());
    }

    #[test]
    fn build_cmd_pins_codepage_when_force_utf8() {
        let tempdir = std::env::temp_dir().join("cognia-test-cmd-utf8");
        let _ = fs::create_dir_all(&tempdir);
        // force_utf8 applies even with integration disabled — cmd has no hook.
        let setup = build(ShellKind::Cmd, &tempdir, "n", false, true).unwrap();
        assert_eq!(setup.extra_args.first().map(String::as_str), Some("/K"));
        assert!(setup.extra_args.iter().any(|a| a.contains("chcp 65001")));
        assert!(setup.env_overrides.is_empty());
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
        let setup = build(ShellKind::Bash, &tempdir, "n", true, true).unwrap();
        assert!(setup.extra_args.is_empty());
        assert!(setup.env_overrides.is_empty());
    }

    #[test]
    fn build_bash_with_script_sets_rcfile_and_nonce() {
        let tempdir = std::env::temp_dir().join("cognia-test-bash-int");
        let _ = fs::create_dir_all(&tempdir);
        let script = tempdir.join("shell-integration.bash");
        fs::write(&script, "# stub").unwrap();
        let setup = build(ShellKind::Bash, &tempdir, "nonce-123", true, true).unwrap();
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
        let setup = build(ShellKind::Zsh, &tempdir, "zsh-nonce", true, true).unwrap();
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
        let setup = build(ShellKind::Pwsh, &tempdir, "ps-nonce", true, true).unwrap();
        assert!(setup.extra_args.contains(&"-NoExit".to_string()));
        assert!(setup.extra_args.contains(&"-Command".to_string()));
        // -ExecutionPolicy Bypass is required so the bundled (unsigned)
        // integration script can be dot-sourced under a Restricted policy.
        let policy_idx = setup
            .extra_args
            .iter()
            .position(|a| a == "-ExecutionPolicy")
            .expect("-ExecutionPolicy present");
        assert_eq!(setup.extra_args.get(policy_idx + 1).map(String::as_str), Some("Bypass"));
        let cmd_idx = setup
            .extra_args
            .iter()
            .position(|a| a == "-Command")
            .unwrap();
        let cmd = &setup.extra_args[cmd_idx + 1];
        // UTF-8 prelude runs before the profile/integration sourcing.
        assert!(cmd.contains("OutputEncoding"));
        assert!(cmd.contains("$PROFILE"));
        assert!(cmd.contains("shell-integration.ps1"));
        assert_eq!(
            setup.env_overrides.get("COGNIA_TERM_NONCE").map(String::as_str),
            Some("ps-nonce")
        );
        let _ = fs::remove_file(script);
    }

    #[test]
    fn build_pwsh_force_utf8_only_skips_integration() {
        // No script present + integration disabled, but force_utf8 on: we
        // still launch with the UTF-8 prelude and ExecutionPolicy Bypass,
        // but no $PROFILE/integration sourcing and no nonce.
        let tempdir = std::env::temp_dir().join("cognia-test-pwsh-utf8only");
        let _ = fs::create_dir_all(&tempdir);
        let setup = build(ShellKind::Pwsh, &tempdir, "n", false, true).unwrap();
        let cmd_idx = setup
            .extra_args
            .iter()
            .position(|a| a == "-Command")
            .expect("-Command present");
        let cmd = &setup.extra_args[cmd_idx + 1];
        assert!(cmd.contains("OutputEncoding"));
        assert!(!cmd.contains("$PROFILE"));
        assert!(!cmd.contains("shell-integration.ps1"));
        assert!(setup.env_overrides.is_empty());
        assert!(setup.extra_args.contains(&"Bypass".to_string()));
        let _ = fs::remove_dir_all(&tempdir);
    }

    #[test]
    fn build_pwsh_empty_when_no_integration_and_no_utf8() {
        let tempdir = std::env::temp_dir().join("cognia-test-pwsh-noop");
        let _ = fs::create_dir_all(&tempdir);
        let setup = build(ShellKind::Pwsh, &tempdir, "n", false, false).unwrap();
        assert!(setup.extra_args.is_empty());
        assert!(setup.env_overrides.is_empty());
        let _ = fs::remove_dir_all(&tempdir);
    }

    #[test]
    fn build_bash_skipped_when_integration_disabled() {
        // Even with the script present, a disabled toggle spawns bash clean.
        let tempdir = std::env::temp_dir().join("cognia-test-bash-disabled");
        let _ = fs::create_dir_all(&tempdir);
        let script = tempdir.join("shell-integration.bash");
        fs::write(&script, "# stub").unwrap();
        let setup = build(ShellKind::Bash, &tempdir, "n", false, true).unwrap();
        assert!(setup.extra_args.is_empty());
        assert!(setup.env_overrides.is_empty());
        let _ = fs::remove_file(script);
    }

    #[test]
    fn pwsh_command_escapes_embedded_quotes_in_path() {
        let tempdir = std::env::temp_dir().join("cognia-test-pwsh'quoted-int");
        let _ = fs::create_dir_all(&tempdir);
        let script = tempdir.join("shell-integration.ps1");
        fs::write(&script, "# stub").unwrap();
        let setup = build(ShellKind::Pwsh, &tempdir, "n", true, true).unwrap();
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
        let setup = build(ShellKind::Unknown, &tempdir, "n", true, true).unwrap();
        assert!(setup.extra_args.is_empty());
        assert!(setup.env_overrides.is_empty());
        assert!(setup.tempdir.is_none());
    }
}
