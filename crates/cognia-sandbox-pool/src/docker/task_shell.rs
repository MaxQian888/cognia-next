//! Host task shells (ADR-0224 A8). On an always-on Host nothing a task runs
//! may run on the Host itself, so a built-in turn's `sandbox_bash`, `edit`
//! and `write` commands each run in a retained runtime of the task's
//! environment: as the environment's user, under its isolation tier, in the
//! task workspace, which the runtime reaches by the same path the Host uses.
//!
//! The runtime is keyed apart from any agent's ([`RuntimePurpose::TaskShell`])
//! because a released task removes it, and an orphan sweep removes one a
//! previous process left behind.

use super::persistent::{exec_spec, sha256_hex, RuntimePurpose, SessionApi, SOCKET};
use super::*;
use crate::runtime::{TaskShellRequest, TaskShellResult, TASK_SHELL_OUTPUT_LIMIT};
use cognia_external_agent::container_backend::{
    is_owned, PERSISTENT_RUNTIME_LABEL, TASK_SHELL_RUNTIME_LABEL,
};
use std::path::Component;

/// The longest a single tool command may run.
pub(super) const MAX_TIMEOUT_MS: u64 = 60 * 60 * 1000;
/// Bytes a command's stdin may carry (a `write` of a large file).
pub(super) const MAX_STDIN_BYTES: usize = 32 * 1024 * 1024;
/// How long a command signalled on timeout gets to report its status.
const KILL_GRACE: Duration = Duration::from_secs(5);
/// Runtimes one release may name.
pub(super) const MAX_RELEASE: usize = 64;

fn refused(code: &'static str, message: impl Into<String>) -> SandboxSpawnError {
    SandboxSpawnError::refused(code, message.into())
}

fn fault(message: impl Into<String>) -> SandboxSpawnError {
    SandboxSpawnError::fault("sandbox_task_shell_failed", message.into())
}

/// An absolute path of plain components, short enough for the supervisor.
fn plain_absolute(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= 4096
        && !path.contains('\0')
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
}

fn env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first == b'_' || first.is_ascii_alphabetic())
        && bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
}

/// Refuse a request the supervisor would refuse, before preparing anything.
pub(super) fn validate(request: &TaskShellRequest) -> Result<(), SandboxSpawnError> {
    let invalid = |message: &str| refused("sandbox_task_shell_invalid", message);
    if request.owner.is_empty()
        || request.owner.len() > 256
        || request.owner.chars().any(char::is_control)
    {
        return Err(invalid("a task shell needs its owner"));
    }
    for root in [&request.workspace_root, &request.workspace_path] {
        if !plain_absolute(root) || root == "/" {
            return Err(invalid("the workspace must be an absolute path"));
        }
    }
    if !plain_absolute(&request.cwd)
        || !Path::new(&request.cwd).starts_with(Path::new(&request.workspace_path))
    {
        return Err(invalid("the command must start inside its workspace"));
    }
    if request.argv.is_empty()
        || request.argv.len() > 256
        || request.argv[0].is_empty()
        || request
            .argv
            .iter()
            .any(|arg| arg.contains('\0') || arg.len() > 32 * 1024)
    {
        return Err(invalid("invalid command"));
    }
    if request.env.len() > 256
        || request
            .env
            .iter()
            .any(|(name, value)| !env_name(name) || value.contains('\0'))
    {
        return Err(invalid("invalid command environment"));
    }
    if !(1..=MAX_TIMEOUT_MS).contains(&request.timeout_ms) {
        return Err(invalid("the timeout must be between 1 ms and one hour"));
    }
    if request
        .stdin
        .as_ref()
        .is_some_and(|stdin| stdin.len() > MAX_STDIN_BYTES)
    {
        return Err(invalid("the command input is too large"));
    }
    Ok(())
}

/// One output stream, kept up to [`TASK_SHELL_OUTPUT_LIMIT`] bytes.
#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

