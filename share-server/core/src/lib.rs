//! Pure shared primitives for the cognia self-hosted share service (ADR-0037).
//!
//! This crate mirrors the role `cognia-signaling-core` plays for the signaling
//! server: it holds the *decisions* (envelope validation, share lifecycle,
//! origin gating, code generation, per-IP rate limiting) as side-effect-free
//! functions so they are unit-tested once, in isolation from axum and SQLite.
//!
//! Unlike the signaling core it is **not** compiled to wasm — the share Worker
//! is TypeScript, so the shared contract is the HTTP API, not the code. The
//! split is kept anyway for the same reason it helps signaling: the lifecycle
//! rules are the subtle part, and testing them without a server or a database
//! keeps them honest.

pub mod codegen;
pub mod limits;
pub mod policy;
pub mod proto;
