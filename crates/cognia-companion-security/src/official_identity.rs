//! Trust anchors for a signed-in person, including the official Cognia
//! account (ADR-0215 §2, ADR-0149 §9).
//!
//! `account_bind_person` records which person a profile belongs to after the
//! renderer proves a sign-in with an access token. The host verifies that
//! token against an issuer it trusts on its own authority, never one the
//! caller names. Three sources can supply that issuer:
//!
//! - **Env**: `COGNIA_LOGTO_ISSUER` / `COGNIA_LOGTO_AUDIENCE` on a headless
//!   host. A host configured this way trusts exactly that issuer;
//! - **Stored**: the deployment record `account_set_cloud_deployment` fetched
//!   itself from a gateway the person chose;
//! - **Official**: the official account's issuer, compiled into the build,
//!   trusted beside a stored deployment (or alone).
//!
//! The token's own (unverified) `iss` only *chooses among* these anchors; the
//! token is then verified against the chosen one, so naming an issuer nobody
//! configured gets the caller nothing.
//!
//! # The person's id
//!
//! A subject is opaque, so the id is derived: `usr_` + the first 24 hex
//! characters of SHA-256(`user\n<issuer>\n<subject>`), identical to
//! `lib/identity/sign-in.ts`. Only the **official** issuer is different: it
//! mints `usr_` ids as its subject (ADR-0149 §1), so a subject from the
//! official anchor that is a valid user id IS the id.
//!
//! That exception is tied to the anchor, never to what a deployment says
//! about itself. A gateway the renderer can name announces whatever it likes,
//! so if its subjects were taken as ids it could mint a token whose subject
//! is somebody else's official id and bind this profile to them. Hashing in
//! the issuer keeps every other issuer's ids in a space of their own.
//!
//! Both sides read `fixtures/identity-id-vectors.json`, so they cannot drift
//! apart.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use cognia_tenant_auth::UserId;
use sha2::{Digest, Sha256};

use crate::oidc::{self, OidcAuthenticator, OidcVerifierConfig};

/// The production official issuer, unless the build overrides it.
pub const OFFICIAL_ISSUER_DEFAULT: &str = "https://id.cognia.cn/api/auth";
/// The audience of the official account's access tokens (the sync API).
pub const OFFICIAL_AUDIENCE_DEFAULT: &str = "https://sync.cognia.cn";
/// Names of the build-time (and, in debug builds, runtime) overrides.
pub const ENV_OFFICIAL_ISSUER: &str = "COGNIA_OFFICIAL_ISSUER";
pub const ENV_OFFICIAL_AUDIENCE: &str = "COGNIA_OFFICIAL_AUDIENCE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorSource {
    Env,
    Stored,
    Official,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustAnchor {
    pub issuer: String,
    pub audience: String,
    pub source: AnchorSource,
}

fn is_loopback_http(url: &str) -> bool {
    ["http://localhost", "http://127.0.0.1", "http://[::1]"]
        .iter()
        .any(|prefix| {
            url.strip_prefix(prefix).is_some_and(|rest| {
                rest.is_empty() || rest.starts_with(':') || rest.starts_with('/')
            })
        })
}

/// Whether `issuer` may be the official anchor: https, or loopback http in a
/// debug build (a developer's local identity Worker).
fn acceptable_official_issuer(issuer: &str, debug: bool) -> bool {
    issuer.starts_with("https://") || (debug && is_loopback_http(issuer))
}

/// Resolve the official anchor from (in order) a debug-build runtime
/// override, the build-time override, and the production default.
///
/// A release build never reads the runtime environment for this: whoever can
/// set an environment variable on a user's machine must not be able to make
/// the desktop trust another issuer as the official one.
pub fn official_anchor_from(
    runtime: impl Fn(&str) -> Option<String>,
    build_issuer: Option<&str>,
    build_audience: Option<&str>,
    debug: bool,
) -> Option<TrustAnchor> {
    let pick = |name: &str, build: Option<&str>, default: &str| -> String {
        let from_runtime = if debug { runtime(name) } else { None };
        from_runtime
            .or_else(|| build.map(str::to_owned))
            .map(|value| value.trim().trim_end_matches('/').to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default.to_owned())
    };
    let issuer = pick(ENV_OFFICIAL_ISSUER, build_issuer, OFFICIAL_ISSUER_DEFAULT);
    let audience = pick(
        ENV_OFFICIAL_AUDIENCE,
        build_audience,
        OFFICIAL_AUDIENCE_DEFAULT,
    );
    acceptable_official_issuer(&issuer, debug).then_some(TrustAnchor {
        issuer,
        audience,
        source: AnchorSource::Official,
    })
}

