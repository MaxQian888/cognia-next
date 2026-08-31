//! Data shapes the renderer pushes through `invoke("tray_set_menu", …)`.
//!
//! These mirror the TS types in `lib/tray/types.ts` and the serde tags MUST
//! stay aligned with that file. The renderer is the source of truth for the
//! menu layout, i18n, and `when` filtering — Rust is the dumb container
//! that translates the DTO into a `tauri::menu::Menu`.

use serde::{Deserialize, Serialize};

/// One node in the persisted tray-menu tree. Recursive via `Submenu`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TrayMenuItem {
    Action {
        /// Stable id — also the message-id passed back through
        /// `tray://item-clicked`.
        id: String,
        /// Already-translated label.
        label: String,
        /// Optional accelerator string (cosmetic, e.g. "Ctrl+Shift+Space").
        #[serde(default)]
        accelerator: Option<String>,
        payload: TrayActionPayload,
        /// When `Some(true)`, the menu item is rendered greyed-out.
        #[serde(default)]
        disabled: Option<bool>,
        /// When `Some(_)`, the item is rendered as a checkable entry
        /// (`CheckMenuItem`) with the tick reflecting the boolean. Used by
        /// stateful toggles such as "Launch at login".
        #[serde(default)]
        checked: Option<bool>,
    },
    Separator {
        /// Stable id so settings UIs can drag-reorder separators.
        id: String,
    },
    Submenu {
        id: String,
        label: String,
        items: Vec<TrayMenuItem>,
    },
}

/// What happens when the user activates an `Action` item.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TrayActionPayload {
    /// Resolved entirely in Rust — `action` matches one of the strings in
    /// `tray::native_actions::NATIVE_ACTIONS`. Anything outside that list is
    /// rejected by `menu_builder::build_menu`.
    Native { action: String },
    /// Forwarded to the renderer as `dispatchSlashCommand(/<command>)`.
    Slash { command: String },
    /// Forwarded to the renderer as `executeCommand(<command_id>)`.
    Command {
        #[serde(rename = "commandId")]
        command_id: String,
    },
}

/// Icon variant the Rust side renders. Matches the four PNG paths in
/// `src-tauri/icons/tray/`.
#[derive(Default, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum TrayIconState {
    #[default]
    Idle,
    Busy,
    Error,
    Muted,
}

impl TrayIconState {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "idle" => Some(Self::Idle),
            "busy" => Some(Self::Busy),
            "error" => Some(Self::Error),
            "muted" => Some(Self::Muted),
            _ => None,
        }
    }
}

/// The set of native actions a tray item may carry. Anything outside this
/// list is rejected by the menu builder so a malformed plugin payload can't
/// silently no-op.
pub const NATIVE_ACTIONS: &[&str] = &[
    "show",
    "hide",
    "toggle-window",
    "tray-panel-toggle",
    "new-chat",
    "settings",
    "open-logs",
    "open-data-folder",
    "copy-diagnostics",
    "open-docs",
    "report-issue",
    "check-updates",
    "toggle-autostart",
    "automation-kill",
    "pet-toggle",
    "pet-disable-click-through",
    "island-toggle",
    "noop",
    "quit",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_state_round_trips_through_str() {
        for s in ["idle", "busy", "error", "muted"] {
            let parsed = TrayIconState::from_str(s).expect("known state");
            let json = serde_json::to_string(&parsed).unwrap();
            // serde rename_all = "kebab-case" mirrors from_str
            assert_eq!(json, format!("\"{}\"", s));
        }
        assert!(TrayIconState::from_str("strobe").is_none());
    }

    #[test]
    fn action_payload_deserializes_each_variant() {
        let native: TrayActionPayload =
            serde_json::from_str(r#"{"kind":"native","action":"show"}"#).unwrap();
        assert_eq!(
            native,
            TrayActionPayload::Native {
                action: "show".into()
            }
        );

        let slash: TrayActionPayload =
            serde_json::from_str(r#"{"kind":"slash","command":"goal"}"#).unwrap();
        assert!(matches!(slash, TrayActionPayload::Slash { .. }));

        let cmd: TrayActionPayload =
            serde_json::from_str(r#"{"kind":"command","commandId":"screenshot.capture"}"#).unwrap();
        assert!(matches!(
            cmd,
            TrayActionPayload::Command { ref command_id } if command_id == "screenshot.capture"
        ));
    }

    #[test]
    fn menu_item_round_trips_through_json() {
        let item = TrayMenuItem::Submenu {
            id: "all".into(),
            label: "All Commands".into(),
            items: vec![
                TrayMenuItem::Action {
                    id: "clear".into(),
                    label: "Clear".into(),
                    accelerator: None,
                    payload: TrayActionPayload::Slash {
                        command: "clear".into(),
                    },
                    disabled: None,
                    checked: None,
                },
                TrayMenuItem::Separator { id: "sep1".into() },
            ],
        };
        let json = serde_json::to_string(&item).unwrap();
        let back: TrayMenuItem = serde_json::from_str(&json).unwrap();
        match back {
            TrayMenuItem::Submenu { ref items, .. } => assert_eq!(items.len(), 2),
            _ => panic!("expected submenu"),
        }
    }

    #[test]
    fn native_actions_table_lists_every_string_referenced_elsewhere() {
        // The builder's whitelist must include every action the
        // bootstrap defaults emit (see `tray::defaults::bootstrap_items`).
        for action in [
            "show",
            "hide",
            "toggle-window",
            "tray-panel-toggle",
            "new-chat",
            "settings",
            "open-logs",
            "open-data-folder",
            "copy-diagnostics",
            "open-docs",
            "report-issue",
            "check-updates",
            "toggle-autostart",
            "automation-kill",
            "pet-toggle",
            "pet-disable-click-through",
            "noop",
            "quit",
        ] {
            assert!(
                NATIVE_ACTIONS.contains(&action),
                "{action} is referenced by defaults but missing from NATIVE_ACTIONS"
            );
        }
    }

    #[test]
    fn action_with_checked_round_trips_through_json() {
        let item = TrayMenuItem::Action {
            id: "tray.autostart".into(),
            label: "Launch at login".into(),
            accelerator: None,
            payload: TrayActionPayload::Native {
                action: "toggle-autostart".into(),
            },
            disabled: None,
            checked: Some(true),
        };
        let json = serde_json::to_string(&item).unwrap();
        let back: TrayMenuItem = serde_json::from_str(&json).unwrap();
        match back {
            TrayMenuItem::Action { checked, .. } => assert_eq!(checked, Some(true)),
            _ => panic!("expected action"),
        }
    }

    #[test]
    fn action_checked_defaults_to_none_when_absent() {
        // The renderer omits `checked` for ordinary items; serde must default
        // it to None rather than failing deserialization.
        let action: TrayMenuItem = serde_json::from_str(
            r#"{"kind":"action","id":"a","label":"A","payload":{"kind":"native","action":"show"}}"#,
        )
        .unwrap();
        match action {
            TrayMenuItem::Action {
                checked, disabled, ..
            } => {
                assert_eq!(checked, None);
                assert_eq!(disabled, None);
            }
            _ => panic!("expected action"),
        }
    }
}
