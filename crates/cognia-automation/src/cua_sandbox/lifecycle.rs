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
use std::time::Duration;

use tokio::process::Command;

use crate::automation::types::{AutomationError, Result};

#[path = "lifecycle_execution.rs"]
pub(super) mod execution;

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
pub const AUTH_TOKEN_ENV: &str = "COGNIA_CUA_AUTH_TOKEN";

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
        "--env".into(),
        AUTH_TOKEN_ENV.into(),
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
    let (status, stdout, stderr) =
        execution::control(Command::new("docker").args(args), what).await?;
    if !status.success() {
        return Err(backend_err(format!(
            "{what} failed: {}",
            stderr.text().trim()
        )));
    }
    if stdout.truncated {
        return Err(backend_err(format!(
            "{what} response exceeds its output limit"
        )));
    }
    Ok(stdout.text().trim().to_string())
}

const IMAGE_ID_LABEL: &str = "cognia.cua.image-id";
const IMAGE_REFERENCE_LABEL: &str = "cognia.cua.image-reference";
pub const BUILTIN_DESKTOP_IMAGE: &str = "cognia-cua-desktop:0.3.46-1";

fn builtin_image_context() -> Result<tempfile::TempDir> {
    let context = tempfile::Builder::new()
        .prefix("cognia-cua-desktop-")
        .tempdir()
        .map_err(|e| backend_err(format!("could not prepare desktop build context: {e}")))?;
    for (name, content) in [
        ("Dockerfile", include_str!("image/Dockerfile")),
        ("entrypoint.sh", include_str!("image/entrypoint.sh")),
        ("startup.py", include_str!("image/startup.py")),
        ("server.py", include_str!("image/server.py")),
        ("menu.xml", include_str!("image/menu.xml")),
    ] {
        std::fs::write(context.path().join(name), content).map_err(|e| {
            backend_err(format!(
                "could not write desktop build resource {name}: {e}"
            ))
        })?;
    }
    Ok(context)
}

async fn build_builtin_image(executable: &std::ffi::OsStr) -> Result<()> {
    // The tiny context is embedded in the desktop binary. No checkout,
    // writable server script or user-supplied Dockerfile participates.
    let context = builtin_image_context()?;
    let (status, stdout, stderr) = execution::control_with_timeout(
        Command::new(executable)
            .args([
                "build",
                "--progress",
                "plain",
                "--tag",
                BUILTIN_DESKTOP_IMAGE,
            ])
            .arg(context.path()),
        "build built-in Linux desktop image",
        Duration::from_secs(900),
    )
    .await?;
    if !status.success() {
        return Err(backend_err(format!(
            "Could not build the built-in Linux desktop image. Check Docker disk space and access to Docker Hub, Debian and PyPI. {} {}",
            stderr.text().trim(), stdout.text().trim()
        )));
    }
    Ok(())
}

async fn pinned_spec(spec: &SpawnSpec) -> Result<SpawnSpec> {
    pinned_spec_with(spec, std::ffi::OsStr::new("docker")).await
}

async fn pinned_spec_with(spec: &SpawnSpec, executable: &std::ffi::OsStr) -> Result<SpawnSpec> {
    let inspect_args = ["image", "inspect", "--format", "{{.Id}}", &spec.image];
    let (mut status, mut stdout, mut stderr) = execution::control(
        Command::new(executable).args(inspect_args),
        "resolve desktop image",
    )
    .await?;
    if !status.success() && is_no_such_image(&stderr.text()) {
        // Provisioning the configured desktop includes installing its image.
        // Only a positively identified missing image triggers a pull; daemon,
        // permissions and malformed-reference errors must retain their cause.
        if spec.image == BUILTIN_DESKTOP_IMAGE {
            build_builtin_image(executable).await?;
        } else {
            let (pull_status, _, pull_stderr) = execution::control_with_timeout(
                Command::new(executable).args(["pull", &spec.image]),
                "pull configured desktop image",
                Duration::from_secs(600),
            )
            .await?;
            if !pull_status.success() {
                return Err(backend_err(format!(
                    "could not pull configured desktop image: {}",
                    pull_stderr.text().trim()
                )));
            }
        }
        (status, stdout, stderr) = execution::control(
            Command::new(executable).args(inspect_args),
            "resolve provisioned desktop image",
        )
        .await?;
    }
    if !status.success() {
        return Err(backend_err(format!(
            "could not resolve configured desktop image: {}",
            stderr.text().trim()
        )));
    }
    if stdout.truncated {
        return Err(backend_err("Docker image identity response exceeds limit"));
    }
    let image = stdout.text().trim().to_owned();
    if !valid_image_id(&image) {
        return Err(backend_err(
            "Docker did not return an immutable sha256 image identity",
        ));
    }
    Ok(SpawnSpec {
        image,
        ..spec.clone()
    })
}

