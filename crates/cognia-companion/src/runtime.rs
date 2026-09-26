//! What the companion core reads from the app above it (ADR-0196 P5.4).
//!
//! The core cannot name the app, so what it needs from it arrives two ways.
//!
//! [`CompanionRuntime`] is what every binary provides: a field of
//! [`CompanionState`](super::CompanionState), so a binary that builds a state
//! without one does not compile. Production states take
//! [`super::wiring::runtime`]; unit-test states take [`unwired`].
//!
//! The headless server's extras are process-global slots, because the
//! services behind them are:
//!
//! - [`HEADLESS`], set and cleared by `headless::install_headless_services`
//!   together with the services themselves, so every existing install path
//!   (the server's boot, the tests' stubs) fills it with no extra call. It
//!   feeds `/healthz`, `/metrics`, the bridge's orchestration replies, the
//!   Lark admin surface and the headless-only routes;
//! - [`BRAIN`], set by `headless::brain::install_brain`.
//!
//! On the desktop both stay empty, which is what "not headless" means here.

use std::sync::Arc;

use axum::{http::StatusCode, Json, Router};
use cognia_core::installed::Replaceable;
use serde_json::Value;

use super::event_bus::EventBus;
use super::middleware::DeviceContext;
use super::remote_execution::ExecutionPlane;
use super::rpc_error::RpcError;
use super::SharedState;

/// The result of one command dispatch: the arm's value, or its RPC error.
pub type DispatchResult = Result<Value, (StatusCode, Json<RpcError>)>;

/// What the app adds to every companion server it runs.
#[async_trait::async_trait]
pub trait CompanionRuntime: Send + Sync + 'static {
    /// The remote Pro IDE relay (`/ide/relay/{relay_id}[/{*tail}]`), mounted
    /// behind device access.
    fn ide_relay_routes(&self) -> Router<SharedState>;

    /// Whether this process has a host to run commands on: the desktop
    /// WebView, or the headless services `cognia-server` installs at boot.
    fn can_dispatch(&self, state: &SharedState) -> bool;

    /// Run one command through the app's dispatch table.
    ///
    /// Only [`super::remote_execution`] calls this, after it has completed
    /// authentication, capability, approval, transport and durable-idempotency
    /// checks; protocol adapters go through `remote_execution::execute`.
    async fn dispatch(
        &self,
        name: &str,
        args: Value,
        state: &SharedState,
        principal: &DeviceContext,
        plane: ExecutionPlane,
    ) -> DispatchResult;
}

/// Proof that a state's runtime can dispatch, for protocol handlers that skip
/// the dispatches of a turn (a deny, an interrupt) when there is no host to
/// run them on.
#[derive(Debug, Clone, Copy)]
pub struct DispatchReady(());

impl DispatchReady {
    /// `Some` when [`CompanionRuntime::can_dispatch`] says so for `state`.
    pub fn check(state: &SharedState) -> Option<Self> {
        state.runtime.can_dispatch(state).then_some(Self(()))
    }
}

/// A runtime that adds nothing, for unit-test states that never reach the
/// app: no routes, and every dispatch answers the 503 a state with no host
/// always has.
#[cfg(any(test, feature = "test-support"))]
pub fn unwired() -> Arc<dyn CompanionRuntime> {
    struct Unwired;
    #[async_trait::async_trait]
    impl CompanionRuntime for Unwired {
        fn ide_relay_routes(&self) -> Router<SharedState> {
            Router::new()
        }

        fn can_dispatch(&self, _state: &SharedState) -> bool {
            false
        }

        async fn dispatch(
            &self,
            _name: &str,
            _args: Value,
            _state: &SharedState,
            _principal: &DeviceContext,
            _plane: ExecutionPlane,
        ) -> DispatchResult {
            Err(RpcError::service_unavailable(
                "app_handle not available (test mode)".to_string(),
            ))
        }
    }
    Arc::new(Unwired)
}

/// Env var naming the brain bundle `cognia-server` supervises. Set, the
/// server is not ready until the brain has said hello.
pub const BRAIN_ENTRY_ENV: &str = "COGNIA_BRAIN_ENTRY";

/// The headless server's side of the companion core.
#[async_trait::async_trait]
pub trait HeadlessRuntime: Send + Sync + 'static {
    /// The Node sidecar answers.
    async fn sidecar_ready(&self) -> bool;
    /// Sidecar spawns since boot.
    fn sidecar_restart_count(&self) -> u64;
    /// The LLM gateway is configured on.
    fn gateway_enabled(&self) -> bool;
    /// The LLM gateway's listener is up.
    fn gateway_running(&self) -> bool;
    /// The `gateway` block `/healthz` reports (ADR-0090 Phase 2).
    fn gateway_health(&self) -> Value;
    /// Hand a brain's orchestration reply to the embedded MCP server.
    fn resolve_orchestration_reply(
        &self,
        id: &str,
        reply: cognia_mcp_server::orchestration_proxy::OrchestrationReply,
    );
    /// The connector runtime the public webhook ingress (`/connectors`)
    /// serves.
    fn connectors(&self) -> cognia_connectors::state::ConnectorsState;
    /// The bus webhook events are published onto.
    fn event_bus(&self) -> Arc<EventBus>;
    /// `/oauth/callback` for remote MCP servers, nested under
    /// `/integrations/mcp`.
    fn mcp_oauth_routes(&self) -> Router<SharedState>;
    /// The Pro IDE content broker (`/ide/content`, `/ide/content/{handle_id}`),
    /// mounted behind the service token.
    fn ide_content_routes(&self) -> Router<SharedState>;
}

