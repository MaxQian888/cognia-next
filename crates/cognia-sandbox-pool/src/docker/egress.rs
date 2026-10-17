//! Container-owned local egress. Only byte streams cross Docker exec; the
//! shared Host FilteringProxy owns policy, resolution and upstream dialing.
use super::*;
use cognia_exec_sandbox::net_proxy::{FilteringProxy, ProxyStream};
use cognia_external_agent::container_backend::{RuntimeContainerState, PERSISTENT_RUNTIME_LABEL};
use cognia_sandboxd::egress::{EgressConfig, Ready, Release, VERSION};
use cognia_sandboxd::service_bridge::{self as wire, Frame};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};

pub(super) const POLICY_DIGEST_LABEL: &str = "cognia.egress-policy-digest";
pub(super) const POLICY_DOMAINS_LABEL: &str = "cognia.egress-policy-domains";
pub(super) const TIER_LABEL: &str = "cognia.egress-tier";
const MATCHER_VERSION: u32 = 1;
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) fn refused(message: impl Into<String>) -> SandboxSpawnError {
    SandboxSpawnError::refused("sandbox_egress_unenforceable", message)
}

#[derive(Clone, Debug)]
pub(super) struct FrozenPolicy {
    domains: Vec<String>,
    digest: String,
}

impl FrozenPolicy {
    pub fn new(mut domains: Vec<String>) -> Self {
        domains.sort();
        domains.dedup();
        let bytes = serde_json::to_vec(&(MATCHER_VERSION, VERSION, &domains))
            .expect("egress policy serializes");
        Self {
            domains,
            digest: persistent::sha256_hex(&bytes),
        }
    }

    pub fn config(&self) -> EgressConfig {
        EgressConfig {
            version: VERSION,
            policy_digest: self.digest.clone(),
        }
    }

    pub fn label(&self, labels: &mut BTreeMap<String, String>) {
        labels.insert(POLICY_DIGEST_LABEL.into(), self.digest.clone());
        labels.insert(
            POLICY_DOMAINS_LABEL.into(),
            serde_json::to_string(&self.domains).unwrap(),
        );
    }

    fn from_spec(spec: &RunnerSpec) -> Result<Option<Self>, SandboxSpawnError> {
        let Some(digest) = spec.labels.get(POLICY_DIGEST_LABEL) else {
            if spec
                .labels
                .get(TIER_LABEL)
                .is_some_and(|tier| tier == "allowlist")
            {
                return Err(refused("local allowlist has no frozen policy"));
            }
            return Ok(None);
        };
        let domains = spec
            .labels
            .get(POLICY_DOMAINS_LABEL)
            .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
            .ok_or_else(|| refused("local allowlist policy is missing or invalid"))?;
        let policy = Self::new(domains);
        if &policy.digest != digest || spec.network_mode != "none" {
            return Err(refused("local allowlist policy or network mode changed"));
        }
        Ok(Some(policy))
    }
}

pub(super) struct EgressLease {
    generation: String,
    digest: String,
    live: Arc<AtomicBool>,
    stop: watch::Sender<bool>,
    done: watch::Receiver<Option<Result<(), String>>>,
}

impl Drop for EgressLease {
    fn drop(&mut self) {
        self.live.store(false, Ordering::SeqCst);
        self.stop.send_replace(true);
    }
}

fn isolated(state: &RuntimeContainerState) -> bool {
    state.running
        && state.network_mode.as_deref() == Some("none")
        && state.network_attachments.keys().all(|name| name == "none")
}

impl DockerSandboxBackend {
    pub(super) fn egress_live(&self, id: &str) -> bool {
        self.egress_leases
            .lock()
            .get(id)
            .is_some_and(|lease| lease.live.load(Ordering::SeqCst))
    }

    pub(super) fn release_egress(&self, id: &str) {
        if let Some(lease) = self.egress_leases.lock().get(id) {
            lease.live.store(false, Ordering::SeqCst);
            lease.stop.send_replace(true);
        }
    }

    pub(super) async fn drain_egress(&self, id: &str) -> Result<(), SandboxSpawnError> {
        let done = self.egress_leases.lock().get(id).map(|lease| {
            lease.live.store(false, Ordering::SeqCst);
            lease.stop.send_replace(true);
            lease.done.clone()
        });
        if let Some(mut done) = done {
            // The pump bounds proxy shutdown and Docker stop; wait for it
            // before a new generation can resume the same container id.
            if done.borrow().is_none() {
                done.changed()
                    .await
                    .map_err(|_| refused("egress teardown worker stopped"))?;
            }
            return done
                .borrow()
                .clone()
                .unwrap_or_else(|| Err("egress teardown has no result".into()))
                .map_err(refused);
        }
        Ok(())
    }

