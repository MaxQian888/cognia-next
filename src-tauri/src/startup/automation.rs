//! Boot steps for Computer Use (ADR-0020): the automation state, the
//! plugin-facts seam the sandbox gate reads, and the OCR backends the skill
//! recorder waits on.

use tauri::{App, Manager};

/// ADR-0020 W1 — automation subsystem. We construct the worker thread with an
/// `AppHandle` so it can emit `automation:worker-restart` /
/// `automation:worker-dead` events when the backend panics. Built here
/// (instead of `.manage({...})`) because the handle is only available after
/// `App` is built.
pub(crate) fn automation_state(app: &App) {
    let app_handle = app.handle().clone();
    // The closure captures `app_handle` by clone on each invocation so the
    // worker thread (which may rebuild the backend several times after a
    // panic) can keep emitting `automation:backend-init-failed` if reinit
    // fails too.
    let app_handle_for_builder = app_handle.clone();
    let app_handle_for_vdd = app_handle.clone();
    let worker = crate::automation::Worker::spawn_with_app(Some(app_handle), move || {
        crate::automation::make_default_backend_with_app(Some(app_handle_for_builder.clone()))
    });
    // ADR-0020 — hydrate the gate + policy from disk so a configured tier /
    // whitelist / per-action policy survives a restart (previously this
    // booted to `default()`, silently dropping every persisted setting on
    // every launch).
    let gate = crate::automation::PermissionGate::new(crate::automation::persist::load_settings());
    let audit = crate::automation::AuditRing::new();
    let consent = crate::automation::ConsentBroker::new();
    let policy = crate::automation::persist::load_policy_state();
    // Screen-off Computer Use (ADR-0020 follow-up). Dedicated thread owns the
    // bundled parsec-vdd device + 100ms keep-alive ping; the audit ring + app
    // handle let it emit `automation:event` rows on virtual-display enter /
    // release.
    let virtual_display = crate::automation::VirtualDisplayController::spawn(
        crate::automation::virtual_display::build_driver,
        Some(audit.clone()),
        Some(app_handle_for_vdd),
    );
    // ADR-0020 remote-target — registry of running cua desktop sandboxes.
    // Shared (Arc-backed clone) between the managed state the `cua_sandbox_*`
    // lifecycle commands read and the `AutomationState` the `cua_route`
    // dispatch layer reads, so both see the same running containers.
    // Live UI-event delivery (trigger.desktop.event): watcher threads forward
    // focus-changed events through this sink to `automation:uia-event`, which
    // the TS workflow fan-out (`lib/workflow/runtime/desktop-event-trigger.ts`)
    // consumes.
    crate::automation::events::wire_uia_event_sink(app.handle().clone());
    let cua_registry = crate::cua_sandbox::CuaSandboxRegistry::default();
    app.manage(cua_registry.clone());
    app.manage(crate::automation::commands::AutomationState::new(
        worker,
        gate,
        audit,
        consent,
        policy,
        virtual_display,
        cua_registry,
    ));
}

/// The automation layer's plugin-facts seam, wired synchronously:
/// `sandbox_exec`'s permission gate reads it on the first sandboxed tool call
/// of a turn, and its default fails closed as "plugin not installed". The
/// recorder's own registration in [`ocr_and_recorder`] sits behind an awaited
/// OCR probe, which is far too late for that caller.
pub(crate) fn plugin_facts(app: &App) {
    crate::recorder_window::adapters::register_plugin_facts(app.handle());
}

/// ADR-0024 — install the OCR native backends. Each enabled Cargo feature
/// (`ocr-tesseract`, `ocr-windows`, `ocr-apple`) contributes its backend;
/// absent features land a placeholder that reports `MissingBinding` so the
/// frontend can fall back.
pub(crate) fn ocr_and_recorder(app: &App) {
    let ocr_state = app.state::<crate::ocr::NativeOcrRegistry>().inner().clone();
    let recorder_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        crate::ocr::install_default_backends(&ocr_state).await;
        // ADR-0106 — the skill recorder's seams, registered AFTER the OCR
        // backends so `available_ids` reflects the real set. Without this the
        // recorder's preflight reports the plugin as not installed and refuses
        // to record: the defaults fail closed on purpose, so a missed wiring
        // is loud.
        crate::recorder_window::adapters::register(&recorder_handle).await;
    });
}

#[cfg(test)]
mod tests {
    use crate::startup::step_position;

    /// Both later steps read `AutomationState`, which only
    /// [`super::automation_state`] manages; `app.state` panics on a type that
    /// is not managed yet.
    #[test]
    fn the_automation_state_is_managed_before_anything_reads_it() {
        assert!(step_position("automation_state") < step_position("plugin_facts"));
        assert!(step_position("automation_state") < step_position("ocr_and_recorder"));
    }

    /// `sandbox_exec`'s permission gate reads the plugin-facts seam on the
    /// first sandboxed tool call; the recorder's registration waits on an OCR
    /// probe, which is far too late for it.
    #[test]
    fn plugin_facts_are_wired_before_the_ocr_probe() {
        assert!(step_position("plugin_facts") < step_position("ocr_and_recorder"));
    }
}
