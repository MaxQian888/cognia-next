//! Per-platform automation back-ends. Each target_os compiles exactly one
//! main sub-module (uia / ax / atspi); the rest are absent from the build.
//! `shared` is compiled on every target — it owns the parts that don't
//! depend on platform-specific accessibility APIs (screenshot is the
//! canonical example; xcap works on Windows, macOS, and Linux out of the
//! box).

pub mod shared;

#[cfg(target_os = "windows")]
pub mod uia;

#[cfg(target_os = "macos")]
pub mod ax;

#[cfg(target_os = "linux")]
pub mod atspi;
