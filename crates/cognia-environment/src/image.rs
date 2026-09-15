//! OCI image references.
//!
//! One parser for every place an image name enters the environment plane: a
//! catalog entry an admin types, a `devcontainer.json` `image`, the legacy
//! `COGNIA_RUNNER_IMAGE`. It follows the Docker distribution reference grammar
//! closely enough that what it accepts is what a registry will resolve, and it
//! normalises the implicit parts (`docker.io`, `library/`) so two spellings of
//! the same image compare equal.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The registry a reference without one resolves to.
pub const DEFAULT_REGISTRY: &str = "docker.io";

/// The algorithm every pinned digest in the environment plane uses.
pub const DIGEST_PREFIX: &str = "sha256:";

/// Why a string is not an image reference.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ImageReferenceError {
    #[error("image reference is empty")]
    Empty,
    #[error("image reference is longer than 512 characters")]
    TooLong,
    #[error("registry host {0:?} is not a valid host[:port]")]
    InvalidRegistry(String),
    #[error("repository {0:?} is not a valid lowercase repository path")]
    InvalidRepository(String),
    #[error("tag {0:?} is not valid")]
    InvalidTag(String),
    #[error("digest {0:?} is not a sha256 digest")]
    InvalidDigest(String),
}

/// A parsed, normalised image reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageReference {
    pub registry: String,
    pub repository: String,
    pub tag: Option<String>,
    pub digest: Option<String>,
}

impl ImageReference {
    pub fn parse(input: &str) -> Result<Self, ImageReferenceError> {
        let input = input.trim();
        if input.is_empty() {
            return Err(ImageReferenceError::Empty);
        }
        if input.len() > 512 {
            return Err(ImageReferenceError::TooLong);
        }

        let (name_and_tag, digest) = match input.split_once('@') {
            Some((name, digest)) => {
                validate_digest(digest)?;
                (name, Some(digest.to_ascii_lowercase()))
            }
            None => (input, None),
        };

        // A tag is the part after the LAST colon, but only when that colon
        // comes after the last slash — `localhost:5000/app` has a port, not a
        // tag.
        let last_slash = name_and_tag.rfind('/');
        let (name, tag) = match name_and_tag.rfind(':') {
            Some(colon) if last_slash.is_none_or(|slash| colon > slash) => (
                &name_and_tag[..colon],
                Some(name_and_tag[colon + 1..].to_string()),
            ),
            _ => (name_and_tag, None),
        };
        if let Some(tag) = &tag {
            if !is_valid_tag(tag) {
                return Err(ImageReferenceError::InvalidTag(tag.clone()));
            }
        }

        let (registry, repository) = match name.split_once('/') {
            Some((first, rest))
                if first.contains('.') || first.contains(':') || first == "localhost" =>
            {
                (first.to_ascii_lowercase(), rest.to_string())
            }
            _ => (DEFAULT_REGISTRY.to_string(), name.to_string()),
        };
        if !is_valid_registry(&registry) {
            return Err(ImageReferenceError::InvalidRegistry(registry));
        }
        let repository = if registry == DEFAULT_REGISTRY && !repository.contains('/') {
            format!("library/{repository}")
        } else {
            repository
        };
        if !is_valid_repository(&repository) {
            return Err(ImageReferenceError::InvalidRepository(repository));
        }

        Ok(Self {
            registry,
            repository,
            tag,
            digest,
        })
    }

    /// Whether this reference names immutable content.
    pub fn is_pinned(&self) -> bool {
        self.digest.is_some()
    }

    /// `registry/repository`, the key registry allowlists match on.
    pub fn name(&self) -> String {
        format!("{}/{}", self.registry, self.repository)
    }

    /// The fully qualified reference: digest when pinned, else tag (or
    /// `latest`, which is what a registry would resolve).
    pub fn canonical(&self) -> String {
        match (&self.digest, &self.tag) {
            (Some(digest), _) => format!("{}@{digest}", self.name()),
            (None, Some(tag)) => format!("{}:{tag}", self.name()),
            (None, None) => format!("{}:latest", self.name()),
        }
    }
}

/// A digest-pinned image as it travels in specs and catalog entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct PinnedImage {
    pub registry: String,
    pub repository: String,
    /// `sha256:<64 lowercase hex>`.
    pub digest: String,
}

impl PinnedImage {
    pub fn validate(&self) -> Result<(), ImageReferenceError> {
        if !is_valid_registry(&self.registry) {
            return Err(ImageReferenceError::InvalidRegistry(self.registry.clone()));
        }
        if !is_valid_repository(&self.repository) {
            return Err(ImageReferenceError::InvalidRepository(
                self.repository.clone(),
            ));
        }
        validate_digest(&self.digest)?;
        if self.digest != self.digest.to_ascii_lowercase() {
            return Err(ImageReferenceError::InvalidDigest(self.digest.clone()));
        }
        Ok(())
    }

    pub fn name(&self) -> String {
        format!("{}/{}", self.registry, self.repository)
    }

    pub fn canonical(&self) -> String {
        format!("{}@{}", self.name(), self.digest)
    }

    /// The pinned form of a parsed reference, when it carries a digest.
    pub fn from_reference(reference: &ImageReference) -> Option<Self> {
        Some(Self {
            registry: reference.registry.clone(),
            repository: reference.repository.clone(),
            digest: reference.digest.clone()?,
        })
    }
}

/// `sha256:` followed by exactly 64 hex digits.
pub fn validate_digest(digest: &str) -> Result<(), ImageReferenceError> {
    let Some(hex) = digest.strip_prefix(DIGEST_PREFIX) else {
        return Err(ImageReferenceError::InvalidDigest(digest.to_string()));
    };
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ImageReferenceError::InvalidDigest(digest.to_string()));
    }
    Ok(())
}

