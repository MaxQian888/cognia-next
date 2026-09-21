//! Retained workspace runtimes. Docker labels survive Host restarts; an exec
//! session owns only its process, never the shared workspace container.

use super::*;
use cognia_external_agent::container_backend::{
    OwnedContainer, RunnerExecSpec, PERSISTENT_RUNTIME_LABEL,
};
use sha2::{Digest, Sha256};

pub(super) const SOCKET: &str = "/tmp/cognia-sandboxd/control.sock";
const RUNTIME_KEY_LABEL: &str = "cognia.runtime-key";
const PROJECT_LABEL: &str = "cognia.project-id";

fn fault(message: impl Into<String>) -> SandboxSpawnError {
    SandboxSpawnError::fault("sandbox_persistent_runtime_failed", message.into())
}

fn runtime_key(spec: &RunnerSpec, environment: &EnvironmentSpec) -> String {
    // Mount identity is part of compatibility: project ids alone do not
    // distinguish two checkouts, volume subpaths, or another deployment.
    // Keep every container-level setting, including injected bundle mounts,
    // in compatibility. Only per-session inputs and ownership bookkeeping are
    // excluded; adding a RunnerSpec bound must not accidentally allow reuse.
    let mut stable = spec.clone();
    stable.name.clear();
    stable.cmd.clear();
    stable.env.clear();
    stable.labels.clear();
    let identity = format!("{}\0{stable:?}", environment.spec_digest);
    format!("{:x}", Sha256::digest(identity.as_bytes()))
}

fn exec_spec(container_id: &str, args: &[&str]) -> RunnerExecSpec {
    RunnerExecSpec {
        container_id: container_id.into(),
        command: std::iter::once(format!("{INJECTION_ROOT}/bin/cognia-sandboxd"))
            .chain(args.iter().map(|arg| (*arg).to_string()))
            .collect(),
        env: Vec::new(),
        working_dir: WORKSPACE_TARGET.into(),
    }
}

async fn control(api: &Arc<dyn SandboxDockerApi>, spec: RunnerExecSpec) -> Result<Vec<u8>, String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut running = api.exec_runtime(spec).await?;
        drop(running.stdin);
        let mut output = Vec::new();
        while let Some(event) = running.events.recv().await {
            match event {
                RunnerEvent::Stdout(bytes) if output.len() + bytes.len() <= MAX_CAPTURED_OUTPUT => {
                    output.extend(bytes)
                }
                RunnerEvent::Stdout(_) => {
                    return Err("runtime control response exceeds limit".into())
                }
                RunnerEvent::Stderr(_) => {}
                RunnerEvent::Exited { code: Some(0) } => return Ok(output),
                RunnerEvent::Exited { .. } => return Err("runtime control command failed".into()),
            }
        }
        Err("runtime control stream ended without status".into())
    })
    .await
    .map_err(|_| "runtime control timed out".to_string())?
}

/// The registry's cleanup capability is scoped to an unguessable session id.
/// An old collector cannot kill a later session or delete its shared rootfs.
struct SessionApi {
    daemon: Arc<dyn SandboxDockerApi>,
    container_id: String,
    session: String,
    renewal: tokio::task::JoinHandle<()>,
}

impl SessionApi {
    fn new(daemon: Arc<dyn SandboxDockerApi>, container_id: String, session: String) -> Self {
        let lease_daemon = daemon.clone();
        let lease_container = container_id.clone();
        let lease_session = session.clone();
        let renewal = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(20)).await;
                if let Err(error) = control(
                    &lease_daemon,
                    exec_spec(
                        &lease_container,
                        &[
                            "renew-agent",
                            "--socket",
                            SOCKET,
                            "--session",
                            &lease_session,
                        ],
                    ),
                )
                .await
                {
                    // A transient daemon failure may recover before the
                    // supervisor's 60-second lease expires. It is the server,
                    // not a surviving Docker exec pipe, that owns expiry.
                    log::warn!("persistent agent lease renewal failed: {error}");
                }
            }
        });
        Self {
            daemon,
            container_id,
            session,
            renewal,
        }
    }
}

