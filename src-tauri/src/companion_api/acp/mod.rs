//! ACP server — cognia as an Agent Client Protocol agent.
//!
//! Exposes `GET /ws/acp` (JSON-RPC 2.0, one message per WS text frame) so
//! ACP clients — Zed, Neovim, JetBrains, or the `cognia acp` stdio bridge —
//! can drive cognia's Claude sessions. Inverse of the TypeScript ACP *client*
//! in `lib/ai/agent/external/acp-client.ts`, and deliberately speaks the same
//! protocol dialect (version 1).
//!
//! Module layout:
//! - [`types`]     — JSON-RPC envelope + ACP wire shapes.
//! - [`translate`] — sidecar `claude://message` events → ACP updates.
//! - [`registry`]  — per-connection sessions + process-wide resume index.
//! - [`handler`]   — axum WS handler and the connection loop.

pub mod handler;
pub mod registry;
pub mod translate;
pub mod types;

pub use handler::acp_handler;
