//! Start/stop lifecycle for the connectors axum server.
//!
//! Mirrors `remote_control::server` — graceful shutdown via a tokio `watch`
//! channel. Binds to the caller-supplied `SocketAddr`; use port 0 for
//! OS-assigned ephemeral ports (handy in tests).

use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::watch;

use super::axum_app::{build_router, EventEmitter};
use super::state::ConnectorsState;

/// Live server handle returned by [`start_server`].
pub struct ServerHandle {
    pub bound_addr: SocketAddr,
    shutdown_tx: watch::Sender<bool>,
    serve_task: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    /// Signal the server task to shut down gracefully and wait (bounded) for
    /// it to finish, so the listener socket is actually released before this
    /// returns — an immediate restart on the same port would otherwise race
    /// the old task into EADDRINUSE.
    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        // Bounded wait: a wedged in-flight connection must not hang shutdown
        // forever.
        if tokio::time::timeout(std::time::Duration::from_secs(3), self.serve_task)
            .await
            .is_err()
        {
            log::warn!("connectors server task did not stop within 3s of shutdown signal");
        }
    }
}

/// Bind `bind_addr`, build the router, and spawn the server task.
///
/// `emitter` is the sink for verified webhook events. Production callers pass
/// an `AppHandleEmitter`; tests can pass a recording mock. Updates
/// `state.inner.server_running` and `bound_addr` before returning so
/// `connectors_health` reflects the new state immediately.
pub async fn start_server(
    state: ConnectorsState,
    bind_addr: SocketAddr,
    emitter: Arc<dyn EventEmitter>,
) -> Result<ServerHandle, String> {
    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("connectors bind failed: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?;

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let app = build_router(state.clone(), emitter);

    {
        let mut inner = state.inner.lock();
        inner.server_running = true;
        inner.bound_addr = Some(bound.to_string());
    }

    let serve_task = tokio::spawn(async move {
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
        serve_task,
    })
}

/// Idempotent bind: start the server only if `slot` is empty, and return the
/// bound address either way.
///
/// The remote-document OAuth flow (ADR-0134) needs a *guarantee* that the
/// loopback listener exists for the duration of a consent round-trip, and it
/// cannot know whether a webhook adapter already started one. `start_server`
/// alone cannot express that: the command wrapping it treats "already running"
/// as a lifecycle bug and errors. So the caller asks for the address and never
/// learns which of the two happened.
///
/// The slot lock is held across the bind, so two concurrent callers cannot
/// both start a server.
pub async fn ensure_server(
    slot: &tokio::sync::Mutex<Option<ServerHandle>>,
    state: ConnectorsState,
    bind_addr: SocketAddr,
    emitter: Arc<dyn EventEmitter>,
) -> Result<SocketAddr, String> {
    let mut guard = slot.lock().await;
    if let Some(handle) = guard.as_ref() {
        return Ok(handle.bound_addr);
    }
    let handle = start_server(state, bind_addr, emitter).await?;
    let bound = handle.bound_addr;
    *guard = Some(handle);
    Ok(bound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    struct NullEmitter;

    #[tokio::test]
    async fn ensure_server_binds_once_and_reports_the_same_address() {
        let state = ConnectorsState::new();
        let slot = tokio::sync::Mutex::new(None);
        let addr = SocketAddr::from(([127, 0, 0, 1], 0));

        let first = ensure_server(&slot, state.clone(), addr, Arc::new(NullEmitter))
            .await
            .unwrap();
        let second = ensure_server(&slot, state.clone(), addr, Arc::new(NullEmitter))
            .await
            .unwrap();

        assert_eq!(first, second, "a second ensure must not rebind");
        assert_ne!(first.port(), 0);
        assert!(state.inner.lock().server_running);

        let handle = slot.lock().await.take();
        if let Some(handle) = handle {
            handle.shutdown().await;
        }
    }

    #[tokio::test]
    async fn ensure_server_surfaces_a_bind_failure_and_leaves_the_slot_empty() {
        let state = ConnectorsState::new();
        let occupied = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let taken = occupied.local_addr().unwrap();
        let slot = tokio::sync::Mutex::new(None);

        let err = ensure_server(&slot, state, taken, Arc::new(NullEmitter))
            .await
            .unwrap_err();

        assert!(err.contains("connectors bind failed"), "unexpected error: {err}");
        let still_empty = slot.lock().await.is_none();
        assert!(still_empty, "a failed bind must not leave a handle behind");
        drop(occupied);
    }

    impl EventEmitter for NullEmitter {
        fn emit(&self, _topic: &str, _payload: serde_json::Value) {}
    }

    #[tokio::test]
    async fn server_starts_and_shuts_down_cleanly() {
        let state = ConnectorsState::new();
        let handle = start_server(
            state.clone(),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            Arc::new(NullEmitter),
        )
        .await
        .unwrap();
        assert!(handle.bound_addr.port() > 0);
        assert!(state.inner.lock().server_running);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_releases_the_port_for_immediate_rebind() {
        let state = ConnectorsState::new();
        let handle = start_server(
            state.clone(),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            Arc::new(NullEmitter),
        )
        .await
        .unwrap();
        let addr = handle.bound_addr;

        // shutdown() awaits the serve task, so by the time it returns the
        // listener socket must be closed and the exact port rebindable.
        handle.shutdown().await;
        let rebind = TcpListener::bind(addr).await;
        assert!(rebind.is_ok(), "rebind after shutdown failed: {rebind:?}");
    }
}
