//! The desktop host's implementation of the gateway's brain bridge (ADR-0188 D9, B2).
//!
//! `/v1/runs` is served by `cognia-gateway`, but Dexie — the authority on runs,
//! money and events — lives in the brain: the desktop renderer, or the headless
//! Node process when there is no window. This adapter is the one round trip
//! between them, and it reuses the companion writes bridge rather than opening a
//! second channel, so a Run API request travels exactly the path every other
//! brain-owned mutation already does.
//!
//! The brain answers with a tagged outcome (`{ ok: true, value }` or
//! `{ ok: false, error: { status, code, … } }`) rather than by throwing,
//! because the gateway needs the status and the code to answer the caller with.
//! A transport failure — no window attached, the brain did not answer in time —
//! is `Unavailable`, which becomes `503 BRAIN_UNAVAILABLE`, never a stale read.

use std::sync::Arc;
use std::time::Duration;

use cognia_gateway::brain_bridge::{BrainBridge, BrainBridgeError, BrainFuture};
use serde::Deserialize;
use serde_json::Value;

use crate::companion_api::bridge_transport::{BridgeTransport, WebViewBridgeTransport};
use crate::companion_api::ws_bridge::resolve_bridge_transport;
use crate::companion_api::CompanionServerState;

/// A Run API request is one brain round trip. Shorter than the writes bridge's
/// own default: an HTTP caller is waiting, and a brain that needs longer than
/// this is a brain the caller should be told about rather than kept waiting for.
pub const RUN_API_BRIDGE_TIMEOUT: Duration = Duration::from_secs(10);

/// The tagged outcome `lib/router-fusion/gate/run-api-bridge.ts` answers with.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum BridgeOutcome {
    Ok {
        ok: bool,
        value: Value,
    },
    Err {
        ok: bool,
        error: BridgeErrorBody,
    },
}

#[derive(Debug, Deserialize)]
struct BridgeErrorBody {
    #[serde(default = "default_status")]
    status: u16,
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    details: Option<Value>,
}

fn default_status() -> u16 {
    500
}

/// Turn what the brain sent into what the gateway's routes expect. Anything
/// that is not one of the two shapes is a broken contract, not a refusal: the
/// caller is told the brain is unavailable rather than being handed a guess.
fn interpret(raw: Value) -> Result<Value, BrainBridgeError> {
    match serde_json::from_value::<BridgeOutcome>(raw.clone()) {
        Ok(BridgeOutcome::Err { ok: false, error }) => Err(BrainBridgeError::Refused {
            status: error.status,
            code: if error.code.is_empty() {
                "BRAIN_ERROR".to_string()
            } else {
                error.code
            },
            message: error.message,
            details: error.details,
        }),
        Ok(BridgeOutcome::Ok { ok: true, value }) => Ok(value),
        _ => Err(BrainBridgeError::unavailable(format!(
            "the brain answered a Run API command with an unrecognised shape: {raw}"
        ))),
    }
}

/// The bridge the desktop gateway runs with.
///
/// It holds only the app handle: the writes bridge and the transport are read
/// per call, because both change while the app runs — the companion listener
/// starts and stops, a headless brain connects and disconnects, and a window
/// opens and closes. Resolving them once at startup would pin whichever state
/// happened to exist then.
pub struct DesktopBrainBridge {
    app: tauri::AppHandle,
}

impl DesktopBrainBridge {
    pub fn new(app: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self { app })
    }
}

impl BrainBridge for DesktopBrainBridge {
    fn call(&self, command: &'static str, payload: Value) -> BrainFuture {
        let app = self.app.clone();
        Box::pin(async move {
            // Everything borrowed from the app handle is cloned out before the
            // await: a Tauri `State` guard may not be held across one.
            let (writes, transport) = {
                use tauri::Manager as _;
                let companion = app.state::<CompanionServerState>();
                let writes = Arc::clone(&companion.desktop_writes_bridge);
                // A connected headless brain wins; otherwise the window, whose
                // own emit is how every other brain-owned mutation travels.
                let transport: Arc<dyn BridgeTransport> = companion
                    .shared_state()
                    .and_then(|state| resolve_bridge_transport(&state).ok())
                    .unwrap_or_else(|| Arc::new(WebViewBridgeTransport(app.clone())));
                (writes, transport)
            };
            let raw = writes
                .dispatch(transport.as_ref(), command, payload, RUN_API_BRIDGE_TIMEOUT)
                .await
                .map_err(BrainBridgeError::unavailable)?;
            interpret(raw)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_successful_outcome_unwraps_to_its_value() {
        let value = interpret(json!({ "ok": true, "value": { "runId": "run-1" } }))
            .expect("a successful outcome");
        assert_eq!(value["runId"], "run-1");
    }

    #[test]
    fn a_refusal_keeps_the_brains_own_status_and_code() {
        let error = interpret(json!({
            "ok": false,
            "error": { "status": 409, "code": "SESSION_BUSY", "message": "busy", "details": { "activeRunId": "run-2" } }
        }))
        .expect_err("a refusal");
        match error {
            BrainBridgeError::Refused {
                status,
                code,
                message,
                details,
            } => {
                assert_eq!(status, 409);
                assert_eq!(code, "SESSION_BUSY");
                assert_eq!(message, "busy");
                assert_eq!(details.unwrap()["activeRunId"], "run-2");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn a_refusal_with_no_code_still_names_something() {
        let error = interpret(json!({ "ok": false, "error": { "status": 500 } }))
            .expect_err("a refusal");
        match error {
            BrainBridgeError::Refused { code, status, .. } => {
                assert_eq!(code, "BRAIN_ERROR");
                assert_eq!(status, 500);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn a_passthrough_outcome_travels_in_the_same_envelope() {
        // `desktop-write-source.ts` wraps every passthrough outcome — a refusal
        // or a bypass included — as `ok: true`, and the gateway's
        // `passthrough_ledger` reads the unwrapped value.
        let value = interpret(json!({
            "ok": true,
            "value": { "status": "ledgered", "runId": "gwpt:req-1", "attemptId": "a1" }
        }))
        .expect("an enveloped passthrough outcome");
        assert_eq!(value["status"], "ledgered");
        assert_eq!(value["attemptId"], "a1");

        // A bare outcome is a broken contract. This is the shape that once made
        // every passthrough request read as "brain unavailable".
        let bare = interpret(json!({ "status": "ledgered", "runId": "gwpt:req-1" }));
        assert!(matches!(bare, Err(BrainBridgeError::Unavailable(_))));
    }

    #[test]
    fn an_unrecognised_answer_is_unavailable_rather_than_a_guess() {
        for raw in [json!({ "runId": "run-1" }), json!(null), json!("nope")] {
            let error = interpret(raw).expect_err("not a bridge outcome");
            assert!(matches!(error, BrainBridgeError::Unavailable(_)));
        }
    }
}
