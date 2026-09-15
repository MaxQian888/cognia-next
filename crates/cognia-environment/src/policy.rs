//! Admission: the Rust re-validation of a spec the brain resolved (ADR-0182).
//!
//! The brain resolves; this decides. Every check here repeats something the
//! resolver already did, on purpose — the resolver runs in a process a paired
//! client can reach and a spec is only a request. A spec that passes is
//! admitted exactly as written; nothing here edits it.
//!
//! [`fault_disposition`] is the other half of the ADR's fault rule: when the
//! sandbox infrastructure is down, whether the run falls back to the existing
//! execution path or is refused.

use std::collections::BTreeSet;

use crate::approval::{runtime_fields_digest, ApprovalRecord, EgressGrant};
use crate::catalog::{EffectiveCatalog, EnvironmentBaseline, SizeClass};
use crate::spec::{EgressTier, EnvironmentSource, EnvironmentSpec, IsolationTier};

/// Why a spec is not admitted. `code` is stable and localized by the UI.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AdmissionRefusal {
    pub code: &'static str,
    pub message: String,
}

fn refuse(code: &'static str, message: impl Into<String>) -> AdmissionRefusal {
    AdmissionRefusal {
        code,
        message: message.into(),
    }
}

/// What admission needs beyond the spec.
pub struct AdmissionContext<'a> {
    pub baseline: &'a EnvironmentBaseline,
    pub catalog: &'a EffectiveCatalog,
    /// The approval named by a repo-declaration spec's `approvalRef`, looked
    /// up by the caller. Ignored for other sources.
    pub approval: Option<&'a ApprovalRecord>,
    /// The project's active egress grant, if any.
    pub egress_grant: Option<&'a EgressGrant>,
    /// Tiers the selected driver can attest right now, in any order.
    pub available_tiers: &'a [IsolationTier],
    /// True on the desktop, where approvals are per device and the brain's
    /// trust row is the authority (`approvalRef` = `device:<key>`).
    pub device_approvals: bool,
}

/// An admitted spec: the tier it will actually get and its size class.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admission {
    pub spec_digest: String,
    pub actual_tier: IsolationTier,
    pub size_class: SizeClass,
}

