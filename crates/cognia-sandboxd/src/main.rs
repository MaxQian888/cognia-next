//! `cognia-sandboxd` command line (ADR-0183).
//!
//! Exit codes: `probe` exits with its report's code (0, 64-68, 126);
//! `init-agent` exits with the agent's status, or 125 when it could not start
//! the agent at all; everything else exits 1 on failure and 2 on bad usage.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};

use cognia_sandboxd::install;
use cognia_sandboxd::layout::{
    Arch, InjectedLayout, Libc, BUNDLE_ROOT, INJECTION_ROOT, WORKSPACE_ROOT,
};
use cognia_sandboxd::manifest::BundleManifest;
use cognia_sandboxd::passwd::UserSpec;
use cognia_sandboxd::probe::{self, ProbeOptions, ProbeReport};

/// Status for "the supervisor could not start the agent", as `docker run` uses it.
const EXIT_INIT_FAILED: u8 = 125;

#[derive(Parser)]
#[command(
    name = "cognia-sandboxd",
    version,
    about = "Cognia's in-sandbox supervisor"
)]
struct Cli {
    #[command(subcommand)]
    command: Mode,
}

#[derive(Clone, Copy, ValueEnum)]
enum StageArg {
    Core,
    Libc,
}

#[derive(Subcommand)]
enum Mode {
    #[cfg(unix)]
    /// Keep one workspace container ready for concurrent agent sessions.
    Serve {
        #[arg(long, default_value = "/tmp/cognia-sandboxd/control.sock")]
        socket: PathBuf,
        #[arg(long, default_value = "/var/lib/cognia-sandboxd")]
        state_dir: PathBuf,
        #[arg(long)]
        runtime_key: String,
        #[arg(long, default_value = "300")]
        idle_timeout_secs: u64,
        #[arg(long)]
        forward_port: Vec<u16>,
        #[arg(long, default_value = "/")]
        root: PathBuf,
        #[arg(long, default_value = INJECTION_ROOT)]
        bundle: PathBuf,
        #[arg(long)]
        user: Option<UserSpec>,
        #[arg(long)]
        match_owner_of: Option<String>,
        #[arg(long)]
        runtime_config: Option<PathBuf>,
    },
    #[cfg(unix)]
    /// Attach stdio to one agent in a persistent sandbox.
    ConnectAgent {
        #[arg(long, default_value = "/tmp/cognia-sandboxd/control.sock")]
        socket: PathBuf,
        #[arg(long)]
        session: String,
        #[arg(long)]
        runtime_config: Option<PathBuf>,
        /// Host-renewed lease; expiry terminates an abandoned Docker exec.
        #[arg(long, value_parser = clap::value_parser!(u64).range(1..=300))]
        lease_seconds: Option<u64>,
        #[arg(last = true, required = true)]
        argv: Vec<String>,
    },
    #[cfg(unix)]
    /// Renew one existing agent's original lease duration.
    RenewAgent {
        #[arg(long, default_value = "/tmp/cognia-sandboxd/control.sock")]
        socket: PathBuf,
        #[arg(long)]
        session: String,
    },
    #[cfg(unix)]
    /// Send a lifecycle signal to one persistent agent session.
    SignalAgent {
        #[arg(long, default_value = "/tmp/cognia-sandboxd/control.sock")]
        socket: PathBuf,
        #[arg(long)]
        session: String,
        #[arg(long, value_parser = ["TERM", "INT", "KILL"], default_value = "TERM")]
        signal: String,
    },
    #[cfg(unix)]
    /// Report readiness after the required lifecycle phases complete.
    Health {
        #[arg(long, default_value = "/tmp/cognia-sandboxd/control.sock")]
        socket: PathBuf,
    },
    #[cfg(unix)]
    /// Tunnel binary stdio to a port explicitly authorized at supervisor boot.
    ConnectPort {
        #[arg(long, default_value = "/tmp/cognia-sandboxd/control.sock")]
        socket: PathBuf,
        #[arg(long)]
        port: u16,
        /// Direct loopback tunnel for a Host-authorized ephemeral container.
        #[arg(long)]
        direct: bool,
    },
    /// Stage bundle trees into the injection volume.
    Install {
        #[arg(long, value_enum)]
        stage: StageArg,
        /// For `--stage libc`; read from `<to>/probe.json` when omitted.
        #[arg(long)]
        libc: Option<Libc>,
        #[arg(long, default_value = BUNDLE_ROOT)]
        from: PathBuf,
        #[arg(long, default_value = INJECTION_ROOT)]
        to: PathBuf,
    },
    /// Inspect the image this runs in and write probe.json.
    Probe {
        #[arg(long, default_value = "/")]
        root: PathBuf,
        /// The injection root holding the staged bundle manifest.
        #[arg(long, default_value = INJECTION_ROOT)]
        bundle: PathBuf,
        #[arg(long, default_value = WORKSPACE_ROOT)]
        workspace: String,
        /// The user the agent will run as; defaults to the probing user.
        #[arg(long)]
        user: Option<UserSpec>,
        /// Answer for a named `--user` remapped onto the workspace owner, as
        /// `init-agent --match-owner-of <workspace>` will run it.
        #[arg(long)]
        match_workspace_owner: bool,
        /// Defaults to `<bundle>/probe.json`; `-` prints the report only,
        /// for a driver reading it from a container whose volumes are all
        /// read-only.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Run one agent as PID 1.
    InitAgent {
        #[arg(long)]
        user: Option<UserSpec>,
        /// Run a named `--user` as the owner of this in-image directory when
        /// the two differ, handing its home over first (ADR-0183).
        #[arg(long)]
        match_owner_of: Option<String>,
        #[arg(long, default_value = "/")]
        root: PathBuf,
        #[arg(long, default_value = INJECTION_ROOT)]
        bundle: PathBuf,
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// Protected runtime configuration; otherwise read the driver's
        /// chunked COGNIA_SANDBOXD_RUNTIME_CONFIG_* environment handoff.
        #[arg(long)]
        runtime_config: Option<PathBuf>,
        #[arg(last = true, required = true)]
        argv: Vec<OsString>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        #[cfg(unix)]
        Mode::Serve {
            socket,
            state_dir,
            runtime_key,
            idle_timeout_secs,
            forward_port,
            root,
            bundle,
            user,
            match_owner_of,
            runtime_config,
        } => {
            let image_env = std::env::vars().collect();
            let runtime = match load_runtime(runtime_config.as_deref(), &image_env) {
                Ok(Some(runtime)) => runtime,
                _ => {
                    return fail(
                        "persistent supervisor requires valid runtime configuration",
                        EXIT_INIT_FAILED,
                    )
                }
            };
            let executable = match std::env::current_exe() {
                Ok(path) => path,
                Err(error) => return fail(error, EXIT_INIT_FAILED),
            };
            match cognia_sandboxd::serve::serve(cognia_sandboxd::serve::ServeOptions {
                socket,
                state_dir,
                runtime_key,
                idle_timeout_secs,
                forward_ports: forward_port,
                root,
                bundle,
                user,
                match_owner_of,
                runtime,
                image_env,
                executable,
            }) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => fail(error, EXIT_INIT_FAILED),
            }
        }
        #[cfg(unix)]
        Mode::ConnectAgent {
            socket,
            session,
            runtime_config,
            lease_seconds,
            argv,
        } => {
            let runtime = match load_runtime(runtime_config.as_deref(), &std::env::vars().collect())
            {
                Ok(Some(runtime)) => runtime,
                _ => {
                    return fail(
                        "agent connection requires valid runtime configuration",
                        EXIT_INIT_FAILED,
                    )
                }
            };
            match cognia_sandboxd::serve::connect_agent_with_lease(
                &socket,
                session,
                argv,
                runtime,
                lease_seconds,
            ) {
                Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
                Err(error) => fail(error, EXIT_INIT_FAILED),
            }
        }
        #[cfg(unix)]
        Mode::RenewAgent { socket, session } => {
            match cognia_sandboxd::serve::renew_agent(&socket, session) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => fail(error, EXIT_INIT_FAILED),
            }
        }
        #[cfg(unix)]
        Mode::SignalAgent {
            socket,
            session,
            signal,
        } => {
            let signal = match signal.as_str() {
                "INT" => libc::SIGINT,
                "KILL" => libc::SIGKILL,
                _ => libc::SIGTERM,
            };
            match cognia_sandboxd::serve::signal_agent(&socket, session, signal) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => fail(error, EXIT_INIT_FAILED),
            }
        }
        #[cfg(unix)]
        Mode::Health { socket } => match cognia_sandboxd::serve::health(&socket) {
            Ok(value) => {
                println!("{value}");
                ExitCode::SUCCESS
            }
            Err(error) => fail(error, EXIT_INIT_FAILED),
        },
        #[cfg(unix)]
        Mode::ConnectPort {
            socket,
            port,
            direct,
        } => {
            match if direct {
                cognia_sandboxd::serve::connect_port_direct(port)
            } else {
                cognia_sandboxd::serve::connect_port(&socket, port)
            } {
                Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
                Err(error) => fail(error, EXIT_INIT_FAILED),
            }
        }
        Mode::Install {
            stage,
            libc,
            from,
            to,
        } => run_install(stage, libc, &from, &to),
        Mode::Probe {
            root,
            bundle,
            workspace,
            user,
            match_workspace_owner,
            out,
        } => run_probe(
            &root,
            &bundle,
            &workspace,
            user.as_ref(),
            match_workspace_owner,
            out,
        ),
        Mode::InitAgent {
            user,
            match_owner_of,
            root,
            bundle,
            cwd,
            runtime_config,
            argv,
        } => run_init(
            user.as_ref(),
            match_owner_of.as_deref(),
            &root,
            &bundle,
            cwd,
            runtime_config.as_deref(),
            argv,
        ),
    }
}

