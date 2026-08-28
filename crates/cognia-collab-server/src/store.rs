//! Storage for the collaboration plane.
//!
//! Two implementations behind one trait, matching
//! `crates/cognia-ops-controller/src/store.rs`:
//!
//! - [`InMemoryStore`] — what the route tests run against.
//! - [`PgStore`] — production, and the only one that enforces row-level
//!   security.
//!
//! # The honest limitation of this split
//!
//! Tests exercise `InMemoryStore`, so they prove the *routes* and the
//! authorization chain but not the RLS policies, which live in Postgres and
//! only run under `PgStore`. `InMemoryStore` therefore filters by `org_id` in
//! Rust — deliberately duplicating what RLS does — so that a route which
//! forgets to scope a query fails a test rather than passing one and leaking in
//! production. That is a mitigation, not a substitute: the policies themselves
//! need a live database, the way `services/diagnostic-server` proves its own
//! through `compose-e2e`.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use cognia_tenant_auth::rls::SET_TENANT_SQL;
use cognia_tenant_auth::{OrgRole, WorkspaceRole};
use deadpool_postgres::{ManagerConfig, Pool, RecyclingMethod};
use parking_lot::RwLock;
use rustls::{ClientConfig, RootCertStore};
use tokio_postgres::Config;
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::model::{
    ActorError, CollabActor, Issue, IssueEvent, IssuePriority, IssueStatus, Plan, PlanStatus,
    PlanStep, PlanStepKind, PlanStepStatus, Run, RunArtifact, RunKind, RunStatus,
};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("not found")]
    NotFound,
    #[error("stored row is unreadable: {0}")]
    Corrupt(String),
    #[error("database error: {0}")]
    Database(String),
    #[error("revision conflict")]
    Conflict(serde_json::Value),
}

impl From<ActorError> for StoreError {
    fn from(error: ActorError) -> Self {
        Self::Corrupt(error.to_string())
    }
}

/// One person's standing in one org, as the store can see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Membership {
    pub org_role: Option<OrgRole>,
    pub workspace_role: Option<WorkspaceRole>,
}

/// A workspace as the plane knows it — ADR-0149 §6.
///
/// Thin on purpose: roots, trust and provisioning stay local, because they
/// describe one machine's relationship to a checkout and a client acting on
/// somebody else's paths is not a feature.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    /// The local `projectId`, unchanged — ADR-0149 §1 froze that on purpose.
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One person's seat in a workspace, as the roster reports it.
///
/// Carries the person, not just their id, so a roster renders without a second
/// round trip per member — and `guest` is absent because it is derived: the
/// reader knows the org memberships, and the server stating it too would be a
/// second implementation of one rule.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMember {
    pub user_id: String,
    pub display_name: String,
    pub role: WorkspaceRole,
    /// Whether this person also belongs to the org that owns the workspace.
    /// The raw fact; `personStandingFrom` on the client turns it into a word.
    pub org_member: bool,
}

/// One workspace membership, as `GET …/memberships/me` reports it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMembershipRow {
    pub workspace_id: String,
    pub role: WorkspaceRole,
}

/// Complete, operator-supplied seed for one initial tenant and workspace.
/// Stable ids make repeated invocations idempotent.
#[derive(Debug, Clone)]
pub struct OperatorBootstrap {
    pub org_id: String,
    pub org_name: String,
    pub logto_organization_id: String,
    pub user_id: String,
    pub user_name: String,
    pub user_email: Option<String>,
    pub identity_id: String,
    pub identity_provider: String,
    pub identity_subject: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub now: i64,
}

#[derive(Debug, Clone)]
pub struct NewIssue {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub issue_project_id: String,
    pub title: String,
    pub body: Option<String>,
    pub status: IssueStatus,
    pub priority: IssuePriority,
    pub board_order: f64,
    pub assignee: Option<CollabActor>,
    pub created_by: CollabActor,
    pub now: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct IssuePatch {
    pub title: Option<String>,
    pub body: Option<Option<String>>,
    pub status: Option<IssueStatus>,
    pub priority: Option<IssuePriority>,
    pub board_order: Option<f64>,
    /// `Some(None)` unassigns; `None` leaves the assignee alone.
    pub assignee: Option<Option<CollabActor>>,
}

#[derive(Debug, Clone)]
pub struct MutationGuard {
    pub operation_id: String,
    pub base_revision: i64,
}

#[derive(Debug, Clone, Default)]
pub struct IssueQuery {
    pub workspace_id: Option<String>,
    pub issue_project_id: Option<String>,
    pub assignee_id: Option<String>,
    /// Restrict to these workspaces. `None` means unrestricted, which only a
    /// caller who traverses the whole org may ask for; the route decides that,
    /// and passing `Some(vec![])` legitimately yields nothing.
    pub workspace_scope: Option<Vec<String>>,
}

// ── Plans and Runs (Batch 7c) ────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct NewPlanStep {
    pub id: String,
    pub order: i32,
    pub title: String,
    pub description: Option<String>,
    pub kind: PlanStepKind,
    pub status: PlanStepStatus,
}

#[derive(Debug, Clone)]
pub struct NewPlan {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: PlanStatus,
    pub steps: Vec<NewPlanStep>,
    pub created_by: CollabActor,
    pub now: i64,
    pub operation_id: String,
}

