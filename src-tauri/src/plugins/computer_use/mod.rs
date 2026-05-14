//! Bridge module that brings the computer-use plugin's Rust backend
//! (`plugins/computer-use/rust/src/`) into the main Tauri crate.
//!
//! Each sub-module is wired via `#[path]` so the source files stay under the
//! plugin directory (self-contained front-end + back-end).

#[path = "../../../../plugins/computer-use/rust/src/types.rs"]
pub mod types;

#[path = "../../../../plugins/computer-use/rust/src/translator.rs"]
pub mod translator;

#[path = "../../../../plugins/computer-use/rust/src/commands.rs"]
pub mod commands;
