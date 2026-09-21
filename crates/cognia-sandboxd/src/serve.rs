//! Persistent sandbox supervision over a private Unix socket.
//!
//! Every session runs its own init-agent process in a new POSIX session. Its
//! stdio travels in bounded frames; blocking writes propagate backpressure
//! to the child's pipes. There is no event ring or polling cursor that can
//! lose an ACP frame. Only the supervisor's uid can open the control plane.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use signal_hook::consts::signal::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

use crate::env::{LifecyclePhase, RuntimeConfigV1};
use crate::passwd::UserSpec;

const FRAME_BYTES: usize = 64 * 1024;
const REQUEST_BYTES: usize = 32 * 1024 * 1024;
const REQUEST: u8 = 1;
const REQUEST_END: u8 = 2;
const STDIN: u8 = 3;
const STDIN_EOF: u8 = 4;
const STDOUT: u8 = 5;
const STDERR: u8 = 6;
const EXIT: u8 = 7;
const ERROR: u8 = 8;
const REPLY: u8 = 9;
const MAX_SESSIONS: usize = 64;
static NEXT_FILE: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    Connect {
        session: String,
        argv: Vec<String>,
        runtime: Box<RuntimeConfigV1>,
        #[serde(default)]
        lease_seconds: Option<u64>,
    },
    Renew {
        session: String,
    },
    Signal {
        session: String,
        signal: i32,
    },
    Health,
    Port {
        port: u16,
    },
}

pub struct ServeOptions {
    pub socket: PathBuf,
    pub state_dir: PathBuf,
    pub runtime_key: String,
    pub idle_timeout_secs: u64,
    pub forward_ports: Vec<u16>,
    pub root: PathBuf,
    pub bundle: PathBuf,
    pub user: Option<UserSpec>,
    pub match_owner_of: Option<String>,
    pub runtime: RuntimeConfigV1,
    pub image_env: BTreeMap<String, String>,
    /// Normally the running sandboxd binary; injectable for subprocess tests.
    pub executable: PathBuf,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn effective_uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn write_frame(stream: &mut impl Write, kind: u8, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > FRAME_BYTES {
        return Err(invalid("frame too large"));
    }
    stream.write_all(&[kind])?;
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(bytes)
}

fn read_frame(stream: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut kind = [0; 1];
    loop {
        match stream.read(&mut kind) {
            Ok(0) => return Ok(None),
            Ok(1) => break,
            Ok(_) => unreachable!(),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    let mut size = [0; 4];
    stream.read_exact(&mut size)?;
    let size = u32::from_be_bytes(size) as usize;
    if size > FRAME_BYTES {
        return Err(invalid("frame too large"));
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes)?;
    Ok(Some((kind[0], bytes)))
}

fn send_request(stream: &mut UnixStream, request: &Request) -> io::Result<()> {
    let bytes = serde_json::to_vec(request).map_err(|_| invalid("cannot encode request"))?;
    if bytes.len() > REQUEST_BYTES {
        return Err(invalid("request too large"));
    }
    for chunk in bytes.chunks(FRAME_BYTES) {
        write_frame(stream, REQUEST, chunk)?;
    }
    write_frame(stream, REQUEST_END, &[])
}

fn receive_request(stream: &mut UnixStream) -> io::Result<Request> {
    let mut bytes = Vec::new();
    loop {
        match read_frame(stream)? {
            Some((REQUEST, chunk)) if bytes.len() + chunk.len() <= REQUEST_BYTES => {
                bytes.extend(chunk)
            }
            Some((REQUEST_END, empty)) if empty.is_empty() => break,
            _ => return Err(invalid("invalid request framing")),
        }
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid("invalid request document"))
}

fn check_peer(stream: &UnixStream) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    let uid = {
        let mut credential: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credential as *mut libc::ucred).cast(),
                &mut length,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        credential.uid
    };
    #[cfg(not(target_os = "linux"))]
    let uid = {
        let (mut uid, mut gid) = (0, 0);
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
        uid
    };
    if uid != effective_uid() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "control peer is not supervisor owner",
        ));
    }
    Ok(())
}

fn private_directory(path: &Path) -> io::Result<File> {
    match fs::create_dir(path) {
        Ok(()) => fs::set_permissions(path, fs::Permissions::from_mode(0o700))?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = directory.metadata()?;
    if metadata.uid() != effective_uid() || metadata.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "control directory is not private",
        ));
    }
    Ok(directory)
}

