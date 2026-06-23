//! Wasm-safe shared primitives for the cognia signaling rendezvous (ADR-0021).
//!
//! Consumed by both the native axum server (`cognia-signaling-server`) and the
//! Cloudflare Worker (`signaling-worker`). This crate is strictly `serde`-only
//! — no tokio, axum, or `std::time::Instant` — so it compiles unchanged to
//! `wasm32-unknown-unknown`. The native server pulls everything else (HTTP,
//! WebSocket, room registry) from its own crate; the Worker re-implements the
//! transport against Durable Objects but reuses these wire types and the rate
//! limiter verbatim.

pub mod limits;
pub mod policy;
pub mod proto;
