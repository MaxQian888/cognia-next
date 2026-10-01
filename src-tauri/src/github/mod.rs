//! GitHub subsystem — Rust-side helpers for the GitHub Delivery plugin
//! (ADR-0018). The `workspace` module that backs `lib/github/workspace.ts`
//! lives in `cognia_git::github` (ADR-0196 P6); this re-export keeps the
//! `github::workspace::…` paths the command registry and the companion RPC
//! arms name.

pub use cognia_git::github::workspace;
pub mod runner;
