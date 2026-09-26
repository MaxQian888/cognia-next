//! Twin subsystem — Rust-side helpers for the Employee Digital Twin pipeline
//! (ADR-0003). The `code_repo` importer lives in `cognia_git` (ADR-0196 P6);
//! this re-export keeps the `twin::code_repo::…` path the command registry
//! names.

pub use cognia_git::code_repo;
