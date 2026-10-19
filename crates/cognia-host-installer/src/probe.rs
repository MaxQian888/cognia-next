//! Read the machine, then decide whether a Host can be installed on it.
//!
//! Supported (ADR-0235 §3): Linux x64 and arm64 with systemd, macOS arm64 and
//! x64 with launchd, user scope only. Everything else is refused with the
//! reason, never attempted.

use std::time::Duration;

use cognia_host_service::ServicePlatform;

use crate::shell::{
    ExecRequest, InitSystem, RemoteArch, RemoteOs, RemoteOutcome, RemoteProbe, RemoteShell,
};

/// The oldest glibc a Linux host archive runs on. The Linux archives are built
/// against it (ADR-0235 P2/P3); a machine below it is refused at probe time
/// rather than failing to load the binary after an upload.
pub const GLIBC_BASELINE: (u32, u32) = (2, 35);

/// Each probe command's wait budget.
const PROBE_WAIT: Duration = Duration::from_secs(15);

/// Room an install needs beside the archive: the scratch stage, the adopted
/// copy and the data dir's first writes.
const DISK_MARGIN_BYTES: u64 = 256 * 1024 * 1024;

/// Run one probe command; a non-zero exit reads as no answer.
async fn read<S: RemoteShell + ?Sized>(shell: &S, argv: &[&str]) -> RemoteOutcome<Option<String>> {
    shell
        .exec(ExecRequest::new(argv.iter().copied(), PROBE_WAIT))
        .await
        .map(|output| {
            output
                .success()
                .then(|| output.stdout.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
}

macro_rules! probe_step {
    ($outcome:expr) => {
        match $outcome {
            RemoteOutcome::Completed(value) => value,
            RemoteOutcome::NotStarted(error) => return RemoteOutcome::NotStarted(error),
            RemoteOutcome::Unknown(detail) => return RemoteOutcome::Unknown(detail),
        }
    };
}

/// The probe every adapter shares, built on exec.
pub async fn probe_via_exec<S: RemoteShell + ?Sized>(shell: &S) -> RemoteOutcome<RemoteProbe> {
    let kernel = probe_step!(read(shell, &["uname", "-s"]).await);
    let os = match kernel.as_deref() {
        Some("Linux") => RemoteOs::Linux,
        Some("Darwin") => RemoteOs::MacOs,
        Some(other) if is_windows_kernel(other) => RemoteOs::Windows,
        Some(other) => RemoteOs::Other(other.to_owned()),
        None => {
            // No `uname`: Windows answers `ver` through cmd.
            let ver = probe_step!(read(shell, &["cmd.exe", "/c", "ver"]).await);
            if ver.as_deref().is_some_and(|v| v.contains("Windows")) {
                RemoteOs::Windows
            } else {
                RemoteOs::Other("unknown".into())
            }
        }
    };
    if !matches!(os, RemoteOs::Linux | RemoteOs::MacOs) {
        return RemoteOutcome::Completed(RemoteProbe {
            os,
            arch: RemoteArch::Other("unknown".into()),
            init: InitSystem::None,
            hostname: String::new(),
            user: String::new(),
            home: String::new(),
            linger: None,
            glibc: None,
            free_bytes: None,
        });
    }
    let machine = probe_step!(read(shell, &["uname", "-m"]).await).unwrap_or_default();
    let arch = parse_arch(&machine);
    let hostname = probe_step!(read(shell, &["uname", "-n"]).await).unwrap_or_default();
    let user = probe_step!(read(shell, &["id", "-un"]).await).unwrap_or_default();
    let home = probe_step!(read(shell, &["printenv", "HOME"]).await).unwrap_or_default();
    let (init, linger, glibc) = if os == RemoteOs::Linux {
        let pid1 = probe_step!(read(shell, &["cat", "/proc/1/comm"]).await);
        let init = if pid1.as_deref() == Some("systemd") {
            InitSystem::Systemd
        } else {
            InitSystem::None
        };
        let linger = if init == InitSystem::Systemd && !user.is_empty() {
            probe_step!(
                read(
                    shell,
                    &[
                        "loginctl",
                        "show-user",
                        &user,
                        "--property=Linger",
                        "--value"
                    ]
                )
                .await
            )
            .and_then(|value| parse_yes_no(&value))
        } else {
            None
        };
        let glibc = probe_step!(read(shell, &["getconf", "GNU_LIBC_VERSION"]).await)
            .and_then(|value| parse_glibc(&value));
        (init, linger, glibc)
    } else {
        (InitSystem::Launchd, None, None)
    };
    let free_bytes = if home.is_empty() {
        None
    } else {
        probe_step!(read(shell, &["df", "-Pk", &home]).await).and_then(|out| parse_df(&out))
    };
    RemoteOutcome::Completed(RemoteProbe {
        os,
        arch,
        init,
        hostname,
        user,
        home,
        linger,
        glibc,
        free_bytes,
    })
}

fn is_windows_kernel(kernel: &str) -> bool {
    let lower = kernel.to_ascii_lowercase();
    lower.starts_with("mingw")
        || lower.starts_with("msys")
        || lower.starts_with("cygwin")
        || lower.starts_with("windows")
}

fn parse_arch(machine: &str) -> RemoteArch {
    match machine {
        "x86_64" | "amd64" => RemoteArch::X64,
        "arm64" | "aarch64" => RemoteArch::Arm64,
        other => RemoteArch::Other(other.to_owned()),
    }
}

fn parse_yes_no(value: &str) -> Option<bool> {
    match value.trim() {
        "yes" => Some(true),
        "no" => Some(false),
        _ => None,
    }
}

/// `glibc 2.35` → `(2, 35)`.
fn parse_glibc(value: &str) -> Option<(u32, u32)> {
    let version = value.trim().strip_prefix("glibc ")?;
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// The available column of `df -Pk <path>`, in bytes.
fn parse_df(output: &str) -> Option<u64> {
    let line = output.lines().nth(1)?;
    let available_kib: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    available_kib.checked_mul(1024)
}

/// Why a machine cannot take a Host.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Unsupported {
    #[error("Windows machines cannot run a Cognia Host yet; use Linux or macOS")]
    Windows,
    #[error("{0} is not a supported operating system; use Linux or macOS")]
    Os(String),
    #[error("the {0} architecture is not supported; use x64 or arm64")]
    Arch(String),
    #[error(
        "this Linux machine does not run systemd, so a user service cannot keep the Host running"
    )]
    NoServiceManager,
    #[error(
        "glibc {}.{} is older than the {}.{} the Host is built for",
        .found.0, .found.1, .baseline.0, .baseline.1
    )]
    GlibcTooOld {
        found: (u32, u32),
        baseline: (u32, u32),
    },
    #[error("the C library is not glibc (or could not be read); the Linux Host needs glibc {}.{} or newer", GLIBC_BASELINE.0, GLIBC_BASELINE.1)]
    GlibcUnknown,
    #[error("the home directory could not be read")]
    NoHome,
}

