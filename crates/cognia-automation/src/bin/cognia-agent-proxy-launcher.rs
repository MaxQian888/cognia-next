//! Network-only, fail-closed launcher for arbitrary local agent commands.
//!
//! This is deliberately separate from `cognia-external-agent-launcher`: the
//! latter owns Cognia's strict filesystem/process sandbox contract, while this
//! binary preserves the caller's ordinary local permissions and changes only
//! network egress. On macOS Seatbelt allows one loopback HTTP proxy port and
//! denies every other network destination for the complete child process tree.

#[cfg(target_os = "macos")]
use std::path::Path;

#[cfg(target_os = "macos")]
use cognia_automation::sandbox::launcher::sandbox_exec_network_proxy_prefix;

#[derive(Debug, PartialEq, Eq)]
struct Args {
    proxy_port: u16,
    target: Vec<String>,
}

fn parse_args(raw: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut iter = raw.into_iter().peekable();
    let mut proxy_port = None;

    while let Some(arg) = iter.next() {
        if arg == "--" {
            let target: Vec<String> = iter.collect();
            if target.is_empty() {
                return Err("missing target command after --".into());
            }
            return Ok(Args {
                proxy_port: proxy_port.ok_or_else(|| "missing --proxy-port".to_string())?,
                target,
            });
        }
        match arg.as_str() {
            "--proxy-port" => {
                let raw = iter
                    .next()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "missing value for --proxy-port".to_string())?;
                let port = raw
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port != 0)
                    .ok_or_else(|| format!("invalid --proxy-port: {raw:?}"))?;
                proxy_port = Some(port);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Err("missing -- target separator".into())
}

#[cfg(target_os = "macos")]
fn render_launch(args: &Args) -> Result<Vec<String>, String> {
    if !Path::new("/usr/bin/sandbox-exec").is_file() {
        return Err("/usr/bin/sandbox-exec is unavailable".into());
    }
    let mut launch = sandbox_exec_network_proxy_prefix(args.proxy_port);
    launch.extend(args.target.clone());
    Ok(launch)
}

#[cfg(not(target_os = "macos"))]
fn render_launch(_args: &Args) -> Result<Vec<String>, String> {
    Err(format!(
        "kernel-enforced agent proxy launching is unavailable on {}",
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
        "failed to exec agent proxy launcher {program}: {error}"
    ))
}

#[cfg(not(unix))]
fn exec_launch(_launch: Vec<String>) -> Result<(), String> {
    Err("agent proxy exec is unavailable on this platform".into())
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1))?;
    let launch = render_launch(&args)?;
    if std::env::var("COGNIA_AGENT_PROXY_LAUNCHER_DEBUG").as_deref() == Ok("1") {
        eprintln!("agent proxy launch: {launch:?}");
    }
    exec_launch(launch)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("cognia-agent-proxy-launcher: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proxy_port_and_preserves_arbitrary_target_argv() {
        let args = parse_args(
            [
                "--proxy-port",
                "7890",
                "--",
                "my-custom-agent",
                "--mode",
                "safe",
            ]
            .into_iter()
            .map(str::to_string),
        )
        .unwrap();
        assert_eq!(args.proxy_port, 7890);
        assert_eq!(args.target, ["my-custom-agent", "--mode", "safe"]);
    }

    #[test]
    fn rejects_missing_target_port_and_unknown_flags() {
        assert!(parse_args(["--proxy-port".into(), "7890".into()]).is_err());
        assert!(parse_args(["--".into(), "agent".into()]).is_err());
        assert!(parse_args(["--wat".into()]).is_err());
    }

    #[test]
    fn rejects_invalid_proxy_ports() {
        for port in ["0", "65536", "not-a-port"] {
            let result = parse_args(
                ["--proxy-port", port, "--", "agent"]
                    .into_iter()
                    .map(str::to_string),
            );
            assert!(result.is_err(), "{port} must be rejected");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_changes_only_network_and_pins_the_proxy_port() {
        let args = parse_args(
            ["--proxy-port", "7890", "--", "/usr/bin/true"]
                .into_iter()
                .map(str::to_string),
        )
        .unwrap();
        let launch = render_launch(&args).unwrap();
        assert!(launch[2].contains("(allow default)"));
        assert!(launch[2].contains("(deny network*)"));
        assert!(launch[2].contains("localhost:7890"));
    }
}
