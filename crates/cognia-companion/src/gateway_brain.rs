//! The LLM gateway's link to the brain over the companion writes bridge
//! (ADR-0188 D9/D36, B2; ADR-0059 W3).
//!
//! `/v1/runs`, the `cognia/*` models and the passthrough ledger are served by
//! `cognia-gateway`, but Dexie — the authority on runs, money and events —
//! lives in the brain: the desktop renderer, or the headless Node process when
//! there is no window. Both hosts already carry every brain-owned mutation over
//! one channel, the companion writes bridge, whose frames reach whichever brain
//! is attached through a [`BridgeTransport`]. This module is the gateway's
//! adapter onto that channel, shared by both hosts:
//!
//! - [`WritesBrainBridge`] is the one [`BrainBridge`] implementation. The
//!   desktop resolves its route through the app handle (the window, or a
//!   connected headless brain); `cognia-server` resolves it from the companion
//!   state, where the only transport is the brain's `/internal/bridge` socket.
//!   Either way the brain's answer is read by
//!   [`interpret_envelope`](cognia_gateway::brain_bridge::interpret_envelope),
//!   so the two hosts cannot drift on the `{ ok, value }` contract.
//! - [`HeadlessRouterFusionGateway`] is what `cognia-server` adds on top: the
//!   brain bridge, and the Router + Fusion switches. The desktop's window
//!   pushes them inside the routing snapshot (`gateway_push_snapshot`), but a
//!   headless gateway's snapshot is projected from the Provider Profile Store,
//!   which knows nothing about Router + Fusion. The headless brain therefore
//!   publishes the account's two gateway switches itself
//!   (`lib/headless/runtimes/router-fusion.ts`) through a `respond` frame
//!   ([`PUBLISH_SWITCHES_COMMAND`]), and every projected snapshot is stamped
//!   with the last value it published.

use std::sync::{Arc, Weak};
use std::time::Duration;

use cognia_gateway::brain_bridge::{
    interpret_envelope, BrainBridge, BrainBridgeError, BrainFuture,
};
use cognia_gateway::runs::RouterFusionGatewaySwitches;
use cognia_gateway::snapshot::RoutingSnapshot;
use cognia_gateway::{GatewayState, SnapshotAccepted, SnapshotRejected};
use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};
use serde_json::Value;

use crate::bridge_transport::BridgeTransport;
use crate::desktop_writes_bridge::DesktopWritesBridge;
use crate::ws_bridge::resolve_bridge_transport;
use crate::SharedState;

/// A Run API request is one brain round trip. Shorter than the writes bridge's
/// own default: an HTTP caller is waiting, and a brain that needs longer than
/// this is a brain the caller should be told about rather than kept waiting
/// for. The passthrough lane bounds its own calls far tighter
/// (`passthrough_ledger::RESERVE_TIMEOUT`), inside this one.
pub const RUN_API_BRIDGE_TIMEOUT: Duration = Duration::from_secs(10);

/// The `respond` command the headless brain publishes the account's gateway
/// switches with. Mirrored by `GATEWAY_SWITCHES_PUBLISH_COMMAND` in
/// `lib/headless/runtimes/router-fusion.ts`.
pub const PUBLISH_SWITCHES_COMMAND: &str = "gateway_router_fusion_switches_publish";

/// Where a call travels: the writes bridge that owns the pending request, and
/// the transport that reaches the attached brain.
pub type WritesRoute = (Arc<DesktopWritesBridge>, Arc<dyn BridgeTransport>);

/// Resolves the route per call. Both halves change while the process runs — a
/// window opens and closes, a headless brain connects and reconnects — so
/// resolving them once would pin whichever state happened to exist then.
pub type WritesRouteResolver = Arc<dyn Fn() -> Result<WritesRoute, String> + Send + Sync>;

/// The gateway's [`BrainBridge`] over the companion writes bridge.
///
/// A transport failure — no brain attached, the brain did not answer in time,
/// the socket dropped mid-request — is `Unavailable`, which the Run API turns
/// into `503 BRAIN_UNAVAILABLE` and the passthrough lane into a bypass. It is
/// never answered from a stale read.
pub struct WritesBrainBridge {
    resolve: WritesRouteResolver,
    timeout: Duration,
}

