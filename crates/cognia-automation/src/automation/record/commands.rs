//! Tauri commands for the skill recorder.
//!
//! `record_start` is the only privileged one: it arms a global input hook and
//! continuous screen capture, so it faces the full automation gate. Everything
//! after it — pause, undo, stop, reading a bundle back — operates on a session
//! the user has already authorized and needs no further approval.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::assets::{self, AssetId, AssetMeta, AssetPayload, RecordingId};
use super::events::EventSink;
use super::journal::{self, InterruptReason, RecordingBundle, RecoverableBundle};
use super::limits::{RecordLimits, StorageHeadroom};
use super::plugin_facts::missing_grants;
use super::preflight;
use super::scope::CaptureScope;
use super::session::{
    self, CaptureSettings, RecordStatus, StartConfig, DEFAULT_MAX_HEIGHT, DEFAULT_MAX_WIDTH,
};
use crate::automation::audit::{AuditEntry, Decision as AuditDecision};
use crate::automation::commands::{
    emit_audit, err_to_string, now_ms, record_deny, AutomationState,
};
use crate::automation::dispatcher::{self, GateContext};
use crate::automation::permission::{Surface, TargetMeta};
use crate::automation::platform::shared::input_monitoring::{input_monitoring_state, ProbeState};
use crate::automation::session::AppLocator;
use crate::automation::types::{AutomationError, Platform};

pub const RECORDER_PLUGIN_ID: &str = "cognia-skill-recorder";

fn backend_err(message: impl Into<String>) -> String {
    err_to_string(&AutomationError::BackendError {
        message: message.into(),
    })
}

