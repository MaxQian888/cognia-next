//! OCI / Docker v2 manifests, indexes and image configs.
//!
//! Only what the environment plane needs is read: which platforms an image
//! offers, and for each the config's `User`, `Env` and `WorkingDir`. Schema 1
//! manifests are refused. Every byte string is checked against the digest the
//! referring descriptor named before it is parsed.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::RegistryError;
use crate::image::DIGEST_PREFIX;

pub const OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";
pub const OCI_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";
pub const DOCKER_MANIFEST_LIST: &str = "application/vnd.docker.distribution.manifest.list.v2+json";
pub const DOCKER_MANIFEST: &str = "application/vnd.docker.distribution.manifest.v2+json";
pub const OCI_CONFIG: &str = "application/vnd.oci.image.config.v1+json";
pub const DOCKER_CONFIG: &str = "application/vnd.docker.container.image.v1+json";

/// `Accept` for manifest requests, most specific first.
pub fn manifest_accept() -> String {
    [
        OCI_INDEX,
        OCI_MANIFEST,
        DOCKER_MANIFEST_LIST,
        DOCKER_MANIFEST,
    ]
    .join(", ")
}

/// Annotation BuildKit puts on provenance/SBOM manifests inside an index.
const REFERENCE_TYPE_ANNOTATION: &str = "vnd.docker.reference.type";