/// Something true about the install that the user must be told before
/// consenting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    /// systemd lingering is off: the Host stops at logout and does not start
    /// after a reboot until the user logs in again.
    LingerOff,
    /// Lingering could not be read; the same may be true.
    LingerUnknown,
}

/// A machine that can take a Host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostTarget {
    /// The catalog target: `linux-x64`, `linux-arm64`, `darwin-arm64`,
    /// `darwin-x64`.
    pub target: &'static str,
    pub platform: ServicePlatform,
    pub notices: Vec<Notice>,
}

/// Decide the catalog target for a probed machine, or why there is none.
pub fn resolve_target(probe: &RemoteProbe) -> Result<HostTarget, Unsupported> {
    let platform = match &probe.os {
        RemoteOs::Linux => ServicePlatform::Linux,
        RemoteOs::MacOs => ServicePlatform::MacOs,
        RemoteOs::Windows => return Err(Unsupported::Windows),
        RemoteOs::Other(name) => return Err(Unsupported::Os(name.clone())),
    };
    let target = match (platform, &probe.arch) {
        (ServicePlatform::Linux, RemoteArch::X64) => "linux-x64",
        (ServicePlatform::Linux, RemoteArch::Arm64) => "linux-arm64",
        (ServicePlatform::MacOs, RemoteArch::Arm64) => "darwin-arm64",
        (ServicePlatform::MacOs, RemoteArch::X64) => "darwin-x64",
        (_, RemoteArch::Other(name)) => return Err(Unsupported::Arch(name.clone())),
    };
    if probe.home.is_empty() {
        return Err(Unsupported::NoHome);
    }
    let mut notices = Vec::new();
    if platform == ServicePlatform::Linux {
        if probe.init != InitSystem::Systemd {
            return Err(Unsupported::NoServiceManager);
        }
        match probe.glibc {
            Some(found) if found < GLIBC_BASELINE => {
                return Err(Unsupported::GlibcTooOld {
                    found,
                    baseline: GLIBC_BASELINE,
                })
            }
            Some(_) => {}
            None => return Err(Unsupported::GlibcUnknown),
        }
        match probe.linger {
            Some(true) => {}
            Some(false) => notices.push(Notice::LingerOff),
            None => notices.push(Notice::LingerUnknown),
        }
    }
    Ok(HostTarget {
        target,
        platform,
        notices,
    })
}

