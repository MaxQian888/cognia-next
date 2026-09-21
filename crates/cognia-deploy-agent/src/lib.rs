//! Provider-neutral deployment agent with a signed, typed operation boundary.

mod client;
mod config;
mod driver;
mod enroll;
mod executor;

/// Ensure a process-wide rustls `CryptoProvider` exists.
///
/// The library is used directly by integration tests and embedders that never
/// execute the binary's `main`; `reqwest` resolves the installed provider at
/// `Client` construction. `Once` makes repeat calls free.
pub(crate) fn ensure_crypto_provider() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

pub use client::{decode_verifying_key, AgentRuntime};
pub use config::{
    AgentConfig, ComposeConfig, ExternalSnapshotAdapterConfig, KubernetesConfig, PlatformConfig,
    TlsClientConfig,
};
pub use driver::{ComposeDriver, Driver, DriverError, KubernetesDriver, PlatformDriver};
pub use enroll::{enroll, EnrollmentOptions};
pub use executor::{
    AgentExecutor, CompletedOperation, ExecutionOutcome, ExecutionState, StateStore,
};
