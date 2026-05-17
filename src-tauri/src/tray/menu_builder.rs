//! Recursive `TrayMenuItem` → `tauri::menu::Menu` builder.
//!
//! Two invariants enforced here:
//!   - Submenu nesting is capped at `MAX_SUBMENU_DEPTH` (= 2) so users
//!     cannot get lost in a deeply-nested menu.
//!   - `payload.kind == "native"` actions are checked against
//!     `dto::NATIVE_ACTIONS`; anything else is a
//!     `BuildError::UnknownNativeAction`.
//!
//! The builder also returns a flat `id → payload` index so the click
//! handler can dispatch in O(1) without re-walking the tree.

use std::collections::{HashMap, HashSet};

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{Manager, Runtime};

use super::dto::{TrayActionPayload, TrayMenuItem, NATIVE_ACTIONS};

pub const MAX_SUBMENU_DEPTH: usize = 2;

#[derive(thiserror::Error, Debug)]
pub enum BuildError {
    #[error("tray menu submenu nesting exceeds the cap of {MAX_SUBMENU_DEPTH}")]
    DepthExceeded,
    #[error("tray menu references unknown native action '{0}'")]
    UnknownNativeAction(String),
    #[error("tray menu duplicate id '{0}'")]
    DuplicateId(String),
    #[error("tauri menu builder failed: {0}")]
    Tauri(#[from] tauri::Error),
}

/// Output of a successful build: the assembled `Menu` plus a lookup table
/// that resolves a clicked item id back to its action payload.
pub struct BuiltMenu<R: Runtime> {
    pub menu: Menu<R>,
    pub index: HashMap<String, TrayActionPayload>,
}

pub fn build_menu<R, M>(handle: &M, items: &[TrayMenuItem]) -> Result<BuiltMenu<R>, BuildError>
where
    R: Runtime,
    M: Manager<R>,
{
    let mut builder = MenuBuilder::new(handle);
    let mut index = HashMap::new();
    let mut seen = HashSet::new();

    for item in items {
        builder = append_item(handle, builder, item, 0, &mut index, &mut seen)?;
    }

    let menu = builder.build()?;
    Ok(BuiltMenu { menu, index })
}

fn append_item<'m, R, M>(
    handle: &'m M,
    mut builder: MenuBuilder<'m, R, M>,
    item: &TrayMenuItem,
    depth: usize,
    index: &mut HashMap<String, TrayActionPayload>,
    seen: &mut HashSet<String>,
) -> Result<MenuBuilder<'m, R, M>, BuildError>
where
    R: Runtime,
    M: Manager<R>,
{
    match item {
        TrayMenuItem::Separator { id } => {
            ensure_unique(id, seen)?;
            builder = builder.separator();
            Ok(builder)
        }
        TrayMenuItem::Action {
            id,
            label,
            accelerator,
            payload,
            disabled,
        } => {
            ensure_unique(id, seen)?;
            validate_payload(payload)?;

            if is_quit_native(payload) {
                let quit = PredefinedMenuItem::quit(handle, Some(label.as_str()))?;
                builder = builder.item(&quit);
            } else {
                let mut item_builder = MenuItemBuilder::new(label).id(id.as_str());
                if let Some(acc) = accelerator.as_deref() {
                    item_builder = item_builder.accelerator(acc);
                }
                if disabled.unwrap_or(false) {
                    item_builder = item_builder.enabled(false);
                }
                let menu_item = item_builder.build(handle)?;
                builder = builder.item(&menu_item);
                index.insert(id.clone(), payload.clone());
            }
            Ok(builder)
        }
        TrayMenuItem::Submenu { id, label, items } => {
            if depth >= MAX_SUBMENU_DEPTH {
                return Err(BuildError::DepthExceeded);
            }
            ensure_unique(id, seen)?;

            let submenu = build_submenu(handle, id, label, items, depth + 1, index)?;
            builder = builder.item(&submenu);
            Ok(builder)
        }
    }
}

