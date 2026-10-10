//! The desktop's remote sandboxes (ADR-0221 D10).
//!
//! A desktop has no Ops Controller to hand it a baseline, so its "Remote
//! sandboxes" settings section writes one document — the providers file plus
//! the registries its projects may use — and the desktop synthesizes the
//! baseline the shared admission runs against from it. The agent bundle comes
//! from the release: a release build compiles in `COGNIA_AGENT_BUNDLE_IMAGE`
//! (digest-pinned), and the same variable overrides it at run time.
//!
//! # Intentionally inert without a pinned bundle
//!
//! A build that carries no pinned bundle (a development build, a release that
//! was not given one) cannot inject the agent into any image. Remote
//! sandboxes are then off whatever the settings say: [`DesktopAvailability::BundleUnpinned`]
//! documents it here, the settings section labels it `bundle_unpinned`, and
//! `an_unpinned_build_keeps_remote_sandboxes_off` pins it.

use std::path::Path;

use cognia_environment::catalog::{
    BundlePolicy, EgressPreset, EnvironmentBaseline, OfferedBundle, RegistryRule,
    SandboxPoolSwitch, SizeClass,
};
use cognia_environment::image::ImageReference;
use cognia_environment::spec::IsolationTier;
use serde::{Deserialize, Serialize};

use crate::providers::{ProvidersError, SandboxProvidersFile};

/// The settings document, beside the other Rust-owned files in app data.
pub const SETTINGS_FILE: &str = "remote-sandboxes.json";
/// The baseline synthesized from it, which the boot seam loads.
pub const BASELINE_FILE: &str = "remote-sandboxes-baseline.json";
/// The bundle this build was released with, when it was given one.
pub const COMPILED_BUNDLE_IMAGE: Option<&str> = option_env!("COGNIA_AGENT_BUNDLE_IMAGE");
/// The run-time override of [`COMPILED_BUNDLE_IMAGE`].
pub const BUNDLE_IMAGE_ENV: &str = "COGNIA_AGENT_BUNDLE_IMAGE";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopRemoteSandboxes {
    /// Always `1`.
    pub version: u8,
    pub providers: SandboxProvidersFile,
    /// Registries (and repository prefixes) project images may come from.
    #[serde(default)]
    pub registry_allowlist: Vec<RegistryRule>,
}

/// Whether remote sandboxes can run on this desktop, and why not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DesktopAvailability {
    /// At least one provider and a pinned bundle: the pool is installed.
    Active,
    /// No provider is configured.
    NoProviders,
    /// This build carries no pinned agent bundle (see the module docs).
    BundleUnpinned,
}

