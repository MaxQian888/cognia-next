//! Input / output types for the Anthropic native Computer Use tool commands.
//!
//! These mirror the JSON shapes that Anthropic's `computer_20251124`,
//! `bash_20250124`, and `text_editor_20250728` tool schemas expect.

use serde::{Deserialize, Serialize};

// =============================================================================
// Computer tool (computer_20251124)
// =============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
#[serde(tag = "action")]
pub enum ComputerAction {
    Screenshot,
    LeftClick { coordinate: [i32; 2] },
    RightClick { coordinate: [i32; 2] },
    MiddleClick { coordinate: [i32; 2] },
    DoubleClick { coordinate: [i32; 2] },
    TripleClick { coordinate: [i32; 2] },
    MouseMove { coordinate: [i32; 2] },
    LeftClickDrag {
        start_coordinate: [i32; 2],
        coordinate: [i32; 2],
    },
    LeftMouseDown,
    LeftMouseUp,
    Scroll {
        coordinate: [i32; 2],
        scroll_direction: ScrollDirection,
        scroll_amount: i32,
    },
    Type { text: String },
    Key { text: String },
    HoldKey { text: String, duration: f64 },
    Wait { duration: f64 },
    Zoom { region: [i32; 4] },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComputerResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_width_px: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_height_px: Option<u32>,
}

// =============================================================================
// Bash tool (bash_20250124)
// =============================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct BashAction {
    pub command: String,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub restart: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BashResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

// =============================================================================
// Text Editor tool (text_editor_20250728)
// =============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
#[serde(tag = "action")]
pub enum TextEditorAction {
    View { path: String },
    Create { path: String, file_text: String },
    StrReplace { path: String, old_str: String, new_str: String },
    Insert { path: String, insert_line: usize, new_str: String },
    UndoEdit { path: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct TextEditorResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
