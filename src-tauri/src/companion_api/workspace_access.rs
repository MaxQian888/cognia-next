//! Asking the collaboration plane what one person may do in one workspace —
//! ADR-0182 approvals over ADR-0149 §4.
//!
//! A shared cloud Host approves the container image a repository declares
//! ([`crate::companion_api`]'s `environment.approval.*` arms). Who may approve
//! is a collaboration-plane fact: a Workspace Maintainer, an Org owner or
//! admin, or — on a single-tenant deployment with no plane at all — the Host's
//! own owner principal.
//!
//! # Why this asks a server instead of reading a local table
//!
//! The brain mirrors memberships into Dexie, and `lib/db/identity.ts` carries
//! the warning that its `resolveWorkspaceAccessFor` is a **UI affordance**: it
//! reads a projection the renderer itself writes. Approving an image that a
//! credentialed sandbox then runs is not an affordance. The answer has to come
//! from the side of the wire that owns the membership rows, which is what
//! `GET /internal/v1/orgs/{org}/workspaces/{ws}/access/{user}` is for.
//!
//! # Why a service credential
//!
//! The Host is not the person. A paired client asks it to approve something;
//! the Host knows which device asked and which person that device is bound to,
//! but holds no grant for them and could not verify one — the collaboration
//! server's grant key never leaves it. So the Host authenticates as itself
//! with `COGNIA_COLLAB_SERVICE_CREDENTIAL` and names the person it asks about.
//!
//! A Host with no credential configured has no approval authority, and every
//! call here refuses. That is the safe default: the approval is then refused
//! rather than granted on a local guess.

use std::time::Duration;

use cognia_tenant_auth::membership::{allows_capability, EffectiveWorkspaceAccess};
use cognia_tenant_auth::{OrgId, UserId, WorkspaceCapability};
use serde::Deserialize;

/// The clear credential this Host presents. The collaboration server stores
/// only its SHA-256 (`COLLAB_INTERNAL_SERVICE_CREDENTIAL_SHA256`).
pub const ENV_COLLAB_SERVICE_CREDENTIAL: &str = "COGNIA_COLLAB_SERVICE_CREDENTIAL";

/// An approval decision is on the interactive path, so the wait is bounded
/// tightly: a plane that is slow is, for this purpose, a plane that is down.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Why the plane could not answer. Every variant is a refusal, never a
/// fallback: an approval that cannot be verified must not be granted.
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceAccessError {
    #[error("this Host is not configured to reach a collaboration plane")]
    NotConfigured,
    #[error("{0}")]
    InvalidTarget(String),
    #[error("the collaboration plane did not accept this Host's service credential")]
    Unauthorized,
    #[error("the collaboration plane could not be reached: {0}")]
    Unreachable(String),
    #[error("the collaboration plane answered {status}")]
    Upstream { status: u16 },
    #[error("the collaboration plane's answer is not readable: {0}")]
    Malformed(String),
}

impl WorkspaceAccessError {
    /// The stable code the RPC refuses with and the UI localizes.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConfigured => "approval_authority_unconfigured",
            Self::InvalidTarget(_) => "approval_authority_invalid_target",
            Self::Unauthorized => "approval_authority_unauthorized",
            Self::Unreachable(_) | Self::Upstream { .. } | Self::Malformed(_) => {
                "approval_authority_unavailable"
            }
        }
    }
}

/// Where this Host's collaboration plane is, and what it presents to it.
#[derive(Clone)]
pub struct CollabServiceConfig {
    pub base_url: String,
    credential: String,
}

impl std::fmt::Debug for CollabServiceConfig {
    /// Hand-written so the credential cannot reach a log line through a `{:?}`
    /// on some enclosing struct.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CollabServiceConfig")
            .field("base_url", &self.base_url)
            .field("credential", &"<redacted>")
            .finish()
    }
}

impl CollabServiceConfig {
    /// Both halves or nothing: a base URL without a credential would produce
    /// a 401 on every approval, which reads like an outage rather than like
    /// the missing configuration it is.
    pub fn from_env() -> Option<Self> {
        Self::from_parts(
            std::env::var(super::api::ENV_COLLAB_SERVICE_URL).ok(),
            std::env::var(ENV_COLLAB_SERVICE_CREDENTIAL).ok(),
        )
    }

