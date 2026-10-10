//! Which remote sandbox providers a Host offers (ADR-0221).
//!
//! One JSON document, the same on both dispatch sources: `cognia-server`
//! reads it from `COGNIA_SANDBOX_PROVIDERS_FILE`, the desktop writes it from
//! its "Remote sandboxes" settings section. It names providers and where
//! their account credentials come from; it never contains a credential.
//!
//! ```json
//! {
//!   "version": 1,
//!   "defaultProviderId": "e2b",
//!   "providers": [
//!     { "id": "e2b", "kind": "e2b", "credential": { "env": "COGNIA_E2B_API_KEY" },
//!       "limits": { "maxConcurrent": 4 }, "settings": { "delegatedRegistries": ["ghcr.io"] } },
//!     { "id": "cluster", "kind": "kubernetes", "credential": { "file": "/etc/cognia/kubeconfig" },
//!       "settings": { "connection": "kubeconfig", "namespace": "cognia-sandboxes" } }
//!   ]
//! }
//! ```
//!
//! `settings` is kept as JSON here and parsed by the provider's own type at
//! boot, so a binary built without a provider can still read the file and
//! refuse that provider by name instead of failing to parse.

use std::path::{Path, PathBuf};
use std::time::Duration;

use cognia_external_agent::sandbox_routing_backend::{is_provider_id, LOCAL_PROVIDER_ID};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::remote::RemoteLimits;

/// The variable naming the providers file on a server.
pub const PROVIDERS_FILE_ENV: &str = "COGNIA_SANDBOX_PROVIDERS_FILE";

/// The providers file's only version.
pub const PROVIDERS_FILE_VERSION: u8 = 1;

