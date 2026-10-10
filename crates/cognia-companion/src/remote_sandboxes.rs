//! The desktop's remote sandboxes (ADR-0221 G7, G10).
//!
//! A desktop installs the same sandbox pool a server does, with remote
//! providers only (its local containers are a separate, still-dormant
//! switch). What a server reads from `COGNIA_SANDBOX_PROVIDERS_FILE` and its
//! environment, a desktop reads from the "Remote sandboxes" settings section:
//! one document in the app's data directory
//! ([`cognia_sandbox_pool::desktop::SETTINGS_FILE`]) plus provider credentials
//! in the encrypted secret store, which the document names by id and never
//! holds.
//!
//! # Changes apply at the next start
//!
//! The router is installed once, at startup, in front of the process manager
//! every command drives; an agent it placed cannot be handed to a second
//! router. So a saved change is written immediately and takes effect when the
//! app next starts, and [`RemoteSandboxesView::restart_required`] says so —
//! the same contract a server has with its providers file.
//!
//! # Intentionally inert without a pinned bundle
//!
//! See [`cognia_sandbox_pool::desktop`]: a build with no pinned agent bundle
//! installs nothing, whatever the settings say, and the view reports
//! `bundle_unpinned` so the settings section can say why.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use cognia_environment::baseline::BaselineInputs;
use cognia_environment::catalog::OfferedBundle;
use cognia_external_agent::exec_backend::ExecBackend;
use cognia_external_agent::sandbox_routing_backend::FallbackConfinement;
use cognia_sandbox_pool::boot::{install_with_inputs, InstalledPool, LocalDriver, PoolInputs};
use cognia_sandbox_pool::desktop::{
    pinned_bundle, write_baseline, DesktopAvailability, DesktopRemoteSandboxes, BUNDLE_IMAGE_ENV,
};
use cognia_sandbox_pool::providers::{CredentialLookups, CredentialSource};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The secret-store service provider credentials are kept under; the account
/// is the credential's `secretId`.
pub const SECRET_SERVICE: &str = "cognia-remote-sandboxes";

/// A credential id the settings may name: `remote-sandbox:<slug>`.
const SECRET_ID_PREFIX: &str = "remote-sandbox:";

/// What the running app installed at startup.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct InstalledState {
    /// Whether this app's startup step has run. Until it has, the settings
    /// on disk are what it will read, so nothing waits for a restart.
    started: bool,
    /// The fingerprint of the settings the pool was installed from; `None`
    /// when nothing was installed.
    fingerprint: Option<String>,
    /// Why the pool was asked for and did not install.
    error: Option<String>,
}

static INSTALLED: Lazy<RwLock<InstalledState>> = Lazy::new(|| RwLock::new(InstalledState::default()));

/// The settings section's read model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSandboxesView {
    pub settings: DesktopRemoteSandboxes,
    pub availability: DesktopAvailability,
    /// The agent bundle this build injects, when it carries one.
    pub bundle: Option<OfferedBundle>,
    /// Credential ids the settings name that have a stored value.
    pub stored_secret_ids: Vec<String>,
    /// The saved settings differ from what the running app installed.
    pub restart_required: bool,
    /// Why the pool was asked for at startup and did not install.
    pub install_error: Option<String>,
}

/// A save from the settings section.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSandboxesUpdate {
    pub settings: DesktopRemoteSandboxes,
    /// Credential values by `secretId`: a string stores it, `null` deletes
    /// it, an absent id leaves a stored value alone.
    #[serde(default)]
    pub secrets: BTreeMap<String, Option<String>>,
}

/// A refusal the settings section can name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct RemoteSandboxesError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl RemoteSandboxesError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }
}

impl std::fmt::Display for RemoteSandboxesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<cognia_sandbox_pool::providers::ProvidersError> for RemoteSandboxesError {
    fn from(error: cognia_sandbox_pool::providers::ProvidersError) -> Self {
        Self::new(error.code, error.message)
    }
}

