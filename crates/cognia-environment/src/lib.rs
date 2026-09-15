//! Runtime environments (ADR-0182).
//!
//! - [`image`] — OCI image references and the digest-pinned form specs carry.
//! - [`spec`] — the `EnvironmentSpec` wire type, its structural validation and
//!   its RFC 8785 digest.
//! - [`catalog`] — the operator baseline, the tenant layer and the merge that
//!   lets a tenant append but never widen.
//! - [`approval`] — server-side approvals of repository declarations and
//!   project egress grants.
//! - [`policy`] — admission, and the fault rule (fall back unless isolation is
//!   mandatory).
//! - [`baseline`] — where the operator baseline comes from: a file, the
//!   legacy `COGNIA_RUNNER_IMAGE` mapping, or nothing (the pool stays off).
//! - [`registry`] — reading an image's digest, platforms and configured user
//!   from an OCI registry.
//! - `store` (feature `store`) — the tenant's `environment.sqlite`.

pub mod approval;
pub mod baseline;
pub mod catalog;
pub mod image;
pub mod policy;
pub mod registry;
pub mod spec;
#[cfg(feature = "store")]
pub mod store;
