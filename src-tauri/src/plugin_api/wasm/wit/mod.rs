//! Per-version host bindings. Picked by `host.rs::version_linker` after the
//! component's `cognia:api-version` custom section is parsed.
//!
//! v0.1.0 is the only version today; adding `since_v0_2.rs` for a future
//! breaking change is a tracked exercise — the version-router pattern is
//! already in place so we don't regress to a single-linker design.

pub mod since_v0_1;
