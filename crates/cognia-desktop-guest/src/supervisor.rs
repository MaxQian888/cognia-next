//! Root-only fixed bootstrap. The workload never receives supervisor authority.

use crate::{boundary, control, relay};
use cognia_exec_sandbox::desktop::DesktopLaunch;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const RUN: &str = "/run/cognia-desktop";
const DATA: &str = "/var/lib/cognia-desktop";
const HOME: &str = "/var/lib/cognia-desktop/home";
const WORKSPACE: &str = "/var/lib/cognia-desktop/workspace";
const STATE: &str = "/run/cognia-desktop/state.json";
static STOP: AtomicBool = AtomicBool::new(false);
static STAGE: AtomicU8 = AtomicU8::new(0);

pub(crate) fn failure_stage() -> &'static str {
    match STAGE.load(Ordering::Relaxed) {
        1 => "credentials",
        2 => "protected_state",
        3 => "listener",
        4 => "isolation_profile",
        5 => "workload_spawn",
        6 => "namespace_report",
        7 => "boundary_validation",
        8 => "boundary_persistence",
        9 => "relay_spawn",
        10 => "monitor",
        11 => "workload_exit",
        12 => "relay_exit",
        13 => "boundary_changed",
        14 => "handoff_control",
        _ => "supervisor_identity",
    }
}

fn phase(stage: u8) {
    STAGE.store(stage, Ordering::Relaxed);
}

extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
fn refused() -> io::Error {
    io::Error::other("desktop supervisor refused")
}

fn protected_directory(path: &str, mode: u32, uid: u32, gid: u32) -> io::Result<()> {
    match fs::DirBuilder::new().mode(mode).create(path) {
        Ok(()) => {
            let name = std::ffi::CString::new(path).map_err(|_| refused())?;
            if unsafe { libc::chown(name.as_ptr(), uid, gid) } != 0 {
                return Err(io::Error::last_os_error());
            }
            fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.uid() != uid || meta.gid() != gid || meta.mode() & 0o777 != mode {
        return Err(refused());
    }
    Ok(())
}

fn lock() -> io::Result<File> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(format!("{RUN}/supervisor.lock"))?;
    let meta = lock.metadata()?;
    if !meta.is_file() || meta.uid() != 0 || meta.nlink() != 1 || meta.mode() & 0o777 != 0o600 {
        return Err(refused());
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(refused());
    }
    Ok(lock)
}

struct Processes {
    workload: Option<Child>,
    relay: Option<Child>,
    owned_socket: bool,
}
impl Drop for Processes {
    fn drop(&mut self) {
        // Close external ingress first. Killing bwrap triggers its namespace
        // init/death guard, independently terminating the workload descendants.
        for process in [&mut self.relay, &mut self.workload].into_iter().flatten() {
            let _ = process.kill();
            let _ = process.wait();
        }
        if self.owned_socket {
            let _ = fs::remove_file(STATE);
            let _ = fs::remove_file(relay::SOCKET);
        }
    }
}

pub(crate) fn init_pid(input: &mut UnixStream, child: &mut Child) -> io::Result<u32> {
    let deadline = Instant::now() + Duration::from_secs(10);
    input.set_read_timeout(Some(Duration::from_millis(200)))?;
    let mut bytes = Vec::new();
    while Instant::now() < deadline && !STOP.load(Ordering::Relaxed) {
        if child.try_wait()?.is_some() {
            return Err(refused());
        }
        let mut buffer = [0_u8; 1024];
        match input.read(&mut buffer) {
            Ok(0) => return Err(refused()),
            Ok(n) => bytes.extend_from_slice(&buffer[..n]),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            Err(error) => return Err(error),
        }
        if bytes.len() > 8192 {
            return Err(refused());
        }
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) => {
                return value
                    .get("child-pid")
                    .and_then(|pid| pid.as_u64())
                    .filter(|pid| *pid > 1 && *pid <= i32::MAX as u64)
                    .map(|pid| pid as u32)
                    .ok_or_else(refused)
            }
            Err(error) if error.is_eof() => (),
            Err(_) => return Err(refused()),
        }
    }
    Err(refused())
}

fn store_boundary(value: &boundary::Boundary) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(STATE)?;
    let bytes = serde_json::to_vec(value).map_err(|_| refused())?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    File::open(RUN)?.sync_all()
}

