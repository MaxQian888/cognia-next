use super::*;
use crate::runtime::{RuntimePort, SandboxRuntimeControl};
use cognia_external_agent::container_backend::{is_owned, RunnerExecSpec};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn unavailable(message: impl Into<String>) -> SandboxSpawnError {
    SandboxSpawnError::refused("sandbox_port_unavailable", message.into())
}

async fn wait_for_idle(
    mut activity: tokio::sync::watch::Receiver<tokio::time::Instant>,
    timeout: Duration,
) {
    loop {
        let deadline = *activity.borrow_and_update() + timeout;
        match tokio::time::timeout_at(deadline, activity.changed()).await {
            Ok(Ok(())) => {}
            _ => break,
        }
    }
}

impl DockerSandboxBackend {
    async fn port_spec(
        &self,
        project_id: &str,
        container_id: &str,
    ) -> Result<Option<EnvironmentSpec>, SandboxSpawnError> {
        let Some(state) = self
            .api
            .inspect_runtime(container_id)
            .await
            .map_err(unavailable)?
        else {
            return Ok(None);
        };
        if !state.running
            || !is_owned(&state.labels)
            || state.labels.get(DEPLOYMENT_LABEL).map(String::as_str)
                != Some(self.config.deployment_id.as_str())
            || state.labels.get("cognia.project-id").map(String::as_str) != Some(project_id)
        {
            return Ok(None);
        }
        let Some(digest) = state.labels.get("cognia.spec-digest") else {
            return Ok(None);
        };
        let Some(body) = self.admission.stored_spec(digest) else {
            return Ok(None);
        };
        let admitted = self
            .admission
            .recheck(&body, &self.available_tiers().await?)?;
        if admitted.spec.project_id != project_id || &admitted.spec.spec_digest != digest {
            return Ok(None);
        }
        Ok(Some(admitted.spec))
    }
}

#[async_trait]
impl SandboxRuntimeControl for DockerSandboxBackend {
    async fn list_ports(&self, project_id: &str) -> Result<Vec<RuntimePort>, SandboxSpawnError> {
        let mut ports = Vec::new();
        for container in self.api.list_owned().await.map_err(unavailable)? {
            if container
                .labels
                .get("cognia.project-id")
                .map(String::as_str)
                != Some(project_id)
            {
                continue;
            }
            let Some(spec) = self.port_spec(project_id, &container.id).await? else {
                continue;
            };
            for port in spec.forward_ports {
                ports.push(RuntimePort {
                    path: format!(
                        "/api/environment/ports/{}/{}/{}/",
                        url::form_urlencoded::byte_serialize(project_id.as_bytes())
                            .collect::<String>()
                            .replace('+', "%20"),
                        container.id,
                        port.port
                    ),
                    container_id: container.id.clone(),
                    project_id: project_id.into(),
                    port: port.port,
                    label: port.label,
                });
            }
        }
        ports.sort_by(|a, b| (&a.container_id, a.port).cmp(&(&b.container_id, b.port)));
        Ok(ports)
    }

    async fn port_allowed(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<bool, SandboxSpawnError> {
        Ok(port != 0
            && self
                .port_spec(project_id, container_id)
                .await?
                .is_some_and(|spec| spec.forward_ports.iter().any(|entry| entry.port == port)))
    }

    async fn open_port(
        &self,
        project_id: &str,
        container_id: &str,
        port: u16,
    ) -> Result<tokio::io::DuplexStream, SandboxSpawnError> {
        let permit = self
            .port_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| unavailable("too many active port connections"))?;
        let spec = self
            .port_spec(project_id, container_id)
            .await?
            .filter(|spec| spec.forward_ports.iter().any(|entry| entry.port == port))
            .ok_or_else(|| unavailable("port is not declared by an active approved runtime"))?;
        let mut command = vec![
            format!("{INJECTION_ROOT}/bin/cognia-sandboxd"),
            "connect-port".into(),
            "--port".into(),
            port.to_string(),
        ];
        if spec.lifecycle == SandboxLifecycleKind::Ephemeral {
            command.push("--direct".into());
        }
        let mut running = self
            .api
            .exec_runtime(RunnerExecSpec {
                container_id: container_id.into(),
                command,
                env: Vec::new(),
                working_dir: WORKSPACE_TARGET.into(),
            })
            .await
            .map_err(unavailable)?;
        let (client, server) = tokio::io::duplex(64 * 1024);
        let backend = self
            .own
            .upgrade()
            .expect("driver retained through port acquisition");
        let project_id = project_id.to_string();
        let container_id = container_id.to_string();
        tokio::spawn(async move {
            let _permit = permit;
            let (mut input, mut output) = tokio::io::split(server);
            let stdin = running.stdin;
            let (activity, last_activity) =
                tokio::sync::watch::channel(tokio::time::Instant::now());
            let inbound_activity = activity.clone();
            let inbound = async move {
                let mut buffer = [0u8; 32 * 1024];
                loop {
                    let len = input.read(&mut buffer).await.map_err(|_| ())?;
                    if len == 0 {
                        drop(stdin);
                        return Ok::<_, ()>(());
                    }
                    stdin.send(buffer[..len].to_vec()).await.map_err(|_| ())?;
                    inbound_activity.send_replace(tokio::time::Instant::now());
                }
            };
            let outbound = async {
                while let Some(event) = running.events.recv().await {
                    match event {
                        RunnerEvent::Stdout(bytes) => {
                            output.write_all(&bytes).await.map_err(|_| ())?;
                            if !bytes.is_empty() {
                                activity.send_replace(tokio::time::Instant::now());
                            }
                        }
                        RunnerEvent::Stderr(_) => {}
                        RunnerEvent::Exited { .. } => break,
                    }
                }
                output.shutdown().await.map_err(|_| ())
            };
            let revoked = async {
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if !backend
                        .port_allowed(&project_id, &container_id, port)
                        .await
                        .unwrap_or(false)
                    {
                        break;
                    }
                }
            };
            // Any error or revocation drops both exec streams and its socket.
            // Inactivity bounds abandoned half-closed connections without
            // terminating active SSE or WebSocket streams after a fixed age.
            tokio::select! {
                _ = async { let _ = tokio::try_join!(inbound, outbound); } => {},
                _ = revoked => {},
                _ = wait_for_idle(last_activity, Duration::from_secs(3600)) => {},
            }
        });
        Ok(client)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::tests::{admitted, command, report, spawn_config, spec, Harness};

