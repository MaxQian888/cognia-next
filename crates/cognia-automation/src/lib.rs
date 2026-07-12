//! Computer Use automation + execution sandbox (ADR-0020 / ADR-0028), extracted
//! from `app_lib` per ADR-0067 Phase 5.
//!
//! Three tightly-coupled modules that form one cyclic cluster
//! (`automation ↔ sandbox ↔ cua_sandbox`), so they share a crate. `app_lib`
//! re-aliases each (`pub use cognia_automation::automation as automation`, …)
//! so every `crate::{automation,sandbox,cua_sandbox}::…` path — including the
//! `generate_handler!` command entries and the `.manage()` state calls —
//! resolves unchanged. Instrumentation goes through `cognia-instrument`; atomic
//! file writes through `cognia-core::fs_atomic`.

pub mod automation;
pub mod cua_sandbox;
pub mod sandbox;
