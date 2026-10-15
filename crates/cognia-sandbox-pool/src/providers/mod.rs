//! Remote sandbox providers as members of the provider set (ADR-0221).
//!
//! - [`config`] — the providers file both dispatch sources share.
//! - [`set`] — the one sandbox arm the router holds, routing to members.
//!
//! [`remote_member`] turns one configured provider into a member: a provider
//! client (behind its cargo feature) wrapped in the shared sandbox driver.

pub mod config;
pub mod set;

use std::path::Path;
use std::sync::Arc;

pub use config::{
    CredentialSource, ProviderConfig, ProviderKind, ProviderLimitsConfig, ProvidersError,
    SandboxProvidersFile, PROVIDERS_FILE_ENV,
};
pub use set::{ProviderMember, ProviderSet, ProviderView};

use crate::admission::SandboxAdmission;
use crate::docker::{DockerSandboxBackend, DockerSandboxConfig};
use crate::remote::RemoteProvider;

/// How a Host reads provider credentials: its environment, and (on the
/// desktop) its encrypted secret store.
pub struct CredentialLookups<'a> {
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub secrets: &'a dyn Fn(&str) -> Option<String>,
}

/// One configured provider as a member of the set. Performs no network I/O:
/// every provider client connects on first use, so a provider that is down at
/// boot is a status the console shows, not a Host that cannot start. A
/// workspace it cannot push is kept under `data_dir` (ADR-0221).
pub fn remote_member(
    provider: &ProviderConfig,
    admission: Arc<dyn SandboxAdmission>,
    driver_config: DockerSandboxConfig,
    lookups: &CredentialLookups<'_>,
    data_dir: &Path,
) -> Result<ProviderMember, String> {
    let credential = provider
        .credential
        .as_ref()
        .map(|source| source.resolve(lookups.env, lookups.secrets))
        .transpose()
        .map_err(|error| format!("provider {}: {error}", provider.id))?;
    let client = provider_client(provider, credential, &driver_config.deployment_id)
        .map_err(|error| format!("provider {}: {error}", provider.id))?;
    let limits = provider.limits.limits();
    let backend = DockerSandboxBackend::new_remote(
        provider.id.clone(),
        client,
        limits,
        admission,
        driver_config,
    );
    backend.configure_publish_recovery(data_dir);
    Ok(ProviderMember {
        id: provider.id.clone(),
        label: provider.label.clone(),
        exec: backend.clone(),
        status: backend.clone(),
        runtime: Some(backend),
        limits: Some(limits),
    })
}

/// Check a provider's own settings (the `settings` object the providers file
/// carries opaquely) without building a client, so a settings section can
/// refuse a typo before it is saved rather than at the next start. A kind
/// this binary was built without is not checked here: installing it refuses
/// by name.
pub fn validate_provider_settings(provider: &ProviderConfig) -> Result<(), ProvidersError> {
    let invalid = |message: String| ProvidersError {
        code: "provider_settings_invalid",
        message: format!("{}: {message}", provider.id),
    };
    match provider.kind {
        #[cfg(feature = "e2b")]
        ProviderKind::E2b => {
            let settings: crate::remote::e2b::E2bSettings =
                serde_json::from_value(provider.settings.clone())
                    .map_err(|error| invalid(error.to_string()))?;
            crate::remote::e2b::E2bProvider::validate(&settings).map_err(invalid)
        }
        #[cfg(feature = "kubernetes")]
        ProviderKind::Kubernetes => {
            let settings: crate::remote::kubernetes::KubernetesSettings =
                serde_json::from_value(provider.settings.clone())
                    .map_err(|error| invalid(error.to_string()))?;
            crate::remote::kubernetes::KubernetesProvider::validate(&settings).map_err(invalid)
        }
        #[allow(unreachable_patterns)]
        _ => Ok(()),
    }
}

fn provider_client(
    provider: &ProviderConfig,
    credential: Option<String>,
    deployment_id: &str,
) -> Result<Arc<dyn RemoteProvider>, String> {
    match provider.kind {
        ProviderKind::E2b => e2b_client(provider, credential, deployment_id),
        ProviderKind::Kubernetes => kubernetes_client(provider, credential, deployment_id),
    }
}

#[cfg(feature = "e2b")]
fn e2b_client(
    provider: &ProviderConfig,
    credential: Option<String>,
    deployment_id: &str,
) -> Result<Arc<dyn RemoteProvider>, String> {
    use crate::remote::e2b::{E2bProvider, E2bSettings};
    let settings: E2bSettings = serde_json::from_value(provider.settings.clone())
        .map_err(|error| format!("invalid e2b settings: {error}"))?;
    let api_key = credential.ok_or("an E2B provider needs an API key credential")?;
    let client: Arc<dyn RemoteProvider> = E2bProvider::new(settings, api_key, deployment_id)?;
    Ok(client)
}

