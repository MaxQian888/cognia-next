//! Trust anchors for a signed-in person, including the official Cognia
//! account (ADR-0215 §2, ADR-0149 §9).
//!
//! `account_bind_person` records which person a profile belongs to after the
//! renderer proves a sign-in with an access token. The host verifies that
//! token against an issuer it trusts on its own authority, never one the
//! caller names. Three sources can supply that issuer:
//!
//! - **Env**: `COGNIA_LOGTO_ISSUER` / `COGNIA_LOGTO_AUDIENCE` on a headless host;
//! - **Stored**: the deployment record `account_set_cloud_deployment` fetched
//!   itself from a gateway the person chose;
//! - **Official**: the official account's issuer, compiled into the build.
//!
//! The token's own (unverified) `iss` only *chooses among* these anchors; the
//! token is then verified against the chosen one, so naming an issuer nobody
//! configured gets the caller nothing.
//!
//! # The person's id
//!
//! A Logto subject is opaque, so the id is derived: `usr_` + the first 24 hex
//! characters of SHA-256(`user\n<issuer>\n<subject>`), identical to
//! `lib/identity/sign-in.ts`. The official issuer already mints `usr_` ids as
//! its subject (ADR-0149 §1), so for an `Oidc` anchor a subject that is a
//! valid user id IS the id. Both sides read
//! `fixtures/identity-id-vectors.json`, so they cannot drift apart.

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
/// What kind of issuer `COGNIA_LOGTO_ISSUER` names on a headless host (the
/// variable `cognia_companion::api::ENV_OIDC_ISSUER_KIND` documents).
pub const ENV_ISSUER_KIND: &str = "COGNIA_OIDC_ISSUER_KIND";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssuerKind {
    /// Self-hosted Logto: opaque subjects, organizations.
    Logto,
    /// A standards-only issuer whose subject is already a `usr_` id.
    Oidc,
}

impl IssuerKind {
    /// `COGNIA_OIDC_ISSUER_KIND` / the auth config's `oidc.issuerKind`.
    /// Anything other than `oidc` is Logto, the kind every deployment had
    /// before the field existed.
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(|value| value.trim().to_ascii_lowercase()) {
            Some(value) if value == "oidc" => IssuerKind::Oidc,
            _ => IssuerKind::Logto,
        }
    }
}

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
    pub kind: IssuerKind,
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
/// the desktop trust another issuer.
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
        kind: IssuerKind::Oidc,
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

/// The anchor whose issuer the token names, among the configured ones only.
/// A trailing slash is not a different issuer.
pub fn select_anchor<'a>(
    anchors: &'a [TrustAnchor],
    unverified_iss: &str,
) -> Option<&'a TrustAnchor> {
    let wanted = unverified_iss.trim_end_matches('/');
    anchors
        .iter()
        .find(|anchor| anchor.issuer.trim_end_matches('/') == wanted)
}

