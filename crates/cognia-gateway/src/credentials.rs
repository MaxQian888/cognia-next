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
    fn short_secrets_fingerprint_safely() {
        assert_eq!(fingerprint_of("ab"), "…ab");
        assert_eq!(fingerprint_of(""), "…");
    }
}
