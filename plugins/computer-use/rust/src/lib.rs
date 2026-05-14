//! Plugin Computer Use — Rust backend for the Anthropic native Computer Use tool.
//!
//! This module is physically located under `plugins/computer-use/rust/src/`
//! so that the plugin remains self-contained (front-end + back-end in one
//! directory).  It is brought into the main Tauri crate via `#[path]` in
//! `src-tauri/src/plugins/computer_use/mod.rs`.

pub mod commands;
pub mod translator;
pub mod types;
