//! Remote sandbox providers (ADR-0221).
//!
//! A remote provider is not a second pool. It supplies two things to the one
//! sandbox driver ([`crate::docker::DockerSandboxBackend`]):
//!
//! - the container surface the driver already drives a Docker daemon through
//!   ([`SandboxDockerApi`]): exec with attached stdio, ownership labels,
//!   inspection, deletion. Every bridge, port tunnel, persistent session and
//!   orphan sweep runs over it unchanged;
//! - [`RemoteProvisioner`]: creating an instance of the user's image with the
//!   agent bundle already at `/cognia`, because a provider has no named
//!   volumes to stage the bundle into and no Host workspace to mount.
//!
//! Every instance runs `cognia-sandboxd serve` as its supervisor, and every
//! agent is one `connect-agent` session of it — the persistent model, used for
//! both lifecycles. The supervisor is started only after the workspace has
//! been cloned ([`RemoteProvisioner::release_supervisor`]), because `serve`
//! runs the devcontainer lifecycle hooks when it starts and they expect the
//! repository to be there.

use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use cognia_environment::catalog::SizeClass;
use cognia_environment::image::PinnedImage;
use cognia_environment::spec::{EgressTier, IsolationTier};
use cognia_external_agent::container_backend::{RegistryAuth, SandboxDockerApi};
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;

#[cfg(feature = "e2b")]
pub mod e2b;
#[cfg(feature = "kubernetes")]
pub mod kubernetes;
#[cfg(test)]
pub(crate) mod fake;

/// The in-sandbox loopback port the workspace git proxy is bridged to. Fixed,
/// so the clone's `origin` stays valid for the agent's own `git fetch`/`push`
/// and across a Host restart that re-opens the bridge.
pub const GIT_PROXY_SANDBOX_PORT: u16 = 47821;

/// The marker a Kubernetes instance's start gate waits for before it execs the
/// supervisor (`cognia-sandboxd await-start`). Root-owned, created by
/// `cognia-sandboxd release-start` over exec.
pub const START_MARKER: &str = "/tmp/cognia-sandboxd/start";

/// What one provider may spend (ADR-0221 "Bounded by construction").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RemoteLimits {
    /// Live instances at once. A spawn that cannot get one within
    /// [`CAPACITY_WAIT`] is a fault, and the ADR-0182 fault rule decides.
    pub max_concurrent: u32,
    /// Hard lifetime of an instance, also written into the provider's TTL.
    pub max_lifetime: Duration,
    /// How long a persistent instance with no session is kept.
    pub idle_timeout: Duration,
}

/// How long a spawn waits for a provider slot before it is a capacity fault.
pub const CAPACITY_WAIT: Duration = Duration::from_secs(30);

/// The egress a provider must enforce for one instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EgressPlan {
    pub tier: EgressTier,
    /// Hostnames (`example.com`, `*.example.com`) an `allowlist` permits:
    /// the spec's baseline presets plus its approved domains. Empty for the
    /// other tiers.
    pub domains: Vec<String>,
}

/// Everything a provider needs to create one instance.
#[derive(Clone, Debug)]
pub struct ProvisionRequest {
    /// A deterministic name derived from the runtime key, at most 63
    /// characters of `[a-z0-9-]`, starting with a letter.
    pub name: String,
    /// Ownership and identity labels ([`cognia_external_agent::container_backend::ownership_labels`]
    /// plus the runtime key, project, spec digest and persistence). The
    /// provider must return them verbatim from `labels`/`list_owned`, however
    /// it stores them.
    pub labels: BTreeMap<String, String>,
    /// The user image, digest-pinned.
    pub image: PinnedImage,
    /// Pull credentials for `image`. Present only when the registry needs
    /// them and the provider may receive them
    /// ([`RemoteProvisioner::may_receive_registry_credentials`]).
    pub registry_auth: Option<RegistryAuth>,
    /// The agent bundle image, digest-pinned, and its release tag.
    pub bundle: PinnedImage,
    /// Pull credentials for `bundle`, under the same rule as `registry_auth`.
    pub bundle_registry_auth: Option<RegistryAuth>,
    pub bundle_release_tag: String,
    /// The tier admission settled on; the provider must run at least this.
    pub tier: IsolationTier,
    pub size: SizeClass,
    pub egress: EgressPlan,
    /// Hard lifetime: written into the provider's own TTL, so a Host that
    /// dies cannot leak a running instance past it.
    pub lifetime: Duration,
    /// The supervisor's absolute argv (`/cognia/bin/cognia-sandboxd serve …`).
    pub supervisor: Vec<String>,
    /// `KEY=VALUE` environment for the supervisor: the encoded boot runtime
    /// configuration. Never contains a credential.
    pub supervisor_env: Vec<String>,
}

