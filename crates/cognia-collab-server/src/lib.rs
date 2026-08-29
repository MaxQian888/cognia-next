//! The Cognia collaboration plane — ADR-0149 §6.
//!
//! # What this service is for
//!
//! Cognia's local data is single-owner and offline-first: one Dexie database
//! per LocalProfile, opened by one password. That model has no answer for two
//! people looking at the same board, and ADR-0149 deliberately does not try to
//! stretch it into one. This service is the other half — a **server-authoritative**
//! plane where the rows belong to an Org rather than to a laptop, and the client
//! keeps a read-only cache of them.
//!
//! Two consistency models, on purpose. Core local functionality keeps working
//! with no network; collaboration requires one. No attempt is made to unify them.
//!
//! # First cut: Issues
//!
//! Issues, and nothing else. They already had stable ids, an event stream and a
//! `human | agent | team` actor skeleton — the one thing missing was an id on
//! the actor, which is exactly what ADR-0149 §10 supersedes from ADR-0132.
//! Workspace metadata, Plans and Runs follow in Batch 7. Sessions and messages
//! are a second cut and are not in scope.
//!
//! # Shape
//!
//! - [`model`] — wire and storage types, including the actor whose id is
//!   **required**.
//! - [`store`] — a [`store::Store`] trait over [`store::InMemoryStore`] (tests)
//!   and [`store::PgStore`] (production, and the only one that enforces RLS).
//! - [`auth`] — the two-step chain: prove the grant, then resolve what its
//!   bearer may do on *this* request's target.
//! - [`api`] — the axum router, including the one door in:
//!   `POST /v1/orgs/{org_id}/grants` exchanges a verified OIDC access token for
//!   a five-minute grant. Every other route takes a grant and nothing else
//!   mints one.
//!
//! The exchange verifies the org named in the path *inside that org's own RLS
//! scope*, which is what lets it run without a privileged escape from
//! row-level security — otherwise answering "which org does this token belong
//! to" would require reading rows before any tenant is bound.
//!
//! Authorization is not implemented here. It is
//! `cognia_tenant_auth::resolve_workspace_access`, shared with the client so the
//! button the UI greys out and the request the server refuses are one decision
//! rather than two that drift.
//!
//! # Not encrypted end-to-end, and why
//!
//! ADR-0149 §6 rejects MLS-class group encryption for this plane: it would
//! destroy server-side search, notification and aggregation, and it would not
//! even be self-consistent, since ADR-0054 already states the local Dexie
//! database is not encrypted at rest. Protection here is per-tenant KMS
//! envelopes plus row-level security, the design `services/diagnostic-server`
//! already proved. The zero-knowledge share links of ADR-0037 remain a separate
//! capability and are untouched.

pub mod api;
pub mod auth;
pub mod chat;
pub mod chat_api;
pub mod chat_attachment_store;
pub mod chat_metrics;
pub mod chat_store;
pub mod model;
pub mod store;

pub use api::{router, AppState};
pub use store::{InMemoryStore, OperatorBootstrap, PgStore, Store};
