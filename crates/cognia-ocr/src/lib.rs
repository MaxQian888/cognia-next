//! Native OCR subsystem (ADR-0024) — crate root.
//!
//! The core types, the `NativeOcrRegistry` managed state, the model
//! download/status logic and the `ocr_*` commands live in [`native`]; the
//! platform backends in [`backend`]; the Windows MSIX identity probe in
//! [`msix`]. Extracted from `app_lib` per ADR-0067 Phase 3.
//!
//! The command functions are kept in the `native` submodule (not this crate
//! root) because a `#[tauri::command]` at a library crate root collides in the
//! macro namespace; the app's `generate_handler!` references them by their
//! `cognia_ocr::native::ocr_*` path (the tauri command macro must be co-located
//! with its fn). Types + the boot hook are re-exported so `ocr::NativeOcrRegistry`
//! and `ocr::install_default_backends` resolve unchanged.

pub mod backend;
pub mod msix;
pub mod native;

pub use native::*;
