//! Strict primitives for the managed-desktop caller (ADR-0233).
//!
//! Wire evidence: E2B's `template/tags` documentation and JS SDK
//! `src/api/schema.gen.ts` (NewSandboxV2, TemplateBuildStartV2), checked
//! 2026-10-15. Account authorization, paid-operation consent, OCI verification
//! and durable build receipts belong to the Host domain, not this HTTP client.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{ApiClient, ApiError, BuildInfo, CreatedSandbox, RequestedBuild};

/// An immutable provider build, never a mutable alias/tag.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactBuild {
    pub template_id: String,
    pub build_id: String,
}

impl ExactBuild {
    pub fn validate(&self) -> Result<(), ApiError> {
        if !identifier(&self.template_id)
            || self.build_id.len() != 36
            || uuid::Uuid::parse_str(&self.build_id).is_err()
            || uuid::Uuid::parse_str(&self.build_id).is_ok_and(|id| id.is_nil())
        {
            return Err(ApiError::Invalid(
                "an exact template ID and non-nil UUID build ID are required".into(),
            ));
        }
        Ok(())
    }

    pub fn reference(&self) -> Result<String, ApiError> {
        self.validate()?;
        Ok(format!("{}:{}", self.template_id, self.build_id))
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

/// Release-owned recipe for a public digest-pinned OCI image. No credentials,
/// arbitrary build arguments or mutable base-template references are accepted.
#[derive(Clone, Debug)]
pub struct ImageBuildRequest {
    pub name: String,
    pub image: String,
    pub cpu_count: u32,
    pub memory_mb: u32,
    pub start_cmd: String,
    pub ready_cmd: String,
}

impl ImageBuildRequest {
    pub fn validate(&self) -> Result<(), ApiError> {
        let parts: Vec<_> = self.name.split('/').collect();
        if !(1..=2).contains(&parts.len()) || !parts.iter().all(|part| identifier(part)) {
            return Err(ApiError::Invalid(
                "a template name or namespace/name without a tag is required".into(),
            ));
        }
        let Some((repository, digest)) = self.image.split_once("@sha256:") else {
            return Err(ApiError::Invalid(
                "the base image must be pinned by sha256 digest".into(),
            ));
        };
        if repository.is_empty()
            || repository.len() > 512
            || repository.starts_with('/')
            || repository.ends_with('/')
            || repository
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || !repository
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/._-:".contains(&b))
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(ApiError::Invalid(
                "the base image reference is not a canonical sha256 reference".into(),
            ));
        }
        if self.cpu_count == 0
            || self.memory_mb == 0
            || self.cpu_count > i32::MAX as u32
            || self.memory_mb > i32::MAX as u32
        {
            return Err(ApiError::Invalid(
                "positive provider resource values are required".into(),
            ));
        }
        for command in [&self.start_cmd, &self.ready_cmd] {
            if command.trim().is_empty() || command.len() > 8192 || command.contains('\0') {
                return Err(ApiError::Invalid(
                    "a bounded release-owned start and readiness command is required".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn body(&self) -> Result<Value, ApiError> {
        self.validate()?;
        Ok(json!({
            "fromImage": self.image,
            "force": false,
            "steps": [],
            "startCmd": self.start_cmd,
            "readyCmd": self.ready_cmd,
        }))
    }
}

/// E2B enforces these ranges outside every guest. Repeat them in the managed
/// request for an inspectable policy; this does not replace provider attestation.
/// https://docs.e2b.dev/network/restrict-public-access
pub const PRIVATE_EGRESS_DENY: &[&str] = &[
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
];

/// The Host must admit these rules against its approved policy before calling.
/// Allowlist supports DNS names only: E2B filters HTTP80/TLS443, permits its
/// documented DNS resolver exception, and has shared-CDN endpoint limitations.
/// IPv6/metadata enforcement remains an enablement attestation, not a local claim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SandboxEgress {
    Off,
    On,
    Allowlist(Vec<String>),
}

/// Host-only request. Provider/Git/model credentials must never be supplied in
/// global environment. Managed desktops leave it empty and bootstrap their
/// separate guest token through the protected envd process request. Debug omits it.
#[derive(Clone)]
pub struct ExactSandboxRequest {
    pub build: ExactBuild,
    pub timeout_secs: u64,
    pub metadata: BTreeMap<String, String>,
    pub env_vars: BTreeMap<String, String>,
    pub egress: SandboxEgress,
}

impl std::fmt::Debug for ExactSandboxRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExactSandboxRequest")
            .field("build", &self.build)
            .field("timeout_secs", &self.timeout_secs)
            .field("metadata_keys", &self.metadata.keys().collect::<Vec<_>>())
            .field("env_vars", &"<redacted>")
            .field("egress", &self.egress)
            .finish()
    }
}

fn valid_egress_domain(rule: &str) -> bool {
    let host = rule.strip_prefix("*.").unwrap_or(rule);
    if host.len() > 253 || host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    let host = host.to_ascii_lowercase();
    // Single-label names and reserved local/metadata suffixes cannot be admitted.
    if !host.contains('.')
        || ["localhost", "local", "internal"]
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) && host
        .rsplit('.')
        .next()
        .is_some_and(|tld| tld.bytes().any(|b| b.is_ascii_alphabetic()))
}

impl ExactSandboxRequest {
    pub fn body(&self) -> Result<Value, ApiError> {
        // The account-specific cap belongs to admission. Never clamp here.
        if !(1..=86_400).contains(&self.timeout_secs) {
            return Err(ApiError::Invalid(
                "sandbox lifetime must be 1-86400 seconds without truncation".into(),
            ));
        }
        let reference = self.build.reference()?;
        let mut network = json!({
            "allowPublicTraffic": false,
            "denyOut": if self.egress == SandboxEgress::On { json!(PRIVATE_EGRESS_DENY) } else { json!(["0.0.0.0/0"]) },
        });
        if let SandboxEgress::Allowlist(rules) = &self.egress {
            if rules.is_empty()
                || rules.len() > 256
                || rules.iter().any(|rule| !valid_egress_domain(rule))
            {
                return Err(ApiError::Invalid(
                    "a bounded admitted egress allowlist is required".into(),
                ));
            }
            network["allowOut"] = json!(rules);
            network["denyOut"] = json!(["0.0.0.0/0"]);
        }
        Ok(json!({
            "templateID": reference,
            "timeout": self.timeout_secs,
            "autoPause": false,
            "autoResume": {"enabled": false},
            "allow_internet_access": self.egress != SandboxEgress::Off,
            "network": network,
            "metadata": self.metadata,
            "envVars": self.env_vars,
        }))
    }
}

impl ApiClient {
    /// Register only. Persist the returned IDs before starting or polling.
    /// An unknown registration outcome must be reconciled, not blindly retried.
    pub async fn request_image_build(
        &self,
        request: &ImageBuildRequest,
    ) -> Result<RequestedBuild, ApiError> {
        request.validate()?;
        self.request_build(&request.name, request.cpu_count, request.memory_mb)
            .await
    }

    /// Start the journalled build. A recipe digest must already be in the Host
    /// receipt; provider build status does not attest the image's content.
    pub async fn start_image_build(
        &self,
        build: &ExactBuild,
        request: &ImageBuildRequest,
    ) -> Result<(), ApiError> {
        build.validate()?;
        self.start_build(&build.template_id, &build.build_id, &request.body()?)
            .await
    }

    /// Verify the exact response identity and ready state. Do not substitute
    /// another ready build behind the same template/alias.
    pub async fn validate_exact_build(&self, build: &ExactBuild) -> Result<BuildInfo, ApiError> {
        build.validate()?;
        #[derive(Deserialize)]
        struct ExactInfo {
            #[serde(rename = "templateID")]
            template_id: String,
            #[serde(rename = "buildID")]
            build_id: String,
            #[serde(flatten)]
            info: BuildInfo,
        }
        let url = self.endpoint(&[
            "templates",
            &build.template_id,
            "builds",
            &build.build_id,
            "status",
        ])?;
        let response = self.call_ok(reqwest::Method::GET, url, None).await?;
        let info: ExactInfo = crate::decode(&response.body, "the exact build status")?;
        if info.template_id != build.template_id
            || info.build_id != build.build_id
            || info.info.status != "ready"
        {
            return Err(ApiError::Invalid(
                "the exact template build is missing, mismatched or not ready".into(),
            ));
        }
        Ok(info.info)
    }

    /// One billable call, with no retry or cleanup side effect. The domain
    /// persists its intent first and owns all outcome/cleanup reconciliation.
    pub async fn create_exact_sandbox(
        &self,
        request: &ExactSandboxRequest,
    ) -> Result<CreatedSandbox, ApiError> {
        self.create_sandbox(&request.body()?).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build() -> ExactBuild {
        ExactBuild {
            template_id: "desktop123".into(),
            build_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479".into(),
        }
    }

    #[test]
    fn mutable_tags_and_paths_cannot_be_an_exact_build() {
        for id in [
            "default",
            "latest",
            "v1",
            "00000000-0000-0000-0000-000000000000",
            "../build",
        ] {
            let mut candidate = build();
            candidate.build_id = id.into();
            assert!(candidate.reference().is_err());
        }
        for id in ["namespace/desktop", "desktop:latest", "..", "", "a?b"] {
            let mut candidate = build();
            candidate.template_id = id.into();
            assert!(candidate.reference().is_err());
        }
        assert_eq!(
            build().reference().unwrap(),
            "desktop123:f47ac10b-58cc-4372-a567-0e02b2c3d479"
        );
    }

    #[test]
    fn create_is_protected_finite_and_never_auto_resumes() {
        let mut request = ExactSandboxRequest {
            build: build(),
            timeout_secs: 3600,
            metadata: BTreeMap::new(),
            env_vars: BTreeMap::from([("TOKEN".into(), "guest-secret".into())]),
            egress: SandboxEgress::Off,
        };
        let body = request.body().unwrap();
        assert_eq!(body["autoPause"], false);
        assert_eq!(body["autoResume"]["enabled"], false);
        assert_eq!(body["network"]["allowPublicTraffic"], false);
        assert_eq!(body["allow_internet_access"], false);
        assert!(
            body.get("lifecycle").is_none(),
            "lifecycle is a response field"
        );
        assert!(!format!("{request:?}").contains("guest-secret"));
        for seconds in [0, 86401, u64::MAX] {
            request.timeout_secs = seconds;
            assert!(request.body().is_err());
        }
        request.timeout_secs = 86400;
        assert_eq!(request.body().unwrap()["timeout"], 86400);
        request.egress = SandboxEgress::Allowlist(vec!["example.com".into()]);
        assert_eq!(
            request.body().unwrap()["network"]["denyOut"],
            json!(["0.0.0.0/0"])
        );
        request.egress = SandboxEgress::Allowlist(vec![]);
        assert!(request.body().is_err());
    }

    #[test]
    fn image_recipe_requires_full_digest_and_fixed_shape() {
        let mut request = ImageBuildRequest {
            name: "owner/cognia-desktop".into(),
            image: format!("ghcr.io/cognia/desktop@sha256:{}", "a".repeat(64)),
            cpu_count: 2,
            memory_mb: 4096,
            start_cmd: "/opt/cognia/start".into(),
            ready_cmd: "/opt/cognia/ready".into(),
        };
        let body = request.body().unwrap();
        assert_eq!(body["fromImage"], request.image);
        assert!(body.get("fromTemplate").is_none());
        for image in [
            "desktop:latest".to_string(),
            format!("https://registry/desktop@sha256:{}", "a".repeat(64)),
            format!("registry/../desktop@sha256:{}", "a".repeat(64)),
            format!("desktop@sha256:{}", "A".repeat(64)),
        ] {
            request.image = image;
            assert!(request.body().is_err());
        }
    }

    #[test]
    fn managed_egress_cannot_allow_private_ip_cidr_or_unbounded_wildcard() {
        for rule in [
            "127.0.0.1",
            "10.0.0.0/8",
            "169.254.169.254",
            "1.1.1.1",
            "::1",
            "*",
            "localhost",
            "metadata.google.internal",
            "foo.local",
            "example.com:443",
            "*.*.example.com",
            "-bad.example.com",
        ] {
            assert!(!valid_egress_domain(rule), "{rule}");
        }
        assert!(valid_egress_domain("api.example.com"));
        assert!(valid_egress_domain("*.example.com"));
        let request = ExactSandboxRequest {
            build: build(),
            timeout_secs: 60,
            metadata: BTreeMap::new(),
            env_vars: BTreeMap::new(),
            egress: SandboxEgress::On,
        };
        assert_eq!(
            request.body().unwrap()["network"]["denyOut"],
            json!(PRIVATE_EGRESS_DENY)
        );
    }
}
