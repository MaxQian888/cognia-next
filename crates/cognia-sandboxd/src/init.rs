//! `init-agent`: a reaping PID 1 that runs one agent (ADR-0183).
//!
//! The user image's entrypoint is replaced by this, so it inherits PID 1's
//! duties: a PID 1 with no handler ignores `SIGTERM`, and orphans reparented
//! to it stay zombies unless it reaps them. It runs exactly one child with the
//! container's stdio — ACP over container attach is unchanged — forwards the
//! signals a runtime sends, reaps everything, and exits with the child's
//! status (`128 + n` for a child killed by signal `n`, as a shell reports it).

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use signal_hook::consts::signal::{
    SIGALRM, SIGCHLD, SIGCONT, SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2, SIGWINCH,
};
use signal_hook::iterator::Signals;

use crate::env::{RuntimeCommand, RuntimeConfigV1};
use crate::passwd::ResolvedUser;
use crate::probe::Ownership;

/// Entries a home handover will look at before it stops and says so. A home
/// in a user image is a few config files; one this large is not something to
/// walk on every agent start.
pub const HANDOVER_ENTRY_LIMIT: usize = 100_000;

/// One ownership change: `None` leaves that id as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnershipChange {
    pub path: PathBuf,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HandoverPlan {
    pub changes: Vec<OwnershipChange>,
    /// The walk stopped at [`HANDOVER_ENTRY_LIMIT`].
    pub truncated: bool,
}

/// What must change under `home` for a user remapped from `from` to `to`
/// (ADR-0183): entries owned by the old uid get the new one, entries in the
/// old primary group get the new gid — `usermod -u` and `groupmod -g`, applied
/// to the home only.
///
/// Symlinks are changed themselves, never followed, and the walk stays on
/// `home`'s filesystem, so a mount under it (the workspace volume, the
/// injected bundle) is never touched. This runs in the container's own
/// writable layer; the image and every volume stay as they were.
pub fn plan_home_handover(
    home: &Path,
    from: Ownership,
    to: Ownership,
    limit: usize,
) -> io::Result<HandoverPlan> {
    let top = fs::symlink_metadata(home)?;
    let device = top.dev();
    let mut plan = HandoverPlan::default();
    let mut pending = vec![(home.to_path_buf(), top)];
    let mut visited = 0usize;
    while let Some((path, metadata)) = pending.pop() {
        if visited == limit {
            plan.truncated = true;
            break;
        }
        visited += 1;
        let uid = (metadata.uid() == from.uid && from.uid != to.uid).then_some(to.uid);
        let gid = (metadata.gid() == from.gid && from.gid != to.gid).then_some(to.gid);
        if uid.is_some() || gid.is_some() {
            plan.changes.push(OwnershipChange {
                path: path.clone(),
                uid,
                gid,
            });
        }
        if metadata.file_type().is_dir() && metadata.dev() == device {
            let mut children = Vec::new();
            for entry in fs::read_dir(&path)? {
                let entry = entry?;
                let child = fs::symlink_metadata(entry.path())?;
                if child.dev() == device {
                    children.push((entry.path(), child));
                }
            }
            children.sort_by(|a, b| b.0.cmp(&a.0));
            pending.extend(children);
        }
    }
    Ok(plan)
}

/// Applies a plan with `lchown`. Returns the changes that failed; one
/// unchangeable file must not keep the agent from starting.
pub fn apply_handover(plan: &HandoverPlan) -> Vec<(PathBuf, io::Error)> {
    use std::os::unix::ffi::OsStrExt;
    let mut failures = Vec::new();
    for change in &plan.changes {
        let Ok(path) = std::ffi::CString::new(change.path.as_os_str().as_bytes()) else {
            failures.push((
                change.path.clone(),
                io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"),
            ));
            continue;
        };
        // `-1` (as uid_t/gid_t) leaves that id unchanged.
        let uid = change.uid.unwrap_or(u32::MAX);
        let gid = change.gid.unwrap_or(u32::MAX);
        // SAFETY: `path` is a valid NUL-terminated string for the call's
        // duration; lchown has no other memory preconditions.
        if unsafe { libc::lchown(path.as_ptr(), uid, gid) } != 0 {
            failures.push((change.path.clone(), io::Error::last_os_error()));
        }
    }
    failures
}

