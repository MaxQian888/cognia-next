//! Per-runtime restart on an always-on host (ADR-0059 W2): the server's half.
//!
//! A headless runtime that failed to start leaves the brain serving everything
//! else, and the brain's pongs name it (`ws_bridge::brain_failed_runtimes`).
//! `host_runtime_list` and `host_runtime_restart` ask the connected brain
//! about its runtimes and to restart one, over the bridge: the server emits
//! [`REQUEST_EVENT`] with a request id, and the brain answers with a
//! [`RESPONSE_COMMAND`] respond frame (`cli/src/serve/runtime-control.ts`),
//! which `ws_bridge::route_respond` hands to [`resolve`].
//!
//! Only a headless host has a brain to ask; the desktop runs its runtimes in
//! the window, where a reload restarts them.

use std::collections::HashMap;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::bridge_transport::BridgeTransport;

pub const REQUEST_EVENT: &str = "companion://runtime-control-request";
pub const RESPONSE_COMMAND: &str = "companion_runtime_control_response";

/// A list is a snapshot the brain holds in memory.
pub const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// A restart waits for one runtime to stop and start again.
pub const RESTART_TIMEOUT: Duration = Duration::from_secs(120);

/// The longest runtime name a request may carry; registered names are short
/// kebab-case words.
const MAX_NAME: usize = 64;

/// What the server asks the brain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeControlAction {
    List,
    Restart(String),
}

impl RuntimeControlAction {
    /// A restart of `name`, refused when it cannot be a runtime's name.
    pub fn restart(name: &str) -> Result<Self, RuntimeControlError> {
        let name = name.trim();
        let valid = !name.is_empty()
            && name.len() <= MAX_NAME
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !valid {
            return Err(RuntimeControlError::new(
                "invalid_argument",
                "a runtime name is lowercase letters, digits and dashes",
            ));
        }
        Ok(Self::Restart(name.to_string()))
    }

    fn timeout(&self) -> Duration {
        match self {
            Self::List => LIST_TIMEOUT,
            Self::Restart(_) => RESTART_TIMEOUT,
        }
    }

    fn payload(&self, request_id: &str) -> Value {
        match self {
            Self::List => json!({ "request_id": request_id, "action": "list" }),
            Self::Restart(name) => {
                json!({ "request_id": request_id, "action": "restart", "name": name })
            }
        }
    }
}

/// Why a request got no usable answer: the brain's own refusal
/// (`runtime_not_found`, `runtime_not_restartable`, `runtimes_stopped`,
/// `invalid_argument`, `runtime_control_failed`), or the server's
/// (`brain_unavailable`, `brain_timeout`, `brain_answer_invalid`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeControlError {
    pub code: String,
    pub message: String,
}

impl RuntimeControlError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

