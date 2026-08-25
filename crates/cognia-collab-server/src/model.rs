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
        };
        let json = serde_json::to_string(&issue).unwrap();
        assert!(!json.contains("assignee"), "{json}");
        assert!(json.contains("\"createdBy\""), "{json}");
    }
}
