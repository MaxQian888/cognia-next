//! Strict, stdio-preserving sandbox launcher for the standalone agent CLI.
//!
//! This binary is intentionally thin: argument parsing lives here, while the
//! Seatbelt/bwrap policy is rendered by the existing ADR-0028 launcher module.

#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(target_os = "linux")]
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
}

fn parse_args(raw: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut iter = raw.into_iter().peekable();
    let mut cwd = None;
    let mut writable = Vec::new();
    let mut readable = Vec::new();
    let mut network = false;

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
                    network,
                },
                target,
            });
        }
        match arg.as_str() {
            "--cwd" => cwd = Some(next_value(&mut iter, "--cwd")?),
            "--writable" => writable.push(next_value(&mut iter, "--writable")?),
            "--readable" => readable.push(next_value(&mut iter, "--readable")?),
            "--network" => network = true,
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

#[cfg(target_os = "linux")]
fn find_on_path(binary: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .map(|dir| dir.join(binary))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(target_os = "linux")]
fn render_launch(args: &Args) -> Result<Vec<String>, String> {
    let bwrap = find_on_path("bwrap").ok_or_else(|| {
        "bubblewrap (bwrap) is required for strict external-agent hosting".to_string()
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
fn exec_launch(launch: Vec<String>) -> Result<(), String> {
    use std::os::unix::process::CommandExt;

    let (program, args) = launch
        .split_first()
        .ok_or_else(|| "sandbox renderer returned an empty command".to_string())?;
    let error = std::process::Command::new(program).args(args).exec();
    Err(format!(
        "failed to exec sandbox launcher {program}: {error}"
    ))
}

#[cfg(not(unix))]
fn exec_launch(_launch: Vec<String>) -> Result<(), String> {
    Err("stdio-preserving sandbox exec is unavailable on this platform".into())
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1))?;
    let launch = render_launch(&args)?;
    if std::env::var("COGNIA_EXTERNAL_AGENT_LAUNCHER_DEBUG").as_deref() == Ok("1") {
        eprintln!("external-agent sandbox launch: {launch:?}");
    }
    exec_launch(launch)
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
    fn parses_scope_and_preserves_target_argv() {
        let args = parse_args(
            [
                "--cwd",
                "/work",
                "--writable",
                "/work",
                "--readable",
                "/home/u",
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
        assert!(args.scope.network);
        assert_eq!(args.target, ["codex", "app-server"]);
    }

    #[test]
    fn rejects_missing_target_and_unknown_flags() {
        assert!(parse_args(["--cwd".into(), "/work".into()]).is_err());
        assert!(parse_args(["--wat".into()]).is_err());
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
