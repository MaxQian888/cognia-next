//! The host side of runtime environment sandboxes (ADR-0182/0183).
//!
//! - [`admission`] — re-admitting a spec the brain resolved against this
//!   Host's baseline, tenant catalog and approvals, and the registry
//!   credentials a pull needs.
//! - [`boot`] — the one seam a Host calls: wrap the execution backend in the
//!   per-spawn router, or hand it straight back when the pool is off.
//! - [`command`] — which bundled file a spawn's command maps onto.
//! - [`probe_cache`] — what a cached probe records, written by the driver and
//!   read back by a console through one type.
//! - [`docker`] — the Step ① driver: one container per agent, on a single
//!   Docker daemon, with the agent bundle injected through named volumes.
//!   Needs the `docker` feature, which brings the bollard client with it.
//! - [`status`] — what a driver can tell a console about itself.
//!
//! Nothing here is installed unless the deployment turned the sandbox pool on.
//! With the pool off, `cognia-external-agent` has no router and this crate is
//! dead weight in the binary — which is the point: the existing execution
//! paths cannot change behaviour because of code that never runs.

pub mod admission;
pub mod boot;
pub mod build;
pub mod command;
pub mod docker;
pub mod probe_cache;
pub mod status;
pub mod runtime;
