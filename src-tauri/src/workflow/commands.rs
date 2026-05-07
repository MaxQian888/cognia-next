//! Tauri commands exposed to the renderer for the workflow subsystem.
//!
//! Implements the IPC contract documented in
//! `lib/workflow/runtime/tauri-bridge.ts` — five TS→Rust commands plus the
//! Rust→TS `workflow:trigger` event (emitted by the daemon, not a command).

use tauri::State;

use super::run_mirror::MirrorError;
use super::state::WorkflowState;
use super::types::{InFlightRunRow, PersistRunStateInput, RegisterTriggerInput};

fn map_mirror_err(e: MirrorError) -> String {
    e.to_string()
}

/// `workflow_register_trigger` — add or update a trigger entry. The cron
/// daemon (or the eventual webhook router / inbound tap) reads the registry
/// to decide what to fire.
#[tauri::command]
pub async fn workflow_register_trigger(
    state: State<'_, WorkflowState>,
    input: RegisterTriggerInput,
) -> Result<(), String> {
    match input.kind.as_str() {
        "trigger.cron" => {
            let cron = input
                .cron
                .as_deref()
                .ok_or_else(|| "trigger.cron requires a 'cron' field".to_string())?;
            state.cron.upsert(
                input.trigger_id.clone(),
                input.workflow_id.clone(),
                cron,
                input.enabled,
                input.binding.clone(),
            )?;
            Ok(())
        }
        // Webhook + connector + chat-message triggers don't need Rust-side
        // registration in Phase 5a — they ride the existing connectors axum
        // app and the TS hooks already in place. We accept the call as a
        // no-op so the TS bridge can register all triggers uniformly.
        "trigger.webhook"
        | "trigger.connector.inbound"
        | "trigger.chat.message"
        | "trigger.manual" => Ok(()),
        other => Err(format!("workflow_register_trigger: unsupported kind '{other}'")),
    }
}

/// `workflow_unregister_trigger` — remove a trigger by id. Idempotent;
/// missing ids are a no-op.
#[tauri::command]
pub async fn workflow_unregister_trigger(
    state: State<'_, WorkflowState>,
    trigger_id: String,
) -> Result<(), String> {
    state.cron.remove(&trigger_id);
    Ok(())
}

/// `workflow_persist_run_state` — upsert the SQLite mirror. Called from the
/// orchestrator after every step transition.
#[tauri::command]
pub async fn workflow_persist_run_state(
    state: State<'_, WorkflowState>,
    input: PersistRunStateInput,
) -> Result<(), String> {
    state.mirror.persist(&input).map_err(map_mirror_err)
}

/// `workflow_reload_in_flight_runs` — return rows whose status is still
/// `running` / `waiting` / `paused` / `pending`. Called once on app boot;
/// the TS resume controller turns each row into a `workflow:resume` event.
#[tauri::command]
pub async fn workflow_reload_in_flight_runs(
    state: State<'_, WorkflowState>,
) -> Result<Vec<InFlightRunRow>, String> {
    state.mirror.list_in_flight().map_err(map_mirror_err)
}

/// `workflow_ack_completed` — drop a mirror row after a successful run.
#[tauri::command]
pub async fn workflow_ack_completed(
    state: State<'_, WorkflowState>,
    run_id: String,
) -> Result<(), String> {
    state.mirror.ack_completed(&run_id).map_err(map_mirror_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::state::WorkflowState;
    use serde_json::json;

    /// Tauri's `State<'_, T>` is opaque, so the unit tests poke the underlying
    /// mirror + cron through `WorkflowState` directly. The command bodies
    /// themselves are 1-3 lines of pass-through, so the value of each test is
    /// the IPC contract: which inputs succeed / fail and which side effects
    /// they produce in the mirror or daemon.

    #[test]
    fn register_a_cron_trigger_lands_in_the_daemon() {
        let (state, _) = WorkflowState::open_in_memory_for_testing();
        state
            .cron
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "0 0 9 * * 1-5",
                true,
                None,
            )
            .unwrap();
        assert_eq!(state.cron.entry_count(), 1);
    }

    #[test]
    fn register_a_cron_with_invalid_expression_returns_an_error() {
        let (state, _) = WorkflowState::open_in_memory_for_testing();
        let err = state
            .cron
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "completely broken",
                true,
                None,
            )
            .unwrap_err();
        assert!(err.contains("invalid cron"));
        assert_eq!(state.cron.entry_count(), 0);
    }

    #[test]
    fn unregister_is_idempotent_for_unknown_ids() {
        let (state, _) = WorkflowState::open_in_memory_for_testing();
        state.cron.remove("never_registered");
        assert_eq!(state.cron.entry_count(), 0);
    }

    #[test]
    fn persist_then_reload_round_trips() {
        let (state, _) = WorkflowState::open_in_memory_for_testing();
        let input = PersistRunStateInput {
            run_id: "run_a".into(),
            workflow_id: "wf_1".into(),
            status: "running".into(),
            last_step_id: Some("n_a".into()),
            snapshot: Some(json!({"id": "wf_1", "schemaVersion": 1, "name": "x"})),
        };
        state.mirror.persist(&input).unwrap();
        let in_flight = state.mirror.list_in_flight().unwrap();
        assert_eq!(in_flight.len(), 1);
        assert_eq!(in_flight[0].run_id, "run_a");
    }

    #[test]
    fn ack_completed_removes_the_mirror_row() {
        let (state, _) = WorkflowState::open_in_memory_for_testing();
        state
            .mirror
            .persist(&PersistRunStateInput {
                run_id: "run_a".into(),
                workflow_id: "wf_1".into(),
                status: "running".into(),
                last_step_id: None,
                snapshot: Some(json!({"id": "wf_1", "schemaVersion": 1, "name": "x"})),
            })
            .unwrap();
        state.mirror.ack_completed("run_a").unwrap();
        assert_eq!(state.mirror.count().unwrap(), 0);
    }
}
