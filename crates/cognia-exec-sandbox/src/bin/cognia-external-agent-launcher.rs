//! Strict, stdio-preserving sandbox launcher for the standalone agent CLI.
//!
//! This binary is intentionally thin: argument parsing lives here, while the
//! Seatbelt/bwrap policy is rendered by the existing ADR-0028 launcher module.

#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(any(target_os = "linux", test))]
use std::path::PathBuf;

#[cfg(target_os = "linux")]
use cognia_exec_sandbox::launcher::bwrap_prefix;
#[cfg(target_os = "macos")]
use cognia_exec_sandbox::launcher::sandbox_exec_prefix;
use cognia_exec_sandbox::launcher::{validate_network_allowlist, LaunchScope};
use cognia_exec_sandbox::types::NetworkPolicy;

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
    let mut network = NetworkPolicy::Off;
    let mut restrict_readable = false;
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
                    restrict_readable,
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
            "--workspace-readable" => restrict_readable = true,
            "--network" => {
                if matches!(network, NetworkPolicy::Allowlist { .. }) {
                    return Err("--network conflicts with --network-allow".into());
                }
                network = NetworkPolicy::On;
            }
            "--network-allow" => {
                if matches!(network, NetworkPolicy::On) {
                    return Err("--network-allow conflicts with --network".into());
                }
                let host = next_value(&mut iter, "--network-allow")?;
                validate_network_allowlist(std::slice::from_ref(&host))?;
                if !matches!(network, NetworkPolicy::Allowlist { .. }) {
                    network = NetworkPolicy::Allowlist { hosts: Vec::new() };
                }
                if let NetworkPolicy::Allowlist { hosts } = &mut network {
                    hosts.push(host);
                }
            }
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
    render_macos_launch(args, None)
}

#[cfg(target_os = "macos")]
fn render_macos_launch(args: &Args, proxy_port: Option<u16>) -> Result<Vec<String>, String> {
    let launcher = Path::new("/usr/bin/sandbox-exec");
    if !launcher.is_file() {
        return Err("/usr/bin/sandbox-exec is unavailable".into());
    }
    let mut launch = match proxy_port {
        Some(port) => cognia_exec_sandbox::launcher::sandbox_exec_proxy_prefix(&args.scope, port),
        None => sandbox_exec_prefix(&args.scope),
    };
    if args.bot_isolation {
        // SQLite and executable loaders canonicalize ancestor directories.
        // Permit metadata, while file contents beneath denied HOME stay hidden.
        launch[2].push_str("(allow file-read-metadata)\n");
        // Scrubbing SSH_AUTH_SOCK alone is insufficient: a process could
        // discover an ambient agent socket by listing the host temp directory.
        launch[2].push_str("(deny network-outbound (remote unix-socket (subpath \"/\")))\n");
        for root in std::iter::once(&args.scope.cwd).chain(args.scope.writable.iter()) {
            if !matches!(args.scope.network, NetworkPolicy::On)
                && !Path::new(root)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("cognia-toolhost-"))
            {
                continue;
            }
            let escaped = root.replace('\\', "\\\\").replace('"', "\\\"");
            launch[2].push_str(&format!(
                "(allow network-outbound (remote unix-socket (subpath \"{escaped}\")))\n"
            ));
        }
        if matches!(args.scope.network, NetworkPolicy::On) {
            launch[2].push_str("(allow network-outbound (remote unix-socket (literal \"/private/var/run/mDNSResponder\")))\n");
        }
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

fn run() -> Result<i32, String> {
    // Consumed in every mode so the agent never sees the host's policy.
    let upstream = cognia_exec_sandbox::net_proxy::take_upstream_policy_env()?;
    let args = parse_args(std::env::args().skip(1))?;
    #[cfg(unix)]
    if matches!(args.scope.network, NetworkPolicy::Allowlist { .. }) {
        // Read the inherited proxy variables now, before the supervisor
        // overrides them with its own relay.
        cognia_exec_sandbox::net_proxy::install_upstream_policy(upstream.as_deref(), |name| {
            std::env::var(name).ok()
        })
        .map_err(|error| format!("upstream proxy policy: {error}"))?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("failed to start proxy supervisor: {error}"))?;
        return runtime.block_on(supervise(AgentSupervisor::new(args)));
    }
    let launch = render_launch(&args)?;
    if std::env::var("COGNIA_EXTERNAL_AGENT_LAUNCHER_DEBUG").as_deref() == Ok("1") {
        eprintln!("external-agent sandbox launch: {launch:?}");
    }
    exec_launch(launch, args.bot_isolation)?;
    Ok(0)
}

