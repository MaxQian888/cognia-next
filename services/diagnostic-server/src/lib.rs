pub mod api;
pub mod auth;
pub mod config;
pub mod db;
pub mod model;
pub mod privacy;
pub mod storage;

pub use model::{
    fingerprint_incident, IncidentLimits, IncidentState, IncidentTransition, LimitViolation,
    ProcessingState,
};

pub use api::{build_router, AppState};
pub use auth::{GrantClaims, GrantRole, GrantSigner};
pub use config::ServerConfig;
pub use db::DiagnosticRepository;
pub use privacy::{PrivacyGate, PrivacyScan};
pub use storage::ArtifactStore;
