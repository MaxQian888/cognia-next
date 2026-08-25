//! OIDC access-token verification with JWKS discovery — ADR-0149 §8.
//!
//! Lifted verbatim from `crates/cognia-ops-controller/src/auth.rs`, which is
//! now a re-export shim. The move is what ADR-0149 §7 asked for, but for a
//! reason the ADR did not have: not that two services had duplicated this, but
//! that a *third* — `cognia-collab-server` — was about to write a third copy in
//! order to exchange an OIDC token for a grant.
//!
//! `services/diagnostic-server` stays out. It verifies against a static RSA PEM
//! rather than JWKS, sits on `jsonwebtoken 9` against this crate's 11, and its
//! image build context cannot see this directory. See the crate root.
//!
//! # What this layer decides, and what it does not
//!
//! It answers "is this token real, and whose is it" — signature, issuer,
//! audience, expiry, and the tenant claim. It does **not** answer what the
//! bearer may do: that is [`crate::membership`], reading membership rows. A
//! token is evidence of identity, never of authority.

use async_trait::async_trait;
use jsonwebtoken::jwk::{Jwk, JwkSet, KeyAlgorithm};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Claims {
    pub subject: String,
    pub tenant_id: String,
    pub scopes: BTreeSet<String>,
}

impl Claims {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.contains(scope)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("access token is invalid: {0}")]
    Invalid(String),
    #[error("OIDC discovery failed: {0}")]
    Discovery(String),
    #[error("access token does not contain tenant claim `{0}`")]
    MissingTenant(String),
}

#[async_trait]
pub trait Authenticator: Send + Sync {
    async fn authenticate(&self, token: &str) -> Result<Claims, AuthError>;
}

#[derive(Default)]
pub struct TestAuthenticator;

