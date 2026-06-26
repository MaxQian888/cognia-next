//! `cognia:plugin/notification` host import.

use super::super::store::HostState;
use super::require;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingNotification {
    pub plugin_id: String,
    pub title: String,
    pub body: String,
    pub kind: NotificationKind,
}

/// Validate the capability and produce the host-facing notification payload.
/// The actual surface call (Tauri `app_handle.notification().builder()...`)
/// is owned by `host.rs::dispatch_notification` so this module stays
/// trivially testable without Tauri.
pub fn prepare(
    state: &HostState,
    title: String,
    body: String,
    kind: NotificationKind,
) -> Result<PendingNotification, String> {
    require(state, "notification")?;
    if title.trim().is_empty() {
        return Err("notification title is empty".into());
    }
    Ok(PendingNotification {
        plugin_id: state.plugin_id.clone(),
        title,
        body,
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::super::super::store::CapabilitySet;
    use super::*;
    use wasmtime_wasi::{ResourceTable, WasiCtxBuilder};

    fn state(caps: &[&str], id: &str) -> HostState {
        HostState {
            plugin_id: id.into(),
            capabilities: CapabilitySet::from_iter(caps.iter().map(|s| (*s).to_string())),
            shell_allowlist: Vec::new(),
            call_timeout_ms: 30_000,
            limits: wasmtime::StoreLimitsBuilder::new().build(),
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
        }
    }

    #[test]
    fn prepare_allows_granted_plugin() {
        let st = state(&["notification"], "demo");
        let out = prepare(&st, "Hi".into(), "world".into(), NotificationKind::Info).unwrap();
        assert_eq!(out.plugin_id, "demo");
        assert_eq!(out.title, "Hi");
        assert_eq!(out.kind, NotificationKind::Info);
    }

    #[test]
    fn prepare_rejects_blank_title() {
        let st = state(&["notification"], "demo");
        let err = prepare(&st, "   ".into(), "ok".into(), NotificationKind::Info).unwrap_err();
        assert!(err.contains("title is empty"));
    }

    #[test]
    fn prepare_rejects_ungranted_plugin() {
        let st = state(&[], "demo");
        let err = prepare(&st, "Hi".into(), "x".into(), NotificationKind::Info).unwrap_err();
        assert!(err.contains("capability `notification` not granted"));
    }
}
