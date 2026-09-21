#![cfg(unix)]

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use cognia_sandboxd::env::{RuntimeCommand, RuntimeConfigV1, RuntimeLifecycleCommands};
use cognia_sandboxd::serve::{health, signal_agent};

const BINARY: &str = env!("CARGO_BIN_EXE_cognia-sandboxd");

struct Host {
    directory: tempfile::TempDir,
    config: RuntimeConfigV1,
    child: Option<Child>,
    idle: u64,
    ports: Vec<u16>,
}

impl Host {
    fn new(config: RuntimeConfigV1) -> Self {
        let directory = tempfile::Builder::new()
            .prefix("cg-")
            .tempdir_in("/tmp")
            .unwrap();
        fs::create_dir_all(directory.path().join("root/workspace")).unwrap();
        Self {
            directory,
            config,
            child: None,
            idle: 30,
            ports: Vec::new(),
        }
    }
    fn socket(&self) -> PathBuf {
        self.directory.path().join("control/socket")
    }
    fn workspace(&self) -> PathBuf {
        self.directory.path().join("root/workspace")
    }
    fn config_path(&self) -> PathBuf {
        self.directory.path().join("runtime.json")
    }
    fn command(&self) -> Command {
        fs::write(
            self.config_path(),
            serde_json::to_vec(&self.config).unwrap(),
        )
        .unwrap();
        let mut command = Command::new(BINARY);
        command
            .arg("serve")
            .arg("--socket")
            .arg(self.socket())
            .arg("--state-dir")
            .arg(self.directory.path().join("state"))
            .arg("--runtime-key")
            .arg("a".repeat(64))
            .arg("--root")
            .arg(self.directory.path().join("root"))
            .arg("--bundle")
            .arg(self.directory.path().join("bundle"))
            .arg("--runtime-config")
            .arg(self.config_path())
            .arg("--idle-timeout-secs")
            .arg(self.idle.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        for port in &self.ports {
            command.arg("--forward-port").arg(port.to_string());
        }
        command
    }
    fn start(&mut self) {
        self.child = Some(self.command().spawn().unwrap());
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if health(&self.socket()).is_ok() {
                break;
            }
            if let Some(status) = self.child.as_mut().unwrap().try_wait().unwrap() {
                let mut error = String::new();
                self.child
                    .as_mut()
                    .unwrap()
                    .stderr
                    .take()
                    .unwrap()
                    .read_to_string(&mut error)
                    .unwrap();
                panic!("supervisor exited {status}: {error}");
            }
            assert!(Instant::now() < until, "supervisor did not become ready");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            let until = Instant::now() + Duration::from_secs(6);
            while child.try_wait().unwrap().is_none() {
                if Instant::now() >= until {
                    child.kill().unwrap();
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            child.wait().unwrap();
        }
    }
    fn connect(&self, session: &str, script: &str) -> Child {
        self.connect_with_lease(session, script, None)
    }
    fn connect_with_lease(&self, session: &str, script: &str, lease: Option<u64>) -> Child {
        let mut command = Command::new(BINARY);
        if let Some(seconds) = lease {
            command.args(["connect-agent", "--lease-seconds", &seconds.to_string()]);
        } else {
            command.arg("connect-agent");
        }
        command
            .arg("--socket")
            .arg(self.socket())
            .arg("--session")
            .arg(session)
            .arg("--runtime-config")
            .arg(self.config_path())
            .args(["--", "/bin/sh", "-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.stop();
    }
}

fn wait_for(mut condition: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < until, "condition did not complete");
        thread::sleep(Duration::from_millis(10));
    }
}
fn shell(command: &str) -> RuntimeCommand {
    RuntimeCommand::Shell {
        command: command.into(),
    }
}
fn read_pid(path: &Path) -> i32 {
    fs::read_to_string(path).unwrap().trim().parse().unwrap()
}

#[test]
fn two_live_sessions_keep_separate_binary_stdio_and_exit_status() {
    let mut host = Host::new(RuntimeConfigV1::default());
    host.start();
    let mut first = host.connect("first", "read value; printf 'first:%s' \"$value\"; exit 7");
    let mut second = host.connect(
        "second",
        "read value; printf 'second:%s' \"$value\"; exit 9",
    );
    wait_for(|| health(&host.socket()).unwrap()["activeSessions"] == 2);
    first.stdin.take().unwrap().write_all(b"alpha\n").unwrap();
    second.stdin.take().unwrap().write_all(b"beta\n").unwrap();
    let first = first.wait_with_output().unwrap();
    let second = second.wait_with_output().unwrap();
    assert_eq!(first.status.code(), Some(7));
    assert_eq!(second.status.code(), Some(9));
    assert_eq!(first.stdout, b"first:alpha");
    assert_eq!(second.stdout, b"second:beta");
    wait_for(|| health(&host.socket()).unwrap()["activeSessions"] == 0);
    signal_agent(&host.socket(), "first".into(), libc::SIGTERM).unwrap();
    signal_agent(&host.socket(), "never-existed".into(), libc::SIGKILL).unwrap();
}

#[test]
fn a_disconnected_exec_removes_its_agent_and_background_descendants() {
    let mut host = Host::new(RuntimeConfigV1::default());
    host.start();
    let mut client = host.connect(
        "disconnect",
        "echo $$ > agent-pid; sleep 30 & echo $! > descendant-pid; wait",
    );
    wait_for(|| host.workspace().join("descendant-pid").exists());
    let agent = read_pid(&host.workspace().join("agent-pid"));
    let descendant = read_pid(&host.workspace().join("descendant-pid"));
    client.kill().unwrap();
    client.wait().unwrap();
    wait_for(|| health(&host.socket()).unwrap()["activeSessions"] == 0);
    wait_for(|| unsafe { libc::kill(agent, 0) == -1 && libc::kill(descendant, 0) == -1 });
}

#[test]
fn creation_runs_once_restart_runs_post_start_and_every_attach_runs_post_attach() {
    let mut host = Host::new(RuntimeConfigV1 {
        lifecycle_commands: RuntimeLifecycleCommands {
            on_create: Some(shell("printf c >> created")),
            update_content: Some(shell("printf u >> created")),
            post_create: Some(shell("printf p >> created")),
            post_start: Some(shell("printf s >> started")),
            post_attach: Some(shell("printf a >> attached; printf setup-log")),
        },
        ..RuntimeConfigV1::default()
    });
    host.start();
    let first = host
        .connect("first", "printf agent")
        .wait_with_output()
        .unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(first.stdout, b"agent");
    assert!(String::from_utf8_lossy(&first.stderr).contains("setup-log"));
    host.stop();
    host.start();
    assert!(host
        .connect("second", "true")
        .wait_with_output()
        .unwrap()
        .status
        .success());
    assert_eq!(
        fs::read_to_string(host.workspace().join("created")).unwrap(),
        "cup"
    );
    assert_eq!(
        fs::read_to_string(host.workspace().join("started")).unwrap(),
        "ss"
    );
    assert_eq!(
        fs::read_to_string(host.workspace().join("attached")).unwrap(),
        "aa"
    );
}

#[test]
fn failed_creation_is_not_marked_successful_or_reported_ready() {
    let mut host = Host::new(RuntimeConfigV1 {
        lifecycle_commands: RuntimeLifecycleCommands {
            on_create: Some(shell("exit 23")),
            ..RuntimeLifecycleCommands::default()
        },
        ..RuntimeConfigV1::default()
    });
    let output = host.command().output().unwrap();
    assert!(!output.status.success());
    assert!(health(&host.socket()).is_err());
    assert_eq!(
        fs::read_dir(host.directory.path().join("state"))
            .unwrap()
            .count(),
        0
    );
    host.config.lifecycle_commands.on_create = Some(shell("touch repaired"));
    host.start();
    assert!(host.workspace().join("repaired").exists());
}

#[test]
fn authorized_port_tunnel_preserves_binary_streams_and_tcp_half_close() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        socket.read_to_end(&mut bytes).unwrap();
        bytes.reverse();
        socket.write_all(&bytes).unwrap();
    });
    let mut host = Host::new(RuntimeConfigV1::default());
    host.ports.push(port);
    host.start();
    let mut client = Command::new(BINARY)
        .arg("connect-port")
        .arg("--socket")
        .arg(host.socket())
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let payload: Vec<u8> = (0..262_144).map(|index| (index % 256) as u8).collect();
    client.stdin.take().unwrap().write_all(&payload).unwrap();
    let output = client.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, payload.into_iter().rev().collect::<Vec<_>>());
    server.join().unwrap();
    let forbidden = Command::new(BINARY)
        .arg("connect-port")
        .arg("--socket")
        .arg(host.socket())
        .arg("--port")
        .arg(if port == 1 { "2" } else { "1" })
        .output()
        .unwrap();
    assert!(!forbidden.status.success());
}

