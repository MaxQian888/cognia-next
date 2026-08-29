//! HTTP surface of the collaboration plane.
//!
//! Routes are org-scoped in the path (`/v1/orgs/{org_id}/…`) rather than
//! implied by the token. The org in the path and the org in the grant must
//! agree — see [`crate::auth::authorize`] — which makes a cross-tenant request
//! a 403 that names the mismatch instead of a silent empty list.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cognia_tenant_auth::grant::{GrantClaims, GrantSigner};
use cognia_tenant_auth::membership::resolve_workspace_access;
use cognia_tenant_auth::oidc::Authenticator;
use cognia_tenant_auth::{OrgId, OrgRole, UserId, WorkspaceCapability, WorkspaceRole};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::{authorize_workspace, readable_scope, verify_grant, AuthError, WorkspaceScope};
use crate::chat_api::ChatHub;
use crate::chat_store::{ChatStore, InMemoryChatStore};
use crate::model::{
    ActorError, ActorKind, ArtifactError, CollabActor, Issue, IssueEvent, IssuePriority,
    IssueStatus, Plan, PlanStatus, PlanStepKind, PlanStepStatus, Run, RunArtifact, RunKind,
    RunStatus,
};
use crate::store::{
    AcceptInvitation, AuthorizationAuditEvent, AuthorizationContext, Invitation, IssuePatch,
    IssueQuery, MutationGuard, NewInvitation, NewIssue, NewPlan, NewPlanStep, NewRun, PlanPatch,
    PlanQuery, PlanStepProgress, RunPatch, RunQuery, Store, StoreError, Workspace, WorkspaceMember,
};

/// How long a minted grant lives.
///
/// Five minutes, matching `services/diagnostic-server`. Short because the role
/// is baked into the claim: the TTL is the whole bound on how stale a
/// membership change can be before it takes effect.
pub const GRANT_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// The provider name `external_identities` files Logto subjects under.
const LOGTO_PROVIDER: &str = "logto";

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn Store>,
    pub chat_store: Arc<dyn ChatStore>,
    pub chat_hub: Arc<ChatHub>,
    pub chat_attachments: Arc<dyn crate::chat_attachment_store::ChatAttachmentObjectStore>,
    pub chat_metrics: Arc<crate::chat_metrics::ChatMetrics>,
    pub shared_chat_enabled: bool,
    pub signer: Arc<GrantSigner>,
    /// Verifies the OIDC access token a grant is exchanged for.
    pub oidc: Arc<dyn Authenticator>,
    /// Injectable so tests can pin timestamps instead of sleeping.
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl AppState {
    pub fn new(store: Arc<dyn Store>, signer: GrantSigner, oidc: Arc<dyn Authenticator>) -> Self {
        Self {
            store,
            chat_store: Arc::new(InMemoryChatStore::new()),
            chat_hub: Arc::new(ChatHub::default()),
            chat_attachments: Arc::new(
                crate::chat_attachment_store::ObjectStoreChatAttachments::in_memory(),
            ),
            chat_metrics: Arc::new(crate::chat_metrics::ChatMetrics::default()),
            shared_chat_enabled: true,
            signer: Arc::new(signer),
            oidc,
            now: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_millis() as i64)
                    .unwrap_or_default()
            }),
        }
    }

    pub fn with_chat_store(mut self, chat_store: Arc<dyn ChatStore>) -> Self {
        self.chat_store = chat_store;
        self
    }

    pub fn with_chat_attachments(
        mut self,
        store: Arc<dyn crate::chat_attachment_store::ChatAttachmentObjectStore>,
    ) -> Self {
        self.chat_attachments = store;
        self
    }

    pub fn with_shared_chat_enabled(mut self, enabled: bool) -> Self {
        self.shared_chat_enabled = enabled;
        self
    }
}

pub fn router(state: AppState) -> Router {
    let routes = Router::new()
        .route("/health", get(health))
        .route("/internal/shared-chat-metrics", get(shared_chat_metrics))
        .route("/v1/orgs/{org_id}/grants", axum::routing::post(mint_grant))
        .route("/v1/orgs/{org_id}/memberships/me", get(my_memberships))
        .route(
            "/v1/orgs/{org_id}/invitations",
            axum::routing::post(create_invitation),
        )
        .route(
            "/v1/orgs/{org_id}/invitations/accept",
            axum::routing::post(accept_invitation),
        )
        .route(
            "/v1/orgs/{org_id}/invitations/{invitation_id}",
            get(get_invitation).delete(revoke_invitation),
        )
        .route(
            "/v1/orgs/{org_id}/members/{user_id}",
            patch(patch_org_member).delete(delete_org_member),
        )
        .route(
            "/v1/orgs/{org_id}/workspaces/{workspace_id}/members/{user_id}",
            axum::routing::post(set_workspace_member)
                .patch(set_workspace_member)
                .delete(delete_workspace_member),
        )
        .route("/v1/orgs/{org_id}/audit-events", get(list_audit_events))
        .route("/v1/orgs/{org_id}/workspaces", get(list_workspaces))
        .route(
            "/v1/orgs/{org_id}/workspaces/{workspace_id}/members",
            get(list_workspace_members),
        )
        .route(
            "/v1/orgs/{org_id}/issues",
            get(list_issues).post(create_issue),
        )
        .route("/v1/orgs/{org_id}/issues/{issue_id}", patch(patch_issue))
        .route(
            "/v1/orgs/{org_id}/issues/{issue_id}/events",
            get(list_events).post(append_event),
        )
        .route("/v1/orgs/{org_id}/plans", get(list_plans).post(create_plan))
        .route(
            "/v1/orgs/{org_id}/plans/{plan_id}",
            get(get_plan).patch(patch_plan),
        )
        .route("/v1/orgs/{org_id}/runs", get(list_runs).post(create_run))
        .route("/v1/orgs/{org_id}/runs/{run_id}", patch(patch_run));
    let routes = if state.shared_chat_enabled {
        routes.merge(crate::chat_api::routes())
    } else {
        routes
    };
    routes.with_state(state)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    collab_protocol_version: u32,
    features: Vec<&'static str>,
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let mut features = vec!["issue-writes", "plan-writes", "run-writes"];
    if state.shared_chat_enabled {
        features.push("shared-chat");
    }
    Json(HealthResponse {
        status: "ok",
        collab_protocol_version: 2,
        features,
    })
}

async fn shared_chat_metrics(
    State(state): State<AppState>,
) -> Json<crate::chat_metrics::ChatMetricsSnapshot> {
    Json(state.chat_metrics.snapshot())
}

// ── Error shape ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
}

/// A refusal a client can act on.
///
/// `Forbidden` deliberately does not distinguish "you are not a member" from
/// "this workspace does not exist": both answers would let an outsider probe
/// which workspaces an org has.
enum Failure {
    Auth(AuthError),
    Store(StoreError),
    Actor(ActorError),
    /// A run artifact the database would refuse anyway. Caught here so the
    /// client gets a 400 naming the bad link instead of a 500 carrying a
    /// constraint name.
    Artifact(ArtifactError),
    BadRequest(String),
    /// The OIDC token itself did not verify.
    Oidc(cognia_tenant_auth::oidc::AuthError),
    /// The token verified but names nobody this org knows.
    ///
    /// Deliberately the same 403 as "wrong org": distinguishing them would let
    /// a stranger with a valid token enumerate which orgs exist and which
    /// subjects they have linked.
    UnlinkedIdentity,
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        match self {
            Self::Store(StoreError::Conflict(authoritative))
            | Self::Auth(AuthError::Store(StoreError::Conflict(authoritative))) => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "revision conflict",
                    "authoritative": authoritative,
                })),
            )
                .into_response(),
            other => other.into_non_conflict_response(),
        }
    }
}

impl Failure {
    fn into_non_conflict_response(self) -> Response {
        let (status, message) = match self {
            Self::Auth(AuthError::MissingCredentials) => (
                StatusCode::UNAUTHORIZED,
                "missing bearer credentials".into(),
            ),
            Self::Auth(error @ AuthError::Grant(_)) => {
                (StatusCode::UNAUTHORIZED, error.to_string())
            }
            Self::Auth(error @ (AuthError::Forbidden | AuthError::WrongOrg { .. })) => {
                (StatusCode::FORBIDDEN, error.to_string())
            }
            Self::Auth(AuthError::Store(error)) | Self::Store(error) => match error {
                StoreError::NotFound => (StatusCode::NOT_FOUND, "not found".into()),
                StoreError::Conflict(_) => unreachable!("conflicts are handled before this match"),
                StoreError::LastOwner => (StatusCode::CONFLICT, error.to_string()),
                StoreError::InvitationUnavailable => (StatusCode::GONE, error.to_string()),
                StoreError::Policy(_) => (StatusCode::FORBIDDEN, error.to_string()),
                other => {
                    tracing::error!(error = %other, "collaboration store failure");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "storage unavailable".into(),
                    )
                }
            },
            Self::Actor(error) => (StatusCode::BAD_REQUEST, error.to_string()),
            Self::Artifact(error) => (StatusCode::BAD_REQUEST, error.to_string()),
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::Oidc(error) => (StatusCode::UNAUTHORIZED, error.to_string()),
            Self::UnlinkedIdentity => (
                StatusCode::FORBIDDEN,
                "this identity is not a member of that organisation".into(),
            ),
        };
        (status, Json(ApiError { error: message })).into_response()
    }
}

impl From<AuthError> for Failure {
    fn from(error: AuthError) -> Self {
        Self::Auth(error)
    }
}
impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<ActorError> for Failure {
    fn from(error: ActorError) -> Self {
        Self::Actor(error)
    }
}
impl From<ArtifactError> for Failure {
    fn from(error: ArtifactError) -> Self {
        Self::Artifact(error)
    }
}

// ── Wire bodies ──────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListIssuesParams {
    pub workspace_id: Option<String>,
    pub issue_project_id: Option<String>,
    pub assignee_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorBody {
    pub kind: ActorKind,
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
}

