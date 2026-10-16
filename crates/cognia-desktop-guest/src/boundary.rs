//! Root-side observations, never workload-supplied health claims.

use cognia_desktop_guest::observation::{
    DescriptorObservation, ProcessBoundaryReport, ISOLATION_REVISION, REPORT_VERSION,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Boundary {
    pub generation: String,
    pub isolation_revision: u32,
    pub namespace_init_pid: u32,
    pub namespace_init_start_time: u64,
    pub workload_pid: u32,
    pub workload_start_time: u64,
    pub namespaces: BTreeMap<String, String>,
}

fn invalid() -> io::Error {
    io::Error::other("desktop boundary invalid")
}

pub(crate) fn start_time(pid: u32) -> io::Result<u64> {
    parse_start_time(&fs::read_to_string(format!("/proc/{pid}/stat"))?)
}

fn parse_start_time(stat: &str) -> io::Result<u64> {
    stat.rsplit_once(')')
        .ok_or_else(invalid)?
        .1
        .split_whitespace()
        .nth(19)
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())
}

pub(crate) fn descendants(pid: u32) -> io::Result<BTreeSet<u32>> {
    let mut found = BTreeSet::new();
    let mut pending = vec![pid];
    while let Some(parent) = pending.pop() {
        let children = match fs::read_to_string(format!("/proc/{parent}/task/{parent}/children")) {
            Ok(children) => children,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for child in children.split_whitespace() {
            let child: u32 = child.parse().map_err(|_| invalid())?;
            if found.insert(child) {
                pending.push(child);
            }
            if found.len() > 256 {
                return Err(invalid());
            }
        }
    }
    Ok(found)
}

pub(crate) fn namespace(pid: u32, name: &str) -> io::Result<String> {
    let value = fs::read_link(format!("/proc/{pid}/ns/{name}"))?;
    let value = value.to_str().ok_or_else(invalid)?;
    let expected = format!("{name}:[");
    if !value.starts_with(&expected) || !value.ends_with(']') {
        return Err(invalid());
    }
    Ok(value.into())
}

pub(crate) fn restricted_status(status: &str) -> bool {
    restricted_identity(status, "1000")
}

fn restricted_identity(status: &str, uid: &str) -> bool {
    let fields: BTreeMap<_, _> = status
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name, value.trim()))
        .collect();
    ["Uid", "Gid"].iter().all(|key| {
        fields.get(key).is_some_and(|value| {
            let ids: Vec<_> = value.split_whitespace().collect();
            ids.len() == 4 && ids.iter().all(|id| *id == uid)
        })
    }) && ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]
        .iter()
        .all(|key| {
            fields
                .get(key)
                .is_some_and(|value| u64::from_str_radix(value, 16) == Ok(0))
        })
        && fields.get("NoNewPrivs") == Some(&"1")
        && fields.get("Seccomp") == Some(&"2")
        && fields.get("Groups").is_some_and(|value| value.is_empty())
}

fn loopback_only(devices: &str) -> bool {
    let interfaces: Vec<_> = devices
        .lines()
        .skip(2)
        .filter_map(|line| line.split_once(':').map(|(name, _)| name.trim()))
        .collect();
    interfaces == ["lo"]
}

pub(crate) fn observe(supervisor_child: u32, init: u32, generation: &str) -> io::Result<Boundary> {
    observe_identity(
        supervisor_child,
        init,
        generation,
        "1000",
        b"/usr/local/bin/python3\0-I\0/opt/cognia-desktop/startup.py\0--managed\0",
    )
}

pub(crate) fn observe_importer(child: u32, init: u32) -> io::Result<Boundary> {
    observe_identity(
        child,
        init,
        "importer",
        "1001",
        b"/usr/local/bin/python3\0-I\0/opt/cognia-desktop/handoff-import.py\0",
    )
}

