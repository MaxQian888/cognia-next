//! Asking the collaboration plane what one person may do in one workspace —
//! ADR-0182 approvals over ADR-0149 §4.
//!
//! A shared cloud Host approves the container image a repository declares
//! (the companion RPC's `environment.approval.*` arms, in the app). Who may approve
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

use axum::{http::StatusCode, Json};
use cognia_environment::approval::ApprovalAuthority;
use cognia_tenant_auth::membership::{allows_capability, EffectiveWorkspaceAccess};
use cognia_tenant_auth::{OrgId, UserId, WorkspaceCapability};
use serde::Deserialize;

use super::deployment::{deployment_mode, DeploymentMode};
use super::rpc_error::RpcError;

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
    #[error("the authenticated identity is not linked to this organization")]
    IdentityUnlinked,
}

impl WorkspaceAccessError {
    /// The stable code the RPC refuses with and the UI localizes.
    pub fn code(&self) -> &'static str {
        match self {
            Self::IdentityUnlinked => "oidc_identity_unlinked",
            Self::NotConfigured => "approval_authority_unconfigured",
            Self::InvalidTarget(_) => "approval_authority_invalid_target",
            Self::Unauthorized => "approval_authority_unauthorized",
            Self::Unreachable(_) | Self::Upstream { .. } | Self::Malformed(_) => {
                "approval_authority_unavailable"
            }
        }
    }
}

/// Resolve only ids asserted by the configured collaboration service. The
/// access token is forwarded transiently and never stored or logged.
pub async fn resolve_oidc_device_person(
    token: &str,
    organization: &str,
    subject: &str,
) -> Result<crate::security_store::VerifiedDevicePerson, WorkspaceAccessError> {
    let config = CollabServiceConfig::from_env().ok_or(WorkspaceAccessError::NotConfigured)?;
    resolve_oidc_device_person_with(&config, token, organization, subject).await
}

async fn resolve_oidc_device_person_with(
    config: &CollabServiceConfig,
    token: &str,
    organization: &str,
    subject: &str,
) -> Result<crate::security_store::VerifiedDevicePerson, WorkspaceAccessError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Identity {
        user_id: String,
        org_id: String,
        subject: String,
        organization_id: String,
    }
    let identity: Identity = identity_request(config, token).await?;
    if identity.subject != subject
        || identity.organization_id != organization
        || organization.is_empty()
    {
        return Err(WorkspaceAccessError::IdentityUnlinked);
    }
    Ok(crate::security_store::VerifiedDevicePerson {
        user_id: UserId::parse(identity.user_id)
            .map_err(|error| WorkspaceAccessError::Malformed(error.to_string()))?,
        org_id: OrgId::parse(identity.org_id)
            .map_err(|error| WorkspaceAccessError::Malformed(error.to_string()))?,
    })
}

fn collab_client(endpoint: &str) -> Result<reqwest::Client, WorkspaceAccessError> {
    cognia_net::proxy_config::managed_client(
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none()),
        endpoint,
    )
    .map_err(|error| WorkspaceAccessError::Unreachable(error.to_string()))
}

