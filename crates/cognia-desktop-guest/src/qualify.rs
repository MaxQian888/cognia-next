//! Fixed root-only asynchronous collector. No workload-selected PID/path/argv.
//! EnvD returns from start before this detached collector begins. Qualification
//! result is a separate authenticated connection, never a prerequisite for death.
use crate::{acceptance, boundary, promotion};
use cognia_desktop_guest::qualification::*;
use cognia_exec_sandbox::importer::ImportLaunch;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
const CLAIM: &str = "/run/cognia-desktop/qualification.claim";
const RESULT: &str = "/run/cognia-desktop/qualification.json";
const FAILURE: &str = "/run/cognia-desktop/qualification.failed";
const LIMIT: u64 = 128 * 1024;
static STAGE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
const ACCEPTANCE_STAGES: &[&str] = &[
    "acceptance_prepare",
    "acceptance_spawn",
    "acceptance_admission_wait",
    "acceptance_admission_validate",
    "acceptance_ack",
    "acceptance_payload",
    "payload_identity",
    "payload_acceptance",
    "payload_terminal_spawn",
    "payload_terminal_wait",
    "payload_terminal_peer",
    "payload_terminal_report",
    "payload_terminal_exited",
    "payload_terminal_deadline",
    "payload_terminal_probe",
    "payload_browser_local",
    "payload_browser_metadata",
    "payload_browser_redirect",
    "payload_browser_hostname",
    "payload_descendant",
    "payload_serialization",
    "importer_prepare",
    "importer_spawn",
    "importer_init",
    "importer_admission",
    "importer_boundary_report",
    "importer_release",
    "importer_wait",
    "importer_deadline",
    "importer_teardown",
    "importer_output",
    "importer_exited",
    "importer_identity",
    "importer_git_spawn",
    "importer_git_observe",
    "importer_git_write",
    "importer_git_wait",
    "importer_serialization",
    "payload_terminal_display",
    "payload_terminal_pty",
    "payload_terminal_exec",
    "payload_terminal_font",
    "importer_probe_snapshot",
    "importer_probe_sockets",
    "importer_probe_dns_spawn",
    "importer_probe_dns_deadline",
    "importer_probe_dns_channel",
    "importer_probe_helpers",
    "payload_acceptance_snapshot",
    "payload_acceptance_sockets",
    "payload_acceptance_dns_spawn",
    "payload_acceptance_dns_deadline",
    "payload_acceptance_dns_channel",
    "payload_acceptance_helpers",
    "payload_terminal_snapshot",
    "payload_terminal_sockets",
    "payload_terminal_dns_spawn",
    "payload_terminal_dns_deadline",
    "payload_terminal_dns_channel",
    "payload_terminal_helpers",
    "validation_desktop",
    "validation_negative_control",
    "validation_tamper_control",
    "validation_acceptance_admission",
    "validation_importer_admission",
    "validation_binding",
    "validation_acceptance_probe",
    "validation_terminal_probe",
    "validation_browser_process",
    "validation_importer_probe",
    "validation_git_process",
    "validation_browser",
    "validation_teardown",
    "negative_prepare",
    "negative_spawn",
    "negative_observe",
    "negative_rejection",
    "negative_teardown",
    "validation_weakened_launch",
];
pub(crate) fn acceptance_stage(value: &str) {
    if let Some(index) = ACCEPTANCE_STAGES.iter().position(|name| *name == value) {
        stage(index as u8 + 10);
    }
}
fn stage(value: u8) {
    STAGE.store(value, std::sync::atomic::Ordering::Relaxed);
}
fn failure_stage() -> &'static str {
    match STAGE.load(std::sync::atomic::Ordering::Relaxed) {
        1 => "boundary",
        2 => "importer",
        3 => "acceptance",
        4 => "descendants",
        5 => "supervisor_death",
        6 => "validation",
        value if value >= 10 => ACCEPTANCE_STAGES
            .get((value - 10) as usize)
            .copied()
            .unwrap_or("bootstrap"),
        _ => "bootstrap",
    }
}
fn refused() -> io::Error {
    io::Error::other("qualification refused")
}
fn root() -> io::Result<()> {
    if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0 {
        return Err(refused());
    }
    let meta = fs::symlink_metadata("/run/cognia-desktop")?;
    if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
        return Err(refused());
    }
    Ok(())
}
fn protected_read(path: &str) -> io::Result<Vec<u8>> {
    root()?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != 0
        || meta.nlink() != 1
        || meta.mode() & 0o7777 != 0o600
        || meta.len() > LIMIT
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        return Err(refused());
    }
    Ok(bytes)
}
fn protected_write(path: &str, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() as u64 > LIMIT {
        return Err(refused());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
pub(crate) fn start() -> io::Result<()> {
    root()?;
    let live = boundary::load_current()?;
    protected_write(CLAIM, live.generation.as_bytes())?;
    let mut command = Command::new("/usr/local/bin/cognia-desktop-guest");
    command
        .arg("qualify-worker")
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0
                || libc::syscall(libc::SYS_close_range, 3_u32, u32::MAX, 4_u32) != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn()?;
    io::stdout().write_all(
        &serde_json::to_vec(
            &serde_json::json!({"boundaryGeneration": live.generation, "started":true}),
        )
        .map_err(|_| refused())?,
    )
}
pub(crate) fn result() -> io::Result<()> {
    root()?;
    let claim = String::from_utf8(protected_read(CLAIM)?).map_err(|_| refused())?;
    if Path::new(FAILURE).exists() {
        let failure = protected_read(FAILURE)?;
        if failure.len() <= 128
            && failure
                .iter()
                .all(|b| b.is_ascii_lowercase() || *b == b'_' || *b == b':')
        {
            eprintln!("{}", String::from_utf8_lossy(&failure));
        }
        return Err(refused());
    }
    let bytes = match protected_read(RESULT) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return io::stdout().write_all(
                &serde_json::to_vec(
                    &serde_json::json!({"boundaryGeneration":claim,"pending":true}),
                )
                .map_err(|_| refused())?,
            )
        }
        Err(error) => return Err(error),
    };
    let report: WorkloadQualificationReport =
        serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if report.boundary_generation != claim {
        return Err(refused());
    }
    report.validate().map_err(|_| refused())?;
    io::stdout().write_all(&bytes)
}
pub(crate) fn worker() -> io::Result<()> {
    let outcome = worker_inner();
    if outcome.is_err() && root().is_ok() {
        // Bootstrap errors precede watchdog installation and otherwise leave a
        // permanent pending result after the detached worker has already exited.
        let _ = protected_write(
            FAILURE,
            format!("qualification_failed:{}", failure_stage()).as_bytes(),
        );
    }
    outcome
}
fn worker_inner() -> io::Result<()> {
    root()?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(CLAIM)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(refused());
    }
    // The start command's envd stdout has closed. This process retained no envd
    // descriptors and is neither a child of nor owned by the desktop supervisor.
    let pinned = boundary::load_current()?;
    let (_, _, watchdog_supervisor) = supervisor(pinned.namespace_init_pid)?;
    let completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = completed.clone();
    let watchdog = std::thread::spawn(move || {
        let end = Instant::now() + Duration::from_secs(75);
        while Instant::now() < end {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = protected_write(FAILURE, b"qualification_deadline");
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                watchdog_supervisor.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0_u32,
            );
            libc::_exit(124);
        }
    });
    std::thread::sleep(Duration::from_secs(2));
    let outcome = collect().and_then(|report| {
        let bytes = serde_json::to_vec(&report).map_err(|_| refused())?;
        protected_write(RESULT, &bytes)
    });
    if outcome.is_err() {
        let _ = protected_write(
            FAILURE,
            format!("qualification_failed:{}", failure_stage()).as_bytes(),
        );
    }
    completed.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = watchdog.join();
    outcome
}
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn importer(
    generation: &str,
) -> io::Result<(
    cognia_desktop_guest::observation::ProcessBoundaryReport,
    ImporterProbe,
    BTreeMap<u32, u64>,
)> {
    acceptance_stage("importer_prepare");
    let operation = uuid::Uuid::new_v4().to_string();
    let root = Path::new(promotion::IMPORTS);
    promotion::directory(root, 0o711, 0, 0, false)?;
    let staging = root.join(&operation);
    promotion::directory(&staging, 0o711, 0, 0, true)?;
    let input = staging.join("input");
    let output = staging.join("output");
    promotion::directory(&input, 0o750, 0, 1001, true)?;
    promotion::directory(&output, 0o700, 1001, 1001, true)?;
    let outcome = (|| {
        let (mut info, write) = UnixStream::pair()?;
        let mut command =
            ImportLaunch::prepare(&operation, &input, &output, write.as_fd())?.command()?;
        acceptance_stage("importer_spawn");
        let mut process = Process(command.spawn()?);
        drop(command);
        drop(write);
        acceptance_stage("importer_init");
        let init = crate::supervisor::init_pid(&mut info, &mut process.0)?;
        let until = Instant::now() + Duration::from_secs(10);
        acceptance_stage("importer_admission");
        let observed = loop {
            if let Ok(value) = boundary::observe_importer(process.0.id(), init) {
                break value;
            }
            if process.0.try_wait()?.is_some() || Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        acceptance_stage("importer_boundary_report");
        let report = boundary::report(&observed, observed.workload_pid, 1001, generation)?;
        let mut pids = boundary::descendants(process.0.id())?;
        pids.insert(process.0.id());
        let terminated = pids
            .into_iter()
            .map(|pid| Ok((pid, boundary::start_time(pid)?)))
            .collect::<io::Result<BTreeMap<_, _>>>()?;
        acceptance_stage("importer_release");
        process
            .0
            .stdin
            .take()
            .ok_or_else(refused)?
            .write_all(b"Q")?;
        acceptance_stage("importer_wait");
        let until = Instant::now() + Duration::from_secs(25);
        let status = loop {
            if let Some(status) = process.0.try_wait()? {
                break status;
            }
            if Instant::now() >= until {
                acceptance_stage("importer_deadline");
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        acceptance_stage("importer_teardown");
        for (pid, start) in &terminated {
            if boundary::start_time(*pid).ok() == Some(*start) {
                return Err(refused());
            }
        }
        acceptance_stage("importer_output");
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(output.join("qualification.json"))?;
        let meta = file.metadata()?;
        if !meta.is_file() || meta.uid() != 1001 || meta.nlink() != 1 || meta.len() > 32768 {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(32769)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 32768 {
            return Err(refused());
        }
        // Failure payload is read only after exit and the same protected path,
        // owner/type/link/size checks as success. It can never qualify a run.
        if let Ok(failure) = serde_json::from_slice::<crate::probe::DiagnosticFailure>(&bytes) {
            if crate::probe::valid_failure(&failure.diagnostic_failure)
                && failure.diagnostic_failure.starts_with("importer_")
            {
                acceptance_stage(&failure.diagnostic_failure);
            }
            return Err(refused());
        }
        if !status.success() {
            acceptance_stage("importer_exited");
            return Err(refused());
        }
        let probe: ImporterProbe = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        Ok((report, probe, terminated))
    })();
    let _ = fs::remove_dir_all(&staging);
    outcome
}
fn weakened_launch(
    desktop: &cognia_desktop_guest::observation::ProcessBoundaryReport,
) -> io::Result<WeakenedLaunchEvidence> {
    use cognia_desktop_guest::observation::{
        ObservationPhase, ProcessBoundaryReport, ISOLATION_REVISION, NAMESPACES, REPORT_VERSION,
    };
    acceptance_stage("negative_prepare");
    let operation = uuid::Uuid::new_v4().to_string();
    let root = Path::new(promotion::IMPORTS);
    promotion::directory(root, 0o711, 0, 0, false)?;
    let staging = root.join(&operation);
    promotion::directory(&staging, 0o711, 0, 0, true)?;
    let input = staging.join("input");
    let output = staging.join("output");
    promotion::directory(&input, 0o750, 0, 1001, true)?;
    promotion::directory(&output, 0o700, 1001, 1001, true)?;
    let outcome = (|| {
        let (mut info, write) = UnixStream::pair()?;
        let mut command = ImportLaunch::prepare(&operation, &input, &output, write.as_fd())?
            .qualification_without_seccomp_command()?;
        acceptance_stage("negative_spawn");
        let mut process = Process(command.spawn()?);
        drop(command);
        drop(write);
        let init = crate::supervisor::init_pid(&mut info, &mut process.0)?;
        let init_start = boundary::start_time(init)?;
        acceptance_stage("negative_observe");
        let until = Instant::now() + Duration::from_secs(5);
        let (workload, observed) = loop {
            let mut candidates = boundary::descendants(init)?;
            candidates.insert(init);
            let value = candidates.into_iter().find_map(|pid| {
                (fs::read(format!("/proc/{pid}/cmdline")).ok()?.as_slice()
                    == b"/usr/local/bin/cognia-desktop-guest\0qualification-negative-wait\0")
                    .then(|| crate::probe::snapshot(pid).ok())
                    .flatten()
                    .map(|report| (pid, report))
            });
            if let Some(value) = value {
                break value;
            }
            if process.0.try_wait()?.is_some() || Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if !boundary::descendants(process.0.id())?.contains(&init)
            || boundary::start_time(init)? != init_start
            || NAMESPACES.iter().any(|name| {
                boundary::namespace(init, name).ok().as_ref() != observed.namespaces.get(*name)
            })
        {
            return Err(refused());
        }
        let read = |suffix: &str, limit: usize| -> io::Result<String> {
            let mut file = std::fs::File::open(format!("/proc/{workload}/{suffix}"))?;
            let mut bytes = String::new();
            Read::by_ref(&mut file)
                .take(limit as u64 + 1)
                .read_to_string(&mut bytes)?;
            if bytes.len() > limit {
                return Err(refused());
            }
            Ok(bytes)
        };
        let admission = ProcessBoundaryReport {
            report_version: REPORT_VERSION,
            phase: ObservationPhase::ImporterAdmission,
            workload_isolation_revision: ISOLATION_REVISION,
            boundary_generation: desktop.boundary_generation.clone(),
            namespace_init_pid: init,
            namespace_init_start_time: init_start,
            workload_pid: workload,
            workload_start_time: observed.start_time,
            namespaces: observed.namespaces,
            provider_namespaces: desktop.provider_namespaces.clone(),
            status: observed.status,
            network_devices: read("net/dev", 4096)?,
            ipv4_routes: read("net/route", 4096)?,
            ipv6_routes: read("net/ipv6_route", 8192)?,
            descriptors: observed.descriptors,
        };
        let mut pids = boundary::descendants(process.0.id())?;
        pids.insert(process.0.id());
        let terminated_processes = pids
            .into_iter()
            .map(|pid| Ok((pid, boundary::start_time(pid)?)))
            .collect::<io::Result<BTreeMap<_, _>>>()?;
        if boundary::start_time(workload)? != admission.workload_start_time {
            return Err(refused());
        }
        acceptance_stage("negative_rejection");
        let mut evidence = WeakenedLaunchEvidence {
            profile: "importer-without-seccomp-v1".into(),
            executable: observed.executable,
            admission,
            terminated_processes,
            surviving_processes: BTreeMap::new(),
        };
        // Reject inherited provider filters that make this an undemonstrated
        // negative control. Never grant a capability or weaken networking.
        evidence.validate(desktop).map_err(|_| refused())?;
        acceptance_stage("negative_teardown");
        if boundary::start_time(init)? != init_start
            || unsafe { libc::kill(init as i32, libc::SIGKILL) } != 0
        {
            return Err(refused());
        }
        let until = Instant::now() + Duration::from_secs(3);
        while process.0.try_wait()?.is_none() {
            if Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        loop {
            evidence.surviving_processes = evidence
                .terminated_processes
                .iter()
                .filter(|(pid, start)| boundary::start_time(**pid).ok() == Some(**start))
                .map(|(pid, start)| (*pid, *start))
                .collect();
            if evidence.surviving_processes.is_empty() {
                break;
            }
            if Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        evidence.validate(desktop).map_err(|_| refused())?;
        Ok(evidence)
    })();
    let _ = fs::remove_dir_all(&staging);
    outcome
}
fn supervisor(init: u32) -> io::Result<(u32, u64, OwnedFd)> {
    let mut pid = init;
    for _ in 0..8 {
        let cmd = fs::read(format!("/proc/{pid}/cmdline"))?;
        if cmd == b"/usr/local/bin/cognia-desktop-guest\0supervise\0" {
            let started = boundary::start_time(pid)?;
            let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
            if raw < 0 {
                return Err(io::Error::last_os_error());
            }
            let fd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
            if boundary::start_time(pid)? != started {
                return Err(refused());
            }
            return Ok((pid, started, fd));
        }
        let status = fs::read_to_string(format!("/proc/{pid}/status"))?;
        pid = status
            .lines()
            .find_map(|l| l.strip_prefix("PPid:"))
            .and_then(|v| v.trim().parse().ok())
            .filter(|p| *p > 1)
            .ok_or_else(refused)?;
    }
    Err(refused())
}
fn collect() -> io::Result<WorkloadQualificationReport> {
    stage(1);
    let live = boundary::load_current()?;
    if protected_read(CLAIM)? != live.generation.as_bytes() {
        return Err(refused());
    }
    let desktop = boundary::report(&live, live.workload_pid, 1000, &live.generation)?;
    let negative_control = crate::probe::snapshot(std::process::id())?;
    let weakened_launch = weakened_launch(&desktop)?;
    let (supervisor_pid, supervisor_start_time, supervisor_fd) =
        supervisor(live.namespace_init_pid)?;
    stage(2);
    let (importer_admission, importer_probe, mut terminated_processes) =
        importer(&live.generation)?;
    let operation = uuid::Uuid::new_v4().to_string();
    let parent = Path::new("/var/lib/cognia-desktop/workspace").join(&operation);
    promotion::directory(&parent, 0o711, 0, 0, true)?;
    let workspace = parent.join("workspace");
    promotion::directory(&workspace, 0o755, 1000, 1000, true)?;
    stage(3);
    let mut job =
        acceptance::spawn_diagnostic(&live, &operation, Instant::now() + Duration::from_secs(90))?;
    let acceptance_admission = job.boundary_report.take().ok_or_else(refused)?;
    let desktop_probe = job.diagnostic_report.take().ok_or_else(refused)?;
    stage(4);
    let mut pids = boundary::descendants(supervisor_pid)?;
    pids.insert(supervisor_pid);
    pids.insert(live.namespace_init_pid);
    for pid in pids {
        if let Ok(start) = boundary::start_time(pid) {
            terminated_processes.insert(pid, start);
        }
    }
    let detached_outer_pid = terminated_processes
        .keys()
        .copied()
        .find(|pid| {
            boundary::namespace(*pid, "pid").ok().as_ref() == live.namespaces.get("pid")
                && fs::read_to_string(format!("/proc/{pid}/status"))
                    .ok()
                    .and_then(|text| {
                        text.lines()
                            .find_map(|l| l.strip_prefix("NSpid:"))
                            .and_then(|v| v.split_whitespace().last())
                            .and_then(|v| v.parse::<u32>().ok())
                    })
                    == Some(desktop_probe.detached_pid)
        })
        .ok_or_else(refused)?;
    stage(5);
    // Pin identity, then kill the actual supervisor, not its workload namespace.
    // No Host connection, explicit desktop delete or AcceptanceJob drop triggers it.
    if boundary::start_time(supervisor_pid)? != supervisor_start_time
        || !boundary::still_current(&live)
    {
        return Err(refused());
    }
    if unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            supervisor_fd.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0_u32,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let until = Instant::now() + Duration::from_secs(8);
    let surviving_processes = loop {
        let survivors: BTreeMap<_, _> = terminated_processes
            .iter()
            .filter(|(pid, start)| boundary::start_time(**pid).ok() == Some(**start))
            .map(|(p, s)| (*p, *s))
            .collect();
        if survivors.is_empty() || Instant::now() >= until {
            break survivors;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let ingress_errno = match std::net::TcpStream::connect_timeout(
        &"127.0.0.1:8000".parse().map_err(|_| refused())?,
        Duration::from_secs(1),
    ) {
        Ok(_) => 0,
        Err(e) => e.raw_os_error().unwrap_or(0),
    };
    // Only after recording post-supervisor evidence may local handle drop clean up.
    drop(job);
    let _ = fs::remove_dir_all(parent);
    let report = WorkloadQualificationReport {
        report_version: PROBE_VERSION,
        boundary_generation: live.generation.clone(),
        negative_control,
        weakened_launch,
        desktop,
        acceptance_admission,
        importer_admission,
        desktop_probe,
        importer_probe,
        terminated_processes,
        surviving_processes,
        supervisor_pid,
        detached_outer_pid,
        supervisor_start_time,
        ingress_errno,
    };
    stage(6);
    if let Err(category) = report.validate() {
        acceptance_stage(category);
        // Failed evidence remains root-only for diagnosis. FAILURE prevents the
        // result command from returning it as a qualification result.
        protected_write(RESULT, &serde_json::to_vec(&report).map_err(|_| refused())?)?;
        return Err(refused());
    }
    Ok(report)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_stage_catalog_is_unique_and_bounded() {
        let unique: std::collections::BTreeSet<_> = ACCEPTANCE_STAGES.iter().collect();
        assert_eq!(unique.len(), ACCEPTANCE_STAGES.len());
        assert!(ACCEPTANCE_STAGES.len() + 10 < u8::MAX as usize);
        assert!(ACCEPTANCE_STAGES.iter().all(|stage| stage.len() <= 64
            && stage
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')));
        assert!(ACCEPTANCE_STAGES.contains(&"importer_probe_dns_deadline"));
        assert!(ACCEPTANCE_STAGES.contains(&"validation_importer_probe"));
    }
    #[test]
    fn fixed_result_paths_are_outside_workload_mounts() {
        for path in [CLAIM, RESULT, FAILURE] {
            assert!(path.starts_with("/run/cognia-desktop/"));
        }
        assert_eq!(LIMIT, 131072);
    }
}