static PENDING: Lazy<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Ask the connected brain. `Ok` carries `runtimes` (every runtime, as the
/// brain holds them) and, for a restart, `runtime` (the one restarted).
pub async fn call_brain(action: RuntimeControlAction) -> Result<Value, RuntimeControlError> {
    let Some(transport) = crate::ws_bridge::socket_bridge_transport() else {
        return Err(RuntimeControlError::new(
            "brain_unavailable",
            "no brain is connected to this host",
        ));
    };
    let timeout = action.timeout();
    request(transport.as_ref(), action, timeout).await
}

/// [`call_brain`] over a given transport, with a given timeout.
pub async fn request(
    transport: &dyn BridgeTransport,
    action: RuntimeControlAction,
    timeout: Duration,
) -> Result<Value, RuntimeControlError> {
    let unavailable = |message: String| RuntimeControlError::new("brain_unavailable", message);
    let mut guard = transport.reserve_request().map_err(unavailable)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    PENDING.lock().insert(request_id.clone(), tx);
    if let Err(error) = transport.emit(REQUEST_EVENT, action.payload(&request_id)) {
        PENDING.lock().remove(&request_id);
        return Err(unavailable(error));
    }
    let outcome = tokio::select! {
        biased;
        _ = guard.disconnected() => None,
        outcome = tokio::time::timeout(timeout, rx) => Some(outcome),
    };
    PENDING.lock().remove(&request_id);
    match outcome {
        None => Err(unavailable("the brain disconnected before it answered".into())),
        Some(Err(_)) => Err(RuntimeControlError::new(
            "brain_timeout",
            format!("the brain did not answer within {}s", timeout.as_secs()),
        )),
        Some(Ok(Err(_))) => Err(unavailable("the brain's answer was dropped".into())),
        Some(Ok(Ok(answer))) => interpret(answer),
    }
}

/// Hand a `companion_runtime_control_response` payload to its waiter.
pub fn resolve(payload: Value) {
    let request_id = payload
        .get("requestId")
        .or_else(|| payload.get("request_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(request_id) = request_id else {
        log::warn!("companion-api runtime control: an answer without a request id");
        return;
    };
    match PENDING.lock().remove(&request_id) {
        Some(waiter) => {
            let _ = waiter.send(payload);
        }
        None => log::debug!("companion-api runtime control: a late answer for {request_id}"),
    }
}

/// The brain's answer as a command result: its refusal as an error, else the
/// runtimes (and the restarted runtime) without the request id.
fn interpret(answer: Value) -> Result<Value, RuntimeControlError> {
    if let Some(error) = answer.get("error").filter(|error| !error.is_null()) {
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("runtime_control_failed");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("the brain refused the request");
        return Err(RuntimeControlError::new(code, message));
    }
    let Some(runtimes) = answer.get("runtimes").filter(|value| value.is_array()) else {
        return Err(RuntimeControlError::new(
            "brain_answer_invalid",
            "the brain answered without a runtime list",
        ));
    };
    let mut result = json!({ "runtimes": runtimes });
    if let Some(runtime) = answer.get("runtime").filter(|value| value.is_object()) {
        result["runtime"] = runtime.clone();
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_companion_bus::bridge_transport::BridgeRequestGuard;

    /// A brain that answers each request the way the test says.
    struct ScriptedBrain {
        answer: Box<dyn Fn(&Value) -> Option<Value> + Send + Sync>,
        sent: Mutex<Vec<(String, Value)>>,
    }

    impl BridgeTransport for ScriptedBrain {
        fn emit(&self, channel: &str, payload: Value) -> Result<(), String> {
            self.sent.lock().push((channel.to_string(), payload.clone()));
            if let Some(answer) = (self.answer)(&payload) {
                // Answer after the emit returns, as a real brain would.
                tokio::spawn(async move {
                    tokio::task::yield_now().await;
                    resolve(answer);
                });
            }
            Ok(())
        }
        fn reserve_request(&self) -> Result<BridgeRequestGuard, String> {
            Ok(BridgeRequestGuard::unscoped())
        }
        fn kind(&self) -> &'static str {
            "socket"
        }
    }

    fn brain(answer: impl Fn(&Value) -> Option<Value> + Send + Sync + 'static) -> ScriptedBrain {
        ScriptedBrain {
            answer: Box::new(answer),
            sent: Mutex::new(Vec::new()),
        }
    }

    fn id(payload: &Value) -> String {
        payload["request_id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn a_restart_is_asked_by_name_and_answered_with_the_runtimes() {
        let brain = brain(|payload| {
            Some(json!({
                "requestId": id(payload),
                "runtime": { "name": "room-runner", "state": "running" },
                "runtimes": [{ "name": "room-runner", "state": "running" }],
            }))
        });
        let result = request(
            &brain,
            RuntimeControlAction::restart(" room-runner ").unwrap(),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(result["runtime"]["name"], "room-runner");
        assert_eq!(result["runtimes"][0]["state"], "running");
        assert!(result.get("requestId").is_none());
        let sent = brain.sent.lock();
        assert_eq!(sent[0].0, REQUEST_EVENT);
        assert_eq!(sent[0].1["action"], "restart");
        assert_eq!(sent[0].1["name"], "room-runner");
        assert!(PENDING.lock().is_empty());
    }

    #[tokio::test]
    async fn the_brains_refusal_keeps_its_code() {
        let brain = brain(|payload| {
            Some(json!({
                "requestId": id(payload),
                "error": { "code": "runtime_not_restartable", "message": "no teardown" },
            }))
        });
        let error = request(
            &brain,
            RuntimeControlAction::restart("initializers").unwrap(),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "runtime_not_restartable");
        assert_eq!(error.message, "no teardown");
    }

    #[tokio::test]
    async fn an_answer_without_runtimes_is_invalid() {
        let brain = brain(|payload| Some(json!({ "requestId": id(payload) })));
        let error = request(&brain, RuntimeControlAction::List, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(error.code, "brain_answer_invalid");
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_brain_times_out_and_leaves_nothing_pending() {
        let brain = brain(|_| None);
        let error = request(&brain, RuntimeControlAction::List, Duration::from_secs(3))
            .await
            .unwrap_err();
        assert_eq!(error.code, "brain_timeout");
        let id = id(&brain.sent.lock()[0].1);
        assert!(!PENDING.lock().contains_key(&id));
        // A late answer is dropped, not delivered to anyone.
        resolve(json!({ "requestId": id, "runtimes": [] }));
    }

    #[test]
    fn a_name_that_cannot_be_a_runtime_is_refused_before_asking() {
        for name in ["", "  ", "Room", "a/b", &"x".repeat(65)] {
            assert_eq!(
                RuntimeControlAction::restart(name).unwrap_err().code,
                "invalid_argument",
                "{name:?}"
            );
        }
        assert_eq!(
            RuntimeControlAction::restart("connector-runtime").unwrap(),
            RuntimeControlAction::Restart("connector-runtime".into())
        );
    }

    #[tokio::test]
    async fn without_a_brain_nothing_is_asked() {
        let _guard = crate::ws_bridge::test_support::lock_slot().await;
        crate::ws_bridge::test_support::clear_socket_for_testing();
        let error = call_brain(RuntimeControlAction::List).await.unwrap_err();
        assert_eq!(error.code, "brain_unavailable");
    }
}
