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

/// The process cap frozen into the container (`--pids-limit`). High enough
/// for a desktop session's normal fan-out, far below a fork bomb's reach.
pub const DEFAULT_PIDS_LIMIT: u64 = 512;

/// The user every `docker exec` runs as — the model's command channel. The
/// container's own entrypoint cannot use it: the cua-xfce supervisord must
/// start as root so it can launch session programs as `cua`, so the user
/// bound is applied to the exec channel instead of `--user` at create time.
pub const DEFAULT_EXEC_USER: &str = "cua";

/// The label recording `exec_user` on the container itself. It survives app
/// restarts, so an adopted container still carries the exec-user bound it was
/// created with, and attestation can compare it against what was asked.
pub const EXEC_USER_LABEL: &str = "cognia.cua.exec-user";

/// Container-level isolation settings. Docker fixes all of these at create
/// time: `docker exec` cannot change the network mode or the cpu/memory
/// ceiling of a running container. They are recorded here so the renderer can
/// attest a per-call policy request against what the container actually got,
/// and refuse rather than silently run something less confined than asked.
///
/// The defaults are the hardened profile: every field named "let Docker
/// decide" opted into the weaker behaviour, so `Default` now spells them out
/// explicitly and a field has to be turned OFF deliberately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerPolicy {
    /// `--network`. `None` leaves Docker's default bridge network, which the
    /// published computer-server port needs — `--network none` would cut the
    /// WebSocket the client drives the desktop through. Isolation comes from
    /// `publish_addr` (loopback) and the exec/capability/read-only bounds
    /// below, not from cutting the network.
    pub network_mode: Option<String>,
    /// `--cpus`, e.g. "1.5". `None` leaves the cpu allowance uncapped.
    pub cpus: Option<String>,
    /// `--memory`, in MiB. `None` leaves memory uncapped.
    pub memory_mb: Option<u64>,
    /// `--pids-limit`. `Some(0)`/`None` means unlimited (no flag emitted).
    pub pids_limit: Option<u64>,
    /// `--cap-drop` entries, in request order. The default drops `ALL`; the
    /// image's supervisor gets back only what `cap_add` re-grants.
    pub cap_drop: Vec<String>,
    /// `--cap-add` entries, re-granted after `cap_drop`. The cua-xfce
    /// supervisord runs as root and needs SETUID/SETGID to drop session
    /// programs to `cua`, CHOWN to hand the home dir over, and
    /// DAC_OVERRIDE/FOWNER to provision its runtime dirs.
    pub cap_add: Vec<String>,
    /// `--security-opt no-new-privileges` — no setuid binary or file
    /// capability may raise privilege inside the container.
    pub no_new_privileges: bool,
    /// `--read-only` root filesystem. The writable surface the desktop needs
    /// is restored surgically through `tmpfs_mounts` and `writable_dirs`.
    pub read_only_rootfs: bool,
    /// `--tmpfs` mounts, each `path` or `path:opts` verbatim.
    pub tmpfs_mounts: Vec<String>,
    /// Directories mounted as anonymous volumes (`-v <dir>`). Unlike tmpfs,
    /// an anonymous volume is seeded with the image's content — which is what
    /// the image's populated home directory needs under a read-only rootfs.
    pub writable_dirs: Vec<String>,
    /// The user every `docker exec` runs as (`-u`), applied to the command
    /// channel rather than the entrypoint. `None` leaves the image's default
    /// user — for the cua-xfce image that is root, which is exactly what the
    /// hardening is meant to prevent on the model-facing channel.
    pub exec_user: Option<String>,
    /// `--user` for the container entrypoint itself. `None` keeps the image's
    /// configured user; cua-xfce's supervisord must boot as root, so this is
    /// left unset by default and the user bound lives on `exec_user`.
    pub entrypoint_user: Option<String>,
    /// Host interface the computer-server port publishes on. The renderer
    /// only ever dials loopback, so publishing on `0.0.0.0` would expose the
    /// desktop's unauthenticated control socket to every host interface.
    pub publish_addr: String,
    /// A single `-v host:container` bind mount for the session workspace.
    pub workspace_mount: Option<WorkspaceMount>,
}