impl WritesBrainBridge {
    pub fn new(resolve: WritesRouteResolver) -> Arc<Self> {
        Self::with_timeout(resolve, RUN_API_BRIDGE_TIMEOUT)
    }

    pub fn with_timeout(resolve: WritesRouteResolver, timeout: Duration) -> Arc<Self> {
        Arc::new(Self { resolve, timeout })
    }

    /// The headless server's bridge: the companion state's writes bridge, and
    /// whichever transport [`resolve_bridge_transport`] finds for it — on
    /// `cognia-server` that is only ever the connected brain's socket, since
    /// the headless state has no renderer.
    pub fn for_shared_state(state: SharedState) -> Arc<Self> {
        Self::new(Arc::new(move || {
            let transport = resolve_bridge_transport(&state)?;
            Ok((Arc::clone(&state.desktop_writes_bridge), transport))
        }))
    }
}

impl BrainBridge for WritesBrainBridge {
    fn call(&self, command: &'static str, payload: Value) -> BrainFuture {
        let route = (self.resolve)();
        let timeout = self.timeout;
        Box::pin(async move {
            let (writes, transport) = route.map_err(BrainBridgeError::unavailable)?;
            let raw = writes
                .dispatch(transport.as_ref(), command, payload, timeout)
                .await
                .map_err(BrainBridgeError::unavailable)?;
            interpret_envelope(raw)
        })
    }
}

/// Receives the switches the brain published, and says whether a live gateway
/// took them. Installed by [`HeadlessRouterFusionGateway::install`]; absent on
/// the desktop, whose window pushes its switches inside the routing snapshot
/// instead.
pub type SwitchesSink = Arc<dyn Fn(RouterFusionGatewaySwitches) -> bool + Send + Sync>;

/// Process-global, following the module-global idiom of the socket-bridge
/// slot: the `respond` router runs on the bridge socket with nothing but the
/// companion state in hand.
static SWITCHES_SINK: Lazy<RwLock<Option<SwitchesSink>>> = Lazy::new(|| RwLock::new(None));

pub fn install_switches_sink(sink: Option<SwitchesSink>) {
    *SWITCHES_SINK.write() = sink;
}

/// Why a published set of switches was not applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublishSwitchesError {
    /// The payload is not the two booleans the gateway reads.
    Malformed(String),
    /// Nothing on this host consumes brain-published switches — the desktop,
    /// or a headless server whose gateway was never wired.
    NoGateway,
}

/// Apply switches a brain published over the bridge (`ws_bridge::route_respond`).
///
/// The payload must be exactly the gateway's `RouterFusionGatewaySwitches`:
/// a payload that is anything else is refused whole rather than read as
/// "both off", because an unreadable publish must not switch off a surface the
/// account turned on — and must never switch one on.
pub fn publish_switches(payload: Value) -> Result<RouterFusionGatewaySwitches, PublishSwitchesError> {
    let switches = parse_switches(payload)?;
    let sink = SWITCHES_SINK.read().clone();
    match sink {
        Some(sink) if sink(switches) => Ok(switches),
        _ => Err(PublishSwitchesError::NoGateway),
    }
}

fn parse_switches(payload: Value) -> Result<RouterFusionGatewaySwitches, PublishSwitchesError> {
    let object = payload
        .as_object()
        .ok_or_else(|| PublishSwitchesError::Malformed(format!("not an object: {payload}")))?;
    for field in ["runsEnabled", "passthroughLedgerEnabled"] {
        if !object.get(field).is_some_and(Value::is_boolean) {
            return Err(PublishSwitchesError::Malformed(format!(
                "`{field}` must be a boolean: {payload}"
            )));
        }
    }
    serde_json::from_value(payload).map_err(|error| PublishSwitchesError::Malformed(error.to_string()))
}

/// The headless server's Router + Fusion wiring for its LLM gateway.
///
/// One lock guards the brain's last publish, and both writers take it: the
/// profile projection (which replaces the whole snapshot, switches included)
/// and a publish from the brain (which changes only the switches). Without it
/// a projection that read the old switches could commit after a publish and
/// switch a surface back off until the brain's next heartbeat.
pub struct HeadlessRouterFusionGateway {
    gateway: Arc<GatewayState>,
    published: Mutex<Option<RouterFusionGatewaySwitches>>,
}