impl ActorBody {
    fn into_actor(self) -> Result<CollabActor, ActorError> {
        CollabActor::new(self.kind, self.id, self.label)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIssueBody {
    pub operation_id: String,
    pub workspace_id: String,
    pub issue_project_id: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub status: Option<IssueStatus>,
    #[serde(default)]
    pub priority: Option<IssuePriority>,
    #[serde(default)]
    pub board_order: Option<f64>,
    #[serde(default)]
    pub assignee: Option<ActorBody>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchIssueBody {
    pub operation_id: String,
    pub base_revision: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Option<String>>,
    #[serde(default)]
    pub status: Option<IssueStatus>,
    #[serde(default)]
    pub priority: Option<IssuePriority>,
    #[serde(default)]
    pub board_order: Option<f64>,
    /// `null` unassigns; absent leaves the assignee alone. The two are
    /// different requests and the wire form keeps them distinguishable.
    #[serde(default, deserialize_with = "double_option")]
    pub assignee: Option<Option<ActorBody>>,
}

/// Distinguish "field absent" from "field present and null".
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

fn validated_operation_id(operation_id: String) -> Result<String, Failure> {
    if operation_id.trim().is_empty() {
        return Err(Failure::BadRequest("operationId must not be blank".into()));
    }
    Ok(operation_id)
}

fn mutation_guard(operation_id: String, base_revision: i64) -> Result<MutationGuard, Failure> {
    if base_revision < 1 {
        return Err(Failure::BadRequest(
            "baseRevision must be a positive integer".into(),
        ));
    }
    Ok(MutationGuard {
        operation_id: validated_operation_id(operation_id)?,
        base_revision,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendEventBody {
    pub operation_id: String,
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

// ── Plans and Runs (Batch 7c) ────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPlansParams {
    pub workspace_id: Option<String>,
    pub status: Option<PlanStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePlanStepBody {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub kind: PlanStepKind,
    #[serde(default)]
    pub status: Option<PlanStepStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePlanBody {
    pub operation_id: String,
    pub workspace_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<PlanStatus>,
    /// Ordered. The index in this array becomes the step's order, so a
    /// publisher does not have to keep a separate counter in step with it.
    #[serde(default)]
    pub steps: Vec<CreatePlanStepBody>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepProgressBody {
    pub id: String,
    pub status: PlanStepStatus,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchPlanBody {
    pub operation_id: String,
    pub base_revision: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub status: Option<PlanStatus>,
    /// Progress for the named steps only. Absent steps keep what they had.
    #[serde(default)]
    pub steps: Vec<PlanStepProgressBody>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRunsParams {
    pub workspace_id: Option<String>,
    pub issue_id: Option<String>,
    pub plan_id: Option<String>,
    /// `?active=true` narrows to `queued`/`running`.
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBody {
    pub label: String,
    pub href: String,
}

impl ArtifactBody {
    fn into_artifact(self) -> Result<RunArtifact, ArtifactError> {
        RunArtifact::new(self.label, self.href)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunBody {
    pub operation_id: String,
    pub workspace_id: String,
    /// Both optional and neither required — an ad-hoc dispatch attaches to
    /// nothing. `title` is what makes it readable, so it is not optional.
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(default)]
    pub plan_id: Option<String>,
    pub title: String,
    pub kind: RunKind,
    #[serde(default)]
    pub status: Option<RunStatus>,
    #[serde(default)]
    pub artifacts: Vec<ArtifactBody>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchRunBody {
    pub operation_id: String,
    pub base_revision: i64,
    #[serde(default)]
    pub status: Option<RunStatus>,
    #[serde(default, deserialize_with = "double_option")]
    pub summary: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub error: Option<Option<String>>,
    /// Present replaces the whole set; absent leaves it alone.
    #[serde(default)]
    pub artifacts: Option<Vec<ArtifactBody>>,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MintGrantBody {
    /// Optional: a grant may be org-scoped, for listing across workspaces.
    #[serde(default)]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MintedGrant {
    pub grant: String,
    pub user_id: String,
    pub org_id: String,
    pub expires_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInvitationBody {
    #[serde(default)]
    pub org_role: Option<OrgRole>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_role: Option<WorkspaceRole>,
    #[serde(default = "default_invitation_days")]
    pub expires_in_days: u32,
    pub reason: String,
}

fn default_invitation_days() -> u32 {
    7
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedInvitation {
    #[serde(flatten)]
    pub invitation: Invitation,
    /// Returned exactly once. Persisted state contains only its SHA-256 hash.
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInvitationBody {
    pub token: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchOrgMemberBody {
    pub role: OrgRole,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkspaceMemberBody {
    pub role: WorkspaceRole,
    pub reason: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventsParams {
    #[serde(default = "default_audit_limit")]
    pub limit: usize,
}

fn default_audit_limit() -> usize {
    100
}

/// What a caller holds in one org.
///
/// `orgRole` absent plus a non-empty `workspaces` is a guest — derived by the
/// reader, never stated here, so the rule lives in one place.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyMemberships {
    pub user_id: String,
    pub org_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_role: Option<cognia_tenant_auth::OrgRole>,
    pub workspaces: Vec<crate::store::WorkspaceMembershipRow>,
}

/// Exchange a verified OIDC access token for a short-lived grant.
///
/// This is the only door into the plane: every other route takes a grant, and
/// nothing but this mints one.
///
/// The org in the path is a **claim by the client**, and it is verified inside
/// that org's own RLS scope — the two lookups below only see rows if the caller
/// really belongs there. That is what lets the exchange run without a
/// privileged escape from row-level security, which would otherwise be needed
/// to answer "which org does this token belong to" before a tenant is bound.
async fn mint_grant(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<MintGrantBody>,
) -> Result<Json<MintedGrant>, Failure> {
    let token = crate::auth::bearer_token(authorization(&headers))?;
    let claims = state
        .oidc
        .authenticate(token)
        .await
        .map_err(Failure::Oidc)?;

    // The token's organization claim must be the one this org mirrors. A token
    // for another Logto organization is not a credential here, however valid.
    let mirrored = state.store.org_logto_id(&org_id).await?;
    if mirrored.as_deref() != Some(claims.tenant_id.as_str()) {
        return Err(Failure::UnlinkedIdentity);
    }

    let user_id = state
        .store
        .user_for_external_identity(
            &org_id,
            LOGTO_PROVIDER,
            Some(&claims.tenant_id),
            &claims.subject,
        )
        .await?
        .ok_or(Failure::UnlinkedIdentity)?;

    let user = UserId::parse(user_id).map_err(|error| {
        // A linked row whose user id is not an id is a corrupt row, not a
        // rejected caller.
        Failure::Store(StoreError::Corrupt(error.to_string()))
    })?;
    let org =
        OrgId::parse(org_id.clone()).map_err(|error| Failure::BadRequest(error.to_string()))?;

    // `role` remains in the grant for wire compatibility and diagnostics only.
    // Every protected request re-resolves authoritative memberships.
    let membership = state
        .store
        .membership(&org_id, user.as_str(), body.workspace_id.as_deref())
        .await?;
    let role = resolve_workspace_access(membership.org_role, membership.workspace_role)
        .map(|access| access.role);
    if membership.org_role.is_none() && role.is_none() {
        // A workspace-only guest does not know a workspace id until the
        // memberships endpoint answers. Permit an org-scoped discovery grant
        // only when the server can already prove at least one membership.
        if body.workspace_id.is_some()
            || state
                .store
                .list_workspace_memberships(&org_id, user.as_str())
                .await?
                .is_empty()
        {
            return Err(Failure::UnlinkedIdentity);
        }
    }

    let grant_claims = GrantClaims::issue(user, org, body.workspace_id, role, GRANT_TTL)
        .map_err(|error| Failure::BadRequest(error.to_string()))?;
    let grant = state
        .signer
        .sign(&grant_claims)
        .map_err(|error| Failure::BadRequest(error.to_string()))?;

    state
        .store
        .append_authorization_audit(AuthorizationAuditEvent {
            id: format!("aud_{}", Uuid::new_v4().simple()),
            org_id: org_id.clone(),
            workspace_id: grant_claims.workspace_id.clone(),
            actor_user_id: grant_claims.user_id.to_string(),
            target_user_id: None,
            invitation_id: None,
            action: "grant.minted".into(),
            old_role: None,
            new_role: role.map(|value| value.as_str().to_owned()),
            reason: "OIDC grant exchange".into(),
            request_id: request_id(&headers),
            grant_id: Some(grant_claims.grant_id.to_string()),
            source: request_source(&headers),
            created_at: (state.now)(),
        })
        .await?;

    Ok(Json(MintedGrant {
        grant,
        user_id: grant_claims.user_id.to_string(),
        org_id: grant_claims.org_id.to_string(),
        expires_at: grant_claims.expires_at,
    }))
}

/// What this caller holds in this org — ADR-0149 §4.
///
/// The client's `orgMemberships` / `workspaceMemberships` projection has had
/// no filler since it was created: sign-in writes an org membership guessed
/// from the token's `organization_roles`, and nothing at all writes a
/// workspace one. Without this route "guest" is a shape the code can describe
/// and nothing can ever be in.
///
/// Raw facts only. Whether somebody is a guest is DERIVED — org role absent,
/// workspace memberships present — and deriving it here as well as on the
/// client would be two rules to keep in step. The client's
/// `personStandingFrom` is the one implementation.
async fn my_memberships(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<MyMemberships>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let user_id = claims.user_id.to_string();

    // No `authorize_workspace` here on purpose: asking what you hold is not
    // scoped to one workspace, and requiring a workspace role to find out
    // which workspaces you have would be circular.
    let membership = state.store.membership(&org_id, &user_id, None).await?;
    let workspaces = state
        .store
        .list_workspace_memberships(&org_id, &user_id)
        .await?;

    Ok(Json(MyMemberships {
        user_id,
        org_id,
        org_role: membership.org_role,
        workspaces,
    }))
}

async fn create_invitation(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreateInvitationBody>,
) -> Result<(StatusCode, Json<CreatedInvitation>), Failure> {
    if body.reason.trim().is_empty() {
        return Err(Failure::BadRequest("reason must not be blank".into()));
    }
    if !(1..=30).contains(&body.expires_in_days) {
        return Err(Failure::BadRequest(
            "expiresInDays must be between 1 and 30".into(),
        ));
    }
    let valid_scope = matches!(
        (&body.org_role, &body.workspace_id, &body.workspace_role),
        (Some(_), None, None) | (None, Some(_), Some(_))
    );
    if !valid_scope {
        return Err(Failure::BadRequest(
            "set exactly one orgRole or workspaceId/workspaceRole pair".into(),
        ));
    }
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    authorize_invitation_target(
        &state,
        &claims,
        body.org_role,
        body.workspace_id.as_deref(),
        body.workspace_role,
    )
    .await?;

    let mut token_bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let now = (state.now)();
    let invitation = Invitation {
        id: format!("inv_{}", Uuid::new_v4().simple()),
        org_id: org_id.clone(),
        workspace_id: body.workspace_id,
        org_role: body.org_role,
        workspace_role: body.workspace_role,
        created_by: claims.user_id.to_string(),
        expires_at: now + i64::from(body.expires_in_days) * 86_400_000,
        redeemed_at: None,
        redeemed_by: None,
        revoked_at: None,
        created_at: now,
    };
    let invitation = state
        .store
        .create_invitation(NewInvitation {
            invitation,
            token_hash: invitation_token_hash(&token),
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedInvitation { invitation, token }),
    ))
}

async fn get_invitation(
    State(state): State<AppState>,
    Path((org_id, invitation_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Invitation>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let invitation = state
        .store
        .get_invitation(&org_id, &invitation_id)
        .await?
        .ok_or(Failure::Store(StoreError::NotFound))?;
    authorize_invitation_target(
        &state,
        &claims,
        invitation.org_role,
        invitation.workspace_id.as_deref(),
        invitation.workspace_role,
    )
    .await?;
    Ok(Json(invitation))
}

async fn revoke_invitation(
    State(state): State<AppState>,
    Path((org_id, invitation_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Invitation>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let invitation = state
        .store
        .get_invitation(&org_id, &invitation_id)
        .await?
        .ok_or(Failure::Store(StoreError::NotFound))?;
    authorize_invitation_target(
        &state,
        &claims,
        invitation.org_role,
        invitation.workspace_id.as_deref(),
        invitation.workspace_role,
    )
    .await?;
    let context = authorization_context(
        &claims,
        &headers,
        header_reason(&headers, "invitation revoked"),
        (state.now)(),
    );
    Ok(Json(
        state
            .store
            .revoke_invitation(&org_id, &invitation_id, context)
            .await?,
    ))
}

async fn accept_invitation(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<AcceptInvitationBody>,
) -> Result<Json<crate::store::AcceptedInvitation>, Failure> {
    if body.token.trim().is_empty() {
        return Err(Failure::BadRequest("token must not be blank".into()));
    }
    let oidc_token = crate::auth::bearer_token(authorization(&headers))?;
    let claims = state
        .oidc
        .authenticate(oidc_token)
        .await
        .map_err(Failure::Oidc)?;
    let mirrored = state.store.org_logto_id(&org_id).await?;
    if mirrored.as_deref() != Some(claims.tenant_id.as_str()) {
        return Err(Failure::UnlinkedIdentity);
    }
    let display_name = body
        .display_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| claims.subject.clone());
    Ok(Json(
        state
            .store
            .accept_invitation(AcceptInvitation {
                org_id,
                token_hash: invitation_token_hash(&body.token),
                identity_provider: LOGTO_PROVIDER.into(),
                identity_tenant: claims.tenant_id,
                identity_subject: claims.subject,
                display_name,
                now: (state.now)(),
                request_id: request_id(&headers),
                source: request_source(&headers),
            })
            .await?,
    ))
}

async fn patch_org_member(
    State(state): State<AppState>,
    Path((org_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PatchOrgMemberBody>,
) -> Result<StatusCode, Failure> {
    if body.reason.trim().is_empty() {
        return Err(Failure::BadRequest("reason must not be blank".into()));
    }
    let (claims, actor_role) = authorize_org_management(&state, &org_id, &headers).await?;
    let target = state.store.membership(&org_id, &user_id, None).await?;
    authorize_org_role_mutation(actor_role, target.org_role, Some(body.role))?;
    let context = authorization_context(&claims, &headers, body.reason, (state.now)());
    state
        .store
        .set_org_member(&org_id, &user_id, body.role, context)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_org_member(
    State(state): State<AppState>,
    Path((org_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, Failure> {
    let (claims, actor_role) = authorize_org_management(&state, &org_id, &headers).await?;
    let target = state.store.membership(&org_id, &user_id, None).await?;
    authorize_org_role_mutation(actor_role, target.org_role, None)?;
    let context = authorization_context(
        &claims,
        &headers,
        header_reason(&headers, "organization member offboarded"),
        (state.now)(),
    );
    state
        .store
        .offboard_org_member(&org_id, &user_id, context)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_workspace_member(
    State(state): State<AppState>,
    Path((org_id, workspace_id, user_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<SetWorkspaceMemberBody>,
) -> Result<StatusCode, Failure> {
    if body.reason.trim().is_empty() {
        return Err(Failure::BadRequest("reason must not be blank".into()));
    }
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    authorize_workspace_member_mutation(&state, &claims, &workspace_id, &user_id, Some(body.role))
        .await?;
    let context = authorization_context(&claims, &headers, body.reason, (state.now)());
    state
        .store
        .set_workspace_member(&org_id, &workspace_id, &user_id, body.role, context)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_workspace_member(
    State(state): State<AppState>,
    Path((org_id, workspace_id, user_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    authorize_workspace_member_mutation(&state, &claims, &workspace_id, &user_id, None).await?;
    let context = authorization_context(
        &claims,
        &headers,
        header_reason(&headers, "workspace membership revoked"),
        (state.now)(),
    );
    state
        .store
        .remove_workspace_member(&org_id, &workspace_id, &user_id, context)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_audit_events(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    Query(params): Query<AuditEventsParams>,
    headers: HeaderMap,
) -> Result<Json<Vec<AuthorizationAuditEvent>>, Failure> {
    authorize_org_management(&state, &org_id, &headers).await?;
    Ok(Json(
        state
            .store
            .list_authorization_audit(&org_id, params.limit.clamp(1, 500))
            .await?,
    ))
}

/// Workspaces this caller can see — ADR-0149 §6.
///
/// Narrowed by `readable_scope`, the same resolver the issue listing uses, so
/// an org admin traverses everything and everyone else sees exactly what they
/// were recruited into. Reusing it rather than re-deriving is what keeps one
/// answer to "what may this person see".
async fn list_workspaces(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<Workspace>>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let scope = readable_scope(state.store.as_ref(), &claims).await?;
    let workspaces = match &scope {
        WorkspaceScope::All => state.store.list_workspaces(&org_id, None).await?,
        WorkspaceScope::Only(ids) => state.store.list_workspaces(&org_id, Some(ids)).await?,
    };
    Ok(Json(workspaces))
}

/// Everyone in one workspace.
///
/// Read access to the workspace is required, and `authorize_workspace` is what
/// decides it — a roster is a thing you can see because you are in the room,
/// not because you know its id.
async fn list_workspace_members(
    State(state): State<AppState>,
    Path((org_id, workspace_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<WorkspaceMember>>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    authorize_workspace(
        state.store.as_ref(),
        &claims,
        &workspace_id,
        WorkspaceCapability::Read,
    )
    .await?;
    Ok(Json(
        state
            .store
            .list_workspace_members(&org_id, &workspace_id)
            .await?,
    ))
}

async fn list_issues(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    Query(params): Query<ListIssuesParams>,
    headers: HeaderMap,
) -> Result<Json<Vec<Issue>>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let workspace_scope = listing_scope(&state, &claims, params.workspace_id.as_deref()).await?;

    let issues = state
        .store
        .list_issues(
            &org_id,
            IssueQuery {
                workspace_id: params.workspace_id,
                issue_project_id: params.issue_project_id,
                assignee_id: params.assignee_id,
                workspace_scope,
            },
        )
        .await?;
    Ok(Json(issues))
}

async fn create_issue(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreateIssueBody>,
) -> Result<(StatusCode, Json<Issue>), Failure> {
    let operation_id = validated_operation_id(body.operation_id)?;
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let caller = authorize_workspace(
        state.store.as_ref(),
        &claims,
        &body.workspace_id,
        WorkspaceCapability::Write,
    )
    .await?;

    if body.title.trim().is_empty() {
        return Err(Failure::BadRequest("an issue needs a title".into()));
    }

    // The creator is the authenticated caller, never a field on the request.
    // Accepting `createdBy` from the body would let any member forge authorship.
    let created_by = CollabActor::new(ActorKind::Human, caller.user_id, None)?;
    let assignee = body.assignee.map(ActorBody::into_actor).transpose()?;
    validate_human_assignee(&state, &org_id, &body.workspace_id, assignee.as_ref()).await?;
    let now = (state.now)();

    let issue = state
        .store
        .create_issue(NewIssue {
            id: format!("iss_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: body.workspace_id,
            issue_project_id: body.issue_project_id,
            title: body.title,
            body: body.body,
            status: body.status.unwrap_or(IssueStatus::Backlog),
            priority: body.priority.unwrap_or(IssuePriority::None),
            board_order: body.board_order.unwrap_or(0.0),
            assignee,
            created_by,
            now,
            operation_id,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(issue)))
}

async fn patch_issue(
    State(state): State<AppState>,
    Path((org_id, issue_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PatchIssueBody>,
) -> Result<Json<Issue>, Failure> {
    let mutation_guard = mutation_guard(body.operation_id, body.base_revision)?;
    // Read the issue first so the capability check runs against the workspace
    // the issue actually lives in, not one the caller names.
    let (claims, existing) = peek_issue(&state, &org_id, &issue_id, &headers).await?;
    authorize_workspace(
        state.store.as_ref(),
        &claims,
        &existing.workspace_id,
        WorkspaceCapability::Write,
    )
    .await?;

    let assignee = match body.assignee {
        Some(Some(actor)) => Some(Some(actor.into_actor()?)),
        Some(None) => Some(None),
        None => None,
    };
    if let Some(Some(actor)) = assignee.as_ref() {
        validate_human_assignee(&state, &org_id, &existing.workspace_id, Some(actor)).await?;
    }

    let issue = state
        .store
        .patch_issue(
            &org_id,
            &issue_id,
            IssuePatch {
                title: body.title,
                body: body.body,
                status: body.status,
                priority: body.priority,
                board_order: body.board_order,
                assignee,
            },
            mutation_guard,
            (state.now)(),
        )
        .await?;
    Ok(Json(issue))
}

async fn list_events(
    State(state): State<AppState>,
    Path((org_id, issue_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Vec<IssueEvent>>, Failure> {
    let (claims, existing) = peek_issue(&state, &org_id, &issue_id, &headers).await?;
    authorize_workspace(
        state.store.as_ref(),
        &claims,
        &existing.workspace_id,
        WorkspaceCapability::Read,
    )
    .await?;
    Ok(Json(state.store.list_events(&org_id, &issue_id).await?))
}

async fn append_event(
    State(state): State<AppState>,
    Path((org_id, issue_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<AppendEventBody>,
) -> Result<(StatusCode, Json<IssueEvent>), Failure> {
    let operation_id = validated_operation_id(body.operation_id)?;
    let (claims, existing) = peek_issue(&state, &org_id, &issue_id, &headers).await?;
    let caller = authorize_workspace(
        state.store.as_ref(),
        &claims,
        &existing.workspace_id,
        WorkspaceCapability::Write,
    )
    .await?;

    let event = IssueEvent {
        id: format!("evt_{}", Uuid::new_v4().simple()),
        issue_id,
        kind: body.kind,
        ts: (state.now)(),
        // Same rule as authorship: the actor is who authenticated.
        actor: CollabActor::new(ActorKind::Human, caller.user_id, None)?,
        payload: body.payload,
        operation_id,
    };
    let event = state.store.append_event(&org_id, event).await?;
    Ok((StatusCode::CREATED, Json(event)))
}

// ── Plans and Runs (Batch 7c) ────────────────────────────────────────────────

/// Which workspaces a listing may draw from, given an optional target.
///
/// Naming one workspace is a targeted capability check; naming none returns
/// the union of what this caller may read. Extracted because `list_issues`,
/// `list_plans` and `list_runs` all need exactly this and getting it subtly
/// different in one of them is how a board starts showing somebody else's rows.
async fn listing_scope(
    state: &AppState,
    claims: &cognia_tenant_auth::grant::GrantClaims,
    workspace_id: Option<&str>,
) -> Result<Option<Vec<String>>, Failure> {
    match workspace_id {
        Some(workspace) => {
            authorize_workspace(
                state.store.as_ref(),
                claims,
                workspace,
                WorkspaceCapability::Read,
            )
            .await?;
            Ok(None)
        }
        None => match readable_scope(state.store.as_ref(), claims).await? {
            WorkspaceScope::All => Ok(None),
            WorkspaceScope::Only(workspaces) => Ok(Some(workspaces)),
        },
    }
}

async fn list_plans(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    Query(params): Query<ListPlansParams>,
    headers: HeaderMap,
) -> Result<Json<Vec<Plan>>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let workspace_scope = listing_scope(&state, &claims, params.workspace_id.as_deref()).await?;
    Ok(Json(
        state
            .store
            .list_plans(
                &org_id,
                PlanQuery {
                    workspace_id: params.workspace_id,
                    status: params.status,
                    workspace_scope,
                },
            )
            .await?,
    ))
}

async fn get_plan(
    State(state): State<AppState>,
    Path((org_id, plan_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Plan>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let plan = state
        .store
        .get_plan(&org_id, &plan_id)
        .await?
        .ok_or(Failure::Store(StoreError::NotFound))?;
    authorize_workspace(
        state.store.as_ref(),
        &claims,
        &plan.workspace_id,
        WorkspaceCapability::Read,
    )
    .await?;
    Ok(Json(plan))
}

async fn create_plan(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreatePlanBody>,
) -> Result<(StatusCode, Json<Plan>), Failure> {
    let operation_id = validated_operation_id(body.operation_id)?;
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let caller = authorize_workspace(
        state.store.as_ref(),
        &claims,
        &body.workspace_id,
        WorkspaceCapability::Write,
    )
    .await?;

    if body.title.trim().is_empty() {
        return Err(Failure::BadRequest("a plan needs a title".into()));
    }
    if body.steps.iter().any(|step| step.title.trim().is_empty()) {
        return Err(Failure::BadRequest("every step needs a title".into()));
    }

    // Step ids are assigned here, exactly as issue ids are: the plane's ids are
    // the plane's. A publisher gets them back in the response and patches
    // progress against them.
    let steps = body
        .steps
        .into_iter()
        .enumerate()
        .map(|(index, step)| NewPlanStep {
            id: format!("pstp_{}", Uuid::new_v4().simple()),
            order: index as i32,
            title: step.title,
            description: step.description,
            kind: step.kind,
            status: step.status.unwrap_or(PlanStepStatus::Pending),
        })
        .collect();

    let plan = state
        .store
        .create_plan(NewPlan {
            id: format!("plan_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: body.workspace_id,
            title: body.title,
            description: body.description,
            status: body.status.unwrap_or(PlanStatus::Draft),
            steps,
            // Authorship is who authenticated, never a field on the request.
            created_by: CollabActor::new(ActorKind::Human, caller.user_id, None)?,
            now: (state.now)(),
            operation_id,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(plan)))
}

async fn patch_plan(
    State(state): State<AppState>,
    Path((org_id, plan_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PatchPlanBody>,
) -> Result<Json<Plan>, Failure> {
    let mutation_guard = mutation_guard(body.operation_id, body.base_revision)?;
    // Read first, so the capability check runs against the workspace the plan
    // actually lives in rather than one the caller names.
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let existing = state
        .store
        .get_plan(&org_id, &plan_id)
        .await?
        .ok_or(Failure::Store(StoreError::NotFound))?;
    authorize_workspace(
        state.store.as_ref(),
        &claims,
        &existing.workspace_id,
        WorkspaceCapability::Write,
    )
    .await?;

    let plan = state
        .store
        .patch_plan(
            &org_id,
            &plan_id,
            PlanPatch {
                title: body.title,
                description: body.description,
                status: body.status,
                steps: body
                    .steps
                    .into_iter()
                    .map(|step| PlanStepProgress {
                        id: step.id,
                        status: step.status,
                        result: step.result,
                        error: step.error,
                    })
                    .collect(),
            },
            mutation_guard,
            (state.now)(),
        )
        .await?;
    Ok(Json(plan))
}

async fn list_runs(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    Query(params): Query<ListRunsParams>,
    headers: HeaderMap,
) -> Result<Json<Vec<Run>>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let workspace_scope = listing_scope(&state, &claims, params.workspace_id.as_deref()).await?;
    Ok(Json(
        state
            .store
            .list_runs(
                &org_id,
                RunQuery {
                    workspace_id: params.workspace_id,
                    issue_id: params.issue_id,
                    plan_id: params.plan_id,
                    active_only: params.active,
                    workspace_scope,
                },
            )
            .await?,
    ))
}

async fn create_run(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<CreateRunBody>,
) -> Result<(StatusCode, Json<Run>), Failure> {
    let operation_id = validated_operation_id(body.operation_id)?;
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let caller = authorize_workspace(
        state.store.as_ref(),
        &claims,
        &body.workspace_id,
        WorkspaceCapability::Write,
    )
    .await?;

    if body.title.trim().is_empty() {
        return Err(Failure::BadRequest("a run needs a title".into()));
    }
    let artifacts = body
        .artifacts
        .into_iter()
        .map(ArtifactBody::into_artifact)
        .collect::<Result<Vec<_>, _>>()?;

    let run = state
        .store
        .create_run(NewRun {
            id: format!("run_{}", Uuid::new_v4().simple()),
            org_id,
            workspace_id: body.workspace_id,
            issue_id: body.issue_id,
            plan_id: body.plan_id,
            title: body.title,
            kind: body.kind,
            status: body.status.unwrap_or(RunStatus::Queued),
            started_by: CollabActor::new(ActorKind::Human, caller.user_id, None)?,
            artifacts,
            now: (state.now)(),
            operation_id,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(run)))
}

async fn patch_run(
    State(state): State<AppState>,
    Path((org_id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<PatchRunBody>,
) -> Result<Json<Run>, Failure> {
    let mutation_guard = mutation_guard(body.operation_id, body.base_revision)?;
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let existing = state
        .store
        .get_run(&org_id, &run_id)
        .await?
        .ok_or(Failure::Store(StoreError::NotFound))?;
    authorize_workspace(
        state.store.as_ref(),
        &claims,
        &existing.workspace_id,
        WorkspaceCapability::Write,
    )
    .await?;

    let artifacts = match body.artifacts {
        Some(artifacts) => Some(
            artifacts
                .into_iter()
                .map(ArtifactBody::into_artifact)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        None => None,
    };

    let run = state
        .store
        .patch_run(
            &org_id,
            &run_id,
            RunPatch {
                status: body.status,
                summary: body.summary,
                error: body.error,
                artifacts,
            },
            mutation_guard,
            (state.now)(),
        )
        .await?;
    Ok(Json(run))
}

/// Fetch an issue for a route that needs its workspace before it can decide
/// what the caller may do, returning the verified claims alongside it.
///
/// Gated on a valid grant for this org — not on a workspace capability, which
/// is not knowable until the row is read. That ordering is why the caller must
/// still run [`authorize_workspace`] afterwards; this function alone authorizes
/// nothing beyond "you hold a grant for this org".
///
/// The `NotFound` it returns for an unknown id is indistinguishable from the
/// `Forbidden` a non-member gets on the check that follows, so neither answer
/// tells an outsider which issues exist.
async fn peek_issue(
    state: &AppState,
    org_id: &str,
    issue_id: &str,
    headers: &HeaderMap,
) -> Result<(cognia_tenant_auth::grant::GrantClaims, Issue), Failure> {
    let claims = verify_grant(&state.signer, authorization(headers), org_id).await?;
    let issue = state
        .store
        .get_issue(org_id, issue_id)
        .await?
        .ok_or(Failure::Store(StoreError::NotFound))?;
    Ok((claims, issue))
}

async fn validate_human_assignee(
    state: &AppState,
    org_id: &str,
    workspace_id: &str,
    assignee: Option<&CollabActor>,
) -> Result<(), Failure> {
    let Some(assignee) = assignee.filter(|actor| actor.kind == ActorKind::Human) else {
        return Ok(());
    };
    if state
        .store
        .human_is_workspace_member(org_id, workspace_id, &assignee.id)
        .await?
    {
        Ok(())
    } else {
        Err(Failure::BadRequest(
            "a human assignee must be a current member of this workspace".into(),
        ))
    }
}

async fn authorize_org_management(
    state: &AppState,
    org_id: &str,
    headers: &HeaderMap,
) -> Result<(GrantClaims, OrgRole), Failure> {
    let claims = verify_grant(&state.signer, authorization(headers), org_id).await?;
    let role = state
        .store
        .membership(org_id, claims.user_id.as_str(), None)
        .await?
        .org_role
        .filter(|role| matches!(role, OrgRole::Owner | OrgRole::Admin))
        .ok_or(Failure::Auth(AuthError::Forbidden))?;
    Ok((claims, role))
}

fn authorize_org_role_mutation(
    actor: OrgRole,
    current: Option<OrgRole>,
    requested: Option<OrgRole>,
) -> Result<(), Failure> {
    if actor == OrgRole::Owner {
        return Ok(());
    }
    if actor == OrgRole::Admin
        && current != Some(OrgRole::Owner)
        && requested != Some(OrgRole::Owner)
    {
        return Ok(());
    }
    Err(Failure::Auth(AuthError::Forbidden))
}

async fn authorize_invitation_target(
    state: &AppState,
    claims: &GrantClaims,
    org_role: Option<OrgRole>,
    workspace_id: Option<&str>,
    workspace_role: Option<WorkspaceRole>,
) -> Result<(), Failure> {
    if let Some(role) = org_role {
        let actor = state
            .store
            .membership(claims.org_id.as_str(), claims.user_id.as_str(), None)
            .await?
            .org_role
            .ok_or(Failure::Auth(AuthError::Forbidden))?;
        return authorize_org_role_mutation(actor, None, Some(role));
    }
    let workspace_id = workspace_id
        .ok_or_else(|| Failure::BadRequest("workspace invitation needs workspaceId".into()))?;
    let requested = workspace_role
        .ok_or_else(|| Failure::BadRequest("workspace invitation needs workspaceRole".into()))?;
    authorize_workspace(
        state.store.as_ref(),
        claims,
        workspace_id,
        WorkspaceCapability::Manage,
    )
    .await?;
    let actor_org_role = state
        .store
        .membership(claims.org_id.as_str(), claims.user_id.as_str(), None)
        .await?
        .org_role;
    if matches!(actor_org_role, Some(OrgRole::Owner | OrgRole::Admin))
        || requested != WorkspaceRole::Maintainer
    {
        Ok(())
    } else {
        Err(Failure::Auth(AuthError::Forbidden))
    }
}

async fn authorize_workspace_member_mutation(
    state: &AppState,
    claims: &GrantClaims,
    workspace_id: &str,
    target_user_id: &str,
    requested: Option<WorkspaceRole>,
) -> Result<(), Failure> {
    authorize_workspace(
        state.store.as_ref(),
        claims,
        workspace_id,
        WorkspaceCapability::Manage,
    )
    .await?;
    let actor = state
        .store
        .membership(claims.org_id.as_str(), claims.user_id.as_str(), None)
        .await?;
    if matches!(actor.org_role, Some(OrgRole::Owner | OrgRole::Admin)) {
        return Ok(());
    }
    let target = state
        .store
        .membership(claims.org_id.as_str(), target_user_id, Some(workspace_id))
        .await?;
    if target.workspace_role == Some(WorkspaceRole::Maintainer)
        || requested == Some(WorkspaceRole::Maintainer)
    {
        return Err(Failure::Auth(AuthError::Forbidden));
    }
    Ok(())
}

fn invitation_token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn request_id(headers: &HeaderMap) -> String {
    headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("req_{}", Uuid::new_v4().simple()))
}

fn request_source(headers: &HeaderMap) -> serde_json::Value {
    serde_json::json!({
        "userAgent": headers
            .get(axum::http::header::USER_AGENT)
            .and_then(|value| value.to_str().ok()),
        "forwardedFor": headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok()),
    })
}

fn header_reason(headers: &HeaderMap, fallback: &str) -> String {
    headers
        .get("x-cognia-reason")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn authorization_context(
    claims: &GrantClaims,
    headers: &HeaderMap,
    reason: String,
    now: i64,
) -> AuthorizationContext {
    AuthorizationContext {
        actor_user_id: claims.user_id.to_string(),
        reason,
        request_id: request_id(headers),
        grant_id: Some(claims.grant_id.to_string()),
        source: request_source(headers),
        now,
    }
}

fn authorization(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use axum::body::Body;
    use axum::http::Request;
    use cognia_tenant_auth::grant::GrantClaims;
    use cognia_tenant_auth::{OrgId, OrgRole, UserId, WorkspaceRole};
    use tower::ServiceExt;

    use crate::store::InMemoryStore;

    const ORG: &str = "org_acme00000000000000000";

    fn ada() -> UserId {
        UserId::parse("usr_aaaaaaaaaaaaaaaaaaaaaaaa").unwrap()
    }

    fn bob() -> UserId {
        UserId::parse("usr_bbbbbbbbbbbbbbbbbbbbbbbb").unwrap()
    }

    fn signer() -> GrantSigner {
        GrantSigner::new(&[5; 32]).unwrap()
    }

    fn token_for(user: &UserId) -> String {
        let claims = GrantClaims::issue(
            user.clone(),
            OrgId::parse(ORG).unwrap(),
            None,
            None,
            Duration::from_secs(300),
        )
        .unwrap();
        format!("Bearer {}", signer().sign(&claims).unwrap())
    }

    /// A store with Ada as a workspace member of `proj-1` and Bob outside it.
    fn seeded() -> InMemoryStore {
        let store = InMemoryStore::new();
        store.add_user(ada().as_str(), "Ada");
        store.add_user(bob().as_str(), "Bob");
        store.add_org_member(ORG, ada().as_str(), OrgRole::Member);
        store.add_workspace_member(ORG, "proj-1", ada().as_str(), WorkspaceRole::Member);
        store.add_org_member(ORG, bob().as_str(), OrgRole::Member);
        store
    }

    fn app(store: InMemoryStore) -> Router {
        let mut state = AppState::new(
            Arc::new(store),
            signer(),
            Arc::new(cognia_tenant_auth::oidc::TestAuthenticator),
        );
        state.now = Arc::new(|| 1_000);
        router(state)
    }

    /// `TestAuthenticator` reads `"<tenant>:<scopes>"` and reports a fixed
    /// subject, so an exchange test drives the tenant claim directly.
    const LOGTO_ORG: &str = "logto-org-1";

    fn oidc_token(logto_org: &str) -> String {
        format!("Bearer {logto_org}:collab:read")
    }

    /// The subject `TestAuthenticator` always reports.
    const TEST_SUBJECT: &str = "test-user";

    fn seeded_for_exchange() -> InMemoryStore {
        let store = seeded();
        store.link_org_to_logto(ORG, LOGTO_ORG);
        store.link_external_identity(ORG, "logto", Some(LOGTO_ORG), TEST_SUBJECT, ada().as_str());
        store
    }

    async fn mint(
        store: InMemoryStore,
        token: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        call(
            app(store),
            post(&format!("/v1/orgs/{ORG}/grants"), token, body),
        )
        .await
    }

    async fn call(app: Router, request: Request<Body>) -> (StatusCode, serde_json::Value) {
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        (status, json)
    }

    fn post(path: &str, token: &str, mut body: serde_json::Value) -> Request<Body> {
        if let Some(object) = body.as_object_mut() {
            object.entry("operationId").or_insert_with(|| {
                serde_json::Value::String(format!("test-op-{}", Uuid::new_v4().simple()))
            });
        }
        Request::builder()
            .method("POST")
            .uri(path)
            .header("authorization", token)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn get(path: &str, token: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .header("authorization", token)
            .body(Body::empty())
            .unwrap()
    }

    fn request_with_body(
        method: &str,
        path: &str,
        token: &str,
        body: serde_json::Value,
    ) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", token)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn create_body() -> serde_json::Value {
        serde_json::json!({
            "workspaceId": "proj-1",
            "issueProjectId": "cont-1",
            "title": "Ship it",
        })
    }

    async fn create_issue_as_ada(store: &InMemoryStore) -> String {
        let (status, issue) = call(
            app(store.clone()),
            post(
                &format!("/v1/orgs/{ORG}/issues"),
                &token_for(&ada()),
                create_body(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{issue}");
        issue["id"].as_str().unwrap().to_owned()
    }

    /// A roster with names, and the raw fact a guest is derived from.
    #[tokio::test]
    async fn a_workspace_roster_carries_names_and_org_membership() {
        let store = seeded();
        store.add_workspace(ORG, "proj-1", "Mercury");
        store.add_user(ada().as_str(), "Ada");
        store.add_user(bob().as_str(), "Bob");
        // Bob is in the org but not this workspace; Cleo is a guest in it.
        let cleo = UserId::parse("usr_cccccccccccccccccccccccc").unwrap();
        store.add_workspace_member(ORG, "proj-1", cleo.as_str(), WorkspaceRole::Viewer);
        store.add_user(cleo.as_str(), "Cleo");

        let (status, body) = call(
            app(store),
            get(
                &format!("/v1/orgs/{ORG}/workspaces/proj-1/members"),
                &token_for(&ada()),
            ),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        let members = body.as_array().unwrap();
        assert_eq!(members.len(), 2, "{body}");
        let ada_row = members
            .iter()
            .find(|row| row["userId"] == ada().as_str())
            .unwrap();
        assert_eq!(ada_row["displayName"], "Ada");
        assert_eq!(ada_row["orgMember"], true);
        let cleo_row = members
            .iter()
            .find(|row| row["userId"] == cleo.as_str())
            .unwrap();
        // The raw fact, never the verdict: `personStandingFrom` on the client
        // is the one implementation of "guest".
        assert_eq!(cleo_row["orgMember"], false);
        assert!(cleo_row.get("guest").is_none());
    }

    /// A roster is something you can see because you are in the room, not
    /// because you know the room's id.
    #[tokio::test]
    async fn a_roster_needs_read_access_to_that_workspace() {
        let store = seeded();
        store.add_workspace(ORG, "proj-1", "Mercury");
        // Bob is an org member with no membership in `proj-1`.
        let (status, _) = call(
            app(store),
            get(
                &format!("/v1/orgs/{ORG}/workspaces/proj-1/members"),
                &token_for(&bob()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn workspaces_are_narrowed_to_what_the_caller_was_recruited_into() {
        let store = seeded();
        store.add_workspace(ORG, "proj-1", "Mercury");
        store.add_workspace(ORG, "proj-2", "Venus");

        let (status, body) = call(
            app(store.clone()),
            get(&format!("/v1/orgs/{ORG}/workspaces"), &token_for(&ada())),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let names: Vec<&str> = body
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["Mercury"], "{body}");
    }

    #[tokio::test]
    async fn an_org_admin_traverses_every_workspace() {
        // §4 rejects hiding a workspace from its own org's admin: off-boarding,
        // audit and compliance all need a way in.
        let store = seeded();
        store.add_org_member(ORG, bob().as_str(), OrgRole::Admin);
        store.add_workspace(ORG, "proj-1", "Mercury");
        store.add_workspace(ORG, "proj-2", "Venus");

        let (status, body) = call(
            app(store),
            get(&format!("/v1/orgs/{ORG}/workspaces"), &token_for(&bob())),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body.as_array().unwrap().len(), 2, "{body}");
    }

    #[tokio::test]
    async fn memberships_report_what_the_caller_actually_holds() {
        let (status, body) = call(
            app(seeded()),
            get(
                &format!("/v1/orgs/{ORG}/memberships/me"),
                &token_for(&ada()),
            ),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["userId"], ada().as_str());
        assert_eq!(body["orgId"], ORG);
        assert_eq!(body["orgRole"], "member");
        assert_eq!(body["workspaces"][0]["workspaceId"], "proj-1");
        assert_eq!(body["workspaces"][0]["role"], "member");
    }

    /// A guest is the shape ADR-0149 §4 describes: workspace membership with
    /// no org membership. The server reports the raw facts and never the
    /// verdict — deriving "guest" here as well as on the client would be two
    /// rules to keep in step.
    #[tokio::test]
    async fn a_guest_is_reported_as_facts_not_as_a_verdict() {
        let store = InMemoryStore::new();
        store.add_workspace_member(ORG, "proj-1", ada().as_str(), WorkspaceRole::Viewer);

        let (status, body) = call(
            app(store),
            get(
                &format!("/v1/orgs/{ORG}/memberships/me"),
                &token_for(&ada()),
            ),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.get("orgRole").is_none(), "{body}");
        assert_eq!(body["workspaces"][0]["role"], "viewer");
        assert!(body.get("guest").is_none(), "the verdict is the client's");
    }

    /// Somebody who holds nothing gets an empty answer rather than a refusal.
    /// A 403 here would be indistinguishable from "this org does not exist",
    /// and the caller already proved they hold a grant for it.
    #[tokio::test]
    async fn holding_nothing_is_an_empty_answer_not_a_refusal() {
        let (status, body) = call(
            app(InMemoryStore::new()),
            get(
                &format!("/v1/orgs/{ORG}/memberships/me"),
                &token_for(&ada()),
            ),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.get("orgRole").is_none());
        assert_eq!(body["workspaces"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn memberships_need_a_grant_for_this_org() {
        let other = OrgId::parse("org_other0000000000000000").unwrap();
        let claims = GrantClaims::issue(
            ada(),
            other,
            None,
            None,
            std::time::Duration::from_secs(300),
        )
        .unwrap();
        let foreign = format!("Bearer {}", signer().sign(&claims).unwrap());

        let (status, _) = call(
            app(seeded()),
            get(&format!("/v1/orgs/{ORG}/memberships/me"), &foreign),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn health_needs_no_credentials() {
        let response = app(InMemoryStore::new())
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn an_unauthenticated_request_is_401_not_404() {
        let (status, _) = call(
            app(seeded()),
            Request::builder()
                .uri(format!("/v1/orgs/{ORG}/issues"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn creating_an_issue_stamps_the_authenticated_caller_as_author() {
        // The defect this prevents: accepting `createdBy` from the body would
        // let any member forge authorship.
        let store = seeded();
        let (status, issue) = call(
            app(store.clone()),
            post(
                &format!("/v1/orgs/{ORG}/issues"),
                &token_for(&ada()),
                serde_json::json!({
                    "workspaceId": "proj-1",
                    "issueProjectId": "cont-1",
                    "title": "Ship it",
                    "createdBy": { "kind": "human", "id": bob().as_str() },
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(issue["createdBy"]["id"], ada().as_str());
        assert_eq!(issue["createdBy"]["kind"], "human");
        // Unset fields take their documented defaults, not null.
        assert_eq!(issue["status"], "backlog");
        assert_eq!(issue["priority"], "none");
    }

    #[tokio::test]
    async fn a_member_of_the_org_but_not_the_workspace_cannot_write_to_it() {
        let (status, error) = call(
            app(seeded()),
            post(
                &format!("/v1/orgs/{ORG}/issues"),
                &token_for(&bob()),
                create_body(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    }

    #[tokio::test]
    async fn an_org_admin_may_write_to_a_workspace_they_never_joined() {
        let store = seeded();
        store.add_org_member(ORG, bob().as_str(), OrgRole::Admin);
        let (status, issue) = call(
            app(store),
            post(
                &format!("/v1/orgs/{ORG}/issues"),
                &token_for(&bob()),
                create_body(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{issue}");
    }

    #[tokio::test]
    async fn a_blank_title_is_refused_before_anything_is_written() {
        let store = seeded();
        let (status, _) = call(
            app(store.clone()),
            post(
                &format!("/v1/orgs/{ORG}/issues"),
                &token_for(&ada()),
                serde_json::json!({
                    "workspaceId": "proj-1",
                    "issueProjectId": "cont-1",
                    "title": "   ",
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(store
            .list_issues(ORG, IssueQuery::default())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn an_anonymous_human_assignee_is_a_400_rather_than_a_row() {
        // ADR-0149 §10, at the boundary: the plane refuses to invent an id.
        let (status, error) = call(
            app(seeded()),
            post(
                &format!("/v1/orgs/{ORG}/issues"),
                &token_for(&ada()),
                serde_json::json!({
                    "workspaceId": "proj-1",
                    "issueProjectId": "cont-1",
                    "title": "Ship it",
                    "assignee": { "kind": "human", "id": "local" },
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error["error"].as_str().unwrap().contains("usr_"), "{error}");
    }

    #[tokio::test]
    async fn a_human_assignee_must_exist_and_belong_to_the_workspace() {
        let outsider = UserId::parse("usr_outsider0000000000000000").unwrap();
        let store = seeded();
        store.add_user(outsider.as_str(), "Outsider");
        let (status, error) = call(
            app(store),
            post(
                &format!("/v1/orgs/{ORG}/issues"),
                &token_for(&ada()),
                serde_json::json!({
                    "workspaceId": "proj-1",
                    "issueProjectId": "cont-1",
                    "title": "Ship it",
                    "assignee": { "kind": "human", "id": outsider.as_str() },
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error["error"].as_str().unwrap().contains("current member"));
    }

    #[tokio::test]
    async fn a_grant_for_another_org_is_forbidden_and_says_so() {
        let claims = GrantClaims::issue(
            ada(),
            OrgId::parse("org_elsewhere000000000000").unwrap(),
            None,
            None,
            Duration::from_secs(300),
        )
        .unwrap();
        let token = format!("Bearer {}", signer().sign(&claims).unwrap());
        let (status, error) = call(
            app(seeded()),
            get(&format!("/v1/orgs/{ORG}/issues"), &token),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(error["error"].as_str().unwrap().contains("org_elsewhere"));
    }

    #[tokio::test]
    async fn listing_without_a_workspace_returns_only_what_the_caller_may_read() {
        // The bug this pins: gating an unscoped list on a *workspace*
        // capability makes every ordinary member a 403 instead of a board.
        let store = seeded();
        create_issue_as_ada(&store).await;

        let (status, ada_sees) = call(
            app(store.clone()),
            get(&format!("/v1/orgs/{ORG}/issues"), &token_for(&ada())),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ada_sees.as_array().unwrap().len(), 1);

        // Bob is in the org but in no workspace: an empty board, not an error.
        let (status, bob_sees) = call(
            app(store),
            get(&format!("/v1/orgs/{ORG}/issues"), &token_for(&bob())),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(bob_sees.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn someone_in_neither_the_org_nor_a_workspace_is_forbidden() {
        let outsider = UserId::parse("usr_cccccccccccccccccccccccc").unwrap();
        let (status, _) = call(
            app(seeded()),
            get(&format!("/v1/orgs/{ORG}/issues"), &token_for(&outsider)),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn patching_checks_the_workspace_the_issue_lives_in() {
        let store = seeded();
        let id = create_issue_as_ada(&store).await;

        // Ada may; Bob (org member, not in proj-1) may not.
        let (status, patched) = call(
            app(store.clone()),
            Request::builder()
                .method("PATCH")
                .uri(format!("/v1/orgs/{ORG}/issues/{id}"))
                .header("authorization", token_for(&ada()))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operationId": "patch-in-progress",
                        "baseRevision": 1,
                        "status": "in_progress"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["status"], "in_progress");

        let (status, _) = call(
            app(store),
            Request::builder()
                .method("PATCH")
                .uri(format!("/v1/orgs/{ORG}/issues/{id}"))
                .header("authorization", token_for(&bob()))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operationId": "patch-stolen",
                        "baseRevision": 2,
                        "title": "stolen"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_null_assignee_unassigns_and_an_absent_one_does_not() {
        let store = seeded();
        let id = create_issue_as_ada(&store).await;

        let assign = |body: serde_json::Value| {
            Request::builder()
                .method("PATCH")
                .uri(format!("/v1/orgs/{ORG}/issues/{id}"))
                .header("authorization", token_for(&ada()))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };

        let (_, assigned) = call(
            app(store.clone()),
            assign(serde_json::json!({
                "operationId": "assign",
                "baseRevision": 1,
                "assignee": { "kind": "human", "id": ada().as_str(), "label": "Ada" }
            })),
        )
        .await;
        assert_eq!(assigned["assignee"]["id"], ada().as_str());

        // An unrelated patch leaves the assignee alone…
        let (_, renamed) = call(
            app(store.clone()),
            assign(serde_json::json!({
                "operationId": "rename",
                "baseRevision": 2,
                "title": "Renamed"
            })),
        )
        .await;
        assert_eq!(renamed["assignee"]["id"], ada().as_str());

        // …an explicit null clears it.
        let (_, cleared) = call(
            app(store),
            assign(serde_json::json!({
                "operationId": "unassign",
                "baseRevision": 3,
                "assignee": null
            })),
        )
        .await;
        assert!(cleared.get("assignee").is_none(), "{cleared}");
    }

    #[tokio::test]
    async fn patch_replay_is_successful_and_a_stale_new_operation_returns_authority() {
        let store = seeded();
        let id = create_issue_as_ada(&store).await;
        let path = format!("/v1/orgs/{ORG}/issues/{id}");
        let token = token_for(&ada());

        let first_body = serde_json::json!({
            "operationId": "rename-once",
            "baseRevision": 1,
            "title": "Renamed"
        });
        let (status, first) = call(
            app(store.clone()),
            patch_request(&path, &token, first_body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["revision"], 2);

        let (status, replay) =
            call(app(store.clone()), patch_request(&path, &token, first_body)).await;
        assert_eq!(status, StatusCode::OK, "{replay}");
        assert_eq!(replay, first);

        let (status, conflict) = call(
            app(store),
            patch_request(
                &path,
                &token,
                serde_json::json!({
                    "operationId": "rename-from-stale-copy",
                    "baseRevision": 1,
                    "title": "Overwrite"
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
        assert_eq!(conflict["authoritative"], first);
    }

    #[tokio::test]
    async fn an_unknown_issue_is_not_found_even_for_a_member() {
        let (status, _) = call(
            app(seeded()),
            get(
                &format!("/v1/orgs/{ORG}/issues/iss_nope/events"),
                &token_for(&ada()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn events_record_the_authenticated_actor_and_come_back_in_order() {
        let store = seeded();
        let id = create_issue_as_ada(&store).await;

        let (status, event) = call(
            app(store.clone()),
            post(
                &format!("/v1/orgs/{ORG}/issues/{id}/events"),
                &token_for(&ada()),
                serde_json::json!({ "kind": "commented", "payload": { "body": "on it" } }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{event}");
        assert_eq!(event["actor"]["id"], ada().as_str());
        assert_eq!(event["payload"]["body"], "on it");

        let (status, events) = call(
            app(store),
            get(
                &format!("/v1/orgs/{ORG}/issues/{id}/events"),
                &token_for(&ada()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(events.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_viewer_may_read_the_timeline_but_not_add_to_it() {
        let store = seeded();
        let id = create_issue_as_ada(&store).await;
        store.add_workspace_member(ORG, "proj-1", bob().as_str(), WorkspaceRole::Viewer);

        let (status, _) = call(
            app(store.clone()),
            get(
                &format!("/v1/orgs/{ORG}/issues/{id}/events"),
                &token_for(&bob()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, _) = call(
            app(store),
            post(
                &format!("/v1/orgs/{ORG}/issues/{id}/events"),
                &token_for(&bob()),
                serde_json::json!({ "kind": "commented" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    // ── Grant exchange ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_linked_identity_receives_a_grant_the_other_routes_accept() {
        let store = seeded_for_exchange();
        let (status, minted) = mint(
            store.clone(),
            &oidc_token(LOGTO_ORG),
            serde_json::json!({ "workspaceId": "proj-1" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{minted}");
        assert_eq!(minted["userId"], ada().as_str());
        assert_eq!(minted["orgId"], ORG);

        // The whole point of the endpoint: what it mints must open the door.
        let grant = minted["grant"].as_str().unwrap();
        let (status, issues) = call(
            app(store),
            get(
                &format!("/v1/orgs/{ORG}/issues"),
                &format!("Bearer {grant}"),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{issues}");
    }

    #[tokio::test]
    async fn a_token_for_another_logto_organisation_is_refused() {
        let (status, error) = mint(
            seeded_for_exchange(),
            &oidc_token("logto-org-somebody-else"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    }

    #[tokio::test]
    async fn an_unlinked_subject_is_refused_however_valid_its_token() {
        // You join an org by invitation, not by presenting a token.
        let store = seeded();
        store.link_org_to_logto(ORG, LOGTO_ORG);
        let (status, _) = mint(store, &oidc_token(LOGTO_ORG), serde_json::json!({})).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn an_unlinked_subject_and_a_wrong_org_are_indistinguishable() {
        // Distinguishing them would let a stranger enumerate orgs and subjects.
        let unlinked = {
            let store = seeded();
            store.link_org_to_logto(ORG, LOGTO_ORG);
            mint(store, &oidc_token(LOGTO_ORG), serde_json::json!({})).await
        };
        let wrong_org = mint(
            seeded_for_exchange(),
            &oidc_token("logto-org-somebody-else"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(unlinked.0, wrong_org.0);
        assert_eq!(unlinked.1, wrong_org.1);
    }

    #[tokio::test]
    async fn the_minted_role_is_the_one_storage_says_not_the_one_asked_for() {
        let store = seeded_for_exchange();
        // Ada is a plain `member` of proj-1. A grant for a workspace she is
        // only a viewer in must not let her write.
        store.add_workspace_member(ORG, "proj-2", ada().as_str(), WorkspaceRole::Viewer);
        let (_, minted) = mint(
            store.clone(),
            &oidc_token(LOGTO_ORG),
            serde_json::json!({ "workspaceId": "proj-2" }),
        )
        .await;
        let grant = minted["grant"].as_str().unwrap();

        let (status, _) = call(
            app(store),
            post(
                &format!("/v1/orgs/{ORG}/issues"),
                &format!("Bearer {grant}"),
                serde_json::json!({
                    "workspaceId": "proj-2",
                    "issueProjectId": "cont-1",
                    "title": "nope",
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn an_org_scoped_grant_needs_no_workspace() {
        let (status, minted) = mint(
            seeded_for_exchange(),
            &oidc_token(LOGTO_ORG),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{minted}");
        assert!(minted["expiresAt"].as_i64().unwrap() > 0);
    }

    #[tokio::test]
    async fn the_exchange_still_needs_a_bearer_token() {
        let (status, _) = call(
            app(seeded_for_exchange()),
            Request::builder()
                .method("POST")
                .uri(format!("/v1/orgs/{ORG}/grants"))
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_guest_can_obtain_a_grant_for_the_workspace_they_were_invited_into() {
        // ADR-0149 §4: workspace membership without org membership is a
        // first-class state, and a guest who cannot mint a grant is locked out
        // of the workspace they were deliberately invited to.
        let store = InMemoryStore::new();
        store.link_org_to_logto(ORG, LOGTO_ORG);
        store.link_external_identity(ORG, "logto", Some(LOGTO_ORG), TEST_SUBJECT, ada().as_str());
        store.add_workspace_member(ORG, "proj-1", ada().as_str(), WorkspaceRole::Member);

        let (status, minted) =
            mint(store.clone(), &oidc_token(LOGTO_ORG), serde_json::json!({})).await;
        assert_eq!(status, StatusCode::OK, "{minted}");
        let grant = minted["grant"].as_str().unwrap();
        let (status, memberships) = call(
            app(store),
            get(
                &format!("/v1/orgs/{ORG}/memberships/me"),
                &format!("Bearer {grant}"),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{memberships}");
        assert_eq!(memberships["workspaces"][0]["workspaceId"], "proj-1");
    }

    #[tokio::test]
    async fn an_invitation_is_single_use_and_bootstraps_grant_discovery() {
        let store = InMemoryStore::new();
        store.add_user(ada().as_str(), "Ada");
        store.add_org_member(ORG, ada().as_str(), OrgRole::Owner);
        store.link_org_to_logto(ORG, LOGTO_ORG);

        let (status, created) = call(
            app(store.clone()),
            post(
                &format!("/v1/orgs/{ORG}/invitations"),
                &token_for(&ada()),
                serde_json::json!({
                    "orgRole": "member",
                    "expiresInDays": 7,
                    "reason": "join the release team"
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        let token = created["token"].as_str().unwrap();
        assert_eq!(token.len(), 43, "256 random bits encoded without padding");

        let acceptance = serde_json::json!({ "token": token, "displayName": "New member" });
        let (status, accepted) = call(
            app(store.clone()),
            post(
                &format!("/v1/orgs/{ORG}/invitations/accept"),
                &oidc_token(LOGTO_ORG),
                acceptance.clone(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{accepted}");
        assert_eq!(accepted["invitation"]["orgRole"], "member");

        let (status, _) = call(
            app(store.clone()),
            post(
                &format!("/v1/orgs/{ORG}/invitations/accept"),
                &oidc_token(LOGTO_ORG),
                acceptance,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::GONE);

        let (status, minted) =
            mint(store.clone(), &oidc_token(LOGTO_ORG), serde_json::json!({})).await;
        assert_eq!(status, StatusCode::OK, "{minted}");
        let (status, audit) = call(
            app(store),
            get(&format!("/v1/orgs/{ORG}/audit-events"), &token_for(&ada())),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{audit}");
        assert!(audit
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["action"] == "invitation.redeemed"));
    }

    #[tokio::test]
    async fn an_admin_cannot_grant_or_mutate_an_owner_role() {
        let store = InMemoryStore::new();
        store.add_user(ada().as_str(), "Ada");
        store.add_user(bob().as_str(), "Bob");
        store.add_org_member(ORG, ada().as_str(), OrgRole::Admin);
        store.add_org_member(ORG, bob().as_str(), OrgRole::Owner);

        let (status, _) = call(
            app(store.clone()),
            post(
                &format!("/v1/orgs/{ORG}/invitations"),
                &token_for(&ada()),
                serde_json::json!({ "orgRole": "owner", "reason": "not allowed" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = call(
            app(store),
            request_with_body(
                "PATCH",
                &format!("/v1/orgs/{ORG}/members/{}", bob().as_str()),
                &token_for(&ada()),
                serde_json::json!({ "role": "member", "reason": "not allowed" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn the_last_owner_is_protected_inside_the_store_mutation() {
        let store = InMemoryStore::new();
        store.add_user(ada().as_str(), "Ada");
        store.add_org_member(ORG, ada().as_str(), OrgRole::Owner);
        let (status, body) = call(
            app(store),
            request_with_body(
                "PATCH",
                &format!("/v1/orgs/{ORG}/members/{}", ada().as_str()),
                &token_for(&ada()),
                serde_json::json!({ "role": "member", "reason": "leave" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
    }

    #[tokio::test]
    async fn a_workspace_maintainer_only_manages_member_and_viewer_roles() {
        let store = InMemoryStore::new();
        store.add_user(ada().as_str(), "Ada");
        store.add_user(bob().as_str(), "Bob");
        store.add_workspace(ORG, "proj-1", "Mercury");
        store.add_workspace_member(ORG, "proj-1", ada().as_str(), WorkspaceRole::Maintainer);

        let path = format!(
            "/v1/orgs/{ORG}/workspaces/proj-1/members/{}",
            bob().as_str()
        );
        let (status, _) = call(
            app(store.clone()),
            request_with_body(
                "POST",
                &path,
                &token_for(&ada()),
                serde_json::json!({ "role": "maintainer", "reason": "too much" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = call(
            app(store.clone()),
            request_with_body(
                "POST",
                &path,
                &token_for(&ada()),
                serde_json::json!({ "role": "viewer", "reason": "review access" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let membership = store
            .membership(ORG, bob().as_str(), Some("proj-1"))
            .await
            .unwrap();
        assert_eq!(membership.workspace_role, Some(WorkspaceRole::Viewer));
    }

    // ── Plans and Runs (Batch 7c) ────────────────────────────────────────────

    fn patch_request(path: &str, token: &str, mut body: serde_json::Value) -> Request<Body> {
        if let Some(object) = body.as_object_mut() {
            object.entry("operationId").or_insert_with(|| {
                serde_json::Value::String(format!("test-op-{}", Uuid::new_v4().simple()))
            });
            object
                .entry("baseRevision")
                .or_insert(serde_json::Value::from(1));
        }
        Request::builder()
            .method("PATCH")
            .uri(path)
            .header("authorization", token)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn create_plan_as_ada(store: &InMemoryStore) -> serde_json::Value {
        let (status, plan) = call(
            app(store.clone()),
            post(
                &format!("/v1/orgs/{ORG}/plans"),
                &token_for(&ada()),
                serde_json::json!({
                    "workspaceId": "proj-1",
                    "title": "Migrate the store",
                    "status": "executing",
                    "steps": [
                        { "title": "Read the schema", "kind": "agent_turn" },
                        { "title": "Write the migration", "kind": "tool_call" },
                    ],
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{plan}");
        plan
    }

    async fn create_run_as_ada(
        store: &InMemoryStore,
        body: serde_json::Value,
    ) -> serde_json::Value {
        let (status, run) = call(
            app(store.clone()),
            post(&format!("/v1/orgs/{ORG}/runs"), &token_for(&ada()), body),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{run}");
        run
    }

    #[tokio::test]
    async fn a_plan_is_created_with_server_assigned_step_ids_and_ordered_steps() {
        let store = seeded();
        let plan = create_plan_as_ada(&store).await;

        assert_eq!(plan["totalSteps"], 2);
        assert_eq!(plan["completedSteps"], 0);
        // Authorship is who authenticated, not a field on the request.
        assert_eq!(plan["createdBy"]["id"], ada().as_str());

        let steps = plan["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["order"], 0);
        assert_eq!(steps[1]["order"], 1);
        for step in steps {
            // The plane's ids are the plane's, exactly as an issue's are.
            assert!(step["id"].as_str().unwrap().starts_with("pstp_"), "{step}");
        }
    }

    #[tokio::test]
    async fn a_plan_listing_omits_the_steps_a_detail_read_returns() {
        let store = seeded();
        create_plan_as_ada(&store).await;

        let (status, listed) = call(
            app(store.clone()),
            get(&format!("/v1/orgs/{ORG}/plans"), &token_for(&ada())),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        let rows = listed.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        // Absent, not `[]` — "not asked for" and "there are none" are different
        // answers, and a panel that read `[]` would show an empty plan.
        assert!(rows[0].get("steps").is_none(), "{listed}");
        assert_eq!(rows[0]["totalSteps"], 2);

        let id = rows[0]["id"].as_str().unwrap();
        let (status, one) = call(
            app(store),
            get(&format!("/v1/orgs/{ORG}/plans/{id}"), &token_for(&ada())),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{one}");
        assert_eq!(one["steps"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn plan_progress_moves_the_counts_the_body_cannot_set() {
        let store = seeded();
        let plan = create_plan_as_ada(&store).await;
        let id = plan["id"].as_str().unwrap();
        let step = plan["steps"][0]["id"].as_str().unwrap();

        let (status, patched) = call(
            app(store),
            patch_request(
                &format!("/v1/orgs/{ORG}/plans/{id}"),
                &token_for(&ada()),
                serde_json::json!({
                    "steps": [{ "id": step, "status": "completed", "result": "done" }],
                    // Not a field the body has. If it ever becomes one, this
                    // assertion is what catches the day a client can lie about
                    // its own progress.
                    "totalSteps": 99,
                    "completedSteps": 99,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{patched}");
        assert_eq!(patched["totalSteps"], 2);
        assert_eq!(patched["completedSteps"], 1);
        assert_eq!(patched["steps"][0]["result"], "done");
    }

    #[tokio::test]
    async fn a_plan_outside_the_callers_workspaces_is_invisible_and_unwritable() {
        let store = seeded();
        let plan = create_plan_as_ada(&store).await;
        let id = plan["id"].as_str().unwrap();

        // Bob is in the org but was never recruited into `proj-1`.
        let (status, listed) = call(
            app(store.clone()),
            get(&format!("/v1/orgs/{ORG}/plans"), &token_for(&bob())),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed.as_array().unwrap().len(), 0, "{listed}");

        let (status, _) = call(
            app(store.clone()),
            get(&format!("/v1/orgs/{ORG}/plans/{id}"), &token_for(&bob())),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = call(
            app(store),
            patch_request(
                &format!("/v1/orgs/{ORG}/plans/{id}"),
                &token_for(&bob()),
                serde_json::json!({ "status": "cancelled" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_plan_needs_a_title_and_so_does_every_step() {
        let store = seeded();
        for body in [
            serde_json::json!({ "workspaceId": "proj-1", "title": "   " }),
            serde_json::json!({
                "workspaceId": "proj-1",
                "title": "Fine",
                "steps": [{ "title": " ", "kind": "agent_turn" }],
            }),
        ] {
            let (status, error) = call(
                app(store.clone()),
                post(&format!("/v1/orgs/{ORG}/plans"), &token_for(&ada()), body),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        }
    }

    #[tokio::test]
    async fn a_run_records_who_dispatched_it_and_what_it_produced() {
        let store = seeded();
        let run = create_run_as_ada(
            &store,
            serde_json::json!({
                "workspaceId": "proj-1",
                "issueId": "iss_1",
                "title": "Fix the flake",
                "kind": "agent-task",
                "status": "running",
                "artifacts": [{ "label": "PR #12", "href": "https://example.com/pr/12" }],
            }),
        )
        .await;
        assert_eq!(run["startedBy"]["id"], ada().as_str());
        assert_eq!(run["kind"], "agent-task");
        assert_eq!(run["artifacts"].as_array().unwrap().len(), 1);
        assert!(run.get("endedAt").is_none(), "{run}");

        let id = run["id"].as_str().unwrap();
        let (status, settled) = call(
            app(store),
            patch_request(
                &format!("/v1/orgs/{ORG}/runs/{id}"),
                &token_for(&ada()),
                serde_json::json!({ "status": "succeeded", "summary": "merged" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{settled}");
        assert_eq!(settled["endedAt"], 1_000);
        // Artifacts absent from the patch are left alone, not cleared.
        assert_eq!(settled["artifacts"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_run_link_that_only_opens_on_one_machine_is_refused() {
        // The href would publish the shape of somebody's home directory and
        // open nothing on a colleague's screen.
        let store = seeded();
        let (status, error) = call(
            app(store),
            post(
                &format!("/v1/orgs/{ORG}/runs"),
                &token_for(&ada()),
                serde_json::json!({
                    "workspaceId": "proj-1",
                    "title": "Fix the flake",
                    "kind": "agent-task",
                    "artifacts": [{ "label": "Worktree", "href": "file:///Users/ada/code" }],
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert!(
            error["error"].as_str().unwrap().contains("http"),
            "the refusal should name the rule: {error}"
        );
    }

    #[tokio::test]
    async fn the_active_filter_answers_how_many_agents_are_working() {
        let store = seeded();
        create_run_as_ada(
            &store,
            serde_json::json!({
                "workspaceId": "proj-1",
                "title": "Running one",
                "kind": "agent-task",
                "status": "running",
            }),
        )
        .await;
        create_run_as_ada(
            &store,
            serde_json::json!({
                "workspaceId": "proj-1",
                "title": "Finished one",
                "kind": "agent-team",
                "status": "succeeded",
            }),
        )
        .await;

        let (status, all) = call(
            app(store.clone()),
            get(&format!("/v1/orgs/{ORG}/runs"), &token_for(&ada())),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(all.as_array().unwrap().len(), 2);

        let (status, active) = call(
            app(store),
            get(
                &format!("/v1/orgs/{ORG}/runs?active=true"),
                &token_for(&ada()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{active}");
        let rows = active.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], "Running one");
    }

    #[tokio::test]
    async fn an_unattached_run_is_still_listed_under_its_workspace() {
        let store = seeded();
        let run = create_run_as_ada(
            &store,
            serde_json::json!({
                "workspaceId": "proj-1",
                "title": "Ad-hoc sweep",
                "kind": "agent-task",
            }),
        )
        .await;
        assert!(run.get("issueId").is_none(), "{run}");
        assert!(run.get("planId").is_none(), "{run}");
        // Queued by default: a dispatch nobody has picked up yet.
        assert_eq!(run["status"], "queued");

        let (status, listed) = call(
            app(store),
            get(
                &format!("/v1/orgs/{ORG}/runs?workspaceId=proj-1"),
                &token_for(&ada()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert_eq!(listed.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn runs_outside_the_callers_workspaces_stay_invisible() {
        let store = seeded();
        let run = create_run_as_ada(
            &store,
            serde_json::json!({
                "workspaceId": "proj-1",
                "title": "Fix the flake",
                "kind": "agent-task",
            }),
        )
        .await;
        let id = run["id"].as_str().unwrap();

        let (status, listed) = call(
            app(store.clone()),
            get(&format!("/v1/orgs/{ORG}/runs"), &token_for(&bob())),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed.as_array().unwrap().len(), 0, "{listed}");

        let (status, _) = call(
            app(store),
            patch_request(
                &format!("/v1/orgs/{ORG}/runs/{id}"),
                &token_for(&bob()),
                serde_json::json!({ "status": "cancelled" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