impl DesktopRemoteSandboxes {
    pub fn empty() -> Self {
        Self {
            version: 1,
            providers: SandboxProvidersFile::empty(),
            registry_allowlist: Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<(), ProvidersError> {
        if self.version != 1 {
            return Err(ProvidersError {
                code: "remote_sandboxes_version_unsupported",
                message: format!("version {} is not 1", self.version),
            });
        }
        self.providers.validate()?;
        for provider in &self.providers.providers {
            crate::providers::validate_provider_settings(provider)?;
        }
        // The registry rules are validated as part of the synthesized
        // baseline; checking them here gives the settings UI the same answer
        // before anything is written.
        let probe = synthesize_baseline(self, Some(placeholder_bundle()));
        probe.validate().map_err(|error| ProvidersError {
            code: "remote_sandboxes_registry_invalid",
            message: error.to_string(),
        })
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, ProvidersError> {
        let parsed: Self = serde_json::from_slice(bytes).map_err(|error| ProvidersError {
            code: "remote_sandboxes_invalid",
            message: format!("line {}, column {}", error.line(), error.column()),
        })?;
        parsed.validate()?;
        Ok(parsed)
    }

    /// The settings in `dir`, or empty settings when none were saved.
    pub fn load(dir: &Path) -> Result<Self, ProvidersError> {
        let path = dir.join(SETTINGS_FILE);
        match std::fs::read(&path) {
            Ok(bytes) => Self::parse(&bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::empty()),
            Err(error) => Err(ProvidersError {
                code: "remote_sandboxes_unreadable",
                message: format!("{}: {error}", path.display()),
            }),
        }
    }

    /// Validate and write atomically (temp file + rename).
    pub fn save(&self, dir: &Path) -> Result<(), ProvidersError> {
        self.validate()?;
        let unwritable = |error: std::io::Error| ProvidersError {
            code: "remote_sandboxes_unwritable",
            message: error.to_string(),
        };
        std::fs::create_dir_all(dir).map_err(unwritable)?;
        let bytes = serde_json::to_vec_pretty(self).expect("settings serialize");
        let temporary = dir.join(format!("{SETTINGS_FILE}.tmp"));
        std::fs::write(&temporary, bytes).map_err(unwritable)?;
        std::fs::rename(&temporary, dir.join(SETTINGS_FILE)).map_err(unwritable)
    }

    pub fn availability(&self, bundle: Option<&OfferedBundle>) -> DesktopAvailability {
        if bundle.is_none() {
            DesktopAvailability::BundleUnpinned
        } else if self.providers.providers.is_empty() {
            DesktopAvailability::NoProviders
        } else {
            DesktopAvailability::Active
        }
    }
}

/// The bundle this desktop injects: the run-time override when set, else the
/// compiled-in release bundle. Only a digest-pinned reference counts.
pub fn pinned_bundle(runtime_override: Option<&str>) -> Option<OfferedBundle> {
    let raw = runtime_override
        .filter(|value| !value.trim().is_empty())
        .or(COMPILED_BUNDLE_IMAGE)?;
    match ImageReference::parse(raw) {
        Ok(ImageReference {
            registry,
            repository,
            digest: Some(digest),
            tag,
        }) => Some(OfferedBundle {
            registry,
            repository,
            digest,
            release_tag: tag.unwrap_or_else(|| "untagged".into()),
        }),
        _ => None,
    }
}

/// A well-formed bundle for validating settings before a real one is known.
fn placeholder_bundle() -> OfferedBundle {
    OfferedBundle {
        registry: "ghcr.io".into(),
        repository: "cognia/agent-bundle".into(),
        digest: format!("sha256:{}", "0".repeat(64)),
        release_tag: "validation".into(),
    }
}

/// The size classes every desktop offers.
pub fn desktop_size_classes() -> Vec<SizeClass> {
    let class = |id: &str, label: &str, cpu_millis: u32, memory_mib: u32, storage: u32| SizeClass {
        id: id.to_string(),
        label: label.to_string(),
        cpu_millis,
        memory_mib,
        ephemeral_storage_mib: storage,
        volume_mib: storage * 2,
        gpu: None,
    };
    vec![
        class("small", "Small", 1_000, 2_048, 10_240),
        class("medium", "Medium", 2_000, 4_096, 20_480),
        class("large", "Large", 4_000, 8_192, 40_960),
    ]
}

/// The egress presets every desktop offers to an `allowlist` sandbox.
pub fn desktop_egress_presets() -> Vec<EgressPreset> {
    let preset = |id: &str, label: &str, domains: &[&str]| EgressPreset {
        id: id.to_string(),
        label: label.to_string(),
        domains: domains.iter().map(|domain| domain.to_string()).collect(),
    };
    vec![
        preset(
            "package-registries",
            "Package registries",
            &[
                "registry.npmjs.org",
                "registry.yarnpkg.com",
                "pypi.org",
                "files.pythonhosted.org",
                "crates.io",
                "static.crates.io",
                "index.crates.io",
                "proxy.golang.org",
                "sum.golang.org",
                "rubygems.org",
                "repo.maven.apache.org",
            ],
        ),
        preset(
            "github",
            "GitHub",
            &[
                "github.com",
                "api.github.com",
                "codeload.github.com",
                "*.githubusercontent.com",
            ],
        ),
    ]
}

/// The baseline a desktop admits against. The pool is on only when there is
/// a provider and a pinned bundle; single-tenant, container floor (a provider
/// attests what it can), no baseline entries — projects bring their own
/// images through the tenant catalog and approved declarations.
pub fn synthesize_baseline(
    settings: &DesktopRemoteSandboxes,
    bundle: Option<OfferedBundle>,
) -> EnvironmentBaseline {
    let enabled = bundle.is_some() && !settings.providers.providers.is_empty();
    EnvironmentBaseline {
        version: 1,
        revision: 0,
        sandbox_pool: SandboxPoolSwitch { enabled },
        multi_tenant: false,
        registry_allowlist: settings.registry_allowlist.clone(),
        isolation_floor: IsolationTier::Container,
        entries: Vec::new(),
        default_entry_id: None,
        size_classes: desktop_size_classes(),
        egress_presets: desktop_egress_presets(),
        internal_exceptions: Vec::new(),
        bundle: bundle.map(|current| BundlePolicy {
            current,
            retained: Vec::new(),
        }),
    }
}

/// Write the synthesized baseline for the boot seam to load; returns its path.
pub fn write_baseline(
    dir: &Path,
    settings: &DesktopRemoteSandboxes,
    bundle: Option<OfferedBundle>,
) -> Result<std::path::PathBuf, ProvidersError> {
    let unwritable = |error: std::io::Error| ProvidersError {
        code: "remote_sandboxes_unwritable",
        message: error.to_string(),
    };
    std::fs::create_dir_all(dir).map_err(unwritable)?;
    let baseline = synthesize_baseline(settings, bundle);
    let path = dir.join(BASELINE_FILE);
    let temporary = dir.join(format!("{BASELINE_FILE}.tmp"));
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(&baseline).expect("a baseline serializes"),
    )
    .map_err(unwritable)?;
    std::fs::rename(&temporary, &path).map_err(unwritable)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{CredentialSource, ProviderConfig, ProviderKind, ProviderLimitsConfig};
    use cognia_environment::baseline::{load_baseline_from, BaselineInputs};

    fn bundle() -> OfferedBundle {
        OfferedBundle {
            registry: "ghcr.io".into(),
            repository: "cognia/agent-bundle".into(),
            digest: format!("sha256:{}", "a".repeat(64)),
            release_tag: "v2.0.0".into(),
        }
    }

    fn settings_with_provider() -> DesktopRemoteSandboxes {
        DesktopRemoteSandboxes {
            version: 1,
            providers: SandboxProvidersFile {
                version: 1,
                providers: vec![ProviderConfig {
                    id: "e2b".into(),
                    kind: ProviderKind::E2b,
                    label: None,
                    credential: Some(CredentialSource::SecretId("remote-sandbox:e2b".into())),
                    limits: ProviderLimitsConfig::default(),
                    settings: serde_json::json!({}),
                }],
                default_provider_id: Some("e2b".into()),
            },
            registry_allowlist: vec![RegistryRule {
                registry: "ghcr.io".into(),
                repository_prefix: "acme/".into(),
                insecure: false,
            }],
        }
    }

    #[test]
    fn an_unpinned_build_keeps_remote_sandboxes_off() {
        let settings = settings_with_provider();
        assert_eq!(settings.availability(None), DesktopAvailability::BundleUnpinned);
        let baseline = synthesize_baseline(&settings, None);
        assert!(!baseline.sandbox_pool.enabled);
        assert!(baseline.bundle.is_none());
    }

    #[test]
    fn a_provider_and_a_pinned_bundle_turn_the_pool_on() {
        let settings = settings_with_provider();
        assert_eq!(settings.availability(Some(&bundle())), DesktopAvailability::Active);
        assert_eq!(
            DesktopRemoteSandboxes::empty().availability(Some(&bundle())),
            DesktopAvailability::NoProviders
        );
        let baseline = synthesize_baseline(&settings, Some(bundle()));
        assert!(baseline.sandbox_pool.enabled);
        assert!(!baseline.multi_tenant);
        assert_eq!(baseline.registry_allowlist, settings.registry_allowlist);
        assert_eq!(baseline.size_classes.len(), 3);
        baseline.validate().unwrap();
    }

    #[test]
    fn the_written_baseline_is_what_the_boot_seam_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_baseline(dir.path(), &settings_with_provider(), Some(bundle())).unwrap();
        let loaded = load_baseline_from(&BaselineInputs {
            baseline_file: Some(path),
            ..BaselineInputs::default()
        })
        .unwrap();
        assert!(loaded.baseline.sandbox_pool.enabled);
        assert_eq!(loaded.baseline.bundle.unwrap().current.digest, bundle().digest);
    }

    #[test]
    fn settings_round_trip_and_refuse_what_the_baseline_would() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            DesktopRemoteSandboxes::load(dir.path()).unwrap(),
            DesktopRemoteSandboxes::empty()
        );
        let settings = settings_with_provider();
        settings.save(dir.path()).unwrap();
        assert_eq!(DesktopRemoteSandboxes::load(dir.path()).unwrap(), settings);