fn marker_exists(directory: &File, key: &str) -> io::Result<bool> {
    let name = std::ffi::CString::new(format!("{key}.json"))
        .map_err(|_| invalid("invalid runtime key"))?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::NotFound {
            Ok(false)
        } else {
            Err(error)
        };
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != effective_uid() || metadata.mode() & 0o077 != 0 {
        return Err(invalid("invalid creation marker"));
    }
    let mut value = String::new();
    file.take(257).read_to_string(&mut value)?;
    let expected = serde_json::json!({"version": 1, "runtimeKey": key});
    Ok(serde_json::from_str::<serde_json::Value>(&value)
        .ok()
        .as_ref()
        == Some(&expected))
}

fn record_marker(directory: &File, key: &str) -> io::Result<()> {
    let temporary = format!(
        ".{}-{}",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    );
    let temp = std::ffi::CString::new(temporary).unwrap();
    let contents =
        serde_json::to_vec(&serde_json::json!({"version": 1, "runtimeKey": key})).unwrap();
    let key = std::ffi::CString::new(format!("{key}.json"))
        .map_err(|_| invalid("invalid runtime key"))?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            temp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(&contents)?;
        file.sync_all()?;
        if unsafe {
            libc::renameat(
                directory.as_raw_fd(),
                temp.as_ptr(),
                directory.as_raw_fd(),
                key.as_ptr(),
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        directory.sync_all()
    })();
    if result.is_err() {
        unsafe {
            libc::unlinkat(directory.as_raw_fd(), temp.as_ptr(), 0);
        }
    }
    result
}

fn spawn_worker(
    options: &ServeOptions,
    runtime: &RuntimeConfigV1,
    argv: &[String],
    piped: bool,
) -> io::Result<(Child, PathBuf)> {
    let path = options
        .socket
        .parent()
        .ok_or_else(|| invalid("socket has no parent"))?
        .join(format!(
            "session-{}-{}.json",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    let result = (|| {
        serde_json::to_writer(&mut file, runtime).map_err(|_| invalid("cannot encode runtime"))?;
        file.flush()?;
        let mut command = Command::new(&options.executable);
        command
            .arg("init-agent")
            .arg("--root")
            .arg(&options.root)
            .arg("--bundle")
            .arg(&options.bundle)
            .arg("--runtime-config")
            .arg(&path);
        if let Some(user) = &options.user {
            command.arg("--user").arg(user.to_string());
        }
        if let Some(owner) = &options.match_owner_of {
            command.arg("--match-owner-of").arg(owner);
        }
        command
            .arg("--")
            .args(argv)
            .env_clear()
            .envs(&options.image_env);
        if piped {
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        } else {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit());
        }
        // All descendants retain this session id even when init-agent puts
        // commands in separate groups for cancellation. Cleanup uses the sid,
        // never a stale process-group id that another session might reuse.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        command.spawn()
    })();
    match result {
        Ok(child) => Ok((child, path)),
        Err(error) => {
            let _ = fs::remove_file(path);
            Err(error)
        }
    }
}

#[cfg(target_os = "linux")]
fn process_ids() -> io::Result<Vec<i32>> {
    Ok(fs::read_dir("/proc")?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
        .collect())
}

#[cfg(target_os = "macos")]
fn process_ids() -> io::Result<Vec<i32>> {
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_listallpids(buffer: *mut libc::c_void, buffersize: libc::c_int) -> libc::c_int;
    }
    let count = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut ids = vec![0; count as usize + 256];
    let count = unsafe {
        proc_listallpids(
            ids.as_mut_ptr().cast(),
            (ids.len() * std::mem::size_of::<i32>()) as i32,
        )
    };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    ids.truncate(count as usize);
    Ok(ids)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_ids() -> io::Result<Vec<i32>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "persistent sessions require Linux or macOS process enumeration",
    ))
}