    pub(super) async fn start_inner(
        &self,
        spec: RunnerSpec,
        auth: Option<RegistryAuth>,
        leases: OperationLeases,
    ) -> Result<RunningRunner, RunFailure> {
        let policy = FrozenPolicy::from_spec(&spec).map_err(RunFailure::Egress)?;
        // Establish the Host policy owner before submitting Docker create.
        let proxy = policy
            .as_ref()
            .map(|policy| FilteringProxy::start_streams(policy.domains.clone()))
            .transpose()
            .map_err(|error| RunFailure::Egress(refused(error.to_string())))?;
        let mut running = self
            .start_daemon(spec.clone(), auth)
            .await
            .map_err(|error| {
                if policy.is_none() {
                    return error;
                }
                RunFailure::Egress(refused(match error {
                    RunFailure::Pull(error) | RunFailure::Start(error) => error,
                    RunFailure::Timeout => "runtime start timed out".into(),
                    RunFailure::Egress(error) => error.to_string(),
                }))
            })?;
        if let (Some(policy), Some(proxy)) = (policy, proxy) {
            let id = running.container_id.clone();
            let mut cleanup = HelperCleanup {
                api: self.container.clone(),
                container_id: Some(id.clone()),
                leases,
            };
            if let Err(error) = self.establish_egress(&id, &policy, proxy).await {
                let _ = self.drain_egress(&id).await;
                cleanup.remove().await;
                return Err(RunFailure::Egress(error));
            }
            cleanup.container_id.take();
            // An ephemeral collector and a retained supervisor both release
            // the container lease when their original attach stream ends.
            let (sender, events) = mpsc::channel(64);
            let backend = self.own.clone();
            let generation = self
                .egress_leases
                .lock()
                .get(&id)
                .map(|lease| lease.generation.clone());
            let mut source = running.events;
            tokio::spawn(async move {
                while let Some(event) = source.recv().await {
                    let exited = matches!(event, RunnerEvent::Exited { .. });
                    if sender.send(event).await.is_err() || exited {
                        break;
                    }
                }
                if let Some(backend) = backend.upgrade() {
                    let leases = backend.egress_leases.lock();
                    if let Some(lease) = leases
                        .get(&id)
                        .filter(|lease| Some(&lease.generation) == generation.as_ref())
                    {
                        lease.live.store(false, Ordering::SeqCst);
                        lease.stop.send_replace(true);
                    }
                }
            });
            running.events = events.into();
        }
        Ok(running)
    }

    pub(super) async fn ensure_egress(
        &self,
        id: &str,
        spec: &RunnerSpec,
    ) -> Result<bool, SandboxSpawnError> {
        let Some(policy) = FrozenPolicy::from_spec(spec)? else {
            return Ok(false);
        };
        let matching = self.egress_leases.lock().get(id).is_some_and(|lease| {
            lease.digest == policy.digest && lease.live.load(Ordering::SeqCst)
        });
        if matching {
            let state = tokio::time::timeout(SETUP_TIMEOUT, self.api.inspect_runtime(id)).await;
            if matches!(state, Ok(Ok(Some(ref state))) if isolated(state)) {
                return Ok(true);
            }
            let _ = self.drain_egress(id).await;
            return Err(refused(
                "runtime network isolation could not be re-attested",
            ));
        }
        self.drain_egress(id).await?;
        let proxy = FilteringProxy::start_streams(policy.domains.clone())
            .map_err(|error| refused(error.to_string()))?;
        if let Err(error) = self.establish_egress(id, &policy, proxy).await {
            let _ = self.drain_egress(id).await;
            let _ = tokio::time::timeout(CLEANUP_TIMEOUT, self.api.stop_runtime(id)).await;
            return Err(error);
        }
        Ok(true)
    }

