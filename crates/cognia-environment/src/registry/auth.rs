//! Registry credentials and authentication challenges.
//!
//! Credentials are never stored in the catalog. An entry names a registry
//! host; the credential for that host comes from a Docker `config.json`-shaped
//! file named by `COGNIA_REGISTRY_AUTH_FILE` — the same bytes as a Kubernetes
//! `kubernetes.io/dockerconfigjson` pull secret or a compose host's
//! `~/.docker/config.json`, so the kubelet (or daemon) that pulls and the
//! server that reads metadata authenticate identically.
//!
//! Only inline credentials (`auths`) are read. A registry whose credential
//! lives in a helper (`credHelpers`) is refused with
//! `registry_credential_helper_unsupported` rather than silently read
//! anonymously; a global `credsStore` only affects registries with no
//! `auths` entry, which are then read anonymously.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;

use base64::Engine as _;
use serde::Deserialize;

use super::RegistryError;
use crate::image::DEFAULT_REGISTRY;

/// Path to a Docker `config.json` / `.dockerconfigjson` document.
pub const REGISTRY_AUTH_FILE_ENV: &str = "COGNIA_REGISTRY_AUTH_FILE";
const MAX_AUTH_FILE_BYTES: u64 = 1024 * 1024;

/// Every spelling Docker Hub appears under in a `config.json`.
const DOCKER_HUB_ALIASES: [&str; 3] = [DEFAULT_REGISTRY, "index.docker.io", "registry-1.docker.io"];

#[derive(Clone, PartialEq, Eq)]
pub enum RegistryCredential {
    Basic {
        username: String,
        password: String,
    },
    /// An OAuth2 refresh token (`identitytoken`), exchanged at the token realm.
    IdentityToken(String),
    /// A bearer token used as-is (`registrytoken`).
    RegistryToken(String),
}

impl fmt::Debug for RegistryCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Basic { username, .. } => f
                .debug_struct("Basic")
                .field("username", username)
                .field("password", &"<redacted>")
                .finish(),
            Self::IdentityToken(_) => f.write_str("IdentityToken(<redacted>)"),
            Self::RegistryToken(_) => f.write_str("RegistryToken(<redacted>)"),
        }
    }
}

impl RegistryCredential {
    pub(crate) fn basic_header(username: &str, password: &str) -> String {
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
        format!("Basic {encoded}")
    }
}

#[derive(Debug, Deserialize)]
struct RawDockerConfig {
    #[serde(default)]
    auths: BTreeMap<String, RawAuthEntry>,
    #[serde(default, rename = "credHelpers")]
    cred_helpers: BTreeMap<String, String>,
    // `credsStore` is deliberately not read: it only applies to registries
    // without an `auths` entry, and those are read anonymously.
}

#[derive(Debug, Default, Deserialize)]
struct RawAuthEntry {
    #[serde(default)]
    auth: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    identitytoken: Option<String>,
    #[serde(default)]
    registrytoken: Option<String>,
}

/// The credentials a deployment holds, keyed by normalised registry host.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegistryCredentials {
    by_host: BTreeMap<String, RegistryCredential>,
    helper_hosts: BTreeSet<String>,
}

impl RegistryCredentials {
    pub fn empty() -> Self {
        Self::default()
    }

    /// Parses a Docker `config.json` or a `.dockerconfigjson` secret payload.
    pub fn parse_docker_config(bytes: &[u8]) -> Result<Self, RegistryError> {
        let raw: RawDockerConfig =
            serde_json::from_slice(bytes).map_err(|error| RegistryError::AuthFile {
                message: format!("not a Docker config document: {error}"),
            })?;
        let mut by_host = BTreeMap::new();
        for (key, entry) in raw.auths {
            let host = normalize_host_key(&key);
            if host.is_empty() {
                return Err(RegistryError::AuthFile {
                    message: format!("auths key {key:?} names no registry"),
                });
            }
            let Some(credential) = credential_from_entry(&key, entry)? else {
                continue;
            };
            by_host.insert(host, credential);
        }
        let helper_hosts = raw
            .cred_helpers
            .keys()
            .map(|key| normalize_host_key(key))
            .filter(|host| !host.is_empty())
            .collect();
        Ok(Self {
            by_host,
            helper_hosts,
        })
    }

