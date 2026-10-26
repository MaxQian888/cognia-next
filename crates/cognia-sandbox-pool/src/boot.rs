//! Installing the sandbox pool at boot (ADR-0182).
//!
//! [`wrap_exec_backend`] is the whole seam: a Host calls it with the execution
//! backend it already resolved, and gets either that same backend back or one
//! wrapped in the per-spawn router.
//!
//! # A deployment that has not opted in cannot be refused here
//!
//! With none of the runtime environment variables set, the baseline loads as
//! `Disabled` and this returns the caller's backend unchanged — the same
//! `Arc`, so nothing downstream can behave differently. Boot is refused only
//! when the operator set something: a baseline file that does not parse, an
//! unreadable `COGNIA_SANDBOX_POOL_ENABLED`, the switch on with no catalog, or
//! a switch on in a binary built without a driver. Every one of those is an
//! operator asking for sandboxes and not getting them, which is worth a loud
//! failure rather than a silent downgrade.
//!
//! # Remote providers join the same sandbox arm (ADR-0221)
//!
//! A providers file (`COGNIA_SANDBOX_PROVIDERS_FILE` on a server, the
//! "Remote sandboxes" settings on a desktop) adds remote members beside the
//! local Docker driver; the router then holds one [`ProviderSet`] instead of
//! the driver alone. A deployment with no providers installs exactly what it
//! did before. A providers file with the pool off is refused for the same
//! reason as everything above: it is an operator asking for sandboxes.

use std::path::Path;
use std::sync::Arc;

use cognia_environment::baseline::{load_baseline_from, BaselineInputs};
use cognia_environment::store::EnvironmentStore;
use cognia_external_agent::exec_backend::ExecBackend;
use cognia_external_agent::sandbox_routing_backend::{
    FallbackConfinement, SandboxExecBackend, SandboxRoutingBackend, LOCAL_PROVIDER_ID,
};

use crate::admission::{EnvironmentSandboxAdmission, SandboxAdmission};
use crate::providers::{
    remote_member, CredentialLookups, ProviderMember, ProviderSet, SandboxProvidersFile,
};
use crate::runtime::SandboxRuntimeControl;
use crate::status::SandboxDriverStatus;

/// The tenant environment store, beside the other Rust-owned databases.
pub const STORE_FILE: &str = "environment.sqlite";

pub use cognia_environment::policy::ExecutionSetting;

/// Pure boot decision: probing is a distinct stage so no single-user or
/// control-plane-only deployment contacts a runtime as part of preflight.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Preflight { Legacy, ControlPlaneOnly, ProbeRuntime, Ready }

pub struct PreflightInput<'a> {
    pub multi_tenant: bool,
    pub execution: Option<&'a str>,
    pub baseline: &'a cognia_environment::catalog::EnvironmentBaseline,
    pub runtime: Option<Result<&'a [cognia_environment::spec::IsolationTier], &'a str>>,
}

pub fn preflight(input: PreflightInput<'_>) -> Result<Preflight, String> {
    if ExecutionSetting::parse(input.execution)? == ExecutionSetting::Disabled {
        return Ok(Preflight::ControlPlaneOnly);
    }
    if !input.multi_tenant { return Ok(Preflight::Legacy); }
    if !input.baseline.multi_tenant {
        return Err("COGNIA_DEPLOYMENT_MODE=multi-tenant requires multiTenant=true in COGNIA_ENVIRONMENT_BASELINE_FILE".into());
    }
    if !input.baseline.sandbox_pool.enabled {
        return Err("COGNIA_DEPLOYMENT_MODE=multi-tenant requires sandboxPool.enabled=true in COGNIA_ENVIRONMENT_BASELINE_FILE (COGNIA_SANDBOX_POOL_ENABLED applies only without a file)".into());
    }
    // Reuse the catalog validator, including its gVisor/VM minimum; do not
    // create a second definition of a conforming multi-tenant baseline.
    input.baseline.validate().map_err(|error| format!("COGNIA_ENVIRONMENT_BASELINE_FILE: {error}"))?;
    let Some(runtime) = input.runtime else { return Ok(Preflight::ProbeRuntime); };
    let tiers = runtime.map_err(|error| format!("COGNIA_ENVIRONMENT_BASELINE_FILE isolationFloor runtime unavailable: {error}; configure a reachable sandbox runtime or COGNIA_EXECUTION=disabled"))?;
    if !tiers.iter().any(|tier| *tier >= input.baseline.isolation_floor) {
        return Err(format!("COGNIA_ENVIRONMENT_BASELINE_FILE isolationFloor={} has no available runtime; configure runsc for gvisor or a VM provider, or COGNIA_EXECUTION=disabled", input.baseline.isolation_floor.as_str()));
    }
    Ok(Preflight::Ready)
}

