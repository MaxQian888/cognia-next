//! The Fleet commands that need nothing from the desktop beyond the runtime:
//! snapshots, managed-session projection, the OpenCode outbox, island
//! approvals and answers, and stopping the monitor. Starting it needs the
//! companion listener, so `fleet_monitor_start` / `_restore` / `_status` stay
//! in the desktop and call [`crate::start_monitor`] / [`crate::monitor_status`].

use std::sync::atomic::Ordering;

use crate::{
    install, outbox, registry, runtime, FleetMonitorStatus, FleetSnapshot, PermissionBehavior,
};

/// Disable fleet monitoring. Removes the monitor config file so installed
/// hook scripts fast-exit (they no-op when the file is missing); the
/// companion server is left as-is (other features may be using it).
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn fleet_monitor_stop() -> Result<FleetMonitorStatus, String> {
    let runtime = runtime();
    runtime.enabled.store(false, Ordering::SeqCst);
    *runtime.token.write() = None;
    runtime.clear_pending_controls();
    if runtime.registry.lock().mark_all_detached() {
        runtime.persist_recovery();
        runtime.emit_update();
    }
    install::remove_monitor_config().map_err(|e| e.to_string())?;
    Ok(FleetMonitorStatus {
        enabled: false,
        port: None,
        config_path: None,
    })
}

/// Full snapshot for island mount (before the first `fleet://update`).
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn fleet_get_snapshot() -> Result<FleetSnapshot, String> {
    // The first call builds the runtime, which reads its recovery state from
    // disk; that happens during startup, so it stays off the async workers.
    tokio::task::spawn_blocking(|| runtime().snapshot())
        .await
        .map_err(|error| format!("fleet snapshot task failed: {error}"))
}

/// Brain-side disposable projection of a durable AgentTeam child. The child
/// row and ExecutionRun journal remain authoritative.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn fleet_project_managed_session(
    input: registry::ManagedFleetSession,
) -> Result<(), String> {
    runtime().project_managed_session(input);
    Ok(())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn fleet_remove_managed_session(session_id: String) -> Result<bool, String> {
    Ok(runtime().remove_managed_session(&session_id))
}

/// Island → queue a prompt for an OpenCode session (the plugin executes it via
/// its bound `client.session.promptAsync`). Returns the command id.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn fleet_opencode_send_message(
    session_id: String,
    text: String,
) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("message is empty".to_string());
    }
    let runtime = runtime();
    if !runtime
        .session_capabilities(registry::FleetAgent::Opencode, &session_id)
        .is_some_and(|capabilities| capabilities.send_message)
    {
        return Err("opencode-send-message-unavailable".to_string());
    }
    runtime
        .queue_opencode_command(session_id, trimmed.to_string())
        .await
}

/// Diagnose the durable OpenCode reverse-command channel. A corrupt store is
/// reported rather than silently replaced, because doing so would lose queued
/// controls without an audit trail.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn fleet_opencode_outbox_status() -> Result<outbox::OutboxStatus, String> {
    runtime().opencode_outbox_status().await
}

/// Explicitly quarantine a corrupt/unavailable outbox and create a clean one.
/// This is intentionally separate from status/startup so recovery can never
/// destroy durable commands without a deliberate operator action.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn fleet_opencode_outbox_repair() -> Result<outbox::OutboxStatus, String> {
    runtime().repair_opencode_outbox().await
}

/// Island Approve/Deny → resolves the parked hook long-poll.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn fleet_permission_respond(
    request_id: String,
    behavior: PermissionBehavior,
) -> Result<bool, String> {
    Ok(runtime().respond_permission(&request_id, behavior))
}

/// Island question answer → resolves the parked AskUserQuestion long-poll.
/// `selections[i]` carries the option indices the user picked for question `i`
/// (one for single-select, one or more for multi-select). Returns false when
/// the answer window already lapsed (the island shows "answered in terminal").
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn fleet_question_respond(
    request_id: String,
    selections: Vec<Vec<u32>>,
) -> Result<bool, String> {
    Ok(runtime().respond_question(&request_id, selections))
}

/// Island question rejection → resolves the parked native question gate.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn fleet_question_reject(request_id: String) -> Result<bool, String> {
    Ok(runtime().reject_question(&request_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_empty_opencode_message_is_refused_before_the_queue() {
        let error = fleet_opencode_send_message("any-session".into(), "  \n ".into())
            .await
            .unwrap_err();
        assert_eq!(error, "message is empty");
    }

    #[tokio::test]
    async fn a_message_to_a_session_that_cannot_take_one_is_refused() {
        let error = fleet_opencode_send_message("no-such-opencode-session".into(), "hi".into())
            .await
            .unwrap_err();
        assert_eq!(error, "opencode-send-message-unavailable");
    }

    #[tokio::test]
    async fn answers_without_a_parked_request_report_false() {
        let request = "commands-test-no-such-request".to_string();
        assert!(
            !fleet_permission_respond(request.clone(), PermissionBehavior::Allow)
                .await
                .unwrap()
        );
        assert!(!fleet_question_respond(request.clone(), vec![vec![0]])
            .await
            .unwrap());
        assert!(!fleet_question_reject(request).await.unwrap());
    }

    #[tokio::test]
    async fn removing_an_unknown_managed_session_reports_false() {
        assert!(
            !fleet_remove_managed_session("commands-test-no-such-session".into())
                .await
                .unwrap()
        );
    }
}
