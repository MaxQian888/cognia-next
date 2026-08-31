//! The one emergency-stop path.
//!
//! Before this module the sequence was hand-rolled at three call sites and only
//! one of them was complete:
//!
//! | trigger | engaged | persisted | cleared grants | released the display | stopped the recorder | emitted |
//! |---|---|---|---|---|---|---|
//! | Settings button (`automation_kill_switch`) | yes | yes | yes | yes | yes | **no** |
//! | global shortcut (`Ctrl+Alt+K`) | yes | **no** | yes | **no** | **no** | yes |
//! | tray menu | yes | **no** | **no** | **no** | **no** | yes |
//!
//! Which meant the answer to "what does the kill switch do?" depended on which
//! one the user reached for — the opposite of what an emergency stop is for.
//! [`engage`] is now that answer, and all three call it.
//!
//! Ordering is deliberate: engage first, so a concurrent call is already denied
//! by `PermissionGate::evaluate` while the rest unwinds; then release
//! resources; then notify.

use serde::Serialize;
use tauri::Emitter;

use super::commands::AutomationState;
use super::record::journal::InterruptReason;
use super::virtual_display::ReleaseReason;

/// Event name the renderer already listens on
/// (`computer-use-kill-switch-initializer.tsx`). Unchanged, so existing
/// listeners keep working; only the payload gains structure.
pub const KILL_SWITCH_EVENT: &str = "automation:kill-switch";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum KillSwitchCause {
    /// The Settings card, the app menu, or the title-bar Tools menu — every
    /// path that routes through the `automation_kill_switch` command.
    Renderer,
    /// The global `Ctrl+Alt+K` hotkey.
    Shortcut,
    /// The tray menu item.
    Tray,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KillSwitchEvent {
    pub cause: KillSwitchCause,
    pub at: i64,
    /// Present when a recording was interrupted. The journal is preserved and
    /// the bundle stays recoverable under this id — which is what makes hitting
    /// the switch a safe reflex rather than a decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted_recording_id: Option<String>,
}

/// Engage the emergency stop and tear down everything it owns.
///
/// Generic over the Tauri runtime so the tray and shortcut dispatchers — both
/// of which are themselves generic — can call it without an `AppHandle`
/// concretization. That works because `RecorderState::interrupt_blocking` needs
/// no `AppHandle` of its own (it emits through the sink captured at session
/// start).
pub fn engage<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AutomationState,
    cause: KillSwitchCause,
) -> KillSwitchEvent {
    // 1. Deny everything, immediately. Any call already inside the gate fails
    //    from here on.
    state.gate.engage_kill_switch();
    // 2. Persist `enabled == false` so a reload — or any later bulk save —
    //    reflects the stopped state instead of a stale `enabled: true`.
    super::persist::save_settings(&state.gate.settings());
    // 3. Drop all trust: engaging the switch must clear "always allow this
    //    session" grants, not merely freeze the engine.
    state.consent.clear_session_grants();
    // 4. Hand the screen back — a screen-off virtual display is restored to the
    //    prior topology.
    state
        .virtual_display
        .force_release(ReleaseReason::KillSwitch);
    // 5. Detach the recorder's global input hook and screen capture. The
    //    journal is stamped `Interrupted`, never deleted.
    let interrupted_recording_id = state
        .recorder
        .interrupt_blocking(InterruptReason::KillSwitch)
        .map(|id| id.as_str().to_string());
    // 6. Forget every remembered frame. Whatever runs after a kill switch
    //    starts from a screen it has not seen, so the first `get_app_state`
    //    must carry a real image rather than "unchanged since revision N".
    state.screenshot_dedup.clear();
    // 7. Forget the driving-call history too. The next run must not inherit
    //    the budget the stopped run burned, or an emergency stop would leave
    //    the rate limiter refusing the operator's own first retry.
    state.gate.reset_rate();

    let event = KillSwitchEvent {
        cause,
        at: super::commands::now_ms(),
        interrupted_recording_id,
    };
    // 8. One event, one payload, whichever trigger fired.
    let _ = app.emit(KILL_SWITCH_EVENT, &event);
    event
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kill_switch_event_serializes_camel_case() {
        let json = serde_json::to_string(&KillSwitchEvent {
            cause: KillSwitchCause::Shortcut,
            at: 12,
            interrupted_recording_id: Some("0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01".into()),
        })
        .unwrap();
        assert!(json.contains("\"cause\":\"shortcut\""));
        assert!(json.contains("\"at\":12"));
        assert!(json.contains("\"interruptedRecordingId\""));
    }

    #[test]
    fn absent_recording_is_omitted_from_the_payload() {
        let json = serde_json::to_string(&KillSwitchEvent {
            cause: KillSwitchCause::Tray,
            at: 1,
            interrupted_recording_id: None,
        })
        .unwrap();
        assert!(!json.contains("interruptedRecordingId"));
    }

    #[test]
    fn every_cause_round_trips_to_a_distinct_tag() {
        let tags: Vec<String> = [
            KillSwitchCause::Renderer,
            KillSwitchCause::Shortcut,
            KillSwitchCause::Tray,
        ]
        .iter()
        .map(|c| serde_json::to_string(c).unwrap())
        .collect();
        assert_eq!(tags, vec!["\"renderer\"", "\"shortcut\"", "\"tray\""]);
    }

    #[test]
    fn event_name_is_the_one_the_renderer_listens_on() {
        // `components/providers/initializers/computer-use-kill-switch-initializer.tsx`
        // keys on this exact string.
        assert_eq!(KILL_SWITCH_EVENT, "automation:kill-switch");
    }

    // `engage` itself needs a live `AppHandle` and managed `AutomationState`, so
    // it is covered by the desktop smoke procedure rather than a unit test —
    // the same limitation the code it replaces always had.
}