fn cleanup_session(session: i32) {
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        let mut found = false;
        if let Ok(pids) = process_ids() {
            for pid in pids {
                if pid > 0 && unsafe { libc::getsid(pid) } == session {
                    found = true;
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                        libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG);
                    }
                }
            }
        }
        if !found || Instant::now() >= until {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn same_environment(base: &RuntimeConfigV1, requested: &RuntimeConfigV1) -> bool {
    base.container_env == requested.container_env
        && base.remote_env == requested.remote_env
        && base.workspace_folder == requested.workspace_folder
        && base.lifecycle_commands == requested.lifecycle_commands
        && base.lifecycle_timeout_ms == requested.lifecycle_timeout_ms
}

struct SessionLease {
    duration: Duration,
    deadline: Instant,
    expired_at: Option<Instant>,
    stream: UnixStream,
}

struct Session {
    pid: i32,
    lease: Option<SessionLease>,
}

type Sessions = Arc<Mutex<BTreeMap<String, Session>>>;

/// Docker can keep an exec process alive after its host client disappears.
/// Only authenticated root control requests renew this server-owned deadline.
fn expire_leases(sessions: &Sessions) {
    let now = Instant::now();
    for session in sessions.lock().unwrap().values_mut() {
        let Some(lease) = &mut session.lease else {
            continue;
        };
        if now < lease.deadline {
            continue;
        }
        let signal = match lease.expired_at {
            None => {
                lease.expired_at = Some(now);
                let _ = lease.stream.shutdown(std::net::Shutdown::Both);
                libc::SIGTERM
            }
            Some(expired) if now.duration_since(expired) >= Duration::from_secs(5) => libc::SIGKILL,
            Some(_) => continue,
        };
        // Keep registration locked through the signal so expiry cannot address
        // a later adoption of the same session id.
        unsafe {
            libc::kill(session.pid, signal);
        }
    }
}
type IdleClock = Arc<Mutex<Instant>>;

struct ActiveSession {
    id: String,
    sessions: Sessions,
    idle: IdleClock,
}
impl Drop for ActiveSession {
    fn drop(&mut self) {
        self.sessions.lock().unwrap().remove(&self.id);
        *self.idle.lock().unwrap() = Instant::now();
    }
}

fn output_pump(
    mut source: impl Read + Send + 'static,
    output: Arc<Mutex<UnixStream>>,
    kind: u8,
    pid: i32,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut bytes = [0; FRAME_BYTES];
        loop {
            match source.read(&mut bytes) {
                Ok(0) => break,
                Ok(size) => {
                    if write_frame(&mut *output.lock().unwrap(), kind, &bytes[..size]).is_err() {
                        unsafe {
                            libc::kill(pid, SIGTERM);
                        }
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    unsafe {
                        libc::kill(pid, SIGTERM);
                    }
                    break;
                }
            }
        }
    })
}

// A pipe write can block when an agent stops reading stdin. Observe socket
// hangup independently so backpressure cannot prevent disconnect cleanup.
fn watch_disconnect(
    stream: UnixStream,
    finished: Arc<AtomicBool>,
    on_disconnect: impl FnOnce() + Send + 'static,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        #[cfg(not(target_os = "linux"))]
        {
            let fd = unsafe { libc::kqueue() };
            if fd < 0 {
                on_disconnect();
                return;
            }
            let queue = unsafe { File::from_raw_fd(fd) };
            unsafe {
                libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            }
            let event = libc::kevent {
                ident: stream.as_raw_fd() as _,
                filter: libc::EVFILT_READ,
                flags: libc::EV_ADD | libc::EV_CLEAR,
                fflags: 0,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            if unsafe {
                libc::kevent(
                    queue.as_raw_fd(),
                    &event,
                    1,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null(),
                )
            } < 0
            {
                on_disconnect();
                return;
            }
            while !finished.load(Ordering::Acquire) {
                let mut event: libc::kevent = unsafe { std::mem::zeroed() };
                let timeout = libc::timespec {
                    tv_sec: 0,
                    tv_nsec: 100_000_000,
                };
                let result = unsafe {
                    libc::kevent(
                        queue.as_raw_fd(),
                        std::ptr::null(),
                        0,
                        &mut event,
                        1,
                        &timeout,
                    )
                };
                if result > 0 && event.flags & (libc::EV_EOF | libc::EV_ERROR) != 0 {
                    if !finished.load(Ordering::Acquire) {
                        on_disconnect();
                    }
                    break;
                }
                if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    on_disconnect();
                    break;
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            let events = libc::POLLRDHUP;
            let mut descriptor = libc::pollfd {
                fd: stream.as_raw_fd(),
                events,
                revents: 0,
            };
            while !finished.load(Ordering::Acquire) {
                let result = unsafe { libc::poll(&mut descriptor, 1, 100) };
                if result > 0 && descriptor.revents != 0 {
                    if !finished.load(Ordering::Acquire) {
                        on_disconnect();
                    }
                    break;
                }
                if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    break;
                }
            }
        }
    })
}