fn observe_identity(
    supervisor_child: u32,
    init: u32,
    generation: &str,
    uid: &str,
    argv: &[u8],
) -> io::Result<Boundary> {
    if init <= 1 || !descendants(supervisor_child)?.contains(&init) && init != supervisor_child {
        return Err(invalid());
    }
    let init_start = start_time(init)?;
    let mut candidates = descendants(init)?;
    candidates.insert(init);
    let workload = candidates
        .into_iter()
        .find(|pid| fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|cmd| cmd == argv))
        .ok_or_else(invalid)?;
    let workload_start = start_time(workload)?;
    if uid == "1001" {
        // At the fixed admission barrier the importer has not opened /input.
        // No socket or outside directory descriptor may survive bootstrap.
        let mut standard = BTreeSet::new();
        for entry in fs::read_dir(format!("/proc/{workload}/fd"))? {
            let entry = entry?;
            let fd: u32 = entry
                .file_name()
                .to_str()
                .ok_or_else(invalid)?
                .parse()
                .map_err(|_| invalid())?;
            let target = fs::read_link(entry.path())?;
            let target = target.to_str().ok_or_else(invalid)?;
            let allowed = match fd {
                0 => target.starts_with("pipe:[") && target.ends_with(']'),
                1 | 2 => target == "/dev/null",
                _ => target == "/opt/cognia-desktop/handoff-import.py",
            };
            if !allowed {
                return Err(invalid());
            }
            if fd <= 2 {
                standard.insert(fd);
            }
        }
        if standard != BTreeSet::from([0, 1, 2]) {
            return Err(invalid());
        }
    }
    if !restricted_identity(
        &fs::read_to_string(format!("/proc/{workload}/status"))?,
        uid,
    ) {
        return Err(invalid());
    }
    let mut namespaces = BTreeMap::new();
    for name in ["user", "net", "pid", "mnt", "ipc", "uts"] {
        let value = namespace(workload, name)?;
        if value == namespace(std::process::id(), name)? || value != namespace(init, name)? {
            return Err(invalid());
        }
        namespaces.insert(name.into(), value);
    }
    if !loopback_only(&fs::read_to_string(format!("/proc/{workload}/net/dev"))?) {
        return Err(invalid());
    }
    let routes = fs::read_to_string(format!("/proc/{workload}/net/route"))?;
    if routes.lines().skip(1).any(|line| !line.trim().is_empty()) {
        return Err(invalid());
    }
    let routes6 = fs::read_to_string(format!("/proc/{workload}/net/ipv6_route"))?;
    if routes6
        .lines()
        .any(|line| line.split_whitespace().last() != Some("lo"))
    {
        return Err(invalid());
    }
    // A changing PID cannot satisfy a generation-bound observation.
    if start_time(init)? != init_start || start_time(workload)? != workload_start {
        return Err(invalid());
    }
    Ok(Boundary {
        generation: generation.into(),
        isolation_revision: 1,
        namespace_init_pid: init,
        namespace_init_start_time: init_start,
        workload_pid: workload,
        workload_start_time: workload_start,
        namespaces,
    })
}

pub(crate) fn still_current(boundary: &Boundary) -> bool {
    start_time(boundary.namespace_init_pid).ok() == Some(boundary.namespace_init_start_time)
        && start_time(boundary.workload_pid).ok() == Some(boundary.workload_start_time)
        && boundary.namespaces.iter().all(|(name, expected)| {
            namespace(boundary.workload_pid, name).as_ref().ok() == Some(expected)
        })
}