#[test]
fn idle_exit_waits_for_the_last_agent_and_preserves_created_state() {
    let mut host = Host::new(RuntimeConfigV1::default());
    host.idle = 1;
    host.start();
    let mut agent = host.connect("live", "read value");
    wait_for(|| health(&host.socket()).unwrap()["activeSessions"] == 1);
    thread::sleep(Duration::from_millis(1200));
    assert!(host.child.as_mut().unwrap().try_wait().unwrap().is_none());
    agent.stdin.take().unwrap().write_all(b"done\n").unwrap();
    assert!(agent.wait_with_output().unwrap().status.success());
    wait_for(|| host.child.as_mut().unwrap().try_wait().unwrap().is_some());
    host.child.take().unwrap().wait().unwrap();
    assert!(fs::read_dir(host.directory.path().join("state"))
        .unwrap()
        .next()
        .is_some());
}

#[test]
fn disconnect_cleans_up_even_when_agent_never_reads_a_full_stdin_pipe() {
    let mut host = Host::new(RuntimeConfigV1::default());
    host.start();
    let mut client = host.connect("blocked-stdin", "echo $$ > blocked-pid; sleep 30");
    wait_for(|| host.workspace().join("blocked-pid").exists());
    let pid = read_pid(&host.workspace().join("blocked-pid"));
    let mut input = client.stdin.take().unwrap();
    let writer = thread::spawn(move || {
        let _ = input.write_all(&vec![42; 4 * 1024 * 1024]);
    });
    thread::sleep(Duration::from_millis(100));
    client.kill().unwrap();
    client.wait().unwrap();
    writer.join().unwrap();
    wait_for(|| health(&host.socket()).unwrap()["activeSessions"] == 0);
    wait_for(|| unsafe { libc::kill(pid, 0) == -1 });
}

