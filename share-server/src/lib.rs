//! `cognia-share-server` library re-exports.
//!
//! The integration tests in `tests/` consume [`serve_for_test`] and
//! [`Config`]; the binary `src/main.rs` calls [`server::serve`] after parsing
//! CLI args. Pure policy / codegen / rate-limit primitives live in the
//! `cognia-share-core` crate, re-exported here so `crate::policy::*` etc.
//! resolve in tests.

pub mod handlers;
pub mod ip_limits;
pub mod metrics;
pub mod reaper;
pub mod server;
pub mod store;

pub use cognia_share_core::{codegen, limits, policy, proto};

pub use server::{build_state, router, serve, serve_for_test, AppState, Config};
