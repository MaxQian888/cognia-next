//! Re-admitting a spec the brain resolved (ADR-0182).
//!
//! A [`SandboxPlacement`](cognia_external_agent::sandbox_routing_backend::SandboxPlacement)
//! carries the spec as JSON because it travelled through a client the Host
//! does not trust. Everything in it is re-read here against this Host's
//! baseline, tenant catalog, approvals and egress grants before a container is
//! created, and the admitted body is recorded so there is a record of what ran.
//!
//! The trait exists so the driver can be tested against a scripted admission
//! without a store, and so the Kubernetes pool (ADR-0184) admits identically.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use cognia_environment::approval::ApprovalRecord;
use cognia_environment::catalog::{EffectiveCatalog, EnvironmentBaseline};
use cognia_environment::policy::{self, Admission, AdmissionContext, AdmissionRefusal};
use cognia_environment::registry::{
    RegistryCredential, RegistryCredentials, REGISTRY_AUTH_FILE_ENV,
};
use cognia_environment::spec::{EnvironmentSource, EnvironmentSpec, IsolationTier};
use cognia_environment::store::EnvironmentStore;
use cognia_external_agent::container_backend::RegistryAuth;
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
use parking_lot::Mutex;
use serde_json::Value;

/// What Docker Hub's credential is addressed as in an `X-Registry-Auth`
/// header. `docker.io` is the reference spelling; the daemon wants the v1 API
/// URL, which is also what `docker login` writes into `config.json`.
pub const DOCKER_HUB_SERVER: &str = "https://index.docker.io/v1/";

/// A spec this Host admitted, with what admission decided about it.
#[derive(Debug, Clone, PartialEq)]
pub struct AdmittedSandbox {
    pub spec: EnvironmentSpec,
    pub admission: Admission,
}

/// Admission codes that describe the deployment rather than the request: the
/// pool switch is off, or there is no bundle to inject. Those are faults — the
/// run may fall back — and everything else admission says is a decision about
/// this spec, which a fallback would silently overrule.
const FAULT_CODES: [&str; 2] = ["sandbox_pool_disabled", "bundle_unavailable"];

/// Turn an admission refusal into a spawn error, keeping its code.
pub fn spawn_error(refusal: &AdmissionRefusal) -> SandboxSpawnError {
    if FAULT_CODES.contains(&refusal.code) {
        SandboxSpawnError::fault(refusal.code, refusal.message.clone())
    } else {
        SandboxSpawnError::refused(refusal.code, refusal.message.clone())
    }
}

/// What a sandbox driver needs from the environment authority.
pub trait SandboxAdmission: Send + Sync + 'static {
    /// This Host runs every agent in a sandbox: a fault refuses instead of
    /// falling back, because the existing path would run untrusted code in the
    /// server container beside another tenant's data.
    fn multi_tenant(&self) -> bool;

    /// Admit `spec` for a sandbox on a driver that can attest `available_tiers`.
    fn admit(
        &self,
        spec: &Value,
        available_tiers: &[IsolationTier],
    ) -> Result<AdmittedSandbox, SandboxSpawnError>;

    /// The credential for one pull, `None` for anonymous access.
    fn registry_auth(&self, registry: &str) -> Result<Option<RegistryAuth>, SandboxSpawnError>;

    /// A cached probe entry for (user image, bundle), in whatever shape the
    /// driver wrote. `None` when there is none or it cannot be read.
    fn cached_probe(&self, user_image_digest: &str, bundle_digest: &str) -> Option<Value>;

    /// Cache a probe entry. Best effort: a store that cannot record it costs a
    /// probe on the next spawn and nothing else.
    fn record_probe(&self, user_image_digest: &str, bundle_digest: &str, entry: &Value);

    /// Digests of every bundle this deployment still offers. Staged bundle
    /// volumes for anything else are garbage.
    fn offered_bundle_digests(&self) -> Vec<String>;
}

/// Admission against the operator baseline and the tenant store.
pub struct EnvironmentSandboxAdmission {
    baseline: EnvironmentBaseline,
    /// The store is `!Sync` (a `rusqlite::Connection`) and admission is short,
    /// synchronous and never awaits, so one lock around it is enough.
    store: Mutex<EnvironmentStore>,
    credentials: RegistryCredentials,
    device_approvals: bool,
}

impl EnvironmentSandboxAdmission {
    pub fn new(
        baseline: EnvironmentBaseline,
        store: EnvironmentStore,
        credentials: RegistryCredentials,
        device_approvals: bool,
    ) -> Self {
        Self {
            baseline,
            store: Mutex::new(store),
            credentials,
            device_approvals,
        }
    }