fn handle_connection(
    mut stream: UnixStream,
    options: Arc<ServeOptions>,
    sessions: Sessions,
    idle: IdleClock,
) -> io::Result<()> {
    check_peer(&stream)?;
    // BSD/macOS inherit O_NONBLOCK from the listening socket. Framed streams
    // intentionally block so pipe and socket pressure reaches the producer.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let request = receive_request(&mut stream)?;
    stream.set_read_timeout(None)?;
    match request {
        Request::Health => {
            let active = sessions.lock().unwrap();
            let value = serde_json::json!({"ready":true,"runtimeKey":options.runtime_key,"activeSessions":active.keys().filter(|id| !id.starts_with("@port:")).count(),"activeConnections":active.len()});
            write_frame(&mut stream, REPLY, &serde_json::to_vec(&value).unwrap())
        }
        Request::Signal { session, signal } => {
            if !matches!(signal, libc::SIGTERM | libc::SIGINT | libc::SIGKILL) {
                return Err(invalid("unsupported session signal"));
            }
            let pid = sessions
                .lock()
                .unwrap()
                .get(&session)
                .map(|session| session.pid);
            let Some(pid) = pid.filter(|pid| *pid > 0) else {
                return write_frame(&mut stream, REPLY, br#"{"existed":false}"#);
            };
            if unsafe { libc::kill(pid, signal) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
                return write_frame(&mut stream, REPLY, br#"{"existed":false}"#);
            }
            write_frame(&mut stream, REPLY, br#"{"existed":true}"#)
        }
        Request::Renew { session } => {
            let mut active = sessions.lock().unwrap();
            let lease = active
                .get_mut(&session)
                .and_then(|session| session.lease.as_mut())
                .ok_or_else(|| invalid("session has no renewable lease"))?;
            let now = Instant::now();
            if lease.expired_at.is_some() || now >= lease.deadline {
                return Err(invalid("session lease has expired"));
            }
            lease.deadline = now + lease.duration;
            write_frame(&mut stream, REPLY, b"{}")
        }
        Request::Port { port } => {
            if port == 0 || !options.forward_ports.contains(&port) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "port is not authorized",
                ));
            }
            let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
            let mut tcp = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
            let id = format!("@port:{}", NEXT_FILE.fetch_add(1, Ordering::Relaxed));
            let mut active = sessions.lock().unwrap();
            if active.len() >= MAX_SESSIONS {
                return Err(io::Error::other("connection capacity reached"));
            }
            active.insert(
                id.clone(),
                Session {
                    pid: 0,
                    lease: None,
                },
            );
            drop(active);
            let _active = ActiveSession { id, sessions, idle };
            let mut tcp_write = tcp.try_clone()?;
            let mut input = stream.try_clone()?;
            let finished = Arc::new(AtomicBool::new(false));
            let tcp_disconnect = tcp.try_clone()?;
            let disconnect =
                watch_disconnect(stream.try_clone()?, Arc::clone(&finished), move || {
                    let _ = tcp_disconnect.shutdown(std::net::Shutdown::Both);
                });
            let incoming = thread::spawn(move || {
                loop {
                    match read_frame(&mut input) {
                        Ok(Some((STDIN, bytes))) => {
                            if tcp_write.write_all(&bytes).is_err() {
                                break;
                            }
                        }
                        Ok(Some((STDIN_EOF, bytes))) if bytes.is_empty() => {
                            let _ = tcp_write.shutdown(std::net::Shutdown::Write);
                            // Keep observing a disconnected client, even after
                            // its TCP write half was explicitly closed.
                            continue;
                        }
                        _ => break,
                    }
                }
                let _ = tcp_write.shutdown(std::net::Shutdown::Both);
            });
            let result = (|| {
                let mut bytes = [0; FRAME_BYTES];
                loop {
                    let count = tcp.read(&mut bytes)?;
                    if count == 0 {
                        break;
                    }
                    write_frame(&mut stream, STDOUT, &bytes[..count])?;
                }
                write_frame(&mut stream, EXIT, &0i32.to_be_bytes())
            })();
            finished.store(true, Ordering::Release);
            let _ = stream.shutdown(std::net::Shutdown::Read);
            let _ = tcp.shutdown(std::net::Shutdown::Both);
            let _ = incoming.join();
            let _ = disconnect.join();
            result
        }
        Request::Connect {
            session,
            argv,
            mut runtime,
            lease_seconds,
        } => {
            runtime
                .validate()
                .map_err(|_| invalid("invalid session runtime"))?;
            if !same_environment(&options.runtime, &runtime) {
                return Err(invalid("session runtime does not match container"));
            }
            if session.is_empty()
                || session.starts_with("@port:")
                || session.len() > 256
                || session.chars().any(char::is_control)
                || argv.is_empty()
                || argv.len() > 256
                || argv[0].is_empty()
                || argv
                    .iter()
                    .any(|value| value.contains('\0') || value.len() > 32 * 1024)
            {
                return Err(invalid("invalid session request"));
            }
            if lease_seconds.is_some_and(|seconds| !(1..=300).contains(&seconds)) {
                return Err(invalid("session lease must be between 1 and 300 seconds"));
            }
            let lease = lease_seconds
                .map(|seconds| -> io::Result<_> {
                    let duration = Duration::from_secs(seconds);
                    Ok(SessionLease {
                        duration,
                        deadline: Instant::now() + duration,
                        expired_at: None,
                        stream: stream.try_clone()?,
                    })
                })
                .transpose()?;
            runtime.lifecycle_phases = vec![LifecyclePhase::PostAttach];
            let mut active = sessions.lock().unwrap();
            if active.len() >= MAX_SESSIONS || active.contains_key(&session) {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "session already exists or capacity reached",
                ));
            }
            let (mut child, path) = spawn_worker(&options, &runtime, &argv, true)?;
            let pid = child.id() as i32;
            active.insert(session.clone(), Session { pid, lease });
            drop(active);
            let _active = ActiveSession {
                id: session,
                sessions,
                idle,
            };
            let result = (|| {
                let writer = Arc::new(Mutex::new(stream.try_clone()?));
                let out = output_pump(
                    child.stdout.take().unwrap(),
                    Arc::clone(&writer),
                    STDOUT,
                    pid,
                );
                let err = output_pump(
                    child.stderr.take().unwrap(),
                    Arc::clone(&writer),
                    STDERR,
                    pid,
                );
                let finished = Arc::new(AtomicBool::new(false));
                let disconnect =
                    watch_disconnect(stream.try_clone()?, Arc::clone(&finished), move || unsafe {
                        libc::kill(pid, SIGTERM);
                    });
                let input_finished = Arc::clone(&finished);
                let mut input = stream.try_clone()?;
                let mut stdin = child.stdin.take();
                let input_thread = thread::spawn(move || {
                    loop {
                        match read_frame(&mut input) {
                            Ok(Some((STDIN, bytes))) => {
                                if let Some(stdin) = &mut stdin {
                                    if stdin.write_all(&bytes).is_err() {
                                        break;
                                    }
                                } else {
                                    break;
                                }
                            }
                            Ok(Some((STDIN_EOF, bytes))) if bytes.is_empty() => {
                                stdin.take();
                            }
                            _ => break,
                        }
                    }
                    if !input_finished.load(Ordering::Acquire) {
                        unsafe {
                            libc::kill(pid, SIGTERM);
                        }
                    }
                });
                let status = child.wait()?;
                finished.store(true, Ordering::Release);
                cleanup_session(pid);
                let _ = stream.shutdown(std::net::Shutdown::Read);
                let _ = input_thread.join();
                let _ = disconnect.join();
                let _ = out.join();
                let _ = err.join();
                use std::os::unix::process::ExitStatusExt;
                let code = status
                    .code()
                    .unwrap_or_else(|| 128 + status.signal().unwrap_or(1));
                let result = write_frame(&mut *writer.lock().unwrap(), EXIT, &code.to_be_bytes());
                result
            })();
            if result.is_err() {
                unsafe {
                    libc::kill(pid, SIGTERM);
                }
                let _ = child.wait();
                cleanup_session(pid);
            }
            let _ = fs::remove_file(path);
            result
        }
    }
}

