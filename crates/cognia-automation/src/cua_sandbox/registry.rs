//! Registry of cua desktop sandboxes (ADR-0020 remote-target). Keyed by
//! sandbox connection id.
//!
//! The registry deliberately owns **only the live WebSocket clients**. Docker
//! itself owns container state, and `container_name_for_connection` derives a
//! stable name from the connection id, so every lifecycle operation can be
//! answered by asking Docker rather than by trusting an in-process map.
//!
//! That matters after an unclean exit. The previous design tracked containers
//! in a `HashMap` and always created a new one, so a container that outlived
//! the app left its deterministic name taken, and `docker run --name` failed
//! forever after. The connection was permanently unstartable. Every entry
//! point here now adopts an existing container before creating one.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use super::desktop_session::RemoteDesktop;
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::lifecycle::{
    attest_adopted, docker_create, docker_exec, docker_health, docker_inspect, docker_pause,
    docker_read_file, docker_remove, docker_run, docker_start, docker_stop, docker_unpause,
    resolve_port, ContainerPolicy, ContainerState, ExecOutcome, SpawnSpec,
};
use super::remote_client::CuaRemoteClient;
use crate::automation::types::{AutomationError, Result};

const MAX_DOCKER_CONTAINER_NAME_LEN: usize = 63;
const CONTAINER_NAME_PREFIX: &str = "cua-";

/// What a lifecycle call did, so the renderer can record the resulting state
/// without a second round-trip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxPlacement {
    pub container_id: String,
    /// Mapped host port for `computer-server`. Zero while the container is not
    /// running, because Docker publishes no port until then.
    pub port: u16,
}

#[derive(Default, Clone)]
pub struct CuaSandboxRegistry {
    /// Live driver connections only. Rebuildable at any time from Docker.
    clients: Arc<Mutex<HashMap<String, Arc<CuaRemoteClient>>>>,
    desktops: Arc<Mutex<HashMap<String, Arc<Mutex<RemoteDesktop>>>>>,
}

fn backend_err(msg: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: msg.into(),
    }
}