pub const DEFAULT_MAX_CONCURRENT: u32 = 4;
pub const DEFAULT_MAX_LIFETIME_SECS: u64 = 7200;
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SandboxProvidersFile {
    /// Always `1`.
    pub version: u8,
    pub providers: Vec<ProviderConfig>,
    /// The remote provider `auto` placement uses when the local driver cannot
    /// attest the required tier (or this Host has none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    E2b,
    Kubernetes,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::E2b => "e2b",
            Self::Kubernetes => "kubernetes",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfig {
    /// `[a-z0-9][a-z0-9-]{0,31}`, never `local`.
    pub id: String,
    pub kind: ProviderKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Where the account credential comes from: the E2B API key, or the
    /// kubeconfig YAML for a Kubernetes provider connecting from outside the
    /// cluster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<CredentialSource>,
    #[serde(default)]
    pub limits: ProviderLimitsConfig,
    /// The provider's own settings (`E2bSettings`, `KubernetesSettings`).
    #[serde(default = "empty_object")]
    pub settings: Value,
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

/// Where a credential is read from. Exactly one source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum CredentialSource {
    /// An environment variable of the Host process.
    Env(String),
    /// A file (mode checks are the operator's; the file is read at boot).
    File(PathBuf),
    /// An entry of the desktop's encrypted secret store.
    SecretId(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLimitsConfig {
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: u32,
    #[serde(default = "default_max_lifetime_secs")]
    pub max_lifetime_secs: u64,
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
}

fn default_max_concurrent() -> u32 {
    DEFAULT_MAX_CONCURRENT
}
fn default_max_lifetime_secs() -> u64 {
    DEFAULT_MAX_LIFETIME_SECS
}
fn default_idle_timeout_secs() -> u64 {
    DEFAULT_IDLE_TIMEOUT_SECS
}

impl Default for ProviderLimitsConfig {
    fn default() -> Self {
        Self {
            max_concurrent: DEFAULT_MAX_CONCURRENT,
            max_lifetime_secs: DEFAULT_MAX_LIFETIME_SECS,
            idle_timeout_secs: DEFAULT_IDLE_TIMEOUT_SECS,
        }
    }
}

impl ProviderLimitsConfig {
    pub fn limits(&self) -> RemoteLimits {
        RemoteLimits {
            max_concurrent: self.max_concurrent,
            max_lifetime: Duration::from_secs(self.max_lifetime_secs),
            idle_timeout: Duration::from_secs(self.idle_timeout_secs),
        }
    }
}

/// Why a providers file is refused. `code` is stable for the console.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvidersError {
    pub code: &'static str,
    pub message: String,
}

impl std::error::Error for ProvidersError {}

impl std::fmt::Display for ProvidersError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

fn error(code: &'static str, message: impl Into<String>) -> ProvidersError {
    ProvidersError {
        code,
        message: message.into(),
    }
}

impl SandboxProvidersFile {
    /// An empty file: no remote providers.
    pub fn empty() -> Self {
        Self {
            version: PROVIDERS_FILE_VERSION,
            providers: Vec::new(),
            default_provider_id: None,
        }
    }

    /// Structural validation. Provider settings are validated by the
    /// provider's own type when it is built.
    pub fn validate(&self) -> Result<(), ProvidersError> {
        if self.version != PROVIDERS_FILE_VERSION {
            return Err(error(
                "providers_version_unsupported",
                format!("version {} is not {PROVIDERS_FILE_VERSION}", self.version),
            ));
        }
        let mut seen = std::collections::BTreeSet::new();
        for provider in &self.providers {
            if !is_provider_id(&provider.id) || provider.id == LOCAL_PROVIDER_ID {
                return Err(error(
                    "provider_id_invalid",
                    format!(
                        "{:?} is not a provider id ([a-z0-9][a-z0-9-]{{0,31}}, not `local`)",
                        provider.id
                    ),
                ));
            }
            if !seen.insert(provider.id.clone()) {
                return Err(error(
                    "provider_id_duplicate",
                    format!("{} is configured twice", provider.id),
                ));
            }
            if provider
                .label
                .as_ref()
                .is_some_and(|label| label.trim().is_empty() || label.chars().count() > 64)
            {
                return Err(error(
                    "provider_label_invalid",
                    format!("{}: labels are 1-64 characters", provider.id),
                ));
            }
            if !provider.settings.is_object() {
                return Err(error(
                    "provider_settings_invalid",
                    format!("{}: settings must be an object", provider.id),
                ));
            }
            let limits = provider.limits;
            if !(1..=256).contains(&limits.max_concurrent) {
                return Err(error(
                    "provider_limits_invalid",
                    format!("{}: maxConcurrent is 1-256", provider.id),
                ));
            }
            if !(300..=86_400).contains(&limits.max_lifetime_secs) {
                return Err(error(
                    "provider_limits_invalid",
                    format!("{}: maxLifetimeSecs is 300-86400", provider.id),
                ));
            }
            if !(60..=86_400).contains(&limits.idle_timeout_secs) {
                return Err(error(
                    "provider_limits_invalid",
                    format!("{}: idleTimeoutSecs is 60-86400", provider.id),
                ));
            }
            match &provider.credential {
                Some(CredentialSource::Env(name))
                    if name.is_empty()
                        || !name
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_') =>
                {
                    return Err(error(
                        "provider_credential_invalid",
                        format!("{}: the credential variable name is invalid", provider.id),
                    ));
                }
                Some(CredentialSource::File(path)) if !path.is_absolute() => {
                    return Err(error(
                        "provider_credential_invalid",
                        format!("{}: the credential file must be an absolute path", provider.id),
                    ));
                }
                Some(CredentialSource::SecretId(id)) if id.trim().is_empty() || id.len() > 256 => {
                    return Err(error(
                        "provider_credential_invalid",
                        format!("{}: the credential secret id is invalid", provider.id),
                    ));
                }
                _ => {}
            }
        }
        if let Some(default) = &self.default_provider_id {
            if !self.providers.iter().any(|provider| &provider.id == default) {
                return Err(error(
                    "provider_default_unknown",
                    format!("the default provider {default} is not configured"),
                ));
            }
        }
        Ok(())
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, ProvidersError> {
        // Serde messages can quote values; a providers file holds no secret
        // by construction, but keep the message to the location regardless.
        let file: Self = serde_json::from_slice(bytes).map_err(|parse| {
            error(
                "providers_file_invalid",
                format!("line {}, column {}: {}", parse.line(), parse.column(), parse.classify_name()),
            )
        })?;
        file.validate()?;
        Ok(file)
    }

    pub fn load(path: &Path) -> Result<Self, ProvidersError> {
        let bytes = std::fs::read(path).map_err(|io| {
            error(
                "providers_file_unreadable",
                format!("{}: {io}", path.display()),
            )
        })?;
        Self::parse(&bytes)
    }

    /// The file a server names in [`PROVIDERS_FILE_ENV`], or none.
    pub fn from_env_lookup(
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<Self>, ProvidersError> {
        match lookup(PROVIDERS_FILE_ENV) {
            Some(path) if !path.trim().is_empty() => Self::load(Path::new(path.trim())).map(Some),
            _ => Ok(None),
        }
    }
}

trait ClassifyName {
    fn classify_name(&self) -> &'static str;
}

impl ClassifyName for serde_json::Error {
    fn classify_name(&self) -> &'static str {
        match self.classify() {
            serde_json::error::Category::Io => "read error",
            serde_json::error::Category::Syntax => "not JSON",
            serde_json::error::Category::Data => "unexpected shape",
            serde_json::error::Category::Eof => "truncated",
        }
    }
}

impl CredentialSource {
    /// Read the credential. `secrets` answers a secret-store id (the desktop);
    /// a Host without a secret store passes a lookup that answers nothing.
    pub fn resolve(
        &self,
        env: &dyn Fn(&str) -> Option<String>,
        secrets: &dyn Fn(&str) -> Option<String>,
    ) -> Result<String, ProvidersError> {
        let value = match self {
            Self::Env(name) => env(name).ok_or_else(|| {
                error(
                    "provider_credential_missing",
                    format!("the variable {name} is not set"),
                )
            })?,
            Self::File(path) => std::fs::read_to_string(path).map_err(|io| {
                error(
                    "provider_credential_missing",
                    format!("{}: {io}", path.display()),
                )
            })?,
            Self::SecretId(id) => secrets(id).ok_or_else(|| {
                error(
                    "provider_credential_missing",
                    format!("the secret store has no entry {id}"),
                )
            })?,
        };
        let value = value.trim().to_string();
        if value.is_empty() {
            return Err(error("provider_credential_missing", "the credential is empty"));
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(value: Value) -> Result<SandboxProvidersFile, ProvidersError> {
        SandboxProvidersFile::parse(value.to_string().as_bytes())
    }

    #[test]
    fn a_file_names_providers_with_defaults_for_their_limits() {
        let parsed = file(json!({
            "version": 1,
            "defaultProviderId": "e2b",
            "providers": [
                { "id": "e2b", "kind": "e2b", "credential": { "env": "COGNIA_E2B_API_KEY" } },
                { "id": "cluster", "kind": "kubernetes", "credential": { "file": "/etc/kubeconfig" },
                  "limits": { "maxConcurrent": 8 }, "settings": { "namespace": "sbx" } }
            ]
        }))
        .unwrap();
        assert_eq!(parsed.providers[0].kind, ProviderKind::E2b);
        assert_eq!(parsed.providers[0].limits, ProviderLimitsConfig::default());
        assert_eq!(parsed.providers[1].limits.max_concurrent, 8);
        assert_eq!(parsed.providers[1].limits.max_lifetime_secs, 7200);
        let limits = parsed.providers[1].limits.limits();
        assert_eq!(limits.idle_timeout, Duration::from_secs(600));
        assert_eq!(parsed.providers[1].settings["namespace"], "sbx");
    }

    #[test]
    fn a_file_that_cannot_be_trusted_is_refused_with_a_stable_code() {
        let cases = [
            (json!({ "version": 2, "providers": [] }), "providers_version_unsupported"),
            (json!({ "version": 1, "providers": [{ "id": "local", "kind": "e2b" }] }), "provider_id_invalid"),
            (json!({ "version": 1, "providers": [{ "id": "E2B", "kind": "e2b" }] }), "provider_id_invalid"),
            (
                json!({ "version": 1, "providers": [{ "id": "a", "kind": "e2b" }, { "id": "a", "kind": "kubernetes" }] }),
                "provider_id_duplicate",
            ),
            (json!({ "version": 1, "providers": [], "defaultProviderId": "x" }), "provider_default_unknown"),
            (
                json!({ "version": 1, "providers": [{ "id": "a", "kind": "e2b", "limits": { "maxConcurrent": 0 } }] }),
                "provider_limits_invalid",
            ),
            (
                json!({ "version": 1, "providers": [{ "id": "a", "kind": "e2b", "limits": { "maxLifetimeSecs": 100000 } }] }),
                "provider_limits_invalid",
            ),
            (
                json!({ "version": 1, "providers": [{ "id": "a", "kind": "e2b", "credential": { "file": "relative" } }] }),
                "provider_credential_invalid",
            ),
            (
                json!({ "version": 1, "providers": [{ "id": "a", "kind": "e2b", "credential": { "env": "BAD NAME" } }] }),
                "provider_credential_invalid",
            ),
            (json!({ "version": 1, "providers": [{ "id": "a", "kind": "e2b", "settings": [] }] }), "provider_settings_invalid"),
            (json!({ "version": 1, "providers": [{ "id": "a", "kind": "vm" }] }), "providers_file_invalid"),
            (json!({ "version": 1, "providers": [], "extra": true }), "providers_file_invalid"),
        ];
        for (value, code) in cases {
            let refused = file(value.clone()).unwrap_err();
            assert_eq!(refused.code, code, "{value}");
        }
    }

    #[test]
    fn credentials_resolve_from_one_source_and_are_never_empty() {
        let env = |name: &str| (name == "KEY").then(|| " secret \n".to_string());
        let secrets = |id: &str| (id == "e2b-key").then(|| "from-store".to_string());
        assert_eq!(
            CredentialSource::Env("KEY".into()).resolve(&env, &secrets).unwrap(),
            "secret"
        );
        assert_eq!(
            CredentialSource::SecretId("e2b-key".into())
                .resolve(&env, &secrets)
                .unwrap(),
            "from-store"
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kubeconfig");
        std::fs::write(&path, "apiVersion: v1\n").unwrap();
        assert_eq!(
            CredentialSource::File(path).resolve(&env, &secrets).unwrap(),
            "apiVersion: v1"
        );
        for missing in [
            CredentialSource::Env("NOPE".into()),
            CredentialSource::SecretId("nope".into()),
            CredentialSource::File(dir.path().join("absent")),
        ] {
            assert_eq!(
                missing.resolve(&env, &secrets).unwrap_err().code,
                "provider_credential_missing"
            );
        }
        let empty = |_: &str| Some("   ".to_string());
        assert_eq!(
            CredentialSource::Env("KEY".into())
                .resolve(&empty, &secrets)
                .unwrap_err()
                .code,
            "provider_credential_missing"
        );
    }

    #[test]
    fn a_server_reads_the_file_its_variable_names() {
        assert!(SandboxProvidersFile::from_env_lookup(|_| None).unwrap().is_none());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        std::fs::write(&path, json!({ "version": 1, "providers": [] }).to_string()).unwrap();
        let path_text = path.display().to_string();
        let loaded = SandboxProvidersFile::from_env_lookup(|name| {
            (name == PROVIDERS_FILE_ENV).then(|| path_text.clone())
        })
        .unwrap()
        .unwrap();
        assert!(loaded.providers.is_empty());
        let missing = dir.path().join("absent.json").display().to_string();
        assert_eq!(
            SandboxProvidersFile::from_env_lookup(|_| Some(missing.clone()))
                .unwrap_err()
                .code,
            "providers_file_unreadable"
        );
    }

    #[test]
    fn the_file_round_trips_without_inventing_fields() {
        let original = SandboxProvidersFile {
            version: 1,
            providers: vec![ProviderConfig {
                id: "e2b".into(),
                kind: ProviderKind::E2b,
                label: Some("E2B".into()),
                credential: Some(CredentialSource::SecretId("remote-sandbox:e2b".into())),
                limits: ProviderLimitsConfig::default(),
                settings: json!({}),
            }],
            default_provider_id: Some("e2b".into()),
        };
        let text = serde_json::to_string(&original).unwrap();
        assert!(text.contains("\"secretId\":\"remote-sandbox:e2b\""));
        assert_eq!(SandboxProvidersFile::parse(text.as_bytes()).unwrap(), original);
    }
}