fn boot_phase(
    options: &ServeOptions,
    phases: Vec<LifecyclePhase>,
    stopped: &AtomicI32,
) -> io::Result<i32> {
    let mut config = options.runtime.clone();
    config.lifecycle_phases = phases;
    let (mut child, path) = spawn_worker(
        options,
        &config,
        &["/bin/sh".into(), "-c".into(), ":".into()],
        false,
    )?;
    let pid = child.id() as i32;
    let status = loop {
        if stopped.load(Ordering::Acquire) != 0 {
            unsafe {
                libc::kill(pid, SIGTERM);
            }
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let _ = fs::remove_file(path);
    if !status.success() {
        cleanup_session(pid);
        return Err(io::Error::other("persistent lifecycle preparation failed"));
    }
    Ok(pid)
}

/// Health only answers after all required startup hooks have succeeded.
pub fn serve(mut options: ServeOptions) -> io::Result<()> {
    options
        .runtime
        .validate()
        .map_err(|_| invalid("invalid server runtime"))?;
    if options.runtime_key.len() != 64
        || !options.runtime_key.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(invalid("runtime key must be a SHA-256 digest"));
    }
    if options.idle_timeout_secs == 0
        || options.idle_timeout_secs > 86_400
        || options.forward_ports.contains(&0)
    {
        return Err(invalid("invalid idle timeout or port"));
    }
    process_ids()?; // Refuse unsupported process cleanup before accepting work.
    let parent = options
        .socket
        .parent()
        .ok_or_else(|| invalid("socket has no parent"))?;
    let _socket_directory = private_directory(parent)?;
    let state = private_directory(&options.state_dir)?;
    if let Ok(metadata) = fs::symlink_metadata(&options.socket) {
        if !metadata.file_type().is_socket() || metadata.uid() != effective_uid() {
            return Err(invalid("unexpected control socket path"));
        }
        if UnixStream::connect(&options.socket).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "supervisor already running",
            ));
        }
        fs::remove_file(&options.socket)?;
    }
    // Runtime spawn credentials belong to a connection, never the persistent
    // supervisor or startup hooks.
    options.runtime.spawn_env.clear();
    options
        .image_env
        .retain(|name, _| !name.starts_with("COGNIA_SANDBOXD_"));
    let stopped = Arc::new(AtomicI32::new(0));
    let signal_stop = Arc::clone(&stopped);
    let mut signals = Signals::new([SIGTERM, SIGINT])?;
    let signal_handle = signals.handle();
    let signal_thread = thread::spawn(move || {
        if let Some(signal) = signals.forever().next() {
            signal_stop.store(signal, Ordering::Release);
        }
    });
    let mut boot_sessions = Vec::new();
    let result = (|| {
        if !marker_exists(&state, &options.runtime_key)? {
            boot_sessions.push(boot_phase(
                &options,
                vec![
                    LifecyclePhase::OnCreate,
                    LifecyclePhase::UpdateContent,
                    LifecyclePhase::PostCreate,
                ],
                &stopped,
            )?);
            record_marker(&state, &options.runtime_key)?;
        }
        boot_sessions.push(boot_phase(
            &options,
            vec![LifecyclePhase::PostStart],
            &stopped,
        )?);
        if stopped.load(Ordering::Acquire) != 0 {
            return Ok(());
        }
        let listener = UnixListener::bind(&options.socket)?;
        fs::set_permissions(&options.socket, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let options = Arc::new(options);
        let sessions: Sessions = Arc::new(Mutex::new(BTreeMap::new()));
        let idle: IdleClock = Arc::new(Mutex::new(Instant::now()));
        let mut connections = Vec::new();
        let mut last_reap = Instant::now();
        while stopped.load(Ordering::Acquire) == 0 {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    if connections.len() >= MAX_SESSIONS * 2 {
                        let _ = write_frame(&mut stream, ERROR, b"connection capacity reached");
                        continue;
                    }
                    let close = stream.try_clone()?;
                    let options = Arc::clone(&options);
                    let sessions = Arc::clone(&sessions);
                    let idle = Arc::clone(&idle);
                    let thread = thread::spawn(move || {
                        let error_stream = stream.try_clone();
                        if let Err(error) = handle_connection(stream, options, sessions, idle) {
                            eprintln!("cognia-sandboxd: control request failed: {error}");
                            if let Ok(mut stream) = error_stream {
                                let _ =
                                    write_frame(&mut stream, ERROR, b"supervisor request failed");
                            }
                        }
                    });
                    connections.push((close, thread));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(error) => return Err(error),
            }
            let mut index = 0;
            while index < connections.len() {
                if connections[index].1.is_finished() {
                    let (_, thread) = connections.swap_remove(index);
                    let _ = thread.join();
                } else {
                    index += 1;
                }
            }
            expire_leases(&sessions);
            if last_reap.elapsed() >= Duration::from_secs(1) {
                // PID 1 adopts services started by completed lifecycle hooks.
                // Reap only children that are not owned by an active worker's
                // Child::wait; the same lock guards worker spawn/registration.
                let active = sessions.lock().unwrap();
                if let Ok(pids) = process_ids() {
                    for pid in pids {
                        if !active.values().any(|worker| worker.pid == pid) {
                            unsafe {
                                libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG);
                            }
                        }
                    }
                }
                last_reap = Instant::now();
            }
            if connections.is_empty()
                && sessions.lock().unwrap().is_empty()
                && idle.lock().unwrap().elapsed() >= Duration::from_secs(options.idle_timeout_secs)
            {
                break;
            }
        }
        for pid in sessions
            .lock()
            .unwrap()
            .values()
            .map(|session| session.pid)
            .filter(|pid| *pid > 0)
        {
            unsafe {
                libc::kill(pid, SIGTERM);
            }
        }
        for (stream, _) in &connections {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        for (_, thread) in connections {
            let _ = thread.join();
        }
        fs::remove_file(&options.socket)?;
        Ok(())
    })();
    for session in boot_sessions {
        cleanup_session(session);
    }
    signal_handle.close();
    let _ = signal_thread.join();
    result
}

