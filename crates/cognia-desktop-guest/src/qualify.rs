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
const ACCEPTANCE_STAGES: [&str; 18] = [
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
    "payload_browser_local",
    "payload_browser_metadata",
    "payload_browser_redirect",
    "payload_browser_hostname",
    "payload_descendant",
    "payload_serialization",
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
        let mut process = Process(command.spawn()?);
        drop(command);
        drop(write);
        let init = crate::supervisor::init_pid(&mut info, &mut process.0)?;
        let until = Instant::now() + Duration::from_secs(10);
        let observed = loop {
            if let Ok(value) = boundary::observe_importer(process.0.id(), init) {
                break value;
            }
            if process.0.try_wait()?.is_some() || Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let report = boundary::report(&observed, observed.workload_pid, 1001, generation)?;
        let mut pids = boundary::descendants(process.0.id())?;
        pids.insert(process.0.id());
        let terminated = pids
            .into_iter()
            .map(|pid| Ok((pid, boundary::start_time(pid)?)))
            .collect::<io::Result<BTreeMap<_, _>>>()?;
        process
            .0
            .stdin
            .take()
            .ok_or_else(refused)?
            .write_all(b"Q")?;
        let until = Instant::now() + Duration::from_secs(25);
        loop {
            if let Some(status) = process.0.try_wait()? {
                if !status.success() {
                    return Err(refused());
                }
                break;
            }
            if Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        for (pid, start) in &terminated {
            if boundary::start_time(*pid).ok() == Some(*start) {
                return Err(refused());
            }
        }
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
        let probe: ImporterProbe = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        Ok((report, probe, terminated))
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
    if report.validate().is_err() {
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
    fn fixed_result_paths_are_outside_workload_mounts() {
        for path in [CLAIM, RESULT, FAILURE] {
            assert!(path.starts_with("/run/cognia-desktop/"));
        }
        assert_eq!(LIMIT, 131072);
    }
}