/// Headless boot boundary. Disabled execution skips pool configuration and
/// runtime probing entirely; the companion refuses execution entry points.
pub async fn install_for_deployment(
    existing: Arc<dyn ExecBackend>, data_dir: &Path, deployment_id: &str,
    multi_tenant: bool, execution: Option<&str>,
) -> Result<InstalledPool, String> {
    let setting = ExecutionSetting::parse(execution)?;
    if setting == ExecutionSetting::Disabled {
        return Ok(InstalledPool { backend: existing, services: None });
    }
    if !multi_tenant { return install(existing, data_dir, deployment_id); }
    let loaded = load_baseline_from(&BaselineInputs::from_process_env())
        .map_err(|error| format!("COGNIA_ENVIRONMENT_BASELINE_FILE: {error}"))?;
    preflight(PreflightInput { multi_tenant, execution, baseline: &loaded.baseline, runtime: None })?;
    let pool = install(existing, data_dir, deployment_id)?;
    let services = pool.services.as_ref().ok_or("COGNIA_ENVIRONMENT_BASELINE_FILE sandboxPool.enabled must install a sandbox driver")?;
    // Driver API is the same capability probe admission uses on first spawn:
    // Docker lists registered OCI runtimes (runsc); remote drivers probe tiers.
    let probe = match &services.providers {
        Some(providers) => providers.available_placement_tiers().await,
        None => services.status.available_tiers().await,
    }.map_err(|error| error.to_string());
    preflight(PreflightInput { multi_tenant, execution, baseline: services.admission.baseline(),
        runtime: Some(probe.as_deref().map_err(String::as_str)) })?;
    if !pool.backend.routes_sandboxes() { return Err("COGNIA_SANDBOX_POOL_ENABLED did not install sandbox routing".into()); }
    Ok(pool)
}

/// What the pool put in place.
///
/// A Host needs two things out of this seam: the execution backend to hand to
/// its process manager, and — only when the pool is actually on — the services
/// its companion API serves the catalog, the approvals and the driver status
/// from. Keeping them in one return value is what makes "the pool is off" a
/// single `None` the API layer can answer uniformly instead of a flag every
/// command re-derives.
pub struct InstalledPool {
    /// The caller's own backend when the pool is off, the router when it is on.
    pub backend: Arc<dyn ExecBackend>,
    /// `None` when this deployment did not turn the pool on.
    pub services: Option<PoolServices>,
}

/// The read and write surfaces the companion API needs.
#[derive(Clone)]
pub struct PoolServices {
    /// Baseline, tenant store and registry credentials — the same instance
    /// admission uses, so the API can never disagree with a spawn.
    pub admission: Arc<EnvironmentSandboxAdmission>,
    /// The driver, narrowed to what a status read may ask.
    pub status: Arc<dyn SandboxDriverStatus>,
    pub runtime: Option<Arc<dyn SandboxRuntimeControl>>,
    /// Every driver the router can place on, when remote providers are
    /// configured (ADR-0221); `None` when the local driver is the only one.
    pub providers: Option<Arc<ProviderSet>>,
}

/// Which local driver a Host installs beside its remote providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalDriver {
    /// The Docker driver, when this binary was built with it. A binary built
    /// without it runs a remote-only pool when providers are configured, and
    /// refuses boot when none are (there would be no driver at all).
    IfBuilt,
    /// No local driver: a remote-only pool (the desktop, ADR-0221 G7, whose
    /// local containers are a separate, still-dormant switch).
    None,
}

