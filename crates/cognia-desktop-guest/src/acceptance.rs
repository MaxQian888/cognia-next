//! Fixed, supervised entry into the already verified desktop boundary. There
//! is no general nsenter/argv/environment API and no project parsing as root.

use crate::boundary::{self, Boundary};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const NAMES: [&str; 6] = ["user", "mnt", "net", "pid", "ipc", "uts"];
const MAX_SPEC: usize = 4096;
const SETUP: Duration = Duration::from_secs(10);
const NAMESPACE_MASK: i32 = libc::CLONE_NEWUSER
    | libc::CLONE_NEWNS
    | libc::CLONE_NEWNET
    | libc::CLONE_NEWPID
    | libc::CLONE_NEWIPC
    | libc::CLONE_NEWUTS;

fn refused() -> io::Error {
    io::Error::other("acceptance boundary refused")
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchSpec {
    generation: String,
    operation_id: String,
    script: String,
    namespaces: BTreeMap<String, String>,
}

struct PinnedDesktop {
    init: OwnedFd,
    root: File,
    // Keep the original namespaces alive and their inode identities pinned;
    // these handles never enter either helper or workload.
    _namespaces: Vec<File>,
}

impl PinnedDesktop {
    fn pin(boundary: &Boundary) -> io::Result<Self> {
        if !boundary::still_current(boundary) || boundary.namespaces.len() != NAMES.len() {
            return Err(refused());
        }
        let init = pidfd(boundary.namespace_init_pid)?;
        let mut namespaces = Vec::new();
        for name in NAMES {
            if boundary::namespace(boundary.namespace_init_pid, name)
                .ok()
                .as_ref()
                != boundary.namespaces.get(name)
            {
                return Err(refused());
            }
            let file = File::open(format!("/proc/{}/ns/{name}", boundary.namespace_init_pid))?;
            let identity = format!("{name}:[{}]", file.metadata()?.ino());
            if boundary.namespaces.get(name) != Some(&identity) {
                return Err(refused());
            }
            namespaces.push(file);
        }
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(format!("/proc/{}/root", boundary.namespace_init_pid))?;
        if !alive(init.as_fd())? || !boundary::still_current(boundary) {
            return Err(refused());
        }
        Ok(Self {
            init,
            root,
            _namespaces: namespaces,
        })
    }
}

/// Retain until desktop teardown even after npm exits successfully: a project
/// can detach children. Losing ownership, deadline or failure kills the entire
/// original PID namespace, not merely a process group.
pub(crate) struct AcceptanceJob {
    helper: Child,
    pins: PinnedDesktop,
    deadline: Instant,
    workload_pid: u32,
}

impl AcceptanceJob {
    pub(crate) fn pid(&self) -> u32 {
        self.workload_pid
    }

    /// Call on every supervisor monitor tick; do not discard successful jobs.
    pub(crate) fn check(&mut self) -> io::Result<()> {
        let live = match alive(self.pins.init.as_fd()) {
            Ok(live) => live,
            Err(error) => {
                self.abort();
                return Err(error);
            }
        };
        if Instant::now() >= self.deadline || !live {
            self.abort();
            return Err(refused());
        }
        let status = match self.helper.try_wait() {
            Ok(status) => status,
            Err(error) => {
                self.abort();
                return Err(error);
            }
        };
        if status.is_some_and(|status| !status.success()) {
            self.abort();
            return Err(refused());
        }
        Ok(())
    }

    pub(crate) fn abort(&mut self) {
        kill_pidfd(self.pins.init.as_fd());
        let _ = self.helper.kill();
    }
}

impl Drop for AcceptanceJob {
    fn drop(&mut self) {
        self.abort();
        // Bounded reap. Provider TTL/destroy remains the independent backstop.
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            match self.helper.try_wait() {
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                _ => break,
            }
        }
    }
}