impl Drop for SessionApi {
    fn drop(&mut self) {
        self.renewal.abort();
    }
}

#[async_trait]
impl ContainerApi for SessionApi {
    async fn run(&self, _: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
        Err(RunnerRunError::Other(
            "session handle cannot create containers".into(),
        ))
    }
    async fn pull_image(&self, _: &str) -> Result<(), String> {
        Err("session handle cannot pull images".into())
    }
    async fn kill(&self, id: &str) -> Result<(), String> {
        if id != self.container_id {
            return Err("session container mismatch".into());
        }
        self.renewal.abort();
        if self
            .daemon
            .inspect_runtime(id)
            .await?
            .is_none_or(|state| !state.running)
        {
            return Ok(());
        }
        control(
            &self.daemon,
            exec_spec(
                id,
                &[
                    "signal-agent",
                    "--socket",
                    SOCKET,
                    "--session",
                    &self.session,
                    "--signal",
                    "TERM",
                ],
            ),
        )
        .await
        .map(|_| ())
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        self.kill(id).await
    }
    async fn labels(&self, id: &str) -> Result<Option<BTreeMap<String, String>>, String> {
        if id != self.container_id {
            return Err("session container mismatch".into());
        }
        self.daemon.labels(id).await
    }
    async fn list_owned(&self) -> Result<Vec<OwnedContainer>, String> {
        Ok(Vec::new())
    }
}

