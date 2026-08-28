//! The wire and storage shapes of the collaboration plane — ADR-0149 §6.
//!
//! # Why the actor id is not optional here
//!
//! ADR-0132 gave `IssueActor.id` an explicit reason for being optional: "the
//! local app is single-user". ADR-0149 §10 supersedes exactly that reason. On
//! a plane where more than one person can see the same board, an actor of kind
//! `human` with no id names nobody — every issue would read "assigned to the
//! human", and no filter, notification or audit line could tell Ada from Bob.
//!
//! So [`CollabActor`] carries a required id, and a `human` id must be a
//! `usr_…`. The local client keeps its optional-id shape for offline work; the
//! conversion at the boundary refuses rather than inventing one, which is the
//! whole point — an anonymous human must not silently become somebody.

use cognia_tenant_auth::UserId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Human,
    Agent,
    Team,
}

impl ActorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Agent => "agent",
            Self::Team => "team",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "human" => Some(Self::Human),
            "agent" => Some(Self::Agent),
            "team" => Some(Self::Team),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ActorError {
    #[error("a `human` actor on the collaboration plane must carry a usr_ id: {0}")]
    NotAUser(String),
    #[error("an actor id must not be blank")]
    Blank,
    #[error("`{0}` is not an actor kind")]
    UnknownKind(String),
}

/// Who did something, on a plane where "the local user" names nobody.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabActor {
    pub kind: ActorKind,
    pub id: String,
    /// Cached at write time so a board renders without a join, exactly as the
    /// local `IssueActor` does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl CollabActor {
    /// Build an actor, enforcing that a human is a `usr_…`.
    ///
    /// Agent and team ids are opaque here on purpose: they name a `Character`
    /// or an `AgentTeam` in the client's own id spaces, and this crate has no
    /// business validating a namespace it does not own.
    pub fn new(
        kind: ActorKind,
        id: impl Into<String>,
        label: Option<String>,
    ) -> Result<Self, ActorError> {
        let id = id.into();
        if id.trim().is_empty() {
            return Err(ActorError::Blank);
        }
        if kind == ActorKind::Human && !UserId::is_valid(&id) {
            return Err(ActorError::NotAUser(id));
        }
        Ok(Self { kind, id, label })
    }

    pub fn human(user: &UserId, label: Option<String>) -> Self {
        Self {
            kind: ActorKind::Human,
            id: user.as_str().to_owned(),
            label,
        }
    }

    /// Rebuild from the flat columns the `issues` table stores.
    pub fn from_columns(kind: &str, id: &str, label: Option<String>) -> Result<Self, ActorError> {
        let kind =
            ActorKind::parse(kind).ok_or_else(|| ActorError::UnknownKind(kind.to_owned()))?;
        Self::new(kind, id, label)
    }
}

/// Board columns. Mirrors `ISSUE_STATUSES` in `types/issues/index.ts`; a
/// parity test pins the two together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueStatus {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Done,
    /// One `l`, matching the client. `ISSUE_STATUSES` spells it `canceled`,
    /// and a server that spells it `cancelled` writes a column no board renders.
    Canceled,
}

/// Mirrors `ISSUE_PRIORITIES`. Deliberately not `SubAgentPriority` — see the
/// note in `types/issues/index.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssuePriority {
    Urgent,
    High,
    /// `medium`, not `normal` — `ISSUE_PRIORITIES` is the authority and it is
    /// deliberately not `SubAgentPriority`'s vocabulary.
    Medium,
    Low,
    None,
}

macro_rules! string_enum {
    ($name:ident, $($variant:ident => $text:literal),+ $(,)?) => {
        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }

            pub fn parse(value: &str) -> Option<Self> {
                match value { $($text => Some(Self::$variant),)+ _ => None }
            }
        }
    };
}

string_enum!(
    IssueStatus,
    Backlog => "backlog",
    Todo => "todo",
    InProgress => "in_progress",
    InReview => "in_review",
    Done => "done",
    Canceled => "canceled",
);