/// Called only by the long-lived supervisor after protected promotion and
/// receipt validation. The request cannot select a path or executable.
pub(crate) fn spawn(
    boundary: &Boundary,
    operation: &str,
    script: &str,
    deadline: Instant,
) -> io::Result<AcceptanceJob> {
    validate_identifiers(operation, script)?;
    if unsafe { libc::geteuid() } != 0
        || !deadline
            .checked_duration_since(Instant::now())
            .is_some_and(|remaining| !remaining.is_zero() && remaining <= Duration::from_secs(3600))
    {
        return Err(refused());
    }
    validate_promoted_path(operation)?;
    let pins = PinnedDesktop::pin(boundary)?;
    let supervisor = pidfd(std::process::id())?;
    let (mut control, helper_control) = UnixStream::pair()?;
    control.set_read_timeout(Some(SETUP))?;
    control.set_write_timeout(Some(SETUP))?;
    let sources = [
        duplicate(pins.init.as_fd(), 7)?,
        duplicate(pins.root.as_fd(), 7)?,
        duplicate(helper_control.as_fd(), 7)?,
        duplicate(supervisor.as_fd(), 7)?,
    ];
    // Reserve every hole in 3..6 before std allocates its exec-error pipe.
    // All original sources stay alive until after spawn.
    let reservations = [
        duplicate(supervisor.as_fd(), 3)?,
        duplicate(supervisor.as_fd(), 3)?,
        duplicate(supervisor.as_fd(), 3)?,
        duplicate(supervisor.as_fd(), 3)?,
    ];
    let parent = unsafe { libc::getpid() };
    let mut command = Command::new("/usr/local/bin/cognia-desktop-guest");
    command
        .arg("acceptance-helper")
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: captures owned FDs; only raw syscalls run after fork.
    unsafe {
        command.pre_exec(move || {
            let _keep = &reservations;
            if libc::syscall(libc::SYS_close_range, 3_u32, u32::MAX, 4_u32) != 0 {
                return Err(io::Error::last_os_error());
            }
            for (index, source) in sources.iter().enumerate() {
                if libc::dup2(source.as_raw_fd(), 3 + index as i32) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0
                || libc::getppid() != parent
            {
                return Err(io::Error::from_raw_os_error(libc::ECHILD));
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    drop(command);
    drop(helper_control);
    let mut job = AcceptanceJob {
        helper: child,
        pins,
        deadline,
        workload_pid: 0,
    };
    let spec = LaunchSpec {
        generation: boundary.generation.clone(),
        operation_id: operation.into(),
        script: script.into(),
        namespaces: boundary.namespaces.clone(),
    };
    write_spec(&mut control, &spec)?;
    let mut bytes = [0_u8; 4];
    control.read_exact(&mut bytes)?;
    let pid = u32::from_be_bytes(bytes);
    validate_child(job.helper.id(), pid, boundary, operation)?;
    if !alive(job.pins.init.as_fd())?
        || !boundary::still_current(boundary)
        || Instant::now() >= deadline
    {
        return Err(refused());
    }
    control.write_all(b"G")?;
    let mut acknowledged = [0_u8; 1];
    control.read_exact(&mut acknowledged)?;
    if acknowledged != *b"E" {
        return Err(refused());
    }
    job.workload_pid = pid;
    job.check()?;
    Ok(job)
}

fn validate_child(parent: u32, pid: u32, boundary: &Boundary, operation: &str) -> io::Result<()> {
    if pid <= 1 || !boundary::descendants(parent)?.contains(&pid) {
        return Err(refused());
    }
    let started = boundary::start_time(pid)?;
    if !boundary::restricted_status(&fs::read_to_string(format!("/proc/{pid}/status"))?) {
        return Err(refused());
    }
    for name in NAMES {
        if boundary::namespace(pid, name).ok().as_ref() != boundary.namespaces.get(name) {
            return Err(refused());
        }
    }
    validate_child_fds(pid)?;
    // No source cwd is entered until this admission succeeds. The helper's
    // root/cwd must already be the desktop root, never the outer VM root.
    let expected = fs::metadata(format!("/proc/{}/root", boundary.namespace_init_pid))?;
    let actual = fs::metadata(format!("/proc/{pid}/root"))?;
    let cwd = fs::metadata(format!("/proc/{pid}/cwd"))?;
    if (actual.dev(), actual.ino()) != (expected.dev(), expected.ino())
        || (cwd.dev(), cwd.ino()) != (expected.dev(), expected.ino())
        || boundary::start_time(pid)? != started
    {
        return Err(refused());
    }
    validate_promoted_path(operation)
}

fn validate_child_fds(pid: u32) -> io::Result<()> {
    let mut streams = 0;
    let mut gates = 0;
    for entry in fs::read_dir(format!("/proc/{pid}/fd"))? {
        let entry = entry?;
        let number = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(refused)?;
        let target = fs::read_link(entry.path())?;
        let target = target.to_str().ok_or_else(refused)?;
        if number <= 2 && target == "/dev/null" {
            streams += 1;
        } else if number > 2 && is_pipe_identity(target) {
            gates += 1;
        } else {
            return Err(refused());
        }
    }
    if streams != 3 || gates != 2 {
        return Err(refused());
    }
    Ok(())
}

fn is_pipe_identity(value: &str) -> bool {
    value
        .strip_prefix("pipe:[")
        .and_then(|value| value.strip_suffix(']'))
        .is_some_and(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_identifiers(operation: &str, script: &str) -> io::Result<()> {
    let id = uuid::Uuid::parse_str(operation).map_err(|_| refused())?;
    if id.hyphenated().to_string() != operation
        || script.is_empty()
        || script.len() > 100
        || !script
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || b"_:".contains(&byte))
        || !script
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_:.-".contains(&byte))
    {
        return Err(refused());
    }
    Ok(())
}

fn validate_promoted_path(operation: &str) -> io::Result<()> {
    let root = Path::new("/var/lib/cognia-desktop/workspace");
    for path in [root.to_path_buf(), root.join(operation)] {
        let meta = fs::symlink_metadata(&path)?;
        if !meta.is_dir()
            || meta.uid() != 0
            || meta.gid() != 0
            || meta.mode() & 0o7777 != 0o711
            || fs::canonicalize(&path)? != path
        {
            return Err(refused());
        }
    }
    let work = root.join(operation).join("workspace");
    let meta = fs::symlink_metadata(&work)?;
    if !meta.is_dir()
        || meta.uid() != 1000
        || meta.gid() != 1000
        || fs::canonicalize(&work)? != work
    {
        return Err(refused());
    }
    Ok(())
}

fn write_spec(stream: &mut UnixStream, spec: &LaunchSpec) -> io::Result<()> {
    let bytes = serde_json::to_vec(spec).map_err(|_| refused())?;
    if bytes.len() > MAX_SPEC {
        return Err(refused());
    }
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(&bytes)
}

fn read_spec(stream: &mut UnixStream) -> io::Result<LaunchSpec> {
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_SPEC {
        return Err(refused());
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes)?;
    let spec: LaunchSpec = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    validate_identifiers(&spec.operation_id, &spec.script)?;
    if uuid::Uuid::parse_str(&spec.generation).is_err()
        || spec.namespaces.len() != NAMES.len()
        || NAMES.iter().any(|name| {
            !spec.namespaces.get(*name).is_some_and(|value| {
                value
                    .strip_prefix(&format!("{name}:["))
                    .and_then(|v| v.strip_suffix(']'))
                    .is_some_and(|digits| {
                        !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                    })
            })
        })
    {
        return Err(refused());
    }
    Ok(spec)
}

fn pidfd(pid: u32) -> io::Result<OwnedFd> {
    // SAFETY: pidfd_open returns a fresh CLOEXEC descriptor or -1.
    let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0_u32) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw as i32) })
}

fn duplicate(source: BorrowedFd<'_>, minimum: i32) -> io::Result<OwnedFd> {
    let raw = unsafe { libc::fcntl(source.as_raw_fd(), libc::F_DUPFD_CLOEXEC, minimum) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

fn alive(fd: BorrowedFd<'_>) -> io::Result<bool> {
    let mut poll = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let result = unsafe { libc::poll(&mut poll, 1, 0) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(result == 0)
}

fn kill_pidfd(fd: BorrowedFd<'_>) {
    unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0_u32,
        );
    }
}

fn pipe() -> io::Result<(File, File)> {
    let mut fds = [-1; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) })
}

fn read_byte(fd: i32, timeout: Duration) -> io::Result<Option<u8>> {
    let until = Instant::now() + timeout;
    loop {
        let remaining = until.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(refused());
        }
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe {
            libc::poll(
                &mut poll,
                1,
                remaining.as_millis().min(i32::MAX as u128) as i32,
            )
        };
        if ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if ready <= 0 {
            return Err(refused());
        }
        let mut byte = 0_u8;
        let count = unsafe { libc::read(fd, (&mut byte as *mut u8).cast(), 1) };
        if count == 1 {
            return Ok(Some(byte));
        }
        if count == 0 {
            return Ok(None);
        }
        if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(io::Error::last_os_error());
        }
    }
}