/// Everything [`install_with_inputs`] decides from.
pub struct PoolInputs<'a> {
    pub baseline: BaselineInputs,
    /// The remote providers, when the Host configured any.
    pub providers: Option<SandboxProvidersFile>,
    /// Where provider credentials are read from.
    pub lookups: CredentialLookups<'a>,
    pub local: LocalDriver,
    /// A desktop admits repository declarations against the brain's own
    /// trust row rather than a server-side approval record.
    pub device_approvals: bool,
    /// How a spawn that falls back onto `existing` is confined first (the
    /// desktop's OS sandbox launcher); `None` on a Host whose existing path
    /// needs nothing added.
    pub fallback_confinement: Option<FallbackConfinement>,
}

/// Install the pool: wrap `existing` in the sandbox router when this
/// deployment enabled it, or hand it straight back when it did not.
///
/// A server names its remote providers in `COGNIA_SANDBOX_PROVIDERS_FILE`;
/// their credentials come from its environment or files.
pub fn install(
    existing: Arc<dyn ExecBackend>,
    data_dir: &Path,
    default_deployment_id: &str,
) -> Result<InstalledPool, String> {
    let env = |name: &str| std::env::var(name).ok();
    let no_secrets = |_: &str| None;
    let providers = SandboxProvidersFile::from_env_lookup(env)
        .map_err(|error| format!("sandbox providers: {error}"))?;
    install_with_inputs(
        existing,
        PoolInputs {
            baseline: BaselineInputs::from_process_env(),
            providers,
            lookups: CredentialLookups {
                env: &env,
                secrets: &no_secrets,
            },
            local: LocalDriver::IfBuilt,
            device_approvals: false,
            fallback_confinement: None,
        },
        data_dir,
        default_deployment_id,
    )
}

/// Wrap `existing` in the sandbox router when this deployment enabled the
/// pool, or return it untouched when it did not.
pub fn wrap_exec_backend(
    existing: Arc<dyn ExecBackend>,
    data_dir: &Path,
    default_deployment_id: &str,
) -> Result<Arc<dyn ExecBackend>, String> {
    wrap_exec_backend_with(
        existing,
        &BaselineInputs::from_process_env(),
        data_dir,
        default_deployment_id,
    )
}

/// [`wrap_exec_backend`] against captured inputs, so the decision is testable
/// without touching the process environment.
pub fn wrap_exec_backend_with(
    existing: Arc<dyn ExecBackend>,
    inputs: &BaselineInputs,
    data_dir: &Path,
    default_deployment_id: &str,
) -> Result<Arc<dyn ExecBackend>, String> {
    install_with(existing, inputs, data_dir, default_deployment_id).map(|pool| pool.backend)
}

/// [`install`] against captured baseline inputs and no remote providers, so
/// the decision is testable without touching the process environment.
pub fn install_with(
    existing: Arc<dyn ExecBackend>,
    inputs: &BaselineInputs,
    data_dir: &Path,
    default_deployment_id: &str,
) -> Result<InstalledPool, String> {
    let none = |_: &str| None;
    install_with_inputs(
        existing,
        PoolInputs {
            baseline: inputs.clone(),
            providers: None,
            lookups: CredentialLookups {
                env: &none,
                secrets: &none,
            },
            local: LocalDriver::IfBuilt,
            device_approvals: false,
            fallback_confinement: None,
        },
        data_dir,
        default_deployment_id,
    )
}

