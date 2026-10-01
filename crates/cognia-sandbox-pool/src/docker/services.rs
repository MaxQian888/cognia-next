//! Private reverse service transport for one currently admitted agent adoption.
use super::*;
use crate::runtime::{ToolHostBridge, ToolHostService};
use cognia_external_agent::container_backend::{AgentServiceScope, RunnerExecSpec};
use cognia_sandboxd::service_bridge::{self as wire, Frame};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) struct PendingToolHost {
    pub deadline: tokio::time::Instant,
    pub service: ToolHostService,
}
pub(super) struct ServiceLease {
    pub deadline: tokio::time::Instant,
    pub scope: AgentServiceScope,
    pub scopes: Arc<Mutex<Vec<AgentServiceScope>>>,
    identity: String,
    pub authorization: Arc<dyn Fn() -> bool + Send + Sync>,
    listen_port: Option<u16>,
    stop: tokio::sync::watch::Sender<bool>,
}
impl Drop for ServiceLease {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

fn service_identity(service: &ToolHostService) -> String {
    format!(
        "{}:{}:{}",
        service.lease_id, service.generation, service.owner_session_id
    )
}

fn fault(message: impl Into<String>) -> SandboxSpawnError {
    SandboxSpawnError::refused("sandbox_service_unavailable", message.into())
}

struct Connection {
    input: tokio::sync::mpsc::Sender<Frame>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn connection(id: u32, port: u16, output: tokio::sync::mpsc::Sender<Frame>) -> Connection {
    let (input, mut received) = tokio::sync::mpsc::channel::<Frame>(8);
    let task = tokio::spawn(async move {
        let work = async {
            let stream = tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)),
            )
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
            let (mut read, mut write) = stream.into_split();
            let mut buffer = vec![0; wire::MAX_DATA];
            let mut read_eof = false;
            let mut write_eof = false;
            while !(read_eof && write_eof) {
                tokio::select! {
                    result=read.read(&mut buffer), if !read_eof => {
                        let size=result.map_err(|_| ())?;
                        read_eof=size==0;
                        output.send(Frame {kind:if read_eof {wire::HALF_CLOSE} else {wire::DATA},id,bytes:buffer[..size].to_vec()}).await.map_err(|_| ())?;
                    },
                    frame=received.recv(), if !write_eof => {
                        let frame=frame.ok_or(())?;
                        if frame.kind==wire::HALF_CLOSE { write.shutdown().await.map_err(|_| ())?; write_eof=true; }
                        else if frame.kind==wire::DATA { write.write_all(&frame.bytes).await.map_err(|_| ())?; }
                        else { return Err(()); }
                    },
                    _=tokio::time::sleep(Duration::from_secs(120)) => return Err(()),
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
    Connection { input, task }
}

impl DockerSandboxBackend {
    pub(super) fn register_pending_tool_host(
        &self,
        service: ToolHostService,
    ) -> Result<String, SandboxSpawnError> {
        if service.agent_id.is_empty()
            || service.agent_id.len() > 256
            || service.port == 0
            || service.generation == 0
            || service.owner_session_id.is_empty()
            || service.owner_session_id.len() > 256
            || service.lease_id.len() < 16
            || service.lease_id.len() > 256
            || !service.authorization.as_ref().is_some_and(|check| check())
        {
            return Err(fault("Invalid pending hosted tool lease"));
        }
        if service.origin_device_id.as_ref().is_some_and(|device| {
            device.is_empty()
                || device.len() > 256
                || !service
                    .lease_id
                    .starts_with(&format!("remote-tool-host:{device}:"))
        }) {
            return Err(fault("Hosted service device mismatch"));
        }
        let mut pending = self.pending_tool_hosts.lock();
        pending.retain(|_, lease| {
            lease.deadline > tokio::time::Instant::now()
                && lease
                    .service
                    .authorization
                    .as_ref()
                    .is_some_and(|check| check())
        });
        if pending.len() >= 128 {
            return Err(fault("Pending hosted tool lease limit reached"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        pending.insert(
            id.clone(),
            PendingToolHost {
                deadline: tokio::time::Instant::now() + Duration::from_secs(60),
                service,
            },
        );
        Ok(id)
    }
    pub(super) fn pending_service(
        &self,
        id: &str,
        agent: &str,
    ) -> Result<ToolHostService, SandboxSpawnError> {
        let mut service = {
            let pending = self.pending_tool_hosts.lock();
            let lease = pending
                .get(id)
                .ok_or_else(|| fault("Hosted tool lease is unavailable"))?;
            if lease.deadline <= tokio::time::Instant::now()
                || lease.service.origin_device_id
                    != cognia_external_agent::spawn_authority::current_origin()
                || !lease
                    .service
                    .authorization
                    .as_ref()
                    .is_some_and(|check| check())
            {
                return Err(fault(
                    "Hosted tool lease is expired or belongs to another device",
                ));
            }
            lease.service.clone()
        };
        let backend = self.own.clone();
        let id = id.to_owned();
        service.agent_id = agent.to_owned();
        service.authorization = Some(Arc::new(move || {
            backend.upgrade().is_some_and(|backend| {
                backend
                    .pending_tool_hosts
                    .lock()
                    .get(&id)
                    .is_some_and(|lease| {
                        lease.deadline > tokio::time::Instant::now()
                            && lease
                                .service
                                .authorization
                                .as_ref()
                                .is_some_and(|check| check())
                    })
            })
        }));
        Ok(service)
    }
    pub(super) async fn open_pending_bridge(
        &self,
        service: ToolHostService,
        nonce: Option<String>,
    ) -> Result<ToolHostBridge, SandboxSpawnError> {
        let scope = self
            .runners
            .service_scope(
                &service.agent_id,
                service.origin_device_id.as_deref(),
                &service.owner_session_id,
            )
            .map_err(fault)?;
        if !self.service_admitted(&scope).await
            || !service.authorization.as_ref().is_some_and(|check| check())
        {
            return Err(fault("Sandbox admission is no longer valid"));
        }
        let lock = self.stage_lock(&format!("service:{}:{}", scope.container_id, service.port));
        let _guard = lock.lock().await;
        if !self.service_admitted(&scope).await
            || !service.authorization.as_ref().is_some_and(|check| check())
        {
            return Err(fault("Sandbox admission is no longer valid"));
        }
        let (previous, reused) = {
            let mut bridges = self.service_bridges.lock();
            let matching = bridges
                .iter()
                .filter(|(_, lease)| {
                    lease.listen_port == Some(service.port)
                        && lease.scope.container_id == scope.container_id
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let mut reused = None;
            for id in &matching {
                if let Some(lease) = bridges.get(id) {
                    if lease
                        .scopes
                        .lock()
                        .iter()
                        .any(|scope| self.runners.service_scope_active(scope))
                        && (lease.authorization)()
                    {
                        if lease.identity != service_identity(&service) {
                            return Err(fault(
                                "This service port belongs to another active hosted tool lease",
                            ));
                        }
                        lease.scopes.lock().push(scope.clone());
                        reused = Some(ToolHostBridge {
                            bridge_id: id.clone(),
                            port: service.port,
                        });
                        break;
                    }
                }
            }
            if reused.is_none() {
                for id in &matching {
                    bridges.remove(id);
                }
            }
            (!matching.is_empty(), reused)
        };
        if let Some(bridge) = reused {
            if let Some(nonce) = nonce {
                super::persistent::control(
                    &self.api,
                    RunnerExecSpec {
                        container_id: scope.container_id,
                        command: vec![
                            format!("{INJECTION_ROOT}/bin/cognia-sandboxd"),
                            "publish-gateway-ready".into(),
                            "--nonce".into(),
                            nonce,
                            "--port".into(),
                            service.port.to_string(),
                        ],
                        env: vec![],
                        working_dir: WORKSPACE_TARGET.into(),
                    },
                )
                .await
                .map_err(fault)?;
            }
            return Ok(bridge);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let result = self
                .open_service_bridge_inner(service.clone(), nonce.clone(), true)
                .await;
            if result.is_ok() || !previous || tokio::time::Instant::now() >= deadline {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    async fn service_scopes_admitted(&self, scopes: &Arc<Mutex<Vec<AgentServiceScope>>>) -> bool {
        let active = {
            let mut scopes = scopes.lock();
            scopes.retain(|scope| self.runners.service_scope_active(scope));
            scopes.first().cloned()
        };
        match active {
            Some(scope) => self.service_admitted(&scope).await,
            None => false,
        }
    }
    async fn service_admitted(&self, scope: &AgentServiceScope) -> bool {
        if !self.runners.service_scope_active(scope) {
            return false;
        }
        matches!(tokio::time::timeout(Duration::from_secs(10),self.port_spec(&scope.project_id,&scope.container_id)).await,
            Ok(Ok(Some(spec))) if spec.spec_digest==scope.spec_digest)
            && self.runners.service_scope_active(scope)
    }

    pub(super) async fn open_service_bridge(
        &self,
        service: ToolHostService,
    ) -> Result<ToolHostBridge, SandboxSpawnError> {
        self.open_service_bridge_inner(service, None, false).await
    }

    pub(super) async fn open_gateway_bridge(
        &self,
        service: ToolHostService,
        nonce: String,
    ) -> Result<ToolHostBridge, SandboxSpawnError> {
        self.open_service_bridge_inner(service, Some(nonce), false)
            .await
    }

    async fn open_service_bridge_inner(
        &self,
        service: ToolHostService,
        gateway_nonce: Option<String>,
        fixed_port: bool,
    ) -> Result<ToolHostBridge, SandboxSpawnError> {
        let authority = service
            .authorization
            .clone()
            .ok_or_else(|| fault("Missing Host service authority"))?;
        if !authority() {
            return Err(fault("Host service authority was revoked"));
        }
        if service.port == 0
            || service.generation == 0
            || service.lease_id.len() < 16
            || service.lease_id.len() > 256
            || service.agent_id.is_empty()
            || service.agent_id.len() > 256
            || service
                .origin_device_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 256)
        {
            return Err(fault("Invalid hosted service identity"));
        }
        if let Some(device) = &service.origin_device_id {
            if !service
                .lease_id
                .starts_with(&format!("remote-tool-host:{device}:"))
            {
                return Err(fault("Hosted service device mismatch"));
            }
        }
        let scope = self
            .runners
            .service_scope(
                &service.agent_id,
                service.origin_device_id.as_deref(),
                &service.owner_session_id,
            )
            .map_err(fault)?;
        if !self.service_admitted(&scope).await || !authority() {
            return Err(fault("Sandbox admission is no longer valid"));
        }
        let permit = self
            .port_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| fault("Sandbox bridge limit reached"))?;
        let mut running = tokio::time::timeout(
            Duration::from_secs(10),
            self.api.exec_runtime(RunnerExecSpec {
                container_id: scope.container_id.clone(),
                command: {
                    let mut command = vec![
                        format!("{INJECTION_ROOT}/bin/cognia-sandboxd"),
                        "bridge-service".into(),
                    ];
                    if fixed_port {
                        command.extend(["--listen-port".into(), service.port.to_string()]);
                    }
                    if let Some(nonce) = gateway_nonce.as_ref() {
                        command.extend(["--gateway-nonce".into(), nonce.clone()]);
                    }
                    command
                },
                env: vec![],
                working_dir: WORKSPACE_TARGET.into(),
            }),
        )
        .await
        .map_err(|_| fault("Sandbox bridge startup timed out"))?
        .map_err(fault)?;
        let scopes = Arc::new(Mutex::new(vec![scope.clone()]));
        let bridge_id = uuid::Uuid::new_v4().to_string();
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        self.service_bridges.lock().insert(
            bridge_id.clone(),
            ServiceLease {
                deadline: tokio::time::Instant::now() + Duration::from_secs(60),
                scope: scope.clone(),
                scopes: scopes.clone(),
                identity: service_identity(&service),
                authorization: authority.clone(),
                listen_port: fixed_port.then_some(service.port),
                stop,
            },
        );
        let backend = self.own.upgrade().expect("active backend");
        let id = bridge_id.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _permit = permit;
            let mut ready = Some(ready_tx);
            let mut incoming = Vec::new();
            let mut last_connection_id = 0;
            let mut connections: HashMap<u32, Connection> = HashMap::new();
            let (output, mut frames) = tokio::sync::mpsc::channel::<Frame>(64);
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let work = async {
                loop {
                    tokio::select! {
                        _=stopped.changed() => break,
                        _=tick.tick() => {
                            let live=backend.service_bridges.lock().get(&id).is_some_and(|lease| lease.deadline>tokio::time::Instant::now());
                            if !live || !authority() || !backend.service_scopes_admitted(&scopes).await || !authority() { break; }
                            if gateway_nonce.is_some() || fixed_port {
                                if let Some(lease)=backend.service_bridges.lock().get_mut(&id) { lease.deadline=tokio::time::Instant::now()+Duration::from_secs(60); }
                            }
                            send(&running.stdin,Frame {kind:wire::RENEW,id:0,bytes:vec![]}).await?;
                        },
                        Some(frame)=frames.recv() => {
                            if frame.kind==wire::CLOSE { connections.remove(&frame.id); }
                            send(&running.stdin,frame).await?;
                        },
                        event=running.events.recv() => match event {
                            Some(RunnerEvent::Stdout(bytes)) => {
                                // Docker frame chunks are not protocol frames. Consume incrementally
                                // so even an oversized daemon chunk cannot grow the decoder unbounded.
                                for chunk in bytes.chunks(wire::MAX_DATA) {
                                    incoming.extend_from_slice(chunk);
                                    while let Some(frame)=wire::decode(&mut incoming).map_err(|_| ())? {
                                        match frame.kind {
                                            wire::READY => {
                                                let Some(sender)=ready.take() else { return Err(()); };
                                                let port=u16::from_be_bytes(frame.bytes.as_slice().try_into().map_err(|_| ())?);
                                                if port==0 || (fixed_port && port!=service.port) { return Err(()); }
                                                sender.send(port).map_err(|_| ())?;
                                            },
                                            wire::OPEN if ready.is_none() => {
                                                if connections.len()>=wire::MAX_CONNECTIONS || frame.id <= last_connection_id || !authority() || !backend.service_scopes_admitted(&scopes).await || !authority() { return Err(()); }
                                                last_connection_id = frame.id;
                                                connections.insert(frame.id,connection(frame.id,service.port,output.clone()));
                                            },
                                            wire::DATA | wire::HALF_CLOSE => {
                                                if let Some(conn)=connections.get(&frame.id) {
                                                    if !matches!(tokio::time::timeout(Duration::from_secs(2),conn.input.send(Frame {kind:frame.kind,id:frame.id,bytes:frame.bytes})).await,Ok(Ok(()))) {
                                                        connections.remove(&frame.id);
                                                        send(&running.stdin,Frame {kind:wire::CLOSE,id:frame.id,bytes:vec![]}).await?;
                                                    }
                                                }
                                            },
                                            wire::CLOSE => { connections.remove(&frame.id); },
                                            _ => return Err(()),
                                        }
                                    }
                                }
                            },
                            Some(RunnerEvent::Stderr(_)) => {},
                            _ => break,
                        }
                    }
                }
                Ok::<_, ()>(())
            };
            let _ = work.await;
            connections.clear();
            backend.service_bridges.lock().remove(&id);
            // Dropping stdin revokes the helper; its own 60s deadline also
            // covers daemon implementations that retain the exec pipe.
        });
        match tokio::time::timeout(Duration::from_secs(8), ready_rx).await {
            Ok(Ok(port)) => Ok(ToolHostBridge { bridge_id, port }),
            _ => {
                self.service_bridges.lock().remove(&bridge_id);
                Err(fault(
                    "Agent bundle does not support hosted service bridges or startup failed",
                ))
            }
        }
    }
}

async fn send(
    input: &cognia_external_agent::container_backend::RunnerStdin,
    frame: Frame,
) -> Result<(), ()> {
    let bytes = wire::encode(frame.kind, frame.id, &frame.bytes).map_err(|_| ())?;
    tokio::time::timeout(Duration::from_secs(2), input.send(bytes))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::tests::{admitted, command, report, spawn_config, spec, Harness};
    use crate::runtime::SandboxRuntimeControl;

    fn gateway_config(environment: &EnvironmentSpec) -> ExternalAgentSpawnConfig {
        let mut config = spawn_config("gateway-agent", "kiro-cli", &[], environment);
        config.env.extend([
            (
                "COGNIA_GATEWAY_TASK_CONFIG".into(),
                serde_json::json!({"taskId":"task", "runtime":"claude", "binding":{}, "files":{}})
                    .to_string(),
            ),
            ("COGNIA_GATEWAY_TOKEN".into(), "fixture-task-secret".into()),
            ("ANTHROPIC_AUTH_TOKEN".into(), "fixture-task-secret".into()),
            ("ANTHROPIC_BASE_URL".into(), "http://127.0.0.1:32123".into()),
        ]);
        config
    }

    #[tokio::test]
    async fn pending_tools_attach_before_spawn_share_siblings_and_immediately_rebind() {
        use cognia_external_agent::spawn_authority::with_remote_origin;
        let mut environment = spec(EgressTier::Off, None);
        environment.lifecycle = SandboxLifecycleKind::Persistent;
        let harness = Harness::new(
            admitted(environment.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], vec![]),
            0,
        );
        let pending = harness
            .backend
            .register_tool_host(ToolHostService {
                agent_id: "parent".into(),
                owner_session_id: "chat".into(),
                origin_device_id: Some("device-a".into()),
                lease_id: "remote-tool-host:device-a:pending".into(),
                generation: 1,
                port: 32123,
                authorization: Some(Arc::new(|| true)),
            })
            .await
            .unwrap();
        let config = |id: &str| {
            let mut config = spawn_config(id, "kiro-cli", &[], &environment);
            let SandboxPlacement::Container {
                hosted_tool_host_lease_ids,
                ..
            } = config.sandbox.as_mut().unwrap();
            hosted_tool_host_lease_ids.push(pending.clone());
            config
        };
        assert!(
            with_remote_origin("device-b", harness.spawn(config("foreign")))
                .await
                .is_err()
        );
        with_remote_origin("device-a", harness.spawn(config("parent:a")))
            .await
            .unwrap();
        let first = harness
            .backend
            .service_bridges
            .lock()
            .keys()
            .next()
            .unwrap()
            .clone();
        with_remote_origin("device-a", harness.spawn(config("parent:b")))
            .await
            .unwrap();
        assert_eq!(harness.backend.service_bridges.lock().len(), 1);
        assert_eq!(
            harness.backend.service_bridges.lock()[&first]
                .scopes
                .lock()
                .len(),
            2
        );
        harness.backend.kill("parent:a").await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while harness.backend.runners.contains("parent:a") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            harness.backend.renew_tool_host(&first),
            "sibling retains bridge"
        );
        harness.backend.kill("parent:b").await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while harness.backend.runners.contains("parent:b") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        with_remote_origin("device-a", harness.spawn(config("parent:c")))
            .await
            .unwrap();
        assert!(!harness.backend.service_bridges.lock().contains_key(&first));
        assert_eq!(harness.backend.service_bridges.lock().len(), 1);
        harness.backend.close_tool_host(&pending);
        tokio::time::timeout(Duration::from_secs(4), async {
            while !harness.backend.service_bridges.lock().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        harness.backend.kill_all().await.unwrap();
    }
    #[tokio::test]
    async fn pending_registration_attaches_existing_prefix_adoptions_with_origin_checks() {
        let (harness, mut service) = setup(true).await;
        service.agent_id = "service-agent".into();
        let pending = harness
            .backend
            .register_tool_host(service.clone())
            .await
            .unwrap();
        assert_eq!(harness.backend.service_bridges.lock().len(), 1);
        assert!(harness.backend.renew_tool_host(&pending));
        service.agent_id = "service-agent".into();
        service.origin_device_id = Some("device-b".into());
        service.lease_id = "remote-tool-host:device-b:pending".into();
        let other = harness.backend.register_tool_host(service).await.unwrap();
        assert_eq!(harness.backend.service_bridges.lock().len(), 1);
        harness.backend.close_tool_host(&other);
        harness.backend.close_tool_host(&pending);
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn gateway_spawn_requires_host_authority_before_container_creation() {
        let environment = spec(EgressTier::Off, None);
        let harness = Harness::new(
            admitted(environment.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], vec![]),
            0,
        );
        assert_eq!(
            harness
                .spawn(gateway_config(&environment))
                .await
                .unwrap_err()
                .code,
            "sandbox_gateway_authority_missing"
        );
        assert!(harness.api.specs.lock().is_empty());
    }

    #[tokio::test]
    async fn gateway_spawns_bridge_both_lifecycles_and_revoke_with_the_task() {
        use cognia_external_agent::spawn_authority::{
            with_gateway, with_remote_origin, GatewayAuthority,
        };
        use std::sync::atomic::{AtomicBool, Ordering};
        for persistent in [false, true] {
            let mut environment = spec(EgressTier::Off, None);
            if persistent {
                environment.lifecycle = SandboxLifecycleKind::Persistent;
            }
            let harness = Harness::new(
                admitted(environment.clone(), IsolationTier::Container),
                report(vec![command("kiro-cli", None)], vec![]),
                0,
            );
            let active = Arc::new(AtomicBool::new(true));
            let check = active.clone();
            let authority = GatewayAuthority {
                port: 32123,
                device_id: Some("device-a".into()),
                task_id: "task".into(),
                authorized: Arc::new(move || check.load(Ordering::SeqCst)),
            };
            with_remote_origin(
                "device-a",
                with_gateway(Some(authority), harness.spawn(gateway_config(&environment))),
            )
            .await
            .unwrap();
            let execs = harness.api.runtime_execs.lock().clone();
            let bridge = execs
                .iter()
                .find(|e| e.command.get(1).is_some_and(|v| v == "bridge-service"))
                .unwrap();
            assert_eq!(bridge.command[2], "--gateway-nonce");
            assert_eq!(bridge.command[3].len(), 32);
            assert!(
                bridge.env.is_empty(),
                "helper never receives task credentials"
            );
            assert_eq!(harness.backend.service_bridges.lock().len(), 1);
            active.store(false, Ordering::SeqCst);
            tokio::time::timeout(Duration::from_secs(4), async {
                while !harness.backend.service_bridges.lock().is_empty() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            harness.backend.kill_all().await.unwrap();
        }
    }

    #[tokio::test]
    async fn local_gateway_authority_starts_both_sandbox_lifecycles_without_remote_identity() {
        use cognia_external_agent::spawn_authority::{with_gateway, GatewayAuthority};
        use std::sync::atomic::{AtomicBool, Ordering};
        for persistent in [false, true] {
            let mut environment = spec(EgressTier::Off, None);
            if persistent {
                environment.lifecycle = SandboxLifecycleKind::Persistent;
            }
            let harness = Harness::new(
                admitted(environment.clone(), IsolationTier::Container),
                report(vec![command("kiro-cli", None)], vec![]),
                0,
            );
            let live = Arc::new(AtomicBool::new(true));
            let active = live.clone();
            let authority = GatewayAuthority {
                port: 32123,
                device_id: None,
                task_id: "task".into(),
                authorized: Arc::new(move || active.load(Ordering::SeqCst)),
            };
            with_gateway(Some(authority), harness.spawn(gateway_config(&environment)))
                .await
                .unwrap();
            assert_eq!(harness.backend.service_bridges.lock().len(), 1);
            assert!(harness
                .backend
                .runners
                .service_scope("gateway-agent", None, "task")
                .is_ok());
            assert!(harness
                .backend
                .runners
                .service_scope("gateway-agent", Some("device-a"), "task")
                .is_err());
            live.store(false, Ordering::SeqCst);
            tokio::time::timeout(Duration::from_secs(4), async {
                while !harness.backend.service_bridges.lock().is_empty() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            harness.backend.kill_all().await.unwrap();
        }
    }

    #[tokio::test]
    async fn gateway_revocation_during_spawn_cleans_the_adopted_process() {
        use cognia_external_agent::spawn_authority::{
            with_gateway, with_remote_origin, GatewayAuthority,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        for persistent in [false, true] {
            let mut environment = spec(EgressTier::Off, None);
            if persistent {
                environment.lifecycle = SandboxLifecycleKind::Persistent;
            }
            let harness = Harness::new(
                admitted(environment.clone(), IsolationTier::Container),
                report(vec![command("kiro-cli", None)], vec![]),
                0,
            );
            let calls = AtomicUsize::new(0);
            let authority = GatewayAuthority {
                port: 32123,
                device_id: Some("device-a".into()),
                task_id: "task".into(),
                authorized: Arc::new(move || calls.fetch_add(1, Ordering::SeqCst) == 0),
            };
            assert!(with_remote_origin(
                "device-a",
                with_gateway(Some(authority), harness.spawn(gateway_config(&environment)))
            )
            .await
            .is_err());
            tokio::time::timeout(Duration::from_secs(2), async {
                while harness.backend.runners.contains("gateway-agent") {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(harness.backend.service_bridges.lock().is_empty());
        }
    }

    async fn setup(persistent: bool) -> (Harness, ToolHostService) {
        let mut environment = spec(EgressTier::Off, None);
        if persistent {
            environment.lifecycle = SandboxLifecycleKind::Persistent;
        }
        let harness = Harness::new(
            admitted(environment.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], vec![]),
            0,
        );
        cognia_external_agent::spawn_authority::with_remote_origin(
            "device-a",
            harness.spawn(spawn_config("service-agent", "kiro-cli", &[], &environment)),
        )
        .await
        .unwrap();
        let service = ToolHostService {
            agent_id: "service-agent".into(),
            owner_session_id: "chat-a".into(),
            origin_device_id: Some("device-a".into()),
            lease_id: "remote-tool-host:device-a:fixture".into(),
            generation: 1,
            port: 32123,
            authorization: Some(Arc::new(|| true)),
        };
        (harness, service)
    }

    #[tokio::test]
    async fn bridge_binds_origin_and_current_admission_and_supports_sibling_sessions() {
        for persistent in [false, true] {
            let (harness, service) = setup(persistent).await;
            let mut other = service.clone();
            other.origin_device_id = Some("device-b".into());
            other.lease_id = "remote-tool-host:device-b:fixture".into();
            assert!(harness.backend.open_tool_host(other).await.is_err());
            let bridge = harness
                .backend
                .open_tool_host(service.clone())
                .await
                .unwrap();
            assert_eq!(bridge.port, 34567);
            let mut other = service;
            other.owner_session_id = "chat-b".into();
            other.lease_id = "remote-tool-host:device-a:sibling".into();
            let sibling = harness.backend.open_tool_host(other).await.unwrap();
            harness.backend.close_tool_host(&sibling.bridge_id);
            assert!(harness.backend.renew_tool_host(&bridge.bridge_id));
            *harness.admission.outcome.lock() = Err(fault("revoked"));
            tokio::time::timeout(Duration::from_secs(4), async {
                while harness.backend.renew_tool_host(&bridge.bridge_id) {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            harness.backend.kill_all().await.unwrap();
        }
    }

    #[tokio::test]
    async fn transparent_upstream_preserves_binary_data_and_half_close() {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = server.local_addr().unwrap().port();
        let serving = tokio::spawn(async move {
            let (mut stream, _) = server.accept().await.unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            assert_eq!(bytes, b"request\0payload");
            stream.write_all(b"response\0bytes").await.unwrap();
            stream.shutdown().await.unwrap();
        });
        let (output, mut frames) = tokio::sync::mpsc::channel(8);
        let conn = connection(1, port, output);
        conn.input
            .send(Frame {
                kind: wire::DATA,
                id: 1,
                bytes: b"request\0payload".to_vec(),
            })
            .await
            .unwrap();
        conn.input
            .send(Frame {
                kind: wire::HALF_CLOSE,
                id: 1,
                bytes: vec![],
            })
            .await
            .unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), async {
            while let Some(frame) = frames.recv().await {
                if frame.kind == wire::DATA {
                    response.extend(frame.bytes);
                }
                if frame.kind == wire::CLOSE {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(response, b"response\0bytes");
        serving.await.unwrap();
    }

    #[tokio::test]
    async fn paired_device_revocation_closes_an_existing_bridge() {
        let (harness, mut service) = setup(false).await;
        let authorized = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flag = authorized.clone();
        service.authorization = Some(Arc::new(move || {
            flag.load(std::sync::atomic::Ordering::SeqCst)
        }));
        let bridge = harness.backend.open_tool_host(service).await.unwrap();
        authorized.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(!harness.backend.renew_tool_host(&bridge.bridge_id));
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn renewal_rejects_dead_adoption_before_background_tick_and_respawn_rebinds() {
        let (harness, service) = setup(false).await;
        let old_scope = harness
            .backend
            .runners
            .service_scope("service-agent", Some("device-a"), "chat-a")
            .unwrap();
        let previous = harness
            .backend
            .open_tool_host(service.clone())
            .await
            .unwrap();
        harness.backend.kill_all().await.unwrap();
        assert!(!harness.backend.renew_tool_host(&previous.bridge_id));
        assert!(harness
            .backend
            .open_tool_host(service.clone())
            .await
            .is_err());
        tokio::time::timeout(Duration::from_secs(2), async {
            while harness.backend.runners.contains("service-agent") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let environment = spec(EgressTier::Off, None);
        cognia_external_agent::spawn_authority::with_remote_origin(
            "device-a",
            harness.spawn(spawn_config("service-agent", "kiro-cli", &[], &environment)),
        )
        .await
        .unwrap();
        let kills = harness.api.kills.lock().len();
        harness
            .backend
            .runners
            .kill_service_scope(&old_scope)
            .await
            .unwrap();
        assert_eq!(
            harness.api.kills.lock().len(),
            kills,
            "stale startup cleanup must not kill the replacement"
        );
        let replacement = harness.backend.open_tool_host(service).await.unwrap();
        assert_ne!(replacement.bridge_id, previous.bridge_id);
        assert!(!harness.backend.renew_tool_host(&previous.bridge_id));
        assert!(harness.backend.renew_tool_host(&replacement.bridge_id));
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn abandoned_sidecar_bridge_cannot_renew_after_its_deadline() {
        let (harness, service) = setup(false).await;
        let bridge = harness.backend.open_tool_host(service).await.unwrap();
        tokio::time::advance(Duration::from_secs(61)).await;
        assert!(!harness.backend.renew_tool_host(&bridge.bridge_id));
        harness.backend.close_tool_host(&bridge.bridge_id);
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn replayed_connection_ids_close_the_entire_bridge() {
        let (harness, service) = setup(false).await;
        let bridge = harness.backend.open_tool_host(service).await.unwrap();
        let key = harness
            .api
            .handles
            .lock()
            .keys()
            .find(|key| key.starts_with("bridge:"))
            .unwrap()
            .clone();
        let events = harness.api.handle_events(&key);
        let mut frames = wire::encode(wire::OPEN, 1, &[]).unwrap();
        frames.extend(wire::encode(wire::OPEN, 1, &[]).unwrap());
        events.send(RunnerEvent::Stdout(frames)).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while harness.backend.renew_tool_host(&bridge.bridge_id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn closing_bridge_drops_private_exec_and_stale_agent_scope() {
        let (harness, service) = setup(false).await;
        let scope = harness
            .backend
            .runners
            .service_scope(&service.agent_id, Some("device-a"), "chat-a")
            .unwrap();
        let bridge = harness.backend.open_tool_host(service).await.unwrap();
        let key = harness
            .api
            .handles
            .lock()
            .keys()
            .find(|key| key.starts_with("bridge:"))
            .unwrap()
            .clone();
        let mut input = harness.api.take_stdin(&key);
        harness.backend.close_tool_host(&bridge.bridge_id);
        tokio::time::timeout(Duration::from_secs(2), async {
            while input.recv().await.is_some() {}
        })
        .await
        .unwrap();
        assert!(!harness.backend.renew_tool_host(&bridge.bridge_id));
        harness.backend.kill_all().await.unwrap();
        assert!(!harness.backend.runners.service_scope_active(&scope));
        tokio::time::timeout(Duration::from_secs(2), async {
            while harness.backend.runners.contains("service-agent") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let environment = spec(EgressTier::Off, None);
        cognia_external_agent::spawn_authority::with_remote_origin(
            "device-a",
            harness.spawn(spawn_config("service-agent", "kiro-cli", &[], &environment)),
        )
        .await
        .unwrap();
        assert!(
            !harness.backend.runners.service_scope_active(&scope),
            "A replacement agent must not revive its predecessor's bridge"
        );
        harness.backend.kill_all().await.unwrap();
    }
}
