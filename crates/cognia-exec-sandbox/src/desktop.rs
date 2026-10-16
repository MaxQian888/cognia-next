//! ADR-0228 mandatory desktop boundary. This intentionally does not accept the
//! generic launcher's optional network or arbitrary readable-root policies.
//! The guest supervisor owns the fixed roots before any workload starts.

use std::fs;
use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

pub const DESKTOP_UID: u32 = 1000;
pub const DESKTOP_GID: u32 = 1000;
pub const LISTENER_FD: i32 = 3;
pub const FILTER_FD: i32 = 4;
pub const INFO_FD: i32 = 5;
pub const HOME_SOURCE: &str = "/var/lib/cognia-desktop/home";
pub const WORKSPACE_SOURCE: &str = "/var/lib/cognia-desktop/workspace";

/// One-use launcher. Required filter construction and source validation happen
/// before a child exists; there is no namespace-only fallback on failure.
pub struct DesktopLaunch {
    listener: OwnedFd,
    filter: OwnedFd,
    info: OwnedFd,
    last_capability: u32,
}

impl DesktopLaunch {
    /// `listener` must be the fixed AF_UNIX listening socket, not a connected
    /// stream or an outside-network socket. `info` is a supervisor-owned pipe,
    /// connected AF_UNIX stream or file; bwrap consumes it before workload exec.
    pub fn prepare(
        home: &Path,
        workspace: &Path,
        listener: BorrowedFd<'_>,
        info: BorrowedFd<'_>,
    ) -> io::Result<Self> {
        validate_source(home, HOME_SOURCE)?;
        validate_source(workspace, WORKSPACE_SOURCE)?;
        validate_listener(listener)?;
        validate_info(info)?;
        let last_capability: u32 = fs::read_to_string("/proc/sys/kernel/cap_last_cap")?
            .trim()
            .parse()
            .map_err(|_| invalid("invalid kernel capability ceiling"))?;
        if last_capability > 63 {
            return Err(invalid("unsupported kernel capability ceiling"));
        }
        let filter = crate::seccomp::park_desktop_filter()?;
        Ok(Self {
            listener: duplicate_high(listener)?,
            filter: duplicate_high(filter.as_fd())?,
            info: duplicate_high(info)?,
            last_capability,
        })
    }

