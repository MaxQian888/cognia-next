//! The app's side of [`CompanionRuntime`] (ADR-0196 P5.4).
//!
//! The one file of `companion_api` that names app modules on the core's
//! behalf: the desktop (`commands::build_state`), `cognia-server` and the
//! `cognia-webrtc-peer` harness all build their [`CompanionState`] with
//! [`runtime`], and the source test below keeps it that way. When the core
//! leaves the app (P7) this file stays behind with the `companion_api`
//! facade.
//!
//! [`CompanionState`]: super::CompanionState

use std::sync::Arc;

use axum::routing::any;
use axum::Router;

use serde_json::Value;

use super::middleware::DeviceContext;
use super::remote_execution::ExecutionPlane;
use super::runtime::{CompanionRuntime, DispatchResult};
use super::SharedState;

/// The app's routes and hooks for a companion server.
struct AppCompanionRuntime;

#[async_trait::async_trait]
impl CompanionRuntime for AppCompanionRuntime {
    fn can_dispatch(&self, state: &SharedState) -> bool {
        super::dispatch_host::DispatchHost::from_state(state).is_some()
    }

    async fn dispatch(
        &self,
        name: &str,
        args: Value,
        state: &SharedState,
        principal: &DeviceContext,
        plane: ExecutionPlane,
    ) -> DispatchResult {
        super::rpc::dispatch_canonical(name, args, state, principal, plane).await
    }

    fn ide_relay_routes(&self) -> Router<SharedState> {
        Router::new()
            .route(
                "/ide/relay/{relay_id}",
                any(crate::codeserver::remote::relay_root_handler),
            )
            .route(
                "/ide/relay/{relay_id}/",
                any(crate::codeserver::remote::relay_root_handler),
            )
            .route(
                "/ide/relay/{relay_id}/{*tail}",
                any(crate::codeserver::remote::relay_handler),
            )
    }
}

/// The runtime every production companion state carries.
pub fn runtime() -> Arc<dyn CompanionRuntime> {
    Arc::new(AppCompanionRuntime)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A production state built without the app runtime would still compile
    /// against [`super::super::runtime::unwired`] if someone reached for it,
    /// and silently lose the IDE relay. Pin each production constructor to
    /// [`runtime`].
    #[test]
    fn every_production_state_carries_the_app_runtime() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for (file, needle) in [
            (
                "companion_api/commands.rs",
                "runtime: super::wiring::runtime(),",
            ),
            (
                "bin/cognia-server.rs",
                "runtime: app_lib::companion_api::wiring::runtime(),",
            ),
            (
                "bin/cognia-webrtc-peer.rs",
                "runtime: app_lib::companion_api::wiring::runtime(),",
            ),
        ] {
            let source = std::fs::read_to_string(root.join(file)).expect(file);
            assert!(
                source.contains(needle),
                "{file} must build its state with wiring::runtime()"
            );
            assert!(
                !source
                    .split("#[cfg(test)]")
                    .next()
                    .unwrap_or_default()
                    .contains("runtime::unwired()"),
                "{file} must not take the unit-test runtime outside its tests"
            );
        }
    }

    #[tokio::test]
    async fn the_app_runtime_mounts_the_ide_relay() {
        use tower::ServiceExt as _;
        let router: Router = runtime().ide_relay_routes().with_state(unit_state());
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
    /// there is a host; the app runtime must answer the way the dispatch
    /// table resolves one, or a headless server would refuse every RPC.
    #[tokio::test]
    async fn the_app_runtime_can_dispatch_exactly_when_the_table_has_a_host() {
        let _slot = super::super::ws_bridge::test_support::lock_slot().await;
        let state = unit_state();

        crate::headless::install_headless_services(None);
        assert!(!state.runtime.can_dispatch(&state));
        assert!(super::super::dispatch_host::DispatchHost::from_state(&state).is_none());

        crate::headless::install_headless_services(Some(
            crate::headless::HeadlessServices::stub_for_tests(),
        ));
        let with_host = state.runtime.can_dispatch(&state);
        let table_has_host =
            super::super::dispatch_host::DispatchHost::from_state(&state).is_some();
        crate::headless::install_headless_services(None);
        assert!(with_host);
        assert!(table_has_host);
    }

    fn unit_state() -> SharedState {
        use super::super::*;
        Arc::new(CompanionState {
            secret: RwLock::new(vec![0u8; 32]),
            deny_list: Arc::new(DenyList::new()),
            renderer: None,
            runtime: runtime(),
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: sync_bridge::SyncBridge::new(),
            desktop_messages_bridge: desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge: desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: rate_limit::RateLimiter::with_defaults(),
            push_tokens: push::PushTokenRegistry::new(),
        })
    }
}