#[test]
fn authorized_port_connection_prevents_idle_exit_until_disconnected() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut host = Host::new(RuntimeConfigV1::default());
    host.idle = 1;
    host.ports.push(port);
    host.start();
    let mut client = Command::new(BINARY)
        .arg("connect-port")
        .arg("--socket")
        .arg(host.socket())
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (mut backend, _) = listener.accept().unwrap();
    wait_for(|| health(&host.socket()).unwrap()["activeConnections"] == 1);
    thread::sleep(Duration::from_millis(1200));
    assert!(host.child.as_mut().unwrap().try_wait().unwrap().is_none());
    client.kill().unwrap();
    client.wait().unwrap();
    backend
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    assert_eq!(backend.read(&mut [0]).unwrap(), 0);
    wait_for(|| host.child.as_mut().unwrap().try_wait().unwrap().is_some());
}

#[test]
fn explicit_direct_port_tunnel_preserves_binary_and_half_close_without_a_supervisor() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        socket.read_to_end(&mut bytes).unwrap();
        socket.write_all(&bytes).unwrap();
    });
    let mut client = Command::new(BINARY)
        .args(["connect-port", "--direct", "--port", &port.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let payload: Vec<u8> = (0..262_144).map(|index| (index % 256) as u8).collect();
    client.stdin.take().unwrap().write_all(&payload).unwrap();
    let output = client.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, payload);
    server.join().unwrap();
}

