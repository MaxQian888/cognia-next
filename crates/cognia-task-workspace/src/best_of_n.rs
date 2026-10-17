//! Host-authoritative best-of-N allocation and winner authorization.
use crate::{
    changeset::{git_output, git_text},
    service::now_ms,
    AgentChangeset, TaskWorkspaceService,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BestOfNPhase {
    Preparing,
    Running,
    AwaitingSelection,
    Publishing,
    Published,
    Cancelling,
    Cancelled,
    RecoveryRequired,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BestOfNCandidateStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    CancelRequested,
    Cancelled,
    RecoveryRequired,
}
impl BestOfNCandidateStatus {
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::RecoveryRequired
        )
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BestOfNArchiveStatus {
    Pending,
    Archiving,
    Archived,
    Failed,
}
/// Transport shells must derive this from trusted caller context, never request JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BestOfNSelectionOrigin {
    InteractiveUser,
    Plugin,
    Unattended,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct BestOfNBudgetPolicy {
    pub max_cost_usd: Option<f64>,
    pub max_duration_ms: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct BestOfNAgentDescriptor {
    pub agent_id: String,
    pub provider: Option<String>,
    pub model: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartBestOfN {
    pub request_id: String,
    pub repository_id: String,
    pub source_root: String,
    pub base_ref: Option<String>,
    pub target_ref: Option<String>,
    pub target_is_new: bool,
    pub budget_policy: BestOfNBudgetPolicy,
    pub candidates: Vec<BestOfNAgentDescriptor>,
    pub owner_id: String,
    pub lease_duration_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BestOfNMutation {
    pub group_id: String,
    pub expected_version: u64,
    pub owner_id: String,
    pub lease_duration_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BestOfNSelect {
    pub mutation: BestOfNMutation,
    pub candidate_id: String,
    pub head_sha: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BestOfNCandidateProgress {
    pub mutation: BestOfNMutation,
    pub candidate_id: String,
    pub status: BestOfNCandidateStatus,
    pub workspace_bundle_id: Option<String>,
    pub physical_root: Option<String>,
    pub changeset_id: Option<String>,
    pub head_sha: Option<String>,
    pub has_changes: bool,
    pub cost_usd: Option<f64>,
    pub error: Option<String>,
    pub team_run_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct BestOfNCandidate {
    pub candidate_id: String,
    pub index: u32,
    pub agent: BestOfNAgentDescriptor,
    pub child_session_id: String,
    pub workspace_bundle_id: Option<String>,
    pub physical_root: Option<String>,
    pub changeset_id: Option<String>,
    pub head_sha: Option<String>,
    pub status: BestOfNCandidateStatus,
    pub has_changes: bool,
    pub cost_usd: Option<f64>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct BestOfNGroup {
    pub group_id: String,
    pub request_id: String,
    pub repository_id: String,
    pub repo_common_dir: String,
    pub source_root: String,
    pub base_sha: String,
    pub checkout_had_uncommitted_changes: bool,
    pub target_ref: String,
    pub target_is_new: bool,
    pub n: u32,
    pub budget_policy: BestOfNBudgetPolicy,
    pub team_run_id: String,
    pub phase: BestOfNPhase,
    pub selected_candidate_id: Option<String>,
    pub selected_head_sha: Option<String>,
    pub integration_id: Option<String>,
    pub version: u64,
    pub owner_id: String,
    pub owner_lease_expires_at: i64,
    pub archive_status: BestOfNArchiveStatus,
    pub archive_error: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub candidates: Vec<BestOfNCandidate>,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS best_of_n_groups (
      group_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, repository_id TEXT NOT NULL,
      base_sha TEXT NOT NULL, target_ref TEXT NOT NULL, target_is_new INTEGER NOT NULL,
      n INTEGER NOT NULL CHECK(n BETWEEN 2 AND 4), budget_policy TEXT NOT NULL,
      team_run_id TEXT, phase TEXT NOT NULL, selected_candidate_id TEXT, selected_head_sha TEXT,
      integration_id TEXT, version INTEGER NOT NULL, owner_id TEXT NOT NULL,
      owner_lease_expires_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS best_of_n_candidates (
      candidate_id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES best_of_n_groups(group_id),
      candidate_index INTEGER NOT NULL, child_session_id TEXT NOT NULL UNIQUE,
      workspace_bundle_id TEXT UNIQUE, physical_root TEXT UNIQUE, changeset_id TEXT UNIQUE,
      head_sha TEXT, status TEXT NOT NULL, has_changes INTEGER NOT NULL, cost_usd REAL,
      started_at INTEGER, finished_at INTEGER, error TEXT, payload TEXT NOT NULL,
      UNIQUE(group_id, candidate_index)
    );
    CREATE INDEX IF NOT EXISTS idx_best_of_n_phase ON best_of_n_groups(phase);",
        )
        .map_err(|e| format!("initialize best-of-N ledger: {e}"))
}
fn encode<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}
fn tag<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_value(value)
        .map_err(|e| e.to_string())?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "invalid ledger enum".into())
}
fn read(connection: &Connection, id: &str) -> Result<Option<BestOfNGroup>, String> {
    let payload: Option<String> = connection
        .query_row(
            "SELECT payload FROM best_of_n_groups WHERE group_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    payload
        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        .transpose()
}
fn save(connection: &Connection, group: &BestOfNGroup) -> Result<(), String> {
    connection.execute("INSERT INTO best_of_n_groups (group_id,request_id,repository_id,base_sha,target_ref,target_is_new,n,budget_policy,team_run_id,phase,selected_candidate_id,selected_head_sha,integration_id,version,owner_id,owner_lease_expires_at,payload)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
        ON CONFLICT(group_id) DO UPDATE SET team_run_id=excluded.team_run_id,phase=excluded.phase,selected_candidate_id=excluded.selected_candidate_id,selected_head_sha=excluded.selected_head_sha,integration_id=excluded.integration_id,version=excluded.version,owner_id=excluded.owner_id,owner_lease_expires_at=excluded.owner_lease_expires_at,payload=excluded.payload",
        params![group.group_id,group.request_id,group.repository_id,group.base_sha,group.target_ref,group.target_is_new,group.n,encode(&group.budget_policy)?,group.team_run_id,tag(&group.phase)?,group.selected_candidate_id,group.selected_head_sha,group.integration_id,group.version,group.owner_id,group.owner_lease_expires_at,encode(group)?]).map_err(|e| e.to_string())?;
    for c in &group.candidates {
        connection.execute("INSERT INTO best_of_n_candidates (candidate_id,group_id,candidate_index,child_session_id,workspace_bundle_id,physical_root,changeset_id,head_sha,status,has_changes,cost_usd,started_at,finished_at,error,payload)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
          ON CONFLICT(candidate_id) DO UPDATE SET workspace_bundle_id=excluded.workspace_bundle_id,physical_root=excluded.physical_root,changeset_id=excluded.changeset_id,head_sha=excluded.head_sha,status=excluded.status,has_changes=excluded.has_changes,cost_usd=excluded.cost_usd,started_at=excluded.started_at,finished_at=excluded.finished_at,error=excluded.error,payload=excluded.payload",
          params![c.candidate_id,group.group_id,c.index,c.child_session_id,c.workspace_bundle_id,c.physical_root,c.changeset_id,c.head_sha,tag(&c.status)?,c.has_changes,c.cost_usd,c.started_at,c.finished_at,c.error,encode(c)?]).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn lease_expiry(now: i64, duration: u64) -> Result<i64, String> {
    if duration == 0 || duration > 300_000 {
        return Err("best-of-N lease duration must be 1..=300000 ms".into());
    }
    now.checked_add(duration as i64)
        .ok_or_else(|| "lease expiry overflow".into())
}
fn require_identity(value: &str, name: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{name} must not be empty"))
    } else {
        Ok(())
    }
}
fn canonical(path: &str) -> Result<String, String> {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("workspace unavailable {path}: {e}"))
}
fn stop_remaining(group: &mut BestOfNGroup) {
    for c in &mut group.candidates {
        if !c.status.terminal() {
            c.status = BestOfNCandidateStatus::CancelRequested;
        }
    }
}
fn settle_phase(group: &mut BestOfNGroup) {
    if matches!(
        group.phase,
        BestOfNPhase::Publishing | BestOfNPhase::Published | BestOfNPhase::RecoveryRequired
    ) {
        return;
    }
    let all_done = group.candidates.iter().all(|c| c.status.terminal());
    if group.phase == BestOfNPhase::Cancelling {
        if all_done {
            group.phase = if group
                .error
                .as_deref()
                .is_some_and(|error| error.contains("budget exhausted"))
                && group
                    .candidates
                    .iter()
                    .any(|c| c.status == BestOfNCandidateStatus::Succeeded)
            {
                BestOfNPhase::AwaitingSelection
            } else {
                BestOfNPhase::Cancelled
            };
        }
    } else if all_done {
        if group
            .candidates
            .iter()
            .any(|c| c.status == BestOfNCandidateStatus::Succeeded)
        {
            group.phase = BestOfNPhase::AwaitingSelection;
        } else {
            group.phase = BestOfNPhase::RecoveryRequired;
            group.error = Some("all candidates failed or were cancelled".into());
        }
    } else {
        group.phase = BestOfNPhase::Running;
    }
}
impl TaskWorkspaceService {
    pub fn best_of_n_get(&self, id: &str) -> Result<Option<BestOfNGroup>, String> {
        read(&self.store.lock().connection, id)
    }
    pub fn best_of_n_list(&self) -> Result<Vec<BestOfNGroup>, String> {
        let store = self.store.lock();
        let mut statement = store
            .connection
            .prepare("SELECT payload FROM best_of_n_groups ORDER BY rowid DESC")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn best_of_n_start(&self, request: StartBestOfN) -> Result<BestOfNGroup, String> {
        // IMMEDIATE serializes the request-id lookup and the one-time Git resolution across Hosts.
        let mut store = self.store.lock();
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT group_id FROM best_of_n_groups WHERE request_id=?1",
                [&request.request_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(id) = existing {
            return read(&tx, &id)?.ok_or_else(|| "missing existing best-of-N group".into());
        }
        require_identity(&request.request_id, "requestId")?;
        require_identity(&request.repository_id, "repositoryId")?;
        require_identity(&request.owner_id, "ownerId")?;
        if !(2..=4).contains(&request.candidates.len()) {
            return Err("best-of-N requires 2..=4 candidates".into());
        }
        for agent in &request.candidates {
            require_identity(&agent.agent_id, "agentId")?;
        }
        if request
            .budget_policy
            .max_cost_usd
            .is_some_and(|n| !n.is_finite() || n <= 0.0)
            || request.budget_policy.max_duration_ms == Some(0)
        {
            return Err("budget limits must be positive and finite".into());
        }
        let now = now_ms();
        let expiry = lease_expiry(now, request.lease_duration_ms)?;
        let source_root = canonical(&request.source_root)?;
        let root = Path::new(&source_root);
        let base_ref = request.base_ref.as_deref().unwrap_or("HEAD");
        let base_sha = git_text(
            root,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{base_ref}^{{commit}}"),
            ],
        )
        .map_err(|e| e.to_string())?;
        let common =
            git_text(root, &["rev-parse", "--git-common-dir"]).map_err(|e| e.to_string())?;
        let common_path = PathBuf::from(common);
        let repo_common_dir = canonical(
            &if common_path.is_absolute() {
                common_path
            } else {
                root.join(common_path)
            }
            .to_string_lossy(),
        )?;
        let dirty = !git_text(root, &["status", "--porcelain", "--untracked-files=normal"])
            .map_err(|e| e.to_string())?
            .is_empty();
        let id = Uuid::new_v4().to_string();
        let target_is_new = request.target_ref.is_none() || request.target_is_new;
        let target = request
            .target_ref
            .unwrap_or_else(|| format!("refs/heads/best-of-n/{id}"));
        if (target.starts_with("refs/") && !target.starts_with("refs/heads/"))
            || target.starts_with('-')
            || target.trim().is_empty()
        {
            return Err("publish target must name a local branch".into());
        }
        let target_ref = if target.starts_with("refs/heads/") {
            target
        } else {
            format!("refs/heads/{target}")
        };
        if !git_output(root, &["check-ref-format", &target_ref])
            .map_err(|e| e.to_string())?
            .status
            .success()
        {
            return Err("invalid result branch".into());
        }
        let exists = git_output(root, &["show-ref", "--verify", "--quiet", &target_ref])
            .map_err(|e| e.to_string())?
            .status
            .success();
        if exists == target_is_new {
            return Err(if exists {
                "new result branch already exists"
            } else {
                "explicit existing target branch does not exist"
            }
            .into());
        }
        let group = BestOfNGroup {
            group_id: id.clone(),
            request_id: request.request_id,
            repository_id: request.repository_id,
            repo_common_dir,
            source_root,
            base_sha,
            checkout_had_uncommitted_changes: dirty,
            target_ref,
            target_is_new,
            n: request.candidates.len() as u32,
            budget_policy: request.budget_policy,
            team_run_id: format!("best-of-n:{id}"),
            phase: BestOfNPhase::Preparing,
            selected_candidate_id: None,
            selected_head_sha: None,
            integration_id: None,
            version: 1,
            owner_id: request.owner_id,
            owner_lease_expires_at: expiry,
            archive_status: BestOfNArchiveStatus::Pending,
            archive_error: None,
            error: None,
            created_at: now,
            updated_at: now,
            candidates: request
                .candidates
                .into_iter()
                .enumerate()
                .map(|(index, agent)| BestOfNCandidate {
                    candidate_id: Uuid::new_v4().to_string(),
                    index: index as u32,
                    agent,
                    child_session_id: Uuid::new_v4().to_string(),
                    workspace_bundle_id: None,
                    physical_root: None,
                    changeset_id: None,
                    head_sha: None,
                    status: BestOfNCandidateStatus::Pending,
                    has_changes: false,
                    cost_usd: None,
                    started_at: None,
                    finished_at: None,
                    error: None,
                })
                .collect(),
        };
        save(&tx, &group)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(group)
    }
    fn mutate_best_of_n(
        &self,
        mutation: &BestOfNMutation,
        claim: bool,
        apply: impl FnOnce(&Connection, &mut BestOfNGroup) -> Result<(), String>,
    ) -> Result<BestOfNGroup, String> {
        require_identity(&mutation.owner_id, "ownerId")?;
        let now = now_ms();
        let expiry = lease_expiry(now, mutation.lease_duration_ms)?;
        let mut store = self.store.lock();
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let mut group = read(&tx, &mutation.group_id)?
            .ok_or_else(|| "best-of-N group not found".to_string())?;
        if group.version != mutation.expected_version {
            return Err("best-of-N version conflict".into());
        }
        if group.owner_id != mutation.owner_id && (!claim || group.owner_lease_expires_at > now) {
            return Err("best-of-N owner lease is held by another owner".into());
        }
        if !claim && group.owner_lease_expires_at <= now {
            return Err("best-of-N owner lease expired; recover before mutating".into());
        }
        apply(&tx, &mut group)?;
        group.owner_id = mutation.owner_id.clone();
        group.owner_lease_expires_at = expiry;
        group.version += 1;
        group.updated_at = now;
        save(&tx, &group)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(group)
    }
    pub fn best_of_n_candidate_progress(
        &self,
        request: BestOfNCandidateProgress,
    ) -> Result<BestOfNGroup, String> {
        self.mutate_best_of_n(&request.mutation,false,|connection,group|{
            if matches!(group.phase,BestOfNPhase::Cancelled) {return Err("group no longer accepts candidate progress".into());}
            if request.cost_usd.is_some_and(|cost|!cost.is_finite() || cost<0.0) {return Err("invalid candidate cost".into());}
            if let Some(run)=&request.team_run_id {
                if &group.team_run_id!=run {return Err("team run identity cannot change".into());}
            }
            let candidate=group.candidates.iter_mut().find(|c|c.candidate_id==request.candidate_id).ok_or("candidate not found")?;
            if candidate.status.terminal() {return Err("terminal candidate is immutable".into());}
            if candidate.cost_usd.zip(request.cost_usd).is_some_and(|(previous,next)| next<previous) {return Err("candidate cumulative cost cannot decrease".into());}
            if request.status==BestOfNCandidateStatus::Pending || (candidate.status==BestOfNCandidateStatus::CancelRequested && !request.status.terminal()) {return Err("invalid candidate status transition".into());}
            if let Some(bundle_id)=&request.workspace_bundle_id {
                if candidate.workspace_bundle_id.as_ref().is_some_and(|old|old!=bundle_id) {return Err("candidate workspace bundle cannot change".into());}
                let owner: Option<String>=connection.query_row("SELECT owner_ref FROM workspace_bundles WHERE bundle_id=?1",[bundle_id],|r|r.get(0)).map_err(|e|e.to_string())?;
                if owner.as_deref()!=Some(candidate.child_session_id.as_str()) {return Err("candidate bundle must belong to its child session".into());}
                candidate.workspace_bundle_id=Some(bundle_id.clone());
            }
            if let Some(path)=&request.physical_root {
                let path=canonical(path)?;
                if candidate.physical_root.as_ref().is_some_and(|old|old!=&path) {return Err("candidate physical workspace cannot change".into());}
                let bundle_id=candidate.workspace_bundle_id.as_deref().ok_or("physical root requires candidate bundle")?;
                let mut statement=connection.prepare("SELECT alias_path FROM workspace_root_leases WHERE bundle_id=?1").map_err(|e|e.to_string())?;
                let roots=statement.query_map([bundle_id],|row|row.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
                if roots.len()!=1 || canonical(&roots[0])?!=path {return Err("candidate requires a single repository workspace matching its bundle".into());}
                let (kind,base_ref,repo):(String,Option<String>,Option<String>)=connection.query_row("SELECT r.base_kind,r.base_ref,r.git_common_dir FROM workspace_registry r JOIN workspace_root_leases l ON l.workspace_id=r.workspace_id WHERE l.bundle_id=?1",[bundle_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|e|e.to_string())?;
                if kind!="gitRef" || base_ref.as_deref()!=Some(group.base_sha.as_str()) || repo.as_deref()!=Some(group.repo_common_dir.as_str()) {return Err("candidate bundle must use the frozen repository and committed SHA".into());}
                let base=git_text(Path::new(&path), &["merge-base","--is-ancestor",&group.base_sha,"HEAD"]);
                if base.is_err() {return Err("candidate must descend from frozen base".into());}
                candidate.physical_root=Some(path);
            }
            if request.status==BestOfNCandidateStatus::Running && (candidate.physical_root.is_none() || candidate.workspace_bundle_id.is_none()) {return Err("running candidate requires its workspace bundle and physical root".into());}
            if let Some(id)=&request.changeset_id {
                let json:String=connection.query_row("SELECT payload FROM agent_changesets WHERE changeset_id=?1",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
                let changeset:AgentChangeset=serde_json::from_str(&json).map_err(|e|e.to_string())?;
                if changeset.session_id.as_deref()!=Some(candidate.child_session_id.as_str()) || changeset.repo_common_dir!=group.repo_common_dir || changeset.base_sha!=group.base_sha || request.head_sha.as_deref()!=Some(changeset.head_sha.as_str()) || candidate.physical_root.as_deref()!=Some(canonical(&changeset.execution_root)?.as_str()) {return Err("candidate changeset does not match frozen repository, workspace, session and head".into());}
                if request.has_changes != changeset.files.iter().any(|file| !file.excluded) {return Err("candidate hasChanges disagrees with captured changeset".into());}
                candidate.changeset_id=Some(id.clone());candidate.head_sha=Some(changeset.head_sha);
            } else if request.has_changes || request.head_sha.is_some() {return Err("candidate changes require a captured changeset".into());}
            if request.status==BestOfNCandidateStatus::Succeeded && candidate.physical_root.is_none() {return Err("successful candidate requires a workspace".into());}
            candidate.status=request.status;candidate.has_changes=request.has_changes;candidate.cost_usd=request.cost_usd.or(candidate.cost_usd);candidate.error=request.error.clone();
            candidate.started_at.get_or_insert(now_ms());
            if candidate.status.terminal() {candidate.finished_at=Some(now_ms());}
            let known_cost:f64=group.candidates.iter().filter_map(|c|c.cost_usd).sum();
            let over_cost=group.budget_policy.max_cost_usd.is_some_and(|max|known_cost>=max);
            let over_time=group.budget_policy.max_duration_ms.is_some_and(|max|now_ms().saturating_sub(group.created_at) as u64>=max);
            if (over_cost||over_time) && group.selected_candidate_id.is_none() {group.phase=BestOfNPhase::Cancelling;group.error=Some("best-of-N budget exhausted".into());stop_remaining(group);}
            if request.status==BestOfNCandidateStatus::RecoveryRequired {group.phase=BestOfNPhase::RecoveryRequired;group.error=request.error.clone();}
            settle_phase(group);Ok(())
        })
    }
    pub fn best_of_n_cancel(&self, mutation: BestOfNMutation) -> Result<BestOfNGroup, String> {
        self.mutate_best_of_n(&mutation, false, |_, group| {
            if matches!(
                group.phase,
                BestOfNPhase::Publishing | BestOfNPhase::Published
            ) {
                return Err("cannot cancel a selected publication".into());
            }
            group.phase = BestOfNPhase::Cancelling;
            stop_remaining(group);
            settle_phase(group);
            Ok(())
        })
    }
    pub fn best_of_n_select(
        &self,
        request: BestOfNSelect,
        origin: BestOfNSelectionOrigin,
    ) -> Result<BestOfNGroup, String> {
        if origin != BestOfNSelectionOrigin::InteractiveUser {
            return Err("only an interactive user may select a best-of-N winner".into());
        }
        let group = self.mutate_best_of_n(&request.mutation, false, |connection, group| {
            if !matches!(
                group.phase,
                BestOfNPhase::Running | BestOfNPhase::AwaitingSelection
            ) {
                return Err("group is not accepting a winner".into());
            }
            let candidate = group
                .candidates
                .iter()
                .find(|c| c.candidate_id == request.candidate_id)
                .ok_or("candidate not found")?;
            if candidate.status != BestOfNCandidateStatus::Succeeded
                || !candidate.has_changes
                || candidate.head_sha.as_deref() != Some(request.head_sha.as_str())
            {
                return Err(
                    "winner must be a successful changed candidate at its recorded head".into(),
                );
            }
            let id = candidate
                .changeset_id
                .as_deref()
                .ok_or("winner has no captured changeset")?;
            let payload: String = connection
                .query_row(
                    "SELECT payload FROM agent_changesets WHERE changeset_id=?1",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let changeset: AgentChangeset =
                serde_json::from_str(&payload).map_err(|e| e.to_string())?;
            if changeset.head_sha != request.head_sha {
                return Err("winner changeset head changed".into());
            }
            let root = candidate
                .physical_root
                .as_deref()
                .ok_or("winner workspace missing")?;
            if !Path::new(root).is_dir() {
                return Err("winner workspace is missing".into());
            }
            if git_text(Path::new(root), &["rev-parse", &changeset.change_ref])
                .map_err(|e| e.to_string())?
                != request.head_sha
            {
                return Err("winner changeset pin changed".into());
            }
            if group.target_is_new
                && git_output(
                    Path::new(&group.repo_common_dir),
                    &["show-ref", "--verify", "--quiet", &group.target_ref],
                )
                .map_err(|e| e.to_string())?
                .status
                .success()
            {
                return Err("new result branch was created by another operation".into());
            }
            group.selected_candidate_id = Some(request.candidate_id.clone());
            group.selected_head_sha = Some(request.head_sha.clone());
            group.phase = BestOfNPhase::Publishing;
            stop_remaining(group);
            Ok(())
        })?;
        // Persist the manual decision before touching Git. Recovery can resume
        // this step after a crash without inventing or repeating a selection.
        if let Err(error) = initialize_result_branch(&group, false) {
            return self.mutate_best_of_n(
                &BestOfNMutation {
                    expected_version: group.version,
                    ..request.mutation
                },
                false,
                |_, group| {
                    group.phase = BestOfNPhase::RecoveryRequired;
                    group.error = Some(format!("result branch initialization failed: {error}"));
                    Ok(())
                },
            );
        }
        Ok(group)
    }
    pub fn best_of_n_recover(&self, mutation: BestOfNMutation) -> Result<BestOfNGroup, String> {
        self.mutate_best_of_n(&mutation, true, |connection, group| {
            if group.archive_status == BestOfNArchiveStatus::Archiving
                && (group.owner_lease_expires_at <= now_ms() || group.owner_id != mutation.owner_id)
            {
                group.archive_status = BestOfNArchiveStatus::Failed;
                group.archive_error = Some("archive was interrupted; retry cleanup".into());
            }
            if group.phase == BestOfNPhase::Published || group.phase == BestOfNPhase::Cancelled {
                return Ok(());
            }
            // Prepare persists its changeset/integration link before the group
            // projection. Recompose that link if the Host stopped between them.
            if group.integration_id.is_none() {
                if let Some(candidate) = group.candidates.iter().find(|candidate| {
                    Some(&candidate.candidate_id) == group.selected_candidate_id.as_ref()
                }) {
                    if let Some(id) = &candidate.changeset_id {
                        let payload: Option<String> = connection
                            .query_row(
                                "SELECT payload FROM agent_changesets WHERE changeset_id=?1",
                                [id],
                                |row| row.get(0),
                            )
                            .optional()
                            .map_err(|e| e.to_string())?;
                        if let Some(payload) = payload {
                            let changeset: AgentChangeset =
                                serde_json::from_str(&payload).map_err(|e| e.to_string())?;
                            group.integration_id = changeset.integration_id;
                        }
                    }
                }
            }
            if let Some(id) = &group.integration_id {
                let payload: Option<String> = connection
                    .query_row(
                        "SELECT payload FROM integration_runs WHERE integration_id=?1",
                        [id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if let Some(payload) = payload {
                    let run: crate::IntegrationRun =
                        serde_json::from_str(&payload).map_err(|e| e.to_string())?;
                    if run.state == crate::IntegrationState::Published {
                        group.phase = BestOfNPhase::Published;
                        return Ok(());
                    }
                }
            }
            if group.selected_candidate_id.is_some() {
                if let Err(error) = initialize_result_branch(group, true) {
                    group.phase = BestOfNPhase::RecoveryRequired;
                    group.error = Some(format!("result branch initialization failed: {error}"));
                    return Ok(());
                }
                if group
                    .error
                    .as_deref()
                    .is_some_and(|error| error.starts_with("result branch initialization failed:"))
                {
                    group.phase = BestOfNPhase::Publishing;
                    group.error = None;
                }
            }
            let interrupted =
                group.owner_lease_expires_at <= now_ms() || group.owner_id != mutation.owner_id;
            if interrupted
                && group
                    .candidates
                    .iter()
                    .any(|c| c.status == BestOfNCandidateStatus::Running)
            {
                group.phase = BestOfNPhase::RecoveryRequired;
                group.error = Some(
                    "candidate execution was interrupted; explicit reconciliation required".into(),
                );
                for c in &mut group.candidates {
                    if c.status == BestOfNCandidateStatus::Running {
                        c.status = BestOfNCandidateStatus::RecoveryRequired;
                        c.error = group.error.clone();
                    }
                }
            }
            for c in &group.candidates {
                if c.physical_root
                    .as_ref()
                    .is_some_and(|root| !Path::new(root).is_dir())
                {
                    group.phase = BestOfNPhase::RecoveryRequired;
                    group.error =
                        Some(format!("candidate {} workspace is missing", c.candidate_id));
                    return Ok(());
                }
            }
            let expired = group
                .budget_policy
                .max_duration_ms
                .is_some_and(|max| now_ms().saturating_sub(group.created_at) as u64 >= max);
            if expired
                && group.selected_candidate_id.is_none()
                && matches!(group.phase, BestOfNPhase::Preparing | BestOfNPhase::Running)
            {
                group.phase = BestOfNPhase::Cancelling;
                group.error = Some("best-of-N duration budget exhausted".into());
                stop_remaining(group);
                settle_phase(group);
            }
            Ok(())
        })
    }
    pub fn best_of_n_archive(&self, mutation: BestOfNMutation) -> Result<BestOfNGroup, String> {
        let group = self.mutate_best_of_n(&mutation, false, |_, group| {
            if group.candidates.iter().any(|c| !c.status.terminal()) {
                return Err("cannot archive while candidates are still running".into());
            }
            if !matches!(
                group.phase,
                BestOfNPhase::Published | BestOfNPhase::Cancelled | BestOfNPhase::RecoveryRequired
            ) {
                return Err("group must be published, cancelled or failed before archive".into());
            }
            group.archive_status = BestOfNArchiveStatus::Archiving;
            group.archive_error = None;
            Ok(())
        })?;
        let mut errors = Vec::new();
        for candidate in &group.candidates {
            if let Some(id) = &candidate.workspace_bundle_id {
                match self.get_workspace_bundle(id) {
                    Ok(Some(bundle)) => {
                        for lease in bundle.leases {
                            if let Err(error) = self.archive_managed_workspace(&lease.workspace_id)
                            {
                                errors.push(error);
                            }
                        }
                    }
                    Ok(None) => errors.push(format!("candidate bundle {id} is missing")),
                    Err(error) => errors.push(error),
                }
            }
        }
        self.mutate_best_of_n(
            &BestOfNMutation {
                expected_version: group.version,
                ..mutation
            },
            // Cleanup can outlast its lease. The unchanged version proves no
            // other owner has claimed it, so renew before persisting its result.
            true,
            |_, group| {
                group.archive_status = if errors.is_empty() {
                    BestOfNArchiveStatus::Archived
                } else {
                    BestOfNArchiveStatus::Failed
                };
                group.archive_error = if errors.is_empty() {
                    None
                } else {
                    Some(errors.join("; "))
                };
                Ok(())
            },
        )
    }
    pub(crate) fn guard_best_of_n_changeset(
        &self,
        changeset: &AgentChangeset,
        target: &str,
    ) -> Result<Option<String>, String> {
        guard(&self.store.lock().connection, changeset, target)
    }
    pub(crate) fn record_best_of_n_integration(
        &self,
        changeset: &AgentChangeset,
        integration_id: &str,
        published: bool,
    ) -> Result<(), String> {
        let mut store = self.store.lock();
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if let Some(id) = candidate_group(&tx, changeset)? {
            let mut group = read(&tx, &id)?.ok_or("best-of-N group missing")?;
            guard(&tx, changeset, &group.target_ref)?;
            group.integration_id = Some(integration_id.into());
            if published {
                group.phase = BestOfNPhase::Published;
            }
            group.version += 1;
            group.updated_at = now_ms();
            save(&tx, &group)?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
fn initialize_result_branch(group: &BestOfNGroup, recovering: bool) -> Result<(), String> {
    if !group.target_is_new {
        return Ok(());
    }
    let root = Path::new(&group.repo_common_dir);
    if git_output(
        root,
        &["show-ref", "--verify", "--quiet", &group.target_ref],
    )
    .map_err(|e| e.to_string())?
    .status
    .success()
    {
        if recovering
            && git_text(root, &["rev-parse", &group.target_ref]).map_err(|e| e.to_string())?
                == group.base_sha
        {
            return Ok(());
        }
        return Err("new result branch already exists or moved".into());
    }
    git_text(
        root,
        &["update-ref", &group.target_ref, &group.base_sha, ""],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn candidate_group(
    connection: &Connection,
    changeset: &AgentChangeset,
) -> Result<Option<String>, String> {
    let root = std::fs::canonicalize(&changeset.execution_root)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| changeset.execution_root.clone());
    let mut statement=connection.prepare("SELECT DISTINCT group_id FROM best_of_n_candidates WHERE changeset_id=?1 OR child_session_id=?2 OR physical_root=?3 OR child_session_id=?4 OR child_session_id=(SELECT owner_ref FROM workspace_registry WHERE workspace_id=?5)").map_err(|e|e.to_string())?;
    let ids = statement
        .query_map(
            params![
                changeset.changeset_id,
                changeset.session_id,
                root,
                changeset.owner_ref,
                changeset.workspace_id
            ],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if ids.len() > 1 {
        return Err("changeset ambiguously belongs to multiple best-of-N groups".into());
    }
    Ok(ids.into_iter().next())
}
fn guard(
    connection: &Connection,
    changeset: &AgentChangeset,
    target: &str,
) -> Result<Option<String>, String> {
    let Some(id) = candidate_group(connection, changeset)? else {
        return Ok(None);
    };
    let group = read(connection, &id)?.ok_or("best-of-N group missing")?;
    let winner = group
        .candidates
        .iter()
        .find(|c| Some(&c.candidate_id) == group.selected_candidate_id.as_ref());
    let permitted = winner.is_some_and(|c| {
        c.changeset_id.as_deref() == Some(changeset.changeset_id.as_str())
            && c.status == BestOfNCandidateStatus::Succeeded
            && c.has_changes
            && c.head_sha.as_deref() == Some(changeset.head_sha.as_str())
    });
    if !permitted
        || group.selected_head_sha.as_deref() != Some(changeset.head_sha.as_str())
        || group.repo_common_dir != changeset.repo_common_dir
        || group.base_sha != changeset.base_sha
        || group.target_ref != target
        || !matches!(
            group.phase,
            BestOfNPhase::Publishing | BestOfNPhase::Published
        )
    {
        return Err("best-of-N publish guard: changeset is not the selected winner at the recorded head and target".into());
    }
    Ok(Some(id))
}

pub(crate) fn frozen_capture(
    connection: &Connection,
    workspace: &crate::WorkspaceRecord,
) -> Result<Option<(String, String)>, String> {
    let id:Option<String>=connection.query_row("SELECT group_id FROM best_of_n_candidates WHERE child_session_id=?1 OR physical_root=?2",params![workspace.owner_ref,workspace.execution_root],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    id.map(|id| {
        read(connection, &id)?
            .map(|group| (group.target_ref, group.base_sha))
            .ok_or_else(|| "best-of-N group missing".into())
    })
    .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AcquireWorkspaceBundle, CaptureChangeset, ServiceConfig, WorkspaceBaseSpec,
        WorkspaceBundleRootInput, WorkspaceEnvironmentKind, WorkspaceOwnerType, WorkspaceRootRole,
    };
    struct Fixture {
        _ports: crate::ports::TestPortProbeGuard,
        _temp: tempfile::TempDir,
        service: TaskWorkspaceService,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let ports = crate::ports::TestPortProbeGuard::vacant();
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap().join("repo");
            std::fs::create_dir(&root).unwrap();
            for args in [
                vec!["init", "-b", "main"],
                vec!["config", "user.name", "Best of N Test"],
                vec!["config", "user.email", "best-of-n@test.invalid"],
            ] {
                git_text(&root, &args).unwrap();
            }
            std::fs::write(root.join("file.txt"), "base\n").unwrap();
            git_text(&root, &["add", "file.txt"]).unwrap();
            git_text(&root, &["commit", "-m", "base"]).unwrap();
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(temp.path().join("data"))).unwrap();
            Self {
                _ports: ports,
                _temp: temp,
                service,
                root,
            }
        }
        fn request(&self) -> StartBestOfN {
            StartBestOfN {
                request_id: "request".into(),
                repository_id: "repo".into(),
                source_root: self.root.to_string_lossy().into_owned(),
                base_ref: None,
                target_ref: None,
                target_is_new: true,
                budget_policy: BestOfNBudgetPolicy {
                    max_cost_usd: Some(1.0),
                    max_duration_ms: Some(600_000),
                },
                candidates: (0..2)
                    .map(|_| BestOfNAgentDescriptor {
                        agent_id: "claude-code".into(),
                        provider: None,
                        model: Some("model".into()),
                    })
                    .collect(),
                owner_id: "owner".into(),
                lease_duration_ms: 60_000,
            }
        }
        fn start(&self) -> BestOfNGroup {
            self.service.best_of_n_start(self.request()).unwrap()
        }
        fn provision(&self, group: &BestOfNGroup, index: usize) -> BestOfNGroup {
            let c = &group.candidates[index];
            let bundle = self
                .service
                .acquire_workspace_bundle(AcquireWorkspaceBundle {
                    owner_type: WorkspaceOwnerType::Session,
                    owner_ref: Some(c.child_session_id.clone()),
                    project_id: None,
                    environment_kind: WorkspaceEnvironmentKind::Managed,
                    base: WorkspaceBaseSpec::GitRef {
                        git_ref: group.base_sha.clone(),
                    },
                    roots: vec![WorkspaceBundleRootInput {
                        logical_root_id: "primary".into(),
                        role: WorkspaceRootRole::Primary,
                        source_root: self.root.to_string_lossy().into_owned(),
                    }],
                    provisioning: None,
                    requested_name: None,
                })
                .unwrap();
            self.service
                .best_of_n_candidate_progress(BestOfNCandidateProgress {
                    mutation: mutation(group),
                    candidate_id: c.candidate_id.clone(),
                    status: BestOfNCandidateStatus::Running,
                    workspace_bundle_id: Some(bundle.bundle_id),
                    physical_root: Some(bundle.leases[0].alias_path.clone()),
                    changeset_id: None,
                    head_sha: None,
                    has_changes: false,
                    cost_usd: None,
                    error: None,
                    team_run_id: Some(group.team_run_id.clone()),
                })
                .unwrap()
        }
        fn complete(&self, group: &BestOfNGroup, index: usize) -> BestOfNGroup {
            let candidate = &group.candidates[index];
            let bundle = self
                .service
                .get_workspace_bundle(candidate.workspace_bundle_id.as_deref().unwrap())
                .unwrap()
                .unwrap();
            std::fs::write(
                Path::new(candidate.physical_root.as_ref().unwrap()).join("file.txt"),
                format!("candidate {index}\n"),
            )
            .unwrap();
            let captured = self
                .service
                .capture_changeset(CaptureChangeset {
                    workspace_id: bundle.leases[0].workspace_id.clone(),
                    target_ref: None,
                    title: "candidate".into(),
                    depends_on: vec![],
                    required_checks: vec![],
                    changeset_id: None,
                })
                .unwrap();
            assert_eq!(captured.base_sha, group.base_sha);
            assert_eq!(captured.target_ref, group.target_ref);
            self.service
                .best_of_n_candidate_progress(BestOfNCandidateProgress {
                    mutation: mutation(group),
                    candidate_id: candidate.candidate_id.clone(),
                    status: BestOfNCandidateStatus::Succeeded,
                    workspace_bundle_id: None,
                    physical_root: None,
                    changeset_id: Some(captured.changeset_id),
                    head_sha: Some(captured.head_sha),
                    has_changes: true,
                    cost_usd: None,
                    error: None,
                    team_run_id: None,
                })
                .unwrap()
        }
    }
    fn mutation(group: &BestOfNGroup) -> BestOfNMutation {
        BestOfNMutation {
            group_id: group.group_id.clone(),
            expected_version: group.version,
            owner_id: group.owner_id.clone(),
            lease_duration_ms: 60_000,
        }
    }
    fn progress(
        group: &BestOfNGroup,
        index: usize,
        status: BestOfNCandidateStatus,
    ) -> BestOfNCandidateProgress {
        BestOfNCandidateProgress {
            mutation: mutation(group),
            candidate_id: group.candidates[index].candidate_id.clone(),
            status,
            workspace_bundle_id: None,
            physical_root: None,
            changeset_id: None,
            head_sha: None,
            has_changes: false,
            cost_usd: None,
            error: None,
            team_run_id: None,
        }
    }
    #[test]
    fn best_of_n_idempotency_freezes_base_and_preserves_unknown_cost() {
        let fixture = Fixture::new();
        std::fs::write(fixture.root.join("dirty.txt"), "not copied").unwrap();
        let group = fixture.start();
        assert!(group.checkout_had_uncommitted_changes);
        assert!(group.candidates.iter().all(|c| c.cost_usd.is_none()));
        git_text(&fixture.root, &["add", "dirty.txt"]).unwrap();
        git_text(&fixture.root, &["commit", "-m", "later"]).unwrap();
        let repeated = fixture.start();
        assert_eq!(repeated, group);
        assert_ne!(
            group.base_sha,
            git_text(&fixture.root, &["rev-parse", "HEAD"]).unwrap()
        );
        assert!(!git_output(
            &fixture.root,
            &["show-ref", "--verify", "--quiet", &group.target_ref]
        )
        .unwrap()
        .status
        .success());
        let group = fixture.provision(&group, 0);
        assert!(
            !Path::new(group.candidates[0].physical_root.as_ref().unwrap())
                .join("dirty.txt")
                .exists()
        );
    }
    #[test]
    fn best_of_n_invalid_n_budget_and_target_are_rejected() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.candidates.truncate(1);
        assert!(fixture.service.best_of_n_start(request).is_err());
        let mut request = fixture.request();
        request.budget_policy.max_cost_usd = Some(f64::NAN);
        assert!(fixture.service.best_of_n_start(request).is_err());
        let mut request = fixture.request();
        request.target_ref = Some("main".into());
        assert!(fixture.service.best_of_n_start(request).is_err());
    }
    #[test]
    fn best_of_n_cas_owner_expiry_and_missing_workspace_recovery() {
        let fixture = Fixture::new();
        let group = fixture.start();
        let mut other = mutation(&group);
        other.owner_id = "other".into();
        assert!(fixture.service.best_of_n_recover(other.clone()).is_err());
        let active = fixture.provision(&group, 0);
        assert!(fixture.service.best_of_n_cancel(mutation(&group)).is_err());
        {
            let store = fixture.service.store.lock();
            let mut expired = active.clone();
            expired.owner_lease_expires_at = 0;
            save(&store.connection, &expired).unwrap();
        }
        other.expected_version = active.version;
        let recovered = fixture.service.best_of_n_recover(other).unwrap();
        assert_eq!(recovered.phase, BestOfNPhase::RecoveryRequired);
        assert_eq!(recovered.owner_id, "other");
        let mut missing = recovered.clone();
        missing.candidates[0].physical_root = Some("/nonexistent-best-of-n-workspace".into());
        save(&fixture.service.store.lock().connection, &missing).unwrap();
        let missing = fixture
            .service
            .best_of_n_recover(mutation(&missing))
            .unwrap();
        assert!(missing.error.unwrap().contains("workspace is missing"));
    }
    #[test]
    fn best_of_n_failure_is_independent_and_zero_successes_require_recovery() {
        let fixture = Fixture::new();
        let group = fixture.start();
        let group = fixture
            .service
            .best_of_n_candidate_progress(progress(&group, 0, BestOfNCandidateStatus::Failed))
            .unwrap();
        assert_eq!(group.phase, BestOfNPhase::Running);
        assert_eq!(group.candidates[1].status, BestOfNCandidateStatus::Pending);
        let group = fixture
            .service
            .best_of_n_candidate_progress(progress(&group, 1, BestOfNCandidateStatus::Failed))
            .unwrap();
        assert_eq!(group.phase, BestOfNPhase::RecoveryRequired);
    }
    #[test]
    fn best_of_n_budget_cancels_remaining_without_inventing_unknown_cost() {
        let fixture = Fixture::new();
        let group = fixture.start();
        let mut request = progress(&group, 0, BestOfNCandidateStatus::Failed);
        request.cost_usd = Some(1.0);
        let group = fixture
            .service
            .best_of_n_candidate_progress(request)
            .unwrap();
        assert_eq!(group.phase, BestOfNPhase::Cancelling);
        assert_eq!(
            group.candidates[1].status,
            BestOfNCandidateStatus::CancelRequested
        );
        assert_eq!(group.candidates[1].cost_usd, None);
        let group = fixture
            .service
            .best_of_n_candidate_progress(progress(&group, 1, BestOfNCandidateStatus::Cancelled))
            .unwrap();
        assert_eq!(group.phase, BestOfNPhase::Cancelled);
    }
    #[test]
    fn best_of_n_selection_is_manual_exact_head_and_stops_losers() {
        let fixture = Fixture::new();
        let group = fixture.start();
        let group = fixture.provision(&group, 0);
        let group = fixture.complete(&group, 0);
        let request = BestOfNSelect {
            mutation: mutation(&group),
            candidate_id: group.candidates[0].candidate_id.clone(),
            head_sha: group.candidates[0].head_sha.clone().unwrap(),
        };
        for origin in [
            BestOfNSelectionOrigin::Plugin,
            BestOfNSelectionOrigin::Unattended,
        ] {
            assert!(fixture
                .service
                .best_of_n_select(request.clone(), origin)
                .is_err());
        }
        let mut wrong = request.clone();
        wrong.head_sha = group.base_sha.clone();
        assert!(fixture
            .service
            .best_of_n_select(wrong, BestOfNSelectionOrigin::InteractiveUser)
            .is_err());
        let group = fixture
            .service
            .best_of_n_select(request, BestOfNSelectionOrigin::InteractiveUser)
            .unwrap();
        assert_eq!(group.phase, BestOfNPhase::Publishing);
        assert_eq!(
            group.candidates[1].status,
            BestOfNCandidateStatus::CancelRequested
        );
        assert_eq!(
            git_text(&fixture.root, &["rev-parse", &group.target_ref]).unwrap(),
            group.base_sha
        );
    }
    #[test]
    fn best_of_n_no_change_success_cannot_be_selected() {
        let fixture = Fixture::new();
        let group = fixture.start();
        let group = fixture.provision(&group, 0);
        let group = fixture
            .service
            .best_of_n_candidate_progress(progress(&group, 0, BestOfNCandidateStatus::Succeeded))
            .unwrap();
        assert!(fixture
            .service
            .best_of_n_select(
                BestOfNSelect {
                    mutation: mutation(&group),
                    candidate_id: group.candidates[0].candidate_id.clone(),
                    head_sha: group.base_sha.clone()
                },
                BestOfNSelectionOrigin::InteractiveUser
            )
            .is_err());
    }
    #[test]
    fn best_of_n_guard_covers_unattached_changesets_by_session_and_exact_head() {
        let fixture = Fixture::new();
        let group = fixture.start();
        let group = fixture.provision(&group, 0);
        let group = fixture.complete(&group, 0);
        let captured = fixture
            .service
            .get_changeset(group.candidates[0].changeset_id.as_ref().unwrap())
            .unwrap();
        assert!(fixture
            .service
            .guard_best_of_n_changeset(&captured, &group.target_ref)
            .is_err());
        let mut group = group;
        group.selected_candidate_id = Some(group.candidates[0].candidate_id.clone());
        group.selected_head_sha = group.candidates[0].head_sha.clone();
        group.phase = BestOfNPhase::Publishing;
        save(&fixture.service.store.lock().connection, &group).unwrap();
        assert!(fixture
            .service
            .guard_best_of_n_changeset(&captured, &group.target_ref)
            .unwrap()
            .is_some());
        let mut unrelated = captured.clone();
        unrelated.changeset_id = "other-capture".into();
        assert!(fixture
            .service
            .guard_best_of_n_changeset(&unrelated, &group.target_ref)
            .is_err());
        let mut stale = captured;
        stale.head_sha = group.base_sha.clone();
        assert!(fixture
            .service
            .guard_best_of_n_changeset(&stale, &group.target_ref)
            .is_err());
    }
    #[test]
    fn best_of_n_archive_cleanup_error_preserves_published_phase() {
        let fixture = Fixture::new();
        let mut group = fixture.start();
        group.phase = BestOfNPhase::Published;
        for c in &mut group.candidates {
            c.status = BestOfNCandidateStatus::Failed;
        }
        group.candidates[0].workspace_bundle_id = Some("missing-bundle".into());
        save(&fixture.service.store.lock().connection, &group).unwrap();
        let group = fixture.service.best_of_n_archive(mutation(&group)).unwrap();
        assert_eq!(group.phase, BestOfNPhase::Published);
        assert_eq!(group.archive_status, BestOfNArchiveStatus::Failed);
        assert!(group.archive_error.is_some());
    }
    #[test]
    fn best_of_n_recovery_marks_interrupted_archive_without_losing_publication() {
        let fixture = Fixture::new();
        let mut group = fixture.start();
        group.phase = BestOfNPhase::Published;
        group.archive_status = BestOfNArchiveStatus::Archiving;
        group.owner_lease_expires_at = 0;
        for candidate in &mut group.candidates {
            candidate.status = BestOfNCandidateStatus::Cancelled;
        }
        save(&fixture.service.store.lock().connection, &group).unwrap();
        let recovered = fixture.service.best_of_n_recover(mutation(&group)).unwrap();
        assert_eq!(recovered.phase, BestOfNPhase::Published);
        assert_eq!(recovered.archive_status, BestOfNArchiveStatus::Failed);
        assert!(recovered.archive_error.as_deref().unwrap().contains("interrupted"));
        let retried = fixture
            .service
            .best_of_n_archive(mutation(&recovered))
            .unwrap();
        assert_eq!(retried.phase, BestOfNPhase::Published);
        assert_eq!(retried.archive_status, BestOfNArchiveStatus::Archived);
    }

    #[test]
    fn best_of_n_response_schema_matches_published_catalog() {
        fn normalize(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::Object(object) => {
                    object.remove("$schema");
                    object.remove("title");
                    object.remove("description");
                    if let Some(serde_json::Value::Array(required)) = object.get_mut("required") {
                        required.sort_by_key(|value| value.to_string());
                    }
                    for value in object.values_mut() {
                        normalize(value);
                    }
                }
                serde_json::Value::Array(values) => {
                    for value in values {
                        normalize(value);
                    }
                }
                _ => (),
            }
        }
        let catalog: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol/companion-response-schemas.json"
        ))
        .unwrap();
        let mut schema = serde_json::to_value(schemars::schema_for!(BestOfNGroup)).unwrap();
        let defs = schema.as_object_mut().unwrap().remove("$defs").unwrap();
        let root_name = "BestOfNGroup".to_string();
        for (name, expected) in defs
            .as_object()
            .unwrap()
            .iter()
            .chain(std::iter::once((&root_name, &schema)))
        {
            let mut expected = expected.clone();
            let mut actual = catalog["$defs"][name].clone();
            normalize(&mut expected);
            normalize(&mut actual);
            assert_eq!(actual, expected, "{name} response schema drift");
        }
    }

    #[test]
    fn best_of_n_selected_winner_publishes_only_to_new_result_branch() {
        let fixture = Fixture::new();
        let group = fixture.start();
        let group = fixture.provision(&group, 0);
        let group = fixture.complete(&group, 0);
        let candidate = &group.candidates[0];
        let id = candidate.changeset_id.as_ref().unwrap();
        let head = candidate.head_sha.clone().unwrap();
        fixture.service.mark_changeset_ready(id).unwrap();
        fixture
            .service
            .record_changeset_review(
                id,
                crate::ChangesetReview {
                    head_sha: head.clone(),
                    verdict: crate::ChangesetReviewVerdict::Approve,
                    reviewer: crate::ChangesetReviewer::Deterministic,
                    risk_tier: crate::ChangesetRiskTier::Low,
                    reasons: vec!["test review".into()],
                    findings: vec![],
                    requires_human_approval: false,
                    recorded_at: now_ms(),
                },
            )
            .unwrap();
        let group = fixture
            .service
            .best_of_n_select(
                BestOfNSelect {
                    mutation: mutation(&group),
                    candidate_id: candidate.candidate_id.clone(),
                    head_sha: head,
                },
                BestOfNSelectionOrigin::InteractiveUser,
            )
            .unwrap();
        let run = fixture
            .service
            .prepare_integration(crate::PrepareIntegration {
                changeset_ids: vec![id.clone()],
                required_checks: vec![],
                target_ref: group.target_ref.clone(),
                strategy: crate::IntegrationStrategy::Merge,
                on_conflict: crate::IntegrationConflictPolicy::Stop,
                provisioning: None,
                integration_id: None,
            })
            .unwrap();
        let run = fixture
            .service
            .publish_integration(
                &run.integration_id,
                run.candidate_sha.as_ref().unwrap(),
                vec![],
            )
            .unwrap();
        let group = fixture
            .service
            .best_of_n_get(&group.group_id)
            .unwrap()
            .unwrap();
        assert_eq!(group.phase, BestOfNPhase::Published);
        assert_eq!(
            group.integration_id.as_deref(),
            Some(run.integration_id.as_str())
        );
        assert_eq!(
            git_text(&fixture.root, &["rev-parse", "refs/heads/main"]).unwrap(),
            group.base_sha
        );
        assert_eq!(
            git_text(&fixture.root, &["rev-parse", &group.target_ref]).unwrap(),
            run.result_sha.unwrap()
        );
        let group = fixture
            .service
            .best_of_n_candidate_progress(progress(&group, 1, BestOfNCandidateStatus::Cancelled))
            .unwrap();
        assert_eq!(group.phase, BestOfNPhase::Published);
    }
    #[test]
    fn best_of_n_recovery_resumes_branch_initialization_only_after_recorded_selection() {
        let fixture = Fixture::new();
        let group = fixture.start();
        let group = fixture.provision(&group, 0);
        let mut group = fixture.complete(&group, 0);
        group.selected_candidate_id = Some(group.candidates[0].candidate_id.clone());
        group.selected_head_sha = group.candidates[0].head_sha.clone();
        group.phase = BestOfNPhase::Publishing;
        stop_remaining(&mut group);
        save(&fixture.service.store.lock().connection, &group).unwrap();
        assert!(!git_output(
            &fixture.root,
            &["show-ref", "--verify", "--quiet", &group.target_ref]
        )
        .unwrap()
        .status
        .success());
        let recovered = fixture.service.best_of_n_recover(mutation(&group)).unwrap();
        assert_eq!(recovered.selected_candidate_id, group.selected_candidate_id);
        assert_eq!(recovered.phase, BestOfNPhase::Publishing);
        assert_eq!(
            git_text(&fixture.root, &["rev-parse", &group.target_ref]).unwrap(),
            group.base_sha
        );
        assert_eq!(
            fixture
                .service
                .best_of_n_recover(mutation(&recovered))
                .unwrap()
                .phase,
            BestOfNPhase::Publishing
        );
    }

    #[test]
    fn best_of_n_comparison_time_does_not_consume_execution_budget() {
        let fixture = Fixture::new();
        let group = fixture.start();
        let group = fixture.provision(&group, 0);
        let group = fixture.complete(&group, 0);
        let mut group = fixture
            .service
            .best_of_n_candidate_progress(progress(&group, 1, BestOfNCandidateStatus::Failed))
            .unwrap();
        assert_eq!(group.phase, BestOfNPhase::AwaitingSelection);
        group.created_at = now_ms() - 1_000_000;
        save(&fixture.service.store.lock().connection, &group).unwrap();
        let recovered = fixture.service.best_of_n_recover(mutation(&group)).unwrap();
        assert_eq!(recovered.phase, BestOfNPhase::AwaitingSelection);
        assert_eq!(
            fixture
                .service
                .best_of_n_select(
                    BestOfNSelect {
                        mutation: mutation(&recovered),
                        candidate_id: recovered.candidates[0].candidate_id.clone(),
                        head_sha: recovered.candidates[0].head_sha.clone().unwrap()
                    },
                    BestOfNSelectionOrigin::InteractiveUser
                )
                .unwrap()
                .phase,
            BestOfNPhase::Publishing
        );
    }
}
