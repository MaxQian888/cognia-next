//! The app's side of [`CompanionRuntime`] (ADR-0196 P5.4).
//!
//! The desktop (`commands::build_state`) and the `cognia-webrtc-peer`
//! harness build their [`CompanionState`] with [`runtime`], which resolves an
//! RPC's host through [`DispatchHost`]; the headless `cognia-server` builds
//! its own with `cognia_companion_rpc::companion_runtime::headless()`. The
//! source test below keeps each production constructor on its runtime.
//!
//! [`CompanionState`]: super::CompanionState

use std::sync::Arc;

use super::dispatch_host::{DispatchHost, RpcHost};
use super::runtime::CompanionRuntime;
use super::SharedState;

/// The desktop's host for one companion state: the `AppHandle` when the
/// state has a WebView renderer, the headless services otherwise.
fn desktop_host(state: &SharedState) -> Option<Arc<dyn RpcHost>> {
    DispatchHost::from_state(state).map(|host| Arc::new(host) as Arc<dyn RpcHost>)
}

/// The runtime every production companion state the app builds carries.
///
/// The dispatch and the IDE relay are `cognia_companion_rpc`'s; only the
/// host resolver is the app's.
pub fn runtime() -> Arc<dyn CompanionRuntime> {
    cognia_companion_rpc::companion_runtime::with_host_resolver(desktop_host)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A production state built without a dispatching runtime would still
    /// compile against [`super::super::runtime::unwired`] if someone reached
    /// for it, and silently lose the RPC table and the IDE relay. Pin each
    /// production constructor to its runtime.
    #[test]
    fn every_production_state_carries_its_runtime() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        for (file, needle) in [
            (
                "src-tauri/src/companion_api/commands.rs",
                "runtime: super::wiring::runtime(),",
            ),
            (
                "crates/cognia-server/src/main.rs",
                "runtime: cognia_companion_rpc::companion_runtime::headless(),",
            ),
            (
                "src-tauri/src/bin/cognia-webrtc-peer.rs",
                "runtime: app_lib::companion_api::wiring::runtime(),",
            ),
        ] {
            let source = std::fs::read_to_string(root.join(file)).expect(file);
            assert!(
                source.contains(needle),
                "{file} must build its state with its production runtime"
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

    /// `remote_execution` and the WebRTC dispatcher ask the runtime whether
    /// there is a host; the app runtime must answer the way the dispatch
    /// table resolves one, or a headless server would refuse every RPC.
    #[tokio::test]
    async fn the_app_runtime_can_dispatch_exactly_when_the_table_has_a_host() {
        let _slot = super::super::ws_bridge::test_support::lock_slot().await;
        let state = unit_state();

        crate::headless::install_headless_services(None);
        assert!(!state.runtime.can_dispatch(&state));
        assert!(DispatchHost::from_state(&state).is_none());

        crate::headless::install_headless_services(Some(
            crate::headless::HeadlessServices::stub_for_tests(),
        ));
        let with_host = state.runtime.can_dispatch(&state);
        let table_has_host = DispatchHost::from_state(&state).is_some();
        crate::headless::install_headless_services(None);
        assert!(with_host);
        assert!(table_has_host);
    }

    /// The headless server's own routes, against their real handlers: the
    /// public MCP OAuth callback answers a request with no query as a bad
    /// request, and the IDE content broker is mounted behind the service
    /// token. Neither exists on the desktop.
    #[tokio::test]
    async fn the_headless_server_mounts_its_own_routes() {
        use tower::ServiceExt as _;
        let _slot = super::super::ws_bridge::test_support::lock_slot().await;
        let peer = axum::extract::ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 34567)));
        let request = |method: &str, uri: &str| {
            axum::http::Request::builder()
                .method(method)
                .uri(uri)
                .extension(peer)
                .body(axum::body::Body::empty())
                .unwrap()
        };

        crate::headless::install_headless_services(None);
        let desktop = super::super::server::build_router(unit_state());
        for (method, uri) in [
            ("GET", "/integrations/mcp/oauth/callback"),
            ("POST", "/ide/content"),
        ] {
            let response = desktop.clone().oneshot(request(method, uri)).await.unwrap();
            assert_eq!(
                response.status(),
                axum::http::StatusCode::NOT_FOUND,
                "the desktop does not mount {uri}"
            );
        }

        crate::headless::install_headless_services(Some(
            crate::headless::HeadlessServices::stub_for_tests(),
        ));
        let headless = super::super::server::build_router(unit_state());
        let callback = headless
            .clone()
            .oneshot(request("GET", "/integrations/mcp/oauth/callback"))
            .await
            .unwrap()
            .status();
        let content = headless
            .oneshot(request("POST", "/ide/content"))
            .await
            .unwrap()
            .status();
        crate::headless::install_headless_services(None);
        assert_eq!(
            callback,
            axum::http::StatusCode::BAD_REQUEST,
            "headless mounts the public MCP OAuth callback"
        );
        assert_eq!(
            content,
            axum::http::StatusCode::UNAUTHORIZED,
            "headless mounts the IDE content broker behind the service token"
        );
    }

    /// `/healthz`, `whoami`, the bridge hello and the agent cards report the
    /// companion crate's version; `version-sync` keeps it the app's.
    #[test]
    fn the_companion_reports_the_app_version() {
        assert_eq!(cognia_companion::BUILD_VERSION, env!("CARGO_PKG_VERSION"));
    }

    fn unit_state() -> SharedState {
        use super::super::*;
        Arc::new(CompanionState {
            secret: parking_lot::RwLock::new(vec![0u8; 32]),
            deny_list: Arc::new(deny_list::DenyList::new()),
            renderer: None,
            runtime: runtime(),
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