impl Capture {
    fn push(&mut self, chunk: Vec<u8>) {
        let room = TASK_SHELL_OUTPUT_LIMIT.saturating_sub(self.bytes.len());
        if chunk.len() > room {
            self.truncated = true;
        }
        self.bytes
            .extend_from_slice(&chunk[..chunk.len().min(room)]);
    }

    fn text(self) -> (String, bool) {
        (
            String::from_utf8_lossy(&self.bytes).into_owned(),
            self.truncated,
        )
    }
}

/// A runtime's `health` says no session or port connection is live.
fn idle(health: &Value) -> bool {
    health["activeConnections"].as_u64() == Some(0)
}

impl DockerSandboxBackend {
    pub(super) async fn exec_task_shell(
        &self,
        request: TaskShellRequest,
    ) -> Result<TaskShellResult, SandboxSpawnError> {
        validate(&request)?;
        if self.remote.is_some() {
            return Err(refused(
                "sandbox_task_shell_remote_unsupported",
                "task shells run on this Host's local sandbox driver",
            ));
        }
        let TaskShellRequest {
            placement,
            owner,
            workspace_root,
            workspace_path,
            cwd,
            argv,
            env,
            stdin,
            timeout_ms,
        } = request;

        let slot = self
            .prepare_slots
            .clone()
            .acquire_owned()
            .await
            .expect("preparation semaphore stays open");
        let prepared = self
            .prepare_local(
                &placement,
                &workspace_root,
                OperationLeases {
                    _prepare: Some(Arc::new(slot)),
                    ..OperationLeases::default()
                },
            )
            .await?;
        let libc_volume = self.stage_libc(&prepared).await?;
        let boot = runtime_config_with_env(&prepared.admitted.spec, BTreeMap::new())?;
        let boot_env = encode_runtime_config_env(&boot)
            .map_err(|error| refused("sandbox_runtime_config_invalid", error.to_string()))?;
        let name = format!("task-shell-{}", &sha256_hex(owner.as_bytes())[..16]);
        let mut spec =
            self.local_runner_spec(&name, &prepared, libc_volume, boot_env, Vec::new())?;
        let environment = prepared.admitted.spec.clone();
        self.configure_workspace_ports(&mut spec, &workspace_root)
            .await?;
        let workspace_env = spec.workspace_env.clone();
        let tier = prepared.admitted.admission.actual_tier.as_str().to_string();
        let acquired = self
            .acquire_runtime(
                spec,
                prepared.auth.clone(),
                &environment,
                RuntimePurpose::TaskShell,
            )
            .await?;
        // The runtime is up: the preparation slot and bundle leases go back.
        drop(prepared);
        let container_id = acquired.container_id.clone();

        let session = sha256_hex(format!("{owner}:{}", uuid::Uuid::new_v4()).as_bytes());
        let mut exec = exec_spec(
            &container_id,
            &[
                "connect-agent",
                "--socket",
                SOCKET,
                "--session",
                &session,
                "--lease-seconds",
                "60",
                "--task-cwd",
                &cwd,
                "--workspace-alias",
                &workspace_path,
                "--",
            ],
        );
        exec.command.extend(argv);
        let mut runtime = runtime_config_with_env(&environment, env.into_iter().collect())?;
        runtime.workspace_env = workspace_env.clone();
        exec.workspace_env = workspace_env;
        // The supervisor runs no lifecycle for a task command.
        runtime.lifecycle_phases.clear();
        exec.env = encode_runtime_config_env(&runtime)
            .map_err(|error| refused("sandbox_runtime_config_invalid", error.to_string()))?;
        let session_api = SessionApi::new(self.api.clone(), container_id.clone(), session);
        let running = match self.api.exec_runtime(exec).await {
            Ok(running) => running,
            Err(error) => {
                // The start may still have reached the supervisor.
                let _ = session_api.kill(&container_id).await;
                return Err(fault(error));
            }
        };
        // Released only once the session exists, so a release that takes the
        // lock next sees it in `health`.
        drop(acquired);
        // The timeout is the command's: preparing the runtime (a first image
        // pull, lifecycle hooks) is not charged to a tool's budget.
        let started = tokio::time::Instant::now();

        let RunningRunner {
            mut events,
            stdin: input,
            ..
        } = running;
        let feeder = tokio::spawn(async move {
            if let Some(text) = stdin {
                for chunk in text.into_bytes().chunks(64 * 1024) {
                    if input.send(chunk.to_vec()).await.is_err() {
                        return;
                    }
                }
            }
            // Dropping the sender is the command's end of input.
        });
        let mut stdout = Capture::default();
        let mut stderr = Capture::default();
        let deadline = started + Duration::from_millis(timeout_ms);
        let mut grace_until: Option<tokio::time::Instant> = None;
        let mut exit_code = None;
        loop {
            tokio::select! {
                event = events.recv() => match event {
                    Some(RunnerEvent::Stdout(bytes)) => stdout.push(bytes),
                    Some(RunnerEvent::Stderr(bytes)) => stderr.push(bytes),
                    Some(RunnerEvent::Exited { code }) => {
                        exit_code = code;
                        break;
                    }
                    None => break,
                },
                _ = tokio::time::sleep_until(deadline), if grace_until.is_none() => {
                    if let Err(error) = session_api.kill(&container_id).await {
                        log::warn!("task shell timeout signal failed: {error}");
                    }
                    grace_until = Some(tokio::time::Instant::now() + KILL_GRACE);
                }
                _ = tokio::time::sleep_until(grace_until.unwrap_or(deadline)), if grace_until.is_some() => break,
            }
        }
        feeder.abort();
        let timed_out = grace_until.is_some();
        if timed_out && exit_code.is_none() {
            // Nothing reported a status: make sure the session is gone.
            let _ = session_api.kill(&container_id).await;
        }
        drop(session_api);
        let (stdout, stdout_truncated) = stdout.text();
        let (stderr, stderr_truncated) = stderr.text();
        Ok(TaskShellResult {
            exit_code,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            timed_out,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            provider: placement.provider().to_string(),
            container_id,
            tier,
        })
    }