/// The bundle this desktop injects: `COGNIA_AGENT_BUNDLE_IMAGE` at run time,
/// else the one compiled into the release.
pub fn current_bundle() -> Option<OfferedBundle> {
    pinned_bundle(std::env::var(BUNDLE_IMAGE_ENV).ok().as_deref())
}

/// The credential ids `settings` names.
pub fn secret_ids(settings: &DesktopRemoteSandboxes) -> BTreeSet<String> {
    settings
        .providers
        .providers
        .iter()
        .filter_map(|provider| match provider.credential.as_ref() {
            Some(CredentialSource::SecretId(id)) => Some(id.clone()),
            _ => None,
        })
        .collect()
}

fn valid_secret_id(id: &str) -> bool {
    id.strip_prefix(SECRET_ID_PREFIX).is_some_and(|slug| {
        !slug.is_empty()
            && slug.len() <= 63
            && slug
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

fn fingerprint(settings: &DesktopRemoteSandboxes, bundle: Option<&OfferedBundle>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(settings).expect("settings serialize"));
    hasher.update(b"\0");
    if let Some(bundle) = bundle {
        hasher.update(bundle.digest.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn stored_secret(id: &str) -> Option<String> {
    match cognia_secrets::secret_store::get(SECRET_SERVICE, id) {
        Ok(value) => value.filter(|value| !value.trim().is_empty()),
        Err(error) => {
            log::warn!("remote sandboxes: reading credential {id}: {error}");
            None
        }
    }
}

/// The view of the settings saved in `dir` against what is installed.
pub fn view(dir: &Path) -> Result<RemoteSandboxesView, RemoteSandboxesError> {
    view_with(dir, current_bundle())
}

fn view_with(
    dir: &Path,
    bundle: Option<OfferedBundle>,
) -> Result<RemoteSandboxesView, RemoteSandboxesError> {
    let settings = DesktopRemoteSandboxes::load(dir)?;
    let availability = settings.availability(bundle.as_ref());
    let wanted = (availability == DesktopAvailability::Active)
        .then(|| fingerprint(&settings, bundle.as_ref()));
    let installed = INSTALLED.read().clone();
    let stored_secret_ids = secret_ids(&settings)
        .into_iter()
        .filter(|id| stored_secret(id).is_some())
        .collect();
    Ok(RemoteSandboxesView {
        restart_required: installed.started && installed.fingerprint != wanted,
        install_error: installed.error,
        settings,
        availability,
        bundle,
        stored_secret_ids,
    })
}

/// Validate and store a save: credentials into the secret store, the
/// document beside the app's other files. Nothing is written when anything
/// in the update is refused.
pub fn save(
    dir: &Path,
    update: RemoteSandboxesUpdate,
) -> Result<RemoteSandboxesView, RemoteSandboxesError> {
    save_with(dir, update, current_bundle())
}

fn save_with(
    dir: &Path,
    update: RemoteSandboxesUpdate,
    bundle: Option<OfferedBundle>,
) -> Result<RemoteSandboxesView, RemoteSandboxesError> {
    update.settings.validate()?;
    let referenced = secret_ids(&update.settings);
    for id in &referenced {
        if !valid_secret_id(id) {
            return Err(RemoteSandboxesError::new(
                "remote_sandboxes_secret_id_invalid",
                format!("a credential id must look like {SECRET_ID_PREFIX}<slug>, not {id}"),
            ));
        }
    }
    for (id, value) in &update.secrets {
        let deleting = value.is_none();
        if !valid_secret_id(id) || (!deleting && !referenced.contains(id)) {
            return Err(RemoteSandboxesError::new(
                "remote_sandboxes_secret_unreferenced",
                format!("no provider names the credential {id}"),
            ));
        }
        if value.as_deref().is_some_and(|value| value.trim().is_empty()) {
            return Err(RemoteSandboxesError::new(
                "remote_sandboxes_secret_empty",
                format!("the credential {id} is empty"),
            ));
        }
    }
    let unwritable = |error: String| RemoteSandboxesError::new("remote_sandboxes_secret_unwritable", error);
    for (id, value) in &update.secrets {
        match value {
            Some(value) => cognia_secrets::secret_store::set(SECRET_SERVICE, id, value.trim())
                .map_err(unwritable)?,
            None => cognia_secrets::secret_store::delete(SECRET_SERVICE, id).map_err(unwritable)?,
        }
    }
    update.settings.save(dir)?;
    view_with(dir, bundle)
}

/// Install the desktop's pool at startup, in front of `existing`.
///
/// `Ok(None)` when remote sandboxes are not active (no provider, or an
/// unpinned build). A failure is also recorded for the settings section, and
/// the caller keeps running without the pool: a desktop that cannot reach its
/// sandbox providers still has to start.
pub fn install(
    existing: Arc<dyn ExecBackend>,
    dir: &Path,
    deployment_id: &str,
    fallback_confinement: Option<FallbackConfinement>,
) -> Result<Option<InstalledPool>, String> {
    install_with(existing, dir, deployment_id, fallback_confinement, current_bundle())
}

fn install_with(
    existing: Arc<dyn ExecBackend>,
    dir: &Path,
    deployment_id: &str,
    fallback_confinement: Option<FallbackConfinement>,
    bundle: Option<OfferedBundle>,
) -> Result<Option<InstalledPool>, String> {
    let outcome = install_inner(existing, dir, deployment_id, fallback_confinement, bundle);
    let mut installed = INSTALLED.write();
    match &outcome {
        Ok((pool, fingerprint)) => {
            *installed = InstalledState {
                started: true,
                fingerprint: pool.as_ref().map(|_| fingerprint.clone()),
                error: None,
            };
        }
        Err(error) => {
            *installed = InstalledState {
                started: true,
                fingerprint: None,
                error: Some(error.clone()),
            };
        }
    }
    outcome.map(|(pool, _)| pool)
}

fn install_inner(
    existing: Arc<dyn ExecBackend>,
    dir: &Path,
    deployment_id: &str,
    fallback_confinement: Option<FallbackConfinement>,
    bundle: Option<OfferedBundle>,
) -> Result<(Option<InstalledPool>, String), String> {
    let settings = DesktopRemoteSandboxes::load(dir).map_err(|error| error.to_string())?;
    let fingerprint = fingerprint(&settings, bundle.as_ref());
    match settings.availability(bundle.as_ref()) {
        DesktopAvailability::Active => {}
        availability => {
            log::info!("remote sandboxes: off ({availability:?})");
            return Ok((None, fingerprint));
        }
    }
    let baseline = write_baseline(dir, &settings, bundle).map_err(|error| error.to_string())?;
    let env = |name: &str| std::env::var(name).ok();
    let secrets = |id: &str| stored_secret(id);
    let pool = install_with_inputs(
        existing,
        PoolInputs {
            baseline: BaselineInputs {
                baseline_file: Some(baseline),
                ..BaselineInputs::default()
            },
            providers: Some(settings.providers),
            lookups: CredentialLookups {
                env: &env,
                secrets: &secrets,
            },
            local: LocalDriver::None,
            device_approvals: true,
            fallback_confinement,
        },
        dir,
        deployment_id,
    )?;
    Ok((Some(pool), fingerprint))
}

/// The settings section's two commands (registered by the desktop shell).
#[cfg(feature = "tauri-host")]
pub mod commands {
    use super::*;
    use tauri::{AppHandle, Manager};

    fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, RemoteSandboxesError> {
        app.path()
            .app_data_dir()
            .map(|dir| dir.join("cognia"))
            .map_err(|error| RemoteSandboxesError::new("remote_sandboxes_unwritable", error.to_string()))
    }

    async fn blocking<T: Send + 'static>(
        work: impl FnOnce() -> Result<T, RemoteSandboxesError> + Send + 'static,
    ) -> Result<T, RemoteSandboxesError> {
        tokio::task::spawn_blocking(work).await.map_err(|error| {
            RemoteSandboxesError::new("remote_sandboxes_unreadable", error.to_string())
        })?
    }

    /// The "Remote sandboxes" settings, what this build can do with them,
    /// and whether they are what the running app installed.
    #[tauri::command]
    pub async fn remote_sandboxes_get(
        app: AppHandle,
    ) -> Result<RemoteSandboxesView, RemoteSandboxesError> {
        let dir = data_dir(&app)?;
        blocking(move || view(&dir)).await
    }

    /// Save the settings and credentials; they apply at the next start.
    #[tauri::command]
    pub async fn remote_sandboxes_set(
        app: AppHandle,
        update: RemoteSandboxesUpdate,
    ) -> Result<RemoteSandboxesView, RemoteSandboxesError> {
        let dir = data_dir(&app)?;
        blocking(move || save(&dir, update)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_external_agent::exec_backend::LocalProcessBackend;
    use cognia_sandbox_pool::providers::{
        ProviderConfig, ProviderKind, ProviderLimitsConfig, SandboxProvidersFile,
    };

    /// `INSTALLED` is process-global; these tests serialize on it.
    static LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    fn bundle() -> OfferedBundle {
        pinned_bundle(Some(&format!(
            "ghcr.io/cognia/agent-bundle:v2.0.0@sha256:{}",
            "d".repeat(64)
        )))
        .expect("a pinned bundle")
    }

    fn settings(secret: &str) -> DesktopRemoteSandboxes {
        DesktopRemoteSandboxes {
            version: 1,
            providers: SandboxProvidersFile {
                version: 1,
                providers: vec![ProviderConfig {
                    id: "cloud".into(),
                    kind: ProviderKind::E2b,
                    label: Some("E2B".into()),
                    credential: Some(CredentialSource::SecretId(secret.into())),
                    limits: ProviderLimitsConfig::default(),
                    settings: serde_json::json!({}),
                }],
                default_provider_id: None,
            },
            registry_allowlist: Vec::new(),
        }
    }

    fn update(
        settings: DesktopRemoteSandboxes,
        secrets: &[(&str, Option<&str>)],
    ) -> RemoteSandboxesUpdate {
        RemoteSandboxesUpdate {
            settings,
            secrets: secrets
                .iter()
                .map(|(id, value)| (id.to_string(), value.map(str::to_string)))
                .collect(),
        }
    }

    #[test]
    fn a_save_keeps_credentials_in_the_secret_store_not_the_document() {
        let _guard = LOCK.lock();
        // The startup step ran and found nothing to install.
        *INSTALLED.write() = InstalledState {
            started: true,
            ..InstalledState::default()
        };
        let dir = tempfile::tempdir().unwrap();
        let view = save_with(
            dir.path(),
            update(
                settings("remote-sandbox:save-test"),
                &[("remote-sandbox:save-test", Some(" e2b_key "))],
            ),
            Some(bundle()),
        )
        .expect("a valid save");
        assert_eq!(view.availability, DesktopAvailability::Active);
        assert_eq!(view.stored_secret_ids, vec!["remote-sandbox:save-test".to_string()]);
        assert!(view.restart_required, "nothing was installed from these yet");
        let document =
            std::fs::read_to_string(dir.path().join(cognia_sandbox_pool::desktop::SETTINGS_FILE))
                .unwrap();
        assert!(!document.contains("e2b_key"));
        assert_eq!(
            cognia_secrets::secret_store::get(SECRET_SERVICE, "remote-sandbox:save-test")
                .unwrap()
                .as_deref(),
            Some("e2b_key")
        );

        // Deleting a credential leaves the settings and drops the value.
        let view = save_with(
            dir.path(),
            update(
                settings("remote-sandbox:save-test"),
                &[("remote-sandbox:save-test", None)],
            ),
            Some(bundle()),
        )
        .unwrap();
        assert!(view.stored_secret_ids.is_empty());
    }

    #[test]
    fn a_save_refuses_credentials_nothing_names_and_writes_nothing() {
        let _guard = LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        let error = save_with(
            dir.path(),
            update(
                settings("remote-sandbox:named"),
                &[("remote-sandbox:other", Some("x"))],
            ),
            Some(bundle()),
        )
        .unwrap_err();
        assert_eq!(error.code, "remote_sandboxes_secret_unreferenced");
        assert!(!dir
            .path()
            .join(cognia_sandbox_pool::desktop::SETTINGS_FILE)
            .exists());
        assert_eq!(
            cognia_secrets::secret_store::get(SECRET_SERVICE, "remote-sandbox:other").unwrap(),
            None
        );

        let error = save_with(dir.path(), update(settings("keyring:everything"), &[]), Some(bundle()))
            .unwrap_err();
        assert_eq!(error.code, "remote_sandboxes_secret_id_invalid");

        let error = save_with(
            dir.path(),
            update(
                settings("remote-sandbox:named"),
                &[("remote-sandbox:named", Some("  "))],
            ),
            Some(bundle()),
        )
        .unwrap_err();
        assert_eq!(error.code, "remote_sandboxes_secret_empty");
    }

    /// The dormancy pin: an unpinned build installs nothing and says why.
    #[test]
    fn an_unpinned_build_installs_nothing_and_reports_it() {
        let _guard = LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        settings("remote-sandbox:unpinned").save(dir.path()).unwrap();
        let existing: Arc<dyn ExecBackend> = LocalProcessBackend::new();
        let pool = install_with(existing, dir.path(), "dep1", None, None).unwrap();
        assert!(pool.is_none());
        let view = view_with(dir.path(), None).unwrap();
        assert_eq!(view.availability, DesktopAvailability::BundleUnpinned);
        assert!(!view.restart_required, "nothing to install, nothing installed");
        assert!(view.install_error.is_none());
    }

    /// A pool asked for and not installed (here: no stored credential) is a
    /// recorded error and a desktop that keeps running.
    #[test]
    fn a_failed_install_is_recorded_for_the_settings_section() {
        let _guard = LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        settings("remote-sandbox:never-stored").save(dir.path()).unwrap();
        let existing: Arc<dyn ExecBackend> = LocalProcessBackend::new();
        let error = match install_with(existing, dir.path(), "dep1", None, Some(bundle())) {
            Ok(_) => panic!("a provider without its credential cannot install"),
            Err(error) => error,
        };
        let view = view_with(dir.path(), Some(bundle())).unwrap();
        assert_eq!(view.install_error.as_deref(), Some(error.as_str()));
        assert!(view.restart_required);
    }

    /// A save before the startup step has run is what that step will read,
    /// so it asks for no restart.
    #[test]
    fn a_save_before_startup_installs_asks_for_no_restart() {
        let _guard = LOCK.lock();
        *INSTALLED.write() = InstalledState::default();
        let dir = tempfile::tempdir().unwrap();
        let view = save_with(
            dir.path(),
            update(
                settings("remote-sandbox:early"),
                &[("remote-sandbox:early", Some("key"))],
            ),
            Some(bundle()),
        )
        .expect("a valid save");
        assert_eq!(view.availability, DesktopAvailability::Active);
        assert!(!view.restart_required);
        cognia_secrets::secret_store::delete(SECRET_SERVICE, "remote-sandbox:early").unwrap();
    }

    #[test]
    fn credential_ids_are_namespaced_slugs() {
        assert!(valid_secret_id("remote-sandbox:e2b"));
        assert!(valid_secret_id("remote-sandbox:k8s-prod-2"));
        assert!(!valid_secret_id("remote-sandbox:"));
        assert!(!valid_secret_id("remote-sandbox:E2B"));
        assert!(!valid_secret_id("other:e2b"));
        assert!(!valid_secret_id(&format!("remote-sandbox:{}", "a".repeat(64))));
    }
}