/// Lifecycle ordering is shared by both OS integrations and exercised without
/// binding sockets. Setup owns resources before spawning; every exit tears them
/// down, including setup, spawn, and handshake failures.
#[cfg(unix)]
#[async_trait::async_trait]
trait Supervision: Send {
    async fn setup(&mut self) -> Result<(), String>;
    fn spawn(&mut self) -> Result<(), String>;
    async fn wait(&mut self) -> Result<i32, String>;
    async fn shutdown(&mut self) -> Result<(), String>;
}

#[cfg(unix)]
async fn supervise(mut supervisor: impl Supervision) -> Result<i32, String> {
    let result = async {
        supervisor.setup().await?;
        supervisor.spawn()?;
        supervisor.wait().await
    }
    .await;
    let cleanup = supervisor.shutdown().await;
    match (result, cleanup) {
        (Err(error), _) | (_, Err(error)) => Err(error),
        (Ok(code), Ok(())) => Ok(code),
    }
}

#[cfg(unix)]
struct ForwardSignals {
    term: tokio::signal::unix::Signal,
    interrupt: tokio::signal::unix::Signal,
    hangup: tokio::signal::unix::Signal,
    quit: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl ForwardSignals {
    fn new() -> std::io::Result<Self> {
        use tokio::signal::unix::{signal, SignalKind};
        Ok(Self {
            term: signal(SignalKind::terminate())?,
            interrupt: signal(SignalKind::interrupt())?,
            hangup: signal(SignalKind::hangup())?,
            quit: signal(SignalKind::quit())?,
        })
    }

    async fn receive(&mut self) -> i32 {
        tokio::select! {
            _ = self.term.recv() => libc::SIGTERM,
            _ = self.interrupt.recv() => libc::SIGINT,
            _ = self.hangup.recv() => libc::SIGHUP,
            _ = self.quit.recv() => libc::SIGQUIT,
        }
    }
}

#[cfg(unix)]
struct AgentSupervisor {
    args: Args,
    proxy: Option<cognia_exec_sandbox::net_proxy::FilteringProxy>,
    command: Option<tokio::process::Command>,
    child: Option<tokio::process::Child>,
    child_group: Option<i32>,
    signals: Option<ForwardSignals>,
    #[cfg(target_os = "linux")]
    directory: Option<tempfile::TempDir>,
    #[cfg(target_os = "linux")]
    control: Option<tokio::net::UnixListener>,
    #[cfg(target_os = "linux")]
    lifecycle: Option<tokio::net::UnixStream>,
    #[cfg(target_os = "linux")]
    helper_pid: Option<std::os::fd::OwnedFd>,
    #[cfg(target_os = "linux")]
    filter_fd: Option<std::fs::File>,
}

#[cfg(unix)]
impl AgentSupervisor {
    fn new(args: Args) -> Self {
        Self {
            args,
            proxy: None,
            command: None,
            child: None,
            child_group: None,
            signals: None,
            #[cfg(target_os = "linux")]
            directory: None,
            #[cfg(target_os = "linux")]
            control: None,
            #[cfg(target_os = "linux")]
            lifecycle: None,
            #[cfg(target_os = "linux")]
            helper_pid: None,
            #[cfg(target_os = "linux")]
            filter_fd: None,
        }
    }

    fn command(&self, launch: &[String]) -> Result<tokio::process::Command, String> {
        let (program, args) = launch.split_first().ok_or("empty sandbox command")?;
        let mut command = tokio::process::Command::new(program);
        command.args(args).kill_on_drop(true).process_group(0);
        command
            .stdin(std::process::Stdio::inherit())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit());
        if self.args.bot_isolation {
            command.env_clear().envs(bot_environment(std::env::vars()));
        }
        Ok(command)
    }