fn fail(message: impl std::fmt::Display, code: u8) -> ExitCode {
    eprintln!("cognia-sandboxd: {message}");
    ExitCode::from(code)
}

fn run_install(stage: StageArg, libc: Option<Libc>, from: &Path, to: &Path) -> ExitCode {
    let stage = match stage {
        StageArg::Core => install::Stage::Core,
        StageArg::Libc => {
            let libc = match libc {
                Some(libc) => libc,
                None => match read_probe(&InjectedLayout::at(to).probe()) {
                    Ok(ProbeReport {
                        libc: Some(libc), ..
                    }) => libc,
                    Ok(_) => return fail("probe.json names no libc; pass --libc", 1),
                    Err(error) => return fail(format!("{error}; pass --libc"), 1),
                },
            };
            install::Stage::Libc(libc)
        }
    };
    match install::install(from, to, stage) {
        Ok(outcome) => {
            println!("{outcome:?}");
            ExitCode::SUCCESS
        }
        Err(error) => fail(error, 1),
    }
}

fn run_probe(
    root: &Path,
    bundle: &Path,
    workspace: &str,
    user: Option<&UserSpec>,
    match_workspace_owner: bool,
    out: Option<PathBuf>,
) -> ExitCode {
    let Some(arch) = Arch::current() else {
        return fail(
            format!("no bundle is built for {}", std::env::consts::ARCH),
            1,
        );
    };
    let layout = InjectedLayout::at(bundle);
    let manifest = match BundleManifest::load(&layout.manifest()) {
        Ok(manifest) => manifest,
        Err(error) => return fail(error, 1),
    };
    let report = probe::probe(&ProbeOptions {
        root,
        arch,
        workspace,
        user,
        match_workspace_owner,
        manifest: Some(&manifest),
        probing_uid: effective_uid(),
    });

    let json = serde_json::to_vec_pretty(&report).expect("probe reports serialize");
    let out = out.unwrap_or_else(|| layout.probe());
    if out != Path::new("-") {
        if let Err(error) = write_atomically(&out, &json) {
            return fail(format!("cannot write {}: {error}", out.display()), 1);
        }
    }
    let _ = std::io::stdout().write_all(&json);
    println!();
    for problem in &report.problems {
        eprintln!("cognia-sandboxd: {:?}: {}", problem.code, problem.message);
    }
    // 126 is the largest code the report uses; u8 holds every one.
    ExitCode::from(report.exit_code() as u8)
}