/// Internal dispatch only. Root supervisor owns all four inherited descriptors;
/// user-invoked helpers with arbitrary arguments or identity are refused.
pub(crate) fn helper_main() -> io::Result<()> {
    if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0 {
        return Err(refused());
    }
    validate_bootstrap()?;
    // SAFETY: fixed descriptor contract from spawn; ownership is taken once.
    let (init, root, mut control, supervisor) = unsafe {
        (
            OwnedFd::from_raw_fd(3),
            File::from_raw_fd(4),
            UnixStream::from_raw_fd(5),
            OwnedFd::from_raw_fd(6),
        )
    };
    control.set_read_timeout(Some(SETUP))?;
    control.set_write_timeout(Some(SETUP))?;
    let spec = read_spec(&mut control)?;
    let filter = cognia_exec_sandbox::seccomp::build_desktop_filter().map_err(|_| refused())?;
    let last_capability = fs::read_to_string("/proc/sys/kernel/cap_last_cap")?
        .trim()
        .parse::<u32>()
        .map_err(|_| refused())?;
    if last_capability > 63
        || !alive(init.as_fd())?
        || !alive(supervisor.as_fd())?
        || fs::read_dir("/proc/self/task")?.count() != 1
    {
        return Err(refused());
    }
    // Clear groups before entering the unprivileged user namespace, whose
    // setgroups policy may be permanently deny. No project path is touched.
    if unsafe { libc::setgroups(0, std::ptr::null()) } != 0
        || unsafe { libc::setns(init.as_raw_fd(), NAMESPACE_MASK) } != 0
        || unsafe { libc::fchdir(root.as_raw_fd()) } != 0
        || unsafe { libc::chroot(c".".as_ptr()) } != 0
        || unsafe { libc::chdir(c"/".as_ptr()) } != 0
    {
        return Err(refused());
    }
    drop(root);
    drop(init);
    restrict_identity(last_capability)?;
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0
        || !alive(supervisor.as_fd())?
    {
        return Err(refused());
    }
    drop(supervisor);
    let program = libc::sock_fprog {
        len: filter.len().try_into().map_err(|_| refused())?,
        filter: filter.as_ptr().cast_mut().cast(),
    };
    // Mandatory: namespace setup is finished, and every later fork inherits it.
    if unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) } != 0 {
        return Err(refused());
    }
    let parent = pidfd(std::process::id())?;
    let (ready_read, ready_write) = pipe()?;
    let (gate_read, gate_write) = pipe()?;
    let (exec_read, exec_write) = pipe()?;
    // This single-threaded immutable helper MUST fork after PID setns: setns
    // changes only its future children's PID namespace, not its own.
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }
    if child == 0 {
        let result = child_exec(
            &spec,
            parent.as_fd(),
            ready_write.as_raw_fd(),
            gate_read.as_raw_fd(),
            exec_write.as_raw_fd(),
        );
        let code = result
            .err()
            .and_then(|error| error.raw_os_error())
            .unwrap_or(libc::EPERM) as u32;
        unsafe {
            libc::write(
                exec_write.as_raw_fd(),
                code.to_be_bytes().as_ptr().cast(),
                4,
            );
            libc::_exit(125);
        }
    }
    drop(parent);
    drop(ready_write);
    drop(gate_read);
    drop(exec_write);
    let mut completed_status = None;
    let finish = (|| {
        if read_byte(ready_read.as_raw_fd(), SETUP)? != Some(b'R') {
            return Err(refused());
        }
        // Wait for the immutable child to close its ready descriptor before
        // the supervisor inspects the exact remaining descriptor set.
        if read_byte(ready_read.as_raw_fd(), SETUP)?.is_some() {
            return Err(refused());
        }
        control.write_all(&(child as u32).to_be_bytes())?;
        let mut allow = [0_u8; 1];
        control.read_exact(&mut allow)?;
        if allow != *b"G" {
            return Err(refused());
        }
        let mut gate_write = gate_write;
        gate_write.write_all(b"G")?;
        drop(gate_write);
        if read_byte(exec_read.as_raw_fd(), SETUP)?.is_some() {
            return Err(refused());
        }
        // A killed pre-exec child also closes its error pipe. Do not label that
        // EOF as successful exec. An already exited zero-status child can only
        // come from npm: the immutable pre-exec branch exits 125 on every error.
        let mut status = 0;
        let ended = unsafe { libc::waitpid(child, &mut status, libc::WNOHANG) };
        if ended < 0 {
            return Err(io::Error::last_os_error());
        }
        if ended == child {
            completed_status = Some(status);
            if !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != 0 {
                return Err(refused());
            }
        }
        control.write_all(b"E")?;
        Ok(())
    })();
    if finish.is_err() && completed_status.is_none() {
        unsafe {
            libc::kill(child, libc::SIGKILL);
        }
    }
    drop(control);
    let mut status = completed_status.unwrap_or(0);
    while completed_status.is_none() {
        let result = unsafe { libc::waitpid(child, &mut status, 0) };
        if result >= 0 {
            break;
        }
        if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(io::Error::last_os_error());
        }
    }
    finish?;
    if !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != 0 {
        return Err(refused());
    }
    Ok(())
}

