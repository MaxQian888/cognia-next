//! Real Linux allowlist acceptance. Run explicitly:
//! cargo test -p cognia-exec-sandbox --test linux_allowlist -- --ignored --test-threads=1
//!
//! Requires bwrap, util-linux `unshare`, iproute2 `ip`, /usr/bin/python3,
//! enabled nested user/network/mount namespaces, and the Cargo-built launcher.
//! Missing prerequisites FAIL; they never turn acceptance into a skip.
//! Each test re-execs in a disposable user/network/mount namespace. Its fixture
//! assigns a public-classified address only to that namespace's loopback: no
//! host network change, external service, DNS, or production IP-check bypass.

#![cfg(target_os = "linux")]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use cognia_exec_sandbox::launcher::{render_linux_network_launch, LinuxBridgeLaunchSpec};
use cognia_exec_sandbox::linux::LinuxSandboxBackend;
use cognia_exec_sandbox::net_bridge::PROTOCOL_VERSION;
use cognia_exec_sandbox::net_proxy::{is_forbidden_dest_ip, FilteringProxy};
use cognia_exec_sandbox::traits::SandboxedExec;
use cognia_exec_sandbox::types::{
    NetworkPolicy, SandboxCommand, SandboxError, SandboxPolicy, SandboxResult,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UnixListener};
use tokio::time::{sleep, timeout};

const PUBLIC_FIXTURE: &str = "93.184.216.34";
const CHILD_ENV: &str = "COGNIA_LINUX_ALLOWLIST_ACCEPTANCE_CHILD";
const HELPER: &str = env!("CARGO_BIN_EXE_cognia-external-agent-launcher");
const PYTHON: &str = "/usr/bin/python3";

/// The namespace is entered in a new executable, never by mutating the Rust
/// test harness thread's namespace after it started multiple threads.
fn isolated(test: &str) -> bool {
    if std::env::var(CHILD_ENV).ok().as_deref() == Some(test) {
        for args in [
            vec!["link", "set", "lo", "up"],
            vec!["address", "add", "93.184.216.34/32", "dev", "lo"],
        ] {
            let status = Command::new("ip")
                .args(args)
                .status()
                .expect("iproute2 is required");
            assert!(status.success(), "isolated network fixture setup failed");
        }
        assert!(Path::new(PYTHON).is_file(), "{PYTHON} is required");
        let version = Command::new(HELPER)
            .arg("--linux-netns-bridge-version")
            .output()
            .expect("Cargo-built trusted helper is required");
        assert!(version.status.success(), "helper version probe failed");
        assert_eq!(
            String::from_utf8(version.stdout).unwrap().trim(),
            PROTOCOL_VERSION.to_string()
        );
        assert!(!is_forbidden_dest_ip(&PUBLIC_FIXTURE.parse().unwrap()));
        cognia_net::proxy_config::apply_current(Default::default()).unwrap();
        return true;
    }
    let scratch = tempfile::Builder::new()
        .prefix("cognia-allowlist-acceptance-")
        .tempdir()
        .unwrap();
    let status = Command::new("unshare")
        .args([
            "--user",
            "--map-root-user",
            "--net",
            "--mount",
            "--fork",
            "--kill-child",
        ])
        .arg(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            test,
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_ENV, test)
        .env("TMPDIR", scratch.path())
        .status()
        .expect("util-linux unshare and working namespaces are required");
    assert!(
        status.success(),
        "Linux acceptance failed (including missing bwrap/userns/ip/helper prerequisites)"
    );
    assert_eq!(
        std::fs::read_dir(scratch.path()).unwrap().count(),
        0,
        "acceptance left scratch files or sockets"
    );
    false
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn policy(work: &Path, hosts: &[&str]) -> SandboxPolicy {
    SandboxPolicy::Bash {
        writable: vec![work.to_path_buf()],
        readable: Vec::new(),
        network: NetworkPolicy::Allowlist {
            hosts: hosts.iter().map(|host| (*host).into()).collect(),
        },
        max_cpu_seconds: 0,
        max_memory_mb: 0,
        max_processes: 0,
    }
}

fn command(work: &Path, script: &str) -> SandboxCommand {
    SandboxCommand {
        argv: vec![
            PYTHON.into(),
            "-c".into(),
            script.into(),
            format!("cognia-acceptance-target-{}", work.display()),
        ],
        cwd: work.to_path_buf(),
        env: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        stdin: None,
        timeout: Duration::from_secs(12),
    }
}

async fn execute(work: &Path, script: &str, hosts: &[&str]) -> SandboxResult {
    let result = LinuxSandboxBackend::new(None)
        .run(command(work, script), policy(work, hosts))
        .await
        .expect("real bwrap allowlist setup and execution must succeed");
    assert!(!result.timed_out, "unexpected timeout: {result:?}");
    assert_eq!(result.exit_code, 0, "target failed: {result:?}");
    assert_eq!(
        result.network.mechanism.as_deref(),
        Some("netns_unix_proxy")
    );
    assert_eq!(result.network.requested, result.network.effective);
    result
}

fn bridge_directories() -> Vec<PathBuf> {
    std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cognia-egress-")
        })
        .collect()
}