    async fn establish_egress(
        &self,
        id: &str,
        policy: &FrozenPolicy,
        (mut proxy, streams): (FilteringProxy, mpsc::Sender<ProxyStream>),
    ) -> Result<(), SandboxSpawnError> {
        let state = tokio::time::timeout(SETUP_TIMEOUT, self.api.inspect_runtime(id))
            .await
            .map_err(|_| refused("runtime network inspection timed out"))?
            .map_err(refused)?;
        if !state.as_ref().is_some_and(isolated) {
            let _ = tokio::time::timeout(CLEANUP_TIMEOUT, self.api.stop_runtime(id)).await;
            return Err(refused(
                "Docker did not attest network=none with no external attachments",
            ));
        }
        let generation = uuid::Uuid::new_v4().simple().to_string();
        let running = tokio::time::timeout(
            SETUP_TIMEOUT,
            self.api.exec_runtime(persistent::exec_spec(
                id,
                &[
                    "bridge-egress",
                    "--generation",
                    &generation,
                    "--policy-digest",
                    &policy.digest,
                ],
            )),
        )
        .await
        .map_err(|_| refused("egress exec startup timed out"))?
        .map_err(refused)?;
        let (stop, stopped) = watch::channel(false);
        let (finished, done) = watch::channel(None);
        let live = Arc::new(AtomicBool::new(false));
        self.egress_leases.lock().insert(
            id.into(),
            EgressLease {
                generation: generation.clone(),
                digest: policy.digest.clone(),
                live: live.clone(),
                stop,
                done,
            },
        );
        let (ready, received) = oneshot::channel();
        let backend = self.own.clone();
        let api = self.api.clone();
        let container = id.to_string();
        let digest = policy.digest.clone();
        tokio::spawn(async move {
            pump(
                running,
                streams,
                stopped,
                ready,
                &generation,
                &digest,
                &live,
                &api,
                &container,
            )
            .await;
            live.store(false, Ordering::SeqCst);
            let _ = tokio::time::timeout(CLEANUP_TIMEOUT, proxy.shutdown()).await;
            // Serialise teardown with any later re-admission of this id.
            // The map entry remains non-live until stop has completed.
            let result = tokio::time::timeout(CLEANUP_TIMEOUT, api.stop_runtime(&container))
                .await
                .map_err(|_| "egress teardown stop outcome is unknown".to_string())
                .and_then(|result| result);
            if let Some(backend) = backend.upgrade().filter(|_| result.is_ok()) {
                let mut leases = backend.egress_leases.lock();
                if leases
                    .get(&container)
                    .is_some_and(|lease| lease.generation == generation)
                {
                    leases.remove(&container);
                }
            }
            finished.send_replace(Some(result));
        });
        let mut cancel = PendingLease {
            backend: self.own.clone(),
            id: Some(id.into()),
        };
        match tokio::time::timeout(SETUP_TIMEOUT, received).await {
            Ok(Ok(())) if self.egress_live(id) => {
                cancel.id.take();
                Ok(())
            }
            _ => Err(refused(
                "bundle egress protocol, proxy handshake or lease release failed",
            )),
        }
    }

    pub(super) async fn sweep_egress_runtimes(&self) -> Result<Vec<String>, String> {
        let mut stopped = Vec::new();
        for item in self.api.list_owned().await? {
            if item.deployment() != Some(self.config.deployment_id.as_str())
                || item
                    .labels
                    .get(PERSISTENT_RUNTIME_LABEL)
                    .map(String::as_str)
                    != Some("1")
            {
                continue;
            }
            let Some(key) = item.labels.get(persistent::RUNTIME_KEY_LABEL) else {
                continue;
            };
            let lock = self.stage_lock(&format!("runtime:{key}"));
            let Ok(_guard) = lock.try_lock_owned() else {
                continue;
            };
            let tier = item.labels.get(TIER_LABEL).cloned().or_else(|| {
                let body = self
                    .admission
                    .stored_spec(item.labels.get("cognia.spec-digest")?)?;
                body.get("egress")?
                    .get("tier")?
                    .as_str()
                    .map(str::to_string)
            });
            // Unknown legacy policy cannot attest that preserving it is safe.
            let allowlist = tier.as_deref().is_none_or(|tier| tier == "allowlist");
            if !allowlist {
                continue;
            }
            let state = self.api.inspect_runtime(&item.id).await?;
            let legacy = !item.labels.contains_key(POLICY_DIGEST_LABEL)
                || state.as_ref().is_some_and(|state| {
                    state.network_mode.as_deref() != Some("none")
                        || state.network_attachments.keys().any(|name| name != "none")
                });
            if legacy || !self.egress_live(&item.id) {
                self.drain_egress(&item.id)
                    .await
                    .map_err(|error| error.to_string())?;
                tokio::time::timeout(CLEANUP_TIMEOUT, self.api.stop_runtime(&item.id))
                    .await
                    .map_err(|_| "orphan runtime stop timed out".to_string())??;
                if legacy {
                    remove_owned(&self.container, &item.id).await?;
                }
                stopped.push(item.id);
            }
        }
        Ok(stopped)
    }
}

struct PendingLease {
    backend: Weak<DockerSandboxBackend>,
    id: Option<String>,
}
impl Drop for PendingLease {
    fn drop(&mut self) {
        if let (Some(backend), Some(id)) = (self.backend.upgrade(), self.id.take()) {
            backend.release_egress(&id);
        }
    }
}

