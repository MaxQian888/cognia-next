//! Durable admission of a paired device's direct chat turn.
//!
//! A paired client sends its turns over `agent_send`, because only that path
//! carries the turn's own options (provider, model, a device-local key). The
//! sidecar used to be the only thing that saw such a turn arrive, so the
//! brain's terminal-event persister, which keeps a reply only for a session
//! with an open work submission, dropped every frame of it.
//!
//! The send arm now asks the brain to admit the turn over the writes bridge
//! (`paired_turn_admit`, `lib/work-submission/paired-turn-adapter.ts`) before
//! the prompt reaches the sidecar, and to seal it (`paired_turn_abandon`) when
//! the handoff fails. This module holds the request and answer shapes; the
//! arm in the app shell owns the async round trip.

use axum::{http::StatusCode, Json};
use serde_json::Value;

use crate::rpc_error::RpcError;

/// Internal bridge command that admits a turn. No device reaches it.
pub const ADMIT: &str = "paired_turn_admit";
/// Internal bridge command that seals an admitted turn the runtime never got.
pub const ABANDON: &str = "paired_turn_abandon";

/// The admission request for a device-originated turn, or `None` when the turn
/// needs none.
///
/// The service scope is the brain itself: its HostState dispatcher already
/// admitted the turn (`lib/work-submission/host-adapter.ts`), and a second
/// submission would split one turn's reply across two rows. A caller with no
/// account scope has no Host account to file work under; such a device cannot
/// use HostState either, so its turns stay as unrecorded as they always were.
///
/// The turn's options are never part of the request: they may carry a key.
pub fn admission_args(
    scope: Option<&str>,
    account_id: Option<&str>,
    session_id: &str,
    prompt: &Value,
    message_id: Option<&str>,
    request_id: &str,
) -> Option<Value> {
    if scope == Some("service") || account_id.is_none() {
        return None;
    }
    let mut args = serde_json::json!({
        "sessionId": session_id,
        "runId": format!("paired:{request_id}"),
        "prompt": prompt,
    });
    if let Some(message_id) = message_id.filter(|id| !id.is_empty()) {
        args["messageId"] = Value::String(message_id.to_string());
    }
    Some(args)
}

/// Read the brain's answer: the submission to seal if the handoff fails,
/// nothing to track, or the Host's refusal as the error the client sees.
pub fn interpret_admission(result: Value) -> Result<Option<String>, (StatusCode, Json<RpcError>)> {
    if result.get("admitted").and_then(Value::as_bool) == Some(true) {
        return result
            .get("submissionId")
            .and_then(Value::as_str)
            .map(|id| Some(id.to_string()))
            .ok_or_else(|| RpcError::internal("paired turn admission named no submission".into()));
    }
    if result.get("untracked").and_then(Value::as_bool) == Some(true) {
        return Ok(None);
    }
    let refusal = result.get("refusal");
    match refusal.and_then(|r| r.get("code")).and_then(Value::as_str) {
        Some(code) => Err((
            StatusCode::CONFLICT,
            Json(RpcError::new(
                code,
                refusal
                    .and_then(|r| r.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("the host refused this turn"),
            )),
        )),
        None => Err(RpcError::internal(
            "paired turn admission answered an unknown shape".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_turn_is_admitted_under_its_request_and_message_ids() {
        let args = admission_args(
            Some("device"),
            Some("tenant-a"),
            "session-1",
            &serde_json::json!("hello"),
            Some("user-message-1"),
            "request-1",
        )
        .expect("a device-originated turn needs admission");
        assert_eq!(
            args,
            serde_json::json!({
                "sessionId": "session-1",
                "runId": "paired:request-1",
                "prompt": "hello",
                "messageId": "user-message-1",
            })
        );
        assert!(args.get("options").is_none());
    }

    #[test]
    fn an_absent_or_empty_message_id_is_left_to_the_host() {
        for message_id in [None, Some("")] {
            let args = admission_args(
                None,
                Some("tenant-a"),
                "session-1",
                &serde_json::json!([{ "type": "text", "text": "hi" }]),
                message_id,
                "request-2",
            )
            .unwrap();
            assert!(args.get("messageId").is_none());
        }
    }

    #[test]
    fn the_brains_own_sends_and_unscoped_callers_are_not_admitted() {
        let prompt = serde_json::json!("hi");
        assert!(
            admission_args(Some("service"), Some("tenant-a"), "s", &prompt, None, "r").is_none()
        );
        assert!(admission_args(None, None, "s", &prompt, None, "r").is_none());
    }

    #[test]
    fn an_admission_answer_names_the_submission_to_seal() {
        assert_eq!(
            interpret_admission(serde_json::json!({
                "admitted": true,
                "submissionId": "work:paired:request-1",
            }))
            .unwrap(),
            Some("work:paired:request-1".to_string())
        );
        assert_eq!(
            interpret_admission(serde_json::json!({ "admitted": false, "untracked": true }))
                .unwrap(),
            None
        );
    }

    #[test]
    fn a_refused_admission_reaches_the_client_as_the_hosts_code() {
        let (status, Json(error)) = interpret_admission(serde_json::json!({
            "admitted": false,
            "refusal": { "code": "session_not_found", "message": "not on this Host" },
        }))
        .unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error.code, "session_not_found");
        assert_eq!(error.message, "not on this Host");
    }

    #[test]
    fn a_malformed_admission_answer_is_an_internal_error() {
        for answer in [
            serde_json::json!({ "admitted": true }),
            serde_json::json!({ "admitted": false }),
            serde_json::json!(null),
        ] {
            let (status, _) = interpret_admission(answer).unwrap_err();
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        }
    }
}