    /// Credentials from `COGNIA_REGISTRY_AUTH_FILE`, or none when it is unset.
    /// The same bytes the daemon or kubelet reads, so what this process can
    /// see metadata for is what a pull can fetch.
    pub fn credentials_from_env() -> Result<RegistryCredentials, String> {
        match std::env::var(REGISTRY_AUTH_FILE_ENV) {
            Ok(path) if !path.trim().is_empty() => {
                RegistryCredentials::load_file(Path::new(path.trim()))
                    .map_err(|error| format!("invalid {REGISTRY_AUTH_FILE_ENV}: {error}"))
            }
            _ => Ok(RegistryCredentials::empty()),
        }
    }

    pub fn baseline(&self) -> &EnvironmentBaseline {
        &self.baseline
    }

    /// Run `read` against the tenant store.
    ///
    /// The lock stays private: the companion API reads the catalog, the
    /// approvals and the probe cache out of the same connection admission
    /// uses, and two connections to one SQLite file would be two answers to
    /// "what did this tenant approve". The closure shape also keeps the guard
    /// off any `await`, which a returned guard could not promise.
    pub fn with_store<R>(&self, read: impl FnOnce(&mut EnvironmentStore) -> R) -> R {
        let mut store = self.store.lock();
        read(&mut store)
    }