/// A platform the environment plane can run. Only `linux` images run.
#[derive(
    Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct Platform {
    pub os: String,
    pub architecture: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

impl Platform {
    pub fn linux(architecture: &str) -> Self {
        Self {
            os: "linux".into(),
            architecture: architecture.into(),
            variant: None,
        }
    }

    /// The platforms sandboxes run on.
    pub fn supported() -> Vec<Self> {
        vec![Self::linux("amd64"), Self::linux("arm64")]
    }

    /// `self` is a wanted platform; `offered` is what an index or config
    /// declares. `arm64` with no variant and `arm64/v8` are the same thing.
    pub fn accepts(&self, offered: &Platform) -> bool {
        if self.os != offered.os || self.architecture != offered.architecture {
            return false;
        }
        let normalize = |variant: Option<&str>, architecture: &str| match (architecture, variant) {
            ("arm64", Some("v8")) => None,
            (_, variant) => variant.map(str::to_string),
        };
        match &self.variant {
            None => true,
            Some(wanted) => {
                normalize(Some(wanted), &self.architecture)
                    == normalize(offered.variant.as_deref(), &offered.architecture)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    #[serde(default)]
    pub media_type: Option<String>,
    pub digest: String,
    pub size: i64,
    #[serde(default)]
    pub platform: Option<RawPlatform>,
    #[serde(default)]
    pub annotations: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RawPlatform {
    pub os: String,
    pub architecture: String,
    #[serde(default)]
    pub variant: Option<String>,
}

impl From<&RawPlatform> for Platform {
    fn from(raw: &RawPlatform) -> Self {
        Self {
            os: raw.os.clone(),
            architecture: raw.architecture.clone(),
            variant: raw.variant.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
    schema_version: u32,
    #[serde(default)]
    media_type: Option<String>,
    #[serde(default)]
    manifests: Option<Vec<Descriptor>>,
    #[serde(default)]
    config: Option<Descriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedManifest {
    Index {
        media_type: String,
        /// Runnable image manifests only: attestation manifests and entries
        /// without a platform are dropped.
        manifests: Vec<Descriptor>,
    },
    Image {
        media_type: String,
        config: Descriptor,
    },
}

impl ParsedManifest {
    pub fn media_type(&self) -> &str {
        match self {
            Self::Index { media_type, .. } | Self::Image { media_type, .. } => media_type,
        }
    }
}

/// Parses a manifest body. `content_type` is the response header, used when
/// the body does not name its own media type (optional in OCI).
pub fn parse_manifest(
    content_type: Option<&str>,
    body: &[u8],
) -> Result<ParsedManifest, RegistryError> {
    let raw: RawManifest =
        serde_json::from_slice(body).map_err(|error| RegistryError::ResponseInvalid {
            message: format!("manifest is not JSON: {error}"),
        })?;
    if raw.schema_version != 2 {
        return Err(RegistryError::ResponseInvalid {
            message: format!(
                "manifest schemaVersion {} is not supported",
                raw.schema_version
            ),
        });
    }
    // A generic header (`application/json`) says nothing; only a manifest
    // type counts. A body that names its own type is taken at its word.
    let header_type = content_type
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| {
            matches!(
                value.as_str(),
                OCI_INDEX | DOCKER_MANIFEST_LIST | OCI_MANIFEST | DOCKER_MANIFEST
            )
        });
    let media_type = raw.media_type.clone().or(header_type);

    let is_index = match media_type.as_deref() {
        Some(OCI_INDEX | DOCKER_MANIFEST_LIST) => true,
        Some(OCI_MANIFEST | DOCKER_MANIFEST) => false,
        Some(other) => {
            return Err(RegistryError::ResponseInvalid {
                message: format!("unsupported manifest media type {other}"),
            });
        }
        None => raw.manifests.is_some(),
    };

    if is_index {
        let manifests = raw
            .manifests
            .ok_or_else(|| RegistryError::ResponseInvalid {
                message: "image index has no manifests".into(),
            })?;
        for descriptor in &manifests {
            validate_descriptor(descriptor)?;
        }
        let runnable = manifests
            .into_iter()
            .filter(|descriptor| {
                descriptor.platform.is_some()
                    && !descriptor
                        .annotations
                        .contains_key(REFERENCE_TYPE_ANNOTATION)
                    && descriptor
                        .platform
                        .as_ref()
                        .is_some_and(|platform| platform.os != "unknown")
            })
            .collect();
        Ok(ParsedManifest::Index {
            media_type: media_type.unwrap_or_else(|| OCI_INDEX.into()),
            manifests: runnable,
        })
    } else {
        let config = raw.config.ok_or_else(|| RegistryError::ResponseInvalid {
            message: "image manifest has no config".into(),
        })?;
        validate_descriptor(&config)?;
        if let Some(config_type) = &config.media_type {
            if config_type != OCI_CONFIG && config_type != DOCKER_CONFIG {
                return Err(RegistryError::ResponseInvalid {
                    message: format!("{config_type} is not a container image config"),
                });
            }
        }
        Ok(ParsedManifest::Image {
            media_type: media_type.unwrap_or_else(|| OCI_MANIFEST.into()),
            config,
        })
    }
}

fn validate_descriptor(descriptor: &Descriptor) -> Result<(), RegistryError> {
    crate::image::validate_digest(&descriptor.digest).map_err(|error| {
        RegistryError::ResponseInvalid {
            message: format!("descriptor digest: {error}"),
        }
    })?;
    if descriptor.size < 0 {
        return Err(RegistryError::ResponseInvalid {
            message: format!("descriptor {} has a negative size", descriptor.digest),
        });
    }
    Ok(())
}

/// The parts of an image config the environment plane reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageConfig {
    pub platform: Platform,
    pub user: Option<String>,
    pub env: Vec<String>,
    pub working_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawImageConfig {
    #[serde(default)]
    architecture: Option<String>,
    #[serde(default)]
    os: Option<String>,
    #[serde(default)]
    variant: Option<String>,
    #[serde(default)]
    config: Option<RawContainerConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawContainerConfig {
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    env: Option<Vec<String>>,
    #[serde(default)]
    working_dir: Option<String>,
}

pub fn parse_image_config(body: &[u8]) -> Result<ImageConfig, RegistryError> {
    let raw: RawImageConfig =
        serde_json::from_slice(body).map_err(|error| RegistryError::ResponseInvalid {
            message: format!("image config is not JSON: {error}"),
        })?;
    let (Some(os), Some(architecture)) = (raw.os, raw.architecture) else {
        return Err(RegistryError::ResponseInvalid {
            message: "image config names no os/architecture".into(),
        });
    };
    let container = raw.config;
    let non_empty = |value: Option<String>| value.filter(|value| !value.trim().is_empty());
    let env = container
        .as_ref()
        .and_then(|config| config.env.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|line| {
            line.split_once('=')
                .is_some_and(|(name, _)| crate::spec::is_valid_env_name(name))
        })
        .collect();
    Ok(ImageConfig {
        platform: Platform {
            os,
            architecture,
            variant: raw.variant,
        },
        user: non_empty(container.as_ref().and_then(|config| config.user.clone())),
        env,
        working_dir: non_empty(container.and_then(|config| config.working_dir)),
    })
}

/// `sha256:<hex>` of `bytes`.
pub fn sha256_digest(bytes: &[u8]) -> String {
    format!("{DIGEST_PREFIX}{}", hex::encode(Sha256::digest(bytes)))
}

/// Refuses bytes that do not hash to `expected` or whose length differs from
/// the descriptor's `size`.
pub fn verify_content(
    expected: &str,
    size: Option<i64>,
    bytes: &[u8],
) -> Result<(), RegistryError> {
    let actual = sha256_digest(bytes);
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(RegistryError::DigestMismatch {
            expected: expected.to_ascii_lowercase(),
            actual,
        });
    }
    if let Some(size) = size {
        if size != bytes.len() as i64 {
            return Err(RegistryError::ResponseInvalid {
                message: format!(
                    "{expected} is {} bytes, the descriptor says {size}",
                    bytes.len()
                ),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn config_body(architecture: &str, user: Option<&str>) -> Vec<u8> {
        let mut config = json!({
            "Env": ["PATH=/usr/local/bin:/usr/bin", "LANG=C.UTF-8"],
            "WorkingDir": "/app",
        });
        if let Some(user) = user {
            config["User"] = json!(user);
        }
        serde_json::to_vec(&json!({
            "architecture": architecture,
            "os": "linux",
            "config": config,
            "rootfs": { "type": "layers", "diff_ids": [] },
        }))
        .unwrap()
    }

    pub(crate) fn image_manifest_body(config: &[u8]) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "mediaType": OCI_MANIFEST,
            "config": {
                "mediaType": OCI_CONFIG,
                "digest": sha256_digest(config),
                "size": config.len(),
            },
            "layers": [],
        }))
        .unwrap()
    }

    pub(crate) fn index_body(manifests: &[(&str, Option<&str>, &[u8])]) -> Vec<u8> {
        let mut entries: Vec<_> = manifests
            .iter()
            .map(|(architecture, variant, body)| {
                let mut platform = json!({ "os": "linux", "architecture": architecture });
                if let Some(variant) = variant {
                    platform["variant"] = json!(variant);
                }
                json!({
                    "mediaType": OCI_MANIFEST,
                    "digest": sha256_digest(body),
                    "size": body.len(),
                    "platform": platform,
                })
            })
            .collect();
        entries.push(json!({
            "mediaType": OCI_MANIFEST,
            "digest": sha256_digest(b"attestation"),
            "size": 11,
            "platform": { "os": "unknown", "architecture": "unknown" },
            "annotations": { "vnd.docker.reference.type": "attestation-manifest" },
        }));
        serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "mediaType": OCI_INDEX,
            "manifests": entries,
        }))
        .unwrap()
    }

    #[test]
    fn an_index_keeps_only_runnable_platform_manifests() {
        let amd = image_manifest_body(&config_body("amd64", None));
        let parsed = parse_manifest(None, &index_body(&[("amd64", None, amd.as_slice())])).unwrap();
        match parsed {
            ParsedManifest::Index {
                media_type,
                manifests,
            } => {
                assert_eq!(media_type, OCI_INDEX);
                assert_eq!(manifests.len(), 1, "the attestation manifest is dropped");
                assert_eq!(manifests[0].digest, sha256_digest(&amd));
            }
            other => panic!("expected an index, got {other:?}"),
        }
    }

    #[test]
    fn the_media_type_falls_back_to_the_header_then_the_shape() {
        let config = config_body("amd64", None);
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&image_manifest_body(&config)).unwrap();
        manifest.as_object_mut().unwrap().remove("mediaType");
        let body = serde_json::to_vec(&manifest).unwrap();

        let from_header = parse_manifest(
            Some("application/vnd.docker.distribution.manifest.v2+json; charset=utf-8"),
            &body,
        )
        .unwrap();
        assert_eq!(from_header.media_type(), DOCKER_MANIFEST);

        let from_shape = parse_manifest(Some("application/json"), &body).unwrap();
        assert_eq!(from_shape.media_type(), OCI_MANIFEST);
    }

    #[test]
    fn schema_one_and_foreign_artifacts_are_refused() {
        let schema1 = br#"{"schemaVersion":1,"name":"library/node","fsLayers":[]}"#;
        assert_eq!(
            parse_manifest(None, schema1).unwrap_err().code(),
            "registry_response_invalid"
        );

        let helm = serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "mediaType": OCI_MANIFEST,
            "config": {
                "mediaType": "application/vnd.cncf.helm.config.v1+json",
                "digest": sha256_digest(b"{}"),
                "size": 2,
            },
        }))
        .unwrap();
        assert_eq!(
            parse_manifest(None, &helm).unwrap_err().code(),
            "registry_response_invalid"
        );

        let bad_digest = serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "manifests": [{ "digest": "md5:abc", "size": 1, "platform": { "os": "linux", "architecture": "amd64" } }],
        }))
        .unwrap();
        assert_eq!(
            parse_manifest(None, &bad_digest).unwrap_err().code(),
            "registry_response_invalid"
        );

        let unknown = br#"{"schemaVersion":2,"mediaType":"application/vnd.example.thing+json"}"#;
        assert_eq!(
            parse_manifest(None, unknown).unwrap_err().code(),
            "registry_response_invalid"
        );
    }

    #[test]
    fn image_config_reads_user_env_and_working_dir() {
        let config = parse_image_config(&config_body("arm64", Some("1000:1000"))).unwrap();
        assert_eq!(config.platform, Platform::linux("arm64"));
        assert_eq!(config.user.as_deref(), Some("1000:1000"));
        assert_eq!(
            config.env,
            vec!["PATH=/usr/local/bin:/usr/bin", "LANG=C.UTF-8"]
        );
        assert_eq!(config.working_dir.as_deref(), Some("/app"));

        let blank_user = parse_image_config(&config_body("amd64", Some(""))).unwrap();
        assert_eq!(blank_user.user, None, "an empty User means root");

        let junk_env = serde_json::to_vec(&json!({
            "os": "linux", "architecture": "amd64",
            "config": { "Env": ["GOOD=1", "no-equals", "1BAD=x", "=empty"] },
        }))
        .unwrap();
        assert_eq!(parse_image_config(&junk_env).unwrap().env, vec!["GOOD=1"]);

        assert_eq!(
            parse_image_config(br#"{"config":{}}"#).unwrap_err().code(),
            "registry_response_invalid"
        );
    }

    #[test]
    fn platform_matching_treats_arm64_v8_as_arm64() {
        let offered_v8 = Platform {
            variant: Some("v8".into()),
            ..Platform::linux("arm64")
        };
        assert!(Platform::linux("arm64").accepts(&offered_v8));
        let wanted_v8 = offered_v8.clone();
        assert!(wanted_v8.accepts(&Platform::linux("arm64")));
        assert!(!Platform::linux("amd64").accepts(&offered_v8));
        let arm_v7 = Platform {
            variant: Some("v7".into()),
            ..Platform::linux("arm")
        };
        assert!(!Platform {
            variant: Some("v6".into()),
            ..Platform::linux("arm")
        }
        .accepts(&arm_v7));
        assert!(!Platform::linux("amd64").accepts(&Platform {
            os: "windows".into(),
            ..Platform::linux("amd64")
        }));
    }

    #[test]
    fn content_is_verified_by_digest_and_size() {
        let body = b"hello";
        let digest = sha256_digest(body);
        verify_content(&digest, Some(5), body).unwrap();
        verify_content(
            &digest.to_ascii_uppercase().replace("SHA256", "sha256"),
            None,
            body,
        )
        .unwrap();
        assert_eq!(
            verify_content(&digest, Some(5), b"jello")
                .unwrap_err()
                .code(),
            "registry_digest_mismatch"
        );
        assert_eq!(
            verify_content(&digest, Some(6), body).unwrap_err().code(),
            "registry_response_invalid"
        );
    }

    #[test]
    fn platform_is_a_closed_sparse_wire_type() {
        let violations = cognia_problem::wire_schema::closed_object_pairing_violations(
            "manifest.rs",
            include_str!("manifest.rs"),
        );
        assert!(violations.is_empty(), "{violations:#?}");
    }
}
