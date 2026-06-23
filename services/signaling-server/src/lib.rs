//! `cognia-signaling-server` library re-exports.
//!
//! The integration test in `tests/room_routing.rs` consumes [`serve_for_test`]
//! and the protocol types directly. The binary `src/main.rs` calls
//! [`server::serve`] after parsing CLI args.

pub mod ip_limits;
pub mod metrics;
pub mod room;
pub mod server;
pub mod ws;

// Protocol + rate-limiting primitives live in the wasm-safe
// `cognia-signaling-core` crate, shared with the Cloudflare Worker. Re-exported
// here so existing `crate::proto::*` / `crate::limits::*` paths and the
// integration tests in `tests/` keep resolving unchanged.
pub use cognia_signaling_core::{limits, proto};

pub use server::{
    router, serve, serve_for_test, serve_for_test_full, serve_for_test_with, AppState,
};

// Re-export the shared admission policy so `crate::policy::*` resolves in the
// integration tests alongside `crate::proto` / `crate::limits`.
pub use cognia_signaling_core::policy;