string_enum!(
    IssuePriority,
    Urgent => "urgent",
    High => "high",
    Medium => "medium",
    Low => "low",
    None => "none",
);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub issue_project_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub status: IssueStatus,
    pub priority: IssuePriority,
    pub board_order: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<CollabActor>,
    pub created_by: CollabActor,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: i64,
    pub created_operation_id: String,
    pub last_operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueEvent {
    pub id: String,
    pub issue_id: String,
    pub kind: String,
    pub ts: i64,
    pub actor: CollabActor,
    #[serde(default)]
    pub payload: serde_json::Value,
    pub operation_id: String,
}

// ── Plans and Runs (Batch 7c) ────────────────────────────────────────────────
//
// The plane's view of ADR-0045's execution hub. Deliberately narrower than the
// local model: see the header of `migrations/0003_plans_runs.sql` for the list
// of fields that stay on the machine that produced them, and why.

/// Plan lifecycle. Mirrors `PlanStatus` in `types/agent/plan.ts`.
///
/// Note `cancelled` with two `l`s here, against `IssueStatus::Canceled` with
/// one. That is not a typo to be tidied — the two client unions genuinely
/// disagree, and a server that "corrected" either one would write a state the
/// corresponding surface cannot render. The parity tests pin both spellings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Draft,
    AwaitingApproval,
    Approved,
    Executing,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

/// How one step executes. Mirrors `PlanStepKind`.
///
/// The kind travels even though the step's `params` do not: "this step
/// delegates to a teammate" is readable by a colleague, while the teammate id
/// and spawn prompt are the machine-local half.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepKind {
    AgentTurn,
    TeammateDispatch,
    ToolCall,
    McpToolCall,
    SubWorkflow,
    ApprovalGate,
    EditorReview,
}

/// Step lifecycle. Mirrors `PlanStepStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    Ready,
    InProgress,
    Completed,
    Failed,
    Skipped,
    Blocked,
}

/// Which engine a run was dispatched to. Mirrors `ISSUE_RUN_KINDS`.
///
/// Spelled with hyphens on the wire because the client's array is, and a kind
/// this server writes as `agent_task` is a badge no board renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunKind {
    #[serde(rename = "agent-task")]
    AgentTask,
    #[serde(rename = "agent-team")]
    AgentTeam,
    #[serde(rename = "github-loop")]
    GithubLoop,
    /// A dispatch that is neither of the issue engines — an approved plan
    /// executing under the plan runtime. No local `IssueRun` has this kind,
    /// because `issueRuns` only ever describes an issue; it exists here
    /// because on the plane a plan's execution is a run like any other.
    #[serde(rename = "plan")]
    Plan,
}

/// Run lifecycle. Mirrors `ISSUE_RUN_STATUSES` — `cancelled`, two `l`s.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl RunStatus {
    /// The two non-terminal states, matching `isActiveIssueRunStatus`.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

string_enum!(
    PlanStatus,
    Draft => "draft",
    AwaitingApproval => "awaiting_approval",
    Approved => "approved",
    Executing => "executing",
    Paused => "paused",
    Completed => "completed",
    Failed => "failed",
    Cancelled => "cancelled",
);

string_enum!(
    PlanStepKind,
    AgentTurn => "agent_turn",
    TeammateDispatch => "teammate_dispatch",
    ToolCall => "tool_call",
    McpToolCall => "mcp_tool_call",
    SubWorkflow => "sub_workflow",
    ApprovalGate => "approval_gate",
    EditorReview => "editor_review",
);

string_enum!(
    PlanStepStatus,
    Pending => "pending",
    Ready => "ready",
    InProgress => "in_progress",
    Completed => "completed",
    Failed => "failed",
    Skipped => "skipped",
    Blocked => "blocked",
);

