//! Bounded process transport for Docker control and supervised CUA commands.
//! Kept separate from lifecycle policy; the embedded supervisor is tested as
//! the exact payload sent into the container.

use super::{backend_err, ExecOutcome, Result, MAX_STREAM_BYTES};
use base64::Engine;
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

pub(super) const SUPERVISOR: &str = include_str!("exec_supervisor.py");
pub(crate) const PYTHON_BOOTSTRAP: &str = r#"for python in /usr/local/bin/python3 /opt/venv/bin/python3 /usr/bin/python3; do if [ -x "$python" ]; then exec "$python" -I -u -c "$1"; fi; done; echo 'CUA requires Python3 at a trusted absolute path' >&2; exit 125"#;
pub(super) const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct Capture {
    pub bytes: Vec<u8>,
    pub truncated: bool,
    limit: usize,
}

impl Default for Capture {
    fn default() -> Self {
        Self {
            bytes: Vec::new(),
            truncated: false,
            limit: MAX_STREAM_BYTES,
        }
    }
}

impl Capture {
    fn append(&mut self, bytes: &[u8]) {
        let remaining = self.limit.saturating_sub(self.bytes.len());
        self.truncated |= bytes.len() > remaining;
        self.bytes
            .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
    }

    pub fn text(&self) -> String {
        let mut text = String::from_utf8_lossy(&self.bytes).into_owned();
        // A stream cap can bisect a valid UTF-8 sequence. Do not present a
        // synthetic replacement character for that final incomplete codepoint.
        if self.truncated {
            if let Err(error) = std::str::from_utf8(&self.bytes) {
                if error.error_len().is_none() {
                    text = String::from_utf8_lossy(&self.bytes[..error.valid_up_to()]).into_owned();
                }
            }
        }
        if text.len() > self.limit {
            let mut end = self.limit;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        text
    }

    fn text_truncated(&self) -> bool {
        self.truncated || String::from_utf8_lossy(&self.bytes).len() > self.limit
    }
}

async fn capture(mut stream: impl AsyncRead + Unpin) -> Result<Capture> {
    let mut result = Capture::default();
    // Keep capture buffers off nested async future stacks (two per Docker call).
    let mut chunk = vec![0; 16 * 1024];
    loop {
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|e| backend_err(e.to_string()))?;
        if count == 0 {
            return Ok(result);
        }
        result.append(&chunk[..count]);
    }
}

pub(super) async fn control(
    command: &mut Command,
    what: &str,
) -> Result<(ExitStatus, Capture, Capture)> {
    control_with_timeout(command, what, CONTROL_TIMEOUT).await
}

pub(super) async fn control_with_timeout(
    command: &mut Command,
    what: &str,
    timeout: Duration,
) -> Result<(ExitStatus, Capture, Capture)> {
    let mut child = command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| backend_err(format!("{what} could not spawn: {e}")))?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let operation = async {
        let (status, stdout, stderr) = tokio::try_join!(
            async { child.wait().await.map_err(|e| backend_err(e.to_string())) },
            capture(stdout),
            capture(stderr),
        )?;
        Ok((status, stdout, stderr))
    };
    match tokio::time::timeout(timeout, operation).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            Err(backend_err(format!(
                "{what} exceeded its {} second Docker operation deadline",
                timeout.as_secs()
            )))
        }
    }
}

#[derive(Default)]
struct Frames {
    stdout: Capture,
    stderr: Capture,
    terminal: Option<serde_json::Value>,
}

#[cfg(test)]
async fn frames(stream: impl AsyncRead + Unpin) -> Result<Frames> {
    frames_with_limit(stream, MAX_STREAM_BYTES).await
}

async fn frames_with_limit(stream: impl AsyncRead + Unpin, stdout_limit: usize) -> Result<Frames> {
    let mut stream = BufReader::new(stream);
    let mut result = Frames::default();
    result.stdout.limit = stdout_limit;
    loop {
        let mut line = Vec::new();
        // A malformed peer must not allocate an unbounded line. Protocol
        // chunks are 16 KiB before base64 and JSON framing.
        let count = (&mut stream)
            .take(32 * 1024)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|e| backend_err(format!("CUA exec frame read failed: {e}")))?;
        if count == 0 {
            return Ok(result);
        }
        if line.last() != Some(&b'\n') {
            return Err(backend_err("CUA exec frame exceeds protocol limit"));
        }
        if result.terminal.is_some() {
            return Err(backend_err("CUA exec received output after terminal frame"));
        }
        let value: serde_json::Value = serde_json::from_slice(&line)
            .map_err(|e| backend_err(format!("CUA exec invalid protocol frame: {e}")))?;
        if value.get("exit_code").is_some() {
            result.terminal = Some(value);
        } else {
            let (kind, capture) = if value.get("stdout").is_some() {
                ("stdout", &mut result.stdout)
            } else {
                ("stderr", &mut result.stderr)
            };
            let encoded = value[kind]
                .as_str()
                .ok_or_else(|| backend_err("CUA exec invalid stream frame"))?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| backend_err("CUA exec invalid base64 output"))?;
            capture.append(&bytes);
        }
    }
}

