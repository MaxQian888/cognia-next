//! What the companion core reads from the headless server (ADR-0196 P5.4).
//!
//! `/healthz`, `/metrics`, the bridge's orchestration replies and the Lark
//! admin surface behave differently on `cognia-server`: they report and reach
//! its sidecar, gateway and MCP server, and the brain child it supervises.
//! Those live in the server's own services, above this core, so the core reads
//! them through two slots:
//!
//! - [`HEADLESS`], set and cleared by `headless::install_headless_services`
//!   together with the services themselves, so every existing install path
//!   (the server's boot, the tests' stubs) fills it with no extra call;
//! - [`BRAIN`], set by `headless::brain::install_brain`.
//!
//! On the desktop both stay empty, which is what "not headless" means here.

use std::sync::Arc;

use cognia_core::installed::Replaceable;
use serde_json::Value;

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
        reply: crate::mcp_server::orchestration_proxy::OrchestrationReply,
    );
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
