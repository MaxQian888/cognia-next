//! Hard-coded bootstrap menu used between Rust startup and the renderer's
//! first `tray_set_menu` IPC. Strings here are intentionally English-only —
//! the renderer replaces this within milliseconds with the locale-correct
//! menu built from `lib/tray/defaults.ts`.

use super::dto::{TrayActionPayload, TrayMenuItem};

pub fn bootstrap_items() -> Vec<TrayMenuItem> {
    vec![
        action("tray-show", "Show Cognia", "show"),
        action("tray-new-chat", "Quick Chat", "new-chat"),
        TrayMenuItem::Separator {
            id: "tray-sep-1".into(),
        },
        action("tray-settings", "Settings", "settings"),
        action("tray-open-logs", "Open Log Panel", "open-logs"),
        action(
            "tray-automation-kill",
            "🛑 Engage automation kill switch",
            "automation-kill",
        ),
        TrayMenuItem::Separator {
            id: "tray-sep-2".into(),
        },
        action("tray-quit", "Quit", "quit"),
    ]
}

fn action(id: &str, label: &str, native_action: &str) -> TrayMenuItem {
    TrayMenuItem::Action {
        id: id.into(),
        label: label.into(),
        accelerator: None,
        payload: TrayActionPayload::Native {
            action: native_action.into(),
        },
        disabled: None,
        checked: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_items_have_unique_ids() {
        let items = bootstrap_items();
        let mut seen = std::collections::HashSet::new();
        for item in &items {
            let id = match item {
                TrayMenuItem::Action { id, .. }
                | TrayMenuItem::Separator { id, .. }
                | TrayMenuItem::Submenu { id, .. } => id.clone(),
            };
            assert!(seen.insert(id.clone()), "duplicate id {id}");
        }
    }

    #[test]
    fn bootstrap_items_only_use_known_natives() {
        for item in bootstrap_items() {
            if let TrayMenuItem::Action {
                payload: TrayActionPayload::Native { action },
                ..
            } = item
            {
                assert!(
                    super::super::dto::NATIVE_ACTIONS.contains(&action.as_str()),
                    "{action}"
                );
            }
        }
    }
}