/// Signals passed on to the agent. `SIGKILL` and `SIGSTOP` cannot be caught
/// and need no forwarding: the runtime delivers those to the whole container.
pub const FORWARDED_SIGNALS: [i32; 9] = [
    SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2, SIGWINCH, SIGCONT, SIGALRM,
];

#[derive(Clone)]
pub struct InitOptions {
    /// The program and its arguments.
    pub argv: Vec<OsString>,
    /// The child's complete environment (see [`crate::env::build_child_env`]).
    pub env: BTreeMap<String, String>,
    /// Who to become; `None` keeps the supervisor's identity.
    pub user: Option<ResolvedUser>,
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum InitError {
    #[error("no command to run")]
    NoCommand,
    #[error("switching to uid {uid} needs root, and this process runs as uid {current}")]
    UserSwitchRequiresRoot { uid: u32, current: u32 },
    #[error("cannot watch signals: {0}")]
    Signals(io::Error),
    #[error("cannot start {program}: {source}")]
    Spawn { program: String, source: io::Error },
    #[error("invalid runtime configuration: {0}")]
    Runtime(#[from] crate::env::RuntimeConfigError),
    #[error("cannot set up child output: {0}")]
    Output(io::Error),
    #[error("cannot read the current process groups: {0}")]
    Groups(io::Error),
    #[error("changing the current user's groups needs root")]
    GroupSwitchRequiresRoot,
}

/// Runs the agent to completion and returns the status to exit with.
pub fn run(options: InitOptions) -> Result<i32, InitError> {
    run_with_runtime(options, None)
}

/// The lifecycle and agent share one signal subscription: there is no gap
/// between preparation phases during which PID 1 can lose a cancellation.
pub fn run_with_runtime(
    options: InitOptions,
    runtime: Option<&RuntimeConfigV1>,
) -> Result<i32, InitError> {
    if options.argv.is_empty() {
        return Err(InitError::NoCommand);
    }
    if let Some(runtime) = runtime {
        runtime.validate()?;
    }
    become_subreaper();
    let mut watched: Vec<i32> = FORWARDED_SIGNALS.to_vec();
    watched.push(SIGCHLD);
    let mut signals = Signals::new(&watched).map_err(InitError::Signals)?;
    if let Some(runtime) = runtime {
        for phase in &runtime.lifecycle_phases {
            if let Some(command) = runtime.lifecycle_commands.get(*phase) {
                let commands = lifecycle_tasks(command);
                let code = supervise(
                    &options,
                    &commands,
                    true,
                    Some(Duration::from_millis(runtime.lifecycle_timeout_ms)),
                    &mut signals,
                )?;
                if code != 0 {
                    eprintln!("cognia-sandboxd: lifecycle {phase:?} failed with status {code}");
                    return Ok(code);
                }
            }
        }
    }
    supervise(
        &options,
        &[CommandTask {
            argv: options.argv.clone(),
            dependencies: BTreeSet::new(),
        }],
        false,
        None,
        &mut signals,
    )
}

struct CommandTask {
    argv: Vec<OsString>,
    dependencies: BTreeSet<usize>,
}

/// Compile the bounded tree into prerequisites. Sequence waits for every
/// terminal task in its preceding group; parallel siblings share prerequisites.
fn lifecycle_tasks(command: &RuntimeCommand) -> Vec<CommandTask> {
    fn append(
        command: &RuntimeCommand,
        dependencies: &BTreeSet<usize>,
        tasks: &mut Vec<CommandTask>,
    ) -> BTreeSet<usize> {
        let argv = match command {
            RuntimeCommand::Shell { command } => {
                vec!["/bin/sh".into(), "-c".into(), command.into()]
            }
            RuntimeCommand::Argv { argv } => argv.iter().map(OsString::from).collect(),
            RuntimeCommand::Parallel { commands } => {
                return commands
                    .values()
                    .flat_map(|command| append(command, dependencies, tasks))
                    .collect()
            }
            RuntimeCommand::Sequence { commands } => {
                return commands
                    .iter()
                    .fold(dependencies.clone(), |previous, command| {
                        append(command, &previous, tasks)
                    })
            }
        };
        let index = tasks.len();
        tasks.push(CommandTask {
            argv,
            dependencies: dependencies.clone(),
        });
        BTreeSet::from([index])
    }
    let mut tasks = Vec::new();
    append(command, &BTreeSet::new(), &mut tasks);
    tasks
}

fn child_command(
    options: &InitOptions,
    argv: &[OsString],
    lifecycle: bool,
) -> Result<Command, InitError> {
    let Some((program, args)) = argv.split_first() else {
        return Err(InitError::NoCommand);
    };
    let mut command = Command::new(program);
    command.args(args).env_clear().envs(&options.env);
    command.process_group(0);
    if lifecycle {
        // Setup output must never be mistaken for an ACP stdout frame.
        use std::os::fd::FromRawFd;
        // SAFETY: dup returns a fresh descriptor which Stdio exclusively owns.
        let stderr = unsafe { libc::dup(libc::STDERR_FILENO) };
        if stderr < 0 {
            return Err(InitError::Output(io::Error::last_os_error()));
        }
        command.stdout(unsafe { Stdio::from_raw_fd(stderr) });
        command.stdin(Stdio::null());
    }
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    if let Some(user) = &options.user {
        // SAFETY: geteuid has no preconditions and cannot fail.
        let current = unsafe { libc::geteuid() };
        if current != 0 {
            if current != user.uid {
                return Err(InitError::UserSwitchRequiresRoot {
                    uid: user.uid,
                    current,
                });
            }
            // An unprivileged caller can retain its identity, but must not
            // silently run with a different primary or supplementary group.
            let mut groups = current_groups()?;
            groups.insert(unsafe { libc::getegid() });
            let wanted: BTreeSet<_> = user.groups.iter().copied().chain([user.gid]).collect();
            if unsafe { libc::getegid() } != user.gid || groups != wanted {
                return Err(InitError::GroupSwitchRequiresRoot);
            }
        } else {
            // Root applies the whole identity even when uid stays zero.
            let groups: Vec<libc::gid_t> = user.groups.clone();
            let (uid, gid) = (user.uid, user.gid);
            // SAFETY: the closure runs between fork and exec and only calls
            // async-signal-safe functions on data prepared before the fork.
            // Order matters: groups and gid while still root, uid last.
            unsafe {
                command.pre_exec(move || {
                    if libc::setgroups(groups.len() as _, groups.as_ptr()) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::setgid(gid) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::setuid(uid) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
    }

    Ok(command)
}

fn current_groups() -> Result<BTreeSet<u32>, InitError> {
    // SAFETY: first query the length, then supply the allocated output array.
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if count < 0 {
        return Err(InitError::Groups(io::Error::last_os_error()));
    }
    let mut groups = vec![0; count as usize];
    let count = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
    if count < 0 {
        return Err(InitError::Groups(io::Error::last_os_error()));
    }
    groups.truncate(count as usize);
    Ok(groups.into_iter().collect())
}

fn signal_groups(groups: &BTreeSet<libc::pid_t>, signal: i32) {
    for pid in groups {
        // SAFETY: a negative pid selects the child's independent process
        // group. Missing/exited groups are harmless (ESRCH).
        unsafe {
            libc::kill(-*pid, signal);
        }
    }
}

/// Reap all descendants while watching only this phase's direct children.
/// A failed parallel command cancels its peers and their descendants. A
/// successful setup may intentionally leave a background server running.
fn supervise(
    options: &InitOptions,
    commands: &[CommandTask],
    lifecycle: bool,
    timeout: Option<Duration>,
    signals: &mut Signals,
) -> Result<i32, InitError> {
    for signal in signals.pending() {
        if matches!(signal, SIGTERM | SIGINT | SIGQUIT | SIGHUP) {
            return Ok(128 + signal);
        }
    }
    let mut children = BTreeMap::new();
    let mut groups = BTreeSet::new();
    let mut launched = BTreeSet::new();
    let mut completed = BTreeSet::new();
    let mut spawn_error = None;
    let started = Instant::now();
    let mut outcome = None;
    let mut stopping = None;
    loop {
        for signal in signals.pending() {
            if signal == SIGCHLD {
                continue;
            }
            signal_groups(&groups, signal);
            if matches!(signal, SIGTERM | SIGINT | SIGQUIT | SIGHUP) && outcome.is_none() {
                // Lifecycle cancellation prevents the following stage even
                // if a hook traps TERM and exits zero. The final agent keeps
                // its own exit status, including an application-specific
                // status returned by a graceful signal handler.
                if lifecycle || launched.is_empty() {
                    outcome = Some(128 + signal);
                }
                stopping.get_or_insert_with(Instant::now);
            }
        }
        loop {
            let mut status = 0;
            // SAFETY: valid output pointer; WNOHANG never blocks.
            let reaped = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
            if reaped <= 0 {
                break;
            }
            if let Some(index) = children.remove(&reaped) {
                completed.insert(index);
                let code = exit_status(status);
                if (code != 0 || !lifecycle) && outcome.is_none() {
                    outcome = Some(code);
                    stopping = Some(Instant::now());
                    signal_groups(&groups, SIGTERM);
                }
            }
        }
        if timeout.is_some_and(|limit| started.elapsed() >= limit) && outcome.is_none() {
            outcome = Some(124);
            stopping = Some(Instant::now());
            signal_groups(&groups, SIGTERM);
        }
        if outcome.is_none() && stopping.is_none() {
            for (index, task) in commands.iter().enumerate() {
                if launched.contains(&index) || !task.dependencies.is_subset(&completed) {
                    continue;
                }
                match child_command(options, &task.argv, lifecycle).and_then(|mut command| {
                    command.spawn().map_err(|source| InitError::Spawn {
                        program: task.argv[0].to_string_lossy().into_owned(),
                        source,
                    })
                }) {
                    Ok(child) => {
                        let pid = child.id() as libc::pid_t;
                        children.insert(pid, index);
                        launched.insert(index);
                        groups.insert(pid);
                        drop(child);
                    }
                    Err(error) => {
                        spawn_error = Some(error);
                        outcome = Some(125);
                        stopping = Some(Instant::now());
                        signal_groups(&groups, SIGTERM);
                        break;
                    }
                }
            }
        }
        if children.is_empty() && (outcome.is_some() || completed.len() == commands.len()) {
            if outcome.is_some() {
                signal_groups(&groups, libc::SIGKILL);
            }
            return match spawn_error {
                Some(error) => Err(error),
                None => Ok(outcome.unwrap_or(0)),
            };
        }
        if stopping.is_some_and(|at| at.elapsed() >= Duration::from_secs(2)) {
            signal_groups(&groups, libc::SIGKILL);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The shell convention for a wait status.
pub fn exit_status(status: libc::c_int) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        1
    }
}

#[cfg(target_os = "linux")]
fn become_subreaper() {
    // Orphans of the agent come to us even when a runtime's own init is PID 1.
    // Failure only means an older kernel; PID 1 reaps them regardless.
    // SAFETY: prctl with PR_SET_CHILD_SUBREAPER takes plain integers.
    unsafe {
        libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
    }
}

#[cfg(not(target_os = "linux"))]
fn become_subreaper() {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::{LifecyclePhase, RuntimeLifecycleCommands};

    #[test]
    fn maps_wait_statuses_like_a_shell() {
        // Encodings shared by Linux and macOS: exit code in the high byte,
        // terminating signal in the low seven bits.
        assert_eq!(exit_status(3 << 8), 3);
        assert_eq!(exit_status(0), 0);
        assert_eq!(exit_status(SIGTERM), 128 + SIGTERM);
    }

    fn me() -> Ownership {
        // SAFETY: getuid/getgid have no preconditions and cannot fail.
        unsafe {
            Ownership {
                uid: libc::getuid(),
                gid: libc::getgid(),
            }
        }
    }

    #[test]
    fn a_home_handover_changes_what_the_old_ids_own_without_following_links() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".config/app")).unwrap();
        fs::write(home.path().join(".config/app/settings.json"), "{}").unwrap();
        fs::write(home.path().join(".profile"), "").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("link")).unwrap();

        let from = me();
        let to = Ownership {
            uid: from.uid.wrapping_add(7),
            gid: from.gid.wrapping_add(7),
        };
        let plan = plan_home_handover(home.path(), from, to, HANDOVER_ENTRY_LIMIT).unwrap();
        let mut paths: Vec<_> = plan
            .changes
            .iter()
            .map(|change| change.path.strip_prefix(home.path()).unwrap().to_path_buf())
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            [
                "",
                ".config",
                ".config/app",
                ".config/app/settings.json",
                ".profile",
                "link"
            ]
            .map(PathBuf::from)
        );
        assert!(plan
            .changes
            .iter()
            .all(|change| change.uid == Some(to.uid) && change.gid == Some(to.gid)));
        assert!(!plan.truncated);

        // The link is changed, the directory it points at is never walked.
        fs::write(outside.path().join("not-mine"), "").unwrap();
        let again = plan_home_handover(home.path(), from, to, HANDOVER_ENTRY_LIMIT).unwrap();
        assert!(again
            .changes
            .iter()
            .all(|change| !change.path.ends_with("not-mine")));
    }

    #[test]
    fn a_home_handover_touches_only_the_ids_that_changed_and_stops_at_its_limit() {
        let home = tempfile::tempdir().unwrap();
        for index in 0..5 {
            fs::write(home.path().join(format!("file-{index}")), "").unwrap();
        }
        let from = me();
        let uid_only = Ownership {
            uid: from.uid.wrapping_add(1),
            gid: from.gid,
        };
        let plan = plan_home_handover(home.path(), from, uid_only, HANDOVER_ENTRY_LIMIT).unwrap();
        assert!(plan.changes.iter().all(|change| change.gid.is_none()));

        let nothing = plan_home_handover(home.path(), from, from, HANDOVER_ENTRY_LIMIT).unwrap();
        assert!(nothing.changes.is_empty());

        let limited = plan_home_handover(home.path(), from, uid_only, 3).unwrap();
        assert!(limited.truncated);
        assert_eq!(limited.changes.len(), 3);

        // Applying a plan that keeps our own ids is a harmless round trip.
        let own = HandoverPlan {
            changes: vec![OwnershipChange {
                path: home.path().join("file-0"),
                uid: Some(from.uid),
                gid: None,
            }],
            truncated: false,
        };
        assert!(apply_handover(&own).is_empty());
    }

    #[test]
    fn refuses_to_start_without_a_command() {
        let error = run(InitOptions {
            argv: vec![],
            env: BTreeMap::new(),
            user: None,
            cwd: None,
        })
        .unwrap_err();
        assert!(matches!(error, InitError::NoCommand));
    }

    // Each supervisor test runs in its own process: PID 1's waitpid(-1) and
    // signal handlers must not reap another parallel Rust test's children.
    #[test]
    fn lifecycle_subprocess_fixture() {
        let Ok(path) = std::env::var("COGNIA_TEST_RUNTIME_PATH") else {
            return;
        };
        let config: RuntimeConfigV1 = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let directory = std::env::var("COGNIA_TEST_RUNTIME_CWD").unwrap();
        let mut env = BTreeMap::from([("PATH".into(), "/bin:/usr/bin".into())]);
        env.insert("ORDER".into(), format!("{directory}/order"));
        let argv = vec![
            "/bin/sh".into(),
            "-c".into(),
            std::env::var("COGNIA_TEST_AGENT_COMMAND").unwrap().into(),
        ];
        let result = run_with_runtime(
            InitOptions {
                argv,
                env,
                user: None,
                cwd: Some(directory.into()),
            },
            Some(&config),
        );
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(125);
            }
        }
    }

