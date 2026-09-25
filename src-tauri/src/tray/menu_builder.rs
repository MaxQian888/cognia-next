//! Recursive `TrayMenuItem` → `tauri::menu::Menu` builder.
//!
//! Three invariants, checked by [`sanitize_items`] before any OS menu object
//! is created:
//!   - Submenu nesting is capped at `MAX_SUBMENU_DEPTH` (= 2) so users
//!     cannot get lost in a deeply-nested menu.
//!   - `payload.kind == "native"` actions are checked against
//!     `dto::NATIVE_ACTIONS`; anything else is a
//!     `BuildError::UnknownNativeAction`.
//!   - Ids are unique within one menu level, and action ids across the
//!     whole tree: the click index is flat, so an action id repeated in
//!     another submenu would dispatch whichever copy was indexed last.
//!
//! Two entry points differ only in what a violation costs:
//!   - [`build_menu_skipping_invalid`] (renderer pushes) drops the offending
//!     node, reports it, and builds the rest. A single stale persisted item
//!     used to reject the whole push, stranding the previous menu (on cold
//!     start, the English bootstrap one) with nothing telling the renderer.
//!   - [`build_menu`] (the hard-coded bootstrap) fails on the first
//!     violation, because there one is a logic bug, not user data.
//!
//! Both return a flat `id → payload` index so the click handler can
//! dispatch in O(1) without re-walking the tree.

use std::collections::{HashMap, HashSet};

use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, MenuItemKind, PredefinedMenuItem,
    SubmenuBuilder,
};
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

/// One node [`sanitize_items`] dropped. A dropped submenu takes its whole
/// subtree with it; only the submenu itself is reported.
#[derive(Debug)]
pub struct SkippedItem {
    pub id: String,
    pub error: BuildError,
}

/// The input tree with every invariant-violating node removed.
#[derive(Debug)]
pub struct SanitizedItems {
    pub items: Vec<TrayMenuItem>,
    pub skipped: Vec<SkippedItem>,
}

/// Output of [`build_menu_skipping_invalid`].
pub struct SanitizedBuild<R: Runtime> {
    pub built: BuiltMenu<R>,
    /// The tree the menu was built from: what `TrayMenuStateStore` should
    /// hold so `tray_get_current_menu` reports the menu the user sees.
    pub applied: Vec<TrayMenuItem>,
    pub skipped: Vec<SkippedItem>,
}

/// Strict build: the first invariant violation fails the whole menu. Only
/// the hard-coded bootstrap layout goes through here.
pub fn build_menu<R, M>(handle: &M, items: &[TrayMenuItem]) -> Result<BuiltMenu<R>, BuildError>
where
    R: Runtime,
    M: Manager<R>,
{
    let sanitized = sanitize_items(items);
    if let Some(first) = sanitized.skipped.into_iter().next() {
        return Err(first.error);
    }
    build_valid(handle, &sanitized.items)
}

/// Lenient build for renderer pushes: drop what violates an invariant, build
/// the rest. Only an OS-level menu failure (`BuildError::Tauri`) is an error.
pub fn build_menu_skipping_invalid<R, M>(
    handle: &M,
    items: &[TrayMenuItem],
) -> Result<SanitizedBuild<R>, BuildError>
where
    R: Runtime,
    M: Manager<R>,
{
    let SanitizedItems { items, skipped } = sanitize_items(items);
    let built = build_valid(handle, &items)?;
    Ok(SanitizedBuild {
        built,
        applied: items,
        skipped,
    })
}

/// Remove every node that breaks a builder invariant, recording why.
///
/// When nothing is dropped the output equals the input exactly. When a level
/// loses a node, that level's separators are tidied (leading, trailing and
/// doubled ones removed, as `lib/tray/builder.ts` does before pushing), and a
/// submenu left with no children is removed rather than shown as a dead
/// arrow; its children's entries in `skipped` already explain why.
pub fn sanitize_items(items: &[TrayMenuItem]) -> SanitizedItems {
    let mut skipped = Vec::new();
    let mut action_ids = HashSet::new();
    let items = sanitize_level(items, 0, &mut action_ids, &mut skipped);
    SanitizedItems { items, skipped }
}

