//! Docker container lifecycle for cua desktop sandboxes (ADR-0020
//! remote-target). cognia shells the `docker` CLI to create, start, pause,
//! stop, remove and probe a `ghcr.io/trycua/cua-xfce` container exposing
//! `computer-server` on :8000. The container is the isolation boundary (same
//! model as the existing e2b microvm tier), and fine-grained policy is not
//! applied inside it.
//!
//! Containers are deliberately NOT created with `--rm`. With `--rm` a stop
//! also destroys the container, which collapses three distinct operations
//! (stop, delete, and "start fresh") into two and loses every file the user
//! wrote inside the machine. A cloud machine that forgets itself on every stop
//! is not a machine. Removal is therefore explicit, via `docker_remove`.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::automation::types::{AutomationError, Result};

/// Container-level isolation settings. Docker fixes all of these at create
/// time: `docker exec` cannot change the network mode or the cpu/memory
/// ceiling of a running container. They are recorded here so the renderer can
/// attest a per-call policy request against what the container actually got,
/// and refuse rather than silently run something less confined than asked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContainerPolicy {
    /// `--network`. `None` leaves Docker's default bridge network.
    pub network_mode: Option<String>,
    /// `--cpus`, e.g. "1.5". `None` leaves the cpu allowance uncapped.
    pub cpus: Option<String>,
    /// `--memory`, in MiB. `None` leaves memory uncapped.
    pub memory_mb: Option<u64>,
    /// A single `-v host:container` bind mount for the session workspace.
    pub workspace_mount: Option<WorkspaceMount>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceMount {
    pub host_path: String,
    pub container_path: String,
}

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    /// e.g. `ghcr.io/trycua/cua-xfce:latest`.
    pub image: String,
    /// `docker --name`, derived from the connection id (`cua-<id>`).
    pub name: String,
    /// Isolation settings frozen into the container at create time.
    pub policy: ContainerPolicy,
}

/// What `docker inspect` says about one container. This is the only source of
/// truth for lifecycle state: the in-process registry records what we asked
/// for, which is not the same thing as what Docker did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerState {
    /// `.Id`, the full container id. Recorded on the connection row so the UI
    /// can show which container a row actually owns.
    pub id: String,
    /// Docker's own `.State.Status`: created, running, paused, restarting,
    /// removing, exited, or dead.
    pub status: String,
    pub running: bool,
    pub paused: bool,
    /// `.HostConfig.NetworkMode`.
    pub network_mode: String,
    /// `.HostConfig.NanoCpus`. Zero means uncapped.
    pub nano_cpus: i64,
    /// `.HostConfig.Memory`, in bytes. Zero means uncapped.
    pub memory_bytes: i64,
}

/// Result of running one command inside a container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutcome {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Per-stream cap on captured output. Matches the transport cap the renderer
/// reports through `MicrovmResult.stdout_truncated`.
pub const MAX_STREAM_BYTES: usize = 1024 * 1024;

/// The `docker inspect --format` template. One line, `|`-separated, so a single
/// round-trip answers both "what state is it in" and "what policy did it get".
const INSPECT_FORMAT: &str = "{{.Id}}|{{.State.Status}}|{{.State.Running}}|{{.State.Paused}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}";

fn backend_err(msg: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: msg.into(),
    }
}

/// `docker run -d -p 0:8000 [policy flags] --name <name> <image>`.
///
/// `-p 0:8000` asks Docker for an ephemeral host port mapped to the
/// container's computer-server. The image is always the final argument so no
/// policy flag can be mistaken for the image name.
pub fn run_args(spec: &SpawnSpec) -> Vec<String> {
    let mut args: Vec<String> = vec!["run".into(), "-d".into(), "-p".into(), "0:8000".into()];
    if let Some(network) = &spec.policy.network_mode {
        args.push("--network".into());
        args.push(network.clone());
    }
    if let Some(cpus) = &spec.policy.cpus {
        args.push("--cpus".into());
        args.push(cpus.clone());
    }
    if let Some(memory_mb) = spec.policy.memory_mb {
        args.push("--memory".into());
        args.push(format!("{memory_mb}m"));
    }
    if let Some(mount) = &spec.policy.workspace_mount {
        args.push("-v".into());
        args.push(format!("{}:{}", mount.host_path, mount.container_path));
    }
    args.push("--name".into());
    args.push(spec.name.clone());
    args.push(spec.image.clone());
    args
}

