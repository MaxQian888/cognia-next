//! The two-level image catalog (ADR-0182).
//!
//! The **baseline** is the operator's: entries, the registry allowlist, the
//! isolation floor, size classes, egress presets, internal egress exceptions
//! and the agent bundles a release retains. It arrives from the Ops Controller
//! as a signed operation, or from a file on a standalone deployment.
//!
//! The **tenant** layer is the runtime authority's additions: extra entries
//! and a tenant policy. It may narrow what the baseline allows and never widen
//! it. [`EffectiveCatalog::merge`] is the only place the two meet, and it
//! refuses — rather than silently drops — a tenant entry that would widen the
//! baseline, so the admin who wrote it sees why it is unavailable.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::image::PinnedImage;
use crate::spec::{
    is_valid_catalog_id, is_valid_domain_pattern, is_valid_slug, is_valid_user_name, IsolationTier,
    SpecBundle,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogScope {
    Baseline,
    Tenant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogEntrySource {
    /// Typed in by an admin.
    Manual,
    /// Produced by an environment build (ADR-0186).
    Build,
    /// Derived at boot from `COGNIA_RUNNER_IMAGE`.
    Legacy,
}

/// The image a catalog entry names. Pinned except for a legacy entry derived
/// from a tag-only `COGNIA_RUNNER_IMAGE`, which admission refuses until the
/// tag is resolved to a digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct CatalogImage {
    pub registry: String,
    pub repository: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    /// The tag a legacy entry was derived from; informational once pinned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

impl CatalogImage {
    pub fn pinned(&self) -> Option<PinnedImage> {
        Some(PinnedImage {
            registry: self.registry.clone(),
            repository: self.repository.clone(),
            digest: self.digest.clone()?,
        })
    }

    pub fn name(&self) -> String {
        format!("{}/{}", self.registry, self.repository)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct CatalogEntry {
    pub id: String,
    pub scope: CatalogScope,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub image: CatalogImage,
    /// The weakest tier this image may run at. The effective floor is the
    /// strictest of this, the tenant floor and the baseline floor.
    pub isolation_floor: IsolationTier,
    /// Size classes this entry may run with; the first is the default.
    pub size_class_ids: Vec<String>,
    /// The image config's `USER`, read from the registry when the entry was
    /// added. Absent means the image runs as root by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_user: Option<String>,
    pub source: CatalogEntrySource,
    /// Build key, commit and approval for a `build` entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<i64>,
    /// Server-owned, and defaulted rather than required: the Host stamps both
    /// on every write, and an operator authoring a baseline file by hand has
    /// no timestamp to give. `0` reads as "not recorded", which is the honest
    /// answer for a hand-written entry.
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// A size class. `gpu` is reserved and dormant: the type accepts it so the
/// model does not have to change when GPU sandboxes land, and admission
/// refuses any class that sets it (`gpu_not_supported`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct SizeClass {
    pub id: String,
    pub label: String,
    pub cpu_millis: u32,
    pub memory_mib: u32,
    pub ephemeral_storage_mib: u32,
    /// Persistent workspace volume size for persistent sandboxes.
    pub volume_mib: u32,
    /// Reserved; dormant. See the type doc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu: Option<GpuRequest>,
}

/// Reserved for GPU sandboxes; never admitted today.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct GpuRequest {
    pub count: u32,
    pub resource_name: String,
}

/// `registry` exactly, and a repository equal to or under `repositoryPrefix`
/// (empty prefix: any repository on that registry).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct RegistryRule {
    pub registry: String,
    pub repository_prefix: String,
    /// The registry speaks plain HTTP (an in-cluster registry without TLS).
    /// Metadata reads then use `http://`; pulls still verify every digest.
    /// Every rule naming one registry must agree on this.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub insecure: bool,
}

impl RegistryRule {
    pub fn matches(&self, registry: &str, repository: &str) -> bool {
        if !self.registry.eq_ignore_ascii_case(registry) {
            return false;
        }
        let prefix = self.repository_prefix.trim_matches('/');
        prefix.is_empty() || repository == prefix || repository.starts_with(&format!("{prefix}/"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct EgressPreset {
    pub id: String,
    pub label: String,
    pub domains: Vec<String>,
}

/// An operator-declared route to a VPC-internal endpoint (an internal package
/// mirror). Exactly one of `host` / `cidr`. Never exceptable: any cloud
/// metadata endpoint (`cognia_net::egress::METADATA_CIDRS`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct InternalException {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cidr: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct BundlePolicy {
    /// The release's current agent bundle.
    pub current: OfferedBundle,
    /// Older bundles a project may still pin, newest first.
    pub retained: Vec<OfferedBundle>,
}

impl BundlePolicy {
    /// Every offered bundle, current first.
    pub fn offered(&self) -> impl Iterator<Item = &OfferedBundle> {
        std::iter::once(&self.current).chain(self.retained.iter())
    }

    /// The offered bundle a spec names: the current one for a spec following
    /// the release, any retained one for a pinned spec.
    pub fn resolve(&self, bundle: &SpecBundle) -> Option<&OfferedBundle> {
        if bundle.pinned {
            self.offered().find(|offered| offered.matches(bundle))
        } else {
            Some(&self.current).filter(|current| current.matches(bundle))
        }
    }
}

/// An agent bundle a deployment offers (ADR-0183): where a driver pulls it
/// from, and the digest and release tag a spec records. The spec itself does
/// not carry the registry, so a bundle moving registries between releases does
/// not change any spec digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct OfferedBundle {
    pub registry: String,
    pub repository: String,
    /// `sha256:<64 lowercase hex>`.
    pub digest: String,
    pub release_tag: String,
}

impl OfferedBundle {
    pub fn image(&self) -> PinnedImage {
        PinnedImage {
            registry: self.registry.clone(),
            repository: self.repository.clone(),
            digest: self.digest.clone(),
        }
    }

    pub fn matches(&self, bundle: &SpecBundle) -> bool {
        self.digest == bundle.digest && self.release_tag == bundle.release_tag
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct SandboxPoolSwitch {
    /// The deployment-level switch (ADR-0182 "off by default, in layers").
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct EnvironmentBaseline {
    /// Always `1`.
    pub version: u8,
    /// Monotonic revision from the Ops Controller (0 for a derived baseline).
    pub revision: u64,
    pub sandbox_pool: SandboxPoolSwitch,
    /// True on a Host several tenants' work shares. Forces a sandbox: an
    /// infrastructure fault refuses instead of falling back (ADR-0182).
    pub multi_tenant: bool,
    pub registry_allowlist: Vec<RegistryRule>,
    pub isolation_floor: IsolationTier,
    pub entries: Vec<CatalogEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_entry_id: Option<String>,
    pub size_classes: Vec<SizeClass>,
    pub egress_presets: Vec<EgressPreset>,
    pub internal_exceptions: Vec<InternalException>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<BundlePolicy>,
}

/// The tenant's own policy. Floors can only be raised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct TenantPolicy {
    pub isolation_floor: IsolationTier,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_entry_id: Option<String>,
    pub updated_at: i64,
}

impl Default for TenantPolicy {
    fn default() -> Self {
        Self {
            isolation_floor: IsolationTier::Container,
            default_entry_id: None,
            updated_at: 0,
        }
    }
}

/// Why a baseline, tenant policy or entry is refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code} at {field}: {message}")]
pub struct CatalogError {
    pub code: &'static str,
    pub field: String,
    pub message: String,
}

impl CatalogError {
    fn new(code: &'static str, field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            field: field.into(),
            message: message.into(),
        }
    }
}

impl CatalogEntry {
    /// Structural validation of one entry, independent of any baseline.
    pub fn validate(&self, field: &str) -> Result<(), CatalogError> {
        if !is_valid_catalog_id(&self.id) {
            return Err(CatalogError::new(
                "catalog_entry_invalid",
                format!("{field}.id"),
                "catalog ids are [a-z0-9][a-z0-9._-]{0,63}",
            ));
        }
        if self.label.trim().is_empty() || self.label.chars().count() > 128 {
            return Err(CatalogError::new(
                "catalog_entry_invalid",
                format!("{field}.label"),
                "labels are 1-128 characters",
            ));
        }
        if let Some(description) = &self.description {
            if description.chars().count() > 2000 {
                return Err(CatalogError::new(
                    "catalog_entry_invalid",
                    format!("{field}.description"),
                    "descriptions are at most 2000 characters",
                ));
            }
        }
        match (&self.image.digest, self.source) {
            (Some(_), _) => {
                self.image
                    .pinned()
                    .expect("digest present")
                    .validate()
                    .map_err(|error| {
                        CatalogError::new(
                            "catalog_entry_invalid",
                            format!("{field}.image"),
                            error.to_string(),
                        )
                    })?;
            }
            (None, CatalogEntrySource::Legacy) => {
                // Name-only validation for a tag-only legacy entry.
                crate::image::ImageReference::parse(&format!(
                    "{}:{}",
                    self.image.name(),
                    self.image.tag.as_deref().unwrap_or("latest")
                ))
                .map_err(|error| {
                    CatalogError::new(
                        "catalog_entry_invalid",
                        format!("{field}.image"),
                        error.to_string(),
                    )
                })?;
            }
            (None, _) => {
                return Err(CatalogError::new(
                    "catalog_entry_unpinned",
                    format!("{field}.image.digest"),
                    "catalog images must be pinned to a sha256 digest",
                ));
            }
        }
        if self.size_class_ids.is_empty() {
            return Err(CatalogError::new(
                "catalog_entry_invalid",
                format!("{field}.sizeClassIds"),
                "an entry needs at least one size class",
            ));
        }
        let mut seen = BTreeSet::new();
        for (index, id) in self.size_class_ids.iter().enumerate() {
            if !is_valid_slug(id) || !seen.insert(id) {
                return Err(CatalogError::new(
                    "catalog_entry_invalid",
                    format!("{field}.sizeClassIds[{index}]"),
                    "size class ids are unique slugs",
                ));
            }
        }
        if let Some(user) = &self.image_user {
            let numeric = user
                .split(':')
                .next()
                .is_some_and(|uid| uid.parse::<u32>().is_ok());
            let named = user.split(':').next().is_some_and(is_valid_user_name);
            if !(numeric || named) {
                return Err(CatalogError::new(
                    "catalog_entry_invalid",
                    format!("{field}.imageUser"),
                    format!("{user:?} is not a user name or uid"),
                ));
            }
        }
        Ok(())
    }

    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }
}

impl EnvironmentBaseline {
    /// A baseline with nothing in it and the pool off: what a deployment that
    /// never configured runtime environments runs with.
    pub fn disabled() -> Self {
        Self {
            version: 1,
            revision: 0,
            sandbox_pool: SandboxPoolSwitch { enabled: false },
            multi_tenant: false,
            registry_allowlist: Vec::new(),
            isolation_floor: IsolationTier::Container,
            entries: Vec::new(),
            default_entry_id: None,
            size_classes: Vec::new(),
            egress_presets: Vec::new(),
            internal_exceptions: Vec::new(),
            bundle: None,
        }
    }

    pub fn validate(&self) -> Result<(), CatalogError> {
        if self.version != 1 {
            return Err(CatalogError::new(
                "baseline_version_unsupported",
                "version",
                format!("baseline version {} is not supported", self.version),
            ));
        }
        if self.multi_tenant && self.isolation_floor < IsolationTier::Gvisor {
            return Err(CatalogError::new(
                "baseline_floor_too_low",
                "isolationFloor",
                "a multi-tenant baseline needs an isolation floor of gvisor or vm",
            ));
        }
        for (index, rule) in self.registry_allowlist.iter().enumerate() {
            let probe = if rule.repository_prefix.is_empty() {
                format!("{}/probe", rule.registry)
            } else {
                format!(
                    "{}/{}",
                    rule.registry,
                    rule.repository_prefix.trim_matches('/')
                )
            };
            let parsed = crate::image::ImageReference::parse(&probe).map_err(|error| {
                CatalogError::new(
                    "baseline_registry_rule_invalid",
                    format!("registryAllowlist[{index}]"),
                    error.to_string(),
                )
            })?;
            if !parsed.registry.eq_ignore_ascii_case(&rule.registry) {
                return Err(CatalogError::new(
                    "baseline_registry_rule_invalid",
                    format!("registryAllowlist[{index}].registry"),
                    "registry must be an explicit host[:port]",
                ));
            }
            let disagrees = self.registry_allowlist[..index].iter().any(|earlier| {
                earlier.registry.eq_ignore_ascii_case(&rule.registry)
                    && earlier.insecure != rule.insecure
            });
            if disagrees {
                return Err(CatalogError::new(
                    "baseline_registry_rule_conflict",
                    format!("registryAllowlist[{index}].insecure"),
                    format!(
                        "rules for {} disagree on whether it is insecure",
                        rule.registry
                    ),
                ));
            }
        }

        let mut size_ids = BTreeSet::new();
        for (index, class) in self.size_classes.iter().enumerate() {
            let field = format!("sizeClasses[{index}]");
            if !is_valid_slug(&class.id) || !size_ids.insert(class.id.clone()) {
                return Err(CatalogError::new(
                    "baseline_size_class_invalid",
                    format!("{field}.id"),
                    "size class ids are unique slugs",
                ));
            }
            if class.cpu_millis == 0
                || class.memory_mib == 0
                || class.ephemeral_storage_mib == 0
                || class.volume_mib == 0
            {
                return Err(CatalogError::new(
                    "baseline_size_class_invalid",
                    field,
                    "cpu, memory, ephemeral storage and volume must all be positive",
                ));
            }
        }

        let mut entry_ids = BTreeSet::new();
        for (index, entry) in self.entries.iter().enumerate() {
            let field = format!("entries[{index}]");
            entry.validate(&field)?;
            if entry.scope != CatalogScope::Baseline {
                return Err(CatalogError::new(
                    "baseline_entry_scope",
                    format!("{field}.scope"),
                    "baseline entries must have scope baseline",
                ));
            }
            if !entry_ids.insert(entry.id.clone()) {
                return Err(CatalogError::new(
                    "catalog_entry_duplicate",
                    format!("{field}.id"),
                    format!("duplicate entry id {}", entry.id),
                ));
            }
            if !self.registry_permits(&entry.image) {
                return Err(CatalogError::new(
                    "catalog_registry_not_allowlisted",
                    format!("{field}.image"),
                    format!("{} is not on the registry allowlist", entry.image.name()),
                ));
            }
            for (class_index, class) in entry.size_class_ids.iter().enumerate() {
                if !size_ids.contains(class) {
                    return Err(CatalogError::new(
                        "catalog_size_class_unknown",
                        format!("{field}.sizeClassIds[{class_index}]"),
                        format!("size class {class} is not defined"),
                    ));
                }
            }
        }
        if let Some(default) = &self.default_entry_id {
            if !entry_ids.contains(default) {
                return Err(CatalogError::new(
                    "catalog_default_unknown",
                    "defaultEntryId",
                    format!("default entry {default} is not in the baseline"),
                ));
            }
        }

        let mut preset_ids = BTreeSet::new();
        for (index, preset) in self.egress_presets.iter().enumerate() {
            let field = format!("egressPresets[{index}]");
            if !is_valid_slug(&preset.id) || !preset_ids.insert(preset.id.clone()) {
                return Err(CatalogError::new(
                    "baseline_egress_preset_invalid",
                    format!("{field}.id"),
                    "preset ids are unique slugs",
                ));
            }
            if preset.domains.is_empty() {
                return Err(CatalogError::new(
                    "baseline_egress_preset_invalid",
                    format!("{field}.domains"),
                    "a preset needs at least one domain",
                ));
            }
            for (domain_index, domain) in preset.domains.iter().enumerate() {
                if !is_valid_domain_pattern(domain) {
                    return Err(CatalogError::new(
                        "baseline_egress_preset_invalid",
                        format!("{field}.domains[{domain_index}]"),
                        format!("{domain:?} is not a domain or *.domain pattern"),
                    ));
                }
            }
        }

        for (index, exception) in self.internal_exceptions.iter().enumerate() {
            validate_internal_exception(exception, &format!("internalExceptions[{index}]"))?;
        }

        if let Some(bundle) = &self.bundle {
            let mut digests = BTreeSet::new();
            for (index, candidate) in bundle.offered().enumerate() {
                let field = if index == 0 {
                    "bundle.current".to_string()
                } else {
                    format!("bundle.retained[{}]", index - 1)
                };
                candidate.image().validate().map_err(|error| {
                    CatalogError::new("baseline_bundle_invalid", field.clone(), error.to_string())
                })?;
                if candidate.release_tag.trim().is_empty() || candidate.release_tag.len() > 128 {
                    return Err(CatalogError::new(
                        "baseline_bundle_invalid",
                        format!("{field}.releaseTag"),
                        "release tag must be 1-128 characters",
                    ));
                }
                if !digests.insert(candidate.digest.clone()) {
                    return Err(CatalogError::new(
                        "baseline_bundle_invalid",
                        field,
                        "a bundle appears twice",
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn registry_permits(&self, image: &CatalogImage) -> bool {
        self.registry_allowlist
            .iter()
            .any(|rule| rule.matches(&image.registry, &image.repository))
    }

    /// Whether metadata for an allowlisted image is read over plain HTTP.
    /// `None` when the allowlist does not permit the image — the caller must
    /// not contact a registry the baseline does not name.
    pub fn registry_is_insecure(&self, image: &CatalogImage) -> Option<bool> {
        self.registry_allowlist
            .iter()
            .find(|rule| rule.matches(&image.registry, &image.repository))
            .map(|rule| rule.insecure)
    }

    pub fn size_class(&self, id: &str) -> Option<&SizeClass> {
        self.size_classes.iter().find(|class| class.id == id)
    }
}

fn validate_internal_exception(
    exception: &InternalException,
    field: &str,
) -> Result<(), CatalogError> {
    if exception.reason.trim().is_empty() {
        return Err(CatalogError::new(
            "baseline_exception_invalid",
            format!("{field}.reason"),
            "an internal exception must say why it exists",
        ));
    }
    match (&exception.host, &exception.cidr) {
        (Some(host), None) => {
            if host.starts_with("*.") || !cognia_net::egress::is_valid_hostname(host) {
                return Err(CatalogError::new(
                    "baseline_exception_invalid",
                    format!("{field}.host"),
                    "exceptions name one exact host",
                ));
            }
            if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                if cognia_net::egress::is_metadata_ip(&ip) {
                    return Err(CatalogError::new(
                        "baseline_exception_metadata",
                        format!("{field}.host"),
                        "cloud metadata endpoints can never be excepted",
                    ));
                }
            }
        }
        (None, Some(cidr)) => {
            let Some(network) = cognia_net::egress::IpCidr::parse(cidr) else {
                return Err(CatalogError::new(
                    "baseline_exception_invalid",
                    format!("{field}.cidr"),
                    format!("{cidr:?} is not a CIDR"),
                ));
            };
            if cognia_net::egress::overlaps_metadata(&network) {
                return Err(CatalogError::new(
                    "baseline_exception_metadata",
                    format!("{field}.cidr"),
                    "the range covers a cloud metadata endpoint",
                ));
            }
        }
        _ => {
            return Err(CatalogError::new(
                "baseline_exception_invalid",
                field,
                "set exactly one of host or cidr",
            ))
        }
    }
    Ok(())
}

/// Why one tenant entry is not part of the effective catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct RejectedTenantEntry {
    pub id: String,
    pub code: String,
    pub message: String,
}

/// An entry as it is offered: with the floor that actually applies to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveEntry {
    pub entry: CatalogEntry,
    pub effective_floor: IsolationTier,
}

/// The catalog a Host resolves against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveCatalog {
    pub pool_enabled: bool,
    pub multi_tenant: bool,
    pub floor: IsolationTier,
    pub entries: BTreeMap<String, EffectiveEntry>,
    pub default_entry_id: Option<String>,
    pub rejected: Vec<RejectedTenantEntry>,
}

impl EffectiveCatalog {
    /// Merge a validated baseline with the tenant layer. Revoked entries are
    /// kept out; tenant entries that would widen the baseline are listed in
    /// `rejected` with the reason.
    pub fn merge(
        baseline: &EnvironmentBaseline,
        tenant_entries: &[CatalogEntry],
        tenant_policy: &TenantPolicy,
    ) -> Self {
        let floor = baseline.isolation_floor.max(tenant_policy.isolation_floor);
        let mut entries = BTreeMap::new();
        for entry in baseline.entries.iter().filter(|entry| !entry.is_revoked()) {
            entries.insert(
                entry.id.clone(),
                EffectiveEntry {
                    effective_floor: entry.isolation_floor.max(floor),
                    entry: entry.clone(),
                },
            );
        }

        let mut rejected = Vec::new();
        for entry in tenant_entries.iter().filter(|entry| !entry.is_revoked()) {
            let refuse = |code: &str, message: String| RejectedTenantEntry {
                id: entry.id.clone(),
                code: code.to_string(),
                message,
            };
            if let Err(error) = entry.validate("entry") {
                rejected.push(refuse(error.code, error.message));
                continue;
            }
            if entry.scope != CatalogScope::Tenant {
                rejected.push(refuse(
                    "tenant_entry_scope",
                    "tenant entries must have scope tenant".into(),
                ));
                continue;
            }
            if entries.contains_key(&entry.id) {
                rejected.push(refuse(
                    "catalog_entry_duplicate",
                    format!("{} is already a baseline entry", entry.id),
                ));
                continue;
            }
            if !baseline.registry_permits(&entry.image) {
                rejected.push(refuse(
                    "catalog_registry_not_allowlisted",
                    format!(
                        "{} is not on the baseline registry allowlist",
                        entry.image.name()
                    ),
                ));
                continue;
            }
            if let Some(unknown) = entry
                .size_class_ids
                .iter()
                .find(|class| baseline.size_class(class).is_none())
            {
                rejected.push(refuse(
                    "catalog_size_class_unknown",
                    format!("size class {unknown} is not defined in the baseline"),
                ));
                continue;
            }
            entries.insert(
                entry.id.clone(),
                EffectiveEntry {
                    effective_floor: entry.isolation_floor.max(floor),
                    entry: entry.clone(),
                },
            );
        }

        let default_entry_id = tenant_policy
            .default_entry_id
            .as_ref()
            .filter(|id| entries.contains_key(*id))
            .or(baseline
                .default_entry_id
                .as_ref()
                .filter(|id| entries.contains_key(*id)))
            .cloned();

        Self {
            pool_enabled: baseline.sandbox_pool.enabled,
            multi_tenant: baseline.multi_tenant,
            floor,
            entries,
            default_entry_id,
            rejected,
        }
    }

    pub fn entry(&self, id: &str) -> Option<&EffectiveEntry> {
        self.entries.get(id)
    }
}

/// Refuse a tenant policy that would lower the baseline floor.
pub fn validate_tenant_policy(
    baseline: &EnvironmentBaseline,
    policy: &TenantPolicy,
) -> Result<(), CatalogError> {
    if policy.isolation_floor < baseline.isolation_floor {
        return Err(CatalogError::new(
            "tenant_floor_below_baseline",
            "isolationFloor",
            format!(
                "the baseline floor is {}; a tenant may only raise it",
                baseline.isolation_floor.as_str()
            ),
        ));
    }
    if let Some(id) = &policy.default_entry_id {
        if !is_valid_catalog_id(id) {
            return Err(CatalogError::new(
                "catalog_entry_invalid",
                "defaultEntryId",
                "catalog ids are [a-z0-9][a-z0-9._-]{0,63}",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::spec::tests::{BUNDLE_DIGEST, IMAGE_DIGEST};

    pub(crate) fn entry(
        id: &str,
        scope: CatalogScope,
        registry: &str,
        repository: &str,
    ) -> CatalogEntry {
        CatalogEntry {
            id: id.into(),
            scope,
            label: id.into(),
            description: None,
            image: CatalogImage {
                registry: registry.into(),
                repository: repository.into(),
                digest: Some(IMAGE_DIGEST.into()),
                tag: None,
            },
            isolation_floor: IsolationTier::Container,
            size_class_ids: vec!["medium".into()],
            image_user: None,
            source: CatalogEntrySource::Manual,
            provenance: None,
            revoked_at: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    pub(crate) fn baseline() -> EnvironmentBaseline {
        EnvironmentBaseline {
            version: 1,
            revision: 3,
            sandbox_pool: SandboxPoolSwitch { enabled: true },
            multi_tenant: false,
            registry_allowlist: vec![RegistryRule {
                registry: "ghcr.io".into(),
                repository_prefix: "acme".into(),
                insecure: false,
            }],
            isolation_floor: IsolationTier::Container,
            entries: vec![entry(
                "python-312",
                CatalogScope::Baseline,
                "ghcr.io",
                "acme/python",
            )],
            default_entry_id: Some("python-312".into()),
            size_classes: vec![SizeClass {
                id: "medium".into(),
                label: "Medium".into(),
                cpu_millis: 2000,
                memory_mib: 4096,
                ephemeral_storage_mib: 10240,
                volume_mib: 20480,
                gpu: None,
            }],
            egress_presets: vec![EgressPreset {
                id: "pypi".into(),
                label: "PyPI".into(),
                domains: vec!["pypi.org".into(), "files.pythonhosted.org".into()],
            }],
            internal_exceptions: vec![],
            bundle: Some(BundlePolicy {
                current: offered_bundle(BUNDLE_DIGEST, "v1.0.0"),
                retained: vec![],
            }),
        }
    }

    pub(crate) fn offered_bundle(digest: &str, release_tag: &str) -> OfferedBundle {
        OfferedBundle {
            registry: "ghcr.io".into(),
            repository: "maxqian888/cognia-agent-bundle".into(),
            digest: digest.into(),
            release_tag: release_tag.into(),
        }
    }

    #[test]
    fn a_sample_baseline_validates() {
        baseline().validate().unwrap();
        EnvironmentBaseline::disabled().validate().unwrap();
    }

    #[test]
    fn registry_rules_match_by_registry_and_path_prefix() {
        let rule = RegistryRule {
            registry: "ghcr.io".into(),
            repository_prefix: "acme".into(),
            insecure: false,
        };
        assert!(rule.matches("ghcr.io", "acme"));
        assert!(rule.matches("GHCR.io", "acme/python"));
        assert!(
            !rule.matches("ghcr.io", "acme-evil/python"),
            "prefix is a path, not a string"
        );
        assert!(!rule.matches("docker.io", "acme/python"));
        let any = RegistryRule {
            registry: "registry.cn-beijing.cr.volces.com".into(),
            repository_prefix: String::new(),
            insecure: false,
        };
        assert!(any.matches("registry.cn-beijing.cr.volces.com", "team/app"));
    }

    fn baseline_refusal(mutate: impl FnOnce(&mut EnvironmentBaseline)) -> &'static str {
        let mut value = baseline();
        mutate(&mut value);
        value.validate().expect_err("mutation must be refused").code
    }

    #[test]
    fn baseline_refusals_carry_stable_codes() {
        assert_eq!(
            baseline_refusal(|b| b.version = 9),
            "baseline_version_unsupported"
        );
        assert_eq!(
            baseline_refusal(|b| b.multi_tenant = true),
            "baseline_floor_too_low"
        );
        assert_eq!(
            baseline_refusal(|b| b.entries[0].image.registry = "docker.io".into()),
            "catalog_registry_not_allowlisted"
        );
        assert_eq!(
            baseline_refusal(|b| b.entries[0].image.digest = None),
            "catalog_entry_unpinned"
        );
        assert_eq!(
            baseline_refusal(|b| b.entries.push(b.entries[0].clone())),
            "catalog_entry_duplicate"
        );
        assert_eq!(
            baseline_refusal(|b| b.entries[0].size_class_ids = vec!["huge".into()]),
            "catalog_size_class_unknown"
        );
        assert_eq!(
            baseline_refusal(|b| b.default_entry_id = Some("missing".into())),
            "catalog_default_unknown"
        );
        assert_eq!(
            baseline_refusal(|b| b.egress_presets[0].domains.push("10.0.0.1".into())),
            "baseline_egress_preset_invalid"
        );
        assert_eq!(
            baseline_refusal(|b| b.entries[0].scope = CatalogScope::Tenant),
            "baseline_entry_scope"
        );
        assert_eq!(
            baseline_refusal(|b| {
                let mut other = b.registry_allowlist[0].clone();
                other.repository_prefix = "acme-internal".into();
                other.insecure = true;
                b.registry_allowlist.push(other);
            }),
            "baseline_registry_rule_conflict"
        );
    }

    #[test]
    fn offered_bundles_must_be_pullable_pinned_and_distinct() {
        use crate::spec::tests::RETAINED_BUNDLE_DIGEST;
        let with_retained = |b: &mut EnvironmentBaseline| {
            b.bundle.as_mut().unwrap().retained =
                vec![offered_bundle(RETAINED_BUNDLE_DIGEST, "v0.9.0")];
        };
        let mut valid = baseline();
        with_retained(&mut valid);
        valid.validate().unwrap();

        for broken in [
            |b: &mut EnvironmentBaseline| b.bundle.as_mut().unwrap().current.registry = "".into(),
            |b: &mut EnvironmentBaseline| {
                b.bundle.as_mut().unwrap().current.repository = "UPPER/case".into()
            },
            |b: &mut EnvironmentBaseline| {
                b.bundle.as_mut().unwrap().current.digest = "sha256:short".into()
            },
            |b: &mut EnvironmentBaseline| {
                b.bundle.as_mut().unwrap().current.release_tag = " ".into()
            },
            |b: &mut EnvironmentBaseline| {
                let current = b.bundle.as_ref().unwrap().current.clone();
                b.bundle.as_mut().unwrap().retained = vec![current];
            },
        ] {
            assert_eq!(baseline_refusal(broken), "baseline_bundle_invalid");
        }
    }

    #[test]
    fn a_spec_bundle_resolves_to_what_the_deployment_offers() {
        use crate::spec::tests::RETAINED_BUNDLE_DIGEST;
        let mut policy = baseline().bundle.unwrap();
        policy.retained = vec![offered_bundle(RETAINED_BUNDLE_DIGEST, "v0.9.0")];
        let spec_bundle = |digest: &str, tag: &str, pinned: bool| SpecBundle {
            digest: digest.into(),
            release_tag: tag.into(),
            pinned,
        };

        let following = spec_bundle(BUNDLE_DIGEST, "v1.0.0", false);
        assert_eq!(policy.resolve(&following), Some(&policy.current));
        // A spec following the release cannot name a retained bundle.
        assert_eq!(
            policy.resolve(&spec_bundle(RETAINED_BUNDLE_DIGEST, "v0.9.0", false)),
            None
        );
        let pinned_old = spec_bundle(RETAINED_BUNDLE_DIGEST, "v0.9.0", true);
        assert_eq!(policy.resolve(&pinned_old), Some(&policy.retained[0]));
        assert_eq!(
            policy.resolve(&pinned_old).unwrap().image().canonical(),
            format!("ghcr.io/maxqian888/cognia-agent-bundle@{RETAINED_BUNDLE_DIGEST}")
        );
        // The release tag is part of the match: a re-tagged digest is not the same bundle.
        assert_eq!(
            policy.resolve(&spec_bundle(BUNDLE_DIGEST, "v1.0.1", true)),
            None
        );
        assert_eq!(policy.offered().count(), 2);
    }

    #[test]
    fn insecure_is_read_from_the_matching_rule_and_omitted_when_false() {
        let mut value = baseline();
        let image = value.entries[0].image.clone();
        assert_eq!(value.registry_is_insecure(&image), Some(false));
        let wire = serde_json::to_value(&value.registry_allowlist[0]).unwrap();
        assert!(wire.get("insecure").is_none(), "{wire}");

        value.registry_allowlist[0].insecure = true;
        value.validate().unwrap();
        assert_eq!(value.registry_is_insecure(&image), Some(true));

        let mut elsewhere = image;
        elsewhere.registry = "docker.io".into();
        assert_eq!(value.registry_is_insecure(&elsewhere), None);
    }

    #[test]
    fn metadata_endpoints_can_never_be_excepted() {
        let exception = |host: Option<&str>, cidr: Option<&str>| InternalException {
            host: host.map(Into::into),
            cidr: cidr.map(Into::into),
            reason: "internal pypi mirror".into(),
        };
        assert_eq!(
            baseline_refusal(|b| b
                .internal_exceptions
                .push(exception(None, Some("100.64.0.0/10")))),
            "baseline_exception_metadata"
        );
        assert_eq!(
            baseline_refusal(|b| b
                .internal_exceptions
                .push(exception(Some("100.100.100.200"), None))),
            "baseline_exception_metadata"
        );
        assert_eq!(
            baseline_refusal(|b| b
                .internal_exceptions
                .push(exception(Some("*.internal"), None))),
            "baseline_exception_invalid"
        );
        assert_eq!(
            baseline_refusal(|b| b
                .internal_exceptions
                .push(exception(Some("a.b"), Some("10.0.0.0/8")))),
            "baseline_exception_invalid"
        );
        let mut ok = baseline();
        ok.internal_exceptions
            .push(exception(Some("mirrors.cloud.aliyuncs.com"), None));
        ok.internal_exceptions
            .push(exception(None, Some("100.100.2.136/32")));
        ok.validate().unwrap();
    }

    #[test]
    fn tenant_entries_can_append_but_never_widen() {
        let base = baseline();
        let tenant = vec![
            entry("node-22", CatalogScope::Tenant, "ghcr.io", "acme/node"),
            entry("evil", CatalogScope::Tenant, "docker.io", "library/ubuntu"),
            entry("python-312", CatalogScope::Tenant, "ghcr.io", "acme/python"),
            {
                let mut revoked = entry("old", CatalogScope::Tenant, "ghcr.io", "acme/old");
                revoked.revoked_at = Some(5);
                revoked
            },
            {
                let mut huge = entry("huge", CatalogScope::Tenant, "ghcr.io", "acme/huge");
                huge.size_class_ids = vec!["xl".into()];
                huge
            },
        ];
        let effective = EffectiveCatalog::merge(&base, &tenant, &TenantPolicy::default());
        assert!(effective.entry("node-22").is_some());
        assert!(effective.entry("python-312").is_some());
        assert!(
            effective.entry("old").is_none(),
            "revoked entries are not offered"
        );
        let codes: BTreeMap<_, _> = effective
            .rejected
            .iter()
            .map(|rejected| (rejected.id.as_str(), rejected.code.as_str()))
            .collect();
        assert_eq!(codes.get("evil"), Some(&"catalog_registry_not_allowlisted"));
        assert_eq!(codes.get("python-312"), Some(&"catalog_entry_duplicate"));
        assert_eq!(codes.get("huge"), Some(&"catalog_size_class_unknown"));
        assert_eq!(effective.default_entry_id.as_deref(), Some("python-312"));
    }

    #[test]
    fn the_effective_floor_is_the_strictest_layer() {
        let mut base = baseline();
        base.isolation_floor = IsolationTier::Gvisor;
        let mut strict_entry = entry("vm-only", CatalogScope::Tenant, "ghcr.io", "acme/vm");
        strict_entry.isolation_floor = IsolationTier::Vm;
        let policy = TenantPolicy {
            isolation_floor: IsolationTier::Gvisor,
            default_entry_id: Some("vm-only".into()),
            updated_at: 1,
        };
        let effective = EffectiveCatalog::merge(&base, &[strict_entry], &policy);
        assert_eq!(effective.floor, IsolationTier::Gvisor);
        assert_eq!(
            effective.entry("python-312").unwrap().effective_floor,
            IsolationTier::Gvisor
        );
        assert_eq!(
            effective.entry("vm-only").unwrap().effective_floor,
            IsolationTier::Vm
        );
        assert_eq!(effective.default_entry_id.as_deref(), Some("vm-only"));
    }

    #[test]
    fn a_tenant_policy_may_raise_but_not_lower_the_floor() {
        let mut base = baseline();
        base.isolation_floor = IsolationTier::Gvisor;
        let lower = TenantPolicy {
            isolation_floor: IsolationTier::Container,
            ..TenantPolicy::default()
        };
        assert_eq!(
            validate_tenant_policy(&base, &lower).unwrap_err().code,
            "tenant_floor_below_baseline"
        );
        let raise = TenantPolicy {
            isolation_floor: IsolationTier::Vm,
            ..TenantPolicy::default()
        };
        validate_tenant_policy(&base, &raise).unwrap();
    }

    #[test]
    fn a_legacy_entry_may_be_tag_only_but_manual_entries_may_not() {
        let mut legacy = entry(
            "legacy-env",
            CatalogScope::Baseline,
            "ghcr.io",
            "acme/runner",
        );
        legacy.image.digest = None;
        legacy.image.tag = Some("latest".into());
        legacy.source = CatalogEntrySource::Legacy;
        legacy.validate("entry").unwrap();
        legacy.source = CatalogEntrySource::Manual;
        assert_eq!(
            legacy.validate("entry").unwrap_err().code,
            "catalog_entry_unpinned"
        );
    }

    #[test]
    fn closed_object_attributes_are_paired_correctly() {
        let violations = cognia_problem::wire_schema::closed_object_pairing_violations(
            "catalog.rs",
            include_str!("catalog.rs"),
        );
        assert!(violations.is_empty(), "{violations:#?}");
    }
}
