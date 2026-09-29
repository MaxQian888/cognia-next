//! The gateway's link to the brain (ADR-0188 D9, B2).
//!
//! `/v1/runs` is served here, but the gateway owns none of the state a run
//! needs: Dexie is authoritative and lives in the brain — the desktop renderer
//! or the headless Node process. Every Run API request therefore crosses this
//! bridge, which is one round trip carrying a command name and a JSON payload,
//! and comes back with the brain's own answer.
//!
//! Two consequences the endpoints depend on:
//!
//! - **The brain can be away.** A closed window, a restarting headless process
//!   or a bridge that times out is `Unavailable`, which the Run API reports as
//!   `503 BRAIN_UNAVAILABLE`. It is never answered from a stale cache: a run's
//!   money and status are only true where they are written.
//! - **The brain's refusals are the API's refusals.** A budget refusal, a
//!   missing scope or an unknown run comes back as `Refused` with the brain's
//!   own status and code, and is passed through unchanged rather than being
//!   re-interpreted here.

use std::future::Future;
use std::pin::Pin;
#[cfg(any(test, feature = "test-support"))]
use std::sync::Arc;

#[cfg(any(test, feature = "test-support"))]
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Commands the Run API sends over the bridge. The brain dispatches them in
/// `lib/companion/desktop-write-source.ts`; a name with no arm there is a wiring
/// bug, not a runtime condition.
pub mod command {
    pub const RUN_CREATE: &str = "router_fusion_run_create";
    pub const RUN_GET: &str = "router_fusion_run_get";
    pub const RUN_EVENTS: &str = "router_fusion_run_events";
    pub const RUN_CANCEL: &str = "router_fusion_run_cancel";
    pub const RUN_RESUME: &str = "router_fusion_run_resume";
    pub const RUN_FEEDBACK: &str = "router_fusion_run_feedback";
    pub const SESSION_GET: &str = "router_fusion_session_get";
    pub const ARTIFACT_GET: &str = "router_fusion_artifact_get";
    pub const ARTIFACT_READ: &str = "router_fusion_artifact_read";
    /// `POST /v1/chat/completions` for a `cognia/*` virtual model (B3).
    pub const CHAT_CREATE: &str = "router_fusion_chat_create";
    pub const CHAT_RESULT: &str = "router_fusion_chat_result";

    /// Every Run API command, in the order the brain lists them in
    /// `ROUTER_FUSION_BRIDGE_COMMANDS` (`lib/router-fusion/gate/run-api-bridge.ts`).
    pub const ALL: [&str; 11] = [
        RUN_CREATE,
        RUN_GET,
        RUN_EVENTS,
        RUN_CANCEL,
        RUN_RESUME,
        RUN_FEEDBACK,
        SESSION_GET,
        ARTIFACT_GET,
        ARTIFACT_READ,
        CHAT_CREATE,
        CHAT_RESULT,
    ];
}

/// What went wrong on the way to, or inside, the brain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrainBridgeError {
    /// No brain answered: no window is open, or the bridge timed out.
    Unavailable(String),
    /// The brain answered, and its answer is a refusal the caller must see.
    Refused {
        status: u16,
        code: String,
        message: String,
        details: Option<Value>,
    },
}

impl BrainBridgeError {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self::Unavailable(reason.into())
    }
}

/// The refusal shape the brain sends back, mirroring `RunApiError` in
/// `lib/router-fusion/api/run-api.ts`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BrainRefusal {
    pub status: u16,
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub details: Option<Value>,
}

pub type BrainFuture = Pin<Box<dyn Future<Output = Result<Value, BrainBridgeError>> + Send>>;

/// The tagged outcome the brain answers every bridged command with:
/// `{ ok: true, value }` or `{ ok: false, error: { status, code, … } }`.
///
/// `lib/router-fusion/gate/run-api-bridge.ts` answers the Run API in it, and
/// `lib/companion/desktop-write-source.ts` wraps every passthrough outcome in
/// it too, so one reader serves every transport that carries these commands —
/// the desktop's WebView and the headless brain's `/internal/bridge` socket.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum BridgeOutcome {
    Ok { ok: bool, value: Value },
    Err { ok: bool, error: BridgeErrorBody },
}

#[derive(Debug, Deserialize)]
struct BridgeErrorBody {
    #[serde(default = "default_refusal_status")]
    status: u16,
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    details: Option<Value>,
}

fn default_refusal_status() -> u16 {
    500
}

/// Turn what the brain sent into what the gateway's routes expect.
///
/// The brain answers with a tagged outcome rather than by throwing, because
/// the gateway needs the status and the code to answer its caller with. Any
/// other shape is a broken contract, not a refusal: the caller is told the
/// brain is unavailable rather than being handed a guess.
pub fn interpret_envelope(raw: Value) -> Result<Value, BrainBridgeError> {
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
            "the brain answered a bridged command with an unrecognised shape: {raw}"
        ))),
    }
}

