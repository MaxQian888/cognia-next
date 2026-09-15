//! Where a deployment's environment baseline comes from (ADR-0182).
//!
//! Three sources, checked in order:
//!
//! 1. **A baseline file** named by `COGNIA_ENVIRONMENT_BASELINE_FILE`. The Ops
//!    Controller's `apply-environment-baseline` operation writes it (a
//!    ConfigMap mount on Kubernetes, `environment-baseline.json` beside the
//!    compose file); a standalone operator can write it by hand. The file is
//!    the whole baseline, the pool switch included, so
//!    `COGNIA_SANDBOX_POOL_ENABLED` is ignored (with a note) when it exists.
//! 2. **The legacy mapping** from `COGNIA_RUNNER_IMAGE`: one `legacy-env`
//!    entry, a size class from `COGNIA_RUNNER_CPUS` / `COGNIA_RUNNER_MEMORY_MB`,
//!    the agent bundle from `COGNIA_AGENT_BUNDLE_IMAGE` with the older bundles
//!    projects may still pin from `COGNIA_AGENT_BUNDLE_RETAINED_IMAGES`, and the
//!    pool switch from `COGNIA_SANDBOX_POOL_ENABLED`. A controller-managed
//!    deployment gets both bundle variables from its release (ADR-0183).
//! 3. **Nothing**: [`EnvironmentBaseline::disabled`].
//!
//! # What refuses boot and what does not
//!
//! The pool is off by default and a deployment that never turns it on must
//! boot exactly as before, whatever its runner variables hold (ADR-0182
//! "legacy layout keeps working while the pool is off"). So with the pool off,
//! a legacy variable the mapping cannot use becomes a [`BaselineNote`] and the
//! entry it would have produced is left out.
//!
//! Everything else is a [`BaselineError`] the server refuses to boot on:
//!
//! - a baseline file that cannot be read, is too large, is not JSON or does
//!   not validate. The file may be the thing declaring `multiTenant`; booting
//!   without it would run other tenants' code without the isolation it asks
//!   for, which is exactly the fallback the fault rule forbids.
//! - with the pool switched on by the environment, a legacy variable that is
//!   malformed, or no runner image at all — the operator opted in and a pool
//!   with an empty catalog admits nothing.
//!
//! Tag-only images are not errors in either mode: the legacy entry keeps its
//! tag and admission refuses it (`image_digest_not_pinned`) until an operator
//! pins it, which the catalog UI shows next to the entry.
//!
//! Every function here takes its inputs as values ([`BaselineInputs`]) so the
//! rules are testable without touching the process environment.

use std::path::{Path, PathBuf};

use crate::catalog::{
    CatalogEntry, CatalogEntrySource, CatalogError, CatalogImage, CatalogScope,
    EnvironmentBaseline, OfferedBundle, RegistryRule, SandboxPoolSwitch, SizeClass,
};
use crate::image::ImageReference;
use crate::spec::IsolationTier;

/// Path to the baseline JSON (ConfigMap mount or compose file).
pub const BASELINE_FILE_ENV: &str = "COGNIA_ENVIRONMENT_BASELINE_FILE";
/// Deployment-level pool switch when no baseline file exists. Default off.
pub const SANDBOX_POOL_ENABLED_ENV: &str = "COGNIA_SANDBOX_POOL_ENABLED";
/// The release's agent bundle image (ADR-0183), digest-pinned by the release.
pub const AGENT_BUNDLE_IMAGE_ENV: &str = "COGNIA_AGENT_BUNDLE_IMAGE";
/// Comma-separated, digest-pinned bundle images a project may still pin,
/// newest first. The Ops Controller fills it from its release history.
pub const AGENT_BUNDLE_RETAINED_IMAGES_ENV: &str = "COGNIA_AGENT_BUNDLE_RETAINED_IMAGES";
/// Same names as `cognia_external_agent::container_backend::{RUNNER_IMAGE_ENV,
/// RUNNER_CPUS_ENV, RUNNER_MEMORY_MB_ENV}`; this crate stays free of that
/// dependency, and the legacy backend's defaults are repeated below.
pub const RUNNER_IMAGE_ENV: &str = "COGNIA_RUNNER_IMAGE";
pub const RUNNER_CPUS_ENV: &str = "COGNIA_RUNNER_CPUS";
pub const RUNNER_MEMORY_MB_ENV: &str = "COGNIA_RUNNER_MEMORY_MB";

/// The id of the entry derived from `COGNIA_RUNNER_IMAGE`.
pub const LEGACY_ENTRY_ID: &str = "legacy-env";
/// The id of the size class derived from the runner resource variables.
pub const LEGACY_SIZE_CLASS_ID: &str = "legacy";
/// Largest baseline file accepted.
pub const MAX_BASELINE_FILE_BYTES: u64 = 1024 * 1024;