/// Whether the machine has room for an archive of `archive_len` bytes: the
/// upload, the scratch stage and the adopted copy, plus a margin.
pub fn has_room_for(probe: &RemoteProbe, archive_len: u64) -> Result<(), (u64, u64)> {
    let needed = archive_len
        .saturating_mul(3)
        .saturating_add(DISK_MARGIN_BYTES);
    match probe.free_bytes {
        Some(free) if free < needed => Err((free, needed)),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::FakeShell;

    fn linux_probe() -> RemoteProbe {
        RemoteProbe {
            os: RemoteOs::Linux,
            arch: RemoteArch::X64,
            init: InitSystem::Systemd,
            hostname: "box".into(),
            user: "ubuntu".into(),
            home: "/home/ubuntu".into(),
            linger: Some(true),
            glibc: Some((2, 35)),
            free_bytes: Some(10 << 30),
        }
    }

    #[tokio::test]
    async fn the_probe_reads_a_linux_machine_through_exec() {
        let shell = FakeShell::linux_ubuntu_2204();
        let RemoteOutcome::Completed(probe) = shell.probe().await else {
            panic!("probe failed");
        };
        assert_eq!(probe.os, RemoteOs::Linux);
        assert_eq!(probe.arch, RemoteArch::X64);
        assert_eq!(probe.init, InitSystem::Systemd);
        assert_eq!(probe.hostname, "VM-0-8-ubuntu");
        assert_eq!(probe.user, "ubuntu");
        assert_eq!(probe.home, "/home/ubuntu");
        assert_eq!(probe.linger, Some(false));
        assert_eq!(probe.glibc, Some((2, 35)));
        assert_eq!(probe.free_bytes, Some(52_428_800 * 1024));
    }

    #[tokio::test]
    async fn a_machine_without_uname_that_answers_ver_is_windows() {
        let shell = FakeShell::new();
        shell.answer(
            &["cmd.exe", "/c", "ver"],
            0,
            "Microsoft Windows [Version 10.0]",
        );
        let RemoteOutcome::Completed(probe) = shell.probe().await else {
            panic!("probe failed");
        };
        assert_eq!(probe.os, RemoteOs::Windows);
        assert_eq!(resolve_target(&probe), Err(Unsupported::Windows));
    }

    #[tokio::test]
    async fn an_unknown_outcome_stops_the_probe() {
        let shell = FakeShell::linux_ubuntu_2204();
        shell.unknown(&["uname", "-m"]);
        assert!(matches!(shell.probe().await, RemoteOutcome::Unknown(_)));
    }

    #[test]
    fn supported_machines_map_to_catalog_targets() {
        assert_eq!(resolve_target(&linux_probe()).unwrap().target, "linux-x64");
        let arm = RemoteProbe {
            arch: RemoteArch::Arm64,
            ..linux_probe()
        };
        assert_eq!(resolve_target(&arm).unwrap().target, "linux-arm64");
        let mac = RemoteProbe {
            os: RemoteOs::MacOs,
            arch: RemoteArch::Arm64,
            init: InitSystem::Launchd,
            linger: None,
            glibc: None,
            ..linux_probe()
        };
        let target = resolve_target(&mac).unwrap();
        assert_eq!(target.target, "darwin-arm64");
        assert_eq!(target.platform, ServicePlatform::MacOs);
        assert!(target.notices.is_empty());
    }

    #[test]
    fn unsupported_machines_are_refused_with_the_reason() {
        let no_systemd = RemoteProbe {
            init: InitSystem::None,
            ..linux_probe()
        };
        assert_eq!(
            resolve_target(&no_systemd),
            Err(Unsupported::NoServiceManager)
        );
        let old = RemoteProbe {
            glibc: Some((2, 31)),
            ..linux_probe()
        };
        assert_eq!(
            resolve_target(&old),
            Err(Unsupported::GlibcTooOld {
                found: (2, 31),
                baseline: GLIBC_BASELINE
            })
        );
        let musl = RemoteProbe {
            glibc: None,
            ..linux_probe()
        };
        assert_eq!(resolve_target(&musl), Err(Unsupported::GlibcUnknown));
        let riscv = RemoteProbe {
            arch: RemoteArch::Other("riscv64".into()),
            ..linux_probe()
        };
        assert_eq!(
            resolve_target(&riscv),
            Err(Unsupported::Arch("riscv64".into()))
        );
        let bsd = RemoteProbe {
            os: RemoteOs::Other("FreeBSD".into()),
            ..linux_probe()
        };
        assert_eq!(resolve_target(&bsd), Err(Unsupported::Os("FreeBSD".into())));
    }

    #[test]
    fn lingering_off_is_a_notice_not_a_refusal() {
        let off = RemoteProbe {
            linger: Some(false),
            ..linux_probe()
        };
        assert_eq!(
            resolve_target(&off).unwrap().notices,
            vec![Notice::LingerOff]
        );
        let unknown = RemoteProbe {
            linger: None,
            ..linux_probe()
        };
        assert_eq!(
            resolve_target(&unknown).unwrap().notices,
            vec![Notice::LingerUnknown]
        );
    }

    #[test]
    fn disk_room_counts_the_upload_the_stage_and_the_copy() {
        let probe = RemoteProbe {
            free_bytes: Some(1 << 30),
            ..linux_probe()
        };
        assert!(has_room_for(&probe, 200 << 20).is_ok());
        assert!(has_room_for(&probe, 300 << 20).is_err());
        let unknown = RemoteProbe {
            free_bytes: None,
            ..linux_probe()
        };
        assert!(has_room_for(&unknown, u64::MAX).is_ok());
    }

    #[test]
    fn probe_output_parsers_tolerate_real_output() {
        assert_eq!(parse_glibc("glibc 2.39\n"), Some((2, 39)));
        assert_eq!(parse_glibc("musl"), None);
        assert_eq!(
            parse_df("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 82045336 29590364 52428800 37% /\n"),
            Some(52_428_800 * 1024)
        );
        assert_eq!(parse_df("garbage"), None);
        assert_eq!(parse_arch("aarch64"), RemoteArch::Arm64);
        assert_eq!(parse_yes_no("maybe"), None);
    }
}
