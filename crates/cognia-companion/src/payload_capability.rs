//! What a command's payload demands on top of its manifest capability
//! (ADR-0196 P5.2).
//!
//! The manifest declares one capability per command. A few commands are two
//! operations wearing one name, and which one was asked for is in the payload:
//! an AI scheduled task needs `process.spawn` where a script task does not, and
//! a control attach needs Remote Control where an observe attach does not.
//! `remote_execution::authorize_capability` checks this next to the manifest
//! capability, so it is part of the core's gate, not the dispatch table's.

use serde_json::Value;

const AGENT_SCHEDULE_TASK_TYPES: &[&str] = &[
    "chat",
    "agent",
    "agent-team",
    "goal",
    "skill",
    "external-agent",
];

fn is_agent_schedule_task_type(task_type: &str) -> bool {
    AGENT_SCHEDULE_TASK_TYPES.contains(&task_type)
}

/// Scheduler commands are payload-sensitive: script/workflow maintenance only
/// needs the ordinary control grant, while reading or mutating an AI task also
/// needs the separate agent-control grant. Missing type hints fail closed.
pub fn scheduled_task_requires_agent_control(name: &str, args: &Value) -> bool {
    if !name.starts_with("scheduled_task_") {
        return false;
    }
    match name {
        "scheduled_task_create" => args
            .get("input")
            .and_then(|input| input.get("type"))
            .and_then(Value::as_str)
            .map(is_agent_schedule_task_type)
            .unwrap_or(true),
        "scheduled_task_list" => args
            .get("filter")
            .and_then(|filter| filter.get("types"))
            .and_then(Value::as_array)
            .map(|types| {
                types
                    .iter()
                    .filter_map(Value::as_str)
                    .any(is_agent_schedule_task_type)
            })
            // An unfiltered list may disclose prompts from an AI task.
            .unwrap_or(true),
        "scheduled_task_statistics" | "scheduled_task_upcoming" | "scheduled_task_export" => true,
        _ => args
            .get("taskType")
            .and_then(Value::as_str)
            .map(is_agent_schedule_task_type)
            .unwrap_or(true),
    }
}

pub fn payload_required_capability(name: &str, args: &Value) -> Option<&'static str> {
    if scheduled_task_requires_agent_control(name, args) {
        return Some("process.spawn");
    }
    if attach_requests_control(name, args) {
        return Some("workspace.write");
    }
    None
}

/// True when `session_attach` is asking for a *control* attachment.
///
/// Attaching is two operations wearing one command name. Observing needs the
/// read capability every paired device already holds — the manifest baseline —
/// while controlling claims the right to be handed this session's approval and
/// elicitation prompts, which is Remote Control (`workspace.write`, the
/// capability `GrantKind::Control` maps onto).
///
/// Declaring the manifest capability as `workspace.write` for both, which is
/// what it used to say, made observe-only attach impossible: a device with read
/// access could not register as a watcher at all, so the plan's read-capability
/// observe mode had no way to exist. Splitting it here keeps ONE command whose
/// authorization follows what it was actually asked to do.
///
/// The absent case must read the way the handler reads it, not the way that is
/// cheapest to authorize: `readAttachMode` in `lib/companion/desktop-write-source.ts`
/// treats anything that is not literally `"observe"` as a control request — the
/// mode every pre-`mode` client was implicitly asking for. Escalating only on a
/// literal `"control"` left the gate and the handler disagreeing about what the
/// same payload means, so a `{ "sessionId": … }` body was authorized as a read
/// and then handled as a control request.
fn attach_requests_control(name: &str, args: &Value) -> bool {
    name == "session_attach" && args.get("mode").and_then(Value::as_str) != Some("observe")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scheduled_task_agent_control_is_payload_sensitive_and_fail_closed() {
        assert!(!scheduled_task_requires_agent_control(
            "scheduled_task_create",
            &json!({ "input": { "type": "workflow" } })
        ));
        assert!(scheduled_task_requires_agent_control(
            "scheduled_task_create",
            &json!({ "input": { "type": "agent" } })
        ));
        assert!(!scheduled_task_requires_agent_control(
            "scheduled_task_delete",
            &json!({ "taskType": "backup" })
        ));
        assert!(scheduled_task_requires_agent_control(
            "scheduled_task_delete",
            &json!({})
        ));
        assert!(scheduled_task_requires_agent_control(
            "scheduled_task_list",
            &json!({})
        ));
        assert!(!scheduled_task_requires_agent_control(
            "scheduled_task_list",
            &json!({ "filter": { "types": ["workflow", "backup"] } })
        ));
    }

    /// Attaching is two operations wearing one command name, and the manifest can
    /// only declare one capability. The baseline is the read capability every
    /// paired device holds; asking for control escalates to Remote Control.
    ///
    /// Before this, `session_attach` declared `workspace.write` outright, so a
    /// read-only device could not register as a watcher at all — which is why the
    /// plan's observe mode had no way to exist.
    #[test]
    fn attaching_escalates_to_remote_control_only_when_control_is_asked_for() {
        let descriptor = crate::command_manifest::descriptor("session_attach").expect("registered");
        assert_eq!(
            descriptor.capability, "host.observe",
            "the baseline must be readable by any paired device, or observe attach cannot exist"
        );
        // Anything that is not a literal `observe` is a control request, because
        // that is exactly how `readAttachMode` in desktop-write-source.ts reads it.
        // A gate that escalated only on a literal `"control"` authorized a
        // mode-less body as a read and then let the handler treat it as control.
        for args in [
            json!({ "mode": "control" }),
            json!({}),
            json!({ "mode": "CONTROL" }),
            json!({ "mode": true }),
        ] {
            assert_eq!(
                payload_required_capability("session_attach", &args),
                Some("workspace.write"),
                "the gate must read the absent/unrecognized mode the way the handler does: {args}"
            );
        }
        assert_eq!(
            payload_required_capability("session_attach", &json!({ "mode": "observe" })),
            None,
            "observing stays at the baseline every paired device holds"
        );
        // Detaching releases the caller's own lease and can never be riskier than
        // holding it, so it stays at the baseline whatever the payload says.
        assert_eq!(
            payload_required_capability("session_detach", &json!({ "mode": "control" })),
            None
        );
    }
}