/// The legacy container backend's defaults (`container_backend.rs`).
const LEGACY_DEFAULT_CPU_MILLIS: u32 = 2_000;
const LEGACY_DEFAULT_MEMORY_MIB: u32 = 2_048;
/// The legacy backend sets no storage limits; these only size a pool sandbox.
const LEGACY_EPHEMERAL_STORAGE_MIB: u32 = 10_240;
const LEGACY_VOLUME_MIB: u32 = 20_480;
/// Release tag recorded for a bundle image that carries only a digest.
const UNTAGGED_BUNDLE_RELEASE: &str = "untagged";

/// The environment variables the loader reads, captured once.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BaselineInputs {
    pub baseline_file: Option<PathBuf>,
    pub sandbox_pool_enabled: Option<String>,
    pub runner_image: Option<String>,
    pub runner_cpus: Option<String>,
    pub runner_memory_mb: Option<String>,
    pub agent_bundle_image: Option<String>,
    pub agent_bundle_retained_images: Option<String>,
}

impl BaselineInputs {
    /// Reads the variables through `lookup`. Blank values count as unset, as a
    /// compose `${VAR:-}` interpolation produces them.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let read = |name: &str| lookup(name).filter(|value| !value.trim().is_empty());
        Self {
            baseline_file: read(BASELINE_FILE_ENV).map(PathBuf::from),
            sandbox_pool_enabled: read(SANDBOX_POOL_ENABLED_ENV),
            runner_image: read(RUNNER_IMAGE_ENV),
            runner_cpus: read(RUNNER_CPUS_ENV),
            runner_memory_mb: read(RUNNER_MEMORY_MB_ENV),
            agent_bundle_image: read(AGENT_BUNDLE_IMAGE_ENV),
            agent_bundle_retained_images: read(AGENT_BUNDLE_RETAINED_IMAGES_ENV),
        }
    }

    pub fn from_process_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BaselineOrigin {
    File(PathBuf),
    LegacyEnv,
    Disabled,
}

impl BaselineOrigin {
    /// Wire value for the catalog UI.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::File(_) => "file",
            Self::LegacyEnv => "legacy-env",
            Self::Disabled => "disabled",
        }
    }
}

/// Something the loader ignored or could not use, shown to the operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaselineNote {
    pub code: &'static str,
    pub variable: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedBaseline {
    pub baseline: EnvironmentBaseline,
    pub origin: BaselineOrigin,
    pub notes: Vec<BaselineNote>,
}

#[derive(Debug, thiserror::Error)]
pub enum BaselineError {
    #[error("cannot read environment baseline {path}: {source}")]
    FileUnreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("environment baseline {path} is {size} bytes; the limit is {MAX_BASELINE_FILE_BYTES}")]
    FileTooLarge { path: PathBuf, size: u64 },
    #[error("environment baseline {path} is not a valid baseline document: {message}")]
    FileMalformed { path: PathBuf, message: String },
    #[error("environment baseline is invalid: {0}")]
    Invalid(#[from] CatalogError),
    #[error("{variable} is invalid: {message}")]
    EnvInvalid {
        variable: &'static str,
        message: String,
    },
    #[error(
        "{SANDBOX_POOL_ENABLED_ENV} is on but there is no catalog: set {BASELINE_FILE_ENV} or {RUNNER_IMAGE_ENV}"
    )]
    PoolWithoutCatalog,
}

impl BaselineError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::FileUnreadable { .. } => "baseline_file_unreadable",
            Self::FileTooLarge { .. } => "baseline_file_too_large",
            Self::FileMalformed { .. } => "baseline_file_malformed",
            Self::Invalid(error) => error.code,
            Self::EnvInvalid { .. } => "baseline_env_invalid",
            Self::PoolWithoutCatalog => "baseline_pool_without_catalog",
        }
    }
}

/// Loads the baseline from the process environment. See the module docs.
pub fn load_baseline() -> Result<LoadedBaseline, BaselineError> {
    load_baseline_from(&BaselineInputs::from_process_env())
}

pub fn load_baseline_from(inputs: &BaselineInputs) -> Result<LoadedBaseline, BaselineError> {
    if let Some(path) = &inputs.baseline_file {
        let baseline = read_baseline_file(path)?;
        let mut notes = Vec::new();
        if inputs.sandbox_pool_enabled.is_some() {
            notes.push(BaselineNote {
                code: "baseline_env_ignored",
                variable: SANDBOX_POOL_ENABLED_ENV,
                message: format!(
                    "{SANDBOX_POOL_ENABLED_ENV} is ignored: the baseline file sets sandboxPool.enabled"
                ),
            });
        }
        return Ok(LoadedBaseline {
            baseline,
            origin: BaselineOrigin::File(path.clone()),
            notes,
        });
    }

    let pool_enabled = match &inputs.sandbox_pool_enabled {
        None => false,
        Some(raw) => parse_switch(raw).ok_or_else(|| BaselineError::EnvInvalid {
            variable: SANDBOX_POOL_ENABLED_ENV,
            message: format!("{raw:?} is not one of true/false/1/0/yes/no/on/off"),
        })?,
    };

    let Some(runner_image) = &inputs.runner_image else {
        if pool_enabled {
            return Err(BaselineError::PoolWithoutCatalog);
        }
        return Ok(LoadedBaseline {
            baseline: EnvironmentBaseline::disabled(),
            origin: BaselineOrigin::Disabled,
            notes: Vec::new(),
        });
    };

    legacy_baseline(inputs, runner_image, pool_enabled)
}

