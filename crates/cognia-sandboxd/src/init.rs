//! `init-agent`: a reaping PID 1 that runs one agent (ADR-0183).
//!
//! The user image's entrypoint is replaced by this, so it inherits PID 1's
//! duties: a PID 1 with no handler ignores `SIGTERM`, and orphans reparented
//! to it stay zombies unless it reaps them. It runs exactly one child with the
//! container's stdio — ACP over container attach is unchanged — forwards the
//! signals a runtime sends, reaps everything, and exits with the child's
//! status (`128 + n` for a child killed by signal `n`, as a shell reports it).

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use signal_hook::consts::signal::{
    SIGALRM, SIGCHLD, SIGCONT, SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2, SIGWINCH,
};
use signal_hook::iterator::Signals;

use crate::passwd::ResolvedUser;

/// Signals passed on to the agent. `SIGKILL` and `SIGSTOP` cannot be caught
/// and need no forwarding: the runtime delivers those to the whole container.
pub const FORWARDED_SIGNALS: [i32; 9] = [
    SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2, SIGWINCH, SIGCONT, SIGALRM,
];

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
}

/// Runs the agent to completion and returns the status to exit with.
pub fn run(options: InitOptions) -> Result<i32, InitError> {
    let Some((program, args)) = options.argv.split_first() else {
        return Err(InitError::NoCommand);
    };

    become_subreaper();

    // Registered before the child exists, so an early SIGCHLD is not lost.
    let mut watched: Vec<i32> = FORWARDED_SIGNALS.to_vec();
    watched.push(SIGCHLD);
    let mut signals = Signals::new(&watched).map_err(InitError::Signals)?;

    let mut command = Command::new(program);
    command.args(args).env_clear().envs(&options.env);
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    if let Some(user) = &options.user {
        // SAFETY: geteuid has no preconditions and cannot fail.
        let current = unsafe { libc::geteuid() };
        if current != user.uid {
            if current != 0 {
                return Err(InitError::UserSwitchRequiresRoot {
                    uid: user.uid,
                    current,
                });
            }
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

    let child = command.spawn().map_err(|source| InitError::Spawn {
        program: program.to_string_lossy().into_owned(),
        source,
    })?;
    let pid = child.id() as libc::pid_t;
    // The child is waited on with waitpid(-1) below; std's handle must not
    // reap it first.
    drop(child);

    let mut status_of_child = None;
    for signal in signals.forever() {
        if signal == SIGCHLD {
            loop {
                let mut status = 0;
                // SAFETY: a valid out-pointer; WNOHANG makes this non-blocking.
                let reaped = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
                if reaped <= 0 {
                    break;
                }
                if reaped == pid {
                    status_of_child = Some(exit_status(status));
                }
            }
            if let Some(code) = status_of_child {
                return Ok(code);
            }
        } else {
            // SAFETY: kill has no memory preconditions; a child that already
            // exited makes it fail with ESRCH, which is harmless here.
            unsafe {
                libc::kill(pid, signal);
            }
        }
    }
    unreachable!("Signals::forever only ends when the handle is closed")
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

    #[test]
    fn maps_wait_statuses_like_a_shell() {
        // Encodings shared by Linux and macOS: exit code in the high byte,
        // terminating signal in the low seven bits.
        assert_eq!(exit_status(3 << 8), 3);
        assert_eq!(exit_status(0), 0);
        assert_eq!(exit_status(SIGTERM), 128 + SIGTERM);
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
}
