//! Linux namespace relay and its versioned lifecycle protocol.
//!
//! The host owns policy and filtering. This helper forwards opaque bytes only
//! to the fixed Unix endpoint; it never resolves a destination or dials egress.

#[cfg(any(target_os = "linux", test))]
use std::io;
use std::time::Duration;
#[cfg(any(target_os = "linux", test))]
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(target_os = "linux")]
use tokio::net::UnixListener;
#[cfg(any(target_os = "linux", test))]
use tokio::net::UnixStream;

pub const PROTOCOL_VERSION: u32 = 2;
pub const RESERVED_DIR: &str = "/run/cognia-egress";
pub const PROXY_PATH: &str = "/run/cognia-egress/proxy.sock";
pub const CONTROL_PATH: &str = "/run/cognia-egress/control.sock";
pub const HELPER_PATH: &str = "/run/cognia-egress/helper";
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(any(target_os = "linux", test))]
const READY: &[u8] = b"COGNIA_EGRESS_READY 2\n";
#[cfg(any(target_os = "linux", test))]
const GO: &[u8] = b"COGNIA_EGRESS_GO 2\n";
#[cfg(any(target_os = "linux", test))]
const STARTED: &[u8] = b"COGNIA_EGRESS_STARTED 2\n";

#[cfg(any(target_os = "linux", test))]
fn protocol_error(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(any(target_os = "linux", test))]
async fn expect_frame<S: AsyncRead + Unpin>(stream: &mut S, expected: &[u8]) -> io::Result<()> {
    // A fixed-length read bounds memory even for hostile or stale helpers.
    let mut frame = [0; 64];
    stream.read_exact(&mut frame[..expected.len()]).await?;
    if &frame[..expected.len()] != expected {
        return Err(protocol_error("unsupported Linux egress bridge protocol"));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
async fn host_go<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    before_go: impl FnOnce(&S) -> io::Result<()>,
) -> io::Result<()> {
    expect_frame(stream, READY).await?;
    before_go(stream)?;
    stream.write_all(GO).await?;
    stream.flush().await
}

#[cfg(test)]
async fn host_exchange<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    before_go: impl FnOnce(&S) -> io::Result<()>,
) -> io::Result<()> {
    host_go(stream, before_go).await?;
    expect_frame(stream, STARTED).await
}

#[cfg(any(target_os = "linux", test))]
async fn helper_exchange<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> io::Result<()> {
    stream.write_all(READY).await?;
    stream.flush().await?;
    expect_frame(stream, GO).await
}

#[cfg(any(target_os = "linux", test))]
async fn helper_started<S: AsyncWrite + Unpin>(stream: &mut S) -> io::Result<()> {
    stream.write_all(STARTED).await?;
    stream.flush().await
}

/// Accept Ready and release the target only after the namespace relay passed
/// its end-to-end probe. Success additionally requires confirmation that the
/// target's pre-exec seccomp install succeeded. EOF, stale versions and stalls
/// refuse the run.
#[cfg(target_os = "linux")]
pub async fn host_handshake(
    listener: &UnixListener,
    stdin: std::os::fd::OwnedFd,
    mut before_go: impl FnMut(&UnixStream) -> io::Result<()>,
) -> io::Result<UnixStream> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let mut stream = loop {
            let (stream, _) = listener.accept().await?;
            // Authenticate kernel peer credentials before reading even Ready:
            // a foreign connection must neither stall us nor receive Go/fds.
            // The enclosing deadline bounds repeated rejected connections.
            if before_go(&stream).is_ok() {
                break stream;
            }
        };
        host_go(&mut stream, |_| Ok(())).await?;
        descriptors::send(&stream, &stdin).await?;
        drop(stdin);
        expect_frame(&mut stream, STARTED).await?;
        Ok(stream)
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Linux bridge handshake timed out"))?
}

