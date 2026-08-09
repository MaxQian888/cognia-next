//! OIDC resource-server validation for the companion API inbound gateway
//! (ADR-0059 cloud/headless brain — Logto integration).
//!
//! In a multi-tenant **cloud/headless brain**, cgnp3 registration carries a
//! Logto-issued **OIDC access token** (OAuth 2.1 resource-server model). This
//! module validates that registration credential. Steady-state public device
//! requests use separately minted, short-lived P-256 DPoP-bound access tokens.
//!
//! # What "validate" means here
//!
//! A Logto access token is a JWT signed (default **ES384**) with a key
//! published in the tenant's JWKS. To trust it, a resource server must:
//!
//! 1. read the token header's `kid` and look up the matching key in the JWKS,
//! 2. verify the signature with that key,
//! 3. check `iss` == the Logto issuer, `aud` == this gateway's API Resource
//!    indicator, and `exp` is in the future,
//! 4. confirm the token's `scope` claim carries every scope the route requires.
//!
//! [`verify_access_token`] does exactly this against an already-fetched
//! [`jsonwebtoken::jwk::JwkSet`] — it performs **no network I/O**, so it is
//! fully unit-testable. The JWKS itself is fetched and cached by
//! [`JwksCache`] (added in Phase 1b).
//!
//! # Claim → cognia mapping
//!
//! - `sub` → the caller identity (Logto user id, or M2M app id).
//! - `organization_id` (Logto Organizations) → the cognia tenant.
//! - `scope` → the granted permission set.

use jsonwebtoken::jwk::{Jwk, JwkSet, KeyAlgorithm};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use parking_lot::RwLock;
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Everything [`verify_access_token`] needs to decide whether a Logto token is
/// acceptable for a given route.
#[derive(Debug, Clone)]
pub struct OidcVerifierConfig {
    /// Expected `iss` claim — the Logto issuer URL, e.g.
    /// `https://logto.example.com/oidc`.
    pub issuer: String,
    /// Expected `aud` claim — this gateway's API Resource **indicator** URI,
    /// e.g. `https://brain.example.com/api`.
    pub audience: String,
    /// Scopes that MUST all be present in the token's `scope` claim for the
    /// request to be authorized. Empty ⇒ any authenticated token passes.
    pub required_scopes: Vec<String>,
    /// Clock-skew leeway in seconds applied to `exp`. Logto access tokens are
    /// short-lived; a small leeway absorbs client/server clock drift.
    pub leeway_secs: u64,
}

impl OidcVerifierConfig {
    /// Convenience constructor with a sane default leeway (60 s).
    pub fn new(
        issuer: impl Into<String>,
        audience: impl Into<String>,
        required_scopes: Vec<String>,
    ) -> Self {
        Self {
            issuer: issuer.into(),
            audience: audience.into(),
            required_scopes,
            leeway_secs: 60,
        }
    }
}

/// Identity extracted from a validated Logto access token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcClaims {
    /// `sub` — the Logto user id (human) or M2M application id (service).
    pub sub: String,
    /// `organization_id` — the Logto Organization the token was issued for,
    /// mapped to a cognia tenant. `None` on non-organization tokens.
    pub organization_id: Option<String>,
    /// Granted scopes, split from the space-delimited `scope` claim.
    pub scopes: Vec<String>,
    /// `exp` — expiry (seconds since Unix epoch).
    pub exp: i64,
}