fn is_valid_registry(registry: &str) -> bool {
    let (host, port) = match registry.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (registry, None),
    };
    if let Some(port) = port {
        if port.is_empty() || port.parse::<u16>().is_err() {
            return false;
        }
    }
    host == "localhost" || (host.contains('.') && cognia_net::egress::is_valid_hostname(host))
}

/// Lowercase path components of `[a-z0-9]` separated by `.`, `_`, `__` or
/// runs of `-`, joined by `/`. At most 255 characters.
fn is_valid_repository(repository: &str) -> bool {
    if repository.is_empty() || repository.len() > 255 {
        return false;
    }
    repository.split('/').all(is_valid_path_component)
}

fn is_valid_path_component(component: &str) -> bool {
    let bytes = component.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    if !alnum(bytes[0]) || !alnum(bytes[bytes.len() - 1]) {
        return false;
    }
    let mut index = 0;
    while index < bytes.len() {
        let b = bytes[index];
        if alnum(b) {
            index += 1;
            continue;
        }
        // A separator run: `.`, `_`, `__`, or one or more `-`.
        match b {
            b'.' => index += 1,
            b'_' => {
                index += 1;
                if bytes.get(index) == Some(&b'_') {
                    index += 1;
                }
            }
            b'-' => {
                while bytes.get(index) == Some(&b'-') {
                    index += 1;
                }
            }
            _ => return false,
        }
        if !bytes.get(index).copied().is_some_and(alnum) {
            return false;
        }
    }
    true
}

/// `[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`.
fn is_valid_tag(tag: &str) -> bool {
    let bytes = tag.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn bare_names_resolve_to_docker_hub_library() {
        let reference = ImageReference::parse("python:3.12-slim").unwrap();
        assert_eq!(reference.registry, "docker.io");
        assert_eq!(reference.repository, "library/python");
        assert_eq!(reference.tag.as_deref(), Some("3.12-slim"));
        assert!(!reference.is_pinned());
        assert_eq!(reference.canonical(), "docker.io/library/python:3.12-slim");
    }

    #[test]
    fn a_first_component_with_a_dot_or_port_is_the_registry() {
        let ghcr = ImageReference::parse("ghcr.io/maxqian888/cognia-runner:latest").unwrap();
        assert_eq!(ghcr.registry, "ghcr.io");
        assert_eq!(ghcr.repository, "maxqian888/cognia-runner");

        let local = ImageReference::parse("localhost:5000/team/app").unwrap();
        assert_eq!(local.registry, "localhost:5000");
        assert_eq!(local.repository, "team/app");
        assert_eq!(local.tag, None, "the port colon is not a tag");

        let hub_user = ImageReference::parse("someuser/app").unwrap();
        assert_eq!(hub_user.registry, "docker.io");
        assert_eq!(hub_user.repository, "someuser/app");
    }

    #[test]
    fn digests_pin_and_normalise_case() {
        let upper = DIGEST.replace("abcdef", "ABCDEF");
        let reference = ImageReference::parse(&format!(
            "registry.cn-hangzhou.aliyuncs.com/ns/img:v1@{upper}"
        ))
        .unwrap();
        assert_eq!(reference.digest.as_deref(), Some(DIGEST));
        assert_eq!(reference.tag.as_deref(), Some("v1"));
        assert!(reference.is_pinned());
        assert_eq!(
            reference.canonical(),
            format!("registry.cn-hangzhou.aliyuncs.com/ns/img@{DIGEST}")
        );
        let pinned = PinnedImage::from_reference(&reference).unwrap();
        assert!(pinned.validate().is_ok());
    }

    #[test]
    fn malformed_references_are_refused_with_the_reason() {
        assert_eq!(ImageReference::parse(" "), Err(ImageReferenceError::Empty));
        assert!(matches!(
            ImageReference::parse("Upper/Case"),
            Err(ImageReferenceError::InvalidRepository(_))
        ));
        assert!(matches!(
            ImageReference::parse("app@sha256:short"),
            Err(ImageReferenceError::InvalidDigest(_))
        ));
        assert!(matches!(
            ImageReference::parse("app@md5:0123"),
            Err(ImageReferenceError::InvalidDigest(_))
        ));
        assert!(matches!(
            ImageReference::parse("app:-bad"),
            Err(ImageReferenceError::InvalidTag(_))
        ));
        assert!(matches!(
            ImageReference::parse("reg.io:notaport/app"),
            Err(ImageReferenceError::InvalidRegistry(_))
        ));
        assert!(matches!(
            ImageReference::parse("reg.io/a//b"),
            Err(ImageReferenceError::InvalidRepository(_))
        ));
        assert!(matches!(
            ImageReference::parse("reg.io/a-/b"),
            Err(ImageReferenceError::InvalidRepository(_))
        ));
        assert_eq!(
            ImageReference::parse(&"a".repeat(513)),
            Err(ImageReferenceError::TooLong)
        );
    }

    #[test]
    fn repository_separators_follow_the_distribution_grammar() {
        for ok in ["a", "a.b", "a_b", "a__b", "a-b", "a---b", "a0/b1/c2"] {
            assert!(is_valid_repository(ok), "{ok} should be valid");
        }
        for bad in ["_a", "a_", "a___b", "a.-b", "a..b", "-a", "a/", "A"] {
            assert!(!is_valid_repository(bad), "{bad} should be invalid");
        }
    }

    #[test]
    fn a_pinned_image_rejects_an_uppercase_digest() {
        let image = PinnedImage {
            registry: "ghcr.io".into(),
            repository: "org/img".into(),
            digest: DIGEST.to_ascii_uppercase().replace("SHA256", "sha256"),
        };
        assert!(image.validate().is_err());
    }
}