fn target_processes(token: &str) -> Vec<u32> {
    std::fs::read_dir("/proc")
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let pid = entry.file_name().to_string_lossy().parse::<u32>().ok()?;
            let argv = std::fs::read(entry.path().join("cmdline")).ok()?;
            String::from_utf8_lossy(&argv)
                .contains(token)
                .then_some(pid)
        })
        .collect()
}

async fn assert_clean(token: &str, known_pids: &[u32]) {
    timeout(Duration::from_secs(5), async {
        loop {
            if bridge_directories().is_empty()
                && target_processes(token).is_empty()
                && known_pids
                    .iter()
                    .all(|pid| !Path::new(&format!("/proc/{pid}")).exists())
            {
                break;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "{token}: leftovers: dirs={:?}, processes={:?}, known={known_pids:?}",
            bridge_directories(),
            target_processes(token)
        )
    });
}

async fn await_marker(path: &Path, mode: &str) {
    timeout(Duration::from_secs(8), async {
        while !path.exists() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|error| panic!("{mode}: target never reached its marker (setup failure is not a passing test): {error}"));
}

const PROXY_CLIENT: &str = r#"
import errno, os, socket, urllib.parse
proxy = urllib.parse.urlparse(os.environ['HTTPS_PROXY'])
assert proxy.hostname == '127.0.0.1' and proxy.port
for key in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']:
    assert os.environ[key] == os.environ['HTTPS_PROXY'], (key, os.environ[key])
assert not os.environ.get('NO_PROXY') and not os.environ.get('no_proxy')
def connect(host, port):
    sock = socket.create_connection((proxy.hostname, proxy.port), timeout=3)
    sock.sendall(('CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n\r\n' % (host, port, host, port)).encode())
    head = b''
    while not head.endswith(b'\r\n\r\n'):
        part = sock.recv(1)
        assert part, head
        head += part
    return sock, int(head.split(b' ')[1])
"#;

#[test]
#[ignore = "requires real Linux bwrap/userns, util-linux, iproute2 and python3"]
fn target_cannot_read_supervisor_memory_or_steal_descriptors() {
    if !isolated("target_cannot_read_supervisor_memory_or_steal_descriptors") {
        return;
    }
    runtime().block_on(async {
        let work = tempfile::tempdir().unwrap();
        let result = execute(
            work.path(),
            r#"
import ctypes, errno, os
supervisor = os.getppid()
assert supervisor > 0
try:
    fd = os.open('/proc/%d/mem' % supervisor, os.O_RDWR)
except OSError as error:
    assert error.errno in [errno.EPERM, errno.EACCES], error
else:
    os.close(fd)
    raise AssertionError('supervisor memory is accessible')
# pidfd_open/getfd numbers are shared by Linux aarch64 and x86_64.
libc = ctypes.CDLL(None, use_errno=True)
pidfd = libc.syscall(434, supervisor, 0)
assert pidfd >= 0, ctypes.get_errno()
try:
    assert libc.syscall(438, pidfd, 0, 0) == -1
    assert ctypes.get_errno() == errno.EPERM, ctypes.get_errno()
finally:
    os.close(pidfd)
print('supervisor-memory-and-fds-protected')
"#,
            &[PUBLIC_FIXTURE],
        )
        .await;
        assert!(result
            .stdout
            .contains("supervisor-memory-and-fds-protected"));
        assert_clean(&work.path().to_string_lossy(), &[]).await;
    });
}

#[test]
#[ignore = "requires real Linux bwrap/userns, util-linux, iproute2 and python3"]
fn foreign_namespace_control_connection_is_rejected_and_real_run_completes() {
    if !isolated("foreign_namespace_control_connection_is_rejected_and_real_run_completes") {
        return;
    }
    runtime().block_on(async {
        use std::os::unix::fs::PermissionsExt;
        let work = tempfile::tempdir().unwrap();
        let socket_marker = work.path().join("control-path");
        let release = work.path().join("release-bwrap");
        let wrapper = work.path().join("bwrap-wrapper");
        // Delay only the real launch, not --help, so the independently spawned
        // foreign namespace deterministically connects before the supervisor.
        std::fs::write(&wrapper, format!(r#"#!{PYTHON}
import os, sys, time
args = sys.argv[1:]
if '--help' not in args:
    control = args[args.index('/run/cognia-egress/control.sock') - 1]
    open({socket_marker:?}, 'w').write(control)
    deadline = time.monotonic() + 4
    while not os.path.exists({release:?}):
        assert time.monotonic() < deadline, 'foreign peer did not finish'
        time.sleep(0.005)
os.execvp('bwrap', ['bwrap'] + args)
"#)).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let attack = format!(r#"
import errno, os, socket, time
deadline = time.monotonic() + 8
while not os.path.exists({socket_marker:?}):
    assert time.monotonic() < deadline, 'backend did not create control socket'
    time.sleep(0.005)
path = open({socket_marker:?}).read()
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(4)
sock.connect(path)
try:
    sock.sendall(b'COGNIA_EGRESS_READY {PROTOCOL_VERSION}\n')
    data, ancillary, flags, address = sock.recvmsg(128, socket.CMSG_SPACE(4))
    assert not data and not ancillary, (data, ancillary)
except OSError as error:
    assert error.errno in [errno.ECONNRESET, errno.EPIPE], error
finally:
    sock.close()
open({release:?}, 'w').write('foreign-peer-refused')
"#);
        let mut foreign = tokio::process::Command::new("unshare")
            .args(["--pid", "--fork", "--kill-child", PYTHON, "-c", &attack])
            .kill_on_drop(true).spawn().unwrap();
        let mut cmd = command(work.path(), "import sys; assert sys.stdin.read() == 'private-stdin'; print('real-supervisor-completed')");
        cmd.stdin = Some(b"private-stdin".to_vec());
        let result = LinuxSandboxBackend::new(Some(wrapper))
            .run(cmd, policy(work.path(), &[PUBLIC_FIXTURE])).await.unwrap();
        assert_eq!(result.exit_code, 0, "{result:?}");
        assert!(!result.timed_out);
        assert!(result.stdout.contains("real-supervisor-completed"));
        assert_eq!(result.network.mechanism.as_deref(), Some("netns_unix_proxy"));
        assert!(timeout(Duration::from_secs(5), foreign.wait()).await.unwrap().unwrap().success());
        assert!(release.exists(), "foreign peer never exercised the handshake");
        assert_clean(&work.path().to_string_lossy(), &[]).await;
    });
}

#[test]
#[ignore = "requires real Linux bwrap/userns, util-linux, iproute2 and python3"]
fn allowed_connect_and_denied_destinations() {
    if !isolated("allowed_connect_and_denied_destinations") {
        return;
    }
    runtime().block_on(async {
        let work = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind((PUBLIC_FIXTURE, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let fixture = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut message = [0; 16];
            stream.read_exact(&mut message).await.unwrap();
            assert_eq!(&message, b"controlled-bytes");
            stream.write_all(&message).await.unwrap();
            stream.shutdown().await.unwrap();
        });
        let script = format!(
            r#"{PROXY_CLIENT}
sock, status = connect('{PUBLIC_FIXTURE}', {port})
assert status == 200, status
sock.sendall(b'controlled-bytes')
reply = b''
while len(reply) < 16:
    reply += sock.recv(16 - len(reply))
assert reply == b'controlled-bytes', reply
sock.close()
for host in ['denied.invalid', '127.0.0.1', '10.0.0.1', '169.254.169.254']:
    sock, status = connect(host, {port})
    assert status == 403, (host, status)
    sock.close()
print('allowed-and-denied-verified')
"#
        );
        let mut cmd = command(work.path(), &script);
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            cmd.env
                .insert(key.into(), "http://attacker.invalid:9".into());
        }
        cmd.env.insert("NO_PROXY".into(), "*".into());
        cmd.env.insert("no_proxy".into(), "*".into());
        cmd.env
            .insert("COGNIA_SANDBOX_PROXY_PORT".into(), "9".into());
        let requested = policy(
            work.path(),
            &[PUBLIC_FIXTURE, "127.0.0.1", "10.0.0.1", "169.254.169.254"],
        );
        let result = LinuxSandboxBackend::new(None)
            .run(cmd, requested.clone())
            .await
            .unwrap();
        assert_eq!(result.exit_code, 0, "{result:?}");
        assert!(!result.timed_out);
        assert!(result.stdout.contains("allowed-and-denied-verified"));
        assert_eq!(
            result.network.mechanism.as_deref(),
            Some("netns_unix_proxy")
        );
        let SandboxPolicy::Bash { network, .. } = requested else {
            unreachable!()
        };
        assert_eq!(result.network.requested, Some(network.clone()));
        assert_eq!(result.network.effective, Some(network));
        timeout(Duration::from_secs(2), fixture)
            .await
            .unwrap()
            .unwrap();
        assert_clean(&work.path().to_string_lossy(), &[]).await;
    });
}

#[test]
#[ignore = "requires real Linux bwrap/userns, util-linux, iproute2 and python3"]
fn cleared_environment_and_mounted_unix_socket_cannot_bypass() {
    if !isolated("cleared_environment_and_mounted_unix_socket_cannot_bypass") {
        return;
    }
    runtime().block_on(async {
        let work = tempfile::tempdir().unwrap();
        let tcp = TcpListener::bind((PUBLIC_FIXTURE, 0)).await.unwrap();
        let port = tcp.local_addr().unwrap().port();
        let socket_path = work.path().join("host.sock");
        let unix = UnixListener::bind(&socket_path).unwrap();
        let script = format!(r#"{PROXY_CLIENT}
import stat
assert stat.S_ISSOCK(os.stat({socket_path:?}).st_mode), 'host socket was not mounted'
for key in list(os.environ):
    if key.lower().endswith('_proxy') or key == 'COGNIA_SANDBOX_PROXY_PORT':
        del os.environ[key]
try:
    sock = socket.create_connection(('{PUBLIC_FIXTURE}', {port}), timeout=1)
except OSError as error:
    assert error.errno in [errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ECONNREFUSED, errno.EPERM], error
else:
    sock.close()
    raise AssertionError('direct network bypass succeeded')
try:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
except OSError as error:
    assert error.errno == errno.EPERM, error
else:
    sock.close()
    raise AssertionError('target could create AF_UNIX socket')
print('bypasses-refused')
"#);
        let result = execute(work.path(), &script, &[PUBLIC_FIXTURE]).await;
        assert!(result.stdout.contains("bypasses-refused"));
        assert!(timeout(Duration::from_millis(50), tcp.accept()).await.is_err());
        assert!(timeout(Duration::from_millis(50), unix.accept()).await.is_err());
        let invalid = LinuxSandboxBackend::new(None)
            .run(command(work.path(), "raise AssertionError('empty allowlist ran')"), policy(work.path(), &[])).await;
        assert!(matches!(invalid, Err(SandboxError::InvalidPolicy { .. })), "{invalid:?}");
        assert_clean(&work.path().to_string_lossy(), &[]).await;
    });
}

#[test]
#[ignore = "requires real Linux bwrap/userns, util-linux, iproute2 and python3"]
fn timeout_stdin_failure_and_cancellation_reap_and_remove_sockets() {
    if !isolated("timeout_stdin_failure_and_cancellation_reap_and_remove_sockets") {
        return;
    }
    runtime().block_on(async {
        for mode in ["timeout", "blocked-stdin", "stdin", "cancel"] {
            let work = tempfile::tempdir().unwrap();
            let marker = work.path().join("started");
            let token = format!("cognia-acceptance-target-{}-{mode}", std::process::id());
            let script = format!(
                r#"
import os, time
if os.fork() == 0:
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    os.close(0)
    open({marker:?} + '-escaped', 'w').write('escaped')
    time.sleep(60)
    os._exit(0)
while not os.path.exists({marker:?} + '-escaped'):
    time.sleep(0.01)
open({marker:?}, 'w').write('started')
{}
time.sleep(60)
"#,
                if mode == "stdin" { "os.close(0)" } else { "" }
            );
            let mut cmd = command(work.path(), &script);
            cmd.argv.push(token.clone());
            if mode == "timeout" || mode == "blocked-stdin" {
                cmd.timeout = Duration::from_secs(4);
            }
            if mode == "stdin" || mode == "blocked-stdin" {
                cmd.stdin = Some(vec![b'x'; 4 * 1024 * 1024]);
            }
            let requested = policy(work.path(), &[PUBLIC_FIXTURE]);
            let task =
                tokio::spawn(
                    async move { LinuxSandboxBackend::new(None).run(cmd, requested).await },
                );
            await_marker(&marker, mode).await;
            let pids = target_processes(&token);
            if mode == "cancel" {
                assert!(!pids.is_empty(), "{mode}: no live target to cancel");
                task.abort();
                assert!(
                    task.await
                        .expect_err(&format!("{mode}: task must cancel"))
                        .is_cancelled(),
                    "{mode}: unexpected join error"
                );
            } else {
                let result = timeout(Duration::from_secs(10), task)
                    .await
                    .unwrap_or_else(|error| {
                        panic!("{mode}: backend did not return within 10s: {error}")
                    })
                    .unwrap_or_else(|error| panic!("{mode}: lifecycle task failed: {error}"));
                if mode == "timeout" || mode == "blocked-stdin" {
                    let result = result.unwrap_or_else(|error| {
                        panic!("{mode}: timeout must return an execution result: {error}")
                    });
                    assert!(result.timed_out, "{mode}: {result:?}");
                    assert_eq!(
                        result.network.mechanism.as_deref(),
                        Some("netns_unix_proxy"),
                        "{mode}: completed handshake must remain in timeout report"
                    );
                } else {
                    let error =
                        result.expect_err(&format!("{mode}: closed target stdin must fail"));
                    assert!(
                        error.to_string().to_lowercase().contains("broken pipe"),
                        "{mode}: expected EPIPE, not an idle timeout or setup failure: {error}"
                    );
                }
            }
            assert_clean(&token, &pids).await;
        }
    });
}

#[test]
#[ignore = "requires real Linux bwrap/userns, util-linux, iproute2 and python3"]
fn helper_crash_or_control_eof_before_go_never_starts_target() {
    if !isolated("helper_crash_or_control_eof_before_go_never_starts_target") {
        return;
    }
    runtime().block_on(async {
        for crash in [true, false] {
            let work = tempfile::tempdir().unwrap();
            let marker = work.path().join("must-not-start");
            let proxy_path = work.path().join("proxy.sock");
            let control_path = work.path().join("control.sock");
            let mut proxy = FilteringProxy::start_unix(&proxy_path, vec![PUBLIC_FIXTURE.into()])
                .await
                .unwrap();
            let control = UnixListener::bind(&control_path).unwrap();
            let target = vec![
                PYTHON.into(),
                "-c".into(),
                format!("open({marker:?}, 'w').write('started')"),
            ];
            let bridge = LinuxBridgeLaunchSpec {
                helper: PathBuf::from(HELPER),
                proxy_socket: proxy_path.clone(),
                control_socket: control_path.clone(),
                as_pid_1: false,
            };
            let launch = render_linux_network_launch(
                &NetworkPolicy::Allowlist {
                    hosts: vec![PUBLIC_FIXTURE.into()],
                },
                Some(&bridge),
                &target,
            )
            .unwrap();
            let mut cmd = tokio::process::Command::new("bwrap");
            cmd.args([
                "--unshare-user",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--die-with-parent",
            ]);
            for system in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"] {
                if Path::new(system).exists() {
                    cmd.args(["--ro-bind", system, system]);
                }
            }
            cmd.args(["--proc", "/proc", "--dev", "/dev", "--bind"])
                .arg(work.path())
                .arg(work.path())
                .args(launch)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .kill_on_drop(true);
            let mut child = cmd.spawn().expect("real bwrap is required");
            let (mut channel, _) = timeout(Duration::from_secs(8), control.accept())
                .await
                .expect("helper did not reach Ready; setup failure is not acceptance")
                .unwrap();
            let expected = format!("COGNIA_EGRESS_READY {PROTOCOL_VERSION}\n");
            let mut ready = vec![0; expected.len()];
            timeout(Duration::from_secs(2), channel.read_exact(&mut ready))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(ready, expected.as_bytes());
            assert!(!marker.exists(), "target ran before Go");
            let pids = target_processes(&marker.to_string_lossy());
            if crash {
                let helper_pid = pids
                    .iter()
                    .find(|pid| {
                        std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|argv| {
                            argv.split(|byte| *byte == 0).next()
                                == Some(b"/run/cognia-egress/helper".as_slice())
                        })
                    })
                    .expect("ready helper process must be visible in host procfs");
                assert_eq!(unsafe { libc::kill(*helper_pid as i32, libc::SIGKILL) }, 0);
            }
            drop(channel); // EOF instead of Go in the second case.
            let status = timeout(Duration::from_secs(8), child.wait())
                .await
                .unwrap()
                .unwrap();
            assert!(!status.success());
            assert!(!marker.exists(), "failed helper released the target");
            proxy.shutdown().await.unwrap();
            drop(control);
            std::fs::remove_file(control_path).unwrap();
            assert!(!proxy_path.exists(), "proxy socket survived shutdown");
            assert_clean(&marker.to_string_lossy(), &pids).await;
        }
    });
}