    #[cfg(target_os = "macos")]
    async fn prepare(&mut self, hosts: Vec<String>) -> Result<(), String> {
        // Render/check the sandbox before allocating the proxy. The proxy is
        // outside Seatbelt and the child can reach exactly its loopback port.
        render_launch(&self.args)?;
        let proxy = cognia_exec_sandbox::net_proxy::FilteringProxy::start(hosts)
            .await
            .map_err(|error| format!("filtering proxy setup failed: {error}"))?;
        let port = proxy.port();
        self.proxy = Some(proxy);
        let launch = render_macos_launch(&self.args, Some(port))?;
        let mut command = self.command(&launch)?;
        // Apply these last, after inherited or bot-filtered caller values.
        command.envs(cognia_exec_sandbox::net_bridge::relay_environment(port));
        self.command = Some(command);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    async fn prepare(&mut self, hosts: Vec<String>) -> Result<(), String> {
        use cognia_exec_sandbox::{launcher, seccomp};
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::PermissionsExt;
        let bwrap = find_trusted_bwrap(|path| path.is_file())
            .ok_or("bubblewrap is required at /usr/bin/bwrap or /bin/bwrap")?;
        // The helper is this executable, so no PATH lookup or version skew.
        let helper = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|error| format!("cannot resolve bridge executable: {error}"))?;
        let mut probe = tokio::process::Command::new(&bwrap);
        probe.arg("--help").kill_on_drop(true);
        let help = tokio::time::timeout(std::time::Duration::from_secs(5), probe.output())
            .await
            .map_err(|_| "bubblewrap capability probe timed out")?
            .map_err(|error| format!("bubblewrap capability probe failed: {error}"))?;
        if !help.status.success() {
            return Err("bubblewrap capability probe failed".into());
        }
        let dir = tempfile::Builder::new()
            .prefix("cognia-agent-egress-")
            .tempdir()
            .map_err(|error| error.to_string())?;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        let proxy_socket = dir.path().join("proxy.sock");
        let control_socket = dir.path().join("control.sock");
        self.directory = Some(dir);
        self.proxy = Some(
            cognia_exec_sandbox::net_proxy::FilteringProxy::start_unix(&proxy_socket, hosts)
                .await
                .map_err(|error| format!("filtering proxy setup failed: {error}"))?,
        );
        std::fs::set_permissions(&proxy_socket, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
        self.control = Some(
            tokio::net::UnixListener::bind(&control_socket).map_err(|error| error.to_string())?,
        );
        std::fs::set_permissions(&control_socket, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
        let bridge = launcher::LinuxBridgeLaunchSpec {
            helper,
            proxy_socket,
            control_socket,
            as_pid_1: String::from_utf8_lossy(&help.stdout).contains("--as-pid-1"),
        };
        let private = self.directory.as_ref().ok_or("missing bridge directory")?;
        let empty = private.path().join("empty");
        std::fs::create_dir(&empty).map_err(|error| error.to_string())?;
        let launch = launcher::bwrap_bridge_launch(
            &bwrap.to_string_lossy(),
            &self.args.scope,
            &empty,
            &bridge,
            &self.args.target,
        )?;
        let filter = seccomp::build_allowlist_supervisor_filter()?;
        let filter_fd = seccomp::park_program(&filter).map_err(|error| error.to_string())?;
        let mut launch = launch;
        launch.splice(1..1, ["--seccomp".into(), seccomp::SECCOMP_FD.to_string()]);
        let mut command = self.command(&launch)?;
        // Bwrap and its namespace reaper never retain the real input stream.
        // The target receives a duplicate through the Ready/Go descriptor path.
        command.stdin(std::process::Stdio::null());
        seccomp::attach_program_fd(&mut command, filter_fd.as_raw_fd());
        // attach_program_fd borrows the descriptor until spawn.
        self.filter_fd = Some(filter_fd);
        self.command = Some(command);
        Ok(())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    async fn prepare(&mut self, _hosts: Vec<String>) -> Result<(), String> {
        Err("allowlist sandbox supervision is unsupported on this platform".into())
    }

    fn forward(&self, signal: i32) {
        #[cfg(target_os = "linux")]
        if let Some(helper) = &self.helper_pid {
            use std::os::fd::AsRawFd;
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    helper.as_raw_fd(),
                    signal,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
            return;
        }
        if let Some(pid) = self.child_group {
            unsafe {
                libc::kill(-pid, signal);
            }
        }
    }
}

#[cfg(unix)]
#[async_trait::async_trait]
impl Supervision for AgentSupervisor {
    async fn setup(&mut self) -> Result<(), String> {
        let hosts = match &self.args.scope.network {
            NetworkPolicy::Allowlist { hosts } if !hosts.is_empty() => hosts.clone(),
            _ => return Err("proxy supervision requires a nonempty allowlist".into()),
        };
        validate_network_allowlist(&hosts)?;
        self.signals = Some(ForwardSignals::new().map_err(|error| error.to_string())?);
        self.prepare(hosts).await
    }

    fn spawn(&mut self) -> Result<(), String> {
        self.child = Some(
            self.command
                .as_mut()
                .ok_or("missing prepared sandbox")?
                .spawn()
                .map_err(|error| format!("sandbox spawn failed: {error}"))?,
        );
        self.child_group = self
            .child
            .as_ref()
            .and_then(|child| child.id())
            .map(|pid| pid as i32);
        self.command = None;
        #[cfg(target_os = "linux")]
        {
            self.filter_fd = None;
        }
        Ok(())
    }

    async fn wait(&mut self) -> Result<i32, String> {
        use std::os::unix::process::ExitStatusExt;
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::{FromRawFd, OwnedFd};
            let pid = self
                .child
                .as_ref()
                .and_then(|child| child.id())
                .ok_or("sandbox exited before handshake")? as i32;
            let raw = unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_DUPFD_CLOEXEC, 3) };
            if raw < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let stdin = unsafe { OwnedFd::from_raw_fd(raw) };
            let control = self
                .control
                .as_ref()
                .ok_or("missing bridge control listener")?;
            let helper_pid = &mut self.helper_pid;
            let handshake =
                cognia_exec_sandbox::net_bridge::host_handshake(control, stdin, |peer| {
                    *helper_pid = Some(cognia_exec_sandbox::net_bridge::pin_external_agent_peer(
                        peer, pid,
                    )?);
                    Ok(())
                });
            tokio::pin!(handshake);
            let signals = self.signals.as_mut().ok_or("missing signal handlers")?;
            self.lifecycle = Some(tokio::select! {
                result = &mut handshake => result.map_err(|error| format!("bridge handshake failed: {error}"))?,
                _ = signals.receive() => return Err("interrupted before bridge startup".into()),
            });
        }
        loop {
            let signals = self.signals.as_mut().ok_or("missing signal handlers")?;
            let child = self.child.as_mut().ok_or("missing sandbox child")?;
            tokio::select! {
                result = child.wait() => {
                    let status = result.map_err(|error| format!("sandbox wait failed: {error}"))?;
                    return Ok(status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(1)));
                }
                signal = signals.receive() => self.forward(signal),
            }
        }
    }

    async fn shutdown(&mut self) -> Result<(), String> {
        // Tear down the whole target group, not just its leader. Linux also
        // observes lifecycle EOF and reaps the target through the S5 helper.
        self.forward(libc::SIGKILL);
        #[cfg(target_os = "linux")]
        {
            self.lifecycle = None;
        }
        let mut failure = None;
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {}
                _ => {
                    let _ = child.start_kill();
                    if let Err(error) = child.wait().await {
                        failure = Some(error.to_string());
                    }
                }
            }
        }
        if let Some(proxy) = self.proxy.as_mut() {
            if let Err(error) = proxy.shutdown().await {
                failure = Some(error.to_string());
            }
        }
        self.proxy = None;
        #[cfg(target_os = "linux")]
        {
            self.control = None;
            if let Some(directory) = self.directory.take() {
                if let Err(error) = directory.close() {
                    failure = Some(error.to_string());
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

/// The Bot agent receives its model credential, never ambient GitHub/SSH or
/// interpreter injection credentials. Git's global helper configuration is
/// disabled independently of filesystem confinement.
fn bot_environment(
    env: impl IntoIterator<Item = (String, String)>,
) -> std::collections::BTreeMap<String, String> {
    let mut result: std::collections::BTreeMap<_, _> = env
        .into_iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "PATH"
                    | "COGNIA_PORT"
                    | "COGNIA_PORT_COUNT"
                    | "PORT"
                    | "HOME"
                    | "USER"
                    | "LOGNAME"
                    | "SHELL"
                    | "LANG"
                    | "LC_ALL"
                    | "LC_CTYPE"
                    | "TZ"
                    | "TERM"
                    | "TMPDIR"
                    | "TMP"
                    | "TEMP"
                    | "XDG_CONFIG_HOME"
                    | "XDG_DATA_HOME"
                    | "XDG_CACHE_HOME"
                    | "XDG_STATE_HOME"
                    | "SSL_CERT_FILE"
                    | "SSL_CERT_DIR"
                    | "NODE_EXTRA_CA_CERTS"
                    | "HTTP_PROXY"
                    | "HTTPS_PROXY"
                    | "NO_PROXY"
                    | "http_proxy"
                    | "https_proxy"
                    | "no_proxy"
                    | "DEVIN_API_KEY"
                    | "DEVIN_TOKEN"
                    | "DEVIN_BASE_URL"
                    | "DISABLE_AUTO_UPDATE"
                    | "NO_COLOR"
                    | "FORCE_COLOR"
                    | "NVM_BIN"
                    | "NVM_DIR"
                    | "PNPM_HOME"
                    | "BUN_INSTALL"
                    | "npm_config_cache"
                    | "npm_config_store_dir"
                    | "pnpm_config_store_dir"
                    | "pnpm_config_cache_dir"
            )
        })
        .collect();
    result.insert("GIT_CONFIG_GLOBAL".into(), "/dev/null".into());
    result.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
    result.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    result
}