/// Descriptor transfer occurs after Go and before Started. Bwrap never sees
/// either pipe end. All descriptors remain CLOEXEC except target fd 0.
#[cfg(target_os = "linux")]
mod descriptors {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use tokio::io::Interest;

    pub async fn send(stream: &UnixStream, fd: &OwnedFd) -> io::Result<()> {
        stream
            .async_io(Interest::WRITABLE, || {
                let mut byte = b'I';
                let mut iov = libc::iovec {
                    iov_base: (&mut byte as *mut u8).cast(),
                    iov_len: 1,
                };
                // usize alignment is sufficient for cmsghdr on supported Linux ABIs.
                let mut ancillary = [0usize; 32];
                let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
                message.msg_iov = &mut iov;
                message.msg_iovlen = 1;
                message.msg_control = ancillary.as_mut_ptr().cast();
                message.msg_controllen =
                    unsafe { libc::CMSG_SPACE(std::mem::size_of::<i32>() as _) } as _;
                unsafe {
                    let header = libc::CMSG_FIRSTHDR(&message);
                    (*header).cmsg_level = libc::SOL_SOCKET;
                    (*header).cmsg_type = libc::SCM_RIGHTS;
                    (*header).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<i32>() as _) as _;
                    std::ptr::write_unaligned(
                        libc::CMSG_DATA(header).cast::<i32>(),
                        fd.as_raw_fd(),
                    );
                    let sent = libc::sendmsg(stream.as_raw_fd(), &message, libc::MSG_NOSIGNAL);
                    if sent < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if sent != 1 {
                        return Err(io::Error::new(
                            io::ErrorKind::WriteZero,
                            "bridge stdin descriptor not sent",
                        ));
                    }
                }
                Ok(())
            })
            .await
    }

    pub async fn receive(stream: &UnixStream) -> io::Result<OwnedFd> {
        stream
            .async_io(Interest::READABLE, || {
                let mut byte = 0u8;
                let mut iov = libc::iovec {
                    iov_base: (&mut byte as *mut u8).cast(),
                    iov_len: 1,
                };
                let mut ancillary = [0usize; 32];
                let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
                message.msg_iov = &mut iov;
                message.msg_iovlen = 1;
                message.msg_control = ancillary.as_mut_ptr().cast();
                message.msg_controllen = std::mem::size_of_val(&ancillary) as _;
                let count = unsafe {
                    libc::recvmsg(stream.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC)
                };
                if count < 0 {
                    return Err(io::Error::last_os_error());
                }
                let mut descriptors = Vec::new();
                unsafe {
                    let mut header = libc::CMSG_FIRSTHDR(&message);
                    while !header.is_null() {
                        if (*header).cmsg_level == libc::SOL_SOCKET
                            && (*header).cmsg_type == libc::SCM_RIGHTS
                        {
                            let bytes = ((*header).cmsg_len as usize)
                                .saturating_sub(libc::CMSG_LEN(0) as usize);
                            for index in 0..bytes / std::mem::size_of::<i32>() {
                                let fd = std::ptr::read_unaligned(
                                    libc::CMSG_DATA(header).cast::<i32>().add(index),
                                );
                                descriptors.push(OwnedFd::from_raw_fd(fd));
                            }
                        }
                        header = libc::CMSG_NXTHDR(&message, header);
                    }
                }
                if count != 1
                    || byte != b'I'
                    || message.msg_flags & libc::MSG_CTRUNC != 0
                    || descriptors.len() != 1
                {
                    return Err(protocol_error("missing or invalid bridge stdin descriptor"));
                }
                Ok(descriptors.pop().expect("one validated descriptor"))
            })
            .await
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[tokio::test]
        async fn spawned_target_closing_stdin_returns_epipe_while_it_is_alive() {
            use std::process::Stdio;
            let (host, helper) = UnixStream::pair().unwrap();
            let (mut writer, reader) = tokio::net::unix::pipe::pipe().unwrap();
            let reader = reader.into_blocking_fd().unwrap();
            send(&host, &reader).await.unwrap();
            drop(reader);
            let received = receive(&helper).await.unwrap();
            let mut command = tokio::process::Command::new("/bin/sh");
            command
                .args(["-c", "exec 0<&-; printf ready; exec sleep 10"])
                .stdin(Stdio::from(received))
                .stdout(Stdio::piped())
                .kill_on_drop(true);
            let mut target = command.spawn().unwrap();
            drop(command);
            let mut ready = [0; 5];
            target
                .stdout
                .take()
                .unwrap()
                .read_exact(&mut ready)
                .await
                .unwrap();
            assert_eq!(&ready, b"ready");
            let error = tokio::time::timeout(Duration::from_secs(1), writer.write_all(&[0; 65536]))
                .await
                .expect("EPIPE must not depend on target exit or the idle deadline")
                .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
            assert!(target.try_wait().unwrap().is_none());
            target.kill().await.unwrap();
        }

        #[tokio::test]
        async fn transferred_pipe_is_cloexec_and_last_reader_closure_is_observable() {
            let (host, helper) = UnixStream::pair().unwrap();
            let (mut writer, reader) = tokio::net::unix::pipe::pipe().unwrap();
            let reader = reader.into_blocking_fd().unwrap();
            for fd in [writer.as_raw_fd(), reader.as_raw_fd()] {
                assert_ne!(
                    unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
                    0
                );
            }
            send(&host, &reader).await.unwrap();
            drop(reader);
            let received = receive(&helper).await.unwrap();
            assert_ne!(
                unsafe { libc::fcntl(received.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
            drop(received);
            let error = tokio::time::timeout(Duration::from_secs(1), writer.write_all(&[0; 65536]))
                .await
                .expect("closing the only reader must wake the writer")
                .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
        }
    }
}

/// Reset the deadline after each successful write; slow but progressing input
/// is allowed. A retained reader must not block a command with no wall timeout.
#[cfg(any(target_os = "linux", test))]
pub(crate) async fn write_stdin<W: AsyncWrite + Unpin>(
    writer: &mut W,
    mut payload: &[u8],
    idle_timeout: Duration,
) -> io::Result<()> {
    while !payload.is_empty() {
        let written = tokio::time::timeout(idle_timeout, writer.write(payload))
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "sandbox stdin made no progress")
            })??;
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "sandbox stdin closed during write",
            ));
        }
        payload = &payload[written..];
    }
    Ok(())
}

