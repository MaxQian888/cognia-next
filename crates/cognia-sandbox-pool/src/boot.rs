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

use std::path::Path;
use std::sync::Arc;

use cognia_environment::baseline::{load_baseline_from, BaselineInputs};
use cognia_environment::store::EnvironmentStore;
use cognia_external_agent::exec_backend::ExecBackend;
use cognia_external_agent::sandbox_routing_backend::{SandboxExecBackend, SandboxRoutingBackend};

use crate::admission::EnvironmentSandboxAdmission;

/// The tenant environment store, beside the other Rust-owned databases.
pub const STORE_FILE: &str = "environment.sqlite";

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
    let loaded =
        load_baseline_from(inputs).map_err(|error| format!("{}: {error}", error.code()))?;
    for note in &loaded.notes {
        log::warn!("environment baseline: {}", note.message);
    }
    if !loaded.baseline.sandbox_pool.enabled {
        log::info!(
            "runtime environment sandboxes: off (baseline {})",
            loaded.origin.as_str()
        );
        return Ok(existing);
    }

    let store = EnvironmentStore::open(&data_dir.join(STORE_FILE))
        .map_err(|error| format!("environment store: {error}"))?;
    let credentials = EnvironmentSandboxAdmission::credentials_from_env()?;
    // A shared Host approves repository declarations server-side; the
    // desktop's per-device approvals are the brain's own trust row, and that
    // path arrives with ADR-0147's device approval reference in ①.11.
    let admission = Arc::new(EnvironmentSandboxAdmission::new(
        loaded.baseline,
        store,
        credentials,
        false,
    ));
    let multi_tenant = admission.baseline().multi_tenant;
    let sandbox = docker_driver(admission, default_deployment_id)?;
    log::info!(
        "runtime environment sandboxes: on (docker driver, baseline {}, multi-tenant {multi_tenant})",
        loaded.origin.as_str()
    );
    Ok(SandboxRoutingBackend::new(existing, sandbox))
}

#[cfg(feature = "docker")]
fn docker_driver(
    admission: Arc<EnvironmentSandboxAdmission>,
    default_deployment_id: &str,
) -> Result<Arc<dyn SandboxExecBackend>, String> {
    use cognia_external_agent::container_backend::bollard_api::BollardContainerApi;

    let api = BollardContainerApi::connect()?;
    let config = crate::docker::DockerSandboxConfig::from_env(default_deployment_id)?;
    Ok(crate::docker::DockerSandboxBackend::new(
        api, admission, config,
    ))
}

#[cfg(not(feature = "docker"))]
fn docker_driver(
    _admission: Arc<EnvironmentSandboxAdmission>,
    _default_deployment_id: &str,
) -> Result<Arc<dyn SandboxExecBackend>, String> {
    Err("the sandbox pool is enabled but this binary was built without the `docker` feature".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_external_agent::exec_backend::LocalProcessBackend;

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
}