unsafe fn relay_identity(parent: libc::pid_t, listener: i32) -> io::Result<()> {
    if listener != 3 && libc::dup2(listener, 3) == -1 {
        return Err(io::Error::last_os_error());
    }
    if libc::fcntl(3, libc::F_SETFD, 0) == -1 {
        return Err(io::Error::last_os_error());
    }
    // Preserve std::process's exec-error pipe until exec; CLOEXEC closes all
    // unrelated descriptors without making a failed pre_exec look successful.
    if libc::syscall(libc::SYS_close_range, 4_u32, u32::MAX, 4_u32) != 0 {
        return Err(io::Error::last_os_error());
    }
    for capability in 0..64 {
        if libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0) != 0
            && io::Error::last_os_error().raw_os_error() != Some(libc::EINVAL)
        {
            return Err(io::Error::last_os_error());
        }
    }
    if libc::prctl(
        libc::PR_CAP_AMBIENT,
        libc::PR_CAP_AMBIENT_CLEAR_ALL,
        0,
        0,
        0,
    ) != 0
        || libc::setgroups(0, std::ptr::null()) != 0
        || libc::setgid(65534) != 0
        || libc::setuid(65534) != 0
        || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
        || libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) != 0
        || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0
        || libc::getppid() != parent
    {
        return Err(io::Error::from_raw_os_error(libc::EPERM));
    }
    #[repr(C)]
    struct CapHeader {
        version: u32,
        pid: i32,
    }
    let header = CapHeader {
        version: 0x2008_0522,
        pid: 0,
    };
    let empty_sets = [0_u32; 6];
    if libc::syscall(
        libc::SYS_capset,
        &header as *const CapHeader,
        empty_sets.as_ptr(),
    ) != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn run() -> io::Result<()> {
    if unsafe { libc::geteuid() } != 0
        || unsafe { libc::getuid() } != 0
        || unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0
    {
        return Err(refused());
    }
    phase(1);
    let token = std::env::var("COGNIA_CUA_AUTH_TOKEN").map_err(|_| refused())?;
    std::env::remove_var("COGNIA_CUA_AUTH_TOKEN");
    if token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(refused());
    }
    unsafe {
        libc::umask(0o077);
        libc::signal(libc::SIGTERM, stop as libc::sighandler_t);
        libc::signal(libc::SIGINT, stop as libc::sighandler_t);
    }
    phase(2);
    protected_directory(RUN, 0o710, 0, 65534)?;
    let _lock = lock()?;
    if fs::symlink_metadata(STATE).is_ok() || fs::symlink_metadata(relay::SOCKET).is_ok() {
        return Err(refused());
    }
    protected_directory(DATA, 0o711, 0, 0)?;
    protected_directory(HOME, 0o700, 1000, 1000)?;
    protected_directory(WORKSPACE, 0o711, 0, 0)?;
    phase(3);
    let listener = UnixListener::bind(relay::SOCKET)?;
    let mut processes = Processes {
        workload: None,
        relay: None,
        owned_socket: true,
    };
    let name = std::ffi::CString::new(relay::SOCKET).map_err(|_| refused())?;
    if unsafe { libc::chown(name.as_ptr(), 0, 65534) } != 0 {
        return Err(io::Error::last_os_error());
    }
    fs::set_permissions(relay::SOCKET, fs::Permissions::from_mode(0o660))?;
    let (mut info_read, info_write) = UnixStream::pair()?;
    phase(4);
    let launch = DesktopLaunch::prepare(
        Path::new(HOME),
        Path::new(WORKSPACE),
        listener.as_fd(),
        info_write.as_fd(),
    )
    .map_err(|_| refused())?;
    let arguments = vec![
        "-I".into(),
        "/opt/cognia-desktop/startup.py".into(),
        "--managed".into(),
    ];
    let mut command = launch
        .command("/usr/local/bin/python3", &arguments)
        .map_err(|_| refused())?;
    // This one narrow credential is consumed by nondumpable startup before any
    // browser/terminal child. Never serialize it into argv or boundary state.
    command
        .env("COGNIA_CUA_AUTH_TOKEN", &token)
        .stdin(Stdio::null());
    phase(5);
    processes.workload = Some(command.spawn()?);
    drop(command);
    drop(token);
    drop(info_write);
    let child = processes.workload.as_mut().ok_or_else(refused)?;
    phase(6);
    let init = init_pid(&mut info_read, child)?;
    drop(info_read);
    let generation = uuid::Uuid::new_v4().to_string();
    let deadline = Instant::now() + Duration::from_secs(20);
    phase(7);
    let boundary = loop {
        if child.try_wait()?.is_some() || STOP.load(Ordering::Relaxed) || Instant::now() >= deadline
        {
            return Err(refused());
        }
        if let Ok(observed) = boundary::observe(child.id(), init, &generation) {
            break observed;
        }
        thread::sleep(Duration::from_millis(50));
    };
    phase(8);
    store_boundary(&boundary)?;
    // No external ingress is bound until the actual workload identity and
    // kernel boundary, not merely bwrap's early info event, have been verified.
    phase(9);
    let tcp = TcpListener::bind(("0.0.0.0", 8000))?;
    let fd = tcp.as_raw_fd();
    let parent = unsafe { libc::getpid() };
    let mut relay = Command::new("/usr/local/bin/cognia-desktop-guest");
    relay
        .arg("relay")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        relay.pre_exec(move || relay_identity(parent, fd));
    }
    processes.relay = Some(relay.spawn()?);
    drop(tcp);
    drop(listener);
    phase(14);
    let mut control = control::Control::bind()?;
    phase(10);
    loop {
        if STOP.load(Ordering::Relaxed) {
            return Ok(());
        }
        if processes
            .workload
            .as_mut()
            .ok_or_else(refused)?
            .try_wait()?
            .is_some()
        {
            phase(11);
            return Err(refused());
        }
        if processes
            .relay
            .as_mut()
            .ok_or_else(refused)?
            .try_wait()?
            .is_some()
        {
            phase(12);
            return Err(refused());
        }
        if !boundary::still_current(&boundary) {
            phase(13);
            return Err(refused());
        }
        phase(14);
        control.tick(&boundary)?;
        phase(10);
        thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_and_workspace_paths_are_disjoint_fixed_roots() {
        assert!(!Path::new(STATE).starts_with(HOME));
        assert!(!Path::new(relay::SOCKET).starts_with(WORKSPACE));
        assert!(Path::new(HOME).starts_with(DATA));
    }
}