fn main() {
    // Internal mode is handled before the ordinary launcher parser. It starts
    // a fresh current-thread runtime inside the namespace, never a post-fork
    // Rust runtime inherited from the multi-threaded sandbox host.
    #[cfg(target_os = "linux")]
    {
        let raw: Vec<String> = std::env::args().skip(1).collect();
        if raw.first().map(String::as_str) == Some("--linux-netns-bridge-version") {
            if raw.len() != 1 {
                eprintln!("unexpected arguments to bridge version probe");
                std::process::exit(1);
            }
            println!("{}", cognia_exec_sandbox::net_bridge::PROTOCOL_VERSION);
            return;
        }
        if raw.first().map(String::as_str) == Some("--linux-netns-bridge") {
            if raw.get(1).map(String::as_str) != Some("--") || raw.len() < 3 {
                eprintln!("expected --linux-netns-bridge -- target [args]");
                std::process::exit(1);
            }
            match cognia_exec_sandbox::net_bridge::run_helper(raw.into_iter().skip(2).collect()) {
                Ok(code) => std::process::exit(code),
                Err(error) => {
                    eprintln!("cognia-external-agent-launcher bridge: {error}");
                    std::process::exit(1);
                }
            }
        }
    }
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("cognia-external-agent-launcher: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn network_modes_and_workspace_reads_are_explicit() {
        let parse = |flags: &[&str]| {
            let mut args = vec!["--cwd", "/work"];
            args.extend(flags);
            args.extend(["--", "agent"]);
            parse_args(args.into_iter().map(str::to_string))
        };
        assert_eq!(parse(&[]).unwrap().scope.network, NetworkPolicy::Off);
        assert_eq!(
            parse(&["--network"]).unwrap().scope.network,
            NetworkPolicy::On
        );
        let allow = parse(&[
            "--network-allow",
            "api.example.com",
            "--network-allow",
            "*.example.org",
            "--workspace-readable",
        ])
        .unwrap();
        assert_eq!(
            allow.scope.network,
            NetworkPolicy::Allowlist {
                hosts: vec!["api.example.com".into(), "*.example.org".into()]
            }
        );
        assert!(allow.scope.restrict_readable);
        for flags in [
            vec!["--network", "--network-allow", "example.com"],
            vec!["--network-allow", "example.com", "--network"],
            vec!["--network-allow", "https://example.com"],
            vec!["--network-allow", "example.com:443"],
            vec!["--network-allow", "*."],
            vec!["--network-allow", ""],
        ] {
            assert!(parse(&flags).is_err(), "{flags:?}");
        }
    }

    #[cfg(unix)]
    struct FakeSupervisor {
        events: std::sync::Arc<std::sync::Mutex<Vec<&'static str>>>,
        fail: Option<&'static str>,
        exit: i32,
    }

    #[cfg(unix)]
    #[async_trait::async_trait]
    impl Supervision for FakeSupervisor {
        async fn setup(&mut self) -> Result<(), String> {
            self.events.lock().unwrap().push("proxy setup");
            if self.fail == Some("setup") {
                return Err("setup failed".into());
            }
            Ok(())
        }
        fn spawn(&mut self) -> Result<(), String> {
            self.events.lock().unwrap().push("child spawn");
            if self.fail == Some("spawn") {
                return Err("spawn failed".into());
            }
            Ok(())
        }
        async fn wait(&mut self) -> Result<i32, String> {
            self.events.lock().unwrap().push("child wait");
            if self.fail == Some("handshake") {
                return Err("handshake failed".into());
            }
            Ok(self.exit)
        }
        async fn shutdown(&mut self) -> Result<(), String> {
            self.events.lock().unwrap().push("proxy shutdown");
            Ok(())
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_starts_proxy_first_shuts_down_last_and_returns_child_status() {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let result = supervise(FakeSupervisor {
            events: events.clone(),
            fail: None,
            exit: 37,
        })
        .await;
        assert_eq!(result.unwrap(), 37);
        assert_eq!(
            *events.lock().unwrap(),
            ["proxy setup", "child spawn", "child wait", "proxy shutdown"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_setup_failure_never_spawns_and_all_failures_shutdown() {
        for failure in ["setup", "spawn", "handshake"] {
            let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            assert!(supervise(FakeSupervisor {
                events: events.clone(),
                fail: Some(failure),
                exit: 0
            })
            .await
            .is_err());
            let events = events.lock().unwrap();
            assert_eq!(events.last(), Some(&"proxy shutdown"));
            if failure == "setup" {
                assert!(!events.contains(&"child spawn"));
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_wait_preserves_real_child_exit_and_signal_status() {
        for (script, expected) in [("exit 37", 37), ("kill -TERM $$", 128 + libc::SIGTERM)] {
            let args = parse_args(
                ["--cwd", "/tmp", "--", "/bin/sh"]
                    .into_iter()
                    .map(str::to_string),
            )
            .unwrap();
            let mut supervisor = AgentSupervisor::new(args);
            supervisor.signals = Some(ForwardSignals::new().unwrap());
            supervisor.command = Some(
                supervisor
                    .command(&["/bin/sh".into(), "-c".into(), script.into()])
                    .unwrap(),
            );
            supervisor.spawn().unwrap();
            // Linux waits for the bridge; this direct process check only uses
            // the host wait branch, independently of network or namespace I/O.
            #[cfg(target_os = "macos")]
            assert_eq!(supervisor.wait().await.unwrap(), expected);
            #[cfg(not(target_os = "macos"))]
            {
                use std::os::unix::process::ExitStatusExt;
                let status = supervisor.child.as_mut().unwrap().wait().await.unwrap();
                assert_eq!(
                    status
                        .code()
                        .unwrap_or_else(|| 128 + status.signal().unwrap()),
                    expected
                );
            }
            supervisor.shutdown().await.unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_forwards_every_termination_signal_to_the_child_group() {
        use std::os::unix::process::ExitStatusExt;
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGQUIT] {
            let args = parse_args(
                ["--cwd", "/tmp", "--", "/bin/sleep"]
                    .into_iter()
                    .map(str::to_string),
            )
            .unwrap();
            let mut supervisor = AgentSupervisor::new(args);
            supervisor.command = Some(
                supervisor
                    .command(&["/bin/sleep".into(), "30".into()])
                    .unwrap(),
            );
            supervisor.spawn().unwrap();
            supervisor.forward(signal);
            let status = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                supervisor.child.as_mut().unwrap().wait(),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(status.signal(), Some(signal));
            supervisor.shutdown().await.unwrap();
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_allowlist_profile_and_environment_do_not_allow_direct_egress() {
        let args = parse_args(
            [
                "--bot-isolation",
                "--cwd",
                "/tmp/work",
                "--network-allow",
                "example.com",
                "--",
                "agent",
            ]
            .into_iter()
            .map(str::to_string),
        )
        .unwrap();
        let launch = render_macos_launch(&args, Some(32101)).unwrap();
        assert!(launch[2].contains("localhost:32101"));
        assert!(launch[2].contains("(deny network*)"));
        assert!(!launch[2].contains("(allow network*)"));
        assert!(!launch[2].contains("mDNSResponder"));
        let env = cognia_exec_sandbox::net_bridge::relay_environment(32101);
        for (key, value) in env {
            if key.eq_ignore_ascii_case("no_proxy") {
                assert_eq!(value, "");
            } else {
                assert_eq!(value, "http://127.0.0.1:32101");
            }
        }
    }

    #[test]
    fn bot_environment_keeps_exact_workspace_port_keys() {
        let env = bot_environment([
            ("COGNIA_PORT".into(), "41000".into()),
            ("COGNIA_PORT_COUNT".into(), "10".into()),
            ("PORT".into(), "41000".into()),
            ("COGNIA_UNREVIEWED".into(), "secret".into()),
        ]);
        assert_eq!(env["PORT"], "41000");
        assert_eq!(env["COGNIA_PORT"], "41000");
        assert_eq!(env["COGNIA_PORT_COUNT"], "10");
        assert!(!env.contains_key("COGNIA_UNREVIEWED"));
    }

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
        assert_eq!(args.scope.network, NetworkPolicy::On);
        assert_eq!(args.target, ["codex", "app-server"]);
    }

    #[test]
    fn rejects_missing_target_and_unknown_flags() {
        assert!(parse_args(["--cwd".into(), "/work".into()]).is_err());
        assert!(parse_args(["--wat".into()]).is_err());
    }

    #[test]
    fn bot_scope_scrubs_publication_credentials_and_injection_hooks() {
        let env = bot_environment(
            [
                ("GH_TOKEN", "secret"),
                ("GITHUB_TOKEN", "secret"),
                ("SSH_AUTH_SOCK", "/socket"),
                ("NODE_OPTIONS", "--require bad"),
                ("DEVIN_API_KEY", "model-only"),
                ("PATH", "/bin"),
                ("XDG_CONFIG_HOME", "/isolated/config"),
            ]
            .map(|(key, value)| (key.into(), value.into())),
        );
        for key in ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS"] {
            assert!(!env.contains_key(key));
        }
        assert_eq!(env["DEVIN_API_KEY"], "model-only");
        assert_eq!(env["GIT_CONFIG_GLOBAL"], "/dev/null");
        assert_eq!(env["GIT_TERMINAL_PROMPT"], "0");
        let args = parse_args(
            [
                "--bot-isolation",
                "--cwd",
                "/work",
                "--deny-readable",
                "/home/user",
                "--",
                "devin",
                "acp",
            ]
            .into_iter()
            .map(str::to_string),
        )
        .unwrap();
        assert!(args.bot_isolation);
    }

    #[test]
    fn bot_scope_retains_owned_temp_and_package_cache_environment_only() {
        let entries = [
            ("TMPDIR", "/work/state/tmp"),
            ("TMP", "/work/state/tmp"),
            ("TEMP", "/work/state/tmp"),
            ("npm_config_cache", "/work/state/cache/npm"),
            ("npm_config_store_dir", "/work/state/cache/pnpm-store"),
            ("pnpm_config_store_dir", "/work/state/cache/pnpm-store"),
            ("pnpm_config_cache_dir", "/work/state/cache/pnpm"),
        ];
        let env = bot_environment(
            entries
                .into_iter()
                .chain([
                    ("npm_config_userconfig", "/private/credentials"),
                    ("NODE_OPTIONS", "--require injected.js"),
                    ("GITHUB_TOKEN", "private"),
                ])
                .map(|(key, value)| (key.into(), value.into())),
        );
        for (key, value) in entries {
            assert_eq!(env[key], value);
        }
        for key in ["npm_config_userconfig", "NODE_OPTIONS", "GITHUB_TOKEN"] {
            assert!(!env.contains_key(key));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bot_scope_blocks_keychain_ipc() {
        let args = parse_args(
            ["--bot-isolation", "--cwd", "/tmp", "--", "/usr/bin/true"]
                .into_iter()
                .map(str::to_string),
        )
        .unwrap();
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
