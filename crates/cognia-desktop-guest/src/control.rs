//! Fixed root-only handoff endpoint. The supervisor retains request authority
//! and launch lifetime; a direct child handles bounded transfer and promotion.
use crate::{
    acceptance, boundary, promotion,
    protocol::{self, invalid, Manifest, Receipt, Report, Request},
};
use cognia_exec_sandbox::importer::ImportLaunch;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const SOCKET: &str = "/run/cognia-desktop/control.sock";
fn peer(socket: &UnixStream) -> io::Result<libc::ucred> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut size,
        )
    } != 0
        || size as usize != std::mem::size_of::<libc::ucred>()
        || credentials.uid != 0
    {
        return Err(invalid());
    }
    Ok(credentials)
}
fn root_identity() -> io::Result<()> {
    if unsafe { libc::geteuid() } != 0
        || unsafe { libc::getuid() } != 0
        || unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0
    {
        return Err(invalid());
    }
    Ok(())
}
fn duplicate(fd: i32) -> io::Result<OwnedFd> {
    let fd = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
fn timeout(socket: &UnixStream, deadline: Instant) -> io::Result<()> {
    socket.set_write_timeout(Some(
        deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(invalid)?
            .min(Duration::from_secs(30)),
    ))
}

/// envd transport only. The root supervisor, not this CLI, authorizes promotion.
pub(crate) fn forward() -> io::Result<()> {
    root_identity()?;
    let fd = unsafe { libc::fcntl(0, libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut input = unsafe { File::from_raw_fd(fd) };
    let header = protocol::read_line(
        &mut input,
        protocol::HEADER_LIMIT,
        Instant::now() + Duration::from_secs(30),
    )?;
    let request: Request = serde_json::from_slice(&header).map_err(|_| invalid())?;
    let manifest = request.validate()?;
    let deadline = request.deadline()?;
    let mut socket = UnixStream::connect(SOCKET)?;
    peer(&socket)?;
    timeout(&socket, deadline)?;
    socket.write_all(&header)?;
    let total = manifest.bundle_bytes + manifest.files.iter().map(|file| file.bytes).sum::<u64>();
    let mut remaining = total;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let read = protocol::read_some(&mut input, &mut buffer[..limit], deadline)?;
        if read == 0 {
            return Err(invalid());
        }
        timeout(&socket, deadline)?;
        socket.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    if protocol::read_some(&mut input, &mut buffer[..1], deadline)? != 0 {
        return Err(invalid());
    }
    socket.shutdown(Shutdown::Write)?;
    let bytes = protocol::read_line(&mut socket, protocol::RECEIPT_LIMIT, deadline)?;
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if receipt.receipt_version != 2
        || receipt.operation_id != request.operation_id
        || receipt.manifest_digest != request.manifest_digest
        || receipt.commit != manifest.commit
        || receipt.source_tree_sha256 != manifest.source_tree_sha256
        || receipt.source_file_count != manifest.source_file_count
        || receipt.source_bytes != manifest.source_bytes
        || !protocol::canonical_uuid(&receipt.boundary_generation)
        || receipt.workspace != format!("/workspace/{}/workspace", request.operation_id)
        || receipt.launched != request.launch.is_some()
    {
        return Err(invalid());
    }
    std::io::stdout().write_all(&bytes)
}

struct Pending {
    child: Child,
    report: UnixStream,
    client: UnixStream,
    client_pidfd: OwnedFd,
    buffer: Vec<u8>,
    request: Option<Request>,
    prepared: bool,
    eof: bool,
    deadline: Instant,
}
impl Drop for Pending {
    fn drop(&mut self) {
        kill_and_reap(&mut self.child);
    }
}
pub(crate) struct Control {
    listener: UnixListener,
    pending: Option<Pending>,
    jobs: Vec<acceptance::AcceptanceJob>,
    completed: usize,
}
impl Drop for Control {
    fn drop(&mut self) {
        self.pending.take();
        self.jobs.clear();
        let _ = std::fs::remove_file(SOCKET);
    }
}
impl Control {
    pub(crate) fn bind() -> io::Result<Self> {
        let listener = UnixListener::bind(SOCKET)?;
        std::fs::set_permissions(SOCKET, std::fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener,
            pending: None,
            jobs: Vec::new(),
            completed: 0,
        })
    }
    pub(crate) fn tick(&mut self, boundary: &boundary::Boundary) -> io::Result<()> {
        for job in &mut self.jobs {
            job.check()?;
        }
        match self.listener.accept() {
            Ok((client, _)) => {
                let client_pid = peer(&client)?.pid;
                let raw_pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, client_pid, 0) };
                if raw_pidfd < 0 {
                    return Err(invalid());
                }
                let client_pidfd = unsafe { OwnedFd::from_raw_fd(raw_pidfd as i32) };
                if self.pending.is_some() || self.completed >= 100 {
                    return Err(invalid());
                }
                let (report, worker_report) = UnixStream::pair()?;
                report.set_nonblocking(true)?;
                let client_fd = duplicate(client.as_raw_fd())?;
                let report_fd = duplicate(worker_report.as_raw_fd())?;
                // Reserve low descriptor holes before std::process creates its exec pipe.
                let reservations = [
                    duplicate_low(client.as_raw_fd())?,
                    duplicate_low(client.as_raw_fd())?,
                ];
                let parent = unsafe { libc::getpid() };
                let mut command = Command::new("/usr/local/bin/cognia-desktop-guest");
                command
                    .arg("handoff-worker")
                    .env_clear()
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                unsafe {
                    command.pre_exec(move || {
                        let _held = &reservations;
                        if libc::syscall(libc::SYS_close_range, 3_u32, u32::MAX, 4_u32) != 0
                            || libc::dup2(client_fd.as_raw_fd(), 3) < 0
                            || libc::dup2(report_fd.as_raw_fd(), 4) < 0
                            || libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) != 0
                            || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0
                            || libc::getppid() != parent
                        {
                            return Err(invalid());
                        }
                        Ok(())
                    });
                }
                let child = command.spawn()?;
                drop(command);
                drop(worker_report);
                self.pending = Some(Pending {
                    child,
                    report,
                    client,
                    client_pidfd,
                    buffer: Vec::new(),
                    request: None,
                    prepared: false,
                    eof: false,
                    deadline: Instant::now() + Duration::from_secs(30),
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => (),
            Err(error) => return Err(error),
        }
        let Some(pending) = &mut self.pending else {
            return Ok(());
        };
        let mut alive = libc::pollfd {
            fd: pending.client_pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut alive, 1, 0) } != 0 {
            return Err(invalid());
        }
        if Instant::now() >= pending.deadline {
            return Err(invalid());
        }
        loop {
            let mut bytes = [0_u8; 8192];
            match pending.report.read(&mut bytes) {
                Ok(0) => {
                    pending.eof = true;
                    break;
                }
                Ok(count) => pending.buffer.extend_from_slice(&bytes[..count]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
            if pending.buffer.len() > protocol::REPORT_LIMIT {
                return Err(invalid());
            }
        }
        while let Some(end) = pending.buffer.iter().position(|byte| *byte == b'\n') {
            let report: Report =
                serde_json::from_slice(&pending.buffer[..=end]).map_err(|_| invalid())?;
            pending.buffer.drain(..=end);
            match report {
                Report::Header(request) if pending.request.is_none() && !pending.prepared => {
                    request.validate()?;
                    pending.deadline = request.deadline()?;
                    pending.request = Some(request);
                    // One byte on a fresh socket cannot fill its send buffer.
                    pending.report.write_all(b"G")?;
                }
                Report::Prepared if pending.request.is_some() && !pending.prepared => {
                    pending.prepared = true
                }
                _ => return Err(invalid()),
            }
        }
        let Some(status) = pending.child.try_wait()? else {
            return Ok(());
        };
        if !status.success() {
            return Err(invalid());
        }
        if !pending.eof {
            return Ok(());
        }
        if !pending.buffer.is_empty() || !pending.prepared {
            return Err(invalid());
        }
        let request = pending.request.as_ref().ok_or_else(invalid)?;
        let manifest = request.validate()?;
        if !boundary::still_current(boundary) {
            return Err(invalid());
        }
        if let Some(launch) = &request.launch {
            self.jobs.push(acceptance::spawn(
                boundary,
                &request.operation_id,
                &launch.script,
                pending.deadline,
            )?);
        }
        let receipt = Receipt {
            receipt_version: 2,
            boundary_generation: boundary.generation.clone(),
            operation_id: request.operation_id.clone(),
            commit: manifest.commit,
            manifest_digest: request.manifest_digest.clone(),
            source_tree_sha256: manifest.source_tree_sha256,
            source_file_count: manifest.source_file_count,
            source_bytes: manifest.source_bytes,
            workspace: format!("/workspace/{}/workspace", request.operation_id),
            launched: request.launch.is_some(),
        };
        promotion::store_receipt(request, &receipt)?;
        timeout(&pending.client, pending.deadline)?;
        protocol::write_json(&mut pending.client, &receipt, protocol::RECEIPT_LIMIT)?;
        pending.client.shutdown(Shutdown::Both)?;
        self.pending.take();
        self.completed += 1;
        Ok(())
    }
}
fn duplicate_low(fd: i32) -> io::Result<OwnedFd> {
    let value = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if value < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(value) })
}
fn kill_and_reap(child: &mut Child) {
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            _ => break,
        }
    }
}
struct ImportProcess(Child);
impl Drop for ImportProcess {
    fn drop(&mut self) {
        kill_and_reap(&mut self.0);
    }
}
fn receive(
    socket: &mut UnixStream,
    file: &mut File,
    length: u64,
    expected: &str,
    deadline: Instant,
) -> io::Result<()> {
    let mut digest = Sha256::new();
    let mut remaining = length;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let read = protocol::read_some(socket, &mut buffer[..limit], deadline)?;
        if read == 0 {
            return Err(invalid());
        }
        file.write_all(&buffer[..read])?;
        digest.update(&buffer[..read]);
        remaining -= read as u64;
    }
    if hex::encode(digest.finalize()) != expected {
        return Err(invalid());
    }
    file.sync_all()
}
fn run_import(
    request: &Request,
    input: &std::path::Path,
    output: &std::path::Path,
    deadline: Instant,
) -> io::Result<()> {
    let (mut info, write) = UnixStream::pair()?;
    let mut command =
        ImportLaunch::prepare(&request.operation_id, input, output, write.as_fd())?.command()?;
    let mut process = ImportProcess(command.spawn()?);
    drop(command);
    drop(write);
    let init = crate::supervisor::init_pid(&mut info, &mut process.0)?;
    let admission_deadline = deadline.min(Instant::now() + Duration::from_secs(20));
    let observed = loop {
        if process.0.try_wait()?.is_some() || Instant::now() >= admission_deadline {
            return Err(invalid());
        }
        if let Ok(observed) = boundary::observe_importer(process.0.id(), init) {
            break observed;
        }
        thread::sleep(Duration::from_millis(20));
    };
    let mut admission = process.0.stdin.take().ok_or_else(invalid)?;
    admission.write_all(b"G")?;
    drop(admission);
    loop {
        if Instant::now() >= deadline {
            return Err(invalid());
        }
        if let Some(status) = process.0.try_wait()? {
            if !status.success() {
                return Err(invalid());
            }
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    // Namespace init's death kills every member, including setsid/double-fork.
    let death_deadline = deadline.min(Instant::now() + Duration::from_secs(5));
    while boundary::start_time(init).ok() == Some(observed.namespace_init_start_time) {
        if Instant::now() >= death_deadline {
            return Err(invalid());
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}
pub(crate) fn worker() -> io::Result<()> {
    root_identity()?;
    let parent = unsafe { libc::getppid() };
    let mut socket = unsafe { UnixStream::from_raw_fd(3) };
    let mut report = unsafe { UnixStream::from_raw_fd(4) };
    if peer(&report)?.pid != parent || parent <= 1 {
        return Err(invalid());
    }
    peer(&socket)?;
    for fd in [3, 4] {
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(invalid());
        }
    }
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0
        || unsafe { libc::getppid() } != parent
    {
        return Err(invalid());
    }
    let header = protocol::read_line(
        &mut socket,
        protocol::HEADER_LIMIT,
        Instant::now() + Duration::from_secs(30),
    )?;
    let request: Request = serde_json::from_slice(&header).map_err(|_| invalid())?;
    let manifest: Manifest = request.validate()?;
    let deadline = request.deadline()?;
    timeout(&report, deadline)?;
    protocol::write_json(
        &mut report,
        &Report::Header(request.clone()),
        protocol::REPORT_LIMIT,
    )?;
    let mut admission = [0_u8];
    if protocol::read_some(&mut report, &mut admission, deadline)? != 1 || admission != [b'G'] {
        return Err(invalid());
    }
    let (input, output) = promotion::stage(&request)?;
    receive(
        &mut socket,
        &mut promotion::input_file(&input, "source.bundle")?,
        manifest.bundle_bytes,
        &manifest.bundle_sha256,
        deadline,
    )?;
    for (index, file) in manifest.files.iter().enumerate() {
        receive(
            &mut socket,
            &mut promotion::input_file(&input, &format!("file-{index}"))?,
            file.bytes,
            &file.sha256,
            deadline,
        )?;
    }
    if protocol::read_some(&mut socket, &mut admission, deadline)? != 0 {
        return Err(invalid());
    }
    run_import(&request, &input, &output, deadline)?;
    promotion::promote(&request, &manifest, &output, deadline)?;
    promotion::finish_staging(&request)?;
    protocol::write_json(&mut report, &Report::Prepared, protocol::REPORT_LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_and_ingress_are_separate_fixed_endpoints() {
        assert_ne!(SOCKET, crate::relay::SOCKET);
        assert!(!SOCKET.starts_with("/workspace"));
    }
}
