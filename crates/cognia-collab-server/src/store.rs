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

use crate::model::{ActorError, CollabActor, Issue, IssueEvent, IssuePriority, IssueStatus};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("not found")]
    NotFound,
    #[error("stored row is unreadable: {0}")]
    Corrupt(String),
    #[error("database error: {0}")]
    Database(String),
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
        now: i64,
    ) -> Result<Issue, StoreError>;

    async fn append_event(&self, org_id: &str, event: IssueEvent) -> Result<(), StoreError>;

    async fn list_events(
        &self,
        org_id: &str,
        issue_id: &str,
    ) -> Result<Vec<IssueEvent>, StoreError>;
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
        };
        self.tables
            .write()
            .issues
            .insert(issue.id.clone(), issue.clone());
        Ok(issue)
    }

    async fn patch_issue(
        &self,
        org_id: &str,
        id: &str,
        patch: IssuePatch,
        now: i64,
    ) -> Result<Issue, StoreError> {
        let mut tables = self.tables.write();
        let issue = tables
            .issues
            .get_mut(id)
            .filter(|issue| issue.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
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
        Ok(issue.clone())
    }

    async fn append_event(&self, org_id: &str, event: IssueEvent) -> Result<(), StoreError> {
        self.tables.write().events.push((org_id.to_owned(), event));
        Ok(())
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
}

// ── Postgres ─────────────────────────────────────────────────────────────────

const ISSUE_COLUMNS: &str = "id, org_id, workspace_id, issue_project_id, title, body, status, \
     priority, board_order, assignee_kind, assignee_id, created_by_kind, created_by_id, \
     created_at, updated_at";

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
    })
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
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) \
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
        now: i64,
    ) -> Result<Issue, StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
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
                       updated_at      = $12 \
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

    async fn append_event(&self, org_id: &str, event: IssueEvent) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let transaction = self.scoped(&mut client, org_id).await?;
        transaction
            .execute(
                "INSERT INTO issue_events \
                   (id, org_id, issue_id, kind, ts, actor_kind, actor_id, payload) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                &[
                    &event.id,
                    &org_id,
                    &event.issue_id,
                    &event.kind,
                    &event.ts,
                    &event.actor.kind.as_str(),
                    &event.actor.id,
                    &event.payload,
                ],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        transaction
            .commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(())
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
                "SELECT id, issue_id, kind, ts, actor_kind, actor_id, payload \
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
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_tenant_auth::UserId;

    fn ada() -> UserId {
        UserId::parse("usr_aaaaaaaaaaaaaaaaaaaaaaaa").unwrap()
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
            store.patch_issue("org_b", "iss_a", patch, 200).await,
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
}
