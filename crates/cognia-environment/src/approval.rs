//! Server-side approvals and egress grants (ADR-0182).
//!
//! On a shared cloud Host an approval of a repository declaration is a record
//! on the tenant database, created by a workspace Maintainer, an Org
//! Owner/Admin or the Host owner. Admission compares the values frozen here
//! against the spec, so this crate never needs to parse a `devcontainer.json`.
//!
//! The runtime-fields digest covers what a declaration contributes at run
//! time — env, lifecycle commands, ports, the declared user. Changing any of
//! those in the repository changes the digest and the old approval no longer
//! admits the spec.
//!
//! Egress domains are deliberately outside it. A spec's `approvedDomains` is
//! the union of the declaration's domains and the project's own allowlist, so
//! binding it here would void every approval whenever a project admin edited
//! that allowlist. The declaration's domains are still frozen by
//! `declarationDigest`, and admission checks every domain against the
//! project's [`EgressGrant`] — the grant, not the approval, is the authority
//! for where a sandbox may connect.

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

/// What a caller asks to have approved.
///
/// The approver, the moment and the authority are deliberately **not** on this
/// type. They are the Host's to state: an approval whose `approverUserId`
/// arrived from the client would be an audit trail of claims rather than of
/// decisions, and a comment saying "the server overwrites this" is a weaker
/// guarantee than a field that is not there to send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct ApprovalRequest {
    pub id: String,
    pub project_id: String,
    pub normalized_remote: String,
    pub path: String,
    pub declaration_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_image: Option<PinnedImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_key: Option<String>,
    pub runtime_fields_digest: String,
}

impl ApprovalRequest {
    /// Complete the record with the three facts only the Host may state.
    pub fn into_record(
        self,
        approver_user_id: String,
        via: ApprovalAuthority,
        approved_at: i64,
    ) -> ApprovalRecord {
        ApprovalRecord {
            id: self.id,
            project_id: self.project_id,
            normalized_remote: self.normalized_remote,
            path: self.path,
            declaration_digest: self.declaration_digest,
            resolved_image: self.resolved_image,
            build_key: self.build_key,
            runtime_fields_digest: self.runtime_fields_digest,
            approver_user_id,
            via,
            approved_at,
            revoked_at: None,
            revoked_by: None,
        }
    }
}

/// What a caller asks to be granted. `grantedBy` and `grantedAt` are the
/// Host's, for the same reason as on [`ApprovalRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_sparse_object)]
pub struct EgressGrantRequest {
    pub id: String,
    pub project_id: String,
    pub tier: EgressTier,
    #[serde(default)]
    pub domains: Vec<String>,
}

impl EgressGrantRequest {
    pub fn into_grant(self, granted_by: String, granted_at: i64) -> EgressGrant {
        EgressGrant {
            id: self.id,
            project_id: self.project_id,
            tier: self.tier,
            domains: self.domains,
            granted_by,
            granted_at,
            revoked_at: None,
        }
    }
}

/// SHA-256 (lowercase hex) over the RFC 8785 form of the runtime fields a
/// declaration contributes (egress domains excluded, see the module doc).
/// Mirrored by `environmentRuntimeFieldsDigest` in
/// `lib/project-environment/environment-spec-digest.ts`.
pub fn runtime_fields_digest(spec: &EnvironmentSpec) -> Result<String, SpecError> {
    let mut value = json!({
        "containerEnv": spec.container_env,
        "lifecycleCommands": spec.lifecycle_commands,
        "forwardPorts": spec.forward_ports,
        "user": spec.user,
    });
    if !spec.remote_env.is_empty() {
        value["remoteEnv"] = json!(spec.remote_env);
    }
    if let Some(folder) = &spec.workspace_folder {
        value["workspaceFolder"] = json!(folder);
    }
    if let Some(timeout) = spec.lifecycle_timeout_ms {
        value["lifecycleTimeoutMs"] = json!(timeout);
    }
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
        other_image.image.registry_mut().unwrap().repository = "acme/other".into();
        assert_eq!(base, runtime_fields_digest(&other_image).unwrap());

        let mut more_ports = spec.clone();
        more_ports.forward_ports.push(ForwardPort {
            port: 9000,
            label: None,
        });
        assert_ne!(base, runtime_fields_digest(&more_ports).unwrap());

        let mut other_env = spec.clone();
        other_env.container_env.insert("EXTRA".into(), "1".into());
        assert_ne!(base, runtime_fields_digest(&other_env).unwrap());

        // The egress grant, not the approval, authorizes domains.
        let mut more_domains = spec;
        more_domains
            .egress
            .approved_domains
            .push("example.org".into());
        assert_eq!(base, runtime_fields_digest(&more_domains).unwrap());
    }

    #[test]
    fn optional_runtime_fields_require_new_approval_without_changing_old_digests() {
        let spec = sample_spec();
        let base = runtime_fields_digest(&spec).unwrap();
        let old_fields = json!({ "containerEnv": spec.container_env, "lifecycleCommands": spec.lifecycle_commands, "forwardPorts": spec.forward_ports, "user": spec.user });
        let old_canonical = cognia_canonical_json::canonicalize(&old_fields).unwrap();
        assert_eq!(base, hex::encode(Sha256::digest(old_canonical.as_bytes())));
        let mut changed = spec.clone();
        changed.remote_env.insert("REMOVE".into(), None);
        assert_ne!(base, runtime_fields_digest(&changed).unwrap());
        changed = spec.clone();
        changed.workspace_folder = Some("/workspace/subdir".into());
        assert_ne!(base, runtime_fields_digest(&changed).unwrap());
        changed = spec;
        changed.lifecycle_timeout_ms = Some(30_000);
        assert_ne!(base, runtime_fields_digest(&changed).unwrap());
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
