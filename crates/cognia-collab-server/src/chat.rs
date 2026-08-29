use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Importing,
    Active,
    Archived,
    Deleting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRole {
    Owner,
    Maintainer,
    Member,
    Viewer,
}

impl SessionRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Maintainer => "maintainer",
            Self::Member => "member",
            Self::Viewer => "viewer",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "owner" => Some(Self::Owner),
            "maintainer" => Some(Self::Maintainer),
            "member" => Some(Self::Member),
            "viewer" => Some(Self::Viewer),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAction {
    Discover,
    Read,
    Post,
    StartRun,
    Steer,
    ManageMembers,
    ManageSettings,
    Delete,
    RedactAny,
    ApproveOrdinary,
    ApproveHighRisk,
    Export,
    AuditMetadata,
    BreakGlassRead,
    AttachmentRead,
    AttachmentWrite,
}

impl SessionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Discover => "session.discover",
            Self::Read => "session.read",
            Self::Post => "session.post",
            Self::StartRun => "session.startRun",
            Self::Steer => "session.steer",
            Self::ManageMembers => "session.manageMembers",
            Self::ManageSettings => "session.manageSettings",
            Self::Delete => "session.delete",
            Self::RedactAny => "message.redactAny",
            Self::ApproveOrdinary => "run.approveOrdinary",
            Self::ApproveHighRisk => "run.approveHighRisk",
            Self::Export => "session.export",
            Self::AuditMetadata => "session.auditMetadata",
            Self::BreakGlassRead => "session.breakGlassRead",
            Self::AttachmentRead => "attachment.read",
            Self::AttachmentWrite => "attachment.write",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMembership {
    pub session_id: String,
    pub user_id: String,
    pub role: SessionRole,
    pub approver: bool,
    pub guest: bool,
    pub display_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSession {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub title: String,
    pub status: SessionStatus,
    pub created_by_user_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: i64,
    pub policy_revision: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    pub session_id: String,
    pub sequence: i64,
    pub kind: String,
    pub actor_kind: String,
    pub actor_id: String,
    pub actor_label: Option<String>,
    pub payload: serde_json::Value,
    pub created_at: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAuthorizationDecision {
    pub allowed: bool,
    pub reason: &'static str,
    pub policy_revision: i64,
}

pub fn authorize_session_action(
    membership: Option<&SessionMembership>,
    action: SessionAction,
    policy_revision: i64,
) -> SessionAuthorizationDecision {
    let Some(membership) = membership else {
        return SessionAuthorizationDecision {
            allowed: false,
            reason: "not_a_session_member",
            policy_revision,
        };
    };
    let guest_denied = matches!(
        action,
        SessionAction::ManageMembers
            | SessionAction::ManageSettings
            | SessionAction::Delete
            | SessionAction::RedactAny
            | SessionAction::ApproveHighRisk
            | SessionAction::Export
            | SessionAction::AuditMetadata
            | SessionAction::BreakGlassRead
    );
    if membership.guest && guest_denied {
        return SessionAuthorizationDecision {
            allowed: false,
            reason: "guest_capability_ceiling",
            policy_revision,
        };
    }
    let allowed = match membership.role {
        SessionRole::Owner => action != SessionAction::BreakGlassRead,
        SessionRole::Maintainer => !matches!(
            action,
            SessionAction::Delete | SessionAction::BreakGlassRead
        ),
        SessionRole::Member => {
            matches!(
                action,
                SessionAction::Discover
                    | SessionAction::Read
                    | SessionAction::Post
                    | SessionAction::StartRun
                    | SessionAction::ApproveOrdinary
                    | SessionAction::AttachmentRead
                    | SessionAction::AttachmentWrite
            ) || (action == SessionAction::ApproveHighRisk && membership.approver)
        }
        SessionRole::Viewer => matches!(
            action,
            SessionAction::Discover | SessionAction::Read | SessionAction::AttachmentRead
        ),
    };
    SessionAuthorizationDecision {
        allowed,
        reason: if allowed {
            "session_role"
        } else {
            "insufficient_session_role"
        },
        policy_revision,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn membership(role: SessionRole) -> SessionMembership {
        SessionMembership {
            session_id: "ses_1".into(),
            user_id: "usr_a".into(),
            role,
            approver: false,
            guest: false,
            display_name: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn explicit_membership_is_required_even_when_the_id_is_known() {
        let decision = authorize_session_action(None, SessionAction::Read, 8);
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "not_a_session_member");
    }

    #[test]
    fn approver_is_an_overlay_but_guests_can_never_hold_it() {
        let mut member = membership(SessionRole::Member);
        member.approver = true;
        assert!(authorize_session_action(Some(&member), SessionAction::ApproveHighRisk, 2).allowed);
        member.guest = true;
        assert!(
            !authorize_session_action(Some(&member), SessionAction::ApproveHighRisk, 2).allowed
        );
    }
}
