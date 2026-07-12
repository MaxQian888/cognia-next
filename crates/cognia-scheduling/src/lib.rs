//! System scheduler + visual workflow engine + timing/cron triggers
//! (ADR-0002 / ADR-0011), extracted from `app_lib` per ADR-0067 Phase 6.
//!
//! Three tightly-coupled modules forming one cyclic cluster
//! (`scheduler ↔ workflow ↔ timing`), so they share a crate. `app_lib`
//! re-aliases each so `crate::{scheduler,workflow,timing}::…` paths — including
//! `generate_handler!` entries and `.manage()` state — resolve unchanged. The
//! shared command error type lives in `cognia-core`; `scheduler/error.rs` owns
//! the `From<SchedulerError> for CommandError` impl (orphan-rule: SchedulerError
//! is local here).

pub mod scheduler;
pub mod timing;
pub mod workflow;
