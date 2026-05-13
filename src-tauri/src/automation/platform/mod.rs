//! Per-platform automation back-ends. Each target_os compiles exactly one
//! sub-module; the rest are absent from the build.

#[cfg(target_os = "windows")]
pub mod uia;

#[cfg(target_os = "macos")]
pub mod ax;

#[cfg(target_os = "linux")]
pub mod atspi;
