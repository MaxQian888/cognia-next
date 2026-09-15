//! Server-side approvals and egress grants (ADR-0182).
//!
//! On a shared cloud Host an approval of a repository declaration is a record
//! on the tenant database, created by a workspace Maintainer, an Org
//! Owner/Admin or the Host owner. Admission compares the values frozen here
//! against the spec, so this crate never needs to parse a `devcontainer.json`.
//!
//! The runtime-fields digest covers what a declaration contributes at run
//! time — env, lifecycle commands, ports, the declared user, the requested
//! egress domains. Changing any of those in the repository changes the digest
//! and the old approval no longer admits the spec.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::image::PinnedImage;
use crate::spec::{EgressTier, EnvironmentSpec, SpecError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalAuthority {
    /// `WorkspaceRole::Maintainer` of the project's collab workspace.
    WorkspaceMaintainer,
    /// `OrgRole::Owner` or `OrgRole::Admin`.
    OrgAdmin,
    /// The Host owner principal.
    HostOwner,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct ApprovalRecord {
    pub id: String,
    pub project_id: String,
    /// `normalize_remote_url` form: credentials stripped, lowercased host.
    pub normalized_remote: String,
    pub path: String,
    pub declaration_digest: String,
    /// The image the declaration resolved to when approved. Absent for a
    /// declaration that builds (ADR-0186), which carries `buildKey` instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_image: Option<PinnedImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_key: Option<String>,
    pub runtime_fields_digest: String,
    pub approver_user_id: String,
    pub via: ApprovalAuthority,
    pub approved_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_by: Option<String>,
}

impl ApprovalRecord {
    pub fn is_active(&self) -> bool {
        self.revoked_at.is_none()
    }
}

/// A project's permission to use egress beyond the presets: extra domains on
/// the allowlist tier, or the open tier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct EgressGrant {
    pub id: String,
    pub project_id: String,
    pub tier: EgressTier,
    pub domains: Vec<String>,
    pub granted_by: String,
    pub granted_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<i64>,
}

impl EgressGrant {
    pub fn is_active(&self) -> bool {
        self.revoked_at.is_none()
    }
}

/// SHA-256 (lowercase hex) over the RFC 8785 form of the runtime fields a
/// declaration contributes. Mirrored by `runtimeFieldsDigest` in
/// `lib/project-environment/resolve-environment-spec.ts`.
pub fn runtime_fields_digest(spec: &EnvironmentSpec) -> Result<String, SpecError> {
    let value = json!({
        "containerEnv": spec.container_env,
        "lifecycleCommands": spec.lifecycle_commands,
        "forwardPorts": spec.forward_ports,
        "user": spec.user,
        "egressDomains": spec.egress.approved_domains,
    });
    let canonical = cognia_canonical_json::canonicalize(&value).map_err(|error| SpecError {
        code: "spec_digest_failed",
        field: "spec".into(),
        message: error.to_string(),
    })?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::tests::sample_spec;
    use crate::spec::ForwardPort;

    #[test]
    fn runtime_fields_digest_tracks_only_runtime_fields() {
        let spec = sample_spec();
        let base = runtime_fields_digest(&spec).unwrap();

        let mut other_image = spec.clone();
        other_image.image.repository = "acme/other".into();
        assert_eq!(base, runtime_fields_digest(&other_image).unwrap());

        let mut more_ports = spec.clone();
        more_ports.forward_ports.push(ForwardPort {
            port: 9000,
            label: None,
        });
        assert_ne!(base, runtime_fields_digest(&more_ports).unwrap());

        let mut more_domains = spec;
        more_domains
            .egress
            .approved_domains
            .push("example.org".into());
        assert_ne!(base, runtime_fields_digest(&more_domains).unwrap());
    }

    #[test]
    fn closed_object_attributes_are_paired_correctly() {
        let violations = cognia_problem::wire_schema::closed_object_pairing_violations(
            "approval.rs",
            include_str!("approval.rs"),
        );
        assert!(violations.is_empty(), "{violations:#?}");
    }
}
