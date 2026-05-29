//! Process-scoped registry of running cua desktop sandboxes (ADR-0020
//! remote-target, Phase 1). Keyed by sandbox connection id. Owns the Docker
//! container handle and the live `CuaRemoteClient` for each running sandbox.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::automation::types::{AutomationError, Result};
use super::lifecycle::{docker_health, docker_run, docker_stop, resolve_port, SpawnSpec};
use super::remote_client::CuaRemoteClient;

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
    AutomationError::BackendError { message: msg.into() }
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
        let spec = SpawnSpec { image: image.to_string(), name: format!("cua-{connection_id}") };
        let container_id = docker_run(&spec).await?;
        let port = resolve_port(&container_id).await?;
        let client = CuaRemoteClient::connect("127.0.0.1", port).await?;
        map.insert(connection_id.to_string(), Entry { container_id, port, client });
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