pub(crate) struct SupervisedOutput {
    pub outcome: ExecOutcome,
    pub stdout_bytes: Vec<u8>,
}

#[cfg(test)]
pub(super) async fn supervised(
    command: &mut Command,
    argv: &[String],
    stdin: Option<&str>,
    timeout: Duration,
) -> Result<SupervisedOutput> {
    supervised_with_env(
        command,
        argv,
        stdin,
        timeout,
        &std::collections::BTreeMap::new(),
    )
    .await
}

#[cfg(test)]
pub(super) async fn supervised_with_env(
    command: &mut Command,
    argv: &[String],
    stdin: Option<&str>,
    timeout: Duration,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<SupervisedOutput> {
    supervised_with_limits(
        command,
        argv,
        stdin,
        timeout,
        env,
        MAX_STREAM_BYTES,
        MAX_STREAM_BYTES,
    )
    .await
}

/// File operations have a separate bounded envelope; generic exec stays at 1 MiB.
pub(super) async fn supervised_with_limits(
    command: &mut Command,
    argv: &[String],
    stdin: Option<&str>,
    timeout: Duration,
    env: &std::collections::BTreeMap<String, String>,
    input_limit: usize,
    stdout_limit: usize,
) -> Result<SupervisedOutput> {
    // Bound the envelope before serializing; input is one frame while output
    // is streamed. This is independent of the captured-output limit.
    if stdin.is_some_and(|input| input.len() > input_limit)
        || argv.iter().map(String::len).sum::<usize>() > 1024 * 1024
        || env
            .iter()
            .map(|(key, value)| key.len().saturating_add(value.len()))
            .sum::<usize>()
            > 1024 * 1024
    {
        return Err(backend_err(
            "CUA exec input or argv exceeds the configured limit (generic exec: 1 MiB)",
        ));
    }
    let envelope = serde_json::to_vec(&serde_json::json!({
        "argv": argv, "stdin": stdin.unwrap_or_default(), "env": env,
        "timeout_ms": timeout.as_millis().min(u64::MAX as u128) as u64,
    }))
    .map_err(|e| backend_err(e.to_string()))?;
    let started = Instant::now();
    let mut child = command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| backend_err(format!("CUA exec could not spawn: {e}")))?;
    let mut input = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let heartbeat = async {
        input
            .write_all(&envelope)
            .await
            .map_err(|e| backend_err(e.to_string()))?;
        input
            .write_all(b"\n")
            .await
            .map_err(|e| backend_err(e.to_string()))?;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            input
                .write_all(b".\n")
                .await
                .map_err(|e| backend_err(e.to_string()))?;
        }
        #[allow(unreachable_code)]
        Ok::<(), super::AutomationError>(())
    };
    let completion = async {
        let (status, output, diagnostics) = tokio::try_join!(
            async { child.wait().await.map_err(|e| backend_err(e.to_string())) },
            frames_with_limit(stdout, stdout_limit),
            capture(stderr),
        )?;
        if !status.success() {
            return Err(backend_err(format!(
                "CUA supervised exec unavailable or failed (requires Python 3, Linux /proc and prctl): {}",
                diagnostics.text().trim()
            )));
        }
        let terminal = output
            .terminal
            .ok_or_else(|| backend_err("CUA exec ended without cleanup confirmation"))?;
        if terminal["cleaned"] != true {
            return Err(backend_err(
                "CUA exec could not confirm process tree cleanup",
            ));
        }
        if terminal["cancelled"] == true {
            return Err(backend_err(
                "CUA exec caller lease expired; process tree was terminated",
            ));
        }
        let exit_code = terminal["exit_code"]
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .ok_or_else(|| backend_err("CUA exec missing exit status"))?;
        let timed_out = terminal["timed_out"]
            .as_bool()
            .ok_or_else(|| backend_err("CUA exec missing timeout status"))?;
        Ok(SupervisedOutput {
            outcome: ExecOutcome {
                exit_code,
                stdout: output.stdout.text(),
                stderr: output.stderr.text(),
                timed_out,
                duration_ms: started.elapsed().as_millis() as u64,
                stdout_truncated: output.stdout.text_truncated(),
                stderr_truncated: output.stderr.text_truncated(),
            },
            stdout_bytes: output.stdout.bytes,
        })
    };
    // No detached task: cancellation drops heartbeat and kill-on-drop kills
    // the local Docker client. The in-container lease remains authoritative
    // even if Docker fails to forward EOF after host loss.
    tokio::pin!(completion, heartbeat);
    let operation = async {
        tokio::select! {
            biased;
            result = &mut completion => result,
            _ = &mut heartbeat => completion.await,
        }
    };
    // Includes envelope/stdin writes. Extra time is only for in-container
    // cleanup and transport; requested command runtime is enforced there.
    tokio::time::timeout(timeout.saturating_add(Duration::from_secs(15)), operation).await
        .map_err(|_| backend_err("CUA exec transport deadline exceeded; container cleanup is unconfirmed (lease expiry remains active)"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn fake_supervisor(script: &str) -> Command {
        let mut command = Command::new("python3");
        command.args(["-I", "-u", "-c", script]);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_budget_accepts_binary_envelopes_without_raising_generic_exec_limits() {
        let payload = "x".repeat(MAX_STREAM_BYTES + 4096);
        let script = r#"import sys,json,base64
request=json.loads(sys.stdin.readline())
data=request['stdin'].encode()
for offset in range(0,len(data),16384):
 print(json.dumps({'stdout':base64.b64encode(data[offset:offset+16384]).decode()}),flush=True)
print(json.dumps({'exit_code':0,'timed_out':False,'cancelled':False,'cleaned':True}),flush=True)
"#;
        assert!(supervised(
            &mut fake_supervisor(script),
            &["ignored".into()],
            Some(&payload),
            Duration::from_secs(5)
        )
        .await
        .is_err());
        let result = supervised_with_limits(
            &mut fake_supervisor(script),
            &["ignored".into()],
            Some(&payload),
            Duration::from_secs(5),
            &Default::default(),
            2 * MAX_STREAM_BYTES,
            2 * MAX_STREAM_BYTES,
        )
        .await
        .unwrap();
        assert_eq!(result.stdout_bytes, payload.as_bytes());
        assert!(!result.outcome.stdout_truncated);
        assert_eq!(result.outcome.stdout.len(), payload.len());
    }

    #[tokio::test]
    async fn capture_drains_but_retains_only_the_stream_cap() {
        let bytes = vec![b'x'; MAX_STREAM_BYTES + 100];
        let result = capture(bytes.as_slice()).await.unwrap();
        assert_eq!(result.bytes.len(), MAX_STREAM_BYTES);
        assert!(result.truncated);
    }

    #[tokio::test]
    async fn frames_reject_unbounded_and_unconfirmed_output() {
        let bytes = vec![b'x'; 64 * 1024];
        assert!(frames(bytes.as_slice()).await.is_err());
        let result = frames(b"{\"stdout\":\"aGk=\"}\n".as_slice()).await.unwrap();
        assert_eq!(result.stdout.text(), "hi");
        assert!(result.terminal.is_none());
    }

    #[test]
    fn capped_utf8_does_not_invent_a_replacement_character() {
        let mut capture = Capture::default();
        capture.append("你".repeat(MAX_STREAM_BYTES).as_bytes());
        assert!(capture.truncated);
        assert!(!capture.text().contains('\u{fffd}'));
        let mut invalid = Capture::default();
        invalid.append(&vec![0xff; MAX_STREAM_BYTES]);
        assert!(invalid.text().len() <= MAX_STREAM_BYTES);
        assert!(invalid.text_truncated());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn transport_preserves_literal_argv_stdin_and_command_exit_124() {
        let mut command = fake_supervisor(
            r#"
import sys,json,base64
request=json.loads(sys.stdin.readline())
data=json.dumps(request['argv'])+'|'+request['stdin']
print(json.dumps({'stdout':base64.b64encode(data.encode()).decode()}),flush=True)
print(json.dumps({'exit_code':124,'timed_out':False,'cancelled':False,'cleaned':True}),flush=True)
"#,
        );
        let result = supervised(
            &mut command,
            &["echo".into(), "$(touch /never); quoted ' input".into()],
            Some("line one\nline two"),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(result.outcome.exit_code, 124);
        assert!(!result.outcome.timed_out);
        assert!(result.outcome.stdout.contains("$(touch /never)"));
        assert!(result.outcome.stdout.ends_with("line one\nline two"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn transport_drains_both_streams_beyond_capture_limit() {
        let mut command = fake_supervisor(
            r#"
import sys,json,base64
sys.stdin.readline()
chunk=base64.b64encode(b'x'*16384).decode()
for _ in range(100):
 for kind in ['stdout','stderr']:
  print(json.dumps({kind:chunk}),flush=True)
print(json.dumps({'exit_code':0,'timed_out':False,'cancelled':False,'cleaned':True}),flush=True)
"#,
        );
        let result = supervised(&mut command, &["true".into()], None, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(result.stdout_bytes.len(), MAX_STREAM_BYTES);
        assert_eq!(result.outcome.stderr.len(), MAX_STREAM_BYTES);
        assert!(result.outcome.stdout_truncated && result.outcome.stderr_truncated);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn transport_refuses_missing_or_failed_cleanup_confirmation() {
        for terminal in ["{}", r#"{"exit_code":0,"timed_out":false,"cleaned":false}"#] {
            let script =
                format!("import sys\nsys.stdin.readline()\nprint({terminal:?},flush=True)");
            let result = supervised(
                &mut fake_supervisor(&script),
                &["true".into()],
                None,
                Duration::from_secs(5),
            )
            .await;
            assert!(result.is_err());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_reaps_the_local_transport_process() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let script = format!(
            "import sys,os,time\nopen({:?},'w').write(str(os.getpid()))\nsys.stdin.readline()\ntime.sleep(60)",
            file.path().to_str().unwrap()
        );
        let task = tokio::spawn(async move {
            supervised(
                &mut fake_supervisor(&script),
                &["true".into()],
                None,
                Duration::from_secs(60),
            )
            .await
        });
        let mut pid = String::new();
        for _ in 0..100 {
            pid = std::fs::read_to_string(file.path()).unwrap();
            if !pid.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!pid.is_empty());
        task.abort();
        let _ = task.await;
        for _ in 0..100 {
            let exists = Command::new("kill")
                .args(["-0", &pid])
                .stderr(Stdio::null())
                .status()
                .await
                .unwrap()
                .success();
            if !exists {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("cancelled local transport survived kill-on-drop");
    }

    #[tokio::test]
    #[ignore = "requires Docker and COGNIA_CUA_TEST_PYTHON_IMAGE naming a local Linux Python3 image"]
    async fn live_supervisor_cleans_timeout_descendants_and_handles_stdin_backpressure() {
        let image = std::env::var("COGNIA_CUA_TEST_PYTHON_IMAGE").expect("local Python3 image");
        let name = format!("cognia-cua-exec-test-{}", uuid::Uuid::new_v4());
        let mut command = Command::new("docker");
        command.args([
            "run",
            "--rm",
            "-i",
            "--name",
            &name,
            "--entrypoint",
            "python3",
            &image,
            "-I",
            "-u",
            "-c",
            SUPERVISOR,
        ]);
        let script = "import os,time,signal; child=os.fork(); os.setsid() if child == 0 else None; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('started',flush=True); time.sleep(60)";
        let result = supervised(
            &mut command,
            &["python3".into(), "-c".into(), script.into()],
            Some(&"x".repeat(1024 * 1024)),
            Duration::from_millis(500),
        )
        .await
        .unwrap();
        assert!(result.outcome.timed_out);
        assert!(result.outcome.stdout.contains("started"));
        // Success itself requires an explicit in-container cleanup frame.
        assert!(!Command::new("docker")
            .args(["inspect", &name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .unwrap()
            .success());
    }

    #[tokio::test]
    #[ignore = "requires Docker and COGNIA_CUA_TEST_PYTHON_IMAGE naming a local Linux Python3 image"]
    async fn live_supervisor_lease_survives_lost_docker_client() {
        let image = std::env::var("COGNIA_CUA_TEST_PYTHON_IMAGE").expect("local Python3 image");
        let name = format!("cognia-cua-lease-test-{}", uuid::Uuid::new_v4());
        let mut command = Command::new("docker");
        command.args([
            "run",
            "--rm",
            "-i",
            "--name",
            &name,
            "--entrypoint",
            "python3",
            &image,
            "-I",
            "-u",
            "-c",
            SUPERVISOR,
        ]);
        let task = tokio::spawn(async move {
            supervised(
                &mut command,
                &["sleep".into(), "60".into()],
                None,
                Duration::from_secs(60),
            )
            .await
        });
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(
            !task.is_finished(),
            "supervised command exited before the disconnect test"
        );
        assert!(
            Command::new("docker")
                .args(["inspect", &name])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .unwrap()
                .success(),
            "supervisor container was never created"
        );
        task.abort();
        let _ = task.await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while tokio::time::Instant::now() < deadline {
            if !Command::new("docker")
                .args(["inspect", &name])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .unwrap()
                .success()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let _ = Command::new("docker")
            .args(["rm", "-f", &name])
            .output()
            .await;
        panic!("supervisor survived lost caller beyond the heartbeat lease");
    }

    #[tokio::test]
    #[ignore = "requires Docker and COGNIA_CUA_TEST_PYTHON_IMAGE naming a local Linux Python3 image"]
    async fn live_supervisor_expires_an_open_but_unrenewed_lease() {
        let image = std::env::var("COGNIA_CUA_TEST_PYTHON_IMAGE").expect("local Python3 image");
        let mut child = Command::new("docker")
            .args([
                "run",
                "--rm",
                "-i",
                "--entrypoint",
                "python3",
                &image,
                "-I",
                "-u",
                "-c",
                SUPERVISOR,
            ])
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        input
            .write_all(b"{\"argv\":[\"sleep\",\"60\"],\"stdin\":\"\",\"timeout_ms\":60000}\n")
            .await
            .unwrap();
        // Retain stdin without heartbeats: proves the deadline is independent
        // of Docker forwarding EOF from a disconnected host transport.
        let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        drop(input);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let terminal = frames(output.stdout.as_slice())
            .await
            .unwrap()
            .terminal
            .unwrap();
        assert_eq!(terminal["cleaned"], true);
        assert_eq!(terminal["cancelled"], true);
        assert_eq!(terminal["timed_out"], false);
    }

    #[tokio::test]
    #[ignore = "requires Docker and COGNIA_CUA_TEST_PYTHON_IMAGE naming a local Linux Python3 image"]
    async fn live_supervisor_request_environment_cannot_replace_bootstrap() {
        let image = std::env::var("COGNIA_CUA_TEST_PYTHON_IMAGE").expect("local Python3 image");
        let setup = r#"mkdir -p /tmp/cua-spoof; printf '#!/bin/sh\necho forged-bootstrap > /tmp/cua-injected\n' > /tmp/cua-spoof/python3; chmod +x /tmp/cua-spoof/python3; printf 'open("/tmp/cua-injected","w").write("injected")\n' > /tmp/cua-spoof/sitecustomize.py; exec /bin/sh -c "$1" bootstrap "$2""#;
        let mut command = Command::new("docker");
        command.args([
            "run",
            "--rm",
            "-i",
            "--entrypoint",
            "/bin/sh",
            &image,
            "-c",
            setup,
            "setup",
            PYTHON_BOOTSTRAP,
            SUPERVISOR,
        ]);
        let env = std::collections::BTreeMap::from([
            ("PATH".into(), "/tmp/cua-spoof".into()),
            ("PYTHONPATH".into(), "/tmp/cua-spoof".into()),
        ]);
        let result = supervised_with_env(
            &mut command,
            &[
                "/bin/sh".into(),
                "-c".into(),
                "printf '%s' \"$PATH\"; test ! -e /tmp/cua-injected".into(),
            ],
            None,
            Duration::from_secs(5),
            &env,
        )
        .await
        .unwrap();
        assert_eq!(result.outcome.exit_code, 0);
        assert_eq!(result.outcome.stdout, "/tmp/cua-spoof");
    }

    #[tokio::test]
    #[ignore = "requires Docker and COGNIA_CUA_TEST_PYTHON_IMAGE naming a local Linux Python3 image"]
    async fn live_supervisor_child_cannot_access_parent_protocol_or_memory() {
        let image = std::env::var("COGNIA_CUA_TEST_PYTHON_IMAGE").expect("local Python3 image");
        let mut command = Command::new("docker");
        command.args([
            "run",
            "--rm",
            "-i",
            "--entrypoint",
            "/bin/sh",
            &image,
            "-c",
            PYTHON_BOOTSTRAP,
            "bootstrap",
            SUPERVISOR,
        ]);
        let script = r#"import os,sys
for target in ['fd/1','fd/2','mem']:
 try:
  fd=os.open('/proc/'+str(os.getppid())+'/'+target,os.O_WRONLY)
  os.close(fd)
  sys.exit(42)
 except PermissionError:
  pass
print('parent-control-protected')
"#;
        let result = supervised(
            &mut command,
            &["/usr/local/bin/python3".into(), "-c".into(), script.into()],
            None,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(result.outcome.exit_code, 0, "{}", result.outcome.stderr);
        assert_eq!(result.outcome.stdout.trim(), "parent-control-protected");
    }
}