/// `action_ids` spans the whole tree; `seen` (every kind) spans one level.
fn sanitize_level(
    items: &[TrayMenuItem],
    depth: usize,
    action_ids: &mut HashSet<String>,
    skipped: &mut Vec<SkippedItem>,
) -> Vec<TrayMenuItem> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(items.len());
    let mut dropped_here = false;

    for item in items {
        let kept = match item {
            TrayMenuItem::Separator { id } => ensure_unique(id, &mut seen).map(|()| item.clone()),
            // Validate before claiming the id, so a dropped action does not
            // push a later, valid one with the same id out as a duplicate.
            TrayMenuItem::Action { id, payload, .. } => validate_payload(payload).and_then(|()| {
                if seen.contains(id.as_str()) || action_ids.contains(id.as_str()) {
                    return Err(BuildError::DuplicateId(id.clone()));
                }
                seen.insert(id.clone());
                action_ids.insert(id.clone());
                Ok(item.clone())
            }),
            TrayMenuItem::Submenu {
                id,
                label,
                items: children,
            } => {
                if depth >= MAX_SUBMENU_DEPTH {
                    Err(BuildError::DepthExceeded)
                } else if seen.contains(id.as_str()) {
                    Err(BuildError::DuplicateId(id.clone()))
                } else {
                    let skipped_before = skipped.len();
                    let kept_children = sanitize_level(children, depth + 1, action_ids, skipped);
                    if kept_children.is_empty() && skipped.len() > skipped_before {
                        dropped_here = true;
                        continue;
                    }
                    seen.insert(id.clone());
                    Ok(TrayMenuItem::Submenu {
                        id: id.clone(),
                        label: label.clone(),
                        items: kept_children,
                    })
                }
            }
        };
        match kept {
            Ok(node) => out.push(node),
            Err(error) => {
                dropped_here = true;
                skipped.push(SkippedItem {
                    id: item_id(item).to_string(),
                    error,
                });
            }
        }
    }

    if dropped_here {
        collapse_separators(out)
    } else {
        out
    }
}

/// Strip leading, trailing and consecutive separators.
fn collapse_separators(items: Vec<TrayMenuItem>) -> Vec<TrayMenuItem> {
    let mut out: Vec<TrayMenuItem> = Vec::with_capacity(items.len());
    for item in items {
        let after_separator_or_start = out
            .last()
            .is_none_or(|prev| matches!(prev, TrayMenuItem::Separator { .. }));
        if matches!(item, TrayMenuItem::Separator { .. }) && after_separator_or_start {
            continue;
        }
        out.push(item);
    }
    while matches!(out.last(), Some(TrayMenuItem::Separator { .. })) {
        out.pop();
    }
    out
}

fn item_id(item: &TrayMenuItem) -> &str {
    match item {
        TrayMenuItem::Action { id, .. }
        | TrayMenuItem::Separator { id }
        | TrayMenuItem::Submenu { id, .. } => id,
    }
}

/// Build the OS menu from a tree that already passed [`sanitize_items`].
fn build_valid<R, M>(handle: &M, items: &[TrayMenuItem]) -> Result<BuiltMenu<R>, BuildError>
where
    R: Runtime,
    M: Manager<R>,
{
    let mut builder = MenuBuilder::new(handle);
    let mut index = HashMap::new();
    for item in items {
        builder = builder.item(&build_node(handle, item, &mut index)?);
    }
    let menu = builder.build()?;
    Ok(BuiltMenu { menu, index })
}

fn build_node<R, M>(
    handle: &M,
    item: &TrayMenuItem,
    index: &mut HashMap<String, TrayActionPayload>,
) -> Result<MenuItemKind<R>, BuildError>
where
    R: Runtime,
    M: Manager<R>,
{
    Ok(match item {
        TrayMenuItem::Separator { .. } => {
            MenuItemKind::Predefined(PredefinedMenuItem::separator(handle)?)
        }
        TrayMenuItem::Action {
            id,
            label,
            accelerator,
            payload,
            disabled,
            checked,
        } => {
            if is_quit_native(payload) {
                // Tauri handles the predefined quit itself; it never enters
                // the click index.
                MenuItemKind::Predefined(PredefinedMenuItem::quit(handle, Some(label.as_str()))?)
            } else {
                index.insert(id.clone(), payload.clone());
                match checked {
                    Some(is_checked) => MenuItemKind::Check(build_check_item(
                        handle,
                        id,
                        label,
                        accelerator,
                        *disabled,
                        *is_checked,
                    )?),
                    None => MenuItemKind::MenuItem(build_action_item(
                        handle,
                        id,
                        label,
                        accelerator,
                        *disabled,
                    )?),
                }
            }
        }
        TrayMenuItem::Submenu { id, label, items } => {
            let mut sub = SubmenuBuilder::new(handle, label).id(id);
            for child in items {
                sub = sub.item(&build_node(handle, child, index)?);
            }
            MenuItemKind::Submenu(sub.build()?)
        }
    })
}