string_enum!(
    RunKind,
    AgentTask => "agent-task",
    AgentTeam => "agent-team",
    GithubLoop => "github-loop",
    Plan => "plan",
);

string_enum!(
    RunStatus,
    Queued => "queued",
    Running => "running",
    Succeeded => "succeeded",
    Failed => "failed",
    Cancelled => "cancelled",
);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: String,
    pub plan_id: String,
    /// 0-based display order. The DAG's `dependencies` do not travel: nothing
    /// on this plane executes a plan, and shipping edges no reader renders is
    /// the dormant-data shape ADR-0149 exists to remove.
    pub order: i32,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub kind: PlanStepKind,
    pub status: PlanStepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: PlanStatus,
    /// Recomputed by the store from `steps` on every write — never taken from
    /// a client, which would let two writers disagree about one plan's
    /// progress with no way to settle it.
    pub total_steps: i32,
    pub completed_steps: i32,
    pub created_by: CollabActor,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: i64,
    pub created_operation_id: String,
    pub last_operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// Present on a single-plan read, absent from a listing. A board renders
    /// the header from the counts; only the detail view spends a second query.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<PlanStep>>,
}

/// A produced thing worth linking from a run.
///
/// `href` is http(s) only, enforced by `run_artifacts_href_is_web` — see the
/// migration for why a `file://` link is worse than no link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArtifact {
    pub label: String,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArtifactError {
    #[error("an artifact link must be http(s): {0}")]
    NotWeb(String),
    #[error("an artifact label must not be blank")]
    BlankLabel,
}

impl RunArtifact {
    /// Build an artifact, refusing anything the database would refuse anyway.
    ///
    /// Checked here as well as in SQL so the client gets a 400 naming the bad
    /// link instead of a 500 carrying a constraint name.
    pub fn new(label: impl Into<String>, href: impl Into<String>) -> Result<Self, ArtifactError> {
        let label = label.into();
        let href = href.into();
        if label.trim().is_empty() {
            return Err(ArtifactError::BlankLabel);
        }
        if !href.starts_with("http://") && !href.starts_with("https://") {
            return Err(ArtifactError::NotWeb(href));
        }
        Ok(Self { label, href })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    /// Both optional and neither required: an ad-hoc dispatch attaches to
    /// nothing and is still worth showing. `title` carries the weight instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    pub title: String,
    pub kind: RunKind,
    pub status: RunStatus,
    pub started_by: CollabActor,
    pub started_at: i64,
    pub updated_at: i64,
    pub revision: i64,
    pub created_operation_id: String,
    pub last_operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<RunArtifact>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> UserId {
        UserId::parse("usr_0123456789abcdef01234567").unwrap()
    }

    #[test]
    fn a_human_actor_must_be_a_user() {
        // The supersession, as a test: an anonymous human cannot exist here.
        assert!(matches!(
            CollabActor::new(ActorKind::Human, "local", None),
            Err(ActorError::NotAUser(_))
        ));
        assert!(CollabActor::new(ActorKind::Human, user().as_str(), None).is_ok());
    }

    #[test]
    fn agent_and_team_ids_stay_opaque() {
        // They name a Character or an AgentTeam in the client's id spaces, and
        // this crate does not own those namespaces.
        assert!(CollabActor::new(ActorKind::Agent, "char_7", None).is_ok());
        assert!(CollabActor::new(ActorKind::Team, "team-alpha", None).is_ok());
    }

    #[test]
    fn no_actor_kind_accepts_a_blank_id() {
        for kind in [ActorKind::Human, ActorKind::Agent, ActorKind::Team] {
            assert!(matches!(
                CollabActor::new(kind, "   ", None),
                Err(ActorError::Blank)
            ));
        }
    }

    #[test]
    fn column_round_trip_preserves_the_actor() {
        let actor = CollabActor::human(&user(), Some("Ada".into()));
        let rebuilt =
            CollabActor::from_columns(actor.kind.as_str(), &actor.id, actor.label.clone()).unwrap();
        assert_eq!(actor, rebuilt);
        assert!(matches!(
            CollabActor::from_columns("robot", "x", None),
            Err(ActorError::UnknownKind(_))
        ));
    }

    #[test]
    fn enums_round_trip_through_their_stored_spelling() {
        for status in IssueStatus::ALL {
            assert_eq!(IssueStatus::parse(status.as_str()), Some(*status));
            assert_eq!(
                serde_json::to_string(status).unwrap(),
                format!("\"{}\"", status.as_str())
            );
        }
        for priority in IssuePriority::ALL {
            assert_eq!(IssuePriority::parse(priority.as_str()), Some(*priority));
        }
        assert_eq!(IssueStatus::parse("nope"), None);
    }

    /// Parity guard: the client owns the board's vocabulary, and a status this
    /// server accepts but the board cannot render is a column of invisible work.
    ///
    /// Compares the whole array literal rather than probing for each word —
    /// this caught `cancelled` vs `canceled` and `normal` vs `medium`, neither
    /// of which a per-word `contains` would have noticed.
    #[test]
    fn stays_in_step_with_the_client_status_and_priority_lists() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../types/issues/index.ts"),
        )
        .expect("types/issues/index.ts is the client-side authority");