impl DockerSandboxBackend {
    pub(super) async fn start_persistent(
        &self,
        spec: RunnerSpec,
        auth: Option<RegistryAuth>,
        environment: &EnvironmentSpec,
        config: &ExternalAgentSpawnConfig,
        leases: OperationLeases,
    ) -> Result<(RunningRunner, Arc<dyn ContainerApi>), SandboxSpawnError> {
        let backend = self.own.upgrade().expect("backend retained through spawn");
        let environment = environment.clone();
        let config = config.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            // The owned task retains preparation and identity leases until a
            // cancelled Docker exec has settled and its session is terminated.
            let _leases = leases;
            match backend
                .persistent_inner(spec, auth, &environment, &config)
                .await
            {
                Ok((running, cleanup)) => {
                    let id = running.container_id.clone();
                    let (accepted, acknowledgement) = tokio::sync::oneshot::channel();
                    let _ = sender.send(Ok((running, cleanup.clone(), accepted)));
                    if acknowledgement.await.is_err() {
                        if let Err(error) = cleanup.remove(&id).await {
                            log::warn!("cancelled persistent session cleanup failed: {error}");
                        }
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error));
                }
            }
        });
        let (running, cleanup, accepted) = receiver
            .await
            .map_err(|_| fault("runtime worker stopped"))??;
        let _ = accepted.send(());
        Ok((running, cleanup))
    }

    async fn persistent_inner(
        &self,
        mut spec: RunnerSpec,
        auth: Option<RegistryAuth>,
        environment: &EnvironmentSpec,
        config: &ExternalAgentSpawnConfig,
    ) -> Result<(RunningRunner, Arc<dyn ContainerApi>), SandboxSpawnError> {
        let key = runtime_key(&spec, environment);
        let lock = self.stage_lock(&format!("runtime:{key}"));
        let _guard = lock.lock().await;
        let command_start = spec
            .cmd
            .iter()
            .position(|arg| arg == "--")
            .ok_or_else(|| fault("missing agent invocation"))?;
        let invocation = spec.cmd[command_start + 1..].to_vec();
        let mut boot = runtime_config(environment, config)?;
        // Task leases are never baked into a retained container or replayed on
        // restart. Lifecycle preparation uses only the approved project env.
        boot.spawn_env.clear();
        boot.lifecycle_phases
            .retain(|phase| *phase != LifecyclePhase::PostAttach);
        spec.env = encode_runtime_config_env(&boot).map_err(|error| fault(error.to_string()))?;
        spec.cmd.truncate(command_start);
        spec.cmd[0] = "serve".into();
        spec.cmd.extend([
            "--socket".into(),
            SOCKET.into(),
            "--runtime-key".into(),
            key.clone(),
            "--idle-timeout-secs".into(),
            "300".into(),
        ]);
        for port in &environment.forward_ports {
            spec.cmd
                .extend(["--forward-port".into(), port.port.to_string()]);
        }
        spec.name = format!(
            "cognia-runtime-{}-{}",
            sanitize_container_name(&self.config.deployment_id),
            &key[..32]
        );
        spec.labels = ownership_labels(&key, &self.config.instance_id, &self.config.deployment_id);
        spec.labels
            .insert(PERSISTENT_RUNTIME_LABEL.into(), "1".into());
        spec.labels.insert(RUNTIME_KEY_LABEL.into(), key.clone());
        spec.labels
            .insert(PROJECT_LABEL.into(), environment.project_id.clone());
        spec.labels
            .insert("cognia.spec-digest".into(), environment.spec_digest.clone());
        let candidates = self.api.list_owned().await.map_err(fault)?;
        let matching: Vec<_> = candidates
            .into_iter()
            .filter(|item| {
                item.deployment() == Some(self.config.deployment_id.as_str())
                    && item.labels.get(RUNTIME_KEY_LABEL) == Some(&key)
                    && item
                        .labels
                        .get(PERSISTENT_RUNTIME_LABEL)
                        .map(String::as_str)
                        == Some("1")
            })
            .collect();
        if matching.len() > 1 {
            return Err(fault(
                "multiple persistent runtimes claim the same workspace configuration",
            ));
        }
        let container_id = if let Some(existing) = matching.first() {
            let state = self
                .api
                .inspect_runtime(&existing.id)
                .await
                .map_err(fault)?
                .ok_or_else(|| fault("runtime disappeared during acquisition"))?;
            if !state.running {
                self.api.start_runtime(&existing.id).await.map_err(fault)?;
            }
            existing.id.clone()
        } else {
            let mut running =
                self.start_inner(spec, auth)
                    .await
                    .map_err(|failure| match failure {
                        RunFailure::Pull(error) | RunFailure::Start(error) => fault(error),
                        RunFailure::Timeout => fault("runtime start timed out"),
                    })?;
            let container_id = running.container_id.clone();
            // Docker retains the rootfs after serve exits on idle. Only its
            // attach stream is drained here; no agent collector owns deletion.
            tokio::spawn(async move {
                while let Some(event) = running.events.recv().await {
                    if matches!(event, RunnerEvent::Exited { .. }) {
                        break;
                    }
                }
            });
            container_id
        };
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(boot.lifecycle_timeout_ms.saturating_mul(4) + 30_000);
        loop {
            if let Ok(body) = control(
                &self.api,
                exec_spec(&container_id, &["health", "--socket", SOCKET]),
            )
            .await
            {
                if serde_json::from_slice::<Value>(&body)
                    .ok()
                    .is_some_and(|state| runtime_ready(&state, &key))
                {
                    break;
                }
            }
            if self
                .api
                .inspect_runtime(&container_id)
                .await
                .map_err(fault)?
                .is_none_or(|state| !state.running)
            {
                return Err(fault(
                    "persistent runtime exited before lifecycle preparation completed",
                ));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(fault("persistent runtime readiness timed out"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let session = format!(
            "{:x}",
            Sha256::digest(format!("{}:{}", config.id, default_instance_id()).as_bytes())
        );
        let mut request = exec_spec(
            &container_id,
            &[
                "connect-agent",
                "--socket",
                SOCKET,
                "--session",
                &session,
                "--lease-seconds",
                "60",
                "--",
            ],
        );
        request.command.extend(invocation);
        let mut runtime = runtime_config(environment, config)?;
        runtime.lifecycle_phases = vec![LifecyclePhase::PostAttach];
        request.env =
            encode_runtime_config_env(&runtime).map_err(|error| fault(error.to_string()))?;
        let cleanup: Arc<dyn ContainerApi> = Arc::new(SessionApi::new(
            self.api.clone(),
            container_id.clone(),
            session,
        ));
        // A failed start may still have reached the server; signal the unique
        // session before releasing the reservation, never retry that exec.
        match self.api.exec_runtime(request).await {
            Ok(running) => Ok((running, cleanup)),
            Err(error) => {
                let _ = cleanup.remove(&container_id).await;
                Err(fault(error))
            }
        }
    }
}

fn runtime_ready(state: &Value, expected_key: &str) -> bool {
    state["ready"] == true && state["runtimeKey"].as_str() == Some(expected_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn session_lease_renewal_stops_when_its_owner_is_dropped() {
        use cognia_external_agent::container_backend::test_support::FakeContainerApi;
        let api = FakeContainerApi::new();
        let owner = SessionApi::new(api.clone(), "container".into(), "unique-session".into());
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(20)).await;
        tokio::task::yield_now().await;
        assert_eq!(api.runtime_execs.lock().len(), 1);
        assert!(api.runtime_execs.lock()[0]
            .command
            .windows(2)
            .any(|args| args == ["--session", "unique-session"]));
        drop(owner);
        tokio::time::advance(Duration::from_secs(120)).await;
        tokio::task::yield_now().await;
        assert_eq!(api.runtime_execs.lock().len(), 1);
    }

    #[tokio::test]
    async fn compatibility_includes_bundle_and_all_container_bounds_but_not_agent_credentials() {
        use crate::docker::tests::{admitted, command, report, spawn_config, spec, Harness};
        let environment = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(environment.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("compatibility", "kiro-cli", &[], &environment))
            .await
            .unwrap();
        let original = harness
            .api
            .specs
            .lock()
            .iter()
            .find(|spec| spec.cmd.first().is_some_and(|arg| arg == "init-agent"))
            .unwrap()
            .clone();
        let expected = runtime_key(&original, &environment);
        let mut changed = original.clone();
        changed.extra_mounts[0].volume.push_str("-new-bundle");
        assert_ne!(runtime_key(&changed, &environment), expected);
        changed = original.clone();
        changed.read_only_rootfs = !changed.read_only_rootfs;
        assert_ne!(runtime_key(&changed, &environment), expected);
        changed = original.clone();
        changed.tmpfs.push("/new:rw".into());
        assert_ne!(runtime_key(&changed, &environment), expected);
        changed = original.clone();
        changed.user = Some("1234".into());
        assert_ne!(runtime_key(&changed, &environment), expected);
        changed = original;
        changed.name = "different-agent".into();
        changed.env.push("TOKEN=fresh".into());
        changed.cmd.push("another-agent-option".into());
        changed.labels.clear();
        assert_eq!(runtime_key(&changed, &environment), expected);
        harness.backend.kill_all().await.unwrap();
    }

    #[test]
    fn readiness_is_bound_to_the_expected_runtime_configuration() {
        assert!(runtime_ready(
            &serde_json::json!({"ready":true,"runtimeKey":"expected"}),
            "expected"
        ));
        assert!(!runtime_ready(
            &serde_json::json!({"ready":true,"runtimeKey":"stale"}),
            "expected"
        ));
        assert!(!runtime_ready(
            &serde_json::json!({"ready":true}),
            "expected"
        ));
    }

    #[test]
    fn control_commands_use_fixed_socket_and_no_shell() {
        let request = exec_spec(
            "container",
            &[
                "signal-agent",
                "--socket",
                SOCKET,
                "--session",
                "session",
                "--signal",
                "TERM",
            ],
        );
        assert_eq!(request.command[0], "/cognia/bin/cognia-sandboxd");
        assert!(request.env.is_empty());
        assert_eq!(request.working_dir, "/workspace");
    }
}