    fn fixture_command(dir: &Path, config: &RuntimeConfigV1, agent: &str) -> Command {
        let config_path = dir.join("runtime.json");
        fs::write(&config_path, serde_json::to_vec(config).unwrap()).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "init::tests::lifecycle_subprocess_fixture",
                "--nocapture",
            ])
            .env("COGNIA_TEST_RUNTIME_PATH", config_path)
            .env("COGNIA_TEST_RUNTIME_CWD", dir)
            .env("COGNIA_TEST_AGENT_COMMAND", agent);
        command
    }

    fn shell(command: &str) -> RuntimeCommand {
        RuntimeCommand::Shell {
            command: command.into(),
        }
    }

    #[test]
    fn lifecycle_phases_run_in_order_and_setup_output_never_enters_agent_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let config = RuntimeConfigV1 {
            lifecycle_phases: vec![
                LifecyclePhase::OnCreate,
                LifecyclePhase::UpdateContent,
                LifecyclePhase::PostCreate,
                LifecyclePhase::PostStart,
                LifecyclePhase::PostAttach,
            ],
            lifecycle_commands: RuntimeLifecycleCommands {
                on_create: Some(shell(
                    "printf 'create,' >> \"$ORDER\"; printf 'setup-output'",
                )),
                update_content: Some(RuntimeCommand::Argv {
                    argv: vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "printf 'update,' >> \"$ORDER\"".into(),
                    ],
                }),
                post_create: Some(shell("printf 'postcreate,' >> \"$ORDER\"")),
                post_start: Some(shell("printf 'start,' >> \"$ORDER\"")),
                post_attach: Some(shell("printf 'attach,' >> \"$ORDER\"")),
            },
            ..RuntimeConfigV1::default()
        };
        let output = fixture_command(
            dir.path(),
            &config,
            "printf 'agent' >> \"$ORDER\"; printf 'agent-output'",
        )
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("order")).unwrap(),
            "create,update,postcreate,start,attach,agent"
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("setup-output"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("setup-output"));
        assert!(String::from_utf8_lossy(&output.stdout).contains("agent-output"));
    }

    #[test]
    fn parallel_lifecycle_children_start_concurrently_and_all_finish_before_agent() {
        let dir = tempfile::tempdir().unwrap();
        let config = RuntimeConfigV1 {
            lifecycle_timeout_ms: 1_000,
            lifecycle_phases: vec![LifecyclePhase::OnCreate],
            lifecycle_commands: RuntimeLifecycleCommands {
                on_create: Some(RuntimeCommand::Parallel { commands: BTreeMap::from([
                    ("left".into(), shell("touch left; while [ ! -e right ]; do sleep 0.01; done; touch left-done")),
                    ("right".into(), shell("touch right; while [ ! -e left ]; do sleep 0.01; done; touch right-done")),
                ]) }),
                ..RuntimeLifecycleCommands::default()
            },
            ..RuntimeConfigV1::default()
        };
        let output = fixture_command(
            dir.path(),
            &config,
            "test -e left-done && test -e right-done",
        )
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn failing_preparation_blocks_remaining_phases_and_the_agent() {
        let dir = tempfile::tempdir().unwrap();
        let config = RuntimeConfigV1 {
            lifecycle_phases: vec![LifecyclePhase::OnCreate, LifecyclePhase::PostStart],
            lifecycle_commands: RuntimeLifecycleCommands {
                on_create: Some(RuntimeCommand::Sequence {
                    commands: vec![
                        shell("touch first-step"),
                        shell("exit 17"),
                        shell("touch sequence-must-not-run"),
                    ],
                }),
                post_start: Some(shell("touch should-not-run")),
                ..RuntimeLifecycleCommands::default()
            },
            ..RuntimeConfigV1::default()
        };
        let output = fixture_command(dir.path(), &config, "touch agent-must-not-run")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(17));
        assert!(dir.path().join("first-step").exists());
        assert!(!dir.path().join("sequence-must-not-run").exists());
        assert!(!dir.path().join("should-not-run").exists());
        assert!(!dir.path().join("agent-must-not-run").exists());
    }

    #[test]
    fn parallel_failure_and_timeout_kill_peers_instead_of_leaving_them_running() {
        for timeout in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut commands = BTreeMap::from([(
                "blocking".into(),
                shell("trap '' TERM; sleep 30 & echo $! > descendant; wait"),
            )]);
            if !timeout {
                commands.insert(
                    "failure".into(),
                    shell("while [ ! -e descendant ]; do sleep 0.01; done; exit 19"),
                );
            }
            let config = RuntimeConfigV1 {
                lifecycle_timeout_ms: 1_000,
                lifecycle_phases: vec![LifecyclePhase::OnCreate],
                lifecycle_commands: RuntimeLifecycleCommands {
                    on_create: Some(RuntimeCommand::Sequence {
                        commands: vec![
                            RuntimeCommand::Parallel { commands },
                            shell("touch sequence-must-not-run"),
                        ],
                    }),
                    ..RuntimeLifecycleCommands::default()
                },
                ..RuntimeConfigV1::default()
            };
            let started = Instant::now();
            let output = fixture_command(dir.path(), &config, "touch agent-must-not-run")
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(if timeout { 124 } else { 19 }));
            assert!(started.elapsed() < Duration::from_secs(8));
            assert!(!dir.path().join("agent-must-not-run").exists());
            assert!(!dir.path().join("sequence-must-not-run").exists());
            let pid: i32 = fs::read_to_string(dir.path().join("descendant"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "setup descendant must not survive"
            );
        }
    }

    #[test]
    fn cancellation_during_preparation_reaches_children_and_blocks_the_agent() {
        let dir = tempfile::tempdir().unwrap();
        let config = RuntimeConfigV1 {
            lifecycle_phases: vec![LifecyclePhase::OnCreate],
            lifecycle_commands: RuntimeLifecycleCommands {
                on_create: Some(RuntimeCommand::Sequence {
                    commands: vec![
                        shell("touch ready; sleep 30"),
                        shell("touch sequence-must-not-run"),
                    ],
                }),
                ..RuntimeLifecycleCommands::default()
            },
            ..RuntimeConfigV1::default()
        };
        let child = fixture_command(dir.path(), &config, "touch agent-must-not-run")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !dir.path().join("ready").exists() {
            assert!(started.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(unsafe { libc::kill(child.id() as i32, SIGTERM) }, 0);
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(128 + SIGTERM));
        assert!(!dir.path().join("agent-must-not-run").exists());
        assert!(!dir.path().join("sequence-must-not-run").exists());
    }

    #[test]
    fn sequence_preserves_parallel_barriers_and_each_nested_branch_order() {
        let dir = tempfile::tempdir().unwrap();
        let config = RuntimeConfigV1 {
            lifecycle_timeout_ms: 2_000,
            lifecycle_phases: vec![LifecyclePhase::OnCreate],
            lifecycle_commands: RuntimeLifecycleCommands {
                on_create: Some(RuntimeCommand::Sequence { commands: vec![
                    shell("printf before, >> \"$ORDER\"; touch before"),
                    RuntimeCommand::Parallel { commands: BTreeMap::from([
                        ("left".into(), RuntimeCommand::Sequence { commands: vec![
                            shell("test -e before; touch left; while [ ! -e right ]; do sleep 0.01; done; touch left-first"),
                            shell("test -e left-first; touch left-done"),
                        ] }),
                        ("right".into(), RuntimeCommand::Sequence { commands: vec![
                            shell("test -e before; touch right; while [ ! -e left ]; do sleep 0.01; done; touch right-first"),
                            shell("test -e right-first; touch right-done"),
                        ] }),
                    ]) },
                    shell("test -e left-done && test -e right-done && printf after, >> \"$ORDER\""),
                ] }),
                ..RuntimeLifecycleCommands::default()
            },
            ..RuntimeConfigV1::default()
        };
        let output = fixture_command(dir.path(), &config, "printf agent >> \"$ORDER\"")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("order")).unwrap(),
            "before,after,agent"
        );
    }
}