/// The whole decision: the baseline, the local driver and the remote
/// providers, from captured inputs.
pub fn install_with_inputs(
    existing: Arc<dyn ExecBackend>,
    inputs: PoolInputs<'_>,
    data_dir: &Path,
    default_deployment_id: &str,
) -> Result<InstalledPool, String> {
    let loaded = load_baseline_from(&inputs.baseline)
        .map_err(|error| format!("{}: {error}", error.code()))?;
    for note in &loaded.notes {
        log::warn!("environment baseline: {}", note.message);
    }
    let providers = inputs
        .providers
        .filter(|file| !file.providers.is_empty());
    if let Some(file) = providers.as_ref() {
        file.validate()
            .map_err(|error| format!("sandbox providers: {error}"))?;
    }
    if !loaded.baseline.sandbox_pool.enabled {
        if providers.is_some() {
            return Err(
                "sandbox_providers_without_pool: remote sandbox providers are configured but \
                 the sandbox pool is off"
                    .into(),
            );
        }
        log::info!(
            "runtime environment sandboxes: off (baseline {})",
            loaded.origin.as_str()
        );
        return Ok(InstalledPool {
            backend: existing,
            services: None,
        });
    }

    let store = EnvironmentStore::open(&data_dir.join(STORE_FILE))
        .map_err(|error| format!("environment store: {error}"))?;
    let admission = Arc::new(EnvironmentSandboxAdmission::new_with_registry_lookup(
        loaded.baseline,
        store,
        |name| std::env::var(name).ok(),
        inputs.device_approvals,
    )?);
    let multi_tenant = admission.baseline().multi_tenant;

    let local = match inputs.local {
        LocalDriver::IfBuilt if cfg!(feature = "docker") || providers.is_none() => Some(
            docker_driver(Arc::clone(&admission), default_deployment_id, data_dir)?,
        ),
        LocalDriver::IfBuilt | LocalDriver::None => None,
    };

    let Some(file) = providers else {
        let Some((sandbox, status, runtime)) = local else {
            return Err(
                "sandbox_pool_without_driver: the sandbox pool is enabled but this Host has \
                 neither a local driver nor a remote provider"
                    .into(),
            );
        };
        log::info!(
            "runtime environment sandboxes: on (docker driver, baseline {}, multi-tenant {multi_tenant})",
            loaded.origin.as_str()
        );
        return Ok(InstalledPool {
            backend: SandboxRoutingBackend::with_fallback_confinement(
                existing,
                sandbox,
                inputs.fallback_confinement,
            ),
            services: Some(PoolServices {
                admission,
                status,
                runtime: Some(runtime),
                providers: None,
            }),
        });
    };

    let mut members = Vec::with_capacity(file.providers.len() + 1);
    if let Some((exec, status, runtime)) = local {
        members.push(ProviderMember {
            id: LOCAL_PROVIDER_ID.to_string(),
            label: None,
            exec,
            status,
            runtime: Some(runtime),
            limits: None,
        });
    }
    for provider in &file.providers {
        members.push(remote_member(
            provider,
            Arc::clone(&admission) as Arc<dyn SandboxAdmission>,
            crate::docker::DockerSandboxConfig::remote(default_deployment_id)?,
            &inputs.lookups,
            data_dir,
        )?);
    }
    // A Host with exactly one remote provider places `auto` there without
    // the operator having to name it.
    let default_remote = file.default_provider_id.clone().or_else(|| {
        (file.providers.len() == 1).then(|| file.providers[0].id.clone())
    });
    let set = ProviderSet::new(members, default_remote)?;
    log::info!(
        "runtime environment sandboxes: on (providers {}, baseline {}, multi-tenant {multi_tenant})",
        set.member_ids().collect::<Vec<_>>().join(", "),
        loaded.origin.as_str()
    );
    Ok(InstalledPool {
        backend: SandboxRoutingBackend::with_fallback_confinement(
            existing,
            Arc::clone(&set) as Arc<dyn SandboxExecBackend>,
            inputs.fallback_confinement,
        ),
        services: Some(PoolServices {
            admission,
            status: Arc::clone(&set) as Arc<dyn SandboxDriverStatus>,
            runtime: Some(Arc::clone(&set) as Arc<dyn SandboxRuntimeControl>),
            providers: Some(set),
        }),
    })
}

/// The driver, as both halves the Host needs: the one that starts agents and
/// the one that answers what it can attest.
type Driver = (
    Arc<dyn SandboxExecBackend>,
    Arc<dyn SandboxDriverStatus>,
    Arc<dyn SandboxRuntimeControl>,
);

#[cfg(feature = "docker")]
fn docker_driver(
    admission: Arc<EnvironmentSandboxAdmission>,
    default_deployment_id: &str,
    data_dir: &Path,
) -> Result<Driver, String> {
    use cognia_external_agent::container_backend::bollard_api::BollardContainerApi;

    let api = BollardContainerApi::connect()?;
    let config = crate::docker::DockerSandboxConfig::from_env(default_deployment_id)?;
    let backend = crate::docker::DockerSandboxBackend::new(api, admission, config);
    backend.configure_retained_tasks(data_dir)?;
    Ok((
        Arc::clone(&backend) as Arc<dyn SandboxExecBackend>,
        Arc::clone(&backend) as Arc<dyn SandboxDriverStatus>,
        backend,
    ))
}

