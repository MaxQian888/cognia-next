//! What the Host serves about runtime environments (ADR-0182, ADR-0183).
//!
//! The sandbox pool is installed at boot by
//! [`cognia_sandbox_pool::boot::install`], which hands back
//! [`PoolServices`] — the admission instance (baseline, tenant store,
//! registry credentials) and the driver, narrowed to what a status read may
//! ask. This module holds that handle for the companion API and owns the wire
//! shapes the arms in [`crate::companion_api::rpc`] answer with.
//!
//! # Why the API reads through admission rather than opening the store itself
//!
//! `environment.sqlite` is one file with one connection. A console that read
//! the catalog out of a second connection could show an entry a spawn would
//! refuse, or miss an approval a spawn just recorded. Routing every read and
//! write through the same [`cognia_sandbox_pool::admission::EnvironmentSandboxAdmission`]
//! makes that impossible by construction.
//!
//! # With the pool off there is nothing installed
//!
//! [`installed`] answers `None` on a deployment that never turned the pool
//! on, and every arm refuses with `sandbox_pool_disabled`. That is one fact
//! read in one place rather than a switch each command re-derives — and it is
//! a refusal naming the switch, not an empty list, because "this deployment
//! has no runtime environments" and "this tenant has configured none" are
//! different answers and a UI has to be able to say which.

use cognia_environment::approval::ApprovalRecord;
use cognia_environment::catalog::{
    BundlePolicy, CatalogEntry, CatalogScope, EffectiveCatalog, EgressPreset, SizeClass,
};
use cognia_environment::image::ImageReference;
use cognia_environment::registry::{
    ImageMetadata, Platform, RegistryClient, RegistryCredentials, RegistryEndpoint,
    RegistryTransport,
};
use cognia_environment::spec::IsolationTier;
use cognia_problem::paging::Page;
use cognia_sandbox_pool::probe_cache::{Ownership, ProbeCacheEntry};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub use cognia_sandbox_pool::boot::PoolServices;

use cognia_sandbox_pool::build::{BuildConfig, BuildService};
pub use cognia_sandbox_pool::build::{BuildPhase, BuildRequest, BuildStatus};
use std::sync::Arc;

static BUILD_SERVICE: Lazy<parking_lot::Mutex<Option<Arc<BuildService>>>> =
    Lazy::new(|| parking_lot::Mutex::new(None));

fn build_service() -> Served<Arc<BuildService>> {
    let mut service = BUILD_SERVICE.lock();
    if let Some(service) = service.as_ref() {
        return Ok(Arc::clone(service));
    }
    let created = BuildService::new(BuildConfig::from_env().map_err(|error| {
        EnvironmentServiceError::refused("environment_build_unconfigured", error)
    })?)
    .map_err(|error| EnvironmentServiceError::refused("environment_build_unconfigured", error))?;
    *service = Some(Arc::clone(&created));
    Ok(created)
}

pub fn start_build(services: &PoolServices, request: BuildRequest) -> Served<BuildStatus> {
    let admission = Arc::clone(&services.admission);
    build_service()?
        .start(
            request,
            Arc::new(move |record| {
                admission
                    .with_store(|store| store.record_build(record))
                    .map_err(|error| error.to_string())
            }),
        )
        .map_err(|error| EnvironmentServiceError::refused("environment_build_invalid", error))
}

pub fn get_build(
    services: &PoolServices,
    project_id: &str,
    job_id: Option<&str>,
    build_key: Option<&str>,
) -> Served<BuildStatus> {
    match (job_id, build_key) {
        (Some(job), None) => build_service()?
            .get(project_id, job)
            .map_err(|error| EnvironmentServiceError::refused("environment_build_missing", error)),
        (None, Some(key)) => {
            let record = services
                .admission
                .with_store(|store| store.get_build(key))?
                .filter(|record| record.project_id == project_id)
                .ok_or_else(|| {
                    EnvironmentServiceError::refused(
                        "environment_build_missing",
                        "build is not recorded for this project",
                    )
                })?;
            Ok(BuildStatus {
                job_id: String::new(),
                project_id: project_id.into(),
                status: BuildPhase::Succeeded,
                record: Some(record),
                error: None,
            })
        }
        _ => Err(EnvironmentServiceError::refused(
            "environment_build_invalid",
            "provide exactly one of jobId or buildKey",
        )),
    }
}

pub fn cancel_build(project_id: &str, job_id: &str) -> Served<BuildStatus> {
    build_service()?
        .cancel(project_id, job_id)
        .map_err(|error| EnvironmentServiceError::refused("environment_build_missing", error))
}

/// The list page size when a caller names none. Catalogs and approval ledgers
/// are small; the cap exists so a console cannot be handed an unbounded
/// answer, not because paging these is routine.
pub const DEFAULT_PAGE_SIZE: u32 = 50;

/// The declaration files a repository may carry, in precedence order.
///
/// The same order `lib/project-environment/read-environment-declaration.ts`
/// walks, so the Host and the brain never disagree about which file counts.
pub const DECLARATION_FILES: &[(&str, &str)] = &[
    (".cognia/workspace.json", "workspace-config"),
    (".devcontainer/devcontainer.json", "devcontainer"),
    (".devcontainer.json", "devcontainer"),
];

/// A declaration is a config file, not a payload. Anything larger is a caller
/// pointing at the wrong path, and reading it would be the only unbounded
/// allocation on this surface.
pub const MAX_DECLARATION_BYTES: u64 = 512 * 1024;

static SERVICES: Lazy<RwLock<Option<PoolServices>>> = Lazy::new(|| RwLock::new(None));

/// Publish what the boot seam installed. Called once, before the plane
/// listens.
pub fn install(services: PoolServices) {
    *SERVICES.write() = Some(services);
}

/// The installed services, or `None` on a deployment with the pool off.
pub fn installed() -> Option<PoolServices> {
    SERVICES.read().clone()
}

/// Forget the installed services. Tests only: a running Host never
/// un-installs a pool.
#[cfg(test)]
pub fn uninstall() {
    *SERVICES.write() = None;
}