        let mut bad = settings.clone();
        bad.registry_allowlist[0].registry = "not a host/".into();
        assert_eq!(
            bad.save(dir.path()).unwrap_err().code,
            "remote_sandboxes_registry_invalid"
        );
        // A refused save leaves the previous settings in place.
        assert_eq!(DesktopRemoteSandboxes::load(dir.path()).unwrap(), settings);

        let mut duplicate = settings;
        duplicate.providers.providers.push(duplicate.providers.providers[0].clone());
        assert_eq!(duplicate.validate().unwrap_err().code, "provider_id_duplicate");
    }

    #[test]
    fn only_a_digest_pinned_bundle_reference_counts() {
        let pinned = format!("ghcr.io/cognia/agent-bundle:v2.0.0@sha256:{}", "b".repeat(64));
        let parsed = pinned_bundle(Some(&pinned)).unwrap();
        assert_eq!(parsed.release_tag, "v2.0.0");
        assert_eq!(parsed.digest, format!("sha256:{}", "b".repeat(64)));
        if COMPILED_BUNDLE_IMAGE.is_none() {
            assert!(pinned_bundle(Some("ghcr.io/cognia/agent-bundle:v2.0.0")).is_none());
            assert!(pinned_bundle(None).is_none());
            assert!(pinned_bundle(Some("   ")).is_none());
        }
    }
}