    /// Builds a std::process command for the trusted supervisor. It consumes
    /// the filter stream so a second launch cannot accidentally read EOF.
    /// The caller may explicitly add the session auth token, and pipe output;
    /// environment and stdio otherwise start empty/null. No source command is
    /// executed until bwrap has installed the mandatory filter.
    /// Keep the original listener/report handles alive through `spawn`, then
    /// drop this Command so its duplicated report writer cannot delay EOF.
    pub fn command(self, program: &str, args: &[String]) -> io::Result<Command> {
        if !Path::new(program).is_absolute() || program.as_bytes().contains(&0) {
            return Err(invalid("desktop executable must be an absolute path"));
        }
        let mut command = Command::new("/usr/bin/bwrap");
        // Fill any vacant fixed slots before std creates its spawn-error pipe.
        // Original borrowed handles must remain live through spawn as documented
        // above; the supervisor already needs both for transport/readiness.
        let reservations = [
            duplicate_at_least(self.listener.as_fd(), 3)?,
            duplicate_at_least(self.listener.as_fd(), 3)?,
            duplicate_at_least(self.listener.as_fd(), 3)?,
        ];
        command
            .args(profile_args())
            .arg("--")
            .arg(program)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/home/cua")
            .env("USER", "cua")
            .env("LOGNAME", "cua")
            .env("LANG", "C.UTF-8")
            .env("DISPLAY", ":99")
            .env("CUA_BACKEND", "native")
            .env("CUA_TELEMETRY", "0")
            .env("DO_NOT_TRACK", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTHONUNBUFFERED", "1")
            .env("XDG_RUNTIME_DIR", "/run/user/1000")
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: getpid is read-only; captured before the fork so the child
        // can detect a supervisor death racing installation of PDEATHSIG.
        let parent = unsafe { libc::getpid() };
        // SAFETY: closure performs only raw syscalls and reads captured owned
        // descriptors. It allocates nothing and takes no locks after fork.
        unsafe {
            command.pre_exec(move || {
                // Capture reservations as owned values, retaining their slots
                // in the parent until this command has been spawned/dropped.
                let _reserved = &reservations;
                for (source, target) in [
                    (self.listener.as_raw_fd(), LISTENER_FD),
                    (self.filter.as_raw_fd(), FILTER_FD),
                    (self.info.as_raw_fd(), INFO_FD),
                ] {
                    if libc::dup2(source, target) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                // CLOEXEC, rather than close, preserves std's spawn-error
                // channel until exec. No unrelated FD reaches bwrap. Missing
                // close_range support is an explicit launch failure.
                if libc::syscall(libc::SYS_close_range, 6_u32, u32::MAX, 4_u32) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::setgroups(0, std::ptr::null()) != 0 {
                    return Err(io::Error::last_os_error());
                }
                for capability in 0..=self.last_capability {
                    if libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0) != 0 {
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
                    || libc::setgid(DESKTOP_GID) != 0
                    || libc::setuid(DESKTOP_UID) != 0
                {
                    return Err(io::Error::last_os_error());
                }
                let header = CapabilityHeader {
                    version: 0x20080522, // _LINUX_CAPABILITY_VERSION_3
                    pid: 0,
                };
                let data = [CapabilityData::default(); 2];
                if libc::syscall(libc::SYS_capset, &header, data.as_ptr()) != 0
                    || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                    || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0
                {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(io::Error::from_raw_os_error(libc::ECHILD));
                }
                Ok(())
            });
        }
        Ok(command)
    }
}

#[repr(C)]
struct CapabilityHeader {
    version: u32,
    pid: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

fn profile_args() -> Vec<String> {
    let mut args: Vec<String> = [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--uid",
        "1000",
        "--gid",
        "1000",
        "--hostname",
        "cognia-desktop",
        "--seccomp",
        "4",
        "--info-fd",
        "5",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    // These are image runtime roots, never the provider's mutable /run,
    // /root, /var or whole /etc. Optional architecture paths may be absent.
    for path in ["/usr", "/bin", "/sbin", "/lib", "/lib64"] {
        args.extend(["--ro-bind-try".into(), path.into(), path.into()]);
    }
    args.extend([
        "--ro-bind".into(),
        "/opt/cognia-desktop".into(),
        "/opt/cognia-desktop".into(),
    ]);
    for path in [
        "/etc/passwd",
        "/etc/group",
        "/etc/nsswitch.conf",
        "/etc/hosts",
        "/etc/ld.so.cache",
        "/etc/localtime",
        "/etc/fonts",
        "/etc/X11",
        "/etc/xdg",
        "/etc/dbus-1",
        "/etc/chromium.d",
        "/etc/alternatives",
        "/etc/ssl/certs",
        "/etc/mime.types",
    ] {
        args.extend(["--ro-bind-try".into(), path.into(), path.into()]);
    }
    for (flag, path) in [
        ("--proc", "/proc"),
        ("--dev", "/dev"),
        ("--tmpfs", "/tmp"),
        ("--tmpfs", "/run"),
        ("--dir", "/run/user"),
    ] {
        args.extend([flag.into(), path.into()]);
    }
    args.extend([
        "--perms".into(),
        "1777".into(),
        "--dir".into(),
        "/tmp/.X11-unix".into(),
        "--perms".into(),
        "0700".into(),
        "--dir".into(),
        "/run/user/1000".into(),
    ]);
    args.extend([
        "--bind".into(),
        HOME_SOURCE.into(),
        "/home/cua".into(),
        "--bind".into(),
        WORKSPACE_SOURCE.into(),
        "/workspace".into(),
        "--chdir".into(),
        "/workspace".into(),
    ]);
    args
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn validate_source(path: &Path, expected: &str) -> io::Result<()> {
    if path != Path::new(expected) || fs::canonicalize(path)? != path {
        return Err(invalid(
            "desktop writable root must match the fixed canonical source",
        ));
    }
    let leaf = fs::symlink_metadata(path)?;
    if !leaf.is_dir() || leaf.uid() != DESKTOP_UID || leaf.gid() != DESKTOP_GID {
        return Err(invalid(
            "desktop writable root must be a cua-owned directory",
        ));
    }
    // A workload may mutate files inside its root, but cannot replace the
    // source directory while bwrap resolves it, nor any ancestor of it.
    for ancestor in path.ancestors().skip(1) {
        let metadata = fs::symlink_metadata(ancestor)?;
        if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(invalid(
                "desktop source ancestors must be root-owned and immutable to cua",
            ));
        }
    }
    Ok(())
}

fn duplicate_high(fd: BorrowedFd<'_>) -> io::Result<OwnedFd> {
    duplicate_at_least(fd, 6)
}

fn duplicate_at_least(fd: BorrowedFd<'_>, minimum: i32) -> io::Result<OwnedFd> {
    // SAFETY: duplicates a valid borrowed descriptor without taking ownership
    // of it. High sources avoid dup2 collisions; low reservations fill holes.
    let raw = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, minimum) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: F_DUPFD_CLOEXEC returned a fresh descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

fn validate_listener(fd: BorrowedFd<'_>) -> io::Result<()> {
    validate_unix_socket(fd, true)
}

fn validate_unix_socket(fd: BorrowedFd<'_>, listening: bool) -> io::Result<()> {
    for (option, expected) in [
        (libc::SO_DOMAIN, libc::AF_UNIX),
        (libc::SO_TYPE, libc::SOCK_STREAM),
        (libc::SO_ACCEPTCONN, i32::from(listening)),
    ] {
        let mut value: libc::c_int = 0;
        let mut len = std::mem::size_of_val(&value) as libc::socklen_t;
        // SAFETY: value/len point to properly sized writable stack values.
        if unsafe {
            libc::getsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                option,
                (&mut value as *mut libc::c_int).cast(),
                &mut len,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        if value != expected {
            return Err(invalid("unexpected desktop AF_UNIX socket kind"));
        }
    }
    if !listening {
        let mut peer = std::mem::MaybeUninit::<libc::sockaddr_un>::uninit();
        let mut len = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
        // SAFETY: valid writable output buffer and length; success confirms
        // the report stream is connected without reading peer data.
        if unsafe { libc::getpeername(fd.as_raw_fd(), peer.as_mut_ptr().cast(), &mut len) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn validate_info(fd: BorrowedFd<'_>) -> io::Result<()> {
    // SAFETY: fstat fills the valid uninitialized output on success.
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstat initialized the complete structure.
    let kind = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
    if kind == libc::S_IFSOCK {
        return validate_unix_socket(fd, false);
    }
    if kind != libc::S_IFREG && kind != libc::S_IFIFO {
        return Err(invalid(
            "desktop namespace report requires a local file or stream",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_has_no_outside_network_or_control_filesystem() {
        let args = profile_args();
        for flag in [
            "--unshare-user",
            "--unshare-net",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--die-with-parent",
        ] {
            assert!(args.iter().any(|arg| arg == flag), "missing {flag}");
        }
        assert!(!args.iter().any(|arg| arg == "--share-net"));
        for triple in args.windows(3) {
            if matches!(triple[0].as_str(), "--ro-bind" | "--ro-bind-try" | "--bind") {
                assert!(
                    !["/", "/etc", "/run", "/proc", "/var", "/root"].contains(&triple[1].as_str())
                );
            }
        }
        assert!(args.windows(2).any(|pair| pair == ["--seccomp", "4"]));
        assert!(args.windows(2).any(|pair| pair == ["--info-fd", "5"]));
        // Debian's Chromium launcher sources this image-owned configuration
        // before starting the browser. It must stay read-only and narrow.
        assert!(args
            .windows(3)
            .any(|triple| triple == ["--ro-bind-try", "/etc/chromium.d", "/etc/chromium.d"]));
    }

    #[test]
    fn network_socket_and_connected_unix_socket_are_not_ingress() {
        let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(validate_listener(tcp.as_fd()).is_err());
        assert!(validate_info(tcp.as_fd()).is_err());
        let (unix, _) = std::os::unix::net::UnixStream::pair().unwrap();
        assert!(validate_listener(unix.as_fd()).is_err());
        validate_info(unix.as_fd()).unwrap();
    }

    #[test]
    fn unix_listener_and_report_file_are_accepted_and_duplicates_are_private() {
        let dir = tempfile::tempdir().unwrap();
        let listener = std::os::unix::net::UnixListener::bind(dir.path().join("gui.sock")).unwrap();
        validate_listener(listener.as_fd()).unwrap();
        let file = tempfile::tempfile().unwrap();
        validate_info(file.as_fd()).unwrap();
        let duplicate = duplicate_high(listener.as_fd()).unwrap();
        assert!(duplicate.as_raw_fd() >= 6);
        // SAFETY: read-only descriptor flag query.
        assert_ne!(
            unsafe { libc::fcntl(duplicate.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
    }

    #[test]
    fn arbitrary_writable_roots_are_rejected_before_launch() {
        assert!(validate_source(Path::new("/tmp"), HOME_SOURCE).is_err());
        assert!(validate_source(
            Path::new("/var/lib/cognia-desktop/home/../workspace"),
            WORKSPACE_SOURCE
        )
        .is_err());
    }
}
