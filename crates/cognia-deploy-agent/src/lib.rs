//! Provider-neutral deployment agent with a signed, typed operation boundary.

mod client;
mod config;
mod driver;
mod executor;

pub use client::{decode_verifying_key, AgentRuntime};
pub use config::{AgentConfig, ComposeConfig, KubernetesConfig, PlatformConfig, TlsClientConfig};
pub use driver::{ComposeDriver, Driver, DriverError, KubernetesDriver, PlatformDriver};
pub use executor::{
    AgentExecutor, CompletedOperation, ExecutionOutcome, ExecutionState, StateStore,
};
