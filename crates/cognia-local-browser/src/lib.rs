//! Local Chromium for the desktop browser (ADR-0201).
//!
//! The desktop runs `services/workspace-runtime` in local mode
//! (`local-main.mjs`) on loopback and drives it over the same private protocol
//! the cloud uses (ADR-0085), so snapshots, refs and actions are identical on
//! both. Everything here is Tauri-free; the command shells and the `AppHandle`
//! adapters live in `src-tauri/src/browser/`.

pub mod bridge;
pub mod client;
pub mod dev_servers;
pub mod extensions;
pub mod installer;
pub mod local_files;
pub mod supervisor;
pub mod user_chrome;