/// Failure modes of [`verify_access_token`] (and the JWKS fetch layer).
#[derive(Debug, thiserror::Error)]
pub enum OidcError {
    #[error("token header has no `kid`")]
    MissingKid,
    #[error("no JWKS key matches kid `{0}`")]
    UnknownKid(String),
    #[error("JWKS key `{kid}` has an unsupported or missing signing algorithm")]
    UnsupportedKeyAlgorithm { kid: String },
    #[error("could not build a decoding key from JWK `{kid}`: {source}")]
    Jwk {
        kid: String,
        #[source]
        source: jsonwebtoken::errors::Error,
    },
    #[error("token signature, format, or reserved-claim validation failed: {0}")]
    Invalid(#[from] jsonwebtoken::errors::Error),
    #[error("token is missing required scope `{0}`")]
    MissingScope(String),
    #[error("OIDC discovery or JWKS fetch failed: {0}")]
    Discovery(String),
}

// ---------------------------------------------------------------------------
// Raw claims (deserialized from the token body)
// ---------------------------------------------------------------------------

/// The subset of Logto access-token claims we read. `iss` / `aud` / `iat` are
/// validated by `jsonwebtoken` internally and need not appear here.
#[derive(Debug, Deserialize)]
struct RawClaims {
    sub: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    organization_id: Option<String>,
    exp: i64,
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/// Verify a Logto access token against an already-fetched JWKS. **No network.**
///
/// Signature is checked with the key whose `kid` matches the token header, and
/// the algorithm is taken from the **JWKS entry** (not the attacker-controlled
/// token header) to prevent algorithm-confusion attacks.
pub fn verify_access_token(
    jwks: &JwkSet,
    token: &str,
    cfg: &OidcVerifierConfig,
) -> Result<OidcClaims, OidcError> {
    // ── 1. Read the `kid` from the token header ─────────────────────────────
    let header = decode_header(token)?;
    let kid = header.kid.ok_or(OidcError::MissingKid)?;

    // ── 2. Locate the matching signing key in the JWKS ──────────────────────
    let jwk = jwks
        .find(&kid)
        .ok_or_else(|| OidcError::UnknownKid(kid.clone()))?;

    // ── 3. Pin the algorithm to the JWKS entry, NOT the token header ────────
    // Trusting the header's `alg` would allow an algorithm-confusion attack;
    // the key's declared algorithm is authoritative.
    let alg = algorithm_for_jwk(jwk)
        .ok_or_else(|| OidcError::UnsupportedKeyAlgorithm { kid: kid.clone() })?;

    let key = DecodingKey::from_jwk(jwk).map_err(|source| OidcError::Jwk {
        kid: kid.clone(),
        source,
    })?;

    // ── 4. Verify signature + reserved claims (exp / iss / aud) ─────────────
    // `Validation::new(alg)` pins `algorithms` to exactly `[alg]`, so a token
    // whose header advertises a different algorithm is rejected before verify.
    let mut validation = Validation::new(alg);
    validation.leeway = cfg.leeway_secs;
    validation.validate_exp = true;
    validation.validate_nbf = false;
    validation.set_issuer(&[cfg.issuer.as_str()]);
    validation.set_audience(&[cfg.audience.as_str()]);
    validation.set_required_spec_claims(&["exp", "iss", "aud"]);

    let raw = decode::<RawClaims>(token, &key, &validation)?.claims;

    // ── 5. Enforce the route's required scopes ──────────────────────────────
    let scopes: Vec<String> = raw
        .scope
        .as_deref()
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    for required in &cfg.required_scopes {
        if !scopes.iter().any(|granted| granted == required) {
            return Err(OidcError::MissingScope(required.clone()));
        }
    }

    Ok(OidcClaims {
        sub: raw.sub,
        organization_id: raw.organization_id,
        scopes,
        exp: raw.exp,
    })
}

/// Map a JWKS entry's declared signing algorithm to a `jsonwebtoken::Algorithm`.
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

// ---------------------------------------------------------------------------
// JWKS cache (OIDC discovery + fetch + TTL)
// ---------------------------------------------------------------------------

/// The single field we read from the OIDC discovery document.
#[derive(Debug, Deserialize)]
struct DiscoveryDoc {
    jwks_uri: String,
}

struct CachedJwks {
    jwks: Arc<JwkSet>,
    fetched_at: Instant,
}

/// Fetches and caches a Logto tenant's JWKS.
///
/// The signing keys behind a Logto issuer rotate rarely, so the resource
/// server caches them for [`ttl`](Self::new) and only re-fetches (via the
/// OIDC discovery document → `jwks_uri`) once the cache goes stale. This keeps
/// the hot request path free of network I/O.
pub struct JwksCache {
    /// Logto issuer base URL (e.g. `https://logto.example.com/oidc`). The
    /// discovery document lives at `<issuer>/.well-known/openid-configuration`.
    issuer: String,
    ttl: Duration,
    client: reqwest::Client,
    cached: RwLock<Option<CachedJwks>>,
}

impl JwksCache {
    /// Build a cache for `issuer`, keeping fetched keys for `ttl`.
    pub fn new(issuer: impl Into<String>, ttl: Duration) -> Self {
        // Bound the discovery + JWKS round-trip. `jwks()` is reachable from the
        // request hot path (OIDC is tried before the HS256 fall-through), so an
        // issuer that connects but never responds must not stall every companion
        // request for the OS TCP timeout. Fall back to a default client if the
        // builder ever fails (it does not for a static config).
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .no_proxy()
            .build()
            .expect("static OIDC HTTP client configuration must build");
        Self {
            issuer: issuer.into(),
            ttl,
            client,
            cached: RwLock::new(None),
        }
    }

