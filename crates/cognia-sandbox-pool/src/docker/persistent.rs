//! Retained workspace runtimes. Docker labels survive Host restarts; an exec
//! session owns only its process, never the shared workspace container.

use super::*;
use cognia_external_agent::container_backend::{
    OwnedContainer, RunnerExecSpec, PERSISTENT_RUNTIME_LABEL, TASK_SHELL_RUNTIME_LABEL,
};
use cognia_sandboxd::egress::{EgressConfig, VERSION as EGRESS_VERSION};
use sha2::{Digest, Sha256};

pub(super) const SOCKET: &str = "/tmp/cognia-sandboxd/control.sock";
pub(super) const RUNTIME_KEY_LABEL: &str = "cognia.runtime-key";
pub(super) const PROJECT_LABEL: &str = "cognia.project-id";

fn fault(message: impl Into<String>) -> SandboxSpawnError {
    SandboxSpawnError::fault("sandbox_persistent_runtime_failed", message.into())
}

pub(super) async fn runtime_operation<T>(
    allowlist: bool,
    timeout: Duration,
    operation: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if allowlist {
        tokio::time::timeout(timeout, operation)
            .await
            .map_err(|_| "persistent runtime Docker operation timed out".to_string())?
    } else {
        operation.await
    }
}

/// What a retained runtime is for. A task shell's runtime is never an
/// agent's: releasing it removes the container, which would take an agent's
/// installed packages and running services with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RuntimePurpose {
    Agent,
    TaskShell,
}

pub(super) fn runtime_key(
    spec: &RunnerSpec,
    environment: &EnvironmentSpec,
    purpose: RuntimePurpose,
) -> String {
    // Mount identity is part of compatibility: project ids alone do not
    // distinguish two checkouts, volume subpaths, or another deployment.
    // Keep every container-level setting, including injected bundle mounts,
    // in compatibility. Only per-session inputs and ownership bookkeeping are
    // excluded; adding a RunnerSpec bound must not accidentally allow reuse.
    let mut stable = spec.clone();
    stable.name.clear();
    stable.cmd.clear();
    stable.env.clear();
    // workspace_env remains: a lease change requires a different running instance.
    stable
        .labels
        .retain(|key, _| key == egress::POLICY_DIGEST_LABEL || key == "cognia.execution-binding");
    let identity = match purpose {
        // Unchanged since agent runtimes were introduced: a new spelling
        // would orphan every existing one.
        RuntimePurpose::Agent => format!("{}\0{stable:?}", environment.spec_digest),
        RuntimePurpose::TaskShell => {
            format!("{}\0{stable:?}\0task-shell", environment.spec_digest)
        }
    };
    sha256_hex(identity.as_bytes())
}

/// Lowercase hex SHA-256. Persistent runtimes are matched by the keys this
/// produces, so the format must never drift: a changed spelling would orphan
/// every runtime created under the old one.
pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(super) fn exec_spec(container_id: &str, args: &[&str]) -> RunnerExecSpec {
    RunnerExecSpec {
        workspace_env: BTreeMap::new(),
        container_id: container_id.into(),
        command: std::iter::once(format!("{INJECTION_ROOT}/bin/cognia-sandboxd"))
            .chain(args.iter().map(|arg| (*arg).to_string()))
            .collect(),
        env: Vec::new(),
        working_dir: WORKSPACE_TARGET.into(),
    }
}