/// Why a read or write against the environment store could not be served.
#[derive(Debug, thiserror::Error)]
pub enum EnvironmentServiceError {
    #[error("the environment store could not be used: {0}")]
    Store(String),
    #[error("no {what} with id {id}")]
    NotFound { what: &'static str, id: String },
    #[error("{message}")]
    Refused { code: String, message: String },
    #[error("{0}")]
    Unreadable(String),
    /// A registry or the network between us failed in a way worth retrying.
    /// Kept apart from `Store` so the code a client sees is the registry's,
    /// not "the environment store is down".
    #[error("{message}")]
    Upstream { code: String, message: String },
}

/// A store error keeps what it says about the request: a missing record is a
/// 404 and an invalid one is a refusal. Only a database fault is the store
/// being unavailable — and only that one is worth retrying.
impl From<cognia_environment::store::StoreError> for EnvironmentServiceError {
    fn from(error: cognia_environment::store::StoreError) -> Self {
        use cognia_environment::store::StoreError;
        match error {
            StoreError::NotFound { kind, id } => Self::NotFound { what: kind, id },
            StoreError::Invalid(message) => Self::Refused {
                code: "environment_record_invalid".into(),
                message,
            },
            other => Self::Store(other.to_string()),
        }
    }
}

impl EnvironmentServiceError {
    /// The stable code a client switches on. Store faults are retryable, the
    /// rest are answers.
    pub fn code(&self) -> &str {
        match self {
            Self::Store(_) => "environment_store_unavailable",
            Self::NotFound { .. } => "environment_record_not_found",
            Self::Refused { code, .. } => code,
            Self::Unreadable(_) => "declaration_unreadable",
            Self::Upstream { code, .. } => code,
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, Self::Store(_) | Self::Upstream { .. })
    }

    fn store(error: impl std::fmt::Display) -> Self {
        Self::Store(error.to_string())
    }

    fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Refused {
            code: code.into(),
            message: message.into(),
        }
    }
}

type Served<T> = Result<T, EnvironmentServiceError>;

/// A catalog entry as a console reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntryView {
    pub entry: CatalogEntry,
    /// `max(entry floor, baseline floor, tenant floor)` — never lower than
    /// what the entry itself declares.
    pub effective_floor: IsolationTier,
    /// True for the entry a project that names none gets.
    pub default_entry: bool,
}

/// Why a stored tenant entry is not in the merged catalog.
///
/// A rejected entry stays stored and stays visible: an operator who added an
/// image the baseline allowlist later stopped permitting needs the reason,
/// not an entry that silently vanished.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRejection {
    pub id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub items: Vec<CatalogEntryView>,
    /// Present exactly when another page exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_page_token: Option<String>,
    pub rejected: Vec<CatalogRejection>,
    /// The deployment switch (Q39). False: nothing is admitted and every
    /// project takes the existing execution path.
    pub pool_enabled: bool,
    /// True on a Host several tenants' work shares, where an infrastructure
    /// fault refuses instead of falling back.
    pub multi_tenant: bool,
    /// The strictest of the baseline's and the tenant's floors.
    pub floor: IsolationTier,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_entry_id: Option<String>,
    /// What an entry's `sizeClassIds` refer to.
    pub size_classes: Vec<SizeClass>,
    /// What an egress spec's `presetIds` refer to.
    pub egress_presets: Vec<EgressPreset>,
    /// Absent: no agent bundle is configured and nothing can be admitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<BundlePolicy>,
}

/// One declaration file, as bytes plus the digest of those bytes.
///
/// Deliberately *not* parsed here. The devcontainer and workspace-config
/// grammars, their closed-world refusals and the RFC 8785 declaration digest
/// live in one place — `lib/project-environment` — and a second
/// implementation in Rust would be a parity liability with nothing to gain:
/// this Host's job on this path is access to a checkout the approver's
/// browser cannot reach. The digest over the raw bytes is what makes "the
/// file changed since you looked at it" answerable without parsing either
/// grammar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeclarationRead {
    /// Absolute path of the file that was read.
    pub path: String,
    /// Repository-relative path, which is what an approval record stores.
    pub relative_path: String,
    /// `workspace-config` or `devcontainer`.
    pub file: String,
    pub contents: String,
    /// SHA-256 (lowercase hex) of the exact bytes above.
    pub bytes_sha256: String,
}

/// Every declaration file a repository has, plus where the Host looked.
///
/// **All** of them, not the first one that matched. Precedence between
/// `.cognia/workspace.json` and a devcontainer file is decided by
/// `lib/project-environment/read-environment-declaration.ts`, together with
/// the trust gate and the parse — and a Host that returned only its own first
/// match would be a second, silent answer to the same question. Returning the
/// set keeps that rule in one place and still costs one round trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeclarationReadResult {
    /// In `DECLARATION_FILES` order; empty when the repository declares nothing,
    /// which is the common case and not an error.
    pub files: Vec<DeclarationRead>,
    /// Every path that was looked for, so a caller can say where it looked
    /// instead of only "not found".
    pub searched: Vec<String>,
}

/// A dry run of admission: what this Host would give the spec, or why it
/// would refuse. Never starts anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpecPreview {
    pub admitted: bool,
    pub spec_digest: Option<String>,
    pub actual_tier: Option<IsolationTier>,
    pub size_class_id: Option<String>,
    pub bundle_digest: Option<String>,
    /// The tiers the driver could attest when this ran.
    pub available_tiers: Vec<IsolationTier>,
    pub refusal_code: Option<String>,
    pub refusal_message: Option<String>,
    /// Whether the refusal was a fault (infrastructure) rather than an answer
    /// about the spec. A fault falls back at spawn time unless isolation is
    /// mandatory, so a preview must not report one as a verdict on the spec.
    pub fault: bool,
}

