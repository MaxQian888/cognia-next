//! Rust-runtime performance analysis subsystem.
//!
//! Three layers, surfaced together by the Task-Manager-style `/performance`
//! panel in the renderer:
//!
//! 1. **Process tree** ([`process`]) — per-process CPU / memory / disk for the
//!    main app, the Node sidecar, and any spawned children, via `sysinfo`.
//! 2. **Async runtime** ([`runtime`]) — Tokio `RuntimeMetrics` (worker busy %,
//!    alive tasks, queue depths) read off the dial9-traced runtime handle.
//! 3. **Span hotspots** ([`registry`] + [`span`]) — an opt-in, in-process
//!    metrics registry that records `count / p50 / p95 / max / errors` for
//!    coarse operation boundaries instrumented with [`guard`] / [`timed`].
//!
//! The [`sampler`] composes 1–3 into a [`sampler::PerfSample`] roughly once a
//! second and emits it over `perf://sample` — but only while the panel is open
//! (ref-counted start/stop), so there is no idle overhead.
//!
//! Span recording is two `Instant::now()` calls plus a tiny mutex section, so
//! it is cheap — but it is still meant for *coarse* boundaries (a sidecar send,
//! an OCR extract, a vector query), never per-iteration inner loops.

#![allow(dead_code)]

pub mod commands;
pub mod process;
pub mod runtime;
pub mod sampler;

// ADR-0067 Phase 1 — the span instrumentation API + registry moved into the
// `cognia-instrument` crate so the Tier-A leaf crates can share it without a
// dependency on the whole Tauri app. Re-export them under the original
// `crate::perf::{span,registry,guard,…}` paths so every in-tree call site
// (`crate::perf::guard`, `super::registry::REGISTRY`, `crate::perf::registry::…`)
// resolves unchanged.
// The span API is surfaced via the flattened `guard`/`record`/`timed`/… re-exports
// below, so only `registry` needs a module-path re-export.
pub use cognia_instrument::registry;

use std::sync::Arc;

// Public instrumentation API. Re-exported as the stable surface call sites use
// (`crate::perf::timed(...)` etc.); not every symbol has an in-tree caller yet,
// so silence the unused-import lint without dropping the API.
#[allow(unused_imports)]
pub use cognia_instrument::{guard, record, timed, timed_ok, Guard};

/// Convenience macro: `perf_span!("name");` drops a [`Guard`] at scope end.
/// Kept here (not in `cognia-instrument`) because it hard-codes the
/// `$crate::perf::guard` path of the app crate.
#[macro_export]
macro_rules! perf_span {
    ($name:expr) => {
        let _perf_guard = $crate::perf::guard($name);
    };
}

/// Milliseconds since the Unix epoch — the timestamp every sample carries.
pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Managed Tauri state holding the (ref-counted) sampler. The span registry is
/// a process-global static ([`registry::REGISTRY`]) so deep call sites can
/// instrument without threading `State` through every signature.
pub struct PerfState {
    pub sampler: Arc<sampler::SamplerHandle>,
}

impl PerfState {
    pub fn new() -> Self {
        Self {
            sampler: Arc::new(sampler::SamplerHandle::default()),
        }
    }
}

impl Default for PerfState {
    fn default() -> Self {
        Self::new()
    }
}