/// Copy one accepted stream to an already-connected fixed Unix endpoint.
/// No target-supplied address participates in routing.
#[cfg(any(target_os = "linux", test))]
async fn relay<S: AsyncRead + AsyncWrite + Unpin>(
    mut client: S,
    mut upstream: UnixStream,
) -> io::Result<()> {
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

/// Applied after all inherited/caller environment values.
pub fn relay_environment(port: u16) -> [(String, String); 8] {
    let proxy = format!("http://127.0.0.1:{port}");
    [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ]
    .map(|name| {
        (
            name.into(),
            if name.eq_ignore_ascii_case("no_proxy") {
                String::new()
            } else {
                proxy.clone()
            },
        )
    })
}

#[cfg(target_os = "linux")]
mod supervisor {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::process::CommandExt;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::signal::unix::{signal, SignalKind};
    use tokio::task::JoinSet;

    fn verify_loopback_up() -> io::Result<()> {
        // getifaddrs may use AF_NETLINK. Query the flags over an IPv4 socket,
        // which is explicitly permitted by the supervisor seccomp layer.
        let raw = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        let fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(raw) };
        let mut request: libc::ifreq = unsafe { std::mem::zeroed() };
        request.ifr_name[0] = b'l' as libc::c_char;
        request.ifr_name[1] = b'o' as libc::c_char;
        if unsafe { libc::ioctl(fd.as_raw_fd(), libc::SIOCGIFFLAGS as _, &mut request) } < 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { request.ifr_ifru.ifru_flags } & libc::IFF_UP as i16 == 0 {
            return Err(protocol_error("namespace loopback is not up"));
        }
        Ok(())
    }

    async fn serve(listener: TcpListener) -> io::Result<()> {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept(), if connections.len() < 128 => {
                    let (client, _) = accepted?;
                    connections.spawn(async move {
                        let upstream = tokio::time::timeout(HANDSHAKE_TIMEOUT, UnixStream::connect(PROXY_PATH))
                            .await.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "proxy connect timed out"))??;
                        relay(client, upstream).await
                    });
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        // Dropping JoinSet aborts every live relay, closing both socket ends.
    }

    async fn probe(port: u16) -> io::Result<()> {
        let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await?;
        // Invalid HTTP reaches the shared filtering proxy without DNS or any
        // external request. This also proves real loopback TCP connectivity.
        stream.write_all(b"INVALID\r\n\r\n").await?;
        let mut response = [0; 12];
        stream.read_exact(&mut response).await?;
        if &response != b"HTTP/1.1 400" {
            return Err(protocol_error("Linux bridge end-to-end probe failed"));
        }
        Ok(())
    }

    /// Mark everything except stdio close-on-exec, including descriptors a
    /// caller might have inherited. The std Command error pipe stays usable
    /// until exec, so failed seccomp installation is reported to the parent.
    fn seal_descriptors(max_fd: i32) -> io::Result<()> {
        const CLOSE_RANGE_CLOEXEC: u32 = 4;
        if unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, CLOSE_RANGE_CLOEXEC) } == 0
        {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) {
            return Err(error);
        }
        for fd in 3..max_fd {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            if flags < 0 {
                if io::Error::last_os_error().raw_os_error() == Some(libc::EBADF) {
                    continue;
                }
                return Err(io::Error::last_os_error());
            }
            if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    fn signal_group(pid: i32, signal: i32) {
        // ESRCH is benign when the last member exited between wait and kill.
        unsafe {
            libc::kill(-pid, signal);
        }
    }

    fn release_supervisor_stdin() -> io::Result<()> {
        // Keep fd 0 occupied so a later relay socket cannot reuse it. The
        // target's stdin descriptor is transferred separately, never through
        // bwrap or its fallback init process.
        let null = std::fs::File::open("/dev/null")?;
        if null.as_raw_fd() == libc::STDIN_FILENO {
            use std::os::fd::IntoRawFd;
            let _ = null.into_raw_fd();
            return Ok(());
        }
        if unsafe { libc::dup2(null.as_raw_fd(), libc::STDIN_FILENO) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn protect_supervisor() -> io::Result<()> {
        // The target has the same UID. Deny procfs memory/fd introspection of
        // this process after the host has pinned its namespace and sent stdin.
        if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub async fn run(target: Vec<String>) -> io::Result<i32> {
        let (program, args) = target
            .split_first()
            .ok_or_else(|| protocol_error("missing bridge target"))?;
        // As namespace init (or subreaper on older bwrap), collect orphaned
        // descendants through the same waitpid path as the direct target.
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut term = signal(SignalKind::terminate())?;
        let mut interrupt = signal(SignalKind::interrupt())?;
        let mut hangup = signal(SignalKind::hangup())?;
        let filter =
            crate::seccomp::build_allowlist_target_filter().map_err(protocol_error_owned)?;
        let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let max_fd = limit.rlim_max.min(i32::MAX as libc::rlim_t) as i32;
        verify_loopback_up()?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let relay_task = tokio::spawn(serve(listener));
        let setup = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            probe(port).await?;
            let mut control = UnixStream::connect(CONTROL_PATH).await?;
            helper_exchange(&mut control).await?;
            let stdin = descriptors::receive(&control).await?;
            Ok::<_, io::Error>((control, stdin))
        })
        .await;
        let (mut control, stdin) = match setup {
            Ok(Ok(ready)) => ready,
            failed => {
                relay_task.abort();
                let _ = relay_task.await;
                return match failed {
                    Ok(Err(error)) => Err(error),
                    _ => Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Linux bridge setup timed out",
                    )),
                };
            }
        };
        let mut command = std::process::Command::new(program);
        command
            .args(args)
            .envs(relay_environment(port))
            .stdin(std::process::Stdio::from(stdin));
        release_supervisor_stdin()?;
        if let Err(error) = protect_supervisor() {
            relay_task.abort();
            let _ = relay_task.await;
            return Err(error);
        }
        // No Rust application code runs after a bare fork. Command's pre-exec
        // closure performs only allocation-free syscalls over prebuilt state.
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                seal_descriptors(max_fd)?;
                crate::seccomp::install_target_filter(&filter)
            });
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                relay_task.abort();
                let _ = relay_task.await;
                return Err(error);
            }
        };
        // Command owns the parent's copy of the transferred read end even
        // after spawn. Drop it before Started so only the target retains it.
        drop(command);
        let pid = child.id() as i32;
        // std Child has no background reaper; waitpid below is the sole owner.
        drop(child);
        let startup_error =
            match tokio::time::timeout(HANDSHAKE_TIMEOUT, helper_started(&mut control)).await {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error),
                Err(_) => Some(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Linux bridge startup acknowledgement timed out",
                )),
            };
        if startup_error.is_some() {
            signal_group(pid, libc::SIGKILL);
        }
        let mut exit_code = None;
        let mut deadline = startup_error.as_ref().map(|_| tokio::time::Instant::now());
        let mut hard_deadline = None;
        let mut control_closed = false;
        let mut control_byte = [0];
        let mut tick = tokio::time::interval(Duration::from_millis(10));
        loop {
            tokio::select! {
                _ = control.read(&mut control_byte), if !control_closed => {
                    control_closed = true;
                    signal_group(pid, libc::SIGKILL);
                    deadline = Some(tokio::time::Instant::now());
                }
                _ = term.recv() => { signal_group(pid, libc::SIGTERM); deadline.get_or_insert(tokio::time::Instant::now() + Duration::from_secs(2)); }
                _ = interrupt.recv() => { signal_group(pid, libc::SIGINT); deadline.get_or_insert(tokio::time::Instant::now() + Duration::from_secs(2)); }
                _ = hangup.recv() => { signal_group(pid, libc::SIGHUP); deadline.get_or_insert(tokio::time::Instant::now() + Duration::from_secs(2)); }
                _ = tick.tick() => {}
            }
            if relay_task.is_finished()
                || deadline.is_some_and(|end| tokio::time::Instant::now() >= end)
            {
                signal_group(pid, libc::SIGKILL);
                hard_deadline.get_or_insert(tokio::time::Instant::now() + Duration::from_secs(1));
            }
            loop {
                let mut status = 0;
                let reaped = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
                if reaped == pid {
                    exit_code = Some(if libc::WIFEXITED(status) {
                        libc::WEXITSTATUS(status)
                    } else {
                        128 + libc::WTERMSIG(status)
                    });
                    signal_group(pid, libc::SIGKILL);
                }
                if reaped <= 0 {
                    break;
                }
            }
            if exit_code.is_some()
                || hard_deadline.is_some_and(|end| tokio::time::Instant::now() >= end)
            {
                let code = exit_code.unwrap_or(128 + libc::SIGKILL);
                relay_task.abort();
                let _ = relay_task.await;
                // Namespace init exiting also destroys descendants that
                // deliberately escaped the target's process group.
                return match startup_error {
                    Some(error) => Err(error),
                    None => Ok(code),
                };
            }
        }
    }

    fn protocol_error_owned(message: String) -> io::Error {
        protocol_error(&message)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn supervisor_becomes_nondumpable_and_prctl_failure_is_reported() {
            const FIXTURE: &str = "COGNIA_DUMPABLE_FIXTURE";
            if let Some(mode) = std::env::var_os(FIXTURE) {
                assert_eq!(unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 1, 0, 0, 0) }, 0);
                if mode == "failure" {
                    let filter: seccompiler::BpfProgram = seccompiler::SeccompFilter::new(
                        [(libc::SYS_prctl, vec![])].into_iter().collect(),
                        seccompiler::SeccompAction::Allow,
                        seccompiler::SeccompAction::Errno(libc::EPERM as u32),
                        std::env::consts::ARCH.try_into().unwrap(),
                    )
                    .unwrap()
                    .try_into()
                    .unwrap();
                    crate::seccomp::install_target_filter(&filter).unwrap();
                    assert_eq!(
                        protect_supervisor().unwrap_err().raw_os_error(),
                        Some(libc::EPERM)
                    );
                } else {
                    protect_supervisor().unwrap();
                    assert_eq!(unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) }, 0);
                }
                return;
            }
            for mode in ["success", "failure"] {
                assert!(std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "net_bridge::supervisor::tests::supervisor_becomes_nondumpable_and_prctl_failure_is_reported"])
                    .env(FIXTURE, mode).status().unwrap().success());
            }
        }

        #[test]
        fn target_closed_stdin_is_not_kept_alive_by_supervisor() {
            use std::io::{BufRead, Read, Write};
            use std::process::Stdio;
            const FIXTURE: &str = "COGNIA_BRIDGE_STDIN_CLOSE_FIXTURE";
            if std::env::var_os(FIXTURE).is_some() {
                // Run in an isolated test process so closing fd 0 cannot
                // disturb parallel tests in the main test runner.
                let mut target = std::process::Command::new("/bin/sh")
                    .args(["-c", "exec 0<&-; printf ready; sleep 0.2"])
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap();
                release_supervisor_stdin().unwrap();
                let mut ready = [0; 5];
                target
                    .stdout
                    .take()
                    .unwrap()
                    .read_exact(&mut ready)
                    .unwrap();
                assert_eq!(&ready, b"ready");
                println!("BRIDGE_STDIN_CLOSED");
                std::io::stdout().flush().unwrap();
                assert!(target.wait().unwrap().success());
                return;
            }
            let mut helper = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "net_bridge::supervisor::tests::target_closed_stdin_is_not_kept_alive_by_supervisor", "--nocapture"])
                .env(FIXTURE, "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn().unwrap();
            let mut output = std::io::BufReader::new(helper.stdout.take().unwrap());
            loop {
                let mut line = String::new();
                assert_ne!(
                    output.read_line(&mut line).unwrap(),
                    0,
                    "helper did not close stdin"
                );
                if line.trim().ends_with("BRIDGE_STDIN_CLOSED") {
                    break;
                }
            }
            let error = helper
                .stdin
                .take()
                .unwrap()
                .write_all(b"payload")
                .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
            assert!(helper.wait().unwrap().success());
        }

        #[test]
        fn termination_is_forwarded_to_the_target_process_group() {
            use std::os::unix::process::ExitStatusExt;
            let mut command = std::process::Command::new("/bin/sleep");
            command.arg("30").process_group(0);
            let mut child = command.spawn().unwrap();
            signal_group(child.id() as i32, libc::SIGTERM);
            assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGTERM));
        }

        #[test]
        fn target_setup_is_confined_to_child_and_seals_inherited_fds() {
            let fd = std::fs::File::open("/dev/null").unwrap();
            let raw = fd.as_raw_fd();
            unsafe {
                libc::fcntl(raw, libc::F_SETFD, 0);
            }
            let mut child = std::process::Command::new("/bin/sh");
            child.args(["-c", &format!("test ! -e /proc/self/fd/{raw}")]);
            unsafe {
                child.pre_exec(|| seal_descriptors(1024));
            }
            assert!(child.status().unwrap().success());
            assert_eq!(unsafe { libc::fcntl(raw, libc::F_GETFD) }, 0);
            unsafe {
                libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC);
            }
        }
    }
}

