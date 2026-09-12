//! Strict, stdio-preserving sandbox launcher for the standalone agent CLI.
//!
//! This binary is intentionally thin: argument parsing lives here, while the
//! Seatbelt/bwrap policy is rendered by the existing ADR-0028 launcher module.

#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(any(target_os = "linux", test))]
use std::path::PathBuf;

#[cfg(target_os = "linux")]
use cognia_automation::sandbox::launcher::bwrap_prefix;
#[cfg(target_os = "macos")]
use cognia_automation::sandbox::launcher::sandbox_exec_prefix;
use cognia_automation::sandbox::launcher::LaunchScope;

#[derive(Debug, PartialEq, Eq)]
struct Args {
    scope: LaunchScope,
    target: Vec<String>,
    bot_isolation: bool,
}

fn parse_args(raw: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut iter = raw.into_iter().peekable();
    let mut cwd = None;
    let mut writable = Vec::new();
    let mut readable = Vec::new();
    let mut denied_readable = Vec::new();
    let mut network = false;
    let mut bot_isolation = false;

    while let Some(arg) = iter.next() {
        if arg == "--" {
            let target: Vec<String> = iter.collect();
            if target.is_empty() {
                return Err("missing target command after --".into());
            }
            let cwd = cwd.ok_or_else(|| "missing --cwd".to_string())?;
            return Ok(Args {
                scope: LaunchScope {
                    cwd,
                    writable,
                    readable,
                    denied_readable,
                    network,
                },
                target,
                bot_isolation,
            });
        }
        match arg.as_str() {
            "--cwd" => cwd = Some(next_value(&mut iter, "--cwd")?),
            "--writable" => writable.push(next_value(&mut iter, "--writable")?),
            "--readable" => readable.push(next_value(&mut iter, "--readable")?),
            "--deny-readable" => denied_readable.push(next_value(&mut iter, "--deny-readable")?),
            "--network" => network = true,
            "--bot-isolation" => bot_isolation = true,
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Err("missing -- target separator".into())
}

fn next_value<I>(iter: &mut std::iter::Peekable<I>, flag: &str) -> Result<String, String>
where
    I: Iterator<Item = String>,
{
    iter.next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing value for {flag}"))
}

// PATH belongs to the command being launched and can contain workspace shims.
// Choosing the sandbox executable from it would execute those shims before
// confinement. Only OS-managed absolute locations may provide bubblewrap.
#[cfg(any(target_os = "linux", test))]
fn find_trusted_bwrap(is_file: impl Fn(&std::path::Path) -> bool) -> Option<PathBuf> {
    ["/usr/bin/bwrap", "/bin/bwrap"]
        .into_iter()
        .map(PathBuf::from)
        .find(|candidate| is_file(candidate))
}

#[cfg(target_os = "linux")]
fn render_launch(args: &Args) -> Result<Vec<String>, String> {
    let bwrap = find_trusted_bwrap(|candidate| candidate.is_file()).ok_or_else(|| {
        "bubblewrap is required at /usr/bin/bwrap or /bin/bwrap for strict sandbox hosting"
            .to_string()
    })?;
    let empty = std::env::temp_dir().join("cognia-sandbox-empty");
    std::fs::create_dir_all(&empty)
        .map_err(|error| format!("failed to create sandbox empty directory: {error}"))?;
    let mut launch = bwrap_prefix(&bwrap.to_string_lossy(), &args.scope, &empty);
    launch.extend(args.target.clone());
    Ok(launch)
}

#[cfg(target_os = "macos")]
fn render_launch(args: &Args) -> Result<Vec<String>, String> {
    let launcher = Path::new("/usr/bin/sandbox-exec");
    if !launcher.is_file() {
        return Err("/usr/bin/sandbox-exec is unavailable".into());
    }
    let mut launch = sandbox_exec_prefix(&args.scope);
    if args.bot_isolation {
        // SQLite and executable loaders canonicalize ancestor directories.
        // Permit metadata, while file contents beneath denied HOME stay hidden.
        launch[2].push_str("(allow file-read-metadata)\n");
        // Scrubbing SSH_AUTH_SOCK alone is insufficient: a process could
        // discover an ambient agent socket by listing the host temp directory.
        launch[2].push_str("(deny network-outbound (remote unix-socket (subpath \"/\")))\n");
        for root in std::iter::once(&args.scope.cwd).chain(args.scope.writable.iter()) {
            let escaped = root.replace('\\', "\\\\").replace('"', "\\\"");
            launch[2].push_str(&format!("(allow network-outbound (remote unix-socket (subpath \"{escaped}\")))\n"));
        }
        launch[2].push_str("(allow network-outbound (remote unix-socket (literal \"/private/var/run/mDNSResponder\")))\n");
        // Keychain access is an IPC operation, not a read of its on-disk
        // database. Denying HOME alone does not prevent credential-helper use.
        launch[2].push_str("(deny mach-lookup (global-name \"com.apple.securityd\") (global-name \"com.apple.securityd.xpc\") (global-name \"com.apple.SecurityServer\") (global-name \"com.apple.security.agent\"))\n");
    }
    launch.extend(args.target.clone());
    Ok(launch)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn render_launch(_args: &Args) -> Result<Vec<String>, String> {
    Err(format!(
        "strict external-agent sandbox hosting is unavailable on {}",
        std::env::consts::OS
    ))
}

#[cfg(unix)]
fn exec_launch(launch: Vec<String>, bot_isolation: bool) -> Result<(), String> {
    use std::os::unix::process::CommandExt;

    let (program, args) = launch
        .split_first()
        .ok_or_else(|| "sandbox renderer returned an empty command".to_string())?;
    let mut command = std::process::Command::new(program);
    command.args(args);
    if bot_isolation {
        command.env_clear().envs(bot_environment(std::env::vars()));
    }
    let error = command.exec();
    Err(format!(
        "failed to exec sandbox launcher {program}: {error}"
    ))
}

#[cfg(not(unix))]
fn exec_launch(_launch: Vec<String>, _bot_isolation: bool) -> Result<(), String> {
    Err("stdio-preserving sandbox exec is unavailable on this platform".into())
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1))?;
    let launch = render_launch(&args)?;
    if std::env::var("COGNIA_EXTERNAL_AGENT_LAUNCHER_DEBUG").as_deref() == Ok("1") {
        eprintln!("external-agent sandbox launch: {launch:?}");
    }
    exec_launch(launch, args.bot_isolation)
}

/// The Bot agent receives its model credential, never ambient GitHub/SSH or
/// interpreter injection credentials. Git's global helper configuration is
/// disabled independently of filesystem confinement.
fn bot_environment(env: impl IntoIterator<Item = (String, String)>) -> std::collections::BTreeMap<String, String> {
    let mut result: std::collections::BTreeMap<_, _> = env.into_iter().filter(|(key, _)| matches!(key.as_str(),
        "PATH" | "HOME" | "USER" | "LOGNAME" | "SHELL" | "LANG" | "LC_ALL" | "LC_CTYPE" | "TZ" | "TERM" | "TMPDIR" | "TMP" | "TEMP" |
        "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_CACHE_HOME" | "XDG_STATE_HOME" | "SSL_CERT_FILE" | "SSL_CERT_DIR" | "NODE_EXTRA_CA_CERTS" |
        "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY" | "http_proxy" | "https_proxy" | "no_proxy" | "DEVIN_API_KEY" | "DEVIN_TOKEN" | "DEVIN_BASE_URL" |
        "DISABLE_AUTO_UPDATE" | "NO_COLOR" | "FORCE_COLOR" | "NVM_BIN" | "NVM_DIR" | "PNPM_HOME" | "BUN_INSTALL"
    )).collect();
    result.insert("GIT_CONFIG_GLOBAL".into(), "/dev/null".into());
    result.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
    result.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    result
}

fn main() {
    if let Err(error) = run() {
        eprintln!("cognia-external-agent-launcher: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bubblewrap_selection_never_searches_workspace_or_path() {
        let mut visited = std::cell::RefCell::new(Vec::new());
        let selected = find_trusted_bwrap(|candidate| {
            visited.borrow_mut().push(candidate.to_path_buf());
            candidate == std::path::Path::new("/bin/bwrap")
        });
        assert_eq!(selected, Some(PathBuf::from("/bin/bwrap")));
        assert_eq!(
            *visited.get_mut(),
            vec![PathBuf::from("/usr/bin/bwrap"), PathBuf::from("/bin/bwrap")]
        );
        assert_eq!(find_trusted_bwrap(|_| false), None);
    }

    #[test]
    fn parses_scope_and_preserves_target_argv() {
        let args = parse_args(
            [
                "--cwd",
                "/work",
                "--writable",
                "/work",
                "--readable",
                "/home/u",
                "--deny-readable",
                "/home/u/.codex",
                "--network",
                "--",
                "codex",
                "app-server",
            ]
            .into_iter()
            .map(str::to_string),
        )
        .unwrap();
        assert_eq!(args.scope.cwd, "/work");
        assert_eq!(args.scope.writable, ["/work"]);
        assert_eq!(args.scope.readable, ["/home/u"]);
        assert_eq!(args.scope.denied_readable, ["/home/u/.codex"]);
        assert!(args.scope.network);
        assert_eq!(args.target, ["codex", "app-server"]);
    }

    #[test]
    fn rejects_missing_target_and_unknown_flags() {
        assert!(parse_args(["--cwd".into(), "/work".into()]).is_err());
        assert!(parse_args(["--wat".into()]).is_err());
    }

    #[test]
    fn bot_scope_scrubs_publication_credentials_and_injection_hooks() {
        let env = bot_environment([("GH_TOKEN", "secret"), ("GITHUB_TOKEN", "secret"), ("SSH_AUTH_SOCK", "/socket"), ("NODE_OPTIONS", "--require bad"), ("DEVIN_API_KEY", "model-only"), ("PATH", "/bin"), ("XDG_CONFIG_HOME", "/isolated/config")].map(|(key, value)| (key.into(), value.into())));
        for key in ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS"] { assert!(!env.contains_key(key)); }
        assert_eq!(env["DEVIN_API_KEY"], "model-only");
        assert_eq!(env["GIT_CONFIG_GLOBAL"], "/dev/null");
        assert_eq!(env["GIT_TERMINAL_PROMPT"], "0");
        let args = parse_args(["--bot-isolation", "--cwd", "/work", "--deny-readable", "/home/user", "--", "devin", "acp"].into_iter().map(str::to_string)).unwrap();
        assert!(args.bot_isolation);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bot_scope_blocks_keychain_ipc() {
        let args = parse_args(["--bot-isolation", "--cwd", "/tmp", "--", "/usr/bin/true"].into_iter().map(str::to_string)).unwrap();
        let launch = render_launch(&args).unwrap();
        assert!(launch[2].contains("(deny mach-lookup (global-name \"com.apple.securityd\")"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_allows_required_process_metadata_operations() {
        let args = parse_args(
            ["--cwd", "/tmp", "--", "/usr/bin/true"]
                .into_iter()
                .map(str::to_string),
        )
        .unwrap();
        let launch = render_launch(&args).unwrap();
        assert!(launch[2].contains("(allow process*)"));
    }
}