pub(super) async fn control(
    api: &Arc<dyn SandboxDockerApi>,
    spec: RunnerExecSpec,
) -> Result<Vec<u8>, String> {
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
pub(super) struct SessionApi {
    daemon: Arc<dyn SandboxDockerApi>,
    container_id: String,
    session: String,
    renewal: tokio::task::JoinHandle<()>,
}

impl SessionApi {
    pub(super) fn new(
        daemon: Arc<dyn SandboxDockerApi>,
        container_id: String,
        session: String,
    ) -> Self {
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
        spec: RunnerSpec,
        auth: Option<RegistryAuth>,
        environment: &EnvironmentSpec,
        config: &ExternalAgentSpawnConfig,
    ) -> Result<(RunningRunner, Arc<dyn ContainerApi>), SandboxSpawnError> {
        let command_start = spec
            .cmd
            .iter()
            .position(|arg| arg == "--")
            .ok_or_else(|| fault("missing agent invocation"))?;
        let invocation = spec.cmd[command_start + 1..].to_vec();
        let workspace_env = spec.workspace_env.clone();
        let acquired = self
            .acquire_runtime(spec, auth, environment, RuntimePurpose::Agent)
            .await?;
        let container_id = acquired.container_id.clone();
        self.remember_retained_task(config, &container_id, environment)?;
        let session = sha256_hex(format!("{}:{}", config.id, default_instance_id()).as_bytes());
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
        let mut runtime =
            runtime_config_with_env(environment, config.env.clone().into_iter().collect())?;
        runtime.egress = acquired.egress.clone();
        runtime.workspace_env = workspace_env.clone();
        request.workspace_env = workspace_env;
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
        if acquired.egress.is_some() && !self.egress_live(&container_id) {
            return Err(SandboxSpawnError::refused(
                "sandbox_egress_unenforceable",
                "runtime egress lease ended before session start",
            ));
        }
        match runtime_operation(
            acquired.egress.is_some(),
            Duration::from_secs(10),
            self.api.exec_runtime(request),
        )
        .await
        {
            Ok(running) => Ok((running, cleanup)),
            Err(error) => {
                let _ = cleanup.remove(&container_id).await;
                Err(if acquired.egress.is_some() {
                    SandboxSpawnError::refused("sandbox_egress_unenforceable", error)
                } else {
                    fault(error)
                })
            }
        }
    }

    /// Find or start the retained runtime for `spec` (an `init-agent` spec
    /// whose command after `--` is dropped) and wait for its lifecycle
    /// preparation. The returned guard is the runtime's lock: a session
    /// connected while it is held cannot race a release of the container.
    pub(super) async fn acquire_runtime(
        &self,
        mut spec: RunnerSpec,
        auth: Option<RegistryAuth>,
        environment: &EnvironmentSpec,
        purpose: RuntimePurpose,
    ) -> Result<AcquiredRuntime, SandboxSpawnError> {
        let key = runtime_key(&spec, environment, purpose);
        let snapshot_mount = spec.mount.clone();
        let workspace_guard = match &snapshot_mount {
            Some(mount) => Some(Arc::new(
                self.snapshot_workspace_lock(mount).read_owned().await,
            )),
            None => None,
        };
        let snapshot_bundle = spec.labels.get("cognia.bundle-digest").cloned();
        let egress = spec
            .labels
            .get(egress::POLICY_DIGEST_LABEL)
            .map(|digest| EgressConfig {
                version: EGRESS_VERSION,
                policy_digest: digest.clone(),
            });
        let runtime_error = |message: String| match &egress {
            Some(_) => SandboxSpawnError::refused("sandbox_egress_unenforceable", message),
            None => fault(message),
        };
        let lock = self.stage_lock(&format!("runtime:{key}"));
        let guard = Arc::new(lock.lock_owned().await);
        let command_start = spec
            .cmd
            .iter()
            .position(|arg| arg == "--")
            .ok_or_else(|| fault("missing agent invocation"))?;
        let mut boot = runtime_config_with_env(environment, BTreeMap::new())?;
        if spec.labels.get("cognia.snapshot-fork").map(String::as_str) == Some("1") {
            boot.lifecycle_phases = vec![LifecyclePhase::PostStart];
        }
        boot.egress = egress.clone();
        boot.workspace_env = spec.workspace_env.clone();
        // Task leases are never baked into a retained container or replayed on
        // restart. Lifecycle preparation uses only the approved project env.
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
        spec.labels.retain(|key, _| {
            key == egress::POLICY_DIGEST_LABEL
                || key == egress::POLICY_DOMAINS_LABEL
                || key == egress::TIER_LABEL
                || key == "cognia.execution-binding"
        });
        spec.labels.extend(ownership_labels(
            &key,
            &self.config.instance_id,
            &self.config.deployment_id,
        ));
        spec.labels
            .insert(PERSISTENT_RUNTIME_LABEL.into(), "1".into());
        if purpose == RuntimePurpose::TaskShell {
            spec.labels
                .insert(TASK_SHELL_RUNTIME_LABEL.into(), "1".into());
        }
        spec.labels.insert(RUNTIME_KEY_LABEL.into(), key.clone());
        spec.labels
            .insert(PROJECT_LABEL.into(), environment.project_id.clone());
        spec.labels
            .insert("cognia.spec-digest".into(), environment.spec_digest.clone());
        let candidates = runtime_operation(
            egress.is_some(),
            Duration::from_secs(10),
            self.api.list_owned(),
        )
        .await
        .map_err(&runtime_error)?;
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
            return Err(runtime_error(
                "multiple persistent runtimes claim the same workspace configuration".into(),
            ));
        }
        let container_id = if let Some(existing) = matching.first() {
            let state = runtime_operation(
                egress.is_some(),
                Duration::from_secs(10),
                self.api.inspect_runtime(&existing.id),
            )
            .await
            .map_err(&runtime_error)?
            .ok_or_else(|| runtime_error("runtime disappeared during acquisition".into()))?;
            let readmit = egress.is_some() && (!state.running || !self.egress_live(&existing.id));
            if readmit {
                self.drain_egress(&existing.id).await?;
                if state.running {
                    runtime_operation(true, CLEANUP_TIMEOUT, self.api.stop_runtime(&existing.id))
                        .await
                        .map_err(&runtime_error)?;
                }
            }
            if !state.running || readmit {
                runtime_operation(
                    egress.is_some(),
                    CLEANUP_TIMEOUT,
                    self.api.start_runtime(&existing.id),
                )
                .await
                .map_err(&runtime_error)?;
            }
            self.ensure_egress(&existing.id, &spec).await?;
            existing.id.clone()
        } else {
            let mut running = self
                .start_inner(
                    spec,
                    auth,
                    OperationLeases {
                        _stage: Some(guard.clone()),
                        _workspace: workspace_guard.clone(),
                        ..OperationLeases::default()
                    },
                )
                .await
                .map_err(|failure| match failure {
                    RunFailure::Pull(error) | RunFailure::Start(error) => fault(error),
                    RunFailure::Timeout => fault("runtime start timed out"),
                    RunFailure::Egress(error) => error,
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
            if egress.is_some() && !self.egress_live(&container_id) {
                return Err(runtime_error(
                    "runtime egress lease ended before readiness".into(),
                ));
            }
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
            if runtime_operation(
                egress.is_some(),
                Duration::from_secs(10),
                self.api.inspect_runtime(&container_id),
            )
            .await
            .map_err(&runtime_error)?
            .is_none_or(|state| !state.running)
            {
                let _ = self.drain_egress(&container_id).await;
                return Err(runtime_error(
                    "persistent runtime exited before lifecycle preparation completed".into(),
                ));
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = self.drain_egress(&container_id).await;
                if egress.is_some() {
                    let _ = runtime_operation(
                        true,
                        CLEANUP_TIMEOUT,
                        self.api.stop_runtime(&container_id),
                    )
                    .await;
                }
                return Err(runtime_error(
                    "persistent runtime readiness timed out".into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if let Some(mount) = &snapshot_mount {
            self.remember_snapshot_runtime(
                &container_id,
                &key,
                environment,
                mount,
                snapshot_bundle.as_deref().unwrap_or(""),
            )?;
        }
        Ok(AcquiredRuntime {
            container_id,
            egress,
            _guard: guard,
            _workspace_guard: workspace_guard,
        })
    }
}

/// A retained runtime that is up and prepared, held under its lock.
pub(super) struct AcquiredRuntime {
    pub container_id: String,
    pub egress: Option<EgressConfig>,
    pub _guard: Arc<tokio::sync::OwnedMutexGuard<()>>,
    pub _workspace_guard: Option<Arc<tokio::sync::OwnedRwLockReadGuard<()>>>,
}

pub(super) fn runtime_ready(state: &Value, expected_key: &str) -> bool {
    state["ready"] == true && state["runtimeKey"].as_str() == Some(expected_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn allowlist_runtime_operations_have_a_setup_deadline() {
        let result = runtime_operation(
            true,
            Duration::from_secs(10),
            std::future::pending::<Result<(), String>>(),
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            "persistent runtime Docker operation timed out"
        );
        let ordinary = runtime_operation(false, Duration::from_secs(1), async {
            tokio::time::sleep(Duration::from_secs(2)).await;
            Ok(())
        })
        .await;
        assert!(ordinary.is_ok());
    }

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
    async fn p4_compatibility_includes_binding_and_container_bounds_but_not_agent_credentials() {
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
        let expected = runtime_key(&original, &environment, RuntimePurpose::Agent);
        let mut tenant = original.clone();
        tenant.labels.insert("cognia.execution-binding".into(), "actor-a/task".into());
        let actor_a = runtime_key(&tenant, &environment, RuntimePurpose::Agent);
        tenant.labels.insert("cognia.execution-binding".into(), "actor-b/task".into());
        assert_ne!(runtime_key(&tenant, &environment, RuntimePurpose::Agent), actor_a);
        assert_ne!(expected, actor_a);
        let mut changed = original.clone();
        changed.extra_mounts[0].volume.push_str("-new-bundle");
        assert_ne!(
            runtime_key(&changed, &environment, RuntimePurpose::Agent),
            expected
        );
        changed = original.clone();
        changed.read_only_rootfs = !changed.read_only_rootfs;
        assert_ne!(
            runtime_key(&changed, &environment, RuntimePurpose::Agent),
            expected
        );
        changed = original.clone();
        changed.tmpfs.push("/new:rw".into());
        assert_ne!(
            runtime_key(&changed, &environment, RuntimePurpose::Agent),
            expected
        );
        changed = original.clone();
        changed.user = Some("1234".into());
        assert_ne!(
            runtime_key(&changed, &environment, RuntimePurpose::Agent),
            expected
        );
        changed = original;
        changed.name = "different-agent".into();
        changed.env.push("TOKEN=fresh".into());
        changed.cmd.push("another-agent-option".into());
        changed.labels.clear();
        assert_eq!(
            runtime_key(&changed, &environment, RuntimePurpose::Agent),
            expected
        );
        changed
            .labels
            .insert(egress::POLICY_DIGEST_LABEL.into(), "policy-one".into());
        let policy_one = runtime_key(&changed, &environment, RuntimePurpose::Agent);
        assert_ne!(policy_one, expected);
        changed
            .labels
            .insert(egress::POLICY_DIGEST_LABEL.into(), "policy-two".into());
        assert_ne!(
            runtime_key(&changed, &environment, RuntimePurpose::Agent),
            policy_one
        );
        changed
            .labels
            .insert(egress::POLICY_DIGEST_LABEL.into(), "policy-one".into());
        changed
            .labels
            .insert("cognia.egress-generation".into(), "another-boot".into());
        changed.env.push("HTTP_PROXY=http://127.0.0.1:45678".into());
        assert_eq!(
            runtime_key(&changed, &environment, RuntimePurpose::Agent),
            policy_one
        );
        changed.labels.clear();
        let without_lease = changed.clone();
        changed.workspace_env.insert("PORT".into(), "41000".into());
        assert_ne!(
            runtime_key(&changed, &environment, RuntimePurpose::Agent),
            expected
        );
        let lease_key = runtime_key(&changed, &environment, RuntimePurpose::Agent);
        changed.workspace_env.insert("PORT".into(), "42000".into());
        assert_ne!(
            runtime_key(&changed, &environment, RuntimePurpose::Agent),
            lease_key
        );
        let first = tokio::time::timeout(
            Duration::from_secs(5),
            harness.backend.acquire_runtime(
                changed.clone(),
                None,
                &environment,
                RuntimePurpose::Agent,
            ),
        )
        .await
        .expect("first runtime acquisition must complete")
        .unwrap();
        let first_id = first.container_id.clone();
        drop(first);
        let reused = tokio::time::timeout(
            Duration::from_secs(5),
            harness.backend.acquire_runtime(
                changed.clone(),
                None,
                &environment,
                RuntimePurpose::Agent,
            ),
        )
        .await
        .expect("matching runtime acquisition must complete")
        .unwrap();
        assert_eq!(first_id, reused.container_id);
        drop(reused);
        changed.workspace_env.insert("PORT".into(), "43000".into());
        let replaced = tokio::time::timeout(
            Duration::from_secs(5),
            harness.backend.acquire_runtime(
                changed.clone(),
                None,
                &environment,
                RuntimePurpose::Agent,
            ),
        )
        .await
        .expect("changed-lease runtime acquisition must complete")
        .unwrap();
        assert_ne!(
            first_id, replaced.container_id,
            "a runtime booted with different ports cannot be reused"
        );
        drop(replaced);
        changed = without_lease;
        // A task shell never resolves to an agent's runtime for the same spec.
        assert_ne!(
            runtime_key(&changed, &environment, RuntimePurpose::TaskShell),
            expected
        );
        harness.backend.kill_all().await.unwrap();
    }

    /// The spelling persistent runtimes are matched by (see `sha256_hex`).
    #[test]
    fn runtime_keys_are_lowercase_sha256_hex() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
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

    #[tokio::test]
    async fn allowlist_context_survives_persistent_sessions_and_host_restart() {
        use crate::docker::tests::{
            admitted, command, config, decode_agent_environment, report, spawn_config, spec,
            Harness,
        };
        use cognia_external_agent::exec_backend::EmitterEventSink;
        let mut environment = spec(EgressTier::Allowlist, None);
        environment.lifecycle = SandboxLifecycleKind::Persistent;
        environment.egress.approved_domains = vec!["registry.npmjs.org".into()];
        let harness = Harness::new(
            admitted(environment.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("before", "kiro-cli", &[], &environment))
            .await
            .unwrap();
        let id = harness.backend.get_info("before").await.unwrap()["containerId"]
            .as_str()
            .unwrap()
            .to_string();
        let boot = harness
            .api
            .specs
            .lock()
            .iter()
            .find(|s| s.cmd[0] == "serve")
            .unwrap()
            .clone();
        assert_eq!(boot.network_mode, "none");
        assert!(boot.cmd.iter().any(|arg| arg == "--require-egress-v1"));
        let expected = decode_agent_environment(&boot.env).egress.unwrap();
        assert_eq!(
            expected.policy_digest,
            boot.labels[egress::POLICY_DIGEST_LABEL]
        );
        let connect = harness
            .api
            .runtime_execs
            .lock()
            .iter()
            .find(|s| s.command.get(1).map(String::as_str) == Some("connect-agent"))
            .unwrap()
            .clone();
        assert_eq!(
            decode_agent_environment(&connect.env).egress,
            Some(expected.clone())
        );
        let generation = |exec: &RunnerExecSpec| {
            exec.command
                .windows(2)
                .find(|pair| pair[0] == "--generation")
                .unwrap()[1]
                .clone()
        };
        let first = generation(
            harness
                .api
                .runtime_execs
                .lock()
                .iter()
                .find(|s| s.command.get(1).map(String::as_str) == Some("bridge-egress"))
                .unwrap(),
        );
        harness.backend.kill_all().await.unwrap();
        harness.backend.drain_egress(&id).await.unwrap();
        let mut next_config = config();
        next_config.instance_id = "next-egress-host".into();
        let next =
            DockerSandboxBackend::new(harness.api.clone(), harness.admission.clone(), next_config);
        next.reap_orphans().await.unwrap();
        next.spawn_sandboxed(
            spawn_config("after", "kiro-cli", &[], &environment),
            EmitterEventSink::new(
                cognia_external_agent::exec_backend::test_support::RecordingAgentEmitter::new(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(next.get_info("after").await.unwrap()["containerId"], id);
        let execs = harness.api.runtime_execs.lock().clone();
        let bridges: Vec<_> = execs
            .iter()
            .filter(|s| s.command.get(1).map(String::as_str) == Some("bridge-egress"))
            .collect();
        assert_eq!(bridges.len(), 2);
        assert_ne!(generation(bridges[1]), first);
        let connect = execs
            .iter()
            .rev()
            .find(|s| s.command.get(1).map(String::as_str) == Some("connect-agent"))
            .unwrap();
        assert_eq!(
            decode_agent_environment(&connect.env).egress,
            Some(expected)
        );
        next.kill_all().await.unwrap();
        next.drain_egress(&id).await.unwrap();
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