    #[tokio::test(start_paused = true)]
    async fn active_streams_extend_the_idle_deadline() {
        let (activity, receiver) = tokio::sync::watch::channel(tokio::time::Instant::now());
        let monitor = tokio::spawn(wait_for_idle(receiver, Duration::from_secs(3600)));
        for _ in 0..3 {
            tokio::time::advance(Duration::from_secs(3500)).await;
            activity.send_replace(tokio::time::Instant::now());
            tokio::task::yield_now().await;
            assert!(!monitor.is_finished());
        }
        tokio::time::advance(Duration::from_secs(3601)).await;
        tokio::task::yield_now().await;
        assert!(monitor.is_finished());
        monitor.await.unwrap();
    }

    async fn port_runtime() -> (Harness, String) {
        let mut spec = spec(EgressTier::Off, None);
        spec.forward_ports
            .push(cognia_environment::spec::ForwardPort {
                port: 3000,
                label: Some("App".into()),
            });
        let harness = Harness::new(
            admitted(spec.clone(), IsolationTier::Container),
            report(vec![command("kiro-cli", None)], Vec::new()),
            0,
        );
        harness
            .spawn(spawn_config("ports", "kiro-cli", &[], &spec))
            .await
            .unwrap();
        let id = harness.backend.get_info("ports").await.unwrap()["containerId"]
            .as_str()
            .unwrap()
            .to_string();
        (harness, id)
    }

    #[tokio::test]
    async fn port_authority_requires_project_deployment_live_runtime_and_approved_port() {
        let (harness, id) = port_runtime().await;
        let ports = harness.backend.list_ports("proj-1").await.unwrap();
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].port, 3000);
        assert_eq!(ports[0].label.as_deref(), Some("App"));
        assert!(!harness
            .backend
            .port_allowed("another-project", &id, 3000)
            .await
            .unwrap());
        assert!(!harness
            .backend
            .port_allowed("proj-1", &id, 3001)
            .await
            .unwrap());
        assert!(harness
            .backend
            .open_port("proj-1", &id, 3001)
            .await
            .is_err());
        assert!(harness.api.runtime_execs.lock().is_empty());
        harness
            .api
            .labels_by_container
            .lock()
            .get_mut(&id)
            .unwrap()
            .insert(DEPLOYMENT_LABEL.into(), "other-deployment".into());
        assert!(!harness
            .backend
            .port_allowed("proj-1", &id, 3000)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn binary_port_tunnel_preserves_backpressure_data_and_half_close() {
        let (harness, id) = port_runtime().await;
        let stream = harness
            .backend
            .open_port("proj-1", &id, 3000)
            .await
            .unwrap();
        let (mut read, mut write) = tokio::io::split(stream);
        let expected: Vec<u8> = (0..300_000).map(|n| (n % 256) as u8).collect();
        let bytes = expected.clone();
        let send = async move {
            write.write_all(&bytes).await.unwrap();
            write.shutdown().await.unwrap();
        };
        let receive = async {
            let mut bytes = Vec::new();
            read.read_to_end(&mut bytes).await.unwrap();
            bytes
        };
        let (_, actual) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(send, receive)
        })
        .await
        .unwrap();
        assert_eq!(actual, expected);
        harness.backend.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn revoking_admission_closes_existing_port_stream() {
        let (harness, id) = port_runtime().await;
        let mut stream = harness
            .backend
            .open_port("proj-1", &id, 3000)
            .await
            .unwrap();
        *harness.admission.outcome.lock() = Err(unavailable("approval revoked"));
        assert!(!harness
            .backend
            .port_allowed("proj-1", &id, 3000)
            .await
            .unwrap_or(false));
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(4), stream.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        harness.backend.kill_all().await.unwrap();
    }

    #[test]
    fn route_project_segment_cannot_escape_its_path() {
        let encoded =
            url::form_urlencoded::byte_serialize(b"project/other?x=1").collect::<String>();
        assert!(!encoded.contains('/'));
        assert!(!encoded.contains('?'));
    }
}
