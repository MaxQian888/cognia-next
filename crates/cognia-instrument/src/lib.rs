//! Process-global span instrumentation shared across cognia subsystem crates.
//!
//! Extracted from the desktop `perf` subsystem (ADR-0067) so that leaf crates
//! (`cognia-git`, `cognia-vector`, `cognia-ocr`, …) can instrument coarse
//! operation boundaries without depending on the whole Tauri app. The perf
//! panel in `app_lib` re-exports these symbols and reads [`registry::REGISTRY`],
//! which is a single process-global static — every crate that links this one
//! shares the same registry instance.

pub mod registry;
pub mod span;

// Public instrumentation API. Re-exported as the stable surface call sites use
// (`cognia_instrument::guard(...)` in leaf crates; `crate::perf::guard(...)` in
// `app_lib` via the re-export in `perf/mod.rs`).
#[allow(unused_imports)]
pub use span::{guard, record, timed, timed_ok, Guard};

/// Milliseconds since the Unix epoch — the timestamp every span observation
/// carries. Kept here (rather than in the perf panel) so [`registry`] has no
/// upward dependency; `app_lib::perf` keeps its own copy for the sampler.
pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