pub fn health(socket: &Path) -> io::Result<serde_json::Value> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    send_request(&mut stream, &Request::Health)?;
    match read_frame(&mut stream)? {
        Some((REPLY, bytes)) => {
            serde_json::from_slice(&bytes).map_err(|_| invalid("invalid health response"))
        }
        _ => Err(invalid("supervisor is not ready")),
    }
}

pub fn signal_agent(socket: &Path, session: String, signal: i32) -> io::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    send_request(&mut stream, &Request::Signal { session, signal })?;
    match read_frame(&mut stream)? {
        Some((REPLY, _)) => Ok(()),
        _ => Err(invalid("session signal refused")),
    }
}

pub fn renew_agent(socket: &Path, session: String) -> io::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    send_request(&mut stream, &Request::Renew { session })?;
    match read_frame(&mut stream)? {
        Some((REPLY, _)) => Ok(()),
        _ => Err(invalid("session lease renewal refused")),
    }
}

/// This is a CLI pump: its stdin reader is ended by process exit after the
/// final status arrives, so a terminal left open cannot delay agent exit.
pub fn connect_agent(
    socket: &Path,
    session: String,
    argv: Vec<String>,
    runtime: RuntimeConfigV1,
) -> io::Result<i32> {
    connect_agent_with_lease(socket, session, argv, runtime, None)
}