fn validate_bootstrap() -> io::Result<()> {
    for fd in 3..=6 {
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
            return Err(refused());
        }
    }
    let mut peer = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            5,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            peer.as_mut_ptr().cast(),
            &mut length,
        )
    } != 0
    {
        return Err(refused());
    }
    if length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(refused());
    }
    let peer = unsafe { peer.assume_init() };
    if peer.uid != 0 || peer.pid != unsafe { libc::getppid() } {
        return Err(refused());
    }
    for (option, expected) in [
        (libc::SO_DOMAIN, libc::AF_UNIX),
        (libc::SO_TYPE, libc::SOCK_STREAM),
        (libc::SO_ACCEPTCONN, 0),
    ] {
        let mut value = 0_i32;
        let mut length = std::mem::size_of_val(&value) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                5,
                libc::SOL_SOCKET,
                option,
                (&mut value as *mut i32).cast(),
                &mut length,
            )
        } != 0
            || value != expected
        {
            return Err(refused());
        }
    }
    Ok(())
}

fn restrict_identity(last_capability: u32) -> io::Result<()> {
    for capability in 0..=last_capability {
        if unsafe { libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0) } != 0 {
            return Err(refused());
        }
    }
    #[repr(C)]
    struct Header {
        version: u32,
        pid: i32,
    }
    let header = Header {
        version: 0x20080522,
        pid: 0,
    };
    let empty = [0_u32; 6];
    if unsafe {
        libc::prctl(
            libc::PR_CAP_AMBIENT,
            libc::PR_CAP_AMBIENT_CLEAR_ALL,
            0,
            0,
            0,
        )
    } != 0
        || unsafe { libc::setgid(1000) } != 0
        || unsafe { libc::setuid(1000) } != 0
        || unsafe { libc::syscall(libc::SYS_capset, &header as *const Header, empty.as_ptr()) } != 0
        || unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0
        || unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0
        || unsafe { libc::getgroups(0, std::ptr::null_mut()) } != 0
    {
        return Err(refused());
    }
    Ok(())
}