fn load_runtime(
    path: Option<&Path>,
    parent: &BTreeMap<String, String>,
) -> Result<Option<cognia_sandboxd::env::RuntimeConfigV1>, cognia_sandboxd::env::RuntimeConfigError>
{
    match path {
        Some(path) => cognia_sandboxd::env::read_runtime_config(path).map(Some),
        None => cognia_sandboxd::env::decode_runtime_config_env(parent),
    }
}

#[allow(clippy::too_many_arguments)] // Mirrors the init-agent CLI, including its optional wire handoff.
fn run_init(
    user: Option<&UserSpec>,
    match_owner_of: Option<&str>,
    root: &Path,
    bundle: &Path,
    cwd: Option<PathBuf>,
    runtime_config_path: Option<&Path>,
    argv: Vec<OsString>,
) -> ExitCode {
    let parent: BTreeMap<String, String> = std::env::vars().collect();
    let runtime = load_runtime(runtime_config_path, &parent);
    let runtime = match runtime {
        Ok(runtime) => runtime,
        Err(error) => return fail(error, EXIT_INIT_FAILED),
    };
    let cwd = if let Some(runtime) = &runtime {
        let workspace = root.join("workspace");
        let path =
            cwd.unwrap_or_else(|| root.join(runtime.workspace_folder.trim_start_matches('/')));
        let confined = std::fs::canonicalize(&workspace).and_then(|workspace| {
            std::fs::canonicalize(&path).map(|path| path.starts_with(workspace))
        });
        if !matches!(confined, Ok(true)) {
            return fail(
                "runtime working directory is unavailable or outside /workspace",
                EXIT_INIT_FAILED,
            );
        }
        Some(path)
    } else {
        cwd
    };
    let layout = InjectedLayout::at(bundle);
    let mut resolved = match user {
        Some(spec) => match cognia_sandboxd::passwd::resolve_user(root, spec) {
            Ok(user) => Some(user),
            Err(error) => return fail(error, EXIT_INIT_FAILED),
        },
        None => None,
    };
    if let (Some(dir), Some(UserSpec::Name(_)), Some(declared)) =
        (match_owner_of, user, resolved.as_ref())
    {
        match probe::ownership_of(root, dir) {
            Some(owner) => {
                if let Some(remapped) =
                    cognia_sandboxd::passwd::remap_to_owner(declared, owner.uid, owner.gid)
                {
                    hand_over_home(root, declared, &remapped);
                    resolved = Some(remapped);
                }
            }
            None => return fail(format!("cannot read the owner of {dir}"), EXIT_INIT_FAILED),
        }
    }

    // The probe's findings when the driver staged them; otherwise look again.
    let (libc, image_ca) = match read_probe(&layout.probe()) {
        Ok(report) => (report.libc, report.ca_bundle),
        Err(_) => (
            Arch::current().and_then(|arch| probe::inspect_shell(root, arch).libc),
            probe::find_ca_bundle(root),
        ),
    };
    let input = cognia_sandboxd::env::ChildEnvInput {
        parent: &parent,
        layout: &layout,
        libc,
        user: resolved.as_ref(),
        image_ca_bundle: image_ca.as_deref(),
    };
    let env = match &runtime {
        Some(runtime) => match cognia_sandboxd::env::build_runtime_child_env(&input, runtime) {
            Ok(env) => env,
            Err(error) => return fail(error, EXIT_INIT_FAILED),
        },
        None => cognia_sandboxd::env::build_child_env(&input),
    };

    run_agent(argv, env, resolved, cwd, runtime.as_ref())
}

