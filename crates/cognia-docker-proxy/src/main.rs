//! `cognia-docker-proxy`: the always-on host's only door to the Docker daemon
//! (ADR-0224 A8). Configuration is in [`cognia_docker_proxy::config`].

use cognia_docker_proxy::config::{Listen, ProxyConfig};
use cognia_docker_proxy::proxy::Proxy;
use tokio::net::{TcpListener, UnixListener};

#[tokio::main]
async fn main() -> Result<(), String> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let config = ProxyConfig::from_lookup(|key| std::env::var(key).ok())?;
    let proxy = Proxy::new(config.policy.clone(), config.upstream.clone());
    tracing::info!(
        deployment = %config.policy.deployment_id,
        workspaces = %config.policy.workspaces_volume,
        upstream = %config.upstream.display(),
        "cognia-docker-proxy starting"
    );
    match config.listen {
        Listen::Tcp(addr) => {
            let listener = TcpListener::bind(addr)
                .await
                .map_err(|e| format!("cannot listen on {addr}: {e}"))?;
            tracing::info!(%addr, "listening");
            loop {
                let (stream, _) = listener
                    .accept()
                    .await
                    .map_err(|e| format!("accept failed: {e}"))?;
                let proxy = proxy.clone();
                tokio::spawn(async move {
                    if let Err(error) = proxy.serve_connection(stream).await {
                        tracing::debug!(%error, "client connection ended");
                    }
                });
            }
        }
        Listen::Unix(path) => {
            // A stale socket from a previous run blocks the bind.
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path)
                .map_err(|e| format!("cannot listen on {}: {e}", path.display()))?;
            tracing::info!(path = %path.display(), "listening");
            loop {
                let (stream, _) = listener
                    .accept()
                    .await
                    .map_err(|e| format!("accept failed: {e}"))?;
                let proxy = proxy.clone();
                tokio::spawn(async move {
                    if let Err(error) = proxy.serve_connection(stream).await {
                        tracing::debug!(%error, "client connection ended");
                    }
                });
            }
        }
    }
}