/// Reads and validates a baseline document.
pub fn read_baseline_file(path: &Path) -> Result<EnvironmentBaseline, BaselineError> {
    let unreadable = |source| BaselineError::FileUnreadable {
        path: path.to_path_buf(),
        source,
    };
    let size = std::fs::metadata(path).map_err(unreadable)?.len();
    if size > MAX_BASELINE_FILE_BYTES {
        return Err(BaselineError::FileTooLarge {
            path: path.to_path_buf(),
            size,
        });
    }
    let bytes = std::fs::read(path).map_err(unreadable)?;
    parse_baseline(&bytes).map_err(|error| match error {
        BaselineError::FileMalformed { message, .. } => BaselineError::FileMalformed {
            path: path.to_path_buf(),
            message,
        },
        other => other,
    })
}

/// Parses and validates baseline JSON bytes (the shape the Ops Controller
/// signs). Unknown fields are refused.
pub fn parse_baseline(bytes: &[u8]) -> Result<EnvironmentBaseline, BaselineError> {
    if bytes.len() as u64 > MAX_BASELINE_FILE_BYTES {
        return Err(BaselineError::FileTooLarge {
            path: PathBuf::new(),
            size: bytes.len() as u64,
        });
    }
    let baseline: EnvironmentBaseline =
        serde_json::from_slice(bytes).map_err(|error| BaselineError::FileMalformed {
            path: PathBuf::new(),
            message: error.to_string(),
        })?;
    baseline.validate()?;
    Ok(baseline)
}