struct Connection {
    input: mpsc::Sender<Frame>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn connection(
    id: u32,
    streams: &mpsc::Sender<ProxyStream>,
    output: mpsc::Sender<Frame>,
) -> Result<Connection, ()> {
    let (client, server) = tokio::io::duplex(wire::MAX_DATA * 2);
    streams.send(Box::new(server)).await.map_err(|_| ())?;
    let (input, mut incoming) = mpsc::channel::<Frame>(8);
    let task = tokio::spawn(async move {
        let (mut read, mut write) = tokio::io::split(client);
        let mut buffer = vec![0; wire::MAX_DATA];
        let mut read_eof = false;
        let mut write_eof = false;
        let work = async {
            while !(read_eof && write_eof) {
                tokio::select! {
                    result = read.read(&mut buffer), if !read_eof => {
                        let size = result.map_err(|_| ())?;
                        read_eof = size == 0;
                        output.send(Frame {kind: if read_eof {wire::HALF_CLOSE} else {wire::DATA}, id, bytes:buffer[..size].to_vec()}).await.map_err(|_| ())?;
                    }
                    frame = incoming.recv(), if !write_eof => {
                        let frame = frame.ok_or(())?;
                        match frame.kind {
                            wire::DATA => write.write_all(&frame.bytes).await.map_err(|_| ())?,
                            wire::HALF_CLOSE => {write.shutdown().await.map_err(|_| ())?; write_eof=true;}
                            _ => return Err(()),
                        }
                    }
                }
            }
            Ok::<_, ()>(())
        };
        let _ = work.await;
        let _ = output
            .send(Frame {
                kind: wire::CLOSE,
                id,
                bytes: vec![],
            })
            .await;
    });
    Ok(Connection { input, task })
}

async fn send(
    input: &cognia_external_agent::container_backend::RunnerStdin,
    kind: u8,
    bytes: Vec<u8>,
) -> Result<(), ()> {
    let bytes = wire::encode(kind, 0, &bytes).map_err(|_| ())?;
    tokio::time::timeout(Duration::from_secs(2), input.send(bytes))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

#[allow(clippy::too_many_arguments)]
async fn pump(
    mut running: RunningRunner,
    streams: mpsc::Sender<ProxyStream>,
    mut stopped: watch::Receiver<bool>,
    ready: oneshot::Sender<()>,
    generation: &str,
    digest: &str,
    live: &AtomicBool,
    api: &Arc<dyn SandboxDockerApi>,
    container: &str,
) {
    let mut ready = Some(ready);
    let mut releasing = false;
    let mut probe_request = Vec::new();
    let mut probe_response = Vec::new();
    let mut last_id = 0;
    let mut incoming = Vec::new();
    let mut connections = HashMap::<u32, Connection>::new();
    let (output, mut frames) = mpsc::channel::<Frame>(64);
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let work = async {
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                _ = tick.tick() => {
                    if streams.is_closed() { break; }
                    let state = tokio::time::timeout(SETUP_TIMEOUT, api.inspect_runtime(container)).await;
                    if !matches!(state,Ok(Ok(Some(ref state))) if isolated(state)) { break; }
                    send(&running.stdin, wire::RENEW, vec![]).await?;
                }
                frame = frames.recv() => {
                    let frame = frame.ok_or(())?;
                    if frame.kind == wire::CLOSE { connections.remove(&frame.id); }
                    if frame.kind == wire::DATA && frame.id == 1 && ready.is_some() {
                        let remaining = 13usize.saturating_sub(probe_response.len());
                        probe_response.extend_from_slice(&frame.bytes[..frame.bytes.len().min(remaining)]);
                    }
                    let bytes = wire::encode(frame.kind,frame.id,&frame.bytes).map_err(|_| ())?;
                    tokio::time::timeout(Duration::from_secs(2),running.stdin.send(bytes)).await.map_err(|_| ())?.map_err(|_| ())?;
                }
                event = running.events.recv() => match event {
                    Some(RunnerEvent::Stdout(bytes)) => {
                        for chunk in bytes.chunks(wire::MAX_DATA) {
                            incoming.extend_from_slice(chunk);
                            while let Some(frame) = wire::decode(&mut incoming).map_err(|_| ())? {
                                match frame.kind {
                                    wire::EGRESS_READY if ready.is_some() && !releasing => {
                                        let message: Ready = serde_json::from_slice(&frame.bytes).map_err(|_| ())?;
                                        if message.version != VERSION || message.generation != generation
                                            || message.policy_digest != digest || message.port == 0 { return Err(()); }
                                        // A READY is accepted only after an actual proxy stream was opened.
                                        if probe_request != cognia_sandboxd::egress::PROBE_REQUEST
                                            || probe_response != b"HTTP/1.1 400 " { return Err(()); }
                                        releasing = true;
                                        send(&running.stdin,wire::EGRESS_RELEASE,serde_json::to_vec(&Release {
                                            version:VERSION,generation:generation.into(),
                                        }).map_err(|_| ())?).await?;
                                    }
                                    wire::EGRESS_RELEASED if releasing && ready.is_some() => {
                                        let message: Release = serde_json::from_slice(&frame.bytes).map_err(|_| ())?;
                                        if message.version != VERSION || message.generation != generation { return Err(()); }
                                        live.store(true,Ordering::SeqCst);
                                        ready.take().ok_or(())?.send(()).map_err(|_| ())?;
                                    }
                                    wire::OPEN => {
                                        if frame.id <= last_id || connections.len() >= wire::MAX_CONNECTIONS
                                            || (ready.is_some() && (last_id != 0 || frame.id != 1)) { return Err(()); }
                                        last_id = frame.id;
                                        connections.insert(frame.id,connection(frame.id,&streams,output.clone()).await?);
                                    }
                                    wire::DATA | wire::HALF_CLOSE => {
                                        if ready.is_some() && frame.kind == wire::DATA {
                                            if frame.id != 1 { return Err(()); }
                                            probe_request.extend_from_slice(&frame.bytes);
                                            if !cognia_sandboxd::egress::PROBE_REQUEST.starts_with(&probe_request) { return Err(()); }
                                        }
                                        if let Some(connection) = connections.get(&frame.id) {
                                            tokio::time::timeout(Duration::from_secs(2),connection.input.send(frame)).await.map_err(|_| ())?.map_err(|_| ())?;
                                        }
                                    }
                                    wire::CLOSE => {connections.remove(&frame.id);}
                                    _ => return Err(()),
                                }
                            }
                        }
                    }
                    Some(RunnerEvent::Stderr(_)) => {}
                    _ => break,
                }
            }
        }
        Ok::<_, ()>(())
    };
    let _ = work.await;
    live.store(false, Ordering::SeqCst);
    connections.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::docker::tests::{admitted, command, report, spawn_config, spec, Harness};
    use cognia_external_agent::sandbox_routing_backend::SandboxErrorKind;

