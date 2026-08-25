//! Tenant-scoped identity and authorization primitives — ADR-0149.
//!
//! This crate exists to answer one question, in Rust, the same way
//! `types/identity/index.ts` answers it in TypeScript: **may this person do
//! this thing in this workspace?** Before ADR-0149 the product had no entity
//! for a person at all, so authorization hung off hardware — ADR-0133 says
//! outright that removing a device grant is "the kick".
//!
//! # What is here
//!
//! - [`ids`] — `usr_…` / `org_…` parsing and validation, mirroring the
//!   TypeScript patterns byte for byte (there is a parity test).
//! - [`roles`] — the two frozen ladders (Org owner/admin/member, Workspace
//!   maintainer/member/viewer) and the capability they map to.
//! - [`membership`] — [`membership::resolve_workspace_access`], the Rust mirror
//!   of `resolveWorkspaceAccess`. The TypeScript one is documented as a UI
//!   affordance; **this one is the authorization decision.**
//! - [`rls`] — the Postgres session-variable contract shared by every
//!   tenant-scoped service, deliberately carrying no database driver so both
//!   the `sqlx` and the `tokio-postgres` services can use it.
//! - [`grant`] (feature `grants`) — minting and verifying the short-lived
//!   bearer grant a tenant-scoped service hands out.
//!
//! # What is deliberately NOT here, and why
//!
//! ADR-0149's roadmap described this crate as "merged from
//! `services/diagnostic-server/src/auth.rs` and
//! `crates/cognia-ops-controller/src/auth.rs`". That premise did not survive
//! contact with the two files: they share **no type, no function and no
//! constant**. They are two different auth designs for two different threat
//! models, not one design duplicated.
//!
//! - diagnostic-server verifies an OIDC session against a **static RSA PEM**,
//!   RS256 only, with `tenant_id: Uuid` and a four-rung role enum.
//! - ops-controller runs **JWKS discovery with a TTL cache** across nine
//!   algorithms, with `tenant_id: String` and a free-form scope set.
//!
//! Neither is wrong. Folding them together would mean picking one service's
//! threat model for the other, and they are additionally on incompatible
//! majors of `jsonwebtoken` (9 vs 11). So **the OIDC verification plane stays
//! where it is**, and this crate owns the layer above it: what the verified
//! token *means* once you have it.
//!
//! # Why diagnostic-server does not depend on this crate
//!
//! It cannot, yet. `.github/workflows/images.yml` builds its image with
//! `context: services/diagnostic-server`, so a `path = "../../crates/…"`
//! dependency resolves at `cargo test` time and then fails inside Docker,
//! where the parent directory does not exist. Changing a deploy pipeline's
//! build context to serve a refactor is a worse trade than leaving a
//! well-tested file where it is. ADR-0149 §7 priced this as a `rust-version`
//! split; that turned out to be a phantom (the Dockerfile builds on
//! `rust:1.95-bookworm` and the repo pins `channel = "1.95"` — the declared
//! `rust-version = "1.82"` is a floor nothing compiles at). The build context
//! is the real constraint.

pub mod ids;
pub mod membership;
pub mod rls;
pub mod roles;

#[cfg(feature = "grants")]
pub mod grant;

pub use ids::{IdError, OrgId, UserId};
pub use membership::{resolve_workspace_access, EffectiveWorkspaceAccess, WorkspaceAccessVia};
pub use roles::{OrgRole, RoleParseError, WorkspaceCapability, WorkspaceRole};
