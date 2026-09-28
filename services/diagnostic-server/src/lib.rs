pub mod alert;
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

pub use alert::{AlertDispatcher, AlertWorker};
pub use api::{build_router, AppState};
pub use auth::{GrantClaims, GrantRole, GrantSigner};
pub use config::ServerConfig;
pub use db::DiagnosticRepository;
pub use privacy::{PrivacyGate, PrivacyScan};
pub use retention::RetentionWorker;
pub use storage::ArtifactStore;
pub use worker::{build_processor, DiagnosticProcessor};

/// Initialize TLS for callers that construct service clients without running `main`.
/// Keep an existing process-wide provider when the embedding host installed one.
pub fn ensure_crypto_provider() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn tls_clients_can_be_built_without_binary_startup() {
        super::ensure_crypto_provider();
        reqwest::Client::builder().build().unwrap();
        super::ensure_crypto_provider();
        reqwest::Client::builder().build().unwrap();
    }
}