/// Creating instances. Implemented beside [`SandboxDockerApi`] by every
/// remote provider.
#[async_trait]
pub trait RemoteProvisioner: Send + Sync + 'static {
    /// Stable kind, as the console labels the driver: `kubernetes`, `e2b`.
    fn kind(&self) -> &'static str;

    /// Tiers this provider can attest right now. A failure is the provider
    /// being unreachable (a fault), not an answer about isolation.
    async fn tiers(&self) -> Result<Vec<IsolationTier>, SandboxSpawnError>;

    /// Whether this provider enforces `tier`. An unenforced `allowlist` is
    /// refused on a mandatory-isolation run and labelled
    /// `egress.enforced: false` otherwise.
    fn egress_enforced(&self, tier: EgressTier) -> bool;

    /// Whether pull credentials for `registry` may be handed to this provider.
    /// A Kubernetes cluster the operator runs may hold them; a third-party
    /// cloud receives them only for registries the operator delegated.
    fn may_receive_registry_credentials(&self, registry: &str) -> bool;

    /// Create the instance and return its id once exec into it works. The
    /// bundle is at `/cognia` (core and both libc trees), `/workspace` exists,
    /// is empty and writable by any uid, and the supervisor is NOT running
    /// yet. Refused for an answer about the request (an image the provider
    /// cannot run), a fault for the provider being unavailable.
    async fn provision(&self, request: &ProvisionRequest) -> Result<String, SandboxSpawnError>;

    /// Start the supervisor `provision` prepared, once. Returns when it has
    /// been started; readiness is the driver's `health` poll.
    async fn release_supervisor(
        &self,
        instance: &str,
        request: &ProvisionRequest,
    ) -> Result<(), SandboxSpawnError>;

    /// What this provider's own API can preserve. The Host intersects it with
    /// what it implements for remote runtimes, so a provider can only narrow,
    /// never widen, the snapshot surface. Default: nothing.
    fn snapshot_capabilities(&self) -> crate::runtime::SnapshotCapabilities {
        crate::runtime::SnapshotCapabilities::default()
    }
}

/// A remote provider: the container surface plus provisioning.
pub trait RemoteProvider: SandboxDockerApi + RemoteProvisioner {}
impl<T: SandboxDockerApi + RemoteProvisioner> RemoteProvider for T {}

/// A DNS-1123 label from a runtime key: `cognia-<prefix>-<hex>`, 63 at most.
pub fn instance_name(prefix: &str, runtime_key: &str) -> String {
    let prefix: String = prefix
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let prefix = prefix.trim_matches('-');
    let prefix = if prefix.is_empty() { "sbx" } else { prefix };
    let prefix: String = prefix.chars().take(20).collect();
    let prefix = prefix.trim_end_matches('-');
    let hex: String = runtime_key
        .chars()
        .filter(char::is_ascii_hexdigit)
        .map(|c| c.to_ascii_lowercase())
        .take(32)
        .collect();
    format!("cognia-{prefix}-{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_names_are_dns_labels_derived_from_the_key() {
        let key = "A".repeat(64);
        let name = instance_name("Deploy_1", &key);
        assert_eq!(name, format!("cognia-deploy-1-{}", "a".repeat(32)));
        assert!(name.len() <= 63);
        assert!(name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));

        let long = instance_name(&"x".repeat(80), &key);
        assert!(long.len() <= 63, "{long}");
        assert_eq!(instance_name("--", &key), format!("cognia-sbx-{}", "a".repeat(32)));
    }
}
