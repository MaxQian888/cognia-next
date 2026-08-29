use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use tokio_postgres::Row;

use crate::chat::{SessionEvent, SessionMembership, SessionRole, SessionStatus, SharedSession};
use crate::store::{PgStore, StoreError};

#[derive(Debug, Clone)]
pub struct NewSharedSession {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub title: String,
    pub status: SessionStatus,
    pub created_by_user_id: String,
    pub now: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone)]
pub struct NewSessionEvent {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub kind: String,
    pub actor_kind: String,
    pub actor_id: String,
    pub actor_label: Option<String>,
    pub payload: serde_json::Value,
    pub now: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRunLease {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub holder_user_id: String,
    pub holder_device_id: String,
    pub status: String,
    pub token_expires_at: i64,
    pub heartbeat_expires_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewChatRunLease {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub run_id: String,
    pub holder_user_id: String,
    pub holder_device_id: String,
    pub token_hash: String,
    pub token_expires_at: i64,
    pub heartbeat_expires_at: i64,
    pub now: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakGlassGrant {
    pub id: String,
    pub org_id: String,
    pub session_id: String,
    pub granted_to_user_id: String,
    pub reason: String,
    pub expires_at: i64,
    pub revoked_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewBreakGlassGrant {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub granted_to_user_id: String,
    pub reason: String,
    pub expires_at: i64,
    pub created_at: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionInvite {
    pub id: String,
    pub session_id: String,
    pub role: SessionRole,
    pub approver: bool,
    pub guest: bool,
    pub target_user_id: Option<String>,
    pub status: String,
    pub created_by_user_id: String,
    pub accepted_by_user_id: Option<String>,
    pub accepted_at: Option<i64>,
    pub expires_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewChatSessionInvite {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub token_hash: String,
    pub target_user_id: Option<String>,
    pub role: SessionRole,
    pub approver: bool,
    pub guest: bool,
    pub created_by_user_id: String,
    pub expires_at: i64,
    pub now: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatApprovalRequest {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub action: String,
    pub risk: String,
    pub requested_by_user_id: String,
    pub status: String,
    pub resolved_by_user_id: Option<String>,
    pub resolved_at: Option<i64>,
    pub expires_at: i64,
    pub created_at: i64,
    pub revision: i64,
}

#[derive(Debug, Clone)]
pub struct NewChatApprovalRequest {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub run_id: String,
    pub action: String,
    pub risk: String,
    pub requested_by_user_id: String,
    pub expires_at: i64,
    pub now: i64,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    pub id: String,
    pub session_id: String,
    pub event_id: Option<String>,
    #[serde(skip_serializing)]
    pub object_key: String,
    pub file_name: String,
    pub media_type: String,
    pub byte_length: i64,
    pub sha256: String,
    pub status: String,
    pub created_by_user_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewChatAttachment {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub object_key: String,
    pub file_name: String,
    pub media_type: String,
    pub byte_length: i64,
    pub sha256: String,
    pub created_by_user_id: String,
    pub now: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRunQueueItem {
    pub id: String,
    pub session_id: String,
    pub requested_by_user_id: String,
    pub payload: serde_json::Value,
    pub status: String,
    pub position: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewChatRunQueueItem {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub requested_by_user_id: String,
    pub payload: serde_json::Value,
    pub now: i64,
    pub operation_id: String,
}

#[async_trait]
#[allow(clippy::too_many_arguments)]
pub trait ChatStore: Send + Sync {
    async fn create_session(&self, input: NewSharedSession) -> Result<SharedSession, StoreError>;
    async fn list_sessions(
        &self,
        org_id: &str,
        user_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Vec<SharedSession>, StoreError>;
    async fn patch_session(
        &self,
        org_id: &str,
        session_id: &str,
        title: Option<&str>,
        status: Option<SessionStatus>,
        operation_id: &str,
        base_revision: i64,
        now: i64,
    ) -> Result<SharedSession, StoreError>;
    async fn delete_session_data(&self, org_id: &str, session_id: &str) -> Result<(), StoreError>;
    async fn visible_session(
        &self,
        org_id: &str,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<(SharedSession, SessionMembership)>, StoreError>;
    async fn admin_session(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<SharedSession, StoreError>;
    async fn list_members(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<SessionMembership>, StoreError>;
    async fn put_member(
        &self,
        org_id: &str,
        session_id: &str,
        workspace_id: &str,
        user_id: &str,
        role: SessionRole,
        approver: bool,
        guest: bool,
        now: i64,
    ) -> Result<SessionMembership, StoreError>;
    async fn remove_member(
        &self,
        org_id: &str,
        session_id: &str,
        user_id: &str,
        now: i64,
    ) -> Result<(), StoreError>;
    async fn create_invite(
        &self,
        input: NewChatSessionInvite,
    ) -> Result<ChatSessionInvite, StoreError>;
    async fn list_invites(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<ChatSessionInvite>, StoreError>;
    async fn accept_invite(
        &self,
        org_id: &str,
        token_hash: &str,
        user_id: &str,
        now: i64,
    ) -> Result<(ChatSessionInvite, SessionMembership), StoreError>;
    async fn revoke_invite(
        &self,
        org_id: &str,
        session_id: &str,
        invite_id: &str,
    ) -> Result<ChatSessionInvite, StoreError>;
    async fn append_session_event(
        &self,
        input: NewSessionEvent,
    ) -> Result<SessionEvent, StoreError>;
    async fn list_session_events(
        &self,
        org_id: &str,
        session_id: &str,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<SessionEvent>, StoreError>;
    async fn redacted_message_ids(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<String>, StoreError>;
    async fn get_message_event(
        &self,
        org_id: &str,
        session_id: &str,
        message_id: &str,
    ) -> Result<SessionEvent, StoreError>;
    async fn acquire_run_lease(&self, input: NewChatRunLease) -> Result<ChatRunLease, StoreError>;
    async fn heartbeat_run_lease(
        &self,
        org_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        holder_device_id: &str,
        token_hash: &str,
        heartbeat_expires_at: i64,
        now: i64,
    ) -> Result<ChatRunLease, StoreError>;
    async fn release_run_lease(
        &self,
        org_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        now: i64,
        status: &str,
    ) -> Result<ChatRunLease, StoreError>;
    async fn active_run_lease(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Option<ChatRunLease>, StoreError>;
    async fn validate_run_token(
        &self,
        org_id: &str,
        session_id: &str,
        run_id: &str,
        token_hash: &str,
        now: i64,
    ) -> Result<ChatRunLease, StoreError>;
    async fn enqueue_run_input(
        &self,
        input: NewChatRunQueueItem,
    ) -> Result<ChatRunQueueItem, StoreError>;
    async fn list_run_queue(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<ChatRunQueueItem>, StoreError>;
    async fn cancel_run_queue_item(
        &self,
        org_id: &str,
        session_id: &str,
        item_id: &str,
        actor_user_id: &str,
        elevated: bool,
    ) -> Result<ChatRunQueueItem, StoreError>;
    async fn create_break_glass_grant(
        &self,
        input: NewBreakGlassGrant,
    ) -> Result<BreakGlassGrant, StoreError>;
    async fn valid_break_glass_grant(
        &self,
        org_id: &str,
        session_id: &str,
        grant_id: &str,
        user_id: &str,
        now: i64,
    ) -> Result<BreakGlassGrant, StoreError>;
    async fn create_approval(
        &self,
        input: NewChatApprovalRequest,
    ) -> Result<ChatApprovalRequest, StoreError>;
    async fn list_approvals(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<ChatApprovalRequest>, StoreError>;
    async fn get_approval(
        &self,
        org_id: &str,
        session_id: &str,
        approval_id: &str,
    ) -> Result<ChatApprovalRequest, StoreError>;
    async fn resolve_approval(
        &self,
        org_id: &str,
        session_id: &str,
        approval_id: &str,
        resolver_user_id: &str,
        status: &str,
        base_revision: i64,
        now: i64,
    ) -> Result<ChatApprovalRequest, StoreError>;
    async fn create_attachment(
        &self,
        input: NewChatAttachment,
    ) -> Result<ChatAttachment, StoreError>;
    async fn get_attachment(
        &self,
        org_id: &str,
        session_id: &str,
        attachment_id: &str,
    ) -> Result<ChatAttachment, StoreError>;
    async fn list_session_attachments(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<ChatAttachment>, StoreError>;
    async fn commit_attachment(
        &self,
        org_id: &str,
        session_id: &str,
        attachment_id: &str,
        event_id: Option<&str>,
        now: i64,
    ) -> Result<ChatAttachment, StoreError>;
    async fn delete_attachment(
        &self,
        org_id: &str,
        session_id: &str,
        attachment_id: &str,
        now: i64,
    ) -> Result<ChatAttachment, StoreError>;
}

#[derive(Default)]
struct MemoryTables {
    sessions: HashMap<String, SharedSession>,
    memberships: HashMap<(String, String), SessionMembership>,
    events: HashMap<String, Vec<SessionEvent>>,
    leases: HashMap<String, (ChatRunLease, String, String, String)>,
    invites: HashMap<String, (ChatSessionInvite, String, String)>,
    approvals: HashMap<String, (ChatApprovalRequest, String, String)>,
    attachments: HashMap<String, (ChatAttachment, String)>,
    queue: HashMap<String, (ChatRunQueueItem, String, String)>,
    break_glass: HashMap<String, (BreakGlassGrant, String, String)>,
    operations: HashMap<(String, String), String>,
}

#[derive(Clone, Default)]
pub struct InMemoryChatStore {
    tables: Arc<RwLock<MemoryTables>>,
}

impl InMemoryChatStore {
    pub fn new() -> Self {
        Self::default()
    }
}

fn conflict(value: impl serde::Serialize) -> StoreError {
    StoreError::Conflict(serde_json::to_value(value).unwrap_or_default())
}

#[async_trait]
impl ChatStore for InMemoryChatStore {
    async fn create_session(&self, input: NewSharedSession) -> Result<SharedSession, StoreError> {
        let mut tables = self.tables.write();
        if let Some(id) = tables
            .operations
            .get(&(input.org_id.clone(), input.operation_id.clone()))
        {
            return tables.sessions.get(id).cloned().ok_or(StoreError::NotFound);
        }
        let session = SharedSession {
            id: input.id,
            org_id: input.org_id.clone(),
            workspace_id: input.workspace_id,
            title: input.title,
            status: input.status,
            created_by_user_id: input.created_by_user_id.clone(),
            created_at: input.now,
            updated_at: input.now,
            revision: 1,
            policy_revision: 1,
        };
        let owner = SessionMembership {
            session_id: session.id.clone(),
            user_id: input.created_by_user_id,
            role: SessionRole::Owner,
            approver: true,
            guest: false,
            display_name: None,
            created_at: input.now,
            updated_at: input.now,
        };
        tables
            .operations
            .insert((input.org_id, input.operation_id), session.id.clone());
        tables
            .memberships
            .insert((session.id.clone(), owner.user_id.clone()), owner);
        tables.sessions.insert(session.id.clone(), session.clone());
        Ok(session)
    }

    async fn list_sessions(
        &self,
        org_id: &str,
        user_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Vec<SharedSession>, StoreError> {
        let tables = self.tables.read();
        let mut sessions: Vec<_> = tables
            .sessions
            .values()
            .filter(|session| session.org_id == org_id)
            .filter(|session| workspace_id.is_none_or(|id| session.workspace_id == id))
            .filter(|session| {
                tables
                    .memberships
                    .contains_key(&(session.id.clone(), user_id.to_owned()))
            })
            .cloned()
            .collect();
        sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
        Ok(sessions)
    }

    async fn patch_session(
        &self,
        org_id: &str,
        session_id: &str,
        title: Option<&str>,
        status: Option<SessionStatus>,
        operation_id: &str,
        base_revision: i64,
        now: i64,
    ) -> Result<SharedSession, StoreError> {
        let mut tables = self.tables.write();
        if let Some(id) = tables
            .operations
            .get(&(org_id.to_owned(), operation_id.to_owned()))
        {
            return tables.sessions.get(id).cloned().ok_or(StoreError::NotFound);
        }
        let session = tables
            .sessions
            .get_mut(session_id)
            .filter(|session| session.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        if session.revision != base_revision {
            return Err(conflict(session.clone()));
        }
        if let Some(title) = title {
            session.title = title.to_owned();
        }
        if let Some(status) = status {
            session.status = status;
        }
        session.revision += 1;
        session.policy_revision += 1;
        session.updated_at = now;
        let updated = session.clone();
        tables.operations.insert(
            (org_id.to_owned(), operation_id.to_owned()),
            session_id.to_owned(),
        );
        Ok(updated)
    }

    async fn delete_session_data(&self, org_id: &str, session_id: &str) -> Result<(), StoreError> {
        let mut tables = self.tables.write();
        if tables
            .sessions
            .get(session_id)
            .is_none_or(|session| session.org_id != org_id)
        {
            return Err(StoreError::NotFound);
        }
        tables.sessions.remove(session_id);
        tables
            .memberships
            .retain(|(stored_session, _), _| stored_session != session_id);
        tables.events.remove(session_id);
        tables
            .leases
            .retain(|_, (lease, _, _, _)| lease.session_id != session_id);
        tables
            .invites
            .retain(|_, (invite, _, _)| invite.session_id != session_id);
        tables
            .approvals
            .retain(|_, (approval, _, _)| approval.session_id != session_id);
        tables
            .attachments
            .retain(|_, (attachment, _)| attachment.session_id != session_id);
        tables
            .queue
            .retain(|_, (item, _, _)| item.session_id != session_id);
        tables
            .break_glass
            .retain(|_, (grant, _, _)| grant.session_id != session_id);
        Ok(())
    }

    async fn visible_session(
        &self,
        org_id: &str,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<(SharedSession, SessionMembership)>, StoreError> {
        let tables = self.tables.read();
        let Some(session) = tables
            .sessions
            .get(session_id)
            .filter(|session| session.org_id == org_id)
            .cloned()
        else {
            return Ok(None);
        };
        Ok(tables
            .memberships
            .get(&(session_id.to_owned(), user_id.to_owned()))
            .cloned()
            .map(|membership| (session, membership)))
    }

    async fn admin_session(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<SharedSession, StoreError> {
        self.tables
            .read()
            .sessions
            .get(session_id)
            .filter(|session| session.org_id == org_id)
            .cloned()
            .ok_or(StoreError::NotFound)
    }

    async fn list_members(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<SessionMembership>, StoreError> {
        let tables = self.tables.read();
        if tables
            .sessions
            .get(session_id)
            .is_none_or(|session| session.org_id != org_id)
        {
            return Err(StoreError::NotFound);
        }
        let mut members: Vec<_> = tables
            .memberships
            .iter()
            .filter(|((session, _), _)| session == session_id)
            .map(|(_, member)| member.clone())
            .collect();
        members.sort_by(|left, right| left.user_id.cmp(&right.user_id));
        Ok(members)
    }

    async fn put_member(
        &self,
        org_id: &str,
        session_id: &str,
        _workspace_id: &str,
        user_id: &str,
        role: SessionRole,
        approver: bool,
        guest: bool,
        now: i64,
    ) -> Result<SessionMembership, StoreError> {
        if guest && (matches!(role, SessionRole::Owner | SessionRole::Maintainer) || approver) {
            return Err(StoreError::Corrupt("guest capability ceiling".into()));
        }
        let mut tables = self.tables.write();
        let session = tables
            .sessions
            .get_mut(session_id)
            .filter(|session| session.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        session.policy_revision += 1;
        session.updated_at = now;
        let existing = tables
            .memberships
            .get(&(session_id.to_owned(), user_id.to_owned()));
        let member = SessionMembership {
            session_id: session_id.to_owned(),
            user_id: user_id.to_owned(),
            role,
            approver: approver || matches!(role, SessionRole::Owner | SessionRole::Maintainer),
            guest,
            display_name: existing.and_then(|member| member.display_name.clone()),
            created_at: existing.map_or(now, |member| member.created_at),
            updated_at: now,
        };
        tables
            .memberships
            .insert((session_id.to_owned(), user_id.to_owned()), member.clone());
        Ok(member)
    }

    async fn remove_member(
        &self,
        org_id: &str,
        session_id: &str,
        user_id: &str,
        now: i64,
    ) -> Result<(), StoreError> {
        let mut tables = self.tables.write();
        let key = (session_id.to_owned(), user_id.to_owned());
        let removed = tables
            .memberships
            .get(&key)
            .cloned()
            .ok_or(StoreError::NotFound)?;
        if removed.role == SessionRole::Owner
            && tables
                .memberships
                .values()
                .filter(|member| {
                    member.session_id == session_id && member.role == SessionRole::Owner
                })
                .count()
                == 1
        {
            return Err(conflict(serde_json::json!({ "reason": "last_owner" })));
        }
        tables.memberships.remove(&key);
        let session = tables
            .sessions
            .get_mut(session_id)
            .filter(|session| session.org_id == org_id)
            .ok_or(StoreError::NotFound)?;
        session.policy_revision += 1;
        session.updated_at = now;
        for (lease, _, _, _) in tables.leases.values_mut() {
            if lease.session_id == session_id && lease.holder_user_id == user_id {
                lease.status = "failed".into();
                lease.updated_at = now;
            }
        }
        Ok(())
    }

    async fn create_invite(
        &self,
        input: NewChatSessionInvite,
    ) -> Result<ChatSessionInvite, StoreError> {
        if matches!(input.role, SessionRole::Owner)
            || (input.guest && (matches!(input.role, SessionRole::Maintainer) || input.approver))
        {
            return Err(StoreError::Policy("invalid_invite_capabilities".into()));
        }
        let mut tables = self.tables.write();
        tables
            .sessions
            .get(&input.session_id)
            .filter(|session| {
                session.org_id == input.org_id && session.workspace_id == input.workspace_id
            })
            .ok_or(StoreError::NotFound)?;
        let invite = ChatSessionInvite {
            id: input.id.clone(),
            session_id: input.session_id,
            role: input.role,
            approver: input.approver,
            guest: input.guest,
            target_user_id: input.target_user_id,
            status: "pending".into(),
            created_by_user_id: input.created_by_user_id,
            accepted_by_user_id: None,
            accepted_at: None,
            expires_at: input.expires_at,
            created_at: input.now,
        };
        tables
            .invites
            .insert(input.id, (invite.clone(), input.org_id, input.token_hash));
        Ok(invite)
    }

    async fn list_invites(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<ChatSessionInvite>, StoreError> {
        let mut tables = self.tables.write();
        let mut invites = Vec::new();
        for (invite, stored_org, _) in tables.invites.values_mut() {
            if stored_org == org_id && invite.session_id == session_id {
                if invite.status == "pending" && invite.expires_at <= now {
                    invite.status = "expired".into();
                }
                invites.push(invite.clone());
            }
        }
        invites.sort_by_key(|invite| std::cmp::Reverse(invite.created_at));
        Ok(invites)
    }

    async fn accept_invite(
        &self,
        org_id: &str,
        token_hash: &str,
        user_id: &str,
        now: i64,
    ) -> Result<(ChatSessionInvite, SessionMembership), StoreError> {
        let mut tables = self.tables.write();
        let invite_id = tables
            .invites
            .iter()
            .find(|(_, (_, stored_org, stored_hash))| {
                stored_org == org_id && stored_hash == token_hash
            })
            .map(|(id, _)| id.clone())
            .ok_or(StoreError::InvitationUnavailable)?;
        let (invite, _, _) = tables.invites.get(&invite_id).unwrap();
        if invite.status != "pending"
            || invite.expires_at <= now
            || invite
                .target_user_id
                .as_ref()
                .is_some_and(|target| target != user_id)
        {
            return Err(StoreError::InvitationUnavailable);
        }
        let invite_snapshot = invite.clone();
        let session = tables
            .sessions
            .get_mut(&invite_snapshot.session_id)
            .ok_or(StoreError::InvitationUnavailable)?;
        session.policy_revision += 1;
        session.updated_at = now;
        let membership = SessionMembership {
            session_id: invite_snapshot.session_id.clone(),
            user_id: user_id.to_owned(),
            role: invite_snapshot.role,
            approver: invite_snapshot.approver,
            guest: invite_snapshot.guest,
            display_name: None,
            created_at: now,
            updated_at: now,
        };
        tables.memberships.insert(
            (invite_snapshot.session_id.clone(), user_id.to_owned()),
            membership.clone(),
        );
        let (invite, _, _) = tables.invites.get_mut(&invite_id).unwrap();
        invite.status = "accepted".into();
        invite.accepted_by_user_id = Some(user_id.to_owned());
        invite.accepted_at = Some(now);
        Ok((invite.clone(), membership))
    }

    async fn revoke_invite(
        &self,
        org_id: &str,
        session_id: &str,
        invite_id: &str,
    ) -> Result<ChatSessionInvite, StoreError> {
        let mut tables = self.tables.write();
        let (invite, _, _) = tables
            .invites
            .get_mut(invite_id)
            .filter(|(invite, stored_org, _)| {
                stored_org == org_id && invite.session_id == session_id
            })
            .ok_or(StoreError::NotFound)?;
        if invite.status != "pending" {
            return Err(StoreError::InvitationUnavailable);
        }
        invite.status = "revoked".into();
        Ok(invite.clone())
    }

    async fn append_session_event(
        &self,
        input: NewSessionEvent,
    ) -> Result<SessionEvent, StoreError> {
        let mut tables = self.tables.write();
        tables
            .sessions
            .get(&input.session_id)
            .filter(|session| {
                session.org_id == input.org_id && session.workspace_id == input.workspace_id
            })
            .ok_or(StoreError::NotFound)?;
        let events = tables.events.entry(input.session_id.clone()).or_default();
        if let Some(existing) = events
            .iter()
            .find(|event| event.operation_id == input.operation_id)
        {
            return Ok(existing.clone());
        }
        let event = SessionEvent {
            id: input.id,
            session_id: input.session_id.clone(),
            sequence: events.last().map_or(1, |event| event.sequence + 1),
            kind: input.kind,
            actor_kind: input.actor_kind,
            actor_id: input.actor_id,
            actor_label: input.actor_label,
            payload: input.payload,
            created_at: input.now,
            operation_id: input.operation_id,
        };
        events.push(event.clone());
        Ok(event)
    }

    async fn list_session_events(
        &self,
        org_id: &str,
        session_id: &str,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<SessionEvent>, StoreError> {
        let tables = self.tables.read();
        if tables
            .sessions
            .get(session_id)
            .is_none_or(|session| session.org_id != org_id)
        {
            return Err(StoreError::NotFound);
        }
        Ok(tables
            .events
            .get(session_id)
            .into_iter()
            .flatten()
            .filter(|event| event.sequence > after_sequence)
            .take(limit.max(1) as usize)
            .cloned()
            .collect())
    }

    async fn redacted_message_ids(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<String>, StoreError> {
        let tables = self.tables.read();
        if tables
            .sessions
            .get(session_id)
            .is_none_or(|session| session.org_id != org_id)
        {
            return Err(StoreError::NotFound);
        }
        Ok(tables
            .events
            .get(session_id)
            .into_iter()
            .flatten()
            .filter(|event| event.kind == "message.redacted")
            .filter_map(|event| {
                event
                    .payload
                    .get("targetMessageId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .collect())
    }

    async fn get_message_event(
        &self,
        org_id: &str,
        session_id: &str,
        message_id: &str,
    ) -> Result<SessionEvent, StoreError> {
        let tables = self.tables.read();
        if tables
            .sessions
            .get(session_id)
            .is_none_or(|session| session.org_id != org_id)
        {
            return Err(StoreError::NotFound);
        }
        tables
            .events
            .get(session_id)
            .and_then(|events| {
                events.iter().find(|event| {
                    event.kind == "message.created"
                        && event
                            .payload
                            .get("messageId")
                            .and_then(|value| value.as_str())
                            == Some(message_id)
                })
            })
            .cloned()
            .ok_or(StoreError::NotFound)
    }

    async fn acquire_run_lease(&self, input: NewChatRunLease) -> Result<ChatRunLease, StoreError> {
        let mut tables = self.tables.write();
        if let Some((lease, _, _, _)) = tables
            .leases
            .values()
            .find(|(_, org, _, operation)| org == &input.org_id && operation == &input.operation_id)
        {
            return Ok(lease.clone());
        }
        if let Some((lease, _, _, _)) = tables.leases.values_mut().find(|(lease, _, _, _)| {
            lease.session_id == input.session_id
                && matches!(lease.status.as_str(), "active" | "paused")
        }) {
            if lease.heartbeat_expires_at > input.now {
                return Err(conflict(lease.clone()));
            }
            lease.status = "expired".into();
            lease.updated_at = input.now;
        }
        let lease = ChatRunLease {
            id: input.id.clone(),
            session_id: input.session_id,
            run_id: input.run_id,
            holder_user_id: input.holder_user_id,
            holder_device_id: input.holder_device_id,
            status: "active".into(),
            token_expires_at: input.token_expires_at,
            heartbeat_expires_at: input.heartbeat_expires_at,
            created_at: input.now,
            updated_at: input.now,
        };
        tables.leases.insert(
            input.id,
            (
                lease.clone(),
                input.org_id,
                input.token_hash,
                input.operation_id,
            ),
        );
        Ok(lease)
    }

    async fn heartbeat_run_lease(
        &self,
        org_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        holder_device_id: &str,
        token_hash: &str,
        heartbeat_expires_at: i64,
        now: i64,
    ) -> Result<ChatRunLease, StoreError> {
        let mut tables = self.tables.write();
        let (lease, stored_org, stored_token, _) = tables
            .leases
            .get_mut(lease_id)
            .ok_or(StoreError::NotFound)?;
        if stored_org != org_id
            || lease.holder_user_id != holder_user_id
            || lease.holder_device_id != holder_device_id
            || stored_token != token_hash
            || lease.status != "active"
            || lease.token_expires_at <= now
        {
            return Err(StoreError::NotFound);
        }
        lease.token_expires_at = heartbeat_expires_at;
        lease.heartbeat_expires_at = heartbeat_expires_at;
        lease.updated_at = now;
        Ok(lease.clone())
    }

    async fn release_run_lease(
        &self,
        org_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        now: i64,
        status: &str,
    ) -> Result<ChatRunLease, StoreError> {
        let mut tables = self.tables.write();
        let (lease, stored_org, _, _) = tables
            .leases
            .get_mut(lease_id)
            .ok_or(StoreError::NotFound)?;
        if stored_org != org_id || lease.holder_user_id != holder_user_id {
            return Err(StoreError::NotFound);
        }
        lease.status = status.to_owned();
        lease.updated_at = now;
        Ok(lease.clone())
    }

    async fn active_run_lease(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Option<ChatRunLease>, StoreError> {
        let mut tables = self.tables.write();
        let Some((lease, stored_org, _, _)) =
            tables.leases.values_mut().find(|(lease, org, _, _)| {
                org == org_id
                    && lease.session_id == session_id
                    && matches!(lease.status.as_str(), "active" | "paused")
            })
        else {
            return Ok(None);
        };
        if stored_org != org_id {
            return Ok(None);
        }
        if lease.heartbeat_expires_at <= now {
            lease.status = "expired".into();
            lease.updated_at = now;
            return Ok(None);
        }
        Ok(Some(lease.clone()))
    }

    async fn validate_run_token(
        &self,
        org_id: &str,
        session_id: &str,
        run_id: &str,
        token_hash: &str,
        now: i64,
    ) -> Result<ChatRunLease, StoreError> {
        let tables = self.tables.read();
        tables
            .leases
            .values()
            .find(|(lease, stored_org, stored_token, _)| {
                stored_org == org_id
                    && stored_token == token_hash
                    && lease.session_id == session_id
                    && lease.run_id == run_id
                    && lease.status == "active"
                    && lease.token_expires_at > now
                    && lease.heartbeat_expires_at > now
            })
            .map(|(lease, _, _, _)| lease.clone())
            .ok_or(StoreError::NotFound)
    }

    async fn enqueue_run_input(
        &self,
        input: NewChatRunQueueItem,
    ) -> Result<ChatRunQueueItem, StoreError> {
        let mut tables = self.tables.write();
        if let Some((item, _, _)) = tables.queue.values().find(|(_, stored_org, operation)| {
            stored_org == &input.org_id && operation == &input.operation_id
        }) {
            return Ok(item.clone());
        }
        let position = tables
            .queue
            .values()
            .filter(|(item, org, _)| org == &input.org_id && item.session_id == input.session_id)
            .map(|(item, _, _)| item.position)
            .max()
            .unwrap_or(0)
            + 1;
        let item = ChatRunQueueItem {
            id: input.id.clone(),
            session_id: input.session_id,
            requested_by_user_id: input.requested_by_user_id,
            payload: input.payload,
            status: "queued".into(),
            position,
            created_at: input.now,
        };
        tables
            .queue
            .insert(input.id, (item.clone(), input.org_id, input.operation_id));
        Ok(item)
    }

    async fn list_run_queue(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<ChatRunQueueItem>, StoreError> {
        let mut items: Vec<_> = self
            .tables
            .read()
            .queue
            .values()
            .filter(|(item, stored_org, _)| {
                stored_org == org_id && item.session_id == session_id && item.status == "queued"
            })
            .map(|(item, _, _)| item.clone())
            .collect();
        items.sort_by_key(|item| item.position);
        Ok(items)
    }

    async fn cancel_run_queue_item(
        &self,
        org_id: &str,
        session_id: &str,
        item_id: &str,
        actor_user_id: &str,
        elevated: bool,
    ) -> Result<ChatRunQueueItem, StoreError> {
        let mut tables = self.tables.write();
        let (item, stored_org, _) = tables.queue.get_mut(item_id).ok_or(StoreError::NotFound)?;
        if stored_org != org_id
            || item.session_id != session_id
            || item.status != "queued"
            || (!elevated && item.requested_by_user_id != actor_user_id)
        {
            return Err(StoreError::NotFound);
        }
        item.status = "cancelled".into();
        Ok(item.clone())
    }

    async fn create_break_glass_grant(
        &self,
        input: NewBreakGlassGrant,
    ) -> Result<BreakGlassGrant, StoreError> {
        let mut tables = self.tables.write();
        if let Some((grant, _, _)) = tables
            .break_glass
            .values()
            .find(|(_, org, operation)| org == &input.org_id && operation == &input.operation_id)
        {
            return Ok(grant.clone());
        }
        if !tables
            .sessions
            .get(&input.session_id)
            .is_some_and(|session| {
                session.org_id == input.org_id && session.workspace_id == input.workspace_id
            })
        {
            return Err(StoreError::NotFound);
        }
        let grant = BreakGlassGrant {
            id: input.id.clone(),
            org_id: input.org_id.clone(),
            session_id: input.session_id,
            granted_to_user_id: input.granted_to_user_id,
            reason: input.reason,
            expires_at: input.expires_at,
            revoked_at: None,
            created_at: input.created_at,
        };
        tables
            .break_glass
            .insert(input.id, (grant.clone(), input.org_id, input.operation_id));
        Ok(grant)
    }

    async fn valid_break_glass_grant(
        &self,
        org_id: &str,
        session_id: &str,
        grant_id: &str,
        user_id: &str,
        now: i64,
    ) -> Result<BreakGlassGrant, StoreError> {
        self.tables
            .read()
            .break_glass
            .get(grant_id)
            .filter(|(grant, stored_org, _)| {
                stored_org == org_id
                    && grant.session_id == session_id
                    && grant.granted_to_user_id == user_id
                    && grant.revoked_at.is_none()
                    && grant.expires_at > now
            })
            .map(|(grant, _, _)| grant.clone())
            .ok_or(StoreError::InvitationUnavailable)
    }

    async fn create_approval(
        &self,
        input: NewChatApprovalRequest,
    ) -> Result<ChatApprovalRequest, StoreError> {
        if !matches!(input.risk.as_str(), "ordinary" | "high") {
            return Err(StoreError::Policy("invalid_approval_risk".into()));
        }
        let mut tables = self.tables.write();
        if let Some((approval, _, _)) = tables
            .approvals
            .values()
            .find(|(_, org, op)| org == &input.org_id && op == &input.operation_id)
        {
            return Ok(approval.clone());
        }
        let holds_run = tables.leases.values().any(|(lease, org, _, _)| {
            org == &input.org_id
                && lease.session_id == input.session_id
                && lease.run_id == input.run_id
                && lease.holder_user_id == input.requested_by_user_id
                && lease.status == "active"
                && lease.heartbeat_expires_at > input.now
        });
        if !holds_run {
            return Err(StoreError::Policy("active_run_lease_required".into()));
        }
        let approval = ChatApprovalRequest {
            id: input.id.clone(),
            session_id: input.session_id,
            run_id: input.run_id,
            action: input.action,
            risk: input.risk,
            requested_by_user_id: input.requested_by_user_id,
            status: "pending".into(),
            resolved_by_user_id: None,
            resolved_at: None,
            expires_at: input.expires_at,
            created_at: input.now,
            revision: 1,
        };
        tables.approvals.insert(
            input.id,
            (approval.clone(), input.org_id, input.operation_id),
        );
        Ok(approval)
    }

    async fn list_approvals(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<ChatApprovalRequest>, StoreError> {
        let mut tables = self.tables.write();
        let mut approvals = Vec::new();
        for (approval, stored_org, _) in tables.approvals.values_mut() {
            if stored_org == org_id && approval.session_id == session_id {
                if approval.status == "pending" && approval.expires_at <= now {
                    approval.status = "expired".into();
                    approval.revision += 1;
                }
                approvals.push(approval.clone());
            }
        }
        approvals.sort_by_key(|approval| std::cmp::Reverse(approval.created_at));
        Ok(approvals)
    }

    async fn get_approval(
        &self,
        org_id: &str,
        session_id: &str,
        approval_id: &str,
    ) -> Result<ChatApprovalRequest, StoreError> {
        self.tables
            .read()
            .approvals
            .get(approval_id)
            .filter(|(approval, stored_org, _)| {
                stored_org == org_id && approval.session_id == session_id
            })
            .map(|(approval, _, _)| approval.clone())
            .ok_or(StoreError::NotFound)
    }

    async fn resolve_approval(
        &self,
        org_id: &str,
        session_id: &str,
        approval_id: &str,
        resolver_user_id: &str,
        status: &str,
        base_revision: i64,
        now: i64,
    ) -> Result<ChatApprovalRequest, StoreError> {
        if !matches!(status, "approved" | "denied") {
            return Err(StoreError::Policy("invalid_approval_resolution".into()));
        }
        let mut tables = self.tables.write();
        let (approval, _, _) = tables
            .approvals
            .get_mut(approval_id)
            .filter(|(approval, stored_org, _)| {
                stored_org == org_id && approval.session_id == session_id
            })
            .ok_or(StoreError::NotFound)?;
        if approval.status == "pending" && approval.expires_at <= now {
            approval.status = "expired".into();
            approval.revision += 1;
            return Err(StoreError::InvitationUnavailable);
        }
        if approval.status != "pending" || approval.revision != base_revision {
            return Err(conflict(approval.clone()));
        }
        approval.status = status.into();
        approval.resolved_by_user_id = Some(resolver_user_id.into());
        approval.resolved_at = Some(now);
        approval.revision += 1;
        Ok(approval.clone())
    }

    async fn create_attachment(
        &self,
        input: NewChatAttachment,
    ) -> Result<ChatAttachment, StoreError> {
        if !(0..=52_428_800).contains(&input.byte_length) {
            return Err(StoreError::Policy("attachment_size_invalid".into()));
        }
        let mut tables = self.tables.write();
        tables
            .sessions
            .get(&input.session_id)
            .filter(|session| {
                session.org_id == input.org_id && session.workspace_id == input.workspace_id
            })
            .ok_or(StoreError::NotFound)?;
        let attachment = ChatAttachment {
            id: input.id.clone(),
            session_id: input.session_id,
            event_id: None,
            object_key: input.object_key,
            file_name: input.file_name,
            media_type: input.media_type,
            byte_length: input.byte_length,
            sha256: input.sha256,
            status: "pending".into(),
            created_by_user_id: input.created_by_user_id,
            created_at: input.now,
            updated_at: input.now,
        };
        tables
            .attachments
            .insert(input.id, (attachment.clone(), input.org_id));
        Ok(attachment)
    }

    async fn get_attachment(
        &self,
        org_id: &str,
        session_id: &str,
        attachment_id: &str,
    ) -> Result<ChatAttachment, StoreError> {
        self.tables
            .read()
            .attachments
            .get(attachment_id)
            .filter(|(attachment, stored_org)| {
                stored_org == org_id && attachment.session_id == session_id
            })
            .map(|(attachment, _)| attachment.clone())
            .ok_or(StoreError::NotFound)
    }

    async fn list_session_attachments(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<ChatAttachment>, StoreError> {
        Ok(self
            .tables
            .read()
            .attachments
            .values()
            .filter(|(attachment, stored_org)| {
                stored_org == org_id && attachment.session_id == session_id
            })
            .map(|(attachment, _)| attachment.clone())
            .collect())
    }

    async fn commit_attachment(
        &self,
        org_id: &str,
        session_id: &str,
        attachment_id: &str,
        event_id: Option<&str>,
        now: i64,
    ) -> Result<ChatAttachment, StoreError> {
        let mut tables = self.tables.write();
        let (attachment, _) = tables
            .attachments
            .get_mut(attachment_id)
            .filter(|(attachment, stored_org)| {
                stored_org == org_id && attachment.session_id == session_id
            })
            .ok_or(StoreError::NotFound)?;
        if attachment.status != "pending" {
            return Err(conflict(attachment.clone()));
        }
        attachment.status = "available".into();
        attachment.event_id = event_id.map(str::to_owned);
        attachment.updated_at = now;
        Ok(attachment.clone())
    }

    async fn delete_attachment(
        &self,
        org_id: &str,
        session_id: &str,
        attachment_id: &str,
        now: i64,
    ) -> Result<ChatAttachment, StoreError> {
        let mut tables = self.tables.write();
        let (attachment, _) = tables
            .attachments
            .get_mut(attachment_id)
            .filter(|(attachment, stored_org)| {
                stored_org == org_id && attachment.session_id == session_id
            })
            .ok_or(StoreError::NotFound)?;
        attachment.status = "deleted".into();
        attachment.updated_at = now;
        Ok(attachment.clone())
    }
}

fn session_from_row(row: &Row) -> Result<SharedSession, StoreError> {
    Ok(SharedSession {
        id: row.get("id"),
        org_id: row.get("org_id"),
        workspace_id: row.get("workspace_id"),
        title: row.get("title"),
        status: match row.get::<_, String>("status").as_str() {
            "importing" => SessionStatus::Importing,
            "active" => SessionStatus::Active,
            "archived" => SessionStatus::Archived,
            "deleting" => SessionStatus::Deleting,
            other => {
                return Err(StoreError::Corrupt(format!(
                    "unknown chat session status {other}"
                )))
            }
        },
        created_by_user_id: row.get("created_by_user_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        revision: row.get("revision"),
        policy_revision: row.get("policy_revision"),
    })
}

fn member_from_row(row: &Row) -> Result<SessionMembership, StoreError> {
    let role_text: String = row.get("role");
    Ok(SessionMembership {
        session_id: row.get("session_id"),
        user_id: row.get("user_id"),
        role: SessionRole::parse(&role_text)
            .ok_or_else(|| StoreError::Corrupt(format!("unknown session role {role_text}")))?,
        approver: row.get("approver"),
        guest: row.get("guest"),
        display_name: row.try_get("display_name").ok(),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn event_from_row(row: &Row) -> SessionEvent {
    SessionEvent {
        id: row.get("id"),
        session_id: row.get("session_id"),
        sequence: row.get("sequence"),
        kind: row.get("kind"),
        actor_kind: row.get("actor_kind"),
        actor_id: row.get("actor_id"),
        actor_label: row.get("actor_label"),
        payload: row.get("payload"),
        created_at: row.get("created_at"),
        operation_id: row.get("operation_id"),
    }
}

fn lease_from_row(row: &Row) -> ChatRunLease {
    ChatRunLease {
        id: row.get("id"),
        session_id: row.get("session_id"),
        run_id: row.get("run_id"),
        holder_user_id: row.get("holder_user_id"),
        holder_device_id: row.get("holder_device_id"),
        status: row.get("status"),
        token_expires_at: row.get("token_expires_at"),
        heartbeat_expires_at: row.get("heartbeat_expires_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

const SESSION_COLUMNS: &str = "id, org_id, workspace_id, title, status, created_by_user_id, created_at, updated_at, revision, policy_revision";
const MEMBER_COLUMNS: &str = "m.session_id, m.user_id, m.role, m.approver, m.guest, u.display_name, m.created_at, m.updated_at";
const EVENT_COLUMNS: &str = "id, session_id, sequence, kind, actor_kind, actor_id, actor_label, payload, created_at, operation_id";
const LEASE_COLUMNS: &str = "id, session_id, run_id, holder_user_id, holder_device_id, status, token_expires_at, heartbeat_expires_at, created_at, updated_at";
const INVITE_COLUMNS: &str = "id, session_id, role, approver, guest, target_user_id, status, created_by_user_id, accepted_by_user_id, accepted_at, expires_at, created_at";
const APPROVAL_COLUMNS: &str = "id, session_id, run_id, action, risk, requested_by_user_id, status, resolved_by_user_id, resolved_at, expires_at, created_at, revision";
const ATTACHMENT_COLUMNS: &str = "id, session_id, event_id, object_key, file_name, media_type, byte_length, sha256, status, created_by_user_id, created_at, updated_at";
const QUEUE_COLUMNS: &str =
    "id, session_id, requested_by_user_id, payload, status, position, created_at";
const BREAK_GLASS_COLUMNS: &str =
    "id, org_id, session_id, granted_to_user_id, reason, expires_at, revoked_at, created_at";

fn break_glass_from_row(row: &Row) -> BreakGlassGrant {
    BreakGlassGrant {
        id: row.get("id"),
        org_id: row.get("org_id"),
        session_id: row.get("session_id"),
        granted_to_user_id: row.get("granted_to_user_id"),
        reason: row.get("reason"),
        expires_at: row.get("expires_at"),
        revoked_at: row.get("revoked_at"),
        created_at: row.get("created_at"),
    }
}

fn invite_from_row(row: &Row) -> Result<ChatSessionInvite, StoreError> {
    Ok(ChatSessionInvite {
        id: row.get("id"),
        session_id: row.get("session_id"),
        role: SessionRole::parse(row.get::<_, String>("role").as_str())
            .ok_or_else(|| StoreError::Corrupt("invalid chat invite role".into()))?,
        approver: row.get("approver"),
        guest: row.get("guest"),
        target_user_id: row.get("target_user_id"),
        status: row.get("status"),
        created_by_user_id: row.get("created_by_user_id"),
        accepted_by_user_id: row.get("accepted_by_user_id"),
        accepted_at: row.get("accepted_at"),
        expires_at: row.get("expires_at"),
        created_at: row.get("created_at"),
    })
}

fn approval_from_row(row: &Row) -> ChatApprovalRequest {
    ChatApprovalRequest {
        id: row.get("id"),
        session_id: row.get("session_id"),
        run_id: row.get("run_id"),
        action: row.get("action"),
        risk: row.get("risk"),
        requested_by_user_id: row.get("requested_by_user_id"),
        status: row.get("status"),
        resolved_by_user_id: row.get("resolved_by_user_id"),
        resolved_at: row.get("resolved_at"),
        expires_at: row.get("expires_at"),
        created_at: row.get("created_at"),
        revision: row.get("revision"),
    }
}

fn attachment_from_row(row: &Row) -> ChatAttachment {
    ChatAttachment {
        id: row.get("id"),
        session_id: row.get("session_id"),
        event_id: row.get("event_id"),
        object_key: row.get("object_key"),
        file_name: row.get("file_name"),
        media_type: row.get("media_type"),
        byte_length: row.get("byte_length"),
        sha256: row.get("sha256"),
        status: row.get("status"),
        created_by_user_id: row.get("created_by_user_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn queue_from_row(row: &Row) -> ChatRunQueueItem {
    ChatRunQueueItem {
        id: row.get("id"),
        session_id: row.get("session_id"),
        requested_by_user_id: row.get("requested_by_user_id"),
        payload: row.get("payload"),
        status: row.get("status"),
        position: row.get("position"),
        created_at: row.get("created_at"),
    }
}

#[async_trait]
impl ChatStore for PgStore {
    async fn create_session(&self, input: NewSharedSession) -> Result<SharedSession, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        if let Some(row) = tx.query_opt(&format!("SELECT {SESSION_COLUMNS} FROM chat_sessions WHERE org_id = $1 AND created_operation_id = $2"), &[&input.org_id, &input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))? {
            return session_from_row(&row);
        }
        let row = tx.query_one(&format!("INSERT INTO chat_sessions (id, org_id, workspace_id, title, status, created_by_user_id, created_at, updated_at, created_operation_id, last_operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$8) RETURNING {SESSION_COLUMNS}"), &[&input.id,&input.org_id,&input.workspace_id,&input.title,&format!("{:?}", input.status).to_lowercase(),&input.created_by_user_id,&input.now,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.execute("INSERT INTO chat_session_memberships (org_id, workspace_id, session_id, user_id, role, approver, guest, created_at, updated_at) VALUES ($1,$2,$3,$4,'owner',true,false,$5,$5)", &[&input.org_id,&input.workspace_id,&input.id,&input.created_by_user_id,&input.now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        session_from_row(&row)
    }

    async fn delete_session_data(&self, org_id: &str, session_id: &str) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let deleted = tx
            .execute(
                "DELETE FROM chat_sessions WHERE org_id=$1 AND id=$2 AND status='deleting'",
                &[&org_id, &session_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        if deleted == 0 {
            return Err(StoreError::NotFound);
        }
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(())
    }

    async fn list_sessions(
        &self,
        org_id: &str,
        user_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Vec<SharedSession>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx.query(&format!("SELECT {} FROM chat_sessions s JOIN chat_session_memberships m ON m.session_id=s.id AND m.user_id=$2 WHERE s.org_id=$1 AND ($3::text IS NULL OR s.workspace_id=$3) ORDER BY s.updated_at DESC", SESSION_COLUMNS.replace("id", "s.id").replace("org_id", "s.org_id").replace("workspace_id", "s.workspace_id").replace("title", "s.title").replace("status", "s.status").replace("created_by_user_id", "s.created_by_user_id").replace("created_at", "s.created_at").replace("updated_at", "s.updated_at").replace("revision", "s.revision").replace("policy_revision", "s.policy_revision")), &[&org_id,&user_id,&workspace_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        rows.iter().map(session_from_row).collect()
    }

    async fn patch_session(
        &self,
        org_id: &str,
        session_id: &str,
        title: Option<&str>,
        status: Option<SessionStatus>,
        operation_id: &str,
        base_revision: i64,
        now: i64,
    ) -> Result<SharedSession, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let existing = tx
            .query_opt(
                &format!("SELECT {SESSION_COLUMNS}, last_operation_id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE"),
                &[&org_id, &session_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
            .ok_or(StoreError::NotFound)?;
        if existing.get::<_, String>("last_operation_id") == operation_id {
            return session_from_row(&existing);
        }
        let current = session_from_row(&existing)?;
        if current.revision != base_revision {
            return Err(conflict(current));
        }
        let status_text = status.map(|value| format!("{value:?}").to_lowercase());
        let row = tx
            .query_one(
                &format!("UPDATE chat_sessions SET title=COALESCE($3,title),status=COALESCE($4,status),updated_at=$5,revision=revision+1,policy_revision=policy_revision+1,last_operation_id=$6 WHERE org_id=$1 AND id=$2 RETURNING {SESSION_COLUMNS}"),
                &[&org_id, &session_id, &title, &status_text, &now, &operation_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        session_from_row(&row)
    }

    async fn visible_session(
        &self,
        org_id: &str,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<(SharedSession, SessionMembership)>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let Some(session_row) = tx
            .query_opt(
                &format!("SELECT {SESSION_COLUMNS} FROM chat_sessions WHERE org_id=$1 AND id=$2"),
                &[&org_id, &session_id],
            )
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?
        else {
            return Ok(None);
        };
        let Some(member_row) = tx.query_opt(&format!("SELECT {MEMBER_COLUMNS} FROM chat_session_memberships m LEFT JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.session_id=$2 AND m.user_id=$3"), &[&org_id,&session_id,&user_id]).await.map_err(|e| StoreError::Database(e.to_string()))? else { return Ok(None) };
        Ok(Some((
            session_from_row(&session_row)?,
            member_from_row(&member_row)?,
        )))
    }

    async fn admin_session(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<SharedSession, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                &format!("SELECT {SESSION_COLUMNS} FROM chat_sessions WHERE org_id=$1 AND id=$2"),
                &[&org_id, &session_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
            .ok_or(StoreError::NotFound)?;
        session_from_row(&row)
    }

    async fn list_members(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<SessionMembership>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx.query(&format!("SELECT {MEMBER_COLUMNS} FROM chat_session_memberships m LEFT JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.session_id=$2 ORDER BY m.user_id"), &[&org_id,&session_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        rows.iter().map(member_from_row).collect()
    }

    async fn put_member(
        &self,
        org_id: &str,
        session_id: &str,
        workspace_id: &str,
        user_id: &str,
        role: SessionRole,
        approver: bool,
        guest: bool,
        now: i64,
    ) -> Result<SessionMembership, StoreError> {
        if guest && (matches!(role, SessionRole::Owner | SessionRole::Maintainer) || approver) {
            return Err(StoreError::Corrupt("guest capability ceiling".into()));
        }
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        tx.query_one(
            "SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE",
            &[&org_id, &session_id],
        )
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
        let previous = tx
            .query_opt(
                "SELECT role FROM chat_session_memberships WHERE org_id=$1 AND session_id=$2 AND user_id=$3 FOR UPDATE",
                &[&org_id, &session_id, &user_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        if previous
            .as_ref()
            .is_some_and(|row| row.get::<_, String>(0) == "owner")
            && role != SessionRole::Owner
        {
            let owners: i64 = tx
                .query_one(
                    "SELECT count(*) FROM chat_session_memberships WHERE org_id=$1 AND session_id=$2 AND role='owner'",
                    &[&org_id, &session_id],
                )
                .await
                .map_err(|error| StoreError::Database(error.to_string()))?
                .get(0);
            if owners <= 1 {
                return Err(StoreError::Policy("last owner cannot be demoted".into()));
            }
        }
        tx.execute("INSERT INTO chat_session_memberships (org_id,workspace_id,session_id,user_id,role,approver,guest,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (session_id,user_id) DO UPDATE SET role=EXCLUDED.role,approver=EXCLUDED.approver,guest=EXCLUDED.guest,updated_at=EXCLUDED.updated_at", &[&org_id,&workspace_id,&session_id,&user_id,&role.as_str(),&(approver || matches!(role,SessionRole::Owner|SessionRole::Maintainer)),&guest,&now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.execute("UPDATE chat_sessions SET policy_revision=policy_revision+1,updated_at=$3 WHERE org_id=$1 AND id=$2", &[&org_id,&session_id,&now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        let row=tx.query_one(&format!("SELECT {MEMBER_COLUMNS} FROM chat_session_memberships m LEFT JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.session_id=$2 AND m.user_id=$3"), &[&org_id,&session_id,&user_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        member_from_row(&row)
    }

    async fn remove_member(
        &self,
        org_id: &str,
        session_id: &str,
        user_id: &str,
        now: i64,
    ) -> Result<(), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        tx.query_one(
            "SELECT id FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE",
            &[&org_id, &session_id],
        )
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
        let row=tx.query_opt("SELECT role FROM chat_session_memberships WHERE org_id=$1 AND session_id=$2 AND user_id=$3 FOR UPDATE", &[&org_id,&session_id,&user_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        if row.get::<_, String>(0) == "owner" {
            let owners:i64=tx.query_one("SELECT count(*) FROM chat_session_memberships WHERE org_id=$1 AND session_id=$2 AND role='owner'", &[&org_id,&session_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.get(0);
            if owners <= 1 {
                return Err(conflict(serde_json::json!({"reason":"last_owner"})));
            }
        }
        tx.execute(
            "DELETE FROM chat_session_memberships WHERE org_id=$1 AND session_id=$2 AND user_id=$3",
            &[&org_id, &session_id, &user_id],
        )
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
        tx.execute("UPDATE chat_sessions SET policy_revision=policy_revision+1,updated_at=$3 WHERE org_id=$1 AND id=$2", &[&org_id,&session_id,&now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.execute("UPDATE chat_run_leases SET status='failed',updated_at=$4 WHERE org_id=$1 AND session_id=$2 AND holder_user_id=$3 AND status IN ('active','paused')", &[&org_id,&session_id,&user_id,&now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.execute("UPDATE chat_run_queue SET status='cancelled' WHERE org_id=$1 AND session_id=$2 AND requested_by_user_id=$3 AND status='queued'", &[&org_id,&session_id,&user_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(())
    }

    async fn create_invite(
        &self,
        input: NewChatSessionInvite,
    ) -> Result<ChatSessionInvite, StoreError> {
        if matches!(input.role, SessionRole::Owner)
            || (input.guest && (matches!(input.role, SessionRole::Maintainer) || input.approver))
        {
            return Err(StoreError::Policy("invalid_invite_capabilities".into()));
        }
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        let row = tx
            .query_one(
                &format!("INSERT INTO chat_session_invites (id,org_id,workspace_id,session_id,token_hash,target_user_id,role,approver,guest,status,created_by_user_id,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12) RETURNING {INVITE_COLUMNS}"),
                &[&input.id,&input.org_id,&input.workspace_id,&input.session_id,&input.token_hash,&input.target_user_id,&input.role.as_str(),&input.approver,&input.guest,&input.created_by_user_id,&input.expires_at,&input.now],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        invite_from_row(&row)
    }

    async fn list_invites(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<ChatSessionInvite>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        tx.execute("UPDATE chat_session_invites SET status='expired' WHERE org_id=$1 AND session_id=$2 AND status='pending' AND expires_at<=$3", &[&org_id,&session_id,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        let rows = tx.query(&format!("SELECT {INVITE_COLUMNS} FROM chat_session_invites WHERE org_id=$1 AND session_id=$2 ORDER BY created_at DESC"), &[&org_id,&session_id]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        rows.iter().map(invite_from_row).collect()
    }

    async fn accept_invite(
        &self,
        org_id: &str,
        token_hash: &str,
        user_id: &str,
        now: i64,
    ) -> Result<(ChatSessionInvite, SessionMembership), StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx.query_opt(&format!("SELECT {INVITE_COLUMNS}, workspace_id FROM chat_session_invites WHERE org_id=$1 AND token_hash=$2 FOR UPDATE"), &[&org_id,&token_hash]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::InvitationUnavailable)?;
        let current = invite_from_row(&row)?;
        if current.status != "pending"
            || current.expires_at <= now
            || current
                .target_user_id
                .as_ref()
                .is_some_and(|target| target != user_id)
        {
            return Err(StoreError::InvitationUnavailable);
        }
        let workspace_id: String = row.get("workspace_id");
        tx.execute("INSERT INTO chat_session_memberships (org_id,workspace_id,session_id,user_id,role,approver,guest,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (session_id,user_id) DO UPDATE SET role=EXCLUDED.role,approver=EXCLUDED.approver,guest=EXCLUDED.guest,updated_at=EXCLUDED.updated_at", &[&org_id,&workspace_id,&current.session_id,&user_id,&current.role.as_str(),&current.approver,&current.guest,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        let invite_row = tx.query_one(&format!("UPDATE chat_session_invites SET status='accepted',accepted_by_user_id=$3,accepted_at=$4 WHERE org_id=$1 AND id=$2 RETURNING {INVITE_COLUMNS}"), &[&org_id,&current.id,&user_id,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.execute("UPDATE chat_sessions SET policy_revision=policy_revision+1,updated_at=$3 WHERE org_id=$1 AND id=$2", &[&org_id,&current.session_id,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        let member_row = tx.query_one(&format!("SELECT {MEMBER_COLUMNS} FROM chat_session_memberships m LEFT JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.session_id=$2 AND m.user_id=$3"), &[&org_id,&current.session_id,&user_id]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok((invite_from_row(&invite_row)?, member_from_row(&member_row)?))
    }

    async fn revoke_invite(
        &self,
        org_id: &str,
        session_id: &str,
        invite_id: &str,
    ) -> Result<ChatSessionInvite, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx.query_opt(&format!("UPDATE chat_session_invites SET status='revoked' WHERE org_id=$1 AND session_id=$2 AND id=$3 AND status='pending' RETURNING {INVITE_COLUMNS}"), &[&org_id,&session_id,&invite_id]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::InvitationUnavailable)?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        invite_from_row(&row)
    }

    async fn append_session_event(
        &self,
        input: NewSessionEvent,
    ) -> Result<SessionEvent, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        if let Some(row)=tx.query_opt(&format!("SELECT {EVENT_COLUMNS} FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))? { return Ok(event_from_row(&row)); }
        let sequence:i64=tx.query_one("UPDATE chat_sessions SET next_sequence=next_sequence+1,updated_at=$3 WHERE org_id=$1 AND id=$2 AND workspace_id=$4 RETURNING next_sequence-1", &[&input.org_id,&input.session_id,&input.now,&input.workspace_id]).await.map_err(|e| StoreError::Database(e.to_string()))?.get(0);
        let row=tx.query_one(&format!("INSERT INTO chat_session_events (id,org_id,workspace_id,session_id,sequence,kind,actor_kind,actor_id,actor_label,payload,created_at,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING {EVENT_COLUMNS}"), &[&input.id,&input.org_id,&input.workspace_id,&input.session_id,&sequence,&input.kind,&input.actor_kind,&input.actor_id,&input.actor_label,&input.payload,&input.now,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(event_from_row(&row))
    }

    async fn list_session_events(
        &self,
        org_id: &str,
        session_id: &str,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<SessionEvent>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows=tx.query(&format!("SELECT {EVENT_COLUMNS} FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4"), &[&org_id,&session_id,&after_sequence,&limit.clamp(1,500)]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(rows.iter().map(event_from_row).collect())
    }

    async fn redacted_message_ids(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<String>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                "SELECT DISTINCT payload->>'targetMessageId' AS message_id FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND kind='message.redacted' AND payload ? 'targetMessageId'",
                &[&org_id, &session_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(rows.iter().map(|row| row.get("message_id")).collect())
    }

    async fn get_message_event(
        &self,
        org_id: &str,
        session_id: &str,
        message_id: &str,
    ) -> Result<SessionEvent, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                &format!("SELECT {EVENT_COLUMNS} FROM chat_session_events WHERE org_id=$1 AND session_id=$2 AND kind='message.created' AND payload->>'messageId'=$3 ORDER BY sequence LIMIT 1"),
                &[&org_id, &session_id, &message_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
            .ok_or(StoreError::NotFound)?;
        Ok(event_from_row(&row))
    }

    async fn acquire_run_lease(&self, input: NewChatRunLease) -> Result<ChatRunLease, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        if let Some(row)=tx.query_opt(&format!("SELECT {LEASE_COLUMNS} FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))? { return Ok(lease_from_row(&row)); }
        tx.execute("UPDATE chat_run_leases SET status='expired',updated_at=$3 WHERE org_id=$1 AND session_id=$2 AND status IN ('active','paused') AND heartbeat_expires_at<=$3", &[&input.org_id,&input.session_id,&input.now]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        if let Some(row)=tx.query_opt(&format!("SELECT {LEASE_COLUMNS} FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND status IN ('active','paused')"), &[&input.org_id,&input.session_id]).await.map_err(|e| StoreError::Database(e.to_string()))? { return Err(conflict(lease_from_row(&row))); }
        let inserted=tx.query_opt(&format!("INSERT INTO chat_run_leases (id,org_id,workspace_id,session_id,run_id,holder_user_id,holder_device_id,status,token_hash,token_expires_at,heartbeat_expires_at,created_at,updated_at,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$11,$12) ON CONFLICT DO NOTHING RETURNING {LEASE_COLUMNS}"), &[&input.id,&input.org_id,&input.workspace_id,&input.session_id,&input.run_id,&input.holder_user_id,&input.holder_device_id,&input.token_hash,&input.token_expires_at,&input.heartbeat_expires_at,&input.now,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))?;
        let row = if let Some(row) = inserted {
            row
        } else if let Some(row) = tx.query_opt(&format!("SELECT {LEASE_COLUMNS} FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|e| StoreError::Database(e.to_string()))? {
            row
        } else if let Some(row) = tx.query_opt(&format!("SELECT {LEASE_COLUMNS} FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND status IN ('active','paused')"), &[&input.org_id,&input.session_id]).await.map_err(|e| StoreError::Database(e.to_string()))? {
            return Err(conflict(lease_from_row(&row)));
        } else {
            return Err(StoreError::Conflict(serde_json::json!({"reason":"lease_conflict"})));
        };
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(lease_from_row(&row))
    }

    async fn heartbeat_run_lease(
        &self,
        org_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        holder_device_id: &str,
        token_hash: &str,
        heartbeat_expires_at: i64,
        now: i64,
    ) -> Result<ChatRunLease, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row=tx.query_opt(&format!("UPDATE chat_run_leases SET token_expires_at=$6,heartbeat_expires_at=$6,updated_at=$7 WHERE org_id=$1 AND id=$2 AND holder_user_id=$3 AND holder_device_id=$4 AND token_hash=$5 AND status='active' AND token_expires_at>$7 RETURNING {LEASE_COLUMNS}"), &[&org_id,&lease_id,&holder_user_id,&holder_device_id,&token_hash,&heartbeat_expires_at,&now]).await.map_err(|e|StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(lease_from_row(&row))
    }
    async fn release_run_lease(
        &self,
        org_id: &str,
        lease_id: &str,
        holder_user_id: &str,
        now: i64,
        status: &str,
    ) -> Result<ChatRunLease, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row=tx.query_opt(&format!("UPDATE chat_run_leases SET status=$4,updated_at=$5 WHERE org_id=$1 AND id=$2 AND holder_user_id=$3 RETURNING {LEASE_COLUMNS}"), &[&org_id,&lease_id,&holder_user_id,&status,&now]).await.map_err(|e|StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        tx.commit()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        Ok(lease_from_row(&row))
    }

    async fn active_run_lease(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Option<ChatRunLease>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        tx.execute("UPDATE chat_run_leases SET status='expired',updated_at=$3 WHERE org_id=$1 AND session_id=$2 AND status IN ('active','paused') AND heartbeat_expires_at<=$3", &[&org_id,&session_id,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        let row = tx.query_opt(&format!("SELECT {LEASE_COLUMNS} FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND status IN ('active','paused')"), &[&org_id,&session_id]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(row.map(|row| lease_from_row(&row)))
    }

    async fn validate_run_token(
        &self,
        org_id: &str,
        session_id: &str,
        run_id: &str,
        token_hash: &str,
        now: i64,
    ) -> Result<ChatRunLease, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx.query_opt(&format!("SELECT {LEASE_COLUMNS} FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND run_id=$3 AND token_hash=$4 AND status='active' AND token_expires_at>$5 AND heartbeat_expires_at>$5"), &[&org_id,&session_id,&run_id,&token_hash,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::NotFound)?;
        Ok(lease_from_row(&row))
    }

    async fn enqueue_run_input(
        &self,
        input: NewChatRunQueueItem,
    ) -> Result<ChatRunQueueItem, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        if let Some(row) = tx.query_opt(&format!("SELECT {QUEUE_COLUMNS} FROM chat_run_queue WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|error| StoreError::Database(error.to_string()))? {
            return Ok(queue_from_row(&row));
        }
        let position: i64 = tx.query_one("SELECT COALESCE(max(position),0)+1 FROM chat_run_queue WHERE org_id=$1 AND session_id=$2", &[&input.org_id,&input.session_id]).await.map_err(|error| StoreError::Database(error.to_string()))?.get(0);
        let row = tx.query_one(&format!("INSERT INTO chat_run_queue (id,org_id,workspace_id,session_id,requested_by_user_id,payload,status,position,created_at,operation_id) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9) RETURNING {QUEUE_COLUMNS}"), &[&input.id,&input.org_id,&input.workspace_id,&input.session_id,&input.requested_by_user_id,&input.payload,&position,&input.now,&input.operation_id]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(queue_from_row(&row))
    }

    async fn list_run_queue(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<ChatRunQueueItem>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx.query(&format!("SELECT {QUEUE_COLUMNS} FROM chat_run_queue WHERE org_id=$1 AND session_id=$2 AND status='queued' ORDER BY position"), &[&org_id,&session_id]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(rows.iter().map(queue_from_row).collect())
    }

    async fn cancel_run_queue_item(
        &self,
        org_id: &str,
        session_id: &str,
        item_id: &str,
        actor_user_id: &str,
        elevated: bool,
    ) -> Result<ChatRunQueueItem, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx.query_opt(&format!("UPDATE chat_run_queue SET status='cancelled' WHERE org_id=$1 AND session_id=$2 AND id=$3 AND status='queued' AND ($5 OR requested_by_user_id=$4) RETURNING {QUEUE_COLUMNS}"), &[&org_id,&session_id,&item_id,&actor_user_id,&elevated]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::NotFound)?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(queue_from_row(&row))
    }

    async fn create_break_glass_grant(
        &self,
        input: NewBreakGlassGrant,
    ) -> Result<BreakGlassGrant, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        if let Some(row) = tx
            .query_opt(
                &format!("SELECT {BREAK_GLASS_COLUMNS} FROM break_glass_grants WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"),
                &[&input.org_id, &input.session_id, &input.operation_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
        {
            return Ok(break_glass_from_row(&row));
        }
        let row = tx
            .query_one(
                &format!("INSERT INTO break_glass_grants (id,org_id,workspace_id,session_id,granted_to_user_id,reason,expires_at,created_at,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING {BREAK_GLASS_COLUMNS}"),
                &[&input.id, &input.org_id, &input.workspace_id, &input.session_id, &input.granted_to_user_id, &input.reason, &input.expires_at, &input.created_at, &input.operation_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(break_glass_from_row(&row))
    }

    async fn valid_break_glass_grant(
        &self,
        org_id: &str,
        session_id: &str,
        grant_id: &str,
        user_id: &str,
        now: i64,
    ) -> Result<BreakGlassGrant, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                &format!("SELECT {BREAK_GLASS_COLUMNS} FROM break_glass_grants WHERE org_id=$1 AND session_id=$2 AND id=$3 AND granted_to_user_id=$4 AND revoked_at IS NULL AND expires_at>$5"),
                &[&org_id, &session_id, &grant_id, &user_id, &now],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?
            .ok_or(StoreError::InvitationUnavailable)?;
        Ok(break_glass_from_row(&row))
    }

    async fn create_approval(
        &self,
        input: NewChatApprovalRequest,
    ) -> Result<ChatApprovalRequest, StoreError> {
        if !matches!(input.risk.as_str(), "ordinary" | "high") {
            return Err(StoreError::Policy("invalid_approval_risk".into()));
        }
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        if let Some(row) = tx.query_opt(&format!("SELECT {APPROVAL_COLUMNS} FROM chat_approval_requests WHERE org_id=$1 AND session_id=$2 AND operation_id=$3"), &[&input.org_id,&input.session_id,&input.operation_id]).await.map_err(|error| StoreError::Database(error.to_string()))? {
            return Ok(approval_from_row(&row));
        }
        let holds_run = tx.query_opt("SELECT 1 FROM chat_run_leases WHERE org_id=$1 AND session_id=$2 AND run_id=$3 AND holder_user_id=$4 AND status='active' AND heartbeat_expires_at>$5 FOR UPDATE", &[&input.org_id,&input.session_id,&input.run_id,&input.requested_by_user_id,&input.now]).await.map_err(|error| StoreError::Database(error.to_string()))?.is_some();
        if !holds_run {
            return Err(StoreError::Policy("active_run_lease_required".into()));
        }
        let row = tx.query_one(&format!("INSERT INTO chat_approval_requests (id,org_id,workspace_id,session_id,run_id,action,risk,requested_by_user_id,status,expires_at,created_at,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11) RETURNING {APPROVAL_COLUMNS}"), &[&input.id,&input.org_id,&input.workspace_id,&input.session_id,&input.run_id,&input.action,&input.risk,&input.requested_by_user_id,&input.expires_at,&input.now,&input.operation_id]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(approval_from_row(&row))
    }

    async fn list_approvals(
        &self,
        org_id: &str,
        session_id: &str,
        now: i64,
    ) -> Result<Vec<ChatApprovalRequest>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        tx.execute("UPDATE chat_approval_requests SET status='expired',revision=revision+1 WHERE org_id=$1 AND session_id=$2 AND status='pending' AND expires_at<=$3", &[&org_id,&session_id,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        let rows = tx.query(&format!("SELECT {APPROVAL_COLUMNS} FROM chat_approval_requests WHERE org_id=$1 AND session_id=$2 ORDER BY created_at DESC"), &[&org_id,&session_id]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(rows.iter().map(approval_from_row).collect())
    }

    async fn get_approval(
        &self,
        org_id: &str,
        session_id: &str,
        approval_id: &str,
    ) -> Result<ChatApprovalRequest, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx.query_opt(&format!("SELECT {APPROVAL_COLUMNS} FROM chat_approval_requests WHERE org_id=$1 AND session_id=$2 AND id=$3"), &[&org_id,&session_id,&approval_id]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::NotFound)?;
        Ok(approval_from_row(&row))
    }

    async fn resolve_approval(
        &self,
        org_id: &str,
        session_id: &str,
        approval_id: &str,
        resolver_user_id: &str,
        status: &str,
        base_revision: i64,
        now: i64,
    ) -> Result<ChatApprovalRequest, StoreError> {
        if !matches!(status, "approved" | "denied") {
            return Err(StoreError::Policy("invalid_approval_resolution".into()));
        }
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let current_row = tx.query_opt(&format!("SELECT {APPROVAL_COLUMNS} FROM chat_approval_requests WHERE org_id=$1 AND session_id=$2 AND id=$3 FOR UPDATE"), &[&org_id,&session_id,&approval_id]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::NotFound)?;
        let current = approval_from_row(&current_row);
        if current.status == "pending" && current.expires_at <= now {
            tx.execute("UPDATE chat_approval_requests SET status='expired',revision=revision+1 WHERE org_id=$1 AND id=$2", &[&org_id,&approval_id]).await.map_err(|error| StoreError::Database(error.to_string()))?;
            tx.commit()
                .await
                .map_err(|error| StoreError::Database(error.to_string()))?;
            return Err(StoreError::InvitationUnavailable);
        }
        if current.status != "pending" || current.revision != base_revision {
            return Err(conflict(current));
        }
        let row = tx.query_one(&format!("UPDATE chat_approval_requests SET status=$4,resolved_by_user_id=$5,resolved_at=$6,revision=revision+1 WHERE org_id=$1 AND session_id=$2 AND id=$3 AND status='pending' AND revision=$7 RETURNING {APPROVAL_COLUMNS}"), &[&org_id,&session_id,&approval_id,&status,&resolver_user_id,&now,&base_revision]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(approval_from_row(&row))
    }

    async fn create_attachment(
        &self,
        input: NewChatAttachment,
    ) -> Result<ChatAttachment, StoreError> {
        if !(0..=52_428_800).contains(&input.byte_length) {
            return Err(StoreError::Policy("attachment_size_invalid".into()));
        }
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, &input.org_id).await?;
        let row = tx.query_one(&format!("INSERT INTO chat_attachments (id,org_id,workspace_id,session_id,object_key,file_name,media_type,byte_length,sha256,status,created_by_user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$11) RETURNING {ATTACHMENT_COLUMNS}"), &[&input.id,&input.org_id,&input.workspace_id,&input.session_id,&input.object_key,&input.file_name,&input.media_type,&input.byte_length,&input.sha256,&input.created_by_user_id,&input.now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(attachment_from_row(&row))
    }

    async fn get_attachment(
        &self,
        org_id: &str,
        session_id: &str,
        attachment_id: &str,
    ) -> Result<ChatAttachment, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx.query_opt(&format!("SELECT {ATTACHMENT_COLUMNS} FROM chat_attachments WHERE org_id=$1 AND session_id=$2 AND id=$3"), &[&org_id,&session_id,&attachment_id]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::NotFound)?;
        Ok(attachment_from_row(&row))
    }

    async fn list_session_attachments(
        &self,
        org_id: &str,
        session_id: &str,
    ) -> Result<Vec<ChatAttachment>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let rows = tx
            .query(
                &format!("SELECT {ATTACHMENT_COLUMNS} FROM chat_attachments WHERE org_id=$1 AND session_id=$2"),
                &[&org_id, &session_id],
            )
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(rows.iter().map(attachment_from_row).collect())
    }

    async fn commit_attachment(
        &self,
        org_id: &str,
        session_id: &str,
        attachment_id: &str,
        event_id: Option<&str>,
        now: i64,
    ) -> Result<ChatAttachment, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx.query_opt(&format!("UPDATE chat_attachments SET status='available',event_id=$4,updated_at=$5 WHERE org_id=$1 AND session_id=$2 AND id=$3 AND status='pending' RETURNING {ATTACHMENT_COLUMNS}"), &[&org_id,&session_id,&attachment_id,&event_id,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?;
        if let Some(row) = row {
            tx.commit()
                .await
                .map_err(|error| StoreError::Database(error.to_string()))?;
            return Ok(attachment_from_row(&row));
        }
        let current = tx.query_opt(&format!("SELECT {ATTACHMENT_COLUMNS} FROM chat_attachments WHERE org_id=$1 AND session_id=$2 AND id=$3"), &[&org_id,&session_id,&attachment_id]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::NotFound)?;
        Err(conflict(attachment_from_row(&current)))
    }

    async fn delete_attachment(
        &self,
        org_id: &str,
        session_id: &str,
        attachment_id: &str,
        now: i64,
    ) -> Result<ChatAttachment, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx.query_opt(&format!("UPDATE chat_attachments SET status='deleted',updated_at=$4 WHERE org_id=$1 AND session_id=$2 AND id=$3 AND status<>'deleted' RETURNING {ATTACHMENT_COLUMNS}"), &[&org_id,&session_id,&attachment_id,&now]).await.map_err(|error| StoreError::Database(error.to_string()))?.ok_or(StoreError::NotFound)?;
        tx.commit()
            .await
            .map_err(|error| StoreError::Database(error.to_string()))?;
        Ok(attachment_from_row(&row))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(operation_id: &str) -> NewSharedSession {
        NewSharedSession {
            id: "ses_1".into(),
            org_id: "org_1".into(),
            workspace_id: "ws_1".into(),
            title: "Shared".into(),
            status: SessionStatus::Active,
            created_by_user_id: "usr_owner".into(),
            now: 1,
            operation_id: operation_id.into(),
        }
    }

    #[tokio::test]
    async fn creation_is_idempotent_and_only_the_owner_can_discover_the_session() {
        let store = InMemoryChatStore::new();
        let first = store.create_session(session("op_1")).await.unwrap();
        let replay = store.create_session(session("op_1")).await.unwrap();
        assert_eq!(first, replay);
        assert_eq!(
            store
                .list_sessions("org_1", "usr_owner", None)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .list_sessions("org_1", "usr_outsider", None)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn session_patch_is_revision_checked_idempotent_and_advances_policy() {
        let store = InMemoryChatStore::new();
        store.create_session(session("op_1")).await.unwrap();
        let active = store
            .patch_session(
                "org_1",
                "ses_1",
                None,
                Some(SessionStatus::Archived),
                "op_patch",
                1,
                2,
            )
            .await
            .unwrap();
        assert_eq!(active.status, SessionStatus::Archived);
        assert_eq!(active.revision, 2);
        assert_eq!(active.policy_revision, 2);
        assert_eq!(
            store
                .patch_session(
                    "org_1",
                    "ses_1",
                    None,
                    Some(SessionStatus::Archived),
                    "op_patch",
                    1,
                    3,
                )
                .await
                .unwrap(),
            active
        );
        assert!(matches!(
            store
                .patch_session("org_1", "ses_1", Some("stale"), None, "op_stale", 1, 3)
                .await,
            Err(StoreError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn invitation_is_single_use_target_bound_and_guest_capped() {
        let store = InMemoryChatStore::new();
        store.create_session(session("op_1")).await.unwrap();
        assert!(matches!(
            store
                .create_invite(NewChatSessionInvite {
                    id: "inv_bad".into(),
                    org_id: "org_1".into(),
                    workspace_id: "ws_1".into(),
                    session_id: "ses_1".into(),
                    token_hash: "bad".into(),
                    target_user_id: None,
                    role: SessionRole::Maintainer,
                    approver: false,
                    guest: true,
                    created_by_user_id: "usr_owner".into(),
                    expires_at: 100,
                    now: 2,
                })
                .await,
            Err(StoreError::Policy(_))
        ));
        store
            .create_invite(NewChatSessionInvite {
                id: "inv_1".into(),
                org_id: "org_1".into(),
                workspace_id: "ws_1".into(),
                session_id: "ses_1".into(),
                token_hash: "hash".into(),
                target_user_id: Some("usr_invited".into()),
                role: SessionRole::Member,
                approver: false,
                guest: true,
                created_by_user_id: "usr_owner".into(),
                expires_at: 100,
                now: 2,
            })
            .await
            .unwrap();
        assert!(matches!(
            store.accept_invite("org_1", "hash", "usr_other", 3).await,
            Err(StoreError::InvitationUnavailable)
        ));
        let (_, membership) = store
            .accept_invite("org_1", "hash", "usr_invited", 3)
            .await
            .unwrap();
        assert!(membership.guest);
        assert!(matches!(
            store.accept_invite("org_1", "hash", "usr_invited", 4).await,
            Err(StoreError::InvitationUnavailable)
        ));
    }

    #[tokio::test]
    async fn approval_resolution_is_compare_and_consume() {
        let store = InMemoryChatStore::new();
        store.create_session(session("op_1")).await.unwrap();
        store
            .acquire_run_lease(NewChatRunLease {
                id: "lease_1".into(),
                org_id: "org_1".into(),
                workspace_id: "ws_1".into(),
                session_id: "ses_1".into(),
                run_id: "run_1".into(),
                holder_user_id: "usr_owner".into(),
                holder_device_id: "dev_1".into(),
                token_hash: "hash".into(),
                token_expires_at: 100,
                heartbeat_expires_at: 100,
                now: 2,
                operation_id: "lease_op".into(),
            })
            .await
            .unwrap();
        let approval = store
            .create_approval(NewChatApprovalRequest {
                id: "approval_1".into(),
                org_id: "org_1".into(),
                workspace_id: "ws_1".into(),
                session_id: "ses_1".into(),
                run_id: "run_1".into(),
                action: "filesystem.delete".into(),
                risk: "high".into(),
                requested_by_user_id: "usr_owner".into(),
                expires_at: 90,
                now: 3,
                operation_id: "approval_op".into(),
            })
            .await
            .unwrap();
        let resolved = store
            .resolve_approval(
                "org_1",
                "ses_1",
                "approval_1",
                "usr_owner",
                "approved",
                approval.revision,
                4,
            )
            .await
            .unwrap();
        assert_eq!(resolved.status, "approved");
        assert!(matches!(
            store
                .resolve_approval(
                    "org_1",
                    "ses_1",
                    "approval_1",
                    "usr_owner",
                    "approved",
                    approval.revision,
                    5,
                )
                .await,
            Err(StoreError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn attachment_metadata_requires_pending_before_commit() {
        let store = InMemoryChatStore::new();
        store.create_session(session("op_1")).await.unwrap();
        let attachment = store
            .create_attachment(NewChatAttachment {
                id: "attachment_1".into(),
                org_id: "org_1".into(),
                workspace_id: "ws_1".into(),
                session_id: "ses_1".into(),
                object_key: "org/ws/session/attachment".into(),
                file_name: "report.txt".into(),
                media_type: "text/plain".into(),
                byte_length: 5,
                sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
                created_by_user_id: "usr_owner".into(),
                now: 2,
            })
            .await
            .unwrap();
        assert_eq!(attachment.status, "pending");
        let available = store
            .commit_attachment("org_1", "ses_1", "attachment_1", None, 3)
            .await
            .unwrap();
        assert_eq!(available.status, "available");
        assert!(matches!(
            store
                .commit_attachment("org_1", "ses_1", "attachment_1", None, 4)
                .await,
            Err(StoreError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn run_token_is_bound_and_concurrent_input_is_ordered() {
        let store = InMemoryChatStore::new();
        store.create_session(session("op_1")).await.unwrap();
        store
            .acquire_run_lease(NewChatRunLease {
                id: "lease_1".into(),
                org_id: "org_1".into(),
                workspace_id: "ws_1".into(),
                session_id: "ses_1".into(),
                run_id: "run_1".into(),
                holder_user_id: "usr_owner".into(),
                holder_device_id: "dev_1".into(),
                token_hash: "token_hash".into(),
                token_expires_at: 100,
                heartbeat_expires_at: 100,
                now: 2,
                operation_id: "lease_op".into(),
            })
            .await
            .unwrap();
        assert!(store
            .validate_run_token("org_1", "ses_1", "run_1", "token_hash", 3)
            .await
            .is_ok());
        assert!(store
            .validate_run_token("org_1", "ses_1", "run_other", "token_hash", 3)
            .await
            .is_err());
        for index in 0..2 {
            store
                .enqueue_run_input(NewChatRunQueueItem {
                    id: format!("queue_{index}"),
                    org_id: "org_1".into(),
                    workspace_id: "ws_1".into(),
                    session_id: "ses_1".into(),
                    requested_by_user_id: "usr_owner".into(),
                    payload: serde_json::json!({"text":index}),
                    now: 3 + index,
                    operation_id: format!("queue_op_{index}"),
                })
                .await
                .unwrap();
        }
        assert_eq!(
            store
                .list_run_queue("org_1", "ses_1")
                .await
                .unwrap()
                .iter()
                .map(|item| item.position)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[tokio::test]
    async fn a_session_keeps_an_owner_and_removal_fails_their_active_lease() {
        let store = InMemoryChatStore::new();
        store.create_session(session("op_1")).await.unwrap();
        assert!(matches!(
            store.remove_member("org_1", "ses_1", "usr_owner", 2).await,
            Err(StoreError::Conflict(_))
        ));
        store
            .put_member(
                "org_1",
                "ses_1",
                "ws_1",
                "usr_next",
                SessionRole::Owner,
                true,
                false,
                2,
            )
            .await
            .unwrap();
        store
            .acquire_run_lease(NewChatRunLease {
                id: "lease_1".into(),
                org_id: "org_1".into(),
                workspace_id: "ws_1".into(),
                session_id: "ses_1".into(),
                run_id: "run_1".into(),
                holder_user_id: "usr_owner".into(),
                holder_device_id: "dev_1".into(),
                token_hash: "hash".into(),
                token_expires_at: 100,
                heartbeat_expires_at: 50,
                now: 3,
                operation_id: "lease-op".into(),
            })
            .await
            .unwrap();
        store
            .remove_member("org_1", "ses_1", "usr_owner", 4)
            .await
            .unwrap();
        assert!(store
            .acquire_run_lease(NewChatRunLease {
                id: "lease_2".into(),
                org_id: "org_1".into(),
                workspace_id: "ws_1".into(),
                session_id: "ses_1".into(),
                run_id: "run_2".into(),
                holder_user_id: "usr_next".into(),
                holder_device_id: "dev_2".into(),
                token_hash: "hash2".into(),
                token_expires_at: 100,
                heartbeat_expires_at: 50,
                now: 5,
                operation_id: "lease-op-2".into()
            })
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn break_glass_is_user_bound_expiring_and_idempotent() {
        let store = InMemoryChatStore::new();
        store.create_session(session("op_1")).await.unwrap();
        let input = NewBreakGlassGrant {
            id: "grant_1".into(),
            org_id: "org_1".into(),
            workspace_id: "ws_1".into(),
            session_id: "ses_1".into(),
            granted_to_user_id: "admin".into(),
            reason: "incident response".into(),
            expires_at: 100,
            created_at: 2,
            operation_id: "grant-op".into(),
        };
        let first = store.create_break_glass_grant(input.clone()).await.unwrap();
        let retry = store.create_break_glass_grant(input).await.unwrap();
        assert_eq!(first, retry);
        assert!(store
            .valid_break_glass_grant("org_1", "ses_1", "grant_1", "admin", 99)
            .await
            .is_ok());
        assert!(store
            .valid_break_glass_grant("org_1", "ses_1", "grant_1", "other", 99)
            .await
            .is_err());
        assert!(store
            .valid_break_glass_grant("org_1", "ses_1", "grant_1", "admin", 100)
            .await
            .is_err());
    }
}
