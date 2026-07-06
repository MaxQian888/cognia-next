//! A2A turn accumulator.
//!
//! One [`A2aTurn`] drives a single `message/send` turn: it feeds each
//! `claude://message` EventBus frame through the *shared* ACP frame translator
//! ([`super::super::acp::translate::translate_frame`]) and folds the resulting
//! [`AcpOutbound`] actions into A2A terms — accumulate agent text, decline any
//! permission prompt (fail-closed; this surface is non-interactive), and detect
//! turn termination. The final [`build_task`](Self::final_task) snapshot is
//! what `message/send` returns.
//!
//! Interactive tool approval over A2A (the `input-required` round-trip) and
//! streaming (`message/stream`) are deliberately out of scope for this MVP;
//! the Agent Card advertises `streaming:false` accordingly.

use serde_json::Value;

use super::super::acp::translate::{translate_frame, AcpOutbound};
use super::super::acp::types::SessionUpdate;
use super::wire::{self, TaskState};
use super::super::acp::translate::TurnState;

/// Terminal result of an A2A turn.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnOutcome {
    Completed,
    Failed(String),
}

/// The side-effects of applying one translated action.
#[derive(Debug, Default, PartialEq)]
pub struct A2aStep {
    /// A permission request id that must be declined via `claude_approve`
    /// (fail-closed — this surface offers no interactive approval).
    pub deny_permission: Option<String>,
    /// Set once the turn reaches a terminal state.
    pub outcome: Option<TurnOutcome>,
}

/// Accumulates one A2A turn.
#[derive(Debug, Default)]
pub struct A2aTurn {
    /// Shared per-turn dedup state owned by the ACP translator.
    acp: TurnState,
    /// Accumulated agent-visible text across the turn.
    text: String,
}

impl A2aTurn {
    pub fn new() -> Self {
        Self::default()
    }

    /// Accumulated text so far (exposed for tests).
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Translate one EventBus frame payload for `session_id` into ACP actions,
    /// using the shared translator + this turn's dedup state.
    pub fn translate(&mut self, session_id: &str, payload: &Value) -> Vec<AcpOutbound> {
        translate_frame(session_id, payload, &mut self.acp)
    }

    /// Fold one translated action into the turn, returning its side-effects.
    pub fn apply(&mut self, action: AcpOutbound) -> A2aStep {
        let mut step = A2aStep::default();
        match action {
            AcpOutbound::Update(SessionUpdate::AgentMessageChunk { content }) => {
                if let Some(text) = content.get("text").and_then(Value::as_str) {
                    self.text.push_str(text);
                }
            }
            // Thoughts, tool-call visibility, and plans are not projected into
            // the A2A text artifact (they belong to a streaming surface).
            AcpOutbound::Update(_) => {}
            AcpOutbound::PermissionRequest { request_id, .. } => {
                step.deny_permission = Some(request_id);
            }
            AcpOutbound::TurnEnded(_) => {
                step.outcome = Some(TurnOutcome::Completed);
            }
            AcpOutbound::TurnFailed(message) => {
                step.outcome = Some(TurnOutcome::Failed(message));
            }
            AcpOutbound::SdkSessionId(_) => {}
        }
        step
    }

    /// Build the final `Task` snapshot for this turn.
    pub fn final_task(&self, task_id: &str, context_id: &str, outcome: &TurnOutcome) -> Value {
        match outcome {
            TurnOutcome::Completed => {
                let artifacts = if self.text.is_empty() {
                    Vec::new()
                } else {
                    vec![wire::text_artifact("response", "response", &self.text)]
                };
                let status_message = wire::agent_message(context_id, task_id, &self.text);
                wire::build_task(
                    task_id,
                    context_id,
                    TaskState::Completed,
                    artifacts,
                    Some(status_message),
                )
            }
            TurnOutcome::Failed(message) => {
                let status_message = wire::agent_message(context_id, task_id, message);
                wire::build_task(
                    task_id,
                    context_id,
                    TaskState::Failed,
                    Vec::new(),
                    Some(status_message),
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event_frame(session_id: &str, event: Value) -> Value {
        json!({ "type": "event", "sessionId": session_id, "event": event })
    }

    fn text_delta(session_id: &str, text: &str) -> Value {
        event_frame(
            session_id,
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": text },
                },
            }),
        )
    }

    #[test]
    fn accumulates_text_and_completes() {
        let mut turn = A2aTurn::new();
        for chunk in ["Hel", "lo ", "world"] {
            for action in turn.translate("s1", &text_delta("s1", chunk)) {
                assert!(turn.apply(action).outcome.is_none());
            }
        }
        assert_eq!(turn.text(), "Hello world");

        let result = event_frame("s1", json!({ "type": "result", "subtype": "success" }));
        let mut outcome = None;
        for action in turn.translate("s1", &result) {
            if let Some(o) = turn.apply(action).outcome {
                outcome = Some(o);
            }
        }
        assert_eq!(outcome, Some(TurnOutcome::Completed));

        let task = turn.final_task("t1", "s1", &outcome.unwrap());
        assert_eq!(task["status"]["state"], "completed");
        assert_eq!(task["artifacts"][0]["parts"][0]["text"], "Hello world");
        assert_eq!(task["status"]["message"]["parts"][0]["text"], "Hello world");
    }

    #[test]
    fn empty_completion_has_no_artifacts() {
        let turn = A2aTurn::new();
        let task = turn.final_task("t1", "s1", &TurnOutcome::Completed);
        assert_eq!(task["status"]["state"], "completed");
        assert_eq!(task["artifacts"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn permission_request_is_denied_fail_closed() {
        let mut turn = A2aTurn::new();
        let payload = json!({
            "type": "permission_request",
            "sessionId": "s1",
            "requestId": "req-9",
            "toolName": "Bash",
            "input": { "command": "rm -rf /" },
        });
        let actions = turn.translate("s1", &payload);
        let step = turn.apply(actions.into_iter().next().unwrap());
        assert_eq!(step.deny_permission.as_deref(), Some("req-9"));
        assert!(step.outcome.is_none());
    }

    #[test]
    fn turn_failure_maps_to_failed_task() {
        let mut turn = A2aTurn::new();
        let payload = event_frame(
            "s1",
            json!({ "type": "result", "subtype": "error", "is_error": true, "result": "boom" }),
        );
        let mut outcome = None;
        for action in turn.translate("s1", &payload) {
            if let Some(o) = turn.apply(action).outcome {
                outcome = Some(o);
            }
        }
        assert_eq!(outcome, Some(TurnOutcome::Failed("boom".into())));
        let task = turn.final_task("t1", "s1", &outcome.unwrap());
        assert_eq!(task["status"]["state"], "failed");
        assert_eq!(task["status"]["message"]["parts"][0]["text"], "boom");
    }

    #[test]
    fn frames_for_other_sessions_are_ignored() {
        let mut turn = A2aTurn::new();
        let actions = turn.translate("mine", &text_delta("other", "nope"));
        assert!(actions.is_empty());
        assert_eq!(turn.text(), "");
    }
}
