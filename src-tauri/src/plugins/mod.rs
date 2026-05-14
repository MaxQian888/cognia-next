//! Plugin backend modules — each sub-module corresponds to a plugin that
//! ships Rust-side Tauri commands.  Source files live under
//! `plugins/<name>/rust/src/` and are brought in via `#[path]`.

pub mod computer_use;