        // `ISSUE_STATUSES` is written one-per-line; `ISSUE_PRIORITIES` inline.
        let statuses = IssueStatus::ALL
            .iter()
            .map(|status| format!("  \"{}\",", status.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            source.contains(&format!("ISSUE_STATUSES = [\n{statuses}\n] as const")),
            "the client status list changed; expected\n{statuses}"
        );

        let priorities = IssuePriority::ALL
            .iter()
            .map(|priority| format!("\"{}\"", priority.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        assert!(
            source.contains(&format!("ISSUE_PRIORITIES = [{priorities}] as const")),
            "the client priority list changed; expected [{priorities}]"
        );
    }

    #[test]
    fn an_unassigned_issue_omits_the_field_rather_than_sending_null() {
        let issue = Issue {
            id: "iss_1".into(),
            org_id: "org_acme".into(),
            workspace_id: "proj-1".into(),
            issue_project_id: "cont-1".into(),
            title: "Ship it".into(),
            body: None,
            status: IssueStatus::Todo,
            priority: IssuePriority::Medium,
            board_order: 1.0,
            assignee: None,
            created_by: CollabActor::human(&user(), None),
            created_at: 1,
            updated_at: 1,
            revision: 1,
            created_operation_id: "op-create".into(),
            last_operation_id: "op-create".into(),
        };
        let json = serde_json::to_string(&issue).unwrap();
        assert!(!json.contains("assignee"), "{json}");
        assert!(json.contains("\"createdBy\""), "{json}");
    }

    // ── Plans and Runs (Batch 7c) ────────────────────────────────────────────

    fn client_source(relative: &str) -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(relative),
        )
        .unwrap_or_else(|_| panic!("{relative} is the client-side authority"))
    }

    /// Both spellings prettier produces for a string-literal union: one variant
    /// per line with leading pipes, or all of them on one line.
    ///
    /// Accepting either means a reflow caused by a longer variant name does not
    /// fail the test, while adding, removing or renaming a variant still does.
    fn union_spellings(name: &str, variants: &[&str]) -> Vec<String> {
        let quoted: Vec<String> = variants
            .iter()
            .map(|value| format!("\"{value}\""))
            .collect();
        vec![
            format!("export type {name} =\n  | {}\n", quoted.join("\n  | ")),
            format!("export type {name} =\n  {}\n", quoted.join(" | ")),
        ]
    }

    fn assert_union_matches(relative: &str, name: &str, variants: &[&str]) {
        let source = client_source(relative);
        let spellings = union_spellings(name, variants);
        assert!(
            spellings.iter().any(|spelling| source.contains(spelling)),
            "the client `{name}` union changed; expected one of\n{}",
            spellings.join("\n--- or ---\n")
        );
    }

