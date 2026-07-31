//! Read-only cross-application text selection primitives.
//!
//! Platform backends materialize the currently focused selection into the
//! bounded snapshot defined here. The snapshot deliberately contains no live
//! accessibility handles: selection-toolbar candidates cross async and window
//! boundaries, so retaining an AX/UIA object would be both unsafe and stale.

use serde::{Deserialize, Serialize};

use super::types::Rect;

pub const MAX_SELECTION_CHARS: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSelectionSnapshot {
    pub text: String,
    pub source_app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_rect: Option<Rect>,
    pub truncated: bool,
}

pub fn build_text_selection(
    text: &str,
    source_app: &str,
    source_title: Option<&str>,
    anchor_rect: Option<Rect>,
) -> Option<TextSelectionSnapshot> {
    if text.trim().is_empty() {
        return None;
    }

    let mut chars = text.chars();
    let bounded: String = chars.by_ref().take(MAX_SELECTION_CHARS).collect();
    let truncated = chars.next().is_some();

    Some(TextSelectionSnapshot {
        text: bounded,
        source_app: source_app.to_string(),
        source_title: source_title
            .map(str::to_string)
            .filter(|title| !title.is_empty()),
        anchor_rect,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_preserves_text_and_source_metadata() {
        let snapshot = build_text_selection("  selected text\n", "TextEdit", Some("Notes"), None)
            .expect("non-blank selection");

        assert_eq!(snapshot.text, "  selected text\n");
        assert_eq!(snapshot.source_app, "TextEdit");
        assert_eq!(snapshot.source_title.as_deref(), Some("Notes"));
        assert!(!snapshot.truncated);
    }

    #[test]
    fn snapshot_rejects_blank_text() {
        assert!(build_text_selection(" \n\t", "TextEdit", None, None).is_none());
    }

    #[test]
    fn snapshot_caps_text_and_marks_truncation() {
        let text = "界".repeat(MAX_SELECTION_CHARS + 7);
        let snapshot =
            build_text_selection(&text, "Preview", Some("Long PDF"), None).expect("selection");

        assert_eq!(snapshot.text.chars().count(), MAX_SELECTION_CHARS);
        assert!(snapshot.truncated);
    }
}
