//! Process-scoped registry of running cua desktop sandboxes (ADR-0020
//! remote-target, Phase 1). Keyed by sandbox connection id. Owns the Docker
//! container handle and the live `CuaRemoteClient` for each running sandbox.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::lifecycle::{docker_health, docker_run, docker_stop, resolve_port, SpawnSpec};
use super::remote_client::CuaRemoteClient;
use crate::automation::types::{AutomationError, Result};

const MAX_DOCKER_CONTAINER_NAME_LEN: usize = 63;
const CONTAINER_NAME_PREFIX: &str = "cua-";

struct Entry {
    container_id: String,
    port: u16,
    client: Arc<CuaRemoteClient>,
}

#[derive(Default, Clone)]
pub struct CuaSandboxRegistry {
    inner: Arc<Mutex<HashMap<String, Entry>>>,
}

fn backend_err(msg: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: msg.into(),
    }
}

impl CuaSandboxRegistry {
    /// Start (idempotently) the container for `connection_id`, connect a
    /// client, and return the mapped host port. If a container is already
    /// tracked and still healthy, returns its existing port.
    pub async fn start(&self, connection_id: &str, image: &str) -> Result<u16> {
        let mut map = self.inner.lock().await;
        if let Some(entry) = map.get(connection_id) {
            if docker_health(&entry.container_id).await {
                return Ok(entry.port);
            }
            map.remove(connection_id);
        }
        let spec = SpawnSpec {
            image: image.to_string(),
            name: container_name_for_connection(connection_id),
        };
        let container_id = docker_run(&spec).await?;
        let port = resolve_port(&container_id).await?;
        let client = CuaRemoteClient::connect("127.0.0.1", port).await?;
        map.insert(
            connection_id.to_string(),
            Entry {
                container_id,
                port,
                client,
            },
        );
        Ok(port)
    }

    /// Resolve the live client for a running connection.
    pub async fn client(&self, connection_id: &str) -> Result<Arc<CuaRemoteClient>> {
        self.inner
            .lock()
            .await
            .get(connection_id)
            .map(|e| e.client.clone())
            .ok_or_else(|| backend_err(format!("sandbox '{connection_id}' is not running")))
    }

    pub async fn stop(&self, connection_id: &str) -> Result<()> {
        if let Some(entry) = self.inner.lock().await.remove(connection_id) {
            docker_stop(&entry.container_id).await?;
        }
        Ok(())
    }

    pub async fn health(&self, connection_id: &str) -> bool {
        let container_id = {
            let map = self.inner.lock().await;
            match map.get(connection_id) {
                Some(e) => e.container_id.clone(),
                None => return false,
            }
        };
        docker_health(&container_id).await
    }

    /// Stop every tracked container — called on app exit so we don't leak
    /// containers (they're `--rm`, but stop guarantees prompt teardown).
    pub async fn shutdown_all(&self) {
        let ids: Vec<String> = self.inner.lock().await.keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }
}

fn container_name_for_connection(connection_id: &str) -> String {
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
}
