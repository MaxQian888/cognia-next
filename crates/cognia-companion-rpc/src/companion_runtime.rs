//! The [`CompanionRuntime`] the RPC dispatch table serves (ADR-0196 P9).
//!
//! A companion server needs a runtime to answer two questions the core cannot:
//! which host an RPC arm runs on, and which routes it cannot name itself (the
//! IDE relay). Both answers live here, so the headless `cognia-server` builds
//! its state without the desktop app. The desktop passes its own host
//! resolver, which prefers the `AppHandle` and falls back to the headless
//! services, through [`with_host_resolver`]; everything else is shared.

use std::sync::Arc;

use axum::routing::any;
use axum::Router;
use cognia_companion::middleware::DeviceContext;
use cognia_companion::remote_execution::ExecutionPlane;
use cognia_companion::runtime::{CompanionRuntime, DispatchResult};
use cognia_companion::SharedState;
use serde_json::Value;

use crate::rpc_host::RpcHost;

/// Finds the host an RPC runs on for one companion state, or `None` when
/// there is none yet (the table then answers every arm with a 503).
pub type HostResolver = fn(&SharedState) -> Option<Arc<dyn RpcHost>>;

struct RpcRuntime {
    resolve: HostResolver,
}

#[async_trait::async_trait]
impl CompanionRuntime for RpcRuntime {
    fn execution_binding_root(&self, state: &SharedState) -> Option<std::path::PathBuf> {
        (self.resolve)(state)?.cognia_data_dir().ok()
    }

    async fn prune_execution_bindings(&self, state: &SharedState) -> Result<(), cognia_problem::Problem> {
        let Some(host) = (self.resolve)(state) else { return Ok(()); };
        let directory = host.cognia_data_dir().map_err(|_| cognia_problem::Problem::with_status(
            axum::http::StatusCode::SERVICE_UNAVAILABLE, "execution_binding_store_unavailable", "Host directory unavailable"))?;
        cognia_companion::host_surface_gate::prune_execution_records(directory, host.exec_backend()).await
    }

    fn can_dispatch(&self, state: &SharedState) -> bool {
        (self.resolve)(state).is_some()
    }

    async fn dispatch(
        &self,
        name: &str,
        args: Value,
        state: &SharedState,
        principal: &DeviceContext,
        plane: ExecutionPlane,
    ) -> DispatchResult {
        let host = (self.resolve)(state);
        crate::rpc::dispatch_canonical(name, args, state, principal, plane, host.as_deref()).await
    }

    fn ide_relay_routes(&self) -> Router<SharedState> {
        ide_relay_routes()
    }
}

/// A runtime whose arms run on the host `resolve` finds.
pub fn with_host_resolver(resolve: HostResolver) -> Arc<dyn CompanionRuntime> {
    Arc::new(RpcRuntime { resolve })
}

/// The runtime of a server with no desktop: arms run on the installed
/// headless services.
pub fn headless() -> Arc<dyn CompanionRuntime> {
    with_host_resolver(headless_host)
}

/// The installed headless services, as the host the table dispatches to.
pub fn headless_host(_state: &SharedState) -> Option<Arc<dyn RpcHost>> {
    crate::headless::headless_services().map(|services| services.to_shared())
}

/// The IDE relay a paired client reaches a code-server through
/// (`cognia_codeserver::remote`), the same on every host.
pub fn ide_relay_routes() -> Router<SharedState> {
    use cognia_codeserver::remote::{relay_handler, relay_root_handler};
    Router::new()
        .route("/ide/relay/{relay_id}", any(relay_root_handler))
        .route("/ide/relay/{relay_id}/", any(relay_root_handler))
        .route("/ide/relay/{relay_id}/{*tail}", any(relay_handler))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_runtime_mounts_the_ide_relay() {
        use tower::ServiceExt as _;
        let router: Router = headless().ide_relay_routes().with_state(unit_state());
        for path in [
            "/ide/relay/opaque",
            "/ide/relay/opaque/",
            "/ide/relay/opaque/a/b",
        ] {
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(path)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_ne!(
                response.status(),
                axum::http::StatusCode::NOT_FOUND,
                "{path} is not routed"
            );
        }
    }

    /// `remote_execution` and the WebRTC dispatcher ask the runtime whether
    /// there is a host; the headless runtime has one exactly while the
    /// headless services are installed, or a server would refuse every RPC.
    #[tokio::test]
    async fn the_headless_runtime_can_dispatch_exactly_while_services_are_installed() {
        let _slot = cognia_companion::ws_bridge::test_support::lock_slot().await;
        let state = unit_state();

        crate::headless::install_headless_services(None);
        assert!(!state.runtime.can_dispatch(&state));
        assert!(state.runtime.execution_binding_root(&state).is_none());
        assert!(headless_host(&state).is_none());

        crate::headless::install_headless_services(Some(
            crate::headless::HeadlessServices::stub_for_tests(),
        ));
        let with_host = state.runtime.can_dispatch(&state);
        let kind = headless_host(&state).map(|host| host.kind());
        let binding_root = state.runtime.execution_binding_root(&state);
        state.runtime.prune_execution_bindings(&state).await.unwrap();
        crate::headless::install_headless_services(None);
        assert!(with_host);
        assert_eq!(kind, Some("headless"));
        assert!(binding_root.is_some());
    }

    /// A state with no host answers an RPC from the table, not from the core:
    /// the 503 the table gives every arm when it has nowhere to run it.
    #[tokio::test]
    async fn a_dispatch_without_a_host_is_a_503_from_the_table() {
        let _slot = cognia_companion::ws_bridge::test_support::lock_slot().await;
        crate::headless::install_headless_services(None);
        let state = unit_state();
        let principal = DeviceContext {
            device_id: "device-1".to_string(),
            tenant_id: "local_acct_a".to_string(),
            scope: "owner".to_string(),
            granted_scopes: Vec::new(),
            authorization_capabilities: None,
        };
        let result = state
            .runtime
            .dispatch(
                "background_job_list",
                serde_json::json!({}),
                &state,
                &principal,
                ExecutionPlane::Network,
            )
            .await;
        assert_eq!(
            result.expect_err("no host").0,
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
    }

    fn unit_state() -> SharedState {
        use cognia_companion::*;
        Arc::new(CompanionState {
            secret: parking_lot::RwLock::new(vec![0u8; 32]),
            deny_list: Arc::new(deny_list::DenyList::new()),
            renderer: None,
            runtime: headless(),
            idempotency: Arc::new(idempotency::IdempotencyCache::new()),
            event_bus: event_bus::EventBus::new(),
            sync_bridge: sync_bridge::SyncBridge::new(),
            desktop_messages_bridge: desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge: desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: rate_limit::RateLimiter::with_defaults(),
            push_tokens: push::PushTokenRegistry::new(),
        })
    }
}