    fn harness() -> (Harness, ExternalAgentSpawnConfig) {
        let environment = spec(EgressTier::Allowlist, None);
        let config = spawn_config("egress-agent", "kiro-cli", &[], &environment);
        (
            Harness::new(
                admitted(environment, IsolationTier::Container),
                report(vec![command("kiro-cli", None)], vec![]),
                0,
            ),
            config,
        )
    }

    fn assert_refused(error: SandboxSpawnError) {
        assert_eq!(error.kind, SandboxErrorKind::Refused);
        assert_eq!(error.code, "sandbox_egress_unenforceable");
    }

    #[tokio::test]
    async fn egress_exec_unsupported_and_daemon_failure_refuse_optional_isolation() {
        let (harness, config) = harness();
        harness.api.script_exec(|request| {
            (request.command.get(1).map(String::as_str) == Some("bridge-egress"))
                .then(|| Err("exec unsupported".into()))
        });
        assert_refused(harness.spawn(config).await.unwrap_err());
        assert!(harness.backend.egress_leases.lock().is_empty());
        let (harness, config) = self::harness();
        *harness.api.runtimes.lock() = Err("unavailable".into());
        assert_refused(harness.spawn(config).await.unwrap_err());
    }

    #[tokio::test]
    async fn egress_real_inspection_mismatch_refuses_before_bridge_exec() {
        for attachment in [false, true] {
            let (harness, config) = harness();
            let original = harness.api.exit_script.lock().take().unwrap();
            let api = Arc::downgrade(&harness.api);
            harness.api.script_exits(move |spec| {
                if spec.cmd.first().map(String::as_str) == Some("init-agent") {
                    let api = api.upgrade().unwrap();
                    if attachment {
                        for networks in api.network_attachments.lock().values_mut() {
                            networks
                                .insert("unexpected".into(), Some("external-network-id".into()));
                        }
                    } else {
                        for mode in api.network_modes.lock().values_mut() {
                            *mode = "bridge".into();
                        }
                    }
                }
                original(spec)
            });
            assert_refused(harness.spawn(config).await.unwrap_err());
            assert!(harness.api.runtime_execs.lock().is_empty());
            assert!(harness.backend.egress_leases.lock().is_empty());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn egress_old_bundle_and_ready_timeout_refuse_without_enforcement() {
        for old in [true, false] {
            let (harness, config) = harness();
            let retained = Arc::new(Mutex::new(Vec::new()));
            let keep = retained.clone();
            harness.api.script_exec(move |request| {
                if request.command.get(1).map(String::as_str) != Some("bridge-egress") {
                    return None;
                }
                let (events, received) = mpsc::unbounded_channel();
                let (input, stdin) = mpsc::unbounded_channel();
                if old {
                    events
                        .send(RunnerEvent::Stdout(
                            wire::encode(wire::READY, 0, &1234u16.to_be_bytes()).unwrap(),
                        ))
                        .unwrap();
                }
                keep.lock().push((events, stdin));
                Some(Ok(RunningRunner {
                    container_id: request.container_id.clone(),
                    events: received.into(),
                    stdin: input.into(),
                }))
            });
            assert_refused(harness.spawn(config).await.unwrap_err());
            assert!(!harness.backend.egress_live("ctr-5"));
        }
    }

    #[tokio::test]
    async fn egress_bridge_death_stops_runtime_and_clears_enforcement() {
        let (harness, config) = harness();
        harness.spawn(config).await.unwrap();
        let id = harness
            .backend
            .egress_leases
            .lock()
            .keys()
            .next()
            .unwrap()
            .clone();
        assert!(harness.backend.egress_live(&id));
        harness
            .api
            .handle_events(&format!("egress:{id}"))
            .send(RunnerEvent::Exited { code: Some(1) })
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !harness.api.stopped_runtimes.lock().contains(&id)
                || harness.backend.egress_live(&id)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            harness
                .api
                .network_modes
                .lock()
                .get(&id)
                .map(String::as_str),
            Some("none")
        );
    }

    #[tokio::test]
    async fn egress_legacy_persistent_runtime_is_removed_by_orphan_sweep() {
        let (harness, config) = harness();
        harness.spawn(config).await.unwrap();
        let id = harness
            .backend
            .egress_leases
            .lock()
            .keys()
            .next()
            .unwrap()
            .clone();
        {
            let mut all = harness.api.labels_by_container.lock();
            let labels = all.get_mut(&id).unwrap();
            labels.insert(PERSISTENT_RUNTIME_LABEL.into(), "1".into());
            labels.insert(persistent::RUNTIME_KEY_LABEL.into(), "legacy-key".into());
            labels.remove(POLICY_DIGEST_LABEL);
        }
        harness
            .api
            .network_modes
            .lock()
            .insert(id.clone(), "bridge".into());
        assert!(harness
            .backend
            .sweep_egress_runtimes()
            .await
            .unwrap()
            .contains(&id));
        assert!(harness.api.removes.lock().contains(&id));
        assert!(!harness.backend.egress_live(&id));
    }

    #[tokio::test]
    async fn egress_stale_ready_and_forged_probe_refuse() {
        for forged in [true, false] {
            let (harness, config) = harness();
            harness.api.script_exec(move |request| {
                if request.command.get(1).map(String::as_str) != Some("bridge-egress") {
                    return None;
                }
                let argument =
                    |name| request.command.windows(2).find(|p| p[0] == name).unwrap()[1].clone();
                let message = Ready {
                    version: VERSION,
                    generation: if forged {
                        argument("--generation")
                    } else {
                        "stale-generation".into()
                    },
                    policy_digest: argument("--policy-digest"),
                    port: 1234,
                };
                let (events, received) = mpsc::unbounded_channel();
                let (input, mut stdin) = mpsc::unbounded_channel::<Vec<u8>>();
                tokio::spawn(async move {
                    events
                        .send(RunnerEvent::Stdout(
                            wire::encode(wire::OPEN, 1, &[]).unwrap(),
                        ))
                        .unwrap();
                    if !forged {
                        events
                            .send(RunnerEvent::Stdout(
                                wire::encode(wire::DATA, 1, cognia_sandboxd::egress::PROBE_REQUEST)
                                    .unwrap(),
                            ))
                            .unwrap();
                        let mut bytes = Vec::new();
                        'probe: while let Some(chunk) = stdin.recv().await {
                            bytes.extend(chunk);
                            while let Some(frame) = wire::decode(&mut bytes).unwrap() {
                                if frame.kind == wire::DATA
                                    && frame.bytes.starts_with(b"HTTP/1.1 400 ")
                                {
                                    break 'probe;
                                }
                            }
                        }
                    }
                    let _ = events.send(RunnerEvent::Stdout(
                        wire::encode(
                            wire::EGRESS_READY,
                            0,
                            &serde_json::to_vec(&message).unwrap(),
                        )
                        .unwrap(),
                    ));
                    while stdin.recv().await.is_some() {}
                });
                Some(Ok(RunningRunner {
                    container_id: request.container_id.clone(),
                    events: received.into(),
                    stdin: input.into(),
                }))
            });
            assert_refused(harness.spawn(config).await.unwrap_err());
        }
    }

