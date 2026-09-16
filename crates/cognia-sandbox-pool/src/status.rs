//! What a driver can tell a console about itself (ADR-0182).
//!
//! Admission answers questions about a *spec*; this answers questions about
//! the *driver*: which isolation tiers it can actually attest, and whether its
//! infrastructure is reachable at all. The companion API serves it so the UI
//! can show a real tier instead of the one a project asked for, and so an
//! operator who turned the pool on can see why nothing starts.
//!
//! It is a separate trait from [`crate::admission::SandboxAdmission`] and from
//! `SandboxExecBackend` on purpose: a status read must never be able to start
//! anything, and the companion API holds only this half.

use async_trait::async_trait;
use cognia_environment::spec::IsolationTier;
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;

/// The driver half of a pool status read.
#[async_trait]
pub trait SandboxDriverStatus: Send + Sync {
    /// Stable identifier for the driver, as the console labels it.
    fn driver(&self) -> &'static str;

    /// The ownership scope this driver reaps and labels containers with.
    fn deployment_id(&self) -> &str;

    /// The instance within the deployment, so two instances on one daemon are
    /// distinguishable in the console.
    fn instance_id(&self) -> &str;

    /// Tiers the driver can attest right now. A fault here is the
    /// infrastructure being unreachable, not an answer about isolation, so
    /// callers report it as such rather than showing an empty tier list.
    async fn available_tiers(&self) -> Result<Vec<IsolationTier>, SandboxSpawnError>;
}