/// One round trip to the brain. Implemented once, over the companion writes
/// bridge, by `cognia_companion::gateway_brain::WritesBrainBridge` — the
/// desktop resolves its route through the app handle, `cognia-server` through
/// the connected brain's `/internal/bridge` socket — and by
/// `RecordingBrainBridge` in tests (a test double, compiled only for tests and
/// the `test-support` feature).
pub trait BrainBridge: Send + Sync {
    fn call(&self, command: &'static str, payload: Value) -> BrainFuture;
}

/// A bridge with no brain behind it: every call is unavailable. This is what a
/// gateway started before the renderer attached uses, so `/v1/runs` answers 503
/// instead of pretending.
#[derive(Debug, Default, Clone)]
pub struct DetachedBrainBridge;

impl BrainBridge for DetachedBrainBridge {
    fn call(&self, _command: &'static str, _payload: Value) -> BrainFuture {
        Box::pin(async {
            Err(BrainBridgeError::unavailable(
                "no Cognia window or headless brain is attached",
            ))
        })
    }
}

#[cfg(any(test, feature = "test-support"))]
type ScriptedAnswer = Result<Value, BrainBridgeError>;

/// A bridge that records what it was asked and answers from a script. The
/// gateway's own tests drive `/v1/runs` end to end through it, so the routes,
/// the scope checks and the SSE stream are exercised without a renderer.
///
/// A test double, not a bridge: it is compiled only into this crate's tests
/// and, for another crate's tests, behind the `test-support` feature, which
/// only a `[dev-dependencies]` entry may enable. A production build has no way
/// to install a scripted brain.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Default)]
pub struct RecordingBrainBridge {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    answers: Arc<Mutex<Vec<(String, ScriptedAnswer)>>>,
}

#[cfg(any(test, feature = "test-support"))]
impl RecordingBrainBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue an answer for one command. Answers are consumed in the order they
    /// were pushed, per command.
    pub fn answer(&self, command: &str, answer: ScriptedAnswer) -> &Self {
        self.answers.lock().push((command.to_string(), answer));
        self
    }

    pub fn ok(&self, command: &str, value: Value) -> &Self {
        self.answer(command, Ok(value))
    }

    pub fn refuse(&self, command: &str, status: u16, code: &str) -> &Self {
        self.answer(
            command,
            Err(BrainBridgeError::Refused {
                status,
                code: code.to_string(),
                message: code.to_string(),
                details: None,
            }),
        )
    }

    /// Every call made so far, as `(command, payload)` in order.
    pub fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().clone()
    }

    pub fn payloads_for(&self, command: &str) -> Vec<Value> {
        self.calls
            .lock()
            .iter()
            .filter(|(name, _)| name == command)
            .map(|(_, payload)| payload.clone())
            .collect()
    }
}