/// Invoked before the launcher's ordinary argument parser or runtime startup.
#[cfg(target_os = "linux")]
pub fn run_helper(target: Vec<String>) -> io::Result<i32> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(supervisor::run(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn foreign_control_peer_is_rejected_before_real_peer_completes() {
        const FIXTURE: &str = "COGNIA_CONTROL_PEER_FIXTURE";
        if let Some(path) = std::env::var_os(FIXTURE) {
            let mut stream = UnixStream::connect(path).await.unwrap();
            helper_exchange(&mut stream).await.unwrap();
            let stdin = descriptors::receive(&stream).await.unwrap();
            let mut stdin = tokio::fs::File::from_std(std::fs::File::from(stdin));
            let mut payload = String::new();
            stdin.read_to_string(&mut payload).await.unwrap();
            assert_eq!(payload, "only-the-real-peer");
            helper_started(&mut stream).await.unwrap();
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.sock");
        let listener = UnixListener::bind(&path).unwrap();
        // Queue a foreign connection first, without even sending Ready.
        let mut foreign = UnixStream::connect(&path).await.unwrap();
        let mut real = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "net_bridge::tests::foreign_control_peer_is_rejected_before_real_peer_completes",
            ])
            .env(FIXTURE, &path)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let real_pid = real.id().unwrap() as i32;
        let input_path = directory.path().join("stdin");
        std::fs::write(&input_path, "only-the-real-peer").unwrap();
        let input = std::fs::File::open(input_path).unwrap().into();
        let mut rejected = 0;
        let control = host_handshake(&listener, input, |peer| {
            if peer.peer_cred()?.pid() != Some(real_pid) {
                rejected += 1;
                return Err(io::Error::other("foreign peer"));
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(rejected, 1);
        let mut bytes = Vec::new();
        foreign.read_to_end(&mut bytes).await.unwrap();
        assert!(
            bytes.is_empty(),
            "foreign peer received Go or an fd payload"
        );
        assert!(tokio::time::timeout(HANDSHAKE_TIMEOUT, real.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
        drop(control);
    }

    #[tokio::test]
    async fn ready_go_exchange_and_version_mismatch() {
        let (mut host, mut helper) = tokio::io::duplex(128);
        let (host_result, helper_result) =
            tokio::join!(host_exchange(&mut host, |_| Ok(())), async {
                helper_exchange(&mut helper).await?;
                helper_started(&mut helper).await
            });
        host_result.unwrap();
        helper_result.unwrap();
        let (mut host, mut helper) = tokio::io::duplex(128);
        helper.write_all(b"COGNIA_EGRESS_READY 0\n").await.unwrap();
        assert_eq!(
            host_exchange(&mut host, |_| Ok(()))
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[tokio::test]
    async fn stalled_stdin_without_command_timeout_returns_an_error() {
        let (mut writer, _retained_reader) = tokio::io::duplex(8);
        let error = tokio::time::timeout(
            Duration::from_secs(1),
            write_stdin(&mut writer, &[0; 64], Duration::from_millis(20)),
        )
        .await
        .expect("stdin idle deadline must bound a retained reader")
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn stdin_progress_resets_the_idle_deadline() {
        let (mut writer, mut reader) = tokio::io::duplex(1);
        let payload = vec![42; 5];
        let consume = tokio::spawn(async move {
            let mut received = Vec::new();
            for _ in 0..5 {
                tokio::time::sleep(Duration::from_millis(15)).await;
                received.push(reader.read_u8().await.unwrap());
            }
            received
        });
        write_stdin(&mut writer, &payload, Duration::from_millis(50))
            .await
            .unwrap();
        assert_eq!(consume.await.unwrap(), payload);
    }

    #[tokio::test]
    async fn failed_namespace_guard_never_sends_go() {
        let (mut host, mut helper) = tokio::io::duplex(128);
        helper.write_all(READY).await.unwrap();
        let error = host_exchange(&mut host, |_| {
            Err(io::Error::other("cannot pin namespace init"))
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("cannot pin namespace init"));
        drop(host);
        let mut bytes = Vec::new();
        helper.read_to_end(&mut bytes).await.unwrap();
        assert!(
            bytes.is_empty(),
            "Go must follow a successful namespace guard"
        );
    }

    #[tokio::test]
    async fn eof_and_timeout_never_release_target() {
        let (mut host, helper) = tokio::io::duplex(128);
        drop(helper);
        assert_eq!(
            host_exchange(&mut host, |_| Ok(()))
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
        let (mut host, _helper) = tokio::io::duplex(128);
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            host_exchange(&mut host, |_| Ok(()))
        )
        .await
        .is_err());
        let (host, mut helper) = tokio::io::duplex(128);
        drop(host);
        assert!(helper_exchange(&mut helper).await.is_err());
    }

    #[tokio::test]
    async fn ready_alone_does_not_release_helper_and_wrong_go_is_refused() {
        let (mut host, mut helper) = tokio::io::duplex(128);
        let task = tokio::spawn(async move { helper_exchange(&mut helper).await });
        expect_frame(&mut host, READY).await.unwrap();
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        host.write_all(b"COGNIA_EGRESS_GO 0\n").await.unwrap();
        assert_eq!(
            task.await.unwrap().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let (_host, mut helper) = tokio::io::duplex(128);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), helper_exchange(&mut helper))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn host_refuses_eof_after_go_without_installed_filter_acknowledgement() {
        let (mut host, mut helper) = tokio::io::duplex(128);
        let task = tokio::spawn(async move { host_exchange(&mut host, |_| Ok(())).await });
        helper_exchange(&mut helper).await.unwrap();
        assert!(!task.is_finished());
        drop(helper);
        assert_eq!(
            task.await.unwrap().unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn relay_environment_overrides_every_proxy_and_bypass_variable() {
        let mut env: std::collections::BTreeMap<_, _> = [
            ("HTTP_PROXY".to_string(), "http://attacker".to_string()),
            ("NO_PROXY".to_string(), "*".to_string()),
            ("no_proxy".to_string(), "localhost".to_string()),
        ]
        .into_iter()
        .collect();
        env.extend(relay_environment(1234));
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            assert_eq!(env[key], "http://127.0.0.1:1234");
        }
        assert!(env["NO_PROXY"].is_empty());
        assert!(env["no_proxy"].is_empty());
    }

    #[tokio::test]
    async fn unix_socketpair_relay_preserves_bytes_and_shutdown() {
        let (mut peer, upstream) = UnixStream::pair().unwrap();
        let (mut client, relay_side) = tokio::io::duplex(64);
        let task = tokio::spawn(relay(relay_side, upstream));
        client.write_all(b"request").await.unwrap();
        let mut request = [0; 7];
        peer.read_exact(&mut request).await.unwrap();
        assert_eq!(&request, b"request");
        peer.write_all(b"reply").await.unwrap();
        let mut response = [0; 5];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"reply");
        client.shutdown().await.unwrap();
        peer.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn cancelled_relay_closes_upstream() {
        let (mut peer, upstream) = UnixStream::pair().unwrap();
        let (_client, relay_side) = tokio::io::duplex(64);
        let task = tokio::spawn(relay(relay_side, upstream));
        task.abort();
        let _ = task.await;
        assert_eq!(peer.read(&mut [0]).await.unwrap(), 0);
    }
}