    /// Return the tenant's JWKS, fetching (and caching) it if the cache is
    /// empty or older than the TTL.
    pub async fn jwks(&self) -> Result<Arc<JwkSet>, OidcError> {
        // Fast path: a fresh cached copy.
        if let Some(cached) = self.cached.read().as_ref() {
            if cached.fetched_at.elapsed() < self.ttl {
                return Ok(Arc::clone(&cached.jwks));
            }
        }
        // Slow path: fetch and replace. A concurrent fetch would at worst do
        // redundant work and overwrite with an equally-fresh copy — acceptable
        // for a rarely-rotated key set, and it avoids holding a lock across
        // the network round-trip.
        let jwks = Arc::new(self.fetch().await?);
        *self.cached.write() = Some(CachedJwks {
            jwks: Arc::clone(&jwks),
            fetched_at: Instant::now(),
        });
        Ok(jwks)
    }

    /// Fetch the JWKS fresh: discovery document → `jwks_uri` → key set.
    async fn fetch(&self) -> Result<JwkSet, OidcError> {
        let discovery_url = format!(
            "{}/.well-known/openid-configuration",
            self.issuer.trim_end_matches('/')
        );
        let discovery: DiscoveryDoc = self
            .client
            .get(&discovery_url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| OidcError::Discovery(format!("GET {discovery_url}: {e}")))?
            .json()
            .await
            .map_err(|e| OidcError::Discovery(format!("parse discovery document: {e}")))?;

        let jwks: JwkSet = self
            .client
            .get(&discovery.jwks_uri)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| OidcError::Discovery(format!("GET {}: {e}", discovery.jwks_uri)))?
            .json()
            .await
            .map_err(|e| OidcError::Discovery(format!("parse JWKS: {e}")))?;

        Ok(jwks)
    }
}

// ---------------------------------------------------------------------------
// Authenticator (config + cache, built from the environment)
// ---------------------------------------------------------------------------

/// Environment variable holding the Logto issuer URL. Presence of BOTH this
/// and [`ENV_AUDIENCE`] switches the gateway into OIDC mode.
pub const ENV_ISSUER: &str = "COGNIA_LOGTO_ISSUER";
/// Environment variable holding this gateway's API Resource indicator.
pub const ENV_AUDIENCE: &str = "COGNIA_LOGTO_AUDIENCE";
/// Optional: comma/whitespace-separated scopes every request must carry.
pub const ENV_REQUIRED_SCOPES: &str = "COGNIA_LOGTO_REQUIRED_SCOPES";
/// Optional: JWKS cache TTL in seconds (default 600).
pub const ENV_JWKS_TTL_SECS: &str = "COGNIA_LOGTO_JWKS_TTL_SECS";

const DEFAULT_JWKS_TTL_SECS: u64 = 600;

/// Bundles the verifier config with the JWKS cache — the object the middleware
/// consults when the gateway runs in OIDC (cloud/headless) mode.
pub struct OidcAuthenticator {
    config: OidcVerifierConfig,
    cache: JwksCache,
}

impl OidcAuthenticator {
    /// Build directly from a config + JWKS cache TTL.
    pub fn new(config: OidcVerifierConfig, jwks_ttl: Duration) -> Self {
        let cache = JwksCache::new(config.issuer.clone(), jwks_ttl);
        Self { config, cache }
    }