    /// Remove each named task shell runtime no session or port uses. A
    /// container that is not this deployment's task shell runtime refuses the
    /// whole release: an agent's runtime is never the caller's to remove.
    pub(super) async fn release_task_shell(
        &self,
        container_ids: &[String],
    ) -> Result<Vec<String>, SandboxSpawnError> {
        if container_ids.len() > MAX_RELEASE {
            return Err(refused(
                "sandbox_task_shell_invalid",
                "too many runtimes in one release",
            ));
        }
        let mut removed = Vec::new();
        for id in container_ids {
            let Some(state) = self.api.inspect_runtime(id).await.map_err(fault)? else {
                continue;
            };
            let label = |key: &str| state.labels.get(key).map(String::as_str);
            if !is_owned(&state.labels)
                || label(DEPLOYMENT_LABEL) != Some(self.config.deployment_id.as_str())
                || label(PERSISTENT_RUNTIME_LABEL) != Some("1")
                || label(TASK_SHELL_RUNTIME_LABEL) != Some("1")
            {
                return Err(refused(
                    "sandbox_task_shell_not_owned",
                    format!("{id} is not a task shell runtime of this Host"),
                ));
            }
            let key = label(persistent::RUNTIME_KEY_LABEL)
                .ok_or_else(|| fault("task shell runtime has no runtime key"))?
                .to_string();
            let lock = self.stage_lock(&format!("runtime:{key}"));
            let _guard = lock.lock_owned().await;
            // Re-read under the lock: an acquisition may have started it.
            let Some(state) = self.api.inspect_runtime(id).await.map_err(fault)? else {
                continue;
            };
            if state.running {
                let health =
                    persistent::control(&self.api, exec_spec(id, &["health", "--socket", SOCKET]))
                        .await
                        .ok()
                        .and_then(|body| serde_json::from_slice::<Value>(&body).ok());
                // An unreadable health is not proof the runtime is idle.
                if !health.as_ref().is_some_and(idle) {
                    continue;
                }
            }
            self.api.remove(id).await.map_err(fault)?;
            removed.push(id.clone());
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::tests::{
        admitted, command, decode_agent_environment, report, spawn_config, spec, Harness,
    };
    use cognia_environment::spec::IsolationTier;

    const ROOT: &str = "/srv/workspaces/ws-1";
    /// How the task's tools name it (here through a symlinked parent).
    const PATH: &str = "/data/workspaces/ws-1";

    fn request(environment: &EnvironmentSpec) -> TaskShellRequest {
        TaskShellRequest {
            placement: spawn_config("unused", "unused", &[], environment)
                .sandbox
                .expect("a placement"),
            owner: "session:s1".into(),
            workspace_root: ROOT.into(),
            workspace_path: PATH.into(),
            cwd: format!("{PATH}/src"),
            argv: vec!["/bin/sh".into(), "-c".into(), "cat > note".into()],
            env: BTreeMap::from([("TASK_FLAG".to_string(), "1".to_string())]),
            stdin: Some("hello".into()),
            timeout_ms: 30_000,
        }
    }

    fn harness() -> (Harness, EnvironmentSpec) {
        let environment = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(environment.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        (harness, environment)
    }

    /// The `connect-agent` exec of the next task command, once it exists.
    async fn next_connect(harness: &Harness, seen: usize) -> RunnerExecSpec {
        for _ in 0..10_000 {
            let found = harness
                .api
                .runtime_execs
                .lock()
                .iter()
                .filter(|exec| exec.command.get(1).map(String::as_str) == Some("connect-agent"))
                .nth(seen)
                .cloned();
            if let Some(exec) = found {
                return exec;
            }
            tokio::task::yield_now().await;
        }
        panic!("no task command reached the runtime");
    }

    fn flag<'a>(exec: &'a RunnerExecSpec, name: &str) -> &'a str {
        exec.command
            .windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].as_str())
            .unwrap_or_else(|| panic!("{name} missing"))
    }

    use cognia_external_agent::container_backend::RunnerExecSpec;

    #[test]
    fn requests_are_refused_before_anything_is_prepared() {
        let environment = spec(EgressTier::Off, None);
        assert!(validate(&request(&environment)).is_ok());
        let cases: Vec<(&str, Box<dyn Fn(&mut TaskShellRequest)>)> = vec![
            ("no owner", Box::new(|r| r.owner.clear())),
            ("control owner", Box::new(|r| r.owner = "a\nb".into())),
            (
                "relative root",
                Box::new(|r| r.workspace_root = "srv/w".into()),
            ),
            (
                "relative path",
                Box::new(|r| r.workspace_path = "data/w".into()),
            ),
            (
                "root of the filesystem",
                Box::new(|r| {
                    r.workspace_path = "/".into();
                    r.cwd = "/".into();
                }),
            ),
            (
                "dot-dot root",
                Box::new(|r| r.workspace_root = "/srv/../etc".into()),
            ),
            (
                "cwd outside",
                Box::new(|r| r.cwd = "/data/workspaces/ws-10".into()),
            ),
            (
                "cwd under the mount source only",
                Box::new(|r| r.cwd = ROOT.into()),
            ),
            (
                "cwd escapes",
                Box::new(|r| r.cwd = format!("{PATH}/../ws-2")),
            ),
            ("empty argv", Box::new(|r| r.argv.clear())),
            ("empty program", Box::new(|r| r.argv[0].clear())),
            ("nul in argv", Box::new(|r| r.argv.push("a\0b".into()))),
            (
                "bad env name",
                Box::new(|r| {
                    r.env.insert("1BAD".into(), "x".into());
                }),
            ),
            (
                "nul in env",
                Box::new(|r| {
                    r.env.insert("OK".into(), "a\0".into());
                }),
            ),
            ("no timeout", Box::new(|r| r.timeout_ms = 0)),
            (
                "long timeout",
                Box::new(|r| r.timeout_ms = MAX_TIMEOUT_MS + 1),
            ),
            (
                "huge stdin",
                Box::new(|r| r.stdin = Some("x".repeat(MAX_STDIN_BYTES + 1))),
            ),
        ];
        for (name, mutate) in cases {
            let mut case = request(&environment);
            mutate(&mut case);
            let error = validate(&case).expect_err(name);
            assert_eq!(error.code, "sandbox_task_shell_invalid", "{name}");
        }
        // The workspace root itself is a valid place to start.
        let mut at_root = request(&environment);
        at_root.cwd = PATH.into();
        assert!(validate(&at_root).is_ok());
    }

    #[test]
    fn output_is_capped_per_stream_and_flagged() {
        let mut capture = Capture::default();
        capture.push(vec![b'a'; TASK_SHELL_OUTPUT_LIMIT - 1]);
        capture.push(b"bc".to_vec());
        capture.push(b"d".to_vec());
        let (text, truncated) = capture.text();
        assert_eq!(text.len(), TASK_SHELL_OUTPUT_LIMIT);
        assert!(text.ends_with('b'));
        assert!(truncated);
        let mut small = Capture::default();
        small.push(vec![0xff, b'o', b'k']);
        assert_eq!(small.text(), ("\u{fffd}ok".to_string(), false));
    }

    #[tokio::test]
    async fn workspace_ports_reach_task_shell_boot_and_each_exec() {
        super::super::tests::install_port_provider();
        let (harness, environment) = harness();
        let backend = harness.backend.clone();
        let mut req = request(&environment);
        req.workspace_root = super::super::tests::PORT_CWD.into();
        req.env.insert("PORT".into(), "9999".into());
        let running = tokio::spawn(async move { backend.exec_task_shell(req).await });
        let exec = next_connect(&harness, 0).await;
        let runtime = decode_agent_environment(&exec.env);
        assert_eq!(runtime.spawn_env["PORT"], "9999");
        assert_eq!(runtime.workspace_env["PORT"], "41000");
        assert_eq!(exec.workspace_env, runtime.workspace_env);
        let boot = harness
            .api
            .specs
            .lock()
            .iter()
            .find(|s| s.cmd[0] == "serve")
            .unwrap()
            .clone();
        let boot_runtime = decode_agent_environment(&boot.env);
        assert!(boot_runtime.spawn_env.is_empty());
        assert_eq!(boot_runtime.workspace_env, runtime.workspace_env);
        let session = format!("session:{}", flag(&exec, "--session"));
        harness
            .api
            .handle_events(&session)
            .send(RunnerEvent::Exited { code: Some(0) })
            .unwrap();
        running.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_command_runs_in_its_own_runtime_with_the_hosts_paths() {
        let (harness, environment) = harness();
        let backend = harness.backend.clone();
        let req = request(&environment);
        let running = tokio::spawn(async move { backend.exec_task_shell(req).await });
        let exec = next_connect(&harness, 0).await;

        assert_eq!(flag(&exec, "--task-cwd"), format!("{PATH}/src"));
        assert_eq!(flag(&exec, "--workspace-alias"), PATH);
        assert_eq!(flag(&exec, "--lease-seconds"), "60");
        let separator = exec.command.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(
            exec.command[separator + 1..],
            ["/bin/sh", "-c", "cat > note"]
        );
        let runtime = decode_agent_environment(&exec.env);
        assert_eq!(
            runtime.spawn_env.get("TASK_FLAG").map(String::as_str),
            Some("1")
        );
        assert!(runtime.lifecycle_phases.is_empty());

        let session = format!("session:{}", flag(&exec, "--session"));
        let mut stdin = harness.api.take_stdin(&session);
        assert_eq!(stdin.recv().await.unwrap(), b"hello");
        assert!(stdin.recv().await.is_none(), "input ends after the payload");
        let events = harness.api.handle_events(&session);
        events.send(RunnerEvent::Stdout(b"done".to_vec())).unwrap();
        events.send(RunnerEvent::Stderr(b"warn".to_vec())).unwrap();
        events.send(RunnerEvent::Exited { code: Some(0) }).unwrap();
        let result = running.await.unwrap().unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "done");
        assert_eq!(result.stderr, "warn");
        assert!(!result.timed_out && !result.stdout_truncated && !result.stderr_truncated);
        assert_eq!(result.provider, "local");
        assert_eq!(result.tier, IsolationTier::Container.as_str());
        assert_eq!(result.container_id, exec.container_id);

        // The runtime is a task shell's: labelled, keyed apart from an agent's,
        // and booted without the task's environment.
        let specs = harness.api.specs.lock().clone();
        let boot = specs.iter().find(|s| s.cmd[0] == "serve").unwrap();
        assert_eq!(boot.labels[TASK_SHELL_RUNTIME_LABEL], "1");
        assert_eq!(boot.labels[PERSISTENT_RUNTIME_LABEL], "1");
        assert!(decode_agent_environment(&boot.env).spawn_env.is_empty());
        assert_eq!(boot.user.as_deref(), Some("0"));
        assert!(boot.cmd.iter().any(|arg| arg == "--runtime-key"));

        // A second command reuses the runtime.
        let backend = harness.backend.clone();
        let mut again = request(&environment);
        again.stdin = None;
        let running = tokio::spawn(async move { backend.exec_task_shell(again).await });
        let second = next_connect(&harness, 1).await;
        assert_eq!(second.container_id, exec.container_id);
        assert_ne!(flag(&second, "--session"), flag(&exec, "--session"));
        let session = format!("session:{}", flag(&second, "--session"));
        let mut stdin = harness.api.take_stdin(&session);
        assert!(
            stdin.recv().await.is_none(),
            "no input closes stdin at once"
        );
        harness
            .api
            .handle_events(&session)
            .send(RunnerEvent::Exited { code: Some(3) })
            .unwrap();
        assert_eq!(running.await.unwrap().unwrap().exit_code, Some(3));
        assert_eq!(
            harness
                .api
                .specs
                .lock()
                .iter()
                .filter(|s| s.cmd[0] == "serve")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn task_shells_never_share_an_agents_runtime() {
        let (harness, mut environment) = harness();
        environment.lifecycle = SandboxLifecycleKind::Persistent;
        harness
            .admission
            .outcome
            .lock()
            .clone_from(&Ok(admitted(environment.clone(), IsolationTier::Container)));
        let mut agent = spawn_config("agent", "kiro-cli", &[], &environment);
        agent.cwd = Some(ROOT.into());
        harness.spawn(agent).await.unwrap();
        let backend = harness.backend.clone();
        let mut req = request(&environment);
        req.cwd = PATH.into();
        let running = tokio::spawn(async move { backend.exec_task_shell(req).await });
        let exec = next_connect(&harness, 1).await;
        let agent_runtime = harness.backend.get_info("agent").await.unwrap()["containerId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(exec.container_id, agent_runtime);
        harness
            .api
            .handle_events(&format!("session:{}", flag(&exec, "--session")))
            .send(RunnerEvent::Exited { code: Some(0) })
            .unwrap();
        running.await.unwrap().unwrap();

        // Releasing the agent's runtime is refused outright.
        let error = harness
            .backend
            .release_task_shell(&[agent_runtime.clone()])
            .await
            .unwrap_err();
        assert_eq!(error.code, "sandbox_task_shell_not_owned");
        assert!(!harness.api.removes.lock().contains(&agent_runtime));
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_command_past_its_timeout_is_signalled_and_reported() {
        let (harness, environment) = harness();
        let backend = harness.backend.clone();
        let mut req = request(&environment);
        req.stdin = None;
        req.timeout_ms = 1_000;
        let running = tokio::spawn(async move { backend.exec_task_shell(req).await });
        let exec = next_connect(&harness, 0).await;
        let session = flag(&exec, "--session").to_string();
        harness
            .api
            .handle_events(&format!("session:{session}"))
            .send(RunnerEvent::Stdout(b"partial".to_vec()))
            .unwrap();
        // The fake answers `signal-agent` by exiting the session with 143.
        let result = running.await.unwrap().unwrap();
        assert!(result.timed_out);
        assert_eq!(result.exit_code, Some(143));
        assert_eq!(result.stdout, "partial");
        assert!(harness.api.runtime_execs.lock().iter().any(|exec| {
            exec.command.get(1).map(String::as_str) == Some("signal-agent")
                && exec.command.iter().any(|arg| arg == &session)
        }));
    }

    #[tokio::test]
    async fn release_removes_only_idle_task_runtimes() {
        let (harness, environment) = harness();
        let backend = harness.backend.clone();
        let req = request(&environment);
        let running = tokio::spawn(async move { backend.exec_task_shell(req).await });
        let exec = next_connect(&harness, 0).await;
        let session = format!("session:{}", flag(&exec, "--session"));
        drop(harness.api.take_stdin(&session));
        harness
            .api
            .handle_events(&session)
            .send(RunnerEvent::Exited { code: Some(0) })
            .unwrap();
        let container = running.await.unwrap().unwrap().container_id;

        // A live session keeps it.
        harness.api.busy_runtimes.lock().insert(container.clone());
        let kept = harness
            .backend
            .release_task_shell(&[container.clone()])
            .await
            .unwrap();
        assert!(kept.is_empty());
        assert!(!harness.api.removes.lock().contains(&container));

        // Idle, it goes; a second release of it is a no-op.
        harness.api.busy_runtimes.lock().clear();
        let removed = harness
            .backend
            .release_task_shell(&[container.clone()])
            .await
            .unwrap();
        assert_eq!(removed, vec![container.clone()]);
        assert!(harness
            .backend
            .release_task_shell(&[container])
            .await
            .unwrap()
            .is_empty());

        // A stopped runtime needs no health check.
        let mut labels = ownership_labels("key", "inst0", "dep1");
        labels.insert(PERSISTENT_RUNTIME_LABEL.into(), "1".into());
        labels.insert(TASK_SHELL_RUNTIME_LABEL.into(), "1".into());
        labels.insert(persistent::RUNTIME_KEY_LABEL.into(), "k".into());
        harness
            .api
            .labels_by_container
            .lock()
            .insert("stopped".into(), labels.clone());
        harness.api.stopped_runtimes.lock().insert("stopped".into());
        harness.api.busy_runtimes.lock().insert("stopped".into());
        assert_eq!(
            harness
                .backend
                .release_task_shell(&["stopped".into()])
                .await
                .unwrap(),
            vec!["stopped".to_string()]
        );

        // Another deployment's task shell is not this Host's to remove.
        labels.insert(DEPLOYMENT_LABEL.into(), "other".into());
        harness
            .api
            .labels_by_container
            .lock()
            .insert("foreign".into(), labels);
        assert_eq!(
            harness
                .backend
                .release_task_shell(&["foreign".into()])
                .await
                .unwrap_err()
                .code,
            "sandbox_task_shell_not_owned"
        );
        let too_many = vec!["x".to_string(); MAX_RELEASE + 1];
        assert_eq!(
            harness
                .backend
                .release_task_shell(&too_many)
                .await
                .unwrap_err()
                .code,
            "sandbox_task_shell_invalid"
        );
    }
}