fn build_submenu<R, M>(
    handle: &M,
    id: &str,
    label: &str,
    items: &[TrayMenuItem],
    depth: usize,
    index: &mut HashMap<String, TrayActionPayload>,
) -> Result<Submenu<R>, BuildError>
where
    R: Runtime,
    M: Manager<R>,
{
    let mut sub = SubmenuBuilder::new(handle, label).id(id);
    let mut inner_seen = HashSet::new();

    for item in items {
        match item {
            TrayMenuItem::Separator { id } => {
                ensure_unique(id, &mut inner_seen)?;
                sub = sub.separator();
            }
            TrayMenuItem::Action {
                id,
                label,
                accelerator,
                payload,
                disabled,
            } => {
                ensure_unique(id, &mut inner_seen)?;
                validate_payload(payload)?;

                if is_quit_native(payload) {
                    let quit = PredefinedMenuItem::quit(handle, Some(label.as_str()))?;
                    sub = sub.item(&quit);
                } else {
                    let mut item_builder = MenuItemBuilder::new(label).id(id.as_str());
                    if let Some(acc) = accelerator.as_deref() {
                        item_builder = item_builder.accelerator(acc);
                    }
                    if disabled.unwrap_or(false) {
                        item_builder = item_builder.enabled(false);
                    }
                    let menu_item = item_builder.build(handle)?;
                    sub = sub.item(&menu_item);
                    index.insert(id.clone(), payload.clone());
                }
            }
            TrayMenuItem::Submenu { id, label, items } => {
                if depth >= MAX_SUBMENU_DEPTH {
                    return Err(BuildError::DepthExceeded);
                }
                ensure_unique(id, &mut inner_seen)?;
                let nested = build_submenu(handle, id, label, items, depth + 1, index)?;
                sub = sub.item(&nested);
            }
        }
    }

    Ok(sub.build()?)
}

fn ensure_unique(id: &str, seen: &mut HashSet<String>) -> Result<(), BuildError> {
    if !seen.insert(id.to_string()) {
        return Err(BuildError::DuplicateId(id.to_string()));
    }
    Ok(())
}

fn validate_payload(payload: &TrayActionPayload) -> Result<(), BuildError> {
    if let TrayActionPayload::Native { action } = payload {
        if !NATIVE_ACTIONS.contains(&action.as_str()) {
            return Err(BuildError::UnknownNativeAction(action.clone()));
        }
    }
    Ok(())
}

fn is_quit_native(payload: &TrayActionPayload) -> bool {
    matches!(payload, TrayActionPayload::Native { action } if action == "quit")
}

#[cfg(test)]
mod tests {
    use super::*;

    // The native code-path needs `tauri::test::mock_app` which is not enabled
    // here (see `window_utils.rs` note). We exercise the pure validation
    // helpers instead — they are the actual logic worth testing; the
    // `MenuBuilder` calls themselves are thin pass-throughs.

    #[test]
    fn validate_payload_accepts_known_natives() {
        for a in NATIVE_ACTIONS {
            let p = TrayActionPayload::Native {
                action: (*a).to_string(),
            };
            assert!(validate_payload(&p).is_ok(), "{a}");
        }
    }

    #[test]
    fn validate_payload_rejects_unknown_native() {
        let p = TrayActionPayload::Native {
            action: "nuke".into(),
        };
        assert!(matches!(
            validate_payload(&p),
            Err(BuildError::UnknownNativeAction(a)) if a == "nuke"
        ));
    }

    #[test]
    fn validate_payload_lets_slash_and_command_through_unchecked() {
        assert!(validate_payload(&TrayActionPayload::Slash {
            command: "anything".into()
        })
        .is_ok());
        assert!(validate_payload(&TrayActionPayload::Command {
            command_id: "anything".into()
        })
        .is_ok());
    }

    #[test]
    fn ensure_unique_rejects_dupes_within_a_scope() {
        let mut seen = HashSet::new();
        ensure_unique("a", &mut seen).unwrap();
        let err = ensure_unique("a", &mut seen).unwrap_err();
        assert!(matches!(err, BuildError::DuplicateId(id) if id == "a"));
    }

    #[test]
    fn is_quit_native_detects_only_the_quit_action() {
        assert!(is_quit_native(&TrayActionPayload::Native {
            action: "quit".into()
        }));
        assert!(!is_quit_native(&TrayActionPayload::Native {
            action: "show".into()
        }));
        assert!(!is_quit_native(&TrayActionPayload::Slash {
            command: "quit".into()
        }));
    }
}
