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

use std::time::{SystemTime, UNIX_EPOCH};

use cognia_environment::approval::ApprovalRecord;
use cognia_environment::catalog::{EffectiveCatalog, EnvironmentBaseline};
use cognia_environment::policy::{self, Admission, AdmissionContext, AdmissionRefusal};
use cognia_environment::registry::{
    RegistryCredential, RegistryCredentials, RegistryError, REGISTRY_AUTH_FILE_ENV,
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

    /// Revalidate current authority without recording another execution.
    fn recheck(
        &self,
        spec: &Value,
        available_tiers: &[IsolationTier],
    ) -> Result<AdmittedSandbox, SandboxSpawnError> {
        self.admit(spec, available_tiers)
    }

    /// The credential for one pull, `None` for anonymous access.
    fn registry_auth(&self, registry: &str) -> Result<Option<RegistryAuth>, SandboxSpawnError>;

    /// Previously admitted body used to re-check persisted container authority.
    fn stored_spec(&self, _digest: &str) -> Option<Value> {
        None
    }

    /// Resolve the exact daemon reference after admission. Built images are
    /// local Docker IDs and must never be pulled as registry manifests.
    fn runtime_image(&self, spec: &EnvironmentSpec) -> Result<String, SandboxSpawnError> {
        spec.image
            .registry_image()
            .map(|image| image.canonical())
            .ok_or_else(|| {
                SandboxSpawnError::refused(
                    "build_record_missing",
                    "this admission cannot attest a local build",
                )
            })
    }

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
    credentials: RegistryCredentialSource,
    device_approvals: bool,
}

type RegistryConfigLookup = dyn Fn(&str) -> Option<String> + Send + Sync;

enum RegistryCredentialSource {
    Fixed(RegistryCredentials),
    Lookup(Box<RegistryConfigLookup>),
}