#[test]
fn expired_lease_closes_live_exec_and_cleans_blocked_agent_descendants() {
    let mut host = Host::new(RuntimeConfigV1::default());
    host.start();
    let mut client = host.connect_with_lease(
        "leased",
        "echo $$ > leased-agent; sleep 30 & echo $! > leased-child; wait",
        Some(1),
    );
    wait_for(|| host.workspace().join("leased-child").exists());
    let agent = read_pid(&host.workspace().join("leased-agent"));
    let descendant = read_pid(&host.workspace().join("leased-child"));
    let mut input = client.stdin.take().unwrap();
    let blocked = thread::spawn(move || {
        let _ = input.write_all(&vec![42; 4 * 1024 * 1024]);
    });
    // Keep the exec client alive: loss of the Host heartbeat, not socket EOF,
    // must release this session and wake blocked stdio.
    wait_for(|| client.try_wait().unwrap().is_some());
    blocked.join().unwrap();
    wait_for(|| health(&host.socket()).unwrap()["activeConnections"] == 0);
    wait_for(|| unsafe { libc::kill(agent, 0) == -1 && libc::kill(descendant, 0) == -1 });
}

#[test]
fn renewing_lease_keeps_session_alive_then_expiration_cancels_lifecycle() {
    let mut host = Host::new(RuntimeConfigV1 {
        lifecycle_commands: RuntimeLifecycleCommands { post_attach: Some(shell("echo $$ > lease-hook; sleep 30 & echo $! > lease-hook-child; wait; touch forbidden-after-hook")), ..RuntimeLifecycleCommands::default() },
        ..RuntimeConfigV1::default()
    });
    host.start();
    let mut client = host.connect_with_lease("renewed", "touch forbidden-agent", Some(1));
    wait_for(|| host.workspace().join("lease-hook-child").exists());
    let hook = read_pid(&host.workspace().join("lease-hook"));
    let descendant = read_pid(&host.workspace().join("lease-hook-child"));
    for _ in 0..5 {
        thread::sleep(Duration::from_millis(300));
        let result = Command::new(BINARY)
            .args(["renew-agent", "--socket"])
            .arg(host.socket())
            .args(["--session", "renewed"])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(client.try_wait().unwrap().is_none());
    }
    wait_for(|| client.try_wait().unwrap().is_some());
    wait_for(|| health(&host.socket()).unwrap()["activeConnections"] == 0);
    wait_for(|| unsafe { libc::kill(hook, 0) == -1 && libc::kill(descendant, 0) == -1 });
    assert!(!host.workspace().join("forbidden-agent").exists());
    assert!(!host.workspace().join("forbidden-after-hook").exists());
    assert!(!Command::new(BINARY)
        .args(["renew-agent", "--socket"])
        .arg(host.socket())
        .args(["--session", "renewed"])
        .output()
        .unwrap()
        .status
        .success());
}

#[test]
fn lease_bounds_and_renewal_never_change_unleased_sessions() {
    let mut host = Host::new(RuntimeConfigV1::default());
    host.start();
    for invalid in [0, 301] {
        let result = host
            .connect_with_lease("invalid", "touch forbidden-invalid-lease", Some(invalid))
            .wait_with_output()
            .unwrap();
        assert!(!result.status.success());
    }
    assert!(!host.workspace().join("forbidden-invalid-lease").exists());
    let mut unleased = host.connect("unleased", "echo ready > unleased-ready; sleep 30");
    wait_for(|| host.workspace().join("unleased-ready").exists());
    let renewal = Command::new(BINARY)
        .args(["renew-agent", "--socket"])
        .arg(host.socket())
        .args(["--session", "unleased"])
        .output()
        .unwrap();
    assert!(!renewal.status.success());
    let mut leased = host.connect_with_lease("leased", "sleep 30", Some(1));
    wait_for(|| leased.try_wait().unwrap().is_some());
    wait_for(|| health(&host.socket()).unwrap()["activeSessions"] == 1);
    assert!(unleased.try_wait().unwrap().is_none());
    signal_agent(&host.socket(), "unleased".into(), libc::SIGTERM).unwrap();
    wait_for(|| unleased.try_wait().unwrap().is_some());
}