pub fn connect_agent_with_lease(
    socket: &Path,
    session: String,
    argv: Vec<String>,
    runtime: RuntimeConfigV1,
    lease_seconds: Option<u64>,
) -> io::Result<i32> {
    runtime
        .validate()
        .map_err(|_| invalid("invalid session runtime"))?;
    let mut stream = UnixStream::connect(socket)?;
    send_request(
        &mut stream,
        &Request::Connect {
            session,
            argv,
            runtime: Box::new(runtime),
            lease_seconds,
        },
    )?;
    pump_stdio(stream)
}

pub fn connect_port(socket: &Path, port: u16) -> io::Result<i32> {
    let mut stream = UnixStream::connect(socket)?;
    send_request(&mut stream, &Request::Port { port })?;
    pump_stdio(stream)
}

/// An explicit Host-authorized Docker exec path for ephemeral containers.
/// This never runs as a fallback after a supervisor rejected a port.
pub fn connect_port_direct(port: u16) -> io::Result<i32> {
    if port == 0 {
        return Err(invalid("invalid port"));
    }
    let mut tcp = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(5),
    )?;
    let mut writer = tcp.try_clone()?;
    thread::spawn(move || {
        let result = io::copy(&mut io::stdin().lock(), &mut writer);
        let _ = writer.shutdown(if result.is_ok() {
            std::net::Shutdown::Write
        } else {
            std::net::Shutdown::Both
        });
    });
    io::copy(&mut tcp, &mut io::stdout().lock())?;
    Ok(0)
}

