//! In-app browser (v0/Lovable-style visual editing), Tauri-native.
//!
//! Renders a local dev server in a native webview, injects a selection overlay
//! (`overlay.rs`), and turns "selected element + comment" into a chat turn on
//! the frontend. P0 ships a standalone preview window driven by `commands.rs`;
//! P1 embeds the same webview into a side pane via the `unstable` multi-webview
//! API. The page->Rust channel is documented in `overlay.rs`.

pub mod cdp;
pub mod commands;
pub mod cookie_import;
pub mod embedded;
pub mod overlay;
