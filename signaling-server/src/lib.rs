//! `cognia-signaling-server` library re-exports.
//!
//! The integration test in `tests/room_routing.rs` consumes [`serve_for_test`]
//! and the protocol types directly. The binary `src/main.rs` calls
//! [`server::serve`] after parsing CLI args.

pub mod limits;
pub mod metrics;
pub mod proto;
pub mod room;
pub mod server;
pub mod ws;

pub use server::{router, serve, serve_for_test, AppState};