fn child_exec(
    spec: &LaunchSpec,
    parent: BorrowedFd<'_>,
    ready: i32,
    gate: i32,
    error: i32,
) -> io::Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0
        || !alive(parent)?
    {
        return Err(refused());
    }
    // Close every unrelated inherited descriptor, including the root-facing
    // control socket, before reporting readiness. Remaining pipes are local
    // bounded admission/error streams; all close before/on project exec.
    close_except([ready, gate, error])?;
    for name in NAMES {
        if fs::read_link(format!("/proc/self/ns/{name}"))?.to_str()
            != spec.namespaces.get(name).map(String::as_str)
        {
            return Err(refused());
        }
    }
    if !boundary::restricted_status(&fs::read_to_string("/proc/self/status")?) {
        return Err(refused());
    }
    if unsafe { libc::write(ready, b"R".as_ptr().cast(), 1) } != 1 {
        return Err(refused());
    }
    unsafe {
        libc::close(ready);
    }
    if read_byte(gate, SETUP)? != Some(b'G') {
        return Err(refused());
    }
    unsafe {
        libc::close(gate);
    }
    let mut command = Command::new("/usr/bin/npm");
    command
        .args(["--ignore-scripts", "run", &spec.script])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", "/home/cua")
        .env("USER", "cua")
        .env("LOGNAME", "cua")
        .env("LANG", "C.UTF-8")
        .env("DISPLAY", ":99")
        .env("XDG_RUNTIME_DIR", "/run/user/1000")
        .env("DO_NOT_TRACK", "1")
        .env("NPM_CONFIG_UPDATE_NOTIFIER", "false")
        .current_dir(format!("/workspace/{}/workspace", spec.operation_id));
    Err(command.exec())
}