impl HeadlessRouterFusionGateway {
    /// Give the gateway its brain and start listening for the brain's switches.
    ///
    /// Installing changes nothing a caller can see on its own: both surfaces
    /// stay off — `/v1/runs` answers `403`, passthrough is `bypassed:surface_off`
    /// — until the brain publishes the account's switches.
    pub fn install(shared: SharedState, gateway: Arc<GatewayState>) -> Arc<Self> {
        Self::install_with_bridge(WritesBrainBridge::for_shared_state(shared), gateway)
    }

    fn install_with_bridge(bridge: Arc<dyn BrainBridge>, gateway: Arc<GatewayState>) -> Arc<Self> {
        gateway.runs.install_bridge(bridge);
        let this = Arc::new(Self {
            gateway,
            published: Mutex::new(None),
        });
        // Weak: the sink is process-global and must not keep a gateway alive
        // past the server that owns it.
        let weak: Weak<Self> = Arc::downgrade(&this);
        install_switches_sink(Some(Arc::new(move |switches| match weak.upgrade() {
            Some(this) => {
                this.apply_switches(switches);
                true
            }
            None => false,
        })));
        this
    }

    /// Record and apply what the brain published.
    pub fn apply_switches(&self, switches: RouterFusionGatewaySwitches) {
        let mut published = self.published.lock();
        let changed = *published != Some(switches);
        *published = Some(switches);
        self.gateway.runs.set_switches(switches);
        if changed {
            log::info!(
                "gateway Router + Fusion switches from the brain: runs={}, passthrough ledger={}",
                switches.runs_enabled,
                switches.passthrough_ledger_enabled
            );
        }
    }

    /// The switches the brain last published, if it has published any.
    pub fn published_switches(&self) -> Option<RouterFusionGatewaySwitches> {
        *self.published.lock()
    }