fn legacy_baseline(
    inputs: &BaselineInputs,
    runner_image: &str,
    pool_enabled: bool,
) -> Result<LoadedBaseline, BaselineError> {
    let mut notes = Vec::new();
    let unusable = |variable: &'static str, message: String, notes: &mut Vec<BaselineNote>| {
        unusable_legacy_value(pool_enabled, variable, message, notes)
    };

    let size_class = {
        let cpu_millis = match &inputs.runner_cpus {
            None => Some(LEGACY_DEFAULT_CPU_MILLIS),
            Some(raw) => {
                let parsed = parse_cpu_millis(raw);
                if parsed.is_none() {
                    unusable(
                        RUNNER_CPUS_ENV,
                        format!("{raw:?} is not a positive CPU count"),
                        &mut notes,
                    )?;
                }
                parsed
            }
        };
        let memory_mib = match &inputs.runner_memory_mb {
            None => Some(LEGACY_DEFAULT_MEMORY_MIB),
            Some(raw) => {
                let parsed = raw.trim().parse::<u32>().ok().filter(|mib| *mib > 0);
                if parsed.is_none() {
                    unusable(
                        RUNNER_MEMORY_MB_ENV,
                        format!("{raw:?} is not a positive MiB count"),
                        &mut notes,
                    )?;
                }
                parsed
            }
        };
        cpu_millis
            .zip(memory_mib)
            .map(|(cpu_millis, memory_mib)| SizeClass {
                id: LEGACY_SIZE_CLASS_ID.into(),
                label: "Deployment default".into(),
                cpu_millis,
                memory_mib,
                ephemeral_storage_mib: LEGACY_EPHEMERAL_STORAGE_MIB,
                volume_mib: LEGACY_VOLUME_MIB,
                gpu: None,
            })
    };

    let image = match ImageReference::parse(runner_image) {
        Ok(reference) => Some(reference),
        Err(error) => {
            unusable(RUNNER_IMAGE_ENV, error.to_string(), &mut notes)?;
            None
        }
    };

    let mut bundle = match &inputs.agent_bundle_image {
        None => None,
        Some(raw) => match ImageReference::parse(raw) {
            Err(error) => {
                unusable(AGENT_BUNDLE_IMAGE_ENV, error.to_string(), &mut notes)?;
                None
            }
            Ok(ImageReference { digest: None, .. }) => {
                // A tag-only bundle is not an error in either mode: admission
                // refuses `bundle_unavailable` until the release pins it.
                notes.push(BaselineNote {
                    code: "baseline_bundle_unpinned",
                    variable: AGENT_BUNDLE_IMAGE_ENV,
                    message: format!(
                        "{raw:?} has no digest; sandboxes cannot start until it is pinned"
                    ),
                });
                None
            }
            Ok(ImageReference {
                registry,
                repository,
                digest: Some(digest),
                tag,
            }) => Some(crate::catalog::BundlePolicy {
                current: OfferedBundle {
                    registry,
                    repository,
                    digest,
                    release_tag: tag.unwrap_or_else(|| UNTAGGED_BUNDLE_RELEASE.into()),
                },
                retained: Vec::new(),
            }),
        },
    };

    if let Some(raw) = &inputs.agent_bundle_retained_images {
        match bundle.as_mut() {
            // Nothing to retain beside; the current bundle's own note or
            // error already says why.
            None => notes.push(BaselineNote {
                code: "baseline_bundle_retained_ignored",
                variable: AGENT_BUNDLE_RETAINED_IMAGES_ENV,
                message: format!(
                    "{AGENT_BUNDLE_RETAINED_IMAGES_ENV} is ignored without a pinned {AGENT_BUNDLE_IMAGE_ENV}"
                ),
            }),
            Some(policy) => {
                for item in raw.split(',').map(str::trim).filter(|item| !item.is_empty()) {
                    match ImageReference::parse(item) {
                        Err(error) => unusable(
                            AGENT_BUNDLE_RETAINED_IMAGES_ENV,
                            format!("{item:?}: {error}"),
                            &mut notes,
                        )?,
                        Ok(ImageReference { digest: None, .. }) => notes.push(BaselineNote {
                            code: "baseline_bundle_unpinned",
                            variable: AGENT_BUNDLE_RETAINED_IMAGES_ENV,
                            message: format!(
                                "{item:?} has no digest; projects cannot pin it until it is pinned"
                            ),
                        }),
                        Ok(ImageReference {
                            registry,
                            repository,
                            digest: Some(digest),
                            tag,
                        }) => {
                            let listed = policy.offered().any(|listed| listed.digest == digest);
                            if listed {
                                unusable(
                                    AGENT_BUNDLE_RETAINED_IMAGES_ENV,
                                    format!("{item:?} is already listed"),
                                    &mut notes,
                                )?;
                                continue;
                            }
                            policy.retained.push(OfferedBundle {
                                registry,
                                repository,
                                digest,
                                release_tag: tag
                                    .unwrap_or_else(|| UNTAGGED_BUNDLE_RELEASE.into()),
                            });
                        }
                    }
                }
            }
        }
    }

    let mut baseline = EnvironmentBaseline::disabled();
    baseline.sandbox_pool = SandboxPoolSwitch {
        enabled: pool_enabled,
    };
    baseline.bundle = bundle;

    if let (Some(image), Some(size_class)) = (image, size_class) {
        if image.digest.is_none() {
            notes.push(BaselineNote {
                code: "baseline_image_unpinned",
                variable: RUNNER_IMAGE_ENV,
                message: format!(
                    "{runner_image:?} has no digest; the {LEGACY_ENTRY_ID} entry is listed but not admitted until it is pinned"
                ),
            });
        }
        baseline.registry_allowlist = vec![RegistryRule {
            registry: image.registry.clone(),
            repository_prefix: image.repository.clone(),
            insecure: false,
        }];
        baseline.entries = vec![CatalogEntry {
            id: LEGACY_ENTRY_ID.into(),
            scope: CatalogScope::Baseline,
            label: "Deployment runner image".into(),
            description: None,
            image: CatalogImage {
                registry: image.registry,
                repository: image.repository,
                digest: image.digest,
                tag: image.tag,
            },
            isolation_floor: IsolationTier::Container,
            size_class_ids: vec![LEGACY_SIZE_CLASS_ID.into()],
            image_user: None,
            source: CatalogEntrySource::Legacy,
            provenance: None,
            revoked_at: None,
            created_at: 0,
            updated_at: 0,
        }];
        baseline.default_entry_id = Some(LEGACY_ENTRY_ID.into());
        baseline.size_classes = vec![size_class];
    }

    baseline.validate()?;
    Ok(LoadedBaseline {
        baseline,
        origin: BaselineOrigin::LegacyEnv,
        notes,
    })
}

/// With the pool off a legacy value the mapping cannot use is a note; with it
/// on, an error.
fn unusable_legacy_value(
    pool_enabled: bool,
    variable: &'static str,
    message: String,
    notes: &mut Vec<BaselineNote>,
) -> Result<(), BaselineError> {
    if pool_enabled {
        return Err(BaselineError::EnvInvalid { variable, message });
    }
    notes.push(BaselineNote {
        code: "baseline_env_unusable",
        variable,
        message,
    });
    Ok(())
}

