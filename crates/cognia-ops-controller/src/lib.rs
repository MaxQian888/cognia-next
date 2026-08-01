//! Cloud-neutral operations controller for Cognia server fleets.

mod api;
mod auth;
mod model;
mod store;

pub use api::{router, AppState};
pub use auth::{Authenticator, Claims, OidcAuthenticator, OidcConfig, TestAuthenticator};
pub use model::*;
pub use store::{InMemoryStore, PgStore, Store};