    /// Whether this Host trusts per-device approvals (the desktop) rather than
    /// server-side ones. A shared Host answers `false`, and the approval
    /// commands are its authority.
    pub fn device_approvals(&self) -> bool {
        self.device_approvals
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// The store being unavailable is infrastructure, not an answer about the spec.
fn store_fault(error: impl std::fmt::Display) -> SandboxSpawnError {
    SandboxSpawnError::fault(
        "sandbox_store_unavailable",
        format!("the environment store could not be read: {error}"),
    )
}

impl SandboxAdmission for EnvironmentSandboxAdmission {
    fn multi_tenant(&self) -> bool {
        self.baseline.multi_tenant
    }

    fn admit(
        &self,
        spec: &Value,
        available_tiers: &[IsolationTier],
    ) -> Result<AdmittedSandbox, SandboxSpawnError> {
        let spec: EnvironmentSpec = serde_json::from_value(spec.clone()).map_err(|error| {
            SandboxSpawnError::refused(
                "spec_unreadable",
                format!("the runtime environment spec is not a valid spec: {error}"),
            )
        })?;

        let store = self.store.lock();
        let tenant_entries = store.list_tenant_entries().map_err(store_fault)?;
        let tenant_policy = store.tenant_policy().map_err(store_fault)?;
        let catalog = EffectiveCatalog::merge(&self.baseline, &tenant_entries, &tenant_policy);

        // Only a repo declaration is admitted against an approval, and only on
        // a shared Host: a desktop's authority is the brain's own trust row,
        // which is why `device_approvals` skips the lookup entirely.
        let approval: Option<ApprovalRecord> = match &spec.source {
            EnvironmentSource::RepoDeclaration { approval_ref, .. } if !self.device_approvals => {
                store.get_approval(approval_ref).map_err(store_fault)?
            }
            _ => None,
        };
        let egress_grant = store
            .active_egress_grant(&spec.project_id)
            .map_err(store_fault)?;

        let admission = policy::admit(
            &spec,
            &AdmissionContext {
                baseline: &self.baseline,
                catalog: &catalog,
                approval: approval.as_ref(),
                egress_grant: egress_grant.as_ref(),
                available_tiers,
                device_approvals: self.device_approvals,
            },
        )
        .map_err(|refusal| spawn_error(&refusal))?;

        // Recorded after admission, never before: the table is the record of
        // what this Host allowed to run, not of what was asked for.
        store
            .record_admitted_spec(&spec, now_secs())
            .map_err(store_fault)?;

        Ok(AdmittedSandbox { spec, admission })
    }

    fn registry_auth(&self, registry: &str) -> Result<Option<RegistryAuth>, SandboxSpawnError> {
        let credential = self
            .credentials
            .credential_for(registry)
            .map_err(|error| SandboxSpawnError::refused(error.code(), error.to_string()))?;
        Ok(credential.map(|credential| registry_auth(registry, credential)))
    }

    fn cached_probe(&self, user_image_digest: &str, bundle_digest: &str) -> Option<Value> {
        match self
            .store
            .lock()
            .get_probe(user_image_digest, bundle_digest)
        {
            Ok(entry) => entry,
            Err(error) => {
                log::warn!("probe cache read failed for {user_image_digest}: {error}");
                None
            }
        }
    }

    fn record_probe(&self, user_image_digest: &str, bundle_digest: &str, entry: &Value) {
        if let Err(error) =
            self.store
                .lock()
                .put_probe(user_image_digest, bundle_digest, entry, now_secs())
        {
            log::warn!("probe cache write failed for {user_image_digest}: {error}");
        }
    }

    fn offered_bundle_digests(&self) -> Vec<String> {
        self.baseline
            .bundle
            .iter()
            .flat_map(|policy| policy.offered())
            .map(|bundle| bundle.digest.clone())
            .collect()
    }
}

/// A parsed credential in the shape the daemon's `X-Registry-Auth` takes.
pub fn registry_auth(registry: &str, credential: RegistryCredential) -> RegistryAuth {
    let server_address = if registry.eq_ignore_ascii_case("docker.io") {
        DOCKER_HUB_SERVER.to_string()
    } else {
        registry.to_ascii_lowercase()
    };
    let mut auth = RegistryAuth {
        server_address,
        ..RegistryAuth::default()
    };
    match credential {
        RegistryCredential::Basic { username, password } => {
            auth.username = Some(username);
            auth.password = Some(password);
        }
        RegistryCredential::IdentityToken(token) => auth.identity_token = Some(token),
        RegistryCredential::RegistryToken(token) => auth.registry_token = Some(token),
    }
    auth
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_environment::baseline::{load_baseline_from, BaselineInputs};

    fn baseline() -> EnvironmentBaseline {
        // The legacy mapping is the one baseline a test can build without a
        // file: it is what a pool-enabled compose deployment derives.
        let inputs = BaselineInputs::from_lookup(|key| {
            Some(match key {
                "COGNIA_SANDBOX_POOL_ENABLED" => "1".to_string(),
                "COGNIA_RUNNER_IMAGE" => {
                    "ghcr.io/acme/runner@sha256:".to_string() + &"1".repeat(64)
                }
                "COGNIA_AGENT_BUNDLE_IMAGE" => {
                    "ghcr.io/acme/bundle@sha256:".to_string() + &"2".repeat(64)
                }
                _ => return None,
            })
        });
        load_baseline_from(&inputs)
            .expect("the legacy baseline loads")
            .baseline
    }

    fn admission(baseline: EnvironmentBaseline) -> EnvironmentSandboxAdmission {
        EnvironmentSandboxAdmission::new(
            baseline,
            EnvironmentStore::open_in_memory().expect("in-memory store"),
            RegistryCredentials::empty(),
            false,
        )
    }

    #[test]
    fn a_spec_that_is_not_a_spec_is_refused_not_faulted() {
        let error = admission(baseline())
            .admit(&serde_json::json!({ "version": 1 }), &[])
            .expect_err("an incomplete spec is not admissible");
        assert_eq!(error.code, "spec_unreadable");
        assert_eq!(
            error.kind,
            cognia_external_agent::sandbox_routing_backend::SandboxErrorKind::Refused
        );
    }

    #[test]
    fn a_deployment_with_the_pool_off_is_a_fault_so_the_run_can_fall_back() {
        let refusal = AdmissionRefusal {
            code: "sandbox_pool_disabled",
            message: "off".into(),
        };
        assert_eq!(
            spawn_error(&refusal).fallback_code(),
            "sandbox_fallback_pool_disabled"
        );
        let refused = AdmissionRefusal {
            code: "approval_missing",
            message: "no".into(),
        };
        assert_eq!(
            spawn_error(&refused).kind,
            cognia_external_agent::sandbox_routing_backend::SandboxErrorKind::Refused
        );
    }

    #[test]
    fn the_offered_bundles_are_what_a_volume_sweep_keeps() {
        let admission = admission(baseline());
        assert_eq!(
            admission.offered_bundle_digests(),
            vec!["sha256:".to_string() + &"2".repeat(64)]
        );
    }

    #[test]
    fn docker_hub_credentials_are_addressed_as_the_daemon_expects() {
        let auth = registry_auth(
            "docker.io",
            RegistryCredential::Basic {
                username: "user".into(),
                password: "secret".into(),
            },
        );
        assert_eq!(auth.server_address, DOCKER_HUB_SERVER);
        assert_eq!(auth.username.as_deref(), Some("user"));
        // A private registry is addressed by host, and a token credential
        // never lands in the basic-auth fields.
        let token = registry_auth("GHCR.io", RegistryCredential::IdentityToken("t".into()));
        assert_eq!(token.server_address, "ghcr.io");
        assert_eq!(token.identity_token.as_deref(), Some("t"));
        assert_eq!(token.password, None);
        // Debug must never print a secret: the driver logs pull failures.
        assert!(!format!("{:?}", auth).contains("secret"));
    }

    #[test]
    fn a_missing_credential_is_anonymous_not_an_error() {
        let admission = admission(baseline());
        assert_eq!(admission.registry_auth("ghcr.io").unwrap(), None);
    }
}