#[cfg(unix)]
fn run_agent(
    argv: Vec<OsString>,
    env: BTreeMap<String, String>,
    user: Option<cognia_sandboxd::passwd::ResolvedUser>,
    cwd: Option<PathBuf>,
    runtime: Option<&cognia_sandboxd::env::RuntimeConfigV1>,
) -> ExitCode {
    use cognia_sandboxd::init::{self, InitOptions};
    match init::run_with_runtime(
        InitOptions {
            argv,
            env,
            user,
            cwd,
        },
        runtime,
    ) {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(error) => fail(error, EXIT_INIT_FAILED),
    }
}

#[cfg(not(unix))]
fn run_agent(
    _argv: Vec<OsString>,
    _env: BTreeMap<String, String>,
    _user: Option<cognia_sandboxd::passwd::ResolvedUser>,
    _cwd: Option<PathBuf>,
    _runtime: Option<&cognia_sandboxd::env::RuntimeConfigV1>,
) -> ExitCode {
    fail("init-agent only runs on Linux", EXIT_INIT_FAILED)
}

/// Gives a remapped user's home to the uid it now runs as. Failures are
/// reported and the agent still starts: a home it cannot write is a problem
/// the agent can name, a missing agent is not.
#[cfg(unix)]
fn hand_over_home(
    root: &Path,
    declared: &cognia_sandboxd::passwd::ResolvedUser,
    remapped: &cognia_sandboxd::passwd::ResolvedUser,
) {
    use cognia_sandboxd::init::{apply_handover, plan_home_handover, HANDOVER_ENTRY_LIMIT};
    use cognia_sandboxd::probe::Ownership;

    let Some(home) = declared.home.as_deref().filter(|home| *home != "/") else {
        return;
    };
    let Ok(host) = cognia_sandboxd::rootfs::resolve(root, home) else {
        return;
    };
    let from = Ownership {
        uid: declared.uid,
        gid: declared.gid,
    };
    let to = Ownership {
        uid: remapped.uid,
        gid: remapped.gid,
    };
    match plan_home_handover(&host, from, to, HANDOVER_ENTRY_LIMIT) {
        Ok(plan) => {
            if plan.truncated {
                eprintln!(
                    "cognia-sandboxd: {home} has more than {HANDOVER_ENTRY_LIMIT} entries; only the first were handed over"
                );
            }
            for (path, error) in apply_handover(&plan) {
                eprintln!(
                    "cognia-sandboxd: cannot hand over {}: {error}",
                    path.display()
                );
            }
        }
        Err(error) => eprintln!("cognia-sandboxd: cannot walk {home}: {error}"),
    }
}

#[cfg(not(unix))]
fn hand_over_home(
    _root: &Path,
    _declared: &cognia_sandboxd::passwd::ResolvedUser,
    _remapped: &cognia_sandboxd::passwd::ResolvedUser,
) {
}

fn read_probe(path: &Path) -> Result<ProbeReport, String> {
    let bytes =
        std::fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is not a probe report: {error}", path.display()))
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(unix)]
fn effective_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

#[cfg(not(unix))]
fn effective_uid() -> u32 {
    0
}
