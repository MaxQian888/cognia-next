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
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use signal_hook::consts::signal::{
    SIGALRM, SIGCHLD, SIGCONT, SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2, SIGWINCH,
};
use signal_hook::iterator::Signals;

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
}