/// Every anchor a host trusts, each with its verifier: the environment when
/// it configures an issuer (a headless host), else the deployment the person
/// chose (`stored`), plus `official` unless it is already one of them.
pub fn trusted_anchors(
    vars: impl Fn(&str) -> Option<String>,
    stored: Option<TrustAnchor>,
    official: Option<TrustAnchor>,
    jwks_ttl: Duration,
) -> Vec<(TrustAnchor, Arc<OidcAuthenticator>)> {
    let verified = |anchor: TrustAnchor| {
        let config =
            OidcVerifierConfig::new(anchor.issuer.clone(), anchor.audience.clone(), Vec::new());
        (anchor, Arc::new(OidcAuthenticator::new(config, jwks_ttl)))
    };
    let mut anchors = Vec::new();
    if let Some(from_env) = OidcAuthenticator::from_vars(&vars) {
        let anchor = TrustAnchor {
            issuer: from_env.issuer().to_owned(),
            audience: vars(oidc::ENV_AUDIENCE)
                .unwrap_or_default()
                .trim()
                .to_owned(),
            kind: IssuerKind::parse(vars(ENV_ISSUER_KIND).as_deref()),
            source: AnchorSource::Env,
        };
        anchors.push((anchor, Arc::new(from_env)));
    } else if let Some(stored) = stored {
        anchors.push(verified(stored));
    }
    if let Some(official) = official {
        let configured: Vec<TrustAnchor> =
            anchors.iter().map(|(anchor, _)| anchor.clone()).collect();
        if select_anchor(&configured, &official.issuer).is_none() {
            anchors.push(verified(official));
        }
    }
    anchors
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

/// The person's id for a verified `(anchor, subject)`.
pub fn expected_user_id(kind: IssuerKind, issuer: &str, subject: &str) -> String {
    if kind == IssuerKind::Oidc && UserId::parse(subject).is_ok() {
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
    let wanted = claimed.trim_end_matches('/');
    let (anchor, verifier) = anchors
        .iter()
        .find(|(anchor, _)| anchor.issuer.trim_end_matches('/') == wanted)
        .ok_or(PersonVerifyError::UntrustedIssuer)?;
    let claims = verifier.authenticate(token).await?;
    let issuer = verifier.issuer();
    Ok(VerifiedPerson {
        user_id: expected_user_id(anchor.kind, issuer, &claims.sub),
        org_id: claims
            .organization_id
            .as_deref()
            .map(|organization| derive_identity_id("org_", "org", issuer, organization)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vector {
        issuer: String,
        subject: String,
        #[serde(rename = "issuerKind")]
        issuer_kind: String,
        #[serde(rename = "userId")]
        user_id: String,
    }

    #[test]
    fn user_ids_match_the_shared_vectors() {
        let raw = include_str!("../fixtures/identity-id-vectors.json");
        let vectors: Vec<Vector> = serde_json::from_str(raw).unwrap();
        assert!(vectors.len() >= 4);
        for vector in vectors {
            let kind = IssuerKind::parse(Some(&vector.issuer_kind));
            assert_eq!(
                expected_user_id(kind, &vector.issuer, &vector.subject),
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

    #[tokio::test]
    async fn a_token_from_an_issuer_nobody_configured_gets_nothing() {
        let anchors = trusted_anchors(|_| None, Some(stored()), None, Duration::from_secs(600));
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

    #[test]
    fn an_oidc_subject_that_is_not_a_user_id_is_still_derived() {
        let id = expected_user_id(
            IssuerKind::Oidc,
            "https://id.test/api/auth",
            "opaque-subject",
        );
        assert!(id.starts_with("usr_") && id.len() == 28, "{id}");
        // A Logto subject shaped like a user id is never trusted as one.
        assert_ne!(
            expected_user_id(
                IssuerKind::Logto,
                "https://logto.test/oidc",
                "usr_0123456789abcdef"
            ),
            "usr_0123456789abcdef"
        );
    }

    #[test]
    fn the_kind_defaults_to_logto() {
        assert_eq!(IssuerKind::parse(None), IssuerKind::Logto);
        assert_eq!(IssuerKind::parse(Some("logto")), IssuerKind::Logto);
        assert_eq!(IssuerKind::parse(Some("better-auth")), IssuerKind::Logto);
        assert_eq!(IssuerKind::parse(Some(" OIDC ")), IssuerKind::Oidc);
    }

    #[test]
    fn the_official_anchor_defaults_to_production() {
        let anchor = official_anchor_from(|_| None, None, None, false).unwrap();
        assert_eq!(anchor.issuer, OFFICIAL_ISSUER_DEFAULT);
        assert_eq!(anchor.audience, OFFICIAL_AUDIENCE_DEFAULT);
        assert_eq!(anchor.kind, IssuerKind::Oidc);
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

    fn stored() -> TrustAnchor {
        TrustAnchor {
            issuer: "https://logto.example/oidc".into(),
            audience: "https://api.example".into(),
            kind: IssuerKind::Logto,
            source: AnchorSource::Stored,
        }
    }

    fn sources(anchors: &[(TrustAnchor, Arc<OidcAuthenticator>)]) -> Vec<AnchorSource> {
        anchors.iter().map(|(anchor, _)| anchor.source).collect()
    }

    #[test]
    fn the_official_anchor_is_trusted_alongside_the_chosen_deployment() {
        let ttl = Duration::from_secs(600);
        let official = official_anchor_from(|_| None, None, None, false);
        let none = |_: &str| None::<String>;
        assert_eq!(
            sources(&trusted_anchors(none, None, official.clone(), ttl)),
            [AnchorSource::Official]
        );

        let both = trusted_anchors(none, Some(stored()), official.clone(), ttl);
        assert_eq!(
            sources(&both),
            [AnchorSource::Stored, AnchorSource::Official]
        );
        assert_eq!(both[0].1.issuer(), "https://logto.example/oidc");
        assert_eq!(both[1].1.issuer(), OFFICIAL_ISSUER_DEFAULT);

        // A deployment that IS the official issuer is not listed twice.
        let mut same = official.clone().unwrap();
        same.source = AnchorSource::Stored;
        same.issuer.push('/');
        assert_eq!(
            sources(&trusted_anchors(none, Some(same), official, ttl)),
            [AnchorSource::Stored]
        );
    }

    #[test]
    fn the_environment_replaces_the_stored_deployment() {
        let env = |name: &str| match name {
            oidc::ENV_ISSUER => Some("https://headless.example/api/auth".to_owned()),
            oidc::ENV_AUDIENCE => Some(" https://sync.example ".to_owned()),
            ENV_ISSUER_KIND => Some("oidc".to_owned()),
            _ => None,
        };
        let anchors = trusted_anchors(env, Some(stored()), None, Duration::from_secs(600));
        assert_eq!(sources(&anchors), [AnchorSource::Env]);
        assert_eq!(anchors[0].0.issuer, "https://headless.example/api/auth");
        assert_eq!(anchors[0].0.audience, "https://sync.example");
        assert_eq!(anchors[0].0.kind, IssuerKind::Oidc);
    }

    #[test]
    fn selection_picks_a_configured_anchor_and_nothing_else() {
        let anchors = vec![
            stored(),
            official_anchor_from(|_| None, None, None, false).unwrap(),
        ];
        assert_eq!(
            select_anchor(&anchors, "https://id.cognia.cn/api/auth/")
                .unwrap()
                .source,
            AnchorSource::Official
        );
        assert_eq!(
            select_anchor(&anchors, "https://logto.example/oidc")
                .unwrap()
                .kind,
            IssuerKind::Logto
        );
        assert!(select_anchor(&anchors, "https://attacker.example/oidc").is_none());
    }
}
