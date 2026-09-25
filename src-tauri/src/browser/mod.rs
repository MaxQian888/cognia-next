//! In-app browser (v0/Lovable-style visual editing), Tauri-native.
//!
//! Renders a page in a native child webview embedded in the main window
//! (`embedded.rs`, via the `unstable` multi-webview API), injects a selection
//! overlay (`overlay.rs`), and turns "selected element + comment" into a chat
//! turn on the frontend. `commands.rs` holds the helpers the embedded webview
//! shares — there is no standalone preview window. `cookie_import/` reuses a
//! local Chromium profile's sign-in (ADR-0073); `cdp.rs` is the session-scoped
//! developer bridge. The page->Rust channel is documented in `overlay.rs`.

pub mod cdp;
pub mod commands;
pub mod cookie_import;
pub mod embedded;
pub mod overlay;