#[cfg(not(feature = "docker"))]
fn docker_driver(
    _admission: Arc<EnvironmentSandboxAdmission>,
    _default_deployment_id: &str,
    _data_dir: &Path,
) -> Result<Driver, String> {
    Err("the sandbox pool is enabled but this binary was built without the `docker` feature".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_external_agent::exec_backend::LocalProcessBackend;

    #[test]
    fn deployment_preflight_covers_every_branch_without_runtime_io() {
        use cognia_environment::{catalog::EnvironmentBaseline, spec::IsolationTier};
        let mut baseline = EnvironmentBaseline::disabled();
        let check = |baseline: &EnvironmentBaseline, multi_tenant, execution, runtime| {
            preflight(PreflightInput { baseline, multi_tenant, execution, runtime })
        };
        assert_eq!(check(&baseline, false, None, None).unwrap(), Preflight::Legacy);
        assert!(check(&baseline, true, Some("invalid"), None).unwrap_err().contains("COGNIA_EXECUTION"));
        assert_eq!(check(&baseline, true, Some("disabled"), None).unwrap(), Preflight::ControlPlaneOnly);
        assert!(check(&baseline, true, None, None).unwrap_err().contains("multiTenant"));
        baseline.multi_tenant = true;
        assert_eq!(check(&baseline, false, None, None).unwrap(), Preflight::Legacy);
        assert!(check(&baseline, true, None, None).unwrap_err().contains("sandboxPool.enabled"));
        baseline.sandbox_pool.enabled = true;
        assert!(check(&baseline, true, None, None).unwrap_err().contains("isolation"));
        baseline = load_baseline_from(&BaselineInputs {
            sandbox_pool_enabled: Some("true".into()),
            runner_image: Some(format!("ghcr.io/acme/runner@sha256:{}", "1".repeat(64))),
            agent_bundle_image: Some(format!("ghcr.io/acme/bundle@sha256:{}", "2".repeat(64))),
            ..BaselineInputs::default()
        }).unwrap().baseline;
        baseline.multi_tenant = true;
        baseline.isolation_floor = IsolationTier::Gvisor;
        baseline.validate().unwrap();
        assert_eq!(check(&baseline, true, None, None).unwrap(), Preflight::ProbeRuntime);
        assert!(check(&baseline, true, None, Some(Err("daemon offline"))).unwrap_err().contains("daemon offline"));
        assert!(check(&baseline, true, None, Some(Ok(&[]))).unwrap_err().contains("isolationFloor"));
        assert!(check(&baseline, true, None, Some(Ok(&[IsolationTier::Container]))).is_err());
        assert_eq!(check(&baseline, true, None, Some(Ok(&[IsolationTier::Gvisor]))).unwrap(), Preflight::Ready);
        assert_eq!(check(&baseline, true, None, Some(Ok(&[IsolationTier::Vm]))).unwrap(), Preflight::Ready);
        baseline.isolation_floor = IsolationTier::Vm;
        assert!(check(&baseline, true, None, Some(Ok(&[IsolationTier::Gvisor]))).is_err());
        assert_eq!(check(&baseline, false, Some("disabled"), Some(Err("must not probe"))).unwrap(), Preflight::ControlPlaneOnly);
        assert_eq!(check(&baseline, false, None, Some(Err("must not probe"))).unwrap(), Preflight::Legacy);
    }

    #[tokio::test]
    async fn control_plane_only_does_not_read_a_baseline_or_install_a_pool() {
        let dir = tempfile::tempdir().unwrap();
        let existing: Arc<dyn ExecBackend> = Arc::new(cognia_external_agent::exec_backend::DisabledExecBackend);
        let pool = install_for_deployment(existing.clone(), dir.path(), "deployment", true, Some("disabled")).await.unwrap();
        assert!(Arc::ptr_eq(&existing, &pool.backend));
        assert!(pool.services.is_none());
        assert_eq!(pool.backend.kind(), "disabled");
        assert!(pool.backend.list().await.is_empty());
        assert!(pool.backend.reap_orphans().await.unwrap().is_empty());
        assert!(!dir.path().join(STORE_FILE).exists());
    }

    /// `expect_err` needs `Debug` on the success type, and an execution
    /// backend is a trait object.
    fn refusal(result: Result<Arc<dyn ExecBackend>, String>, expectation: &str) -> String {
        match result {
            Ok(_) => panic!("{expectation}"),
            Err(error) => error,
        }
    }

    fn inputs(switch: Option<&str>) -> BaselineInputs {
        BaselineInputs {
            sandbox_pool_enabled: switch.map(str::to_string),
            ..BaselineInputs::default()
        }
    }

    /// The off path returns the caller's own backend, not a wrapper that
    /// happens to behave the same: a router installed on a pool-off
    /// deployment is the one way this slice could change existing behaviour.
    #[test]
    fn a_deployment_that_set_nothing_gets_its_own_backend_back() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let existing: Arc<dyn ExecBackend> = LocalProcessBackend::new();
        let wrapped =
            wrap_exec_backend_with(Arc::clone(&existing), &inputs(None), dir.path(), "dep1")
                .expect("an unconfigured deployment boots");
        assert!(Arc::ptr_eq(&existing, &wrapped));
        assert!(!wrapped.routes_sandboxes());
        // Nothing was created beside it either.
        assert!(!dir.path().join(STORE_FILE).exists());
    }

    /// The companion API's "the pool is off" answer comes from this `None`,
    /// not from a second reading of the switch — so an off deployment must
    /// hand out no services at all, including no open store handle.
    #[test]
    fn an_off_deployment_exposes_no_pool_services() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let pool = install_with(
            LocalProcessBackend::new(),
            &inputs(None),
            dir.path(),
            "dep1",
        )
        .expect("an unconfigured deployment boots");
        assert!(pool.services.is_none());
    }

    /// An explicit `off` is still the off path, and still refuses nothing.
    #[test]
    fn an_explicit_off_switch_needs_no_catalog() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let existing: Arc<dyn ExecBackend> = LocalProcessBackend::new();
        let wrapped = wrap_exec_backend_with(
            Arc::clone(&existing),
            &inputs(Some("false")),
            dir.path(),
            "d",
        )
        .expect("an explicitly disabled pool boots");
        assert!(Arc::ptr_eq(&existing, &wrapped));
    }

    #[test]
    fn the_switch_on_without_a_catalog_refuses_boot() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let error = refusal(
            wrap_exec_backend_with(
                LocalProcessBackend::new(),
                &inputs(Some("1")),
                dir.path(),
                "d",
            ),
            "an operator asking for sandboxes must not be ignored",
        );
        assert!(
            error.starts_with("baseline_pool_without_catalog:"),
            "{error}"
        );
    }

    #[test]
    fn an_unreadable_switch_refuses_boot_rather_than_defaulting_to_off() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let error = refusal(
            wrap_exec_backend_with(
                LocalProcessBackend::new(),
                &inputs(Some("maybe")),
                dir.path(),
                "d",
            ),
            "a switch nobody can read is not a switch that is off",
        );
        assert!(error.starts_with("baseline_env_invalid:"), "{error}");
    }

    /// The pool on in a binary with no driver is refused, not downgraded.
    #[cfg(not(feature = "docker"))]
    #[test]
    fn the_switch_on_without_a_driver_refuses_boot() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let error = refusal(
            wrap_exec_backend_with(
                LocalProcessBackend::new(),
                &BaselineInputs {
                    sandbox_pool_enabled: Some("1".to_string()),
                    runner_image: Some(format!("ghcr.io/acme/runner@sha256:{}", "1".repeat(64))),
                    agent_bundle_image: Some(format!(
                        "ghcr.io/acme/bundle@sha256:{}",
                        "2".repeat(64)
                    )),
                    ..BaselineInputs::default()
                },
                dir.path(),
                "dep1",
            ),
            "a build with no driver cannot serve sandboxes",
        );
        assert!(
            error.contains("built without the `docker` feature"),
            "{error}"
        );
    }

    fn desktop_pool(
        dir: &Path,
        providers: SandboxProvidersFile,
    ) -> Result<InstalledPool, String> {
        let settings = crate::desktop::DesktopRemoteSandboxes {
            version: 1,
            providers: providers.clone(),
            registry_allowlist: Vec::new(),
        };
        let bundle = crate::desktop::pinned_bundle(Some(&format!(
            "ghcr.io/cognia/agent-bundle:v2.0.0@sha256:{}",
            "c".repeat(64)
        )));
        let baseline = crate::desktop::write_baseline(dir, &settings, bundle).unwrap();
        let none = |_: &str| None;
        let secrets = |id: &str| (id == "remote-sandbox:cloud").then(|| "e2b_test_key".to_string());
        install_with_inputs(
            LocalProcessBackend::new(),
            PoolInputs {
                baseline: BaselineInputs {
                    baseline_file: Some(baseline),
                    ..BaselineInputs::default()
                },
                providers: Some(providers),
                lookups: CredentialLookups {
                    env: &none,
                    secrets: &secrets,
                },
                local: LocalDriver::None,
                device_approvals: true,
                fallback_confinement: None,
            },
            dir,
            "dep1",
        )
    }

    fn cloud_provider() -> SandboxProvidersFile {
        SandboxProvidersFile::parse(
            br#"{"version":1,"providers":[{"id":"cloud","kind":"e2b",
                "credential":{"secretId":"remote-sandbox:cloud"},"settings":{}}]}"#,
        )
        .expect("a valid providers file")
    }

    fn install_refusal(result: Result<InstalledPool, String>, expectation: &str) -> String {
        match result {
            Ok(_) => panic!("{expectation}"),
            Err(error) => error,
        }
    }

    /// Providers with the pool off are an operator asking for sandboxes
    /// that would never start.
    #[test]
    fn providers_with_the_pool_off_refuse_boot() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let none = |_: &str| None;
        let error = install_refusal(
            install_with_inputs(
                LocalProcessBackend::new(),
                PoolInputs {
                    baseline: inputs(Some("false")),
                    providers: Some(cloud_provider()),
                    lookups: CredentialLookups {
                        env: &none,
                        secrets: &none,
                    },
                    local: LocalDriver::IfBuilt,
                    device_approvals: false,
                    fallback_confinement: None,
                },
                dir.path(),
                "dep1",
            ),
            "configured providers cannot be silently ignored",
        );
        assert!(error.starts_with("sandbox_providers_without_pool:"), "{error}");
    }

    /// An empty providers file is no providers: the off path is unchanged.
    #[test]
    fn an_empty_providers_file_keeps_the_off_path() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let none = |_: &str| None;
        let existing: Arc<dyn ExecBackend> = LocalProcessBackend::new();
        let pool = install_with_inputs(
            Arc::clone(&existing),
            PoolInputs {
                baseline: inputs(None),
                providers: Some(SandboxProvidersFile::empty()),
                lookups: CredentialLookups {
                    env: &none,
                    secrets: &none,
                },
                local: LocalDriver::IfBuilt,
                device_approvals: false,
                fallback_confinement: None,
            },
            dir.path(),
            "dep1",
        )
        .expect("an empty providers file boots");
        assert!(Arc::ptr_eq(&existing, &pool.backend));
        assert!(pool.services.is_none());
    }

    #[cfg(not(feature = "e2b"))]
    #[test]
    fn a_provider_kind_this_binary_lacks_refuses_boot_by_name() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let error = install_refusal(
            desktop_pool(dir.path(), cloud_provider()),
            "a provider this build cannot reach must not be dropped",
        );
        assert!(error.contains("provider cloud"), "{error}");
        assert!(error.contains("built without the `e2b` provider"), "{error}");
    }

    #[cfg(feature = "e2b")]
    #[tokio::test]
    async fn a_desktop_installs_a_remote_only_provider_set() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let pool = desktop_pool(dir.path(), cloud_provider()).expect("a desktop pool installs");
        assert!(pool.backend.routes_sandboxes());
        let services = pool.services.expect("the pool is on");
        assert!(services.admission.device_approvals());
        let set = services.providers.expect("remote providers form a set");
        assert!(!set.has_local());
        // The only remote provider is the default without being named.
        assert_eq!(set.default_remote(), Some("cloud"));
        assert_eq!(services.status.driver(), "e2b");
    }

    #[test]
    fn a_missing_provider_credential_refuses_boot() {
        let dir = tempfile::tempdir().expect("a temp data dir");
        let mut file = cloud_provider();
        file.providers[0].credential = Some(crate::providers::CredentialSource::SecretId(
            "remote-sandbox:missing".into(),
        ));
        let error = install_refusal(
            desktop_pool(dir.path(), file),
            "a provider without its credential cannot run",
        );
        assert!(error.contains("provider_credential_missing"), "{error}");
    }
}
