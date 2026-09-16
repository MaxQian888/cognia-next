//! Reading image metadata from an OCI registry (ADR-0182).
//!
//! When an admin adds a catalog entry, or a repository declaration names an
//! image, the server reads what the image *is* before anything runs it: the
//! digest a tag currently points at, the platforms it offers, and each
//! platform's configured `User` and `Env`. The declared user decides what the
//! sandbox runs as (ADR-0183); the platforms decide where it can run.
//!
//! The protocol logic — challenge-driven auth, redirects, digest checks —
//! lives here over a [`RegistryTransport`], so it is tested without a network.
//! `http::ReqwestTransport` (feature `registry`) is the production transport:
//! it goes through the Host's proxy policy and pins DNS.
//!
//! # What this refuses to contact
//!
//! The registry host is operator-controlled: callers only get here for an
//! image the baseline allowlist permits. The URLs a registry hands back are
//! not — a token realm and a blob redirect are chosen by whoever answers. So
//! every hop must be HTTPS (plain HTTP only on the registry's own host when
//! its rule says `insecure`), carry no userinfo, and never be a cloud metadata
//! address; loopback only when the registry itself is on loopback. The HTTP
//! transport repeats the address checks after DNS resolution.
//!
//! Credentials are answered to challenges only, never sent up front, and a
//! redirect to a different host (a CDN presigned URL) drops `Authorization`.

pub mod auth;
#[cfg(feature = "registry")]
pub mod http;
pub mod manifest;

use std::future::Future;
use std::net::IpAddr;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::image::{ImageReference, DEFAULT_REGISTRY};
pub use auth::{
    parse_challenges, Challenge, RegistryCredential, RegistryCredentials, REGISTRY_AUTH_FILE_ENV,
};
pub use manifest::{ImageConfig, ParsedManifest, Platform};

/// Docker Hub's API host; `docker.io` itself serves no `/v2/`.
pub const DOCKER_HUB_API_HOST: &str = "registry-1.docker.io";
/// The OCI distribution spec's recommended manifest ceiling.
pub const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_CONFIG_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TOKEN_BYTES: usize = 256 * 1024;
pub const MAX_REDIRECTS: usize = 5;
/// `client_id` sent with an OAuth2 refresh-token exchange.
const OAUTH_CLIENT_ID: &str = "cognia";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RegistryError {
    #[error("registry {registry} is unreachable: {message}")]
    Unreachable { registry: String, message: String },
    #[error("refusing to contact {url}: {reason}")]
    EndpointRefused { url: String, reason: String },
    #[error("registry {registry} refused the credentials, or needs some")]
    Unauthorized { registry: String },
    #[error("registry {registry} denied access to {repository}")]
    Forbidden {
        registry: String,
        repository: String,
    },
    #[error("{reference} does not exist")]
    NotFound { reference: String },
    #[error("registry {registry} is rate limiting requests")]
    RateLimited {
        registry: String,
        retry_after_secs: Option<u64>,
    },
    #[error("registry answered {status} for {url}")]
    UnexpectedStatus { status: u16, url: String },
    #[error("invalid registry response: {message}")]
    ResponseInvalid { message: String },
    #[error("registry response is larger than {limit} bytes")]
    ResponseTooLarge { limit: usize },
    #[error("content digest {actual} does not match {expected}")]
    DigestMismatch { expected: String, actual: String },
    #[error("{reference} offers none of the platforms sandboxes run on")]
    PlatformUnavailable { reference: String },
    #[error(
        "the credential for {registry} lives in a credential helper, which the server cannot run"
    )]
    CredentialHelperUnsupported { registry: String },
    #[error("registry auth file: {message}")]
    AuthFile { message: String },
}

impl RegistryError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreachable { .. } => "registry_unreachable",
            Self::EndpointRefused { .. } => "registry_endpoint_refused",
            Self::Unauthorized { .. } => "registry_unauthorized",
            Self::Forbidden { .. } => "registry_forbidden",
            Self::NotFound { .. } => "registry_not_found",
            Self::RateLimited { .. } => "registry_rate_limited",
            Self::UnexpectedStatus { .. } => "registry_unexpected_status",
            Self::ResponseInvalid { .. } => "registry_response_invalid",
            Self::ResponseTooLarge { .. } => "registry_response_too_large",
            Self::DigestMismatch { .. } => "registry_digest_mismatch",
            Self::PlatformUnavailable { .. } => "registry_platform_unavailable",
            Self::CredentialHelperUnsupported { .. } => "registry_credential_helper_unsupported",
            Self::AuthFile { .. } => "registry_auth_file_invalid",
        }
    }

    /// A fault of the registry or the network, not of the reference or the
    /// configuration: worth retrying later.
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::Unreachable { .. }
                | Self::RateLimited { .. }
                | Self::UnexpectedStatus {
                    status: 500..=599,
                    ..
                }
        )
    }
}

/// Which registry to talk to and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryEndpoint {
    /// As [`ImageReference`] normalises it (`docker.io`, `ghcr.io`, `host:5000`).
    pub registry: String,
    /// From the matching allowlist rule (`EnvironmentBaseline::registry_is_insecure`).
    pub insecure: bool,
}

impl RegistryEndpoint {
    fn api_authority(&self) -> String {
        if self.registry.eq_ignore_ascii_case(DEFAULT_REGISTRY) {
            DOCKER_HUB_API_HOST.to_string()
        } else {
            self.registry.to_ascii_lowercase()
        }
    }

    fn api_base(&self) -> Result<Url, RegistryError> {
        let scheme = if self.insecure { "http" } else { "https" };
        let raw = format!("{scheme}://{}/", self.api_authority());
        Url::parse(&raw).map_err(|error| RegistryError::EndpointRefused {
            url: raw,
            reason: error.to_string(),
        })
    }
}