/// Resolve the recordings root, or report that this platform has nowhere
/// durable to put a bundle.
fn root() -> Result<std::path::PathBuf, String> {
    assets::recordings_root()
        .ok_or_else(|| backend_err("no application data directory is available"))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordStartArgs {
    /// Caller-supplied so the renderer can create its Dexie row and the native
    /// bundle under one identity, and reattach after a crash without a lookup
    /// table. Must be a canonical UUID — it names a directory.
    pub recording_id: String,
    pub scope: CaptureScope,
    #[serde(default = "default_true")]
    pub capture_screenshots: bool,
    /// May only tighten the defaults; `RecordLimits::clamped` enforces that.
    #[serde(default)]
    pub limits: Option<RecordLimits>,
    #[serde(default)]
    pub max_width: Option<u32>,
    #[serde(default)]
    pub max_height: Option<u32>,
}

fn default_true() -> bool {
    true
}

/// Collect everything the setup screen needs to explain a blocker.
#[tauri::command]
pub async fn record_preflight(
    state: State<'_, AutomationState>,
) -> Result<preflight::RecordPreflight, String> {
    let limits = RecordLimits::default();
    let root = assets::recordings_root();
    let storage = root
        .as_deref()
        .map(|r| super::limits::storage_headroom(r, limits))
        .unwrap_or(StorageHeadroom {
            used_bytes: 0,
            global_limit_bytes: limits.max_global_bytes,
            bundle_limit_bytes: limits.max_bundle_bytes,
            free_disk_bytes: None,
        });
    let open_bundles = root
        .as_deref()
        .map(|r| journal::scan_recoverable(r).len() as u32)
        .unwrap_or(0);

    let facts = state.plugin_facts().facts(RECORDER_PLUGIN_ID);
    let missing = missing_grants(&facts);
    let ocr_backends = state
        .recorder
        .region_ocr()
        .map(|o| o.backend_ids())
        .unwrap_or_default();

    let report = preflight::RecordPreflight {
        ready: false,
        blockers: Vec::new(),
        platform: current_platform(),
        platform_supported: platform_supported(),
        plugin_installed: facts.installed,
        plugin_enabled: facts.enabled,
        granted: facts.granted.clone(),
        missing_grants: missing.clone(),
        automation_enabled: state.gate.settings().enabled,
        kill_switch_engaged: state.gate.kill_switch_engaged(),
        already_recording: state.recorder.is_recording(),
        accessibility: accessibility_state(),
        input_monitoring: input_monitoring_state(),
        screen_recording: screen_recording_state(),
        ui_automation: ui_automation_state(&state).await,
        ocr_available: !ocr_backends.is_empty(),
        ocr_backends,
        storage,
        open_bundles,
    };
    let admission = preflight::AdmissionFacts {
        kill_switch: report.kill_switch_engaged,
        automation_enabled: report.automation_enabled,
        platform_supported: report.platform_supported,
        plugin_installed: report.plugin_installed,
        plugin_enabled: report.plugin_enabled,
        missing_grants: missing,
        already_recording: report.already_recording,
        storage_exhausted: report.storage.is_exhausted(),
    };
    Ok(preflight::finalize(report, &admission))
}

fn current_platform() -> Platform {
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
    #[cfg(target_os = "macos")]
    {
        Platform::Macos
    }
    #[cfg(target_os = "linux")]
    {
        Platform::Linux
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Platform::Unsupported
    }
}

/// Recording is macOS + Windows only. Linux, the browser build and mobile are
/// blocked with a localized explanation rather than degraded silently.
fn platform_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

fn accessibility_state() -> ProbeState {
    #[cfg(target_os = "macos")]
    {
        if crate::automation::platform::ax::accessibility_trusted() {
            ProbeState::Ok
        } else {
            ProbeState::Missing
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        ProbeState::NotApplicable
    }
}

fn screen_recording_state() -> ProbeState {
    #[cfg(target_os = "macos")]
    {
        if crate::automation::platform::shared::screen_capture::screen_capture_permitted() {
            ProbeState::Ok
        } else {
            ProbeState::Missing
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // No equivalent gate; `screen_capture_permitted` returns true off macOS,
        // so reporting `Ok` would claim a grant that does not exist.
        ProbeState::NotApplicable
    }
}

/// Windows UI Automation readiness. Derived from the live backend's declared
/// capabilities rather than probed separately — `UiaBackend::new()` failing at
/// boot is exactly what `has_uia: false` means.
async fn ui_automation_state(state: &AutomationState) -> ProbeState {
    #[cfg(target_os = "windows")]
    {
        match state.handle.capabilities().await {
            Ok(caps) if caps.has_uia => ProbeState::Ok,
            Ok(_) => ProbeState::Missing,
            Err(_) => ProbeState::Unknown,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        ProbeState::NotApplicable
    }
}

#[tauri::command]
pub async fn record_start(
    app: AppHandle,
    state: State<'_, AutomationState>,
    args: RecordStartArgs,
) -> Result<RecordStatus, String> {
    let recording_id = RecordingId::parse(&args.recording_id)
        .map_err(|_| backend_err("the recording id must be a canonical UUID"))?;
    let root = root()?;

    // Admission runs BEFORE the gate, and therefore before any consent prompt
    // can be raised. The gate re-checks the kill switch and the master disable
    // itself; this adds the recorder-specific blockers (plugin disabled, a
    // missing manifest grant, no disk headroom) to the same "never prompt for
    // something that cannot proceed" rule.
    let facts = state.plugin_facts().facts(RECORDER_PLUGIN_ID);
    let admission = preflight::AdmissionFacts {
        kill_switch: state.gate.kill_switch_engaged(),
        automation_enabled: state.gate.settings().enabled,
        platform_supported: platform_supported(),
        plugin_installed: facts.installed,
        plugin_enabled: facts.enabled,
        missing_grants: missing_grants(&facts),
        already_recording: state.recorder.is_recording(),
        storage_exhausted: super::limits::storage_headroom(&root, RecordLimits::default())
            .is_exhausted(),
    };
    if let Err(err) = preflight::admission_check(&admission) {
        let entry = record_deny(
            &state.audit,
            "record_start",
            Surface::ComputerUse,
            Some(RECORDER_PLUGIN_ID),
            &TargetMeta::default(),
            &err,
            std::time::Instant::now(),
        );
        emit_audit(&app, &entry);
        return Err(err_to_string(&err));
    }

    let binding = super::scope::ScopeBinding::resolve(args.scope.clone(), None)
        .map_err(|e| backend_err(e.to_string()))?;

    let sink = EventSink::tauri(app.clone());
    let settings = CaptureSettings {
        redact: state.gate.settings().redact_screenshots,
        max_width: args.max_width.unwrap_or(DEFAULT_MAX_WIDTH),
        max_height: args.max_height.unwrap_or(DEFAULT_MAX_HEIGHT),
        capture_screenshots: args.capture_screenshots,
    };

    // Gate the *transition*, not the session.
    //
    // `run_gated` is built for one-shot actions: it audits `do_call`'s
    // completion, and a recording session outlives the call. But the thing that
    // needs authorizing genuinely is one-shot — "armed a recording" completes in
    // milliseconds. Teardown needs no authorization and records its own paired
    // audit row (`audit_session_end`), so the Diagnostics tab shows a matched
    // start/stop pair rather than an unexplained one-sided row.
    //
    // This replaces a hand-rolled `consent.request` that bypassed the pipeline
    // entirely. Going through it buys three things the bypass could not:
    // the kill switch and the master disable now reject *before* any prompt is
    // raised (`PermissionGate::evaluate` checks both first); the T5 per-action
    // policy applies; and the call lands in the audit ring either way.
    let scope_summary = args.scope.summary();
    let gctx = GateContext {
        surface: Surface::ComputerUse,
        plugin_id: Some(RECORDER_PLUGIN_ID.into()),
        // Derived from the scope, which is what makes the operator's whitelist
        // actually apply to the recording target. The bypassed path passed
        // `None` for both and so skipped the whitelist check entirely.
        process_name: scope_process_name(&args.scope),
        window_title: scope_window_title(&args.scope),
        target_url: None,
        click_x: None,
        click_y: None,
        force_tier: None,
        command_detail: Some(format!("Record desktop actions: {scope_summary}")),
        // Deliberately no chat-session tag: `ConsentPrompt::is_one_shot` makes
        // this prompt ungrantable, so there is no grant for a key to scope.
        session_key: None,
    };

    let start_sink = sink.clone();
    let inner: &AutomationState = &state;
    dispatcher::run_gated(
        Some(&app),
        inner,
        gctx,
        "record_start",
        move || async move {
            inner
                .recorder
                .start(StartConfig {
                    recording_id,
                    root,
                    handle: inner.handle.clone(),
                    input_monitor: inner.input_monitor.clone(),
                    sink: start_sink,
                    scope: binding,
                    limits: args.limits.unwrap_or_default(),
                    settings,
                    secure_probe: inner.recorder.secure_probe(),
                    ocr: inner.recorder.region_ocr(),
                    app_version: env!("CARGO_PKG_VERSION").to_string(),
                })
                .map_err(|message| AutomationError::BackendError { message })
        },
    )
    .await
    .inspect_err(|e| session::emit_record_error(&sink, e.to_string()))
    .map_err(|e| err_to_string(&e))
}

/// Whitelist-facing process name for a scope. `None` for whole-desktop, which
/// has no single target — the whitelist gate skips when there is nothing to
/// match, and `forces_per_call` guarantees a prompt regardless.
fn scope_process_name(scope: &CaptureScope) -> Option<String> {
    match scope {
        CaptureScope::Window { app_name, .. } => Some(app_name.clone()),
        CaptureScope::Application { locator } => match locator {
            AppLocator::DisplayName { display_name } => Some(display_name.clone()),
            AppLocator::BundleId { bundle_id } => bundle_id.rsplit('.').next().map(str::to_string),
            AppLocator::Path { path } => path.rsplit(['/', '\\']).next().map(|f| {
                f.trim_end_matches(".app")
                    .trim_end_matches(".exe")
                    .to_string()
            }),
        },
        CaptureScope::Desktop => None,
    }
}

fn scope_window_title(scope: &CaptureScope) -> Option<String> {
    match scope {
        CaptureScope::Window { title, .. } => title.clone(),
        _ => None,
    }
}

/// Record the paired teardown row for a session the gate authorized.
///
/// Without it the audit ring shows a `record_start` consent with no matching
/// end, which reads like a recording that never stopped.
///
/// The row is deliberately untargeted and its reason carries only a scope
/// *kind* and a count — the recorder's telemetry rule is that no window title,
/// app name or captured content ever reaches a log.
fn audit_session_end(
    app: &AppHandle,
    state: &AutomationState,
    command: &str,
    reason: String,
    started_at: i64,
) {
    let entry = state.audit.record(AuditEntry {
        id: String::new(),
        ts: now_ms(),
        surface: Surface::ComputerUse,
        plugin_id: Some(RECORDER_PLUGIN_ID.to_string()),
        command: command.to_string(),
        process_name: None,
        window_title: None,
        decision: AuditDecision::Allow,
        reason: Some(reason),
        duration_ms: now_ms().saturating_sub(started_at).max(0) as u64,
        error: None,
    });
    emit_audit(app, &entry);
}

#[tauri::command]
pub async fn record_pause(state: State<'_, AutomationState>) -> Result<RecordStatus, String> {
    state.recorder.pause().await.map_err(backend_err)
}

#[tauri::command]
pub async fn record_resume(state: State<'_, AutomationState>) -> Result<RecordStatus, String> {
    state.recorder.resume().await.map_err(backend_err)
}

#[tauri::command]
pub async fn record_undo_last(state: State<'_, AutomationState>) -> Result<RecordStatus, String> {
    state.recorder.undo_last().await.map_err(backend_err)
}

#[tauri::command]
pub async fn record_stop(
    app: AppHandle,
    state: State<'_, AutomationState>,
) -> Result<RecordingBundle, String> {
    let started_at = state.recorder.status().started_at.unwrap_or_else(now_ms);
    let bundle = state.recorder.stop().await.map_err(backend_err)?;
    audit_session_end(
        &app,
        &state,
        "record_stop",
        format!(
            "{} scope; {} steps",
            bundle.manifest.scope.kind_label(),
            bundle.steps.len()
        ),
        started_at,
    );
    Ok(bundle)
}

/// End a recording without discarding it. The bundle stays on disk and shows up
/// in `record_list_recoverable`.
#[tauri::command]
pub async fn record_interrupt(
    app: AppHandle,
    state: State<'_, AutomationState>,
) -> Result<(), String> {
    let status = state.recorder.status();
    let started_at = status.started_at.unwrap_or_else(now_ms);
    let scope_kind = status
        .scope
        .as_ref()
        .map(|s| s.kind_label())
        .unwrap_or("none");
    let step_count = status.step_count;
    state
        .recorder
        .interrupt(InterruptReason::UserInterrupt)
        .await;
    audit_session_end(
        &app,
        &state,
        "record_interrupt",
        format!("{scope_kind} scope; {step_count} steps"),
        started_at,
    );
    Ok(())
}

#[tauri::command]
pub async fn record_status(state: State<'_, AutomationState>) -> Result<RecordStatus, String> {
    Ok(state.recorder.status())
}

#[tauri::command]
pub async fn record_list_recoverable() -> Result<Vec<RecoverableBundle>, String> {
    Ok(journal::scan_recoverable(&root()?))
}

/// One pickable target for the setup screen's window / application scope.
///
/// Carries exactly the identity fields `CaptureScope::Window` needs plus the
/// label the picker shows — the renderer must not have to synthesize a scope out
/// of a kind alone, which is how "window scope" silently became "no scope".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    pub window_id: u32,
    pub process_id: u32,
    pub app_name: String,
    pub title: String,
    /// True for the window that currently has focus — the picker preselects it.
    pub focused: bool,
    pub minimized: bool,
}

/// Project the live window list into pickable targets.
///
/// Pure so the two rules that matter can be asserted directly:
///
/// - **Our own windows are never offered.** Recording Cognia with Cognia would
///   put the recorder's own review UI — every frame it has already captured —
///   back into the next bundle.
/// - **Focused first, then stable.** The picker preselects the focused window,
///   and the rest are ordered by app then title so the list does not reshuffle
///   between two refreshes of the same desktop.
pub fn capture_targets_from(
    windows: &[super::scope::WindowSnapshot],
    self_pid: u32,
) -> Vec<CaptureTarget> {
    let mut targets: Vec<CaptureTarget> = windows
        .iter()
        .filter(|w| w.pid != self_pid)
        .filter(|w| !w.app_name.trim().is_empty())
        .map(|w| CaptureTarget {
            window_id: w.id,
            process_id: w.pid,
            app_name: w.app_name.clone(),
            title: w.title.clone(),
            focused: w.focused,
            minimized: w.minimized,
        })
        .collect();
    targets.sort_by(|a, b| {
        b.focused
            .cmp(&a.focused)
            .then_with(|| a.app_name.to_lowercase().cmp(&b.app_name.to_lowercase()))
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.window_id.cmp(&b.window_id))
    });
    targets
}

/// Enumerate what the user can scope a recording to.
///
/// Needs no gate: it returns window titles the user can already see on their own
/// screen, and it arms nothing. `record_start` remains the privileged call.
#[tauri::command]
pub async fn record_list_capture_targets() -> Result<Vec<CaptureTarget>, String> {
    Ok(capture_targets_from(
        &super::scope::snapshot_windows(),
        std::process::id(),
    ))
}

#[tauri::command]
pub async fn record_load_bundle(recording_id: String) -> Result<RecordingBundle, String> {
    let id = RecordingId::parse(&recording_id)
        .map_err(|_| backend_err("the recording id must be a canonical UUID"))?;
    journal::load_bundle(&root()?, &id).map_err(|e| backend_err(e.to_string()))
}

/// Read one frame back as base64.
///
/// `AssetMeta` is not taken from the caller — it is looked up in the journal, so
/// a renderer cannot influence how the bytes are interpreted, and an id that is
/// not part of this bundle simply is not found.
#[tauri::command]
pub async fn record_read_asset(
    recording_id: String,
    asset_id: String,
) -> Result<AssetPayload, String> {
    let id = RecordingId::parse(&recording_id)
        .map_err(|_| backend_err("the recording id must be a canonical UUID"))?;
    let asset = AssetId::parse(&asset_id)
        .map_err(|_| backend_err("the asset id must be a canonical UUID"))?;
    let root = root()?;
    let bundle = journal::load_bundle(&root, &id).map_err(|e| backend_err(e.to_string()))?;
    let meta: AssetMeta = bundle
        .steps
        .iter()
        .find(|s| s.asset_id.as_ref() == Some(&asset))
        .and_then(|s| s.asset_meta)
        .ok_or_else(|| backend_err("no such frame in this recording"))?;
    assets::read_asset(&root, &id, &asset, meta).map_err(|e| backend_err(e.to_string()))
}

#[tauri::command]
pub async fn record_delete_bundle(recording_id: String) -> Result<(), String> {
    let id = RecordingId::parse(&recording_id)
        .map_err(|_| backend_err("the recording id must be a canonical UUID"))?;
    assets::delete_bundle(&root()?, &id).map_err(|e| backend_err(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::record::scope::WindowSnapshot;
    use crate::automation::session::AppLocator;
    use crate::automation::types::Rect;

    fn snap(id: u32, pid: u32, app: &str, title: &str, focused: bool) -> WindowSnapshot {
        WindowSnapshot {
            id,
            pid,
            app_name: app.into(),
            title: title.into(),
            rect: Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
            minimized: false,
            focused,
            z: 0,
        }
    }

    #[test]
    fn capture_targets_exclude_our_own_windows() {
        let windows = [
            snap(1, 42, "Cognia", "Skill recorder", false),
            snap(2, 7, "Safari", "Invoices", false),
        ];
        let targets = capture_targets_from(&windows, 42);
        assert_eq!(targets.len(), 1, "recording ourselves is never offered");
        assert_eq!(targets[0].app_name, "Safari");
        assert_eq!(targets[0].window_id, 2);
        assert_eq!(targets[0].process_id, 7);
    }

    #[test]
    fn capture_targets_put_the_focused_window_first() {
        let windows = [
            snap(1, 7, "Safari", "Invoices", false),
            snap(2, 8, "Zed", "main.rs", true),
        ];
        let targets = capture_targets_from(&windows, 42);
        assert!(targets[0].focused);
        assert_eq!(targets[0].app_name, "Zed");
    }

    #[test]
    fn capture_targets_order_is_stable_for_the_same_desktop() {
        // Same windows, enumerated in a different order, must project to the
        // same list — a picker that reshuffles under the cursor is unusable.
        let a = [
            snap(3, 9, "notes", "b", false),
            snap(1, 7, "Safari", "Invoices", false),
            snap(2, 8, "Notes", "a", false),
        ];
        let b = [
            snap(2, 8, "Notes", "a", false),
            snap(3, 9, "notes", "b", false),
            snap(1, 7, "Safari", "Invoices", false),
        ];
        let ids = |w: &[WindowSnapshot]| {
            capture_targets_from(w, 42)
                .into_iter()
                .map(|t| t.window_id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&a), ids(&b));
        assert_eq!(
            ids(&a),
            vec![2, 3, 1],
            "case-insensitive app name, then title"
        );
    }

    #[test]
    fn capture_targets_drop_nameless_windows() {
        // An empty app name gives the user nothing to recognise and cannot be
        // matched by an `AppLocator` afterwards.
        let windows = [snap(1, 7, "   ", "", false)];
        assert!(capture_targets_from(&windows, 42).is_empty());
    }

    #[test]
    fn capture_target_serializes_camel_case_for_the_scope_fields() {
        // The renderer builds a `CaptureScope::Window` straight out of this, so
        // the field names have to line up with the scope's own wire format.
        let json = serde_json::to_value(
            &capture_targets_from(&[snap(5, 6, "Safari", "Invoices", true)], 42)[0],
        )
        .unwrap();
        assert_eq!(json["windowId"], 5);
        assert_eq!(json["processId"], 6);
        assert_eq!(json["appName"], "Safari");
        assert_eq!(json["title"], "Invoices");
        assert_eq!(json["focused"], true);
    }

    fn args_json(extra: &str) -> String {
        format!(
            r#"{{"recordingId":"0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01","scope":{{"kind":"desktop"}}{extra}}}"#
        )
    }

    #[test]
    fn record_start_args_requires_a_recording_id() {
        let err = serde_json::from_str::<RecordStartArgs>(r#"{"scope":{"kind":"desktop"}}"#);
        assert!(err.is_err(), "an id-less start must not deserialize");
    }

    #[test]
    fn record_start_args_requires_a_scope() {
        let err = serde_json::from_str::<RecordStartArgs>(
            r#"{"recordingId":"0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"}"#,
        );
        assert!(
            err.is_err(),
            "scope is not optional — there is no safe default"
        );
    }

    #[test]
    fn record_start_args_rejects_unknown_fields() {
        // `deny_unknown_fields` is what stops a stale renderer from silently
        // getting different behaviour than it asked for.
        let err =
            serde_json::from_str::<RecordStartArgs>(&args_json(r#","inlineScreenshots":true"#));
        assert!(err.is_err());
    }

    #[test]
    fn record_start_args_defaults_capture_screenshots_true() {
        let args: RecordStartArgs = serde_json::from_str(&args_json("")).unwrap();
        assert!(args.capture_screenshots);
        assert!(args.limits.is_none());
        assert!(args.max_width.is_none());
    }

    #[test]
    fn record_start_args_deserializes_window_scope() {
        let args: RecordStartArgs = serde_json::from_str(
            r#"{"recordingId":"0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01",
                "scope":{"kind":"window","windowId":7,"processId":8,"appName":"Safari","title":"Invoices"},
                "captureScreenshots":false}"#,
        )
        .unwrap();
        assert!(!args.capture_screenshots);
        match args.scope {
            CaptureScope::Window {
                window_id,
                process_id,
                app_name,
                title,
            } => {
                assert_eq!((window_id, process_id), (7, 8));
                assert_eq!(app_name, "Safari");
                assert_eq!(title.as_deref(), Some("Invoices"));
            }
            other => panic!("expected a window scope, got {other:?}"),
        }
    }

    #[test]
    fn record_start_args_deserializes_application_scope() {
        let args: RecordStartArgs = serde_json::from_str(
            r#"{"recordingId":"0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01",
                "scope":{"kind":"application","locator":{"kind":"bundleId","bundleId":"com.apple.Safari"}}}"#,
        )
        .unwrap();
        assert!(matches!(
            args.scope,
            CaptureScope::Application {
                locator: AppLocator::BundleId { .. }
            }
        ));
    }

    #[test]
    fn record_start_args_rejects_a_non_uuid_recording_id() {
        let args: RecordStartArgs = serde_json::from_str(
            r#"{"recordingId":"../../etc/passwd","scope":{"kind":"desktop"}}"#,
        )
        .unwrap();
        // Deserialization keeps it as a string; the parse at the command
        // boundary is what refuses it, before any path is built.
        assert!(RecordingId::parse(&args.recording_id).is_err());
    }

    #[test]
    fn record_start_args_limits_are_clamped_to_the_defaults() {
        let args: RecordStartArgs = serde_json::from_str(&args_json(
            r#","limits":{"maxDurationMs":999999999,"maxSteps":99999,"maxBundleBytes":999999999999,"maxGlobalBytes":999999999999}"#,
        ))
        .unwrap();
        assert_eq!(
            args.limits.unwrap().clamped(),
            RecordLimits::default(),
            "a renderer must not be able to raise a native cap"
        );
    }

    #[test]
    fn recorder_plugin_id_matches_the_manifest() {
        // `plugins/skill-recorder/plugin.json` owns the permission grants that
        // preflight checks; the id has to agree on both sides.
        assert_eq!(RECORDER_PLUGIN_ID, "cognia-skill-recorder");
    }
}
