pub mod api;
pub mod auth;
pub mod config;
pub mod crypto;
pub mod db;
pub mod kms;
pub mod model;
pub mod privacy;
pub mod processing;
pub mod retention;
pub mod storage;
pub mod worker;

pub use model::{
    fingerprint_incident, IncidentLimits, IncidentState, IncidentTransition, LimitViolation,
    ProcessingState,
};

pub use api::{build_router, AppState};
pub use auth::{GrantClaims, GrantRole, GrantSigner};
pub use config::ServerConfig;
pub use db::DiagnosticRepository;
pub use privacy::{PrivacyGate, PrivacyScan};
pub use retention::RetentionWorker;
pub use storage::ArtifactStore;
pub use worker::{build_processor, DiagnosticProcessor};