fn is_no_such_image(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains("no such image:")
}

fn valid_image_id(image: &str) -> bool {
    image.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn add_image_labels(args: &mut Vec<String>, identity: &str, reference: &str) {
    let at = args.len() - 1;
    args.splice(
        at..at,
        [
            "--label".into(),
            format!("{IMAGE_ID_LABEL}={identity}"),
            "--label".into(),
            format!("{IMAGE_REFERENCE_LABEL}={reference}"),
        ],
    );
}

/// Verify an adopted machine still has its creation-time immutable identity
/// and the requested image configuration. A mutable registry tag is never
/// re-resolved during adoption: updating a tag cannot silently replace a VM.
pub async fn docker_attest_image(container: &str, configured_image: &str) -> Result<()> {
    let text = docker(
        &[
            "inspect",
            "--format",
            "{{.Image}}\n{{json .Config.Labels}}",
            container,
        ],
        "attest desktop image",
    )
    .await?;
    attest_image_response(&text, configured_image)
}

/// Resume/reconnect verifies the identity retained on the container itself
/// when no new configuration is being supplied by the caller.
pub async fn docker_attest_stored_image(container: &str) -> Result<()> {
    let text = docker(
        &[
            "inspect",
            "--format",
            "{{.Image}}\n{{json .Config.Labels}}",
            container,
        ],
        "attest retained desktop image",
    )
    .await?;
    let (_, labels) = text
        .split_once('\n')
        .ok_or_else(|| backend_err("Docker image identity response is incomplete"))?;
    let labels: BTreeMap<String, String> = serde_json::from_str(labels)
        .map_err(|_| backend_err("Desktop image identity is missing; recreate this sandbox"))?;
    let reference = labels
        .get(IMAGE_REFERENCE_LABEL)
        .filter(|reference| !reference.is_empty())
        .ok_or_else(|| backend_err("Desktop image reference is missing; recreate this sandbox"))?;
    attest_image_response(&text, reference)
}

fn attest_image_response(text: &str, configured_image: &str) -> Result<()> {
    let (actual, labels) = text
        .split_once('\n')
        .ok_or_else(|| backend_err("Docker image identity response is incomplete"))?;
    let labels: BTreeMap<String, String> = serde_json::from_str(labels)
        .map_err(|_| backend_err("Desktop image identity is missing; recreate this sandbox"))?;
    if !valid_image_id(actual)
        || labels.get(IMAGE_ID_LABEL).map(String::as_str) != Some(actual)
        || labels.get(IMAGE_REFERENCE_LABEL).map(String::as_str) != Some(configured_image)
    {
        return Err(backend_err(
            "Desktop image identity or configured reference changed; recreate this sandbox",
        ));
    }
    Ok(())
}

/// Create and start the container. Returns its container id.
pub async fn docker_run(spec: &SpawnSpec) -> Result<String> {
    let pinned = pinned_spec(spec).await?;
    let mut args = run_args(&pinned);
    add_image_labels(&mut args, &pinned.image, &spec.image);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    create_with_private_token(&borrowed, "docker run").await
}

/// Create the container without starting it. Returns its container id.
pub async fn docker_create(spec: &SpawnSpec) -> Result<String> {
    let pinned = pinned_spec(spec).await?;
    let mut args = create_args(&pinned);
    add_image_labels(&mut args, &pinned.image, &spec.image);
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    create_with_private_token(&borrowed, "docker create").await
}

async fn create_with_private_token(args: &[&str], what: &str) -> Result<String> {
    let token = hex::encode(rand::random::<[u8; 32]>());
    let (status, stdout, stderr) = execution::control(
        Command::new("docker").args(args).env(AUTH_TOKEN_ENV, token),
        what,
    )
    .await?;
    if !status.success() {
        return Err(backend_err(format!(
            "{what} failed: {}",
            stderr.text().trim()
        )));
    }
    if stdout.truncated {
        return Err(backend_err("Docker creation response exceeds limit"));
    }
    Ok(stdout.text().trim().to_owned())
}

/// Docker metadata is the private recovery store; this credential must never
/// be serialized into renderer connection state or included in diagnostics.
pub async fn docker_auth_token(container: &str) -> Result<String> {
    let (status, stdout, _) = execution::control(
        Command::new("docker").args(["inspect", "--format", "{{json .Config.Env}}", container]),
        "read private desktop credential",
    )
    .await?;
    if !status.success() || stdout.truncated {
        return Err(backend_err(
            "Could not recover private desktop credential; inspect the sandbox state",
        ));
    }
    parse_auth_token(&stdout.bytes)
}

fn parse_auth_token(bytes: &[u8]) -> Result<String> {
    let env: Vec<String> = serde_json::from_slice(bytes).map_err(|_| {
        backend_err("Invalid private desktop credential metadata; recreate this sandbox")
    })?;
    let prefix = format!("{AUTH_TOKEN_ENV}=");
    let tokens: Vec<_> = env
        .iter()
        .filter_map(|entry| entry.strip_prefix(&prefix))
        .collect();
    if tokens.len() != 1
        || tokens[0].len() != 64
        || !tokens[0].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(backend_err(
            "Missing protected desktop endpoint credential; recreate with a compatible image",
        ));
    }
    Ok(tokens[0].to_owned())
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
    let (status, stdout, stderr) = execution::control(
        Command::new("docker").args(["inspect", "--format", INSPECT_FORMAT, name_or_id]),
        "docker inspect",
    )
    .await?;
    if !status.success() {
        let stderr = stderr.text();
        if is_no_such_object(&stderr) {
            return Ok(None);
        }
        return Err(backend_err(format!(
            "docker inspect failed: {}",
            stderr.trim()
        )));
    }
    if stdout.truncated {
        return Err(backend_err("docker inspect response exceeds limit"));
    }
    let text = stdout.text();
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
    docker(
        &[
            "exec",
            "--env",
            "COGNIA_CUA_AUTH_TOKEN=",
            container_id,
            "true",
        ],
        "docker health",
    )
    .await
    .is_ok()
}