    #[test]
    fn plan_enums_stay_in_step_with_the_client_unions() {
        // Same guard as the issue board's, one subsystem over: a status this
        // server accepts but the plan panel cannot render is invisible work.
        assert_union_matches(
            "types/agent/plan.ts",
            "PlanStatus",
            &PlanStatus::ALL
                .iter()
                .map(|status| status.as_str())
                .collect::<Vec<_>>(),
        );
        assert_union_matches(
            "types/agent/plan.ts",
            "PlanStepKind",
            &PlanStepKind::ALL
                .iter()
                .map(|kind| kind.as_str())
                .collect::<Vec<_>>(),
        );
        assert_union_matches(
            "types/agent/plan.ts",
            "PlanStepStatus",
            &PlanStepStatus::ALL
                .iter()
                .map(|status| status.as_str())
                .collect::<Vec<_>>(),
        );
    }

    #[test]
    fn run_enums_stay_in_step_with_the_client_arrays() {
        let source = client_source("types/issues/index.ts");

        // `plan` is deliberately NOT in the client array — `issueRuns` only ever
        // describes an issue, and a plan's execution is a run this plane knows
        // about and that table does not. So the parity check is over the three
        // kinds the client owns, and the fourth is asserted to be absent there.
        let client_kinds = [RunKind::AgentTask, RunKind::AgentTeam, RunKind::GithubLoop]
            .iter()
            .map(|kind| format!("\"{}\"", kind.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        assert!(
            source.contains(&format!("ISSUE_RUN_KINDS = [{client_kinds}] as const")),
            "the client run-kind list changed; expected [{client_kinds}]"
        );
        assert!(
            !source.contains("\"plan\""),
            "`plan` appeared in the client run kinds; the split in RunKind's doc comment is stale"
        );

        let statuses = RunStatus::ALL
            .iter()
            .map(|status| format!("\"{}\"", status.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        assert!(
            source.contains(&format!("ISSUE_RUN_STATUSES = [{statuses}] as const")),
            "the client run-status list changed; expected [{statuses}]"
        );
    }

    /// The two `cancel*` spellings genuinely disagree across subsystems, and
    /// each one is right for its own surface. Pinned as its own test so a tidy-up
    /// that "fixes the typo" fails here with the reason attached rather than
    /// silently writing a state one of the two panels cannot render.
    #[test]
    fn the_two_cancel_spellings_are_both_deliberate() {
        assert_eq!(IssueStatus::Canceled.as_str(), "canceled");
        assert_eq!(PlanStatus::Cancelled.as_str(), "cancelled");
        assert_eq!(RunStatus::Cancelled.as_str(), "cancelled");
        // And neither parses the other's spelling, so a cross-wired writer
        // fails loudly at the boundary instead of storing an unknown word.
        assert_eq!(IssueStatus::parse("cancelled"), None);
        assert_eq!(PlanStatus::parse("canceled"), None);
        assert_eq!(RunStatus::parse("canceled"), None);
    }

    #[test]
    fn plan_and_run_enums_round_trip_through_their_stored_spelling() {
        for status in PlanStatus::ALL {
            assert_eq!(PlanStatus::parse(status.as_str()), Some(*status));
            assert_eq!(
                serde_json::to_string(status).unwrap(),
                format!("\"{}\"", status.as_str())
            );
        }
        for kind in PlanStepKind::ALL {
            assert_eq!(PlanStepKind::parse(kind.as_str()), Some(*kind));
            assert_eq!(
                serde_json::to_string(kind).unwrap(),
                format!("\"{}\"", kind.as_str())
            );
        }
        for status in PlanStepStatus::ALL {
            assert_eq!(PlanStepStatus::parse(status.as_str()), Some(*status));
        }
        for kind in RunKind::ALL {
            assert_eq!(RunKind::parse(kind.as_str()), Some(*kind));
            // Hyphens, not underscores: `#[serde(rename_all = "snake_case")]`
            // would have written `agent_task` and no board renders that badge.
            assert_eq!(
                serde_json::to_string(kind).unwrap(),
                format!("\"{}\"", kind.as_str())
            );
        }
        for status in RunStatus::ALL {
            assert_eq!(RunStatus::parse(status.as_str()), Some(*status));
        }
    }

    #[test]
    fn only_queued_and_running_count_as_active() {
        assert!(RunStatus::Queued.is_active());
        assert!(RunStatus::Running.is_active());
        for status in [
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
        ] {
            assert!(!status.is_active(), "{status:?}");
        }
    }

    #[test]
    fn an_artifact_link_must_be_reachable_from_another_machine() {
        assert!(RunArtifact::new("PR #12", "https://github.com/x/y/pull/12").is_ok());
        assert!(RunArtifact::new("Build", "http://ci.internal/builds/9").is_ok());
        // The whole reason this rule exists: the href would publish the shape
        // of one person's home directory and open nothing on anybody else's.
        assert!(matches!(
            RunArtifact::new("Worktree", "file:///Users/ada/code/cognia"),
            Err(ArtifactError::NotWeb(_))
        ));
        assert!(matches!(
            RunArtifact::new("Session", "cognia://session/7"),
            Err(ArtifactError::NotWeb(_))
        ));
        assert!(matches!(
            RunArtifact::new("  ", "https://example.com"),
            Err(ArtifactError::BlankLabel)
        ));
    }

    #[test]
    fn a_listed_plan_omits_its_steps_rather_than_sending_an_empty_array() {
        // The two are different answers: `null`/absent means "not asked for",
        // `[]` means "asked, and there are none". A listing that sent `[]`
        // would make every plan look empty until the detail view loaded.
        let plan = Plan {
            id: "plan_1".into(),
            org_id: "org_acme".into(),
            workspace_id: "proj-1".into(),
            title: "Migrate the store".into(),
            description: None,
            status: PlanStatus::Executing,
            total_steps: 3,
            completed_steps: 1,
            created_by: CollabActor::human(&user(), None),
            created_at: 1,
            updated_at: 2,
            revision: 1,
            created_operation_id: "op-create".into(),
            last_operation_id: "op-create".into(),
            ended_at: None,
            steps: None,
        };
        let json = serde_json::to_string(&plan).unwrap();
        assert!(!json.contains("steps"), "{json}");
        assert!(json.contains("\"totalSteps\":3"), "{json}");

        let with_steps = Plan {
            steps: Some(vec![]),
            ..plan
        };
        assert!(serde_json::to_string(&with_steps)
            .unwrap()
            .contains("\"steps\":[]"));
    }

    #[test]
    fn an_unattached_run_omits_both_subjects_and_keeps_its_title() {
        let run = Run {
            id: "run_1".into(),
            org_id: "org_acme".into(),
            workspace_id: "proj-1".into(),
            issue_id: None,
            plan_id: None,
            title: "Ad-hoc sweep".into(),
            kind: RunKind::AgentTask,
            status: RunStatus::Running,
            started_by: CollabActor::human(&user(), Some("Ada".into())),
            started_at: 5,
            updated_at: 5,
            revision: 1,
            created_operation_id: "op-create".into(),
            last_operation_id: "op-create".into(),
            ended_at: None,
            summary: None,
            error: None,
            artifacts: vec![],
        };
        let json = serde_json::to_string(&run).unwrap();
        assert!(!json.contains("issueId"), "{json}");
        assert!(!json.contains("planId"), "{json}");
        assert!(json.contains("\"title\":\"Ad-hoc sweep\""), "{json}");
        assert!(json.contains("\"kind\":\"agent-task\""), "{json}");
        assert!(json.contains("\"artifacts\":[]"), "{json}");
    }
}
