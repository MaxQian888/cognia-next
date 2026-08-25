//! OIDC verification for the operations controller.
//!
//! The implementation moved to `cognia_tenant_auth::oidc` when
//! `cognia-collab-server` needed the same JWKS discovery to exchange a token
//! for a grant — ADR-0149 §7. This module stays as the crate-local name so
//! `api.rs`, `main.rs` and `lib.rs` keep importing `crate::auth::…`, and so the
//! controller's scope vocabulary (`servers:read`, `servers:operate`,
//! `servers:admin`) is still read from a file that belongs to the controller.
//!
//! Nothing about verification changed in the move; the shared copy simply
//! arrived with tests this one never had.

// `AuthError` is deliberately not re-exported: `mod auth` is private and
// `lib.rs` never listed it, so it was unreachable from outside this crate
// before the move too. Callers that need it take it from
// `cognia_tenant_auth::oidc` directly.
pub use cognia_tenant_auth::oidc::{
    Authenticator, Claims, OidcAuthenticator, OidcConfig, TestAuthenticator,
};
