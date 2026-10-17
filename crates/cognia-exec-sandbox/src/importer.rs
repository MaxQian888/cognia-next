//! Mandatory one-shot source importer confinement, separate from desktop UID
//! and network/PID/mount/IPC namespaces. Only the fixed image parser may run.

use crate::desktop::{duplicate_at_least, duplicate_high, validate_info};
use std::fs;
use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const IMPORT_UID: u32 = 1001;
pub const IMPORT_GID: u32 = 1001;
pub const IMPORT_ROOT: &str = "/var/lib/cognia-desktop/imports";

pub struct ImportLaunch {
    input: PathBuf,
    output: PathBuf,
    filter: OwnedFd,
    info: OwnedFd,
    last_capability: u32,
}

impl ImportLaunch {
    /// The caller owns the protected operation directories and keeps `info`
    /// open through spawn. The fixed Python parser MUST wait for a single G
    /// byte on stdin before opening /input. The receiver sends G only after
    /// observing this actual Python process's complete kernel boundary.
    pub fn prepare(
        operation: &str,
        input: &Path,
        output: &Path,
        info: BorrowedFd<'_>,
    ) -> io::Result<Self> {
        validate_operation(operation)?;
        let root = Path::new(IMPORT_ROOT).join(operation);
        validate_source(input, &root.join("input"), 0, IMPORT_GID, 0o750)?;
        validate_source(output, &root.join("output"), IMPORT_UID, IMPORT_GID, 0o700)?;
        validate_info(info)?;
        let last_capability = fs::read_to_string("/proc/sys/kernel/cap_last_cap")?
            .trim()
            .parse::<u32>()
            .map_err(|_| refused())?;
        if last_capability > 63 {
            return Err(refused());
        }
        let filter = crate::seccomp::park_desktop_filter()?;
        Ok(Self {
            input: input.into(),
            output: output.into(),
            filter: duplicate_high(filter.as_fd())?,
            info: duplicate_high(info)?,
            last_capability,
        })
    }

    /// Spawn uses a piped admission channel, not source bytes. No GUI socket,
    /// token or outside-network descriptor is passed. Drop Command after spawn
    /// so its duplicate report writer cannot hold the readiness stream open.
    pub fn command(self) -> io::Result<Command> {
        self.command_for(false)
    }

    /// Root-only, fixed negative-control launch. It cannot execute source or
    /// select an executable: both data mounts are replaced by empty tmpfs and
    /// only the immutable wait-only diagnostic runs. Production never calls it.
    pub fn qualification_without_seccomp_command(self) -> io::Result<Command> {
        if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0 {
            return Err(refused());
        }
        self.command_for(true)
    }

