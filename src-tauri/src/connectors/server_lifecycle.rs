//! Start/stop lifecycle for the connectors axum server.
//!
//! Mirrors `remote_control::server` — graceful shutdown via a tokio `watch`
//! channel. Binds to the caller-supplied `SocketAddr`; use port 0 for
//! OS-assigned ephemeral ports (handy in tests).

use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::watch;

use super::axum_app::build_router;
use super::state::ConnectorsState;

/// Live server handle returned by [`start_server`].
pub struct ServerHandle {
    pub bound_addr: SocketAddr,
    shutdown_tx: watch::Sender<bool>,
}

impl ServerHandle {
    /// Signal the server task to shut down gracefully.
    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
    }
}

/// Bind `bind_addr`, build the router, and spawn the server task.
///
/// Updates `state.inner.server_running` and `bound_addr` before returning so
/// `connectors_health` reflects the new state immediately.
pub async fn start_server(
    state: ConnectorsState,
    bind_addr: SocketAddr,
) -> Result<ServerHandle, String> {
    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("connectors bind failed: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?;

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let app = build_router(state.clone());

    {
        let mut inner = state.inner.lock();
        inner.server_running = true;
        inner.bound_addr = Some(bound.to_string());
    }

    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                loop {
                    if shutdown_rx.changed().await.is_err() {
                        break;
                    }
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
            })
            .await;
    });

    Ok(ServerHandle {
        bound_addr: bound,
        shutdown_tx,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[tokio::test]
    async fn server_starts_and_shuts_down_cleanly() {
        let state = ConnectorsState::new();
        let handle = start_server(
            state.clone(),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        )
        .await
        .unwrap();
        assert!(handle.bound_addr.port() > 0);
        assert!(state.inner.lock().server_running);
        handle.shutdown().await;
    }
}
