//! Immutable unprivileged diagnostic payload. It has no provider authority.
use cognia_desktop_guest::qualification::*;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Only fixed diagnostic failure names cross the protected output channel.
/// They cannot affect qualification or select any privileged operation.
static PROBE_STAGE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
fn phase(stage: u8) {
    PROBE_STAGE.store(stage, std::sync::atomic::Ordering::Relaxed);
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DiagnosticFailure {
    pub diagnostic_failure: String,
}
const BASIC_FAILURES: [&str; 6] = [
    "snapshot",
    "sockets",
    "dns_spawn",
    "dns_deadline",
    "dns_channel",
    "helpers",
];
fn diagnostic_error(name: &'static str) -> io::Error {
    io::Error::other(name)
}
fn contextual_failure(context: &str, error: &io::Error) -> Option<String> {
    let name = error.to_string();
    BASIC_FAILURES
        .contains(&name.as_str())
        .then(|| format!("{context}_{name}"))
}
pub(crate) fn valid_failure(value: &str) -> bool {
    if ["importer_probe", "payload_acceptance", "payload_terminal"]
        .iter()
        .any(|prefix| {
            value
                .strip_prefix(&format!("{prefix}_"))
                .is_some_and(|suffix| BASIC_FAILURES.contains(&suffix))
        })
    {
        return true;
    }
    matches!(
        value,
        "payload_identity"
            | "payload_acceptance"
            | "payload_terminal_spawn"
            | "payload_terminal_wait"
            | "payload_terminal_peer"
            | "payload_terminal_report"
            | "payload_terminal_exited"
            | "payload_terminal_deadline"
            | "payload_terminal_probe"
            | "payload_terminal_display"
            | "payload_terminal_pty"
            | "payload_terminal_exec"
            | "payload_terminal_font"
            | "importer_identity"
            | "importer_git_spawn"
            | "importer_git_observe"
            | "importer_git_write"
            | "importer_git_wait"
            | "importer_serialization"
            | "payload_browser_local"
            | "payload_browser_metadata"
            | "payload_browser_redirect"
            | "payload_browser_hostname"
            | "payload_descendant"
            | "payload_serialization"
    )
}
fn failure_stage() -> &'static str {
    match PROBE_STAGE.load(std::sync::atomic::Ordering::Relaxed) {
        1 => "payload_acceptance",
        2 => "payload_terminal_spawn",
        3 => "payload_terminal_wait",
        4 => "payload_terminal_peer",
        5 => "payload_terminal_report",
        6 => "payload_browser_local",
        7 => "payload_browser_metadata",
        8 => "payload_browser_redirect",
        9 => "payload_browser_hostname",
        10 => "payload_descendant",
        11 => "payload_serialization",
        12 => "payload_terminal_exited",
        13 => "payload_terminal_deadline",
        14 => "payload_terminal_probe",
        15 => "payload_terminal_display",
        16 => "payload_terminal_pty",
        17 => "payload_terminal_exec",
        18 => "payload_terminal_font",
        30 => "importer_identity",
        31 => "importer_git_spawn",
        32 => "importer_git_observe",
        33 => "importer_git_write",
        34 => "importer_git_wait",
        35 => "importer_serialization",
        _ => "payload_identity",
    }
}
fn refused() -> io::Error {
    io::Error::other("qualification probe refused")
}
pub(crate) fn snapshot(pid: u32) -> io::Result<ProcessSnapshot> {
    let raw = fs::read_to_string(format!("/proc/{pid}/status"))?;
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
    let status = raw
        .lines()
        .filter(|line| line.split_once(':').is_some_and(|(k, _)| keys.contains(&k)))
        .collect::<Vec<_>>()
        .join("\n");
    let mut sockets = std::collections::BTreeSet::new();
    for table in ["tcp", "tcp6", "udp", "udp6", "unix"] {
        let content = fs::read_to_string(format!("/proc/{pid}/net/{table}"))?;
        if content.len() > 256 * 1024 {
            return Err(refused());
        }
        for line in content.lines().skip(1) {
            if let Some(inode) = line
                .split_whitespace()
                .nth(if table == "unix" { 6 } else { 9 })
            {
                sockets.insert(format!("socket:[{inode}]"));
            }
        }
    }
    let mut descriptors = BTreeMap::new();
    for item in fs::read_dir(format!("/proc/{pid}/fd"))? {
        let item = item?;
        let fd: u32 = item
            .file_name()
            .to_str()
            .and_then(|v| v.parse().ok())
            .ok_or_else(refused)?;
        let target = match fs::read_link(item.path()) {
            Ok(target) => target,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        {
            let target = target.to_str().ok_or_else(refused)?.to_owned();
            // This directory is opened by the observer, not inherited by its payload.
            if pid == std::process::id() && target == format!("/proc/{pid}/fd") {
                continue;
            }
            let info = fs::read_to_string(format!("/proc/{pid}/fdinfo/{fd}"))?;
            let flags = info
                .lines()
                .find_map(|v| v.strip_prefix("flags:"))
                .and_then(|v| u64::from_str_radix(v.trim(), 8).ok())
                .ok_or_else(refused)?;
            let socket_scope = if target.starts_with("socket:[") {
                Some(
                    if sockets.contains(&target) {
                        "workload"
                    } else {
                        "outside"
                    }
                    .into(),
                )
            } else {
                None
            };
            descriptors.insert(
                fd,
                cognia_desktop_guest::observation::DescriptorObservation {
                    target,
                    flags,
                    socket_scope,
                },
            );
        }
    }
    Ok(ProcessSnapshot {
        pid,
        start_time: crate::boundary::start_time(pid)?,
        executable: fs::read_link(format!("/proc/{pid}/exe"))?
            .to_str()
            .ok_or_else(refused)?
            .into(),
        status,
        namespaces: cognia_desktop_guest::observation::NAMESPACES
            .into_iter()
            .map(|n| Ok((n.into(), crate::boundary::namespace(pid, n)?)))
            .collect::<io::Result<_>>()?,
        descriptors,
    })
}
fn syscall_result(operation: &str, result: i32) -> ErrorObservation {
    ErrorObservation {
        operation: operation.into(),
        result,
        errno: if result < 0 {
            io::Error::last_os_error().raw_os_error().unwrap_or(0)
        } else {
            0
        },
    }
}
fn sockets() -> io::Result<Vec<SocketAttempt>> {
    let mut attempts = Vec::new();
    for target in TARGETS {
        for (transport, kind, port) in [
            ("tcp", libc::SOCK_STREAM, 80_u16),
            ("tcp", libc::SOCK_STREAM, 443),
            ("udp", libc::SOCK_DGRAM, 443),
        ] {
            let ip: IpAddr = target.parse().map_err(|_| refused())?;
            let raw = unsafe {
                libc::socket(
                    if ip.is_ipv4() {
                        libc::AF_INET
                    } else {
                        libc::AF_INET6
                    },
                    kind | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                    0,
                )
            };
            if raw < 0 {
                return Err(io::Error::last_os_error());
            }
            let fd = unsafe { OwnedFd::from_raw_fd(raw) };
            let result = match ip {
                IpAddr::V4(ip) => {
                    let addr = libc::sockaddr_in {
                        sin_family: libc::AF_INET as _,
                        sin_port: port.to_be(),
                        sin_addr: libc::in_addr {
                            s_addr: u32::from_ne_bytes(ip.octets()),
                        },
                        sin_zero: [0; 8],
                    };
                    unsafe {
                        libc::connect(
                            fd.as_raw_fd(),
                            (&addr as *const libc::sockaddr_in).cast(),
                            std::mem::size_of_val(&addr) as _,
                        )
                    }
                }
                IpAddr::V6(ip) => {
                    let addr = libc::sockaddr_in6 {
                        sin6_family: libc::AF_INET6 as _,
                        sin6_port: port.to_be(),
                        sin6_flowinfo: 0,
                        sin6_addr: libc::in6_addr {
                            s6_addr: ip.octets(),
                        },
                        sin6_scope_id: if target == "fe80::1" { 1 } else { 0 },
                    };
                    unsafe {
                        libc::connect(
                            fd.as_raw_fd(),
                            (&addr as *const libc::sockaddr_in6).cast(),
                            std::mem::size_of_val(&addr) as _,
                        )
                    }
                }
            };
            let errno = if result < 0 {
                io::Error::last_os_error().raw_os_error().unwrap_or(0)
            } else {
                0
            };
            attempts.push(SocketAttempt {
                target: target.into(),
                transport: transport.into(),
                port,
                result,
                errno,
            });
        }
    }
    Ok(attempts)
}
fn hostname_attempts() -> io::Result<Vec<ErrorObservation>> {
    // Both real libc lookups share a deadline. In particular musl need not
    // honor glibc RES_OPTIONS, and a timeout is never a synthetic DNS denial.
    hostname_attempts_with(resolve_hostname, Duration::from_secs(12))
}
fn resolve_hostname(name: &str) -> i32 {
    let name_c = std::ffi::CString::new(name).expect("fixed hostname");
    let mut address = std::ptr::null_mut();
    let code = unsafe {
        libc::getaddrinfo(
            name_c.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            &mut address,
        )
    };
    if !address.is_null() {
        unsafe { libc::freeaddrinfo(address) };
    }
    code
}
fn hostname_attempts_with(
    resolve: fn(&str) -> i32,
    timeout: Duration,
) -> io::Result<Vec<ErrorObservation>> {
    let names = ["example.com", "metadata.google.internal"];
    let (send, receive) = std::sync::mpsc::sync_channel(2);
    for (index, name) in names.into_iter().enumerate() {
        let send = send.clone();
        std::thread::Builder::new()
            .spawn(move || {
                let code = resolve(name);
                let _ = send.send((index, code));
            })
            .map_err(|_| diagnostic_error("dns_spawn"))?;
    }
    drop(send);
    let until = Instant::now() + timeout;
    let mut codes = [None; 2];
    for _ in 0..2 {
        let (index, code) = receive
            .recv_timeout(until.saturating_duration_since(Instant::now()))
            .map_err(|error| {
                diagnostic_error(match error {
                    std::sync::mpsc::RecvTimeoutError::Timeout => "dns_deadline",
                    std::sync::mpsc::RecvTimeoutError::Disconnected => "dns_channel",
                })
            })?;
        codes[index] = Some(code);
    }
    names
        .into_iter()
        .zip(codes)
        .map(|(name, code)| {
            let code = code.ok_or_else(|| diagnostic_error("dns_channel"))?;
            Ok(ErrorObservation {
                operation: name.into(),
                result: code,
                errno: code,
            })
        })
        .collect()
}
pub(crate) fn basic() -> io::Result<ProbeRun> {
    let process = snapshot(std::process::id()).map_err(|_| diagnostic_error("snapshot"))?;
    let sockets = sockets().map_err(|_| diagnostic_error("sockets"))?;
    let mut paths = Vec::new();
    for path in HIDDEN_PATHS {
        let name = std::ffi::CString::new(path).map_err(|_| refused())?;
        let fd = unsafe {
            libc::open(
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        paths.push(syscall_result(path, fd));
        if fd >= 0 {
            unsafe {
                libc::close(fd);
            }
        }
    }
    let unshare = unsafe { libc::unshare(libc::CLONE_NEWUSER) };
    let a = syscall_result("unshareUser", unshare);
    let uid = unsafe { libc::setuid(0) };
    let b = syscall_result("setuidRoot", uid);
    let hostnames = hostname_attempts()?;
    let mut local_helpers = Vec::new();
    for target in ["127.0.0.1:49983", "127.0.0.1:8000"] {
        let (result, errno) = match std::net::TcpStream::connect_timeout(
            &target.parse().map_err(|_| refused())?,
            Duration::from_millis(500),
        ) {
            Ok(_) => (0, 0),
            Err(e) => (-1, e.raw_os_error().unwrap_or(0)),
        };
        local_helpers.push(ErrorObservation {
            operation: target.into(),
            result,
            errno,
        });
    }
    Ok(ProbeRun {
        process,
        sockets,
        paths,
        escapes: vec![a, b],
        hostnames,
        local_helpers,
    })
}
fn write_json(value: &impl serde::Serialize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| refused())?;
    if bytes.len() > 96 * 1024 {
        return Err(refused());
    }
    io::stdout().write_all(&bytes)
}
fn terminal_exit_category(bytes: &[u8]) -> u8 {
    let text = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    if text.contains("can't open display") || text.contains("cannot open display") {
        15
    } else if text.contains("pty") || text.contains("/dev/pts") {
        16
    } else if text.contains("execvp")
        || text.contains("cannot execute")
        || text.contains("can't exec")
    {
        17
    } else if text.contains("font") {
        18
    } else {
        12
    }
}
fn terminal() -> io::Result<ProbeRun> {
    use std::os::unix::net::UnixListener;
    let path = "/tmp/cognia-p4-terminal.sock";
    let listener = UnixListener::bind(path)?;
    listener.set_nonblocking(true)?;
    let diagnostic_fd = unsafe {
        libc::memfd_create(
            c"cognia-terminal-stderr".as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        )
    };
    if diagnostic_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let diagnostic = unsafe { File::from_raw_fd(diagnostic_fd) };
    diagnostic.set_len(4096)?;
    if unsafe {
        libc::fcntl(
            diagnostic.as_raw_fd(),
            libc::F_ADD_SEALS,
            libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut command = Command::new("/usr/bin/xterm");
    command
        .args([
            "-e",
            "/usr/local/bin/cognia-desktop-guest",
            "qualification-terminal",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(diagnostic.try_clone()?);
    phase(2);
    let mut child = command.spawn()?;
    phase(3);
    let started = Instant::now();
    let until = started + Duration::from_secs(10);
    let report_deadline = started + Duration::from_secs(24);
    let result = (|| loop {
        match listener.accept() {
            Ok((mut socket, _)) => {
                phase(4);
                let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
                let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
                if unsafe {
                    libc::getsockopt(
                        socket.as_raw_fd(),
                        libc::SOL_SOCKET,
                        libc::SO_PEERCRED,
                        credentials.as_mut_ptr().cast(),
                        &mut length,
                    )
                } != 0
                    || length as usize != std::mem::size_of::<libc::ucred>()
                {
                    return Err(refused());
                }
                let credentials = unsafe { credentials.assume_init() };
                let peer = credentials.pid as u32;
                if credentials.uid != 1000
                    || credentials.pid <= 1
                    || !crate::boundary::descendants(child.id())?.contains(&peer)
                    || fs::read(format!("/proc/{peer}/cmdline"))?
                        != b"/usr/local/bin/cognia-desktop-guest\0qualification-terminal\0"
                {
                    return Err(refused());
                }
                phase(5);
                let mut bytes = Vec::new();
                // One absolute deadline bounds partial writes as well as initial
                // probe latency. It never resets when the peer sends a byte.
                loop {
                    let remaining = report_deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        phase(13);
                        return Err(refused());
                    }
                    socket.set_read_timeout(Some(remaining))?;
                    let mut chunk = [0_u8; 4096];
                    match socket.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(length) => bytes.extend_from_slice(&chunk[..length]),
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                            ) =>
                        {
                            phase(13);
                            return Err(refused());
                        }
                        Err(error) => return Err(error),
                    }
                    if bytes.len() > 32768 {
                        return Err(refused());
                    }
                }
                if let Ok(failure) = serde_json::from_slice::<DiagnosticFailure>(&bytes) {
                    if valid_failure(&failure.diagnostic_failure) {
                        return Err(io::Error::other(failure.diagnostic_failure));
                    }
                    phase(14);
                    return Err(refused());
                }
                let value: ProbeRun = serde_json::from_slice(&bytes).map_err(|_| refused())?;
                if value.process.pid != peer
                    || value.process.start_time != crate::boundary::start_time(peer)?
                    || value.process.namespaces != snapshot(peer)?.namespaces
                {
                    return Err(refused());
                }
                return Ok(value);
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => (),
            Err(e) => return Err(e),
        }
        if child.try_wait()?.is_some() {
            use std::os::unix::fs::FileExt;
            let mut bytes = [0; 4096];
            let length = diagnostic.read_at(&mut bytes, 0).unwrap_or(0);
            phase(terminal_exit_category(&bytes[..length]));
            return Err(refused());
        }
        if Instant::now() >= until {
            phase(13);
            return Err(refused());
        }
        std::thread::sleep(Duration::from_millis(20));
    })();
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_file(path);
    result
}
fn navigation_errors(value: &serde_json::Value, target: &str) -> io::Result<Vec<i32>> {
    let events = value
        .get("events")
        .and_then(|v| v.as_array())
        .ok_or_else(refused)?;
    let mut sources = std::collections::BTreeSet::new();
    let mut errors = Vec::new();
    for event in events {
        let Some(id) = event.pointer("/source/id").and_then(|v| v.as_u64()) else {
            continue;
        };
        let Some(params) = event.get("params") else {
            continue;
        };
        if params
            .get("url")
            .and_then(|v| v.as_str())
            .is_some_and(|u| u == target)
        {
            sources.insert(id);
        }
        if !sources.contains(&id) {
            continue;
        }
        // A metadata response of any status is failure, even if a later event
        // fails. Only events for the URL's own NetLog source count as denial.
        if params
            .get("headers")
            .is_some_and(|headers| headers.to_string().contains("HTTP/"))
        {
            return Err(refused());
        }
        if let Some(error) = params.get("net_error").and_then(|v| v.as_i64()) {
            errors.push(error as i32);
        }
    }
    errors.sort_unstable();
    errors.dedup();
    if sources.is_empty() || errors.is_empty() {
        return Err(refused());
    }
    Ok(errors)
}
fn browser(url: &str, label: &str) -> io::Result<(ProcessSnapshot, i32, String, Vec<i32>)> {
    let log = format!("/tmp/cognia-p4-{label}.netlog");
    let output = format!("/tmp/cognia-p4-{label}.html");
    // Fresh release-owned diagnostic paths: never reuse a workload-created
    // Chromium profile or permit default /tmp files outside the observed scope.
    let profile = format!("/tmp/cognia-p4-{label}-profile");
    let temporary = format!("/tmp/cognia-p4-{label}-temporary");
    fs::create_dir(&profile)?;
    fs::create_dir(&temporary)?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&output)?;
    let mut command = Command::new("/usr/bin/chromium");
    command
        .args([
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-features=HttpsUpgrades",
            "--timeout=6000",
            "--dump-dom",
        ])
        .arg(format!("--log-net-log={log}"))
        .arg(format!("--user-data-dir={profile}"))
        .env("TMPDIR", &temporary)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(file)
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    let until = Instant::now() + Duration::from_secs(12);
    let mut observed = None;
    let result = (|| {
        let code = loop {
            if observed.is_none() {
                let mut candidates = crate::boundary::descendants(child.id())?;
                candidates.insert(child.id());
                for pid in candidates {
                    if fs::read_link(format!("/proc/{pid}/exe"))
                        .is_ok_and(|p| p == std::path::Path::new("/usr/lib/chromium/chromium"))
                    {
                        if let Ok(value) = snapshot(pid) {
                            observed = Some(value);
                            break;
                        }
                    }
                }
            }
            if let Some(status) = child.try_wait()? {
                break status.code().ok_or_else(refused)?;
            }
            if Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if fs::metadata(&output)?.len() > 1024 * 1024 || fs::metadata(&log)?.len() > 8 * 1024 * 1024
        {
            return Err(refused());
        }
        let html = fs::read_to_string(&output)?;
        let raw = fs::read(&log)?;
        let parsed: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| refused())?;
        let errors = if label == "local" {
            Vec::new()
        } else {
            navigation_errors(
                &parsed,
                if label == "hostname" {
                    "http://example.com/"
                } else {
                    "http://169.254.169.254/"
                },
            )?
        };
        Ok((observed.ok_or_else(refused)?, code, html, errors))
    })();
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
    let _ = fs::remove_file(output);
    let _ = fs::remove_file(log);
    result
}
fn browser_runs() -> io::Result<BrowserRun> {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 18765)))?;
    listener.set_nonblocking(true)?;
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop = done.clone();
    let server = std::thread::spawn(move || {
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
                    let mut bytes = [0; 2048];
                    let n = socket.read(&mut bytes).unwrap_or(0);
                    let redirect =
                        String::from_utf8_lossy(&bytes[..n]).starts_with("GET /redirect ");
                    let response = if redirect {
                        "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    } else {
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 51\r\nConnection: close\r\n\r\n<html><body>cognia-qualified-loopback</body></html>"
                    };
                    let _ = socket.write_all(response.as_bytes());
                }
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    });
    let result = (|| {
        let runs = std::thread::scope(|scope| {
            let local = scope.spawn(|| browser("http://127.0.0.1:18765/", "local"));
            let direct = scope.spawn(|| browser("http://169.254.169.254/", "metadata"));
            let redirect = scope.spawn(|| browser("http://127.0.0.1:18765/redirect", "redirect"));
            let hostname = scope.spawn(|| browser("http://example.com/", "hostname"));
            [
                local.join(),
                direct.join(),
                redirect.join(),
                hostname.join(),
            ]
        });
        let [local, direct, redirect, hostname] = runs;
        phase(6);
        let (process, exit, html, _) = local.map_err(|_| refused())??;
        phase(7);
        let (_, direct, _, metadata_navigation_net_errors) = direct.map_err(|_| refused())??;
        phase(8);
        let (_, redirect, _, redirect_net_errors) = redirect.map_err(|_| refused())??;
        phase(9);
        let (_, hostname, _, hostname_net_errors) = hostname.map_err(|_| refused())??;
        if direct != 0 || redirect != 0 || hostname != 0 {
            return Err(refused());
        }
        Ok(BrowserRun {
            process,
            exit_code: exit,
            local_preview: if html.contains("cognia-qualified-loopback") {
                "cognia-qualified-loopback".into()
            } else {
                String::new()
            },
            metadata_navigation_net_errors,
            redirect_net_errors,
            hostname_net_errors,
        })
    })();
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = server.join();
    result
}
pub(crate) fn desktop() -> io::Result<DesktopProbe> {
    if unsafe { libc::getuid() } != 1000 {
        return Err(refused());
    }
    phase(1);
    let acceptance = basic().map_err(|error| {
        io::Error::other(
            contextual_failure("payload_acceptance", &error)
                .unwrap_or_else(|| "payload_acceptance".into()),
        )
    })?;
    phase(2);
    let terminal = terminal()?;
    phase(6);
    let browser = browser_runs()?;
    phase(10);
    // A detached descendant outlives the original launch process group. The outer
    // root collector observes it before killing the pinned PID namespace.
    let mut pipe = [-1; 2];
    if unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut reader = unsafe { File::from_raw_fd(pipe[0]) };
    let writer = unsafe { OwnedFd::from_raw_fd(pipe[1]) };
    let detached = unsafe { libc::fork() };
    if detached < 0 {
        return Err(io::Error::last_os_error());
    }
    if detached == 0 {
        unsafe {
            libc::setsid();
            let child = libc::fork();
            if child != 0 {
                libc::_exit(if child < 0 { 125 } else { 0 });
            }
            let pid = (libc::getpid() as u32).to_be_bytes();
            libc::write(writer.as_raw_fd(), pid.as_ptr().cast(), 4);
            let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
            if null < 0 {
                libc::_exit(125);
            }
            for fd in 0..=2 {
                libc::dup2(null, fd);
            }
            libc::syscall(libc::SYS_close_range, 3_u32, u32::MAX, 0_u32);
            loop {
                libc::pause();
            }
        }
    }
    drop(writer);
    let mut detached_bytes = [0; 4];
    reader.read_exact(&mut detached_bytes)?;
    let detached_pid = u32::from_be_bytes(detached_bytes);
    let mut status = 0;
    unsafe {
        libc::waitpid(detached, &mut status, 0);
    }

    Ok(DesktopProbe {
        acceptance,
        terminal,
        browser,
        detached_pid,
    })
}
pub(crate) fn importer() -> io::Result<ImporterProbe> {
    phase(30);
    if unsafe { libc::getuid() } != 1001 {
        return Err(refused());
    }
    let importer = basic().map_err(|error| {
        io::Error::other(
            contextual_failure("importer_probe", &error)
                .unwrap_or_else(|| "importer_identity".into()),
        )
    })?;
    phase(31);
    let mut child = Command::new("/usr/bin/git")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "protocol.allow=never",
            "hash-object",
            "--stdin",
        ])
        .env_clear()
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let result = (|| {
        phase(32);
        let until = Instant::now() + Duration::from_secs(3);
        let git = loop {
            if let Ok(s) = snapshot(child.id()) {
                if s.executable == "/usr/bin/git" {
                    break s;
                }
            }
            if Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        phase(33);
        child
            .stdin
            .take()
            .ok_or_else(refused)?
            .write_all(b"cognia-fixed-qualification\n")?;
        phase(34);
        let status = child.wait()?;
        Ok(ImporterProbe {
            importer,
            git,
            git_exit_code: status.code().ok_or_else(refused)?,
        })
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}
// Connect before running probes: startup and probe completion are separate
// deadlines. SO_PEERCRED still authenticates the live xterm descendant.
fn terminal_payload(path: &str, probe: impl FnOnce() -> io::Result<ProbeRun>) -> io::Result<()> {
    let mut socket = std::os::unix::net::UnixStream::connect(path)?;
    socket.set_write_timeout(Some(Duration::from_secs(3)))?;
    let result = probe();
    let bytes = match &result {
        Ok(report) => serde_json::to_vec(report),
        Err(error) => serde_json::to_vec(&DiagnosticFailure {
            diagnostic_failure: contextual_failure("payload_terminal", error)
                .unwrap_or_else(|| "payload_terminal_probe".into()),
        }),
    }
    .map_err(|_| refused())?;
    socket.write_all(&bytes)?;
    socket.shutdown(std::net::Shutdown::Write)?;
    // Keep the actual peer alive until the parent checks its start time/namespaces.
    std::thread::sleep(Duration::from_secs(2));
    result.map(|_| ())
}
fn write_failure(error: &io::Error) {
    let name = error.to_string();
    let diagnostic_failure = if valid_failure(&name) {
        name
    } else {
        failure_stage().into()
    };
    let _ = write_json(&DiagnosticFailure { diagnostic_failure });
}
pub(crate) fn child(mode: &str) -> io::Result<()> {
    match mode {
        "qualification-workload" => {
            let result = desktop().and_then(|report| {
                phase(11);
                write_json(&report)
            });
            if let Err(error) = &result {
                write_failure(error);
            }
            result
        }
        "qualification-importer" => {
            let result = importer().and_then(|report| {
                phase(35);
                write_json(&report)
            });
            if let Err(error) = &result {
                write_failure(error);
            }
            result
        }
        "qualification-terminal" => {
            if unsafe { libc::getuid() } != 1000 {
                return Err(refused());
            }
            terminal_payload("/tmp/cognia-p4-terminal.sock", basic)
        }
        _ => Err(refused()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_failure_names_are_closed_and_never_success_reports() {
        let failure: DiagnosticFailure =
            serde_json::from_str(r#"{"diagnosticFailure":"payload_terminal_peer"}"#).unwrap();
        assert!(valid_failure(&failure.diagnostic_failure));
        assert!(!valid_failure("payload_terminal_peer: arbitrary stderr"));
        assert!(serde_json::from_str::<DiagnosticFailure>(
            r#"{"diagnosticFailure":"payload_acceptance","stdout":"untrusted"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<DesktopProbe>(
            r#"{"diagnosticFailure":"payload_acceptance"}"#
        )
        .is_err());
    }
    #[test]
    fn terminal_connects_before_probe_and_reports_probe_failure() {
        use std::os::unix::net::UnixListener;
        let path =
            std::env::temp_dir().join(format!("cognia-terminal-{}.sock", std::process::id()));
        let listener = UnixListener::bind(&path).unwrap();
        let (connected, ready) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            connected.send(()).unwrap();
            let mut bytes = Vec::new();
            socket.read_to_end(&mut bytes).unwrap();
            let failure: DiagnosticFailure = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(failure.diagnostic_failure, "payload_terminal_probe");
        });
        assert!(terminal_payload(path.to_str().unwrap(), || {
            // This receive would time out with the former probe-before-connect ordering.
            ready.recv_timeout(Duration::from_secs(1)).unwrap();
            Err(refused())
        })
        .is_err());
        thread.join().unwrap();
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn resolver_preserves_raw_outcomes_and_timeout_is_not_dns_denial() {
        fn raw(name: &str) -> i32 {
            if name == "example.com" {
                -3
            } else {
                0
            }
        }
        let observations = hostname_attempts_with(raw, Duration::from_secs(1)).unwrap();
        assert_eq!(observations[0].operation, "example.com");
        assert_eq!(observations[0].result, -3);
        // A successfully resolved address must remain a success observation;
        // the separate security validator rejects it rather than rewriting it.
        assert_eq!(observations[1].result, 0);
        fn slow(_: &str) -> i32 {
            std::thread::sleep(Duration::from_millis(30));
            -3
        }
        let error = hostname_attempts_with(slow, Duration::from_millis(1)).unwrap_err();
        assert_eq!(
            contextual_failure("importer_probe", &error).as_deref(),
            Some("importer_probe_dns_deadline")
        );
    }
    #[test]
    fn diagnostic_failure_classes_are_fixed_and_do_not_include_stderr() {
        for (raw, stage) in [
            (b"Xt error: Can't open display: :99".as_slice(), 15),
            (b"unable to open /dev/pts/1".as_slice(), 16),
            (b"execvp failed".as_slice(), 17),
            (b"cannot load font".as_slice(), 18),
            (b"unclassified arbitrary text".as_slice(), 12),
        ] {
            assert_eq!(terminal_exit_category(raw), stage);
        }
        for prefix in ["importer_probe", "payload_acceptance", "payload_terminal"] {
            for suffix in BASIC_FAILURES {
                assert!(valid_failure(&format!("{prefix}_{suffix}")));
            }
        }
        assert!(!valid_failure(
            "importer_probe_dns_deadline: arbitrary stderr"
        ));
        assert!(!valid_failure("arbitrary_probe_dns_deadline"));
    }
    #[test]
    fn browser_error_requires_same_url_source_and_no_response() {
        let unrelated = serde_json::json!({"events":[{"source":{"id":1},"params":{"url":"http://169.254.169.254/"}},{"source":{"id":2},"params":{"net_error":-109}}]});
        assert!(navigation_errors(&unrelated, "http://169.254.169.254/").is_err());
        let direct = serde_json::json!({"events":[{"source":{"id":1},"params":{"url":"http://169.254.169.254/"}},{"source":{"id":1},"params":{"net_error":-109}}]});
        assert_eq!(
            navigation_errors(&direct, "http://169.254.169.254/").unwrap(),
            vec![-109]
        );
        let response = serde_json::json!({"events":[{"source":{"id":1},"params":{"url":"http://169.254.169.254/"}},{"source":{"id":1},"params":{"headers":["HTTP/1.1 403 Forbidden"]}},{"source":{"id":1},"params":{"net_error":-109}}]});
        assert!(navigation_errors(&response, "http://169.254.169.254/").is_err());
    }
}