pub fn admit(
    spec: &EnvironmentSpec,
    ctx: &AdmissionContext<'_>,
) -> Result<Admission, AdmissionRefusal> {
    spec.validate_with_digest()
        .map_err(|error| refuse(error.code, format!("{} ({})", error.message, error.field)))?;

    if !ctx.catalog.pool_enabled {
        return Err(refuse(
            "sandbox_pool_disabled",
            "runtime environments are not enabled on this deployment",
        ));
    }

    match &spec.source {
        EnvironmentSource::ProjectSetting { catalog_entry_id }
        | EnvironmentSource::DeploymentDefault { catalog_entry_id } => {
            let Some(entry) = ctx.catalog.entry(catalog_entry_id) else {
                return Err(refuse(
                    "catalog_entry_unavailable",
                    format!("catalog entry {catalog_entry_id} is not available"),
                ));
            };
            if matches!(spec.source, EnvironmentSource::DeploymentDefault { .. })
                && ctx.catalog.default_entry_id.as_deref() != Some(catalog_entry_id.as_str())
            {
                return Err(refuse(
                    "catalog_default_changed",
                    "the deployment default changed after this spec was resolved",
                ));
            }
            let Some(pinned) = entry.entry.image.pinned() else {
                return Err(refuse(
                    "image_digest_not_pinned",
                    format!("catalog entry {catalog_entry_id} has not been resolved to a digest"),
                ));
            };
            if pinned != spec.image.pinned()
                || spec.image.catalog_entry_id.as_deref() != Some(catalog_entry_id.as_str())
            {
                return Err(refuse(
                    "spec_image_mismatch",
                    "the spec image is not the catalog entry's image",
                ));
            }
            if !entry.entry.size_class_ids.contains(&spec.size_class_id) {
                return Err(refuse(
                    "size_class_not_offered",
                    format!(
                        "size class {} is not offered by {catalog_entry_id}",
                        spec.size_class_id
                    ),
                ));
            }
            if spec.isolation.minimum < entry.effective_floor {
                return Err(refuse(
                    "isolation_below_floor",
                    format!(
                        "{catalog_entry_id} requires at least {}",
                        entry.effective_floor.as_str()
                    ),
                ));
            }
        }
        EnvironmentSource::RepoDeclaration {
            path,
            declaration_digest,
            approval_ref,
            ..
        } => {
            if ctx.device_approvals {
                if !approval_ref.starts_with("device:") {
                    return Err(refuse(
                        "approval_missing",
                        "a desktop spec must carry its device approval",
                    ));
                }
            } else {
                let Some(approval) = ctx.approval.filter(|approval| approval.id == *approval_ref)
                else {
                    return Err(refuse(
                        "approval_missing",
                        "the repository declaration has not been approved on this Host",
                    ));
                };
                if !approval.is_active() {
                    return Err(refuse("approval_revoked", "the approval was revoked"));
                }
                let runtime_digest = runtime_fields_digest(spec)
                    .map_err(|error| refuse(error.code, error.message))?;
                let image_matches = match (&approval.resolved_image, &approval.build_key) {
                    (Some(image), _) => *image == spec.image.pinned(),
                    (None, Some(key)) => spec.image.build_key.as_deref() == Some(key.as_str()),
                    (None, None) => false,
                };
                if approval.project_id != spec.project_id
                    || approval.path != *path
                    || approval.declaration_digest != *declaration_digest
                    || approval.runtime_fields_digest != runtime_digest
                    || !image_matches
                {
                    return Err(refuse(
                        "approval_mismatch",
                        "the declaration changed since it was approved",
                    ));
                }
            }
            let image = spec.image.pinned();
            let permitted = ctx
                .baseline
                .registry_allowlist
                .iter()
                .any(|rule| rule.matches(&image.registry, &image.repository));
            if !permitted {
                return Err(refuse(
                    "catalog_registry_not_allowlisted",
                    format!("{} is not on the registry allowlist", image.name()),
                ));
            }
            if spec.isolation.minimum < ctx.catalog.floor {
                return Err(refuse(
                    "isolation_below_floor",
                    format!("this Host requires at least {}", ctx.catalog.floor.as_str()),
                ));
            }
        }
    }

    let Some(size_class) = ctx.baseline.size_class(&spec.size_class_id) else {
        return Err(refuse(
            "size_class_unknown",
            format!("size class {} is not defined", spec.size_class_id),
        ));
    };
    if size_class.gpu.is_some() {
        // Dormant by design: GPU sandboxes are reserved in the model only.
        return Err(refuse(
            "gpu_not_supported",
            "GPU sandboxes are not available yet",
        ));
    }

    let Some(bundles) = &ctx.baseline.bundle else {
        return Err(refuse(
            "bundle_unavailable",
            "this deployment has no agent bundle configured",
        ));
    };
    let bundle_ok = if spec.bundle.pinned {
        bundles
            .retained
            .iter()
            .chain(std::iter::once(&bundles.current))
            .any(|bundle| {
                bundle.digest == spec.bundle.digest && bundle.release_tag == spec.bundle.release_tag
            })
    } else {
        bundles.current.digest == spec.bundle.digest
            && bundles.current.release_tag == spec.bundle.release_tag
    };
    if !bundle_ok {
        return Err(refuse(
            if spec.bundle.pinned {
                "bundle_pin_retired"
            } else {
                "bundle_not_current"
            },
            "the agent bundle is not one this deployment offers",
        ));
    }

    let presets: BTreeSet<&str> = ctx
        .baseline
        .egress_presets
        .iter()
        .map(|preset| preset.id.as_str())
        .collect();
    if let Some(unknown) = spec
        .egress
        .preset_ids
        .iter()
        .find(|id| !presets.contains(id.as_str()))
    {
        return Err(refuse(
            "egress_preset_unknown",
            format!("egress preset {unknown} is not defined"),
        ));
    }
    let grant = ctx
        .egress_grant
        .filter(|grant| grant.is_active() && grant.project_id == spec.project_id);
    if spec.egress.tier == EgressTier::On && grant.is_none_or(|grant| grant.tier != EgressTier::On)
    {
        return Err(refuse(
            "egress_open_requires_grant",
            "open egress needs an explicit grant for this project",
        ));
    }
    if !spec.egress.approved_domains.is_empty() {
        let granted: BTreeSet<String> = grant
            .map(|grant| {
                grant
                    .domains
                    .iter()
                    .map(|domain| domain.to_ascii_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        if let Some(missing) = spec
            .egress
            .approved_domains
            .iter()
            .find(|domain| !granted.contains(&domain.to_ascii_lowercase()))
        {
            return Err(refuse(
                "egress_domain_not_granted",
                format!("{missing} has not been granted for this project"),
            ));
        }
    }

    let Some(actual_tier) = ctx
        .available_tiers
        .iter()
        .copied()
        .filter(|tier| *tier >= spec.isolation.minimum)
        .min()
    else {
        return Err(refuse(
            "isolation_tier_unavailable",
            format!(
                "no sandbox of at least {} is available",
                spec.isolation.minimum.as_str()
            ),
        ));
    };

    Ok(Admission {
        spec_digest: spec.spec_digest.clone(),
        actual_tier,
        size_class: size_class.clone(),
    })
}

/// What an infrastructure fault does to a run (ADR-0182).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultDisposition {
    /// Run on the existing execution path and tell the user why.
    FallBack,
    /// Refuse: falling back would run untrusted code with weaker isolation
    /// than the project or Host requires.
    Refuse,
}

/// Isolation is mandatory — and a fault therefore refuses — on a multi-tenant
/// Host, for a project that set `requireSandbox`, and for a project that named
/// an explicit minimum tier.
pub fn fault_disposition(
    multi_tenant: bool,
    project_requires_sandbox: bool,
    explicit_minimum: Option<IsolationTier>,
) -> FaultDisposition {
    if multi_tenant || project_requires_sandbox || explicit_minimum.is_some() {
        FaultDisposition::Refuse
    } else {
        FaultDisposition::FallBack
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{ApprovalAuthority, ApprovalRecord};
    use crate::catalog::tests::{baseline, entry};
    use crate::catalog::{CatalogScope, GpuRequest, TenantPolicy};
    use crate::spec::tests::sample_spec;
    use crate::spec::{DeclarationFile, SpecBundle};

    const ALL_TIERS: [IsolationTier; 3] = [
        IsolationTier::Container,
        IsolationTier::Gvisor,
        IsolationTier::Vm,
    ];

    fn ctx_parts() -> (EnvironmentBaseline, EffectiveCatalog) {
        let base = baseline();
        let catalog = EffectiveCatalog::merge(&base, &[], &TenantPolicy::default());
        (base, catalog)
    }

    fn reseal(spec: &mut EnvironmentSpec) {
        spec.spec_digest = spec.compute_digest().unwrap();
    }

    fn admit_with(
        spec: &EnvironmentSpec,
        base: &EnvironmentBaseline,
        catalog: &EffectiveCatalog,
        approval: Option<&ApprovalRecord>,
        grant: Option<&EgressGrant>,
        tiers: &[IsolationTier],
    ) -> Result<Admission, &'static str> {
        admit(
            spec,
            &AdmissionContext {
                baseline: base,
                catalog,
                approval,
                egress_grant: grant,
                available_tiers: tiers,
                device_approvals: false,
            },
        )
        .map_err(|refusal| refusal.code)
    }

    fn grant(tier: EgressTier, domains: &[&str]) -> EgressGrant {
        EgressGrant {
            id: "grant-1".into(),
            project_id: "proj-1".into(),
            tier,
            domains: domains.iter().map(|d| d.to_string()).collect(),
            granted_by: "user-1".into(),
            granted_at: 1,
            revoked_at: None,
        }
    }

    #[test]
    fn a_catalog_spec_is_admitted_at_the_weakest_tier_that_satisfies_it() {
        let (base, catalog) = ctx_parts();
        let spec = sample_spec();
        let domains = grant(EgressTier::Allowlist, &["files.pythonhosted.org"]);
        let admission =
            admit_with(&spec, &base, &catalog, None, Some(&domains), &ALL_TIERS).unwrap();
        assert_eq!(admission.actual_tier, IsolationTier::Gvisor);
        assert_eq!(admission.size_class.id, "medium");
        assert_eq!(admission.spec_digest, spec.spec_digest);
    }

    #[test]
    fn the_pool_switch_gates_everything() {
        let (mut base, _) = ctx_parts();
        base.sandbox_pool.enabled = false;
        let catalog = EffectiveCatalog::merge(&base, &[], &TenantPolicy::default());
        assert_eq!(
            admit_with(&sample_spec(), &base, &catalog, None, None, &ALL_TIERS).unwrap_err(),
            "sandbox_pool_disabled"
        );
    }

    #[test]
    fn catalog_refusals() {
        let (base, catalog) = ctx_parts();
        let domains = grant(EgressTier::Allowlist, &["files.pythonhosted.org"]);
        let check = |mutate: &dyn Fn(&mut EnvironmentSpec)| {
            let mut spec = sample_spec();
            mutate(&mut spec);
            reseal(&mut spec);
            admit_with(&spec, &base, &catalog, None, Some(&domains), &ALL_TIERS).unwrap_err()
        };
        assert_eq!(
            check(&|s| s.source = EnvironmentSource::ProjectSetting {
                catalog_entry_id: "nope".into()
            }),
            "catalog_entry_unavailable"
        );
        assert_eq!(
            check(&|s| s.image.repository = "acme/other".into()),
            "spec_image_mismatch"
        );
        assert_eq!(
            check(&|s| s.size_class_id = "large".into()),
            "size_class_not_offered"
        );
        assert_eq!(
            check(&|s| s.bundle = SpecBundle {
                digest: format!("sha256:{}", "3".repeat(64)),
                release_tag: "v0.9".into(),
                pinned: true
            }),
            "bundle_pin_retired"
        );
        assert_eq!(
            check(&|s| s.egress.preset_ids.push("npm".into())),
            "egress_preset_unknown"
        );
        assert_eq!(
            check(&|s| s.egress.tier = EgressTier::On),
            "egress_open_requires_grant"
        );
        assert_eq!(
            check(&|s| s.egress.approved_domains.push("example.org".into())),
            "egress_domain_not_granted"
        );
    }

    #[test]
    fn a_tampered_spec_is_refused_before_policy() {
        let (base, catalog) = ctx_parts();
        let mut spec = sample_spec();
        spec.forward_ports.clear();
        assert_eq!(
            admit_with(&spec, &base, &catalog, None, None, &ALL_TIERS).unwrap_err(),
            "spec_digest_mismatch"
        );
    }

    #[test]
    fn floors_and_tier_availability() {
        let (mut base, _) = ctx_parts();
        base.entries[0].isolation_floor = IsolationTier::Vm;
        let catalog = EffectiveCatalog::merge(&base, &[], &TenantPolicy::default());
        let domains = grant(EgressTier::Allowlist, &["files.pythonhosted.org"]);
        let spec = sample_spec();
        assert_eq!(
            admit_with(&spec, &base, &catalog, None, Some(&domains), &ALL_TIERS).unwrap_err(),
            "isolation_below_floor"
        );

        let (base, catalog) = ctx_parts();
        assert_eq!(
            admit_with(
                &spec,
                &base,
                &catalog,
                None,
                Some(&domains),
                &[IsolationTier::Container]
            )
            .unwrap_err(),
            "isolation_tier_unavailable"
        );
        let admission = admit_with(
            &spec,
            &base,
            &catalog,
            None,
            Some(&domains),
            &[IsolationTier::Vm],
        )
        .unwrap();
        assert_eq!(
            admission.actual_tier,
            IsolationTier::Vm,
            "a stronger tier satisfies a weaker minimum"
        );
    }

    #[test]
    fn gpu_size_classes_are_dormant() {
        let (mut base, _) = ctx_parts();
        base.size_classes[0].gpu = Some(GpuRequest {
            count: 1,
            resource_name: "nvidia.com/gpu".into(),
        });
        let catalog = EffectiveCatalog::merge(&base, &[], &TenantPolicy::default());
        let domains = grant(EgressTier::Allowlist, &["files.pythonhosted.org"]);
        assert_eq!(
            admit_with(
                &sample_spec(),
                &base,
                &catalog,
                None,
                Some(&domains),
                &ALL_TIERS
            )
            .unwrap_err(),
            "gpu_not_supported"
        );
    }

    #[test]
    fn a_changed_deployment_default_is_refused() {
        let (base, catalog) = ctx_parts();
        let mut spec = sample_spec();
        spec.source = EnvironmentSource::DeploymentDefault {
            catalog_entry_id: "python-312".into(),
        };
        reseal(&mut spec);
        let domains = grant(EgressTier::Allowlist, &["files.pythonhosted.org"]);
        admit_with(&spec, &base, &catalog, None, Some(&domains), &ALL_TIERS).unwrap();

        let tenant = vec![entry(
            "node-22",
            CatalogScope::Tenant,
            "ghcr.io",
            "acme/node",
        )];
        let policy = TenantPolicy {
            default_entry_id: Some("node-22".into()),
            ..TenantPolicy::default()
        };
        let moved = EffectiveCatalog::merge(&base, &tenant, &policy);
        assert_eq!(
            admit_with(&spec, &base, &moved, None, Some(&domains), &ALL_TIERS).unwrap_err(),
            "catalog_default_changed"
        );
    }

    fn declared_spec() -> EnvironmentSpec {
        let mut spec = sample_spec();
        spec.source = EnvironmentSource::RepoDeclaration {
            file: DeclarationFile::Devcontainer,
            path: ".devcontainer/devcontainer.json".into(),
            remote: "https://github.com/acme/app".into(),
            commit_sha: "0123456789abcdef0123456789abcdef01234567".into(),
            declaration_digest: "d".repeat(64),
            approval_ref: "approval-1".into(),
        };
        spec.image.catalog_entry_id = None;
        spec.egress.approved_domains.clear();
        reseal(&mut spec);
        spec
    }

    fn approval_for(spec: &EnvironmentSpec) -> ApprovalRecord {
        ApprovalRecord {
            id: "approval-1".into(),
            project_id: spec.project_id.clone(),
            normalized_remote: "https://github.com/acme/app".into(),
            path: ".devcontainer/devcontainer.json".into(),
            declaration_digest: "d".repeat(64),
            resolved_image: Some(spec.image.pinned()),
            build_key: None,
            runtime_fields_digest: runtime_fields_digest(spec).unwrap(),
            approver_user_id: "maintainer-1".into(),
            via: ApprovalAuthority::WorkspaceMaintainer,
            approved_at: 1,
            revoked_at: None,
            revoked_by: None,
        }
    }

    #[test]
    fn a_repo_declaration_needs_a_matching_active_approval() {
        let (base, catalog) = ctx_parts();
        let spec = declared_spec();
        let approval = approval_for(&spec);
        admit_with(&spec, &base, &catalog, Some(&approval), None, &ALL_TIERS).unwrap();

        assert_eq!(
            admit_with(&spec, &base, &catalog, None, None, &ALL_TIERS).unwrap_err(),
            "approval_missing"
        );
        let mut revoked = approval.clone();
        revoked.revoked_at = Some(9);
        assert_eq!(
            admit_with(&spec, &base, &catalog, Some(&revoked), None, &ALL_TIERS).unwrap_err(),
            "approval_revoked"
        );

        let mut changed = spec.clone();
        changed.container_env.insert("NEW".into(), "1".into());
        reseal(&mut changed);
        assert_eq!(
            admit_with(&changed, &base, &catalog, Some(&approval), None, &ALL_TIERS).unwrap_err(),
            "approval_mismatch",
            "a runtime field added after approval invalidates it"
        );

        let mut other_image = spec.clone();
        other_image.image.digest = format!("sha256:{}", "9".repeat(64));
        reseal(&mut other_image);
        assert_eq!(
            admit_with(
                &other_image,
                &base,
                &catalog,
                Some(&approval),
                None,
                &ALL_TIERS
            )
            .unwrap_err(),
            "approval_mismatch"
        );
    }

    #[test]
    fn a_repo_declaration_still_obeys_the_registry_allowlist_and_floor() {
        let (base, catalog) = ctx_parts();
        let mut spec = declared_spec();
        spec.image.registry = "docker.io".into();
        spec.image.repository = "library/ubuntu".into();
        reseal(&mut spec);
        let approval = approval_for(&spec);
        assert_eq!(
            admit_with(&spec, &base, &catalog, Some(&approval), None, &ALL_TIERS).unwrap_err(),
            "catalog_registry_not_allowlisted"
        );

        let mut strict = baseline();
        strict.isolation_floor = IsolationTier::Vm;
        let strict_catalog = EffectiveCatalog::merge(&strict, &[], &TenantPolicy::default());
        let spec = declared_spec();
        let approval = approval_for(&spec);
        assert_eq!(
            admit_with(
                &spec,
                &strict,
                &strict_catalog,
                Some(&approval),
                None,
                &ALL_TIERS
            )
            .unwrap_err(),
            "isolation_below_floor"
        );
    }

    #[test]
    fn desktop_specs_carry_a_device_approval() {
        let (base, catalog) = ctx_parts();
        let mut spec = declared_spec();
        let ctx = |spec: &EnvironmentSpec| {
            admit(
                spec,
                &AdmissionContext {
                    baseline: &base,
                    catalog: &catalog,
                    approval: None,
                    egress_grant: None,
                    available_tiers: &ALL_TIERS,
                    device_approvals: true,
                },
            )
            .map_err(|refusal| refusal.code)
        };
        assert_eq!(ctx(&spec).unwrap_err(), "approval_missing");
        if let EnvironmentSource::RepoDeclaration { approval_ref, .. } = &mut spec.source {
            *approval_ref = "device:/Users/me/app".into();
        }
        reseal(&mut spec);
        ctx(&spec).unwrap();
    }

    #[test]
    fn faults_fall_back_only_when_isolation_is_optional() {
        assert_eq!(
            fault_disposition(false, false, None),
            FaultDisposition::FallBack
        );
        assert_eq!(
            fault_disposition(true, false, None),
            FaultDisposition::Refuse
        );
        assert_eq!(
            fault_disposition(false, true, None),
            FaultDisposition::Refuse
        );
        assert_eq!(
            fault_disposition(false, false, Some(IsolationTier::Container)),
            FaultDisposition::Refuse
        );
    }
}