impl Default for ContainerPolicy {
    fn default() -> Self {
        Self {
            network_mode: None,
            cpus: None,
            memory_mb: None,
            pids_limit: Some(DEFAULT_PIDS_LIMIT),
            cap_drop: vec!["ALL".to_string()],
            cap_add: vec![
                "SETUID".to_string(),
                "SETGID".to_string(),
                "CHOWN".to_string(),
                "DAC_OVERRIDE".to_string(),
                "FOWNER".to_string(),
            ],
            no_new_privileges: true,
            read_only_rootfs: true,
            // The desktop's scratch surface under a read-only rootfs: X11
            // sockets land in /tmp, dbus and supervisord pids in /run, logs
            // in /var/log. /dev/shm is already writable (Docker mounts it).
            tmpfs_mounts: vec![
                "/tmp".to_string(),
                "/run".to_string(),
                "/run/lock".to_string(),
                "/var/log".to_string(),
            ],
            writable_dirs: vec!["/home/cua".to_string()],
            exec_user: Some(DEFAULT_EXEC_USER.to_string()),
            entrypoint_user: None,
            publish_addr: "127.0.0.1".to_string(),
            workspace_mount: None,
        }
    }
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
    /// `.HostConfig.PidsLimit`. Zero or negative means unlimited.
    pub pids_limit: i64,
    /// `.HostConfig.ReadonlyRootfs`.
    pub read_only_rootfs: bool,
    /// `.HostConfig.CapDrop`, e.g. `["ALL"]`.
    pub cap_drop: Vec<String>,
    /// `.HostConfig.SecurityOpt`, e.g. `["no-new-privileges"]`.
    pub security_opts: Vec<String>,
    /// The exec-user the container was created with, recorded on the
    /// `EXEC_USER_LABEL` label. `None` on containers that predate the label —
    /// an adopted container without it gives exec the image's default user.
    pub exec_user: Option<String>,
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
/// The label lookup is wrapped in `with` because `.Config.Labels` is nil on
/// unlabeled containers and `index` on a nil map still answers an empty string.
const INSPECT_FORMAT: &str = "{{.Id}}|{{.State.Status}}|{{.State.Running}}|{{.State.Paused}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.ReadonlyRootfs}}|{{join .HostConfig.CapDrop \",\"}}|{{join .HostConfig.SecurityOpt \",\"}}|{{with .Config.Labels}}{{index . \"cognia.cua.exec-user\"}}{{end}}";

fn backend_err(msg: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: msg.into(),
    }
}

