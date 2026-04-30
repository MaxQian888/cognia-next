//! Canvas-related Tauri commands.
//!
//! Currently provides only a sandboxed Python execution path used by
//! the canvas code-execution panel. Web mode falls back to iframe-only
//! execution; this module is desktop-only.

pub mod python_exec;