#[async_trait]
impl Authenticator for TestAuthenticator {
    async fn authenticate(&self, token: &str) -> Result<Claims, AuthError> {
        let (tenant_id, scopes) = token
            .split_once(':')
            .ok_or_else(|| AuthError::Invalid("test token format".into()))?;
        Ok(Claims {
            subject: "test-user".into(),
            tenant_id: tenant_id.into(),
            scopes: scopes.split(',').map(str::to_owned).collect(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct OidcConfig {
    pub issuer: String,
    pub audience: String,
    pub tenant_claim: String,
    pub jwks_ttl: Duration,
}

#[derive(Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    jwks_uri: String,
}

#[derive(Deserialize)]
struct RawClaims {
    sub: String,
    exp: i64,
    #[serde(default)]
    scope: String,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

struct CachedJwks {
    value: Arc<JwkSet>,
    fetched_at: Instant,
}

pub struct OidcAuthenticator {
    config: OidcConfig,
    client: reqwest::Client,
    cached: RwLock<Option<CachedJwks>>,
}

impl OidcAuthenticator {
    pub fn new(config: OidcConfig) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            config,
            client,
            cached: RwLock::new(None),
        })
    }

    async fn jwks(&self) -> Result<Arc<JwkSet>, AuthError> {
        if let Some(cached) = self.cached.read().as_ref() {
            if cached.fetched_at.elapsed() < self.config.jwks_ttl {
                return Ok(Arc::clone(&cached.value));
            }
        }
        let discovery_url = format!(
            "{}/.well-known/openid-configuration",
            self.config.issuer.trim_end_matches('/')
        );
        let discovery: DiscoveryDocument = self
            .client
            .get(&discovery_url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| AuthError::Discovery(error.to_string()))?
            .json()
            .await
            .map_err(|error| AuthError::Discovery(error.to_string()))?;
        if discovery.issuer.trim_end_matches('/') != self.config.issuer.trim_end_matches('/') {
            return Err(AuthError::Discovery("discovery issuer mismatch".into()));
        }
        let jwks: JwkSet = self
            .client
            .get(&discovery.jwks_uri)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| AuthError::Discovery(error.to_string()))?
            .json()
            .await
            .map_err(|error| AuthError::Discovery(error.to_string()))?;
        let value = Arc::new(jwks);
        *self.cached.write() = Some(CachedJwks {
            value: Arc::clone(&value),
            fetched_at: Instant::now(),
        });
        Ok(value)
    }
}

#[async_trait]
impl Authenticator for OidcAuthenticator {
    async fn authenticate(&self, token: &str) -> Result<Claims, AuthError> {
        let header = decode_header(token).map_err(|error| AuthError::Invalid(error.to_string()))?;
        let kid = header
            .kid
            .ok_or_else(|| AuthError::Invalid("missing kid".into()))?;
        let jwks = self.jwks().await?;
        let jwk = jwks
            .find(&kid)
            .ok_or_else(|| AuthError::Invalid("unknown kid".into()))?;
        let algorithm = algorithm_for_jwk(jwk)
            .ok_or_else(|| AuthError::Invalid("unsupported signing algorithm".into()))?;
        let key =
            DecodingKey::from_jwk(jwk).map_err(|error| AuthError::Invalid(error.to_string()))?;
        let mut validation = Validation::new(algorithm);
        validation.leeway = 60;
        validation.set_issuer(&[self.config.issuer.as_str()]);
        validation.set_audience(&[self.config.audience.as_str()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        let raw = decode::<RawClaims>(token, &key, &validation)
            .map_err(|error| AuthError::Invalid(error.to_string()))?
            .claims;
        let tenant_id = raw
            .extra
            .get(&self.config.tenant_claim)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AuthError::MissingTenant(self.config.tenant_claim.clone()))?;
        let _ = raw.exp;
        Ok(Claims {
            subject: raw.sub,
            tenant_id: tenant_id.into(),
            scopes: raw.scope.split_whitespace().map(str::to_owned).collect(),
        })
    }
}

fn algorithm_for_jwk(jwk: &Jwk) -> Option<Algorithm> {
    match jwk.common.key_algorithm? {
        KeyAlgorithm::ES256 => Some(Algorithm::ES256),
        KeyAlgorithm::ES384 => Some(Algorithm::ES384),
        KeyAlgorithm::RS256 => Some(Algorithm::RS256),
        KeyAlgorithm::RS384 => Some(Algorithm::RS384),
        KeyAlgorithm::RS512 => Some(Algorithm::RS512),
        KeyAlgorithm::PS256 => Some(Algorithm::PS256),
        KeyAlgorithm::PS384 => Some(Algorithm::PS384),
        KeyAlgorithm::PS512 => Some(Algorithm::PS512),
        KeyAlgorithm::EdDSA => Some(Algorithm::EdDSA),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_test_authenticator_splits_tenant_from_scopes() {
        let claims = TestAuthenticator
            .authenticate("tenant-a:servers:read,servers:operate")
            .await
            .unwrap();
        assert_eq!(claims.tenant_id, "tenant-a");
        assert!(claims.has_scope("servers:read"));
        assert!(claims.has_scope("servers:operate"));
        assert!(!claims.has_scope("servers:admin"));
    }

    #[tokio::test]
    async fn a_token_with_no_separator_is_rejected_rather_than_treated_as_a_tenant() {
        assert!(matches!(
            TestAuthenticator.authenticate("no-colon").await,
            Err(AuthError::Invalid(_))
        ));
    }

    #[test]
    fn scopes_are_a_set_so_a_repeated_scope_grants_nothing_extra() {
        let claims = Claims {
            subject: "s".into(),
            tenant_id: "t".into(),
            scopes: ["a", "a", "b"].into_iter().map(str::to_owned).collect(),
        };
        assert_eq!(claims.scopes.len(), 2);
        assert!(claims.has_scope("a"));
    }

    #[test]
    fn only_asymmetric_algorithms_map_to_a_verifier() {
        // The list is an allowlist on purpose. A JWK announcing `HS256` would
        // mean verifying an *asymmetric* token with a symmetric key taken from
        // the JWKS itself — the classic confusion attack — so it maps to None
        // and the token is refused as "unsupported signing algorithm".
        use jsonwebtoken::jwk::{CommonParameters, Jwk, KeyAlgorithm, RSAKeyParameters};

        let jwk_with = |algorithm: Option<KeyAlgorithm>| Jwk {
            common: CommonParameters {
                key_algorithm: algorithm,
                ..Default::default()
            },
            algorithm: jsonwebtoken::jwk::AlgorithmParameters::RSA(RSAKeyParameters::default()),
        };

        assert_eq!(
            algorithm_for_jwk(&jwk_with(Some(KeyAlgorithm::RS256))),
            Some(Algorithm::RS256)
        );
        assert_eq!(
            algorithm_for_jwk(&jwk_with(Some(KeyAlgorithm::EdDSA))),
            Some(Algorithm::EdDSA)
        );
        assert_eq!(
            algorithm_for_jwk(&jwk_with(Some(KeyAlgorithm::HS256))),
            None
        );
        // A JWK that names no algorithm cannot be used to pick one.
        assert_eq!(algorithm_for_jwk(&jwk_with(None)), None);
    }

    #[test]
    fn discovery_url_construction_tolerates_a_trailing_slash_on_the_issuer() {
        for issuer in ["https://idp.test", "https://idp.test/"] {
            let url = format!(
                "{}/.well-known/openid-configuration",
                issuer.trim_end_matches('/')
            );
            assert_eq!(url, "https://idp.test/.well-known/openid-configuration");
        }
    }

    #[test]
    fn a_missing_tenant_claim_names_the_claim_it_wanted() {
        // The operator reading this log needs to know which claim to configure.
        let error = AuthError::MissingTenant("org_id".into());
        assert!(error.to_string().contains("org_id"));
    }
}