#[cfg(any(test, feature = "test-support"))]
impl BrainBridge for RecordingBrainBridge {
    fn call(&self, command: &'static str, payload: Value) -> BrainFuture {
        self.calls.lock().push((command.to_string(), payload));
        let mut answers = self.answers.lock();
        let index = answers.iter().position(|(name, _)| name == command);
        let answer = match index {
            Some(position) => answers.remove(position).1,
            // An unscripted command is a test that did not say what the brain
            // does; failing loudly beats inventing an answer.
            None => Err(BrainBridgeError::unavailable(format!(
                "no scripted answer for {command}"
            ))),
        };
        Box::pin(async move { answer })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The brain's dispatcher answers exactly the commands this crate sends. A
    /// constant added on one side only is a request the other side refuses as
    /// unknown, which would surface as a 503 in production rather than here.
    #[test]
    fn every_command_is_one_the_brain_dispatches_and_none_is_missing() {
        let source = include_str!("../../../lib/router-fusion/gate/run-api-bridge.ts");
        let start = source
            .find("ROUTER_FUSION_BRIDGE_COMMANDS = [")
            .expect("the brain lists its commands");
        let end = start + source[start..].find("] as const").expect("the list ends");
        let listed: Vec<&str> = source[start..end]
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"'))
            .filter_map(|line| line.split('"').next())
            .collect();
        assert_eq!(listed, command::ALL.to_vec());
    }

    #[test]
    fn a_successful_outcome_unwraps_to_its_value() {
        let value = interpret_envelope(json!({ "ok": true, "value": { "runId": "run-1" } }))
            .expect("a successful outcome");
        assert_eq!(value["runId"], "run-1");
    }

    #[test]
    fn a_refusal_keeps_the_brains_own_status_and_code() {
        let error = interpret_envelope(json!({
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
        let error = interpret_envelope(json!({ "ok": false, "error": { "status": 500 } }))
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
        // or a bypass included — as `ok: true`, and `passthrough_ledger` reads
        // the unwrapped value.
        let value = interpret_envelope(json!({
            "ok": true,
            "value": { "status": "ledgered", "runId": "gwpt:req-1", "attemptId": "a1" }
        }))
        .expect("an enveloped passthrough outcome");
        assert_eq!(value["status"], "ledgered");
        assert_eq!(value["attemptId"], "a1");

        // A bare outcome is a broken contract. This is the shape that once made
        // every passthrough request read as "brain unavailable".
        let bare = interpret_envelope(json!({ "status": "ledgered", "runId": "gwpt:req-1" }));
        assert!(matches!(bare, Err(BrainBridgeError::Unavailable(_))));
    }

    #[test]
    fn an_unrecognised_answer_is_unavailable_rather_than_a_guess() {
        for raw in [
            json!({ "runId": "run-1" }),
            json!(null),
            json!("nope"),
            // The tag contradicts the payload: neither shape, so no guess.
            json!({ "ok": false, "value": {} }),
            json!({ "ok": true, "error": { "status": 409 } }),
        ] {
            let error = interpret_envelope(raw).expect_err("not a bridge outcome");
            assert!(matches!(error, BrainBridgeError::Unavailable(_)));
        }
    }

    #[tokio::test]
    async fn a_detached_bridge_is_unavailable_rather_than_empty() {
        let bridge = DetachedBrainBridge;
        let error = bridge
            .call(command::RUN_GET, json!({}))
            .await
            .expect_err("a detached bridge has no brain to answer");
        assert!(matches!(error, BrainBridgeError::Unavailable(_)));
    }

    #[tokio::test]
    async fn the_recording_bridge_answers_in_order_and_keeps_what_it_was_asked() {
        let bridge = RecordingBrainBridge::new();
        bridge.ok(command::RUN_GET, json!({ "runId": "run-1" }));
        bridge.refuse(command::RUN_GET, 404, "RUN_NOT_FOUND");

        let first = bridge
            .call(command::RUN_GET, json!({ "runId": "run-1" }))
            .await
            .expect("the first scripted answer");
        assert_eq!(first["runId"], "run-1");

        let second = bridge
            .call(command::RUN_GET, json!({ "runId": "run-2" }))
            .await
            .expect_err("the second scripted answer refuses");
        assert!(matches!(
            second,
            BrainBridgeError::Refused { status: 404, .. }
        ));

        assert_eq!(
            bridge.payloads_for(command::RUN_GET),
            vec![json!({ "runId": "run-1" }), json!({ "runId": "run-2" })]
        );
        assert_eq!(bridge.calls().len(), 2);
    }

    /// The scripted brain is a test double. Its declaration and both of its
    /// impls carry the test gate, so a production build of this crate has no
    /// type that can answer the Run API from a script.
    #[test]
    fn the_scripted_brain_is_compiled_only_for_tests() {
        const GATE: &str = "#[cfg(any(test, feature = \"test-support\"))]";
        let source = include_str!("brain_bridge.rs");
        let lines: Vec<&str> = source.lines().collect();
        for declaration in [
            "pub struct RecordingBrainBridge {",
            "impl RecordingBrainBridge {",
            "impl BrainBridge for RecordingBrainBridge {",
            "type ScriptedAnswer = Result<Value, BrainBridgeError>;",
        ] {
            let at = lines
                .iter()
                .position(|line| *line == declaration)
                .unwrap_or_else(|| panic!("{declaration} is declared"));
            let attributes: Vec<&str> = lines[..at]
                .iter()
                .rev()
                .take_while(|line| line.starts_with("#[") || line.starts_with("///"))
                .copied()
                .collect();
            assert!(attributes.contains(&GATE), "{declaration} is not gated");
        }
    }

    /// `test-support` is declared, and every crate that depends on this one
    /// enables it only from `[dev-dependencies]`.
    #[test]
    fn test_support_is_enabled_only_by_dev_dependencies() {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let own = std::fs::read_to_string(manifest_dir.join("Cargo.toml")).unwrap();
        assert!(own.lines().any(|line| line.trim() == "test-support = []"));

        let root = manifest_dir.join("../..");
        let mut manifests = vec![root.join("src-tauri/Cargo.toml")];
        for dir in ["crates", "services"] {
            let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
                continue;
            };
            for entry in entries.flatten() {
                let manifest = entry.path().join("Cargo.toml");
                if manifest.is_file() && entry.path() != manifest_dir {
                    manifests.push(manifest);
                }
            }
        }
        for manifest in manifests {
            let Ok(text) = std::fs::read_to_string(&manifest) else {
                continue;
            };
            let mut section = String::new();
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('[') {
                    section = trimmed.to_string();
                    continue;
                }
                if trimmed.starts_with("cognia-gateway") && trimmed.contains("test-support") {
                    assert!(
                        section.ends_with("dev-dependencies]"),
                        "{} enables cognia-gateway/test-support under {section}",
                        manifest.display()
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn an_unscripted_command_fails_rather_than_inventing_an_answer() {
        let bridge = RecordingBrainBridge::new();
        let error = bridge
            .call(command::RUN_CREATE, json!({}))
            .await
            .expect_err("nothing was scripted");
        match error {
            BrainBridgeError::Unavailable(reason) => {
                assert!(reason.contains(command::RUN_CREATE))
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