/// Capture kernel evidence while the immutable launch is held at its admission barrier.
/// This report is not populated from workload stdout or a guest health endpoint.
pub(crate) fn report(
    boundary: &Boundary,
    pid: u32,
    uid: u32,
    generation: &str,
) -> io::Result<ProcessBoundaryReport> {
    use std::io::Read;
    let bounded = |path: String, limit: u64| -> io::Result<String> {
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(limit + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit {
            return Err(invalid());
        }
        String::from_utf8(bytes).map_err(|_| invalid())
    };
    let started = start_time(pid)?;
    let raw_status = bounded(format!("/proc/{pid}/status"), 16384)?;
    let keys = [
        "Uid",
        "Gid",
        "Groups",
        "CapInh",
        "CapPrm",
        "CapEff",
        "CapBnd",
        "CapAmb",
        "NoNewPrivs",
        "Seccomp",
    ];
    let status = raw_status
        .lines()
        .filter(|line| {
            line.split_once(':')
                .is_some_and(|(name, _)| keys.contains(&name))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut namespaces = BTreeMap::new();
    let mut provider_namespaces = BTreeMap::new();
    for name in cognia_desktop_guest::observation::NAMESPACES {
        let identity = namespace(pid, name)?;
        if boundary.namespaces.get(name) != Some(&identity) {
            return Err(invalid());
        }
        namespaces.insert(name.into(), identity);
        provider_namespaces.insert(name.into(), namespace(std::process::id(), name)?);
    }
    let mut socket_inodes = BTreeSet::new();
    for table in ["tcp", "tcp6", "udp", "udp6", "unix"] {
        let contents = bounded(format!("/proc/{pid}/net/{table}"), 256 * 1024)?;
        for line in contents.lines().skip(1) {
            if let Some(inode) = line
                .split_whitespace()
                .nth(if table == "unix" { 6 } else { 9 })
            {
                socket_inodes.insert(format!("socket:[{inode}]"));
            }
        }
    }
    let ingress = bounded("/proc/self/net/unix".into(), 256 * 1024)?
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            (fields.len() == 8 && fields[7] == crate::relay::SOCKET)
                .then(|| format!("socket:[{}]", fields[6]))
        })
        .collect::<BTreeSet<_>>();
    let mut descriptors = BTreeMap::new();
    for entry in fs::read_dir(format!("/proc/{pid}/fd"))? {
        let entry = entry?;
        let fd: u32 = entry
            .file_name()
            .to_str()
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?;
        let target = fs::read_link(entry.path())?
            .to_str()
            .ok_or_else(invalid)?
            .to_owned();
        let fdinfo = bounded(format!("/proc/{pid}/fdinfo/{fd}"), 4096)?;
        let flags = fdinfo
            .lines()
            .find_map(|line| line.strip_prefix("flags:"))
            .and_then(|v| u64::from_str_radix(v.trim(), 8).ok())
            .ok_or_else(invalid)?;
        let socket_scope = if target.starts_with("socket:[") {
            if socket_inodes.contains(&target) {
                Some("workload".into())
            } else if ingress.contains(&target) && uid == 1000 {
                Some("gui-ingress".into())
            } else {
                return Err(invalid());
            }
        } else {
            None
        };
        descriptors.insert(
            fd,
            DescriptorObservation {
                target,
                flags,
                socket_scope,
            },
        );
        if descriptors.len() > 128 {
            return Err(invalid());
        }
    }
    let report = ProcessBoundaryReport {
        report_version: REPORT_VERSION,
        phase: if uid == 1001 {
            cognia_desktop_guest::observation::ObservationPhase::ImporterAdmission
        } else if pid == boundary.workload_pid {
            cognia_desktop_guest::observation::ObservationPhase::DesktopLive
        } else {
            cognia_desktop_guest::observation::ObservationPhase::AcceptanceAdmission
        },
        workload_isolation_revision: ISOLATION_REVISION,
        boundary_generation: generation.into(),
        namespace_init_pid: boundary.namespace_init_pid,
        namespace_init_start_time: boundary.namespace_init_start_time,
        workload_pid: pid,
        workload_start_time: started,
        namespaces,
        provider_namespaces,
        status,
        network_devices: bounded(format!("/proc/{pid}/net/dev"), 4096)?,
        ipv4_routes: bounded(format!("/proc/{pid}/net/route"), 4096)?,
        ipv6_routes: bounded(format!("/proc/{pid}/net/ipv6_route"), 8192)?,
        descriptors,
    };
    report.validate(uid).map_err(|_| invalid())?;
    if start_time(pid)? != started || !still_current(boundary) {
        return Err(invalid());
    }
    Ok(report)
}

/// Fixed root-only observer; no project path, PID, command or destination input.
pub(crate) fn print_live_report() -> io::Result<()> {
    use std::io::{Read, Write};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    if unsafe { libc::geteuid() } != 0 || unsafe { libc::getuid() } != 0 {
        return Err(invalid());
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(25);
    loop {
        let attempt = (|| -> io::Result<ProcessBoundaryReport> {
            let parent = fs::symlink_metadata("/run/cognia-desktop")?;
            if !parent.is_dir() || parent.uid() != 0 || parent.mode() & 0o022 != 0 {
                return Err(invalid());
            }
            let mut file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
                .open("/run/cognia-desktop/state.json")?;
            let meta = file.metadata()?;
            if !meta.is_file()
                || meta.uid() != 0
                || meta.nlink() != 1
                || meta.mode() & 0o7777 != 0o600
                || meta.len() > 16384
            {
                return Err(invalid());
            }
            let mut bytes = Vec::new();
            Read::by_ref(&mut file)
                .take(16385)
                .read_to_end(&mut bytes)?;
            let boundary: Boundary = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            if boundary.isolation_revision != ISOLATION_REVISION || !still_current(&boundary) {
                return Err(invalid());
            }
            report(&boundary, boundary.workload_pid, 1000, &boundary.generation)
        })();
        match attempt {
            Ok(report) => {
                let bytes = serde_json::to_vec(&report).map_err(|_| invalid())?;
                if bytes.len() > 32768 {
                    return Err(invalid());
                }
                std::io::stdout().write_all(&bytes)?;
                return Ok(());
            }
            Err(_) if std::time::Instant::now() < until => {
                std::thread::sleep(std::time::Duration::from_millis(100))
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_identity_uses_start_time_not_a_reusable_pid_or_name() {
        let stat =
            "123 (name with ) paren) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 98765 20";
        assert_eq!(parse_start_time(stat).unwrap(), 98765);
        assert!(parse_start_time("123 (truncated) S 1").is_err());
        assert!(parse_start_time("malformed").is_err());
    }

    #[test]
    fn status_requires_all_privilege_dimensions() {
        let status = "Uid:\t1000 1000 1000 1000\nGid:\t1000 1000 1000 1000\nGroups:\nCapInh:\t0\nCapPrm:\t0\nCapEff:\t0\nCapBnd:\t0\nCapAmb:\t0\nNoNewPrivs:\t1\nSeccomp:\t2\n";
        assert!(restricted_status(status));
        let importer = status.replace("1000", "1001");
        assert!(restricted_identity(&importer, "1001"));
        assert!(!restricted_status(&importer));
        assert!(!restricted_identity(status, "1001"));
        for (before, after) in [
            ("CapBnd:\t0", "CapBnd:\t1"),
            ("Seccomp:\t2", "Seccomp:\t0"),
            ("Groups:", "Groups: 0"),
            ("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
        ] {
            assert!(!restricted_status(&status.replace(before, after)));
        }
    }

    #[test]
    fn additional_interface_refuses_even_without_default_route() {
        assert!(loopback_only("header\nheader\n lo: 0 0\n"));
        assert!(!loopback_only("header\nheader\n lo: 0 0\n eth0: 0 0\n"));
        assert!(!loopback_only("header\nheader\n"));
    }
}