    /// Build from a variable lookup (real env or a test map). Returns `None`
    /// unless BOTH the issuer and audience are present & non-empty — that is
    /// how OIDC mode stays **off by default** on the offline desktop app.
    pub fn from_vars(get: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let issuer = get(ENV_ISSUER).filter(|s| !s.trim().is_empty())?;
        let audience = get(ENV_AUDIENCE).filter(|s| !s.trim().is_empty())?;
        let required_scopes = get(ENV_REQUIRED_SCOPES)
            .map(|raw| {
                raw.split(|c: char| c == ',' || c.is_whitespace())
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let ttl = get(ENV_JWKS_TTL_SECS)
            .and_then(|s| s.trim().parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or_else(|| Duration::from_secs(DEFAULT_JWKS_TTL_SECS));
        let config = OidcVerifierConfig::new(
            issuer.trim().to_owned(),
            audience.trim().to_owned(),
            required_scopes,
        );
        Some(Self::new(config, ttl))
    }

    /// Build from the process environment. `None` ⇒ OIDC mode is disabled.
    pub fn from_env() -> Option<Arc<Self>> {
        Self::from_vars(|k| std::env::var(k).ok()).map(Arc::new)
    }

    /// The scopes this authenticator requires of every token.
    pub fn required_scopes(&self) -> &[String] {
        &self.config.required_scopes
    }

    /// Fetch (cached) JWKS and verify `token` against the configured issuer,
    /// audience, and required scopes.
    pub async fn authenticate(&self, token: &str) -> Result<OidcClaims, OidcError> {
        // Cheap pre-check BEFORE any network I/O. Registration accepts only a
        // real IdP JWT with a `kid`; malformed or unrelated bearer values must
        // not trigger discovery/JWKS traffic.
        let header = decode_header(token)?;
        if header.kid.is_none() {
            return Err(OidcError::MissingKid);
        }
        let jwks = self.cache.jwks().await?;
        verify_access_token(&jwks, token, &self.config)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    //! Shared OIDC test fixtures — a deterministic P-384 (ES384) keypair, a
    //! matching JWKS, a token minter, and a wiremock discovery+JWKS mounter.
    //! `pub(crate)` so sibling suites (e.g. `middleware`) can mint Logto
    //! tokens and stand up a fake issuer without duplicating key material.
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // Deterministic P-384 test keypair (generated with openssl, ES384). The
    // private key signs test tokens; the JWKS below exposes the public half.
    pub(crate) const TEST_PRIVATE_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDDcIjauh48CSp0lEVYP\n\
w4XTC5uWLIO7cIPKlbqQr22ufRVVNuYohxpppzoVsRicCW+hZANiAAQh5CBI9kKF\n\
gCdPz9JXKjnpR3r6P7SkjxqjsNVkRPOm1Wm+20enwYU0m5zWGfA3kojy6ejQg4Ub\n\
NMXGupxmTMhli7JOJL8zEc93nWvBSpvoVwfTUwBHaYvIFdINrBF5wQg=\n\
-----END PRIVATE KEY-----\n";
    pub(crate) const TEST_X: &str =
        "IeQgSPZChYAnT8_SVyo56Ud6-j-0pI8ao7DVZETzptVpvttHp8GFNJuc1hnwN5KI";
    pub(crate) const TEST_Y: &str =
        "8uno0IOFGzTFxrqcZkzIZYuyTiS_MxHPd51rwUqb6FcH01MAR2mLyBXSDawRecEI";
    pub(crate) const TEST_KID: &str = "test-key-1";

    /// The single-key JWKS as raw JSON — used both as a parsed key set and as
    /// a wiremock response body.
    pub(crate) fn jwks_value() -> serde_json::Value {
        json!({
            "keys": [{
                "kty": "EC",
                "crv": "P-384",
                "x": TEST_X,
                "y": TEST_Y,
                "use": "sig",
                "alg": "ES384",
                "kid": TEST_KID,
            }]
        })
    }

    /// The test JWKS parsed into a [`JwkSet`].
    pub(crate) fn jwks() -> JwkSet {
        serde_json::from_value(jwks_value()).expect("parse test JWKS")
    }

    pub(crate) fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    /// Mint a token from arbitrary claims with a chosen header kid + alg.
    pub(crate) fn mint(claims: serde_json::Value, kid: Option<&str>, alg: Algorithm) -> String {
        let mut header = Header::new(alg);
        header.kid = kid.map(str::to_owned);
        let key = EncodingKey::from_ec_pem(TEST_PRIVATE_PEM.as_bytes()).expect("load ec pem");
        encode(&header, &claims, &key).expect("encode token")
    }

    /// A valid claim set (fresh `exp`) for the given issuer + audience.
    pub(crate) fn claims(issuer: &str, audience: &str) -> serde_json::Value {
        json!({
            "sub": "user_abc",
            "iss": issuer,
            "aud": audience,
            "iat": now(),
            "exp": now() + 3600,
            "scope": "brain:rpc brain:read",
            "organization_id": "org_tenant_1",
        })
    }

    /// Mount OIDC discovery + JWKS on `server`, asserting each endpoint is hit
    /// exactly `disc_calls` / `jwks_calls` times (verified on server drop).
    pub(crate) async fn mount(server: &MockServer, disc_calls: u64, jwks_calls: u64) {
        Mock::given(method("GET"))
            .and(path("/.well-known/openid-configuration"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "issuer": server.uri(),
                "jwks_uri": format!("{}/oidc/jwks", server.uri()),
            })))
            .expect(disc_calls)
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/oidc/jwks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(jwks_value()))
            .expect(jwks_calls)
            .mount(server)
            .await;
    }

    /// Like [`mount`] but without asserting call counts — for suites where the
    /// number of JWKS fetches depends on auth fall-through behavior.
    pub(crate) async fn mount_lenient(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path("/.well-known/openid-configuration"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "issuer": server.uri(),
                "jwks_uri": format!("{}/oidc/jwks", server.uri()),
            })))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/oidc/jwks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(jwks_value()))
            .mount(server)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{jwks as test_jwks, mint, now, TEST_KID};
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;

    const ISSUER: &str = "https://logto.test/oidc";
    const AUDIENCE: &str = "https://brain.cognia.test/api";

    fn cfg(required: &[&str]) -> OidcVerifierConfig {
        OidcVerifierConfig::new(
            ISSUER,
            AUDIENCE,
            required.iter().map(|s| s.to_string()).collect(),
        )
    }

    fn valid_claims() -> serde_json::Value {
        test_support::claims(ISSUER, AUDIENCE)
    }

    #[test]
    fn valid_token_returns_mapped_claims() {
        let token = mint(valid_claims(), Some(TEST_KID), Algorithm::ES384);
        let claims = verify_access_token(&test_jwks(), &token, &cfg(&["brain:rpc"]))
            .expect("valid token should verify");
        assert_eq!(claims.sub, "user_abc");
        assert_eq!(claims.organization_id.as_deref(), Some("org_tenant_1"));
        assert!(claims.scopes.contains(&"brain:rpc".to_string()));
        assert!(claims.scopes.contains(&"brain:read".to_string()));
    }

    #[test]
    fn no_required_scopes_accepts_any_authenticated_token() {
        let token = mint(valid_claims(), Some(TEST_KID), Algorithm::ES384);
        let claims = verify_access_token(&test_jwks(), &token, &cfg(&[]))
            .expect("no scope requirement should pass");
        assert_eq!(claims.sub, "user_abc");
    }

    #[test]
    fn token_without_organization_maps_to_none() {
        let mut c = valid_claims();
        c.as_object_mut().unwrap().remove("organization_id");
        let token = mint(c, Some(TEST_KID), Algorithm::ES384);
        let claims =
            verify_access_token(&test_jwks(), &token, &cfg(&["brain:rpc"])).expect("verify");
        assert_eq!(claims.organization_id, None);
    }

    #[test]
    fn missing_kid_is_rejected() {
        let token = mint(valid_claims(), None, Algorithm::ES384);
        let err = verify_access_token(&test_jwks(), &token, &cfg(&["brain:rpc"])).unwrap_err();
        assert!(matches!(err, OidcError::MissingKid), "got {err:?}");
    }

    #[test]
    fn unknown_kid_is_rejected() {
        let token = mint(valid_claims(), Some("some-other-kid"), Algorithm::ES384);
        let err = verify_access_token(&test_jwks(), &token, &cfg(&["brain:rpc"])).unwrap_err();
        assert!(
            matches!(err, OidcError::UnknownKid(ref k) if k == "some-other-kid"),
            "got {err:?}"
        );
    }

    #[test]
    fn wrong_audience_is_rejected() {
        let mut c = valid_claims();
        c["aud"] = json!("https://someone-else/api");
        let token = mint(c, Some(TEST_KID), Algorithm::ES384);
        let err = verify_access_token(&test_jwks(), &token, &cfg(&["brain:rpc"])).unwrap_err();
        assert!(matches!(err, OidcError::Invalid(_)), "got {err:?}");
    }

    #[test]
    fn wrong_issuer_is_rejected() {
        let mut c = valid_claims();
        c["iss"] = json!("https://evil.test/oidc");
        let token = mint(c, Some(TEST_KID), Algorithm::ES384);
        let err = verify_access_token(&test_jwks(), &token, &cfg(&["brain:rpc"])).unwrap_err();
        assert!(matches!(err, OidcError::Invalid(_)), "got {err:?}");
    }

    #[test]
    fn expired_token_is_rejected() {
        let mut c = valid_claims();
        c["iat"] = json!(now() - 7200);
        c["exp"] = json!(now() - 3600);
        let token = mint(c, Some(TEST_KID), Algorithm::ES384);
        let err = verify_access_token(&test_jwks(), &token, &cfg(&["brain:rpc"])).unwrap_err();
        assert!(matches!(err, OidcError::Invalid(_)), "got {err:?}");
    }

    #[test]
    fn missing_required_scope_is_rejected() {
        // Token only carries brain:read; route needs brain:admin.
        let mut c = valid_claims();
        c["scope"] = json!("brain:read");
        let token = mint(c, Some(TEST_KID), Algorithm::ES384);
        let err = verify_access_token(&test_jwks(), &token, &cfg(&["brain:admin"])).unwrap_err();
        assert!(
            matches!(err, OidcError::MissingScope(ref s) if s == "brain:admin"),
            "got {err:?}"
        );
    }

    #[test]
    fn token_without_scope_claim_fails_scope_requirement() {
        let mut c = valid_claims();
        c.as_object_mut().unwrap().remove("scope");
        let token = mint(c, Some(TEST_KID), Algorithm::ES384);
        let err = verify_access_token(&test_jwks(), &token, &cfg(&["brain:rpc"])).unwrap_err();
        assert!(matches!(err, OidcError::MissingScope(_)), "got {err:?}");
    }

    #[test]
    fn tampered_signature_is_rejected() {
        let token = mint(valid_claims(), Some(TEST_KID), Algorithm::ES384);
        // Flip the last character of the signature segment.
        let mut chars: Vec<char> = token.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == 'A' { 'B' } else { 'A' };
        let tampered: String = chars.into_iter().collect();
        let err = verify_access_token(&test_jwks(), &tampered, &cfg(&["brain:rpc"])).unwrap_err();
        assert!(matches!(err, OidcError::Invalid(_)), "got {err:?}");
    }

    #[test]
    fn algorithm_confusion_header_is_rejected() {
        // Classic algorithm-confusion attempt: the attacker presents a token
        // whose header advertises HS256 (symmetric) while the JWKS key is
        // ES384 (asymmetric), hoping the server treats the EC public material
        // as an HMAC secret. The verifier pins the algorithm to the JWKS
        // entry, so the mismatched header is rejected before any signature
        // check — no valid signature is even required to trigger this.
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some(TEST_KID.to_string());
        let forged = encode(
            &header,
            &valid_claims(),
            &EncodingKey::from_secret(b"attacker-chosen-secret"),
        )
        .expect("mint HS256 token");
        let err = verify_access_token(&test_jwks(), &forged, &cfg(&["brain:rpc"])).unwrap_err();
        assert!(matches!(err, OidcError::Invalid(_)), "got {err:?}");
    }

    // ── JwksCache (discovery + fetch + TTL) ──────────────────────────────────

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn cache_fetches_jwks_via_discovery() {
        let server = MockServer::start().await;
        test_support::mount(&server, 1, 1).await;
        let cache = JwksCache::new(server.uri(), Duration::from_secs(300));
        let jwks = cache.jwks().await.expect("fetch jwks");
        assert!(jwks.find(TEST_KID).is_some());
    }

    #[tokio::test]
    async fn cache_hit_avoids_refetch() {
        let server = MockServer::start().await;
        // Exactly ONE call to each endpoint across two jwks() reads.
        test_support::mount(&server, 1, 1).await;
        let cache = JwksCache::new(server.uri(), Duration::from_secs(300));
        let a = cache.jwks().await.expect("first");
        let b = cache.jwks().await.expect("second");
        assert!(a.find(TEST_KID).is_some());
        assert!(b.find(TEST_KID).is_some());
    }

    #[tokio::test]
    async fn stale_cache_refetches() {
        let server = MockServer::start().await;
        // ttl=0 ⇒ every read is stale ⇒ two fetches for two reads.
        test_support::mount(&server, 2, 2).await;
        let cache = JwksCache::new(server.uri(), Duration::ZERO);
        let _ = cache.jwks().await.expect("first");
        let _ = cache.jwks().await.expect("second");
    }

    #[tokio::test]
    async fn discovery_failure_surfaces_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/.well-known/openid-configuration"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let cache = JwksCache::new(server.uri(), Duration::from_secs(300));
        let err = cache.jwks().await.unwrap_err();
        assert!(matches!(err, OidcError::Discovery(_)), "got {err:?}");
    }

    // ── OidcAuthenticator (config + cache, env parsing) ──────────────────────

    #[tokio::test]
    async fn authenticator_verifies_valid_token() {
        let server = MockServer::start().await;
        test_support::mount(&server, 1, 1).await;
        let authn = OidcAuthenticator::new(
            OidcVerifierConfig::new(server.uri(), AUDIENCE, vec!["brain:rpc".to_string()]),
            Duration::from_secs(300),
        );
        let token = mint(
            test_support::claims(&server.uri(), AUDIENCE),
            Some(TEST_KID),
            Algorithm::ES384,
        );
        let claims = authn.authenticate(&token).await.expect("authenticate");
        assert_eq!(claims.sub, "user_abc");
        assert_eq!(claims.organization_id.as_deref(), Some("org_tenant_1"));
    }

    #[tokio::test]
    async fn authenticate_rejects_kidless_token_without_fetching_jwks() {
        // A kid-less token (e.g. a paired HS256 device token) must be rejected
        // with MissingKid BEFORE any JWKS fetch, so a slow/unreachable issuer
        // can't stall the HS256 fall-through. The server has NO mocks mounted:
        // any discovery/JWKS request would 404 and surface as
        // OidcError::Discovery — getting MissingKid instead proves the network
        // was never touched.
        let server = MockServer::start().await;
        let authn = OidcAuthenticator::new(
            OidcVerifierConfig::new(server.uri(), AUDIENCE, vec![]),
            Duration::from_secs(300),
        );
        let token = mint(valid_claims(), None, Algorithm::ES384);
        let err = authn.authenticate(&token).await.unwrap_err();
        assert!(matches!(err, OidcError::MissingKid), "got {err:?}");
    }

    #[tokio::test]
    async fn authenticator_rejects_expired_token() {
        let server = MockServer::start().await;
        test_support::mount(&server, 1, 1).await;
        let authn = OidcAuthenticator::new(
            OidcVerifierConfig::new(server.uri(), AUDIENCE, vec![]),
            Duration::from_secs(300),
        );
        let mut c = test_support::claims(&server.uri(), AUDIENCE);
        c["iat"] = json!(now() - 7200);
        c["exp"] = json!(now() - 3600);
        let token = mint(c, Some(TEST_KID), Algorithm::ES384);
        let err = authn.authenticate(&token).await.unwrap_err();
        assert!(matches!(err, OidcError::Invalid(_)), "got {err:?}");
    }

    #[test]
    fn from_vars_disabled_without_issuer_and_audience() {
        // Nothing configured ⇒ OIDC off.
        assert!(OidcAuthenticator::from_vars(|_| None).is_none());
        // Issuer alone is not enough.
        assert!(
            OidcAuthenticator::from_vars(|k| (k == ENV_ISSUER).then(|| ISSUER.to_string()))
                .is_none()
        );
        // Audience alone is not enough.
        assert!(
            OidcAuthenticator::from_vars(|k| (k == ENV_AUDIENCE).then(|| AUDIENCE.to_string()))
                .is_none()
        );
        // A blank issuer is treated as absent.
        assert!(OidcAuthenticator::from_vars(|k| match k {
            ENV_ISSUER => Some("   ".to_string()),
            ENV_AUDIENCE => Some(AUDIENCE.to_string()),
            _ => None,
        })
        .is_none());
    }

    #[test]
    fn from_vars_parses_issuer_audience_and_scopes() {
        let authn = OidcAuthenticator::from_vars(|k| match k {
            ENV_ISSUER => Some(ISSUER.to_string()),
            ENV_AUDIENCE => Some(AUDIENCE.to_string()),
            ENV_REQUIRED_SCOPES => Some("brain:rpc, brain:admin".to_string()),
            _ => None,
        })
        .expect("both issuer + audience present ⇒ configured");
        assert_eq!(
            authn.required_scopes(),
            &["brain:rpc".to_string(), "brain:admin".to_string()]
        );
    }
}