    #[tokio::test]
    async fn egress_teardown_failure_poison_prevents_runtime_reuse() {
        let (harness, config) = harness();
        harness.spawn(config).await.unwrap();
        let id = harness
            .backend
            .egress_leases
            .lock()
            .keys()
            .next()
            .unwrap()
            .clone();
        *harness.api.fail_stop_runtime.lock() = Some("ambiguous daemon stop".into());
        assert_refused(harness.backend.drain_egress(&id).await.unwrap_err());
        assert!(!harness.backend.egress_live(&id));
        assert!(harness.backend.egress_leases.lock().contains_key(&id));
        let runner = harness.api.specs.lock().last().unwrap().clone();
        assert_refused(
            harness
                .backend
                .ensure_egress(&id, &runner)
                .await
                .unwrap_err(),
        );
        assert!(harness.api.restarted_runtimes.lock().is_empty());
    }

    #[tokio::test]
    async fn egress_cancelled_drain_keeps_teardown_until_daemon_settles() {
        let (harness, config) = harness();
        harness.spawn(config).await.unwrap();
        let id = harness
            .backend
            .egress_leases
            .lock()
            .keys()
            .next()
            .unwrap()
            .clone();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *harness.api.stop_gate.lock() = Some(gate.clone());
        let backend = harness.backend.clone();
        let container = id.clone();
        let draining = tokio::spawn(async move { backend.drain_egress(&container).await });
        harness.api.stop_started.notified().await;
        draining.abort();
        let _ = draining.await;
        assert!(!harness.backend.egress_live(&id));
        assert!(harness.backend.egress_leases.lock().contains_key(&id));
        gate.add_permits(1);
        harness.backend.drain_egress(&id).await.unwrap();
        assert!(harness.api.stopped_runtimes.lock().contains(&id));
        assert!(!harness.backend.egress_leases.lock().contains_key(&id));
    }