/// Build a plain (non-checkable) action menu item.
fn build_action_item<R, M>(
    handle: &M,
    id: &str,
    label: &str,
    accelerator: &Option<String>,
    disabled: Option<bool>,
) -> Result<tauri::menu::MenuItem<R>, BuildError>
where
    R: Runtime,
    M: Manager<R>,
{
    let mut item_builder = MenuItemBuilder::new(label).id(id);
    if let Some(acc) = accelerator.as_deref() {
        item_builder = item_builder.accelerator(acc);
    }
    if disabled.unwrap_or(false) {
        item_builder = item_builder.enabled(false);
    }
    Ok(item_builder.build(handle)?)
}

/// Build a checkable action item (`CheckMenuItem`) with the tick reflecting
/// `checked`. Used by stateful toggles such as "Launch at login".
fn build_check_item<R, M>(
    handle: &M,
    id: &str,
    label: &str,
    accelerator: &Option<String>,
    disabled: Option<bool>,
    checked: bool,
) -> Result<tauri::menu::CheckMenuItem<R>, BuildError>
where
    R: Runtime,
    M: Manager<R>,
{
    let mut item_builder = CheckMenuItemBuilder::new(label).id(id).checked(checked);
    if let Some(acc) = accelerator.as_deref() {
        item_builder = item_builder.accelerator(acc);
    }
    if disabled.unwrap_or(false) {
        item_builder = item_builder.enabled(false);
    }
    Ok(item_builder.build(handle)?)
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
    // helpers and `sanitize_items` instead: they hold the actual logic; the
    // `MenuBuilder` calls in `build_valid` are thin pass-throughs.

    fn native(id: &str, action: &str) -> TrayMenuItem {
        TrayMenuItem::Action {
            id: id.into(),
            label: id.into(),
            accelerator: None,
            payload: TrayActionPayload::Native {
                action: action.into(),
            },
            disabled: None,
            checked: None,
        }
    }

    fn slash(id: &str) -> TrayMenuItem {
        TrayMenuItem::Action {
            id: id.into(),
            label: id.into(),
            accelerator: None,
            payload: TrayActionPayload::Slash { command: id.into() },
            disabled: None,
            checked: None,
        }
    }

    fn sep(id: &str) -> TrayMenuItem {
        TrayMenuItem::Separator { id: id.into() }
    }

    fn submenu(id: &str, items: Vec<TrayMenuItem>) -> TrayMenuItem {
        TrayMenuItem::Submenu {
            id: id.into(),
            label: id.into(),
            items,
        }
    }

    /// Ids of a level, with a submenu rendered as `id[child, …]`.
    fn shape(items: &[TrayMenuItem]) -> Vec<String> {
        items
            .iter()
            .map(|item| match item {
                TrayMenuItem::Submenu { id, items, .. } => {
                    format!("{id}[{}]", shape(items).join(", "))
                }
                other => item_id(other).to_string(),
            })
            .collect()
    }

    fn skipped_ids(sanitized: &SanitizedItems) -> Vec<&str> {
        sanitized.skipped.iter().map(|s| s.id.as_str()).collect()
    }

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

    #[test]
    fn sanitize_leaves_a_valid_tree_untouched() {
        // Includes a leading separator and an intentionally empty submenu:
        // tidying only runs on a level that lost a node, so a clean push
        // reaches the OS exactly as the renderer built it.
        let items = vec![
            sep("s0"),
            native("show", "show"),
            submenu("empty", vec![]),
            submenu(
                "all",
                vec![slash("clear"), sep("s1"), submenu("deep", vec![slash("x")])],
            ),
            native("quit", "quit"),
        ];
        let sanitized = sanitize_items(&items);
        assert!(sanitized.skipped.is_empty());
        assert_eq!(shape(&sanitized.items), shape(&items));
    }

    #[test]
    fn sanitize_drops_one_unknown_native_and_keeps_the_rest() {
        // The cold-start failure: one stale persisted action used to reject
        // the entire push and leave the bootstrap menu up.
        let items = vec![
            native("show", "show"),
            native("stale", "self-destruct"),
            native("settings", "settings"),
        ];
        let sanitized = sanitize_items(&items);
        assert_eq!(shape(&sanitized.items), ["show", "settings"]);
        assert_eq!(skipped_ids(&sanitized), ["stale"]);
        assert!(matches!(
            &sanitized.skipped[0].error,
            BuildError::UnknownNativeAction(a) if a == "self-destruct"
        ));
    }

    #[test]
    fn sanitize_keeps_the_first_action_id_across_the_whole_tree() {
        // The click index is flat: a second `a` in the submenu would make a
        // click on the top-level `a` dispatch the submenu's payload.
        let items = vec![
            slash("a"),
            slash("a"),
            submenu("sub", vec![slash("a"), slash("b"), slash("b")]),
        ];
        let sanitized = sanitize_items(&items);
        assert_eq!(shape(&sanitized.items), ["a", "sub[b]"]);
        assert_eq!(skipped_ids(&sanitized), ["a", "a", "b"]);
        assert!(sanitized
            .skipped
            .iter()
            .all(|s| matches!(&s.error, BuildError::DuplicateId(id) if *id == s.id)));
    }

    #[test]
    fn sanitize_scopes_separator_and_submenu_ids_to_one_level() {
        // Neither is clickable, so a repeat on another level is harmless.
        let items = vec![
            sep("s"),
            slash("x"),
            submenu(
                "sub",
                vec![
                    slash("y"),
                    sep("s"),
                    slash("z"),
                    submenu("sub", vec![slash("w")]),
                ],
            ),
        ];
        let sanitized = sanitize_items(&items);
        assert!(sanitized.skipped.is_empty());
        assert_eq!(shape(&sanitized.items), shape(&items));

        // On one level, any kind still clashes with any other.
        let same_level = vec![slash("x"), sep("x"), submenu("x", vec![slash("y")])];
        let sanitized = sanitize_items(&same_level);
        assert_eq!(shape(&sanitized.items), ["x"]);
        assert_eq!(skipped_ids(&sanitized), ["x", "x"]);
    }

    #[test]
    fn sanitize_does_not_let_a_dropped_action_claim_its_id() {
        let items = vec![native("x", "self-destruct"), native("x", "show")];
        let sanitized = sanitize_items(&items);
        assert_eq!(shape(&sanitized.items), ["x"]);
        assert!(matches!(
            &sanitized.items[0],
            TrayMenuItem::Action { payload: TrayActionPayload::Native { action }, .. }
                if action == "show"
        ));
        assert!(matches!(
            &sanitized.skipped[0].error,
            BuildError::UnknownNativeAction(_)
        ));
    }

    #[test]
    fn sanitize_drops_a_duplicate_submenu_whole_without_reporting_its_children() {
        let items = vec![
            submenu("sub", vec![slash("a")]),
            submenu("sub", vec![native("bad", "self-destruct")]),
        ];
        let sanitized = sanitize_items(&items);
        assert_eq!(shape(&sanitized.items), ["sub[a]"]);
        assert_eq!(skipped_ids(&sanitized), ["sub"]);
        assert!(matches!(
            &sanitized.skipped[0].error,
            BuildError::DuplicateId(_)
        ));
    }

    #[test]
    fn sanitize_drops_submenus_nested_past_the_cap() {
        // Two submenu levels are allowed; the third is dropped with its
        // subtree, and its parent keeps its other children.
        let items = vec![submenu(
            "l1",
            vec![submenu(
                "l2",
                vec![slash("keep"), submenu("l3", vec![slash("lost")])],
            )],
        )];
        let sanitized = sanitize_items(&items);
        assert_eq!(shape(&sanitized.items), ["l1[l2[keep]]"]);
        assert_eq!(skipped_ids(&sanitized), ["l3"]);
        assert!(matches!(
            &sanitized.skipped[0].error,
            BuildError::DepthExceeded
        ));
    }

    #[test]
    fn sanitize_prunes_a_submenu_emptied_by_skips() {
        let items = vec![
            slash("a"),
            sep("s1"),
            submenu("sub", vec![native("bad", "self-destruct"), sep("s2")]),
            sep("s3"),
            slash("b"),
        ];
        let sanitized = sanitize_items(&items);
        // `sub` goes (its only action was dropped, its separator collapsed),
        // and the top level then collapses the doubled separator it left.
        assert_eq!(shape(&sanitized.items), ["a", "s1", "b"]);
        assert_eq!(skipped_ids(&sanitized), ["bad"]);
    }

    #[test]
    fn sanitize_collapses_separators_left_around_a_dropped_item() {
        let items = vec![
            native("stale", "self-destruct"),
            sep("s1"),
            slash("a"),
            sep("s2"),
            native("stale-2", "self-destruct"),
            sep("s3"),
            slash("b"),
            sep("s4"),
        ];
        let sanitized = sanitize_items(&items);
        assert_eq!(shape(&sanitized.items), ["a", "s2", "b"]);
        assert_eq!(skipped_ids(&sanitized), ["stale", "stale-2"]);
    }

    #[test]
    fn sanitize_tidies_only_the_level_that_lost_a_node() {
        // The top level keeps its leading separator: only `sub` lost a child.
        let items = vec![
            sep("s0"),
            submenu("sub", vec![native("bad", "self-destruct"), slash("a")]),
        ];
        let sanitized = sanitize_items(&items);
        assert_eq!(shape(&sanitized.items), ["s0", "sub[a]"]);
    }

    #[test]
    fn collapse_separators_handles_an_all_separator_level() {
        assert!(collapse_separators(vec![sep("a"), sep("b")]).is_empty());
        assert!(collapse_separators(vec![]).is_empty());
    }
}