/// `docker run -d -p <publish_addr>:0:8000 [policy flags] --name <name> <image>`.
///
/// `-p 127.0.0.1:0:8000` asks Docker for an ephemeral host port mapped to the
/// container's computer-server, bound to loopback only: the renderer dials it
/// locally, and binding every interface would publish the desktop's control
/// socket to the LAN. The image is always the final argument so no policy
/// flag can be mistaken for the image name.
pub fn run_args(spec: &SpawnSpec) -> Vec<String> {
    let policy = &spec.policy;
    let mut args: Vec<String> = vec![
        "run".into(),
        "-d".into(),
        "-p".into(),
        format!("{}:0:8000", policy.publish_addr),
    ];
    if let Some(network) = &policy.network_mode {
        args.push("--network".into());
        args.push(network.clone());
    }
    if let Some(cpus) = &policy.cpus {
        args.push("--cpus".into());
        args.push(cpus.clone());
    }
    if let Some(memory_mb) = policy.memory_mb {
        args.push("--memory".into());
        args.push(format!("{memory_mb}m"));
    }
    if let Some(limit) = policy.pids_limit.filter(|n| *n > 0) {
        args.push("--pids-limit".into());
        args.push(limit.to_string());
    }
    for cap in &policy.cap_drop {
        args.push("--cap-drop".into());
        args.push(cap.clone());
    }
    for cap in &policy.cap_add {
        args.push("--cap-add".into());
        args.push(cap.clone());
    }
    if policy.no_new_privileges {
        args.push("--security-opt".into());
        args.push("no-new-privileges".into());
    }
    if policy.read_only_rootfs {
        args.push("--read-only".into());
    }
    for mount in &policy.tmpfs_mounts {
        args.push("--tmpfs".into());
        args.push(mount.clone());
    }
    for dir in &policy.writable_dirs {
        args.push("-v".into());
        args.push(dir.clone());
    }
    if let Some(user) = &policy.exec_user {
        // Recorded, not enforced here: `docker exec` reads the label back
        // through inspect so an adopted container still runs commands under
        // the user it was created for.
        args.push("--label".into());
        args.push(format!("{EXEC_USER_LABEL}={user}"));
    }
    if let Some(user) = &policy.entrypoint_user {
        args.push("--user".into());
        args.push(user.clone());
    }
    if let Some(mount) = &policy.workspace_mount {
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

/// `docker rm -f -v <id>`. Destroys the container and everything written
/// inside it that is not on a bind mount — `-v` also reclaims the anonymous
/// volumes `writable_dirs` created, so a delete does not leak volumes.
pub async fn docker_remove(container: &str) -> Result<()> {
    docker(&["rm", "-f", "-v", container], "docker rm")
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
    let pids_limit = parts.next()?.trim().parse().unwrap_or(0);
    let read_only_rootfs = parts.next()?.trim() == "true";
    let cap_drop = split_joined(parts.next()?);
    let security_opts = split_joined(parts.next()?);
    let exec_user = parts
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
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
        pids_limit,
        read_only_rootfs,
        cap_drop,
        security_opts,
        exec_user,
    })
}

