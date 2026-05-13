//! `Locator` → `UIMatcher` translation. The matcher is fluent so we wrap each
//! optional field in a guarded chain. Unsupported fields (no UIA equivalent)
//! are documented inline and silently dropped.

use uiautomation::{UIAutomation, UIElement, UIMatcher};

use crate::automation::types::Locator;

pub fn build_matcher<'a>(
    automation: &'a UIAutomation,
    locator: &Locator,
    from: Option<&UIElement>,
) -> UIMatcher {
    let mut m = automation.create_matcher();
    if let Some(elt) = from {
        m = m.from_ref(elt);
    }
    if let Some(name) = &locator.name {
        m = m.name(name.clone());
    }
    if let Some(classname) = &locator.class_name {
        m = m.classname(classname.clone());
    }
    if let Some(ct) = &locator.control_type {
        if let Some(parsed) = parse_control_type(ct) {
            m = m.control_type(parsed);
        }
    }
    if let Some(pid) = locator.process_id {
        m = m.process_id(pid);
    }
    if let Some(depth) = locator.depth {
        m = m.depth(depth);
    }
    // `nameContains`, `windowTitleContains`, `processName`, `automationId`
    // are not part of the fluent matcher API; M2 will add `filter_fn` chains
    // for them. Recorded here so the contract surfaces in the next iteration.
    m
}

/// Match a TypeScript camelCase control type name (e.g. `"button"`,
/// `"checkBox"`) against the uiautomation enum. Falls back to `None` when
/// the name doesn't match any known variant — caller can decide whether to
/// surface that as an error or just drop the filter.
pub fn parse_control_type(s: &str) -> Option<uiautomation::controls::ControlType> {
    use uiautomation::controls::ControlType as CT;
    Some(match s.to_ascii_lowercase().as_str() {
        "button" => CT::Button,
        "calendar" => CT::Calendar,
        "checkbox" => CT::CheckBox,
        "combobox" => CT::ComboBox,
        "edit" => CT::Edit,
        "hyperlink" => CT::Hyperlink,
        "image" => CT::Image,
        "listitem" => CT::ListItem,
        "list" => CT::List,
        "menu" => CT::Menu,
        "menubar" => CT::MenuBar,
        "menuitem" => CT::MenuItem,
        "progressbar" => CT::ProgressBar,
        "radiobutton" => CT::RadioButton,
        "scrollbar" => CT::ScrollBar,
        "slider" => CT::Slider,
        "spinner" => CT::Spinner,
        "statusbar" => CT::StatusBar,
        "tab" => CT::Tab,
        "tabitem" => CT::TabItem,
        "text" => CT::Text,
        "toolbar" => CT::ToolBar,
        "tooltip" => CT::ToolTip,
        "tree" => CT::Tree,
        "treeitem" => CT::TreeItem,
        "custom" => CT::Custom,
        "group" => CT::Group,
        "thumb" => CT::Thumb,
        "datagrid" => CT::DataGrid,
        "dataitem" => CT::DataItem,
        "document" => CT::Document,
        "splitbutton" => CT::SplitButton,
        "window" => CT::Window,
        "pane" => CT::Pane,
        "header" => CT::Header,
        "headeritem" => CT::HeaderItem,
        "table" => CT::Table,
        "titlebar" => CT::TitleBar,
        "separator" => CT::Separator,
        "semanticzoom" => CT::SemanticZoom,
        "appbar" => CT::AppBar,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_type_parser_is_case_insensitive() {
        assert!(parse_control_type("button").is_some());
        assert!(parse_control_type("Button").is_some());
        assert!(parse_control_type("BUTTON").is_some());
        assert!(parse_control_type("CheckBox").is_some());
    }

    #[test]
    fn control_type_parser_handles_unknown() {
        assert!(parse_control_type("bogusType").is_none());
        assert!(parse_control_type("").is_none());
    }
}
