//! The desktop's trust anchor for cloud sign-in (ADR-0149 section 9).
//!
//! `account_bind_person` verifies a Logto access token before it records the
//! person on the host. That verification needs an issuer and an audience, and
//! a headless deployment gets them from its environment. The desktop app has no
//! such environment: nobody exports `COGNIA_LOGTO_ISSUER` on a laptop, so the
//! host refused every binding and `host_bindings.user_id` stayed NULL on every
//! desktop. The device attribution of ADR-0149 section 5 never happened there.
//!
//! This module gives the desktop the same anchor from a different source. The
//! person names a gateway in Settings, this process fetches that gateway's
//! `/api/auth/config` itself (never trusting the renderer's copy of it), and
//! stores the issuer and audience it answered with. From then on the token
//! verifier is built from the stored record exactly as the headless one is
//! built from the environment.
//!
//! # Why the renderer cannot simply hand the issuer over
//!
//! A caller that supplies the trust anchor is verifying a token against
//! itself. The record here is written only by a command that fetched the
//! configuration over TLS from an address the person typed, with the
//! certificate pinned when the host is self-signed, and the environment still
//! wins when it is set. That is the difference between a configuration and an
//! argument.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::companion_api::oidc::{OidcAuthenticator, OidcVerifierConfig};

const CONFIG_FILE: &str = "cloud-deployment.json";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const JWKS_TTL: Duration = Duration::from_secs(600);

/// What the host remembers about the deployment it verifies tokens against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDeploymentConfig {
    /// Normalized gateway origin (scheme, host, port, optional path prefix).
    pub gateway_url: String,
    /// SPKI SHA-256 of a self-signed gateway, lowercase hex. `None` for a
    /// publicly trusted certificate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    /// The Logto issuer the gateway announced, verbatim.
    pub issuer: String,
    /// The API resource the gateway announced, verbatim.
    pub audience: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_service_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_origin: Option<String>,
    /// Unix seconds.
    pub saved_at: i64,
}

/// The slice of `GET /api/auth/config` this module reads. Additive fields the
/// gateway adds later are ignored on purpose.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAuthConfig {
    pub deployment_mode: String,
    #[serde(default)]
    pub oidc: Option<RemoteOidcConfig>,
    #[serde(default)]
    pub collaboration: Option<RemoteCollaborationConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOidcConfig {
    pub issuer: String,
    pub audience: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCollaborationConfig {
    pub service_url: String,
    #[serde(default)]
    pub web_origin: Option<String>,
}

pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cognia").join(CONFIG_FILE)
}

/// Read the stored record. Unreadable is the same as absent: the only power
/// of this file is to make the host trust an issuer, and a torn write must
/// not leave it trusting half of one.
pub fn load(data_dir: Option<&Path>) -> Option<CloudDeploymentConfig> {
    let path = config_path(data_dir?);
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn save(data_dir: Option<&Path>, config: &CloudDeploymentConfig) -> Result<(), String> {
    let data_dir = data_dir.ok_or("this host has no data directory")?;
    let path = config_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(config).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perms) = std::fs::metadata(&path).map(|m| m.permissions()) {
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(&path, perms);
        }
    }
    Ok(())
}