/// One step's reported progress.
///
/// Carries no timestamps. `started_at` and `completed_at` are derived from the
/// transition by [`apply_step_progress`], on the server's clock — a plan whose
/// steps are reported by two machines would otherwise render a timeline that
/// runs backwards whenever their clocks disagree.
#[derive(Debug, Clone)]
pub struct PlanStepProgress {
    pub id: String,
    pub status: PlanStepStatus,
    pub result: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PlanPatch {
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub status: Option<PlanStatus>,
    /// Progress for the named steps only. Steps left out keep what they had —
    /// a driver reporting step 3 must not blank steps 1 and 2.
    pub steps: Vec<PlanStepProgress>,
}

#[derive(Debug, Clone, Default)]
pub struct PlanQuery {
    pub workspace_id: Option<String>,
    pub status: Option<PlanStatus>,
    /// Restrict to these workspaces, exactly as [`IssueQuery::workspace_scope`].
    pub workspace_scope: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct NewRun {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub issue_id: Option<String>,
    pub plan_id: Option<String>,
    pub title: String,
    pub kind: RunKind,
    pub status: RunStatus,
    pub started_by: CollabActor,
    pub artifacts: Vec<RunArtifact>,
    pub now: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct RunPatch {
    pub status: Option<RunStatus>,
    pub summary: Option<Option<String>>,
    pub error: Option<Option<String>>,
    /// Replaces the whole set when present. Appending would make an engine that
    /// re-reports its artifacts — which a retried settle does — duplicate every
    /// link it had already published.
    pub artifacts: Option<Vec<RunArtifact>>,
}

#[derive(Debug, Clone, Default)]
pub struct RunQuery {
    pub workspace_id: Option<String>,
    pub issue_id: Option<String>,
    pub plan_id: Option<String>,
    /// Only `queued`/`running`, for the "N agents working" question.
    pub active_only: bool,
    pub workspace_scope: Option<Vec<String>>,
}

// ── Progress rules ───────────────────────────────────────────────────────────
//
// One implementation, used by BOTH stores. Expressing them a second time in
// SQL would give the test double and production two chances to disagree about
// what a plan's progress is, and only one of the two is ever under test.

/// Apply one report to a step, deriving the timestamps from the transition.
///
/// A step that is no longer terminal loses its outcome: `result`, `error` and
/// `completed_at` all clear. That is what a retry is — the step is running
/// again, so the previous answer is not its answer any more, and leaving a
/// stale error beside a step now marked `in_progress` is the shape that makes
/// a reader distrust the whole panel.
pub fn apply_step_progress(step: &mut PlanStep, report: &PlanStepProgress, now: i64) {
    step.status = report.status;
    if report.status == PlanStepStatus::InProgress && step.started_at.is_none() {
        step.started_at = Some(now);
    }
    if is_terminal_step(report.status) {
        step.completed_at = Some(step.completed_at.unwrap_or(now));
        step.result = report.result.clone();
        step.error = report.error.clone();
    } else {
        step.completed_at = None;
        step.result = None;
        step.error = None;
    }
}

/// Mirrors `isTerminalStepStatus` in `types/agent/plan.ts`.
pub fn is_terminal_step(status: PlanStepStatus) -> bool {
    matches!(
        status,
        PlanStepStatus::Completed | PlanStepStatus::Failed | PlanStepStatus::Skipped
    )
}

/// Mirrors `isTerminalPlanStatus`.
pub fn is_terminal_plan(status: PlanStatus) -> bool {
    matches!(
        status,
        PlanStatus::Completed | PlanStatus::Failed | PlanStatus::Cancelled
    )
}

/// `(total, completed)`, recomputed from the stored steps.
///
/// Never taken from a client: two writers reporting different progress for one
/// plan is a disagreement with no tiebreak, and the steps are the tiebreak.
pub fn plan_counts(steps: &[PlanStep]) -> (i32, i32) {
    let completed = steps
        .iter()
        .filter(|step| step.status == PlanStepStatus::Completed)
        .count();
    (steps.len() as i32, completed as i32)
}

/// When a plan or run ended, given where it just moved to.
///
/// Sticky while terminal — a plan that completes twice keeps the first
/// timestamp — and cleared on the way back out, because a plan that is
/// executing again has not ended.
pub fn ended_at_for(terminal: bool, previous: Option<i64>, now: i64) -> Option<i64> {
    if terminal {
        Some(previous.unwrap_or(now))
    } else {
        None
    }
}

#[async_trait]
pub trait Store: Send + Sync {
    /// What `user_id` may do in `org_id` / `workspace_id`.
    ///
    /// Returns the two raw memberships; collapsing them into a decision is
    /// `cognia_tenant_auth::resolve_workspace_access`'s job, and doing it here
    /// would put the authorization rule in two places.
    async fn membership(
        &self,
        org_id: &str,
        user_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Membership, StoreError>;

    /// The Logto organization `org_id` mirrors, if it mirrors one.
    ///
    /// Read inside `org_id`'s own RLS scope, so a caller naming an org they do
    /// not belong to gets `None` rather than a fact about somebody else's org.
    async fn org_logto_id(&self, org_id: &str) -> Result<Option<String>, StoreError>;

    /// The user an external subject is linked to, within `org_id`.
    ///
    /// `None` means the subject has never been linked here. That is the normal
    /// answer for a stranger with a perfectly valid token: you join an org by
    /// invitation, not by presenting one.
    async fn user_for_external_identity(
        &self,
        org_id: &str,
        provider: &str,
        tenant: Option<&str>,
        subject: &str,
    ) -> Result<Option<String>, StoreError>;

    /// Every workspace in `org_id` this person was recruited into.
    ///
    /// Separate from [`Store::membership`] because a listing needs the whole
    /// set while a single-target check needs one row, and issuing the wide
    /// query on every request would be the more expensive of the two.
    /// Every workspace membership this person holds in `org_id`, with the role.
    ///
    /// The role is carried because `GET …/memberships/me` answers with it: the
    /// client's projection needs to know whether somebody is a viewer or a
    /// maintainer to render a roster, and re-deriving that from a list of ids
    /// would mean a second round trip per workspace.
    async fn list_workspace_memberships(
        &self,
        org_id: &str,
        user_id: &str,
    ) -> Result<Vec<WorkspaceMembershipRow>, StoreError>;

    /// Workspaces in this org, narrowed to `visible` when the caller cannot
    /// traverse. Alphabetical, so a roster page has a stable order.
    async fn list_workspaces(
        &self,
        org_id: &str,
        visible: Option<&[String]>,
    ) -> Result<Vec<Workspace>, StoreError>;

    /// Everyone in one workspace, with their name and whether they are also in
    /// the org. Empty for a workspace nobody was recruited into.
    async fn list_workspace_members(
        &self,
        org_id: &str,
        workspace_id: &str,
    ) -> Result<Vec<WorkspaceMember>, StoreError>;

    async fn list_issues(&self, org_id: &str, query: IssueQuery) -> Result<Vec<Issue>, StoreError>;

    async fn get_issue(&self, org_id: &str, id: &str) -> Result<Option<Issue>, StoreError>;

    async fn create_issue(&self, input: NewIssue) -> Result<Issue, StoreError>;

    async fn patch_issue(
        &self,
        org_id: &str,
        id: &str,
        patch: IssuePatch,
        guard: MutationGuard,
        now: i64,
    ) -> Result<Issue, StoreError>;

    async fn append_event(&self, org_id: &str, event: IssueEvent)
        -> Result<IssueEvent, StoreError>;

    async fn list_events(
        &self,
        org_id: &str,
        issue_id: &str,
    ) -> Result<Vec<IssueEvent>, StoreError>;

    /// Plan headers, without their steps.
    ///
    /// A listing deliberately leaves `steps` as `None` rather than `Some(vec![])`
    /// — see [`Plan::steps`]. Fetching every plan's steps to render a list that
    /// shows only the counts would be the expensive half of a query nothing
    /// reads.
    async fn list_plans(&self, org_id: &str, query: PlanQuery) -> Result<Vec<Plan>, StoreError>;

    /// One plan WITH its steps, ordered.
    async fn get_plan(&self, org_id: &str, id: &str) -> Result<Option<Plan>, StoreError>;

    async fn create_plan(&self, input: NewPlan) -> Result<Plan, StoreError>;

    async fn patch_plan(
        &self,
        org_id: &str,
        id: &str,
        patch: PlanPatch,
        guard: MutationGuard,
        now: i64,
    ) -> Result<Plan, StoreError>;

    /// Runs in this org, newest first, with their artifacts.
    async fn list_runs(&self, org_id: &str, query: RunQuery) -> Result<Vec<Run>, StoreError>;

    async fn get_run(&self, org_id: &str, id: &str) -> Result<Option<Run>, StoreError>;

    async fn create_run(&self, input: NewRun) -> Result<Run, StoreError>;

    async fn patch_run(
        &self,
        org_id: &str,
        id: &str,
        patch: RunPatch,
        guard: MutationGuard,
        now: i64,
    ) -> Result<Run, StoreError>;
}

// ── In-memory ────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Tables {
    org_memberships: HashMap<(String, String), OrgRole>,
    /// `(workspace_id, user_id) -> (org_id, role)`, mirroring the columns
    /// `workspace_memberships` actually has. Without the org, a listing
    /// cannot tell one tenant's workspaces from another's.
    workspace_memberships: HashMap<(String, String), (String, WorkspaceRole)>,
    /// `org_id -> logto organization id`
    org_logto_ids: HashMap<String, String>,
    /// `(org_id, provider, tenant, subject) -> user_id`
    external_identities: HashMap<(String, String, String, String), String>,
    /// `(org_id, workspace_id) -> Workspace`
    workspaces: HashMap<(String, String), Workspace>,
    /// `user_id -> display name`, so a roster can be assembled without a
    /// second table the test double does not have.
    users: HashMap<String, String>,
    issues: HashMap<String, Issue>,
    events: Vec<(String, IssueEvent)>,
    /// Plans always hold `steps: Some(..)` in here; `list_plans` strips them,
    /// mirroring what the header-only Postgres query returns.
    plans: HashMap<String, Plan>,
    runs: HashMap<String, Run>,
}

/// Test double. Scopes by `org_id` in Rust on purpose — see the module note.
#[derive(Default, Clone)]
pub struct InMemoryStore {
    tables: Arc<RwLock<Tables>>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_org_member(&self, org_id: &str, user_id: &str, role: OrgRole) {
        self.tables
            .write()
            .org_memberships
            .insert((org_id.to_owned(), user_id.to_owned()), role);
    }

    pub fn link_org_to_logto(&self, org_id: &str, logto_organization_id: &str) {
        self.tables
            .write()
            .org_logto_ids
            .insert(org_id.to_owned(), logto_organization_id.to_owned());
    }

    pub fn link_external_identity(
        &self,
        org_id: &str,
        provider: &str,
        tenant: Option<&str>,
        subject: &str,
        user_id: &str,
    ) {
        self.tables.write().external_identities.insert(
            (
                org_id.to_owned(),
                provider.to_owned(),
                tenant.unwrap_or_default().to_owned(),
                subject.to_owned(),
            ),
            user_id.to_owned(),
        );
    }

    pub fn add_workspace_member(
        &self,
        org_id: &str,
        workspace_id: &str,
        user_id: &str,
        role: WorkspaceRole,
    ) {
        self.tables.write().workspace_memberships.insert(
            (workspace_id.to_owned(), user_id.to_owned()),
            (org_id.to_owned(), role),
        );
    }

    pub fn add_workspace(&self, org_id: &str, workspace_id: &str, name: &str) {
        self.tables.write().workspaces.insert(
            (org_id.to_owned(), workspace_id.to_owned()),
            Workspace {
                id: workspace_id.to_owned(),
                org_id: org_id.to_owned(),
                name: name.to_owned(),
                created_at: 0,
                updated_at: 0,
            },
        );
    }

    pub fn add_user(&self, user_id: &str, display_name: &str) {
        self.tables
            .write()
            .users
            .insert(user_id.to_owned(), display_name.to_owned());
    }
}

#[async_trait]
impl Store for InMemoryStore {
    async fn membership(
        &self,
        org_id: &str,
        user_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Membership, StoreError> {
        let tables = self.tables.read();
        Ok(Membership {
            org_role: tables
                .org_memberships
                .get(&(org_id.to_owned(), user_id.to_owned()))
                .copied(),
            workspace_role: workspace_id.and_then(|workspace| {
                tables
                    .workspace_memberships
                    .get(&(workspace.to_owned(), user_id.to_owned()))
                    .filter(|(org, _)| org == org_id)
                    .map(|(_, role)| *role)
            }),
        })
    }

    async fn org_logto_id(&self, org_id: &str) -> Result<Option<String>, StoreError> {
        Ok(self.tables.read().org_logto_ids.get(org_id).cloned())
    }

    async fn user_for_external_identity(
        &self,
        org_id: &str,
        provider: &str,
        tenant: Option<&str>,
        subject: &str,
    ) -> Result<Option<String>, StoreError> {
        Ok(self
            .tables
            .read()
            .external_identities
            .get(&(
                org_id.to_owned(),
                provider.to_owned(),
                tenant.unwrap_or_default().to_owned(),
                subject.to_owned(),
            ))
            .cloned())
    }

    async fn list_workspace_memberships(
        &self,
        org_id: &str,
        user_id: &str,
    ) -> Result<Vec<WorkspaceMembershipRow>, StoreError> {
        let tables = self.tables.read();
        let mut workspaces: Vec<WorkspaceMembershipRow> = tables
            .workspace_memberships
            .iter()
            .filter(|((_, member), (org, _))| member == user_id && org == org_id)
            .map(|((workspace, _), (_, role))| WorkspaceMembershipRow {
                workspace_id: workspace.clone(),
                role: *role,
            })
            .collect();
        workspaces.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
        Ok(workspaces)
    }

    async fn list_workspaces(
        &self,
        org_id: &str,
        visible: Option<&[String]>,
    ) -> Result<Vec<Workspace>, StoreError> {
        let tables = self.tables.read();
        let mut rows: Vec<Workspace> = tables
            .workspaces
            .iter()
            .filter(|((org, workspace), _)| {
                org == org_id
                    && visible.is_none_or(|allowed| allowed.iter().any(|w| w == workspace))
            })
            .map(|(_, workspace)| workspace.clone())
            .collect();
        rows.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
        Ok(rows)
    }

    async fn list_workspace_members(
        &self,
        org_id: &str,
        workspace_id: &str,
    ) -> Result<Vec<WorkspaceMember>, StoreError> {
        let tables = self.tables.read();
        let mut rows: Vec<WorkspaceMember> = tables
            .workspace_memberships
            .iter()
            .filter(|((workspace, _), (org, _))| workspace == workspace_id && org == org_id)
            .map(|((_, user), (_, role))| WorkspaceMember {
                user_id: user.clone(),
                display_name: tables.users.get(user).cloned().unwrap_or_default(),
                role: *role,
                org_member: tables
                    .org_memberships
                    .contains_key(&(org_id.to_owned(), user.clone())),
            })
            .collect();
        rows.sort_by(|left, right| left.user_id.cmp(&right.user_id));
        Ok(rows)
    }

    async fn list_issues(&self, org_id: &str, query: IssueQuery) -> Result<Vec<Issue>, StoreError> {
        let tables = self.tables.read();
        let mut rows: Vec<Issue> = tables
            .issues
            .values()
            .filter(|issue| issue.org_id == org_id)
            .filter(|issue| {
                query
                    .workspace_scope
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(&issue.workspace_id))
            })
            .filter(|issue| {
                query
                    .workspace_id
                    .as_ref()
                    .is_none_or(|id| &issue.workspace_id == id)
            })
            .filter(|issue| {
                query
                    .issue_project_id
                    .as_ref()
                    .is_none_or(|id| &issue.issue_project_id == id)
            })
            .filter(|issue| {
                query
                    .assignee_id
                    .as_ref()
                    .is_none_or(|id| issue.assignee.as_ref().is_some_and(|actor| &actor.id == id))
            })
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            a.board_order
                .partial_cmp(&b.board_order)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        Ok(rows)
    }

    async fn get_issue(&self, org_id: &str, id: &str) -> Result<Option<Issue>, StoreError> {
        Ok(self
            .tables
            .read()
            .issues
            .get(id)
            .filter(|issue| issue.org_id == org_id)
            .cloned())
    }

    async fn create_issue(&self, input: NewIssue) -> Result<Issue, StoreError> {
        let mut tables = self.tables.write();
        if let Some(existing) = tables
            .issues
            .values()
            .find(|issue| {
                issue.org_id == input.org_id && issue.created_operation_id == input.operation_id
            })
            .cloned()
        {
            return Ok(existing);
        }
        let issue = Issue {
            id: input.id,
            org_id: input.org_id,
            workspace_id: input.workspace_id,
            issue_project_id: input.issue_project_id,
            title: input.title,
            body: input.body,
            status: input.status,
            priority: input.priority,
            board_order: input.board_order,
            assignee: input.assignee,
            created_by: input.created_by,
            created_at: input.now,
            updated_at: input.now,
            revision: 1,
            created_operation_id: input.operation_id.clone(),
            last_operation_id: input.operation_id,
        };
        tables.issues.insert(issue.id.clone(), issue.clone());
        Ok(issue)
    }

    async fn patch_issue(
        &self,
        org_id: &str,
        id: &str,
        patch: IssuePatch,
        guard: MutationGuard,
        now: i64,
    ) -> Result<Issue, StoreError> {
        let mut tables = self.tables.write();
        let issue = tables
            .issues
            .get_mut(id)
            .filter(|issue| issue.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        if issue.last_operation_id == guard.operation_id {
            return Ok(issue.clone());
        }
        if issue.revision != guard.base_revision {
            return Err(StoreError::Conflict(
                serde_json::to_value(issue.clone())
                    .map_err(|error| StoreError::Corrupt(error.to_string()))?,
            ));
        }
        if let Some(title) = patch.title {
            issue.title = title;
        }
        if let Some(body) = patch.body {
            issue.body = body;
        }
        if let Some(status) = patch.status {
            issue.status = status;
        }
        if let Some(priority) = patch.priority {
            issue.priority = priority;
        }
        if let Some(order) = patch.board_order {
            issue.board_order = order;
        }
        if let Some(assignee) = patch.assignee {
            issue.assignee = assignee;
        }
        issue.updated_at = now;
        issue.revision += 1;
        issue.last_operation_id = guard.operation_id;
        Ok(issue.clone())
    }

    async fn append_event(
        &self,
        org_id: &str,
        event: IssueEvent,
    ) -> Result<IssueEvent, StoreError> {
        let mut tables = self.tables.write();
        if let Some((_, existing)) = tables
            .events
            .iter()
            .find(|(org, existing)| org == org_id && existing.operation_id == event.operation_id)
        {
            return Ok(existing.clone());
        }
        tables.events.push((org_id.to_owned(), event.clone()));
        Ok(event)
    }

    async fn list_events(
        &self,
        org_id: &str,
        issue_id: &str,
    ) -> Result<Vec<IssueEvent>, StoreError> {
        let tables = self.tables.read();
        let mut rows: Vec<IssueEvent> = tables
            .events
            .iter()
            .filter(|(org, event)| org == org_id && event.issue_id == issue_id)
            .map(|(_, event)| event.clone())
            .collect();
        rows.sort_by_key(|event| event.ts);
        Ok(rows)
    }

    async fn list_plans(&self, org_id: &str, query: PlanQuery) -> Result<Vec<Plan>, StoreError> {
        let tables = self.tables.read();
        let mut rows: Vec<Plan> = tables
            .plans
            .values()
            .filter(|plan| plan.org_id == org_id)
            .filter(|plan| {
                query
                    .workspace_scope
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(&plan.workspace_id))
            })
            .filter(|plan| {
                query
                    .workspace_id
                    .as_ref()
                    .is_none_or(|id| &plan.workspace_id == id)
            })
            .filter(|plan| query.status.is_none_or(|status| plan.status == status))
            // A listing carries no steps, matching what Postgres returns from
            // the header-only query.
            .map(|plan| Plan {
                steps: None,
                ..plan.clone()
            })
            .collect();
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(rows)
    }

    async fn get_plan(&self, org_id: &str, id: &str) -> Result<Option<Plan>, StoreError> {
        Ok(self
            .tables
            .read()
            .plans
            .get(id)
            .filter(|plan| plan.org_id == org_id)
            .cloned())
    }

    async fn create_plan(&self, input: NewPlan) -> Result<Plan, StoreError> {
        let mut tables = self.tables.write();
        if let Some(existing) = tables
            .plans
            .values()
            .find(|plan| {
                plan.org_id == input.org_id && plan.created_operation_id == input.operation_id
            })
            .cloned()
        {
            return Ok(existing);
        }
        let steps: Vec<PlanStep> = input
            .steps
            .into_iter()
            .map(|step| PlanStep {
                id: step.id,
                plan_id: input.id.clone(),
                order: step.order,
                title: step.title,
                description: step.description,
                kind: step.kind,
                status: step.status,
                result: None,
                error: None,
                started_at: None,
                completed_at: None,
            })
            .collect();
        let (total, completed) = plan_counts(&steps);
        let plan = Plan {
            id: input.id,
            org_id: input.org_id,
            workspace_id: input.workspace_id,
            title: input.title,
            description: input.description,
            status: input.status,
            total_steps: total,
            completed_steps: completed,
            created_by: input.created_by,
            created_at: input.now,
            updated_at: input.now,
            revision: 1,
            created_operation_id: input.operation_id.clone(),
            last_operation_id: input.operation_id,
            ended_at: ended_at_for(is_terminal_plan(input.status), None, input.now),
            steps: Some(steps),
        };
        tables.plans.insert(plan.id.clone(), plan.clone());
        Ok(plan)
    }

    async fn patch_plan(
        &self,
        org_id: &str,
        id: &str,
        patch: PlanPatch,
        guard: MutationGuard,
        now: i64,
    ) -> Result<Plan, StoreError> {
        let mut tables = self.tables.write();
        let plan = tables
            .plans
            .get_mut(id)
            .filter(|plan| plan.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        if plan.last_operation_id == guard.operation_id {
            return Ok(plan.clone());
        }
        if plan.revision != guard.base_revision {
            return Err(StoreError::Conflict(
                serde_json::to_value(plan.clone())
                    .map_err(|error| StoreError::Corrupt(error.to_string()))?,
            ));
        }
        if let Some(title) = patch.title {
            plan.title = title;
        }
        if let Some(description) = patch.description {
            plan.description = description;
        }
        if let Some(status) = patch.status {
            plan.status = status;
        }
        let steps = plan.steps.get_or_insert_with(Vec::new);
        for report in &patch.steps {
            let Some(step) = steps.iter_mut().find(|step| step.id == report.id) else {
                // A report for a step this plan does not have. Refused rather
                // than inserted: a step that appeared from a patch would have no
                // order, no kind and no title, which is not a step.
                return Err(StoreError::NotFound);
            };
            apply_step_progress(step, report, now);
        }
        let (total, completed) = plan_counts(steps);
        plan.total_steps = total;
        plan.completed_steps = completed;
        plan.ended_at = ended_at_for(is_terminal_plan(plan.status), plan.ended_at, now);
        plan.updated_at = now;
        plan.revision += 1;
        plan.last_operation_id = guard.operation_id;
        Ok(plan.clone())
    }

    async fn list_runs(&self, org_id: &str, query: RunQuery) -> Result<Vec<Run>, StoreError> {
        let tables = self.tables.read();
        let mut rows: Vec<Run> = tables
            .runs
            .values()
            .filter(|run| run.org_id == org_id)
            .filter(|run| {
                query
                    .workspace_scope
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(&run.workspace_id))
            })
            .filter(|run| {
                query
                    .workspace_id
                    .as_ref()
                    .is_none_or(|id| &run.workspace_id == id)
            })
            .filter(|run| {
                query
                    .issue_id
                    .as_ref()
                    .is_none_or(|id| run.issue_id.as_ref() == Some(id))
            })
            .filter(|run| {
                query
                    .plan_id
                    .as_ref()
                    .is_none_or(|id| run.plan_id.as_ref() == Some(id))
            })
            .filter(|run| !query.active_only || run.status.is_active())
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            b.started_at
                .cmp(&a.started_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(rows)
    }

    async fn get_run(&self, org_id: &str, id: &str) -> Result<Option<Run>, StoreError> {
        Ok(self
            .tables
            .read()
            .runs
            .get(id)
            .filter(|run| run.org_id == org_id)
            .cloned())
    }

    async fn create_run(&self, input: NewRun) -> Result<Run, StoreError> {
        let mut tables = self.tables.write();
        if let Some(existing) = tables
            .runs
            .values()
            .find(|run| {
                run.org_id == input.org_id && run.created_operation_id == input.operation_id
            })
            .cloned()
        {
            return Ok(existing);
        }
        let run = Run {
            id: input.id,
            org_id: input.org_id,
            workspace_id: input.workspace_id,
            issue_id: input.issue_id,
            plan_id: input.plan_id,
            title: input.title,
            kind: input.kind,
            status: input.status,
            started_by: input.started_by,
            started_at: input.now,
            updated_at: input.now,
            revision: 1,
            created_operation_id: input.operation_id.clone(),
            last_operation_id: input.operation_id,
            ended_at: ended_at_for(!input.status.is_active(), None, input.now),
            summary: None,
            error: None,
            artifacts: input.artifacts,
        };
        tables.runs.insert(run.id.clone(), run.clone());
        Ok(run)
    }

    async fn patch_run(
        &self,
        org_id: &str,
        id: &str,
        patch: RunPatch,
        guard: MutationGuard,
        now: i64,
    ) -> Result<Run, StoreError> {
        let mut tables = self.tables.write();
        let run = tables
            .runs
            .get_mut(id)
            .filter(|run| run.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        if run.last_operation_id == guard.operation_id {
            return Ok(run.clone());
        }
        if run.revision != guard.base_revision {
            return Err(StoreError::Conflict(
                serde_json::to_value(run.clone())
                    .map_err(|error| StoreError::Corrupt(error.to_string()))?,
            ));
        }
        if let Some(status) = patch.status {
            run.status = status;
        }
        if let Some(summary) = patch.summary {
            run.summary = summary;
        }
        if let Some(error) = patch.error {
            run.error = error;
        }
        if let Some(artifacts) = patch.artifacts {
            run.artifacts = artifacts;
        }
        run.ended_at = ended_at_for(!run.status.is_active(), run.ended_at, now);
        run.updated_at = now;
        run.revision += 1;
        run.last_operation_id = guard.operation_id;
        Ok(run.clone())
    }
}

// ── Postgres ─────────────────────────────────────────────────────────────────

const ISSUE_COLUMNS: &str = "id, org_id, workspace_id, issue_project_id, title, body, status, \
     priority, board_order, assignee_kind, assignee_id, created_by_kind, created_by_id, \
     created_at, updated_at, revision, created_operation_id, last_operation_id";

pub struct PgStore {
    pool: Pool,
}

impl PgStore {
    pub async fn connect(database_url: &str, max_connections: usize) -> anyhow::Result<Self> {
        let config: Config = database_url.parse()?;
        let native_certificates = rustls_native_certs::load_native_certs();
        if !native_certificates.errors.is_empty() {
            tracing::warn!(
                errors = ?native_certificates.errors,
                "some native root certificates could not be loaded"
            );
        }
        let mut root_store = RootCertStore::empty();
        for certificate in native_certificates.certs {
            root_store.add(certificate)?;
        }
        let tls = MakeRustlsConnect::new(
            ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth(),
        );
        let manager = deadpool_postgres::Manager::from_config(
            config,
            tls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(max_connections)
            .build()
            .map_err(|error| anyhow::anyhow!(error))?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> anyhow::Result<()> {
        let client = self.pool.get().await?;
        client
            .batch_execute(include_str!("../migrations/0001_collab.sql"))
            .await?;
        client
            .batch_execute(include_str!("../migrations/0002_workspaces.sql"))
            .await?;
        client
            .batch_execute(include_str!("../migrations/0003_plans_runs.sql"))
            .await?;
        client
            .batch_execute(include_str!("../migrations/0004_write_concurrency.sql"))
            .await?;
        Ok(())
    }

    /// Idempotently seed the first operator-owned tenant.
    ///
    /// This deliberately requires a database role allowed to bypass RLS, and
    /// that is NOT the same requirement the server has: every table carries
    /// `FORCE ROW LEVEL SECURITY`, so owning them is not enough. The seed is
    /// also chicken-and-egg — `users` is visible only to a tenant the person
    /// already belongs to, and the membership that would grant that visibility
    /// is one of the rows being inserted — so simply setting `app.tenant_id`
    /// cannot work either. Point the bootstrap at a superuser / `BYPASSRLS`
    /// connection (`COLLAB_BOOTSTRAP_DATABASE_URL`); the request pool keeps the
    /// least-privilege role. The public API cannot call this; the standalone
    /// bootstrap binary is the only caller.
    pub async fn bootstrap_operator(&self, input: &OperatorBootstrap) -> anyhow::Result<()> {
        let mut client = self.pool.get().await?;
        // Checked up front so a least-privilege role fails with the fix rather
        // than with Postgres' "query would be affected by row-level security
        // policy for table \"orgs\"" on the first INSERT.
        let can_bypass: bool = client
            .query_one(
                "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user",
                &[],
            )
            .await?
            .get(0);
        if !can_bypass {
            anyhow::bail!(
                "collaboration bootstrap needs a database role that bypasses row-level security \
                 (SUPERUSER or BYPASSRLS); the current role cannot. Point \
                 COLLAB_BOOTSTRAP_DATABASE_URL at an admin connection, or run \
                 `ALTER ROLE <role> BYPASSRLS`."
            )
        }
        let transaction = client.transaction().await?;
        transaction
            .batch_execute("SET LOCAL row_security = off")
            .await?;
        transaction
            .execute(
                "INSERT INTO orgs (id, display_name, logto_organization_id, created_at, updated_at) \
                 VALUES ($1, $2, $3, $4, $4) \
                 ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, \
                   logto_organization_id = EXCLUDED.logto_organization_id, updated_at = EXCLUDED.updated_at",
                &[&input.org_id, &input.org_name, &input.logto_organization_id, &input.now],
            )
            .await?;
        transaction
            .execute(
                "INSERT INTO users (id, display_name, email, created_at, updated_at) \
                 VALUES ($1, $2, $3, $4, $4) \
                 ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, \
                   email = EXCLUDED.email, updated_at = EXCLUDED.updated_at",
                &[
                    &input.user_id,
                    &input.user_name,
                    &input.user_email,
                    &input.now,
                ],
            )
            .await?;
        transaction
            .execute(
                "INSERT INTO external_identities \
                   (id, user_id, provider, subject, tenant, label, linked_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7) \
                 ON CONFLICT (provider, tenant, subject) DO UPDATE SET \
                   user_id = EXCLUDED.user_id, label = EXCLUDED.label, linked_at = EXCLUDED.linked_at",
                &[
                    &input.identity_id,
                    &input.user_id,
                    &input.identity_provider,
                    &input.identity_subject,
                    &Some(input.logto_organization_id.clone()),
                    &Some(input.user_name.clone()),
                    &input.now,
                ],
            )
            .await?;
        transaction
            .execute(
                "INSERT INTO org_memberships (org_id, user_id, role, created_at, updated_at) \
                 VALUES ($1, $2, 'owner', $3, $3) \
                 ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner', updated_at = EXCLUDED.updated_at",
                &[&input.org_id, &input.user_id, &input.now],
            )
            .await?;
        transaction
            .execute(
                "INSERT INTO workspaces (id, org_id, name, created_at, updated_at) \
                 VALUES ($1, $2, $3, $4, $4) \
                 ON CONFLICT (org_id, id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at",
                &[&input.workspace_id, &input.org_id, &input.workspace_name, &input.now],
            )
            .await?;
        transaction
            .execute(
                "INSERT INTO workspace_memberships \
                   (workspace_id, user_id, org_id, role, created_at, updated_at) \
                 VALUES ($1, $2, $3, 'maintainer', $4, $4) \
                 ON CONFLICT (workspace_id, user_id) DO UPDATE SET \
                   org_id = EXCLUDED.org_id, role = 'maintainer', updated_at = EXCLUDED.updated_at",
                &[
                    &input.workspace_id,
                    &input.user_id,
                    &input.org_id,
                    &input.now,
                ],
            )
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Open a transaction with `app.tenant_id` bound to `org_id`.
    ///
    /// Every read and write goes through here. The bind is transaction-local
    /// (see `cognia_tenant_auth::rls`), so a pooled connection cannot carry one
    /// tenant's scope into the next request — and because the bind and the
    /// query share a transaction, there is no window in which a statement runs
    /// unscoped.
    async fn scoped<'a>(
        &self,
        client: &'a mut deadpool_postgres::Client,
        org_id: &str,
    ) -> Result<deadpool_postgres::Transaction<'a>, StoreError> {
        let transaction = client
            .transaction()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        transaction
            .execute(SET_TENANT_SQL, &[&org_id])
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(transaction)
    }

    async fn client(&self) -> Result<deadpool_postgres::Client, StoreError> {
        self.pool
            .get()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))
    }
}

fn issue_from_row(row: &tokio_postgres::Row) -> Result<Issue, StoreError> {
    let status: String = row.get("status");
    let priority: String = row.get("priority");
    let assignee_kind: Option<String> = row.get("assignee_kind");
    let assignee_id: Option<String> = row.get("assignee_id");
    let assignee = match (assignee_kind, assignee_id) {
        (Some(kind), Some(id)) => Some(CollabActor::from_columns(&kind, &id, None)?),
        // The `issues_assignee_complete` constraint makes a half-present
        // assignee unrepresentable, so this arm is a corrupt row, not a state.
        (None, None) => None,
        _ => {
            return Err(StoreError::Corrupt(
                "assignee kind and id must be present together".into(),
            ))
        }
    };
    Ok(Issue {
        id: row.get("id"),
        org_id: row.get("org_id"),
        workspace_id: row.get("workspace_id"),
        issue_project_id: row.get("issue_project_id"),
        title: row.get("title"),
        body: row.get("body"),
        status: IssueStatus::parse(&status)
            .ok_or_else(|| StoreError::Corrupt(format!("unknown status `{status}`")))?,
        priority: IssuePriority::parse(&priority)
            .ok_or_else(|| StoreError::Corrupt(format!("unknown priority `{priority}`")))?,
        board_order: row.get("board_order"),
        assignee,
        created_by: CollabActor::from_columns(
            &row.get::<_, String>("created_by_kind"),
            &row.get::<_, String>("created_by_id"),
            None,
        )?,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        revision: row.get("revision"),
        created_operation_id: row.get("created_operation_id"),
        last_operation_id: row.get("last_operation_id"),
    })
}

const PLAN_COLUMNS: &str = "id, org_id, workspace_id, title, description, status, total_steps, \
     completed_steps, created_by_kind, created_by_id, created_at, updated_at, ended_at, revision, \
     created_operation_id, last_operation_id";

const PLAN_STEP_COLUMNS: &str = "id, org_id, plan_id, step_order, title, description, kind, \
     status, result, error, started_at, completed_at";

const RUN_COLUMNS: &str = "id, org_id, workspace_id, issue_id, plan_id, title, kind, status, \
     started_by_kind, started_by_id, started_at, updated_at, ended_at, summary, error, revision, \
     created_operation_id, last_operation_id";

fn plan_from_row(
    row: &tokio_postgres::Row,
    steps: Option<Vec<PlanStep>>,
) -> Result<Plan, StoreError> {
    let status: String = row.get("status");
    Ok(Plan {
        id: row.get("id"),
        org_id: row.get("org_id"),
        workspace_id: row.get("workspace_id"),
        title: row.get("title"),
        description: row.get("description"),
        status: PlanStatus::parse(&status)
            .ok_or_else(|| StoreError::Corrupt(format!("unknown plan status `{status}`")))?,
        total_steps: row.get("total_steps"),
        completed_steps: row.get("completed_steps"),
        created_by: CollabActor::from_columns(
            &row.get::<_, String>("created_by_kind"),
            &row.get::<_, String>("created_by_id"),
            None,
        )?,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        revision: row.get("revision"),
        created_operation_id: row.get("created_operation_id"),
        last_operation_id: row.get("last_operation_id"),
        ended_at: row.get("ended_at"),
        steps,
    })
}

fn plan_step_from_row(row: &tokio_postgres::Row) -> Result<PlanStep, StoreError> {
    let kind: String = row.get("kind");
    let status: String = row.get("status");
    Ok(PlanStep {
        id: row.get("id"),
        plan_id: row.get("plan_id"),
        order: row.get("step_order"),
        title: row.get("title"),
        description: row.get("description"),
        kind: PlanStepKind::parse(&kind)
            .ok_or_else(|| StoreError::Corrupt(format!("unknown step kind `{kind}`")))?,
        status: PlanStepStatus::parse(&status)
            .ok_or_else(|| StoreError::Corrupt(format!("unknown step status `{status}`")))?,
        result: row.get("result"),
        error: row.get("error"),
        started_at: row.get("started_at"),
        completed_at: row.get("completed_at"),
    })
}

fn run_from_row(row: &tokio_postgres::Row, artifacts: Vec<RunArtifact>) -> Result<Run, StoreError> {
    let kind: String = row.get("kind");
    let status: String = row.get("status");
    Ok(Run {
        id: row.get("id"),
        org_id: row.get("org_id"),
        workspace_id: row.get("workspace_id"),
        issue_id: row.get("issue_id"),
        plan_id: row.get("plan_id"),
        title: row.get("title"),
        kind: RunKind::parse(&kind)
            .ok_or_else(|| StoreError::Corrupt(format!("unknown run kind `{kind}`")))?,
        status: RunStatus::parse(&status)
            .ok_or_else(|| StoreError::Corrupt(format!("unknown run status `{status}`")))?,
        started_by: CollabActor::from_columns(
            &row.get::<_, String>("started_by_kind"),
            &row.get::<_, String>("started_by_id"),
            None,
        )?,
        started_at: row.get("started_at"),
        updated_at: row.get("updated_at"),
        revision: row.get("revision"),
        created_operation_id: row.get("created_operation_id"),
        last_operation_id: row.get("last_operation_id"),
        ended_at: row.get("ended_at"),
        summary: row.get("summary"),
        error: row.get("error"),
        artifacts,
    })
}

async fn read_plan_steps(
    transaction: &deadpool_postgres::Transaction<'_>,
    org_id: &str,
    plan_id: &str,
) -> Result<Vec<PlanStep>, StoreError> {
    let rows = transaction
        .query(
            &format!(
                "SELECT {PLAN_STEP_COLUMNS} FROM plan_steps \
                 WHERE org_id = $1 AND plan_id = $2 ORDER BY step_order ASC, id ASC"
            ),
            &[&org_id, &plan_id],
        )
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
    rows.iter().map(plan_step_from_row).collect()
}

async fn insert_plan_step(
    transaction: &deadpool_postgres::Transaction<'_>,
    org_id: &str,
    step: &PlanStep,
) -> Result<(), StoreError> {
    transaction
        .execute(
            &format!(
                "INSERT INTO plan_steps ({PLAN_STEP_COLUMNS}) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)"
            ),
            &[
                &step.id,
                &org_id,
                &step.plan_id,
                &step.order,
                &step.title,
                &step.description,
                &step.kind.as_str(),
                &step.status.as_str(),
                &step.result,
                &step.error,
                &step.started_at,
                &step.completed_at,
            ],
        )
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
    Ok(())
}

async fn read_run_artifacts(
    transaction: &deadpool_postgres::Transaction<'_>,
    org_id: &str,
    run_id: &str,
) -> Result<Vec<RunArtifact>, StoreError> {
    let rows = transaction
        .query(
            "SELECT label, href FROM run_artifacts \
             WHERE org_id = $1 AND run_id = $2 ORDER BY id ASC",
            &[&org_id, &run_id],
        )
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
    Ok(rows
        .iter()
        .map(|row| RunArtifact {
            label: row.get("label"),
            href: row.get("href"),
        })
        .collect())
}

/// Replace a run's whole artifact set.
///
/// Delete-then-insert rather than an upsert: an engine that re-reports fewer
/// artifacts than last time means it withdrew one, and an upsert would leave
/// the withdrawn link on a colleague's screen forever.
async fn replace_run_artifacts(
    transaction: &deadpool_postgres::Transaction<'_>,
    org_id: &str,
    run_id: &str,
    artifacts: &[RunArtifact],
) -> Result<(), StoreError> {
    transaction
        .execute(
            "DELETE FROM run_artifacts WHERE org_id = $1 AND run_id = $2",
            &[&org_id, &run_id],
        )
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
    for (index, artifact) in artifacts.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO run_artifacts (id, org_id, run_id, label, href) \
                 VALUES ($1, $2, $3, $4, $5)",
                &[
                    // Ordinal-suffixed rather than random: the ORDER BY id in
                    // `read_run_artifacts` is what preserves the order the
                    // engine reported, and a uuid would shuffle it on rewrite.
                    &format!("{run_id}#{index:04}"),
                    &org_id,
                    &run_id,
                    &artifact.label,
                    &artifact.href,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
    }
    Ok(())
}

#[async_trait]
impl Store for PgStore {
    async fn membership(
        &self,
        org_id: &str,
        user_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Membership, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;

        let org_row = transaction
            .query_opt(
                "SELECT role FROM org_memberships WHERE org_id = $1 AND user_id = $2",
                &[&org_id, &user_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let org_role = org_row
            .map(|row| {
                let role: String = row.get("role");
                OrgRole::parse(&role).map_err(|error| StoreError::Corrupt(error.to_string()))
            })
            .transpose()?;

        let workspace_role = match workspace_id {
            Some(workspace) => transaction
                .query_opt(
                    "SELECT role FROM workspace_memberships \
                     WHERE workspace_id = $1 AND user_id = $2",
                    &[&workspace, &user_id],
                )
                .await
                .map_err(|error| StoreError::Database(error.to_string()))?
                .map(|row| {
                    let role: String = row.get("role");
                    WorkspaceRole::parse(&role)
                        .map_err(|error| StoreError::Corrupt(error.to_string()))
                })
                .transpose()?,
            None => None,
        };

        Ok(Membership {
            org_role,
            workspace_role,
        })
    }

    async fn org_logto_id(&self, org_id: &str) -> Result<Option<String>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let row = transaction
            .query_opt(
                "SELECT logto_organization_id FROM orgs WHERE id = $1",
                &[&org_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(row.and_then(|row| row.get("logto_organization_id")))
    }

    async fn user_for_external_identity(
        &self,
        org_id: &str,
        provider: &str,
        tenant: Option<&str>,
        subject: &str,
    ) -> Result<Option<String>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        // `tenant IS NOT DISTINCT FROM $2` so a provider with no tenant concept
        // matches its NULL rows; plain `=` would never match them.
        let row = transaction
            .query_opt(
                "SELECT user_id FROM external_identities \
                 WHERE provider = $1 AND tenant IS NOT DISTINCT FROM $2 AND subject = $3",
                &[&provider, &tenant, &subject],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(row.map(|row| row.get("user_id")))
    }

    async fn list_workspace_memberships(
        &self,
        org_id: &str,
        user_id: &str,
    ) -> Result<Vec<WorkspaceMembershipRow>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let rows = transaction
            .query(
                "SELECT workspace_id, role FROM workspace_memberships \
                 WHERE org_id = $1 AND user_id = $2 ORDER BY workspace_id",
                &[&org_id, &user_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        rows.iter()
            .map(|row| {
                let raw: String = row.get("role");
                Ok(WorkspaceMembershipRow {
                    workspace_id: row.get("workspace_id"),
                    role: WorkspaceRole::parse(&raw)
                        .map_err(|error| StoreError::Corrupt(error.to_string()))?,
                })
            })
            .collect()
    }

    async fn list_workspaces(
        &self,
        org_id: &str,
        visible: Option<&[String]>,
    ) -> Result<Vec<Workspace>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        // `$2::text[] IS NULL` keeps one prepared statement for both the
        // traversing caller and the one narrowed to their own workspaces.
        let rows = transaction
            .query(
                "SELECT id, org_id, name, created_at, updated_at FROM workspaces \
                 WHERE org_id = $1 AND ($2::text[] IS NULL OR id = ANY($2)) \
                 ORDER BY name, id",
                &[&org_id, &visible],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(rows
            .iter()
            .map(|row| Workspace {
                id: row.get("id"),
                org_id: row.get("org_id"),
                name: row.get("name"),
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
            })
            .collect())
    }

    async fn list_workspace_members(
        &self,
        org_id: &str,
        workspace_id: &str,
    ) -> Result<Vec<WorkspaceMember>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        // One statement rather than a roster read plus a membership probe per
        // person: `org_member` is the fact a guest is derived from, and asking
        // for it N times is how a ten-person workspace becomes eleven queries.
        let rows = transaction
            .query(
                "SELECT w.user_id, u.display_name, w.role, \
                        (o.user_id IS NOT NULL) AS org_member \
                 FROM workspace_memberships w \
                 JOIN users u ON u.id = w.user_id \
                 LEFT JOIN org_memberships o \
                   ON o.user_id = w.user_id AND o.org_id = w.org_id \
                 WHERE w.org_id = $1 AND w.workspace_id = $2 \
                 ORDER BY u.display_name, w.user_id",
                &[&org_id, &workspace_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        rows.iter()
            .map(|row| {
                let raw: String = row.get("role");
                Ok(WorkspaceMember {
                    user_id: row.get("user_id"),
                    display_name: row.get("display_name"),
                    role: WorkspaceRole::parse(&raw)
                        .map_err(|error| StoreError::Corrupt(error.to_string()))?,
                    org_member: row.get("org_member"),
                })
            })
            .collect()
    }

    async fn list_issues(&self, org_id: &str, query: IssueQuery) -> Result<Vec<Issue>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        // RLS already scopes to the tenant; `org_id = $1` is repeated in the
        // WHERE clause so a misconfigured database (policies dropped, table
        // owner exempt) degrades to correct-but-slow rather than to a leak.
        let rows = transaction
            .query(
                &format!(
                    "SELECT {ISSUE_COLUMNS} FROM issues \
                     WHERE org_id = $1 \
                       AND ($2::text IS NULL OR workspace_id = $2) \
                       AND ($3::text IS NULL OR issue_project_id = $3) \
                       AND ($4::text IS NULL OR assignee_id = $4) \
                       AND ($5::text[] IS NULL OR workspace_id = ANY($5)) \
                     ORDER BY board_order ASC, updated_at DESC"
                ),
                &[
                    &org_id,
                    &query.workspace_id,
                    &query.issue_project_id,
                    &query.assignee_id,
                    &query.workspace_scope,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        rows.iter().map(issue_from_row).collect()
    }

    async fn get_issue(&self, org_id: &str, id: &str) -> Result<Option<Issue>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let row = transaction
            .query_opt(
                &format!("SELECT {ISSUE_COLUMNS} FROM issues WHERE org_id = $1 AND id = $2"),
                &[&org_id, &id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        row.as_ref().map(issue_from_row).transpose()
    }

    async fn create_issue(&self, input: NewIssue) -> Result<Issue, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, &input.org_id).await?;
        let assignee_kind = input.assignee.as_ref().map(|actor| actor.kind.as_str());
        let assignee_id = input.assignee.as_ref().map(|actor| actor.id.as_str());
        let row = transaction
            .query_one(
                &format!(
                    "INSERT INTO issues ({ISSUE_COLUMNS}) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16, $16) \
                     ON CONFLICT (org_id, created_operation_id) DO UPDATE \
                       SET created_operation_id = EXCLUDED.created_operation_id \
                     RETURNING {ISSUE_COLUMNS}"
                ),
                &[
                    &input.id,
                    &input.org_id,
                    &input.workspace_id,
                    &input.issue_project_id,
                    &input.title,
                    &input.body,
                    &input.status.as_str(),
                    &input.priority.as_str(),
                    &input.board_order,
                    &assignee_kind,
                    &assignee_id,
                    &input.created_by.kind.as_str(),
                    &input.created_by.id,
                    &input.now,
                    &input.now,
                    &input.operation_id,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let issue = issue_from_row(&row)?;
        transaction
            .commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(issue)
    }

    async fn patch_issue(
        &self,
        org_id: &str,
        id: &str,
        patch: IssuePatch,
        guard: MutationGuard,
        now: i64,
    ) -> Result<Issue, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let existing = transaction
            .query_opt(
                &format!(
                    "SELECT {ISSUE_COLUMNS} FROM issues WHERE org_id = $1 AND id = $2 FOR UPDATE"
                ),
                &[&org_id, &id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
            .ok_or(StoreError::NotFound)?;
        let existing = issue_from_row(&existing)?;
        if existing.last_operation_id == guard.operation_id {
            return Ok(existing);
        }
        if existing.revision != guard.base_revision {
            return Err(StoreError::Conflict(
                serde_json::to_value(existing)
                    .map_err(|error| StoreError::Corrupt(error.to_string()))?,
            ));
        }
        // COALESCE keeps this one statement instead of read-modify-write, which
        // would need the read and the write in the same transaction anyway and
        // would still lose a concurrent edit between them.
        let assignee_kind = patch
            .assignee
            .as_ref()
            .and_then(|actor| actor.as_ref().map(|actor| actor.kind.as_str()));
        let assignee_id = patch
            .assignee
            .as_ref()
            .and_then(|actor| actor.as_ref().map(|actor| actor.id.as_str()));
        let clears_assignee = matches!(patch.assignee, Some(None));
        let row = transaction
            .query_opt(
                &format!(
                    "UPDATE issues SET \
                       title           = COALESCE($3, title), \
                       body            = CASE WHEN $4::bool THEN $5 ELSE body END, \
                       status          = COALESCE($6, status), \
                       priority        = COALESCE($7, priority), \
                       board_order     = COALESCE($8, board_order), \
                       assignee_kind   = CASE WHEN $9::bool THEN NULL \
                                              ELSE COALESCE($10, assignee_kind) END, \
                       assignee_id     = CASE WHEN $9::bool THEN NULL \
                                              ELSE COALESCE($11, assignee_id) END, \
                       updated_at      = $12, \
                       revision        = revision + 1, \
                       last_operation_id = $13 \
                     WHERE org_id = $1 AND id = $2 \
                     RETURNING {ISSUE_COLUMNS}"
                ),
                &[
                    &org_id,
                    &id,
                    &patch.title,
                    &patch.body.is_some(),
                    &patch.body.clone().flatten(),
                    &patch.status.map(IssueStatus::as_str),
                    &patch.priority.map(IssuePriority::as_str),
                    &patch.board_order,
                    &clears_assignee,
                    &assignee_kind,
                    &assignee_id,
                    &now,
                    &guard.operation_id,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
            .ok_or(StoreError::NotFound)?;
        let issue = issue_from_row(&row)?;
        transaction
            .commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(issue)
    }

    async fn append_event(
        &self,
        org_id: &str,
        event: IssueEvent,
    ) -> Result<IssueEvent, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let row = transaction
            .query_one(
                "INSERT INTO issue_events \
                   (id, org_id, issue_id, kind, ts, actor_kind, actor_id, payload, operation_id) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
                 ON CONFLICT (org_id, operation_id) DO UPDATE \
                   SET operation_id = EXCLUDED.operation_id \
                 RETURNING id, issue_id, kind, ts, actor_kind, actor_id, payload, operation_id",
                &[
                    &event.id,
                    &org_id,
                    &event.issue_id,
                    &event.kind,
                    &event.ts,
                    &event.actor.kind.as_str(),
                    &event.actor.id,
                    &event.payload,
                    &event.operation_id,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let result = IssueEvent {
            id: row.get("id"),
            issue_id: row.get("issue_id"),
            kind: row.get("kind"),
            ts: row.get("ts"),
            actor: CollabActor::from_columns(
                &row.get::<_, String>("actor_kind"),
                &row.get::<_, String>("actor_id"),
                None,
            )?,
            payload: row.get("payload"),
            operation_id: row.get("operation_id"),
        };
        transaction
            .commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(result)
    }

    async fn list_events(
        &self,
        org_id: &str,
        issue_id: &str,
    ) -> Result<Vec<IssueEvent>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let rows = transaction
            .query(
                "SELECT id, issue_id, kind, ts, actor_kind, actor_id, payload, operation_id \
                 FROM issue_events WHERE org_id = $1 AND issue_id = $2 ORDER BY ts ASC",
                &[&org_id, &issue_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        rows.iter()
            .map(|row| {
                Ok(IssueEvent {
                    id: row.get("id"),
                    issue_id: row.get("issue_id"),
                    kind: row.get("kind"),
                    ts: row.get("ts"),
                    actor: CollabActor::from_columns(
                        &row.get::<_, String>("actor_kind"),
                        &row.get::<_, String>("actor_id"),
                        None,
                    )?,
                    payload: row.get("payload"),
                    operation_id: row.get("operation_id"),
                })
            })
            .collect()
    }

    async fn list_plans(&self, org_id: &str, query: PlanQuery) -> Result<Vec<Plan>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let rows = transaction
            .query(
                &format!(
                    "SELECT {PLAN_COLUMNS} FROM plans \
                     WHERE org_id = $1 \
                       AND ($2::text IS NULL OR workspace_id = $2) \
                       AND ($3::text IS NULL OR status = $3) \
                       AND ($4::text[] IS NULL OR workspace_id = ANY($4)) \
                     ORDER BY updated_at DESC, id ASC"
                ),
                &[
                    &org_id,
                    &query.workspace_id,
                    &query.status.map(PlanStatus::as_str),
                    &query.workspace_scope,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        rows.iter().map(|row| plan_from_row(row, None)).collect()
    }

    async fn get_plan(&self, org_id: &str, id: &str) -> Result<Option<Plan>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let Some(row) = transaction
            .query_opt(
                &format!("SELECT {PLAN_COLUMNS} FROM plans WHERE org_id = $1 AND id = $2"),
                &[&org_id, &id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
        else {
            return Ok(None);
        };
        let steps = read_plan_steps(&transaction, org_id, id).await?;
        Ok(Some(plan_from_row(&row, Some(steps))?))
    }

    async fn create_plan(&self, input: NewPlan) -> Result<Plan, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, &input.org_id).await?;
        let steps: Vec<PlanStep> = input
            .steps
            .iter()
            .map(|step| PlanStep {
                id: step.id.clone(),
                plan_id: input.id.clone(),
                order: step.order,
                title: step.title.clone(),
                description: step.description.clone(),
                kind: step.kind,
                status: step.status,
                result: None,
                error: None,
                started_at: None,
                completed_at: None,
            })
            .collect();
        let (total, completed) = plan_counts(&steps);
        let ended_at = ended_at_for(is_terminal_plan(input.status), None, input.now);
        let row = transaction
            .query_one(
                &format!(
                    "INSERT INTO plans ({PLAN_COLUMNS}) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $14) \
                     ON CONFLICT (org_id, created_operation_id) DO UPDATE \
                       SET created_operation_id = EXCLUDED.created_operation_id \
                     RETURNING {PLAN_COLUMNS}"
                ),
                &[
                    &input.id,
                    &input.org_id,
                    &input.workspace_id,
                    &input.title,
                    &input.description,
                    &input.status.as_str(),
                    &total,
                    &completed,
                    &input.created_by.kind.as_str(),
                    &input.created_by.id,
                    &input.now,
                    &input.now,
                    &ended_at,
                    &input.operation_id,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let replay = row.get::<_, String>("id") != input.id;
        if replay {
            let replay_id: String = row.get("id");
            let replay_steps = read_plan_steps(&transaction, &input.org_id, &replay_id).await?;
            let plan = plan_from_row(&row, Some(replay_steps))?;
            transaction
                .commit()
                .await
                .map_err(|error| StoreError::Database(error.to_string()))?;
            return Ok(plan);
        }
        for step in &steps {
            insert_plan_step(&transaction, &input.org_id, step).await?;
        }
        let plan = plan_from_row(&row, Some(steps))?;
        transaction
            .commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(plan)
    }

    /// Read-modify-write, unlike `patch_issue`'s single COALESCE statement.
    ///
    /// The progress rules live in Rust ([`apply_step_progress`]) precisely so
    /// the test double and production cannot disagree about them, and that
    /// means the current step must be read before it can be updated. Both
    /// halves run inside the tenant-scoped transaction, so a concurrent writer
    /// is serialised rather than lost.
    async fn patch_plan(
        &self,
        org_id: &str,
        id: &str,
        patch: PlanPatch,
        guard: MutationGuard,
        now: i64,
    ) -> Result<Plan, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let existing = transaction
            .query_opt(
                &format!(
                    "SELECT {PLAN_COLUMNS} FROM plans WHERE org_id = $1 AND id = $2 FOR UPDATE"
                ),
                &[&org_id, &id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
            .ok_or(StoreError::NotFound)?;
        let mut steps = read_plan_steps(&transaction, org_id, id).await?;
        let mut plan = plan_from_row(&existing, None)?;
        if plan.last_operation_id == guard.operation_id {
            plan.steps = Some(steps);
            return Ok(plan);
        }
        if plan.revision != guard.base_revision {
            plan.steps = Some(steps);
            return Err(StoreError::Conflict(
                serde_json::to_value(plan)
                    .map_err(|error| StoreError::Corrupt(error.to_string()))?,
            ));
        }

        if let Some(title) = patch.title {
            plan.title = title;
        }
        if let Some(description) = patch.description {
            plan.description = description;
        }
        if let Some(status) = patch.status {
            plan.status = status;
        }
        for report in &patch.steps {
            let Some(step) = steps.iter_mut().find(|step| step.id == report.id) else {
                return Err(StoreError::NotFound);
            };
            apply_step_progress(step, report, now);
            transaction
                .execute(
                    "UPDATE plan_steps SET status = $3, result = $4, error = $5, \
                       started_at = $6, completed_at = $7 \
                     WHERE org_id = $1 AND id = $2",
                    &[
                        &org_id,
                        &step.id,
                        &step.status.as_str(),
                        &step.result,
                        &step.error,
                        &step.started_at,
                        &step.completed_at,
                    ],
                )
                .await
                .map_err(|error| StoreError::Database(error.to_string()))?;
        }

        let (total, completed) = plan_counts(&steps);
        plan.total_steps = total;
        plan.completed_steps = completed;
        plan.ended_at = ended_at_for(is_terminal_plan(plan.status), plan.ended_at, now);
        plan.updated_at = now;
        plan.revision += 1;
        plan.last_operation_id = guard.operation_id;

        transaction
            .execute(
                "UPDATE plans SET title = $3, description = $4, status = $5, \
                   total_steps = $6, completed_steps = $7, updated_at = $8, ended_at = $9, \
                   revision = $10, last_operation_id = $11 \
                 WHERE org_id = $1 AND id = $2",
                &[
                    &org_id,
                    &id,
                    &plan.title,
                    &plan.description,
                    &plan.status.as_str(),
                    &plan.total_steps,
                    &plan.completed_steps,
                    &plan.updated_at,
                    &plan.ended_at,
                    &plan.revision,
                    &plan.last_operation_id,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        transaction
            .commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        plan.steps = Some(steps);
        Ok(plan)
    }

    async fn list_runs(&self, org_id: &str, query: RunQuery) -> Result<Vec<Run>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let rows = transaction
            .query(
                &format!(
                    "SELECT {RUN_COLUMNS} FROM runs \
                     WHERE org_id = $1 \
                       AND ($2::text IS NULL OR workspace_id = $2) \
                       AND ($3::text IS NULL OR issue_id = $3) \
                       AND ($4::text IS NULL OR plan_id = $4) \
                       AND ($5::text[] IS NULL OR workspace_id = ANY($5)) \
                       AND (NOT $6::bool OR status IN ('queued', 'running')) \
                     ORDER BY started_at DESC, id ASC"
                ),
                &[
                    &org_id,
                    &query.workspace_id,
                    &query.issue_id,
                    &query.plan_id,
                    &query.workspace_scope,
                    &query.active_only,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;

        let mut runs = Vec::with_capacity(rows.len());
        for row in &rows {
            let id: String = row.get("id");
            let artifacts = read_run_artifacts(&transaction, org_id, &id).await?;
            runs.push(run_from_row(row, artifacts)?);
        }
        Ok(runs)
    }

    async fn get_run(&self, org_id: &str, id: &str) -> Result<Option<Run>, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        let Some(row) = transaction
            .query_opt(
                &format!("SELECT {RUN_COLUMNS} FROM runs WHERE org_id = $1 AND id = $2"),
                &[&org_id, &id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
        else {
            return Ok(None);
        };
        let artifacts = read_run_artifacts(&transaction, org_id, id).await?;
        Ok(Some(run_from_row(&row, artifacts)?))
    }

    async fn create_run(&self, input: NewRun) -> Result<Run, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, &input.org_id).await?;
        let ended_at = ended_at_for(!input.status.is_active(), None, input.now);
        let row = transaction
            .query_one(
                &format!(
                    "INSERT INTO runs ({RUN_COLUMNS}) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16, $16) \
                     ON CONFLICT (org_id, created_operation_id) DO UPDATE \
                       SET created_operation_id = EXCLUDED.created_operation_id \
                     RETURNING {RUN_COLUMNS}"
                ),
                &[
                    &input.id,
                    &input.org_id,
                    &input.workspace_id,
                    &input.issue_id,
                    &input.plan_id,
                    &input.title,
                    &input.kind.as_str(),
                    &input.status.as_str(),
                    &input.started_by.kind.as_str(),
                    &input.started_by.id,
                    &input.now,
                    &input.now,
                    &ended_at,
                    &None::<String>,
                    &None::<String>,
                    &input.operation_id,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        let replay = row.get::<_, String>("id") != input.id;
        if replay {
            let replay_id: String = row.get("id");
            let artifacts = read_run_artifacts(&transaction, &input.org_id, &replay_id).await?;
            let run = run_from_row(&row, artifacts)?;
            transaction
                .commit()
                .await
                .map_err(|error| StoreError::Database(error.to_string()))?;
            return Ok(run);
        }
        replace_run_artifacts(&transaction, &input.org_id, &input.id, &input.artifacts).await?;
        let run = run_from_row(&row, input.artifacts)?;
        transaction
            .commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(run)
    }

    async fn patch_run(
        &self,
        org_id: &str,
        id: &str,
        patch: RunPatch,
        guard: MutationGuard,
        now: i64,
    ) -> Result<Run, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        // `ended_at` is derived from the status the row ends up with, so the
        // current status has to be read first — same reason as `patch_plan`.
        let existing = transaction
            .query_opt(
                &format!("SELECT {RUN_COLUMNS} FROM runs WHERE org_id = $1 AND id = $2 FOR UPDATE"),
                &[&org_id, &id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
            .ok_or(StoreError::NotFound)?;
        let mut run = run_from_row(&existing, Vec::new())?;
        if run.last_operation_id == guard.operation_id {
            run.artifacts = read_run_artifacts(&transaction, org_id, id).await?;
            return Ok(run);
        }
        if run.revision != guard.base_revision {
            run.artifacts = read_run_artifacts(&transaction, org_id, id).await?;
            return Err(StoreError::Conflict(
                serde_json::to_value(run)
                    .map_err(|error| StoreError::Corrupt(error.to_string()))?,
            ));
        }

        if let Some(status) = patch.status {
            run.status = status;
        }
        if let Some(summary) = patch.summary {
            run.summary = summary;
        }
        if let Some(error) = patch.error {
            run.error = error;
        }
        run.ended_at = ended_at_for(!run.status.is_active(), run.ended_at, now);
        run.updated_at = now;
        run.revision += 1;
        run.last_operation_id = guard.operation_id;

        transaction
            .execute(
                "UPDATE runs SET status = $3, summary = $4, error = $5, \
                   updated_at = $6, ended_at = $7, revision = $8, last_operation_id = $9 \
                 WHERE org_id = $1 AND id = $2",
                &[
                    &org_id,
                    &id,
                    &run.status.as_str(),
                    &run.summary,
                    &run.error,
                    &run.updated_at,
                    &run.ended_at,
                    &run.revision,
                    &run.last_operation_id,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;

        run.artifacts = match patch.artifacts {
            Some(artifacts) => {
                replace_run_artifacts(&transaction, org_id, id, &artifacts).await?;
                artifacts
            }
            None => read_run_artifacts(&transaction, org_id, id).await?,
        };
        transaction
            .commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_tenant_auth::UserId;

    fn ada() -> UserId {
        UserId::parse("usr_aaaaaaaaaaaaaaaaaaaaaaaa").unwrap()
    }

    fn guard(operation_id: &str, base_revision: i64) -> MutationGuard {
        MutationGuard {
            operation_id: operation_id.into(),
            base_revision,
        }
    }

    fn new_issue(id: &str, org: &str) -> NewIssue {
        NewIssue {
            id: id.into(),
            org_id: org.into(),
            workspace_id: "proj-1".into(),
            issue_project_id: "cont-1".into(),
            title: "Ship it".into(),
            body: None,
            status: IssueStatus::Todo,
            priority: IssuePriority::Medium,
            board_order: 1.0,
            assignee: None,
            created_by: CollabActor::human(&ada(), None),
            now: 100,
            operation_id: format!("create-{org}-{id}"),
        }
    }

    #[tokio::test]
    async fn reads_never_cross_an_org_boundary() {
        // The in-Rust mirror of the RLS policies: a route that forgets to scope
        // must fail here rather than in production.
        let store = InMemoryStore::new();
        store
            .create_issue(new_issue("iss_a", "org_a"))
            .await
            .unwrap();
        store
            .create_issue(new_issue("iss_b", "org_b"))
            .await
            .unwrap();

        let mine = store
            .list_issues("org_a", IssueQuery::default())
            .await
            .unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].id, "iss_a");

        assert!(store.get_issue("org_a", "iss_b").await.unwrap().is_none());
        assert!(store.get_issue("org_b", "iss_b").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn a_patch_from_the_wrong_org_finds_nothing_to_patch() {
        let store = InMemoryStore::new();
        store
            .create_issue(new_issue("iss_a", "org_a"))
            .await
            .unwrap();
        let patch = IssuePatch {
            title: Some("stolen".into()),
            ..Default::default()
        };
        assert!(matches!(
            store
                .patch_issue("org_b", "iss_a", patch, guard("wrong-org", 1), 200)
                .await,
            Err(StoreError::NotFound)
        ));
        assert_eq!(
            store
                .get_issue("org_a", "iss_a")
                .await
                .unwrap()
                .unwrap()
                .title,
            "Ship it"
        );
    }

    #[tokio::test]
    async fn a_patch_distinguishes_unassign_from_leave_alone() {
        let store = InMemoryStore::new();
        store
            .create_issue(new_issue("iss_a", "org_a"))
            .await
            .unwrap();

        let assigned = store
            .patch_issue(
                "org_a",
                "iss_a",
                IssuePatch {
                    assignee: Some(Some(CollabActor::human(&ada(), Some("Ada".into())))),
                    ..Default::default()
                },
                guard("assign", 1),
                200,
            )
            .await
            .unwrap();
        assert_eq!(assigned.assignee.as_ref().unwrap().id, ada().as_str());

        // `None` leaves it alone…
        let untouched = store
            .patch_issue(
                "org_a",
                "iss_a",
                IssuePatch {
                    title: Some("Renamed".into()),
                    ..Default::default()
                },
                guard("rename", 2),
                300,
            )
            .await
            .unwrap();
        assert!(untouched.assignee.is_some());

        // …`Some(None)` clears it.
        let cleared = store
            .patch_issue(
                "org_a",
                "iss_a",
                IssuePatch {
                    assignee: Some(None),
                    ..Default::default()
                },
                guard("clear", 3),
                400,
            )
            .await
            .unwrap();
        assert!(cleared.assignee.is_none());
    }

    #[tokio::test]
    async fn membership_reports_both_layers_without_collapsing_them() {
        let store = InMemoryStore::new();
        store.add_org_member("org_a", ada().as_str(), OrgRole::Admin);
        store.add_workspace_member("org_a", "proj-1", ada().as_str(), WorkspaceRole::Viewer);

        let found = store
            .membership("org_a", ada().as_str(), Some("proj-1"))
            .await
            .unwrap();
        assert_eq!(found.org_role, Some(OrgRole::Admin));
        assert_eq!(found.workspace_role, Some(WorkspaceRole::Viewer));

        // A different org sees nothing, even for the same person.
        let elsewhere = store
            .membership("org_b", ada().as_str(), Some("proj-1"))
            .await
            .unwrap();
        assert_eq!(elsewhere.org_role, None);
    }

    #[tokio::test]
    async fn events_are_scoped_and_ordered() {
        let store = InMemoryStore::new();
        for (id, ts, org) in [
            ("e2", 200, "org_a"),
            ("e1", 100, "org_a"),
            ("e3", 50, "org_b"),
        ] {
            store
                .append_event(
                    org,
                    IssueEvent {
                        id: id.into(),
                        issue_id: "iss_a".into(),
                        kind: "commented".into(),
                        ts,
                        actor: CollabActor::human(&ada(), None),
                        payload: serde_json::json!({}),
                        operation_id: format!("event-{org}-{id}"),
                    },
                )
                .await
                .unwrap();
        }
        let events = store.list_events("org_a", "iss_a").await.unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            ["e1", "e2"]
        );
    }

    #[tokio::test]
    async fn listing_filters_by_assignee_without_leaking_unassigned_rows() {
        let store = InMemoryStore::new();
        store
            .create_issue(new_issue("iss_none", "org_a"))
            .await
            .unwrap();
        let mut assigned = new_issue("iss_ada", "org_a");
        assigned.assignee = Some(CollabActor::human(&ada(), None));
        store.create_issue(assigned).await.unwrap();

        let mine = store
            .list_issues(
                "org_a",
                IssueQuery {
                    assignee_id: Some(ada().as_str().to_owned()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].id, "iss_ada");
    }

    // ── Plans and Runs (Batch 7c) ────────────────────────────────────────────

    fn new_plan(id: &str, org: &str) -> NewPlan {
        NewPlan {
            id: id.into(),
            org_id: org.into(),
            workspace_id: "proj-1".into(),
            title: "Migrate the store".into(),
            description: None,
            status: PlanStatus::Executing,
            steps: (0..3)
                .map(|order| NewPlanStep {
                    id: format!("{id}-step-{order}"),
                    order,
                    title: format!("Step {order}"),
                    description: None,
                    kind: PlanStepKind::AgentTurn,
                    status: PlanStepStatus::Pending,
                })
                .collect(),
            created_by: CollabActor::human(&ada(), None),
            now: 100,
            operation_id: format!("create-{org}-{id}"),
        }
    }

    fn new_run(id: &str, org: &str) -> NewRun {
        NewRun {
            id: id.into(),
            org_id: org.into(),
            workspace_id: "proj-1".into(),
            issue_id: Some("iss_1".into()),
            plan_id: None,
            title: "Fix the flake".into(),
            kind: RunKind::AgentTask,
            status: RunStatus::Running,
            started_by: CollabActor::human(&ada(), None),
            artifacts: vec![],
            now: 100,
            operation_id: format!("create-{org}-{id}"),
        }
    }

    fn progress(id: &str, status: PlanStepStatus) -> PlanStepProgress {
        PlanStepProgress {
            id: id.into(),
            status,
            result: None,
            error: None,
        }
    }

    #[tokio::test]
    async fn plans_and_runs_never_cross_an_org_boundary() {
        let store = InMemoryStore::new();
        store
            .create_plan(new_plan("plan_1", "org_a"))
            .await
            .unwrap();
        store.create_run(new_run("run_1", "org_a")).await.unwrap();

        assert_eq!(
            store
                .list_plans("org_b", PlanQuery::default())
                .await
                .unwrap()
                .len(),
            0
        );
        assert!(store.get_plan("org_b", "plan_1").await.unwrap().is_none());
        assert_eq!(
            store
                .list_runs("org_b", RunQuery::default())
                .await
                .unwrap()
                .len(),
            0
        );
        assert!(store.get_run("org_b", "run_1").await.unwrap().is_none());
        // And the patches, which would otherwise be a write across the boundary.
        assert!(store
            .patch_plan(
                "org_b",
                "plan_1",
                PlanPatch::default(),
                guard("wrong-plan-org", 1),
                200,
            )
            .await
            .is_err());
        assert!(store
            .patch_run(
                "org_b",
                "run_1",
                RunPatch::default(),
                guard("wrong-run-org", 1),
                200,
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_listing_carries_no_steps_and_a_single_read_does() {
        // `None` and `Some(vec![])` are different answers: "not asked for"
        // against "asked, and there are none". A listing that sent the latter
        // would make every plan look empty until the detail view loaded.
        let store = InMemoryStore::new();
        store
            .create_plan(new_plan("plan_1", "org_a"))
            .await
            .unwrap();

        let listed = store
            .list_plans("org_a", PlanQuery::default())
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].steps.is_none());
        assert_eq!(listed[0].total_steps, 3);

        let one = store.get_plan("org_a", "plan_1").await.unwrap().unwrap();
        assert_eq!(one.steps.as_ref().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn progress_recomputes_the_counts_from_the_steps() {
        // The client never supplies counts. Two writers reporting different
        // progress for one plan is a disagreement with no tiebreak, and the
        // steps are the tiebreak.
        let store = InMemoryStore::new();
        store
            .create_plan(new_plan("plan_1", "org_a"))
            .await
            .unwrap();

        let patched = store
            .patch_plan(
                "org_a",
                "plan_1",
                PlanPatch {
                    steps: vec![
                        progress("plan_1-step-0", PlanStepStatus::Completed),
                        progress("plan_1-step-1", PlanStepStatus::InProgress),
                    ],
                    ..Default::default()
                },
                guard("progress", 1),
                200,
            )
            .await
            .unwrap();
        assert_eq!((patched.total_steps, patched.completed_steps), (3, 1));

        let steps = patched.steps.unwrap();
        // A step nobody reported keeps what it had — a driver reporting step 2
        // must not blank the others.
        assert_eq!(steps[2].status, PlanStepStatus::Pending);
        assert_eq!(steps[0].completed_at, Some(200));
        assert_eq!(steps[1].started_at, Some(200));
        assert_eq!(steps[1].completed_at, None);
    }

    #[tokio::test]
    async fn a_retried_step_drops_the_outcome_it_no_longer_has() {
        let store = InMemoryStore::new();
        store
            .create_plan(new_plan("plan_1", "org_a"))
            .await
            .unwrap();
        // The realistic sequence: it ran, then it failed. A step that goes
        // straight from `pending` to `failed` never started, and correctly ends
        // up with no start time at all.
        store
            .patch_plan(
                "org_a",
                "plan_1",
                PlanPatch {
                    steps: vec![progress("plan_1-step-0", PlanStepStatus::InProgress)],
                    ..Default::default()
                },
                guard("start", 1),
                150,
            )
            .await
            .unwrap();
        store
            .patch_plan(
                "org_a",
                "plan_1",
                PlanPatch {
                    steps: vec![PlanStepProgress {
                        id: "plan_1-step-0".into(),
                        status: PlanStepStatus::Failed,
                        result: None,
                        error: Some("timed out".into()),
                    }],
                    ..Default::default()
                },
                guard("fail", 2),
                200,
            )
            .await
            .unwrap();

        let retried = store
            .patch_plan(
                "org_a",
                "plan_1",
                PlanPatch {
                    steps: vec![progress("plan_1-step-0", PlanStepStatus::InProgress)],
                    ..Default::default()
                },
                guard("retry", 3),
                300,
            )
            .await
            .unwrap();
        let step = &retried.steps.unwrap()[0];
        // A stale error beside a step now marked in_progress is what makes a
        // reader distrust the whole panel.
        assert_eq!(step.error, None);
        assert_eq!(step.completed_at, None);
        // But the first start time survives: the step has been running since
        // then, and resetting it would hide how long the retry loop has run.
        assert_eq!(step.started_at, Some(150));
    }

    #[tokio::test]
    async fn a_progress_report_for_a_step_the_plan_does_not_have_is_refused() {
        // Inserting it would create a step with no order, no kind and no title,
        // which is not a step.
        let store = InMemoryStore::new();
        store
            .create_plan(new_plan("plan_1", "org_a"))
            .await
            .unwrap();
        assert!(matches!(
            store
                .patch_plan(
                    "org_a",
                    "plan_1",
                    PlanPatch {
                        steps: vec![progress("some-other-plans-step", PlanStepStatus::Completed)],
                        ..Default::default()
                    },
                    guard("unknown-step", 1),
                    200,
                )
                .await,
            Err(StoreError::NotFound)
        ));
    }

    #[tokio::test]
    async fn an_end_time_is_sticky_while_terminal_and_clears_on_the_way_out() {
        let store = InMemoryStore::new();
        store
            .create_plan(new_plan("plan_1", "org_a"))
            .await
            .unwrap();

        let done = store
            .patch_plan(
                "org_a",
                "plan_1",
                PlanPatch {
                    status: Some(PlanStatus::Completed),
                    ..Default::default()
                },
                guard("complete", 1),
                200,
            )
            .await
            .unwrap();
        assert_eq!(done.ended_at, Some(200));

        // A second terminal write keeps the first timestamp — a plan does not
        // finish twice.
        let again = store
            .patch_plan(
                "org_a",
                "plan_1",
                PlanPatch {
                    status: Some(PlanStatus::Failed),
                    ..Default::default()
                },
                guard("fail-terminal", 2),
                300,
            )
            .await
            .unwrap();
        assert_eq!(again.ended_at, Some(200));

        let reopened = store
            .patch_plan(
                "org_a",
                "plan_1",
                PlanPatch {
                    status: Some(PlanStatus::Executing),
                    ..Default::default()
                },
                guard("reopen", 3),
                400,
            )
            .await
            .unwrap();
        assert_eq!(reopened.ended_at, None);
    }

    #[tokio::test]
    async fn a_run_listing_answers_the_n_agents_working_question() {
        let store = InMemoryStore::new();
        store.create_run(new_run("run_1", "org_a")).await.unwrap();
        store
            .create_run(NewRun {
                status: RunStatus::Succeeded,
                now: 50,
                ..new_run("run_2", "org_a")
            })
            .await
            .unwrap();

        let all = store.list_runs("org_a", RunQuery::default()).await.unwrap();
        // Newest first.
        assert_eq!(
            all.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
            ["run_1", "run_2"]
        );
        // A run created in a terminal state ends the moment it starts, rather
        // than sitting open forever because nobody patched it.
        assert_eq!(all[1].ended_at, Some(50));

        let active = store
            .list_runs(
                "org_a",
                RunQuery {
                    active_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "run_1");
    }

    #[tokio::test]
    async fn a_run_listing_narrows_by_its_subject() {
        let store = InMemoryStore::new();
        store.create_run(new_run("run_1", "org_a")).await.unwrap();
        store
            .create_run(NewRun {
                issue_id: None,
                plan_id: Some("plan_1".into()),
                ..new_run("run_2", "org_a")
            })
            .await
            .unwrap();
        store
            .create_run(NewRun {
                issue_id: None,
                plan_id: None,
                title: "Ad-hoc sweep".into(),
                ..new_run("run_3", "org_a")
            })
            .await
            .unwrap();

        let by_issue = store
            .list_runs(
                "org_a",
                RunQuery {
                    issue_id: Some("iss_1".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(by_issue.len(), 1);
        assert_eq!(by_issue[0].id, "run_1");

        let by_plan = store
            .list_runs(
                "org_a",
                RunQuery {
                    plan_id: Some("plan_1".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(by_plan.len(), 1);
        assert_eq!(by_plan[0].id, "run_2");

        // The unattached one is reachable from the workspace and from nothing
        // else — which is the whole reason it carries a title.
        let all = store.list_runs("org_a", RunQuery::default()).await.unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().any(|run| run.title == "Ad-hoc sweep"));
    }

    #[tokio::test]
    async fn patching_a_run_replaces_its_artifacts_rather_than_appending() {
        let store = InMemoryStore::new();
        store
            .create_run(NewRun {
                artifacts: vec![
                    RunArtifact::new("PR #1", "https://example.com/pr/1").unwrap(),
                    RunArtifact::new("Build", "https://example.com/build/1").unwrap(),
                ],
                ..new_run("run_1", "org_a")
            })
            .await
            .unwrap();

        // An engine that re-reports fewer artifacts withdrew one; appending
        // would leave the withdrawn link on a colleague's screen forever.
        let patched = store
            .patch_run(
                "org_a",
                "run_1",
                RunPatch {
                    status: Some(RunStatus::Succeeded),
                    summary: Some(Some("merged".into())),
                    artifacts: Some(vec![
                        RunArtifact::new("PR #1", "https://example.com/pr/1").unwrap()
                    ]),
                    ..Default::default()
                },
                guard("settle", 1),
                200,
            )
            .await
            .unwrap();
        assert_eq!(patched.artifacts.len(), 1);
        assert_eq!(patched.ended_at, Some(200));
        assert_eq!(patched.summary.as_deref(), Some("merged"));

        // Absent means "leave them alone", not "clear them".
        let untouched = store
            .patch_run(
                "org_a",
                "run_1",
                RunPatch {
                    error: Some(Some("flaked".into())),
                    ..Default::default()
                },
                guard("annotate", 2),
                300,
            )
            .await
            .unwrap();
        assert_eq!(untouched.artifacts.len(), 1);
    }

    #[tokio::test]
    async fn create_operations_are_idempotent_for_every_shared_resource() {
        let store = InMemoryStore::new();

        let issue = store
            .create_issue(new_issue("iss_1", "org_a"))
            .await
            .unwrap();
        let issue_replay = store
            .create_issue(NewIssue {
                id: "iss_2".into(),
                ..new_issue("iss_1", "org_a")
            })
            .await
            .unwrap();
        assert_eq!(issue_replay.id, issue.id);

        let plan = store
            .create_plan(new_plan("plan_1", "org_a"))
            .await
            .unwrap();
        let plan_replay = store
            .create_plan(NewPlan {
                id: "plan_2".into(),
                ..new_plan("plan_1", "org_a")
            })
            .await
            .unwrap();
        assert_eq!(plan_replay.id, plan.id);

        let run = store.create_run(new_run("run_1", "org_a")).await.unwrap();
        let run_replay = store
            .create_run(NewRun {
                id: "run_2".into(),
                ..new_run("run_1", "org_a")
            })
            .await
            .unwrap();
        assert_eq!(run_replay.id, run.id);
    }

    #[tokio::test]
    async fn patch_replays_succeed_and_stale_new_operations_conflict() {
        let store = InMemoryStore::new();
        store
            .create_issue(new_issue("iss_1", "org_a"))
            .await
            .unwrap();
        store
            .create_plan(new_plan("plan_1", "org_a"))
            .await
            .unwrap();
        store.create_run(new_run("run_1", "org_a")).await.unwrap();

        let issue = store
            .patch_issue(
                "org_a",
                "iss_1",
                IssuePatch {
                    title: Some("Updated".into()),
                    ..Default::default()
                },
                guard("issue-patch", 1),
                200,
            )
            .await
            .unwrap();
        let issue_replay = store
            .patch_issue(
                "org_a",
                "iss_1",
                IssuePatch::default(),
                guard("issue-patch", 1),
                300,
            )
            .await
            .unwrap();
        assert_eq!(issue_replay, issue);
        assert!(matches!(
            store
                .patch_issue(
                    "org_a",
                    "iss_1",
                    IssuePatch::default(),
                    guard("stale-issue-patch", 1),
                    300,
                )
                .await,
            Err(StoreError::Conflict(_))
        ));

        let plan = store
            .patch_plan(
                "org_a",
                "plan_1",
                PlanPatch::default(),
                guard("plan-patch", 1),
                200,
            )
            .await
            .unwrap();
        let plan_replay = store
            .patch_plan(
                "org_a",
                "plan_1",
                PlanPatch::default(),
                guard("plan-patch", 1),
                300,
            )
            .await
            .unwrap();
        assert_eq!(plan_replay, plan);
        assert!(matches!(
            store
                .patch_plan(
                    "org_a",
                    "plan_1",
                    PlanPatch::default(),
                    guard("stale-plan-patch", 1),
                    300,
                )
                .await,
            Err(StoreError::Conflict(_))
        ));

        let run = store
            .patch_run(
                "org_a",
                "run_1",
                RunPatch::default(),
                guard("run-patch", 1),
                200,
            )
            .await
            .unwrap();
        let run_replay = store
            .patch_run(
                "org_a",
                "run_1",
                RunPatch::default(),
                guard("run-patch", 1),
                300,
            )
            .await
            .unwrap();
        assert_eq!(run_replay, run);
        assert!(matches!(
            store
                .patch_run(
                    "org_a",
                    "run_1",
                    RunPatch::default(),
                    guard("stale-run-patch", 1),
                    300,
                )
                .await,
            Err(StoreError::Conflict(_))
        ));
    }
}