async fn identity_request<T: serde::de::DeserializeOwned>(
    config: &CollabServiceConfig,
    token: &str,
) -> Result<T, WorkspaceAccessError> {
    let endpoint = format!("{}/internal/v1/device-person", config.base_url);
    let response = collab_client(&endpoint)?
        .post(&endpoint)
        .bearer_auth(&config.credential)
        .json(&serde_json::json!({"accessToken": token}))
        .send()
        .await
        .map_err(|error| WorkspaceAccessError::Unreachable(error.to_string()))?;
    let status = response.status().as_u16();
    // Identity responses contain ids, never an unbounded collaboration dump.
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| WorkspaceAccessError::Unreachable(error.to_string()))?
    {
        if body.len().saturating_add(chunk.len()) > 256 * 1024 {
            return Err(WorkspaceAccessError::Malformed(
                "identity response is too large".into(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    if matches!(status, 401 | 403) {
        let error: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
        return Err(
            match error.get("code").and_then(serde_json::Value::as_str) {
                Some("oidc_authentication_failed" | "oidc_identity_unlinked") => {
                    WorkspaceAccessError::IdentityUnlinked
                }
                _ => WorkspaceAccessError::Unauthorized,
            },
        );
    }
    if !(200..300).contains(&status) {
        return Err(WorkspaceAccessError::Upstream { status });
    }
    serde_json::from_slice(&body)
        .map_err(|error| WorkspaceAccessError::Malformed(error.to_string()))
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
    let client = collab_client(&endpoint)?;
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

/// Actions are collaboration-owned standing, not a renderer projection.
/// This deliberately shares the approval client's proxy, timeout, credential
/// and no-redirect policy. The admission cache lives in host_surface_gate.
pub async fn standing_actions(
    org_id: &str,
    workspace_id: Option<&str>,
    user_id: &str,
) -> Result<Vec<String>, WorkspaceAccessError> {
    let config = CollabServiceConfig::from_env().ok_or(WorkspaceAccessError::NotConfigured)?;
    let endpoint = match workspace_id {
        Some(workspace) => access_endpoint(&config.base_url, org_id, workspace, user_id)?,
        None => {
            let org = OrgId::parse(org_id)
                .map_err(|error| WorkspaceAccessError::InvalidTarget(error.to_string()))?;
            let user = UserId::parse(user_id)
                .map_err(|error| WorkspaceAccessError::InvalidTarget(error.to_string()))?;
            format!("{}/internal/v1/orgs/{}/access/{}", config.base_url, org.as_str(), user.as_str())
        }
    };
    let client = collab_client(&endpoint)?;
    let response = client
        .get(&endpoint)
        .bearer_auth(&config.credential)
        .header(reqwest::header::ACCEPT, "application/json")
        .send().await
        .map_err(|error| WorkspaceAccessError::Unreachable(error.to_string()))?;
    if !response.status().is_success() {
        return Err(WorkspaceAccessError::Upstream { status: response.status().as_u16() });
    }
    let body = response.bytes().await
        .map_err(|error| WorkspaceAccessError::Unreachable(error.to_string()))?;
    parse_standing_actions(&body)
}

fn parse_standing_actions(body: &[u8]) -> Result<Vec<String>, WorkspaceAccessError> {
    #[derive(Deserialize)]
    struct Standing { actions: Vec<String> }
    serde_json::from_slice::<Standing>(body).map(|standing| standing.actions)
        .map_err(|error| WorkspaceAccessError::Malformed(error.to_string()))
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

// ---------------------------------------------------------------------------
// Authority checks the companion's arms and relays share
// ---------------------------------------------------------------------------

/// Revalidate the paired-device control grant on non-RPC streams such as the
/// managed IDE relay. Revocation therefore closes authority immediately rather
/// than only when a new code-server session is requested.
pub fn device_can_control(device_id: &str) -> bool {
    let Some(store) = super::security_store::security_store() else {
        return false;
    };
    let Ok(Some(tenant_id)) = store.active_device_tenant(device_id) else {
        return false;
    };
    store
        .has_capability(&tenant_id, device_id, "workspace.write")
        .unwrap_or(false)
}

/// The Host's own owner principal.
///
/// A single-tenant deployment has exactly one person behind it: pairing is
/// owner-driven and the environment write arms additionally require the
/// remote-control capability, so an authenticated caller on such a Host *is*
/// the owner. A multi-tenant Host has no owner principal — several tenants
/// share it, and only the collaboration plane can tell them apart.
pub fn host_owner() -> bool {
    deployment_mode() != DeploymentMode::MultiTenant
}

/// Who the caller is, as the collaboration plane knows them.
pub fn acting_person(
    name: &str,
    local_account_id: Option<&str>,
) -> Result<crate::host_identity::HostPerson, (StatusCode, Json<RpcError>)> {
    let unknown = |detail: String| {
        (
            StatusCode::FORBIDDEN,
            Json(RpcError::new(
                "approval_authority_unknown_person",
                format!("{name}: {detail}"),
            )),
        )
    };
    let namespace = match local_account_id {
        Some(id) if !id.trim().is_empty() => id.trim().to_string(),
        _ => {
            crate::host_identity::current()
                .map_err(|error| {
                    unknown(format!(
                        "this host has no account binding to act as: {error}"
                    ))
                })?
                .local_account_namespace
        }
    };
    crate::host_identity::person(&namespace)
        .map_err(|error| unknown(format!("no person is recorded for this account: {error}")))
}

/// Refuse unless the caller may approve for `workspace_id`.
///
/// On a multi-tenant Host this is a round trip to the collaboration plane, and
/// every way it can fail is a refusal — never an assumption of access. The
/// codes come from this module so a UI can tell
/// "you are not a maintainer" from "the plane is down".
pub async fn require_approval_authority(
    name: &str,
    workspace_id: &str,
    local_account_id: Option<&str>,
) -> Result<ApprovalAuthority, (StatusCode, Json<RpcError>)> {
    require_environment_authority(name, workspace_id, local_account_id, true).await
}

pub async fn require_environment_authority(
    name: &str,
    workspace_id: &str,
    local_account_id: Option<&str>,
    manage: bool,
) -> Result<ApprovalAuthority, (StatusCode, Json<RpcError>)> {
    if host_owner() {
        return Ok(ApprovalAuthority::HostOwner);
    }
    let person = acting_person(name, local_account_id)?;
    let (org_id, user_id) = match (
        person.canonical_org_id.or(person.org_id),
        person.canonical_user_id.or(person.user_id),
    ) {
        (Some(org), Some(user)) => (org, user),
        _ => {
            return Err((
                StatusCode::FORBIDDEN,
                Json(RpcError::new(
                    "approval_authority_unknown_person",
                    format!(
                        "{name}: this account is not signed in to a collaboration \
                         organization, so no approval authority can be established"
                    ),
                )),
            ))
        }
    };
    let access = workspace_access(&org_id, workspace_id, &user_id)
        .await
        .map_err(|error| {
            (
                StatusCode::FORBIDDEN,
                Json(RpcError::new(error.code(), format!("{name}: {error}"))),
            )
        })?;
    if !(may_approve_environment(access.as_ref(), false)
        || (!manage
            && access.as_ref().is_some_and(|access| {
                access.allows(cognia_tenant_auth::WorkspaceCapability::Read)
            })))
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(RpcError::new(
                "approval_authority_insufficient",
                format!("{name}: approving a runtime environment needs workspace management"),
            )),
        ));
    }
    Ok(ApprovalAuthority::WorkspaceMaintainer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_tenant_auth::membership::{resolve_workspace_access, WorkspaceAccessVia};
    use cognia_tenant_auth::{OrgRole, WorkspaceRole};

    const ORG: &str = "org_acme";
    const USER: &str = "usr_alice";

    #[tokio::test]
    async fn resolved_identity_registers_a_device_without_a_local_profile() {
        cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default())
            .unwrap();
        use wiremock::{
            matchers::{body_json, header, method, path},
            Mock, MockServer, ResponseTemplate,
        };
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/internal/v1/device-person"))
            .and(header("authorization", "Bearer host-credential"))
            .and(body_json(serde_json::json!({"accessToken":"person-token"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "userId": USER, "orgId": ORG, "subject":"oidc-person", "organizationId":"logto-org"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let config =
            CollabServiceConfig::from_parts(Some(server.uri()), Some("host-credential".into()))
                .unwrap();
        let person =
            resolve_oidc_device_person_with(&config, "person-token", "logto-org", "oidc-person")
                .await
                .unwrap();
        let store = crate::security_store::SecurityStore::in_memory().unwrap();
        let challenge = store.issue_challenge("logto-org", 100, 60).unwrap();
        store
            .register_oidc_device(
                "logto-org",
                "oidc-person",
                &person,
                &challenge.id,
                &challenge.nonce,
                "web",
                "Web",
                "pem",
                "thumb",
                "member",
                101,
            )
            .unwrap();
        assert_eq!(
            store.active_oidc_device_person("logto-org", "web").unwrap(),
            Some(person)
        );
        assert_eq!(
            store.device_user("logto-org", "web").unwrap().as_deref(),
            Some(USER)
        );
        assert!(!store
            .has_capability("logto-org", "web", "host.admin")
            .unwrap());
    }

    #[tokio::test]
    async fn identity_lookup_refuses_mismatch_malformed_status_and_redirect() {
        cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default())
            .unwrap();
        use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};
        let good = serde_json::json!({"userId":USER,"orgId":ORG,"subject":"subject","organizationId":"lorg"});
        let mut bodies = vec![
            serde_json::json!({}),
            good.clone(),
            good.clone(),
            good.clone(),
        ];
        bodies[1]["subject"] = "another".into();
        bodies[2]["organizationId"] = "other-org".into();
        bodies[3]["userId"] = "not-an-id".into();
        for body in bodies {
            let server = MockServer::start().await;
            Mock::given(path("/internal/v1/device-person"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(&server)
                .await;
            let config =
                CollabServiceConfig::from_parts(Some(server.uri()), Some("host".into())).unwrap();
            assert!(
                resolve_oidc_device_person_with(&config, "token", "lorg", "subject")
                    .await
                    .is_err()
            );
        }
        for status in [301, 401, 403, 404, 503] {
            let server = MockServer::start().await;
            Mock::given(path("/internal/v1/device-person"))
                .respond_with(
                    ResponseTemplate::new(status)
                        .insert_header("location", format!("{}/redirected", server.uri())),
                )
                .mount(&server)
                .await;
            let config =
                CollabServiceConfig::from_parts(Some(server.uri()), Some("host".into())).unwrap();
            assert!(
                resolve_oidc_device_person_with(&config, "token", "lorg", "subject")
                    .await
                    .is_err()
            );
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        }
        let server = MockServer::start().await;
        Mock::given(path("/internal/v1/device-person"))
            .respond_with(ResponseTemplate::new(200).set_body_string("x".repeat(256 * 1024 + 1)))
            .mount(&server)
            .await;
        let config =
            CollabServiceConfig::from_parts(Some(server.uri()), Some("host".into())).unwrap();
        assert!(matches!(
            resolve_oidc_device_person_with(&config, "token", "lorg", "subject").await,
            Err(WorkspaceAccessError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn identity_lookup_distinguishes_host_credentials_from_person_denials() {
        cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default())
            .unwrap();
        use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};
        for (status, code, unlinked) in [
            (401, "host_service_credential_invalid", false),
            (403, "host_service_credential_scope", false),
            (401, "oidc_authentication_failed", true),
            (403, "oidc_identity_unlinked", true),
        ] {
            let server = MockServer::start().await;
            Mock::given(path("/internal/v1/device-person"))
                .respond_with(
                    ResponseTemplate::new(status).set_body_json(serde_json::json!({"code":code})),
                )
                .mount(&server)
                .await;
            let config =
                CollabServiceConfig::from_parts(Some(server.uri()), Some("host".into())).unwrap();
            let error = resolve_oidc_device_person_with(&config, "token", "lorg", "subject")
                .await
                .unwrap_err();
            assert_eq!(
                matches!(error, WorkspaceAccessError::IdentityUnlinked),
                unlinked
            );
        }
    }

    #[test]
    fn admission_actions_fail_closed_on_missing_or_malformed_standing() {
        assert_eq!(parse_standing_actions(br#"{"actions":["execution.request"]}"#).unwrap(), vec!["execution.request"]);
        assert!(parse_standing_actions(br#"{"actions":[]}"#).unwrap().is_empty());
        for body in [b"{}".as_slice(), b"null", br#"{"actions":[true]}"#, b"not json"] {
            assert!(parse_standing_actions(body).is_err());
        }
    }

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