pub fn clear(data_dir: Option<&Path>) -> Result<(), String> {
    let Some(data_dir) = data_dir else {
        return Ok(());
    };
    match std::fs::remove_file(config_path(data_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove cloud deployment: {error}")),
    }
}

/// Reject anything but an https origin, or plaintext http on a loopback
/// address when `allow_loopback_http` (debug builds and tests).
///
/// Returns the normalized origin: no query, no fragment, no credentials, no
/// trailing slash. The path prefix survives because a deployment may mount
/// the gateway under one.
pub fn validate_gateway_url(raw: &str, allow_loopback_http: bool) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("a gateway address is required".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|error| format!("gateway address: {error}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "gateway address has no host".to_owned())?;
    match parsed.scheme() {
        "https" => {}
        "http" => {
            let loopback = host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .map(|ip| ip.is_loopback())
                    .unwrap_or(false);
            if !(allow_loopback_http && loopback) {
                return Err("the gateway address must use https".into());
            }
        }
        other => return Err(format!("the gateway address must use https, not {other}")),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("the gateway address must not carry credentials".into());
    }
    let mut normalized = parsed;
    normalized.set_query(None);
    normalized.set_fragment(None);
    Ok(normalized.to_string().trim_end_matches('/').to_owned())
}

/// Lowercase hex, separators dropped. `Ok(None)` for an empty value.
pub fn normalize_fingerprint(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let compact: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if compact.is_empty() {
        return Ok(None);
    }
    if compact.len() != 64 || !compact.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("the certificate fingerprint must be 64 hex characters (SHA-256)".into());
    }
    Ok(Some(compact))
}

/// A certificate verifier that accepts exactly one server key: the one whose
/// SPKI SHA-256 the person copied from the host. Chain, name and expiry are
/// not consulted, which is the whole point of pinning a self-signed host, and
/// which is why this verifier is only ever built with a fingerprint.
#[derive(Debug)]
struct SpkiPinVerifier {
    expected: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for SpkiPinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let actual = crate::companion_api::tls::spki_fingerprint_from_der(end_entity.as_ref())
            .map_err(|error| rustls::Error::General(format!("certificate: {error}")))?;
        if actual.eq_ignore_ascii_case(&self.expected) {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "the gateway's certificate does not match the pinned fingerprint".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn pinned_tls_config(fingerprint: &str) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(SpkiPinVerifier {
        expected: fingerprint.to_owned(),
        provider: Arc::clone(&provider),
    });
    rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("tls: {error}"))
        .map(|builder| {
            builder
                .dangerous()
                .with_custom_certificate_verifier(verifier)
                .with_no_client_auth()
        })
}

/// Fetch the gateway's public sign-in configuration.
///
/// Redirects are not followed: a gateway that answers with one is not the
/// gateway the person named, and following it would let a captive portal or a
/// misconfigured proxy name the issuer.
pub async fn fetch_auth_config(
    gateway_url: &str,
    fingerprint: Option<&str>,
) -> Result<RemoteAuthConfig, String> {
    let endpoint = format!("{gateway_url}/api/auth/config");
    let mut builder = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(fingerprint) = fingerprint {
        builder = builder.use_preconfigured_tls(pinned_tls_config(fingerprint)?);
    }
    let client = crate::proxy_config::managed_client(builder, &endpoint)
        .map_err(|error| format!("http client: {error}"))?;
    let response = client
        .get(&endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("could not reach {endpoint}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{endpoint} answered {status}"));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("reading {endpoint}: {error}"))?;
    parse_auth_config(&body)
}

pub fn parse_auth_config(body: &[u8]) -> Result<RemoteAuthConfig, String> {
    serde_json::from_slice(body).map_err(|error| format!("auth config is malformed: {error}"))
}

/// Turn a gateway answer into the record to store, refusing anything that is
/// not a multi-tenant deployment with an identity provider.
pub fn config_from_remote(
    gateway_url: String,
    fingerprint: Option<String>,
    remote: RemoteAuthConfig,
    now: i64,
) -> Result<CloudDeploymentConfig, String> {
    if remote.deployment_mode != "multi-tenant" {
        return Err(format!(
            "the gateway runs in {} mode and has no cloud account to sign in to",
            remote.deployment_mode
        ));
    }
    let oidc = remote
        .oidc
        .ok_or("the gateway announces no identity provider")?;
    let issuer = oidc.issuer.trim().to_owned();
    let audience = oidc.audience.trim().to_owned();
    if issuer.is_empty() || audience.is_empty() {
        return Err("the gateway announced an empty issuer or audience".into());
    }
    if !issuer.starts_with("https://") && !issuer.starts_with("http://") {
        return Err("the announced issuer is not a URL".into());
    }
    let (collaboration_service_url, web_origin) = match remote.collaboration {
        Some(collab) => (
            Some(collab.service_url).filter(|value| !value.trim().is_empty()),
            collab.web_origin.filter(|value| !value.trim().is_empty()),
        ),
        None => (None, None),
    };
    Ok(CloudDeploymentConfig {
        gateway_url,
        fingerprint,
        issuer,
        audience,
        collaboration_service_url,
        web_origin,
        saved_at: now,
    })
}