/// Verify the execution protocol on the actual running image and bound user.
/// A Docker container can be healthy while missing our required Python/Linux
/// supervision capabilities; admission must not infer one from the other.
pub async fn docker_probe_execution(container: &str, exec_user: Option<&str>) -> Result<()> {
    let result = docker_exec(
        container,
        &["true".into()],
        None,
        &BTreeMap::new(),
        None,
        Duration::from_secs(5),
        exec_user,
    )
    .await?;
    if result.timed_out || result.exit_code != 0 {
        return Err(backend_err(format!(
            "Desktop execution protocol probe failed: {}",
            result.stderr
        )));
    }
    Ok(())
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
/// The in-container supervisor owns the timeout and caller lease. Returning a
/// timed-out outcome confirms process cleanup; missing confirmation is an error.
pub async fn docker_exec(
    container: &str,
    argv: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
    stdin: Option<&str>,
    timeout: Duration,
    exec_user: Option<&str>,
) -> Result<ExecOutcome> {
    Ok(
        supervised_exec(container, argv, cwd, env, stdin, timeout, exec_user)
            .await?
            .outcome,
    )
}

async fn supervised_exec(
    container: &str,
    argv: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
    stdin: Option<&str>,
    timeout: Duration,
    exec_user: Option<&str>,
) -> Result<execution::SupervisedOutput> {
    supervised_exec_with_limits(
        container,
        argv,
        cwd,
        env,
        stdin,
        timeout,
        exec_user,
        MAX_STREAM_BYTES,
        MAX_STREAM_BYTES,
    )
    .await
}

pub(super) async fn supervised_exec_with_limits(
    container: &str,
    argv: &[String],
    cwd: Option<&str>,
    env: &BTreeMap<String, String>,
    stdin: Option<&str>,
    timeout: Duration,
    exec_user: Option<&str>,
    input_limit: usize,
    stdout_limit: usize,
) -> Result<execution::SupervisedOutput> {
    if argv.is_empty() {
        return Err(backend_err("docker exec requires a command to run"));
    }
    let wrapper = vec![
        "/bin/sh".into(),
        "-c".into(),
        execution::PYTHON_BOOTSTRAP.into(),
        "cognia-supervised-exec".into(),
        execution::SUPERVISOR.into(),
    ];
    // Requested PATH/PYTHONPATH must never influence the supervisor itself.
    // Only the requested child receives these values in its environment.
    let bootstrap_env = BTreeMap::from([(AUTH_TOKEN_ENV.to_owned(), String::new())]);
    let args = exec_args(container, &wrapper, cwd, &bootstrap_env, true, exec_user);
    execution::supervised_with_limits(
        Command::new("docker").args(&args),
        argv,
        stdin,
        timeout,
        env,
        input_limit,
        stdout_limit,
    )
    .await
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
    let argv = vec!["cat".to_string(), "--".to_string(), path.to_string()];
    let result = supervised_exec(
        container,
        &argv,
        None,
        &BTreeMap::new(),
        None,
        Duration::from_secs(30),
        exec_user,
    )
    .await?;
    validate_file_read(path, max_bytes, result)
}

fn validate_file_read(
    path: &str,
    max_bytes: usize,
    result: execution::SupervisedOutput,
) -> Result<String> {
    let outcome = result.outcome;
    if outcome.timed_out {
        return Err(backend_err(format!("reading '{path}' timed out")));
    }
    if outcome.exit_code != 0 {
        return Err(backend_err(format!(
            "could not read '{path}' inside the container: {}",
            outcome.stderr.trim()
        )));
    }
    if outcome.stdout_truncated {
        return Err(backend_err(format!(
            "'{path}' exceeds the {MAX_STREAM_BYTES} byte transport read limit"
        )));
    }
    if result.stdout_bytes.len() > max_bytes {
        return Err(backend_err(format!(
            "'{path}' is larger than the {max_bytes} byte read limit"
        )));
    }
    String::from_utf8(result.stdout_bytes)
        .map_err(|_| backend_err(format!("'{path}' is not valid UTF-8 text")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires Docker and the built-in native desktop image; operates only a new isolated container"]
    async fn live_builtin_desktop_authenticated_lifecycle_and_real_input() {
        use crate::automation::permission::ScreenshotScalingSettings;
        use crate::automation::session::{
            ActionRequest, ActionStrategy, ActionTarget, AppLocator, GetAppStateOptions,
            PixelTarget, UiAction, UiStateRevision,
        };
        use crate::automation::types::{KeyChord, Locator, Point};
        use crate::cua_sandbox::registry::CuaSandboxRegistry;
        use base64::Engine as _;
        let id = format!(
            "native-desktop-proof-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        );
        let name = format!("cua-{id}");
        docker(
            &[
                "image",
                "inspect",
                "--format",
                "{{.Id}}",
                BUILTIN_DESKTOP_IMAGE,
            ],
            "require the prebuilt desktop image for live acceptance",
        )
        .await
        .expect("build the bundled image before running this opt-in live test");
        let registry = CuaSandboxRegistry::default();
        let result: Result<()> = Box::pin(async {
            registry.create(&id, BUILTIN_DESKTOP_IMAGE, ContainerPolicy::default()).await?;
            let placement = registry.start(&id, BUILTIN_DESKTOP_IMAGE, ContainerPolicy::default()).await?;
            println!("native desktop started: {} port {}", placement.container_id, placement.port);
            // connect() itself verifies that an unauthenticated WebSocket is
            // rejected before establishing the private authenticated channel.
            let frame = registry.desktop_frame(&id).await?;
            if (frame.width, frame.height) != (1280, 800) { return Err(backend_err("unexpected native frame dimensions")); }
            std::fs::write("/tmp/cognia-cua-desktop-native.png", base64::engine::general_purpose::STANDARD.decode(&frame.bytes).map_err(|e| backend_err(e.to_string()))?).map_err(|e| backend_err(e.to_string()))?;
            let credentials = registry.exec(&id,
                &["/usr/local/bin/python3".into(), "-c".into(),
                  "import os; assert 'COGNIA_CUA_AUTH_TOKEN' not in os.environ\ntry:\n open('/proc/1/environ','rb').read(); raise RuntimeError('desktop credential process is readable')\nexcept PermissionError:\n print('credential-protected')".into()],
                None, &BTreeMap::new(), None, Duration::from_secs(5)).await?;
            if credentials.exit_code != 0 || credentials.stdout.trim() != "credential-protected" {
                return Err(backend_err(format!("guest credential isolation failed: {}", credentials.stderr)));
            }
            let app = registry.remote_list_apps(&id).await?.into_iter().next().ok_or_else(|| backend_err("no remote desktop application"))?;
            let locator = AppLocator::BundleId { bundle_id: app.bundle_id.ok_or_else(|| backend_err("missing desktop identity"))? };
            let action = |revision: &UiStateRevision| ActionRequest {
                turn_token: revision.turn_token.clone(), strategy: ActionStrategy::Pixel,
                target: ActionTarget::Pixel { target: PixelTarget {
                    session_id: revision.session_id.clone(), lineage_id: revision.lineage_id.clone(), revision: revision.revision,
                    point: Point { x: 10, y: 10 }, screenshot_width: revision.surface.pixel_width, screenshot_height: revision.surface.pixel_height,
                } }, action: UiAction::PressKey { chord: KeyChord("Escape".into()) },
            };
            let revision = registry.remote_get_app_state(&id, "live-session".into(), "live-turn".into(), locator.clone(), GetAppStateOptions::default(), ScreenshotScalingSettings { enabled: false, ..Default::default() }).await?;
            registry.remote_query_elements(&id, &revision.session_id, &revision.lineage_id, revision.revision, &Locator::default(), 10).await?;
            registry.remote_perform_action(&id, action(&revision), "live-turn").await?;
            let revision = registry.remote_get_app_state(&id, "live-session".into(), "live-turn".into(), locator, GetAppStateOptions::default(), ScreenshotScalingSettings { enabled: false, ..Default::default() }).await?;
            let lease = registry.acquire_control(&id).await?;
            if registry.remote_perform_action(&id, action(&revision), "live-turn").await.is_ok() {
                return Err(backend_err("agent desktop action was not blocked during human control"));
            }
            if registry.exec(&id, &["true".into()], None, &BTreeMap::new(), None, Duration::from_secs(5)).await.is_ok() {
                return Err(backend_err("agent execution was not blocked during human control"));
            }
            // Full transfer budget, arbitrary binary bytes, immutable placement
            // and collision behavior all pass through the public registry.
            let binary: Vec<u8> = (0..super::super::file_transfer::MAX_TRANSFER_BYTES).map(|index| index as u8).collect();
            let binary_base64 = base64::engine::general_purpose::STANDARD.encode(&binary);
            let binary_hash = super::super::file_transfer::sha256(&binary);
            let uploaded = registry.upload_file(&id, &placement.container_id, &lease.token, "/home/cua/binary-proof.bin", &binary_base64).await?;
            if uploaded.size != binary.len() as u64 || uploaded.sha256 != binary_hash { return Err(backend_err("binary upload mismatch")); }
            registry.renew_control(&id, &lease.token).await?;
            if registry.upload_file(&id, &placement.container_id, &lease.token, "/home/cua/binary-proof.bin", "").await.is_ok() { return Err(backend_err("binary upload silently replaced an existing file")); }
            // Acknowledged EEXIST must not quarantine or discard human control.
            registry.renew_control(&id, &lease.token).await?;
            let downloaded = registry.download_file(&id, &placement.container_id, "/home/cua/binary-proof.bin").await?;
            if downloaded.data_base64 != binary_base64 || downloaded.sha256 != binary_hash { return Err(backend_err("binary download mismatch")); }
            if registry.download_file(&id, &"0".repeat(64), "/home/cua/binary-proof.bin").await.is_ok() { return Err(backend_err("transfer accepted a replaced container identity")); }
            registry.renew_control(&id, &lease.token).await?;
            registry.upload_file(&id, &placement.container_id, &lease.token, "/home/cua/empty-proof.bin", "").await?;
            if registry.download_file(&id, &placement.container_id, "/home/cua/empty-proof.bin").await?.size != 0 { return Err(backend_err("empty binary transfer mismatch")); }
            registry.control_input(&id, &lease.token, Some(Point { x: 100, y: 650 }), UiAction::Click { button: None, count: Some(1) }).await?;
            registry.control_input(&id, &lease.token, None, UiAction::TypeText {
                text: "printf 'native-ui-proof' > /home/cua/ui-proof.txt".into(),
            }).await?;
            registry.control_input(&id, &lease.token, None, UiAction::PressKey { chord: KeyChord("Enter".into()) }).await?;
            registry.release_control(&id, &lease.token).await?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let frame = registry.desktop_frame(&id).await?;
            std::fs::write("/tmp/cognia-cua-desktop-native-input.png", base64::engine::general_purpose::STANDARD.decode(&frame.bytes).map_err(|e| backend_err(e.to_string()))?).map_err(|e| backend_err(e.to_string()))?;
            if registry.read_file(&id, "/home/cua/ui-proof.txt", 1024).await? != "native-ui-proof" {
                return Err(backend_err("real desktop keyboard input did not create the expected file"));
            }
            // Kill the actual Linux helper after its anonymous file is open.
            // The same unprivileged user must leave no partial name behind.
            let helper_json = serde_json::to_string(super::super::file_transfer::HELPER).unwrap();
            let kill_upload = format!(r#"import os,signal,tempfile,time
namespace={{'__name__':'transfer_test'}}
exec({helper_json},namespace)
root=tempfile.mkdtemp(prefix='cognia-transfer-kill-',dir='/home/cua')
parent,name=namespace['open_parent'](root+'/partial')
r,w=os.pipe()
child=os.fork()
if child==0:
 os.close(r)
 original=os.write
 def blocked(fd,data):
  original(w,b'ready')
  time.sleep(60)
  return original(fd,data)
 os.write=blocked
 namespace['upload'](parent,name,b'never published')
 os._exit(2)
os.close(w)
assert os.read(r,5)==b'ready'
os.kill(child,signal.SIGKILL)
os.waitpid(child,0)
os.close(r)
os.close(parent)
assert os.listdir(root)==[],os.listdir(root)
os.rmdir(root)
print('anonymous-upload-clean')
"#);
            let cleaned = registry.exec(&id, &["/usr/local/bin/python3".into(), "-I".into(), "-c".into(), kill_upload], None, &BTreeMap::new(), None, Duration::from_secs(10)).await?;
            if cleaned.exit_code != 0 || cleaned.stdout.trim() != "anonymous-upload-clean" { return Err(backend_err(format!("anonymous upload cancellation failed: {}", cleaned.stderr))); }
            registry.suspend(&id).await?;
            if !docker_inspect(&name).await?.is_some_and(|state| state.paused) { return Err(backend_err("desktop did not pause")); }
            registry.resume(&id).await?;
            registry.desktop_frame(&id).await?;
            registry.disconnect_all().await;
            let restarted_host = CuaSandboxRegistry::default();
            restarted_host.desktop_frame(&id).await?;
            restarted_host.stop(&id).await?;
            restarted_host.start(&id, BUILTIN_DESKTOP_IMAGE, ContainerPolicy::default()).await?;
            if restarted_host.read_file(&id, "/home/cua/ui-proof.txt", 1024).await? != "native-ui-proof" {
                return Err(backend_err("desktop file did not survive restart"));
            }
            let persisted = restarted_host.download_file(&id, &placement.container_id, "/home/cua/binary-proof.bin").await?;
            if persisted.sha256 != binary_hash || persisted.data_base64 != binary_base64 { return Err(backend_err("binary transfer did not survive restart")); }
            restarted_host.disconnect_all().await;
            println!("native screenshot, authenticated input, credential isolation, control lease, pause/resume, cold reconnect and persistent restart: PASS");
            Ok(())
        }).await;
        if result.is_err() {
            eprintln!(
                "desktop diagnostics: {}",
                docker(&["logs", "--tail", "60", &name], "read smoke diagnostics")
                    .await
                    .unwrap_or_default()
            );
        }
        let cleanup = registry.delete(&id).await;
        result.unwrap();
        cleanup.unwrap();
        assert!(docker_inspect(&name).await.unwrap().is_none());
    }

    #[test]
    fn private_credential_metadata_rejects_duplicates_missing_and_malformed_values() {
        let token = "a".repeat(64);
        let entry = format!("{AUTH_TOKEN_ENV}={token}");
        assert_eq!(
            parse_auth_token(&serde_json::to_vec(&vec![entry.clone()]).unwrap()).unwrap(),
            token
        );
        for bytes in [
            b"[]".to_vec(),
            b"not-json-secret".to_vec(),
            serde_json::to_vec(&vec![entry.clone(), entry]).unwrap(),
        ] {
            let error = parse_auth_token(&bytes).unwrap_err().to_string();
            assert!(!error.contains(&token));
            assert!(!error.contains("not-json-secret"));
        }
        let args = create_args(&spec(ContainerPolicy::default()));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--env", AUTH_TOKEN_ENV]));
        assert!(!args.iter().any(|arg| arg.contains(&token)));
    }

    #[test]
    fn adopted_image_is_bound_to_creation_identity_and_configuration() {
        let identity = format!("sha256:{}", "a".repeat(64));
        let labels = serde_json::json!({
            IMAGE_ID_LABEL: identity,
            IMAGE_REFERENCE_LABEL: "desktop:latest",
        });
        let response = format!("{identity}\n{labels}");
        assert!(attest_image_response(&response, "desktop:latest").is_ok());
        assert!(attest_image_response(&response, "different:latest").is_err());
        assert!(attest_image_response(
            &format!("sha256:{}\n{labels}", "b".repeat(64)),
            "desktop:latest"
        )
        .is_err());
        assert!(attest_image_response(&format!("{identity}\n{{}}"), "desktop:latest").is_err());
    }

    #[test]
    fn pinned_creation_preserves_image_as_the_final_argument() {
        let identity = format!("sha256:{}", "f".repeat(64));
        let mut spec = spec(ContainerPolicy::default());
        spec.image = identity.clone();
        let mut args = create_args(&spec);
        add_image_labels(&mut args, &identity, "image:latest");
        assert_eq!(args.last(), Some(&identity));
        assert!(args.contains(&format!("{IMAGE_REFERENCE_LABEL}=image:latest")));
        assert!(valid_image_id(&identity));
        assert!(!valid_image_id("sha256:not-a-digest"));
    }

    #[test]
    fn file_reads_reject_truncation_even_when_the_requested_limit_is_larger() {
        let output = |bytes: Vec<u8>, truncated| execution::SupervisedOutput {
            stdout_bytes: bytes.clone(),
            outcome: ExecOutcome {
                stdout: String::from_utf8_lossy(&bytes).into_owned(),
                stderr: String::new(),
                exit_code: 0,
                duration_ms: 0,
                timed_out: false,
                stdout_truncated: truncated,
                stderr_truncated: false,
            },
        };
        assert!(validate_file_read(
            "file",
            MAX_STREAM_BYTES * 2,
            output(vec![b'x'; MAX_STREAM_BYTES], true)
        )
        .is_err());
        assert!(validate_file_read("file", 1, output(b"ab".to_vec(), false)).is_err());
        assert!(validate_file_read("file", 100, output(vec![0xff], false)).is_err());
        assert_eq!(
            validate_file_read("file", 3, output("你".as_bytes().to_vec(), false)).unwrap(),
            "你"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provisioning_pulls_only_a_confirmed_missing_image_then_pins_its_id() {
        use std::os::unix::fs::PermissionsExt;
        for (requested_image, missing) in [
            ("requested:tag", true),
            ("requested:tag", false),
            (BUILTIN_DESKTOP_IMAGE, true),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let executable = directory.path().join("fake-docker");
            let log = directory.path().join("calls.jsonl");
            let state = directory.path().join("pulled");
            let script = format!(
                r#"#!/usr/bin/env python3
import sys,json,os
with open({log:?},'a') as log: log.write(json.dumps(sys.argv[1:])+'\n')
if sys.argv[1] == 'build':
 assert set(os.listdir(sys.argv[-1])) == {{'Dockerfile','entrypoint.sh','startup.py','server.py','menu.xml'}}
 assert 'cua-computer-server[linux]==0.3.46' in open(os.path.join(sys.argv[-1],'Dockerfile')).read()
if sys.argv[1] in ['pull','build']:
 open({state:?},'w').close()
 sys.exit(0)
if os.path.exists({state:?}):
 print('sha256:'+'a'*64)
 sys.exit(0)
print({error:?},file=sys.stderr)
sys.exit(1)
"#,
                log = log.to_str().unwrap(),
                state = state.to_str().unwrap(),
                error = if missing {
                    "Error response from daemon: No such image: requested:tag"
                } else {
                    "Cannot connect to the Docker daemon"
                }
            );
            std::fs::write(&executable, script).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut requested = spec(ContainerPolicy::default());
            requested.image = requested_image.into();
            let result = pinned_spec_with(&requested, executable.as_os_str()).await;
            let calls: Vec<Vec<String>> = std::fs::read_to_string(&log)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(
                calls[0],
                ["image", "inspect", "--format", "{{.Id}}", requested_image]
            );
            if missing {
                assert_eq!(result.unwrap().image, format!("sha256:{}", "a".repeat(64)));
                assert_eq!(calls.len(), 3);
                if requested_image == BUILTIN_DESKTOP_IMAGE {
                    assert_eq!(
                        &calls[1][..5],
                        [
                            "build",
                            "--progress",
                            "plain",
                            "--tag",
                            BUILTIN_DESKTOP_IMAGE
                        ]
                    );
                    assert!(
                        !std::path::Path::new(&calls[1][5]).exists(),
                        "build context must be removed"
                    );
                } else {
                    assert_eq!(calls[1], ["pull", requested_image]);
                }
                assert_eq!(calls[2], calls[0]);
            } else {
                assert!(result.unwrap_err().to_string().contains("Cannot connect"));
                assert_eq!(calls.len(), 1);
            }
        }
    }

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

    /// Locally built fixture: `FROM python:3.12-alpine` with
    /// `CMD ["sleep", "infinity"]`, tagged cognia-cua-lifecycle-test:local.
    /// Python3 is an explicit supervised-exec capability; the old caddy-only
    /// fixture could not exercise the current execution protocol.
    const LIVE_IMAGE: &str = "cognia-cua-lifecycle-test:local";
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
    #[ignore = "requires Docker and a local cognia-cua-lifecycle-test:local Python3 fixture"]
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
    #[ignore = "requires Docker and a local cognia-cua-lifecycle-test:local Python3 fixture"]
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
    #[ignore = "requires Docker and a local cognia-cua-lifecycle-test:local Python3 fixture"]
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
    #[ignore = "requires Docker and a local cognia-cua-lifecycle-test:local Python3 fixture"]
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
    #[ignore = "requires Docker and a local cognia-cua-lifecycle-test:local Python3 fixture"]
    async fn live_hardened_container_denies_docker_socket_and_rootfs_writes() {
        cleanup_live().await;
        docker_run(&live_spec(ContainerPolicy {
            // Exercise explicit writable volumes and a minimal capability
            // grant while keeping the image root filesystem read-only.
            writable_dirs: vec!["/data".into(), "/config".into()],
            cap_add: vec!["NET_BIND_SERVICE".into()],
            exec_user: None, // the small lifecycle fixture has no `cua` user
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
}
