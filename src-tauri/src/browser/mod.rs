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

/// Every browser command is invoked from the main window, which hosts the
/// embedded preview as a child webview. Tauri only resolves a command's
/// window-typed argument while every webview in the window shares the window's
/// label, so once the preview exists such a command fails with "current
/// webview is not a WebviewWindow". Commands take the calling `Webview` instead.
#[cfg(test)]
mod tests {
    const WINDOW_TYPED_ARGUMENT: &str = concat!("Webview", "Window");

    #[test]
    fn browser_commands_take_the_calling_webview_not_its_window() {
        let sources = [
            ("cdp.rs", include_str!("cdp.rs")),
            ("commands.rs", include_str!("commands.rs")),
            ("cookie_import/mod.rs", include_str!("cookie_import/mod.rs")),
            ("downloads.rs", include_str!("downloads.rs")),
            ("embedded.rs", include_str!("embedded.rs")),
            ("extensions.rs", include_str!("extensions.rs")),
            ("local.rs", include_str!("local.rs")),
            ("local_content.rs", include_str!("local_content.rs")),
            ("passwords.rs", include_str!("passwords.rs")),
        ];
        for (file, source) in sources {
            assert!(
                !source.contains(WINDOW_TYPED_ARGUMENT),
                "{file} names the window-typed command argument; take `tauri::Webview` so the \
                 command still resolves while the embedded preview is a child of the main window"
            );
        }
    }
}