/// The verifier `account_bind_person` uses: the environment when it is set
/// (a headless host), else the stored deployment, else nothing.
pub fn resolve_verifier(data_dir: Option<&Path>) -> Option<Arc<OidcAuthenticator>> {
    if let Some(from_env) = OidcAuthenticator::from_env() {
        return Some(from_env);
    }
    let stored = load(data_dir)?;
    Some(Arc::new(OidcAuthenticator::new(
        OidcVerifierConfig::new(stored.issuer, stored.audience, Vec::new()),
        JWKS_TTL,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cognia-cloud-deployment-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample() -> CloudDeploymentConfig {
        CloudDeploymentConfig {
            gateway_url: "https://cloud.example".into(),
            fingerprint: Some("ab".repeat(32)),
            issuer: "https://auth.example/oidc".into(),
            audience: "https://cloud.example/api".into(),
            collaboration_service_url: Some("https://cloud.example/collab".into()),
            web_origin: Some("https://cloud.example".into()),
            saved_at: 42,
        }
    }

    #[test]
    fn a_missing_or_torn_file_reads_as_nothing() {
        let dir = temp_dir("missing");
        assert_eq!(load(Some(&dir)), None);
        std::fs::create_dir_all(dir.join("cognia")).unwrap();
        std::fs::write(config_path(&dir), b"{not json").unwrap();
        assert_eq!(load(Some(&dir)), None);
        assert_eq!(load(None), None);
    }

    #[test]
    fn saves_private_and_round_trips_and_clears() {
        let dir = temp_dir("roundtrip");
        save(Some(&dir), &sample()).unwrap();
        assert_eq!(load(Some(&dir)), Some(sample()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(config_path(&dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        clear(Some(&dir)).unwrap();
        assert_eq!(load(Some(&dir)), None);
        // Clearing twice is not an error, and neither is clearing nowhere.
        clear(Some(&dir)).unwrap();
        clear(None).unwrap();
        assert!(save(None, &sample()).is_err());
    }

    #[test]
    fn gateway_url_must_be_https_unless_loopback_is_allowed() {
        assert_eq!(
            validate_gateway_url(" https://cloud.example:8443/prefix/?x=1#y ", false).unwrap(),
            "https://cloud.example:8443/prefix"
        );
        assert!(validate_gateway_url("http://cloud.example", false).is_err());
        assert!(validate_gateway_url("http://127.0.0.1:27890", false).is_err());
        assert_eq!(
            validate_gateway_url("http://127.0.0.1:27890/", true).unwrap(),
            "http://127.0.0.1:27890"
        );
        assert_eq!(
            validate_gateway_url("http://localhost:3000", true).unwrap(),
            "http://localhost:3000"
        );
        assert!(validate_gateway_url("http://10.0.0.5", true).is_err());
        assert!(validate_gateway_url("ftp://cloud.example", true).is_err());
        assert!(validate_gateway_url("https://user:pw@cloud.example", true).is_err());
        assert!(validate_gateway_url("", true).is_err());
        assert!(validate_gateway_url("not a url", true).is_err());
    }

    #[test]
    fn fingerprints_are_normalized_or_refused() {
        let spaced = format!("AB:{}AB", "ab:".repeat(30));
        assert_eq!(
            normalize_fingerprint(Some(&spaced)).unwrap(),
            Some("ab".repeat(32))
        );
        assert_eq!(normalize_fingerprint(Some("  ")).unwrap(), None);
        assert_eq!(normalize_fingerprint(None).unwrap(), None);
        assert!(normalize_fingerprint(Some("abcd")).is_err());
        assert!(normalize_fingerprint(Some(&"zz".repeat(32))).is_err());
    }

    #[test]
    fn parses_the_gateway_answer_and_ignores_fields_it_does_not_know() {
        let body = br#"{
            "configVersion": 3,
            "deploymentMode": "multi-tenant",
            "hostId": "h",
            "oidc": {"issuer": "https://auth.example/oidc", "audience": "https://api", "webClientId": "w", "scopes": [], "socialProviders": [], "callbackModes": []},
            "signaling": {"url": "wss://x"},
            "collaboration": {"serviceUrl": "https://cloud.example/collab", "registrationPolicy": "bootstrap-then-invite", "webOrigin": "https://cloud.example"}
        }"#;
        let remote = parse_auth_config(body).unwrap();
        let config = config_from_remote("https://cloud.example".into(), None, remote, 7).unwrap();
        assert_eq!(config.issuer, "https://auth.example/oidc");
        assert_eq!(config.audience, "https://api");
        assert_eq!(
            config.collaboration_service_url.as_deref(),
            Some("https://cloud.example/collab")
        );
        assert_eq!(config.web_origin.as_deref(), Some("https://cloud.example"));
        assert_eq!(config.saved_at, 7);
        assert!(parse_auth_config(b"nope").is_err());
    }

    #[test]
    fn refuses_a_single_user_gateway_and_a_gateway_without_oidc() {
        let single = parse_auth_config(
            br#"{"deploymentMode": "single-user", "hostId": "h", "signaling": {}}"#,
        )
        .unwrap();
        let error = config_from_remote("https://x".into(), None, single, 0).unwrap_err();
        assert!(error.contains("single-user"), "{error}");

        let no_oidc = parse_auth_config(
            br#"{"deploymentMode": "multi-tenant", "hostId": "h", "signaling": {}}"#,
        )
        .unwrap();
        assert!(config_from_remote("https://x".into(), None, no_oidc, 0).is_err());

        let blank = parse_auth_config(
            br#"{"deploymentMode": "multi-tenant", "oidc": {"issuer": " ", "audience": "a"}}"#,
        )
        .unwrap();
        assert!(config_from_remote("https://x".into(), None, blank, 0).is_err());
    }

    #[test]
    fn the_pin_accepts_only_the_certificate_it_was_given() {
        use rustls::client::danger::ServerCertVerifier;
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["cloud.example".to_owned()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let der = rustls::pki_types::CertificateDer::from(cert.der().to_vec());
        let expected = crate::companion_api::tls::spki_fingerprint_from_der(der.as_ref()).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let name = rustls::pki_types::ServerName::try_from("cloud.example").unwrap();
        let now = rustls::pki_types::UnixTime::now();

        let matching = SpkiPinVerifier {
            expected: expected.to_uppercase(),
            provider: Arc::clone(&provider),
        };
        assert!(matching
            .verify_server_cert(&der, &[], &name, &[], now)
            .is_ok());

        let other = SpkiPinVerifier {
            expected: "00".repeat(32),
            provider,
        };
        assert!(other
            .verify_server_cert(&der, &[], &name, &[], now)
            .is_err());
        assert!(pinned_tls_config(&expected).is_ok());
    }

    #[test]
    fn the_verifier_comes_from_the_stored_record_when_the_environment_is_silent() {
        // The environment is process-wide, so this test only holds when no
        // headless configuration leaks in from the shell running cargo.
        if std::env::var("COGNIA_LOGTO_ISSUER").is_ok() {
            return;
        }
        let dir = temp_dir("verifier");
        assert!(resolve_verifier(Some(&dir)).is_none());
        save(Some(&dir), &sample()).unwrap();
        let verifier = resolve_verifier(Some(&dir)).unwrap();
        assert_eq!(verifier.issuer(), "https://auth.example/oidc");
    }
}
