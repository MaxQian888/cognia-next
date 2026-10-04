//! Execution-time credential resolution (ADR-0090 Phase 2).
//!
//! Snapshots stop being the only credential source: a provider entry may
//! carry inline keys (desktop renderer path, unchanged) OR a reference that
//! is resolved per attempt at send time. Resolved secrets never enter logs
//! or events — only the stable `fingerprint` (last 4 chars, same convention
//! as `CooldownRow`) does.

use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("credential not found: {0}")]
    NotFound(String),
    #[error("credential source unavailable: {0}")]
    Unavailable(String),
}

/// Where a credential lives. Mirrors the TS `CredentialReference` kinds that
/// are resolvable inside the gateway process.
#[derive(Debug, Clone, PartialEq)]
pub enum CredentialSource<'a> {
    /// Inline value from the snapshot (renderer-projected desktop path).
    Inline(&'a str),
    /// The cognia-secrets encrypted store (headless + desktop).
    SecretStore { id: &'a str },
    /// A host environment variable (headless bootstrap).
    Env { var: &'a str },
}

#[derive(Clone)]
pub struct ResolvedCredential {
    pub secret: String,
    /// Stable non-secret identity for cooldown/lease/telemetry keying.
    pub fingerprint: String,
}

impl std::fmt::Debug for ResolvedCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the secret, even from debug logging.
        f.debug_struct("ResolvedCredential")
            .field("fingerprint", &self.fingerprint)
            .finish()
    }
}

pub fn fingerprint_of(secret: &str) -> String {
    let tail: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{tail}")
}

pub trait CredentialResolver: Send + Sync + 'static {
    fn resolve(&self, source: &CredentialSource<'_>)
        -> Result<ResolvedCredential, CredentialError>;
}

/// Inline-only resolver — exactly today's behavior (snapshot carries keys).
pub struct InlineResolver;

impl CredentialResolver for InlineResolver {
    fn resolve(
        &self,
        source: &CredentialSource<'_>,
    ) -> Result<ResolvedCredential, CredentialError> {
        match source {
            CredentialSource::Inline(secret) if !secret.is_empty() => Ok(ResolvedCredential {
                secret: (*secret).to_string(),
                fingerprint: fingerprint_of(secret),
            }),
            CredentialSource::Inline(_) => {
                Err(CredentialError::NotFound("empty inline key".into()))
            }
            other => Err(CredentialError::Unavailable(format!(
                "inline resolver cannot resolve {other:?}"
            ))),
        }
    }
}

/// cognia-secrets-backed resolver (single-master-key store; the same
/// `secret_store` every other subsystem uses — no new keyring entries).
pub struct SecretStoreResolver {
    pub service: String,
}

/// The secret-store service a provider profile's
/// `{"kind":"secret-store","secretId":…}` credential reference names.
pub const PROVIDER_CREDENTIAL_SERVICE: &str = "com.cognia.provider-credentials";

/// A secret id is a reference written into profile documents, so it is a
/// plain identifier: never empty, never a path, never long enough to carry a
/// key by mistake.
pub fn validate_credential_id(id: &str) -> Result<(), CredentialError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return Err(CredentialError::Unavailable(
            "credential id must be 1-128 characters of [A-Za-z0-9._-]".into(),
        ));
    }
    Ok(())
}

impl SecretStoreResolver {
    /// The resolver the Provider Profile Store's `secret-store` references use.
    pub fn provider_credentials() -> Self {
        Self {
            service: PROVIDER_CREDENTIAL_SERVICE.into(),
        }
    }

    /// Write (or replace) the secret a `secret-store` reference resolves to.
    /// The value is encrypted under the store's master key and never logged.
    pub fn store(&self, id: &str, secret: &str) -> Result<(), CredentialError> {
        validate_credential_id(id)?;
        if secret.trim().is_empty() {
            return Err(CredentialError::Unavailable(
                "credential value is empty".into(),
            ));
        }
        cognia_secrets::secret_store::set(&self.service, id, secret.trim())
            .map_err(CredentialError::Unavailable)
    }

    /// Remove a stored credential. Idempotent.
    pub fn delete(&self, id: &str) -> Result<(), CredentialError> {
        validate_credential_id(id)?;
        cognia_secrets::secret_store::delete(&self.service, id)
            .map_err(CredentialError::Unavailable)
    }

    /// The ids stored under this service. Ids only, never values.
    pub fn ids(&self) -> Result<Vec<String>, CredentialError> {
        let mut ids = cognia_secrets::secret_store::list_accounts(&self.service)
            .map_err(CredentialError::Unavailable)?;
        ids.sort();
        Ok(ids)
    }
}

impl CredentialResolver for SecretStoreResolver {
    fn resolve(
        &self,
        source: &CredentialSource<'_>,
    ) -> Result<ResolvedCredential, CredentialError> {
        match source {
            CredentialSource::SecretStore { id } => {
                match cognia_secrets::secret_store::get(&self.service, id) {
                    Ok(Some(secret)) if !secret.is_empty() => Ok(ResolvedCredential {
                        fingerprint: fingerprint_of(&secret),
                        secret,
                    }),
                    Ok(_) => Err(CredentialError::NotFound(format!("secret-store:{id}"))),
                    Err(error) => Err(CredentialError::Unavailable(error.to_string())),
                }
            }
            other => Err(CredentialError::Unavailable(format!(
                "secret-store resolver cannot resolve {other:?}"
            ))),
        }
    }
}