fn credential_load_error(error: RegistryError) -> SandboxSpawnError {
    // Serde errors can include the offending value. Auth files contain
    // secrets, so only the stable code and a fixed explanation may escape.
    SandboxSpawnError::refused(
        error.code(),
        format!("the configured {REGISTRY_AUTH_FILE_ENV} could not be loaded"),
    )
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
            credentials: RegistryCredentialSource::Fixed(credentials),
            device_approvals,
        }
    }

    /// Resolve the configured auth file again for every pull, so credential
    /// rotation takes effect without restarting this Host. Validate once at
    /// boot too; an invalid initial configuration must still fail startup.
    pub fn new_with_registry_lookup(
        baseline: EnvironmentBaseline,
        store: EnvironmentStore,
        lookup: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
        device_approvals: bool,
    ) -> Result<Self, String> {
        RegistryCredentials::from_lookup(&lookup)
            .map_err(|error| credential_load_error(error).message)?;
        let mut admission = Self::new(
            baseline,
            store,
            RegistryCredentials::empty(),
            device_approvals,
        );
        admission.credentials = RegistryCredentialSource::Lookup(Box::new(lookup));
        Ok(admission)
    }

    /// Credentials from `COGNIA_REGISTRY_AUTH_FILE`, or none when it is unset.
    /// The same bytes the daemon or kubelet reads, so what this process can
    /// see metadata for is what a pull can fetch.
    pub fn credentials_from_env() -> Result<RegistryCredentials, String> {
        RegistryCredentials::from_lookup(|name| std::env::var(name).ok())
            .map_err(|error| credential_load_error(error).message)
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

    fn admit_internal(
        &self,
        spec: &Value,
        available_tiers: &[IsolationTier],
        record_execution: bool,
    ) -> Result<AdmittedSandbox, SandboxSpawnError> {
        let spec: EnvironmentSpec = serde_json::from_value(spec.clone()).map_err(|error| {
            SandboxSpawnError::refused(
                "spec_unreadable",
                format!("the runtime environment spec is not a valid spec: {error}"),
            )
        })?;

        self.runtime_image(&spec)?;
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
        if record_execution {
            store
                .record_admitted_spec(&spec, now_secs())
                .map_err(store_fault)?;
        }

        Ok(AdmittedSandbox { spec, admission })
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
    fn stored_spec(&self, digest: &str) -> Option<Value> {
        let admitted = self.store.lock().get_admitted_spec(digest).ok()??;
        serde_json::to_value(admitted.spec).ok()
    }

    fn runtime_image(&self, spec: &EnvironmentSpec) -> Result<String, SandboxSpawnError> {
        let Some(key) = spec.image.build_key() else {
            return Ok(spec.image.identity());
        };
        let Some(image_id) = spec.image.image_id() else {
            return Err(SandboxSpawnError::refused(
                "build_identity_invalid",
                "built images must use the explicit local image identity",
            ));
        };
        let record = self
            .store
            .lock()
            .get_build(key)
            .map_err(store_fault)?
            .ok_or_else(|| {
                SandboxSpawnError::refused(
                    "build_record_missing",
                    "this Host has not recorded that build",
                )
            })?;
        let source_matches = match &spec.source {
            EnvironmentSource::RepoDeclaration {
                path,
                commit_sha,
                declaration_digest,
                ..
            } => {
                *path == record.declaration_path
                    && *commit_sha == record.commit_sha
                    && *declaration_digest == record.declaration_digest
            }
            _ => false,
        };
        if record.project_id != spec.project_id || record.image_id != image_id || !source_matches {
            return Err(SandboxSpawnError::refused(
                "build_record_mismatch",
                "the local build does not match this project and declaration",
            ));
        }
        Ok(record.image_id)
    }

    fn multi_tenant(&self) -> bool {
        self.baseline.multi_tenant
    }

    fn admit(
        &self,
        spec: &Value,
        available_tiers: &[IsolationTier],
    ) -> Result<AdmittedSandbox, SandboxSpawnError> {
        self.admit_internal(spec, available_tiers, true)
    }

    fn recheck(
        &self,
        spec: &Value,
        available_tiers: &[IsolationTier],
    ) -> Result<AdmittedSandbox, SandboxSpawnError> {
        self.admit_internal(spec, available_tiers, false)
    }

    fn registry_auth(&self, registry: &str) -> Result<Option<RegistryAuth>, SandboxSpawnError> {
        let loaded;
        let credentials = match &self.credentials {
            RegistryCredentialSource::Fixed(credentials) => credentials,
            RegistryCredentialSource::Lookup(lookup) => {
                loaded = RegistryCredentials::from_lookup(lookup).map_err(credential_load_error)?;
                &loaded
            }
        };
        let credential = credentials
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
    fn recheck_reads_fresh_revocation_without_recording_an_execution() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../protocol/environment-spec-fixtures.json"
        ))
        .unwrap();
        let mut spec: EnvironmentSpec =
            serde_json::from_value(fixtures["cases"][0]["spec"].clone()).unwrap();
        let base = baseline();
        let image = &base.entries[0].image;
        spec.image = cognia_environment::spec::RegistrySpecImage {
            registry: image.registry.clone(),
            repository: image.repository.clone(),
            digest: image.digest.clone().unwrap(),
            catalog_entry_id: None,
            build_key: None,
        }
        .into();
        let bundle = &base.bundle.as_ref().unwrap().current;
        spec.bundle.digest = bundle.digest.clone();
        spec.bundle.release_tag = bundle.release_tag.clone();
        spec.size_class_id = base.size_classes[0].id.clone();
        spec.source = serde_json::from_value(serde_json::json!({"kind":"repo-declaration","file":"devcontainer","path":".devcontainer/devcontainer.json","remote":"https://example.com/repo","commitSha":"c".repeat(40),"declarationDigest":"d".repeat(64),"approvalRef":"approval"})).unwrap();
        spec.spec_digest = spec.compute_digest().unwrap();
        let approval = ApprovalRecord {
            id: "approval".into(),
            project_id: spec.project_id.clone(),
            normalized_remote: "https://example.com/repo".into(),
            path: ".devcontainer/devcontainer.json".into(),
            declaration_digest: "d".repeat(64),
            resolved_image: spec.image.registry_image(),
            build_key: None,
            runtime_fields_digest: cognia_environment::approval::runtime_fields_digest(&spec)
                .unwrap(),
            approver_user_id: "maintainer".into(),
            via: cognia_environment::approval::ApprovalAuthority::WorkspaceMaintainer,
            approved_at: 1,
            revoked_at: None,
            revoked_by: None,
        };
        let authority = admission(base);
        authority.with_store(|store| {
            store.record_approval(&approval).unwrap();
            store.record_admitted_spec(&spec, 1).unwrap();
        });
        let value = serde_json::to_value(&spec).unwrap();
        authority
            .recheck(&value, &[IsolationTier::Container])
            .unwrap();
        assert_eq!(
            authority.with_store(|store| store
                .get_admitted_spec(&spec.spec_digest)
                .unwrap()
                .unwrap()
                .last_admitted_at),
            1
        );
        authority.with_store(|store| store.revoke_approval("approval", "maintainer", 2).unwrap());
        assert_eq!(
            authority
                .recheck(&value, &[IsolationTier::Container])
                .unwrap_err()
                .code,
            "approval_revoked"
        );
    }

    #[test]
    fn local_image_requires_exact_host_record_project_and_source() {
        use cognia_environment::store::EnvironmentBuildRecord;
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../protocol/environment-spec-fixtures.json"
        ))
        .unwrap();
        let mut spec: EnvironmentSpec =
            serde_json::from_value(fixtures["cases"][0]["spec"].clone()).unwrap();
        spec.image=serde_json::from_value(serde_json::json!({"kind":"build","buildKey":"a".repeat(64),"imageId":format!("sha256:{}","b".repeat(64))})).unwrap();
        spec.source=serde_json::from_value(serde_json::json!({"kind":"repo-declaration","file":"devcontainer","path":".devcontainer/devcontainer.json","remote":"https://example.com/repo","commitSha":"c".repeat(40),"declarationDigest":"d".repeat(64),"approvalRef":"approval"})).unwrap();
        let admission = admission(baseline());
        assert_eq!(
            admission.runtime_image(&spec).unwrap_err().code,
            "build_record_missing"
        );
        let record = EnvironmentBuildRecord {
            build_key: "a".repeat(64),
            image_id: format!("sha256:{}", "b".repeat(64)),
            project_id: spec.project_id.clone(),
            commit_sha: "c".repeat(40),
            declaration_path: ".devcontainer/devcontainer.json".into(),
            declaration_digest: "d".repeat(64),
            declaration_bytes_sha256: "e".repeat(64),
            source_hash: "f".repeat(64),
            runtime_configuration: serde_json::json!({}),
            cli_version: "0.89.0".into(),
            platform: "linux/arm64".into(),
            created_at: 1,
        };
        admission
            .with_store(|store| store.record_build(&record))
            .unwrap();
        assert_eq!(admission.runtime_image(&spec).unwrap(), record.image_id);
        spec.project_id = "other".into();
        assert_eq!(
            admission.runtime_image(&spec).unwrap_err().code,
            "build_record_mismatch"
        );
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

    #[test]
    fn registry_credentials_file_is_live_and_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let write = |token: &str| {
            std::fs::write(
                &path,
                serde_json::to_vec(&serde_json::json!({
                    "auths": { "ghcr.io": { "registrytoken": token } }
                }))
                .unwrap(),
            )
            .unwrap();
        };
        write("first-secret");
        let configured_path = path.clone();
        let admission = EnvironmentSandboxAdmission::new_with_registry_lookup(
            baseline(),
            EnvironmentStore::open_in_memory().unwrap(),
            move |_| Some(configured_path.display().to_string()),
            false,
        )
        .unwrap();
        assert_eq!(
            admission
                .registry_auth("ghcr.io")
                .unwrap()
                .unwrap()
                .registry_token
                .as_deref(),
            Some("first-secret")
        );
        write("second-secret");
        let auth = admission.registry_auth("ghcr.io").unwrap().unwrap();
        assert_eq!(auth.registry_token.as_deref(), Some("second-secret"));
        assert!(!format!("{auth:?}").contains("second-secret"));

        let replacement = dir.path().join("auth.next.json");
        std::fs::write(
            &replacement,
            r#"{"auths":{"ghcr.io":{"registrytoken":"atomic-secret"}}}"#,
        )
        .unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert_eq!(
            admission
                .registry_auth("ghcr.io")
                .unwrap()
                .unwrap()
                .registry_token
                .as_deref(),
            Some("atomic-secret")
        );

        // A schema error may itself quote the offending input. The spawn
        // error must never copy those credential bytes into a log or event.
        std::fs::write(&path, r#"{"auths":{"ghcr.io":"private-secret"}}"#).unwrap();
        let error = admission.registry_auth("ghcr.io").unwrap_err();
        assert_eq!(error.code, "registry_auth_file_invalid");
        assert!(!format!("{error:?}").contains("private-secret"));

        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            admission.registry_auth("ghcr.io").unwrap_err().code,
            "registry_auth_file_invalid"
        );
        write("recovered-secret");
        assert_eq!(
            admission
                .registry_auth("ghcr.io")
                .unwrap()
                .unwrap()
                .registry_token
                .as_deref(),
            Some("recovered-secret")
        );
    }

    #[test]
    fn live_registry_configuration_is_checked_at_boot_and_each_pull() {
        use std::sync::Arc;

        let configured = Arc::new(Mutex::new(None::<String>));
        let lookup = Arc::clone(&configured);
        let admission = EnvironmentSandboxAdmission::new_with_registry_lookup(
            baseline(),
            EnvironmentStore::open_in_memory().unwrap(),
            move |_| lookup.lock().clone(),
            false,
        )
        .unwrap();
        assert_eq!(admission.registry_auth("ghcr.io").unwrap(), None);
        *configured.lock() = Some("  ".into());
        assert_eq!(admission.registry_auth("ghcr.io").unwrap(), None);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-yet-created.json");
        *configured.lock() = Some(path.display().to_string());
        assert_eq!(
            admission.registry_auth("ghcr.io").unwrap_err().code,
            "registry_auth_file_invalid"
        );
        let initial_error = EnvironmentSandboxAdmission::new_with_registry_lookup(
            baseline(),
            EnvironmentStore::open_in_memory().unwrap(),
            move |_| Some(path.display().to_string()),
            false,
        );
        assert!(
            initial_error.is_err(),
            "boot must reject an unreadable configured file"
        );
        *configured.lock() = None;
        assert_eq!(admission.registry_auth("ghcr.io").unwrap(), None);
    }
}