fn pump_stdio(mut stream: UnixStream) -> io::Result<i32> {
    let mut input_stream = stream.try_clone()?;
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut bytes = [0; FRAME_BYTES];
        loop {
            match input.read(&mut bytes) {
                Ok(0) => {
                    let _ = write_frame(&mut input_stream, STDIN_EOF, &[]);
                    break;
                }
                Ok(count) => {
                    if write_frame(&mut input_stream, STDIN, &bytes[..count]).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    let _ = input_stream.shutdown(std::net::Shutdown::Both);
                    break;
                }
            }
        }
        // Keep the connection's write half open after an explicit stdin EOF:
        // the server must distinguish EOF from a disconnected Docker exec.
    });
    loop {
        match read_frame(&mut stream)? {
            Some((STDOUT, bytes)) => {
                io::stdout().write_all(&bytes)?;
                io::stdout().flush()?;
            }
            Some((STDERR, bytes)) => {
                io::stderr().write_all(&bytes)?;
                io::stderr().flush()?;
            }
            Some((EXIT, bytes)) if bytes.len() == 4 => {
                return Ok(i32::from_be_bytes(bytes.try_into().unwrap()))
            }
            Some((ERROR, _)) => return Err(invalid("supervisor refused the session")),
            _ => return Err(invalid("supervisor disconnected before session exit")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frames_preserve_binary_and_reject_oversized_or_truncated_payloads() {
        let payload: Vec<u8> = (0..FRAME_BYTES).map(|n| (n % 256) as u8).collect();
        let mut encoded = Vec::new();
        write_frame(&mut encoded, STDIN, &payload).unwrap();
        assert_eq!(
            read_frame(&mut Cursor::new(&encoded)).unwrap(),
            Some((STDIN, payload))
        );
        assert!(write_frame(&mut Vec::new(), STDIN, &vec![0; FRAME_BYTES + 1]).is_err());
        let mut oversized = vec![STDIN];
        oversized.extend(((FRAME_BYTES + 1) as u32).to_be_bytes());
        assert_eq!(
            read_frame(&mut Cursor::new(oversized)).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        encoded.pop();
        assert_eq!(
            read_frame(&mut Cursor::new(encoded)).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert!(read_frame(&mut Cursor::new(Vec::<u8>::new()))
            .unwrap()
            .is_none());
    }

    #[test]
    fn creation_markers_are_private_atomic_versioned_and_reject_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state");
        let directory = private_directory(&path).unwrap();
        let key = "b".repeat(64);
        assert!(!marker_exists(&directory, &key).unwrap());
        record_marker(&directory, &key).unwrap();
        assert!(marker_exists(&directory, &key).unwrap());
        let marker = path.join(format!("{key}.json"));
        assert_eq!(fs::metadata(&marker).unwrap().mode() & 0o777, 0o600);
        fs::write(&marker, format!(r#"{{"version":2,"runtimeKey":"{key}"}}"#)).unwrap();
        assert!(!marker_exists(&directory, &key).unwrap());
        fs::remove_file(&marker).unwrap();
        std::os::unix::fs::symlink(root.path().join("untrusted"), &marker).unwrap();
        assert!(marker_exists(&directory, &key).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(private_directory(&path).is_err());
    }

    #[test]
    fn signal_is_idempotent_for_unknown_and_already_reaped_sessions() {
        let root = tempfile::tempdir().unwrap();
        let options = Arc::new(ServeOptions {
            socket: root.path().join("socket"),
            state_dir: root.path().join("state"),
            runtime_key: "a".repeat(64),
            idle_timeout_secs: 300,
            forward_ports: vec![],
            root: root.path().into(),
            bundle: root.path().into(),
            user: None,
            match_owner_of: None,
            runtime: RuntimeConfigV1::default(),
            image_env: BTreeMap::new(),
            executable: PathBuf::new(),
        });
        let sessions = Arc::new(Mutex::new(BTreeMap::from([(
            "gone".into(),
            Session {
                pid: i32::MAX,
                lease: None,
            },
        )])));
        for session in ["unknown", "gone"] {
            let (mut client, server) = UnixStream::pair().unwrap();
            send_request(
                &mut client,
                &Request::Signal {
                    session: session.into(),
                    signal: SIGTERM,
                },
            )
            .unwrap();
            handle_connection(
                server,
                Arc::clone(&options),
                Arc::clone(&sessions),
                Arc::new(Mutex::new(Instant::now())),
            )
            .unwrap();
            assert_eq!(
                read_frame(&mut client).unwrap(),
                Some((REPLY, br#"{"existed":false}"#.to_vec()))
            );
        }
    }
}