#[cfg(not(feature = "e2b"))]
fn e2b_client(
    _provider: &ProviderConfig,
    _credential: Option<String>,
    _deployment_id: &str,
) -> Result<Arc<dyn RemoteProvider>, String> {
    Err("this binary was built without the `e2b` provider".into())
}

#[cfg(feature = "kubernetes")]
fn kubernetes_client(
    provider: &ProviderConfig,
    credential: Option<String>,
    deployment_id: &str,
) -> Result<Arc<dyn RemoteProvider>, String> {
    use crate::remote::kubernetes::{KubernetesProvider, KubernetesSettings};
    let settings: KubernetesSettings = serde_json::from_value(provider.settings.clone())
        .map_err(|error| format!("invalid kubernetes settings: {error}"))?;
    let client: Arc<dyn RemoteProvider> =
        KubernetesProvider::new(settings, credential, deployment_id)?;
    Ok(client)
}

#[cfg(not(feature = "kubernetes"))]
fn kubernetes_client(
    _provider: &ProviderConfig,
    _credential: Option<String>,
    _deployment_id: &str,
) -> Result<Arc<dyn RemoteProvider>, String> {
    Err("this binary was built without the `kubernetes` provider".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider(kind: ProviderKind, credential: Option<CredentialSource>) -> ProviderConfig {
        ProviderConfig {
            id: "remote".into(),
            kind,
            label: None,
            credential,
            limits: ProviderLimitsConfig::default(),
            settings: json!({}),
        }
    }

    #[test]
    fn a_missing_credential_names_the_provider() {
        let none = |_: &str| None;
        let lookups = CredentialLookups {
            env: &none,
            secrets: &none,
        };
        let error = match provider_client_with_credential(
            &provider(ProviderKind::E2b, Some(CredentialSource::Env("NOPE".into()))),
            &lookups,
        ) {
            Ok(_) => panic!("a missing credential is refused"),
            Err(error) => error,
        };
        assert!(error.contains("provider_credential_missing"), "{error}");
    }

    /// The credential half of [`remote_member`], without building a driver.
    fn provider_client_with_credential(
        provider: &ProviderConfig,
        lookups: &CredentialLookups<'_>,
    ) -> Result<Arc<dyn RemoteProvider>, String> {
        let credential = provider
            .credential
            .as_ref()
            .map(|source| source.resolve(lookups.env, lookups.secrets))
            .transpose()
            .map_err(|error| format!("provider {}: {error}", provider.id))?;
        provider_client(provider, credential, "dep1")
    }

    #[cfg(feature = "e2b")]
    #[test]
    fn e2b_settings_are_checked_before_they_are_saved() {
        let mut config = provider(ProviderKind::E2b, None);
        validate_provider_settings(&config).expect("the defaults are valid");
        config.settings = json!({ "apiUrl": "http://api.e2b.app" });
        assert_eq!(
            validate_provider_settings(&config).unwrap_err().code,
            "provider_settings_invalid"
        );
        config.settings = json!({ "unknown": true });
        assert_eq!(
            validate_provider_settings(&config).unwrap_err().code,
            "provider_settings_invalid"
        );
    }

    #[cfg(feature = "kubernetes")]
    #[test]
    fn kubernetes_settings_are_checked_before_they_are_saved() {
        let mut config = provider(ProviderKind::Kubernetes, None);
        config.settings = json!({ "connection": "inCluster", "namespace": "cognia-sandboxes" });
        validate_provider_settings(&config).expect("a namespace and a connection suffice");
        config.settings = json!({ "connection": "inCluster", "namespace": "Not A Label" });
        assert_eq!(
            validate_provider_settings(&config).unwrap_err().code,
            "provider_settings_invalid"
        );
    }

    #[cfg(not(feature = "e2b"))]
    #[test]
    fn settings_of_a_kind_this_binary_lacks_are_left_to_install() {
        let mut config = provider(ProviderKind::E2b, None);
        config.settings = json!({ "anything": 1 });
        validate_provider_settings(&config).expect("install refuses it by name instead");
    }

    #[cfg(not(feature = "e2b"))]
    #[test]
    fn a_kind_this_binary_was_built_without_is_refused_by_name() {
        let error = match provider_client(&provider(ProviderKind::E2b, None), None, "dep1") {
            Ok(_) => panic!("no e2b client in this build"),
            Err(error) => error,
        };
        assert!(error.contains("built without the `e2b` provider"), "{error}");
    }

    #[cfg(not(feature = "kubernetes"))]
    #[test]
    fn a_kubernetes_provider_needs_its_feature() {
        let error = match provider_client(&provider(ProviderKind::Kubernetes, None), None, "dep1") {
            Ok(_) => panic!("no kubernetes client in this build"),
            Err(error) => error,
        };
        assert!(error.contains("built without the `kubernetes` provider"), "{error}");
    }
}