    fn command_for(self, negative: bool) -> io::Result<Command> {
        let reservations = [
            duplicate_at_least(self.filter.as_fd(), 3)?,
            duplicate_at_least(self.filter.as_fd(), 3)?,
            duplicate_at_least(self.filter.as_fd(), 3)?,
        ];
        let mut command = Command::new("/usr/bin/bwrap");
        command.args(if negative {
            negative_profile_args()
        } else {
            profile_args(&self.input, &self.output)
        });
        if negative {
            command.args([
                "--",
                "/usr/local/bin/cognia-desktop-guest",
                "qualification-negative-wait",
            ]);
        } else {
            command.args([
                "--",
                "/usr/local/bin/python3",
                "-I",
                "/opt/cognia-desktop/handoff-import.py",
            ]);
        }
        command
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/home/importer")
            .env("USER", "importer")
            .env("LOGNAME", "importer")
            .env("LANG", "C.UTF-8")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTHONUNBUFFERED", "1")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: capture the actual parent before fork.
        let parent = unsafe { libc::getpid() };
        // SAFETY: only async-signal-safe syscalls and captured values are used
        // after fork; filter construction/path validation happen above.
        unsafe {
            command.pre_exec(move || {
                let _reserved = &reservations;
                if libc::syscall(libc::SYS_close_range, 3_u32, u32::MAX, 4_u32) != 0
                    || !negative && libc::dup2(self.filter.as_raw_fd(), 4) < 0
                    || libc::dup2(self.info.as_raw_fd(), 5) < 0
                    || libc::setgroups(0, std::ptr::null()) != 0
                {
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
                    || libc::setgid(IMPORT_GID) != 0
                    || libc::setuid(IMPORT_UID) != 0
                {
                    return Err(io::Error::last_os_error());
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
                let data = [0_u32; 6];
                if libc::syscall(libc::SYS_capset, &header as *const Header, data.as_ptr()) != 0
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

fn refused() -> io::Error {
    io::Error::other("import confinement refused")
}

fn validate_operation(value: &str) -> io::Result<()> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
    {
        return Err(refused());
    }
    Ok(())
}

fn validate_source(path: &Path, expected: &Path, uid: u32, gid: u32, mode: u32) -> io::Result<()> {
    if path != expected || fs::canonicalize(path)? != path {
        return Err(refused());
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.uid() != uid || meta.gid() != gid || meta.mode() & 0o7777 != mode {
        return Err(refused());
    }
    for ancestor in path.ancestors().skip(1) {
        let meta = fs::symlink_metadata(ancestor)?;
        if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
            return Err(refused());
        }
    }
    Ok(())
}

fn negative_profile_args() -> Vec<String> {
    // Start from the production profile and change only the mandatory filter
    // and source mounts. The ignored paths never appear in rendered arguments.
    profile_args_for(Path::new("/input"), Path::new("/output"), true)
}
fn profile_args(input: &Path, output: &Path) -> Vec<String> {
    profile_args_for(input, output, false)
}
fn profile_args_for(input: &Path, output: &Path, negative: bool) -> Vec<String> {
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
        "1001",
        "--gid",
        "1001",
        "--hostname",
        "cognia-import",
        "--info-fd",
        "5",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if !negative {
        args.extend(["--seccomp".into(), "4".into()]);
    }
    for path in ["/usr", "/bin", "/lib", "/lib64"] {
        args.extend(["--ro-bind-try".into(), path.into(), path.into()]);
    }
    // Map only the immutable importer, not the desktop bootstrap or its sockets.
    args.extend([
        "--ro-bind".into(),
        "/opt/cognia-desktop/handoff-import.py".into(),
        "/opt/cognia-desktop/handoff-import.py".into(),
    ]);
    for path in [
        "/etc/passwd",
        "/etc/group",
        "/etc/nsswitch.conf",
        "/etc/ld.so.cache",
        "/etc/localtime",
    ] {
        args.extend(["--ro-bind-try".into(), path.into(), path.into()]);
    }
    for (flag, path) in [
        ("--proc", "/proc"),
        ("--dev", "/dev"),
        ("--tmpfs", "/tmp"),
        ("--tmpfs", "/run"),
        ("--tmpfs", "/home"),
        ("--dir", "/home/importer"),
    ] {
        args.extend([flag.into(), path.into()]);
    }
    if negative {
        args.extend([
            "--tmpfs".into(),
            "/input".into(),
            "--tmpfs".into(),
            "/output".into(),
        ]);
    } else {
        args.extend([
            "--ro-bind".into(),
            input.to_string_lossy().into_owned(),
            "/input".into(),
            "--bind".into(),
            output.to_string_lossy().into_owned(),
            "/output".into(),
        ]);
    }
    args.extend(["--chdir".into(), "/output".into()]);
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_profile_omits_only_filter_and_replaces_source_with_empty_mounts() {
        let production = profile_args(Path::new("/private/input"), Path::new("/private/output"));
        let negative = negative_profile_args();
        assert!(production.windows(2).any(|pair| pair == ["--seccomp", "4"]));
        assert!(!negative
            .iter()
            .any(|arg| arg == "--seccomp" || arg.starts_with("/private/")));
        assert!(negative
            .windows(2)
            .any(|pair| pair == ["--tmpfs", "/input"]));
        assert!(negative
            .windows(2)
            .any(|pair| pair == ["--tmpfs", "/output"]));
        let mut expected = production.clone();
        let index = expected.iter().position(|arg| arg == "--seccomp").unwrap();
        expected.drain(index..index + 2);
        for (flag, source, target) in [
            ("--ro-bind", "/private/input", "/input"),
            ("--bind", "/private/output", "/output"),
        ] {
            let index = expected
                .windows(3)
                .position(|args| args == [flag, source, target])
                .unwrap();
            expected.splice(index..index + 3, ["--tmpfs".into(), target.into()]);
        }
        assert_eq!(negative, expected);
    }
    #[test]
    fn importer_sources_cannot_select_an_arbitrary_path() {
        assert!(validate_operation("../outside").is_err());
        assert!(validate_operation("12345678-1234-1234-1234-123456789abc").is_ok());
        assert!(validate_operation("12345678-1234-1234-1234-123456789ABC").is_err());
        assert!(validate_source(Path::new("/tmp"), Path::new("/input"), 0, 0, 0o750).is_err());
    }
    #[test]
    fn importer_has_fresh_namespaces_and_only_its_own_data() {
        let args = profile_args(Path::new("/private/input"), Path::new("/private/output"));
        for flag in [
            "--unshare-user",
            "--unshare-pid",
            "--unshare-net",
            "--unshare-ipc",
            "--unshare-uts",
        ] {
            assert!(args.iter().any(|arg| arg == flag));
        }
        assert!(args
            .windows(3)
            .any(|v| v == ["--ro-bind", "/private/input", "/input"]));
        assert!(args
            .windows(3)
            .any(|v| v == ["--bind", "/private/output", "/output"]));
        assert!(!args
            .iter()
            .any(|arg| ["/workspace", "/home/cua", "--share-net"].contains(&arg.as_str())));
        assert!(args.windows(2).any(|v| v == ["--uid", "1001"]));
        assert!(args.windows(2).any(|v| v == ["--seccomp", "4"]));
    }
}