/// `host[:port]` as it appears in a URL (IPv6 bracketed, port only when
/// explicit and not the scheme default).
fn authority(url: &Url) -> Option<String> {
    let host = match url.host()? {
        Host::Domain(domain) => domain.to_ascii_lowercase(),
        Host::Ipv4(ip) => ip.to_string(),
        Host::Ipv6(ip) => format!("[{ip}]"),
    };
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// The address a URL names literally, if it is an IP literal.
pub(crate) fn literal_ip(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(ip) => Some(IpAddr::V4(ip)),
        Host::Ipv6(ip) => Some(IpAddr::V6(ip)),
        Host::Domain(_) => None,
    }
}

/// Refuses cloud metadata addresses always, loopback/unspecified unless
/// `allow_loopback`. IPv4-mapped IPv6 is judged as its IPv4 address.
pub(crate) fn check_address(
    url: &Url,
    ip: IpAddr,
    allow_loopback: bool,
) -> Result<(), RegistryError> {
    let ip = match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    };
    let refuse = |reason: &str| {
        Err(RegistryError::EndpointRefused {
            url: url.to_string(),
            reason: reason.to_string(),
        })
    };
    if cognia_net::egress::is_metadata_ip(&ip) {
        return refuse("it is a cloud metadata address");
    }
    if (ip.is_loopback() || ip.is_unspecified()) && !allow_loopback {
        return refuse("it is a loopback address and the registry is not");
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryRequest {
    pub method: HttpMethod,
    pub url: Url,
    /// Lowercase names.
    pub headers: Vec<(String, String)>,
    /// `(content-type, bytes)`.
    pub body: Option<(String, Vec<u8>)>,
    /// The transport stops reading and fails past this many body bytes.
    pub max_body_bytes: usize,
    /// True only for a request to a registry that is itself on loopback (a
    /// local development registry). Private ranges are always allowed — VPC
    /// registries live there; metadata addresses never are.
    pub allow_loopback: bool,
}

impl RegistryRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryResponse {
    pub status: u16,
    /// Lowercase names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl RegistryResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// One HTTP exchange; redirects are returned, not followed.
pub trait RegistryTransport {
    fn send(
        &self,
        request: RegistryRequest,
    ) -> impl Future<Output = Result<RegistryResponse, RegistryError>> + Send;
}

/// Everything read about one image; cached per digest (`probe_cache`) and
/// shown in the catalog editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ImageMetadata {
    pub registry: String,
    pub repository: String,
    /// What the reference resolved to: the index digest for a multi-platform
    /// image, the manifest digest otherwise. This is what a catalog entry pins.
    pub digest: String,
    pub media_type: String,
    /// In the order the caller asked for them.
    pub platforms: Vec<PlatformImage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct PlatformImage {
    pub platform: Platform,
    pub manifest_digest: String,
    pub config_digest: String,
    /// The config's `User`; absent means root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub env: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
}

/// Platforms of one image that declare different users.
pub type UserDisagreement<'a> = Vec<(&'a Platform, Option<&'a str>)>;

impl ImageMetadata {
    /// The user every platform agrees on, for `CatalogEntry.imageUser`. When
    /// they disagree the platforms are returned so the catalog editor can show
    /// them instead of guessing.
    pub fn common_user(&self) -> Result<Option<&str>, UserDisagreement<'_>> {
        let first = self
            .platforms
            .first()
            .and_then(|image| image.user.as_deref());
        if self
            .platforms
            .iter()
            .all(|image| image.user.as_deref() == first)
        {
            Ok(first)
        } else {
            Err(self
                .platforms
                .iter()
                .map(|image| (&image.platform, image.user.as_deref()))
                .collect())
        }
    }
}

pub struct RegistryClient<T> {
    transport: T,
    credentials: RegistryCredentials,
}

impl<T: RegistryTransport + Sync> RegistryClient<T> {
    pub fn new(transport: T, credentials: RegistryCredentials) -> Self {
        Self {
            transport,
            credentials,
        }
    }

    /// Resolves `reference` and reads the config of each `wanted` platform it
    /// offers. A digest reference is verified against the bytes served; a tag
    /// resolves to the digest of the bytes served.
    pub async fn fetch_metadata(
        &self,
        endpoint: &RegistryEndpoint,
        reference: &ImageReference,
        wanted: &[Platform],
    ) -> Result<ImageMetadata, RegistryError> {
        let credential = self.credentials.credential_for(&endpoint.registry)?;
        let base = endpoint.api_base()?;
        let registry_on_loopback = match base.host() {
            Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        };
        let mut session = Session {
            transport: &self.transport,
            endpoint,
            base,
            repository: &reference.repository,
            credential,
            authorization: None,
            registry_on_loopback,
        };

        let target = reference
            .digest
            .clone()
            .or_else(|| reference.tag.clone())
            .unwrap_or_else(|| "latest".into());
        let top = session.get_manifest(&target).await?;
        if let Some(expected) = &reference.digest {
            manifest::verify_content(expected, None, &top.body)?;
        }
        let digest = manifest::sha256_digest(&top.body);
        let parsed = manifest::parse_manifest(top.content_type.as_deref(), &top.body)?;
        let media_type = parsed.media_type().to_string();

        let mut platforms: Vec<PlatformImage> = Vec::new();
        match parsed {
            ParsedManifest::Index { manifests, .. } => {
                for want in wanted {
                    let Some((descriptor, offered)) = manifests.iter().find_map(|descriptor| {
                        let offered = Platform::from(descriptor.platform.as_ref()?);
                        want.accepts(&offered).then_some((descriptor, offered))
                    }) else {
                        continue;
                    };
                    if platforms.iter().any(|image| image.platform == offered) {
                        continue;
                    }
                    let child = session.get_manifest(&descriptor.digest).await?;
                    manifest::verify_content(
                        &descriptor.digest,
                        Some(descriptor.size),
                        &child.body,
                    )?;
                    let ParsedManifest::Image { config, .. } =
                        manifest::parse_manifest(child.content_type.as_deref(), &child.body)?
                    else {
                        return Err(RegistryError::ResponseInvalid {
                            message: format!("{} is an index inside an index", descriptor.digest),
                        });
                    };
                    let image = session.read_config(&descriptor.digest, &config).await?;
                    // The index's platform is what selection matched on.
                    platforms.push(PlatformImage {
                        platform: offered,
                        ..image
                    });
                }
            }
            ParsedManifest::Image { config, .. } => {
                let image = session.read_config(&digest, &config).await?;
                if wanted.iter().any(|want| want.accepts(&image.platform)) {
                    platforms.push(image);
                }
            }
        }

        if platforms.is_empty() {
            return Err(RegistryError::PlatformUnavailable {
                reference: format!("{}/{}@{digest}", endpoint.registry, reference.repository),
            });
        }
        Ok(ImageMetadata {
            registry: endpoint.registry.clone(),
            repository: reference.repository.clone(),
            digest,
            media_type,
            platforms,
        })
    }
}

struct Fetched {
    content_type: Option<String>,
    body: Vec<u8>,
}

struct Session<'a, T> {
    transport: &'a T,
    endpoint: &'a RegistryEndpoint,
    base: Url,
    repository: &'a str,
    credential: Option<RegistryCredential>,
    /// The `Authorization` value earned by answering a challenge.
    authorization: Option<String>,
    registry_on_loopback: bool,
}

