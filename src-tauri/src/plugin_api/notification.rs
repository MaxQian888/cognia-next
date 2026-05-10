//! Plugin notification Tauri command (Batch 3b).
//!
//! Uses `tauri-plugin-notification` to actually surface a system notification
//! when the OS supports it. The TS-side wrapper at
//! `lib/plugin/core/context.ts:357-367` records a silent failure via
//! `recordSilentFailure` (Tier 1.1) when this rejects.

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use super::{PluginError, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowNotificationArgs {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[tauri::command]
pub async fn plugin_show_notification(app: AppHandle, args: ShowNotificationArgs) -> Result<()> {
    let mut builder = app.notification().builder().title(&args.title);
    if let Some(body) = args.body.as_deref() {
        builder = builder.body(body);
    }
    if let Some(icon) = args.icon.as_deref() {
        builder = builder.icon(icon);
    }
    builder
        .show()
        .map_err(|e| PluginError::Internal(format!("notification failed: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_round_trip_camel_case() {
        let raw = serde_json::json!({"title": "T", "body": "B"});
        let parsed: ShowNotificationArgs = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.title, "T");
        assert_eq!(parsed.body.as_deref(), Some("B"));
        assert!(parsed.icon.is_none());
    }
}
