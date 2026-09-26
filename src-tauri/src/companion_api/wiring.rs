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

use super::runtime::CompanionRuntime;
use super::SharedState;

/// The app's routes and hooks for a companion server.
struct AppCompanionRuntime;

impl CompanionRuntime for AppCompanionRuntime {
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
