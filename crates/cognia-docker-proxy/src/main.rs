//! `cognia-docker-proxy`: the always-on host's only door to the Docker daemon
//! (ADR-0224 A8). Configuration is in [`cognia_docker_proxy::config`].

use std::path::Path;

use cognia_docker_proxy::config::{Listen, ProxyConfig};
use cognia_docker_proxy::proxy::Proxy;
use tokio::net::{TcpListener, UnixListener};

/// Bind the Unix listener, replacing a socket a previous run left behind.
/// Anything else at the path is refused, never deleted: a misconfigured
/// `COGNIA_DOCKER_PROXY_LISTEN` must not remove the file it names.
fn bind_unix(path: &Path) -> Result<UnixListener, String> {
    use std::os::unix::fs::FileTypeExt;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_socket() => std::fs::remove_file(path)
            .map_err(|e| format!("cannot replace the stale socket {}: {e}", path.display()))?,
        Ok(_) => {
            return Err(format!(
                "{} exists and is not a socket; refusing to replace it",
                path.display()
            ))
        }
        Err(_) => {}
    }
    UnixListener::bind(path).map_err(|e| format!("cannot listen on {}: {e}", path.display()))
}

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
            let listener = bind_unix(&path)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_stale_socket_is_replaced_and_anything_else_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proxy.sock");
        // Fresh path.
        let first = bind_unix(&path).unwrap();
        drop(first);
        // The socket file the first listener left behind.
        assert!(path.exists());
        bind_unix(&path).expect("a stale socket is replaced");

        let file = dir.path().join("not-a-socket");
        std::fs::write(&file, b"keep me").unwrap();
        assert!(bind_unix(&file).unwrap_err().contains("not a socket"));
        assert_eq!(std::fs::read(&file).unwrap(), b"keep me");
    }
}