/// The official anchor of this build.
pub fn official_anchor() -> Option<TrustAnchor> {
    official_anchor_from(
        |name| std::env::var(name).ok(),
        option_env!("COGNIA_OFFICIAL_ISSUER"),
        option_env!("COGNIA_OFFICIAL_AUDIENCE"),
        cfg!(debug_assertions),
    )
}

/// Whether two issuer URLs name the same issuer. A trailing slash is not a
/// different issuer.
pub fn same_issuer(left: &str, right: &str) -> bool {
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

/// The anchor whose issuer the token names, among the configured ones only.
pub fn select_anchor<'a, T>(
    anchors: &'a [T],
    unverified_iss: &str,
    anchor_of: impl Fn(&T) -> &TrustAnchor,
) -> Option<&'a T> {
    anchors
        .iter()
        .find(|entry| same_issuer(&anchor_of(entry).issuer, unverified_iss))
}

/// Every anchor a host trusts, each with its verifier.
///
/// - An environment that configures an issuer (a headless host) is the only
///   anchor: that deployment chose its issuer explicitly.
/// - Otherwise the deployment the person chose (`stored`), plus `official`.
///   A stored deployment that IS the official issuer is the official anchor,
///   with the official issuer, audience and id rule, never a second copy
///   under the gateway's spelling of it.
pub fn trusted_anchors(
    vars: impl Fn(&str) -> Option<String>,
    stored: Option<TrustAnchor>,
    official: Option<TrustAnchor>,
    jwks_ttl: Duration,
) -> Vec<(TrustAnchor, Arc<OidcAuthenticator>)> {
    if let Some(from_env) = OidcAuthenticator::from_vars(&vars) {
        let anchor = TrustAnchor {
            issuer: from_env.issuer().to_owned(),
            audience: vars(oidc::ENV_AUDIENCE)
                .unwrap_or_default()
                .trim()
                .to_owned(),
            source: AnchorSource::Env,
        };
        return vec![(anchor, Arc::new(from_env))];
    }
    let verified = |anchor: TrustAnchor| {
        let config =
            OidcVerifierConfig::new(anchor.issuer.clone(), anchor.audience.clone(), Vec::new());
        (anchor, Arc::new(OidcAuthenticator::new(config, jwks_ttl)))
    };
    let stored = stored.filter(|stored| {
        official
            .as_ref()
            .is_none_or(|official| !same_issuer(&stored.issuer, &official.issuer))
    });
    stored.into_iter().chain(official).map(verified).collect()
}

/// [`trusted_anchors`] for this process: its environment and this build's
/// official anchor.
pub fn host_anchors(
    stored: Option<TrustAnchor>,
    jwks_ttl: Duration,
) -> Vec<(TrustAnchor, Arc<OidcAuthenticator>)> {
    trusted_anchors(
        |name| std::env::var(name).ok(),
        stored,
        official_anchor(),
        jwks_ttl,
    )
}

/// The `iss` a JWT claims, read WITHOUT verifying it. Only for choosing which
/// configured anchor to verify the token against; never trust it otherwise.
pub fn unverified_issuer(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("iss")?.as_str().map(str::to_owned)
}

/// `usr_`/`org_` + 24 hex characters of SHA-256(`kind\nissuer\nsubject`).
pub fn derive_identity_id(prefix: &str, kind: &str, issuer: &str, subject: &str) -> String {
    let digest = Sha256::digest(format!("{kind}\n{issuer}\n{subject}").as_bytes());
    format!("{prefix}{}", &hex::encode(digest)[..24])
}

/// The person's id for a verified subject. `official`: the token was verified
/// against the official anchor, the one issuer whose subjects are ids.
pub fn expected_user_id(official: bool, issuer: &str, subject: &str) -> String {
    if official && UserId::parse(subject).is_ok() {
        return subject.to_owned();
    }
    derive_identity_id("usr_", "user", issuer, subject)
}