    /// Commit a projected snapshot, carrying the brain's switches.
    ///
    /// The profile projection has no opinion on Router + Fusion; left alone,
    /// every profile change would commit a snapshot that says "both off"
    /// (`commit_snapshot` reads `router_fusion: None` as off).
    pub fn project_snapshot(
        &self,
        mut snapshot: RoutingSnapshot,
    ) -> Result<SnapshotAccepted, SnapshotRejected> {
        let published = self.published.lock();
        snapshot.router_fusion = *published;
        self.gateway.try_set_snapshot(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ws_bridge::test_support::{
        clear_socket_for_testing, install_socket_for_testing, lock_slot,
    };
    use axum::extract::ws::Message;
    use cognia_gateway::brain_bridge::{command, RecordingBrainBridge};
    use serde_json::json;

    fn test_state() -> SharedState {
        use crate::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache, CompanionState,
        };
        Arc::new(CompanionState {
            secret: RwLock::new(vec![0u8; 32]),
            deny_list: Arc::new(DenyList::new()),
            renderer: None,
            runtime: crate::runtime::unwired(),
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: crate::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge: crate::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge: DesktopWritesBridge::new(),
            sync_registry: crate::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::push::PushTokenRegistry::new(),
        })
    }

    /// The request the bridge put on the brain's socket, as `(requestId, command, payload)`.
    fn request_of(message: Message) -> (String, String, Value) {
        let Message::Text(text) = message else {
            panic!("the bridge sends text frames");
        };
        let frame: Value = serde_json::from_str(&text).expect("a JSON frame");
        assert_eq!(frame["type"], "event");
        assert_eq!(frame["event"], "companion://desktop-write-request");
        let payload = &frame["payload"];
        (
            payload["requestId"].as_str().expect("a request id").to_string(),
            payload["command"].as_str().expect("a command").to_string(),
            payload["payload"].clone(),
        )
    }

    fn answer(state: &SharedState, request_id: &str, result: Value) {
        state.desktop_writes_bridge.resolve(
            serde_json::from_value(json!({ "requestId": request_id, "result": result, "error": null }))
                .expect("a write response"),
        );
    }

    #[tokio::test]
    async fn a_headless_bridge_round_trips_through_the_brains_socket() {
        let _slot = lock_slot().await;
        let state = test_state();
        let mut socket = install_socket_for_testing(&state);
        let bridge = WritesBrainBridge::for_shared_state(Arc::clone(&state));

        let call = tokio::spawn({
            let bridge = Arc::clone(&bridge);
            async move { bridge.call(command::RUN_GET, json!({ "runId": "run-1" })).await }
        });
        let (request_id, name, payload) = request_of(socket.recv().await.expect("a frame"));
        assert_eq!(name, command::RUN_GET);
        assert_eq!(payload["runId"], "run-1");
        answer(&state, &request_id, json!({ "ok": true, "value": { "runId": "run-1", "status": "running" } }));

        let value = call.await.unwrap().expect("the brain's value");
        assert_eq!(value["status"], "running");
        clear_socket_for_testing();
    }

    #[tokio::test]
    async fn the_brains_refusal_and_a_broken_contract_are_told_apart() {
        let _slot = lock_slot().await;
        let state = test_state();
        let mut socket = install_socket_for_testing(&state);
        let bridge = WritesBrainBridge::for_shared_state(Arc::clone(&state));

        let refused = tokio::spawn({
            let bridge = Arc::clone(&bridge);
            async move { bridge.call(command::RUN_CREATE, json!({})).await }
        });
        let (request_id, _, _) = request_of(socket.recv().await.unwrap());
        answer(
            &state,
            &request_id,
            json!({ "ok": false, "error": { "status": 403, "code": "ROUTER_FUSION_DISABLED", "message": "off" } }),
        );
        assert!(matches!(
            refused.await.unwrap(),
            Err(BrainBridgeError::Refused { status: 403, ref code, .. }) if code == "ROUTER_FUSION_DISABLED"
        ));

        let bare = tokio::spawn({
            let bridge = Arc::clone(&bridge);
            async move { bridge.call(command::RUN_GET, json!({})).await }
        });
        let (request_id, _, _) = request_of(socket.recv().await.unwrap());
        answer(&state, &request_id, json!({ "runId": "run-1" }));
        assert!(matches!(bare.await.unwrap(), Err(BrainBridgeError::Unavailable(_))));
        clear_socket_for_testing();
    }

    #[tokio::test]
    async fn a_headless_server_with_no_brain_connected_is_unavailable() {
        let _slot = lock_slot().await;
        clear_socket_for_testing();
        let bridge = WritesBrainBridge::for_shared_state(test_state());
        let error = bridge
            .call(command::RUN_GET, json!({}))
            .await
            .expect_err("nothing to answer");
        assert!(matches!(error, BrainBridgeError::Unavailable(_)));
    }

    #[tokio::test]
    async fn a_brain_that_never_answers_times_out_as_unavailable() {
        let _slot = lock_slot().await;
        let state = test_state();
        let _socket = install_socket_for_testing(&state);
        let writes = Arc::clone(&state.desktop_writes_bridge);
        let bridge = WritesBrainBridge::with_timeout(
            Arc::new(move || {
                let transport = resolve_bridge_transport(&state)?;
                Ok((Arc::clone(&writes), transport))
            }),
            Duration::from_millis(20),
        );
        let error = bridge
            .call(command::RUN_GET, json!({}))
            .await
            .expect_err("timed out");
        match error {
            BrainBridgeError::Unavailable(reason) => assert!(reason.contains("timed out"), "{reason}"),
            other => panic!("unexpected: {other:?}"),
        }
        clear_socket_for_testing();
    }

    fn snapshot() -> RoutingSnapshot {
        serde_json::from_value(json!({
            "providers": [],
            "aliases": [],
            "generatedAtMs": 1,
            "profileVersion": 1,
            "authority": "profile-store"
        }))
        .expect("a projected snapshot")
    }

    /// `install` touches the process-global sink; tests that do share the slot lock.
    #[tokio::test]
    async fn the_brains_switches_survive_every_profile_projection() {
        let _slot = lock_slot().await;
        let gateway = Arc::new(GatewayState::new());
        let rf = HeadlessRouterFusionGateway::install_with_bridge(
            Arc::new(RecordingBrainBridge::new()),
            Arc::clone(&gateway),
        );
        // Nothing published yet: both off, and a projection keeps them off.
        rf.project_snapshot(snapshot()).expect("accepted");
        assert!(!gateway.runs.runs_enabled());
        assert!(rf.published_switches().is_none());

        let applied = publish_switches(json!({ "runsEnabled": true, "passthroughLedgerEnabled": true }))
            .expect("applied");
        assert!(applied.runs_enabled && applied.passthrough_ledger_enabled);
        assert!(gateway.runs.runs_enabled());
        assert!(gateway.runs.passthrough_ledger_enabled());

        // A profile change replaces the whole snapshot. Without the stamp it
        // would read as "both off" and take the surfaces down.
        let mut next = snapshot();
        next.profile_version = Some(2);
        rf.project_snapshot(next).expect("accepted");
        assert!(gateway.runs.runs_enabled());
        assert!(gateway.runs.passthrough_ledger_enabled());

        publish_switches(json!({ "runsEnabled": false, "passthroughLedgerEnabled": true })).unwrap();
        assert!(!gateway.runs.runs_enabled());
        assert!(gateway.runs.passthrough_ledger_enabled());
        drop(rf);
        install_switches_sink(None);
    }

    #[tokio::test]
    async fn an_unreadable_publish_changes_nothing() {
        let _slot = lock_slot().await;
        let gateway = Arc::new(GatewayState::new());
        let rf = HeadlessRouterFusionGateway::install_with_bridge(
            Arc::new(RecordingBrainBridge::new()),
            Arc::clone(&gateway),
        );
        rf.apply_switches(RouterFusionGatewaySwitches {
            runs_enabled: true,
            passthrough_ledger_enabled: false,
        });
        for payload in [
            json!(null),
            json!({ "runsEnabled": false }),
            json!({ "runsEnabled": "false", "passthroughLedgerEnabled": false }),
            json!([true, true]),
        ] {
            assert!(matches!(
                publish_switches(payload),
                Err(PublishSwitchesError::Malformed(_))
            ));
        }
        assert!(gateway.runs.runs_enabled(), "a malformed publish is not an off switch");
        drop(rf);
        install_switches_sink(None);
    }

    #[tokio::test]
    async fn a_host_with_no_headless_gateway_reports_the_publish_unapplied() {
        let _slot = lock_slot().await;
        install_switches_sink(None);
        assert_eq!(
            publish_switches(json!({ "runsEnabled": true, "passthroughLedgerEnabled": true })),
            Err(PublishSwitchesError::NoGateway)
        );
    }

    #[tokio::test]
    async fn installing_gives_the_gateway_its_brain_without_switching_anything_on() {
        let _slot = lock_slot().await;
        let gateway = Arc::new(GatewayState::new());
        let brain = RecordingBrainBridge::new();
        brain.ok(command::RUN_GET, json!({ "runId": "run-1" }));
        let rf = HeadlessRouterFusionGateway::install_with_bridge(
            Arc::new(brain.clone()),
            Arc::clone(&gateway),
        );
        assert!(!gateway.runs.runs_enabled());
        assert!(!gateway.runs.passthrough_ledger_enabled());
        let value = gateway
            .runs
            .bridge()
            .call(command::RUN_GET, json!({}))
            .await
            .expect("the installed bridge answers");
        assert_eq!(value["runId"], "run-1");
        assert_eq!(brain.calls().len(), 1);
        drop(rf);
        install_switches_sink(None);
    }

    /// The name the headless brain publishes with is the name routed here.
    #[test]
    fn the_publish_command_matches_the_brain_and_the_router() {
        let brain = include_str!("../../../lib/headless/runtimes/router-fusion.ts");
        assert!(
            brain.contains(&format!("\"{PUBLISH_SWITCHES_COMMAND}\"")),
            "lib/headless/runtimes/router-fusion.ts publishes under another name"
        );
        let router = include_str!("ws_bridge.rs");
        let routing = router
            .split_once("fn route_respond(")
            .expect("route_respond exists")
            .1;
        assert!(routing.contains("PUBLISH_SWITCHES_COMMAND"));
    }
}
