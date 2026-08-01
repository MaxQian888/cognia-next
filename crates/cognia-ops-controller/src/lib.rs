//! Cloud-neutral operations controller for Cognia server fleets.

mod agent_gateway;
mod api;
mod auth;
mod enrollment;
mod model;
mod store;

pub use agent_gateway::OperationSigner;
pub use api::{router, AppState};
pub use auth::{Authenticator, Claims, OidcAuthenticator, OidcConfig, TestAuthenticator};
pub use enrollment::{CertificateIssuer, IssuedCertificate, RcgenCertificateIssuer};
pub use model::*;
pub use store::{InMemoryStore, PgStore, Store};
