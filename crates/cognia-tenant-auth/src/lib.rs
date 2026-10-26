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
//! `cognia-services/services/diagnostic-server/src/auth.rs` and
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
//! majors of `jsonwebtoken` (9 vs 11). So diagnostic-server's static-PEM
//! verification stays where it is, and this crate owns the layer above it:
//! what the verified token *means* once you have it.
//!
//! **Amended when `cognia-collab-server` landed.** The JWKS half did move here,
//! as [`oidc`], behind a feature — but for a reason ADR-0149 did not have.
//! Not because two services had duplicated it (they had not), but because a
//! third was about to write a third copy in order to exchange an OIDC token for
//! a grant. One consumer is not a shared crate; two are. It arrived with the
//! tests the original never had.
//!
//! # Why diagnostic-server does not depend on this crate
//!
//! It cannot: the diagnostic server lives in cognia-labs/cognia-services
//! (`services/diagnostic-server`) and builds its image with its own directory
//! as the Docker context, so a path dependency on this crate cannot resolve
//! there. ADR-0149 §7 priced this as a `rust-version` split; that turned out
//! to be a phantom (the Dockerfile builds on the same pinned toolchain — the
//! declared `rust-version = "1.82"` is a floor nothing compiles at). The
//! repository boundary is the real constraint; the RLS parity test in [`rls`]
//! reads that service from a checkout of the pinned revision.

pub mod actions;
pub mod ids;
pub mod membership;
pub mod rls;
pub mod roles;

#[cfg(feature = "grants")]
pub mod grant;

#[cfg(feature = "oidc")]
pub mod oidc;

pub use ids::{IdError, OrgId, UserId};
pub use membership::{resolve_workspace_access, EffectiveWorkspaceAccess, WorkspaceAccessVia};
pub use roles::{OrgRole, RoleParseError, WorkspaceCapability, WorkspaceRole};
