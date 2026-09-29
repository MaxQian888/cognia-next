//! In-app browser (v0/Lovable-style visual editing), Tauri-native.
//!
//! Renders a page in a native child webview embedded in the main window
//! (`embedded.rs`, via the `unstable` multi-webview API), injects a selection
//! overlay (`overlay.rs`), and turns "selected element + comment" into a chat
//! turn on the frontend. `commands.rs` holds the helpers the embedded webview
//! shares — there is no standalone preview window. `cookie_import/` reuses a
//! local Chromium profile's sign-in (ADR-0073); `cdp.rs` is the session-scoped
//! developer bridge. The page->Rust channel is documented in `overlay.rs`.
//!
//! ADR-0201 adds the local Chromium backends: `local.rs` shells over
//! `cognia-local-browser` (runtime, installer, frames, events, user Chrome),
//! `extensions.rs` the Chrome extension store, `passwords.rs` the Rust-only
//! password vault and autofill, `downloads.rs` the shared Downloads directory
//! and the embedded webview's download handler, and `local_content.rs` local
//! files and dev-server discovery.

pub mod cdp;
pub mod commands;
pub mod cookie_import;
pub mod downloads;
pub mod embedded;
pub mod extensions;
pub mod local;
pub mod local_content;
pub mod overlay;
pub mod passwords;