    pub fn load_file(path: &Path) -> Result<Self, RegistryError> {
        let unreadable = |error: std::io::Error| RegistryError::AuthFile {
            message: format!("cannot read {}: {error}", path.display()),
        };
        let size = std::fs::metadata(path).map_err(unreadable)?.len();
        if size > MAX_AUTH_FILE_BYTES {
            return Err(RegistryError::AuthFile {
                message: format!("{} is larger than 1 MiB", path.display()),
            });
        }
        Self::parse_docker_config(&std::fs::read(path).map_err(unreadable)?)
    }

    /// Loads the file named by `COGNIA_REGISTRY_AUTH_FILE`, or no credentials
    /// when it is unset or blank.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, RegistryError> {
        match lookup(REGISTRY_AUTH_FILE_ENV).filter(|value| !value.trim().is_empty()) {
            Some(path) => Self::load_file(Path::new(path.trim())),
            None => Ok(Self::empty()),
        }
    }

    /// The credential for `registry` (as [`crate::image::ImageReference`]
    /// normalises it), `None` for anonymous access.
    pub fn credential_for(
        &self,
        registry: &str,
    ) -> Result<Option<RegistryCredential>, RegistryError> {
        let candidates = host_candidates(registry);
        if let Some(credential) = candidates.iter().find_map(|host| self.by_host.get(host)) {
            return Ok(Some(credential.clone()));
        }
        if candidates
            .iter()
            .any(|host| self.helper_hosts.contains(host))
        {
            return Err(RegistryError::CredentialHelperUnsupported {
                registry: registry.to_string(),
            });
        }
        Ok(None)
    }
}

fn credential_from_entry(
    key: &str,
    entry: RawAuthEntry,
) -> Result<Option<RegistryCredential>, RegistryError> {
    let non_empty = |value: Option<String>| value.filter(|value| !value.is_empty());
    if let Some(token) = non_empty(entry.registrytoken) {
        return Ok(Some(RegistryCredential::RegistryToken(token)));
    }
    if let Some(token) = non_empty(entry.identitytoken) {
        return Ok(Some(RegistryCredential::IdentityToken(token)));
    }
    if let (Some(username), Some(password)) = (non_empty(entry.username), non_empty(entry.password))
    {
        return Ok(Some(RegistryCredential::Basic { username, password }));
    }
    let Some(auth) = non_empty(entry.auth) else {
        return Ok(None);
    };
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(auth.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| RegistryError::AuthFile {
            message: format!("auths[{key:?}].auth is not base64 of user:password"),
        })?;
    let (username, password) = decoded
        .split_once(':')
        .ok_or_else(|| RegistryError::AuthFile {
            message: format!("auths[{key:?}].auth is not base64 of user:password"),
        })?;
    Ok(Some(RegistryCredential::Basic {
        username: username.to_string(),
        password: password.to_string(),
    }))
}

/// `https://index.docker.io/v1/` → `index.docker.io`; `GHCR.io` → `ghcr.io`.
fn normalize_host_key(key: &str) -> String {
    let trimmed = key.trim();
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    without_scheme
        .split('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn host_candidates(registry: &str) -> Vec<String> {
    let host = normalize_host_key(registry);
    if DOCKER_HUB_ALIASES.contains(&host.as_str()) {
        DOCKER_HUB_ALIASES
            .iter()
            .map(|alias| alias.to_string())
            .collect()
    } else {
        vec![host]
    }
}

/// One `WWW-Authenticate` challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    /// Lowercased (`bearer`, `basic`).
    pub scheme: String,
    /// Lowercased parameter names.
    pub params: BTreeMap<String, String>,
}

