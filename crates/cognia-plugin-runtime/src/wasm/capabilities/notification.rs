//! `cognia:plugin/notification` host import.

use super::super::errors::{coded, WasmErrorCode};
use super::super::store::HostState;
use super::require;

/// Cap on each of `title` and `body`. An OS notification that long is already
/// unusable; the limit exists so a guest cannot push megabytes through the
/// native surface.
pub const MAX_FIELD_BYTES: usize = 4 * 1024;

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
///
/// The actual surface call is owned by
/// [`NotificationService`](super::super::services::NotificationService) so this
/// module stays trivially testable without Tauri. Neither `title` nor `body` is
/// ever logged — v0.1 wrote both to `log::info!`, and that leak does not come
/// across the cutover.
pub fn prepare(
    state: &HostState,
    title: String,
    body: String,
    kind: NotificationKind,
) -> Result<PendingNotification, String> {
    require(state, "notification")?;
    if title.trim().is_empty() {
        return Err(coded(
            WasmErrorCode::InvalidRequest,
            "notification.notify: title is empty",
        ));
    }
    for (field, value) in [("title", &title), ("body", &body)] {
        if value.len() > MAX_FIELD_BYTES {
            return Err(coded(
                WasmErrorCode::PayloadTooLarge,
                format!(
                    "notification.notify: {field} is {} bytes, over the {MAX_FIELD_BYTES} byte limit",
                    value.len()
                ),
            ));
        }
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
    use super::super::super::store::test_host_state;
    use super::*;

    fn state(caps: &[&str], id: &str) -> HostState {
        test_host_state(id, caps)
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
        assert!(err.starts_with("INVALID_REQUEST: "));
        assert!(err.contains("title is empty"));
    }

    #[test]
    fn prepare_rejects_ungranted_plugin() {
        let st = state(&[], "demo");
        let err = prepare(&st, "Hi".into(), "x".into(), NotificationKind::Info).unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED: "));
        assert!(err.contains("capability `notification` not granted"));
    }

    #[test]
    fn capability_denial_precedes_validation() {
        // A denied plugin must not learn that its title was also blank.
        let st = state(&[], "demo");
        let err = prepare(&st, "".into(), "x".into(), NotificationKind::Info).unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED: "));
    }

    #[test]
    fn prepare_caps_title_and_body() {
        let st = state(&["notification"], "demo");
        let big = "x".repeat(MAX_FIELD_BYTES + 1);

        let title_err = prepare(&st, big.clone(), "ok".into(), NotificationKind::Info).unwrap_err();
        assert!(title_err.starts_with("PAYLOAD_TOO_LARGE: "));
        assert!(title_err.contains("title"));

        let body_err = prepare(&st, "Hi".into(), big, NotificationKind::Info).unwrap_err();
        assert!(body_err.starts_with("PAYLOAD_TOO_LARGE: "));
        assert!(body_err.contains("body"));

        // Exactly at the cap is fine.
        let at_cap = "x".repeat(MAX_FIELD_BYTES);
        assert!(prepare(&st, at_cap.clone(), at_cap, NotificationKind::Info).is_ok());
    }
}