/// Docker can publish its port before Xvfb and the authenticated server are
/// ready. Only read-only readiness attempts are retried, under one deadline.
async fn connect_desktop_ready(
    host: &str,
    port: u16,
    token: &str,
    timeout: Duration,
) -> Result<Arc<CuaRemoteClient>> {
    tokio::time::timeout(timeout, async {
        loop {
            match CuaRemoteClient::connect(host, port, token).await {
                Ok(client) => match super::desktop_session::capture(&client).await {
                    Ok(_) => return Ok(client),
                    Err(error @ AutomationError::PermissionDenied { .. }) => return Err(error),
                    Err(_) => {},
                },
                Err(error @ AutomationError::PermissionDenied { .. }) => return Err(error),
                Err(_) => {},
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }).await.map_err(|_| backend_err(format!(
        "sandbox desktop was not ready within {} seconds; check the secured desktop server and display startup",
        timeout.as_secs()
    )))?
}

impl CuaSandboxRegistry {
    #[cfg(test)]
    pub(crate) async fn insert_test_client(&self, id: &str, client: Arc<CuaRemoteClient>) {
        self.clients.lock().await.insert(id.into(), client);
    }

    pub(crate) async fn desktop_guard(
        &self,
        connection_id: &str,
    ) -> OwnedMutexGuard<RemoteDesktop> {
        let desktop = self
            .desktops
            .lock()
            .await
            .entry(connection_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(RemoteDesktop::default())))
            .clone();
        desktop.lock_owned().await
    }

    pub(crate) async fn agent_guard(
        &self,
        connection_id: &str,
    ) -> Result<OwnedMutexGuard<RemoteDesktop>> {
        let mut guard = self.desktop_guard(connection_id).await;
        guard.require_agent()?;
        Ok(guard)
    }

    /// Provision the container without starting it. Adopts an existing
    /// container of the same name rather than failing on a name collision.
    pub async fn create(
        &self,
        connection_id: &str,
        image: &str,
        policy: ContainerPolicy,
    ) -> Result<SandboxPlacement> {
        let mut desktop = self.desktop_guard(connection_id).await;
        desktop.invalidate();
        self.clients.lock().await.remove(connection_id);
        let name = container_name_for_connection(connection_id);
        if let Some(state) = docker_inspect(&name).await? {
            if state.running {
                desktop.require_quiescent()?;
            } else {
                desktop.confirm_quiescence();
            }
            // The found container may predate the hardened profile. Adopting
            // it anyway would silently drop every bound the caller asked for.
            attest_adopted(&policy, &state)?;
            super::lifecycle::docker_attest_image(&name, image).await?;
            let port = if state.running {
                resolve_port(&name).await.unwrap_or(0)
            } else {
                0
            };
            return Ok(SandboxPlacement {
                container_id: state.id,
                port,
            });
        }
        desktop.confirm_quiescence(); // Docker confirmed the old container is absent.
        let container_id = docker_create(&SpawnSpec {
            image: image.to_string(),
            name,
            policy,
        })
        .await?;
        Ok(SandboxPlacement {
            container_id,
            port: 0,
        })
    }

    /// Bring the container to running and connect a driver client.
    ///
    /// Adopts whatever Docker already has: a paused container is unpaused, a
    /// stopped or merely created one is started, a running one is reused, and
    /// only a genuinely absent one is created.
    pub async fn start(
        &self,
        connection_id: &str,
        image: &str,
        policy: ContainerPolicy,
    ) -> Result<SandboxPlacement> {
        let mut desktop = self.desktop_guard(connection_id).await;
        desktop.invalidate();
        self.clients.lock().await.remove(connection_id);
        let name = container_name_for_connection(connection_id);
        let container_id = match docker_inspect(&name).await? {
            Some(state) => {
                if state.running {
                    desktop.require_quiescent()?;
                } else {
                    desktop.confirm_quiescence();
                }
                attest_adopted(&policy, &state)?;
                super::lifecycle::docker_attest_image(&name, image).await?;
                if state.paused {
                    docker_unpause(&name).await?;
                } else if !state.running {
                    docker_start(&name).await?;
                }
                state.id
            }
            None => {
                desktop.confirm_quiescence();
                docker_run(&SpawnSpec {
                    image: image.to_string(),
                    name: name.clone(),
                    policy,
                })
                .await?
            }
        };
        let state = docker_inspect(&name)
            .await?
            .ok_or_else(|| backend_err("sandbox disappeared during connection"))?;
        super::lifecycle::docker_probe_execution(&name, state.exec_user.as_deref()).await?;
        let port = resolve_port(&name).await?;
        let token = super::lifecycle::docker_auth_token(&name).await?;
        let client =
            connect_desktop_ready("127.0.0.1", port, &token, Duration::from_secs(60)).await?;
        self.clients
            .lock()
            .await
            .insert(connection_id.to_string(), client);
        Ok(SandboxPlacement { container_id, port })
    }

    /// Suspend the machine with `docker pause`, keeping memory resident so the
    /// desktop session survives. `docker stop` is not a suspend and is not used
    /// here. The driver client is dropped because its peer is frozen.
    pub async fn suspend(&self, connection_id: &str) -> Result<()> {
        let mut desktop = self.desktop_guard(connection_id).await;
        desktop.invalidate();
        self.clients.lock().await.remove(connection_id);
        let name = self.require_container(connection_id).await?;
        docker_pause(&name).await
    }

    pub async fn resume(&self, connection_id: &str) -> Result<SandboxPlacement> {
        let mut desktop = self.desktop_guard(connection_id).await;
        desktop.invalidate();
        self.clients.lock().await.remove(connection_id);
        let name = self.require_container(connection_id).await?;
        let state = docker_inspect(&name)
            .await?
            .ok_or_else(|| backend_err(format!("sandbox '{connection_id}' no longer exists")))?;
        if state.running {
            desktop.require_quiescent()?;
        } else {
            desktop.confirm_quiescence();
        }
        super::lifecycle::docker_attest_stored_image(&name).await?;
        if state.paused {
            docker_unpause(&name).await?;
        } else if !state.running {
            docker_start(&name).await?;
        }
        let state = docker_inspect(&name)
            .await?
            .ok_or_else(|| backend_err("sandbox disappeared during connection"))?;
        super::lifecycle::docker_probe_execution(&name, state.exec_user.as_deref()).await?;
        let port = resolve_port(&name).await?;
        let token = super::lifecycle::docker_auth_token(&name).await?;
        let client =
            connect_desktop_ready("127.0.0.1", port, &token, Duration::from_secs(60)).await?;
        self.clients
            .lock()
            .await
            .insert(connection_id.to_string(), client);
        Ok(SandboxPlacement {
            container_id: state.id,
            port,
        })
    }

    /// Stop the container. It keeps existing, along with everything written
    /// inside it. Use `delete` to destroy it.
    pub async fn stop(&self, connection_id: &str) -> Result<()> {
        let mut desktop = self.desktop_guard(connection_id).await;
        desktop.invalidate();
        self.clients.lock().await.remove(connection_id);
        let name = container_name_for_connection(connection_id);
        // A container that is already gone is already stopped. Reporting that
        // as a failure would leave the user unable to settle the row.
        match docker_inspect(&name).await? {
            None => {
                desktop.confirm_quiescence();
                return Ok(());
            }
            Some(state) if state.paused => {
                // Docker cannot gracefully stop a frozen supervisor. Keep
                // admission locked while unfreezing only to terminate it.
                docker_unpause(&name).await?;
            }
            _ => {}
        }
        docker_stop(&name).await?;
        desktop.confirm_quiescence();
        Ok(())
    }

    /// Destroy the container and everything in it that is not on a bind mount.
    pub async fn delete(&self, connection_id: &str) -> Result<()> {
        let mut desktop = self.desktop_guard(connection_id).await;
        desktop.invalidate();
        self.clients.lock().await.remove(connection_id);
        let name = container_name_for_connection(connection_id);
        if docker_inspect(&name).await?.is_none() {
            desktop.confirm_quiescence();
            return Ok(());
        }
        docker_remove(&name).await?;
        desktop.confirm_quiescence();
        Ok(())
    }

    /// Docker's own view of the container, or `None` when it does not exist.
    pub async fn inspect(&self, connection_id: &str) -> Result<Option<ContainerState>> {
        docker_inspect(&container_name_for_connection(connection_id)).await
    }

    /// Both workspace execution and GUI capture must answer. Cold driver
    /// reconnect also validates the execution supervisor and image contract.
    pub async fn health(&self, connection_id: &str) -> bool {
        let desktop = self.desktop_guard(connection_id).await;
        if desktop.require_quiescent().is_err() {
            return false;
        }
        if !docker_health(&container_name_for_connection(connection_id)).await {
            return false;
        }
        match self.client(connection_id).await {
            Ok(client) => super::desktop_session::capture(&client).await.is_ok(),
            Err(_) => false,
        }
    }

    /// Run one command inside the machine. Commands run under the exec user
    /// recorded on the container at create time — the entrypoint's supervisord
    /// must boot as root, so the user bound lives on this channel, and the
    /// container's own label is what carries it across app restarts.
    pub async fn exec(
        &self,
        connection_id: &str,
        argv: &[String],
        cwd: Option<&str>,
        env: &BTreeMap<String, String>,
        stdin: Option<&str>,
        timeout: Duration,
    ) -> Result<ExecOutcome> {
        let mut desktop = self.agent_guard(connection_id).await?;
        desktop.sessions = crate::automation::session::UiSessionManager::default();
        let (name, state) = self.require_running(connection_id).await?;
        desktop
            .run_mutation(docker_exec(
                &name,
                argv,
                cwd,
                env,
                stdin,
                timeout,
                state.exec_user.as_deref(),
            ))
            .await
    }

    /// Read one file from inside the machine, under the same exec-user bound
    /// as `exec`.
    pub async fn read_file(
        &self,
        connection_id: &str,
        path: &str,
        max_bytes: usize,
    ) -> Result<String> {
        let desktop = self.desktop_guard(connection_id).await;
        desktop.require_quiescent()?;
        let (_, state) = self.require_running(connection_id).await?;
        docker_read_file(&state.id, path, max_bytes, state.exec_user.as_deref()).await
    }

    pub async fn upload_file(
        &self,
        connection_id: &str,
        expected_container_id: &str,
        token: &str,
        path: &str,
        data_base64: &str,
    ) -> Result<super::file_transfer::SandboxFileInfo> {
        use super::file_transfer;
        file_transfer::validate_path(path)?;
        file_transfer::validate_container_id(expected_container_id)?;
        let bytes = file_transfer::decode_bytes(data_base64)?;
        let size = bytes.len();
        let hash = file_transfer::sha256(&bytes);
        drop(bytes);
        let mut desktop = self.desktop_guard(connection_id).await;
        desktop.require_controller(token)?;
        let state = self
            .require_transfer_target(connection_id, expected_container_id)
            .await?;
        // Docker admission can outlive the lease; authorization must still be
        // current when the guest mutation is actually dispatched.
        desktop.require_controller(token)?;
        desktop.sessions = crate::automation::session::UiSessionManager::default();
        let reply = desktop
            .run_mutation(file_transfer::execute(
                &state.id,
                state.exec_user.as_deref(),
                path,
                Some(data_base64),
            ))
            .await?;
        // Known file errors are interpreted only after confirmed process cleanup.
        reply.upload(path, size, &hash)
    }

    pub async fn download_file(
        &self,
        connection_id: &str,
        expected_container_id: &str,
        path: &str,
    ) -> Result<super::file_transfer::SandboxFileDownload> {
        use super::file_transfer;
        file_transfer::validate_path(path)?;
        file_transfer::validate_container_id(expected_container_id)?;
        let desktop = self.desktop_guard(connection_id).await;
        desktop.require_quiescent()?;
        let state = self
            .require_transfer_target(connection_id, expected_container_id)
            .await?;
        file_transfer::execute(&state.id, state.exec_user.as_deref(), path, None)
            .await?
            .download(path)
    }

    async fn require_transfer_target(
        &self,
        connection_id: &str,
        expected_id: &str,
    ) -> Result<ContainerState> {
        let (_, state) = self.require_running(connection_id).await?;
        verify_transfer_identity(expected_id, &state.id)?;
        // Attest and execute by immutable ID, so even an out-of-band Docker
        // replacement between these calls cannot retarget this operation.
        super::lifecycle::docker_attest_stored_image(&state.id).await?;
        Ok(state)
    }

    /// Resolve the driver client, reconnecting when the cache is cold.
    ///
    /// The cache is always cold right after an app restart, and the container
    /// it belongs to may well still be running. Refusing on a cache miss would
    /// make a perfectly healthy machine look dead.
    pub async fn client(&self, connection_id: &str) -> Result<Arc<CuaRemoteClient>> {
        if let Some(client) = self.clients.lock().await.get(connection_id) {
            if !client.is_closed() {
                return Ok(client.clone());
            }
        }
        let (name, state) = self.require_running(connection_id).await?;
        super::lifecycle::docker_probe_execution(&name, state.exec_user.as_deref()).await?;
        let port = resolve_port(&name).await?;
        let token = super::lifecycle::docker_auth_token(&name).await?;
        let client =
            connect_desktop_ready("127.0.0.1", port, &token, Duration::from_secs(30)).await?;
        self.clients
            .lock()
            .await
            .insert(connection_id.to_string(), client.clone());
        Ok(client)
    }

    /// Drop every cached driver client at the application exit boundary.
    ///
    /// Containers are deliberately left running. A machine the user started is
    /// expected to still be there when the app comes back, and `start` adopts
    /// it rather than creating a second one.
    pub async fn disconnect_all(&self) {
        self.clients.lock().await.clear();
        let desktops: Vec<_> = self.desktops.lock().await.values().cloned().collect();
        for desktop in desktops {
            desktop.lock().await.invalidate();
        }
    }

    /// The container name for a connection that must already exist.
    async fn require_container(&self, connection_id: &str) -> Result<String> {
        let name = container_name_for_connection(connection_id);
        if docker_inspect(&name).await?.is_none() {
            return Err(backend_err(format!(
                "sandbox '{connection_id}' has no container yet"
            )));
        }
        Ok(name)
    }

    /// The container name and its inspected state for a connection that must
    /// be running right now. Callers need the state as well as the name: the
    /// exec-user bound is recorded on the container, not in this process.
    async fn require_running(&self, connection_id: &str) -> Result<(String, ContainerState)> {
        let name = container_name_for_connection(connection_id);
        match docker_inspect(&name).await? {
            Some(state) if state.paused => Err(backend_err(format!(
                "sandbox '{connection_id}' is suspended. Resume it first."
            ))),
            Some(state) if state.running => {
                super::lifecycle::docker_attest_stored_image(&name).await?;
                Ok((name, state))
            }
            Some(state) => Err(backend_err(format!(
                "sandbox '{connection_id}' is not running (docker reports '{}')",
                state.status
            ))),
            None => Err(backend_err(format!(
                "sandbox '{connection_id}' has no container"
            ))),
        }
    }
}

fn verify_transfer_identity(expected: &str, actual: &str) -> Result<()> {
    if expected != actual {
        return Err(backend_err(
            "sandbox container was replaced; refresh its placement before transferring files",
        ));
    }
    Ok(())
}

/// Derive the stable Docker container name for a connection id. Determinism is
/// what makes adoption possible: the same connection always maps to the same
/// container, across restarts and across app versions.
pub fn container_name_for_connection(connection_id: &str) -> String {
    let mut suffix = String::new();
    let mut last_separator = false;
    for ch in connection_id.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            suffix.push(ch.to_ascii_lowercase());
            last_separator = false;
        } else if !last_separator && !suffix.is_empty() {
            suffix.push('-');
            last_separator = true;
        }
    }
    let mut suffix = suffix.trim_matches('-').to_string();
    if suffix.is_empty() {
        suffix = "sandbox".to_string();
    }

    let max_suffix_len = MAX_DOCKER_CONTAINER_NAME_LEN - CONTAINER_NAME_PREFIX.len();
    if suffix.len() > max_suffix_len {
        let hash = stable_hash_suffix(connection_id);
        let keep = max_suffix_len - 9;
        suffix = suffix.chars().take(keep).collect::<String>();
        suffix = suffix.trim_matches('-').to_string();
        suffix.push('-');
        suffix.push_str(&hash);
    }

    format!("{CONTAINER_NAME_PREFIX}{suffix}")
}

