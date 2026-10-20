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

/// Read-time standing preserves ownership acquired by creating a session.
/// Every workspace writer may own their session; viewers are read-only.
pub fn session_read_role_ceiling(
    standing: cognia_tenant_auth::membership::EffectiveWorkspaceAccess,
) -> SessionRole {
    use cognia_tenant_auth::WorkspaceRole;
    match standing.role {
        WorkspaceRole::Maintainer | WorkspaceRole::Member => SessionRole::Owner,
        WorkspaceRole::Viewer => SessionRole::Viewer,
    }
}

/// Grant-time standing limits roles assigned to someone by another manager.
/// Unlike a creator's ownership, a grant to a plain writer stops at Member.
/// Org owner/admin traversal resolves to Maintainer before reaching this rule.
pub fn session_grant_role_ceiling(
    standing: cognia_tenant_auth::membership::EffectiveWorkspaceAccess,
) -> SessionRole {
    use cognia_tenant_auth::WorkspaceRole;
    match standing.role {
        WorkspaceRole::Maintainer => SessionRole::Owner,
        WorkspaceRole::Member => SessionRole::Member,
        WorkspaceRole::Viewer => SessionRole::Viewer,
    }
}

pub fn can_change_member_role(actor: SessionRole, existing: Option<SessionRole>, requested: SessionRole) -> bool {
    actor == SessionRole::Owner
        || (existing != Some(SessionRole::Owner) && requested != SessionRole::Owner)
}

pub fn cap_session_member(
    mut member: SessionMembership,
    standing: Option<cognia_tenant_auth::membership::EffectiveWorkspaceAccess>,
) -> Option<SessionMembership> {
    if member.guest {
        return Some(member);
    }
    let ceiling = session_read_role_ceiling(standing?);
    if session_role_rank(member.role) > session_role_rank(ceiling) {
        member.role = ceiling;
    }
    if member.role == SessionRole::Viewer {
        member.approver = false;
    }
    Some(member)
}