fn close_except(mut keep: [i32; 3]) -> io::Result<()> {
    if keep.iter().any(|fd| *fd < 3) {
        return Err(refused());
    }
    keep.sort_unstable();
    let mut first = 3_u32;
    for fd in keep {
        if first < fd as u32
            && unsafe { libc::syscall(libc::SYS_close_range, first, fd as u32 - 1, 0_u32) } != 0
        {
            return Err(refused());
        }
        first = fd as u32 + 1;
    }
    if unsafe { libc::syscall(libc::SYS_close_range, first, u32::MAX, 0_u32) } != 0 {
        return Err(refused());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const OP: &str = "12345678-1234-1234-1234-123456789abc";
    #[test]
    fn executable_cwd_and_arguments_cannot_be_selected_by_project_metadata() {
        assert!(validate_identifiers(OP, "test:gui").is_ok());
        for script in ["", "--prefix=/", "a;curl", "../x", "x y", "$(curl)"] {
            assert!(validate_identifiers(OP, script).is_err());
        }
        for operation in ["../x", "/tmp/x", "12345678-1234-1234-1234-123456789ABC"] {
            assert!(validate_identifiers(operation, "dev").is_err());
        }
    }
    #[test]
    fn bounded_control_rejects_oversized_request_before_allocation() {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        writer
            .write_all(&((MAX_SPEC + 1) as u32).to_be_bytes())
            .unwrap();
        assert!(read_spec(&mut reader).is_err());
    }
    #[test]
    fn control_spec_requires_every_exact_namespace_and_no_unknown_fields() {
        let mut spec = LaunchSpec {
            generation: OP.into(),
            operation_id: OP.into(),
            script: "dev".into(),
            namespaces: NAMES
                .into_iter()
                .map(|name| (name.into(), format!("{name}:[123]")))
                .collect(),
        };
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        write_spec(&mut writer, &spec).unwrap();
        assert!(read_spec(&mut reader).is_ok());
        spec.namespaces.insert("net".into(), "user:[123]".into());
        write_spec(&mut writer, &spec).unwrap();
        assert!(read_spec(&mut reader).is_err());
        spec.namespaces.remove("net");
        write_spec(&mut writer, &spec).unwrap();
        assert!(read_spec(&mut reader).is_err());
        let mut value = serde_json::to_value(&spec).unwrap();
        value["executable"] = "/bin/sh".into();
        let bytes = serde_json::to_vec(&value).unwrap();
        writer
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        writer.write_all(&bytes).unwrap();
        assert!(read_spec(&mut reader).is_err());
    }
    #[test]
    fn namespace_join_mask_covers_the_complete_desktop_boundary() {
        for flag in [
            libc::CLONE_NEWUSER,
            libc::CLONE_NEWNS,
            libc::CLONE_NEWNET,
            libc::CLONE_NEWPID,
            libc::CLONE_NEWIPC,
            libc::CLONE_NEWUTS,
        ] {
            assert_ne!(NAMESPACE_MASK & flag, 0);
        }
    }
    #[test]
    fn admission_descriptor_proof_refuses_sockets_paths_and_malformed_pipes() {
        assert!(is_pipe_identity("pipe:[123]"));
        for value in [
            "socket:[123]",
            "/workspace/source",
            "pipe:[]",
            "pipe:[12x]",
            "pipe:[123]/other",
        ] {
            assert!(!is_pipe_identity(value));
        }
    }
    #[test]
    fn gate_is_bounded_and_eof_cannot_authorize_execution() {
        let (read, mut write) = pipe().unwrap();
        write.write_all(b"X").unwrap();
        assert_eq!(
            read_byte(read.as_raw_fd(), Duration::from_secs(1)).unwrap(),
            Some(b'X')
        );
        drop(write);
        assert_eq!(
            read_byte(read.as_raw_fd(), Duration::from_secs(1)).unwrap(),
            None
        );
    }
}