    #[tokio::test]
    async fn egress_failed_create_holds_preparation_through_cancelled_cleanup() {
        let (harness, config) = harness();
        harness.spawn(config.clone()).await.unwrap();
        let previous = harness.backend.get_info(&config.id).await.unwrap()["containerId"]
            .as_str()
            .unwrap()
            .to_string();
        harness.backend.kill(&config.id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !harness.api.removes.lock().contains(&previous) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        harness.backend.drain_egress(&previous).await.unwrap();
        let failed = Arc::new(tokio::sync::Notify::new());
        let signal = failed.clone();
        harness.api.script_exec(move |request| {
            (request.command.get(1).map(String::as_str) == Some("bridge-egress")).then(|| {
                signal.notify_one();
                Err("unsupported exec".into())
            })
        });
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *harness.api.remove_gate.lock() = Some(gate.clone());
        let mut next = config;
        next.id = "cancel-egress-setup".into();
        let backend = harness.backend.clone();
        let pending = tokio::spawn(async move {
            backend.spawn_sandboxed(next,cognia_external_agent::exec_backend::EmitterEventSink::new(
                cognia_external_agent::exec_backend::test_support::RecordingAgentEmitter::new(),
            )).await
        });
        failed.notified().await;
        pending.abort();
        let _ = pending.await;
        assert_eq!(
            harness.backend.prepare_slots.available_permits(),
            MAX_CONCURRENT_PREPARES - 1
        );
        assert!(harness
            .backend
            .runners
            .reserve("cancel-egress-setup")
            .is_err());
        gate.add_permits(1);
        tokio::time::timeout(Duration::from_secs(2), async {
            while harness.backend.prepare_slots.available_permits() != MAX_CONCURRENT_PREPARES {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(harness
            .backend
            .runners
            .reserve("cancel-egress-setup")
            .is_ok());
    }

    #[test]
    fn policy_digest_is_canonical_and_covers_versions_and_domains() {
        let first = FrozenPolicy::new(vec!["b.test".into(), "a.test".into(), "a.test".into()]);
        assert_eq!(
            first.digest,
            FrozenPolicy::new(vec!["a.test".into(), "b.test".into()]).digest
        );
        assert_ne!(
            first.digest,
            FrozenPolicy::new(vec!["a.test".into()]).digest
        );
        for versions in [
            (MATCHER_VERSION + 1, VERSION),
            (MATCHER_VERSION, VERSION + 1),
        ] {
            assert_ne!(
                first.digest,
                persistent::sha256_hex(
                    &serde_json::to_vec(&(versions.0, versions.1, &first.domains)).unwrap()
                )
            );
        }
    }

    #[test]
    fn enforcement_is_never_claimed_without_a_verified_lease() {
        assert!(!egress_enforced(EgressTier::Allowlist, false));
        assert!(egress_enforced(EgressTier::Allowlist, true));
        assert!(egress_enforced(EgressTier::Off, false));
        assert!(!egress_enforced(EgressTier::On, true));
    }

    /// The production bridge against a real daemon, without bundle staging:
    /// a container the caller created with `--network none`, a Linux
    /// `cognia-sandboxd` at `/cognia/bin/cognia-sandboxd`, curl inside, and
    /// `/workspace` present. COGNIA_TEST_EGRESS_CONTAINER names it,
    /// COGNIA_TEST_EGRESS_ALLOWED_HOST / COGNIA_TEST_EGRESS_DENIED_HOST are two
    /// public HTTPS hosts. Point DOCKER_HOST at the daemon, then run
    /// `cargo test --offline -p cognia-sandbox-pool --features docker real_docker_egress_bridge -- --ignored --test-threads=1`.
    /// The teardown stops the container.
    #[cfg(feature = "docker")]
    #[tokio::test]
    #[ignore = "requires a real Docker daemon and a prepared network=none container"]
    async fn real_docker_egress_bridge_enforces_the_allowlist() {
        use cognia_external_agent::container_backend::bollard_api::BollardContainerApi;
        let id = std::env::var("COGNIA_TEST_EGRESS_CONTAINER").expect("set the container id");
        let allowed = std::env::var("COGNIA_TEST_EGRESS_ALLOWED_HOST").expect("set allowed host");
        let denied = std::env::var("COGNIA_TEST_EGRESS_DENIED_HOST").expect("set denied host");
        let api = BollardContainerApi::connect().unwrap();
        let backend = DockerSandboxBackend::new(
            api.clone(),
            crate::docker::tests::FakeAdmission::admitting(admitted(
                spec(EgressTier::Allowlist, None),
                IsolationTier::Container,
            )),
            crate::docker::tests::config(),
        );
        // The desktop app initializes the Host proxy policy at startup; a bare
        // test process has to, or every upstream dial fails closed.
        cognia_exec_sandbox::net_proxy::install_upstream_policy(None, |_| None).unwrap();
        let policy = FrozenPolicy::new(vec![allowed.clone()]);
        let proxy = FilteringProxy::start_streams(policy.domains.clone()).unwrap();
        backend.establish_egress(&id, &policy, proxy).await.unwrap();
        assert!(backend.egress_live(&id));
        let run = |script: String| {
            let api = backend.api.clone();
            let id = id.clone();
            async move {
                let mut spec = persistent::exec_spec(&id, &[]);
                spec.command = vec!["sh".into(), "-c".into(), script];
                persistent::control(&api, spec).await
            }
        };
        let lease = run(format!("cat {}", cognia_sandboxd::egress::LEASE_PATH))
            .await
            .unwrap();
        let lease: serde_json::Value = serde_json::from_slice(&lease).unwrap();
        let port = lease["ready"]["port"].as_u64().unwrap();
        let curl = |proxy: Option<u64>, host: &str| {
            let via = proxy.map_or("--noproxy '*'".to_string(), |port| {
                format!("--proxy http://127.0.0.1:{port}")
            });
            format!(
                "curl -s -o /dev/null -m 15 -w '%{{http_code}}' {via} https://{host}/ 2>/dev/null; echo \" exit=$?\""
            )
        };
        let allowed_out = String::from_utf8(run(curl(Some(port), &allowed)).await.unwrap()).unwrap();
        let denied_out = String::from_utf8(run(curl(Some(port), &denied)).await.unwrap()).unwrap();
        let direct_out = String::from_utf8(run(curl(None, &allowed)).await.unwrap()).unwrap();
        eprintln!("allowed: {allowed_out} | denied: {denied_out} | direct: {direct_out}");
        assert!(allowed_out.contains(" exit=0"), "allowed host: {allowed_out}");
        assert!(!allowed_out.starts_with("000"), "allowed host: {allowed_out}");
        assert!(!denied_out.contains(" exit=0"), "denied host: {denied_out}");
        assert!(!direct_out.contains(" exit=0"), "direct egress: {direct_out}");
        backend.drain_egress(&id).await.unwrap();
        assert!(!backend.egress_live(&id));
    }
}