/// The `join`-rendered inspect fields arrive comma-separated; an empty field
/// means the container holds none of that list.
fn split_joined(field: &str) -> Vec<String> {
    field
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Compare a requested policy against what an already-existing container
/// actually has. Adoption reuses whatever Docker holds under the connection's
/// name; when that container predates the hardened defaults (or was created
/// by hand), taking it over would silently run weaker than the caller asked.
/// Every check is "at least as confined as requested", so a container that is
/// stricter than asked still adopts.
pub fn attest_adopted(policy: &ContainerPolicy, state: &ContainerState) -> Result<()> {
    let mut weaker: Vec<String> = Vec::new();
    if let Some(user) = &policy.exec_user {
        if state.exec_user.as_deref() != Some(user.as_str()) {
            weaker.push(format!(
                "exec user: requested {user}, container records {:?}",
                state.exec_user
            ));
        }
    }
    if let Some(limit) = policy.pids_limit.filter(|n| *n > 0) {
        // A recorded limit of 0 means unlimited — strictly weaker than any
        // requested cap. A recorded cap no higher than requested is fine.
        if state.pids_limit <= 0 || state.pids_limit > limit as i64 {
            weaker.push(format!(
                "pids limit: requested {limit}, container has {}",
                state.pids_limit
            ));
        }
    }
    if policy.read_only_rootfs && !state.read_only_rootfs {
        weaker.push("read-only rootfs: requested, container is writable".to_string());
    }
    if policy
        .cap_drop
        .iter()
        .any(|cap| cap.eq_ignore_ascii_case("all"))
        && !state
            .cap_drop
            .iter()
            .any(|cap| cap.eq_ignore_ascii_case("all"))
    {
        weaker.push("capabilities: requested cap-drop ALL, container drops nothing".to_string());
    }
    if policy.no_new_privileges
        && !state
            .security_opts
            .iter()
            .any(|opt| opt.starts_with("no-new-privileges"))
    {
        weaker.push("no-new-privileges: requested, container lacks it".to_string());
    }
    if let Some(network) = &policy.network_mode {
        if &state.network_mode != network {
            weaker.push(format!(
                "network: requested {network}, container has {}",
                state.network_mode
            ));
        }
    }
    if let Some(cpus) = &policy.cpus {
        if let Ok(requested) = cpus.parse::<f64>() {
            let requested_nano = (requested * 1e9) as i64;
            if state.nano_cpus != requested_nano {
                weaker.push(format!(
                    "cpus: requested {cpus}, container has {} nano-cpus",
                    state.nano_cpus
                ));
            }
        }
    }
    if let Some(memory_mb) = policy.memory_mb {
        let requested_bytes = memory_mb.saturating_mul(1024 * 1024).min(i64::MAX as u64) as i64;
        if state.memory_bytes != requested_bytes {
            weaker.push(format!(
                "memory: requested {memory_mb}m, container has {} bytes",
                state.memory_bytes
            ));
        }
    }
    if weaker.is_empty() {
        return Ok(());
    }
    Err(backend_err(format!(
        "existing container is less confined than the requested policy ({}); \
         delete the sandbox and start it again to re-create it hardened",
        weaker.join("; ")
    )))
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
/// command. `exec_user` becomes `-u`: the container's entrypoint must boot as
/// root, so the user bound lives here, on the channel the model actually
/// commands through.
pub fn exec_args<'a>(
    container: &'a str,
    argv: &'a [String],
    cwd: Option<&'a str>,
    env: &'a BTreeMap<String, String>,
    with_stdin: bool,
    exec_user: Option<&'a str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["exec".into()];
    if with_stdin {
        args.push("-i".into());
    }
    if let Some(user) = exec_user {
        args.push("-u".into());
        args.push(user.to_string());
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
    exec_user: Option<&str>,
) -> Result<ExecOutcome> {
    if argv.is_empty() {
        return Err(backend_err("docker exec requires a command to run"));
    }
    let args = exec_args(container, argv, cwd, env, stdin.is_some(), exec_user);
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

/// Read one file from inside the container. Reads ride the same exec channel
/// as commands, so they run under the same `exec_user` bound — a root read
/// would defeat the whole point of confining the exec user.
pub async fn docker_read_file(
    container: &str,
    path: &str,
    max_bytes: usize,
    exec_user: Option<&str>,
) -> Result<String> {
    let argv = vec!["cat".to_string(), path.to_string()];
    let outcome = docker_exec(
        container,
        &argv,
        None,
        &BTreeMap::new(),
        None,
        Duration::from_secs(30),
        exec_user,
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
        // Loopback-only publish: the renderer dials the port locally, so
        // nothing outside the host may reach the desktop's control socket.
        assert!(a.contains(&"127.0.0.1:0:8000".to_string()));
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
    fn run_args_default_to_the_hardened_profile() {
        // The audit's regression guard: the tier's defaults must emit every
        // isolation flag without the caller asking.
        let a = run_args(&spec(ContainerPolicy::default()));
        let joined = a.join(" ");
        assert!(joined.contains("--pids-limit 512"));
        assert!(joined.contains("--cap-drop ALL"));
        assert!(joined.contains("--security-opt no-new-privileges"));
        assert!(joined.contains("--read-only"));
        assert!(joined.contains("--tmpfs /tmp"));
        assert!(joined.contains("-v /home/cua"));
        assert!(joined.contains("--label cognia.cua.exec-user=cua"));
        // The exec-user bound does NOT become `--user` on the container: the
        // image's supervisord must boot as root.
        assert!(!a.contains(&"--user".to_string()));
        // The supervisor's minimal re-grants are present and nothing else is.
        for cap in ["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER"] {
            assert!(
                joined.contains(&format!("--cap-add {cap}")),
                "missing {cap}"
            );
        }
        // The port publish is loopback-scoped.
        assert!(joined.contains("-p 127.0.0.1:0:8000"));
        assert!(!joined.contains("-p 0:8000"));
    }

    #[test]
    fn run_args_carry_the_container_policy() {
        let a = run_args(&spec(ContainerPolicy {
            network_mode: Some("none".into()),
            cpus: Some("1.5".into()),
            memory_mb: Some(2048),
            pids_limit: Some(128),
            cap_drop: vec!["ALL".into()],
            cap_add: vec!["SETUID".into()],
            no_new_privileges: true,
            read_only_rootfs: true,
            tmpfs_mounts: vec!["/tmp".into()],
            writable_dirs: vec!["/home/cua".into()],
            exec_user: Some("cua".into()),
            entrypoint_user: Some("operator".into()),
            publish_addr: "127.0.0.1".into(),
            workspace_mount: Some(WorkspaceMount {
                host_path: "/host/ws".into(),
                container_path: "/workspace".into(),
            }),
        }));
        let joined = a.join(" ");
        assert!(joined.contains("--network none"));
        assert!(joined.contains("--cpus 1.5"));
        assert!(joined.contains("--memory 2048m"));
        assert!(joined.contains("--pids-limit 128"));
        assert!(joined.contains("--user operator"));
        assert!(joined.contains("-v /host/ws:/workspace"));
        // The image stays last so no policy value can be read as the image.
        assert_eq!(a.last().map(String::as_str), Some("img"));
    }

    #[test]
    fn run_args_omit_flags_a_policy_turned_off() {
        // An explicitly relaxed policy must produce the relaxed argv — the
        // flags are opt-out, not hard-coded.
        let a = run_args(&spec(ContainerPolicy {
            network_mode: Some("none".into()),
            cpus: None,
            memory_mb: None,
            pids_limit: None,
            cap_drop: vec![],
            cap_add: vec![],
            no_new_privileges: false,
            read_only_rootfs: false,
            tmpfs_mounts: vec![],
            writable_dirs: vec![],
            exec_user: None,
            entrypoint_user: None,
            publish_addr: "127.0.0.1".into(),
            workspace_mount: None,
        }));
        let joined = a.join(" ");
        assert!(!joined.contains("--pids-limit"));
        assert!(!joined.contains("--cap-drop"));
        assert!(!joined.contains("--cap-add"));
        assert!(!joined.contains("--security-opt"));
        assert!(!joined.contains("--read-only"));
        assert!(!joined.contains("--tmpfs"));
        assert!(!joined.contains("--label"));
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
        let parsed = parse_inspect(
            "abc123|running|true|false|none|1500000000|2147483648|512|true|ALL|no-new-privileges|cua\n",
        )
        .unwrap();
        assert_eq!(parsed.id, "abc123");
        assert_eq!(parsed.status, "running");
        assert!(parsed.running);
        assert!(!parsed.paused);
        assert_eq!(parsed.network_mode, "none");
        assert_eq!(parsed.nano_cpus, 1_500_000_000);
        assert_eq!(parsed.memory_bytes, 2_147_483_648);
        assert_eq!(parsed.pids_limit, 512);
        assert!(parsed.read_only_rootfs);
        assert_eq!(parsed.cap_drop, vec!["ALL".to_string()]);
        assert_eq!(parsed.security_opts, vec!["no-new-privileges".to_string()]);
        assert_eq!(parsed.exec_user.as_deref(), Some("cua"));
    }

    #[test]
    fn parse_inspect_reads_a_paused_container() {
        let parsed = parse_inspect("abc123|paused|true|true|bridge|0|0|0|false|||").unwrap();
        // Docker keeps `.State.Running` true while paused. Suspended is not
        // stopped, and the two must not be conflated.
        assert!(parsed.running);
        assert!(parsed.paused);
        assert_eq!(parsed.status, "paused");
        // A container that predates the label records no exec user and no
        // hardening — attestation is what refuses to adopt it quietly.
        assert_eq!(parsed.exec_user, None);
        assert!(!parsed.read_only_rootfs);
        assert!(parsed.cap_drop.is_empty());
    }

    #[test]
    fn parse_inspect_rejects_junk() {
        assert!(parse_inspect("").is_none());
        assert!(parse_inspect("only|three|fields").is_none());
        assert!(parse_inspect("abc123||true|false|bridge|0|0|0|false|||").is_none());
        assert!(parse_inspect("|running|true|false|bridge|0|0|0|false|||").is_none());
    }

    #[test]
    fn attest_adopted_accepts_a_matching_or_stricter_container() {
        let policy = ContainerPolicy {
            network_mode: Some("none".into()),
            cpus: Some("1.5".into()),
            memory_mb: Some(2048),
            ..ContainerPolicy::default()
        };
        let state = ContainerState {
            id: "abc".into(),
            status: "running".into(),
            running: true,
            paused: false,
            network_mode: "none".into(),
            nano_cpus: 1_500_000_000,
            memory_bytes: 2048 * 1024 * 1024,
            pids_limit: 256, // stricter than the requested 512: fine
            read_only_rootfs: true,
            cap_drop: vec!["ALL".into()],
            security_opts: vec!["no-new-privileges".into()],
            exec_user: Some("cua".into()),
        };
        attest_adopted(&policy, &state).unwrap();
    }

    #[test]
    fn attest_adopted_refuses_a_pre_hardening_container() {
        // The exact upgrade case: a container created before the hardened
        // profile carries no label, no pids cap, a writable rootfs and full
        // capabilities. Adopting it would silently drop every bound.
        let legacy = ContainerState {
            id: "abc".into(),
            status: "running".into(),
            running: true,
            paused: false,
            network_mode: "bridge".into(),
            nano_cpus: 0,
            memory_bytes: 0,
            pids_limit: 0,
            read_only_rootfs: false,
            cap_drop: vec![],
            security_opts: vec![],
            exec_user: None,
        };
        let err = attest_adopted(&ContainerPolicy::default(), &legacy).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("exec user"), "{msg}");
        assert!(msg.contains("pids limit"), "{msg}");
        assert!(msg.contains("read-only"), "{msg}");
        assert!(msg.contains("cap-drop ALL"), "{msg}");
        assert!(msg.contains("no-new-privileges"), "{msg}");
    }

    #[test]
    fn attest_adopted_accepts_a_relaxed_policy_onto_a_relaxed_container() {
        // Opting out of a bound and adopting a matching container is honest:
        // the caller asked for the weaker profile and got exactly that.
        let relaxed = ContainerPolicy {
            pids_limit: None,
            cap_drop: vec![],
            cap_add: vec![],
            no_new_privileges: false,
            read_only_rootfs: false,
            tmpfs_mounts: vec![],
            writable_dirs: vec![],
            exec_user: None,
            ..ContainerPolicy::default()
        };
        let state = ContainerState {
            id: "abc".into(),
            status: "running".into(),
            running: true,
            paused: false,
            network_mode: "bridge".into(),
            nano_cpus: 0,
            memory_bytes: 0,
            pids_limit: 0,
            read_only_rootfs: false,
            cap_drop: vec![],
            security_opts: vec![],
            exec_user: None,
        };
        attest_adopted(&relaxed, &state).unwrap();
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
        let args = exec_args("cid", &argv, Some("/workspace"), &env, true, Some("cua"));
        assert_eq!(args[0], "exec");
        assert!(args.contains(&"-i".to_string()));
        // The model's command channel runs as the bound user, never root.
        let u_at = args.iter().position(|a| a == "-u").unwrap();
        assert_eq!(args[u_at + 1], "cua");
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
        let args = exec_args(
            "cid",
            &["true".to_string()],
            None,
            &BTreeMap::new(),
            false,
            None,
        );
        assert!(!args.contains(&"-i".to_string()));
        assert!(!args.contains(&"-w".to_string()));
        assert!(!args.contains(&"-u".to_string()));
    }

    /// Image used by the live tests. Deliberately whatever is already on the
    /// machine rather than the cua desktop image: what is being proven here is
    /// the container lifecycle and the exec channel, and neither depends on
    /// which image is running.
    const LIVE_IMAGE: &str = "caddy:2.10.2-alpine";
    const LIVE_NAME: &str = "cua-lifecycle-selftest";

    async fn cleanup_live() {
        let _ = docker_remove(LIVE_NAME).await;
    }

    fn live_spec(policy: ContainerPolicy) -> SpawnSpec {
        SpawnSpec {
            image: LIVE_IMAGE.into(),
            name: LIVE_NAME.into(),
            policy,
        }
    }

    /// Every bound relaxed, for live tests that exercise lifecycle rather
    /// than confinement — e.g. the persistence test that writes under /root,
    /// which a read-only rootfs would rightly refuse.
    fn relaxed_live_policy() -> ContainerPolicy {
        ContainerPolicy {
            network_mode: None,
            cpus: None,
            memory_mb: None,
            pids_limit: None,
            cap_drop: vec![],
            cap_add: vec![],
            no_new_privileges: false,
            read_only_rootfs: false,
            tmpfs_mounts: vec![],
            writable_dirs: vec![],
            exec_user: None,
            entrypoint_user: None,
            publish_addr: "127.0.0.1".into(),
            workspace_mount: None,
        }
    }

    /// The claim the cua-desktop shell tier rests on: a command dispatched
    /// through this module runs inside the container, not on the developer's
    /// machine. If this ever stops holding, the tier is silently running the
    /// model's shell commands on someone's real desktop.
    #[tokio::test]
    #[ignore = "requires a running Docker daemon and the caddy:2.10.2-alpine image"]
    async fn live_exec_runs_inside_the_container() {
        cleanup_live().await;
        let container = docker_run(&live_spec(ContainerPolicy {
            network_mode: Some("none".into()),
            cpus: Some("1.5".into()),
            memory_mb: Some(512),
            ..relaxed_live_policy()
        }))
        .await
        .expect("docker run");

        let host_name = Command::new("hostname")
            .output()
            .await
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        let outcome = docker_exec(
            LIVE_NAME,
            &["hostname".to_string()],
            None,
            &BTreeMap::new(),
            None,
            Duration::from_secs(30),
            None,
        )
        .await
        .expect("docker exec");

        assert_eq!(outcome.exit_code, 0, "stderr: {}", outcome.stderr);
        let inside = outcome.stdout.trim();
        assert!(!inside.is_empty());
        assert_ne!(
            inside, host_name,
            "docker exec reported the host's hostname, so it did not run inside the container"
        );
        assert!(
            container.starts_with(inside),
            "the container reports its own short id as its hostname"
        );

        // The frozen policy is readable back, which is what attestation compares
        // a per-call request against.
        let state = docker_inspect(LIVE_NAME).await.unwrap().unwrap();
        assert_eq!(state.network_mode, "none");
        assert_eq!(state.nano_cpus, 1_500_000_000);
        assert_eq!(state.memory_bytes, 512 * 1024 * 1024);

        cleanup_live().await;
    }

    /// Without `--rm`, stopping keeps the container and everything written in
    /// it. This is the difference between a machine and a scratch process.
    #[tokio::test]
    #[ignore = "requires a running Docker daemon and the caddy:2.10.2-alpine image"]
    async fn live_files_survive_a_stop_and_start() {
        cleanup_live().await;
        docker_run(&live_spec(relaxed_live_policy()))
            .await
            .expect("docker run");

        let write = docker_exec(
            LIVE_NAME,
            &[
                "sh".to_string(),
                "-c".to_string(),
                "echo written-before-stop > /root/proof.txt".to_string(),
            ],
            None,
            &BTreeMap::new(),
            None,
            Duration::from_secs(30),
            None,
        )
        .await
        .expect("write");
        assert_eq!(write.exit_code, 0, "stderr: {}", write.stderr);

        docker_stop(LIVE_NAME).await.expect("stop");
        let stopped = docker_inspect(LIVE_NAME).await.unwrap().unwrap();
        assert!(
            !stopped.running,
            "the container should still exist, stopped"
        );

        docker_start(LIVE_NAME).await.expect("start");
        let read = docker_read_file(LIVE_NAME, "/root/proof.txt", 4096, None)
            .await
            .expect("read back");
        assert_eq!(read.trim(), "written-before-stop");

        cleanup_live().await;
    }

    /// Suspend is `pause`, and Docker reports a paused container as still
    /// running. A stopped container reports the opposite, which is exactly why
    /// implementing suspend with stop would be a lie about the session.
    #[tokio::test]
    #[ignore = "requires a running Docker daemon and the caddy:2.10.2-alpine image"]
    async fn live_pause_is_a_suspend_not_a_stop() {
        cleanup_live().await;
        docker_run(&live_spec(relaxed_live_policy()))
            .await
            .expect("docker run");

        docker_pause(LIVE_NAME).await.expect("pause");
        let paused = docker_inspect(LIVE_NAME).await.unwrap().unwrap();
        assert_eq!(paused.status, "paused");
        assert!(paused.paused);
        assert!(paused.running, "a paused container is still running");

        docker_unpause(LIVE_NAME).await.expect("unpause");
        let resumed = docker_inspect(LIVE_NAME).await.unwrap().unwrap();
        assert_eq!(resumed.status, "running");
        assert!(!resumed.paused);

        cleanup_live().await;
    }

    /// The bug adoption exists to fix: a container that outlived the app takes
    /// its deterministic name, and a second `docker run` fails forever after.
    /// `docker_inspect` answering `Some` is what lets the registry reuse it.
    #[tokio::test]
    #[ignore = "requires a running Docker daemon and the caddy:2.10.2-alpine image"]
    async fn live_a_second_run_conflicts_but_inspect_can_adopt() {
        cleanup_live().await;
        docker_run(&live_spec(relaxed_live_policy()))
            .await
            .expect("first run");

        let conflict = docker_run(&live_spec(relaxed_live_policy())).await;
        assert!(
            conflict.is_err(),
            "a duplicate name must fail, which is what used to brick a connection"
        );

        let adopted = docker_inspect(LIVE_NAME).await.expect("inspect");
        assert!(adopted.is_some(), "the existing container is adoptable");

        docker_remove(LIVE_NAME).await.expect("remove");
        assert!(
            docker_inspect(LIVE_NAME).await.unwrap().is_none(),
            "delete really removes the container"
        );
    }

    /// The per-tier confinement proof: inside a container created with the
    /// hardened profile, the host's Docker socket is absent and the root
    /// filesystem refuses writes. A container that can reach the daemon is
    /// root on the host, which is exactly the escape this tier must not have.
    #[tokio::test]
    #[ignore = "requires a running Docker daemon and the caddy:2.10.2-alpine image"]
    async fn live_hardened_container_denies_docker_socket_and_rootfs_writes() {
        cleanup_live().await;
        docker_run(&live_spec(ContainerPolicy {
            // The caddy image needs its config/data dirs writable under a
            // read-only rootfs, and NET_BIND_SERVICE to listen on :80.
            writable_dirs: vec!["/data".into(), "/config".into()],
            cap_add: vec!["NET_BIND_SERVICE".into()],
            exec_user: None, // the caddy image has no `cua` user
            ..ContainerPolicy::default()
        }))
        .await
        .expect("docker run");

        // The Docker socket is never mounted and cannot be reached.
        let sock = docker_exec(
            LIVE_NAME,
            &[
                "sh".to_string(),
                "-c".to_string(),
                "test ! -e /var/run/docker.sock".to_string(),
            ],
            None,
            &BTreeMap::new(),
            None,
            Duration::from_secs(30),
            None,
        )
        .await
        .expect("socket probe");
        assert_eq!(
            sock.exit_code, 0,
            "the host's docker socket is reachable inside the container"
        );

        // A read-only rootfs refuses writes even to a process running as root
        // with the supervisor's capability set.
        let write = docker_exec(
            LIVE_NAME,
            &[
                "sh".to_string(),
                "-c".to_string(),
                "touch /usr/proof".to_string(),
            ],
            None,
            &BTreeMap::new(),
            None,
            Duration::from_secs(30),
            None,
        )
        .await
        .expect("rootfs probe");
        assert_ne!(
            write.exit_code, 0,
            "the root filesystem accepted a write despite --read-only"
        );

        // And inspect reads the frozen policy back — the attestation surface.
        let state = docker_inspect(LIVE_NAME).await.unwrap().unwrap();
        assert_eq!(state.pids_limit, DEFAULT_PIDS_LIMIT as i64);
        assert!(state.read_only_rootfs);
        assert!(state.cap_drop.iter().any(|cap| cap == "ALL"));
        assert!(state
            .security_opts
            .iter()
            .any(|opt| opt.starts_with("no-new-privileges")));

        cleanup_live().await;
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