impl<T: RegistryTransport + Sync> Session<'_, T> {
    async fn get_manifest(&mut self, reference: &str) -> Result<Fetched, RegistryError> {
        let url = self.api_url(&format!("manifests/{reference}"))?;
        let accept = vec![("accept".to_string(), manifest::manifest_accept())];
        let response = self
            .get_authorized(url, accept, MAX_MANIFEST_BYTES)
            .await
            .map_err(|error| match error {
                RegistryError::NotFound { .. } => RegistryError::NotFound {
                    reference: format!(
                        "{}/{}:{reference}",
                        self.endpoint.registry, self.repository
                    ),
                },
                other => other,
            })?;
        Ok(Fetched {
            content_type: response.header("content-type").map(str::to_string),
            body: response.body,
        })
    }

    async fn read_config(
        &mut self,
        manifest_digest: &str,
        config: &manifest::Descriptor,
    ) -> Result<PlatformImage, RegistryError> {
        if config.size > MAX_CONFIG_BYTES as i64 {
            return Err(RegistryError::ResponseTooLarge {
                limit: MAX_CONFIG_BYTES,
            });
        }
        let url = self.api_url(&format!("blobs/{}", config.digest))?;
        let response = self
            .get_authorized(url, Vec::new(), MAX_CONFIG_BYTES)
            .await?;
        manifest::verify_content(&config.digest, Some(config.size), &response.body)?;
        let parsed = manifest::parse_image_config(&response.body)?;
        Ok(PlatformImage {
            platform: parsed.platform,
            manifest_digest: manifest_digest.to_ascii_lowercase(),
            config_digest: config.digest.to_ascii_lowercase(),
            user: parsed.user,
            env: parsed.env,
            working_dir: parsed.working_dir,
        })
    }

    fn api_url(&self, suffix: &str) -> Result<Url, RegistryError> {
        let path = format!("v2/{}/{suffix}", self.repository);
        self.base
            .join(&path)
            .map_err(|error| RegistryError::EndpointRefused {
                url: format!("{}{path}", self.base),
                reason: error.to_string(),
            })
    }

    /// GET with the auth handshake: one attempt with whatever authorization
    /// the session already holds, then at most one retry after answering a
    /// `401` challenge.
    async fn get_authorized(
        &mut self,
        url: Url,
        headers: Vec<(String, String)>,
        limit: usize,
    ) -> Result<RegistryResponse, RegistryError> {
        let mut answered = false;
        loop {
            let mut request_headers = headers.clone();
            if let Some(authorization) = &self.authorization {
                request_headers.push(("authorization".into(), authorization.clone()));
            }
            let response = self
                .follow(HttpMethod::Get, url.clone(), request_headers, None, limit)
                .await?;
            match response.status {
                200 => return Ok(response),
                401 if !answered => {
                    let header = response
                        .header("www-authenticate")
                        .unwrap_or_default()
                        .to_string();
                    self.answer_challenge(&header).await?;
                    answered = true;
                }
                status => return Err(self.status_error(status, &response, &url)),
            }
        }
    }

    async fn answer_challenge(&mut self, header: &str) -> Result<(), RegistryError> {
        let challenges = parse_challenges(header);
        if let Some(bearer) = challenges
            .iter()
            .find(|challenge| challenge.scheme == "bearer")
        {
            let token = match &self.credential {
                Some(RegistryCredential::RegistryToken(token)) => token.clone(),
                _ => self.fetch_token(bearer).await?,
            };
            self.authorization = Some(format!("Bearer {token}"));
            return Ok(());
        }
        let basic_offered = challenges
            .iter()
            .any(|challenge| challenge.scheme == "basic");
        if let (true, Some(RegistryCredential::Basic { username, password })) =
            (basic_offered, &self.credential)
        {
            self.authorization = Some(RegistryCredential::basic_header(username, password));
            return Ok(());
        }
        Err(RegistryError::Unauthorized {
            registry: self.endpoint.registry.clone(),
        })
    }

    /// The token endpoint dance (distribution spec "token authentication"):
    /// GET with optional Basic credentials, or an OAuth2 refresh-token POST.
    async fn fetch_token(&self, challenge: &Challenge) -> Result<String, RegistryError> {
        let realm =
            challenge
                .params
                .get("realm")
                .ok_or_else(|| RegistryError::ResponseInvalid {
                    message: "bearer challenge names no realm".into(),
                })?;
        let mut url = Url::parse(realm).map_err(|error| RegistryError::ResponseInvalid {
            message: format!("bearer realm {realm:?} is not a URL: {error}"),
        })?;
        let service = challenge.params.get("service").cloned();
        let scope = challenge
            .params
            .get("scope")
            .cloned()
            .unwrap_or_else(|| format!("repository:{}:pull", self.repository));

        let response = match &self.credential {
            Some(RegistryCredential::IdentityToken(refresh)) => {
                // Built in its own scope: the serializer holds a non-`Sync`
                // encoder, and keeping it alive across the `.await` below makes
                // this whole future non-`Send` — which no RPC arm can await.
                let form = {
                    let mut form = url::form_urlencoded::Serializer::new(String::new());
                    form.append_pair("grant_type", "refresh_token");
                    if let Some(service) = &service {
                        form.append_pair("service", service);
                    }
                    form.append_pair("scope", &scope)
                        .append_pair("client_id", OAUTH_CLIENT_ID)
                        .append_pair("refresh_token", refresh);
                    form.finish()
                };
                let body = (
                    "application/x-www-form-urlencoded".to_string(),
                    form.into_bytes(),
                );
                self.follow(
                    HttpMethod::Post,
                    url.clone(),
                    Vec::new(),
                    Some(body),
                    MAX_TOKEN_BYTES,
                )
                .await?
            }
            credential => {
                {
                    let mut query = url.query_pairs_mut();
                    if let Some(service) = &service {
                        query.append_pair("service", service);
                    }
                    query.append_pair("scope", &scope);
                }
                let mut headers = Vec::new();
                if let Some(RegistryCredential::Basic { username, password }) = credential {
                    headers.push((
                        "authorization".to_string(),
                        RegistryCredential::basic_header(username, password),
                    ));
                }
                self.follow(HttpMethod::Get, url.clone(), headers, None, MAX_TOKEN_BYTES)
                    .await?
            }
        };

        match response.status {
            200 => {}
            401 | 403 => {
                return Err(RegistryError::Unauthorized {
                    registry: self.endpoint.registry.clone(),
                })
            }
            status => return Err(self.status_error(status, &response, &url)),
        }
        #[derive(Deserialize)]
        struct TokenResponse {
            #[serde(default)]
            token: Option<String>,
            #[serde(default)]
            access_token: Option<String>,
        }
        let parsed: TokenResponse = serde_json::from_slice(&response.body).map_err(|error| {
            RegistryError::ResponseInvalid {
                message: format!("token response is not JSON: {error}"),
            }
        })?;
        let token = parsed
            .token
            .filter(|token| !token.is_empty())
            .or(parsed.access_token)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| RegistryError::ResponseInvalid {
                message: "token response carries no token".into(),
            })?;
        if !token.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err(RegistryError::ResponseInvalid {
                message: "token contains characters a header cannot carry".into(),
            });
        }
        Ok(token)
    }

    /// Sends one request and follows redirects, validating every hop.
    async fn follow(
        &self,
        method: HttpMethod,
        url: Url,
        headers: Vec<(String, String)>,
        body: Option<(String, Vec<u8>)>,
        limit: usize,
    ) -> Result<RegistryResponse, RegistryError> {
        let mut request = RegistryRequest {
            method,
            url,
            headers,
            body,
            max_body_bytes: limit,
            allow_loopback: false,
        };
        for hop in 0..=MAX_REDIRECTS {
            self.check_hop(&request.url)?;
            request.allow_loopback = self.registry_on_loopback
                && authority(&request.url) == Some(self.endpoint.api_authority());
            let response = self.transport.send(request.clone()).await?;
            if response.body.len() > limit {
                return Err(RegistryError::ResponseTooLarge { limit });
            }
            if !matches!(response.status, 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == MAX_REDIRECTS {
                return Err(RegistryError::EndpointRefused {
                    url: request.url.to_string(),
                    reason: format!("more than {MAX_REDIRECTS} redirects"),
                });
            }
            let location =
                response
                    .header("location")
                    .ok_or_else(|| RegistryError::ResponseInvalid {
                        message: format!("{} redirect without a Location", response.status),
                    })?;
            let next =
                request
                    .url
                    .join(location)
                    .map_err(|error| RegistryError::ResponseInvalid {
                        message: format!("redirect Location {location:?}: {error}"),
                    })?;
            if authority(&next) != authority(&request.url) {
                request
                    .headers
                    .retain(|(name, _)| !name.eq_ignore_ascii_case("authorization"));
            }
            let keeps_method = matches!(response.status, 307 | 308);
            if !keeps_method {
                request.method = HttpMethod::Get;
                request.body = None;
            }
            request.url = next;
        }
        unreachable!("the loop returns on its last iteration")
    }

    fn check_hop(&self, url: &Url) -> Result<(), RegistryError> {
        let refuse = |reason: &str| {
            Err(RegistryError::EndpointRefused {
                url: url.to_string(),
                reason: reason.to_string(),
            })
        };
        if !url.username().is_empty() || url.password().is_some() {
            return refuse("URLs carrying credentials are not followed");
        }
        let Some(host) = url.host_str() else {
            return refuse("it names no host");
        };
        let registry_host = self
            .base
            .host_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        match url.scheme() {
            "https" => {}
            "http" if self.endpoint.insecure && host.eq_ignore_ascii_case(&registry_host) => {}
            "http" => {
                return refuse("plain HTTP is only allowed on an insecure registry's own host")
            }
            _ => return refuse("only http(s) URLs are followed"),
        }
        if let Some(ip) = literal_ip(url) {
            let allow_loopback =
                self.registry_on_loopback && authority(url) == Some(self.endpoint.api_authority());
            check_address(url, ip, allow_loopback)?;
        }
        Ok(())
    }

    fn status_error(&self, status: u16, response: &RegistryResponse, url: &Url) -> RegistryError {
        match status {
            401 => RegistryError::Unauthorized {
                registry: self.endpoint.registry.clone(),
            },
            403 => RegistryError::Forbidden {
                registry: self.endpoint.registry.clone(),
                repository: self.repository.to_string(),
            },
            404 => RegistryError::NotFound {
                reference: url.path().to_string(),
            },
            429 => RegistryError::RateLimited {
                registry: self.endpoint.registry.clone(),
                retry_after_secs: response
                    .header("retry-after")
                    .and_then(|value| value.trim().parse().ok()),
            },
            status => RegistryError::UnexpectedStatus {
                status,
                url: url.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use super::manifest::tests::{config_body, image_manifest_body, index_body};
    use super::manifest::{sha256_digest, DOCKER_MANIFEST, OCI_INDEX, OCI_MANIFEST};
    use super::*;

    type Handler =
        Box<dyn Fn(&RegistryRequest) -> Result<RegistryResponse, RegistryError> + Send + Sync>;

    struct FakeTransport {
        handler: Handler,
        log: Mutex<Vec<RegistryRequest>>,
    }

    impl FakeTransport {
        fn new(
            handler: impl Fn(&RegistryRequest) -> Result<RegistryResponse, RegistryError>
                + Send
                + Sync
                + 'static,
        ) -> Self {
            Self {
                handler: Box::new(handler),
                log: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<RegistryRequest> {
            self.log.lock().unwrap().clone()
        }
    }

    impl RegistryTransport for FakeTransport {
        fn send(
            &self,
            request: RegistryRequest,
        ) -> impl Future<Output = Result<RegistryResponse, RegistryError>> + Send {
            let result = (self.handler)(&request);
            self.log.lock().unwrap().push(request);
            std::future::ready(result)
        }
    }

    fn ok(content_type: &str, body: &[u8]) -> Result<RegistryResponse, RegistryError> {
        Ok(RegistryResponse {
            status: 200,
            headers: vec![("content-type".into(), content_type.into())],
            body: body.to_vec(),
        })
    }

    fn status(code: u16, headers: &[(&str, &str)]) -> Result<RegistryResponse, RegistryError> {
        Ok(RegistryResponse {
            status: code,
            headers: headers
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
            body: Vec::new(),
        })
    }

    /// A server awaits this from a request handler, which must be `Send`. A
    /// non-`Send` local held across an `.await` anywhere in the token dance
    /// compiles here and fails only in the Host, far from the cause.
    #[test]
    fn fetching_metadata_is_a_send_future() {
        fn assert_send<T: Send>(_: &T) {}
        let transport = FakeTransport::new(|_| status(404, &[]));
        let client = RegistryClient::new(transport, RegistryCredentials::empty());
        let endpoint = hub();
        let wanted = Platform::supported();
        let target = reference("library/node:22");
        let future = client.fetch_metadata(&endpoint, &target, &wanted);
        assert_send(&future);
        drop(future);
    }

    fn run<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn reference(text: &str) -> ImageReference {
        ImageReference::parse(text).unwrap()
    }

    fn hub() -> RegistryEndpoint {
        RegistryEndpoint {
            registry: "docker.io".into(),
            insecure: false,
        }
    }

    fn endpoint(registry: &str) -> RegistryEndpoint {
        RegistryEndpoint {
            registry: registry.into(),
            insecure: false,
        }
    }

    const HUB_CHALLENGE: &str = r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/node:pull""#;

    /// A Docker Hub-shaped registry: bearer auth, a two-platform index, and
    /// config blobs served through a CDN redirect.
    fn docker_hub() -> (FakeTransport, Vec<u8>, Vec<u8>, Vec<u8>) {
        let amd_config = config_body("amd64", None);
        let arm_config = config_body("arm64", Some("node"));
        let amd = image_manifest_body(&amd_config);
        let arm = image_manifest_body(&arm_config);
        let index = index_body(&[
            ("amd64", None, amd.as_slice()),
            ("arm64", Some("v8"), arm.as_slice()),
        ]);

        let blobs: BTreeMap<String, Vec<u8>> = [
            (sha256_digest(&amd_config), amd_config),
            (sha256_digest(&arm_config), arm_config),
        ]
        .into();
        let manifests: BTreeMap<String, (String, Vec<u8>)> = [
            ("22".to_string(), (OCI_INDEX.to_string(), index.clone())),
            (
                sha256_digest(&index),
                (OCI_INDEX.to_string(), index.clone()),
            ),
            (sha256_digest(&amd), (OCI_MANIFEST.to_string(), amd.clone())),
            (sha256_digest(&arm), (OCI_MANIFEST.to_string(), arm.clone())),
        ]
        .into();

        let transport = FakeTransport::new(move |request| {
            let url = request.url.as_str();
            if let Some(rest) = url.strip_prefix("https://auth.docker.io/token?") {
                assert_eq!(
                    rest,
                    "service=registry.docker.io&scope=repository%3Alibrary%2Fnode%3Apull"
                );
                return ok(
                    "application/json",
                    br#"{"token":"anon-token","expires_in":300}"#,
                );
            }
            if let Some(rest) = url.strip_prefix("https://production.cloudflare.docker.com/blobs/")
            {
                assert_eq!(
                    request.header("authorization"),
                    None,
                    "credentials never reach the CDN"
                );
                return ok("application/octet-stream", &blobs[rest]);
            }
            let path = url
                .strip_prefix("https://registry-1.docker.io/v2/library/node/")
                .unwrap_or_else(|| panic!("unexpected request to {url}"));
            if request.header("authorization") != Some("Bearer anon-token") {
                return status(401, &[("www-authenticate", HUB_CHALLENGE)]);
            }
            if let Some(reference) = path.strip_prefix("manifests/") {
                assert!(request.header("accept").unwrap().contains(OCI_INDEX));
                return match manifests.get(reference) {
                    Some((content_type, body)) => ok(content_type, body),
                    None => status(404, &[]),
                };
            }
            let digest = path.strip_prefix("blobs/").unwrap();
            status(
                307,
                &[(
                    "location",
                    &format!("https://production.cloudflare.docker.com/blobs/{digest}"),
                )],
            )
        });
        (transport, index, amd, arm)
    }

    #[test]
    fn reads_a_multi_platform_docker_hub_image_anonymously() {
        let (transport, index, amd, arm) = docker_hub();
        let client = RegistryClient::new(transport, RegistryCredentials::empty());
        let metadata =
            run(client.fetch_metadata(&hub(), &reference("node:22"), &Platform::supported()))
                .unwrap();

        assert_eq!(metadata.registry, "docker.io");
        assert_eq!(metadata.repository, "library/node");
        assert_eq!(
            metadata.digest,
            sha256_digest(&index),
            "a tag pins to the index"
        );
        assert_eq!(metadata.media_type, OCI_INDEX);
        assert_eq!(metadata.platforms.len(), 2);
        assert_eq!(metadata.platforms[0].platform, Platform::linux("amd64"));
        assert_eq!(metadata.platforms[0].manifest_digest, sha256_digest(&amd));
        assert_eq!(metadata.platforms[0].user, None);
        assert_eq!(
            metadata.platforms[1].platform.variant.as_deref(),
            Some("v8")
        );
        assert_eq!(metadata.platforms[1].manifest_digest, sha256_digest(&arm));
        assert_eq!(metadata.platforms[1].user.as_deref(), Some("node"));
        assert_eq!(metadata.platforms[1].working_dir.as_deref(), Some("/app"));
        assert!(
            metadata.common_user().is_err(),
            "the platforms disagree on the user"
        );

        let requests = client.transport.requests();
        let token_requests = requests
            .iter()
            .filter(|request| request.url.host_str() == Some("auth.docker.io"))
            .count();
        assert_eq!(token_requests, 1, "one token serves the whole session");
        assert!(requests.iter().all(|request| !request.allow_loopback));
    }

    #[test]
    fn a_digest_reference_is_verified_and_can_select_one_platform() {
        let (transport, index, _, arm) = docker_hub();
        let client = RegistryClient::new(transport, RegistryCredentials::empty());
        let pinned = reference(&format!("node@{}", sha256_digest(&index)));
        let metadata =
            run(client.fetch_metadata(&hub(), &pinned, &[Platform::linux("arm64")])).unwrap();
        assert_eq!(metadata.platforms.len(), 1);
        assert_eq!(metadata.platforms[0].manifest_digest, sha256_digest(&arm));
        assert_eq!(metadata.common_user(), Ok(Some("node")));

        let (transport, ..) = docker_hub();
        let client = RegistryClient::new(transport, RegistryCredentials::empty());
        let wrong = reference(&format!("node@{}", sha256_digest(b"something else")));
        let error = run(client.fetch_metadata(&hub(), &wrong, &Platform::supported())).unwrap_err();
        assert_eq!(error.code(), "registry_not_found");
    }

    #[test]
    fn served_bytes_that_do_not_match_the_digest_are_refused() {
        let config = config_body("amd64", None);
        let manifest = image_manifest_body(&config);
        let digest = sha256_digest(&manifest);
        let transport =
            FakeTransport::new(move |_| ok(OCI_MANIFEST, &image_manifest_body(b"tampered")));
        let client = RegistryClient::new(transport, RegistryCredentials::empty());
        let error = run(client.fetch_metadata(
            &endpoint("ghcr.io"),
            &reference(&format!("ghcr.io/acme/app@{digest}")),
            &Platform::supported(),
        ))
        .unwrap_err();
        assert_eq!(error.code(), "registry_digest_mismatch");
    }

    #[test]
    fn a_single_platform_image_outside_the_wanted_set_is_unavailable() {
        let config = config_body("s390x", None);
        let manifest = image_manifest_body(&config);
        let transport = FakeTransport::new(move |request| {
            if request.url.path().contains("/blobs/") {
                ok("application/octet-stream", &config)
            } else {
                ok(DOCKER_MANIFEST, &manifest)
            }
        });
        let client = RegistryClient::new(transport, RegistryCredentials::empty());
        let error = run(client.fetch_metadata(
            &endpoint("ghcr.io"),
            &reference("ghcr.io/acme/app:1"),
            &Platform::supported(),
        ))
        .unwrap_err();
        assert_eq!(error.code(), "registry_platform_unavailable");
    }

    fn private_registry(
        challenge: &'static str,
        expect_token_auth: Option<&'static str>,
    ) -> FakeTransport {
        let config = config_body("amd64", Some("app"));
        let manifest = image_manifest_body(&config);
        FakeTransport::new(move |request| {
            if request.url.path() == "/token" {
                assert_eq!(request.header("authorization"), expect_token_auth);
                if request.method == HttpMethod::Post {
                    let (content_type, body) = request.body.as_ref().unwrap();
                    assert_eq!(content_type, "application/x-www-form-urlencoded");
                    let form: BTreeMap<String, String> =
                        url::form_urlencoded::parse(body).into_owned().collect();
                    assert_eq!(form["grant_type"], "refresh_token");
                    assert_eq!(form["refresh_token"], "refresh-secret");
                    assert_eq!(form["client_id"], "cognia");
                    assert_eq!(form["scope"], "repository:team/app:pull");
                    assert_eq!(form["service"], "cr");
                    return ok("application/json", br#"{"access_token":"exchanged"}"#);
                }
                return ok("application/json", br#"{"token":"issued"}"#);
            }
            let authorized = matches!(
                request.header("authorization"),
                Some(
                    "Bearer issued"
                        | "Bearer exchanged"
                        | "Bearer static"
                        | "Basic Ym90OnMzY3JldA=="
                )
            );
            if !authorized {
                return status(401, &[("www-authenticate", challenge)]);
            }
            if request.url.path().contains("/blobs/") {
                ok("application/octet-stream", &config)
            } else {
                ok(OCI_MANIFEST, &manifest)
            }
        })
    }

    fn credentials(entry: &str) -> RegistryCredentials {
        RegistryCredentials::parse_docker_config(
            format!(r#"{{ "auths": {{ "cr.example.com": {entry} }} }}"#).as_bytes(),
        )
        .unwrap()
    }

    fn fetch_private(
        transport: FakeTransport,
        credentials: RegistryCredentials,
    ) -> Result<ImageMetadata, RegistryError> {
        let client = RegistryClient::new(transport, credentials);
        run(client.fetch_metadata(
            &endpoint("cr.example.com"),
            &reference("cr.example.com/team/app:1"),
            &Platform::supported(),
        ))
    }

    const CR_BEARER: &str = r#"Bearer realm="https://cr.example.com/token",service="cr""#;

    #[test]
    fn basic_credentials_are_sent_to_the_token_realm() {
        let metadata = fetch_private(
            private_registry(CR_BEARER, Some("Basic Ym90OnMzY3JldA==")),
            credentials(r#"{ "username": "bot", "password": "s3cret" }"#),
        )
        .unwrap();
        assert_eq!(metadata.common_user(), Ok(Some("app")));
    }

    #[test]
    fn an_identity_token_is_exchanged_by_refresh_token_post() {
        fetch_private(
            private_registry(CR_BEARER, None),
            credentials(r#"{ "identitytoken": "refresh-secret" }"#),
        )
        .unwrap();
    }

    #[test]
    fn a_registry_token_answers_the_bearer_challenge_directly() {
        let transport = private_registry(CR_BEARER, None);
        let client =
            RegistryClient::new(transport, credentials(r#"{ "registrytoken": "static" }"#));
        run(client.fetch_metadata(
            &endpoint("cr.example.com"),
            &reference("cr.example.com/team/app:1"),
            &Platform::supported(),
        ))
        .unwrap();
        assert!(client
            .transport
            .requests()
            .iter()
            .all(|request| request.url.path() != "/token"));
    }

    #[test]
    fn a_basic_challenge_is_answered_with_basic_credentials_only() {
        fetch_private(
            private_registry(r#"Basic realm="Harbor""#, None),
            credentials(r#"{ "auth": "Ym90OnMzY3JldA==" }"#),
        )
        .unwrap();

        let error = fetch_private(
            private_registry(r#"Basic realm="Harbor""#, None),
            RegistryCredentials::empty(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "registry_unauthorized");
    }

    #[test]
    fn a_second_401_after_the_handshake_is_unauthorized() {
        let transport = FakeTransport::new(|request| {
            if request.url.path() == "/token" {
                return ok("application/json", br#"{"token":"useless"}"#);
            }
            status(401, &[("www-authenticate", CR_BEARER)])
        });
        let error = fetch_private(transport, RegistryCredentials::empty()).unwrap_err();
        assert_eq!(error.code(), "registry_unauthorized");

        let denied_token = FakeTransport::new(|request| {
            if request.url.path() == "/token" {
                return status(403, &[]);
            }
            status(401, &[("www-authenticate", CR_BEARER)])
        });
        let error = fetch_private(denied_token, RegistryCredentials::empty()).unwrap_err();
        assert_eq!(error.code(), "registry_unauthorized");
    }

    #[test]
    fn a_credential_helper_is_refused_before_any_request() {
        let transport =
            FakeTransport::new(|request| panic!("no request expected: {}", request.url));
        let helpers = RegistryCredentials::parse_docker_config(
            br#"{ "credHelpers": { "cr.example.com": "acr-helper" } }"#,
        )
        .unwrap();
        let error = fetch_private(transport, helpers).unwrap_err();
        assert_eq!(error.code(), "registry_credential_helper_unsupported");
    }

    #[test]
    fn statuses_map_to_stable_codes() {
        for (code, headers, expected, transient) in [
            (404, vec![], "registry_not_found", false),
            (403, vec![], "registry_forbidden", false),
            (
                429,
                vec![("retry-after", "30")],
                "registry_rate_limited",
                true,
            ),
            (503, vec![], "registry_unexpected_status", true),
            (418, vec![], "registry_unexpected_status", false),
        ] {
            let transport = FakeTransport::new(move |_| status(code, &headers));
            let error = fetch_private(transport, RegistryCredentials::empty()).unwrap_err();
            assert_eq!(error.code(), expected, "{code}");
            assert_eq!(error.is_transient(), transient, "{code}");
            if let RegistryError::RateLimited {
                retry_after_secs, ..
            } = error
            {
                assert_eq!(retry_after_secs, Some(30));
            }
            if let RegistryError::NotFound { reference } = error {
                assert_eq!(reference, "cr.example.com/team/app:1");
            }
        }
    }

    fn redirect_to(location: &'static str) -> FakeTransport {
        FakeTransport::new(move |request| {
            if request.url.host_str() == Some("cr.example.com") {
                status(302, &[("location", location)])
            } else {
                panic!("a refused hop must not be sent: {}", request.url)
            }
        })
    }

    #[test]
    fn hops_a_registry_chooses_are_validated() {
        for (location, why) in [
            ("http://cdn.example.com/blob", "plain http"),
            ("https://169.254.169.254/latest/meta-data/", "metadata v4"),
            ("https://[::ffff:169.254.169.254]/", "metadata v4-mapped v6"),
            ("https://100.100.100.200/", "alibaba metadata"),
            ("https://127.0.0.1:8080/", "loopback"),
            ("https://user:pass@cdn.example.com/", "userinfo"),
            ("ftp://cdn.example.com/", "scheme"),
        ] {
            let error =
                fetch_private(redirect_to(location), RegistryCredentials::empty()).unwrap_err();
            assert_eq!(error.code(), "registry_endpoint_refused", "{why}");
        }

        let realm_on_metadata = FakeTransport::new(|request| {
            assert_eq!(request.url.host_str(), Some("cr.example.com"));
            status(
                401,
                &[(
                    "www-authenticate",
                    r#"Bearer realm="https://169.254.169.254/token""#,
                )],
            )
        });
        let error = fetch_private(realm_on_metadata, RegistryCredentials::empty()).unwrap_err();
        assert_eq!(error.code(), "registry_endpoint_refused");
    }

    #[test]
    fn redirect_loops_end() {
        let transport = FakeTransport::new(|request| {
            status(307, &[("location", &format!("{}x", request.url))])
        });
        let error = fetch_private(transport, RegistryCredentials::empty()).unwrap_err();
        assert_eq!(error.code(), "registry_endpoint_refused");
    }

    #[test]
    fn same_host_redirects_keep_authorization_and_307_keeps_the_method() {
        let config = config_body("amd64", None);
        let manifest = image_manifest_body(&config);
        let transport = FakeTransport::new(move |request| {
            let authorized = request.header("authorization") == Some("Bearer static");
            match request.url.path() {
                "/v2/team/app/manifests/1" => status(301, &[("location", "/moved/manifest")]),
                "/moved/manifest" if authorized => ok(OCI_MANIFEST, &manifest),
                path if path.starts_with("/v2/team/app/blobs/") => {
                    status(307, &[("location", "https://cr.example.com/moved/blob")])
                }
                "/moved/blob" if authorized => ok("application/octet-stream", &config),
                _ => status(401, &[("www-authenticate", CR_BEARER)]),
            }
        });
        fetch_private(transport, credentials(r#"{ "registrytoken": "static" }"#)).unwrap();
    }

    #[test]
    fn an_insecure_loopback_registry_is_reachable_over_http() {
        let config = config_body("arm64", None);
        let manifest = image_manifest_body(&config);
        let transport = FakeTransport::new(move |request| {
            assert_eq!(request.url.scheme(), "http");
            assert!(request.allow_loopback);
            if request.url.path().contains("/blobs/") {
                ok("application/octet-stream", &config)
            } else {
                ok(OCI_MANIFEST, &manifest)
            }
        });
        let client = RegistryClient::new(transport, RegistryCredentials::empty());
        let local = RegistryEndpoint {
            registry: "localhost:5000".into(),
            insecure: true,
        };
        run(client.fetch_metadata(
            &local,
            &reference("localhost:5000/dev/app:1"),
            &Platform::supported(),
        ))
        .unwrap();
        assert!(client.transport.requests()[0]
            .url
            .as_str()
            .starts_with("http://localhost:5000/v2/dev/app/manifests/1"));
    }

    #[test]
    fn oversized_and_nested_responses_are_refused() {
        let transport =
            FakeTransport::new(|_| ok(OCI_MANIFEST, &vec![b' '; MAX_MANIFEST_BYTES + 1]));
        let error = fetch_private(transport, RegistryCredentials::empty()).unwrap_err();
        assert_eq!(error.code(), "registry_response_too_large");

        let inner = index_body(&[]);
        let outer = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 2,
            "mediaType": OCI_INDEX,
            "manifests": [{
                "mediaType": OCI_INDEX,
                "digest": sha256_digest(&inner),
                "size": inner.len(),
                "platform": { "os": "linux", "architecture": "amd64" },
            }],
        }))
        .unwrap();
        let transport = FakeTransport::new(move |request| {
            if request.url.path().ends_with("/manifests/1") {
                ok(OCI_INDEX, &outer)
            } else {
                ok(OCI_INDEX, &inner)
            }
        });
        let error = fetch_private(transport, RegistryCredentials::empty()).unwrap_err();
        assert_eq!(error.code(), "registry_response_invalid");
    }

    #[test]
    fn metadata_round_trips_as_a_closed_wire_type() {
        let metadata = ImageMetadata {
            registry: "ghcr.io".into(),
            repository: "acme/app".into(),
            digest: sha256_digest(b"index"),
            media_type: OCI_INDEX.into(),
            platforms: vec![PlatformImage {
                platform: Platform::linux("amd64"),
                manifest_digest: sha256_digest(b"m"),
                config_digest: sha256_digest(b"c"),
                user: None,
                env: vec!["PATH=/bin".into()],
                working_dir: None,
            }],
        };
        let value = serde_json::to_value(&metadata).unwrap();
        assert!(value["platforms"][0].get("user").is_none());
        assert_eq!(
            serde_json::from_value::<ImageMetadata>(value).unwrap(),
            metadata
        );

        let violations = cognia_problem::wire_schema::closed_object_pairing_violations(
            "registry/mod.rs",
            include_str!("mod.rs"),
        );
        assert!(violations.is_empty(), "{violations:#?}");
    }
}