    pub fn from_parts(base_url: Option<String>, credential: Option<String>) -> Option<Self> {
        let non_empty = |value: Option<String>| {
            value
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Some(Self {
            base_url: non_empty(base_url)?.trim_end_matches('/').to_string(),
            credential: non_empty(credential)?,
        })
    }
}

/// What `user_id` may do in `workspace_id`, or `None` for no access at all.
pub async fn workspace_access(
    org_id: &str,
    workspace_id: &str,
    user_id: &str,
) -> Result<Option<EffectiveWorkspaceAccess>, WorkspaceAccessError> {
    let config = CollabServiceConfig::from_env().ok_or(WorkspaceAccessError::NotConfigured)?;
    workspace_access_with(&config, org_id, workspace_id, user_id).await
}

/// [`workspace_access`] against an explicit config, for a caller that already
/// resolved one (and for tests, which point it at a local server).
pub async fn workspace_access_with(
    config: &CollabServiceConfig,
    org_id: &str,
    workspace_id: &str,
    user_id: &str,
) -> Result<Option<EffectiveWorkspaceAccess>, WorkspaceAccessError> {
    let endpoint = access_endpoint(&config.base_url, org_id, workspace_id, user_id)?;
    // Built per request: the proxy policy is per-URL and mutable, and a client
    // cached in a struct keeps whatever was true when it was constructed.
    let client = crate::proxy_config::managed_client(
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            // A collaboration plane that answers an authorization question with
            // a redirect is not the plane the operator named.
            .redirect(reqwest::redirect::Policy::none()),
        &endpoint,
    )
    .map_err(|error| WorkspaceAccessError::Unreachable(error.to_string()))?;
    let response = client
        .get(&endpoint)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", config.credential),
        )
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| WorkspaceAccessError::Unreachable(error.to_string()))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(WorkspaceAccessError::Unauthorized);
    }
    if !status.is_success() {
        return Err(WorkspaceAccessError::Upstream {
            status: status.as_u16(),
        });
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| WorkspaceAccessError::Unreachable(error.to_string()))?;
    parse_access(&body)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceAccessBody {
    #[serde(default)]
    access: Option<EffectiveWorkspaceAccess>,
}

fn parse_access(body: &[u8]) -> Result<Option<EffectiveWorkspaceAccess>, WorkspaceAccessError> {
    serde_json::from_slice::<WorkspaceAccessBody>(body)
        .map(|body| body.access)
        .map_err(|error| WorkspaceAccessError::Malformed(error.to_string()))
}

/// The URL for one lookup, refusing anything that could leave the path it
/// names.
///
/// Org and user ids are parsed with the collaboration plane's own patterns;
/// workspace ids are plane-assigned opaque strings (a Cognia project id), so
/// they are checked against the character set a single path segment may hold.
/// Refusing beats percent-encoding here: an id with a slash in it is not a
/// legal id, and encoding one would send a request nobody meant.
fn access_endpoint(
    base_url: &str,
    org_id: &str,
    workspace_id: &str,
    user_id: &str,
) -> Result<String, WorkspaceAccessError> {
    let org = OrgId::parse(org_id)
        .map_err(|error| WorkspaceAccessError::InvalidTarget(error.to_string()))?;
    let user = UserId::parse(user_id)
        .map_err(|error| WorkspaceAccessError::InvalidTarget(error.to_string()))?;
    if !is_path_segment(workspace_id) {
        return Err(WorkspaceAccessError::InvalidTarget(format!(
            "workspace id {workspace_id:?} is not a single path segment"
        )));
    }
    Ok(format!(
        "{base_url}/internal/v1/orgs/{}/workspaces/{workspace_id}/access/{}",
        org.as_str(),
        user.as_str()
    ))
}

fn is_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
        && value != "."
        && value != ".."
}

