//! Who may call the companion and what they may do (ADR-0196 P4).
//!
//! The SQLite security ledger and the identity resolved against it, the deny
//! list and elevated grants, service tokens and OIDC validation, step-up
//! leases, rate limits, replay and idempotency caches, the audit trail, the
//! long-running operation documents and the deployment-mode boundary. None of
//! it reads companion state; the companion core and its RPC families call in.
//!
//! The desktop's `companion_api` module re-exports every module here at its
//! old path.

pub mod admin_lease;
pub mod audit;
pub mod deny_list;
pub mod deployment;
pub mod device_grants;
pub mod host_identity;
pub mod idempotency;
pub mod jwt;
pub mod oidc;
pub mod operations;
pub mod principal;
pub mod rate_limit;
pub mod replay_cache;
pub mod secret;
pub mod security_store;
