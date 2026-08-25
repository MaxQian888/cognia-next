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
use cognia_tenant_auth::grant::GrantSigner;
use cognia_tenant_auth::WorkspaceCapability;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{authorize_workspace, readable_scope, verify_grant, AuthError, WorkspaceScope};
use crate::model::{
    ActorError, ActorKind, CollabActor, Issue, IssueEvent, IssuePriority, IssueStatus,
};
use crate::store::{IssuePatch, IssueQuery, NewIssue, Store, StoreError};

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn Store>,
    pub signer: Arc<GrantSigner>,
    /// Injectable so tests can pin timestamps instead of sleeping.
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl AppState {
    pub fn new(store: Arc<dyn Store>, signer: GrantSigner) -> Self {
        Self {
            store,
            signer: Arc::new(signer),
            now: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_millis() as i64)
                    .unwrap_or_default()
            }),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route(
            "/v1/orgs/{org_id}/issues",
            get(list_issues).post(create_issue),
        )
        .route("/v1/orgs/{org_id}/issues/{issue_id}", patch(patch_issue))
        .route(
            "/v1/orgs/{org_id}/issues/{issue_id}/events",
            get(list_events).post(append_event),
        )
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
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
    BadRequest(String),
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
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
                other => {
                    tracing::error!(error = %other, "collaboration store failure");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "storage unavailable".into(),
                    )
                }
            },
            Self::Actor(error) => (StatusCode::BAD_REQUEST, error.to_string()),
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendEventBody {
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async fn list_issues(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    Query(params): Query<ListIssuesParams>,
    headers: HeaderMap,
) -> Result<Json<Vec<Issue>>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;

    // Asking for one workspace is a targeted check. Asking for none returns the
    // union of what the caller may read — an org member recruited into nothing
    // gets an empty board, which is an answer, not an error.
    let workspace_scope = match params.workspace_id.as_deref() {
        Some(workspace) => {
            authorize_workspace(
                state.store.as_ref(),
                &claims,
                workspace,
                WorkspaceCapability::Read,
            )
            .await?;
            None
        }
        None => match readable_scope(state.store.as_ref(), &claims).await? {
            WorkspaceScope::All => None,
            WorkspaceScope::Only(workspaces) => Some(workspaces),
        },
    };

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
    };
    state.store.append_event(&org_id, event.clone()).await?;
    Ok((StatusCode::CREATED, Json(event)))
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
        store.add_org_member(ORG, ada().as_str(), OrgRole::Member);
        store.add_workspace_member(ORG, "proj-1", ada().as_str(), WorkspaceRole::Member);
        store.add_org_member(ORG, bob().as_str(), OrgRole::Member);
        store
    }

    fn app(store: InMemoryStore) -> Router {
        let mut state = AppState::new(Arc::new(store), signer());
        state.now = Arc::new(|| 1_000);
        router(state)
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

    fn post(path: &str, token: &str, body: serde_json::Value) -> Request<Body> {
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
                    serde_json::json!({ "status": "in_progress" }).to_string(),
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
                    serde_json::json!({ "title": "stolen" }).to_string(),
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
                "assignee": { "kind": "human", "id": ada().as_str(), "label": "Ada" }
            })),
        )
        .await;
        assert_eq!(assigned["assignee"]["id"], ada().as_str());

        // An unrelated patch leaves the assignee alone…
        let (_, renamed) = call(
            app(store.clone()),
            assign(serde_json::json!({ "title": "Renamed" })),
        )
        .await;
        assert_eq!(renamed["assignee"]["id"], ada().as_str());

        // …an explicit null clears it.
        let (_, cleared) = call(app(store), assign(serde_json::json!({ "assignee": null }))).await;
        assert!(cleared.get("assignee").is_none(), "{cleared}");
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
}
