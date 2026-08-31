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

use tokio::sync::Mutex;

use super::lifecycle::{
    docker_create, docker_exec, docker_health, docker_inspect, docker_pause, docker_read_file,
    docker_remove, docker_run, docker_start, docker_stop, docker_unpause, resolve_port,
    ContainerPolicy, ContainerState, ExecOutcome, SpawnSpec,
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
}

fn backend_err(msg: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: msg.into(),
    }
}

impl CuaSandboxRegistry {
    /// Provision the container without starting it. Adopts an existing
    /// container of the same name rather than failing on a name collision.
    pub async fn create(
        &self,
        connection_id: &str,
        image: &str,
        policy: ContainerPolicy,
    ) -> Result<SandboxPlacement> {
        let name = container_name_for_connection(connection_id);
        if let Some(state) = docker_inspect(&name).await? {
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
        let name = container_name_for_connection(connection_id);
        let container_id = match docker_inspect(&name).await? {
            Some(state) => {
                if state.paused {
                    docker_unpause(&name).await?;
                } else if !state.running {
                    docker_start(&name).await?;
                }
                state.id
            }
            None => {
                docker_run(&SpawnSpec {
                    image: image.to_string(),
                    name: name.clone(),
                    policy,
                })
                .await?
            }
        };
        let port = resolve_port(&name).await?;
        let client = CuaRemoteClient::connect("127.0.0.1", port).await?;
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
        let name = self.require_container(connection_id).await?;
        self.clients.lock().await.remove(connection_id);
        docker_pause(&name).await
    }

    pub async fn resume(&self, connection_id: &str) -> Result<SandboxPlacement> {
        let name = self.require_container(connection_id).await?;
        let state = docker_inspect(&name)
            .await?
            .ok_or_else(|| backend_err(format!("sandbox '{connection_id}' no longer exists")))?;
        if state.paused {
            docker_unpause(&name).await?;
        } else if !state.running {
            docker_start(&name).await?;
        }
        let port = resolve_port(&name).await?;
        let client = CuaRemoteClient::connect("127.0.0.1", port).await?;
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
        self.clients.lock().await.remove(connection_id);
        let name = container_name_for_connection(connection_id);
        // A container that is already gone is already stopped. Reporting that
        // as a failure would leave the user unable to settle the row.
        if docker_inspect(&name).await?.is_none() {
            return Ok(());
        }
        docker_stop(&name).await
    }

    /// Destroy the container and everything in it that is not on a bind mount.
    pub async fn delete(&self, connection_id: &str) -> Result<()> {
        self.clients.lock().await.remove(connection_id);
        let name = container_name_for_connection(connection_id);
        if docker_inspect(&name).await?.is_none() {
            return Ok(());
        }
        docker_remove(&name).await
    }

    /// Docker's own view of the container, or `None` when it does not exist.
    pub async fn inspect(&self, connection_id: &str) -> Result<Option<ContainerState>> {
        docker_inspect(&container_name_for_connection(connection_id)).await
    }

    /// Whether the machine answers. `docker exec true` proves more than
    /// `inspect` does: it proves the exec channel every workspace operation
    /// rides is actually usable, not merely that Docker thinks it is running.
    pub async fn health(&self, connection_id: &str) -> bool {
        docker_health(&container_name_for_connection(connection_id)).await
    }

    /// Run one command inside the machine.
    pub async fn exec(
        &self,
        connection_id: &str,
        argv: &[String],
        cwd: Option<&str>,
        env: &BTreeMap<String, String>,
        stdin: Option<&str>,
        timeout: Duration,
    ) -> Result<ExecOutcome> {
        let name = self.require_running(connection_id).await?;
        docker_exec(&name, argv, cwd, env, stdin, timeout).await
    }

    /// Read one file from inside the machine.
    pub async fn read_file(
        &self,
        connection_id: &str,
        path: &str,
        max_bytes: usize,
    ) -> Result<String> {
        let name = self.require_running(connection_id).await?;
        docker_read_file(&name, path, max_bytes).await
    }

    /// Resolve the driver client, reconnecting when the cache is cold.
    ///
    /// The cache is always cold right after an app restart, and the container
    /// it belongs to may well still be running. Refusing on a cache miss would
    /// make a perfectly healthy machine look dead.
    pub async fn client(&self, connection_id: &str) -> Result<Arc<CuaRemoteClient>> {
        if let Some(client) = self.clients.lock().await.get(connection_id) {
            return Ok(client.clone());
        }
        let name = self.require_running(connection_id).await?;
        let port = resolve_port(&name).await?;
        let client = CuaRemoteClient::connect("127.0.0.1", port).await?;
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

    /// The container name for a connection that must be running right now.
    async fn require_running(&self, connection_id: &str) -> Result<String> {
        let name = container_name_for_connection(connection_id);
        match docker_inspect(&name).await? {
            Some(state) if state.paused => Err(backend_err(format!(
                "sandbox '{connection_id}' is suspended. Resume it first."
            ))),
            Some(state) if state.running => Ok(name),
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
}