fn stable_hash_suffix(value: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:08x}", hash as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfers_reject_a_replaced_container_identity() {
        assert!(verify_transfer_identity(&"a".repeat(64), &"b".repeat(64)).is_err());
        assert!(verify_transfer_identity(&"a".repeat(64), &"a".repeat(64)).is_ok());
    }

    #[tokio::test]
    async fn file_boundaries_reject_invalid_leases_and_quarantine_before_docker() {
        let registry = CuaSandboxRegistry::default();
        let id = "file-boundary-test";
        let expected = "a".repeat(64);
        let result = registry
            .upload_file(id, &expected, "wrong", "/home/cua/file", "AP8=")
            .await;
        assert!(result.unwrap_err().to_string().contains("control lease"));
        assert!(registry
            .upload_file(id, &expected, "wrong", "/home/cua/file", "!!!!")
            .await
            .unwrap_err()
            .to_string()
            .contains("base64"));
        let mut desktop = registry.desktop_guard(id).await;
        let failure: Result<()> = desktop
            .run_mutation(async { Err(backend_err("unconfirmed cleanup")) })
            .await;
        assert!(failure.is_err());
        drop(desktop);
        assert!(registry
            .download_file(id, &expected, "/home/cua/file")
            .await
            .unwrap_err()
            .to_string()
            .contains("cleanup is unconfirmed"));
        assert!(registry
            .read_file(id, "/home/cua/file", 100)
            .await
            .unwrap_err()
            .to_string()
            .contains("cleanup is unconfirmed"));
    }

    #[tokio::test]
    async fn existing_text_reads_and_binary_downloads_wait_for_the_desktop_lock() {
        let registry = CuaSandboxRegistry::default();
        let guard = registry.desktop_guard("locked-read").await;
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            registry.read_file("locked-read", "/file", 100)
        )
        .await
        .is_err());
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            registry.download_file("locked-read", &"a".repeat(64), "/file")
        )
        .await
        .is_err());
        drop(guard);
    }

    #[test]
    fn container_name_sanitizes_connection_id_for_docker() {
        assert_eq!(
            container_name_for_connection(" Team/Alpha\r\n../demo "),
            "cua-team-alpha-demo"
        );
    }

    #[test]
    fn container_name_uses_fallback_for_empty_sanitized_id() {
        assert_eq!(container_name_for_connection(" \r\n\t "), "cua-sandbox");
    }

    #[test]
    fn container_name_is_bounded_and_hashes_truncated_ids() {
        let first = format!("{}A", "a".repeat(100));
        let second = format!("{}B", "a".repeat(100));

        let first_name = container_name_for_connection(&first);
        let second_name = container_name_for_connection(&second);

        assert!(first_name.len() <= 63);
        assert!(second_name.len() <= 63);
        assert_ne!(first_name, second_name);
        assert!(first_name.starts_with("cua-"));
        assert!(second_name.starts_with("cua-"));
    }

    #[test]
    fn container_name_is_stable_across_calls() {
        // Adoption depends on this. If the name drifted, every restart would
        // orphan the previous container and create a second machine.
        let id = "3f2a1b0c-1111-2222-3333-444455556666";
        assert_eq!(
            container_name_for_connection(id),
            container_name_for_connection(id)
        );
    }
    #[tokio::test]
    async fn readiness_retries_starting_server_until_authenticated_capture_is_available() {
        use super::super::remote_client::{accept_test_client, TEST_AUTH_TOKEN};
        use base64::Engine as _;
        use futures_util::{SinkExt, StreamExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            // Port is published but startup has not installed the desktop app.
            let (starting, _) = listener.accept().await.unwrap();
            assert!(tokio_tungstenite::accept_hdr_async(
                starting,
                |_: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 _: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    Err(tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(503)
                        .body(None)
                        .unwrap())
                }
            )
            .await
            .is_err());
            tokio::time::sleep(Duration::from_millis(25)).await;
            let mut ws = accept_test_client(&listener).await;
            let request = ws.next().await.unwrap().unwrap();
            assert!(request.to_text().unwrap().contains("screenshot"));
            let mut png = std::io::Cursor::new(Vec::new());
            xcap::image::RgbaImage::new(10, 8)
                .write_to(&mut png, xcap::image::ImageFormat::Png)
                .unwrap();
            let bytes = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
            ws.send(tokio_tungstenite::tungstenite::Message::Text(
                serde_json::json!({"image_data":bytes}).to_string().into(),
            ))
            .await
            .unwrap();
        });
        let result =
            connect_desktop_ready("127.0.0.1", port, TEST_AUTH_TOKEN, Duration::from_secs(2)).await;
        assert!(result.is_ok());
        drop(result);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn readiness_deadline_bounds_an_unresponsive_handshake() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let started = std::time::Instant::now();
        let result = connect_desktop_ready(
            "127.0.0.1",
            listener.local_addr().unwrap().port(),
            super::super::remote_client::TEST_AUTH_TOKEN,
            Duration::from_millis(40),
        )
        .await;
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn readiness_never_retries_an_unauthenticated_desktop() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(socket).await.unwrap();
        });
        let result = connect_desktop_ready(
            "127.0.0.1",
            port,
            super::super::remote_client::TEST_AUTH_TOKEN,
            Duration::from_secs(5),
        )
        .await;
        assert!(matches!(
            result,
            Err(AutomationError::PermissionDenied { .. })
        ));
        server.await.unwrap();
    }
}