/// Who a verified access token says the person is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPerson {
    pub user_id: String,
    /// The derived `org_` id of a Logto organization token.
    pub org_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum PersonVerifyError {
    #[error("this host trusts no sign-in issuer (no COGNIA_LOGTO_ISSUER / COGNIA_LOGTO_AUDIENCE, no chosen deployment, no official account)")]
    NoAnchor,
    #[error("the access token's issuer is not one this host trusts")]
    UntrustedIssuer,
    #[error("the access token was rejected: {0}")]
    Rejected(#[from] oidc::OidcError),
}

/// Verify `token` against the trusted anchor its issuer names and return the
/// person's ids. The token's unverified `iss` only picks the anchor; the
/// signature, issuer and audience are then checked against that anchor.
pub async fn verify_person(
    anchors: &[(TrustAnchor, Arc<OidcAuthenticator>)],
    token: &str,
) -> Result<VerifiedPerson, PersonVerifyError> {
    if anchors.is_empty() {
        return Err(PersonVerifyError::NoAnchor);
    }
    let claimed = unverified_issuer(token).ok_or(PersonVerifyError::UntrustedIssuer)?;
    let (anchor, verifier) = select_anchor(anchors, &claimed, |(anchor, _)| anchor)
        .ok_or(PersonVerifyError::UntrustedIssuer)?;
    let claims = verifier.authenticate(token).await?;
    let issuer = verifier.issuer();
    Ok(VerifiedPerson {
        user_id: expected_user_id(anchor.source == AnchorSource::Official, issuer, &claims.sub),
        org_id: claims
            .organization_id
            .as_deref()
            .map(|organization| derive_identity_id("org_", "org", issuer, organization)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oidc::test_support;
    use jsonwebtoken::Algorithm;
    use serde_json::json;

    #[derive(serde::Deserialize)]
    struct Vector {
        issuer: String,
        subject: String,
        official: bool,
        #[serde(rename = "userId")]
        user_id: String,
    }

    const TTL: Duration = Duration::from_secs(600);

    fn stored(issuer: &str) -> TrustAnchor {
        TrustAnchor {
            issuer: issuer.into(),
            audience: "https://api.example".into(),
            source: AnchorSource::Stored,
        }
    }

    fn official() -> Option<TrustAnchor> {
        official_anchor_from(|_| None, None, None, false)
    }

    fn sources(anchors: &[(TrustAnchor, Arc<OidcAuthenticator>)]) -> Vec<AnchorSource> {
        anchors.iter().map(|(anchor, _)| anchor.source).collect()
    }

    fn none(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn user_ids_match_the_shared_vectors() {
        let raw = include_str!("../fixtures/identity-id-vectors.json");
        let vectors: Vec<Vector> = serde_json::from_str(raw).unwrap();
        assert!(vectors.len() >= 6);
        for vector in vectors {
            assert_eq!(
                expected_user_id(vector.official, &vector.issuer, &vector.subject),
                vector.user_id,
                "{} / {}",
                vector.issuer,
                vector.subject
            );
        }
    }

    #[test]
    fn org_ids_match_the_renderer_contract() {
        assert_eq!(
            derive_identity_id("org_", "org", "https://logto.test/oidc", "tenant-1"),
            "org_b6f56214a98891636d36e8c5"
        );
    }

    #[test]
    fn only_the_official_issuer_mints_ids_as_subjects() {
        let id = expected_user_id(true, "https://id.test/api/auth", "opaque-subject");
        assert!(id.starts_with("usr_") && id.len() == 28, "{id}");
        // Any other issuer's user-id-shaped subject is still hashed with its
        // issuer, so it can never equal an official id.
        assert_ne!(
            expected_user_id(false, "https://gw.example/api/auth", "usr_0123456789abcdef"),
            "usr_0123456789abcdef"
        );
    }

    #[test]
    fn the_official_anchor_defaults_to_production() {
        let anchor = official().unwrap();
        assert_eq!(anchor.issuer, OFFICIAL_ISSUER_DEFAULT);
        assert_eq!(anchor.audience, OFFICIAL_AUDIENCE_DEFAULT);
        assert_eq!(anchor.source, AnchorSource::Official);
    }

    #[test]
    fn a_release_build_ignores_the_runtime_environment() {
        let runtime =
            |name: &str| (name == ENV_OFFICIAL_ISSUER).then(|| "https://evil.example".to_owned());
        assert_eq!(
            official_anchor_from(runtime, None, None, false)
                .unwrap()
                .issuer,
            OFFICIAL_ISSUER_DEFAULT
        );
        // The build-time override is part of the build, so it applies.
        assert_eq!(
            official_anchor_from(
                runtime,
                Some("https://id-staging.cognia.cn/api/auth/"),
                None,
                false
            )
            .unwrap()
            .issuer,
            "https://id-staging.cognia.cn/api/auth"
        );
    }

    #[test]
    fn a_debug_build_may_point_at_a_local_worker_over_loopback_http() {
        let runtime = |name: &str| {
            (name == ENV_OFFICIAL_ISSUER).then(|| "http://localhost:8787/api/auth".to_owned())
        };
        assert_eq!(
            official_anchor_from(runtime, None, None, true)
                .unwrap()
                .issuer,
            "http://localhost:8787/api/auth"
        );
        // Plain http to anything else is never an official issuer.
        let remote = |name: &str| {
            (name == ENV_OFFICIAL_ISSUER).then(|| "http://id.example/api/auth".to_owned())
        };
        assert!(official_anchor_from(remote, None, None, true).is_none());
        assert!(official_anchor_from(
            |_| None,
            Some("http://localhost:8787/api/auth"),
            None,
            false
        )
        .is_none());
        assert!(!is_loopback_http("http://localhost.evil.example/"));
    }

    #[test]
    fn the_unverified_issuer_is_read_from_the_payload() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"iss":"https://id.cognia.cn/api/auth","sub":"usr_x"}"#);
        assert_eq!(
            unverified_issuer(&format!("e30.{payload}.sig")).as_deref(),
            Some("https://id.cognia.cn/api/auth")
        );
        assert_eq!(unverified_issuer("not-a-jwt"), None);
        assert_eq!(unverified_issuer("e30.!!!.sig"), None);
    }

    #[test]
    fn selection_picks_a_configured_anchor_and_nothing_else() {
        let anchors = vec![stored("https://logto.example/oidc"), official().unwrap()];
        let pick = |iss: &str| select_anchor(&anchors, iss, |anchor| anchor).map(|a| a.source);
        assert_eq!(
            pick("https://id.cognia.cn/api/auth/"),
            Some(AnchorSource::Official)
        );
        assert_eq!(
            pick("https://logto.example/oidc"),
            Some(AnchorSource::Stored)
        );
        assert_eq!(pick("https://attacker.example/oidc"), None);
    }

    #[test]
    fn the_official_anchor_is_trusted_alongside_the_chosen_deployment() {
        assert_eq!(
            sources(&trusted_anchors(none, None, official(), TTL)),
            [AnchorSource::Official]
        );
        let both = trusted_anchors(
            none,
            Some(stored("https://logto.example/oidc")),
            official(),
            TTL,
        );
        assert_eq!(
            sources(&both),
            [AnchorSource::Stored, AnchorSource::Official]
        );
        assert_eq!(both[0].1.issuer(), "https://logto.example/oidc");
        assert_eq!(both[1].1.issuer(), OFFICIAL_ISSUER_DEFAULT);
    }

    #[test]
    fn a_deployment_that_is_the_official_issuer_becomes_the_official_anchor() {
        let mut same = stored("https://id.cognia.cn/api/auth/");
        same.audience = "https://gateway-said-this".into();
        let anchors = trusted_anchors(none, Some(same), official(), TTL);
        assert_eq!(sources(&anchors), [AnchorSource::Official]);
        // The official spelling and audience, not the gateway's.
        assert_eq!(anchors[0].1.issuer(), OFFICIAL_ISSUER_DEFAULT);
        assert_eq!(anchors[0].0.audience, OFFICIAL_AUDIENCE_DEFAULT);
    }

    #[test]
    fn the_environment_is_the_only_anchor_of_a_headless_host() {
        let env = |name: &str| match name {
            oidc::ENV_ISSUER => Some("https://headless.example/api/auth".to_owned()),
            oidc::ENV_AUDIENCE => Some(" https://sync.example ".to_owned()),
            _ => None,
        };
        let anchors = trusted_anchors(
            env,
            Some(stored("https://logto.example/oidc")),
            official(),
            TTL,
        );
        assert_eq!(sources(&anchors), [AnchorSource::Env]);
        assert_eq!(anchors[0].0.issuer, "https://headless.example/api/auth");
        assert_eq!(anchors[0].0.audience, "https://sync.example");
    }

    #[tokio::test]
    async fn a_token_from_an_issuer_nobody_configured_gets_nothing() {
        let anchors = trusted_anchors(none, Some(stored("https://logto.example/oidc")), None, TTL);
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"iss":"https://attacker.example/oidc","sub":"usr_0123456789abcdef"}"#);
        let token = format!("e30.{payload}.sig");
        assert!(matches!(
            verify_person(&anchors, &token).await,
            Err(PersonVerifyError::UntrustedIssuer)
        ));
        assert!(matches!(
            verify_person(&anchors, "garbage").await,
            Err(PersonVerifyError::UntrustedIssuer)
        ));
        assert!(matches!(
            verify_person(&[], &token).await,
            Err(PersonVerifyError::NoAnchor)
        ));
    }

    /// A real issuer (wiremock discovery + JWKS) standing in for one anchor.
    async fn issuer_anchor(
        source: AnchorSource,
    ) -> (
        wiremock::MockServer,
        Vec<(TrustAnchor, Arc<OidcAuthenticator>)>,
    ) {
        // The JWKS fetch builds a managed client, which is fail-closed until a
        // proxy policy exists; tests opt into the direct one, as oidc.rs does.
        cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default())
            .expect("a default (off) policy always validates");
        let server = wiremock::MockServer::start().await;
        test_support::mount_lenient(&server).await;
        let anchor = TrustAnchor {
            issuer: server.uri(),
            audience: "https://sync.example".into(),
            source,
        };
        let config = OidcVerifierConfig::new(server.uri(), "https://sync.example", Vec::new());
        let verifier = Arc::new(OidcAuthenticator::new(config, TTL));
        (server, vec![(anchor, verifier)])
    }

    fn token(issuer: &str, sub: &str, organization: Option<&str>) -> String {
        let mut claims = test_support::claims(issuer, "https://sync.example");
        claims["sub"] = json!(sub);
        claims["organization_id"] = organization.map_or(serde_json::Value::Null, |o| json!(o));
        test_support::mint(claims, Some(test_support::TEST_KID), Algorithm::ES384)
    }

    #[tokio::test]
    async fn the_official_anchor_takes_its_subject_as_the_id() {
        let (server, anchors) = issuer_anchor(AnchorSource::Official).await;
        let person = verify_person(
            &anchors,
            &token(&server.uri(), "usr_0123456789abcdef0123456789abcdef", None),
        )
        .await
        .unwrap();
        assert_eq!(person.user_id, "usr_0123456789abcdef0123456789abcdef");
        assert_eq!(person.org_id, None);
    }

    #[tokio::test]
    async fn a_chosen_deployment_cannot_claim_an_official_id() {
        let (server, anchors) = issuer_anchor(AnchorSource::Stored).await;
        let subject = "usr_0123456789abcdef0123456789abcdef";
        let person = verify_person(&anchors, &token(&server.uri(), subject, None))
            .await
            .unwrap();
        assert_eq!(
            person.user_id,
            derive_identity_id("usr_", "user", &server.uri(), subject)
        );
    }

    #[tokio::test]
    async fn a_logto_organization_token_yields_both_derived_ids() {
        let (server, anchors) = issuer_anchor(AnchorSource::Stored).await;
        let person = verify_person(
            &anchors,
            &token(&server.uri(), "logto_ada", Some("org_tenant_1")),
        )
        .await
        .unwrap();
        assert_eq!(
            person.user_id,
            derive_identity_id("usr_", "user", &server.uri(), "logto_ada")
        );
        assert_eq!(
            person.org_id,
            Some(derive_identity_id(
                "org_",
                "org",
                &server.uri(),
                "org_tenant_1"
            ))
        );
    }

    #[tokio::test]
    async fn a_token_signed_for_another_audience_is_rejected() {
        let (server, anchors) = issuer_anchor(AnchorSource::Official).await;
        let mut claims = test_support::claims(&server.uri(), "https://other.example");
        claims["sub"] = json!("usr_0123456789abcdef0123456789abcdef");
        let forged = test_support::mint(claims, Some(test_support::TEST_KID), Algorithm::ES384);
        assert!(matches!(
            verify_person(&anchors, &forged).await,
            Err(PersonVerifyError::Rejected(_))
        ));
    }
}