/// The installed headless runtime; empty on the desktop.
pub static HEADLESS: Replaceable<dyn HeadlessRuntime> =
    Replaceable::new("companion_api::runtime::HEADLESS");

/// The headless runtime, when this process is `cognia-server`.
pub fn headless() -> Option<Arc<dyn HeadlessRuntime>> {
    HEADLESS.try_get()
}

/// Snapshot for `/healthz` and `/metrics` of the supervised brain child.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrainStatus {
    /// A child process is currently alive.
    pub running: bool,
    /// The child completed the bridge hello (data plane live).
    pub ready: bool,
    /// Times a child has been spawned since boot.
    pub restart_count: u64,
    /// Latest RSS gauge from the brain's pong frames (0 = unknown).
    pub rss_bytes: u64,
    /// `brainVersion` from the hello frame, when connected.
    pub version: Option<String>,
}

/// Whatever supervises the brain child.
pub trait BrainProbe: Send + Sync + 'static {
    fn status(&self) -> BrainStatus;
}

/// The installed brain supervisor; empty on the desktop.
pub static BRAIN: Replaceable<dyn BrainProbe> = Replaceable::new("companion_api::runtime::BRAIN");

/// The installed supervisor's status, if any (`None` on desktop).
pub fn brain_status() -> Option<BrainStatus> {
    BRAIN.try_get().map(|brain| brain.status())
}

/// A headless runtime for the core's own tests: the server's reads answer
/// "not ready, nothing configured", its routes are empty, and orchestration
/// replies are recorded instead of reaching an MCP server. Hold
/// `ws_bridge::test_support::lock_slot()` while it is installed; the slot is
/// process-global.
#[cfg(any(test, feature = "test-support"))]
pub mod test_support {
    use super::*;
    use parking_lot::Mutex;

    #[derive(Default)]
    pub struct FakeHeadless {
        /// The ids of the orchestration replies handed over, in order.
        pub orchestration_replies: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl HeadlessRuntime for FakeHeadless {
        async fn sidecar_ready(&self) -> bool {
            false
        }

        fn sidecar_restart_count(&self) -> u64 {
            0
        }

        fn gateway_enabled(&self) -> bool {
            false
        }

        fn gateway_running(&self) -> bool {
            false
        }

        fn gateway_health(&self) -> Value {
            serde_json::json!({ "running": false })
        }

        fn resolve_orchestration_reply(
            &self,
            id: &str,
            _reply: cognia_mcp_server::orchestration_proxy::OrchestrationReply,
        ) {
            self.orchestration_replies.lock().push(id.to_string());
        }

        fn connectors(&self) -> cognia_connectors::state::ConnectorsState {
            cognia_connectors::state::ConnectorsState::new()
        }

        fn event_bus(&self) -> Arc<EventBus> {
            EventBus::new()
        }

        fn mcp_oauth_routes(&self) -> Router<SharedState> {
            Router::new()
        }

        fn ide_content_routes(&self) -> Router<SharedState> {
            Router::new()
        }
    }

    /// Install a [`FakeHeadless`], making this process look like
    /// `cognia-server` to the core.
    pub fn install_fake_headless() -> Arc<FakeHeadless> {
        let fake = Arc::new(FakeHeadless::default());
        let _ = HEADLESS.set(fake.clone() as Arc<dyn HeadlessRuntime>);
        fake
    }

    /// Empty the slot: the desktop topology.
    pub fn clear_headless() {
        let _ = HEADLESS.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `/healthz` serializes this struct as-is, so its field names are wire
    /// contract. (The slot itself is exercised by `headless::brain`'s tests;
    /// a second test here would race them over the same global.)
    #[test]
    fn brain_status_keeps_its_healthz_field_names() {
        let value = serde_json::to_value(BrainStatus {
            running: true,
            ready: false,
            restart_count: 3,
            rss_bytes: 7,
            version: Some("1.2.3".into()),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "running": true,
                "ready": false,
                "restart_count": 3,
                "rss_bytes": 7,
                "version": "1.2.3",
            })
        );
    }

    #[test]
    fn the_brain_entry_env_name_is_stable() {
        assert_eq!(BRAIN_ENTRY_ENV, "COGNIA_BRAIN_ENTRY");
    }
}