pub fn session_role_rank(role: SessionRole) -> u8 {
    match role {
        SessionRole::Viewer => 0,
        SessionRole::Member => 1,
        SessionRole::Maintainer => 2,
        SessionRole::Owner => 3,
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
    /// Publish the conversation's files as a link (ADR-0222). Owners and
    /// maintainers, never a guest; the org's file-sharing policy is checked
    /// on top.
    FilesShare,
    /// Read the files a host shares live with the conversation's members
    /// (ADR-0222 §6): every role, a guest too — a grant still has to name
    /// them.
    FilesReadLive,
    /// Change those files through a live grant that allows it: owners,
    /// maintainers and members, never a viewer or a guest.
    FilesWriteLive,
}

impl SessionAction {
    /// Every server-side action, in wire order.
    pub const ALL: [SessionAction; 19] = [
        Self::Discover,
        Self::Read,
        Self::Post,
        Self::StartRun,
        Self::Steer,
        Self::ManageMembers,
        Self::ManageSettings,
        Self::Delete,
        Self::RedactAny,
        Self::ApproveOrdinary,
        Self::ApproveHighRisk,
        Self::Export,
        Self::AuditMetadata,
        Self::BreakGlassRead,
        Self::AttachmentRead,
        Self::AttachmentWrite,
        Self::FilesShare,
        Self::FilesReadLive,
        Self::FilesWriteLive,
    ];

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
            Self::FilesShare => "files.share",
            Self::FilesReadLive => "files.readLive",
            Self::FilesWriteLive => "files.writeLive",
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
            | SessionAction::FilesShare
            | SessionAction::FilesWriteLive
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
                    | SessionAction::FilesReadLive
                    | SessionAction::FilesWriteLive
            ) || (action == SessionAction::ApproveHighRisk && membership.approver)
        }
        SessionRole::Viewer => matches!(
            action,
            SessionAction::Discover
                | SessionAction::Read
                | SessionAction::AttachmentRead
                | SessionAction::FilesReadLive
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
    fn read_and_grant_ceilings_distinguish_creator_ownership_from_assigned_roles() {
        use cognia_tenant_auth::{membership::resolve_workspace_access, OrgRole, WorkspaceRole};
        for (workspace, read, grant) in [
            (WorkspaceRole::Maintainer, SessionRole::Owner, SessionRole::Owner),
            (WorkspaceRole::Member, SessionRole::Owner, SessionRole::Member),
            (WorkspaceRole::Viewer, SessionRole::Viewer, SessionRole::Viewer),
        ] {
            let standing = resolve_workspace_access(Some(OrgRole::Member), Some(workspace)).unwrap();
            assert_eq!(session_read_role_ceiling(standing), read);
            assert_eq!(session_grant_role_ceiling(standing), grant);
        }
        for org in [OrgRole::Owner, OrgRole::Admin] {
            let standing = resolve_workspace_access(Some(org), Some(WorkspaceRole::Viewer)).unwrap();
            assert_eq!(session_read_role_ceiling(standing), SessionRole::Owner);
            assert_eq!(session_grant_role_ceiling(standing), SessionRole::Owner);
        }
    }

    #[test]
    fn current_workspace_standing_caps_non_guests_and_never_changes_session_guests() {
        use cognia_tenant_auth::{membership::resolve_workspace_access, OrgRole, WorkspaceRole};
        let member = SessionMembership {
            session_id: "session".into(), user_id: "user".into(), role: SessionRole::Maintainer,
            approver: true, guest: false, display_name: None, created_at: 1, updated_at: 1,
        };
        assert!(cap_session_member(member.clone(), None).is_none());
        for (workspace, expected) in [(WorkspaceRole::Maintainer, SessionRole::Maintainer), (WorkspaceRole::Member, SessionRole::Maintainer), (WorkspaceRole::Viewer, SessionRole::Viewer)] {
            let effective = cap_session_member(member.clone(), resolve_workspace_access(Some(OrgRole::Member), Some(workspace))).unwrap();
            assert_eq!(effective.role, expected);
            assert_eq!(effective.approver, expected != SessionRole::Viewer);
        }
        let guest = SessionMembership { role: SessionRole::Member, approver: false, guest: true, ..member.clone() };
        assert_eq!(cap_session_member(guest.clone(), None), Some(guest));
        assert_eq!(cap_session_member(member.clone(), resolve_workspace_access(Some(OrgRole::Admin), Some(WorkspaceRole::Viewer))), Some(member));
    }

    #[test]
    fn explicit_membership_is_required_even_when_the_id_is_known() {
        let decision = authorize_session_action(None, SessionAction::Read, 8);
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "not_a_session_member");
    }

    /// `fixtures/session-actions.json` is the table the client checks too.
    #[test]
    fn decisions_match_the_shared_action_table() {
        let table: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/session-actions.json")).unwrap();
        let strings = |value: &serde_json::Value| -> Vec<String> {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item.as_str().unwrap().to_owned())
                .collect()
        };
        let client_only = strings(&table["clientOnlyActions"]);
        let server_actions: Vec<String> = strings(&table["actions"])
            .into_iter()
            .filter(|action| !client_only.contains(action))
            .collect();
        let ours: Vec<String> = SessionAction::ALL
            .iter()
            .map(|action| action.as_str().to_owned())
            .collect();
        assert_eq!(ours, server_actions, "SessionAction::ALL vs the table");

        let guest_denied = strings(&table["guestDenied"]);
        let overlay_roles = strings(&table["approverOverlay"]["roles"]);
        let overlay_actions = strings(&table["approverOverlay"]["actions"]);
        for (name, role) in [
            ("owner", SessionRole::Owner),
            ("maintainer", SessionRole::Maintainer),
            ("member", SessionRole::Member),
            ("viewer", SessionRole::Viewer),
        ] {
            let allowed = strings(&table["roles"][name]);
            for guest in [false, true] {
                for approver in [false, true] {
                    let mut who = membership(role);
                    who.guest = guest;
                    who.approver = approver;
                    for action in SessionAction::ALL {
                        let wire = action.as_str().to_owned();
                        let expected = !(guest && guest_denied.contains(&wire))
                            && (allowed.contains(&wire)
                                || (approver
                                    && overlay_roles.iter().any(|r| r == name)
                                    && overlay_actions.contains(&wire)));
                        assert_eq!(
                            authorize_session_action(Some(&who), action, 1).allowed,
                            expected,
                            "{name} guest={guest} approver={approver} {wire}"
                        );
                    }
                }
            }
        }
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