/// Who may approve a repository-declared runtime environment (ADR-0182).
///
/// `Manage` is the bar because that is exactly what a Workspace Maintainer
/// holds and what an Org owner or admin traverses into — `resolve_workspace_access`
/// already collapsed those two ladders into one capability, and re-deriving
/// the roles here would put the rule in two places.
///
/// `host_owner` is the case the collaboration plane cannot see: on a
/// single-tenant Host the owner principal is the authority, and there may be
/// no plane at all.
pub fn may_approve_environment(
    access: Option<&EffectiveWorkspaceAccess>,
    host_owner: bool,
) -> bool {
    host_owner || allows_capability(access, WorkspaceCapability::Manage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_tenant_auth::membership::{resolve_workspace_access, WorkspaceAccessVia};
    use cognia_tenant_auth::{OrgRole, WorkspaceRole};

    const ORG: &str = "org_acme";
    const USER: &str = "usr_alice";

    fn config() -> CollabServiceConfig {
        CollabServiceConfig::from_parts(
            Some("https://collab.example.com/".into()),
            Some("secret".into()),
        )
        .expect("both halves present")
    }

    #[test]
    fn both_halves_of_the_configuration_are_required() {
        assert!(CollabServiceConfig::from_parts(Some("https://c".into()), None).is_none());
        assert!(CollabServiceConfig::from_parts(None, Some("s".into())).is_none());
        assert!(CollabServiceConfig::from_parts(Some("  ".into()), Some("s".into())).is_none());
        // The trailing slash is dropped once, here, so no endpoint doubles it.
        assert_eq!(config().base_url, "https://collab.example.com");
    }

    #[test]
    fn the_credential_never_reaches_a_debug_line() {
        let rendered = format!("{:?}", config());
        assert!(!rendered.contains("secret"), "{rendered}");
        assert!(rendered.contains("collab.example.com"), "{rendered}");
    }

    #[test]
    fn the_endpoint_names_the_person_being_asked_about() {
        assert_eq!(
            access_endpoint("https://collab.example.com", ORG, "proj-1", USER).unwrap(),
            "https://collab.example.com/internal/v1/orgs/org_acme/workspaces/proj-1/access/usr_alice"
        );
    }

    #[test]
    fn an_id_that_could_leave_its_path_segment_is_refused() {
        for (org, workspace, user) in [
            (ORG, "../../v1/orgs", USER),
            (ORG, "proj/1", USER),
            (ORG, "", USER),
            (ORG, ".", USER),
            ("org_acme/../other", "proj-1", USER),
            (ORG, "proj-1", "usr_alice/../bob"),
            // Not an id this plane issues at all.
            ("acme", "proj-1", USER),
            (ORG, "proj-1", "alice"),
        ] {
            let error = access_endpoint("https://collab.example.com", org, workspace, user)
                .expect_err("{workspace} must not reach a request");
            assert_eq!(error.code(), "approval_authority_invalid_target");
        }
    }

    #[test]
    fn a_missing_access_key_reads_as_no_access() {
        assert_eq!(parse_access(b"{}").unwrap(), None);
        assert_eq!(parse_access(br#"{"access":null}"#).unwrap(), None);
        let access = parse_access(
            br#"{"access":{"role":"maintainer","capability":"manage","via":"org-admin","guest":false}}"#,
        )
        .unwrap()
        .expect("an access object");
        assert_eq!(access.role, WorkspaceRole::Maintainer);
        assert_eq!(access.capability, WorkspaceCapability::Manage);
        assert_eq!(access.via, WorkspaceAccessVia::OrgAdmin);
        // A body that is not the shape this endpoint answers with is a
        // refusal, never an empty access that would read as "no".
        assert_eq!(
            parse_access(b"not json").unwrap_err().code(),
            "approval_authority_unavailable"
        );
    }

    /// The deny path is the point of this module: everyone below Maintainer
    /// is refused, including an ordinary Org member who happens to be in the
    /// workspace.
    #[test]
    fn only_workspace_management_or_the_host_owner_may_approve() {
        let access = |org: Option<OrgRole>, workspace: Option<WorkspaceRole>| {
            resolve_workspace_access(org, workspace)
        };
        for (org, workspace) in [
            (Some(OrgRole::Owner), None),
            (Some(OrgRole::Admin), None),
            (Some(OrgRole::Member), Some(WorkspaceRole::Maintainer)),
            (None, Some(WorkspaceRole::Maintainer)),
        ] {
            assert!(
                may_approve_environment(access(org, workspace).as_ref(), false),
                "{org:?}/{workspace:?}"
            );
        }
        for (org, workspace) in [
            (Some(OrgRole::Member), Some(WorkspaceRole::Member)),
            (Some(OrgRole::Member), Some(WorkspaceRole::Viewer)),
            (None, Some(WorkspaceRole::Member)),
            (Some(OrgRole::Member), None),
            (None, None),
        ] {
            assert!(
                !may_approve_environment(access(org, workspace).as_ref(), false),
                "{org:?}/{workspace:?}"
            );
        }
        // No plane, no access — the single-tenant Host's owner principal.
        assert!(may_approve_environment(None, true));
    }

    /// `workspace_access` reads the process environment, which every other
    /// test in this binary also reads; the refusal is asserted through the
    /// same constructor it uses rather than by mutating that environment.
    #[test]
    fn an_unconfigured_host_refuses_instead_of_guessing() {
        assert!(CollabServiceConfig::from_parts(None, None).is_none());
        assert_eq!(
            WorkspaceAccessError::NotConfigured.code(),
            "approval_authority_unconfigured"
        );
    }
}