/// Parses a `WWW-Authenticate` header value (RFC 9110 §11.6.1) into its
/// challenges. Quoted strings may contain commas and escaped quotes; a
/// malformed tail ends parsing without discarding the challenges before it.
pub fn parse_challenges(header: &str) -> Vec<Challenge> {
    let chars: Vec<char> = header.chars().collect();
    let mut position = 0;
    let mut challenges = Vec::new();

    let skip = |position: &mut usize, predicate: &dyn Fn(char) -> bool| {
        while *position < chars.len() && predicate(chars[*position]) {
            *position += 1;
        }
    };
    let is_token = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c);

    loop {
        skip(&mut position, &|c| c == ',' || c.is_whitespace());
        let start = position;
        skip(&mut position, &is_token);
        if position == start {
            break;
        }
        let scheme: String = chars[start..position]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        let mut challenge = Challenge {
            scheme,
            params: BTreeMap::new(),
        };

        loop {
            let checkpoint = position;
            skip(&mut position, &|c| c == ',' || c.is_whitespace());
            let name_start = position;
            skip(&mut position, &is_token);
            if position == name_start {
                break;
            }
            let name: String = chars[name_start..position]
                .iter()
                .collect::<String>()
                .to_ascii_lowercase();
            skip(&mut position, &|c| c == ' ' || c == '\t');
            if position >= chars.len() || chars[position] != '=' {
                // A bare token: the next challenge's scheme.
                position = checkpoint;
                break;
            }
            position += 1;
            skip(&mut position, &|c| c == ' ' || c == '\t');
            let value = if position < chars.len() && chars[position] == '"' {
                position += 1;
                let mut value = String::new();
                let mut closed = false;
                while position < chars.len() {
                    match chars[position] {
                        '\\' if position + 1 < chars.len() => {
                            value.push(chars[position + 1]);
                            position += 2;
                        }
                        '"' => {
                            position += 1;
                            closed = true;
                            break;
                        }
                        other => {
                            value.push(other);
                            position += 1;
                        }
                    }
                }
                if !closed {
                    challenges.push(challenge);
                    return challenges;
                }
                value
            } else {
                let value_start = position;
                skip(&mut position, &is_token);
                chars[value_start..position].iter().collect()
            };
            challenge.params.insert(name, value);
        }
        challenges.push(challenge);
    }
    challenges
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    #[test]
    fn parses_a_docker_hub_bearer_challenge() {
        let challenges = parse_challenges(
            r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/node:pull""#,
        );
        assert_eq!(challenges.len(), 1);
        let bearer = &challenges[0];
        assert_eq!(bearer.scheme, "bearer");
        assert_eq!(bearer.params["realm"], "https://auth.docker.io/token");
        assert_eq!(bearer.params["service"], "registry.docker.io");
        assert_eq!(bearer.params["scope"], "repository:library/node:pull");
    }

    #[test]
    fn quoted_commas_and_escapes_stay_inside_their_value() {
        let challenges = parse_challenges(
            r#"Bearer realm="https://r.example/token", scope="repository:a/b:pull,push", error="say \"hi\"", Basic realm="Harbor""#,
        );
        assert_eq!(challenges.len(), 2);
        assert_eq!(challenges[0].params["scope"], "repository:a/b:pull,push");
        assert_eq!(challenges[0].params["error"], r#"say "hi""#);
        assert_eq!(challenges[1].scheme, "basic");
        assert_eq!(challenges[1].params["realm"], "Harbor");
    }

    #[test]
    fn token_values_and_mixed_case_names_parse() {
        let challenges = parse_challenges("BASIC Realm=registry, Charset=UTF-8");
        assert_eq!(challenges[0].scheme, "basic");
        assert_eq!(challenges[0].params["realm"], "registry");
        assert_eq!(challenges[0].params["charset"], "UTF-8");
    }

    #[test]
    fn an_unterminated_quote_keeps_what_parsed() {
        let challenges =
            parse_challenges(r#"Bearer realm="https://x.example/token",service="oops"#);
        assert_eq!(challenges.len(), 1);
        assert_eq!(challenges[0].params["realm"], "https://x.example/token");
        assert!(!challenges[0].params.contains_key("service"));
        assert!(parse_challenges("").is_empty());
        assert!(parse_challenges(" , ").is_empty());
    }

    #[test]
    fn reads_every_inline_credential_form() {
        let config = format!(
            r#"{{
              "auths": {{
                "https://index.docker.io/v1/": {{ "auth": "{}" }},
                "ghcr.io": {{ "username": "bot", "password": "ghp_secret" }},
                "registry.cn-hangzhou.aliyuncs.com": {{ "identitytoken": "refresh" }},
                "cr.volces.com": {{ "registrytoken": "bearer-token" }},
                "empty.example.com": {{}}
              }}
            }}"#,
            b64("hubuser:hub:pass")
        );
        let credentials = RegistryCredentials::parse_docker_config(config.as_bytes()).unwrap();
        assert_eq!(
            credentials.credential_for("docker.io").unwrap(),
            Some(RegistryCredential::Basic {
                username: "hubuser".into(),
                password: "hub:pass".into(),
            }),
            "the password keeps everything after the first colon"
        );
        assert_eq!(
            credentials.credential_for("GHCR.IO").unwrap(),
            Some(RegistryCredential::Basic {
                username: "bot".into(),
                password: "ghp_secret".into(),
            })
        );
        assert_eq!(
            credentials
                .credential_for("registry.cn-hangzhou.aliyuncs.com")
                .unwrap(),
            Some(RegistryCredential::IdentityToken("refresh".into()))
        );
        assert_eq!(
            credentials.credential_for("cr.volces.com").unwrap(),
            Some(RegistryCredential::RegistryToken("bearer-token".into()))
        );
        assert_eq!(
            credentials.credential_for("empty.example.com").unwrap(),
            None
        );
        assert_eq!(credentials.credential_for("quay.io").unwrap(), None);
    }

    #[test]
    fn helpers_refuse_but_a_global_store_reads_anonymously() {
        let credentials = RegistryCredentials::parse_docker_config(
            br#"{ "credsStore": "desktop", "credHelpers": { "123.dkr.ecr.us-east-1.amazonaws.com": "ecr-login" } }"#,
        )
        .unwrap();
        let error = credentials
            .credential_for("123.dkr.ecr.us-east-1.amazonaws.com")
            .unwrap_err();
        assert_eq!(error.code(), "registry_credential_helper_unsupported");
        assert_eq!(credentials.credential_for("ghcr.io").unwrap(), None);
    }

    #[test]
    fn malformed_documents_are_refused() {
        for bad in [
            &b"not json"[..],
            br#"{ "auths": { "ghcr.io": { "auth": "%%%" } } }"#,
            br#"{ "auths": { "ghcr.io": { "auth": "bm9jb2xvbg==" } } }"#,
            br#"{ "auths": { "https:///v1/": { "auth": "YTpi" } } }"#,
        ] {
            let error = RegistryCredentials::parse_docker_config(bad).unwrap_err();
            assert_eq!(error.code(), "registry_auth_file_invalid");
        }
    }

    #[test]
    fn debug_output_never_contains_secrets() {
        let rendered = format!(
            "{:?} {:?} {:?}",
            RegistryCredential::Basic {
                username: "bot".into(),
                password: "hunter2".into(),
            },
            RegistryCredential::IdentityToken("refresh-secret".into()),
            RegistryCredential::RegistryToken("bearer-secret".into()),
        );
        assert!(rendered.contains("bot"));
        for secret in ["hunter2", "refresh-secret", "bearer-secret"] {
            assert!(!rendered.contains(secret), "{rendered}");
        }
    }

    #[test]
    fn the_auth_file_variable_is_optional() {
        assert_eq!(
            RegistryCredentials::from_lookup(|_| None).unwrap(),
            RegistryCredentials::empty()
        );
        assert_eq!(
            RegistryCredentials::from_lookup(|_| Some("  ".into())).unwrap(),
            RegistryCredentials::empty()
        );

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            br#"{ "auths": { "ghcr.io": { "registrytoken": "t" } } }"#,
        )
        .unwrap();
        let credentials =
            RegistryCredentials::from_lookup(|_| Some(path.display().to_string())).unwrap();
        assert!(credentials.credential_for("ghcr.io").unwrap().is_some());

        let missing =
            RegistryCredentials::from_lookup(|_| Some("/definitely/not/here.json".into()));
        assert_eq!(missing.unwrap_err().code(), "registry_auth_file_invalid");
    }

    #[test]
    fn basic_headers_are_rfc_7617() {
        assert_eq!(
            RegistryCredential::basic_header("Aladdin", "open sesame"),
            "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=="
        );
    }
}
