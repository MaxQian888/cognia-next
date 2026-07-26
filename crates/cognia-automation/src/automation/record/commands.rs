//! Tauri commands for the skill recorder. Recording reuses the automation
//! worker (screenshot + element pick) but is gated by its own one-shot consent
//! at `record_start` (a global input hook + continuous capture is more invasive
//! than a single action) rather than the per-action `run_gated` pipeline.

use std::path::PathBuf;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use super::session::{
    self, CaptureSettings, RecordStatus, RecordingTrace, DEFAULT_MAX_HEIGHT, DEFAULT_MAX_WIDTH,
};
use crate::automation::commands::{err_to_string, AutomationState};
use crate::automation::permission::{ConsentPrompt, Surface};
use crate::automation::types::AutomationError;

const RECORDER_PLUGIN_ID: &str = "cognia-skill-recorder";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordStartArgs {
    /// Return screenshots as inline base64 (default) so the renderer can attach
    /// them as skill resources. When false, screenshots are written to a temp
    /// dir and referenced by path (self-contained traces, smaller IPC reply).
    pub inline_screenshots: bool,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
}

impl Default for RecordStartArgs {
    fn default() -> Self {
        Self {
            inline_screenshots: true,
            max_width: None,
            max_height: None,
        }
    }
}

#[tauri::command]
pub async fn record_start(
    app: AppHandle,
    state: State<'_, AutomationState>,
    args: Option<RecordStartArgs>,
) -> std::result::Result<RecordStatus, String> {
    let args = args.unwrap_or_default();
    if state.recorder.is_recording() {
        return Err(err_to_string(&AutomationError::BackendError {
            message: "a recording is already in progress".into(),
        }));
    }

    // One-shot, recording-specific consent for the whole session. The renderer
    // ConsentOverlay (mounted in app/layout.tsx) renders the prompt; the user
    // responds via `automation_consent_respond`.
    let prompt = ConsentPrompt {
        command: "record_start".into(),
        surface: Surface::ComputerUse,
        plugin_id: Some(RECORDER_PLUGIN_ID.into()),
        process_name: None,
        window_title: None,
        command_detail: Some("Record desktop actions to generate a skill".into()),
        // Recording consent is a one-shot for the whole capture session and is
        // never persisted as a grant, so it carries no chat session tag.
        session_key: None,
    };
    let consent_timeout = state.gate.settings().consent_timeout_ms();
    if !state
        .consent
        .request(app.clone(), prompt, consent_timeout)
        .await
    {
        return Err(err_to_string(&AutomationError::UserDeclined));
    }

    let session_id = new_session_id();
    let temp_dir: Option<PathBuf> = if args.inline_screenshots {
        None
    } else {
        app.path()
            .app_cache_dir()
            .ok()
            .map(|d| d.join("cognia").join("record").join(&session_id))
    };
    let settings = CaptureSettings {
        redact: state.gate.settings().redact_screenshots,
        max_width: args.max_width.unwrap_or(DEFAULT_MAX_WIDTH),
        max_height: args.max_height.unwrap_or(DEFAULT_MAX_HEIGHT),
        inline: args.inline_screenshots,
    };

    match state.recorder.start(
        app.clone(),
        state.handle.clone(),
        settings,
        session_id,
        temp_dir,
    ) {
        Ok(status) => Ok(status),
        Err(e) => {
            session::emit_record_error(&app, e.clone());
            Err(err_to_string(&AutomationError::BackendError { message: e }))
        }
    }
}

#[tauri::command]
pub async fn record_stop(
    app: AppHandle,
    state: State<'_, AutomationState>,
) -> std::result::Result<RecordingTrace, String> {
    state.recorder.stop(&app).ok_or_else(|| {
        err_to_string(&AutomationError::BackendError {
            message: "no recording in progress".into(),
        })
    })
}

#[tauri::command]
pub async fn record_status(
    state: State<'_, AutomationState>,
) -> std::result::Result<RecordStatus, String> {
    Ok(state.recorder.status())
}

#[tauri::command]
pub async fn record_cancel(
    app: AppHandle,
    state: State<'_, AutomationState>,
) -> std::result::Result<(), String> {
    state.recorder.cancel(&app);
    Ok(())
}

fn new_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_start_args_default_is_inline() {
        let args = RecordStartArgs::default();
        assert!(args.inline_screenshots);
        assert!(args.max_width.is_none());
    }

    #[test]
    fn record_start_args_deserializes_partial() {
        // Omitted fields fall back to the inline default (struct-level serde
        // default), so a renderer that only sends maxWidth still works.
        let args: RecordStartArgs = serde_json::from_str(r#"{"maxWidth":1024}"#).unwrap();
        assert!(args.inline_screenshots);
        assert_eq!(args.max_width, Some(1024));
    }

    #[test]
    fn new_session_id_is_unique() {
        assert_ne!(new_session_id(), new_session_id());
    }

    #[test]
    fn new_session_id_returns_uuid_v4() {
        let id = new_session_id();
        let parsed = uuid::Uuid::parse_str(&id).expect("record session id should be a UUID");
        assert_eq!(parsed.get_version_num(), 4);
    }
}