/// The cached probe verdict for one (user image, bundle) pair.
///
/// A view over what the driver stored, not a second source of truth: these
/// are the fields a console shows. The entry is parsed by
/// `cognia_sandbox_pool::probe_cache::ProbeCacheEntry`, the same type the
/// driver writes it with, so the two cannot disagree about its shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeCacheView {
    pub version: u32,
    /// The user the probe was asked about: a name, a uid, or `uid:gid`.
    pub requested_user: String,
    /// The user the agent actually runs as, as the image resolved it. Absent
    /// when the requested user does not exist in the image.
    pub resolved_user: Option<ProbeUserView>,
    pub match_workspace_owner: bool,
    /// Who owned the workspace when the probe ran.
    pub workspace_owner: Option<ProbeOwnerView>,
    pub libc: Option<String>,
    pub arch: String,
    pub shell: Option<String>,
    /// Bundle runtimes this image's C library can run.
    pub runtimes: Vec<String>,
    /// Empty when the probe accepted the image.
    pub problems: Vec<ProbeProblemView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOwnerView {
    pub uid: u32,
    pub gid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeUserView {
    /// Absent for a numeric uid the image has no passwd entry for.
    pub name: Option<String>,
    pub uid: u32,
    pub gid: u32,
    /// The declared user's own ids, when it was remapped onto the workspace
    /// owner.
    pub remapped_from: Option<ProbeOwnerView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeProblemView {
    /// A `probe_*` code, or `bundle_arch_mismatch`.
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeCacheResult {
    pub cached: Option<ProbeCacheView>,
    /// True when an entry exists but this build cannot read its shape. "No
    /// probe yet" and "a probe I cannot read" lead to different actions.
    pub unreadable: bool,
}

/// An offered agent bundle, for a console that must show which digest a
/// sandbox would inject and which older ones a project may still pin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OfferedBundleView {
    pub registry: String,
    pub repository: String,
    pub digest: String,
    pub release_tag: String,
    /// True for the current bundle, false for a retained older one.
    pub current: bool,
}

/// The driver's own answer about itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DriverStatus {
    pub driver: String,
    pub deployment_id: String,
    pub instance_id: String,
    pub multi_tenant: bool,
    pub isolation_floor: IsolationTier,
    /// Empty with `reachable: false`. An unreachable daemon attests no tier,
    /// which is not the same claim as attesting none.
    pub available_tiers: Vec<IsolationTier>,
    pub reachable: bool,
    pub unreachable_reason: Option<String>,
    pub bundles: Vec<OfferedBundleView>,
}

/// The merged catalog and the tenant policy it was merged under.
pub fn effective_catalog(services: &PoolServices) -> Served<EffectiveCatalog> {
    let (entries, policy) = services
        .admission
        .with_store(|store| -> Result<_, String> {
            let entries = store.list_tenant_entries().map_err(|e| e.to_string())?;
            let policy = store.tenant_policy().map_err(|e| e.to_string())?;
            Ok((entries, policy))
        })
        .map_err(EnvironmentServiceError::Store)?;
    Ok(EffectiveCatalog::merge(
        services.admission.baseline(),
        &entries,
        &policy,
    ))
}

pub fn catalog_views(catalog: &EffectiveCatalog) -> Vec<CatalogEntryView> {
    catalog
        .entries
        .values()
        .map(|effective| CatalogEntryView {
            entry: effective.entry.clone(),
            effective_floor: effective.effective_floor,
            default_entry: catalog.default_entry_id.as_deref() == Some(effective.entry.id.as_str()),
        })
        .collect()
}

pub fn catalog_rejections(catalog: &EffectiveCatalog) -> Vec<CatalogRejection> {
    catalog
        .rejected
        .iter()
        .map(|rejected| CatalogRejection {
            id: rejected.id.clone(),
            code: rejected.code.clone(),
            message: rejected.message.clone(),
        })
        .collect()
}

/// Refuse a tenant entry the merge would reject, before it is stored.
///
/// The merge is the authority on what a tenant may add — it refuses widening
/// the registry allowlist and lowering the isolation floor — so this write
/// and admission cannot disagree about an entry's validity. Storing first and
/// letting the merge drop it later would leave a console showing an entry no
/// spawn can use.
pub fn validate_tenant_entry(services: &PoolServices, candidate: &CatalogEntry) -> Served<()> {
    if candidate.scope != CatalogScope::Tenant {
        return Err(EnvironmentServiceError::refused(
            "tenant_entry_scope",
            "a catalog entry written here must have scope tenant",
        ));
    }
    let policy = services
        .admission
        .with_store(|store| store.tenant_policy())
        .map_err(EnvironmentServiceError::store)?;
    let merged = EffectiveCatalog::merge(
        services.admission.baseline(),
        std::slice::from_ref(candidate),
        &policy,
    );
    match merged
        .rejected
        .iter()
        .find(|rejected| rejected.id == candidate.id)
    {
        Some(rejected) => Err(EnvironmentServiceError::refused(
            rejected.code.clone(),
            rejected.message.clone(),
        )),
        None => Ok(()),
    }
}

/// One page of the merged catalog, with every rejection alongside it.
pub fn catalog_page(
    services: &PoolServices,
    request: &cognia_problem::paging::PageRequest,
) -> Served<CatalogPage> {
    let catalog = effective_catalog(services)?;
    let rejected = catalog_rejections(&catalog);
    let page =
        Page::slice_all(catalog_views(&catalog), request, DEFAULT_PAGE_SIZE).map_err(|error| {
            EnvironmentServiceError::refused("malformed_request", error.to_string())
        })?;
    // Repeated on every page, like `rejected`: resolution needs the floor, the
    // switch, the size classes and the bundle offer together with the entries,
    // and a second command for them would let a caller resolve against a
    // catalog whose halves came from two different reads.
    let baseline = services.admission.baseline();
    Ok(CatalogPage {
        items: page.items,
        next_page_token: page.next_page_token,
        rejected,
        pool_enabled: catalog.pool_enabled,
        multi_tenant: catalog.multi_tenant,
        floor: catalog.floor,
        default_entry_id: catalog.default_entry_id.clone(),
        size_classes: baseline.size_classes.clone(),
        egress_presets: baseline.egress_presets.clone(),
        bundle: baseline.bundle.clone(),
    })
}

/// Write a tenant catalog entry. `updating` decides whether an existing id is
/// required or refused, so a create can never silently replace.
pub fn write_catalog_entry(
    services: &PoolServices,
    mut entry: CatalogEntry,
    updating: bool,
    now: i64,
) -> Served<CatalogEntry> {
    let existing = services
        .admission
        .with_store(|store| store.get_tenant_entry(&entry.id))
        .map_err(EnvironmentServiceError::store)?;
    match (updating, &existing) {
        (true, None) => {
            return Err(EnvironmentServiceError::NotFound {
                what: "catalog entry",
                id: entry.id,
            })
        }
        (false, Some(_)) => {
            return Err(EnvironmentServiceError::refused(
                "catalog_entry_duplicate",
                format!("a tenant entry with id {} exists", entry.id),
            ))
        }
        _ => {}
    }
    entry.created_at = existing.as_ref().map(|e| e.created_at).unwrap_or(now);
    entry.updated_at = now;
    // A create never arrives revoked, and an update cannot revoke: that is
    // what the delete arm is for, and it records who did it.
    entry.revoked_at = existing.as_ref().and_then(|e| e.revoked_at);
    validate_tenant_entry(services, &entry)?;
    services
        .admission
        .with_store(|store| store.upsert_tenant_entry(&entry))
        .map_err(EnvironmentServiceError::store)?;
    Ok(entry)
}

/// Read every declaration file a repository carries under `root`.
pub fn read_declaration(root: &str) -> Served<DeclarationReadResult> {
    let base = std::path::Path::new(root);
    let mut searched = Vec::new();
    let mut files = Vec::new();
    for (relative, kind) in DECLARATION_FILES {
        searched.push((*relative).to_string());
        let path = base.join(relative);
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };
        if metadata.len() > MAX_DECLARATION_BYTES {
            return Err(EnvironmentServiceError::refused(
                "declaration_too_large",
                format!(
                    "{relative} is {} bytes, over the {MAX_DECLARATION_BYTES} byte limit \
                     for a declaration file",
                    metadata.len()
                ),
            ));
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| EnvironmentServiceError::Unreadable(format!("{relative}: {error}")))?;
        let bytes_sha256 = sha256_hex(&bytes);
        let contents = String::from_utf8(bytes).map_err(|_| {
            EnvironmentServiceError::refused(
                "declaration_not_utf8",
                format!("{relative} is not UTF-8"),
            )
        })?;
        files.push(DeclarationRead {
            path: path.to_string_lossy().into_owned(),
            relative_path: (*relative).to_string(),
            file: (*kind).to_string(),
            contents,
            bytes_sha256,
        });
    }
    Ok(DeclarationReadResult { files, searched })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            use std::fmt::Write as _;
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// Re-admit a spec without starting anything.
pub fn preview_spec(
    services: &PoolServices,
    spec: &Value,
    available_tiers: Vec<IsolationTier>,
) -> SpecPreview {
    use cognia_external_agent::sandbox_routing_backend::SandboxErrorKind;
    use cognia_sandbox_pool::admission::SandboxAdmission as _;

    match services.admission.admit(spec, &available_tiers) {
        Ok(admitted) => SpecPreview {
            admitted: true,
            spec_digest: Some(admitted.admission.spec_digest),
            actual_tier: Some(admitted.admission.actual_tier),
            size_class_id: Some(admitted.admission.size_class.id),
            bundle_digest: Some(admitted.admission.bundle.digest),
            available_tiers,
            refusal_code: None,
            refusal_message: None,
            fault: false,
        },
        Err(error) => SpecPreview {
            admitted: false,
            spec_digest: None,
            actual_tier: None,
            size_class_id: None,
            bundle_digest: None,
            available_tiers,
            refusal_code: Some(error.code.clone()),
            refusal_message: Some(error.message.clone()),
            fault: matches!(error.kind, SandboxErrorKind::Fault),
        },
    }
}

/// The driver's status, keeping "the daemon did not answer" separate from
/// "no tier is available".
pub async fn driver_status(services: &PoolServices) -> DriverStatus {
    let baseline = services.admission.baseline();
    let bundles = baseline
        .bundle
        .as_ref()
        .map(|policy| {
            std::iter::once((&policy.current, true))
                .chain(policy.retained.iter().map(|bundle| (bundle, false)))
                .map(|(bundle, current)| OfferedBundleView {
                    registry: bundle.registry.clone(),
                    repository: bundle.repository.clone(),
                    digest: bundle.digest.clone(),
                    release_tag: bundle.release_tag.clone(),
                    current,
                })
                .collect()
        })
        .unwrap_or_default();
    let (available_tiers, reachable, unreachable_reason) =
        match services.status.available_tiers().await {
            Ok(tiers) => (tiers, true, None),
            Err(error) => (Vec::new(), false, Some(error.message)),
        };
    DriverStatus {
        driver: services.status.driver().to_string(),
        deployment_id: services.status.deployment_id().to_string(),
        instance_id: services.status.instance_id().to_string(),
        multi_tenant: baseline.multi_tenant,
        isolation_floor: baseline.isolation_floor,
        available_tiers,
        reachable,
        unreachable_reason,
        bundles,
    }
}

/// Read one cached probe entry, distinguishing absent from unreadable.
pub fn probe_cache(
    services: &PoolServices,
    user_image_digest: &str,
    bundle_digest: &str,
) -> ProbeCacheResult {
    use cognia_sandbox_pool::admission::SandboxAdmission as _;

    let entry = services
        .admission
        .cached_probe(user_image_digest, bundle_digest);
    let cached = entry.as_ref().and_then(probe_view);
    ProbeCacheResult {
        unreadable: entry.is_some() && cached.is_none(),
        cached,
    }
}

fn probe_view(entry: &Value) -> Option<ProbeCacheView> {
    let entry = ProbeCacheEntry::from_value(entry)?;
    let owner = |owner: Ownership| ProbeOwnerView {
        uid: owner.uid,
        gid: owner.gid,
    };
    let report = entry.report;
    let problems = report
        .problems
        .into_iter()
        .map(|problem| {
            // The wire name is the serde rename, which is also what the UI
            // localizes; an unnamed variant would be a build error there.
            let code = serde_json::to_value(problem.code)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))?;
            Some(ProbeProblemView {
                code,
                message: problem.message,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(ProbeCacheView {
        version: entry.version,
        requested_user: entry.user,
        resolved_user: report.user.map(|user| ProbeUserView {
            name: user.name,
            uid: user.uid,
            gid: user.gid,
            remapped_from: report.user_remapped_from.map(owner),
        }),
        match_workspace_owner: entry.match_workspace_owner,
        workspace_owner: entry.workspace_owner.map(owner),
        libc: report.libc.map(|libc| libc.as_str().to_string()),
        arch: report.arch.as_str().to_string(),
        shell: report.shell,
        runtimes: report.runtimes,
        problems,
    })
}

/// Where an image reference may be read from, or why it may not.
///
/// Only a registry the baseline allowlists is contacted at all — the
/// reference is caller-chosen, and without this the Host's registry
/// credentials would answer challenges from any host a caller named. The
/// scheme comes from the matching rule, never from the reference.
pub fn inspect_target(
    services: &PoolServices,
    raw: &str,
) -> Served<(ImageReference, RegistryEndpoint)> {
    let reference = ImageReference::parse(raw).map_err(|error| {
        EnvironmentServiceError::refused("image_reference_invalid", error.to_string())
    })?;
    let image = cognia_environment::catalog::CatalogImage {
        registry: reference.registry.clone(),
        repository: reference.repository.clone(),
        digest: None,
        tag: None,
    };
    let insecure = services
        .admission
        .baseline()
        .registry_is_insecure(&image)
        .ok_or_else(|| {
            EnvironmentServiceError::refused(
                "catalog_registry_not_allowlisted",
                format!(
                    "{}/{} is not on this deployment's registry allowlist",
                    reference.registry, reference.repository
                ),
            )
        })?;
    let endpoint = RegistryEndpoint {
        registry: reference.registry.clone(),
        insecure,
    };
    Ok((reference, endpoint))
}

/// Read what an image reference is: the digest it resolves to now, and the
/// user and environment each supported platform declares.
///
/// Generic over the transport so the refusal paths are tested without a
/// network; the dispatch arm passes the production transport.
pub async fn inspect_image<T: RegistryTransport + Sync>(
    services: &PoolServices,
    raw: &str,
    transport: T,
    credentials: RegistryCredentials,
) -> Served<ImageMetadata> {
    let (reference, endpoint) = inspect_target(services, raw)?;
    RegistryClient::new(transport, credentials)
        .fetch_metadata(&endpoint, &reference, &Platform::supported())
        .await
        .map_err(|error| {
            if error.is_transient() {
                EnvironmentServiceError::Upstream {
                    code: error.code().to_string(),
                    message: error.to_string(),
                }
            } else {
                EnvironmentServiceError::refused(error.code(), error.to_string())
            }
        })
}

/// One page of the approval ledger.
pub fn approval_page(
    services: &PoolServices,
    project_id: Option<&str>,
    include_revoked: bool,
    request: &cognia_problem::paging::PageRequest,
) -> Served<Page<ApprovalRecord>> {
    let mut all = services
        .admission
        .with_store(|store| store.list_approvals(project_id))
        .map_err(EnvironmentServiceError::store)?;
    // The ledger keeps revocations rather than deleting rows, so hiding them
    // is a filter here and not a narrower query: a console that asked for the
    // history has to be able to get it.
    if !include_revoked {
        all.retain(ApprovalRecord::is_active);
    }
    Page::slice_all(all, request, DEFAULT_PAGE_SIZE)
        .map_err(|error| EnvironmentServiceError::refused("malformed_request", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_environment::approval::EgressGrant;
    use cognia_environment::baseline::{load_baseline_from, BaselineInputs};
    use cognia_environment::catalog::{CatalogEntrySource, CatalogImage};
    use cognia_environment::registry::auth::RegistryCredentials;
    use cognia_environment::spec::EgressTier;
    use cognia_environment::store::EnvironmentStore;
    use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
    use cognia_problem::paging::PageRequest;
    use cognia_sandbox_pool::admission::EnvironmentSandboxAdmission;
    use cognia_sandbox_pool::status::SandboxDriverStatus;
    use std::sync::Arc;

    const BUNDLE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const IMAGE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    struct FakeDriver {
        tiers: Option<Vec<IsolationTier>>,
    }

    #[async_trait::async_trait]
    impl SandboxDriverStatus for FakeDriver {
        fn driver(&self) -> &'static str {
            "docker"
        }
        fn deployment_id(&self) -> &str {
            "dep1"
        }
        fn instance_id(&self) -> &str {
            "inst1"
        }
        async fn available_tiers(&self) -> Result<Vec<IsolationTier>, SandboxSpawnError> {
            match &self.tiers {
                Some(tiers) => Ok(tiers.clone()),
                None => Err(SandboxSpawnError::fault(
                    "sandbox_daemon_unreachable",
                    "the container daemon did not answer",
                )),
            }
        }
    }

    fn pool(tiers: Option<Vec<IsolationTier>>) -> PoolServices {
        let inputs = BaselineInputs {
            sandbox_pool_enabled: Some("1".into()),
            runner_image: Some(format!("ghcr.io/acme/runner@sha256:{IMAGE}")),
            agent_bundle_image: Some(format!("ghcr.io/acme/bundle@sha256:{BUNDLE}")),
            ..BaselineInputs::default()
        };
        let baseline = load_baseline_from(&inputs)
            .expect("a legacy baseline")
            .baseline;
        PoolServices {
            runtime: None,
            admission: Arc::new(EnvironmentSandboxAdmission::new(
                baseline,
                EnvironmentStore::open_in_memory().expect("an in-memory store"),
                RegistryCredentials::empty(),
                false,
            )),
            status: Arc::new(FakeDriver { tiers }),
        }
    }

    #[test]
    fn recorded_build_reads_are_project_scoped_and_require_one_selector() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let record = cognia_environment::store::EnvironmentBuildRecord {
            build_key: "a".repeat(64),
            image_id: format!("sha256:{}", "b".repeat(64)),
            project_id: "project".into(),
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
        services
            .admission
            .with_store(|store| store.record_build(&record))
            .unwrap();
        let status = get_build(&services, "project", None, Some(&record.build_key)).unwrap();
        assert_eq!(status.status, BuildPhase::Succeeded);
        assert_eq!(status.record.unwrap().image_id, record.image_id);
        assert_eq!(
            get_build(&services, "other", None, Some(&record.build_key))
                .unwrap_err()
                .code(),
            "environment_build_missing"
        );
        assert_eq!(
            get_build(&services, "project", None, None)
                .unwrap_err()
                .code(),
            "environment_build_invalid"
        );
        assert_eq!(
            get_build(&services, "project", Some("job"), Some(&record.build_key))
                .unwrap_err()
                .code(),
            "environment_build_invalid"
        );
    }

    /// A transport that records what it was asked and answers from a closure.
    struct ScriptedRegistry {
        asked: parking_lot::Mutex<Vec<String>>,
        answer: fn(
            &cognia_environment::registry::RegistryRequest,
        ) -> Result<
            cognia_environment::registry::RegistryResponse,
            cognia_environment::registry::RegistryError,
        >,
    }

    impl RegistryTransport for &ScriptedRegistry {
        fn send(
            &self,
            request: cognia_environment::registry::RegistryRequest,
        ) -> impl std::future::Future<
            Output = Result<
                cognia_environment::registry::RegistryResponse,
                cognia_environment::registry::RegistryError,
            >,
        > + Send {
            self.asked.lock().push(request.url.to_string());
            std::future::ready((self.answer)(&request))
        }
    }

    /// The reference is the caller's; the registry host is the operator's.
    /// Without the allowlist check the Host's registry credentials would
    /// answer challenges from any host a caller named.
    #[tokio::test]
    async fn an_image_outside_the_allowlist_is_refused_before_any_registry_is_contacted() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let registry = ScriptedRegistry {
            asked: parking_lot::Mutex::new(Vec::new()),
            answer: |_| panic!("no registry may be contacted"),
        };
        let error = inspect_image(
            &services,
            "evil.example.com/acme/runner:latest",
            &registry,
            RegistryCredentials::empty(),
        )
        .await
        .expect_err("not allowlisted");
        assert_eq!(error.code(), "catalog_registry_not_allowlisted");
        assert!(registry.asked.lock().is_empty());
    }

    #[test]
    fn a_reference_that_does_not_parse_is_refused_as_such() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let error = inspect_target(&services, "UPPER/Case:tag").expect_err("invalid");
        assert_eq!(error.code(), "image_reference_invalid");
        assert!(!error.retryable());
    }

    /// The scheme is the allowlist rule's, and an allowlisted reference goes
    /// to its own registry over HTTPS.
    #[test]
    fn an_allowlisted_reference_is_read_from_its_own_registry_over_https() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let (reference, endpoint) =
            inspect_target(&services, "ghcr.io/acme/runner:v1").expect("allowlisted");
        assert_eq!(reference.repository, "acme/runner");
        assert_eq!(endpoint.registry, "ghcr.io");
        assert!(!endpoint.insecure);
    }

    /// A registry that is down is worth retrying and says which registry
    /// failed; it is not reported as the environment store being down.
    #[tokio::test]
    async fn a_registry_outage_is_retryable_and_keeps_the_registry_code() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let registry = ScriptedRegistry {
            asked: parking_lot::Mutex::new(Vec::new()),
            answer: |_| {
                Err(cognia_environment::registry::RegistryError::Unreachable {
                    registry: "ghcr.io".into(),
                    message: "connection refused".into(),
                })
            },
        };
        let error = inspect_image(
            &services,
            "ghcr.io/acme/runner:v1",
            &registry,
            RegistryCredentials::empty(),
        )
        .await
        .expect_err("unreachable");
        assert_eq!(error.code(), "registry_unreachable");
        assert!(error.retryable());
        assert_eq!(registry.asked.lock().len(), 1);
    }

    /// A missing tag is an answer about the reference, not a fault.
    #[tokio::test]
    async fn a_missing_image_is_a_refusal_not_a_fault() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let registry = ScriptedRegistry {
            asked: parking_lot::Mutex::new(Vec::new()),
            answer: |_| {
                Ok(cognia_environment::registry::RegistryResponse {
                    status: 404,
                    headers: Vec::new(),
                    body: Vec::new(),
                })
            },
        };
        let error = inspect_image(
            &services,
            "ghcr.io/acme/runner:gone",
            &registry,
            RegistryCredentials::empty(),
        )
        .await
        .expect_err("not found");
        assert_eq!(error.code(), "registry_not_found");
        assert!(!error.retryable());
    }

    fn tenant_entry(id: &str) -> CatalogEntry {
        CatalogEntry {
            id: id.to_string(),
            scope: CatalogScope::Tenant,
            label: "Tenant image".into(),
            description: None,
            image: CatalogImage {
                registry: "ghcr.io".into(),
                // The legacy baseline allowlists exactly the runner image's own
                // repository, so a tenant entry elsewhere is refused even on the
                // same registry — which is the point of the allowlist.
                repository: "acme/runner".into(),
                digest: Some(format!("sha256:{IMAGE}")),
                tag: None,
            },
            isolation_floor: IsolationTier::Container,
            // The legacy baseline offers exactly one class; an entry with none is
            // refused as invalid before the registry is even consulted.
            size_class_ids: vec![cognia_environment::baseline::LEGACY_SIZE_CLASS_ID.to_string()],
            image_user: None,
            source: CatalogEntrySource::Manual,
            provenance: None,
            revoked_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// The off path is one `None` read in one place. Nothing here may open a
    /// store or answer an empty collection on a deployment that never opted
    /// in.
    #[test]
    fn a_deployment_with_no_pool_has_nothing_installed() {
        uninstall();
        assert!(installed().is_none());
    }

    /// A tenant may add an image the baseline allowlist permits, and it comes
    /// back through the merge rather than straight from the write.
    #[test]
    fn a_permitted_tenant_entry_is_stored_and_merged() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let written = write_catalog_entry(&services, tenant_entry("acme-dev"), false, 99)
            .expect("ghcr is the baseline's own registry");
        assert_eq!(written.created_at, 99);
        assert_eq!(written.updated_at, 99);
        let page = catalog_page(&services, &PageRequest::default()).expect("a catalog page");
        assert!(page.items.iter().any(|view| view.entry.id == "acme-dev"));
        assert!(page.rejected.is_empty());
        assert_eq!(page.next_page_token, None);
        // A resolver reads the entries and the floor, the switch, the size
        // classes and the bundle offer from ONE answer. Splitting them across
        // commands would let it resolve against two different reads.
        assert!(page.pool_enabled);
        assert_eq!(page.floor, IsolationTier::Container);
        assert!(!page.size_classes.is_empty());
        assert!(page.bundle.is_some());
    }

    /// The merge's refusal is the write's refusal. A tenant that could store
    /// an entry the merge drops would see a catalog no spawn agrees with.
    #[test]
    fn an_entry_outside_the_registry_allowlist_is_refused_before_it_is_stored() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let mut entry = tenant_entry("elsewhere");
        entry.image.registry = "registry.example.invalid".into();
        let error = write_catalog_entry(&services, entry, false, 1).expect_err("not allowlisted");
        assert_eq!(error.code(), "catalog_registry_not_allowlisted");
        assert!(!error.retryable());
        assert!(services
            .admission
            .with_store(|store| store.list_tenant_entries())
            .expect("a readable store")
            .is_empty());
    }

    /// A baseline-scoped entry is the operator's. Writing one here would let a
    /// tenant mint an entry the baseline never shipped.
    #[test]
    fn a_baseline_scoped_entry_cannot_be_written_as_a_tenant_entry() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let mut entry = tenant_entry("pretend-baseline");
        entry.scope = CatalogScope::Baseline;
        let error = write_catalog_entry(&services, entry, false, 1).expect_err("wrong scope");
        assert_eq!(error.code(), "tenant_entry_scope");
    }

    /// A create that found an existing id must not silently replace it, and an
    /// update that found none must not silently create one.
    #[test]
    fn create_and_update_disagree_about_an_id_that_already_exists() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let missing = write_catalog_entry(&services, tenant_entry("nope"), true, 1)
            .expect_err("nothing to update");
        assert_eq!(missing.code(), "environment_record_not_found");
        write_catalog_entry(&services, tenant_entry("dup"), false, 1).expect("the first create");
        let duplicate = write_catalog_entry(&services, tenant_entry("dup"), false, 2)
            .expect_err("already exists");
        assert_eq!(duplicate.code(), "catalog_entry_duplicate");
        let updated = write_catalog_entry(&services, tenant_entry("dup"), true, 7)
            .expect("an update finds it");
        assert_eq!(updated.created_at, 1, "a create time is not rewritten");
        assert_eq!(updated.updated_at, 7);
    }

    /// An unreachable daemon attests no tier. Reporting that as an empty tier
    /// list with no reason would read as "this driver offers no isolation",
    /// which is a different and much worse claim.
    #[tokio::test]
    async fn an_unreachable_daemon_is_reported_as_unreachable_not_as_tierless() {
        let status = driver_status(&pool(None)).await;
        assert!(!status.reachable);
        assert!(status.available_tiers.is_empty());
        assert_eq!(
            status.unreachable_reason.as_deref(),
            Some("the container daemon did not answer")
        );
        assert_eq!(status.driver, "docker");
        assert_eq!(status.deployment_id, "dep1");
    }

    /// The offered bundles are what a console shows to let a project pin one,
    /// so the current bundle has to be distinguishable from a retained one.
    #[tokio::test]
    async fn the_status_names_the_offered_bundles() {
        let status = driver_status(&pool(Some(vec![IsolationTier::Container]))).await;
        assert_eq!(status.bundles.len(), 1);
        assert!(status.bundles[0].current);
        assert_eq!(status.bundles[0].digest, format!("sha256:{BUNDLE}"));
        assert_eq!(status.available_tiers, vec![IsolationTier::Container]);
    }

    /// A spec nothing can read is refused, and the preview says it is not a
    /// fault — a fault would fall back at spawn time, so reporting one here
    /// would misdescribe what happens next.
    #[test]
    fn a_preview_of_an_unreadable_spec_is_a_refusal_not_a_fault() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let preview = preview_spec(
            &services,
            &serde_json::json!({ "not": "a spec" }),
            vec![IsolationTier::Container],
        );
        assert!(!preview.admitted);
        assert!(!preview.fault);
        assert!(preview.refusal_code.is_some());
        assert_eq!(preview.available_tiers, vec![IsolationTier::Container]);
    }

    /// A cached entry this build cannot read is not the same as no entry: one
    /// says "re-probe", the other says "probe".
    #[test]
    fn a_probe_entry_that_does_not_parse_is_unreadable_rather_than_absent() {
        assert!(probe_view(&serde_json::json!({ "version": 1 })).is_none());
        // The shape an earlier build of this view assumed: a flat report and a
        // numeric owner. No driver writes it.
        assert!(probe_view(&serde_json::json!({
            "version": 1,
            "user": "root",
            "matchWorkspaceOwner": false,
            "workspaceOwner": 1000,
            "report": { "libc": "glibc", "arch": "amd64", "shell": "/bin/sh" },
        }))
        .is_none());
    }

    /// The view is read from exactly what the Docker driver writes, and a
    /// probe that refused the image must read back as refused.
    #[test]
    fn a_probe_entry_reads_back_as_the_driver_wrote_it() {
        use cognia_sandbox_pool::probe_cache::{
            Arch, Libc, ProbeCode, ProbeProblem, ProbeReport, ResolvedUser, UserSpec,
            PROBE_REPORT_VERSION,
        };

        let report = ProbeReport {
            version: PROBE_REPORT_VERSION,
            arch: Arch::Amd64,
            libc: Some(Libc::Glibc),
            glibc_version: None,
            interpreter: None,
            shell: Some("/bin/dash".to_string()),
            user: Some(ResolvedUser {
                name: Some("vscode".to_string()),
                uid: 1000,
                gid: 1000,
                groups: vec![1000],
                home: Some("/home/vscode".to_string()),
            }),
            user_remapped_from: Some(Ownership {
                uid: 1001,
                gid: 1001,
            }),
            workspace_owner: Some(Ownership {
                uid: 1000,
                gid: 1000,
            }),
            home_writable: Some(true),
            workspace_writable: true,
            ca_bundle: None,
            runtimes: vec!["codex-acp".to_string()],
            commands: Vec::new(),
            problems: vec![ProbeProblem {
                code: ProbeCode::GlibcTooOld,
                message: "glibc 2.24 is older than 2.28".to_string(),
            }],
        };
        let stored = ProbeCacheEntry::new(
            &UserSpec::Name("vscode".to_string()),
            true,
            Some(Ownership {
                uid: 1000,
                gid: 1000,
            }),
            report,
        )
        .to_value();

        let view = probe_view(&stored).expect("readable");
        assert_eq!(view.requested_user, "vscode");
        assert_eq!(
            view.resolved_user,
            Some(ProbeUserView {
                name: Some("vscode".to_string()),
                uid: 1000,
                gid: 1000,
                remapped_from: Some(ProbeOwnerView {
                    uid: 1001,
                    gid: 1001
                }),
            })
        );
        assert_eq!(
            view.workspace_owner,
            Some(ProbeOwnerView {
                uid: 1000,
                gid: 1000
            })
        );
        assert_eq!(view.libc.as_deref(), Some("glibc"));
        assert_eq!(view.arch, "amd64");
        assert_eq!(view.runtimes, vec!["codex-acp".to_string()]);
        assert_eq!(
            view.problems,
            vec![ProbeProblemView {
                code: "probe_glibc_too_old".to_string(),
                message: "glibc 2.24 is older than 2.28".to_string(),
            }]
        );
    }

    /// Deleting an entry that is not there is an answer about the request, not
    /// an outage: a client that retried it would retry forever.
    #[test]
    fn a_missing_record_is_not_found_rather_than_a_retryable_store_fault() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let error: EnvironmentServiceError = services
            .admission
            .with_store(|store| store.revoke_tenant_entry("nope", 1))
            .expect_err("no such entry")
            .into();
        assert_eq!(error.code(), "environment_record_not_found");
        assert!(!error.retryable());
    }

    /// A repository with no declaration is the common case, and the answer
    /// says where it looked so a UI can be specific.
    #[test]
    fn a_workspace_with_no_declaration_reports_where_it_looked() {
        let dir = tempfile::tempdir().expect("a temp workspace");
        let result = read_declaration(&dir.path().to_string_lossy()).expect("no declaration");
        assert!(result.files.is_empty());
        assert_eq!(result.searched.len(), DECLARATION_FILES.len());
    }

    /// Both files come back, in `DECLARATION_FILES` order, and each digest is
    /// over the exact bytes — which is what makes "it changed since you
    /// approved it" answerable without parsing either grammar.
    ///
    /// The Host does **not** pick the winner. Precedence is
    /// `read-environment-declaration.ts`'s, and a Host that returned only its
    /// own first match would be a second answer to the same question.
    #[test]
    fn every_declaration_file_comes_back_in_precedence_order_digested_verbatim() {
        let dir = tempfile::tempdir().expect("a temp workspace");
        std::fs::create_dir_all(dir.path().join(".cognia")).expect("a .cognia dir");
        std::fs::write(
            dir.path().join(".cognia/workspace.json"),
            "{\"version\":1}\n",
        )
        .expect("a workspace config");
        std::fs::write(dir.path().join(".devcontainer.json"), "{}").expect("a devcontainer");
        let result = read_declaration(&dir.path().to_string_lossy()).expect("a declaration");
        assert_eq!(
            result
                .files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec![".cognia/workspace.json", ".devcontainer.json"]
        );
        assert_eq!(result.files[0].file, "workspace-config");
        assert_eq!(result.files[1].file, "devcontainer");
        assert_eq!(
            result.files[0].bytes_sha256,
            sha256_hex(b"{\"version\":1}\n")
        );
    }

    /// An egress grant is active until it is revoked, and the ledger keeps the
    /// revocation rather than dropping the row.
    #[test]
    fn a_stored_egress_grant_is_active_until_it_is_revoked() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let grant = EgressGrant {
            id: "grant1".into(),
            project_id: "prj1".into(),
            tier: EgressTier::Allowlist,
            domains: vec!["registry.npmjs.org".into()],
            granted_by: "usr_alice".into(),
            granted_at: 10,
            revoked_at: None,
        };
        services
            .admission
            .with_store(|store| store.record_egress_grant(&grant))
            .expect("a recordable grant");
        let active = services
            .admission
            .with_store(|store| store.active_egress_grant("prj1"))
            .expect("a readable store")
            .expect("an active grant");
        assert_eq!(active.granted_by, "usr_alice");
        let revoked = services
            .admission
            .with_store(|store| store.revoke_egress_grant("grant1", 20))
            .expect("a revocable grant");
        assert_eq!(revoked.revoked_at, Some(20));
        assert!(services
            .admission
            .with_store(|store| store.active_egress_grant("prj1"))
            .expect("a readable store")
            .is_none());
    }

    /// The approval ledger pages, and a filter by project is a filter, not a
    /// suggestion.
    #[test]
    fn the_approval_ledger_pages_and_filters_by_project() {
        let services = pool(Some(vec![IsolationTier::Container]));
        let page = approval_page(&services, Some("prj1"), false, &PageRequest::default())
            .expect("an empty ledger still pages");
        assert!(page.items.is_empty());
        assert_eq!(page.next_page_token, None);
    }
}