fn parse_switch(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// `COGNIA_RUNNER_CPUS` is fractional CPUs (`1.5`); a size class counts
/// millicores. Rounds to the nearest millicore; refuses zero, negatives,
/// non-finite values and more than 1024 CPUs.
fn parse_cpu_millis(raw: &str) -> Option<u32> {
    let cpus: f64 = raw.trim().parse().ok()?;
    if !cpus.is_finite() || cpus <= 0.0 || cpus > 1024.0 {
        return None;
    }
    let millis = (cpus * 1000.0).round() as u32;
    (millis > 0).then_some(millis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::tests::{BUNDLE_DIGEST, IMAGE_DIGEST};

    fn inputs() -> BaselineInputs {
        BaselineInputs::default()
    }

    fn pinned_runner() -> String {
        format!("ghcr.io/maxqian888/cognia-runner:v1.2.0@{IMAGE_DIGEST}")
    }

    #[test]
    fn nothing_configured_is_the_disabled_baseline() {
        let loaded = load_baseline_from(&inputs()).unwrap();
        assert_eq!(loaded.origin, BaselineOrigin::Disabled);
        assert_eq!(loaded.baseline, EnvironmentBaseline::disabled());
        assert!(!loaded.baseline.sandbox_pool.enabled);
        assert!(loaded.notes.is_empty());
    }

    #[test]
    fn blank_variables_count_as_unset() {
        let captured = BaselineInputs::from_lookup(|name| match name {
            RUNNER_IMAGE_ENV => Some("   ".into()),
            SANDBOX_POOL_ENABLED_ENV => Some(String::new()),
            _ => None,
        });
        assert_eq!(captured, BaselineInputs::default());
    }

    #[test]
    fn from_lookup_reads_every_variable() {
        let captured = BaselineInputs::from_lookup(|name| Some(format!("value-of-{name}")));
        assert_eq!(
            captured.baseline_file,
            Some(PathBuf::from(format!("value-of-{BASELINE_FILE_ENV}")))
        );
        assert_eq!(
            captured.agent_bundle_image.as_deref(),
            Some("value-of-COGNIA_AGENT_BUNDLE_IMAGE")
        );
        assert_eq!(
            captured.agent_bundle_retained_images.as_deref(),
            Some("value-of-COGNIA_AGENT_BUNDLE_RETAINED_IMAGES")
        );
        assert_eq!(
            captured.runner_cpus.as_deref(),
            Some("value-of-COGNIA_RUNNER_CPUS")
        );
        assert_eq!(
            captured.runner_memory_mb.as_deref(),
            Some("value-of-COGNIA_RUNNER_MEMORY_MB")
        );
    }

    #[test]
    fn legacy_runner_image_becomes_the_default_entry_with_the_pool_off() {
        let loaded = load_baseline_from(&BaselineInputs {
            runner_image: Some(pinned_runner()),
            runner_cpus: Some("1.5".into()),
            runner_memory_mb: Some("1024".into()),
            agent_bundle_image: Some(format!(
                "ghcr.io/maxqian888/cognia-agent-bundle:v1.2.0@{BUNDLE_DIGEST}"
            )),
            ..inputs()
        })
        .unwrap();

        assert_eq!(loaded.origin, BaselineOrigin::LegacyEnv);
        assert!(loaded.notes.is_empty(), "{:?}", loaded.notes);
        let baseline = &loaded.baseline;
        assert!(
            !baseline.sandbox_pool.enabled,
            "the pool is off unless switched on"
        );
        assert!(!baseline.multi_tenant);
        assert_eq!(baseline.isolation_floor, IsolationTier::Container);
        assert_eq!(baseline.default_entry_id.as_deref(), Some(LEGACY_ENTRY_ID));

        let entry = &baseline.entries[0];
        assert_eq!(entry.source, CatalogEntrySource::Legacy);
        assert_eq!(entry.image.registry, "ghcr.io");
        assert_eq!(entry.image.repository, "maxqian888/cognia-runner");
        assert_eq!(entry.image.digest.as_deref(), Some(IMAGE_DIGEST));
        assert_eq!(entry.image.tag.as_deref(), Some("v1.2.0"));

        let class = baseline.size_class(LEGACY_SIZE_CLASS_ID).unwrap();
        assert_eq!((class.cpu_millis, class.memory_mib), (1_500, 1_024));
        assert!(class.gpu.is_none());

        assert_eq!(
            baseline.registry_allowlist,
            vec![RegistryRule {
                registry: "ghcr.io".into(),
                repository_prefix: "maxqian888/cognia-runner".into(),
                insecure: false,
            }]
        );
        let bundle = baseline.bundle.as_ref().unwrap();
        assert_eq!(bundle.current.digest, BUNDLE_DIGEST);
        assert_eq!(bundle.current.release_tag, "v1.2.0");
        // Where the driver pulls it from rides along; the spec records only
        // the digest and release tag.
        assert_eq!(
            bundle.current.image().canonical(),
            format!("ghcr.io/maxqian888/cognia-agent-bundle@{BUNDLE_DIGEST}")
        );
        baseline.validate().unwrap();
    }

    #[test]
    fn legacy_defaults_match_the_container_backend() {
        let loaded = load_baseline_from(&BaselineInputs {
            runner_image: Some(pinned_runner()),
            ..inputs()
        })
        .unwrap();
        let class = loaded.baseline.size_class(LEGACY_SIZE_CLASS_ID).unwrap();
        assert_eq!((class.cpu_millis, class.memory_mib), (2_000, 2_048));
    }

    #[test]
    fn docker_hub_shorthand_normalises_for_the_allowlist() {
        let loaded = load_baseline_from(&BaselineInputs {
            runner_image: Some("node:22-slim".into()),
            ..inputs()
        })
        .unwrap();
        let entry = &loaded.baseline.entries[0];
        assert_eq!(entry.image.registry, "docker.io");
        assert_eq!(entry.image.repository, "library/node");
        assert!(loaded.baseline.registry_permits(&entry.image));
    }

    #[test]
    fn a_tag_only_runner_image_is_listed_with_a_note_in_both_modes() {
        for pool in ["false", "true"] {
            let loaded = load_baseline_from(&BaselineInputs {
                runner_image: Some("ghcr.io/maxqian888/cognia-runner:latest".into()),
                sandbox_pool_enabled: Some(pool.into()),
                ..inputs()
            })
            .unwrap();
            let entry = &loaded.baseline.entries[0];
            assert!(entry.image.digest.is_none());
            assert!(entry.image.pinned().is_none());
            assert_eq!(
                loaded
                    .notes
                    .iter()
                    .map(|note| note.code)
                    .collect::<Vec<_>>(),
                vec!["baseline_image_unpinned"],
                "pool={pool}"
            );
        }
    }

    #[test]
    fn a_tag_only_bundle_is_a_note_not_an_error() {
        let loaded = load_baseline_from(&BaselineInputs {
            runner_image: Some(pinned_runner()),
            agent_bundle_image: Some("ghcr.io/maxqian888/cognia-agent-bundle:latest".into()),
            sandbox_pool_enabled: Some("on".into()),
            ..inputs()
        })
        .unwrap();
        assert!(loaded.baseline.bundle.is_none());
        assert_eq!(loaded.notes[0].code, "baseline_bundle_unpinned");
    }

    #[test]
    fn a_digest_only_bundle_records_an_untagged_release() {
        let loaded = load_baseline_from(&BaselineInputs {
            runner_image: Some(pinned_runner()),
            agent_bundle_image: Some(format!(
                "ghcr.io/maxqian888/cognia-agent-bundle@{BUNDLE_DIGEST}"
            )),
            ..inputs()
        })
        .unwrap();
        assert_eq!(
            loaded.baseline.bundle.unwrap().current.release_tag,
            UNTAGGED_BUNDLE_RELEASE
        );
    }

    const RETAINED_V1: &str =
        "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const RETAINED_V0: &str =
        "sha256:4444444444444444444444444444444444444444444444444444444444444444";

    fn bundle_ref(tag: &str, digest: &str) -> String {
        format!("ghcr.io/maxqian888/cognia-agent-bundle{tag}@{digest}")
    }

    fn with_retained(retained: &str, pool: &str) -> BaselineInputs {
        BaselineInputs {
            runner_image: Some(pinned_runner()),
            agent_bundle_image: Some(bundle_ref(":v1.2.0", BUNDLE_DIGEST)),
            agent_bundle_retained_images: Some(retained.into()),
            sandbox_pool_enabled: Some(pool.into()),
            ..inputs()
        }
    }

    #[test]
    fn retained_bundles_stay_pinnable_in_release_order() {
        let retained = format!(
            "{}, {},",
            bundle_ref(":v1.1.0", RETAINED_V1),
            bundle_ref("", RETAINED_V0)
        );
        let loaded = load_baseline_from(&with_retained(&retained, "on")).unwrap();
        assert!(loaded.notes.is_empty(), "{:?}", loaded.notes);
        let bundle = loaded.baseline.bundle.unwrap();
        assert_eq!(bundle.current.digest, BUNDLE_DIGEST);
        assert_eq!(
            bundle
                .retained
                .iter()
                .map(|retained| (retained.digest.as_str(), retained.release_tag.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (RETAINED_V1, "v1.1.0"),
                (RETAINED_V0, UNTAGGED_BUNDLE_RELEASE)
            ]
        );
        assert!(bundle
            .retained
            .iter()
            .all(|retained| retained.repository == "maxqian888/cognia-agent-bundle"));
    }

    #[test]
    fn retained_bundles_without_a_current_bundle_are_ignored_with_a_note() {
        for current in [None, Some("ghcr.io/maxqian888/cognia-agent-bundle:latest")] {
            let loaded = load_baseline_from(&BaselineInputs {
                agent_bundle_image: current.map(str::to_owned),
                ..with_retained(&bundle_ref(":v1.1.0", RETAINED_V1), "on")
            })
            .unwrap();
            assert!(loaded.baseline.bundle.is_none());
            assert!(
                loaded
                    .notes
                    .iter()
                    .any(|note| note.code == "baseline_bundle_retained_ignored"),
                "{current:?}: {:?}",
                loaded.notes
            );
        }
    }

    #[test]
    fn a_tag_only_retained_bundle_is_a_note_in_both_modes() {
        for pool in ["off", "on"] {
            let loaded = load_baseline_from(&with_retained(
                "ghcr.io/maxqian888/cognia-agent-bundle:v1.1.0",
                pool,
            ))
            .unwrap();
            assert!(loaded.baseline.bundle.unwrap().retained.is_empty());
            assert_eq!(loaded.notes[0].code, "baseline_bundle_unpinned");
            assert_eq!(loaded.notes[0].variable, AGENT_BUNDLE_RETAINED_IMAGES_ENV);
        }
    }

    #[test]
    fn a_malformed_or_repeated_retained_bundle_is_a_note_off_and_an_error_on() {
        for retained in [
            "@@@".to_string(),
            bundle_ref(":v1.2.0-again", BUNDLE_DIGEST),
            format!(
                "{},{}",
                bundle_ref(":v1.1.0", RETAINED_V1),
                bundle_ref("", RETAINED_V1)
            ),
        ] {
            let loaded = load_baseline_from(&with_retained(&retained, "off")).unwrap();
            assert_eq!(loaded.notes.len(), 1, "{retained}: {:?}", loaded.notes);
            assert_eq!(loaded.notes[0].code, "baseline_env_unusable");
            loaded.baseline.validate().unwrap();

            match load_baseline_from(&with_retained(&retained, "on")) {
                Err(BaselineError::EnvInvalid { variable, .. }) => {
                    assert_eq!(variable, AGENT_BUNDLE_RETAINED_IMAGES_ENV)
                }
                other => panic!("{retained}: expected EnvInvalid, got {other:?}"),
            }
        }
    }

    #[test]
    fn malformed_legacy_values_never_block_boot_with_the_pool_off() {
        let loaded = load_baseline_from(&BaselineInputs {
            runner_image: Some("Not An Image!".into()),
            runner_cpus: Some("lots".into()),
            runner_memory_mb: Some("-1".into()),
            agent_bundle_image: Some("@@@".into()),
            ..inputs()
        })
        .unwrap();
        assert!(!loaded.baseline.sandbox_pool.enabled);
        assert!(loaded.baseline.entries.is_empty());
        assert!(loaded.baseline.size_classes.is_empty());
        assert!(loaded.baseline.default_entry_id.is_none());
        let variables: Vec<_> = loaded.notes.iter().map(|note| note.variable).collect();
        assert_eq!(
            variables,
            vec![
                RUNNER_CPUS_ENV,
                RUNNER_MEMORY_MB_ENV,
                RUNNER_IMAGE_ENV,
                AGENT_BUNDLE_IMAGE_ENV
            ]
        );
        assert!(loaded
            .notes
            .iter()
            .all(|note| note.code == "baseline_env_unusable"));
    }

    #[test]
    fn a_malformed_image_alone_keeps_the_size_class_out_too() {
        let loaded = load_baseline_from(&BaselineInputs {
            runner_image: Some("UPPER/case".into()),
            ..inputs()
        })
        .unwrap();
        assert!(loaded.baseline.entries.is_empty());
        assert!(loaded.baseline.size_classes.is_empty());
        assert!(loaded.baseline.registry_allowlist.is_empty());
    }

    #[test]
    fn malformed_legacy_values_refuse_boot_once_the_pool_is_on() {
        let cases: [(BaselineInputs, &str); 4] = [
            (
                BaselineInputs {
                    runner_image: Some("Not An Image!".into()),
                    ..inputs()
                },
                RUNNER_IMAGE_ENV,
            ),
            (
                BaselineInputs {
                    runner_image: Some(pinned_runner()),
                    runner_cpus: Some("0".into()),
                    ..inputs()
                },
                RUNNER_CPUS_ENV,
            ),
            (
                BaselineInputs {
                    runner_image: Some(pinned_runner()),
                    runner_memory_mb: Some("0".into()),
                    ..inputs()
                },
                RUNNER_MEMORY_MB_ENV,
            ),
            (
                BaselineInputs {
                    runner_image: Some(pinned_runner()),
                    agent_bundle_image: Some("@@@".into()),
                    ..inputs()
                },
                AGENT_BUNDLE_IMAGE_ENV,
            ),
        ];
        for (mut case, expected) in cases {
            case.sandbox_pool_enabled = Some("true".into());
            match load_baseline_from(&case) {
                Err(error @ BaselineError::EnvInvalid { variable, .. }) => {
                    assert_eq!(variable, expected);
                    assert_eq!(error.code(), "baseline_env_invalid");
                }
                other => panic!("{expected}: expected EnvInvalid, got {other:?}"),
            }
        }
    }

    #[test]
    fn the_pool_switch_accepts_the_usual_spellings_and_refuses_the_rest() {
        for (raw, enabled) in [
            ("1", true),
            ("TRUE", true),
            (" yes ", true),
            ("on", true),
            ("0", false),
            ("False", false),
            ("no", false),
            ("OFF", false),
        ] {
            let loaded = load_baseline_from(&BaselineInputs {
                runner_image: Some(pinned_runner()),
                sandbox_pool_enabled: Some(raw.into()),
                ..inputs()
            })
            .unwrap();
            assert_eq!(loaded.baseline.sandbox_pool.enabled, enabled, "{raw:?}");
        }
        let error = load_baseline_from(&BaselineInputs {
            runner_image: Some(pinned_runner()),
            sandbox_pool_enabled: Some("enabled".into()),
            ..inputs()
        })
        .unwrap_err();
        assert_eq!(error.code(), "baseline_env_invalid");
    }

    #[test]
    fn a_switched_on_pool_without_a_catalog_refuses_boot() {
        let error = load_baseline_from(&BaselineInputs {
            sandbox_pool_enabled: Some("true".into()),
            ..inputs()
        })
        .unwrap_err();
        assert!(matches!(error, BaselineError::PoolWithoutCatalog));
        assert_eq!(error.code(), "baseline_pool_without_catalog");

        // Switched off explicitly with nothing else: the disabled baseline.
        let loaded = load_baseline_from(&BaselineInputs {
            sandbox_pool_enabled: Some("false".into()),
            ..inputs()
        })
        .unwrap();
        assert_eq!(loaded.origin, BaselineOrigin::Disabled);
    }

    #[test]
    fn cpu_counts_round_to_millicores() {
        assert_eq!(parse_cpu_millis("2"), Some(2_000));
        assert_eq!(parse_cpu_millis("0.25"), Some(250));
        assert_eq!(parse_cpu_millis("0.0004"), None, "rounds to zero");
        assert_eq!(parse_cpu_millis("-1"), None);
        assert_eq!(parse_cpu_millis("NaN"), None);
        assert_eq!(parse_cpu_millis("inf"), None);
        assert_eq!(parse_cpu_millis("2048"), None);
    }

    fn baseline_document() -> serde_json::Value {
        let mut baseline = crate::catalog::tests::baseline();
        baseline.sandbox_pool.enabled = true;
        serde_json::to_value(baseline).unwrap()
    }

    #[test]
    fn a_baseline_file_wins_over_the_environment() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("environment-baseline.json");
        std::fs::write(&path, serde_json::to_vec(&baseline_document()).unwrap()).unwrap();

        let loaded = load_baseline_from(&BaselineInputs {
            baseline_file: Some(path.clone()),
            sandbox_pool_enabled: Some("false".into()),
            runner_image: Some(pinned_runner()),
            ..inputs()
        })
        .unwrap();
        assert_eq!(loaded.origin, BaselineOrigin::File(path));
        assert_eq!(loaded.origin.as_str(), "file");
        assert!(
            loaded.baseline.sandbox_pool.enabled,
            "the file's switch wins"
        );
        assert!(loaded
            .baseline
            .entries
            .iter()
            .all(|entry| entry.id != LEGACY_ENTRY_ID));
        assert_eq!(
            loaded
                .notes
                .iter()
                .map(|note| note.code)
                .collect::<Vec<_>>(),
            vec!["baseline_env_ignored"]
        );
    }

    #[test]
    fn a_missing_baseline_file_refuses_boot() {
        let dir = tempfile::tempdir().unwrap();
        let error = load_baseline_from(&BaselineInputs {
            baseline_file: Some(dir.path().join("absent.json")),
            ..inputs()
        })
        .unwrap_err();
        assert_eq!(error.code(), "baseline_file_unreadable");
    }

    #[test]
    fn an_oversized_baseline_file_refuses_boot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.json");
        std::fs::write(&path, vec![b' '; (MAX_BASELINE_FILE_BYTES + 1) as usize]).unwrap();
        let error = read_baseline_file(&path).unwrap_err();
        assert_eq!(error.code(), "baseline_file_too_large");
    }

    #[test]
    fn a_malformed_baseline_file_names_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.json");
        std::fs::write(&path, b"{\"version\": 1,").unwrap();
        match read_baseline_file(&path).unwrap_err() {
            BaselineError::FileMalformed { path: named, .. } => assert_eq!(named, path),
            other => panic!("expected FileMalformed, got {other:?}"),
        }
    }

    #[test]
    fn unknown_baseline_fields_are_refused() {
        let mut document = baseline_document();
        document["autoscaler"] = serde_json::json!({ "enabled": true });
        let error = parse_baseline(&serde_json::to_vec(&document).unwrap()).unwrap_err();
        assert_eq!(error.code(), "baseline_file_malformed");
    }

    #[test]
    fn a_baseline_that_does_not_validate_carries_the_catalog_code() {
        let mut document = baseline_document();
        document["multiTenant"] = serde_json::json!(true);
        document["isolationFloor"] = serde_json::json!("container");
        let error = parse_baseline(&serde_json::to_vec(&document).unwrap()).unwrap_err();
        assert_eq!(error.code(), "baseline_floor_too_low");
    }

    #[test]
    fn a_disabled_baseline_round_trips_through_the_file_format() {
        let bytes = serde_json::to_vec(&EnvironmentBaseline::disabled()).unwrap();
        assert_eq!(
            parse_baseline(&bytes).unwrap(),
            EnvironmentBaseline::disabled()
        );
    }
}
