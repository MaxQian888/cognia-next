//! The desktop host's implementation of the gateway's brain bridge (ADR-0188 D9, B2).
//!
//! `/v1/runs` is served by `cognia-gateway`, but Dexie — the authority on runs,
//! money and events — lives in the brain: the desktop renderer, or the headless
//! Node process when there is no window. The bridge itself is host-neutral and
//! lives in `cognia-companion` ([`WritesBrainBridge`]): it reuses the companion
//! writes bridge rather than opening a second channel, so a Run API request
//! travels exactly the path every other brain-owned mutation already does, and
//! it reads the brain's answer with the gateway crate's one envelope reader.
//! `cognia-server` builds the same bridge from its companion state
//! (`gateway_brain::HeadlessRouterFusionGateway`).
//!
//! What this file adds is the only desktop-specific part: where the route comes
//! from. It is resolved per call from the app handle, because it changes while
//! the app runs — the companion listener starts and stops, a headless brain
//! connects and disconnects, and a window opens and closes.

use std::sync::Arc;

use cognia_gateway::brain_bridge::{BrainBridge, BrainFuture};
use serde_json::Value;

use crate::companion_api::bridge_transport::{BridgeTransport, WebViewBridgeTransport};
use crate::companion_api::gateway_brain::{WritesBrainBridge, WritesRoute};
use crate::companion_api::ws_bridge::resolve_bridge_transport;
use crate::companion_api::CompanionServerState;

/// The route a desktop brain call takes: the companion's writes bridge, and a
/// connected headless brain when there is one, otherwise the window, whose own
/// emit is how every other brain-owned mutation travels.
fn desktop_route(app: &tauri::AppHandle) -> WritesRoute {
    use tauri::Manager as _;
    // Everything borrowed from the app handle is cloned out here, in a
    // synchronous resolver: a Tauri `State` guard may not be held across the
    // bridge's await.
    let companion = app.state::<CompanionServerState>();
    let writes = Arc::clone(&companion.desktop_writes_bridge);
    let transport: Arc<dyn BridgeTransport> = companion
        .shared_state()
        .and_then(|state| resolve_bridge_transport(&state).ok())
        .unwrap_or_else(|| Arc::new(WebViewBridgeTransport(app.clone())));
    (writes, transport)
}

/// The bridge the desktop gateway runs with.
pub struct DesktopBrainBridge {
    inner: Arc<WritesBrainBridge>,
}

impl DesktopBrainBridge {
    pub fn new(app: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self {
            inner: WritesBrainBridge::new(Arc::new(move || Ok(desktop_route(&app)))),
        })
    }
}

impl BrainBridge for DesktopBrainBridge {
    fn call(&self, command: &'static str, payload: Value) -> BrainFuture {
        self.inner.call(command, payload)
    }
}

#[cfg(test)]
mod tests {
    /// The desktop adds a route and nothing else: the envelope is read by the
    /// gateway crate's `interpret_envelope` inside the shared bridge, so the
    /// desktop and `cognia-server` cannot drift on the `{ ok, value }` contract.
    #[test]
    fn the_desktop_bridge_delegates_to_the_shared_writes_bridge() {
        let source = include_str!("gateway_brain_bridge.rs");
        let code = source.split("#[cfg(test)]").next().expect("the module body");
        assert!(code.contains("WritesBrainBridge::new("));
        assert!(!code.contains("fn interpret("), "the envelope reader lives in cognia-gateway");
        assert!(!code.contains("enum BridgeOutcome"));
    }
}