/// `docker create ...`, the same shape as {@link run_args} without `-d`.
///
/// Create is separate from start because they are different lifecycle answers:
/// a created container exists, holds its image and its frozen policy, and has
/// written nothing yet. Collapsing the two would leave no way to say "the
/// machine is provisioned but not running".
pub fn create_args(spec: &SpawnSpec) -> Vec<String> {
    let mut args = run_args(spec);
    args[0] = "create".into();
    args.retain(|a| a != "-d");
    args
}

/// Run a `docker` subcommand, failing on a non-zero exit. Returns trimmed stdout.
async fn docker(args: &[&str], what: &str) -> Result<String> {
    let out = Command::new("docker")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| {
            backend_err(format!(
                "{what} could not spawn (is Docker installed?): {e}"
            ))
        })?;
    if !out.status.success() {
        return Err(backend_err(format!(
            "{what} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Create and start the container. Returns its container id.
pub async fn docker_run(spec: &SpawnSpec) -> Result<String> {
    let args = run_args(spec);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    docker(&borrowed, "docker run").await
}

/// Create the container without starting it. Returns its container id.
pub async fn docker_create(spec: &SpawnSpec) -> Result<String> {
    let args = create_args(spec);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    docker(&borrowed, "docker create").await
}

/// `docker start <id>` on a container that already exists but is stopped.
pub async fn docker_start(container: &str) -> Result<()> {
    docker(&["start", container], "docker start")
        .await
        .map(|_| ())
}

/// `docker stop <id>`. The container survives, along with its filesystem.
pub async fn docker_stop(container: &str) -> Result<()> {
    docker(&["stop", container], "docker stop")
        .await
        .map(|_| ())
}

/// `docker pause <id>`. SIGSTOPs every process and keeps memory resident, so
/// a paused desktop still has its windows and its session when it resumes.
/// This is what suspend means. `docker stop` is not a suspend.
pub async fn docker_pause(container: &str) -> Result<()> {
    docker(&["pause", container], "docker pause")
        .await
        .map(|_| ())
}

pub async fn docker_unpause(container: &str) -> Result<()> {
    docker(&["unpause", container], "docker unpause")
        .await
        .map(|_| ())
}

/// `docker rm -f <id>`. Destroys the container and everything written inside
/// it that is not on a bind mount.
pub async fn docker_remove(container: &str) -> Result<()> {
    docker(&["rm", "-f", container], "docker rm")
        .await
        .map(|_| ())
}

/// `docker port <id> 8000/tcp` mapped to e.g. `0.0.0.0:49160`, yielding `49160`.
pub async fn resolve_port(container_id: &str) -> Result<u16> {
    let text = docker(&["port", container_id, "8000/tcp"], "docker port").await?;
    parse_port(&text)
        .ok_or_else(|| backend_err(format!("no mapped port in `docker port` output: {text:?}")))
}

/// Extracts the port from a `docker port` line such as `0.0.0.0:49160` or
/// `[::]:49161`, being the trailing `:`-delimited number.
fn parse_port(s: &str) -> Option<u16> {
    s.lines()
        .next()?
        .trim()
        .rsplit(':')
        .next()?
        .trim()
        .parse()
        .ok()
}

/// Read the container's real state, or `None` when no such container exists.
///
/// A missing container is not an error: it is the answer to "should I adopt or
/// create". Every other failure (daemon down, permission denied) still errors,
/// because treating those as "absent" would silently create a second machine.
pub async fn docker_inspect(name_or_id: &str) -> Result<Option<ContainerState>> {
    let out = Command::new("docker")
        .args(["inspect", "--format", INSPECT_FORMAT, name_or_id])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| backend_err(format!("docker inspect could not spawn: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if is_no_such_object(&stderr) {
            return Ok(None);
        }
        return Err(backend_err(format!(
            "docker inspect failed: {}",
            stderr.trim()
        )));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    parse_inspect(&text)
        .map(Some)
        .ok_or_else(|| backend_err(format!("unparseable `docker inspect` output: {text:?}")))
}

/// Docker reports an absent container on stderr rather than with a distinct
/// exit code, so the message is the only signal available.
fn is_no_such_object(stderr: &str) -> bool {
    let lowered = stderr.to_ascii_lowercase();
    lowered.contains("no such object") || lowered.contains("no such container")
}

fn parse_inspect(text: &str) -> Option<ContainerState> {
    let line = text.lines().next()?.trim();
    let mut parts = line.split('|');
    let id = parts.next()?.trim().to_string();
    let status = parts.next()?.trim().to_string();
    let running = parts.next()?.trim() == "true";
    let paused = parts.next()?.trim() == "true";
    let network_mode = parts.next()?.trim().to_string();
    let nano_cpus = parts.next()?.trim().parse().unwrap_or(0);
    let memory_bytes = parts.next()?.trim().parse().unwrap_or(0);
    if status.is_empty() || id.is_empty() {
        return None;
    }
    Some(ContainerState {
        id,
        status,
        running,
        paused,
        network_mode,
        nano_cpus,
        memory_bytes,
    })
}

/// `docker exec <id> true` succeeds only while the container is running.
pub async fn docker_health(container_id: &str) -> bool {
    Command::new("docker")
        .args(["exec", container_id, "true"])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Build the argument vector for `docker exec`. `argv` is passed through as
/// separate arguments and never joined into a shell string, so a path or an
/// environment value containing a space or a quote cannot become a second
/// command.
pub fn exec_args<'a>(
    container: &'a str,
    argv: &'a [String],
    cwd: Option<&'a str>,
    env: &'a BTreeMap<String, String>,
    with_stdin: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["exec".into()];
    if with_stdin {
        args.push("-i".into());
    }
    if let Some(cwd) = cwd {
        args.push("-w".into());
        args.push(cwd.to_string());
    }
    for (key, value) in env {
        args.push("-e".into());
        args.push(format!("{key}={value}"));
    }
    args.push(container.to_string());
    args.extend(argv.iter().cloned());
    args
}

/// Run one command inside the container.
///
/// A timeout kills the `docker exec` client, which does NOT kill the process
/// inside the container. `timed_out` says so honestly rather than implying the
/// work stopped.
pub async fn docker_exec(
    container: &str,
    argv: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
    stdin: Option<&str>,
    timeout: Duration,
) -> Result<ExecOutcome> {
    if argv.is_empty() {
        return Err(backend_err("docker exec requires a command to run"));
    }
    let args = exec_args(container, argv, cwd, env, stdin.is_some());
    let started = Instant::now();
    let mut child = Command::new("docker")
        .args(&args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| backend_err(format!("docker exec could not spawn: {e}")))?;

    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            // A closed stdin means the command exited before reading it, which
            // is a normal outcome rather than a failure of this call.
            let _ = pipe.write_all(input.as_bytes()).await;
            let _ = pipe.shutdown().await;
        }
    }

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => {
            let out =
                result.map_err(|e| backend_err(format!("docker exec could not complete: {e}")))?;
            let (stdout, stdout_truncated) = cap_stream(&out.stdout);
            let (stderr, stderr_truncated) = cap_stream(&out.stderr);
            Ok(ExecOutcome {
                exit_code: out.status.code().unwrap_or(-1),
                stdout,
                stderr,
                duration_ms: started.elapsed().as_millis() as u64,
                timed_out: false,
                stdout_truncated,
                stderr_truncated,
            })
        }
        Err(_) => Ok(ExecOutcome {
            exit_code: -1,
            stdout: String::new(),
            stderr: format!(
                "timed out after {}ms waiting for `docker exec`. The command may still be running inside the container.",
                timeout.as_millis()
            ),
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out: true,
            stdout_truncated: false,
            stderr_truncated: false,
        }),
    }
}

/// Read one file from inside the container.
pub async fn docker_read_file(container: &str, path: &str, max_bytes: usize) -> Result<String> {
    let argv = vec!["cat".to_string(), path.to_string()];
    let outcome = docker_exec(
        container,
        &argv,
        None,
        &BTreeMap::new(),
        None,
        Duration::from_secs(30),
    )
    .await?;
    if outcome.timed_out {
        return Err(backend_err(format!("reading '{path}' timed out")));
    }
    if outcome.exit_code != 0 {
        return Err(backend_err(format!(
            "could not read '{path}' inside the container: {}",
            outcome.stderr.trim()
        )));
    }
    if outcome.stdout.len() > max_bytes {
        return Err(backend_err(format!(
            "'{path}' is larger than the {max_bytes} byte read limit"
        )));
    }
    Ok(outcome.stdout)
}

/// Truncate to the per-stream cap on a char boundary, reporting whether it hit.
fn cap_stream(raw: &[u8]) -> (String, bool) {
    if raw.len() <= MAX_STREAM_BYTES {
        return (String::from_utf8_lossy(raw).into_owned(), false);
    }
    let mut end = MAX_STREAM_BYTES;
    while end > 0 && !raw.is_char_boundary_at(end) {
        end -= 1;
    }
    (String::from_utf8_lossy(&raw[..end]).into_owned(), true)
}

/// `str::is_char_boundary` over a byte slice, without an intermediate `String`.
trait CharBoundary {
    fn is_char_boundary_at(&self, index: usize) -> bool;
}

impl CharBoundary for [u8] {
    fn is_char_boundary_at(&self, index: usize) -> bool {
        // A UTF-8 continuation byte matches 0b10xxxxxx. Any other byte, and the
        // end of the slice, starts a new character.
        match self.get(index) {
            None => true,
            Some(byte) => (*byte as i8) >= -0x40,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(policy: ContainerPolicy) -> SpawnSpec {
        SpawnSpec {
            image: "img".into(),
            name: "cua-c1".into(),
            policy,
        }
    }

    #[test]
    fn run_args_have_port_and_name() {
        let a = run_args(&spec(ContainerPolicy::default()));
        assert!(a.contains(&"0:8000".to_string()));
        assert!(a.contains(&"cua-c1".to_string()));
        assert_eq!(a.first().map(String::as_str), Some("run"));
        assert_eq!(a.last().map(String::as_str), Some("img"));
    }

    #[test]
    fn run_args_never_pass_rm() {
        // `--rm` would delete the container on stop, which destroys every file
        // the user wrote and collapses stop into delete. Regression guard.
        let a = run_args(&spec(ContainerPolicy::default()));
        assert!(!a.contains(&"--rm".to_string()));
    }

    #[test]
    fn run_args_carry_the_container_policy() {
        let a = run_args(&spec(ContainerPolicy {
            network_mode: Some("none".into()),
            cpus: Some("1.5".into()),
            memory_mb: Some(2048),
            workspace_mount: Some(WorkspaceMount {
                host_path: "/host/ws".into(),
                container_path: "/workspace".into(),
            }),
        }));
        let joined = a.join(" ");
        assert!(joined.contains("--network none"));
        assert!(joined.contains("--cpus 1.5"));
        assert!(joined.contains("--memory 2048m"));
        assert!(joined.contains("-v /host/ws:/workspace"));
        // The image stays last so no policy value can be read as the image.
        assert_eq!(a.last().map(String::as_str), Some("img"));
    }

    #[test]
    fn create_args_drop_the_detach_flag_and_keep_policy() {
        let a = create_args(&spec(ContainerPolicy {
            network_mode: Some("none".into()),
            ..ContainerPolicy::default()
        }));
        assert_eq!(a.first().map(String::as_str), Some("create"));
        assert!(!a.contains(&"-d".to_string()));
        assert!(a.join(" ").contains("--network none"));
        assert_eq!(a.last().map(String::as_str), Some("img"));
    }

    #[test]
    fn parse_port_extracts_last_colon_segment() {
        assert_eq!(parse_port("0.0.0.0:49160\n"), Some(49160));
        assert_eq!(parse_port("[::]:49161\n"), Some(49161));
        assert_eq!(parse_port(""), None);
        assert_eq!(parse_port("garbage"), None);
    }

    #[test]
    fn parse_inspect_reads_state_and_policy() {
        let parsed =
            parse_inspect("abc123|running|true|false|none|1500000000|2147483648\n").unwrap();
        assert_eq!(parsed.id, "abc123");
        assert_eq!(parsed.status, "running");
        assert!(parsed.running);
        assert!(!parsed.paused);
        assert_eq!(parsed.network_mode, "none");
        assert_eq!(parsed.nano_cpus, 1_500_000_000);
        assert_eq!(parsed.memory_bytes, 2_147_483_648);
    }

    #[test]
    fn parse_inspect_reads_a_paused_container() {
        let parsed = parse_inspect("abc123|paused|true|true|bridge|0|0").unwrap();
        // Docker keeps `.State.Running` true while paused. Suspended is not
        // stopped, and the two must not be conflated.
        assert!(parsed.running);
        assert!(parsed.paused);
        assert_eq!(parsed.status, "paused");
    }

    #[test]
    fn parse_inspect_rejects_junk() {
        assert!(parse_inspect("").is_none());
        assert!(parse_inspect("only|three|fields").is_none());
        assert!(parse_inspect("abc123||true|false|bridge|0|0").is_none());
        assert!(parse_inspect("|running|true|false|bridge|0|0").is_none());
    }

    #[test]
    fn absent_container_is_recognised_from_stderr() {
        assert!(is_no_such_object("Error: No such object: cua-missing\n"));
        assert!(is_no_such_object(
            "Error response from daemon: No such container: abc"
        ));
        assert!(!is_no_such_object(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
        ));
    }

    #[test]
    fn exec_args_pass_argv_as_separate_arguments() {
        let mut env = BTreeMap::new();
        env.insert("FOO".to_string(), "bar baz".to_string());
        let argv = vec![
            "sh".to_string(),
            "-c".to_string(),
            "echo hi; rm -rf /".to_string(),
        ];
        let args = exec_args("cid", &argv, Some("/workspace"), &env, true);
        assert_eq!(args[0], "exec");
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"-w".to_string()));
        assert!(args.contains(&"/workspace".to_string()));
        assert!(args.contains(&"FOO=bar baz".to_string()));
        // The whole third argv element stays one argument. It is never split on
        // the semicolon, so it cannot become a second command.
        assert_eq!(args.last().map(String::as_str), Some("echo hi; rm -rf /"));
        let container_at = args.iter().position(|a| a == "cid").unwrap();
        assert_eq!(&args[container_at + 1..], &argv[..]);
    }

    #[test]
    fn exec_args_omit_stdin_flag_when_there_is_no_input() {
        let args = exec_args("cid", &["true".to_string()], None, &BTreeMap::new(), false);
        assert!(!args.contains(&"-i".to_string()));
        assert!(!args.contains(&"-w".to_string()));
    }

    #[test]
    fn cap_stream_reports_truncation_on_a_char_boundary() {
        let (text, truncated) = cap_stream(b"short");
        assert_eq!(text, "short");
        assert!(!truncated);

        // Multi-byte characters straddling the cap must not produce a
        // replacement character mid-sequence.
        let oversized: Vec<u8> = "\u{4f60}".repeat(MAX_STREAM_BYTES).into_bytes();
        let (text, truncated) = cap_stream(&oversized);
        assert!(truncated);
        assert!(text.len() <= MAX_STREAM_BYTES);
        assert!(!text.contains('\u{FFFD}'));
    }
}
