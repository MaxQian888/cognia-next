//! GitHub subsystem — Rust-side helpers for the GitHub Delivery plugin
//! (ADR-0018). Today only hosts the `workspace` module that backs
//! `lib/github/workspace.ts`; future Rust ports of GitHub plumbing go here.

pub mod workspace;