/// Env-var resolver (headless bootstrap).
pub struct EnvResolver;

impl CredentialResolver for EnvResolver {
    fn resolve(
        &self,
        source: &CredentialSource<'_>,
    ) -> Result<ResolvedCredential, CredentialError> {
        match source {
            CredentialSource::Env { var } => match std::env::var(var) {
                Ok(secret) if !secret.is_empty() => Ok(ResolvedCredential {
                    fingerprint: fingerprint_of(&secret),
                    secret,
                }),
                _ => Err(CredentialError::NotFound(format!("env:{var}"))),
            },
            other => Err(CredentialError::Unavailable(format!(
                "env resolver cannot resolve {other:?}"
            ))),
        }
    }
}

/// First-match chain (inline → secret store → env by construction order).
pub struct ChainResolver {
    pub links: Vec<Arc<dyn CredentialResolver>>,
}

impl ChainResolver {
    pub fn standard(secret_service: impl Into<String>) -> Self {
        Self {
            links: vec![
                Arc::new(InlineResolver),
                Arc::new(SecretStoreResolver {
                    service: secret_service.into(),
                }),
                Arc::new(EnvResolver),
            ],
        }
    }
}

impl CredentialResolver for ChainResolver {
    fn resolve(
        &self,
        source: &CredentialSource<'_>,
    ) -> Result<ResolvedCredential, CredentialError> {
        let mut last = CredentialError::NotFound("empty resolver chain".into());
        for link in &self.links {
            match link.resolve(source) {
                Ok(resolved) => return Ok(resolved),
                Err(error) => last = error,
            }
        }
        Err(last)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_resolves_and_fingerprints_without_leaking() {
        let resolved = InlineResolver
            .resolve(&CredentialSource::Inline("sk-live-abcd1234"))
            .unwrap();
        assert_eq!(resolved.secret, "sk-live-abcd1234");
        assert_eq!(resolved.fingerprint, "…1234");
        let debug = format!("{resolved:?}");
        assert!(!debug.contains("sk-live"), "debug leaked: {debug}");
        assert!(debug.contains("…1234"));
    }

    #[test]
    fn inline_rejects_empty_and_foreign_sources() {
        assert!(InlineResolver
            .resolve(&CredentialSource::Inline(""))
            .is_err());
        assert!(InlineResolver
            .resolve(&CredentialSource::Env { var: "X" })
            .is_err());
    }

    #[test]
    fn env_resolver_reads_process_env() {
        std::env::set_var("COGNIA_GW_TEST_CRED", "sk-env-zz99");
        let resolved = EnvResolver
            .resolve(&CredentialSource::Env {
                var: "COGNIA_GW_TEST_CRED",
            })
            .unwrap();
        assert_eq!(resolved.fingerprint, "…zz99");
        std::env::remove_var("COGNIA_GW_TEST_CRED");
        assert!(EnvResolver
            .resolve(&CredentialSource::Env {
                var: "COGNIA_GW_TEST_CRED",
            })
            .is_err());
    }

    #[test]
    fn chain_falls_through_in_order() {
        std::env::set_var("COGNIA_GW_TEST_CHAIN", "sk-chain-1111");
        let chain = ChainResolver {
            links: vec![Arc::new(InlineResolver), Arc::new(EnvResolver)],
        };
        // Inline wins when present.
        assert_eq!(
            chain
                .resolve(&CredentialSource::Inline("sk-in-2222"))
                .unwrap()
                .fingerprint,
            "…2222"
        );
        // Falls through to env for env sources.
        assert_eq!(
            chain
                .resolve(&CredentialSource::Env {
                    var: "COGNIA_GW_TEST_CHAIN"
                })
                .unwrap()
                .fingerprint,
            "…1111"
        );
        std::env::remove_var("COGNIA_GW_TEST_CHAIN");
    }

    #[test]
    fn provider_credentials_round_trip_through_the_secret_store_by_id() {
        let store = SecretStoreResolver::provider_credentials();
        store.store("stub-openai", "  sk-stub-9876  ").unwrap();
        let resolved = store
            .resolve(&CredentialSource::SecretStore { id: "stub-openai" })
            .unwrap();
        assert_eq!(resolved.secret, "sk-stub-9876");
        assert!(store.ids().unwrap().contains(&"stub-openai".to_string()));
        store.delete("stub-openai").unwrap();
        assert!(store
            .resolve(&CredentialSource::SecretStore { id: "stub-openai" })
            .is_err());
        store.delete("stub-openai").unwrap();
    }

    #[test]
    fn provider_credential_ids_and_values_are_validated() {
        let store = SecretStoreResolver::provider_credentials();
        for id in ["", "../x", "a b", &"x".repeat(129)] {
            assert!(store.store(id, "value").is_err(), "{id}");
        }
        assert!(store.store("ok-id", "   ").is_err());
        assert!(validate_credential_id("Team_1.prod-key").is_ok());
    }

    #[test]
    fn short_secrets_fingerprint_safely() {
        assert_eq!(fingerprint_of("ab"), "…ab");
        assert_eq!(fingerprint_of(""), "…");
    }
}
